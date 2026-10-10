#!/usr/bin/env bash
# Spoken commands for scripts/e2e/whisper-voice.js, synthesised with espeak-ng (needs espeak-ng + ffmpeg).
# Written to apps/web/public/__e2e/ (git-ignored) so the dev server serves them to the test page.
set -euo pipefail
out="$(dirname "$0")/../../apps/web/public/__e2e"
mkdir -p "$out"
make_clip() {
  espeak-ng -s 140 -w "$out/tmp.wav" "$2"
  # 1 s of silence after each command, like a person pausing.
  ffmpeg -loglevel error -y -i "$out/tmp.wav" -af "apad=pad_dur=1" -ar 48000 -ac 1 "$out/$1.wav"
}
make_clip blind "I am blind"
make_clip next "next"
make_clip k30 "k 30"
make_clip number1 "number one"
make_clip audimax "the audimax"
make_clip start "start"
rm -f "$out/tmp.wav"
echo "clips in $out"
