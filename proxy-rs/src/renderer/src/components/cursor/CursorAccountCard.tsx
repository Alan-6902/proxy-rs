import {
  CircleAlert,
  Clock3,
  Download,
  Loader2,
  Play,
  RotateCw,
  Tag,
  Timer,
  Trash2
} from 'lucide-react'
import {
  formatCursorUsageDollars,
  getCursorAccountDisplayEmail,
  getCursorBotUsage,
  getCursorOnDemandSummary,
  getCursorPlanDisplayName,
  getCursorPlanTone,
  getCursorUsage,
  hasCursorQuotaData,
  isCursorAccountBanned,
  type CursorAccount
} from '../../../../shared/cursorAccounts'
import { Card, CardContent } from '../ui'
import { cn } from '@/lib/utils'
import {
  PLAN_BADGE_CLASS,
  daysUntil,
  formatCompactDateTime,
  formatShortDate,
  formatShortDateTime,
  percentText,
  resetCountdownLabel,
  usageBarClass,
  usageTextClass
} from './_helpers'

interface UsageBarProps {
  percent: number | null
  /** 传高度（h-1 / h-2）与外边距；轨道颜色和圆角统一在这里。 */
  className?: string
}

function UsageBar({ percent, className }: UsageBarProps): React.ReactNode {
  const clamped = percent == null ? 0 : Math.min(100, Math.max(0, percent))
  return (
    <div className={cn('w-full overflow-hidden rounded-full bg-foreground/10', className)}>
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-500 ease-out',
          usageBarClass(clamped)
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

interface LedgerRowProps {
  label: string
  percent: number | null
  /** 标签后的弱化补充（如 Bot 的重置倒计时）。 */
  hint?: React.ReactNode
  title?: string
}

/**
 * 次级额度的一行：标签 | 细进度条 | 百分比。
 * 三个单元格直接挂在父级三列网格上（display: contents），所有行的条与数字才会纵向对齐成表。
 */
function LedgerRow({ label, percent, hint, title }: LedgerRowProps): React.ReactNode {
  return (
    <div className="contents" title={title}>
      <span className="flex items-center gap-1 whitespace-nowrap text-2xs text-muted-foreground">
        {label}
        {hint}
      </span>
      <UsageBar percent={percent} className="h-1" />
      <span
        className={cn(
          'min-w-[2.5rem] text-right text-2xs font-semibold tabular-nums',
          usageTextClass(percent)
        )}
      >
        {percentText(percent)}
      </span>
    </div>
  )
}

interface IconActionProps {
  icon: React.ElementType
  title: string
  onClick: () => void
  disabled?: boolean
  busy?: boolean
  danger?: boolean
}

/** 底栏的方形图标按钮，尺寸与 Kiro 卡片的操作图标一致。 */
function IconAction({
  icon: Icon,
  title,
  onClick,
  disabled,
  busy,
  danger
}: IconActionProps): React.ReactNode {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled || busy}
      onClick={onClick}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md border border-foreground/10 bg-foreground/[0.06] text-muted-foreground transition-colors',
        'hover:bg-foreground/[0.12] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        'disabled:cursor-not-allowed disabled:opacity-40',
        danger && 'hover:text-destructive'
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
    </button>
  )
}

export interface CursorAccountCardProps {
  account: CursorAccount
  isCurrent: boolean
  selected: boolean
  refreshing: boolean
  injecting: boolean
  onToggleSelect: () => void
  onInject: () => void
  onRefresh: () => void
  onEditTags: () => void
  onExport: () => void
  onDelete: () => void
}

interface MoneyItem {
  label: string
  value: string
  className?: string
}

/**
 * 卡片自上而下四层，视觉权重递减：
 * 1. 标题：邮箱 + 套餐徽标，下面一行状态药丸（当前使用 / 封禁）与用户自己打的标签
 * 2. 主指标面板：套餐额度的大百分比、金额、重置倒计时、粗进度条——整卡唯一的大数字
 * 3. 次级台账：Auto+Composer / API / Bot 三列对齐的细条，可纵向扫读
 * 4. 金额一行：按需 / 赠送 / 合计 / Credit，等宽小字
 * 底栏固定在最下：最近使用时间 + 操作图标。
 */
export function CursorAccountCard({
  account,
  isCurrent,
  selected,
  refreshing,
  injecting,
  onToggleSelect,
  onInject,
  onRefresh,
  onEditTags,
  onExport,
  onDelete
}: CursorAccountCardProps): React.ReactNode {
  const banned = isCursorAccountBanned(account)
  const usage = getCursorUsage(account)
  const onDemand = getCursorOnDemandSummary(usage)
  const botUsage = getCursorBotUsage(account)
  const hasUsage = hasCursorQuotaData(account)
  const displayEmail = getCursorAccountDisplayEmail(account)
  // Auth ID（auth0|user_xxx / grok|user_xxx）只进 tooltip：单独摆出来会被当成标签
  const emailTitle = account.authId ? `${displayEmail}\nAuth ID: ${account.authId}` : displayEmail

  // 套餐内已用优先取 breakdown.included；Ultra 用满后 used 会停在 limit
  const includedCents = usage.includedSpendCents ?? usage.planUsedCents
  const planAmount =
    includedCents != null && usage.planLimitCents != null
      ? `${formatCursorUsageDollars(includedCents)} / ${formatCursorUsageDollars(usage.planLimitCents)}`
      : null

  // 有固定上限的按需额度是「百分比型」配额，进台账画条；禁用 / 无上限只是状态，放金额行
  const onDemandPercent =
    onDemand.hasFixedLimit && onDemand.limitCents
      ? (onDemand.usedCents / onDemand.limitCents) * 100
      : null
  const onDemandLabel = onDemand.isTeamLimit ? '团队按需' : '按需'
  const onDemandUsed = formatCursorUsageDollars(onDemand.usedCents)
  const onDemandItem: MoneyItem = onDemand.isDisabled
    ? {
        label: onDemandLabel,
        value: onDemand.usedCents > 0 ? `${onDemandUsed} · 已禁用` : '已禁用',
        className: 'text-muted-foreground'
      }
    : onDemand.isUnlimited
      ? { label: onDemandLabel, value: `${onDemandUsed} · 无上限` }
      : {
          label: onDemandLabel,
          value: `${onDemandUsed}/${formatCursorUsageDollars(onDemand.limitCents ?? 0)}`,
          className: usageTextClass(onDemandPercent)
        }

  const hasLedger =
    usage.autoPercentUsed != null ||
    usage.apiPercentUsed != null ||
    botUsage?.hasLimit === true ||
    onDemandPercent != null

  const money: MoneyItem[] = [onDemandItem]
  if (usage.bonusSpendCents != null && usage.bonusSpendCents > 0) {
    money.push({ label: '赠送', value: formatCursorUsageDollars(usage.bonusSpendCents) })
  }
  if (usage.totalSpendCents != null && usage.totalSpendCents > 0) {
    money.push({ label: '合计', value: formatCursorUsageDollars(usage.totalSpendCents) })
  }
  if (account.creditBalanceCents != null && account.creditBalanceCents > 0) {
    money.push({ label: 'Credit', value: formatCursorUsageDollars(account.creditBalanceCents) })
  }

  const showMetaRow = isCurrent || banned || account.tags.length > 0

  return (
    <Card
      className={cn(
        'relative flex h-full flex-col overflow-hidden bg-solid-card',
        isCurrent && 'border-transparent active-glow-border',
        banned && 'border-destructive/50'
      )}
    >
      {/* 多选态覆盖层：浮在内容之上、不拦事件，避免与流光边框 / 封禁边框互相覆盖 */}
      {selected && (
        <div className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] bg-primary/[0.06] ring-2 ring-inset ring-primary/60" />
      )}

      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              aria-label={`选择 ${displayEmail}`}
              className="h-4 w-4 shrink-0 rounded accent-primary"
            />
            <span className="type-title min-w-0 flex-1 truncate text-sm" title={emailTitle}>
              {displayEmail}
            </span>
            <span
              className={cn(
                'shrink-0 rounded-md px-2 py-0.5 text-2xs font-bold uppercase tracking-wide',
                PLAN_BADGE_CLASS[getCursorPlanTone(account)]
              )}
            >
              {getCursorPlanDisplayName(account)}
            </span>
          </div>

          {showMetaRow && (
            <div className="flex flex-wrap items-center gap-1 pl-6">
              {isCurrent && (
                <span className="rounded-full bg-primary/15 px-2 py-px text-2xs font-medium text-primary">
                  当前使用
                </span>
              )}
              {banned && (
                <span className="rounded-full bg-destructive/12 px-2 py-px text-2xs font-medium text-destructive">
                  已封禁
                </span>
              )}
              {account.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-foreground/[0.07] px-2 py-px text-2xs text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {banned && account.statusReason && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-2xs text-red-600 dark:text-red-300">
              {account.statusReason}
            </p>
          )}
        </div>

        {hasUsage ? (
          <>
            <div className="rounded-xl border border-border/50 bg-muted/30 px-3 pb-3 pt-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="type-eyebrow">套餐额度</span>
                {usage.allowanceResetAt != null && (
                  <span
                    className="shrink-0 text-2xs text-muted-foreground tabular-nums"
                    title={`重置时间 ${formatCompactDateTime(usage.allowanceResetAt)}`}
                  >
                    {resetCountdownLabel(usage.allowanceResetAt)}
                    <span className="text-muted-foreground/60">
                      {' · '}
                      {formatShortDate(usage.allowanceResetAt)}
                    </span>
                  </span>
                )}
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-2">
                <span
                  className={cn(
                    'type-metric text-display-sm',
                    usageTextClass(usage.planUsedPercent)
                  )}
                >
                  {percentText(usage.planUsedPercent)}
                </span>
                {planAmount && (
                  <span className="truncate font-mono text-2xs text-muted-foreground tabular-nums">
                    {planAmount}
                  </span>
                )}
              </div>
              <UsageBar percent={usage.planUsedPercent} className="mt-2 h-2" />
            </div>

            {hasLedger && (
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1.5 px-1">
                {usage.autoPercentUsed != null && (
                  <LedgerRow label="Auto + Composer" percent={usage.autoPercentUsed} />
                )}
                {usage.apiPercentUsed != null && (
                  <LedgerRow label="API" percent={usage.apiPercentUsed} />
                )}
                {botUsage?.hasLimit && (
                  <LedgerRow
                    label="Bot（周）"
                    percent={botUsage.usedPercent}
                    hint={
                      botUsage.nextResetAt != null && (
                        <span className="inline-flex items-center gap-0.5 text-3xs text-muted-foreground/70">
                          <Timer className="h-2.5 w-2.5" />
                          {daysUntil(botUsage.nextResetAt)} 天
                        </span>
                      )
                    }
                    title={[
                      botUsage.planLabel,
                      botUsage.nextResetAt != null
                        ? `重置时间 ${formatCompactDateTime(botUsage.nextResetAt)}`
                        : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                )}
                {onDemandPercent != null && (
                  <LedgerRow
                    label={onDemandLabel}
                    percent={onDemandPercent}
                    title={`${onDemandLabel} ${onDemandItem.value}`}
                  />
                )}
              </div>
            )}

            {/* 两列固定网格：四项时折成整齐的 2×2，而不是 flex-wrap 留下一个孤儿 */}
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 px-1 font-mono text-2xs tabular-nums">
              {money.map((item) => (
                <span key={item.label} className="truncate" title={`${item.label} ${item.value}`}>
                  <span className="text-muted-foreground">{item.label} </span>
                  <span className={cn('text-foreground/85', item.className)}>{item.value}</span>
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-border/60 px-3 py-5 text-center text-xs text-muted-foreground">
            {account.quotaQueryLastError ? '用量拉取失败' : '还没拉过用量，点刷新试试'}
          </div>
        )}

        {account.quotaQueryLastError && (
          <p
            className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-2xs text-amber-700 dark:text-amber-300"
            title={account.quotaQueryLastError}
          >
            <CircleAlert className="mt-px h-3 w-3 shrink-0" />
            <span className="line-clamp-2 break-all">{account.quotaQueryLastError}</span>
          </p>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/50 pt-2.5">
          <span
            className="flex min-w-0 items-center gap-1 font-mono text-2xs text-muted-foreground tabular-nums"
            title={`最近使用 ${formatCompactDateTime(account.lastUsed)} · 用量更新 ${formatCompactDateTime(account.usageUpdatedAt)}`}
          >
            <Clock3 className="h-3 w-3 shrink-0" />
            <span className="truncate">{formatShortDateTime(account.lastUsed)}</span>
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <IconAction
              icon={Play}
              title={
                banned
                  ? '已封禁的账号不能切换'
                  : isCurrent
                    ? '本机 Cursor 已经在用这个号，可重新写入一次'
                    : '切换：把这个号写进本机 Cursor 的登录态'
              }
              onClick={onInject}
              disabled={banned}
              busy={injecting}
            />
            <IconAction icon={Tag} title="编辑标签" onClick={onEditTags} />
            <IconAction
              icon={RotateCw}
              title="刷新套餐与用量"
              onClick={onRefresh}
              busy={refreshing}
            />
            <IconAction
              icon={Download}
              title="导出这个账号（弹窗里可复制 token）"
              onClick={onExport}
            />
            <IconAction icon={Trash2} title="删除账号" onClick={onDelete} danger />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
