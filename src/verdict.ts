import type { HwtrackConfig, Snapshot, Verdict } from "./types"

export function computeVerdict(snapshot: Snapshot, config: HwtrackConfig): Verdict {
  const { cpu, mem, net } = snapshot
  const localReasons: string[] = []

  if (cpu && cpu.usagePct >= config.cpuHighPct) {
    localReasons.push(`cpu ${cpu.usagePct.toFixed(0)}% ≥ ${config.cpuHighPct}%`)
  }
  if (cpu && cpu.cores > 0 && cpu.load1 / cpu.cores >= config.loadHighRatio) {
    localReasons.push(`load ${(cpu.load1 / cpu.cores).toFixed(2)}/core ≥ ${config.loadHighRatio}`)
  }
  if (mem && mem.usedPct >= config.memHighPct) {
    localReasons.push(`mem ${mem.usedPct.toFixed(0)}% ≥ ${config.memHighPct}%`)
  }
  if (localReasons.length > 0) {
    return { label: "LOCAL likely", reasons: localReasons }
  }

  if (net && net.ok === false) {
    return { label: "NETWORK likely", reasons: ["vllm probe failed"] }
  }
  if (net && net.tcpConnectMs !== null && net.tcpConnectMs >= config.netHighMs) {
    return { label: "NETWORK likely", reasons: [`net ${net.tcpConnectMs.toFixed(0)}ms ≥ ${config.netHighMs}ms`] }
  }

  const reasons = ["local resources nominal"]
  if (net && net.tcpConnectMs !== null) {
    reasons.push(`net ${net.tcpConnectMs.toFixed(0)}ms < ${config.netHighMs}ms`)
  }
  return { label: "BACKEND likely", reasons }
}
