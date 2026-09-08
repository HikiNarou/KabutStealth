# KABUT v3.0.0 — Hasil Pengujian (Nyata)

Tanggal uji: 2026-09-08 · Harness: `scripts/build.mjs`, `scripts/test-unit.mjs`, `scripts/e2e/run-e2e.cjs`
Peramban uji E2E: **Chromium 151** (Playwright 1.62.1, persistent context, ekstensi dimuat `--load-extension`, mode berkepala via Xvfb, adapter WebGPU aktif `--enable-unsafe-webgpu --use-angle=swiftshader`) · Node v24.19.0

## Ringkasan

| Jalur | Lulus | Gagal | Status |
|---|---|---|---|
| Kontrak build & berkas | 46 | 0 | ✅ |
| Unit (murni, Node) | **349** | 0 | ✅ |
| E2E (browser nyata, ekstensi termuat) | **226** | 0 | ✅ |

## Sorotan pembuktian E2E

- **Boot sinkron (v3.1)**: skrip inline pertama di `<head>` (milidetik ke-0) sudah melihat nilai spoof — `early read == nilai akhir`; DOMREADY == akhir; atribut boot terhapus.
- **Keamanan kanal**: listener pencuri (`kabut-cfg`) dipasang di halaman uji — payload tertangkap tidak memuat seed polos/allowlist/domainOverrides; cache sessionStorage tersanitasi.
- **WebGPU nyata**: adapter sungguhan tersedia (swiftshader) → `GPUAdapter.info.vendor` ∈ {intel, nvidia, amd} (terspoof, `common-3d`), `limits.maxTextureDimension2D = 8192`, `maxBufferSize = 256MB`, features ⊆ daftar lazim, `requestDevice()` → `createCommandEncoder()` **berfungsi** (method native ter-bound), `toString()` native, identitas method stabil, `destroy()` tanpa error, `instanceof GPUAdapter/GPUSupportedLimits/GPUSupportedFeatures` ✓.
- **Farbling worker (v3)**: blob worker melaporkan `hardwareConcurrency` == spoof utama; hash noise `putImageData` worker == hash utama (**tabel seed identik lintas realm**); `getImageData.toString()` native DI DALAM worker; GPU vendor worker == utama; worker module-type tetap berfungsi.
- **Guard window.open**: popup `about:blank` ter-patch sinkron (cores/UA == spoof sebelum halaman pembuka sempat membaca).
- **WebRTC**: `localDescription.sdp` tanpa kandidat IP mentah (hanya mDNS `.local`), `getStats` tanpa field `address/ip/networkType/url`, `instanceof RTCSessionDescription` ✓.
- **DNR**: response `Accept-CH`/`Critical-CH` terbuang (server uji sengaja mengirimnya); tak ada header CH entropy tinggi / X-Client-Data / Device-Memory / Rtt / Downlink / DPR pada permintaan.
- **Anti deteksi noise**: kanvas kosong → data-URL identik baseline native; silence analyser (byte 128/0, float 0) tetap persis native.
- **Anti-korelasi**: 127.0.0.1 vs localhost → hash canvas berbeda + profil (cores/GPU/layar) berbeda; warm-reload domain sama → sidik jari IDENTIK.
- **Identitas lokal asli**: UA, zona waktu, dan bahasa == baseline tanpa ekstensi.
- **UI**: popup badge AKTIF + versi 3.0.0; options memuat surface baru aktif; konfigurasi tersimpan `v=3`; diagnostik menampilkan ruleset `core_headers` aktif; nol error JS pada popup/options/halaman uji.
- **Instanceof & toString**: BatteryManager, NetworkInformation, PermissionStatus, Plugin(Array)/MimeType(Array), NavigatorUAData, Keyboard (peta 64 tombol), MediaDeviceInfo, GPUAdapter dkk., RTCStatsReport — semua lulus.
- Nol `pageerror` pada seluruh halaman terproteksi.

## Sampel nilai terproteksi (domain uji lokal, Chromium 151)

| Sinyal | Nilai terlihat situs | Baseline asli |
|---|---|---|
| cores | 4 / 16 / 20 (pool, per-domain) | 2 |
| GPU WebGL | pool ANGLE sesuai OS | null (swiftshader) |
| WebGPU vendor | `amd` (pool) | — |
| Layar | 1440×900 (pool) | 1280×720 |
| sampleRate | 48000 (pool) | 48000 |
| baseLatency | 0.005 (pool) | 0.01 |
| TZ / bahasa / UA | **identik baseline** | — |

Laporan mentah: `scripts/e2e/e2e-report.json` (di lingkungan harness).

## Reproduksi

```bash
node scripts/build.mjs        # kontrak build + gabung modul core
node scripts/test-unit.mjs    # 349 asersi unit
Xvfb :99 & DISPLAY=:99 NODE_PATH=... node scripts/e2e/run-e2e.cjs   # 226 asersi E2E
```
