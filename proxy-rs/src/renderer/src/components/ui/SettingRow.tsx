import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 设置项行：左侧标题 + 说明，右侧控件。
 *
 * 收敛 SettingsPage 里 22 处重复的 `flex items-center justify-between` 结构。
 * `divider` 用于第二项起的分隔线（原代码逐处手写 `pt-2 border-t`）。
 *
 * 控件用 label 关联：传 htmlFor 时标题变成 <label>，点标题即可切换开关，
 * 这是原来"Button 当开关"写法缺失的可用性。
 */
interface SettingRowProps {
  title: React.ReactNode
  description?: React.ReactNode
  /** 右侧控件（Switch / Select / Input / Button）。 */
  control?: React.ReactNode
  /** 与控件关联的 id，让标题可点击。 */
  htmlFor?: string
  /** 顶部分隔线，用于同一卡片内的第二项及之后。 */
  divider?: boolean
  className?: string
  /** 行下方的补充内容（提示框、展开区域等）。 */
  children?: React.ReactNode
}

export function SettingRow({
  title,
  description,
  control,
  htmlFor,
  divider = false,
  className,
  children
}: SettingRowProps): React.ReactNode {
  const TitleTag = htmlFor ? 'label' : 'p'
  return (
    <div className={cn(divider && 'border-t border-border/50 pt-4', className)}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <TitleTag
            {...(htmlFor ? { htmlFor } : {})}
            className={cn('type-title block text-sm text-foreground', htmlFor && 'cursor-pointer')}
          >
            {title}
          </TitleTag>
          {description && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {children}
    </div>
  )
}
