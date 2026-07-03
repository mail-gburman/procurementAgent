/**
 * Conversation-layer intent client (PROCURE_COPILOT_PLAN.md §3.1, §3.2, Epic 1).
 *
 * Turns a raw chat/voice utterance into a structured list of {@link RequestedItem}s by calling the
 * backend `/intent` endpoint (which wraps Claude). Crucially it runs every utterance through
 * {@link scrubForApi} FIRST, so credentials/OTPs/phone numbers/emails are stripped on-device before
 * anything is sent to the backend or Anthropic (§9.5 "secret scrubbing before API calls").
 *
 * Low-confidence or empty extractions are handled gracefully: the caller always gets an array (never
 * a throw for "nothing recognised"), and can decide how to prompt the user to refine.
 */
import type { BackendClient } from "../backend/BackendClient";
import type { RequestedItem } from "../domain/types";
import { parseLocalIntent } from "./localIntent";
import { scrubForApi } from "./scrubForApi";

/** Below this confidence we still return the items but the UI may ask the user to confirm/refine. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/** Confidence stamped on on-device parses — above the low-confidence bar, below a solid LLM read. */
const LOCAL_PARSE_CONFIDENCE = 0.7;

export class IntentClient {
  constructor(private readonly backend: BackendClient) {}

  /**
   * Parses `text` into structured items. The text is scrubbed before leaving the device. Always
   * resolves to an array (possibly empty) so callers can render an editable list either way.
   */
  async parse(text: string, locale?: string): Promise<readonly RequestedItem[]> {
    return (await this.parseWithConfidence(text, locale)).items;
  }

  /**
   * Like {@link parse} but also exposes the model's confidence so the UI can decide whether to show
   * a "did we get this right?" confirmation affordance.
   *
   * Standalone fallback: when the backend is unreachable (quick probe) or the call fails, the order
   * is parsed ON-DEVICE by {@link parseLocalIntent} — the APK keeps working with no Mac on the WiFi.
   * The LLM stays preferred whenever it answers (better at odd phrasing, brands, other languages).
   */
  async parseWithConfidence(
    text: string,
    locale?: string,
  ): Promise<{ items: readonly RequestedItem[]; confidence: number; lowConfidence: boolean }> {
    const scrubbed = scrubForApi(text);
    if (scrubbed.length === 0) {
      return { items: [], confidence: 0, lowConfidence: true };
    }

    try {
      // Fail over in ~2.5s when the backend host is off the network (vs the 45s request timeout).
      if ((await this.backend.isReachable?.()) === false) {
        return this.parseLocally(scrubbed);
      }
      const response = await this.backend.intent({ text: scrubbed, locale });
      const items = response.items ?? [];
      if (items.length === 0) {
        // The LLM read nothing usable — a plain typed order may still parse on-device.
        const local = this.parseLocally(scrubbed);
        if (local.items.length > 0) return local;
      }
      const confidence = response.confidence ?? 0;
      return {
        items,
        confidence,
        lowConfidence: confidence < LOW_CONFIDENCE_THRESHOLD,
      };
    } catch {
      return this.parseLocally(scrubbed);
    }
  }

  private parseLocally(scrubbed: string): {
    items: readonly RequestedItem[];
    confidence: number;
    lowConfidence: boolean;
  } {
    const items = parseLocalIntent(scrubbed);
    return {
      items,
      confidence: items.length > 0 ? LOCAL_PARSE_CONFIDENCE : 0,
      lowConfidence: items.length === 0,
    };
  }
}
