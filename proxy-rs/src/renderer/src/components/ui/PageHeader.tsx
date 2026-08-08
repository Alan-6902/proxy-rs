import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 页面顶部标题区。
 *
 * 收敛之前 9 个页面各自手抄的 hero 结构（两个 blur blob + 图标底板 + h1 + 描述）。
 * 氛围光已下沉到 `.page-hero` 伪元素并跟随主题渐变令牌，这里只负责内容排布：
 *
 *   eyebrow（可选全大写小标签）
 *   标题（展示字体）+ 标题右侧徽标
 *   描述
 *   右侧操作区
 *
 * accent 决定图标底板与 eyebrow 的色相。默认 'primary' 跟随主题色；
 * 其余色值给语义固定的页面（诊断=emerald、代理池=cyan、配置同步=indigo、抢号=violet），
 * 保留它们原有的辨识度，同时不再让 h1 直接吃硬编码颜色。
 */
export type PageHeaderAccent = 'primary' | 'emerald' | 'cyan' | 'indigo' | 'violet'

const ACCENT_ICON_CLASS: Record<PageHeaderAccent, string> = {
  primary: 'bg-primary/12 text-primary ring-primary/25',
  emerald: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 ring-emerald-500/25',
  cyan: 'bg-cyan-500/12 text-cyan-600 dark:text-cyan-400 ring-cyan-500/25',
  indigo: 'bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 ring-indigo-500/25',
  violet: 'bg-violet-500/12 text-violet-600 dark:text-violet-400 ring-violet-500/25'
}

const ACCENT_EYEBROW_CLASS: Record<PageHeaderAccent, string> = {
  primary: 'text-primary/75',
  emerald: 'text-emerald-600/80 dark:text-emerald-400/80',
  cyan: 'text-cyan-600/80 dark:text-cyan-400/80',
  indigo: 'text-indigo-600/80 dark:text-indigo-400/80',
  violet: 'text-violet-600/80 dark:text-violet-400/80'
}

interface PageHeaderProps {
  /** 主标题。 */
  title: React.ReactNode
  /** 标题上方的全大写小标签，用于说明页面在应用里的归属。 */
  eyebrow?: React.ReactNode
  /** 标题下的一句话说明。 */
  description?: React.ReactNode
  /** 左侧图标，传 lucide 图标组件本身（非元素）。 */
  icon?: React.ElementType
  /** 直接给出自定义左侧视觉（如产品 logo），优先于 icon。 */
  visual?: React.ReactNode
  /** 标题同行右侧的徽标区（计数、状态等）。 */
  badges?: React.ReactNode
  /** 头部右端操作区。 */
  actions?: React.ReactNode
  accent?: PageHeaderAccent
  /** 紧凑模式：用于日志页这类"头部同时承担工具栏"的场景。 */
  dense?: boolean
  className?: string
}

export function PageHeader({
  title,
  eyebrow,
  description,
  icon: Icon,
  visual,
  badges,
  actions,
  accent = 'primary',
  dense = false,
  className
}: PageHeaderProps): React.ReactNode {
  return (
    <div className={cn('page-hero shrink-0', dense ? 'p-4 sm:p-5' : 'p-6 sm:p-7', className)}>
      <span className="page-hero-rule" />
      <div className="relative z-[2] flex flex-wrap items-center gap-x-5 gap-y-4">
        {visual ??
          (Icon ? (
            <div
              className={cn(
                'grid shrink-0 place-items-center rounded-2xl ring-1 backdrop-blur-sm',
                dense ? 'h-11 w-11' : 'h-14 w-14',
                ACCENT_ICON_CLASS[accent]
              )}
            >
              <Icon className={dense ? 'h-5 w-5' : 'h-6 w-6'} strokeWidth={1.9} />
            </div>
          ) : null)}

        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className={cn('type-eyebrow mb-2', ACCENT_EYEBROW_CLASS[accent])}>{eyebrow}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1
              className={cn(
                'type-display text-foreground',
                dense ? 'text-display-sm' : 'text-display'
              )}
            >
              {title}
            </h1>
            {badges}
          </div>
          {description && (
            <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>

        {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
    </div>
  )
}
