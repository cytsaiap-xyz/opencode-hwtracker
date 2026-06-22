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
