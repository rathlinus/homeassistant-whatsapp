/**
 * WhatsApp Web.js Bridge Server for Home Assistant
 * -------------------------------------------------
 * Exposes a REST API and a WebSocket event stream so the
 * Home Assistant Python integration can:
 *   • Receive real-time WhatsApp messages  (WebSocket)
 *   • Send WhatsApp messages               (POST /api/send)
 *   • Query connection status              (GET  /api/status)
 *   • Fetch the QR code image              (GET  /api/qr)
 *   • Request a pairing code               (POST /api/pairing-code)
 *   • Logout / disconnect                  (POST /api/logout)
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const qrcode = require("qrcode");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const API_TOKEN = process.env.API_TOKEN || "change_me_to_a_random_secret";
const SESSION_PATH = process.env.SESSION_PATH || "./.wwebjs_auth";

// ─── State ────────────────────────────────────────────────────────────────────
let currentQrDataUrl = null;   // latest QR as a data:image/png;base64,… string
let clientStatus = "DISCONNECTED"; // DISCONNECTED | INITIALIZING | QR_READY | AUTHENTICATED | READY | AUTH_FAILURE
let waClient = null;

// ─── WhatsApp client ──────────────────────────────────────────────────────────
function createClient() {
  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
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
    console.log("[WA] QR code ready – open GET /api/qr to view it.");
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
    console.log("[WA] Client ready.");
  });

  waClient.on("disconnected", (reason) => {
    clientStatus = "DISCONNECTED";
    broadcast({ event: "disconnected", data: { reason } });
    console.warn("[WA] Disconnected:", reason);
    // Auto-reconnect after 5 s
    setTimeout(() => {
      console.log("[WA] Attempting to reconnect…");
      createClient();
    }, 5000);
  });

  // ── Incoming messages ─────────────────────────────────────────────────────
  waClient.on("message", async (msg) => {
    const payload = await buildMessagePayload(msg);
    broadcast({ event: "message", data: payload });
    console.log(`[WA] Message from ${msg.from}: ${msg.body}`);
  });

  waClient.on("message_create", async (msg) => {
    // Fires for messages sent by *this* client too
    if (msg.fromMe) {
      const payload = await buildMessagePayload(msg);
      broadcast({ event: "message_sent", data: payload });
    }
  });

  waClient.on("message_ack", (msg, ack) => {
    // ack: 0=PENDING, 1=SERVER, 2=DEVICE, 3=READ, 4=PLAYED, -1=ERROR
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

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Simple bearer-token middleware
function auth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token !== API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// GET /api/status
app.get("/api/status", auth, (req, res) => {
  res.json({
    status: clientStatus,
    info: clientStatus === "READY" && waClient?.info ? waClient.info : null,
  });
});

// GET /api/qr  – returns an HTML page showing the QR image for easy scanning
app.get("/api/qr", auth, (req, res) => {
  if (clientStatus === "READY" || clientStatus === "AUTHENTICATED") {
    return res.json({ message: "Already authenticated, no QR needed." });
  }
  if (!currentQrDataUrl) {
    return res.json({ message: "QR not yet generated. Status: " + clientStatus });
  }
  res.send(`<!DOCTYPE html>
<html>
<head><title>WhatsApp QR Code</title></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#111;margin:0">
  <div style="text-align:center">
    <h2 style="color:#25D366;font-family:sans-serif">Scan with WhatsApp</h2>
    <img src="${currentQrDataUrl}" style="width:300px;height:300px;border-radius:12px" />
    <p style="color:#aaa;font-family:sans-serif;font-size:12px">This page auto-refreshes. Re-open if the code expires.</p>
  </div>
</body>
</html>`);
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

// POST /api/send  { "to": "1234567890", "message": "Hello" }
// Optional: "media_url" sends an image/document from a URL
app.post("/api/send", auth, async (req, res) => {
  if (clientStatus !== "READY") {
    return res.status(503).json({ error: "WhatsApp client not ready. Status: " + clientStatus });
  }

  const { to, message, media_url, media_filename } = req.body || {};
  if (!to) return res.status(400).json({ error: "'to' is required" });

  // Normalise phone number to WA chat ID
  const chatId = to.includes("@") ? to : `${to.replace(/\D/g, "")}@c.us`;

  try {
    let sentMsg;
    if (media_url) {
      const media = await MessageMedia.fromUrl(media_url, {
        unsafeMime: true,
        filename: media_filename,
      });
      sentMsg = await waClient.sendMessage(chatId, media, {
        caption: message || undefined,
      });
    } else {
      if (!message) return res.status(400).json({ error: "'message' is required when no media_url" });
      sentMsg = await waClient.sendMessage(chatId, message);
    }

    res.json({
      success: true,
      message_id: sentMsg.id._serialized,
      timestamp: sentMsg.timestamp,
    });
  } catch (err) {
    console.error("[WA] Send error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logout
app.post("/api/logout", auth, async (req, res) => {
  try {
    await waClient.logout();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/chats  – list recent chats
app.get("/api/chats", auth, async (req, res) => {
  if (clientStatus !== "READY") {
    return res.status(503).json({ error: "Not ready" });
  }
  try {
    const chats = await waClient.getChats();
    const list = chats.slice(0, 50).map((c) => ({
      id: c.id._serialized,
      name: c.name,
      is_group: c.isGroup,
      unread_count: c.unreadCount,
      timestamp: c.timestamp,
      last_message: c.lastMessage?.body || null,
    }));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HTTP server + WebSocket ──────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const wsClients = new Set();

wss.on("connection", (ws, req) => {
  // Authenticate via ?token=... query param
  const url = new URL(req.url, `http://localhost`);
  const token = url.searchParams.get("token");
  if (token !== API_TOKEN) {
    ws.close(4001, "Unauthorized");
    return;
  }

  wsClients.add(ws);
  console.log("[WS] Client connected. Total:", wsClients.size);

  // Send current status immediately on connect
  ws.send(JSON.stringify({ event: "status", data: { status: clientStatus } }));

  ws.on("close", () => {
    wsClients.delete(ws);
    console.log("[WS] Client disconnected. Total:", wsClients.size);
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
    wsClients.delete(ws);
  });
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of wsClients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(msg);
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Bridge] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[Bridge] WebSocket endpoint: ws://0.0.0.0:${PORT}/ws?token=<API_TOKEN>`);
  console.log(`[Bridge] QR page: http://localhost:${PORT}/api/qr  (auth header required)`);
  createClient();
});

process.on("SIGTERM", async () => {
  console.log("[Bridge] SIGTERM received, shutting down…");
  if (waClient) await waClient.destroy().catch(() => {});
  server.close();
  process.exit(0);
});
