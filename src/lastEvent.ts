import fs from "fs"
import type { HwEvent } from "./types"

/** Reads the most recent JSONL event from the log, or null if none / unreadable. */
export function readLastEvent(logPath: string): HwEvent | null {
  try {
    const data = fs.readFileSync(logPath, "utf8").trim()
    if (!data) return null
    const lastLine = data.slice(data.lastIndexOf("\n") + 1)
    return JSON.parse(lastLine) as HwEvent
  } catch {
    return null
  }
}
