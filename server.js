/* ============================================================
 *  CITFUND ENTERPRISE — SERVER v13.0
 *  - WebAuthn fingerprint login ⭐
 *  - Change password / PIN with verification ⭐
 *  - Session tokens, beneficiaries, standing orders ⭐
 *  - Admin dashboard + metrics + health ⭐
 *  - Referrals, announcements, feature flags ⭐
 *  - All v12 features preserved
 * ============================================================ */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// ============================================================
// KEEP-ALIVE HTTPS AGENT
// ============================================================
const httpsAgent = new https.Agent({
    keepAlive: true, keepAliveMsecs: 30000,
    maxSockets: 100, maxFreeSockets: 20
});

// ============================================================
// CLOUDINARY
// ============================================================
let cloudinary = null, cloudinaryConfigured = false;
try {
    cloudinary = require('cloudinary').v2;
    cloudinary.config({
        cloud_name: 'eqwzfghw',
        api_key: '965386697474534',
        api_secret: process.env.CLOUDINARY_SECRET || 'bWKDW1305Dy9esrqYUO9ZPBh8vw',
        secure: true
    });
    cloudinaryConfigured = true;
    console.log('[OK] Cloudinary loaded');
} catch (e) { console.warn('[WARN] Cloudinary not available'); }

// ============================================================
// KYC FIREBASE
// ============================================================
const KYC_FIREBASE_DB_URL = "https://kyc-cit-user-default-rtdb.firebaseio.com";
function kycRequest(p, method = 'GET', body = null) {
    const url = `${KYC_FIREBASE_DB_URL}${p}.json`;
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method, headers: { 'Content-Type': 'application/json' }, agent: httpsAgent
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); } catch { resolve({}); }
                } else reject(new Error(`KYC DB HTTP ${res.statusCode}`));
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}
async function uploadImage(imageData, folder, uid) {
    if (cloudinaryConfigured) {
        try {
            const r = await cloudinary.uploader.upload(imageData, {
                folder: `cit_fund/kyc/${uid}/${folder}`,
                allowed_formats: ['jpg', 'png', 'jpeg'],
                transformation: [{ quality: 'auto:good' }, { fetch_format: 'auto' }]
            });
            return r.secure_url;
        } catch (e) { console.warn('Cloudinary fail:', e.message); }
    }
    return imageData;
}

// ============================================================
// SECRETS & CONFIG
// ============================================================
const FIREBASE_SECRET     = process.env.FIREBASE_SECRET  || "90tPeiM0evu2QTt9dODNXPo04ktQ5wCAu8wQbL4O";
const FIREBASE_DB_URL     = process.env.FIREBASE_DB_URL  || "https://sir-cosmos-default-rtdb.firebaseio.com";
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET || "sk_live_620c49aba82ff76bcf46b6d9f8d8df15ece96ccf";
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || 'https://citfund.com';
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || '0205720154';
const AGENT_SECRET = process.env.AGENT_SECRET || '049aae1d-cb5e-43c2-9c6e-a93bc11cd620';
const SERVER_START_TIME = Date.now();

const ACCOUNT_OPENING_FEE = 10;
const DVA_COMING_SOON_MSG = 'Dedicated Virtual Account is coming soon. Please use your CITFUND account number for now.';
const MS_PER_DAY = 86400000;
const SERVER_VERSION = '13.0';

// ============================================================
// TIERED FEE ENGINE
// ============================================================
const FEE_TIERS = [
    { min: 1,        max: 50,       type: 'flat',    value: 1.00, label: 'GHS 1.00 (flat)' },
    { min: 50.01,    max: 99.99,    type: 'flat',    value: 1.50, label: 'GHS 1.50 (flat)' },
    { min: 100,      max: 199.99,   type: 'percent', value: 1.5,  label: '1.5%' },
    { min: 200,      max: 300,      type: 'percent', value: 2.7,  label: '2.7%' },
    { min: 300.01,   max: 500,      type: 'percent', value: 2.5,  label: '2.5%' },
    { min: 500.01,   max: 1000,     type: 'percent', value: 2.2,  label: '2.2%' },
    { min: 1000.01,  max: 2000,     type: 'percent', value: 2.0,  label: '2.0%' },
    { min: 2000.01,  max: 5000,     type: 'percent', value: 1.8,  label: '1.8%' },
    { min: 5000.01,  max: 10000,    type: 'percent', value: 1.5,  label: '1.5%' },
    { min: 10000.01, max: 50000,    type: 'percent', value: 1.2,  label: '1.2%' },
    { min: 50000.01, max: Infinity, type: 'percent', value: 1.0,  label: '1.0%' }
];

function calculateTieredFee(amount) {
    const gross = Number(amount) || 0;
    if (gross < 1) return { gross, fee: 0, net: 0, tier: null, error: 'Minimum GHS 1.00' };
    const tier = FEE_TIERS.find(t => gross >= t.min && gross <= t.max);
    if (!tier) return { gross, fee: 0, net: gross, tier: null };
    let fee = (tier.type === 'flat') ? tier.value : Number((gross * (tier.value / 100)).toFixed(2));
    fee = Math.min(fee, Number((gross * 0.5).toFixed(2)));
    return { gross, fee, net: Number((gross - fee).toFixed(2)), tier, label: tier.label };
}
function calculateDepositFee(amount) {
    const r = calculateTieredFee(amount);
    return { gross: r.gross, fee: r.fee, netAfterFee: r.net, tier: r.tier, label: r.label };
}
function calculateWithdrawFee(amount) {
    const r = calculateTieredFee(amount);
    return { gross: r.gross, fee: r.fee, totalDebit: Number((r.gross + r.fee).toFixed(2)), tier: r.tier, label: r.label };
}

// ============================================================
// TRANSACTION MATRIX + GREETINGS
// ============================================================
const TRANSACTION_TYPES = ['deposit','withdraw','transfer','invest','invest_withdraw','loan_disbursement','loan_repayment','bill','airtime','order','referral_bonus','standing_order'];
const TRANSACTION_STATUS = ['pending','processing','success','failed','cancelled','expired','reversed','refunded'];
const TRANSACTION_GATEWAYS = ['paystack','internal','manual','admin','investment_engine','loan_engine','referral_engine','standing_order_engine'];
const TRANSACTION_NETWORKS = ['mtn','telecel','airteltigo','airtel','internal'];
function generateTransactionMatrix() {
    const combos = [];
    for (const t of TRANSACTION_TYPES)
        for (const s of TRANSACTION_STATUS)
            for (const g of TRANSACTION_GATEWAYS)
                for (const n of TRANSACTION_NETWORKS)
                    combos.push({ type: t, status: s, gateway: g, network: n, code: `${t.toUpperCase()}_${s.toUpperCase()}_${g.toUpperCase()}_${n.toUpperCase()}` });
    return combos;
}
const TX_MATRIX = generateTransactionMatrix();

const GREETINGS = {
    morning:   ['Good morning', 'Morning sunshine', 'Hello early bird', 'Rise and shine', 'A bright morning to you'],
    afternoon: ['Good afternoon', 'Hello there', 'Hope your day is going well', 'Hello and welcome', 'A pleasant afternoon'],
    evening:   ['Good evening', 'Hope you had a great day', 'Welcome back this evening', 'Evening greetings', 'Hello there'],
    night:     ['Good night', 'Sweet dreams', 'Sleep well', 'Rest easy tonight', 'A calm night to you']
};
function getTimeGreeting() {
    const h = new Date().getHours();
    const period = h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
    const arr = GREETINGS[period];
    return arr[Math.floor(Math.random() * arr.length)];
}
const MOTIVATIONAL_PHRASES = [
    "Your future self will thank you for every deposit you make today.",
    "Small, consistent savings grow into great wealth.",
    "The best time to invest was yesterday. The next best is now.",
    "Every cedi you save is a step toward freedom.",
    "Discipline today, prosperity tomorrow.",
    "Financial freedom starts with a decision.",
    "Don't just earn — let your money earn for you.",
    "A journey of a thousand cedis begins with one deposit.",
    "Wealth is built one smart decision at a time.",
    "You are one deposit away from a better future.",
    "Compound interest is the eighth wonder of the world.",
    "Save now, celebrate later.",
    "Your money deserves to work as hard as you do.",
    "Grow your money while you sleep — 5% every 15 days.",
    "Turning small deposits into big dreams.",
    "The secret to wealth is patience, not luck.",
    "Invest in your future — one cedi at a time.",
    "Your bank account reflects your decisions.",
    "Make your money your best employee.",
    "Prosperity is a habit, not an accident.",
    "Every investment is a seed for a better tomorrow.",
    "Frugality today, abundance tomorrow.",
    "Don't wait to invest — invest to grow.",
    "A wise person turns savings into streams of income.",
    "Wealth is not about how much you make, but how you grow it.",
    "Start small. Think big. Grow steadily.",
    "The rich save first, spend later.",
    "Let your money multiply while you rest.",
    "One smart deposit is worth a thousand excuses.",
    "Your financial future is in your hands — today.",
    "Turn patience into profit with CITFUND.",
    "A small step today is a giant leap tomorrow.",
    "Sow today, reap in 15 days.",
    "Money grows when it is invested, not when it sleeps.",
    "Financial freedom is a choice. Make it today.",
    "A stronger tomorrow begins with a smarter today.",
    "Your money has a mission. Let it grow.",
    "Prosperity is built by those who plan.",
    "Add to your savings like you add to your dreams.",
    "You are richer today than yesterday if you saved."
];
function pickRandomMotivation() {
    return MOTIVATIONAL_PHRASES[Math.floor(Math.random() * MOTIVATIONAL_PHRASES.length)];
}

// ============================================================
// CHAT CONFIG
// ============================================================
const CHAT_SUPPORT_UID = 'CITFUND_SUPPORT';
const CHAT_SUPPORT_NAME = 'CITFUND Support';
const CHAT_MAX_TEXT_LEN = 4000;
const CHAT_MAX_IMAGE_BYTES = 1500000;
const CHAT_SUPPORT_REPLY_DELAY_MS = 1200;

// ============================================================
// PAYSTACK NETWORKS
// ============================================================
const PAYSTACK_NETWORK_CODES = {
    mtn: 'MTN', telecel: 'VOD', vodafone: 'VOD',
    airtel: 'ATL', airteltigo: 'ATL', tigo: 'ATL'
};

// ============================================================
// FORGOT-CREDENTIALS CONFIG
// ============================================================
const FORGOT_OTP_EXPIRY_MS      = 5 * 60 * 1000;
const FORGOT_SESSION_EXPIRY_MS  = 10 * 60 * 1000;
const FORGOT_MAX_ATTEMPTS       = 5;
const FORGOT_SEND_COOLDOWN_MS   = 60 * 60 * 1000;

// ============================================================
// WEBAUTHN CONFIG
// ============================================================
const WEBAUTHN_RP_NAME = 'CITFUND ENTERPRISE';
const WEBAUTHN_CHALLENGE_MS = 5 * 60 * 1000;
const WEBAUTHN_PIN_TOKEN_MS = 5 * 60 * 1000;
const WEBAUTHN_MAX_CREDS = 5;

const webAuthnChallenges = new Map();
const pinSessionTokens = new Map();

// ⭐ NEW: Server-side session tokens (short-lived JWT-like)
const apiSessionTokens = new Map();   // token -> { uid, expires, ip, ua }
const API_SESSION_MS = 24 * 60 * 60 * 1000; // 24 hours

// ⭐ NEW: Support tickets store
const supportTickets = new Map();     // ticketId -> { uid, subject, message, status, createdAt, replies: [] }

// ⭐ NEW: Announcements (system-wide)
const announcements = [];             // [{ id, title, body, level, active, createdAt, expiresAt }]

// ⭐ NEW: Feature flags
const featureFlags = {
    webauthn_login: true,
    forgot_credentials: true,
    referrals: true,
    standing_orders: true,
    support_tickets: true,
    announcements: true,
    bill_payments: true,
    airtime: true,
    cards: true,
    loans: true,
    investments: true,
    chat: true
};

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of webAuthnChallenges) if (now > v.expires) webAuthnChallenges.delete(k);
    for (const [k, v] of pinSessionTokens) if (now > v.expires) pinSessionTokens.delete(k);
    for (const [k, v] of apiSessionTokens) if (now > v.expires) apiSessionTokens.delete(k);
}, 2 * 60 * 1000);

// ============================================================
// RATE LIMITER
// ============================================================
const rateBuckets = new Map();
function rateLimit(ip, route, max, windowMs) {
    const key = ip + '|' + route;
    const now = Date.now();
    let arr = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) { rateBuckets.set(key, arr); return false; }
    arr.push(now); rateBuckets.set(key, arr);
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of rateBuckets) {
        const f = arr.filter(t => now - t < 15 * 60 * 1000);
        if (!f.length) rateBuckets.delete(k); else rateBuckets.set(k, f);
    }
}, 5 * 60 * 1000);

// ============================================================
// AUTH LOCKOUT
// ============================================================
const authFails = new Map();
const AUTH_FAIL_LIMIT = 5;
const AUTH_LOCK_MS = 15 * 60 * 1000;
function recordAuthFail(key) {
    const rec = authFails.get(key) || { count: 0, until: 0 };
    rec.count++;
    if (rec.count >= AUTH_FAIL_LIMIT) { rec.until = Date.now() + AUTH_LOCK_MS; rec.count = 0; }
    authFails.set(key, rec);
}
function isAuthLocked(key) {
    const rec = authFails.get(key);
    if (!rec) return false;
    if (rec.until && rec.until > Date.now()) return true;
    if (rec.until && rec.until <= Date.now()) authFails.delete(key);
    return false;
}
function clearAuthFails(key) { authFails.delete(key); }

// ============================================================
// SMS DEDUP
// ============================================================
const smsDedup = new Map();
function canSendSMS(phone, dedupKey, windowMs = 30000) {
    const key = phone + '|' + dedupKey;
    const last = smsDedup.get(key) || 0;
    if (Date.now() - last < windowMs) return false;
    smsDedup.set(key, Date.now());
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, t] of smsDedup) if (now - t > 10 * 60 * 1000) smsDedup.delete(k);
}, 60 * 1000);

// ============================================================
// AUDIT LOG
// ============================================================
const auditLog = [];
function audit(action, actor, target, details) {
    const entry = {
        ts: new Date().toISOString(),
        action, actor: String(actor || '').slice(0, 40),
        target: String(target || '').slice(0, 40),
        details: details ? String(JSON.stringify(details)).slice(0, 200) : ''
    };
    auditLog.push(entry);
    if (auditLog.length > 500) auditLog.splice(0, auditLog.length - 500);
    console.log('[AUDIT]', action, actor, target);
}

// ============================================================
// SECURITY HEADERS
// ============================================================
function setSecurityHeaders(res) {
    try {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('X-XSS-Protection', '1; mode=block');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
        res.removeHeader('X-Powered-By');
    } catch (e) {}
}

// ============================================================
// SANITIZE / VALIDATE / CRYPTO
// ============================================================
function sanitizeInput(v) {
    if (v == null) return v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v !== 'string') return v;
    return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}
function sanitizeBody(body) {
    if (!body || typeof body !== 'object') return body;
    const out = Array.isArray(body) ? [] : {};
    for (const k in body) {
        if (Object.prototype.hasOwnProperty.call(body, k)) {
            const v = body[k];
            if (v && typeof v === 'object' && !Buffer.isBuffer(v)) out[k] = sanitizeBody(v);
            else out[k] = sanitizeInput(v);
        }
    }
    return out;
}
function validatePasswordStrength(pw) {
    if (!pw || typeof pw !== 'string' || pw.length < 6) return 'Password must be at least 6 characters';
    if (pw.length > 128) return 'Password too long';
    if (/^(.)\1+$/.test(pw)) return 'Password too simple';
    if (/^(0123|1234|abcd|password|qwerty)/i.test(pw)) return 'Password too common';
    return null;
}
function validatePinStrength(pin) {
    if (!pin || typeof pin !== 'string') return 'PIN is required';
    if (!/^\d{4,6}$/.test(pin)) return 'PIN must be 4–6 digits';
    if (/^(\d)\1+$/.test(pin)) return 'PIN cannot be all same digits';
    if (/^(0123|1234|12345|123456|0000|1111)/.test(pin)) return 'PIN too simple';
    return null;
}
function safeEqual(a, b) {
    try {
        const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
        if (ab.length !== bb.length) return false;
        return crypto.timingSafeEqual(ab, bb);
    } catch { return false; }
}
function deriveKeyAndIV(passphrase, salt, keyLength = 32, ivLength = 16) {
    let key = Buffer.alloc(keyLength), iv = Buffer.alloc(ivLength);
    let prev = Buffer.alloc(0), kf = 0, ivf = 0;
    while (kf < keyLength || ivf < ivLength) {
        const h = crypto.createHash('md5'); h.update(prev); h.update(passphrase); h.update(salt);
        prev = h.digest();
        const nk = keyLength - kf, ni = ivLength - ivf;
        if (nk > 0) { const t = Math.min(nk, prev.length); prev.copy(key, kf, 0, t); kf += t; }
        if (ni > 0 && kf >= keyLength) { const t = Math.min(ni, prev.length); prev.copy(iv, ivf, 0, t); ivf += t; }
    }
    return { key, iv };
}
function encryptData(pt, uid) {
    const pass = Buffer.from('CIT_SECRET_' + uid);
    const salt = crypto.randomBytes(8);
    const { key, iv } = deriveKeyAndIV(pass, salt);
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(pt), 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from('Salted__'), salt, enc]).toString('base64');
}
function decryptData(ct, uid) {
    const pass = Buffer.from('CIT_SECRET_' + uid);
    const d = Buffer.from(ct, 'base64');
    if (d.slice(0, 8).toString() === 'Salted__') {
        const salt = d.slice(8, 16), enc = d.slice(16);
        const { key, iv } = deriveKeyAndIV(pass, salt);
        const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let out = dec.update(enc);
        out = Buffer.concat([out, dec.final()]);
        return JSON.parse(out.toString('utf8'));
    } else {
        const key = crypto.createHash('sha256').update('CIT_SECRET_' + uid).digest();
        const iv = Buffer.alloc(16, 0);
        const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let out = dec.update(ct, 'base64', 'utf8');
        out += dec.final('utf8');
        return JSON.parse(out);
    }
}

// ============================================================
// PROCESS SAFETY
// ============================================================
process.on('warning', () => {});
process.on('uncaughtException', (err) => console.error("UNCAUGHT:", err.stack || err.message));
process.on('unhandledRejection', (r) => console.error("UNHANDLED:", r));

// ============================================================
// SCANNER FLOOD
// ============================================================
const scannerHits = new Map();
function isScannerFlood(ip) {
    const now = Date.now();
    const arr = (scannerHits.get(ip) || []).filter(t => now - t < 60000);
    arr.push(now); scannerHits.set(ip, arr);
    return arr.length > 200;
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, arr] of scannerHits) {
        const f = arr.filter(t => now - t < 5 * 60 * 1000);
        if (!f.length) scannerHits.delete(ip); else scannerHits.set(ip, f);
    }
}, 60 * 1000);

// ============================================================
// HELPERS
// ============================================================
function formatMoney(a) {
    return 'GHS ' + Number(a || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function formatShortDate() {
    return new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
}
function formatDateLong(ts) {
    return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function jsonRes(res, data, statusCode = 200) {
    if (res.headersSent || res.writableEnded) return;
    try {
        const body = JSON.stringify(data);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
        });
        res.end(body);
    } catch (e) { console.error('jsonRes failed:', e.message); }
}
function sendError(res, message, statusCode = 500) {
    jsonRes(res, { success: false, error: String(message || 'Server error') }, statusCode);
}
function maskPhone(phone) {
    const p = String(phone || '').replace(/\s+/g, '');
    if (p.length < 4) return '*** *** ****';
    return p.slice(0, 3) + ' *** ' + p.slice(-4);
}
function withTimeout(promise, ms, tag) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error((tag || 'Operation') + ' timed out')), ms))
    ]);
}

// ============================================================
// CBOR DECODER (for WebAuthn)
// ============================================================
function decodeCBOR(buffer) {
    let offset = 0;
    function readUint8() { return buffer[offset++]; }
    function readUint16() { const v = buffer.readUInt16BE(offset); offset += 2; return v; }
    function readUint32() { const v = buffer.readUInt32BE(offset); offset += 4; return v; }
    function readUint64() {
        const hi = buffer.readUInt32BE(offset);
        const lo = buffer.readUInt32BE(offset + 4);
        offset += 8;
        return hi * 0x100000000 + lo;
    }
    function decode() {
        const byte = readUint8();
        const major = byte >> 5;
        const additional = byte & 0x1f;
        let val;
        if (additional < 24) val = additional;
        else if (additional === 24) val = readUint8();
        else if (additional === 25) val = readUint16();
        else if (additional === 26) val = readUint32();
        else if (additional === 27) val = readUint64();
        else if (additional === 31) val = null;
        else throw new Error('Invalid CBOR');

        if (major === 0) return val;
        if (major === 1) return -1 - val;
        if (major === 2) { const b = buffer.slice(offset, offset + val); offset += val; return b; }
        if (major === 3) { const s = buffer.toString('utf8', offset, offset + val); offset += val; return s; }
        if (major === 4) {
            const arr = [];
            if (val === null) { while (buffer[offset] !== 0xff) arr.push(decode()); offset++; }
            else for (let i = 0; i < val; i++) arr.push(decode());
            return arr;
        }
        if (major === 5) {
            const map = {};
            if (val === null) { while (buffer[offset] !== 0xff) { const k = decode(); const v = decode(); map[k] = v; } offset++; }
            else for (let i = 0; i < val; i++) { const k = decode(); const v = decode(); map[k] = v; }
            return map;
        }
        if (major === 6) return decode();
        if (major === 7) {
            if (additional === 20) return false;
            if (additional === 21) return true;
            if (additional === 22) return null;
            if (additional === 23) return undefined;
            throw new Error('Unsupported CBOR simple value');
        }
        throw new Error('Unsupported CBOR major type');
    }
    return decode();
}

// ============================================================
// WEBAUTHN HELPERS
// ============================================================
function b64urlToBuffer(str) {
    str = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64');
}
function bufferToB64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function parseAuthData(buffer) {
    let offset = 0;
    const rpIdHash = buffer.slice(0, 32); offset = 32;
    const flags = buffer[offset]; offset += 1;
    const signCount = buffer.readUInt32BE(offset); offset += 4;
    const uv = (flags & 0x04) !== 0;
    const at = (flags & 0x40) !== 0;
    let aaguid = null, credentialId = null, credentialPublicKey = null;
    if (at) {
        if (buffer.length < offset + 18) throw new Error('Invalid authData');
        aaguid = buffer.slice(offset, offset + 16); offset += 16;
        const credIdLen = buffer.readUInt16BE(offset); offset += 2;
        if (buffer.length < offset + credIdLen) throw new Error('Invalid credentialId length');
        credentialId = buffer.slice(offset, offset + credIdLen); offset += credIdLen;
        credentialPublicKey = buffer.slice(offset);
    }
    return { rpIdHash, flags, signCount, uv, at, aaguid, credentialId, credentialPublicKey };
}

// ============================================================
// SMS TEMPLATES
// ============================================================
const BRAND = 'CITFUND ENTERPRISE';
const SUPPORT_LINE = `Support: ${SUPPORT_PHONE}`;

const SMS = {
    welcomeWithCredentials: (u, acc, mid, regRef, loginUrl) =>
`${BRAND}
========================
WELCOME, ${u.fullName}!

Your CITFUND account is now ACTIVE. ✅

---- LOGIN CREDENTIALS ----
Login URL:  ${loginUrl}
Email:      ${u.email}
Password:   ${u.password}
CIT Account:${acc}
Member ID:  ${mid}

---- SECURITY REMINDER ----
• PIN (4-6 digits): keep PRIVATE
• Never share your PIN with anyone
• CITFUND will NEVER ask for your PIN
• Change password anytime in Profile → Security

---- NEXT STEPS ----
1) Log in and change your password
2) Complete your KYC for higher limits
3) Make your first deposit and start earning 5% every 15 days

---- IMPORTANT ----
• One-time opening fee: ${formatMoney(ACCOUNT_OPENING_FEE)} (from 1st deposit)
• Tiered deposit/withdrawal fees apply
• Internal transfers: FREE

Ref: ${regRef}
${SUPPORT_LINE}
========================
Save this message securely — you may need it later.`,

    otp: (otp, acc) =>
`${BRAND} — OTP
========================
Your One-Time Password:

     ${otp}

Valid 5 minutes.
Account: ${acc}
Never share this code.
========================`,

    forgotOtp: (otp) =>
`${BRAND} — RECOVERY CODE
========================
Your credential recovery code is:

     ${otp}

Valid for 5 minutes.
If you did NOT request this, IGNORE this SMS and call ${SUPPORT_PHONE} immediately.
========================`,

    forgotCredentials: (u, loginUrl) =>
`${BRAND} — YOUR CREDENTIALS
========================
Hello ${(u.fullName || 'Member').split(' ')[0]},

You requested your account details.

---- LOGIN INFO ----
Login URL:   ${loginUrl}/userlogin.html
Email:       ${u.email || '-'}
CIT Account: ${u.accountNumber || '-'}
Member ID:   ${u.memberID || '-'}

---- SECURITY TIPS ----
1) Log in NOW and change your password
2) Set a strong, unique password (6+ chars)
3) Never share your PIN with anyone
4) CITFUND will NEVER ask for your PIN

If you did NOT request this, call ${SUPPORT_PHONE} IMMEDIATELY.
========================`,

    passwordChanged: (u) =>
`${BRAND} — PASSWORD CHANGED ✅
========================
Hi ${(u.fullName || 'Member').split(' ')[0]},

Your password was changed successfully.

Time: ${formatShortDate()}

If this wasn't you, call ${SUPPORT_PHONE} IMMEDIATELY.
========================`,

    pinChanged: (u) =>
`${BRAND} — PIN CHANGED ✅
========================
Hi ${(u.fullName || 'Member').split(' ')[0]},

Your transaction PIN was changed.

Time: ${formatShortDate()}

If this wasn't you, call ${SUPPORT_PHONE} IMMEDIATELY.
========================`,

    depositPending: (a, f, r, label) =>
`${BRAND} — DEPOSIT STARTED
========================
Amount: ${formatMoney(a)}
Fee:    ${formatMoney(f)} (${label || 'tiered'})
Ref:    ${r}

Approve the MoMo prompt on your phone to complete.
========================`,

    depositCredited: (g, f, of, c, nb, r, label) =>
`${BRAND} — DEPOSIT CREDITED ✅
========================
Gross:        ${formatMoney(g)}
Fee (${label || 'tier'}):  ${formatMoney(f)}${of > 0 ? `\nOpening Fee:  ${formatMoney(of)}` : ''}
Credited:     ${formatMoney(c)}
New Balance:  ${formatMoney(nb)}
Ref:          ${r}
========================`,

    depositFailed: (a, r, reason) =>
`${BRAND} — DEPOSIT FAILED
========================
Amount: ${formatMoney(a)}
Ref:    ${r}
Reason: ${reason}

No money was taken from your wallet.
========================`,

    transferSent: (a, n, acc, r, nb) =>
`${BRAND} — TRANSFER SENT
========================
Sent:        ${formatMoney(a)}
To:          ${n}
Account:     ${acc}
Fee:         FREE
New Balance: ${formatMoney(nb)}
Ref:         ${r}

Delivered instantly.
========================`,

    transferReceived: (a, n, acc, r, nb) =>
`${BRAND} — MONEY RECEIVED
========================
Received:    ${formatMoney(a)}
From:        ${n}
Account:     ${acc}
New Balance: ${formatMoney(nb)}
Ref:         ${r}
========================`,

    investCreated: (pn, a, rate, d, mat, id) =>
`${BRAND} — INVESTMENT ACTIVE
========================
Plan:    ${pn}
Amount:  ${formatMoney(a)}
Rate:    ${rate}% over ${d} days
Matures: ${mat}
Ref:     ${id}

Your money is now working for you.
========================`,

    investMatured: (pn, p, y, t, nb, id) =>
`${BRAND} — INVESTMENT MATURED
========================
Plan:        ${pn}
Principal:   ${formatMoney(p)}
Profit:      ${formatMoney(y)}
Total:       ${formatMoney(t)}
New Balance: ${formatMoney(nb)}
Ref:         ${id}

Congratulations!
========================`,

    withdrawRequested: (a, f, td, mp, id, label) =>
`${BRAND} — WITHDRAWAL STARTED
========================
Withdraw:   ${formatMoney(a)}
Fee (${label || 'tier'}): ${formatMoney(f)}
Debited:    ${formatMoney(td)}
MoMo:       ${mp}
Ref:        ${id}

Transfer in progress. Funds arrive in seconds.
========================`,

    withdrawSuccess: (a, mp, nb, id) =>
`${BRAND} — WITHDRAWAL SUCCESSFUL ✅
========================
Amount:      ${formatMoney(a)}
MoMo:        ${mp}
New Balance: ${formatMoney(nb)}
Ref:         ${id}
========================`,

    withdrawFailed: (a, reason, id) =>
`${BRAND} — WITHDRAWAL FAILED
========================
Amount: ${formatMoney(a)}
Ref:    ${id}
Reason: ${reason}

Your balance has been refunded.
========================`,

    kycSubmitted: (n) =>
`${BRAND} — KYC RECEIVED
========================
Hi ${n},

We received your KYC documents.
Review within 24 hours.
========================`,

    kycApproved: (n) =>
`${BRAND} — KYC APPROVED ✅
========================
Congratulations ${n}!

Identity verified. Account fully active.
========================`,

    kycRejected: (n, reason) =>
`${BRAND} — KYC REJECTED
========================
Hi ${n},

Reason: ${reason || 'Document unclear'}

Please resubmit from the KYC page.
========================`,

    loanApplied: (p, a, id) =>
`${BRAND} — LOAN APPLICATION
========================
Product: ${p}
Amount:  ${formatMoney(a)}
Ref:     ${id}

Under review (24h).
========================`,

    loanApproved: (p, a, id) =>
`${BRAND} — LOAN APPROVED ✅
========================
Product: ${p}
Amount:  ${formatMoney(a)}
Ref:     ${id}

Funds to wallet shortly.
========================`,

    loanRejected: (p, id, reason) =>
`${BRAND} — LOAN DECLINED
========================
Product: ${p}
Ref:     ${id}
Reason:  ${reason || 'Not eligible at this time'}
========================`,

    reengage: (name, body) =>
`${BRAND}
========================
${name}, ${body}

Open the app to continue →
${APP_URL}
${SUPPORT_LINE}
========================`,

    referralBonus: (u, bonus, refName) =>
`${BRAND} — REFERRAL BONUS 🎉
========================
Congratulations ${(u.fullName || 'Member').split(' ')[0]}!

${refName} joined using your referral code.

Bonus: ${formatMoney(bonus)} credited.
New Balance: ${formatMoney(u.balance)}

Keep sharing — earn more!
========================`,

    announcement: (title, body) =>
`${BRAND} — ANNOUNCEMENT
========================
${title}

${body}

${SUPPORT_LINE}
========================`,

    supportTicketReply: (ticketId, reply) =>
`${BRAND} — SUPPORT TICKET #${ticketId}
========================
Reply:

${String(reply).slice(0, 300)}

Log in to view the full thread.
${SUPPORT_LINE}
========================`,

    miniStatement: (u, txs) => {
        const lines = txs.slice(0, 5).map(t =>
            `• ${new Date(t.date).toLocaleDateString('en-GB',{day:'2-digit',month:'short'})} ${t.type.toUpperCase()} ${formatMoney(t.amount)} [${t.status}]`).join('\n');
        return `${BRAND} — MINI STATEMENT
========================
Hi ${u.fullName},

Balance: ${formatMoney(u.balance)}

Recent Activity:
${lines}

Full statement in the app.
${SUPPORT_LINE}
========================`;
    }
};

async function sendSMS(phone, message, dedupKey = null, dedupMs = 30000) {
    try {
        if (!phone) return { sent: false, reason: 'no-phone' };
        if (dedupKey && !canSendSMS(String(phone), dedupKey, dedupMs)) return { sent: false, reason: 'dedup' };
        const p = String(phone).replace(/^0/, '233').replace(/\D/g, '');
        const m = String(message).replace(/[^\x20-\x7E\n]/g, '').replace(/\n{3,}/g, '\n\n');
        await httpsRequest(`https://smsc.hubtel.com/v1/messages/send?clientsecret=njpupech&clientid=tptqvikq&from=DZINPA&to=${p}&content=${encodeURIComponent(m)}`);
        return { sent: true };
    } catch (e) { console.error("SMS fail:", e.message); return { sent: false, error: e.message }; }
}

// ============================================================
// HTTPS REQUEST
// ============================================================
function httpsRequest(url, options = {}, postData = null) {
    return new Promise((resolve, reject) => {
        if (!options.agent) options.agent = httpsAgent;
        if (postData) {
            options.method = options.method || 'POST';
            options.headers = options.headers || {};
            options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';
        }
        const req = https.request(url, options, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(d)); } catch { resolve({}); }
                } else reject(new Error(`HTTP ${res.statusCode}: ${String(d).slice(0, 300)}`));
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
        if (postData) {
            const body = JSON.stringify(postData);
            options.headers['Content-Length'] = Buffer.byteLength(body);
            req.write(body);
        }
        req.end();
    });
}

// ============================================================
// PAYSTACK
// ============================================================
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function paystackInitializeTransaction({ email, amount, currency = 'GHS', reference, channels = ['mobile_money'], callback_url }) {
    const postData = JSON.stringify({ email, amount: Math.round(Number(amount) * 100), currency, reference, channels, callback_url });
    return new Promise((resolve, reject) => {
        const req = https.request(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
            agent: httpsAgent
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const p = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300 && p.status) resolve(p.data);
                    else reject(new Error(p.message || `Paystack HTTP ${res.statusCode}`));
                } catch (e) { reject(new Error('Paystack parse: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('Paystack timeout')); });
        req.write(postData); req.end();
    });
}
function paystackVerifyTransaction(reference) {
    return new Promise((resolve, reject) => {
        const req = https.request(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
            method: 'GET', headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` }, agent: httpsAgent
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const p = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300 && p.status) resolve(p.data);
                    else reject(new Error(p.message || `Verify HTTP ${res.statusCode}`));
                } catch (e) { reject(new Error('Verify parse: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Verify timeout')); });
        req.end();
    });
}
function paystackCreateRecipient({ name, accountNumber, bankCode, currency = 'GHS' }) {
    const postData = JSON.stringify({ type: 'mobile_money', name, account_number: accountNumber, bank_code: bankCode, currency });
    return new Promise((resolve, reject) => {
        const req = https.request(`${PAYSTACK_BASE_URL}/transferrecipient`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
            agent: httpsAgent
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const p = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300 && p.status) resolve(p.data);
                    else reject(new Error(p.message || `Recipient HTTP ${res.statusCode}`));
                } catch (e) { reject(new Error('Recipient parse: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('Recipient timeout')); });
        req.write(postData); req.end();
    });
}
function paystackInitiateTransfer({ amount, recipientCode, reason, reference, currency = 'GHS' }) {
    const postData = JSON.stringify({ source: 'balance', amount: Math.round(Number(amount) * 100), recipient: recipientCode, reason: reason || 'CITFUND Withdrawal', reference, currency });
    return new Promise((resolve, reject) => {
        const req = https.request(`${PAYSTACK_BASE_URL}/transfer`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
            agent: httpsAgent
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const p = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300 && p.status) resolve(p.data);
                    else reject(new Error(p.message || `Transfer HTTP ${res.statusCode}`));
                } catch (e) { reject(new Error('Transfer parse: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('Transfer timeout')); });
        req.write(postData); req.end();
    });
}
function paystackFinalizeTransfer({ transferCode, otp }) {
    const postData = JSON.stringify({ transfer_code: transferCode, otp });
    return new Promise((resolve, reject) => {
        const req = https.request(`${PAYSTACK_BASE_URL}/transfer/finalize_transfer`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
            agent: httpsAgent
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const p = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300 && p.status) resolve(p.data);
                    else reject(new Error(p.message || `Finalize HTTP ${res.statusCode}`));
                } catch (e) { reject(new Error('Finalize parse: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('Finalize timeout')); });
        req.write(postData); req.end();
    });
}
function paystackVerifyTransfer(reference) {
    return new Promise((resolve, reject) => {
        const req = https.request(`${PAYSTACK_BASE_URL}/transfer/verify/${encodeURIComponent(reference)}`, {
            method: 'GET', headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}` }, agent: httpsAgent
        }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const p = JSON.parse(d);
                    if (res.statusCode >= 200 && res.statusCode < 300 && p.status) resolve(p.data);
                    else reject(new Error(p.message || `Verify transfer HTTP ${res.statusCode}`));
                } catch (e) { reject(new Error('Verify transfer parse: ' + e.message)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Verify transfer timeout')); });
        req.end();
    });
}

// ============================================================
// BLOCK BAD UA / BODY READERS
// ============================================================
const isBlocked = (req) => /python|curl|wget|sqlmap|nikto|scrapy|headless|apivoid|masscan|nmap/i.test(req.headers['user-agent'] || '');

function getRawBody(req, maxBytes = 50 * 1024 * 1024) {
    return new Promise((resolve) => {
        let body = '', size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > maxBytes) { req.destroy(); resolve({ error: 'File too large.' }); return; }
            body += c;
        });
        req.on('end', () => resolve(body));
        req.on('error', err => resolve({ error: 'Request error: ' + err.message }));
    });
}
async function getBody(req, maxBytes = 10 * 1024 * 1024) {
    const raw = await getRawBody(req, maxBytes);
    if (typeof raw === 'object' && raw.error) return raw;
    if (!raw) return {};
    if (raw.trim().startsWith('<')) return { error: 'Server returned HTML.' };
    try { return sanitizeBody(JSON.parse(raw)); }
    catch (e) { return { error: 'Invalid JSON: ' + e.message }; }
}

// ============================================================
// USER LOOKUP / SAVE
// ============================================================
async function getAllUsers() {
    return await httpsRequest(`${FIREBASE_DB_URL}/users.json?auth=${FIREBASE_SECRET}`);
}
async function getUserByUid(uid) {
    const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
    if (!snap || !snap.encryptedData) return null;
    try { return decryptData(snap.encryptedData, uid); } catch (e) { return null; }
}
async function findUserByIdentifier(identifier) {
    if (!identifier) return null;
    const s = String(identifier).toLowerCase().trim();
    const all = await getAllUsers();
    for (const uid in all) {
        if (!all[uid] || !all[uid].encryptedData) continue;
        try {
            const d = decryptData(all[uid].encryptedData, uid);
            if (d.accountNumber && String(d.accountNumber).toLowerCase() === s) return { uid, data: d };
            if (d.memberID && String(d.memberID).toLowerCase() === s) return { uid, data: d };
            if (d.email && String(d.email).toLowerCase() === s) return { uid, data: d };
            if (d.phone && String(d.phone).replace(/\D/g, '').endsWith(s.replace(/\D/g, ''))) return { uid, data: d };
        } catch { continue; }
    }
    return null;
}
async function findUserByAccount(acc) {
    const all = await getAllUsers();
    for (const uid in all) {
        if (!all[uid] || !all[uid].encryptedData) continue;
        try {
            const d = decryptData(all[uid].encryptedData, uid);
            if (String(d.accountNumber) === String(acc)) return { uid, data: d };
        } catch { continue; }
    }
    return null;
}
async function findUserByEmail(email) {
    if (!email) return null;
    const s = String(email).toLowerCase();
    const all = await getAllUsers();
    for (const uid in all) {
        if (!all[uid] || !all[uid].encryptedData) continue;
        try {
            const d = decryptData(all[uid].encryptedData, uid);
            if (d.email && String(d.email).toLowerCase() === s) return { uid, data: d };
        } catch { continue; }
    }
    return null;
}
async function saveUser(uid, userData) {
    return await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`,
        { method: 'PUT' }, { encryptedData: encryptData(userData, uid) });
}

function sanitizeUserData(u) {
    if (!u) return u;
    const s = { ...u };
    if (s.transactions) {
        const e = Object.entries(s.transactions);
        if (e.length > 50) {
            e.sort((a, b) => new Date(b[1].date || 0) - new Date(a[1].date || 0));
            const t = {};
            e.slice(0, 50).forEach(([k, tx]) => { t[k] = tx; });
            s.transactions = t;
        }
    }
    delete s.idFront; delete s.idBack;
    delete s.otp; delete s.otpExpires;
    delete s.password; delete s.pin;
    delete s.forgotOtp; delete s.forgotOtpExpires;
    delete s.forgotSessionToken; delete s.forgotSessionExpires;
    delete s.forgotFingerprint; delete s.forgotAttempts; delete s.forgotVerified;
    delete s.webauthnPinToken; delete s.webauthnPinTokenExpires;
    if (s.webauthn && Array.isArray(s.webauthn.credentials)) {
        s.webauthn = {
            credentials: s.webauthn.credentials.map(c => ({
                id: c.id,
                name: c.name,
                createdAt: c.createdAt,
                lastUsedAt: c.lastUsedAt || null,
                transports: c.transports || []
            }))
        };
    }
    return s;
}
async function enrichUserWithKYC(u, uid) {
    try {
        const r = await kycRequest(`/kyc/${uid}`);
        if (r && r.status && r.status !== 'none') u.kyc = { status: r.status };
        else u.kyc = { status: 'none' };
    } catch { u.kyc = { status: 'none' }; }
    return u;
}

// ⭐ NEW: Session token helpers
function issueApiSessionToken(uid, ip, ua) {
    const token = crypto.randomBytes(32).toString('hex');
    apiSessionTokens.set(token, {
        uid,
        ip: ip.slice(0, 32),
        ua: String(ua || '').slice(0, 80),
        expires: Date.now() + API_SESSION_MS
    });
    return token;
}
function verifyApiSessionToken(token) {
    const rec = apiSessionTokens.get(token);
    if (!rec) return null;
    if (Date.now() > rec.expires) { apiSessionTokens.delete(token); return null; }
    return rec;
}

// ============================================================
// DEPOSIT CREDIT + RECONCILER
// ============================================================
function applyDepositCredit(u, tx, gross, source) {
    if (!tx || tx.status === 'success') return { credited: false };
    const { fee, netAfterFee, label } = calculateDepositFee(gross);
    let actual = netAfterFee, openFee = 0;
    if (u.pendingFee && u.pendingFee > 0) {
        openFee = Math.min(u.pendingFee, actual);
        u.pendingFee -= openFee;
        actual = Number((actual - openFee).toFixed(2));
    }
    u.citFundRevenue = Number(((Number(u.citFundRevenue) || 0) + fee + openFee).toFixed(2));
    u.balance = Number(((Number(u.balance) || 0) + actual).toFixed(2));
    tx.status = 'success';
    tx.completedAt = new Date().toISOString();
    tx.newBalance = u.balance;
    tx.grossAmount = gross;
    tx.transactionFee = fee;
    tx.feeTier = label || 'tiered';
    tx.openingFee = openFee;
    tx.creditedAmount = actual;
    tx.creditedVia = source || 'unknown';
    return { credited: true, fee, openingFee: openFee, actualCredit: actual, newBalance: u.balance, label };
}

async function reconcileUserPendingDeposits(uid, u, opts) {
    opts = opts || {};
    const minAgeMs = opts.minAgeMs == null ? 60000 : opts.minAgeMs;
    const maxAgeMs = opts.maxAgeMs == null ? 48 * 60 * 60 * 1000 : opts.maxAgeMs;
    const txs = u.transactions || {};
    const now = Date.now();
    const refs = [];
    for (const ref in txs) {
        const tx = txs[ref];
        if (!tx || tx.status !== 'pending' || tx.type !== 'deposit') continue;
        const created = tx.date ? new Date(tx.date).getTime() : 0;
        if (now - created < minAgeMs) continue;
        if (now - created > maxAgeMs) {
            tx.status = 'failed'; tx.failureReason = 'Verification timeout';
            tx.completedAt = new Date().toISOString(); continue;
        }
        refs.push(ref);
    }
    if (!refs.length) return { checked: 0, credited: 0 };
    let credited = 0;
    for (const ref of refs) {
        try {
            const v = await paystackVerifyTransaction(ref);
            if (v && v.status === 'success') {
                const gross = Number(v.amount) / 100;
                const tx = u.transactions[ref];
                const r = applyDepositCredit(u, tx, gross, 'reconcile');
                if (r.credited) {
                    credited++;
                    sendSMS(u.phone, SMS.depositCredited(gross, tx.transactionFee, tx.openingFee, tx.creditedAmount, u.balance, ref, tx.feeTier), 'dep-credit-' + ref).catch(() => {});
                }
            } else if (v && ['failed', 'abandoned', 'reversed'].includes(v.status)) {
                const tx2 = u.transactions[ref];
                tx2.status = 'failed';
                tx2.failureReason = v.gateway_response || ('Payment ' + v.status);
                tx2.completedAt = new Date().toISOString();
            }
        } catch {}
    }
    return { checked: refs.length, credited };
}

let _reconciling = false, _lastReconcile = 0;
async function reconcileAllPendingDeposits() {
    if (_reconciling || Date.now() - _lastReconcile < 60000) return;
    _reconciling = true; _lastReconcile = Date.now();
    try {
        const all = await getAllUsers();
        if (!all || typeof all !== 'object') return;
        for (const uid in all) {
            if (!all[uid].encryptedData) continue;
            let u;
            try { u = decryptData(all[uid].encryptedData, uid); } catch { continue; }
            const r = await reconcileUserPendingDeposits(uid, u, {});
            if (r.credited > 0) { try { await saveUser(uid, u); } catch {} }
        }
    } catch (e) { console.error('[RECONCILE]', e.message); }
    finally { _reconciling = false; }
}
setTimeout(() => {
    reconcileAllPendingDeposits().catch(() => {});
    setInterval(reconcileAllPendingDeposits, 60000);
    console.log('[RECONCILE] started');
}, 30000);

// ============================================================
// RE-ENGAGEMENT
// ============================================================
const REENGAGE_INTERVAL_MS = 5 * 24 * 60 * 60 * 1000;
const REENGAGE_CHECK_MS = 6 * 60 * 60 * 1000;
const REENGAGE_MESSAGES = [
    "we miss you! Your money is waiting to grow at 5% every 15 days.",
    "5% return every 15 days — that's 120% a year. Start today.",
    "a quick hello from CITFUND. Have you checked your balance?",
    "financial freedom starts small. Invest from GHS 10 and watch your money work.",
    "did you know? Transfers between CITFUND members are always FREE.",
    "your future self will thank you for every deposit today.",
    "our 15-day Starter Plan pays 5% — no hidden fees, start with GHS 300.",
    "we've built new features for you. Log in to see what's new."
];

let _reengageRunning = false;
async function runReengagementSweep() {
    if (_reengageRunning) return;
    _reengageRunning = true;
    const now = Date.now();
    let sent = 0, skipped = 0;
    try {
        const all = await getAllUsers();
        if (!all || typeof all !== 'object') return;
        for (const uid in all) {
            if (!all[uid].encryptedData) continue;
            let u;
            try { u = decryptData(all[uid].encryptedData, uid); } catch { continue; }
            if (!u.phone || u.smsOptOut === true) { skipped++; continue; }
            const last = Number(u.lastReengageAt) || 0;
            if (now - last < REENGAGE_INTERVAL_MS) { skipped++; continue; }
            let body;
            const hasDep = u.transactions && Object.values(u.transactions).some(t => t.type === 'deposit' && t.status === 'success');
            const hasInv = u.investments && Object.values(u.investments).some(i => i.status === 'active');
            if (!hasDep) body = "your CITFUND account is ready. Fund from GHS 1 and start earning.";
            else if (hasInv) body = pickRandomMotivation();
            else body = REENGAGE_MESSAGES[Math.floor(Math.random() * REENGAGE_MESSAGES.length)];
            try {
                const greeting = getTimeGreeting();
                await sendSMS(u.phone, SMS.reengage((u.fullName ? u.fullName.split(' ')[0] : 'Friend'), `${greeting}! ${body}`), 'reengage-' + uid);
                u.lastReengageAt = now;
                u.reengageCount = (Number(u.reengageCount) || 0) + 1;
                await saveUser(uid, u);
                sent++;
            } catch (e) { console.error('[REENGAGE]', uid, e.message); }
        }
        console.log(`[REENGAGE] sent=${sent} skipped=${skipped}`);
    } catch (e) { console.error('[REENGAGE] Fatal:', e.message); }
    finally { _reengageRunning = false; }
}
setTimeout(() => { runReengagementSweep().catch(() => {}); }, 3 * 60 * 1000);
setInterval(() => { runReengagementSweep().catch(() => {}); }, REENGAGE_CHECK_MS);

// ============================================================
// INVESTMENT PLANS
// ============================================================
const RATE_PER_15_DAYS = 5;
const DAYS_PER_RATE_CYCLE = 15;
const DAILY_RATE_PERCENT = RATE_PER_15_DAYS / DAYS_PER_RATE_CYCLE;
function calcRate(d) { return Number(((d / DAYS_PER_RATE_CYCLE) * RATE_PER_15_DAYS).toFixed(2)); }

const FIXED_PLANS = [
    { id: 'FIX_15D',   name: 'Starter Investment Plan',        duration: 15,   durationLabel: '15 Days',  interestRate: calcRate(15),   minAmount: 300, type: 'fixed' },
    { id: 'FIX_30D',   name: 'Growth Investment Plan',         duration: 30,   durationLabel: '30 Days',  interestRate: calcRate(30),   minAmount: 300, type: 'fixed' },
    { id: 'FIX_45D',   name: 'Silver Investment Plan',         duration: 45,   durationLabel: '45 Days',  interestRate: calcRate(45),   minAmount: 300, type: 'fixed' },
    { id: 'FIX_60D',   name: 'Gold Investment Plan',           duration: 60,   durationLabel: '60 Days',  interestRate: calcRate(60),   minAmount: 300, type: 'fixed' },
    { id: 'FIX_90D',   name: 'Prosperity Investment Plan',     duration: 90,   durationLabel: '3 Months', interestRate: calcRate(90),   minAmount: 300, type: 'fixed' },
    { id: 'FIX_120D',  name: 'Platinum Investment Plan',       duration: 120,  durationLabel: '4 Months', interestRate: calcRate(120),  minAmount: 300, type: 'fixed' },
    { id: 'FIX_180D',  name: 'Wealth Builder Investment Plan', duration: 180,  durationLabel: '6 Months', interestRate: calcRate(180),  minAmount: 300, type: 'fixed' },
    { id: 'FIX_365D',  name: 'Legendary Investment Plan',      duration: 365,  durationLabel: '1 Year',   interestRate: calcRate(365),  minAmount: 300, type: 'fixed' },
    { id: 'FIX_730D',  name: 'Elite Investment Plan',          duration: 730,  durationLabel: '2 Years',  interestRate: calcRate(730),  minAmount: 300, type: 'fixed' },
    { id: 'FIX_1095D', name: 'Royal Investment Plan',          duration: 1095, durationLabel: '3 Years',  interestRate: calcRate(1095), minAmount: 300, type: 'fixed' },
    { id: 'FIX_1460D', name: 'Imperial Investment Plan',       duration: 1460, durationLabel: '4 Years',  interestRate: calcRate(1460), minAmount: 300, type: 'fixed' },
    { id: 'FIX_1825D', name: 'Ultimate Investment Plan',       duration: 1825, durationLabel: '5 Years',  interestRate: calcRate(1825), minAmount: 300, type: 'fixed' }
];
const FLEX_PLANS = [
    { id: 'FLEX_15D', name: 'Flex Starter', duration: 15, durationLabel: 'Flexible (15 Days)', interestRate: calcRate(15), minAmount: 10, type: 'flex' },
    { id: 'FLEX_30D', name: 'Flex Plus',    duration: 30, durationLabel: 'Flexible (30 Days)', interestRate: calcRate(30), minAmount: 10, type: 'flex' },
    { id: 'FLEX_60D', name: 'Flex Pro',     duration: 60, durationLabel: 'Flexible (60 Days)', interestRate: calcRate(60), minAmount: 10, type: 'flex' },
    { id: 'FLEX_90D', name: 'Flex Max',     duration: 90, durationLabel: 'Flexible (90 Days)', interestRate: calcRate(90), minAmount: 10, type: 'flex' }
];
const ALL_PLANS = [...FIXED_PLANS, ...FLEX_PLANS];

const LOAN_ELIGIBILITY_DAYS = 120;
const LOAN_PRODUCTS = [
    { id: 'INSTANT',   name: 'Instant Loan',   desc: 'Quick cash for urgent needs', interestRate: 20, paymentFrequency: 'monthly',  minAmount: 100, maxAmount: 5000,  minDuration: 1, maxDuration: 3,  durationUnit: 'months', processingFeePercent: 2, penaltyPercent: 12 },
    { id: 'BUSINESS',  name: 'Business Loan',  desc: 'Grow your business',         interestRate: 14, paymentFrequency: 'weekly',   minAmount: 500, maxAmount: 50000, minDuration: 3, maxDuration: 12, durationUnit: 'months', processingFeePercent: 2, penaltyPercent: 12 },
    { id: 'PERSONAL',  name: 'Personal Loan',  desc: 'Personal projects & more',   interestRate: 16, paymentFrequency: 'monthly',  minAmount: 200, maxAmount: 10000, minDuration: 2, maxDuration: 6,  durationUnit: 'months', processingFeePercent: 2, penaltyPercent: 12 },
    { id: 'EMERGENCY', name: 'Emergency Loan', desc: 'Medical & urgent support',   interestRate: 18, paymentFrequency: 'biweekly', minAmount: 50,  maxAmount: 2000,  minDuration: 1, maxDuration: 2,  durationUnit: 'months', processingFeePercent: 2, penaltyPercent: 12 }
];
function loanInstallmentCount(p, m) {
    if (!p) return 0;
    if (p.paymentFrequency === 'weekly') return Math.round(m * 4);
    if (p.paymentFrequency === 'biweekly') return Math.round(m * 2);
    return m;
}

// ============================================================
// CHAT HELPERS
// ============================================================
function chatConvId(a, b) { return [String(a), String(b)].sort().join('__'); }
function chatIsParticipant(c, uid) { return !!(c && c.participants && c.participants[uid] === true); }
function chatNewMsgId() { return 'm_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'); }
function chatNowIso() { return new Date().toISOString(); }
function chatSanitizeText(s) { return String(s == null ? '' : s).slice(0, CHAT_MAX_TEXT_LEN); }
function chatSanitizeImage(s) {
    if (!s || typeof s !== 'string') return null;
    if (!s.startsWith('data:image/')) return null;
    if (s.length > CHAT_MAX_IMAGE_BYTES) return null;
    return s;
}
async function chatGetConv(id) { return await httpsRequest(`${FIREBASE_DB_URL}/chats/${id}.json?auth=${FIREBASE_SECRET}`); }
async function chatPutConv(id, d) { return await httpsRequest(`${FIREBASE_DB_URL}/chats/${id}.json?auth=${FIREBASE_SECRET}`, { method: 'PUT' }, d); }
async function chatEnsureSupportConv(uid) {
    const id = chatConvId(uid, CHAT_SUPPORT_UID);
    let c = await chatGetConv(id);
    if (c) return id;
    const now = chatNowIso();
    c = {
        participants: { [uid]: true, [CHAT_SUPPORT_UID]: true },
        type: 'support', createdAt: Date.now(),
        lastMessage: { text: 'Welcome to CITFUND Support', senderUid: CHAT_SUPPORT_UID, time: now },
        messages: { ['welcome_' + uid]: { id: 'welcome_' + uid, senderUid: CHAT_SUPPORT_UID, text: `Hello 👋 Welcome to CITFUND Support.\n\nAsk about:\n• Deposits & withdrawals\n• Investment plans\n• Account & security\n• Loans\n\nType "hello" to start.`, time: now, readBy: {}, reactions: {} } }
    };
    await chatPutConv(id, c);
    return id;
}
async function chatGetPeerInfo(peerUid) {
    if (peerUid === CHAT_SUPPORT_UID) return { name: CHAT_SUPPORT_NAME, account: null, verified: true };
    try {
        const u = await getUserByUid(peerUid);
        if (u) return { name: u.fullName || 'CITFUND Member', account: u.accountNumber || null, verified: false };
    } catch {}
    return { name: 'CITFUND Member', account: null, verified: false };
}
function chatGenerateSupportReply(text) {
    const t = String(text || '').toLowerCase();
    if (/hello|hi\b|hey|good\s*(morning|afternoon|evening)|wassup|yo\b/.test(t)) return 'Hello! 👋 Welcome to CITFUND. How can we help?';
    if (/deposit|add\s*money|fund\s*my|top\s*up/.test(t)) return 'To deposit:\n1. Tap ⊕\n2. Choose network\n3. Enter amount & phone\n4. Approve prompt\n\nTiered fees apply.';
    if (/withdraw|cash\s*out/.test(t)) return 'To withdraw:\n1. Tap Withdraw\n2. Enter amount & MoMo\n3. Confirm PIN\n\nTiered fees apply.';
    if (/invest|plan|interest|earn/.test(t)) return 'Investment:\n• 5% every 15 days\n• 15 days to 5 years\n• Min GHS 300 (fixed) / GHS 10 (flex)';
    if (/loan|borrow/.test(t)) return 'Loans unlock after 120 days.\n• Instant, Business, Personal, Emergency\n• 14%–20%';
    if (/pin|password|security|fraud/.test(t)) return `🔒 Never share your PIN.\nSuspected fraud? Call ${SUPPORT_PHONE}.`;
    if (/transfer/.test(t)) return 'CITFUND transfers are FREE and instant.';
    if (/fee|charge/.test(t)) return 'Fees are tiered:\n• GHS 1-50: GHS 1 flat\n• GHS 100-199: 1.5%\n• GHS 200-300: 2.7%\n• Higher: as low as 1%';
    if (/thank/.test(t)) return "You're welcome! 😊";
    if (/bye/.test(t)) return "Goodbye! 👋 We're here 24/7.";
    if (/account|number|member/.test(t)) return 'Your account number is on your dashboard.';
    if (/balance/.test(t)) return 'Balance is on your dashboard.';
    return `Thanks! A support agent will review shortly. Urgent? Call ${SUPPORT_PHONE}.`;
}

// ============================================================
// SPLASH
// ============================================================
function getSplashSnippet() {
    return `<script>(function(){var o=document.createElement('div');o.id='citSplash';o.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(160deg,#075C22 0%,#0B7A2E 100%);z-index:999999;display:flex;flex-direction:column;justify-content:center;align-items:center;color:white;font-family:Poppins,Arial,sans-serif;transition:opacity .5s;';o.innerHTML='<div style="text-align:center;padding:20px;"><img src="cit_logo.png" alt="CITFUND" style="width:220px;max-width:80vw;height:auto;margin-bottom:20px;" onerror="this.style.display=\\'none\\';document.getElementById(\\'citSplashText\\').style.display=\\'block\\';" /><div id="citSplashText" style="display:none;font-size:44px;font-weight:800;letter-spacing:2px;color:#fff;margin-bottom:10px;">CITFUND<span style="color:#FFC72C;"> ENTERPRISE</span></div><div style="font-size:13px;letter-spacing:3px;color:rgba(255,255,255,0.7);text-transform:uppercase;margin-bottom:40px;">Your Trusted Financial Partner</div><div style="width:70px;height:70px;border:5px solid rgba(255,199,44,0.15);border-top-color:#FFC72C;border-radius:50%;animation:citSpin 1s linear infinite;margin:0 auto 25px;"></div><div id="citSplashStatus" style="font-size:14px;color:rgba(255,255,255,0.9);font-weight:500;">Connecting...</div></div>';document.body.appendChild(o);var s=document.createElement('style');s.innerHTML='@keyframes citSpin{to{transform:rotate(360deg)}}';document.head.appendChild(s);setTimeout(function(){var el=document.getElementById('citSplash');if(el){el.style.opacity='0';setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el);},550);}},2000);})();</script>`;
}

// ============================================================
// MAIN SERVER
// ============================================================
const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Secret, X-Agent-Id',
            'Access-Control-Max-Age': '86400'
        });
        return res.end();
    }

    Promise.resolve().then(async () => {
        try {
            setSecurityHeaders(res);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Secret, X-Agent-Id');

            const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
            const cleanPath = req.url.split('?')[0].replace(/\/$/, '');

            if (cleanPath === '/api/server-status') {
                return jsonRes(res, { success: true, status: "online", version: SERVER_VERSION, tiers: FEE_TIERS.length, matrix: TX_MATRIX.length, uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000) });
            }
            if (isBlocked(req)) { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end("ACCESS DENIED"); }
            if (isScannerFlood(ip) && !cleanPath.startsWith('/api/')) { res.writeHead(403, { 'Content-Type': 'text/html' }); return res.end("ACCESS DENIED"); }

            if (cleanPath.startsWith('/api/')) {
                try {

                    // =====================================================
                    // ⭐ HEALTH & METRICS
                    // =====================================================
                    if (cleanPath === '/api/health' && req.method === 'GET') {
                        const mem = process.memoryUsage();
                        return jsonRes(res, {
                            success: true,
                            status: 'healthy',
                            version: SERVER_VERSION,
                            uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
                            memory: {
                                rss: Math.floor(mem.rss / 1024 / 1024) + ' MB',
                                heapUsed: Math.floor(mem.heapUsed / 1024 / 1024) + ' MB'
                            },
                            features: featureFlags
                        });
                    }
                    if (cleanPath === '/api/metrics' && req.method === 'GET') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, 'Unauthorized', 401);
                        const mem = process.memoryUsage();
                        return jsonRes(res, {
                            success: true,
                            version: SERVER_VERSION,
                            uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
                            memory: {
                                rss: Math.floor(mem.rss / 1024 / 1024) + ' MB',
                                heapUsed: Math.floor(mem.heapUsed / 1024 / 1024) + ' MB',
                                heapTotal: Math.floor(mem.heapTotal / 1024 / 1024) + ' MB'
                            },
                            counts: {
                                activeSessions: apiSessionTokens.size,
                                challenges: webAuthnChallenges.size,
                                pinTokens: pinSessionTokens.size,
                                auditEntries: auditLog.length,
                                supportTickets: supportTickets.size,
                                announcements: announcements.length
                            },
                            rateBuckets: rateBuckets.size
                        });
                    }

                    // =====================================================
                    // ⭐ FEATURE FLAGS (public read)
                    // =====================================================
                    if (cleanPath === '/api/features' && req.method === 'GET') {
                        return jsonRes(res, { success: true, features: featureFlags });
                    }

                    // =====================================================
                    // ⭐ ANNOUNCEMENTS (public read)
                    // =====================================================
                    if (cleanPath === '/api/announcements' && req.method === 'GET') {
                        const now = Date.now();
                        const active = announcements
                            .filter(a => a.active && (!a.expiresAt || now < a.expiresAt))
                            .map(a => ({ id: a.id, title: a.title, body: a.body, level: a.level, createdAt: a.createdAt }));
                        return jsonRes(res, { success: true, announcements: active });
                    }

                    // =====================================================
                    // ========== FEE TOOLS ================================
                    // =====================================================
                    if (cleanPath === '/api/fee-calculator' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const amt = Number(body.amount);
                        if (isNaN(amt) || amt <= 0) return sendError(res, "Invalid amount", 400);
                        const dep = calculateDepositFee(amt);
                        const wd = calculateWithdrawFee(amt);
                        return jsonRes(res, {
                            success: true, amount: amt,
                            deposit: { fee: dep.fee, credited: dep.netAfterFee, label: dep.label },
                            withdrawal: { fee: wd.fee, totalDebit: wd.totalDebit, label: wd.label },
                            tier: dep.tier
                        });
                    }
                    if (cleanPath === '/api/fee-tiers' && req.method === 'GET') {
                        return jsonRes(res, { success: true, tiers: FEE_TIERS.map(t => ({ min: t.min, max: t.max === Infinity ? '∞' : t.max, type: t.type, value: t.value, label: t.label })) });
                    }
                    if (cleanPath === '/api/system/matrix' && req.method === 'GET') {
                        return jsonRes(res, { success: true, count: TX_MATRIX.length, sample: TX_MATRIX.slice(0, 20) });
                    }

                    // =====================================================
                    // ========== AUTH =====================================
                    // =====================================================
                    if (cleanPath === '/api/self-register' && req.method === 'POST') {
                        if (!rateLimit(ip, 'register', 5, 3600000)) return sendError(res, "Too many signups. Try in an hour.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.fullName || !body.email || !body.phone || !body.pin || !body.password) return sendError(res, "Missing critical fields", 400);
                        const pwErr = validatePasswordStrength(body.password); if (pwErr) return sendError(res, pwErr, 400);
                        const pinErr = validatePinStrength(body.pin); if (pinErr) return sendError(res, pinErr, 400);
                        if (!/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(body.email)) return sendError(res, "Invalid email", 400);

                        const uid = crypto.randomBytes(16).toString('hex');
                        const accNum = "215" + crypto.randomBytes(5).toString('hex').replace(/[a-f]/g, '0').padEnd(10, '0').slice(0, 10);
                        const memberID = "CIT" + crypto.randomBytes(4).toString('hex').replace(/[a-f]/g, '0').slice(0, 7);
                        const regRef = 'REG-' + Date.now().toString().slice(-8);
                        const referralCode = 'CIT-' + crypto.randomBytes(4).toString('hex').toUpperCase();

                        // ⭐ Handle referral (if provided)
                        let referrerUid = null;
                        if (body.referralCode) {
                            try {
                                const allUsers = await getAllUsers();
                                for (const rid in allUsers) {
                                    if (!allUsers[rid].encryptedData) continue;
                                    try {
                                        const rd = decryptData(allUsers[rid].encryptedData, rid);
                                        if (rd.referralCode && rd.referralCode.toUpperCase() === String(body.referralCode).toUpperCase()) {
                                            referrerUid = rid;
                                            break;
                                        }
                                    } catch {}
                                }
                            } catch {}
                        }

                        const userData = {
                            fullName: body.fullName, email: String(body.email).toLowerCase(), phone: body.phone,
                            pin: body.pin, password: body.password, accountNumber: accNum, memberID,
                            balance: 0, pendingFee: ACCOUNT_OPENING_FEE, transactions: {}, citFundRevenue: 0,
                            dob: body.dob || "", gender: body.gender || "", marital: body.marital || "",
                            nationality: body.nationality || "", placeOfBirth: body.placeOfBirth || "",
                            address: body.address || "", city: body.city || "", region: body.region || "",
                            postal: body.postal || "", idType: body.idType || "", idNumber: body.idNumber || "",
                            accType: body.accType || "Savings", branch: body.branch || "Main Branch - Accra",
                            currency: body.currency || "GHS",
                            nokName: body.nokName || "", nokRel: body.nokRel || "", nokPhone: body.nokPhone || "",
                            nokEmail: body.nokEmail || "", nokAddress: body.nokAddress || "", nokCity: body.nokCity || "",
                            occupation: body.occupation || "", employer: body.employer || "", income: body.income || "",
                            sourceFunds: body.sourceFunds || "", purpose: body.purpose || "",
                            loans: {}, cards: {}, investments: {}, business: {}, items: [],
                            withdrawalRequests: {}, kyc: { status: 'none' }, loginHistory: [], notifications: [],
                            bankAccount: "", bankCode: "", bankName: "", momoPhone: "", momoNetwork: "",
                            paystackRecipients: {},
                            webauthn: { credentials: [] },
                            beneficiaries: [],
                            standingOrders: [],
                            supportTickets: [],
                            referralCode,
                            referredBy: referrerUid || null,
                            referralCount: 0,
                            referralEarnings: 0,
                            twoFactorEnabled: true,
                            virtualAccount: { status: 'unavailable', accountNumber: '', accountName: '', bankName: '', currency: 'GHS', error: DVA_COMING_SOON_MSG, message: DVA_COMING_SOON_MSG },
                            smsOptOut: false, lastReengageAt: Date.now(), createdAt: Date.now(),
                            limits: { dailyDeposit: 100000, dailyWithdraw: 50000, perTransactionDeposit: 100000, perTransactionWithdraw: 50000 }
                        };

                        try {
                            await saveUser(uid, userData);
                            await sendSMS(userData.phone, SMS.welcomeWithCredentials(userData, accNum, memberID, regRef, APP_URL), 'welcome-' + uid);

                            // ⭐ Credit referrer with bonus
                            if (referrerUid) {
                                try {
                                    const ref = await getUserByUid(referrerUid);
                                    if (ref) {
                                        const bonus = 5; // GHS 5 referral bonus
                                        ref.balance = Number(((Number(ref.balance) || 0) + bonus).toFixed(2));
                                        ref.referralCount = (Number(ref.referralCount) || 0) + 1;
                                        ref.referralEarnings = Number(((Number(ref.referralEarnings) || 0) + bonus).toFixed(2));
                                        ref.transactions = ref.transactions || {};
                                        const bonusTx = 'REF-' + Date.now() + '-' + uid.slice(0, 6);
                                        ref.transactions[bonusTx] = {
                                            id: bonusTx, type: 'referral_bonus', amount: bonus,
                                            narration: `Referral bonus - ${userData.fullName}`,
                                            status: 'success', date: new Date().toISOString(),
                                            read: false, newBalance: ref.balance, transactionFee: 0
                                        };
                                        await saveUser(referrerUid, ref);
                                        sendSMS(ref.phone, SMS.referralBonus(ref, bonus, userData.fullName), 'ref-bonus-' + bonusTx).catch(() => {});
                                    }
                                } catch (e) { console.error('[REFERRAL]', e.message); }
                            }

                            audit('REGISTER', ip, uid, { accNum, memberID, referral: !!referrerUid });
                            return jsonRes(res, {
                                success: true, uid, referralCode,
                                user: { fullName: userData.fullName, accountNumber: accNum, memberID, pendingFee: ACCOUNT_OPENING_FEE }
                            });
                        } catch (e) { return sendError(res, "DB Error: " + e.message, 500); }
                    }

                    if (cleanPath === '/api/login' && req.method === 'POST') {
                        if (!rateLimit(ip, 'login', 10, 900000)) return sendError(res, "Too many attempts.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { identifier, password } = body;
                        if (!identifier || !password) return sendError(res, "Missing credentials", 400);
                        const lk = ip + '|' + String(identifier).toLowerCase();
                        if (isAuthLocked(lk)) return sendError(res, "Account locked. Try in 15 min.", 429);
                        try {
                            const match = await findUserByIdentifier(identifier);
                            if (!match) { recordAuthFail(lk); return sendError(res, "Invalid credentials", 401); }
                            if (!safeEqual(match.data.password, password)) { recordAuthFail(lk); return sendError(res, "Invalid credentials", 401); }
                            clearAuthFails(lk);
                            const u = match.data;
                            u.loginHistory = u.loginHistory || [];
                            u.loginHistory.push({ date: Date.now(), ip: ip.slice(0, 32), ua: String(req.headers['user-agent'] || '').slice(0, 60) });
                            if (u.loginHistory.length > 20) u.loginHistory = u.loginHistory.slice(-20);
                            await saveUser(match.uid, u);
                            audit('LOGIN', ip, match.uid, {});
                            return jsonRes(res, { success: true, message: "Password verified." });
                        } catch (e) { return sendError(res, "DB Error: " + e.message, 500); }
                    }

                    if (cleanPath === '/api/send-otp' && req.method === 'POST') {
                        if (!rateLimit(ip, 'otp', 5, 900000)) return sendError(res, "Too many OTP requests.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.identifier) return sendError(res, "Missing identifier", 400);
                        const match = await findUserByIdentifier(body.identifier);
                        if (!match) return sendError(res, "User not found", 404);
                        const otp = Math.floor(100000 + Math.random() * 900000).toString();
                        match.data.otp = otp;
                        match.data.otpExpires = Date.now() + 300000;
                        await saveUser(match.uid, match.data);
                        await sendSMS(match.data.phone, SMS.otp(otp, match.data.accountNumber), 'otp-' + match.uid, 60 * 1000);
                        return jsonRes(res, { success: true, message: "OTP sent" });
                    }

                    if (cleanPath === '/api/verify-otp' && req.method === 'POST') {
                        if (!rateLimit(ip, 'votp', 10, 900000)) return sendError(res, "Too many attempts.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { identifier, otp } = body;
                        if (!identifier || !otp) return sendError(res, "Missing fields", 400);
                        const match = await findUserByIdentifier(identifier);
                        if (!match) return sendError(res, "User not found", 404);
                        if (!safeEqual(match.data.otp, otp) || Date.now() > (match.data.otpExpires || 0)) return sendError(res, "Invalid or expired OTP", 401);
                        delete match.data.otp; delete match.data.otpExpires;
                        await saveUser(match.uid, match.data);
                        return jsonRes(res, { success: true, message: "OTP verified" });
                    }

                    if (cleanPath === '/api/verify-pin' && req.method === 'POST') {
                        if (!rateLimit(ip, 'vpin', 15, 900000)) return sendError(res, "Too many attempts.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { identifier, pin } = body;
                        if (!identifier || !pin) return sendError(res, "Missing fields", 400);
                        const lk = ip + '|pin|' + String(identifier).toLowerCase();
                        if (isAuthLocked(lk)) return sendError(res, "Locked for 15 min.", 429);
                        const match = await findUserByIdentifier(identifier);
                        if (!match) return sendError(res, "User not found", 404);
                        if (!safeEqual(match.data.pin, pin)) { recordAuthFail(lk); return sendError(res, "Incorrect PIN", 401); }
                        clearAuthFails(lk);
                        const s = sanitizeUserData(match.data);
                        const sessToken = issueApiSessionToken(match.uid, ip, req.headers['user-agent']);
                        return jsonRes(res, {
                            success: true, uid: match.uid,
                            sessionToken: sessToken,
                            user: {
                                fullName: s.fullName, accountNumber: s.accountNumber, memberID: s.memberID,
                                email: s.email, phone: s.phone, balance: s.balance || 0,
                                transactions: s.transactions || {}, accType: s.accType || "Savings",
                                business: s.business || {}, items: s.items || [],
                                virtualAccount: s.virtualAccount || null
                            }
                        });
                    }

                    // ⭐ NEW: Verify session token
                    if (cleanPath === '/api/session/verify' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const rec = verifyApiSessionToken(body.sessionToken);
                        if (!rec) return sendError(res, 'Invalid or expired session', 401);
                        return jsonRes(res, { success: true, uid: rec.uid, expiresIn: Math.floor((rec.expires - Date.now()) / 1000) });
                    }
                    if (cleanPath === '/api/session/logout' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (body.sessionToken) apiSessionTokens.delete(body.sessionToken);
                        return jsonRes(res, { success: true });
                    }

                    // =====================================================
                    // ⭐ CHANGE PASSWORD / PIN (with old verification)
                    // =====================================================
                    if (cleanPath === '/api/change-password' && req.method === 'POST') {
                        if (!rateLimit(ip, 'chpw', 5, 3600000)) return sendError(res, 'Too many requests.', 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, oldPassword, newPassword } = body;
                        if (!uid || !oldPassword || !newPassword) return sendError(res, 'Missing fields', 400);
                        const pwErr = validatePasswordStrength(newPassword);
                        if (pwErr) return sendError(res, pwErr, 400);
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            if (!safeEqual(u.password, oldPassword)) return sendError(res, 'Current password is incorrect', 401);
                            if (safeEqual(u.password, newPassword)) return sendError(res, 'New password must be different', 400);
                            u.password = newPassword;
                            u.passwordChangedAt = Date.now();
                            await saveUser(uid, u);
                            sendSMS(u.phone, SMS.passwordChanged(u), 'pwchg-' + uid).catch(() => {});
                            audit('PASSWORD_CHANGE', ip, uid, {});
                            return jsonRes(res, { success: true, message: 'Password changed successfully' });
                        } catch (e) { return sendError(res, 'Could not change password', 500); }
                    }

                    if (cleanPath === '/api/change-pin' && req.method === 'POST') {
                        if (!rateLimit(ip, 'chpin', 5, 3600000)) return sendError(res, 'Too many requests.', 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, oldPin, newPin } = body;
                        if (!uid || !oldPin || !newPin) return sendError(res, 'Missing fields', 400);
                        const pinErr = validatePinStrength(newPin);
                        if (pinErr) return sendError(res, pinErr, 400);
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            if (!safeEqual(u.pin, oldPin)) return sendError(res, 'Current PIN is incorrect', 401);
                            if (safeEqual(u.pin, newPin)) return sendError(res, 'New PIN must be different', 400);
                            u.pin = newPin;
                            u.pinChangedAt = Date.now();
                            await saveUser(uid, u);
                            sendSMS(u.phone, SMS.pinChanged(u), 'pinchg-' + uid).catch(() => {});
                            audit('PIN_CHANGE', ip, uid, {});
                            return jsonRes(res, { success: true, message: 'PIN changed successfully' });
                        } catch (e) { return sendError(res, 'Could not change PIN', 500); }
                    }

                    // =====================================================
                    // ========== FORGOT CREDENTIALS =======================
                    // =====================================================
                    if (cleanPath === '/api/forgot/identify' && req.method === 'POST') {
                        if (!rateLimit(ip, 'forgot-id', 5, 1800000)) return sendError(res, 'Too many requests.', 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { identifier, fingerprint, resend } = body;
                        if (!identifier) return sendError(res, 'Missing identifier', 400);
                        try {
                            const match = await findUserByIdentifier(identifier);
                            if (!match) {
                                return jsonRes(res, {
                                    success: true,
                                    sessionToken: 'dummy_' + crypto.randomBytes(24).toString('hex'),
                                    maskedPhone: maskPhone(identifier),
                                    expiresIn: Math.floor(FORGOT_OTP_EXPIRY_MS / 1000)
                                });
                            }
                            const u = match.data;
                            if (u.smsOptOut) {
                                return jsonRes(res, {
                                    success: true,
                                    sessionToken: 'dummy_' + crypto.randomBytes(24).toString('hex'),
                                    maskedPhone: maskPhone(u.phone || identifier),
                                    expiresIn: Math.floor(FORGOT_OTP_EXPIRY_MS / 1000)
                                });
                            }
                            const otp = Math.floor(100000 + Math.random() * 900000).toString();
                            const sessionToken = crypto.randomBytes(24).toString('hex');
                            if (resend && u.forgotSessionToken && Date.now() < (u.forgotSessionExpires || 0)) {
                                u.forgotOtp = otp;
                                u.forgotOtpExpires = Date.now() + FORGOT_OTP_EXPIRY_MS;
                                u.forgotAttempts = 0;
                                await saveUser(match.uid, u);
                                await sendSMS(u.phone, SMS.forgotOtp(otp), 'forgot-otp-' + sessionToken, 60 * 1000);
                                return jsonRes(res, {
                                    success: true,
                                    sessionToken: u.forgotSessionToken,
                                    maskedPhone: maskPhone(u.phone),
                                    expiresIn: Math.floor(FORGOT_OTP_EXPIRY_MS / 1000)
                                });
                            }
                            u.forgotOtp = otp;
                            u.forgotOtpExpires = Date.now() + FORGOT_OTP_EXPIRY_MS;
                            u.forgotSessionToken = sessionToken;
                            u.forgotSessionExpires = Date.now() + FORGOT_SESSION_EXPIRY_MS;
                            u.forgotAttempts = 0;
                            u.forgotVerified = false;
                            u.forgotFingerprint = String(fingerprint || '').slice(0, 64);
                            await saveUser(match.uid, u);
                            await sendSMS(u.phone, SMS.forgotOtp(otp), 'forgot-otp-' + sessionToken, 60 * 1000);
                            audit('FORGOT_IDENTIFY', ip, match.uid, {});
                            return jsonRes(res, {
                                success: true, sessionToken,
                                maskedPhone: maskPhone(u.phone),
                                expiresIn: Math.floor(FORGOT_OTP_EXPIRY_MS / 1000)
                            });
                        } catch (e) { return sendError(res, 'Could not process request', 500); }
                    }

                    if (cleanPath === '/api/forgot/verify-otp' && req.method === 'POST') {
                        if (!rateLimit(ip, 'forgot-votp', 15, 900000)) return sendError(res, 'Too many attempts.', 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { sessionToken, otp } = body;
                        if (!sessionToken || !otp) return sendError(res, 'Missing fields', 400);
                        try {
                            const all = await getAllUsers();
                            let foundUid = null, foundUser = null;
                            for (const uid in all) {
                                if (!all[uid] || !all[uid].encryptedData) continue;
                                try {
                                    const d = decryptData(all[uid].encryptedData, uid);
                                    if (d.forgotSessionToken === sessionToken) { foundUid = uid; foundUser = d; break; }
                                } catch { continue; }
                            }
                            if (!foundUid) return sendError(res, 'Invalid or expired session', 401);
                            if (Date.now() > (foundUser.forgotSessionExpires || 0)) return sendError(res, 'Session expired', 401);
                            if (Date.now() > (foundUser.forgotOtpExpires || 0)) return sendError(res, 'Code expired', 401);
                            if ((foundUser.forgotAttempts || 0) >= FORGOT_MAX_ATTEMPTS) return sendError(res, 'Too many attempts', 429);
                            if (!safeEqual(foundUser.forgotOtp, otp)) {
                                foundUser.forgotAttempts = (foundUser.forgotAttempts || 0) + 1;
                                await saveUser(foundUid, foundUser);
                                return sendError(res, 'Incorrect code', 401);
                            }
                            foundUser.forgotVerified = true;
                            foundUser.forgotAttempts = 0;
                            await saveUser(foundUid, foundUser);
                            audit('FORGOT_VERIFY', ip, foundUid, {});
                            return jsonRes(res, { success: true, verified: true });
                        } catch (e) { return sendError(res, 'Verification failed', 500); }
                    }

                    if (cleanPath === '/api/forgot/send-credentials' && req.method === 'POST') {
                        if (!rateLimit(ip, 'forgot-send', 3, 3600000)) return sendError(res, 'Too many requests.', 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { sessionToken } = body;
                        if (!sessionToken) return sendError(res, 'Missing session', 400);
                        try {
                            const all = await getAllUsers();
                            let foundUid = null, foundUser = null;
                            for (const uid in all) {
                                if (!all[uid] || !all[uid].encryptedData) continue;
                                try {
                                    const d = decryptData(all[uid].encryptedData, uid);
                                    if (d.forgotSessionToken === sessionToken) { foundUid = uid; foundUser = d; break; }
                                } catch { continue; }
                            }
                            if (!foundUid) return sendError(res, 'Invalid session', 401);
                            if (!foundUser.forgotVerified) return sendError(res, 'Not verified', 401);
                            if (Date.now() > (foundUser.forgotSessionExpires || 0)) return sendError(res, 'Session expired', 401);
                            const lastSend = Number(foundUser.forgotLastSendAt) || 0;
                            if (Date.now() - lastSend < FORGOT_SEND_COOLDOWN_MS) return sendError(res, 'Please wait before requesting again.', 429);
                            await sendSMS(foundUser.phone, SMS.forgotCredentials(foundUser, APP_URL), 'forgot-creds-' + sessionToken, 60 * 1000);
                            foundUser.forgotSessionToken = null;
                            foundUser.forgotOtp = null;
                            foundUser.forgotVerified = false;
                            foundUser.forgotLastSendAt = Date.now();
                            await saveUser(foundUid, foundUser);
                            audit('FORGOT_SEND', ip, foundUid, {});
                            return jsonRes(res, { success: true, message: 'Credentials sent to your registered phone' });
                        } catch (e) { return sendError(res, 'Could not send credentials', 500); }
                    }

                    // =====================================================
                    // ========== WEBAUTHN / FINGERPRINT ===================
                    // =====================================================

                    if (cleanPath === '/api/webauthn/verify-pin' && req.method === 'POST') {
                        if (!rateLimit(ip, 'webauthn-vpin', 20, 900000)) return sendError(res, 'Too many attempts.', 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, pin } = body;
                        if (!uid || !pin) return sendError(res, 'Missing fields', 400);
                        const lk = ip + '|webauthnpin|' + String(uid).slice(0, 16);
                        if (isAuthLocked(lk)) return sendError(res, 'Locked. Try again later.', 429);
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            if (!safeEqual(u.pin, pin)) { recordAuthFail(lk); return sendError(res, 'Incorrect PIN', 401); }
                            clearAuthFails(lk);
                            const sessionToken = crypto.randomBytes(24).toString('hex');
                            pinSessionTokens.set(sessionToken, { uid, expires: Date.now() + WEBAUTHN_PIN_TOKEN_MS });
                            audit('WEBAUTHN_PIN', ip, uid, {});
                            return jsonRes(res, { success: true, sessionToken, expiresIn: Math.floor(WEBAUTHN_PIN_TOKEN_MS / 1000) });
                        } catch (e) { return sendError(res, 'Verification failed', 500); }
                    }

                    // =====================================================
                    // ⭐ WEBAUTHN LOGIN — start
                    // =====================================================
                    if (cleanPath === '/api/webauthn/login-start' && req.method === 'POST') {
                        if (!featureFlags.webauthn_login) return sendError(res, 'Fingerprint login is disabled', 403);
                        if (!rateLimit(ip, 'webauthn-login-start', 20, 60000)) return sendError(res, 'Too many requests.', 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { identifier } = body;
                        if (!identifier) return sendError(res, 'Missing identifier', 400);
                        try {
                            const match = await findUserByIdentifier(identifier);
                            if (!match) {
                                // Anti-enumeration
                                return jsonRes(res, {
                                    success: true,
                                    challenge: bufferToB64url(crypto.randomBytes(32)),
                                    challengeId: crypto.randomBytes(16).toString('hex'),
                                    rpId: (req.headers.host || '').split(':')[0] || undefined,
                                    allowCredentials: []
                                });
                            }
                            const u = match.data;
                            const creds = (u.webauthn && Array.isArray(u.webauthn.credentials)) ? u.webauthn.credentials : [];
                            if (!creds.length) {
                                return jsonRes(res, {
                                    success: true,
                                    challenge: bufferToB64url(crypto.randomBytes(32)),
                                    challengeId: crypto.randomBytes(16).toString('hex'),
                                    rpId: (req.headers.host || '').split(':')[0] || undefined,
                                    allowCredentials: []
                                });
                            }
                            const challengeB64 = bufferToB64url(crypto.randomBytes(32));
                            const challengeId = crypto.randomBytes(16).toString('hex');
                            webAuthnChallenges.set(challengeId, {
                                challenge: challengeB64,
                                uid: match.uid,
                                type: 'login',
                                expires: Date.now() + WEBAUTHN_CHALLENGE_MS
                            });
                            const allowCredentials = creds.map(c => ({
                                id: c.id,
                                type: 'public-key',
                                transports: c.transports || ['internal', 'hybrid']
                            }));
                            return jsonRes(res, {
                                success: true,
                                challenge: challengeB64,
                                challengeId,
                                rpId: (req.headers.host || '').split(':')[0] || undefined,
                                allowCredentials
                            });
                        } catch (e) { return sendError(res, 'Could not start fingerprint login', 500); }
                    }

                    // ⭐ WEBAUTHN LOGIN — finish (verify signature)
                    if (cleanPath === '/api/webauthn/login-finish' && req.method === 'POST') {
                        if (!featureFlags.webauthn_login) return sendError(res, 'Fingerprint login is disabled', 403);
                        if (!rateLimit(ip, 'webauthn-login-finish', 20, 60000)) return sendError(res, 'Too many requests.', 429);
                        const body = await getBody(req, 2 * 1024 * 1024);
                        if (body.error) return sendError(res, body.error, 400);
                        const { identifier, challengeId, id, response } = body;
                        if (!identifier || !challengeId || !id || !response) return sendError(res, 'Missing fields', 400);
                        try {
                            const match = await findUserByIdentifier(identifier);
                            if (!match) return sendError(res, 'Fingerprint login failed', 401);
                            const u = match.data;
                            const creds = (u.webauthn && Array.isArray(u.webauthn.credentials)) ? u.webauthn.credentials : [];
                            const cred = creds.find(c => c.id === id);
                            if (!cred) return sendError(res, 'Fingerprint login failed', 401);

                            const chal = webAuthnChallenges.get(challengeId);
                            if (!chal || chal.uid !== match.uid || chal.type !== 'login' || Date.now() > chal.expires) {
                                return sendError(res, 'Challenge expired or invalid', 400);
                            }
                            webAuthnChallenges.delete(challengeId);

                            let clientData;
                            try {
                                const raw = b64urlToBuffer(response.clientDataJSON);
                                clientData = JSON.parse(raw.toString('utf8'));
                            } catch (e) { return sendError(res, 'Invalid clientDataJSON', 400); }
                            if (clientData.type !== 'webauthn.get') return sendError(res, 'Bad clientData type', 400);
                            if (clientData.challenge !== chal.challenge) return sendError(res, 'Challenge mismatch', 400);

                            const reqHost = (req.headers.host || '').toLowerCase();
                            const expectedOrigins = [];
                            if (reqHost) { expectedOrigins.push('https://' + reqHost); expectedOrigins.push('http://' + reqHost); }
                            if (APP_URL) expectedOrigins.push(APP_URL);
                            const origin = String(clientData.origin || '');
                            let originOK = false;
                            for (const exp of expectedOrigins) {
                                try {
                                    const o1 = new URL(origin);
                                    const o2 = new URL(exp);
                                    if (o1.hostname === o2.hostname) { originOK = true; break; }
                                } catch (e) {}
                            }
                            if (!originOK) return sendError(res, 'Origin mismatch', 400);

                            const authDataBuf = b64urlToBuffer(response.authenticatorData);
                            const parsedAuth = parseAuthData(authDataBuf);

                            const expectedRpId = (req.headers.host || '').split(':')[0] || '';
                            const rpIdHash = crypto.createHash('sha256').update(expectedRpId).digest();
                            if (!rpIdHash.equals(parsedAuth.rpIdHash)) return sendError(res, 'RP ID hash mismatch', 400);
                            if (!parsedAuth.uv) return sendError(res, 'User verification required', 400);

                            const clientDataHash = crypto.createHash('sha256').update(b64urlToBuffer(response.clientDataJSON)).digest();
                            const signedData = Buffer.concat([authDataBuf, clientDataHash]);
                            const signature = b64urlToBuffer(response.signature);

                            const coseKeyBuf = b64urlToBuffer(cred.publicKey);
                            const coseKey = decodeCBOR(coseKeyBuf);

                            const kty = coseKey[1];
                            const alg = coseKey[3];
                            const crv = coseKey[-1];
                            const xCoord = coseKey[-2];
                            const yCoord = coseKey[-3];

                            if (kty !== 2 || alg !== -7 || crv !== 1) {
                                return sendError(res, 'Unsupported key type', 400);
                            }

                            const jwk = {
                                kty: 'EC',
                                crv: 'P-256',
                                x: Buffer.from(xCoord).toString('base64url'),
                                y: Buffer.from(yCoord).toString('base64url')
                            };

                            let publicKeyObj;
                            try {
                                publicKeyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' });
                            } catch (e) {
                                return sendError(res, 'Could not load public key: ' + e.message, 400);
                            }

                            const verifier = crypto.createVerify('SHA256');
                            verifier.update(signedData);
                            verifier.end();

                            let valid = false;
                            try {
                                valid = verifier.verify({ key: publicKeyObj, dsaEncoding: 'der' }, signature);
                            } catch (e) {
                                try {
                                    valid = verifier.verify({ key: publicKeyObj, dsaEncoding: 'ieee-p1363' }, signature);
                                } catch (e2) { valid = false; }
                            }

                            if (!valid) return sendError(res, 'Signature verification failed', 401);

                            cred.signCount = parsedAuth.signCount || cred.signCount || 0;
                            cred.lastUsedAt = Date.now();
                            await saveUser(match.uid, u);

                            audit('WEBAUTHN_LOGIN', ip, match.uid, {});
                            const safeUser = sanitizeUserData(u);
                            const sessToken = issueApiSessionToken(match.uid, ip, req.headers['user-agent']);
                            return jsonRes(res, {
                                success: true,
                                uid: match.uid,
                                sessionToken: sessToken,
                                user: {
                                    fullName: safeUser.fullName,
                                    accountNumber: safeUser.accountNumber,
                                    memberID: safeUser.memberID,
                                    email: safeUser.email,
                                    phone: safeUser.phone,
                                    balance: safeUser.balance || 0,
                                    accType: safeUser.accType || 'Savings'
                                }
                            });
                        } catch (e) {
                            console.error('[WEBAUTHN login-finish]', e.stack || e);
                            return sendError(res, 'Fingerprint verification failed', 500);
                        }
                    }

                    if (cleanPath === '/api/webauthn/register-start' && req.method === 'POST') {
                        if (!rateLimit(ip, 'webauthn-start', 20, 60000)) return sendError(res, 'Too many requests.', 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, sessionToken } = body;
                        if (!uid || !sessionToken) return sendError(res, 'Missing fields', 400);
                        const tok = pinSessionTokens.get(sessionToken);
                        if (!tok || tok.uid !== uid || Date.now() > tok.expires) {
                            return sendError(res, 'Invalid or expired verification session', 401);
                        }
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            if (!u.webauthn) u.webauthn = { credentials: [] };
                            if (!Array.isArray(u.webauthn.credentials)) u.webauthn.credentials = [];
                            if (u.webauthn.credentials.length >= WEBAUTHN_MAX_CREDS) {
                                return sendError(res, `Maximum ${WEBAUTHN_MAX_CREDS} devices allowed`, 400);
                            }
                            const challengeB64 = bufferToB64url(crypto.randomBytes(32));
                            const challengeId = crypto.randomBytes(16).toString('hex');
                            webAuthnChallenges.set(challengeId, {
                                challenge: challengeB64,
                                uid,
                                type: 'register',
                                expires: Date.now() + WEBAUTHN_CHALLENGE_MS
                            });
                            const excludeCredentials = u.webauthn.credentials.map(c => ({
                                id: c.id, type: 'public-key', transports: c.transports || []
                            }));
                            const userId = Buffer.from(uid, 'hex');
                            return jsonRes(res, {
                                success: true,
                                challenge: challengeB64,
                                challengeId,
                                rpId: (req.headers.host || '').split(':')[0] || undefined,
                                rpName: WEBAUTHN_RP_NAME,
                                userId: bufferToB64url(userId),
                                userName: u.email || uid,
                                userDisplayName: u.fullName || 'CITFUND User',
                                excludeCredentials
                            });
                        } catch (e) { return sendError(res, 'Could not start registration', 500); }
                    }

                    if (cleanPath === '/api/webauthn/register-finish' && req.method === 'POST') {
                        if (!rateLimit(ip, 'webauthn-finish', 20, 60000)) return sendError(res, 'Too many requests.', 429);
                        const body = await getBody(req, 2 * 1024 * 1024);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, sessionToken, id, response, deviceName } = body;
                        if (!uid || !sessionToken || !id || !response) return sendError(res, 'Missing fields', 400);
                        const tok = pinSessionTokens.get(sessionToken);
                        if (!tok || tok.uid !== uid || Date.now() > tok.expires) {
                            return sendError(res, 'Invalid or expired verification session', 401);
                        }
                        try {
                            let clientData;
                            try {
                                const clientDataRaw = b64urlToBuffer(response.clientDataJSON);
                                clientData = JSON.parse(clientDataRaw.toString('utf8'));
                            } catch (e) { return sendError(res, 'Invalid clientDataJSON', 400); }
                            if (clientData.type !== 'webauthn.create') return sendError(res, 'Bad clientData type', 400);
                            let challengeId = null;
                            for (const [cid, c] of webAuthnChallenges) {
                                if (c.uid === uid && c.type === 'register' && c.challenge === clientData.challenge) {
                                    challengeId = cid; break;
                                }
                            }
                            if (!challengeId) return sendError(res, 'Challenge not found or expired', 400);
                            webAuthnChallenges.delete(challengeId);

                            const reqHost = (req.headers.host || '').toLowerCase();
                            const expectedOrigins = [];
                            if (reqHost) { expectedOrigins.push(`https://${reqHost}`); expectedOrigins.push(`http://${reqHost}`); }
                            if (APP_URL) expectedOrigins.push(APP_URL);
                            const origin = String(clientData.origin || '');
                            let originOK = false;
                            for (const exp of expectedOrigins) {
                                try {
                                    const o1 = new URL(origin);
                                    const o2 = new URL(exp);
                                    if (o1.hostname === o2.hostname) { originOK = true; break; }
                                } catch (e) {}
                            }
                            if (!originOK) return sendError(res, 'Origin mismatch', 400);

                            let attObj;
                            try {
                                const attRaw = b64urlToBuffer(response.attestationObject);
                                attObj = decodeCBOR(attRaw);
                            } catch (e) { return sendError(res, 'Invalid attestationObject: ' + e.message, 400); }
                            if (!attObj || !attObj.authData) return sendError(res, 'Missing authData', 400);

                            const authData = parseAuthData(attObj.authData);
                            if (!authData.credentialId || !authData.credentialPublicKey) {
                                return sendError(res, 'Missing credential public key', 400);
                            }

                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            if (!u.webauthn) u.webauthn = { credentials: [] };
                            if (!Array.isArray(u.webauthn.credentials)) u.webauthn.credentials = [];

                            const credIdB64 = bufferToB64url(authData.credentialId);
                            if (u.webauthn.credentials.some(c => c.id === credIdB64)) {
                                return sendError(res, 'Credential already registered', 400);
                            }

                            const newCred = {
                                id: credIdB64,
                                publicKey: bufferToB64url(authData.credentialPublicKey),
                                signCount: authData.signCount,
                                transports: response.transports || [],
                                name: (deviceName || 'Device').slice(0, 60),
                                createdAt: Date.now(),
                                lastUsedAt: null
                            };
                            u.webauthn.credentials.push(newCred);
                            await saveUser(uid, u);
                            pinSessionTokens.delete(sessionToken);
                            audit('WEBAUTHN_REGISTER', ip, uid, { name: newCred.name });
                            return jsonRes(res, { success: true, credentialId: credIdB64, name: newCred.name });
                        } catch (e) {
                            console.error('[WEBAUTHN finish]', e);
                            return sendError(res, 'Registration verification failed: ' + e.message, 400);
                        }
                    }

                    if (cleanPath === '/api/webauthn/list' && req.method === 'POST') {
                        if (!rateLimit(ip, 'webauthn-list', 60, 60000)) return sendError(res, 'Too many requests.', 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, 'Missing uid', 400);
                        try {
                            const u = await getUserByUid(body.uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            const creds = (u.webauthn && Array.isArray(u.webauthn.credentials)) ? u.webauthn.credentials : [];
                            return jsonRes(res, {
                                success: true,
                                credentials: creds.map(c => ({
                                    id: c.id,
                                    name: c.name || 'Registered Device',
                                    createdAt: c.createdAt,
                                    lastUsedAt: c.lastUsedAt || null,
                                    transports: c.transports || []
                                }))
                            });
                        } catch (e) { return sendError(res, 'Could not list credentials', 500); }
                    }

                    if (cleanPath === '/api/webauthn/remove' && req.method === 'POST') {
                        if (!rateLimit(ip, 'webauthn-remove', 20, 60000)) return sendError(res, 'Too many requests.', 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, sessionToken, credentialId } = body;
                        if (!uid || !sessionToken || !credentialId) return sendError(res, 'Missing fields', 400);
                        const tok = pinSessionTokens.get(sessionToken);
                        if (!tok || tok.uid !== uid || Date.now() > tok.expires) {
                            return sendError(res, 'Invalid or expired verification session', 401);
                        }
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            if (!u.webauthn || !Array.isArray(u.webauthn.credentials)) {
                                return sendError(res, 'No credentials found', 404);
                            }
                            const before = u.webauthn.credentials.length;
                            u.webauthn.credentials = u.webauthn.credentials.filter(c => c.id !== credentialId);
                            if (u.webauthn.credentials.length === before) return sendError(res, 'Credential not found', 404);
                            await saveUser(uid, u);
                            pinSessionTokens.delete(sessionToken);
                            audit('WEBAUTHN_REMOVE', ip, uid, {});
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, 'Could not remove credential', 500); }
                    }

                    // =====================================================
                    // ========== DASHBOARD / USER DATA ====================
                    // =====================================================
                    if ((cleanPath === '/api/dashboard' || cleanPath === '/api/user-data') && req.method === 'POST') {
                        const rlKey = cleanPath === '/api/user-data' ? 'userdata' : 'dashboard';
                        if (!rateLimit(ip, rlKey, 240, 60000)) return sendError(res, "Too many requests.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${body.uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap || !snap.encryptedData) return sendError(res, "User not found", 404);
                            let u = decryptData(snap.encryptedData, body.uid);
                            try {
                                const rc = await reconcileUserPendingDeposits(body.uid, u, { minAgeMs: 5000, maxAgeMs: 72 * 3600000 });
                                if (rc.credited > 0) await saveUser(body.uid, u);
                            } catch (e) { console.warn('[DASH-RECONCILE]', e.message); }
                            u = await enrichUserWithKYC(u, body.uid);
                            if (!u.virtualAccount) u.virtualAccount = {};
                            if (u.virtualAccount.status !== 'unavailable') {
                                u.virtualAccount.status = 'unavailable';
                                u.virtualAccount.error = DVA_COMING_SOON_MSG;
                                u.virtualAccount.message = DVA_COMING_SOON_MSG;
                                try { await saveUser(body.uid, u); } catch {}
                            }
                            return jsonRes(res, { success: true, user: sanitizeUserData(u) });
                        } catch (e) { return sendError(res, "DB Error: " + e.message, 500); }
                    }

                    if (cleanPath === '/api/update-profile' && req.method === 'POST') {
                        if (!rateLimit(ip, 'updateprofile', 30, 60000)) return sendError(res, "Too many requests.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${body.uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, body.uid);
                            const fields = ['fullName','dob','gender','marital','nationality','occupation','employer','income','phone','email','address','city','region','postal','idType','idNumber','idIssue','nokName','nokRel','nokPhone','nokEmail','nokAddress','nokCity','branch','language','emailNotif','smsAlert','photo','bankAccount','bankCode','bankName','momoPhone','momoNetwork'];
                            fields.forEach(f => { if (body[f] !== undefined) u[f] = body[f]; });
                            if (body.pin) {
                                const pErr = validatePinStrength(body.pin);
                                if (pErr) return sendError(res, pErr, 400);
                                u.pin = body.pin;
                            }
                            if (body.password) {
                                const pwE = validatePasswordStrength(body.password);
                                if (pwE) return sendError(res, pwE, 400);
                                u.password = body.password;
                            }
                            await saveUser(body.uid, u);
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, "Update Error: " + e.message, 500); }
                    }

                    if (cleanPath.startsWith('/api/virtual-account/')) {
                        return jsonRes(res, {
                            success: false, comingSoon: true, notAvailable: true,
                            message: DVA_COMING_SOON_MSG, error: DVA_COMING_SOON_MSG,
                            virtualAccount: { status: 'unavailable', accountNumber: '', accountName: '', bankName: '', currency: 'GHS', error: DVA_COMING_SOON_MSG, message: DVA_COMING_SOON_MSG }
                        });
                    }

                    // =====================================================
                    // ⭐ BENEFICIARIES
                    // =====================================================
                    if (cleanPath === '/api/beneficiaries/list' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, 'Missing uid', 400);
                        try {
                            const u = await getUserByUid(body.uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            return jsonRes(res, { success: true, beneficiaries: u.beneficiaries || [] });
                        } catch (e) { return sendError(res, 'Error', 500); }
                    }
                    if (cleanPath === '/api/beneficiaries/add' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, accountNumber, name, nickname } = body;
                        if (!uid || !accountNumber) return sendError(res, 'Missing fields', 400);
                        try {
                            const target = await findUserByAccount(accountNumber);
                            if (!target) return sendError(res, 'Account not found', 404);
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            u.beneficiaries = u.beneficiaries || [];
                            if (u.beneficiaries.length >= 50) return sendError(res, 'Maximum 50 beneficiaries', 400);
                            if (u.beneficiaries.some(b => b.accountNumber === accountNumber)) {
                                return sendError(res, 'Already saved', 400);
                            }
                            u.beneficiaries.push({
                                id: 'BEN-' + Date.now(),
                                accountNumber: String(accountNumber),
                                name: name || target.data.fullName,
                                nickname: nickname || '',
                                createdAt: Date.now()
                            });
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, 'Error', 500); }
                    }
                    if (cleanPath === '/api/beneficiaries/remove' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, beneficiaryId } = body;
                        if (!uid || !beneficiaryId) return sendError(res, 'Missing fields', 400);
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            u.beneficiaries = (u.beneficiaries || []).filter(b => b.id !== beneficiaryId);
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, 'Error', 500); }
                    }

                    // =====================================================
                    // ⭐ STANDING ORDERS (recurring transfers)
                    // =====================================================
                    if (cleanPath === '/api/standing-orders/list' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, 'Missing uid', 400);
                        try {
                            const u = await getUserByUid(body.uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            return jsonRes(res, { success: true, orders: u.standingOrders || [] });
                        } catch (e) { return sendError(res, 'Error', 500); }
                    }
                    if (cleanPath === '/api/standing-orders/create' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, receiverAccount, amount, frequency, nextRun, pin } = body;
                        if (!uid || !receiverAccount || !amount || !pin) return sendError(res, 'Missing fields', 400);
                        const amt = Number(amount);
                        if (isNaN(amt) || amt < 1) return sendError(res, 'Invalid amount', 400);
                        const validFreq = ['daily', 'weekly', 'monthly'];
                        if (!validFreq.includes(frequency)) return sendError(res, 'Invalid frequency', 400);
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            if (!safeEqual(u.pin, pin)) return sendError(res, 'Invalid PIN', 401);
                            const target = await findUserByAccount(receiverAccount);
                            if (!target) return sendError(res, 'Recipient not found', 404);
                            if (target.uid === uid) return sendError(res, 'Cannot schedule transfer to yourself', 400);
                            u.standingOrders = u.standingOrders || [];
                            if (u.standingOrders.length >= 10) return sendError(res, 'Maximum 10 standing orders', 400);
                            const id = 'SO-' + Date.now();
                            const nextTime = Number(nextRun) || Date.now() + MS_PER_DAY;
                            u.standingOrders.push({
                                id, receiverAccount: String(receiverAccount),
                                receiverName: target.data.fullName,
                                amount: amt, frequency,
                                nextRun: nextTime, active: true,
                                createdAt: Date.now(), lastRunAt: null
                            });
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true, id });
                        } catch (e) { return sendError(res, 'Error', 500); }
                    }
                    if (cleanPath === '/api/standing-orders/toggle' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, orderId } = body;
                        if (!uid || !orderId) return sendError(res, 'Missing fields', 400);
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            const order = (u.standingOrders || []).find(o => o.id === orderId);
                            if (!order) return sendError(res, 'Order not found', 404);
                            order.active = !order.active;
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true, active: order.active });
                        } catch (e) { return sendError(res, 'Error', 500); }
                    }
                    if (cleanPath === '/api/standing-orders/delete' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, orderId } = body;
                        if (!uid || !orderId) return sendError(res, 'Missing fields', 400);
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            u.standingOrders = (u.standingOrders || []).filter(o => o.id !== orderId);
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, 'Error', 500); }
                    }

                    // =====================================================
                    // ⭐ STATEMENT DATA (for print.html)
                    // =====================================================
                    if (cleanPath === '/api/statement/data' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, from, to } = body;
                        if (!uid) return sendError(res, 'Missing uid', 400);
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            let txs = Object.values(u.transactions || {});
                            if (from) txs = txs.filter(t => new Date(t.date) >= new Date(from));
                            if (to) txs = txs.filter(t => new Date(t.date) <= new Date(to));
                            txs.sort((a, b) => new Date(b.date) - new Date(a.date));
                            return jsonRes(res, {
                                success: true,
                                user: {
                                    fullName: u.fullName, accountNumber: u.accountNumber,
                                    memberID: u.memberID, phone: u.phone, email: u.email,
                                    balance: u.balance || 0, accType: u.accType || 'Savings'
                                },
                                transactions: txs.slice(0, 500),
                                period: { from: from || null, to: to || null, generatedAt: new Date().toISOString() }
                            });
                        } catch (e) { return sendError(res, 'Error', 500); }
                    }

                    // =====================================================
                    // ========== PAYSTACK DEPOSITS ========================
                    // =====================================================
                    if (cleanPath === '/api/paystack/momo-initialize' && req.method === 'POST') {
                        if (!rateLimit(ip, 'momoint', 30, 300000)) return sendError(res, "Too many deposit attempts.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, amount, network, phoneNumber, callbackUrl } = body;
                        if (!uid || !amount || !network || !phoneNumber) return sendError(res, 'Missing fields', 400);
                        const validNets = ['mtn', 'telecel', 'airteltigo', 'airtel'];
                        const net = String(network).toLowerCase();
                        if (!validNets.includes(net)) return sendError(res, 'Invalid network', 400);
                        const amt = Number(amount);
                        if (isNaN(amt) || amt < 1) return sendError(res, 'Minimum GHS 1.00', 400);
                        if (amt > 100000) return sendError(res, 'Maximum GHS 100,000', 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, 'User not found', 404);
                            const u = decryptData(snap.encryptedData, uid);
                            const txRef = 'CITPS-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
                            const feeCalc = calculateDepositFee(amt);
                            const psData = await paystackInitializeTransaction({
                                email: u.email, amount: amt, currency: 'GHS',
                                reference: txRef, channels: ['mobile_money'],
                                callback_url: callbackUrl || undefined
                            });
                            u.transactions = u.transactions || {};
                            u.transactions[txRef] = {
                                id: txRef, type: 'deposit', amount: amt,
                                phone: phoneNumber, network: net, reference: txRef,
                                status: 'pending', gateway: 'paystack',
                                transactionFee: feeCalc.fee, feeTier: feeCalc.label,
                                netAfterFee: feeCalc.netAfterFee,
                                date: new Date().toISOString(), read: false
                            };
                            await saveUser(uid, u);
                            sendSMS(u.phone, SMS.depositPending(amt, feeCalc.fee, txRef, feeCalc.label), 'dep-pend-' + txRef).catch(() => {});
                            return jsonRes(res, {
                                success: true, txRef,
                                authorizationUrl: psData.authorization_url,
                                accessCode: psData.access_code,
                                amount: amt, transactionFee: feeCalc.fee,
                                feeTier: feeCalc.label
                            });
                        } catch (e) { return sendError(res, 'Paystack init failed: ' + e.message, 500); }
                    }

                    if (cleanPath === '/api/klasha/momo-collect' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        try {
                            const { uid, amount, phoneNumber, network } = body;
                            if (!uid || !amount || !phoneNumber) return sendError(res, 'Missing fields', 400);
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, 'User not found', 404);
                            const u = decryptData(snap.encryptedData, uid);
                            const txRef = 'CITKS-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
                            const feeCalc = calculateDepositFee(Number(amount));
                            const psData = await paystackInitializeTransaction({
                                email: u.email, amount: Number(amount), currency: 'GHS',
                                reference: txRef, channels: ['mobile_money']
                            });
                            u.transactions = u.transactions || {};
                            u.transactions[txRef] = {
                                id: txRef, type: 'deposit', amount: Number(amount),
                                phone: phoneNumber, network: network || 'airtel',
                                reference: txRef, status: 'pending', gateway: 'paystack',
                                transactionFee: feeCalc.fee, feeTier: feeCalc.label,
                                netAfterFee: feeCalc.netAfterFee,
                                date: new Date().toISOString(), read: false
                            };
                            await saveUser(uid, u);
                            sendSMS(u.phone, SMS.depositPending(Number(amount), feeCalc.fee, txRef, feeCalc.label), 'dep-pend-' + txRef).catch(() => {});
                            return jsonRes(res, {
                                success: true, txRef,
                                authorizationUrl: psData.authorization_url,
                                accessCode: psData.access_code,
                                paymentUrl: psData.authorization_url,
                                amount: Number(amount), transactionFee: feeCalc.fee
                            });
                        } catch (e) { return sendError(res, 'Klasha fallback failed: ' + e.message, 500); }
                    }

                    if (cleanPath === '/api/paystack/verify' && req.method === 'POST') {
                        if (!rateLimit(ip, 'psverify', 60, 60000)) return sendError(res, "Too many requests.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.txRef) return sendError(res, 'Missing txRef', 400);
                        try {
                            const v = await paystackVerifyTransaction(body.txRef);
                            const all = await getAllUsers();
                            let fUid = null, fData = null;
                            for (const u in all) {
                                if (!all[u].encryptedData) continue;
                                try {
                                    const d = decryptData(all[u].encryptedData, u);
                                    if (d.transactions && d.transactions[body.txRef]) { fUid = u; fData = d; break; }
                                } catch {}
                            }
                            if (fUid && fData && v.status === 'success') {
                                const tx = fData.transactions[body.txRef];
                                if (tx.status !== 'success') {
                                    const gross = Number(v.amount) / 100;
                                    const r = applyDepositCredit(fData, tx, gross, 'client-verify');
                                    if (r.credited) {
                                        await saveUser(fUid, fData);
                                        sendSMS(fData.phone, SMS.depositCredited(gross, tx.transactionFee, tx.openingFee, tx.creditedAmount, fData.balance, body.txRef, tx.feeTier), 'dep-credit-' + body.txRef).catch(() => {});
                                    }
                                }
                                return jsonRes(res, { success: true, status: 'success', amount: Number(v.amount) / 100, newBalance: fData.balance });
                            }
                            return jsonRes(res, { success: true, status: v.status });
                        } catch (e) { return sendError(res, 'Verify failed: ' + e.message, 500); }
                    }

                    if (cleanPath === '/api/paystack/verify-pending' && req.method === 'POST') {
                        if (!rateLimit(ip, 'psvp', 30, 60000)) return sendError(res, "Too many.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, 'Missing uid', 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${body.uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, 'User not found', 404);
                            const u = decryptData(snap.encryptedData, body.uid);
                            const r = await reconcileUserPendingDeposits(body.uid, u, { minAgeMs: 0, maxAgeMs: 72 * 3600000 });
                            if (r.credited > 0) await saveUser(body.uid, u);
                            return jsonRes(res, { success: true, checked: r.checked, credited: r.credited, newBalance: u.balance });
                        } catch (e) { return sendError(res, 'Verify failed: ' + e.message, 500); }
                    }

                    if (cleanPath === '/api/admin/reconcile' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, 'Unauthorized', 401);
                        const body = await getBody(req);
                        const minAgeMs = Math.max(0, Number(body && body.minAgeMs) || 0);
                        try {
                            const all = await getAllUsers();
                            let tc = 0, tk = 0, ut = 0;
                            for (const uid in all) {
                                if (!all[uid].encryptedData) continue;
                                let u;
                                try { u = decryptData(all[uid].encryptedData, uid); } catch { continue; }
                                const r = await reconcileUserPendingDeposits(uid, u, { minAgeMs, maxAgeMs: 30 * 86400000 });
                                tk += r.checked; tc += r.credited;
                                if (r.credited > 0) { ut++; await saveUser(uid, u); }
                            }
                            audit('RECONCILE', 'admin', '', { checked: tk, credited: tc });
                            return jsonRes(res, { success: true, checked: tk, credited: tc, usersTouched: ut });
                        } catch (e) { return sendError(res, 'Reconcile error: ' + e.message, 500); }
                    }

                    // ========== PAYSTACK WEBHOOK ==========
                    if (cleanPath === '/api/paystack/webhook' && req.method === 'POST') {
                        const raw = await getRawBody(req, 1048576);
                        if (typeof raw === 'object' && raw.error) return sendError(res, raw.error, 400);
                        const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(raw).digest('hex');
                        const sig = req.headers['x-paystack-signature'];
                        if (!sig || !safeEqual(hash, sig)) {
                            console.error('[WEBHOOK] Invalid signature');
                            return sendError(res, 'Invalid signature', 401);
                        }
                        let payload;
                        try { payload = JSON.parse(raw); } catch { return sendError(res, "Invalid JSON", 400); }
                        const event = payload.event;
                        const data = payload.data || {};
                        console.log('[WEBHOOK]', event, data.status, data.reference);

                        if (event === 'charge.success' && data.status === 'success') {
                            const txRef = data.reference;
                            const amount = Number(data.amount) / 100;
                            try {
                                const all = await getAllUsers();
                                let fUid = null, fData = null;
                                for (const u in all) {
                                    if (!all[u].encryptedData) continue;
                                    try {
                                        const d = decryptData(all[u].encryptedData, u);
                                        if (d.transactions && d.transactions[txRef]) { fUid = u; fData = d; break; }
                                    } catch {}
                                }
                                if (fUid && fData) {
                                    const tx = fData.transactions[txRef];
                                    if (tx && tx.status !== 'success') {
                                        const r = applyDepositCredit(fData, tx, amount, 'webhook');
                                        if (r.credited) {
                                            await saveUser(fUid, fData);
                                            sendSMS(fData.phone, SMS.depositCredited(amount, tx.transactionFee, tx.openingFee, tx.creditedAmount, fData.balance, txRef, tx.feeTier), 'dep-credit-' + txRef).catch(() => {});
                                        }
                                    }
                                }
                            } catch (e) { console.error('Webhook error:', e.message); }
                        }

                        if (event === 'transfer.success' && data.status === 'success') {
                            const ref = data.reference;
                            try {
                                const all = await getAllUsers();
                                for (const u2 in all) {
                                    if (!all[u2].encryptedData) continue;
                                    try {
                                        const d = decryptData(all[u2].encryptedData, u2);
                                        if (d.withdrawalRequests && d.withdrawalRequests[ref]) {
                                            const rec = d.withdrawalRequests[ref];
                                            if (rec.status !== 'success') {
                                                rec.status = 'success';
                                                rec.completedAt = Date.now();
                                                const tx = d.transactions && d.transactions[ref];
                                                if (tx) tx.status = 'success';
                                                await saveUser(u2, d);
                                                sendSMS(d.phone, SMS.withdrawSuccess(rec.amount, rec.momoPhone, d.balance, ref), 'wd-success-' + ref).catch(() => {});
                                            }
                                            break;
                                        }
                                    } catch {}
                                }
                            } catch (e) { console.error('Transfer webhook error:', e.message); }
                        }

                        if (event === 'transfer.failed' && data.status === 'failed') {
                            const ref = data.reference;
                            try {
                                const all = await getAllUsers();
                                for (const u2 in all) {
                                    if (!all[u2].encryptedData) continue;
                                    try {
                                        const d = decryptData(all[u2].encryptedData, u2);
                                        if (d.withdrawalRequests && d.withdrawalRequests[ref]) {
                                            const rec = d.withdrawalRequests[ref];
                                            if (rec.status === 'pending') {
                                                const refund = Number(rec.totalDebit || rec.amount);
                                                d.balance = Number(((Number(d.balance) || 0) + refund).toFixed(2));
                                                rec.status = 'failed';
                                                rec.failureReason = data.reason || 'Transfer failed at Paystack';
                                                rec.completedAt = Date.now();
                                                const tx = d.transactions && d.transactions[ref];
                                                if (tx) { tx.status = 'failed'; tx.failureReason = rec.failureReason; tx.newBalance = d.balance; }
                                                await saveUser(u2, d);
                                                sendSMS(d.phone, SMS.withdrawFailed(rec.amount, rec.failureReason, ref), 'wd-fail-' + ref).catch(() => {});
                                            }
                                            break;
                                        }
                                    } catch {}
                                }
                            } catch (e) { console.error('Transfer fail webhook error:', e.message); }
                        }

                        return jsonRes(res, { success: true });
                    }

                    if (cleanPath === '/api/payment/failed' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, txRef, reason } = body;
                        if (!uid || !txRef) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            u.transactions = u.transactions || {};
                            const tx = u.transactions[txRef];
                            if (tx && tx.status !== 'success') {
                                tx.status = 'failed';
                                tx.failedAt = new Date().toISOString();
                                tx.failureReason = reason || 'Payment cancelled';
                                await saveUser(uid, u);
                                sendSMS(u.phone, SMS.depositFailed(tx.amount, txRef, tx.failureReason), 'dep-fail-' + txRef).catch(() => {});
                            }
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, "Error: " + e.message, 500); }
                    }

                    // =====================================================
                    // ========== INVESTMENT ===============================
                    // =====================================================
                    if (cleanPath === '/api/investment/plans' && req.method === 'POST') {
                        return jsonRes(res, {
                            success: true, rateRule: '5% every 15 days',
                            fixed: FIXED_PLANS, flex: FLEX_PLANS,
                            feeNote: 'Investing from your CITFUND wallet is free.'
                        });
                    }
                    if (cleanPath === '/api/investment/create' && req.method === 'POST') {
                        if (!rateLimit(ip, 'invcreate', 20, 60000)) return sendError(res, "Too many.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, planId, amount, pin } = body;
                        if (!uid || !planId || !amount || !pin) return sendError(res, "Missing fields", 400);
                        const amt = Number(amount);
                        if (isNaN(amt) || amt <= 0) return sendError(res, "Invalid amount", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            if (!safeEqual(u.pin, pin)) return sendError(res, "Invalid PIN", 401);
                            const plan = ALL_PLANS.find(p => p.id === planId);
                            if (!plan) return sendError(res, "Plan not found", 404);
                            if (amt < plan.minAmount) return sendError(res, `Minimum ${formatMoney(plan.minAmount)}`, 400);
                            const bal = parseFloat(u.balance) || 0;
                            if (bal < amt) return sendError(res, "Insufficient balance", 400);
                            const investId = 'INV' + Date.now() + crypto.randomBytes(3).toString('hex').toUpperCase();
                            const now = Date.now();
                            const ei = Number((amt * (plan.interestRate / 100)).toFixed(2));
                            const et = Number((amt + ei).toFixed(2));
                            const mat = plan.duration > 0 ? now + (plan.duration * MS_PER_DAY) : 0;
                            const nb = Number((bal - amt).toFixed(2));
                            u.balance = nb;
                            u.investments = u.investments || {};
                            u.investments[investId] = {
                                id: investId, planId: plan.id, planName: plan.name, planType: plan.type,
                                duration: plan.duration, interestRate: plan.interestRate, amount: amt,
                                expectedInterest: ei, expectedTotal: et, status: 'active',
                                startDate: new Date(now).toISOString(), startTime: now,
                                maturityTime: mat, createdAt: now, lastYieldAt: now, currentYield: 0, transactionFee: 0
                            };
                            u.transactions = u.transactions || {};
                            u.transactions[investId] = {
                                id: investId, type: 'invest', amount: amt, plan: plan.name, planId: plan.id,
                                status: 'success', date: new Date().toISOString(), read: false,
                                newBalance: nb, transactionFee: 0, narration: `Investment - ${plan.name}`
                            };
                            await saveUser(uid, u);
                            sendSMS(u.phone, SMS.investCreated(plan.name, amt, plan.interestRate, plan.duration, formatDateLong(mat), investId), 'inv-' + investId).catch(() => {});
                            return jsonRes(res, {
                                success: true, investmentId: investId, plan, amount: amt,
                                expectedInterest: ei, expectedTotal: et, newBalance: nb,
                                startTime: now, maturityTime: mat, transactionFee: 0
                            });
                        } catch (e) { return sendError(res, "Investment error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/investment/list' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${body.uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, body.uid);
                            const list = Object.values(u.investments || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                            return jsonRes(res, { success: true, investments: list, balance: u.balance || 0 });
                        } catch (e) { return sendError(res, "Error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/investment/withdraw' && req.method === 'POST') {
                        if (!rateLimit(ip, 'invwd', 20, 60000)) return sendError(res, "Too many.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, investmentId, pin } = body;
                        if (!uid || !investmentId || !pin) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            if (!safeEqual(u.pin, pin)) return sendError(res, "Invalid PIN", 401);
                            const inv = u.investments && u.investments[investmentId];
                            if (!inv) return sendError(res, "Investment not found", 404);
                            if (inv.status !== 'active') return sendError(res, "Investment not active", 400);
                            const now = Date.now();
                            const st = Number(inv.startTime) || 0;
                            const dd = Number(inv.duration) || 0;
                            const mt = Number(inv.maturityTime) || (st + dd * MS_PER_DAY);
                            if (now < mt) {
                                const rd = Math.ceil((mt - now) / MS_PER_DAY);
                                return jsonRes(res, {
                                    success: false,
                                    error: `Investment still running. ${rd} day(s) remaining.`,
                                    matured: false, maturityTime: mt, serverTime: now, remainingDays: rd
                                });
                            }
                            const dailyRate = DAILY_RATE_PERCENT / 100;
                            const earned = Number((inv.amount * dailyRate * dd).toFixed(2));
                            const total = Number((inv.amount + earned).toFixed(2));
                            const bal = parseFloat(u.balance) || 0;
                            const nb = Number((bal + total).toFixed(2));
                            u.balance = nb;
                            inv.status = 'withdrawn';
                            inv.withdrawnAt = new Date(now).toISOString();
                            inv.finalYield = earned;
                            inv.finalReturn = total;
                            u.transactions = u.transactions || {};
                            const txId = 'INVW-' + Date.now();
                            u.transactions[txId] = {
                                id: txId, type: 'deposit', amount: total,
                                narration: `Investment matured - ${inv.planName}`,
                                reference: investmentId, status: 'success',
                                date: new Date().toISOString(), read: false, newBalance: nb, transactionFee: 0
                            };
                            await saveUser(uid, u);
                            sendSMS(u.phone, SMS.investMatured(inv.planName, inv.amount, earned, total, nb, investmentId), 'inv-mature-' + investmentId).catch(() => {});
                            return jsonRes(res, { success: true, matured: true, yield: earned, totalReturn: total, newBalance: nb, durationDays: dd, transactionFee: 0 });
                        } catch (e) { return sendError(res, "Withdraw error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/investment/live' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, investmentId } = body;
                        if (!uid || !investmentId) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            const inv = u.investments && u.investments[investmentId];
                            if (!inv) return sendError(res, "Investment not found", 404);
                            const now = Date.now();
                            const elapsedMs = now - inv.startTime;
                            const elapsedDays = elapsedMs / MS_PER_DAY;
                            const yieldSoFar = Number((inv.amount * (DAILY_RATE_PERCENT / 100) * elapsedDays).toFixed(6));
                            const totalSoFar = Number((inv.amount + yieldSoFar).toFixed(6));
                            const progress = inv.duration > 0 ? Math.min(100, (elapsedDays / inv.duration) * 100) : 100;
                            const matured = now >= (inv.maturityTime || (inv.startTime + inv.duration * MS_PER_DAY));
                            return jsonRes(res, {
                                success: true, investment: inv,
                                elapsedDays: elapsedDays.toFixed(4),
                                dailyRatePercent: DAILY_RATE_PERCENT,
                                yieldSoFar, totalSoFar,
                                progress: Number(progress.toFixed(2)),
                                matured, serverTime: now
                            });
                        } catch (e) { return sendError(res, "Error: " + e.message, 500); }
                    }

                    // =====================================================
                    // ========== BANK / MOMO / BUSINESS ===================
                    // =====================================================
                    if (cleanPath === '/api/update-bank-details' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, bankAccount, bankCode, bankName } = body;
                        if (!uid || !bankAccount || !bankCode) return sendError(res, "Missing required fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            u.bankAccount = bankAccount; u.bankCode = bankCode;
                            if (bankName) u.bankName = bankName;
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, "Update error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/update-momo-details' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, momoPhone, momoNetwork } = body;
                        if (!uid || !momoPhone || !momoNetwork) return sendError(res, "Missing required fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            u.momoPhone = momoPhone; u.momoNetwork = momoNetwork;
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, "Update error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/business/save' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, business } = body;
                        if (!uid || !business) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            u.business = business;
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, "Business Save Error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/business/add-item' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, item } = body;
                        if (!uid || !item) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            u.items = u.items || [];
                            u.items.push(item);
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, "Item Add Error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/business/delete-item' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, itemId } = body;
                        if (!uid || !itemId) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            if (u.items && Array.isArray(u.items)) {
                                const idx = u.items.findIndex(i => i.id === itemId);
                                if (idx !== -1) {
                                    u.items.splice(idx, 1);
                                    await saveUser(uid, u);
                                    return jsonRes(res, { success: true });
                                }
                                return sendError(res, "Item not found", 404);
                            }
                            return sendError(res, "No items found", 404);
                        } catch (e) { return sendError(res, "Delete Error: " + e.message, 500); }
                    }

                    // ========== MARKETPLACE ==========
                    if (cleanPath === '/api/market/items' && req.method === 'GET') {
                        try {
                            const all = await getAllUsers();
                            const items = [];
                            for (const uid in all) {
                                if (!all[uid].encryptedData) continue;
                                try {
                                    const d = decryptData(all[uid].encryptedData, uid);
                                    if (d.items && Array.isArray(d.items)) {
                                        d.items.forEach(item => items.push({
                                            ...item, sellerUid: uid,
                                            sellerName: d.fullName, sellerAccount: d.accountNumber,
                                            businessName: d.business?.name || 'CIT Store',
                                            businessLogo: d.business?.logo || '',
                                            businessDesc: d.business?.desc || ''
                                        }));
                                    }
                                } catch { continue; }
                            }
                            return jsonRes(res, { success: true, items });
                        } catch (e) { return sendError(res, "Market Error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/market/order' && req.method === 'POST') {
                        if (!rateLimit(ip, 'mktorder', 30, 60000)) return sendError(res, "Too many.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { buyerUid, sellerAccount, amount, itemName } = body;
                        if (!buyerUid || !sellerAccount || !amount || amount <= 0) return sendError(res, "Missing fields", 400);
                        try {
                            const buyerSnap = await httpsRequest(`${FIREBASE_DB_URL}/users/${buyerUid}.json?auth=${FIREBASE_SECRET}`);
                            if (!buyerSnap.encryptedData) return sendError(res, "Buyer not found", 404);
                            const buyerData = decryptData(buyerSnap.encryptedData, buyerUid);
                            const sellerInfo = await findUserByAccount(sellerAccount);
                            if (!sellerInfo) return sendError(res, "Seller account not found", 404);
                            const buyerBalance = parseFloat(buyerData.balance) || 0;
                            if (buyerBalance < amount) return sendError(res, "Insufficient balance", 400);
                            const txId = 'ORD' + Date.now() + Math.random().toString(36).substring(2, 7);
                            const date = new Date().toISOString();
                            buyerData.transactions = buyerData.transactions || {};
                            buyerData.transactions[txId] = {
                                id: txId, date, type: "order", amount: Number(amount),
                                receiver: sellerAccount, receiverName: sellerInfo.data.fullName,
                                itemName: itemName || 'Market item',
                                newBalance: buyerBalance - Number(amount), status: "SUCCESS", read: false
                            };
                            buyerData.balance = buyerBalance - Number(amount);
                            await saveUser(buyerUid, buyerData);

                            const sellerBalance = parseFloat(sellerInfo.data.balance) || 0;
                            sellerInfo.data.transactions = sellerInfo.data.transactions || {};
                            sellerInfo.data.transactions[txId] = {
                                id: txId, date, type: "deposit", amount: Number(amount),
                                sender: buyerData.accountNumber, senderName: buyerData.fullName,
                                itemName: itemName || 'Market item',
                                newBalance: sellerBalance + Number(amount), status: "SUCCESS", read: false
                            };
                            sellerInfo.data.balance = sellerBalance + Number(amount);
                            await saveUser(sellerInfo.uid, sellerInfo.data);

                            sendSMS(buyerData.phone, SMS.transferSent(Number(amount), sellerInfo.data.fullName, sellerAccount, txId, buyerData.balance), 'ord-b-' + txId).catch(() => {});
                            sendSMS(sellerInfo.data.phone, SMS.transferReceived(Number(amount), buyerData.fullName, buyerData.accountNumber, txId, sellerInfo.data.balance), 'ord-s-' + txId).catch(() => {});
                            return jsonRes(res, { success: true, transactionId: txId, newBalance: buyerData.balance });
                        } catch (e) { return sendError(res, "Order Error: " + e.message, 500); }
                    }

                    // =====================================================
                    // ========== TRANSACTIONS =============================
                    // =====================================================
                    if (cleanPath === '/api/verify-receiver' && req.method === 'POST') {
                        if (!rateLimit(ip, 'verifyrecv', 60, 60000)) return sendError(res, "Too many.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.accountNumber) return sendError(res, "Missing account number", 400);
                        try {
                            const found = await findUserByAccount(body.accountNumber);
                            if (found) return jsonRes(res, { success: true, name: found.data.fullName, accountType: found.data.accType || 'Savings' });
                            return sendError(res, "Account not found", 404);
                        } catch (e) { return sendError(res, "DB Error: " + e.message, 500); }
                    }

                    if (cleanPath === '/api/transfer' && req.method === 'POST') {
                        if (!rateLimit(ip, 'transfer', 30, 60000)) return sendError(res, "Too many transfers.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { senderUid, receiverAccount, amount } = body;
                        if (!senderUid || !receiverAccount || !amount || amount <= 0) return sendError(res, "Invalid parameters", 400);
                        try {
                            const senderSnap = await httpsRequest(`${FIREBASE_DB_URL}/users/${senderUid}.json?auth=${FIREBASE_SECRET}`);
                            if (!senderSnap.encryptedData) return sendError(res, "Sender not found", 404);
                            const senderData = decryptData(senderSnap.encryptedData, senderUid);
                            const senderBalance = parseFloat(senderData.balance) || 0;
                            if (senderBalance < amount) return sendError(res, "Insufficient balance", 400);
                            const receiverInfo = await findUserByAccount(receiverAccount);
                            if (!receiverInfo) return sendError(res, "Receiver account not found", 404);
                            if (receiverInfo.uid === senderUid) return sendError(res, "Cannot transfer to yourself", 400);
                            const txId = 'CITTRF' + Date.now() + Math.random().toString(36).substring(2, 7);
                            const date = new Date().toISOString();
                            senderData.transactions = senderData.transactions || {};
                            senderData.transactions[txId] = {
                                id: txId, date, type: "transfer", amount: Number(amount),
                                receiver: receiverAccount, receiverName: receiverInfo.data.fullName,
                                previousBalance: senderBalance,
                                newBalance: senderBalance - Number(amount),
                                status: "SUCCESS", read: false, transactionFee: 0
                            };
                            senderData.balance = senderBalance - Number(amount);
                            await saveUser(senderUid, senderData);

                            const receiverBalance = parseFloat(receiverInfo.data.balance) || 0;
                            receiverInfo.data.transactions = receiverInfo.data.transactions || {};
                            receiverInfo.data.transactions[txId] = {
                                id: txId, date, type: "deposit", amount: Number(amount),
                                sender: senderData.accountNumber, senderName: senderData.fullName,
                                previousBalance: receiverBalance,
                                newBalance: receiverBalance + Number(amount),
                                status: "SUCCESS", read: false, transactionFee: 0
                            };
                            receiverInfo.data.balance = receiverBalance + Number(amount);
                            await saveUser(receiverInfo.uid, receiverInfo.data);

                            sendSMS(senderData.phone, SMS.transferSent(Number(amount), receiverInfo.data.fullName, receiverAccount, txId, senderData.balance), 'trf-s-' + txId).catch(() => {});
                            sendSMS(receiverInfo.data.phone, SMS.transferReceived(Number(amount), senderData.fullName, senderData.accountNumber, txId, receiverInfo.data.balance), 'trf-r-' + txId).catch(() => {});
                            return jsonRes(res, { success: true, transactionId: txId, newBalance: senderData.balance, transactionFee: 0 });
                        } catch (e) { return sendError(res, "Transfer Error: " + e.message, 500); }
                    }

                    if (cleanPath === '/api/deposit' && req.method === 'POST') {
                        if (!rateLimit(ip, 'deposit', 30, 60000)) return sendError(res, "Too many.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, amount, reference } = body;
                        if (!uid || !amount || amount <= 0) return sendError(res, "Invalid parameters", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            const gross = Number(amount);
                            const { fee, netAfterFee, label } = calculateDepositFee(gross);
                            let actual = netAfterFee, openFee = 0;
                            if (u.pendingFee && u.pendingFee > 0) {
                                openFee = Math.min(u.pendingFee, actual);
                                u.pendingFee -= openFee;
                                actual = Number((actual - openFee).toFixed(2));
                            }
                            u.citFundRevenue = Number(((Number(u.citFundRevenue) || 0) + fee + openFee).toFixed(2));
                            const bal = parseFloat(u.balance) || 0;
                            const nb = Number((bal + actual).toFixed(2));
                            u.transactions = u.transactions || {};
                            const txId = reference || ('CITDEP' + Date.now());
                            u.transactions[txId] = {
                                id: txId, date: new Date().toISOString(), type: "deposit",
                                amount: actual, grossAmount: gross,
                                transactionFee: fee, feeTier: label,
                                openingFee: openFee, newBalance: nb, status: "SUCCESS", read: false
                            };
                            u.balance = nb;
                            await saveUser(uid, u);
                            sendSMS(u.phone, SMS.depositCredited(gross, fee, openFee, actual, nb, txId, label), 'dep-credit-' + txId).catch(() => {});
                            return jsonRes(res, { success: true, newBalance: nb, grossAmount: gross, transactionFee: fee, feeTier: label, openingFee: openFee, creditedAmount: actual });
                        } catch (e) { return sendError(res, "Deposit Error: " + e.message, 500); }
                    }

                    if (cleanPath === '/api/external-deposit' && req.method === 'POST') {
                        if (!rateLimit(ip, 'extdep', 20, 60000)) return sendError(res, "Too many.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { receiverAccount, amount, reference } = body;
                        if (!receiverAccount || !amount || amount <= 0) return sendError(res, "Invalid parameters", 400);
                        try {
                            const info = await findUserByAccount(receiverAccount);
                            if (!info) return sendError(res, "Account not found", 404);
                            const u = info.data;
                            const gross = Number(amount);
                            const { fee, netAfterFee, label } = calculateDepositFee(gross);
                            let actual = netAfterFee, openFee = 0;
                            if (u.pendingFee && u.pendingFee > 0) {
                                openFee = Math.min(u.pendingFee, actual);
                                u.pendingFee -= openFee;
                                actual = Number((actual - openFee).toFixed(2));
                            }
                            u.citFundRevenue = Number(((Number(u.citFundRevenue) || 0) + fee + openFee).toFixed(2));
                            const bal = parseFloat(u.balance) || 0;
                            const nb = Number((bal + actual).toFixed(2));
                            u.transactions = u.transactions || {};
                            const txId = reference || ('CITEXT' + Date.now());
                            u.transactions[txId] = {
                                id: txId, date: new Date().toISOString(), type: "deposit",
                                amount: actual, grossAmount: gross,
                                transactionFee: fee, feeTier: label,
                                openingFee: openFee, sender: "External",
                                newBalance: nb, status: "SUCCESS", read: false
                            };
                            u.balance = nb;
                            await saveUser(info.uid, u);
                            sendSMS(u.phone, SMS.depositCredited(gross, fee, openFee, actual, nb, txId, label), 'dep-credit-' + txId).catch(() => {});
                            return jsonRes(res, { success: true, newBalance: nb, grossAmount: gross, transactionFee: fee, feeTier: label, openingFee: openFee, creditedAmount: actual });
                        } catch (e) { return sendError(res, e.message, 500); }
                    }

                    if (cleanPath === '/api/pay-bill' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, biller, amount, pin } = body;
                        if (!uid || !biller || !amount || !pin) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            if (!safeEqual(u.pin, pin)) return sendError(res, "Invalid PIN", 401);
                            const bal = parseFloat(u.balance) || 0;
                            if (bal < amount) return sendError(res, "Insufficient balance", 400);
                            const nb = bal - Number(amount);
                            u.transactions = u.transactions || {};
                            const txId = 'CITBILL' + Date.now();
                            u.transactions[txId] = { id: txId, date: new Date().toISOString(), type: "bill", amount: Number(amount), biller, newBalance: nb, status: "SUCCESS", read: false };
                            u.balance = nb;
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true, newBalance: nb });
                        } catch (e) { return sendError(res, e.message, 500); }
                    }

                    if (cleanPath === '/api/buy-airtime' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, phone, amount, pin } = body;
                        if (!uid || !phone || !amount || !pin) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            if (!safeEqual(u.pin, pin)) return sendError(res, "Invalid PIN", 401);
                            const bal = parseFloat(u.balance) || 0;
                            if (bal < amount) return sendError(res, "Insufficient balance", 400);
                            const nb = bal - Number(amount);
                            u.transactions = u.transactions || {};
                            const txId = 'CITAIRTIME' + Date.now();
                            u.transactions[txId] = { id: txId, date: new Date().toISOString(), type: "airtime", amount: Number(amount), phone, newBalance: nb, status: "SUCCESS", read: false };
                            u.balance = nb;
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true, newBalance: nb });
                        } catch (e) { return sendError(res, e.message, 500); }
                    }

                    // =====================================================
                    // ========== LOANS ====================================
                    // =====================================================
                    if (cleanPath === '/api/loan/products' && req.method === 'POST') {
                        return jsonRes(res, { success: true, products: LOAN_PRODUCTS, eligibilityDays: LOAN_ELIGIBILITY_DAYS });
                    }
                    if (cleanPath === '/api/loan/eligibility' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${body.uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, body.uid);
                            const reg = Number(u.createdAt) || 0;
                            const age = reg > 0 ? Math.floor((Date.now() - reg) / MS_PER_DAY) : 0;
                            const active = Object.values(u.loans || {}).some(l => ['pending', 'approved', 'active'].includes(String(l.status || '').toLowerCase()));
                            const eligible = age >= LOAN_ELIGIBILITY_DAYS && !active;
                            return jsonRes(res, {
                                success: true, eligible, accountAgeDays: age,
                                daysRemaining: Math.max(0, LOAN_ELIGIBILITY_DAYS - age),
                                requiredDays: LOAN_ELIGIBILITY_DAYS, hasActiveLoan: active
                            });
                        } catch (e) { return sendError(res, "Error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/loan/apply' && req.method === 'POST') {
                        if (!rateLimit(ip, 'loanapply', 10, 60000)) return sendError(res, "Too many.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, productId, amount, duration, purpose, employment, income, occupation, pin } = body;
                        if (!uid || !productId || !amount || !duration || !pin) return sendError(res, "Missing fields", 400);
                        const amt = Number(amount), dur = Number(duration);
                        if (isNaN(amt) || amt <= 0) return sendError(res, "Invalid amount", 400);
                        if (isNaN(dur) || dur <= 0) return sendError(res, "Invalid duration", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            if (!safeEqual(u.pin, pin)) return sendError(res, "Invalid PIN", 401);
                            const product = LOAN_PRODUCTS.find(p => p.id === productId);
                            if (!product) return sendError(res, "Loan product not found", 404);
                            if (amt < product.minAmount) return sendError(res, `Minimum ${formatMoney(product.minAmount)}`, 400);
                            if (amt > product.maxAmount) return sendError(res, `Maximum ${formatMoney(product.maxAmount)}`, 400);
                            if (dur < product.minDuration || dur > product.maxDuration) return sendError(res, `Duration must be ${product.minDuration}-${product.maxDuration}`, 400);
                            const reg = Number(u.createdAt) || 0;
                            const age = reg > 0 ? Math.floor((Date.now() - reg) / MS_PER_DAY) : 0;
                            if (age < LOAN_ELIGIBILITY_DAYS) return sendError(res, `Loan requires ${LOAN_ELIGIBILITY_DAYS} days history. You have ${age} days.`, 403);
                            const active = Object.values(u.loans || {}).some(l => ['pending', 'approved', 'active'].includes(String(l.status || '').toLowerCase()));
                            if (active) return sendError(res, "You already have a pending or active loan.", 400);
                            const feePercent = Number(product.processingFeePercent || 2);
                            const interest = Number((amt * (product.interestRate / 100)).toFixed(2));
                            const processingFee = Number((amt * (feePercent / 100)).toFixed(2));
                            const netDisbursed = Number((amt - processingFee).toFixed(2));
                            const totalRepayment = Number((amt + interest).toFixed(2));
                            const installments = loanInstallmentCount(product, dur);
                            const perInstallment = installments > 0 ? Number((totalRepayment / installments).toFixed(2)) : totalRepayment;
                            const loanId = 'CITLN' + Date.now().toString().slice(-8) + crypto.randomBytes(2).toString('hex').toUpperCase();
                            const now = Date.now();
                            const first = now + (product.paymentFrequency === 'weekly' ? 7 : (product.paymentFrequency === 'biweekly' ? 14 : 30)) * MS_PER_DAY;
                            u.loans = u.loans || {};
                            u.loans[loanId] = {
                                id: loanId, uid, productId: product.id, productName: product.name,
                                amount: amt, interestRate: product.interestRate, interest,
                                processingFee, processingFeePercent: feePercent, penaltyPercent: product.penaltyPercent,
                                netDisbursed, totalRepayment, duration: dur,
                                durationUnit: product.durationUnit, paymentFrequency: product.paymentFrequency,
                                installments, perInstallment, amountPaid: 0,
                                purpose: purpose || '', employment: employment || '',
                                income: Number(income) || 0, occupation: occupation || '',
                                status: 'pending', appliedAt: now, firstInstallmentAt: first,
                                reviewedAt: null, reviewedBy: null, notes: []
                            };
                            await saveUser(uid, u);
                            sendSMS(u.phone, SMS.loanApplied(product.name, amt, loanId), 'loan-' + loanId).catch(() => {});
                            return jsonRes(res, {
                                success: true, loanId, productId: product.id, productName: product.name,
                                amount: amt, interest, processingFee, netDisbursed, totalRepayment,
                                installments, perInstallment, paymentFrequency: product.paymentFrequency,
                                duration: dur, durationUnit: product.durationUnit, status: 'pending'
                            });
                        } catch (e) { return sendError(res, "Loan application error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/loan/list' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${body.uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, body.uid);
                            const loans = Object.values(u.loans || {}).sort((a, b) => (b.appliedAt || 0) - (a.appliedAt || 0));
                            return jsonRes(res, { success: true, loans });
                        } catch (e) { return sendError(res, "Error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/admin/loan/decision' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, 'Unauthorized', 401);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, loanId, decision, reason } = body;
                        if (!uid || !loanId || !decision) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            const loan = u.loans && u.loans[loanId];
                            if (!loan) return sendError(res, "Loan not found", 404);
                            if (decision === 'approved') {
                                const bal = parseFloat(u.balance) || 0;
                                const nb = Number((bal + loan.netDisbursed).toFixed(2));
                                u.balance = nb;
                                u.transactions = u.transactions || {};
                                const txId = 'CITLN-DISB-' + Date.now();
                                u.transactions[txId] = {
                                    id: txId, date: new Date().toISOString(), type: 'deposit',
                                    amount: loan.netDisbursed, narration: `Loan disbursement - ${loan.productName}`,
                                    reference: loanId, status: 'SUCCESS', read: false, newBalance: nb, transactionFee: 0
                                };
                                loan.status = 'active';
                                loan.disbursedAt = Date.now();
                                loan.newBalance = nb;
                                await saveUser(uid, u);
                                sendSMS(u.phone, SMS.loanApproved(loan.productName, loan.amount, loanId), 'loan-app-' + loanId).catch(() => {});
                            } else {
                                loan.status = 'rejected';
                                loan.rejectedAt = Date.now();
                                loan.rejectionReason = reason || 'Not eligible at this time';
                                await saveUser(uid, u);
                                sendSMS(u.phone, SMS.loanRejected(loan.productName, loanId, reason), 'loan-rej-' + loanId).catch(() => {});
                            }
                            audit('LOAN_DECISION', 'admin', uid, { loanId, decision });
                            return jsonRes(res, { success: true, status: loan.status });
                        } catch (e) { return sendError(res, "Error: " + e.message, 500); }
                    }

                    // =====================================================
                    // ========== CARDS / NOTIFICATIONS ====================
                    // =====================================================
                    if (cleanPath === '/api/request-card' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, cardType } = body;
                        if (!uid || !cardType) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            u.cards = u.cards || {};
                            const cardId = 'CARD' + Date.now();
                            u.cards[cardId] = { id: cardId, type: cardType, status: 'pending', requestedAt: Date.now() };
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true, cardId });
                        } catch (e) { return sendError(res, e.message, 500); }
                    }
                    if (cleanPath === '/api/get-cards' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${body.uid}.json?auth=${FIREBASE_SECRET}`);
                        if (!snap.encryptedData) return sendError(res, "User not found", 404);
                        const u = decryptData(snap.encryptedData, body.uid);
                        return jsonRes(res, { success: true, cards: u.cards || {} });
                    }
                    if (cleanPath === '/api/get-notifications' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${body.uid}.json?auth=${FIREBASE_SECRET}`);
                        if (!snap.encryptedData) return sendError(res, "User not found", 404);
                        const u = decryptData(snap.encryptedData, body.uid);
                        const notifications = [];
                        if (u.transactions) {
                            Object.values(u.transactions).forEach(tx => {
                                notifications.push({
                                    id: tx.id,
                                    title: tx.type.charAt(0).toUpperCase() + tx.type.slice(1),
                                    message: tx.type + ' of GHS ' + tx.amount,
                                    date: tx.date, read: tx.read || false
                                });
                            });
                        }
                        return jsonRes(res, { success: true, notifications: notifications.reverse() });
                    }
                    if (cleanPath === '/api/mark-notification-read' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, txId } = body;
                        if (!uid || !txId) return sendError(res, "Missing fields", 400);
                        const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                        if (!snap.encryptedData) return sendError(res, "User not found", 404);
                        const u = decryptData(snap.encryptedData, uid);
                        if (u.transactions && u.transactions[txId]) {
                            u.transactions[txId].read = true;
                            await saveUser(uid, u);
                        }
                        return jsonRes(res, { success: true });
                    }
                    if (cleanPath === '/api/sms-opt-out' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, optOut } = body;
                        if (!uid) return sendError(res, "Missing uid", 400);
                        const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                        if (!snap.encryptedData) return sendError(res, "User not found", 404);
                        const u = decryptData(snap.encryptedData, uid);
                        u.smsOptOut = !!optOut;
                        await saveUser(uid, u);
                        return jsonRes(res, { success: true, smsOptOut: u.smsOptOut });
                    }

                    if (cleanPath === '/api/request-mini-statement' && req.method === 'POST') {
                        if (!rateLimit(ip, 'ministmt', 3, 3600000)) return sendError(res, "Too many requests.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${body.uid}.json?auth=${FIREBASE_SECRET}`);
                        if (!snap.encryptedData) return sendError(res, "User not found", 404);
                        const u = decryptData(snap.encryptedData, body.uid);
                        const txs = Object.values(u.transactions || {}).sort((a, b) => new Date(b.date) - new Date(a.date));
                        await sendSMS(u.phone, SMS.miniStatement(u, txs), 'ministmt-' + body.uid, 60 * 1000);
                        return jsonRes(res, { success: true, message: 'Statement sent via SMS' });
                    }

                    // =====================================================
                    // ========== KYC ======================================
                    // =====================================================
                    if (cleanPath === '/api/kyc/submit' && req.method === 'POST') {
                        if (!rateLimit(ip, 'kycsubmit', 5, 3600000)) return sendError(res, "Too many KYC submissions.", 429);
                        const body = await getBody(req, 30 * 1024 * 1024);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, fullName, dob, idType, idNumber, idFront, idBack, addressProof, selfie } = body;
                        if (!uid || !fullName || !idType || !idNumber || !idFront || !idBack || !addressProof || !selfie)
                            return sendError(res, "Missing required fields", 400);
                        try {
                            const [idFrontUrl, idBackUrl, addressProofUrl, selfieUrl] = await Promise.all([
                                uploadImage(idFront, 'id_front', uid),
                                uploadImage(idBack, 'id_back', uid),
                                uploadImage(addressProof, 'address_proof', uid),
                                uploadImage(selfie, 'selfie', uid)
                            ]);
                            const kycData = {
                                fullName, dob, idType, idNumber,
                                idFront: idFrontUrl, idBack: idBackUrl,
                                addressProof: addressProofUrl, selfie: selfieUrl,
                                status: 'pending', submittedAt: Date.now(), updatedAt: Date.now()
                            };
                            await kycRequest(`/kyc/${uid}`, 'PUT', kycData);
                            try {
                                const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                                if (snap.encryptedData) {
                                    const ud = decryptData(snap.encryptedData, uid);
                                    sendSMS(ud.phone, SMS.kycSubmitted(ud.fullName), 'kyc-sub-' + uid).catch(() => {});
                                }
                            } catch {}
                            return jsonRes(res, { success: true, message: "KYC submitted. Review within 24 hours." });
                        } catch (e) { return sendError(res, "KYC submission error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/kyc/status' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        try {
                            const rec = await kycRequest(`/kyc/${body.uid}`);
                            if (rec && rec.status && rec.status !== 'none')
                                return jsonRes(res, { success: true, status: { status: rec.status, ...rec } });
                            return jsonRes(res, { success: true, status: { status: 'none' } });
                        } catch (e) { return sendError(res, "Error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/admin/kyc' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, 'Unauthorized', 401);
                        try {
                            const kycSnapshot = await kycRequest('/kyc');
                            const kycList = [];
                            if (kycSnapshot && typeof kycSnapshot === 'object') {
                                for (const uid in kycSnapshot) {
                                    const rec = kycSnapshot[uid];
                                    if (rec.status === 'pending') {
                                        let fullName = 'Unknown';
                                        try {
                                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                                            if (snap && snap.encryptedData) {
                                                const u = decryptData(snap.encryptedData, uid);
                                                fullName = u.fullName || fullName;
                                            }
                                        } catch {}
                                        kycList.push({ uid, kyc: rec, fullName });
                                    }
                                }
                            }
                            return jsonRes(res, { success: true, kycList });
                        } catch (e) { return sendError(res, "Admin Error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/admin/kyc/decision' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, 'Unauthorized', 401);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, decision, reason } = body;
                        if (!uid || !decision) return sendError(res, "Missing fields", 400);
                        try {
                            let rec = await kycRequest(`/kyc/${uid}`);
                            if (!rec) rec = { status: 'none' };
                            rec.status = decision;
                            rec.updatedAt = Date.now();
                            rec.reviewedBy = 'admin';
                            if (reason) rec.rejectionReason = reason;
                            await kycRequest(`/kyc/${uid}`, 'PUT', rec);
                            try {
                                const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                                if (snap.encryptedData) {
                                    const ud = decryptData(snap.encryptedData, uid);
                                    if (decision === 'approved') sendSMS(ud.phone, SMS.kycApproved(ud.fullName), 'kyc-app-' + uid).catch(() => {});
                                    else if (decision === 'rejected') sendSMS(ud.phone, SMS.kycRejected(ud.fullName, reason), 'kyc-rej-' + uid).catch(() => {});
                                }
                            } catch {}
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, "Error: " + e.message, 500); }
                    }
                    if (cleanPath === '/api/admin/force-kyc' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, 'Unauthorized', 401);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        try {
                            await kycRequest(`/kyc/${body.uid}`, 'PUT', { status: 'none', resetAt: Date.now() });
                            return jsonRes(res, { success: true });
                        } catch (e) { return sendError(res, "Error: " + e.message, 500); }
                    }

                    // =====================================================
                    // ========== WITHDRAWALS ==============================
                    // =====================================================
                    if (cleanPath === '/api/withdraw/request' && req.method === 'POST') {
                        if (!rateLimit(ip, 'wdreq', 10, 60000)) return sendError(res, "Too many withdrawal attempts.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, amount, pin, momoPhone, momoNetwork } = body;
                        if (!uid || !amount || !pin || !momoPhone || !momoNetwork) return sendError(res, "Missing required fields", 400);

                        const amt = Number(amount);
                        if (isNaN(amt) || amt <= 0) return sendError(res, "Invalid amount", 400);
                        if (amt < 1) return sendError(res, "Minimum withdrawal is GHS 1.00", 400);
                        if (amt > 50000) return sendError(res, "Maximum single withdrawal is GHS 50,000", 400);

                        const num = String(momoPhone).replace(/\D/g, '');
                        if (num.length < 9 || num.length > 12) return sendError(res, "Enter a valid MoMo number", 400);

                        const netKey = String(momoNetwork).toLowerCase();
                        const bankCode = PAYSTACK_NETWORK_CODES[netKey];
                        if (!bankCode) return sendError(res, "Unsupported network. Use MTN, Telecel, or AirtelTigo.", 400);

                        const { fee, totalDebit, label } = calculateWithdrawFee(amt);

                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const userData = decryptData(snap.encryptedData, uid);
                            if (!safeEqual(userData.pin, pin)) return sendError(res, "Invalid PIN", 401);

                            const balance = Number(userData.balance) || 0;
                            if (balance < totalDebit) return sendError(res, `Insufficient balance. You need ${formatMoney(totalDebit)} (incl. ${formatMoney(fee)} fee — ${label}).`, 400);

                            const now = Date.now();
                            const STALE_MS = 10 * 60 * 1000;
                            for (const id in (userData.withdrawalRequests || {})) {
                                const r = userData.withdrawalRequests[id];
                                if (r.status === 'pending' && (now - (r.appliedAt || 0)) > STALE_MS) {
                                    r.status = 'failed';
                                    r.failureReason = 'Auto-expired after 10 minutes';
                                    r.completedAt = now;
                                }
                            }
                            const hasPending = Object.values(userData.withdrawalRequests || {}).some(r => r.status === 'pending');
                            if (hasPending) return sendError(res, "You already have a pending withdrawal. Please wait.", 400);

                            const requestId = 'WDR' + Date.now().toString().slice(-8) + crypto.randomBytes(2).toString('hex').toUpperCase();

                            let recipientCode = userData.paystackRecipients && userData.paystackRecipients[netKey + '_' + num];
                            if (!recipientCode) {
                                try {
                                    const rec = await paystackCreateRecipient({
                                        name: userData.fullName || 'CITFUND User',
                                        accountNumber: num,
                                        bankCode: bankCode,
                                        currency: 'GHS'
                                    });
                                    recipientCode = rec.recipient_code;
                                    userData.paystackRecipients = userData.paystackRecipients || {};
                                    userData.paystackRecipients[netKey + '_' + num] = recipientCode;
                                } catch (e) { return sendError(res, "Could not validate MoMo number: " + e.message, 400); }
                            }

                            let transferData;
                            try {
                                transferData = await paystackInitiateTransfer({
                                    amount: amt,
                                    recipientCode: recipientCode,
                                    reason: 'CITFUND Withdrawal',
                                    reference: requestId,
                                    currency: 'GHS'
                                });
                            } catch (e) { return sendError(res, "Transfer failed: " + e.message, 500); }

                            const newBalance = Number((balance - totalDebit).toFixed(2));
                            userData.balance = newBalance;
                            userData.withdrawalRequests = userData.withdrawalRequests || {};
                            userData.withdrawalRequests[requestId] = {
                                id: requestId, amount: amt, fee: fee, feeTier: label,
                                totalDebit: totalDebit,
                                method: 'paystack', momoNetwork: netKey, momoPhone: num,
                                recipientCode: recipientCode,
                                paystackTransferCode: transferData.transfer_code || null,
                                paystackReference: transferData.reference || requestId,
                                paystackStatus: transferData.status || 'pending',
                                status: 'pending', appliedAt: now
                            };

                            userData.transactions = userData.transactions || {};
                            userData.transactions[requestId] = {
                                id: requestId, type: 'withdraw', amount: amt,
                                fee: fee, feeTier: label, totalDebit: totalDebit,
                                method: 'paystack', momoNetwork: netKey, momoPhone: num,
                                status: 'pending',
                                date: new Date().toISOString(), read: false,
                                newBalance: newBalance
                            };

                            await saveUser(uid, userData);
                            sendSMS(userData.phone, SMS.withdrawRequested(amt, fee, totalDebit, num, requestId, label), 'wd-req-' + requestId).catch(() => {});
                            audit('WITHDRAW_REQ', ip, uid, { requestId, amt, fee });

                            return jsonRes(res, {
                                success: true, requestId,
                                status: transferData.status === 'otp' ? 'otp' : 'pending',
                                fee: fee, feeTier: label, totalDebit: totalDebit,
                                newBalance: newBalance,
                                transferCode: transferData.transfer_code || null,
                                message: 'Withdrawal is being processed'
                            });
                        } catch (e) {
                            console.error('[WITHDRAW]', e);
                            return sendError(res, "Withdrawal request failed: " + e.message, 500);
                        }
                    }

                    if (cleanPath === '/api/withdraw/finalize-otp' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, requestId, otp } = body;
                        if (!uid || !requestId || !otp) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            const rec = u.withdrawalRequests && u.withdrawalRequests[requestId];
                            if (!rec) return sendError(res, "Request not found", 404);
                            if (rec.status !== 'pending') return sendError(res, "Request already processed", 400);
                            const result = await paystackFinalizeTransfer({ transferCode: rec.paystackTransferCode, otp });
                            rec.paystackStatus = result.status;
                            if (['success', 'pending', 'processing'].includes(result.status)) {
                                await saveUser(uid, u);
                                return jsonRes(res, { success: true, status: 'pending' });
                            } else {
                                rec.status = 'failed';
                                rec.failureReason = 'OTP finalization failed';
                                rec.completedAt = Date.now();
                                const refund = Number(rec.totalDebit || rec.amount);
                                u.balance = Number(((Number(u.balance) || 0) + refund).toFixed(2));
                                await saveUser(uid, u);
                                return jsonRes(res, { success: false, status: 'failed', newBalance: u.balance });
                            }
                        } catch (e) { return sendError(res, "OTP finalize failed: " + e.message, 500); }
                    }

                    if (cleanPath === '/api/withdraw/status' && req.method === 'POST') {
                        if (!rateLimit(ip, 'wdstatus', 240, 60000)) return sendError(res, "Too many.", 429);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, requestId } = body;
                        if (!uid || !requestId) return sendError(res, "Missing fields", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            const rec = (u.withdrawalRequests || {})[requestId];
                            if (!rec) return sendError(res, "Request not found", 404);
                            if (rec.status === 'success' || rec.status === 'failed') {
                                return jsonRes(res, { success: true, status: rec.status, newBalance: u.balance, reason: rec.failureReason || null });
                            }
                            try {
                                const v = await paystackVerifyTransfer(rec.paystackReference || requestId);
                                const psStatus = v.status;
                                if (psStatus === 'success') {
                                    rec.status = 'success';
                                    rec.completedAt = Date.now();
                                    rec.paystackStatus = 'success';
                                    const tx = u.transactions && u.transactions[requestId];
                                    if (tx) { tx.status = 'success'; tx.completedAt = new Date().toISOString(); }
                                    await saveUser(uid, u);
                                    sendSMS(u.phone, SMS.withdrawSuccess(rec.amount, rec.momoPhone, u.balance, requestId), 'wd-success-' + requestId).catch(() => {});
                                    return jsonRes(res, { success: true, status: 'success', newBalance: u.balance });
                                }
                                if (psStatus === 'failed' || psStatus === 'reversed') {
                                    const refund = Number(rec.totalDebit || rec.amount);
                                    u.balance = Number(((Number(u.balance) || 0) + refund).toFixed(2));
                                    rec.status = 'failed';
                                    rec.completedAt = Date.now();
                                    rec.failureReason = v.reason || v.gateway_response || ('Transfer ' + psStatus);
                                    rec.paystackStatus = psStatus;
                                    const tx = u.transactions && u.transactions[requestId];
                                    if (tx) { tx.status = 'failed'; tx.failureReason = rec.failureReason; tx.newBalance = u.balance; }
                                    await saveUser(uid, u);
                                    sendSMS(u.phone, SMS.withdrawFailed(rec.amount, rec.failureReason, requestId), 'wd-fail-' + requestId).catch(() => {});
                                    return jsonRes(res, { success: true, status: 'failed', newBalance: u.balance, reason: rec.failureReason });
                                }
                                return jsonRes(res, { success: true, status: 'pending', newBalance: u.balance });
                            } catch (e) {
                                return jsonRes(res, { success: true, status: 'pending', newBalance: u.balance });
                            }
                        } catch (e) { return sendError(res, "Status error: " + e.message, 500); }
                    }

                    if (cleanPath === '/api/withdraw/list' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, "Missing uid", 400);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${body.uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, body.uid);
                            const list = Object.values(u.withdrawalRequests || {})
                                .sort((a, b) => (b.appliedAt || 0) - (a.appliedAt || 0))
                                .slice(0, 20)
                                .map(r => ({
                                    id: r.id, amount: r.amount,
                                    fee: r.fee || 0, feeTier: r.feeTier || null,
                                    total: r.totalDebit || r.amount,
                                    method: 'paystack',
                                    momoNetwork: r.momoNetwork, momoPhone: r.momoPhone,
                                    status: r.status,
                                    date: new Date(r.appliedAt || Date.now()).toISOString()
                                }));
                            return jsonRes(res, { success: true, withdrawals: list });
                        } catch (e) { return sendError(res, "List error: " + e.message, 500); }
                    }

                    if (cleanPath === '/api/admin/clear-pending-get' && req.method === 'GET') {
                        const urlParams = new URL(req.url, 'http://x').searchParams;
                        const uid = urlParams.get('uid');
                        const pin = urlParams.get('pin');
                        if (!uid || pin !== 'CLEAR') return sendError(res, "Unauthorized", 401);
                        try {
                            const snap = await httpsRequest(`${FIREBASE_DB_URL}/users/${uid}.json?auth=${FIREBASE_SECRET}`);
                            if (!snap.encryptedData) return sendError(res, "User not found", 404);
                            const u = decryptData(snap.encryptedData, uid);
                            let cleared = 0;
                            for (const id in (u.withdrawalRequests || {})) {
                                const r = u.withdrawalRequests[id];
                                if (r.status === 'pending') {
                                    r.status = 'failed';
                                    r.failureReason = 'Cleared by admin';
                                    r.completedAt = Date.now();
                                    cleared++;
                                }
                            }
                            await saveUser(uid, u);
                            return jsonRes(res, { success: true, cleared });
                        } catch (e) { return sendError(res, "Clear error: " + e.message, 500); }
                    }

                    // =====================================================
                    // ========== CHAT =====================================
                    // =====================================================
                    if (cleanPath === '/api/chat/list' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, 'Missing uid', 400);
                        await chatEnsureSupportConv(body.uid);
                        const all = await httpsRequest(`${FIREBASE_DB_URL}/chats.json?auth=${FIREBASE_SECRET}`);
                        const convs = [];
                        if (all && typeof all === 'object') {
                            for (const convId in all) {
                                const c = all[convId];
                                if (!chatIsParticipant(c, body.uid)) continue;
                                const msgs = Object.values(c.messages || {}).sort((a, b) => new Date(a.time) - new Date(b.time));
                                const last = msgs.length ? msgs[msgs.length - 1] : null;
                                let unread = 0;
                                msgs.forEach(m => { if (m.senderUid !== body.uid && !m.deleted && !(m.readBy && m.readBy[body.uid])) unread++; });
                                let peerUid, peerName, peerAccount, peerVerified, type;
                                if (c.type === 'support') {
                                    peerUid = CHAT_SUPPORT_UID; peerName = CHAT_SUPPORT_NAME;
                                    peerAccount = null; peerVerified = true; type = 'support';
                                } else {
                                    peerUid = Object.keys(c.participants).find(u => u !== body.uid);
                                    const peer = await chatGetPeerInfo(peerUid);
                                    peerName = peer.name; peerAccount = peer.account; peerVerified = peer.verified;
                                    type = 'direct';
                                }
                                convs.push({
                                    convId, type, peerUid, peerName, peerAccount, peerVerified, unread,
                                    lastMessage: last ? { text: last.text || '', image: !!last.image, senderUid: last.senderUid, time: last.time } : null,
                                    lastTime: last ? new Date(last.time).getTime() : (c.createdAt || 0)
                                });
                            }
                        }
                        convs.sort((a, b) => b.lastTime - a.lastTime);
                        return jsonRes(res, { success: true, conversations: convs });
                    }
                    if (cleanPath === '/api/chat/messages' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, convId } = body;
                        if (!uid || !convId) return sendError(res, 'Missing fields', 400);
                        const conv = await chatGetConv(convId);
                        if (!conv || !chatIsParticipant(conv, uid)) return sendError(res, 'Not found', 404);
                        const msgs = Object.values(conv.messages || {}).sort((a, b) => new Date(a.time) - new Date(b.time));
                        let changed = false;
                        msgs.forEach(m => {
                            if (m.senderUid !== uid && !(m.readBy && m.readBy[uid])) {
                                m.readBy = m.readBy || {}; m.readBy[uid] = true; conv.messages[m.id] = m; changed = true;
                            }
                        });
                        if (changed) await chatPutConv(convId, conv);
                        return jsonRes(res, { success: true, messages: msgs });
                    }
                    if (cleanPath === '/api/chat/send' && req.method === 'POST') {
                        if (!rateLimit(ip, 'chatsend', 60, 60000)) return sendError(res, "Slow down.", 429);
                        const body = await getBody(req, 3 * 1024 * 1024);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, toUid, text, image, replyTo } = body;
                        if (!uid || !toUid) return sendError(res, 'Missing fields', 400);
                        const cleanText = chatSanitizeText(text);
                        const cleanImage = chatSanitizeImage(image);
                        if (!cleanText && !cleanImage) return sendError(res, 'Empty message', 400);
                        if (uid === toUid) return sendError(res, 'Cannot chat with yourself', 400);
                        const convId = chatConvId(uid, toUid);
                        let conv = await chatGetConv(convId);
                        if (!conv) {
                            conv = {
                                participants: { [uid]: true, [toUid]: true },
                                type: toUid === CHAT_SUPPORT_UID ? 'support' : 'direct',
                                createdAt: Date.now(), messages: {}
                            };
                        }
                        const now = chatNowIso();
                        const msgId = chatNewMsgId();
                        const msg = { id: msgId, senderUid: uid, text: cleanText, time: now, readBy: { [uid]: true }, reactions: {} };
                        if (cleanImage) msg.image = cleanImage;
                        if (replyTo && replyTo.text) msg.replyTo = { name: chatSanitizeText(replyTo.name), text: chatSanitizeText(replyTo.text) };
                        conv.messages = conv.messages || {};
                        conv.messages[msgId] = msg;
                        conv.lastMessage = { text: cleanText || '📷 Photo', senderUid: uid, time: now };
                        await chatPutConv(convId, conv);
                        if (toUid === CHAT_SUPPORT_UID) {
                            setTimeout(async () => {
                                try {
                                    const fresh = await chatGetConv(convId);
                                    if (!fresh) return;
                                    const rid = chatNewMsgId();
                                    const rTime = chatNowIso();
                                    const rText = chatGenerateSupportReply(cleanText);
                                    fresh.messages = fresh.messages || {};
                                    fresh.messages[rid] = { id: rid, senderUid: CHAT_SUPPORT_UID, text: rText, time: rTime, readBy: {}, reactions: {} };
                                    fresh.lastMessage = { text: rText, senderUid: CHAT_SUPPORT_UID, time: rTime };
                                    await chatPutConv(convId, fresh);
                                } catch (e) { console.warn('[CHAT reply]', e.message); }
                            }, CHAT_SUPPORT_REPLY_DELAY_MS);
                        }
                        return jsonRes(res, { success: true, messageId: msgId, time: now, convId });
                    }
                    if (cleanPath === '/api/chat/start' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, accountNumber, subject } = body;
                        if (!uid || !accountNumber) return sendError(res, 'Missing fields', 400);
                        const target = await findUserByAccount(String(accountNumber).trim());
                        if (!target) return sendError(res, 'Recipient not found', 404);
                        if (target.uid === uid) return sendError(res, 'Cannot chat with yourself', 400);
                        const convId = chatConvId(uid, target.uid);
                        let conv = await chatGetConv(convId);
                        if (!conv) {
                            const now = chatNowIso();
                            conv = {
                                participants: { [uid]: true, [target.uid]: true },
                                type: 'direct', peerAccount: target.data.accountNumber,
                                createdAt: Date.now(), messages: {}
                            };
                            if (subject) {
                                const mid = chatNewMsgId();
                                conv.messages[mid] = { id: mid, senderUid: uid, text: 'Subject: ' + chatSanitizeText(subject).slice(0, 200), time: now, readBy: { [uid]: true }, reactions: {} };
                                conv.lastMessage = { text: 'Subject: ' + subject, senderUid: uid, time: now };
                            }
                            await chatPutConv(convId, conv);
                        }
                        return jsonRes(res, { success: true, convId, peerUid: target.uid, peerName: target.data.fullName, peerAccount: target.data.accountNumber });
                    }
                    if (cleanPath === '/api/chat/react' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, convId, msgId, emoji } = body;
                        if (!uid || !convId || !msgId || !emoji) return sendError(res, 'Missing fields', 400);
                        const conv = await chatGetConv(convId);
                        if (!conv || !chatIsParticipant(conv, uid)) return sendError(res, 'Not found', 404);
                        const m = conv.messages && conv.messages[msgId];
                        if (!m) return sendError(res, 'Message not found', 404);
                        m.reactions = m.reactions || {};
                        m.reactions[emoji] = m.reactions[emoji] || {};
                        if (m.reactions[emoji][uid]) delete m.reactions[emoji][uid];
                        else m.reactions[emoji][uid] = true;
                        Object.keys(m.reactions).forEach(k => { if (!Object.keys(m.reactions[k]).length) delete m.reactions[k]; });
                        conv.messages[msgId] = m;
                        await chatPutConv(convId, conv);
                        return jsonRes(res, { success: true });
                    }
                    if (cleanPath === '/api/chat/delete' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, convId, msgId } = body;
                        if (!uid || !convId || !msgId) return sendError(res, 'Missing fields', 400);
                        const conv = await chatGetConv(convId);
                        if (!conv || !chatIsParticipant(conv, uid)) return sendError(res, 'Not found', 404);
                        const m = conv.messages && conv.messages[msgId];
                        if (!m) return sendError(res, 'Message not found', 404);
                        if (m.senderUid !== uid) return sendError(res, 'You can only delete your own messages', 403);
                        m.deleted = true; m.text = ''; delete m.image; m.reactions = {};
                        conv.messages[msgId] = m;
                        await chatPutConv(convId, conv);
                        return jsonRes(res, { success: true });
                    }
                    if (cleanPath === '/api/chat/mark-read' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, convId } = body;
                        if (!uid || !convId) return sendError(res, 'Missing fields', 400);
                        const conv = await chatGetConv(convId);
                        if (!conv || !chatIsParticipant(conv, uid)) return sendError(res, 'Not found', 404);
                        let changed = false;
                        Object.values(conv.messages || {}).forEach(m => {
                            if (m.senderUid !== uid && !(m.readBy && m.readBy[uid])) {
                                m.readBy = m.readBy || {}; m.readBy[uid] = true; conv.messages[m.id] = m; changed = true;
                            }
                        });
                        if (changed) await chatPutConv(convId, conv);
                        return jsonRes(res, { success: true });
                    }
                    if (cleanPath === '/api/chat/find-user' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.accountNumber) return sendError(res, 'Missing accountNumber', 400);
                        const found = await findUserByAccount(String(body.accountNumber).trim());
                        if (!found) return jsonRes(res, { success: false, error: 'Not found' });
                        return jsonRes(res, {
                            success: true,
                            user: { fullName: found.data.fullName, accountNumber: found.data.accountNumber, memberID: found.data.memberID }
                        });
                    }
                    if (cleanPath === '/api/chat/unread-count' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, 'Missing uid', 400);
                        const all = await httpsRequest(`${FIREBASE_DB_URL}/chats.json?auth=${FIREBASE_SECRET}`);
                        let total = 0;
                        if (all && typeof all === 'object') {
                            for (const convId in all) {
                                const c = all[convId];
                                if (!chatIsParticipant(c, body.uid)) continue;
                                Object.values(c.messages || {}).forEach(m => {
                                    if (m.senderUid !== body.uid && !m.deleted && !(m.readBy && m.readBy[body.uid])) total++;
                                });
                            }
                        }
                        return jsonRes(res, { success: true, unread: total });
                    }
                    if (cleanPath === '/api/chat/delete-conversation' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, convId } = body;
                        if (!uid || !convId) return sendError(res, 'Missing fields', 400);
                        const conv = await chatGetConv(convId);
                        if (!conv || !chatIsParticipant(conv, uid)) return sendError(res, 'Not found', 404);
                        if (conv.type === 'support') return sendError(res, 'Cannot delete support chat', 400);
                        await httpsRequest(`${FIREBASE_DB_URL}/chats/${convId}.json?auth=${FIREBASE_SECRET}`, { method: 'DELETE' });
                        return jsonRes(res, { success: true });
                    }

                    // =====================================================
                    // ⭐ SUPPORT TICKETS
                    // =====================================================
                    if (cleanPath === '/api/support/tickets/create' && req.method === 'POST') {
                        if (!featureFlags.support_tickets) return sendError(res, 'Support tickets disabled', 403);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, subject, message, priority } = body;
                        if (!uid || !subject || !message) return sendError(res, 'Missing fields', 400);
                        try {
                            const ticketId = 'TICK-' + Date.now().toString(36).toUpperCase();
                            supportTickets.set(ticketId, {
                                id: ticketId, uid,
                                subject: String(subject).slice(0, 120),
                                message: String(message).slice(0, 2000),
                                priority: ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal',
                                status: 'open',
                                createdAt: Date.now(),
                                replies: []
                            });
                            audit('TICKET_CREATE', ip, uid, { ticketId });
                            return jsonRes(res, { success: true, ticketId });
                        } catch (e) { return sendError(res, 'Could not create ticket', 500); }
                    }
                    if (cleanPath === '/api/support/tickets/list' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        if (!body.uid) return sendError(res, 'Missing uid', 400);
                        const list = [];
                        for (const [id, t] of supportTickets) {
                            if (t.uid === body.uid) {
                                list.push({
                                    id: t.id, subject: t.subject, status: t.status,
                                    priority: t.priority, createdAt: t.createdAt,
                                    replyCount: t.replies.length
                                });
                            }
                        }
                        list.sort((a, b) => b.createdAt - a.createdAt);
                        return jsonRes(res, { success: true, tickets: list });
                    }
                    if (cleanPath === '/api/support/tickets/view' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, ticketId } = body;
                        if (!uid || !ticketId) return sendError(res, 'Missing fields', 400);
                        const t = supportTickets.get(ticketId);
                        if (!t || t.uid !== uid) return sendError(res, 'Ticket not found', 404);
                        return jsonRes(res, { success: true, ticket: t });
                    }
                    if (cleanPath === '/api/support/tickets/reply' && req.method === 'POST') {
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, ticketId, message, isStaff } = body;
                        if (!uid || !ticketId || !message) return sendError(res, 'Missing fields', 400);
                        const t = supportTickets.get(ticketId);
                        if (!t) return sendError(res, 'Ticket not found', 404);
                        if (!isStaff && t.uid !== uid) return sendError(res, 'Not found', 404);
                        t.replies.push({
                            by: isStaff ? 'staff' : 'user',
                            message: String(message).slice(0, 2000),
                            at: Date.now()
                        });
                        if (isStaff) {
                            t.status = 'replied';
                            try {
                                const u = await getUserByUid(t.uid);
                                if (u) sendSMS(u.phone, SMS.supportTicketReply(t.id, message), 'ticket-' + t.id).catch(() => {});
                            } catch {}
                        }
                        return jsonRes(res, { success: true });
                    }

                    // =====================================================
                    // ========== ADMIN ====================================
                    // =====================================================
                    if (cleanPath === '/api/admin/reengage-now' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        runReengagementSweep().catch(() => {});
                        return jsonRes(res, { success: true, message: 'Re-engagement sweep triggered' });
                    }
                    if (cleanPath === '/api/admin/audit-log' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        return jsonRes(res, { success: true, log: auditLog.slice(-200).reverse() });
                    }
                    if (cleanPath === '/api/admin/broadcast-sms' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const msg = String(body.message || '').slice(0, 480);
                        if (!msg) return sendError(res, "Missing message", 400);
                        const all = await getAllUsers();
                        let sent = 0, failed = 0;
                        for (const uid in all) {
                            if (!all[uid].encryptedData) continue;
                            try {
                                const u = decryptData(all[uid].encryptedData, uid);
                                if (!u.phone || u.smsOptOut) continue;
                                const r = await sendSMS(u.phone, `${BRAND}\n${msg}\n${SUPPORT_LINE}`, 'broadcast-' + Date.now().toString().slice(0, 6) + '-' + uid);
                                if (r.sent) sent++; else failed++;
                            } catch { failed++; }
                        }
                        audit('BROADCAST', 'admin', '', { sent, failed });
                        return jsonRes(res, { success: true, sent, failed });
                    }

                    // ⭐ ADMIN: System-wide stats
                    if (cleanPath === '/api/admin/stats' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        try {
                            const all = await getAllUsers();
                            let totalUsers = 0, totalBalance = 0, totalTransactions = 0;
                            let totalDeposits = 0, totalWithdrawals = 0;
                            let kycPending = 0, kycApproved = 0;
                            for (const uid in all) {
                                if (!all[uid] || !all[uid].encryptedData) continue;
                                try {
                                    const d = decryptData(all[uid].encryptedData, uid);
                                    totalUsers++;
                                    totalBalance += Number(d.balance) || 0;
                                    const txs = Object.values(d.transactions || {});
                                    totalTransactions += txs.length;
                                    txs.forEach(tx => {
                                        if (tx.type === 'deposit' && tx.status === 'success') totalDeposits += Number(tx.amount) || 0;
                                        if (tx.type === 'withdraw' && tx.status === 'success') totalWithdrawals += Number(tx.amount) || 0;
                                    });
                                } catch {}
                            }
                            try {
                                const kycAll = await kycRequest('/kyc');
                                for (const uid in kycAll) {
                                    if (kycAll[uid].status === 'pending') kycPending++;
                                    if (kycAll[uid].status === 'approved') kycApproved++;
                                }
                            } catch {}
                            return jsonRes(res, {
                                success: true,
                                stats: {
                                    totalUsers, totalBalance: Number(totalBalance.toFixed(2)),
                                    totalTransactions, totalDeposits: Number(totalDeposits.toFixed(2)),
                                    totalWithdrawals: Number(totalWithdrawals.toFixed(2)),
                                    kycPending, kycApproved,
                                    activeSessions: apiSessionTokens.size,
                                    supportTickets: supportTickets.size,
                                    uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000)
                                }
                            });
                        } catch (e) { return sendError(res, 'Stats failed: ' + e.message, 500); }
                    }

                    // ⭐ ADMIN: List users
                    if (cleanPath === '/api/admin/users' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        const body = await getBody(req);
                        const limit = Math.min(Number(body && body.limit) || 50, 500);
                        const search = String(body && body.search || '').toLowerCase();
                        try {
                            const all = await getAllUsers();
                            const users = [];
                            for (const uid in all) {
                                if (!all[uid] || !all[uid].encryptedData) continue;
                                try {
                                    const d = decryptData(all[uid].encryptedData, uid);
                                    if (search) {
                                        const hay = (d.fullName + ' ' + d.email + ' ' + d.phone + ' ' + d.accountNumber + ' ' + d.memberID).toLowerCase();
                                        if (hay.indexOf(search) === -1) continue;
                                    }
                                    users.push({
                                        uid, fullName: d.fullName,
                                        accountNumber: d.accountNumber, memberID: d.memberID,
                                        email: d.email, phone: d.phone,
                                        balance: Number(d.balance) || 0,
                                        createdAt: d.createdAt, lastLogin: (d.loginHistory || []).slice(-1)[0] || null
                                    });
                                } catch {}
                            }
                            users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
                            return jsonRes(res, { success: true, total: users.length, users: users.slice(0, limit) });
                        } catch (e) { return sendError(res, 'Failed', 500); }
                    }

                    // ⭐ ADMIN: User actions (freeze, unfreeze, credit, debit)
                    if (cleanPath === '/api/admin/user-action' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { uid, action, amount, reason } = body;
                        if (!uid || !action) return sendError(res, 'Missing fields', 400);
                        try {
                            const u = await getUserByUid(uid);
                            if (!u) return sendError(res, 'User not found', 404);
                            let result = {};
                            if (action === 'freeze') {
                                u.frozen = true;
                                u.frozenReason = String(reason || '').slice(0, 200);
                                result = { frozen: true };
                            } else if (action === 'unfreeze') {
                                u.frozen = false;
                                delete u.frozenReason;
                                result = { frozen: false };
                            } else if (action === 'credit' || action === 'debit') {
                                const amt = Number(amount);
                                if (isNaN(amt) || amt <= 0) return sendError(res, 'Invalid amount', 400);
                                const bal = Number(u.balance) || 0;
                                if (action === 'debit' && bal < amt) return sendError(res, 'Insufficient balance', 400);
                                u.balance = action === 'credit' ? Number((bal + amt).toFixed(2)) : Number((bal - amt).toFixed(2));
                                u.transactions = u.transactions || {};
                                const txId = 'ADM-' + Date.now();
                                u.transactions[txId] = {
                                    id: txId, type: action === 'credit' ? 'deposit' : 'withdraw',
                                    amount: amt, narration: String(reason || ('Admin ' + action)).slice(0, 120),
                                    status: 'success', date: new Date().toISOString(),
                                    read: false, newBalance: u.balance, transactionFee: 0
                                };
                                result = { newBalance: u.balance };
                            } else {
                                return sendError(res, 'Unknown action', 400);
                            }
                            await saveUser(uid, u);
                            audit('ADMIN_ACTION', 'admin', uid, { action, amount, reason });
                            return jsonRes(res, { success: true, ...result });
                        } catch (e) { return sendError(res, 'Action failed: ' + e.message, 500); }
                    }

                    // ⭐ ADMIN: Feature flags toggle
                    if (cleanPath === '/api/admin/feature-flags' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { flags } = body;
                        if (flags && typeof flags === 'object') {
                            for (const k in flags) {
                                if (Object.prototype.hasOwnProperty.call(featureFlags, k)) {
                                    featureFlags[k] = !!flags[k];
                                }
                            }
                        }
                        audit('FEATURE_FLAGS_UPDATE', 'admin', '', flags);
                        return jsonRes(res, { success: true, features: featureFlags });
                    }

                    // ⭐ ADMIN: Create announcement
                    if (cleanPath === '/api/admin/announcements/create' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const { title, body: abody, level, expiresAt, broadcast } = body;
                        if (!title || !abody) return sendError(res, 'Missing fields', 400);
                        const id = 'ANN-' + Date.now().toString(36).toUpperCase();
                        const ann = {
                            id,
                            title: String(title).slice(0, 120),
                            body: String(abody).slice(0, 1000),
                            level: ['info', 'warning', 'success'].includes(level) ? level : 'info',
                            active: true,
                            createdAt: Date.now(),
                            expiresAt: Number(expiresAt) || null
                        };
                        announcements.push(ann);
                        audit('ANNOUNCEMENT_CREATE', 'admin', id, {});
                        if (broadcast) {
                            const all = await getAllUsers();
                            let sent = 0;
                            for (const uid in all) {
                                if (!all[uid] || !all[uid].encryptedData) continue;
                                try {
                                    const u = decryptData(all[uid].encryptedData, uid);
                                    if (!u.phone || u.smsOptOut) continue;
                                    const r = await sendSMS(u.phone, SMS.announcement(ann.title, ann.body), 'ann-' + id + '-' + uid, 60 * 1000);
                                    if (r.sent) sent++;
                                } catch {}
                            }
                            ann.broadcastCount = sent;
                        }
                        return jsonRes(res, { success: true, announcement: ann });
                    }
                    if (cleanPath === '/api/admin/announcements/list' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        return jsonRes(res, { success: true, announcements });
                    }
                    if (cleanPath === '/api/admin/announcements/toggle' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        const body = await getBody(req);
                        if (body.error) return sendError(res, body.error, 400);
                        const ann = announcements.find(a => a.id === body.id);
                        if (!ann) return sendError(res, 'Not found', 404);
                        ann.active = !ann.active;
                        return jsonRes(res, { success: true, active: ann.active });
                    }

                    // ⭐ ADMIN: Support tickets
                    if (cleanPath === '/api/admin/support/tickets' && req.method === 'POST') {
                        if (!safeEqual(req.headers['x-agent-secret'], AGENT_SECRET)) return sendError(res, "Unauthorized", 401);
                        const list = [];
                        for (const [id, t] of supportTickets) {
                            list.push({
                                id: t.id, uid: t.uid,
                                subject: t.subject, status: t.status,
                                priority: t.priority, createdAt: t.createdAt,
                                replyCount: t.replies.length
                            });
                        }
                        list.sort((a, b) => b.createdAt - a.createdAt);
                        return jsonRes(res, { success: true, tickets: list.slice(0, 100) });
                    }

                    return sendError(res, "API Not Found: " + cleanPath, 404);

                } catch (error) {
                    console.error("API ERROR on " + cleanPath + ":", error.stack || error);
                    return sendError(res, "Internal Server Error: " + (error.message || 'unknown'), 500);
                }
            }

            // =====================================================
            // ========== STATIC FILES =============================
            // =====================================================
            let requestedPath = cleanPath;
            if (requestedPath === '/' || requestedPath === '') requestedPath = '/userlogin.html';
            let filePath = path.join(__dirname, requestedPath);
            if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end("Forbidden"); }
            fs.readFile(filePath, (err, data) => {
                if (err) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('File not found'); }
                let ext = path.extname(filePath).toLowerCase();
                let type = 'text/html';
                if (ext === '.css') type = 'text/css';
                if (ext === '.js') type = 'application/javascript';
                if (ext === '.png') type = 'image/png';
                if (ext === '.jpg' || ext === '.jpeg') type = 'image/jpeg';
                if (ext === '.ico') type = 'image/x-icon';
                if (ext === '.svg') type = 'image/svg+xml';
                if (ext === '.json') type = 'application/json';
                if (type === 'text/html') {
                    let content = data.toString('utf8');
                    const snippet = getSplashSnippet();
                    if (content.includes('</body>')) content = content.replace('</body>', snippet + '</body>');
                    try {
                        const gzipped = zlib.gzipSync(content);
                        res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' });
                        return res.end(gzipped);
                    } catch { res.writeHead(200, { 'Content-Type': type }); return res.end(content); }
                }
                const cacheable = ['.css', '.js', '.png', '.jpg', '.jpeg', '.ico', '.svg'].includes(ext);
                if (cacheable) res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
                else res.writeHead(200, { 'Content-Type': type });
                res.end(data);
            });

        } catch (outerErr) {
            console.error("OUTER ERROR:", outerErr.stack || outerErr);
            try { sendError(res, "Internal Server Error", 500); } catch (e) {}
        }
    }).catch((error) => {
        console.error("Request failed:", error.stack || error);
        try { sendError(res, "Internal Server Error", 500); } catch (e) {}
    });
});

server.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`CITFUND Server v${SERVER_VERSION}`);
    console.log(`Fee Tiers: ${FEE_TIERS.length}`);
    console.log(`Transaction Matrix: ${TX_MATRIX.length} combinations`);
    console.log(`Motivational Phrases: ${MOTIVATIONAL_PHRASES.length}`);
    console.log(`Forgot-Credentials: ENABLED`);
    console.log(`WebAuthn Register + Login: ENABLED`);
    console.log(`Change Password/PIN: ENABLED`);
    console.log(`Beneficiaries, Standing Orders: ENABLED`);
    console.log(`Referrals, Announcements, Support Tickets: ENABLED`);
    console.log(`Admin dashboard: ENABLED`);
    console.log(`Port: ${PORT}`);
    console.log(`========================================`);
});
