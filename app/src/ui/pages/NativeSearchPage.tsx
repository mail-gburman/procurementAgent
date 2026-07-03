/**
 * V2 — "Search through the Hyperpure APP, not the web view."
 *
 * Drives the installed native Hyperpure app (com.wotu.app) through an Android Accessibility Service and
 * reads product prices straight from its native UI (no WebView, no vision model). Requires the user to
 * enable the accessibility service once. Falls back to a clear message on web / when disabled.
 */
import { useCallback, useEffect, useState } from "react";
import {
  IonButton,
  IonContent,
  IonInput,
  IonNote,
  IonPage,
  IonSpinner,
} from "@ionic/react";
import { HyperpureNative, type NativeProduct } from "../../core/native/hyperpureNative";
import { formatRupees } from "../../core/domain/types";
import { BrandHeader } from "../components/BrandHeader";

export function NativeSearchPage(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [query, setQuery] = useState("chicken 1 kg");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<NativeProduct[]>([]);

  const refreshEnabled = useCallback(async () => {
    try {
      const { enabled: on } = await HyperpureNative.isEnabled();
      setEnabled(on);
    } catch {
      setEnabled(false); // web / plugin unavailable
    }
  }, []);

  useEffect(() => {
    void refreshEnabled();
  }, [refreshEnabled]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setProducts([]);
    try {
      const res = await HyperpureNative.search({ query: q });
      setProducts(res.products ?? []);
      if ((res.products ?? []).length === 0) setError(res.warning ?? "No products read.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        msg === "accessibility_disabled"
          ? "Enable the Hyperpure reader in Accessibility settings first."
          : `Native search failed: ${msg}`,
      );
      void refreshEnabled();
    } finally {
      setBusy(false);
    }
  }, [busy, query, refreshEnabled]);

  return (
    <IonPage>
      <BrandHeader title="Search the Hyperpure app" subtitle="V2 · native source (no web view)" />
      <IonContent className="ion-padding pc-content">
        {enabled === false ? (
          <div className="pc-banner pc-banner--warn" data-testid="native-disabled">
            <div>
              <strong>Native reader is off.</strong> Enable “Procure Copilot — Hyperpure reader” in
              Android <em>Settings ▸ Accessibility</em>, then come back.
              <div style={{ marginTop: 10 }}>
                <IonButton
                  size="small"
                  onClick={() => void HyperpureNative.openAccessibilitySettings().catch(() => undefined)}
                >
                  Open Accessibility settings
                </IonButton>
                <IonButton size="small" fill="clear" onClick={() => void refreshEnabled()}>
                  I’ve enabled it
                </IonButton>
              </div>
            </div>
          </div>
        ) : null}

        <div className="pc-composer" style={{ marginTop: 12 }}>
          <IonInput
            className="pc-composer__input"
            data-testid="native-query"
            aria-label="Search Hyperpure app"
            placeholder="e.g. chicken 1 kg"
            value={query}
            onIonInput={(e) => setQuery(e.detail.value ?? "")}
          />
          <IonButton
            className="pc-sendbtn"
            data-testid="native-search"
            shape="round"
            disabled={busy || query.trim().length === 0}
            onClick={() => void runSearch()}
          >
            {busy ? <IonSpinner name="dots" /> : "Search"}
          </IonButton>
        </div>

        {busy ? (
          <div className="pc-banner pc-banner--info" data-testid="native-busy">
            <IonSpinner name="dots" />
            <IonNote>Driving the Hyperpure app… (it will open on screen briefly)</IonNote>
          </div>
        ) : null}

        {error ? (
          <p className="pc-banner pc-banner--error" data-testid="native-error">
            {error}
          </p>
        ) : null}

        {products.length > 0 ? (
          <div className="pc-section" data-testid="native-results">
            <p className="pc-section-title">Read from the Hyperpure app ({products.length})</p>
            {products.map((p, i) => (
              <div className="pc-card" key={`${p.title}-${i}`}>
                <div className="pc-line" style={{ padding: "12px 16px", borderBottom: 0 }}>
                  <span className="pc-line__main">
                    <span className="pc-line__name">{p.title}</span>
                    {p.perUnit ? <span className="pc-line__reason">{p.perUnit}</span> : null}
                  </span>
                  <span className="pc-line__price pc-money pc-money--strong">
                    {formatRupees(p.pricePaise)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </IonContent>
    </IonPage>
  );
}
