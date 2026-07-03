/**
 * Last staged-run summary, persisted so the user still lands on "Open Hyperpure to check out / Start
 * new order" after a WebView reload — Android routinely kills our activity while the native Hyperpure
 * app is foregrounded during staging, and without this the summary vanished into the idle chat.
 */
import type { OrderAttempt } from "../domain/types";

const LAST_RUN_KEY = "pc.lastRunSummary";
const LAST_RUN_TTL_MS = 30 * 60 * 1000;

export function saveLastRun(attempts: readonly OrderAttempt[]): void {
  try {
    globalThis.localStorage?.setItem(LAST_RUN_KEY, JSON.stringify({ attempts, at: Date.now() }));
  } catch {
    /* best-effort */
  }
}

export function clearLastRun(): void {
  try {
    globalThis.localStorage?.removeItem(LAST_RUN_KEY);
  } catch {
    /* best-effort */
  }
}

export function loadLastRun(): OrderAttempt[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(LAST_RUN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { attempts?: OrderAttempt[]; at?: number };
    if (!Array.isArray(parsed.attempts) || parsed.attempts.length === 0) return null;
    if (typeof parsed.at !== "number" || Date.now() - parsed.at > LAST_RUN_TTL_MS) return null;
    return parsed.attempts;
  } catch {
    return null;
  }
}
