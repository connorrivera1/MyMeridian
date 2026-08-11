import { Decimal } from "@prisma/client/runtime/library";
import { describe, expect, it } from "vitest";

import {
  csvCell,
  PROFIT_EXPORT_HEADER,
  profitOrderCsvRow,
} from "./profit-export.server";

describe("profit CSV export", () => {
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
