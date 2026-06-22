export interface HwtrackConfig {
  minTokensPerSec: number
  ttftThresholdMs: number
  vllmEndpoint: string | null
  logPath: string
  cpuHighPct: number
  loadHighRatio: number
  memHighPct: number
  netHighMs: number
  netTimeoutMs: number
}

export interface CpuInfo {
  usagePct: number
  load1: number
  load5: number
  load15: number
  cores: number
}

export interface MemInfo {
  totalMB: number
  usedMB: number
  freeMB: number
  usedPct: number
  swapUsedMB: number | null
}

export interface NetInfo {
  endpoint: string
  tcpConnectMs: number | null
  ok: boolean
}

export interface DiskInfo {
  path: string
  freeGB: number
  usedPct: number
}

export interface Snapshot {
  cpu: CpuInfo | null
  mem: MemInfo | null
  net: NetInfo | null
  disk: DiskInfo | null
}

export type VerdictLabel = "LOCAL likely" | "NETWORK likely" | "BACKEND likely"

export interface Verdict {
  label: VerdictLabel
  reasons: string[]
}

export type TriggerType = "ttft" | "tokps"

export interface Trigger {
  type: TriggerType
  sessionId: string
  tokensPerSec?: number
  ttftMs?: number
  estimated?: boolean
}

export interface HwEvent {
  ts: string
  sessionId: string
  trigger: TriggerType
  speed: { tokensPerSec?: number; ttftMs?: number; estimated?: boolean }
  snapshot: Snapshot
  verdict: Verdict
}
