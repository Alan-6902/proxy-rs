export type SubscriptionType = 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams'

/**
 * 从 Kiro 返回的订阅标题推断订阅类型。
 *
 * main 与 renderer 共用这一份，避免各处各写一套 `toUpperCase().includes` 判断。
 */
export function resolveSubscriptionTypeFromTitle(title: string): SubscriptionType {
  const normalized = title.toUpperCase()
  if (normalized.includes('PRO+') || normalized.includes('PRO_PLUS')) return 'Pro_Plus'
  if (normalized.includes('PRO')) return 'Pro'
  if (normalized.includes('POWER') || normalized.includes('ENTERPRISE')) return 'Enterprise'
  if (normalized.includes('TEAMS')) return 'Teams'
  return 'Free'
}
