import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the surfaces a Shopify reviewer sees *outside* the app.
 *
 * `plan.test.ts` stopped the in-app plan tiers selling ad-platform capability
 * the app does not have. That fix was applied to `plans.ts` and to the
 * Acquisition banner, and `SUBMISSION.md` then recorded the problem as closed —
 * "nothing merchant-visible sells ad spend, CAC or ROAS any more".
 *
 * It was not closed. The listing screenshots are more reviewer-visible than any
 * screen in the app, they are checked into this repo, and three of the six still
 * advertised the missing capability: `acquisition.png` led with Blended CAC
 * $54.56, Paid spend $80.2K, Marketing efficiency 6.50x and a channel table
 * giving Facebook, Google and TikTok Ads a spend, a CAC, a claimed-vs-measured
 * ROAS and a "Profitable" verdict; `overview.png` carried an Ad spend $80.2K
 * headline tile; `orders.png` gave every order an ADS column with a real-looking
 * figure in it (-$112.11 on the first row). On a real store every one of those
 * is a dash or a zero.
 *
 * `products.png` was checked and kept: it names ad spend as one of the costs
 * allocated to a product, which stays true at zero, and every figure on it is
 * computed from orders. `fulfilment.png` and `pricing.png` carry no ad figure.
 *
 * They were captured from the seeded demo store, which was the last thing in the
 * repo still producing the numbers. These tests hold both ends: the seed may not
 * fabricate the data, and the listing may not ship media captured from a store
 * that did.
 *
 * `overview.png` and `orders.png` were re-captured on 2026-08-06 against a store
 * with the spend rows cleared: the Ad spend tile now reads $0 with a dash, and
 * the ADS column is -$0.00 on every row. Both are shipped again. The guard that
 * used to hold them was their *filename*, which a re-capture defeats by
 * definition, so it is now their *bytes* — a shipped screenshot may not be the
 * held original of the same name. Copying a held file back fails the test.
 *
 * The old `acquisition.png` stays in the held directory because its bytes show
 * fabricated spend. The redesigned route now leads with order-derived revenue
 * and contribution profit when spend is absent, so a fresh capture is eligible
 * for the listing; the byte guard below is the only media restriction it needs.
 *
 * Keep the byte-provenance guard while the historical originals remain. A real
 * connector may change the ad-claim boundary in `plan.test.ts`; it must not
 * make an old fabricated screenshot valid again.
 */

const REPO_ROOT = join(__dirname, "..", "..");

function read(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

describe("listing media and the demo store it is captured from", () => {
  it("the landing page uses a complete current capture in every feature card", () => {
    const site = read("site/index.html");
    const styles = read("site/landing.css");
    for (const asset of ["orders", "products", "pricing", "fulfilment"]) {
      expect(site).toContain(`src="assets/${asset}.jpg"`);
    }
    expect(site).not.toContain("product-chart-crop");
    expect(styles).toContain("aspect-ratio: 1800 / 1126");
    expect(styles).toContain("scroll-margin-top: 96px");
  });

  it("keeps the public surface aligned with the app opening and chrome", () => {
    const site = read("site/index.html");
    const styles = read("site/landing.css");
    const legalStyles = read("site/legal.css");

    expect(site).toContain('class="site-splash"');
    expect(site).toContain('class="mark spinning"');
    expect(site).toContain('rel="stylesheet" href="landing.css"');

    // The opening scene: the brand mark at hero scale, turning with the scroll.
    //
    // Two earlier versions of this assertion pinned an implementation and had
    // to be rewritten when the implementation was replaced — first a CSS
    // wireframe, then a WebGL sun. What is actually load-bearing is that the
    // hero opens on the meridian globe, that it is line art rather than a
    // raster, and that its rotation is driven from scroll position, so those
    // are what is checked here.
    expect(site).toContain('id="globe"');
    expect(site).toContain("data-longitude");
    expect(styles).toContain(".globe-meridian");

    const globe = read("site/globe.js");
    expect(globe).toContain("scrollY");
    // Rotation is a cosine sweep of each meridian's width, not a rotateY: a
    // flat SVG spun in 3D collapses edge-on and reappears mirrored.
    expect(globe).toContain("Math.cos");
    expect(globe).toContain('setAttribute("rx"');
    expect(styles).toContain(".mark.spinning .meridian-a");
    expect(styles).toContain("scrollbar-color:");
    expect(styles).toContain("::-webkit-scrollbar-thumb");
    expect(legalStyles).toContain("scrollbar-color:");
    expect(legalStyles).toContain("::-webkit-scrollbar-thumb");
  });

  it("the seed does not fabricate ad spend", () => {
    // `prisma/seed.ts:949` was the only writer of `AdSpend` in the repo. While no
    // connector exists, any row in that table is invented, and the seeded store
    // is not a private fixture — it is the source of the listing screenshots and
    // the target of the reviewer's demo store URL.
    const seed = read("prisma/seed.ts");
    const writes = seed.match(/prisma\.adSpend\.(create|createMany|upsert)/g);
    expect(
      writes,
      "prisma/seed.ts writes AdSpend again — nothing in the repo can produce that " +
        "table on a real store, so seeding it makes the demo store and every " +
        "screenshot taken from it advertise a capability the app does not have",
    ).toBeNull();
  });

  it("no shipped listing screenshot is a held original put back unchanged", () => {
    // The real assertion is provenance, not naming. A screenshot re-captured
    // against a clean store legitimately keeps its filename, so the only thing
    // that separates it from the poisoned original is its bytes. Every held file
    // is the exact image that advertised the missing capability; if one of those
    // byte sequences is in the shipped set, it was copied back rather than
    // re-captured, whatever it is called.
    const shippedDir = join(REPO_ROOT, "listing", "screenshots");
    const heldDir = join(REPO_ROOT, "listing", "screenshots-held");
    const shipped = readdirSync(shippedDir).filter((f) => f.endsWith(".png"));

    const digest = (dir: string, file: string) =>
      createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");

    const heldDigests = new Map(
      readdirSync(heldDir)
        .filter((f) => f.endsWith(".png"))
        .map((f) => [digest(heldDir, f), f] as const),
    );

    for (const file of shipped) {
      const held = heldDigests.get(digest(shippedDir, file));
      expect(
        held,
        `listing/screenshots/${file} is byte-identical to the held original ` +
          `${held}. That image was captured from a store with seeded ad spend and ` +
          `shows figures a real merchant never sees. Clear the spend rows, re-capture ` +
          `it, and check the result before shipping — see listing/screenshots-held/README.md.`,
      ).toBeUndefined();
    }
  });

  it("public copy does not sell unavailable or unenforced analysis", () => {
    const publicCopy = [
      "listing/copy.md",
      "site/index.html",
      "app/root.tsx",
      "app/routes/home.tsx",
      "app/routes/app.products.tsx",
      "app/routes/app.pricing.tsx",
    ]
      .map(read)
      .join("\n")
      .toLowerCase();

    expect(publicCopy).not.toMatch(/loss[- ]leader/);
    expect(publicCopy).not.toMatch(/multi[- ]location|per[- ]location capacity/);
    expect(publicCopy).not.toMatch(/priced by (your )?volume/);
    expect(publicCopy).not.toMatch(/up to [\d,]+ orders|unlimited orders/);
    expect(publicCopy).not.toContain("true net profit");
  });

  it("does not distribute the Fontshare binary whose license forbids font serving", () => {
    const forbidden = [
      "app/fonts/satoshi/Satoshi-Variable.woff2",
      "site/fonts/Satoshi-Variable.woff2",
    ];
    for (const relative of forbidden) {
      expect(
        existsSync(join(REPO_ROOT, relative)),
        `${relative} is governed by the Fontshare FFL, which forbids uploading ` +
          "or serving the font file without prior written consent",
      ).toBe(false);
    }

    const servedSource = [
      "app/root.tsx",
      "app/design/meridian.css",
      "site/index.html",
      "site/landing.css",
    ]
      .map(read)
      .join("\n");
    expect(servedSource).not.toMatch(/Satoshi-Variable|fonts\/satoshi/i);
  });

  it("reviewer instructions unlock the shipped gates without claiming dormant features", () => {
    const copy = read("listing/copy.md");

    expect(copy).toContain("Choose Growth monthly ($149/month)");
    expect(copy).toContain("Pricing and Fulfilment");
    expect(copy).toContain("Customer-lifecycle product classifications");
    expect(copy).toContain("does not request read_customers");
    expect(copy).toContain("ShopPlan.partnerDevelopment");
    expect(copy).toContain("resolveBillingChargeMode");
    expect(copy).not.toContain("MERIDIAN_BILLING_TEST_SHOPS");
    expect(copy).not.toContain("full feature set immediately");
    expect(copy).not.toContain(
      'billingIsTest = process.env.NODE_ENV !== "production"',
    );
  });

  it("merchant screens do not tell the merchant to perform publisher-only setup", () => {
    const merchantScreens = [
      "app/routes/app.layout.tsx",
      "app/routes/app.overview.tsx",
      "app/routes/app.settings.tsx",
    ]
      .map(read)
      .join("\n");

    expect(merchantScreens).not.toContain("shopify.app.toml");
    expect(merchantScreens).not.toContain("npm run shopify:dev");
    expect(merchantScreens).not.toContain("your Partner Dashboard");
  });

  it("the listing keeps at least Shopify's three desktop screenshots", () => {
    // Shopify requires three to six. Holding one back must not quietly take the
    // listing under the floor.
    const shipped = readdirSync(join(REPO_ROOT, "listing", "screenshots")).filter((f) =>
      f.endsWith(".png"),
    );
    expect(
      shipped.length,
      "the listing needs at least three desktop screenshots and is now below that",
    ).toBeGreaterThanOrEqual(3);
    expect(
      shipped.length,
      "Shopify accepts at most six desktop screenshots",
    ).toBeLessThanOrEqual(6);
  });

  it("SUBMISSION.md does not record the ad-accuracy flag as closed while it is open", () => {
    // The specific sentence that was wrong. It is the one Connor would act on
    // when deciding the listing was ready to submit.
    const submission = read("SUBMISSION.md");
    expect(
      submission,
      "SUBMISSION.md claims nothing merchant-visible sells ad performance. The " +
        "listing screenshots are merchant-visible and two of them did.",
    ).not.toContain("anywhere a merchant or a reviewer can see");
  });
});
