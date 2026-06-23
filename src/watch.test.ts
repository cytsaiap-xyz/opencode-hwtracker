import { test, expect } from "bun:test"
import { renderPanel, readLastEvent } from "./watch"
import { DEFAULTS } from "./config"
import type { Snapshot, HwEvent } from "./types"
import fs from "fs/promises"
import os from "os"
import path from "path"

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cpu: { usagePct: 12, load1: 1.2, load5: 1, load15: 0.8, cores: 8 },
    mem: { totalMB: 16000, usedMB: 4000, freeMB: 12000, usedPct: 25, swapUsedMB: 0 },
    disk: { path: "/", freeGB: 200, usedPct: 40 },
    ...over,
  }
}

test("renders current CPU/RAM/disk values", () => {
  const out = renderPanel(snap(), null, DEFAULTS, "2026-06-23T00:00:00.000Z")
  expect(out).toContain("CPU")
  expect(out).toContain("RAM")
  expect(out).toContain("Disk")
  expect(out).toContain("12%")
})

test("marks a metric HIGH when over threshold", () => {
  const out = renderPanel(
    snap({ cpu: { usagePct: 95, load1: 16, load5: 10, load15: 8, cores: 8 } }),
    null,
    DEFAULTS,
    "t",
  )
  expect(out).toContain("HIGH")
})

test("nominal hardware shows no HIGH marker", () => {
  const out = renderPanel(snap(), null, DEFAULTS, "t")
  expect(out).not.toContain("HIGH")
})

test("shows 'none yet' when there is no slow event", () => {
  const out = renderPanel(snap(), null, DEFAULTS, "t")
  expect(out).toContain("none yet")
})

test("shows the latest slow event with verdict", () => {
  const last: HwEvent = {
    ts: "2026-06-23T01:02:03.000Z",
    sessionId: "s",
    trigger: "tokps",
    speed: { tokensPerSec: 6.1 },
    snapshot: snap(),
    verdict: { label: "LOCAL likely", reasons: [] },
  }
  const out = renderPanel(snap(), last, DEFAULTS, "t")
  expect(out).toContain("6.1 tok/s")
  expect(out).toContain("LOCAL likely")
})

test("handles null collectors gracefully", () => {
  const out = renderPanel({ cpu: null, mem: null, disk: null }, null, DEFAULTS, "t")
  expect(out).toContain("CPU  n/a")
  expect(out).toContain("RAM  n/a")
  expect(out).toContain("Disk n/a")
})

test("readLastEvent returns the last line, or null when missing/empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hwwatch-"))
  const p = path.join(dir, "events.jsonl")
  expect(readLastEvent(p)).toBeNull() // missing file
  const e1 = { ts: "a", verdict: { label: "BACKEND likely" } }
  const e2 = { ts: "b", verdict: { label: "LOCAL likely" } }
  await fs.writeFile(p, JSON.stringify(e1) + "\n" + JSON.stringify(e2) + "\n")
  expect(readLastEvent(p)?.ts).toBe("b")
  await fs.rm(dir, { recursive: true, force: true })
})
