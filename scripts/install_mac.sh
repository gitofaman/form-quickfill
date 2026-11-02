#!/bin/bash
# Run the bridge as a LaunchAgent: it starts at login and restarts if it dies.
# Run again after moving the folder or editing bridge/*.py (it reloads the agent).
#
# Keep this folder OUTSIDE Desktop / Documents / Downloads: macOS blocks background
# agents from reading those, and the bridge fails with "Operation not permitted".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="local.form-quickfill.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$(command -v python3 || true)"
AGY="$(grep -E '^AGY_BIN=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
AGY="${AGY:-$(command -v agy || echo "$HOME/.local/bin/agy")}"

[ -n "$PY" ] || { echo "python3 not found"; exit 1; }
for f in .env config/profile.json config/facts.json; do
  [ -f "$ROOT/$f" ] || { echo "Missing $f: see README (Setup)."; exit 1; }
done
case "$ROOT" in "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
  echo "This folder is under Desktop/Documents/Downloads, which LaunchAgents can't read. Move it (e.g. to ~/form-quickfill) and rerun."; exit 1;;
esac
[ -x "$AGY" ] || echo "warning: agy not found at $AGY. Install it or set AGY_BIN in .env; form answers will fail until then."

mkdir -p "$ROOT/data" "$HOME/Library/LaunchAgents"
# agy needs python3 on PATH too: its tool gate (bridge/agy/gate.py) runs as `python3`.
AGENT_PATH="$(dirname "$PY"):$(dirname "$AGY"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>-u</string><string>$ROOT/bridge/bridge.py</string></array>
  <key>WorkingDirectory</key><string>$ROOT/bridge</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$AGENT_PATH</string><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/data/bridge.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/bridge.log</string>
</dict></plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST"
for _ in 1 2 3 4 5 6; do
  sleep 1
  if curl -sf http://127.0.0.1:8131/health >/dev/null; then
    echo "Bridge is up on http://127.0.0.1:8131. Check everything with: python3 scripts/doctor.py"; exit 0
  fi
done
echo "Bridge isn't answering yet. Look at $ROOT/data/bridge.log"
exit 1
