# EdGameClaw — notes for coding agents

Self-hosted AI studio that turns learning material into playable browser mini-games.
Python 3.10+ / FastAPI backend, vanilla-JS canvas game engine, no frontend build step.

Read this before touching the generator: the expensive, non-obvious parts are the
generation pipeline and the sandbox repair loop.

## Layout

| Path | What it is |
| --- | --- |
| `edgameclaw/server.py` | FastAPI app: routes, job manager, course registry, embedded Node spawn |
| `edgameclaw/generator/api.py` | The **only** LLM call site: `generate(prompt, system_prompt, step=…)` |
| `edgameclaw/generator/pipeline.py` | Single-game pipeline — the `_step_*` prompt chain |
| `edgameclaw/generator/course_pipeline.py` | Multi-lesson course orchestration |
| `edgameclaw/generator/prompts.py` | All prompt text |
| `edgameclaw/generator/sandbox.py` | Validates generated JS; builds repair prompts |
| `edgameclaw/generator/sandbox_harness.js` | Node sandbox that mocks DOM/canvas and *executes* generated game code |
| `edgameclaw/engine/` | Runtime engine shipped into each generated course |
| `edgameclaw/node/server.js` | Engine state server, port 3100 |
| `edgameclaw/static/` | Studio and player HTML |
| `courses/` | **Generated output. Gitignored.** |
| `courses.json` | Course registry the Studio reads (tracked) |

## Running it

```bash
./start.sh            # Node engine on :3100 + uvicorn on :8000
```

`start.sh` needs `uvicorn` from `.venv/bin` or `PATH`. `Procfile` is the deploy form.
Studio at `/`, player at `/play`.

## Architecture facts that matter

- **One LLM entry point.** Everything goes through `generator/api.py: generate()`, an
  OpenAI-compatible non-streaming chat completion. There is no agent loop and no tool
  calling; "intelligence" is the prompt chain in `pipeline.py`. Add a step by adding a
  `_step_*` function, not by calling an API elsewhere.
- **Per-step models.** `get_model_for_step()` reads `STUDIO_MODEL_<STEP>` (e.g.
  `STUDIO_MODEL_SIM_IMPLEMENT`), falling back to `STUDIO_MODEL` / `MODEL`. Use it instead
  of hardcoding a model.
- **Env aliases.** `API_KEY` / `API_BASE_URL` / `MODEL` are the documented names;
  `OPENROUTER_API_KEY*` and `STUDIO_*` are legacy aliases unified in
  `server._unify_ai_env_aliases()`. Read keys through the existing helpers.
- **Generate → sandbox → repair.** Generated game JS is executed in
  `sandbox_harness.js` (not merely parsed); failures are fed back to the model by
  `sandbox.build_repair_prompt()`. Phases: `SYNTAX`, `EXEC`, `RUNTIME`, `NO_REGISTER`,
  `TIMEOUT`. Falls back to an `esprima` syntax check when Node is absent.
- **Generated minigame contract:** `registerMinigame(name, fn)`, where the harness calls
  `fn(container, data)`.
- **Checkpoints / resume.** Each course writes `_checkpoint.json`; re-running generation
  with the same `course_id` reuses cached steps. Do not "clean up" checkpoints.
- **Concurrency.** `api.py` holds a module-level `asyncio.Semaphore(2)` over all LLM
  calls. Raising it raises rate-limit risk.
- **Job logs** are a mix of plain strings and JSON envelopes
  (`{"type","label","value"}`). Handle both when parsing.

## Gotchas

- `courses/` and `jobs/` are gitignored. Generated lessons exist in exactly one place and
  cost real API credits to produce — **never** `rm -rf courses/` or `git clean -x`
  without being asked to.
- Every generation run spends money. Confirm before kicking one off, and prefer resuming
  an existing `course_id` over starting fresh.
- `.env` is gitignored and holds the only copy of the API key. Never print it, commit it,
  or send it anywhere.
- Timeouts are deliberately long (600s connect/read) for thinking models. A slow call is
  not necessarily a hung one.
- Licensing is dual: AGPL-3.0-or-later plus a commercial option (`COMMERCIAL.md`).
  Keep the `Created by Yuqi Hang` header comments in place.

## The pi agent

`.pi/extensions/edgameclaw/` adds EdGameClaw tools to the [pi](https://github.com/earendil-works/pi)
harness: Studio status, start the server, plan a course from markdown, generate/resume a
course with live job progress, validate game JS in the real sandbox, list/delete courses.
Also `/egc`. See [docs/pi-agent.md](docs/pi-agent.md).
