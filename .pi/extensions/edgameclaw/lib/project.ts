/**
 * Project discovery and configuration for the EdGameClaw pi agent.
 *
 * Node builtins only — no runtime dependencies. The extension must load on a bare
 * `pi` install with no `npm install` in this repo. (`typebox` is provided by pi itself.)
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Absolute paths inside an EdGameClaw checkout. */
export interface ProjectPaths {
  /** Repo root — holds pyproject.toml, start.sh, courses.json. */
  root: string;
  /** The Python package dir: <root>/edgameclaw. */
  pkg: string;
  /** Generated courses (gitignored, not recoverable from git). */
  coursesDir: string;
  /** Generation job records (gitignored). */
  jobsDir: string;
  /** The course registry the Studio reads: <root>/courses.json. */
  registry: string;
  /** The Node sandbox the generator's repair loop uses to execute generated game JS. */
  sandboxHarness: string;
  startScript: string;
  envFile: string;
}

/** Studio/engine endpoints and the AI config, as the server itself would resolve them. */
export interface StudioConfig {
  host: string;
  port: number;
  /** e.g. http://127.0.0.1:8000 */
  baseUrl: string;
  /** Node engine-state server port (ENGINE_STATE_URL), default 3100. */
  enginePort: number;
  model?: string;
  apiBaseUrl?: string;
  /**
   * Whether an API key is configured — presence ONLY. This module never returns the key
   * value, so a leaky tool result or a transcript cannot carry the user's credential.
   */
  hasApiKey: boolean;
  /** Where hasApiKey/model came from: "env" | ".env" | "default". */
  source: string;
}

/** Files that together identify an EdGameClaw checkout rather than any Python repo. */
const ROOT_MARKERS = ["pyproject.toml", join("edgameclaw", "server.py")];

/** Env names the server accepts for the AI key (see server._unify_ai_env_aliases). */
const API_KEY_NAMES = ["API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_API_KEY_studio"];

/**
 * Walk up from `startDir` looking for an EdGameClaw checkout. pi may be launched from a
 * subdirectory, so cwd alone is not enough.
 */
export function findProjectRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (ROOT_MARKERS.every((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function projectPaths(root: string): ProjectPaths {
  const pkg = join(root, "edgameclaw");
  return {
    root,
    pkg,
    coursesDir: join(root, "courses"),
    jobsDir: join(root, "jobs"),
    registry: join(root, "courses.json"),
    sandboxHarness: join(pkg, "generator", "sandbox_harness.js"),
    startScript: join(root, "start.sh"),
    envFile: join(root, ".env"),
  };
}

/**
 * Minimal .env reader: `KEY=value`, `#` comments, optional surrounding quotes.
 * Deliberately not a full dotenv implementation — it only needs to answer
 * "which port, which model, is a key present".
 */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  let text: string;
  try {
    if (!statSync(path).isFile()) return out;
    text = readFileSync(path, "utf-8");
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Process env wins over .env, matching how start.sh exports .env then runs uvicorn. */
function pick(
  env: Record<string, string>,
  names: string[],
): { value?: string; source: string } {
  for (const n of names) {
    const fromProc = (process.env[n] ?? "").trim();
    if (fromProc) return { value: fromProc, source: "env" };
  }
  for (const n of names) {
    const fromFile = (env[n] ?? "").trim();
    if (fromFile) return { value: fromFile, source: ".env" };
  }
  return { source: "default" };
}

export function readStudioConfig(paths: ProjectPaths): StudioConfig {
  const env = parseEnvFile(paths.envFile);

  const host = pick(env, ["BIND_HOST"]).value || "127.0.0.1";
  const port = Number.parseInt(pick(env, ["PORT"]).value || "8000", 10) || 8000;

  const engineUrl = pick(env, ["ENGINE_STATE_URL"]).value || "http://127.0.0.1:3100";
  let enginePort = 3100;
  try {
    enginePort = Number.parseInt(new URL(engineUrl).port, 10) || 3100;
  } catch {
    /* keep default */
  }

  const model = pick(env, ["STUDIO_MODEL", "MODEL"]).value;
  const apiBaseUrl = pick(env, ["STUDIO_AI_BASE_URL", "API_BASE_URL"]).value;
  const key = pick(env, API_KEY_NAMES);

  return {
    host,
    port,
    // The server binds 0.0.0.0 for LAN access, but we always talk to it over loopback.
    baseUrl: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    enginePort,
    model,
    apiBaseUrl,
    hasApiKey: Boolean(key.value),
    source: key.source,
  };
}
