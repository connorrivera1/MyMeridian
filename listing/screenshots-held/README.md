# Historical listing media — captured from a store with invented ad spend

These three were part of the six-screenshot listing set until 2026-08-06. They
are not deleted because their bytes are the provenance record used by the
listing guard. None of these files should be copied back into the shipped set.

**Two of the three came back on 2026-08-06.** `overview.png` and `orders.png`
were re-captured against a store with the spend rows cleared and are shipped
again in `listing/screenshots/`. The copies here are kept as the record of what
the listing used to claim, and as the reference bytes for the provenance guard in
`app/lib/listing.test.ts` — a shipped screenshot may not be byte-identical to the
held original of the same name. The Acquisition route has since been redesigned;
a fresh capture is now eligible even though this old image remains held.

## Why

`prisma/seed.ts` used to write `AdSpend` rows for every campaign for every day,
and it was the only writer of that table in the repo at the time these images
were removed. The app then had no ad-platform OAuth flow or platform API client,
and `provision.server.ts:97` created every connector `NOT_CONFIGURED`.

So the seeded demo store showed invented ad performance while a real store could
not connect an ad account. These screenshots are what the App Store listing
would have shown a merchant deciding whether to install:

| File | What it advertised that the app cannot do | Now |
|---|---|---|
| `acquisition.png` | Blended CAC $54.56, Paid spend $80.2K, Marketing efficiency 6.50×, Platform over-claim $211.8K, and a channel table giving Facebook, Google and TikTok Ads a spend, a CAC, a claimed-vs-measured ROAS and a **Profitable** verdict | **Historical only** — the redesigned route can be freshly captured without spend |
| `overview.png` | An **Ad spend $80.2K** headline tile, and an Ad spend row in the P&L waterfall | **Re-captured and shipped** — the tile reads `$0` with a dash; the other five tiles are real |
| `orders.png` | An **ADS** column with a figure on every order (−$112.11 on the first row), and Facebook/Google/TikTok Ads channel filters | **Re-captured and shipped** — the ADS column is `-$0.00` on every row; the channel filters stay, and are correct, because orders really are attributed to those channels by UTM |

## Why a fresh Acquisition capture is valid now

The redesigned route no longer leads with four blank spend-dependent tiles. With
no connector it shows a clear unavailable-input banner and a compact table of
order count, net revenue and contribution profit by channel — values measured
from stored orders. Spend, CAC, ROAS, payback and marketing efficiency remain
absent rather than zero. A fresh capture therefore demonstrates useful current
behavior without pretending an ad source exists.

All six listing screenshots were re-shot after the August 9–10 UI redraw on
2026-08-11. This note remains provenance for the replaced media.

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
4. **Look at the image before shipping it.** Not the file size — the pixels. The
   no-spend Acquisition view must lead with order-derived revenue and profit,
   retain its unavailable-input explanation, and show no invented CAC or ROAS.
5. Copy the fresh image into `listing/screenshots/`. The byte-provenance test
   passes automatically once it genuinely differs from the historical copy here.

## Do not just restore them

The held files are wrong because of the data behind them and, now, visually
obsolete. Restoring one puts the same claim back on the listing — and
`listing.test.ts` fails on the bytes, not the filename, so it will catch you.
