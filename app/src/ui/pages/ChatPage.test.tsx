import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  BackendClient,
  IntentRequest,
  IntentResponse,
} from "../../core/backend/BackendClient";
import type { RequestedItem } from "../../core/domain/types";
import { IntentClient } from "../../core/intent/IntentClient";
import { ChatPage } from "./ChatPage";

const ITEMS: readonly RequestedItem[] = [
  { raw: "5 kilo aloo", name: "potato", qty: 5, unit: "kg" },
  { raw: "2 carton tel", name: "refined oil", qty: 2, unit: "carton" },
];

function makeIntentClient(
  intent: (req: IntentRequest) => Promise<IntentResponse>,
): { client: IntentClient; intent: ReturnType<typeof vi.fn> } {
  const intentMock = vi.fn(intent);
  const reject = () => Promise.reject(new Error("not used"));
  const backend: BackendClient = {
    intent: intentMock as unknown as BackendClient["intent"],
    plan: reject as unknown as BackendClient["plan"],
    nextAction: reject as unknown as BackendClient["nextAction"],
    verify: reject as unknown as BackendClient["verify"],
    optimize: reject as unknown as BackendClient["optimize"],
    appendEvent: reject as unknown as BackendClient["appendEvent"],
    createSession: reject as unknown as BackendClient["createSession"],
    getSession: reject as unknown as BackendClient["getSession"],
  };
  return { client: new IntentClient(backend), intent: intentMock };
}

/** Simulates typing into the Ionic input by firing its `ionInput` custom event. */
function typeOrder(value: string): void {
  const input = screen.getByTestId("order-input");
  fireEvent(input, new CustomEvent("ionInput", { detail: { value } }));
}

describe("ChatPage", () => {
  it("shows the empty state before any order", () => {
    const { client } = makeIntentClient(async () => ({ items: [], confidence: 0 }));
    render(<ChatPage intentClient={client} />);
    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
  });

  it("parses a typed order and renders an editable item list", async () => {
    const { client, intent } = makeIntentClient(async () => ({
      items: ITEMS,
      confidence: 0.9,
    }));
    render(<ChatPage intentClient={client} />);

    typeOrder("5 kilo aloo aur 2 carton tel");
    fireEvent.click(screen.getByTestId("send-button"));

    await waitFor(() => expect(screen.getByTestId("item-list")).toBeInTheDocument());
    expect(intent).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("item-name-0")).toHaveTextContent("potato");
    expect(screen.getByTestId("item-name-1")).toHaveTextContent("refined oil");
    expect(screen.getByTestId("qty-value-0")).toHaveTextContent("5");
  });

  it("updates the displayed quantity when the stepper is used", async () => {
    const { client } = makeIntentClient(async () => ({ items: ITEMS, confidence: 0.9 }));
    render(<ChatPage intentClient={client} />);

    typeOrder("order");
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(screen.getByTestId("qty-value-0")).toHaveTextContent("5"));

    fireEvent.click(screen.getByTestId("qty-increment-0"));
    expect(screen.getByTestId("qty-value-0")).toHaveTextContent("6");

    fireEvent.click(screen.getByTestId("qty-decrement-0"));
    expect(screen.getByTestId("qty-value-0")).toHaveTextContent("5");
  });

  it("fires onConfirm with the (edited) items", async () => {
    const onConfirm = vi.fn();
    const { client } = makeIntentClient(async () => ({ items: ITEMS, confidence: 0.9 }));
    render(<ChatPage intentClient={client} onConfirm={onConfirm} />);

    typeOrder("order");
    fireEvent.click(screen.getByTestId("send-button"));
    await waitFor(() => expect(screen.getByTestId("confirm-button")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("qty-increment-0"));
    fireEvent.click(screen.getByTestId("confirm-button"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const confirmed = onConfirm.mock.calls[0][0] as readonly RequestedItem[];
    expect(confirmed[0].qty).toBe(6);
  });

  it("shows a no-items message when nothing is recognised", async () => {
    const { client } = makeIntentClient(async () => ({ items: [], confidence: 0.9 }));
    render(<ChatPage intentClient={client} />);

    // Symbols only: the LLM returns no items AND the on-device fallback parser can't extract a
    // name either (a wordy input like "blah blah" is now picked up by the local parser by design).
    typeOrder("??? !!!");
    fireEvent.click(screen.getByTestId("send-button"));

    await waitFor(() => expect(screen.getByTestId("status-note")).toBeInTheDocument());
  });

  it("renders Hindi copy when locale is hi-IN", () => {
    const { client } = makeIntentClient(async () => ({ items: [], confidence: 0 }));
    render(<ChatPage intentClient={client} locale="hi-IN" />);
    expect(screen.getByTestId("send-button")).toHaveTextContent("भेजें");
  });
});
