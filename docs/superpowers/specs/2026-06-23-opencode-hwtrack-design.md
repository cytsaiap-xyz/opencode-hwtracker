# opencode-hwtrack — Design Spec

**Date:** 2026-06-23
**Status:** Approved for planning

## Problem

We run our model on an IT-managed **vLLM service hosted on a GPU server**, while **opencode runs on a separate client server**. When output feels slow, we can't see the GPU server (it's IT's domain, out of scope). What we *can* do, from the opencode server, is measure output speed and local server health at the moment of slowness, so we can answer one question:

> **Is the slowness our local opencode server's fault, or is it the backend (vLLM / network)?**

The plugin produces actionable evidence to either fix locally or escalate to IT.

## Goals

- Detect when assistant output is slow (low tokens/sec **or** high time-to-first-token).
- On a slow event, capture a snapshot of the **local** opencode server: CPU, load, RAM, network latency to vLLM, disk.
- Emit a **verdict** (LOCAL / NETWORK / BACKEND likely) from that snapshot.
- Persist every event to a JSONL log for later analysis / escalation.
- Surface a live warning in the opencode TUI (bottom-right), refreshed on each new event.

## Non-Goals

- **No GPU / vLLM server metrics.** The GPU server and vLLM service are IT-controlled and out of scope.
- No historical dashboards or charts (JSONL is the record; analysis is external).
- No automatic remediation — the plugin reports, it does not act.

## Architecture

A single opencode plugin (TypeScript, runs in opencode's Bun runtime). It exports the standard plugin function `({ project, directory, worktree, client, $ }) => hooks` and registers the `event` hook plus uses `tui.toast.show` for warnings.

Internal modules (kept small and independently testable):

| Module | Responsibility | Depends on |
|--------|----------------|------------|
| `index.ts` | Plugin entry: wires hooks, owns config, orchestrates detector → snapshot → verdict → outputs | all below |
| `detector.ts` | Per-turn timing state machine; decides when a turn is "slow" (TTFT timer + tok/s at completion) | config |
| `snapshot.ts` | Collects local hardware: CPU%, load, RAM, net latency, disk | `os`, `$`, config |
| `verdict.ts` | Pure function: snapshot + speed → `LOCAL` / `NETWORK` / `BACKEND` verdict | config thresholds |
| `logger.ts` | Appends one JSON line per event to the log file | config |
| `warning.ts` | Formats and shows/refreshes the TUI toast | `client` / tui |
| `config.ts` | Loads defaults, merges env vars and optional `hwtrack.config.json` | — |

Each module has one clear purpose and a narrow interface so it can be unit-tested without opencode running. `verdict.ts` is a pure function — the most important logic, fully testable in isolation.

## Detection logic (`detector.ts`)

Tracks state per assistant turn using opencode `event` payloads and wall-clock timestamps (`Date.now()`):

1. **Turn start** — on the assistant `message.updated` that begins a new turn, record `tStart` and arm a TTFT timer for `ttftThresholdMs`.
2. **First token** — on the first `message.part.updated` carrying assistant text, compute `ttft = now - tStart`, cancel the TTFT timer. If the timer already fired, the event was already triggered.
3. **TTFT trigger (live)** — if the TTFT timer expires before any token arrives, fire a `ttft` trigger immediately (don't wait for the turn to finish).
4. **Turn complete** — on `session.idle` / final `message.updated`, compute `tokensPerSec = tokens.output / max(durationSec, ε)` using the message's token counts and `time.created`/`time.completed` (falling back to wall-clock if absent). If `tokensPerSec < minTokensPerSec`, fire a `tok/s` trigger.

A single turn fires **at most one** event per trigger type. Triggers carry: `{ type: 'ttft'|'tokps', tokensPerSec?, ttftMs?, sessionId }`.

### Edge cases
- Turns with near-zero output tokens (e.g. tool-only or empty responses) are excluded from the tok/s check to avoid false positives.
- If token counts are unavailable, tok/s is estimated from streamed character count (best-effort) and the event is marked `estimated: true`.
- Overlapping/rapid turns: detector keys state by message/session id so concurrent turns don't clobber each other.

## Snapshot (`snapshot.ts`)

Runs asynchronously after a trigger fires. Returns:

```jsonc
{
  "cpu": { "usagePct": 12.4, "load1": 0.8, "load5": 0.6, "load15": 0.5, "cores": 8 },
  "mem": { "totalMB": 16384, "usedMB": 9000, "freeMB": 7384, "usedPct": 54.9, "swapUsedMB": 0 },
  "net": { "endpoint": "10.0.0.5:8000", "tcpConnectMs": 4.2, "ok": true },
  "disk": { "path": "/", "freeGB": 220.5, "usedPct": 41.0 }
}
```

- **CPU:** two `os.cpus()` samples ~200ms apart → aggregate non-idle %. `os.loadavg()` for load. (`load*` may be 0 on platforms that don't report it.)
- **RAM:** `os.totalmem()` / `os.freemem()`; swap best-effort via `$` (`free`/`vm_stat`), null if unavailable.
- **Net:** raw TCP connect timing to the vLLM host:port parsed from `vllmEndpoint`. Measured with `Date.now()`; `ok: false` + null latency on failure/timeout (default 2s).
- **Disk:** `df -k` (or `-g`) on the working directory's mount → free space + used %. I/O is best-effort and may be omitted.

All collectors are individually wrapped so one failing collector degrades to `null` rather than failing the whole snapshot.

## Verdict (`verdict.ts`)

Pure function `(trigger, snapshot, config) => verdict`. Default rules, evaluated in order:

1. `cpu.usagePct >= cpuHighPct` (default 85) **or** `load1/cores >= loadHighRatio` (default 1.0) **or** `mem.usedPct >= memHighPct` (default 90) → **`LOCAL likely`**
2. else if `net.ok === false` **or** `net.tcpConnectMs >= netHighMs` (default 200) → **`NETWORK likely`**
3. else → **`BACKEND likely`**

Verdict object: `{ label, reasons: string[] }` — e.g. `{ label: "LOCAL likely", reasons: ["cpu 91% ≥ 85%"] }`. The reasons make the log self-explanatory.

## Outputs

### JSONL log (`logger.ts`)
One line per event appended to `logPath` (default `~/.opencode-hwtrack/events.jsonl`, created if missing):

```jsonc
{
  "ts": "2026-06-23T10:15:03.221Z",
  "sessionId": "ses_abc",
  "trigger": "tokps",
  "speed": { "tokensPerSec": 6.1, "ttftMs": 850, "estimated": false },
  "snapshot": { /* see above */ },
  "verdict": { "label": "BACKEND likely", "reasons": ["local resources nominal", "net 4ms < 200ms"] }
}
```

Append-only, never rotated by the plugin (left to the user / logrotate). Write failures are caught and logged to stderr; they never crash the turn.

### TUI warning (`warning.ts`)
On each event, show a toast via `tui.toast.show` (bottom-right) summarizing the latest issue:

```
⚠ Slow 6 tok/s · CPU 12% net 4ms → BACKEND likely
```

Re-shown/replaced on each new event so it always reflects the most recent issue.

**Caveat (accepted):** the plugin API provides `tui.toast.show` (a notification), not a guaranteed persistent status widget. If opencode toasts auto-dismiss, the warning is transient between events; the JSONL remains the complete record.

## Config (`config.ts`)

Defaults, overridable via env vars and an optional `hwtrack.config.json` (project root or `~/.opencode-hwtrack/`). Merge order: defaults < file < env.

| Key | Default | Meaning |
|-----|---------|---------|
| `minTokensPerSec` | `10` | tok/s below this fires a `tokps` trigger |
| `ttftThresholdMs` | `5000` | first-token delay above this fires a `ttft` trigger |
| `vllmEndpoint` | (from opencode provider config, else env) | host:port for the net latency probe |
| `logPath` | `~/.opencode-hwtrack/events.jsonl` | JSONL output |
| `cpuHighPct` | `85` | LOCAL verdict CPU threshold |
| `loadHighRatio` | `1.0` | LOCAL verdict load-per-core threshold |
| `memHighPct` | `90` | LOCAL verdict RAM threshold |
| `netHighMs` | `200` | NETWORK verdict latency threshold |
| `netTimeoutMs` | `2000` | net probe timeout |

## Error handling

- Every collector, the logger, and the toast call are wrapped so a failure degrades gracefully (null field / skipped output) and never interrupts the user's opencode turn.
- Missing `vllmEndpoint` → net probe skipped, `net: null`, verdict treats network as unknown (won't claim NETWORK; falls through to BACKEND only when local is nominal).
- Plugin init failures are logged to stderr and the plugin no-ops rather than breaking opencode.

## Testing

- **`verdict.ts`** — pure unit tests across the truth table (local-high, net-high, all-nominal, missing fields).
- **`detector.ts`** — feed synthetic event sequences (fast turn, slow tok/s turn, slow TTFT turn, empty/tool turn) and assert which triggers fire.
- **`snapshot.ts`** — collectors tested with mocked `os` / `$`; assert graceful degradation when a collector throws.
- **`config.ts`** — merge precedence (defaults < file < env).
- **`logger.ts`** — appends valid JSON lines; tolerates a missing directory.
- **Integration (manual):** run inside opencode against the real vLLM endpoint, force a slow turn, confirm a JSONL line + a TUI toast with a sensible verdict.

## Open questions / future (out of scope for v1)

- Optional session-end summary (count of slow events, how often LOCAL was the cause).
- Optional log rotation.
- Richer disk I/O metrics if a clean cross-platform source is found.
