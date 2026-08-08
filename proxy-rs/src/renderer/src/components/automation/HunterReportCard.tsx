import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  FolderOpen,
  Loader2,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  ShoppingCart,
  Truck
} from 'lucide-react'
import {
  HUNTER_REPORT_WINDOW_DAYS,
  HUNTER_REPORT_WINDOW_OPTIONS,
  type HunterReport,
  type HunterReportChannelRow,
  type HunterReportLinkRow
} from '../../../../shared/hunterReport'
import { KSK_HUNTER_CHANNEL_LABEL } from '../../../../shared/kskHunter'
import { Button, Card, CardContent } from '../ui'
import { TrendChart, type TrendSeries } from '../stats/TrendChart'
import { cn } from '@/lib/utils'

/** 与反代统计页同一套语义配色：放货=紫、下单=蓝、交付=绿、失败=红。 */
const SERIES_COLOR = {
  restock: '#a855f7',
  order: '#3b82f6',
  delivered: '#22c55e',
  failed: '#ef4444',
  spend: '#0ea5e9'
} as const

/** 明细表的两种维度。 */
const REPORT_DIMENSION = {
  CHANNEL: 'channel',
  LINK: 'link'
} as const

type ReportDimension = (typeof REPORT_DIMENSION)[keyof typeof REPORT_DIMENSION]

function formatCount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function formatCny(value: number): string {
  return `¥${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function formatRate(value?: number): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

function formatDate(value?: number): string {
  return value ? new Date(value).toLocaleString() : '—'
}

interface StatCellProps {
  label: string
  value: string
  hint?: string
  icon: React.ElementType
  accent: string
  tone?: 'default' | 'warn' | 'danger'
}

function StatCell({
  label,
  value,
  hint,
  icon: Icon,
  accent,
  tone = 'default'
}: StatCellProps): React.ReactNode {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/15 p-3">
      <div
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
        style={{ backgroundColor: `${accent}1f`, color: accent }}
      >
        <Icon className="h-4 w-4" strokeWidth={1.9} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={cn(
            'text-lg font-semibold tabular-nums',
            tone === 'danger' && 'text-red-500',
            tone === 'warn' && 'text-amber-500'
          )}
        >
          {value}
        </p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  )
}

/**
 * 放货时段分布。
 *
 * 用 div 高度画柱子而不是复用 TrendChart：24 个离散桶用折线读不出「哪个钟点开货」，
 * 柱状才是对的表达，而且这点结构不值得再抽一个组件。
 */
function RestockHours({ buckets }: { buckets: number[] }): React.ReactNode {
  const max = Math.max(...buckets, 0)
  if (max === 0) {
    return (
      <div className="grid h-24 place-items-center rounded-xl border border-dashed border-border/60 text-xs text-muted-foreground">
        窗口内还没抓到放货
      </div>
    )
  }
  const peak = buckets.indexOf(max)
  return (
    <div>
      <div className="flex h-24 items-end gap-0.5">
        {buckets.map((count, hour) => (
          <div
            key={hour}
            className="group relative flex-1"
            title={`${String(hour).padStart(2, '0')}:00 · ${formatCount(count)} 次放货`}
          >
            <div
              className={cn(
                'w-full rounded-t transition-colors',
                hour === peak ? 'bg-violet-500' : 'bg-violet-500/35 group-hover:bg-violet-500/60'
              )}
              // 有数据的桶至少给 2px，否则 1 次放货在 max 很大时完全看不见
              style={{ height: count > 0 ? `${Math.max(2, (count / max) * 96)}px` : '1px' }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-2xs text-muted-foreground">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        放货最密集的时段是 {String(peak).padStart(2, '0')}:00（{formatCount(max)} 次）。
      </p>
    </div>
  )
}

/** 渠道行与链接行的公共列，两种维度共用一套渲染。 */
type ReportRow = (HunterReportChannelRow | HunterReportLinkRow) & { rowKey: string; title: string }

function toChannelRows(report: HunterReport): ReportRow[] {
  return report.byChannel.map((row) => ({
    ...row,
    rowKey: row.channel,
    title: KSK_HUNTER_CHANNEL_LABEL[row.channel]
  }))
}

function toLinkRows(report: HunterReport): ReportRow[] {
  return report.byLink.map((row) => ({
    ...row,
    rowKey: row.linkId,
    title: row.linkName
  }))
}

export function HunterReportCard(): React.ReactNode {
  const [report, setReport] = useState<HunterReport | null>(null)
  const [days, setDays] = useState<number>(HUNTER_REPORT_WINDOW_DAYS)
  const [loading, setLoading] = useState(true)
  const [dimension, setDimension] = useState<ReportDimension>(REPORT_DIMENSION.CHANNEL)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async (windowDays: number): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await window.api.kskHunterReport(windowDays)
      if (!result.success) throw new Error(result.error || '读取抢号报表失败')
      setReport(result.data)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(days)
  }, [days, load])

  const handleReveal = useCallback(async (): Promise<void> => {
    setNotice('')
    const result = await window.api.kskHunterRevealReportFile()
    if (!result.success) {
      setError(result.error || '打开历史文件失败')
      return
    }
    setNotice(`历史事件文件：${result.data}`)
  }, [])

  const trend = useMemo(() => {
    const daily = report?.daily ?? []
    const timestamps = daily.map((day) => day.at)
    const outcomeSeries: TrendSeries[] = [
      {
        key: 'restocks',
        label: '放货',
        color: SERIES_COLOR.restock,
        values: daily.map((day) => day.restocks)
      },
      {
        key: 'orders',
        label: '下单',
        color: SERIES_COLOR.order,
        values: daily.map((day) => day.orders)
      },
      {
        key: 'delivered',
        label: '交付',
        color: SERIES_COLOR.delivered,
        values: daily.map((day) => day.delivered)
      },
      {
        key: 'failed',
        label: '失败（验活+推送）',
        color: SERIES_COLOR.failed,
        values: daily.map((day) => day.deadKeys + day.deliveryFailed)
      }
    ]
    const spendSeries: TrendSeries[] = [
      {
        key: 'spendCny',
        label: '日花费',
        color: SERIES_COLOR.spend,
        values: daily.map((day) => day.spendCny),
        area: true
      }
    ]
    return { timestamps, outcomeSeries, spendSeries }
  }, [report])

  const rows = useMemo(() => {
    if (!report) return []
    return dimension === REPORT_DIMENSION.CHANNEL ? toChannelRows(report) : toLinkRows(report)
  }, [report, dimension])

  const totals = report?.totals
  const avgDailyCny =
    totals && totals.activeDays > 0
      ? Math.round((totals.spendCny / totals.activeDays) * 100) / 100
      : 0

  return (
    <Card className="mb-5 border-border/70 bg-card/70">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <BarChart3 className="h-4 w-4 text-violet-500" />
          <h3 className="text-sm font-semibold">抢号报表</h3>
          {report && (
            <span className="text-xs text-muted-foreground">
              {report.fromDate} → {report.toDate}
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {HUNTER_REPORT_WINDOW_OPTIONS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={days === option ? 'default' : 'ghost'}
                onClick={() => setDays(option)}
                disabled={loading}
              >
                近 {option} 天
              </Button>
            ))}
            <Button size="sm" variant="outline" onClick={() => void load(days)} disabled={loading}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleReveal()}
              title="历史事件全量保留在这个文件里"
            >
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              历史文件
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        )}
        {notice && (
          <p className="break-all rounded-xl border border-border/60 bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground">
            {notice}
          </p>
        )}

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <StatCell
            label="放货 → 下单"
            value={`${formatCount(totals?.orders ?? 0)} / ${formatCount(totals?.restocks ?? 0)}`}
            hint={`抢中率 ${formatRate(totals?.orderRate)}`}
            icon={PackageCheck}
            accent={SERIES_COLOR.restock}
          />
          <StatCell
            label="窗口花费"
            value={formatCny(totals?.spendCny ?? 0)}
            hint={`均价 ${totals?.avgCostCny === undefined ? '—' : formatCny(totals.avgCostCny)} · 活跃 ${formatCount(totals?.activeDays ?? 0)} 天日均 ${formatCny(avgDailyCny)}`}
            icon={ShoppingCart}
            accent={SERIES_COLOR.spend}
          />
          <StatCell
            label="交付成功"
            value={formatCount(totals?.delivered ?? 0)}
            hint={`交付率 ${formatRate(totals?.deliverRate)}`}
            icon={Truck}
            accent={SERIES_COLOR.delivered}
          />
          <StatCell
            label="废号 / 推送失败"
            value={`${formatCount(totals?.deadKeys ?? 0)} / ${formatCount(totals?.deliveryFailed ?? 0)}`}
            hint={`验活失败率 ${formatRate(totals?.deadKeyRate)} · 拦单 ${formatCount(totals?.blocks ?? 0)} 次`}
            icon={ShieldAlert}
            accent={SERIES_COLOR.failed}
            tone={
              (totals?.deadKeys ?? 0) + (totals?.deliveryFailed ?? 0) > 0 ? 'danger' : 'default'
            }
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium">成果趋势（按天）</p>
            <TrendChart
              timestamps={trend.timestamps}
              series={trend.outcomeSeries}
              formatValue={formatCount}
              emptyHint={loading ? '正在读取历史' : '窗口内还没有抢号记录'}
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">每日花费</p>
            <TrendChart
              timestamps={trend.timestamps}
              series={trend.spendSeries}
              formatValue={(value) => formatCny(value)}
              emptyHint={loading ? '正在读取历史' : '窗口内还没有花费'}
            />
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium">放货时段分布（本地时间）</p>
          <RestockHours buckets={report?.restockByHour ?? []} />
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium">分维度明细</p>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                size="sm"
                variant={dimension === REPORT_DIMENSION.CHANNEL ? 'default' : 'ghost'}
                onClick={() => setDimension(REPORT_DIMENSION.CHANNEL)}
              >
                按渠道
              </Button>
              <Button
                size="sm"
                variant={dimension === REPORT_DIMENSION.LINK ? 'default' : 'ghost'}
                onClick={() => setDimension(REPORT_DIMENSION.LINK)}
              >
                按链接
              </Button>
            </div>
          </div>

          {loading && !report ? (
            <div className="grid h-20 place-items-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <div className="grid h-20 place-items-center rounded-xl border border-dashed border-border/60 text-xs text-muted-foreground">
              窗口内没有记录
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-xs text-muted-foreground">
                    <th className="px-2 py-2 text-left font-medium">
                      {dimension === REPORT_DIMENSION.CHANNEL ? '渠道' : '链接'}
                    </th>
                    <th className="px-2 py-2 text-right font-medium">放货</th>
                    <th className="px-2 py-2 text-right font-medium">下单</th>
                    <th className="px-2 py-2 text-right font-medium">交付</th>
                    <th className="px-2 py-2 text-right font-medium">废号</th>
                    <th className="px-2 py-2 text-right font-medium">推送失败</th>
                    <th className="px-2 py-2 text-right font-medium">拦单</th>
                    <th className="px-2 py-2 text-right font-medium">花费</th>
                    <th className="px-2 py-2 text-left font-medium">最近下单</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.rowKey} className="border-b border-border/40 last:border-0">
                      <td className="px-2 py-2">
                        <span className="font-medium">{row.title}</span>
                        {dimension === REPORT_DIMENSION.LINK && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {KSK_HUNTER_CHANNEL_LABEL[row.channel]}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatCount(row.restocks)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatCount(row.orders)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatCount(row.delivered)}
                      </td>
                      <td
                        className={cn(
                          'px-2 py-2 text-right tabular-nums',
                          row.deadKeys > 0 && 'font-medium text-amber-500'
                        )}
                      >
                        {formatCount(row.deadKeys)}
                      </td>
                      <td
                        className={cn(
                          'px-2 py-2 text-right tabular-nums',
                          row.deliveryFailed > 0 && 'font-medium text-red-500'
                        )}
                      >
                        {formatCount(row.deliveryFailed)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {formatCount(row.blocks)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {/* 原币是记账口径，非人民币渠道才补一行折算 */}
                        <span>
                          {row.spendUnit} {row.unitLabel}
                        </span>
                        {row.unitLabel !== 'CNY' && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ≈ {formatCny(row.spendCny)}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {formatDate(row.lastOrderedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="border-t border-border/60 pt-2 text-xs text-muted-foreground">
          事件历史全量保留在本机，报表只展示所选窗口。
          {report?.earliestEventAt
            ? ` 已攒 ${formatCount(report.totalEventCount)} 条事件，最早 ${formatDate(report.earliestEventAt)}。`
            : ' 抢号产生第一条记录后这里就会有数据。'}
        </p>
      </CardContent>
    </Card>
  )
}
