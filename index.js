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
// 🛠️ CONFIGURATION (SECURED FOR CLOUD)
// ==========================================
// Pulling credentials from Render Environment Variables
const HOTEL_EMAIL = process.env.HOTEL_EMAIL; 
const APP_PASSWORD = process.env.APP_PASSWORD; 
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 

const MODEL_NAME = "gemma-3-4b-it"; 
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

// 🟢 MEMORY CACHE (Prevents Loops & Duplicates)
const processedCache = new Set();

// Smart Pathing: Uses Render's secure vault in the cloud, or local file on your PC
const serviceAccount = process.env.RENDER 
  ? require('/etc/secrets/serviceAccountKey.json') 
  : require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// PDF Parsing Fallback
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

async function startImapPolling() {
    console.log("👀 AI AGENT: Connecting to Hotel Inbox...");
    try {
        const connection = await imaps.connect(IMAP_CONFIG);
        await connection.openBox('INBOX');
        console.log("✅ Connected! Watching for new orders...");

        // Check for new emails every 20 seconds
        setInterval(async () => {
            try {
                // 1. Generate today's date in IMAP format (e.g., "Apr 18, 2026")
                const today = new Date();
                const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const imapDate = `${months[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`;

                // 2. Fetch ALL emails (Read OR Unread) that arrived today
                const searchCriteria = ['ALL', ['SINCE', imapDate]];
                const fetchOptions = { bodies: [''], markSeen: false }; 
                const messages = await connection.search(searchCriteria, fetchOptions);

                if (messages.length === 0) return;
                
                // Only log if we find emails we haven't processed yet
                const newMessages = messages.filter(m => !processedCache.has(m.attributes.uid));
                if (newMessages.length > 0) {
                    console.log(`📩 Found ${messages.length} total emails today. Processing ${newMessages.length} new ones...`);
                }

                for (let item of messages) {
                    const uid = item.attributes.uid;
                    if (processedCache.has(uid)) {
                        continue; // Skip silently to keep logs clean
                    }

                    // Parse the email body
                    const all = item.parts.find(part => part.which === '');
                    const parsedEmail = await simpleParser(all.body);
                    
                    const subject = parsedEmail.subject || "No Subject";
                    const from = parsedEmail.from?.text || "Unknown";

                    // Ignore non-order emails
                    if (!subject.match(/Order|Booking|PNR|Reservation|Invoice|Bill|Catering/i)) {
                        processedCache.add(uid); // Add to cache so we don't scan it again
                        continue;
                    }

                    console.log(`🤖 AI Analyzing: ${subject}`);
                    let fullText = parsedEmail.text || parsedEmail.html || "";

                    // Extract PDF Attachments if any exist
                    if (parsedEmail.attachments && parsedEmail.attachments.length > 0) {
                        for (let att of parsedEmail.attachments) {
                            if (att.contentType === 'application/pdf') {
                                console.log(`   📎 Found PDF! Reading content...`);
                                try {
                                    const pdfData = await pdfParse(att.content);
                                    fullText += "\n\n--- PDF CONTENT ---\n" + pdfData.text;
                                } catch (e) { console.log("   ⚠️ PDF Error:", e.message); }
                            }
                        }
                    }

                    // Send to Gemini
                    const orderData = await parseWithAI(fullText, subject, from);

                    if (orderData && (orderData.orderNo || orderData.pnr)) {
                        let finalOrderNo = orderData.orderNo || orderData.pnr || `UNK_${Date.now()}`;
                        finalOrderNo = finalOrderNo.toString().replace(/\//g, '-').trim();
                        const cleanFloat = (val) => parseFloat((val || 0).toString().replace(/[^\d.]/g, '')) || 0;

                        // Save to Firebase
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
                        console.log("   ❌ AI Failed to extract data. Skipping.");
                        processedCache.add(uid);
                    }
                }
            } catch (err) {
                console.error("⚠️ Polling Error:", err.message);
            }
        }, 20000); // 20 Second Loop

    } catch (error) {
        console.error("❌ IMAP Connection Error. Check Email/Password:", error.message);
    }
}

// ==========================================
// 🧠 AI PARSER
// ==========================================
async function parseWithAI(rawText, subject, sender) {
    try {
        const prompt = `
        You are a JSON extractor. Extract catering order details from the email below.
        
        CRITICAL RULES:
        - Output ONLY valid JSON.
        - "orderDate": Extract the Journey Date or Delivery Date. Format: "YYYY-MM-DD".
        - "orderTime": Extract the Delivery Time. Format: "HH:MM".
        - "items": Array of { "name": string, "quantity": number, "price": number }.
        - "subTotal": Look for "Subtotal", "Net Amount", or sum of items. (Number only).
        - "tax": Look for "GST", "IGST", "CGST", "SGST", or "VAT". (Number only).
        - "deliveryCharge": Look for "Delivery Fee" or "Convenience Fee". (Number only).
        - "totalAmount": Look for "Grand Total", "Total Payable", or "Final Amount". (Number only).
        - "orderNo": The Order ID or PNR.
        - "vendorName": Restaurant Name.
        - "customerName": Passenger Name.
        - "contactNo": Passenger Phone.
        - "trainInfo": Train Number/Name.
        - "coach": Coach/Seat.
        - "paymentType": "COD" or "ONLINE".
        - "remark": Look for "Customer Note", "Instructions", "Message", or "Remarks". (String, output "" if none found).

        EMAIL TEXT:
        ${rawText.substring(0, 15000)}
        `;

        const result = await model.generateContent(prompt);
        let text = result.response.text();
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(text);

        if (!data.orderNo && !data.pnr) return null;
        return data;

    } catch (e) {
        console.error(`   ❌ AI Parse Error:`, e.message);
        return null;
    }
}

// Start the engine
startImapPolling();
