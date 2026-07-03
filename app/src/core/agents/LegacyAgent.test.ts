import { describe, expect, it, vi } from "vitest";
import type { Quote, RequestedItem } from "../domain/types";
import type { AutomationEngine } from "../automation/AutomationEngine";
import { agentForEngine, agentFor } from "./AgentRegistry";
import { AmazonAgent } from "./amazon/AmazonAgent";
import { HyperpureAgent } from "./hyperpure/HyperpureAgent";
import { LegacyAgent } from "./LegacyAgent";
import type { BrowserSession } from "./PlatformAgent";

const item: RequestedItem = { raw: "1 kg paneer", name: "paneer", qty: 1, unit: "kg" };

const quote: Quote = {
  platform: "amazon",
  skuId: "B0PANEER1",
  canonicalItemId: "paneer",
  title: "Amul Malai Paneer 1 kg",
  pricePaise: 39900,
  inStock: true,
  readAt: "2026-01-01T00:00:00.000Z",
};

function fakeEngine(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    platform: "amazon",
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(undefined),
    readProduct: vi.fn().mockResolvedValue(quote),
    addToCart: vi.fn().mockResolvedValue(undefined),
    getCart: vi.fn().mockResolvedValue({ platform: "amazon", lines: [], subtotalPaise: 0 }),
    checkout: vi.fn().mockResolvedValue({ kind: "credit_ok", amountPaise: 0 }),
    placeOrder: vi.fn().mockResolvedValue({ orderRef: "x", totalPaise: 0, paidOnCredit: true }),
    on: vi.fn().mockReturnValue(() => undefined),
    observe: vi.fn().mockResolvedValue({ url: "", title: "", scroll: { y: 0, h: 0, vh: 0 }, elements: [] }),
    act: vi.fn().mockResolvedValue({ ok: true }),
    captureScreenshot: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as BrowserSession;
}

describe("LegacyAgent", () => {
  it("delegates search/readQuote to the engine", async () => {
    const engine = fakeEngine();
    const agent = new LegacyAgent({ session: engine });
    expect(agent.platform).toBe("amazon");

    await agent.search(item);
    expect(engine.search).toHaveBeenCalledWith(item);

    const { chosen: q, candidates } = await agent.readQuote(item);
    expect(engine.readProduct).toHaveBeenCalledWith(item);
    expect(q).toEqual(quote);
    expect(candidates).toEqual([quote]);
  });

  it("ensureReady opens the home url when provided, no-op otherwise", async () => {
    const withHome = fakeEngine();
    await new LegacyAgent({ session: withHome, homeUrl: "https://www.amazon.in" }).ensureReady();
    expect(withHome.open).toHaveBeenCalledWith("https://www.amazon.in", { hidden: false });

    const noHome = fakeEngine();
    await new LegacyAgent({ session: noHome }).ensureReady();
    expect(noHome.open).not.toHaveBeenCalled();
  });

  it("addToCart returns an 'added' result echoing cart + product urls on success", async () => {
    const engine = fakeEngine();
    const agent = new LegacyAgent({ session: engine, cartUrl: "https://cart" });
    const result = await agent.addToCart({ skuId: "B0PANEER1", qty: 3, productUrl: "https://prod" });

    expect(engine.addToCart).toHaveBeenCalledWith("B0PANEER1", 3);
    expect(result).toEqual({
      status: "added",
      skuId: "B0PANEER1",
      qty: 3,
      cartUrl: "https://cart",
      productUrl: "https://prod",
    });
  });

  it("addToCart returns a 'failed' result (not throwing) when the engine throws", async () => {
    const engine = fakeEngine({ addToCart: vi.fn().mockRejectedValue(new Error("dead button")) });
    const agent = new LegacyAgent({ session: engine });
    const result = await agent.addToCart({ skuId: "B0PANEER1", qty: 1, productUrl: "https://prod" });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("dead button");
    expect(result.productUrl).toBe("https://prod");
  });

  it("addToCart opens the product url when known, else re-searches the item, before adding", async () => {
    const withUrl = fakeEngine();
    await new LegacyAgent({ session: withUrl }).addToCart({
      skuId: "B0PANEER1",
      qty: 2,
      productUrl: "https://prod",
      item,
    });
    expect(withUrl.open).toHaveBeenCalledWith("https://prod", { hidden: false });
    expect(withUrl.search).not.toHaveBeenCalled();
    expect(withUrl.addToCart).toHaveBeenCalledWith("B0PANEER1", 2);

    const noUrl = fakeEngine();
    await new LegacyAgent({ session: noUrl }).addToCart({ skuId: "B0PANEER1", qty: 2, item });
    expect(noUrl.search).toHaveBeenCalledWith(item);
    expect(noUrl.addToCart).toHaveBeenCalledWith("B0PANEER1", 2);
  });
});

describe("agentForEngine", () => {
  /** An AutomationEngine WITHOUT the BrowserSession primitives (like the demo MockAutomationEngine). */
  function engineOnly(): AutomationEngine {
    return {
      platform: "amazon",
      open: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      hide: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue(undefined),
      readProduct: vi.fn().mockResolvedValue(quote),
      addToCart: vi.fn().mockResolvedValue(undefined),
      getCart: vi.fn().mockResolvedValue({ platform: "amazon", lines: [], subtotalPaise: 0 }),
      checkout: vi.fn().mockResolvedValue({ kind: "credit_ok", amountPaise: 0 }),
      placeOrder: vi.fn().mockResolvedValue({ orderRef: "x", totalPaise: 0, paidOnCredit: true }),
      on: vi.fn().mockReturnValue(() => undefined),
    } as AutomationEngine;
  }

  it("uses the dedicated agent for a real BrowserSession engine", () => {
    expect(agentForEngine("amazon", fakeEngine())).toBeInstanceOf(AmazonAgent);
    expect(agentForEngine("hyperpure", fakeEngine({ platform: "hyperpure" }))).toBeInstanceOf(
      HyperpureAgent,
    );
  });

  it("falls back to LegacyAgent for an engine without perceive/act primitives (demo mock)", () => {
    expect(agentForEngine("amazon", engineOnly())).toBeInstanceOf(LegacyAgent);
  });
});

describe("agentFor", () => {
  it("returns the AmazonAgent for amazon, wired with amazon urls", async () => {
    const engine = fakeEngine({ platform: "amazon" });
    const agent = agentFor("amazon", engine);
    expect(agent).toBeInstanceOf(AmazonAgent);
    expect(agent.platform).toBe("amazon");

    await agent.ensureReady();
    expect(engine.open).toHaveBeenCalledWith("https://www.amazon.in", { hidden: false });
  });

  it("returns the HyperpureAgent for hyperpure, wired with hyperpure urls", async () => {
    const engine = fakeEngine({ platform: "hyperpure" });
    const agent = agentFor("hyperpure", engine);
    expect(agent).toBeInstanceOf(HyperpureAgent);
    expect(agent.platform).toBe("hyperpure");

    await agent.ensureReady();
    expect(engine.open).toHaveBeenCalledWith("https://www.hyperpure.com", { hidden: false });

    // HyperpureAgent now confirms the add (ADD → stepper) before echoing the cart URL, so drive a
    // product page where the click swaps ADD for a "− + " stepper.
    const productUrl = "https://www.hyperpure.com/in/paneer-1-kg";
    const card = {
      idx: 1,
      tag: "h3",
      role: null,
      name: "Paneer, 1 Kg ₹399",
      value: null,
      bbox: [200, 200, 200, 60] as const,
      attrs: {},
    };
    const before = {
      url: productUrl,
      title: "",
      scroll: { y: 0, h: 0, vh: 0 },
      elements: [card, { ...card, idx: 2, tag: "button", name: "ADD", bbox: [220, 240, 80, 40] as const }],
    };
    const after = {
      url: productUrl,
      title: "",
      scroll: { y: 0, h: 0, vh: 0 },
      elements: [
        card,
        { ...card, idx: 3, tag: "button", name: "−", bbox: [210, 240, 30, 30] as const },
        { ...card, idx: 4, tag: "button", name: "+", bbox: [290, 240, 30, 30] as const },
      ],
    };
    (engine.observe as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(before)
      .mockResolvedValue(after);

    const result = await agent.addToCart({ skuId: "HP-PANEER-1KG", qty: 1, productUrl, item });
    expect(result.status).toBe("added");
    expect(result.cartUrl).toBe("https://www.hyperpure.com/buyer/cart");
  });
});
