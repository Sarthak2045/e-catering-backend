const express = require('express');
const OpenAI = require('openai'); 
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
// 🛠️ THE 4-MODEL FALLBACK ARRAY (High-Limit)
// ==========================================
const HOTEL_EMAIL = process.env.HOTEL_EMAIL; 
const APP_PASSWORD = process.env.APP_PASSWORD; 

const AI_PROVIDERS = [
    {
        name: "Groq (Llama 3.1 8B)",
        baseURL: "https://api.groq.com/openai/v1",
        apiKey: process.env.GROQ_API_KEY,
        model: "llama-3.1-8b-instant"
    },
    {
        name: "OpenRouter (Llama 3.1 8B Free)",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        model: "meta-llama/llama-3.1-8b-instruct:free"
    },
    {
        name: "OpenRouter (Gemini 2.0 Flash Exp Free)",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        model: "google/gemini-2.0-flash-exp:free"
    },
    {
        name: "OpenRouter (Llama 3.3 70B Free)",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        model: "meta-llama/llama-3.3-70b-instruct:free" 
    }
];

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
// 🔄 IMAP CONNECTION & STRICT DATE LOOP
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
        console.log("✅ Connected! Strictly watching for orders from April 28, 2026 onwards...");

        async function runPollingCycle() {
            try {
                // 🟢 STRICT DATE CUTOFF: April 28, 2026, 12:00 AM IST
                const CUTOFF_DATE = new Date('2026-04-28T00:00:00+05:30'); 
                
                // Tell IMAP to only bother fetching emails from Apr 28 onwards to save memory
                const searchCriteria = ['ALL', ['SINCE', 'Apr 28, 2026']];
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
                        
                        // 🟢 JAVASCRIPT GATEKEEPER: Absolutely block anything before midnight April 28
                        const emailDate = parsedEmail.date ? new Date(parsedEmail.date) : new Date();
                        if (emailDate < CUTOFF_DATE) {
                            processedCache.add(uid); 
                            continue;
                        }

                        const subject = parsedEmail.subject || "No Subject";
                        // Get the exact sender email address (e.g., orders@zoop.com)
                        const fromAddress = parsedEmail.from?.value?.[0]?.address || parsedEmail.from?.text || "Unknown";

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

                        // Pass the exact sender address to the AI
                        const orderData = await parseWithAI(fullText, subject, fromAddress);

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
                            console.log("   ❌ All AI Models Failed or text was unreadable. Skipping.");
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
// 🧠 AI PARSER (The Fallback Engine)
// ==========================================
async function parseWithAI(rawText, subject, senderEmail) {
    const prompt = `
    CRITICAL EXTRACTION RULES:
    1. SENDER EMAIL ANALYSIS: Look at the "SENDER EMAIL" below. Deduce the "vendorName" strictly from the domain or name in this email address (e.g., if it's info@zoopindia.com, the vendor is ZOOP. If it's orders@relfood.com, the vendor is REL FOOD).
    2. ORDER NUMBER: Analyze the "EMAIL SUBJECT" and "EMAIL BODY" to extract the "orderNo" (Order ID / PNR / Invoice No). 
    3. Extract all remaining order details strictly from the "EMAIL BODY".

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

    for (let i = 0; i < AI_PROVIDERS.length; i++) {
        const config = AI_PROVIDERS[i];
        
        if (!config.apiKey) continue; 

        try {
            const client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
            
            const completion = await client.chat.completions.create({
                model: config.model,
                response_format: { type: "json_object" }, 
                max_tokens: 1500, 
                messages: [
                  { role: "system", content: "You are a strict data extraction API. Return a SINGLE, VALID JSON object." },
                  { role: "user", content: prompt }
                ]
            });

            const data = JSON.parse(completion.choices[0].message.content);

            if (!data.orderNo && !data.pnr) return null;
            return data; 

        } catch (e) {
            if (e.status === 429 || e.status >= 500) {
                console.log(`   ⚠️ ${config.name} is busy or out of quota (${e.status}). Switching to next model...`);
                continue; 
            }
            console.error(`   ❌ ${config.name} Parse Error:`, e.message);
        }
    }

    console.error("   🚨 FATAL: All 4 fallback AI models have exhausted their free tiers or failed.");
    return null;
}

startImapPolling();
