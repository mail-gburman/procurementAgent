import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackendClient } from "../../core/backend/BackendClient";
import type {
  Allocation,
  ProcurementRequest,
  Quote,
  RequestedItem,
} from "../../core/domain/types";
import { Orchestrator } from "../../core/orchestrator/Orchestrator";
import { ComparisonPage } from "./ComparisonPage";

const ITEMS: readonly RequestedItem[] = [
  { raw: "5 kg potato", name: "potato", qty: 5, unit: "kg" },
];

const REQUEST: ProcurementRequest = {
  id: "req-1",
  items: ITEMS,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function quote(): Quote {
  return {
    platform: "hyperpure",
    skuId: "hp-potato",
    canonicalItemId: "potato",
    title: "potato",
    pricePaise: 1000,
    inStock: true,
    readAt: "2026-01-01T00:00:00.000Z",
  };
}

function allocation(grandTotalPaise: number): Allocation {
  return {
    perPlatform: [
      {
        platform: "hyperpure",
        lines: [
          {
            canonicalItemId: "potato",
            itemName: "potato",
            platform: "hyperpure",
            skuId: "hp-potato",
            qty: 5,
            unitPricePaise: 1000,
            lineTotalPaise: grandTotalPaise,
            reason: "cheaper on Hyperpure by Rs 38",
          },
        ],
        subtotalPaise: grandTotalPaise,
        deliveryFeePaise: 0,
        totalPaise: grandTotalPaise,
        meetsMov: true,
        payableOnCredit: true,
      },
    ],
    grandTotalPaise,
    singlePlatformBaselinePaise: grandTotalPaise + 2000,
    savingPaise: -2000,
    unfulfilled: [],
  };
}

function makeBackend(optimize: BackendClient["optimize"]): BackendClient {
  const reject = () => Promise.reject(new Error("not used"));
  return {
    intent: reject as unknown as BackendClient["intent"],
    plan: reject as unknown as BackendClient["plan"],
    nextAction: reject as unknown as BackendClient["nextAction"],
    verify: reject as unknown as BackendClient["verify"],
    optimize,
    appendEvent: (async () => undefined) as unknown as BackendClient["appendEvent"],
    createSession: (async () => ({ id: "s1" })) as unknown as BackendClient["createSession"],
    getSession: reject as unknown as BackendClient["getSession"],
  };
}

/** Build an orchestrator already sitting at the approval gate with `alloc`. */
async function atApproval(optimize: BackendClient["optimize"]): Promise<Orchestrator> {
  const orch = new Orchestrator(makeBackend(optimize), {
    sessionId: "s1",
    retryDelayMs: 0,
  });
  await orch.start(REQUEST);
  orch.recordQuote(quote());
  await orch.optimize();
  return orch;
}

describe("ComparisonPage", () => {
  it("renders the allocation in rupees with each line reason and the saving", async () => {
    const orch = await atApproval(async () => allocation(12300));
    render(<ComparisonPage orchestrator={orch} />);

    expect(screen.getByTestId("grand-total")).toHaveTextContent("₹123");
    expect(screen.getByTestId("reason-hyperpure-potato")).toHaveTextContent(
      "cheaper on Hyperpure",
    );
    expect(screen.getByTestId("saving")).toHaveTextContent("You save ₹20");
  });

  it("Modify → editing a line re-optimizes and re-renders the new allocation", async () => {
    const optimize = vi
      .fn()
      .mockResolvedValueOnce(allocation(12300))
      .mockResolvedValueOnce(allocation(9900));
    const orch = await atApproval(optimize as unknown as BackendClient["optimize"]);
    render(<ComparisonPage orchestrator={orch} />);

    expect(screen.getByTestId("grand-total")).toHaveTextContent("₹123");

    fireEvent.click(screen.getByTestId("modify-button"));
    fireEvent.click(screen.getByTestId("qty-inc-potato"));

    await waitFor(() =>
      expect(screen.getByTestId("grand-total")).toHaveTextContent("₹99"),
    );
    expect(optimize).toHaveBeenCalledTimes(2);
  });

  it("Proceed fires approve() and shows the approved state", async () => {
    const orch = await atApproval(async () => allocation(12300));
    const approveSpy = vi.spyOn(orch, "approve");
    render(<ComparisonPage orchestrator={orch} />);

    fireEvent.click(screen.getByTestId("proceed-button"));

    expect(approveSpy).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("approved-note")).toBeInTheDocument(),
    );
  });

  it("Cancel cancels the session and never approves", async () => {
    const orch = await atApproval(async () => allocation(12300));
    const approveSpy = vi.spyOn(orch, "approve");
    render(<ComparisonPage orchestrator={orch} />);

    fireEvent.click(screen.getByTestId("cancel-button"));

    await waitFor(() =>
      expect(screen.getByTestId("cancelled-note")).toBeInTheDocument(),
    );
    expect(approveSpy).not.toHaveBeenCalled();
  });

  it("shows each platform's option per item with ₹/unit, and choosing re-optimizes", async () => {
    const optimize = vi
      .fn()
      .mockResolvedValueOnce(allocation(39900))
      .mockResolvedValueOnce(allocation(9900));
    const orch = new Orchestrator(makeBackend(optimize as unknown as BackendClient["optimize"]), {
      sessionId: "s1",
      retryDelayMs: 0,
    });
    await orch.start(REQUEST);
    // Same item on both platforms in different pack sizes (the real-world Milky Mist case).
    orch.recordQuote({
      platform: "hyperpure",
      skuId: "hp-paneer",
      canonicalItemId: "potato",
      title: "Milky Mist Paneer 1 Kg",
      pricePaise: 39900,
      packSize: "1 Kg",
      inStock: true,
      readAt: "2026-01-01T00:00:00.000Z",
    });
    orch.recordQuote({
      platform: "amazon",
      skuId: "az-paneer",
      canonicalItemId: "potato",
      title: "Milky Mist Paneer 500 g",
      pricePaise: 9900,
      packSize: "500 g",
      inStock: true,
      readAt: "2026-01-01T00:00:00.000Z",
    });
    await orch.optimize();

    render(<ComparisonPage orchestrator={orch} />);

    // Both platform options are shown for the item, each with a per-unit price.
    const hp = screen.getByTestId("choice-potato-hyperpure");
    const az = screen.getByTestId("choice-potato-amazon");
    expect(hp).toHaveTextContent("₹399/kg");
    expect(az).toHaveTextContent("₹198/kg");

    // Picking a platform issues a swap-platform modify (which re-optimizes).
    fireEvent.click(az);
    await waitFor(() => expect(optimize).toHaveBeenCalledTimes(2));
  });

  it("V2: auto-picks for an approximate default — no nearby-SKU picker is surfaced", async () => {
    const optimize = vi
      .fn()
      .mockResolvedValueOnce(allocation(42000))
      .mockResolvedValueOnce(allocation(40000));
    const orch = new Orchestrator(makeBackend(optimize as unknown as BackendClient["optimize"]), {
      sessionId: "s1",
      retryDelayMs: 0,
    });
    await orch.start(REQUEST);
    const chosen: Quote = {
      platform: "hyperpure",
      skuId: "mm-1kg",
      canonicalItemId: "potato",
      title: "Milky Mist Paneer 1 Kg",
      pricePaise: 42000,
      packSize: "1 Kg",
      inStock: true,
      matchKind: "nearby",
      readAt: "2026-01-01T00:00:00.000Z",
    };
    // Same product, different SIZE — an approximate (nearby) match, NOT ambiguous.
    const alt: Quote = {
      ...chosen,
      skuId: "mm-500g",
      title: "Milky Mist Paneer 500 g",
      packSize: "500 g",
      pricePaise: 40000,
    };
    orch.recordQuote(chosen);
    orch.recordCandidates("potato", [chosen, alt]);
    await orch.optimize();

    render(<ComparisonPage orchestrator={orch} />);

    // V2 decision (SHOW_PRODUCT_PICKER=false): no picker is surfaced — the cheapest/best-value match
    // is auto-picked and the user proceeds without a "which product?" prompt.
    expect(screen.queryByTestId("picker-toggle-potato")).toBeNull();
    expect(screen.queryByTestId("picker-potato")).toBeNull();
    expect(optimize).toHaveBeenCalledTimes(1);
  });

  it("V2: auto-picks the cheapest even when a query is AMBIGUOUS — no picker is surfaced", async () => {
    const optimize = vi
      .fn()
      .mockResolvedValueOnce(allocation(31400))
      .mockResolvedValueOnce(allocation(28000));
    const orch = new Orchestrator(makeBackend(optimize as unknown as BackendClient["optimize"]), {
      sessionId: "s1",
      retryDelayMs: 0,
    });
    await orch.start(REQUEST);
    // "chicken" matched several DIFFERENT products — the app must ask which one.
    const chosen: Quote = {
      platform: "hyperpure",
      skuId: "nugget-1kg",
      canonicalItemId: "potato",
      title: "ITC - Crunchy Chicken Nugget, 1 Kg",
      pricePaise: 31400,
      packSize: "1 Kg",
      inStock: true,
      matchKind: "exact",
      readAt: "2026-01-01T00:00:00.000Z",
    };
    const alt: Quote = { ...chosen, skuId: "curry-1kg", title: "Chicken Curry Cut 1 Kg", pricePaise: 28000 };
    orch.recordQuote(chosen);
    orch.recordCandidates("potato", [chosen, alt]);
    await orch.optimize();

    render(<ComparisonPage orchestrator={orch} />);

    // V2 decision (SHOW_PRODUCT_PICKER=false): even for an ambiguous query no picker is surfaced —
    // the cheapest/best-value match is auto-picked (chooseQuote) and the flow continues silently.
    expect(screen.queryByTestId("picker-potato")).toBeNull();
    expect(screen.queryByTestId("picker-toggle-potato")).toBeNull();
    expect(optimize).toHaveBeenCalledTimes(1);
  });

  it("does NOT show the nearby-SKU picker when the default is an exact match", async () => {
    const orch = await atApproval(async () => allocation(12300)); // quote() has no matchKind (exact/unknown)
    render(<ComparisonPage orchestrator={orch} />);
    expect(screen.queryByTestId("picker-potato")).toBeNull();
  });

  it("read back invokes the injected speak fn with the explanation", async () => {
    const orch = await atApproval(async () => allocation(12300));
    const speak = vi.fn();
    render(<ComparisonPage orchestrator={orch} speak={speak} />);

    fireEvent.click(screen.getByTestId("readback-button"));

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toContain("Grand total");
  });
});
