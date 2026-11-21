// ══════════════════════════════════════════════════════════════════
// reseller-v1.js — Reseller API v1 (HeroMarket sebagai PROVIDER, khusus Reseller Tier 2)
//
// Kontrak (konsep Thanhub / Drip): katalog flat per SKU, saldo wallet reseller, order dengan
// Idempotency-Key, key dikirim langsung di respons. Auth: Authorization: Bearer rk_live_<48 hex>.
//
// Ini JALUR SELF-SERVICE (reseller buat key sendiri di /reseller/api). Terpisah dari Partner API lama
// (partner-api.js, HMAC, dibuat admin) -- keduanya tetap hidup berdampingan.
//
// Modul ini murni logika (tanpa import server.js) supaya bisa dites: semua akses data lewat `deps`.
// ══════════════════════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

const KEY_RE = /^rk_live_[a-f0-9]{48}$/;
const RATE_LIMIT_RPM = 120;
const MAX_QTY = 20;
const CURRENCY = 'IDR';

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

// Key utuh hanya dikembalikan SEKALI (saat dibuat). Yang disimpan: hash + prefix tampilan.
function generateApiKey() {
  const key = 'rk_live_' + crypto.randomBytes(24).toString('hex');
  return { key, hash: hashKey(key), prefix: key.slice(0, 12) + '…' + key.slice(-4) };
}

// 0 = bukan reseller, 1 = Tier 1 (harga murah), 2 = Tier 2 (+ API).
// Reseller lama (is_reseller tanpa reseller_tier) dianggap Tier 1.
function getResellerTier(user) {
  if (!user || !user.is_reseller) return 0;
  const t = Number(user.reseller_tier);
  return t >= 2 ? 2 : 1;
}

// Harga reseller per opsi: reseller_price kalau diisi admin, kalau tidak diskon global; tidak pernah di atas harga normal.
function resellerUnitPrice(opt, settings) {
  const base = Number(opt.price) || 0;
  if (opt.resellerPrice !== undefined && opt.resellerPrice !== null && opt.resellerPrice !== '' && Number.isFinite(Number(opt.resellerPrice))) {
    return Math.max(0, Math.round(Number(opt.resellerPrice)));
  }
  const d = Number(settings && settings.resellerDiscount);
  const disc = Number.isFinite(d) && d >= 0 && d <= 100 ? d : 20;
  return Math.min(base, Math.round(base * (1 - disc / 100)));
}

// SKU = <productId>.<angka><unit>, unit d/h/m. Contoh: p17.30d
function skuForMinutes(productId, minutes) {
  if (minutes > 0 && minutes % 1440 === 0) return `${productId}.${minutes / 1440}d`;
  if (minutes > 0 && minutes % 60 === 0) return `${productId}.${minutes / 60}h`;
  return `${productId}.${minutes}m`;
}
function parseSku(sku) {
  const s = String(sku || '');
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return null;
  const m = /^(\d{1,9})([dhm])$/.exec(s.slice(dot + 1));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n) return null;
  const minutes = m[2] === 'd' ? n * 1440 : m[2] === 'h' ? n * 60 : n;
  return { productId: s.slice(0, dot), minutes, amount: n, unit: m[2] };
}

const sendErr = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const sendOk = (res, data, status = 200) => res.status(status).json({ data });

function createHandlers(deps) {
  const {
    readFresh, readSmart, adjustUserBalance, allocateKeyAndCompleteTransaction, writeDB,
    processingOrders, getOptionDurationMinutes, formatDurationLabel, getOptionStock,
    uuidv4, generateOrderCode, formatDate
  } = deps;

  // ── Rate limit: 120 req/menit per key (jendela tetap 60 dtk) ──
  const limiter = new Map(); // keyHash -> { count, resetAt }
  const sweep = () => { const now = Date.now(); for (const [k, v] of limiter) if (v.resetAt <= now) limiter.delete(k); };
  const sweeper = setInterval(sweep, 60 * 1000);
  if (sweeper.unref) sweeper.unref();
  const hitLimit = (keyHash) => {
    const now = Date.now();
    let e = limiter.get(keyHash);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + 60 * 1000 }; limiter.set(keyHash, e); }
    e.count++;
    return e.count > RATE_LIMIT_RPM;
  };

  const isMaintenance = (p) => String(p.safetyStatus || '').toLowerCase() === 'maintenance';

  // ── Auth ──
  async function auth(req, res, next) {
    try {
      res.set('Cache-Control', 'no-store');
      const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
      if (!m || !KEY_RE.test(m[1])) return sendErr(res, 401, 'UNAUTHORIZED', 'API key tidak valid atau tidak ada.');
      const keyHash = hashKey(m[1]);
      const users = await readFresh('users.json'); // SEGAR: key yang diganti/dicabut harus langsung mati
      const user = users.find(u => u.apiKeyHash && u.apiKeyHash === keyHash);
      if (!user) return sendErr(res, 401, 'UNAUTHORIZED', 'API key tidak valid atau tidak ada.');
      const settings = await readSmart('settings.json');
      if (getResellerTier(user) < 2 || user.resellerSuspended) {
        return sendErr(res, 403, 'FORBIDDEN', 'Akun ini tidak punya akses API (khusus Reseller Tier 2 yang aktif).');
      }
      if (settings && settings.resellerV1Enabled === false) {
        return sendErr(res, 403, 'FORBIDDEN', 'API reseller sedang dimatikan oleh admin.');
      }
      if (hitLimit(keyHash)) {
        res.set('Retry-After', '60');
        return sendErr(res, 429, 'BUSY', 'Terlalu banyak request. Maksimal 120 request per menit.');
      }
      req.apiUser = user;
      req.apiSettings = settings || {};
      next();
    } catch (e) {
      console.error('[reseller-v1] auth error:', e.message);
      return sendErr(res, 500, 'INTERNAL', 'Terjadi kesalahan pada server.');
    }
  }

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      console.error('[reseller-v1] error:', e && e.stack || e);
      if (!res.headersSent) sendErr(res, 500, 'INTERNAL', 'Terjadi kesalahan pada server.');
    }
  };

  // Daftar opsi yang ditawarkan: produk aktif + punya pricingOptions
  const offeredProducts = (products) => products.filter(p => p.status === 'active' && Array.isArray(p.pricingOptions) && p.pricingOptions.length > 0);

  async function buildItem(p, opt, settings) {
    const minutes = getOptionDurationMinutes(opt);
    if (!(minutes > 0)) return null;
    const apiCode = skuForMinutes(p.id, minutes);
    const unit = apiCode.slice(-1);
    const amount = parseInt(apiCode.slice(apiCode.lastIndexOf('.') + 1), 10);
    const maint = isMaintenance(p);
    let stock = null;
    try { stock = await getOptionStock(settings, p, opt); } catch (e) { stock = null; }
    if (stock !== null && !Number.isFinite(stock)) stock = null;
    return {
      apiCode,
      name: `${p.name} ${formatDurationLabel(opt)}`,
      product: p.name,
      productApiCode: p.id,
      category: p.category || '',
      label: formatDurationLabel(opt),
      days: Math.round((minutes / 1440) * 10000) / 10000,
      unit,
      amount,
      price: resellerUnitPrice(opt, settings),
      currency: CURRENCY,
      stock,
      inStock: !maint && (stock === null || stock > 0),
      is_maintenance: maint
    };
  }

  const findBySku = (products, sku) => {
    const parsed = parseSku(sku);
    if (!parsed) return { parsed: null };
    const product = products.find(p => p.id === parsed.productId && p.status === 'active' && Array.isArray(p.pricingOptions));
    if (!product) return { parsed, product: null };
    const opt = product.pricingOptions.find(o => getOptionDurationMinutes(o) === parsed.minutes);
    return { parsed, product, opt: opt || null };
  };

  // ── Handlers ──
  const me = wrap(async (req, res) => {
    sendOk(res, { username: req.apiUser.username, role: 'RESELLER', currency: CURRENCY, keyPrefix: req.apiUser.apiKeyPrefix || null, rateLimitRpm: RATE_LIMIT_RPM, maxQuantity: MAX_QTY });
  });

  const balance = wrap(async (req, res) => {
    const users = await readFresh('users.json');
    const u = users.find(x => x.id === req.apiUser.id);
    sendOk(res, { balance: (u && u.balance) || 0, currency: CURRENCY });
  });

  const products = wrap(async (req, res) => {
    const list = offeredProducts(await readFresh('products.json'));
    const rows = await Promise.all(list.map(async (p) => Promise.all(p.pricingOptions.map(o => buildItem(p, o, req.apiSettings)))));
    const items = rows.flat().filter(Boolean);
    sendOk(res, { currency: CURRENCY, priceTier: 'reseller', items });
  });

  const stock = wrap(async (req, res) => {
    const { parsed, product, opt } = findBySku(await readFresh('products.json'), req.query.sku);
    if (!parsed || !product || !opt) return sendErr(res, 404, 'UNKNOWN_SKU', 'SKU tidak ditemukan.');
    const it = await buildItem(product, opt, req.apiSettings);
    sendOk(res, { apiCode: it.apiCode, stock: it.stock, inStock: it.inStock, is_maintenance: it.is_maintenance });
  });

  // Susun ulang 1 order dari unit-unit transaksinya (1 key = 1 transaksi unit, dikelompokkan lewat apiOrderId)
  const buildOrder = (units, balanceNow) => {
    const first = units[0];
    const got = units.length;
    const full = got >= (first.apiQty || got);
    const out = {
      id: first.apiOrderId,
      code: first.apiCode,
      status: full ? 'FULFILLED' : 'PARTIAL',
      sku: first.apiSku,
      quantity: got,
      price: first.apiCharged != null ? first.apiCharged : got * (first.apiUnitPrice || 0),
      unitPrice: first.apiUnitPrice || 0,
      currency: CURRENCY,
      keys: units.map(u => u.key).filter(Boolean),
      createdAt: first.createdAt
    };
    if (balanceNow !== undefined) out.balance = balanceNow;
    return out;
  };
  const unitsOf = (txs, userId) => txs.filter(t => t.source === 'api' && t.userId === userId && t.apiOrderId && t.status === 'done');

  const createOrder = wrap(async (req, res) => {
    const user = req.apiUser;
    const idem = String(req.get('idempotency-key') || '').trim();
    if (!idem) return sendErr(res, 400, 'IDEMPOTENCY_REQUIRED', 'Header Idempotency-Key wajib diisi.');
    if (idem.length > 100) return sendErr(res, 400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key maksimal 100 karakter.');
    const body = req.body || {};
    const sku = String(body.sku || '').trim();
    if (!sku || !parseSku(sku)) return sendErr(res, 400, 'DURATION_REQUIRED', 'sku wajib diisi dengan format <produk>.<angka><d|h|m>.');
    const qRaw = body.quantity === undefined || body.quantity === null || body.quantity === '' ? 1 : body.quantity;
    const qty = Number(qRaw);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return sendErr(res, 400, 'INVALID_QTY', `quantity harus bilangan bulat 1-${MAX_QTY}.`);
    const target = body.target === undefined || body.target === null ? '' : String(body.target);
    if (target.length > 80) return sendErr(res, 400, 'INVALID_TARGET', 'target maksimal 80 karakter.');

    // Satu order per reseller sekaligus (anti double-spend)
    const lockKey = 'v1-' + user.id;
    if (processingOrders.has(lockKey)) return sendErr(res, 409, 'PURCHASE_PENDING', 'Masih ada order lain yang sedang diproses. Coba lagi sebentar.');
    processingOrders.add(lockKey);
    try {
      // Idempotensi (cek di dalam lock supaya request kembar tidak lolos bersamaan)
      let transactions = await readFresh('transactions.json');
      const prev = unitsOf(transactions, user.id).filter(t => t.apiIdem === idem);
      if (prev.length) {
        if (prev[0].apiSku !== sku) return sendErr(res, 422, 'IDEMPOTENCY_MISMATCH', 'Idempotency-Key ini sudah dipakai untuk SKU lain.');
        const users = await readFresh('users.json');
        const u = users.find(x => x.id === user.id);
        return sendOk(res, buildOrder(prev, (u && u.balance) || 0));
      }

      const prods = await readFresh('products.json');
      const { product, opt } = findBySku(prods, sku);
      if (!product || !opt) return sendErr(res, 404, 'UNKNOWN_SKU', 'SKU tidak ditemukan.');
      if (isMaintenance(product)) return sendErr(res, 400, 'PRODUCT_MAINTENANCE', 'Produk sedang maintenance.');

      // Stok manual: tolak di muka kalau tidak cukup sama sekali (auto/provider ketahuan saat alokasi)
      let st = null;
      try { st = await getOptionStock(req.apiSettings, product, opt); } catch (e) { st = null; }
      if (st !== null && Number.isFinite(st) && st < 1) return sendErr(res, 409, 'BUSY', 'Stok sedang habis. Coba lagi nanti.');
      // stok kurang dari qty (tapi > 0): tetap diproses, hasilnya PARTIAL sesuai yang tersedia

      const unitPrice = resellerUnitPrice(opt, req.apiSettings);
      const total = unitPrice * qty;
      const minutes = getOptionDurationMinutes(opt);

      // Potong saldo DI MUKA secara atomik (tidak bisa negatif, aman lintas instance)
      const pay = await adjustUserBalance(user.id, -total, { minBalance: 0 });
      if (!pay.ok) {
        if (pay.reason === 'insufficient') {
          return sendErr(res, 402, 'INSUFFICIENT_BALANCE', `Saldo tidak cukup. Dibutuhkan Rp${total.toLocaleString('id-ID')}, saldo kamu Rp${(pay.balance || 0).toLocaleString('id-ID')}.`);
        }
        return sendErr(res, 401, 'UNAUTHORIZED', 'Akun tidak ditemukan.');
      }

      const apiOrderId = uuidv4();
      const apiCode = generateOrderCode();
      const createdAt = new Date().toISOString();
      const idemHash = crypto.createHash('sha256').update(idem).digest('hex').slice(0, 16);
      transactions = await readFresh('transactions.json');
      const done = [];
      let failReason = null;
      for (let i = 0; i < qty; i++) {
        const unit = {
          // id deterministik -> idempotency key ke provider (kalau request diulang tidak bikin order ganda di sana)
          id: `api-${user.id}-${idemHash}-${i + 1}`,
          orderId: apiOrderId,
          code: apiCode,
          type: 'api-order',
          source: 'api',
          userId: user.id,
          customerName: user.username,
          productId: product.id,
          productName: product.name,
          selectedDays: minutes,
          price: unitPrice,
          totalPayment: unitPrice,
          paymentMethod: 'api',          // BUKAN 'balance': refund diurus modul ini, bukan jalur checkout biasa
          coinCashbackGiven: true,       // order API tidak ikut program cashback koin
          status: 'pending',
          wa: target,
          apiOrderId, apiCode, apiIdem: idem, apiSku: sku, apiQty: qty, apiUnitPrice: unitPrice,
          createdAt, time: formatDate()
        };
        transactions.push(unit);
        let r;
        try { r = await allocateKeyAndCompleteTransaction(unit, transactions); }
        catch (e) { r = { status: 'failed' }; unit.status = 'failed'; unit.failReason = 'Gagal mengalokasikan key'; console.error('[reseller-v1] alokasi error:', e.message); }
        if (r && r.status === 'done' && unit.key) done.push(unit);
        else { failReason = unit.failReason || (r && r.error) || 'Gagal mengalokasikan key'; break; }
      }

      // buang unit yang gagal dari catatan (tidak ada key, tidak ditagih)
      const failedIds = new Set(transactions.filter(t => t.apiOrderId === apiOrderId && t.status !== 'done').map(t => t.id));
      if (failedIds.size) transactions = transactions.filter(t => !failedIds.has(t.id));

      // Tagih hanya yang terkirim
      const charged = qty === 0 ? 0 : Math.round(total * done.length / qty);
      const refund = total - charged;
      let balanceNow = pay.balance;
      if (refund > 0) {
        const rf = await adjustUserBalance(user.id, refund);
        if (rf.ok) balanceNow = rf.balance;
      }
      if (done.length === 0) {
        await writeDB('transactions.json', transactions);
        console.warn('[reseller-v1] stok tidak tersedia / alokasi gagal:', failReason);
        return sendErr(res, 409, 'BUSY', 'Stok sedang tidak tersedia. Saldo tidak dipotong.');
      }
      done.forEach(u => { u.apiCharged = charged; });
      await writeDB('transactions.json', transactions);
      return sendOk(res, buildOrder(done, balanceNow), 201);
    } finally {
      processingOrders.delete(lockKey);
    }
  });

  const groupOrders = (txs, userId) => {
    const map = new Map();
    for (const t of unitsOf(txs, userId)) {
      if (!map.has(t.apiOrderId)) map.set(t.apiOrderId, []);
      map.get(t.apiOrderId).push(t);
    }
    return [...map.values()].sort((a, b) => new Date(b[0].createdAt) - new Date(a[0].createdAt));
  };

  const listOrders = wrap(async (req, res) => {
    let page = parseInt(req.query.page, 10); if (!(page >= 1)) page = 1;
    let limit = parseInt(req.query.limit, 10); if (!(limit >= 1)) limit = 20; if (limit > 50) limit = 50;
    const orders = groupOrders(await readFresh('transactions.json'), req.apiUser.id);
    const total = orders.length;
    const slice = orders.slice((page - 1) * limit, page * limit);
    const items = slice.map(units => {
      const o = buildOrder(units);
      return { id: o.id, code: o.code, status: o.status, sku: o.sku, quantity: o.quantity, price: o.price, keysCount: o.keys.length, createdAt: o.createdAt };
    });
    sendOk(res, { page, limit, total, hasMore: page * limit < total, items });
  });

  const getOrder = wrap(async (req, res) => {
    const ref = String(req.params.id || '');
    const orders = groupOrders(await readFresh('transactions.json'), req.apiUser.id);
    const units = orders.find(u => u[0].apiOrderId === ref || u[0].apiCode === ref);
    if (!units) return sendErr(res, 404, 'NOT_FOUND', 'Order tidak ditemukan.');
    sendOk(res, buildOrder(units));
  });

  const notFound = (req, res) => { res.set('Cache-Control', 'no-store'); sendErr(res, 404, 'NOT_FOUND', 'Endpoint tidak ditemukan.'); };

  return { auth, me, balance, products, stock, createOrder, listOrders, getOrder, notFound, _limiter: limiter };
}

function mount(app, express, deps) {
  const h = createHandlers(deps);
  const r = express.Router();
  r.get('/me', h.auth, h.me);
  r.get('/balance', h.auth, h.balance);
  r.get('/products', h.auth, h.products);
  r.get('/stock', h.auth, h.stock);
  r.post('/orders', h.auth, h.createOrder);
  r.get('/orders', h.auth, h.listOrders);
  r.get('/orders/:id', h.auth, h.getOrder);
  r.use(h.notFound);
  app.use('/api/v1', r);
  return h;
}

module.exports = {
  createHandlers, mount, generateApiKey, hashKey, getResellerTier, resellerUnitPrice,
  skuForMinutes, parseSku, KEY_RE, RATE_LIMIT_RPM, MAX_QTY
};
