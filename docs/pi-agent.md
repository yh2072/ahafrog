# The EdGameClaw pi agent

[pi](https://github.com/earendil-works/pi) is a minimal, extensible agent harness (a
terminal coding agent, MIT, TypeScript/Node ≥ 22.19). This repo ships a pi *extension*
that teaches it EdGameClaw: it can check and start the Studio, plan a course from
markdown, generate or resume one while streaming job progress, validate generated game
JS in the real sandbox, and list or delete courses.

## Install pi

Either of these; pick one. pi is not vendored into this repo.

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

The npm package does not pin transitive dependencies; the official installer does and
adds `pi update`. The second command runs a script fetched from the network — read it
first if that matters to you.

Then authenticate once:

```bash
pi
```

and run `/login` inside pi to connect a subscription or an API key. This is pi's own
model access, separate from the `API_KEY` in `.env` that EdGameClaw's generator uses.

## Use it

```bash
cd /path/to/edgameclaw && pi
```

Run pi from the repo (or any subdirectory). On first run pi asks you to **trust** the
project; project-local extensions under `.pi/` are only loaded once you do. pi also picks
up `AGENTS.md` from the repo root as context, so the agent starts out knowing the layout,
the generation pipeline and the gotchas.

Then just ask, e.g.:

- "Is the studio running? Start it if not."
- "Plan a course from `notes.md` and show me the lesson split before generating."
- "Generate it in Chinese."
- "Resume course-1774497192059."
- "This simulation JS I edited — does it still pass the sandbox?"

`/egc` prints Studio status; `/egc courses` adds the course list.

## Tools it adds

| Tool | Does |
| --- | --- |
| `edgameclaw_status` | Studio + engine-state server state, model, whether an API key is set, course count |
| `edgameclaw_start_studio` | Runs `./start.sh` detached, waits until the server answers, logs to `.pi/logs/studio.log` |
| `edgameclaw_courses` | Lists courses with ids, lesson counts and play URLs |
| `edgameclaw_plan_course` | Markdown → the structured course plan, generating nothing |
| `edgameclaw_generate_course` | Starts generation and streams job progress; reuse a `course_id` to resume |
| `edgameclaw_job` | Re-attach to a running or finished generation job |
| `edgameclaw_validate_js` | Executes game JS in `generator/sandbox_harness.js` — the pipeline's own validator |
| `edgameclaw_delete_course` | Deletes a course, after confirmation |

The generation tools drive the Studio's HTTP API rather than importing the Python
package, so the agent and the browser Studio share one orchestration path — the same job
manager, the same `courses.json` registry, the same resume behaviour.

## Safety

Two things cost real money or are unrecoverable here, so the extension gates them:

- **Generating a course** spends API credits per lesson. The agent asks before starting
  one, and reports the model and lesson count in the prompt.
- **Destroying generated work.** `courses/` and `jobs/` are gitignored, so `rm -rf
  courses/` or `git clean -xdf` cannot be undone by git. A `tool_call` hook intercepts
  `bash` commands that touch `courses/`, `jobs/`, `courses.json` or `.env` and asks
  first. With no UI to ask in (`pi --print`), it blocks instead.

Tune that policy in `classifyCommand()` in
[`.pi/extensions/edgameclaw/index.ts`](../.pi/extensions/edgameclaw/index.ts).

Note pi's own caveat: it has no built-in permission system, and an extension can see
prompts, tool calls, files and credentials. Treat `.pi/extensions/` as trusted code and
review it like any other code you run — including in any fork or clone of this repo.

## Developing the extension

No `npm install` is needed to *use* it: the only runtime import is `typebox`, which pi
aliases to its own copy when it loads project extensions, and pi's own types are imported
type-only and erased.

To typecheck or smoke-test it, install the dev-only peers somewhere and point at them:

```bash
npm install --no-save @earendil-works/pi-coding-agent typescript @types/node
```

```bash
node .pi/extensions/edgameclaw/test/smoke.mjs
```

The smoke test loads `index.ts` through jiti (pi's loader) with a stub `ExtensionAPI`,
checks every tool's schema, and really runs the sandbox harness and the bash guard. It
does not need pi to be authenticated.
