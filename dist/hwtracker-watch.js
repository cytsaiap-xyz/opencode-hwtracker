// @bun
// src/watch.ts
import fs2 from "fs";

// src/config.ts
import os from "os";
import path from "path";
var DEFAULTS = {
  minTokensPerSec: 10,
  ttftThresholdMs: 5000,
  logPath: "~/.opencode-hwtrack/events.jsonl",
  cpuHighPct: 85,
  loadHighRatio: 1,
  memHighPct: 90
};
var NUM_KEYS = [
  "minTokensPerSec",
  "ttftThresholdMs",
  "cpuHighPct",
  "loadHighRatio",
  "memHighPct"
];
function toEnvKey(key) {
  return "HWTRACK_" + key.replace(/[A-Z]/g, (m) => "_" + m).toUpperCase();
}
function expandHome(p) {
  if (p.startsWith("~"))
    return path.join(os.homedir(), p.slice(1));
  return p;
}
function loadConfig(env = {}, fileConfig = {}) {
  const merged = { ...DEFAULTS, ...fileConfig };
  for (const key of NUM_KEYS) {
    const raw = env[toEnvKey(key)];
    if (raw !== undefined && raw !== "" && !Number.isNaN(Number(raw))) {
      merged[key] = Number(raw);
    }
  }
  const lp = env["HWTRACK_LOG_PATH"] ?? merged.logPath;
  merged.logPath = expandHome(lp);
  return merged;
}

// src/readFileConfig.ts
import fs from "fs";
import path2 from "path";
function readFileConfig(dir) {
  const candidates = [path2.join(dir, "hwtrack.config.json")];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }
  return {};
}

// src/snapshot.ts
import os2 from "os";
var {$ } = globalThis.Bun;
function defaultDeps() {
  return {
    cpus: () => os2.cpus(),
    loadavg: () => os2.loadavg(),
    totalmem: () => os2.totalmem(),
    freemem: () => os2.freemem(),
    sh: async (cmd) => (await $`sh -c ${cmd}`.quiet()).stdout.toString(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms))
  };
}
function cpuTimes(cpus) {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const v of Object.values(c.times))
      total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}
async function collectCpu(d) {
  try {
    const first = d.cpus();
    const a = cpuTimes(first);
    await d.sleep(200);
    const b = cpuTimes(d.cpus());
    const idleD = b.idle - a.idle;
    const totalD = b.total - a.total;
    const usagePct = totalD > 0 ? (1 - idleD / totalD) * 100 : 0;
    const [load1, load5, load15] = d.loadavg();
    return { usagePct, load1, load5, load15, cores: first.length };
  } catch {
    return null;
  }
}
async function collectMem(d) {
  try {
    const total = d.totalmem();
    const free = d.freemem();
    const used = total - free;
    let swapUsedMB = null;
    try {
      const out = await d.sh("free -m 2>/dev/null || true");
      const line = out.split(`
`).find((l) => /^Swap:/i.test(l.trim()));
      if (line) {
        const parts = line.trim().split(/\s+/);
        const v = Number(parts[2]);
        if (!Number.isNaN(v))
          swapUsedMB = v;
      }
    } catch {}
    return {
      totalMB: total / 1048576,
      usedMB: used / 1048576,
      freeMB: free / 1048576,
      usedPct: total > 0 ? used / total * 100 : 0,
      swapUsedMB
    };
  } catch {
    return null;
  }
}
function shellQuote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
async function collectDisk(d, cwd) {
  try {
    const out = await d.sh(`df -k ${shellQuote(cwd)}`);
    const lines = out.trim().split(`
`);
    const last = lines[lines.length - 1].trim().split(/\s+/);
    const availKB = Number(last[3]);
    const usedPct = Number(String(last[4]).replace("%", ""));
    if (Number.isNaN(availKB) || Number.isNaN(usedPct))
      return null;
    return { path: cwd, freeGB: availKB / 1048576, usedPct };
  } catch {
    return null;
  }
}
async function collectSnapshot(config, cwd, deps) {
  const d = { ...defaultDeps(), ...deps };
  const [cpu, mem, disk] = await Promise.all([
    collectCpu(d),
    collectMem(d),
    collectDisk(d, cwd)
  ]);
  return { cpu, mem, disk };
}

// src/watch.ts
function bar(p, width = 20) {
  const clamped = Math.max(0, Math.min(100, p));
  const filled = Math.round(clamped / 100 * width);
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}
function pct(n) {
  return `${n.toFixed(0).padStart(3)}%`;
}
function renderPanel(s, last, config, nowIso) {
  const lines = [];
  lines.push("opencode-hwtracker \u2014 live local hardware");
  lines.push(nowIso);
  lines.push("");
  if (s.cpu) {
    const high = s.cpu.usagePct >= config.cpuHighPct;
    lines.push(`CPU  ${bar(s.cpu.usagePct)} ${pct(s.cpu.usagePct)}${high ? "  HIGH" : ""}`);
    const ratio = s.cpu.cores > 0 ? s.cpu.load1 / s.cpu.cores : 0;
    const loadHigh = ratio >= config.loadHighRatio;
    lines.push(`load ${s.cpu.load1.toFixed(2)} (1m) / ${s.cpu.cores} cores = ${ratio.toFixed(2)}/core${loadHigh ? "  HIGH" : ""}`);
  } else {
    lines.push("CPU  n/a");
  }
  if (s.mem) {
    const high = s.mem.usedPct >= config.memHighPct;
    lines.push(`RAM  ${bar(s.mem.usedPct)} ${pct(s.mem.usedPct)}${high ? "  HIGH" : ""}  (${(s.mem.usedMB / 1024).toFixed(1)}/${(s.mem.totalMB / 1024).toFixed(1)} GB)`);
  } else {
    lines.push("RAM  n/a");
  }
  if (s.disk) {
    const high = s.disk.usedPct >= 90;
    lines.push(`Disk ${bar(s.disk.usedPct)} ${pct(s.disk.usedPct)}${high ? "  HIGH" : ""}  (${s.disk.freeGB.toFixed(0)} GB free)`);
  } else {
    lines.push("Disk n/a");
  }
  lines.push("");
  lines.push("Last slow-output event:");
  if (!last) {
    lines.push("  (none yet \u2014 quiet so far)");
  } else {
    const speed = last.speed.tokensPerSec != null ? `${last.speed.tokensPerSec.toFixed(1)} tok/s` : last.speed.ttftMs != null ? `TTFT ${(last.speed.ttftMs / 1000).toFixed(1)}s` : "\u2014";
    lines.push(`  ${last.ts}`);
    lines.push(`  ${last.trigger}: ${speed} -> ${last.verdict.label}`);
  }
  lines.push("");
  lines.push("(Ctrl-C to quit)");
  return lines.join(`
`);
}
function readLastEvent(logPath) {
  try {
    const data = fs2.readFileSync(logPath, "utf8").trim();
    if (!data)
      return null;
    const lastLine = data.slice(data.lastIndexOf(`
`) + 1);
    return JSON.parse(lastLine);
  } catch {
    return null;
  }
}
async function main() {
  const cwd = process.cwd();
  const config = loadConfig(process.env, readFileConfig(cwd));
  const intervalMs = (Number(process.env.HWTRACK_WATCH_INTERVAL) || 2) * 1000;
  process.stdout.write("\x1B[?25l");
  const cleanup = () => {
    process.stdout.write(`\x1B[?25h
`);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  for (;; ) {
    const snap = await collectSnapshot(config, cwd);
    const last = readLastEvent(config.logPath);
    const panel = renderPanel(snap, last, config, new Date().toISOString());
    process.stdout.write("\x1B[2J\x1B[H" + panel + `
`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
if (import.meta.main) {
  main();
}
export {
  renderPanel,
  readLastEvent
};
