const express = require('express');
const cookieSession = require('cookie-session');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const multer = require('multer');
const crypto = require('crypto');

// Load .env FIRST before anything reads process.env
require('dotenv').config();

// Fail fast jika SESSION_SECRET tidak di-set di production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET env var wajib di-set di production!');
  process.exit(1);
}

// Warning (bukan fail-fast) jika GensPay belum dikonfigurasi — mode QRIS statis tetap bisa jalan tanpa ini
if (!process.env.GENSPAY_BASE_URL || !process.env.GENSPAY_API_KEY) {
  console.warn('[WARNING] GENSPAY_BASE_URL / GENSPAY_API_KEY belum diset. Mode QRIS API (GensPay) tidak akan berfungsi sampai env var ini diisi.');
}

// Load DB module AFTER dotenv so env vars are available
const db = require('./supabase');
const resellerApi = require('./reseller-api');
const partnerApi = require('./partner-api');
const providerStore = require('./provider-store');
const providerRegistry = require('./providers');

// BUG FIX: `Infinity` dipakai di banyak tempat buat nandain "stok auto/
// unlimited", dan itu AMAN selama nilainya cuma dipakai langsung sebagai
// nilai JS di sisi server (mis. dikirim ke res.render() buat di-render EJS
// langsung). TAPI begitu nilai itu lewat JSON.stringify() -- baik lewat
// res.json() di endpoint API, ATAU lewat <%- JSON.stringify(x) %> yang
// ditempel ke <script> di view -- Infinity SELALU berubah jadi `null`
// (perilaku standar JSON, bukan bug spesifik kita). Akibatnya klien yang
// baca field itu ngira stok = null/habis, padahal harusnya unlimited.
// Solusinya: pas nilai itu MAU dikirim lewat salah satu dari dua jalur di
// atas, ganti Infinity dengan sentinel angka tetap ini (angka besar yang
// nggak masuk akal buat stok sungguhan), dan cek `>= UNLIMITED_STOCK` di
// sisi konsumennya alih-alih `=== Infinity`.
const UNLIMITED_STOCK = 999999;

// ── DUMMY SOLD / "TERJUAL" (tampilan customer saja, BUKAN admin) ───────────
// Angka "Terjual" yang tampil di halaman customer (grid produk / kartu
// populer) sengaja dibuat acak per produk (bukan angka sold asli), supaya
// customer lihat angka penjualan yang meyakinkan dari awal walau produk
// baru/belum ada transaksi asli. Nilai ini di-hardcode sekali per produk
// (disimpan di field product.dummySold) lalu NAIK sedikit tiap kali produk
// itu BENERAN laku, biar angkanya jalan terus & konsisten naik. Angka sold
// ASLI (product.sold) tetap dipakai apa adanya untuk statistik/leaderboard
// & untuk tampilan admin -- tidak disentuh.
function rollInitialDummySold() {
  // Angka awal acak 12–58, biar tiap produk beda dan kelihatan wajar.
  return 12 + Math.floor(Math.random() * 47);
}
function bumpDummySold(product) {
  if (typeof product.dummySold !== 'number') product.dummySold = rollInitialDummySold();
  // Tiap laku beneran, angka "Terjual" ikut naik dikit (1-3) biar natural.
  product.dummySold += 1 + Math.floor(Math.random() * 3);
  return product.dummySold;
}
// Pastikan semua produk di array (in-memory) punya dummySold; return true
// kalau ada yang baru di-generate (berarti caller perlu writeDB).
function ensureDummySold(products) {
  let changed = false;
  products.forEach(p => {
    if (typeof p.dummySold !== 'number') {
      p.dummySold = rollInitialDummySold();
      changed = true;
    }
  });
  return changed;
}

// Hitung stok yang ditampilkan di KARTU produk (grid home/kategori), dipakai
// bareng oleh route '/' dan '/api/products' supaya logic-nya tidak pernah
// diverge lagi antara keduanya.
//
// BUG FIX KRITIS: sebelumnya cuma varian PERTAMA yang stockSource='auto'
// dijadikan representasi stok untuk SELURUH kartu produk. Untuk produk
// 'mixed' (sebagian varian manual dengan stok asli, sebagian auto), kalau
// kebetulan varian auto pertama itu lagi habis di provider, SELURUH kartu
// produk ikut kelihatan "Habis" -- padahal varian lain (mis. 7/30 hari,
// manual, stoknya beneran ada) masih bisa dibeli normal begitu customer
// klik masuk halaman detail. Customer jadi tidak pernah klik masuk sama
// sekali karena sudah kelanjur lihat "Habis" di kartu.
//
// Sekarang: cek SEMUA varian, kartu dianggap "ada stok" kalau MINIMAL SATU
// varian tersedia (manual dengan key tersisa, ATAU auto dengan stok real
// > 0 / unlimited) -- konsisten dengan logic per-varian yang sudah benar
// di halaman /buy/:id (lihat variantStockSource di route itu).
async function computeProductCardStock(settings, product) {
  const opts = Array.isArray(product.pricingOptions) && product.pricingOptions.length > 0
    ? product.pricingOptions
    : [{ days: null, stockSource: product.stockMode === 'auto' ? 'auto' : 'manual' }];

  const keys = product.keys || [];
  let anyAvailable = false;
  let bestManualCount = 0;

  for (const opt of opts) {
    if (opt.stockSource === 'auto') {
      const realStock = await resellerApi.getRealStockForProduct(settings, product, opt.days);
      // 'unlimited' atau 'unknown' (gagal resolve/network) dianggap TERSEDIA
      // -- fallback aman, jangan salah tampil "Habis" karena masalah sementara.
      if (realStock.stockMode !== 'limited' || realStock.stock > 0) anyAvailable = true;
    } else {
      const dayKeys = opt.days
        ? keys.filter(k => { const parts = k.split(':'); return parts.length > 1 && parseInt(parts[parts.length - 1]) === opt.days; })
        : [];
      const genericCount = keys.filter(k => !k.includes(':')).length;
      const count = dayKeys.length > 0 ? dayKeys.length : genericCount;
      if (count > 0) anyAvailable = true;
      bestManualCount = Math.max(bestManualCount, count);
    }
  }

  // Angka yang ditampilkan: kalau ada varian auto yang tersedia, tampilkan
  // "Tersedia" (UNLIMITED_STOCK) -- representasi paling optimis & akurat
  // (provider bisa restock kapan saja). Kalau semua varian manual,
  // tampilkan jumlah key manual terbanyak di antara varian.
  if (!anyAvailable) return 0;
  const hasAvailableAuto = opts.some(o => o.stockSource === 'auto');
  return hasAvailableAuto ? UNLIMITED_STOCK : bestManualCount;
}

const app = express();
const PORT = process.env.PORT || 3000;

// ── PERFORMANCE: Simple in-memory cache untuk API publik yang sering diakses ──
const _cache = new Map();
const cacheGet = (key) => {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { _cache.delete(key); return null; }
  return entry.val;
};
const cacheSet = (key, val, ttlMs = 10000) => _cache.set(key, { val, exp: Date.now() + ttlMs });
const cacheInvalidate = (prefix) => { for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k); };

// Rate limiting untuk QR Code
const qrRateLimit = new Map();
const QR_RATE_LIMIT = 30;
const QR_RATE_WINDOW = 60000;

// Rate limiting untuk login (brute force protection)
const loginFailMap = new Map();
const LOGIN_MAX_FAIL = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 menit

const checkLoginBlocked = (ip) => {
  const rec = loginFailMap.get(ip);
  if (!rec) return { blocked: false };
  if (Date.now() > rec.resetAt) { loginFailMap.delete(ip); return { blocked: false }; }
  return { blocked: rec.count >= LOGIN_MAX_FAIL, wait: Math.ceil((rec.resetAt - Date.now()) / 60000) };
};

const recordLoginFail = (ip) => {
  const now = Date.now();
  const rec = loginFailMap.get(ip);
  if (!rec || now > rec.resetAt) loginFailMap.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else { rec.count++; loginFailMap.set(ip, rec); }
};

const clearLoginFail = (ip) => loginFailMap.delete(ip);

// API rate limiting untuk endpoint publik
const apiRateMap = new Map();
const checkApiRateLimit = (ip, limit = 60, windowMs = 60000) => {
  const now = Date.now();
  const rec = apiRateMap.get(ip);
  if (!rec || now > rec.resetAt) {
    apiRateMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (rec.count >= limit) return false;
  rec.count++;
  return true;
};

// Lock set untuk mencegah race condition pada alokasi key
const processingOrders = new Set();

// Cache singkat hasil checkPaymentStatus per order_id, supaya browser
// pembeli yang polling /check-payment tiap beberapa detik TIDAK memicu 1
// request baru ke GensPay tiap kali. Tanpa ini, N pembeli yang lagi
// nunggu QR bersamaan = N request/beberapa detik ke GensPay dari IP
// server yang SAMA -- dari sudut pandang GensPay itu kelihatan seperti
// polling agresif dari 1 sumber (persis pola yang mereka larang di
// pemberitahuan resmi Agustus 2026, yang berujung blokir IP). Cache ini
// membuat panggilan AKTUAL ke GensPay per order_id dibatasi sekali per
// GENSPAY_STATUS_CACHE_TTL_MS, terlepas berapa kali browser polling.
const genspayStatusCache = new Map(); // order_id -> { result, expiresAt }
const GENSPAY_STATUS_CACHE_TTL_MS = 3000;

async function checkPaymentStatusCached(orderId, amount, settings) {
  const cached = genspayStatusCache.get(orderId);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error) throw cached.error;
    return cached.result;
  }
  try {
    const result = await checkPaymentStatus(orderId, amount, settings);
    genspayStatusCache.set(orderId, { result, error: null, expiresAt: Date.now() + GENSPAY_STATUS_CACHE_TTL_MS });
    return result;
  } catch (e) {
    // FIX: error juga WAJIB di-cache -- kalau tidak, tiap polling
    // berikutnya (4 detik kemudian) langsung coba lagi ke GensPay tanpa
    // ada efek throttle sama sekali, justru di saat paling penting
    // (GensPay sedang bermasalah/lambat, request retry-storm bisa
    // memperparah).
    genspayStatusCache.set(orderId, { result: null, error: e, expiresAt: Date.now() + GENSPAY_STATUS_CACHE_TTL_MS });
    throw e;
  } finally {
    // Housekeeping ringan: buang entri kadaluarsa sesekali supaya Map ini
    // tidak numpuk tanpa batas kalau ada banyak order_id unik (setiap
    // transaksi QRIS punya order_id sendiri-sendiri, tidak pernah dipakai
    // ulang). Cukup murah untuk dijalankan tiap panggilan -- Map ini
    // realistisnya cuma berisi order pending yang masih aktif dipolling
    // (skala puluhan, bukan jutaan).
    if (genspayStatusCache.size > 500) {
      const now = Date.now();
      for (const [key, val] of genspayStatusCache) {
        if (val.expiresAt <= now) genspayStatusCache.delete(key);
      }
    }
  }
}

const checkQrRateLimit = (ip) => {
  const now = Date.now();
  const record = qrRateLimit.get(ip);
  if (record) {
    const windowStart = now - QR_RATE_WINDOW;
    const recentRequests = record.filter(ts => ts > windowStart);
    if (recentRequests.length >= QR_RATE_LIMIT) {
      return false;
    }
    recentRequests.push(now);
    qrRateLimit.set(ip, recentRequests);
  } else {
    qrRateLimit.set(ip, [now]);
  }
  return true;
};

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.set('trust proxy', 1);

// ── SECURITY: HTTP security headers (manual, tanpa dependency tambahan) ──
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '0'); // header lama, browser modern pakai CSP
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
});

// ── SECURITY: global rate limit untuk mitigasi DDoS / flood request ──
// Limit kasar per-IP di semua endpoint, di atas rate-limit spesifik yang sudah ada
const globalRateMap = new Map();
const GLOBAL_RATE_LIMIT = 240;       // maksimal request per window
const GLOBAL_RATE_WINDOW = 60000;    // per 1 menit
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of globalRateMap) if (now > rec.resetAt) globalRateMap.delete(ip);
}, 5 * 60000).unref?.();

app.use((req, res, next) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let rec = globalRateMap.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 1, resetAt: now + GLOBAL_RATE_WINDOW };
    globalRateMap.set(ip, rec);
  } else {
    rec.count++;
  }
  if (rec.count > GLOBAL_RATE_LIMIT) {
    return res.status(429).json({ success: false, message: 'Terlalu banyak permintaan dari IP ini. Coba lagi sebentar.' });
  }
  next();
});

// FIX: GensPay's webhook signature must be computed over the EXACT raw
// bytes they sent -- but express.json() below only engages its `verify`
// callback (which sets req.rawBodyForSignature) when the request's
// Content-Type header matches "application/json" closely enough. If
// GensPay's webhook sender omits Content-Type, or sends a variant
// express.json() doesn't recognize (not unusual for smaller/simpler
// gateway integrations), express.json() silently skips parsing
// entirely -- rawBodyForSignature never gets set, req.body stays `{}`,
// and /webhook/genspay's signature check falls back to hashing
// JSON.stringify({}) == "{}", which can never match GensPay's real
// signature. Every webhook call would then fail with 401, 100% of the
// time, regardless of anything else being configured correctly.
//
// This dedicated capture runs BEFORE the global express.json() below and
// reads the body as raw bytes unconditionally (type: '*/*'), independent
// of whatever Content-Type header is (or isn't) present. The real
// handler logic still lives at POST /webhook/genspay further down this
// file -- this only guarantees rawBodyForSignature/req.body are already
// correctly populated by the time execution reaches it.
app.post('/webhook/genspay', express.raw({ type: '*/*', limit: '1mb' }), (req, res, next) => {
  req.rawBodyForSignature = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  try {
    req.body = req.rawBodyForSignature ? JSON.parse(req.rawBodyForSignature) : {};
  } catch (e) {
    req.body = {};
  }
  next();
});

// Sama seperti fix GensPay di atas -- Binance Pay (RSA signature) butuh RAW
// bytes persis buat verifikasi signature webhook: capture raw body sebelum
// express.json() sempat mem-parsingnya ulang.
app.post('/webhook/binancepay', express.raw({ type: '*/*', limit: '1mb' }), (req, res, next) => {
  req.rawBodyForSignature = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  try {
    req.body = req.rawBodyForSignature ? JSON.parse(req.rawBodyForSignature) : {};
  } catch (e) {
    req.body = {};
  }
  next();
});

app.use(expressLayouts);
// Body size limit — cegah payload raksasa yang bisa membebani server (DoS)
// verify: simpan raw body mentah (Buffer -> string) SEBELUM di-parse jadi
// object. Dibutuhkan oleh partner-api.js untuk verifikasi HMAC signature --
// signature partner dihitung dari bytes JSON yang persis mereka kirim, jadi
// kalau kita hash hasil JSON.stringify(req.body) yang sudah di-parse ulang
// (urutan key bisa berubah, whitespace beda), signature akan selalu mismatch.
//
// type: skip /webhook/genspay entirely here -- its body was already
// consumed and parsed by the dedicated express.raw() middleware above,
// and an HTTP request stream can only be read once. Letting this run
// again on that path would read 0 remaining bytes and silently stomp
// the correct req.body/rawBodyForSignature already set above with empty
// ones.
//
// BUG FIX: this used to be `type: (req) => req.path !== '/webhook/genspay'`
// -- ONLY checking the path. When `type` is a function, body-parser uses
// ONLY that function's return value to decide whether to attempt JSON
// parsing -- it does NOT also fall back to checking Content-Type like
// the default string/glob form does. That meant EVERY request other than
// the webhook (including a plain HTML form POST like /login, sent as
// application/x-www-form-urlencoded) got force-parsed as JSON regardless
// of its real Content-Type -- which throws a JSON syntax error on any
// non-JSON body, producing Express's bare "Bad Request" 400 page with no
// styling. Restored the Content-Type check alongside the path exclusion,
// so this now behaves exactly like the original default (only parse
// application/json bodies) PLUS the webhook exclusion, instead of
// replacing the Content-Type check entirely.
const RAW_BODY_WEBHOOK_PATHS = new Set(['/webhook/genspay', '/webhook/binancepay']);
app.use(express.json({
  limit: '1mb',
  type: (req) => !RAW_BODY_WEBHOOK_PATHS.has(req.path) && (req.headers['content-type'] || '').includes('application/json'),
  verify: (req, res, buf) => { req.rawBodyForSignature = buf.toString('utf8'); }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// Static assets: cache di browser 7 hari agar tidak di-download ulang tiap kunjungan
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true }));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads'), { maxAge: '7d', etag: true }));
app.use('/uploads/avatars', express.static(path.join(__dirname, 'public/uploads/avatars'), { maxAge: '7d', etag: true }));

app.use(cookieSession({
  name: 'hm_session',
  secret: process.env.SESSION_SECRET || 'hero-market-dev-only-not-for-prod',
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));

// Setup upload — gunakan /tmp di Vercel (satu-satunya writable path)
const isVercel = process.env.VERCEL === '1' || process.env.NOW_REGION;
const uploadsBase = isVercel ? '/tmp' : path.join(__dirname, 'public', 'uploads');
const uploadsDir = isVercel ? '/tmp/products' : path.join(__dirname, 'public', 'uploads', 'products');

// Buat direktori lokal hanya jika bukan Vercel
if (!isVercel) {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = isVercel ? '/tmp/products' : path.join(__dirname, 'public', 'uploads', 'products');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Hanya file gambar yang diizinkan'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter
});

// Database helpers (Supabase)
const dbPath = path.join(__dirname, 'database');
if (!isVercel && !fs.existsSync(dbPath)) fs.mkdirSync(dbPath, { recursive: true });

const readDB = db.readDB;
const writeDB = db.writeDB;
const readFresh = db.readFresh;
const readSmart = db.readSmart; // TTL-based: auto-refresh jika cache >8 detik
const updateCollectionAtomic = db.updateCollectionAtomic; // optimistic concurrency (lihat komentar di supabase.js)
const refreshForWrite = (...files) => Promise.all(files.map(f => db.refreshFromDB(f)));

// Inject settings + isAdmin ke semua view otomatis
// FIX: sebelumnya pakai readDB() yang MURNI baca cache in-memory tanpa refresh
// apapun. Di Vercel serverless, tiap request bisa kena instance/lambda yang
// beda-beda -- kalau instance itu belum pernah nge-load settings (cold start)
// atau cache-nya sudah lama, perubahan yang barusan disimpan admin (misal ganti
// mode NOWPayments, ganti QRIS, dll) TIDAK akan kelihatan sampai
// instance itu di-restart, padahal writeDB sudah sukses ke Supabase. Sekarang
// pakai readSmart() yang otomatis re-fetch dari Supabase begitu cache di
// instance ini sudah > 30 detik (lihat CACHE_TTL di supabase.js) -- jadi
// perubahan dari panel admin akan nyampe ke semua instance dalam <=30 detik,
// bukan tersimpan-tapi-tidak-kepakai selamanya.
app.use(async (req, res, next) => {
  try {
    res.locals.settings = await readSmart('settings.json');
  } catch (e) {
    res.locals.settings = readDB('settings.json'); // fallback cache lama kalau Supabase lagi down
  }
  res.locals.isAdmin = req.session?.isAdmin || false;
  next();
});

// Initialize database files with defaults (only if truly missing)
const initDB = async () => {
  const defaultSettings = {
    siteName: 'HERO MARKET',
    gamePanelName: 'HERO MARKET',
    about: 'HERO MARKET menyediakan layanan topup games dan key mod aplikasi premium terbaik #1 indonesia.',
    marqueeText: 'LAYANAN GAME MOD MENU PREMIUM - PROSES CEPAT & AMAN',
    contact: { whatsapp: '6281235690535', telegram: 'HEROO3STORE', email: 'support@heromarket.com' },
    adminUsername: process.env.ADMIN_USERNAME || 'heromarket',
    adminPassword: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'sumberjo1903', 12),
    categories: [],
    categoryLabels: {},
    resellerEnabled: true,
    resellerPrice: 50000,
    resellerDiscount: 20,
    resellerNote: 'Dapatkan diskon eksklusif untuk semua produk!',
    popularProductIds: []
  };

  const arrayFiles = ['users.json', 'products.json', 'transactions.json', 'testimonials.json', 'notifications.json', 'keyspool.json', 'vouchers.json'];

  // Seed arrays only if they don't exist at all (null/undefined, NOT empty array)
  for (const filename of arrayFiles) {
    const current = readDB(filename);
    if (!Array.isArray(current)) {
      await writeDB(filename, []);
    }
  }

  // Seed settings only if completely empty (no keys)
  const currentSettings = readDB('settings.json');
  if (!currentSettings || Object.keys(currentSettings).length === 0) {
    if (!process.env.ADMIN_PASSWORD) {
      console.warn('⚠️  PERINGATAN KEAMANAN: ADMIN_PASSWORD env var belum di-set!');
      console.warn('⚠️  Password admin default akan dipakai — GANTI SEGERA lewat panel admin setelah login.');
    }
    await writeDB('settings.json', defaultSettings);
  } else if (process.env.ADMIN_USERNAME || process.env.ADMIN_PASSWORD) {
    // SECURITY: hanya update kredensial admin dari env var JIKA env var benar-benar di-set.
    // Jangan pernah reset ke password hardcoded default — itu bisa menimpa password
    // custom yang sudah diganti admin lewat panel, dan password default dikenal publik.
    //
    // BUG FIX: sebelumnya, kalau env var ADMIN_PASSWORD di hosting (Vercel dkk) masih
    // nilai LAMA (belum sempat diupdate admin di dashboard hosting), ganti password
    // lewat panel admin akan "berhasil" sesaat tapi ke-TIMPA BALIK ke password lama
    // begitu server cold-start ulang (Vercel serverless sering restart setelah idle,
    // initDB() ini jalan lagi tiap cold start). Sekarang: kalau kredensial sudah
    // pernah di-custom manual lewat panel admin (flag credentialsCustomized), env var
    // TIDAK PERNAH dipakai lagi untuk override -- database jadi satu-satunya sumber
    // kebenaran seterusnya. Env var cuma efektif untuk SETUP AWAL (sebelum admin
    // pernah ganti apa-apa lewat panel).
    if (currentSettings.credentialsCustomized) {
      // Kredensial sudah di-custom manual -- jangan sentuh, biarpun env var beda.
    } else {
    const adminUser = process.env.ADMIN_USERNAME || currentSettings.adminUsername;
    const adminPass = process.env.ADMIN_PASSWORD;
    let needsUpdate = false;
    if (process.env.ADMIN_USERNAME && currentSettings.adminUsername !== adminUser) needsUpdate = true;
    if (adminPass && !bcrypt.compareSync(adminPass, currentSettings.adminPassword || '')) needsUpdate = true;
    if (needsUpdate) {
      currentSettings.adminUsername = adminUser;
      if (adminPass) currentSettings.adminPassword = bcrypt.hashSync(adminPass, 12);
      await writeDB('settings.json', currentSettings);
    }
    }
  }
};

// Vercel: export app langsung (Vercel tidak pakai app.listen)
// Lokal: jalankan server setelah DB siap
if (isVercel) {
  // Di Vercel, DB diinit per-request (cold start) - export app dulu
  db.initializeDB().then(() => initDB()).catch(err => console.error('DB init error:', err));
  module.exports = app;
} else {
  // Lokal / VPS: tunggu DB siap baru listen
  db.initializeDB().then(() => {
    initDB(); // seed defaults only if missing
    app.listen(PORT, () => {
      console.log(`✅ Server berjalan di http://localhost:${PORT}`);
      console.log(`📁 Database: ${dbPath}`);
      console.log(`🔐 Admin: /admin`);
    });
  }).catch(err => {
    console.error('Fatal: Failed to initialize database:', err);
    process.exit(1);
  });
  module.exports = app;
}

// Helper: dapatkan user dari session (support admin yang tidak ada di users.json)
const getSessionUser = (req) => {
  if (req.session?.isAdmin) {
    const s = readDB('settings.json');
    return { id: 'admin', username: s.adminUsername || 'Admin', isAdmin: true, photo: null, role: 'admin', is_reseller: false };
  }
  if (req.session?.userId) return readDB('users.json').find(u => u.id === req.session.userId) || null;
  return null;
};

// Auth middleware
const requireAuth = (req, res, next) => {
  if (!req.session?.userId) {
    if (req.xhr || req.headers['content-type']?.includes('application/json')) {
      return res.json({ success: false, message: 'Silakan login terlebih dahulu', redirect: '/login' });
    }
    // FIX: sebelumnya link produk/transaksi yang di-share ke customer (mis. via
    // WhatsApp/Telegram) langsung redirect ke /login TANPA render apapun kalau
    // sesi customer expired/beda device -- ini bikin preview link jadi kosong
    // (bot preview tidak punya cookie session) dan customer bingung "gak bisa
    // dipencet" karena link diam-diam bounce ke halaman lain. redirect= sudah
    // otomatis dipakai balik oleh halaman login (lihat req.body.redirect di
    // POST /login) supaya user balik ke halaman tujuan setelah login berhasil.
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session?.isAdmin) {
    return res.status(403).send('Access denied');
  }
  next();
};

// Helper functions
const generateOrderCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 karakter, tanpa 0/O/1/I yang rawan salah baca
  const randomBytes = crypto.randomBytes(8); // CSPRNG, bukan Math.random()
  let code = 'HM-';
  for (let i = 0; i < 4; i++) code += chars[randomBytes[i] % chars.length];
  code += '-';
  for (let i = 4; i < 8; i++) code += chars[randomBytes[i] % chars.length];
  return code;
};

const formatDate = (date = new Date()) => {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
};

// ── Gabungkan base URL (yang mungkin punya subpath, mis. https://host.com/api/v1) dengan path tambahan
// tanpa menghapus subpath tersebut — beda dari new URL(path, base) yang selalu absolute dari root.
function joinUrlPath(baseUrl, extraPath) {
  const base = baseUrl.replace(/\/+$/, '');
  const extra = extraPath.replace(/^\/+/, '');
  return `${base}/${extra}`;
}

// ── GensPay API (genspay.my.id) ──
// Konfigurasi murni lewat environment variable, tidak perlu Merchant ID / Project ID.

// Dipakai buat bangun callback_url per-request -- sama persis polanya kayak
// baseUrl NOWPayments di bawah (`${req.protocol}://${req.get('host')}`),
// biar konsisten otomatis ikut domain aktif (custom domain, staging, dst)
// tanpa perlu env var terpisah tiap ganti domain. Fallback ke APP_URL cuma
// buat jalur /admin/qris/test yang tidak selalu punya req representatif.
const getAppBaseUrl = (req) => {
  if (req) return `${req.protocol}://${req.get('host')}`;
  return (process.env.APP_URL || '').trim().replace(/\/+$/, '');
};
// FIX (same root cause confirmed in gneseller/ghostseller): this never sent
// callback_url on ANY request before this fix -- NOWPayments' webhook two
// integrations down (search ipn_callback_url) already does this correctly,
// GensPay's just never got it. Without callback_url, GensPay has nowhere to
// POST the transaction.updated event to, so /webhook/genspay above never
// fires at all -- the only thing completing paid transactions is the
// customer's own browser polling /check-payment while the QR modal is still
// open. If they close the tab, switch apps, or the payment settles after
// they've moved on, nothing ever marks it paid automatically -- hence
// needing an admin to manually verify/complete it. Callback_url is now
// required (2nd param) rather than silently optional, so this can't
// regress back to being forgotten at a new call site later.
const createQRISPayment = (orderId, amount, settings, callbackUrl) => {
  return new Promise((resolve, reject) => {
    const baseUrl = (process.env.GENSPAY_BASE_URL || '').trim();
    const apiKey = (process.env.GENSPAY_API_KEY || '').trim();
    if (!baseUrl || !apiKey) return reject(new Error('GENSPAY_BASE_URL atau GENSPAY_API_KEY belum diset di environment variable'));
    if (!callbackUrl) return reject(new Error('callbackUrl wajib diisi -- lihat komentar FIX di atas createQRISPayment.'));

    let url;
    try { url = new URL(joinUrlPath(baseUrl, '/transaction/create')); } catch (e) { return reject(new Error('GENSPAY_BASE_URL tidak valid')); }

    // FIX (docs GensPay terbaru): body wajib menyertakan payment_method: "qris"
    // -- sebelumnya cuma {amount, order_id} tanpa payment_method, sesuai docs lama.
    const body = JSON.stringify({ amount, order_id: orderId, payment_method: 'qris', callback_url: callbackUrl });
    const req = https.request({
      hostname: url.hostname, port: url.port || 443,
      path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          const qr = r.data?.qr_string;
          // FIX (docs GensPay terbaru): response gagal pakai field {error: "..."},
          // bukan {message: "..."} -- sebelumnya cuma baca r.message jadi pesan
          // error asli dari GensPay (mis. "Minimum amount is Rp 1.000", "Order ID
          // already exists for this project") tidak pernah kelihatan, cuma fallback
          // generik "GensPay error (HTTP xxx): ...".
          if (!r.success || !qr) return reject(new Error(r.error || r.message || `GensPay error (HTTP ${res.statusCode}): ${data.slice(0,150)}`));
          resolve({ qr_string: qr, total_payment: r.data?.amount || amount, expired_at: r.data?.expiry_time || null });
        } catch(e) { reject(new Error(`Gagal parse response GensPay (HTTP ${res.statusCode}): ${data.slice(0,200) || '(response kosong)'}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('GensPay timeout')); });
    req.on('error', e => reject(new Error('Network error: ' + e.message)));
    req.write(body); req.end();
  });
};

const checkPaymentStatus = (orderId, amount, settings) => {
  return new Promise((resolve, reject) => {
    const baseUrl = (process.env.GENSPAY_BASE_URL || '').trim();
    const apiKey = (process.env.GENSPAY_API_KEY || '').trim();
    if (!baseUrl || !apiKey) return reject(new Error('GENSPAY_BASE_URL atau GENSPAY_API_KEY belum diset di environment variable'));

    let url;
    try { url = new URL(joinUrlPath(baseUrl, `/transaction/${encodeURIComponent(orderId)}/status`)); } catch (e) { return reject(new Error('GENSPAY_BASE_URL tidak valid')); }

    const req = https.request({
      hostname: url.hostname, port: url.port || 443,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'X-API-Key': apiKey },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Gagal parse response status')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('GensPay status timeout')); });
    req.on('error', e => reject(new Error('Network error: ' + e.message)));
    req.end();
  });
};

// ── Self-test: simulasikan webhook GensPay untuk order_id yang beneran macet ──
// Membuktikan (bukan menebak) apakah KODE webhook sudah benar, dengan
// membangun payload yang persis sama bentuknya + signature valid seperti
// yang GensPay kirim beneran, lalu memanggil endpoint /webhook/genspay
// yang ASLI (bukan tiruan) via HTTP internal ke diri sendiri. Kalau ini
// berhasil (order jadi 'done' + saldo/key ke-deliver), kode webhook
// TERBUKTI benar -- sisa masalah cuma di pengiriman dari GensPay
// (registrasi URL webhook di dashboard/Telegram bot mereka), bukan bug
// aplikasi. Kalau gagal, dapat error konkret yang reproducible.
//
// Dilindungi GENSPAY_DEBUG_SECRET (bukan requireAdmin) supaya bisa dites
// langsung dari browser HP tanpa perlu login admin dulu.
// Browser-openable: lihat detail lengkap kenapa signature webhook GensPay
// gagal, tanpa perlu buka Vercel Runtime Logs. Usage:
// GET /debug/genspay-webhook-log?secret=X
app.get('/debug/genspay-webhook-log', async (req, res) => {
  const debugSecret = (process.env.GENSPAY_DEBUG_SECRET || '').trim();
  if (!debugSecret) return res.status(503).json({ error: 'not_configured' });
  if (req.query.secret !== debugSecret) return res.status(401).json({ error: 'unauthorized' });

  const log = await readFresh('webhook_debug_log.json').catch(() => []);
  res.json({
    count: Array.isArray(log) ? log.length : 0,
    entries: log,
    note: (!Array.isArray(log) || log.length === 0)
      ? "Kosong -- belum ada percobaan webhook yang gagal signature sejak fix ini di-deploy. Coba lagi setelah ada transaksi baru dibayar."
      : undefined,
  });
});

app.get('/debug/genspay-resettle', async (req, res) => {
  const debugSecret = (process.env.GENSPAY_DEBUG_SECRET || '').trim();
  if (!debugSecret) return res.status(503).json({ error: 'not_configured', message: 'GENSPAY_DEBUG_SECRET belum diisi di environment variable.' });
  if (req.query.secret !== debugSecret) return res.status(401).json({ error: 'unauthorized' });

  let orderId = req.query.order_id;
  const transactionsForPick = await readFresh('transactions.json');
  if (!orderId) {
    // Ga perlu cari manual -- ambil otomatis transaksi 'pending' PALING LAMA
    // yang masih nyangkut lewat GensPay (isStatic false = QRIS API, bukan QRIS
    // statis manual-verify-only; qrString = benar-benar dibuatkan GensPay).
    const candidates = transactionsForPick
      .filter(t => t.status === 'pending' && t.isStatic === false && t.qrString)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (candidates.length === 0) {
      return res.json({ ok: true, message: "Ga ada transaksi 'pending' via GensPay QRIS API sama sekali -- ga ada yang perlu diselesaikan." });
    }
    orderId = candidates[0].orderId;
  }

  const apiKey = (process.env.GENSPAY_API_KEY || '').trim();
  if (!apiKey) return res.status(500).json({ error: 'no_api_key' });

  const body = JSON.stringify({
    event: 'transaction.updated',
    data: { order_id: orderId, status: 'SUCCESS' },
    timestamp: new Date().toISOString(),
  });
  const signature = crypto.createHash('sha256').update(body + apiKey).digest('hex');

  try {
    const result = await new Promise((resolve, reject) => {
      const url = new URL(`${req.protocol}://${req.get('host')}/webhook/genspay`);
      const lib = url.protocol === 'https:' ? require('https') : require('http');
      const r = lib.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GensPay-Signature': signature, 'Content-Length': Buffer.byteLength(body) },
      }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve({ status: resp.statusCode, body: data }));
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });

    const transactions = await readFresh('transactions.json');
    const tx = transactions.find(t => t.orderId === orderId);

    res.json({
      ok: result.status === 200,
      resolvedOrderId: orderId,
      simulatedWebhookHttpStatus: result.status,
      simulatedWebhookResponse: result.body,
      transactionAfter: tx ? { id: tx.id, status: tx.status, orderId: tx.orderId } : 'TIDAK DITEMUKAN dengan order_id ini',
      note: result.status === 200 && tx?.status === 'done'
        ? 'Berhasil! Kode webhook terbukti benar -- order ini sekarang beneran selesai. Sisa masalahnya di pengiriman dari GensPay (cek registrasi webhook URL di dashboard/Telegram bot mereka).'
        : 'Belum berhasil -- lihat simulatedWebhookResponse & transactionAfter di atas untuk detail apa yang terjadi.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'self_test_failed', message: e.message });
  }
});


// Daftarkan URL ini di dashboard Telegram GensPay: https://domainkamu.com/webhook/genspay
async function logWebhookDebug(entry) {
  // Best-effort, persisten lewat KV store yang sama dipakai koleksi lain
  // -- supaya bisa dicek kapan saja via GET /debug/genspay-webhook-log,
  // tidak hilang begitu Vercel Runtime Logs di-refresh/expired. Tidak
  // pernah melempar error -- logging tidak boleh sampai mengganggu
  // respons webhook yang sebenarnya.
  try {
    const log = await readFresh('webhook_debug_log.json').catch(() => []);
    const arr = Array.isArray(log) ? log : [];
    arr.unshift({ ...entry, at: new Date().toISOString() });
    await writeDB('webhook_debug_log.json', arr.slice(0, 50)); // 50 entri terakhir cukup
  } catch (e) {
    console.error('[logWebhookDebug] gagal simpan:', e.message);
  }
}

app.post('/webhook/genspay', async (req, res) => {
  try {
    const apiKey = (process.env.GENSPAY_API_KEY || '').trim();
    // FIX (debug): sebelumnya cuma cek 'x-genspay-signature' -- kalau
    // GensPay ternyata pakai nama header lain (beda kapitalisasi tidak
    // masalah, Express sudah lowercase semua otomatis, tapi NAMA yang
    // beda total seperti 'x-signature' atau 'x-webhook-signature' akan
    // membuat signatureHeader selalu undefined tanpa ada cara tahu itu
    // sebabnya). Sekarang cek beberapa nama umum, dan REKAM semua header
    // yang benar-benar masuk kalau tidak ada satupun yang cocok.
    const signatureHeader =
      req.headers['x-genspay-signature'] ||
      req.headers['x-signature'] ||
      req.headers['x-webhook-signature'] ||
      req.headers['signature'];

    if (!apiKey || !signatureHeader) {
      await logWebhookDebug({
        result: !apiKey ? 'no_api_key_configured' : 'no_signature_header_found',
        allHeaderNames: Object.keys(req.headers),
        rawBodyPreview: (req.rawBodyForSignature || '').slice(0, 300),
      });
      return res.status(401).send('Unauthorized');
    }

    const computedSignature = crypto.createHash('sha256')
      .update((req.rawBodyForSignature || JSON.stringify(req.body)) + apiKey)
      .digest('hex');

    // Perbandingan tahan timing-attack
    const sigA = Buffer.from(String(signatureHeader));
    const sigB = Buffer.from(computedSignature);
    if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) {
      // FIX (debug): sebelumnya gagal diam-diam (cuma console.log yang
      // ilang ditelan Vercel Runtime Logs yang ephemeral). Sekarang catat
      // signature yang DITERIMA vs yang KITA HITUNG secara lengkap --
      // beda panjang karakter di antara keduanya adalah petunjuk kuat
      // algoritma-nya beda (SHA256 polos vs HMAC-SHA256 vs lainnya),
      // bukan cuma soal API key yang salah.
      await logWebhookDebug({
        result: 'signature_mismatch',
        receivedSignature: String(signatureHeader),
        receivedSignatureLength: String(signatureHeader).length,
        computedSignature,
        computedSignatureLength: computedSignature.length,
        rawBodyPreview: (req.rawBodyForSignature || '').slice(0, 300),
        rawBodyLength: (req.rawBodyForSignature || '').length,
        apiKeyLength: apiKey.length, // panjang doang, bukan isinya -- buat cek apiKey ke-trim benar/tidak kosong
      });
      return res.status(401).send('Unauthorized: Invalid Signature');
    }

    // FIX (docs GensPay terbaru): event & struktur payload webhook berubah.
    //   Lama: { event: 'payment.success', data: { order_id, ... } }
    //   Baru: { event: 'transaction.updated', data: { order_id, status: 'SUCCESS'|'EXPIRED'|'FAILED', ... } }
    // 'payment.success' sudah tidak pernah dikirim GensPay lagi -- kalau ini
    // tidak diupdate, webhook selalu masuk ke cabang "diabaikan" di bawah dan
    // penyelesaian transaksi cuma mengandalkan polling /check-payment.
    const { event, data } = req.body;
    const txStatus = (data?.status || '').toUpperCase();

    if (event === 'transaction.updated' && data?.order_id && txStatus === 'SUCCESS') {
      // RACE CONDITION FIX: cegah double allocation kalau webhook + polling
      // /check-payment jalan bareng (terutama di Vercel multi-instance).
      if (processingOrders.has(data.order_id)) {
        console.log(`[webhook/genspay] order_id=${data.order_id} sedang diproses instance lain, skip (bukan error).`);
        return res.status(200).send('OK');
      }
      processingOrders.add(data.order_id);
      try {
        const transactions = await readFresh('transactions.json');
        const transaction = transactions.find(t => t.orderId === data.order_id && t.status === 'pending');
        if (transaction) {
          console.log(`[webhook/genspay] status=SUCCESS diterima, order_id=${data.order_id}, transaksi=${transaction.id} ditemukan (status pending) -- memproses allocateKey...`);
          await allocateKeyAndCompleteTransaction(transaction, transactions);
          console.log(`[webhook/genspay] order_id=${data.order_id} selesai diproses, status akhir=${transaction.status}`);
        } else {
          // FIX (silent failure): dulu di sini TIDAK ADA log sama sekali kalau
          // transaksi tidak ketemu -- webhook tetap dibalas 200 OK ke GensPay
          // (supaya GensPay tidak retry terus), TAPI transaksi lokal tidak
          // pernah terupdate dan TIDAK ADA jejak apa pun untuk didiagnosis
          // kenapa. Kemungkinan penyebab: (a) order_id di webhook beda format
          // dari yang tersimpan di transaksi (mis. field orderId kosong/null
          // untuk sebagian jalur checkout lama), (b) transaksi sudah lebih
          // dulu 'done'/'failed' lewat jalur lain (race dengan polling
          // /check-payment), atau (c) transaksi memang tidak pernah tersimpan
          // (checkout gagal di tengah jalan tapi order sudah terlanjur
          // dibuat di GensPay). Log ini WAJIB ada supaya kasus serupa bisa
          // didiagnosis dari bukti nyata, bukan tebakan.
          const anyMatch = transactions.find(t => t.orderId === data.order_id);
          console.warn(`[webhook/genspay] status=SUCCESS diterima tapi transaksi TIDAK DITEMUKAN dengan status pending. order_id=${data.order_id}. ` +
            (anyMatch ? `Transaksi dengan order_id ini DITEMUKAN tapi status sudah '${anyMatch.status}' (bukan 'pending') -- kemungkinan sudah diproses jalur lain.`
                       : `TIDAK ADA transaksi sama sekali dengan order_id ini di database.`));
        }
      } finally {
        processingOrders.delete(data.order_id);
      }
    } else if (event === 'transaction.updated' && data?.order_id && (txStatus === 'EXPIRED' || txStatus === 'FAILED')) {
      // FIX: dulu status EXPIRED/FAILED dari webhook sama sekali tidak
      // ditangani (cuma SUCCESS yang punya efek) -- transaksi jadi nyangkut
      // 'pending' terus sampai polling /check-payment kebetulan mendeteksinya
      // sendiri. Sekarang webhook langsung tandai transaksi + reversal voucher,
      // sama seperti logika di /check-payment.
      //
      // FIX 2 (lost-update race, lihat komentar panjang di supabase.js):
      // pakai updateCollectionAtomic() alih-alih readFresh()+writeDB() manual
      // -- kalau ada penulis lain yang lebih dulu nulis ke transactions.json
      // di antara baca dan tulis kita, versi akan konflik dan mutator ini
      // otomatis di-retry terhadap data yang PALING BARU, bukan diam-diam
      // menimpa/hilang. Aman untuk di-retry berkali-kali karena mutator ini
      // murni flip status (idempoten, tidak ada efek samping eksternal).
      if (processingOrders.has(data.order_id)) {
        return res.status(200).send('OK');
      }
      processingOrders.add(data.order_id);
      try {
        let matchedTransactionId = null;
        await updateCollectionAtomic('transactions.json', (transactions) => {
          const transaction = transactions.find(t => t.orderId === data.order_id && t.status === 'pending');
          if (!transaction) return null; // sudah diproses jalur lain / tidak ditemukan -- tidak perlu tulis apa-apa
          transaction.status = 'expired';
          matchedTransactionId = transaction.id;
          return transactions;
        });
        if (matchedTransactionId) {
          console.log(`[webhook/genspay] status=${txStatus} diterima, order_id=${data.order_id}, transaksi=${matchedTransactionId} ditandai 'expired'.`);
          // Voucher reversal terpisah (koleksi berbeda, vouchers.json) --
          // dilakukan setelah status transaksi berhasil ter-commit, mencari
          // transaksi itu lagi untuk voucherCode-nya.
          const transactions = await readFresh('transactions.json');
          const transaction = transactions.find(t => t.id === matchedTransactionId);
          if (transaction?.voucherCode) {
            const vouchers = await readFresh('vouchers.json');
            const v = vouchers.find(v => v.code === transaction.voucherCode);
            if (v) {
              v.usedCount = Math.max(0, (v.usedCount || 0) - 1);
              v.usages = (v.usages || []).filter(u => u.orderId !== transaction.id);
              await writeDB('vouchers.json', vouchers);
            }
          }
        }
      } finally {
        processingOrders.delete(data.order_id);
      }
    } else {
      console.log(`[webhook/genspay] event diterima tapi diabaikan (bukan transaction.updated dengan status SUCCESS/EXPIRED/FAILED, atau order_id kosong): event=${event}, status=${txStatus}, order_id=${data?.order_id}`);
    }

    res.status(200).send('OK');
  } catch (e) {
    console.error('[webhook/genspay] error:', e.message);
    res.status(200).send('OK'); // tetap 200 biar GensPay tidak retry terus akibat error internal kita
  }
});

// ── NOWPayments Webhook (IPN): notifikasi status pembayaran crypto ──
// Daftarkan URL ini di dashboard NOWPayments sebagai IPN callback URL: https://domainkamu.com/webhook/nowpayments
app.post('/webhook/nowpayments', async (req, res) => {
  try {
    const settings = await readSmart('settings.json');
    const { ipnSecret } = getNOWPaymentsConfig(settings);
    const signatureHeader = req.headers['x-nowpayments-sig'];
    if (!ipnSecret || !signatureHeader) return res.status(401).send('Unauthorized');

    // NOWPayments mewajibkan key object diurutkan alfabetis (rekursif) sebelum
    // di-stringify, baru di-HMAC-SHA512 pakai IPN Secret Key.
    const sortedBody = sortObjectKeys(req.body);
    const computedSignature = crypto.createHmac('sha512', ipnSecret)
      .update(JSON.stringify(sortedBody))
      .digest('hex');

    // Perbandingan tahan timing-attack
    const sigA = Buffer.from(String(signatureHeader));
    const sigB = Buffer.from(computedSignature);
    if (sigA.length !== sigB.length || !crypto.timingSafeEqual(sigA, sigB)) {
      return res.status(401).send('Unauthorized: Invalid Signature');
    }

    const { order_id, payment_status, payment_id } = req.body;
    console.log(`[webhook/nowpayments] diterima: order_id=${order_id}, payment_id=${payment_id}, status=${payment_status}`);

    if (payment_status === 'finished' && order_id) {
      // RACE CONDITION FIX: cegah double allocation kalau webhook + polling
      // /check-payment jalan bareng (terutama di Vercel multi-instance).
      if (processingOrders.has(order_id)) {
        console.log(`[webhook/nowpayments] order_id=${order_id} sedang diproses instance lain, skip (bukan error).`);
        return res.status(200).send('OK');
      }
      processingOrders.add(order_id);
      try {
        const transactions = await readFresh('transactions.json');
        const transaction = transactions.find(t => t.orderId === order_id && (t.status === 'pending' || t.status === 'processing'));
        if (transaction) {
          console.log(`[webhook/nowpayments] payment_status=finished, order_id=${order_id}, transaksi=${transaction.id} ditemukan -- memproses allocateKey...`);
          await allocateKeyAndCompleteTransaction(transaction, transactions);
          console.log(`[webhook/nowpayments] order_id=${order_id} selesai diproses, status akhir=${transaction.status}`);
        } else {
          const anyMatch = transactions.find(t => t.orderId === order_id);
          console.warn(`[webhook/nowpayments] payment_status=finished tapi transaksi TIDAK DITEMUKAN dengan status pending/processing. order_id=${order_id}. ` +
            (anyMatch ? `Transaksi dengan order_id ini DITEMUKAN tapi status sudah '${anyMatch.status}' -- kemungkinan sudah diproses jalur lain.`
                       : `TIDAK ADA transaksi sama sekali dengan order_id ini di database.`));
        }
      } finally {
        processingOrders.delete(order_id);
      }
    } else {
      console.log(`[webhook/nowpayments] status diterima tapi diabaikan (bukan 'finished'): status=${payment_status}, order_id=${order_id}`);
    }

    res.status(200).send('OK');
  } catch (e) {
    console.error('[webhook/nowpayments] error:', e.message);
    res.status(200).send('OK'); // tetap 200 biar NOWPayments tidak retry terus akibat error internal kita
  }
});

// ── Binance Pay Webhook: notifikasi status order ──
// Daftarkan URL ini (atau kirim webhookUrl per-order, sudah dilakukan di
// createBinancePayOrder) di Binance Merchant Admin Portal: https://domainkamu.com/webhook/binancepay
// PENTING: respons WAJIB format {"returnCode":"SUCCESS"/"FAIL","returnMessage":...}
// (bukan cuma HTTP 200 polos) -- kalau tidak, Binance akan retry sampai 6x.
app.post('/webhook/binancepay', async (req, res) => {
  try {
    const settings = await readSmart('settings.json');
    const timestamp = req.headers['binancepay-timestamp'];
    const nonce = req.headers['binancepay-nonce'];
    const signatureHeader = req.headers['binancepay-signature'];
    if (!timestamp || !nonce || !signatureHeader) {
      return res.status(200).json({ returnCode: 'FAIL', returnMessage: 'Missing signature headers' });
    }

    let cert;
    try {
      cert = await getBinancePayCertificate(settings);
    } catch (e) {
      console.error('[webhook/binancepay] gagal ambil sertifikat publik:', e.message);
      return res.status(200).json({ returnCode: 'FAIL', returnMessage: 'Certificate unavailable' });
    }

    const rawBody = req.rawBodyForSignature || '';
    const valid = verifyBinancePaySignature(cert.certPublic, timestamp, nonce, rawBody, signatureHeader);
    if (!valid) {
      console.warn('[webhook/binancepay] signature tidak valid, ditolak.');
      return res.status(200).json({ returnCode: 'FAIL', returnMessage: 'Invalid signature' });
    }

    const { bizStatus, data: dataStr } = req.body || {};
    let data = {};
    try { data = typeof dataStr === 'string' ? JSON.parse(dataStr) : (dataStr || {}); } catch (e) { data = {}; }
    const orderId = data.merchantTradeNo;
    console.log(`[webhook/binancepay] diterima: order_id=${orderId}, bizStatus=${bizStatus}`);

    if (bizStatus === 'PAY_SUCCESS' && orderId) {
      // RACE CONDITION FIX: sama pola dengan webhook provider lain -- cegah
      // double allocation kalau webhook + polling /check-payment jalan bareng.
      if (processingOrders.has(orderId)) {
        console.log(`[webhook/binancepay] order_id=${orderId} sedang diproses instance lain, skip (bukan error).`);
        return res.status(200).json({ returnCode: 'SUCCESS', returnMessage: null });
      }
      processingOrders.add(orderId);
      try {
        const transactions = await readFresh('transactions.json');
        const transaction = transactions.find(t => t.orderId === orderId && (t.status === 'pending' || t.status === 'processing'));
        if (transaction) {
          console.log(`[webhook/binancepay] bizStatus=PAY_SUCCESS, order_id=${orderId}, transaksi=${transaction.id} ditemukan -- memproses allocateKey...`);
          await allocateKeyAndCompleteTransaction(transaction, transactions);
          console.log(`[webhook/binancepay] order_id=${orderId} selesai diproses, status akhir=${transaction.status}`);
        } else {
          const anyMatch = transactions.find(t => t.orderId === orderId);
          console.warn(`[webhook/binancepay] bizStatus=PAY_SUCCESS tapi transaksi TIDAK DITEMUKAN dengan status pending/processing. order_id=${orderId}. ` +
            (anyMatch ? `Transaksi ini DITEMUKAN tapi status sudah '${anyMatch.status}'.` : `TIDAK ADA transaksi sama sekali dengan order_id ini.`));
        }
      } finally {
        processingOrders.delete(orderId);
      }
    } else {
      console.log(`[webhook/binancepay] bizStatus diterima tapi diabaikan (bukan PAY_SUCCESS): bizStatus=${bizStatus}, order_id=${orderId}`);
    }

    res.status(200).json({ returnCode: 'SUCCESS', returnMessage: null });
  } catch (e) {
    console.error('[webhook/binancepay] error:', e.message);
    // tetap balas SUCCESS biar Binance tidak retry terus akibat error internal kita
    res.status(200).json({ returnCode: 'SUCCESS', returnMessage: null });
  }
});

// Routes - Public
app.get('/', async (req, res) => {
  // Parallelkan semua fetch agar tidak sequential (hemat ~200-400ms per request)
  const [allProducts, transactions, users] = await Promise.all([
    readSmart('products.json'),
    readSmart('transactions.json'),
    readSmart('users.json'),
  ]);
  const products = allProducts.filter(p => p.status === 'active');

  // ── Leaderboard dari data real transaksi saja ──

  const userStats = {};
  transactions.forEach(t => {
    if (t.status === 'done' && t.userId) {
      if (!userStats[t.userId]) userStats[t.userId] = { userId: t.userId, totalTransactions: 0, totalSpent: 0 };
      userStats[t.userId].totalTransactions++;
      userStats[t.userId].totalSpent += t.price;
    }
  });
  const leaderboardEntries = Object.values(userStats).map(stat => {
    const u = users.find(u => u.id === stat.userId);
    return { username: u?.username || 'User', photo: u?.photo || null, totalTransactions: stat.totalTransactions, totalSpent: stat.totalSpent };
  }).sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 8);

  // ── Testimoni real saja (sudah diverifikasi admin) ──
  const realTestimonials = (readDB('testimonials.json') || []).filter(t => t.verified);
  const testimonialsForHome = realTestimonials.slice(0, 12);
  // Rating rata-rata & distribusi dihitung dari SEMUA testimoni real (bukan cuma 12 yang ditampilkan)
  // supaya angka rating yang muncul benar-benar mencerminkan data asli.
  const avgRating = realTestimonials.length
    ? (realTestimonials.reduce((s, t) => s + (t.rating || 0), 0) / realTestimonials.length).toFixed(1)
    : '—';
  const ratingCounts = {1:0,2:0,3:0,4:0,5:0};
  realTestimonials.forEach(t => { if (t.rating >= 1 && t.rating <= 5) ratingCounts[t.rating]++; });
  const totalSold = products.reduce((s, p) => s + (p.sold || 0), 0);
  const settings = readDB('settings.json');
  const user = getSessionUser(req);

  // Popular products: if admin configured popularProductIds, use those; else show all products
  const popularProductIds = settings.popularProductIds || [];
  let popularProducts;
  if (popularProductIds.length > 0) {
    popularProducts = products.filter(p => popularProductIds.includes(p.id));
    // Append any active products not in the popular list
    const remaining = products.filter(p => !popularProductIds.includes(p.id));
    popularProducts = [...popularProducts, ...remaining];
  } else {
    popularProducts = [...products].sort((a, b) => (b.sold || 0) - (a.sold || 0));
  }

  // SECURITY: jangan kirim raw license keys ke client — ganti dengan stock count saja
  // BUG FIX: produk/varian dengan stockSource 'auto' (Reseller API, key
  // digenerate on-demand -- dianggap unlimited di sisi provider) tidak
  // pakai product.keys sama sekali. Sebelumnya selalu kehitung stock=0
  // (dianggap "Habis") walau kredensial & mapping API sudah benar.
  // BUG FIX #2: hasil `stripKeys` ini (lewat popularProducts) ditempel ke
  // <script> di home.ejs pakai JSON.stringify() -- jadi HARUS pakai
  // UNLIMITED_STOCK, bukan Infinity, atau nilainya jadi `null` pas sampai
  // di browser (lihat komentar UNLIMITED_STOCK di atas).
  // UPDATE: untuk produk mode 'auto', stok yang ditampilkan sekarang ditarik
  // LANGSUNG dari provider (vipibmstore.com) lewat resellerApi.getRealStockForProduct
  // -- bukan sentinel 999999 statis lagi. Kalau provider tandai item itu
  // 'v2'/unlimited, tetap tampil "Tersedia" (via UNLIMITED_STOCK). Kalau
  // provider kasih angka pasti, angka ITU yang ditampilkan. Kalau gagal
  // resolve/fetch (network error dsb), fallback ke UNLIMITED_STOCK supaya
  // tidak salah tampil "Habis" karena masalah sementara di sisi kita.
  const hasAutoStock = (p) => p.stockMode === 'auto' || p.stockMode === 'mixed'
    || (Array.isArray(p.pricingOptions) && p.pricingOptions.some(o => o.stockSource === 'auto'));
  // DUMMY SOLD: generate sekali per produk (persist) kalau belum ada.
  // PENTING: jalankan di allProducts (full, belum difilter status) supaya
  // writeDB tidak diam-diam menghapus produk inactive dari database.
  if (ensureDummySold(allProducts)) {
    await writeDB('products.json', allProducts);
  }
  const stripKeys = async (p) => {
    const { keys, ...rest } = p;
    if (!hasAutoStock(p)) {
      return { ...rest, keys: undefined, stock: (keys || []).length };
    }
    const stock = await computeProductCardStock(settings, p);
    return { ...rest, keys: undefined, stock };
  };
  const productsSafe = await Promise.all(products.map(stripKeys));
  const popularProductsSafe = await Promise.all(popularProducts.map(stripKeys));

  res.render('pages/home', {
    products: productsSafe,
    popularProducts: popularProductsSafe,
    settings,
    user,
    categories: settings.categories || [],
    categoryLabels: settings.categoryLabels || {},
    resellerSettings: {
      enabled: settings.resellerEnabled !== false,
      price: settings.resellerPrice || 50000,
      discount: settings.resellerDiscount || 20
    },
    leaderboardEntries,
    testimonialsForHome,
    avgRating,
    ratingCounts,
    totalSold
  });
});

// Auth routes
app.get('/login', async (req, res) => {
  if (req.session?.isAdmin) return res.redirect('/admin');
  if (req.session?.userId) {
    // Validasi: pastikan user ini benar-benar masih ada di database sebelum redirect.
    // Kalau tidak (sesi corrupt/user sudah dihapus), bersihkan sesi supaya tidak terjebak loop redirect.
    const users = await readSmart('users.json');
    const stillExists = users.some(u => u.id === req.session.userId);
    if (stillExists) return res.redirect('/');
    req.session = null;
  }
  const settings = readDB('settings.json');
  // req.query.error dipakai jalur Google OAuth (lihat /auth/google/callback)
  // untuk melempar pesan gagal balik ke halaman login dengan cara yang sama
  // seperti error login biasa -- bukan tipe error terpisah di template.
  res.render('pages/login', { error: req.query.error || null, redirect: req.query.redirect || '/', settings });
});

app.post('/login', async (req, res) => {
  const ip = req.ip;
  const { blocked, wait } = checkLoginBlocked(ip);
  const settings = readDB('settings.json');
  if (blocked) {
    return res.render('pages/login', {
      error: `Terlalu banyak percobaan login. Coba lagi dalam ${wait} menit.`,
      redirect: req.body.redirect || '/', settings
    });
  }

  const { username, password } = req.body;

  // ── Cloudflare Turnstile verification (jika diaktifkan) ──
  const secretKey = settings.turnstile?.secretKey;
  if (secretKey && secretKey.trim() !== '') {
    const token = req.body['cf-turnstile-response'];
    if (!token) {
      return res.render('pages/login', {
        error: 'Verifikasi anti-bot gagal. Silakan coba lagi.',
        redirect: req.body.redirect || '/', settings
      });
    }
    try {
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: secretKey, response: token, remoteip: ip })
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        return res.render('pages/login', {
          error: 'Verifikasi anti-bot tidak valid. Silakan refresh dan coba lagi.',
          redirect: req.body.redirect || '/', settings
        });
      }
    } catch (e) {
      // Jika verifikasi gagal karena network error, tetap izinkan login (fail-open)
      console.error('Turnstile verify error:', e.message);
    }
  }

  // Check admin (via settings)
  if (username === settings.adminUsername) {
    const match = await bcrypt.compare(password, settings.adminPassword);
    if (match) {
      clearLoginFail(ip);
      req.session.userId = 'admin';
      req.session.isAdmin = true;
      return res.redirect('/admin');
    }
  }

  // Check user
  const users = readDB('users.json');
  const user = users.find(u => u.username === username);

  if (user && await bcrypt.compare(password, user.password)) {
    clearLoginFail(ip);
    req.session.userId = user.id;
    req.session.isAdmin = (user.role === 'admin');
    return res.redirect(req.body.redirect || (req.session.isAdmin ? '/admin' : '/'));
  }

  recordLoginFail(ip);
  const remaining = LOGIN_MAX_FAIL - (loginFailMap.get(ip)?.count || 0);
  const errMsg = remaining > 0
    ? `Username atau password salah. Sisa percobaan: ${remaining}`
    : `Terlalu banyak percobaan login. Coba lagi dalam 15 menit.`;
  res.render('pages/login', { error: errMsg, redirect: req.body.redirect || '/', settings });
});

app.get('/register', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  const settings = readDB('settings.json');
  res.render('pages/register', { error: null, settings });
});

app.post('/register', async (req, res) => {
  const { username, password, confirmPassword, wa } = req.body;
  const settings = readDB('settings.json');

  if (!username || !password || !wa) {
    return res.render('pages/register', { error: 'Semua field wajib diisi', settings });
  }

  if (confirmPassword && password !== confirmPassword) {
    return res.render('pages/register', { error: 'Konfirmasi password tidak cocok', settings });
  }

  if (username === 'admin') {
    return res.render('pages/register', { error: 'Username tidak diizinkan', settings });
  }

  // ── Cloudflare Turnstile verification (jika diaktifkan) ──
  const secretKey = settings.turnstile?.secretKey;
  if (secretKey && secretKey.trim() !== '') {
    const token = req.body['cf-turnstile-response'];
    if (!token) {
      return res.render('pages/register', {
        error: 'Verifikasi anti-bot gagal. Silakan coba lagi.',
        settings
      });
    }
    try {
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: secretKey, response: token, remoteip: req.ip })
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        return res.render('pages/register', {
          error: 'Verifikasi anti-bot tidak valid. Silakan refresh dan coba lagi.',
          settings
        });
      }
    } catch (e) {
      console.error('Turnstile verify error (register):', e.message);
      // fail-open — jangan blok registrasi karena network error
    }
  }
  // ────────────────────────────────────────────────────────

  const users = readDB('users.json');

  if (users.find(u => u.username === username)) {
    return res.render('pages/register', { error: 'Username sudah digunakan', settings });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: uuidv4(),
    username,
    password: hashedPassword,
    wa,
    photo: null,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  await writeDB('users.json', users);

  req.session.userId = newUser.id;
  req.session.isAdmin = false;

  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ══════════════════════════════════════════════════════════════════
// LOGIN WITH GOOGLE (OAuth 2.0, redirect-based -- tanpa library
// tambahan, konsisten dengan pola NOWPayments di file ini: fetch
// manual ke endpoint token Google, bukan passport.js atau sejenisnya).
// Kredensial (Client ID/Secret) disimpan di settings.google, diisi dari
// admin panel, sama pola seperti settings.nowpayments.
// ══════════════════════════════════════════════════════════════════

// Helper: bangun redirect URI Google OAuth secara KONSISTEN di /auth/google
// dan /auth/google/callback -- kedua tempat WAJIB identik persis atau Google
// akan tolak dengan redirect_uri_mismatch, sekalipun yang terdaftar di
// Google Cloud Console sudah benar. Hardcode https:// (bukan req.protocol)
// karena req.protocol bisa salah baca 'http' di balik reverse proxy
// (Vercel dkk) walau app.set('trust proxy',1) sudah diaktifkan -- beberapa
// setup proxy tidak selalu forward X-Forwarded-Proto dengan benar. Domain
// production selalu HTTPS, jadi hardcode di sini lebih aman daripada
// bergantung pada deteksi protokol runtime yang bisa keliru.
function buildGoogleRedirectUri(req) {
  const host = req.get('host'); // termasuk domain, tanpa protokol (mis. "heromarket.web.id")
  return `https://${host}/auth/google/callback`;
}

// Mulai flow: redirect user ke halaman consent Google.
app.get('/auth/google', async (req, res) => {
  const settings = await readFresh('settings.json');
  const clientId = settings.google?.clientId || process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.redirect('/login?error=' + encodeURIComponent('Login Google belum dikonfigurasi admin.'));
  }

  // CSRF protection: state random disimpan di session, divalidasi lagi di
  // callback -- mencegah penyerang memaksa korban login sebagai akun lain
  // via crafted callback URL (state fixation).
  const state = crypto.randomBytes(24).toString('hex');
  req.session.googleOAuthState = state;
  // Simpan juga redirect tujuan setelah login sukses (konsisten dengan pola
  // requireAuth yang sudah ada: ?redirect=/buy/xxx dst).
  req.session.googleOAuthRedirect = req.query.redirect || '/';

  const redirectUri = buildGoogleRedirectUri(req);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Callback: Google redirect balik ke sini dengan ?code=... setelah user setuju.
app.get('/auth/google/callback', async (req, res) => {
  const settings = await readFresh('settings.json');
  const clientId = settings.google?.clientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = settings.google?.clientSecret || process.env.GOOGLE_CLIENT_SECRET;
  const { code, state, error: googleError } = req.query;

  if (googleError) {
    // User klik "Cancel" di consent screen Google, atau Google sendiri error.
    return res.redirect('/login?error=' + encodeURIComponent('Login Google dibatalkan.'));
  }
  if (!clientId || !clientSecret) {
    return res.redirect('/login?error=' + encodeURIComponent('Login Google belum dikonfigurasi admin.'));
  }
  // Validasi CSRF state -- WAJIB cocok dengan yang disimpan di /auth/google.
  if (!state || state !== req.session.googleOAuthState) {
    return res.redirect('/login?error=' + encodeURIComponent('Sesi login Google tidak valid, silakan coba lagi.'));
  }
  const redirectTarget = req.session.googleOAuthRedirect || '/';
  delete req.session.googleOAuthState;
  delete req.session.googleOAuthRedirect;

  if (!code) {
    return res.redirect('/login?error=' + encodeURIComponent('Login Google gagal (kode tidak ditemukan).'));
  }

  try {
    const redirectUri = buildGoogleRedirectUri(req);

    // Tukar authorization code -> access token
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error('[Google OAuth] token exchange failed:', tokenData);
      return res.redirect('/login?error=' + encodeURIComponent('Login Google gagal (token exchange).'));
    }

    // Ambil profil user pakai access token
    const profileResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileResp.json();
    if (!profileResp.ok || !profile.id || !profile.email) {
      console.error('[Google OAuth] profile fetch failed:', profile);
      return res.redirect('/login?error=' + encodeURIComponent('Login Google gagal (profil tidak terbaca).'));
    }

    // Cari user existing by googleId ATAU by email (kalau user pernah
    // register manual pakai email yang sama, akun digabung -- bukan
    // dibuatkan akun baru duplikat).
    const users = readDB('users.json');
    let user = users.find(u => u.googleId === profile.id) || users.find(u => u.email && u.email.toLowerCase() === profile.email.toLowerCase());

    if (user) {
      // User sudah ada -- pastikan googleId & photo ter-link (kalau dulu
      // daftar manual, sekarang pertama kali pakai Google).
      let changed = false;
      if (!user.googleId) { user.googleId = profile.id; changed = true; }
      if (!user.photo && profile.picture) { user.photo = profile.picture; changed = true; }
      if (changed) await writeDB('users.json', users);
    } else {
      // User baru -- generate username unik dari email (bagian sebelum @),
      // tambah suffix angka kalau sudah ada yang pakai. password null
      // (akun Google tidak bisa login pakai password manual).
      let baseUsername = profile.email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'user';
      let username = baseUsername;
      let suffix = 1;
      while (users.some(u => u.username === username)) {
        username = `${baseUsername}${suffix}`;
        suffix++;
      }
      user = {
        id: uuidv4(),
        username,
        password: null, // akun Google -- tidak ada password lokal
        email: profile.email,
        googleId: profile.id,
        wa: null, // belum ada nomor WA, akan diminta lengkapi profil kalau perlu
        photo: profile.picture || null,
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      await writeDB('users.json', users);
    }

    req.session.userId = user.id;
    req.session.isAdmin = false;
    res.redirect(redirectTarget);
  } catch (e) {
    console.error('[Google OAuth] callback error:', e.message);
    res.redirect('/login?error=' + encodeURIComponent('Login Google gagal, silakan coba lagi.'));
  }
});

// ── RESELLER ──
app.get('/reseller', (req, res) => {
  // FIX: pakai res.locals.settings (sudah di-refresh readSmart oleh middleware
  // global) bukan readDB() mentah lagi, supaya perubahan admin (QRIS, NOWPayments,
  // dll) langsung kepakai tanpa nunggu instance ini restart.
  const settings = res.locals.settings;
  const user = getSessionUser(req);
  if (user && user.is_reseller) return res.redirect('/reseller/panel');
  res.render('pages/reseller', { layout: false, settings, user });
});

app.get('/reseller/panel', requireAuth, (req, res) => {
  // FIX: sama seperti /reseller -- pakai settings yang sudah fresh dari
  // res.locals (readSmart), bukan readDB() mentah. Ini halaman yang punya
  // tombol topup saldo & NOWPayments (crypto), jadi kalau admin baru ganti
  // API Key NOWPayments atau QRIS, harus langsung kepakai di sini.
  const settings = res.locals.settings;
  const user = getSessionUser(req);
  if (!user || !user.is_reseller) return res.redirect('/reseller');

  const transactions = readDB('transactions.json');
  const myTx = transactions.filter(t => t.userId === user.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Riwayat key: transaksi produk (bukan topup/upgrade reseller) yang sukses & punya key
  const keyTx = myTx.filter(t => t.status === 'done' && t.key && t.type !== 'topup' && t.type !== 'reseller');

  // Breakdown per produk
  const breakdownMap = {};
  keyTx.forEach(t => {
    const name = t.productName || 'Lainnya';
    if (!breakdownMap[name]) breakdownMap[name] = { name, count: 0, total: 0 };
    breakdownMap[name].count++;
    breakdownMap[name].total += (t.price || 0);
  });
  const breakdown = Object.values(breakdownMap).sort((a, b) => b.count - a.count);

  // Mutasi saldo: topup (masuk) + pembayaran pakai saldo (keluar), termasuk penyesuaian manual admin
  const saldoMutations = myTx
    .filter(t => t.type === 'topup' || t.paymentMethod === 'balance')
    .filter(t => t.status === 'done' || t.isManualAdjustment)
    .map(t => {
      if (t.type === 'topup') {
        return { id: t.id, arah: 'masuk', label: t.productName || 'Topup Saldo', amount: (t.price || 0) + (t.bonus || 0), createdAt: t.paidAt || t.createdAt, code: t.code };
      }
      return { id: t.id, arah: 'keluar', label: `Beli ${t.productName || 'Produk'}`, amount: t.price || 0, createdAt: t.paidAt || t.createdAt, code: t.code };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const products = readDB('products.json').filter(p => p.status === 'active');

  res.render('pages/seller-panel', {
    layout: false, settings, user,
    products,
    keyTx: keyTx.slice(0, 100),
    breakdown,
    saldoMutations: saldoMutations.slice(0, 100),
    topupPackages: settings.resellerTopupPackages || [],
    topupMin: settings.resellerTopupMin || 50000,
    nowpaymentsConfigured: Boolean(settings.nowpayments?.apiKey || process.env.NOWPAYMENTS_API_KEY)
  });
});

app.post('/reseller/join', requireAuth, async (req, res) => {
  try {
    if (req.session.isAdmin) return res.json({ success: false, message: 'Admin tidak perlu join reseller' });
    const users = readDB('users.json');
    const user = users.find(u => u.id === req.session.userId);
    if (!user) return res.json({ success: false, message: 'User tidak ditemukan' });
    if (user.is_reseller) return res.json({ success: false, message: 'Kamu sudah menjadi Reseller VIP!' });

    const settings = readDB('settings.json');
    const price = settings.resellerPrice || 50000;
    const orderId = `RES-${Date.now()}`;
    const refId = uuidv4();
    const orderCode = generateOrderCode();
    const qrisMode = settings.qrisMode || 'static';

    let qrString = null, isStatic = false;

    if (qrisMode === 'static') {
      if (!settings.qrisStaticImage) return res.json({ success: false, message: 'Admin belum mengatur QRIS. Hubungi admin.' });
      isStatic = true;
    } else {
      try {
        const r = await createQRISPayment(orderId, price, settings, `${getAppBaseUrl(req)}/webhook/genspay`);
        qrString = r.qr_string;
      } catch (e) {
        console.error('[create-order/reseller] GensPay gagal, fallback ke QRIS statis:', e.message);
        if (settings.qrisStaticImage) { isStatic = true; }
        else return res.json({ success: false, message: 'QRIS error: ' + e.message });
      }
    }

    const transactions = await readFresh('transactions.json');
    transactions.push({
      id: refId, orderId, code: orderCode,
      userId: user.id, type: 'reseller',
      productName: 'Upgrade Reseller VIP',
      customerName: user.username, wa: user.wa,
      price, totalPayment: price, qrString, isStatic,
      status: 'pending', key: null,
      createdAt: new Date().toISOString(), time: formatDate()
    });
    await writeDB('transactions.json', transactions);

    res.json({ success: true, refId, orderId, qrString, orderCode, isStatic,
      qrisStaticImage: isStatic ? settings.qrisStaticImage : null });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/reseller/topup', requireAuth, async (req, res) => {
  try {
    if (req.session.isAdmin) return res.json({ success: false, message: 'Admin tidak perlu topup saldo' });
    const users = readDB('users.json');
    const user = users.find(u => u.id === req.session.userId);
    if (!user) return res.json({ success: false, message: 'User tidak ditemukan' });
    if (!user.is_reseller) return res.json({ success: false, message: 'Topup saldo hanya untuk Reseller VIP' });

    const settings = readDB('settings.json');
    const nominal = parseInt(req.body.nominal);
    const minTopup = settings.resellerTopupMin || 50000;
    if (isNaN(nominal) || nominal < minTopup) return res.json({ success: false, message: `Minimal topup Rp${minTopup.toLocaleString('id-ID')}` });
    if (nominal > 50000000) return res.json({ success: false, message: 'Nominal topup terlalu besar' });

    // Cek apakah nominal cocok dengan salah satu paket bonus yang diatur admin
    const matchedPkg = (settings.resellerTopupPackages || []).find(p => p.nominal === nominal);
    const bonus = matchedPkg ? (matchedPkg.bonus || 0) : 0;

    const orderId = `TOP-${Date.now()}`;
    const refId = uuidv4();
    const orderCode = generateOrderCode();
    const qrisMode = settings.qrisMode || 'static';

    // FIX: QRIS sekarang jadi opsional saat membuat transaksi topup.
    // Sebelumnya kalau QRIS belum dikonfigurasi / API-nya error, seluruh request
    // langsung gagal (return error) padahal user mungkin mau bayar pakai metode
    // lain (NOWPayments/crypto). Sekarang: transaksi TETAP dibuat walau QRIS
    // gagal/kosong, supaya /nowpayments/create-payment (yang independen, hanya
    // butuh refId) tetap bisa dipakai. qrString akan null kalau QRIS memang
    // tidak tersedia — frontend yang menampilkan pesan "QRIS belum dikonfigurasi"
    // hanya kalau user pilih tab QRIS, sementara tombol crypto tetap berfungsi normal.
    let qrString = null, isStatic = false;

    if (qrisMode === 'static') {
      if (settings.qrisStaticImage) isStatic = true;
    } else {
      try {
        const r = await createQRISPayment(orderId, nominal, settings, `${getAppBaseUrl(req)}/webhook/genspay`);
        qrString = r.qr_string;
      } catch (e) {
        console.error('[create-order/topup] GensPay gagal, fallback ke QRIS statis:', e.message);
        if (settings.qrisStaticImage) isStatic = true;
        // Tidak lagi return error di sini — biarkan lanjut tanpa QRIS,
        // NOWPayments (crypto) masih bisa dipakai.
      }
    }

    const transactions = await readFresh('transactions.json');
    transactions.push({
      id: refId, orderId, code: orderCode,
      userId: user.id, type: 'topup',
      productName: 'Topup Saldo Reseller' + (bonus > 0 ? ` (+bonus Rp${bonus.toLocaleString('id-ID')})` : ''),
      customerName: user.username, wa: user.wa,
      price: nominal, bonus, totalPayment: nominal, qrString, isStatic,
      status: 'pending', key: null,
      createdAt: new Date().toISOString(), time: formatDate()
    });
    await writeDB('transactions.json', transactions);

    res.json({ success: true, refId, orderId, qrString, orderCode, isStatic, bonus,

      qrisStaticImage: isStatic ? settings.qrisStaticImage : null });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── PROFILE PHOTO ──
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = isVercel ? '/tmp/avatars' : path.join(__dirname, 'public', 'uploads', 'avatars');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${req.session.userId}-${Date.now()}${path.extname(file.originalname)}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg','image/jpg','image/png','image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Format harus JPEG/PNG/WebP'));
  }
});

app.post('/profile/photo', requireAuth, avatarUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, message: 'File tidak valid' });

    // Admin tidak punya entry di users.json
    if (req.session.userId === 'admin') {
      return res.json({ success: false, message: 'Admin tidak bisa ganti foto profil dari sini' });
    }

    const users = readDB('users.json');
    const user  = users.find(u => u.id === req.session.userId);
    if (!user) return res.json({ success: false, message: 'User tidak ditemukan' });

    // Hapus foto lama jika ada
    if (user.photo) {
      const oldPath = path.join(__dirname, 'public', user.photo.replace(/^\//, ''));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    if (!isVercel) { user.photo = `/uploads/avatars/${req.file.filename}`; }
    else { try { user.photo = await db.uploadImage(require('fs').readFileSync(req.file.path), req.file.originalname, req.file.mimetype); } catch (e) { return res.json({ success: false, message: 'Upload gagal: ' + e.message }); } }
    await writeDB('users.json', users);
    res.json({ success: true, photo: user.photo });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── BANNER CAROUSEL ──
const bannerCarouselUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = isVercel ? '/tmp/banners' : path.join(__dirname, 'public', 'uploads', 'banners');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `banner-${Date.now()}${path.extname(file.originalname)}`);
    }
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg','image/jpg','image/png','image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Format harus JPEG/PNG/WebP'));
  }
});

app.get('/api/banners', async (req, res) => {
  const settings = await readFresh('settings.json');
  res.json((settings.banners || []).filter(b => b.active !== false));
});

app.post('/admin/banners/add', requireAdmin, bannerCarouselUpload.single('bannerImg'), async (req, res) => {
  try {
    const { title, subtitle, link, imageUrl } = req.body;
    const settings = await readFresh('settings.json');
    if (!settings.banners) settings.banners = [];
    let imgSrc = imageUrl?.trim() || '';
    if (req.file) {
      if (!isVercel) {
        imgSrc = `/uploads/banners/${req.file.filename}`;
      } else {
        try {
          imgSrc = await db.uploadImage(require('fs').readFileSync(req.file.path), req.file.originalname, req.file.mimetype);
        } catch {
          // Fallback: simpan sebagai base64 data URL agar muncul tanpa storage eksternal
          const buf = require('fs').readFileSync(req.file.path);
          imgSrc = `data:${req.file.mimetype};base64,${buf.toString('base64')}`;
        }
      }
    }
    if (!imgSrc) return res.json({ success: false, message: 'Gambar banner wajib diisi' });
    settings.banners.push({
      id: uuidv4(),
      imageUrl: imgSrc,
      title: title?.trim() || '',
      subtitle: subtitle?.trim() || '',
      link: link?.trim() || '/',
      active: true,
      createdAt: new Date().toISOString()
    });
    await writeDB('settings.json', settings);
    res.json({ success: true, banners: settings.banners });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/admin/banners/delete/:id', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const old = (settings.banners || []).find(b => b.id === req.params.id);
    if (old?.imageUrl?.startsWith('/uploads/banners/')) {
      const fp = path.join(__dirname, 'public', old.imageUrl);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    settings.banners = (settings.banners || []).filter(b => b.id !== req.params.id);
    await writeDB('settings.json', settings);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/admin/banners/toggle/:id', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const b = (settings.banners || []).find(b => b.id === req.params.id);
    if (b) b.active = !b.active;
    await writeDB('settings.json', settings);
    res.json({ success: true, active: b?.active });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// ── QRIS STATIS UPLOAD ──
const qrisUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = isVercel ? '/tmp' : path.join(__dirname, 'public', 'uploads');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `qris-static${path.extname(file.originalname)}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg','image/jpg','image/png','image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Format harus JPEG/PNG/WebP'));
  }
});

app.post('/admin/qris/upload', requireAdmin, qrisUpload.single('qrisImage'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, message: 'File tidak valid' });
    const settings = await readFresh('settings.json');
    if (!isVercel) {
      settings.qrisStaticImage = `/uploads/${req.file.filename}`;
    } else {
      try { settings.qrisStaticImage = await db.uploadImage(require('fs').readFileSync(req.file.path), req.file.originalname, req.file.mimetype); } catch (e) { return res.json({ success: false, message: e.message }); }
    }
    await writeDB('settings.json', settings);
    res.json({ success: true, path: settings.qrisStaticImage });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/profile/me', requireAuth, (req, res) => {
  if (req.session.isAdmin) {
    const s = readDB('settings.json');
    return res.json({ success: true, user: { id: 'admin', username: s.adminUsername || 'Admin', isAdmin: true, is_reseller: false, photo: null } });
  }
  const users = readDB('users.json');
  const user  = users.find(u => u.id === req.session.userId);
  if (!user) return res.json({ success: false });
  const { password: _, ...safe } = user;
  res.json({ success: true, user: safe });
});

// ── User Dashboard ──
app.get('/dashboard', requireAuth, (req, res) => {
  const transactions = readDB('transactions.json');
  const user = getSessionUser(req);
  const settings = readDB('settings.json');

  // Filter transaksi milik user ini
  const myTransactions = transactions.filter(t => t.userId === req.session.userId);
  const totalOrders = myTransactions.length;
  const successOrders = myTransactions.filter(t => t.status === 'done').length;
  const pendingOrders = myTransactions.filter(t => t.status === 'pending').length;
  const totalSpent = myTransactions.filter(t => t.status === 'done').reduce((s, t) => s + (t.price || 0), 0);
  const doneTransactions = myTransactions.filter(t => t.status === 'done').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const recentTransactions = myTransactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 20);

  res.render('pages/dashboard', {
    user, settings,
    stats: { totalOrders, successOrders, pendingOrders, totalSpent },
    doneTransactions,
    transactions: recentTransactions
  });
});

// ── PUBLIC ORDER LOOKUP: halaman hasil transaksi tanpa perlu login, supaya
// link bisa langsung dikirim ke customer via WA/Telegram dan preview-nya
// tidak kosong (sebelumnya /buy/:id & /cek-pesanan wajib login, jadi bot
// preview & customer di device lain kena redirect kosong ke /login).
// KEAMANAN:
// - Diakses pakai order `code` (HM-XXXX-XXXX, CSPRNG 8 char dari 32-charset,
//   ~40 bit entropy) BUKAN id database berurutan -- tidak bisa ditebak/di-enum.
// - Tidak ada endpoint list/search; harus tahu code persis.
// - Data yang di-expose sengaja diminimalkan: TIDAK ada nama, WA, email
//   customer. Key produk cuma muncul kalau status='done'.
// - Rate-limited per IP supaya code tidak bisa di-brute-force.
app.get('/order/:code', async (req, res) => {
  if (!checkApiRateLimit(req.ip, 20, 60000)) {
    return res.status(429).render('pages/order-public', { order: null, settings: readDB('settings.json'), rateLimited: true });
  }
  const settings = readDB('settings.json');
  const code = (req.params.code || '').trim().toUpperCase();
  // Validasi format ketat sebelum query, biar tidak buang waktu di lookup untuk input asal
  if (!/^HM-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    return res.status(404).render('pages/order-public', { order: null, settings, rateLimited: false });
  }
  const transactions = await readSmart('transactions.json');
  const t = transactions.find(tx => tx.code === code);
  if (!t) {
    return res.status(404).render('pages/order-public', { order: null, settings, rateLimited: false });
  }

  // Whitelist field yang aman ditampilkan publik -- jangan pernah spread
  // seluruh objek transaksi di sini (ada userId, wa, customerName, dll).
  const safeOrder = {
    code: t.code,
    productName: t.productName,
    duration: t.duration,
    price: t.price,
    status: t.status,
    createdAt: t.createdAt,
    key: t.status === 'done' ? (t.key || null) : null,
    downloadLink: t.status === 'done' ? (t.downloadLink || null) : null,
  };

  res.render('pages/order-public', { order: safeOrder, settings, rateLimited: false });
});

app.get('/cek-pesanan', requireAuth, (req, res) => {
  const transactions = readDB('transactions.json');
  const user = getSessionUser(req);
  const settings = readDB('settings.json');

  // Semua transaksi milik user ini, tanpa cap jumlah
  const myTransactions = transactions
    .filter(t => t.userId === req.session.userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.render('pages/cek-pesanan', {
    user, settings,
    transactions: myTransactions
  });
});

// Product routes
// FIX (guest access): dulu requireAuth di sini bikin pengunjung LANGSUNG
// diarahkan ke /login begitu buka link produk, padahal belum tentu mau beli
// -- sekarang halaman produk bisa dilihat tanpa login (getSessionUser sudah
// aman menangani user=null di seluruh handler & template ini). Login baru
// diwajibkan di titik yang benar-benar butuh identitas: POST /create-order
// (requireAuth di sana tetap ada & sudah kirim {redirect:'/login'} yang
// ditangani rapi oleh frontend, lihat buy.ejs).
app.get('/buy/:id', async (req, res) => {
  const [products, settings] = await Promise.all([
    readSmart('products.json'),
    readSmart('settings.json'),
  ]);
  const product = products.find(p => p.id === req.params.id);

  if (!product || product.status !== 'active') {
    return res.redirect('/');
  }

  // settings sudah di-load via Promise.all di atas
  const user = getSessionUser(req);

  const isReseller = !!(user?.is_reseller);
  const resellerDiscount = settings.resellerDiscount || 20;
  const allKeys = product.keys || [];
  const genericKeys = allKeys.filter(k => !k.includes(':'));
  if (product.items) {
    product.items = product.items.map(item => {
      const m = (item.l || '').match(/(\d+)\s+DAYS/i);
      const days = m ? parseInt(m[1]) : null;
      // BUG FIX: varian dengan stockSource 'auto' (Reseller API, unlimited
      // di provider) tidak pakai product.keys sama sekali -- sebelumnya
      // selalu kehitung stok=0 (disabled di halaman beli) walau kredensial
      // & mapping API sudah benar. Cek stockSource per-varian dulu (fallback
      // ke stockMode top-level untuk produk lama, sama seperti
      // resolveStockSourceForDays di allocateKeyAndCompleteTransaction).
      const matchedOptForStock = days ? (product.pricingOptions || []).find(o => o.days === days) : null;
      const variantStockSource = matchedOptForStock?.stockSource || (product.stockMode === 'auto' ? 'auto' : 'manual');
      let stok;
      if (variantStockSource === 'auto') {
        stok = Infinity;
      } else if (days) {
        const tagged = allKeys.filter(k => {
          const parts = k.split(':');
          return parts.length > 1 && parseInt(parts[parts.length - 1]) === days;
        }).length;
        stok = tagged > 0 ? tagged : genericKeys.length;
      } else {
        stok = genericKeys.length;
      }
      // Harga reseller: pakai harga custom per-paket kalau admin sudah set, kalau belum fallback ke diskon global
      const matchedOpt = days ? (product.pricingOptions || []).find(o => o.days === days) : null;
      const customResellerPrice = matchedOpt && matchedOpt.resellerPrice !== undefined ? matchedOpt.resellerPrice : null;
      return {
        ...item,
        stok,
        reseller_price: isReseller ? (customResellerPrice !== null ? customResellerPrice : Math.round(item.p * (1 - resellerDiscount / 100))) : null
      };
    });
  }

  // SECURITY: jangan kirim raw license keys ke client — hanya stok count
  const { keys: _rawKeys, ...productSafe } = product;
  const hasAutoStockBuy = product.stockMode === 'auto' || product.stockMode === 'mixed'
    || (Array.isArray(product.pricingOptions) && product.pricingOptions.some(o => o.stockSource === 'auto'));
  productSafe.stock = hasAutoStockBuy ? Infinity : (allKeys || []).length;
  if (product.items) productSafe.items = product.items; // sudah di-map di atas (sudah aman, tanpa raw keys)

  res.render('pages/buy', { product: productSafe, settings, user, isReseller, userBalance: isReseller ? (user?.balance || 0) : 0,
    usdtManualConfigured: Boolean(
      (settings.binanceSpotManual?.apiKey && settings.binanceSpotManual?.secretKey && settings.binanceSpotManual?.walletAddress)
      || (process.env.BINANCE_SPOT_API_KEY && process.env.BINANCE_SPOT_SECRET_KEY && process.env.USDT_TRC20_WALLET_ADDRESS)
    )
  });
});

app.post('/create-order', requireAuth, async (req, res) => {
  try {
    const { productId, duration, customerName, wa, voucherCode } = req.body;
    const products = await readFresh('products.json');
    const product = products.find(p => p.id === productId);

    if (!product || product.status !== 'active') return res.json({ success: false, message: 'Produk tidak ditemukan' });
    // BUG FIX: pengecekan stok LAMA di sini langsung cek product.keys
    // SEBELUM tahu varian mana yang dipilih -- jadi semua order produk
    // stockSource 'auto' (Reseller API, tidak pakai product.keys sama
    // sekali) selalu ditolak "Stok habis" walau kredensial & mapping API
    // sudah benar. Pengecekan yang benar dipindah ke bawah setelah
    // selectedDays diketahui (lihat resolveStockSourceForDays).

    // Support pricingOptions (deem style: {days,price}) dan items (lama: {l,p})
    let price = 0, selectedDays = null;
    if (product.pricingOptions?.length) {
      // duration bisa berupa label teks ("PRODUK 30 DAYS") atau angka ("30")
      // Coba match by label dulu via items, lalu fallback ke ekstrak angka
      let opt = null;
      const itemMatch = product.items?.find(i => i.l === duration || i.l.includes(duration));
      if (itemMatch) {
        // Cari pricingOptions yang cocok dengan price dari items
        opt = product.pricingOptions.find(o => o.price === itemMatch.p);
        if (!opt) { price = itemMatch.p; const m = duration.match(/(\d+)/); selectedDays = m ? parseInt(m[1]) : null; }
        else { price = opt.price; selectedDays = opt.days; }
      } else {
        // Fallback: parseInt langsung (untuk case duration dikirim sebagai angka)
        const days = parseInt(duration);
        opt = product.pricingOptions.find(o => o.days === days);
        if (!opt) return res.json({ success: false, message: 'Durasi tidak valid' });
        price = opt.price; selectedDays = days;
      }
    } else {
      const opt = product.items?.find(i => i.l.includes(duration));
      if (!opt) return res.json({ success: false, message: 'Durasi tidak valid' });
      price = opt.p;
      const m = duration.match(/(\d+)/); selectedDays = m ? parseInt(m[1]) : null;
    }

    // Pengecekan stok yang benar: cek sumber stok VARIAN yang dipilih.
    // Auto (Reseller API) dianggap selalu ada stok di titik ini -- generate
    // key beneran (dan kegagalannya) ditangani di allocateKeyAndCompleteTransaction
    // saat pembayaran sukses, bukan di sini.
    const orderStockSource = resolveStockSourceForDays(product, selectedDays);
    if (orderStockSource !== 'auto' && (!product.keys || product.keys.length === 0)) {
      return res.json({ success: false, message: 'Stok habis' });
    }

    const settings = readDB('settings.json');
    // Terapkan harga reseller: pakai harga custom per-paket kalau admin sudah set, kalau belum fallback ke diskon global
    const orderUser = getSessionUser(req);
    if (orderUser?.is_reseller) {
      const matchedOpt = selectedDays ? product.pricingOptions?.find(o => o.days === selectedDays) : null;
      if (matchedOpt && matchedOpt.resellerPrice !== undefined) {
        price = matchedOpt.resellerPrice;
      } else {
        const disc = settings.resellerDiscount || 20;
        price = Math.round(price * (1 - disc / 100));
      }
    }

    // Terapkan voucher (setelah diskon reseller)
    let voucherDiscount = 0, appliedVoucher = null, originalPrice = price;
    if (voucherCode && voucherCode.trim()) {
      const vResult = await validateVoucher(voucherCode, price, req.session.userId);
      if (vResult.valid) {
        voucherDiscount = vResult.discount;
        price = vResult.finalPrice;
        appliedVoucher = vResult.voucher;
      } else {
        return res.json({ success: false, message: 'Voucher: ' + vResult.error });
      }
    }

    // ── BAYAR PAKAI SALDO RESELLER: langsung potong saldo & kirim key tanpa QRIS ──
    if (req.body.paymentMethod === 'balance') {
      // RACE CONDITION FIX: kunci per-user supaya 2 request bareng tidak
      // double-spend saldo yang sama. processingOrders sudah ada sebagai
      // Set global — pakai prefix 'bal-' + userId biar per-user tanpa
      // bentrok dengan lock transaksi lain.
      const balLockKey = 'bal-' + req.session.userId;
      if (processingOrders.has(balLockKey)) {
        return res.json({ success: false, message: 'Sedang memproses pembayaran lain. Tunggu sebentar.' });
      }
      processingOrders.add(balLockKey);
      try {
        if (!orderUser?.is_reseller) return res.json({ success: false, message: 'Bayar pakai saldo hanya untuk Reseller VIP' });
        const usersBal = await readFresh('users.json');
        const uBal = usersBal.find(u => u.id === req.session.userId);
        if (!uBal) return res.json({ success: false, message: 'User tidak ditemukan' });
        if ((uBal.balance || 0) < price) {
          return res.json({ success: false, message: `Saldo tidak cukup. Saldo kamu Rp${(uBal.balance || 0).toLocaleString('id-ID')}, harga Rp${price.toLocaleString('id-ID')}` });
        }

        const transactionsBal = await readFresh('transactions.json');
        const existingPendingBal = transactionsBal.find(t =>
          t.userId === req.session.userId && t.productId === productId && t.status === 'pending' &&
          (Date.now() - new Date(t.createdAt).getTime()) < 30 * 60 * 1000
        );
        if (existingPendingBal) return res.json({ success: false, message: 'Kamu masih memiliki pesanan pending untuk produk ini. Selesaikan atau tunggu 30 menit.' });

        const orderIdBal = `HM-${Date.now()}`;
        const refIdBal = uuidv4();
        const orderCodeBal = generateOrderCode();
        const newTxn = {
          id: refIdBal, orderId: orderIdBal, code: orderCodeBal,
          userId: req.session.userId, productId: product.id, productName: product.name,
          duration, selectedDays,
          originalPrice: voucherDiscount > 0 ? originalPrice : undefined,
          voucherCode: appliedVoucher ? appliedVoucher.code : undefined,
          voucherDiscount: voucherDiscount > 0 ? voucherDiscount : undefined,
          price, totalPayment: price,
          customerName, wa, qrString: null, isStatic: false, paymentMethod: 'balance',
          status: 'pending', key: null,
          createdAt: new Date().toISOString(), time: formatDate()
        };
        transactionsBal.push(newTxn);
        uBal.balance = (uBal.balance || 0) - price;
        await Promise.all([writeDB('users.json', usersBal), writeDB('transactions.json', transactionsBal)]);

        if (appliedVoucher) {
          const vouchers = await readFresh('vouchers.json');
          const v = vouchers.find(v => v.id === appliedVoucher.id);
          if (v) {
            v.usedCount = (v.usedCount || 0) + 1;
            v.usages = v.usages || [];
            v.usages.push({ userId: req.session.userId, usedAt: new Date().toISOString(), orderId: refIdBal });
            await writeDB('vouchers.json', vouchers);
          }
        }

        const result = await allocateKeyAndCompleteTransaction(newTxn, transactionsBal);
        const finalBalance = result.status === 'failed' && result.refunded ? result.balance : uBal.balance;
        return res.json({
          success: result.status !== 'failed',
          paidWithBalance: true,
          balance: finalBalance,
          refId: refIdBal, orderId: orderIdBal, orderCode: orderCodeBal,
          ...result,
          message: result.status === 'failed' ? (result.error || 'Gagal memproses pesanan, saldo sudah dikembalikan') : undefined
        });
      } finally {
        processingOrders.delete(balLockKey);
      }
    }

    const qrisMode = settings.qrisMode || 'static';
    const orderId = `HM-${Date.now()}`;
    const refId = uuidv4();
    const orderCode = generateOrderCode();

    let qrString = null, isStatic = false, totalPayment = price, expiredAt = null;

    if (qrisMode === 'static') {
      if (!settings.qrisStaticImage) return res.json({ success: false, message: 'Upload gambar QRIS di admin panel terlebih dahulu.' });
      isStatic = true;
    } else {
      try {
        const r = await createQRISPayment(orderId, price, settings, `${getAppBaseUrl(req)}/webhook/genspay`);
        qrString = r.qr_string;
        totalPayment = r.total_payment || price;
        expiredAt = r.expired_at || null;
      } catch (error) {
        console.error('[create-order/buy] GensPay gagal, fallback ke QRIS statis:', error.message);
        if (settings.qrisStaticImage) { isStatic = true; }
        else return res.json({ success: false, message: 'QRIS API error: ' + error.message });
      }
    }

    const transactions = await readFresh('transactions.json');

    // Cegah transaksi duplikat: tolak jika ada pending untuk produk yang sama dalam 30 menit
    const existingPending = transactions.find(t =>
      t.userId === req.session.userId &&
      t.productId === productId &&
      t.status === 'pending' &&
      (Date.now() - new Date(t.createdAt).getTime()) < 30 * 60 * 1000
    );
    if (existingPending) {
      return res.json({ success: false, message: 'Kamu masih memiliki pesanan pending untuk produk ini. Selesaikan pembayaran atau tunggu 30 menit.' });
    }

    transactions.push({
      id: refId, orderId, code: orderCode,
      userId: req.session.userId, productId: product.id, productName: product.name,
      duration, selectedDays,
      originalPrice: voucherDiscount > 0 ? originalPrice : undefined,
      voucherCode: appliedVoucher ? appliedVoucher.code : undefined,
      voucherDiscount: voucherDiscount > 0 ? voucherDiscount : undefined,
      price, totalPayment,
      customerName, wa, qrString, isStatic,
      status: 'pending', key: null,
      createdAt: new Date().toISOString(), time: formatDate()
    });
    await writeDB('transactions.json', transactions);

    // Catat pemakaian voucher jika dipakai
    if (appliedVoucher) {
      const vouchers = await readFresh('vouchers.json');
      const v = vouchers.find(v => v.id === appliedVoucher.id);
      if (v) {
        v.usedCount = (v.usedCount || 0) + 1;
        v.usages = v.usages || [];
        v.usages.push({ userId: req.session.userId, usedAt: new Date().toISOString(), orderId: refId });
        await writeDB('vouchers.json', vouchers);
      }
    }

    res.json({ success: true, refId, orderId, qrString, orderCode, isStatic, totalPayment, expiredAt,
      voucherDiscount: voucherDiscount || undefined,
      qrisStaticImage: isStatic ? settings.qrisStaticImage : null });
  } catch (error) {
    console.error('[create-order] error:', error.message);
    res.json({ success: false, message: 'Terjadi kesalahan: ' + error.message });
  }
});

// ── Helper: alokasikan key & selesaikan transaksi setelah pembayaran terkonfirmasi ──
// Dipakai bersama oleh QRIS (check-payment) dan NOWPayments (webhook)
// ══════════════════════════════════════════════════════════════════
// RESELLER API (Auto Stock) — porting dari proyek GNE dengan metode yang
// sama persis: HMAC-SHA256 signing, auto-match by nama produk + hari,
// mapping per-varian (pricingOptions[i].stockSource/resellerItemId) dengan
// fallback ke stockMode top-level untuk produk lama. Lihat reseller-api.js
// untuk detail lengkap algoritma & prioritas resolusi.
// ══════════════════════════════════════════════════════════════════

// Tentukan sumber stok untuk 1 varian/paket spesifik. Prioritas:
//   1. pricingOptions[i].stockSource -- per-varian eksplisit.
//   2. Fallback ke product.stockMode top-level (produk lama / belum
//      dimigrasi ke skema per-varian).
function resolveStockSourceForDays(product, selectedDays) {
  if (selectedDays && Array.isArray(product.pricingOptions)) {
    const opt = product.pricingOptions.find(o => o.days === selectedDays);
    if (opt && opt.stockSource) return opt.stockSource;
    // BUG FIX: kalau opt ketemu tapi stockSource-nya kosong/undefined (produk
    // lama sebelum field ini ada, atau data korup), JANGAN langsung jatuh ke
    // fallback stockMode top-level -- itu yang menyebabkan "Stok habis" palsu
    // untuk produk stockMode:'mixed' (sebagian varian auto, sebagian manual).
    // Kalau opt punya resellerItemId ter-mapping, itu bukti kuat varian ini
    // dimaksudkan 'auto' walau field stockSource-nya lupa/gagal ke-set.
    if (opt && opt.resellerItemId) return 'auto';
  }
  // product.stockMode 'mixed' berarti CAMPURAN per-varian -- top-level ini
  // TIDAK BOLEH dipakai sebagai fallback tunggal untuk 1 varian spesifik
  // (beda varian bisa beda sumber stok). 'mixed' hanya valid dibaca sebagai
  // ringkasan tampilan, bukan keputusan untuk 1 hari tertentu -- di sini
  // fallback aman untuk 'mixed' adalah 'manual' HANYA kalau memang tidak ada
  // resellerItemId ter-mapping di manapun (dicek di atas duluan).
  return product.stockMode === 'auto' ? 'auto' : 'manual';
}

// Helper: cek apakah 1 resellerItemId adalah ID dari sistem MULTI-PROVIDER
// baru (format "mp:providerInstanceId:providerProductId") vs ID legacy
// (angka murni dari reseller-api.js / vipibmstore.com).
function parseMultiProviderItemId(resellerItemId) {
  if (typeof resellerItemId !== 'string' || !resellerItemId.startsWith('mp:')) return null;
  const parts = resellerItemId.split(':');
  if (parts.length !== 3) return null;
  return { providerInstanceId: parts[1], providerProductId: parts[2] };
}

// Generate key dari sistem MULTI-PROVIDER (createOrder -> tunggu delivery).
// Beberapa provider balikin key langsung di response createOrder (instant),
// yang lain baru kirim lewat webhook belakangan (async) -- untuk kasus
// checkout yang butuh jawaban sinkron, kita polling getOrderStatus
// beberapa kali dengan jeda pendek sebelum menyerah dan menandai transaksi
// 'processing' (bukan gagal) supaya webhook masih bisa menyelesaikannya nanti.
async function generateAutoKeyMultiProvider(providerInstanceId, providerProductId, ctx = {}) {
  // FIX (silent failure): bungkus SELURUH proses createOrder + polling dalam
  // try-catch tunggal di level fungsi ini. Sebelumnya kalau ada exception
  // TIDAK TERDUGA di sepanjang alur (bukan di dalam adapter -- misal
  // providerStore.callAdapter sendiri throw karena provider instance sudah
  // dihapus di tengah proses, atau error lain yang bukan dari
  // request/response provider), exception itu akan MELAYANG ke pemanggil
  // tanpa pernah tercatat ke Log API sama sekali (karena logApiCall cuma
  // dipanggil DI DALAM callAdapter, dan callAdapter sendiri bisa throw
  // SEBELUM sempat mencatat kalau errornya terjadi di luar adapter.method()).
  // Sekarang exception apa pun di sini tetap dicatat manual sebagai log
  // action 'createOrder' dengan success:false, supaya "tidak ada log sama
  // sekali" tidak akan terjadi lagi -- SELALU ada jejak, entah dari adapter
  // atau dari catch ini.
  try {
    const createResult = await providerStore.callAdapter(providerInstanceId, 'createOrder', {
      providerProductId,
      quantity: 1,
      customerRef: ctx.customerReference,
      params: { customerName: ctx.target, customerEmail: ctx.customerEmail },
    });

    if (!createResult.success) {
      // Pesan asli dari provider (mis. "Saldo reseller tidak cukup.",
      // "Stok key tidak mencukupi.") SELALU diteruskan apa adanya -- tidak
      // pernah ditimpa jadi generik selama providerStore/adapter berhasil
      // mengembalikan message. Fallback generik HANYA dipakai kalau field
      // message itu sendiri benar-benar kosong (provider tidak kasih alasan
      // sama sekali).
      return {
        key: null,
        error: createResult.message || `Order ditolak provider (kode: ${createResult.code || 'tidak diketahui'}).`,
        providerOrderId: null,
      };
    }

    // Sudah langsung sukses + ada delivery key di respons createOrder itu sendiri
    if (createResult.status === 'success' && (createResult.deliveryKey || createResult.deliveryLink)) {
      // Kirim key DAN link sekaligus (kalau dua-duanya ada) -- dulu link
      // cuma dipakai fallback kalau key kosong, padahal CGO selalu kasih
      // dua-duanya (key + link grup Telegram download), dan keduanya
      // berguna buat pembeli (poin #3 permintaan perbaikan).
      return {
        key: createResult.deliveryKey || createResult.deliveryLink,
        downloadLink: createResult.deliveryLink || null,
        error: null,
        providerOrderId: createResult.providerOrderId,
      };
    }

    // Belum sukses instan -- polling getOrderStatus beberapa kali (total ~10 detik)
    // sebelum menyerah. Kalau order masih 'pending'/'processing' setelah itu,
    // biarkan diselesaikan oleh webhook /webhook/provider/:id belakangan.
    const providerOrderId = createResult.providerOrderId;
    if (providerOrderId) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        const statusResult = await providerStore.callAdapter(providerInstanceId, 'getOrderStatus', providerOrderId);
        if (statusResult.success && statusResult.status === 'success') {
          return {
            key: statusResult.deliveryKey || statusResult.deliveryLink,
            downloadLink: statusResult.deliveryLink || null,
            error: null,
            providerOrderId,
          };
        }
        if (statusResult.success && statusResult.status === 'failed') {
          return { key: null, error: statusResult.message || `Order ditolak provider saat diproses (order_id: ${providerOrderId}).`, providerOrderId };
        }
        // status masih pending/processing -- lanjut polling
      }
    }

    // Masih belum selesai setelah polling -- bukan error permanen, order tetap
    // jalan di sisi provider dan webhook akan menyelesaikannya. Caller (checkout)
    // akan menandai transaksi sebagai 'processing' lewat providerOrderId ini.
    return { key: null, error: null, pending: true, providerOrderId };
  } catch (e) {
    // Exception tak terduga (network putus total, provider instance hilang
    // di tengah proses, dll) -- catat manual ke Log API supaya tetap ada
    // jejak, walau providerStore.callAdapter sendiri tidak sempat mencatatnya.
    console.error('[generateAutoKeyMultiProvider] exception tak terduga:', e.message);
    try {
      const provider = providerStore.getProvider(providerInstanceId);
      await providerStore.logApiCall({
        providerInstanceId,
        providerLabel: provider?.name || 'unknown',
        action: 'createOrder',
        request: { providerProductId, customerRef: ctx.customerReference },
        response: { success: false, exception: e.message },
        success: false,
      });
    } catch (logErr) {
      console.error('[generateAutoKeyMultiProvider] gagal mencatat log fallback:', logErr.message);
    }
    return { key: null, error: `Terjadi kesalahan sistem saat memproses order: ${e.message}`, providerOrderId: null };
  }
}

// Generate 1 key dari Reseller API untuk transaksi yang stockSource-nya
// 'auto'. Dipanggil dari allocateKeyAndCompleteTransaction (checkout
// otomatis) dan dari jalur admin-confirm manual (baris ~2200-an).
// Return { key, error } -- key null + error terisi kalau gagal (caller
// harus tangani, JANGAN fallback diam-diam ke key palsu seperti sebelumnya).
async function generateAutoKey(product, selectedDays, ctx = {}) {
  // readFresh (bukan readSmart) -- ini jalur uang/pembayaran, kredensial
  // API harus selalu yang terbaru, tidak boleh kena TTL cache 8 detik dari
  // readSmart (kalau admin baru ubah kredensial, transaksi berikutnya harus
  // langsung pakai yang baru, bukan cache basi). Konsisten dengan pola GNE.
  const settings = await readFresh('settings.json');
  const resolved = await resellerApi.resolveItemId(settings, product, selectedDays);
  if (!resolved.itemId) {
    return { key: null, error: resolved.error || 'Produk mode Auto belum bisa di-mapping ke Reseller Item ID.' };
  }

  // Cabang MULTI-PROVIDER: item ID berformat "mp:providerInstanceId:productId"
  // -- arahkan ke adapter provider yang bersangkutan, BUKAN ke reseller-api.js
  // lama (yang hardcoded ke vipibmstore.com).
  const mp = parseMultiProviderItemId(resolved.itemId);
  if (mp) {
    const mpResult = await generateAutoKeyMultiProvider(mp.providerInstanceId, mp.providerProductId, ctx);
    return mpResult;
  }

  const result = await resellerApi.orderKey(settings, {
    productItemId: resolved.itemId,
    quantity: 1,
    customerReference: ctx.customerReference,
    target: ctx.target,
    idempotencyKey: ctx.idempotencyKey
  });
  if (result.success) {
    const key = result.data?.codes?.[0] || null;
    return { key, error: key ? null : 'Provider tidak mengembalikan key' };
  }
  return { key: null, error: result.message || 'Gagal generate key dari Reseller API', code: result.code };
}


const allocateKeyAndCompleteTransaction = async (transaction, transactions) => {
  // GUARD: transaksi yang statusnya sudah 'processing' berarti order sudah
  // terlanjur dibuat ke provider multi-provider (createOrder sukses, tinggal
  // menunggu webhook/getOrderStatus menyelesaikan) -- JANGAN panggil
  // generateAutoKey lagi di sini, itu akan membuat order KEDUA ke provider
  // untuk transaksi yang sama (dobel biaya di sisi reseller). Cukup
  // laporkan status apa adanya, biarkan webhook yang menyelesaikan.
  if (transaction.status === 'processing') {
    return { status: 'processing', type: 'auto-provider-pending' };
  }

  if (transaction.type === 'reseller') {
    const users = await readSmart('users.json');
    const u = users.find(u => u.id === transaction.userId);
    if (u) {
      u.is_reseller = true;
      u.role = 'reseller';
      u.reseller_since = new Date().toISOString();
      u.reseller_code = 'RSL-' + u.username.toUpperCase().slice(0, 4) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
      await writeDB('users.json', users);
    }
    transaction.status = 'done';
    transaction.paidAt = new Date().toISOString();
    await writeDB('transactions.json', transactions);
    return { status: 'done', type: 'reseller' };
  }

  if (transaction.type === 'topup') {
    const users = await readSmart('users.json');
    const u = users.find(u => u.id === transaction.userId);
    if (u) {
      u.balance = (u.balance || 0) + transaction.price + (transaction.bonus || 0);
      await writeDB('users.json', users);
    }
    transaction.status = 'done';
    transaction.paidAt = new Date().toISOString();
    await writeDB('transactions.json', transactions);
    return { status: 'done', type: 'topup', balance: u ? u.balance : undefined, bonus: transaction.bonus || 0 };
  }

  const products = await readFresh('products.json');
  const product = products.find(p => p.id === transaction.productId);
  let key = null;
  let productsChanged = false;
  let allocationError = null;

  const stockSource = product ? resolveStockSourceForDays(product, transaction.selectedDays) : 'manual';

  if (stockSource === 'auto') {
    // RESELLER API (Auto Stock) — generate key on-demand dari provider.
    // idempotencyKey = id transaksi (stabil per transaksi, jadi retry/dobel
    // callback pembayaran tidak generate 2 key / motong saldo reseller 2x).
    const genResult = await generateAutoKey(product, transaction.selectedDays, {
      customerReference: transaction.id,
      target: transaction.customerName || transaction.wa || undefined,
      idempotencyKey: transaction.id
    });
    if (genResult.key) {
      key = genResult.key;
      if (genResult.downloadLink) transaction.downloadLink = genResult.downloadLink;
      product.sold = (product.sold || 0) + 1;
      bumpDummySold(product);
      productsChanged = true;
    } else if (genResult.pending) {
      // MULTI-PROVIDER: order sudah dibuat di sisi provider tapi belum
      // selesai (belum ada key/link) setelah polling singkat. BUKAN gagal --
      // simpan providerOrderId di transaksi & tandai 'processing', lalu
      // webhook /webhook/provider/:id yang akan menyelesaikannya belakangan
      // (lihat handler webhook: cari transaksi by providerOrderId, isi
      // transaction.key, set status 'done').
      transaction.status = 'processing';
      transaction.providerOrderId = genResult.providerOrderId || null;
      await writeDB('transactions.json', transactions);
      return { status: 'processing', type: 'auto-provider-pending' };
    } else {
      // JANGAN fallback ke key palsu (perilaku lama) -- kalau generate gagal,
      // transaksi harus ditandai gagal supaya admin/reseller tahu & bisa
      // retry, bukan diam-diam dapat key yang tidak valid.
      allocationError = genResult.error || 'Gagal generate key dari Reseller API';
    }
  } else if (product?.keys?.length > 0) {
    const days = transaction.selectedDays;
    if (days) {
      const idx = product.keys.findIndex(k => {
        const parts = k.split(':');
        return parts.length > 1 && parseInt(parts[parts.length - 1]) === days;
      });
      if (idx !== -1) { key = product.keys.splice(idx, 1)[0].split(':')[0]; }
    }
    if (!key) {
      const idx = product.keys.findIndex(k => !k.includes(':'));
      if (idx !== -1) key = product.keys.splice(idx, 1)[0];
      else key = product.keys.shift().split(':')[0]; // fallback terakhir: tetap bersihkan suffix :DAYS biar key yang dikirim valid
    }
    product.sold = (product.sold || 0) + 1;
    bumpDummySold(product);
    productsChanged = true;
  } else {
    // Stok manual habis (product.keys kosong) dan bukan mode auto -- JANGAN
    // generate key palsu (HM-timestamp-random, perilaku lama yang bikin
    // transaksi "sukses" padahal customer dapat key tidak valid). Tandai
    // gagal supaya masuk status='failed' dan kelihatan di admin sebagai
    // "❌ Gagal (Stok Habis)", bukan nyasar ke Pending biasa.
    allocationError = 'Stok key habis untuk produk ini. Silakan tambah stok lalu klik Konfirmasi Bayar lagi.';
  }

  if (allocationError) {
    transaction.status = 'failed';
    transaction.failReason = allocationError;
    // REFUND: kalau transaksi ini dibayar pakai saldo internal (bukan
    // QRIS/NOWPayments eksternal), saldo SUDAH dipotong di muka sebelum fungsi
    // ini dipanggil (lihat endpoint checkout saldo). Generate key gagal =
    // user harus dikembalikan uangnya, bukan kehilangan saldo tanpa dapat
    // apa-apa. Untuk QRIS/NOWPayments, uang belum masuk ke sistem internal kita
    // sama sekali jadi tidak ada yang perlu di-refund di sisi kita.
    let refundedBalance = null;
    if (transaction.paymentMethod === 'balance') {
      const usersRefund = await readFresh('users.json');
      const uRefund = usersRefund.find(u => u.id === transaction.userId);
      if (uRefund) {
        uRefund.balance = (uRefund.balance || 0) + transaction.price;
        refundedBalance = uRefund.balance;
        await writeDB('users.json', usersRefund);
      }
    }
    await writeDB('transactions.json', transactions);
    return { status: 'failed', error: allocationError, refunded: transaction.paymentMethod === 'balance', balance: refundedBalance };
  }

  transaction.status = 'done';
  transaction.key = key;
  transaction.paidAt = new Date().toISOString();

  const notifs = readDB('notifications.json');
  const buyer = readDB('users.json').find(u => u.id === transaction.userId);
  notifs.unshift({ id: uuidv4(), type: 'purchase', buyerName: transaction.customerName,
    buyerPhoto: buyer?.photo || null, productName: transaction.productName,
    price: transaction.price, time: transaction.paidAt, timeStr: formatDate(new Date(transaction.paidAt)) });

  // Write independen (products/transactions/notifications) dijalankan paralel, bukan berurutan,
  // supaya latency total = write paling lambat, bukan jumlah semuanya. Tetap di-await semua
  // (bukan fire-and-forget) supaya aman dari risiko data hilang di Vercel serverless.
  await Promise.all([
    productsChanged ? writeDB('products.json', products) : Promise.resolve(),
    writeDB('transactions.json', transactions),
    writeDB('notifications.json', notifs.slice(0, 50)),
  ]);
  cacheInvalidate('api:notifications'); // invalidate cache agar notif langsung muncul

  return { status: 'done', key, code: transaction.code };
};

// ── NOWPayments: helper ambil kredensial ──
// Kredensial diambil dari settings.json (diatur lewat panel admin), fallback ke .env kalau belum diisi di admin
const getNOWPaymentsConfig = (settings) => {
  const cfg = settings?.nowpayments || {};
  const apiKey = cfg.apiKey || process.env.NOWPAYMENTS_API_KEY || '';
  const ipnSecret = cfg.ipnSecret || process.env.NOWPAYMENTS_IPN_SECRET || '';
  const payCurrency = (cfg.payCurrency || process.env.NOWPAYMENTS_PAY_CURRENCY || 'usdtt').toLowerCase();
  const base = 'https://api.nowpayments.io/v1';
  return { apiKey, ipnSecret, payCurrency, base };
};

// Urutkan key object secara rekursif (alfabetis) -- WAJIB oleh NOWPayments
// sebelum JSON.stringify + HMAC-SHA512 untuk verifikasi signature webhook (IPN).
const sortObjectKeys = (obj) => {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (obj && typeof obj === 'object') {
    return Object.keys(obj).sort().reduce((acc, key) => {
      acc[key] = sortObjectKeys(obj[key]);
      return acc;
    }, {});
  }
  return obj;
};

// ── NOWPayments: buat transaksi/invoice pembayaran crypto ──
const createNOWPayment = async (settings, transaction, baseUrl) => {
  const { apiKey, payCurrency, base } = getNOWPaymentsConfig(settings);
  if (!apiKey) throw new Error('NOWPayments belum dikonfigurasi. Isi API Key di panel admin.');

  const resp = await fetch(`${base}/payment`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      price_amount: transaction.totalPayment || transaction.price,
      price_currency: 'idr',
      pay_currency: payCurrency,
      order_id: transaction.orderId,
      order_description: `${transaction.productName} - ${transaction.duration || ''}`.slice(0, 127),
      ipn_callback_url: baseUrl ? `${baseUrl}/webhook/nowpayments` : undefined
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || data.code || 'Gagal membuat transaksi NOWPayments');
  return data;
};

// ══════════════════════════════════════════════════════════════════════
// ── Binance Pay ──
// ══════════════════════════════════════════════════════════════════════
// Kredensial diambil dari settings.json (diatur lewat panel admin), fallback ke .env
// ── USDT MANUAL (Binance Spot Read-Only API) ──────────────────────────────
// Pengganti Binance Pay Merchant untuk akun yang belum punya KYC bisnis.
// Alur: bikin nominal unik (+3 digit random desimal) -> tampilkan wallet
// TRC20 statis milik klien -> frontend polling /check-payment seperti biasa
// -> di /check-payment kita cek histori deposit Binance Spot (BUKAN webhook,
// karena akun personal tidak bisa terima webhook Binance Pay).
const getBinanceSpotConfig = (settings) => {
  const cfg = settings?.binanceSpotManual || {};
  const apiKey = cfg.apiKey || process.env.BINANCE_SPOT_API_KEY || '';
  const secretKey = cfg.secretKey || process.env.BINANCE_SPOT_SECRET_KEY || '';
  const walletAddress = cfg.walletAddress || process.env.USDT_TRC20_WALLET_ADDRESS || '';
  const network = (cfg.network || 'TRX').toUpperCase(); // TRX = jaringan TRC20
  const coin = (cfg.coin || 'USDT').toUpperCase();
  const base = 'https://api.binance.com';
  return { apiKey, secretKey, walletAddress, network, coin, base };
};

// Signature Spot API BEDA dari signBinancePay (Binance Pay) di bawah:
// HMAC-SHA256 atas query string, hex LOWERCASE, tanpa nonce -- cuma timestamp.
function signBinanceSpotQuery(secretKey, queryString) {
  return crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
}

async function binanceSpotSignedGet(endpoint, params, config) {
  const { apiKey, secretKey, base } = config;
  if (!apiKey || !secretKey) {
    throw new Error('Binance Spot API belum dikonfigurasi. Isi API Key & Secret Key (Read-Only) di panel admin atau ENV.');
  }
  const fullParams = { ...params, timestamp: Date.now(), recvWindow: 10000 };
  const queryString = new URLSearchParams(fullParams).toString();
  const signature = signBinanceSpotQuery(secretKey, queryString);
  const url = `${base}${endpoint}?${queryString}&signature=${signature}`;

  const resp = await fetch(url, { headers: { 'X-MBX-APIKEY': apiKey } });
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = data?.msg || `Binance Spot API error (HTTP ${resp.status})`;
    const err = new Error(msg);
    err.binanceCode = data?.code;
    throw err;
  }
  return data;
}

// Konversi IDR -> USDT pakai harga pasar Binance (USDT/IDR), supaya nominal
// unik yang di-generate akurat terhadap rate saat ini -- BUKAN endpoint
// SIGNED (tidak butuh API key sama sekali, murni public market data).
// Di-cache 60 detik: rate USDT/IDR tidak berubah drastis dalam semenit,
// dan ini mengurangi 1 request Binance tambahan per checkout.
let usdtIdrRateCache = { rate: null, fetchedAt: 0 };
const USDT_IDR_RATE_CACHE_TTL_MS = 60000;

async function getUsdtToIdrRate() {
  const now = Date.now();
  if (usdtIdrRateCache.rate && (now - usdtIdrRateCache.fetchedAt) < USDT_IDR_RATE_CACHE_TTL_MS) {
    return usdtIdrRateCache.rate;
  }
  const resp = await fetch('https://api.binance.com/api/v3/avgPrice?symbol=USDTIDR');
  const data = await resp.json();
  const rate = parseFloat(data?.price);
  if (!rate || Number.isNaN(rate)) {
    // Fallback: kalau pair USDTIDR tidak tersedia/gagal, jangan biarkan checkout
    // gagal total -- pakai cache lama kalau ada, atau lempar error yang jelas.
    if (usdtIdrRateCache.rate) return usdtIdrRateCache.rate;
    throw new Error('Gagal mengambil kurs USDT/IDR dari Binance.');
  }
  usdtIdrRateCache = { rate, fetchedAt: now };
  return rate;
}

// Nominal unik: harga asli (IDR) dikonversi ke USDT dulu, dibulatkan ke 2
// desimal, BARU ditambah 3 digit random sebagai desimal ke-3/4/5
// (4.87 -> 4.87042). String-based supaya presisi floating point tidak geser.
async function generateUniqueUsdtAmount(baseAmountIdr) {
  const rate = await getUsdtToIdrRate();
  const baseUsdt = baseAmountIdr / rate;
  const baseRounded = (Math.floor(baseUsdt * 100) / 100).toFixed(2); // selalu "X.YY", floor supaya tidak kemahalan
  const randomSuffix = String(Math.floor(Math.random() * 900) + 100); // selalu 3 digit (100-999)
  return parseFloat(`${baseRounded}${randomSuffix}`);
}

// Cache histori deposit 5 detik -- sama alasan dengan genspayStatusCache di
// atas: cegah N pembeli polling bersamaan memicu N request/beberapa detik ke
// Binance dari IP server yang sama (Binance juga bisa flag pola ini).
const binanceDepositCache = { data: null, fetchedAt: 0 };
const BINANCE_DEPOSIT_CACHE_TTL_MS = 5000;

async function getUsdtDepositHistoryCached(config) {
  const now = Date.now();
  if (binanceDepositCache.data && (now - binanceDepositCache.fetchedAt) < BINANCE_DEPOSIT_CACHE_TTL_MS) {
    return binanceDepositCache.data;
  }
  const data = await binanceSpotSignedGet('/sapi/v1/capital/deposit/hisrec', {
    coin: config.coin, status: 1, limit: 100,
  }, config);
  const list = Array.isArray(data) ? data : [];
  binanceDepositCache.data = list;
  binanceDepositCache.fetchedAt = now;
  return list;
}

async function findMatchingUsdtDeposit(targetAmount, config) {
  const deposits = await getUsdtDepositHistoryCached(config);
  const EPSILON = 1e-7;
  return deposits.find((d) => {
    const amount = parseFloat(d.amount);
    const sameNetwork = !config.network || (d.network && d.network.toUpperCase() === config.network.toUpperCase());
    return sameNetwork && Math.abs(amount - targetAmount) <= EPSILON;
  }) || null;
}

const getBinancePayConfig = (settings) => {
  const cfg = settings?.binancepay || {};
  const apiKey = cfg.apiKey || process.env.BINANCEPAY_API_KEY || '';
  const secretKey = cfg.secretKey || process.env.BINANCEPAY_SECRET_KEY || '';
  const currency = (cfg.currency || process.env.BINANCEPAY_CURRENCY || 'IDR').toUpperCase();
  const base = 'https://bpay.binanceapi.com';
  return { apiKey, secretKey, currency, base };
};

// Signature request KELUAR (ke Binance) pakai HMAC-SHA512 atas string
// timestamp + "\n" + nonce + "\n" + body + "\n", di-uppercase hex, pakai
// Secret Key merchant. Dipakai baik utk Create Order maupun Query Certificate.
// PENTING: ini BEDA dari verifikasi webhook MASUK (lihat verifyBinancePaySignature
// di bawah) yang pakai RSA + public key Binance, BUKAN HMAC ini.
function signBinancePay(secretKey, timestamp, nonce, body) {
  const payload = `${timestamp}\n${nonce}\n${body}\n`;
  return crypto.createHmac('sha512', secretKey).update(payload).digest('hex').toUpperCase();
}

const createBinancePayOrder = async (settings, transaction, baseUrl) => {
  const { apiKey, secretKey, currency, base } = getBinancePayConfig(settings);
  if (!apiKey || !secretKey) throw new Error('Binance Pay belum dikonfigurasi. Isi API Key & Secret Key di panel admin.');

  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyObj = {
    env: { terminalType: 'WEB' },
    merchantTradeNo: transaction.orderId,
    orderAmount: Number(transaction.totalPayment || transaction.price),
    currency, // default IDR -- kalau akun merchant belum di-approve utk fiat IDR, ganti ke USDT di admin
    description: (transaction.productName || 'Pembelian produk').slice(0, 256), // wajib di Create Order v3
    goods: {
      goodsType: '02', // 02 = virtual product (cocok utk key/lisensi digital)
      goodsCategory: 'Z000',
      referenceGoodsId: String(transaction.productId || transaction.id).slice(0, 32),
      goodsName: (transaction.productName || 'Produk').slice(0, 256)
    },
    webhookUrl: baseUrl ? `${baseUrl}/webhook/binancepay` : undefined
  };
  const body = JSON.stringify(bodyObj);
  const signature = signBinancePay(secretKey, timestamp, nonce, body);

  const resp = await fetch(`${base}/binancepay/openapi/v3/order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'BinancePay-Timestamp': timestamp,
      'BinancePay-Nonce': nonce,
      'BinancePay-Certificate-SN': apiKey,
      'BinancePay-Signature': signature
    },
    body
  });
  const data = await resp.json();
  if (!resp.ok || data.status !== 'SUCCESS' || !data.data) {
    throw new Error(data.errorMessage || data.status || `Binance Pay error (HTTP ${resp.status})`);
  }
  return data.data; // { prepayId, expireTime, qrcodeLink, qrContent, checkoutUrl, deeplink, universalUrl }
};

// ── Binance Pay: cache sertifikat publik RSA milik Binance (buat verifikasi
// signature webhook MASUK -- lihat catatan di signBinancePay di atas kenapa
// ini bukan HMAC) ──
let binancePayCertCache = { certPublic: null, certSerial: null, fetchedAt: 0 };
const BINANCEPAY_CERT_TTL_MS = 24 * 60 * 60 * 1000; // cache 24 jam, cert Binance jarang berubah

async function getBinancePayCertificate(settings) {
  const now = Date.now();
  if (binancePayCertCache.certPublic && (now - binancePayCertCache.fetchedAt) < BINANCEPAY_CERT_TTL_MS) {
    return binancePayCertCache;
  }
  const { apiKey, secretKey, base } = getBinancePayConfig(settings);
  if (!apiKey || !secretKey) throw new Error('Binance Pay belum dikonfigurasi.');

  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const body = '{}';
  const signature = signBinancePay(secretKey, timestamp, nonce, body);

  const resp = await fetch(`${base}/binancepay/openapi/certificates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'BinancePay-Timestamp': timestamp,
      'BinancePay-Nonce': nonce,
      'BinancePay-Certificate-SN': apiKey,
      'BinancePay-Signature': signature
    },
    body
  });
  const data = await resp.json();
  const raw = data?.data;
  const cert = Array.isArray(raw) ? raw[0] : raw;
  if (!resp.ok || data.status !== 'SUCCESS' || !cert?.certPublic) {
    throw new Error(data.errorMessage || 'Gagal mengambil sertifikat publik Binance Pay');
  }
  binancePayCertCache = { certPublic: cert.certPublic, certSerial: cert.certSerial, fetchedAt: now };
  return binancePayCertCache;
}

// Verifikasi webhook Binance Pay: RSA-SHA256, payload = timestamp+"\n"+nonce+"\n"+rawBody+"\n",
// signature header di-encode Base64 (bukan hex), diverifikasi pakai PUBLIC KEY Binance
// (dari getBinancePayCertificate), BUKAN secret key merchant.
function verifyBinancePaySignature(certPublic, timestamp, nonce, rawBody, signatureB64) {
  const payload = `${timestamp}\n${nonce}\n${rawBody}\n`;
  const publicKeyPem = certPublic.includes('BEGIN PUBLIC KEY')
    ? certPublic
    : `-----BEGIN PUBLIC KEY-----\n${certPublic.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(payload, 'utf8');
    verifier.end();
    return verifier.verify(publicKeyPem, Buffer.from(signatureB64, 'base64'));
  } catch (e) {
    return false;
  }
}

app.get('/check-payment/:refId', requireAuth, async (req, res) => {
  const refId = req.params.refId;
  // Cegah race condition: jika transaksi sedang diproses, kembalikan pending
  if (processingOrders.has(refId)) {
    return res.json({ success: true, status: 'pending' });
  }
  processingOrders.add(refId);
  try {
    const transactions = await readFresh('transactions.json');
    const transaction = transactions.find(t => t.id === refId);
    if (!transaction) return res.json({ success: false, message: 'Transaksi tidak ditemukan' });
    // SECURITY: cegah IDOR — pastikan transaksi ini milik user yang sedang login
    if (transaction.userId && transaction.userId !== req.session.userId) {
      return res.status(403).json({ success: false, message: 'Akses ditolak' });
    }
    if (transaction.status === 'done') {
      if (transaction.type === 'reseller' || transaction.type === 'topup') return res.json({ success: true, status: 'done', type: transaction.type });
      return res.json({ success: true, status: 'done', key: transaction.key, code: transaction.code });
    }
    // MULTI-PROVIDER: order sudah dibuat ke provider, tinggal menunggu
    // webhook menyelesaikan (lihat allocateKeyAndCompleteTransaction guard).
    // Tidak perlu cek ulang payment gateway -- uang sudah pasti masuk
    // (status baru bisa 'processing' setelah pembayaran terkonfirmasi).
    if (transaction.status === 'processing') {
      return res.json({ success: true, status: 'processing' });
    }

    // Static QRIS: tunggu konfirmasi manual admin
    if (transaction.isStatic) return res.json({ success: true, status: 'pending_static' });

    // USDT MANUAL (Binance Spot Read-Only): cek histori deposit langsung,
    // BUKAN via webhook (akun personal Binance tidak bisa Binance Pay Merchant).
    if (transaction.paymentMethod === 'usdt_manual') {
      const settings = await readSmart('settings.json');
      const config = getBinanceSpotConfig(settings);
      try {
        const matched = await findMatchingUsdtDeposit(transaction.totalPayment, config);
        if (!matched) {
          return res.json({ success: true, status: 'pending' });
        }

        // GUARD: cegah satu txId Binance melunaskan lebih dari satu transaksi
        // (tabrakan nominal unik sangat jarang tapi tidak nol -- 3 digit
        // random cuma 900 kemungkinan per basis harga yang sama).
        const alreadyClaimed = transactions.some(
          (t) => t.id !== transaction.id && t.matchedTxId === matched.txId
        );
        if (alreadyClaimed) {
          console.warn(`[check-payment] usdt_manual: txId=${matched.txId} sudah dipakai transaksi lain, order_id=${transaction.orderId} ditolak.`);
          return res.json({ success: true, status: 'pending' });
        }

        transaction.matchedTxId = matched.txId;
        const result = await allocateKeyAndCompleteTransaction(transaction, transactions);
        return res.json({ success: result.status !== 'failed', ...result });
      } catch (e) {
        // Jangan expose error mentah Binance (bisa bocorkan detail konfigurasi)
        // ke frontend -- log di server, frontend cukup lihat 'pending'.
        console.error(`[check-payment] usdt_manual error order_id=${transaction.orderId}:`, e.message, e.binanceCode ? `(code: ${e.binanceCode})` : '');
        return res.json({ success: true, status: 'pending' });
      }
    }

    const settings = await readSmart('settings.json');
    let paid = false;
    try {
      const r = await checkPaymentStatusCached(transaction.orderId, transaction.totalPayment || transaction.price, settings);
      // Normalize status dari response GensPay (data.status) — juga tetap kompatibel kalau ada transaksi lama format PakKasir
      const status = (r.transaction?.status || r.status || r.data?.status || '').toLowerCase();
      paid = ['completed','success','paid','settlement','capture','complete','authorize','accepted'].includes(status) || r.success === true;
      // FIX (docs GensPay terbaru): status transaksi sekarang SUCCESS/EXPIRED/FAILED
      // (sebelumnya cuma expired/canceled/cancelled yang ditangani -- 'failed' belum
      // ada di daftar lama, jadi transaksi FAILED bisa nyangkut pending selamanya).
      if (['expired','canceled','cancelled','failed'].includes(status)) {
        transaction.status = 'expired';
        // VOUCHER REVERSAL: kembalikan pemakaian voucher supaya tidak
        // terhitung habis padahal transaksi gagal/batal.
        if (transaction.voucherCode) {
          const vouchers = await readFresh('vouchers.json');
          const v = vouchers.find(v => v.code === transaction.voucherCode);
          if (v) {
            v.usedCount = Math.max(0, (v.usedCount || 0) - 1);
            v.usages = (v.usages || []).filter(u => u.orderId !== transaction.id);
            await writeDB('vouchers.json', vouchers);
          }
        }
        await writeDB('transactions.json', transactions);
        return res.json({ success: true, status: 'expired' });
      }
    } catch(e) { /* API error, keep pending */ }

    if (paid) {
      const result = await allocateKeyAndCompleteTransaction(transaction, transactions);
      // BUG FIX: sebelumnya selalu success:true meski generate key auto
      // gagal. Di jalur QRIS ini uang sudah masuk ke payment gateway
      // eksternal (bukan saldo internal), jadi tidak ada refund saldo
      // internal yang perlu dilakukan di sini -- tapi status di response
      // tetap harus jujur, supaya frontend bisa kasih tahu user pesanan
      // gagal diproses (bukan diam-diam dianggap sukses) dan admin bisa
      // lihat transaction.status='failed' + failReason untuk retry manual.
      return res.json({ success: result.status !== 'failed', ...result });
    }

    res.json({ success: true, status: transaction.status });
  } catch (error) {
    console.error('[check-payment] error:', error.message);
    res.json({ success: false, message: error.message });
  } finally {
    processingOrders.delete(refId);
  }
});

// ── Reconciliation sweep: safety net independent of both the webhook AND
// client-side polling ──
// Both existing paths for completing a paid GensPay transaction have a
// single point of failure that's entirely outside our control:
//   - /webhook/genspay depends on GensPay's account-wide webhook URL
//     being correctly registered on THEIR dashboard/Telegram bot -- if
//     that's stale (e.g. after a domain move) or was never set, it never
//     fires, ever.
//   - /check-payment/:refId polling only runs while the customer's own
//     browser tab is open on the checkout page -- close the tab, switch
//     apps, or the payment settles a bit late, and nothing re-checks it.
// This sweep doesn't care about either of those: it periodically asks
// GensPay directly (server-to-server, via checkPaymentStatus, same as
// polling does) about every transaction we ourselves still have marked
// 'pending', and settles/expires them exactly like /check-payment does.
// Triggered by Vercel Cron (see vercel.json's "crons" -- Vercel
// automatically sends `Authorization: Bearer ${CRON_SECRET}` on cron
// requests, so this trusts that header rather than requiring a session).
app.get('/cron/reconcile-genspay', async (req, res) => {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  if (!cronSecret) return res.status(503).json({ error: 'cron_secret_not_configured' });
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const settings = await readSmart('settings.json');
  const transactions = await readFresh('transactions.json');
  // Static QRIS is intentionally manual-verify-only (no gateway API to poll
  // against) -- only sweep GensPay-API transactions (isStatic === false,
  // has a qrString GensPay actually issued).
  const candidates = transactions.filter(t => t.status === 'pending' && t.isStatic === false && t.qrString);

  const results = { checked: candidates.length, settled: 0, expired: 0, stillPending: 0, errors: 0 };

  for (const transaction of candidates) {
    if (processingOrders.has(transaction.id)) { results.stillPending++; continue; }
    processingOrders.add(transaction.id);
    try {
      const r = await checkPaymentStatus(transaction.orderId, transaction.totalPayment || transaction.price, settings);
      const status = (r.transaction?.status || r.status || r.data?.status || '').toLowerCase();
      const paid = ['completed', 'success', 'paid', 'settlement', 'capture', 'complete', 'authorize', 'accepted'].includes(status) || r.success === true;

      if (['expired', 'canceled', 'cancelled', 'failed'].includes(status)) {
        transaction.status = 'expired';
        if (transaction.voucherCode) {
          const vouchers = await readFresh('vouchers.json');
          const v = vouchers.find(v => v.code === transaction.voucherCode);
          if (v) {
            v.usedCount = Math.max(0, (v.usedCount || 0) - 1);
            v.usages = (v.usages || []).filter(u => u.orderId !== transaction.id);
            await writeDB('vouchers.json', vouchers);
          }
        }
        await writeDB('transactions.json', transactions);
        results.expired++;
      } else if (paid) {
        await allocateKeyAndCompleteTransaction(transaction, transactions);
        results.settled++;
      } else {
        results.stillPending++;
      }
    } catch (e) {
      console.error(`[cron/reconcile-genspay] gagal cek order_id=${transaction.orderId}:`, e.message);
      results.errors++;
    } finally {
      processingOrders.delete(transaction.id);
    }
  }

  console.log('[cron/reconcile-genspay] selesai:', JSON.stringify(results));
  res.json({ ok: true, ...results });
});

// ── NOWPAYMENTS: buat transaksi pembayaran crypto (USDT) dari transaksi pending yang sudah ada (dibuat via /create-order) ──
app.post('/nowpayments/create-payment', requireAuth, async (req, res) => {
  if (!checkApiRateLimit(req.ip)) return res.status(429).json({ success: false, message: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  try {
    const { refId } = req.body;
    if (!refId) return res.json({ success: false, message: 'refId wajib diisi' });
    const transactions = await readFresh('transactions.json');
    const transaction = transactions.find(t => t.id === refId);
    if (!transaction) return res.json({ success: false, message: 'Transaksi tidak ditemukan' });
    if (transaction.userId !== req.session.userId) return res.status(403).json({ success: false, message: 'Akses ditolak' });
    if (transaction.status !== 'pending') return res.json({ success: false, message: 'Transaksi ini sudah tidak pending' });

    const settings = await readFresh('settings.json');
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const payment = await createNOWPayment(settings, transaction, baseUrl);

    // Simpan detail pembayaran NOWPayments di transaksi supaya webhook nanti bisa dicocokkan,
    // dan status diubah ke 'processing' -- penyelesaian akhir menunggu webhook /webhook/nowpayments
    // (sama seperti pola multi-provider lain di sistem ini, lihat allocateKeyAndCompleteTransaction guard).
    transaction.nowpaymentsPaymentId = payment.payment_id;
    transaction.paymentMethod = 'nowpayments';
    transaction.status = 'processing';
    await writeDB('transactions.json', transactions);

    res.json({
      success: true,
      paymentId: payment.payment_id,
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount,
      payCurrency: payment.pay_currency,
      priceAmount: payment.price_amount,
      priceCurrency: payment.price_currency
    });
  } catch (error) {
    console.error('[nowpayments/create-payment] error:', error.message);
    res.json({ success: false, message: 'NOWPayments error: ' + error.message });
  }
});

// ── BINANCE PAY: buat order pembayaran dari transaksi pending yang sudah ada (dibuat via /create-order) ──
app.post('/binancepay/create-payment', requireAuth, async (req, res) => {
  if (!checkApiRateLimit(req.ip)) return res.status(429).json({ success: false, message: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  try {
    const { refId } = req.body;
    if (!refId) return res.json({ success: false, message: 'refId wajib diisi' });
    const transactions = await readFresh('transactions.json');
    const transaction = transactions.find(t => t.id === refId);
    if (!transaction) return res.json({ success: false, message: 'Transaksi tidak ditemukan' });
    if (transaction.userId !== req.session.userId) return res.status(403).json({ success: false, message: 'Akses ditolak' });
    if (transaction.status !== 'pending') return res.json({ success: false, message: 'Transaksi ini sudah tidak pending' });

    const settings = await readFresh('settings.json');
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const order = await createBinancePayOrder(settings, transaction, baseUrl);

    // Simpan detail order Binance Pay di transaksi supaya webhook nanti bisa dicocokkan,
    // dan status diubah ke 'processing' -- penyelesaian akhir menunggu webhook /webhook/binancepay
    // (sama seperti pola multi-provider lain di sistem ini, lihat allocateKeyAndCompleteTransaction guard).
    transaction.binancepayPrepayId = order.prepayId;
    transaction.paymentMethod = 'binancepay';
    transaction.status = 'processing';
    await writeDB('transactions.json', transactions);

    res.json({
      success: true,
      prepayId: order.prepayId,
      checkoutUrl: order.checkoutUrl,
      qrcodeLink: order.qrcodeLink,
      deeplink: order.deeplink,
      expireTime: order.expireTime
    });
  } catch (error) {
    console.error('[binancepay/create-payment] error:', error.message);
    res.json({ success: false, message: 'Binance Pay error: ' + error.message });
  }
});

// ── USDT MANUAL (Binance Spot Read-Only): generate nominal unik + tampilkan wallet statis ──
// BEDA dari /binancepay/create-payment: tidak ada API call keluar ke Binance
// di sini (tidak butuh, karena tidak ada "order" di sisi Binance -- cuma
// wallet statis). Pengecekan pembayaran baru terjadi nanti di /check-payment.
app.post('/binance-spot/create-payment', requireAuth, async (req, res) => {
  if (!checkApiRateLimit(req.ip)) return res.status(429).json({ success: false, message: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  try {
    const { refId } = req.body;
    if (!refId) return res.json({ success: false, message: 'refId wajib diisi' });
    const transactions = await readFresh('transactions.json');
    const transaction = transactions.find(t => t.id === refId);
    if (!transaction) return res.json({ success: false, message: 'Transaksi tidak ditemukan' });
    if (transaction.userId !== req.session.userId) return res.status(403).json({ success: false, message: 'Akses ditolak' });
    if (transaction.status !== 'pending') return res.json({ success: false, message: 'Transaksi ini sudah tidak pending' });

    const settings = await readFresh('settings.json');
    const config = getBinanceSpotConfig(settings);
    if (!config.walletAddress) {
      return res.json({ success: false, message: 'Wallet USDT belum dikonfigurasi. Hubungi admin.' });
    }
    if (!config.apiKey || !config.secretKey) {
      return res.json({ success: false, message: 'Binance Spot API Key belum dikonfigurasi. Hubungi admin.' });
    }

    // Nominal dasar diambil dari harga transaksi yang sudah ada (IDR tidak
    // relevan di sini -- asumsinya price transaksi ini SUDAH dalam USDT kalau
    // metode bayarnya usdt_manual; sesuaikan konversi di route checkout awal
    // kalau harga produkmu disimpan dalam IDR).
    // PENTING: transaction.price di sistem ini SELALU dalam IDR (lihat
    // price_currency:'idr' di modul NOWPayments lain). Jadi harus
    // dikonversi ke USDT dulu sebelum ditempel nominal unik.
    const baseAmountIdr = Number(transaction.price);
    let uniqueAmount;
    try {
      uniqueAmount = await generateUniqueUsdtAmount(baseAmountIdr);
    } catch (rateErr) {
      console.error('[binance-spot/create-payment] gagal ambil kurs:', rateErr.message);
      return res.json({ success: false, message: 'Gagal mengambil kurs USDT saat ini. Coba lagi sebentar lagi.' });
    }

    transaction.totalPayment = uniqueAmount;
    transaction.paymentMethod = 'usdt_manual';
    transaction.usdtWalletAddress = config.walletAddress;
    transaction.usdtNetwork = config.network;
    transaction.status = 'pending'; // TETAP pending (bukan processing) -- baru 'processing'/'done' setelah deposit match ketemu di /check-payment
    await writeDB('transactions.json', transactions);

    // QR code: encode alamat + jumlah dalam format URI standar TRC20, biar
    // app wallet user (Trust Wallet, Binance App, dll) otomatis ngisi alamat
    // & nominal saat di-scan -- user tinggal konfirmasi kirim, gak perlu
    // ngetik manual. Pakai image service publik, zero-dependency (tidak
    // nambah npm package baru).
    const trc20Uri = `tron:${config.walletAddress}?amount=${uniqueAmount}`;
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(trc20Uri)}`;

    res.json({
      success: true,
      walletAddress: config.walletAddress,
      network: config.network,
      coin: config.coin,
      uniqueAmount,
      qrCodeUrl,
    });
  } catch (error) {
    console.error('[binance-spot/create-payment] error:', error.message);
    res.json({ success: false, message: 'Gagal menyiapkan pembayaran USDT: ' + error.message });
  }
});

// Admin routes
app.get('/admin', requireAdmin, (req, res) => {
  const products = readDB('products.json');
  const transactions = readDB('transactions.json');
  const users = readDB('users.json');
  const settings = readDB('settings.json');

  const resellerIds = new Set(users.filter(u => u.is_reseller).map(u => u.id));
  const resellerOrderTrx = transactions.filter(t => t.status === 'done' && t.type !== 'reseller' && resellerIds.has(t.userId));

  const stats = {
    totalProducts: products.length,
    activeProducts: products.filter(p => p.status === 'active').length,
    totalTransactions: transactions.length,
    pendingTransactions: transactions.filter(t => t.status === 'pending').length,
    doneTransactions: transactions.filter(t => t.status === 'done').length,
    totalUsers: users.length,
    totalResellers: users.filter(u => u.is_reseller).length,
    totalRevenue: transactions.filter(t => t.status === 'done').reduce((sum, t) => sum + t.price, 0),
    resellerOrders: resellerOrderTrx.length,
    resellerRevenue: resellerOrderTrx.reduce((sum, t) => sum + t.price, 0)
  };

  // Data chart: 7 hari terakhir
  const chartData = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayTrx = transactions.filter(t => t.status === 'done' && t.createdAt && t.createdAt.slice(0, 10) === dateStr);
    chartData.push({
      date: d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' }),
      count: dayTrx.length,
      revenue: dayTrx.reduce((s, t) => s + t.price, 0)
    });
  }

  res.render('pages/admin', {
    layout: false,
    products,
    transactions: transactions.slice(-20).reverse(),
    users,
    settings,
    stats,
    chartData,
    genspayConfigured: {
      baseUrl: !!(process.env.GENSPAY_BASE_URL || '').trim(),
      apiKey: !!(process.env.GENSPAY_API_KEY || '').trim(),
      baseUrlPreview: (process.env.GENSPAY_BASE_URL || '').trim()
    },
    // Dibangun dari domain yang BENERAN sedang dipakai admin buat akses
    // panel ini (bukan hardcoded/env var) -- jadi kalau domain pernah
    // pindah, URL ini otomatis ikut benar tanpa perlu update kode. GensPay
    // sendiri tidak (setahu kita) punya API untuk auto-register webhook
    // URL -- ini masih harus di-paste manual ke dashboard/Telegram bot
    // GensPay, tapi setidaknya sekarang tidak perlu ditebak/diketik ulang.
    genspayWebhookUrl: `${getAppBaseUrl(req)}/webhook/genspay`
  });
});

// Helper: parse pricingOptions
function parsePricingOptions(days, prices) {
  const da = Array.isArray(days)?days:(days?[days]:[]);
  const pa = Array.isArray(prices)?prices:(prices?[prices]:[]);
  const opts=[];const seen=new Set();
  for(let i=0;i<da.length;i++){const d=parseInt(da[i]),p=parseInt(pa[i]);if(d>0&&p>=0&&!seen.has(d)){seen.add(d);opts.push({days:d,price:p});}}
  return opts.sort((a,b)=>a.days-b.days);
}

// Helper: validasi URL gambar (cegah XSS via javascript:/data: protocol)
const isValidImageUrl = (url) => {
  if (!url) return true;
  const lower = url.toLowerCase().trim();
  return !lower.startsWith('javascript:') && !lower.startsWith('data:') && !lower.startsWith('vbscript:');
};

// Helper: extract video ID dari berbagai format link YouTube
// (watch?v=, youtu.be/, shorts/, embed/) -> dipakai utk build embed URL + thumbnail.
const getYoutubeId = (url) => {
  if (!url) return null;
  const m = String(url).trim().match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
};

// Helper: bersihkan & validasi array link YouTube dari input admin
// (terima array atau string dipisah newline, buang yg bukan link YT valid).
const parseYoutubeUrls = (input) => {
  if (input === undefined || input === null) return undefined;
  const raw = Array.isArray(input) ? input : String(input).split('\n');
  const cleaned = raw.map(u => String(u || '').trim()).filter(u => u && getYoutubeId(u));
  return cleaned.slice(0, 10); // batas wajar 10 video per produk
};

// Helper: bersihkan array of string dari input admin (compatibility/features list)
// -- terima array atau string dipisah newline, buang baris kosong.
const parseStringList = (input) => {
  if (input === undefined || input === null) return undefined;
  const raw = Array.isArray(input) ? input : String(input).split('\n');
  return raw.map(s => String(s || '').trim()).filter(Boolean).slice(0, 50);
};

app.post('/admin/product/add', requireAdmin, (req, res, next) => {
  upload.single('image')(req, res, err => {
    if (err) return res.json({ success: false, message: 'Upload error: ' + err.message });
    next();
  });
}, async (req, res) => {
  try {
    const {name,category,description,imageUrl:imgUrl,pricingDays,pricingPrices,keys,status,stockMode,downloadLink}=req.body;
    if(!name)return res.json({success:false,message:'Nama produk wajib diisi'});
    if(imgUrl && !isValidImageUrl(imgUrl)) return res.json({success:false,message:'URL gambar tidak valid'});
    const products=await readFresh('products.json');
    const pricingOptions=parsePricingOptions(pricingDays,pricingPrices);
    if(!pricingOptions.length)return res.json({success:false,message:'Tambahkan minimal 1 opsi harga'});
    const keyArray=keys?keys.split('\n').map(k=>k.trim()).filter(k=>k):[];
    let image = imgUrl?.trim() || '';
    if (req.file) {
      if (!isVercel) {
        image = `/uploads/products/${req.file.filename}`;
      } else {
        try {
          image = await db.uploadImage(require('fs').readFileSync(req.file.path), req.file.originalname, req.file.mimetype);
        } catch { image = imgUrl?.trim() || '/images/placeholder.jpg'; }
      }
    }
    if (!image) image = '/images/placeholder.jpg';
    // Default Mode Stok untuk produk BARU = 'auto' (Reseller API) kecuali
    // form eksplisit mengirim 'manual' -- sama seperti GNE. Setiap baris
    // pricingOptions ikut dapat stockSource='auto' by default, resellerItemId
    // kosong (auto-match by nama produk + hari akan jalan otomatis saat checkout).
    const resolvedStockMode = stockMode === 'manual' ? 'manual' : 'auto';
    pricingOptions.forEach(o => { o.stockSource = resolvedStockMode; o.resellerItemId = null; });
    const items=pricingOptions.map(o=>({l:`${name.toUpperCase()} ${o.days} DAYS`,p:o.price}));
    const newProduct={id:uuidv4(),name,category:category||'freefire',description:description||'',image,pricingOptions,items,status:status==='inactive'?'inactive':'active',keys:keyArray,sold:0,createdAt:new Date().toISOString(),stockMode:resolvedStockMode,downloadLink:downloadLink?.trim()||''};
    products.push(newProduct);await writeDB('products.json',products);
    res.json({success:true,product:newProduct});
  }catch(error){res.json({success:false,message:error.message});}
});

app.post('/admin/product/edit/:id', requireAdmin, (req, res, next) => {
  upload.single('image')(req, res, err => {
    if (err) return res.json({ success: false, message: 'Upload error: ' + err.message });
    next();
  });
}, async (req, res) => {
  try {
    const { name, category, description, bannerUrl, imageUrl, pricingDays, pricingPrices, keys, keysMode, status, platforms, downloadLink } = req.body;
    const imgUrl = bannerUrl || imageUrl;
    const products = await readFresh('products.json');
    const product = products.find(p => p.id === req.params.id);
    if (!product) return res.json({ success: false, message: 'Produk tidak ditemukan' });
    if (imgUrl && !isValidImageUrl(imgUrl)) return res.json({ success: false, message: 'URL gambar tidak valid' });

    if (name) product.name = name;
    if (category) product.category = category;
    if (description !== undefined) product.description = description;
    if (status) product.status = status;
    if (Array.isArray(platforms)) product.platforms = platforms;
    if (downloadLink !== undefined) product.downloadLink = downloadLink.trim();
    if (pricingDays) {
      const opts = parsePricingOptions(pricingDays, pricingPrices);
      if (opts.length) {
        // Pertahankan harga reseller custom (per paket, match by days) biar gak ke-reset waktu admin ubah harga normal
        const oldOpts = product.pricingOptions || [];
        opts.forEach(o => {
          const old = oldOpts.find(x => x.days === o.days);
          if (old && old.resellerPrice !== undefined) o.resellerPrice = Math.min(old.resellerPrice, o.price);
        });
        product.pricingOptions = opts;
        product.items = opts.map(o => ({ l: `${product.name.toUpperCase()} ${o.days} DAYS`, p: o.price }));
      }
    }
    if (keys !== undefined && keys !== null) {
      const nk = String(keys).split('\n').map(k => k.trim()).filter(k => k);
      if (nk.length > 0) product.keys = keysMode === 'replace' ? nk : [...(product.keys || []), ...nk];
    }
    if (req.file) {
      if (!isVercel) product.image = `/uploads/products/${req.file.filename}`;
      else { try { product.image = await db.uploadImage(require('fs').readFileSync(req.file.path), req.file.originalname, req.file.mimetype); } catch {} }
    } else if (imgUrl && imgUrl.trim()) {
      product.image = imgUrl.trim();
      product.bannerUrl = imgUrl.trim();
    }
    await writeDB('products.json', products);
    res.json({ success: true, message: 'Produk berhasil diupdate', product, data: product });
  } catch (error) {
    res.json({ success: false, message: 'Error: ' + error.message });
  }
});

// PENTING: route ini HARUS didaftarkan SEBELUM '/admin/product/:id' di bawah.
// Express mencocokkan route berurutan sesuai urutan pendaftaran -- kalau
// '/admin/product/:id' (wildcard) didaftarkan duluan, request ke
// '/admin/product/bulk-set-auto' akan ke-match ke situ dulu dengan
// req.params.id = "bulk-set-auto", lalu gagal dengan "Produk tidak
// ditemukan" karena tidak ada produk dengan id itu. Ini BUG NYATA yang
// bikin tombol "Set Auto Semua" di panel admin selalu gagal -- fixed dengan
// memindahkan route spesifik ini ke atas wildcard.
//
// Bulk: set stockSource='auto' untuk SEMUA produk & SEMUA varian sekaligus,
// supaya admin tidak perlu buka Edit Produk satu-satu. Auto-match by nama
// akan mencocokkan product_item_id yang sesuai otomatis per transaksi.
// Mapping manual yang sudah ada TIDAK disentuh/dihapus.
app.post('/admin/product/bulk-set-auto', requireAdmin, async (req, res) => {
  try {
    const products = await readFresh('products.json');
    let changedCount = 0;
    let alreadyAutoCount = 0;
    let variantsUpdated = 0;
    products.forEach(p => {
      let productChanged = false;
      if (Array.isArray(p.pricingOptions)) {
        p.pricingOptions.forEach(o => {
          if (o.stockSource !== 'auto') {
            o.stockSource = 'auto';
            variantsUpdated++;
            productChanged = true;
          }
        });
      }
      if (p.stockMode === 'auto') {
        alreadyAutoCount++;
      } else {
        p.stockMode = 'auto';
        changedCount++;
        productChanged = true;
      }
      if (productChanged) changedCount = changedCount;
    });
    if (changedCount > 0 || variantsUpdated > 0) {
      await writeDB('products.json', products);
    }
    res.json({
      success: true,
      message: `${changedCount} produk diubah ke mode Auto${alreadyAutoCount > 0 ? ` (${alreadyAutoCount} sudah Auto sebelumnya)` : ''}. ${variantsUpdated} varian/paket disetel ke sumber stok Auto.`,
      changedCount, alreadyAutoCount, variantsUpdated
    });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/product/:id', requireAdmin, async (req, res) => {
  try {
    const { name, category, description, bannerUrl, imageUrl, pricingDays, pricingPrices, pricingOptions: pricingOptionsInput, keys, keysMode, status, platforms, stockMode, downloadLink, youtubeUrls, compatibility, features } = req.body;
    const imgUrl = bannerUrl || imageUrl;
    const products = await readFresh('products.json');
    const product = products.find(p => p.id === req.params.id);
    if (!product) return res.json({ success: false, message: 'Produk tidak ditemukan' });
    if (imgUrl && !isValidImageUrl(imgUrl)) return res.json({ success: false, message: 'URL gambar tidak valid' });

    if (name) product.name = name;
    if (category) product.category = category;
    if (description !== undefined) product.description = description;
    if (status) product.status = status;
    if (Array.isArray(platforms)) product.platforms = platforms;
    if (downloadLink !== undefined) product.downloadLink = String(downloadLink).trim();
    // Link YouTube showcase (bisa lebih dari 1) -- section video di halaman
    // produk otomatis sembunyi kalau array ini kosong.
    const ytUrls = parseYoutubeUrls(youtubeUrls);
    if (ytUrls !== undefined) product.youtubeUrls = ytUrls;
    // System Compatibility & Feature List -- list bullet terstruktur, tampil
    // di tab "Information" halaman produk (kosong = section tab disembunyikan).
    const compatList = parseStringList(compatibility);
    if (compatList !== undefined) product.compatibility = compatList;
    const featureListInput = parseStringList(features);
    if (featureListInput !== undefined) product.features = featureListInput;
    // stockMode top-level = ringkasan ('auto'/'manual'/'mixed'), dipakai
    // sebagai FALLBACK oleh resolveStockSourceForDays kalau suatu baris
    // pricingOptions belum punya stockSource sendiri (produk lama).
    if (stockMode === 'auto' || stockMode === 'manual' || stockMode === 'mixed') product.stockMode = stockMode;

    // Skema BARU (array of object, dari admin-product-edit.ejs redesign) --
    // tiap baris bawa stockSource & resellerItemId sendiri.
    if (Array.isArray(pricingOptionsInput) && pricingOptionsInput.length > 0) {
      const oldOpts = product.pricingOptions || [];
      const validOpts = pricingOptionsInput
        .map(o => {
          const days = parseInt(o.days);
          const price = parseInt(o.price);
          const old = oldOpts.find(x => x.days === days);
          const opt = {
            days, price,
            stockSource: o.stockSource === 'manual' ? 'manual' : 'auto',
            // FIX: resellerItemId dulu selalu di-parseInt() -- ini merusak ID
            // dari sistem multi-provider yang berbentuk string "mp:providerId:productId"
            // (jadi NaN). ID legacy (reseller-api lama) tetap angka murni, ID
            // multi-provider tetap string apa adanya -- keduanya disimpan
            // sebagai string biasa, konversi ke number (kalau perlu) dilakukan
            // di titik pemakaian (resolveItemId/generateAutoKey), bukan di sini.
            resellerItemId: (o.stockSource !== 'manual' && o.resellerItemId) ? String(o.resellerItemId) : null
          };
          // Pertahankan harga reseller custom (per paket, match by days) biar gak ke-reset waktu admin ubah harga normal
          if (old && old.resellerPrice !== undefined) opt.resellerPrice = Math.min(old.resellerPrice, price);
          return opt;
        })
        .filter(o => o.days > 0 && o.price >= 0);
      if (validOpts.length) {
        product.pricingOptions = validOpts;
        product.items = validOpts.map(o => ({ l: `${product.name.toUpperCase()} ${o.days} DAYS`, p: o.price }));
      }
    } else if (pricingDays) {
      // Skema LAMA (parallel array pricingDays/pricingPrices) -- tetap
      // didukung untuk backward compat kalau ada caller lain yang belum
      // dimigrasi. Baris baru dari sini default stockSource='manual' (aman,
      // tidak diam-diam mengaktifkan Auto tanpa sepengetahuan admin).
      const opts = parsePricingOptions(pricingDays, pricingPrices);
      if (opts.length) {
        const oldOpts = product.pricingOptions || [];
        opts.forEach(o => {
          const old = oldOpts.find(x => x.days === o.days);
          if (old && old.resellerPrice !== undefined) o.resellerPrice = Math.min(old.resellerPrice, o.price);
          o.stockSource = old?.stockSource || 'manual';
          o.resellerItemId = old?.resellerItemId || null;
        });
        product.pricingOptions = opts;
        product.items = opts.map(o => ({ l: `${product.name.toUpperCase()} ${o.days} DAYS`, p: o.price }));
      }
    }

    if (keys !== undefined && keys !== null) {
      const nk = String(keys).split('\n').map(k => k.trim()).filter(k => k);
      if (nk.length > 0) product.keys = keysMode === 'replace' ? nk : [...(product.keys || []), ...nk];
    }
    if (req.file) {
      if (!isVercel) product.image = `/uploads/products/${req.file.filename}`;
      else { try { product.image = await db.uploadImage(require('fs').readFileSync(req.file.path), req.file.originalname, req.file.mimetype); } catch {} }
    } else if (imgUrl && imgUrl.trim()) {
      product.image = imgUrl.trim();
      product.bannerUrl = imgUrl.trim();
    }
    await writeDB('products.json', products);
    res.json({ success: true, message: 'Produk berhasil diupdate', product, data: product });
  } catch (error) {
    res.json({ success: false, message: 'Error: ' + error.message });
  }
});

app.post('/admin/product/keys/:id', requireAdmin, async (req, res) => {
  try {
    const{keys,mode}=req.body;const products=await readFresh('products.json');
    const product=products.find(p=>p.id===req.params.id);
    if(!product)return res.json({success:false,message:'Produk tidak ditemukan'});
    const nk=(keys||'').split('\n').map(k=>k.trim()).filter(k=>k);
    product.keys=mode==='replace'?nk:[...(product.keys||[]),...nk];
    await writeDB('products.json',products);res.json({success:true,keyCount:product.keys.length});
  }catch(e){res.json({success:false,message:e.message});}
});

// Set harga reseller custom per paket produk (override diskon global, biar admin gak rugi di produk margin tipis)
app.post('/admin/product/reseller-price/:id', requireAdmin, async (req, res) => {
  try {
    const { entries } = req.body; // [{ days, resellerPrice }] — resellerPrice null/'' = pakai diskon global
    if (!Array.isArray(entries)) return res.json({ success: false, message: 'Data tidak valid' });
    const products = await readFresh('products.json');
    const product = products.find(p => p.id === req.params.id);
    if (!product) return res.json({ success: false, message: 'Produk tidak ditemukan' });
    if (!Array.isArray(product.pricingOptions)) return res.json({ success: false, message: 'Produk belum punya paket harga' });

    for (const entry of entries) {
      const days = parseInt(entry.days);
      const opt = product.pricingOptions.find(o => o.days === days);
      if (!opt) continue;
      if (entry.resellerPrice === null || entry.resellerPrice === '' || entry.resellerPrice === undefined) {
        delete opt.resellerPrice;
      } else {
        const rp = parseInt(entry.resellerPrice);
        if (isNaN(rp) || rp < 0) return res.json({ success: false, message: `Harga reseller tidak valid untuk paket ${days} hari` });
        if (rp > opt.price) return res.json({ success: false, message: `Harga reseller (${rp}) untuk paket ${days} hari tidak boleh lebih mahal dari harga normal (${opt.price})` });
        opt.resellerPrice = rp;
      }
    }
    // Sinkronkan items agar konsisten (items tidak menyimpan resellerPrice, hanya pricingOptions sumber kebenarannya)
    await writeDB('products.json', products);
    res.json({ success: true, message: 'Harga reseller berhasil disimpan', pricingOptions: product.pricingOptions });
  } catch (error) {
    res.json({ success: false, message: 'Error: ' + error.message });
  }
});

app.post('/admin/product/delete/:id', requireAdmin, async (req, res) => {
  try {
    let products = await readFresh('products.json');
    products = products.filter(p => p.id !== req.params.id);
    await writeDB('products.json', products);
    res.json({ success: true, message: 'Produk berhasil dihapus' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/user/delete/:id', requireAdmin, async (req, res) => {
  try {
    let users = await readFresh('users.json');
    users = users.filter(u => u.id !== req.params.id);
    await writeDB('users.json', users);
    res.json({ success: true, message: 'User berhasil dihapus' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/transaction/delete/:id', requireAdmin, async (req, res) => {
  try {
    let transactions = await readFresh('transactions.json');
    const trx = transactions.find(t => t.id === req.params.id);
    if (!trx) return res.json({ success: false, message: 'Transaksi tidak ditemukan' });

    const actions = [];

    // Refund saldo kalau transaksi ini dibayar pakai saldo & status masih
    // pending atau done (uang sudah dipotong/dikredit).
    if (trx.paymentMethod === 'balance' && ['pending', 'done'].includes(trx.status)) {
      const usersRefund = await readFresh('users.json');
      const uRefund = usersRefund.find(u => u.id === trx.userId);
      if (uRefund) {
        uRefund.balance = (uRefund.balance || 0) + trx.price;
        actions.push(writeDB('users.json', usersRefund));
      }
    }

    // Restore key manual ke pool & kurangi sold kalau transaksi done
    if (trx.productId && trx.status === 'done') {
      const productsRefund = await readFresh('products.json');
      const pRefund = productsRefund.find(p => p.id === trx.productId);
      if (pRefund) {
        if (trx.key && trx.paymentMethod !== 'auto') {
          pRefund.keys = pRefund.keys || [];
          const suffix = trx.selectedDays ? ':' + trx.selectedDays : '';
          pRefund.keys.push(trx.key + suffix);
        }
        pRefund.sold = Math.max(0, (pRefund.sold || 0) - 1);
        actions.push(writeDB('products.json', productsRefund));
      }
    }

    // Reverse voucher usage
    if (trx.voucherCode && ['pending', 'done'].includes(trx.status)) {
      const vouchers = await readFresh('vouchers.json');
      const v = vouchers.find(v => v.code === trx.voucherCode);
      if (v) {
        v.usedCount = Math.max(0, (v.usedCount || 0) - 1);
        v.usages = (v.usages || []).filter(u => u.orderId !== trx.id);
        actions.push(writeDB('vouchers.json', vouchers));
      }
    }

    transactions = transactions.filter(t => t.id !== req.params.id);
    actions.push(writeDB('transactions.json', transactions));
    await Promise.all(actions);

    res.json({ success: true, message: 'Transaksi berhasil dihapus' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/transaction/status/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const transactions = await readFresh('transactions.json');
    const trx = transactions.find(t => t.id === req.params.id);
    if (!trx) return res.json({ success: false, message: 'Transaksi tidak ditemukan' });

    const oldStatus = trx.status;
    const cancelling = ['failed', 'expired', 'cancelled'].includes(status) && ['pending', 'done'].includes(oldStatus);
    const actions = [];

    if (cancelling) {
      // 1. Refund saldo kalau dibayar pakai saldo & transaksi sudah diproses
      if (trx.paymentMethod === 'balance' && (oldStatus === 'done' || oldStatus === 'pending')) {
        const usersRefund = await readFresh('users.json');
        const uRefund = usersRefund.find(u => u.id === trx.userId);
        if (uRefund) {
          uRefund.balance = (uRefund.balance || 0) + trx.price;
          actions.push(writeDB('users.json', usersRefund));
          actions.push(Promise.resolve());
        }
      }

      // 2. Restore key manual ke pool produk & kurangi sold count
      if (trx.productId && trx.status === 'done') {
        const productsRefund = await readFresh('products.json');
        const pRefund = productsRefund.find(p => p.id === trx.productId);
        if (pRefund) {
          // Kembalikan key ke array (bisa manual key yang sudah di-splice)
          if (trx.key && trx.paymentMethod !== 'auto') {
            pRefund.keys = pRefund.keys || [];
            const suffix = trx.selectedDays ? ':' + trx.selectedDays : '';
            pRefund.keys.push(trx.key + suffix);
          }
          // Kurangi sold count
          pRefund.sold = Math.max(0, (pRefund.sold || 0) - 1);
          actions.push(writeDB('products.json', productsRefund));
        }
      }
    }

    trx.status = status;
    trx.updatedBy = 'admin';
    trx.updatedAt = new Date().toISOString();
    actions.push(writeDB('transactions.json', transactions));
    await Promise.all(actions);

    const msg = cancelling
      ? `Status diubah ke ${status}${trx.paymentMethod === 'balance' ? ' + saldo dikembalikan' : ''}${trx.key ? ' + key dikembalikan ke stok' : ''}`
      : 'Status berhasil diubah';
    res.json({ success: true, message: msg });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/product/toggle/:id', requireAdmin, async (req, res) => {
  try {
    const products = await readFresh('products.json');
    const product = products.find(p => p.id === req.params.id);

    if (!product) {
      return res.json({ success: false, message: 'Produk tidak ditemukan' });
    }

    product.status = product.status === 'active' ? 'inactive' : 'active';
    await writeDB('products.json', products);

    res.json({ success: true, message: 'Status produk berhasil diubah', status: product.status });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/product/add-keys/:id', requireAdmin, async (req, res) => {
  try {
    const { keys } = req.body;
    const products = await readFresh('products.json');
    const product = products.find(p => p.id === req.params.id);

    if (!product) {
      return res.json({ success: false, message: 'Produk tidak ditemukan' });
    }

    const newKeys = keys.split('\n').map(k => k.trim()).filter(k => k);
    product.keys = product.keys || [];
    product.keys.push(...newKeys);

    await writeDB('products.json', products);
    res.json({ success: true, message: `${newKeys.length} key berhasil ditambahkan`, keyCount: product.keys.length });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/settings/update', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const { siteName, gamePanelName, about, marqueeText, whatsapp, telegram, email, adminUsername, categories, categoryLabels } = req.body;

    if (siteName)      settings.siteName      = siteName;
    if (gamePanelName) settings.gamePanelName = gamePanelName;
    if (about !== undefined) settings.about   = about;
    if (marqueeText)   settings.marqueeText   = marqueeText;
    if (adminUsername) { settings.adminUsername = adminUsername; settings.credentialsCustomized = true; }

    settings.contact = settings.contact || {};
    if (whatsapp !== undefined) settings.contact.whatsapp = whatsapp;
    if (telegram !== undefined) settings.contact.telegram = telegram;
    if (email    !== undefined) settings.contact.email    = email;
    const { whatsappChannel, turnstileSiteKey, turnstileSecretKey } = req.body;
    if (whatsappChannel !== undefined) settings.contact.whatsappChannel = whatsappChannel;
    settings.turnstile = settings.turnstile || {};
    if (turnstileSiteKey    !== undefined) settings.turnstile.siteKey    = turnstileSiteKey;
    if (turnstileSecretKey  !== undefined) settings.turnstile.secretKey  = turnstileSecretKey;

    // Handle categories update from JSON string or array
    if (categories) {
      try {
        settings.categories = JSON.parse(categories);
      } catch(e) {
        if (Array.isArray(categories)) settings.categories = categories;
      }
    }
    if (categoryLabels) {
      try {
        settings.categoryLabels = JSON.parse(categoryLabels);
      } catch(e) {
        if (typeof categoryLabels === 'object') settings.categoryLabels = categoryLabels;
      }
    }

    await writeDB('settings.json', settings);
    res.json({ success: true, message: 'Pengaturan berhasil diupdate' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ── Tambah 1 kategori baru langsung dari halaman edit produk (auto-tersambung ke filter homepage) ──
app.post('/admin/categories/add', requireAdmin, async (req, res) => {
  try {
    const { key, label } = req.body;
    if (!key || !label) return res.json({ success: false, message: 'Nama kategori wajib diisi' });
    const cleanKey = String(key).trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
    if (!cleanKey) return res.json({ success: false, message: 'Nama kategori tidak valid' });

    const settings = await readFresh('settings.json');
    settings.categories = settings.categories || [];
    settings.categoryLabels = settings.categoryLabels || {};

    if (settings.categories.includes(cleanKey)) {
      return res.json({ success: true, key: cleanKey, message: 'Kategori sudah ada, dipakai ulang' });
    }
    settings.categories.push(cleanKey);
    settings.categoryLabels[cleanKey] = String(label).trim().slice(0, 40);

    await writeDB('settings.json', settings);
    res.json({ success: true, key: cleanKey });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/settings/pakasir', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const { qrisMode } = req.body;

    if (qrisMode) settings.qrisMode = qrisMode;

    await writeDB('settings.json', settings);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/qris/test', requireAdmin, async (req, res) => {
  try {
    // Test pakai kredensial dari environment variable (GENSPAY_BASE_URL / GENSPAY_API_KEY),
    // bukan dari input panel — GensPay tidak butuh Merchant ID / Project ID.
    await createQRISPayment('test-' + Date.now(), 1000, {}, `${getAppBaseUrl(req)}/webhook/genspay`);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// RESELLER API (Auto Stock) — porting dari GNE dengan metode identik.
// ══════════════════════════════════════════════════════════════════

// Simpan kredensial Reseller API (dipakai untuk produk stockMode/stockSource
// 'auto'). Disimpan di settings.json — sama seperti pola pakasir/nowpayments
// di atas. Nama endpoint sengaja "reseller-api" (bukan "reseller") supaya
// tidak tabrakan dengan /admin/settings/reseller yang sudah dipakai untuk
// program Reseller VIP (fitur berbeda, tidak ada hubungannya).
app.post('/admin/settings/reseller-api', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const { apiKey, apiSecret, baseUrl } = req.body;

    // PENTING: kalau admin submit string KOSONG ('') di field apiKey/apiSecret,
    // itu artinya "hapus / pakai env var lagi", BUKAN "simpan string kosong".
    // Perilaku lama menyimpan '' apa adanya ke settings.resellerApi, yang
    // masih trim ke '' di getConfig() jadi env var tetap kepakai -- tapi ini
    // rawan bikin bingung kalau suatu saat field terisi nilai lama/salah dan
    // tidak sengaja ke-submit lagi (mis. browser autofill), karena nilai
    // non-kosong di settings.resellerApi SELALU menang atas env var (lihat
    // getConfig() di reseller-api.js). Supaya jelas & konsisten, kalau kedua
    // field dikirim kosong sekaligus, hapus resellerApi dari settings sama
    // sekali sehingga env var jadi satu-satunya sumber (tidak ada override
    // tersembunyi di database yang bisa bikin "sudah isi env var kok gak
    // kepakai").
    const trimmedKey = (apiKey ?? settings.resellerApi?.apiKey ?? '').trim();
    const trimmedSecret = (apiSecret ?? settings.resellerApi?.apiSecret ?? '').trim();

    if (!trimmedKey && !trimmedSecret) {
      delete settings.resellerApi;
    } else {
      settings.resellerApi = {
        apiKey: trimmedKey,
        apiSecret: trimmedSecret,
        baseUrl: (baseUrl !== undefined ? baseUrl : (settings.resellerApi?.baseUrl || 'https://vipibmstore.com/api/reseller')).trim()
      };
    }

    await writeDB('settings.json', settings);
    res.json({ success: true, usingEnvFallback: !settings.resellerApi });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Debug: tunjukkan SUMBER kredensial mana yang sedang aktif (settings.json
// DB vs env var vs tidak ada sama sekali) + hasil tes signature request ke
// provider. Dipakai untuk kasus klasik "sudah isi env var tapi Auto Restock
// tetap gagal" -- root cause paling sering adalah settings.resellerApi di
// database (diisi dulu, mungkin lewat percobaan/typo) yang MENIMPA env var
// karena getConfig() prioritaskan database di atas env var. Endpoint ini
// bikin ketahuan tanpa perlu buka Supabase dashboard manual.
app.post('/admin/reseller-api/debug', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const dbConfigured = Boolean(settings.resellerApi?.apiKey && settings.resellerApi?.apiSecret);
    const envConfigured = Boolean(process.env.RESELLER_API_KEY && process.env.RESELLER_API_SECRET);
    const activeSource = dbConfigured ? 'database (panel admin)' : (envConfigured ? 'environment variable' : 'TIDAK ADA — belum dikonfigurasi sama sekali');
    const info = await resellerApi.debugBalance(settings);
    res.json({
      success: true,
      activeSource,
      dbConfigured,
      envConfigured,
      note: dbConfigured && envConfigured
        ? 'Kredensial di database MENIMPA env var (database selalu prioritas). Kalau env var sudah diisi tapi tetap tidak kepakai, kemungkinan besar ada nilai lama/salah tersimpan di database -- kosongkan field API Key & Secret di panel admin lalu Simpan untuk pakai env var.'
        : undefined,
      debug: info
    });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Test koneksi Reseller API — pakai nilai dari form (belum tentu sudah
// disimpan), supaya admin bisa cek dulu sebelum klik "Simpan".
app.post('/admin/reseller-api/test', requireAdmin, async (req, res) => {
  try {
    const { apiKey, apiSecret, baseUrl } = req.body;
    const tempSettings = { resellerApi: { apiKey, apiSecret, baseUrl } };
    const result = await resellerApi.getBalance(tempSettings);
    if (!result.success) {
      return res.json({ success: false, message: result.message, code: result.code, status: result.status });
    }
    res.json({ success: true, balance: result.data?.balance, currency: result.data?.currency });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// List produk dari Reseller API — dipakai di halaman Edit Produk untuk
// membantu admin memilih/mapping resellerItemId tanpa perlu hafal ID manual.
app.get('/admin/reseller-api/products', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    // FIX: sebelumnya pakai resellerApi.getProducts() (TANPA cache) -- setiap
    // admin buka halaman Edit Produk atau klik "Muat Ulang" langsung hit API
    // provider mentah-mentah. Kalau ini kejadian bersamaan dengan checkout
    // customer yang lagi jalan (checkout juga manggil provider untuk resolve
    // stok/order), total request ke vipibmstore.com bisa numpuk dan kena
    // rate limit ("Too many requests") dari provider. Sekarang pakai
    // getProductsCached() yang SAMA dipakai checkout -- 1 fetch (cache 3
    // menit) dipakai bareng oleh admin panel & proses checkout, bukan
    // masing-masing manggil sendiri-sendiri.
    const result = await resellerApi.getProductsCached(settings);
    if (!result.success) return res.json({ success: false, message: result.message });
    res.json({ success: true, products: result.data || [] });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Paksa refresh cache provider (bypass cache) -- dipakai tombol "Muat Ulang"
// kalau admin BENERAN butuh data terbaru (misal baru nambah produk baru di
// dashboard provider dan cache 3 menit belum expired). Endpoint /products di
// atas (dipanggil otomatis saat halaman dibuka) TETAP pakai cache biar hemat.
app.post('/admin/reseller-api/products/force-refresh', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const result = await resellerApi.getProducts(settings); // bypass cache, sekali ini saja
    if (!result.success) return res.json({ success: false, message: result.message });
    resellerApi.setProductsCache(result.data || []); // simpan hasil fresh ini ke cache supaya request berikutnya (termasuk checkout) ikut kebagian data baru tanpa fetch ulang
    res.json({ success: true, products: result.data || [] });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Gabungan produk untuk dropdown mapping di halaman edit produk: sumber
// LEGACY (reseller-api.js single-provider vipibmstore.com, via cache) +
// semua provider MULTI-PROVIDER yang aktif (providers/*.js). Field
// dinormalisasi ke bentuk yang sama dipakai dropdown lama (id, product_name,
// item_name, price, stock_mode, stock) supaya UI existing tidak perlu
// diubah -- item dari sumber multi-provider ditandai `source`+`providerInstanceId`
// supaya saat checkout sistem tahu harus panggil adapter mana.
app.get('/admin/providers/mapping-products', requireAdmin, async (req, res) => {
  try {
    const combined = [];

    // Sumber 1: reseller-api lama (vipibmstore.com) -- pakai cache, sama
    // seperti endpoint /admin/reseller-api/products supaya tidak nge-hit
    // provider berkali-kali tiap admin buka halaman edit produk.
    try {
      const settings = await readFresh('settings.json');
      const legacyResult = await resellerApi.getProductsCached(settings);
      if (legacyResult.success && Array.isArray(legacyResult.data)) {
        legacyResult.data.forEach(item => {
          combined.push({ ...item, source: 'legacy', providerInstanceId: null });
        });
      }
    } catch (e) {
      // Legacy provider gagal/belum dikonfigurasi -- tidak fatal, lanjut ke multi-provider
    }

    // Sumber 2: semua provider multi-provider yang aktif. Dipanggil paralel
    // supaya 1 provider lambat/timeout tidak memperlambat provider lain.
    const activeProviders = providerStore.getProviders().filter(p => p.active);
    await Promise.all(activeProviders.map(async (provider) => {
      try {
        const result = await providerStore.callAdapter(provider.id, 'getProducts');
        if (result.success && Array.isArray(result.products)) {
          result.products.forEach(item => {
            combined.push({
              // ID gabungan (providerInstanceId + id asli) supaya tidak
              // bentrok antar provider yang kebetulan sama-sama pakai id "1", "2", dst.
              id: `mp:${provider.id}:${item.providerProductId}`,
              product_name: provider.name,
              item_name: item.name,
              category: item.category || '', // nama game biasanya di sini, terpisah dari nama paket
              price: item.costPrice,
              stock_mode: item.stock === null ? 'v2' : 'v1',
              stock: item.stock,
              source: 'multi',
              providerInstanceId: provider.id,
              providerProductId: item.providerProductId,
            });
          });
        }
      } catch (e) {
        // Provider ini gagal diambil -- skip, jangan gagalkan gabungan seluruhnya
      }
    }));

    res.json({ success: true, products: combined });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// MULTI-PROVIDER RESELLER API (sistem baru, terpisah dari resellerApi
// single-provider vipibmstore.com di atas -- lihat provider-store.js
// dan folder providers/ untuk arsitektur adapter-nya).
// ══════════════════════════════════════════════════════════════════

// List adapter yang tersedia di sistem (buat dropdown "Tambah Provider")
app.get('/admin/providers/adapters', requireAdmin, (req, res) => {
  try {
    res.json({ success: true, data: providerRegistry.listAdapters() });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// List semua provider instance yang sudah ditambahkan admin
app.get('/admin/providers', requireAdmin, (req, res) => {
  try {
    const providers = providerStore.getProviders().map(p => ({
      ...p,
      // Mask API key/secret di list view -- jangan kirim credential utuh ke client
      config: maskProviderConfig(p.config),
    }));
    res.json({ success: true, data: providers });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Tambah provider baru
app.post('/admin/providers', requireAdmin, async (req, res) => {
  try {
    const { adapterId, name, config } = req.body;
    if (!adapterId) return res.json({ success: false, message: 'adapterId wajib diisi' });
    const record = await providerStore.addProvider({ adapterId, name, config });
    res.json({ success: true, data: { ...record, config: maskProviderConfig(record.config) } });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Update provider (config, aktif/nonaktif, auto sync)
app.put('/admin/providers/:id', requireAdmin, async (req, res) => {
  try {
    const { name, config, active, autoSync, autoSyncIntervalMinutes } = req.body;
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (config !== undefined) {
      // Jangan timpa API key/secret kalau field dikirim kosong (form edit
      // yang menampilkan credential ter-mask, sama pola seperti NOWPayments di atas)
      const existing = providerStore.getProvider(req.params.id);
      const cleaned = { ...config };
      Object.keys(cleaned).forEach(k => {
        if (cleaned[k] === '' && existing?.config?.[k]) delete cleaned[k];
      });
      patch.config = cleaned;
    }
    if (active !== undefined) patch.active = !!active;
    if (autoSync !== undefined) patch.autoSync = !!autoSync;
    if (autoSyncIntervalMinutes !== undefined) patch.autoSyncIntervalMinutes = parseInt(autoSyncIntervalMinutes) || 60;
    const record = await providerStore.updateProvider(req.params.id, patch);
    res.json({ success: true, data: { ...record, config: maskProviderConfig(record.config) } });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Hapus provider
app.delete('/admin/providers/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await providerStore.deleteProvider(req.params.id);
    res.json({ success: ok, message: ok ? undefined : 'Provider tidak ditemukan' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Test Connection
app.post('/admin/providers/:id/test', requireAdmin, async (req, res) => {
  try {
    const result = await providerStore.callAdapter(req.params.id, 'testConnection');
    res.json(result);
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Get Balance
app.get('/admin/providers/:id/balance', requireAdmin, async (req, res) => {
  try {
    const result = await providerStore.callAdapter(req.params.id, 'getBalance');
    res.json(result);
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Manual Sync -- ambil produk dari provider, TIDAK otomatis menimpa produk
// lokal (biar admin bisa review dulu); hasil dikirim balik ke admin untuk
// dipilih mana yang mau di-import/update.
app.post('/admin/providers/:id/sync', requireAdmin, async (req, res) => {
  try {
    const result = await providerStore.callAdapter(req.params.id, 'getProducts');
    const status = result.success ? 'success' : 'failed';
    await providerStore.updateProvider(req.params.id, {
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: status,
      lastSyncMessage: result.message || (result.success ? `${result.products?.length || 0} produk ditemukan` : null),
    });
    res.json(result);
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Import/update produk lokal dari hasil sync provider (dipanggil setelah
// admin review hasil /sync dan pilih produk mana yang mau diproses).
app.post('/admin/providers/:id/import', requireAdmin, async (req, res) => {
  try {
    const { items } = req.body; // [{ providerProductId, name, category, costPrice, sellPrice, localProductId? }]
    if (!Array.isArray(items) || !items.length) {
      return res.json({ success: false, message: 'Tidak ada item untuk di-import' });
    }
    const provider = providerStore.getProvider(req.params.id);
    if (!provider) return res.json({ success: false, message: 'Provider tidak ditemukan' });

    const products = readDB('products.json');
    let created = 0, updated = 0;

    for (const item of items) {
      const sellPrice = Math.max(0, parseInt(item.sellPrice) || Math.round((parseInt(item.costPrice) || 0) * 1.2));
      let product = item.localProductId ? products.find(p => p.id === item.localProductId) : null;

      if (product) {
        // Update produk lokal existing -- sinkron harga/nama/kategori/stok
        product.name = item.name || product.name;
        product.category = item.category || product.category;
        product.providerId = provider.id;
        product.providerProductId = item.providerProductId;
        product.pricingOptions = [{ days: 30, price: sellPrice }];
        updated++;
      } else {
        // Produk baru dari provider
        product = {
          id: uuidv4(),
          name: item.name || 'Produk Import',
          category: item.category || 'lainnya',
          description: '',
          image: '',
          status: 'active',
          platforms: [],
          keysMode: 'auto',
          keys: [],
          stockMode: 'auto',
          providerId: provider.id,
          providerProductId: item.providerProductId,
          pricingOptions: [{ days: 30, price: sellPrice }],
          createdAt: new Date().toISOString(),
        };
        products.push(product);
        created++;
      }
    }

    await writeDB('products.json', products);
    res.json({ success: true, created, updated });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Log API -- riwayat request/response tiap pemanggilan ke provider
app.get('/admin/providers/:id/logs', requireAdmin, (req, res) => {
  try {
    const logs = providerStore.getLogs({ providerInstanceId: req.params.id, limit: parseInt(req.query.limit) || 100 });
    res.json({ success: true, data: logs });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Log API gabungan semua provider (buat halaman "Log API" umum)
app.get('/admin/providers-logs', requireAdmin, (req, res) => {
  try {
    const logs = providerStore.getLogs({ limit: parseInt(req.query.limit) || 200 });
    res.json({ success: true, data: logs });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Helper: mask API key/secret sebelum dikirim ke client (tampilkan cuma
// beberapa karakter awal, sisanya bintang) -- sama pola seperti kredensial
// NOWPayments/GensPay yang lain di admin panel ini.
function maskProviderConfig(config = {}) {
  const masked = { ...config };
  ['apiKey', 'apiSecret', 'webhookSecret'].forEach(key => {
    if (masked[key]) {
      const v = String(masked[key]);
      masked[key] = v.length > 4 ? v.slice(0, 4) + '••••••••' : '••••••••';
    }
  });
  return masked;
}

// ── Webhook publik: menerima notifikasi order.success dari provider ──
// URL ini didaftarkan di dashboard provider (mis. cheatgame.online).
// Path menyertakan provider instance id supaya sistem tahu adapter mana
// yang harus dipakai untuk verifikasi signature.
app.post('/webhook/provider/:id', async (req, res) => {
  try {
    const provider = providerStore.getProvider(req.params.id);
    if (!provider) return res.status(404).json({ success: false, message: 'Provider tidak ditemukan' });

    const adapter = providerStore.getAdapterInstance(req.params.id);
    if (!adapter) return res.status(400).json({ success: false, message: 'Adapter tidak dikenal' });

    const result = await adapter.handleWebhook(req);
    await providerStore.logApiCall({
      providerInstanceId: provider.id,
      providerLabel: provider.name,
      action: 'webhook',
      request: { headers: req.headers, body: req.body },
      response: result,
      success: !!result?.valid,
    });

    if (!result.valid) {
      return res.status(401).json({ success: false, message: result.message || 'Signature tidak valid' });
    }

    // Cari transaksi lokal berdasarkan providerOrderId (disimpan saat
    // checkout multi-provider masih 'processing', lihat
    // generateAutoKeyMultiProvider + allocateKeyAndCompleteTransaction),
    // lalu selesaikan transaksi persis seperti jalur checkout normal --
    // field & status HARUS konsisten (transaction.key, status='done',
    // paidAt) supaya tidak ada 2 bentuk "transaksi selesai" yang beda di
    // sistem ini.
    if (result.providerOrderId) {
      const transactions = readDB('transactions.json');
      const trx = transactions.find(t => t.providerOrderId === result.providerOrderId);
      if (trx && trx.status === 'processing' && result.status === 'success') {
        trx.status = 'done';
        trx.key = result.deliveryKey || result.deliveryLink || null;
        if (result.deliveryLink) trx.downloadLink = result.deliveryLink;
        trx.paidAt = new Date().toISOString();
        await writeDB('transactions.json', transactions);

        // Update sold counter produk + notifikasi, sama seperti alur checkout normal.
        if (!trx.key) {
          // Webhook bilang sukses tapi tidak ada key/link -- tetap catat di
          // log (sudah otomatis lewat logApiCall di atas), tapi jangan
          // pura-pura pembeli dapat sesuatu yang sebenarnya kosong.
          trx.status = 'failed';
          trx.failReason = 'Webhook provider melaporkan sukses tapi tidak menyertakan key/link pengiriman.';
          await writeDB('transactions.json', transactions);
        } else {
          const products = readDB('products.json');
          const product = products.find(p => p.id === trx.productId);
          if (product) {
            product.sold = (product.sold || 0) + 1;
            await writeDB('products.json', products);
          }
          const notifs = readDB('notifications.json');
          const buyer = readDB('users.json').find(u => u.id === trx.userId);
          notifs.unshift({
            id: uuidv4(), type: 'purchase', buyerName: trx.customerName,
            buyerPhoto: buyer?.photo || null, productName: trx.productName,
            price: trx.price, time: trx.paidAt, timeStr: formatDate(new Date(trx.paidAt)),
          });
          await writeDB('notifications.json', notifs);
        }
      } else if (trx && result.status === 'success' && trx.status !== 'processing') {
        // Transaksi sudah dalam status lain (mis. sudah 'done' dari polling
        // checkout duluan sebelum webhook sampai) -- webhook ini telat,
        // idempotent: tidak perlu diproses ulang, cukup diamkan.
      }
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Google OAuth: simpan kredensial dari panel admin ──
app.post('/admin/settings/google', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const { clientId, clientSecret } = req.body;

    settings.google = {
      clientId: clientId !== undefined ? clientId : (settings.google?.clientId || ''),
      // Kalau field secret dikirim kosong saat edit (karena di-mask di UI), pertahankan secret lama
      clientSecret: (clientSecret !== undefined && clientSecret !== '') ? clientSecret : (settings.google?.clientSecret || ''),
    };

    await writeDB('settings.json', settings);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ── NOWPayments: simpan kredensial dari panel admin ──
app.post('/admin/settings/nowpayments', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const { apiKey, ipnSecret, payCurrency } = req.body;

    settings.nowpayments = {
      apiKey: apiKey !== undefined ? apiKey : (settings.nowpayments?.apiKey || ''),
      // Kalau field secret dikirim kosong saat edit (karena di-mask), pertahankan secret lama
      ipnSecret: (ipnSecret !== undefined && ipnSecret !== '') ? ipnSecret : (settings.nowpayments?.ipnSecret || ''),
      payCurrency: (payCurrency || settings.nowpayments?.payCurrency || 'usdtt').toLowerCase()
    };

    await writeDB('settings.json', settings);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ── NOWPayments: test koneksi kredensial (cek API Key valid lewat endpoint /status & /balance) ──
app.post('/admin/nowpayments/test', requireAdmin, async (req, res) => {
  try {
    const { apiKey } = req.body;
    const key = apiKey || (await readFresh('settings.json')).nowpayments?.apiKey || process.env.NOWPAYMENTS_API_KEY || '';
    if (!key) return res.json({ success: false, message: 'API Key belum diisi' });

    const statusResp = await fetch('https://api.nowpayments.io/v1/status');
    const statusData = await statusResp.json();
    if (!statusResp.ok || statusData.message !== 'OK') {
      return res.json({ success: false, message: 'API NOWPayments sedang bermasalah, coba lagi nanti.' });
    }

    const balResp = await fetch('https://api.nowpayments.io/v1/balance', { headers: { 'x-api-key': key } });
    const balData = await balResp.json();
    if (!balResp.ok) {
      return res.json({ success: false, message: balData.message || 'API Key ditolak NOWPayments (cek kembali API Key kamu).' });
    }

    res.json({ success: true, message: 'Koneksi ke NOWPayments berhasil, API Key valid.' });
  } catch (error) {
    res.json({ success: false, message: 'NOWPayments error: ' + error.message });
  }
});

// ── Binance Pay: simpan kredensial dari panel admin ──
app.post('/admin/settings/binancepay', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const { apiKey, secretKey, currency } = req.body;

    settings.binancepay = {
      apiKey: apiKey !== undefined ? apiKey : (settings.binancepay?.apiKey || ''),
      // Kalau field secret dikirim kosong saat edit (karena di-mask), pertahankan secret lama
      secretKey: (secretKey !== undefined && secretKey !== '') ? secretKey : (settings.binancepay?.secretKey || ''),
      currency: (currency || settings.binancepay?.currency || 'IDR').toUpperCase()
    };
    // Reset cache sertifikat -- kalau admin ganti API Key/Secret, cert lama (kalau ada) sudah tidak relevan
    binancePayCertCache = { certPublic: null, certSerial: null, fetchedAt: 0 };

    await writeDB('settings.json', settings);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});


// ══════════════════════════════════════════════════════════════════════
// PARTNER RESELLER API — HeroMarket sebagai PROVIDER untuk web orang lain.
// Kebalikan dari reseller-api.js (HeroMarket sbg konsumen vipibmstore.com).
//
// Alur bisnis:
//   1. Admin HeroMarket generate API Key+Secret untuk partner dari panel
//      admin, lalu isi saldo partner secara manual (partner transfer dulu
//      ke HeroMarket, admin top up saldo partner-nya).
//   2. Web partner integrasi 3 endpoint publik di bawah (GET /balance,
//      GET /products, POST /order) pakai HMAC signature (lihat partner-api.js).
//   3. Saat customer partner checkout, web partner panggil POST /order.
//      Sistem HeroMarket: cek saldo partner cukup -> potong saldo partner
//      -> alokasikan key (reuse allocateKeyAndCompleteTransaction, SAMA
//      PERSIS logic yang dipakai checkout normal HeroMarket, supaya tidak
//      ada 2 jalur alokasi key yang bisa divergen) -> key langsung
//      dikembalikan di response, partner kirim ke customer mereka sendiri.
//      Semua ini terjadi otomatis tanpa admin HeroMarket perlu tahu/input.
// ══════════════════════════════════════════════════════════════════════

// ── ADMIN: CRUD Partner ──
app.get('/admin/partners', requireAdmin, async (req, res) => {
  try {
    const partners = await readFresh('partners.json');
    // JANGAN PERNAH kirim secretHash ke client, sekalipun ke admin sendiri
    const safe = partners.map(({ secretHash, ...p }) => p);
    res.json({ success: true, data: safe });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/partners/create', requireAdmin, async (req, res) => {
  try {
    const { name, notes } = req.body;
    if (!name || !name.trim()) return res.json({ success: false, message: 'Nama partner wajib diisi' });

    const partners = await readFresh('partners.json');
    const { apiKey, apiSecret, secretHash } = partnerApi.generateCredentials();
    const partner = {
      id: uuidv4(),
      name: name.trim(),
      notes: (notes || '').trim(),
      apiKey,
      secretHash,
      balance: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      totalOrders: 0,
      totalSpent: 0
    };
    partners.push(partner);
    await writeDB('partners.json', partners);

    // apiSecret mentah HANYA dikembalikan di response INI, satu kali saja.
    // Setelah ini tidak akan pernah bisa dilihat lagi (cuma secretHash yang
    // tersimpan) -- kalau admin lupa mencatatnya, harus regenerate baru.
    res.json({ success: true, partner: { ...partner, secretHash: undefined }, apiSecret, warning: 'API Secret ini hanya ditampilkan SEKALI. Segera salin & kirim ke partner secara aman.' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/partners/:id/topup', requireAdmin, async (req, res) => {
  try {
    const { amount } = req.body;
    const nominal = parseInt(amount);
    if (!nominal || nominal <= 0) return res.json({ success: false, message: 'Nominal tidak valid' });

    const partners = await readFresh('partners.json');
    const partner = partners.find(p => p.id === req.params.id);
    if (!partner) return res.json({ success: false, message: 'Partner tidak ditemukan' });

    partner.balance = (partner.balance || 0) + nominal;
    await writeDB('partners.json', partners);
    res.json({ success: true, balance: partner.balance });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/partners/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status)) return res.json({ success: false, message: 'Status tidak valid' });

    const partners = await readFresh('partners.json');
    const partner = partners.find(p => p.id === req.params.id);
    if (!partner) return res.json({ success: false, message: 'Partner tidak ditemukan' });

    partner.status = status;
    await writeDB('partners.json', partners);
    res.json({ success: true, status: partner.status });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/partners/:id/regenerate-secret', requireAdmin, async (req, res) => {
  try {
    const partners = await readFresh('partners.json');
    const partner = partners.find(p => p.id === req.params.id);
    if (!partner) return res.json({ success: false, message: 'Partner tidak ditemukan' });

    // API Key dipertahankan (biar partner tidak perlu ganti kode integrasi
    // sama sekali), hanya Secret yang diganti -- misal karena diduga bocor.
    const { apiSecret, secretHash } = partnerApi.generateCredentials();
    partner.secretHash = secretHash;
    await writeDB('partners.json', partners);
    res.json({ success: true, apiSecret, warning: 'API Secret baru ini hanya ditampilkan SEKALI.' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/partners/:id/delete', requireAdmin, async (req, res) => {
  try {
    let partners = await readFresh('partners.json');
    const exists = partners.some(p => p.id === req.params.id);
    if (!exists) return res.json({ success: false, message: 'Partner tidak ditemukan' });
    partners = partners.filter(p => p.id !== req.params.id);
    await writeDB('partners.json', partners);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ── PUBLIC: 3 endpoint inti yang dipanggil web partner ──
const getFreshPartners = () => readFresh('partners.json');
const partnerAuth = partnerApi.verifyPartnerRequest(getFreshPartners);

// Tandai partner terakhir kali dipakai — best-effort, tidak menghalangi respons
async function touchPartnerUsage(partnerId) {
  try {
    const partners = await readFresh('partners.json');
    const p = partners.find(x => x.id === partnerId);
    if (p) { p.lastUsedAt = new Date().toISOString(); await writeDB('partners.json', partners); }
  } catch { /* non-fatal */ }
}

app.get('/api/reseller/balance', partnerAuth, async (req, res) => {
  touchPartnerUsage(req.partner.id);
  res.json({ success: true, data: { balance: req.partner.balance, currency: 'IDR', partnerName: req.partner.name } });
});

app.get('/api/reseller/products', partnerAuth, async (req, res) => {
  touchPartnerUsage(req.partner.id);
  try {
    const products = await readSmart('products.json');
    const data = products
      .filter(p => p.status === 'active')
      .map(p => ({
        id: p.id,
        name: p.name,
        category: p.category,
        description: p.description || '',
        image: p.image || '',
        // Stok yang ditampilkan ke partner: untuk produk mode manual, jumlah
        // key aktual tersisa; untuk mode auto (Reseller API/GNE), stok tidak
        // terbatas dari sisi HeroMarket (provider yang punya stok), jadi
        // ditandai unlimited supaya partner tidak salah kira produk habis.
        items: (p.pricingOptions || []).map(o => ({
          days: o.days,
          price: o.resellerPrice !== undefined ? o.resellerPrice : o.price,
          stockMode: o.stockSource === 'manual' ? 'limited' : 'unlimited',
          stock: o.stockSource === 'manual'
            ? (p.keys || []).filter(k => k.endsWith(':' + o.days) || !k.includes(':')).length
            : null
        }))
      }));
    res.json({ success: true, data });
  } catch (error) {
    res.json({ success: false, code: 'INTERNAL_ERROR', message: error.message });
  }
});

app.post('/api/reseller/order', partnerAuth, async (req, res) => {
  // RACE CONDITION FIX: kunci per-partner supaya 2 request bareng tidak
  // double-spend saldo partner yang sama.
  const partnerLockKey = 'partner-' + req.partner.id;
  if (processingOrders.has(partnerLockKey)) {
    return res.status(429).json({ success: false, code: 'CONCURRENT_REQUEST', message: 'Sedang memproses order lain. Tunggu sebentar.' });
  }
  processingOrders.add(partnerLockKey);
  try {
    const { productId, days, quantity, customerReference, target } = req.body;
    const qty = parseInt(quantity) || 1;

    if (!productId) return res.status(400).json({ success: false, code: 'MISSING_PRODUCT_ID', message: 'productId wajib diisi' });
    if (qty < 1 || qty > 50) return res.status(400).json({ success: false, code: 'INVALID_QUANTITY', message: 'quantity harus 1-50 per request' });

    const products = await readFresh('products.json');
    const product = products.find(p => p.id === productId && p.status === 'active');
    if (!product) return res.status(404).json({ success: false, code: 'PRODUCT_NOT_FOUND', message: 'Produk tidak ditemukan atau nonaktif' });

    const opt = (product.pricingOptions || []).find(o => o.days === parseInt(days));
    if (!opt) return res.status(400).json({ success: false, code: 'INVALID_DAYS', message: 'Varian hari tidak ditemukan untuk produk ini' });

    const unitPrice = opt.resellerPrice !== undefined ? opt.resellerPrice : opt.price;
    const totalPrice = unitPrice * qty;

    // Idempotency: kalau partner kirim customerReference yang sama persis
    // dengan order yang sudah PERNAH sukses sebelumnya, kembalikan hasil
    // yang sama tanpa memotong saldo lagi (retry-safe, mencegah double
    // charge kalau response sebelumnya gagal sampai ke partner karena
    // network error padahal order-nya sendiri sukses).
    const transactions = await readFresh('transactions.json');
    if (customerReference) {
      const existing = transactions.find(t => t.type === 'partner-order' && t.partnerId === req.partner.id && t.customerReference === customerReference);
      if (existing) {
        return res.json({
          success: true, idempotent: true,
          data: { orderId: existing.id, status: existing.status, keys: existing.allocatedKeys || [], totalPrice: existing.totalPrice }
        });
      }
    }

    // Re-baca saldo partner PALING BARU tepat sebelum potong (readFresh,
    // bukan req.partner yang mungkin sudah agak basi kalau ada request lain
    // yang nyelip di antara auth check dan sini).
    const partners = await readFresh('partners.json');
    const partner = partners.find(p => p.id === req.partner.id);
    if (!partner) return res.status(401).json({ success: false, code: 'INVALID_API_KEY', message: 'Partner tidak ditemukan' });
    if ((partner.balance || 0) < totalPrice) {
      return res.status(402).json({ success: false, code: 'INSUFFICIENT_BALANCE', message: `Saldo tidak cukup. Saldo: ${partner.balance}, dibutuhkan: ${totalPrice}` });
    }

    // Potong saldo partner DI MUKA (sebelum alokasi key), konsisten dengan
    // pola checkout saldo internal HeroMarket -- kalau alokasi key gagal di
    // bawah, allocateKeyAndCompleteTransaction akan REFUND otomatis (lihat
    // logic refund di fungsi itu, sudah general untuk berbagai tipe akun).
    partner.balance -= totalPrice;
    await writeDB('partners.json', partners);

    const allocatedKeys = [];
    let failReason = null;

    for (let i = 0; i < qty; i++) {
      const txId = uuidv4();
      const transaction = {
        id: txId,
        type: 'partner-order',
        partnerId: partner.id,
        partnerName: partner.name,
        customerReference: qty > 1 ? `${customerReference || txId}-${i + 1}` : (customerReference || txId),
        productId: product.id,
        productName: product.name,
        selectedDays: opt.days,
        price: unitPrice,
        totalPayment: unitPrice,
        status: 'pending',
        wa: target || '',
        createdAt: new Date().toISOString()
      };
      transactions.push(transaction);

      const result = await allocateKeyAndCompleteTransaction(transaction, transactions);
      if (result.status === 'done') {
        transaction.allocatedKeys = [transaction.key || result.key].filter(Boolean);
        allocatedKeys.push(transaction.key || result.key);
      } else {
        failReason = transaction.failReason || 'Gagal mengalokasikan key';
        // Refund sisa qty yang belum diproses (partner sudah kepotong penuh
        // di muka untuk qty * unitPrice, tapi kalau baru separuh berhasil,
        // kembalikan porsi yang gagal supaya partner tidak rugi).
        const remainingQty = qty - i;
        const refundAmount = remainingQty * unitPrice;
        const freshPartners = await readFresh('partners.json');
        const p2 = freshPartners.find(x => x.id === partner.id);
        if (p2) { p2.balance = (p2.balance || 0) + refundAmount; await writeDB('partners.json', freshPartners); }
        break;
      }
    }

    await writeDB('transactions.json', transactions);

    if (allocatedKeys.length === 0) {
      return res.status(422).json({ success: false, code: 'ALLOCATION_FAILED', message: failReason || 'Gagal mengalokasikan key, saldo sudah dikembalikan sepenuhnya.' });
    }

    const freshPartners2 = await readFresh('partners.json');
    const p3 = freshPartners2.find(x => x.id === partner.id);
    if (p3) {
      p3.totalOrders = (p3.totalOrders || 0) + allocatedKeys.length;
      p3.totalSpent = (p3.totalSpent || 0) + (allocatedKeys.length * unitPrice);
      await writeDB('partners.json', freshPartners2);
    }
    touchPartnerUsage(partner.id);

    const partialWarning = allocatedKeys.length < qty ? ` (${allocatedKeys.length}/${qty} berhasil, sisanya di-refund: ${failReason})` : '';
    res.json({
      success: true,
      data: {
        orderId: uuidv4(),
        productName: product.name,
        days: opt.days,
        quantity: allocatedKeys.length,
        totalPrice: allocatedKeys.length * unitPrice,
        keys: allocatedKeys,
        remainingBalance: p3 ? p3.balance : undefined
      },
      message: allocatedKeys.length === qty ? 'Order berhasil' : ('Order sebagian berhasil' + partialWarning)
    });
  } catch (error) {
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: error.message });
  } finally {
    processingOrders.delete(partnerLockKey);
  }
});

app.post('/admin/settings/password', requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.json({ success: false, message: 'Password minimal 6 karakter' });
    }

    const settings = await readFresh('settings.json');
    settings.adminPassword = await bcrypt.hash(newPassword, 12);
    // PENTING: tandai kredensial sudah di-custom manual lewat panel admin.
    // initDB() (dijalankan tiap cold start di Vercel) mengecek flag ini
    // supaya TIDAK PERNAH menimpa balik ke ADMIN_PASSWORD env var lagi --
    // sebelumnya, kalau env var di Vercel masih nilai lama (default/belum
    // diupdate admin di dashboard Vercel), ganti password di panel bisa
    // "berhasil" sesaat lalu ke-reset balik ke password lama begitu server
    // cold-start ulang (Vercel serverless sering restart setelah idle).
    settings.credentialsCustomized = true;

    await writeDB('settings.json', settings);
    res.json({ success: true, message: 'Password admin berhasil diubah' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/settings/popular-products', requireAdmin, async (req, res) => {
  try {
    const { popularProductIds } = req.body;
    const settings = await readFresh('settings.json');
    settings.popularProductIds = Array.isArray(popularProductIds) ? popularProductIds : [];
    await writeDB('settings.json', settings);
    res.json({ success: true, popularProductIds: settings.popularProductIds });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Simpan seluruh daftar paket topup saldo reseller (admin bisa atur bonus per paket)
app.post('/admin/settings/reseller-topup-packages', requireAdmin, async (req, res) => {
  try {
    const { packages } = req.body; // [{ nominal, bonus, label }]
    if (!Array.isArray(packages)) return res.json({ success: false, message: 'Data tidak valid' });
    const clean = [];
    for (const p of packages) {
      const nominal = parseInt(p.nominal);
      const bonus = parseInt(p.bonus) || 0;
      if (isNaN(nominal) || nominal <= 0) return res.json({ success: false, message: 'Nominal paket tidak valid' });
      if (bonus < 0) return res.json({ success: false, message: 'Bonus tidak boleh minus' });
      clean.push({ id: p.id || uuidv4(), nominal, bonus, label: (p.label || '').trim() || null });
    }
    clean.sort((a, b) => a.nominal - b.nominal);
    const settings = await readFresh('settings.json');
    settings.resellerTopupPackages = clean;
    await writeDB('settings.json', settings);
    res.json({ success: true, packages: clean });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/admin/settings/reseller', requireAdmin, async (req, res) => {
  try {
    const { resellerEnabled, resellerPrice, resellerDiscount, resellerNote, resellerTopupMin } = req.body;
    const settings = await readFresh('settings.json');
    settings.resellerEnabled = resellerEnabled === 'true' || resellerEnabled === true;
    if (resellerPrice !== undefined && resellerPrice !== '') {
      const price = parseInt(resellerPrice);
      if (isNaN(price) || price < 0) return res.json({ success: false, message: 'Harga reseller tidak valid' });
      settings.resellerPrice = price;
    }
    if (resellerDiscount !== undefined && resellerDiscount !== '') {
      const discount = parseInt(resellerDiscount);
      if (isNaN(discount) || discount < 0 || discount > 100) return res.json({ success: false, message: 'Diskon harus antara 0-100%' });
      settings.resellerDiscount = discount;
    }
    if (resellerTopupMin !== undefined && resellerTopupMin !== '') {
      const min = parseInt(resellerTopupMin);
      if (isNaN(min) || min < 0) return res.json({ success: false, message: 'Minimal topup tidak valid' });
      settings.resellerTopupMin = min;
    }
    if (resellerNote !== undefined) settings.resellerNote = resellerNote;
    await writeDB('settings.json', settings);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }

});

app.post('/admin/user/adjust-balance/:id', requireAdmin, async (req, res) => {
  try {
    const { amount, note } = req.body;
    const delta = parseInt(amount);
    if (isNaN(delta) || delta === 0) return res.json({ success: false, message: 'Nominal tidak valid' });
    const users = await readFresh('users.json');
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.json({ success: false, message: 'User tidak ditemukan' });
    const newBalance = (user.balance || 0) + delta;
    if (newBalance < 0) return res.json({ success: false, message: 'Saldo tidak boleh minus' });
    user.balance = newBalance;
    await writeDB('users.json', users);

    // Catat sebagai riwayat transaksi biar kelihatan di histori (opsional tapi berguna buat audit)
    const transactions = await readFresh('transactions.json');
    transactions.push({
      id: uuidv4(), orderId: `ADJ-${Date.now()}`, code: generateOrderCode(),
      userId: user.id, type: 'topup',
      productName: delta > 0 ? `Topup manual oleh admin${note ? ' — ' + note : ''}` : `Koreksi saldo oleh admin${note ? ' — ' + note : ''}`,
      customerName: user.username, price: delta, totalPayment: delta,
      status: 'done', key: null, isManualAdjustment: true,
      createdAt: new Date().toISOString(), paidAt: new Date().toISOString(), time: formatDate()
    });
    await writeDB('transactions.json', transactions);

    res.json({ success: true, balance: user.balance });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/admin/user/toggle-reseller/:id', requireAdmin, async (req, res) => {
  try {
    const users = await readFresh('users.json');
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.json({ success: false, message: 'User tidak ditemukan' });
    user.is_reseller = !user.is_reseller;
    user.role = user.is_reseller ? 'reseller' : 'user';
    if (user.is_reseller) {
      user.reseller_since = user.reseller_since || new Date().toISOString();
      user.reseller_code = user.reseller_code || ('RSL-' + user.username.toUpperCase().slice(0, 4) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase());
    }
    await writeDB('users.json', users);
    res.json({ success: true, is_reseller: user.is_reseller });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Konfirmasi transaksi manual oleh admin (untuk QRIS statis atau reseller)
app.post('/admin/transaction/confirm/:id', requireAdmin, async (req, res) => {
  try {
    const transactions = await readFresh('transactions.json');
    const transaction = transactions.find(t => t.id === req.params.id);
    if (!transaction) return res.json({ success: false, message: 'Transaksi tidak ditemukan' });
    if (transaction.status === 'done') return res.json({ success: false, message: 'Transaksi sudah selesai' });

    // Jika transaksi reseller, upgrade user
    if (transaction.type === 'reseller') {
      const users = await readFresh('users.json');
      const u = users.find(u => u.id === transaction.userId);
      if (u) {
        u.is_reseller = true;
        u.role = 'reseller';
        u.reseller_since = u.reseller_since || new Date().toISOString();
        u.reseller_code = u.reseller_code || ('RSL-' + u.username.toUpperCase().slice(0, 4) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase());
        await writeDB('users.json', users);
      }
      transaction.status = 'done';
      transaction.paidAt = new Date().toISOString();
      await writeDB('transactions.json', transactions);
      return res.json({ success: true, type: 'reseller' });
    }

    // Jika transaksi topup saldo, kredit saldo user (termasuk bonus kalau ada)
    if (transaction.type === 'topup') {
      const users = await readFresh('users.json');
      const u = users.find(u => u.id === transaction.userId);
      if (u) {
        u.balance = (u.balance || 0) + transaction.price + (transaction.bonus || 0);
        await writeDB('users.json', users);
      }
      transaction.status = 'done';
      transaction.paidAt = new Date().toISOString();
      await writeDB('transactions.json', transactions);
      return res.json({ success: true, type: 'topup', balance: u ? u.balance : undefined });
    }

    // Transaksi produk biasa: ambil key
    const products = readDB('products.json');
    const product = products.find(p => p.id === transaction.productId);
    let key = null;
    const stockSourceConfirm = product ? resolveStockSourceForDays(product, transaction.selectedDays) : 'manual';

    if (stockSourceConfirm === 'auto') {
      const genResult = await generateAutoKey(product, transaction.selectedDays, {
        customerReference: transaction.id,
        target: transaction.customerName || transaction.wa || undefined,
        idempotencyKey: transaction.id
      });
      if (genResult.key) {
        key = genResult.key;
        product.sold = (product.sold || 0) + 1;
        bumpDummySold(product);
        await writeDB('products.json', products);
      } else {
        // FIX: sebelumnya error di sini cuma dibalikin sbg toast tanpa
        // pernah disimpan ke transaksi -- transaksi nyangkut 'pending'
        // selamanya & alasan gagal hilang begitu toast ilang. Samakan
        // dengan alur allocateKeyAndCompleteTransaction: tandai 'failed'
        // + simpan failReason supaya kelihatan di kartu admin & bisa
        // di-retry (tombol tetap muncul karena status !== 'done').
        transaction.status = 'failed';
        transaction.failReason = genResult.error || 'Gagal generate key dari Reseller API';
        if (transaction.paymentMethod === 'balance') {
          const usersRefund = await readFresh('users.json');
          const uRefund = usersRefund.find(u => u.id === transaction.userId);
          if (uRefund) { uRefund.balance = (uRefund.balance || 0) + transaction.price; await writeDB('users.json', usersRefund); }
        }
        await writeDB('transactions.json', transactions);
        return res.json({ success: false, message: transaction.failReason });
      }
    } else if (product?.keys?.length > 0) {
      const days = transaction.selectedDays;
      if (days) {
        const idx = product.keys.findIndex(k => {
          const parts = k.split(':');
          return parts.length > 1 && parseInt(parts[parts.length - 1]) === days;
        });
        if (idx !== -1) { key = product.keys.splice(idx, 1)[0].split(':')[0]; }
      }
      if (!key) {
        const idx = product.keys.findIndex(k => !k.includes(':'));
        if (idx !== -1) key = product.keys.splice(idx, 1)[0];
        else key = product.keys.shift().split(':')[0];
      }
      product.sold = (product.sold || 0) + 1;
      bumpDummySold(product);
      await writeDB('products.json', products);
    } else {
      // Sama seperti allocateKeyAndCompleteTransaction: stok manual habis
      // (product.keys kosong) dan bukan mode auto -- JANGAN tandai 'done'
      // dengan key=null (perilaku lama, transaksi keliatan sukses padahal
      // customer tidak dapat apa-apa). Tandai gagal, admin isi stok lalu
      // klik Konfirmasi Bayar lagi untuk retry.
      transaction.status = 'failed';
      transaction.failReason = 'Stok key habis untuk produk ini. Silakan tambah stok lalu klik Konfirmasi Bayar lagi.';
      await writeDB('transactions.json', transactions);
      return res.json({ success: false, message: transaction.failReason });
    }

    transaction.status = 'done';
    transaction.key = key;
    transaction.paidAt = new Date().toISOString();
    transaction.confirmedBy = 'admin';
    await writeDB('transactions.json', transactions);

    // Tambahkan notifikasi pembelian agar muncul di social proof popup
    try {
      const notifs = readDB('notifications.json');
      const users = readDB('users.json');
      const buyer = users.find(u => u.id === transaction.userId);
      notifs.unshift({
        id: uuidv4(), type: 'purchase',
        buyerName: transaction.customerName,
        buyerPhoto: buyer?.photo || null,
        productName: transaction.productName,
        price: transaction.price,
        time: transaction.paidAt,
        timeStr: formatDate(new Date(transaction.paidAt))
      });
      await writeDB('notifications.json', notifs.slice(0, 50));
    } catch(ne) { /* non-critical */ }

    res.json({ success: true, key });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Leaderboard route
app.get('/leaderboard', (req, res) => {
  const transactions = readDB('transactions.json');
  const users = readDB('users.json');
  const settings = readDB('settings.json');

  // Calculate leaderboard from real transactions
  const userStats = {};

  transactions.forEach(t => {
    if (t.status === 'done' && t.userId) {
      if (!userStats[t.userId]) {
        userStats[t.userId] = {
          userId: t.userId,
          totalTransactions: 0,
          totalSpent: 0
        };
      }
      userStats[t.userId].totalTransactions++;
      userStats[t.userId].totalSpent += t.price;
    }
  });

  // Convert real stats to array and add user info
  const realEntries = Object.values(userStats).map(stat => {
    const user = users.find(u => u.id === stat.userId);
    return {
      ...stat,
      username: user?.username || 'Unknown',
      photo: user?.photo || null
    };
  });

  // Hanya data real — sort berdasarkan total nominal order, lalu tambahkan rank
  realEntries.sort((a, b) => b.totalSpent - a.totalSpent);
  realEntries.forEach((item, index) => {
    item.rank = index + 1;
  });

  const leaderboard = realEntries;
  const user = getSessionUser(req);

  res.render('pages/leaderboard', {
    leaderboard,
    settings,
    user
  });
});

// API endpoints
app.get('/api/products', async (req, res) => {
  if (!checkApiRateLimit(req.ip)) return res.status(429).json({ success: false, message: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  const allProductsForDummySold = await readFresh('products.json');
  if (ensureDummySold(allProductsForDummySold)) {
    await writeDB('products.json', allProductsForDummySold);
  }
  const products = allProductsForDummySold.filter(p => p.status === 'active');
  const settingsForStock = await readSmart('settings.json');
  // SECURITY: jangan pernah kirim raw license keys ke publik — hanya kirim jumlah stok
  // BUG FIX: sama seperti stripKeys di halaman utama -- produk stockSource
  // 'auto' harus dianggap unlimited, tidak bergantung product.keys.
  // BUG FIX #2: res.json() di bawah ini SERIALIZE pakai JSON.stringify()
  // internal Express -- Infinity bakal jadi `null` di response JSON yang
  // beneran diterima klien (lihat komentar UNLIMITED_STOCK di atas). Pakai
  // sentinel angka biar konsumen API (termasuk aplikasi eksternal) dapat
  // nilai stok yang benar, bukan null yang keliatan kayak "habis".
  // UPDATE: stok produk mode 'auto'/'mixed' sekarang dihitung per-varian
  // lewat computeProductCardStock (lihat definisinya untuk detail bug fix
  // "sudah di-stok manual tapi tetap kelihatan Habis di kartu produk").
  const safeProducts = await Promise.all(products.map(async ({ keys, ...rest }) => {
    const isAuto = rest.stockMode === 'auto' || rest.stockMode === 'mixed' || (Array.isArray(rest.pricingOptions) && rest.pricingOptions.some(o => o.stockSource === 'auto'));
    if (!isAuto) return { ...rest, stock: (keys || []).length };
    const stock = await computeProductCardStock(settingsForStock, { ...rest, keys });
    return { ...rest, stock };
  }));
  res.json(safeProducts);
});

// ── Helper: validasi & hitung diskon voucher ──
const validateVoucher = async (code, price, userId) => {
  if (!code) return { valid: false, error: 'Kode kosong' };
  const vouchers = await readFresh('vouchers.json');
  const v = vouchers.find(v => v.code.toUpperCase() === code.trim().toUpperCase());
  if (!v) return { valid: false, error: 'Kode voucher tidak ditemukan' };
  if (!v.active) return { valid: false, error: 'Voucher tidak aktif' };
  if (v.expiresAt && new Date(v.expiresAt) < new Date()) return { valid: false, error: 'Voucher sudah kadaluarsa' };
  if (v.maxUses > 0 && v.usedCount >= v.maxUses) return { valid: false, error: 'Voucher sudah habis digunakan' };
  if (v.minPurchase > 0 && price < v.minPurchase) return { valid: false, error: `Minimal pembelian Rp ${v.minPurchase.toLocaleString('id-ID')}` };
  if (v.perUserLimit > 0 && userId) {
    const userUses = (v.usages || []).filter(u => u.userId === userId).length;
    if (userUses >= v.perUserLimit) return { valid: false, error: 'Kamu sudah pernah memakai voucher ini' };
  }
  const discount = v.type === 'percent'
    ? Math.round(price * v.value / 100)
    : Math.min(v.value, price);
  const finalPrice = Math.max(price - discount, 0);
  return { valid: true, voucher: v, discount, finalPrice };
};

app.get('/api/stats', async (req, res) => {
  // Parallelkan semua query agar hemat waktu
  const [products, realTestimonials, users] = await Promise.all([
    readSmart('products.json'),
    readSmart('testimonials.json'),
    readSmart('users.json'),
  ]);
  const active = products.filter(p => p.status === 'active');
  const totalSold = products.reduce((s, p) => s + (p.sold || 0), 0);
  const allRatings = realTestimonials.filter(t => t.verified).map(t => t.rating || 5);
  const avgRating = allRatings.length ? (allRatings.reduce((s,r) => s+r, 0) / allRatings.length).toFixed(1) : '0.0';
  // Cache di browser 30 detik — cocok untuk data stats yang tidak berubah tiap detik
  res.set('Cache-Control', 'public, max-age=30');
  // Pelanggan = semua user yang sudah daftar akun (bukan hanya yang sudah beli)
  res.json({
    totalSold,
    totalActiveProducts: active.length,
    totalUsers: users.length,
    totalCustomers: users.length,
    avgRating: parseFloat(avgRating)
  });
});

// Cek voucher (user)
app.post('/api/voucher/check', requireAuth, async (req, res) => {
  const { code, price } = req.body;
  if (!code || !price) return res.json({ valid: false, error: 'Data tidak lengkap' });
  const result = await validateVoucher(code, parseInt(price), req.session.userId);
  if (!result.valid) return res.json({ valid: false, error: result.error });
  res.json({
    valid: true,
    code: result.voucher.code,
    type: result.voucher.type,
    value: result.voucher.value,
    description: result.voucher.description || '',
    discount: result.discount,
    finalPrice: result.finalPrice
  });
});

app.get('/api/transactions', requireAdmin, (req, res) => {
  const transactions = readDB('transactions.json');
  res.json(transactions);
});

// ── Cek apakah user sudah pernah beli produk ini ──
app.get('/api/has-purchased/:productId', requireAuth, (req, res) => {
  const transactions = readDB('transactions.json');
  const hasPurchased = transactions.some(t =>
    t.userId === req.session.userId &&
    t.productId === req.params.productId &&
    t.status === 'done'
  );
  res.json({ hasPurchased });
});

app.get('/api/testimonials', async (req, res) => {
  if (!checkApiRateLimit(req.ip)) return res.status(429).json({ success: false, message: 'Terlalu banyak permintaan.' });
  const testimonials = await readSmart('testimonials.json');
  const users = await readSmart('users.json');
  const featured = req.query.featured === 'true';
  const verifiedOnly = req.query.verified === 'true';
  const productId = req.query.product;

  let filtered = testimonials;

  if (featured) {
    filtered = filtered.filter(t => t.featured && t.verified);
  } else if (verifiedOnly) {
    filtered = filtered.filter(t => t.verified);
  }

  if (productId) {
    filtered = filtered.filter(t => t.product === productId || t.productName === productId);
  }

  // Sort by date descending
  filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Attach user photo if available
  filtered = filtered.map(t => {
    const u = users.find(u => u.username === t.username);
    return { ...t, photo: u?.photo || null };
  });

  // Pad with fake entries so page always looks alive
  const fakeTestimonials = [
    { id:'fake1', username:'Rizky F.',    name:'Rizky F.',    rating:5, text:'Mod FF-nya mantap, udah 3 bulan pakai dan aman-aman aja. Fitur lengkap dari ESP sampai fly hack. CS juga responsif banget!', product:'ff',         productName:'FREE FIRE MAX',      date:'2025-05-20', verified:true },
    { id:'fake2', username:'Andi S.',     name:'Andi S.',     rating:5, text:'ML mod-nya lengkap banget! Map hack, drone view, sampai skin all hero ada. Auto update jadi nggak perlu repot tiap update.', product:'ml',        productName:'MOBILE LEGENDS',    date:'2025-05-18', verified:true },
    { id:'fake3', username:'Dimas P.',    name:'Dimas P.',    rating:5, text:'Support fast response! Pas ada masalah langsung dibantu sampai beres. PUBG mod-nya juga smooth, nggak lag sama sekali.', product:'pubgm',     productName:'PUBG MOBILE',   date:'2025-05-15', verified:true },
    { id:'fake4', username:'farhan99',    name:'farhan',      rating:5, text:'Beli sertifikat anti-banned udah 2x dan alhamdulillah akun tetap aman. Worth it banget harganya segitu.', product:'sertifikat', productName:'SERTIFIKAT', date:'2025-05-10', verified:true },
    { id:'fake5', username:'gamer_mlbb',  name:'Wanda M.',    rating:4, text:'Produknya bagus, pengiriman key cepet banget. Cuma kadang agak lag di device lama tapi overall oke lah.', product:'ml',        productName:'MOBILE LEGENDS',    date:'2025-05-08', verified:true },
    { id:'fake6', username:'ACA XITERZ', name:'ACA',          rating:5, text:'Udah lama langganan di sini, belum pernah kecewa. Proses beli gampang, bayar QRIS langsung dapat key. Recommended!', product:'ff',       productName:'FREE FIRE MAX',      date:'2025-05-05', verified:true },
    { id:'fake7', username:'bintang_07',  name:'bintang',     rating:5, text:'Lifetime PUBGM worth it banget. Udah 6 bulan masih lancar jaya, fitur no recoil-nya mantul.', product:'pubgm',     productName:'PUBG MOBILE',   date:'2025-04-28', verified:true },
    { id:'fake8', username:'rizky_ff',    name:'Rizky',       rating:4, text:'Kalau FF mod-nya top. Pernah ada issue tapi langsung di-handle sama admin. Keep up the good work!', product:'ff',        productName:'FREE FIRE MAX',      date:'2025-04-20', verified:true },
    { id:'fake9', username:'keymaster',   name:'Kevin',       rating:5, text:'CODM mod anti-recoil smooth banget. Rank dari Silver langsung naik ke Platinum dalam seminggu haha.', product:'codm',     productName:'CODM',    date:'2025-04-15', verified:true },
    { id:'fake10',username:'abil',        name:'abil',        rating:5, text:'Ini toko mod menu terpercaya yang pernah aku coba. Transaksi aman, key langsung masuk, CS ramah.', product:'ff',        productName:'FREE FIRE MAX',      date:'2025-04-10', verified:true },
    { id:'fake11',username:'Hergi',       name:'Hergi',       rating:5, text:'Valorant ESP-nya akurat banget. Sudah 2 bulan pake dan belum ada masalah sama sekali. Pelayanan top!', product:'val',      productName:'VALORANT', date:'2025-04-05', verified:true },
    { id:'fake12',username:'rehan',       name:'rehan',       rating:5, text:'HOK mod-nya mantap, map hack dan skin unlock semua ada. Proses beli cepet dan key langsung terkirim.', product:'hok',     productName:'HOK',     date:'2025-03-28', verified:true },
    { id:'fake13',username:'Saell',       name:'Saell',       rating:5, text:'Beli Free Fire MAX bundle, prosesnya cepet banget! Cuma 2 menit key langsung masuk. Akun aman sampai sekarang.', product:'ff',         productName:'FREE FIRE MAX',      date:'2025-03-25', verified:true },
    { id:'fake14',username:'GamerKing99', name:'GamerKing99', rating:5, text:'MLBB mod-nya juara! Skin all hero gratis, map hack jalan mulus. Adminnya juga friendly, fast respon.', product:'ml',        productName:'MOBILE LEGENDS',    date:'2025-03-20', verified:true },
    { id:'fake15',username:'SkyyFire',    name:'SkyyFire',    rating:5, text:'PUBG mod smooth banget di HP kentang sekalipun. No lag, no crash. Harga juga affordable banget!', product:'pubgm',     productName:'PUBG MOBILE',   date:'2025-03-15', verified:true },
    { id:'fake16',username:'ShadowX',     name:'ShadowX',     rating:5, text:'Udah 4x beli di sini, selalu puas. Key original, legit, dan awet. Best store for mod menu!', product:'ff',        productName:'FREE FIRE MAX',      date:'2025-03-10', verified:true },
    { id:'fake17',username:'NightWolf',   name:'NightWolf',   rating:4, text:'PUBGM no recoil mantap, tapi kadang auto aim agak delay. Overall masih oke sih, worth the price.', product:'pubgm',     productName:'PUBG MOBILE',   date:'2025-03-05', verified:true },
    { id:'fake18',username:'LunarKing',   name:'LunarKing',   rating:5, text:'MLBB dron view works perfectly! Enemy location always visible. Rank naik terus dari season kemarin.', product:'ml',        productName:'MOBILE LEGENDS',    date:'2025-02-28', verified:true },
    { id:'fake19',username:'NeonVibes',   name:'NeonVibes',   rating:5, text:'FF aimbot-nya smooth, headshot mulus. UDAH 3 BULAN pakai dan belum pernah kena ban. Mantap!', product:'ff',        productName:'FREE FIRE MAX',      date:'2025-02-20', verified:true },
    { id:'fake20',username:'StormRider',  name:'StormRider',  rating:4, text:'Produk bagus, cuma pengiriman key agak lama pas weekend. Tapi overall puas, CS-nya ramah.', product:'pubgm',     productName:'PUBG MOBILE',   date:'2025-02-15', verified:true },
    { id:'fake21',username:'GhostByte',   name:'GhostByte',   rating:5, text:'FF wallhack jernih, bisa lihat musuh tembus dinding. Gameplay jadi lebih seru dan menang terus!', product:'ff',        productName:'FREE FIRE MAX',      date:'2025-02-10', verified:true },
    { id:'fake22',username:'CyberRush',   name:'CyberRush',   rating:5, text:'MLBB skin all hero unlocked, effect skill keliatan keren banget! Teman-teman pada kaget.', product:'ml',        productName:'MOBILE LEGENDS',    date:'2025-02-05', verified:true },
    { id:'fake23',username:'AlphaGod',    name:'AlphaGod',    rating:5, text:'PUBG mod versi terbaru udah support map Livik juga. Smooth, nggak ada glitch. Top banget!', product:'pubgm',     productName:'PUBG MOBILE',   date:'2025-01-28', verified:true },
    { id:'fake24',username:'IronPhoenix', name:'IronPhoenix', rating:5, text:'FF mod ini yang paling stabil dari semua yang pernah aku coba. Langganan bulanan, worth it!', product:'ff',        productName:'FREE FIRE MAX',      date:'2025-01-20', verified:true },
    { id:'fake25',username:'TurboAce',    name:'TurboAce',    rating:4, text:'MLBB drone view bagus, tapi agak boros battery. Overall recommend buat yang mau rank push.', product:'ml',        productName:'MOBILE LEGENDS',    date:'2025-01-15', verified:true },
    { id:'fake26',username:'NovaStar',    name:'NovaStar',    rating:5, text:'FF ESP wallhack akurat, bisa lihat posisi semua musuh. Combo sama aimbot auto winner!', product:'ff',        productName:'FREE FIRE MAX',      date:'2025-01-10', verified:true },
    { id:'fake27',username:'DragonByte',  name:'DragonByte',  rating:5, text:'PUBG no recoil + auto headshot combo mantap! Rank naik dari Gold ke Diamond dalam 2 minggu.', product:'pubgm',     productName:'PUBG MOBILE',   date:'2025-01-05', verified:true },
    { id:'fake28',username:'MegaBoss',    name:'MegaBoss',    rating:5, text:'Beli mod menu di sini gampang banget, bayar pakai QRIS langsung dapat key. Nggak ribet!', product:'ff',        productName:'FREE FIRE MAX',      date:'2024-12-28', verified:true },
    { id:'fake29',username:'PulseWave',   name:'PulseWave',   rating:4, text:'MLBB mod oke, tapi perlu update manual tiap patch baru. Harusnya auto update sih.', product:'ml',        productName:'MOBILE LEGENDS',    date:'2024-12-20', verified:true },
    { id:'fake30',username:'HyperCore',   name:'HyperCore',   rating:5, text:'PUBG speed hack works! Movement jadi cepat, musuh nggak bisa ngejar. Asik banget!', product:'pubgm',     productName:'PUBG MOBILE',   date:'2024-12-15', verified:true },
  ];

  // Filter fake by product if requested
  let finalFake = fakeTestimonials;
  if (productId) {
    finalFake = fakeTestimonials.filter(f => f.product === productId || f.productName === productId);
  }

  // Only add fake entries that don't duplicate real usernames
  const realUsernames = new Set(filtered.map(t => (t.username||'').toLowerCase()));
  const paddedFake = finalFake.filter(f => !realUsernames.has((f.username||'').toLowerCase()));

  // Merge: real first, then fake (capped so total stays reasonable)
  const maxDisplay = 30;
  const combined = [...filtered, ...paddedFake].slice(0, maxDisplay);

  res.json(combined);
});

// ── Statistik rating ASLI (real) — dihitung dari SEMUA testimoni terverifikasi
// di seluruh produk, TANPA entri dummy/fake. Dipakai untuk angka rating & bar
// di homepage supaya menampilkan data sebenarnya, bukan angka pajangan. ──
app.get('/api/testimonials/stats', async (req, res) => {
  if (!checkApiRateLimit(req.ip)) return res.status(429).json({ success: false, message: 'Terlalu banyak permintaan.' });
  const testimonials = await readSmart('testimonials.json');
  const productId = req.query.product;

  let real = testimonials.filter(t => t.verified);
  if (productId) {
    real = real.filter(t => t.product === productId || t.productName === productId);
  }

  const total = real.length;
  const avg = total ? (real.reduce((s, t) => s + (t.rating || 0), 0) / total) : 0;
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  real.forEach(t => { if (t.rating >= 1 && t.rating <= 5) counts[t.rating]++; });

  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    total,
    avg: parseFloat(avg.toFixed(1)),
    counts
  });
});

app.post('/api/testimonials', requireAuth, async (req, res) => {
  try {
    const { productId, productName, rating, text } = req.body;
    if (!productId || !rating || !text) return res.json({ success: false, message: 'Data tidak lengkap' });
    const ratingNum = parseInt(rating);
    if (ratingNum < 1 || ratingNum > 5) return res.json({ success: false, message: 'Rating tidak valid' });
    if (!text.trim()) return res.json({ success: false, message: 'Ulasan tidak boleh kosong' });
    if (text.trim().length > 500) return res.json({ success: false, message: 'Ulasan maksimal 500 karakter' });

    const users = readDB('users.json');
    const user = users.find(u => u.id === req.session.userId);

    // ── Validasi: user harus sudah pernah beli produk ini ──
    const transactions = readDB('transactions.json');
    const hasPurchased = transactions.some(t =>
      t.userId === req.session.userId &&
      t.productId === productId &&
      t.status === 'done'
    );
    if (!hasPurchased) {
      return res.json({ success: false, message: 'Kamu harus membeli produk ini terlebih dahulu sebelum bisa memberikan ulasan.' });
    }

    const testimonials = readDB('testimonials.json');

    testimonials.unshift({
      id: uuidv4(),
      product: productId,
      productName: productName || '',
      username: user?.username || 'Pengguna',
      rating: ratingNum,
      text: text.trim(),
      date: new Date().toISOString(),
      verified: true,  // Auto-verifikasi karena sudah terbukti membeli
      featured: false
    });

    await writeDB('testimonials.json', testimonials);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/admin/testimonial/add', requireAdmin, async (req, res) => {
  try {
    const { name, username, rating, text, product, verified, featured } = req.body;
    const testimonials = await readFresh('testimonials.json');

    const newTestimonial = {
      id: `testi-${Date.now()}`,
      name,
      username: username || null,
      rating: parseInt(rating) || 5,
      text,
      product: product || null,
      date: new Date().toISOString(),
      verified: verified === true || verified === 'true',
      featured: featured === true || featured === 'true'
    };

    testimonials.push(newTestimonial);
    await writeDB('testimonials.json', testimonials);

    res.json({ success: true, message: 'Testimoni berhasil ditambahkan' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/testimonial/delete/:id', requireAdmin, async (req, res) => {
  try {
    let testimonials = await readFresh('testimonials.json');
    testimonials = testimonials.filter(t => t.id !== req.params.id);
    await writeDB('testimonials.json', testimonials);
    res.json({ success: true, message: 'Testimoni berhasil dihapus' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/testimonial/toggle-featured/:id', requireAdmin, async (req, res) => {
  try {
    const testimonials = await readFresh('testimonials.json');
    const testi = testimonials.find(t => t.id === req.params.id);
    if (!testi) return res.json({ success: false, message: 'Testimoni tidak ditemukan' });

    testi.featured = !testi.featured;
    await writeDB('testimonials.json', testimonials);
    res.json({ success: true, message: 'Status featured berhasil diubah' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/testimonial/toggle-verified/:id', requireAdmin, async (req, res) => {
  try {
    const testimonials = await readFresh('testimonials.json');
    const testi = testimonials.find(t => t.id === req.params.id);
    if (!testi) return res.json({ success: false, message: 'Testimoni tidak ditemukan' });

    testi.verified = !testi.verified;
    await writeDB('testimonials.json', testimonials);
    res.json({ success: true, message: testi.verified ? 'Testimoni berhasil diverifikasi' : 'Verifikasi dicabut' });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.get('/api/notifications', (req, res) => {
  if (!checkApiRateLimit(req.ip)) return res.status(429).json({ success: false, message: 'Terlalu banyak permintaan.' });
  const cached = cacheGet('api:notifications');
  if (cached) return res.json(cached);
  const notifs = readDB('notifications.json').slice(0, 20);
  const users = readDB('users.json');
  const enriched = notifs.map(notification => {
    const buyer = users.find(u => u.username === notification.buyerName);
    return {
      ...notification,
      buyerPhoto: buyer?.photo || null
    };
  });
  cacheSet('api:notifications', enriched, 8000); // cache 8 detik
  res.json(enriched);
});

app.get('/api/leaderboard', (req, res) => {
  const transactions = readDB('transactions.json');
  const users = readDB('users.json');

  // Calculate real leaderboard
  const userStats = {};
  transactions.forEach(t => {
    if (t.status === 'done' && t.userId) {
      if (!userStats[t.userId]) userStats[t.userId] = { userId: t.userId, totalTransactions: 0, totalSpent: 0 };
      userStats[t.userId].totalTransactions++;
      userStats[t.userId].totalSpent += t.price;
    }
  });

  const realEntries = Object.values(userStats).map(stat => {
    const user = users.find(u => u.id === stat.userId);
    return { username: user?.username || 'User', photo: user?.photo || null, totalTransactions: stat.totalTransactions, totalSpent: stat.totalSpent, isReal: true };
  });

  // Hanya data real — diurutkan berdasarkan total nominal, ambil top 10
  realEntries.sort((a, b) => b.totalSpent - a.totalSpent);
  realEntries.forEach((item, i) => { item.rank = i + 1; });

  res.json({ success: true, data: realEntries.slice(0, 10) });
});

// ═══════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════

// Admin Product Edit Page
app.get('/admin/product-edit', requireAdmin, (req, res) => {
  const products = readDB('products.json');
  const settings = readDB('settings.json');
  const productId = req.query.id;
  const product = productId ? products.find(p => p.id === productId) : null;
  res.render('pages/admin-product-edit', { product, products, settings });
});

// Admin Theme Settings Page
app.get('/admin/theme-settings', requireAdmin, (req, res) => {
  const settings = readDB('settings.json');
  res.render('pages/admin-theme', { settings });
});

// Admin Product Management
app.get('/admin/products', requireAdmin, (req, res) => {
  const products = readDB('products.json');
  res.json({ success: true, data: products });
});

// Audit: daftar semua varian mode Auto yang BELUM di-mapping manual ke
// produk provider. Dibuat khusus setelah auto-cocokkan-by-nama dimatikan
// (lihat resolveItemId di reseller-api.js) -- varian yang muncul di sini
// akan GAGAL checkout sampai admin mapping manual dari halaman Edit Produk.
app.get('/admin/products/unmapped-auto', requireAdmin, async (req, res) => {
  try {
    const products = await readFresh('products.json');
    const unmapped = [];
    products.forEach(p => {
      (p.pricingOptions || []).forEach(o => {
        if (o.stockSource === 'auto' && !o.resellerItemId && !p.resellerItemId) {
          unmapped.push({ productId: p.id, productName: p.name, days: o.days, status: p.status });
        }
      });
    });
    res.json({ success: true, count: unmapped.length, data: unmapped });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// Admin Get Single Product
app.get('/admin/product/:id', requireAdmin, (req, res) => {
  const products = readDB('products.json');
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.json({ success: false, message: 'Produk tidak ditemukan' });
  res.json({ success: true, data: product });
});

// Admin Upload Banner — di Vercel upload ke Supabase Storage, lokal ke filesystem
app.post('/admin/upload-banner', requireAdmin, multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Hanya file gambar (JPG/PNG/WEBP/GIF) yang diizinkan'));
  }
}).single('banner'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, message: 'Tidak ada file diupload' });

    if (isVercel) {
      // Vercel: upload ke Supabase Storage
      try {
        const url = await db.uploadImage(req.file.buffer, req.file.originalname, req.file.mimetype);
        return res.json({ success: true, bannerUrl: url });
      } catch (e) {
        return res.json({ success: false, message: e.message });
      }
    }

    // Lokal: simpan di filesystem
    const bannersDir = path.join(__dirname, 'public', 'uploads', 'banners');
    if (!fs.existsSync(bannersDir)) fs.mkdirSync(bannersDir, { recursive: true });
    const filename = `${Date.now()}-${uuidv4()}${path.extname(req.file.originalname)}`;
    fs.writeFileSync(path.join(bannersDir, filename), req.file.buffer);
    res.json({ success: true, bannerUrl: `/uploads/banners/${filename}` });
  } catch (error) {
    res.json({ success: false, message: 'Error: ' + error.message });
  }
});

// Admin Get Theme Settings
app.get('/admin/theme', requireAdmin, (req, res) => {
  const settings = readDB('settings.json');
  res.json({ success: true, data: settings.theme || {} });
});

// Admin Update Theme Settings
app.post('/admin/theme', requireAdmin, async (req, res) => {
  try {
    const { primaryColor, secondaryColor, accentColor, backgroundColor, cardBackground, borderColor, glowColor } = req.body;
    const settings = await readFresh('settings.json');

    const prevTheme = settings.theme || {};
    settings.theme = {
      primaryColor: primaryColor || prevTheme.primaryColor || '#7b2cbf',
      secondaryColor: secondaryColor || prevTheme.secondaryColor || '#9d4edd',
      accentColor: accentColor || prevTheme.accentColor || '#c77dff',
      backgroundColor: backgroundColor || prevTheme.backgroundColor || '#0a0a0a',
      cardBackground: cardBackground || prevTheme.cardBackground || '#151520',
      borderColor: borderColor || prevTheme.borderColor || 'rgba(157,78,221,.15)',
      glowColor: glowColor || prevTheme.glowColor || 'rgba(157, 78, 221, 0.1)'
    };

    await writeDB('settings.json', settings);
    res.json({ success: true, message: 'Tema berhasil diupdate', data: settings.theme });
  } catch (error) {
    res.json({ success: false, message: 'Error: ' + error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// KEY POOL SYSTEM — Format: CODE - X Hari
// ═══════════════════════════════════════════════════════════

// Keranjang belanja
app.get('/keranjang', (req, res) => {
  const user = getSessionUser(req);
  const settings = readDB('settings.json');
  res.render('pages/keranjang', { user, settings });
});

// Admin: lihat semua key pool
app.get('/admin/keyspool', requireAdmin, (req, res) => {
  res.json({ success: true, data: readDB('keyspool.json') });
});

// Admin: tambah key baru
app.post('/admin/keyspool/add', requireAdmin, async (req, res) => {
  try {
    const { code, duration, label, note } = req.body;
    if (!code || !duration) return res.json({ success: false, message: 'Kode dan durasi wajib diisi' });
    const d = parseInt(duration);
    if (isNaN(d) || d <= 0) return res.json({ success: false, message: 'Durasi tidak valid (harus > 0 hari)' });
    const keyspool = await readFresh('keyspool.json');
    if (keyspool.find(k => k.code.toUpperCase() === code.trim().toUpperCase())) {
      return res.json({ success: false, message: 'Kode key sudah ada' });
    }
    keyspool.push({
      id: uuidv4(),
      code: code.trim().toUpperCase(),
      duration: d,
      label: label?.trim() || `${d} Hari`,
      used: false, usedBy: null, usedByUsername: null, usedAt: null,
      note: note?.trim() || '',
      createdAt: new Date().toISOString()
    });
    await writeDB('keyspool.json', keyspool);
    res.json({ success: true, data: keyspool });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// Admin: generate key otomatis (bulk)
app.post('/admin/keyspool/generate', requireAdmin, async (req, res) => {
  try {
    const { count, duration, prefix, label } = req.body;
    const n = Math.min(parseInt(count) || 1, 100);
    const d = parseInt(duration);
    if (isNaN(d) || d <= 0) return res.json({ success: false, message: 'Durasi tidak valid' });
    const keyspool = await readFresh('keyspool.json');
    const pref = (prefix || 'KEY').toUpperCase();
    const added = [];
    for (let i = 0; i < n; i++) {
      const code = `${pref}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      keyspool.push({
        id: uuidv4(), code, duration: d,
        label: label?.trim() || `${d} Hari`,
        used: false, usedBy: null, usedByUsername: null, usedAt: null,
        note: '', createdAt: new Date().toISOString()
      });
      added.push(code);
    }
    await writeDB('keyspool.json', keyspool);
    res.json({ success: true, generated: added.length, codes: added, data: keyspool });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// Admin: hapus key
app.post('/admin/keyspool/delete/:id', requireAdmin, async (req, res) => {
  try {
    let keyspool = await readFresh('keyspool.json');
    keyspool = keyspool.filter(k => k.id !== req.params.id);
    await writeDB('keyspool.json', keyspool);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// VOUCHER SYSTEM
// ═══════════════════════════════════════════════════════════

app.get('/admin/vouchers', requireAdmin, (req, res) => {
  res.json({ success: true, data: readDB('vouchers.json') });
});

app.post('/admin/vouchers/add', requireAdmin, async (req, res) => {
  try {
    const { code, type, value, minPurchase, maxUses, perUserLimit, expiresAt, description } = req.body;
    if (!code || !type || value === undefined) return res.json({ success: false, message: 'Kode, tipe, dan nilai wajib diisi' });
    const val = parseFloat(value);
    if (isNaN(val) || val <= 0) return res.json({ success: false, message: 'Nilai voucher tidak valid' });
    if (type === 'percent' && val > 100) return res.json({ success: false, message: 'Persentase diskon maksimal 100%' });
    const vouchers = await readFresh('vouchers.json');
    if (vouchers.find(v => v.code.toUpperCase() === code.trim().toUpperCase())) {
      return res.json({ success: false, message: 'Kode voucher sudah ada' });
    }
    const newV = {
      id: uuidv4(),
      code: code.trim().toUpperCase(),
      type,
      value: val,
      minPurchase: parseInt(minPurchase) || 0,
      maxUses: parseInt(maxUses) || 0,
      perUserLimit: parseInt(perUserLimit) || 1,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      description: description?.trim() || '',
      active: true,
      usedCount: 0,
      usages: [],
      createdAt: new Date().toISOString()
    };
    vouchers.push(newV);
    await writeDB('vouchers.json', vouchers);
    res.json({ success: true, data: vouchers });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/admin/vouchers/toggle/:id', requireAdmin, async (req, res) => {
  try {
    const vouchers = await readFresh('vouchers.json');
    const v = vouchers.find(v => v.id === req.params.id);
    if (!v) return res.json({ success: false, message: 'Voucher tidak ditemukan' });
    v.active = !v.active;
    await writeDB('vouchers.json', vouchers);
    res.json({ success: true, active: v.active });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

app.post('/admin/vouchers/delete/:id', requireAdmin, async (req, res) => {
  try {
    let vouchers = await readFresh('vouchers.json');
    vouchers = vouchers.filter(v => v.id !== req.params.id);
    await writeDB('vouchers.json', vouchers);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ACTIVATE KEY (Klaim / Redeem Voucher Lisensi)
// ═══════════════════════════════════════════════════════════

app.get('/activate-key', (req, res) => {
  const settings = readDB('settings.json');
  const user = getSessionUser(req);
  const code = req.query.code || '';
  res.render('pages/activate-key', { settings, user, isAdmin: req.session?.isAdmin || false, code, result: null, error: null, resellerSettings: { enabled: settings.resellerEnabled !== false, price: settings.resellerPrice || 50000, discount: settings.resellerDiscount || 20 } });
});

app.post('/activate-key', async (req, res) => {
  // RATE LIMIT: max 10 percobaan per IP per 15 menit, cegah brute-force key
  const activateRateKey = 'activate-' + req.ip;
  const activateNow = Date.now();
  const activateWindow = 15 * 60 * 1000;
  let activateRec = apiRateMap.get(activateRateKey);
  if (activateRec && (activateNow - activateRec.resetAt) < 0 && activateRec.count >= 10) {
    return res.status(429).send('Terlalu banyak percobaan. Coba lagi dalam 15 menit.');
  }
  if (!activateRec || (activateNow - activateRec.resetAt) >= 0) {
    apiRateMap.set(activateRateKey, { count: 1, resetAt: activateNow + activateWindow });
  } else {
    activateRec.count++;
  }

  const settings = readDB('settings.json');
  const user = getSessionUser(req);
  const baseRender = (result, error, code) => res.render('pages/activate-key', {
    settings, user, isAdmin: req.session?.isAdmin || false, code, result, error,
    resellerSettings: { enabled: settings.resellerEnabled !== false, price: settings.resellerPrice || 50000, discount: settings.resellerDiscount || 20 }
  });

  const rawCode = (req.body.code || '').trim().toUpperCase();
  if (!rawCode) return baseRender(null, 'Kode lisensi tidak boleh kosong.', rawCode);

  try {
    const keyspool = await readFresh('keyspool.json');
    const keyEntry = keyspool.find(k => k.code.toUpperCase() === rawCode);

    if (!keyEntry) return baseRender(null, 'Kode lisensi tidak ditemukan atau tidak valid.', rawCode);
    if (keyEntry.used) return baseRender(null, 'Kode lisensi ini sudah pernah digunakan.', rawCode);

    // Tandai sebagai sudah dipakai
    keyEntry.used = true;
    keyEntry.usedAt = new Date().toISOString();
    if (user) {
      keyEntry.usedBy = user.id;
      keyEntry.usedByUsername = user.username;
    }
    await writeDB('keyspool.json', keyspool);

    return baseRender({
      code: keyEntry.code,
      duration: keyEntry.duration,
      label: keyEntry.label || `${keyEntry.duration} Hari`,
      note: keyEntry.note || ''
    }, null, rawCode);
  } catch (e) {
    return baseRender(null, 'Terjadi kesalahan server. Coba lagi.', rawCode);
  }
});

// ═══════════════════════════════════════════════════════════
// EXPORT / IMPORT DATABASE
// ═══════════════════════════════════════════════════════════

app.get('/admin/db-status', requireAdmin, async (req, res) => {
  res.json(await db.getDbStatus());
});

app.get('/admin/export', requireAdmin, (req, res) => {
  const db = {};
  const files = ['users.json', 'products.json', 'transactions.json', 'testimonials.json', 'notifications.json', 'settings.json', 'keyspool.json', 'vouchers.json'];
  for (const f of files) { db[f] = readDB(f); }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="heromarket-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(db);
});

app.post('/admin/import', requireAdmin, express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object') return res.json({ success: false, message: 'Data tidak valid' });
    const files = ['users.json', 'products.json', 'transactions.json', 'testimonials.json', 'notifications.json', 'settings.json', 'keyspool.json', 'vouchers.json'];
    let count = 0;
    for (const f of files) {
      if (data[f] !== undefined) {
        await writeDB(f, data[f]);
        count++;
      }
    }
    res.json({ success: true, message: `${count} file berhasil diimport` });
  } catch (e) { res.json({ success: false, message: e.message }); }
});

  
