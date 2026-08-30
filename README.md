# WhatsApp for Home Assistant (HACS + Add-on)

Send and receive WhatsApp messages directly from Home Assistant using [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).

> ⚠️ **Disclaimer:** This integration uses an unofficial WhatsApp API. Use at your own risk. WhatsApp may block accounts that use unofficial clients. Not affiliated with WhatsApp / Meta.

---

## ⚡ Easiest install – Home Assistant Add-on (recommended)

> Requires **Home Assistant OS** or **Supervised** (i.e. you have the Add-ons panel).

### 1 – Add this repository to HA

1. Go to **Settings → Add-ons → Add-on Store**
2. Click the ⋮ menu (top right) → **Repositories**
3. Paste: `https://github.com/rathlinus/homeassistant-whatsapp`
4. Click **Add** → **Close**

### 2 – Install & configure the add-on

1. Find **WhatsApp Bridge** in the store and click **Install**
2. Go to the **Configuration** tab and set `api_token` to a long random secret
3. Click **Save** then **Start**

### 3 – Scan the QR code (one time)

1. Click **Open Web UI** on the add-on page (or the **WhatsApp** entry in the sidebar)
2. Wait a few seconds – the QR code shows up and refreshes itself automatically
3. Scan it with WhatsApp → **Settings → Linked devices → Link a device**
4. The status badge turns green (`READY`) ✅ — the session is saved, no re-scan needed

The Web UI goes through Home Assistant Ingress, so there is no token to paste and
no port to open – it works remotely (Nabu Casa / reverse proxy) too.

No camera on hand? Type your phone number into the same page and click
**Request pairing code**, then enter the code in WhatsApp → **Linked devices →
Link with phone number**.

Once the integration below is set up you can also scan the code from a dashboard:
add a **Picture entity** card for `image.whatsapp_qr_code`.

### 4 – Install & configure the HA integration

1. Install via HACS (see section below) or copy `custom_components/whatsapp/` to your HA config
2. Restart Home Assistant
3. **Settings → Devices & Services → Add Integration → WhatsApp**
   - Host: `localhost` (add-on and HA are on the same machine)
   - Port: `3000`
   - Token: your `api_token` from step 2

---

## Architecture

```
Home Assistant (Python)          Node.js Bridge Server
┌─────────────────────┐          ┌───────────────────────┐
│  custom_components/ │ REST+WS  │  bridge/server.js     │
│  whatsapp/          │◄────────►│  (whatsapp-web.js)    │
│  - sensor           │          │  - Manages WA session │
│  - notify           │          │  - QR / pairing code  │
│  - services         │          │  - Send / receive     │
└─────────────────────┘          └───────────────────────┘
```

---

## Requirements

- **Home Assistant** 2023.1+
- **Node.js** 18+ (on the same machine or any machine reachable from HA)
- A WhatsApp account / phone number

---

## 1 – Start the bridge server

```bash
cd bridge
cp .env.example .env
# Edit .env: set a strong API_TOKEN
npm install
npm start
```

The server will print something like:

```
[Bridge] Listening on http://0.0.0.0:3000
[WA] QR code ready – open GET /api/qr to view it.
```

### Scan the QR code

Open `http://<bridge-host>:3000/api/qr` in a browser (add the `Authorization: Bearer <token>` header, or use the Swagger-style curl below):

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3000/api/qr
```

Alternatively use the **pairing code** (no QR needed):

```bash
curl -X POST http://localhost:3000/api/pairing-code \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone": "+1234567890"}'
```

Enter the 8-digit code in WhatsApp → Linked Devices → Link with phone number.

### Run as a Docker container

```dockerfile
# bridge/Dockerfile (minimal example)
FROM node:20-slim
RUN apt-get update && apt-get install -y chromium --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js .
CMD ["node", "server.js"]
```

```bash
docker build -t ha-whatsapp-bridge ./bridge
docker run -d --name ha-whatsapp-bridge \
  -p 3000:3000 \
  -e API_TOKEN=your_secret_token \
  -v whatsapp_session:/app/.wwebjs_auth \
  ha-whatsapp-bridge
```

---

## 2 – Install the HA integration (via HACS)

1. In HACS → **Integrations** → ⋮ → **Custom repositories**
2. Add the URL of this repo, category **Integration**
3. Install **WhatsApp**
4. Restart Home Assistant

Or manually copy the `custom_components/whatsapp` folder to your HA `config/custom_components/` directory.

---

## 3 – Configure in Home Assistant

Go to **Settings → Devices & Services → Add Integration → WhatsApp**.

| Field | Description |
|-------|-------------|
| Host  | IP / hostname of the bridge server (e.g. `192.168.1.10`) |
| Port  | Bridge port (default `3000`) |
| API Token | The token you set in the bridge `.env` file |

---

## Entities

| Entity | Description |
|--------|-------------|
| `sensor.whatsapp_status` | Current connection status (`READY`, `QR_READY`, `DISCONNECTED`, …) |
| `image.whatsapp_qr_code` | The pairing QR code while the bridge waits to be linked (unavailable once linked) |
| `sensor.whatsapp_last_message` | Body of the last received message; attributes include `from`, `contact_name`, `timestamp`, `is_group`, `has_media` |

---

## Sending messages

### Via the `notify` service (recommended)

```yaml
service: notify.whatsapp
data:
  target: "1234567890"          # digits only, or with country code: 441234567890
  message: "Hello from HA!"
```

Send to a group (use the group chat ID):

```yaml
service: notify.whatsapp
data:
  target: "120363XXXXXXXXXX@g.us"
  message: "Group message!"
```

Send an image:

```yaml
service: notify.whatsapp
data:
  target: "1234567890"
  message: "Check this out!"
  data:
    media_url: "https://example.com/image.png"
    media_filename: "photo.png"
```

### Via the `whatsapp.send_message` service

```yaml
service: whatsapp.send_message
data:
  to: "1234567890"
  message: "Hello!"
```

---

## Automations – reacting to incoming messages

The integration fires a `whatsapp_message_received` event on the HA event bus whenever a WhatsApp message arrives.

### Blueprint / automation example

```yaml
automation:
  alias: "WhatsApp – respond to ping"
  trigger:
    - platform: event
      event_type: whatsapp_message_received
      event_data:
        body: "!ping"
  action:
    - service: notify.whatsapp
      data:
        target: "{{ trigger.event.data.from | replace('@c.us','') }}"
        message: "pong 🏓"
```

### Event data fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Message ID |
| `from` | string | Sender chat ID (e.g. `1234567890@c.us`) |
| `to` | string | Recipient chat ID |
| `body` | string | Message text |
| `type` | string | Message type (`chat`, `image`, `document`, …) |
| `timestamp` | int | Unix timestamp |
| `from_me` | bool | `true` if sent by you |
| `is_group` | bool | `true` if group message |
| `contact_name` | string | Display name of the sender |
| `has_media` | bool | `true` if the message contains media |
| `has_quoted` | bool | `true` if the message is a reply |

---

## Other events fired on the HA event bus

| Event | When |
|-------|------|
| `whatsapp_ready` | WhatsApp client connected and ready |
| `whatsapp_authenticated` | Session authenticated (after QR scan) |
| `whatsapp_disconnected` | WhatsApp disconnected |
| `whatsapp_qr_ready` | New QR code is available (data `qr_data_url`) |
| `whatsapp_auth_failure` | Authentication failed |
| `whatsapp_message_sent` | Message sent by this client |
| `whatsapp_message_ack` | Message delivery acknowledgement |

---

## Bridge REST API reference

All endpoints require `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/status` | Connection status + client info |
| `GET`  | `/api/qr` | HTML page showing the QR code to scan |
| `GET`  | `/api/qr.png` | Raw PNG of the current QR code (404 when already linked) |
| `GET`  | `/api/qr.json` | `{ status, qr_data_url, updated_at }` |
| `POST` | `/api/pairing-code` | `{ "phone": "+1234567890" }` → 8-digit code |
| `POST` | `/api/send` | `{ "to", "message", "media_url?", "media_filename?" }` |
| `GET`  | `/api/chats` | List of 50 most recent chats |
| `POST` | `/api/logout` | Log out from WhatsApp |
| `WS`   | `/ws?token=` | Real-time event stream (JSON frames) |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot connect to the bridge` | Make sure `npm start` is running and the host/port are correct |
| Status stuck at `QR_READY` | Open the add-on **Web UI** (or the `image.whatsapp_qr_code` entity) and scan the code |
| QR code never appears | Give Chromium up to a minute to start; check the add-on log for `[WA] QR code ready` |
| Messages not received in HA | Check the WebSocket connection – look for `[WA] WebSocket connected` in HA logs |
| Bridge crashes on startup | Ensure Node.js ≥ 18 and Chromium / puppeteer dependencies are installed |
| Docker: puppeteer can't find Chrome | Set `PUPPETEER_EXECUTABLE_PATH` in the container environment |

---

## License

Apache-2.0
