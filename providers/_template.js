const BaseProviderAdapter = require('./base');

/**
 * TEMPLATE ADAPTER PROVIDER
 * ==========================
 * Cara pakai:
 *   1. Copy file ini -> providers/nama-provider-kamu.js
 *   2. Ganti class name & static id/label
 *   3. Isi tiap method sesuai dokumentasi API provider tsb
 *   4. Daftarkan di providers/index.js
 *
 * Lihat providers/base.js untuk penjelasan lengkap tiap method &
 * providers/cheatgame.js untuk contoh implementasi nyata.
 */
class TemplateAdapter extends BaseProviderAdapter {
  static get id() { return 'template'; } // slug unik, huruf kecil, tanpa spasi
  static get label() { return 'Nama Provider'; } // nama tampilan di admin panel

  static get configFields() {
    return [
      { key: 'apiKey', label: 'API Key', type: 'password', required: true },
      { key: 'baseUrl', label: 'Base URL', type: 'url', required: true },
      // Tambah field spesifik provider di sini kalau perlu, misal:
      // { key: 'merchantId', label: 'Merchant ID', type: 'text', required: true },
    ];
  }

  async testConnection() {
    // TODO: panggil endpoint paling ringan (biasanya getBalance) untuk
    // memastikan API Key valid & base URL benar.
    return { success: false, message: 'Adapter ini belum diimplementasikan' };
  }

  async getBalance() {
    return { success: false, balance: 0, currency: 'IDR', message: 'Belum diimplementasikan' };
  }

  async getProducts() {
    return { success: false, products: [], message: 'Belum diimplementasikan' };
  }

  async getExchangeRate() {
    return { success: true, rate: 1, from: 'IDR', to: 'IDR' };
  }

  async createOrder(order) {
    return { success: false, providerOrderId: null, status: 'failed', message: 'Belum diimplementasikan' };
  }

  async getOrderStatus(providerOrderId) {
    return { success: false, status: 'failed', message: 'Belum diimplementasikan' };
  }

  async handleWebhook(req) {
    return { success: false, valid: false, message: 'Belum diimplementasikan' };
  }
}

module.exports = TemplateAdapter;
