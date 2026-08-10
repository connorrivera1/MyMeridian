import { describe, expect, it } from "vitest";

import { summariseCash, toCents } from "./cash";

const tx = (
  type: string,
  net: string | null,
  gross: string | null = null,
  fee: string | null = null,
) => ({
  type,
  createdAt: "2026-08-01T00:00:00Z",
  grossAmount: gross,
  shopifyFee: fee,
  netAmount: net,
  shop: "example.myshopify.com",
});

describe("toCents", () => {
  it("converts decimal strings with one rounding at the boundary", () => {
    expect(toCents("149.00")).toBe(14900);
    expect(toCents("12.345")).toBe(1235);
    expect(toCents("-24.83")).toBe(-2483);
  });

  it("treats null and garbage as zero, never NaN", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents("not-money")).toBe(0);
  });
});

describe("summariseCash", () => {
  it("totals gross, fee and net across transactions", () => {
    const summary = summariseCash(
      [
        tx("AppSubscriptionSale", "119.20", "149.00", "29.80"),
        tx("AppSubscriptionSale", "39.20", "49.00", "9.80"),
      ],
      30,
    );
    expect(summary.grossCents).toBe(19800);
    expect(summary.feeCents).toBe(3960);
    expect(summary.netCents).toBe(15840);
    expect(summary.transactionCount).toBe(2);
  });

  it("lets refunds and credits subtract — net can go negative", () => {
    const summary = summariseCash(
      [tx("AppSubscriptionSale", "39.20"), tx("AppSaleCredit", "-49.00")],
      30,
    );
    expect(summary.netCents).toBe(-980);
    expect(summary.byType.AppSaleCredit).toEqual({ count: 1, netCents: -4900 });
  });

  it("survives transaction types that carry no amounts", () => {
    const summary = summariseCash([tx("TaxTransaction", null)], 30);
    expect(summary.netCents).toBe(0);
    expect(summary.byType.TaxTransaction?.count).toBe(1);
  });
});
