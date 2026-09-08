/*!
 * KABUT service worker (MV3) v3.0.0
 *  - DNR: session rules override UA+CH konsisten saat profil aktif;
 *         enable/disable ruleset statis (core/strict) sesuai pengaturan.
 *         v3: ruleset core juga membuang Accept-CH/Critical-CH dari
 *         RESPONSE server → opt-in client-hints entropy tinggi diputus
 *         di sumbernya.
 *  - chrome.privacy: kebijakan WebRTC jaringan (disable_non_proxied_udp)
 *  - Hub pesan untuk popup/opsi + broadcast perubahan ke semua tab
 *  - Menjaga secret identitas install (random 128-bit)
 *  - v3: izin "tabs" dihapus — chrome.tabs.query tetap mengembalikan id
 *    tab (host_permissions <all_urls> mencukupi); permukaan privilese
 *    ekstensi diperkecil & peringatan instalasi berkurang.
 */
importScripts('kabut-core.js');

const CORE = self.kabutCore;
const KEY = 'kabut';
const SECRET_KEY = 'kabutSecret';

function randHex(nBytes) {
  const a = new Uint8Array(nBytes);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
  return s;
}

function getRaw() {
  return new Promise(function (res) {
    chrome.storage.local.get([KEY, SECRET_KEY], function (st) {
      res({ cfg: (st && st[KEY]) || null, secret: (st && st[SECRET_KEY]) || null });
    });
  });
}
function saveCfg(cfg) {
  return new Promise(function (res) {
    chrome.storage.local.set({ 'kabut': cfg }, function () { res(true); });
  });
}

async function ensureSecret() {
  const raw = await getRaw();
  if (raw.secret) return raw.secret;
  const s = randHex(16);
  await new Promise(function (r) { chrome.storage.local.set({ 'kabutSecret': s }, r); });
  return s;
}

async function ensureDefaults() {
  const raw = await getRaw();
  const norm = CORE.normalizeSettings(raw.cfg || {});
  /* Migrasi v2→v3: konfigurasi lama tanpa surface baru mendapatkannya
   * dari default via mergeDeep; perbandingan mentah vs ternormalisasi
   * memicu persist tepat sekali. */
  const needSave = !raw.cfg || JSON.stringify(raw.cfg) !== JSON.stringify(norm);
  if (needSave) await saveCfg(norm);
  return norm;
}

/* ---------------- DNR ---------------- */

const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'];

async function clearSessionRules() {
  const rules = await new Promise(function (res) { chrome.declarativeNetRequest.getSessionRules(res); });
  const ids = (rules || []).map(function (r) { return r.id; });
  if (ids.length) {
    await new Promise(function (res) { chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }, res); });
  }
}

let dnrStatus = { statics: [], sessionRules: 0, profile: 'real', headers: 'core' };

async function applyDnr() {
  try {
    const cfg = CORE.normalizeSettings((await getRaw()).cfg || {});
    /* Ruleset statis:
     * core = buang CH high-entropy + X-Client-Data + hint perangkat/jaringan
     *        (Device-Memory, Save-Data, Rtt, Downlink, Width, Viewport-Width,
     *        DPR) + preferensi pengguna (Sec-CH-Prefers-*) + v3: buang
     *        Accept-CH/Critical-CH dari response (memutus opt-in server).
     * strict = tambah: buang CH entropy-rendah + anti cache-tracking pihak
     *        ketiga (ETag/If-None-Match/If-Modified-Since) + DNT/Sec-GPC.
     * Saat profil UA aktif, strict dimatikan agar tidak konflik dengan
     * session rule yang justru MEN-SET CH low-entropy sesuai profil. */
    const enable = [], disable = [];
    let headersMode = cfg.headers;
    if (cfg.profile !== 'real' && headersMode === 'strict') headersMode = 'core';
    if (headersMode === 'core') { enable.push('core_headers'); disable.push('strict_headers'); }
    else if (headersMode === 'strict') { enable.push('core_headers', 'strict_headers'); }
    else { disable.push('core_headers', 'strict_headers'); }
    await new Promise(function (res) {
      chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: enable, disableRulesetIds: disable }, res);
    });

    await clearSessionRules();

    if (cfg.profile !== 'real') {
      const profile = CORE.buildProfile(navigator.userAgent, null, cfg.profile);
      const excluded = (cfg.allowlist || []).slice();
      const rule = {
        id: 9001,
        priority: 5,
        condition: { urlFilter: '*', resourceTypes: ALL_TYPES, excludedRequestDomains: excluded },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: profile.ua },
            { header: 'Sec-CH-UA', operation: 'set', value: CORE.buildChUaHeader(profile) },
            { header: 'Sec-CH-UA-Mobile', operation: 'set', value: '?0' },
            { header: 'Sec-CH-UA-Platform', operation: 'set', value: '"' + profile.chPlatform + '"' }
          ]
        }
      };
      await new Promise(function (res) { chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] }, res); });
    }

    // Laporkan status ke UI (popup/opsi).
    try {
      const enabled = await new Promise(function (res) {
        chrome.declarativeNetRequest.getEnabledRulesets(res);
      });
      const session = await new Promise(function (res) {
        chrome.declarativeNetRequest.getSessionRules(res);
      });
      dnrStatus = {
        statics: enabled || [],
        sessionRules: (session || []).length,
        profile: cfg.profile,
        headers: headersMode
      };
    } catch (e) {}
  } catch (e) { /* diam */ }
}

/* ---------------- chrome.privacy (WebRTC jaringan) ---------------- */

let webrtcPolicyStatus = 'unknown';

async function applyPrivacy() {
  const cfg = CORE.normalizeSettings((await getRaw()).cfg || {});
  try {
    if (chrome.privacy && chrome.privacy.network && chrome.privacy.network.webRTCIPHandlingPolicy) {
      const setting = chrome.privacy.network.webRTCIPHandlingPolicy;
      const value = (cfg.webrtc === 'strict' || cfg.webrtc === 'block')
        ? 'disable_non_proxied_udp'
        : (cfg.webrtc === 'balanced' ? 'default_public_interface_only' : 'default');
      await setting.set({ value: value });
      const cur = await new Promise(function (res) { setting.get({}, res); });
      webrtcPolicyStatus = (cur && cur.value) || 'unknown';
    } else {
      webrtcPolicyStatus = 'unavailable';
    }
  } catch (e) {
    webrtcPolicyStatus = 'unavailable';
  }
}

/* ---------------- broadcast ke tab ---------------- */

async function broadcastUpdate() {
  try {
    const tabs = await new Promise(function (res) { chrome.tabs.query({}, res); });
    (tabs || []).forEach(function (t) {
      try {
        chrome.tabs.sendMessage(t.id, { type: 'kabut-cfg-update' }, function () {
          void chrome.runtime.lastError;
        });
      } catch (e) {}
    });
  } catch (e) {}
}

/* ---------------- event wiring ---------------- */

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.kabut) return;
  applyDnr();
  applyPrivacy();
  broadcastUpdate();
});

chrome.runtime.onInstalled.addListener(async function () {
  await ensureSecret();
  await ensureDefaults();
  await applyDnr();
  await applyPrivacy();
});

chrome.runtime.onStartup.addListener(async function () {
  await ensureSecret();
  await applyDnr();
  await applyPrivacy();
});

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  (async function () {
    try {
      if (msg && msg.type === 'kabut-get-status') {
        const raw = await getRaw();
        respond({
          ok: true,
          cfg: CORE.normalizeSettings(raw.cfg || {}),
          hasSecret: !!raw.secret,
          webrtcPolicy: webrtcPolicyStatus,
          dnr: dnrStatus,
          version: CORE.version
        });
        return;
      }
      if (msg && msg.type === 'kabut-set-settings') {
        const raw = await getRaw();
        const next = CORE.normalizeSettings(CORE.mergeDeep(raw.cfg || {}, msg.patch || {}));
        await saveCfg(next);
        respond({ ok: true, cfg: next });
        return; // listener onChanged meneruskan efek
      }
      if (msg && msg.type === 'kabut-reroll-domain') {
        const raw = await getRaw();
        const next = CORE.normalizeSettings(raw.cfg || {});
        if (!next.domainOverrides) next.domainOverrides = {};
        next.domainOverrides[String(msg.domain || '')] = randHex(16);
        await saveCfg(next);
        respond({ ok: true });
        return;
      }
      if (msg && msg.type === 'kabut-reroll-global') {
        await new Promise(function (r) { chrome.storage.local.set({ 'kabutSecret': randHex(16) }, r); });
        const raw = await getRaw();
        const next = CORE.normalizeSettings(raw.cfg || {});
        next.domainOverrides = {};
        await saveCfg(next);
        respond({ ok: true });
        return;
      }
      if (msg && msg.type === 'kabut-wipe') {
        // Hapus seluruh data Kabut + identitas, lalu bangun ulang dari nol.
        await new Promise(function (r) { chrome.storage.local.clear(r); });
        await ensureSecret();
        await ensureDefaults();
        await applyDnr();
        await applyPrivacy();
        broadcastUpdate();
        respond({ ok: true });
        return;
      }
      respond({ ok: false, err: 'unknown-type' });
    } catch (e) {
      respond({ ok: false, err: String((e && e.message) || e) });
    }
  })();
  return true; // respons asinkron
});

/* Init saat SW terbangun (cold start oleh pesan/alarm apa pun). */
ensureSecret().then(function () { return ensureDefaults(); }).then(function () {
  applyDnr();
  applyPrivacy();
});
