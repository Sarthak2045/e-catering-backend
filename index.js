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
// 🔄 IMAP CONNECTION & TARGETED POLLING
// ==========================================
async function startImapPolling() {
    console.log("👀 AI AGENT: Connecting to Hotel Inbox...");
    let connection;

    try {
        connection = await imaps.connect(IMAP_CONFIG);
        
        // 🛡️ BACKGROUND ERROR SHIELD: Catch random disconnects gracefully
        connection.on('error', (err) => {
            console.error("⚠️ Background IMAP Socket Error (Handled):", err.message);
        });
        connection.on('end', () => {
            console.log("⚠️ IMAP Connection ended by server.");
        });

        await connection.openBox('INBOX');
        console.log("✅ Connected! Observer Mode: Strictly watching for UNREAD emails from May 18, 2026, 6:00 PM onwards...");

        async function runPollingCycle() {
            try {
                // 🟢 STRICT DATE CUTOFF: May 18, 2026 at 6:00 PM IST
                const CUTOFF_DATE = new Date('2026-05-18T18:00:00+05:30'); 
                
                // 🟢 STRICT UNSEEN FILTER: Only fetch emails that are marked as Unread in Gmail
                const searchCriteria = ['UNSEEN', ['SINCE', 'May 18, 2026']];
                
                const fetchOptions = { bodies: ['HEADER.FIELDS (SUBJECT)'], markSeen: false }; 
                
                const searchPromise = connection.search(searchCriteria, fetchOptions);
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("IMAP_HANG")), 15000));
                
                const messages = await Promise.race([searchPromise, timeoutPromise]);

                if (messages.length > 0) {
                    const newMessages = messages.filter(m => !processedCache.has(m.attributes.uid));
                    
                    if (newMessages.length > 0) {
                        // 🟢 BATCH PROCESSING: Slice the backlog into safe chunks to prevent IMAP timeouts
                        const BATCH_SIZE = 15;
                        const currentBatch = newMessages.slice(0, BATCH_SIZE);
                        
                        console.log(`📩 Inbox has ${newMessages.length} pending emails. Processing a safe batch of ${currentBatch.length}...`);

                        for (let item of currentBatch) {
                            const uid = item.attributes.uid;
                            const uidStr = uid.toString();

                            const emailRef = db.collection('processed_emails').doc(uidStr);
                            const emailDoc = await emailRef.get();
                            
                            if (emailDoc.exists) {
                                processedCache.add(uid);
                                continue; 
                            }

                            console.log(`📥 Downloading payload for UID: ${uid}...`);
                            const fullMessage = await connection.search([['UID', uid]], { bodies: [''], markSeen: false });
                            
                            if (!fullMessage || fullMessage.length === 0) continue;

                            const all = fullMessage[0].parts.find(part => part.which === '');
                            const parsedEmail = await simpleParser(all.body);
                            
                            const emailDate = parsedEmail.date ? new Date(parsedEmail.date) : new Date();
                            
                            if (emailDate < CUTOFF_DATE) {
                                console.log(`   ⏳ Skipping old email from ${emailDate.toLocaleString()}`);
                                processedCache.add(uid); 
                                await emailRef.set({ status: 'old_date_skipped', processedAt: new Date().toISOString() });
                                continue;
                            }

                            const subject = parsedEmail.subject || "No Subject";
                            const fromAddress = parsedEmail.from?.value?.[0]?.address || parsedEmail.from?.text || "Unknown";
                            const lowerFrom = fromAddress.toLowerCase();

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
                                
                                processedCache.add(uid);
                                await emailRef.set({ status: 'success', orderNo: finalOrderNo, processedAt: new Date().toISOString() });

                            } else {
                                console.log("   ❌ AI Failed or text was unreadable. Skipping.");
                                processedCache.add(uid);
                                await emailRef.set({ status: 'failed_parse', processedAt: new Date().toISOString() });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error("⚠️ Polling Error:", err.message);
                
                if (err.message === "IMAP_HANG" || err.message.includes("Not connected") || err.message.includes("Connection ended")) {
                    console.log("🔄 Silent hang detected. Force restarting IMAP connection...");
                    try { connection.end(); } catch(e){}
                    try {
                        connection = await imaps.connect(IMAP_CONFIG);
                        connection.on('error', (e) => console.error("⚠️ Background IMAP Socket Error (Handled):", e.message));
                        connection.on('end', () => console.log("⚠️ IMAP Connection ended by server."));
                        await connection.openBox('INBOX');
                        console.log("✅ Reconnected securely!");
                    } catch(e) {
                        console.error("❌ Reconnect failed, will try again next cycle:", e.message);
                    }
                }
            }

            // Runs the next batch cycle after 30 seconds
            setTimeout(runPollingCycle, 30000); 
        }

        runPollingCycle();

    } catch (error) {
        console.error("❌ IMAP Connection Error:", error.message);
    }
}

// ==========================================
// 🧠 AI PARSER (11-Vendor Mapping + Validation)
// ==========================================
async function parseWithAWS(rawText, subject, senderEmail) {
    const awsToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
    
    if (!awsToken) {
        console.error("   🚨 Missing AWS_BEARER_TOKEN_BEDROCK in Render Environment Variables!");
        return null;
    }

    const lowerFrom = senderEmail.toLowerCase();
    
    const VENDOR_MAP = [
        { match: 'relfood',       name: 'Rail Food',      type: 'railfood' },
        { match: 'railfood',      name: 'Rail Food',      type: 'railfood' },
        { match: 'zoop',          name: 'Zoop India',     type: 'zoop' },
        { match: 'zoopindia',     name: 'Zoop India',     type: 'zoop' },
        { match: 'yatrirestro',   name: 'Yatri Restro',   type: 'yatri_restro' },
        { match: 'yatristro',     name: 'Yatri Restro',   type: 'yatri_restro' },
        { match: 'yatribhojan',   name: 'YatriBhojan',    type: 'yatribhojan' },
        { match: 'rajbhaog',      name: 'Rajbhog',        type: 'rajbhog' },
        { match: 'rajbhog',       name: 'Rajbhog',        type: 'rajbhog' },
        { match: 'homebytes',     name: 'Home Bytes',     type: 'homebytes' },
        { match: 'railyatri',     name: 'RailYatri',      type: 'railyatri' },
        { match: 'railreceipt',   name: 'Rail Receipt',   type: 'railreceipt' },
        { match: 'rajdhani',      name: 'Rajdhani',       type: 'rajdhani' },
        { match: 'dibrail',       name: 'Dibral',         type: 'dibrail' },
        { match: 'spicywagon',    name: 'Spicywagon',     type: 'spicywagon' },
    ];

    let vendorName = "";
    let vendorType = "generic";

    for (const v of VENDOR_MAP) {
        if (lowerFrom.includes(v.match)) {
            vendorName = v.name;
            vendorType = v.type;
            break;
        }
    }

    console.log(`   🏷️ Vendor detected: ${vendorName || 'Unknown'} (${vendorType})`);

    if (!vendorName) {
        try {
            const domainParts = lowerFrom.split('@')[1]?.split('.') || [];
            const rootDomain = domainParts.length > 2 ? domainParts[domainParts.length - 2] : domainParts[0];
            vendorName = rootDomain.charAt(0).toUpperCase() + rootDomain.slice(1);
        } catch(e) {}
        console.log(`   ⚠️ Unknown vendor. Extracted name: ${vendorName}`);
    }

    const VENDOR_RULES = {
        yatri_restro: `
VENDOR: YATRI RESTRO
TABLE: Item Description | ₹ Price | Quantity | ₹ Amount
- Quantity is its OWN column. Numbers inside description (e.g. "4 Butter Roti") are ingredient counts, NOT quantity.
- Date: DD-MM-YYYY → YYYY-MM-DD.
`,
        zoop: `
VENDOR: ZOOP INDIA
TABLE: Item Name | Price | Quantity | Amount
- All plain numbers. Quantity is the 2nd number in the row.
- Large quantities (10, 20) are common. Read exact digit.
- Date: DD-Mon-YYYY → YYYY-MM-DD.
`,
        rajbhog: `
VENDOR: RAJBHOG
TABLE: SL# | Item Description | Qty | Price | GST | Amount
- Numbers in parentheses like (4) in descriptions are ingredient counts, NOT item quantity.
- Date: DD Mon YYYY → YYYY-MM-DD.
`,
        homebytes: `
VENDOR: HOME BYTES
TABLE: SL# | Item Description | Qty | Price | GST | Amount
- Same as Rajbhog. Quantity is its own column.
- Date: DD Mon YYYY → YYYY-MM-DD.
`,
        railyatri: `
VENDOR: RAILYATRI
FORMAT: Item | Quantity | Price
- Quantity as "1 (1 * 159)" → first number is quantity.
- Date: DD-MM-YYYY → YYYY-MM-DD.
`,
        railreceipt: `
VENDOR: RAIL RECEIPT
TABLE: Item Name | ₹ Price | Quantity | ₹ Amount
- Quantity as "x1", "x2". Extract number after "x".
- "(4PCS)", "(200G)" in descriptions are NOT quantity.
- Date: Mon DD, YYYY → YYYY-MM-DD.
`,
        rajdhani: `
VENDOR: RAJDHANI
FORMAT: Quantity Item Name (QUANTITY FIRST)
- "1 Veg Schezwan Rice" → qty=1, name="Veg Schezwan Rice"
- Date: DD-MM-YYYY → YYYY-MM-DD.
`,
        railfood: `
VENDOR: RAIL FOOD / REL FOOD
FORMAT (2 lines per item):
  Line 1: Item Name
  Line 2: Weight Price Quantity Total
- Example: "300gm 254 2 508" → Price=254, Qty=2, Total=508
- "300gm", "1 Pcs" in description are NOT quantity.
- VERIFY: Price × Qty = Total.
- Date: M/D/YYYY → YYYY-MM-DD.
`,
        yatribhojan: `
VENDOR: YATRIBHOJAN
FORMAT: "Item Name X 3" → quantity is the number after "X" or "x"
- Example: "Veg Hydrabadi Biriyani X 3" → qty=3
- "NET TOTAL" = final amount.
- Date: DD-MM-YYYY → YYYY-MM-DD.
`,
        dibrail: `
VENDOR: DIBRAL
FORMAT: "👉🏼 1-Jain Special Thali" → number before "-" is quantity
- Example: "👉🏼 4-Tava Roti" → qty=4, name="Tava Roti"
- Example: "👉🏼 1-Jain Special Thali" → qty=1, name="Jain Special Thali"
- "Total Amount" = final amount.
- Date: DD-MM-YYYY HH:MM → YYYY-MM-DD, HH:MM.
`,
        spicywagon: `
VENDOR: SPICYWAGON
FORMAT: "Item Name × 1" → quantity is the number after "×" or "x"
- Example: "Saada Thali × 1" → qty=1
- "NET TOTAL" = final amount.
- Date: DD-MM-YY HH:MM AM/PM → YYYY-MM-DD, HH:MM (24hr).
`,
        generic: `
GENERAL RULES:
- Find items table. Read Quantity from its dedicated column.
- Numbers in item descriptions are NOT quantity.
- VERIFY: Price × Quantity = Amount for each item.
`
    };

    const vendorRule = VENDOR_RULES[vendorType] || VENDOR_RULES.generic;

    const prompt = `
    You are a STRICT invoice/order parser. Extract data EXACTLY as shown.

    IDENTIFIED VENDOR: ${vendorType}
    VENDOR NAME (PRE-DETERMINED): "${vendorName}" — USE THIS EXACT VALUE.

    ${vendorRule}

    UNIVERSAL RULES:
    1. 🔴 VENDOR NAME: Output "${vendorName}" exactly.
    2. ORDER NUMBER: Order No, Txn No, Ref.No, Invoice, PNR, or # prefix. Strip # symbol.
    3. 🔴🔴🔴 QUANTITY — MOST CRITICAL:
       - Read quantity ONLY from the quantity column or explicit marker (X, ×, -prefix).
       - Numbers inside descriptions ("4 Butter Roti", "3 Roti", "4PCS", "250gm") are NEVER the item quantity.
       - VERIFY: Price × Quantity = Total/Amount for EACH item.
    4. DATE FORMAT: Always "YYYY-MM-DD". Convert from any format.
    5. DELIVERY TIME: Use Delivery ETA, NOT order creation time. Output "HH:MM" (24hr).
    6. PHONE: 10-digit customer mobile.
    7. COACH/SEAT: Exactly as shown (e.g. "S2/1", "B4/47", "M4-55").
    8. PAYMENT: "COD" or "Cash on Delivery" → output "COD". "PRE_PAID"/"Online" → "Prepaid".

    Use this EXACT JSON schema:
    {
      "_thinking": "Step-by-step logic: Explain exactly how you found the quantity based on the vendor rule. Verify Price * Quantity.",
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
      "vendorName": "${vendorName}",
      "customerName": "Passenger Name",
      "contactNo": "9876543210",
      "trainInfo": "Train Number/Name",
      "coach": "S2/1",
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
                messages: [{ role: "user", content: [{ text: prompt }] }]
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

        data.vendorName = vendorName;

        if (data.items && Array.isArray(data.items)) {
            console.log("   🔍 Validating item math...");
            let calculatedSubTotal = 0;

            for (const item of data.items) {
                item.quantity = parseInt(item.quantity, 10);
                item.price = parseFloat(item.price);

                if (item.quantity <= 0 || isNaN(item.quantity)) {
                    console.error(`      ⚠️ INVALID qty for "${item.name}". Resetting to 1.`);
                    item.quantity = 1;
                }
                
                const lineTotal = item.price * item.quantity;
                calculatedSubTotal += lineTotal;
                console.log(`      ${item.name}: ₹${item.price} × ${item.quantity} = ₹${lineTotal}`);
            }

            const parsedSubTotal = parseFloat(data.subTotal) || 0;
            if (Math.abs(parsedSubTotal - calculatedSubTotal) > 5) { 
                 console.log(`      ⚠️ SubTotal Mismatch! AI said ₹${parsedSubTotal}, Real Math is ₹${calculatedSubTotal}. Correcting.`);
                 data.subTotal = calculatedSubTotal;
            }
        }

        return data;

    } catch (e) {
        console.error(`   ❌ AWS Parse Error:`, e.message);
        return null;
    }
}

startImapPolling();
