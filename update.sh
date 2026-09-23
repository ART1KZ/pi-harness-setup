#!/usr/bin/env bash
# ==============================================================================
# Pi Harness Setup Updater for Linux & macOS
# Updates Pi Coding Agent and all installed extensions to latest versions
# ==============================================================================

set -euo pipefail

echo "Updating Pi Coding Agent (@earendil-works/pi-coding-agent@latest)..."
if command -v sudo >/dev/null 2>&1 && [ "$EUID" -ne 0 ] && [ ! -w "$(npm config get prefix)/lib/node_modules" 2>/dev/null ]; then
    sudo npm install -g @earendil-works/pi-coding-agent@latest
else
    npm install -g @earendil-works/pi-coding-agent@latest
fi

echo "Updating all Pi packages, extensions, and model catalogs to latest versions..."
pi update --all

echo "Update complete! Current versions:"
pi --version
pi list
