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
