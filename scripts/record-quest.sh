#!/usr/bin/env bash
# Record what the Quest 2 wearer sees (passthrough included) as a ready-to-edit video.
#
# The headset's built-in recorder blacks out passthrough; scrcpy mirrors the real display.
# This captures the middle of the right eye (4:3), fixes the vertical stretch in Quest
# captures, and trims any blank stretch at the start.
#
# Needs: brew install scrcpy ffmpeg && brew install --cask android-platform-tools
# Usage: scripts/record-quest.sh [seconds]    (default 120; Ctrl+C stops early)

set -uo pipefail

LIMIT=${1:-120}
OUT_DIR=${OUT_DIR:-$HOME/Desktop}
STAMP=$(date +%Y%m%d-%H%M%S)
RAW="$OUT_DIR/.quest-$STAMP-raw.mp4"
LOG="$OUT_DIR/.quest-$STAMP-scrcpy.log"
OUT="$OUT_DIR/quest-$STAMP.mp4"

# Right-eye 4:3 box inside the lens area, in the 10992x8000 space scrcpy captures.
CROP=4400:4592:6192:1648
# The Quest reports a 10992x8000 display for its 3664x1920 panel, so captures come out
# 1.39x too tall; scaling to a true 4:3 undoes that.
FIX="scale=1280:960:flags=lanczos,setsar=1"
# Uncapped capture size once deadlocked the headset's memory and rebooted it.
MIN_FREE_MB=600

if [ "$(adb get-state 2>/dev/null)" != "device" ]; then
  echo "Quest not found over USB. Plug it in and accept the USB debugging prompt in the headset."
  exit 1
fi

restore_sensor() { adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable >/dev/null 2>&1; }
trap restore_sensor EXIT
# Keep the display on while the headset is off your head. scrcpy gets no frames at all if
# it connects while the headset is asleep or has only just woken, so let it settle first.
adb shell am broadcast -a com.oculus.vrpowermanager.prox_close >/dev/null
echo "Waking the headset..."
sleep 10

start_capture() {
  scrcpy --crop="$CROP" --max-size=1280 --max-fps=30 --video-bit-rate=8M --time-limit="$LIMIT" \
    --no-audio --no-control --record="$RAW" \
    --window-title="Quest recording (Ctrl+C in terminal to stop)" >"$LOG" 2>&1 &
  PID=$!
}

# scrcpy writes the file header only when the first frame arrives (its log is buffered,
# so it can't tell us in time).
frames_arriving() {
  for _ in $(seq 1 20); do
    [ -s "$RAW" ] && return 0
    kill -0 "$PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

stop_capture() { kill -INT "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }

# Ctrl+C reaches scrcpy directly (it finalizes the file); keep this script alive to post-process.
trap 'echo " stopping..."' INT

start_capture
if ! frames_arriving; then
  echo "No frames from the headset yet, restarting the capture..."
  stop_capture
  rm -f "$RAW"
  start_capture
  if ! frames_arriving; then
    stop_capture
    echo "Still no frames from the headset. scrcpy's log: $LOG"
    exit 1
  fi
fi
echo "Recording for up to ${LIMIT}s. Put the headset on; Ctrl+C here stops early."

while kill -0 "$PID" 2>/dev/null; do
  free=$(adb shell "grep MemAvailable /proc/meminfo" 2>/dev/null | awk '{print int($2/1024)}')
  if [ -n "$free" ] && [ "$free" -lt "$MIN_FREE_MB" ]; then
    echo "Headset memory low (${free} MB), stopping to avoid a crash."
    kill -INT "$PID" 2>/dev/null
  fi
  sleep 3
done
wait "$PID" 2>/dev/null

if [ ! -s "$RAW" ]; then
  echo "Nothing was recorded. scrcpy's log: $LOG"
  exit 1
fi

# The stream can show black until the first real frames arrive; start the output after that.
start=$(ffmpeg -hide_banner -i "$RAW" -vf "blackdetect=d=0.5:pix_th=0.08" -an -f null - 2>&1 |
  awk -F'black_end:' '/black_start:0 /{split($2, a, " "); print a[1]; exit}')

if ffmpeg -v error -y ${start:+-ss "$start"} -i "$RAW" -vf "$FIX" -c:v libx264 -crf 18 -preset medium \
  -pix_fmt yuv420p -movflags +faststart -an "$OUT"; then
  rm -f "$RAW" "$LOG"
  echo "Saved $OUT"
else
  echo "Post-processing failed; the unprocessed recording is at $RAW"
  exit 1
fi
