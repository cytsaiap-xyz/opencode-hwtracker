// @bun
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

// src/detector.ts
function createDetector(opts) {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  const turns = new Map;
  function onTurnStart(turnId, sessionId) {
    if (turns.has(turnId))
      return;
    const tStart = now();
    const ttftHandle = setTimer(() => {
      const st = turns.get(turnId);
      if (!st || st.firstTokenAt !== null)
        return;
      opts.onTrigger({ type: "ttft", sessionId, ttftMs: now() - st.tStart });
    }, opts.ttftThresholdMs);
    turns.set(turnId, { sessionId, tStart, firstTokenAt: null, ttftHandle, lastCharCount: 0 });
  }
  function onToken(turnId, charCount) {
    const st = turns.get(turnId);
    if (!st)
      return;
    st.lastCharCount = charCount;
    if (st.firstTokenAt === null) {
      st.firstTokenAt = now();
      clearTimer(st.ttftHandle);
    }
  }
  function onTurnComplete(turnId, outputTokens, durationSec) {
    const st = turns.get(turnId);
    if (!st)
      return;
    turns.delete(turnId);
    clearTimer(st.ttftHandle);
    const dur = durationSec ?? (now() - st.tStart) / 1000;
    if (dur <= 0)
      return;
    let tokens = outputTokens;
    let estimated = false;
    if (tokens === null) {
      tokens = Math.round(st.lastCharCount / 4);
      estimated = true;
    }
    if (tokens <= 0)
      return;
    const tokensPerSec = tokens / dur;
    if (tokensPerSec < opts.minTokensPerSec) {
      opts.onTrigger({
        type: "tokps",
        sessionId: st.sessionId,
        tokensPerSec,
        ttftMs: st.firstTokenAt !== null ? st.firstTokenAt - st.tStart : undefined,
        estimated
      });
    }
  }
  return { onTurnStart, onToken, onTurnComplete };
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

// src/verdict.ts
function computeVerdict(snapshot, config) {
  const { cpu, mem } = snapshot;
  const localReasons = [];
  if (cpu && cpu.usagePct >= config.cpuHighPct) {
    localReasons.push(`cpu ${cpu.usagePct.toFixed(0)}% \u2265 ${config.cpuHighPct}%`);
  }
  if (cpu && cpu.cores > 0 && cpu.load1 / cpu.cores >= config.loadHighRatio) {
    localReasons.push(`load ${(cpu.load1 / cpu.cores).toFixed(2)}/core \u2265 ${config.loadHighRatio}`);
  }
  if (mem && mem.usedPct >= config.memHighPct) {
    localReasons.push(`mem ${mem.usedPct.toFixed(0)}% \u2265 ${config.memHighPct}%`);
  }
  if (localReasons.length > 0) {
    return { label: "LOCAL likely", reasons: localReasons };
  }
  return { label: "BACKEND likely", reasons: ["local resources nominal"] };
}

// src/logger.ts
import fs2 from "fs/promises";
import path3 from "path";
async function appendEvent(logPath, event) {
  try {
    await fs2.mkdir(path3.dirname(logPath), { recursive: true });
    await fs2.appendFile(logPath, JSON.stringify(event) + `
`, "utf8");
  } catch (e) {
    console.error("[hwtrack] failed to write log:", e);
  }
}

// src/warning.ts
function formatWarning(event) {
  const parts = ["\u26A0"];
  if (event.trigger === "tokps" && event.speed.tokensPerSec !== undefined) {
    parts.push(`Slow ${event.speed.tokensPerSec.toFixed(1)} tok/s`);
  } else if (event.trigger === "ttft" && event.speed.ttftMs !== undefined) {
    parts.push(`TTFT ${(event.speed.ttftMs / 1000).toFixed(1)}s`);
  }
  const s = event.snapshot;
  const bits = [];
  if (s.cpu)
    bits.push(`CPU ${s.cpu.usagePct.toFixed(0)}%`);
  if (s.mem)
    bits.push(`RAM ${s.mem.usedPct.toFixed(0)}%`);
  if (bits.length)
    parts.push("\xB7 " + bits.join(" "));
  parts.push(`\u2192 ${event.verdict.label}`);
  return parts.join(" ");
}
async function showWarning(showToast, msg) {
  try {
    await showToast(msg);
  } catch (e) {
    console.error("[hwtrack] toast failed:", e);
  }
}

// src/index.ts
var sessionIdMissingWarned = false;
var DEBUG = !!process.env.HWTRACK_DEBUG;
var HwtrackPlugin = async ({ client, directory }) => {
  const cwd = directory ?? process.cwd();
  const config = loadConfig(process.env, readFileConfig(cwd));
  console.error(`[hwtrack] loaded \u2014 cwd=${cwd} minTokensPerSec=${config.minTokensPerSec} ` + `ttftThresholdMs=${config.ttftThresholdMs} logPath=${config.logPath}`);
  const showToast = async (msg) => {
    const c = client;
    if (typeof c.tui?.showToast !== "function") {
      console.error("[hwtrack] client.tui.showToast is unavailable on this opencode version \u2014 cannot show TUI toast. message:", msg);
      return;
    }
    try {
      const res = await c.tui.showToast({
        body: { message: msg, variant: "warning", title: "hwtrack" }
      });
      if (res && res.error) {
        console.error("[hwtrack] toast request returned an error:", JSON.stringify(res.error));
      } else if (DEBUG) {
        console.error("[hwtrack] toast sent OK:", JSON.stringify(res));
      }
    } catch (e) {
      console.error("[hwtrack] toast call threw:", e);
    }
  };
  const handleTrigger = async (t) => {
    const snapshot = await collectSnapshot(config, cwd);
    const verdict = computeVerdict(snapshot, config);
    const event = {
      ts: new Date().toISOString(),
      sessionId: t.sessionId,
      trigger: t.type,
      speed: { tokensPerSec: t.tokensPerSec, ttftMs: t.ttftMs, estimated: t.estimated },
      snapshot,
      verdict
    };
    await appendEvent(config.logPath, event);
    await showWarning(showToast, formatWarning(event));
  };
  const detector = createDetector({
    minTokensPerSec: config.minTokensPerSec,
    ttftThresholdMs: config.ttftThresholdMs,
    onTrigger: (t) => {
      if (DEBUG)
        console.error("[hwtrack] trigger fired:", JSON.stringify(t));
      handleTrigger(t).catch((e) => console.error("[hwtrack] handleTrigger:", e));
    }
  });
  return {
    event: async ({ event }) => {
      try {
        const type = event?.type;
        const props = event?.properties ?? {};
        if (DEBUG && (type === "message.updated" || type === "message.part.updated")) {
          console.error("[hwtrack] event:", type);
        }
        if (type === "message.updated") {
          const msg = props.info ?? props.message ?? props;
          if (msg?.role === "assistant" && typeof msg.id === "string") {
            const turnId = msg.id;
            const sessionId = msg.sessionID ?? msg.sessionId ?? "unknown";
            if (sessionId === "unknown" && !sessionIdMissingWarned) {
              sessionIdMissingWarned = true;
              console.error("[hwtrack] could not read session id from message.updated payload \u2014 event bindings may need adjustment (see README verify step)");
            }
            const time = msg.time ?? {};
            if (!time.completed) {
              detector.onTurnStart(turnId, sessionId);
            } else {
              const tokens = msg.tokens ?? {};
              const outTok = typeof tokens.output === "number" ? tokens.output : null;
              const dur = time.created != null && time.completed != null ? (time.completed - time.created) / 1000 : null;
              detector.onTurnComplete(turnId, outTok, dur);
            }
          }
        } else if (type === "message.part.updated") {
          const part = props.part ?? props;
          const turnId = part.messageID ?? part.messageId;
          if (part?.type === "text" && typeof part.text === "string" && turnId) {
            detector.onToken(turnId, part.text.length);
          }
        }
      } catch (e) {
        console.error("[hwtrack] event handler:", e);
      }
    }
  };
};
var src_default = HwtrackPlugin;
export {
  src_default as default,
  HwtrackPlugin
};
