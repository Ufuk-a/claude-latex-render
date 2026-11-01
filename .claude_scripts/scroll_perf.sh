#!/bin/bash
# Measures scrolling cost: resumes a math-heavy transcript in a real Ghostty on a
# virtual X display, wheels up and down, and reports CPU seconds burnt by the
# claude process and by Ghostty, plus the mod's per-hook render time.
#   scroll_perf.sh <transcript.jsonl>          with the mod
#   NOMOD=1 scroll_perf.sh <transcript.jsonl>  same, without it (control)
# Output in /tmp/scrollperf (log, screenshots); the last lines are the result.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
MOD=${MOD:-$(dirname "$HERE")}
SRC=$1
OUT=/tmp/scrollperf
DISP=:96
W=1480 H=1060
CLICKS=${CLICKS:-80}
mkdir -p "$OUT"
log() { echo "$(date +%T) $*" | tee -a "$OUT/log"; }
ticks() { awk '{print $14+$15}' "/proc/$1/stat" 2>/dev/null || echo 0; }

id=$(cat /proc/sys/kernel/random/uuid)
proj="$HOME/.claude/projects/-tmp-scrollperf"
mkdir -p "$proj"
sed "s#\"cwd\":\"[^\"]*\"#\"cwd\":\"$OUT\"#g; s#$(basename "$SRC" .jsonl)#$id#g" "$SRC" > "$proj/$id.jsonl"
gio trash -f /tmp/latex-render-perf.json 2>/dev/null

Xvfb $DISP -screen 0 ${W}x${H}x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
xv=$!
sleep 1.5
export DISPLAY=$DISP GDK_BACKEND=x11
plug="--plugin-dir $MOD"
[[ -n "${NOMOD:-}" ]] && plug=""
cat > "$OUT/run.sh" <<EOF
#!/bin/bash
cd $OUT
unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_PLUGIN_DIRS
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 CLAUDE_CODE_SANDBOXED=1 LATEX_RENDER_PERF=1
exec /opt/claude-code/bin/claude --setting-sources project --strict-mcp-config $plug --settings $OUT/settings.json --resume $id
EOF
echo '{"tui": "fullscreen"}' > "$OUT/settings.json"
chmod +x "$OUT/run.sh"
ghostty --window-width=146 --window-height=49 --window-decoration=false -e "$OUT/run.sh" >"$OUT/ghostty.log" 2>&1 &
gh=$!
sleep "${SETTLE:-25}"
cl=$(pgrep -f "^/opt/claude-code/bin/claude .*--resume $id" | head -1)
log "ghostty $gh claude ${cl:-none} (NOMOD=${NOMOD:-})"
import -window root "$OUT/before.png" 2>/dev/null
xdotool mousemove 700 450
# Wheel up into the region to measure (PRE clicks, unmeasured), let it settle.
xdotool click --repeat "${PRE:-0}" --delay 5 4
sleep 4
import -window root "$OUT/region.png" 2>/dev/null
# SHOTS=N: step down STEP clicks at a time, a screenshot after each (to diff two builds).
if [[ -n "${SHOTS:-}" ]]; then
  mkdir -p "$OUT/shots-${TAG:-x}"
  for k in $(seq -w 1 "$SHOTS"); do
    xdotool click --repeat "${STEP:-4}" --delay 250 5
    sleep 1.2
    import -window root "$OUT/shots-${TAG:-x}/$k.png" 2>/dev/null
  done
  kill "$gh" 2>/dev/null; sleep 0.5; kill "$xv" 2>/dev/null
  log "shots in $OUT/shots-${TAG:-x}"
  exit 0
fi
# VIDEO=1: record the scroll at 30 fps (for blank_frames.py).
[[ -n "${VIDEO:-}" ]] && { ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -framerate 30 -video_size ${W}x${H} -i $DISP -c:v libx264 -preset ultrafast -crf 10 "$OUT/scroll-${TAG:-x}.mp4" & ff=$!; sleep 0.5; }
c0=$(ticks "$cl"); g0=$(ticks "$gh"); t0=$(date +%s.%N)
cp /tmp/latex-render-perf.json "$OUT/perf0.json" 2>/dev/null || echo '{}' > "$OUT/perf0.json"
for _ in 1 2; do
  xdotool click --repeat "$CLICKS" --delay 25 5
  xdotool click --repeat "$CLICKS" --delay 25 4
done
sleep 3
c1=$(ticks "$cl"); g1=$(ticks "$gh"); t1=$(date +%s.%N)
[[ -n "${VIDEO:-}" ]] && { kill -INT $ff; wait $ff 2>/dev/null; }
import -window root "$OUT/after.png" 2>/dev/null
cp /tmp/latex-render-perf.json "$OUT/perf1.json" 2>/dev/null || echo '{}' > "$OUT/perf1.json"
kill "$gh" 2>/dev/null; sleep 0.5; kill "$xv" 2>/dev/null
hz=$(getconf CLK_TCK)
log "$(awk -v w="$t1-$t0" -v c=$((c1-c0)) -v g=$((g1-g0)) -v hz=$hz -v a=$t0 -v b=$t1 'BEGIN{printf "wall %.1fs; claude cpu %.2fs; ghostty cpu %.2fs", b-a, c/hz, g/hz}')"
python3 - "$OUT/perf0.json" "$OUT/perf1.json" <<'PY' | tee -a "$OUT/log"
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
for k, v in b.items():
    u = a.get(k, {"n": 0, "ms": 0})
    n, ms = v["n"] - u["n"], v["ms"] - u["ms"]
    print(f"{k}: {n} renders during scroll, {ms:.0f} ms total, {ms/max(n,1):.2f} ms avg, max {v['max']:.1f} ms")
PY
