import { test, expect } from "bun:test"
import { readLastEvent } from "./lastEvent"
import fs from "fs/promises"
import os from "os"
import path from "path"

test("readLastEvent returns the last line, or null when missing/empty", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hwlast-"))
  const p = path.join(dir, "events.jsonl")
  expect(readLastEvent(p)).toBeNull() // missing file
  const e1 = { ts: "a", verdict: { label: "BACKEND likely" } }
  const e2 = { ts: "b", verdict: { label: "LOCAL likely" } }
  await fs.writeFile(p, JSON.stringify(e1) + "\n" + JSON.stringify(e2) + "\n")
  expect(readLastEvent(p)?.ts).toBe("b")
  await fs.rm(dir, { recursive: true, force: true })
})
