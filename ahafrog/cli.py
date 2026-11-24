# -- Created by Yuqi Hang (github.com/yh2072) --
"""`ahafrog` — start the Studio.

Installing the package used to leave you holding
`uvicorn ahafrog.server:app --host 127.0.0.1 --port 8000`, which is a lot to
remember for "run the thing I just installed", and easy to get subtly wrong
(bind the wrong interface, forget the module path). This is that line, with
the defaults already chosen.

The server loads .env from the working directory on import, and starts the
bundled Node engine itself, so there is nothing to arrange here beyond
picking the address and saying where to look.
"""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ahafrog",
        description="Turn learning material into playable browser mini-games.",
    )
    parser.add_argument("--host", default="127.0.0.1",
                        help="interface to bind (default: 127.0.0.1, local only)")
    parser.add_argument("--port", type=int, default=8000, help="port (default: 8000)")
    parser.add_argument("--no-open", action="store_true",
                        help="do not open a browser")
    parser.add_argument("--reload", action="store_true",
                        help="reload on code changes (for development)")
    parser.add_argument("--version", action="store_true", help="print the version and exit")
    args = parser.parse_args(argv)

    if args.version:
        try:
            from importlib.metadata import version
            print(version("ahafrog"))
        except Exception:
            print("unknown")
        return 0

    try:
        import uvicorn
    except ImportError:
        print("uvicorn is missing — reinstall with: pip install -U ahafrog", file=sys.stderr)
        return 1

    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}/"
    print(f"\n  AhaFrog Studio  →  {url}\n")

    if not args.no_open:
        # After uvicorn is listening, not before, or the first load 404s on a
        # socket that is not up yet. A daemon thread so Ctrl-C still exits.
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    uvicorn.run("ahafrog.server:app", host=args.host, port=args.port,
                reload=args.reload, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
