import { test, expect } from "bun:test"
import os from "os"
import path from "path"
import { loadConfig, DEFAULTS } from "./config"

test("returns defaults when nothing supplied", () => {
  const c = loadConfig({}, {})
  expect(c.minTokensPerSec).toBe(10)
  expect(c.ttftThresholdMs).toBe(5000)
  expect(c.cpuHighPct).toBe(85)
})

test("file config overrides defaults", () => {
  const c = loadConfig({}, { minTokensPerSec: 25 })
  expect(c.minTokensPerSec).toBe(25)
})

test("env overrides file and defaults", () => {
  const c = loadConfig(
    { HWTRACK_MIN_TOKENS_PER_SEC: "30", HWTRACK_TTFT_THRESHOLD_MS: "30" },
    { minTokensPerSec: 25, ttftThresholdMs: 1000 },
  )
  expect(c.minTokensPerSec).toBe(30)
  expect(c.ttftThresholdMs).toBe(30)
})

test("invalid numeric env is ignored", () => {
  const c = loadConfig({ HWTRACK_MIN_TOKENS_PER_SEC: "abc" }, {})
  expect(c.minTokensPerSec).toBe(10)
})

test("logPath ~ is expanded to home dir", () => {
  const c = loadConfig({}, {})
  expect(c.logPath).toBe(path.join(os.homedir(), ".opencode-hwtrack/events.jsonl"))
})
