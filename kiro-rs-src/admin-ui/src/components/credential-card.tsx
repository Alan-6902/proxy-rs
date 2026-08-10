import { useState, type MouseEvent } from 'react'
import { toast } from 'sonner'
import {
  Check,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  Wallet,
  X,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CredentialStatusItem, BalanceResponse } from '@/types/api'
import {
  useSetDisabled,
  useSetPriority,
  useResetFailure,
  useDeleteCredential,
  useForceRefreshToken,
} from '@/hooks/use-credentials'
import { cn } from '@/lib/utils'

const CRITICAL_REMAINING_PERCENTAGE = 20
const WARNING_REMAINING_PERCENTAGE = 50

interface CredentialCardProps {
  credential: CredentialStatusItem
  onViewBalance: (id: number) => void
  selected: boolean
  onToggleSelect: () => void
  balance: BalanceResponse | null
  loadingBalance: boolean
}

function formatLastUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return '从未使用'
  const date = new Date(lastUsedAt)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  if (diff < 0) return '刚刚'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

export function CredentialCard({
  credential,
  onViewBalance,
  selected,
  onToggleSelect,
  balance,
  loadingBalance,
}: CredentialCardProps) {
  const [editingPriority, setEditingPriority] = useState(false)
  const [priorityValue, setPriorityValue] = useState(String(credential.priority))
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  const setDisabled = useSetDisabled()
  const setPriority = useSetPriority()
  const resetFailure = useResetFailure()
  const deleteCredential = useDeleteCredential()
  const forceRefresh = useForceRefreshToken()

  const handleToggleDisabled = () => {
    setDisabled.mutate(
      { id: credential.id, disabled: !credential.disabled },
      {
        onSuccess: (res) => {
          toast.success(res.message)
        },
        onError: (err) => {
          toast.error('操作失败: ' + (err as Error).message)
        },
      }
    )
  }

  const handlePriorityChange = () => {
    const newPriority = parseInt(priorityValue, 10)
    if (isNaN(newPriority) || newPriority < 0) {
      toast.error('优先级必须是非负整数')
      return
    }
    setPriority.mutate(
      { id: credential.id, priority: newPriority },
      {
        onSuccess: (res) => {
          toast.success(res.message)
          setEditingPriority(false)
        },
        onError: (err) => {
          toast.error('操作失败: ' + (err as Error).message)
        },
      }
    )
  }

  const handleReset = () => {
    resetFailure.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
      },
      onError: (err) => {
        toast.error('操作失败: ' + (err as Error).message)
      },
    })
  }

  const handleForceRefresh = () => {
    forceRefresh.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
      },
      onError: (err) => {
        toast.error('刷新失败: ' + (err as Error).message)
      },
    })
  }

  const handleDelete = () => {
    deleteCredential.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
        setShowDeleteDialog(false)
      },
      onError: (err) => {
        toast.error('删除失败: ' + (err as Error).message)
      },
    })
  }

  /*
   * 后端只允许删除已禁用的凭据，所以启用中的凭据要先禁用再删。
   * 这一步由界面代劳，而不是把删除按钮置灰让用户自己去拨开关——
   * 置灰的按钮带 pointer-events-none，点下去连提示都没有，只会让人以为页面坏了。
   */
  const handleDisableAndDelete = () => {
    setDisabled.mutate(
      { id: credential.id, disabled: true },
      {
        onSuccess: () => handleDelete(),
        onError: (err) => {
          toast.error('禁用失败，未执行删除: ' + (err as Error).message)
        },
      }
    )
  }

  const deleting = setDisabled.isPending || deleteCredential.isPending
  const remainingPercentage = balance
    ? Math.max(0, Math.min(100, 100 - balance.usagePercentage))
    : 0
  const usageToneClass = remainingPercentage <= CRITICAL_REMAINING_PERCENTAGE
    ? 'usage-fill--critical'
    : remainingPercentage <= WARNING_REMAINING_PERCENTAGE
      ? 'usage-fill--warning'
      : ''

  const handleCardClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element)) return

    if (target.closest('button, input, textarea, select, a, .credential-row__actions')) {
      return
    }

    onToggleSelect()
  }

  return (
    <>
      <Card
        className={cn(
          'credential-card',
          credential.isCurrent && 'credential-card--current',
          selected && 'credential-card--selected',
          credential.disabled && 'credential-card--disabled',
        )}
        aria-current={credential.isCurrent ? 'true' : undefined}
        onClick={handleCardClick}
      >
        <button
          type="button"
          className="credential-card__keyboard-select"
          aria-label={`${selected ? '取消选择' : '选择'}凭据 ${credential.email || credential.id}`}
          aria-pressed={selected}
          onClick={onToggleSelect}
        >
          {selected ? '取消选择' : '选择'}此凭据
        </button>
        <div className="credential-row">
          <section className="credential-row__identity">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-foreground px-2 py-0.5 text-[10px] font-bold tracking-[0.08em] text-background">
                  #{String(credential.id).padStart(2, '0')}
                </span>
                {credential.isCurrent && <Badge variant="success" className="rounded-full">当前路由</Badge>}
                {credential.disabled && <Badge variant="destructive" className="rounded-full">已禁用</Badge>}
              </div>
              <h2 className="mt-1.5 truncate text-[15px] font-semibold tracking-tight" title={credential.email || `凭据 #${credential.id}`}>
                {credential.email || `凭据 #${credential.id}`}
              </h2>
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                {credential.authMethod && (
                  <Badge variant="secondary" className="rounded-full font-semibold">
                    {credential.authMethod === 'api_key' ? 'API Key' :
                     credential.authMethod === 'idc' ? 'IdC' :
                     credential.authMethod === 'social' ? 'Social' :
                     credential.authMethod}
                  </Badge>
                )}
                {credential.endpoint && <Badge variant="outline" className="rounded-full">{credential.endpoint}</Badge>}
                {credential.disabled && credential.disabledReason && (
                  <Badge variant="outline" className="max-w-[12rem] rounded-full border-destructive/30 text-destructive" title={credential.disabledReason}>
                    <span className="truncate">{credential.disabledReason}</span>
                  </Badge>
                )}
              </div>
            </div>
          </section>

          <section className="credential-row__facts" aria-label="凭据状态信息">
            <div className="credential-facts__primary">
              <Badge variant="secondary" className="credential-subscription rounded-full font-semibold" title={balance?.subscriptionTitle || '未知订阅'}>
                {loadingBalance ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="truncate">{balance?.subscriptionTitle || '未知订阅'}</span>}
              </Badge>
              <div className={cn('credential-fact', editingPriority && 'credential-fact--editing')}>
                <span>优先级</span>
                {editingPriority ? (
                  <div className="credential-priority-editor">
                    <Input type="number" value={priorityValue} onChange={(e) => setPriorityValue(e.target.value)} className="h-6 min-w-0 rounded-md px-1.5 text-xs" min="0" aria-label="优先级" />
                    <Button size="sm" variant="ghost" className="h-5 w-5 shrink-0 rounded-md p-0" onClick={handlePriorityChange} disabled={setPriority.isPending} aria-label="保存优先级"><Check className="h-3 w-3" /></Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 w-5 shrink-0 rounded-md p-0"
                      onClick={() => {
                        setEditingPriority(false)
                        setPriorityValue(String(credential.priority))
                      }}
                      aria-label="取消编辑优先级"
                    ><X className="h-3 w-3" /></Button>
                  </div>
                ) : (
                  <button type="button" className="font-bold tabular-nums hover:text-primary" onClick={() => setEditingPriority(true)} title="点击编辑优先级">{credential.priority}</button>
                )}
              </div>
              <div className="credential-fact"><span>成功</span><strong>{credential.successCount}</strong></div>
              <div className={cn('credential-fact', credential.failureCount > 0 && 'credential-fact--danger')}><span>失败</span><strong>{credential.failureCount}</strong></div>
              <div className={cn('credential-fact', credential.refreshFailureCount > 0 && 'credential-fact--danger')}><span>刷新失败</span><strong>{credential.refreshFailureCount}</strong></div>
            </div>
            <div className="credential-facts__secondary">
              <span title={`Auth Region（Token 刷新）：${credential.authRegion}\nAPI Region（API 请求）：${credential.apiRegion}`}>
                区域 <strong className="text-foreground">{credential.authRegion === credential.apiRegion ? credential.authRegion : `${credential.authRegion} / ${credential.apiRegion}`}</strong>
              </span>
              <span>最后调用 <strong className="text-foreground">{formatLastUsed(credential.lastUsedAt)}</strong></span>
              <div className="credential-facts__extras">
                {credential.maskedApiKey && (
                  <span className="inline-flex min-w-0 items-center gap-1"><KeyRound className="h-3 w-3 shrink-0 text-primary" /><code className="truncate font-semibold text-foreground">{credential.maskedApiKey}</code></span>
                )}
                {credential.hasProxy && <span className="max-w-[14rem] truncate" title={credential.proxyUrl}>代理 <strong className="text-foreground">{credential.proxyUrl}</strong></span>}
                {credential.hasProfileArn && <span className="font-semibold text-foreground">Profile ARN</span>}
              </div>
            </div>
          </section>

          <section className="usage-inline" aria-label="凭据额度">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">剩余额度</span>
              {balance && !loadingBalance && <strong className="text-sm tabular-nums">{remainingPercentage.toFixed(1)}%</strong>}
            </div>
            <div
              className="usage-track mt-2"
              role="progressbar"
              aria-label="剩余额度百分比"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={balance && !loadingBalance ? remainingPercentage : undefined}
              aria-busy={loadingBalance}
            >
              {balance && !loadingBalance && remainingPercentage > 0 && (
                <div className={cn('usage-fill', usageToneClass)} style={{ width: `${remainingPercentage}%` }} />
              )}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
              {loadingBalance ? (
                <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />查询中</span>
              ) : balance ? (
                <><strong className="text-foreground">{balance.remaining.toFixed(2)}</strong><span>/ {balance.usageLimit.toFixed(2)}</span></>
              ) : (
                <span>等待查询</span>
              )}
            </div>
          </section>

          <section className="credential-row__actions" aria-label="凭据操作">
            <div className="credential-toggle">
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{credential.disabled ? '停用' : '启用'}</span>
              <Switch checked={!credential.disabled} onCheckedChange={handleToggleDisabled} disabled={setDisabled.isPending} aria-label={`${credential.disabled ? '启用' : '停用'}凭据 ${credential.id}`} />
            </div>
            <div className="credential-action-buttons">
              <Button size="sm" variant="default" className="h-8 rounded-lg px-2.5 text-xs" onClick={() => onViewBalance(credential.id)}>
                <Wallet className="mr-1.5 h-3.5 w-3.5" />额度详情
              </Button>
              {credential.authMethod !== 'api_key' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-lg px-2.5 text-xs"
                  onClick={handleForceRefresh}
                  disabled={forceRefresh.isPending || credential.disabled}
                  title={credential.disabled ? '已禁用的凭据无法刷新 Token' : '强制刷新 Token'}
                >
                  <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', forceRefresh.isPending && 'animate-spin')} />刷新 Token
                </Button>
              )}
              {(credential.failureCount > 0 || credential.refreshFailureCount > 0) && (
                <Button size="sm" variant="outline" className="h-8 rounded-lg px-2.5 text-xs" onClick={handleReset} disabled={resetFailure.isPending}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />重置失败
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-8 rounded-lg px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setShowDeleteDialog(true)} disabled={deleting}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />删除
              </Button>
            </div>
          </section>
        </div>
      </Card>

      {/* 删除确认对话框 */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除凭据</DialogTitle>
            <DialogDescription>
              您确定要删除凭据 #{credential.id} 吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          {!credential.disabled && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              这条凭据还在启用中，删除会先自动禁用它。
              {credential.isCurrent && ' 它是当前活跃凭据，删除后会切换到优先级最高的可用凭据。'}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={credential.disabled ? handleDelete : handleDisableAndDelete}
              disabled={deleting}
            >
              {deleting
                ? '删除中...'
                : credential.disabled
                  ? '确认删除'
                  : '禁用并删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
