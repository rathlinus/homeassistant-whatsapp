"""Sensor platform – exposes the WhatsApp connection status + last message."""
from __future__ import annotations

import logging
from datetime import datetime

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DATA_CLIENT, DOMAIN, EVENT_MESSAGE_RECEIVED, SENSOR_STATUS
from .whatsapp_client import WhatsAppBridgeClient

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    """Set up WhatsApp sensors."""
    client: WhatsAppBridgeClient = hass.data[DOMAIN][entry.entry_id][DATA_CLIENT]

    entities = [
        WhatsAppStatusSensor(entry, client),
        WhatsAppLastMessageSensor(entry, client),
    ]
    async_add_entities(entities)


class WhatsAppStatusSensor(SensorEntity):
    """Shows the current WhatsApp bridge connection status."""

    _attr_icon = "mdi:whatsapp"
    _attr_has_entity_name = True

    def __init__(self, entry: ConfigEntry, client: WhatsAppBridgeClient) -> None:
        self._entry = entry
        self._client = client
        self._attr_unique_id = f"{entry.entry_id}_{SENSOR_STATUS}"
        self._attr_name = "Status"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "WhatsApp",
            "manufacturer": "whatsapp-web.js",
            "model": "Bridge",
        }

    @property
    def native_value(self) -> str:
        """Return current WhatsApp status."""
        return self._client.status

    async def async_added_to_hass(self) -> None:
        """Subscribe to bridge status events."""

        @callback
        def _on_status_change(event) -> None:
            self.async_write_ha_state()

        for event_name in (
            f"{DOMAIN}_ready",
            f"{DOMAIN}_authenticated",
            f"{DOMAIN}_disconnected",
            f"{DOMAIN}_auth_failure",
        ):
            self.async_on_remove(
                self.hass.bus.async_listen(event_name, _on_status_change)
            )


class WhatsAppLastMessageSensor(SensorEntity):
    """Shows the last received WhatsApp message."""

    _attr_icon = "mdi:message-text"
    _attr_has_entity_name = True

    def __init__(self, entry: ConfigEntry, client: WhatsAppBridgeClient) -> None:
        self._entry = entry
        self._client = client
        self._attr_unique_id = f"{entry.entry_id}_last_message"
        self._attr_name = "Last Message"
        self._last_message: dict = {}
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "WhatsApp",
            "manufacturer": "whatsapp-web.js",
            "model": "Bridge",
        }

    @property
    def native_value(self) -> str | None:
        """Return the body of the last message."""
        return self._last_message.get("body")

    @property
    def extra_state_attributes(self) -> dict:
        """Return additional message details."""
        return {
            "from": self._last_message.get("from"),
            "contact_name": self._last_message.get("contact_name"),
            "timestamp": self._last_message.get("timestamp"),
            "is_group": self._last_message.get("is_group"),
            "has_media": self._last_message.get("has_media"),
            "message_id": self._last_message.get("id"),
        }

    async def async_added_to_hass(self) -> None:
        """Subscribe to incoming message events."""

        @callback
        def _on_message(event) -> None:
            self._last_message = event.data
            self.async_write_ha_state()

        self.async_on_remove(
            self.hass.bus.async_listen(EVENT_MESSAGE_RECEIVED, _on_message)
        )
