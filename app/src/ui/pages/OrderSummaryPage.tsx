/**
 * The order summary screen (PROCURE_COPILOT_PLAN.md Epic 6). After checkout it shows, per platform,
 * the order reference, total (in rupees), and whether it was paid on credit or paid now — plus a
 * grand total across all placed orders. Fully prop-driven for testability.
 */
import { IonButton, IonContent, IonFooter, IonNote, IonPage } from "@ionic/react";
import type { OrderAttempt, PlatformId } from "../../core/domain/types";
import { formatRupees, SUPPORTED_PLATFORMS } from "../../core/domain/types";
import { clearLastRun } from "../../core/checkout/lastRun";
import { OrderReceiptCard } from "../components/OrderReceiptCard";
import { BrandHeader } from "../components/BrandHeader";

const PLATFORM_LABELS: Record<PlatformId, string> = {
  hyperpure: "Hyperpure",
  amazon: "Amazon.in",
};

function platformLabel(platform: PlatformId): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export interface OrderSummaryPageProps {
  readonly attempts: readonly OrderAttempt[];
  /**
   * Hand-off: open the platform's cart in the foreground (logged-in WebView) for manual review +
   * checkout. Provided for staged ("cart_filled") attempts; omitted in pure-display contexts (tests).
   */
  readonly onOpenCart?: (platform: PlatformId) => void;
  /**
   * Hand-off for a line the agent could NOT add automatically: open its product detail page in the
   * foreground so the user can add it manually. Provided for staged attempts with failed lines.
   */
  readonly onOpenProduct?: (platform: PlatformId, productUrl: string) => void;
}

/** Success check glyph for the summary hero. */
function CheckGlyph(): JSX.Element {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12.5l4.5 4.5L19 7"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function OrderSummaryPage({
  attempts,
  onOpenCart,
  onOpenProduct,
}: OrderSummaryPageProps): JSX.Element {
  const placed = attempts.filter((a) => a.status === "placed");
  const grandTotalPaise = placed.reduce((sum, a) => sum + a.totalPaise, 0);
  const allPlaced = attempts.length > 0 && placed.length === attempts.length;

  // Staged carts: items were added best-effort and handed to the user to review + check out manually.
  const staged = attempts
    .filter((a) => a.status === "cart_filled")
    .slice()
    .sort(
      (a, b) => SUPPORTED_PLATFORMS.indexOf(a.platform) - SUPPORTED_PLATFORMS.indexOf(b.platform),
    );
  const stagedTotalPaise = staged.reduce((sum, a) => sum + a.totalPaise, 0);

  const startNewOrder = (): void => {
    // Drop the persisted run summary first — otherwise the reload restores this screen instead of chat.
    clearLastRun();
    window.location.assign("/");
  };

  return (
    <IonPage>
      <BrandHeader title="Order summary" subtitle="Your procurement run" />
      <IonContent className="ion-padding pc-content">
        {attempts.length === 0 ? (
          <div className="pc-hero" data-testid="summary-empty">
            <h1 className="pc-hero__title">No orders yet</h1>
            <p className="pc-hero__subtitle">
              Place an order to see your receipts and savings here.
            </p>
          </div>
        ) : staged.length > 0 ? (
          <>
            <div className="pc-success-hero" role="status">
              <span className="pc-success-hero__badge" aria-hidden="true">
                <CheckGlyph />
              </span>
              <h2 className="pc-success-hero__title" data-testid="summary-headline">
                {staged.length === 1
                  ? "Your cart is ready"
                  : "Your carts are ready"}
              </h2>
              <p className="pc-success-hero__sub">
                <IonNote>
                  We added your items — open each cart to review quantities and check out.
                </IonNote>
              </p>
            </div>

            {staged.map((attempt) => {
              const failedLines = (attempt.stagedLines ?? []).filter((l) => l.status === "failed");
              return (
                <div
                  className="pc-handoff-card"
                  key={attempt.platform}
                  data-testid={`staged-${attempt.platform}`}
                >
                  <h2 className="pc-handoff-card__platform">{platformLabel(attempt.platform)}</h2>
                  <p className="pc-handoff-card__prompt">
                    {attempt.stagedLineCount ?? 0} item
                    {(attempt.stagedLineCount ?? 0) === 1 ? "" : "s"} added
                    {attempt.nativeApp ? " to your Hyperpure app cart" : ""} · approx{" "}
                    {formatRupees(attempt.totalPaise)}
                  </p>

                  {failedLines.length > 0 ? (
                    <div
                      className="pc-handoff-card__failed"
                      data-testid={`staged-failed-${attempt.platform}`}
                    >
                      <IonNote color="warning">
                        We couldn&apos;t add {failedLines.length} item
                        {failedLines.length === 1 ? "" : "s"} automatically — open{" "}
                        {failedLines.length === 1 ? "it" : "them"} to add manually:
                      </IonNote>
                      {failedLines.map((line) => (
                        <IonButton
                          key={line.canonicalItemId}
                          fill="outline"
                          expand="block"
                          style={{ marginTop: "0.4rem" }}
                          data-testid={`add-manually-${attempt.platform}-${line.canonicalItemId}`}
                          disabled={!line.productUrl || !onOpenProduct}
                          onClick={() =>
                            line.productUrl && onOpenProduct?.(attempt.platform, line.productUrl)
                          }
                        >
                          Open {line.itemName} ({line.qty})
                        </IonButton>
                      ))}
                    </div>
                  ) : null}

                  <IonButton
                    className="pc-cta"
                    expand="block"
                    data-testid={`review-${attempt.platform}`}
                    disabled={(!attempt.cartUrl && !attempt.nativeApp) || !onOpenCart}
                    onClick={() => onOpenCart?.(attempt.platform)}
                  >
                    {attempt.nativeApp
                      ? `Open ${platformLabel(attempt.platform)} to check out`
                      : `Review & checkout on ${platformLabel(attempt.platform)}`}
                  </IonButton>
                </div>
              );
            })}

            <div className="pc-grandtotal">
              <span className="pc-grandtotal__label">Estimated total</span>
              <span className="pc-grandtotal__value" data-testid="summary-grand-total">
                {formatRupees(stagedTotalPaise)}
              </span>
            </div>
            <IonNote className="ion-text-center" style={{ display: "block", marginTop: "0.75rem" }}>
              Nothing is purchased until you complete checkout on each platform.
            </IonNote>
          </>
        ) : (
          <>
            <div className="pc-success-hero" role="status">
              <span
                className="pc-success-hero__badge"
                style={
                  allPlaced
                    ? undefined
                    : {
                        background: "rgba(var(--ion-color-warning-rgb), 0.16)",
                        color: "var(--ion-color-warning-shade)",
                      }
                }
                aria-hidden="true"
              >
                <CheckGlyph />
              </span>
              <h2 className="pc-success-hero__title" data-testid="summary-headline">
                {allPlaced
                  ? "All orders placed"
                  : `${placed.length} of ${attempts.length} orders placed`}
              </h2>
              <p className="pc-success-hero__sub">
                <IonNote data-testid="summary-placed-count">
                  {placed.length} order{placed.length === 1 ? "" : "s"} placed.
                </IonNote>
              </p>
            </div>

            {attempts.map((attempt) => (
              <OrderReceiptCard key={attempt.platform} attempt={attempt} />
            ))}

            <div className="pc-grandtotal">
              <span className="pc-grandtotal__label">Grand total</span>
              <span className="pc-grandtotal__value" data-testid="summary-grand-total">
                {formatRupees(grandTotalPaise)}
              </span>
            </div>
          </>
        )}
      </IonContent>

      {attempts.length > 0 ? (
        <IonFooter className="ion-no-border">
          <div className="pc-sticky-bar">
            <IonButton className="pc-cta" expand="block" onClick={startNewOrder}>
              Start new order
            </IonButton>
          </div>
        </IonFooter>
      ) : null}
    </IonPage>
  );
}
