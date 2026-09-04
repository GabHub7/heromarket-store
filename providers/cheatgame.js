const crypto = require('crypto');
const BaseProviderAdapter = require('./base');

/**
 * ADAPTER: CHEATGAME.ONLINE
 * ==========================
 * Berdasarkan Developer Console > Reseller API Key milik cheatgame.online
 * (screenshot developer console, per 1 Agt 2026) + spesifikasi yang
 * diberikan langsung oleh pemilik toko. Auth: header X-API-Key di semua
 * request. Endpoint tunggal `reseller_api.php`, dibedakan lewat `action`.
 *
 * CATATAN PENTING (baca sebelum deploy production):
 *  - Bentuk response body (nama field persis di dalam JSON hasil
 *    products/balance/order/order_status) BELUM dikonfirmasi dengan
 *    contoh JSON asli dari cheatgame.online. Kode di bawah menerka
 *    beberapa nama field yang paling umum dipakai reseller API sejenis,
 *    dengan fallback berlapis (lihat komentar "// CEK SAAT TESTING").
 *  - Setelah API Key asli didapat, jalankan Test Connection dari admin
 *    panel lalu cek tab "Log API" untuk lihat response mentahnya. Kalau
 *    field yang dipakai adapter ini meleset dari response asli, cukup
 *    sesuaikan baris yang ditandai di bawah -- struktur lain tidak perlu
 *    diubah.
 */
class CheatgameAdapter extends BaseProviderAdapter {
  static get id() { return 'cheatgame'; }
  static get label() { return 'CHEATGAME.ONLINE'; }

  static get configFields() {
    return [
      { key: 'apiKey', label: 'API Key (X-API-Key)', type: 'password', required: true },
      { key: 'webhookSecret', label: 'Webhook Secret', type: 'password', required: false },
      { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, default: 'https://cheatgame.online/reseller_api.php' },
    ];
  }

  get baseUrl() {
    return (this.config.baseUrl || 'https://cheatgame.online/reseller_api.php').replace(/\/$/, '');
  }

  _headers(extra = {}) {
    return {
      'X-API-Key': this.config.apiKey || '',
      ...extra,
    };
  }

  async _get(action, params = {}) {
    const qs = new URLSearchParams({ action, ...params }).toString();
    const url = `${this.baseUrl}?${qs}`;
    const res = await fetch(url, { method: 'GET', headers: this._headers() });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { httpOk: res.ok, status: res.status, body: json };
  }

  async _post(body) {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { httpOk: res.ok, status: res.status, body: json };
  }

  // ── Test Connection ──────────────────────────────────────────────
  async testConnection() {
    try {
      const { httpOk, status, body } = await this._get('balance');
      if (!httpOk) {
        return { success: false, message: `HTTP ${status}: ${body?.message || body?.error || 'Koneksi/API Key gagal'}` };
      }
      // CEK SAAT TESTING: field sukses eksplisit belum dikonfirmasi.
      // Anggap sukses selama request tidak error & tidak ada flag error.
      if (body?.success === false || body?.error) {
        return { success: false, message: body.message || body.error || 'API menolak request' };
      }
      return { success: true, message: 'Koneksi ke CHEATGAME berhasil' };
    } catch (e) {
      return { success: false, message: `Gagal konek: ${e.message}` };
    }
  }

  // ── Get Balance ───────────────────────────────────────────────────
  async getBalance() {
    try {
      const { httpOk, body } = await this._get('balance');
      if (!httpOk || body?.success === false) {
        return { success: false, balance: 0, currency: 'USD', message: body?.message || 'Gagal ambil saldo' };
      }
      // CEK SAAT TESTING: nama field saldo & currency belum dikonfirmasi.
      const balance = Number(body.balance ?? body.data?.balance ?? 0);
      const currency = body.currency ?? body.data?.currency ?? 'USD';
      return { success: true, balance, currency, raw: body };
    } catch (e) {
      return { success: false, balance: 0, currency: 'USD', message: e.message };
    }
  }

  // ── Get Products ──────────────────────────────────────────────────
  async getProducts() {
    try {
      const { httpOk, body } = await this._get('products');
      if (!httpOk || body?.success === false) {
        return { success: false, products: [], message: body?.message || 'Gagal ambil produk' };
      }
      // CEK SAAT TESTING: struktur response cheatgame.online ternyata
      // tidak selalu array polos di body.data/body.products -- bisa juga
      // nested (mis. body.data.products) atau bentuk lain. Kode di bawah
      // coba beberapa kemungkinan path secara berurutan, dan SELALU
      // validasi Array.isArray sebelum .map() supaya tidak crash lagi
      // seperti sebelumnya ("list.map is not a function").
      const candidates = [
        body.data,
        body.products,
        body.data?.products,
        body.data?.data,
        body.result,
        body,
      ];
      const list = candidates.find(c => Array.isArray(c)) || [];

      if (!list.length) {
        // Tidak ada array produk yang ketemu di struktur manapun -- kirim
        // balik raw body di message supaya kelihatan jelas di Log API,
        // bukan gagal diam-diam.
        return {
          success: false,
          products: [],
          message: `Struktur response tidak dikenali. Raw: ${JSON.stringify(body).slice(0, 500)}`,
        };
      }

      const products = list.map(item => {
        const priceUsd = Number(item.price_usd ?? item.price ?? 0);
        const priceIdr = item.price_idr !== undefined && item.price_idr !== null
          ? Number(item.price_idr)
          : null; // null saat exchange_rate provider unavailable (sesuai dok)
        // Field brand dikonfirmasi langsung oleh pihak CHEATGAME (chat 3 Agt
        // 2026): product.brand = nama game/kategori asli, product.name =
        // nama paket saja (mis. "KEY 7 DAY"). Beberapa produk punya name
        // yang SAMA tapi brand BEDA -- brand WAJIB diambil & ditampilkan
        // supaya tidak tertukar, bukan cuma name doang seperti sebelumnya.
        const brand = item.brand ?? '';
        const rawName = item.name ?? item.title ?? 'Produk tanpa nama';
        return {
          providerProductId: String(item.id ?? item.product_id ?? ''),
          name: brand ? `${brand} - ${rawName}` : rawName, // format sesuai contoh CHEATGAME: "VANTIX - KEY 7 DAY"
          category: brand, // dipakai juga sebagai kategori tampilan
          costPrice: priceIdr !== null ? priceIdr : priceUsd, // fallback ke USD kalau IDR belum tersedia
          costPriceUsd: priceUsd,
          costPriceIdr: priceIdr,
          stock: item.stock !== undefined ? Number(item.stock) : null,
          status: (item.status ?? 'active') === 'active' ? 'active' : 'inactive',
          raw: item,
        };
      });
      return {
        success: true,
        products,
        exchangeRate: body.exchange_rate || null, // { rate, status, updated_at, ... } sesuai dok
      };
    } catch (e) {
      return { success: false, products: [], message: e.message };
    }
  }

  // ── Exchange Rate ─────────────────────────────────────────────────
  async getExchangeRate() {
    try {
      const { httpOk, body } = await this._get('exchange_rate');
      if (!httpOk) {
        return { success: false, rate: null, from: 'USDT', to: 'IDR', message: 'Gagal ambil kurs' };
      }
      // Field sesuai dokumentasi resmi yang diberikan: rate, rate_field,
      // source, status (live/cached/stale_cache/unavailable).
      return {
        success: body.status !== 'unavailable',
        rate: body.rate ?? null,
        rateField: body.rate_field ?? 'sell',
        source: body.source ?? 'indodax.usdtidr',
        status: body.status ?? 'unavailable',
        from: 'USDT',
        to: 'IDR',
      };
    } catch (e) {
      return { success: false, rate: null, from: 'USDT', to: 'IDR', message: e.message };
    }
  }

  // ── Create Order ──────────────────────────────────────────────────
  async createOrder(order) {
    try {
      const payload = {
        action: 'order',
        external_ref: order.customerRef,
        product_id: Number(order.providerProductId),
        quantity: order.quantity || 1,
        customer_name: order.params?.customerName || 'Customer Store',
        customer_email: order.params?.customerEmail || 'noreply@heromarket.com',
      };
      const { httpOk, body } = await this._post(payload);
      if (!httpOk || body?.success === false || body?.error) {
        return { success: false, providerOrderId: null, status: 'failed', message: body?.message || body?.error || 'Order ditolak provider', raw: body };
      }
      // FIX (dikonfirmasi dari raw JSON asli CGO, 11 Agt 2026): order_id &
      // status ada di dalam body.data, BUKAN di root body. Key/link
      // pengiriman ada di body.data.delivery[0] (array!) -- field ini dulu
      // TIDAK PERNAH diambil sama sekali di createOrder, sehingga transaksi
      // yang sebenarnya SUKSES di sisi CGO (saldo terpotong, key ready)
      // tetap gagal di HeroMarket karena key-nya tidak pernah terbaca.
      // Optional chaining dipakai di semua level supaya tidak crash kalau
      // provider lain/versi API lain kirim struktur tanpa delivery.
      const providerOrderId = body.data?.order_id ?? body.order_id ?? null;
      const status = this._normalizeStatus(body.data?.status ?? body.status ?? 'pending');
      const delivery = body.data?.delivery?.[0];
      const deliveryKey = delivery?.key ?? null;
      const deliveryLink = delivery?.download_url ?? null;
      return { success: true, providerOrderId, status, deliveryKey, deliveryLink, raw: body };
    } catch (e) {
      return { success: false, providerOrderId: null, status: 'failed', message: e.message };
    }
  }

  // ── Order Status ──────────────────────────────────────────────────
  async getOrderStatus(providerOrderId) {
    try {
      const { httpOk, body } = await this._get('order_status', { order_id: providerOrderId });
      if (!httpOk || body?.success === false) {
        return { success: false, status: 'failed', message: body?.message || 'Gagal cek status order' };
      }
      // FIX (sama seperti createOrder): status & delivery ada di dalam
      // body.data, key/link ada di body.data.delivery[0] (array), bukan
      // field flat di root/body.data langsung.
      const status = this._normalizeStatus(body.data?.status ?? body.status);
      const delivery = body.data?.delivery?.[0];
      const deliveryKey = delivery?.key ?? null;
      const deliveryLink = delivery?.download_url ?? null;
      return { success: true, status, deliveryKey, deliveryLink, raw: body };
    } catch (e) {
      return { success: false, status: 'failed', message: e.message };
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────
  // CHEATGAME kirim POST saat order.success. Signature WAJIB diverifikasi
  // pakai raw body (bukan body yang sudah di-parse ulang jadi JSON), jadi
  // pemanggil (server.js) HARUS menyediakan req.rawBody string persis
  // seperti yang diterima dari network.
  async handleWebhook(req) {
    const secret = this.config.webhookSecret;
    if (!secret) {
      return { success: false, valid: false, message: 'Webhook secret belum diset di config provider' };
    }

    const event = req.headers['x-cgo-event'];
    const eventId = req.headers['x-cgo-event-id'];
    const timestamp = req.headers['x-cgo-timestamp'];
    const signatureHeader = req.headers['x-cgo-signature'] || '';
    const rawBody = req.rawBodyForSignature || JSON.stringify(req.body || {});

    if (!event || !eventId || !timestamp || !signatureHeader) {
      return { success: false, valid: false, message: 'Header webhook tidak lengkap' };
    }

    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${eventId}.${rawBody}`)
      .digest('hex');

    // Bandingkan pakai timing-safe compare untuk cegah timing attack.
    const sigBuf = Buffer.from(signatureHeader);
    const expBuf = Buffer.from(expected);
    const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

    if (!valid) {
      return { success: false, valid: false, message: 'Signature tidak cocok' };
    }

    if (event !== 'order.success') {
      // Event lain (kalau ada di masa depan) -- diterima tapi tidak diproses.
      return { success: true, valid: true, eventId, message: `Event '${event}' diterima tapi tidak diproses` };
    }

    const data = req.body?.data || req.body || {};
    return {
      success: true,
      valid: true,
      eventId,
      providerOrderId: data.order_id ?? null,
      status: 'success',
      deliveryKey: data.key ?? data.license_key ?? null,
      deliveryLink: data.download_link ?? data.link ?? null,
      raw: req.body,
    };
  }

  _normalizeStatus(raw) {
    const s = String(raw || '').toLowerCase();
    if (['success', 'completed', 'done', 'paid'].includes(s)) return 'success';
    if (['failed', 'error', 'cancelled', 'canceled'].includes(s)) return 'failed';
    if (['processing', 'in_progress'].includes(s)) return 'processing';
    return 'pending';
  }
}

module.exports = CheatgameAdapter;
