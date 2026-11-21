# Reseller Tier 1 & Tier 2 (HERO MARKET)

| | Tier 1 | Tier 2 |
|---|---|---|
| Harga key reseller (diskon global / harga per produk) | ✓ | ✓ |
| Beli pakai saldo + panel reseller (`/reseller/panel`) | ✓ | ✓ |
| API key + Reseller API v1 (`/api/v1`) | – | ✓ |
| Dokumentasi API (`/docs/api`, hanya Tier 2) | – | ✓ |

- Halaman daftar/upgrade: `/reseller` (pilih tier, bayar QRIS). Tier 1 -> Tier 2 membayar selisih harga.
- Menu akun: Jadi Reseller / Upgrade ke Tier 2 / Panel Reseller / API Reseller.
- Admin: Pengaturan Reseller (biaya Tier 1 `resellerPrice`, biaya Tier 2 `resellerTier2Price`, diskon, saklar API v1 `resellerV1Enabled`); di daftar user ada pilihan Member / Tier 1 / Tier 2 (turun dari Tier 2 otomatis mencabut API key).
- Reseller lama (tanpa `reseller_tier`) dianggap Tier 1.
- API: kontrak sesuai PROMPT-OPEN-RESELLER-API.md (Bearer `rk_live_…`, Idempotency-Key, SKU `<productId>.<n><d|h|m>`). Key disimpan sebagai hash SHA-256. Kode: `reseller-v1.js`.
- Partner API lama (`/api/reseller/*`, HMAC, dibuat admin) tetap jalan, terpisah.
