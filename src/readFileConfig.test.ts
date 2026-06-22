import { test, expect } from "bun:test"
import { readFileConfig } from "./readFileConfig"
import fs from "fs/promises"
import os from "os"
import path from "path"

test("reads hwtrack.config.json from dir", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hwtrack-cfg-"))
  await fs.writeFile(path.join(dir, "hwtrack.config.json"), JSON.stringify({ minTokensPerSec: 42 }))
  const c = readFileConfig(dir)
  expect(c.minTokensPerSec).toBe(42)
  await fs.rm(dir, { recursive: true, force: true })
})

test("returns empty object when file missing or invalid", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hwtrack-cfg-"))
  expect(readFileConfig(dir)).toEqual({})
  await fs.writeFile(path.join(dir, "hwtrack.config.json"), "{not json")
  expect(readFileConfig(dir)).toEqual({})
  await fs.rm(dir, { recursive: true, force: true })
})
