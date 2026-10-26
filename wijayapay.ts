import "server-only";
import crypto from "crypto";
import { createAdminSupabase } from "@/lib/supabase/admin";

// ══════════════════════════════════════════════════════════════════
// WijayaPay (gateway.wijayapay.com) -- QRIS untuk top up saldo
//   Create    : POST /api/transaction/create  (form-urlencoded: code_merchant, api_key, ref_id, code_payment, nominal)
//               header  X-Signature: md5(code_merchant + api_key + ref_id)
//   Status    : GET  /api/get-status?code_merchant&api_key&ref_id  -> { data, status_pembayaran: pending|paid|expired }
//   Webhook   : POST/GET { data:{ref_id,total_dibayar,amount_received,...}, status:"paid" }, header X-Signature (md5 yang sama)
//               balasan WAJIB JSON { "status": true }. IP pengirim WijayaPay: 172.235.245.77
//   Cancel    : tidak ada -- tagihan kedaluwarsa sendiri.
//
// Kredensial: DB dulu (app_settings key 'wijayapay', diisi lewat panel admin), env sebagai cadangan.
// ══════════════════════════════════════════════════════════════════

const DEFAULT_BASE_URL = "https://gateway.wijayapay.com";

export type WijayapayConfig = { merchantCode: string; apiKey: string; baseUrl: string };

const CONFIG_CACHE_TTL_MS = 30_000;
let cachedConfig: WijayapayConfig | null = null;
let cachedAt = 0;

export async function getWijayapayConfig(): Promise<WijayapayConfig> {
  if (cachedConfig && Date.now() - cachedAt < CONFIG_CACHE_TTL_MS) return cachedConfig;
  let stored: Partial<WijayapayConfig> = {};
  const admin = createAdminSupabase();
  if (admin) {
    const { data } = await admin.from("app_settings").select("value").eq("key", "wijayapay").maybeSingle();
    if (data?.value) stored = data.value as Partial<WijayapayConfig>;
  }
  const config: WijayapayConfig = {
    merchantCode: (stored.merchantCode || process.env.WIJAYAPAY_MERCHANT_CODE || "").trim(),
    apiKey: (stored.apiKey || process.env.WIJAYAPAY_API_KEY || "").trim(),
    baseUrl: (stored.baseUrl || process.env.WIJAYAPAY_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
  };
  cachedConfig = config;
  cachedAt = Date.now();
  return config;
}

export function invalidateWijayapayConfigCache() {
  cachedConfig = null;
  cachedAt = 0;
}

export async function isWijayapayConfigured(): Promise<boolean> {
  const { merchantCode, apiKey, baseUrl } = await getWijayapayConfig();
  return Boolean(merchantCode && apiKey && baseUrl);
}

function signatureFor(cfg: WijayapayConfig, refId: string) {
  return crypto.createHash("md5").update(`${cfg.merchantCode}${cfg.apiKey}${refId}`).digest("hex");
}

/** Cek header X-Signature webhook (md5 code_merchant+api_key+ref_id), tahan timing-attack. */
export async function verifyWijayapaySignature(refId: string, received: string | null): Promise<boolean> {
  if (!received || !refId) return false;
  const cfg = await getWijayapayConfig();
  if (!cfg.merchantCode || !cfg.apiKey) return false;
  const a = crypto.createHash("sha256").update(received.toLowerCase()).digest();
  const b = crypto.createHash("sha256").update(signatureFor(cfg, refId)).digest();
  return crypto.timingSafeEqual(a, b);
}

type Json = Record<string, unknown>;

async function wpFetch(
  cfg: WijayapayConfig,
  path: string,
  init: { method: "GET" | "POST"; query?: Record<string, string>; form?: Record<string, string>; signRef?: string }
): Promise<{ ok: true; json: Json } | { ok: false; message: string }> {
  try {
    const url = new URL(`${cfg.baseUrl}${path}`);
    if (init.query) for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "HeroItBest/1.0" };
    if (init.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (init.signRef) headers["X-Signature"] = signatureFor(cfg, init.signRef);
    const res = await fetch(url, {
      method: init.method,
      headers,
      body: init.form ? new URLSearchParams(init.form).toString() : undefined,
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    const raw = await res.text().catch(() => "");
    let json: Json | null = null;
    try {
      json = raw ? (JSON.parse(raw) as Json) : null;
    } catch {
      /* bukan JSON */
    }
    const msg = typeof json?.message === "string" && json.message ? json.message : "";
    if (!res.ok || json?.success === false) {
      return { ok: false, message: msg || `WijayaPay menolak request (HTTP ${res.status}).` };
    }
    return { ok: true, json: json ?? {} };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, message: aborted ? "Timeout menghubungi WijayaPay (>15 detik)." : "WijayaPay tidak terjangkau." };
  }
}

export type WijayapayCreateResult =
  | { success: true; qrString: string; fee: number; totalPayment: number; trxReference: string | null }
  | { success: false; message: string };

/** ref_id = orderId (unik per transaksi). Nominal akhir yang dibayar pembeli = total_bayar dari respons. */
export async function createWijayapayTransaction(params: { orderId: string; amount: number }): Promise<WijayapayCreateResult> {
  const cfg = await getWijayapayConfig();
  if (!cfg.merchantCode || !cfg.apiKey) return { success: false, message: "WijayaPay belum dikonfigurasi (Merchant Code/API Key kosong)." };
  const r = await wpFetch(cfg, "/api/transaction/create", {
    method: "POST",
    signRef: params.orderId,
    form: {
      code_merchant: cfg.merchantCode,
      api_key: cfg.apiKey,
      ref_id: params.orderId,
      code_payment: "QRIS",
      nominal: String(Math.round(params.amount)),
    },
  });
  if (!r.ok) return { success: false, message: r.message };
  const d = (r.json.data ?? {}) as Json;
  const qr = typeof d.qr_string === "string" ? d.qr_string : "";
  if (!qr) {
    return { success: false, message: "Respons WijayaPay tidak lengkap (qr_string tidak ditemukan). Pastikan channel QRIS aktif di akun WijayaPay." };
  }
  const total = Number(d.total_bayar);
  return {
    success: true,
    qrString: qr,
    fee: Number(d.total_fee ?? 0) || 0,
    totalPayment: Number.isFinite(total) && total > 0 ? total : params.amount,
    trxReference: typeof d.trx_reference === "string" ? d.trx_reference : null,
  };
}

export type WijayapayStatusResult =
  | { success: true; status: "pending" | "paid" | "expired" | string; amount: number | null }
  | { success: false; message: string };

export async function getWijayapayStatus(refId: string): Promise<WijayapayStatusResult> {
  const cfg = await getWijayapayConfig();
  if (!cfg.merchantCode || !cfg.apiKey) return { success: false, message: "WijayaPay belum dikonfigurasi." };
  const r = await wpFetch(cfg, "/api/get-status", {
    method: "GET",
    query: { code_merchant: cfg.merchantCode, api_key: cfg.apiKey, ref_id: refId },
  });
  if (!r.ok) return { success: false, message: r.message };
  const d = (r.json.data ?? {}) as Json;
  const raw = r.json.status_pembayaran ?? d.status_pembayaran;
  if (typeof raw !== "string") return { success: false, message: "Respons status WijayaPay tidak dikenali." };
  const amt = Number(d.total_bayar);
  return { success: true, status: raw.toLowerCase(), amount: Number.isFinite(amt) && amt > 0 ? amt : null };
}

// ── Test & Debug untuk panel admin ──
export type WijayapayTestStep = { step: string; ok: boolean; detail: string };
export type WijayapayTestResult = { ok: boolean; steps: WijayapayTestStep[]; elapsedMs?: number };

/**
 * Uji jalur: config -> create (QRIS uji Rp1.000) -> status. WijayaPay tidak punya cancel, jadi
 * tagihan uji dibiarkan kedaluwarsa sendiri (tidak ada uang berpindah selama tidak dibayar).
 */
export async function testWijayapayConnection(): Promise<WijayapayTestResult> {
  const steps: WijayapayTestStep[] = [];
  const cfg = await getWijayapayConfig();
  const started = Date.now();

  const configured = Boolean(cfg.merchantCode && cfg.apiKey);
  steps.push({
    step: "config",
    ok: configured,
    detail: configured ? `Base URL: ${cfg.baseUrl} · Merchant: ${cfg.merchantCode}` : "Merchant Code atau API Key kosong.",
  });
  if (!configured) return { ok: false, steps };

  const orderId = `test-${Date.now().toString(36)}`;
  const created = await createWijayapayTransaction({ orderId, amount: 1000 });
  if (!created.success) {
    const hint = /ip|whitelist|forbidden|403/i.test(created.message)
      ? " (kemungkinan IP server belum di-whitelist / whitelist belum dihapus oleh CS WijayaPay)"
      : "";
    steps.push({ step: "create", ok: false, detail: created.message + hint });
    return { ok: false, steps, elapsedMs: Date.now() - started };
  }
  steps.push({ step: "create", ok: true, detail: `ref_id=${orderId}, fee Rp${created.fee}, total bayar Rp${created.totalPayment}` });
  steps.push({ step: "qr_string", ok: true, detail: `QR diterima (${created.qrString.length} karakter).` });

  // Data baru bisa butuh beberapa detik: coba beberapa kali, lalu lewat trx_reference. Gagal di sini
  // TIDAK membatalkan test -- QR sudah berhasil dibuat dan pembayaran tetap masuk lewat webhook;
  // hanya cek status otomatis (polling) yang terpengaruh, dan itu dijelaskan apa adanya.
  let found: Awaited<ReturnType<typeof getWijayapayStatus>> | null = null;
  let via = "";
  let lastErr = "";
  for (let i = 0; i < 3 && !(found && found.success); i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    const st = await getWijayapayStatus(orderId);
    if (st.success) {
      found = st;
      via = `ref_id (percobaan ke-${i + 1})`;
    } else lastErr = st.message;
  }
  if (!(found && found.success) && created.trxReference) {
    const st = await getWijayapayStatus(created.trxReference);
    if (st.success) {
      found = st;
      via = `trx_reference ${created.trxReference}`;
    } else lastErr = st.message;
  }
  if (found && found.success) {
    steps.push({ step: "status", ok: found.status === "pending", detail: `Status transaksi uji: ${found.status} -- ditemukan lewat ${via}` });
  } else {
    steps.push({
      step: "status",
      ok: true,
      detail: `PERINGATAN: WijayaPay menjawab "${lastErr}" untuk transaksi yang baru dibuat. Pembuatan QR OK; saldo tetap masuk lewat webhook, tapi cek status otomatis (polling) tidak bisa dipakai di akun ini -- pastikan Webhook URL sudah didaftarkan di WijayaPay & tanyakan CS soal endpoint get-status.`,
    });
  }
  steps.push({ step: "cancel", ok: true, detail: "WijayaPay tidak menyediakan cancel -- tagihan uji kedaluwarsa sendiri." });

  return { ok: steps.every((s) => s.ok), steps, elapsedMs: Date.now() - started };
}
