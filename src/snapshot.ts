import os from "os"
import { $ } from "bun"
import type { HwtrackConfig, Snapshot, CpuInfo, MemInfo, DiskInfo } from "./types"

export interface SnapshotDeps {
  cpus: () => os.CpuInfo[]
  loadavg: () => number[]
  totalmem: () => number
  freemem: () => number
  sh: (cmd: string) => Promise<string>
  sleep: (ms: number) => Promise<void>
}

function defaultDeps(): SnapshotDeps {
  return {
    cpus: () => os.cpus(),
    loadavg: () => os.loadavg(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    sh: async (cmd: string) => (await $`sh -c ${cmd}`.quiet()).stdout.toString(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  }
}

function cpuTimes(cpus: os.CpuInfo[]): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const c of cpus) {
    for (const v of Object.values(c.times)) total += v
    idle += c.times.idle
  }
  return { idle, total }
}

async function collectCpu(d: SnapshotDeps): Promise<CpuInfo | null> {
  try {
    const first = d.cpus()
    const a = cpuTimes(first)
    await d.sleep(200)
    const b = cpuTimes(d.cpus())
    const idleD = b.idle - a.idle
    const totalD = b.total - a.total
    const usagePct = totalD > 0 ? (1 - idleD / totalD) * 100 : 0
    const [load1, load5, load15] = d.loadavg()
    return { usagePct, load1, load5, load15, cores: first.length }
  } catch {
    return null
  }
}

async function collectMem(d: SnapshotDeps): Promise<MemInfo | null> {
  try {
    const total = d.totalmem()
    const free = d.freemem()
    const used = total - free
    let swapUsedMB: number | null = null
    try {
      const out = await d.sh("free -m 2>/dev/null || true")
      const line = out.split("\n").find((l) => /^Swap:/i.test(l.trim()))
      if (line) {
        const parts = line.trim().split(/\s+/)
        const v = Number(parts[2])
        if (!Number.isNaN(v)) swapUsedMB = v
      }
    } catch {
      /* swap optional */
    }
    return {
      totalMB: total / 1048576,
      usedMB: used / 1048576,
      freeMB: free / 1048576,
      usedPct: total > 0 ? (used / total) * 100 : 0,
      swapUsedMB,
    }
  } catch {
    return null
  }
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

async function collectDisk(d: SnapshotDeps, cwd: string): Promise<DiskInfo | null> {
  try {
    const out = await d.sh(`df -k ${shellQuote(cwd)}`)
    const lines = out.trim().split("\n")
    const last = lines[lines.length - 1].trim().split(/\s+/)
    const availKB = Number(last[3])
    const usedPct = Number(String(last[4]).replace("%", ""))
    if (Number.isNaN(availKB) || Number.isNaN(usedPct)) return null
    return { path: cwd, freeGB: availKB / 1048576, usedPct }
  } catch {
    return null
  }
}

export async function collectSnapshot(
  config: HwtrackConfig,
  cwd: string,
  deps?: Partial<SnapshotDeps>,
): Promise<Snapshot> {
  const d: SnapshotDeps = { ...defaultDeps(), ...deps }
  const [cpu, mem, disk] = await Promise.all([
    collectCpu(d),
    collectMem(d),
    collectDisk(d, cwd),
  ])
  return { cpu, mem, disk }
}
