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

// Load DB module AFTER dotenv so env vars are available
const db = require('./supabase');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Invoice rate limiting (cegah brute force order code enumeration)
const invoiceRateMap = new Map();
const INVOICE_RATE_LIMIT = 10;
const INVOICE_RATE_WINDOW = 5 * 60 * 1000;

const checkInvoiceRateLimit = (ip) => {
  const now = Date.now();
  const rec = invoiceRateMap.get(ip);
  if (!rec || now > rec.resetAt) {
    invoiceRateMap.set(ip, { count: 1, resetAt: now + INVOICE_RATE_WINDOW });
    return true;
  }
  if (rec.count >= INVOICE_RATE_LIMIT) return false;
  rec.count++;
  return true;
};

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
app.use(expressLayouts);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use('/uploads/avatars', express.static(path.join(__dirname, 'public/uploads/avatars')));

app.use(cookieSession({
  name: 'hm_session',
  secret: process.env.SESSION_SECRET || 'hero-market-dev-only-not-for-prod',
  maxAge: 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));

// Inject settings + isAdmin ke semua view otomatis
app.use((req, res, next) => {
  res.locals.settings = readDB('settings.json');
  res.locals.isAdmin = req.session?.isAdmin || false;
  next();
});

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
const refreshForWrite = (...files) => Promise.all(files.map(f => db.refreshFromDB(f)));

// Initialize database files with defaults (only if truly missing)
const initDB = async () => {
  const defaultSettings = {
    siteName: 'HERO MARKET',
    gamePanelName: 'HERO MARKET',
    about: 'HERO MARKET menyediakan layanan topup games dan key mod aplikasi premium terbaik #1 indonesia.',
    marqueeText: 'LAYANAN GAME MOD MENU PREMIUM - PROSES CEPAT & AMAN',
    contact: { whatsapp: '6281235690535', telegram: 'HEROO3STORE', email: 'support@heromarket.com' },
    pakasir: { apiKey: '', project: '', mode: 'production' },
    adminUsername: process.env.ADMIN_USERNAME || 'heromarket',
    adminPassword: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'sumberjo1903', 12),
    categories: ['freefire', 'mlbb', 'pubgm', 'sertifikat'],
    categoryLabels: { freefire: 'FREE FIRE', mlbb: 'MOBILE LEGENDS', pubgm: 'PUBG MOBILE', sertifikat: 'SERTIFIKAT' },
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
    await writeDB('settings.json', defaultSettings);
  } else {
    // Selalu update kredensial admin dari env var, bukan dari data lama
    const adminUser = process.env.ADMIN_USERNAME || 'heromarket';
    const adminPass = process.env.ADMIN_PASSWORD || 'sumberjo1903';
    const needsUpdate =
      currentSettings.adminUsername !== adminUser ||
      !bcrypt.compareSync(adminPass, currentSettings.adminPassword || '');
    if (needsUpdate) {
      currentSettings.adminUsername = adminUser;
      currentSettings.adminPassword = bcrypt.hashSync(adminPass, 12);
      await writeDB('settings.json', currentSettings);
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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'HM-';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  code += '-';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
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

// ── PakKasir API (app.pakasir.com) ──
const createQRISPayment = (orderId, amount, settings) => {
  return new Promise((resolve, reject) => {
    const apiKey = settings.pakasir?.apiKey?.trim() || '';
    const project = settings.pakasir?.project?.trim() || '';
    if (!apiKey || !project) return reject(new Error('API Key atau Project PakKasir belum dikonfigurasi'));

    const body = JSON.stringify({ project, order_id: orderId, amount, api_key: apiKey });
    const req = https.request({
      hostname: 'app.pakasir.com', port: 443,
      path: '/api/transactioncreate/qris', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          const qr = r.payment?.payment_number || r.payment_number || r.qr_string || r.data?.payment_number;
          if (!qr) return reject(new Error(r.message || `Pakasir error: ${data.slice(0,100)}`));
          resolve({ qr_string: qr, total_payment: r.payment?.total_payment || amount, expired_at: r.payment?.expired_at || null });
        } catch(e) { reject(new Error('Gagal parse response PakKasir')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('PakKasir timeout')); });
    req.on('error', e => reject(new Error('Network error: ' + e.message)));
    req.write(body); req.end();
  });
};

const checkPaymentStatus = (orderId, amount, settings) => {
  return new Promise((resolve, reject) => {
    const apiKey = settings.pakasir?.apiKey?.trim() || '';
    const project = settings.pakasir?.project?.trim() || '';
    if (!apiKey || !project) return reject(new Error('API Key PakKasir belum dikonfigurasi'));

    const q = `project=${encodeURIComponent(project)}&amount=${parseInt(amount)}&order_id=${encodeURIComponent(orderId)}&api_key=${encodeURIComponent(apiKey)}`;
    const req = https.request({
      hostname: 'app.pakasir.com', port: 443,
      path: `/api/transactiondetail?${q}`, method: 'GET', timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Gagal parse response status')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('PakKasir status timeout')); });
    req.on('error', e => reject(new Error('Network error: ' + e.message)));
    req.end();
  });
};

// Routes - Public
app.get('/', async (req, res) => {
  const products = (await readFresh('products.json')).filter(p => p.status === 'active');

  // ── Server-side fake leaderboard ──
  const fakeEntries = [
    { username: 'ACA XITERZ',  totalTransactions: 47, totalSpent: 12500000 },
    { username: 'Hergi',       totalTransactions: 38, totalSpent: 8700000  },
    { username: 'bintang_07',  totalTransactions: 31, totalSpent: 5300000  },
    { username: 'Wanda',       totalTransactions: 28, totalSpent: 4100000  },
    { username: 'dimas_pro',   totalTransactions: 24, totalSpent: 3800000  },
    { username: 'abil',        totalTransactions: 21, totalSpent: 3200000  },
    { username: 'Saell',       totalTransactions: 18, totalSpent: 2800000  },
    { username: 'rehan',       totalTransactions: 15, totalSpent: 2100000  },
    { username: 'farhan99',    totalTransactions: 12, totalSpent: 1750000  },
    { username: 'rizky_ff',    totalTransactions: 10, totalSpent: 1400000  },
    { username: 'gamer_mlbb',  totalTransactions: 9,  totalSpent: 1200000  },
    { username: 'keymaster',   totalTransactions: 8,  totalSpent: 980000   },
    { username: 'Rizky F.',    totalTransactions: 7,  totalSpent: 850000   },
    { username: 'Andi S.',     totalTransactions: 7,  totalSpent: 820000   },
    { username: 'Dimas P.',    totalTransactions: 6,  totalSpent: 740000   },
  ];
  // Merge real + fake
  const transactions = readDB('transactions.json');
  const users = readDB('users.json');
  const userStats = {};
  transactions.forEach(t => {
    if (t.status === 'done' && t.userId) {
      if (!userStats[t.userId]) userStats[t.userId] = { userId: t.userId, totalTransactions: 0, totalSpent: 0 };
      userStats[t.userId].totalTransactions++;
      userStats[t.userId].totalSpent += t.price;
    }
  });
  const realEntries = Object.values(userStats).map(stat => {
    const u = users.find(u => u.id === stat.userId);
    return { username: u?.username || 'User', totalTransactions: stat.totalTransactions, totalSpent: stat.totalSpent };
  });
  // Merge, deduplicate, sort, take top 8
  const allUsernames = new Set();
  const merged = [];
  [...realEntries, ...fakeEntries].forEach(e => {
    const key = e.username.toLowerCase();
    if (!allUsernames.has(key)) { allUsernames.add(key); merged.push(e); }
  });
  const leaderboardEntries = merged.sort((a, b) => b.totalTransactions - a.totalTransactions).slice(0, 8);

  // ── Server-side fake testimonials ──
  const fakeTestimonials = [
    { id:'fake1', name:'Rizky F.',    rating:5, text:'Mod FF-nya mantap, udah 3 bulan pakai dan aman-aman aja. Fitur lengkap dari ESP sampai fly hack. CS juga responsif banget!', productName:'FREE FIRE MAX',      date:'2025-05-20', verified:true },
    { id:'fake2', name:'Andi S.',     rating:5, text:'ML mod-nya lengkap banget! Map hack, drone view, sampai skin all hero ada. Auto update jadi nggak perlu repot tiap update.', productName:'MOBILE LEGENDS',    date:'2025-05-18', verified:true },
    { id:'fake3', name:'Dimas P.',    rating:5, text:'Support fast response! Pas ada masalah langsung dibantu sampai beres. PUBG mod-nya juga smooth, nggak lag sama sekali.', productName:'PUBG MOBILE',   date:'2025-05-15', verified:true },
    { id:'fake4', name:'farhan',      rating:5, text:'Beli sertifikat anti-banned udah 2x dan alhamdulillah akun tetap aman. Worth it banget harganya segitu.', productName:'SERTIFIKAT', date:'2025-05-10', verified:true },
    { id:'fake5', name:'Wanda M.',    rating:4, text:'Produknya bagus, pengiriman key cepet banget. Cuma kadang agak lag di device lama tapi overall oke lah.', productName:'MOBILE LEGENDS',    date:'2025-05-08', verified:true },
    { id:'fake6', name:'ACA',         rating:5, text:'Udah lama langganan di sini, belum pernah kecewa. Proses beli gampang, bayar QRIS langsung dapat key. Recommended!', productName:'FREE FIRE MAX',      date:'2025-05-05', verified:true },
    { id:'fake7', name:'bintang',     rating:5, text:'Lifetime PUBGM worth it banget. Udah 6 bulan masih lancar jaya, fitur no recoil-nya mantul.', productName:'PUBG MOBILE',   date:'2025-04-28', verified:true },
    { id:'fake8', name:'Rizky',       rating:4, text:'Kalau FF mod-nya top. Pernah ada issue tapi langsung di-handle sama admin. Keep up the good work!', productName:'FREE FIRE MAX',      date:'2025-04-20', verified:true },
    { id:'fake9', name:'Kevin',       rating:5, text:'CODM mod anti-recoil smooth banget. Rank dari Silver langsung naik ke Platinum dalam seminggu haha.', productName:'CODM',    date:'2025-04-15', verified:true },
    { id:'fake10',name:'abil',        rating:5, text:'Ini toko mod menu terpercaya yang pernah aku coba. Transaksi aman, key langsung masuk, CS ramah.', productName:'FREE FIRE MAX',      date:'2025-04-10', verified:true },
    { id:'fake11',name:'Hergi',       rating:5, text:'Valorant ESP-nya akurat banget. Sudah 2 bulan pake dan belum ada masalah sama sekali. Pelayanan top!', productName:'VALORANT', date:'2025-04-05', verified:true },
    { id:'fake12',name:'rehan',       rating:5, text:'HOK mod-nya mantap, map hack dan skin unlock semua ada. Proses beli cepet dan key langsung terkirim.', productName:'HOK',     date:'2025-03-28', verified:true },
  ];
  const realTestimonials = readDB('testimonials.json').filter(t => t.verified);
  const testiUsernames = new Set(realTestimonials.map(t => (t.username||'').toLowerCase()));
  const paddedFake = fakeTestimonials.filter(f => !testiUsernames.has((f.name||'').toLowerCase()));
  const testimonialsForHome = [...realTestimonials, ...paddedFake].slice(0, 12);
  const avgRating = testimonialsForHome.length
    ? (testimonialsForHome.reduce((s, t) => s + (t.rating || 0), 0) / testimonialsForHome.length).toFixed(1)
    : '4.9';
  const ratingCounts = {1:0,2:0,3:0,4:0,5:0};
  testimonialsForHome.forEach(t => { if (t.rating >= 1 && t.rating <= 5) ratingCounts[t.rating]++; });
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

  res.render('pages/home', {
    products,
    popularProducts,
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
app.get('/login', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.render('pages/login', { error: null, redirect: req.query.redirect || '/' });
});

app.post('/login', async (req, res) => {
  const ip = req.ip;
  const { blocked, wait } = checkLoginBlocked(ip);
  if (blocked) {
    return res.render('pages/login', {
      error: `Terlalu banyak percobaan login. Coba lagi dalam ${wait} menit.`,
      redirect: req.body.redirect || '/'
    });
  }

  const { username, password } = req.body;
  const settings = readDB('settings.json');

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
  res.render('pages/login', { error: errMsg, redirect: req.body.redirect || '/' });
});

app.get('/register', (req, res) => {
  if (req.session?.userId) return res.redirect('/');
  res.render('pages/register', { error: null });
});

app.post('/register', async (req, res) => {
  const { username, password, confirmPassword, wa } = req.body;

  if (!username || !password || !wa) {
    return res.render('pages/register', { error: 'Semua field wajib diisi' });
  }

  if (confirmPassword && password !== confirmPassword) {
    return res.render('pages/register', { error: 'Konfirmasi password tidak cocok' });
  }

  if (username === 'admin') {
    return res.render('pages/register', { error: 'Username tidak diizinkan' });
  }

  const users = readDB('users.json');

  if (users.find(u => u.username === username)) {
    return res.render('pages/register', { error: 'Username sudah digunakan' });
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

// ── RESELLER ──
app.get('/reseller', (req, res) => {
  const settings = readDB('settings.json');
  const user = getSessionUser(req);
  res.render('pages/reseller', { layout: false, settings, user });
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
        const r = await createQRISPayment(orderId, price, settings);
        qrString = r.qr_string;
      } catch (e) {
        if (settings.qrisStaticImage) { isStatic = true; }
        else return res.json({ success: false, message: 'QRIS error: ' + e.message });
      }
    }

    const transactions = readDB('transactions.json');
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

// Product routes
app.get('/buy/:id', requireAuth, (req, res) => {
  const products = readDB('products.json');
  const product = products.find(p => p.id === req.params.id);

  if (!product || product.status !== 'active') {
    return res.redirect('/');
  }

  const settings = readDB('settings.json');
  const user = getSessionUser(req);

  const isReseller = !!(user?.is_reseller);
  const resellerDiscount = settings.resellerDiscount || 20;
  const allKeys = product.keys || [];
  const genericKeys = allKeys.filter(k => !k.includes(':'));
  if (product.items) {
    product.items = product.items.map(item => {
      const m = (item.l || '').match(/(\d+)\s+DAYS/i);
      const days = m ? parseInt(m[1]) : null;
      let stok;
      if (days) {
        const tagged = allKeys.filter(k => {
          const parts = k.split(':');
          return parts.length > 1 && parseInt(parts[parts.length - 1]) === days;
        }).length;
        stok = tagged > 0 ? tagged : genericKeys.length;
      } else {
        stok = genericKeys.length;
      }
      return {
        ...item,
        stok,
        reseller_price: isReseller ? Math.round(item.p * (1 - resellerDiscount / 100)) : null
      };
    });
  }

  res.render('pages/buy', { product, settings, user, isReseller });
});

app.post('/create-order', requireAuth, async (req, res) => {
  try {
    const { productId, duration, customerName, wa, voucherCode } = req.body;
    const products = await readFresh('products.json');
    const product = products.find(p => p.id === productId);

    if (!product || product.status !== 'active') return res.json({ success: false, message: 'Produk tidak ditemukan' });
    if (!product.keys || product.keys.length === 0) return res.json({ success: false, message: 'Stok habis' });

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

    const settings = readDB('settings.json');
    // Terapkan diskon reseller
    const orderUser = getSessionUser(req);
    if (orderUser?.is_reseller) {
      const disc = settings.resellerDiscount || 20;
      price = Math.round(price * (1 - disc / 100));
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
        const r = await createQRISPayment(orderId, price, settings);
        qrString = r.qr_string;
        totalPayment = r.total_payment || price;
        expiredAt = r.expired_at || null;
      } catch (error) {
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

app.get('/check-payment/:refId', requireAuth, async (req, res) => {
  const refId = req.params.refId;
  // Cegah race condition: jika transaksi sedang diproses, kembalikan pending
  if (processingOrders.has(refId)) {
    return res.json({ success: true, status: 'pending' });
  }
  processingOrders.add(refId);
  try {
    const transactions = readDB('transactions.json');
    const transaction = transactions.find(t => t.id === refId);
    if (!transaction) return res.json({ success: false, message: 'Transaksi tidak ditemukan' });
    if (transaction.status === 'done') {
      if (transaction.type === 'reseller') return res.json({ success: true, status: 'done', type: 'reseller' });
      return res.json({ success: true, status: 'done', key: transaction.key, code: transaction.code });
    }

    // Static QRIS: tunggu konfirmasi manual admin
    if (transaction.isStatic) return res.json({ success: true, status: 'pending_static' });

    const settings = readDB('settings.json');
    let paid = false;
    try {
      const r = await checkPaymentStatus(transaction.orderId, transaction.totalPayment || transaction.price, settings);
      // Normalize status dari berbagai format response PakKasir
      const status = (r.transaction?.status || r.status || r.data?.status || '').toLowerCase();
      paid = ['completed','success','paid','settlement','capture','complete','authorize','accepted'].includes(status) || r.success === true;
      if (['expired','canceled','cancelled'].includes(status)) {
        transaction.status = 'expired';
        await writeDB('transactions.json', transactions);
        return res.json({ success: true, status: 'expired' });
      }
    } catch(e) { /* API error, keep pending */ }

    if (paid) {
      // Jika transaksi reseller, upgrade status user
      if (transaction.type === 'reseller') {
        const users = readDB('users.json');
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
        return res.json({ success: true, status: 'done', type: 'reseller' });
      }

      const products = readDB('products.json');
      const product = products.find(p => p.id === transaction.productId);
      let key = null;

      if (product?.keys?.length > 0) {
        const days = transaction.selectedDays;
        // Cari key duration-specific dulu (format KEY:DAYS dari deem)
        if (days) {
          const idx = product.keys.findIndex(k => {
            const parts = k.split(':');
            return parts.length > 1 && parseInt(parts[parts.length - 1]) === days;
          });
          if (idx !== -1) { key = product.keys.splice(idx, 1)[0].split(':')[0]; }
        }
        // Fallback: ambil generic key (tanpa colon)
        if (!key) {
          const idx = product.keys.findIndex(k => !k.includes(':'));
          if (idx !== -1) key = product.keys.splice(idx, 1)[0];
          else key = product.keys.shift(); // terakhir: ambil apa saja
        }
        product.sold = (product.sold || 0) + 1;
        await writeDB('products.json', products);
      } else {
        key = `HM-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
      }

      transaction.status = 'done';
      transaction.key = key;
      transaction.paidAt = new Date().toISOString();
      await writeDB('transactions.json', transactions);

      const notifs = readDB('notifications.json');
      const buyer = readDB('users.json').find(u => u.id === transaction.userId);
      notifs.unshift({ id: uuidv4(), type: 'purchase', buyerName: transaction.customerName,
        buyerPhoto: buyer?.photo || null, productName: transaction.productName,
        price: transaction.price, time: transaction.paidAt, timeStr: formatDate(new Date(transaction.paidAt)) });
      await writeDB('notifications.json', notifs.slice(0, 50));

      return res.json({ success: true, status: 'done', key, code: transaction.code });
    }

    res.json({ success: true, status: transaction.status });
  } catch (error) {
    console.error('[check-payment] error:', error.message);
    res.json({ success: false, message: error.message });
  } finally {
    processingOrders.delete(refId);
  }
});

app.get('/invoice', (req, res) => {
  if (!checkInvoiceRateLimit(req.ip)) {
    return res.render('pages/invoice', { transaction: null, error: 'Terlalu banyak pencarian. Coba lagi dalam 5 menit.' });
  }
  const { code } = req.query;
  if (code) {
    const transactions = readDB('transactions.json');
    const transaction = transactions.find(t => t.code === code.toUpperCase());
    return res.render('pages/invoice', { transaction: transaction || null, error: transaction ? null : 'Pesanan tidak ditemukan' });
  }
  res.render('pages/invoice', { transaction: null, error: null });
});

app.post('/invoice', (req, res) => {
  if (!checkInvoiceRateLimit(req.ip)) {
    return res.render('pages/invoice', { transaction: null, error: 'Terlalu banyak pencarian. Coba lagi dalam 5 menit.' });
  }
  const { code } = req.body;
  const transactions = readDB('transactions.json');
  const transaction = transactions.find(t => t.code === code.toUpperCase());

  if (!transaction) {
    return res.render('pages/invoice', { transaction: null, error: 'Pesanan tidak ditemukan' });
  }

  res.render('pages/invoice', { transaction, error: null });
});

// Admin routes
app.get('/admin', requireAdmin, (req, res) => {
  const products = readDB('products.json');
  const transactions = readDB('transactions.json');
  const users = readDB('users.json');
  const settings = readDB('settings.json');

  const stats = {
    totalProducts: products.length,
    activeProducts: products.filter(p => p.status === 'active').length,
    totalTransactions: transactions.length,
    pendingTransactions: transactions.filter(t => t.status === 'pending').length,
    doneTransactions: transactions.filter(t => t.status === 'done').length,
    totalUsers: users.length,
    totalResellers: users.filter(u => u.is_reseller).length,
    totalRevenue: transactions.filter(t => t.status === 'done').reduce((sum, t) => sum + t.price, 0)
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
    chartData
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

app.post('/admin/product/add', requireAdmin, (req, res, next) => {
  upload.single('image')(req, res, err => {
    if (err) return res.json({ success: false, message: 'Upload error: ' + err.message });
    next();
  });
}, async (req, res) => {
  try {
    const {name,category,description,imageUrl:imgUrl,pricingDays,pricingPrices,keys,status}=req.body;
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
    const items=pricingOptions.map(o=>({l:`${name.toUpperCase()} ${o.days} DAYS`,p:o.price}));
    const newProduct={id:uuidv4(),name,category:category||'freefire',description:description||'',image,pricingOptions,items,status:status==='inactive'?'inactive':'active',keys:keyArray,sold:0,createdAt:new Date().toISOString()};
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
    const {name,category,description,imageUrl:imgUrl,pricingDays,pricingPrices,keys,keysMode,status}=req.body;
    const products=await readFresh('products.json');
    const product=products.find(p=>p.id===req.params.id);
    if(!product)return res.json({success:false,message:'Produk tidak ditemukan'});
    if(imgUrl && !isValidImageUrl(imgUrl)) return res.json({success:false,message:'URL gambar tidak valid'});
    if(name)product.name=name;if(category)product.category=category;
    if(description!==undefined)product.description=description;if(status)product.status=status;
    if(pricingDays){const opts=parsePricingOptions(pricingDays,pricingPrices);if(opts.length){product.pricingOptions=opts;product.items=opts.map(o=>({l:`${product.name.toUpperCase()} ${o.days} DAYS`,p:o.price}));}}
    if(keys!==undefined&&keys!==null){const nk=keys.split('\n').map(k=>k.trim()).filter(k=>k);product.keys=keysMode==='append'?[...(product.keys||[]),...nk]:nk;}
    if (req.file) {
      if (!isVercel) product.image=`/uploads/products/${req.file.filename}`;
      else { try { product.image = await db.uploadImage(require('fs').readFileSync(req.file.path), req.file.originalname, req.file.mimetype); } catch {} }
    }
    else if(imgUrl?.trim()) product.image=imgUrl.trim();
    await writeDB('products.json',products);res.json({success:true,product});
  }catch(error){res.json({success:false,message:error.message});}
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
    transactions = transactions.filter(t => t.id !== req.params.id);
    await writeDB('transactions.json', transactions);
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
    trx.status = status;
    trx.updatedBy = 'admin';
    trx.updatedAt = new Date().toISOString();
    await writeDB('transactions.json', transactions);
    res.json({ success: true, message: 'Status berhasil diubah' });
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
    if (adminUsername) settings.adminUsername = adminUsername;

    settings.contact = settings.contact || {};
    if (whatsapp !== undefined) settings.contact.whatsapp = whatsapp;
    if (telegram !== undefined) settings.contact.telegram = telegram;
    if (email    !== undefined) settings.contact.email    = email;

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

app.post('/admin/settings/pakasir', requireAdmin, async (req, res) => {
  try {
    const settings = await readFresh('settings.json');
    const { apiKey, project, mode, apiBaseUrl, qrisMode } = req.body;

    settings.pakasir = {
      apiKey: apiKey !== undefined ? apiKey : (settings.pakasir?.apiKey || ''),
      project: project !== undefined ? project : (settings.pakasir?.project || ''),
      mode: mode || settings.pakasir?.mode || 'production',
      apiBaseUrl: apiBaseUrl !== undefined ? apiBaseUrl : (settings.pakasir?.apiBaseUrl || 'api.pakasir.com')
    };

    if (qrisMode) settings.qrisMode = qrisMode;

    await writeDB('settings.json', settings);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

app.post('/admin/qris/test', requireAdmin, async (req, res) => {
  try {
    const { apiKey, project, apiBaseUrl } = req.body;
    const hostname = apiBaseUrl || 'api.pakasir.com';
    const testSettings = { pakasir: { apiKey, project, apiBaseUrl: hostname } };
    try {
      await createQRISPayment('test-' + Date.now(), 1000, testSettings);
      res.json({ success: true });
    } catch (e) {
      res.json({ success: false, message: e.message });
    }
  } catch (error) {
    res.json({ success: false, message: error.message });
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

app.post('/admin/settings/reseller', requireAdmin, async (req, res) => {
  try {
    const { resellerEnabled, resellerPrice, resellerDiscount, resellerNote } = req.body;
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
    if (resellerNote !== undefined) settings.resellerNote = resellerNote;
    await writeDB('settings.json', settings);
    res.json({ success: true });
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

    // Transaksi produk biasa: ambil key
    const products = readDB('products.json');
    const product = products.find(p => p.id === transaction.productId);
    let key = null;
    if (product?.keys?.length > 0) {
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
        else key = product.keys.shift();
      }
      product.sold = (product.sold || 0) + 1;
      await writeDB('products.json', products);
    }

    transaction.status = 'done';
    transaction.key = key;
    transaction.paidAt = new Date().toISOString();
    transaction.confirmedBy = 'admin';
    await writeDB('transactions.json', transactions);

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

  // Fake entries to make leaderboard look active
  const fakeLeaderboardEntries = [
    { username: 'ACA XITERZ',  totalTransactions: 47, totalSpent: 12500000, photo: null },
    { username: 'Hergi',       totalTransactions: 38, totalSpent: 8700000,  photo: null },
    { username: 'bintang_07',  totalTransactions: 31, totalSpent: 5300000,  photo: null },
    { username: 'Wanda',       totalTransactions: 28, totalSpent: 4100000,  photo: null },
    { username: 'dimas_pro',   totalTransactions: 24, totalSpent: 3800000,  photo: null },
    { username: 'abil',        totalTransactions: 21, totalSpent: 3200000,  photo: null },
    { username: 'Saell',       totalTransactions: 18, totalSpent: 2800000,  photo: null },
    { username: 'rehan',       totalTransactions: 15, totalSpent: 2100000,  photo: null },
    { username: 'farhan99',    totalTransactions: 12, totalSpent: 1750000,  photo: null },
    { username: 'rizky_ff',    totalTransactions: 10, totalSpent: 1400000,  photo: null },
    { username: 'gamer_mlbb',  totalTransactions: 9,  totalSpent: 1200000,  photo: null },
    { username: 'keymaster',   totalTransactions: 8,  totalSpent: 980000,   photo: null },
    { username: 'Rizky F.',    totalTransactions: 7,  totalSpent: 850000,   photo: null },
    { username: 'Andi S.',     totalTransactions: 7,  totalSpent: 820000,   photo: null },
    { username: 'Dimas P.',    totalTransactions: 6,  totalSpent: 740000,   photo: null },
  ];

  // Convert real stats to array and add user info
  const realEntries = Object.values(userStats).map(stat => {
    const user = users.find(u => u.id === stat.userId);
    return {
      ...stat,
      username: user?.username || 'Unknown',
      photo: user?.photo || null
    };
  });

  // Merge real + fake, deduplicate by username
  const seenUsernames = new Set(realEntries.map(e => e.username.toLowerCase()));
  const mergedLeaderboard = [...realEntries];
  fakeLeaderboardEntries.forEach(entry => {
    if (!seenUsernames.has(entry.username.toLowerCase())) {
      seenUsernames.add(entry.username.toLowerCase());
      mergedLeaderboard.push(entry);
    }
  });

  // Sort by total transactions descending
  mergedLeaderboard.sort((a, b) => b.totalTransactions - a.totalTransactions);

  // Add rank
  mergedLeaderboard.forEach((item, index) => {
    item.rank = index + 1;
  });

  const leaderboard = mergedLeaderboard;
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
  const products = (await readFresh('products.json')).filter(p => p.status === 'active');
  res.json(products);
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
  const products = await readSmart('products.json');
  const realTestimonials = await readSmart('testimonials.json');
  const users = await readSmart('users.json');
  const active = products.filter(p => p.status === 'active');
  const totalSold = products.reduce((s, p) => s + (p.sold || 0), 0);
  // Fake testimonial ratings to pad stats
  const fakeRatings = [5,5,5,5,5,4,5,4,5,5,5,5];
  const allRatings = [
    ...realTestimonials.map(t => t.rating || 5),
    ...fakeRatings
  ];
  const avgRating = (allRatings.reduce((s,r) => s+r, 0) / allRatings.length).toFixed(1);
  res.json({
    totalSold,
    totalActiveProducts: active.length,
    totalUsers: users.length + 847,
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
    const testimonials = readDB('testimonials.json');

    testimonials.unshift({
      id: uuidv4(),
      product: productId,
      productName: productName || '',
      username: user?.username || 'Pengguna',
      rating: ratingNum,
      text: text.trim(),
      date: new Date().toISOString(),
      verified: false,
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
  const notifs = readDB('notifications.json').slice(0, 20);
  const users = readDB('users.json');
  const enriched = notifs.map(notification => {
    const buyer = users.find(u => u.username === notification.buyerName);
    return {
      ...notification,
      buyerPhoto: buyer?.photo || null
    };
  });
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
    return { username: user?.username || 'User', totalTransactions: stat.totalTransactions, totalSpent: stat.totalSpent, isReal: true };
  });

  // Fake entries to pad leaderboard so it looks alive
  const fakeEntries = [
    { username: 'ACA XITERZ',  totalTransactions: 47, totalSpent: 12500000 },
    { username: 'Hergi',       totalTransactions: 38, totalSpent: 8700000  },
    { username: 'bintang_07',  totalTransactions: 31, totalSpent: 5300000  },
    { username: 'Wanda',       totalTransactions: 28, totalSpent: 4100000  },
    { username: 'dimas_pro',   totalTransactions: 24, totalSpent: 3800000  },
    { username: 'abil',        totalTransactions: 21, totalSpent: 3200000  },
    { username: 'Saell',       totalTransactions: 18, totalSpent: 2800000  },
    { username: 'rehan',       totalTransactions: 15, totalSpent: 2100000  },
    { username: 'farhan99',    totalTransactions: 12, totalSpent: 1750000  },
    { username: 'rizky_ff',    totalTransactions: 10, totalSpent: 1400000  },
    { username: 'gamer_mlbb',  totalTransactions: 9,  totalSpent: 1200000  },
    { username: 'keymaster',   totalTransactions: 8,  totalSpent: 980000   },
    { username: 'Rizky F.',    totalTransactions: 7,  totalSpent: 850000   },
    { username: 'Andi S.',     totalTransactions: 7,  totalSpent: 820000   },
    { username: 'Dimas P.',    totalTransactions: 6,  totalSpent: 740000   },
    { username: 'GamerKing99', totalTransactions: 6,  totalSpent: 690000   },
    { username: 'SkyyFire',    totalTransactions: 5,  totalSpent: 600000   },
    { username: 'ShadowX',     totalTransactions: 5,  totalSpent: 550000   },
    { username: 'NightWolf',   totalTransactions: 4,  totalSpent: 480000   },
    { username: 'LunarKing',   totalTransactions: 4,  totalSpent: 420000   },
    { username: 'NeonVibes',   totalTransactions: 3,  totalSpent: 350000   },
    { username: 'StormRider',  totalTransactions: 3,  totalSpent: 300000   },
    { username: 'GhostByte',   totalTransactions: 3,  totalSpent: 280000   },
    { username: 'CyberRush',   totalTransactions: 2,  totalSpent: 200000   },
    { username: 'AlphaGod',    totalTransactions: 2,  totalSpent: 180000   },
  ];

  // Merge: real entries take priority, fill remaining with fake
  const realUsernames = new Set(realEntries.map(e => e.username.toLowerCase()));
  const filteredFake = fakeEntries.filter(e => !realUsernames.has(e.username.toLowerCase()));

  const combined = [...realEntries, ...filteredFake];
  combined.sort((a, b) => b.totalTransactions - a.totalTransactions);
  combined.forEach((item, i) => { item.rank = i + 1; });

  res.json({ success: true, data: combined.slice(0, 10) });
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

// Admin Get Single Product
app.get('/admin/product/:id', requireAdmin, (req, res) => {
  const products = readDB('products.json');
  const product = products.find(p => p.id === req.params.id);
  if (!product) return res.json({ success: false, message: 'Produk tidak ditemukan' });
  res.json({ success: true, data: product });
});

// Admin Update Product (image, status, keys)
app.post('/admin/product/:id', requireAdmin, async (req, res) => {
  try {
    const { items, bannerUrl, status, keys, keysMode, platforms } = req.body;
    const products = await readFresh('products.json');
    const productIndex = products.findIndex(p => p.id === req.params.id);

    if (productIndex === -1) return res.json({ success: false, message: 'Produk tidak ditemukan' });
    const p = products[productIndex];

    // Simpan ke image (yang dibaca frontend) DAN bannerUrl
    if (bannerUrl && bannerUrl.trim()) {
      p.image    = bannerUrl.trim();
      p.bannerUrl = bannerUrl.trim();
    }

    if (status) p.status = status;
    if (Array.isArray(platforms)) p.platforms = platforms;

    // Kelola keys
    if (keys !== undefined && keys !== null) {
      const newKeys = String(keys).split('\n').map(k => k.trim()).filter(k => k);
      if (newKeys.length > 0) {
        p.keys = keysMode === 'replace' ? newKeys : [...(p.keys || []), ...newKeys];
      }
    }

    await writeDB('products.json', products);
    res.json({ success: true, message: 'Produk berhasil diupdate', data: p });
  } catch (error) {
    res.json({ success: false, message: 'Error: ' + error.message });
  }
});

// Admin Upload Banner — di Vercel upload ke Supabase Storage, lokal ke filesystem
app.post('/admin/upload-banner', requireAdmin, multer({ storage: multer.memoryStorage() }).single('banner'), async (req, res) => {
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

// User: halaman aktifkan key
app.get('/activate-key', requireAuth, (req, res) => {
  const user = getSessionUser(req);
  const settings = readDB('settings.json');
  res.render('pages/activate-key', { user, settings, result: null, error: null, code: '' });
});

app.post('/activate-key', requireAuth, async (req, res) => {
  const user = getSessionUser(req);
  const settings = readDB('settings.json');
  const code = (req.body.code || '').trim().toUpperCase();

  if (!code) return res.render('pages/activate-key', { user, settings, result: null, error: 'Masukkan kode key terlebih dahulu', code: '' });

  const keyspool = readDB('keyspool.json');
  const key = keyspool.find(k => k.code.toUpperCase() === code);

  if (!key) return res.render('pages/activate-key', { user, settings, result: null, error: 'Key tidak ditemukan atau tidak valid', code });
  if (key.used) return res.render('pages/activate-key', { user, settings, result: null, error: 'Key sudah pernah digunakan', code });

  key.used = true;
  key.usedBy = user.id;
  key.usedByUsername = user.username;
  key.usedAt = new Date().toISOString();
  await writeDB('keyspool.json', keyspool);

  res.render('pages/activate-key', {
    user, settings, code,
    result: { code: key.code, duration: key.duration, label: key.label || `${key.duration} Hari`, note: key.note || '' },
    error: null
  });
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
