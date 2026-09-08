import type { CursorPlanTone } from '../../../../shared/cursorAccounts'

/** 套餐徽标配色：Ultra 紫、Enterprise 琥珀、Team 橙、Pro+ 蓝、Pro 绿、Free 灰。 */
export const PLAN_TONE_CLASS: Record<CursorPlanTone, string> = {
  ultra: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300',
  enterprise: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  team: 'border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-300',
  plus: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300',
  pro: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  free: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300',
  unknown: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-500 dark:text-zinc-400'
}

/** 用量进度条配色：≥90% 红、≥70% 琥珀、其余绿。 */
export function usageBarClass(percent: number): string {
  if (percent >= 90) return 'bg-red-500'
  if (percent >= 70) return 'bg-amber-500'
  return 'bg-emerald-500'
}

export function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}

export function formatDateTime(value?: number | null): string {
  return value ? new Date(value).toLocaleString() : '—'
}

export function formatDate(value?: number | null): string {
  return value ? new Date(value).toLocaleDateString() : '—'
}

/** 距某个时间点还剩几天（向下取整，已过期为 0）。 */
export function daysUntil(value: number, now = Date.now()): number {
  return Math.max(0, Math.floor((value - now) / 86_400_000))
}

export function formatRelativeTime(value?: number | null, now = Date.now()): string {
  if (!value) return '—'
  const diff = Math.max(0, now - value)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(value).toLocaleDateString()
}

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return fallback
}
