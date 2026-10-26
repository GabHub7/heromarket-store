import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createPakasirTransaction, getActivePaymentGateway, getPakasirStatus } from "@/lib/provider/pakasir";
import { getWijayapayStatus } from "@/lib/provider/wijayapay";

// Pakasir membatasi cek status 1x / 4 detik per transaksi -- jaga per instance.
const lastPakasirCheck = new Map<string, number>();
const PAKASIR_MIN_INTERVAL_MS = 5000;

// Pending lebih lama dari ini dianggap kedaluwarsa (QRIS gateway biasanya
// 15-30 menit). Pembayaran telat tetap dikreditkan oleh webhook.
const PENDING_TTL_MS = 30 * 60 * 1000;
// Reconcile ke gateway hanya setelah pending cukup lama (webhook normalnya
// datang dalam hitungan detik) -- hemat request ke gateway/Supabase.
const RECONCILE_AFTER_MS = 45 * 1000;

/**
 * Polled by TopupForm's QR modal every few seconds while a GensPay QRIS
 * payment is pending -- webhook settlement is still the source of truth
 * (see src/app/api/webhooks/topup/route.ts), this endpoint just lets the
 * client find out it already happened without a full page reload.
 *
 * Reads via the user's own session (RLS "users read own topups" policy),
 * NOT the service-role client -- this route only ever needs to read a row
 * the requesting user already owns, so there's no reason to bypass RLS
 * here the way /api/topup/create and the webhook legitimately do.
 */
export async function GET(request: Request) {
  if (!isSupabaseConfigured) {
    return NextResponse.json({ error: "supabase_not_configured" }, { status: 503 });
  }

  const { searchParams } = new URL(request.url);
  const ref = searchParams.get("ref");
  if (!ref) {
    return NextResponse.json({ error: "missing_ref" }, { status: 400 });
  }

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!user || !supabase) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("topups")
    .select("status, total, nominal, bonus, created_at")
    .eq("merchant_ref", ref)
    .eq("user_id", user.id) // belt-and-suspenders on top of RLS -- explicit is cheap here
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "query_failed", message: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let status = data.status as "pending" | "success" | "expired" | "failed";
  if (status === "pending") {
    const age = Date.now() - new Date(data.created_at as string).getTime();
    const admin = createAdminSupabase();
    if (admin) {
      // Pakasir mengirim webhook HANYA saat sukses dan retry-nya tidak terdokumentasi --
      // satu webhook yang gagal = saldo tidak pernah masuk. Cek langsung ke gateway.
      // txn_id tidak kita simpan, jadi diambil lewat create-transaction (find-or-create:
      // order_id + nominal sama = transaksi yang sama), lalu transaction-status.
      const last = lastPakasirCheck.get(ref) ?? 0;
      if (
        age > RECONCILE_AFTER_MS &&
        age <= PENDING_TTL_MS &&
        Date.now() - last > PAKASIR_MIN_INTERVAL_MS &&
        (await getActivePaymentGateway()) === "pakasir"
      ) {
        lastPakasirCheck.set(ref, Date.now());
        if (lastPakasirCheck.size > 500) lastPakasirCheck.clear();
        const found = await createPakasirTransaction({ orderId: ref, amount: Number(data.nominal) });
        const st = found.success ? await getPakasirStatus(found.txnId) : ({ success: false } as const);
        if (st.success && st.status === "completed") {
          const { data: row } = await admin
            .from("topups")
            .select("user_id, nominal, bonus")
            .eq("merchant_ref", ref)
            .eq("user_id", user.id)
            .neq("status", "success")
            .maybeSingle();
          if (row) {
            const { error: sErr } = await admin.rpc("settle_topup", {
              p_provider_ref: ref,
              p_user_id: row.user_id,
              p_nominal: row.nominal,
              p_bonus: row.bonus,
            });
            if (!sErr) status = "success";
          }
        } else if (st.success && st.status === "canceled") {
          await admin.rpc("mark_topup_final", { p_merchant_ref: ref, p_status: "expired" });
          status = "expired";
        }
      }
      // WijayaPay: status dicek per ref_id (= merchant_ref), tidak butuh txn_id. Webhook tetap sumber utama.
      if (
        status === "pending" &&
        age > RECONCILE_AFTER_MS &&
        age <= PENDING_TTL_MS &&
        Date.now() - (lastPakasirCheck.get(`wp:${ref}`) ?? 0) > PAKASIR_MIN_INTERVAL_MS &&
        (await getActivePaymentGateway()) === "wijayapay"
      ) {
        lastPakasirCheck.set(`wp:${ref}`, Date.now());
        if (lastPakasirCheck.size > 500) lastPakasirCheck.clear();
        const st = await getWijayapayStatus(ref);
        if (st.success && st.status === "paid" && (st.amount === null || st.amount >= Number(data.nominal))) {
          const { data: row } = await admin
            .from("topups")
            .select("user_id, nominal, bonus")
            .eq("merchant_ref", ref)
            .eq("user_id", user.id)
            .neq("status", "success")
            .maybeSingle();
          if (row) {
            const { error: sErr } = await admin.rpc("settle_topup", {
              p_provider_ref: ref,
              p_user_id: row.user_id,
              p_nominal: row.nominal,
              p_bonus: row.bonus,
            });
            if (!sErr) status = "success";
          }
        } else if (st.success && st.status === "expired") {
          await admin.rpc("mark_topup_final", { p_merchant_ref: ref, p_status: "expired" });
          status = "expired";
        }
      }
      if (status === "pending" && age > PENDING_TTL_MS) {
        await admin.rpc("mark_topup_final", { p_merchant_ref: ref, p_status: "expired" });
        status = "expired";
      }
    }
  }

  return NextResponse.json({
    status,
    total: data.total,
    nominal: data.nominal,
    bonus: data.bonus,
  });
}
