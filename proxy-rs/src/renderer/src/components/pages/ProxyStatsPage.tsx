import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Ban,
  ChartLine,
  CheckCircle2,
  Coins,
  Gauge,
  Loader2,
  RefreshCw,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import {
  LOCAL_ADMIN_ALERT,
  LOCAL_ADMIN_REPORT_ALL_HOURS,
  LOCAL_ADMIN_STATS_POLL_INTERVAL_SECONDS,
  LOCAL_ADMIN_STATS_STATE,
  LOCAL_ADMIN_USAGE_BUCKET_RETENTION_HOURS,
  buildLocalAdminReport,
  selectExhaustedLocalAdminCredentials,
  toLocalDateKey,
  type LocalAdminAlert,
  type LocalAdminCredentialStats,
  type LocalAdminReportHour,
  type LocalAdminStatsSnapshot
} from '../../../../shared/localAdminStats'
import { Badge, Button, Card, CardContent, Input, PageHeader, Select, askConfirm } from '../ui'
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

/** 小时下拉的选项：全天 + 00:00~23:00。 */
const HOUR_OPTIONS = [
  { value: LOCAL_ADMIN_REPORT_ALL_HOURS, label: '全天' },
  ...Array.from({ length: 24 }, (_, hour) => ({
    value: String(hour),
    label: `${`${hour}`.padStart(2, '0')}:00 — ${`${hour}`.padStart(2, '0')}:59`
  }))
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

/**
 * token 数按 K / M 压缩显示。
 *
 * token 动辄六七位数，`320,906` 这种写法要数位数才知道量级，纵向扫一列更难比大小。
 * 压成 `320.9K` / `2.46M` 后量级一眼可辨；精确值仍放 title，需要对账时能拿到。
 *
 * 阈值取 10_000：五位以内（如 `4,125`）本来就好读，压成 `4.1K` 反而丢精度。
 */
function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}K`
  return formatNumber(value)
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
  /** 主数值的悬浮提示；数值被压缩显示（如 320.9K）时用来给出精确值。 */
  valueTitle?: string
}

function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  accent,
  tone = 'default',
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
          <p
            className={cn(
              'text-xl font-semibold tabular-nums',
              tone === 'danger' && 'text-red-500',
              tone === 'warn' && 'text-amber-500'
            )}
            title={valueTitle}
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
  const [cleaningUp, setCleaningUp] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>(SORT_KEY.ID)
  const [onlyAlerts, setOnlyAlerts] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // 报表窗口：默认看今天全天
  const [reportDate, setReportDate] = useState(() => toLocalDateKey(Date.now()))
  const [reportHour, setReportHour] = useState<string>(LOCAL_ADMIN_REPORT_ALL_HOURS)

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

  const handleCleanupExhausted = useCallback(async (): Promise<void> => {
    const confirmed = await askConfirm({
      title: '清理额度耗尽的凭据',
      description:
        '会先刷新一遍用量，然后把额度已耗尽的凭据从反代删掉，并连带删除本地账号库里的对应账号（不这样做的话，下一次同步会把它推回反代）。删除不可撤销。',
      confirmText: '清理',
      tone: 'danger'
    })
    if (!confirmed) return
    setCleaningUp(true)
    setError('')
    setNotice('')
    try {
      const result = await window.api.localAdminStatsCleanupExhausted()
      if (!result.success) {
        setError(result.error || '清理失败')
        return
      }
      const { exhausted, removed, removedLocalAccounts, removedMaskedKeys, errors } = result.data
      if (exhausted === 0) setNotice('没有额度耗尽的凭据')
      else {
        setNotice(
          `已删除 ${removed} 个额度耗尽的凭据（本地账号 ${removedLocalAccounts} 个）：` +
            removedMaskedKeys.join('、')
        )
      }
      if (errors.length > 0) setError(errors.slice(0, 3).join('；'))
      await load()
    } finally {
      setCleaningUp(false)
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

  /** 跳到当前小时：跨天时日期也要一起更新，否则会停在昨天的同一小时。 */
  const selectNow = useCallback((): void => {
    const now = Date.now()
    setReportDate(toLocalDateKey(now))
    setReportHour(String(new Date(now).getHours()))
  }, [])

  const handleClearBuckets = useCallback(async (): Promise<void> => {
    const confirmed = await askConfirm({
      title: '清空消耗报表',
      description:
        '按小时的消耗记录全靠本地差分攒出来，Admin 不保存历史。清空后这 7 天的报表无法恢复，下一轮采样会重新建立基线。',
      confirmText: '清空',
      tone: 'danger'
    })
    if (!confirmed) return
    const result = await window.api.localAdminStatsClearBuckets()
    if (!result.success) {
      setError(result.error || '清空失败')
      return
    }
    setSnapshot(result.data)
    setNotice('消耗报表已清空')
  }, [])

  const credentials = useMemo(() => {
    const list = snapshot?.credentials ?? []
    const filtered = onlyAlerts ? list.filter((item) => item.alerts.length > 0) : list
    return [...filtered].sort((a, b) => compareCredentials(a, b, sortKey))
  }, [snapshot, sortKey, onlyAlerts])

  const hour: LocalAdminReportHour =
    reportHour === LOCAL_ADMIN_REPORT_ALL_HOURS ? LOCAL_ADMIN_REPORT_ALL_HOURS : Number(reportHour)

  /** 报表按窗口现算：桶数据量小（7 天 × 24 小时 × 凭据数），不值得再缓存一层。 */
  const report = useMemo(
    () =>
      buildLocalAdminReport({
        buckets: snapshot?.buckets ?? [],
        range: { date: reportDate, hour },
        now: Date.now(),
        present: snapshot?.credentials ?? []
      }),
    [snapshot, reportDate, hour]
  )

  /** 窗口内「我的」token 合计（输入 + 输出） */
  const reportTokens = report.inputTokenDelta + report.outputTokenDelta

  /**
   * 本机 Admin 是否支持 token 统计。
   *
   * 判定看凭据上有没有该字段，而不是看 token 是否大于 0：新装或刚重启的 kiro-rs
   * 计数确实是 0，那时候提示「需升级」会误导人。
   */
  const tokenSupported = useMemo(
    () => (snapshot?.credentials ?? []).some((item) => item.inputTokens !== undefined),
    [snapshot]
  )

  /** KPI 与表头共用的窗口标签，避免「本小时/今天」两处写法不一致。 */
  const rangeLabel =
    reportHour === LOCAL_ADMIN_REPORT_ALL_HOURS
      ? reportDate === toLocalDateKey(Date.now())
        ? '今天'
        : reportDate
      : `${`${hour}`.padStart(2, '0')}:00`

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
    return { timestamps, counterSeries }
  }, [snapshot])

  const status = snapshot?.status
  const totals = snapshot?.totals
  const stateBadge = STATE_LABEL[status?.state ?? LOCAL_ADMIN_STATS_STATE.IDLE]
  const unconfigured = status?.state === LOCAL_ADMIN_STATS_STATE.UNCONFIGURED
  // 与主进程清理同一口径，按钮上直接给出待清理条数
  const exhaustedCount = selectExhaustedLocalAdminCredentials(snapshot?.credentials ?? []).length

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
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleCleanupExhausted()}
              disabled={cleaningUp || unconfigured}
              title="删掉额度已耗尽的凭据，并连带清理本地账号库里的对应账号"
            >
              {cleaningUp ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              清理不可用
              {exhaustedCount > 0 ? ` (${exhaustedCount})` : ''}
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

        {/* 报表窗口过滤器：放在最上方，KPI 的「本窗口」数与下方报表都跟着它走 */}
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="proxy-stats-report-date">
                日期
              </label>
              <Input
                id="proxy-stats-report-date"
                type="date"
                className="h-9 w-[9.5rem]"
                value={reportDate}
                max={toLocalDateKey(Date.now())}
                min={toLocalDateKey(
                  Date.now() - (LOCAL_ADMIN_USAGE_BUCKET_RETENTION_HOURS - 1) * 3_600_000
                )}
                onChange={(event) => setReportDate(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <span className="block text-xs text-muted-foreground">小时</span>
              <Select
                className="w-[11.5rem]"
                value={reportHour}
                options={HOUR_OPTIONS}
                onChange={setReportHour}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => selectNow()}>
                本小时
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReportDate(toLocalDateKey(Date.now()))
                  setReportHour(LOCAL_ADMIN_REPORT_ALL_HOURS)
                }}
              >
                今天
              </Button>
            </div>
            <p className="ml-auto max-w-[22rem] text-xs text-muted-foreground">
              {report.hoursWithData === 0
                ? '该时段没有采样。消耗量按相邻两次采样的差值算，需要应用保持运行。'
                : `该时段共 ${report.hoursWithData} 个小时有采样 · 保留最近 7 天`}
            </p>
          </CardContent>
        </Card>

        {/*
          KPI 统一用窗口口径（跟上方过滤器走），只有「凭据」和「剩余用量」是当下水位。
          累计计数不再上卡片：Admin 重启就归零，跟窗口口径混排还容易看串。
        */}
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            label={`${rangeLabel} 我的 token`}
            value={tokenSupported ? formatTokens(reportTokens) : '不支持'}
            hint={
              tokenSupported
                ? `输入 ${formatTokens(report.inputTokenDelta)} · 输出 ${formatTokens(report.outputTokenDelta)}`
                : '需升级 kiro-rs 才有此数据'
            }
            // 压缩显示后精确值只能从 title 拿，对账时需要
            valueTitle={tokenSupported ? `${formatNumber(reportTokens)} tokens` : undefined}
            icon={Coins}
            accent="#f59e0b"
          />
          <KpiCard
            label={`${rangeLabel} 成功`}
            value={formatNumber(report.successDelta)}
            hint={`${report.rows.length} 个账号有记录 · 失败 ${formatNumber(report.failureDelta)}`}
            icon={CheckCircle2}
            accent={SERIES_COLOR.success}
            tone={report.failureDelta > 0 ? 'warn' : 'default'}
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
                ? `已用 ${formatUsage(totals.usageCurrent)}（${formatPercent(totals.usagePercentUsed)}）· ${totals.usageSampleCount} 条已查`
                : '点右上「刷新用量」获取'
            }
            icon={Gauge}
            accent={SERIES_COLOR.usage}
          />
        </section>

        {/* 逐账号消耗报表：含已从 Admin 删除的凭据，否则换号后这段消耗就查无对证 */}
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-medium">账号消耗明细 · {rangeLabel}</h2>
                <p className="text-xs text-muted-foreground">
                  「我的 token」只统计走本机反代的请求；「账号额度」是该号的总消耗，
                  号被原主或别的反代共用时会比前者涨得快，两者差距大的号很可能在被别处使用。
                  不再单列「我的积分」：上游既不下发可用的逐次扣减量（meteringEvent
                  的值与实际扣减差约 26 倍），账号额度差分也分不清哪部分是自己烧的，
                  两种口径实测都偏离一个量级以上。 按相邻两次采样的差值累加，每{' '}
                  {LOCAL_ADMIN_STATS_POLL_INTERVAL_SECONDS} 秒一轮， 计数归零时该轮增量按 0
                  计，不会出现负值。 Admin 的 #id 会被复用，换号后按脱敏 Key
                  分行，旧号的消耗不会算到新号头上。
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleClearBuckets()}
                disabled={(snapshot?.buckets.length ?? 0) === 0}
              >
                <Trash2 className="h-4 w-4" />
                清空报表
              </Button>
            </div>

            {report.rows.length === 0 ? (
              <div className="grid h-24 place-items-center rounded-xl border border-dashed border-border/60 text-sm text-muted-foreground">
                {unconfigured ? '未配置本机 Admin' : '该时段暂无消耗记录'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-xs text-muted-foreground">
                      <th className="px-2 py-2 text-left font-medium">账号</th>
                      <th className="px-2 py-2 text-right font-medium">我的 token</th>
                      <th className="px-2 py-2 text-right font-medium">账号额度</th>
                      <th className="px-2 py-2 text-right font-medium">成功</th>
                      <th className="px-2 py-2 text-right font-medium">失败</th>
                      <th className="px-2 py-2 text-right font-medium">当前水位</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* id 会被复用，同一个 id 可能有多行（换号），key 要带上 maskedKey */}
                    {report.rows.map((row) => (
                      <tr
                        key={`${row.id} ${row.maskedKey ?? ''}`}
                        className="border-b border-border/40 last:border-0"
                      >
                        <td className="px-2 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {/*
                              邮箱在前、#id 在后：邮箱是用户认得出的标识，而 #id 是与
                              Admin 卡片对账用的编号，两个都得露出来。老凭据（推送时没带
                              email）只有 #id。
                            */}
                            <span className="font-medium">{row.email || `#${row.id}`}</span>
                            {row.email && (
                              <span className="text-xs text-muted-foreground">#{row.id}</span>
                            )}
                            {row.maskedKey && (
                              <span className="font-mono text-xs text-muted-foreground">
                                {row.maskedKey}
                              </span>
                            )}
                            {!row.present && (
                              <Badge
                                variant="outline"
                                className="px-1.5 py-0 text-[10px] text-muted-foreground"
                              >
                                已移除
                              </Badge>
                            )}
                          </div>
                        </td>
                        {/* 占比与输入/输出拆分不单独占列，压进 title：需要时悬浮即可 */}
                        <td
                          className="px-2 py-2 text-right font-medium tabular-nums text-amber-600 dark:text-amber-400"
                          title={
                            `${formatNumber(row.inputTokenDelta + row.outputTokenDelta)} tokens` +
                            ` · 输入 ${formatNumber(row.inputTokenDelta)} · 输出 ${formatNumber(row.outputTokenDelta)}` +
                            (reportTokens > 0
                              ? ` · 占比 ${formatPercent(
                                  (row.inputTokenDelta + row.outputTokenDelta) / reportTokens
                                )}`
                              : '')
                          }
                        >
                          {formatTokens(row.inputTokenDelta + row.outputTokenDelta)}
                        </td>
                        <td
                          className="px-2 py-2 text-right tabular-nums text-muted-foreground"
                          title="账号总额度消耗，含别处共用该号的量"
                        >
                          {formatUsage(row.usageDelta)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatNumber(row.successDelta)}
                        </td>
                        <td
                          className={cn(
                            'px-2 py-2 text-right tabular-nums',
                            row.failureDelta > 0 && 'font-medium text-red-500'
                          )}
                        >
                          {formatNumber(row.failureDelta)}
                        </td>
                        <td className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground">
                          {row.usageCurrent !== undefined
                            ? `${formatUsage(row.usageCurrent)}${row.usageLimit ? ` / ${formatUsage(row.usageLimit)}` : ''}`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border/60 text-xs">
                      <td className="px-2 py-2 font-medium">合计</td>
                      <td
                        className="px-2 py-2 text-right font-semibold tabular-nums"
                        title={`${formatNumber(reportTokens)} tokens · 输入 ${formatNumber(report.inputTokenDelta)} · 输出 ${formatNumber(report.outputTokenDelta)}`}
                      >
                        {formatTokens(reportTokens)}
                      </td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">
                        {formatUsage(report.usageDelta)}
                      </td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">
                        {formatNumber(report.successDelta)}
                      </td>
                      <td className="px-2 py-2 text-right font-semibold tabular-nums">
                        {formatNumber(report.failureDelta)}
                      </td>
                      <td className="px-2 py-2" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

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
                <table className="w-full min-w-[840px] text-sm">
                  <thead>
                    <tr className="border-b border-border/60 text-xs text-muted-foreground">
                      <th className="px-2 py-2 text-left font-medium">凭据</th>
                      <th className="px-2 py-2 text-right font-medium">累计 token</th>
                      <th className="px-2 py-2 text-right font-medium">成功</th>
                      <th className="px-2 py-2 text-right font-medium">失败 / 刷新</th>
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
                          <div className="flex flex-wrap items-center gap-2">
                            {/* 与 Admin 卡片同一口径：有邮箱显示邮箱，没有才退回「凭据 #id」 */}
                            <span className="font-medium">
                              {credential.email || `#${credential.id}`}
                            </span>
                            {credential.email && (
                              <span className="text-xs text-muted-foreground">
                                #{credential.id}
                              </span>
                            )}
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
                        <td
                          className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground"
                          title={
                            credential.inputTokens === undefined
                              ? '当前 kiro-rs 不返回 token 统计'
                              : `输入 ${formatNumber(credential.inputTokens)} · 输出 ${formatNumber(credential.outputTokens ?? 0)}`
                          }
                        >
                          {credential.inputTokens === undefined
                            ? '—'
                            : formatTokens(credential.inputTokens + (credential.outputTokens ?? 0))}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {formatNumber(credential.successCount)}
                        </td>
                        {/* 两类失败并成一列：都为 0 时只显示一个 0，省掉一整列的视觉噪音 */}
                        <td className="px-2 py-2 text-right tabular-nums">
                          <span
                            className={cn(
                              credential.failureCount > 0 && 'font-medium text-red-500'
                            )}
                          >
                            {formatNumber(credential.failureCount)}
                          </span>
                          {credential.refreshFailureCount > 0 && (
                            <span
                              className="ml-1 text-xs font-medium text-orange-500"
                              title={`Token 刷新失败 ${formatNumber(credential.refreshFailureCount)} 次`}
                            >
                              / {formatNumber(credential.refreshFailureCount)}
                            </span>
                          )}
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
