import fs from "fs"
import { loadConfig } from "./config"
import { readFileConfig } from "./readFileConfig"
import { collectSnapshot } from "./snapshot"
import type { Snapshot, HwEvent, HwtrackConfig } from "./types"

function bar(p: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, p))
  const filled = Math.round((clamped / 100) * width)
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]"
}

function pct(n: number): string {
  return `${n.toFixed(0).padStart(3)}%`
}

/** Pure renderer — produces the panel text (no terminal control codes). */
export function renderPanel(
  s: Snapshot,
  last: HwEvent | null,
  config: HwtrackConfig,
  nowIso: string,
): string {
  const lines: string[] = []
  lines.push("opencode-hwtracker — live local hardware")
  lines.push(nowIso)
  lines.push("")

  if (s.cpu) {
    const high = s.cpu.usagePct >= config.cpuHighPct
    lines.push(`CPU  ${bar(s.cpu.usagePct)} ${pct(s.cpu.usagePct)}${high ? "  HIGH" : ""}`)
    const ratio = s.cpu.cores > 0 ? s.cpu.load1 / s.cpu.cores : 0
    const loadHigh = ratio >= config.loadHighRatio
    lines.push(
      `load ${s.cpu.load1.toFixed(2)} (1m) / ${s.cpu.cores} cores = ${ratio.toFixed(2)}/core${loadHigh ? "  HIGH" : ""}`,
    )
  } else {
    lines.push("CPU  n/a")
  }

  if (s.mem) {
    const high = s.mem.usedPct >= config.memHighPct
    lines.push(
      `RAM  ${bar(s.mem.usedPct)} ${pct(s.mem.usedPct)}${high ? "  HIGH" : ""}  (${(s.mem.usedMB / 1024).toFixed(1)}/${(s.mem.totalMB / 1024).toFixed(1)} GB)`,
    )
  } else {
    lines.push("RAM  n/a")
  }

  if (s.disk) {
    const high = s.disk.usedPct >= 90
    lines.push(
      `Disk ${bar(s.disk.usedPct)} ${pct(s.disk.usedPct)}${high ? "  HIGH" : ""}  (${s.disk.freeGB.toFixed(0)} GB free)`,
    )
  } else {
    lines.push("Disk n/a")
  }

  lines.push("")
  lines.push("Last slow-output event:")
  if (!last) {
    lines.push("  (none yet — quiet so far)")
  } else {
    const speed =
      last.speed.tokensPerSec != null
        ? `${last.speed.tokensPerSec.toFixed(1)} tok/s`
        : last.speed.ttftMs != null
          ? `TTFT ${(last.speed.ttftMs / 1000).toFixed(1)}s`
          : "—"
    lines.push(`  ${last.ts}`)
    lines.push(`  ${last.trigger}: ${speed} -> ${last.verdict.label}`)
  }

  lines.push("")
  lines.push("(Ctrl-C to quit)")
  return lines.join("\n")
}

/** Reads the most recent JSONL event, or null if none / unreadable. */
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

async function main(): Promise<void> {
  const cwd = process.cwd()
  const config = loadConfig(process.env as Record<string, string | undefined>, readFileConfig(cwd))
  const intervalMs = (Number(process.env.HWTRACK_WATCH_INTERVAL) || 2) * 1000

  process.stdout.write("\x1b[?25l") // hide cursor
  const cleanup = () => {
    process.stdout.write("\x1b[?25h\n") // restore cursor
    process.exit(0)
  }
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  for (;;) {
    const snap = await collectSnapshot(config, cwd)
    const last = readLastEvent(config.logPath)
    const panel = renderPanel(snap, last, config, new Date().toISOString())
    process.stdout.write("\x1b[2J\x1b[H" + panel + "\n") // clear + home + draw
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// Only run the loop when executed directly (not when imported by tests).
if (import.meta.main) {
  void main()
}
