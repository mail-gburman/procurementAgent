/**
 * V2 — native Hyperpure source. Bridges to the Android {@code HyperpureNative} plugin (an
 * Accessibility Service that reads the installed Hyperpure app, `com.wotu.app`). Unlike the WebView
 * path this needs no vision model — the native app exposes prices as text. Only works on-device with
 * the accessibility service enabled; on web it throws "not implemented" (guard with try/catch).
 */
import { registerPlugin } from "@capacitor/core";

export interface NativeProduct {
  readonly title: string;
  /** Price in paise (₹1 = 100). */
  readonly pricePaise: number;
  /** e.g. "₹314/kg" when the app shows a per-unit rate. */
  readonly perUnit?: string;
}

export interface HyperpureNativePlugin {
  /** Whether the user has enabled the accessibility service in Settings. */
  isEnabled(): Promise<{ enabled: boolean }>;
  /** Open the system Accessibility settings so the user can toggle it on. */
  openAccessibilitySettings(): Promise<void>;
  /** Drive the native Hyperpure app to search `query` and read back product prices. */
  search(options: { query: string }): Promise<{ products: NativeProduct[]; warning?: string }>;
  /** Search `query` and add the product best matching `title` to the native cart `qty` times. */
  addToCart(options: { query: string; title: string; qty?: number }): Promise<{ added: number; title: string }>;
  /** Bring the Hyperpure cart to the foreground so the user can review + check out in the app. */
  openCart(): Promise<void>;
  /** Pull OUR app back to the foreground after native sourcing leaves Hyperpure on top. */
  bringToFront(): Promise<void>;
}

export const HyperpureNative = registerPlugin<HyperpureNativePlugin>("HyperpureNative");
