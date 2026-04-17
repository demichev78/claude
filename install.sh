#!/usr/bin/env bash
# install.sh — Prepare this repo for installation as a local Claude Code plugin.
#
# This script verifies prerequisites. Installation itself happens through
# Claude Code's /plugin marketplace flow — see the printed instructions below.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

missing=0

check_file() {
    local path="$1"
    if [ ! -f "$path" ]; then
        echo "  MISSING: $path" >&2
        missing=1
    fi
}

check_dir() {
    local path="$1"
    if [ ! -d "$path" ]; then
        echo "  MISSING: $path" >&2
        missing=1
    fi
}

echo "Verifying plugin layout in $SCRIPT_DIR"

check_file "$SCRIPT_DIR/.claude-plugin/plugin.json"
check_file "$SCRIPT_DIR/.claude-plugin/marketplace.json"
check_dir "$SCRIPT_DIR/agents"
check_dir "$SCRIPT_DIR/skills"
check_dir "$SCRIPT_DIR/commands"
check_dir "$SCRIPT_DIR/rules"
check_dir "$SCRIPT_DIR/hooks"

if [ "$missing" -ne 0 ]; then
    echo ""
    echo "Layout check failed. Restore the missing files before installing."
    exit 1
fi

echo "  OK"
echo ""

# Extract marketplace + plugin names (simple grep-based to avoid jq dependency)
MARKETPLACE=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' \
    "$SCRIPT_DIR/.claude-plugin/marketplace.json" | head -1 \
    | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')
PLUGIN=$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' \
    "$SCRIPT_DIR/.claude-plugin/plugin.json" | head -1 \
    | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')

cat <<EOF
Layout verified. Install in Claude Code with two slash commands:

  /plugin marketplace add $SCRIPT_DIR
  /plugin install $PLUGIN@$MARKETPLACE

Hooks, MCP servers, agents, skills, commands, and rules register
automatically. No edits to ~/.claude/settings.json are required.

To uninstall:

  /plugin uninstall $PLUGIN@$MARKETPLACE
  /plugin marketplace remove $MARKETPLACE

To update after editing this repo, the marketplace cache refreshes on
session start. For an immediate refresh:

  /plugin marketplace update $MARKETPLACE
EOF
