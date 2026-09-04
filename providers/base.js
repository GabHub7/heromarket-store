/**
 * BASE PROVIDER ADAPTER
 * ======================
 * Kontrak generic yang WAJIB diikuti setiap adapter provider reseller API.
 * Tujuannya: sistem inti (provider-registry.js) tidak perlu tahu detail
 * auth/format tiap provider — cukup panggil method standar di sini.
 *
 * Cara tambah provider baru TANPA ubah sistem inti:
 *   1. Copy providers/_template.js -> providers/nama-provider.js
 *   2. Isi implementasi tiap method sesuai dokumentasi API provider tsb
 *   3. Daftarkan di providers/index.js (satu baris require + push)
 *   4. Selesai — admin bisa langsung pilih provider ini dari panel admin
 *
 * Semua method di bawah HARUS async dan HARUS mengembalikan bentuk data
 * yang sudah dinormalisasi (lihat komentar tiap method), supaya kode di
 * server.js tidak perlu tahu "provider ini butuh field apa saja".
 */

class BaseProviderAdapter {
  /**
   * @param {object} config - { apiKey, apiSecret, baseUrl, extra }
   *   extra: object bebas untuk field spesifik provider (mis. merchantId)
   */
  constructor(config = {}) {
    if (new.target === BaseProviderAdapter) {
      throw new Error('BaseProviderAdapter adalah kelas abstrak, jangan diinstansiasi langsung.');
    }
    this.config = config;
  }

  // Identitas provider — WAJIB di-override oleh tiap adapter.
  static get id() { throw new Error('Provider adapter harus punya static id (slug unik, mis. "cheatgame")'); }
  static get label() { throw new Error('Provider adapter harus punya static label (nama tampilan)'); }

  // Field konfigurasi yang dibutuhkan adapter ini, dipakai untuk render
  // form "Tambah Provider" di admin panel secara otomatis (generic).
  // Format: [{ key, label, type: 'text'|'password'|'url', required }]
  static get configFields() {
    return [
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      { key: 'baseUrl', label: 'Base URL', type: 'url', required: true },
    ];
  }

  /**
   * Test koneksi & validitas kredensial.
   * @returns {Promise<{success:boolean, message:string}>}
   */
  async testConnection() {
    throw new Error('testConnection() belum diimplementasikan');
  }

  /**
   * Ambil saldo akun reseller di provider ini.
   * @returns {Promise<{success:boolean, balance:number, currency:string, message?:string}>}
   */
  async getBalance() {
    throw new Error('getBalance() belum diimplementasikan');
  }

  /**
   * Ambil daftar produk dari provider, dinormalisasi ke bentuk standar.
   * @returns {Promise<{success:boolean, products:Array<NormalizedProduct>, message?:string}>}
   *
   * NormalizedProduct:
   *  {
   *    providerProductId: string,   // ID asli di sisi provider
   *    name: string,
   *    category: string,
   *    costPrice: number,           // harga modal dari provider
   *    stock: number|null,          // null = unlimited/tidak dilaporkan
   *    status: 'active'|'inactive',
   *    raw: object                  // payload asli (untuk debug/log)
   *  }
   */
  async getProducts() {
    throw new Error('getProducts() belum diimplementasikan');
  }

  /**
   * Ambil exchange rate / kurs jika provider pakai mata uang asing.
   * @returns {Promise<{success:boolean, rate:number, from:string, to:string, message?:string}>}
   */
  async getExchangeRate() {
    return { success: true, rate: 1, from: 'IDR', to: 'IDR' };
  }

  /**
   * Buat order baru di provider.
   * @param {object} order - { providerProductId, quantity, customerRef, params }
   * @returns {Promise<{success:boolean, providerOrderId:string, status:string, message?:string, raw?:object}>}
   */
  async createOrder(order) {
    throw new Error('createOrder() belum diimplementasikan');
  }

  /**
   * Cek status order yang sudah dibuat.
   * @param {string} providerOrderId
   * @returns {Promise<{success:boolean, status:'pending'|'processing'|'success'|'failed', deliveryKey?:string, deliveryLink?:string, message?:string}>}
   */
  async getOrderStatus(providerOrderId) {
    throw new Error('getOrderStatus() belum diimplementasikan');
  }

  /**
   * Verifikasi & parse payload webhook dari provider (dipanggil dari route
   * webhook generic di server.js). Adapter yang tahu cara verifikasi
   * signature/format spesifik provider ini.
   * @param {object} req - Express request (headers, body, rawBody kalau ada)
   * @returns {Promise<{success:boolean, valid:boolean, providerOrderId?:string, status?:string, deliveryKey?:string, deliveryLink?:string, message?:string}>}
   */
  async handleWebhook(req) {
    throw new Error('handleWebhook() belum diimplementasikan');
  }
}

module.exports = BaseProviderAdapter;
