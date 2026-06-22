import fs from "fs/promises"
import path from "path"
import type { HwEvent } from "./types"

export async function appendEvent(logPath: string, event: HwEvent): Promise<void> {
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await fs.appendFile(logPath, JSON.stringify(event) + "\n", "utf8")
  } catch (e) {
    console.error("[hwtrack] failed to write log:", e)
  }
}
