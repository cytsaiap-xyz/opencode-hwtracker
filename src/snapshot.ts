import os from "os"
import net from "net"
import { $ } from "bun"
import type { HwtrackConfig, Snapshot, CpuInfo, MemInfo, NetInfo, DiskInfo } from "./types"

export interface SnapshotDeps {
  cpus: () => os.CpuInfo[]
  loadavg: () => number[]
  totalmem: () => number
  freemem: () => number
  sh: (cmd: string) => Promise<string>
  tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<number | null>
  sleep: (ms: number) => Promise<void>
}

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const sock = new net.Socket()
    let done = false
    const finish = (v: number | null) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeoutMs)
    sock.once("connect", () => finish(Date.now() - start))
    sock.once("timeout", () => finish(null))
    sock.once("error", () => finish(null))
    sock.connect(port, host)
  })
}

function defaultDeps(): SnapshotDeps {
  return {
    cpus: () => os.cpus(),
    loadavg: () => os.loadavg(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    sh: async (cmd: string) => (await $`sh -c ${cmd}`.quiet()).stdout.toString(),
    tcpProbe,
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

function parseEndpoint(ep: string): { host: string; port: number } | null {
  try {
    const s = ep.includes("://") ? ep : "tcp://" + ep
    const u = new URL(s)
    if (!u.hostname) return null
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80
    return { host: u.hostname, port }
  } catch {
    return null
  }
}

async function collectNet(d: SnapshotDeps, config: HwtrackConfig): Promise<NetInfo | null> {
  try {
    if (!config.vllmEndpoint) return null
    const parsed = parseEndpoint(config.vllmEndpoint)
    if (!parsed) return null
    const endpoint = `${parsed.host}:${parsed.port}`
    let ms: number | null = null
    try {
      ms = await d.tcpProbe(parsed.host, parsed.port, config.netTimeoutMs)
    } catch {
      ms = null
    }
    return { endpoint, tcpConnectMs: ms, ok: ms !== null }
  } catch {
    return null
  }
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
  const [cpu, mem, netInfo, disk] = await Promise.all([
    collectCpu(d),
    collectMem(d),
    collectNet(d, config),
    collectDisk(d, cwd),
  ])
  return { cpu, mem, net: netInfo, disk }
}
