import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BookOpenCheck,
  Clock,
  Coins,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  TrendingDown,
  Wallet
} from 'lucide-react'
import {
  KSK_LEDGER_DEFAULT_WINDOW_DAYS,
  KSK_LEDGER_RETIRE_REASON_LABEL,
  KSK_LEDGER_SORT,
  KSK_LEDGER_STATE,
  KSK_LEDGER_STATE_LABEL,
  KSK_LEDGER_WINDOW_OPTIONS,
  formatLedgerDuration,
  type KskLedgerReport,
  type KskLedgerRow,
  type KskLedgerSort,
  type KskLedgerState
} from '../../../../shared/kskLedger'
import { KSK_HUNTER_CHANNEL_LABEL } from '../../../../shared/kskHunter'
import { Badge, Button, Card, CardContent, PageHeader, askConfirm } from '../ui'
import { cn } from '@/lib/utils'

/** 状态徽标配色：在用=绿、已下线=灰、买到即废=红（白花钱）。 */
const STATE_TONE: Record<KskLedgerState, string> = {
  [KSK_LEDGER_STATE.ALIVE]:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  [KSK_LEDGER_STATE.RETIRED]: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300',
  [KSK_LEDGER_STATE.DEAD_ON_ARRIVAL]:
    'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
}

const SORT_OPTIONS: { key: KskLedgerSort; label: string }[] = [
  { key: KSK_LEDGER_SORT.PURCHASED, label: '最近买入' },
  { key: KSK_LEDGER_SORT.COST, label: '花费' },
  { key: KSK_LEDGER_SORT.CREDITS, label: '消耗积分' },
  { key: KSK_LEDGER_SORT.ALIVE, label: '存活时长' },
  { key: KSK_LEDGER_SORT.EFFICIENCY, label: '每分单价' }
]

/** KPI 语义配色，与反代统计页保持一致（积分=玫红、花费=天蓝）。 */
const ACCENT = {
  spend: '#0ea5e9',
  credits: '#f43f5e',
  alive: '#a855f7',
  efficiency: '#22c55e'
} as const

function formatCount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function formatCny(value?: number): string {
  return value === undefined
    ? '—'
    : `¥${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function formatCredits(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatPercent(value?: number): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

/**
 * 每积分单价。
 *
 * 积分单价通常远小于 1 分钱（50 积分买 10000 额度 ≈ ¥0.005/分），
 * 按 ¥ 两位小数显示会全是 0.00，所以按「每千积分」计价。
 */
function formatPerCredit(value?: number): string {
  return value === undefined ? '—' : `¥${(value * 1000).toFixed(2)}/千分`
}

function formatDate(value?: number): string {
  return value ? new Date(value).toLocaleString() : '—'
}

interface KpiCardProps {
  label: string
  value: string
  hint?: string
  icon: React.ElementType
  accent: string
  valueTitle?: string
}

function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  accent,
  valueTitle
}: KpiCardProps): React.ReactNode {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
          style={{ backgroundColor: `${accent}1f`, color: accent }}
        >
          <Icon className="h-5 w-5" strokeWidth={1.9} />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tabular-nums" title={valueTitle}>
            {value}
          </p>
          {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

/** 一行台账。抽出来是因为单元格里的 title 提示不少，塞在表体里读不动。 */
function LedgerRow({ row }: { row: KskLedgerRow }): React.ReactNode {
  const wasted = row.state === KSK_LEDGER_STATE.DEAD_ON_ARRIVAL
  return (
    <tr className={cn('border-b border-border/40 last:border-0', wasted && 'bg-red-500/5')}>
      <td className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-medium">{row.maskedKey}</span>
          <Badge variant="outline" className={cn('px-1.5 py-0 text-[10px]', STATE_TONE[row.state])}>
            {KSK_LEDGER_STATE_LABEL[row.state]}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {[
            KSK_HUNTER_CHANNEL_LABEL[row.channel],
            row.region || undefined,
            row.groupName,
            row.linkName,
            // 下线原因只在下线后才有意义，在用的号不显示
            row.retireReason ? KSK_LEDGER_RETIRE_REASON_LABEL[row.retireReason] : undefined
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </td>
      <td
        className="px-2 py-2 text-right tabular-nums"
        title={
          row.costUnit === undefined
            ? '下单时商品未提供价格'
            : `${row.costUnit} ${row.unitLabel ?? ''} · 买入 ${formatDate(row.purchasedAt)}`
        }
      >
        {row.costUnit === undefined ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="font-medium">
            {row.costUnit} <span className="text-xs text-muted-foreground">{row.unitLabel}</span>
          </span>
        )}
      </td>
      <td
        className="px-2 py-2 text-right tabular-nums"
        title={`买入 ${formatDate(row.purchasedAt)} · ${
          row.retiredAt
            ? `下线 ${formatDate(row.retiredAt)}`
            : `最后观测 ${formatDate(row.lastSeenAt)}`
        }`}
      >
        {formatLedgerDuration(row.aliveMs)}
      </td>
      <td
        className="px-2 py-2 text-right font-medium tabular-nums text-rose-600 dark:text-rose-400"
        title={
          row.baselineUsage === undefined
            ? '还没拿到额度基线，下一次账号刷新后开始计数'
            : `买入时额度 ${formatCredits(row.baselineUsage)} → 现在 ${formatCredits(row.currentUsage ?? row.baselineUsage)}`
        }
      >
        {formatCredits(row.usedCredits)}
      </td>
      <td
        className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground"
        title={
          row.usageLimit === undefined
            ? '还没拿到额度上限'
            : `已用 ${formatCredits(row.currentUsage ?? 0)} / ${formatCredits(row.usageLimit)}`
        }
      >
        {row.usagePercent === undefined ? '—' : formatPercent(row.usagePercent)}
      </td>
      <td className="px-2 py-2 text-right text-xs tabular-nums" title="花费 ÷ 消耗积分，越低越划算">
        {formatPerCredit(row.cnyPerCredit)}
      </td>
      <td
        className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground"
        title="存活期间的平均积分产出速率"
      >
        {row.creditsPerHour === undefined ? '—' : `${formatCredits(row.creditsPerHour)}/h`}
      </td>
    </tr>
  )
}

export function KskLedgerPage(): React.ReactNode {
  const [report, setReport] = useState<KskLedgerReport | null>(null)
  const [days, setDays] = useState<number>(KSK_LEDGER_DEFAULT_WINDOW_DAYS)
  const [sort, setSort] = useState<KskLedgerSort>(KSK_LEDGER_SORT.PURCHASED)
  const [loading, setLoading] = useState(true)
  const [onlyWasted, setOnlyWasted] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async (windowDays: number, sortKey: KskLedgerSort): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await window.api.kskHunterLedgerReport(windowDays, sortKey)
      if (!result.success) throw new Error(result.error || '读取抢号台账失败')
      setReport(result.data ?? null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(days, sort)
  }, [days, sort, load])

  const handleReveal = useCallback(async (): Promise<void> => {
    setNotice('')
    const result = await window.api.kskHunterRevealLedgerFile()
    if (!result.success) {
      setError(result.error || '打开台账文件失败')
      return
    }
    setNotice(`台账文件：${result.data}`)
  }, [])

  const handleClear = useCallback(async (): Promise<void> => {
    const confirmed = await askConfirm({
      title: '清空抢号台账',
      description:
        '台账记录了每个号花多少钱买的、活了多久、消耗多少积分，全靠本地按采样攒出来，反代不保存历史。清空后这些记录无法恢复，已在池的号会从下一轮采样重新建立基线（此前的产出归零）。',
      confirmText: '清空',
      tone: 'danger'
    })
    if (!confirmed) return
    const result = await window.api.kskHunterClearLedger()
    if (!result.success) {
      setError(result.error || '清空失败')
      return
    }
    setReport(result.data ?? null)
    setNotice('台账已清空')
  }, [])

  /** 只看白花钱的号：买到即废。排序已由主进程做好，这里只过滤。 */
  const rows = useMemo(() => {
    const list = report?.rows ?? []
    if (!onlyWasted) return list
    return list.filter((row) => row.state === KSK_LEDGER_STATE.DEAD_ON_ARRIVAL)
  }, [report, onlyWasted])

  const totals = report?.totals

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <PageHeader
        title="抢号台账"
        eyebrow="KSK Ledger"
        icon={BookOpenCheck}
        accent="violet"
        description="逐号记账：花多少钱买的、活了多长时间、下游拿它烧了多少积分。只收抢号自动买来的号，手动导入与自动同步进来的号没有采购价，不在这里。"
        badges={
          report && (
            <span className="text-xs text-muted-foreground">
              共 {formatCount(report.totalEntryCount)} 条
              {report.earliestPurchasedAt
                ? ` · 最早 ${new Date(report.earliestPurchasedAt).toLocaleDateString()}`
                : ''}
            </span>
          )
        }
        actions={
          <>
            {KSK_LEDGER_WINDOW_OPTIONS.map((option) => (
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(days, sort)}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              刷新
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleReveal()}
              title="台账全量保留在这个文件里（不含 KSK 明文）"
            >
              <FolderOpen className="h-4 w-4" />
              台账文件
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
          <p className="break-all rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 font-mono text-xs text-sky-600 dark:text-sky-300">
            {notice}
          </p>
        )}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="窗口花费"
            value={formatCny(totals?.spendCny ?? 0)}
            hint={`${formatCount(totals?.entries ?? 0)} 个号 · 单价均 ${formatCny(totals?.avgCostCny)}`}
            icon={Wallet}
            accent={ACCENT.spend}
          />
          <KpiCard
            label="下游烧掉的积分"
            value={formatCredits(totals?.usedCredits ?? 0)}
            hint="按「当前额度 − 买入时额度」算"
            icon={Coins}
            accent={ACCENT.credits}
          />
          <KpiCard
            label="每分单价"
            value={formatPerCredit(totals?.cnyPerCredit)}
            hint={totals?.cnyPerCredit === undefined ? '还没有消耗数据' : '花费 ÷ 积分，越低越划算'}
            icon={TrendingDown}
            accent={ACCENT.efficiency}
          />
          <KpiCard
            label="平均服役"
            value={totals?.avgAliveMs === undefined ? '—' : formatLedgerDuration(totals.avgAliveMs)}
            hint={`在用 ${formatCount(totals?.alive ?? 0)} · 已下线 ${formatCount(totals?.retired ?? 0)} · 买到即废 ${formatCount(totals?.wasted ?? 0)}`}
            valueTitle="全部号从买入到现在（或到下线）的平均时长；在用的号会随时间增长"
            icon={Clock}
            accent={ACCENT.alive}
          />
        </section>

        {/* 按分组汇总：不同分组通常对应不同下游，用它对比哪一路更划算 */}
        {(report?.byGroup.length ?? 0) > 1 && (
          <Card>
            <CardContent className="space-y-3 p-4">
              <div>
                <h2 className="text-sm font-medium">按分组</h2>
                <p className="text-xs text-muted-foreground">
                  抢号时指定的目标分组。不同分组通常给不同下游，比一比哪一路的号更划算。
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-xs text-muted-foreground">
                      <th className="px-2 py-2 text-left font-medium">分组</th>
                      <th className="px-2 py-2 text-right font-medium">号数</th>
                      <th className="px-2 py-2 text-right font-medium">花费</th>
                      <th className="px-2 py-2 text-right font-medium">下游消耗</th>
                      <th className="px-2 py-2 text-right font-medium">每分单价</th>
                      <th className="px-2 py-2 text-right font-medium">平均寿命</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report?.byGroup.map((group) => (
                      <tr
                        key={group.groupId ?? 'ungrouped'}
                        className="border-b border-border/40 last:border-0"
                      >
                        <td className="px-2 py-2 font-medium">{group.groupName}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatCount(group.entries)}
                          <span className="ml-1 text-xs text-muted-foreground">
                            (在用 {formatCount(group.alive)})
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatCny(group.spendCny)}
                        </td>
                        <td className="px-2 py-2 text-right font-medium tabular-nums text-rose-600 dark:text-rose-400">
                          {formatCredits(group.usedCredits)}
                        </td>
                        <td className="px-2 py-2 text-right text-xs tabular-nums">
                          {formatPerCredit(group.cnyPerCredit)}
                        </td>
                        <td className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground">
                          {group.avgAliveMs === undefined
                            ? '—'
                            : formatLedgerDuration(group.avgAliveMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-medium">逐号明细</h2>
                <p className="max-w-[52rem] text-xs text-muted-foreground">
                  存活时长从买入算到号被删除或判死（在用的号算到现在）。「下游消耗」= 当前额度 −
                  买入时额度，号是独占给下游的，所以它的全部消耗就是下游的消耗；二手号买来时已经
                  烧掉的那部分记进基线，不会算到你账上。额度随账号刷新更新（账号页默认 5
                  分钟一轮），跨月重置会自动结转。台账不含 KSK 明文。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant={onlyWasted ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setOnlyWasted(!onlyWasted)}
                  title="只看买到即废的号（钱花了但验活没过）"
                >
                  只看白买
                </Button>
                {SORT_OPTIONS.map((option) => (
                  <Button
                    key={option.key}
                    variant={sort === option.key ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setSort(option.key)}
                  >
                    {option.label}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleClear()}
                  disabled={(report?.totalEntryCount ?? 0) === 0}
                >
                  <Trash2 className="h-4 w-4" />
                  清空台账
                </Button>
              </div>
            </div>

            {loading && !report ? (
              <div className="grid h-24 place-items-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : rows.length === 0 ? (
              <div className="grid h-24 place-items-center rounded-xl border border-dashed border-border/60 text-sm text-muted-foreground">
                {onlyWasted
                  ? '这段时间买的号都进池了'
                  : (report?.totalEntryCount ?? 0) === 0
                    ? '还没有抢到过号。抢号器下单成功后这里就会有记录。'
                    : '所选窗口内没有采购记录，试试放宽到更长的时间跨度'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-xs text-muted-foreground">
                      <th className="px-2 py-2 text-left font-medium">号 / 来源</th>
                      <th className="px-2 py-2 text-right font-medium">买入价</th>
                      <th className="px-2 py-2 text-right font-medium">存活时长</th>
                      <th className="px-2 py-2 text-right font-medium">下游消耗</th>
                      <th className="px-2 py-2 text-right font-medium">额度水位</th>
                      <th className="px-2 py-2 text-right font-medium">每分单价</th>
                      <th className="px-2 py-2 text-right font-medium">消耗速率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <LedgerRow key={row.accountId} row={row} />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border/60 text-xs">
                      <td className="px-2 py-2 font-medium">
                        合计 {formatCount(rows.length)} 个号
                      </td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">
                        {formatCny(totals?.spendCny ?? 0)}
                      </td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">
                        {totals?.avgAliveMs === undefined
                          ? '—'
                          : `均 ${formatLedgerDuration(totals.avgAliveMs)}`}
                      </td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">
                        {formatCredits(totals?.usedCredits ?? 0)}
                      </td>
                      <td className="px-2 py-2" />
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">
                        {formatPerCredit(totals?.cnyPerCredit)}
                      </td>
                      <td className="px-2 py-2" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
