import os from "os"
import path from "path"
import type { HwtrackConfig } from "./types"

export const DEFAULTS: HwtrackConfig = {
  minTokensPerSec: 10,
  ttftThresholdMs: 5000,
  vllmEndpoint: null,
  logPath: "~/.opencode-hwtrack/events.jsonl",
  cpuHighPct: 85,
  loadHighRatio: 1.0,
  memHighPct: 90,
  netHighMs: 200,
  netTimeoutMs: 2000,
}

const NUM_KEYS = [
  "minTokensPerSec",
  "ttftThresholdMs",
  "cpuHighPct",
  "loadHighRatio",
  "memHighPct",
  "netHighMs",
  "netTimeoutMs",
] as const

function toEnvKey(key: string): string {
  return "HWTRACK_" + key.replace(/[A-Z]/g, (m) => "_" + m).toUpperCase()
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1))
  return p
}

export function loadConfig(
  env: Record<string, string | undefined> = {},
  fileConfig: Partial<HwtrackConfig> = {},
): HwtrackConfig {
  const merged: HwtrackConfig = { ...DEFAULTS, ...fileConfig }

  for (const key of NUM_KEYS) {
    const raw = env[toEnvKey(key)]
    if (raw !== undefined && raw !== "" && !Number.isNaN(Number(raw))) {
      ;(merged as unknown as Record<string, unknown>)[key] = Number(raw)
    }
  }

  const endpoint = env["HWTRACK_VLLM_ENDPOINT"] ?? fileConfig.vllmEndpoint ?? DEFAULTS.vllmEndpoint
  merged.vllmEndpoint = endpoint ?? null

  const lp = env["HWTRACK_LOG_PATH"] ?? merged.logPath
  merged.logPath = expandHome(lp)

  return merged
}
