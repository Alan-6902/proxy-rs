import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Coins,
  Download,
  FolderOpen,
  FolderCog,
  Handshake,
  Loader2,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
  Wallet
} from 'lucide-react'
import {
  DOWNSTREAM_ALL_HOURS,
  DOWNSTREAM_REPORT_WINDOW_DAYS,
  DOWNSTREAM_REPORT_WINDOW_OPTIONS,
  type DownstreamDeliveryRow,
  type DownstreamReport,
  type DownstreamReportHour
} from '../../../../shared/downstreamSettlement'
import { KSK_HUNTER_CHANNEL_LABEL } from '../../../../shared/kskHunter'
import { KSK_LEDGER_STATE, KSK_LEDGER_STATE_LABEL } from '../../../../shared/kskLedger'
import { Badge, Button, Card, CardContent, Input, PageHeader } from '../ui'
import { cn } from '@/lib/utils'

/** 语义配色：交付=绿、积分=玫红、花费=天蓝，与台账页和反代统计页保持一致。 */
const ACCENT = {
  delivery: '#22c55e',
  credits: '#f43f5e',
  spend: '#0ea5e9'
} as const

function formatCount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function formatCny(value: number): string {
  return `¥${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function formatCredits(value?: number): string {
  return value === undefined ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/** 本地日期键 YYYY-MM-DD，与主进程口径一致（不能用 toISOString，那按 UTC 切）。 */
function localDateKey(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function shiftDateKey(date: string, deltaDays: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(year, month - 1, day)
  shifted.setDate(shifted.getDate() + deltaDays)
  return localDateKey(shifted.getTime())
}

interface StatCellProps {
  label: string
  value: string
  hint?: string
  icon: React.ElementType
  accent: string
}

function StatCell({ label, value, hint, icon: Icon, accent }: StatCellProps): React.ReactNode {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" style={{ color: accent }} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * 24 小时交付分布。点某根柱子筛下面的清单，再点一次取消。
 *
 * 与抢号报表的放货时段图同一形状，但这里的柱子可点：对账时要看「某小时交了哪几个号」。
 */
function DeliveryHours({
  buckets,
  selected,
  onSelect
}: {
  buckets: number[]
  selected: DownstreamReportHour
  onSelect: (hour: DownstreamReportHour) => void
}): React.ReactNode {
  const max = Math.max(...buckets, 0)
  if (max === 0) {
    return (
      <div className="grid h-24 place-items-center rounded-xl border border-dashed border-border/60 text-xs text-muted-foreground">
        这一天没有交付记录
      </div>
    )
  }
  return (
    <div>
      <div className="flex h-24 items-end gap-0.5">
        {buckets.map((count, hour) => {
          const active = selected === hour
          return (
            <button
              key={hour}
              type="button"
              className="group relative flex-1 cursor-pointer"
              title={`${String(hour).padStart(2, '0')}:00 · 交付 ${formatCount(count)} 个${count > 0 ? '（点击筛选）' : ''}`}
              aria-label={`${String(hour).padStart(2, '0')} 时交付 ${count} 个`}
              aria-pressed={active}
              onClick={() => onSelect(active ? DOWNSTREAM_ALL_HOURS : hour)}
            >
              <div
                className={cn(
                  'w-full rounded-t transition-colors',
                  active ? 'bg-emerald-500' : 'bg-emerald-500/35 group-hover:bg-emerald-500/60'
                )}
                // 有数据的桶至少给 2px，否则 1 个号在 max 很大时完全看不见
                style={{ height: count > 0 ? `${Math.max(2, (count / max) * 96)}px` : '1px' }}
              />
            </button>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-2xs text-muted-foreground">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {selected === DOWNSTREAM_ALL_HOURS
          ? '点柱子看该小时交付的号；再点一次看全天。'
          : `正在看 ${String(selected).padStart(2, '0')}:00 这一小时。`}
      </p>
    </div>
  )
}

/** 一行号明细。页面上只显示脱敏 key；完整 key 只在 CSV 里。 */
function DeliveryRow({ row }: { row: DownstreamDeliveryRow }): React.ReactNode {
  return (
    <tr className="border-b border-border/40 last:border-0">
      <td className="px-2 py-2">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs">{row.maskedKey}</span>
          {!row.deliveredToday && (
            <Badge
              variant="outline"
              className="border-border/50 text-2xs text-muted-foreground"
              title="更早交付的号，这一天仍在烧积分"
            >
              往期
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {row.region} · {KSK_HUNTER_CHANNEL_LABEL[row.channel]} · {row.linkName}
        </p>
      </td>
      <td className="px-2 py-2 text-xs tabular-nums text-muted-foreground">
        {row.deliveredToday
          ? formatClock(row.deliveredAt)
          : new Date(row.deliveredAt).toLocaleDateString()}
        {row.attempts > 1 && (
          <span className="ml-1 text-amber-600 dark:text-amber-400" title="推送重试过">
            ×{row.attempts}
          </span>
        )}
      </td>
      <td className="px-2 py-2 text-xs text-muted-foreground">{row.groupName ?? '未分组'}</td>
      <td className="px-2 py-2 text-right text-xs tabular-nums">
        {row.costCny === undefined ? '—' : formatCny(row.costCny)}
        {row.costUnit !== undefined && row.unitLabel && (
          <span className="ml-1 text-muted-foreground">
            ({row.costUnit} {row.unitLabel})
          </span>
        )}
      </td>
      <td
        className="px-2 py-2 text-right font-medium tabular-nums text-rose-600 dark:text-rose-400"
        title={
          row.creditsFromAt && row.creditsToAt
            ? `区间 ${new Date(row.creditsFromAt).toLocaleString()} → ${new Date(row.creditsToAt).toLocaleString()}`
            : '台账里查不到这个号的消耗'
        }
      >
        {formatCredits(row.creditsDelta)}
      </td>
      <td className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground">
        {formatCredits(row.totalCredits)}
      </td>
      <td className="px-2 py-2 text-right text-2xs">
        {row.state === undefined ? (
          <span className="text-muted-foreground" title="台账里查不到，可能已被清空">
            未知
          </span>
        ) : (
          <span
            className={cn(
              row.state === KSK_LEDGER_STATE.ALIVE
                ? 'text-emerald-600 dark:text-emerald-400'
                : row.state === KSK_LEDGER_STATE.DEAD_ON_ARRIVAL
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-muted-foreground'
            )}
          >
            {KSK_LEDGER_STATE_LABEL[row.state]}
          </span>
        )}
      </td>
    </tr>
  )
}

export function DownstreamSettlementPage(): React.ReactNode {
  const [report, setReport] = useState<DownstreamReport | null>(null)
  const [date, setDate] = useState<string>(() => localDateKey(Date.now()))
  const [days, setDays] = useState<number>(DOWNSTREAM_REPORT_WINDOW_DAYS)
  const [hour, setHour] = useState<DownstreamReportHour>(DOWNSTREAM_ALL_HOURS)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async (targetDate: string, windowDays: number): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await window.api.downstreamReport(targetDate, windowDays)
      if (!result.success) throw new Error(result.error || '读取对账数据失败')
      setReport(result.data ?? null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(date, days)
  }, [date, days, load])

  // 换日期就清掉小时筛选：上一天选的 14 点在这一天可能压根没有交付
  useEffect(() => {
    setHour(DOWNSTREAM_ALL_HOURS)
  }, [date])

  const handleExport = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await window.api.downstreamExportDay(date)
      if (!result.success) throw new Error(result.error || '导出失败')
      setNotice(`已导出：${result.data}`)
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError))
    } finally {
      setBusy(false)
    }
  }, [date])

  const handlePickDir = useCallback(async (): Promise<void> => {
    setError('')
    setNotice('')
    const result = await window.api.downstreamPickCsvDir()
    if (!result.success) {
      setError(result.error || '选择目录失败')
      return
    }
    // data 为 null 表示用户取消，不必提示
    if (!result.data) return
    setNotice(`导出目录已改为：${result.data}`)
    await load(date, days)
  }, [date, days, load])

  const handleOpenDir = useCallback(async (): Promise<void> => {
    setError('')
    setNotice('')
    const result = await window.api.downstreamOpenCsvDir()
    if (!result.success) setError(result.error || '打开目录失败')
  }, [])

  /**
   * 立刻补齐所有未结算的过去日期。
   *
   * 正常由后台每半小时自动跑，这个按钮是给「刚打开应用就想对账」用的——
   * 不想等下一轮 tick。只结算已经过去的天，今天不会被定稿。
   */
  const handleSettle = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await window.api.downstreamSettleNow()
      if (!result.success) throw new Error(result.error || '结算失败')
      setNotice('已补齐未结算的日期，CSV 也一并写好了')
      await load(date, days)
    } catch (settleError) {
      setError(settleError instanceof Error ? settleError.message : String(settleError))
    } finally {
      setBusy(false)
    }
  }, [date, days, load])

  const rows = useMemo(() => {
    const list = report?.rows ?? []
    if (hour === DOWNSTREAM_ALL_HOURS) return list
    // 只筛当天交付的：往期号的 hour 是它自己交付那天的小时，按本日小时筛没有意义
    return list.filter((row) => row.deliveredToday && row.hour === hour)
  }, [report, hour])

  const today = localDateKey(Date.now())
  const maxDailyDeliveries = Math.max(...(report?.daily ?? []).map((day) => day.deliveries), 1)

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <PageHeader
        title="下游对账"
        eyebrow="Downstream Settlement"
        icon={Handshake}
        accent="violet"
        description="逐日核对交给下游的号：哪天交了哪些、下游拿它们烧了多少积分。每天自动落一份 CSV 长期存档，用来跟下游对账收款。"
        badges={
          report && (
            <span className="text-xs text-muted-foreground">
              累计交付 {formatCount(report.totalDeliveryCount)} 个
              {report.earliestDeliveredAt
                ? ` · 最早 ${new Date(report.earliestDeliveredAt).toLocaleDateString()}`
                : ''}
            </span>
          )
        }
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDate(shiftDateKey(date, -1))}
              disabled={loading}
            >
              前一天
            </Button>
            <Input
              type="date"
              value={date}
              max={today}
              className="h-8 w-[9.5rem]"
              onChange={(event) => {
                if (event.target.value) setDate(event.target.value)
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDate(shiftDateKey(date, 1))}
              disabled={loading || date >= today}
            >
              后一天
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDate(today)} disabled={loading}>
              今天
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void load(date, days)}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
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

        <Card className="border-border/70 bg-card/70">
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{date} 当日对账</h3>
              {report &&
                (report.settled ? (
                  <Badge className="border-emerald-500/30 bg-emerald-500/10 text-2xs text-emerald-600 dark:text-emerald-300">
                    已定稿
                    {report.settledAt ? ` · ${formatClock(report.settledAt)}` : ''}
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="border-amber-500/30 bg-amber-500/10 text-2xs text-amber-700 dark:text-amber-300"
                    title={
                      date === today
                        ? '今天还没结算，积分是按当前台账实时估算的，数字还会变'
                        : '这一天还没结算，积分待结算后才有数；交付数与花费不受影响'
                    }
                  >
                    未定稿
                  </Badge>
                ))}
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleExport()}
                  disabled={busy}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  导出这天的 CSV
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleSettle()}
                  disabled={busy}
                  title="立刻补齐所有未结算的过去日期；今天不会被定稿"
                >
                  <Coins className="mr-1.5 h-3.5 w-3.5" />
                  立即结算
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void handleOpenDir()}>
                  <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                  打开目录
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void handlePickDir()}>
                  <FolderCog className="mr-1.5 h-3.5 w-3.5" />
                  改目录
                </Button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <StatCell
                label="当日交付"
                value={formatCount(report?.deliveries ?? 0)}
                hint={`累计 ${formatCount(report?.totalDeliveryCount ?? 0)} 个`}
                icon={PackageCheck}
                accent={ACCENT.delivery}
              />
              <StatCell
                label="当日新增积分"
                value={formatCredits(report?.credits ?? 0)}
                hint={
                  report?.settled
                    ? '已定稿，不再变动'
                    : date === today
                      ? '按当前台账实时估算'
                      : '待结算，结算后才有数'
                }
                icon={Coins}
                accent={ACCENT.credits}
              />
              <StatCell
                label="当日买入花费"
                value={formatCny(report?.spendCny ?? 0)}
                hint={`累计 ${formatCny(report?.totalSpendCny ?? 0)}`}
                icon={Wallet}
                accent={ACCENT.spend}
              />
              <StatCell
                label="参与结算的号"
                value={formatCount(report?.rows.length ?? 0)}
                hint="当日交付 + 当日仍在烧积分的往期号"
                icon={Handshake}
                accent={ACCENT.delivery}
              />
            </div>

            <div>
              <p className="mb-1 text-xs font-medium">交付时段分布（本地时间）</p>
              <DeliveryHours
                buckets={report?.deliveriesByHour ?? []}
                selected={hour}
                onSelect={setHour}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/70">
          <CardContent className="space-y-2 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium">
                号明细
                {hour !== DOWNSTREAM_ALL_HOURS && ` · 只看 ${String(hour).padStart(2, '0')}:00`}
              </p>
              {hour !== DOWNSTREAM_ALL_HOURS && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-2xs"
                  onClick={() => setHour(DOWNSTREAM_ALL_HOURS)}
                >
                  看全天
                </Button>
              )}
              <span className="ml-auto text-2xs text-muted-foreground">
                页面只显示脱敏 Key，完整 Key 在导出的 CSV 里
              </span>
            </div>

            {loading && !report ? (
              <div className="grid h-20 place-items-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : rows.length === 0 ? (
              <div className="grid h-20 place-items-center rounded-xl border border-dashed border-border/60 text-xs text-muted-foreground">
                这一天没有需要对账的号
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-xs text-muted-foreground">
                      <th className="px-2 py-2 text-left font-medium">号 / 来源</th>
                      <th className="px-2 py-2 text-left font-medium">交付时刻</th>
                      <th className="px-2 py-2 text-left font-medium">分组</th>
                      <th className="px-2 py-2 text-right font-medium">买入价</th>
                      <th className="px-2 py-2 text-right font-medium">当日积分</th>
                      <th className="px-2 py-2 text-right font-medium">累计积分</th>
                      <th className="px-2 py-2 text-right font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <DeliveryRow key={row.id} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/70">
          <CardContent className="space-y-2 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium">按天汇总</p>
              <div className="ml-auto flex items-center gap-1.5">
                {DOWNSTREAM_REPORT_WINDOW_OPTIONS.map((option) => (
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
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-xs text-muted-foreground">
                    <th className="px-2 py-2 text-left font-medium">日期</th>
                    <th className="px-2 py-2 text-left font-medium">交付量</th>
                    <th className="px-2 py-2 text-right font-medium">交付数</th>
                    <th className="px-2 py-2 text-right font-medium">积分</th>
                    <th className="px-2 py-2 text-right font-medium">花费</th>
                    <th className="px-2 py-2 text-right font-medium">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(report?.daily ?? [])].reverse().map((day) => (
                    <tr
                      key={day.date}
                      className={cn(
                        'cursor-pointer border-b border-border/40 last:border-0 hover:bg-muted/30',
                        day.date === date && 'bg-muted/40'
                      )}
                      onClick={() => setDate(day.date)}
                      title="点击查看这一天的明细"
                    >
                      <td className="px-2 py-1.5 text-xs tabular-nums">{day.date}</td>
                      <td className="px-2 py-1.5">
                        {/* 迷你条形：一眼看出哪几天出货多，不必读数字 */}
                        <div className="h-2 w-full max-w-[8rem] rounded-full bg-muted/40">
                          <div
                            className="h-2 rounded-full bg-emerald-500/70"
                            style={{
                              width: `${(day.deliveries / maxDailyDeliveries) * 100}%`
                            }}
                          />
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs tabular-nums">
                        {formatCount(day.deliveries)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCredits(day.credits)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs tabular-nums">
                        {formatCny(day.spendCny)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-2xs text-muted-foreground">
                        {day.settled ? '已定稿' : '未定稿'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="flex items-start gap-2.5 p-4">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">导出的 CSV 含完整 KSK 明文</p>
              <p>
                这是对账需要（下游握的是完整 Key）。文件权限已压到仅本人可读，但它是磁盘上唯一
                存在明文的地方——
                <span className="font-medium">
                  目录若指向 iCloud、坚果云等同步盘，号会被上传到云端
                </span>
                。
              </p>
              {report && <p className="break-all font-mono">当前导出目录：{report.csvDir}</p>}
              <p>
                每天自动结算一次前一天的账并写 CSV。应用关了几天再打开会自动补齐，
                积分按「上次结算到本次结算」的区间记，CSV 里带区间起止两列。
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
