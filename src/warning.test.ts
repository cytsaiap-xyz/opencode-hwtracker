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

test("output starts with ⚠ warning symbol", () => {
  const s = formatWarning(ev())
  expect(s.startsWith("⚠")).toBe(true)
})

test("tokps output contains Slow prefix", () => {
  const s = formatWarning(ev({ trigger: "tokps", speed: { tokensPerSec: 6.1 } }))
  expect(s).toContain("Slow 6.1 tok/s")
})

test("RAM branch with memory snapshot", () => {
  const s = formatWarning(
    ev({
      snapshot: {
        cpu: null,
        mem: { totalMB: 16000, usedMB: 8800, freeMB: 7200, usedPct: 55, swapUsedMB: 0 },
        net: { endpoint: "h:8000", tcpConnectMs: 4, ok: true },
        disk: null,
      },
    }),
  )
  expect(s).toContain("RAM 55%")
})

test("null tcpConnectMs guard omits net segment", () => {
  const s = formatWarning(
    ev({
      snapshot: {
        cpu: null,
        mem: null,
        net: { endpoint: "h:8000", tcpConnectMs: null, ok: false },
        disk: null,
      },
    }),
  )
  expect(s).not.toContain("net ")
})

test("verdict rendered with arrow at end", () => {
  const s = formatWarning(ev())
  expect(s).toContain("→ BACKEND likely")
})

test("all-null snapshot yields clean string without stray separator", () => {
  const s = formatWarning(
    ev({
      snapshot: {
        cpu: null,
        mem: null,
        net: null,
        disk: null,
      },
    }),
  )
  expect(s).not.toContain("· ")
  expect(s).toContain("→ BACKEND likely")
})
