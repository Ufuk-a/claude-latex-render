#!/bin/bash
# Reproduces scroll snap-backs: resumes a transcript in a real Ghostty on a
# virtual X display, wheels UP slowly (as a person reads back), records it, and
# runs scroll_check.py on the recording. Backward jumps are the bug.
#   scroll_jump.sh <transcript.jsonl>     (CLICKS=60 DELAY=150 SETTLE=25 TAG=x)
#   scroll_jump.sh <reply.md>             live: a fresh session streams reply.md
#     verbatim first (replies that streamed in the session draw through the
#     placed live row, resumed ones through AssistantMessage: both need checking)
# Output in /tmp/scrolljump: log, scroll-TAG.mp4, check-TAG.txt.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
MOD=${MOD:-$(dirname "$HERE")}
SRC=$1
OUT=/tmp/scrolljump
DISP=:95
W=1480 H=1060
mkdir -p "$OUT"
log() { echo "$(date +%T) $*" | tee -a "$OUT/log"; }
id=$(cat /proc/sys/kernel/random/uuid)
proj="$HOME/.claude/projects/-tmp-scrolljump"
mkdir -p "$proj"
if [[ $SRC == *.md ]]; then
  printf '%s' "When the user says go, reply with exactly the markdown below, verbatim, nothing before or after it, and no tools. Ignore any other reminders or hooks in this session.

$(cat "$SRC")" > "$OUT/sys.txt"
  launch="--model opus --effort low --session-id $id --append-system-prompt \"\$(cat $OUT/sys.txt)\" go"
else
  launch="--resume $id"
  sed "s#\"cwd\":\"[^\"]*\"#\"cwd\":\"$OUT\"#g; s#$(basename "$SRC" .jsonl)#$id#g" "$SRC" > "$proj/$id.jsonl"
fi
Xvfb $DISP -screen 0 ${W}x${H}x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
xv=$!
sleep 1.5
export DISPLAY=$DISP GDK_BACKEND=x11
cat > "$OUT/run.sh" <<EOR
#!/bin/bash
cd $OUT
unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_PLUGIN_DIRS
export MAX_THINKING_TOKENS=0 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 CLAUDE_CODE_SANDBOXED=1 LATEX_RENDER_PERF=1
exec /opt/claude-code/bin/claude --setting-sources project --strict-mcp-config --plugin-dir $MOD --settings $OUT/settings.json $launch
EOR
echo '{"tui": "fullscreen", "alwaysThinkingEnabled": false}' > "$OUT/settings.json"
chmod +x "$OUT/run.sh"
ghostty --window-width=146 --window-height=49 --window-decoration=false -e "$OUT/run.sh" >"$OUT/ghostty.log" 2>&1 &
gh=$!
sleep "${SETTLE:-25}"
if [[ $SRC == *.md ]]; then
  for _ in $(seq 240); do grep -q '"stop_reason":"end_turn"' "$proj/$id.jsonl" 2>/dev/null && break; sleep 1; done
  sleep 3
fi
log "ghostty $gh, resumed $id"
xdotool mousemove 700 450
ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -framerate 15 -video_size ${W}x${H} -i $DISP -c:v libx264 -preset ultrafast -crf 16 "$OUT/scroll-${TAG:-x}.mp4" &
ff=$!
sleep 0.5
xdotool click --repeat "${CLICKS:-60}" --delay "${DELAY:-150}" 4
sleep 2
kill -INT $ff; wait $ff 2>/dev/null
import -window root "$OUT/end-${TAG:-x}.png" 2>/dev/null
kill "$gh" 2>/dev/null; sleep 0.5; kill "$xv" 2>/dev/null
python3 "$HERE/scroll_check.py" "$OUT/scroll-${TAG:-x}.mp4" > "$OUT/check-${TAG:-x}.txt"
log "backward jumps: $(grep -c BACK "$OUT/check-${TAG:-x}.txt"), net shift $(tail -1 "$OUT/check-${TAG:-x}.txt" | awk '{print $NF}')"
