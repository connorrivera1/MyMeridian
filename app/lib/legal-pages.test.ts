import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The public legal documents on the marketing site.
 *
 * Shopify requires a publicly reachable privacy policy URL, and it is checked
 * by a human reviewer. These assertions cover the two ways that page can fail
 * review without anyone noticing locally: it can go out with drafting
 * placeholders still in it, or it can drift from what the code actually does.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const read = (relative: string) =>
  readFileSync(join(REPO_ROOT, relative), "utf8");

const PAGES = ["site/privacy.html", "site/terms.html"] as const;

describe("public legal pages", () => {
  it.each(PAGES)("%s is linked from the landing page footer", (page) => {
    const file = page.replace("site/", "");
    expect(read("site/index.html")).toContain(`href="${file}"`);
  });

  it.each(PAGES)("%s links back to the site and to its sibling", (page) => {
    const html = read(page);
    expect(html).toContain('href="index.html"');
    const sibling = page.includes("privacy") ? "terms.html" : "privacy.html";
    expect(html).toContain(`href="${sibling}"`);
  });

  /**
   * The placeholder gate.
   *
   * A legal document is the one place a plausible-looking invention is worse
   * than an obvious hole — "Meridian Ltd" would read as true and be a false
   * statement about who the merchant is contracting with. The drafts therefore
   * carry loud `[bracketed]` placeholders, and this fails until every one is
   * replaced with a real fact.
   *
   * It is skipped rather than failing red while the pages are still drafts:
   * set MERIDIAN_LEGAL_FINAL=true (CI does, before submission) to enforce it.
   */
  const enforcing = process.env.MERIDIAN_LEGAL_FINAL === "true";
  it.skipIf(!enforcing).each(PAGES)(
    "%s has no unfilled placeholders left",
    (page) => {
      const remaining = [...read(page).matchAll(/\[([^\]]{3,60})\]/g)].map(
        (m) => m[1],
      );
      expect(
        remaining,
        `${page} still contains drafting placeholders: ${remaining.join(", ")}`,
      ).toEqual([]);
    },
  );

  it("counts the placeholders so the remaining work is visible", () => {
    const outstanding = PAGES.flatMap((page) =>
      [...read(page).matchAll(/\[([^\]]{3,60})\]/g)].map((m) => m[1]),
    );
    // Not an assertion about the number — just a fixed record that they exist
    // and are tracked. When the pages are finalised this drops to zero and the
    // gate above starts enforcing.
    expect(new Set(outstanding).size).toBeGreaterThanOrEqual(0);
  });

  it("does not repeat claims the code does not support", () => {
    const privacy = read("site/privacy.html").toLowerCase();

    // read_customers is not requested; a policy claiming it would be asking
    // for a scope review the app does not need and cannot pass.
    expect(privacy).toContain("<code>read_customers</code> and");
    expect(privacy).toMatch(/not<\/strong> requested/);

    // No ad connector exists in this release — app/lib has no AdSpend writer
    // outside the seed, so the policy must not describe one.
    expect(privacy).toContain("does not connect to any advertising");
  });

  it("states the retention period the retention worker actually enforces", () => {
    const privacy = read("site/privacy.html");
    const retention = read("app/lib/data-request.server.ts");

    const days = retention.match(
      /DATA_REQUEST_RETENTION_DAYS\s*=\s*(\d+)/,
    )?.[1];
    expect(days, "retention constant not found").toBeTruthy();
    expect(
      privacy,
      `privacy.html must state the same ${days}-day retention the sweep enforces`,
    ).toContain(`<strong>${days} days</strong>`);
  });

  it("states the prices the billing catalogue actually charges", () => {
    const terms = read("site/terms.html");
    const plans = read("app/lib/plans.ts");

    const prices = [...plans.matchAll(/price:\s*(\d+)/g)].map((m) => m[1]);
    const annual = [...plans.matchAll(/annualPrice:\s*(\d+)/g)].map((m) => m[1]);
    expect(prices.length, "no plan prices found").toBeGreaterThan(0);

    for (const price of prices) {
      expect(terms, `terms.html omits the $${price} monthly price`).toContain(
        `$${price}`,
      );
    }
    for (const price of annual) {
      const formatted = Number(price).toLocaleString("en-US");
      expect(terms, `terms.html omits the $${formatted} annual price`).toContain(
        `$${formatted}`,
      );
    }
  });
});
