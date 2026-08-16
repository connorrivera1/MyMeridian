# Sections not captured / values that differ from the brief

Nothing in the film is faked; where the brief's example values no longer exist
in the seeded demo, the real values were used instead. Differences and gaps:

1. **Pricing example.** The brief's "$349 → $435.99, +$2,042/mo" does not exist
   in the current seed. The real top recommendation is
   **Headlamp Pro 800: $65.00 → $66.99 (▲3%), +$5/mo, confidence High,
   e = −1.86** — that is what the film shows, alongside the page's own
   "Modelled from price history observed after install" subtitle, the method
   note, and an added on-screen caption: "A modelled recommendation from
   observed price history — not a guarantee." If a bigger, still-honest demo
   rec is wanted for future ads, the seed needs richer price history first.

2. **"$7,928 lost across 383 orders."** Exists and is used — it lives on the
   Profit-per-order page header ("383 · 12.5% of orders · −$7,928 before paid
   marketing"), not on an Action Center card. The Action Center's real cards
   ("164 orders lost contribution / $4,456", "Backlog exceeds your shipping
   promise / 755 projected", "Clearance Water Bottle is losing money /
   $1,754", "Profit data is partial") are shown as they are.

3. **Ad spend numbers.** The demo store's Meta/Google/TikTok connectors show
   **Connected** but no ad-spend sync has completed, so Spend/CAC/ROAS render
   as "—" by design (Meridian refuses to invent spend). The film therefore
   shows channel net revenue + contribution and the Connections screen, and
   avoids claiming measured ad spend. A future ad could re-capture after a
   seeded ad-spend sync.

4. **Fulfilment backlog animation.** The page's stat sparkline is a static
   SVG once rendered; the film animates it with a deterministic wipe-on of the
   real chart pixels rather than re-rendering the chart. The "14 of the next
   14 days exceed capacity — In 1 day" warning is the real seeded state.

5. **Light mode.** The primary film is the dark visual language per the brief.
   Light-mode source captures are in `raw/stills-light/` for future ads
   (captured after fixing a hydration race that silently reverted the theme).

6. **Landing page scroll story.** Captured by the earlier pass
   (`raw/stills/landing-hero…`, `raw/recordings/landing-splash-dark.mp4`) but
   not used in the 60s structure beyond the splash, which the film rebuilds
   from the landing's own markup/CSS and scrubs frame-exactly.
