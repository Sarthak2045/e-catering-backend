const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");
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
// 🛠️ CONFIGURATION
// ==========================================
const HOTEL_EMAIL = process.env.HOTEL_EMAIL; 
const APP_PASSWORD = process.env.APP_PASSWORD; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

// 🟢 USING THE FAST, STABLE FLASH MODEL
const MODEL_NAME = "gemini-2.0-flash"; 
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// 🟢 ENFORCING OFFICIAL JSON MODE (No more conversational text from the AI)
const model = genAI.getGenerativeModel({ 
    model: MODEL_NAME,
    generationConfig: {
        responseMimeType: "application/json",
    }
});

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

// ==========================================
// 🔄 IMAP CONNECTION & MAIN LOOP
// ==========================================
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

async function startImapPolling() {
    console.log("👀 AI AGENT: Connecting to Hotel Inbox...");
    try {
        const connection = await imaps.connect(IMAP_CONFIG);
        await connection.openBox('INBOX');
        console.log("✅ Connected! Watching for new orders strictly from TODAY onwards...");

        async function runPollingCycle() {
            try {
                const bufferDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
                const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const imapDate = `${months[bufferDate.getMonth()]} ${bufferDate.getDate()}, ${bufferDate.getFullYear()}`;

                const searchCriteria = ['ALL', ['SINCE', imapDate]];
                const fetchOptions = { bodies: [''], markSeen: false }; 
                const messages = await connection.search(searchCriteria, fetchOptions);

                if (messages.length > 0) {
                    const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                    
                    const newMessages = messages.filter(m => !processedCache.has(m.attributes.uid));
                    if (newMessages.length > 0) {
                        console.log(`📩 Found ${newMessages.length} unparsed emails. Processing slowly to avoid API limits...`);
                    }

                    for (let item of messages) {
                        const uid = item.attributes.uid;
                        if (processedCache.has(uid)) continue; 

                        const all = item.parts.find(part => part.which === '');
                        const parsedEmail = await simpleParser(all.body);
                        
                        const emailDate = parsedEmail.date ? new Date(parsedEmail.date) : new Date();
                        const emailDateIST = emailDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

                        if (emailDateIST < todayIST) {
                            processedCache.add(uid); 
                            continue;
                        }

                        const subject = parsedEmail.subject || "No Subject";
                        const from = parsedEmail.from?.text || "Unknown";

                        if (!subject.match(/Order|Booking|PNR|Reservation|Invoice|Bill|Catering/i)) {
                            processedCache.add(uid);
                            continue;
                        }

                        console.log(`🤖 AI Analyzing: ${subject}`);
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

                        // Pause 6 seconds to stay comfortably under 15 requests/min
                        await delay(6000);

                        const orderData = await parseWithAI(fullText, subject, from);

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

                            console.log(`✅ SAVED: #${finalOrderNo} | Total: ₹${orderData.totalAmount}`);
                            processedCache.add(uid);

                        } else {
                            console.log("   ❌ AI Failed to extract data cleanly. Skipping.");
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
// 🧠 AI PARSER (With 503 Auto-Retry)
// ==========================================
async function parseWithAI(rawText, subject, sender, retries = 1) {
    try {
        const prompt = `
        Extract catering order details from the email text.
        
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

        EMAIL TEXT TO PARSE:
        ${rawText.substring(0, 15000)}
        `;

        const result = await model.generateContent(prompt);
        const data = JSON.parse(result.response.text());

        if (!data.orderNo && !data.pnr) return null;
        return data;

    } catch (e) {
        // 🟢 If Google is busy (503) and we haven't retried yet, wait 5 seconds and try again!
        if (e.message.includes("503") && retries > 0) {
            console.log("   ⏳ Google is busy (503). Waiting 5 seconds and retrying...");
            await delay(5000); 
            return parseWithAI(rawText, subject, sender, 0); // Try one last time
        }
        
        console.error(`   ❌ AI Parse Error:`, e.message);
        return null;
    }
}

startImapPolling();
