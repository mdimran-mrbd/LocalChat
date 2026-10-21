// ═════════════════════════════════════════════════════════════════════
// LocalChat — chat client
// • Vanilla JS, no build step
// • E2EE for DMs (ECDH P-256 + AES-GCM, Web Crypto API)
// ═════════════════════════════════════════════════════════════════════

"use strict";

// ── utils ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stable avatar color from a username — mirrors server's pick_color_for (FNV-1a 32, lowercased).
const _AVATAR_COLORS = ["#6366f1","#8b5cf6","#ec4899","#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#06b6d4","#3b82f6"];
function userNameNode(user) {
  let profile = typeof user === "string" ? { username: user } : (user || {});
  if (!profile.designation && S.userProfiles) {
    const cached = [...S.userProfiles.values()].find(item => (item.username || "").toLowerCase() === (profile.username || "").toLowerCase());
    if (cached) profile = { ...cached, ...profile, designation: cached.designation || profile.designation };
  }
  const root = el("span", { class: "user-name-display" });
  root.append(document.createTextNode(profile.username || "Unknown"));
  if (profile.designation) root.append(el("span", { class: "user-designation" }, " • " + profile.designation));
  return root;
}

function colorForName(name) {
  if (!name) return _AVATAR_COLORS[0];
  let h = 0x811c9dc5 >>> 0;
  const s = name.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return _AVATAR_COLORS[h % _AVATAR_COLORS.length];
}

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return e;
}
function svg(path, size = 16, strokeWidth = 2) {
  return el("svg", { viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", html: `<path d="${path}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>` });
}
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDay(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "Today";
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}
function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
function sharedFileIcon(mime, name) {
  const type = String(mime || "").toLowerCase();
  const ext = String(name || "").split(".").pop().toLowerCase();
  if (type.startsWith("image/") || /^(png|jpe?g|gif|webp|svg|bmp|heic)$/.test(ext)) return "🖼️";
  if (type.startsWith("video/") || /^(mp4|mov|avi|mkv|webm)$/.test(ext)) return "🎬";
  if (type.startsWith("audio/") || /^(mp3|wav|ogg|m4a|flac)$/.test(ext)) return "🎵";
  if (ext === "pdf" || type === "application/pdf") return "📕";
  if (/^(doc|docx|odt|rtf)$/.test(ext)) return "📝";
  if (/^(xls|xlsx|csv|ods)$/.test(ext)) return "📊";
  if (/^(ppt|pptx|odp)$/.test(ext)) return "📽️";
  if (/^(zip|rar|7z|tar|gz)$/.test(ext)) return "🗜️";
  if (/^(js|ts|jsx|tsx|rs|py|java|c|cpp|html|css|json|sql|sh)$/.test(ext)) return "💻";
  return "📄";
}
function fileExt(name) {
  const i = name.lastIndexOf(".");
  if (i < 0 || i === name.length - 1) return "file";
  return name.slice(i + 1).slice(0, 4);
}
// True for short messages composed only of emoji / whitespace.
function isJumbo(text) {
  const t = text.trim();
  if (!t || t.length > 24) return false;
  // Remove emoji + variation selectors + ZWJ + whitespace; if nothing remains, it's pure emoji.
  // Use \p{Extended_Pictographic} where supported.
  try {
    const stripped = t.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\s]/gu, "");
    return stripped.length === 0;
  } catch {
    return false;
  }
}

const LINK_TOKEN_RE = /(?:https?:\/\/[^\s<>"']+|www\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[^\s<>"']*)?|(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:\/[^\s<>"']*)?)/gi;
function normalizeChatUrl(raw) {
  let value = String(raw || "").replace(/[),.!?;:]+$/, "");
  if (!value) return null;
  if (/^www\./i.test(value) || !/^https?:\/\//i.test(value)) value = "https://" + value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || !parsed.hostname.includes(".")) return null;
    return parsed.href;
  } catch { return null; }
}
function extractChatUrls(text) {
  const found = [];
  LINK_TOKEN_RE.lastIndex = 0;
  for (const match of String(text || "").matchAll(LINK_TOKEN_RE)) {
    const raw = match[0].replace(/[),.!?;:]+$/, "");
    const url = normalizeChatUrl(raw);
    if (url && !found.some(item => item.url === url)) found.push({ raw, url, index: match.index });
  }
  return found;
}
function appendLinkedText(container, text, channelId = null) {
  const source = String(text || "");
  const tokens = extractChatUrls(source).map(item => ({ ...item, kind: "url" }));
  if (channelId) {
    const users = new Map(S.users);
    if (S.me?.id) users.set(S.me.id, S.me);
    const byName = new Map([...users.values()].filter(u => u?.username && u?.id).map(u => [u.username.toLowerCase(), u]));
    for (const match of source.matchAll(/@([A-Za-z0-9._-]+)/g)) {
      const user = byName.get(match[1].toLowerCase());
      if (user) tokens.push({ raw: match[0], index: match.index, kind: "mention", user });
    }
  }
  tokens.sort((a, b) => a.index - b.index || (a.kind === "url" ? -1 : 1));
  let cursor = 0;
  for (const item of tokens) {
    if (item.index < cursor) continue;
    if (item.index > cursor) container.append(document.createTextNode(source.slice(cursor, item.index)));
    const anchor = document.createElement("a");
    if (item.kind === "mention") {
      anchor.className = "message-mention"; anchor.href = "#"; anchor.textContent = item.raw;
      anchor.title = "Open direct chat with " + item.user.username;
      anchor.setAttribute("aria-label", "Open direct chat with " + item.user.username);
      anchor.addEventListener("click", ev => { ev.preventDefault(); openDmWithUserId(item.user.id, item.user.username); });
    } else {
      anchor.className = "message-link"; anchor.href = item.url; anchor.target = "_blank";
      anchor.rel = "noopener noreferrer"; anchor.textContent = item.raw;
      anchor.setAttribute("aria-label", "Open link " + item.raw);
    }
    container.append(anchor); cursor = item.index + item.raw.length;
  }
  if (cursor < source.length) container.append(document.createTextNode(source.slice(cursor)));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, ms = 2500) {
  const t = $("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function compareVersions(a, b) {
  const left = String(a || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const right = String(b || "0").replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function checkForUpdates(currentVersion, currentBuild) {
  // Update checks are opt-in. Installing/restarting always requires a separate click.
  try {
    if (localStorage.getItem("localchat-update-checks") !== "yes") return;
  } catch { return; }
  // Only the host's own browser may offer the host executable update.
  // Other users joining over the LAN must never see an action that restarts the server.
  if (!["localhost", "127.0.0.1"].includes(location.hostname.toLowerCase())) return;
  try {
    const response = await fetch("https://api.github.com/repos/mdimran-mrbd/LocalChat/releases/latest", {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!response.ok) return;
    const release = await response.json();
    const latest = String(release.tag_name || "").replace(/^v/i, "");
    const versionOrder = compareVersions(latest, currentVersion);
    const isDevelopmentBuild = String(currentBuild || "dev") === "dev";
    // Allow a dev/test binary to move to the first official release even
    // when its Cargo package version already matches that release.
    if (!latest || versionOrder < 0 || (versionOrder === 0 && !isDevelopmentBuild)) return;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    if (!assets.some((a) => a.name === "LocalChat.exe") ||
        !assets.some((a) => a.name === "SHA256SUMS.txt")) return;
    $("updateVersion").textContent = latest;
    $("updateBanner").classList.remove("hidden");
    scheduleUpdateBannerDismiss();
  } catch {
    // Offline / rate-limited checks are intentionally silent; chat still works.
  }
}

let _updateBannerTimer = null;
function dismissUpdateBanner() { clearTimeout(_updateBannerTimer); $("updateBanner")?.classList.add("hidden"); }
function scheduleUpdateBannerDismiss() {
  clearTimeout(_updateBannerTimer);
  _updateBannerTimer = setTimeout(() => {
    const status = $("updateStatus")?.textContent || "";
    if (!/Downloading|Update requested|restart|Preparing/i.test(status)) dismissUpdateBanner();
  }, 12000);
}
$("dismissUpdateBanner")?.addEventListener("click", dismissUpdateBanner);

// Update checks are explicitly opt-in; the install action remains separately user-confirmed.
const updateConsentSection = $("updateConsentSection");
if (updateConsentSection) updateConsentSection.hidden = !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname.toLowerCase());
const updateChecksOptIn = $("updateChecksOptIn");
if (updateChecksOptIn && updateConsentSection && !updateConsentSection.hidden) {
  try { updateChecksOptIn.checked = localStorage.getItem("localchat-update-checks") === "yes"; } catch {}
  updateChecksOptIn.addEventListener("change", async () => {
    try {
      if (updateChecksOptIn.checked) {
        localStorage.setItem("localchat-update-checks", "yes");
        const info = await fetch("/api/info").then((r) => r.json());
        await checkForUpdates(info && info.version, info && info.build);
      } else {
        localStorage.removeItem("localchat-update-checks");
        $("updateBanner").classList.add("hidden");
        clearTimeout(_updateBannerTimer);
        $("updateStatus").textContent = "";
      }
    } catch {
      // An unavailable update service never interrupts chat.
    }
  });
}

$("updateNowBtn").addEventListener("click", async () => {
  const button = $("updateNowBtn");
  const status = $("updateStatus");
  clearTimeout(_updateBannerTimer);
  button.disabled = true;
  button.textContent = "Preparing…";
  status.textContent = "Downloading and verifying the release. LocalChat will restart.";
  try {
    const response = await fetch("/api/update/install", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LocalChat-Update": "1" },
      body: "{}"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not start the update.");
    button.textContent = "Restarting…";
    status.textContent = "Update requested. LocalChat will close, verify the download, and restart if successful.";
  } catch (error) {
    button.disabled = false;
    button.textContent = "Update now";
    status.textContent = "";
    toast(error.message || "Update could not be started. You can download the release manually.");
  }
});

// ── Per-server localStorage namespace ────────────────────────────────
// Every LocalChat database stamps a stable `server_id` (UUID) at first
// creation and returns it from /api/info. We keep ONE localStorage
// entry per server, keyed by that id, whose value is a JSON blob of
// every client-side setting. This means:
//   - different LocalChat networks never see each other's state
//   - wiping a server's data folder gives clients a clean bucket
//     (the new DB stamps a fresh id → a new, empty key)
//   - settings are trivially inspectable / removable per network
//
// Wire format in window.localStorage:
//   "localchat:<server_id>" -> JSON.stringify({
//       "username": "...",
//       "e2ee-kp":  "...",
//       "outbox:v1": "[...]",
//       ...
//   })
//
// Reads before bootServerId() resolves use a transient in-memory bucket
// so nothing is ever written to the wrong namespace.
const _STORE_PREFIX = "localchat:";
let _storeReady = false;
let _storeKey = null;           // full localStorage key for current server
const _pendingStore = {};       // pre-boot writes, replayed once known
let _bucketCache = null;        // last-read bucket for the current server

function _readBucket() {
  if (!_storeReady) return _pendingStore;
  if (_bucketCache) return _bucketCache;
  try {
    _bucketCache = JSON.parse(localStorage.getItem(_storeKey) || "{}") || {};
  } catch {
    _bucketCache = {};
  }
  return _bucketCache;
}
function _writeBucket() {
  if (!_storeReady || !_bucketCache) return;
  try { localStorage.setItem(_storeKey, JSON.stringify(_bucketCache)); } catch {}
}
const lstore = {
  get(key) {
    const b = _readBucket();
    return Object.prototype.hasOwnProperty.call(b, key) ? b[key] : null;
  },
  set(key, value) {
    if (!_storeReady) { _pendingStore[key] = String(value); return; }
    const b = _readBucket();
    b[key] = String(value);
    _writeBucket();
  },
  remove(key) {
    if (!_storeReady) { delete _pendingStore[key]; return; }
    const b = _readBucket();
    if (!(key in b)) return;
    delete b[key];
    _writeBucket();
  },
  // Remove every other LocalChat server bucket from this device. Useful
  // for a "forget other networks" admin button later; not called
  // automatically.
  pruneOthers() {
    if (!_storeReady) return;
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(_STORE_PREFIX) && k !== _storeKey) drop.push(k);
    }
    for (const k of drop) localStorage.removeItem(k);
  },
};
function bindServerId(id) {
  if (!id) return;
  _storeKey = _STORE_PREFIX + String(id);
  _storeReady = true;
  _bucketCache = null;
  // Replay any writes that happened before /api/info responded.
  if (Object.keys(_pendingStore).length) {
    const b = _readBucket();
    Object.assign(b, _pendingStore);
    _writeBucket();
    for (const k of Object.keys(_pendingStore)) delete _pendingStore[k];
  }
}

// ── E2EE (Web Crypto) ────────────────────────────────────────────────
// Model: each browser has a persistent ECDH P-256 keypair stored in
// localStorage. Public key (JWK) is sent to server in the `join` op and
// relayed to peers in the user list. For each DM:
//   sharedKey = HKDF(ECDH(mySK, peerPK))  →  AES-GCM-256 key
// Sender encrypts:  text → {iv, ct}  wire format "e2e:v1:<iv_b64>:<ct_b64>"
// Since ECDH(a,B)=ECDH(b,A), both sides derive the same key and can
// decrypt — including the sender's own message in their history.

const E2EE = {
  kp: null,         // { privateKey, publicKey, publicJwk }
  available: false, // false on insecure contexts (plain HTTP non-localhost)
  peerKeyCache: new Map(),  // userId → CryptoKey (imported peer pubkey)
  sharedCache: new Map(),   // userId → AES-GCM CryptoKey (derived)

  async init() {
    // Web Crypto requires a secure context (HTTPS or localhost). On plain
    // HTTP from a LAN IP, `crypto.subtle` is undefined → DMs will fall back
    // to plaintext relayed by the server (still LAN-only).
    if (!window.isSecureContext || !crypto.subtle) {
      console.warn("E2EE disabled: insecure context (use HTTPS or localhost for end-to-end encryption)");
      this.available = false;
      return;
    }
    this.available = true;
    const stored = lstore.get("e2ee-kp");
    if (stored) {
      try {
        const { privJwk, pubJwk } = JSON.parse(stored);
        const privateKey = await crypto.subtle.importKey("jwk", privJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
        const publicKey  = await crypto.subtle.importKey("jwk", pubJwk,  { name: "ECDH", namedCurve: "P-256" }, true,  []);
        this.kp = { privateKey, publicKey, publicJwk: pubJwk };
        return;
      } catch (e) {
        console.warn("E2EE: failed to restore keypair, generating new", e);
      }
    }
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
    const privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pubJwk  = await crypto.subtle.exportKey("jwk", kp.publicKey);
    lstore.set("e2ee-kp", JSON.stringify({ privJwk, pubJwk }));
    this.kp = { privateKey: kp.privateKey, publicKey: kp.publicKey, publicJwk: pubJwk };
  },

  myPubJwk() { return this.kp?.publicJwk || null; },
  myPubStr() { return this.kp ? JSON.stringify(this.kp.publicJwk) : ""; },

  async _derive(userId, peerPubKeyStr) {
    if (!this.available || !this.kp) return null;
    if (this.sharedCache.has(userId)) return this.sharedCache.get(userId);
    let peerJwk;
    try { peerJwk = JSON.parse(peerPubKeyStr); } catch { return null; }
    const peerKey = await crypto.subtle.importKey("jwk", peerJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const aes = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerKey },
      this.kp.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    this.sharedCache.set(userId, aes);
    return aes;
  },

  invalidatePeer(userId) {
    this.sharedCache.delete(userId);
    this.peerKeyCache.delete(userId);
  },

  async encryptFor(peerId, peerPubStr, plaintext) {
    if (!this.available) throw new Error("E2EE unavailable in this context");
    const key = await this._derive(peerId, peerPubStr);
    if (!key) throw new Error("peer has no E2EE key");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
      new TextEncoder().encode(plaintext)));
    return `e2e:v1:${b64(iv)}:${b64(ct)}`;
  },

  async tryDecrypt(peerId, peerPubStr, wire) {
    if (!this.available) return null;
    if (typeof wire !== "string" || !wire.startsWith("e2e:v1:")) return null;
    const parts = wire.split(":");
    if (parts.length !== 4) return null;
    try {
      const key = await this._derive(peerId, peerPubStr);
      if (!key) return null;
      const iv = unb64(parts[2]);
      const ct = unb64(parts[3]);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return new TextDecoder().decode(pt);
    } catch (e) {
      return null;
    }
  },

  // Encrypt arbitrary bytes for a DM peer. Returns { iv, ct } as Uint8Arrays.
  // Used for end-to-end encrypting file bodies before they hit /api/upload.
  async encryptBytesFor(peerId, peerPubStr, bytes) {
    if (!this.available) throw new Error("E2EE unavailable in this context");
    const key = await this._derive(peerId, peerPubStr);
    if (!key) throw new Error("peer has no E2EE key");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv }, key, bytes,
    ));
    return { iv, ct };
  },

  // Decrypt previously-encrypted bytes from a DM peer.
  async decryptBytesFrom(peerId, peerPubStr, iv, ct) {
    if (!this.available) return null;
    try {
      const key = await this._derive(peerId, peerPubStr);
      if (!key) return null;
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return new Uint8Array(pt);
    } catch {
      return null;
    }
  },
};

function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── E2EE file body decrypt cache ─────────────────────────────────────
// Keyed by the storage filename (which is unique per upload). Returns a
// blob: URL pointing at the decrypted bytes so <img>/<video>/<audio>/<a>
// can use them transparently. Misses fetch+decrypt once and memoize.
const _e2eeBlobUrlCache = new Map();
const _e2eeBlobUrlPending = new Map();
// Replace an attachment node's contents with a "Media deleted" placeholder.
// Used when the underlying file on disk is gone (HTTP 404 from /uploads/...)
// or when E2EE decrypt can't run because the ciphertext has been wiped.
function showMediaDeleted(att, realName) {
  if (!att || att.dataset.deleted === "1") return;
  att.dataset.deleted = "1";
  att.classList.add("att-deleted");
  att.replaceChildren(el("div", { class: "file deleted-file", title: "The original file is no longer on the server." }, [
    el("div", { class: "file-icon" }, "✕"),
    el("div", { class: "file-meta" }, [
      el("div", { class: "file-name" }, realName || "Media"),
      el("div", { class: "file-sub" }, "Media deleted"),
    ]),
  ]));
}

async function getDecryptedBlobUrl(storageName, fetchUrl, envelope, peer) {
  if (_e2eeBlobUrlCache.has(storageName)) return _e2eeBlobUrlCache.get(storageName);
  if (_e2eeBlobUrlPending.has(storageName)) return _e2eeBlobUrlPending.get(storageName);
  if (!peer || !peer.pubkey || !envelope?.iv) return null;
  const promise = (async () => {
    const res = await fetch(fetchUrl, { cache: "force-cache" });
    if (!res.ok) throw new Error(`fetch ${storageName} failed: ${res.status}`);
    const ct = new Uint8Array(await res.arrayBuffer());
    const iv = unb64(envelope.iv);
    const pt = await E2EE.decryptBytesFrom(peer.id, peer.pubkey, iv, ct);
    if (!pt) throw new Error("decrypt failed");
    const blob = new Blob([pt], { type: envelope.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    _e2eeBlobUrlCache.set(storageName, url);
    return url;
  })();
  _e2eeBlobUrlPending.set(storageName, promise);
  try { return await promise; }
  finally { _e2eeBlobUrlPending.delete(storageName); }
}

// ── State ────────────────────────────────────────────────────────────
const S = {
  ws: null,
  me: null,                // { id, username, avatar, color, pubkey }
  users: new Map(),        // online users by id
  userProfiles: new Map(), // known user profiles, including offline designation labels
  channels: new Map(),     // id → meta
  msgs: new Map(),         // channelId → array of wire messages (raw)
  reactions: new Map(),    // channelId → Map<msgId, Map<emoji, Set<userId>>>
  pins: new Map(),         // channelId → pinned-message metadata array
  pinsExpanded: false,
  mentions: new Map(),      // channelId → latest message ID mentioning me
  readMarks: new Map(),    // channelId → Map<userId, latestReadMsgId>
  unread: new Map(),       // channelId → count
  unreadIndicators: new Map(), // channelId → { mention, reply }
  typing: new Map(),       // channelId → Map<userId, { username, until }>
  active: "pub:general",
  hasHistory: new Set(),   // channels we've requested history for
  typingTimer: null,
  reconnectTries: 0,
  hostname: "",
  sidebarTab: "mine",
  sidebarFilter: "",
  sidebarMessageResults: [],
  searchChannel: null,
  replyTo: null,           // { channelId, msgId, username, preview }
};

// ── Boot ─────────────────────────────────────────────────────────────
(async function boot() {
  // Resolve which server we're talking to BEFORE touching localStorage,
  // so every read/write lands in the per-server bucket. Falls back to
  // a synthetic id derived from the page origin if /api/info fails —
  // still better than collapsing every server into one global bucket.
  try {
    const info = await fetch("/api/info").then((r) => r.json());
    bindServerId(info && info.server_id ? info.server_id : `origin:${location.host}`);
    S.hostname = (info && info.hostname) || "";
    const versionLabel = $("appVersionLabel");
    if (versionLabel) {
      const version = (info && info.version) || "unknown";
      const build = (info && info.build) || "dev";
      versionLabel.textContent = `Version ${version} · Build ${build}`;
    }
    void checkForUpdates(info && info.version, info && info.build);
  } catch {
    bindServerId(`origin:${location.host}`);
  }

  try { await E2EE.init(); } catch (e) { console.warn("E2EE init failed", e); }

  // Refresh speaker/headset icon when audio devices change (plug/unplug).
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => updateSpeakerIcon().catch(() => {}));
  }

  // Mobile keyboard handling is delegated to CSS `100dvh` (dynamic
  // viewport units), which Chrome 108+ / Safari 15.4+ resize correctly
  // when the soft keyboard opens. We used to override with a
  // visualViewport-driven `--vv-h`, but that fought Android Chrome's
  // own scroll-into-view behaviour and left the composer stranded mid-
  // viewport. `dvh` is simpler and more reliable.

  // Pre-fill the saved username, but never auto-connect: every join now
  // requires a password supplied by the user.
  const saved = lstore.get("username");
  if (saved) {
    $("username").value = saved;
    const pw = $("password");
    if (pw) pw.focus();
  }
})();

// ── Join flow ────────────────────────────────────────────────────────
$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const username = $("username").value.trim();
  const password = $("password").value;
  if (!username) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,23}$/.test(username)) {
    const status = $("joinStatus");
    if (status) {
      status.textContent = "Username must be 3-24 chars: letters, digits, underscore, hyphen, or dot. No spaces.";
      status.classList.add("err");
    }
    const input = $("username");
    if (input) { input.classList.add("err"); input.focus(); }
    return;
  }
  if (!password || password.length < 4) {
    const status = $("joinStatus");
    if (status) {
      status.textContent = "Password must be at least 4 characters.";
      status.classList.add("err");
    }
    const pw = $("password");
    if (pw) { pw.classList.add("err"); pw.focus(); }
    return;
  }
  lstore.set("username", username);
  connect(username, password);
});

function connect(username, password) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;
  $("joinStatus").textContent = "Connecting…";

  ws.onopen = () => {
    ws.send(JSON.stringify({
      op: "join",
      username,
      password: password || "",
      userId: lstore.get("userId") || "",
      pubkey: E2EE.myPubStr(),
    }));
    // Drain anything that was queued while the socket was down.
    flushOutbox();
  };
  ws.onmessage = (ev) => handleEvent(JSON.parse(ev.data));
  ws.onclose = () => {
    setStatus("off", "disconnected");
    if (S.me) {
      S.reconnectTries += 1;
      setStatus("warn", "reconnecting…");
      setTimeout(() => connect(S.me.username, password), Math.min(6000, 400 * S.reconnectTries));
    } else {
      const status = $("joinStatus");
      // If the server already pushed a specific error (e.g. username taken),
      // don't clobber it with a generic "Connection closed" line.
      if (status && !status.classList.contains("err")) {
        status.textContent = "Connection closed. Try again.";
      }
    }
  };
  ws.onerror = () => {
    const status = $("joinStatus");
    if (status && !status.classList.contains("err")) {
      status.textContent = "Cannot reach server.";
    }
  };
}

function setStatus(kind, label) {
  const pill = $("statusPill");
  if (!pill) return;
  pill.classList.remove("ok", "warn", "off");
  if (kind) pill.classList.add(kind);
  pill.querySelector(".txt").textContent = label;
}

// ── Browser notifications ─────────────────────────────────────────────
// Permission is granted by the browser, but snooze is deliberately session-only:
// reloading or signing in again resumes notifications automatically.
let _browserNotificationSnoozedUntil = 0;
let _browserNotificationSnoozeTimer = null;

function browserNotificationsEnabled() {
  return typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    Date.now() >= _browserNotificationSnoozedUntil;
}

function updateBrowserNotificationButton() {
  const button = $("browserNotificationsBtn");
  if (!button) return;
  const supported = "Notification" in window;
  const granted = supported && Notification.permission === "granted";
  const enabled = browserNotificationsEnabled();
  const snoozed = granted && !enabled && Date.now() < _browserNotificationSnoozedUntil;
  button.classList.toggle("active", enabled);
  button.classList.toggle("snoozed", snoozed);
  button.title = !supported ? "Browser notifications are not supported here"
    : !granted ? (Notification.permission === "denied" ? "Notifications blocked by browser" : "Enable browser notifications")
    : snoozed ? "Notifications snoozed" : "Browser notifications enabled";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-expanded", String(!!$("browserNotificationMenu") && !$("browserNotificationMenu").hidden));
  button.innerHTML = enabled
    ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>'
    : snoozed
      ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/><circle cx="18" cy="18" r="4" fill="var(--bg-1)"/><path d="M18 16v2l1.2 1"/></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/><path d="m3 3 18 18"/></svg>';
  const menu = $("browserNotificationMenu");
  if (menu) {
    const enable = menu.querySelector('[data-notification-action="enable"]');
    const resume = menu.querySelector('[data-notification-action="resume"]');
    if (enable) enable.hidden = granted;
    if (resume) resume.hidden = !snoozed;
    menu.querySelectorAll("[data-snooze-minutes]").forEach(item => { item.hidden = !granted; });
  }
}

async function enableBrowserNotifications() {
  if (!("Notification" in window)) {
    toast("This browser does not support desktop notifications.", 4000);
    return;
  }
  if (!window.isSecureContext && !["localhost", "127.0.0.1", "::1"].includes(location.hostname)) {
    toast("Browser notifications require HTTPS or LocalChat running on this device.", 5000);
    return;
  }
  if (Notification.permission === "denied") {
    toast("Notifications are blocked by your browser. Allow them in site settings, then try again.", 5000);
    return;
  }
  let permission = Notification.permission;
  if (permission === "default") {
    try { permission = await Notification.requestPermission(); }
    catch { permission = "denied"; }
  }
  if (permission !== "granted") {
    toast("Notification permission was not granted.", 3500);
    updateBrowserNotificationButton();
    return;
  }
  _browserNotificationSnoozedUntil = 0;
  clearTimeout(_browserNotificationSnoozeTimer);
  updateBrowserNotificationButton();
  toast("Browser notifications are enabled. Snoozing lasts only until you sign out or reload LocalChat.");
}

function snoozeBrowserNotifications(minutes) {
  const duration = Number(minutes);
  if (![5, 30, 60, 480].includes(duration)) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    toast("Enable browser notifications first.", 3000);
    return;
  }
  clearTimeout(_browserNotificationSnoozeTimer);
  _browserNotificationSnoozedUntil = Date.now() + duration * 60 * 1000;
  _browserNotificationSnoozeTimer = setTimeout(() => {
    _browserNotificationSnoozedUntil = 0;
    updateBrowserNotificationButton();
    toast("Browser notifications resumed.");
  }, duration * 60 * 1000);
  updateBrowserNotificationButton();
  toast("Browser notifications snoozed for " + (duration === 60 ? "1 hour" : duration === 480 ? "8 hours" : duration + " minutes") + ".");
}

function toggleBrowserNotifications() {
  const menu = $("browserNotificationMenu");
  if (!menu) return;
  menu.hidden = !menu.hidden;
  $("browserNotificationsBtn")?.setAttribute("aria-expanded", String(!menu.hidden));
}
$("browserNotificationsBtn")?.addEventListener("click", ev => {
  ev.stopPropagation();
  toggleBrowserNotifications();
});
$("browserNotificationMenu")?.addEventListener("click", async ev => {
  const action = ev.target.closest("button");
  if (!action) return;
  if (action.dataset.notificationAction === "enable") await enableBrowserNotifications();
  else if (action.dataset.notificationAction === "resume") {
    clearTimeout(_browserNotificationSnoozeTimer);
    _browserNotificationSnoozedUntil = 0;
    updateBrowserNotificationButton();
    toast("Browser notifications resumed.");
  } else if (action.dataset.snoozeMinutes) snoozeBrowserNotifications(action.dataset.snoozeMinutes);
  $("browserNotificationMenu").hidden = true;
  $("browserNotificationsBtn")?.setAttribute("aria-expanded", "false");
});
document.addEventListener("click", ev => {
  if (!ev.target.closest("#browserNotificationControl") && $("browserNotificationMenu")) {
    $("browserNotificationMenu").hidden = true;
  }
});
Object.assign(window, { toggleBrowserNotifications, enableBrowserNotifications, snoozeBrowserNotifications });

const _pendingBrowserNotifications = new Map();
function notifyIncomingMessage(m) {
  if (!browserNotificationsEnabled() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden && document.hasFocus() && m.channel === S.active) return;
  const channel = S.channels.get(m.channel);
  if (!channel || channel.notificationMode === "mute") return;
  const sender = m.username || "Someone";
  const isDm = channel.kind === "dm";
  const chatName = isDm ? (dmPeer(channel)?.username || sender) : ("#" + (channel.name || "channel"));
  Promise.resolve(messageMentionsMe(m)).then(mentioned => {
    const original = m.replyTo != null ? (S.msgs.get(m.channel) || []).find(x => String(x.id) === String(m.replyTo)) : null;
    const repliedToMe = !!original && (original.userId === S.me?.id || original.username === S.me?.username);
    // "Mention or reply only" includes both notification types.
    if ((channel.notificationMode || "all") === "mentions" && !mentioned && !repliedToMe) return;
    const detail = mentioned ? `${sender} mentioned you in ${chatName}`
      : repliedToMe ? `${sender} replied to your message in ${chatName}`
      : `New message from ${sender} in ${chatName}`;
    const pending = _pendingBrowserNotifications.get(m.channel) || {
      channelId: m.channel, count: 0, senders: new Set(), special: "", detail: "", timer: null
    };
    pending.count += 1; pending.senders.add(sender);
    if (mentioned) { pending.special = "mention"; pending.detail = detail; }
    else if (repliedToMe && pending.special !== "mention") { pending.special = "reply"; pending.detail = detail; }
    if (!pending.detail) pending.detail = detail;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      _pendingBrowserNotifications.delete(m.channel);
      try {
        const title = pending.special === "mention" ? "You were mentioned"
          : pending.special === "reply" ? "New reply to your message"
          : isDm ? `Message from ${[...pending.senders][0] || sender}` : `New messages in ${chatName}`;
        const senderNames = [...pending.senders].slice(0, 3).join(", ");
        const extraSenders = pending.senders.size > 3 ? ` and ${pending.senders.size - 3} more` : "";
        const body = pending.count > 1
          ? (pending.special ? pending.detail + ` · Plus ${pending.count - 1} other new message${pending.count > 2 ? "s" : ""}.`
            : `You have multiple notifications from ${chatName}: ${senderNames}${extraSenders} (${pending.count} new messages).`)
          : pending.detail;
        const notification = new Notification(title, { body, tag: `localchat-${m.channel}`, renotify: false });
        notification.onclick = () => { try { window.focus(); } catch {} if (S.channels.has(m.channel)) switchChannel(m.channel); notification.close(); };
      } catch (error) { console.debug("[notifications] unable to show browser notification", error); }
    }, 1800);
    _pendingBrowserNotifications.set(m.channel, pending);
  }).catch(error => console.debug("[notifications] classification failed", error));
}

Object.assign(window, { toggleBrowserNotifications });

// ── Event dispatch ───────────────────────────────────────────────────
function handleEvent(e) {
  switch (e.ev) {
    case "welcome":      return onWelcome(e);
    case "msg":          return onWireMsg(e.m);
    case "users":        return onUsers(e.users);
    case "history":      return onHistory(e);
    case "history_before": return onHistoryBefore(e);
    case "shared_items_list": return onSharedItemsList(e);
    case "search_results": return onSearchResults(e);
    case "search_all_results": return onSearchAllResults(e);
    case "saved_messages": return onSavedMessages(e);
    case "react":        return onReact(e);
    case "pin_update":   return onPinUpdate(e);
    case "ch_created":   return onChannelCreated(e.channel);
    case "ch_info":      return onChannelInfo(e);
    case "ch_updated":   return onChannelUpdated(e);
    case "ch_role_updated": return onChannelRoleUpdated(e);
    case "ch_member_removed": return onChannelMemberRemoved(e);
    case "ch_notification_set": return onChannelNotificationSet(e);
    case "ch_invited":   return onChannelInvited(e);
    case "ch_deleted":   return onChannelDeleted(e.channel);
    case "kicked":       return onKicked(e);
    case "error":        return onError(e);
    case "pong":         return;
    case "password_changed": return onPasswordChanged();
    default:             console.debug("[ev]", e);
  }
}

// The server tells us we've been disconnected by an admin (kick, ban,
// or a flush/reset). Drop our identity, show a one-shot notice, and let
// the natural reconnect loop bring up the join screen.
function onKicked(e) {
  const reason = (e && e.text) || (e && e.reason) || "removed by administrator";
  try { lstore.remove("username"); } catch {}
  S.me = null;
  setStatus("warn", "Kicked");
  if (typeof toast === "function") toast("Disconnected: " + reason);
  // Force a clean reconnect so the join screen reappears.
  try { S.ws && S.ws.close(); } catch {}
  setTimeout(() => location.reload(), 1500);
}

function onError(e) {
  if (!S.me) {
    // Server rejected our auto-join (banned, bad name, name taken, etc.).
    // Drop the saved name so the user can pick a different one, surface
    // the message in the join screen, and stop the reconnect loop.
    // Wrong-password and password-required errors leave the username
    // alone so the user can just retype their password.
    if (e.code !== "bad_password" && e.code !== "password_required" && e.code !== "password_weak") {
      lstore.remove("username");
    }
    const status = $("joinStatus");
    if (status) {
      status.textContent = e.text || "Could not join.";
      status.classList.add("err");
    }
    if (e.code === "username_taken") {
      const input = $("username");
      if (input) {
        input.value = "";
        input.focus();
        input.classList.add("err");
        input.addEventListener("input", () => {
          input.classList.remove("err");
          if (status) { status.textContent = ""; status.classList.remove("err"); }
        }, { once: true });
      }
    } else if (e.code === "bad_password" || e.code === "password_required" || e.code === "password_weak") {
      const pw = $("password");
      if (pw) {
        pw.value = "";
        pw.focus();
        pw.classList.add("err");
        pw.addEventListener("input", () => {
          pw.classList.remove("err");
          if (status) { status.textContent = ""; status.classList.remove("err"); }
        }, { once: true });
      }
    }
    // Close the socket so the onclose handler doesn't try to reconnect
    // with the same rejected name.
    try { S.ws && S.ws.close(); } catch {}
    return;
  }
  // If the change-password modal is open, surface the error inline
  // instead of as a generic toast.
  const cpwModal = $("changePwModal");
  if (cpwModal && !cpwModal.classList.contains("hidden") &&
      (e.code === "bad_password" || e.code === "password_weak")) {
    const status = $("cpwStatus");
    if (status) {
      status.textContent = e.text || "Password change failed.";
      status.classList.add("err");
      status.classList.remove("ok");
    }
    return;
  }
  toast(e.text || "Server error");
}

function onWelcome(e) {
  S.me = e.user;
  S.session = e.session || null;
  S.reconnectTries = 0;
  // Persist the server-issued UserId so a future reconnect (or a brand
  // new browser, after the user re-enters their password) can echo it
  // back and reclaim the same identity.
  try { if (S.me && S.me.id) lstore.set("userId", S.me.id); } catch {}
  setStatus("ok", "online");

  S.channels.clear();
  for (const c of e.channels) S.channels.set(c.id, c);
  S.users.clear();
  S.userProfiles.clear();
  for (const u of e.users) { S.users.set(u.id, u); S.userProfiles.set(u.id, u); }

  $("join").classList.add("hidden");
  $("app").classList.remove("hidden");
  // Show admin link only when chat is opened on the host machine itself.
  const adminLink = $("adminLink");
  if (adminLink) {
    const h = location.hostname;
    const onHost = h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
    adminLink.hidden = !onHost;
  }
  $("meChip").innerHTML = "";
  $("meChip").append(
    el("div", { class: "avatar xs", style: `background:${e.user.color}` }, e.user.avatar || "?"),
    el("div", { class: "me-info" }, [
      el("div", { class: "name" }, userNameNode(e.user)),
    ]),
    el("button", {
      id: "themeToggle",
      class: "icon-btn", title: "Toggle theme", "aria-label": "Toggle theme",
      onclick: toggleTheme,
    }),
    el("button", {
      class: "icon-btn", title: "Change password", "aria-label": "Change password",
      onclick: () => openChangePasswordModal({ forced: false }),
      html: `<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 2a5 5 0 00-5 5v3H6a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-8a2 2 0 00-2-2h-1V7a5 5 0 00-5-5zm-3 8V7a3 3 0 016 0v3H9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
    }),
    el("button", {
      class: "icon-btn", title: "Sign out", "aria-label": "Sign out",
      onclick: signOut,
      html: `<svg viewBox="0 0 24 24" width="14" height="14"><path d="M15 17l5-5-5-5M20 12H9M12 19H5a2 2 0 01-2-2V7a2 2 0 012-2h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    }),
  );

  updateThemeIcon();

  renderChannels();
  renderMembers();
  // Load each member chat's persisted notification preference on every session,
  // not only after the user opens that chat's Info panel.
  for (const channel of S.channels.values()) {
    if (channel.kind === "lobby" || (channel.members || []).includes(S.me.id)) {
      sendOp({ op: "ch_info", channel: channel.id });
    }
  }
  switchChannel(e.lobby || "pub:general");
  sendOp({ op: "saved_list" });
  S.lobby = e.lobby || "pub:general";
  if (e.mustChangePassword) {
    setTimeout(() => openChangePasswordModal({ forced: true }), 200);
  } else if (!e.user.designation) {
    setTimeout(openDesignationModal, 250);
  }
}

function onUsers(list) {
  // Detect pubkey changes → invalidate derived keys for that user
  for (const u of list) {
    const prev = S.users.get(u.id);
    if (prev && prev.pubkey !== u.pubkey) E2EE.invalidatePeer(u.id);
    // If a peer that previously had no key now has one, allow re-warn next time it's lost.
    if (u.pubkey && _warnedNoKey && _warnedNoKey.has(u.id)) _warnedNoKey.delete(u.id);
  }
  S.users.clear();
  for (const u of list) { S.users.set(u.id, u); S.userProfiles.set(u.id, u); }
  const updatedMe = list.find(u => u.id === S.me?.id);
  if (updatedMe) {
    S.me = updatedMe;
    const ownName = $("meChip")?.querySelector(".me-info .name");
    if (ownName) ownName.replaceChildren(userNameNode(updatedMe));
    if (updatedMe.designation) closeModal("designationModal");
  }
  const uc = $("userCount"); if (uc) uc.textContent = "";
  renderMembers();
  renderChannels();
  // Presence change can flip ticks from sent→delivered; refresh the visible stream.
  renderStream();
}

async function onWireMsg(m) {
  // Synthetic presence + typing markers piggyback on the broadcast bus.
  if (m.username === "__presence") {
    try { onUsers(JSON.parse(m.text).users); } catch {}
    return;
  }
  if (m.username === "__typing") {
    try { onTyping(JSON.parse(m.text)); } catch {}
    return;
  }
  if (m.username === "__react") {
    try { onReact(JSON.parse(m.text)); } catch {}
    return;
  }
  if (m.username === "__pin") {
    try { onPinUpdate(JSON.parse(m.text)); } catch {}
    return;
  }
  if (m.username === "__msg_deleted") {
    try {
      const payload = JSON.parse(m.text);
      const channel = payload.channel || m.channel;
      const arr = S.msgs.get(channel) || [];
      const at = arr.findIndex((x) => String(x.id) === String(payload.msgId));
      if (at >= 0) arr[at] = payload.message;
      arr.sort((a, b) => Number(a.id) - Number(b.id));
      S.msgs.set(channel, arr);
      S.pins.set(channel, Array.isArray(payload.pins) ? payload.pins : []);
      savedMessages = savedMessages.filter((item) => !(item.channel === channel && String(item.id) === String(payload.msgId)));
      if (channel === S.active) renderStream();
      refreshOpenSharedItems(channel);
      updateSavedCount();
    } catch (err) { console.warn("message deletion update failed", err); }
    return;
  }
  if (m.username === "__read") {
    try { onRead(JSON.parse(m.text)); } catch {}
    return;
  }
  if (m.username === "__call") {
    try { onCallSignal(JSON.parse(m.text)); } catch {}
    return;
  }
  if (m.username === "__dm_deleted") {
    try {
      const id = JSON.parse(m.text).channel || m.channel;
      onChannelDeleted(id);
    } catch {}
    return;
  }
  if (m.username === "__ch_updated") {
    try { onChannelUpdated({ ...JSON.parse(m.text), silent: true }); } catch {}
    return;
  }
  if (m.username === "__ch_photo_updated") {
    try {
      const data = JSON.parse(m.text);
      const ch = S.channels.get(data.channel);
      if (ch) {
        ch.photoUrl = data.photoUrl || "";
        if (S.active === data.channel && !$("channelInfoDrawer")?.classList.contains("hidden")) renderChannelInfo();
      }
    } catch {}
    return;
  }
  if (m.username === "__ch_member_removed") {
    try {
      const data = JSON.parse(m.text);
      if (data.forUserId === S.me?.id) {
        onChannelDeleted(data.channel);
        if (typeof toast === "function") toast("You were removed from the group.");
      }
    } catch {}
    return;
  }
  if (m.username === "__ch_deleted") {
    try {
      const id = JSON.parse(m.text).channel || m.channel;
      onChannelDeleted(id);
    } catch {}
    return;
  }
  if (m.username === "__media_deleted") {
    try {
      const { channel, ids } = JSON.parse(m.text);
      onMediaDeleted(channel || m.channel, Array.isArray(ids) ? ids : []);
    } catch {}
    return;
  }
  // Suppress noisy join/leave system messages.
  if (m.kind === "system" && /\b(joined|left) the chat\b/.test(m.text || "")) {
    return;
  }
  // If this is the server echoing back a file we just queued, drop the
  // queued copy so we don't replay it on the next reload.
  if (m.kind === "file" && m.file?.id) ackOutboxFile(m.file.id);
  const arr = S.msgs.get(m.channel) || [];
  arr.push(m);
  S.msgs.set(m.channel, arr);
  refreshOpenSharedItems(m.channel);

  const isMine = S.me && (m.userId === S.me.id || m.username === S.me.username);
  let mentionMe = false;
  let replyToMe = false;
  if (!isMine && m.kind !== "system") {
    notifyIncomingMessage(m);
    mentionMe = await messageMentionsMe(m);
    const original = m.replyTo ? (S.msgs.get(m.channel) || []).find(x => String(x.id) === String(m.replyTo)) : null;
    replyToMe = !!(original && (original.userId === S.me?.id || original.username === S.me?.username));
    if (mentionMe) {
      S.mentions.set(m.channel, String(m.id));
      updateMentionBadge();
    }
  }

  if (m.channel !== S.active) {
    S.unread.set(m.channel, (S.unread.get(m.channel) || 0) + 1);
    if (mentionMe || replyToMe) {
      const flags = S.unreadIndicators.get(m.channel) || { mention: false, reply: false };
      flags.mention = flags.mention || mentionMe;
      flags.reply = flags.reply || replyToMe;
      S.unreadIndicators.set(m.channel, flags);
    }
    renderChannels();
  } else {
    // Force-scroll if the new message is from us, or if we're already near bottom.
    if (isMine) $("messages").dataset.activeChannel = "__force";
    await renderStream();
    if (!isMine) scheduleReadReceipt();
  }
}

async function onHistory({ channel, messages, reactions, pins }) {
  const filtered = (messages || []).filter((m) =>
    !(m.kind === "system" && /\b(joined|left) the chat\b/.test(m.text || ""))
  );
  S.msgs.set(channel, filtered);
  S.hasHistory.add(channel);
  // Drop any queued file ops that the server already accepted (their
  // resulting WireMsg is now visible in history).
  for (const m of filtered) {
    if (m.kind === "file" && m.file?.id) ackOutboxFile(m.file.id);
  }
  // Hydrate reactions for this channel.
  const rmap = new Map();
  if (reactions && typeof reactions === "object") {
    for (const [msgIdStr, byEmoji] of Object.entries(reactions)) {
      const inner = new Map();
      for (const [emoji, users] of Object.entries(byEmoji || {})) {
        inner.set(emoji, new Set((users || []).map(Number)));
      }
      rmap.set(Number(msgIdStr), inner);
    }
  }
  S.reactions.set(channel, rmap);
  S.pins.set(channel, Array.isArray(pins) ? pins : []);
  if (S.active === channel) { await renderStream(); updateMentionBadge(); }
  if (_ciPendingJump && _ciPendingJump.channelId === channel) {
    if (filtered.some(m => Number(m.id) === Number(_ciPendingJump.messageId))) {
      const target = _ciPendingJump.messageId; _ciPendingJump = null; jumpToMessage(channel, target);
    }
  }
}
function onHistoryBefore({ channel, messages, hasMore }) {
  const older = Array.isArray(messages) ? messages : [];
  const current = S.msgs.get(channel) || [];
  const seen = new Set(current.map(m => Number(m.id)));
  const merged = [...older.filter(m => !seen.has(Number(m.id))), ...current]
    .sort((a, b) => Number(a.id) - Number(b.id));
  S.msgs.set(channel, merged);
  if (S.active === channel) renderStream();
  if (!_ciPendingJump || _ciPendingJump.channelId !== channel) return;
  if (merged.some(m => Number(m.id) === Number(_ciPendingJump.messageId))) {
    const target = _ciPendingJump.messageId; _ciPendingJump = null; jumpToMessage(channel, target);
  } else if (hasMore && older.length) {
    sendOp({ op: "history_before", channel, beforeId: Number(older[0].id), limit: 100 });
  } else {
    _ciPendingJump = null;
    toast("That message could not be found in the available history.", 3000);
  }
}

let messageSearchMatches = [];
let messageSearchIndex = -1;
let messageSearchQuery = "";

function openMessageSearch() {
  const ch = S.channels.get(S.active);
  if (!ch) return;
  if (ch.kind === "dm") { toast("Private messages are encrypted. Server search is disabled for DMs.", 3500); return; }
  S.searchChannel = S.active;
  messageSearchMatches = []; messageSearchIndex = -1; messageSearchQuery = "";
  $("messageSearchBtn").classList.add("hidden");
  $("messageSearchBar").classList.remove("hidden");
  $("messageSearchInput").value = ""; $("messageSearchCount").textContent = "0/0";
  $("messageSearchInput").focus();
}

function closeMessageSearch() {
  $("messageSearchBar").classList.add("hidden"); $("messageSearchBtn").classList.remove("hidden");
  S.searchChannel = null; messageSearchMatches = []; messageSearchIndex = -1; messageSearchQuery = "";
  document.querySelectorAll("#messages .msg.search-match, #messages .msg.search-current").forEach((node) => node.classList.remove("search-match", "search-current"));
  $("messageSearchInput").value = ""; $("messageSearchCount").textContent = "0/0";
}

function handleMessageSearchKeydown(event) {
  if (event.key === "Escape") { event.preventDefault(); closeMessageSearch(); return; }
  if (event.key === "Enter") {
    event.preventDefault();
    if (messageSearchMatches.length && $("messageSearchInput").value.trim() === messageSearchQuery) navigateMessageSearch(event.shiftKey ? "previous" : "next");
    else runMessageSearch();
  }
}

function runMessageSearch(event) {
  if (event) event.preventDefault();
  const query = $("messageSearchInput").value.trim();
  if (query.length < 2 || query.length > 100) { $("messageSearchCount").textContent = query.length ? "—/—" : "0/0"; return; }
  S.searchChannel = S.active; messageSearchQuery = query; messageSearchMatches = []; messageSearchIndex = -1;
  $("messageSearchCount").textContent = "…";
  document.querySelectorAll("#messages .msg.search-match, #messages .msg.search-current").forEach((node) => node.classList.remove("search-match", "search-current"));
  sendOp({ op: "search", channel: S.active, query });
}

async function onSearchResults({ channel, query, messages }) {
  if (channel !== S.active || channel !== S.searchChannel || query !== messageSearchQuery) return;
  const found = messages || [];
  messageSearchMatches = found.map((m) => String(m.id)).filter(Boolean); messageSearchIndex = -1;
  const existing = S.msgs.get(channel) || [];
  const byId = new Map(existing.map((m) => [String(m.id), m]));
  for (const m of found) byId.set(String(m.id), m);
  S.msgs.set(channel, [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id)));
  $("messageSearchCount").textContent = `0/${messageSearchMatches.length}`;
  if (!messageSearchMatches.length) { document.querySelectorAll("#messages .msg.search-match, #messages .msg.search-current").forEach((node) => node.classList.remove("search-match", "search-current")); return; }
  await renderStream(); navigateMessageSearch(0);
}

function navigateMessageSearch(direction) {
  if (!messageSearchMatches.length) return;
  if (direction === "next") messageSearchIndex = (messageSearchIndex + 1) % messageSearchMatches.length;
  else if (direction === "previous") messageSearchIndex = messageSearchIndex <= 0 ? messageSearchMatches.length - 1 : messageSearchIndex - 1;
  else messageSearchIndex = Math.max(0, Math.min(direction, messageSearchMatches.length - 1));
  document.querySelectorAll("#messages .msg.search-match, #messages .msg.search-current").forEach((node) => node.classList.remove("search-match", "search-current"));
  messageSearchMatches.forEach((id, index) => { const node = document.getElementById(`m-${S.active}-${id}`); if (node) { node.classList.add("search-match"); if (index === messageSearchIndex) node.classList.add("search-current"); } });
  const current = document.getElementById(`m-${S.active}-${messageSearchMatches[messageSearchIndex]}`);
  if (current) current.scrollIntoView({ behavior: "smooth", block: "center" });
  $("messageSearchCount").textContent = `${messageSearchIndex + 1}/${messageSearchMatches.length}`;
}

function onPinUpdate({ channel, pins }) {
  if (!channel) return;
  S.pins.set(channel, Array.isArray(pins) ? pins : []);
  if (channel === S.active) renderStream();
}

function onReact({ channel, msgId, userId, emoji, on }) {
  let perCh = S.reactions.get(channel);
  if (!perCh) { perCh = new Map(); S.reactions.set(channel, perCh); }
  let perMsg = perCh.get(msgId);
  if (!perMsg) { perMsg = new Map(); perCh.set(msgId, perMsg); }
  for (const [oldEmoji, oldUsers] of perMsg.entries()) {
    if (oldEmoji !== emoji) { oldUsers.delete(userId); if (!oldUsers.size) perMsg.delete(oldEmoji); }
  }
  let users = perMsg.get(emoji);
  if (!users) { users = new Set(); perMsg.set(emoji, users); }
  if (on) users.add(userId); else users.delete(userId);
  if (!users.size) perMsg.delete(emoji);
  if (!perMsg.size) perCh.delete(msgId);
  if (channel === S.active) renderStream();
}

function isMessagePinned(m) {
  return (S.pins.get(m.channel) || []).some((p) => String(p.id) === String(m.id));
}

function toggleMessagePin(m) {
  sendOp({ op: "pin_toggle", channel: m.channel, msgId: Number(m.id) });
}

function renderPinnedBanner(channel) {
  const pins = S.pins.get(channel) || [];
  if (!pins.length) return null;
  const banner = el("section", { class: "pinned-banner" });
  banner.append(el("button", {
    class: "pinned-banner-head", type: "button",
    "aria-expanded": S.pinsExpanded ? "true" : "false",
    onclick: () => { S.pinsExpanded = !S.pinsExpanded; renderStream(); },
  }, [el("span", {}, "📌 Pinned messages"), el("span", { class: "pinned-count" }, String(pins.length)), el("span", { class: "pinned-chevron" }, S.pinsExpanded ? "▴" : "▾")]));
  if (S.pinsExpanded) {
    const list = el("div", { class: "pinned-list" });
    for (const p of pins) {
      list.append(el("button", {
        type: "button", class: "pinned-item",
        title: "Jump to this message",
        onclick: () => {
          const loaded = (S.msgs.get(channel) || []).some((m) => String(m.id) === String(p.id));
          if (loaded) jumpToMessage(channel, Number(p.id));
          else toast("This pinned message is outside the currently loaded history.", 3500);
        },
      }, [el("strong", {}, p.username || "Message"), el("span", {}, `Message #${p.id} · pinned by ${p.pinnedByName || "a member"}`)]));
    }
    banner.append(list);
  }
  return banner;
}

function positionMessageReaction(row) {
  if (!row?.isConnected) return;
  const bubble = row.querySelector(".bubble"), button = row.querySelector(".msg-hover-reaction");
  if (!bubble || !button) return;
  const br = bubble.getBoundingClientRect(), rr = row.getBoundingClientRect();
  const width = button.offsetWidth || 34, height = button.offsetHeight || 34;
  const left = row.classList.contains("own") ? br.left - rr.left - width - 10 : br.right - rr.left + 10;
  button.style.left = `${left}px`;
  button.style.top = `${br.top - rr.top + (br.height - height) / 2}px`;
}
function closeMessageMenu(row, menu, bubble) {
  row?.classList.remove("menu-open");
  if (!menu) return;
  menu.classList.remove("menu-floating");
  for (const prop of ["left","top","maxHeight","overflowY"]) menu.style[prop] = "";
  menu.remove(); if (bubble) bubble.append(menu);
}
function toggleMessageMenu(row, menu, bubble, trigger) {
  if (!row || !menu || !bubble) return;
  if (row.classList.contains("menu-open")) { closeMessageMenu(row, menu, bubble); return; }
  document.querySelectorAll(".msg.menu-open").forEach((other) => {
    const otherMenu = other.querySelector(".msg-menu") || document.querySelector(".msg-menu.menu-floating");
    closeMessageMenu(other, otherMenu, other.querySelector(".bubble"));
  });
  row.classList.add("menu-open"); menu.classList.add("menu-floating"); document.body.append(menu);
  const tr = trigger.getBoundingClientRect(), sr = $("messages")?.getBoundingClientRect(), cr = $("sendForm")?.getBoundingClientRect();
  const viewportTop = Math.max(8, sr?.top ?? 8);
  const viewportBottom = Math.min(window.innerHeight - 8, sr?.bottom ?? window.innerHeight - 8, cr?.top ?? window.innerHeight - 8);
  const maxHeight = Math.max(1, viewportBottom - viewportTop);
  menu.style.maxHeight = `${maxHeight}px`; menu.style.overflowY = "auto";
  const mr = menu.getBoundingClientRect(), h = Math.min(mr.height || 250, maxHeight);
  const below = viewportBottom - tr.bottom - 6, above = tr.top - viewportTop - 6;
  const top = below >= h ? tr.bottom + 6 : above >= h ? tr.top - h - 6 : Math.max(viewportTop, Math.min(tr.bottom + 6, viewportBottom - h));
  const w = mr.width || 210;
  const left = row.classList.contains("own") ? Math.max(8, Math.min(innerWidth - w - 8, tr.left)) : Math.max(8, Math.min(innerWidth - w - 8, tr.right - w));
  menu.style.left = `${left}px`; menu.style.top = `${top}px`;
}
function positionMessageActions(row) {
  if (!row?.isConnected || !row.classList.contains("actions-visible")) return;
  row.classList.remove("actions-above", "actions-below");
  const bubble = row.querySelector(".bubble");
  const actions = row.querySelector(".msg-actions");
  const stream = $("messages");
  if (!bubble || !actions || !stream) return;
  const br = bubble.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  const sr = stream.getBoundingClientRect();
  const width = actions.offsetWidth || 150;
  const height = actions.offsetHeight || 38;
  const gap = 10;
  const incoming = !row.classList.contains("own");
  const leftCandidate = incoming ? br.left - width - gap : br.right + gap;
  const leftFits = incoming ? leftCandidate >= sr.left + 6 : leftCandidate + width <= sr.right - 6;
  const sideTop = br.top + (br.height - height) / 2;
  const verticalFits = sideTop >= sr.top + 6 && sideTop + height <= sr.bottom - 6;
  let left;
  let top;
  if (leftFits && verticalFits) {
    left = leftCandidate - rr.left;
    top = sideTop - rr.top;
  } else {
    // Prefer the reserved strip above the bubble. At the very top edge, use
    // a reserved strip below it instead of letting the toolbar be clipped.
    const updatedBubble = bubble.getBoundingClientRect();
    const updatedRow = row.getBoundingClientRect();
    left = Math.max(6, Math.min(updatedBubble.left - updatedRow.left, updatedRow.width - width - 6));
    const minTop = sr.top + 6 - updatedRow.top;
    const maxTop = sr.bottom - height - 6 - updatedRow.top;
    const aboveTop = updatedBubble.top - updatedRow.top - height - 8;
    if (aboveTop >= minTop && aboveTop <= maxTop) {
      top = aboveTop;
    } else {
      row.classList.add("actions-below");
      const belowBubble = bubble.getBoundingClientRect();
      const belowRow = row.getBoundingClientRect();
      const belowTop = belowBubble.bottom - belowRow.top + 8;
      top = belowTop + height <= sr.bottom - 6 - belowRow.top
        ? belowTop
        : Math.max(2, Math.min(maxTop, aboveTop));
    }
  }
  actions.style.left = `${left}px`;
  actions.style.right = "auto";
  actions.style.top = `${top}px`;
}

function repositionVisibleMessageActions() {
  document.querySelectorAll("#messages .msg").forEach(positionMessageReaction);
  document.querySelectorAll("#messages .msg.actions-visible").forEach(positionMessageActions);
}
window.addEventListener("resize", repositionVisibleMessageActions);
$("messages")?.addEventListener("scroll", repositionVisibleMessageActions, { passive: true });

function messageMentionsMe(m) {
  if (!S.me?.username || !m || m.kind === "system" || m.kind === "file") return Promise.resolve(false);
  const inspect = async () => {
    let text = String(m.text || "");
    const peer = dmPeer(S.channels.get(m.channel));
    if (peer && text.startsWith("e2e:v1:")) {
      const decrypted = await E2EE.tryDecrypt(peer.id, peer.pubkey, text);
      if (decrypted == null) return false;
      text = decrypted;
    }
    const escaped = S.me.username.replace(/[^A-Za-z0-9._-]/g, (ch) => "\\" + ch);
    return new RegExp(`(^|[^A-Za-z0-9._-])@${escaped}(?=$|[^A-Za-z0-9._-])`, "i").test(text);
  };
  return inspect().catch(() => false);
}

function updateMentionBadge() {
  const badge = $("mentionJumpBtn");
  if (!badge) return;
  const id = S.mentions.get(S.active);
  badge.classList.toggle("hidden", !id);
  badge.setAttribute("aria-hidden", id ? "false" : "true");
  badge.onclick = () => {
    const targetId = S.mentions.get(S.active);
    if (targetId == null) return;
    const node = document.getElementById(`m-${S.active}-${targetId}`);
    if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
    S.mentions.delete(S.active);
    updateMentionBadge();
  };
}

function toggleReaction(msgId, emoji) {
  if (!S.ws || S.ws.readyState !== 1) return;
  S.ws.send(JSON.stringify({
    op: "react",
    channel: S.active,
    msgId,
    emoji,
  }));
}

// Read receipts: S.readMarks: Map<channelId, Map<userId, msgId>>
function onRead({ channel, userId, msgId }) {
  if (!channel || msgId == null || userId == null) return;
  let perCh = S.readMarks.get(channel);
  if (!perCh) { perCh = new Map(); S.readMarks.set(channel, perCh); }
  const cur = perCh.get(userId) || 0;
  if (msgId > cur) perCh.set(userId, msgId);
  if (channel === S.active) renderStream();
}

let _readSendTimer = null;
function sendReadReceipt() {
  if (!S.ws || S.ws.readyState !== 1) return;
  if (document.hidden) return;
  const arr = S.msgs.get(S.active) || [];
  // Find latest non-system message id authored by someone else.
  let latest = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (m.kind === "system") continue;
    if (m.userId === S.me?.id) continue;
    if (m.id > latest) { latest = m.id; break; }
  }
  if (latest === 0) return;
  // Suppress if we've already marked this or higher locally.
  const myReads = S.readMarks.get(S.active);
  const mine = myReads?.get(S.me?.id) || 0;
  if (latest <= mine) return;
  if (myReads) myReads.set(S.me.id, latest); else S.readMarks.set(S.active, new Map([[S.me.id, latest]]));
  S.ws.send(JSON.stringify({ op: "read", channel: S.active, msgId: latest }));
}
function scheduleReadReceipt() {
  clearTimeout(_readSendTimer);
  _readSendTimer = setTimeout(sendReadReceipt, 350);
}

function onChannelCreated(ch) {
  S.channels.set(ch.id, ch);
  renderChannels();
  switchChannel(ch.id);
}

function onChannelInvited({ channel, channelName, inviter }) {
  // Server already sent ch_created right before this, so the channel is
  // in S.channels. Just surface a friendly toast — don't auto-switch
  // (could be jarring mid-conversation).
  const name = channelName || (S.channels.get(channel)?.name || channel);
  const who = inviter ? `${inviter} added you to` : "You were added to";
  toast(`${who} #${name}`);
  renderChannels();
}

function onChannelDeleted(id) {
  S.channels.delete(id);
  S.msgs.delete(id);
  S.unread.delete(id);
  S.unreadIndicators.delete(id);
  S.typing.delete(id);
  if (S.active === id) {
    // Fall back to lobby (or first remaining channel).
    const fallback = S.lobby || [...S.channels.keys()][0];
    if (fallback) switchChannel(fallback);
    else { S.active = null; renderStream(); updateHeader(); }
  }
  renderChannels();
}

// Admin deleted a media file. Patch every cached message in the given
// channel that referenced it: drop the file payload and flip it to a
// system-style "media deleted" marker, matching what the server now
// stores in the DB. If the channel is open we re-render so the change
// is visible immediately, no reload required.
function onMediaDeleted(channel, ids) {
  if (!channel || !ids || !ids.length) return;
  const arr = S.msgs.get(channel);
  if (!arr || !arr.length) return;
  const idSet = new Set(ids.map(Number));
  let touched = false;
  for (let i = 0; i < arr.length; i++) {
    const m = arr[i];
    if (!idSet.has(Number(m.id))) continue;
    arr[i] = {
      ...m,
      kind: "system",
      text: "🗑️ Media deleted by admin",
      file: null,
      deleted: true,
    };
    touched = true;
  }
  if (touched && channel === S.active) {
    $("messages").dataset.activeChannel = "__force";
    renderStream();
  }
}

function onTyping({ channel, userId, username, typing }) {
  if (userId === S.me?.id) return;
  let m = S.typing.get(channel); if (!m) { m = new Map(); S.typing.set(channel, m); }
  if (typing) m.set(userId, { username, until: Date.now() + 4000 });
  else m.delete(userId);
  renderTyping();
}

// ── Rendering ────────────────────────────────────────────────────────

// Collapsed state for sidebar groups, persisted across reloads.
// Key bumped to v2 so any previously-collapsed groups reopen on first
// load after the upgrade — sections start fully expanded by default.
const SB_COLLAPSE_KEY = "sb-collapsed-v2";
const _sbCollapsed = (() => {
  try { return new Set(JSON.parse(lstore.get(SB_COLLAPSE_KEY) || "[]")); }
  catch { return new Set(); }
})();
function _sbToggle(key, open) {
  if (open) _sbCollapsed.delete(key); else _sbCollapsed.add(key);
  lstore.set(SB_COLLAPSE_KEY, JSON.stringify([..._sbCollapsed]));
}

function _sbGroup(key, title, count, items) {
  const open = !_sbCollapsed.has(key);
  const det = el("details", { class: "sb-group", open: open ? "" : null });
  const sum = el("summary", { class: "sb-group-head" }, [
    el("span", { class: "sb-caret", html: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>` }),
    el("span", { class: "sb-group-title" }, title),
  ]);
  det.append(sum);
  if (!open) det.removeAttribute("open");
  det.addEventListener("toggle", () => _sbToggle(key, det.open));
  const ul = el("ul", { class: "chat-list" });
  for (const it of items) ul.append(it);
  det.append(ul);
  return det;
}

function _channelItem(c) {
  const active = c.id === S.active ? "active" : "";
  const pinned = isChatPinned(c.id);
  const unread = S.unread.get(c.id) || 0;
  const isMember = !!(S.me && (c.members || []).includes(S.me.id));
  const canDelete = c.kind === "group" && S.me && c.createdBy === S.me.id;
  // Creators delete (which removes for everyone). Other members can leave.
  // Lobby can't be left or deleted.
  const canLeave = c.kind === "group" && isMember && !canDelete;
  const askDelete = canDelete ? (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    confirmDialog({
      title: "Delete channel",
      body: `Delete channel #${c.name || c.id}?\n\nThis removes the channel and its history for everyone. This cannot be undone.`,
      okText: "Delete",
    }).then((ok) => { if (ok) deleteChannel(c.id); });
  } : null;
  const askLeave = canLeave ? (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    confirmDialog({
      title: "Leave channel",
      body: c.isPrivate
        ? `Leave private channel #${c.name || c.id}?\n\nYou'll need to be added back by a member to rejoin.`
        : `Leave #${c.name || c.id}?\n\nYou can rejoin any time from the Channels list.`,
      okText: "Leave",
    }).then((ok) => { if (ok) leaveChannel(c.id); });
  } : null;
  return el("li", {
    class: "chat-item " + active,
    onclick: () => switchChannel(c.id),
    oncontextmenu: askDelete || askLeave || undefined,
  }, [
    el("div", { class: "avatar", style: `background:var(--brand)` }, "#"),
    el("div", { class: "chat-meta" }, [
      el("div", { class: "chat-name" }, [pinned ? el("span", { class: "chat-pin-mark", title: "Pinned chat" }, "📌 ") : null, c.name || c.id]),
      el("div", { class: "chat-sub muted xs" },
        c.kind === "lobby" ? "lobby \u00b7 everyone" : (c.isPrivate ? "private channel" : "channel")),
    ]),
    c.kind === "group" && S.unreadIndicators.get(c.id)?.mention ? el("span", { class: "chat-unread-signal mention-signal", title: "Unread mention", "aria-label": "Unread mention" }, "@") : null,
    c.kind === "group" && S.unreadIndicators.get(c.id)?.reply ? el("span", { class: "chat-unread-signal reply-signal", title: "Unread reply to you", "aria-label": "Unread reply to you" }, "↩") : null,
    unread ? el("span", { class: "badge badge-unread" }, String(unread)) : null,
    el("button", { class: "chat-pin", type: "button", title: pinned ? "Unpin chat" : "Pin chat", "aria-label": pinned ? "Unpin chat" : "Pin chat", onclick: (ev) => { ev.stopPropagation(); toggleChatPin(c.id); } }, pinned ? "📌" : "📍"),
    canDelete ? el("button", {
      class: "chat-del",
      title: `Delete #${c.name || c.id}`,
      "aria-label": "Delete channel",
      onclick: askDelete,
      html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>`,
    }) : null,
    canLeave ? el("button", {
      class: "chat-del",
      title: `Leave #${c.name || c.id}`,
      "aria-label": "Leave channel",
      onclick: askLeave,
      html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>`,
    }) : null,
  ]);
}

function deleteChannel(channelId) {
  sendOp({ op: "ch_delete", channel: channelId });
}

function leaveChannel(channelId) {
  const ch = S.channels.get(channelId);
  sendOp({ op: "ch_leave", channel: channelId });
  // Optimistically remove ourselves locally so the sidebar updates and
  // the active view falls back to lobby if needed.
  if (ch && S.me) {
    ch.members = (ch.members || []).filter((id) => id !== S.me.id);
  }
  if (S.active === channelId) {
    const fallback = S.lobby || [...S.channels.keys()][0];
    if (fallback) switchChannel(fallback);
  }
  if (ch) S.channels.delete(channelId);
  S.msgs.delete(channelId);
  S.unread.delete(channelId);
  S.unreadIndicators.delete(channelId);
  renderChannels();
  toast(`Left #${ch?.name || channelId}`);
}

function _dmItem(c) {
  const u = dmPeer(c);
  const pinned = isChatPinned(c.id);
  const active = c.id === S.active ? "active" : "";
  const unread = S.unread.get(c.id) || 0;
  const online = !!(u && !u.offline);
  const peerName = u ? u.username : "unknown";
  const askDelete = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    confirmDialog({
      title: "Delete conversation",
      body: `Delete your conversation with ${peerName}?\n\nThis removes the chat for both of you, including all messages. This cannot be undone.`,
      okText: "Delete",
    }).then((ok) => { if (ok) deleteDm(c.id); });
  };
  return el("li", {
    class: "chat-item " + active,
    onclick: () => switchChannel(c.id),
    oncontextmenu: askDelete,
  }, [
    el("div", { class: `avatar ${online ? "avatar-online" : "avatar-offline"}`, style: `background:${u?.color || "var(--brand)"}` }, [
      document.createTextNode(u?.avatar || (u?.username?.[0] || "?").toUpperCase()),
      el("span", { class: "presence-dot" }),
    ]),
    el("div", { class: "chat-meta" }, [
      el("div", { class: "chat-name" }, [pinned ? el("span", { class: "chat-pin-mark", title: "Pinned chat" }, "📌 ") : null, userNameNode(u || { username: peerName })]),
      el("div", { class: "chat-sub muted xs" }, online ? "online" : "offline"),
    ]),
    unread ? el("span", { class: "badge badge-unread" }, String(unread)) : null,
    el("button", { class: "chat-pin", type: "button", title: pinned ? "Unpin chat" : "Pin chat", "aria-label": pinned ? "Unpin chat" : "Pin chat", onclick: (ev) => { ev.stopPropagation(); toggleChatPin(c.id); } }, pinned ? "📌" : "📍"),
    el("button", {
      class: "chat-del",
      title: `Delete conversation with ${peerName}`,
      "aria-label": "Delete conversation",
      onclick: askDelete,
      html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>`,
    }),
  ]);
}

function deleteDm(channelId) {
  sendOp({ op: "dm_delete", channel: channelId });
}

// Click an author name / avatar in any channel to open (or jump into)
// a DM with that user. Falls back to looking the user up by username
// when we don't have a live id.
function openDmWithUserId(userId, username) {
  if (S.me && (userId === S.me.id || username === S.me.username)) return;
  // If a DM channel with this user already exists locally, just switch.
  const existing = [...S.channels.values()].find((c) => {
    if (c.kind !== "dm") return null;
    if (userId != null && (c.members || []).includes(userId)) return c;
    if (username && c.dmUsers) {
      const ln = (username || "").toLowerCase();
      return c.dmUsers.some((n) => (n || "").toLowerCase() === ln) ? c : null;
    }
    return null;
  });
  if (existing) { switchChannel(existing.id); return; }
  // Otherwise ask the server to open a fresh DM. Prefer userId; fall back
  // to a username lookup against current presence.
  let id = userId;
  if (id == null && username) {
    const ln = username.toLowerCase();
    const u = [...S.users.values()].find((x) => (x.username || "").toLowerCase() === ln);
    id = u?.id;
  }
  if (id == null) { toast(`${username || "user"} is offline`); return; }
  sendOp({ op: "dm_open", user: id });
}
Object.assign(window, { openDmWithUserId });

function _personItem(u, online) {
  return el("li", {
    class: "chat-item",
    title: online ? `Message ${u.username}` : `${u.username} (offline)`,
    onclick: () => online && u.id != null
      ? sendOp({ op: "dm_open", user: u.id })
      : toast(`${u.username} is offline`),
  }, [
    el("div", { class: `avatar ${online ? "avatar-online" : "avatar-offline"}`, style: `background:${u.color || "var(--brand)"}` }, [
      document.createTextNode(u.avatar || (u.username?.[0] || "?").toUpperCase()),
      el("span", { class: "presence-dot" }),
    ]),
    el("div", { class: "chat-meta" }, [
      el("div", { class: "chat-name" }, userNameNode(u)),
      el("div", { class: "chat-sub muted xs" }, online ? "online" : "offline"),
    ]),
  ]);
}

function isChatPinned(channelId) {
  try { return (JSON.parse(lstore.get("pinned-chats") || "[]") || []).includes(channelId); } catch { return false; }
}
function toggleChatPin(channelId) {
  let pinned = [];
  try { pinned = JSON.parse(lstore.get("pinned-chats") || "[]") || []; } catch {}
  pinned = pinned.filter(id => S.channels.has(id));
  if (pinned.includes(channelId)) pinned = pinned.filter(id => id !== channelId);
  else {
    if (pinned.length >= 5) { toast("You can pin up to 5 chats. Unpin one first.", 3000); return; }
    pinned.push(channelId);
  }
  lstore.set("pinned-chats", JSON.stringify(pinned));
  renderChannels();
}

function renderChannels() {
  const root = $("sbGroups");
  if (!root) return;
  root.innerHTML = "";
  const tab = S.sidebarTab || "mine";
  const q = (S.sidebarFilter || "").trim().toLowerCase();
  const matches = (s) => !q || (s || "").toLowerCase().includes(q);

  // ── Channels ─────────────────────────────────────────────
  const channels = [];
  for (const c of S.channels.values()) {
    if (c.kind === "dm") continue;
    if (!matches(c.name || c.id)) continue;
    channels.push(c);
  }
  channels.sort((a, b) => {
    const pinDiff = Number(isChatPinned(b.id)) - Number(isChatPinned(a.id));
    if (pinDiff) return pinDiff;
    if (a.kind === "lobby") return -1;
    if (b.kind === "lobby") return 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });

  // ── DM channels (used inside Online/Offline groups for unread + history) ──
  const dmList = [...S.channels.values()].filter((c) => c.kind === "dm");

  // ── People (online + offline) ────────────────────────────
  const me = S.me;
  const myName = (me?.username || "").toLowerCase();
  const byName = new Map();
  for (const u of S.users.values()) {
    if (!me || u.id !== me.id) byName.set((u.username || "").toLowerCase(), { user: u, online: true });
  }
  for (const c of dmList) {
    if (!c.dmUsers) continue;
    for (const n of c.dmUsers) {
      const ln = (n || "").toLowerCase();
      if (!ln || ln === myName || byName.has(ln)) continue;
      byName.set(ln, {
        user: { username: n, color: colorForName(n), avatar: n[0]?.toUpperCase() || "?", offline: true },
        online: false,
      });
    }
  }
  const onlinePeople  = [...byName.values()].filter((x) =>  x.online && matches(x.user.username)).sort((a,b)=> a.user.username.localeCompare(b.user.username));
  const offlinePeople = [...byName.values()].filter((x) => !x.online && matches(x.user.username)).sort((a,b)=> a.user.username.localeCompare(b.user.username));

  // For DM tab we want DM channels grouped by online/offline (since they're conversations)
  const dmGroupedOnline  = dmList.filter((c) => {
    const p = dmPeer(c); return !!(p && !p.offline) && matches(p?.username);
  });
  const dmGroupedOffline = dmList.filter((c) => {
    const p = dmPeer(c); return !(p && !p.offline) && matches(p?.username);
  });
  const sortDm = (a, b) => Number(isChatPinned(b.id)) - Number(isChatPinned(a.id)) || (dmPeer(a)?.username || "").localeCompare(dmPeer(b)?.username || "");
  dmGroupedOnline.sort(sortDm); dmGroupedOffline.sort(sortDm);

  // ── Render based on tab ──────────────────────────────────
  if (tab === "online") {
    // Just online people — quick way to start a chat.
    const items = onlinePeople.map((x) => {
      // If a DM already exists with this peer, render the DM row (preserves unread).
      const existing = dmGroupedOnline.find(
        (c) => dmPeer(c)?.username?.toLowerCase() === x.user.username.toLowerCase()
      );
      return existing ? _dmItem(existing) : _personItem(x.user, true);
    });
    root.append(_sbGroup("online", "Online", items.length, items));
  } else if (tab === "mine") {
    // My channels and personal (DM) chats I've actually opened.
    root.append(_sbGroup("ch", "Channels", channels.length, channels.map(_channelItem)));
    const personal = [...dmGroupedOnline, ...dmGroupedOffline].sort(sortDm);
    root.append(_sbGroup("personal", "Personal", personal.length, personal.map(_dmItem)));
  } else {
    // All: channels + every DM + every person.
    root.append(_sbGroup("ch", "Channels", channels.length, channels.map(_channelItem)));
    const onlinePeopleNoDm = onlinePeople.filter((x) =>
      !dmGroupedOnline.some((c) => dmPeer(c)?.username?.toLowerCase() === x.user.username.toLowerCase()));
    const offlinePeopleNoDm = offlinePeople.filter((x) =>
      !dmGroupedOffline.some((c) => dmPeer(c)?.username?.toLowerCase() === x.user.username.toLowerCase()));
    const onlineItems  = [...dmGroupedOnline.map(_dmItem),  ...onlinePeopleNoDm.map((x) => _personItem(x.user, true))];
    const offlineItems = [...dmGroupedOffline.map(_dmItem), ...offlinePeopleNoDm.map((x) => _personItem(x.user, false))];
    root.append(_sbGroup("online",  "Online",  onlineItems.length,  onlineItems));
    root.append(_sbGroup("offline", "Offline", offlineItems.length, offlineItems));
  }

  if (S.sidebarMessageResults.length && q) {
    const results = S.sidebarMessageResults.filter(item => String(item.message?.text || item.message?.file?.name || "").toLowerCase().includes(q));
    const resultItems = results.slice(0, 20).map(item => el("li", { class: "chat-item search-result-item", title: "Open matching message", onclick: () => openSidebarSearchResult(item) }, [
      el("div", { class: "avatar", style: "background:var(--brand)" }, "#"),
      el("div", { class: "chat-meta" }, [
        el("div", { class: "chat-name" }, item.channelName || item.channelId || "Channel"),
        el("div", { class: "chat-sub muted xs" }, `${item.message?.username || "Member"}: ${String(item.message?.text || item.message?.file?.name || "Attachment").slice(0, 90)}`),
      ]),
    ]));
    root.append(_sbGroup("message-search-results", "Message matches", results.length, resultItems));
  }
  if (!root.children.length) {
    root.append(el("div", { class: "chat-empty muted xs" }, "Nothing here yet."));
  }
}

function setSidebarTab(tab) {
  if (tab === "all") tab = "mine";
  S.sidebarTab = tab;
  document.querySelectorAll(".sb-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  renderChannels();
}

function handleSidebarSearchKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const query = (S.sidebarFilter || "").trim();
  if (query.length < 2 || query.length > 100) { toast("Message search must be 2–100 characters."); return; }
  sendOp({ op: "search_all", query });
}
function onSearchAllResults(e) {
  const query = String(e.query || "");
  if (query.trim().toLowerCase() !== (S.sidebarFilter || "").trim().toLowerCase()) return;
  S.sidebarMessageResults = Array.isArray(e.results) ? e.results : [];
  renderChannels();
  if (!S.sidebarMessageResults.length) toast("No message matches found in searchable channels.", 3000);
}
function openSidebarSearchResult(result) {
  const channelId = result?.channelId;
  const message = result?.message;
  if (!channelId || !message) return;
  const existing = S.msgs.get(channelId) || [];
  if (!existing.some(m => String(m.id) === String(message.id))) {
    S.msgs.set(channelId, [...existing, message].sort((a,b) => Number(a.id) - Number(b.id)));
  }
  S.hasHistory.add(channelId);
  _ciPendingJump = { channelId, messageId: message.id };
  switchChannel(channelId);
  sendOp({ op: "history_before", channel: channelId, beforeId: Number(message.id) + 1, limit: 50 });
}

function setSidebarFilter(v) {
  S.sidebarMessageResults = [];
  S.sidebarFilter = v || "";
  const input = $("sbSearch");
  if (input && input.value !== S.sidebarFilter) input.value = S.sidebarFilter;
  const clear = $("sbSearchClear");
  if (clear) clear.hidden = !S.sidebarFilter;
  renderChannels();
}

function renderMembers() {
  // People are now folded into renderChannels' Online/Offline groups.
}

async function renderStream() {
  const box = $("messages");
  const force = box.dataset.activeChannel !== S.active;
  const atBottom = force ? true : isAtBottom(box);
  box.dataset.activeChannel = S.active;
  box.innerHTML = "";
  const arr = S.msgs.get(S.active) || [];
  const ch = S.channels.get(S.active);
  const pinnedBanner = renderPinnedBanner(S.active);
  if (pinnedBanner) box.append(pinnedBanner);

  if (arr.length === 0) {
    box.append(renderEmptyState(ch));
    updateHeader();
    return;
  }

  // Resolve DM peer (for E2EE decryption) once per render.
  const peer = dmPeer(ch);
  let prev = null;
  let prevDay = "";

  for (const m of arr) {
    const day = fmtDay(m.ts);
    if (day !== prevDay) {
      box.append(el("div", { class: "date-divider" }, el("span", {}, day)));
      prevDay = day; prev = null;
    }

    const isSystem = m.kind === "system" && !m.deleted;
    const isFollow = !isSystem
      && prev
      && prev.userId === m.userId
      && (m.ts - prev.ts) < 300 // 5 min
      && (prev.kind !== "system" || prev.deleted);

    box.append(await renderMessage(m, { follow: isFollow, peer, ch }));
    prev = m;
  }
  updateHeader();
  if (messageSearchMatches.length && S.searchChannel === S.active) {
    messageSearchMatches.forEach((id) => { const node = document.getElementById(`m-${S.active}-${id}`); if (node) node.classList.add("search-match"); });
    const currentId = messageSearchMatches[messageSearchIndex];
    if (currentId != null) document.getElementById(`m-${S.active}-${currentId}`)?.classList.add("search-current");
  }
  if (atBottom) {
    // Snap to bottom now and after layout / image loads settle.
    const snap = () => { box.scrollTop = box.scrollHeight; };
    snap();
    requestAnimationFrame(snap);
    box.querySelectorAll("img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", snap, { once: true });
    });
  }
}

function renderEmptyState(ch) {
  const isDm = ch && ch.kind === "dm";
  const title = isDm ? "Start a private conversation" : "Be the first to say something";
  const sub = isDm
    ? "Messages here are end-to-end encrypted. The server admin cannot read them."
    : "Say hi or share a file. Messages stay on this local network.";
  return el("div", { class: "stream-empty" }, [
    el("div", { class: "brand-mark", html: `<svg viewBox="0 0 32 32" width="56" height="56"><defs><linearGradient id="lcEmpty" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#lcEmpty)"/><path d="M8 10a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-5l-4 3v-3h-1a3 3 0 0 1-3-3z" fill="white"/><circle cx="13" cy="13.5" r="1.3" fill="#6366f1"/><circle cx="16" cy="13.5" r="1.3" fill="#6366f1"/><circle cx="19" cy="13.5" r="1.3" fill="#6366f1"/></svg>` }),
    el("h3", {}, title),
    el("p", {}, sub),
  ]);
}

async function renderMessage(m, { follow, peer, ch }) {
  if (m.kind === "system" && !m.deleted) {
    return el("div", { class: "msg system" },
      el("div", { class: "bubble" }, el("span", { class: "text" }, m.text)),
    );
  }

  const isOwn = m.userId === S.me?.id || (S.me && m.username === S.me.username);
  const isDm  = ch && ch.kind === "dm";

  // Decrypt DM ciphertext when possible.
  let displayText = m.deleted ? "This message was deleted." : (m.text || "");
  let encrypted = false;
  let fileRealName = null;
  if (!m.deleted && peer && displayText.startsWith("e2e:v1:")) {
    const pt = await E2EE.tryDecrypt(peer.id, peer.pubkey, displayText);
    if (pt != null) { displayText = pt; encrypted = true; }
    else displayText = "🔒 (cannot decrypt — missing key)";
  }

  // Avatar slot: only on the first incoming bubble of a group, only in non-DM.
  let avatar;
  if (isOwn || isDm || follow) {
    avatar = el("div", { class: "avatar-spacer" });
  } else {
    avatar = el("button", {
      type: "button",
      class: "avatar avatar-link",
      style: `background:${m.color || "#6366f1"}`,
      title: `Message ${m.username}`,
      onclick: (ev) => {
        ev.stopPropagation();
        openDmWithUserId(m.userId, m.username);
      },
    }, m.avatar || "?");
  }

  const bubble = el("div", { class: "bubble" });

  // Replied-to quote: render at top of the bubble. Click jumps to original.
  if (m.replyTo) {
    const orig = (S.msgs.get(m.channel) || []).find((x) => x.id === m.replyTo);
    let quoteText = "(original message unavailable)";
    let quoteName = "message";
    let quoteColor = "var(--brand)";
    if (orig) {
      const quoteProfile = S.userProfiles.get(orig.userId) || S.users.get(orig.userId);
      quoteName = (orig.username || quoteName) + (quoteProfile?.designation ? " • " + quoteProfile.designation : "");
      quoteColor = orig.color || quoteColor;
      if (orig.deleted) {
        quoteText = "This message was deleted.";
      }
      let t = orig.deleted ? "This message was deleted." : (orig.text || "");
      if (peer && t.startsWith("e2e:v1:")) {
        const pt = await E2EE.tryDecrypt(peer.id, peer.pubkey, t);
        t = pt != null ? pt : "🔒 (encrypted)";
      }
      if (orig.kind === "file") {
        // Prefer the E2EE envelope's real name when present.
        let fileName = orig.file?.originalName;
        if (peer && t && t.startsWith("{")) {
          try {
            const env = JSON.parse(t);
            if (env && env.v === 1 && env.kind === "file" && env.name) fileName = env.name;
          } catch {}
        }
        t = fileName ? `📎 ${fileName}` : "📎 attachment";
      }
      quoteText = t.length > 160 ? t.slice(0, 160) + "…" : (t || "(empty)");
    }
    const quote = el("button", {
      type: "button",
      class: "reply-quote",
      style: `border-left-color:${quoteColor}`,
      title: `Jump to ${quoteName}'s message`,
      onclick: (ev) => { ev.stopPropagation(); jumpToMessage(m.channel, m.replyTo); },
    }, [
      el("div", { class: "reply-quote-name", style: `color:${quoteColor}` }, quoteName),
      el("div", { class: "reply-quote-text" }, quoteText),
    ]);
    bubble.append(quote);
  }

  // Header row above the bubble (Teams-style):
  //  - incoming first-of-group: "Author • Time"
  //  - own first-of-group: "Time" right-aligned
  //  - DM first-of-group: "Time"
  //  - follow-up bubbles: no header
  let header = null;
  const showAuthor = !follow && !isOwn && !isDm;
  if (!follow) {
    if (showAuthor) {
      const authorIsMe = m.userId === S.me?.id;
      header = el("div", { class: "msg-header" }, [
        el(authorIsMe ? "span" : "button", {
          type: authorIsMe ? undefined : "button",
          class: "author" + (authorIsMe ? "" : " author-link"),
          style: `color:${m.color || "var(--brand)"}`,
          title: authorIsMe ? m.username : `Message ${m.username}`,
          onclick: authorIsMe ? undefined : (ev) => {
            ev.stopPropagation();
            openDmWithUserId(m.userId, m.username);
          },
        }, userNameNode(S.users.get(m.userId) || { username: m.username })),
        el("span", { class: "header-time" }, fmtTime(m.ts)),
      ]);
    } else {
      header = el("div", { class: "msg-header own-header" }, [
        el("span", { class: "header-time" }, fmtTime(m.ts)),
      ]);
    }
  }

  if (!m.deleted && m.kind === "file" && m.file) {
    const f = m.file;
    // Detect a DM E2EE envelope. When present, displayText is the JSON
    // metadata that tells us the real name/mime + the AES-GCM IV used
    // to encrypt the body.
    let envelope = null;
    if (peer && displayText && displayText.startsWith("{")) {
      try {
        const parsed = JSON.parse(displayText);
        if (parsed && parsed.v === 1 && parsed.kind === "file" && parsed.iv) {
          envelope = parsed;
          // Don't render the JSON as a caption.
          displayText = "";
        }
      } catch {}
    }

    const realName = envelope?.name || f.originalName;
    fileRealName = realName;
    const realMime = envelope?.mime || f.mimeType || "";
    const isImg   = realMime.startsWith("image/");
    const isVideo = realMime.startsWith("video/");
    const isAudio = realMime.startsWith("audio/");
    const dlUrl   = `/api/download/${encodeURIComponent(f.filename)}?name=${encodeURIComponent(realName)}`;
    const viewUrl = `/uploads/${encodeURIComponent(f.filename)}`;
    const att = el("div", { class: "attachment" });

    // For E2EE attachments, swap viewUrl/dlUrl for blob URLs after
    // decrypt completes. We start with a placeholder src and patch it
    // in once the bytes are ready. If the source file has been deleted
    // from the data folder, swap the attachment for a "Media deleted"
    // placeholder instead.
    const finalize = async (mediaEl, downloadAnchors) => {
      if (!envelope) return;
      try {
        const url = await getDecryptedBlobUrl(f.filename, viewUrl, envelope, peer);
        if (!url) return;
        if (mediaEl) mediaEl.src = url;
        for (const a of downloadAnchors) {
          a.href = url;
          a.setAttribute("download", realName);
        }
      } catch (err) {
        console.warn("e2ee file decrypt failed", err);
        showMediaDeleted(att, realName);
      }
    };

    if (isImg) {
      const img = el("img", {
        src: envelope ? "" : viewUrl,
        alt: realName,
        loading: "lazy",
        onerror: () => { if (!envelope) showMediaDeleted(att, realName); },
      });
      const dlA = el("a", { href: envelope ? "" : dlUrl, onclick: (e) => e.stopPropagation() }, "Download");
      const wrap = el("div", { class: "image-att", title: "Click to expand" }, [
        img,
        el("div", { class: "img-meta" }, [
          el("span", {}, realName),
          dlA,
        ]),
      ]);
      wrap.addEventListener("click", async () => {
        if (att.dataset.deleted === "1") return;
        if (envelope) {
          const url = await getDecryptedBlobUrl(f.filename, viewUrl, envelope, peer);
          if (url) openLightbox(url, realName, url);
        } else {
          openLightbox(viewUrl, realName, dlUrl);
        }
      });
      att.append(wrap);
      finalize(img, [dlA]);
    } else if (isVideo) {
      const video = el("video", {
        src: envelope ? "" : viewUrl,
        controls: "",
        preload: "metadata",
        playsinline: "",
        onclick: (e) => e.stopPropagation(),
        onerror: () => { if (!envelope) showMediaDeleted(att, realName); },
      });
      const dlA = el("a", { href: envelope ? "" : dlUrl, onclick: (e) => e.stopPropagation() }, "Download");
      att.append(el("div", { class: "video-att" }, [
        video,
        el("div", { class: "img-meta" }, [
          el("span", {}, realName),
          dlA,
        ]),
      ]));
      finalize(video, [dlA]);
    } else if (isAudio) {
      const audio = el("audio", {
        src: envelope ? "" : viewUrl,
        controls: "",
        preload: "metadata",
        onclick: (e) => e.stopPropagation(),
        onerror: () => { if (!envelope) showMediaDeleted(att, realName); },
      });
      const dlA = el("a", { href: envelope ? "" : dlUrl, onclick: (e) => e.stopPropagation() }, "Download");
      att.append(el("div", { class: "audio-att" }, [
        audio,
        el("div", { class: "img-meta" }, [
          el("span", {}, realName),
          dlA,
        ]),
      ]));
      finalize(audio, [dlA]);
    } else {
      const dlA = el("a", {
        class: "file", href: envelope ? "" : dlUrl,
        target: envelope ? undefined : "_blank",
        rel: "noopener",
        onclick: async (e) => {
          if (att.dataset.deleted === "1") { e.preventDefault(); return; }
          if (envelope) return; // blob URL is ready or finalize handled errors
          // Probe the source so we can show "Media deleted" if it's gone.
          try {
            const res = await fetch(viewUrl, { method: "HEAD" });
            if (!res.ok) {
              e.preventDefault();
              showMediaDeleted(att, realName);
            }
          } catch {
            e.preventDefault();
            showMediaDeleted(att, realName);
          }
        },
      }, [
        el("div", { class: "file-icon" }, fileExt(realName)),
        el("div", { class: "file-meta" }, [
          el("div", { class: "file-name" }, realName),
          el("div", { class: "file-sub" }, fmtSize(envelope?.size || f.size)),
        ]),
        el("div", { class: "file-dl", html: `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` }),
      ]);
      att.append(dlA);
      finalize(null, [dlA]);
    }
    bubble.append(att);
    if (displayText) {
      const textNode = el("div", { class: "text" });
      appendLinkedText(textNode, displayText, m.channel);
      bubble.append(textNode);
    }
  } else if (displayText) {
    const cls = isJumbo(displayText) ? "text jumbo" : "text";
    const textNode = el("div", { class: cls });
    appendLinkedText(textNode, displayText, m.channel);
    bubble.append(textNode);
  }

  // Inline meta inside bubble: only ticks (own) + lock (E2EE). Time is in the header above.
  const metaChildren = [];
  if (encrypted) {
    metaChildren.push(el("span", { class: "enc-tag", title: "End-to-end encrypted" },
      svg("M6 10V7a6 6 0 0112 0v3M5 10h14v10H5z", 10, 2)));
  }
  if (isOwn) metaChildren.push(renderTicks(computeTickState(m, ch)));
  if (metaChildren.length) bubble.append(el("div", { class: "meta" }, metaChildren));

  // Reaction bar (rendered below the text inside bubble) + hover quick-add.
  const perCh = S.reactions.get(m.channel);
  const perMsg = perCh && perCh.get(m.id);
  if (perMsg && perMsg.size) {
    const bar = el("div", { class: "reactions" });
    for (const [emoji, users] of perMsg.entries()) {
      const mine = S.me && users.has(S.me.id);
      const names = [...users].map((id) => S.users.get(id)?.username || `#${id}`).join(", ");
      bar.append(el("button", {
        class: "reaction" + (mine ? " mine" : ""),
        title: `${names} reacted with ${emoji}`,
        onclick: (ev) => { ev.stopPropagation(); toggleReaction(m.id, emoji); },
      }, [
        el("span", { class: "r-emoji" }, emoji),
        el("span", { class: "r-count" }, String(users.size)),
      ]));
    }
    bubble.append(bar);
  }

  // WhatsApp-style hover controls: reaction stays outside the bubble; arrow lives inside it.
  const savedNow = isMessageSaved(m);
  const canDeleteMessage = isOwn || ch?.kind === "group";
  const quickReaction = el("button", {
    type: "button",
    class: "msg-hover-reaction",
    title: "React",
    "aria-label": "React to message",
    onclick: (ev) => { ev.stopPropagation(); openReactionPicker(ev.currentTarget, m.id); },
    html: `<svg viewBox="0 0 24 24" width="19" height="19"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10.5" r="1.1" fill="currentColor"/><circle cx="15" cy="10.5" r="1.1" fill="currentColor"/><path d="M8.5 14.2c.8 1.3 2.1 2.1 3.5 2.1s2.7-.8 3.5-2.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  });

  const menuTrigger = el("button", {
    type: "button",
    class: "msg-menu-trigger",
    title: "Message actions",
    "aria-label": "Message actions",
    onclick: (ev) => {
      ev.stopPropagation();
      toggleMessageMenu(row, menu, bubble, ev.currentTarget);
    },
    html: `<svg viewBox="0 0 24 24" width="16" height="16"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  });
  const menu = el("div", { class: "msg-menu", role: "menu" }, [
    el("button", { type: "button", class: "msg-menu-item", onclick: (ev) => { ev.stopPropagation(); closeMessageMenu(row, menu, bubble); startReplyTo(m, displayText, fileRealName); } }, [svg("M10 9V5l-7 7 7 7v-4c5 0 8 1.5 10 5-1-7-5-11-10-11z", 16), "Reply"]),
    el("button", { type: "button", class: "msg-menu-item", onclick: (ev) => { ev.stopPropagation(); closeMessageMenu(row, menu, bubble); openForwardDialog(m, displayText, fileRealName, peer); } }, [svg("M14 5l7 7-7 7M21 12H9a6 6 0 0 0-6 6", 16), "Forward"]),
    el("button", { type: "button", class: "msg-menu-item", onclick: (ev) => { ev.stopPropagation(); closeMessageMenu(row, menu, bubble); toggleMessagePin(m); } }, [svg("M16 3l5 5-4 1-4 4-1 5-2-2-4 4-2-2 4-4-2-2 5-1 4-4z", 16), isMessagePinned(m) ? "Unpin" : "Pin"]),
    el("button", { type: "button", class: "msg-menu-item", onclick: (ev) => { ev.stopPropagation(); closeMessageMenu(row, menu, bubble); toggleMessageBookmark(m); } }, [svg("M6 4h12v17l-6-4-6 4z", 16), savedNow ? "Remove saved message" : "Save message"]),
    el("button", { type: "button", class: "msg-menu-item", onclick: async (ev) => { ev.stopPropagation(); closeMessageMenu(row, menu, bubble); try { await navigator.clipboard.writeText(displayText || fileRealName || ""); toast("Copied"); } catch { toast("Could not copy this message"); } } }, [svg("M8 8V4h12v12h-4M4 8h12v12H4z", 16), "Copy"]),
    el("button", { type: "button", class: "msg-menu-item danger", disabled: !canDeleteMessage, title: canDeleteMessage ? "Delete for everyone" : "Only the sender or group admin can delete this message", onclick: (ev) => { ev.stopPropagation(); closeMessageMenu(row, menu, bubble); if (canDeleteMessage && confirm("Delete this message for everyone? This cannot be undone.")) sendOp({ op: "delete_message", channel: m.channel, msgId: Number(m.id) }); } }, [svg("M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 10v6M14 10v6", 16), "Delete for everyone"]),
  ]);
  // Tail only on the first bubble of a group.
  const classes = ["msg"];
  if (isOwn) classes.push("own");
  if (isDm)  classes.push("dm");
  if (follow) classes.push("follow");
  else        classes.push("has-tail");

  bubble.append(menuTrigger, menu);
  const stack = el("div", { class: "msg-stack" });
  if (header) stack.append(header);
  stack.append(bubble);
  const row = el("div", { class: classes.join(" "), id: `m-${m.channel}-${m.id}` }, [avatar, stack, quickReaction]);
  row.addEventListener("mouseenter", () => {
    row.classList.add("actions-visible");
    requestAnimationFrame(() => { positionMessageReaction(row); positionMessageActions(row); });
  });
  row.addEventListener("focusin", () => {
    row.classList.add("actions-visible");
    requestAnimationFrame(() => { positionMessageReaction(row); positionMessageActions(row); });
  });
  row.addEventListener("mouseleave", (ev) => {
    if (!row.contains(ev.relatedTarget) && !menu.contains(ev.relatedTarget)) {
      row.classList.remove("actions-visible");
      // Leave the menu open if keyboard focus is still within the row.
      if (!row.contains(document.activeElement) && !menu.contains(document.activeElement)) closeMessageMenu(row, menu, bubble);
    }
  });
  row.addEventListener("focusout", (ev) => {
    if (!row.contains(ev.relatedTarget) && !menu.contains(ev.relatedTarget)) {
      row.classList.remove("actions-visible");
      closeMessageMenu(row, menu, bubble);
    }
  });
  row.addEventListener("dblclick", (ev) => {
    if (ev.target.closest("button, a, input, textarea, video, audio, .bubble, .msg-hover-reaction, .msg-menu")) return;
    ev.preventDefault();
    startReplyTo(m, displayText, fileRealName);
  });
  requestAnimationFrame(() => positionMessageReaction(row));
  return row;
}

// Compute tick state for an own message:
//   "sent"      → message is in the room, no other connected peer.
//   "delivered" → at least one other channel member is currently online.
//   "read"      → at least one other channel member has read up to this msg.
function computeTickState(m, ch) {
  if (!ch || !m || !S.me) return "sent";
  // Read?
  const reads = S.readMarks.get(m.channel);
  if (reads) {
    for (const [uid, lastId] of reads.entries()) {
      if (uid === S.me.id) continue;
      if (lastId >= m.id) return "read";
    }
  }
  // Delivered? Any other online user who can see this channel.
  const memberSet = ch.members && ch.members.length
    ? new Set(ch.members)
    : null; // lobby/general → everyone counts
  for (const uid of S.users.keys()) {
    if (uid === S.me.id) continue;
    if (!memberSet || memberSet.has(uid)) return "delivered";
  }
  return "sent";
}

// WhatsApp-style ticks. Single grey = sent; double grey = delivered; double blue = read.
function renderTicks(state) {
  const cls = "ticks " + state;
  if (state === "sent") {
    return el("span", {
      class: cls,
      html: `<svg viewBox="0 0 16 12" width="15" height="12"><path d="M1 6.5l4 4L13 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    });
  }
  // Double tick: two checkmarks with the second overlapping slightly to the right (WhatsApp style).
  return el("span", {
    class: cls,
    html: `<svg viewBox="0 0 22 12" width="20" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6.5l4 4L13 1.5"/><path d="M9 10.5l4-4M13 6.5L21 1.5"/></svg>`,
  });
}

// Quick-reaction popover (small, fixed set)
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉"];
function openReactionPicker(anchor, msgId) {
  closeReactionPicker();
  const pop = el("div", { class: "reaction-pop" });
  for (const e of QUICK_REACTIONS) {
    pop.append(el("button", {
      class: "rp-btn",
      onclick: (ev) => {
        ev.stopPropagation();
        toggleReaction(msgId, e);
        closeReactionPicker();
      },
    }, e));
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  // Position above the button, clamped to viewport.
  const popW = 280;
  let left = Math.min(window.innerWidth - popW - 8, Math.max(8, r.left + r.width / 2 - popW / 2));
  let top  = r.top - 48;
  if (top < 8) top = r.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top  = `${top}px`;
  // Dismiss on outside click / escape.
  setTimeout(() => {
    document.addEventListener("click", _rpDismiss, { once: true, capture: true });
    document.addEventListener("keydown", _rpKey);
  }, 0);
}
function closeReactionPicker() {
  document.querySelectorAll(".reaction-pop").forEach((n) => n.remove());
  document.removeEventListener("keydown", _rpKey);
}
function _rpDismiss() { closeReactionPicker(); }
function _rpKey(e) { if (e.key === "Escape") closeReactionPicker(); }

function updateHeader() {
  const ch = S.channels.get(S.active);
  const title = $("chTitle"), sub = $("chSub"), badge = $("e2eeBadge"), composer = $("msgInput");
  const avSlot = $("chAvatar");
  const callBtn = $("callBtn");
  const videoCallBtn = $("videoCallBtn");
  const joinBtn = $("joinBtn");
  const addPeopleBtn = $("addPeopleBtn");
  if (!ch) return;

  // "Join" appears for public groups the current user isn't already a member of.
  const isMember = !!(S.me && (ch.members || []).includes(S.me.id));
  if (joinBtn) joinBtn.classList.toggle("hidden", !(ch.kind === "group" && !ch.isPrivate && !isMember));
  // "Add people" appears for any group channel you're already a member of.
  // For private channels this is the ONLY way for new people to get in.
  if (addPeopleBtn) addPeopleBtn.classList.toggle("hidden", !(ch.kind === "group" && isMember));

  if (ch.kind === "dm") {
    const p = dmPeer(ch);
    title.replaceChildren(userNameNode(p || { username: "unknown" }));
    sub.textContent = p ? (p.offline ? "offline" : "online") : "";
    badge.classList.remove("hidden");
    composer.placeholder = "Type a message";
    if (avSlot) {
      avSlot.style.background = p?.color || "var(--brand)";
      avSlot.textContent = p?.avatar || (p?.username?.[0] || "?").toUpperCase();
      avSlot.classList.remove("hidden");
    }
    if (callBtn) callBtn.classList.toggle("hidden", !p);
    if (videoCallBtn) videoCallBtn.classList.toggle("hidden", !p);
  } else {
    title.textContent = "#" + (ch.name || ch.id);
    sub.textContent = ch.kind === "lobby" ? "lobby \u00b7 everyone" : (ch.isPrivate ? "private channel" : "channel");
    badge.classList.add("hidden");
    composer.placeholder = "Type a message";
    if (avSlot) {
      avSlot.style.background = "var(--brand)";
      avSlot.textContent = "#";
      avSlot.classList.remove("hidden");
    }
    if (callBtn) callBtn.classList.add("hidden");
    if (videoCallBtn) videoCallBtn.classList.add("hidden");
  }
}

function renderTyping() {
  const m = S.typing.get(S.active);
  const now = Date.now();
  const names = [];
  if (m) for (const [uid, v] of [...m.entries()]) {
    if (v.until < now) m.delete(uid); else names.push(v.username);
  }
  const row = $("typing");
  row.innerHTML = "";
  if (names.length === 0) return;
  row.append(
    el("span", { class: "dots" }, [el("span"), el("span"), el("span")]),
    document.createTextNode(` ${names.slice(0, 3).join(", ")} ${names.length === 1 ? "is" : "are"} typing…`),
  );
}
setInterval(renderTyping, 1500);

function isAtBottom(box) {
  return box.scrollTop + box.clientHeight > box.scrollHeight - 160;
}

// ── Channel switching ────────────────────────────────────────────────
function switchChannel(id) {
  S.active = id;
  updateMentionBadge();
  S.unread.set(id, 0);
  S.unreadIndicators.delete(id);
  if (S.replyTo && S.replyTo.channelId !== id) clearReplyTo();
  else renderReplyPreview();
  renderChannels();
  renderMembers();
  renderTyping();
  if (!S.hasHistory.has(id)) sendOp({ op: "history", channel: id, limit: 50 });
  renderStream();
  scheduleReadReceipt();
  $("msgInput").focus();
  if (window.matchMedia("(max-width: 780px)").matches) $("sidebar").classList.remove("open");
}

function dmPeer(ch) {
  if (!ch || ch.kind !== "dm") return null;
  // First try by member UserId (works while peer is online with current id).
  const otherId = (ch.members || []).find((m) => m !== S.me?.id);
  const byId = otherId != null ? S.users.get(otherId) : null;
  if (byId) return byId;
  // Fall back to username from the channel's dmUsers (stable across reconnects).
  if (ch.dmUsers && S.me) {
    const myName = (S.me.username || "").toLowerCase();
    const peerName = ch.dmUsers.find((n) => n && n.toLowerCase() !== myName);
    if (peerName) {
      // Try to find the live user record by username.
      for (const u of S.users.values()) {
        if (u.username && u.username.toLowerCase() === peerName.toLowerCase()) return u;
      }
      // Peer is offline — return a synthetic record so UI shows the name.
      return {
        id: otherId ?? -1,
        username: peerName,                    // original casing
        color: colorForName(peerName),         // stable color matching server
        avatar: peerName[0]?.toUpperCase() || "?",
        pubkey: null,
        offline: true,
      };
    }
  }
  return null;
}

// ── Sending ──────────────────────────────────────────────────────────
function sendOp(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

// Outbox for ops that MUST reach the server. Anything queued here is
// flushed once the WS reconnects + re-joins. Use for user-visible work
// the user thinks already "happened" (sending a chat message,
// announcing an uploaded file). Transient ops (typing, history,
// presence) intentionally use plain sendOp and are dropped if the
// socket is down.
//
// Persisted to localStorage so a page refresh during an in-flight
// upload still posts the file message once we reconnect.
const _OUTBOX_KEY = "outbox:v1";
function _loadOutbox() {
  try { return JSON.parse(lstore.get(_OUTBOX_KEY) || "[]"); }
  catch { return []; }
}
function _saveOutbox() {
  try { lstore.set(_OUTBOX_KEY, JSON.stringify(_outbox)); } catch {}
}
const _outbox = _loadOutbox();
function sendOpReliable(obj) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify(obj));
    return true;
  }
  _outbox.push(obj);
  _saveOutbox();
  toast("Offline — will send when reconnected…", 3000);
  return false;
}
// Stronger guarantee for ops where losing the message is unacceptable
// (file uploads): always queue first, send, and only drop the entry
// when the server echoes the resulting WireMsg back. The server
// dedupes by file_id so replays after a refresh are safe.
function queueAndSend(obj) {
  _outbox.push(obj);
  _saveOutbox();
  if (S.ws && S.ws.readyState === 1) {
    try { S.ws.send(JSON.stringify(obj)); } catch {}
  }
}
function ackOutboxFile(fileId) {
  if (!fileId) return;
  const before = _outbox.length;
  for (let i = _outbox.length - 1; i >= 0; i--) {
    const o = _outbox[i];
    if (o && o.op === "file" && o.file && o.file.id === fileId) {
      _outbox.splice(i, 1);
    }
  }
  if (_outbox.length !== before) _saveOutbox();
}
function flushOutbox() {
  // Re-send everything currently queued. Items remain queued until
  // explicitly acked (file ops) or until the WS frame is flushed for
  // fire-and-forget items (text sends).
  if (!S.ws || S.ws.readyState !== 1) return;
  // Snapshot to avoid mutation during send.
  const items = _outbox.slice();
  let nonFileDrained = false;
  for (const obj of items) {
    try { S.ws.send(JSON.stringify(obj)); }
    catch { return; }
    // Text ops auto-drop after send (they're idempotent enough; the
    // user sees the optimistic UI). File ops stay until echo.
    if (obj.op !== "file") {
      const idx = _outbox.indexOf(obj);
      if (idx >= 0) { _outbox.splice(idx, 1); nonFileDrained = true; }
    }
  }
  if (nonFileDrained) _saveOutbox();
}

async function sendMessage(rawText) {
  const text = rawText.trim();
  if (!text) return;
  const ch = S.channels.get(S.active);
  if (!ch) return;

  let payload = text;
  if (ch.kind === "dm") {
    const peer = dmPeer(ch); // may be null if peer is offline
    const peerId = peer?.id ?? (ch.members || []).find((m) => m !== S.me?.id);
    if (peer && peer.pubkey && E2EE.available) {
      try {
        payload = await E2EE.encryptFor(peer.id, peer.pubkey, text);
      } catch (e) {
        toast("Encryption failed: " + e.message);
        return;
      }
    } else {
      // Peer is offline, has no key, or our browser can't do Web Crypto.
      // Send plaintext (server still relays + persists). Warn once per peer.
      const key = peerId ?? "_unknown";
      if (!_warnedNoKey.has(key)) {
        _warnedNoKey.add(key);
        const why = !peer
          ? "Recipient is offline — sending unencrypted"
          : (!E2EE.available
            ? "Encryption unavailable here (use HTTPS or localhost) — sending unencrypted"
            : `${peer.username} has no encryption key — sending unencrypted`);
        toast(why);
      }
    }
  }

  const op = { op: "send", channel: S.active, text: payload };
  if (S.replyTo && S.replyTo.channelId === S.active) op.replyTo = S.replyTo.msgId;
  sendOpReliable(op);
  sendOp({ op: "typing", channel: S.active, typing: false });
  clearReplyTo();
}

// ── Reply-to ──────────────────────────────────────────────────────────

/* ── Saved messages: synced through the authenticated server account ── */
let savedMessages = [];
function getSavedMessages() { return savedMessages; }
function isMessageSaved(message) {
  return savedMessages.some((item) => item.channel === message.channel && String(item.id) === String(message.id));
}
function toggleMessageBookmark(message, button) {
  if (!message || message.kind === "system") return;
  sendOp({ op: "saved_toggle", channel: message.channel, msgId: Number(message.id) });
  if (button) button.disabled = true;
}
function updateSavedCount() {
  const button = $("savedMessagesBtn");
  if (!button) return;
  button.title = savedMessages.length ? `View saved messages (${savedMessages.length})` : "View saved messages";
  const count = $("savedMessagesCount");
  if (count) { count.textContent = savedMessages.length > 99 ? "99+" : String(savedMessages.length); count.classList.toggle("hidden", savedMessages.length === 0); }
}
function onSavedMessages(e) {
  savedMessages = Array.isArray(e.items) ? e.items : [];
  updateSavedCount();
  document.querySelectorAll("#messages .bookmark-btn").forEach((button) => {
    const node = button.closest(".msg");
    if (!node) return;
    const parts = node.id.match(/^m-(.+)-(\d+)$/);
    if (!parts) return;
    const message = { channel: parts[1], id: parts[2] };
    const active = isMessageSaved(message);
    button.disabled = false;
    button.classList.toggle("saved", active);
    button.title = active ? "Remove bookmark" : "Save message";
    button.setAttribute("aria-label", button.title);
    button.textContent = active ? "★" : "☆";
  });
  if (!$("savedMessagesOverlay")) return;
  renderSavedMessages();
}
function closeSavedMessages() { $("savedMessagesOverlay")?.remove(); }
function renderSavedMessages() {
  const overlay = $("savedMessagesOverlay");
  if (!overlay) return;
  const list = overlay.querySelector(".saved-list");
  if (!list) return;
  list.replaceChildren();
  if (!savedMessages.length) {
    list.append(el("div", { class: "saved-empty" }, "No saved messages yet. Use ☆ on any message to bookmark it."));
    return;
  }
  for (const item of savedMessages) {
    const row = el("button", { class: "saved-item", type: "button", onclick: () => {
      if (S.active !== item.channel) {
        toast(`Open #${item.channelName} to view this saved message`, 3500);
        return;
      }
      const node = document.getElementById(`m-${item.channel}-${item.id}`);
      if (node) {
        closeSavedMessages();
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("saved-jump-highlight");
        setTimeout(() => node.classList.remove("saved-jump-highlight"), 1800);
      } else {
        toast("This message isn't in the currently loaded chat history", 3000);
      }
    } }, [
      el("div", { class: "saved-item-top" }, [
        el("strong", {}, item.username || "Message"),
        el("span", { class: "saved-item-channel" }, "#" + (item.channelName || item.channel)),
      ]),
      el("div", { class: "saved-item-text" }, item.text || "(No text preview)"),
      el("span", { class: "saved-item-date" }, new Date(Number(item.ts) * 1000).toLocaleString()),
    ]);
    list.append(row);
  }
}
function openSavedMessages() {
  closeSavedMessages();
  const overlay = el("div", { id: "savedMessagesOverlay", class: "saved-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Saved messages" });
  const panel = el("section", { class: "saved-panel" });
  const header = el("div", { class: "saved-panel-header" }, [
    el("div", {}, [el("div", { class: "saved-panel-title" }, "Saved messages"), el("div", { class: "muted xs" }, "Synced to your LocalChat account")]),
    el("button", { class: "icon-btn", type: "button", title: "Close saved messages", "aria-label": "Close saved messages", onclick: closeSavedMessages }, "×"),
  ]);
  const list = el("div", { class: "saved-list" });
  panel.append(header, list); overlay.append(panel);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeSavedMessages(); });
  document.addEventListener("keydown", function onEscape(event) {
    if (event.key === "Escape") { closeSavedMessages(); document.removeEventListener("keydown", onEscape); }
  });
  document.body.append(overlay);
  renderSavedMessages();
  sendOp({ op: "saved_list" });
}

function openForwardDialog(message, displayText, fileRealName, sourcePeer) {
  if (!message || message.kind === "system" || message.deleted) return;
  if (String(message.text || "").startsWith("e2e:v1:") && String(displayText || "").startsWith("🔒 (cannot decrypt")) {
    toast("This encrypted message cannot be decrypted here, so it cannot be forwarded.", 4000);
    return;
  }
  const overlay = el("div", { class: "forward-overlay" });
  const panel = el("section", { class: "forward-panel", role: "dialog", "aria-modal": "true", "aria-label": "Forward message" });
  const search = el("input", { class: "forward-search", type: "search", placeholder: "Search people and groups…" });
  const list = el("div", { class: "forward-list" });
  const close = () => overlay.remove();
  const targets = [...S.channels.values()].filter((ch) => ch.id !== message.channel && (ch.kind === "dm" || ch.kind === "group" || ch.kind === "lobby"));
  const draw = () => {
    list.replaceChildren();
    const q = search.value.trim().toLowerCase();
    const filtered = targets.filter((ch) => {
      const title = ch.kind === "lobby" ? "general" : (ch.name || ch.id);
      return title.toLowerCase().includes(q) || ch.id.toLowerCase().includes(q);
    });
    if (!filtered.length) list.append(el("div", { class: "forward-empty" }, "No matching conversations"));
    for (const ch of filtered) {
      const title = ch.kind === "lobby" ? "# general" : (ch.kind === "dm" ? (ch.name || "Private chat") : ch.name || "Group");
      list.append(el("button", { type: "button", class: "forward-target", onclick: async () => {
        if (message.kind === "file") {
          try {
            if (!message.file?.filename) throw new Error("Attachment metadata is unavailable");
            const response = await fetch("/uploads/" + encodeURIComponent(message.file.filename));
            if (!response.ok) throw new Error("The original attachment is unavailable");
            let bytes = new Uint8Array(await response.arrayBuffer());
            let name = fileRealName || message.file.originalName || "forwarded-file";
            let mime = message.file.mimeType || "application/octet-stream";
            if (String(message.text || "").startsWith("e2e:v1:")) {
              if (!sourcePeer?.pubkey || !E2EE.available) throw new Error("The encrypted attachment cannot be decrypted here");
              const envelopeText = await E2EE.tryDecrypt(sourcePeer.id, sourcePeer.pubkey, message.text);
              if (!envelopeText) throw new Error("The attachment metadata could not be decrypted");
              const envelope = JSON.parse(envelopeText);
              if (!envelope || envelope.kind !== "file" || !envelope.iv) throw new Error("Invalid encrypted attachment metadata");
              const plain = await E2EE.decryptBytesFrom(sourcePeer.id, sourcePeer.pubkey, unb64(envelope.iv), bytes);
              if (!plain) throw new Error("The attachment could not be decrypted");
              bytes = plain;
              name = envelope.name || name;
              mime = envelope.mime || mime;
            }
            const forwardedFile = new File([bytes], name, { type: mime });
            const uploaded = await uploadFile(forwardedFile, ch.id);
            if (!uploaded) return;
            close();
            toast("Attachment forwarded");
          } catch (err) {
            toast("Could not forward attachment: " + (err.message || "unknown error"), 4000);
          }
          return;
        }
        let text = String(displayText || "");
        if (ch.kind === "dm") {
          const destPeer = dmPeer(ch);
          if (destPeer?.pubkey && E2EE.available) {
            try { text = await E2EE.encryptFor(destPeer.id, destPeer.pubkey, "↪ Forwarded\n" + text); }
            catch { toast("Could not encrypt this forwarded message for the recipient"); return; }
          } else if (text.startsWith("e2e:v1:")) {
            toast("This private message could not be decrypted for forwarding"); return;
          } else {
            text = "↪ Forwarded\n" + text;
          }
        } else {
          text = "↪ Forwarded\n" + text;
        }
        if (text.length > 4096) { toast("This message is too long to forward"); return; }
        sendOp({ op: "send", channel: ch.id, text });
        close();
        toast("Message forwarded");
      } }, [el("span", { class: "forward-target-icon" }, ch.kind === "dm" ? "●" : "#"), el("span", { class: "forward-target-name" }, title), el("span", { class: "forward-target-kind" }, ch.kind === "dm" ? "Direct message" : ch.kind === "group" ? "Group" : "Public")]));
    }
  };
  panel.append(el("div", { class: "forward-head" }, [el("strong", {}, "Forward message"), el("button", { type: "button", class: "forward-close", "aria-label": "Close", onclick: close }, "×")]), search, list);
  overlay.append(panel);
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  search.addEventListener("input", draw);
  document.addEventListener("keydown", function esc(ev) { if (ev.key === "Escape" && overlay.isConnected) { close(); document.removeEventListener("keydown", esc); } });
  document.body.append(overlay);
  draw();
  search.focus();
}

function startReplyTo(m, plainText, fileRealName) {
  if (!m || m.kind === "system") return;
  const txt = (plainText != null ? plainText : (m.text || "")).toString();
  const fileName = fileRealName || m.file?.originalName;
  const preview = m.kind === "file"
    ? (fileName ? `📎 ${fileName}` : "📎 attachment")
    : (txt.length > 140 ? txt.slice(0, 140) + "…" : txt);
  S.replyTo = {
    channelId: m.channel,
    msgId: m.id,
    username: m.username || "",
    preview,
  };
  renderReplyPreview();
  $("msgInput").focus();
}
function clearReplyTo() {
  if (!S.replyTo) return;
  S.replyTo = null;
  renderReplyPreview();
}
function renderReplyPreview() {
  const box = $("replyPreview");
  if (!box) return;
  if (!S.replyTo || S.replyTo.channelId !== S.active) {
    box.classList.add("hidden");
    return;
  }
  $("replyPreviewName").textContent = S.replyTo.username || "message";
  $("replyPreviewText").textContent = S.replyTo.preview || "";
  box.classList.remove("hidden");
}
Object.assign(window, { startReplyTo, clearReplyTo });

function jumpToMessage(channelId, msgId) {
  if (channelId !== S.active) switchChannel(channelId);
  const tryScroll = (tries) => {
    const node = document.getElementById(`m-${channelId}-${msgId}`);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      node.classList.add("msg-flash");
      setTimeout(() => node.classList.remove("msg-flash"), 1600);
    } else if (tries > 0) {
      setTimeout(() => tryScroll(tries - 1), 80);
    }
  };
  tryScroll(8);
}
Object.assign(window, { jumpToMessage });
const _warnedNoKey = new Set();

// Composer
const msgInput = $("msgInput");
$("replyPreviewClose")?.addEventListener("click", () => clearReplyTo());

// @mention autocomplete. Mentions are sent as literal @usernames, which keeps
// the wire format compatible with existing messages and mention notifications.
const mentionPicker = el("div", { id: "mentionPicker", class: "mention-picker hidden", role: "listbox", "aria-label": "Mention a user" });
$("sendForm").append(mentionPicker);
let mentionCandidates = [];
let mentionActiveIndex = 0;
let mentionToken = null;

function closeMentionPicker() {
  mentionToken = null;
  mentionCandidates = [];
  mentionActiveIndex = 0;
  mentionPicker.classList.add("hidden");
  mentionPicker.replaceChildren();
}
function getMentionToken() {
  const caret = msgInput.selectionStart ?? msgInput.value.length;
  const before = msgInput.value.slice(0, caret);
  const match = before.match(/(^|\s)@([A-Za-z0-9._-]*)$/);
  if (!match) return null;
  return { start: caret - match[2].length - 1, end: caret, query: match[2] };
}
function updateMentionPicker() {
  const token = getMentionToken();
  if (!token) { closeMentionPicker(); return; }
  const query = token.query.toLowerCase();
  const candidates = [...S.users.values()]
    .filter((u) => u.username && u.username.toLowerCase() !== (S.me?.username || "").toLowerCase())
    .filter((u) => u.username.toLowerCase().startsWith(query))
    .sort((a, b) => a.username.localeCompare(b.username))
    .slice(0, 8);
  if (!candidates.length) { closeMentionPicker(); return; }
  mentionToken = token;
  mentionCandidates = candidates;
  mentionActiveIndex = Math.min(mentionActiveIndex, candidates.length - 1);
  mentionPicker.replaceChildren(...candidates.map((u, i) => {
    const item = el("button", {
      type: "button",
      class: "mention-option" + (i === mentionActiveIndex ? " active" : ""),
      role: "option",
      "aria-selected": i === mentionActiveIndex ? "true" : "false",
      onmousedown: (ev) => { ev.preventDefault(); insertMention(u.username); },
    }, [
      el("span", { class: "mention-option-avatar", style: `background:${u.color || colorForName(u.username)}` }, (u.avatar || u.username[0] || "?").toUpperCase()),
      el("span", { class: "mention-option-name" }, "@" + u.username),
      el("span", { class: "mention-option-status" }, u.online ? "online" : ""),
    ]);
    return item;
  }));
  mentionPicker.classList.remove("hidden");
}
function insertMention(username) {
  if (!mentionToken) return;
  const { start, end } = mentionToken;
  const before = msgInput.value.slice(0, start);
  const after = msgInput.value.slice(end);
  const inserted = "@" + username + " ";
  msgInput.value = before + inserted + after;
  const caret = before.length + inserted.length;
  msgInput.focus();
  msgInput.setSelectionRange(caret, caret);
  autoGrow(msgInput);
  closeMentionPicker();
}
function moveMentionSelection(delta) {
  if (mentionPicker.classList.contains("hidden") || !mentionCandidates.length) return false;
  mentionActiveIndex = (mentionActiveIndex + delta + mentionCandidates.length) % mentionCandidates.length;
  [...mentionPicker.querySelectorAll(".mention-option")].forEach((item, i) => {
    item.classList.toggle("active", i === mentionActiveIndex);
    item.setAttribute("aria-selected", i === mentionActiveIndex ? "true" : "false");
  });
  return true;
}
function chooseMentionSelection() {
  if (mentionPicker.classList.contains("hidden") || !mentionCandidates.length) return false;
  insertMention(mentionCandidates[mentionActiveIndex].username);
  return true;
}

msgInput.addEventListener("input", () => {
  autoGrow(msgInput);
  mentionActiveIndex = 0;
  updateMentionPicker();
  if (S.typingTimer) clearTimeout(S.typingTimer);
  sendOp({ op: "typing", channel: S.active, typing: true });
  S.typingTimer = setTimeout(() => sendOp({ op: "typing", channel: S.active, typing: false }), 2500);
});
msgInput.addEventListener("click", updateMentionPicker);
msgInput.addEventListener("keyup", (e) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateMentionPicker();
});
msgInput.addEventListener("keydown", (e) => {
  if (!mentionPicker.classList.contains("hidden")) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveMentionSelection(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveMentionSelection(-1); return; }
    if (e.key === "Enter" && !e.shiftKey && chooseMentionSelection()) { e.preventDefault(); return; }
    if (e.key === "Escape") { e.preventDefault(); closeMentionPicker(); return; }
  }
  if (e.key === "Escape" && S.replyTo) {
    e.preventDefault();
    clearReplyTo();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const v = msgInput.value;
    msgInput.value = "";
    closeMentionPicker();
    autoGrow(msgInput);
    sendMessage(v);
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#mentionPicker") && e.target !== msgInput) closeMentionPicker();
});
$("sendForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = msgInput.value;
  msgInput.value = "";
  closeMentionPicker();
  autoGrow(msgInput);
  sendMessage(v);
});
function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(200, ta.scrollHeight) + "px";
}

// File uploads — note: file content itself travels over HTTP (not WS).
// For group/lobby channels the file lives in /uploads/ and admin CAN see
// it. For DMs we encrypt the bytes client-side with the same ECDH-derived
// AES-GCM key used for text, so the server only stores opaque ciphertext.
// The original filename + mime travel inside an E2EE envelope in `text`.
$("fileInput").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  await uploadFile(f);
  e.target.value = "";
});

// ── Modals ───────────────────────────────────────────────────────────
function openCreateChannel() {
  $("createModal").classList.remove("hidden");
  $("newChName").focus();
}
function closeModal(id) { $(id).classList.add("hidden"); }
function openModal(id) { const m = $(id); if (m) m.classList.remove("hidden"); }

// ── Sidebar "+" menu (new channel / new DM) ─────────────────────────
function toggleNewMenu(ev) {
  if (ev) ev.stopPropagation();
  const menu = $("sbNewMenu");
  const btn = $("sbNewBtn");
  if (!menu || !btn) return;
  const willOpen = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !willOpen);
  btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  if (willOpen) {
    document.addEventListener("click", _newMenuOutside, true);
    document.addEventListener("keydown", _newMenuKey, true);
  } else {
    closeNewMenu();
  }
}
function closeNewMenu() {
  const menu = $("sbNewMenu");
  const btn = $("sbNewBtn");
  if (menu) menu.classList.add("hidden");
  if (btn) btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", _newMenuOutside, true);
  document.removeEventListener("keydown", _newMenuKey, true);
}
function _newMenuOutside(e) {
  const menu = $("sbNewMenu"); const btn = $("sbNewBtn");
  if (!menu || menu.classList.contains("hidden")) return;
  if (menu.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeNewMenu();
}
function _newMenuKey(e) { if (e.key === "Escape") closeNewMenu(); }
Object.assign(window, { toggleNewMenu, closeNewMenu });

// ── Confirm dialog (returns Promise<boolean>) ────────────────────────
let _cfResolve = null;
function confirmDialog({ title = "Confirm", body = "", okText = "Delete", okClass = "btn-danger", cancelText = "Cancel" } = {}) {
  return new Promise((resolve) => {
    _cfResolve = resolve;
    $("cfTitle").textContent = title;
    $("cfBody").textContent = body;
    const ok = $("cfOk");
    ok.textContent = okText;
    ok.className = "btn " + okClass;
    $("cfCancel").textContent = cancelText;
    $("confirmModal").classList.remove("hidden");
    setTimeout(() => ok.focus(), 0);
  });
}
function closeConfirm(result) {
  $("confirmModal").classList.add("hidden");
  const r = _cfResolve; _cfResolve = null;
  if (r) r(!!result);
}
Object.assign(window, { closeConfirm });

// ─── Share / pair modal ───────────────────────────────────────────────
async function openShareModal() {
  const m = $("shareModal");
  const host = $("shareGridUser");
  if (!m || !host) return;
  host.innerHTML = `<p class="muted sm">Loading…</p>`;
  m.classList.remove("hidden");
  try {
    const r = await fetch("/api/share").then((r) => r.json());
    const entries = r.entries || [];
    if (!entries.length) { host.innerHTML = `<p class="muted">No reachable addresses detected.</p>`; return; }
    host.innerHTML = entries.map((e) => `
      <div class="share-card">
        <div class="share-qr">${e.qr}</div>
        <div class="share-meta">
          <div class="share-label">${escapeHtml(e.label)}</div>
          <a class="share-url" href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.url)}</a>
          <div class="share-actions">
            <button type="button" class="btn btn-ghost" data-act="copy" data-url="${escapeHtml(e.url)}">Copy link</button>
            <button type="button" class="btn btn-ghost" data-act="open" data-url="${escapeHtml(e.url)}">Open</button>
          </div>
        </div>
      </div>`).join("");
    host.onclick = async (ev) => {
      const btn = ev.target.closest("button"); if (!btn) return;
      const url = btn.dataset.url;
      if (btn.dataset.act === "copy") {
        try { await navigator.clipboard.writeText(url); toast("Link copied"); }
        catch { toast("Copy failed"); }
      } else if (btn.dataset.act === "open") {
        window.open(url, "_blank", "noopener");
      }
    };
  } catch (err) {
    host.innerHTML = `<p class="muted">Failed to load: ${escapeHtml(String(err && err.message || err))}</p>`;
  }
}
function closeShareModal() { $("shareModal").classList.add("hidden"); }
Object.assign(window, { openShareModal, closeShareModal });

function createChannel(e) {
  e.preventDefault();
  const name = $("newChName").value.trim();
  const isPrivate = $("newChPrivate").checked;
  if (!name) return;
  sendOp({ op: "ch_create", name, private: isPrivate });
  closeModal("createModal");
  $("newChName").value = ""; $("newChPrivate").checked = false;
}

function openDmPicker() {
  const list = $("dmPickList"); list.innerHTML = "";
  const users = [...S.users.values()].filter((u) => u.id !== S.me?.id);
  users.sort((a, b) => a.username.localeCompare(b.username));
  if (users.length === 0) {
    list.append(el("li", { class: "muted sm" }, "No one else is online right now."));
  }
  for (const u of users) {
    const canE2ee = !!u.pubkey;
    list.append(el("li", {
      onclick: () => { sendOp({ op: "dm_open", user: u.id }); closeModal("dmModal"); },
    }, [
      el("div", { class: "avatar xs", style: `background:${u.color}` }, u.avatar || "?"),
      el("span", {}, u.username),
      el("span", { class: "e2ee" + (canE2ee ? " ok" : "") }, [
        svg("M6 10V7a6 6 0 0112 0v3M5 10h14v10H5z", 12, 2),
        canE2ee ? "encrypted" : "no key",
      ]),
    ]));
  }
  $("dmModal").classList.remove("hidden");
}

// ── Self-join a public group channel ────────────────────────────────
function joinCurrentChannel() {
  const ch = S.channels.get(S.active);
  if (!ch || ch.kind !== "group" || ch.isPrivate) return;
  if (S.me && (ch.members || []).includes(S.me.id)) return;
  sendOp({ op: "ch_join", channel: ch.id });
  // Optimistically reflect membership so the Join button hides immediately.
  if (S.me) {
    ch.members = ch.members || [];
    if (!ch.members.includes(S.me.id)) ch.members.push(S.me.id);
  }
  toast(`Joined #${ch.name || ch.id}`);
  updateHeader();
  renderMembers();
}

Object.assign(window, { joinCurrentChannel });

// ── Add people to a group channel (works for public + private) ──────
const _inv = { selected: new Set() };
function openInviteModal() {
  const ch = S.channels.get(S.active);
  if (!ch || ch.kind !== "group") return;
  if (!S.me || !(ch.members || []).includes(S.me.id)) return;
  _inv.selected.clear();
  const sub = $("invSub");
  if (sub) sub.textContent = ch.isPrivate
    ? `Add people to private channel #${ch.name || ch.id}. Only members can see it.`
    : `Add people to #${ch.name || ch.id}.`;
  $("invSearch").value = "";
  renderInviteList();
  $("inviteModal").classList.remove("hidden");
  setTimeout(() => $("invSearch").focus(), 0);
}

function renderInviteList() {
  const ch = S.channels.get(S.active);
  if (!ch) return;
  const list = $("invList");
  const q = ($("invSearch").value || "").trim().toLowerCase();
  const members = new Set(ch.members || []);
  const candidates = [...S.users.values()]
    .filter((u) => u.id !== S.me?.id && !members.has(u.id))
    .filter((u) => !q || (u.username || "").toLowerCase().includes(q))
    .sort((a, b) => a.username.localeCompare(b.username));
  list.innerHTML = "";
  if (!candidates.length) {
    list.append(el("li", { class: "muted sm" },
      q ? "No one matches your search." : "Everyone online is already a member."));
  }
  for (const u of candidates) {
    const checked = _inv.selected.has(u.id);
    const li = el("li", {
      class: "inv-item" + (checked ? " checked" : ""),
      onclick: () => {
        if (_inv.selected.has(u.id)) _inv.selected.delete(u.id);
        else _inv.selected.add(u.id);
        renderInviteList();
      },
    }, [
      el("div", { class: "avatar xs", style: `background:${u.color}` },
        u.avatar || (u.username?.[0] || "?").toUpperCase()),
      el("span", { class: "inv-name" }, u.username),
      el("span", { class: "inv-check", "aria-hidden": "true" }, checked ? "✓" : ""),
    ]);
    list.append(li);
  }
  const n = _inv.selected.size;
  $("invCount").textContent = `${n} selected`;
  $("invSendBtn").disabled = n === 0;
  $("invSendBtn").textContent = n > 0 ? `Add ${n}` : "Add";
}

function sendInvites() {
  const ch = S.channels.get(S.active);
  if (!ch) return;
  const ids = [..._inv.selected];
  if (!ids.length) return;
  sendOp({ op: "ch_invite", channel: ch.id, users: ids });
  // Optimistically reflect new members so the picker / list updates.
  ch.members = ch.members || [];
  for (const id of ids) if (!ch.members.includes(id)) ch.members.push(id);
  toast(`Added ${ids.length} to #${ch.name || ch.id}`);
  closeModal("inviteModal");
  updateHeader();
  renderMembers();
}

Object.assign(window, { openInviteModal, renderInviteList, sendInvites });

function toggleSidebar() { $("sidebar").classList.toggle("open"); }
// Auto-close mobile sidebar on outside tap / Escape.
document.addEventListener("click", (e) => {
  const sb = $("sidebar");
  if (!sb || !sb.classList.contains("open")) return;
  if (!window.matchMedia("(max-width: 780px)").matches) return;
  if (e.target.closest("#sidebar")) return;
  if (e.target.closest('[onclick*="toggleSidebar"]')) return;
  sb.classList.remove("open");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("sidebar")?.classList.remove("open");
});
updateBrowserNotificationButton();
// Re-confirm read state when the tab becomes visible again.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleReadReceipt();
});
window.addEventListener("focus", scheduleReadReceipt);

function signOut() {
  lstore.remove("username");
  // Close socket cleanly so we don't auto-reconnect.
  if (S.ws) {
    try { S.ws.onclose = null; S.ws.close(); } catch {}
  }
  S.me = null;
  S.ws = null;
  location.reload();
}

// ── Change password ─────────────────────────────────────────────────
let _cpwForced = false;
function openDesignationModal() {
  if (S.me?.designation) { closeModal("designationModal"); return; }
  openModal("designationModal");
  const select = $("designationSelect");
  if (select) select.focus();
}
function submitDesignation(event) {
  event.preventDefault();
  if (S.me?.designation) { closeModal("designationModal"); return; }
  const designation = $("designationSelect")?.value || "";
  if (!["AM", "TL", "STL", "QDE", "LRD", "EE", "CSA"].includes(designation)) {
    toast("Please choose your designation.");
    return;
  }
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) { toast("Not connected. Please try again."); return; }
  sendOp({ op: "designation_set", designation });
  const button = $("designationSubmit");
  if (button) { button.disabled = true; button.textContent = "Saving…"; }
  setTimeout(() => {
    if (!S.me?.designation && button) { button.disabled = false; button.textContent = "Save designation"; }
  }, 2500);
}

function openChangePasswordModal({ forced } = {}) {
  _cpwForced = !!forced;
  const intro = $("cpwIntro");
  const closeBtn = $("cpwClose");
  const cancelBtn = $("cpwCancel");
  if (intro) {
    intro.textContent = forced
      ? "An administrator has reset your password. Enter the temporary password and choose a new one to continue."
      : "Update the password you use to log in from any browser.";
  }
  if (closeBtn) closeBtn.style.display = forced ? "none" : "";
  if (cancelBtn) cancelBtn.style.display = forced ? "none" : "";
  $("cpwCurrent").value = "";
  $("cpwNew").value = "";
  $("cpwConfirm").value = "";
  $("cpwStatus").textContent = "";
  $("cpwStatus").classList.remove("err", "ok");
  openModal("changePwModal");
  setTimeout(() => $("cpwCurrent").focus(), 30);
}

function submitChangePassword(ev) {
  ev.preventDefault();
  const cur = $("cpwCurrent").value;
  const next = $("cpwNew").value;
  const conf = $("cpwConfirm").value;
  const status = $("cpwStatus");
  status.classList.remove("err", "ok");
  if (next.length < 4) {
    status.textContent = "New password must be at least 4 characters.";
    status.classList.add("err"); return;
  }
  if (next !== conf) {
    status.textContent = "New passwords do not match.";
    status.classList.add("err"); return;
  }
  if (next === cur) {
    status.textContent = "New password must differ from the current one.";
    status.classList.add("err"); return;
  }
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
    status.textContent = "Not connected. Try again in a moment.";
    status.classList.add("err"); return;
  }
  status.textContent = "Saving…";
  try { S.ws.send(JSON.stringify({ op: "change_password", current: cur, new: next })); }
  catch { status.textContent = "Failed to send."; status.classList.add("err"); }
}

function onPasswordChanged() {
  const status = $("cpwStatus");
  if (status) {
    status.textContent = "Password updated.";
    status.classList.remove("err");
    status.classList.add("ok");
  }
  toast("Password changed.");
  setTimeout(() => { closeModal("changePwModal"); if (!S.me?.designation) openDesignationModal(); }, 700);
}

// ── Lightbox ─────────────────────────────────────────────────────────
let _lightboxPreviousFocus = null;
function openLightbox(src, name, downloadUrl) {
  closeLightbox();
  _lightboxPreviousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const lb = document.createElement("div");
  lb.className = "lightbox";
  lb.id = "lightbox";
  lb.setAttribute("role", "dialog");
  lb.setAttribute("aria-modal", "true");
  lb.setAttribute("aria-label", name || "Image preview");
  lb.tabIndex = -1;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "lb-close";
  close.setAttribute("aria-label", "Close image preview");
  close.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  close.addEventListener("click", (event) => { event.stopPropagation(); closeLightbox(); });

  const image = document.createElement("img");
  image.src = src;
  image.alt = name || "Shared image";
  image.addEventListener("click", (event) => event.stopPropagation());
  image.addEventListener("error", () => {
    image.alt = "Image preview could not be loaded";
    image.classList.add("lb-image-error");
  });

  lb.append(close, image);
  if (downloadUrl) {
    const bar = document.createElement("div");
    bar.className = "lb-bar";
    bar.addEventListener("click", (event) => event.stopPropagation());
    const label = document.createElement("span");
    label.textContent = name || "Shared image";
    const download = document.createElement("a");
    download.className = "lb-download";
    download.href = downloadUrl;
    download.download = (name && /\.[a-z0-9]{2,8}$/i.test(name)) ? name : "shared-image";
    download.rel = "noopener noreferrer";
    download.textContent = "Download";
    bar.append(label, download);
    lb.append(bar);
  }
  lb.addEventListener("click", closeLightbox);
  lb.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeLightbox();
    } else if (event.key === "Tab") {
      // Keep keyboard focus inside the modal while allowing both controls.
      const focusable = [...lb.querySelectorAll("button:not([disabled]), a[href]")];
      if (!focusable.length) { event.preventDefault(); lb.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
  });
  document.body.append(lb);
  close.focus();
}
function closeLightbox() {
  const lb = document.getElementById("lightbox");
  if (!lb) return;
  lb.remove();
  const previous = _lightboxPreviousFocus;
  _lightboxPreviousFocus = null;
  if (previous?.isConnected) previous.focus();
}

// ── Emoji picker ─────────────────────────────────────────────────────
const EMOJI = {
  "Smileys": "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 ☹️ 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖".split(" "),
  "Gestures": "👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦵 🦶 👂 🦻 👃 🧠 🦷 🦴 👀 👁️ 👅 👄 💋 🩸".split(" "),
  "Hearts": "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💌 💯 💢 💥 💫 💦 💨 🕳️ 💣 💬 👁️‍🗨️ 🗨️ 🗯️ 💭 💤".split(" "),
  "Animals": "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🦖 🐙 🦑 🦐 🦀 🐠 🐟 🐬 🐳 🐋 🦈".split(" "),
  "Food": "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🍞 🥖 🥨 🧀 🥚 🍳 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🍤 🍙 🍚 🍘 🥠 🥮 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🧂 🍩 🍪 ☕ 🫖 🍵 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾".split(" "),
  "Activity": "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🪀 🏓 🏸 🏒 🏑 🥍 🏏 🪃 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🪂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖️ 🏵️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩".split(" "),
  "Travel": "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🦯 🦽 🦼 🛴 🚲 🛵 🏍️ 🛺 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩️ 💺 🛰️ 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ ⛽ 🚧 🚦 🚥 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ ⛺ 🏠 🏡 🏘️ 🏚️ 🏗️ 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🛕 🕍 ⛩️".split(" "),
  "Objects": "⌚ 📱 📲 💻 ⌨️ 🖥️ 🖨️ 🖱️ 🖲️ 🕹️ 🗜️ 💽 💾 💿 📀 📼 📷 📸 📹 🎥 📽️ 🎞️ 📞 ☎️ 📟 📠 📺 📻 🎙️ 🎚️ 🎛️ ⏱️ ⏲️ ⏰ 🕰️ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 🪔 🧯 🛢️ 💸 💵 💴 💶 💷 💰 💳 💎 ⚖️ 🧰 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ ⚱️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🕳️ 🩹 🩺 💊 💉 🩸 🧬 🦠 🧫 🧪 🌡️ 🧹 🧺 🧻 🚽 🚰 🚿 🛁 🛀 🧼 🪒 🧽 🧴 🛎️ 🔑 🗝️ 🚪 🪑 🛋️ 🛏️ 🛌 🧸 🖼️ 🛍️ 🛒 🎁 🎈 🎏 🎀 🎊 🎉 🎎 🏮 🎐 🧧 ✉️ 📩 📨 📧 💌 📥 📤 📦 🏷️ 📪 📫 📬 📭 📮 📯 📜 📃 📄 📑 🧾 📊 📈 📉 🗒️ 🗓️ 📆 📅 🗑️ 📇 🗃️ 🗳️ 🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🧷 🔗 📎 🖇️ 📐 📏 🧮 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏 🔐 🔒 🔓".split(" "),
  "Symbols": "❤️ 💔 ✨ 🔥 💯 ✅ ❌ ❓ ❗ ⚠️ 🚫 ✔️ ➕ ➖ ➗ ✖️ 🟰 ♾️ 💲 💱 ™️ ©️ ®️ 🆗 🆒 🆕 🆙 🆓 🆖 🆘 🆚 🅰️ 🅱️ 🆎 🅾️ 🆔 ⚛️ 🕉️ ✡️ ☸️ ☯️ ✝️ ☦️ ☪️ ☮️ 🕎 🔯 ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ⛎ 🔀 🔁 🔂 ▶️ ⏸️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ 🔼 🔽 ⏫ ⏬ ➡️ ⬅️ ⬆️ ⬇️ ↗️ ↘️ ↙️ ↖️ ↕️ ↔️ ↩️ ↪️ ⤴️ ⤵️ 🔃 🔄 🔅 🔆 📶 📳 📴 ♀️ ♂️ ⚧️ ⚕️ ♻️ ⚜️ 🔱 📛 🔰 ⭕ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🟫 ◼️ ◻️ ◾ ◽ ▪️ ▫️ 🔶 🔷 🔸 🔹 🔺 🔻 💠 🔘 🔳 🔲".split(" "),
};

let _emojiOpen = false;
let _emojiTab = "Smileys";
let _emojiQuery = "";

function toggleEmoji() {
  _emojiOpen ? closeEmoji() : openEmoji();
}
function openEmoji() {
  closeEmoji();
  _emojiOpen = true;
  // On touch / small screens, dismiss the on-screen keyboard so the
  // popover isn't hidden behind it.
  if (window.matchMedia("(max-width: 780px)").matches) {
    try { document.activeElement?.blur?.(); } catch {}
  }
  const pop = el("div", { class: "emoji-pop", id: "emojiPop" });
  pop.addEventListener("click", (e) => e.stopPropagation());

  // Search
  const search = el("input", {
    type: "text", placeholder: "Search emoji…", autocomplete: "off", spellcheck: "false",
  });
  search.addEventListener("input", () => { _emojiQuery = search.value.trim().toLowerCase(); renderEmojiGrid(); });
  pop.append(el("div", { class: "ep-search" }, search));

  // Tabs
  const tabs = el("div", { class: "ep-tabs" });
  for (const cat of Object.keys(EMOJI)) {
    const b = el("button", {
      type: "button",
      class: cat === _emojiTab ? "active" : "",
      onclick: () => { _emojiTab = cat; renderEmojiGrid(); refreshTabs(); },
    }, cat);
    tabs.append(b);
  }
  pop.append(tabs);

  const grid = el("div", { class: "ep-grid", id: "epGrid" });
  pop.append(grid);

  $("sendForm").append(pop);
  setTimeout(() => search.focus(), 30);
  renderEmojiGrid();
}
function refreshTabs() {
  const tabs = document.querySelectorAll("#emojiPop .ep-tabs button");
  tabs.forEach((b) => b.classList.toggle("active", b.textContent === _emojiTab));
}
function renderEmojiGrid() {
  const grid = $("epGrid"); if (!grid) return;
  grid.innerHTML = "";
  let pool;
  if (_emojiQuery) {
    pool = Object.values(EMOJI).flat();
  } else {
    pool = EMOJI[_emojiTab] || [];
  }
  // De-dup + filter empties
  pool = [...new Set(pool.filter(Boolean))];
  if (pool.length === 0) {
    grid.append(el("div", { class: "ep-empty" }, "No emoji"));
    return;
  }
  for (const e of pool) {
    grid.append(el("button", {
      type: "button", title: e,
      onclick: () => insertEmoji(e),
    }, e));
  }
}
function insertEmoji(e) {
  const ta = $("msgInput");
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + e + ta.value.slice(end);
  ta.focus();
  const pos = start + e.length;
  ta.setSelectionRange(pos, pos);
  autoGrow(ta);
}
function closeEmoji() {
  _emojiOpen = false;
  document.getElementById("emojiPop")?.remove();
}
$("emojiBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleEmoji(); });
document.addEventListener("click", (e) => {
  if (_emojiOpen && !e.target.closest("#emojiPop") && e.target.id !== "emojiBtn") closeEmoji();
});
// Close emoji panel when the user refocuses the textarea (e.g. taps to type again).
$("msgInput").addEventListener("focus", () => { if (_emojiOpen) closeEmoji(); });
// Also close on Escape and when window loses focus (mobile keyboard switching).
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _emojiOpen) closeEmoji(); });
window.addEventListener("blur", () => { if (_emojiOpen) closeEmoji(); });

// ── Paste image / drag-drop ──────────────────────────────────────────
async function uploadFile(f, targetChannel = S.active) {
  // The atomic /api/upload handler authenticates via the per-WS
  // session token from the welcome envelope. If we haven't received
  // it yet (page just loaded, WS still connecting), wait briefly so
  // the upload doesn't silently land as an orphan with no message.
  if (!S.session) {
    toast("Connecting…", 1500);
    const start = Date.now();
    while (!S.session && Date.now() - start < 5000) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!S.session) {
      toast("Not connected — try again in a moment", 4000);
      return false;
    }
  }
  const ch = S.channels.get(targetChannel);
  const peer = ch ? dmPeer(ch) : null;
  const isDmEncrypted = ch?.kind === "dm" && peer?.pubkey && E2EE.available;

  let blobToUpload = f;
  let uploadName = f.name;
  let uploadType = f.type || "application/octet-stream";
  let envelopeWire = "";

  if (isDmEncrypted) {
    try {
      toast(`Encrypting ${f.name}…`, 10000);
      const buf = await f.arrayBuffer();
      const { iv, ct } = await E2EE.encryptBytesFor(peer.id, peer.pubkey, buf);
      // Upload pure ciphertext as opaque bytes. The server (and admin)
      // sees only "encrypted.bin" of mime application/octet-stream.
      blobToUpload = new Blob([ct], { type: "application/octet-stream" });
      uploadName = "encrypted.bin";
      uploadType = "application/octet-stream";
      // Wrap real metadata + IV in an envelope and E2EE-encrypt it as
      // the message text. Receivers parse this to learn how to decrypt
      // the file body and what it actually is.
      const env = JSON.stringify({
        v: 1, kind: "file",
        iv: b64(iv),
        name: f.name,
        mime: f.type || "application/octet-stream",
        size: f.size,
      });
      envelopeWire = await E2EE.encryptFor(peer.id, peer.pubkey, env);
    } catch (err) {
      toast("Encrypt failed: " + err.message, 4000);
      return false;
    }
  } else if (ch?.kind === "dm") {
    // DM but no peer pubkey / insecure context — warn before sending in clear.
    if (!confirm(
      "Direct-message files normally travel end-to-end encrypted, but the peer's\n" +
      "encryption key isn't available right now (peer offline or insecure context).\n\n" +
      "Send this file in plaintext anyway? The server admin will be able to read it.")) {
      return false;
    }
  }

  // Atomic upload+post. We package channel, the (encrypted) text
  // envelope, and a stable client_id alongside the file bytes. The
  // server saves the file, inserts the message, and broadcasts in
  // a single request — there is no separate WS announce step that
  // could be lost on refresh. The client_id makes retries idempotent.
  const form = new FormData();
  form.append("file", blobToUpload, uploadName);
  form.append("channel", targetChannel);
  if (envelopeWire) form.append("text", envelopeWire);
  if (S.session) form.append("session", S.session);
  const clientId = (crypto.randomUUID && crypto.randomUUID()) ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2));
  form.append("client_id", clientId);
  try {
    toast(`Uploading ${f.name}…`, 10000);
    const res = await fetch("/api/upload", { method: "POST", body: form });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    // Server already broadcast the message via the channel bus;
    // our own onWireMsg will render it. Nothing else to do.
    toast(isDmEncrypted ? `Sent (encrypted) ${f.name}` : `Uploaded ${f.name}`);
    return true;
  } catch (err) {
    toast("Upload failed: " + err.message, 4000);
    return false;
  }
}
$("msgInput").addEventListener("paste", async (e) => {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) {
        e.preventDefault();
        // Give pasted screenshots a friendly name.
        const ext = (f.type.split("/")[1] || "png").split(";")[0];
        const named = new File([f], f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}.${ext}`, { type: f.type });
        await uploadFile(named);
        return;
      }
    }
  }
});
const dropTarget = $("messages");
["dragover", "dragenter"].forEach((ev) => dropTarget.addEventListener(ev, (e) => { e.preventDefault(); }));
dropTarget.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files || [];
  for (const f of files) await uploadFile(f);
});

// Keyboard: Esc closes lightbox/emoji/modals.
document.addEventListener("click", (e) => {
  if (e.target.classList?.contains("modal")) e.target.classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeLightbox();
    closeEmoji();
    if (_cfResolve) closeConfirm(false);
    for (const m of document.querySelectorAll(".modal:not(.hidden)")) m.classList.add("hidden");
  }
});

// expose for inline onclick handlers
Object.assign(window, { openCreateChannel, openDmPicker, closeModal, openModal, createChannel, toggleSidebar, toggleTheme, startCall, acceptCall, declineCall, endCall, toggleMute, toggleSpeaker, toggleCamera, openChangePasswordModal, submitChangePassword });

// ── Theme ────────────────────────────────────────────────────────────
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "dark";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("localchat-theme", next);
  updateThemeIcon();
}
function updateThemeIcon() {
  const isDark = (document.documentElement.getAttribute("data-theme") || "dark") === "dark";
  const sun  = `<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  const moon = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
  const html = isDark ? sun : moon;
  for (const id of ["themeToggle", "themeToggleJoin"]) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
}
updateThemeIcon();

// ═══════════════════════════════════════════════════════════════════
// Audio call (WebRTC, 1:1 over a DM channel)
// ───────────────────────────────────────────────────────────────────
// Signaling piggybacks on the existing WS DM broadcast bus via the
// `call_signal` op. The server tags relayed frames with
// `username == "__call"` so onWireMsg routes them here.
// ═══════════════════════════════════════════════════════════════════
const Call = {
  pc: null,           // RTCPeerConnection
  localStream: null,  // MediaStream from getUserMedia
  channelId: null,    // DM channel hosting this call
  peerId: null,       // remote user id
  peerName: "",
  state: "idle",      // idle | calling | ringing | active
  muted: false,
  isVideo: false,     // true if this call has video
  camOn: false,       // local video track currently sending
  pendingIce: [],     // ICE arrived before remoteDescription was set
};

const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function callSend(kind, payload) {
  if (!Call.channelId) return;
  sendOp({ op: "call_signal", channel: Call.channelId, kind, payload: payload ?? null });
}

async function startCall(video) {
  if (Call.state !== "idle") return;
  const ch = S.channels.get(S.active);
  if (!ch || ch.kind !== "dm") return;
  const peer = dmPeer(ch);
  if (!peer) return;
  const wantVideo = !!video;
  try {
    Call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo });
  } catch (e) {
    toast((wantVideo ? "Camera/mic" : "Mic") + " permission denied: " + e.message);
    return;
  }
  Call.channelId = ch.id;
  Call.peerId = peer.id;
  Call.peerName = peer.username;
  Call.state = "calling";
  Call.isVideo = wantVideo;
  Call.camOn = wantVideo;
  showCallBar(wantVideo ? "Video calling…" : "Calling…");
  await createPC();
  for (const t of Call.localStream.getTracks()) Call.pc.addTrack(t, Call.localStream);
  if (wantVideo) attachLocalVideo();
  const offer = await Call.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: wantVideo });
  await Call.pc.setLocalDescription(offer);
  callSend("offer", { sdp: Call.pc.localDescription, video: wantVideo });
}

async function createPC() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  Call.pc = pc;
  pc.onicecandidate = (ev) => {
    if (ev.candidate) callSend("ice", { candidate: ev.candidate });
  };
  pc.ontrack = (ev) => {
    const stream = ev.streams && ev.streams[0];
    if (!stream) return;
    const audio = $("remoteAudio");
    if (audio) audio.srcObject = stream;
    if (ev.track.kind === "video") {
      const v = $("remoteVideo");
      if (v) v.srcObject = stream;
      // Only reveal the video stage once the call is actually active
      // (not during the ringing phase — the incoming-call modal owns the UI then).
      if (Call.state === "active") showVideoStage(true);
    }
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === "connected") {
      Call.state = "active";
      setCallStatus(Call.isVideo ? "Connected (video)" : "Connected");
      if (Call.isVideo) {
        const rv = $("remoteVideo");
        // Re-attach in case the remote stream was set before "active".
        const audio = $("remoteAudio");
        if (rv && audio && audio.srcObject) rv.srcObject = audio.srcObject;
        showVideoStage(true);
      }
    } else if (s === "failed" || s === "disconnected" || s === "closed") {
      if (Call.state !== "idle") teardownCall(false);
    }
  };
}

async function acceptCall() {
  if (Call.state !== "ringing") return;
  stopRingtone();
  $("incomingCall").classList.add("hidden");
  const wantVideo = !!Call.isVideo;
  try {
    Call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantVideo });
  } catch (e) {
    toast((wantVideo ? "Camera/mic" : "Mic") + " permission denied: " + e.message);
    callSend("decline", null);
    resetCallState();
    return;
  }
  Call.camOn = wantVideo;
  for (const t of Call.localStream.getTracks()) Call.pc.addTrack(t, Call.localStream);
  if (wantVideo) attachLocalVideo();
  const answer = await Call.pc.createAnswer();
  await Call.pc.setLocalDescription(answer);
  callSend("answer", { sdp: Call.pc.localDescription });
  showCallBar("Connecting…");
  Call.state = "active";
}

function declineCall() {
  if (Call.state !== "ringing") return;
  stopRingtone();
  callSend("decline", null);
  $("incomingCall").classList.add("hidden");
  resetCallState();
}

function endCall() {
  if (Call.state === "idle") return;
  callSend("end", null);
  teardownCall(true);
}

function toggleMute() {
  if (!Call.localStream) return;
  Call.muted = !Call.muted;
  for (const t of Call.localStream.getAudioTracks()) t.enabled = !Call.muted;
  const btn = $("muteBtn");
  if (btn) btn.classList.toggle("active", Call.muted);
  setCallStatus(Call.muted ? "Muted" : (Call.state === "active" ? "Connected" : "Connecting…"));
}

async function toggleSpeaker() {
  const audio = $("remoteAudio");
  if (!audio) return;
  Call._speakerState = !(Call._speakerState ?? false);
  const speakerOn = Call._speakerState;
  // Best-effort: pick a different audio output device when available.
  try {
    if (typeof audio.setSinkId === "function" && navigator.mediaDevices?.enumerateDevices) {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const outs = devs.filter((d) => d.kind === "audiooutput");
      if (outs.length > 1) {
        const target = speakerOn
          ? (outs.find((d) => d.deviceId === "default") || outs[0])
          : (outs.find((d) => d.deviceId !== "default") || outs[outs.length - 1]);
        await audio.setSinkId(target.deviceId);
      }
    }
  } catch {}
  audio.volume = speakerOn ? 1.0 : 0.35;
  const btn = $("speakerBtn");
  if (btn) btn.classList.toggle("active", speakerOn);
  await updateSpeakerIcon();
  toast(speakerOn ? "Speaker on" : "Speaker off");
}

// Swap the speaker button's icon to a headset glyph if a headset/Bluetooth
// audio output device is detected (or currently selected).
const SVG_SPEAKER  = `<path d="M3 10v4a1 1 0 001 1h3l5 4V5L7 9H4a1 1 0 00-1 1z"/><path d="M16 8a5 5 0 010 8M19 5a9 9 0 010 14"/>`;
const SVG_HEADSET  = `<path d="M4 14v-2a8 8 0 0116 0v2"/><rect x="2" y="14" width="5" height="7" rx="1.5"/><rect x="17" y="14" width="5" height="7" rx="1.5"/>`;
const SVG_BLUETOOTH= `<path d="M7 7l10 10-5 5V2l5 5L7 17"/>`;

async function updateSpeakerIcon() {
  const icon = document.getElementById("speakerIcon");
  if (!icon) return;
  let kind = "speaker";
  // If user explicitly switched to loudspeaker, always show speaker icon.
  if (Call._speakerState) {
    kind = "speaker";
  } else {
    try {
      if (navigator.mediaDevices?.enumerateDevices) {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const outs = devs.filter((d) => d.kind === "audiooutput");
        const text = outs.map((d) => (d.label || "").toLowerCase()).join(" | ");
        if (/bluetooth|airpods|buds/.test(text)) kind = "bluetooth";
        else if (/head(set|phone)|earphone|earbud|earpiece/.test(text)) kind = "headset";
      }
    } catch {}
  }
  const svg = kind === "bluetooth" ? SVG_BLUETOOTH : kind === "headset" ? SVG_HEADSET : SVG_SPEAKER;
  if (icon.dataset.kind !== kind) {
    icon.innerHTML = svg;
    icon.dataset.kind = kind;
  }
  const btn = $("speakerBtn");
  if (btn) btn.title = kind === "bluetooth" ? "Bluetooth audio" : kind === "headset" ? "Headset" : "Speaker";
}

async function toggleCamera() {
  if (!Call.localStream || !Call.isVideo) return;
  // If we already have a video track, just enable/disable it.
  let vt = Call.localStream.getVideoTracks()[0];
  if (vt) {
    vt.enabled = !vt.enabled;
    Call.camOn = vt.enabled;
  } else {
    // Add a video track on demand (mid-call upgrade).
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      vt = s.getVideoTracks()[0];
      Call.localStream.addTrack(vt);
      // Replace into the existing PC if a video sender exists, else add.
      const sender = Call.pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(vt);
      else Call.pc.addTrack(vt, Call.localStream);
      Call.camOn = true;
    } catch (e) {
      toast("Camera permission denied: " + e.message);
      return;
    }
  }
  attachLocalVideo();
  const btn = $("camBtn");
  if (btn) btn.classList.toggle("active", !Call.camOn);
}

function attachLocalVideo() {
  const v = $("localVideo");
  if (v && Call.localStream) v.srcObject = Call.localStream;
  showVideoStage(true);
  const btn = $("camBtn");
  if (btn) {
    btn.classList.remove("hidden");
    btn.classList.toggle("active", !Call.camOn);
  }
}

function showVideoStage(on) {
  const stage = $("videoStage");
  if (!stage) return;
  stage.classList.toggle("hidden", !on);
  stage.setAttribute("aria-hidden", on ? "false" : "true");
}

function teardownCall(local) {
  stopRingtone();
  try { Call.pc?.close(); } catch {}
  if (Call.localStream) {
    for (const t of Call.localStream.getTracks()) t.stop();
  }
  const audio = $("remoteAudio");
  if (audio) audio.srcObject = null;
  const rv = $("remoteVideo"); if (rv) rv.srcObject = null;
  const lv = $("localVideo");  if (lv) lv.srcObject = null;
  showVideoStage(false);
  $("callPanel").classList.add("hidden");
  $("incomingCall").classList.add("hidden");
  if (local !== true) toast("Call ended");
  resetCallState();
}

function resetCallState() {
  Call.pc = null;
  Call.localStream = null;
  Call.channelId = null;
  Call.peerId = null;
  Call.peerName = "";
  Call.state = "idle";
  Call.muted = false;
  Call.isVideo = false;
  Call.camOn = false;
  Call._speakerState = false;
  Call.pendingIce = [];
  const btn = $("muteBtn");
  if (btn) btn.classList.remove("active");
  const sbtn = $("speakerBtn");
  if (sbtn) sbtn.classList.remove("active");
  const cbtn = $("camBtn");
  if (cbtn) { cbtn.classList.remove("active"); cbtn.classList.add("hidden"); }
  const audio = $("remoteAudio");
  if (audio) audio.volume = 0.35;
}

function showCallBar(status) {
  const bar = $("callPanel");
  $("cbName").textContent = Call.peerName || "Unknown";
  const peer = S.users.get(Call.peerId);
  const av = $("cbAvatar");
  if (av) {
    av.textContent = peer?.avatar || (Call.peerName?.[0] || "?").toUpperCase();
    av.style.background = peer?.color || "var(--brand)";
  }
  setCallStatus(status);
  bar.classList.remove("hidden");
  updateSpeakerIcon();
}

function setCallStatus(s) {
  const el = $("cbStatus");
  if (el) el.textContent = s;
}

async function onCallSignal({ channel, kind, from, fromName, payload }) {
  // Ignore our own echoes from the broadcast bus.
  if (S.me && from === S.me.id) return;

  if (kind === "offer") {
    if (Call.state !== "idle") {
      // Already busy with another call; politely decline.
      sendOp({ op: "call_signal", channel, kind: "busy", payload: null });
      return;
    }
    Call.channelId = channel;
    Call.peerId = from;
    Call.peerName = fromName || (S.users.get(from)?.username || "unknown");
    Call.state = "ringing";
    Call.isVideo = !!payload?.video;
    await createPC();
    try {
      await Call.pc.setRemoteDescription(payload.sdp);
      await drainPendingIce();
    } catch (e) {
      console.warn("setRemoteDescription failed", e);
      resetCallState();
      return;
    }
    // Show the incoming-call modal.
    const peer = S.users.get(from);
    const av = $("icAvatar");
    if (av) {
      av.textContent = peer?.avatar || (Call.peerName?.[0] || "?").toUpperCase();
      av.style.background = peer?.color || "var(--brand)";
    }
    $("icName").textContent = Call.peerName;
    const icSub = $("icSub");
    if (icSub) icSub.textContent = Call.isVideo ? "is video calling…" : "is calling…";
    const icTitle = $("icTitle");
    if (icTitle) icTitle.textContent = Call.isVideo ? "Incoming video call" : "Incoming audio call";
    $("incomingCall").classList.remove("hidden");
    startRingtone();
    return;
  }

  // For all other kinds, must match the active call.
  if (channel !== Call.channelId || from !== Call.peerId) return;

  if (kind === "answer") {
    try {
      await Call.pc.setRemoteDescription(payload.sdp);
      await drainPendingIce();
      Call.state = "active";
      setCallStatus("Connected");
    } catch (e) {
      console.warn("answer setRemoteDescription failed", e);
    }
  } else if (kind === "ice") {
    const cand = payload?.candidate;
    if (!cand) return;
    if (Call.pc?.remoteDescription && Call.pc.remoteDescription.type) {
      try { await Call.pc.addIceCandidate(cand); } catch (e) { console.warn("addIceCandidate", e); }
    } else {
      Call.pendingIce.push(cand);
    }
  } else if (kind === "end" || kind === "decline" || kind === "busy") {
    const why = kind === "busy" ? "Peer is busy" : (kind === "decline" ? "Call declined" : "Call ended");
    teardownCall(false);
    toast(why);
  }
}

async function drainPendingIce() {
  while (Call.pendingIce.length) {
    const c = Call.pendingIce.shift();
    try { await Call.pc.addIceCandidate(c); } catch (e) { console.warn("drain ICE", e); }
  }
}

// ── Ringtone (Web Audio, no asset needed) ────────────────────────────
let _ringCtx = null;
let _ringTimer = null;
let _ringNodes = [];
function startRingtone() {
  stopRingtone();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    _ringCtx = new Ctx();
    // Classic phone ring: two 440+480 Hz dual-tone bursts (~0.4s each
    // with a short gap), then a long silence — roughly the cadence of
    // a desk phone but mellower thanks to soft envelopes and a low
    // master gain. Repeats every 3.2 s.
    const tone = () => {
      const ctx = _ringCtx;
      if (!ctx) return;
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
      _ringNodes.push(master);

      // Two bursts per ring.
      for (let i = 0; i < 2; i++) {
        const t0 = now + i * 0.55;
        const dur = 0.42;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, t0);
        env.gain.linearRampToValueAtTime(1, t0 + 0.04);
        env.gain.setValueAtTime(1, t0 + dur - 0.08);
        env.gain.linearRampToValueAtTime(0, t0 + dur);
        env.connect(master);
        _ringNodes.push(env);

        for (const f of [440, 480]) {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = f;
          osc.connect(env);
          osc.start(t0);
          osc.stop(t0 + dur + 0.02);
          _ringNodes.push(osc);
        }
      }
    };
    tone();
    _ringTimer = setInterval(tone, 3200);
  } catch (e) {
    console.warn("ringtone failed", e);
  }
}
function stopRingtone() {
  if (_ringTimer) { clearInterval(_ringTimer); _ringTimer = null; }
  for (const n of _ringNodes) { try { n.disconnect && n.disconnect(); } catch {} }
  _ringNodes = [];
  if (_ringCtx) { try { _ringCtx.close(); } catch {} _ringCtx = null; }
}


let _ciPendingJump = null;
/* ── Chat info drawer + shared-item browser (initial test slice) ── */
let _channelInfoTab = "media";
let _channelInfoSearch = "";
let _ciNotificationMode = "all";
function _ciEsc(s) { return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch])); }
function _ciPeer(ch) { try { return dmPeer(ch); } catch { return null; } }
async function openChannelInfo() {
  const ch = S.channels.get(S.active);
  if (!ch) return;
  $("channelInfoBackdrop")?.classList.remove("hidden");
  $("channelInfoDrawer")?.classList.remove("hidden");
  document.body.classList.add("channel-info-open");
  _channelInfoTab = "media";
  _channelInfoSearch = "";
  await renderChannelInfo();
  if (ch.kind !== "dm") requestChannelSharedItems(true);
  sendOp({ op: "ch_info", channel: ch.id });
  $("channelInfoDrawer")?.querySelector("button")?.focus();
}
function closeChannelInfo() {
  $("channelInfoBackdrop")?.classList.add("hidden");
  $("channelInfoDrawer")?.classList.add("hidden");
  document.body.classList.remove("channel-info-open");
  $("channelInfoBtn")?.focus();
}
async function renderChannelInfo() {
  const root = $("channelInfoContent");
  const ch = S.channels.get(S.active);
  if (!root || !ch) return;
  const isDm = ch.kind === "dm";
  const peer = isDm ? _ciPeer(ch) : null;
  const title = isDm ? (peer?.username || ch.dmUsers?.find(n => n?.toLowerCase() !== S.me?.username?.toLowerCase()) || "Direct message") : (ch.name || "Group");
  const members = (ch.members || []).map(id => S.users.get(id) || { id, username: id === S.me?.id ? (S.me?.username || "You") : "Offline member", avatar: "?", color: "#6366f1" });
  const profileAvatar = isDm ? (peer?.avatar || "?") : (title.slice(0,1).toUpperCase() || "#");
  const canEditPhoto = ch.kind === "group" && (ch.createdBy === S.me?.id || ch.memberRoles?.[S.me?.id] === "moderator" || ch.memberRoles?.[S.me?.id] === "owner");
  const description = ch.description || "";
  const canEditDescription = ch.kind === "group" && ch.createdBy === S.me?.id;
  _ciNotificationMode = ch.notificationMode || "all";
  root.innerHTML = `
    <section class="ci-profile">
      <div class="ci-avatar">${ch.photoUrl && !isDm ? `<img src="${_ciEsc(ch.photoUrl)}" alt="${_ciEsc(title)} group photo" loading="lazy">` : _ciEsc(profileAvatar)}${canEditPhoto ? '<button type="button" id="ciPhotoEditBtn" class="ci-avatar-edit" aria-label="Change group photo" title="Change group photo"><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' : ""}</div>
      ${canEditPhoto ? '<input id="ciPhotoFileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Choose group photo">' : ""}
      <div class="ci-name">${_ciEsc(title)}</div>
      <div class="ci-subtitle">${isDm ? "Direct message · End-to-end encryption when available" : (ch.kind === "lobby" ? "Public channel" : (ch.isPrivate ? "Private group" : "Group conversation")) + " · " + members.length + " member" + (members.length === 1 ? "" : "s")}</div>
      ${!isDm && ch.kind !== "lobby" ? `<div class="ci-description-row"><div class="ci-description" id="ciDescriptionText">${_ciEsc(description || "No group description yet.")}</div>${canEditDescription ? '<button type="button" id="ciDescriptionEditBtn" class="ci-description-edit" aria-label="Edit group details" title="Edit group name and description"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' : ""}</div>` : ""}
      ${canEditDescription ? `
        <form id="ciEditGroupForm" class="ci-edit-group" hidden>
          <label for="ciNameInput">Channel name</label>
          <input id="ciNameInput" type="text" maxlength="48" minlength="2" required value="${_ciEsc(title)}" placeholder="Enter channel name">
          <label for="ciDescriptionInput">Group description</label>
          <textarea id="ciDescriptionInput" maxlength="500" rows="3" placeholder="Add a group description…">${_ciEsc(description)}</textarea>
          <div class="ci-edit-group-actions"><button class="btn btn-ghost btn-sm" type="button" id="ciCancelDescriptionEdit">Cancel</button><button class="btn btn-primary btn-sm" type="submit">Save changes</button></div>
        </form>` : ""}
    </section>
    <section class="ci-section">
      <div class="ci-section-head"><span>Notifications</span><span>Only for you</span></div>
      <select id="ciNotificationMode" class="ci-search" aria-label="Chat notification preference">
        <option value="all" ${_ciNotificationMode === "all" ? "selected" : ""}>All messages</option>
        <option value="mentions" ${_ciNotificationMode === "mentions" ? "selected" : ""}>Mention or reply only</option>
        <option value="mute" ${_ciNotificationMode === "mute" ? "selected" : ""}>Muted</option>
      </select>
    </section>
    <section class="ci-section">
      <div class="ci-section-head"><span>Shared content</span><span id="ciSharedCount" aria-live="polite">Counting loaded items…</span></div>
      <div class="ci-browser-tabs" role="tablist" aria-label="Shared content type">
        <button type="button" class="ci-browser-tab ${_channelInfoTab === "media" ? "active" : ""}" data-ci-tab="media">Media</button>
        <button type="button" class="ci-browser-tab ${_channelInfoTab === "links" ? "active" : ""}" data-ci-tab="links">Links</button>
        <button type="button" class="ci-browser-tab ${_channelInfoTab === "files" ? "active" : ""}" data-ci-tab="files">Files</button>
      </div>
      <div id="ciSharedItems" class="ci-items"><div class="ci-empty">Preparing shared items…</div></div>
      <div class="muted xs">Shared content is loaded in pages. Direct-message content is indexed locally only when it can be decrypted by this device.</div>
    </section>
    <section class="ci-section">
      <div class="ci-section-head"><span>${isDm ? "Conversation" : "Members"}</span><span>${members.length}</span></div>
      ${!isDm ? '<input id="ciMemberSearch" class="ci-search" type="search" placeholder="Search members…" aria-label="Search members" autocomplete="off">' : ""}
      <div id="ciMembers" class="ci-members"></div>
    </section>
  `;
  updateBrowserNotificationButton();
  const descriptionNode = root.querySelector(".ci-description");
  if (descriptionNode && description) { descriptionNode.replaceChildren(); appendLinkedText(descriptionNode, description); }
  root.querySelectorAll("[data-ci-tab]").forEach(btn => btn.addEventListener("click", async () => {
    _channelInfoTab = btn.dataset.ciTab;
    root.querySelectorAll("[data-ci-tab]").forEach(b => b.classList.toggle("active", b === btn));
    const activeChannel = S.channels.get(S.active);
    if (activeChannel && activeChannel.kind !== "dm") requestChannelSharedItems(true);
    await renderChannelInfoItems();
  }));
  const editForm = $("ciEditGroupForm");
  const descriptionEditButton = $("ciDescriptionEditBtn");
  const descriptionInput = $("ciDescriptionInput");
  const nameInput = $("ciNameInput");
  if (editForm && descriptionEditButton) {
    descriptionEditButton.addEventListener("click", () => { editForm.hidden = false; descriptionEditButton.setAttribute("aria-expanded", "true"); nameInput?.focus(); });
    $("ciCancelDescriptionEdit")?.addEventListener("click", () => { if (descriptionInput) descriptionInput.value = ch.description || ""; if (nameInput) nameInput.value = ch.name || ""; editForm.hidden = true; descriptionEditButton.setAttribute("aria-expanded", "false"); });
    editForm.addEventListener("submit", ev => { ev.preventDefault(); const name = (nameInput?.value || "").trim(); if (name.length < 2 || name.length > 48) { toast("Channel name must be 2–48 characters."); return; } sendOp({ op: "ch_update", channel: ch.id, name, description: descriptionInput?.value || "" }); });
  }
  const photoEditButton = $("ciPhotoEditBtn");
  const photoInput = $("ciPhotoFileInput");
  if (photoEditButton && photoInput) {
    photoEditButton.addEventListener("click", () => photoInput.click());
    photoInput.addEventListener("change", async () => {
      const file = photoInput.files?.[0];
      photoInput.value = "";
      if (file) await uploadGroupPhoto(file, ch.id);
    });
  }
  const notificationSelect = $("ciNotificationMode");
  if (notificationSelect) notificationSelect.addEventListener("change", () => {
    _ciNotificationMode = notificationSelect.value;
    sendOp({ op: "ch_notification_set", channel: ch.id, mode: _ciNotificationMode });
  });
  const search = $("ciMemberSearch");
  if (search) {
    search.value = _channelInfoSearch;
    search.addEventListener("input", () => { _channelInfoSearch = search.value; renderChannelInfoMembers(members); });
  }
  renderChannelInfoMembers(members);
  await renderChannelInfoItems();
}
function renderChannelInfoMembers(members) {
  const root = $("ciMembers");
  if (!root) return;
  const q = (_channelInfoSearch || "").trim().toLowerCase();
  const activeChannel = S.channels.get(S.active);
  const selfRole = members.find(u => u.id === S.me?.id)?.role || (activeChannel?.createdBy === S.me?.id ? "owner" : "member");
  const isOwner = selfRole === "owner";
  const canRemove = selfRole === "owner" || selfRole === "moderator";
  const filtered = members.filter(u => (u.username || "").toLowerCase().includes(q));
  root.innerHTML = "";
  if (!filtered.length) { root.innerHTML = '<div class="ci-empty">No matching members.</div>'; return; }
  for (const u of filtered) {
    const row = document.createElement("div"); row.className = "ci-member";
    const avatar = document.createElement("div"); avatar.className = "ci-member-avatar"; avatar.style.background = u.color || "#6366f1"; avatar.textContent = u.avatar || (u.username || "?").slice(0,1).toUpperCase();
    const main = document.createElement("div"); main.className = "ci-member-main";
    const name = document.createElement("div"); name.className = "ci-member-name"; name.append(userNameNode(u)); if (u.id === S.me?.id) name.append(document.createTextNode(" (you)"));
    const role = document.createElement("div"); role.className = "ci-member-role"; role.textContent = u.role === "owner" || u.id === S.channels.get(S.active)?.createdBy ? "Group owner" : (u.role === "moderator" ? "Moderator" : (u.online ? "Online" : "Member"));
    main.append(name, role); row.append(avatar, main);
    const canMessage = u.id !== S.me?.id && u.id && u.username && typeof openDmWithUserId === "function";
    const canManageMember = activeChannel?.kind === "group" && u.id !== S.me?.id && u.role !== "owner" && canRemove
      && (isOwner || u.role !== "moderator");
    if (canMessage || canManageMember) {
      const actions = document.createElement("div"); actions.className = "ci-member-actions";
      const trigger = document.createElement("button"); trigger.type = "button"; trigger.className = "ci-member-menu-trigger";
      trigger.textContent = "⋯"; trigger.title = "Member actions"; trigger.setAttribute("aria-label", "Actions for " + (u.username || "member"));
      trigger.setAttribute("aria-haspopup", "true"); trigger.setAttribute("aria-expanded", "false");
      const menu = document.createElement("div"); menu.className = "ci-member-menu"; menu.hidden = true;
      const closeMenu = () => { menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); };
      trigger.addEventListener("click", ev => {
        ev.stopPropagation();
        const opening = menu.hidden;
        root.querySelectorAll(".ci-member-menu").forEach(other => { other.hidden = true; });
        root.querySelectorAll(".ci-member-menu-trigger").forEach(other => other.setAttribute("aria-expanded", "false"));
        menu.hidden = !opening; trigger.setAttribute("aria-expanded", String(opening));
        menu.classList.remove("opens-up");
        if (opening) requestAnimationFrame(() => {
          const bounds = menu.getBoundingClientRect();
          const rowBounds = row.getBoundingClientRect();
          const drawerBounds = $("channelInfoDrawer").getBoundingClientRect();
          if (bounds.bottom > drawerBounds.bottom - 8 && rowBounds.top - drawerBounds.top > bounds.height) menu.classList.add("opens-up");
        });
      });
      if (canMessage) {
        const message = document.createElement("button"); message.type = "button"; message.className = "ci-member-menu-item"; message.textContent = "Message";
        message.addEventListener("click", () => { closeMenu(); closeChannelInfo(); openDmWithUserId(u.id, u.username); });
        menu.append(message);
      }
      if (canManageMember && isOwner) {
        const roleAction = document.createElement("button"); roleAction.type = "button"; roleAction.className = "ci-member-menu-item";
        const isModerator = u.role === "moderator";
        roleAction.textContent = isModerator ? "Remove as moderator" : "Assign as moderator";
        roleAction.addEventListener("click", () => { sendOp({ op: "ch_role_set", channel: activeChannel.id, userId: u.id, role: isModerator ? "member" : "moderator" }); closeMenu(); });
        menu.append(roleAction);
      }
      if (canManageMember) {
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "ci-member-menu-item danger"; remove.textContent = "Remove member";
        remove.addEventListener("click", () => {
          closeMenu();
          if (confirm("Remove " + (u.username || "this member") + " from the group?")) sendOp({ op: "ch_member_remove", channel: activeChannel.id, userId: u.id });
        });
        menu.append(remove);
      }
      actions.append(trigger, menu); row.append(actions);
    }
    root.append(row);
  }
}
function onChannelInfo(e) {
  const ch = S.channels.get(e.channel);
  if (!ch) return;
  ch.description = e.description || "";
  ch.photoUrl = e.photoUrl || "";
  ch.notificationMode = e.notificationMode || "all";
  ch.createdBy = e.createdBy || ch.createdBy;
  ch.isPrivate = e.isPrivate ?? ch.isPrivate;
  const profiles = Array.isArray(e.members) ? e.members : [];
  ch.members = profiles.map(m => m.id);
  ch.memberRoles = Object.fromEntries(profiles.map(m => [m.id, m.role || "member"]));
  for (const profile of profiles) { S.users.set(profile.id, profile); S.userProfiles.set(profile.id, profile); }
  renderChannels();
  if (S.active === e.channel) renderStream();
  if (S.active === e.channel && !$("channelInfoDrawer")?.classList.contains("hidden")) {
    _ciNotificationMode = ch.notificationMode;
    renderChannelInfo();
  }
}
function onChannelUpdated(e) {
  const ch = S.channels.get(e.channel);
  if (!ch) return;
  ch.description = e.description || "";
  ch.photoUrl = e.photoUrl || "";
  ch.name = e.name || ch.name;
  renderChannels();
  if (S.active === e.channel && !$("channelInfoDrawer")?.classList.contains("hidden")) renderChannelInfo();
  if (!e.silent && typeof toast === "function") toast("Group details saved.");
}
function onChannelRoleUpdated(e) {
  const ch = S.channels.get(e.channel);
  if (!ch) return;
  if (S.active === e.channel && !$("channelInfoDrawer")?.classList.contains("hidden")) sendOp({ op: "ch_info", channel: e.channel });
}
function onChannelMemberRemoved(e) {
  if (e.userId === S.me?.id) {
    onChannelDeleted(e.channel);
    if (typeof toast === "function") toast("You were removed from the group.");
    return;
  }
  const ch = S.channels.get(e.channel);
  if (ch && Array.isArray(ch.members)) ch.members = ch.members.filter(id => id !== e.userId);
  if (S.active === e.channel && !$("channelInfoDrawer")?.classList.contains("hidden")) sendOp({ op: "ch_info", channel: e.channel });
}
function onChannelNotificationSet(e) {
  const ch = S.channels.get(e.channel);
  if (ch) ch.notificationMode = e.mode;
  _ciNotificationMode = e.mode || "all";
  const select = $("ciNotificationMode");
  if (select) select.value = _ciNotificationMode;
}

const _ciSharedCache = new Map();
let _ciSharedRequestSeq = 0;
// Keep the open shared-content panel fresh as messages arrive or are deleted.
// A reset is required because newly indexed items are newer than the current cursor.
function refreshOpenSharedItems(channelId) {
  const ch = S.channels.get(channelId);
  if (!ch || ch.kind === "dm" || S.active !== channelId ||
      $("channelInfoDrawer")?.classList.contains("hidden")) return;
  const cache = _ciSharedCache.get(_ciSharedKey(channelId, _channelInfoTab));
  if (cache) {
    cache.items = [];
    cache.cursor = null;
    cache.hasMore = true;
    cache.counts = null;
    cache.loading = false;
  }
  requestChannelSharedItems(true);
}
async function uploadGroupPhoto(file, channelId) {
  const ch = S.channels.get(channelId);
  if (!ch || ch.kind !== "group") return;
  if (!S.session) { toast("Not connected — try again in a moment", 3500); return; }
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type || "")) { toast("Choose a PNG, JPEG, or WebP image.", 3500); return; }
  let blob;
  try {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error("Image dimensions are invalid.");
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable.");
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    bitmap.close?.();
    blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", 0.82));
    if (!blob) blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) throw new Error("Could not process this image.");
  } catch (error) {
    toast("Could not process image: " + (error.message || "unsupported image"), 4000);
    return;
  }
  if (blob.size > 2 * 1024 * 1024) { toast("Processed photo is still too large. Choose a smaller image.", 4000); return; }
  const filename = blob.type === "image/webp" ? "group-photo.webp" : "group-photo.jpg";
  const form = new FormData();
  form.append("purpose", "channel_photo");
  form.append("session", S.session);
  form.append("channel", channelId);
  form.append("file", blob, filename);
  try {
    toast("Updating group photo…", 10000);
    const response = await fetch("/api/upload", { method: "POST", body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.message || "Upload failed.");
    ch.photoUrl = result.photoUrl || "";
    if (S.active === channelId) renderChannelInfo();
    toast("Group photo updated.");
  } catch (error) {
    toast("Could not update group photo: " + (error.message || "upload failed"), 4500);
  }
}

function _ciSharedKey(channel, type) { return String(channel) + "::" + String(type); }
function requestChannelSharedItems(reset = false) {
  const ch = S.channels.get(S.active);
  if (!ch || ch.kind === "dm") return;
  const key = _ciSharedKey(ch.id, _channelInfoTab);
  let cache = _ciSharedCache.get(key);
  if (!cache || reset) {
    cache = { items: [], cursor: null, hasMore: true, counts: null, loading: false };
    _ciSharedCache.set(key, cache);
  }
  if (cache.loading || (!cache.hasMore && !reset)) return;
  cache.loading = true;
  const requestId = ++_ciSharedRequestSeq;
  cache.requestId = requestId;
  sendOp({ op: "shared_items_list", channel: ch.id, type: _channelInfoTab, limit: 48, requestId, ...(cache.cursor ? { beforeId: cache.cursor } : {}) });
}
function onSharedItemsList(e) {
  const key = _ciSharedKey(e.channel, e.type);
  const cache = _ciSharedCache.get(key);
  if (!cache || e.requestId !== cache.requestId) return;
  cache.loading = false;
  cache.hasMore = !!e.hasMore;
  cache.cursor = e.nextCursor || cache.cursor;
  cache.counts = e.counts || cache.counts;
  const incoming = Array.isArray(e.items) ? e.items : [];
  const known = new Set(cache.items.map(item => String(item.messageId) + "|" + item.itemType + "|" + item.itemKey));
  for (const item of incoming) {
    const itemKey = String(item.messageId) + "|" + item.itemType + "|" + item.itemKey;
    if (!known.has(itemKey)) { cache.items.push(item); known.add(itemKey); }
  }
  if (S.active === e.channel && _channelInfoTab === e.type && !$("channelInfoDrawer")?.classList.contains("hidden")) renderChannelInfoItems();
}
let _ciVisibleItems = 12;
let _ciExpandedOverlay = null;
function closeSharedItemsOverlay() { _ciExpandedOverlay?.remove(); _ciExpandedOverlay = null; }
function openSharedItemsOverlay(type, items, loadMore) {
  closeSharedItemsOverlay();
  const drawer = $("channelInfoDrawer"); if (!drawer) return;
  const labels = { media: "Shared media", links: "Shared links", files: "Shared files" };
  const overlay = document.createElement("div"); overlay.className = "ci-expanded-overlay"; overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-label", labels[type] || "Shared items");
  const panel = document.createElement("section"); panel.className = "ci-expanded-panel";
  const head = document.createElement("header"); head.className = "ci-expanded-head";
  const heading = document.createElement("h3"); heading.textContent = labels[type] || "Shared items";
  const close = document.createElement("button"); close.type = "button"; close.className = "ci-expanded-close"; close.textContent = "×"; close.setAttribute("aria-label", "Close shared items"); close.addEventListener("click", closeSharedItemsOverlay);
  head.append(heading, close);
  const grid = document.createElement("div"); grid.className = "ci-expanded-grid";
  for (const item of items) {
    const tile = document.createElement("article"); tile.className = "ci-expanded-tile";
    if (type === "media" && item.url && (item.detail || "").startsWith("image/")) {
      const image = document.createElement("img"); image.className = "ci-expanded-thumb"; image.src = item.url; image.alt = "Shared image"; image.loading = "lazy"; image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => { image.removeAttribute("src"); image.alt = "Image unavailable"; tile.classList.add("is-unavailable"); });
      image.addEventListener("click", () => openLightbox(item.url, "Shared image", item.url)); tile.append(image);
    } else {
      const icon = document.createElement("div"); icon.className = "ci-expanded-icon"; icon.textContent = item.icon || (type === "links" ? "🌐" : sharedFileIcon(item.detail, item.title)); tile.append(icon);
    }
    const label = document.createElement("div"); label.className = "ci-expanded-label"; label.textContent = type === "media" ? (item.title || "Media") : (item.title || item.detail || "Shared item"); tile.append(label);
    const meta = document.createElement("div"); meta.className = "ci-expanded-meta"; meta.textContent = item.sender || "Unknown sender"; tile.append(meta);
    if (type === "links" && item.url) { const link = document.createElement("a"); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.className = "ci-expanded-open"; link.textContent = "Open link"; tile.append(link); }
    if (type === "files" && item.url) { const link = document.createElement("a"); link.href = item.url; link.download = item.title || "attachment"; link.rel = "noopener noreferrer"; link.className = "ci-expanded-open"; link.textContent = "Download"; tile.append(link); }
    const view = document.createElement("button"); view.type = "button"; view.className = "ci-expanded-open"; view.textContent = "View in chat"; view.addEventListener("click", () => {
      const channelId = S.active, messageId = item.id; closeSharedItemsOverlay(); closeChannelInfo();
      const loaded = (S.msgs.get(channelId) || []).some(m => Number(m.id) === Number(messageId));
      if (loaded) jumpToMessage(channelId, messageId); else { _ciPendingJump = { channelId, messageId }; sendOp({ op: "history_before", channel: channelId, beforeId: Number(messageId) + 1, limit: 100 }); }
    }); tile.append(view); grid.append(tile);
  }
  panel.append(head, grid);
  if (loadMore) { const more = document.createElement("button"); more.type = "button"; more.className = "ci-expanded-load"; more.textContent = "Load more"; more.addEventListener("click", () => { closeSharedItemsOverlay(); loadMore(); }); panel.append(more); }
  overlay.append(panel); overlay.addEventListener("click", ev => { if (ev.target === overlay) closeSharedItemsOverlay(); });
  drawer.append(overlay); _ciExpandedOverlay = overlay; close.focus();
  overlay.addEventListener("keydown", ev => { if (ev.key === "Escape") { ev.stopPropagation(); closeSharedItemsOverlay(); } });
}
async function renderChannelInfoItems() {
  const root = $("ciSharedItems");
  const ch = S.channels.get(S.active);
  if (!root || !ch) return;
  root.replaceChildren();
  const peer = ch.kind === "dm" ? _ciPeer(ch) : null;
  const messages = S.msgs.get(ch.id) || [];
  const items = [];
  const serverCache = peer ? null : _ciSharedCache.get(_ciSharedKey(ch.id, _channelInfoTab));
  if (!peer && serverCache) {
    for (const item of serverCache.items) {
      const mime = item.mimeType || "";
      if (item.itemType === "link") {
        let hostname = "";
        try { hostname = new URL(item.itemKey).hostname; } catch (_) {}
        items.push({ type: "link", id: item.messageId, ts: item.createdAt, sender: item.username, title: hostname || item.itemKey, detail: item.itemKey, url: item.itemKey, icon: "🌐" });
      } else if (item.itemType === "media") {
        items.push({ type: "media", id: item.messageId, ts: item.createdAt, sender: item.username, title: "Media", detail: mime || "Media", url: item.url || item.itemKey, icon: mime.startsWith("video/") ? "🎬" : "🖼️" });
      } else {
        items.push({ type: "file", id: item.messageId, ts: item.createdAt, sender: item.username, title: item.fileName || "Attachment", detail: mime || "File", url: item.url || item.itemKey, size: item.fileSize, icon: sharedFileIcon(mime, item.fileName || item.itemKey) });
      }
    }
  }
  if (peer || !serverCache) for (const m of messages) {
    if (m.deleted || m.kind === "system") continue;
    let text = m.text || "";
    if (peer && text.startsWith("e2e:v1:")) {
      const plain = await E2EE.tryDecrypt(peer.id, peer.pubkey, text);
      if (plain == null) continue;
      text = plain;
    }
    if (_channelInfoTab === "files" && m.file) {
      const mime = m.file.mimeType || "";
      items.push({ type: "file", id: m.id, ts: m.ts, sender: m.username, title: m.file.originalName || m.file.filename || "Attachment", detail: mime || "File", url: m.file.url, size: m.file.size, icon: sharedFileIcon(mime, m.file.originalName || m.file.filename) });
    }
    if (_channelInfoTab === "media" && m.file && /^(image\/|video\/)/i.test(m.file.mimeType || "")) {
      const mime = m.file.mimeType || "";
      items.push({ type: "media", id: m.id, ts: m.ts, sender: m.username, title: "Media", detail: mime || "Media", url: m.file.url, icon: mime.startsWith("video/") ? "🎬" : "🖼️" });
    }
    if (_channelInfoTab === "links") {
      for (const found of extractChatUrls(text)) {
        let hostname = "";
        try { hostname = new URL(found.url).hostname; } catch (_) {}
        items.push({ type: "link", id: m.id, ts: m.ts, sender: m.username, title: hostname || found.raw, detail: found.raw, url: found.url, icon: "🔗" });
      }
    }
  }
  items.sort((a,b) => (b.ts || 0) - (a.ts || 0));
  const countLabel = $("ciSharedCount");
  const counts = serverCache?.counts;
  if (countLabel) countLabel.textContent = counts
    ? (counts.media + " media · " + counts.links + " links · " + counts.files + " files")
    : (items.length + (items.length === 1 ? " loaded item" : " loaded items"));
  const tabLabels = { media: "Media", links: "Links", files: "Files" };
  if (counts) root.closest("#channelInfoContent")?.querySelectorAll("[data-ci-tab]").forEach(btn => {
    const type = btn.dataset.ciTab;
    const value = type === "media" ? counts.media : type === "links" ? counts.links : counts.files;
    btn.textContent = tabLabels[type] + " (" + value + ")";
  });
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "ci-empty";
    empty.textContent = serverCache ? "No shared " + (_channelInfoTab === "media" ? "media" : _channelInfoTab) + " found." : "No " + (_channelInfoTab === "media" ? "media" : _channelInfoTab) + " found in the currently loaded messages.";
    root.append(empty);
    return;
  }
  const type = _channelInfoTab;
  const limit = 4;
  const isMedia = type === "media";
  root.classList.add("ci-media-grid");
  root.classList.toggle("ci-links-grid", type === "links");
  root.classList.toggle("ci-files-grid", type === "files");
  const needsMore = items.length > limit || !!serverCache?.hasMore;
  const shown = items.slice(0, needsMore ? limit - 1 : limit);
  const makeTile = (item) => {
    const card = document.createElement("article"); card.className = "ci-item ci-preview-tile";
    const open = document.createElement("button"); open.type = "button"; open.className = "ci-preview-open";
    if (isMedia && item.url && (item.detail || "").startsWith("image/")) {
      const thumb = document.createElement("img"); thumb.className = "ci-media-thumb"; thumb.src = item.url; thumb.alt = "Shared image"; thumb.loading = "lazy"; thumb.decoding = "async"; thumb.referrerPolicy = "no-referrer";
      thumb.addEventListener("error", () => { thumb.removeAttribute("src"); thumb.alt = "Image unavailable"; card.classList.add("is-unavailable"); });
      open.append(thumb); open.addEventListener("click", () => openLightbox(item.url, "Shared image", item.url));
    } else {
      const icon = document.createElement("span"); icon.className = "ci-preview-icon"; icon.textContent = item.icon || (type === "links" ? "🔗" : "📄"); open.append(icon);
      if (type === "links" && item.url) open.addEventListener("click", () => window.open(item.url, "_blank", "noopener,noreferrer"));
      else if (type === "files" && item.url) open.addEventListener("click", () => { const a = document.createElement("a"); a.href = item.url; a.download = item.title || "attachment"; a.rel = "noopener noreferrer"; a.click(); });
      else open.addEventListener("click", () => openSharedItemsOverlay(type, items, serverCache?.hasMore ? () => requestChannelSharedItems(false) : null));
    }
    const overlay = document.createElement("span"); overlay.className = "ci-preview-caption";
    overlay.textContent = type === "media" ? (item.title || "Photo") : (item.title || item.detail || (type === "links" ? "Link" : "File"));
    open.append(overlay); card.append(open);
    return card;
  };
  for (const item of shown) root.append(makeTile(item));
  if (needsMore) {
    const more = document.createElement("button"); more.type = "button"; more.className = "ci-preview-tile ci-preview-more";
    more.setAttribute("aria-label", "View more " + type);
    const caption = document.createElement("span"); caption.className = "ci-preview-more-caption"; caption.textContent = "View more"; more.append(caption);
    more.addEventListener("click", () => openSharedItemsOverlay(type, items, serverCache?.hasMore ? () => requestChannelSharedItems(false) : null));
    root.append(more);
  }
}
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !$("channelInfoDrawer")?.classList.contains("hidden")) closeChannelInfo();
});
Object.assign(window, { openChannelInfo, closeChannelInfo });
