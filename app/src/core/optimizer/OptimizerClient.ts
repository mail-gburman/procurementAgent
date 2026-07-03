/**
 * Client wrapper around the backend cart-split optimizer (PROCURE_COPILOT_PLAN.md §4, Epic 4/5).
 *
 * The backend runs the actual greedy/CP-SAT solve; this client's job is to assemble a correct
 * {@link OptimizeRequest} from the quotes collected on-device plus per-platform constraints, apply
 * any retailer "pin this item to a platform" edits, and turn the returned {@link Allocation} into a
 * plain-language rupee narration for the comparison card and voice read-back ({@link explain}).
 */
import type { BackendClient, OptimizeRequest } from "../backend/BackendClient";
import type {
  Allocation,
  PlatformId,
  Quote,
  RequestedItem,
} from "../domain/types";
import { formatRupees } from "../domain/types";
import { localOptimize } from "./localOptimize";

/** Per-platform constraints fed to the optimizer (MOV, delivery fee, optional credit). */
export interface PlatformConstraint {
  readonly platform: PlatformId;
  readonly movPaise: number;
  readonly deliveryFeePaise: number;
  readonly creditAvailablePaise?: number;
}

export interface OptimizeOptions {
  /**
   * Forces a canonical item onto a platform (from a swap-platform edit). Quotes for that item on
   * other platforms are dropped before the solve, so the optimizer must source it there.
   */
  readonly pins?: Readonly<Record<string, PlatformId>>;
  /** Explicit constraints; if omitted they are derived from the quotes' MOV/fee fields. */
  readonly constraints?: readonly PlatformConstraint[];
}

export class OptimizerClient {
  constructor(private readonly backend: BackendClient) {}

  /**
   * Build the request, call the backend optimizer, and return the explainable allocation.
   *
   * Standalone fallback: when the backend is unreachable (quick probe) or the solve fails, the
   * allocation is computed ON-DEVICE by {@link localOptimize} — same contract, greedy best-quote per
   * item — so the APK keeps working with no Mac on the WiFi (exact for the single-platform V2 case).
   */
  async optimize(
    items: readonly RequestedItem[],
    quotes: readonly Quote[],
    options: OptimizeOptions = {},
  ): Promise<Allocation> {
    const request = this.buildRequest(items, quotes, options);
    try {
      if ((await this.backend.isReachable?.()) === false) {
        return localOptimize(request);
      }
      return await this.backend.optimize(request);
    } catch {
      return localOptimize(request);
    }
  }

  /** Pure assembly of the {@link OptimizeRequest} (separated out so it can be asserted in tests). */
  buildRequest(
    items: readonly RequestedItem[],
    quotes: readonly Quote[],
    options: OptimizeOptions = {},
  ): OptimizeRequest {
    const pins = options.pins ?? {};
    const filteredQuotes = quotes.filter((quote) => {
      const pinned = pins[quote.canonicalItemId];
      return pinned === undefined ? true : quote.platform === pinned;
    });
    const constraints =
      options.constraints ?? deriveConstraints(filteredQuotes);
    return { items, quotes: filteredQuotes, constraints };
  }

  /** Plain-language rupee summary for narration / voice read-back. */
  explain(allocation: Allocation): string {
    return explainAllocation(allocation);
  }
}

/** Derive per-platform constraints from the quotes (max MOV / delivery fee seen per platform). */
function deriveConstraints(
  quotes: readonly Quote[],
): readonly PlatformConstraint[] {
  const byPlatform = new Map<PlatformId, { movPaise: number; deliveryFeePaise: number }>();
  for (const quote of quotes) {
    const current = byPlatform.get(quote.platform) ?? {
      movPaise: 0,
      deliveryFeePaise: 0,
    };
    byPlatform.set(quote.platform, {
      movPaise: Math.max(current.movPaise, quote.movPaise ?? 0),
      deliveryFeePaise: Math.max(
        current.deliveryFeePaise,
        quote.deliveryFeePaise ?? 0,
      ),
    });
  }
  return [...byPlatform.entries()].map(([platform, c]) => ({
    platform,
    movPaise: c.movPaise,
    deliveryFeePaise: c.deliveryFeePaise,
  }));
}

/**
 * Standalone narration builder (also used directly by the comparison UI so it needn't construct an
 * {@link OptimizerClient} just to read text). Produces a per-item reason list, per-platform totals,
 * the grand total, and the saving vs the cheapest single-platform baseline.
 */
export function explainAllocation(allocation: Allocation): string {
  const lines: string[] = [];

  for (const platform of allocation.perPlatform) {
    for (const line of platform.lines) {
      lines.push(
        `${line.itemName}: ${line.qty} on ${platform.platform} — ${line.reason} (${formatRupees(
          line.lineTotalPaise,
        )})`,
      );
    }
  }

  for (const platform of allocation.perPlatform) {
    lines.push(
      `${platform.platform} subtotal ${formatRupees(platform.subtotalPaise)} + delivery ${formatRupees(
        platform.deliveryFeePaise,
      )} = ${formatRupees(platform.totalPaise)}`,
    );
  }

  for (const missing of allocation.unfulfilled) {
    lines.push(`Could not source ${missing.itemName}: ${missing.reason}`);
  }

  lines.push(`Grand total ${formatRupees(allocation.grandTotalPaise)}`);

  // savingPaise = grandTotal − baseline; negative means we beat buying it all on one platform.
  if (allocation.savingPaise < 0) {
    lines.push(
      `You save ${formatRupees(-allocation.savingPaise)} versus buying everything on one platform (${formatRupees(
        allocation.singlePlatformBaselinePaise,
      )}).`,
    );
  } else if (allocation.savingPaise > 0) {
    lines.push(
      `This split costs ${formatRupees(allocation.savingPaise)} more than a single platform; kept for availability.`,
    );
  } else {
    lines.push(`No saving versus a single platform.`);
  }

  return lines.join("\n");
}
