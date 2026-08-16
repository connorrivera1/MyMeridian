#!/usr/bin/env bash
# v3 mix: synthetic VO on top, licensed bed ducked under it via sidechain,
# synthesized foley, and the conveyor clip's own licensed ambience.
# Master: -14 LUFS / -1.5 dBTP target, mux onto the v3 picture lock.
set -euo pipefail
cd "$(dirname "$0")"

VOD="../../raw/audio/vo"
MUSIC="../../raw/audio/cinematic-technology-581404.mp3"
SFX="../render-cache-v3/sfx.wav"
AMB_SRC="../../raw/footage/pexels-10472351.mp4"
LOCK="../render-cache-v3/picture-lock.mp4"
MIXWAV="../render-cache-v3/final-mix.wav"
OUT="../../output/mymeridian-reveal-60s-16x9-v3.mp4"

# VO schedule (line index -> start ms), from film-v3.js
declare -a T=(550 2550 6700 7900 11600 15500 22000 25950 29800 38100 43300 55300)

INPUTS=(-i "$MUSIC" -i "$SFX" -ss 2.09 -t 1.05 -i "$AMB_SRC")
FC=""
VOMIX=""
for i in $(seq 0 11); do
  INPUTS+=(-i "$VOD/line-$(printf '%02d' "$i").wav")
  idx=$((i + 3))
  FC+="[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=85,adelay=${T[$i]}|${T[$i]}[v${i}];"
  VOMIX+="[v${i}]"
done
FC+="${VOMIX}amix=inputs=12:normalize=0,volume=1.9,asplit=2[vo][voSC];"

# music: window + base automation, then duck against the VO bus
VOL="volume=eval=frame:volume='\
if(lt(t,4.9), 0.34,\
 if(lt(t,6.5), 0.34+(t-4.9)/1.6*0.26,\
  if(lt(t,50.4), 0.60,\
   if(lt(t,52.4), 0.60-(t-50.4)/2.0*0.18,\
    if(lt(t,58.8), 0.42, max(0, 0.42*(1-(t-58.8)/0.95)))))))'"
FC+="[0:a]atrim=start=57.7:end=117.7,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.9,${VOL}[mus];"
FC+="[mus][voSC]sidechaincompress=threshold=0.022:ratio=7:attack=28:release=430:makeup=1[musD];"

# foley + conveyor ambience
FC+="[1:a]aresample=48000,aformat=channel_layouts=stereo[fol];"
FC+="[2:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.32,afade=t=in:st=0:d=0.18,afade=t=out:st=0.85:d=0.2,adelay=35400|35400[amb];"

FC+="[musD][vo][fol][amb]amix=inputs=4:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,atrim=duration=60[mix]"

ffmpeg -y -loglevel error "${INPUTS[@]}" -filter_complex "$FC" -map "[mix]" -c:a pcm_s16le "$MIXWAV"

ffmpeg -y -loglevel error -i "$LOCK" -i "$MIXWAV" \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 320k -movflags +faststart "$OUT"

ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT"
ffmpeg -i "$OUT" -af 'loudnorm=print_format=summary' -f null - 2>&1 | grep -E 'Input Integrated|Input True Peak'
echo "v3 master -> $OUT"
