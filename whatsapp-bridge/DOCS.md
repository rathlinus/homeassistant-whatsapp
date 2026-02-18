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
2. Open the **Log** tab – you will see `[WA] QR code ready`.
3. Open `http://<HA-IP>:3000/api/qr` in your browser.  
   Add the header `Authorization: Bearer <your_api_token>`.  
   The easiest way: use the **Network** tab URL below, or the ModHeader browser extension.
4. Scan the QR with WhatsApp on your phone → **Linked Devices → Link a device**.
5. The log will print `[WA] Client ready.` — you're done.

The session is saved in `/data/wwebjs_auth` and survives add-on restarts.

## Pairing code (no QR scan)

If you can't scan a QR code, use the pairing code API:

```bash
curl -X POST http://<HA-IP>:3000/api/pairing-code \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone": "+1234567890"}'
```

Enter the returned 8-digit code in WhatsApp → **Linked Devices → Link with phone number**.

## Support

See the [main repository README](https://github.com/rathlinus/homeassistant-whatsapp) for full documentation.
