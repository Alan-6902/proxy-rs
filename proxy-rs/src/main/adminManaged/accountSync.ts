/**
 * 托管账号的状态同步。
 *
 * 账号一旦交给本机反代托管，proxy-rs 就停掉它的本地 token 刷新，因而再也无法
 * 直连 Kiro 上游查用量与订阅状态。这些数据改从反代的 Admin 接口读——反代同样
 * 记着该凭据的余额与订阅标题，而且它才是当前唯一的 token 持有者。
 *
 * 不设「反代不可达就退回直连」的兜底：退回必然伴随一次刷新，等于重新引入双边
 * 抢刷，正是这次改造要消除的东西。宁可让状态停更并明确报错。
 */

import {
  resolveSubscriptionTypeFromTitle,
  type SubscriptionType
} from '../../shared/localAdminStats'
import { fetchLocalAdminUsage } from '../localAdminStats/statsClient'

type LocalAdminStatsTarget = Parameters<typeof fetchLocalAdminUsage>[0]

const MS_PER_DAY = 86_400_000

/** 与渲染进程 AccountUsage 对齐的子集。反代只给总量，不带 base/bonus/freeTrial 子项。 */
export interface ManagedAccountUsage {
  current: number
  limit: number
  percentUsed: number
  lastUpdated: number
  nextResetDate?: string
}

/** 与渲染进程 AccountSubscription 对齐的子集。 */
export interface ManagedAccountSubscription {
  type: SubscriptionType
  title?: string
  expiresAt?: number
  daysRemaining?: number
}

export interface ManagedAccountSyncResult {
  usage?: ManagedAccountUsage
  subscription?: ManagedAccountSubscription
  status: 'active' | 'error'
  errorMessage?: string
}

/**
 * 读一条托管账号的用量与订阅状态。
 *
 * 缺 base / bonus / freeTrial 子项时留空，卡片按「已查过但没有明细」渲染，
 * 与刚导入还没查过的状态一致。
 */
export async function syncManagedAccountFromAdmin(
  target: LocalAdminStatsTarget,
  credentialId: string,
  now: number = Date.now()
): Promise<ManagedAccountSyncResult> {
  const { usage, errors } = await fetchLocalAdminUsage(target, [credentialId])
  const parsed = usage.get(credentialId)
  if (!parsed) {
    return {
      status: 'error',
      errorMessage: errors[0] ?? `反代未返回凭据 #${credentialId} 的用量`
    }
  }

  // 反代给的是毫秒时间戳，卡片按 ISO 字符串渲染（与上游口径一致）
  const nextResetDate = parsed.nextResetAt
    ? new Date(parsed.nextResetAt).toISOString()
    : undefined

  const title = parsed.subscriptionTitle?.trim()
  const subscription: ManagedAccountSubscription | undefined = title
    ? {
        type: resolveSubscriptionTypeFromTitle(title),
        title,
        expiresAt: parsed.nextResetAt,
        daysRemaining: parsed.nextResetAt
          ? Math.max(0, Math.ceil((parsed.nextResetAt - now) / MS_PER_DAY))
          : undefined
      }
    : undefined

  return {
    usage: {
      current: parsed.current,
      limit: parsed.limit,
      percentUsed: parsed.percentUsed,
      lastUpdated: parsed.fetchedAt,
      nextResetDate
    },
    subscription,
    status: 'active'
  }
}
