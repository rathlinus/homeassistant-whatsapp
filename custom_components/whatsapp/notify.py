"""Notify platform – allows using WhatsApp as a notification service in HA."""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.notify import (
    ATTR_DATA,
    ATTR_TARGET,
    BaseNotificationService,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DATA_CLIENT, DOMAIN
from .whatsapp_client import WhatsAppBridgeClient

_LOGGER = logging.getLogger(__name__)


async def async_get_service(
    hass: HomeAssistant,
    config: dict,
    discovery_info: dict | None = None,
) -> WhatsAppNotificationService | None:
    """Return the notification service (called by HA during platform setup)."""
    # discovery_info contains the config entry id when set up via config entries
    if discovery_info is None:
        return None

    entry_id = discovery_info.get("entry_id")
    client: WhatsAppBridgeClient = hass.data[DOMAIN][entry_id][DATA_CLIENT]
    return WhatsAppNotificationService(client)


class WhatsAppNotificationService(BaseNotificationService):
    """Implement the HA notify service for WhatsApp.

    Usage in automations / scripts:

        service: notify.whatsapp
        data:
          target: "1234567890"          # phone number (digits only or with country code)
          message: "Hello from HA!"
          data:
            media_url: "https://…/image.jpg"   # optional
            media_filename: "photo.jpg"         # optional

    Multiple targets:
          target:
            - "1234567890"
            - "0987654321@c.us"
    """

    def __init__(self, client: WhatsAppBridgeClient) -> None:
        self._client = client

    async def async_send_message(self, message: str = "", **kwargs: Any) -> None:
        """Send a WhatsApp message to one or more targets."""
        targets = kwargs.get(ATTR_TARGET, [])
        extra: dict = kwargs.get(ATTR_DATA) or {}

        if isinstance(targets, str):
            targets = [targets]

        if not targets:
            _LOGGER.error("[WA notify] No target(s) specified.")
            return

        media_url: str | None = extra.get("media_url")
        media_filename: str | None = extra.get("media_filename")

        for target in targets:
            try:
                await self._client.async_send_message(
                    to=target,
                    message=message,
                    media_url=media_url,
                    media_filename=media_filename,
                )
                _LOGGER.debug("[WA notify] Message sent to %s", target)
            except Exception as err:  # noqa: BLE001
                _LOGGER.error("[WA notify] Failed to send to %s: %s", target, err)
