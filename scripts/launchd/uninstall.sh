#!/bin/bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.hata.monitor.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed com.hata.monitor. (To cancel scheduled wake: sudo pmset repeat cancel)"
