/**
 * Core domain entities for Procure Copilot.
 *
 * Mirrors the data model in PROCURE_COPILOT_PLAN.md §7. These are the shared contracts that the
 * conversation layer, automation engine, adapters, optimizer and HITL/checkout layers all speak,
 * so they are intentionally platform-count-agnostic (§10).
 */

/** Platforms supported in the MVP. Designed-for extension: add more without touching the core. */
export type PlatformId = "hyperpure" | "amazon";

export const SUPPORTED_PLATFORMS: readonly PlatformId[] = ["hyperpure", "amazon"] as const;

/** A unit of measure as understood by the slot parser and optimizer. */
export type Unit = "kg" | "g" | "l" | "ml" | "piece" | "packet" | "carton" | "dozen";

/** A single line item a retailer asked for, after intent/slot extraction (Epic 1). */
export interface RequestedItem {
  /** Raw text the user said/typed for this item, e.g. "5 kilo aloo". */
  readonly raw: string;
  /** Normalized canonical name, e.g. "potato", "basmati rice". */
  readonly name: string;
  /**
   * Count of {@link packSize}-sized packs to buy. For "5 packets of 1kg basmati", this is 5 and
   * {@link unit} is "packet"; for loose "2 kg potato" it is 2 and unit is "kg".
   */
  readonly qty: number;
  readonly unit: Unit;
  /** Brand the retailer asked for, if any, e.g. "India Gate", "Tata". */
  readonly brand?: string;
  /** Product variant/grade, e.g. "basmati", "lite", "refined", "full cream". */
  readonly variant?: string;
  /** Size of each pack/unit purchased, e.g. "1 kg", "500 g", "1 L". {@link qty}/{@link unit} carry the count. */
  readonly packSize?: string;
  /** Optional free-form constraints, e.g. "refined", brand preferences. */
  readonly notes?: string;
}

/** The structured procurement request opened as a session (§3.6.2). */
export interface ProcurementRequest {
  readonly id: string;
  readonly items: readonly RequestedItem[];
  /** Locale of the originating utterance, e.g. "hi-IN", "bn-IN", "en-IN". */
  readonly locale?: string;
  readonly createdAt: string;
}

/** A canonical item that maps across platforms (§7 SKU normalization). */
export interface CanonicalItem {
  readonly id: string;
  readonly name: string;
  readonly unit: Unit;
  readonly synonyms: readonly string[];
  readonly category?: string;
}

/** A platform-specific SKU mapped to a canonical item. */
export interface PlatformSKU {
  readonly platform: PlatformId;
  readonly canonicalItemId: string;
  readonly skuId: string;
  readonly title: string;
  readonly packSize: string;
  /** 0..1 confidence of the mapping; low confidence is flagged for human review. */
  readonly mappingConfidence: number;
}

/** A live quote read off a platform for a SKU (§7). Prices are in paise to avoid float drift. */
export interface Quote {
  readonly platform: PlatformId;
  readonly skuId: string;
  readonly canonicalItemId: string;
  readonly title: string;
  /** Unit price in paise (₹1 = 100 paise). */
  readonly pricePaise: number;
  /** MRP in paise, if shown. */
  readonly mrpPaise?: number;
  /**
   * The pack size as listed by the platform, e.g. "1 Kg", "500 g", "750 ml". Parsed from the product
   * title so the comparison UI can show ₹/kg (or /L, /piece) and pick the best value across sizes.
   */
  readonly packSize?: string;
  readonly inStock: boolean;
  /**
   * How well this SKU matches the requested item: "exact" when brand AND pack size both match, else
   * "nearby" (a close substitute — different brand/size). Drives the in-app "choose a nearby SKU"
   * picker: an exact match is auto-picked silently; a nearby default invites the user to choose.
   * Computed at read time; absent on quotes from paths that don't classify (treated as unknown).
   */
  readonly matchKind?: "exact" | "nearby";
  /** Absolute product detail-page URL, so checkout can re-open the exact product to add it to cart. */
  readonly productUrl?: string;
  /** How many units are purchasable, if the platform caps it. */
  readonly stockCap?: number;
  readonly deliveryDate?: string;
  /** Minimum order value for the platform, in paise. */
  readonly movPaise?: number;
  /** Delivery fee for the platform, in paise. */
  readonly deliveryFeePaise?: number;
  readonly readAt: string;
}

/** Per-platform account state (§7). Sessions live on-device only; never sent to the backend. */
export interface PlatformAccount {
  readonly platform: PlatformId;
  readonly loggedIn: boolean;
  /** Available credit in paise, if the platform exposes a credit line. */
  readonly creditAvailablePaise?: number;
}

/** One line of an optimizer allocation: buy `qty` of an item on a platform, with a reason. */
export interface AllocationLine {
  readonly canonicalItemId: string;
  readonly itemName: string;
  readonly platform: PlatformId;
  readonly skuId: string;
  readonly qty: number;
  readonly unitPricePaise: number;
  readonly lineTotalPaise: number;
  /** Plain-language reason shown to the retailer, e.g. "cheaper on Hyperpure by ₹38". */
  readonly reason: string;
}

/** Per-platform rollup within an allocation. */
export interface PlatformAllocation {
  readonly platform: PlatformId;
  readonly lines: readonly AllocationLine[];
  readonly subtotalPaise: number;
  readonly deliveryFeePaise: number;
  readonly totalPaise: number;
  /** True if this platform's subtotal meets its MOV. */
  readonly meetsMov: boolean;
  /** True if the order can be placed on available credit. */
  readonly payableOnCredit: boolean;
}

/** A full optimizer result with an explainable rupee P&L (§4). */
export interface Allocation {
  readonly perPlatform: readonly PlatformAllocation[];
  readonly grandTotalPaise: number;
  /** Cheapest single-platform baseline total, in paise, for the "vs naive" comparison. */
  readonly singlePlatformBaselinePaise: number;
  /** grandTotal − baseline; negative means we saved money. */
  readonly savingPaise: number;
  /** Items that could not be sourced anywhere. */
  readonly unfulfilled: readonly { canonicalItemId: string; itemName: string; reason: string }[];
}

/** Status of an attempt to place an order on one platform (§7). */
export type OrderStatus =
  | "pending"
  | "cart_filled"
  | "needs_otp"
  | "needs_payment"
  | "placed"
  | "failed";

export interface OrderAttempt {
  readonly platform: PlatformId;
  readonly status: OrderStatus;
  readonly totalPaise: number;
  readonly paidOnCredit: boolean;
  readonly orderRef?: string;
  readonly idempotencyKey: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  /**
   * The platform's cart URL to hand off to the user for manual review + checkout. Set when the agent
   * only stages the cart (best-effort add-to-cart) instead of fully placing the order, so the summary
   * can offer a "Review & checkout on {platform}" button that re-opens the cart in the foreground.
   */
  readonly cartUrl?: string;
  /** Number of approved lines successfully added to this platform's cart (for the summary copy). */
  readonly stagedLineCount?: number;
  /**
   * True when the cart was filled inside the platform's NATIVE app (V2 Hyperpure accessibility flow)
   * rather than the WebView. The summary then hands off by re-opening that app (no cart URL) so the
   * user reviews + checks out in the real app.
   */
  readonly nativeApp?: boolean;
  /**
   * Per-line outcome of the cart-staging hand-off: which approved items the agent actually added vs.
   * which it couldn't add automatically (so the summary can hand the user a direct product link to add
   * those manually — the model the user asked for). Set on `cart_filled` attempts.
   */
  readonly stagedLines?: readonly StagedLine[];
}

/** One approved line's outcome after the cart-staging hand-off. */
export interface StagedLine {
  readonly canonicalItemId: string;
  readonly itemName: string;
  readonly skuId: string;
  readonly qty: number;
  readonly status: "added" | "failed";
  /** The product detail URL, surfaced so a `failed` line can be opened and added manually. */
  readonly productUrl?: string;
  /** Human-readable reason when `failed`. */
  readonly reason?: string;
}

/** Helper to format paise as a ₹ string for narration/UX. */
export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
