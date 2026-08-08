import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * 轻量趋势折线图。
 *
 * 手写 SVG 而不引图表库：这里只需要「几条线 + 悬停读数」，
 * 为一个页面装 recharts/echarts 会把打包体积和依赖面拉得不成比例。
 *
 * viewBox 用固定坐标系 + preserveAspectRatio="none"，让 CSS 决定实际尺寸，
 * 省掉 ResizeObserver 测宽那一套。
 */

const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 260
const PADDING = { top: 12, right: 12, bottom: 22, left: 12 }
/** 横轴网格线数量（含首尾） */
const GRID_LINES = 4

export interface TrendSeries {
  key: string
  label: string
  color: string
  /** 与 timestamps 等长；undefined 表示该时刻无数据，线段断开 */
  values: (number | undefined)[]
  /** 面积填充，用于用量这类"存量"指标 */
  area?: boolean
}

interface TrendChartProps {
  timestamps: number[]
  series: TrendSeries[]
  /** 纵轴刻度与悬停读数的格式化 */
  formatValue?: (value: number) => string
  emptyHint?: string
  className?: string
}

function defaultFormat(value: number): string {
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

interface TrendSegment {
  path: string
  /** 段起点的 x，画面积填充时要回到这里闭合 */
  startX: number
}

/** 把一条序列切成若干连续段：undefined 处断线，而不是把缺口连成直线。 */
function buildSegments(
  values: (number | undefined)[],
  xAt: (index: number) => number,
  yAt: (value: number) => number
): TrendSegment[] {
  const segments: TrendSegment[] = []
  let commands: string[] = []
  let startX = 0
  const flush = (): void => {
    if (commands.length > 0) segments.push({ path: commands.join(' '), startX })
    commands = []
  }
  values.forEach((value, index) => {
    if (value === undefined) {
      flush()
      return
    }
    const x = xAt(index)
    if (commands.length === 0) startX = x
    commands.push(`${commands.length === 0 ? 'M' : 'L'}${x},${yAt(value)}`)
  })
  flush()
  return segments
}

export function TrendChart({
  timestamps,
  series,
  formatValue = defaultFormat,
  emptyHint = '暂无采样数据',
  className
}: TrendChartProps): React.ReactNode {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  const geometry = useMemo(() => {
    const innerWidth = VIEW_WIDTH - PADDING.left - PADDING.right
    const innerHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom
    const visible = series.filter((item) => item.values.some((value) => value !== undefined))
    let max = 0
    for (const item of visible) {
      for (const value of item.values) {
        if (value !== undefined && value > max) max = value
      }
    }
    // 全零时给个 1 的上界，否则所有点都压在底边看不出线
    const upper = max > 0 ? max * 1.1 : 1
    const step = timestamps.length > 1 ? innerWidth / (timestamps.length - 1) : 0
    const xAt = (index: number): number =>
      timestamps.length > 1 ? PADDING.left + index * step : PADDING.left + innerWidth / 2
    const yAt = (value: number): number => PADDING.top + innerHeight - (value / upper) * innerHeight
    return { innerWidth, innerHeight, upper, xAt, yAt, visible }
  }, [series, timestamps])

  if (timestamps.length === 0 || geometry.visible.length === 0) {
    return (
      <div
        className={cn(
          'grid h-[220px] place-items-center rounded-xl border border-dashed border-border/60 text-sm text-muted-foreground',
          className
        )}
      >
        {emptyHint}
      </div>
    )
  }

  const hoverAt = hoverIndex !== null ? timestamps[hoverIndex] : undefined

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[220px] w-full"
        role="img"
        aria-label={`趋势图，${geometry.visible.map((item) => item.label).join('、')}，共 ${timestamps.length} 个采样点`}
        onMouseLeave={() => setHoverIndex(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (rect.width === 0) return
          const ratio = (event.clientX - rect.left) / rect.width
          const x = ratio * VIEW_WIDTH
          const innerRatio = Math.min(
            1,
            Math.max(0, (x - PADDING.left) / Math.max(1, geometry.innerWidth))
          )
          setHoverIndex(Math.round(innerRatio * (timestamps.length - 1)))
        }}
      >
        {Array.from({ length: GRID_LINES + 1 }, (_, index) => {
          const y = PADDING.top + (geometry.innerHeight / GRID_LINES) * index
          return (
            <line
              key={index}
              x1={PADDING.left}
              x2={VIEW_WIDTH - PADDING.right}
              y1={y}
              y2={y}
              className="stroke-border/50"
              strokeWidth={1}
            />
          )
        })}

        {geometry.visible.map((item) => {
          const segments = buildSegments(item.values, geometry.xAt, geometry.yAt)
          const baseline = PADDING.top + geometry.innerHeight
          return (
            <g key={item.key}>
              {item.area &&
                segments.map((segment, index) => (
                  <path
                    key={`area-${index}`}
                    d={`${segment.path} V${baseline} H${segment.startX} Z`}
                    fill={item.color}
                    opacity={0.12}
                  />
                ))}
              {segments.map((segment, index) => (
                <path
                  key={`line-${index}`}
                  d={segment.path}
                  fill="none"
                  stroke={item.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          )
        })}

        {hoverIndex !== null && (
          <line
            x1={geometry.xAt(hoverIndex)}
            x2={geometry.xAt(hoverIndex)}
            y1={PADDING.top}
            y2={PADDING.top + geometry.innerHeight}
            className="stroke-foreground/40"
            strokeWidth={1}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {geometry.visible.map((item) => {
            const hovered = hoverIndex !== null ? item.values[hoverIndex] : undefined
            return (
              <span key={item.key} className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                <span>{item.label}</span>
                {hovered !== undefined && (
                  <span className="font-medium text-foreground">{formatValue(hovered)}</span>
                )}
              </span>
            )
          })}
        </div>
        <span className="tabular-nums">
          {hoverAt
            ? new Date(hoverAt).toLocaleString()
            : `${formatClock(timestamps[0])} → ${formatClock(timestamps[timestamps.length - 1])}`}
        </span>
      </div>
    </div>
  )
}
