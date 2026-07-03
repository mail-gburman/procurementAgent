/**
 * On-device cart-split fallback for the backend `/optimize` solve — the standalone-APK path (no Mac
 * on the WiFi). Greedy but faithful to the {@link Allocation} contract: each item goes to its best
 * quote (same {@link chooseQuote} ranking the pricing layer uses everywhere: in-stock → exact match →
 * cheapest comparable ₹/unit), quantities are reconciled to the chosen pack via {@link packsNeeded},
 * per-platform rollups include the constraint delivery fees, and the saving is computed against the
 * cheapest single platform that could source everything. With one active platform (V2 = Hyperpure
 * only) this is exactly the optimal split, not an approximation.
 */
import type { OptimizeRequest } from "../backend/BackendClient";
import type {
  Allocation,
  AllocationLine,
  PlatformAllocation,
  PlatformId,
  Quote,
  RequestedItem,
} from "../domain/types";
import { formatRupees } from "../domain/types";
import { chooseQuote } from "../pricing/matchKind";
import { packsNeeded } from "../pricing/quantityReconcile";

/** The runtime canonical id the backend stamps on items (the TS type omits it); name as fallback. */
function canonicalId(item: RequestedItem): string {
  const maybe = (item as { canonicalItemId?: unknown }).canonicalItemId;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : item.name;
}

export function localOptimize(request: OptimizeRequest): Allocation {
  const { items, quotes, constraints } = request;
  const feeByPlatform = new Map<PlatformId, number>(
    constraints.map((c) => [c.platform, c.deliveryFeePaise]),
  );
  const movByPlatform = new Map<PlatformId, number>(
    constraints.map((c) => [c.platform, c.movPaise]),
  );
  const creditByPlatform = new Map<PlatformId, number | undefined>(
    constraints.map((c) => [c.platform, c.creditAvailablePaise]),
  );

  const quotesByItem = new Map<string, Quote[]>();
  for (const quote of quotes) {
    const list = quotesByItem.get(quote.canonicalItemId) ?? [];
    list.push(quote);
    quotesByItem.set(quote.canonicalItemId, list);
  }

  const linesByPlatform = new Map<PlatformId, AllocationLine[]>();
  const unfulfilled: { canonicalItemId: string; itemName: string; reason: string }[] = [];
  // item id → per-platform line cost, for the single-platform baseline below.
  const costOnPlatform = new Map<string, Map<PlatformId, number>>();

  for (const item of items) {
    const cid = canonicalId(item);
    const candidates = quotesByItem.get(cid) ?? [];
    const chosen = chooseQuote(item, candidates);
    if (!chosen || !chosen.inStock) {
      unfulfilled.push({
        canonicalItemId: cid,
        itemName: item.name,
        reason: "out of stock on all platforms",
      });
      continue;
    }
    const packs = packsNeeded(item, chosen);
    const lineTotal = packs * chosen.pricePaise;
    const platformsWithStock = new Set(
      candidates.filter((q) => q.inStock).map((q) => q.platform),
    );
    const reason =
      platformsWithStock.size <= 1
        ? `only ${chosen.platform} has it in stock at ${formatRupees(chosen.pricePaise)} each`
        : `cheapest at ${formatRupees(chosen.pricePaise)} on ${chosen.platform}`;
    const line: AllocationLine = {
      canonicalItemId: cid,
      itemName: item.name,
      platform: chosen.platform,
      skuId: chosen.skuId,
      qty: packs,
      unitPricePaise: chosen.pricePaise,
      lineTotalPaise: lineTotal,
      reason,
    };
    const list = linesByPlatform.get(chosen.platform) ?? [];
    list.push(line);
    linesByPlatform.set(chosen.platform, list);

    // Cheapest cost of THIS item on each platform that stocks it (for the baseline).
    const perPlatform = new Map<PlatformId, number>();
    for (const platform of platformsWithStock) {
      const best = chooseQuote(
        item,
        candidates.filter((q) => q.platform === platform),
      );
      if (best) perPlatform.set(platform, packsNeeded(item, best) * best.pricePaise);
    }
    costOnPlatform.set(cid, perPlatform);
  }

  const perPlatform: PlatformAllocation[] = [...linesByPlatform.entries()].map(
    ([platform, lines]) => {
      const subtotal = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);
      const fee = feeByPlatform.get(platform) ?? 0;
      const total = subtotal + fee;
      const credit = creditByPlatform.get(platform);
      return {
        platform,
        lines,
        subtotalPaise: subtotal,
        deliveryFeePaise: fee,
        totalPaise: total,
        meetsMov: subtotal >= (movByPlatform.get(platform) ?? 0),
        payableOnCredit: credit !== undefined && credit >= total,
      };
    },
  );

  const grandTotal = perPlatform.reduce((sum, p) => sum + p.totalPaise, 0);

  // Cheapest single platform that can source every fulfilled item; the split itself when none can.
  const sourcedIds = [...costOnPlatform.keys()];
  const singlePlatformTotals: number[] = [];
  if (sourcedIds.length > 0) {
    for (const platform of new Set(quotes.map((q) => q.platform))) {
      const costs = sourcedIds.map((id) => costOnPlatform.get(id)?.get(platform));
      if (costs.some((c) => c === undefined)) continue; // this platform can't source everything
      singlePlatformTotals.push(
        costs.reduce((sum: number, c) => sum + (c ?? 0), 0) + (feeByPlatform.get(platform) ?? 0),
      );
    }
  }
  const baseline = singlePlatformTotals.length > 0 ? Math.min(...singlePlatformTotals) : grandTotal;

  return {
    perPlatform,
    grandTotalPaise: grandTotal,
    singlePlatformBaselinePaise: baseline,
    savingPaise: grandTotal - baseline,
    unfulfilled,
  };
}
