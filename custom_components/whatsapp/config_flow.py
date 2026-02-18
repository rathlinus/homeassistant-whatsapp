"""Config flow for the WhatsApp integration."""
from __future__ import annotations

import logging
from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.exceptions import HomeAssistantError

from .const import CONF_HOST, CONF_PORT, CONF_TOKEN, DEFAULT_HOST, DEFAULT_PORT, DOMAIN

_LOGGER = logging.getLogger(__name__)

# When using the HA add-on, the correct host is the machine's IP or homeassistant.local,
# NOT localhost (add-on and HA core run in different Docker containers).
HOST_DESCRIPTION = (
    "IP or hostname of your HA machine (e.g. 192.168.1.10 or homeassistant.local). "
    "Use localhost only if running the bridge outside Docker on the same machine."
)


async def _validate_connection(hass: HomeAssistant, data: dict) -> dict:
    """Try to reach the bridge and return its status payload."""
    url = f"http://{data[CONF_HOST]}:{data[CONF_PORT]}/api/status"
    headers = {"Authorization": f"Bearer {data[CONF_TOKEN]}"}

    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 401:
                    raise InvalidToken
                resp.raise_for_status()
                return await resp.json()
        except aiohttp.ClientConnectorError as err:
            raise CannotConnect from err
        except InvalidToken:
            raise
        except Exception as err:
            raise CannotConnect from err


def _build_schema(defaults: dict) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(CONF_HOST, default=defaults.get(CONF_HOST, DEFAULT_HOST)): str,
            vol.Required(CONF_PORT, default=defaults.get(CONF_PORT, DEFAULT_PORT)): int,
            vol.Required(CONF_TOKEN, default=defaults.get(CONF_TOKEN, "")): str,
        }
    )


class WhatsAppConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for WhatsApp."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                await _validate_connection(self.hass, user_input)
            except CannotConnect:
                errors["base"] = "cannot_connect"
            except InvalidToken:
                errors["base"] = "invalid_token"
            except Exception:
                _LOGGER.exception("Unexpected error during config validation")
                errors["base"] = "unknown"
            else:
                await self.async_set_unique_id(
                    f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}"
                )
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=f"WhatsApp ({user_input[CONF_HOST]}:{user_input[CONF_PORT]})",
                    data=user_input,
                )

        return self.async_show_form(
            step_id="user",
            data_schema=_build_schema(user_input or {}),
            errors=errors,
            description_placeholders={"host_description": HOST_DESCRIPTION},
        )

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        """Handle reconfiguration (e.g. fix wrong host/token without re-adding)."""
        errors: dict[str, str] = {}
        entry = self.hass.config_entries.async_get_entry(self.context["entry_id"])

        if user_input is not None:
            try:
                await _validate_connection(self.hass, user_input)
            except CannotConnect:
                errors["base"] = "cannot_connect"
            except InvalidToken:
                errors["base"] = "invalid_token"
            except Exception:
                _LOGGER.exception("Unexpected error during reconfigure")
                errors["base"] = "unknown"
            else:
                return self.async_update_reload_and_abort(
                    entry,
                    data=user_input,
                    reason="reconfigure_successful",
                )

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=_build_schema(entry.data if entry else {}),
            errors=errors,
            description_placeholders={"host_description": HOST_DESCRIPTION},
        )


class CannotConnect(HomeAssistantError):
    """Error to indicate we cannot connect to the bridge."""


class InvalidToken(HomeAssistantError):
    """Error to indicate the API token is wrong."""
