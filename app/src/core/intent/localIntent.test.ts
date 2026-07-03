import { describe, expect, it } from "vitest";
import { parseLocalIntent } from "./localIntent";

describe("parseLocalIntent (standalone on-device parser)", () => {
  it("parses the advertised multi-item format", () => {
    const items = parseLocalIntent("20kg atta, 5kg sugar");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ name: "atta", qty: 20, unit: "kg" });
    expect(items[1]).toMatchObject({ name: "sugar", qty: 5, unit: "kg" });
  });

  it("parses qty after the name", () => {
    expect(parseLocalIntent("onion 1 kg")[0]).toMatchObject({ name: "onion", qty: 1, unit: "kg" });
  });

  it("defaults a bare item to 1 piece", () => {
    expect(parseLocalIntent("paneer")[0]).toMatchObject({ name: "paneer", qty: 1, unit: "piece" });
  });

  it("handles count units and 'and' separators", () => {
    const items = parseLocalIntent("2 carton refined oil and 1 dozen eggs");
    expect(items[0]).toMatchObject({ name: "refined oil", qty: 2, unit: "carton" });
    expect(items[1]).toMatchObject({ name: "eggs", qty: 1, unit: "dozen" });
  });

  it("extracts a pack size from 'N packets of SIZE'", () => {
    const [item] = parseLocalIntent("5 packets of 1kg basmati rice");
    expect(item).toMatchObject({ name: "basmati rice", qty: 5, unit: "packet", packSize: "1 kg" });
  });

  it("treats a leading bare number as a piece count", () => {
    expect(parseLocalIntent("2 paneer")[0]).toMatchObject({ name: "paneer", qty: 2, unit: "piece" });
  });

  it("returns [] for unusable input", () => {
    expect(parseLocalIntent("???")).toHaveLength(0);
    expect(parseLocalIntent("")).toHaveLength(0);
  });
});
