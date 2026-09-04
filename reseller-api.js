// ══════════════════════════════════════════════════════════════════
// reseller-api.js — Integrasi dengan Reseller API vipibmstore.com (v2)
//
// Dipakai untuk produk dengan stockMode === 'auto': key TIDAK diambil dari
// stok manual (products.json -> keys[]), tapi di-generate langsung dari
// provider setiap kali ada order (lihat resolveProductKey() di server.js).
//
// Pakai modul `https` bawaan Node (bukan fetch global) supaya konsisten
// dengan integrasi Pakasir/GensPay yang sudah ada di server.js, dan tetap
// kompatibel dengan Node versi lama (lihat "engines" di package.json).
//
// Autentikasi memakai HMAC-SHA256 sesuai dokumentasi resmi provider:
//   canonical = METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + SHA256(body)
//   secretHash = SHA256(apiSecret)
//   signature  = HMAC-SHA256(canonical, secretHash)
//
// Kredensial (API Key + API Secret) TIDAK di-hardcode di sini. Diambil dari
// (urutan prioritas):
//   1. settings.resellerApi.{apiKey,apiSecret,baseUrl} — diisi admin lewat
//      panel admin (menu Pengaturan → Reseller API), disimpan di database.
//   2. Environment variable RESELLER_API_KEY / RESELLER_API_SECRET /
//      RESELLER_API_BASE_URL — fallback untuk deployment yang prefer env var.
//
// PENTING SOAL KEAMANAN: API Key & Secret adalah kredensial yang bisa
// dipakai untuk memotong saldo reseller. Jangan pernah commit nilai asli
// ke git, jangan kirim di chat/screenshot. Kalau pernah bocor, WAJIB
// di-regenerate dari dashboard vipibmstore.com/reseller sebelum dipakai.
// ══════════════════════════════════════════════════════════════════

const https = require('https');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_BASE_URL = 'https://vipibmstore.com/api/reseller';
const REQUEST_TIMEOUT_MS = 25000;

function getConfig(settings) {
  const cfg = (settings && settings.resellerApi) || {};
  return {
    apiKey: (cfg.apiKey || process.env.RESELLER_API_KEY || '').trim(),
    apiSecret: (cfg.apiSecret || process.env.RESELLER_API_SECRET || '').trim(),
    baseUrl: (cfg.baseUrl || process.env.RESELLER_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  };
}

function isConfigured(settings) {
  const { apiKey, apiSecret } = getConfig(settings);
  return Boolean(apiKey && apiSecret);
}

function sign({ method, path, timestamp, nonce, rawBody, apiSecret }) {
  const bodyHash = crypto.createHash('sha256').update(rawBody || '').digest('hex');
  const canonical = [method, path, timestamp, nonce, bodyHash].join('\n');
  const secretHash = crypto.createHash('sha256').update(apiSecret).digest('hex');
  return crypto.createHmac('sha256', secretHash).update(canonical).digest('hex');
}

// method: 'GET' | 'POST'
// relativePath: path setelah base URL, contoh '/v2/orders'
// body: object (opsional, untuk POST)
// idempotencyKey: opsional, dikirim sebagai header Idempotency-Key
function doRequest(settings, { method, relativePath, body, idempotencyKey }) {
  return new Promise((resolve) => {
    const { apiKey, apiSecret, baseUrl } = getConfig(settings);
    if (!apiKey || !apiSecret) {
      return resolve({ success: false, code: 'NOT_CONFIGURED', message: 'Reseller API Key/Secret belum diatur di panel admin.' });
    }

    let url;
    try {
      url = new URL(baseUrl.replace(/\/+$/, '') + '/' + relativePath.replace(/^\/+/, ''));
    } catch (e) {
      return resolve({ success: false, code: 'INVALID_BASE_URL', message: 'Base URL Reseller API tidak valid.' });
    }

    // Signature memakai FULL pathname URL (bukan cuma bagian setelah
    // baseUrl), sesuai contoh dokumentasi: path = "/api/reseller/v2/orders".
    const signPath = url.pathname;

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = uuidv4();
    const rawBody = method === 'GET' ? '' : JSON.stringify(body || {});
    const signature = sign({ method, path: signPath, timestamp, nonce, rawBody, apiSecret });

    const headers = {
      'x-api-key': apiKey,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature
    };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(rawBody);
    }
    if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 191);

    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch { /* respon kosong / bukan JSON */ }

        if (res.statusCode < 200 || res.statusCode >= 300 || parsed.success === false) {
          return resolve({
            success: false,
            code: parsed.code || `HTTP_${res.statusCode}`,
            message: parsed.message || `Reseller API mengembalikan status ${res.statusCode}`,
            status: res.statusCode
          });
        }
        resolve({ success: true, data: parsed.data });
      });
    });

    req.on('timeout', () => { req.destroy(); resolve({ success: false, code: 'TIMEOUT', message: 'Timeout menghubungi Reseller API' }); });
    req.on('error', e => resolve({ success: false, code: 'NETWORK_ERROR', message: e.message || 'Gagal menghubungi Reseller API' }));
    if (method !== 'GET') req.write(rawBody);
    req.end();
  });
}

function getBalance(settings) {
  return doRequest(settings, { method: 'GET', relativePath: '/v2/balance' });
}

function getProducts(settings) {
  return doRequest(settings, { method: 'GET', relativePath: '/v2/products' });
}

function getOrder(settings, orderId) {
  return doRequest(settings, { method: 'GET', relativePath: `/v2/orders/${encodeURIComponent(orderId)}` });
}

// ══════════════════════════════════════════════════════════════════
// AUTO-MATCH — cari product_item_id provider TANPA mapping manual, dengan
// mencocokkan nama produk web + jumlah hari varian terhadap daftar produk
// provider (product_name + item_name). Dipakai supaya admin tidak perlu
// mapping satu-satu tiap produk & tiap varian hari lewat halaman Edit
// Produk -- cukup pastikan nama produk & jumlah hari di web mirip dengan
// yang ada di dashboard provider.
//
// Prioritas resolusi item id (lihat resolveItemId di bawah):
//   1. Mapping manual per-varian (product.pricingOptions[i].resellerItemId)
//      -- kalau admin sudah mengisi ini secara eksplisit, SELALU dipakai,
//      auto-match tidak pernah menimpa pilihan manual.
//   2. Mapping manual per-produk (product.resellerItemId) -- untuk produk
//      yang cuma py 1 varian atau semua varian sengaja diarahkan ke 1 item.
//   3. Auto-match by nama produk + hari -- fallback kalau tidak ada mapping
//      manual sama sekali.
//
// Auto-match HANYA dipakai kalau hasilnya benar-benar tidak ambigu (persis
// 1 kandidat cocok). Kalau nama produk provider mengandung >1 variasi yang
// cocok (mis. dua produk beda dengan nama mirip), auto-match sengaja GAGAL
// (bukan asal pilih salah satu) supaya tidak salah generate key dari
// produk yang salah -- admin akan diminta mapping manual untuk kasus itu.
// ══════════════════════════════════════════════════════════════════

// Cache daftar produk provider selama beberapa menit -- dipanggil di setiap
// checkout kalau tidak di-cache akan berat & lambat (network call ekstra
// tiap transaksi). TTL pendek supaya perubahan katalog provider (produk
// baru / stok berubah) tetap terrefleksi dalam waktu wajar.
let productsCache = { data: null, fetchedAt: 0 };
const PRODUCTS_CACHE_TTL_MS = 3 * 60 * 1000; // 3 menit

// FIX RACE CONDITION: sebelumnya, kalau banyak produk mode 'auto' dirender
// bersamaan dalam 1 halaman (Promise.all di stripKeys, server.js), SETIAP
// produk manggil getProductsCached() sendiri-sendiri. Karena cache masih
// kosong/expired di awal, semua panggilan itu LOLOS pengecekan cache secara
// bersamaan (belum ada yang sempat menyimpan hasil), sehingga semuanya
// nembak getProducts() ke provider SECARA PARALEL -- inilah penyebab asli
// "Too many requests" (bukan cuma soal admin buka halaman Edit Produk).
// Sekarang pakai in-flight promise: kalau sudah ada fetch yang sedang
// berjalan, request lain menunggu hasil YANG SAMA itu, tidak bikin fetch
// baru ke provider.
let inFlightFetch = null;

async function getProductsCached(settings) {
  const now = Date.now();
  if (productsCache.data && (now - productsCache.fetchedAt) < PRODUCTS_CACHE_TTL_MS) {
    return { success: true, data: productsCache.data };
  }
  if (inFlightFetch) return inFlightFetch; // gabung ke fetch yang sedang jalan, jangan fetch baru

  inFlightFetch = (async () => {
    try {
      const result = await getProducts(settings);
      if (result.success && Array.isArray(result.data)) {
        productsCache = { data: result.data, fetchedAt: Date.now() };
      }
      return result;
    } finally {
      inFlightFetch = null;
    }
  })();

  return inFlightFetch;
}

// Dipakai endpoint force-refresh admin: simpan hasil fetch fresh (bypass
// cache) ke cache module-level yang sama, supaya request berikutnya
// (termasuk checkout customer) langsung kebagian data terbaru tanpa perlu
// fetch ulang ke provider.
function setProductsCache(data) {
  if (Array.isArray(data)) productsCache = { data, fetchedAt: Date.now() };
}

// Normalisasi nama untuk perbandingan longgar: lowercase, buang spasi ganda,
// buang karakter selain huruf/angka -- supaya "PATO BLUE" vs "Pato  Blue!"
// tetap dianggap sama.
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Cari kandidat item provider yang product_name-nya cocok dengan nama
// produk web, DAN item_name/varian-nya mengandung jumlah hari yang sama.
// Return null kalau tidak ketemu / ambigu (>1 kandidat) -- sengaja tidak
// pernah menebak, karena salah pilih di sini bisa memotong saldo reseller
// untuk produk yang salah.
function findAutoMatch(providerProducts, productName, days) {
  const wantedName = normalizeName(productName);
  if (!wantedName) return null;

  const nameMatches = providerProducts.filter(item => {
    const itemProductName = normalizeName(item.product_name);
    // Cocok kalau salah satu mengandung yang lain (menangani kasus nama
    // provider lebih spesifik/umum dikit dari nama produk web).
    return itemProductName && (itemProductName.includes(wantedName) || wantedName.includes(itemProductName));
  });
  if (nameMatches.length === 0) return null;

  if (days) {
    const dayMatches = nameMatches.filter(item => {
      const m = String(item.item_name || '').match(/(\d+)/);
      return m && parseInt(m[1]) === days;
    });
    if (dayMatches.length === 1) return dayMatches[0];
    if (dayMatches.length > 1) return null; // ambigu, jangan nebak
    // Tidak ada varian dengan hari yang cocok persis -- kalau produk
    // provider yang cocok nama cuma py 1 item total, anggap itu match
    // (produk tanpa banyak varian, mis. GBOX/ESIGN yang cuma 1 opsi).
    if (nameMatches.length === 1) return nameMatches[0];
    return null;
  }

  // Tidak ada info hari (produk tanpa varian durasi) -- hanya match kalau
  // persis 1 produk provider yang namanya cocok.
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

// Titik tunggal resolusi product_item_id untuk 1 kali order. Dipanggil dari
// resolveProductKey() di server.js. selectedDays boleh null (produk tanpa
// varian hari).
async function resolveItemId(settings, product, selectedDays) {
  // 1. Mapping manual per-varian -- prioritas tertinggi, tidak pernah
  //    ditimpa auto-match.
  if (selectedDays && Array.isArray(product.pricingOptions)) {
    const opt = product.pricingOptions.find(o => o.days === selectedDays);
    if (opt && opt.resellerItemId) {
      return { itemId: opt.resellerItemId, source: 'manual_variant' };
    }
  }

  // 2. Mapping manual per-produk (lama, tetap didukung untuk backward
  //    compatibility & produk 1-varian).
  if (product.resellerItemId) {
    return { itemId: product.resellerItemId, source: 'manual_product' };
  }

  // 3. Auto-cocokkan by nama -- DIMATIKAN atas permintaan eksplisit owner
  //    (khawatir "key random": auto-match pakai substring match nama produk,
  //    yang secara teori bisa salah pilih produk provider yang namanya mirip
  //    walau sudah ada filter anti-ambigu di findAutoMatch). Sekarang mapping
  //    manual WAJIB diisi dari halaman Edit Produk -- kalau kosong, order
  //    GAGAL dengan pesan jelas (bukan diam-diam menebak produk provider).
  //    findAutoMatch() di bawah sengaja dibiarkan ada (tidak dihapus) supaya
  //    gampang diaktifkan lagi kalau suatu saat kebijakan ini berubah.
  return { itemId: null, source: 'manual_required', error: `Produk "${product.name}"${selectedDays ? ' varian ' + selectedDays + ' hari' : ''} belum di-mapping ke produk provider. Buka halaman Edit Produk dan pilih produk provider secara manual di dropdown mapping.` };
}

// Order 1 key dari produk auto-generate / stok manual di sisi provider.
// idempotencyKey WAJIB diisi caller dan harus STABIL untuk order yang sama
// (jangan random tiap retry), supaya retry (misal timeout lalu di-retry)
// tidak dobel memotong saldo reseller / generate 2 key untuk 1 pembayaran.
function orderKey(settings, { productItemId, quantity = 1, customerReference, target, idempotencyKey }) {
  if (!productItemId) {
    return Promise.resolve({ success: false, code: 'MISSING_ITEM_ID', message: 'product_item_id belum di-mapping untuk produk ini.' });
  }
  if (!idempotencyKey) {
    return Promise.resolve({ success: false, code: 'MISSING_IDEMPOTENCY_KEY', message: 'idempotencyKey wajib diisi untuk order.' });
  }
  const body = { product_item_id: productItemId, quantity };
  if (customerReference) body.customer_reference = String(customerReference).slice(0, 191);
  if (target) body.target = String(target).slice(0, 191);
  return doRequest(settings, { method: 'POST', relativePath: '/v2/orders', body, idempotencyKey });
}

// ══════════════════════════════════════════════════════════════════
// DEBUG — sama seperti getBalance(), tapi mengembalikan detail canonical
// string, hash, dan signature yang dipakai, PLUS raw response dari
// provider (bukan cuma pesan error yang sudah di-generalisir). Dipakai
// oleh endpoint /admin/reseller-api/debug supaya bisa lihat akar masalah
// tanpa nebak-nebak (mismatch baseUrl, clock skew, whitespace di
// key/secret, dll).
//
// PENTING: JANGAN expose endpoint yang makai fungsi ini ke publik —
// canonical string + secretHash bisa dipakai reverse-engineer pola
// signing kalau bocor. Selalu di balik requireAdmin.
// ══════════════════════════════════════════════════════════════════
function debugBalance(settings) {
  return new Promise((resolve) => {
    const { apiKey, apiSecret, baseUrl } = getConfig(settings);

    const debugInfo = {
      configPresent: { apiKey: Boolean(apiKey), apiSecret: Boolean(apiSecret), baseUrl },
      apiKeyPreview: apiKey ? `${apiKey.slice(0, 10)}...${apiKey.slice(-4)} (len ${apiKey.length})` : null,
      apiSecretPreview: apiSecret ? `${apiSecret.slice(0, 10)}...${apiSecret.slice(-4)} (len ${apiSecret.length})` : null,
      apiKeyHasWhitespaceOrControlChars: apiKey ? /[\s\u200B-\u200D\uFEFF]/.test(apiKey) : null,
      apiSecretHasWhitespaceOrControlChars: apiSecret ? /[\s\u200B-\u200D\uFEFF]/.test(apiSecret) : null,
    };

    if (!apiKey || !apiSecret) {
      debugInfo.error = 'NOT_CONFIGURED';
      return resolve(debugInfo);
    }

    let url;
    try {
      url = new URL(baseUrl.replace(/\/+$/, '') + '/v2/balance');
    } catch (e) {
      debugInfo.error = 'INVALID_BASE_URL: ' + e.message;
      return resolve(debugInfo);
    }

    const method = 'GET';
    const signPath = url.pathname;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = uuidv4();
    const rawBody = '';
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const canonical = [method, signPath, timestamp, nonce, bodyHash].join('\n');
    const secretHash = crypto.createHash('sha256').update(apiSecret).digest('hex');
    const signature = crypto.createHmac('sha256', secretHash).update(canonical).digest('hex');

    debugInfo.request = {
      method,
      fullUrl: url.href,
      signPath,
      timestamp,
      timestampAsDate: new Date(Number(timestamp) * 1000).toISOString(),
      serverNowUtc: new Date().toISOString(),
      nonce,
      bodyHash,
      canonicalString: canonical.replace(/\n/g, '\\n\n'),
      secretHashPreview: secretHash.slice(0, 10) + '...',
      signature
    };

    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: {
        'x-api-key': apiKey,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': signature
      },
      timeout: REQUEST_TIMEOUT_MS
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        debugInfo.response = {
          statusCode: res.statusCode,
          headers: res.headers,
          rawBody: data.slice(0, 2000)
        };
        try { debugInfo.response.parsed = data ? JSON.parse(data) : null; } catch { debugInfo.response.parsed = null; }
        resolve(debugInfo);
      });
    });

    req.on('timeout', () => { req.destroy(); debugInfo.error = 'TIMEOUT'; resolve(debugInfo); });
    req.on('error', e => { debugInfo.error = 'NETWORK_ERROR: ' + e.message; resolve(debugInfo); });
    req.end();
  });
}

// Ambil stok ASLI dari provider untuk 1 varian produk (product + selectedDays)
// yang stockSource-nya 'auto'. Dipakai untuk MENAMPILKAN angka stok yang
// benar di kartu produk (bukan sentinel UNLIMITED_STOCK statis), supaya
// pembeli lihat jumlah yang sesuai kondisi provider saat ini.
//
// Return:
//   { stockMode: 'unlimited' }                — provider tandai v2/unlimited
//   { stockMode: 'limited', stock: number }    — provider kasih angka pasti
//   { stockMode: 'unknown' }                   — gagal resolve/fetch (biar
//                                                 caller fallback ke perilaku
//                                                 lama, jangan tampilkan 0
//                                                 yang keliatan seperti habis)
//
// Sengaja pakai getProductsCached (TTL 3 menit) yang SAMA dengan yang dipakai
// resolveItemId saat checkout, supaya 1 network call ke provider dipakai
// bareng oleh kartu produk (banyak produk sekaligus per page load) dan oleh
// proses checkout -- tidak menambah beban ke API provider.
async function getRealStockForProduct(settings, product, selectedDays) {
  try {
    const resolved = await resolveItemId(settings, product, selectedDays);
    if (!resolved.itemId) return { stockMode: 'unknown' };

    const listResult = await getProductsCached(settings);
    if (!listResult.success || !Array.isArray(listResult.data)) return { stockMode: 'unknown' };

    const item = listResult.data.find(i => i.id === resolved.itemId);
    if (!item) return { stockMode: 'unknown' };

    if (item.stock_mode === 'v2') return { stockMode: 'unlimited' };
    const stockNum = parseInt(item.stock);
    if (Number.isFinite(stockNum)) return { stockMode: 'limited', stock: stockNum };
    return { stockMode: 'unknown' };
  } catch {
    return { stockMode: 'unknown' };
  }
}

module.exports = { isConfigured, getConfig, getBalance, getProducts, getOrder, orderKey, debugBalance, resolveItemId, getProductsCached, getRealStockForProduct, setProductsCache };
