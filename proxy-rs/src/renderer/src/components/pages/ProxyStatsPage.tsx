import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Ban,
  ChartLine,
  CheckCircle2,
  Gauge,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert,
  XCircle
} from 'lucide-react'
import {
  LOCAL_ADMIN_ALERT,
  LOCAL_ADMIN_STATS_POLL_INTERVAL_SECONDS,
  LOCAL_ADMIN_STATS_STATE,
  type LocalAdminAlert,
  type LocalAdminCredentialStats,
  type LocalAdminStatsSnapshot
} from '../../../../shared/localAdminStats'
import { Badge, Button, Card, CardContent, PageHeader, askConfirm } from '../ui'
import { TrendChart, type TrendSeries } from '../stats/TrendChart'
import { cn } from '@/lib/utils'

/** 表格排序维度。 */
const SORT_KEY = {
  ID: 'id',
  SUCCESS: 'success',
  FAILURE: 'failure',
  LAST_USED: 'lastUsed',
  USAGE: 'usage'
} as const

type SortKey = (typeof SORT_KEY)[keyof typeof SORT_KEY]

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: SORT_KEY.ID, label: '编号' },
  { key: SORT_KEY.SUCCESS, label: '成功次数' },
  { key: SORT_KEY.FAILURE, label: '失败次数' },
  { key: SORT_KEY.LAST_USED, label: '最后调用' },
  { key: SORT_KEY.USAGE, label: '剩余用量' }
]

const ALERT_LABEL: Record<LocalAdminAlert, { text: string; tone: string }> = {
  [LOCAL_ADMIN_ALERT.DISABLED]: {
    text: '已禁用',
    tone: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300'
  },
  [LOCAL_ADMIN_ALERT.FAILING]: {
    text: '有调用失败',
    tone: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
  },
  [LOCAL_ADMIN_ALERT.REFRESH_FAILING]: {
    text: '刷新失败',
    tone: 'border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-300'
  },
  [LOCAL_ADMIN_ALERT.QUOTA_HIGH]: {
    text: '额度告急',
    tone: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300'
  },
  [LOCAL_ADMIN_ALERT.QUOTA_EXHAUSTED]: {
    text: '额度耗尽',
    tone: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
  }
}

const STATE_LABEL: Record<string, { text: string; tone: string }> = {
  [LOCAL_ADMIN_STATS_STATE.UNCONFIGURED]: {
    text: '未配置',
    tone: 'border-border bg-muted/40 text-muted-foreground'
  },
  [LOCAL_ADMIN_STATS_STATE.IDLE]: {
    text: '等待采样',
    tone: 'border-border bg-muted/40 text-muted-foreground'
  },
  [LOCAL_ADMIN_STATS_STATE.RUNNING]: {
    text: '采集中',
    tone: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300'
  },
  [LOCAL_ADMIN_STATS_STATE.HEALTHY]: {
    text: '采集正常',
    tone: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
  },
  [LOCAL_ADMIN_STATS_STATE.FAILED]: {
    text: '采集失败',
    tone: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
  }
}

/** 趋势线配色，与 KPI 徽标语义一致（成功=绿、失败=红、刷新失败=橙、用量=蓝）。 */
const SERIES_COLOR = {
  success: '#22c55e',
  failure: '#ef4444',
  refreshFailure: '#f97316',
  usage: '#3b82f6'
} as const

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function formatUsage(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatPercent(value?: number): string {
  return value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : '—'
}

/** 相对时间：表格里比绝对时间好扫，精确值放 title。 */
function formatRelative(value?: number): string {
  if (!value) return '—'
  const diff = Date.now() - value
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function compareCredentials(
  a: LocalAdminCredentialStats,
  b: LocalAdminCredentialStats,
  key: SortKey
): number {
  switch (key) {
    case SORT_KEY.SUCCESS:
      return b.successCount - a.successCount
    case SORT_KEY.FAILURE:
      return (
        b.failureCount + b.refreshFailureCount - (a.failureCount + a.refreshFailureCount) ||
        b.successCount - a.successCount
      )
    case SORT_KEY.LAST_USED:
      return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
    case SORT_KEY.USAGE:
      // 没查过用量的排到最后，避免它们顶在「剩余最少」前面
      return (
        (a.usage?.remaining ?? Number.POSITIVE_INFINITY) -
        (b.usage?.remaining ?? Number.POSITIVE_INFINITY)
      )
    default:
      return Number(a.id) - Number(b.id) || a.id.localeCompare(b.id)
  }
}

interface KpiCardProps {
  label: string
  value: string
  hint?: string
  icon: React.ElementType
  accent: string
  tone?: 'default' | 'warn' | 'danger'
}

function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  accent,
  tone = 'default'
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
          <p
            className={cn(
              'text-xl font-semibold tabular-nums',
              tone === 'danger' && 'text-red-500',
              tone === 'warn' && 'text-amber-500'
            )}
          >
            {value}
          </p>
          {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

export function ProxyStatsPage(): React.ReactNode {
  const [snapshot, setSnapshot] = useState<LocalAdminStatsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshingUsage, setRefreshingUsage] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(SORT_KEY.ID)
  const [onlyAlerts, setOnlyAlerts] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async (): Promise<void> => {
    const result = await window.api.localAdminStatsSnapshot()
    if (!result.success) {
      setError(result.error || '读取反代统计失败')
      return
    }
    setSnapshot(result.data)
  }, [])

  useEffect(() => {
    void load().finally(() => setLoading(false))
  }, [load])

  // 主进程每轮采样后推快照，页面不用自己轮询
  useEffect(() => {
    return window.api.onLocalAdminStatsChanged((next) => setSnapshot(next))
  }, [])

  const handleRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    setError('')
    setNotice('')
    try {
      const result = await window.api.localAdminStatsRefreshNow()
      if (!result.success) setError(result.error || '刷新失败')
      else setSnapshot(result.data)
    } finally {
      setRefreshing(false)
    }
  }, [])

  const handleRefreshUsage = useCallback(async (): Promise<void> => {
    setRefreshingUsage(true)
    setError('')
    setNotice('')
    try {
      const result = await window.api.localAdminStatsRefreshUsage()
      if (!result.success) {
        setError(result.error || '刷新用量失败')
        return
      }
      const { refreshed, failed, errors } = result.data
      setNotice(
        failed > 0
          ? `已刷新 ${refreshed} 条用量，${failed} 条失败：${errors.slice(0, 3).join('；')}`
          : `已刷新 ${refreshed} 条用量`
      )
      await load()
    } finally {
      setRefreshingUsage(false)
    }
  }, [load])

  const handleClearSamples = useCallback(async (): Promise<void> => {
    const confirmed = await askConfirm({
      title: '清空趋势数据',
      description:
        '本机 Admin 不保存历史，趋势曲线全靠本地采样攒出来。清空后这段历史无法恢复，新的采样会从现在重新开始。',
      confirmText: '清空',
      tone: 'danger'
    })
    if (!confirmed) return
    const result = await window.api.localAdminStatsClearSamples()
    if (!result.success) {
      setError(result.error || '清空失败')
      return
    }
    setSnapshot(result.data)
    setNotice('趋势数据已清空')
  }, [])

  const credentials = useMemo(() => {
    const list = snapshot?.credentials ?? []
    const filtered = onlyAlerts ? list.filter((item) => item.alerts.length > 0) : list
    return [...filtered].sort((a, b) => compareCredentials(a, b, sortKey))
  }, [snapshot, sortKey, onlyAlerts])

  const trend = useMemo(() => {
    const samples = snapshot?.samples ?? []
    const timestamps = samples.map((item) => item.at)
    const counterSeries: TrendSeries[] = [
      {
        key: 'success',
        label: '累计成功',
        color: SERIES_COLOR.success,
        values: samples.map((item) => item.successCount)
      },
      {
        key: 'failure',
        label: '累计失败',
        color: SERIES_COLOR.failure,
        values: samples.map((item) => item.failureCount)
      },
      {
        key: 'refreshFailure',
        label: '刷新失败',
        color: SERIES_COLOR.refreshFailure,
        values: samples.map((item) => item.refreshFailureCount)
      }
    ]
    const usageSeries: TrendSeries[] = [
      {
        key: 'usageCurrent',
        label: '已用额度',
        color: SERIES_COLOR.usage,
        values: samples.map((item) => item.usageCurrent),
        area: true
      }
    ]
    return { timestamps, counterSeries, usageSeries }
  }, [snapshot])

  const status = snapshot?.status
  const totals = snapshot?.totals
  const stateBadge = STATE_LABEL[status?.state ?? LOCAL_ADMIN_STATS_STATE.IDLE]
  const unconfigured = status?.state === LOCAL_ADMIN_STATS_STATE.UNCONFIGURED

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <PageHeader
        title="反代统计"
        eyebrow="Local Admin"
        icon={ChartLine}
        accent="cyan"
        description={
          unconfigured
            ? '尚未配置本机 Admin。请到任务管理开启「同步到本机 Admin」并填写 Admin API Key。'
            : `每 ${LOCAL_ADMIN_STATS_POLL_INTERVAL_SECONDS} 秒采集一次成功与失败计数；用量需手动刷新（会请求上游）。`
        }
        badges={
          <>
            <Badge variant="outline" className={stateBadge.tone}>
              {stateBadge.text}
            </Badge>
            {status?.baseUrl && (
              <span className="font-mono text-xs text-muted-foreground">{status.baseUrl}</span>
            )}
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRefresh()}
              disabled={refreshing || loading}
            >
              {refreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              刷新计数
            </Button>
            <Button
              size="sm"
              onClick={() => void handleRefreshUsage()}
              disabled={refreshingUsage || unconfigured}
              title="逐条查询余额，会请求上游 AWS"
            >
              {refreshingUsage ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Gauge className="h-4 w-4" />
              )}
              刷新用量
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
          <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-600 dark:text-sky-300">
            {notice}
          </div>
        )}
        {status?.state === LOCAL_ADMIN_STATS_STATE.FAILED && status.lastError && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-300">
            最近一次采集失败：{status.lastError}
          </div>
        )}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label="成功次数"
            value={formatNumber(totals?.successCount ?? 0)}
            hint={`成功率 ${formatPercent(totals?.successRate)}`}
            icon={CheckCircle2}
            accent={SERIES_COLOR.success}
          />
          <KpiCard
            label="失败次数"
            value={formatNumber(totals?.failureCount ?? 0)}
            hint={`刷新失败 ${formatNumber(totals?.refreshFailureCount ?? 0)}`}
            icon={XCircle}
            accent={SERIES_COLOR.failure}
            tone={(totals?.failureCount ?? 0) > 0 ? 'danger' : 'default'}
          />
          <KpiCard
            label="凭据"
            value={`${formatNumber(totals?.available ?? 0)} / ${formatNumber(totals?.credentials ?? 0)}`}
            hint={`禁用 ${formatNumber(totals?.disabled ?? 0)} · 告警 ${formatNumber(totals?.alertCount ?? 0)}`}
            icon={Activity}
            accent="#a855f7"
            tone={(totals?.alertCount ?? 0) > 0 ? 'warn' : 'default'}
          />
          <KpiCard
            label="剩余用量"
            value={
              totals && totals.usageSampleCount > 0
                ? `${formatUsage(totals.usageRemaining)} / ${formatUsage(totals.usageLimit)}`
                : '未查询'
            }
            hint={
              totals && totals.usageSampleCount > 0
                ? `已用 ${formatPercent(totals.usagePercentUsed)} · ${totals.usageSampleCount} 条已查`
                : '点右上「刷新用量」获取'
            }
            icon={Gauge}
            accent={SERIES_COLOR.usage}
          />
        </section>

        <Card>
          <CardContent className="space-y-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-medium">调用趋势</h2>
                <p className="text-xs text-muted-foreground">
                  累计计数曲线。Admin 重启后失败计数会归零，曲线出现回落属正常。
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleClearSamples()}
                disabled={(snapshot?.samples.length ?? 0) === 0}
              >
                <Trash2 className="h-4 w-4" />
                清空趋势
              </Button>
            </div>
            <TrendChart
              timestamps={trend.timestamps}
              series={trend.counterSeries}
              formatValue={formatNumber}
              emptyHint={unconfigured ? '配置本机 Admin 后开始采样' : '正在采集第一批样本'}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 p-4">
            <div>
              <h2 className="text-sm font-medium">用量趋势</h2>
              <p className="text-xs text-muted-foreground">
                只在手动刷新用量后才有采样点，两次刷新之间是断线。
              </p>
            </div>
            <TrendChart
              timestamps={trend.timestamps}
              series={trend.usageSeries}
              formatValue={formatUsage}
              emptyHint="还没查过用量"
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-medium">凭据明细</h2>
                <p className="text-xs text-muted-foreground">
                  共 {credentials.length} 条
                  {status?.lastUsageRefreshAt
                    ? ` · 用量更新于 ${formatTime(status.lastUsageRefreshAt)}`
                    : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant={onlyAlerts ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setOnlyAlerts(!onlyAlerts)}
                >
                  <TriangleAlert className="h-4 w-4" />
                  只看异常
                </Button>
                {SORT_OPTIONS.map((option) => (
                  <Button
                    key={option.key}
                    variant={sortKey === option.key ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setSortKey(option.key)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="grid h-24 place-items-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : credentials.length === 0 ? (
              <div className="grid h-24 place-items-center rounded-xl border border-dashed border-border/60 text-sm text-muted-foreground">
                {onlyAlerts ? '没有命中告警的凭据' : unconfigured ? '未配置本机 Admin' : '暂无凭据'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-xs text-muted-foreground">
                      <th className="px-2 py-2 text-left font-medium">凭据</th>
                      <th className="px-2 py-2 text-right font-medium">成功</th>
                      <th className="px-2 py-2 text-right font-medium">失败</th>
                      <th className="px-2 py-2 text-right font-medium">刷新失败</th>
                      <th className="px-2 py-2 text-right font-medium">剩余用量</th>
                      <th className="px-2 py-2 text-left font-medium">最后调用</th>
                      <th className="px-2 py-2 text-left font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {credentials.map((credential) => (
                      <tr
                        key={credential.id}
                        className={cn(
                          'border-b border-border/40 last:border-0',
                          credential.alerts.length > 0 && 'bg-amber-500/5',
                          credential.disabled && 'opacity-60'
                        )}
                      >
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">#{credential.id}</span>
                            {credential.isCurrent && (
                              <Badge variant="success" className="px-1.5 py-0 text-[10px]">
                                当前
                              </Badge>
                            )}
                            {credential.maskedKey && (
                              <span className="font-mono text-xs text-muted-foreground">
                                {credential.maskedKey}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {[
                              credential.authMethod,
                              credential.endpoint,
                              credential.subscriptionTitle
                            ]
                              .filter(Boolean)
                              .join(' · ') || '—'}
                          </p>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatNumber(credential.successCount)}
                        </td>
                        <td
                          className={cn(
                            'px-2 py-2 text-right tabular-nums',
                            credential.failureCount > 0 && 'font-medium text-red-500'
                          )}
                        >
                          {formatNumber(credential.failureCount)}
                        </td>
                        <td
                          className={cn(
                            'px-2 py-2 text-right tabular-nums',
                            credential.refreshFailureCount > 0 && 'font-medium text-orange-500'
                          )}
                        >
                          {formatNumber(credential.refreshFailureCount)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {credential.usage ? (
                            <span
                              className={cn(
                                credential.usage.remaining <= 0 && 'font-medium text-red-500'
                              )}
                              title={`已用 ${formatUsage(credential.usage.current)} / ${formatUsage(credential.usage.limit)}`}
                            >
                              {formatUsage(credential.usage.remaining)}
                              <span className="ml-1 text-xs text-muted-foreground">
                                ({formatPercent(1 - credential.usage.percentUsed)})
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td
                          className="px-2 py-2 text-xs text-muted-foreground"
                          title={formatTime(credential.lastUsedAt)}
                        >
                          {formatRelative(credential.lastUsedAt)}
                        </td>
                        <td className="px-2 py-2">
                          {credential.alerts.length === 0 ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-300">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              正常
                            </span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {credential.alerts.map((alert) => (
                                <Badge
                                  key={alert}
                                  variant="outline"
                                  className={cn('px-1.5 py-0 text-[10px]', ALERT_LABEL[alert].tone)}
                                >
                                  {alert === LOCAL_ADMIN_ALERT.DISABLED ? (
                                    <Ban className="mr-0.5 h-3 w-3" />
                                  ) : (
                                    <AlertTriangle className="mr-0.5 h-3 w-3" />
                                  )}
                                  {ALERT_LABEL[alert].text}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
