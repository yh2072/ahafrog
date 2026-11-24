# EdGameClaw extension for pi

Auto-discovered by [pi](https://github.com/earendil-works/pi) as
`.pi/extensions/edgameclaw/index.ts` once this project is trusted.

```
index.ts          tools, /egc command, destructive-command guard
lib/project.ts    find the checkout; read ports/model/key presence from .env
lib/studio.ts     HTTP client for edgameclaw/server.py
lib/sandbox.ts    wraps generator/sandbox_harness.js
test/smoke.mjs    loads the extension with a stub API and exercises it
```

Full usage: [docs/pi-agent.md](../../../docs/pi-agent.md).
Project knowledge the agent reads: [AGENTS.md](../../../AGENTS.md).

Constraints worth preserving:

- **No runtime dependencies.** Node builtins plus `typebox`, which pi aliases into the
  jiti loader for project extensions. A fresh clone needs no `npm install`.
- **The API key is never read into a tool result.** `lib/project.ts` reports only whether
  one is set, and from where.
- **Generation goes through the Studio's HTTP API**, not the Python package, so jobs,
  resume and the `courses.json` registry have exactly one implementation.
