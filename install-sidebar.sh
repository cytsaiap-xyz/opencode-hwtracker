#!/usr/bin/env bash
#
# opencode-hwtracker-sidebar — one-click installer for the TUI sidebar plugin
#
# Installs the opencode-hwtracker sidebar TUI plugin into your global opencode
# config so live CPU/RAM/Disk appears in opencode's right sidebar panel.
#
# Safe to re-run: overwrites only this plugin's own files and MERGES into
# tui.json / plugins/tsconfig.json (never clobbers other plugins).
#
# Run from a cloned repo:   ./install-sidebar.sh
# Or standalone (clones):   curl -fsSL https://raw.githubusercontent.com/cytsaiap-xyz/opencode-hwtracker/master/install-sidebar.sh | bash
#
set -euo pipefail

PLUGIN_ID="opencode-hwtracker-sidebar"
REPO_URL="https://github.com/cytsaiap-xyz/opencode-hwtracker.git"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGINS_DIR="$CONFIG_DIR/plugins"
SRC_DEST="$PLUGINS_DIR/${PLUGIN_ID}-src"
ENTRY="$PLUGINS_DIR/${PLUGIN_ID}.ts"
ENTRY_REL="./plugins/${PLUGIN_ID}.ts"
TSCONFIG="$PLUGINS_DIR/tsconfig.json"
TUI_JSON="$CONFIG_DIR/tui.json"

say() { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# --- 1. Prerequisite: bun (opencode runs on bun) -----------------------------
command -v bun >/dev/null 2>&1 || die "bun is required (opencode runs on bun). Install it from https://bun.sh"

# --- 2. Locate the plugin source (this repo's src/), else clone --------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
CLEANUP=""
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/src/tui.tsx" ]; then
  SRC="$SCRIPT_DIR/src"
else
  command -v git >/dev/null 2>&1 || die "git is required to fetch the source."
  TMP="$(mktemp -d)"; CLEANUP="$TMP"
  echo "Cloning $REPO_URL ..."
  git clone --depth 1 "$REPO_URL" "$TMP/repo" >/dev/null 2>&1 || die "git clone failed."
  SRC="$TMP/repo/src"
fi
[ -f "$SRC/tui.tsx" ] || die "plugin source not found at $SRC (expected tui.tsx)"

# --- 3. Copy source ----------------------------------------------------------
mkdir -p "$PLUGINS_DIR"
rm -rf "$SRC_DEST"; mkdir -p "$SRC_DEST"
cp -R "$SRC/." "$SRC_DEST/"
say "copied source -> $SRC_DEST"

# --- 4. Entry file (opencode's loader reads defaultExport.tui) ---------------
cat > "$ENTRY" <<EOF
/**
 * opencode-hwtracker-sidebar TUI plugin entry.
 * opencode reads defaultExport.tui, so we default-export { id, tui }.
 */
import { tui } from "./${PLUGIN_ID}-src/tui"
export default { id: "${PLUGIN_ID}", tui }
EOF
say "wrote entry -> $ENTRY"

# --- 5. tsconfig.json: ensure jsx + @opentui/solid jsxImportSource (merge) ----
TSCONFIG="$TSCONFIG" bun -e '
  const fs = require("fs");
  const f = process.env.TSCONFIG;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  cfg.compilerOptions = cfg.compilerOptions || {};
  const co = cfg.compilerOptions;
  co.jsx = "preserve";
  co.jsxImportSource = "@opentui/solid";
  co.module = co.module || "ESNext";
  co.moduleResolution = co.moduleResolution || "bundler";
  co.target = co.target || "ESNext";
  if (co.strict === undefined) co.strict = true;
  if (co.skipLibCheck === undefined) co.skipLibCheck = true;
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
'
say "ensured jsxImportSource @opentui/solid -> $TSCONFIG"

# --- 6. Install runtime deps (not bundled in the opencode binary) ------------
echo "Installing deps (@opentui/solid, solid-js, @opencode-ai/sdk) ..."
( cd "$PLUGINS_DIR" && bun add @opentui/solid solid-js @opencode-ai/sdk >/dev/null 2>&1 ) \
  || die "bun add failed in $PLUGINS_DIR"
say "installed runtime deps in $PLUGINS_DIR"

# --- 7. Register in tui.json (merge, no duplicates, keep other plugins) ------
TUI_JSON="$TUI_JSON" ENTRY_REL="$ENTRY_REL" bun -e '
  const fs = require("fs");
  const f = process.env.TUI_JSON, entry = process.env.ENTRY_REL;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  if (!cfg["$schema"]) cfg["$schema"] = "https://opencode.ai/tui.json";
  const arr = Array.isArray(cfg.plugin) ? cfg.plugin : [];
  const nameOf = (p) => (typeof p === "string" ? p : Array.isArray(p) ? p[0] : undefined);
  if (!arr.some((p) => nameOf(p) === entry)) arr.push(entry);
  cfg.plugin = arr;
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
'
say "registered in $TUI_JSON"

# --- 8. Cleanup + done -------------------------------------------------------
[ -n "$CLEANUP" ] && rm -rf "$CLEANUP" || true

cat <<'DONE'

opencode-hwtracker-sidebar installed.

Next:
  1. Fully quit and relaunch opencode (so it reloads plugins from tui.json).
  2. Use a terminal wide enough to show the right sidebar.
  3. The "HW" panel appears immediately — it samples CPU/RAM/disk every 3 s
     and shows the last slow-turn event from ~/.opencode-hwtrack/events.jsonl.

Note: this TUI sidebar complements the server plugin (opencode-hwtracker.js),
which still does slow-turn detection and writes the JSONL log the sidebar reads.
Install both for full functionality.

Uninstall:
  rm ~/.config/opencode/plugins/opencode-hwtracker-sidebar.ts
  rm -rf ~/.config/opencode/plugins/opencode-hwtracker-sidebar-src/
  # then remove the "./plugins/opencode-hwtracker-sidebar.ts" entry from:
  # ~/.config/opencode/tui.json
DONE
