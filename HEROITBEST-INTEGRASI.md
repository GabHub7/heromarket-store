# Sambungkan HERO MARKET ke HEROITBEST (key otomatis)

Dengan ini owner tidak perlu lagi menyetok / mencari key manual. Tiap ada pembeli bayar,
toko meminta key ke heroitbest lewat Partner API dan mengirimkannya ke pembeli.

## Alur uang (monetisasi)

```
Pembeli bayar harga JUAL (mis. Rp25.000)  ->  masuk ke toko HERO MARKET
Toko minta key ke heroitbest               ->  saldo akun partner dipotong harga MODAL (mis. Rp15.000)
Margin owner                                =  harga jual - harga modal  (Rp10.000)
```

- **Harga modal** = harga efektif akun partner di heroitbest (tier / harga custom dari admin heroitbest).
- **Harga jual** = harga yang kamu set sendiri di produk toko (bebas, atur margin sesuka owner).
- Saldo partner di heroitbest harus selalu ada. Kalau habis, pembeli melihat pesan "stok kosong sementara"
  (bukan pesan saldo habis) dan pesanan tidak diproses. Pantau saldo di bagian Multi-Provider (tombol saldo/test) di Admin -> Reseller API.
- Tips margin: pakai kelipatan minimal 20-40% di atas modal untuk menutup biaya gateway pembayaran.

## Setup (sekali saja)

**A. Di panel heroitbest (admin heroitbest)**
1. Buat akun reseller khusus untuk toko ini, mis. `heromarket-partner`. Top up saldonya.
2. Dashboard -> Admin -> Partner API -> buat key baru, ikat ke akun reseller tadi. Salin key-nya.
3. Pastikan update heroitbest terbaru sudah ter-deploy (ada endpoint `/api/v1/partner/balance`).

**B. Di panel admin HERO MARKET**
1. Admin -> Reseller API -> bagian "Multi-Provider Reseller API" -> Tambah Provider Baru -> pilih **HEROITBEST (Partner API)**.
2. Isi **Partner API Key** dan **Base URL** `https://DOMAIN-HEROITBEST-KAMU/api/v1/partner`.
3. Klik **Test Connection** (harus muncul saldo partner). Klik **Sync** untuk memuat katalog.
4. Edit produk toko -> tiap varian durasi -> pilih mapping ke produk heroitbest yang sesuai
   (satu baris = produk + durasi, mis. "FF Mod - 7 HARI") dan set Mode Stok = Auto.
5. Set harga jual per varian. Selesai: pembelian berikutnya otomatis mengambil key dari heroitbest.

## Catatan keamanan
- API key hanya disimpan di server (database toko), tidak pernah dikirim ke browser.
- Pesan error mentah dari supplier (mis. saldo habis) tidak ditampilkan ke pembeli, hanya tercatat di Log API admin.
- Jika koneksi ke heroitbest putus saat order, adapter TIDAK mengulang otomatis (agar tidak terpotong dua kali);
  cek Log API lalu proses manual bila perlu.
