# WhatsApp Bridge Add-on

Runs a [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) Node.js bridge server inside Home Assistant so you can send and receive WhatsApp messages using the WhatsApp custom integration.

## Configuration

| Option | Description | Default |
|--------|-------------|---------|
| `api_token` | Secret token the HA integration uses to authenticate | `change_me_to_a_random_secret` |
| `port` | Port the bridge listens on | `3000` |
| `log_level` | Log verbosity (`trace` `debug` `info` `warning` `error`) | `info` |

> **Important:** Change `api_token` to a long random string before starting.

## First-time setup (QR scan)

1. Start the add-on.
2. Click **Open Web UI** (or the **WhatsApp** item in the sidebar).
3. Wait a few seconds – the QR code appears in the page and refreshes itself.
4. Scan it with WhatsApp on your phone → **Settings → Linked devices → Link a device**.
5. The status badge turns green (`READY`) — you're done.

No token and no open port are needed: the Web UI runs through Home Assistant
Ingress, so it works over Nabu Casa / your reverse proxy just like the rest of HA.

The session is saved in `/data/wwebjs_auth` and survives add-on restarts.

## Pairing code (no QR scan)

If you can't scan a QR code, enter your phone number in the **Web UI** and click
**Request pairing code**, then type the code into WhatsApp → **Linked devices →
Link with phone number**.

The same thing over the REST API:

```bash
curl -X POST http://<HA-IP>:3000/api/pairing-code \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone": "+1234567890"}'
```

## Seeing the QR code in a dashboard

The WhatsApp custom integration exposes the same code as an image entity
(`image.whatsapp_qr_code`). Add a **Picture entity** card pointing at it to scan
the code straight from your dashboard.

## Support

See the [main repository README](https://github.com/rathlinus/homeassistant-whatsapp) for full documentation.
