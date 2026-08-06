# Held back from the listing — captured from a store with invented ad spend

These three were part of the six-screenshot listing set until 2026-08-06. They
are not deleted, because nothing is wrong with the screens themselves — only
with the data they were captured against.

## Why

`prisma/seed.ts` used to write `AdSpend` rows for every campaign for every day,
and it was the only writer of that table in the repo. Nothing else can write it:
there is no ad-platform OAuth flow and no platform API client anywhere in the
tree, and `provision.server.ts:97` creates every connector `NOT_CONFIGURED` and
nothing ever configures one.

So the seeded demo store showed ad performance, and every real store shows `—`
and `$0.00` for the life of the install. These screenshots are what the App Store
listing would have shown a merchant deciding whether to install:

| File | What it advertises that the app cannot do |
|---|---|
| `acquisition.png` | Blended CAC $54.56, Paid spend $80.2K, Marketing efficiency 6.50×, Platform over-claim $211.8K, and a channel table giving Facebook, Google and TikTok Ads a spend, a CAC, a claimed-vs-measured ROAS and a **Profitable** verdict |
| `overview.png` | An **Ad spend $80.2K** headline tile, and an Ad spend row in the P&L waterfall |
| `orders.png` | An **ADS** column with a figure on every order (−$112.11 on the first row), and Facebook/Google/TikTok Ads channel filters |

The fix in `plans.ts` and the Acquisition banner stopped the *app* selling this.
It did not reach `listing/`, and `SUBMISSION.md` recorded the problem as closed
anyway. That is the gap this directory exists to close.

## How to bring them back

1. Re-seed: `npm run db:reset`. The seed no longer writes `AdSpend`, so the demo
   store now shows what a real install shows. Campaign and UTM attribution on
   orders is untouched, so channel revenue and contribution profit — the thing
   Starter actually sells — still demo.
2. Re-capture the three screens at 1600×900.
3. Check each one before shipping it: no CAC, no paid spend, no ROAS, no ADS
   column with a non-zero figure.
4. Move the file back into `listing/screenshots/` and delete its row from the
   held list in `app/lib/listing.test.ts`.

The Acquisition screen will now render its "no ad platform is connected" banner,
which is correct — that is what a merchant sees. Whether a screenshot of a screen
whose four headline tiles are all dashes belongs in a listing at all is a
judgement call for Connor. Shopify needs three to six desktop screenshots and the
set is currently at **three**, which is the floor with no headroom, so at least
one of these three has to come back or a new screen has to be captured.

## Do not just restore them

They are only wrong because of the data behind them. Restoring the files without
step 1 puts the same claim back on the listing.
