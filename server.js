const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// 🔐 Server‑only secrets (never exposed to the browser)
const FIREBASE_SECRET = "90tPeiM0evu2QTt9dODNXPo04ktQ5wCAu8wQbL4O";
const FIREBASE_DB_URL = "https://sir-cosmos-default-rtdb.firebaseio.com";
const PAYSTACK_SECRET_KEY = "sk_live_620c49aba82ff76bcf46b6d9f8d8df15ece96ccf";
const PORT = process.env.PORT || 3000;

// Suppress warnings & keep server stable
process.on('warning', () => {});
process.on('uncaughtException', (err) => { console.error("SERVER CAUGHT:", err.message); });
process.on('unhandledRejection', (reason) => { console.error("UNHANDLED REJECTION:", reason); });

// Block bad bots
const isBlocked = (req) => {
    const ua = req.headers['user-agent'] || '';
    return /python|curl|wget|sqlmap|nikto|scrapy|headless|apivoid/i.test(ua);
};

// Read JSON body with 1MB limit
function getBody(req) {
    return new Promise((resolve) => {
        let body = '';
        let size = 0;
        const MAX = 1e6;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX) { req.destroy(); resolve({}); return; }
            body += chunk;
        });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (e) { resolve({}); }
        });
        req.on('error', () => resolve({}));
    });
}

// HTTPS request (used for Paystack and Firebase REST)
function httpsRequest(url, options = {}, postData = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { resolve({}); }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (postData) req.write(JSON.stringify(postData));
        req.end();
    });
}

// ---- CryptoJS‑compatible encryption (OpenSSL EVP_BytesToKey) ----
function deriveKeyAndIV(passphrase, salt, keyLength = 32, ivLength = 16) {
    let key = Buffer.alloc(keyLength);
    let iv = Buffer.alloc(ivLength);
    let prev = Buffer.alloc(0);
    let keyFilled = 0, ivFilled = 0;
    while (keyFilled < keyLength || ivFilled < ivLength) {
        const hash = crypto.createHash('md5');
        hash.update(prev);
        hash.update(passphrase);
        hash.update(salt);
        prev = hash.digest();
        const needKey = keyLength - keyFilled;
        const needIv = ivLength - ivFilled;
        if (needKey > 0) {
            const take = Math.min(needKey, prev.length);
            prev.copy(key, keyFilled, 0, take);
            keyFilled += take;
        }
        if (needIv > 0 && keyFilled >= keyLength) {
            const take = Math.min(needIv, prev.length);
            prev.copy(iv, ivFilled, 0, take);
            ivFilled += take;
        }
    }
    return { key, iv };
}

// Encrypt using CryptoJS format: "Salted__" + salt + ciphertext
function encryptData(plaintext, uid) {
    const passphrase = Buffer.from('CIT_SECRET_' + uid);
    const salt = crypto.randomBytes(8);
    const { key, iv } = deriveKeyAndIV(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from('Salted__'), salt, encrypted]).toString('base64');
}

// Decrypt CryptoJS format (fallback to old custom method if needed)
function decryptData(ciphertext, uid) {
    const passphrase = Buffer.from('CIT_SECRET_' + uid);
    const data = Buffer.from(ciphertext, 'base64');
    if (data.slice(0, 8).toString() === 'Salted__') {
        const salt = data.slice(8, 16);
        const encrypted = data.slice(16);
        const { key, iv } = deriveKeyAndIV(passphrase, salt);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return JSON.parse(decrypted.toString('utf8'));
    } else {
        // Fallback for old data encrypted with the SHA256 method
        const key = crypto.createHash('sha256').update('CIT_SECRET_' + uid).digest();
        const iv = Buffer.alloc(16, 0);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return JSON.parse(decrypted);
    }
}

function sendError(res, message, statusCode = 500) {
    if (res.headersSent) return;
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: message }));
}

// Main server
const server = http.createServer((req, res) => {
    Promise.resolve().then(async () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') return res.end();

        // Server status
        if (req.url === '/api/server-status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, status: "online" }));
        }

        // Block bots
        if (isBlocked(req)) {
            res.writeHead(403, { 'Content-Type': 'text/html' });
            return res.end("ACCESS DENIED");
        }

        // API routes
        if (req.url.startsWith('/api/')) {
            res.setHeader('Content-Type', 'application/json');

            // ---- Self-register ----
            if (req.url === '/api/self-register' && req.method === 'POST') {
                const body = await getBody(req);
                // Validate required fields
                if (!body.fullName || !body.email || !body.phone || !body.pin || !body.password) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ error: "Missing critical fields" }));
                }
                const uid = crypto.randomBytes(16).toString('hex');
                const accNum = "215" + crypto.randomBytes(5).toString('hex').replace(/[a-f]/g, '0').padEnd(10, '0').slice(0, 10);
                const memberID = "CIT" + crypto.randomBytes(4).toString('hex').replace(/[a-f]/g, '0').slice(0, 7);
                // Collect all form fields
                const userData = {
                    fullName: body.fullName,
                    email: body.email,
                    phone: body.phone,
                    pin: body.pin,
                    password: body.password,
                    accountNumber: accNum,
                    memberID: memberID,
                    balance: parseFloat(body.deposit) || 0,
                    transactions: {},
                    // Additional fields from selfaccountopen.html
                    dob: body.dob || "",
                    gender: body.gender || "",
                    marital: body.marital || "",
                    nationality: body.nationality || "",
                    placeOfBirth: body.placeOfBirth || "",
                    address: body.address || "",
                    city: body.city || "",
                    region: body.region || "",
                    postal: body.postal || "",
                    idType: body.idType || "",
                    idNumber: body.idNumber || "",
                    accType: body.accType || "Savings",
                    branch: body.branch || "Main Branch - Accra",
                    currency: body.currency || "GHS",
                    nokName: body.nokName || "",
                    nokRel: body.nokRel || "",
                    nokPhone: body.nokPhone || "",
                    nokEmail: body.nokEmail || "",
                    nokAddress: body.nokAddress || "",
                    nokCity: body.nokCity || "",
                    occupation: body.occupation || "",
                    employer: body.employer || "",
                    income: body.income || "",
                    sourceFunds: body.sourceFunds || "",
                    purpose: body.purpose || ""
                };
                const encryptedData = encryptData(userData, uid);

                try {
                    await httpsRequest(
                        `${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`,
                        { method: 'PUT', headers: { 'Content-Type': 'application/json' } },
                        { encryptedData }
                    );
                    res.writeHead(200);
                    return res.end(JSON.stringify({ success: true, uid }));
                } catch (e) {
                    return sendError(res, "DB Error: " + e.message, 500);
                }
            }

            // ---- Login ----
            if (req.url === '/api/login' && req.method === 'POST') {
                const body = await getBody(req);
                const { email, password } = body;
                if (!email || !password) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ success: false, error: "Missing email or password" }));
                }
                try {
                    const allUsers = await httpsRequest(`${FIREBASE_DB_URL}/users.json?auth=${FIREBASE_SECRET}`);
                    let foundUid = null, userData = null;
                    for (const uid in allUsers) {
                        if (allUsers.hasOwnProperty(uid)) {
                            const snap = allUsers[uid];
                            if (snap.encryptedData) {
                                try {
                                    const decrypted = decryptData(snap.encryptedData, uid);
                                    if (decrypted.email === email) {
                                        foundUid = uid;
                                        userData = decrypted;
                                        break;
                                    }
                                } catch (e) { continue; }
                            }
                        }
                    }
                    if (!foundUid || !userData) {
                        res.writeHead(404);
                        return res.end(JSON.stringify({ success: false, error: "User not found" }));
                    }
                    if (userData.password !== password) {
                        res.writeHead(401);
                        return res.end(JSON.stringify({ success: false, error: "Incorrect password" }));
                    }
                    res.writeHead(200);
                    return res.end(JSON.stringify({
                        success: true,
                        uid: foundUid,
                        user: {
                            fullName: userData.fullName,
                            accountNumber: userData.accountNumber,
                            memberID: userData.memberID,
                            email: userData.email,
                            phone: userData.phone,
                            balance: userData.balance || 0,
                            transactions: userData.transactions || {}
                        }
                    }));
                } catch (e) {
                    return sendError(res, "Database Error: " + e.message, 500);
                }
            }

            // ---- Dashboard (get full user data) ----
            if (req.url === '/api/dashboard' && req.method === 'POST') {
                const body = await getBody(req);
                const { uid } = body;
                if (!uid) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ success: false, error: "Missing uid" }));
                }
                try {
                    const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                    if (!snap.encryptedData) {
                        return sendError(res, "User not found", 404);
                    }
                    const decrypted = decryptData(snap.encryptedData, uid);
                    res.writeHead(200);
                    return res.end(JSON.stringify({ success: true, user: decrypted }));
                } catch (e) {
                    return sendError(res, "Database Error: " + e.message, 500);
                }
            }

            // ---- Init deposit (Paystack) ----
            if (req.url === '/api/init-deposit' && req.method === 'POST') {
                const body = await getBody(req);
                const { email, amount } = body;
                if (!email || !amount) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ success: false, error: "Email and amount required" }));
                }
                try {
                    const init = await httpsRequest(
                        "https://api.paystack.co/transaction/initialize",
                        {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' }
                        },
                        { 
                            email, 
                            amount: Math.round(amount * 100), 
                            reference: 'CIT' + Date.now(),
                            callback_url: body.callback_url || `${req.headers.origin}/userlogin.html`
                        }
                    );
                    if (init.status && init.status === true) {
                        return res.end(JSON.stringify({ success: true, authorization_url: init.data.authorization_url }));
                    } else {
                        return sendError(res, "Paystack Error: " + (init.message || 'Unknown'), 400);
                    }
                } catch (e) {
                    return sendError(res, "Paystack Error", 500);
                }
            }

            // ---- Verify payment and update balance ----
            if (req.url === '/api/verify-payment' && req.method === 'POST') {
                const body = await getBody(req);
                const { reference, uid } = body;
                if (!reference || !uid) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ success: false, error: "Reference and uid required" }));
                }
                try {
                    const verify = await httpsRequest(
                        `https://api.paystack.co/transaction/verify/${reference}`,
                        { headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` } }
                    );
                    if (verify.data.status === 'success') {
                        const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                        if (!snap.encryptedData) {
                            return sendError(res, "User not found", 404);
                        }
                        const userData = decryptData(snap.encryptedData, uid);
                        userData.balance = (userData.balance || 0) + (verify.data.amount / 100);
                        // Add transaction record
                        if (!userData.transactions) userData.transactions = {};
                        const txId = Date.now().toString();
                        userData.transactions[txId] = {
                            type: "deposit",
                            amount: verify.data.amount / 100,
                            date: new Date().toISOString()
                        };
                        await httpsRequest(
                            `${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`,
                            { method: 'PUT', headers: { 'Content-Type': 'application/json' } },
                            { encryptedData: encryptData(userData, uid) }
                        );
                        return res.end(JSON.stringify({ success: true }));
                    } else {
                        return sendError(res, "Payment not successful", 400);
                    }
                } catch (e) {
                    return sendError(res, "Verification Error: " + e.message, 500);
                }
            }

            // Unknown API
            res.writeHead(404);
            return res.end(JSON.stringify({ error: "API Not Found" }));
        }

        // ---- Static files ----
        let requestedPath = req.url.split('?')[0];
        if (requestedPath === '/' || requestedPath === '') requestedPath = '/userlogin.html';

        let filePath = path.join(__dirname, requestedPath);
        if (!filePath.startsWith(__dirname)) {
            res.writeHead(403);
            return res.end("Forbidden");
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                return res.end('File not found');
            }
            let ext = path.extname(filePath);
            let type = 'text/html';
            if (ext === '.css') type = 'text/css';
            if (ext === '.js') type = 'application/javascript';
            if (ext === '.png') type = 'image/png';
            if (ext === '.jpg') type = 'image/jpeg';
            if (ext === '.ico') type = 'image/x-icon';

            if (type === 'text/html') {
                let content = data.toString('utf8');
                const snippet = `<script>(function(){var o=document.createElement('div');o.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:#041525;z-index:999999;display:flex;flex-direction:column;justify-content:center;align-items:center;color:white;font-family:Arial;';o.innerHTML='<div id="statusIcon" style="font-size:60px;color:#e0a800;animation:spin 2s linear infinite;"><i class="fa-solid fa-server"></i></div><h2 style="margin-top:20px;">Checking Server...</h2>';document.body.appendChild(o);var s=document.createElement('style');s.innerHTML='@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';document.head.appendChild(s);fetch('/api/server-status').then(function(r){if(r.ok){var i=document.getElementById('statusIcon');i.style.animation='none';i.style.color='#00c853';i.innerHTML='<i class="fa-solid fa-circle-check"></i>';o.querySelector('h2').innerText='Server Online!';setTimeout(function(){o.style.transition='opacity 0.5s';o.style.opacity='0';setTimeout(function(){if(o.parentNode)o.parentNode.removeChild(o);},500);},1500);}else{throw new Error('bad');}}).catch(function(){var i=document.getElementById('statusIcon');i.style.animation='none';i.style.color='#ff4d4d';i.innerHTML='<i class="fa-solid fa-circle-xmark"></i>';o.querySelector('h2').innerText='Server Offline!';setTimeout(function(){o.style.transition='opacity 0.5s';o.style.opacity='0';setTimeout(function(){if(o.parentNode)o.parentNode.removeChild(o);},500);},3000);});})();document.addEventListener('contextmenu',function(e){e.preventDefault();});</script>`;
                if (content.includes('</body>')) {
                    content = content.replace('</body>', snippet + '</body>');
                }
                try {
                    const gzipped = zlib.gzipSync(content);
                    res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' });
                    return res.end(gzipped);
                } catch (gzipErr) {
                    res.writeHead(200, { 'Content-Type': type });
                    return res.end(content);
                }
            }
            res.writeHead(200, { 'Content-Type': type });
            res.end(data);
        });
    }).catch((error) => {
        console.error("Request failed:", error);
        sendError(res, "Internal Server Error", 500);
    });
});

server.listen(PORT, () => console.log("CIT FUND Server online!"));