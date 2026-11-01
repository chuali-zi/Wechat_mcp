"""Live read budget shared by direct callers and the JSON-RPC backend."""
import os

from wxtext.errors import ToolError

DEFAULT_LIVE_TIMEOUT_MS = 30_000
MAX_LIVE_TIMEOUT_MS = 2_147_481_647  # Leave room for the JS transport grace period.


def live_timeout_ms(value=None):
    if value is None:
        value = os.environ.get("WEFLOW_LIVE_TIMEOUT_MS", str(DEFAULT_LIVE_TIMEOUT_MS))
    text = str(value)
    if not text.isascii() or not text.isdecimal() or not 1 <= int(text) <= MAX_LIVE_TIMEOUT_MS:
        raise ToolError("INVALID_ARGUMENT", "Live timeout must be an integer from 1 to 2147481647 milliseconds.")
    return int(text)
