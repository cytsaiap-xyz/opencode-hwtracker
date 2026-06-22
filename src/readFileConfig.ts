import fs from "fs"
import path from "path"
import type { HwtrackConfig } from "./types"

export function readFileConfig(dir: string): Partial<HwtrackConfig> {
  const candidates = [path.join(dir, "hwtrack.config.json")]
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as Partial<HwtrackConfig>
    } catch {
      /* try next */
    }
  }
  return {}
}
