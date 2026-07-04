import { css } from '@/styled-system/css'

import type { TrendPoint } from '../api/adminStats'

/**
 * Minimal, dependency-free 14-day bar chart for the dashboard. A single accent
 * colour (theme-aware via a Panda token → `currentColor`), zero-height days
 * drawn as a hairline baseline, and a native `<title>` per bar for the
 * date/value tooltip. Deliberately tiny — an internal activity sparkline, not a
 * full charting surface.
 */
export const TrendBarChart = ({ data }: { data: TrendPoint[] }) => {
  const max = Math.max(1, ...data.map((d) => d.count))
  const width = 100
  const height = 36
  const gap = 1.4
  const n = Math.max(1, data.length)
  const barWidth = (width - gap * (n - 1)) / n

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      className={css({
        width: '100%',
        height: '120px',
        display: 'block',
        color: 'primary.400',
      })}
    >
      {data.map((d, i) => {
        const h = (d.count / max) * (height - 1)
        const x = i * (barWidth + gap)
        const y = height - Math.max(h, 0.4)
        return (
          <rect
            key={d.date}
            x={x}
            y={y}
            width={barWidth}
            height={Math.max(h, 0.4)}
            rx={0.5}
            fill="currentColor"
            opacity={d.count === 0 ? 0.25 : 1}
          >
            <title>{`${d.date}: ${d.count}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}
