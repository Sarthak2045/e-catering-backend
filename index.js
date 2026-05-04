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

// Short-term memory (RAM)
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
// 🔄 IMAP CONNECTION & TARGETED POLLING
// ==========================================
async function startImapPolling() {
    console.log("👀 AI AGENT: Connecting to Hotel Inbox...");
    let connection;

    try {
        connection = await imaps.connect(IMAP_CONFIG);
        await connection.openBox('INBOX');
        console.log("✅ Connected! Observer Mode: Watching ALL emails from May 4, 2026, 6:40 PM onwards...");

        async function runPollingCycle() {
            try {
                // 🟢 STRICT DATE CUTOFF: Shifted to right now (May 4, 4:00 PM) so it ignores everything prior
                const CUTOFF_DATE = new Date('2026-05-04T16:00:00+05:30'); 
                
                // Fetch everything from May 4th, ignoring Read/Unread status
                const searchCriteria = ['ALL', ['SINCE', 'May 04, 2026']];
                
                // Lightweight Scout Check (Strictly markSeen: false)
                const fetchOptions = { bodies: ['HEADER.FIELDS (SUBJECT)'], markSeen: false }; 
                
                const searchPromise = connection.search(searchCriteria, fetchOptions);
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("IMAP_HANG")), 15000));
                
                const messages = await Promise.race([searchPromise, timeoutPromise]);

                if (messages.length > 0) {
                    const newMessages = messages.filter(m => !processedCache.has(m.attributes.uid));
                    if (newMessages.length > 0) {
                        console.log(`📩 Found ${newMessages.length} unparsed emails. Verifying with Firebase memory...`);
                    }

                    for (let item of newMessages) {
                        const uid = item.attributes.uid;
                        const uidStr = uid.toString();

                        // Check Firebase memory BEFORE downloading heavy data
                        const emailRef = db.collection('processed_emails').doc(uidStr);
                        const emailDoc = await emailRef.get();
                        
                        if (emailDoc.exists) {
                            processedCache.add(uid);
                            continue; 
                        }

                        // TARGETED DOWNLOAD: Keep markSeen: false
                        console.log(`📥 Downloading payload for UID: ${uid}...`);
                        const fullMessage = await connection.search([['UID', uid]], { bodies: [''], markSeen: false });
                        
                        if (!fullMessage || fullMessage.length === 0) continue;

                        const all = fullMessage[0].parts.find(part => part.which === '');
                        const parsedEmail = await simpleParser(all.body);
                        
                        const emailDate = parsedEmail.date ? new Date(parsedEmail.date) : new Date();
                        // 🟢 GATEKEEPER: Absolutely block anything before 6:40 PM today
                        if (emailDate < CUTOFF_DATE) {
                            processedCache.add(uid); 
                            continue;
                        }

                        const subject = parsedEmail.subject || "No Subject";
                        const fromAddress = parsedEmail.from?.value?.[0]?.address || parsedEmail.from?.text || "Unknown";
                        const lowerFrom = fromAddress.toLowerCase();

                        // 🛑 THE ZOMATO & IRCTC BLOCKER
                        if (lowerFrom.includes('zomato') || lowerFrom.includes('irctc')) {
                            console.log(`🚫 Blocked Ignored Sender: ${subject}`);
                            processedCache.add(uid);
                            await emailRef.set({ status: 'ignored_sender', processedAt: new Date().toISOString() });
                            continue;
                        }

                        if (!subject.match(/Order|Booking|PNR|Reservation|Invoice|Bill|Catering/i)) {
                            processedCache.add(uid);
                            await emailRef.set({ status: 'irrelevant_subject', processedAt: new Date().toISOString() });
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
                            
                            // LOCK THE UID IN FIREBASE
                            processedCache.add(uid);
                            await emailRef.set({ status: 'success', orderNo: finalOrderNo, processedAt: new Date().toISOString() });

                        } else {
                            console.log("   ❌ AI Failed or text was unreadable. Skipping.");
                            processedCache.add(uid);
                            await emailRef.set({ status: 'failed_parse', processedAt: new Date().toISOString() });
                        }
                    }
                }
            } catch (err) {
                console.error("⚠️ Polling Error:", err.message);
                
                // Auto-reconnect logic
                if (err.message === "IMAP_HANG" || err.message.includes("Not connected") || err.message.includes("Connection ended")) {
                    console.log("🔄 Silent hang detected. Force restarting IMAP connection...");
                    try { connection.end(); } catch(e){}
                    try {
                        connection = await imaps.connect(IMAP_CONFIG);
                        await connection.openBox('INBOX');
                        console.log("✅ Reconnected securely!");
                    } catch(e) {
                        console.error("❌ Reconnect failed, will try again next cycle:", e.message);
                    }
                }
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
    5. 🔴 DELIVERY TIME CHECK 🔴: You must extract the scheduled "Delivery Date" (ETA / Journey Date) and "Delivery Time", NOT the time the order was placed or created.

    Use this exact JSON schema:
    {
      "deliveryDate": "YYYY-MM-DD",
      "deliveryTime": "HH:MM",
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
