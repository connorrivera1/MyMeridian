import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ default: {} }));

const { refundedTotalFrom } = await import("./sync.server");

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
