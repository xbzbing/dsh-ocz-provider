/**
 * The exit tables' row-action icons: 固定 and 取消固定 (padlock) and 轮换
 * (circular arrow). Nothing is ever deleted — the action rotates the row: a
 * reserve takes its place, or it sinks to the pool tail when there is none.
 *
 * Inline SVG rather than a glyph or an emoji: the bundle must not pull in an
 * icon dependency (the client half is a plain React bundle with no UI kit), and
 * emoji render in colour, which clashes with the monochrome table ink. These
 * inherit `currentColor`, so hover/disabled states come from the button's own
 * colour rules.
 *
 * A closed padlock means "this exit is fixed"; the open one means "unpin".
 */
import type { ReactNode } from 'react'

/** Shared drawing frame: 16×16 grid, stroked in the surrounding text colour. */
function Glyph({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** 固定: a closed padlock — subsequent traffic always uses this exit. */
export function PinIcon(): ReactNode {
  return (
    <Glyph>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.6" />
      <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" />
    </Glyph>
  )
}

/** 取消固定: the same padlock with its shackle lifted. */
export function UnpinIcon(): ReactNode {
  return (
    <Glyph>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.6" />
      <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V6" />
    </Glyph>
  )
}

/** 轮换: a circular arrow — swap in a reserve, or sink to the tail. */
export function RotateIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M12.8 8A4.8 4.8 0 1 1 8 3.2" />
      <path d="M6.2 1.6 8 3.2 6.2 4.8" />
    </Glyph>
  )
}
