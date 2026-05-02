const express = require('express');
const admin = require('firebase-admin');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;

// ==========================================
// 🌐 WEB SERVER (Keeps Render Alive)
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`Samrat POS AI Backend is actively listening for emails on port ${PORT}! 🤖`);
});

app.listen(PORT, () => {
  console.log(`✅ Web server running and keeping the app alive on port ${PORT}`);
});

// ==========================================
// 🛠️ FIREBASE & IMAP CONFIGURATION
// ==========================================
const HOTEL_EMAIL = process.env.HOTEL_EMAIL; 
const APP_PASSWORD = process.env.APP_PASSWORD; 
const processedCache = new Set();

const serviceAccount = process.env.RENDER 
  ? require('/etc/secrets/serviceAccountKey.json') 
  : require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

let pdfParseLib = require('pdf-parse');
let pdfParse = pdfParseLib.default || pdfParseLib;
if (typeof pdfParse !== 'function') {
    pdfParse = async () => ({ text: "" });
}

const IMAP_CONFIG = {
    imap: {
        user: HOTEL_EMAIL,
        password: APP_PASSWORD ? APP_PASSWORD.replace(/\s/g, '') : '', 
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 5000,
        tlsOptions: { rejectUnauthorized: false }
    }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 🔄 IMAP CONNECTION & STRICT DATE LOOP
// ==========================================
async function startImapPolling() {
    console.log("👀 AI AGENT: Connecting to Hotel Inbox...");
    try {
        const connection = await imaps.connect(IMAP_CONFIG);
        await connection.openBox('INBOX');
        console.log("✅ Connected! Strictly watching for orders from May 2, 2026, 4:30 PM onwards...");

        async function runPollingCycle() {
            try {
                // 🟢 STRICT DATE CUTOFF: May 2nd, 2026, 4:30 PM IST (16:30)
                const CUTOFF_DATE = new Date('2026-05-02T16:00:00+05:30'); 
                
                // Tell IMAP to only fetch from May 2nd onwards
                const searchCriteria = ['ALL', ['SINCE', 'May 02, 2026']];
                const fetchOptions = { bodies: [''], markSeen: false }; 
                
                const messages = await connection.search(searchCriteria, fetchOptions);

                if (messages.length > 0) {
                    const newMessages = messages.filter(m => !processedCache.has(m.attributes.uid));
                    if (newMessages.length > 0) {
                        console.log(`📩 Found ${newMessages.length} unparsed emails. Checking timestamps...`);
                    }

                    for (let item of messages) {
                        const uid = item.attributes.uid;
                        if (processedCache.has(uid)) continue; 

                        const all = item.parts.find(part => part.which === '');
                        const parsedEmail = await simpleParser(all.body);
                        
                        // 🟢 JAVASCRIPT GATEKEEPER: Block anything before exactly 4:30 PM May 2nd
                        const emailDate = parsedEmail.date ? new Date(parsedEmail.date) : new Date();
                        if (emailDate < CUTOFF_DATE) {
                            processedCache.add(uid); 
                            continue;
                        }

                        const subject = parsedEmail.subject || "No Subject";
                        const fromAddress = parsedEmail.from?.value?.[0]?.address || parsedEmail.from?.text || "Unknown";

                        // 🛑 THE ZOMATO BLOCKER
                        if (fromAddress.toLowerCase().includes('zomato')) {
                            console.log(`🚫 Blocked Zomato Email: ${subject} (Skipping AI Parse)`);
                            processedCache.add(uid);
                            continue;
                        }

                        if (!subject.match(/Order|Booking|PNR|Reservation|Invoice|Bill|Catering/i)) {
                            processedCache.add(uid);
                            continue;
                        }

                        console.log(`🤖 AI Analyzing: ${subject} (From: ${fromAddress})`);
                        let fullText = parsedEmail.text || parsedEmail.html || "";

                        if (parsedEmail.attachments && parsedEmail.attachments.length > 0) {
                            for (let att of parsedEmail.attachments) {
                                if (att.contentType === 'application/pdf') {
                                    try {
                                        const pdfData = await pdfParse(att.content);
                                        fullText += "\n\n--- PDF CONTENT ---\n" + pdfData.text;
                                    } catch (e) {}
                                }
                            }
                        }

                        await delay(3000);

                        const orderData = await parseWithAWS(fullText, subject, fromAddress);

                        if (orderData && (orderData.orderNo || orderData.pnr)) {
                            let finalOrderNo = orderData.orderNo || orderData.pnr || `UNK_${Date.now()}`;
                            finalOrderNo = finalOrderNo.toString().replace(/\//g, '-').trim();
                            const cleanFloat = (val) => parseFloat((val || 0).toString().replace(/[^\d.]/g, '')) || 0;

                            await db.collection('orders').doc(finalOrderNo).set({
                                ...orderData,
                                subTotal: cleanFloat(orderData.subTotal),
                                tax: cleanFloat(orderData.tax),
                                deliveryCharge: cleanFloat(orderData.deliveryCharge),
                                totalAmount: cleanFloat(orderData.totalAmount),
                                remark: orderData.remark || "",
                                orderNo: finalOrderNo,
                                createdAt: new Date().toISOString(),
                                status: 'Active',
                                cancellationEmailSent: false
                            });

                            console.log(`✅ SAVED: #${finalOrderNo} | Vendor: ${orderData.vendorName} | Total: ₹${orderData.totalAmount}`);
                            processedCache.add(uid);

                        } else {
                            console.log("   ❌ AI Failed or text was unreadable. Skipping.");
                            processedCache.add(uid);
                        }
                    }
                }
            } catch (err) {
                console.error("⚠️ Polling Error:", err.message);
            }

            setTimeout(runPollingCycle, 30000); 
        }

        runPollingCycle();

    } catch (error) {
        console.error("❌ IMAP Connection Error:", error.message);
    }
}

// ==========================================
// 🧠 AI PARSER (Native Amazon Bedrock)
// ==========================================
async function parseWithAWS(rawText, subject, senderEmail) {
    const awsToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
    
    if (!awsToken) {
        console.error("   🚨 Missing AWS_BEARER_TOKEN_BEDROCK in Render Environment Variables!");
        return null;
    }

    const prompt = `
    CRITICAL EXTRACTION RULES:
    1. SENDER EMAIL ANALYSIS: Look at the "SENDER EMAIL" below. Deduce the "vendorName" strictly from the domain or name in this email address.
    2. ORDER NUMBER: Analyze the "EMAIL SUBJECT" and "EMAIL BODY" to extract the "orderNo" (Order ID / PNR / Invoice No). 
    3. 🔴 QUANTITY CHECK 🔴: Pay EXTREME attention to the quantity of food items. Look carefully for multipliers (e.g., "x3", "2x", "*4"), numbers written as words (e.g., "two", "three"), or specific "Qty" columns. NEVER default to 1 if a larger quantity is indicated anywhere near the item name.
    4. 🔴 SEAT & COACH CHECK 🔴: Scan the email carefully for Coach, Seat, or Berth numbers (e.g., "Coach: B4", "Seat: 12", "S1/45", "B-2, 43"). Extract this EXACTLY into the "coach" field. Do not miss this if it exists in the text.
    5. Extract all remaining order details strictly from the "EMAIL BODY".

    Use this exact JSON schema:
    {
      "orderDate": "YYYY-MM-DD",
      "orderTime": "HH:MM",
      "items": [
        { "name": "Food Name", "quantity": 1, "price": 150 }
      ],
      "subTotal": 0,
      "tax": 0,
      "deliveryCharge": 0,
      "totalAmount": 0,
      "orderNo": "12345",
      "vendorName": "Restaurant Name",
      "customerName": "Passenger Name",
      "contactNo": "9876543210",
      "trainInfo": "Train Number/Name",
      "coach": "S1/45",
      "paymentType": "COD",
      "remark": ""
    }

    SENDER EMAIL: "${senderEmail}"
    EMAIL SUBJECT: "${subject}"
    
    EMAIL BODY:
    ${rawText.substring(0, 15000)}
    `;

    try {
        const modelId = "qwen.qwen3-vl-235b-a22b";
        const awsUrl = `https://bedrock-runtime.ap-south-1.amazonaws.com/model/${modelId}/converse`;

        const response = await fetch(awsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${awsToken}`
            },
            body: JSON.stringify({
                system: [{ text: "You are a strict data extraction API. Return a SINGLE, VALID JSON object without markdown formatting." }],
                messages: [{
                    role: "user",
                    content: [{ text: prompt }]
                }]
            })
        });

        const result = await response.json();

        if (!response.ok) {
            console.error(`   ❌ AWS Error [${response.status}]:`, result.message || JSON.stringify(result));
            return null;
        }

        const rawResponse = result.output.message.content[0].text;
        
        // 🟢 FIX: 100% crash-proof cleanup. Splits the string to remove markdown blocks instead of using fragile Regex.
        const cleanResponse = rawResponse.split('```json').join('').split('```').join('').trim();
        
        const data = JSON.parse(cleanResponse);

        if (!data.orderNo && !data.pnr) return null;
        return data; 

    } catch (e) {
        console.error(`   ❌ AWS Parse Error:`, e.message);
        return null;
    }
}

startImapPolling();
