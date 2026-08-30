"""Image platform – shows the WhatsApp pairing QR code inside Home Assistant.

The bridge pushes a new QR code over the WebSocket every ~20 seconds while it is
waiting to be linked. This entity mirrors that code so it can be put on a
dashboard (Picture entity card) instead of having to open the bridge port with a
token in the browser.
"""
from __future__ import annotations

import base64
import binascii
import logging

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DATA_CLIENT, DOMAIN, EVENT_QR_READY
from .whatsapp_client import WhatsAppBridgeClient

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up the WhatsApp QR code image entity."""
    client: WhatsAppBridgeClient = hass.data[DOMAIN][entry.entry_id][DATA_CLIENT]
    async_add_entities([WhatsAppQrImage(hass, entry, client)])


class WhatsAppQrImage(ImageEntity):
    """The current pairing QR code, as a PNG image entity."""

    _attr_content_type = "image/png"
    _attr_has_entity_name = True
    _attr_icon = "mdi:qrcode-scan"

    def __init__(
        self, hass: HomeAssistant, entry: ConfigEntry, client: WhatsAppBridgeClient
    ) -> None:
        super().__init__(hass)
        self._entry = entry
        self._client = client
        self._qr_png: bytes | None = None
        self._attr_unique_id = f"{entry.entry_id}_qr_code"
        self._attr_name = "QR Code"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "WhatsApp",
            "manufacturer": "whatsapp-web.js",
            "model": "Bridge",
        }

    @property
    def available(self) -> bool:
        """The QR code only exists while the bridge is waiting to be linked."""
        return self._qr_png is not None

    async def async_image(self) -> bytes | None:
        """Return the current QR code as PNG bytes."""
        return self._qr_png

    async def async_added_to_hass(self) -> None:
        """Fetch the current QR code and subscribe to updates."""
        await self._async_fetch_qr()

        @callback
        def _on_qr(event) -> None:
            data_url = event.data.get("qr_data_url") or ""
            _, _, b64 = data_url.partition("base64,")
            if not b64:
                return
            try:
                self._set_qr(base64.b64decode(b64))
            except (binascii.Error, ValueError) as err:
                _LOGGER.warning("[WA] Could not decode QR image: %s", err)

        @callback
        def _on_linked(event) -> None:
            # Once linked there is no QR code any more.
            self._set_qr(None)

        self.async_on_remove(self.hass.bus.async_listen(EVENT_QR_READY, _on_qr))
        for event_name in (f"{DOMAIN}_ready", f"{DOMAIN}_authenticated"):
            self.async_on_remove(self.hass.bus.async_listen(event_name, _on_linked))

    async def _async_fetch_qr(self) -> None:
        """Pull the QR code from the bridge (needed after a HA restart)."""
        try:
            self._qr_png = await self._client.async_get_qr_png()
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("[WA] Could not fetch QR code from bridge: %s", err)
            self._qr_png = None
        if self._qr_png:
            self._attr_image_last_updated = dt_util.utcnow()

    @callback
    def _set_qr(self, png: bytes | None) -> None:
        """Store a new QR code and tell HA the image changed."""
        self._qr_png = png
        self._attr_image_last_updated = dt_util.utcnow() if png else None
        self.async_write_ha_state()
