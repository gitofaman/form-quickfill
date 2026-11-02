#!/bin/bash
# Stop the bridge and remove its LaunchAgent. Leaves config/ and data/ alone.
LABEL="local.form-quickfill.bridge"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Stopped $LABEL" || echo "$LABEL wasn't running"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
