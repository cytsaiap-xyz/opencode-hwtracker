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
