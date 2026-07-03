/**
 * On-device order parser — the standalone fallback for `/intent` when the backend (Mac + Ollama) is
 * unreachable. Handles the typed-order formats the app advertises ("20kg atta, 5kg sugar",
 * "10kg onions, 5kg paneer", "2 carton refined oil", "onion 1 kg", bare "paneer") with plain
 * pattern-matching: split into segments, pull the quantity+unit out of each, the leftover words are
 * the item name. No network, no LLM — so the APK keeps working with no Mac on the WiFi. The LLM path
 * stays preferred when the backend answers (better at odd phrasing, brands, and other languages).
 */
import type { RequestedItem, Unit } from "../domain/types";

/** Spelling/synonym → canonical {@link Unit}. */
const UNIT_MAP: Record<string, Unit> = {
  kg: "kg",
  kgs: "kg",
  kilo: "kg",
  kilos: "kg",
  kilogram: "kg",
  kilograms: "kg",
  g: "g",
  gm: "g",
  gms: "g",
  gram: "g",
  grams: "g",
  l: "l",
  ltr: "l",
  ltrs: "l",
  litre: "l",
  litres: "l",
  liter: "l",
  liters: "l",
  ml: "ml",
  pc: "piece",
  pcs: "piece",
  piece: "piece",
  pieces: "piece",
  unit: "piece",
  units: "piece",
  pkt: "packet",
  packet: "packet",
  packets: "packet",
  pack: "packet",
  packs: "packet",
  carton: "carton",
  cartons: "carton",
  box: "carton",
  boxes: "carton",
  case: "carton",
  cases: "carton",
  dozen: "dozen",
  dozens: "dozen",
};

const UNIT_TOKENS = Object.keys(UNIT_MAP)
  .sort((a, b) => b.length - a.length)
  .join("|");

/** "20kg", "1.5 litre", "2 cartons" — number glued to or spaced from a known unit. */
const QTY_UNIT_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_TOKENS})\\b`, "i");

/** Words that carry no product meaning once the quantity is extracted. */
const FILLER = new Set([
  "of", "the", "a", "an", "some", "fresh", "please", "pls", "want", "need", "buy",
  "get", "order", "me", "i", "we", "and", "x", "for", "send", "add",
]);

/** Count-only units where a following weight/volume is the pack size ("5 packets of 1kg rice"). */
const COUNT_UNITS: ReadonlySet<Unit> = new Set(["packet", "carton", "dozen", "piece"]);
const MEASURE_UNITS: ReadonlySet<Unit> = new Set(["kg", "g", "l", "ml"]);

function cleanName(fragment: string): string {
  return fragment
    .toLowerCase()
    .replace(/[^a-zऀ-৿\s-]/gi, " ") // keep letters (incl. Devanagari/Bengali), spaces, hyphens
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER.has(w))
    .join(" ")
    .trim();
}

/** Parse one comma/and-separated segment into an item; null when no product name survives. */
function parseSegment(segment: string): RequestedItem | null {
  const raw = segment.trim();
  if (raw.length === 0) return null;

  let rest = raw;
  let qty = 1;
  let unit: Unit = "piece";
  let packSize: string | undefined;

  const m = QTY_UNIT_RE.exec(rest);
  if (m) {
    qty = Number.parseFloat(m[1]);
    unit = UNIT_MAP[m[2].toLowerCase()];
    rest = (rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length)).trim();
    // "5 packets of 1kg basmati" — a second, measured quantity is the per-pack size.
    const m2 = QTY_UNIT_RE.exec(rest);
    if (m2 && COUNT_UNITS.has(unit) && MEASURE_UNITS.has(UNIT_MAP[m2[2].toLowerCase()])) {
      packSize = `${m2[1]} ${UNIT_MAP[m2[2].toLowerCase()]}`;
      rest = (rest.slice(0, m2.index) + " " + rest.slice(m2.index + m2[0].length)).trim();
    }
  } else {
    // No unit anywhere — a leading bare count ("2 paneer") is still a quantity of pieces.
    const bare = /^(\d+(?:\.\d+)?)\s+(.+)$/.exec(rest);
    if (bare) {
      qty = Number.parseFloat(bare[1]);
      rest = bare[2];
    }
  }

  const name = cleanName(rest);
  if (name.length === 0 || !Number.isFinite(qty) || qty <= 0) return null;

  const item: RequestedItem = { raw, name, qty, unit, ...(packSize ? { packSize } : {}) };
  return item;
}

/** Parse a whole typed order into items. Always returns an array (empty when nothing parses). */
export function parseLocalIntent(text: string): RequestedItem[] {
  const items: RequestedItem[] = [];
  const segments = text.split(/,|;|\n|\band\b|\baur\b|\bplus\b/i);
  for (const segment of segments) {
    const item = parseSegment(segment);
    if (item) items.push(item);
  }
  return items;
}
