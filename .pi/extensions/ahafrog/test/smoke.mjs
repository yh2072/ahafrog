#!/usr/bin/env node
/**
 * Smoke test for the AhaFrog pi extension.
 *
 * Loads index.ts through jiti (the loader pi itself uses), with a stub ExtensionAPI, then
 * checks every tool's schema and really exercises the sandbox harness and the bash guard.
 * Needs no pi authentication and makes no LLM calls.
 *
 *   npm install --no-save @earendil-works/pi-coding-agent   # provides jiti + typebox
 *   node .pi/extensions/ahafrog/test/smoke.mjs
 *
 * Set PI_MODULES=/path/to/dir to resolve jiti/typebox from a node_modules elsewhere.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MODULES = process.env.PI_MODULES ? resolve(process.env.PI_MODULES) : REPO;

// createRequire only needs a path to resolve *from*; the file itself need not exist.
const req = createRequire(join(MODULES, "__resolve__.js"));

let jitiDir;
let typeboxPath;
try {
  // Resolve via package.json: jiti's exports map sends a bare specifier to the CJS build,
  // and the subpath ./lib/jiti.mjs is not exported, so go through the package directory.
  jitiDir = dirname(req.resolve("jiti/package.json"));
  typeboxPath = req.resolve("typebox");
} catch {
  console.error(
    `Could not resolve jiti/typebox from ${MODULES}.\n` +
      `Run:  npm install --no-save @earendil-works/pi-coding-agent\n` +
      `or:   PI_MODULES=/path/with/node_modules node ${process.argv[1]}`,
  );
  process.exit(2);
}

const { createJiti } = await import(pathToFileURL(join(jitiDir, "lib", "jiti.mjs")).href);

// Mirror pi's own jiti aliases: project extensions live outside pi's node_modules, so pi
// maps `typebox` (and its own packages) to its copies. pi's packages are imported
// type-only by this extension, so jiti erases them and they need no alias here.
// See pi-coding-agent: dist/core/extensions/loader.js, getAliases().
const jiti = createJiti(`${MODULES}/`, {
  interopDefault: true,
  moduleCache: false,
  alias: {
    typebox: typeboxPath,
    "typebox/compile": req.resolve("typebox/compile"),
    "typebox/value": req.resolve("typebox/value"),
  },
});

/** Matches pi.exec(command, args, options) -> { stdout, stderr, code, killed, truncated }. */
function exec(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? REPO });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = options.timeout
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGTERM");
        }, options.timeout)
      : null;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ stdout, stderr, code: code ?? 0, killed, truncated: false });
    });
  });
}

const tools = new Map();
const commands = new Map();
const handlers = new Map();

const api = {
  exec,
  on: (event, handler) => {
    handlers.set(event, handler);
    return () => {};
  },
  registerTool: (tool) => tools.set(tool.name, tool),
  registerCommand: (name, options) => commands.set(name, options),
  registerShortcut: () => {},
  registerFlag: () => {},
  getFlag: () => undefined,
  sendMessage: (m) => console.log(`    [sendMessage ${m.customType}] ${String(m.content).split("\n")[0]} …`),
  sendUserMessage: () => {},
  appendEntry: () => {},
  events: { on: () => {}, emit: () => {} },
};

const failures = [];
const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
};

const factory = await jiti.import(join(REPO, ".pi/extensions/ahafrog/index.ts"), { default: true });
if (typeof factory !== "function") throw new Error(`default export is ${typeof factory}, expected a function`);
factory(api);

console.log("\n# registration");
check("extension loaded and registered tools", tools.size > 0);
check("registered the /egc command", commands.has("egc"));
check("hooked session_start and tool_call", handlers.has("session_start") && handlers.has("tool_call"));
console.log(`       tools: ${[...tools.keys()].join(", ")}`);

console.log("\n# tool schemas");
for (const [name, tool] of tools) {
  const problems = [];
  if (!tool.parameters || tool.parameters.type !== "object") problems.push("parameters is not an object schema");
  if (!tool.label) problems.push("missing label");
  if (!tool.description) problems.push("missing description");
  if (typeof tool.execute !== "function") problems.push("execute is not a function");
  check(name, problems.length === 0, problems.join("; "));
}
// Regression guard: a mapped Type.Union() builds valid JSON Schema but loses its static
// type, so assert the literal members actually reach the model.
const modeSchema = tools.get("ahafrog_validate_js")?.parameters?.properties?.mode;
check(
  "validate_js exposes all three sandbox modes",
  JSON.stringify(modeSchema ?? {}).includes("pixel_art") && JSON.stringify(modeSchema ?? {}).includes("cover"),
  JSON.stringify(modeSchema),
);

const ctx = {
  cwd: REPO,
  hasUI: false,
  mode: "print",
  ui: {
    setStatus: (k, v) => console.log(`       [status] ${k}=${v}`),
    notify: (m) => console.log(`       [notify] ${m}`),
    confirm: async () => false,
    select: async () => undefined,
  },
};

console.log("\n# session_start");
await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
check("session_start ran without throwing", true);

console.log("\n# ahafrog_status");
const status = await tools.get("ahafrog_status").execute("t1", {}, undefined, undefined, ctx);
check("status found the checkout", status.content[0].text.includes(REPO), status.content[0].text.split("\n")[0]);
check("status never prints a key value", !/sk-[A-Za-z0-9]/.test(status.content[0].text));

console.log("\n# sandbox harness");
const bad = await tools
  .get("ahafrog_validate_js")
  .execute("t2", { code: "function oops( { return 1 }" }, undefined, undefined, ctx);
check("broken syntax fails with phase SYNTAX", bad.isError === true && bad.details?.phase === "SYNTAX", bad.details?.phase);

// registerMinigame(name, fn): the harness calls fn(container, data).
const good = await tools.get("ahafrog_validate_js").execute(
  "t3",
  {
    code: `registerMinigame("demo", function (container, data) {
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 400;
  container.appendChild(canvas);
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, 640, 400);
});`,
  },
  undefined,
  undefined,
  ctx,
);
check("a valid minigame passes", good.isError === false && good.details?.simName === "demo", good.content[0].text);

console.log("\n# destructive-command guard");
const cases = [
  ["rm -rf courses/", true],
  ["rm -f courses.json", true],
  ["git clean -xdf", true],
  ["rm .env", true],
  ["ls -la courses", false],
  ["git clean -fd", false],
  ["rm -rf /tmp/scratch", false],
];
for (const [command, shouldBlock] of cases) {
  const verdict = await handlers.get("tool_call")({ toolName: "bash", input: { command } }, ctx);
  check(`${shouldBlock ? "blocks" : "allows"}: ${command}`, Boolean(verdict?.block) === shouldBlock, JSON.stringify(verdict));
}
const other = await handlers.get("tool_call")({ toolName: "read", input: { path: "x" } }, ctx);
check("ignores non-bash tools", other === undefined);

console.log(
  failures.length === 0
    ? "\nSMOKE OK — all checks passed"
    : `\nSMOKE FAILED — ${failures.length} check(s): ${failures.join(", ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
