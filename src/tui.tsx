/**
 * tui.tsx — opencode-hwtracker TUI plugin entry point
 *
 * Exports a named `tui` export as required by TuiPluginModule.
 * Registers sidebar_title and sidebar_content slots showing live CPU/RAM/disk.
 *
 * Design:
 * - Polls collectSnapshot() every HWTRACK_WATCH_INTERVAL seconds (default 3).
 * - Reads the last JSONL event via readLastEvent() for "last slow event" display.
 * - Uses SolidJS signals (createSignal) to feed the reactive HwSidebar component.
 * - collectSnapshot degrades each collector to null on failure (CPU/RAM via node
 *   `os` are robust; disk/swap use shell commands and may be null in some TUI
 *   runtime environments — this is acceptable and handled by the sidebar).
 */

import type { TuiPlugin, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import { loadConfig } from "./config"
import { readFileConfig } from "./readFileConfig"
import { collectSnapshot } from "./snapshot"
import { readLastEvent } from "./watch"
import type { Snapshot, HwEvent } from "./types"
import { HwSidebar } from "./sidebar"

export const tui: TuiPlugin = async (api) => {
  const cwd = process.cwd()
  const config = loadConfig(process.env as Record<string, string | undefined>, readFileConfig(cwd))
  const intervalMs = (Number(process.env.HWTRACK_WATCH_INTERVAL) || 3) * 1000

  const [snap, setSnap] = createSignal<Snapshot | null>(null)
  const [last, setLast] = createSignal<HwEvent | null>(null)

  let stopped = false

  const tick = async (): Promise<void> => {
    try {
      const s = await collectSnapshot(config, cwd)
      if (!stopped) setSnap(s)
      const l = readLastEvent(config.logPath)
      if (!stopped) setLast(l)
    } catch {
      /* degrade gracefully — stale values remain */
    }
  }

  // Kick off immediately, then poll
  void tick()
  const timer = setInterval(() => {
    void tick()
  }, intervalMs)

  api.lifecycle.onDispose(() => {
    stopped = true
    clearInterval(timer)
  })

  api.slots.register({
    order: 200,
    slots: {
      sidebar_title: (_ctx: unknown, _props: { session_id: string; title: string }) =>
        (<text bold>HW</text>) as unknown as JSX.Element,
      sidebar_content: (_ctx: unknown, _props: { session_id: string }) =>
        (<HwSidebar snap={snap} last={last} config={config} />) as unknown as JSX.Element,
    },
  } as unknown as TuiSlotPlugin)
}
