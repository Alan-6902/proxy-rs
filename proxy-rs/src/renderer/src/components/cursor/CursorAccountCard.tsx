import { useState } from 'react'
import {
  Check,
  CircleAlert,
  Copy,
  Download,
  Loader2,
  Play,
  RotateCw,
  Tag,
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
import { Badge, Button, Card, CardContent } from '../ui'
import { cn } from '@/lib/utils'
import {
  PLAN_TONE_CLASS,
  daysUntil,
  formatDate,
  formatPercent,
  formatRelativeTime,
  usageBarClass
} from './_helpers'

interface UsageBarProps {
  label: string
  percent: number | null
  detail?: string
}

function UsageBar({ label, percent, detail }: UsageBarProps): React.ReactNode {
  const clamped = percent == null ? 0 : Math.min(100, Math.max(0, percent))
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {formatPercent(percent)}
          {detail && <span className="ml-1.5 text-muted-foreground">{detail}</span>}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
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
  const [copied, setCopied] = useState(false)
  const banned = isCursorAccountBanned(account)
  const usage = getCursorUsage(account)
  const onDemand = getCursorOnDemandSummary(usage)
  const botUsage = getCursorBotUsage(account)
  const planTone = getCursorPlanTone(account)
  const hasUsage = hasCursorQuotaData(account)
  const displayEmail = getCursorAccountDisplayEmail(account)

  // 套餐内已用优先取 breakdown.included；Ultra 用满后 used 会停在 limit，赠送部分另起一行
  const includedCents = usage.includedSpendCents ?? usage.planUsedCents
  const planCost =
    includedCents != null && usage.planLimitCents != null
      ? `${formatCursorUsageDollars(includedCents)} / ${formatCursorUsageDollars(usage.planLimitCents)}`
      : undefined
  const hasBonus = usage.bonusSpendCents != null && usage.bonusSpendCents > 0
  // 与 xbar 一致：查到余额就显示（含 $0.00）；没查过或查失败才不占行
  const creditCents = account.creditBalanceCents
  const creditKnown = creditCents != null
  const creditPositive = creditCents != null && creditCents > 0

  const onDemandText = onDemand.isDisabled
    ? onDemand.usedCents > 0
      ? formatCursorUsageDollars(onDemand.usedCents)
      : '未开启'
    : onDemand.isUnlimited
      ? `${formatCursorUsageDollars(onDemand.usedCents)} · 无上限`
      : `${formatCursorUsageDollars(onDemand.usedCents)} / ${formatCursorUsageDollars(onDemand.limitCents)}`

  const copyToken = async (): Promise<void> => {
    await navigator.clipboard.writeText(account.accessToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
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
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`选择 ${displayEmail}`}
            className="mt-1 h-4 w-4 shrink-0 rounded"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-medium" title={displayEmail}>
                {displayEmail}
              </span>
              <Badge
                variant="outline"
                className={cn('px-1.5 py-0 text-[10px]', PLAN_TONE_CLASS[planTone])}
              >
                {getCursorPlanDisplayName(account)}
              </Badge>
              {isCurrent && (
                <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                  当前使用
                </Badge>
              )}
              {banned && (
                <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                  已封禁
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {[
                account.signUpType,
                account.subscriptionStatus,
                account.tags.length > 0 ? account.tags.join(' / ') : undefined
              ]
                .filter(Boolean)
                .join(' · ') || '—'}
            </p>
          </div>
        </div>

        {banned && account.statusReason && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-300">
            {account.statusReason}
          </p>
        )}

        {hasUsage ? (
          <div className="space-y-2">
            <UsageBar label="套餐用量" percent={usage.planUsedPercent} detail={planCost} />
            {usage.autoPercentUsed != null && (
              <UsageBar label="Auto" percent={usage.autoPercentUsed} />
            )}
            {usage.apiPercentUsed != null && (
              <UsageBar label="API" percent={usage.apiPercentUsed} />
            )}
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                按需{onDemand.isTeamLimit ? '（团队）' : ''}
              </span>
              <span className="tabular-nums">{onDemandText}</span>
            </div>
            {hasBonus && (
              <div
                className="flex items-center justify-between text-xs"
                title="官方与模型厂商合作赠送的、超出所购套餐之外的免费用量，数额不固定"
              >
                <span className="text-muted-foreground">赠送用量</span>
                <span className="tabular-nums">
                  {formatCursorUsageDollars(usage.bonusSpendCents)}
                  {usage.totalSpendCents != null && (
                    <span className="ml-1.5 text-muted-foreground">
                      合计 {formatCursorUsageDollars(usage.totalSpendCents)}
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/60 px-2.5 py-2 text-xs text-muted-foreground">
            {account.quotaQueryLastError ? '用量拉取失败' : '还没拉过用量，点刷新试试'}
          </div>
        )}

        {/* Bot 周额度走另一条接口，与主用量各自独立展示；套餐不含 Bot 额度时不占位 */}
        {botUsage?.hasLimit && (
          <UsageBar
            label={`${botUsage.planLabel ?? 'Grok Bot'}（周）`}
            percent={botUsage.usedPercent}
            detail={
              botUsage.nextResetAt
                ? `重置 ${formatDate(botUsage.nextResetAt)}（${daysUntil(botUsage.nextResetAt)} 天）`
                : undefined
            }
          />
        )}

        {creditKnown && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Credit 余额</span>
            <span
              className={cn(
                'tabular-nums',
                creditPositive
                  ? 'font-medium text-emerald-600 dark:text-emerald-400'
                  : 'text-muted-foreground'
              )}
            >
              {formatCursorUsageDollars(account.creditBalanceCents)}
            </span>
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

        <p className="text-2xs text-muted-foreground">
          {usage.allowanceResetAt
            ? `重置 ${formatDate(usage.allowanceResetAt)}（${daysUntil(usage.allowanceResetAt)} 天） · `
            : ''}
          用量更新 {formatRelativeTime(account.usageUpdatedAt)} · 最近使用{' '}
          {formatRelativeTime(account.lastUsed)}
        </p>

        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant={isCurrent ? 'outline' : 'default'}
            onClick={onInject}
            disabled={injecting || banned}
            title={
              banned
                ? '已封禁的账号不能切换'
                : isCurrent
                  ? '本机 Cursor 已经在用这个号，可重新写入一次'
                  : '把这个号写进本机 Cursor 的登录态'
            }
          >
            {injecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {isCurrent ? '重新写入' : '切换'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRefresh}
            disabled={refreshing}
            title="刷新套餐与用量"
          >
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4" />
            )}
            刷新
          </Button>
          <Button size="sm" variant="ghost" onClick={onEditTags} title="编辑标签">
            <Tag className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copyToken()}
            title="复制 access token"
          >
            {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={onExport} title="导出这个账号">
            <Download className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            className="text-red-600 hover:text-red-600 dark:text-red-400"
            title="删除账号"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
