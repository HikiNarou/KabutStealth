# KABUT — Dokumen Teknis v3.0.0

Ringkasan desain, keputusan teknik, dan model ancaman untuk audit pengembang. Ringkas sesuai permintaan (dokumentasi ringan).

## 1. Model Ancaman

**Dilindungi**: identifikasi & korelasi lintas-situs oleh skrip fingerprinting (Canvas/WebGL/WebGPU/Audio/Font/Rect/Navigator/Permissions/MediaDevices/permukaan 2025-2026), enumerasi perangkat eksternal (Bluetooth/USB/HID/Serial/XR/Gamepad), kebocoran IP via WebRTC (semua jalur SDP), pengumpulan header klien entropy-tinggi **termasuk opt-in `Accept-CH` dari server**, dan pembacaan nilai oleh blob-worker.

**Tidak diubah (sesuai preferensi pengguna)**: zona waktu, bahasa, `Accept-Language`, preferensi teramati CSS (`prefers-color-scheme` dkk.) — menurunkan risiko lie-detector TS-locale & CSS-vs-JS.

**Asumsi lawan**: fingerprinter kelas CreepJS/FingerprintJS — render ganda, inspeksi `toString`/`name`/`length`/deskriptor, uji `instanceof` + `toStringTag`, pemindaian own-property, pencurian fungsi pristin (iframe `about:blank`/`srcdoc`, popup `window.open`, blob-worker), silang-klaim antar-API, enum Permissions, deteksi noise via blank/silence probe, dan **pemasangan listener pada kanal internal ekstensi**.

## 2. Arsitektur Injeksi (v3.1)

```
document_start ─ bridge.js (ISOLATED) ──sinkron──> atribut <html data-kabut-boot>
                        │                              │ (dibaca & DIHAPUS core
                        │                               sebelum parser lanjut)
                        │                              ▼
                        │                     kabut-core.js (MAIN) — patch
                        │                     terpasang milidetik pertama
                        └──asinkron──> CustomEvent('kabut-cfg') ──> payload
                                       detail = XOR-ciphertext (pad = atribut)
```

- **Fase sinkron**: bridge membaca cache konfigurasi tersanitasi dari `sessionStorage('ks-cfg')`, membuat pad acak 1024-byte, menulis `{pad, dom, en, cfg}` ke atribut. Core membacanya, **menghapus atribut**, memasang seluruh patch dengan seed provisional deterministik per-domain. Skrip halaman pertama tidak pernah sempat melihat atribut maupun nilai asli.
- **Fase asinkron**: bridge membaca `chrome.storage` → menghitung seed = `H(secret|override, domain)` → event dengan payload **terenkripsi**. Core mendekripsi dengan pad → jika **belum ada nilai terkunci** (`hasLocks()`), seed ditukar ke seed nyata; jika sudah — seed dibeku demi konsistensi lintas realm.
- **Allowlist**: bridge mengevaluasi dan hanya menurunkan flag `en`; daftar situs terpercaya **tidak pernah** menyeberang ke halaman. `en=false` ter-cache → core tidak memasang patch sama sekali.
- Fallback: tanpa bridge/atribut → core boot default paranoid pada 60 ms (seed provisional deterministik).
- Live-update: perubahan pengaturan → SW broadcast → bridge → event terenkripsi → core memperbarui `ctx.cfg` (mode canvas dsb. berlaku segera; nilai terkunci tetap stabil).

## 3. Seed & Determinisme

- `secret` = 128-bit acak per install (`chrome.storage.local`); reroll global/per-domain tersedia.
- `seed(domain) = hex(xmur3("kabut/domain-seed|" + (override‖secret) + "|" + domain))`.
- Setiap permukaan memakai stream sendiri: `makeRng("kabut/<surface>|" + seed + "|" + domain)`.
- Noise = **fungsi murni** (seed, koordinat): canvas `table[hash32(x·A ⊕ y·B ⊕ ch·C) & 511]`; dua kanvas isi sama → hasil identik; beda domain → beda sidik jari (terbukti E2E, termasuk antar-realm worker via prelude dengan string stream identik).
- Guard anti-deteksi-blank: piksel alpha=0 & sampel silence dilewati.

## 4. Anti-Tampering

- `NATIVE_STRINGS` WeakMap bersama lintas realm; guard `Function.prototype.toString` per realm.
- `patchAccessor/patchMethod`: `name`, `length`, flag deskriptor dicerminkan; semua wrapper try/catch → fallback senyap.
- `makeShim`: Proxy di atas `Object.create(Interface.prototype)` — rantai prototipe asli, `instanceof` ✓, `toStringTag` ✓, own-keys bersih, EventTarget nyata.
- `makeBoundProxy` (v3): Proxy di atas **instansi nyata** (WebGPU) — method native di-bound & di-nativize, identitas fungsi stabil.
- `applyIframeGuard` (lazy contentWindow/contentDocument) + `applyWindowOpenGuard` (sinkron) + `applyWorkers` (prelude) menutup tiga jalur fungsi-pristin.

## 5. DNR

- **core** (aktif default): 19 header permintaan dibuang + **response `Accept-CH`/`Critical-CH` dibuang** → mekanisme opt-in CH mati di sumber.
- **strict** (opsional): CH entropy-rendah + anti-cache-tracking pihak ketiga (`If-None-Match`/`If-Modified-Since`/`ETag`) + `DNT`/`Sec-GPC`.
- Profil UA ≠ asli → session rule (prioritas lebih tinggi) MEN-SET UA & CH low-entropy konsisten; strict dimatikan otomatis untuk menghindari konflik.

## 6. Keputusan yang Disengaja (dengan alasan)

| Keputusan | Alasan |
|---|---|
| TZ/bahasa/preferensi-media ASLI | lie-detector CSS-vs-JS & locale-vs-header; entropy kecil |
| dpr di-spoof + matchMedia resolution konsisten | konsistensi JS penuh; jalur CSS murni tak bisa dipatch tanpa merusak render (dokumentasi jujur) |
| limits WebGPU = minimum spesifikasi | tak pernah melebihi kemampuan nyata → nol breakage; seragam → nol entropy |
| features WebGPU hanya difilter | situs tak pernah meminta fitur yang tak didukung → nol breakage |
| blob-worker saja yang di-farbling | membungkus worker ber-URL file tak bisa tanpa merusak resolusi relatif |
| id enumerateDevices pra-izin tetap kosong | identik perilaku native Chrome |
| permission notifications/local-fonts tak pernah granted | konsisten dengan Notification ctor & queryLocalFonts yang ditolak |
| seed dibeku bila ada nilai terkunci | stabilitas intra-halaman > kebaruan seed |
| `innerWidth/innerHeight` asli | volatile sesi, bukan sidik perangkat; spoof berisiko merusak layout |

## 7. Batasan Struktural (jujur)

1. TLS/JA3/JA4 & fingerprint TCP tidak dapat diubah ekstensi — profil "Asli"/"Windows" paling konsisten; VPN untuk lapisan jaringan.
2. Worker ber-URL & Service Worker halaman tanpa farbling (prelude hanya untuk blob).
3. Pertama kali kunjungan situs setelah install: seed provisional publik dipakai sampai event terenkripsi tiba (± puluhan ms); satu kali per install, stabil, tanpa identitas.
4. Brave farbling bawaan bisa bertumpuk dengan Kabut (dobel noise) — nonaktifkan salah satu bila perlu.
5. Pemindaian `performance.getEntriesByType('resource')` (nextHopProtocol/dns) dibiarkan asli.

## 8. Harness

`scripts/build.mjs` (kontrak), `scripts/test-unit.mjs` (unit murni), `scripts/e2e/run-e2e.cjs` (Playwright + Chromium, persistent context, `--load-extension`, mode berkepala via Xvfb + `--enable-unsafe-webgpu --enable-dawn-features=use_swiftshader` agar adapter WebGPU nyata tersedia). Laporan: `scripts/e2e/e2e-report.json`.
