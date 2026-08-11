import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ default: {} }));

const { refundEconomicsFrom, refundedTotalFrom } = await import(
  "./sync.server"
);

/**
 * `refund.transactions[]` is an attempt log, not a ledger. Summing it blindly
 * counts money that never left the merchant's account, and because the total is
 * subtracted from ex-tax revenue an over-count drives an order's margin
 * negative and drags the whole P&L with it.
 */
describe("refundedTotalFrom", () => {
  it("sums successful refund transactions", () => {
    expect(
      refundedTotalFrom([
        { transactions: [{ kind: "refund", status: "success", amount: "55.00" }] },
        { transactions: [{ kind: "refund", status: "success", amount: "10.50" }] },
      ]),
    ).toBe("65.50");
  });

  it("ignores a declined refund that was then retried successfully", () => {
    // The exact scenario: a $120 refund fails at the gateway, the merchant
    // retries, and both attempts stay in the array. Counting both returned
    // $240 against a $120 order.
    expect(
      refundedTotalFrom([
        {
          transactions: [
            { kind: "refund", status: "error", amount: "120.00" },
            { kind: "refund", status: "success", amount: "120.00" },
          ],
        },
      ]),
    ).toBe("120.00");
  });

  it("ignores pending and failed attempts", () => {
    expect(
      refundedTotalFrom([
        {
          transactions: [
            { kind: "refund", status: "pending", amount: "40.00" },
            { kind: "refund", status: "failure", amount: "40.00" },
          ],
        },
      ]),
    ).toBe("0.00");
  });

  it("ignores a void, which releases an uncaptured authorisation", () => {
    expect(
      refundedTotalFrom([
        {
          transactions: [
            { kind: "void", status: "success", amount: "80.00" },
            { kind: "refund", status: "success", amount: "20.00" },
          ],
        },
      ]),
    ).toBe("20.00");
  });

  it("returns zero for missing, empty or malformed input", () => {
    expect(refundedTotalFrom(undefined)).toBe("0.00");
    expect(refundedTotalFrom(null)).toBe("0.00");
    expect(refundedTotalFrom([])).toBe("0.00");
    expect(refundedTotalFrom([{}])).toBe("0.00");
    expect(refundedTotalFrom("nonsense")).toBe("0.00");
  });

  it("still counts a transaction with no status, as the backfill supplies", () => {
    // GraphQL refund transactions come through without a REST-style status;
    // treating those as failures would zero out every backfilled refund.
    expect(
      refundedTotalFrom([{ transactions: [{ kind: "refund", amount: "12.34" }] }]),
    ).toBe("12.34");
  });
});

/**
 * Refund transactions report money in the currency the customer paid in. On a
 * multi-currency order that is the presentment currency, while every stored
 * total is shop currency — subtracting them unconverted treats €92 as $92.
 */
describe("refundEconomicsFrom multi-currency", () => {
  const CONTEXT = {
    shopCurrency: "USD",
    presentmentCurrency: "EUR",
    // Implied by the order itself: $110.00 settled from €100.00.
    presentmentExchangeRate: 1.1,
  };

  it("converts a presentment-currency refund at the order's implied rate", () => {
    const { refundedTotal } = refundEconomicsFrom(
      [
        {
          transactions: [
            {
              kind: "refund",
              status: "success",
              amount: "100.00",
              currency: "EUR",
            },
          ],
        },
      ],
      CONTEXT,
    );
    expect(refundedTotal).toBe("110.00");
  });

  it("leaves a shop-currency transaction alone even in context", () => {
    const { refundedTotal } = refundEconomicsFrom(
      [
        {
          transactions: [
            {
              kind: "refund",
              status: "success",
              amount: "25.00",
              currency: "USD",
            },
          ],
        },
      ],
      CONTEXT,
    );
    expect(refundedTotal).toBe("25.00");
  });

  it("treats a currencyless transaction as shop money, as the backfill synthesises", () => {
    const { refundedTotal } = refundEconomicsFrom(
      [{ transactions: [{ kind: "refund", status: "success", amount: "40.00" }] }],
      CONTEXT,
    );
    expect(refundedTotal).toBe("40.00");
  });

  it("rounds each transaction the way the money moved, not the sum", () => {
    const { refundedTotal } = refundEconomicsFrom(
      [
        {
          transactions: [
            { kind: "refund", status: "success", amount: "0.33", currency: "EUR" },
            { kind: "refund", status: "success", amount: "0.33", currency: "EUR" },
          ],
        },
      ],
      { shopCurrency: "USD", presentmentCurrency: "EUR", presentmentExchangeRate: 1.5 },
    );
    // 0.33 × 1.5 = 0.495 → 0.50 per transaction; 1.00 total, not round(0.99).
    expect(refundedTotal).toBe("1.00");
  });

  it("falls back to rate 1 for a currency it cannot convert", () => {
    const { refundedTotal } = refundEconomicsFrom(
      [
        {
          transactions: [
            { kind: "refund", status: "success", amount: "10.00", currency: "GBP" },
          ],
        },
      ],
      CONTEXT,
    );
    // Wrong by the FX spread but visible and stable — the pre-multi-currency
    // behaviour, never a silent zero.
    expect(refundedTotal).toBe("10.00");
  });
});

/**
 * The gap between the shop-money value of what came back and the money that
 * was actually paid out is the return/restocking fee the merchant kept.
 */
describe("refundEconomicsFrom return fees", () => {
  it("derives the fee from a partial payout against returned items", () => {
    const { refundedTotal, returnFeesRetained } = refundEconomicsFrom([
      {
        transactions: [{ kind: "refund", status: "success", amount: "90.00" }],
        refund_line_items: [
          {
            line_item_id: 1,
            quantity: 1,
            subtotal_set: { shop_money: { amount: "100.00" } },
            total_tax_set: { shop_money: { amount: "10.00" } },
          },
        ],
      },
    ]);
    expect(refundedTotal).toBe("90.00");
    expect(returnFeesRetained).toBe("20.00");
  });

  it("derives no fee from a full payout", () => {
    const { returnFeesRetained } = refundEconomicsFrom([
      {
        transactions: [{ kind: "refund", status: "success", amount: "110.00" }],
        refund_line_items: [
          {
            line_item_id: 1,
            quantity: 1,
            subtotal_set: { shop_money: { amount: "100.00" } },
            total_tax_set: { shop_money: { amount: "10.00" } },
          },
        ],
      },
    ]);
    expect(returnFeesRetained).toBe("0.00");
  });

  it("derives no fee from a money-only goodwill refund", () => {
    const { returnFeesRetained } = refundEconomicsFrom([
      {
        transactions: [{ kind: "refund", status: "success", amount: "15.00" }],
      },
    ]);
    expect(returnFeesRetained).toBe("0.00");
  });

  it("never invents a negative fee when shipping was refunded too", () => {
    // Payout exceeds the returned items' value because shipping came back with
    // them; the fee floors at zero rather than going negative.
    const { returnFeesRetained } = refundEconomicsFrom([
      {
        transactions: [{ kind: "refund", status: "success", amount: "120.00" }],
        refund_line_items: [
          {
            line_item_id: 1,
            quantity: 1,
            subtotal_set: { shop_money: { amount: "100.00" } },
            total_tax_set: { shop_money: { amount: "10.00" } },
          },
        ],
      },
    ]);
    expect(returnFeesRetained).toBe("0.00");
  });

  it("sums fees per refund, not across the blended order", () => {
    // Refund A kept a $20 fee; refund B paid out in full. Blending the two
    // would let B's full payout hide A's fee.
    const { returnFeesRetained } = refundEconomicsFrom([
      {
        transactions: [{ kind: "refund", status: "success", amount: "90.00" }],
        refund_line_items: [
          {
            line_item_id: 1,
            quantity: 1,
            subtotal_set: { shop_money: { amount: "100.00" } },
            total_tax_set: { shop_money: { amount: "10.00" } },
          },
        ],
      },
      {
        transactions: [{ kind: "refund", status: "success", amount: "55.00" }],
        refund_line_items: [
          {
            line_item_id: 2,
            quantity: 1,
            subtotal_set: { shop_money: { amount: "50.00" } },
            total_tax_set: { shop_money: { amount: "5.00" } },
          },
        ],
      },
    ]);
    expect(returnFeesRetained).toBe("20.00");
  });

  it("reads bare legacy fields when the money sets are missing", () => {
    const { returnFeesRetained } = refundEconomicsFrom([
      {
        transactions: [{ kind: "refund", status: "success", amount: "80.00" }],
        refund_line_items: [
          { line_item_id: 1, quantity: 1, subtotal: "100.00", total_tax: "0.00" },
        ],
      },
    ]);
    expect(returnFeesRetained).toBe("20.00");
  });
});
