// Supabase integration — drop-in replacement untuk jsonbin.js
// Interface identik: readDB(filename) dan writeDB(filename, data)

const fs = require('fs');
const path = require('path');

let supabase = null;
let dbCache = {};
const DB_FILES = ['users.json','products.json','transactions.json','testimonials.json','notifications.json','settings.json','keyspool.json','vouchers.json'];

// Lazy init Supabase client
const getClient = () => {
  if (supabase) return supabase;
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(url, key, {
      auth: { persistSession: false }
    });
    return supabase;
  } catch (e) {
    console.error('[supabase] createClient error:', e.message);
    return null;
  }
};

// Local /tmp backup agar ada fallback saat Supabase lambat
const isVercel = process.env.VERCEL === '1' || !!process.env.NOW_REGION;
const localDbPath = isVercel ? '/tmp/database' : path.join(__dirname, 'database');
if (!fs.existsSync(localDbPath)) { try { fs.mkdirSync(localDbPath, { recursive: true }); } catch {} }

const writeLocalBackup = (filename, data) => {
  try { fs.writeFileSync(path.join(localDbPath, filename), JSON.stringify(data)); } catch {}
};

const readLocalBackup = (filename) => {
  try {
    const p = path.join(localDbPath, filename);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return null; }
};

// ── PUBLIC API ──────────────────────────────────────────────

// TTL tracking: catat kapan terakhir cache di-sync dari Supabase
const cacheTimestamp = {}; // filename -> timestamp ms
const CACHE_TTL = 8000;    // 8 detik — cukup cepat untuk konsistensi

const readDB = (filename) => {
  return dbCache[filename] !== undefined
    ? dbCache[filename]
    : (filename === 'settings.json' ? {} : []);
};

// readSmart: pakai cache jika masih segar (<TTL), else fetch Supabase
// Untuk GET endpoints yang butuh konsistensi antar instance Vercel
const readSmart = async (filename) => {
  const now = Date.now();
  const age = now - (cacheTimestamp[filename] || 0);
  if (age < CACHE_TTL) return readDB(filename); // cache masih fresh
  return readFresh(filename);                    // stale → ambil dari Supabase
};

const writeDB = async (filename, data) => {
  dbCache[filename] = data;
  cacheTimestamp[filename] = Date.now(); // mark fresh setelah write
  writeLocalBackup(filename, data);
  const client = getClient();
  if (!client) return;
  try {
    const { error } = await client
      .from('keyvalue_store')
      .upsert({ key: filename, value: data }, { onConflict: 'key' });
    if (error) console.error(`[supabase] writeDB ${filename}:`, error.message);
  } catch (e) {
    console.error(`[supabase] writeDB ${filename} exception:`, e.message);
  }
};

const initializeDB = async () => {
  console.log('📦 Initializing database (Supabase)...');

  // 1. Load local backup ke cache sebagai baseline
  for (const f of DB_FILES) {
    const local = readLocalBackup(f);
    if (local !== null) dbCache[f] = local;
    else dbCache[f] = f === 'settings.json' ? {} : [];
  }

  const client = getClient();
  if (!client) {
    console.warn('⚠️  SUPABASE_URL / SUPABASE_ANON_KEY belum di-set. Pakai local fallback.');
    return;
  }

  // 2. Load dari Supabase (source of truth)
  try {
    const { data, error } = await client
      .from('keyvalue_store')
      .select('key, value');
    if (error) throw new Error(error.message);
    if (data && data.length > 0) {
      data.forEach(row => {
        dbCache[row.key] = row.value;
        writeLocalBackup(row.key, row.value);
      });
      console.log(`✅ Database connected to Supabase (${data.length} collections loaded)`);
    } else {
      console.log('📝 Supabase table kosong, seeding...');
      await seedSupabase(client);
      console.log('✅ Supabase seeded');
    }
  } catch (e) {
    const msg = e.message || '';
    // Table belum dibuat — coba buat otomatis via SQL langsung
    if (msg.includes('relation') || msg.includes('does not exist') || msg.includes('42P01')) {
      console.warn('⚠️  Tabel keyvalue_store belum ada. Mencoba buat otomatis...');
      try {
        await ensureTableExists();
        // Coba load ulang
        const { data: d2 } = await client.from('keyvalue_store').select('key, value');
        if (d2 && d2.length > 0) {
          d2.forEach(row => { dbCache[row.key] = row.value; writeLocalBackup(row.key, row.value); });
          console.log(`✅ Loaded ${d2.length} collections after table creation`);
        } else {
          await seedSupabase(client);
        }
        return;
      } catch (e2) {
        console.error('❌ Gagal buat tabel otomatis. JALANKAN SQL SCHEMA DI SUPABASE DASHBOARD!');
        console.error('   https://supabase.com/dashboard/project/' + (process.env.SUPABASE_URL || '').split('.')[0].replace('https://', '') + '/sql/new');
      }
    }
    console.warn('⚠️  Supabase error, pakai local cache:', msg);
  }
};

// Coba buat tabel otomatis via direct PostgreSQL
const ensureTableExists = async () => {
  const url = process.env.SUPABASE_URL || '';
  const pw = process.env.SUPABASE_DB_PASSWORD;
  if (!pw) throw new Error('SUPABASE_DB_PASSWORD belum di-set');
  const ref = url.replace('https://', '').split('.')[0];
  const fs = require('fs');
  const { Pool } = require('pg');
  const pool = new Pool({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: pw,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, 'supabase-schema.sql'), 'utf-8'));
    console.log('✅ Tabel keyvalue_store berhasil dibuat');
  } finally {
    await pool.end();
  }
};

const seedSupabase = async (client) => {
  const rows = DB_FILES.map(f => ({ key: f, value: dbCache[f] || (f === 'settings.json' ? {} : []) }));
  const { error } = await client
    .from('keyvalue_store')
    .upsert(rows, { onConflict: 'key', ignoreDuplicates: true });
  if (error) console.error('[supabase] seed error:', error.message);
};


// ── UPLOAD IMAGE ke Supabase Storage ─────────────────────
const uploadImage = async (fileBuffer, filename, contentType) => {
  const client = getClient();
  if (!client) throw new Error('Supabase tidak terkonfigurasi');

  const cleanName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const { data, error } = await client.storage
    .from('product-images')
    .upload(cleanName, fileBuffer, {
      contentType,
      upsert: false
    });

  if (error) throw new Error('Gagal upload: ' + error.message);

  const { data: { publicUrl } } = client.storage
    .from('product-images')
    .getPublicUrl(cleanName);

  return publicUrl;
};

// Status untuk admin endpoint
const getDbStatus = async () => {
  const hasUrl = !!process.env.SUPABASE_URL;
  const hasKey = !!process.env.SUPABASE_ANON_KEY;
  const hasDbPw = !!process.env.SUPABASE_DB_PASSWORD;
  const client = getClient();
  let connected = false, tableExists = false, errorMsg = null;
  if (client) {
    try {
      const { error } = await client.from('keyvalue_store').select('key', { count: 'exact', head: true }).limit(1);
      if (error) {
        errorMsg = error.message;
        if (error.message.includes('relation') || error.message.includes('does not exist')) {
          tableExists = false;
        }
      } else {
        connected = true;
        tableExists = true;
      }
    } catch (e) {
      errorMsg = e.message;
      connected = false;
    }
  }
  const projectRef = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace('https://', '').split('.')[0] : null;
  return {
    driver: 'supabase',
    connected,
    tableExists,
    errorMsg,
    hasUrl,
    hasKey,
    hasDbPw,
    projectRef,
    sqlEditorUrl: projectRef ? `https://supabase.com/dashboard/project/${projectRef}/sql/new` : null,
    canAutoCreate: hasDbPw && projectRef
  };
};

// Baca langsung dari Supabase (bypass cache) — untuk operasi kritis
// yang butuh data paling fresh, misal admin concurrent write
const readFresh = async (filename) => {
  const client = getClient();
  if (!client) return readDB(filename); // fallback ke cache jika offline
  try {
    const { data, error } = await client
      .from('keyvalue_store')
      .select('value')
      .eq('key', filename)
      .single();
    if (!error && data?.value !== undefined) {
      dbCache[filename] = data.value;
      cacheTimestamp[filename] = Date.now(); // mark fresh
      writeLocalBackup(filename, data.value);
      return data.value;
    }
  } catch {}
  return readDB(filename);
};

// Re-fetch satu file dari Supabase ke cache — backward compat
const refreshFromDB = async (filename) => {
  const client = getClient();
  if (!client) return;
  try {
    const { data, error } = await client
      .from('keyvalue_store')
      .select('value')
      .eq('key', filename)
      .single();
    if (!error && data?.value !== undefined) {
      dbCache[filename] = data.value;
      cacheTimestamp[filename] = Date.now();
      writeLocalBackup(filename, data.value);
    }
  } catch {}
};

module.exports = { readDB, writeDB, initializeDB, getDbStatus, uploadImage, refreshFromDB, readFresh, readSmart };
