# -- Created by Yuqi Hang (github.com/yh2072) --
"""Cooperative cancellation for a generation run.

A run is a long chain of model calls that costs real money and writes
`_checkpoint.json` after each completed step, so that re-running the same
course_id reuses what was already paid for. That makes *how* a run stops
matter as much as whether it can.

Cancelling the asyncio task outright would cut in wherever the run happens to
be -- possibly mid-checkpoint-write -- and could lose steps the user has
already paid for, which is the one outcome worth avoiding. So a run is stopped
cooperatively at the single place every step passes through: the model call in
`generator/api.py: generate()`. Between two model calls the checkpoint on disk
is always consistent, so a stopped run is just a run that can be resumed.

One check in `generate()` covers the whole prompt chain. Adding a step needs no
cancellation code of its own.
"""

from __future__ import annotations

import contextvars


class Cancelled(Exception):
    """Raised inside a run once a stop has been requested."""


class CancelToken:
    """One run's stop flag. Set from the request thread, read inside the run."""

    __slots__ = ("_requested",)

    def __init__(self) -> None:
        self._requested = False

    def request(self) -> None:
        self._requested = True

    @property
    def requested(self) -> bool:
        return self._requested

    def raise_if_requested(self) -> None:
        if self._requested:
            raise Cancelled("Generation stopped by the user")


# asyncio.create_task copies the current context, so a token set before the
# run starts is visible to everything the run awaits, including steps that
# fan out with gather().
current: contextvars.ContextVar[CancelToken | None] = contextvars.ContextVar(
    "edgameclaw_cancel_token", default=None
)


def check() -> None:
    """Raise Cancelled if this run has been asked to stop. Cheap; call freely."""
    token = current.get()
    if token is not None:
        token.raise_if_requested()


def requested() -> bool:
    token = current.get()
    return token is not None and token.requested
