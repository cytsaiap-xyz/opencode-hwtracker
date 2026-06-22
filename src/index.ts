import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { readFileConfig } from "./readFileConfig"
import { createDetector } from "./detector"
import { collectSnapshot } from "./snapshot"
import { computeVerdict } from "./verdict"
import { appendEvent } from "./logger"
import { formatWarning, showWarning } from "./warning"
import type { HwEvent, Trigger } from "./types"

export const HwtrackPlugin: Plugin = async ({ client, directory }) => {
  const cwd = directory ?? process.cwd()
  const config = loadConfig(process.env as Record<string, string | undefined>, readFileConfig(cwd))

  const showToast = async (msg: string) => {
    // Confirm the exact SDK method against a live session (Step 7).
    const c = client as unknown as {
      tui?: { showToast?: (a: unknown) => Promise<unknown> }
    }
    if (c.tui?.showToast) {
      await c.tui.showToast({ body: msg, variant: "warning", title: "hwtrack" })
    } else {
      console.error("[hwtrack]", msg)
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
      handleTrigger(t).catch((e) => console.error("[hwtrack] handleTrigger:", e))
    },
  })

  return {
    event: async ({ event }: { event: { type?: string; properties?: Record<string, unknown> } }) => {
      try {
        const type = event?.type
        const props = (event?.properties ?? {}) as Record<string, unknown>

        if (type === "message.updated") {
          const msg = (props.info ?? props.message ?? props) as Record<string, unknown>
          if (msg?.role === "assistant" && typeof msg.id === "string") {
            const turnId = msg.id
            const sessionId = (msg.sessionID ?? msg.sessionId ?? "unknown") as string
            const time = (msg.time ?? {}) as { created?: number; completed?: number }
            if (!time.completed) {
              detector.onTurnStart(turnId, sessionId)
            } else {
              const tokens = (msg.tokens ?? {}) as { output?: number }
              const outTok = typeof tokens.output === "number" ? tokens.output : null
              const dur =
                time.created && time.completed ? (time.completed - time.created) / 1000 : null
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
