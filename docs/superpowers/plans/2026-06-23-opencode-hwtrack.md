# opencode-hwtrack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an opencode plugin that detects slow assistant output (low tok/s or high TTFT) and, at that moment, records the local opencode server's CPU/RAM/network/disk to a JSONL log and a TUI warning, emitting a verdict (LOCAL / NETWORK / BACKEND likely) to tell whether to fix locally or escalate to IT.

**Architecture:** A single TypeScript opencode plugin running in opencode's Bun runtime. The `event` hook feeds a pure detector state machine; when a turn is "slow" it triggers an async snapshot collector, a pure verdict function, a JSONL logger, and a TUI toast. All logic lives in small, dependency-injected modules unit-tested with `bun test`; the opencode-specific glue (`index.ts`) is verified by a manual integration checklist.

**Tech Stack:** TypeScript, Bun (runtime + `bun test`), Node `os`/`net`/`fs` modules, `@opencode-ai/plugin` types.

## Global Constraints

- Language: TypeScript, ESM modules. Runtime: Bun (opencode loads plugins via Bun).
- Test runner: `bun test`; test files are `src/<name>.test.ts` co-located with source.
- Plugin types come from `@opencode-ai/plugin` (`Plugin` type).
- No GPU / vLLM-server metrics — local opencode server only.
- Every collector, the logger, and the toast call MUST degrade gracefully (return `null` / no-op, never throw out of the turn).
- Defaults (verbatim): `minTokensPerSec=10`, `ttftThresholdMs=5000`, `cpuHighPct=85`, `loadHighRatio=1.0`, `memHighPct=90`, `netHighMs=200`, `netTimeoutMs=2000`, `logPath="~/.opencode-hwtrack/events.jsonl"`.
- Config merge order: defaults < `hwtrack.config.json` < env (`HWTRACK_*`).
- Verdict labels (verbatim strings): `"LOCAL likely"`, `"NETWORK likely"`, `"BACKEND likely"`.

---

### Task 1: Project scaffold, shared types, and config loader

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/types.ts` exports: `HwtrackConfig`, `CpuInfo`, `MemInfo`, `NetInfo`, `DiskInfo`, `Snapshot`, `VerdictLabel`, `Verdict`, `TriggerType`, `Trigger`, `HwEvent` (exact definitions below — every later task imports from here).
  - `src/config.ts` exports `DEFAULTS: HwtrackConfig` and `loadConfig(env?: Record<string,string|undefined>, fileConfig?: Partial<HwtrackConfig>): HwtrackConfig`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "opencode-hwtrack",
  "version": "0.1.0",
  "description": "opencode plugin: records local server hardware when model output is slow",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "bun test", "typecheck": "tsc --noEmit" },
  "devDependencies": {
    "@opencode-ai/plugin": "latest",
    "typescript": "^5.5.0",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun", "node"],
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules
*.log
.opencode-hwtrack
```

- [ ] **Step 4: Create `src/types.ts`**

```ts
export interface HwtrackConfig {
  minTokensPerSec: number
  ttftThresholdMs: number
  vllmEndpoint: string | null
  logPath: string
  cpuHighPct: number
  loadHighRatio: number
  memHighPct: number
  netHighMs: number
  netTimeoutMs: number
}

export interface CpuInfo {
  usagePct: number
  load1: number
  load5: number
  load15: number
  cores: number
}

export interface MemInfo {
  totalMB: number
  usedMB: number
  freeMB: number
  usedPct: number
  swapUsedMB: number | null
}

export interface NetInfo {
  endpoint: string
  tcpConnectMs: number | null
  ok: boolean
}

export interface DiskInfo {
  path: string
  freeGB: number
  usedPct: number
}

export interface Snapshot {
  cpu: CpuInfo | null
  mem: MemInfo | null
  net: NetInfo | null
  disk: DiskInfo | null
}

export type VerdictLabel = "LOCAL likely" | "NETWORK likely" | "BACKEND likely"

export interface Verdict {
  label: VerdictLabel
  reasons: string[]
}

export type TriggerType = "ttft" | "tokps"

export interface Trigger {
  type: TriggerType
  sessionId: string
  tokensPerSec?: number
  ttftMs?: number
  estimated?: boolean
}

export interface HwEvent {
  ts: string
  sessionId: string
  trigger: TriggerType
  speed: { tokensPerSec?: number; ttftMs?: number; estimated?: boolean }
  snapshot: Snapshot
  verdict: Verdict
}
```

- [ ] **Step 5: Write the failing test `src/config.test.ts`**

```ts
import { test, expect } from "bun:test"
import os from "os"
import path from "path"
import { loadConfig, DEFAULTS } from "./config"

test("returns defaults when nothing supplied", () => {
  const c = loadConfig({}, {})
  expect(c.minTokensPerSec).toBe(10)
  expect(c.ttftThresholdMs).toBe(5000)
  expect(c.cpuHighPct).toBe(85)
  expect(c.vllmEndpoint).toBe(null)
})

test("file config overrides defaults", () => {
  const c = loadConfig({}, { minTokensPerSec: 25, vllmEndpoint: "10.0.0.5:8000" })
  expect(c.minTokensPerSec).toBe(25)
  expect(c.vllmEndpoint).toBe("10.0.0.5:8000")
})

test("env overrides file and defaults", () => {
  const c = loadConfig(
    { HWTRACK_MIN_TOKENS_PER_SEC: "30", HWTRACK_VLLM_ENDPOINT: "host:9000" },
    { minTokensPerSec: 25, vllmEndpoint: "10.0.0.5:8000" },
  )
  expect(c.minTokensPerSec).toBe(30)
  expect(c.vllmEndpoint).toBe("host:9000")
})

test("invalid numeric env is ignored", () => {
  const c = loadConfig({ HWTRACK_MIN_TOKENS_PER_SEC: "abc" }, {})
  expect(c.minTokensPerSec).toBe(10)
})

test("logPath ~ is expanded to home dir", () => {
  const c = loadConfig({}, {})
  expect(c.logPath).toBe(path.join(os.homedir(), ".opencode-hwtrack/events.jsonl"))
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL — cannot find module `./config`.

- [ ] **Step 7: Implement `src/config.ts`**

```ts
import os from "os"
import path from "path"
import type { HwtrackConfig } from "./types"

export const DEFAULTS: HwtrackConfig = {
  minTokensPerSec: 10,
  ttftThresholdMs: 5000,
  vllmEndpoint: null,
  logPath: "~/.opencode-hwtrack/events.jsonl",
  cpuHighPct: 85,
  loadHighRatio: 1.0,
  memHighPct: 90,
  netHighMs: 200,
  netTimeoutMs: 2000,
}

const NUM_KEYS = [
  "minTokensPerSec",
  "ttftThresholdMs",
  "cpuHighPct",
  "loadHighRatio",
  "memHighPct",
  "netHighMs",
  "netTimeoutMs",
] as const

function toEnvKey(key: string): string {
  return "HWTRACK_" + key.replace(/[A-Z]/g, (m) => "_" + m).toUpperCase()
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1))
  return p
}

export function loadConfig(
  env: Record<string, string | undefined> = {},
  fileConfig: Partial<HwtrackConfig> = {},
): HwtrackConfig {
  const merged: HwtrackConfig = { ...DEFAULTS, ...fileConfig }

  for (const key of NUM_KEYS) {
    const raw = env[toEnvKey(key)]
    if (raw !== undefined && raw !== "" && !Number.isNaN(Number(raw))) {
      ;(merged as Record<string, unknown>)[key] = Number(raw)
    }
  }

  const endpoint = env["HWTRACK_VLLM_ENDPOINT"] ?? fileConfig.vllmEndpoint ?? DEFAULTS.vllmEndpoint
  merged.vllmEndpoint = endpoint ?? null

  const lp = env["HWTRACK_LOG_PATH"] ?? merged.logPath
  merged.logPath = expandHome(lp)

  return merged
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test src/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json .gitignore src/types.ts src/config.ts src/config.test.ts
git commit -m "feat: scaffold opencode-hwtrack with types and config loader"
```

---

### Task 2: Verdict (pure function)

**Files:**
- Create: `src/verdict.ts`
- Test: `src/verdict.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `HwtrackConfig`, `Verdict` from `./types`.
- Produces: `computeVerdict(snapshot: Snapshot, config: HwtrackConfig): Verdict`.

- [ ] **Step 1: Write the failing test `src/verdict.test.ts`**

```ts
import { test, expect } from "bun:test"
import { computeVerdict } from "./verdict"
import { DEFAULTS } from "./config"
import type { Snapshot } from "./types"

const cfg = DEFAULTS

function snap(over: Partial<Snapshot>): Snapshot {
  return {
    cpu: { usagePct: 10, load1: 0.5, load5: 0.5, load15: 0.5, cores: 8 },
    mem: { totalMB: 16000, usedMB: 4000, freeMB: 12000, usedPct: 25, swapUsedMB: 0 },
    net: { endpoint: "h:8000", tcpConnectMs: 5, ok: true },
    disk: { path: "/", freeGB: 100, usedPct: 40 },
    ...over,
  }
}

test("high cpu => LOCAL likely", () => {
  const v = computeVerdict(snap({ cpu: { usagePct: 91, load1: 1, load5: 1, load15: 1, cores: 8 } }), cfg)
  expect(v.label).toBe("LOCAL likely")
  expect(v.reasons.some((r) => r.includes("cpu"))).toBe(true)
})

test("high load per core => LOCAL likely", () => {
  const v = computeVerdict(snap({ cpu: { usagePct: 10, load1: 16, load5: 10, load15: 8, cores: 8 } }), cfg)
  expect(v.label).toBe("LOCAL likely")
})

test("high mem => LOCAL likely", () => {
  const v = computeVerdict(snap({ mem: { totalMB: 16000, usedMB: 15000, freeMB: 1000, usedPct: 93, swapUsedMB: 0 } }), cfg)
  expect(v.label).toBe("LOCAL likely")
})

test("local nominal + net probe failed => NETWORK likely", () => {
  const v = computeVerdict(snap({ net: { endpoint: "h:8000", tcpConnectMs: null, ok: false } }), cfg)
  expect(v.label).toBe("NETWORK likely")
})

test("local nominal + high latency => NETWORK likely", () => {
  const v = computeVerdict(snap({ net: { endpoint: "h:8000", tcpConnectMs: 350, ok: true } }), cfg)
  expect(v.label).toBe("NETWORK likely")
})

test("everything nominal => BACKEND likely", () => {
  const v = computeVerdict(snap({}), cfg)
  expect(v.label).toBe("BACKEND likely")
})

test("nominal local with no net info => BACKEND likely (won't claim NETWORK)", () => {
  const v = computeVerdict(snap({ net: null }), cfg)
  expect(v.label).toBe("BACKEND likely")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/verdict.test.ts`
Expected: FAIL — cannot find module `./verdict`.

- [ ] **Step 3: Implement `src/verdict.ts`**

```ts
import type { HwtrackConfig, Snapshot, Verdict } from "./types"

export function computeVerdict(snapshot: Snapshot, config: HwtrackConfig): Verdict {
  const { cpu, mem, net } = snapshot
  const localReasons: string[] = []

  if (cpu && cpu.usagePct >= config.cpuHighPct) {
    localReasons.push(`cpu ${cpu.usagePct.toFixed(0)}% ≥ ${config.cpuHighPct}%`)
  }
  if (cpu && cpu.cores > 0 && cpu.load1 / cpu.cores >= config.loadHighRatio) {
    localReasons.push(`load ${(cpu.load1 / cpu.cores).toFixed(2)}/core ≥ ${config.loadHighRatio}`)
  }
  if (mem && mem.usedPct >= config.memHighPct) {
    localReasons.push(`mem ${mem.usedPct.toFixed(0)}% ≥ ${config.memHighPct}%`)
  }
  if (localReasons.length > 0) {
    return { label: "LOCAL likely", reasons: localReasons }
  }

  if (net && net.ok === false) {
    return { label: "NETWORK likely", reasons: ["vllm probe failed"] }
  }
  if (net && net.tcpConnectMs !== null && net.tcpConnectMs >= config.netHighMs) {
    return { label: "NETWORK likely", reasons: [`net ${net.tcpConnectMs.toFixed(0)}ms ≥ ${config.netHighMs}ms`] }
  }

  const reasons = ["local resources nominal"]
  if (net && net.tcpConnectMs !== null) {
    reasons.push(`net ${net.tcpConnectMs.toFixed(0)}ms < ${config.netHighMs}ms`)
  }
  return { label: "BACKEND likely", reasons }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/verdict.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/verdict.ts src/verdict.test.ts
git commit -m "feat: add verdict logic (LOCAL/NETWORK/BACKEND)"
```

---

### Task 3: Detector (slow-output state machine)

**Files:**
- Create: `src/detector.ts`
- Test: `src/detector.test.ts`

**Interfaces:**
- Consumes: `Trigger` from `./types`.
- Produces:
  - `DetectorOptions` interface: `{ minTokensPerSec: number; ttftThresholdMs: number; onTrigger: (t: Trigger) => void; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void }`.
  - `createDetector(opts: DetectorOptions): { onTurnStart(turnId: string, sessionId: string): void; onToken(turnId: string, charCount: number): void; onTurnComplete(turnId: string, outputTokens: number | null, durationSec: number | null): void }`.

- [ ] **Step 1: Write the failing test `src/detector.test.ts`**

```ts
import { test, expect } from "bun:test"
import { createDetector } from "./detector"
import type { Trigger } from "./types"

// Manual fake clock + timers so the detector is fully deterministic.
function harness(opts: { minTokensPerSec?: number; ttftThresholdMs?: number } = {}) {
  let t = 0
  let id = 0
  const timers: { fn: () => void; at: number; id: number }[] = []
  const fired: Trigger[] = []
  const now = () => t
  const setTimer = (fn: () => void, ms: number) => {
    const h = { fn, at: t + ms, id: id++ }
    timers.push(h)
    return h
  }
  const clearTimer = (h: unknown) => {
    const i = timers.indexOf(h as never)
    if (i >= 0) timers.splice(i, 1)
  }
  const advance = (ms: number) => {
    t += ms
    for (const h of [...timers]) {
      if (h.at <= t) {
        clearTimer(h)
        h.fn()
      }
    }
  }
  const detector = createDetector({
    minTokensPerSec: opts.minTokensPerSec ?? 10,
    ttftThresholdMs: opts.ttftThresholdMs ?? 5000,
    onTrigger: (tr) => fired.push(tr),
    now,
    setTimer,
    clearTimer,
  })
  return { detector, fired, advance }
}

test("fast turn fires nothing", () => {
  const h = harness()
  h.detector.onTurnStart("m1", "s1")
  h.advance(100)
  h.detector.onToken("m1", 10)
  h.detector.onTurnComplete("m1", 500, 1) // 500 tok/s
  expect(h.fired.length).toBe(0)
})

test("slow tok/s fires a tokps trigger at completion", () => {
  const h = harness()
  h.detector.onTurnStart("m1", "s1")
  h.advance(100)
  h.detector.onToken("m1", 5)
  h.detector.onTurnComplete("m1", 6, 1) // 6 tok/s < 10
  expect(h.fired.length).toBe(1)
  expect(h.fired[0].type).toBe("tokps")
  expect(h.fired[0].tokensPerSec).toBeCloseTo(6)
})

test("slow TTFT fires immediately before any token", () => {
  const h = harness({ ttftThresholdMs: 5000 })
  h.detector.onTurnStart("m1", "s1")
  h.advance(5000) // timer fires, no token yet
  expect(h.fired.length).toBe(1)
  expect(h.fired[0].type).toBe("ttft")
  expect(h.fired[0].ttftMs).toBe(5000)
})

test("first token before threshold cancels TTFT trigger", () => {
  const h = harness({ ttftThresholdMs: 5000 })
  h.detector.onTurnStart("m1", "s1")
  h.advance(1000)
  h.detector.onToken("m1", 3)
  h.advance(5000)
  expect(h.fired.some((f) => f.type === "ttft")).toBe(false)
})

test("empty/tool turn (0 output tokens) does not fire tokps", () => {
  const h = harness()
  h.detector.onTurnStart("m1", "s1")
  h.detector.onTurnComplete("m1", 0, 1)
  expect(h.fired.length).toBe(0)
})

test("missing token count estimates from chars and marks estimated", () => {
  const h = harness({ minTokensPerSec: 10 })
  h.detector.onTurnStart("m1", "s1")
  h.detector.onToken("m1", 20) // ~5 tokens
  h.detector.onTurnComplete("m1", null, 1) // 5 tok/s < 10
  expect(h.fired.length).toBe(1)
  expect(h.fired[0].estimated).toBe(true)
})

test("concurrent turns are tracked independently", () => {
  const h = harness()
  h.detector.onTurnStart("a", "s1")
  h.detector.onTurnStart("b", "s2")
  h.detector.onTurnComplete("a", 500, 1) // fast
  h.detector.onTurnComplete("b", 5, 1) // slow
  expect(h.fired.length).toBe(1)
  expect(h.fired[0].sessionId).toBe("s2")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/detector.test.ts`
Expected: FAIL — cannot find module `./detector`.

- [ ] **Step 3: Implement `src/detector.ts`**

```ts
import type { Trigger } from "./types"

export interface DetectorOptions {
  minTokensPerSec: number
  ttftThresholdMs: number
  onTrigger: (t: Trigger) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

interface TurnState {
  sessionId: string
  tStart: number
  firstTokenAt: number | null
  ttftHandle: unknown
  lastCharCount: number
}

export function createDetector(opts: DetectorOptions) {
  const now = opts.now ?? (() => Date.now())
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const turns = new Map<string, TurnState>()

  function onTurnStart(turnId: string, sessionId: string): void {
    if (turns.has(turnId)) return
    const tStart = now()
    const ttftHandle = setTimer(() => {
      const st = turns.get(turnId)
      if (!st || st.firstTokenAt !== null) return
      opts.onTrigger({ type: "ttft", sessionId, ttftMs: now() - st.tStart })
    }, opts.ttftThresholdMs)
    turns.set(turnId, { sessionId, tStart, firstTokenAt: null, ttftHandle, lastCharCount: 0 })
  }

  function onToken(turnId: string, charCount: number): void {
    const st = turns.get(turnId)
    if (!st) return
    st.lastCharCount = charCount
    if (st.firstTokenAt === null) {
      st.firstTokenAt = now()
      clearTimer(st.ttftHandle)
    }
  }

  function onTurnComplete(turnId: string, outputTokens: number | null, durationSec: number | null): void {
    const st = turns.get(turnId)
    if (!st) return
    turns.delete(turnId)
    clearTimer(st.ttftHandle)

    const dur = durationSec ?? (now() - st.tStart) / 1000
    if (dur <= 0) return

    let tokens = outputTokens
    let estimated = false
    if (tokens === null) {
      tokens = Math.round(st.lastCharCount / 4)
      estimated = true
    }
    if (tokens <= 0) return // empty / tool-only turn excluded

    const tokensPerSec = tokens / dur
    if (tokensPerSec < opts.minTokensPerSec) {
      opts.onTrigger({
        type: "tokps",
        sessionId: st.sessionId,
        tokensPerSec,
        ttftMs: st.firstTokenAt !== null ? st.firstTokenAt - st.tStart : undefined,
        estimated,
      })
    }
  }

  return { onTurnStart, onToken, onTurnComplete }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/detector.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/detector.ts src/detector.test.ts
git commit -m "feat: add slow-output detector (tok/s + live TTFT)"
```

---

### Task 4: Snapshot collectors

**Files:**
- Create: `src/snapshot.ts`
- Test: `src/snapshot.test.ts`

**Interfaces:**
- Consumes: `HwtrackConfig`, `Snapshot`, `CpuInfo`, `MemInfo`, `NetInfo`, `DiskInfo` from `./types`.
- Produces:
  - `SnapshotDeps` interface: `{ cpus: () => os.CpuInfo[]; loadavg: () => number[]; totalmem: () => number; freemem: () => number; sh: (cmd: string) => Promise<string>; tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<number | null>; sleep: (ms: number) => Promise<void> }`.
  - `tcpProbe(host: string, port: number, timeoutMs: number): Promise<number | null>` (real default probe).
  - `collectSnapshot(config: HwtrackConfig, cwd: string, deps?: Partial<SnapshotDeps>): Promise<Snapshot>`.

- [ ] **Step 1: Write the failing test `src/snapshot.test.ts`**

```ts
import { test, expect } from "bun:test"
import { collectSnapshot, type SnapshotDeps } from "./snapshot"
import { DEFAULTS } from "./config"
import type { HwtrackConfig } from "./types"
import os from "os"

function fakeCpu(idle: number, busy: number): os.CpuInfo {
  return {
    model: "x",
    speed: 1,
    times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
  } as os.CpuInfo
}

function deps(over: Partial<SnapshotDeps> = {}): Partial<SnapshotDeps> {
  let call = 0
  return {
    // first sample idle-heavy, second sample busier (50% busy delta)
    cpus: () => {
      call++
      return call === 1 ? [fakeCpu(100, 0), fakeCpu(100, 0)] : [fakeCpu(150, 50), fakeCpu(150, 50)]
    },
    loadavg: () => [1, 0.8, 0.6],
    totalmem: () => 16 * 1048576 * 1024,
    freemem: () => 8 * 1048576 * 1024,
    sh: async (cmd: string) => {
      if (cmd.startsWith("df")) return "Filesystem 1K-blocks Used Available Use% Mounted\n/dev/d 1000000 400000 600000 40% /"
      if (cmd.includes("free")) return "              total        used        free\nSwap:          2048         512        1536"
      return ""
    },
    tcpProbe: async () => 5,
    sleep: async () => {},
    ...over,
  }
}

const cfg: HwtrackConfig = { ...DEFAULTS, vllmEndpoint: "10.0.0.5:8000" }

test("collects cpu usage from two samples", async () => {
  const s = await collectSnapshot(cfg, "/", deps())
  expect(s.cpu).not.toBeNull()
  expect(s.cpu!.usagePct).toBeCloseTo(50, 0)
  expect(s.cpu!.load1).toBe(1)
  expect(s.cpu!.cores).toBe(2)
})

test("collects memory", async () => {
  const s = await collectSnapshot(cfg, "/", deps())
  expect(s.mem!.usedPct).toBeCloseTo(50, 0)
  expect(s.mem!.swapUsedMB).toBe(512)
})

test("collects net latency when endpoint configured", async () => {
  const s = await collectSnapshot(cfg, "/", deps())
  expect(s.net).toEqual({ endpoint: "10.0.0.5:8000", tcpConnectMs: 5, ok: true })
})

test("net is null when no endpoint configured", async () => {
  const s = await collectSnapshot({ ...DEFAULTS, vllmEndpoint: null }, "/", deps())
  expect(s.net).toBeNull()
})

test("net ok=false when probe fails", async () => {
  const s = await collectSnapshot(cfg, "/", deps({ tcpProbe: async () => null }))
  expect(s.net).toEqual({ endpoint: "10.0.0.5:8000", tcpConnectMs: null, ok: false })
})

test("collects disk free + used pct", async () => {
  const s = await collectSnapshot(cfg, "/", deps())
  expect(s.disk!.usedPct).toBe(40)
  expect(s.disk!.freeGB).toBeCloseTo(600000 / 1048576, 2)
})

test("a throwing collector degrades to null without failing snapshot", async () => {
  const s = await collectSnapshot(cfg, "/", deps({
    cpus: () => { throw new Error("boom") },
  }))
  expect(s.cpu).toBeNull()
  expect(s.mem).not.toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/snapshot.test.ts`
Expected: FAIL — cannot find module `./snapshot`.

- [ ] **Step 3: Implement `src/snapshot.ts`**

```ts
import os from "os"
import net from "net"
import { $ } from "bun"
import type { HwtrackConfig, Snapshot, CpuInfo, MemInfo, NetInfo, DiskInfo } from "./types"

export interface SnapshotDeps {
  cpus: () => os.CpuInfo[]
  loadavg: () => number[]
  totalmem: () => number
  freemem: () => number
  sh: (cmd: string) => Promise<string>
  tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<number | null>
  sleep: (ms: number) => Promise<void>
}

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const sock = new net.Socket()
    let done = false
    const finish = (v: number | null) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs)
    sock.once("connect", () => finish(Date.now() - start))
    sock.once("timeout", () => finish(null))
    sock.once("error", () => finish(null))
    sock.connect(port, host)
  })
}

function defaultDeps(): SnapshotDeps {
  return {
    cpus: () => os.cpus(),
    loadavg: () => os.loadavg(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    sh: async (cmd: string) => (await $`sh -c ${cmd}`.quiet()).stdout.toString(),
    tcpProbe,
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  }
}

function cpuTimes(cpus: os.CpuInfo[]): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const c of cpus) {
    for (const v of Object.values(c.times)) total += v
    idle += c.times.idle
  }
  return { idle, total }
}

async function collectCpu(d: SnapshotDeps): Promise<CpuInfo | null> {
  try {
    const a = cpuTimes(d.cpus())
    await d.sleep(200)
    const b = cpuTimes(d.cpus())
    const idleD = b.idle - a.idle
    const totalD = b.total - a.total
    const usagePct = totalD > 0 ? (1 - idleD / totalD) * 100 : 0
    const [load1, load5, load15] = d.loadavg()
    return { usagePct, load1, load5, load15, cores: d.cpus().length }
  } catch {
    return null
  }
}

async function collectMem(d: SnapshotDeps): Promise<MemInfo | null> {
  try {
    const total = d.totalmem()
    const free = d.freemem()
    const used = total - free
    let swapUsedMB: number | null = null
    try {
      const out = await d.sh("free -m 2>/dev/null || true")
      const line = out.split("\n").find((l) => /^Swap:/i.test(l.trim()))
      if (line) {
        const parts = line.trim().split(/\s+/)
        const v = Number(parts[2])
        if (!Number.isNaN(v)) swapUsedMB = v
      }
    } catch {
      /* swap optional */
    }
    return {
      totalMB: total / 1048576,
      usedMB: used / 1048576,
      freeMB: free / 1048576,
      usedPct: total > 0 ? (used / total) * 100 : 0,
      swapUsedMB,
    }
  } catch {
    return null
  }
}

function parseEndpoint(ep: string): { host: string; port: number } | null {
  try {
    const s = ep.includes("://") ? ep : "tcp://" + ep
    const u = new URL(s)
    if (!u.hostname) return null
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
    return { host: u.hostname, port }
  } catch {
    return null
  }
}

async function collectNet(d: SnapshotDeps, config: HwtrackConfig): Promise<NetInfo | null> {
  try {
    if (!config.vllmEndpoint) return null
    const parsed = parseEndpoint(config.vllmEndpoint)
    if (!parsed) return null
    const ms = await d.tcpProbe(parsed.host, parsed.port, config.netTimeoutMs)
    return { endpoint: `${parsed.host}:${parsed.port}`, tcpConnectMs: ms, ok: ms !== null }
  } catch {
    return null
  }
}

async function collectDisk(d: SnapshotDeps, cwd: string): Promise<DiskInfo | null> {
  try {
    const out = await d.sh(`df -k ${JSON.stringify(cwd)}`)
    const lines = out.trim().split("\n")
    const last = lines[lines.length - 1].trim().split(/\s+/)
    const availKB = Number(last[3])
    const usedPct = Number(String(last[4]).replace("%", ""))
    if (Number.isNaN(availKB) || Number.isNaN(usedPct)) return null
    return { path: cwd, freeGB: availKB / 1048576, usedPct }
  } catch {
    return null
  }
}

export async function collectSnapshot(
  config: HwtrackConfig,
  cwd: string,
  deps?: Partial<SnapshotDeps>,
): Promise<Snapshot> {
  const d: SnapshotDeps = { ...defaultDeps(), ...deps }
  const [cpu, mem, netInfo, disk] = await Promise.all([
    collectCpu(d),
    collectMem(d),
    collectNet(d, config),
    collectDisk(d, cwd),
  ])
  return { cpu, mem, net: netInfo, disk }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/snapshot.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.ts src/snapshot.test.ts
git commit -m "feat: add local hardware snapshot collectors"
```

---

### Task 5: JSONL logger

**Files:**
- Create: `src/logger.ts`
- Test: `src/logger.test.ts`

**Interfaces:**
- Consumes: `HwEvent` from `./types`.
- Produces: `appendEvent(logPath: string, event: HwEvent): Promise<void>`.

- [ ] **Step 1: Write the failing test `src/logger.test.ts`**

```ts
import { test, expect } from "bun:test"
import { appendEvent } from "./logger"
import type { HwEvent } from "./types"
import fs from "fs/promises"
import os from "os"
import path from "path"

function sampleEvent(): HwEvent {
  return {
    ts: "2026-06-23T10:15:03.221Z",
    sessionId: "ses_abc",
    trigger: "tokps",
    speed: { tokensPerSec: 6.1, estimated: false },
    snapshot: { cpu: null, mem: null, net: null, disk: null },
    verdict: { label: "BACKEND likely", reasons: ["local resources nominal"] },
  }
}

test("creates missing dir and appends a valid JSON line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hwtrack-"))
  const logPath = path.join(dir, "nested", "events.jsonl")
  await appendEvent(logPath, sampleEvent())
  await appendEvent(logPath, sampleEvent())
  const content = await fs.readFile(logPath, "utf8")
  const lines = content.trim().split("\n")
  expect(lines.length).toBe(2)
  expect(JSON.parse(lines[0]).verdict.label).toBe("BACKEND likely")
  await fs.rm(dir, { recursive: true, force: true })
})

test("does not throw on unwritable path", async () => {
  // a path whose parent is a file, not a dir -> mkdir fails; appendEvent must swallow
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hwtrack-"))
  const filePath = path.join(dir, "afile")
  await fs.writeFile(filePath, "x")
  const badPath = path.join(filePath, "events.jsonl")
  await appendEvent(badPath, sampleEvent()) // must resolve without throwing
  await fs.rm(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/logger.test.ts`
Expected: FAIL — cannot find module `./logger`.

- [ ] **Step 3: Implement `src/logger.ts`**

```ts
import fs from "fs/promises"
import path from "path"
import type { HwEvent } from "./types"

export async function appendEvent(logPath: string, event: HwEvent): Promise<void> {
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.appendFile(logPath, JSON.stringify(event) + "\n", "utf8")
  } catch (e) {
    console.error("[hwtrack] failed to write log:", e)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/logger.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/logger.ts src/logger.test.ts
git commit -m "feat: add JSONL event logger"
```

---

### Task 6: TUI warning formatter

**Files:**
- Create: `src/warning.ts`
- Test: `src/warning.test.ts`

**Interfaces:**
- Consumes: `HwEvent` from `./types`.
- Produces:
  - `formatWarning(event: HwEvent): string`.
  - `showWarning(showToast: (msg: string) => Promise<void>, msg: string): Promise<void>`.

- [ ] **Step 1: Write the failing test `src/warning.test.ts`**

```ts
import { test, expect } from "bun:test"
import { formatWarning, showWarning } from "./warning"
import type { HwEvent } from "./types"

function ev(over: Partial<HwEvent> = {}): HwEvent {
  return {
    ts: "t",
    sessionId: "s",
    trigger: "tokps",
    speed: { tokensPerSec: 6.1 },
    snapshot: {
      cpu: { usagePct: 12, load1: 1, load5: 1, load15: 1, cores: 8 },
      mem: null,
      net: { endpoint: "h:8000", tcpConnectMs: 4, ok: true },
      disk: null,
    },
    verdict: { label: "BACKEND likely", reasons: [] },
    ...over,
  }
}

test("formats a tok/s warning with cpu, net and verdict", () => {
  const s = formatWarning(ev())
  expect(s).toContain("6.1 tok/s")
  expect(s).toContain("CPU 12%")
  expect(s).toContain("net 4ms")
  expect(s).toContain("BACKEND likely")
})

test("formats a TTFT warning", () => {
  const s = formatWarning(ev({ trigger: "ttft", speed: { ttftMs: 5200 } }))
  expect(s).toContain("TTFT 5.2s")
})

test("showWarning swallows toast errors", async () => {
  let called = false
  await showWarning(async () => {
    called = true
    throw new Error("toast boom")
  }, "hi")
  expect(called).toBe(true) // resolved despite throw
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/warning.test.ts`
Expected: FAIL — cannot find module `./warning`.

- [ ] **Step 3: Implement `src/warning.ts`**

```ts
import type { HwEvent } from "./types"

export function formatWarning(event: HwEvent): string {
  const parts: string[] = ["⚠"]

  if (event.trigger === "tokps" && event.speed.tokensPerSec !== undefined) {
    parts.push(`Slow ${event.speed.tokensPerSec.toFixed(1)} tok/s`)
  } else if (event.trigger === "ttft" && event.speed.ttftMs !== undefined) {
    parts.push(`TTFT ${(event.speed.ttftMs / 1000).toFixed(1)}s`)
  }

  const s = event.snapshot
  const bits: string[] = []
  if (s.cpu) bits.push(`CPU ${s.cpu.usagePct.toFixed(0)}%`)
  if (s.mem) bits.push(`RAM ${s.mem.usedPct.toFixed(0)}%`)
  if (s.net && s.net.tcpConnectMs !== null) bits.push(`net ${s.net.tcpConnectMs.toFixed(0)}ms`)
  if (bits.length) parts.push("· " + bits.join(" "))

  parts.push(`→ ${event.verdict.label}`)
  return parts.join(" ")
}

export async function showWarning(
  showToast: (msg: string) => Promise<void>,
  msg: string,
): Promise<void> {
  try {
    await showToast(msg)
  } catch (e) {
    console.error("[hwtrack] toast failed:", e)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/warning.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/warning.ts src/warning.test.ts
git commit -m "feat: add TUI warning formatter"
```

---

### Task 7: Plugin entry wiring + integration + README

**Files:**
- Create: `src/index.ts`
- Create: `src/readFileConfig.ts`
- Test: `src/readFileConfig.test.ts`
- Create: `README.md`
- Create: `hwtrack.config.example.json`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `createDetector` (Task 3), `collectSnapshot` (Task 4), `computeVerdict` (Task 2), `appendEvent` (Task 5), `formatWarning`/`showWarning` (Task 6); types `HwEvent`, `Trigger` from `./types`.
- Produces: `readFileConfig(dir: string): Partial<HwtrackConfig>`; default export `HwtrackPlugin: Plugin`.

> **Integration note:** opencode's exact event payload shapes (`message.updated`, `message.part.updated`) and the TUI-toast client method are not fully documented. The extraction in `index.ts` is defensive (tries common property names) and MUST be confirmed against a live opencode session in Step 7. Only `index.ts`'s opencode bindings are unverified by unit tests — every imported module is already tested.

- [ ] **Step 1: Write the failing test `src/readFileConfig.test.ts`**

```ts
import { test, expect } from "bun:test"
import { readFileConfig } from "./readFileConfig"
import fs from "fs/promises"
import os from "os"
import path from "path"

test("reads hwtrack.config.json from dir", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hwtrack-cfg-"))
  await fs.writeFile(path.join(dir, "hwtrack.config.json"), JSON.stringify({ minTokensPerSec: 42 }))
  const c = readFileConfig(dir)
  expect(c.minTokensPerSec).toBe(42)
  await fs.rm(dir, { recursive: true, force: true })
})

test("returns empty object when file missing or invalid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hwtrack-cfg-"))
  expect(readFileConfig(dir)).toEqual({})
  await fs.writeFile(path.join(dir, "hwtrack.config.json"), "{not json")
  expect(readFileConfig(dir)).toEqual({})
  await fs.rm(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/readFileConfig.test.ts`
Expected: FAIL — cannot find module `./readFileConfig`.

- [ ] **Step 3: Implement `src/readFileConfig.ts`**

```ts
import fs from "fs"
import path from "path"
import type { HwtrackConfig } from "./types"

export function readFileConfig(dir: string): Partial<HwtrackConfig> {
  const candidates = [path.join(dir, "hwtrack.config.json")]
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<HwtrackConfig>
    } catch {
      /* try next */
    }
  }
  return {}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/readFileConfig.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `src/index.ts`**

```ts
import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { readFileConfig } from "./readFileConfig"
import { createDetector } from "./detector"
import { collectSnapshot } from "./snapshot"
import { computeVerdict } from "./verdict"
import { appendEvent } from "./logger"
import { formatWarning, showWarning } from "./warning"
import type { HwEvent, Trigger } from "./types"

export const HwtrackPlugin: Plugin = async ({ client, directory }) => {
  const cwd = directory ?? process.cwd()
  const config = loadConfig(process.env as Record<string, string | undefined>, readFileConfig(cwd))

  const showToast = async (msg: string) => {
    // Confirm the exact SDK method against a live session (Step 7).
    const c = client as unknown as {
      tui?: { showToast?: (a: unknown) => Promise<unknown> }
    }
    if (c.tui?.showToast) {
      await c.tui.showToast({ body: msg, variant: "warning", title: "hwtrack" })
    } else {
      console.error("[hwtrack]", msg)
    }
  }

  const handleTrigger = async (t: Trigger) => {
    const snapshot = await collectSnapshot(config, cwd)
    const verdict = computeVerdict(snapshot, config)
    const event: HwEvent = {
      ts: new Date().toISOString(),
      sessionId: t.sessionId,
      trigger: t.type,
      speed: { tokensPerSec: t.tokensPerSec, ttftMs: t.ttftMs, estimated: t.estimated },
      snapshot,
      verdict,
    }
    await appendEvent(config.logPath, event)
    await showWarning(showToast, formatWarning(event))
  }

  const detector = createDetector({
    minTokensPerSec: config.minTokensPerSec,
    ttftThresholdMs: config.ttftThresholdMs,
    onTrigger: (t) => {
      handleTrigger(t).catch((e) => console.error("[hwtrack] handleTrigger:", e))
    },
  })

  return {
    event: async ({ event }: { event: { type?: string; properties?: Record<string, unknown> } }) => {
      try {
        const type = event?.type
        const props = (event?.properties ?? {}) as Record<string, unknown>

        if (type === "message.updated") {
          const msg = (props.info ?? props.message ?? props) as Record<string, unknown>
          if (msg?.role === "assistant" && typeof msg.id === "string") {
            const turnId = msg.id
            const sessionId = (msg.sessionID ?? msg.sessionId ?? "unknown") as string
            const time = (msg.time ?? {}) as { created?: number; completed?: number }
            if (!time.completed) {
              detector.onTurnStart(turnId, sessionId)
            } else {
              const tokens = (msg.tokens ?? {}) as { output?: number }
              const outTok = typeof tokens.output === "number" ? tokens.output : null
              const dur =
                time.created && time.completed ? (time.completed - time.created) / 1000 : null
              detector.onTurnComplete(turnId, outTok, dur)
            }
          }
        } else if (type === "message.part.updated") {
          const part = (props.part ?? props) as Record<string, unknown>
          const turnId = (part.messageID ?? part.messageId) as string | undefined
          if (part?.type === "text" && typeof part.text === "string" && turnId) {
            detector.onToken(turnId, part.text.length)
          }
        }
      } catch (e) {
        console.error("[hwtrack] event handler:", e)
      }
    },
  }
}

export default HwtrackPlugin
```

- [ ] **Step 6: Typecheck and run the full unit suite**

Run: `bun install && bun run typecheck && bun test`
Expected: typecheck passes; all suites green (config 5, verdict 7, detector 7, snapshot 7, logger 2, warning 3, readFileConfig 2).

- [ ] **Step 7: Manual integration test in opencode**

1. Link the plugin so opencode loads it (global): `mkdir -p ~/.config/opencode/plugins && ln -s "$(pwd)" ~/.config/opencode/plugins/opencode-hwtrack` (or copy into a project's `.opencode/plugins/`).
2. Set the endpoint: create `hwtrack.config.json` in the project with `{ "vllmEndpoint": "<your-vllm-host>:<port>", "minTokensPerSec": 10, "ttftThresholdMs": 5000 }`.
3. Start opencode and run a normal prompt. Confirm **no** warning on a fast turn and **no** new JSONL line.
4. Force a slow turn: temporarily set `minTokensPerSec` very high (e.g. `100000`) so any turn triggers `tokps`. Run a prompt.
5. Verify: a toast appears bottom-right, AND a new line is appended to `~/.opencode-hwtrack/events.jsonl` with populated `snapshot` and a `verdict`.
6. `cat ~/.opencode-hwtrack/events.jsonl | tail -1 | python3 -m json.tool` — confirm fields: `ts`, `sessionId`, `trigger`, `speed`, `snapshot.{cpu,mem,net,disk}`, `verdict.label`.
7. **If the toast does not appear or `sessionId`/tokens are `"unknown"`/`null`:** the opencode payload shape differs. Inspect actual events by temporarily adding `console.error("[hwtrack] EVT", JSON.stringify(event))` at the top of the `event` handler, read the real property names from opencode's logs, and adjust the extraction in `index.ts` Step 5 (the property-name fallbacks: `info`/`message`, `sessionID`/`sessionId`, `messageID`/`messageId`, `tokens.output`, `time.created`/`time.completed`) and the `showToast` method name accordingly. Re-run from sub-step 3.
8. Restore `minTokensPerSec` to `10`.

- [ ] **Step 8: Write `hwtrack.config.example.json`**

```json
{
  "vllmEndpoint": "10.0.0.5:8000",
  "minTokensPerSec": 10,
  "ttftThresholdMs": 5000,
  "cpuHighPct": 85,
  "loadHighRatio": 1.0,
  "memHighPct": 90,
  "netHighMs": 200,
  "netTimeoutMs": 2000,
  "logPath": "~/.opencode-hwtrack/events.jsonl"
}
```

- [ ] **Step 9: Write `README.md`**

Document: what the plugin does (records local server hardware when output is slow to tell LOCAL vs NETWORK vs BACKEND), the GPU-out-of-scope rationale, install (symlink/copy into `~/.config/opencode/plugins/` or project `.opencode/plugins/`, set `vllmEndpoint`), config table (copy the Global Constraints defaults), the JSONL event shape, and how to read the log. Note the toast-persistence caveat.

- [ ] **Step 10: Commit**

```bash
git add src/index.ts src/readFileConfig.ts src/readFileConfig.test.ts README.md hwtrack.config.example.json
git commit -m "feat: wire opencode plugin entry, config file, docs"
```

---

## Self-Review

**Spec coverage:**
- Purpose / verdict logic → Task 2 (`verdict.ts`), verdict surfaced in log + toast (Tasks 5, 6, 7). ✓
- Detection (TTFT live + tok/s at completion, edge cases: empty turns, missing tokens→estimate, concurrent turns) → Task 3. ✓
- Snapshot (CPU/load, RAM+swap, net latency, disk; graceful degradation) → Task 4. ✓
- JSONL log → Task 5. ✓
- TUI refreshing warning + toast-persistence caveat → Task 6 + Task 7 (re-shown on each event) + README. ✓
- Config (defaults < file < env, all keys) → Task 1 + Task 7 (`readFileConfig`). ✓
- Error handling (collectors/logger/toast never crash the turn) → Tasks 4/5/6 tests + Task 7 try/catch. ✓
- Testing plan per module → Tasks 1–7 each ship tests. ✓
- Non-goal (no GPU metrics) → honored; snapshot is local-only. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; README step enumerates exact contents rather than "write docs". ✓

**Type consistency:** `HwtrackConfig`, `Snapshot`, `Trigger`, `HwEvent`, `Verdict` defined once in `types.ts`; `computeVerdict(snapshot, config)`, `createDetector(opts)` returning `{onTurnStart,onToken,onTurnComplete}`, `collectSnapshot(config, cwd, deps?)`, `appendEvent(logPath, event)`, `formatWarning(event)`/`showWarning(showToast,msg)`, `loadConfig(env, fileConfig)`, `readFileConfig(dir)` — names/signatures match across all tasks and `index.ts`. ✓
