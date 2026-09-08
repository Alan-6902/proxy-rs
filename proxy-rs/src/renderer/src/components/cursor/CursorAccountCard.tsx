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
import { Badge, Button, Card, CardContent } from '../ui'
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
  /** 标签下方的补充行：金额、重置时间。 */
  sublines?: string[]
  /** 进度条填充比例；默认与 percent 相同。 */
  barPercent?: number | null
}

/** 一项用量：左标签 + 右大号彩色百分比，下面补充行与进度条，布局对齐 cockpit-tools。 */
function Metric({ label, percent, valueText, sublines, barPercent }: MetricProps): React.ReactNode {
  const fill = barPercent ?? percent
  const clamped = fill == null ? 0 : Math.min(100, Math.max(0, fill))
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          {sublines?.map((line) => (
            <p key={line} className="font-mono text-xs text-muted-foreground/80">
              {line}
            </p>
          ))}
        </div>
        <span
          className={cn(
            'shrink-0 text-lg font-semibold tabular-nums leading-6',
            valueText ? 'text-foreground' : usageTextClass(percent)
          )}
        >
          {valueText ?? (percent == null ? '—' : `${Math.round(percent)}%`)}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn('h-full rounded-full transition-all', usageBarClass(clamped))}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
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
    extras.push(`赠送用量 ${formatCursorUsageDollars(usage.bonusSpendCents)}`)
  }
  if (usage.totalSpendCents != null && usage.totalSpendCents > 0) {
    extras.push(`合计消耗 ${formatCursorUsageDollars(usage.totalSpendCents)}`)
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
      <CardContent className="space-y-4 p-5">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              aria-label={`选择 ${displayEmail}`}
              className="h-4 w-4 shrink-0 rounded"
            />
            <span className="min-w-0 flex-1 truncate text-base font-semibold" title={displayEmail}>
              {displayEmail}
            </span>
            <Badge
              variant="outline"
              className={cn(
                'shrink-0 rounded-lg px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide',
                PLAN_BADGE_CLASS[getCursorPlanTone(account)]
              )}
            >
              {getCursorPlanDisplayName(account)}
            </Badge>
          </div>

          <p className="truncate font-mono text-xs text-muted-foreground" title={account.authId}>
            Auth ID: {account.authId ?? '—'}
          </p>

          {(isCurrent || banned || account.tags.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {isCurrent && (
                <Badge variant="default" className="rounded-md px-2 py-0.5 text-2xs">
                  当前使用
                </Badge>
              )}
              {banned && (
                <Badge variant="destructive" className="rounded-md px-2 py-0.5 text-2xs">
                  已封禁
                </Badge>
              )}
              {account.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-foreground/8 px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {banned && account.statusReason && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-300">
              {account.statusReason}
            </p>
          )}
        </div>

        <div className="border-t border-border/50" />

        {hasUsage ? (
          <div className="space-y-4">
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
              <p className="text-xs text-muted-foreground">{extras.join(' · ')}</p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
            {account.quotaQueryLastError ? '用量拉取失败' : '还没拉过用量，点刷新试试'}
          </div>
        )}

        {account.quotaQueryLastError && (
          <p
            className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300"
            title={account.quotaQueryLastError}
          >
            <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="line-clamp-2 break-all">{account.quotaQueryLastError}</span>
          </p>
        )}

        <div className="border-t border-border/50" />

        <div className="flex items-center justify-between gap-2">
          <span
            className="whitespace-nowrap rounded-md bg-foreground/5 px-2 py-1 font-mono text-xs text-muted-foreground"
            title={`最近使用 ${formatCompactDateTime(account.lastUsed)} · 用量更新 ${formatCompactDateTime(account.usageUpdatedAt)}`}
          >
            {formatCompactDateTime(account.lastUsed)}
          </span>
          {/* 与 cockpit-tools 一样只放 5 个：切换 / 标签 / 刷新 / 导出 / 删除；复制 token 在导出弹窗里 */}
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant={isCurrent ? 'outline' : 'default'}
              className="h-8 w-8"
              onClick={onInject}
              disabled={injecting || banned}
              title={
                banned
                  ? '已封禁的账号不能切换'
                  : isCurrent
                    ? '本机 Cursor 已经在用这个号，可重新写入一次'
                    : '切换：把这个号写进本机 Cursor 的登录态'
              }
            >
              {injecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8"
              onClick={onEditTags}
              title="编辑标签"
            >
              <Tag className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8"
              onClick={onRefresh}
              disabled={refreshing}
              title="刷新套餐与用量"
            >
              {refreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCw className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8"
              onClick={onExport}
              title="导出这个账号（弹窗里可复制 token）"
            >
              <Download className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8 text-red-600 hover:text-red-600 dark:text-red-400"
              onClick={onDelete}
              title="删除账号"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
