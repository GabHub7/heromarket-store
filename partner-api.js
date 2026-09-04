// ══════════════════════════════════════════════════════════════════
// partner-api.js — HeroMarket sebagai PROVIDER untuk web/reseller lain.
//
// Ini kebalikan dari reseller-api.js (yang membuat HeroMarket jadi
// KONSUMEN provider vipibmstore.com). Di sini, web ORANG LAIN yang jadi
// klien, dan HeroMarket yang melayani permintaan mereka: cek saldo partner,
// lihat katalog produk, dan order/beli key -- otomatis, tanpa admin
// HeroMarket perlu input manual sama sekali.
//
// Autentikasi memakai skema HMAC-SHA256 yang SAMA PERSIS dengan yang sudah
// dipakai reseller-api.js (canonical = METHOD\npath\ntimestamp\nnonce\nSHA256(body),
// secretHash = SHA256(apiSecret), signature = HMAC-SHA256(canonical, secretHash))
// supaya partner yang familiar dengan skema vipibmstore.com bisa langsung
// pakai. Header yang dikirim partner:
//   x-api-key, x-timestamp, x-nonce, x-signature
//
// PENTING SOAL KEAMANAN:
// - apiSecret TIDAK PERNAH dikirim di response manapun setelah dibuat
//   (cuma ditampilkan SEKALI saat generate di panel admin).
// - Yang disimpan di partners.json adalah HASH dari secret (SHA256), bukan
//   secret mentah -- sama seperti prinsip password hashing. Kalau
//   partners.json bocor, secret asli tetap tidak bisa dipakai ulang.
// - Nonce dicatat per-partner untuk mencegah replay attack (request yang
//   sama dikirim ulang oleh pihak ketiga yang menyadap traffic).
// - Timestamp harus dalam window 5 menit dari waktu server, mencegah
//   signature lama dipakai berkali-kali.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const SIGNATURE_WINDOW_SECONDS = 5 * 60; // toleransi selisih jam partner vs server
const usedNonces = new Map(); // nonce -> expiresAt(ms) — in-memory, cukup untuk cegah replay dalam window aktif

function cleanupNonces() {
  const now = Date.now();
  for (const [nonce, expiresAt] of usedNonces) {
    if (expiresAt < now) usedNonces.delete(nonce);
  }
}

function hashSecret(apiSecret) {
  return crypto.createHash('sha256').update(apiSecret).digest('hex');
}

// Dipanggil sekali saat admin generate partner baru. secretHash disimpan
// di partners.json; apiSecret mentah HANYA dikembalikan sekali ke admin.
function generateCredentials() {
  const apiKey = 'hm_pk_' + crypto.randomBytes(16).toString('hex');
  const apiSecret = 'hm_sk_' + crypto.randomBytes(24).toString('hex');
  return { apiKey, apiSecret, secretHash: hashSecret(apiSecret) };
}

function sign({ method, path, timestamp, nonce, rawBody, secretHash }) {
  const bodyHash = crypto.createHash('sha256').update(rawBody || '').digest('hex');
  const canonical = [method, path, timestamp, nonce, bodyHash].join('\n');
  return crypto.createHmac('sha256', secretHash).update(canonical).digest('hex');
}

// Express middleware factory. `getPartners` adalah async function yang
// mengembalikan array partners.json TERBARU (readFresh) -- sengaja tidak
// di-cache di sini karena ini jalur uang (partner bisa jadi baru
// dibuat/disuspend admin barusan, harus langsung berlaku).
function verifyPartnerRequest(getPartners) {
  return async (req, res, next) => {
    try {
      const apiKey = req.header('x-api-key');
      const timestamp = req.header('x-timestamp');
      const nonce = req.header('x-nonce');
      const signature = req.header('x-signature');

      if (!apiKey || !timestamp || !nonce || !signature) {
        return res.status(401).json({ success: false, code: 'MISSING_AUTH_HEADERS', message: 'Header x-api-key, x-timestamp, x-nonce, x-signature wajib diisi.' });
      }

      const ts = parseInt(timestamp, 10);
      const now = Math.floor(Date.now() / 1000);
      if (!ts || Math.abs(now - ts) > SIGNATURE_WINDOW_SECONDS) {
        return res.status(401).json({ success: false, code: 'TIMESTAMP_EXPIRED', message: 'Timestamp kadaluarsa atau tidak valid. Pastikan jam server partner sinkron (NTP).' });
      }

      cleanupNonces();
      if (usedNonces.has(nonce)) {
        return res.status(401).json({ success: false, code: 'REPLAY_DETECTED', message: 'Nonce sudah pernah dipakai (kemungkinan replay request).' });
      }

      const partners = await getPartners();
      const partner = partners.find(p => p.apiKey === apiKey);
      if (!partner) {
        return res.status(401).json({ success: false, code: 'INVALID_API_KEY', message: 'API Key tidak dikenali.' });
      }
      if (partner.status !== 'active') {
        return res.status(403).json({ success: false, code: 'PARTNER_SUSPENDED', message: 'Akun partner ini sedang dinonaktifkan. Hubungi admin HeroMarket.' });
      }

      // path yang di-sign HARUS full pathname (konsisten dengan reseller-api.js
      // sisi klien: signPath = url.pathname), bukan cuma bagian setelah prefix.
      const signPath = req.originalUrl.split('?')[0];
      const rawBody = req.method === 'GET' ? '' : (req.rawBodyForSignature || JSON.stringify(req.body || {}));
      const expectedSignature = sign({
        method: req.method,
        path: signPath,
        timestamp,
        nonce,
        rawBody,
        secretHash: partner.secretHash
      });

      // timingSafeEqual mencegah timing attack saat membandingkan signature
      const sigBuf = Buffer.from(signature, 'hex');
      const expBuf = Buffer.from(expectedSignature, 'hex');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return res.status(401).json({ success: false, code: 'INVALID_SIGNATURE', message: 'Signature tidak valid. Cek kembali cara membuat canonical string & API Secret.' });
      }

      usedNonces.set(nonce, Date.now() + SIGNATURE_WINDOW_SECONDS * 1000);
      req.partner = partner;
      next();
    } catch (error) {
      res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan saat verifikasi request.' });
    }
  };
}

module.exports = {
  generateCredentials,
  hashSecret,
  verifyPartnerRequest,
  uuidv4
};
