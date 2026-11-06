import { useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw, Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatLastUsed } from '@/components/credential-card'
import { useDeleteQoderAccount, useRefreshQoderAccount, useSetQoderAccountDisabled } from '@/hooks/use-credentials'
import { cn, extractErrorMessage } from '@/lib/utils'
import type { QoderAccount, QoderQuota, QoderQuotaPart } from '@/types/api'

/** 与其它卡片一致：剩余低于 20% 标红，低于 50% 标黄 */
const CRITICAL_REMAINING_FRACTION = 0.2
const WARNING_REMAINING_FRACTION = 0.5

/** 上游没标单位时按 Qoder 的计费单位显示 */
const DEFAULT_CREDIT_UNIT = 'credits'

const agoFromMs = (ms: number | null) => formatLastUsed(ms ? new Date(ms).toISOString() : null)

const isNum = (v: unknown): v is number => typeof v === 'number'

export const formatCredits = (n: number) => Math.round(n).toLocaleString()

/** 账号额度里任一资源包标的单位，用来给累计消耗配单位 */
export const quotaUnit = (quota: QoderQuota | null | undefined) =>
  quota?.orgResourcePackage?.unit ?? quota?.userQuota?.unit ?? quota?.addOnQuota?.unit ?? DEFAULT_CREDIT_UNIT

/** 剩余比例：优先 remaining/total，其次 remaining/(used+remaining)（企业包没有 total），最后 1 - percentage（上游 percentage 为 0~1） */
const remainingFraction = (part: QoderQuotaPart | undefined): number | null => {
  if (!part) return null
  if (isNum(part.total) && part.total > 0 && isNum(part.remaining)) return part.remaining / part.total
  if (isNum(part.used) && isNum(part.remaining) && part.used + part.remaining > 0) return part.remaining / (part.used + part.remaining)
  if (isNum(part.percentage)) return 1 - part.percentage
  return null
}

/** 右侧数字：有 total 显示「剩余 / 总量」，只有 used 显示「已用 · 剩余」，否则显示百分比 */
const quotaText = (part: QoderQuotaPart, fraction: number) => {
  const unit = part.unit ? ` ${part.unit}` : ''
  if (isNum(part.remaining) && isNum(part.total)) return `${formatCredits(part.remaining)} / ${formatCredits(part.total)}${unit}`
  if (isNum(part.remaining) && isNum(part.used)) return `已用 ${formatCredits(part.used)} · 剩余 ${formatCredits(part.remaining)}${unit}`
  return `${Math.round(fraction * 100)}%`
}

function QuotaRow({ label, part }: { label: string; part: QoderQuotaPart | undefined }) {
  const raw = remainingFraction(part)
  if (raw === null || !part) return null
  const fraction = Math.min(Math.max(raw, 0), 1)
  const tone = fraction <= CRITICAL_REMAINING_FRACTION ? 'usage-fill--critical' : fraction <= WARNING_REMAINING_FRACTION ? 'usage-fill--warning' : ''
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-semibold text-muted-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{quotaText(part, fraction)}</span>
      </div>
      <div className="usage-track mt-1" role="progressbar" aria-label={`${label}剩余额度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        {fraction > 0 && <div className={cn('usage-fill', tone)} style={{ width: `${fraction * 100}%` }} />}
      </div>
    </div>
  )
}

export function QoderAccountCard({ account }: { account: QoderAccount }) {
  const refresh = useRefreshQoderAccount()
  const setDisabled = useSetQoderAccountDisabled()
  const remove = useDeleteQoderAccount()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const title = account.name || account.email || account.uid
  const exceeded = account.quota?.isQuotaExceeded === true

  return (
    <Card className={cn('credential-card space-y-3 p-4', account.disabled && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold" title={title}>{title}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground" title={account.email ?? undefined}>
            {account.email ?? `uid ${account.uid}`} · PAT …{account.patTail}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {account.userType && <Badge variant="secondary" className="text-[11px]">{account.userType}</Badge>}
            {account.orgName && <Badge variant="outline" className="text-[11px]">{account.orgName}</Badge>}
            {exceeded && <Badge variant="destructive" className="text-[11px]">额度已用尽</Badge>}
          </div>
        </div>
        <Switch
          checked={!account.disabled}
          disabled={setDisabled.isPending}
          aria-label={account.disabled ? '启用账号' : '禁用账号'}
          onCheckedChange={(on) => setDisabled.mutate({ id: account.id, disabled: !on }, {
            onError: (e) => toast.error(`操作失败：${extractErrorMessage(e)}`),
          })}
        />
      </div>

      <div className="space-y-2">
        <QuotaRow label="套餐额度" part={account.quota?.userQuota} />
        <QuotaRow label="加购额度" part={account.quota?.addOnQuota} />
        <QuotaRow label="组织资源包" part={account.quota?.orgResourcePackage} />
        {!account.quota && <p className="text-xs text-muted-foreground">还没有额度数据，点「刷新」拉取</p>}
      </div>

      {account.lastError && (
        <p className="break-words rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive" role="alert">{account.lastError}</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
        <span>成功 {account.successCount} · 失败 {account.failureCount} · 最近使用 {agoFromMs(account.lastUsedMs)}</span>
        <span title="反代按额度刷新时的已用增量累加，额度周期重置也不清零">
          累计消耗 <strong className="font-semibold text-foreground">{formatCredits(account.consumedTotal)}</strong> {quotaUnit(account.quota)}
        </span>
        <span>额度更新 {agoFromMs(account.quotaUpdatedMs)}</span>
      </div>

      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="h-8 flex-1 text-xs" disabled={refresh.isPending}
          onClick={() => refresh.mutate(account.id, {
            onSuccess: () => toast.success(`${title} 已刷新`),
            onError: (e) => toast.error(`刷新失败：${extractErrorMessage(e)}`),
          })}>
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', refresh.isPending && 'animate-spin')} />刷新
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs text-destructive" onClick={() => setConfirmDelete(true)} aria-label={`删除 ${title}`}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除账号</DialogTitle>
            <DialogDescription>确定删除 {title}？PAT 与 token 会从账号库移除，需重新粘贴 PAT 才能恢复。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>取消</Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(account.id, {
              onSuccess: () => { setConfirmDelete(false); toast.success('已删除') },
              onError: (e) => toast.error(`删除失败：${extractErrorMessage(e)}`),
            })}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
