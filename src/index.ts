import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { readFileConfig } from "./readFileConfig"
import { createDetector } from "./detector"
import { collectSnapshot } from "./snapshot"
import { computeVerdict } from "./verdict"
import { appendEvent } from "./logger"
import { formatWarning, showWarning } from "./warning"
import type { HwEvent, Trigger } from "./types"

let sessionIdMissingWarned = false

const DEBUG = !!process.env.HWTRACK_DEBUG

export const HwtrackPlugin: Plugin = async ({ client, directory }) => {
  const cwd = directory ?? process.cwd()
  const config = loadConfig(process.env as Record<string, string | undefined>, readFileConfig(cwd))

  // Startup diagnostic: proves the plugin loaded and shows the resolved config.
  console.error(
    `[hwtrack] loaded — cwd=${cwd} minTokensPerSec=${config.minTokensPerSec} ` +
      `ttftThresholdMs=${config.ttftThresholdMs} logPath=${config.logPath}`,
  )

  const showToast = async (msg: string) => {
    const c = client as unknown as {
      tui?: { showToast?: (a: { body: { message: string; variant?: string; title?: string } }) => Promise<unknown> }
    }
    if (!c.tui?.showToast) {
      console.error("[hwtrack] client.tui.showToast is unavailable — cannot show TUI toast; message was:", msg)
      return
    }
    try {
      const res = await c.tui.showToast({ body: { message: msg, variant: "warning", title: "hwtrack" } })
      if (DEBUG) console.error("[hwtrack] toast sent; result:", JSON.stringify(res))
    } catch (e) {
      console.error("[hwtrack] toast call threw:", e)
    }
  }

  const handleTrigger = async (t: Trigger) => {
    const snapshot = await collectSnapshot(config, cwd)
    const verdict = computeVerdict(snapshot, config)
    const event: HwEvent = {
      ts: new Date().toISOString(),
      sessionId: t.sessionId,
      trigger: t.type,
      speed: { tokensPerSec: t.tokensPerSec, ttftMs: t.ttftMs, estimated: t.estimated },
      snapshot,
      verdict,
    }
    await appendEvent(config.logPath, event)
    await showWarning(showToast, formatWarning(event))
  }

  const detector = createDetector({
    minTokensPerSec: config.minTokensPerSec,
    ttftThresholdMs: config.ttftThresholdMs,
    onTrigger: (t) => {
      if (DEBUG) console.error("[hwtrack] trigger fired:", JSON.stringify(t))
      handleTrigger(t).catch((e) => console.error("[hwtrack] handleTrigger:", e))
    },
  })

  return {
    event: async ({ event }: { event: { type?: string; properties?: Record<string, unknown> } }) => {
      try {
        const type = event?.type
        const props = (event?.properties ?? {}) as Record<string, unknown>

        if (DEBUG && (type === "message.updated" || type === "message.part.updated")) {
          console.error("[hwtrack] event:", type)
        }

        if (type === "message.updated") {
          const msg = (props.info ?? props.message ?? props) as Record<string, unknown>
          if (msg?.role === "assistant" && typeof msg.id === "string") {
            const turnId = msg.id
            const sessionId = (msg.sessionID ?? msg.sessionId ?? "unknown") as string
            if (sessionId === "unknown" && !sessionIdMissingWarned) {
              sessionIdMissingWarned = true
              console.error("[hwtrack] could not read session id from message.updated payload — event bindings may need adjustment (see README verify step)")
            }
            const time = (msg.time ?? {}) as { created?: number; completed?: number }
            if (!time.completed) {
              detector.onTurnStart(turnId, sessionId)
            } else {
              const tokens = (msg.tokens ?? {}) as { output?: number }
              const outTok = typeof tokens.output === "number" ? tokens.output : null
              const dur =
                time.created != null && time.completed != null ? (time.completed - time.created) / 1000 : null
              detector.onTurnComplete(turnId, outTok, dur)
            }
          }
        } else if (type === "message.part.updated") {
          const part = (props.part ?? props) as Record<string, unknown>
          const turnId = (part.messageID ?? part.messageId) as string | undefined
          if (part?.type === "text" && typeof part.text === "string" && turnId) {
            detector.onToken(turnId, part.text.length)
          }
        }
      } catch (e) {
        console.error("[hwtrack] event handler:", e)
      }
    },
  }
}

export default HwtrackPlugin
