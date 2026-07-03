import { describe, expect, it } from "vitest";
import type { OptimizeRequest } from "../backend/BackendClient";
import type { Quote, RequestedItem } from "../domain/types";
import { localOptimize } from "./localOptimize";

function item(name: string, qty = 1, unit: RequestedItem["unit"] = "kg"): RequestedItem {
  return { raw: `${qty}${unit} ${name}`, name, qty, unit };
}

function quote(over: Partial<Quote> & Pick<Quote, "canonicalItemId" | "pricePaise">): Quote {
  return {
    platform: "hyperpure",
    skuId: `sku-${over.canonicalItemId}`,
    title: over.canonicalItemId,
    packSize: "1 kg",
    inStock: true,
    readAt: new Date().toISOString(),
    ...over,
  };
}

describe("localOptimize (standalone on-device allocation)", () => {
  it("allocates each item to its quote and rolls up totals", () => {
    const req: OptimizeRequest = {
      items: [item("paneer"), item("sugar", 5)],
      quotes: [
        quote({ canonicalItemId: "paneer", pricePaise: 27200 }),
        quote({ canonicalItemId: "sugar", pricePaise: 28700, packSize: "5 Kg", title: "Sugar, 5 Kg" }),
      ],
      constraints: [{ platform: "hyperpure", movPaise: 0, deliveryFeePaise: 0 }],
    };
    const alloc = localOptimize(req);
    expect(alloc.perPlatform).toHaveLength(1);
    expect(alloc.perPlatform[0].platform).toBe("hyperpure");
    expect(alloc.perPlatform[0].lines).toHaveLength(2);
    expect(alloc.grandTotalPaise).toBeGreaterThan(0);
    expect(alloc.grandTotalPaise).toBe(alloc.perPlatform[0].totalPaise);
    // Single platform → the split IS the baseline, no saving either way.
    expect(alloc.savingPaise).toBe(0);
    expect(alloc.unfulfilled).toHaveLength(0);
  });

  it("reports unsourceable items as unfulfilled", () => {
    const req: OptimizeRequest = {
      items: [item("caviar")],
      quotes: [],
      constraints: [],
    };
    const alloc = localOptimize(req);
    expect(alloc.perPlatform).toHaveLength(0);
    expect(alloc.unfulfilled).toEqual([
      {
        canonicalItemId: "caviar",
        itemName: "caviar",
        reason: "out of stock on all platforms",
      },
    ]);
    expect(alloc.grandTotalPaise).toBe(0);
  });

  it("adds the constraint delivery fee to the platform total", () => {
    const req: OptimizeRequest = {
      items: [item("atta", 5)],
      quotes: [quote({ canonicalItemId: "atta", pricePaise: 24000, packSize: "5 Kg", title: "Atta, 5 Kg" })],
      constraints: [{ platform: "hyperpure", movPaise: 10000, deliveryFeePaise: 5000 }],
    };
    const alloc = localOptimize(req);
    expect(alloc.perPlatform[0].deliveryFeePaise).toBe(5000);
    expect(alloc.perPlatform[0].totalPaise).toBe(alloc.perPlatform[0].subtotalPaise + 5000);
    expect(alloc.perPlatform[0].meetsMov).toBe(true);
  });
});
