"""Constants for the WhatsApp integration."""

DOMAIN = "whatsapp"

# Config entry keys
CONF_HOST = "host"
CONF_PORT = "port"
CONF_TOKEN = "token"

# Defaults
DEFAULT_HOST = "homeassistant.local"
DEFAULT_PORT = 3000

# Data keys stored in hass.data
DATA_CLIENT = "client"
DATA_UNSUB = "unsub"

# Event names fired on the HA event bus
EVENT_MESSAGE_RECEIVED = f"{DOMAIN}_message_received"

# Sensor unique-id suffixes
SENSOR_STATUS = "status"

# Services
SERVICE_SEND_MESSAGE = "send_message"
