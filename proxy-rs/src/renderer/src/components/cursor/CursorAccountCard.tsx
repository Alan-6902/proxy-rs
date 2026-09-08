import { CircleAlert, Download, Loader2, Play, RotateCw, Tag, Trash2 } from 'lucide-react'
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
  usageBarClass,
  usageTextClass
} from './_helpers'

interface MetricProps {
  label: string
  /** 已用百分比；null 时右侧显示 `valueText` 而不是百分比。 */
  percent: number | null
  /** 覆盖右侧文字（如按需的「已禁用」/金额）。 */
  valueText?: string
  /** 标签下方的等宽小字：金额、重置时间，各占一行。 */
  sublines?: string[]
  /** 进度条填充比例；默认与 percent 相同。 */
  barPercent?: number | null
}

/**
 * 一项用量：左标签、右彩色百分比、等宽小字补充行、进度条。
 * 结构对齐 cockpit-tools 的账号卡，尺寸对齐本应用 Kiro 账户卡（text-xs / h-1.5）。
 */
function Metric({ label, percent, valueText, sublines, barPercent }: MetricProps): React.ReactNode {
  const fill = barPercent ?? percent
  const clamped = fill == null ? 0 : Math.min(100, Math.max(0, fill))
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
        <span
          className={cn(
            'shrink-0 text-sm font-semibold tabular-nums leading-none',
            valueText ? 'text-foreground' : usageTextClass(percent)
          )}
        >
          {valueText ?? (percent == null ? '—' : `${Math.round(percent)}%`)}
        </span>
      </div>
      {sublines?.map((line) => (
        <p key={line} className="truncate font-mono text-2xs text-muted-foreground">
          {line}
        </p>
      ))}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className={cn('h-full rounded-full transition-all duration-300', usageBarClass(clamped))}
          style={{ width: `${clamped}%` }}
        />
      </div>
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

  // 套餐内已用优先取 breakdown.included；Ultra 用满后 used 会停在 limit
  const includedCents = usage.includedSpendCents ?? usage.planUsedCents
  const totalSublines: string[] = []
  if (includedCents != null && usage.planLimitCents != null) {
    totalSublines.push(
      `${formatCursorUsageDollars(includedCents)} / ${formatCursorUsageDollars(usage.planLimitCents)}`
    )
  }
  if (usage.allowanceResetAt) {
    totalSublines.push(
      `重置: ${formatCompactDateTime(usage.allowanceResetAt)}（${daysUntil(usage.allowanceResetAt)} 天）`
    )
  }

  const onDemandText = onDemand.isDisabled
    ? onDemand.usedCents > 0
      ? formatCursorUsageDollars(onDemand.usedCents)
      : '已禁用'
    : onDemand.isUnlimited
      ? `${formatCursorUsageDollars(onDemand.usedCents)} · 无上限`
      : `${formatCursorUsageDollars(onDemand.usedCents)} / ${formatCursorUsageDollars(onDemand.limitCents)}`
  const onDemandBar =
    onDemand.hasFixedLimit && onDemand.limitCents
      ? (onDemand.usedCents / onDemand.limitCents) * 100
      : 0

  const extras: string[] = []
  if (usage.bonusSpendCents != null && usage.bonusSpendCents > 0) {
    extras.push(`赠送 ${formatCursorUsageDollars(usage.bonusSpendCents)}`)
  }
  if (usage.totalSpendCents != null && usage.totalSpendCents > 0) {
    extras.push(`合计 ${formatCursorUsageDollars(usage.totalSpendCents)}`)
  }
  if (account.creditBalanceCents != null) {
    extras.push(`Credit ${formatCursorUsageDollars(account.creditBalanceCents)}`)
  }

  return (
    <Card
      className={cn(
        'transition-shadow',
        isCurrent && 'ring-1 ring-primary/50',
        banned && 'opacity-80',
        selected && 'ring-2 ring-primary'
      )}
    >
      <CardContent className="flex flex-col gap-3 p-4">
        {/* 标题区：邮箱 + 套餐徽标；Auth ID；标签 */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              aria-label={`选择 ${displayEmail}`}
              className="h-3.5 w-3.5 shrink-0 rounded accent-primary"
            />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={displayEmail}>
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

          <p className="truncate font-mono text-2xs text-muted-foreground" title={account.authId}>
            Auth ID: {account.authId ?? '—'}
          </p>

          {(isCurrent || banned || account.tags.length > 0) && (
            <div className="flex flex-wrap items-center gap-1">
              {isCurrent && (
                <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-2xs font-medium text-primary">
                  当前使用
                </span>
              )}
              {banned && (
                <span className="rounded-md bg-red-500/15 px-1.5 py-0.5 text-2xs font-medium text-red-500">
                  已封禁
                </span>
              )}
              {account.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-foreground/10 px-1.5 py-0.5 text-2xs text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {banned && account.statusReason && (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-2xs text-red-600 dark:text-red-300">
              {account.statusReason}
            </p>
          )}
        </div>

        {/* 用量面板：与 Kiro 卡片同样的浅底小面板 */}
        {hasUsage ? (
          <div className="space-y-3 rounded-lg border border-border/50 bg-muted/30 p-3">
            <Metric label="Total Usage" percent={usage.planUsedPercent} sublines={totalSublines} />
            {usage.autoPercentUsed != null && (
              <Metric label="Auto + Composer" percent={usage.autoPercentUsed} />
            )}
            {usage.apiPercentUsed != null && (
              <Metric label="API Usage" percent={usage.apiPercentUsed} />
            )}
            {botUsage?.hasLimit && (
              <Metric
                label={`${botUsage.planLabel ?? 'Grok Bot'}（周）`}
                percent={botUsage.usedPercent}
                sublines={
                  botUsage.nextResetAt
                    ? [
                        `重置: ${formatCompactDateTime(botUsage.nextResetAt)}（${daysUntil(botUsage.nextResetAt)} 天）`
                      ]
                    : undefined
                }
              />
            )}
            <Metric
              label={`按需使用${onDemand.isTeamLimit ? '（团队）' : ''}`}
              percent={null}
              valueText={onDemandText}
              barPercent={onDemandBar}
            />
            {extras.length > 0 && (
              <p
                className="truncate pt-0.5 font-mono text-2xs text-muted-foreground"
                title={extras.join(' · ')}
              >
                {extras.join(' · ')}
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
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

        {/* 底栏：最近使用时间 + 五个图标按钮 */}
        <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-3">
          <span
            className="whitespace-nowrap rounded-md bg-foreground/[0.06] px-2 py-1 font-mono text-2xs text-muted-foreground"
            title={`最近使用 ${formatCompactDateTime(account.lastUsed)} · 用量更新 ${formatCompactDateTime(account.usageUpdatedAt)}`}
          >
            {formatCompactDateTime(account.lastUsed)}
          </span>
          <div className="flex items-center gap-1">
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
