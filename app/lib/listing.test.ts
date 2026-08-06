import { readFileSync, readdirSync } from "node:fs";
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
 * Lift all of this in the same change that ships a real ad connector, together
 * with the guard in `plan.test.ts`, and not before.
 */

const REPO_ROOT = join(__dirname, "..", "..");

function read(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

describe("listing media and the demo store it is captured from", () => {
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

  it("no shipped listing screenshot is one of the three that sell ad performance", () => {
    // Filenames match the route they were captured from. These two are held out
    // until they are re-captured against a store with no fabricated spend; the
    // other four never showed an ad figure and are untouched.
    const dir = join(REPO_ROOT, "listing", "screenshots");
    const shipped = readdirSync(dir).filter((f) => f.endsWith(".png"));

    for (const stale of ["acquisition.png", "overview.png", "orders.png"]) {
      expect(
        shipped,
        `listing/screenshots/${stale} is back in the shipped set. It was captured ` +
          `from a store with seeded ad spend and shows figures a real merchant ` +
          `never sees. Re-capture it after re-seeding before shipping it.`,
      ).not.toContain(stale);
    }

    // Shopify requires three to six desktop screenshots. Holding two back must
    // not quietly take the listing under the floor.
    expect(
      shipped.length,
      "the listing needs at least three desktop screenshots and is now below that",
    ).toBeGreaterThanOrEqual(3);
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
