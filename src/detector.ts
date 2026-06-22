import type { Trigger } from "./types"

export interface DetectorOptions {
  minTokensPerSec: number
  ttftThresholdMs: number
  onTrigger: (t: Trigger) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

interface TurnState {
  sessionId: string
  tStart: number
  firstTokenAt: number | null
  ttftHandle: unknown
  lastCharCount: number
}

export function createDetector(opts: DetectorOptions) {
  const now = opts.now ?? (() => Date.now())
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const turns = new Map<string, TurnState>()

  function onTurnStart(turnId: string, sessionId: string): void {
    if (turns.has(turnId)) return
    const tStart = now()
    const ttftHandle = setTimer(() => {
      const st = turns.get(turnId)
      if (!st || st.firstTokenAt !== null) return
      opts.onTrigger({ type: "ttft", sessionId, ttftMs: now() - st.tStart })
    }, opts.ttftThresholdMs)
    turns.set(turnId, { sessionId, tStart, firstTokenAt: null, ttftHandle, lastCharCount: 0 })
  }

  function onToken(turnId: string, charCount: number): void {
    const st = turns.get(turnId)
    if (!st) return
    st.lastCharCount = charCount
    if (st.firstTokenAt === null) {
      st.firstTokenAt = now()
      clearTimer(st.ttftHandle)
    }
  }

  function onTurnComplete(turnId: string, outputTokens: number | null, durationSec: number | null): void {
    const st = turns.get(turnId)
    if (!st) return
    turns.delete(turnId)
    clearTimer(st.ttftHandle)

    const dur = durationSec ?? (now() - st.tStart) / 1000
    if (dur <= 0) return

    let tokens = outputTokens
    let estimated = false
    if (tokens === null) {
      tokens = Math.round(st.lastCharCount / 4)
      estimated = true
    }
    if (tokens <= 0) return // empty / tool-only turn excluded

    const tokensPerSec = tokens / dur
    if (tokensPerSec < opts.minTokensPerSec) {
      opts.onTrigger({
        type: "tokps",
        sessionId: st.sessionId,
        tokensPerSec,
        ttftMs: st.firstTokenAt !== null ? st.firstTokenAt - st.tStart : undefined,
        estimated,
      })
    }
  }

  return { onTurnStart, onToken, onTurnComplete }
}
