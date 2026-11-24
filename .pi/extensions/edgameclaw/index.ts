/**
 * EdGameClaw agent for the pi harness (https://github.com/earendil-works/pi).
 *
 * Auto-discovered by pi as `.pi/extensions/edgameclaw/index.ts` once this project is
 * trusted. Project knowledge lives in AGENTS.md at the repo root, which pi loads as a
 * context file; this file adds the *capabilities* that knowledge refers to.
 *
 * Design notes:
 *  - Runtime dependencies: none. Only Node builtins plus `typebox`, which pi provides.
 *    So `pi` works in a fresh clone with no `npm install`.
 *  - Course generation is driven through the Studio's HTTP API, not by importing Python,
 *    so the agent and the browser Studio share one orchestration path (jobs, resume,
 *    the courses.json registry). See lib/studio.ts.
 *  - The AI key is never read into a tool result. Tools report only whether one is set.
 */

import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { findProjectRoot, type ProjectPaths, projectPaths, readStudioConfig, type StudioConfig } from "./lib/project.ts";
import { type CoursePlan, formatJobLine, type JobState, StudioClient } from "./lib/studio.ts";
import { runSandbox, type SandboxMode } from "./lib/sandbox.ts";

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";

// ── small result helpers ─────────────────────────────────────────────────────

function result(text: string, details: unknown = undefined, isError = false) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

const ok = (text: string, details?: unknown) => result(text, details, false);
const fail = (text: string, details?: unknown) => result(text, details, true);

// ── project resolution ───────────────────────────────────────────────────────

interface Resolved {
  paths: ProjectPaths;
  config: StudioConfig;
  studio: StudioClient;
}

/**
 * Resolve the checkout from the context's cwd. pi can be launched from a subdirectory,
 * and a tool must never guess a root: a wrong root would point generation at the wrong
 * courses/ directory.
 */
function resolveProject(ctx: { cwd: string }): Resolved {
  const root = findProjectRoot(ctx.cwd);
  if (!root) {
    throw new Error(
      `not inside an EdGameClaw checkout (looked upward from ${ctx.cwd} for pyproject.toml + edgameclaw/server.py)`,
    );
  }
  const paths = projectPaths(root);
  const config = readStudioConfig(paths);
  return { paths, config, studio: new StudioClient(config.baseUrl) };
}

/** Is something listening on a loopback port? Used for the Node engine-state server. */
function portIsOpen(port: number, host = "127.0.0.1", timeoutMs = 700): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ port, host });
    const finish = (value: boolean) => {
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── sandbox mode schema ────────────────────────────────────────────────────

/**
 * Must be an explicit tuple of literals: `Type.Union(modes.map(Type.Literal))` builds the
 * right JSON Schema at runtime but widens to an array type, so `Static<>` loses the member
 * list and the tool's params infer as `undefined`.
 */
const MODE_SCHEMA = Type.Union([Type.Literal("sim"), Type.Literal("pixel_art"), Type.Literal("cover")], {
  description:
    'Which harness mode: "sim" for a minigame/simulation (default), "pixel_art" for art draw functions, "cover" for cover art.',
});

/** Fails to compile if MODE_SCHEMA and SandboxMode (lib/sandbox.ts) ever drift apart. */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _modesInSync: Exactly<Static<typeof MODE_SCHEMA>, SandboxMode> = true;
void _modesInSync;

// ── destructive-command guard ────────────────────────────────────────────────

/**
 * Generated courses are expensive and unrecoverable: `courses/` and `jobs/` are
 * gitignored, so every lesson in them cost real API tokens and exists in exactly one
 * place. `.env` holds the only copy of the API key. A plain `rm -rf` or `git clean -xdf`
 * from the agent would destroy work that no VCS can restore — so those commands are
 * gated rather than silently run.
 *
 * Tune the policy here. Returning "confirm" asks the user (and blocks outright when
 * there is no UI, e.g. `pi --print`); "allow" lets the command through untouched.
 */
function classifyCommand(command: string): { level: "allow" | "confirm"; reason: string } {
  const cmd = command.toLowerCase();

  // `git clean` that removes ignored files takes courses/ and jobs/ with it.
  if (/\bgit\s+clean\b/.test(cmd) && /-[a-z]*[xX]/.test(command)) {
    return {
      level: "confirm",
      reason: "`git clean` with -x/-X deletes ignored files, which includes every generated course in courses/.",
    };
  }

  const precious: Array<[RegExp, string]> = [
    [/\bcourses\b\/?/, "courses/ — generated lessons, gitignored and not recoverable"],
    [/\bjobs\b\/?/, "jobs/ — generation job records, gitignored"],
    [/courses\.json/, "courses.json — the course registry the Studio reads"],
    [/\.env\b/, ".env — holds the only copy of the AI API key"],
  ];

  if (/\brm\s+/.test(cmd) || /\btruncate\b/.test(cmd) || />\s*\.env/.test(cmd)) {
    for (const [pattern, what] of precious) {
      if (pattern.test(cmd)) return { level: "confirm", reason: `This touches ${what}.` };
    }
  }

  return { level: "allow", reason: "" };
}

// ── the extension ────────────────────────────────────────────────────────────

export default function edgameclaw(pi: ExtensionAPI) {
  /** Shown in the footer so the Studio's state is always visible. */
  async function refreshStatusLine(ctx: ExtensionContext) {
    try {
      const { config, studio } = resolveProject(ctx);
      const health = await studio.health();
      ctx.ui.setStatus(
        "edgameclaw",
        health.running ? `studio :${config.port} up` : `studio :${config.port} down`,
      );
    } catch {
      ctx.ui.setStatus("edgameclaw", undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await refreshStatusLine(ctx);
  });

  // ── Guard: confirm before a command destroys generated courses or the .env key ──
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: unknown }).command ?? "");
    if (!command) return;

    const verdict = classifyCommand(command);
    if (verdict.level === "allow") return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${verdict.reason} Blocked because this session has no UI to confirm with. Re-run interactively if you meant it.`,
      };
    }

    const approved = await ctx.ui.confirm(
      "EdGameClaw — destructive command",
      `${verdict.reason}\n\n${command}\n\nRun it anyway?`,
    );
    return approved ? undefined : { block: true, reason: `User declined: ${verdict.reason}` };
  });

  // ── Tool: status ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "edgameclaw_status",
    label: "EdGameClaw status",
    description:
      "Report the EdGameClaw project state: repo root, whether the Studio server and the Node engine-state server are running, the configured AI model, and whether an API key is set. Call this first when the user asks about running, generating, or previewing courses.",
    promptSnippet: "edgameclaw_status: check the EdGameClaw Studio and generator configuration.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const { paths, config, studio } = resolveProject(ctx);
      const [health, engineUp] = await Promise.all([
        studio.health(signal),
        portIsOpen(config.enginePort),
      ]);

      let courseCount: number | undefined;
      if (health.running) {
        try {
          courseCount = (await studio.listCourses(signal)).length;
        } catch {
          /* non-fatal */
        }
      }

      const lines = [
        `repo root:     ${paths.root}`,
        `studio:        ${health.running ? `running at ${config.baseUrl}` : `not running (expected ${config.baseUrl})`}`,
        `engine state:  ${engineUp ? `listening on :${config.enginePort}` : `not listening on :${config.enginePort}`}`,
        `model:         ${health.model ?? config.model ?? "(default) google/gemini-3-flash-preview"}`,
        `api base url:  ${health.baseUrl ?? config.apiBaseUrl ?? "https://openrouter.ai/api/v1"}`,
        `api key:       ${(health.hasApiKey ?? config.hasApiKey) ? `set (from ${config.source})` : "MISSING — set API_KEY in .env"}`,
        `courses:       ${courseCount ?? "unknown (studio down)"}`,
      ];
      if (!health.running && health.error) lines.push(`probe:         ${health.error}`);
      if (!health.running) lines.push("", "Start it with the edgameclaw_start_studio tool or `./start.sh`.");

      return ok(lines.join("\n"), { health, engineUp, courseCount, root: paths.root });
    },
  });

  // ── Tool: start the Studio ─────────────────────────────────────────────────
  pi.registerTool({
    name: "edgameclaw_start_studio",
    label: "Start EdGameClaw Studio",
    description:
      "Start the EdGameClaw Studio server (./start.sh, which also starts the Node engine-state server) in the background and wait until it answers. Use when the Studio is down and the user wants to generate, play, or preview a course.",
    parameters: Type.Object({
      timeout_sec: Type.Optional(
        Type.Number({
          description: "How long to wait for the server to answer. Default 45.",
          minimum: 5,
          maximum: 180,
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const { paths, config, studio } = resolveProject(ctx);
      const timeoutSec = params.timeout_sec ?? 45;

      const already = await studio.health(signal);
      if (already.running) {
        return ok(`Studio is already running at ${config.baseUrl}.`, already);
      }
      if (!existsSync(paths.startScript)) {
        return fail(`start.sh not found at ${paths.startScript}.`);
      }

      if (ctx.hasUI) {
        const approved = await ctx.ui.confirm(
          "EdGameClaw — start the Studio?",
          `Run ./start.sh in the background?\n\nIt binds ${config.host}:${config.port} and starts the Node engine server on :${config.enginePort}.`,
        );
        if (!approved) return fail("User declined to start the Studio.");
      }

      // start.sh runs uvicorn in the foreground, so it must be detached rather than
      // awaited: pi.exec would simply block until its timeout.
      const logDir = join(paths.root, ".pi", "logs");
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, "studio.log");
      appendFileSync(logPath, `\n=== pi: starting studio ${new Date().toISOString()} ===\n`);

      const child = spawn("bash", [paths.startScript], {
        cwd: paths.root,
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      const deadline = Date.now() + timeoutSec * 1000;
      while (Date.now() < deadline) {
        if (signal?.aborted) return fail("Aborted while waiting for the Studio to start.");
        await sleep(1000);
        const health = await studio.health(signal);
        if (health.running) {
          await refreshStatusLine(ctx);
          return ok(
            [
              `Studio is up at ${config.baseUrl} (pid ${child.pid}).`,
              `model: ${health.model}`,
              `api key: ${health.hasApiKey ? "set" : "MISSING — generation will fail"}`,
              `logs: ${logPath}`,
            ].join("\n"),
            { pid: child.pid, health, logPath },
          );
        }
      }

      return fail(
        `Studio did not answer at ${config.baseUrl} within ${timeoutSec}s. Check ${logPath}, and that uvicorn is installed (./start.sh needs a venv or uvicorn on PATH).`,
        { logPath },
      );
    },
  });

  // ── Tool: list courses ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "edgameclaw_courses",
    label: "List EdGameClaw courses",
    description:
      "List the generated courses this install knows about, with ids, titles, lesson counts and the Studio URL to play each one. Requires the Studio to be running.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const { studio } = resolveProject(ctx);
      const courses = await studio.listCourses(signal);
      if (courses.length === 0) {
        return ok("No courses yet. Generate one with edgameclaw_generate_course.", []);
      }
      const lines = courses.map((c) => {
        const bits = [`${c.id}  ${c.title ?? "(untitled)"}`];
        if (c.total_lessons != null) bits.push(`${c.total_lessons} lesson(s)`);
        if (c.created_at) bits.push(c.created_at);
        return `- ${bits.join("  ·  ")}\n  play: ${studio.playUrl(c.id)}`;
      });
      return ok(`${courses.length} course(s):\n${lines.join("\n")}`, courses);
    },
  });

  // ── Tool: plan a course from markdown ──────────────────────────────────────
  pi.registerTool({
    name: "edgameclaw_plan_course",
    label: "Plan an EdGameClaw course",
    description:
      "Turn learning material in EdGameClaw's markdown format (# course title, ## lesson per chunk) into the structured course plan the generator consumes, WITHOUT generating anything. Use this to review the lesson split and themes before spending API credits on generation.",
    promptGuidelines: [
      "Always plan a course with edgameclaw_plan_course and show the lesson split before calling edgameclaw_generate_course — generation spends real API credits per lesson.",
    ],
    parameters: Type.Object({
      markdown: Type.String({
        description:
          "The course material. `# Title` starts the course, `## Lesson title` starts each lesson/chunk, `- item` lines become learning objectives or lesson bullets.",
      }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const { studio } = resolveProject(ctx);
      const plan = await studio.parseMarkdown(params.markdown, signal);
      const chunks = plan.chunks ?? [];
      const lines = [
        `course: ${plan.course?.title ?? "(no title — the generator will reject this)"}`,
        plan.course?.subtitle ? `subtitle: ${plan.course.subtitle}` : "",
        `lessons: ${chunks.length}`,
        ...chunks.map((c, i) => `  ${i + 1}. [${c.id}] ${c.title}${c.theme ? `  (theme: ${c.theme})` : ""}`),
        "",
        "Pass this plan to edgameclaw_generate_course as plan_json to generate it verbatim.",
      ].filter(Boolean);
      return ok(lines.join("\n"), plan);
    },
  });

  // ── Tool: generate a course ────────────────────────────────────────────────
  pi.registerTool({
    name: "edgameclaw_generate_course",
    label: "Generate an EdGameClaw course",
    description:
      "Generate a playable game-based course. SPENDS REAL API CREDITS: one multi-step LLM pipeline per lesson (knowledge, dialog, pixel art, simulation code, sandbox-validated repair). Give either markdown or plan_json. Re-using an existing course_id resumes from that course's cached steps instead of starting over.",
    parameters: Type.Object({
      markdown: Type.Optional(
        Type.String({ description: "Course material in EdGameClaw markdown format. Ignored when plan_json is given." }),
      ),
      plan_json: Type.Optional(
        Type.String({
          description:
            'A course plan as JSON, exactly as edgameclaw_plan_course returned it: {"course": {...}, "chunks": [...]}.',
        }),
      ),
      locale: Type.Optional(
        Type.String({ description: 'Content language, e.g. "en" or "zh". Defaults to "en".' }),
      ),
      course_id: Type.Optional(
        Type.String({ description: "Reuse an existing course id to resume it; omit to create a new course." }),
      ),
      model: Type.Optional(
        Type.String({ description: "Override the generation model for this run, e.g. google/gemini-3-flash-preview." }),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: "Wait for the job to finish (default true). False returns the job id immediately." }),
      ),
      timeout_sec: Type.Optional(
        Type.Number({ description: "Max wait when wait=true. Default 1800 (generation is slow).", minimum: 30, maximum: 7200 }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx: ExtensionToolContext) {
      const { config, studio } = resolveProject(ctx);

      const health = await studio.health(signal);
      if (!health.running) {
        return fail(`The Studio is not running at ${config.baseUrl}. Start it with edgameclaw_start_studio.`);
      }
      if (!health.hasApiKey) {
        return fail("No AI API key is configured. Set API_KEY in .env, then restart the Studio.");
      }

      // Resolve the plan.
      let plan: CoursePlan;
      if (params.plan_json) {
        try {
          plan = JSON.parse(params.plan_json) as CoursePlan;
        } catch (error) {
          return fail(`plan_json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (params.markdown) {
        plan = await studio.parseMarkdown(params.markdown, signal);
      } else {
        return fail("Give either markdown or plan_json.");
      }

      const chunks = plan.chunks ?? [];
      if (chunks.length === 0) return fail("The plan has no lessons (chunks). Nothing to generate.");
      if (!plan.course?.title) return fail("The plan has no course title; the Studio requires one.");

      const model = params.model ?? health.model ?? config.model ?? "(server default)";

      if (ctx.hasUI) {
        const approved = await ctx.ui.confirm(
          "EdGameClaw — generate course?",
          [
            `"${plan.course.title}" — ${chunks.length} lesson(s)`,
            `model: ${model}`,
            params.course_id ? `resuming course ${params.course_id}` : "new course",
            "",
            "This runs the full generation pipeline per lesson and spends API credits.",
          ].join("\n"),
        );
        if (!approved) return fail("User declined generation.");
      }

      const started = await studio.startGeneration(
        {
          content: plan,
          locale: params.locale ?? "en",
          ...(params.course_id ? { course_id: params.course_id } : {}),
          ...(params.model ? { model: params.model } : {}),
        },
        signal,
      );

      const playUrl = studio.playUrl(started.course_id);

      if (params.wait === false) {
        return ok(
          [
            `Generation started. job_id=${started.job_id}  course_id=${started.course_id}`,
            `Poll it with edgameclaw_job, or open ${playUrl} once it finishes.`,
          ].join("\n"),
          { ...started, playUrl },
        );
      }

      // Poll, streaming new log lines so the user sees progress during a long run.
      const deadline = Date.now() + (params.timeout_sec ?? 1800) * 1000;
      let seen = 0;
      let job: JobState | undefined;

      while (Date.now() < deadline) {
        if (signal?.aborted) {
          return fail(
            `Aborted locally; the Studio job ${started.job_id} keeps running. Re-attach with edgameclaw_job.`,
            { ...started },
          );
        }
        try {
          job = await studio.job(started.job_id, signal);
        } catch (error) {
          // A transient poll failure should not kill a 30-minute generation.
          await sleep(3000);
          continue;
        }

        const fresh = (job.logs ?? []).slice(seen);
        if (fresh.length > 0) {
          seen = job.logs.length;
          onUpdate?.(
            result(
              [
                `generating "${plan.course.title}" (${chunks.length} lesson(s))`,
                ...fresh.map((l) => `  ${formatJobLine(l)}`),
              ].join("\n"),
              { status: job.status },
            ),
          );
        }

        if (job.status === "completed") {
          await refreshStatusLine(ctx);
          return ok(
            [
              `Generated "${plan.course.title}" — course_id=${job.course_id}`,
              `play: ${playUrl}`,
              `lessons: ${chunks.map((c) => c.id).join(", ")}`,
            ].join("\n"),
            { ...started, playUrl, status: job.status },
          );
        }
        if (job.status === "failed") {
          const tail = (job.logs ?? []).slice(-12).map((l) => `  ${formatJobLine(l)}`);
          return fail(
            [`Generation failed: ${job.error ?? "unknown error"}`, "last log lines:", ...tail].join("\n"),
            { ...started, status: job.status, error: job.error },
          );
        }

        await sleep(3000);
      }

      return fail(
        `Still running after the timeout. job_id=${started.job_id} — re-attach with edgameclaw_job.`,
        { ...started, status: job?.status },
      );
    },
  });

  // ── Tool: inspect a generation job ─────────────────────────────────────────
  pi.registerTool({
    name: "edgameclaw_job",
    label: "EdGameClaw job status",
    description:
      "Check a generation job started earlier: its status (running/completed/failed) and the tail of its log. Use to re-attach after edgameclaw_generate_course returned without waiting, or after a timeout.",
    parameters: Type.Object({
      job_id: Type.String({ description: "The job id returned by edgameclaw_generate_course." }),
      tail: Type.Optional(
        Type.Number({ description: "How many trailing log lines to return. Default 25.", minimum: 1, maximum: 500 }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const { studio } = resolveProject(ctx);
      const job = await studio.job(params.job_id, signal);
      const tail = (job.logs ?? []).slice(-(params.tail ?? 25)).map((l) => `  ${formatJobLine(l)}`);
      const lines = [
        `job ${job.id}  status=${job.status}  course=${job.course_id}`,
        job.error ? `error: ${job.error}` : "",
        job.status === "completed" ? `play: ${studio.playUrl(job.course_id)}` : "",
        tail.length ? "log tail:" : "(no log lines)",
        ...tail,
      ].filter(Boolean);
      return ok(lines.join("\n"), job);
    },
  });

  // ── Tool: validate generated game JS ──────────────────────────────────────
  pi.registerTool({
    name: "edgameclaw_validate_js",
    label: "Validate game JS in the sandbox",
    description:
      "Execute generated game JavaScript in EdGameClaw's Node sandbox (generator/sandbox_harness.js) — the same validator the generation pipeline's repair loop uses. It mocks the DOM and canvas and actually runs registerMinigame callbacks, so it catches runtime errors, not just syntax. Use after hand-editing a simulation, pixel-art or cover-art file.",
    promptSnippet:
      "edgameclaw_validate_js: run generated game JS through EdGameClaw's sandbox harness before trusting it.",
    parameters: Type.Object({
      code: Type.String({ description: "The JavaScript source to execute." }),
      mode: Type.Optional(MODE_SCHEMA),
    }),
    async execute(_id, params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const { paths } = resolveProject(ctx);
      if (!existsSync(paths.sandboxHarness)) {
        return fail(`sandbox harness not found at ${paths.sandboxHarness}`);
      }
      const outcome = await runSandbox(
        pi.exec,
        paths.sandboxHarness,
        params.code,
        params.mode ?? "sim",
        signal,
      );
      if (outcome.ok) {
        return ok(`sandbox PASS${outcome.simName ? ` — registered: ${outcome.simName}` : ""}`, outcome);
      }
      return fail(
        [`sandbox FAIL — phase ${outcome.phase}`, outcome.simName ? `minigame: ${outcome.simName}` : "", outcome.message]
          .filter(Boolean)
          .join("\n"),
        outcome,
      );
    },
  });

  // ── Tool: delete a course ─────────────────────────────────────────────────
  pi.registerTool({
    name: "edgameclaw_delete_course",
    label: "Delete an EdGameClaw course",
    description:
      "Delete a generated course and its files. IRREVERSIBLE: courses/ is gitignored, so the lessons cannot be restored from git and regenerating them costs API credits again. Only call this when the user explicitly asked for that course to be deleted.",
    parameters: Type.Object({
      course_id: Type.String({ description: "The course id to delete, as listed by edgameclaw_courses." }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const { studio } = resolveProject(ctx);

      const courses = await studio.listCourses(signal);
      const course = courses.find((c) => c.id === params.course_id);
      if (!course) {
        return fail(
          `No course ${params.course_id}. Known ids: ${courses.map((c) => c.id).join(", ") || "(none)"}`,
        );
      }

      if (ctx.hasUI) {
        const approved = await ctx.ui.confirm(
          "EdGameClaw — delete course?",
          [
            `${course.id} — "${course.title ?? "(untitled)"}"`,
            `${course.total_lessons ?? "?"} lesson(s)`,
            "",
            "courses/ is gitignored: this cannot be undone, and regenerating costs API credits.",
          ].join("\n"),
        );
        if (!approved) return fail("User declined the deletion.");
      } else {
        return fail("Refusing to delete a course without a UI to confirm in. Re-run interactively.");
      }

      await studio.deleteCourse(params.course_id, signal);
      return ok(`Deleted course ${params.course_id} ("${course.title ?? "untitled"}").`, { deleted: params.course_id });
    },
  });

  // ── /egc — one-key project status and actions ─────────────────────────────
  pi.registerCommand("egc", {
    description: "EdGameClaw: Studio status, courses, start the server",
    getArgumentCompletions: (prefix) =>
      ["status", "courses", "start"]
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ value: c, label: c })),
    handler: async (args, ctx) => {
      let resolved: Resolved;
      try {
        resolved = resolveProject(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      const { paths, config, studio } = resolved;

      const action =
        args.trim() ||
        (await ctx.ui.select("EdGameClaw", ["status", "courses", "start the studio"])) ||
        "status";

      if (action.startsWith("start")) {
        ctx.ui.notify("Starting the Studio — ask the agent for edgameclaw_start_studio to watch it.", "info");
        return;
      }

      const health = await studio.health();
      const engineUp = await portIsOpen(config.enginePort);
      const lines = [
        `EdGameClaw — ${paths.root}`,
        `studio:  ${health.running ? `up  ${config.baseUrl}` : `down (expected ${config.baseUrl})`}`,
        `engine:  ${engineUp ? `up  :${config.enginePort}` : `down :${config.enginePort}`}`,
        `model:   ${health.model ?? config.model ?? "(default)"}`,
        `api key: ${(health.hasApiKey ?? config.hasApiKey) ? "set" : "MISSING (set API_KEY in .env)"}`,
      ];

      if (action.startsWith("courses") && health.running) {
        try {
          const courses = await studio.listCourses();
          lines.push("", `courses (${courses.length}):`);
          for (const c of courses) {
            lines.push(`  ${c.id}  ${c.title ?? "(untitled)"}  → ${studio.playUrl(c.id)}`);
          }
        } catch (error) {
          lines.push("", `could not list courses: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      ctx.ui.setStatus("edgameclaw", health.running ? `studio :${config.port} up` : `studio :${config.port} down`);
      pi.sendMessage(
        { customType: "edgameclaw_status", content: lines.join("\n"), display: true },
        { triggerTurn: false },
      );
    },
  });
}
