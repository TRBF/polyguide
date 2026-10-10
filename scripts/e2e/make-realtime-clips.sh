#!/usr/bin/env bash
# Spoken turns and a fake room-sign photo for scripts/e2e/realtime-voice.js (needs espeak-ng, ffmpeg, ImageMagick).
# Written to apps/web/public/__e2e/ (git-ignored) so the dev server serves them to the test page.
set -euo pipefail
out="$(dirname "$0")/../../apps/web/public/__e2e"
mkdir -p "$out"
make_clip() {
  espeak-ng -s 150 -w "$out/tmp.wav" "$2"
  # 1.5 s of silence after each turn, like a person waiting for the answer.
  ffmpeg -loglevel error -y -i "$out/tmp.wav" -af "apad=pad_dur=1.5" -ar 48000 -ac 1 "$out/$1.wav"
}
make_clip rt_lost "I am lost. Where am I? I need to get to the Audimax."
make_clip rt_yes "Yes, that is right."
make_clip rt_which "Which way do I go now?"
rm -f "$out/tmp.wav"
# A corridor wall with a door and an HG-style room plate, as the rear camera would see it.
magick -size 1024x640 gradient:'#d8d4cc-#b9b3a8' -fill '#7a6a55' -draw "rectangle 560,60 900,640" \
  -fill '#2c2c2c' -draw "rectangle 430,250 540,330" -fill white -font DejaVu-Sans-Bold -pointsize 34 -annotate +442+302 'F 33' \
  -fill '#555' -pointsize 14 -annotate +444+322 'Sitzungszimmer' "$out/sign.jpg"
echo "clips in $out"
