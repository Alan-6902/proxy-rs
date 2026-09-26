import type { CursorPlanTone } from '../../../../shared/cursorAccounts'

/** 套餐徽标（实底）：Ultra 橙、Enterprise 紫罗兰、Team 紫、Pro+ 天蓝、Pro 蓝、Free 灰。 */
export const PLAN_BADGE_CLASS: Record<CursorPlanTone, string> = {
  ultra: 'border-transparent bg-amber-500 text-white',
  enterprise: 'border-transparent bg-violet-500 text-white',
  team: 'border-transparent bg-purple-500 text-white',
  plus: 'border-transparent bg-sky-500 text-white',
  pro: 'border-transparent bg-blue-500 text-white',
  free: 'border-transparent bg-zinc-500 text-white',
  unknown: 'border-transparent bg-zinc-400 text-white'
}

/** 用量进度条配色：≥90% 红、≥70% 琥珀、其余绿；带一点横向渐变，与 cockpit-tools 观感一致。 */
export function usageBarClass(percent: number): string {
  if (percent >= 90) return 'bg-gradient-to-r from-red-600 to-red-500'
  if (percent >= 70) return 'bg-gradient-to-r from-amber-600 to-amber-400'
  return 'bg-gradient-to-r from-emerald-600 to-emerald-400'
}

/** 百分比数字配色，与进度条同一套阈值。 */
export function usageTextClass(percent: number | null): string {
  if (percent == null) return 'text-muted-foreground'
  if (percent >= 90) return 'text-red-500'
  if (percent >= 70) return 'text-amber-500'
  return 'text-emerald-500'
}

/** `35%`；没数据时给一个破折号占位，避免行高跳动。 */
export function percentText(percent: number | null): string {
  return percent == null ? '—' : `${Math.round(percent)}%`
}

/** `2026/09/21 12:48` 这种紧凑写法，卡片里放得下。 */
export function formatCompactDateTime(value?: number | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

/** 距某个时间点还剩几天（向下取整，已过期为 0）。 */
export function daysUntil(value: number, now = Date.now()): number {
  return Math.max(0, Math.floor((value - now) / 86_400_000))
}

/** `09/21` 这种只带月日的写法，给已经有倒计时的场景补一个日期锚点。 */
export function formatShortDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
}

/** `09/08 15:44`：底栏可用宽度有限，年份放到 title 里。 */
export function formatShortDateTime(value?: number | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

/** 「12 天后重置」/「今天重置」，比裸日期更快被读懂。 */
export function resetCountdownLabel(value: number): string {
  const days = daysUntil(value)
  return days === 0 ? '今天重置' : `${days} 天后重置`
}

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}
