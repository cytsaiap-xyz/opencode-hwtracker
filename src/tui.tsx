/**
 * tui.tsx — opencode-hwtracker TUI plugin entry point
 *
 * Exports a named `tui` export as required by TuiPluginModule.
 * Registers sidebar_title and sidebar_content slots showing the hardware
 * snapshot captured at the most recent slow-output event.
 *
 * Design — event-driven, NOT polling:
 * - Does NOT sample hardware on a timer (that was costly: a 200ms CPU sample
 *   plus df/free shell calls every few seconds). Instead it reads the snapshot
 *   the server plugin already recorded in events.jsonl when a slow turn fired.
 * - Updates only when a new event is appended: it watches the log directory
 *   (fs.watch) and also refreshes on session.idle as a cheap backup. Both just
 *   re-read the last JSONL line — no hardware sampling in the TUI process.
 */

import type { TuiPlugin, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import fs from "fs"
import path from "path"
import { loadConfig } from "./config"
import { readFileConfig } from "./readFileConfig"
import { readLastEvent } from "./lastEvent"
import type { HwEvent } from "./types"
import { HwSidebar } from "./sidebar"

export const tui: TuiPlugin = async (api) => {
  const cwd = process.cwd()
  const config = loadConfig(process.env as Record<string, string | undefined>, readFileConfig(cwd))

  const [last, setLast] = createSignal<HwEvent | null>(null)
  const refresh = (): void => {
    try {
      setLast(readLastEvent(config.logPath))
    } catch {
      /* ignore unreadable log */
    }
  }
  refresh() // show the most recent event (if any) on load

  // Update ONLY when the server plugin appends a new slow-output event.
  // Watch the log directory — lightweight; no hardware polling.
  let watcher: fs.FSWatcher | null = null
  try {
    const dir = path.dirname(config.logPath)
    fs.mkdirSync(dir, { recursive: true })
    watcher = fs.watch(dir, (_event, filename) => {
      if (!filename || filename === path.basename(config.logPath)) refresh()
    })
  } catch {
    /* fs.watch unavailable — the session.idle backup below still updates it */
  }

  // Backup trigger: re-read after each turn settles (cheap single-line read).
  const unsub = api.event.on("session.idle", () => refresh())

  api.lifecycle.onDispose(() => {
    try {
      watcher?.close()
    } catch {
      /* ignore */
    }
    unsub()
  })

  api.slots.register({
    order: 200,
    slots: {
      sidebar_title: (_ctx: unknown, _props: { session_id: string; title: string }) =>
        (<text bold>HW</text>) as unknown as JSX.Element,
      sidebar_content: (_ctx: unknown, _props: { session_id: string }) =>
        (<HwSidebar last={last} config={config} />) as unknown as JSX.Element,
    },
  } as unknown as TuiSlotPlugin)
}
