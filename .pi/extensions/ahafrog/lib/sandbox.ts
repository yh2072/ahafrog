/**
 * Runs generated game JS through AhaFrog's own Node sandbox
 * (ahafrog/generator/sandbox_harness.js).
 *
 * This is deliberately the same validator the Python repair loop uses, invoked the same
 * way (see generator/sandbox.py: run_in_sandbox), so a verdict here means exactly what a
 * verdict in the pipeline means. The harness mocks the DOM/canvas and actually *executes*
 * registerMinigame callbacks, so it catches runtime errors a syntax check would miss.
 *
 * Protocol:
 *   node sandbox_harness.js [--mode sim|pixel_art|cover] <file.js>
 *   exit 0 + stdout "SANDBOX_OK:<sims>"                  -> pass
 *   stderr "SANDBOX_ERROR:<PHASE>:[<sim>:]<message>"     -> fail
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SandboxMode = "sim" | "pixel_art" | "cover";

export const SANDBOX_MODES: SandboxMode[] = ["sim", "pixel_art", "cover"];

export interface SandboxOutcome {
  ok: boolean;
  /** "" when ok; otherwise SYNTAX | EXEC | RUNTIME | NO_REGISTER | TIMEOUT | UNKNOWN. */
  phase: string;
  /** Which minigame failed (RUNTIME), or the registered sims on success. */
  simName: string;
  message: string;
  /** Full stderr, for when the parsed message is not enough. */
  raw: string;
}

/** The subset of pi's ExecResult this module needs. */
interface ExecLike {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/** Matches pi's `pi.exec(command, args, options)`. */
export type ExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<ExecLike>;

/** The harness kills runaway code; keep this in step with _TIMEOUT in generator/sandbox.py. */
const TIMEOUT_MS = 15_000;

export async function runSandbox(
  exec: ExecFn,
  harnessPath: string,
  code: string,
  mode: SandboxMode = "sim",
  signal?: AbortSignal,
): Promise<SandboxOutcome> {
  // Write to a private temp dir, never into the repo: generated code is untrusted output
  // and must not land next to the project's own sources.
  const dir = mkdtempSync(join(tmpdir(), "ahafrog-sandbox-"));
  const file = join(dir, "candidate.js");
  try {
    writeFileSync(file, code, "utf-8");

    const args = [harnessPath];
    if (mode !== "sim") args.push("--mode", mode);
    args.push(file);

    let result: ExecLike;
    try {
      result = await exec("node", args, { signal, timeout: TIMEOUT_MS });
    } catch (error) {
      return {
        ok: false,
        phase: "UNKNOWN",
        simName: "",
        message: `could not run the sandbox harness with node: ${
          error instanceof Error ? error.message : String(error)
        }`,
        raw: "",
      };
    }

    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();

    if (result.code === 0 && stdout.startsWith("SANDBOX_OK:")) {
      return {
        ok: true,
        phase: "",
        simName: stdout.slice("SANDBOX_OK:".length),
        message: "",
        raw: stderr,
      };
    }

    if (result.killed) {
      return {
        ok: false,
        phase: "TIMEOUT",
        simName: "",
        message: `code did not finish within ${TIMEOUT_MS / 1000}s (possible infinite loop)`,
        raw: stderr,
      };
    }

    const match = /SANDBOX_ERROR:(\w+):(?:(\w+):)?(.*)/.exec(stderr);
    if (match) {
      const [, phase, extra = "", rawMessage = ""] = match;
      // Keep a few stack lines: the pipeline's repair prompt relies on them to locate the fault.
      const stackLines = stderr
        .split("\n")
        .filter((l) => l && !l.startsWith("SANDBOX_ERROR"))
        .slice(0, 4);
      return {
        ok: false,
        phase,
        simName: phase === "RUNTIME" ? extra : "",
        message: [rawMessage, ...stackLines].filter(Boolean).join("\n"),
        raw: stderr,
      };
    }

    return {
      ok: false,
      phase: "UNKNOWN",
      simName: "",
      message: stderr.slice(0, 500) || `harness exited with code ${result.code}`,
      raw: stderr,
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir cleanup is best effort */
    }
  }
}
