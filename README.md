# opencode-hwtracker

An [opencode](https://opencode.ai) plugin that records local server hardware metrics whenever the model output is unexpectedly slow, then surfaces a verdict explaining whether the bottleneck is likely **LOCAL** (CPU/RAM on the inference box), **NETWORK** (latency to the vLLM endpoint), or **BACKEND** (the vLLM process itself is saturated/underprovisioned).

## What it does

1. **Detects slow turns** via two triggers:
   - **TTFT** (time-to-first-token): fires if no token arrives within `ttftThresholdMs` (default 5 s).
   - **tok/s** (token throughput): fires at turn completion if throughput is below `minTokensPerSec` (default 10).

2. **Takes a hardware snapshot** on trigger (CPU usage %, load averages, RAM/swap, TCP connect latency to the vLLM endpoint, disk utilisation).

3. **Computes a verdict** based on which thresholds are crossed:
   - `LOCAL likely` — CPU or memory is saturated.
   - `NETWORK likely` — TCP connect to the endpoint is slow.
   - `BACKEND likely` — hardware looks fine; the bottleneck is inside vLLM.

4. **Logs a JSONL event** to `~/.opencode-hwtrack/events.jsonl` (configurable).

5. **Shows a toast** in the opencode TUI (bottom-right) with a one-line summary.

### Why no GPU metrics?

The vLLM inference service runs on a separate, IT-managed GPU server that the opencode client host cannot observe. This plugin deliberately measures only the local opencode server to help you identify whether slowness is **local** (your machine — fixable here) versus **backend or network** (escalate to IT). GPU metrics on the inference server are out of scope.

### Toast persistence caveat

opencode toasts auto-dismiss after a few seconds. If the turn completes very quickly after the trigger fires, the toast may disappear before you read it. The JSONL log is the durable record — check it with `tail -f` or `cat ... | python3 -m json.tool`.

---

## Install

opencode loads local plugins from two directories:

- `~/.config/opencode/plugins/` — **global** (all projects)
- `.opencode/plugins/` — **per-project** (committed or local to one repo)

The plugin has **no runtime dependencies** — it uses only the Bun runtime and Node
built-ins, so there is nothing to build and no `npm install` step. Just place the
repository in one of those directories.

### Option A — Clone directly into the plugins directory (recommended)

**Global:**

```bash
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/cytsaiap-xyz/opencode-hwtracker.git \
  ~/.config/opencode/plugins/opencode-hwtracker
```

**Per-project:**

```bash
mkdir -p .opencode/plugins
git clone https://github.com/cytsaiap-xyz/opencode-hwtracker.git \
  .opencode/plugins/opencode-hwtracker
```

### Option B — Clone once, symlink into place

Handy if you want a single working copy you can `git pull` and reuse:

```bash
git clone https://github.com/cytsaiap-xyz/opencode-hwtracker.git
mkdir -p ~/.config/opencode/plugins
ln -s "$(pwd)/opencode-hwtracker" ~/.config/opencode/plugins/opencode-hwtracker
```

### Update / uninstall

```bash
# update
git -C ~/.config/opencode/plugins/opencode-hwtracker pull
# uninstall
rm -rf ~/.config/opencode/plugins/opencode-hwtracker   # or remove the symlink
```

### Configure the endpoint

Copy `hwtrack.config.example.json` to `hwtrack.config.json` in your project root
(or wherever opencode is launched from) and set `vllmEndpoint` to your inference
server's `host:port`:

```json
{
  "vllmEndpoint": "10.0.0.5:8000",
  "minTokensPerSec": 10
}
```

Alternatively, set everything via environment variables (see the
[Configuration](#configuration) table) — e.g. `HWTRACK_VLLM_ENDPOINT=10.0.0.5:8000`.

### Confirm it loaded

Restart opencode, then run any prompt. To force a trigger and confirm the plugin is
active, temporarily set a very high threshold so every turn fires:

```bash
HWTRACK_MIN_TOKENS_PER_SEC=100000 opencode
```

You should see a bottom-right toast and a new line appended to
`~/.opencode-hwtrack/events.jsonl`. Then remove the override. See
[Install & verify](#install--verify-manual-integration-checklist) below for the full checklist.

> **Note:** opencode discovers plugins by scanning the `plugins/` directories above.
> If yours isn't picked up, confirm the clone landed at exactly
> `~/.config/opencode/plugins/opencode-hwtracker/` (with `src/index.ts` inside) and
> that you restarted opencode.

---

## Configuration

All fields are optional. Priority order: **env vars > hwtrack.config.json > built-in defaults**.

| Key | Env var | Default | Description |
|-----|---------|---------|-------------|
| `vllmEndpoint` | `HWTRACK_VLLM_ENDPOINT` | `null` | `host:port` of your vLLM server (used for TCP ping). |
| `minTokensPerSec` | `HWTRACK_MIN_TOKENS_PER_SEC` | `10` | Throughput below this triggers a snapshot. |
| `ttftThresholdMs` | `HWTRACK_TTFT_THRESHOLD_MS` | `5000` | TTFT above this triggers a snapshot (ms). |
| `cpuHighPct` | `HWTRACK_CPU_HIGH_PCT` | `85` | CPU usage % considered "high". |
| `loadHighRatio` | `HWTRACK_LOAD_HIGH_RATIO` | `1.0` | load1 / core count ratio considered "high". |
| `memHighPct` | `HWTRACK_MEM_HIGH_PCT` | `90` | RAM used % considered "high". |
| `netHighMs` | `HWTRACK_NET_HIGH_MS` | `200` | TCP connect latency (ms) considered "high". |
| `netTimeoutMs` | `HWTRACK_NET_TIMEOUT_MS` | `2000` | TCP connect timeout (ms). |
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
    "net": {
      "endpoint": "10.0.0.5:8000",
      "tcpConnectMs": 42,
      "ok": true
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

Fields `cpu`, `mem`, `net`, `disk` inside `snapshot` may be `null` if the collector failed or the endpoint is unconfigured.

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
2. **Create `hwtrack.config.json`** in the project root:
   ```json
   { "vllmEndpoint": "<your-vllm-host>:<port>", "minTokensPerSec": 10, "ttftThresholdMs": 5000 }
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
