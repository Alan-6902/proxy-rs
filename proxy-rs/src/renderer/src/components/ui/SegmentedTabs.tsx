import * as React from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

/**
 * 分段切换控件（segmented control）。
 *
 * 激活药丸用 framer-motion 的共享 layout 在选项间滑动，与 Sidebar 的 active-pill 同一套视觉语言
 * （主题渐变 + spring）。同页出现多组时必须传不同的 `layoutId`，否则药丸会在两组之间飞。
 */
export interface SegmentedTabItem<T extends string> {
  value: T
  label: React.ReactNode
  /** lucide 图标组件本身（非元素）。 */
  icon?: React.ElementType
  /** 选项右侧的状态小徽标：分段折叠了内容，用它把关键状态留在表面。 */
  badge?: React.ReactNode
  /** 悬浮说明。 */
  title?: string
}

interface SegmentedTabsProps<T extends string> {
  value: T
  items: SegmentedTabItem<T>[]
  onChange: (value: T) => void
  /** 共享药丸的唯一 id。 */
  layoutId: string
  /** 紧凑档：用于嵌在面板内的二级选择（策略、范围）。 */
  size?: 'default' | 'sm'
  disabled?: boolean
  /** 无障碍名称，标注这组分段在选什么。 */
  ariaLabel?: string
  className?: string
}

export function SegmentedTabs<T extends string>({
  value,
  items,
  onChange,
  layoutId,
  size = 'default',
  disabled = false,
  ariaLabel,
  className
}: SegmentedTabsProps<T>): React.ReactNode {
  // 左右方向键在分段间移动，桌面端键盘操作的最低预期
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!offset) return
    event.preventDefault()
    const current = items.findIndex((item) => item.value === value)
    const next = items[(current + offset + items.length) % items.length]
    if (next) onChange(next.value)
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-center gap-1 rounded-xl border border-[var(--glass-border-strong)] bg-[var(--glass-bg-subtle)] p-1 backdrop-blur-md',
        disabled && 'opacity-50',
        className
      )}
    >
      {items.map((item) => {
        const active = item.value === value
        const Icon = item.icon
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            title={item.title}
            onClick={() => onChange(item.value)}
            className={cn(
              'relative flex items-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
              'disabled:cursor-not-allowed',
              size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
              active ? 'text-white' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-lg shadow-[0_2px_10px_rgba(91,140,255,0.28)]"
                style={{
                  background: 'linear-gradient(135deg, var(--gradient-from), var(--gradient-to))'
                }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              />
            )}
            {Icon && (
              <Icon
                className={cn('relative z-10 shrink-0', size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4')}
              />
            )}
            <span className="relative z-10">{item.label}</span>
            {item.badge != null && item.badge !== '' && (
              <span
                className={cn(
                  'relative z-10 rounded-md px-1.5 py-px text-3xs font-semibold tabular-nums',
                  active ? 'bg-white/22 text-white' : 'bg-foreground/8 text-muted-foreground'
                )}
              >
                {item.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
