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
 * `acquisition.png` stays held, and not because it is false any more. It is
 * accurate and it is unshippable: with no spend, all four headline tiles are
 * blank and the channel table is dashes under SPEND, CAC, LTV:CAC and ROAS with
 * "No spend" as every verdict. Re-capture it when a connector ships.
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

  it("acquisition.png stays held while there is no ad connector", () => {
    // This one is not held for being false — re-captured against a clean store it
    // is accurate. It is held for being empty: four blank headline tiles and a
    // channel table whose spend, CAC, LTV:CAC and ROAS columns are all dashes.
    // Accurate and unshippable are different problems with the same fix.
    const shipped = readdirSync(join(REPO_ROOT, "listing", "screenshots"));
    expect(
      shipped,
      "acquisition.png is in the shipped set. With no ad connector its four " +
        "headline tiles are blank and every channel verdict reads 'No spend'. " +
        "Ship it in the same change that ships a connector.",
    ).not.toContain("acquisition.png");
    expect(
      existsSync(join(REPO_ROOT, "listing", "screenshots-held", "acquisition.png")),
      "the held acquisition.png is gone — it is the record of what the listing " +
        "claimed, and the byte-provenance guard above needs it",
    ).toBe(true);
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
