/**
 * PROVIDER REGISTRY
 * ==================
 * Satu-satunya tempat yang perlu diedit untuk MENDAFTARKAN adapter baru.
 * Tidak perlu ubah server.js atau provider-store.js sama sekali.
 *
 * Cara tambah provider baru:
 *   1. Buat file providers/nama-provider.js (copy dari _template.js)
 *   2. require() di sini dan push ke array ADAPTERS
 */

const CheatgameAdapter = require('./cheatgame');

const ADAPTERS = [
  CheatgameAdapter,
  // TemplateAdapter, // <- contoh: tinggal require + push kalau sudah diisi
];

const registry = new Map(ADAPTERS.map(A => [A.id, A]));

function listAdapters() {
  return ADAPTERS.map(A => ({ id: A.id, label: A.label, configFields: A.configFields }));
}

function getAdapterClass(providerId) {
  return registry.get(providerId) || null;
}

function createAdapterInstance(providerId, config) {
  const AdapterClass = getAdapterClass(providerId);
  if (!AdapterClass) return null;
  return new AdapterClass(config);
}

module.exports = { listAdapters, getAdapterClass, createAdapterInstance };
