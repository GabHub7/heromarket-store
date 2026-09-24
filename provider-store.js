/**
 * PROVIDER STORE
 * ===============
 * CRUD untuk konfigurasi provider reseller (multi-provider) + log API.
 * Disimpan terpisah dari settings.json supaya tidak bentrok dengan sistem
 * single-provider (vipibmstore.com) yang sudah ada di reseller-api.js.
 *
 * File yang dipakai:
 *  - providers.json     : array konfigurasi tiap provider yang ditambahkan admin
 *  - provider-logs.json : log tiap pemanggilan API ke provider (dibatasi jumlahnya)
 */

const { readDB, writeDB } = require('./supabase');
const { v4: uuidv4 } = require('uuid');
const { listAdapters, createAdapterInstance } = require('./providers');

const MAX_LOGS = 500; // cap log biar file tidak membengkak

// ── Provider CRUD ──────────────────────────────────────────────────

function getProviders() {
  const list = readDB('providers.json');
  return Array.isArray(list) ? list : [];
}

function getProvider(providerInstanceId) {
  return getProviders().find(p => p.id === providerInstanceId) || null;
}

async function addProvider({ adapterId, name, config }) {
  const adapters = listAdapters();
  const adapterMeta = adapters.find(a => a.id === adapterId);
  if (!adapterMeta) throw new Error(`Adapter '${adapterId}' tidak dikenal`);

  const providers = getProviders();
  const record = {
    id: uuidv4(),
    adapterId,
    name: name || adapterMeta.label,
    config: config || {},
    active: true,
    autoSync: false,
    autoSyncIntervalMinutes: 60,
    lastSyncAt: null,
    lastSyncStatus: null, // 'success' | 'failed'
    lastSyncMessage: null,
    createdAt: new Date().toISOString(),
  };
  providers.push(record);
  await writeDB('providers.json', providers);
  return record;
}

async function updateProvider(providerInstanceId, patch) {
  const providers = getProviders();
  const idx = providers.findIndex(p => p.id === providerInstanceId);
  if (idx === -1) throw new Error('Provider tidak ditemukan');
  providers[idx] = { ...providers[idx], ...patch, config: { ...providers[idx].config, ...(patch.config || {}) } };
  await writeDB('providers.json', providers);
  return providers[idx];
}

async function deleteProvider(providerInstanceId) {
  const providers = getProviders();
  const next = providers.filter(p => p.id !== providerInstanceId);
  await writeDB('providers.json', next);
  return next.length !== providers.length;
}

// Bikin instance adapter siap-pakai dari provider instance yang tersimpan.
function getAdapterInstance(providerInstanceId) {
  const provider = getProvider(providerInstanceId);
  if (!provider) return null;
  return createAdapterInstance(provider.adapterId, provider.config);
}

// ── Log API ────────────────────────────────────────────────────────

async function logApiCall({ providerInstanceId, providerLabel, action, request, response, success, durationMs }) {
  const logs = readDB('provider-logs.json');
  const list = Array.isArray(logs) ? logs : [];
  list.unshift({
    id: uuidv4(),
    providerInstanceId,
    providerLabel,
    action,
    request: safeTrim(request),
    response: safeTrim(response),
    success: !!success,
    durationMs: durationMs || null,
    at: new Date().toISOString(),
  });
  const trimmed = list.slice(0, MAX_LOGS);
  await writeDB('provider-logs.json', trimmed);
}

function getLogs({ providerInstanceId, limit = 100 } = {}) {
  const logs = readDB('provider-logs.json');
  let list = Array.isArray(logs) ? logs : [];
  if (providerInstanceId) list = list.filter(l => l.providerInstanceId === providerInstanceId);
  return list.slice(0, limit);
}

// Potong payload besar sebelum disimpan sebagai log biar file tidak bengkak.
// Potong payload besar sebelum disimpan sebagai log biar file tidak bengkak.
// BUG FIX: implementasi lama coba JSON.parse(string_yang_dipotong_di_tengah)
// untuk truncate -- itu HAMPIR SELALU invalid JSON (kurung belum ketutup),
// jadi selalu masuk catch block dan berakhir jadi String(obj) yang untuk
// sebuah object JS hasilnya cuma literal "[object Object]" -- log jadi tidak
// berguna sama sekali untuk debugging (persis yang terjadi di getProducts
// dengan 122 produk, responsnya pasti > 3000 karakter). Sekarang truncate
// dilakukan di level STRING JSON-nya langsung (bukan coba re-parse jadi
// objek), dan hasilnya tetap disimpan sebagai STRING bertanda terpotong,
// bukan dipaksa jadi objek lagi.
function safeTrim(obj) {
  try {
    const str = JSON.stringify(obj);
    if (str === undefined) return null; // obj adalah undefined -- JSON.stringify(undefined) = undefined
    if (str.length <= 3000) return obj; // muat penuh, simpan objek aslinya apa adanya
    // Terlalu panjang -- simpan sebagai STRING terpotong + penanda jelas,
    // BUKAN dipaksa parse balik jadi objek (itu yang menyebabkan bug lama).
    return str.slice(0, 3000) + ' …(dipotong, total ' + str.length + ' karakter)';
  } catch {
    // obj tidak bisa di-JSON.stringify sama sekali (circular reference dll)
    return String(obj).slice(0, 3000);
  }
}

// Wrapper: jalankan method adapter + otomatis catat log-nya.
async function callAdapter(providerInstanceId, methodName, ...args) {
  const start = Date.now();
  const provider = getProvider(providerInstanceId);
  if (!provider) {
    // FIX: dulu langsung throw di sini -- kalau produk masih nyimpen mapping
    // ke provider yang SUDAH DIHAPUS admin, order akan gagal TANPA jejak log
    // sama sekali (persis salah satu gejala silent failure yang dilaporkan).
    // Sekarang tetap dicatat sebagai log gagal sebelum melempar hasilnya.
    const result = { success: false, message: 'Provider tidak ditemukan (mungkin sudah dihapus dari pengaturan).' };
    await logApiCall({
      providerInstanceId, providerLabel: 'unknown', action: methodName,
      request: args.length ? args[0] : undefined, response: result,
      success: false, durationMs: Date.now() - start,
    });
    return result;
  }
  const adapter = createAdapterInstance(provider.adapterId, provider.config);
  if (!adapter || typeof adapter[methodName] !== 'function') {
    const result = { success: false, message: `Method '${methodName}' tidak tersedia di adapter '${provider.adapterId}'.` };
    await logApiCall({
      providerInstanceId, providerLabel: provider.name, action: methodName,
      request: args.length ? args[0] : undefined, response: result,
      success: false, durationMs: Date.now() - start,
    });
    return result;
  }
  let result;
  try {
    result = await adapter[methodName](...args);
  } catch (e) {
    result = { success: false, message: e.message };
  }
  await logApiCall({
    providerInstanceId,
    providerLabel: provider.name,
    action: methodName,
    request: args.length ? args[0] : undefined,
    response: result,
    success: !!result?.success,
    durationMs: Date.now() - start,
  });
  return result;
}

module.exports = {
  getProviders,
  getProvider,
  addProvider,
  updateProvider,
  deleteProvider,
  getAdapterInstance,
  logApiCall,
  getLogs,
  callAdapter,
};
