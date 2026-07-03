/**
 * The end-to-end MVP flow controller (PROCURE_COPILOT_PLAN.md §6, §3.6). It is the on-device glue
 * that ties every epic together behind the single {@link Orchestrator} state machine:
 *
 *   Chat (Epic 1) → collect quotes via per-platform WebView engines (Epic 2/3) → optimize (Epic 4)
 *   → Comparison + approval (Epic 5) → per-platform checkout with Verifier + OTP/payment hand-off
 *   and audit (Epic 6) → Order summary.
 *
 * The UX binds to the orchestrator's observable store (live, no polling); automation events are folded
 * back in via `orchestrator.ingest`. Nothing irreversible runs without the explicit approval gate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IonButton, IonContent, IonPage, IonSpinner } from "@ionic/react";
import type { OrderAttempt, PlatformId, RequestedItem } from "../../core/domain/types";
import type { BackendClient } from "../../core/backend/BackendClient";
import { HttpBackendClient } from "../../core/backend/BackendClient";
import { IntentClient } from "../../core/intent/IntentClient";
import { speakText } from "../../core/intent/tts";
import { Orchestrator } from "../../core/orchestrator/Orchestrator";
import { CapgoBridge } from "../../core/automation/bridge";
import type { InAppBrowserBridge } from "../../core/automation/bridge";
import type { AutomationEngine } from "../../core/automation/AutomationEngine";
import { MockAutomationEngine } from "../../core/automation/__mocks__/MockAutomationEngine";
import { createEngine } from "../../core/adapters";
import { CheckoutDriver } from "../../core/checkout/CheckoutDriver";
import { clearLastRun, loadLastRun, saveLastRun } from "../../core/checkout/lastRun";
import { IdempotencyStore } from "../../core/checkout/idempotency";
import { agentForEngine } from "../../core/agents/AgentRegistry";
import { HyperpureNative } from "../../core/native/hyperpureNative";
import { nativeQuoteRead } from "../../core/native/nativeSource";
import { searchQueryFor } from "../../core/adapters/playbooks/common";
import { DefaultKnowledgeStore } from "../../core/knowledge/PlatformKnowledgeStore";
import { BackendFailureReporter } from "../../core/knowledge/failureReporter";
import { SiteMemory } from "../../core/knowledge/siteMemory";
import { defaultPlatformPins } from "../../core/optimizer/defaultSelection";
import { AuditLog, preferredHasher } from "../../core/audit/AuditLog";
import { InMemorySecureStore, LocalStorageSecureStore } from "../../core/secure/SecureStore";
import type { DomainEvent } from "../../core/automation/events";
import { ACTIVE_PLATFORMS, BACKEND_BASE_URLS, PLATFORM_CART_URLS, PLATFORM_URLS } from "../../core/config";
import { isAutomationDebug, traceAutomation } from "../../core/debug/automationDebug";
import { useSyncExternalStore } from "react";
import { allLoginsConfirmed } from "../../core/auth/loginStore";
import { ChatPage } from "./ChatPage";
import { LoginGate } from "./LoginGate";
import { ComparisonPage } from "./ComparisonPage";
import { OtpPaymentPage } from "./OtpPaymentPage";
import { OrderSummaryPage } from "./OrderSummaryPage";
import { BrandHeader } from "../components/BrandHeader";
import { AutomationDebugOverlay } from "../components/AutomationDebugOverlay";

interface PendingHitl {
  readonly platform: PlatformId;
  readonly kind: "otp" | "payment";
  readonly prompt: string;
  readonly amountPaise?: number;
}

/** The platforms this run sources from — driven by {@link ACTIVE_PLATFORMS} (Amazon currently disabled). */
const QUOTE_PLATFORMS: readonly PlatformId[] = ACTIVE_PLATFORMS;

/** Human label per platform for loading copy/pills. */
const PLATFORM_LABEL: Record<PlatformId, string> = {
  hyperpure: "Hyperpure",
  amazon: "Amazon.in",
};

/** "Hyperpure" / "Hyperpure and Amazon.in" — the active platforms joined for status copy. */
const ACTIVE_PLATFORMS_LABEL = QUOTE_PLATFORMS.map((p) => PLATFORM_LABEL[p]).join(" and ");
const CHECKING_PRICES_MSG = `Checking prices on ${ACTIVE_PLATFORMS_LABEL}…`;

/** Branded full-screen loading state with step text, platform pills, and skeleton placeholders. */
function Busy({
  message,
  title = "Working on your order",
  showPlatforms = false,
  showSkeletons = false,
}: {
  message: string;
  title?: string;
  showPlatforms?: boolean;
  showSkeletons?: boolean;
}): JSX.Element {
  return (
    <IonPage>
      <BrandHeader title="Procure Copilot" subtitle="Save ₹ on every order" />
      <IonContent className="ion-padding pc-content">
        <div className="pc-loading">
          <IonSpinner name="crescent" className="pc-loading__spinner" />
          <div>
            <p className="pc-loading__title">{title}</p>
            <p className="pc-loading__step">{message}</p>
          </div>
          {showPlatforms ? (
            <div className="pc-loading__platforms">
              {QUOTE_PLATFORMS.map((p) => (
                <span key={p} className={`pc-platform-pill pc-platform-pill--${p}`}>
                  <span className="pc-platform__dot" />
                  {PLATFORM_LABEL[p]}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {showSkeletons ? (
          <div aria-hidden="true">
            <div className="pc-skeleton pc-skeleton-card" />
            <div className="pc-skeleton pc-skeleton-card" />
          </div>
        ) : null}
      </IonContent>
    </IonPage>
  );
}

/** Branded terminal failure state with a retry that restarts the flow. */
function FailedState({ message }: { message: string }): JSX.Element {
  return (
    <IonPage>
      <BrandHeader title="Procure Copilot" subtitle="Something needs attention" />
      <IonContent className="ion-padding pc-content">
        <div className="pc-handoff-card">
          <span
            className="pc-handoff-card__icon"
            style={{
              background: "rgba(var(--ion-color-danger-rgb), 0.12)",
              color: "var(--ion-color-danger)",
            }}
            aria-hidden="true"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 8v5M12 16.5v.5"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
            </svg>
          </span>
          <h2 className="pc-handoff-card__platform">We hit a snag</h2>
          <p className="pc-handoff-card__prompt" role="alert">
            {message}
          </p>
        </div>
        <div className="pc-section">
          <IonButton
            className="pc-cta"
            expand="block"
            onClick={() => window.location.assign("/")}
          >
            Start over
          </IonButton>
        </div>
      </IonContent>
    </IonPage>
  );
}

/** Factory matching {@link createEngine}; injectable so demo/e2e can supply a deterministic engine. */
export type CreateEngineImpl = (
  platform: PlatformId,
  bridge: InAppBrowserBridge,
  backend: BackendClient,
) => AutomationEngine;

export interface ProcureFlowProps {
  /** Inject the backend client (e.g. a fake); defaults to the real HTTP client. */
  readonly backend?: BackendClient;
  /** Inject the orchestrator; defaults to one wrapping `backend`. */
  readonly orchestrator?: Orchestrator;
  /** Inject the automation-engine factory; defaults to the real `createEngine` (or the demo mock). */
  readonly createEngineImpl?: CreateEngineImpl;
  /** Inject the WebView bridge factory; defaults to the real Capgo bridge. */
  readonly bridgeImpl?: () => InAppBrowserBridge;
  /**
   * Force demo mode on/off. When omitted it is read from an explicit, production-impossible signal
   * (`?demo=1` on the URL, or `VITE_DEMO=1`); production `/flow` never triggers it.
   */
  readonly demo?: boolean;
}

/**
 * Detect the opt-in demo seam. It can ONLY be turned on by an explicit signal that never appears in a
 * production build/visit: the `?demo=1` query param or the `VITE_DEMO=1` env flag. Without it the
 * controller behaves byte-for-byte as before (real Capgo WebView engines).
 */
function detectDemoMode(): boolean {
  try {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("demo") === "1") {
        return true;
      }
    }
  } catch {
    // No DOM (SSR/tests) — fall through to the env flag.
  }
  const env =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return env.VITE_DEMO === "1";
}

/**
 * The flow controller. Dependencies are injectable for testing; on a device it constructs an
 * HTTP-backed client, an orchestrator, an on-device audit log, and a Capgo WebView bridge.
 *
 * In demo mode (see {@link detectDemoMode}) the automation transport is swapped for a deterministic
 * {@link MockAutomationEngine} so the full journey runs in a plain browser. Nothing else changes —
 * the orchestrator state machine, the checkout driver, the Verifier safety gate, and the live
 * backend calls all run exactly as in production.
 */
export function ProcureFlow(props: ProcureFlowProps = {}): JSX.Element {
  const isDemo = useMemo(() => props.demo ?? detectDemoMode(), [props.demo]);

  const backend = useMemo(
    () => props.backend ?? new HttpBackendClient(BACKEND_BASE_URLS),
    [props.backend],
  );
  const orchestrator = useMemo(
    () => props.orchestrator ?? new Orchestrator(backend),
    [props.orchestrator, backend],
  );
  const intentClient = useMemo(() => new IntentClient(backend), [backend]);
  // Durable, tamper-evident audit trail: a persistent store (survives cold-start) + a cryptographic
  // SHA-256 hash chain in production. Demo uses an ephemeral in-memory store so preview runs don't
  // accumulate. Integrity is checked on mount and any breakage surfaces in the debug trace.
  const audit = useMemo(
    () =>
      new AuditLog(
        isDemo ? new InMemorySecureStore() : new LocalStorageSecureStore("pc.secure.audit."),
        "audit:log",
        preferredHasher(),
      ),
    [isDemo],
  );
  useEffect(() => {
    if (isDemo) return;
    void audit.verifyIntegrity().then((ok) => {
      if (!ok) traceAutomation("error", "audit log integrity check FAILED — chain broken", "backend");
    });
  }, [audit, isDemo]);
  // Durable idempotency guard so a placement survives a cold-start (reserve-before-place prevents a
  // double order after a mid-checkout crash). In-memory in demo.
  const idempotency = useMemo(
    () =>
      new IdempotencyStore(
        isDemo ? new InMemorySecureStore() : new LocalStorageSecureStore("pc.secure.idem."),
      ),
    [isDemo],
  );
  // Guided-RAG knowledge: curated per-platform policies/hints that steer each agent. Backed by the
  // backend `/knowledge` endpoint via the client's shared transport (resolved-base + timeout), and always
  // falls back to safe built-in defaults when the backend is unreachable.
  const knowledgeStore = useMemo(
    () => new DefaultKnowledgeStore({ transport: backend.knowledgeTransport?.() }),
    [backend],
  );
  // Ships rate-limited failure reports (≤1/hr per platform|flow|signature) to the backend eval flow, so
  // recurring failures can drive knowledge-doc patches. Demo mode has no real failures to learn from.
  const failureReporter = useMemo(() => {
    if (isDemo) return undefined;
    const transport = backend.knowledgeTransport?.();
    return transport ? new BackendFailureReporter(transport) : undefined;
  }, [backend, isDemo]);

  const bridgeRef = useRef<InAppBrowserBridge | null>(null);
  const enginesRef = useRef<Map<PlatformId, AutomationEngine>>(new Map());
  // One learned, persistent site-memory per platform (localStorage-backed), shared across the pricing
  // and checkout loops so a URL/locator learned while quoting is reused when adding to cart. Demo mode
  // gets none (no real sites to learn from).
  const memoriesRef = useRef<Map<PlatformId, SiteMemory>>(new Map());
  const humanResolverRef = useRef<(() => void) | null>(null);
  const checkoutStartedRef = useRef(false);

  const [pendingHitl, setPendingHitl] = useState<PendingHitl | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [attempts, setAttempts] = useState<OrderAttempt[]>([]);
  // Summary restored after a WebView reload (see LAST_RUN_KEY) — shown while the session is idle.
  const [restoredAttempts, setRestoredAttempts] = useState<OrderAttempt[] | null>(() => loadLastRun());
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  // First-run sign-in gate: the user must manually log in to each active platform once (persisted in
  // localStorage). Demo mode skips it (no real sites). Until ready, the chat is gated behind LoginGate.
  const [loginReady, setLoginReady] = useState<boolean>(
    () => isDemo || allLoginsConfirmed(QUOTE_PLATFORMS),
  );

  const state = useSyncExternalStore(orchestrator.subscribe, orchestrator.getState);

  // V2: the native Hyperpure app is already signed in, so when its accessibility reader is enabled and
  // Hyperpure is the only active platform, skip the WebView sign-in gate entirely (no login web view).
  useEffect(() => {
    if (isDemo || loginReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const { enabled } = await HyperpureNative.isEnabled();
        if (!cancelled && enabled && QUOTE_PLATFORMS.every((p) => p === "hyperpure")) {
          setLoginReady(true);
        }
      } catch {
        /* plugin unavailable (web) — keep the gate */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDemo, loginReady]);

  const bridge = useCallback((): InAppBrowserBridge => {
    if (bridgeRef.current === null) {
      bridgeRef.current = props.bridgeImpl ? props.bridgeImpl() : new CapgoBridge();
    }
    return bridgeRef.current;
  }, [props.bridgeImpl]);

  // The engine factory: an explicit injected factory wins; otherwise demo mode uses the deterministic
  // in-memory mock (no WebView/bridge), and production uses the real Capgo-backed `createEngine`.
  const makeEngine = useCallback(
    (platform: PlatformId): AutomationEngine => {
      if (props.createEngineImpl) {
        return props.createEngineImpl(platform, bridge(), backend);
      }
      if (isDemo) {
        return new MockAutomationEngine({
          platform,
          getAllocation: () => orchestrator.getState().allocation,
        });
      }
      // Give SPA listings a few seconds to lazy-load priced tiles before readProduct extracts, and
      // fall back to a screenshot + vision read when DOM extraction can't resolve the product: on
      // Hyperpure the grid DOM is too large to serialize reliably; on Amazon the title often uses a
      // synonym (search "chicken legs" → product titled "Drumsticks") that token matching misses, so
      // once Claude has navigated to the chosen product, vision reads its price from the page.
      return createEngine(platform, bridge(), backend, {
        listingSettleMs: 8000,
        visionFallback: true,
        // Amazon streams the cart body after its page "settles", so clearCart/getCart must wait for the
        // real cart to render instead of reading the bare shell (which falsely reported an empty cart).
        cartLoadMs: 8000,
      });
    },
    [props.createEngineImpl, isDemo, backend, bridge, orchestrator],
  );

  const engineFor = useCallback(
    (platform: PlatformId): AutomationEngine => {
      const existing = enginesRef.current.get(platform);
      if (existing) {
        return existing;
      }
      const engine = makeEngine(platform);
      enginesRef.current.set(platform, engine);
      return engine;
    },
    [makeEngine],
  );

  /** The shared per-platform site memory (undefined in demo mode — nothing real to learn from). */
  const memoryFor = useCallback(
    (platform: PlatformId): SiteMemory | undefined => {
      if (isDemo) return undefined;
      const existing = memoriesRef.current.get(platform);
      if (existing) return existing;
      const memory = new SiteMemory(platform);
      memoriesRef.current.set(platform, memory);
      return memory;
    },
    [isDemo],
  );

  // ---- Phase 1: parse confirmed → collect quotes on each platform → optimize ----
  const startProcurement = useCallback(
    async (items: readonly RequestedItem[]) => {
      // A fresh order replaces the previous run's restored summary.
      clearLastRun();
      setRestoredAttempts(null);
      const request = {
        id: crypto.randomUUID(),
        items,
        createdAt: new Date().toISOString(),
      };
      setBusyMessage("Planning your order…");
      await orchestrator.start(request);

      setBusyMessage(CHECKING_PRICES_MSG);
      // In automation-debug mode show the live WebView so you can watch the scrape; otherwise hidden.
      const showWebView = isAutomationDebug();
      const br = bridge();

      // V2: if the native Hyperpure-reader accessibility service is enabled, source Hyperpure from the
      // installed APP (com.wotu.app) — not the WebView. Prices come back as text (no vision). Detected
      // once; falls back to the WebView when off / on web / in demo.
      let nativeHyperpure = false;
      if (!isDemo) {
        try {
          nativeHyperpure = (await HyperpureNative.isEnabled()).enabled;
        } catch {
          nativeHyperpure = false;
        }
      }

      let quotesCollected = 0;
      for (const platform of QUOTE_PLATFORMS) {
        try {
          if (platform === "hyperpure" && nativeHyperpure) {
            traceAutomation("info", "sourcing from the NATIVE Hyperpure app (accessibility) — no web view", platform);
            for (const item of orchestrator.getState().items) {
              try {
                const query = searchQueryFor(item) || item.name;
                const res = await HyperpureNative.search({ query });
                const { chosen, candidates } = nativeQuoteRead(item, res.products ?? []);
                orchestrator.recordQuote(chosen);
                orchestrator.recordCandidates(chosen.canonicalItemId, candidates);
                quotesCollected += 1;
                traceAutomation(
                  "info",
                  `✓ (native app) "${item.name}" → ₹${(chosen.pricePaise / 100).toFixed(2)} (${candidates.length} candidate(s))`,
                  platform,
                );
              } catch (err) {
                traceAutomation(
                  "error",
                  `✗ (native app) "${item.name}": ${err instanceof Error ? err.message : String(err)}`,
                  platform,
                );
              }
            }
            continue;
          }

          const engine = engineFor(platform);
          traceAutomation("think", `opening ${PLATFORM_URLS[platform]}`, platform);
          await engine.open(PLATFORM_URLS[platform], { hidden: !showWebView });

          // Sign-in only when the page actually shows a login wall — so we don't re-prompt when the
          // device is already logged in, and don't open the WebView twice unnecessarily. Many
          // platforms (esp. Hyperpure) gate catalog/pricing behind login + a serviceable area.
          if (showWebView && br.openLoginSession && engine.detectLoginWall) {
            let needLogin = false;
            try {
              needLogin = (await engine.detectLoginWall?.()) ?? false;
            } catch {
              needLogin = false;
            }
            if (needLogin) {
              setBusyMessage(
                `Sign in to ${platform}: log in + set your delivery location, then close the window…`,
              );
              traceAutomation(
                "think",
                "not logged in → opening sign-in window; log in + set location, then close it to continue",
                platform,
              );
              try {
                await engine.close();
              } catch {
                /* ignore */
              }
              try {
                await br.openLoginSession?.(platform, PLATFORM_URLS[platform]);
              } catch (err) {
                traceAutomation(
                  "warn",
                  `sign-in hand-off skipped: ${err instanceof Error ? err.message : String(err)}`,
                  platform,
                );
              }
              traceAutomation("think", "re-opening after sign-in", platform);
              await engine.open(PLATFORM_URLS[platform], { hidden: !showWebView });
            } else {
              traceAutomation("info", "session already authenticated → skipping sign-in", platform);
            }
          }

          setBusyMessage(CHECKING_PRICES_MSG);
          // Route reads through the per-platform agent: Amazon opens the product detail page for the TRUE
          // buybox price (not the noisy listing tile); Hyperpure uses its working listing+vision read. The
          // demo mock engine resolves to a LegacyAgent so the demo journey is unchanged. The agent is
          // guided by the platform's knowledge doc (policies/hints).
          const knowledge = await knowledgeStore.getKnowledge(platform);
          const agent = agentForEngine(platform, engine, {
            hidden: !showWebView,
            knowledge,
            memory: memoryFor(platform),
          });
          for (const item of orchestrator.getState().items) {
            try {
              await agent.search(item);
              const { chosen, candidates } = await agent.readQuote(item);
              orchestrator.recordQuote(chosen);
              // Stash the ranked alternatives so the Comparison page can offer an in-app "choose a
              // nearby SKU" picker when the default is only an approximate (nearby) match.
              orchestrator.recordCandidates(chosen.canonicalItemId, candidates);
              quotesCollected += 1;
              traceAutomation(
                "info",
                `✓ "${item.name}" → ₹${(chosen.pricePaise / 100).toFixed(2)} inStock=${chosen.inStock}` +
                  ` (${candidates.length} candidate(s))`,
                platform,
              );
            } catch (err) {
              // Skip items this platform can't quote; the optimizer handles partial availability.
              traceAutomation(
                "error",
                `✗ "${item.name}": ${err instanceof Error ? err.message : String(err)}`,
                platform,
              );
            }
          }
          // Hide the visible WebView between platforms so the trace/comparison stays readable.
          if (showWebView) {
            try {
              await engine.hide();
            } catch {
              /* best-effort */
            }
          }
        } catch (err) {
          // Platform unreachable / not logged in — proceed with whatever quotes we have.
          traceAutomation(
            "error",
            `unreachable (open/login failed): ${err instanceof Error ? err.message : String(err)}`,
            platform,
          );
        }
      }
      // V2: native sourcing drives the Hyperpure app to the foreground; pull our app back so the user
      // lands on the comparison instead of being stranded in Hyperpure after the prices are read.
      if (nativeHyperpure) {
        try {
          await HyperpureNative.bringToFront();
        } catch {
          /* best-effort */
        }
      }
      traceAutomation(
        quotesCollected > 0 ? "info" : "warn",
        `collected ${quotesCollected} quote(s) across ${QUOTE_PLATFORMS.length} platform(s)`,
      );

      setBusyMessage("Finding the cheapest split…");
      // Default each item to the best VALUE (lowest ₹/kg·L·piece) across platforms, so a 1 Kg pack
      // isn't beaten by a "cheaper-looking" 500 g pack. The user can still switch per item.
      orchestrator.seedDefaultPins(defaultPlatformPins(orchestrator.getState().quotes));
      await orchestrator.optimize();
      traceAutomation("think", "optimization complete");
      setBusyMessage(null);
    },
    [engineFor, orchestrator, knowledgeStore, memoryFor, isDemo],
  );

  // ---- Phase 2 (after explicit approval): drive checkout per platform ----
  const runCheckout = useCallback(async () => {
    const allocation = orchestrator.getState().allocation;
    if (!allocation) {
      return;
    }
    const onEvent = (event: DomainEvent): void => {
      orchestrator.ingest(event);
      if (event.type === "NeedsOtp") {
        setRevealed(false);
        setPendingHitl({ platform: event.platform, kind: "otp", prompt: event.prompt });
      } else if (event.type === "NeedsPayment") {
        setRevealed(false);
        setPendingHitl({
          platform: event.platform,
          kind: "payment",
          prompt: event.prompt,
          amountPaise: event.amountPaise,
        });
      }
    };
    const awaitHuman = (): Promise<void> =>
      new Promise<void>((resolve) => {
        humanResolverRef.current = resolve;
      });

    // Add-to-cart requires a RENDERED webview: the ADD click resolves via document.elementFromPoint at
    // the button's coordinates, and a HIDDEN (zero-size / unrendered) webview drops that click so the add
    // never confirms — diagnosed live on-device (hidden fails, visible succeeds). So the staging phase
    // always runs the webview VISIBLE, independent of the debug flag; the user briefly sees the platform's
    // page as their items are added to the cart (an honest "adding to your cart" moment), then it closes.
    const showWebView = true;
    const collected: OrderAttempt[] = [];

    // V2: when the Hyperpure-reader accessibility service is on, ADD TO CART inside the native app
    // (com.wotu.app) too — not just the pricing read. The whole loop (search → add → checkout) then
    // happens in the real app; the user reviews + pays in Hyperpure. Falls back to the WebView when off.
    let nativeHyperpure = false;
    try {
      nativeHyperpure = (await HyperpureNative.isEnabled()).enabled;
    } catch {
      nativeHyperpure = false;
    }

    for (const platformAllocation of allocation.perPlatform) {
      if (platformAllocation.lines.length === 0) {
        continue;
      }
      if (platformAllocation.platform === "hyperpure" && nativeHyperpure) {
        const items = orchestrator.getState().items;
        const titleByItem = new Map<string, string>();
        for (const q of orchestrator.getState().quotes) {
          if (q.platform === "hyperpure") titleByItem.set(q.canonicalItemId, q.title);
        }
        let added = 0;
        traceAutomation("info", "adding to cart in the NATIVE Hyperpure app (accessibility) — no web view", "hyperpure");
        for (const line of platformAllocation.lines) {
          try {
            const item = items.find(
              (i) => ((i as { canonicalItemId?: string }).canonicalItemId ?? i.name) === line.canonicalItemId,
            );
            const query = (item ? searchQueryFor(item) : "") || line.itemName;
            const title = titleByItem.get(line.canonicalItemId) ?? line.itemName;
            const res = await HyperpureNative.addToCart({ query, title, qty: line.qty });
            added += res.added ?? 0;
            traceAutomation("info", `✓ added "${title}" ×${res.added ?? 0} to the Hyperpure cart`, "hyperpure");
          } catch (err) {
            traceAutomation(
              "error",
              `✗ could not add "${line.itemName}": ${err instanceof Error ? err.message : String(err)}`,
              "hyperpure",
            );
          }
        }
        // Items are staged — come BACK to our summary screen (the user chooses there: "Open Hyperpure
        // to check out" jumps straight to the Hyperpure cart, or they start a new order).
        try {
          await HyperpureNative.bringToFront();
          traceAutomation("info", "items staged in the Hyperpure cart — returning to the summary", "hyperpure");
        } catch (err) {
          traceAutomation(
            "warn",
            `couldn't return to the app automatically: ${err instanceof Error ? err.message : String(err)}`,
            "hyperpure",
          );
        }
        const nowIso = new Date().toISOString();
        collected.push({
          platform: "hyperpure",
          status: "cart_filled",
          totalPaise: platformAllocation.totalPaise,
          paidOnCredit: false,
          idempotencyKey: `native-hp-${nowIso}`,
          startedAt: nowIso,
          updatedAt: nowIso,
          stagedLineCount: added,
          nativeApp: true,
        });
        continue;
      }
      // Detail-page URLs captured while pricing this platform, so checkout re-opens the exact product
      // and adds it directly (no re-search), keyed by the canonicalItemId the optimizer's lines use.
      const productUrls = new Map<string, string>();
      for (const q of orchestrator.getState().quotes) {
        if (q.platform === platformAllocation.platform && q.productUrl) {
          productUrls.set(q.canonicalItemId, q.productUrl);
        }
      }
      const engine = engineFor(platformAllocation.platform);
      const knowledge = await knowledgeStore.getKnowledge(platformAllocation.platform);
      const agent = agentForEngine(platformAllocation.platform, engine, {
        hidden: !showWebView,
        knowledge,
        memory: memoryFor(platformAllocation.platform),
      });
      const driver = new CheckoutDriver({
        engine,
        agent,
        backend,
        audit,
        idempotency,
        onEvent,
        awaitHuman,
        failureReporter,
        items: orchestrator.getState().items,
        productUrls,
        showWebView,
        cartUrl: PLATFORM_CART_URLS[platformAllocation.platform],
      });
      const platform = platformAllocation.platform;
      try {
        traceAutomation("think", "▶ staging cart (best-effort add-to-cart, hand off for checkout)", platform);
        // Cart hand-off mode: drop the approved lines into the cart, then let the user review + pay.
        // No cart-clearing (we never delete the user's existing items), no OTP/payment automation.
        const attempt = await driver.stageCart(platformAllocation);
        collected.push(attempt);
        traceAutomation(
          "info",
          `cart staged → ${attempt.stagedLineCount ?? 0}/${platformAllocation.lines.length} line(s) added`,
          platform,
        );
      } catch (err) {
        traceAutomation(
          "error",
          `staging threw: ${err instanceof Error ? err.message : String(err)}`,
          platform,
        );
      } finally {
        // Dismiss the staging WebView so we "come out" of the browser; the user re-opens the cart on
        // demand from the summary (which reloads it logged-in for manual review + checkout).
        traceAutomation("think", "closing webview", platform);
        try {
          await engine.close();
          traceAutomation("info", "webview closed", platform);
        } catch (err) {
          traceAutomation(
            "warn",
            `webview close failed: ${err instanceof Error ? err.message : String(err)}`,
            platform,
          );
        }
      }
    }
    setAttempts(collected);
    saveLastRun(collected); // survive a WebView reload while Hyperpure is foregrounded
    setPendingHitl(null);
    // Staging emits no OrderPlaced, so explicitly move the session to its terminal success state and
    // render the summary (with the per-platform "Review & checkout" hand-off).
    orchestrator.finishCheckout();
  }, [audit, backend, engineFor, orchestrator, knowledgeStore, memoryFor]);

  // Hand-off: bring the platform's cart to the foreground (logged-in session) so the user can review
  // quantities/variants and complete checkout manually. Re-opens the cart URL fresh and shows it.
  const openCartForReview = useCallback(
    async (platform: PlatformId): Promise<void> => {
      // V2: if this platform's cart was filled in its NATIVE app, hand off by re-opening THAT app
      // (foreground Hyperpure on its cart) instead of the WebView cart URL.
      if (platform === "hyperpure") {
        try {
          if ((await HyperpureNative.isEnabled()).enabled) {
            await HyperpureNative.openCart();
            return;
          }
        } catch {
          /* fall through to the WebView cart */
        }
      }
      const url = PLATFORM_CART_URLS[platform];
      try {
        const engine = engineFor(platform);
        traceAutomation("think", `opening cart for manual checkout: ${url}`, platform);
        await engine.open(url, { hidden: false });
        await engine.show();
      } catch (err) {
        traceAutomation(
          "warn",
          `could not open cart: ${err instanceof Error ? err.message : String(err)}`,
          platform,
        );
      }
    },
    [engineFor],
  );

  // Hand-off for a line the agent could NOT add automatically: open its product detail page in the
  // foreground so the user can add it themselves (the model the user asked for on Amazon failures).
  const openProductForAdd = useCallback(
    async (platform: PlatformId, productUrl: string): Promise<void> => {
      try {
        const engine = engineFor(platform);
        traceAutomation("think", `opening product to add manually: ${productUrl}`, platform);
        await engine.open(productUrl, { hidden: false });
        await engine.show();
      } catch (err) {
        traceAutomation(
          "warn",
          `could not open product: ${err instanceof Error ? err.message : String(err)}`,
          platform,
        );
      }
    },
    [engineFor],
  );

  // First-run sign-in: foreground the platform's WebView so the user can log in + set their delivery
  // location. Resolves when they close it; the user then explicitly confirms in the LoginGate.
  const openLoginFor = useCallback(
    async (platform: PlatformId): Promise<void> => {
      const url = PLATFORM_URLS[platform];
      const br = bridge();
      try {
        if (br.openLoginSession) {
          await br.openLoginSession(platform, url);
        } else {
          // Web/demo fallback: open the engine visibly; the user confirms manually afterwards.
          const engine = engineFor(platform);
          await engine.open(url, { hidden: false });
          await engine.show?.();
        }
      } catch (err) {
        traceAutomation(
          "warn",
          `login open failed: ${err instanceof Error ? err.message : String(err)}`,
          platform,
        );
      }
    },
    [bridge, engineFor],
  );

  useEffect(() => {
    if (state.status === "approved" && !checkoutStartedRef.current) {
      checkoutStartedRef.current = true;
      void runCheckout();
    }
  }, [state.status, runCheckout]);

  // ---- Render by session status (and the HITL hand-off, which preempts everything) ----
  const content = renderContent();
  return (
    <>
      {content}
      {isAutomationDebug() ? <AutomationDebugOverlay /> : null}
    </>
  );

  function renderContent(): JSX.Element {
  if (pendingHitl) {
    return (
      <OtpPaymentPage
        platform={pendingHitl.platform}
        kind={pendingHitl.kind}
        prompt={pendingHitl.prompt}
        amountPaise={pendingHitl.amountPaise}
        revealed={revealed}
        onReveal={() => {
          void enginesRef.current.get(pendingHitl.platform)?.show();
          setRevealed(true);
        }}
        onDone={() => {
          const resolve = humanResolverRef.current;
          humanResolverRef.current = null;
          setPendingHitl(null);
          setRevealed(false);
          resolve?.();
        }}
      />
    );
  }

  if (busyMessage) {
    return (
      <Busy
        message={busyMessage}
        title="Finding your best price"
        showPlatforms
        showSkeletons
      />
    );
  }

  // Gate everything behind the one-time manual sign-in (only relevant on the pre-procurement screens).
  if (!loginReady && (state.status === "idle" || state.status === "cancelled")) {
    return (
      <LoginGate
        platforms={QUOTE_PLATFORMS}
        onOpenLogin={openLoginFor}
        onReady={() => setLoginReady(true)}
      />
    );
  }

  switch (state.status) {
    case "awaiting_approval":
    case "modifying":
      return <ComparisonPage orchestrator={orchestrator} speak={speakText} />;
    case "planning":
    case "quoting":
    case "optimizing":
      return (
        <Busy
          message={CHECKING_PRICES_MSG}
          title="Finding your best price"
          showPlatforms
          showSkeletons
        />
      );
    case "approved":
    case "executing":
    case "placing":
      return (
        <Busy message="Filling your carts — we'll pause for OTP/payment." title="Placing your orders" />
      );
    case "done":
      return (
        <OrderSummaryPage
          attempts={attempts}
          onOpenCart={(platform) => void openCartForReview(platform)}
          onOpenProduct={(platform, url) => void openProductForAdd(platform, url)}
        />
      );
    case "failed":
      return <FailedState message={state.error ?? "Something went wrong. Please try again."} />;
    case "cancelled":
      return (
        <ChatPage
          intentClient={intentClient}
          onConfirm={(items) => void startProcurement(items)}
        />
      );
    case "idle":
    default:
      // A WebView reload during staging loses the in-memory session; if the last run's summary was
      // persisted (fresh), land the user back on it — "Open Hyperpure to check out" / new order.
      if (restoredAttempts && restoredAttempts.length > 0) {
        return (
          <OrderSummaryPage
            attempts={restoredAttempts}
            onOpenCart={(platform) => void openCartForReview(platform)}
            onOpenProduct={(platform, url) => void openProductForAdd(platform, url)}
          />
        );
      }
      return (
        <ChatPage
          intentClient={intentClient}
          onConfirm={(items) => void startProcurement(items)}
        />
      );
  }
  }
}
