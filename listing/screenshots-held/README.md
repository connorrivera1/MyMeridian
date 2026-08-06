# Held back from the listing — captured from a store with invented ad spend

These three were part of the six-screenshot listing set until 2026-08-06. They
are not deleted, because nothing is wrong with the screens themselves — only
with the data they were captured against.

**Two of the three came back on 2026-08-06.** `overview.png` and `orders.png`
were re-captured against a store with the spend rows cleared and are shipped
again in `listing/screenshots/`. The copies here are kept as the record of what
the listing used to claim, and as the reference bytes for the provenance guard in
`app/lib/listing.test.ts` — a shipped screenshot may not be byte-identical to the
held original of the same name. **`acquisition.png` is still held**, for a
different reason than it was; see below.

## Why

`prisma/seed.ts` used to write `AdSpend` rows for every campaign for every day,
and it was the only writer of that table in the repo. Nothing else can write it:
there is no ad-platform OAuth flow and no platform API client anywhere in the
tree, and `provision.server.ts:97` creates every connector `NOT_CONFIGURED` and
nothing ever configures one.

So the seeded demo store showed ad performance, and every real store shows `—`
and `$0.00` for the life of the install. These screenshots are what the App Store
listing would have shown a merchant deciding whether to install:

| File | What it advertised that the app cannot do | Now |
|---|---|---|
| `acquisition.png` | Blended CAC $54.56, Paid spend $80.2K, Marketing efficiency 6.50×, Platform over-claim $211.8K, and a channel table giving Facebook, Google and TikTok Ads a spend, a CAC, a claimed-vs-measured ROAS and a **Profitable** verdict | **Still held** — see *Why acquisition is different* |
| `overview.png` | An **Ad spend $80.2K** headline tile, and an Ad spend row in the P&L waterfall | **Re-captured and shipped** — the tile reads `$0` with a dash; the other five tiles are real |
| `orders.png` | An **ADS** column with a figure on every order (−$112.11 on the first row), and Facebook/Google/TikTok Ads channel filters | **Re-captured and shipped** — the ADS column is `-$0.00` on every row; the channel filters stay, and are correct, because orders really are attributed to those channels by UTM |

## Why acquisition is different now

Re-captured against the cleaned store, `acquisition.png` is **accurate**. It is
also unshippable, which is not the same problem:

- All four headline tiles are blank — Blended CAC `—`, Paid spend `$0`,
  Marketing efficiency `—`, Platform over-claim `$0`. Each one divides by spend.
- The Channels table has a dash under SPEND, CAC, LTV:CAC and ROAS · CLAIMED for
  every row, and every VERDICT chip reads **No spend**.
- The "No ad spend has reached Meridian for this period" banner renders, which is
  correct and is what a merchant sees.

The parts of that screen that do work — new customers, 1st order net, 90-day
value per channel — are real and computed from the merchant's own orders, but
they sit beside eleven columns of dashes and do not carry the image. Bring it
back in the same change that ships a connector.

## How to bring a held screenshot back

1. **Clear the invented spend.** `npm run db:reset` is the documented route, but
   Prisma refuses to run a migrate reset for an AI agent without Connor's explicit
   consent, and it drops the whole database to fix one table. The surgical
   equivalent, which is what was actually run on 2026-08-06:
   delete every `AdSpend` row, then re-run the same engine tail `prisma/seed.ts`
   runs — `recomputeShopProfitability(shopId)` followed by
   `generatePricingRecommendations(shopId)`. That second step matters: per-order
   ad cost is **persisted** in `Order.adCostAttributed`, so deleting the spend
   rows alone leaves the ADS column showing the old figures.
   Verify with `select count(*) from "AdSpend"` and
   `select count(*) from "Order" where "adCostAttributed" <> 0` — both must be 0.
2. **Start the app**: `npm run dev`, then check `http://localhost:3000/app`
   returns 200. `MERIDIAN_DEMO_MODE=true` in `.env` is what makes the `/app`
   routes reachable without a Shopify session.
3. **Capture at 1600×900.** `/Applications/Google Chrome.app` exits headless on
   this machine without writing a file. Playwright's headless shell is already on
   disk and works:

   ```sh
   CHS=~/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell
   "$CHS" --disable-gpu --no-sandbox --hide-scrollbars --force-color-profile=srgb \
     --window-size=1600,900 --virtual-time-budget=8000 \
     --screenshot=/tmp/overview.png http://localhost:3000/app
   ```

   Routes: `/app` is overview (it is the index child), `/app/orders`,
   `/app/acquisition`.
4. **Look at the image before shipping it.** Not the file size — the pixels. No
   CAC, no paid spend, no ROAS, no ADS column with a non-zero figure, and no
   screen that is mostly dashes.
5. Copy it into `listing/screenshots/` and drop its row from the held list in
   `app/lib/listing.test.ts`. The byte-provenance test passes automatically once
   the file genuinely differs from the copy here.

## Do not just restore them

They are only wrong because of the data behind them. Restoring a file without
step 1 puts the same claim back on the listing — and `listing.test.ts` now fails
on the bytes, not the filename, so it will catch you.
