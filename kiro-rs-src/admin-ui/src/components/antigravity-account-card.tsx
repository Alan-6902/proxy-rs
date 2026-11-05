import { useState } from 'react'
import { toast } from 'sonner'
import { CircleHelp, Crown, GripVertical, Leaf, RefreshCw, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatLastUsed } from '@/components/credential-card'
import {
  useDeleteAgAccount,
  useRefreshAgAccount,
  useResetAgAccountFailures,
  useSetAgAccountDisabled,
} from '@/hooks/use-credentials'
import { cn, extractErrorMessage } from '@/lib/utils'
import type { AgAccount } from '@/types/api'
import { quotaRows, type QuotaRow } from '@/lib/antigravity-quota'

/** 与 Kiro 卡片一致：剩余低于 20% 标红，低于 50% 标黄 */
const CRITICAL_REMAINING_FRACTION = 0.2
const WARNING_REMAINING_FRACTION = 0.5

const fillTone = (fraction: number) =>
  fraction <= CRITICAL_REMAINING_FRACTION ? 'usage-fill--critical' : fraction <= WARNING_REMAINING_FRACTION ? 'usage-fill--warning' : ''

const textTone = (fraction: number) =>
  fraction <= CRITICAL_REMAINING_FRACTION
    ? 'text-destructive'
    : fraction <= WARNING_REMAINING_FRACTION
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-emerald-600 dark:text-emerald-400'

const pad2 = (n: number) => String(n).padStart(2, '0')

const agoFromMs = (ms: number | null) => formatLastUsed(ms ? new Date(ms).toISOString() : null)

/** 「4h 43m (11/03 23:04)」：距重置的剩余时长 + 重置时刻 */
const formatReset = (value: string) => {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null
  const mins = Math.max(0, Math.round((at.getTime() - Date.now()) / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const left = d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`
  return `${left} (${pad2(at.getMonth() + 1)}/${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())})`
}

function QuotaBar({ row }: { row: QuotaRow }) {
  const fraction = row.fraction === null ? null : Math.min(Math.max(row.fraction, 0), 1)
  const reset = row.resetTime && fraction !== null && fraction < 1 ? formatReset(row.resetTime) : null
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px] font-semibold text-muted-foreground" title={row.label}>{row.label}</span>
        <strong className={cn('shrink-0 text-xs tabular-nums', fraction === null ? 'text-muted-foreground' : textTone(fraction))}>
          {fraction === null ? '—' : `${Math.round(fraction * 100)}%`}
        </strong>
      </div>
      <div
        className="usage-track mt-1"
        role="progressbar"
        aria-label={`${row.label} 剩余额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      >
        {fraction !== null && fraction > 0 && (
          <div className={cn('usage-fill', fillTone(fraction))} style={{ width: `${fraction * 100}%` }} />
        )}
      </div>
      <div className="mt-0.5 h-3.5 truncate text-[10px] tabular-nums text-muted-foreground">{reset}</div>
    </div>
  )
}

/** 用完整订阅名称配合彩色图标；未知套餐保留上游原名。 */
function SubscriptionBadge({ tier }: { tier: string | null }) {
  const name = tier?.trim() || '未知订阅'
  const key = name.toLowerCase()
  const isUltra = key.includes('ultra')
  const isPro = !isUltra && /\bpro\b|premium/.test(key)
  const isFree = /free|免费/.test(key)
  const Icon = isUltra ? Crown : isPro ? Sparkles : isFree ? Leaf : CircleHelp
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1.5 rounded-full whitespace-normal',
        isUltra ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
          : isPro ? 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300'
            : isFree ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'text-muted-foreground',
      )}
      title={name}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{name}</span>
    </Badge>
  )
}

export interface DragHandlers {
  dragging: boolean
  onDragStart: () => void
  onDragOver: () => void
  onDragEnd: () => void
  /** 键盘排序：-1 前移，1 后移 */
  onMove: (step: -1 | 1) => void
}

interface AntigravityAccountCardProps {
  account: AgAccount
  isCurrent: boolean
  drag: DragHandlers
}

export function AntigravityAccountCard({ account, isCurrent, drag }: AntigravityAccountCardProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const refresh = useRefreshAgAccount()
  const setDisabled = useSetAgAccountDisabled()
  const resetFailures = useResetAgAccountFailures()
  const remove = useDeleteAgAccount()
  const rows = quotaRows(account)

  const handleRefresh = () => {
    refresh.mutate(account.id, {
      onSuccess: () => toast.success(`${account.email} 已刷新`),
      onError: (e) => toast.error(`刷新失败：${extractErrorMessage(e)}`),
    })
  }

  const handleReset = () => {
    resetFailures.mutate(account.id, {
      onSuccess: (res) => toast.success(res.message),
      onError: (e) => toast.error(`操作失败：${extractErrorMessage(e)}`),
    })
  }

  const handleToggle = () => {
    setDisabled.mutate(
      { id: account.id, disabled: !account.disabled },
      { onError: (e) => toast.error(`操作失败：${extractErrorMessage(e)}`) },
    )
  }

  const handleDelete = () => {
    remove.mutate(account.id, {
      onSuccess: () => {
        toast.success(`已删除 ${account.email}`)
        setShowDeleteDialog(false)
      },
      onError: (e) => toast.error(`删除失败：${extractErrorMessage(e)}`),
    })
  }

  const hasFailures = account.failureCount > 0 || account.refreshFailureCount > 0

  return (
    <>
      <Card
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          drag.onDragStart()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          drag.onDragOver()
        }}
        onDrop={(e) => e.preventDefault()}
        onDragEnd={drag.onDragEnd}
        className={cn(
          'credential-card ag-card',
          isCurrent && 'credential-card--current',
          account.disabled && 'credential-card--disabled',
          drag.dragging && 'opacity-40',
        )}
      >
        <div className="credential-row ag-row">
          <section className="credential-row__identity">
            <button
              type="button"
              className="mt-0.5 shrink-0 cursor-grab rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
              aria-label={`拖动排序 ${account.email}，也可用方向键移动`}
              title="拖动排序"
              onKeyDown={(e) => {
                const step = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0
                if (step === 0) return
                e.preventDefault()
                drag.onMove(step)
              }}
            >
              <GripVertical className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <SubscriptionBadge tier={account.tier} />
                {isCurrent && <Badge variant="success" className="rounded-full" title="最近一次请求用的账号">最近使用</Badge>}
                {account.disabled && <Badge variant="destructive" className="rounded-full">已禁用</Badge>}
              </div>
              <h2 className="mt-1.5 truncate text-[15px] font-semibold tracking-tight" title={account.email}>{account.email}</h2>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="rounded-full font-semibold">Google</Badge>
                {account.name && <Badge variant="outline" className="max-w-[10rem] rounded-full"><span className="truncate">{account.name}</span></Badge>}
              </div>
            </div>
          </section>

          <section className="credential-row__facts" aria-label="账号状态信息">
            <div className="credential-facts__primary ag-facts__primary">
              <div className="credential-fact"><span>成功</span><strong>{account.successCount}</strong></div>
              <div className={cn('credential-fact', account.failureCount > 0 && 'credential-fact--danger')}><span>失败</span><strong>{account.failureCount}</strong></div>
              <div className={cn('credential-fact', account.refreshFailureCount > 0 && 'credential-fact--danger')}><span>刷新失败</span><strong>{account.refreshFailureCount}</strong></div>
            </div>
            <div className="credential-facts__secondary">
              <span title={account.projectId ?? undefined}>项目 <strong className="text-foreground">{account.projectId ?? '未获取'}</strong></span>
              <span>最后调用 <strong className="text-foreground">{agoFromMs(account.lastUsedMs)}</strong></span>
              <span>额度更新 <strong className="text-foreground">{agoFromMs(account.quotaUpdatedMs)}</strong></span>
            </div>
            {account.lastError && (
              <div className="truncate text-[11px] text-destructive" title={account.lastError}>{account.lastError}</div>
            )}
          </section>

          <section className="ag-quota" aria-label="账号额度">
            {rows.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">暂无额度数据，点刷新拉取</div>
            ) : (
              rows.map((r) => <QuotaBar key={r.key} row={r} />)
            )}
          </section>

          <section className="credential-row__actions" aria-label="账号操作">
            <div className="credential-toggle">
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{account.disabled ? '停用' : '启用'}</span>
              <Switch checked={!account.disabled} onCheckedChange={handleToggle} disabled={setDisabled.isPending} aria-label={`${account.disabled ? '启用' : '停用'}账号 ${account.id}`} />
            </div>
            <div className="credential-action-buttons">
              <Button size="sm" variant="default" className="h-8 rounded-lg px-2.5 text-xs" onClick={handleRefresh} disabled={refresh.isPending}>
                <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', refresh.isPending && 'animate-spin')} />刷新额度
              </Button>
              {hasFailures && (
                <Button size="sm" variant="outline" className="h-8 rounded-lg px-2.5 text-xs" onClick={handleReset} disabled={resetFailures.isPending}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />重置失败
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-8 rounded-lg px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setShowDeleteDialog(true)} disabled={remove.isPending}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />删除
              </Button>
            </div>
          </section>
        </div>
      </Card>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 Antigravity 账号</DialogTitle>
            <DialogDescription>{`账号 #${account.id}（${account.email}）将从账号池删除，之后需要重新 Google 登录才能再用。`}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)} disabled={remove.isPending}>取消</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={remove.isPending}>{remove.isPending ? '删除中...' : '确认删除'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
