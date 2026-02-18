"""
WhatsApp bridge HTTP + WebSocket client.

Communicates with the Node.js bridge server (bridge/server.js).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import aiohttp
import websockets
from websockets.exceptions import ConnectionClosedError, WebSocketException

from homeassistant.core import HomeAssistant

from .const import DOMAIN, EVENT_MESSAGE_RECEIVED

_LOGGER = logging.getLogger(__name__)

RECONNECT_DELAY = 5  # seconds


class WhatsAppBridgeClient:
    """Thin async wrapper around the bridge's REST + WebSocket API."""

    def __init__(self, hass: HomeAssistant, host: str, port: int, token: str) -> None:
        self._hass = hass
        self._host = host
        self._port = port
        self._token = token
        self._base_url = f"http://{host}:{port}"
        self._ws_url = f"ws://{host}:{port}/ws?token={token}"
        self._headers = {"Authorization": f"Bearer {token}"}
        self._ws_task: asyncio.Task | None = None
        self._running = False
        self.status: str = "DISCONNECTED"

    # ── Connection check ──────────────────────────────────────────────────────

    async def async_check_connection(self) -> dict:
        """Raise if the bridge is unreachable, otherwise return status."""
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self._base_url}/api/status",
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()
                self.status = data.get("status", "UNKNOWN")
                return data

    # ── REST helpers ──────────────────────────────────────────────────────────

    async def async_send_message(
        self,
        to: str,
        message: str = "",
        media_url: str | None = None,
        media_filename: str | None = None,
    ) -> dict:
        """Send a WhatsApp message via the bridge REST API."""
        payload: dict[str, Any] = {"to": to, "message": message}
        if media_url:
            payload["media_url"] = media_url
        if media_filename:
            payload["media_filename"] = media_filename

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{self._base_url}/api/send",
                json=payload,
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                data = await resp.json()
                if not resp.ok:
                    raise RuntimeError(data.get("error", "Unknown send error"))
                return data

    async def async_get_status(self) -> dict:
        """Return the current bridge + WhatsApp status."""
        return await self.async_check_connection()

    async def async_get_chats(self) -> list[dict]:
        """Return recent chats."""
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self._base_url}/api/chats",
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                resp.raise_for_status()
                return await resp.json()

    async def async_logout(self) -> None:
        """Log out from WhatsApp."""
        async with aiohttp.ClientSession() as session:
            await session.post(
                f"{self._base_url}/api/logout",
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=15),
            )

    # ── WebSocket listener ────────────────────────────────────────────────────

    async def async_start_listener(self) -> None:
        """Start the background WebSocket listener task."""
        self._running = True
        self._ws_task = self._hass.loop.create_task(
            self._ws_listen_loop(), name=f"{DOMAIN}_ws_listener"
        )

    async def async_stop_listener(self) -> None:
        """Stop the background WebSocket listener task."""
        self._running = False
        if self._ws_task and not self._ws_task.done():
            self._ws_task.cancel()
            try:
                await self._ws_task
            except asyncio.CancelledError:
                pass

    async def _ws_listen_loop(self) -> None:
        """Reconnecting WebSocket receive loop."""
        while self._running:
            try:
                _LOGGER.debug("[WA] Connecting to WebSocket %s", self._ws_url)
                async with websockets.connect(
                    self._ws_url,
                    ping_interval=30,
                    ping_timeout=10,
                    close_timeout=5,
                ) as ws:
                    _LOGGER.info("[WA] WebSocket connected to bridge.")
                    async for raw_msg in ws:
                        if not self._running:
                            break
                        try:
                            payload = json.loads(raw_msg)
                            self._handle_ws_event(payload)
                        except json.JSONDecodeError:
                            _LOGGER.warning("[WA] Non-JSON WS message: %s", raw_msg)

            except asyncio.CancelledError:
                _LOGGER.debug("[WA] WebSocket listener cancelled.")
                return
            except (ConnectionClosedError, WebSocketException, OSError, ConnectionRefusedError) as err:
                if self._running:
                    _LOGGER.warning(
                        "[WA] WebSocket disconnected (%s). Reconnecting in %ds…",
                        err,
                        RECONNECT_DELAY,
                    )
                    await asyncio.sleep(RECONNECT_DELAY)
            except Exception as err:  # noqa: BLE001
                _LOGGER.error("[WA] Unexpected WS error: %s", err)
                if self._running:
                    await asyncio.sleep(RECONNECT_DELAY)

    def _handle_ws_event(self, payload: dict) -> None:
        """Dispatch a WebSocket event from the bridge."""
        event_type = payload.get("event")
        data = payload.get("data", {})

        _LOGGER.debug("[WA] WS event: %s", event_type)

        if event_type == "status":
            self.status = data.get("status", self.status)

        elif event_type in ("ready", "authenticated"):
            self.status = event_type.upper()
            self._hass.bus.async_fire(
                f"{DOMAIN}_{event_type}",
                {
                    "info": data.get("info"),
                },
            )

        elif event_type == "disconnected":
            self.status = "DISCONNECTED"
            self._hass.bus.async_fire(f"{DOMAIN}_disconnected", data)

        elif event_type == "qr":
            # Fire an event so automations / dashboards can react
            self._hass.bus.async_fire(f"{DOMAIN}_qr_ready", {"qr_data_url": data.get("qr_data_url")})

        elif event_type == "message":
            # Fire on the HA event bus – automations can trigger on this
            self._hass.bus.async_fire(EVENT_MESSAGE_RECEIVED, data)

        elif event_type == "message_sent":
            self._hass.bus.async_fire(f"{DOMAIN}_message_sent", data)

        elif event_type == "message_ack":
            self._hass.bus.async_fire(f"{DOMAIN}_message_ack", data)

        elif event_type == "auth_failure":
            self.status = "AUTH_FAILURE"
            self._hass.bus.async_fire(f"{DOMAIN}_auth_failure", data)
