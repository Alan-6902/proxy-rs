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
