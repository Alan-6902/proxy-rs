import { cn } from './utils'

/**
 * 开关轨道 / 滑块的类名。
 *
 * 单独抽出是为了让「整块可点的开关磁贴」把外层容器本身做成 role="switch" 按钮，
 * 内部只画视觉（span），避免 button 套 button 的非法结构，同时两处视觉保持单一来源。
 */
export function switchTrackClass(checked: boolean, className?: string): string {
  return cn(
    'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
    checked
      ? 'bg-[linear-gradient(135deg,var(--gradient-from),var(--gradient-to))] shadow-[0_2px_8px_rgba(91,140,255,0.35)]'
      : 'bg-foreground/20 dark:bg-foreground/15 shadow-inner',
    className
  )
}

export function switchKnobClass(checked: boolean): string {
  return cn(
    'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-md ring-1 ring-black/5 transition-transform duration-200',
    checked ? 'translate-x-4' : 'translate-x-0'
  )
}
