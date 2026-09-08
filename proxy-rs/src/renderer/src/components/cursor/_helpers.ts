import type { CursorPlanTone } from '../../../../shared/cursorAccounts'

/** 套餐徽标（实底）：Ultra 橙、Enterprise 紫、Team 橘、Pro+ 蓝、Pro 绿、Free 灰，与 cockpit-tools 一致。 */
export const PLAN_BADGE_CLASS: Record<CursorPlanTone, string> = {
  ultra: 'border-transparent bg-amber-500 text-white',
  enterprise: 'border-transparent bg-violet-500 text-white',
  team: 'border-transparent bg-orange-500 text-white',
  plus: 'border-transparent bg-sky-500 text-white',
  pro: 'border-transparent bg-emerald-500 text-white',
  free: 'border-transparent bg-zinc-500 text-white',
  unknown: 'border-transparent bg-zinc-400 text-white'
}

/** 用量进度条配色：≥90% 红、≥70% 琥珀、其余绿。 */
export function usageBarClass(percent: number): string {
  if (percent >= 90) return 'bg-red-500'
  if (percent >= 70) return 'bg-amber-500'
  return 'bg-emerald-500'
}

/** 百分比数字配色，与进度条同一套阈值。 */
export function usageTextClass(percent: number | null): string {
  if (percent == null) return 'text-muted-foreground'
  if (percent >= 90) return 'text-red-500'
  if (percent >= 70) return 'text-amber-500'
  return 'text-emerald-500'
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

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}
