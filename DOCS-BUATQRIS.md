# BuatQris di HERO MARKET

Gateway QRIS dinamis ke-4 (selain GensPay, Pakasir, WijayaPay). Pembeli scan QR, status lunas masuk lewat webhook, key terkirim otomatis.

## Pasang
1. Dashboard BuatQris (https://app.buatqris.site) -> menu **Open API**: salin `Account ID`, `Secret Token` (`sk_live_...`) dan `Signing Secret` (bagian Webhook / Callback). Secret Token dan Signing Secret **berbeda**.
2. Admin HERO MARKET -> Pengaturan QRIS -> pilih **API (BuatQris)** -> isi tiga kredensial -> **Simpan Kredensial BuatQris**.
3. Klik **Test Koneksi BuatQris** (membuat transaksi sandbox Rp1.000, tanpa uang asli).
4. Di dashboard BuatQris -> Webhook / Callback isi: `https://heromarket.web.id/webhook/buatqris` (tiap transaksi juga mengirim callback_url sendiri, ini cadangan).
5. Uji dulu dengan **Mode Sandbox**, lalu **matikan** sebelum toko dibuka.

Alternatif lewat env Vercel: `BUATQRIS_ACCOUNT_ID`, `BUATQRIS_SECRET_TOKEN`, `BUATQRIS_SIGNING_SECRET`, `BUATQRIS_BASE_URL` (opsional), `BUATQRIS_FEE_BY`, `BUATQRIS_QRIS_METHOD`. Nilai di panel menang atas env.

## Cara kerja
- Create: `POST https://api.buatqris.site` `action=api_create_qris` (cadangan otomatis `https://app.buatqris.site/api`). `transaction_id` disimpan di `transaction.gatewayTxnId`; nominal bayar = `total_amount` (sudah termasuk kode unik).
- QR berupa **gambar** (`qr_url`), bukan string QRIS; halaman bayar menampilkannya langsung.
- Webhook `POST /webhook/buatqris`: header `X-BuatQris-Signature: sha256=<HMAC-SHA256 body mentah>` wajib valid (tanpa Signing Secret = 401). Event `payment.success` -> cek nominal -> konfirmasi ulang ke API -> key terkirim. Idempoten.
- Cadangan: polling halaman bayar + cron reconcile memakai `api_check_status` (BuatQris membatasi 1x / 20 detik per transaksi, sudah ditangani cache 21 detik).
- Event `is_test:true` diabaikan kalau Mode Sandbox mati.

## Troubleshooting
| Gejala | Solusi |
|---|---|
| "Kredensial API tidak valid" | Account ID / Secret Token salah, salin ulang. |
| Sudah bayar tapi PENDING | Cek Signing Secret terisi & benar; log server `signature_invalid` = salah. |
| Log `amount_mismatch` | Jangan ubah "Biaya layanan" saat ada pesanan pending. |
| QR tidak muncul | Cek saldo/metode QRIS di BuatQris, nominal di luar batas (Rp1.000-5.000.000), atau rate limit 60 transaksi/menit. |

Jangan commit kredensial ke GitHub. Kalau sempat bocor/tertempel di chat, **Regenerate Token** di dashboard BuatQris.
