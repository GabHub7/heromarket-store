# HeroMarket Reseller API — Dokumentasi Integrasi Partner

Dokumen ini dikirim ke partner (web/reseller lain) yang ingin terhubung otomatis
ke stok HeroMarket. Setelah admin HeroMarket generate API Key & Secret untuk
partner, partner bisa langsung integrasi 3 endpoint di bawah.

## Base URL
```
https://<domain-heromarket-kamu>/api/reseller
```

## Autentikasi (HMAC-SHA256)

Setiap request wajib menyertakan 4 header:

| Header | Isi |
|---|---|
| `x-api-key` | API Key yang diberikan admin |
| `x-timestamp` | Unix timestamp (detik), toleransi ±5 menit dari waktu server |
| `x-nonce` | UUID unik per-request (mencegah replay attack) |
| `x-signature` | HMAC-SHA256 signature (lihat cara hitung di bawah) |

### Cara menghitung signature

```
secretHash = SHA256(apiSecret)
bodyHash   = SHA256(rawBody)          // rawBody = "" untuk GET
canonical  = METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + bodyHash
signature  = HMAC-SHA256(canonical, secretHash)   // hex-encoded
```

`path` = full path URL **tanpa domain dan tanpa query string**, contoh:
`/api/reseller/balance` atau `/api/reseller/order`.

### Contoh (Node.js)

```javascript
const crypto = require('crypto');

function signRequest({ method, path, apiSecret, body }) {
  const secretHash = crypto.createHash('sha256').update(apiSecret).digest('hex');
  const rawBody = body ? JSON.stringify(body) : '';
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const canonical = [method, path, timestamp, nonce, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', secretHash).update(canonical).digest('hex');
  return { timestamp, nonce, signature, rawBody };
}
```

## Endpoint

### 1. Cek Saldo — `GET /api/reseller/balance`

Response:
```json
{ "success": true, "data": { "balance": 500000, "currency": "IDR", "partnerName": "Nama Partner" } }
```

### 2. List Produk & Harga — `GET /api/reseller/products`

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid-produk",
      "name": "Nama Produk",
      "category": "freefire",
      "description": "...",
      "image": "https://...",
      "items": [
        { "days": 30, "price": 45000, "stockMode": "limited", "stock": 12 },
        { "days": 7, "price": 15000, "stockMode": "unlimited", "stock": null }
      ]
    }
  ]
}
```
`stockMode: "unlimited"` berarti produk itu auto-restock dari provider HeroMarket sendiri (tidak akan pernah habis dari sisi API ini).

### 3. Order / Beli Key — `POST /api/reseller/order`

Request body:
```json
{
  "productId": "uuid-produk",
  "days": 30,
  "quantity": 1,
  "customerReference": "order-id-di-sistem-partner-kamu",
  "target": "081234567890 (opsional, no. HP/username tujuan)"
}
```

- `customerReference` **sangat disarankan diisi** dan **unik per order** — dipakai untuk idempotency. Kalau request gagal di jaringan lalu partner retry dengan `customerReference` yang sama, sistem tidak akan memotong saldo dua kali; akan mengembalikan hasil order yang sama persis.
- `quantity` maksimal 50 per request.

Response sukses:
```json
{
  "success": true,
  "data": {
    "orderId": "uuid",
    "productName": "Nama Produk",
    "days": 30,
    "quantity": 1,
    "totalPrice": 45000,
    "keys": ["KEY-ABC-123"],
    "remainingBalance": 455000
  },
  "message": "Order berhasil"
}
```

Response gagal (contoh saldo kurang):
```json
{ "success": false, "code": "INSUFFICIENT_BALANCE", "message": "Saldo tidak cukup. Saldo: 30000, dibutuhkan: 50000" }
```

### Kode error yang mungkin muncul

| Code | HTTP | Arti |
|---|---|---|
| `MISSING_AUTH_HEADERS` | 401 | Salah satu header wajib tidak ada |
| `TIMESTAMP_EXPIRED` | 401 | Jam server partner tidak sinkron (selisih >5 menit) |
| `REPLAY_DETECTED` | 401 | Nonce sudah pernah dipakai |
| `INVALID_API_KEY` | 401 | API Key salah/tidak dikenali |
| `PARTNER_SUSPENDED` | 403 | Akun partner dinonaktifkan sementara |
| `INVALID_SIGNATURE` | 401 | Signature tidak cocok — cek ulang cara hitung canonical string |
| `PRODUCT_NOT_FOUND` | 404 | productId salah atau produk nonaktif |
| `INVALID_DAYS` | 400 | Varian hari tidak tersedia untuk produk ini |
| `INSUFFICIENT_BALANCE` | 402 | Saldo partner tidak cukup |
| `ALLOCATION_FAILED` | 422 | Gagal alokasi key (stok habis dll), saldo otomatis di-refund penuh |

## Catatan penting

- Saldo partner hanya bisa ditambah oleh admin HeroMarket secara manual (partner transfer dulu, lalu admin top up).
- API Secret hanya ditampilkan **sekali** saat pertama kali dibuat/regenerate — simpan baik-baik.
- Kalau Secret bocor, segera minta admin HeroMarket untuk regenerate (API Key tetap sama, tidak perlu ubah kode integrasi selain Secret-nya).
