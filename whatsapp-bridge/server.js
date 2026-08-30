/**
 * WhatsApp Web.js Bridge Server – Home Assistant Add-on edition
 * --------------------------------------------------------------
 * Config is loaded from:
 *   1. /data/options.json  (when running as an HA add-on)
 *   2. .env file           (standalone / development)
 *
 * REST endpoints  (all require  Authorization: Bearer <api_token>  or  ?token=)
 *   GET  /api/status        – connection status
 *   GET  /api/qr            – HTML page with QR code
 *   GET  /api/qr.png        – raw PNG of the current QR (used by the HA image entity)
 *   GET  /api/qr.json       – { status, qr_data_url, updated_at }
 *   POST /api/pairing-code  – { "phone": "+1234567890" } → 8-digit code
 *   POST /api/send          – { "to", "message", "media_url?", "media_filename?" }
 *   GET  /api/chats         – recent chats
 *   POST /api/logout        – disconnect
 *
 * Ingress (port 8099, no token – Home Assistant authenticates the user):
 *   GET  /                  – web UI with the QR code, status and pairing code
 *
 * WebSocket  ws://<host>:<port>/ws?token=<api_token>
 *   Streams JSON events: message, ready, qr, authenticated, disconnected, …
 */

// ─── Config loading ───────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");

let cfg = {};

const HA_OPTIONS = "/data/options.json";
if (fs.existsSync(HA_OPTIONS)) {
  // Running as a Home Assistant add-on
  try {
    cfg = JSON.parse(fs.readFileSync(HA_OPTIONS, "utf8"));
    console.log("[Config] Loaded from HA add-on options (/data/options.json)");
  } catch (e) {
    console.error("[Config] Failed to parse options.json:", e.message);
  }
} else {
  // Standalone / development – use .env
  require("dotenv").config();
  cfg = {
    api_token: process.env.API_TOKEN,
    port: process.env.PORT,
    log_level: process.env.LOG_LEVEL,
  };
  console.log("[Config] Loaded from .env");
}

const PORT = parseInt(cfg.port || "3000", 10);
// Ingress always uses a fixed internal port – it is never published on the host.
const INGRESS_PORT = parseInt(process.env.INGRESS_PORT || "8099", 10);
const API_TOKEN = cfg.api_token || "change_me_to_a_random_secret";
// Session lives in /data when running as add-on (persistent across restarts)
const SESSION_PATH = fs.existsSync("/data") ? "/data/wwebjs_auth" : "./.wwebjs_auth";

// ─── Dependencies ─────────────────────────────────────────────────────────────
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const qrcode = require("qrcode");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ─── State ────────────────────────────────────────────────────────────────────
let currentQrDataUrl = null; // data:image/png;base64,… (WS event + legacy HTML page)
let currentQrPng = null; // Buffer with the raw PNG (for /api/qr.png)
let qrUpdatedAt = null; // ISO timestamp of the last QR refresh
let clientStatus = "DISCONNECTED";
let waClient = null;
let initAttempts = 0; // consecutive failed Chromium launches

function clearQr() {
  currentQrDataUrl = null;
  currentQrPng = null;
  qrUpdatedAt = null;
}

// ─── WhatsApp client ──────────────────────────────────────────────────────────
// Resolve Chromium path: env var → known Alpine paths → let Puppeteer decide
function resolveChromiumPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/lib/chromium/chromium",
    "/usr/lib/chromium-browser/chromium-browser",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function createClient() {
  const executablePath = resolveChromiumPath();
  console.log("[WA] Chromium path:", executablePath || "(letting Puppeteer decide)");

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
      executablePath,
      // NOTE: no --single-process / --no-zygote. Recent Chromium builds crash
      // immediately with those ("Target closed" during Target.setDiscoverTargets),
      // which left the bridge stuck at DISCONNECTED with no QR code.
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-accelerated-2d-canvas",
        "--disable-extensions",
        "--no-first-run",
        "--mute-audio",
      ],
    },
  });

  waClient.on("qr", async (qr) => {
    clientStatus = "QR_READY";
    initAttempts = 0;
    try {
      currentQrPng = await qrcode.toBuffer(qr, { width: 512, margin: 2 });
      currentQrDataUrl = "data:image/png;base64," + currentQrPng.toString("base64");
      qrUpdatedAt = new Date().toISOString();
    } catch (err) {
      console.error("[WA] Failed to render QR:", err.message);
      return;
    }
    broadcast({
      event: "qr",
      data: { qr_data_url: currentQrDataUrl, updated_at: qrUpdatedAt },
    });
    console.log('[WA] QR code ready – open the add-on "Open Web UI" button to scan it.');
  });

  waClient.on("authenticated", () => {
    clientStatus = "AUTHENTICATED";
    clearQr();
    broadcast({ event: "authenticated" });
    console.log("[WA] Authenticated.");
  });

  waClient.on("auth_failure", (msg) => {
    clientStatus = "AUTH_FAILURE";
    broadcast({ event: "auth_failure", data: { message: msg } });
    console.error("[WA] Authentication failure:", msg);
  });

  waClient.on("ready", () => {
    clientStatus = "READY";
    initAttempts = 0;
    clearQr();
    broadcast({ event: "ready", data: { info: waClient.info } });
    console.log("[WA] Client ready. WhatsApp is connected.");
  });

  waClient.on("disconnected", (reason) => {
    clientStatus = "DISCONNECTED";
    clearQr();
    broadcast({ event: "disconnected", data: { reason } });
    console.warn("[WA] Disconnected:", reason);
    setTimeout(() => {
      console.log("[WA] Reconnecting…");
      createClient();
    }, 5000);
  });

  waClient.on("message", async (msg) => {
    const payload = await buildMessagePayload(msg);
    broadcast({ event: "message", data: payload });
    console.log(`[WA] ← ${msg.from}: ${msg.body?.substring(0, 80)}`);
  });

  waClient.on("message_create", async (msg) => {
    if (msg.fromMe) {
      const payload = await buildMessagePayload(msg);
      broadcast({ event: "message_sent", data: payload });
    }
  });

  waClient.on("message_ack", (msg, ack) => {
    broadcast({ event: "message_ack", data: { message_id: msg.id._serialized, ack } });
  });

  waClient.on("change_state", (state) => {
    broadcast({ event: "state_change", data: { state } });
  });

  clientStatus = "INITIALIZING";
  waClient.initialize().catch(async (err) => {
    // Chromium can fail to come up (crash, OOM, missing libs). Retry with
    // backoff instead of sitting at DISCONNECTED until someone restarts us.
    clientStatus = "DISCONNECTED";
    initAttempts += 1;
    const delay = Math.min(60000, 10000 * initAttempts);
    console.error("[WA] initialize() error:", err.message);
    console.error("[WA] Chromium failed to start (attempt " + initAttempts + ") – retrying in " + delay / 1000 + "s.");
    try {
      await waClient.destroy();
    } catch (_) {}
    setTimeout(createClient, delay);
  });
}

async function buildMessagePayload(msg) {
  let contact_name = msg.from;
  try {
    const contact = await msg.getContact();
    contact_name = contact.pushname || contact.name || contact.number || msg.from;
  } catch (_) {}
  return {
    id: msg.id._serialized,
    from: msg.from,
    to: msg.to,
    body: msg.body,
    type: msg.type,
    timestamp: msg.timestamp,
    from_me: msg.fromMe,
    is_group: msg.from.endsWith("@g.us"),
    contact_name,
    has_media: msg.hasMedia,
    has_quoted: msg.hasQuotedMsg,
  };
}

// ─── Route handlers (shared by the API server and the Ingress server) ─────────
function auth(req, res, next) {
  // Accept token from Authorization header OR ?token= query param (for browser access)
  const header = req.headers["authorization"] || "";
  const headerToken = header.replace(/^Bearer\s+/i, "").trim();
  const queryToken = (req.query.token || "").trim();
  if (headerToken !== API_TOKEN && queryToken !== API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const noAuth = (_req, _res, next) => next();

function handleStatus(_req, res) {
  res.set("Cache-Control", "no-store");
  res.json({
    status: clientStatus,
    info: clientStatus === "READY" && waClient?.info ? waClient.info : null,
    has_qr: Boolean(currentQrPng),
    qr_updated_at: qrUpdatedAt,
  });
}

function handleQrJson(_req, res) {
  res.set("Cache-Control", "no-store");
  res.json({
    status: clientStatus,
    qr_data_url: currentQrDataUrl,
    updated_at: qrUpdatedAt,
  });
}

function handleQrPng(_req, res) {
  if (!currentQrPng) {
    return res.status(404).json({ error: "No QR code available. Status: " + clientStatus });
  }
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "no-store");
  res.send(currentQrPng);
}

function handleQrPage(_req, res) {
  if (clientStatus === "READY" || clientStatus === "AUTHENTICATED") {
    return res.send(`<!DOCTYPE html><html><body style="background:#111;color:#25D366;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <h2>✅ Already authenticated – no QR needed.</h2></body></html>`);
  }
  if (!currentQrDataUrl) {
    return res.send(`<!DOCTYPE html><html>
      <head><meta http-equiv="refresh" content="3"></head>
      <body style="background:#111;color:#aaa;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center"><h2 style="color:#25D366">Waiting for QR code…</h2>
        <p>Status: <b>${clientStatus}</b></p><p>This page refreshes every 3 seconds.</p></div>
      </body></html>`);
  }
  res.send(`<!DOCTYPE html><html>
    <head><title>WhatsApp QR Code</title><meta http-equiv="refresh" content="30"></head>
    <body style="background:#111;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
      <div style="text-align:center">
        <h2 style="color:#25D366;font-family:sans-serif">Scan with WhatsApp → Linked Devices</h2>
        <img src="${currentQrDataUrl}" style="width:300px;height:300px;border-radius:12px;display:block;margin:0 auto"/>
        <p style="color:#aaa;font-family:sans-serif;font-size:13px;margin-top:12px">Code refreshes automatically. Re-open this page if it expires.</p>
      </div>
    </body></html>`);
}

async function handlePairingCode(req, res) {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone is required" });
  if (!waClient) return res.status(503).json({ error: "WhatsApp client not started yet" });
  try {
    const code = await waClient.requestPairingCode(phone.replace(/\D/g, ""));
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function handleSend(req, res) {
  if (clientStatus !== "READY") {
    return res.status(503).json({ error: "WhatsApp not ready. Status: " + clientStatus });
  }
  const { to, message, media_url, media_filename } = req.body || {};
  if (!to) return res.status(400).json({ error: "'to' is required" });

  const chatId = to.includes("@") ? to : `${to.replace(/\D/g, "")}@c.us`;
  try {
    let sentMsg;
    if (media_url) {
      const media = await MessageMedia.fromUrl(media_url, {
        unsafeMime: true,
        filename: media_filename,
      });
      sentMsg = await waClient.sendMessage(chatId, media, { caption: message || undefined });
    } else {
      if (!message) return res.status(400).json({ error: "'message' is required" });
      sentMsg = await waClient.sendMessage(chatId, message);
    }
    console.log(`[WA] → ${chatId}: ${message}`);
    res.json({ success: true, message_id: sentMsg.id._serialized, timestamp: sentMsg.timestamp });
  } catch (err) {
    console.error("[WA] Send error:", err.message);
    res.status(500).json({ error: err.message });
  }
}

async function handleLogout(_req, res) {
  if (!waClient) return res.status(503).json({ error: "WhatsApp client not started yet" });
  try {
    await waClient.logout();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function handleChats(_req, res) {
  if (clientStatus !== "READY") return res.status(503).json({ error: "Not ready" });
  try {
    const chats = await waClient.getChats();
    res.json(
      chats.slice(0, 50).map((c) => ({
        id: c.id._serialized,
        name: c.name,
        is_group: c.isGroup,
        unread_count: c.unreadCount,
        timestamp: c.timestamp,
        last_message: c.lastMessage?.body || null,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function registerApiRoutes(expressApp, guard) {
  expressApp.get("/api/status", guard, handleStatus);
  expressApp.get("/api/qr", guard, handleQrPage);
  expressApp.get("/api/qr.png", guard, handleQrPng);
  expressApp.get("/api/qr.json", guard, handleQrJson);
  expressApp.post("/api/pairing-code", guard, handlePairingCode);
  expressApp.post("/api/send", guard, handleSend);
  expressApp.post("/api/logout", guard, handleLogout);
  expressApp.get("/api/chats", guard, handleChats);
}

// ─── API server (token protected, published on the host) ─────────────────────
const app = express();
app.use(express.json());
registerApiRoutes(app, auth);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const wsClients = new Set();

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("token") !== API_TOKEN) {
    ws.close(4001, "Unauthorized");
    return;
  }
  wsClients.add(ws);
  console.log("[WS] Client connected. Total:", wsClients.size);
  ws.send(JSON.stringify({ event: "status", data: { status: clientStatus } }));
  ws.on("close", () => { wsClients.delete(ws); });
  ws.on("error", () => { wsClients.delete(ws); });
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ─── Ingress server (no token – Home Assistant authenticates the user) ───────
// Only reachable through the Supervisor, never published on the host network.
const ingressApp = express();
ingressApp.use(express.json());
registerApiRoutes(ingressApp, noAuth);
ingressApp.get("/", (req, res) => res.send(renderIngressPage(req)));

function renderIngressPage(req) {
  // The Supervisor tells us under which path the UI is served, e.g.
  // /api/hassio_ingress/<token>. Build absolute URLs from it so the page works
  // whether or not the browser kept the trailing slash.
  const base = String(req.headers["x-ingress-path"] || "").replace(/\/$/, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Bridge</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f6f7; --card:#fff; --fg:#212121; --muted:#6b6f76; --line:#e3e5e8; --accent:#25D366; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1c2025; --fg:#e8eaed; --muted:#9aa0a6; --line:#2c3238; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--fg);
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:520px; margin:0 auto; display:flex; flex-direction:column; gap:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; }
  h1 { font-size:20px; margin:0 0 8px; }
  h2 { font-size:15px; margin:0 0 12px; }
  p { margin:0 0 8px; color:var(--muted); font-size:14px; line-height:1.5; }
  .badge { display:inline-block; padding:4px 10px; border-radius:999px; font-size:12px;
           font-weight:600; letter-spacing:.02em; background:var(--line); color:var(--fg); }
  .badge.ok { background:var(--accent); color:#04120a; }
  .badge.warn { background:#f5a623; color:#2a1b00; }
  .badge.err { background:#e5534b; color:#fff; }
  .qr { display:flex; align-items:center; justify-content:center; min-height:300px; text-align:center; }
  .qr img { width:280px; height:280px; background:#fff; padding:10px; border-radius:12px; }
  ol { margin:12px 0 0 18px; padding:0; color:var(--muted); font-size:14px; line-height:1.7; }
  input, button { font:inherit; }
  input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line);
          background:var(--bg); color:var(--fg); margin-bottom:10px; }
  button { padding:10px 16px; border-radius:8px; border:0; background:var(--accent);
           color:#04120a; font-weight:600; cursor:pointer; }
  button.secondary { background:var(--line); color:var(--fg); }
  button:disabled { opacity:.5; cursor:default; }
  .code { font-size:28px; font-weight:700; letter-spacing:.15em; margin-top:10px; color:var(--fg); }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <h1>WhatsApp Bridge</h1>
    <p>Status: <span id="status" class="badge">…</span></p>
  </div>

  <div class="card" id="qr-card">
    <h2>Scan to link your phone</h2>
    <div class="qr" id="qr-box"><p>Waiting for the QR code…</p></div>
    <ol>
      <li>Open WhatsApp on your phone</li>
      <li>Go to <b>Settings &rarr; Linked devices</b></li>
      <li>Tap <b>Link a device</b> and scan the code above</li>
    </ol>
  </div>

  <div class="card">
    <h2>No camera? Link with a pairing code</h2>
    <p>Enter your phone number in international format, then type the code into
       WhatsApp &rarr; Linked devices &rarr; <b>Link with phone number</b>.</p>
    <input id="phone" type="tel" placeholder="+49151234567" autocomplete="tel">
    <div class="row">
      <button id="pair-btn">Request pairing code</button>
      <button id="logout-btn" class="secondary">Log out / re-pair</button>
    </div>
    <div class="code" id="pair-code"></div>
  </div>

</div>
<script>
var BASE = ${JSON.stringify(base)};
function url(p) { return BASE + p; }
var statusEl = document.getElementById("status");
var qrBox = document.getElementById("qr-box");
var qrCard = document.getElementById("qr-card");
var lastQrAt = null;

function setStatus(s) {
  statusEl.textContent = s;
  statusEl.className = "badge" +
    (s === "READY" ? " ok" :
     s === "QR_READY" ? " warn" :
     (s === "AUTH_FAILURE" || s === "DISCONNECTED" || s === "UNREACHABLE") ? " err" : "");
}

async function poll() {
  try {
    var r = await fetch(url("/api/status"), { cache: "no-store" });
    var d = await r.json();
    setStatus(d.status);

    if (d.status === "READY" || d.status === "AUTHENTICATED") {
      qrCard.style.display = "none";
      lastQrAt = null;
    } else {
      qrCard.style.display = "";
      if (d.has_qr && d.qr_updated_at !== lastQrAt) {
        lastQrAt = d.qr_updated_at;
        var img = new Image();
        img.alt = "WhatsApp QR code";
        img.src = url("/api/qr.png") + "?t=" + encodeURIComponent(lastQrAt);
        qrBox.innerHTML = "";
        qrBox.appendChild(img);
      } else if (!d.has_qr) {
        lastQrAt = null;
        qrBox.innerHTML = "<p>Waiting for the QR code… this can take a minute after starting.</p>";
      }
    }
  } catch (e) {
    setStatus("UNREACHABLE");
  }
}

document.getElementById("pair-btn").addEventListener("click", async function (ev) {
  var btn = ev.currentTarget;
  var out = document.getElementById("pair-code");
  var phone = document.getElementById("phone").value.trim();
  if (!phone) { out.textContent = "Enter a phone number first."; return; }
  btn.disabled = true;
  out.textContent = "Requesting…";
  try {
    var r = await fetch(url("/api/pairing-code"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: phone }),
    });
    var d = await r.json();
    out.textContent = d.code || ("Error: " + (d.error || "unknown"));
  } catch (e) {
    out.textContent = "Error: " + e.message;
  }
  btn.disabled = false;
});

document.getElementById("logout-btn").addEventListener("click", async function (ev) {
  if (!confirm("Log out of WhatsApp? You will have to link your phone again.")) return;
  var btn = ev.currentTarget;
  btn.disabled = true;
  try { await fetch(url("/api/logout"), { method: "POST" }); } catch (e) {}
  setTimeout(function () { btn.disabled = false; }, 3000);
});

poll();
setInterval(poll, 2000);
</script>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Bridge] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[Bridge] Session stored in: ${SESSION_PATH}`);
  console.log(`[Bridge] QR page: http://localhost:${PORT}/api/qr  (needs auth header or ?token=)`);
  createClient();
});

ingressApp.listen(INGRESS_PORT, "0.0.0.0", () => {
  console.log(`[Bridge] Ingress UI on port ${INGRESS_PORT} – use the add-on's "Open Web UI" button.`);
});

process.on("SIGTERM", async () => {
  console.log("[Bridge] Shutting down…");
  if (waClient) await waClient.destroy().catch(() => {});
  server.close(() => process.exit(0));
});
