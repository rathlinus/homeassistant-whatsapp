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
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error during config validation")
                errors["base"] = "unknown"
            else:
                # Prevent duplicate entries for the same host:port
                await self.async_set_unique_id(
                    f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}"
                )
                self._abort_if_unique_id_configured()

                return self.async_create_entry(
                    title=f"WhatsApp ({user_input[CONF_HOST]}:{user_input[CONF_PORT]})",
                    data=user_input,
                )

        schema = vol.Schema(
            {
                vol.Required(CONF_HOST, default=DEFAULT_HOST): str,
                vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
                vol.Required(CONF_TOKEN): str,
            }
        )

        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)


class CannotConnect(HomeAssistantError):
    """Error to indicate we cannot connect to the bridge."""


class InvalidToken(HomeAssistantError):
    """Error to indicate the API token is wrong."""
