import { Decimal } from "@prisma/client/runtime/library";
import { describe, expect, it } from "vitest";

import {
  csvCell,
  MAX_PROFIT_EXPORT_RANGE_MS,
  PROFIT_EXPORT_HEADER,
  profitExportRangeIsAllowed,
  profitOrderCsvRow,
} from "./profit-export.server";

describe("profit CSV export", () => {
  it("bounds interactive exports to a finite one-year period", () => {
    const from = new Date("2025-01-01T00:00:00.000Z");
    expect(
      profitExportRangeIsAllowed(
        from,
        new Date(from.getTime() + MAX_PROFIT_EXPORT_RANGE_MS),
      ),
    ).toBe(true);
    expect(
      profitExportRangeIsAllowed(
        from,
        new Date(from.getTime() + MAX_PROFIT_EXPORT_RANGE_MS + 1),
      ),
    ).toBe(false);
  });

  it("quotes cells that could alter CSV structure", () => {
    expect(csvCell('one,"two"\nthree')).toBe('"one,""two""\nthree"');
    expect(csvCell(null)).toBe("");
  });

  it("keeps the accountant-facing columns and decimal precision stable", () => {
    expect(PROFIT_EXPORT_HEADER).toContain("net_profit");
    const row = profitOrderCsvRow({
      orderNumber: 1042,
      processedAt: new Date("2026-08-10T12:00:00.000Z"),
      currency: "USD",
      channel: "DIRECT",
      total: new Decimal("100.25"),
      refundedTotal: new Decimal("0"),
      cogsTotal: new Decimal("30.1250"),
      materializedOutboundShippingCost: new Decimal("8.5"),
      materializedReturnShippingCost: new Decimal("2.5"),
      materializedPaymentFee: new Decimal("3.21"),
      materializedPickPackCost: new Decimal("1.75"),
      adCostAttributed: new Decimal("4"),
      overheadAllocated: new Decimal("2"),
      contributionProfit: new Decimal("54.415"),
      netProfit: new Decimal("52.415"),
      computedAt: new Date("2026-08-10T12:01:00.000Z"),
    });
    expect(row).toContain("100.25");
    expect(row).toContain("30.125");
    expect(row).toContain("52.415");
  });
});
