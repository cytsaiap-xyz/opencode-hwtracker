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
