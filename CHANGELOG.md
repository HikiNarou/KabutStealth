# Changelog

## 3.0.0 — Pembaruan menyeluruh end-to-end (arsitektur kanal v3.1)

Fokus: menutup celah permukaan baru 2025-2026, memperbaiki **celah keamanan kritis pada kanal konfigurasi**, menghilangkan race injeksi MV3, menutup vektor lie-detector, dan pembuktian penuh: **349 asersi unit + 226 asersi E2E browser nyata — semua lulus**.

### Keamanan — celah yang DITUTUP
- **KRITIS — kebocoran seed via event (v2)**: payload `CustomEvent('kabut-cfg')` di v2 membawa **seed mentah + allowlist + domainOverrides** dalam teks polos. Skrip halaman mana pun cukup memasang listener untuk **mencuri seed** (identifier pelacak per-domain permanen) beserta daftar situs terpercaya pengguna. v3.1:
  - seed hanya berpindah **terenkripsi** (XOR pad acak 1024-byte per-load);
  - pad ditransfer lewat **atribut DOM prinsenjat** yang dibaca & dihapus core sebelum parser melanjutkan (tak terlihat skrip halaman);
  - allowlist & domainOverrides **tidak pernah** menyeberang ke halaman (hanya flag `enabled` hasil evaluasi bridge);
  - cache sessionStorage hanya berisi konfigurasi tersanitasi tanpa identitas.
  Pembuktian E2E: listener pencuri dipasang di halaman uji — payload yang tertangkap tak memuat seed/allowlist (asersi khusus).
- **Race injeksi (v2)**: konfigurasi via IPC storage tiba 10–20 ms setelah `document_start` → skrip inline-head sempat membaca nilai ASLI (dan acak-acak nilai pertama vs berikutnya). v3.1 menambahkan **fase boot SINKRON**: bridge menurunkan cache konfigurasi via atribut DOM sebelum parser lanjut → patch aktif pada **milidetik pertama** (terbukti E2E: early-read inline-head == nilai akhir).

### Permukaan baru (3)
- **WebGPU** (`surfaces.webgpu`): GPUAdapterInfo (vendor pool generik, `common-3d`, device/description kosong — nilai fallback mayoritas instalasi Chromium); limits dipin ke minimum spesifikasi (`maxTextureDimension2D: 8192`, `maxBufferSize: 256MB`, …) — **tak pernah melebihi kemampuan nyata → nol breakage**; features difilter ke daftar lazim desktop (hanya menghapus → situs tak pernah meminta fitur yang tak didukung). Dibangun di atas `makeBoundProxy` (baru) — Proxy di atas instansi NYATA dengan method native ter-bound (panggilan valid, `toString` native, identitas fungsi stabil). Selaras arah proteksi Brave 1.93 (2026).
- **Farbling blob Web Worker/SharedWorker** (`surfaces.workers`): intersepsi `URL.createObjectURL` + pembungkus konstruktor Worker → blob asli digabung prelude yang mem-patch `WorkerNavigator` (cores/UA) serta `OffscreenCanvas` 2D + WebGL di DALAM lingkup worker, dengan **tabel noise seed identik thread utama** (konsistensi lintas realm terbukti E2E via `putImageData`). Fallback penuh ke worker asli bila CSP menolak. Menutup bypass worker-scope yang di v2 diakui sebagai keterbatasan.
- **API perangkat eksternal** (`surfaces.hwapi`): Bluetooth/USB/HID/Serial (`getDevices`→kosong, `request*`→`NotFoundError` natural), WebXR (`isSessionSupported`→false, `requestSession`→`NotSupportedError`), `getGamepads()`→`[null×4]`, `getInstalledRelatedApps()`→`[]` (Mozilla menandai API ini memperluas permukaan fingerprinting), `DeviceMotion/OrientationEvent.requestPermission`→denied.

### Perbaikan bug
- **`getHighEntropyValues` argumen non-array**: v2 mengembalikan objek (lie); kini TypeError native-format.
- **`decodingInfo` argumen tak valid**: kini jatuh ke fungsi asli (TypeError asli terpelihara).
- **permission `local-fonts`**: v2 bisa 'granted' (bertentangan dengan `queryLocalFonts` yang selalu ditolak); kini selalu 'prompt'.
- **`enumerateDevices` pra-izin**: v2 mengisi deviceId spoof pada nilai yang seharusnya kosong (lie terhadap Chrome native); kini id kosong tetap kosong, hash dua arah tetap berlaku pasca-izin.
- **Peta keyboard**: 46 → 64 tombol (+Space, Backquote, numpad lengkap) — mendekati peta en-US Chromium asli.
- **`readPixels` WebGL**: piksel alpha=0 kini dilewati (konsisten dengan guard canvas).
- **Izasi `tabs` dihapus dari manifest** — `chrome.tabs.query`/`sendMessage` tetap berfungsi via host_permissions; permukaan privilese ekstensi diperkecil dan satu peringatan instalasi hilang.

### Anti-deteksi & konsistensi (penguatan)
- **Guard `window.open` sinkron**: popup `about:blank` dipatch seketika sebelum skrip pembuka sempat membaca navigator (menutup race "fresh pristine window").
- **`matchMedia resolution`/`-webkit-device-pixel-ratio`** dievaluasi terhadap dpr spoof (menutup lie dpr-JS vs media-query); + `video-dynamic-range`, `environment-blending` dinormalisasi.
- **Guard anti-deteksi-blank**: noise canvas dilewati untuk piksel alpha=0; noise audio dilewati untuk sampel 0/128 (silence tetap silence native persis).
- **`getSupportedExtensions`/`getExtension` WebGL** difarbling deterministik per-domain (subset opsional dibuang p=0.5; ekstensi krusial dipertahankan).
- **`baseLatency`/`outputLatency` AudioContext** dipin ke pool lazim (profil latensi hardware tak bocor).
- **`outerWidth`/`outerHeight` dinamis**: delta jendela dipetahankan terhadap layar spoof → deduksi ukuran layar NYATA dari jendela dimaksimalkan tertutup; + `screenLeft/screenTop=0`, `screen.isExtended=false`, `getScreenDetails`→NotAllowedError, `pdfViewerEnabled=true`.
- **Seed beku saat ada nilai terkunci** (`hasLocks()`): seed baru (event terlambat / reroll) tak pernah mengubah nilai yang sudah terbaca → konsistensi lintas realm & stabilitas intra-halaman terjaga; seed fallback deterministik per-domain (v2 acak → tak stabil antar-reload).

### DNR
- **core**: + rule response yang membuang **`Accept-CH` & `Critical-CH`** — opt-in server terhadap client hints entropy tinggi diputus di sumbernya.
- **strict** (opsional): + anti cache-tracking lintas situs (buang `If-None-Match`/`If-Modified-Since` permintaan & `ETag` respons pihak ketiga) + buang `DNT`/`Sec-GPC` (mengurangi entropy postur privasi).

### Arsitektur & alur kerja
- `kabut-core.js` dipecah 15 modul sumber (digabung build script) — auditable & teruji per-modul.
- Manifest: `matches` + `file://*/*`; izin minimum (`storage`, `privacy`, `declarativeNetRequest`).
- Migrasi konfigurasi v2→v3 otomatis (surface baru aktif default; nilai lama dipertahankan).

### Pengujian (nyata, dapat direproduksi)
- Kontrak build: 46 cek (sintaks semua JS, kontrak manifest, kontrak rules DNR, kabel antar-berkas).
- Unit: **349 asersi** murni Node (PRNG, migrasi, profil, perm, SDP, resolution, prelude worker — termasuk eksekusi prelude di worker Node nyata).
- E2E: **226 asersi** Chromium 151 nyata (Playwright, persistent context, ekstensi termuat; mode berkepala + adapter WebGPU swiftshader aktif) — termasuk: WebGPU end-to-end (vendor/limits/features/instanceof/method-bound), konsistensi noise worker↔utama, anti-kebocoran seed, DNR response `Accept-CH`, popup/options, stabilitas seed warm-reload, anti-korelasi antar-domain, TZ/bahasa asli.

## 2.0.0 — Peningkatan menyeluruh end-to-end
Menutup kebocoran WebRTC SDP (vanilla ICE), `copyToChannel` audio, `convertToBlob` mode blok; perbaikan `ensureDefaults` dead-code; Permissions API; shim Proxy rantai prototipe; 11 header baru; 274 unit + 175 E2E.

## 1.0.0 — Rilis awal
Canvas/WebGL/audio/rects/fonts noise deterministik per-domain, navigator & client hints, DNR core/strict, WebRTC dua lapis, popup+options, seed stabil per-domain.
