/**
 * V2 glue: turn products READ FROM THE NATIVE HYPERPURE APP (via {@link HyperpureNative}) into the same
 * ranked {@link QuoteRead} the WebView agents produce, so the optimizer / comparison / picker downstream
 * are completely unchanged. The native app exposes prices as text — no vision step. Throws when nothing
 * usable was read (the caller skips that item, exactly like the WebView path).
 */
import type { Quote, RequestedItem } from "../domain/types";
import type { QuoteRead } from "../agents/PlatformAgent";
import { chooseQuote, classifyQuotes } from "../pricing/matchKind";
import { parsePackSize } from "../pricing/packPricing";
import type { NativeProduct } from "./hyperpureNative";

function canonicalId(item: RequestedItem): string {
  const maybe = (item as { canonicalItemId?: unknown }).canonicalItemId;
  return typeof maybe === "string" && maybe.length > 0 ? maybe : item.name;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function nativeQuoteRead(item: RequestedItem, products: readonly NativeProduct[]): QuoteRead {
  const cid = canonicalId(item);
  const nowIso = new Date().toISOString();
  const raw: Quote[] = products
    .filter((p) => p.title && p.pricePaise > 0)
    .map((p) => {
      const pack = parsePackSize(p.title);
      const q: Quote = {
        platform: "hyperpure",
        skuId: "hp-native-" + slug(p.title),
        canonicalItemId: cid,
        title: p.title,
        pricePaise: p.pricePaise,
        packSize: pack?.raw,
        inStock: true,
        readAt: nowIso,
      };
      return q;
    });

  // classifyQuotes stamps matchKind onto each candidate (for the picker); chooseQuote picks the default.
  const candidates = classifyQuotes(item, raw).map((c) => c.quote);
  const chosen = chooseQuote(item, raw);
  if (!chosen) {
    throw new Error("no usable product read from the Hyperpure app");
  }
  return { chosen, candidates };
}
