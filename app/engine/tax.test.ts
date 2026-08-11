import { TaxJurisdictionType, TaxRegime } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { allocateTaxCents, splitOrderTax } from "./tax";

describe("order tax splitting", () => {
  it("allocates every cent deterministically without floating point drift", () => {
    expect(allocateTaxCents(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allocateTaxCents(-10, [1, 1, 1])).toEqual([-4, -3, -3]);
    expect(allocateTaxCents(2, [0, 0, 0])).toEqual([1, 1, 0]);
  });

  it("splits inclusive EU VAT between merchandise and shipping", () => {
    const result = splitOrderTax({
      totalTax: "20.01",
      taxesIncluded: true,
      countryCode: "DE",
      lineItems: [{ tax_lines: [{ title: "MwSt / VAT", rate: "0.19", price: "19.00" }] }],
      shippingLines: [{ tax_lines: [{ title: "MwSt / VAT", rate: "0.19", price: "1.00" }] }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      regime: TaxRegime.EU_VAT,
      jurisdictionType: TaxJurisdictionType.VAT,
      taxAmountCents: 2001,
      lineItemTaxCents: 1901,
      shippingTaxCents: 100,
      roundingAdjustmentCents: 1,
      includedInPrice: true,
    });
    expect(result[0]!.taxableAmount).toBe("105.32");
  });

  it("keeps compound US state, county, city and district tax auditable", () => {
    const result = splitOrderTax({
      totalTax: "8.88",
      countryCode: "US",
      regionCode: "NY",
      lineItems: [{ tax_lines: [
        { title: "NY State Sales Tax", rate: "0.04", price: "4.00" },
        { title: "Albany County Tax", rate: "0.03", price: "3.00" },
        { title: "Albany City Tax", rate: "0.01", price: "1.00" },
        { title: "Transit District Tax", rate: "0.00875", price: "0.88" },
      ] }],
    });

    expect(result.map((item) => item.jurisdictionType).sort()).toEqual([
      TaxJurisdictionType.CITY,
      TaxJurisdictionType.COUNTY,
      TaxJurisdictionType.DISTRICT,
      TaxJurisdictionType.STATE,
    ].sort());
    expect(result.every((item) => item.regime === TaxRegime.US_SALES_TAX)).toBe(true);
    expect(result.reduce((sum, item) => sum + item.taxAmountCents, 0)).toBe(888);
  });

  it("creates an explicit unallocated component instead of hiding missing detail", () => {
    expect(splitOrderTax({ totalTax: "3.17" })).toEqual([
      expect.objectContaining({
        regime: TaxRegime.UNALLOCATED,
        taxAmountCents: 317,
        roundingAdjustmentCents: 317,
      }),
    ]);
    expect(splitOrderTax({ totalTax: "0.00" })).toEqual([]);
  });

  it("keeps tiny-rate taxable bases exact beyond JavaScript's safe integer range", () => {
    const [component] = splitOrderTax({
      totalTax: "9999999999.99",
      countryCode: "US",
      taxLines: [{ title: "Special district tax", rate: "0.00000001", price: "9999999999.99" }],
    });
    expect(component?.taxableAmount).toBe("999999999999000000.00");
  });
});
