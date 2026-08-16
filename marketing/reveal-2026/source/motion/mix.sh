#!/usr/bin/env bash
# Final audio mix + master mux for the MyMeridian reveal.
#
# Music: "Cinematic Technology" by SoundGalleryByDmitryTaras (Pixabay #581404,
# Pixabay Content License — free commercial use, no attribution required).
# Window 57.7–117.7s so the track's arrival step lands on the splash
# push-through at 6.5s. Volume automation keeps the open restrained, lifts
# through the product tour, and clears room for the brand tone at the end.
# SFX stem is synthesized, sample-locked to the same timeline markers.
set -euo pipefail
cd "$(dirname "$0")"

MUSIC="../../raw/audio/cinematic-technology-581404.mp3"
SFX="../render-cache-v2/sfx.wav"
LOCK="../render-cache-v2/picture-lock.mp4"
OUT="../../output/mymeridian-reveal-60s-16x9-v2.mp4"
MIXWAV="../render-cache-v2/final-mix.wav"

# volume automation: t is output time (seconds)
VOL="volume=eval=frame:volume='\
if(lt(t,4.5), 0.40,\
 if(lt(t,6.3), 0.40+(t-4.5)/1.8*0.26,\
  if(lt(t,38), 0.66,\
   if(lt(t,47.6), 0.66+(t-38)/9.6*0.12,\
    if(lt(t,55.2), 0.78,\
     if(lt(t,56.6), 0.78-(t-55.2)/1.4*0.30,\
      if(lt(t,58.6), 0.48, max(0, 0.48*(1-(t-58.6)/1.1)))))))))'"

ffmpeg -y -loglevel error \
  -ss 57.7 -t 60 -i "$MUSIC" \
  -i "$SFX" \
  -filter_complex "\
    [0:a]aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.9,${VOL}[music];\
    [1:a]aresample=48000,aformat=channel_layouts=stereo[sfx];\
    [music][sfx]amix=inputs=2:normalize=0,\
    loudnorm=I=-14:TP=-1.5:LRA=11,\
    aresample=48000,atrim=duration=60[mix]" \
  -map "[mix]" -c:a pcm_s16le "$MIXWAV"

ffmpeg -y -loglevel error \
  -i "$LOCK" -i "$MIXWAV" \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 320k -movflags +faststart \
  "$OUT"

ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT"
ffmpeg -i "$OUT" -af 'loudnorm=print_format=summary' -f null - 2>&1 | grep -E 'Input Integrated|Input True Peak'
echo "master -> $OUT"
