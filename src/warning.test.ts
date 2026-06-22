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
