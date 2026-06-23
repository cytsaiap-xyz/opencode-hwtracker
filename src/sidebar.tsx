/**
 * sidebar.tsx
 *
 * SolidJS component for the HW Tracker sidebar panel.
 *
 * It renders the hardware snapshot captured at the most recent slow-output
 * event (read from events.jsonl by tui.tsx) — NOT a live sample. This keeps
 * the sidebar zero-overhead: it only changes when a slow turn is detected.
 *
 * JSX element names (box / text) and style props are @opentui/core primitives.
 * @opentui/* is NOT in node_modules — it is bundled inside the opencode binary
 * and injected at plugin-load time. We use `declare module` shims below so that
 * TypeScript accepts the JSX elements without widening to `any` or disabling strict.
 */

import { Show } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { Snapshot, HwEvent, HwtrackConfig } from "./types"

// ---------------------------------------------------------------------------
// @opentui/core shim — teaches TypeScript about the box/text intrinsics.
// ---------------------------------------------------------------------------
declare module "solid-js/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      box: {
        flexDirection?: "column" | "row"
        padding?: number
        marginBottom?: number
        children?: JSX.Element
      }
      text: {
        bold?: boolean
        dim?: boolean
        children?: JSX.Element | string
      }
    }
  }
}

function bar(pct: number, width = 12): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((clamped / 100) * width)
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]"
}

function fmt(n: number): string {
  return `${n.toFixed(0).padStart(3)}%`
}

function speedStr(e: HwEvent): string {
  if (e.speed.tokensPerSec != null) return `${e.speed.tokensPerSec.toFixed(1)} tok/s`
  if (e.speed.ttftMs != null) return `TTFT ${(e.speed.ttftMs / 1000).toFixed(1)}s`
  return "—"
}

// ---------------------------------------------------------------------------
// HwSidebar — renders the latest slow-output event's snapshot.
// ---------------------------------------------------------------------------
export function HwSidebar(props: {
  last: Accessor<HwEvent | null>
  config: HwtrackConfig
}): JSX.Element {
  const snap = (): Snapshot | null => props.last()?.snapshot ?? null
  return (
    <box flexDirection="column" padding={1}>
      <Show
        when={props.last() !== null}
        fallback={
          <box flexDirection="column">
            <text dim>No slow-output events yet.</text>
            <text dim>Hardware is captured only</text>
            <text dim>when output is slow.</text>
          </box>
        }
      >
        {/* Event header */}
        <text dim>{props.last()!.ts}</text>
        <text bold>{`${props.last()!.trigger}: ${speedStr(props.last()!)}`}</text>
        <text>{`-> ${props.last()!.verdict.label}`}</text>
        <text> </text>

        {/* CPU */}
        <Show when={snap()?.cpu != null} fallback={<text>CPU  n/a</text>}>
          <text>
            {`CPU  ${bar(snap()!.cpu!.usagePct)} ${fmt(snap()!.cpu!.usagePct)}${snap()!.cpu!.usagePct >= props.config.cpuHighPct ? " HIGH" : ""}`}
          </text>
          <text dim>
            {`load ${snap()!.cpu!.load1.toFixed(2)}/core${(snap()!.cpu!.cores > 0 ? snap()!.cpu!.load1 / snap()!.cpu!.cores : 0) >= props.config.loadHighRatio ? " HIGH" : ""}`}
          </text>
        </Show>

        {/* RAM */}
        <Show when={snap()?.mem != null} fallback={<text>RAM  n/a</text>}>
          <text>
            {`RAM  ${bar(snap()!.mem!.usedPct)} ${fmt(snap()!.mem!.usedPct)}${snap()!.mem!.usedPct >= props.config.memHighPct ? " HIGH" : ""}`}
          </text>
          <text dim>
            {`(${(snap()!.mem!.usedMB / 1024).toFixed(1)}/${(snap()!.mem!.totalMB / 1024).toFixed(1)} GB)`}
          </text>
        </Show>

        {/* Disk */}
        <Show when={snap()?.disk != null} fallback={<text>Disk n/a</text>}>
          <text>
            {`Disk ${bar(snap()!.disk!.usedPct)} ${fmt(snap()!.disk!.usedPct)}${snap()!.disk!.usedPct >= 90 ? " HIGH" : ""}`}
          </text>
          <text dim>{`(${snap()!.disk!.freeGB.toFixed(0)} GB free)`}</text>
        </Show>
      </Show>
    </box>
  ) as unknown as JSX.Element
}
