"""Backward-compatible ASGI entrypoint when running from the repo root.

Prefer: ``uvicorn ahafrog.server:app`` or ``pip install -e .`` then the same.
"""

from ahafrog.server import app

__all__ = ["app"]
