const BaseProviderAdapter = require('./base');

/**
 * ADAPTER: HEROITBEST (Partner API)
 * ==================================
 * Menyambungkan toko ini ke panel heroitbest sebagai SUPPLIER key.
 * Owner toko tidak perlu lagi menyetok / mencari key manual: tiap ada
 * pembelian, key diambil otomatis dari heroitbest dan saldo akun partner
 * di heroitbest dipotong sebesar harga modal.
 *
 * Alur uang:
 *   pembeli bayar harga jual (QRIS/dll)  ->  toko ini
 *   toko ini minta key ke heroitbest      ->  saldo partner dipotong (harga modal)
 *   margin = harga jual - harga modal
 *
 * Setup di sisi heroitbest (admin): buat akun reseller khusus untuk toko ini,
 * top up saldonya, lalu buat Partner API Key yang terikat ke akun itu.
 *
 * Endpoint heroitbest yang dipakai (semua pakai header X-API-Key):
 *   GET  {baseUrl}/balance         -> { balance }
 *   GET  {baseUrl}/products        -> { data: [{ id, name, category, product_durations: [{ id, label, days, price }] }] }
 *   POST {baseUrl}/generate-key    -> { key: { key_string, ... } }   body: { productId, durationId, idempotencyKey }
 *
 * Satu "produk" di sistem toko = satu pasangan (produk heroitbest + durasi).
 * ID-nya dikodekan "<productId>|<durationId>" (tanpa karakter ':' karena
 * format mapping toko ini memakai ':' sebagai pemisah).
 */

const DEFAULT_BASE_URL = 'https://heroitbest.web.id/api/v1/partner';

function enc(s) { return String(s).replace(/%/g, '%25').replace(/\|/g, '%7C').replace(/:/g, '%3A'); }
function dec(s) { return String(s).replace(/%3A/g, ':').replace(/%7C/g, '|').replace(/%25/g, '%'); }

function encodeId(productId, durationId) { return `${enc(productId)}|${enc(durationId)}`; }
function decodeId(providerProductId) {
  const idx = String(providerProductId || '').indexOf('|');
  if (idx < 1) return null;
  const s = String(providerProductId);
  return { productId: dec(s.slice(0, idx)), durationId: dec(s.slice(idx + 1)) };
}

// Pesan aman untuk PEMBELI. Pesan mentah (mis. saldo partner habis) hanya
// masuk ke Log API admin, tidak ditampilkan ke pembeli.
const CUSTOMER_MESSAGES = {
  insufficient_balance: 'Stok produk ini sedang kosong sementara. Silakan coba lagi nanti atau hubungi admin.',
  out_of_stock: 'Stok key untuk paket ini sedang habis. Silakan coba lagi nanti atau hubungi admin.',
  provider_error: 'Supplier sedang sibuk. Pesanan kamu tidak hilang, hubungi admin bila key belum diterima.',
  rate_limited: 'Server sedang ramai. Coba lagi sebentar lagi.',
  order_in_progress: 'Server sedang memproses pesanan lain. Coba lagi sebentar lagi.',
  unauthorized: 'Layanan supplier sedang bermasalah. Hubungi admin.',
  invalid_product_or_duration: 'Paket ini sedang tidak tersedia. Hubungi admin.',
};

class HeroitbestAdapter extends BaseProviderAdapter {
  static get id() { return 'heroitbest'; }
  static get label() { return 'HEROITBEST (Partner API)'; }

  static get configFields() {
    return [
      { key: 'apiKey', label: 'Partner API Key (X-API-Key)', type: 'password', required: true },
      { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, default: DEFAULT_BASE_URL },
    ];
  }

  get baseUrl() {
    return String(this.config.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  }

  async _req(method, path, body, timeoutMs = 15000) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'X-API-Key': String(this.config.apiKey || '').trim(),
        'Accept': 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
    return { ok: res.ok, status: res.status, body: json };
  }

  async testConnection() {
    try {
      const r = await this._req('GET', '/balance');
      if (r.status === 401) return { success: false, message: 'API Key ditolak (401). Cek key & statusnya di panel heroitbest.' };
      if (r.ok) return { success: true, message: `Koneksi ke HEROITBEST berhasil. Saldo partner: Rp${Number(r.body.balance || 0).toLocaleString('id-ID')}` };
      // heroitbest versi lama belum punya /balance -> cek lewat katalog
      if (r.status === 404) {
        const p = await this._req('GET', '/products');
        if (p.ok) return { success: true, message: 'Koneksi berhasil (endpoint /balance belum ada di heroitbest, update dulu untuk lihat saldo).' };
        return { success: false, message: `HTTP ${p.status}: ${p.body?.error || 'gagal'}` };
      }
      return { success: false, message: `HTTP ${r.status}: ${r.body?.message || r.body?.error || 'gagal'}` };
    } catch (e) {
      return { success: false, message: `Gagal konek: ${e.message}` };
    }
  }

  async getBalance() {
    try {
      const r = await this._req('GET', '/balance');
      if (!r.ok) return { success: false, balance: 0, currency: 'IDR', message: r.body?.message || r.body?.error || `HTTP ${r.status}` };
      return { success: true, balance: Number(r.body.balance || 0), currency: 'IDR', raw: { label: r.body.label } };
    } catch (e) {
      return { success: false, balance: 0, currency: 'IDR', message: e.message };
    }
  }

  async getProducts() {
    try {
      const r = await this._req('GET', '/products', null, 25000);
      if (!r.ok) return { success: false, products: [], message: r.body?.message || r.body?.error || `HTTP ${r.status}` };
      const list = Array.isArray(r.body?.data) ? r.body.data : [];
      const products = [];
      for (const p of list) {
        for (const d of (p.product_durations || [])) {
          products.push({
            providerProductId: encodeId(p.id, d.id),
            name: `${p.name} - ${d.label}`,
            category: p.category || '',
            costPrice: Number(d.price || 0),   // harga efektif akun partner (tier/custom sudah dihitung heroitbest)
            stock: null,                       // heroitbest tidak melaporkan stok -> dianggap tersedia
            status: p.active === false ? 'inactive' : 'active',
            raw: { productId: p.id, durationId: d.id, days: d.days, basePrice: d.base_price },
          });
        }
      }
      return { success: true, products };
    } catch (e) {
      return { success: false, products: [], message: e.message };
    }
  }

  async createOrder(order) {
    const ids = decodeId(order?.providerProductId);
    if (!ids) return { success: false, providerOrderId: null, status: 'failed', message: CUSTOMER_MESSAGES.invalid_product_or_duration };
    try {
      // idempotencyKey = nomor transaksi toko -> aman kalau request diulang.
      const idem = order.customerRef ? `heromarket:${order.customerRef}` : `heromarket:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      const r = await this._req('POST', '/generate-key', { ...ids, idempotencyKey: idem.slice(0, 128) }, 28000);
      const keyString = r.body?.key?.key_string;
      if (r.ok && keyString) {
        return { success: true, providerOrderId: String(r.body.key.id || idem), status: 'success', deliveryKey: String(keyString), raw: { keyId: r.body.key.id } };
      }
      const code = r.body?.error || `http_${r.status}`;
      return {
        success: false, providerOrderId: null, status: 'failed', code,
        // Pesan aman untuk pembeli; detail asli ada di raw (tercatat di Log API admin).
        message: CUSTOMER_MESSAGES[code] || 'Gagal memproses pesanan. Silakan hubungi admin.',
        raw: { status: r.status, body: r.body },
      };
    } catch (e) {
      // Timeout/jaringan: key MUNGKIN sudah terbit di heroitbest -> jangan retry otomatis.
      return { success: false, providerOrderId: null, status: 'failed', code: 'network', message: 'Koneksi ke supplier terputus. Hubungi admin sebelum mencoba lagi agar tidak terpotong dua kali.', raw: { error: e.message } };
    }
  }

  // heroitbest mengirim key langsung saat generate -> tidak ada order async.
  async getOrderStatus() {
    return { success: false, status: 'pending', message: 'HEROITBEST mengirim key langsung; tidak ada cek status.' };
  }

  async handleWebhook() {
    return { success: false, valid: false, message: 'HEROITBEST tidak memakai webhook.' };
  }
}

module.exports = HeroitbestAdapter;
module.exports._test = { encodeId, decodeId };
