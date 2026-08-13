#!/usr/bin/env bash
# Deterministic 60-second MyMeridian reveal renderer.
# Builds only from captured MyMeridian browser pixels and title cards rendered
# in the app's loaded type system. No generated UI, chart, number, or footage.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
raw="$project_root/raw"
assets="$project_root/source/assets"
cache="$project_root/source/render-cache"
output="$project_root/output"
mkdir -p "$cache" "$output"

still_clip() {
  local source_image="$1"
  local frames="$2"
  local name="$3"
  local maximum_zoom="$4"
  local fade_out
  fade_out="$(awk "BEGIN { printf \"%.4f\", (${frames}/60)-0.17 }")"
  ffmpeg -hide_banner -loglevel error -y \
    -loop 1 -framerate 1 -t 1 -i "$source_image" \
    -vf "scale=2040:1148:force_original_aspect_ratio=increase,crop=2040:1148,zoompan=z='min(zoom+0.00025,${maximum_zoom})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=60,fade=t=in:st=0:d=0.17,fade=t=out:st=${fade_out}:d=0.17,format=yuv420p" \
    -frames:v "$frames" -an -c:v libx264 -preset slow -crf 15 -pix_fmt yuv420p \
    "$cache/${name}.mp4"
}

video_clip() {
  local source_video="$1"
  local frames="$2"
  local name="$3"
  local duration
  duration="$(awk "BEGIN { printf \"%.4f\", ${frames}/60 }")"
  local fade_out
  fade_out="$(awk "BEGIN { printf \"%.4f\", (${frames}/60)-0.17 }")"
  ffmpeg -hide_banner -loglevel error -y -i "$source_video" -t "$duration" \
    -vf "fps=60,scale=1920:1080,fade=t=in:st=0:d=0.17,fade=t=out:st=${fade_out}:d=0.17,format=yuv420p" \
    -an -c:v libx264 -preset slow -crf 15 -pix_fmt yuv420p "$cache/${name}.mp4"
}

# 00:00–00:01 black, then the exact captured app splash moves us into product.
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=black:s=1920x1080:r=60:d=1" \
  -an -c:v libx264 -preset slow -crf 15 -pix_fmt yuv420p "$cache/00-black.mp4"
still_clip "$assets/title-intro-sold.png" 120 "01-sold" 1.015
still_clip "$assets/title-intro-kept.png" 100 "02-kept" 1.015
video_clip "$raw/recordings/app-overview-dark.mp4" 120 "03-real-splash"
still_clip "$assets/title-meet.png" 90 "04-meet" 1.015
still_clip "$raw/stills/app-overview-dark-1920x1080.png" 130 "05-overview" 1.050
still_clip "$raw/stills/app-overview-money-bridge-dark-1920x1080.png" 130 "06-money-bridge" 1.045
still_clip "$assets/title-dollars.png" 70 "07-dollars" 1.015
still_clip "$raw/stills/app-overview-dark-1920x1080.png" 80 "08-overview-return" 1.040

# Profit per order: headline count, field, then the selected real loss receipt.
still_clip "$raw/stills/app-orders-dark-1920x1080.png" 100 "09-orders" 1.055
still_clip "$raw/stills/app-orders-field-dark-1920x1080.png" 100 "10-order-field" 1.060
still_clip "$raw/stills/app-orders-losing-order-13123-dark-1920x1080.png" 130 "11-order-drawer" 1.055
still_clip "$assets/title-loss.png" 90 "12-loss-title" 1.015
still_clip "$raw/stills/app-orders-field-dark-1920x1080.png" 60 "13-order-field-return" 1.045
still_clip "$raw/stills/app-orders-losing-order-13123-dark-1920x1080.png" 60 "14-order-drawer-return" 1.035

# Products and acquisition use the current seed state without inventing spend.
still_clip "$raw/stills/app-products-dark-1920x1080.png" 100 "15-products" 1.045
still_clip "$raw/stills/app-products-bleeding-dark-1920x1080.png" 100 "16-products-bleeding" 1.050
still_clip "$assets/title-products.png" 60 "17-products-title" 1.012
still_clip "$raw/stills/app-settings-ad-connections-dark-1920x1080.png" 70 "18-connections" 1.040
still_clip "$raw/stills/app-acquisition-channels-dark-1920x1080.png" 120 "19-acquisition" 1.045
still_clip "$assets/title-channels.png" 50 "20-channels-title" 1.012

# Pricing is explicitly labelled as modeled; three controlled passes emphasize
# the actual $65.00 → $66.99, +$5, High-confidence recommendation.
still_clip "$raw/stills/app-pricing-dark-1920x1080.png" 120 "21-pricing-a" 1.060
still_clip "$raw/stills/app-pricing-dark-1920x1080.png" 120 "22-pricing-b" 1.115
still_clip "$assets/title-pricing.png" 100 "23-pricing-title" 1.012
still_clip "$raw/stills/app-pricing-dark-1920x1080.png" 140 "24-pricing-c" 1.070

# Fulfilment is the real seeded 629-waiting / 14-of-14-days-capacity warning.
still_clip "$raw/stills/app-fulfilment-dark-1920x1080.png" 180 "25-fulfilment-a" 1.055
still_clip "$assets/title-fulfilment.png" 70 "26-fulfilment-title" 1.012
still_clip "$raw/stills/app-fulfilment-dark-1920x1080.png" 150 "27-fulfilment-b" 1.085

# 00:49–00:55 Action Center: present current evidence, not fabricated cards.
still_clip "$assets/title-action.png" 120 "28-action-title" 1.012
still_clip "$raw/stills/app-overview-dark-1920x1080.png" 120 "29-action-overview" 1.060
still_clip "$raw/stills/app-orders-dark-1920x1080.png" 120 "30-action-loss" 1.055
still_clip "$raw/stills/app-pricing-dark-1920x1080.png" 60 "31-action-pricing" 1.065
still_clip "$raw/stills/app-fulfilment-dark-1920x1080.png" 60 "32-action-fulfilment" 1.065

# Resolve with the exact app splash animation and a held, real splash frame.
video_clip "$raw/recordings/app-overview-dark.mp4" 90 "33-final-splash"
still_clip "$assets/title-final-with-splash.png" 210 "34-final-card" 1.010

concat_list="$cache/concat.txt"
{
  for segment in \
    00-black 01-sold 02-kept 03-real-splash 04-meet 05-overview 06-money-bridge 07-dollars 08-overview-return \
    09-orders 10-order-field 11-order-drawer 12-loss-title 13-order-field-return 14-order-drawer-return \
    15-products 16-products-bleeding 17-products-title 18-connections 19-acquisition 20-channels-title \
    21-pricing-a 22-pricing-b 23-pricing-title 24-pricing-c 25-fulfilment-a 26-fulfilment-title 27-fulfilment-b \
    28-action-title 29-action-overview 30-action-loss 31-action-pricing 32-action-fulfilment 33-final-splash 34-final-card
  do
    printf "file '%s/%s.mp4'\\n" "$cache" "$segment"
  done
} > "$concat_list"

# Original procedural sound design only — low hits, subtle UI pings, and a
# final brand tone. No music is substituted for a licensed Artlist selection.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=54:sample_rate=48000:duration=0.34" \
  -f lavfi -i "sine=frequency=94:sample_rate=48000:duration=0.18" \
  -f lavfi -i "sine=frequency=760:sample_rate=48000:duration=0.07" \
  -filter_complex "[0:a]volume=0.26,afade=t=out:st=0.02:d=0.32,asplit=8[h0][h1][h2][h3][h4][h5][h6][h7];[1:a]volume=0.12,afade=t=out:st=0.01:d=0.17,asplit=4[l0][l1][l2][l3];[2:a]volume=0.09,afade=t=out:st=0.01:d=0.06,asplit=8[p0][p1][p2][p3][p4][p5][p6][p7];[h0]adelay=4700|4700[a0];[h1]adelay=15000|15000[a1];[h2]adelay=20500|20500[a2];[h3]adelay=28300|28300[a3];[h4]adelay=32300|32300[a4];[h5]adelay=40300|40300[a5];[h6]adelay=49000|49000[a6];[h7]adelay=55000|55000[a7];[l0]adelay=11800|11800[b0];[l1]adelay=22500|22500[b1];[l2]adelay=38200|38200[b2];[l3]adelay=46800|46800[b3];[p0]adelay=3150|3150[c0];[p1]adelay=8200|8200[c1];[p2]adelay=16700|16700[c2];[p3]adelay=24000|24000[c3];[p4]adelay=29500|29500[c4];[p5]adelay=36500|36500[c5];[p6]adelay=44400|44400[c6];[p7]adelay=56500|56500[c7];[a0][a1][a2][a3][a4][a5][a6][a7][b0][b1][b2][b3][c0][c1][c2][c3][c4][c5][c6][c7]amix=inputs=20:normalize=0,apad=pad_dur=60,atrim=duration=60,alimiter=limit=0.78[sfx]" \
  -map "[sfx]" -c:a pcm_s16le "$output/mymeridian-reveal-procedural-sfx.wav"

ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$concat_list" \
  -i "$output/mymeridian-reveal-procedural-sfx.wav" \
  -map 0:v:0 -map 1:a:0 -r 60 -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p \
  -c:a aac -b:a 256k -movflags +faststart "$output/mymeridian-reveal-60s-16x9.mp4"

ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$output/mymeridian-reveal-60s-16x9.mp4"
