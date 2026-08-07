import * as React from 'react'
import { cn } from '@/lib/utils'
import { Label } from './label'
import { switchKnobClass, switchTrackClass } from '@/lib/switchStyles'

/**
 * 配置字段：小标签 + 控件（+ 标签右侧的辅助操作区）。
 *
 * 多处「Label(text-xs) + space-y-1.5 + 控件」的重复外壳收敛到这里，
 * 顺带统一 hint（title tooltip）与 label 右侧工具区的排布。
 */
interface FieldProps {
  label: React.ReactNode
  /** 关联控件 id，点标签聚焦控件。 */
  htmlFor?: string
  /** 悬浮说明，落到 label 的 title。 */
  hint?: string
  /** 标签同行右侧的紧凑操作区（格式选择、生成/复制按钮等）。 */
  labelAction?: React.ReactNode
  className?: string
  children: React.ReactNode
}

export function Field({
  label,
  htmlFor,
  hint,
  labelAction,
  className,
  children
}: FieldProps): React.ReactNode {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <Label
          {...(htmlFor ? { htmlFor } : {})}
          {...(hint ? { title: hint } : {})}
          className={cn(
            'truncate text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground',
            hint && 'decoration-dotted underline-offset-4 hover:underline'
          )}
        >
          {label}
        </Label>
        {labelAction && <div className="flex shrink-0 items-center gap-1">{labelAction}</div>}
      </div>
      {children}
    </div>
  )
}

/**
 * 开关磁贴：一个开关占一格，标题与状态文案在左、开关在右。
 *
 * 取代原先「Switch + Label 裸排在 grid 里」的写法——那种排法在条件项跨列时会串行错位，
 * 且点击热区只有 label 文字本身。磁贴整体可点，开启态用主色描边直接标识。
 */
interface SwitchTileProps {
  id: string
  title: React.ReactNode
  /** 开关状态的一句话说明，随开关状态变化时由调用方传入对应文案。 */
  description?: React.ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  /** 左侧图标，传 lucide 图标组件本身。 */
  icon?: React.ElementType
  hint?: string
  className?: string
}

export function SwitchTile({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  icon: Icon,
  hint,
  className
}: SwitchTileProps): React.ReactNode {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      title={hint}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
        checked
          ? 'border-primary/35 bg-primary/8 shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]'
          : 'border-[var(--glass-border-strong)] bg-[var(--glass-bg-subtle)]',
        !disabled && !checked && 'hover:border-primary/25 hover:bg-[var(--glass-bg)]',
        className
      )}
    >
      {Icon && (
        <Icon
          className={cn(
            'h-4 w-4 shrink-0 transition-colors',
            checked ? 'text-primary' : 'text-muted-foreground'
          )}
          strokeWidth={1.9}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('type-title truncate text-sm', checked && 'text-foreground')}>{title}</p>
        {description && (
          <p className="mt-0.5 truncate text-3xs text-muted-foreground">{description}</p>
        )}
      </div>
      <span className={switchTrackClass(checked, 'pointer-events-none shrink-0')}>
        <span className={switchKnobClass(checked)} />
      </span>
    </button>
  )
}
