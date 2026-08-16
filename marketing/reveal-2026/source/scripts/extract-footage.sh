#!/usr/bin/env bash
# Bake the film grade into deterministic 30fps frame sequences.
# One look across all b-roll: darkened, desaturated, warm highlights —
# the black/amber Meridian night language. Stage swaps JPEGs per SEEK.
set -euo pipefail
cd "$(dirname "$0")/../../raw/footage"
mkdir -p seq

# tag | file | start(s) | dur(s) | brightness offset
CLIPS=(
  "tape|pexels-7205517.mp4|frac0.35|1.4|-0.09"
  "label|pexels-7855154.mp4|frac0.50|1.4|-0.09"
  "scan|pexels-7287306.mp4|frac0.18|1.4|-0.08"
  "silh|pexels-13375774.mp4|frac0.50|1.6|0.03"
  "typewarm|pexels-8774518.mp4|frac0.30|1.6|-0.02"
  "aisle|pexels-7018667.mp4|abs0.4|2.8|-0.03"
  "convey|pexels-10472351.mp4|frac0.25|1.8|-0.05"
  "packdesk|pexels-7287304.mp4|frac0.62|1.6|-0.07"
  "lockdeskA|pexels-36036732.mp4|abs2.5|3.4|-0.02"
  "lockdeskB|pexels-36036732.mp4|abs26.0|1.6|-0.02"
  "topdown|pexels-7272375.mp4|frac0.42|1.6|-0.01"
)

GRADE="eq=contrast=1.07:saturation=0.68:brightness=%s,colorbalance=rh=.05:bh=-.06:rm=.02:bm=-.03"

for entry in "${CLIPS[@]}"; do
  IFS='|' read -r tag file startspec dur bright <<< "$entry"
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$file")
  if [[ $startspec == frac* ]]; then
    start=$(awk "BEGIN { printf \"%.3f\", ${d} * ${startspec#frac} }")
  else
    start="${startspec#abs}"
  fi
  rm -rf "seq/$tag"; mkdir -p "seq/$tag"
  # shellcheck disable=SC2059
  filter="scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,$(printf "$GRADE" "$bright")"
  ffmpeg -y -loglevel error -ss "$start" -t "$dur" -i "$file" -vf "$filter" -qscale:v 3 "seq/$tag/f-%04d.jpg"
  n=$(ls "seq/$tag" | wc -l | tr -d ' ')
  echo "$tag: $n frames from $file @ ${start}s (+${dur}s)"
done
