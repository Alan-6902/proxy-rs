/**
 * 把上游 getUsageLimits 原样响应解析成账号卡片用的 usage / subscription。
 *
 * 账号库模式下 kiro-rs 把原样响应存进 account_usage.raw_json，proxy-rs 用这里的解析展示。
 * 口径与主进程 check-account-status 的 parseUsageResponse 一致：取 CREDIT 类明细，
 * 基础额度 + ACTIVE 试用 + ACTIVE 奖励累加。
 */

import { resolveSubscriptionTypeFromTitle, type SubscriptionType } from './subscriptionType'

const MS_PER_DAY = 86_400_000

interface RawAmount {
  usageLimit?: number
  usageLimitWithPrecision?: number
  currentUsage?: number
  currentUsageWithPrecision?: number
}

interface RawBreakdown extends RawAmount {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  freeTrialInfo?: RawAmount & { freeTrialStatus?: string; freeTrialExpiry?: string | number }
  bonuses?: Array<
    RawAmount & {
      status?: string
      bonusCode?: string
      displayName?: string
      expiresAt?: string | number
    }
  >
}

interface RawUsageLimits {
  usageBreakdownList?: RawBreakdown[]
  nextDateReset?: string | number
  subscriptionInfo?: {
    subscriptionTitle?: string
    type?: string
    upgradeCapability?: string
    overageCapability?: string
    subscriptionManagementTarget?: string
  }
  overageConfiguration?: { overageStatus?: string; overageEnabled?: boolean }
  userInfo?: { email?: string; userId?: string }
}

export interface ParsedUsage {
  current: number
  limit: number
  percentUsed: number
  lastUpdated: number
  baseLimit: number
  baseCurrent: number
  freeTrialLimit: number
  freeTrialCurrent: number
  freeTrialExpiry?: string
  bonuses: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
  nextResetDate?: string
  resourceDetail?: {
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    overageEnabled: boolean
  }
}

export interface ParsedSubscription {
  type: SubscriptionType
  title: string
  rawType?: string
  expiresAt?: number
  daysRemaining?: number
  upgradeCapability?: string
  overageCapability?: string
  managementTarget?: string
}

export interface ParsedUsageLimits {
  usage: ParsedUsage
  subscription: ParsedSubscription
  email?: string
  userId?: string
}

function amount(value: RawAmount | undefined, kind: 'limit' | 'current'): number {
  if (!value) return 0
  return kind === 'limit'
    ? (value.usageLimitWithPrecision ?? value.usageLimit ?? 0)
    : (value.currentUsageWithPrecision ?? value.currentUsage ?? 0)
}

/** 上游日期字段可能是 Unix 秒或 ISO 字符串，统一成 ISO 字符串 */
function toIsoDate(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'number' ? new Date(value * 1000).toISOString() : value
}

/** 解析失败（非对象）返回 null；字段缺失按 0 / 空处理 */
export function parseUsageLimits(raw: unknown, observedAt: number): ParsedUsageLimits | null {
  if (typeof raw !== 'object' || raw === null) return null
  const result = raw as RawUsageLimits
  const credit = result.usageBreakdownList?.find(
    (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
  )

  const baseLimit = amount(credit, 'limit')
  const baseCurrent = amount(credit, 'current')
  let freeTrialLimit = 0
  let freeTrialCurrent = 0
  let freeTrialExpiry: string | undefined
  if (credit?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
    freeTrialLimit = amount(credit.freeTrialInfo, 'limit')
    freeTrialCurrent = amount(credit.freeTrialInfo, 'current')
    freeTrialExpiry = toIsoDate(credit.freeTrialInfo.freeTrialExpiry)
  }
  const bonuses = (credit?.bonuses ?? [])
    .filter((bonus) => bonus.status === 'ACTIVE')
    .map((bonus) => ({
      code: bonus.bonusCode || '',
      name: bonus.displayName || '',
      current: amount(bonus, 'current'),
      limit: amount(bonus, 'limit'),
      expiresAt: toIsoDate(bonus.expiresAt)
    }))
  const limit = baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
  const current = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)

  const title = result.subscriptionInfo?.subscriptionTitle ?? 'Free'
  let expiresAt: number | undefined
  let daysRemaining: number | undefined
  const nextResetDate = toIsoDate(result.nextDateReset)
  if (nextResetDate) {
    expiresAt = new Date(nextResetDate).getTime()
    daysRemaining = Math.max(0, Math.ceil((expiresAt - observedAt) / MS_PER_DAY))
  }

  return {
    email: result.userInfo?.email,
    userId: result.userInfo?.userId,
    usage: {
      current,
      limit,
      percentUsed: limit > 0 ? current / limit : 0,
      lastUpdated: observedAt,
      baseLimit,
      baseCurrent,
      freeTrialLimit,
      freeTrialCurrent,
      freeTrialExpiry,
      bonuses,
      nextResetDate,
      resourceDetail: credit
        ? {
            resourceType: credit.resourceType,
            displayName: credit.displayName,
            displayNamePlural: credit.displayNamePlural,
            currency: credit.currency,
            unit: credit.unit,
            overageRate: credit.overageRate,
            overageCap: credit.overageCap,
            overageEnabled:
              result.overageConfiguration?.overageStatus === 'ENABLED' ||
              result.overageConfiguration?.overageEnabled === true
          }
        : undefined
    },
    subscription: {
      type: resolveSubscriptionTypeFromTitle(title),
      title,
      rawType: result.subscriptionInfo?.type,
      expiresAt,
      daysRemaining,
      upgradeCapability: result.subscriptionInfo?.upgradeCapability,
      overageCapability: result.subscriptionInfo?.overageCapability,
      managementTarget: result.subscriptionInfo?.subscriptionManagementTarget
    }
  }
}
