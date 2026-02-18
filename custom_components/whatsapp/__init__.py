"""WhatsApp integration – core setup."""
from __future__ import annotations

import asyncio
import logging

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv, discovery

from .const import (
    CONF_HOST,
    CONF_PORT,
    CONF_TOKEN,
    DATA_CLIENT,
    DATA_UNSUB,
    DOMAIN,
    SERVICE_SEND_MESSAGE,
)
from .whatsapp_client import WhatsAppBridgeClient

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor"]

SEND_MESSAGE_SCHEMA = vol.Schema(
    {
        vol.Required("to"): cv.string,
        vol.Optional("message", default=""): cv.string,
        vol.Optional("media_url"): cv.string,
        vol.Optional("media_filename"): cv.string,
    }
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up WhatsApp from a config entry."""
    host = entry.data[CONF_HOST]
    port = entry.data[CONF_PORT]
    token = entry.data[CONF_TOKEN]

    client = WhatsAppBridgeClient(hass, host, port, token)

    # Verify the bridge is reachable before registering everything
    try:
        await client.async_check_connection()
    except Exception as err:
        raise ConfigEntryNotReady(f"Cannot reach WhatsApp bridge at {host}:{port} – {err}") from err

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {
        DATA_CLIENT: client,
        DATA_UNSUB: [],
    }

    # Start WebSocket listener
    await client.async_start_listener()

    # Forward to sensor platform
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Load notify platform with discovery so async_get_service receives entry_id
    hass.async_create_task(
        discovery.async_load_platform(
            hass,
            "notify",
            DOMAIN,
            {"entry_id": entry.entry_id},
            hass.config_entries.async_get_entry(entry.entry_id).data,
        )
    )

    # Register service: whatsapp.send_message
    async def handle_send_message(call: ServiceCall) -> None:
        await client.async_send_message(
            to=call.data["to"],
            message=call.data.get("message", ""),
            media_url=call.data.get("media_url"),
            media_filename=call.data.get("media_filename"),
        )

    hass.services.async_register(
        DOMAIN,
        SERVICE_SEND_MESSAGE,
        handle_send_message,
        schema=SEND_MESSAGE_SCHEMA,
    )

    # Reload on config entry update
    entry.async_on_unload(entry.add_update_listener(async_reload_entry))

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)

    entry_data = hass.data[DOMAIN].pop(entry.entry_id, {})
    client: WhatsAppBridgeClient = entry_data.get(DATA_CLIENT)
    if client:
        await client.async_stop_listener()

    hass.services.async_remove(DOMAIN, SERVICE_SEND_MESSAGE)

    return unload_ok


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload a config entry."""
    await async_unload_entry(hass, entry)
    await async_setup_entry(hass, entry)
