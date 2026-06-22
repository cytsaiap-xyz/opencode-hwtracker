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

test("net ok=false when probe throws", async () => {
  const s = await collectSnapshot(cfg, "/", deps({ tcpProbe: async () => { throw new Error("boom") } }))
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
