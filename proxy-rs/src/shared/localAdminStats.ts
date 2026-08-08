/**
 * 本机 Admin（kiro-rs /admin）反代统计的共享类型：主进程抓取、渲染进程展示。
 *
 * 数据来源分两类：
 * - 计数类（成功 / 失败 / 刷新失败 / 最后调用）来自 `GET /api/admin/credentials`，一次拿全，免费；
 * - 用量类（已用 / 上限 / 剩余）来自 `GET /api/admin/credentials/:id/balance`，一条一请求且会打
 *   上游 AWS，所以只在用户手动点「刷新用量」时逐条串行拉。
 *
 * kiro-rs 只持久化 success_count 与 last_used_at（config/kiro_stats.json），失败计数是内存态，
 * 容器重启即归零；历史时间序列上游也不存。所以趋势由本地按快照自己攒，见 statsStore。
 */

/** 快照采样间隔（秒）：计数类字段免费，抓得密一点趋势才有形状。 */
export const LOCAL_ADMIN_STATS_POLL_INTERVAL_SECONDS = 60

/** 趋势保留的快照条数上限，按 60 秒间隔约等于 24 小时。 */
export const LOCAL_ADMIN_STATS_MAX_SAMPLES = 1440

/** 用量占比告警阈值（0-1 小数），超过即视为额度告急。 */
export const LOCAL_ADMIN_USAGE_WARN_RATIO = 0.9

/** 凭据的告警类别，渲染层据此高亮。 */
export const LOCAL_ADMIN_ALERT = {
  /** 凭据被 Admin 禁用 */
  DISABLED: 'disabled',
  /** 调用失败计数大于 0 */
  FAILING: 'failing',
  /** Token 刷新失败计数大于 0 */
  REFRESH_FAILING: 'refresh_failing',
  /** 额度用量超过告警阈值 */
  QUOTA_HIGH: 'quota_high',
  /** 额度已耗尽 */
  QUOTA_EXHAUSTED: 'quota_exhausted'
} as const

export type LocalAdminAlert = (typeof LOCAL_ADMIN_ALERT)[keyof typeof LOCAL_ADMIN_ALERT]

/** 采集链路状态。 */
export const LOCAL_ADMIN_STATS_STATE = {
  /** 未配置本机 Admin，或配置不完整 */
  UNCONFIGURED: 'unconfigured',
  /** 已配置但还没抓到过数据 */
  IDLE: 'idle',
  /** 抓取中 */
  RUNNING: 'running',
  /** 最近一次抓取成功 */
  HEALTHY: 'healthy',
  /** 最近一次抓取失败 */
  FAILED: 'failed'
} as const

export type LocalAdminStatsState =
  (typeof LOCAL_ADMIN_STATS_STATE)[keyof typeof LOCAL_ADMIN_STATS_STATE]

/** 单条凭据的用量，仅在手动刷新过后才有。 */
export interface LocalAdminCredentialUsage {
  current: number
  limit: number
  remaining: number
  /** 0-1 小数，由 current/limit 归一化得到，不直接用上游的百分数 */
  percentUsed: number
  subscriptionTitle?: string
  /** 额度重置时间（毫秒时间戳） */
  nextResetAt?: number
  /** 本地抓到这份用量的时间（毫秒时间戳） */
  fetchedAt: number
}

/** 单条凭据的统计视图，不含任何凭据明文。 */
export interface LocalAdminCredentialStats {
  id: string
  /** Admin 侧的脱敏 Key，形如 ksk_...ibfB */
  maskedKey?: string
  authMethod?: string
  endpoint?: string
  email?: string
  subscriptionTitle?: string
  priority: number
  disabled: boolean
  isCurrent: boolean
  successCount: number
  failureCount: number
  refreshFailureCount: number
  /** 最后一次被调用的时间（毫秒时间戳） */
  lastUsedAt?: number
  usage?: LocalAdminCredentialUsage
  /** 该凭据命中的告警，空数组表示健康 */
  alerts: LocalAdminAlert[]
}

/** 聚合总览，全部由凭据明细算出，避免两处口径不一致。 */
export interface LocalAdminStatsTotals {
  credentials: number
  available: number
  disabled: number
  successCount: number
  failureCount: number
  refreshFailureCount: number
  /** 成功 /（成功 + 失败），无样本时为 undefined */
  successRate?: number
  /** 有用量数据的凭据条数 */
  usageSampleCount: number
  /** 已消耗的额度合计，KPI 里的「对应量」 */
  usageCurrent: number
  usageLimit: number
  usageRemaining: number
  /** 0-1 小数；usageLimit 为 0 时为 undefined */
  usagePercentUsed?: number
  alertCount: number
}

/** 趋势采样点：只留能画线的聚合量，避免快照文件按凭据数膨胀。 */
export interface LocalAdminStatsSample {
  at: number
  successCount: number
  failureCount: number
  refreshFailureCount: number
  credentials: number
  available: number
  usageCurrent?: number
  usageLimit?: number
}

export interface LocalAdminStatsStatus {
  state: LocalAdminStatsState
  /** Admin 地址（已脱去 query/hash，可安全展示） */
  baseUrl?: string
  lastAttemptAt?: number
  lastSuccessAt?: number
  lastError?: string
  /** 最近一次手动刷新用量的完成时间 */
  lastUsageRefreshAt?: number
  /** 最近一次手动刷新用量的失败条数 */
  lastUsageErrorCount: number
}

export interface LocalAdminStatsSnapshot {
  status: LocalAdminStatsStatus
  totals: LocalAdminStatsTotals
  credentials: LocalAdminCredentialStats[]
  samples: LocalAdminStatsSample[]
  /** 按小时的消耗桶，报表过滤器的数据源 */
  buckets: LocalAdminHourlyBucket[]
}

/** 手动刷新用量的结果汇总。 */
export interface LocalAdminUsageRefreshSummary {
  refreshed: number
  failed: number
  /** 逐条失败原因，已脱敏 */
  errors: string[]
}

export const EMPTY_LOCAL_ADMIN_STATS_TOTALS: LocalAdminStatsTotals = {
  credentials: 0,
  available: 0,
  disabled: 0,
  successCount: 0,
  failureCount: 0,
  refreshFailureCount: 0,
  successRate: undefined,
  usageSampleCount: 0,
  usageCurrent: 0,
  usageLimit: 0,
  usageRemaining: 0,
  usagePercentUsed: undefined,
  alertCount: 0
}

/** 由凭据明细聚合总览。渲染层与主进程共用，保证两侧数字一致。 */
export function aggregateLocalAdminStats(
  credentials: LocalAdminCredentialStats[]
): LocalAdminStatsTotals {
  const totals: LocalAdminStatsTotals = { ...EMPTY_LOCAL_ADMIN_STATS_TOTALS }
  for (const credential of credentials) {
    totals.credentials++
    if (credential.disabled) totals.disabled++
    else totals.available++
    totals.successCount += credential.successCount
    totals.failureCount += credential.failureCount
    totals.refreshFailureCount += credential.refreshFailureCount
    if (credential.alerts.length > 0) totals.alertCount++
    if (credential.usage) {
      totals.usageSampleCount++
      totals.usageCurrent += credential.usage.current
      totals.usageLimit += credential.usage.limit
      totals.usageRemaining += credential.usage.remaining
    }
  }
  const attempts = totals.successCount + totals.failureCount
  totals.successRate = attempts > 0 ? totals.successCount / attempts : undefined
  totals.usagePercentUsed =
    totals.usageLimit > 0 ? totals.usageCurrent / totals.usageLimit : undefined
  return totals
}

/** 判定单条凭据命中的告警。用量缺失时只判计数类。 */
export function resolveLocalAdminAlerts(input: {
  disabled: boolean
  failureCount: number
  refreshFailureCount: number
  usage?: { limit: number; remaining: number; percentUsed: number }
}): LocalAdminAlert[] {
  const alerts: LocalAdminAlert[] = []
  if (input.disabled) alerts.push(LOCAL_ADMIN_ALERT.DISABLED)
  if (input.failureCount > 0) alerts.push(LOCAL_ADMIN_ALERT.FAILING)
  if (input.refreshFailureCount > 0) alerts.push(LOCAL_ADMIN_ALERT.REFRESH_FAILING)
  if (input.usage && input.usage.limit > 0) {
    if (input.usage.remaining <= 0) alerts.push(LOCAL_ADMIN_ALERT.QUOTA_EXHAUSTED)
    else if (input.usage.percentUsed >= LOCAL_ADMIN_USAGE_WARN_RATIO) {
      alerts.push(LOCAL_ADMIN_ALERT.QUOTA_HIGH)
    }
  }
  return alerts
}

/* ------------------------------------------------------------------ *
 * 按小时的消耗报表
 *
 * Admin 只回累计值（successCount 单调增、currentUsage 按月累计），要回答
 * 「这个小时每个账号消耗了多少」只能靠相邻两次观测做差分，再按小时归桶。
 *
 * 差分的两个坑，都在 diffLocalAdminCounter 里兜住：
 * - 计数会归零：Admin 重启清空失败计数，额度到 nextResetAt 按月重置；
 * - 凭据会换：抢号器删旧增新，id 还可能被复用。首次见到一条凭据时只记基线、
 *   不记增量，否则会把它入库前的历史用量算成本小时的消耗。
 * ------------------------------------------------------------------ */

/** 小时桶保留时长：7 天 = 168 小时。 */
export const LOCAL_ADMIN_USAGE_BUCKET_RETENTION_HOURS = 168

/** 「全天」在小时过滤器里的取值。 */
export const LOCAL_ADMIN_REPORT_ALL_HOURS = 'all'

export type LocalAdminReportHour = number | typeof LOCAL_ADMIN_REPORT_ALL_HOURS

/** 单个凭据在某个小时内的增量。都是差分结果，可以直接相加。 */
export interface LocalAdminHourlyCredentialDelta {
  id: string
  /** 观测时的脱敏 Key，凭据被删后报表仍能显示它是谁 */
  maskedKey?: string
  /** 该小时新增的额度消耗（Kiro credits） */
  usageDelta: number
  successDelta: number
  failureDelta: number
  refreshFailureDelta: number
  /** 该小时最后一次观测到的累计用量与上限 */
  usageCurrent?: number
  usageLimit?: number
  /** 该小时最后一次观测到这条凭据的时间 */
  lastSeenAt: number
}

export interface LocalAdminHourlyBucket {
  /** 整小时起点（本地时区，毫秒时间戳） */
  hour: number
  credentials: LocalAdminHourlyCredentialDelta[]
}

/** 上一次观测到的累计值，用来算下一次的增量。 */
export interface LocalAdminCumulativeCursor {
  id: string
  successCount: number
  failureCount: number
  refreshFailureCount: number
  usageCurrent?: number
  at: number
}

/**
 * 单个累计计数器的差分。
 *
 * 回落一律记 0 而不是负数：Admin 重启会把失败计数清零，额度到期会按月重置，
 * 这两种回落都不代表「消耗了负数」。代价是跨重置那一个小时的消耗会少记
 * （重置后新产生的那部分），这比让报表出现负值更可接受。
 */
export function diffLocalAdminCounter(previous: number | undefined, next: number): number {
  if (previous === undefined || !Number.isFinite(previous)) return 0
  if (!Number.isFinite(next)) return 0
  return next > previous ? next - previous : 0
}

/** 归整到所属小时的起点（本地时区）。 */
export function toHourStart(at: number): number {
  const date = new Date(at)
  date.setMinutes(0, 0, 0)
  return date.getTime()
}

/**
 * 把一次观测并入小时桶，返回更新后的桶列表与新的游标。
 *
 * 纯函数：主进程每轮采样调用它，测试也直接喂序列验证差分口径。
 * 首次见到的凭据只写基线（增量 0），避免把入库前的历史算成本小时消耗。
 */
export function accumulateHourlyUsage(input: {
  buckets: LocalAdminHourlyBucket[]
  cursors: LocalAdminCumulativeCursor[]
  credentials: LocalAdminCredentialStats[]
  at: number
  retentionHours?: number
}): { buckets: LocalAdminHourlyBucket[]; cursors: LocalAdminCumulativeCursor[] } {
  const hour = toHourStart(input.at)
  const cursorById = new Map(input.cursors.map((cursor) => [cursor.id, cursor]))
  const bucketByHour = new Map(input.buckets.map((bucket) => [bucket.hour, bucket]))
  const current = bucketByHour.get(hour) ?? { hour, credentials: [] }
  const deltaById = new Map(current.credentials.map((item) => [item.id, { ...item }]))

  for (const credential of input.credentials) {
    const cursor = cursorById.get(credential.id)
    const usageCurrent = credential.usage?.current
    const entry = deltaById.get(credential.id) ?? {
      id: credential.id,
      maskedKey: credential.maskedKey,
      usageDelta: 0,
      successDelta: 0,
      failureDelta: 0,
      refreshFailureDelta: 0,
      lastSeenAt: input.at
    }

    entry.maskedKey = credential.maskedKey ?? entry.maskedKey
    entry.successDelta += diffLocalAdminCounter(cursor?.successCount, credential.successCount)
    entry.failureDelta += diffLocalAdminCounter(cursor?.failureCount, credential.failureCount)
    entry.refreshFailureDelta += diffLocalAdminCounter(
      cursor?.refreshFailureCount,
      credential.refreshFailureCount
    )
    if (usageCurrent !== undefined) {
      entry.usageDelta += diffLocalAdminCounter(cursor?.usageCurrent, usageCurrent)
      entry.usageCurrent = usageCurrent
      entry.usageLimit = credential.usage?.limit
    }
    entry.lastSeenAt = input.at
    deltaById.set(credential.id, entry)

    cursorById.set(credential.id, {
      id: credential.id,
      successCount: credential.successCount,
      failureCount: credential.failureCount,
      refreshFailureCount: credential.refreshFailureCount,
      // 这一轮没查到用量时保留旧基线，否则下一轮会把整段累计当成新增消耗
      usageCurrent: usageCurrent ?? cursor?.usageCurrent,
      at: input.at
    })
  }

  bucketByHour.set(hour, { hour, credentials: [...deltaById.values()] })
  const retentionHours = input.retentionHours ?? LOCAL_ADMIN_USAGE_BUCKET_RETENTION_HOURS
  const earliest = hour - (retentionHours - 1) * 3_600_000
  const buckets = [...bucketByHour.values()]
    .filter((bucket) => bucket.hour >= earliest)
    .sort((a, b) => a.hour - b.hour)

  // 凭据删了就不再产生新增量，但游标要留着：id 复用时仍需基线来判断回落
  const aliveIds = new Set(buckets.flatMap((bucket) => bucket.credentials.map((item) => item.id)))
  const cursors = [...cursorById.values()].filter(
    (cursor) => aliveIds.has(cursor.id) || cursor.at >= earliest
  )
  return { buckets, cursors }
}

/** 报表窗口：某天的某个小时，或整天。 */
export interface LocalAdminReportRange {
  /** 本地日期，YYYY-MM-DD */
  date: string
  hour: LocalAdminReportHour
}

/** 报表里的单个账号行。 */
export interface LocalAdminReportRow {
  id: string
  maskedKey?: string
  usageDelta: number
  successDelta: number
  failureDelta: number
  refreshFailureDelta: number
  /** 窗口内最后一次观测到的累计用量与上限，用于显示"当前水位" */
  usageCurrent?: number
  usageLimit?: number
  lastSeenAt: number
  /** 该凭据是否还在 Admin 里；已删除的凭据历史仍展示 */
  present: boolean
}

export interface LocalAdminReport {
  range: LocalAdminReportRange
  /** 窗口起止（毫秒时间戳），闭开区间 [from, to) */
  from: number
  to: number
  rows: LocalAdminReportRow[]
  usageDelta: number
  successDelta: number
  failureDelta: number
  refreshFailureDelta: number
  /** 窗口内有数据的小时数，用来提示采样是否稀疏 */
  hoursWithData: number
}

/** 本地日期串，避免 toISOString 的 UTC 偏移把凌晨算到前一天。 */
export function toLocalDateKey(at: number): string {
  const date = new Date(at)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 解析 YYYY-MM-DD + 小时为本地时间窗口，非法日期回落到当天。 */
export function resolveReportWindow(
  range: LocalAdminReportRange,
  now: number
): {
  from: number
  to: number
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(range.date)
  const base = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(now)
  base.setHours(0, 0, 0, 0)
  if (range.hour === LOCAL_ADMIN_REPORT_ALL_HOURS) {
    const to = new Date(base)
    to.setDate(to.getDate() + 1)
    return { from: base.getTime(), to: to.getTime() }
  }
  const hour = Number.isInteger(range.hour) ? Math.min(23, Math.max(0, range.hour)) : 0
  base.setHours(hour)
  return { from: base.getTime(), to: base.getTime() + 3_600_000 }
}

/** 按窗口聚合小时桶，得到每个账号的消耗报表。 */
export function buildLocalAdminReport(input: {
  buckets: LocalAdminHourlyBucket[]
  range: LocalAdminReportRange
  now: number
  /** 当前仍在 Admin 里的凭据 id，用于标记已删除的历史行 */
  presentIds?: Iterable<string>
}): LocalAdminReport {
  const { from, to } = resolveReportWindow(input.range, input.now)
  const present = new Set(input.presentIds ?? [])
  const rowById = new Map<string, LocalAdminReportRow>()
  let hoursWithData = 0

  for (const bucket of input.buckets) {
    if (bucket.hour < from || bucket.hour >= to) continue
    if (bucket.credentials.length > 0) hoursWithData++
    for (const item of bucket.credentials) {
      const row = rowById.get(item.id) ?? {
        id: item.id,
        maskedKey: item.maskedKey,
        usageDelta: 0,
        successDelta: 0,
        failureDelta: 0,
        refreshFailureDelta: 0,
        lastSeenAt: 0,
        present: present.has(item.id)
      }
      row.maskedKey = item.maskedKey ?? row.maskedKey
      row.usageDelta += item.usageDelta
      row.successDelta += item.successDelta
      row.failureDelta += item.failureDelta
      row.refreshFailureDelta += item.refreshFailureDelta
      // 取窗口内最后一次观测的水位，而不是第一次
      if (item.lastSeenAt >= row.lastSeenAt) {
        row.lastSeenAt = item.lastSeenAt
        if (item.usageCurrent !== undefined) row.usageCurrent = item.usageCurrent
        if (item.usageLimit !== undefined) row.usageLimit = item.usageLimit
      }
      rowById.set(item.id, row)
    }
  }

  const rows = [...rowById.values()].sort(
    (a, b) => b.usageDelta - a.usageDelta || Number(a.id) - Number(b.id) || a.id.localeCompare(b.id)
  )
  return {
    range: input.range,
    from,
    to,
    rows,
    usageDelta: rows.reduce((sum, row) => sum + row.usageDelta, 0),
    successDelta: rows.reduce((sum, row) => sum + row.successDelta, 0),
    failureDelta: rows.reduce((sum, row) => sum + row.failureDelta, 0),
    refreshFailureDelta: rows.reduce((sum, row) => sum + row.refreshFailureDelta, 0),
    hoursWithData
  }
}
