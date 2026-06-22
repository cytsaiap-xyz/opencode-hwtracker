import type { HwEvent } from "./types"

export function formatWarning(event: HwEvent): string {
  const parts: string[] = ["⚠"]

  if (event.trigger === "tokps" && event.speed.tokensPerSec !== undefined) {
    parts.push(`Slow ${event.speed.tokensPerSec.toFixed(1)} tok/s`)
  } else if (event.trigger === "ttft" && event.speed.ttftMs !== undefined) {
    parts.push(`TTFT ${(event.speed.ttftMs / 1000).toFixed(1)}s`)
  }

  const s = event.snapshot
  const bits: string[] = []
  if (s.cpu) bits.push(`CPU ${s.cpu.usagePct.toFixed(0)}%`)
  if (s.mem) bits.push(`RAM ${s.mem.usedPct.toFixed(0)}%`)
  if (s.net && s.net.tcpConnectMs !== null) bits.push(`net ${s.net.tcpConnectMs.toFixed(0)}ms`)
  if (bits.length) parts.push("· " + bits.join(" "))

  parts.push(`→ ${event.verdict.label}`)
  return parts.join(" ")
}

export async function showWarning(
  showToast: (msg: string) => Promise<void>,
  msg: string,
): Promise<void> {
  try {
    await showToast(msg)
  } catch (e) {
    console.error("[hwtrack] toast failed:", e)
  }
}
