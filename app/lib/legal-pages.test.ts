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

/*
 * These live in `public/` rather than `site/` since the app began serving the
 * whole product from one origin: `public/` is what Vite copies into the client
 * build, so this is what makes them publicly reachable at all. `site/` now
 * holds only the landing document, which is inlined into the server bundle by
 * `routes/home.ts`.
 */
const PAGES = ["public/privacy.html", "public/terms.html"] as const;

describe("public legal pages", () => {
  it.each(PAGES)("%s is linked from the landing page footer", (page) => {
    const file = page.replace("public/", "");
    expect(read("site/index.html")).toContain(`href="${file}"`);
  });

  it.each(PAGES)("%s links back to the site and to its sibling", (page) => {
    const html = read(page);
    // The landing page is served at the root now, not as a sibling file.
    expect(html).toContain('href="/"');
    const sibling = page.includes("privacy") ? "terms.html" : "privacy.html";
    expect(html).toContain(`href="${sibling}"`);
    expect(html).toContain('href="/support"');
  });

  it.each(PAGES)("%s has no drafting placeholders", (page) => {
    const html = read(page);
    const remaining = [...html.matchAll(/\[([^\]]{3,60})\]/g)].map(
      (match) => match[1],
    );
    expect(
      remaining,
      `${page} contains reviewer-visible drafting placeholders: ${remaining.join(", ")}`,
    ).toEqual([]);
    expect(html).not.toContain('class="todo"');
  });

  it.each(PAGES)("%s names current public identity while preserving remaining gates", (page) => {
    const html = read(page);
    expect(html).toContain("Last updated 12 August 2026");
    expect(html).not.toContain("Project Kaira");
    expect(html).not.toContain("trykaira.ai");
    expect(html).toContain("mymeridian.io");
    expect(html).toContain("support@mymeridian.io");
    expect(html).not.toContain("have not been selected");
  });

  it("does not repeat claims the code does not support", () => {
    const privacy = read("public/privacy.html").toLowerCase();

    // read_customers is not requested; a policy claiming it would be asking
    // for a scope review the app does not need and cannot pass.
    expect(privacy).toContain(
      "<code>read_customers</code> is <strong>not</strong> requested",
    );
    expect(privacy).toMatch(/not<\/strong> requested/);
    expect(privacy).toContain("<code>read_all_orders</code>");
    expect(privacy).toContain("permission is already approved");
    expect(privacy).toContain("<code>read_reports</code>");
    expect(privacy).toContain(
      "level 2 protected-customer-data approval covering name,",
    );
    expect(privacy).toContain(
      "mymeridian does not query or persist shopper name, address or phone",
    );

    // Provider connections are merchant-controlled, and credentials must be
    // described without implying that Shopify customer records are shared.
    expect(privacy).toContain("meta ads");
    expect(privacy).toContain("encrypted at rest");
    expect(privacy).toContain("currently pre-launch");
    expect(privacy).toContain("fly managed postgres");
  });

  it("states the retention period the retention worker actually enforces", () => {
    const privacy = read("public/privacy.html");
    const retention = read("app/lib/data-request.server.ts");

    const days = retention.match(
      /DATA_REQUEST_RETENTION_DAYS\s*=\s*(\d+)/,
    )?.[1];
    expect(days, "retention constant not found").toBeTruthy();
    expect(
      privacy,
      `public/privacy.html must state the same ${days}-day retention the sweep enforces`,
    ).toContain(`<strong>${days} days</strong>`);
  });

  it("states the prices the billing catalogue actually charges", () => {
    const terms = read("public/terms.html");
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
