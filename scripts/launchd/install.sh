#!/bin/bash
# Installs the daily launchd job for the current user. Re-run after moving the repo.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.hata.monitor.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$REPO/logs"
sed "s#__REPO__#$REPO#g" "$REPO/scripts/launchd/com.hata.monitor.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST (07:45, 13:45, 19:45 local time)."
echo "Run now:   launchctl kickstart -k gui/$(id -u)/com.hata.monitor"
echo "Wake Mac:  sudo pmset repeat wakeorpoweron MTWRFSU 07:40:00"
