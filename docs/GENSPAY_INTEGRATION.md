# Integrasi GensPay (QRIS Payment Gateway) — HeroMarket

Dokumen ini dibuat berdasarkan kode integrasi yang sudah berjalan di
`server.js` (bukan dokumentasi umum GensPay dari internet) — jadi isinya
akurat sesuai apa yang benar-benar dipakai HeroMarket.

---

## 1. Konsep Dasar

GensPay dipakai sebagai payment gateway QRIS. Ada 3 bagian:

1. **Create Payment** — bikin QRIS baru saat pembeli checkout.
2. **Check Status (polling)** — pembeli/browser cek berkala apakah sudah dibayar.
3. **Webhook** — GensPay kirim notifikasi otomatis begitu pembayaran sukses (lebih cepat dari polling).

Kredensial **tidak** disimpan di database/admin panel, tapi murni lewat
**environment variable** di hosting (Vercel dkk) — demi keamanan API key,
supaya tidak bisa dilihat siapa pun lewat panel admin.

---

## 2. Environment Variable yang Wajib Diisi

Di Vercel (atau hosting lain) → Settings → Environment Variables:

```
GENSPAY_BASE_URL=https://api.genspay.my.id      (contoh, sesuaikan base URL asli akun kamu)
GENSPAY_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
```

Kalau salah satu kosong, server akan cetak warning saat boot:
```
[WARNING] GENSPAY_BASE_URL / GENSPAY_API_KEY belum diset. Mode QRIS API (GensPay) tidak akan berfungsi sampai env var ini diisi.
```
dan semua fitur QRIS otomatis nonaktif (bukan crash, tapi checkout QRIS akan gagal dengan pesan error yang jelas).

---

## 3. Endpoint yang Dipanggil ke GensPay

### a. Create Transaction
```
POST {GENSPAY_BASE_URL}/transaction/create
Header: X-API-Key: {GENSPAY_API_KEY}
Content-Type: application/json

Body:
{
  "amount": 50000,
  "order_id": "HM-XXXX-XXXX"
}
```

Response yang diharapkan (dan field yang dipakai HeroMarket):
```json
{
  "success": true,
  "data": {
    "qr_string": "00020101021226...",
    "amount": 50000,
    "expiry_time": "2026-08-09T12:30:00Z"
  }
}
```
- `data.qr_string` → ditampilkan sebagai QR code ke pembeli.
- `data.amount` → dipakai sebagai `totalPayment` transaksi (fallback ke `amount` yang dikirim kalau tidak ada).
- `data.expiry_time` → waktu kadaluarsa QR (opsional, boleh `null`).

Kalau `success: false` atau `qr_string` kosong, transaksi dianggap gagal dan pesan error dari GensPay (`message`) ditampilkan ke admin/log.

### b. Check Transaction Status
```
GET {GENSPAY_BASE_URL}/transaction/{order_id}/status
Header: X-API-Key: {GENSPAY_API_KEY}
```

Dipanggil lewat polling dari endpoint internal `GET /check-payment/:refId` (dipanggil otomatis berkala oleh browser pembeli selama halaman checkout terbuka).

---

## 4. Webhook (Notifikasi Otomatis)

### URL yang harus didaftarkan di dashboard/Telegram bot GensPay:
```
https://heromarket.web.id/webhook/genspay
```

### Format yang dikirim GensPay ke URL itu:
```
POST /webhook/genspay
Header: X-Genspay-Signature: {signature}
Content-Type: application/json

Body:
{
  "event": "payment.success",
  "data": {
    "order_id": "HM-XXXX-XXXX"
  }
}
```

### Cara verifikasi signature (sudah diimplementasikan di server):
```
signature = SHA256( raw_request_body + GENSPAY_API_KEY )
```
Signature dibandingkan pakai `crypto.timingSafeEqual` (aman dari timing attack). Kalau signature tidak cocok atau header tidak ada → response `401 Unauthorized`.

### Apa yang terjadi saat webhook diterima & valid:
1. Sistem cari transaksi lokal dengan `orderId` yang cocok dan status masih `pending`.
2. Kalau ketemu, transaksi diselesaikan otomatis (`allocateKeyAndCompleteTransaction`) — key/produk dikirim ke pembeli.
3. Ada proteksi race condition: kalau webhook dan polling `/check-payment` kebetulan jalan bersamaan (umum terjadi di Vercel yang multi-instance), sistem pakai `processingOrders` Set in-memory untuk mencegah 1 transaksi diproses dua kali.
4. Response ke GensPay **selalu** `200 OK` walau ada error internal di sisi HeroMarket — ini supaya GensPay tidak retry terus-menerus akibat bug internal kita. Error tetap dicatat di log server (`console.error`).

---

## 5. Test Koneksi dari Admin Panel

Di `/admin` → Setting → card GensPay, ada tombol **Test Koneksi** yang membaca langsung dari environment variable server (bukan dari input form, karena memang tidak disimpan di database). Berguna untuk mastiin `GENSPAY_BASE_URL`/`GENSPAY_API_KEY` sudah kebaca benar oleh server tanpa perlu bikin transaksi asli.

---

## 6. Troubleshooting Cepat

| Gejala | Kemungkinan Penyebab |
|---|---|
| Warning saat boot server | `GENSPAY_BASE_URL`/`GENSPAY_API_KEY` belum diisi di environment variable hosting |
| QRIS gagal dibuat, pesan "GensPay error (HTTP xxx)" | Base URL salah, API key salah/expired, atau endpoint create GensPay sedang down |
| Pembayaran sudah masuk tapi transaksi tetap "pending" lama | Webhook belum terdaftar di dashboard GensPay, atau signature tidak cocok (cek `GENSPAY_API_KEY` di kedua sisi harus identik) — sebagai fallback, polling `/check-payment` tetap akan mendeteksinya walau lebih lambat |
| Webhook selalu balas 401 | `X-Genspay-Signature` tidak dikirim GensPay, atau `GENSPAY_API_KEY` di server beda dari yang dipakai GensPay untuk generate signature |

---

*Dokumen ini digenerate ulang dari kode aktual di `server.js` (fungsi `createQRISPayment`, `checkPaymentStatus`, dan route `POST /webhook/genspay`) karena dokumentasi asli hilang. Kalau ada perubahan di kode integrasi ini di masa depan, dokumen ini perlu di-update manual mengikuti.*
