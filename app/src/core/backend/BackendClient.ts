/**
 * Typed client for the Spring Boot backend (PROCURE_COPILOT_PLAN.md §3.6.7). The device speaks this
 * instead of HTTP directly, so transport can be mocked in tests. The backend is a stateless
 * reasoning provider (`/plan`, `/next-action`, `/verify`, `/intent`, `/optimize`) plus a durable
 * event store (`/sessions...`).
 */
import type {
  Allocation,
  PlatformId,
  Quote,
  RequestedItem,
} from "../domain/types";
import type { EngineAction, Observation } from "../automation/AutomationEngine";
import type { KnowledgeTransport } from "../knowledge/PlatformKnowledgeStore";
import { BACKEND_API_TOKEN } from "../config";
import { isAutomationDebug, traceAutomation } from "../debug/automationDebug";

/** Base JSON headers plus the bearer token when the backend requires one (production). */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (BACKEND_API_TOKEN) {
    headers["Authorization"] = `Bearer ${BACKEND_API_TOKEN}`;
  }
  return headers;
}

/**
 * Compact one-line summary of a request body for the debug log, so every backend call — especially the
 * LLM-backed ones (`/next-action`, `/vision/extract`, `/intent`) — shows WHAT it asked, not just the URL.
 * Never dumps full payloads (DOM/base64 are huge and may carry session text); only safe, identifying bits.
 */
function summarizeBody(path: string, body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  try {
    if (path.startsWith("/next-action")) {
      const obs = (b.observation ?? {}) as { url?: string; elements?: unknown[] };
      const hist = (b.history ?? []) as unknown[];
      return `task="${String(b.task ?? "")}" url=${obs.url ?? "?"} elements=${obs.elements?.length ?? 0} history=${hist.length}`;
    }
    if (path.startsWith("/vision/extract")) {
      const item = (b.item ?? {}) as { name?: string };
      const kb = Math.round(String(b.imageBase64 ?? "").length / 1024);
      return `item="${item.name ?? "?"}" image=${kb}KB`;
    }
    if (path.startsWith("/intent")) return `text="${String(b.text ?? "").slice(0, 80)}"`;
    if (path.startsWith("/plan")) return `items=${((b.items ?? []) as unknown[]).length}`;
    if (path.startsWith("/optimize"))
      return `items=${((b.items ?? []) as unknown[]).length} quotes=${((b.quotes ?? []) as unknown[]).length}`;
    if (path.startsWith("/verify"))
      return `expected=${((b.expected ?? []) as unknown[]).length} actual=${((b.actual ?? []) as unknown[]).length}`;
  } catch {
    /* fall through to keys */
  }
  return Object.keys(b).join(",");
}

/** Compact one-line summary of a response for the debug log (identifying fields only, never full DOM). */
function summarizeResult(path: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  try {
    if (path.startsWith("/next-action")) return `action=${String(r.type ?? "?")}${r.idx !== undefined ? ` @${r.idx}` : ""}`;
    if (path.startsWith("/vision/extract"))
      return `found=${r.found} title="${String(r.title ?? "").slice(0, 40)}" price=${r.pricePaise ?? "?"}`;
    if (path.startsWith("/intent"))
      return `items=${((r.items ?? []) as unknown[]).length} confidence=${r.confidence ?? "?"}`;
    if (path.startsWith("/verify")) return `ok=${r.ok} mismatches=${((r.mismatches ?? []) as unknown[]).length}`;
  } catch {
    /* fall through */
  }
  return "";
}

export interface PlanRequest {
  readonly requestText: string;
  readonly items: readonly RequestedItem[];
}

export interface PlanResponse {
  readonly normalizedItems: readonly RequestedItem[];
  readonly platforms: readonly PlatformId[];
}

export interface NextActionRequest {
  readonly platform: PlatformId;
  readonly task: string;
  readonly observation: Observation;
  readonly history: readonly EngineAction[];
}

export interface VerifyRequest {
  readonly platform: PlatformId;
  readonly expected: { skuId: string; qty: number; unitPricePaise: number }[];
  readonly actual: { skuId: string; qty: number; unitPricePaise: number }[];
}

export interface VerifyResponse {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

export interface IntentRequest {
  readonly text: string;
  readonly locale?: string;
}

export interface IntentResponse {
  readonly items: readonly RequestedItem[];
  readonly confidence: number;
}

export interface VisionExtractRequest {
  readonly platform: PlatformId;
  readonly item: RequestedItem;
  /** Raw base64 PNG payload (no `data:` prefix). */
  readonly imageBase64: string;
  readonly mimeType: string;
}

/** One ranked product the vision model read off a screenshot (title + price), best-first. */
export interface VisionCandidate {
  readonly skuId?: string;
  readonly title: string;
  readonly pricePaise: number;
  readonly mrpPaise?: number;
  readonly inStock?: boolean;
}

export interface VisionExtractResponse {
  readonly found: boolean;
  /** The TOP-ranked candidate, mirrored as scalars for back-compat with single-quote callers. */
  readonly skuId?: string;
  readonly title?: string;
  readonly pricePaise?: number;
  readonly mrpPaise?: number;
  readonly inStock?: boolean;
  /**
   * The full ranked top-N list (best first) for the in-app "choose a nearby SKU" picker. Older
   * backends omit it; callers fall back to the scalar fields as a single candidate.
   */
  readonly candidates?: readonly VisionCandidate[];
}

export interface OptimizeRequest {
  readonly items: readonly RequestedItem[];
  readonly quotes: readonly Quote[];
  readonly constraints: readonly {
    platform: PlatformId;
    movPaise: number;
    deliveryFeePaise: number;
    creditAvailablePaise?: number;
  }[];
}

export interface BackendClient {
  /**
   * Quick health probe (~2.5s) of the backend. Callers that have an on-device fallback (intent
   * parsing, the optimizer) check this first so a dead backend fails over in seconds instead of
   * hanging for the full request timeout — the standalone-APK path (no Mac on the network).
   */
  isReachable?(): Promise<boolean>;
  intent(req: IntentRequest): Promise<IntentResponse>;
  plan(req: PlanRequest): Promise<PlanResponse>;
  nextAction(req: NextActionRequest): Promise<EngineAction>;
  verify(req: VerifyRequest): Promise<VerifyResponse>;
  optimize(req: OptimizeRequest): Promise<Allocation>;
  /**
   * Read the best-matching product (title/price) from a webview screenshot via the backend's vision
   * model. Optional: used as a fallback when DOM serialization can't deliver a usable listing snapshot
   * (e.g. Hyperpure's large virtualized grid). Mocks/tests may omit it.
   */
  visionExtract?(req: VisionExtractRequest): Promise<VisionExtractResponse>;
  appendEvent(sessionId: string, event: unknown): Promise<void>;
  createSession(req: unknown): Promise<{ id: string }>;
  getSession(sessionId: string): Promise<unknown>;
  /**
   * Expose a generic JSON transport (resolved-base + timeout + logging) for the guided-RAG knowledge
   * and eval endpoints (`/knowledge/...`, `/eval/...`). Optional so mock/test clients can omit it; the
   * knowledge store and failure reporter degrade to defaults/no-op when it's absent.
   */
  knowledgeTransport?(): KnowledgeTransport;
}

/** Minimal fetch transport used by the HTTP implementation; mockable in tests. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Reachability probe for a base URL; returns true if the host answers. Mockable in tests. */
export type ProbeLike = (baseUrl: string) => Promise<boolean>;

/**
 * A non-OK HTTP response from the backend, carrying the numeric `status` so callers can distinguish a
 * permanent client error (4xx — e.g. a 404 for a session the backend no longer has after a restart)
 * from a transient one (5xx/network) and skip pointless retries.
 */
export class BackendHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`Backend ${path} failed with status ${status}`);
    this.name = "BackendHttpError";
  }

  /** A 4xx is permanent for an unchanged request — retrying it just spams the log. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/**
 * Default reachability probe: a `no-cors` GET to `/actuator/health`. `no-cors` means we don't need CORS
 * headers on the health endpoint — the request resolves (opaque) when the host is reachable and rejects
 * when it isn't, which is exactly the signal we want. Aborts after a short timeout so a dead candidate
 * doesn't stall resolution.
 */
const defaultProbe: ProbeLike = async (baseUrl) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      await fetch(`${baseUrl}/actuator/health`, {
        mode: "no-cors",
        signal: controller.signal,
      } as RequestInit);
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
};

export class HttpBackendClient implements BackendClient {
  /** Candidate base URLs in preference order; the reachable one is resolved lazily and cached. */
  private readonly candidates: string[];
  private resolved?: string;
  private resolving?: Promise<string>;

  constructor(
    baseUrl: string | readonly string[],
    // Default to a wrapper rather than a bare `fetch` reference: the browser's native `fetch`
    // must be invoked with `this === window`, so calling it as `this.fetchImpl(...)` on a bare
    // reference throws "Failed to execute 'fetch' on 'Window': Illegal invocation". Wrapping it
    // calls `fetch` unqualified, which keeps the correct binding. Tests inject their own mock.
    private readonly fetchImpl: FetchLike = (input, init) =>
      fetch(input, init as RequestInit) as unknown as ReturnType<FetchLike>,
    private readonly probeImpl: ProbeLike = defaultProbe,
    /**
     * Hard ceiling per request. Without it, a fetch that stalls on the device's flaky network (the
     * "Failed to fetch" / dropped-tunnel symptoms) hangs forever — which froze the checkout driver mid-run
     * so its `finally { engine.close() }` never fired and the WebView stayed on screen. 45s comfortably
     * clears the slowest legitimate call (Claude `next-action` ~9s, vision ~5s) while killing a true hang.
     */
    private readonly timeoutMs = 45_000,
  ) {
    const list = (typeof baseUrl === "string" ? [baseUrl] : [...baseUrl])
      .map((u) => u.replace(/\/+$/, ""))
      .filter((u, i, a) => Boolean(u) && a.indexOf(u) === i);
    this.candidates = list.length ? list : ["http://localhost:8080"];
    // A single candidate (the common test path) needs no probing — behave exactly as before.
    if (this.candidates.length === 1) this.resolved = this.candidates[0];
  }

  /** Pick the first reachable candidate (probing in parallel); fall back to the first if none answer. */
  private async resolveBase(): Promise<string> {
    if (this.resolved) return this.resolved;
    if (this.resolving) return this.resolving;
    this.resolving = (async () => {
      const results = await Promise.all(
        this.candidates.map(async (c) => ({ c, ok: await this.probeImpl(c).catch(() => false) })),
      );
      const hit = results.find((r) => r.ok);
      const chosen = hit ? hit.c : this.candidates[0];
      this.resolved = chosen;
      this.resolving = undefined;
      return chosen;
    })();
    return this.resolving;
  }

  /** Drop the cached choice on a transport failure so the next call re-probes (e.g. tunnel dropped). */
  private onTransportError(): void {
    if (this.candidates.length > 1) this.resolved = undefined;
  }

  /**
   * Quick (~2.5s) health probe of the resolved base. Lets callers with an on-device fallback (intent
   * parser, optimizer) bail out fast when the backend host is off the network — the standalone-APK
   * case — instead of waiting out the full 45s request timeout on a dead LAN address.
   */
  async isReachable(): Promise<boolean> {
    try {
      const base = await this.resolveBase();
      return await this.probeImpl(base);
    } catch {
      return false;
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const base = await this.resolveBase();
    const started = Date.now();
    this.logStart("POST", path, summarizeBody(path, body));
    let res;
    try {
      res = await this.withTimeout(path, (signal) =>
        this.fetchImpl(`${base}${path}`, {
          method: "POST",
          headers: authHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body),
          signal,
        }),
      );
    } catch (err) {
      this.onTransportError();
      this.logError("POST", path, started, err);
      throw err;
    }
    if (!res.ok) {
      this.logFailStatus("POST", path, started, res.status);
      throw new BackendHttpError(path, res.status);
    }
    const result = (await res.json()) as T;
    this.logEnd("POST", path, started, res.status, summarizeResult(path, result));
    return result;
  }

  private async get<T>(path: string): Promise<T> {
    const base = await this.resolveBase();
    const started = Date.now();
    this.logStart("GET", path, "");
    let res;
    try {
      res = await this.withTimeout(path, (signal) =>
        this.fetchImpl(`${base}${path}`, { headers: authHeaders(), signal }),
      );
    } catch (err) {
      this.onTransportError();
      this.logError("GET", path, started, err);
      throw err;
    }
    if (!res.ok) {
      this.logFailStatus("GET", path, started, res.status);
      throw new BackendHttpError(path, res.status);
    }
    const result = (await res.json()) as T;
    this.logEnd("GET", path, started, res.status, "");
    return result;
  }

  // --- debug tracing (no-op unless VITE_DEBUG_AUTOMATION) -----------------------------------------
  // Logs every backend call — including the Claude/vision LLM calls — with timing and a compact
  // request/response summary, under the "backend" channel of the on-screen debug overlay.

  private logStart(method: string, path: string, summary: string): void {
    if (!isAutomationDebug()) return;
    traceAutomation("think", `→ ${method} ${path}${summary ? ` · ${summary}` : ""}`, "backend");
  }

  private logEnd(method: string, path: string, started: number, status: number, summary: string): void {
    if (!isAutomationDebug()) return;
    const ms = Date.now() - started;
    traceAutomation("info", `← ${method} ${path} ${status} in ${ms}ms${summary ? ` · ${summary}` : ""}`, "backend");
  }

  private logFailStatus(method: string, path: string, started: number, status: number): void {
    if (!isAutomationDebug()) return;
    traceAutomation("error", `✗ ${method} ${path} → HTTP ${status} in ${Date.now() - started}ms`, "backend");
  }

  private logError(method: string, path: string, started: number, err: unknown): void {
    if (!isAutomationDebug()) return;
    const msg = err instanceof Error ? err.message : String(err);
    traceAutomation("error", `✗ ${method} ${path} threw in ${Date.now() - started}ms: ${msg}`, "backend");
  }

  /**
   * Run a fetch under an abort-on-timeout guard so a stalled request can never hang the caller forever
   * (which previously froze the checkout driver and left the WebView open). Translates an abort into a
   * clear, throwable error. The mock `fetchImpl` used in tests ignores `signal`, so this is a no-op there.
   */
  private async withTimeout(
    path: string,
    run: (signal: AbortSignal) => ReturnType<FetchLike>,
  ): ReturnType<FetchLike> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await run(controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`Backend ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  intent(req: IntentRequest): Promise<IntentResponse> {
    return this.post<IntentResponse>("/intent", req);
  }

  plan(req: PlanRequest): Promise<PlanResponse> {
    return this.post<PlanResponse>("/plan", req);
  }

  nextAction(req: NextActionRequest): Promise<EngineAction> {
    return this.post<EngineAction>("/next-action", req);
  }

  verify(req: VerifyRequest): Promise<VerifyResponse> {
    return this.post<VerifyResponse>("/verify", req);
  }

  optimize(req: OptimizeRequest): Promise<Allocation> {
    return this.post<Allocation>("/optimize", req);
  }

  visionExtract(req: VisionExtractRequest): Promise<VisionExtractResponse> {
    return this.post<VisionExtractResponse>("/vision/extract", req);
  }

  appendEvent(sessionId: string, event: unknown): Promise<void> {
    return this.post<void>(`/sessions/${sessionId}/events`, event);
  }

  createSession(req: unknown): Promise<{ id: string }> {
    return this.post<{ id: string }>("/sessions", req);
  }

  getSession(sessionId: string): Promise<unknown> {
    return this.get<unknown>(`/sessions/${sessionId}`);
  }

  /** A {@link KnowledgeTransport} over this client's resolved-base, timeout-guarded GET/POST. */
  knowledgeTransport(): KnowledgeTransport {
    return {
      get: (path) => this.get<unknown>(path),
      post: (path, body) => this.post<unknown>(path, body),
    };
  }
}
