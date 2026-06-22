import fs from "fs"
import path from "path"
import type { HwtrackConfig } from "./types"

export function readFileConfig(dir: string): Partial<HwtrackConfig> {
  const candidates = [path.join(dir, "hwtrack.config.json")]
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Partial<HwtrackConfig>
      }
    } catch {
      /* try next */
    }
  }
  return {}
}
