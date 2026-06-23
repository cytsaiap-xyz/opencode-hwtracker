/**
 * sidebar.tsx
 *
 * SolidJS component for the HW Tracker sidebar panel.
 *
 * JSX element names (box / text) and style props are @opentui/core primitives.
 * @opentui/* is NOT in node_modules — it is bundled inside the opencode binary
 * and injected at plugin-load time. We use `declare module` shims below so that
 * TypeScript accepts the JSX elements without widening to `any` or disabling strict.
 *
 * Type-gap note: The shim attributes (flexDirection, marginBottom, bold, dim, padding)
 * match the observed prop names in opencode's builtin sidebar feature-plugins.
 * If opencode's actual opentui version uses different names, the runtime will still
 * work because Solid renders by passing props to the renderer directly; only the
 * TypeScript types would need updating.
 */

import { Show } from "solid-js"
import type { Accessor, JSX } from "solid-js"
import type { Snapshot, HwEvent, HwtrackConfig } from "./types"

// ---------------------------------------------------------------------------
// @opentui/core shim — teaches TypeScript about the box/text intrinsics.
// This is a NARROW, DOCUMENTED cast; it does NOT disable strict mode or
// affect any real logic. The real types are supplied by the opencode binary.
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

// ---------------------------------------------------------------------------
// ASCII bar helper — width ~12 chars
// ---------------------------------------------------------------------------
function bar(pct: number, width = 12): string {
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((clamped / 100) * width)
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]"
}

function fmt(n: number): string {
  return `${n.toFixed(0).padStart(3)}%`
}

// ---------------------------------------------------------------------------
// HwSidebar component
// ---------------------------------------------------------------------------
export function HwSidebar(props: {
  snap: Accessor<Snapshot | null>
  last: Accessor<HwEvent | null>
  config: HwtrackConfig
}): JSX.Element {
  return (
    <box flexDirection="column" padding={1}>
      <Show
        when={props.snap() !== null}
        fallback={<text dim>sampling…</text>}
      >
        {/* CPU */}
        <Show
          when={props.snap()?.cpu != null}
          fallback={<text>CPU  n/a</text>}
        >
          <text>
            {`CPU  ${bar(props.snap()!.cpu!.usagePct)} ${fmt(props.snap()!.cpu!.usagePct)}${props.snap()!.cpu!.usagePct >= props.config.cpuHighPct ? " HIGH" : ""}`}
          </text>
          <text dim>
            {`load ${props.snap()!.cpu!.load1.toFixed(2)}/core${(props.snap()!.cpu!.cores > 0 ? props.snap()!.cpu!.load1 / props.snap()!.cpu!.cores : 0) >= props.config.loadHighRatio ? " HIGH" : ""}`}
          </text>
        </Show>

        {/* RAM */}
        <Show
          when={props.snap()?.mem != null}
          fallback={<text>RAM  n/a</text>}
        >
          <text>
            {`RAM  ${bar(props.snap()!.mem!.usedPct)} ${fmt(props.snap()!.mem!.usedPct)}${props.snap()!.mem!.usedPct >= props.config.memHighPct ? " HIGH" : ""}`}
          </text>
          <text dim>
            {`(${(props.snap()!.mem!.usedMB / 1024).toFixed(1)}/${(props.snap()!.mem!.totalMB / 1024).toFixed(1)} GB)`}
          </text>
        </Show>

        {/* Disk */}
        <Show
          when={props.snap()?.disk != null}
          fallback={<text>Disk n/a</text>}
        >
          <text>
            {`Disk ${bar(props.snap()!.disk!.usedPct)} ${fmt(props.snap()!.disk!.usedPct)}${props.snap()!.disk!.usedPct >= 90 ? " HIGH" : ""}`}
          </text>
          <text dim>
            {`(${props.snap()!.disk!.freeGB.toFixed(0)} GB free)`}
          </text>
        </Show>

        {/* Last slow event */}
        <text> </text>
        <text bold>Last slow event:</text>
        <Show
          when={props.last() !== null}
          fallback={<text dim>(none yet)</text>}
        >
          <text dim>{props.last()!.ts}</text>
          <text>
            {`${props.last()!.trigger}: ${
              props.last()!.speed.tokensPerSec != null
                ? `${props.last()!.speed.tokensPerSec!.toFixed(1)} tok/s`
                : props.last()!.speed.ttftMs != null
                  ? `TTFT ${(props.last()!.speed.ttftMs! / 1000).toFixed(1)}s`
                  : "—"
            } -> ${props.last()!.verdict.label}`}
          </text>
        </Show>
      </Show>
    </box>
  ) as unknown as JSX.Element
}
