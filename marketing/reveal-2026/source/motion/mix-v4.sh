#!/usr/bin/env bash
# v4 mix: music + synthesized foley only (no VO, no b-roll audio).
# Bed stays whisper-quiet under the chat, arrives with the splash, breathes
# with the build sections, and clears for the brand tone.
set -euo pipefail
cd "$(dirname "$0")"

MUSIC="../../raw/audio/cinematic-technology-581404.mp3"
SFX="../render-cache-v4/sfx.wav"
LOCK="../render-cache-v4/picture-lock.mp4"
MIXWAV="../render-cache-v4/final-mix.wav"
OUT="../../output/mymeridian-reveal-60s-16x9-v4.mp4"

VOL="volume=eval=frame:volume='\
if(lt(t,5.1), 0.20,\
 if(lt(t,6.65), 0.20+(t-5.1)/1.55*0.42,\
  if(lt(t,50.4), 0.62,\
   if(lt(t,53.6), 0.62-(t-50.4)/3.2*0.20,\
    if(lt(t,58.8), 0.42, max(0, 0.42*(1-(t-58.8)/0.95)))))))'"

ffmpeg -y -loglevel error \
  -ss 57.7 -t 60 -i "$MUSIC" \
  -i "$SFX" \
  -filter_complex "\
    [0:a]aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=1.2,${VOL}[music];\
    [1:a]aresample=48000,aformat=channel_layouts=stereo[sfx];\
    [music][sfx]amix=inputs=2:normalize=0,\
    loudnorm=I=-14:TP=-1.5:LRA=11,\
    aresample=48000,atrim=duration=60[mix]" \
  -map "[mix]" -c:a pcm_s16le "$MIXWAV"

ffmpeg -y -loglevel error -i "$LOCK" -i "$MIXWAV" \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 320k -movflags +faststart "$OUT"

ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT"
ffmpeg -i "$OUT" -af 'loudnorm=print_format=summary' -f null - 2>&1 | grep -E 'Input Integrated|Input True Peak'
echo "v4 master -> $OUT"
