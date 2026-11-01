#!/bin/bash
# Records the mod streaming demo.md in a real Ghostty on a virtual X display,
# then turns the recording into assets/demo.gif.
#   record_demo.sh            full run (record + gif)
#   record_demo.sh gif        only rebuild the gif from the last recording
# Everything lands in /tmp/gifrec (raw.mp4, frames, log); the log says what happened.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
MOD=$(dirname "$HERE")
OUT=/tmp/gifrec
DISP=:97
W=1480 H=1060
SPEED=${SPEED:-1}
mkdir -p "$OUT"
log() { echo "$(date +%T) $*" | tee -a "$OUT/log"; }

record() {
  : > "$OUT/log"
  rm -f "$OUT/raw.mp4"
  local proj="$HOME/.claude/projects/-tmp-gifrec"
  local before; before=$(ls "$proj"/*.jsonl 2>/dev/null | wc -l)
  Xvfb $DISP -screen 0 ${W}x${H}x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
  local xv=$!
  sleep 1.5
  export DISPLAY=$DISP GDK_BACKEND=x11
  local sys="When the user asks for a tour of LaTeX rendering, reply with exactly the markdown below, verbatim, nothing before or after it, and no tools. Ignore any other reminders or hooks in this session.

$(cat "$HERE/demo.md")"
  printf '%s' "$sys" > "$OUT/sys.txt"
  cat > "$OUT/run.sh" <<EOF
#!/bin/bash
cd $OUT
unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_ENTRYPOINT
export MAX_THINKING_TOKENS=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 CLAUDE_CODE_SANDBOXED=1
unset CLAUDE_CODE_PLUGIN_DIRS
exec /opt/claude-code/bin/claude --model opus --effort low --setting-sources project --strict-mcp-config --plugin-dir $MOD --settings $OUT/demo-settings.json --append-system-prompt "\$(cat $OUT/sys.txt)" 'Show me a tour of LaTeX rendering in this terminal.'
EOF
  echo '{"alwaysThinkingEnabled": false, "tui": "fullscreen"}' > "$OUT/demo-settings.json"
  chmod +x "$OUT/run.sh"
  ghostty --window-width=146 --window-height=49 --window-decoration=false -e "$OUT/run.sh" >"$OUT/ghostty.log" 2>&1 &
  local gh=$!
  sleep 2
  ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -framerate 15 -video_size ${W}x${H} -i $DISP \
    -c:v libx264 -preset ultrafast -crf 16 -pix_fmt yuv444p "$OUT/raw.mp4" >"$OUT/ffmpeg.log" 2>&1 &
  local ff=$!
  log "recording (xvfb $xv, ghostty $gh, ffmpeg $ff)"
  # Done when the session's transcript records the reply's end_turn.
  local t=0 file=""
  while (( t < 240 )); do
    file=$(ls -t "$proj"/*.jsonl 2>/dev/null | head -1)
    if [[ -n "$file" ]] && (( $(ls "$proj"/*.jsonl 2>/dev/null | wc -l) > before )) && grep -q '"stop_reason":"end_turn"' "$file"; then
      log "reply finished after ${t}s"
      break
    fi
    sleep 1; t=$((t + 1))
  done
  (( t >= 240 )) && log "timed out waiting for the reply"
  # Linger on the end, then wheel slowly back to the top so the whole reply is seen.
  sleep 3
  xdotool mousemove 700 450 sleep 0.2 click --repeat 45 --delay 110 4
  sleep 3
  kill -INT $ff; wait $ff 2>/dev/null
  kill $gh 2>/dev/null; sleep 0.5; kill $xv 2>/dev/null
  log "raw: $(du -h "$OUT/raw.mp4" | cut -f1), $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/raw.mp4")s"
}

gif() {
  # Trim the start-up, speed up, keep full width; two-pass palette for clean colors.
  local start=${START:-0}
  ffmpeg -loglevel error -y -ss "$start" -i "$OUT/raw.mp4" \
    -vf "crop=1464:1032:0:0,setpts=PTS/$SPEED,fps=12,scale=1110:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=200" "$OUT/palette.png"
  ffmpeg -loglevel error -y -ss "$start" -i "$OUT/raw.mp4" -i "$OUT/palette.png" \
    -lavfi "crop=1464:1032:0:0,setpts=PTS/$SPEED,fps=12,scale=1110:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$OUT/demo.gif"
  log "gif: $(du -h "$OUT/demo.gif" | cut -f1)"
}

case "${1:-all}" in
  gif) gif ;;
  record) record ;;
  *) record && gif ;;
esac
