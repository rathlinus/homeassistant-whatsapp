/**
 * WhatsApp Web.js Bridge Server – Home Assistant Add-on edition
 * --------------------------------------------------------------
 * Config is loaded from:
 *   1. /data/options.json  (when running as an HA add-on)
 *   2. .env file           (standalone / development)
 *
 * REST endpoints  (all require  Authorization: Bearer <api_token>)
 *   GET  /api/status        – connection status
 *   GET  /api/qr            – HTML page with QR code
 *   POST /api/pairing-code  – { "phone": "+1234567890" } → 8-digit code
 *   POST /api/send          – { "to", "message", "media_url?", "media_filename?" }
 *   GET  /api/chats         – recent chats
 *   POST /api/logout        – disconnect
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
let currentQrDataUrl = null;
let clientStatus = "DISCONNECTED";
let waClient = null;

// ─── WhatsApp client ──────────────────────────────────────────────────────────
function createClient() {
  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    },
  });

  waClient.on("qr", async (qr) => {
    clientStatus = "QR_READY";
    currentQrDataUrl = await qrcode.toDataURL(qr);
    broadcast({ event: "qr", data: { qr_data_url: currentQrDataUrl } });
    console.log("[WA] QR code ready – open http://localhost:" + PORT + "/api/qr");
  });

  waClient.on("authenticated", () => {
    clientStatus = "AUTHENTICATED";
    currentQrDataUrl = null;
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
    broadcast({ event: "ready", data: { info: waClient.info } });
    console.log("[WA] Client ready. WhatsApp is connected.");
  });

  waClient.on("disconnected", (reason) => {
    clientStatus = "DISCONNECTED";
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
  waClient.initialize().catch((err) => {
    console.error("[WA] initialize() error:", err.message);
    clientStatus = "DISCONNECTED";
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

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

function auth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token !== API_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// GET /api/status
app.get("/api/status", auth, (_req, res) => {
  res.json({
    status: clientStatus,
    info: clientStatus === "READY" && waClient?.info ? waClient.info : null,
  });
});

// GET /api/qr  – renders the QR as a self-refreshing HTML page
app.get("/api/qr", auth, (_req, res) => {
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
});

// POST /api/pairing-code  { "phone": "+1234567890" }
app.post("/api/pairing-code", auth, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "phone is required" });
  try {
    const code = await waClient.requestPairingCode(phone.replace(/\D/g, ""));
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send
app.post("/api/send", auth, async (req, res) => {
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
});

// POST /api/logout
app.post("/api/logout", auth, async (_req, res) => {
  try {
    await waClient.logout();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chats
app.get("/api/chats", auth, async (_req, res) => {
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
});

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const wsClients = new Set();

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Bridge] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[Bridge] Session stored in: ${SESSION_PATH}`);
  console.log(`[Bridge] QR page: http://localhost:${PORT}/api/qr  (needs auth header)`);
  createClient();
});

process.on("SIGTERM", async () => {
  console.log("[Bridge] Shutting down…");
  if (waClient) await waClient.destroy().catch(() => {});
  server.close(() => process.exit(0));
});
