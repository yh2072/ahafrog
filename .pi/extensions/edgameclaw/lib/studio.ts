/**
 * HTTP client for the EdGameClaw Studio server (edgameclaw/server.py).
 *
 * Why HTTP and not a Python import: server.py already owns the job manager, the
 * courses.json registry, the output layout and the resume logic (a re-run with the same
 * course_id reuses cached steps). Driving the agent through the same API the browser
 * Studio uses means there is exactly one orchestration path to keep correct.
 */

/** GET /api/config — public config, no secrets. */
export interface StudioHealth {
  running: boolean;
  hasApiKey?: boolean;
  model?: string;
  baseUrl?: string;
  /** Why the probe failed, when running === false. */
  error?: string;
}

/** An entry of courses.json / GET /api/courses. */
export interface CourseSummary {
  id: string;
  title?: string;
  subtitle?: string;
  description?: string;
  subject?: string;
  level?: string;
  total_lessons?: number;
  created_at?: string;
  tags?: string[];
}

/** One lesson of a parsed course plan. */
export interface PlanChunk {
  id: string;
  title: string;
  subtitle?: string;
  theme?: string;
  [key: string]: unknown;
}

/** POST /api/parse-md-text — the structured content the generator consumes. */
export interface CoursePlan {
  course: {
    title?: string;
    subtitle?: string;
    description?: string;
    learning_objectives?: string[];
    [key: string]: unknown;
  };
  chunks: PlanChunk[];
}

export interface JobLogLine {
  t: number;
  msg: string;
}

/** GET /api/jobs/{id}. */
export interface JobState {
  id: string;
  course_id: string;
  status: "running" | "completed" | "failed";
  logs: JobLogLine[];
  result: { course_id?: string } | null;
  error: string | null;
  created_at?: number;
}

export interface StartedJob {
  job_id: string;
  course_id: string;
}

export class StudioError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "StudioError";
  }
}

/** Combine the agent's abort signal with a per-request timeout. */
function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class StudioClient {
  constructor(readonly baseUrl: string) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 20_000,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: withTimeout(timeoutMs, signal) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new StudioError(`cannot reach the Studio at ${url}: ${reason}`);
    }
    if (!response.ok) {
      // FastAPI puts the useful part in {"detail": ...}.
      let detail = "";
      try {
        const body = (await response.json()) as { detail?: unknown };
        detail = typeof body?.detail === "string" ? body.detail : JSON.stringify(body?.detail ?? "");
      } catch {
        detail = (await response.text().catch(() => "")).slice(0, 300);
      }
      throw new StudioError(
        `${init.method ?? "GET"} ${path} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  private postJson<T>(path: string, body: unknown, timeoutMs = 20_000, signal?: AbortSignal): Promise<T> {
    return this.request<T>(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs,
      signal,
    );
  }

  /** Never throws — "is the Studio up?" is a question, not an error. */
  async health(signal?: AbortSignal): Promise<StudioHealth> {
    try {
      const cfg = await this.request<{ has_api_key: boolean; model: string; base_url: string }>(
        "/api/config",
        {},
        5_000,
        signal,
      );
      return {
        running: true,
        hasApiKey: cfg.has_api_key,
        model: cfg.model,
        baseUrl: cfg.base_url,
      };
    } catch (error) {
      return { running: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  listCourses(signal?: AbortSignal): Promise<CourseSummary[]> {
    return this.request<CourseSummary[]>("/api/courses", {}, 10_000, signal);
  }

  manifest(courseId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/manifest`, {}, 10_000, signal);
  }

  parseMarkdown(markdown: string, signal?: AbortSignal): Promise<CoursePlan> {
    return this.postJson<CoursePlan>("/api/parse-md-text", { markdown }, 20_000, signal);
  }

  /**
   * Kick off generation. Returns as soon as the job is queued; poll `job()` for progress.
   * Reusing a course_id resumes from that course's cached steps.
   */
  startGeneration(
    body: {
      content: CoursePlan;
      locale?: string;
      course_id?: string;
      model?: string;
      api_key?: string;
      base_url?: string;
    },
    signal?: AbortSignal,
  ): Promise<StartedJob> {
    return this.postJson<StartedJob>("/api/generate", body, 30_000, signal);
  }

  job(jobId: string, signal?: AbortSignal): Promise<JobState> {
    return this.request<JobState>(`/api/jobs/${encodeURIComponent(jobId)}`, {}, 10_000, signal);
  }

  deleteCourse(courseId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request(
      `/api/courses/${encodeURIComponent(courseId)}`,
      { method: "DELETE" },
      15_000,
      signal,
    );
  }

  /** Studio URL a human can open for a generated lesson. */
  playUrl(courseId: string, chunkId?: string): string {
    const base = `${this.baseUrl}/play?course=${encodeURIComponent(courseId)}`;
    return chunkId ? `${base}&chunk=${encodeURIComponent(chunkId)}` : base;
  }
}

/**
 * Studio log lines are sometimes JSON envelopes ({"type","label","value"}) and sometimes
 * plain text. Render both as one human line.
 */
export function formatJobLine(line: JobLogLine): string {
  const msg = line.msg ?? "";
  if (!msg.startsWith("{")) return msg;
  try {
    const parsed = JSON.parse(msg) as { type?: string; label?: string; value?: unknown };
    if (parsed && typeof parsed === "object" && "value" in parsed) {
      const label = parsed.label ? `${parsed.label}: ` : "";
      return `${label}${typeof parsed.value === "string" ? parsed.value : JSON.stringify(parsed.value)}`;
    }
  } catch {
    /* not JSON after all */
  }
  return msg;
}
