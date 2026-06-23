# opencode-hwtracker

An [opencode](https://opencode.ai) plugin that records local server hardware metrics whenever the model output is unexpectedly slow, then surfaces a verdict explaining whether the bottleneck is likely **LOCAL** (CPU/RAM/load on your opencode machine) or **BACKEND** (local hardware looks fine — the slowness is the remote vLLM service or the network to it, which is IT's domain).

## What it does

1. **Detects slow turns** via two triggers:
   - **TTFT** (time-to-first-token): fires if no token arrives within `ttftThresholdMs` (default 5 s).
   - **tok/s** (token throughput): fires at turn completion if throughput is below `minTokensPerSec` (default 10).

2. **Takes a hardware snapshot** on trigger (CPU usage %, load averages, RAM/swap, disk utilisation).

3. **Computes a verdict** based on which thresholds are crossed:
   - `LOCAL likely` — CPU, load, or memory on the local machine is saturated → fix locally.
   - `BACKEND likely` — local hardware looks fine → the bottleneck is the remote vLLM service or the network to it (IT's domain).

4. **Logs a JSONL event** to `~/.opencode-hwtrack/events.jsonl` (configurable).

5. **Shows a toast** in the opencode TUI (bottom-right) with a one-line summary.

### Why no GPU metrics?

The vLLM inference service runs on a separate, IT-managed GPU server that the opencode client host cannot observe. This plugin deliberately measures only the local opencode server to help you identify whether slowness is **local** (your machine — fixable here) versus **backend or network** (escalate to IT). GPU metrics on the inference server are out of scope.

### Toast persistence caveat

opencode toasts auto-dismiss after a few seconds. If the turn completes very quickly after the trigger fires, the toast may disappear before you read it. The JSONL log is the durable record — check it with `tail -f` or `cat ... | python3 -m json.tool`.

---

## Sidebar inside opencode (recommended)

The TUI sidebar plugin renders **live CPU / RAM / disk** in opencode's right sidebar panel — always visible while you work, no separate terminal needed.

### Install the sidebar

```bash
# From a cloned repo:
./install-sidebar.sh

# Or one-liner (clones automatically):
curl -fsSL https://raw.githubusercontent.com/cytsaiap-xyz/opencode-hwtracker/master/install-sidebar.sh | bash
```

The script:
1. Copies `src/` to `~/.config/opencode/plugins/opencode-hwtracker-sidebar-src/`
2. Writes a loader entry `~/.config/opencode/plugins/opencode-hwtracker-sidebar.ts`
3. Merges `plugins/tsconfig.json` with `jsxImportSource: "@opentui/solid"`
4. Runs `bun add @opentui/solid solid-js @opencode-ai/sdk` in the plugins directory
5. Registers `./plugins/opencode-hwtracker-sidebar.ts` in `~/.config/opencode/tui.json`

**After install:** fully quit and relaunch opencode. Use a terminal wide enough to show the right sidebar — the "HW" panel appears immediately and refreshes every 3 seconds (configurable via `HWTRACK_WATCH_INTERVAL`).

This sidebar complements the server plugin (below), which still does slow-turn detection and writes the JSONL log that the sidebar reads for the "last slow event" line. Install both for full functionality.

---

## Install

> **Important:** opencode loads a plugin as a **single `.js`/`.ts` file** placed
> directly in its plugins directory — it does **not** load a cloned repo folder.
> So you install **one bundled file**, `dist/opencode-hwtracker.js` (no build, no
> dependencies — it's pure Bun + Node built-ins).

Plugin directories:
- `~/.config/opencode/plugins/` — **global** (all projects)
- `.opencode/plugins/` — **per-project**

### Option A — Download the prebuilt single file (recommended)

**Global:**

```bash
mkdir -p ~/.config/opencode/plugins
curl -L https://raw.githubusercontent.com/cytsaiap-xyz/opencode-hwtracker/master/dist/opencode-hwtracker.js \
  -o ~/.config/opencode/plugins/opencode-hwtracker.js
```

**Per-project:**

```bash
mkdir -p .opencode/plugins
curl -L https://raw.githubusercontent.com/cytsaiap-xyz/opencode-hwtracker/master/dist/opencode-hwtracker.js \
  -o .opencode/plugins/opencode-hwtracker.js
```

### Option B — Build from source

```bash
git clone https://github.com/cytsaiap-xyz/opencode-hwtracker.git
cd opencode-hwtracker
bun install
bun run build        # produces dist/opencode-hwtracker.js
cp dist/opencode-hwtracker.js ~/.config/opencode/plugins/
```

### Confirm it loaded (do this first!)

Restart opencode. On startup the plugin prints a one-line diagnostic to **stderr**:

```
[hwtrack] loaded — cwd=/your/project minTokensPerSec=10 ttftThresholdMs=5000 logPath=/Users/you/.opencode-hwtrack/events.jsonl
```

**If you see that line, the plugin loaded** — and it shows the exact config it
resolved (handy for confirming your overrides took effect). If you do **not** see
it, the file isn't in the plugins directory (or opencode wasn't restarted).

### Update / uninstall

```bash
# update: re-download (Option A) or rebuild (Option B)
# uninstall:
rm ~/.config/opencode/plugins/opencode-hwtracker.js
```

### Configure (optional)

All settings are optional — the plugin works out of the box with defaults. To tune thresholds, copy `hwtrack.config.example.json` to `hwtrack.config.json` in your project root (where you launch opencode), e.g.:

```json
{
  "minTokensPerSec": 10,
  "ttftThresholdMs": 5000
}
```

Or use environment variables (see the [Configuration](#configuration) table) — e.g. `HWTRACK_MIN_TOKENS_PER_SEC=15`. There is no endpoint to configure: the plugin only reads local hardware.

### Force a trigger (smoke test)

Because the plugin is silent on fast turns, force every turn to fire by setting a
huge throughput threshold, and watch the log:

```bash
# terminal A — watch the log
touch ~/.opencode-hwtrack/events.jsonl && tail -f ~/.opencode-hwtrack/events.jsonl

# terminal B — launch with a forced trigger and debug tracing
HWTRACK_DEBUG=1 HWTRACK_MIN_TOKENS_PER_SEC=100000 opencode
```

Send any prompt. You should see a bottom-right toast **and** a new JSON line in
terminal A. With `HWTRACK_DEBUG=1`, the plugin also logs each `message.updated` /
`message.part.updated` event and every `trigger fired` to stderr — useful if
nothing appears. Remove the overrides when done.

> **Where the `[hwtrack] …` lines appear:** plugin `console` output goes to
> opencode's **log files**, not the TUI screen. View them with either:
> ```bash
> opencode --print-logs                      # stream logs in the terminal, or
> tail -f ~/.local/share/opencode/log/*.log | grep hwtrack
> ```
>
> **Not working?** Two reliable signals that don't depend on the TUI:
> 1. **Startup line** — `grep hwtrack` the log for `[hwtrack] loaded …`. Missing →
>    the file isn't at `~/.config/opencode/plugins/opencode-hwtracker.js`, or opencode
>    wasn't restarted.
> 2. **The JSONL file** — `~/.opencode-hwtrack/events.jsonl` gets a line on every
>    trigger, regardless of whether the toast shows. Lines appearing but no toast →
>    a TUI-toast display issue, not a plugin failure (the data is still recorded).
>
> Line present but no JSONL on a forced trigger → run with `HWTRACK_DEBUG=1` to trace
> events, and see [Install & verify](#install--verify-manual-integration-checklist).

---

## Live panel (separate terminal — alternative to the sidebar)

The [in-opencode sidebar](#sidebar-inside-opencode-recommended) above is the recommended
persistent view. This `hwtracker-watch` command is an **alternative** for when you'd
rather not widen the terminal for opencode's sidebar, or want the readout in its own
pane/window. Run it in a terminal split beside opencode. It samples
**CPU / RAM / disk every couple of seconds** and shows the latest slow-output event:

```
opencode-hwtracker — live local hardware
2026-06-23T13:33:00.000Z

CPU  [#####---------------]  24%
load 2.42 (1m) / 8 cores = 0.30/core
RAM  [#################---]  85%  HIGH  (27.1/32.0 GB)
Disk [############--------]  58%  (381 GB free)

Last slow-output event:
  2026-06-23T13:31:10.000Z
  tokps: 6.1 tok/s -> BACKEND likely

(Ctrl-C to quit)
```

### Install the watcher (one file)

```bash
curl -L https://raw.githubusercontent.com/cytsaiap-xyz/opencode-hwtracker/master/dist/hwtracker-watch.js \
  -o ~/.config/opencode/hwtracker-watch.js
```

### Run it beside opencode

```bash
bun ~/.config/opencode/hwtracker-watch.js
# refresh interval in seconds (default 2):
HWTRACK_WATCH_INTERVAL=1 bun ~/.config/opencode/hwtracker-watch.js
```

Side-by-side with tmux (opencode left, live panel right):

```bash
tmux new-session 'opencode' \; split-window -h 'bun ~/.config/opencode/hwtracker-watch.js' \; select-pane -L
```

The watcher reads the same `hwtrack.config.json` thresholds (run it from your project
directory to match) and tails the same `~/.opencode-hwtrack/events.jsonl` the plugin
writes. It redraws in place and stays up until you press Ctrl-C. A metric is flagged
`HIGH` when it crosses its threshold (`cpuHighPct` / `loadHighRatio` / `memHighPct`).

---

## Configuration

All fields are optional. Priority order: **env vars > hwtrack.config.json > built-in defaults**.

| Key | Env var | Default | Description |
|-----|---------|---------|-------------|
| `minTokensPerSec` | `HWTRACK_MIN_TOKENS_PER_SEC` | `10` | Throughput below this triggers a snapshot. |
| `ttftThresholdMs` | `HWTRACK_TTFT_THRESHOLD_MS` | `5000` | TTFT above this triggers a snapshot (ms). |
| `cpuHighPct` | `HWTRACK_CPU_HIGH_PCT` | `85` | CPU usage % considered "high". |
| `loadHighRatio` | `HWTRACK_LOAD_HIGH_RATIO` | `1.0` | load1 / core count ratio considered "high". |
| `memHighPct` | `HWTRACK_MEM_HIGH_PCT` | `90` | RAM used % considered "high". |
| `logPath` | `HWTRACK_LOG_PATH` | `~/.opencode-hwtrack/events.jsonl` | Path to append JSONL events. `~` is expanded. |

---

## JSONL event shape

Each line in `events.jsonl` is a JSON object:

```json
{
  "ts": "2026-06-23T12:34:56.789Z",
  "sessionId": "sess_abc123",
  "trigger": "tokps",
  "speed": {
    "tokensPerSec": 3.2,
    "ttftMs": 820,
    "estimated": false
  },
  "snapshot": {
    "cpu": {
      "usagePct": 91.4,
      "load1": 7.2,
      "load5": 5.1,
      "load15": 3.8,
      "cores": 8
    },
    "mem": {
      "totalMB": 32768,
      "usedMB": 29000,
      "freeMB": 3768,
      "usedPct": 88.5,
      "swapUsedMB": 512
    },
    "disk": {
      "path": "/",
      "freeGB": 18.4,
      "usedPct": 62.1
    }
  },
  "verdict": {
    "label": "LOCAL likely",
    "reasons": ["CPU 91% (threshold 85%)", "RAM 88% (threshold 90%)"]
  }
}
```

Fields `cpu`, `mem`, `disk` inside `snapshot` may be `null` if that collector failed.

### Reading the log

```bash
# Stream live events
tail -f ~/.opencode-hwtrack/events.jsonl

# Pretty-print the latest event
tail -1 ~/.opencode-hwtrack/events.jsonl | python3 -m json.tool

# Count triggers by type
cat ~/.opencode-hwtrack/events.jsonl | python3 -c "
import sys, json, collections
counts = collections.Counter(json.loads(l)['trigger'] for l in sys.stdin)
print(counts)
"
```

---

## Install & verify (manual integration checklist)

> This checklist corresponds to the manual integration test (brief Step 7) that requires a live opencode + vLLM session. Run it after installing the plugin.

1. **Link the plugin** (global or per-project, see Install section above).
2. **Create `hwtrack.config.json`** in the project root (optional):
   ```json
   { "minTokensPerSec": 10, "ttftThresholdMs": 5000 }
   ```
3. **Start opencode** and run a normal prompt. Confirm **no** warning toast and **no** new JSONL line (turn was fast).
4. **Force a slow turn**: temporarily set `minTokensPerSec` very high (e.g. `100000`) so any turn triggers. Run a prompt.
5. **Verify**: a toast appears bottom-right **and** a new line is appended to `~/.opencode-hwtrack/events.jsonl` with populated `snapshot` and a `verdict`.
6. **Inspect the event**:
   ```bash
   cat ~/.opencode-hwtrack/events.jsonl | tail -1 | python3 -m json.tool
   ```
   Confirm fields: `ts`, `sessionId`, `trigger`, `speed`, `snapshot.{cpu,mem,net,disk}`, `verdict.label`.
7. **If the toast does not appear or `sessionId`/tokens are `"unknown"`/`null`**: the opencode event payload shape may differ from what the plugin expects. To diagnose, temporarily add `console.error("[hwtrack] EVT", JSON.stringify(event))` at the top of the `event` handler in `src/index.ts`, restart opencode, read the property names from the logs, and adjust the extraction fallbacks (`info`/`message`, `sessionID`/`sessionId`, `messageID`/`messageId`, `tokens.output`, `time.created`/`time.completed`) and the `showToast` method name in `src/index.ts` accordingly. Re-run from step 3.
8. **Restore** `minTokensPerSec` to `10`.

---

## Development

```bash
bun install
bun run typecheck   # must pass with 0 errors
bun test            # 43 tests across 7 suites, all green
```

Test files mirror each source module: `config.test.ts` (5), `verdict.test.ts` (7), `detector.test.ts` (9), `snapshot.test.ts` (8), `logger.test.ts` (2), `warning.test.ts` (9), `readFileConfig.test.ts` (3).
