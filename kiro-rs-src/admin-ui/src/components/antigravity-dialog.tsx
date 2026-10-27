import { useEffect, useRef, useState } from 'react'
import { LogIn, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  useAgAccounts,
  useDeleteAgAccount,
  useRefreshAgAccount,
  useSetAgAccountDisabled,
} from '@/hooks/use-credentials'
import { getAgOAuthStatus, startAgOAuth } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { AgAccount } from '@/types/api'

interface AntigravityDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 登录进度轮询间隔 */
const OAUTH_POLL_MS = 1500

const formatPercent = (fraction: number) => `${Math.round(fraction * 100)}%`

const quotaColor = (fraction: number) => {
  if (fraction <= 0.1) return 'text-destructive'
  if (fraction <= 0.4) return 'text-amber-600 dark:text-amber-400'
  return 'text-emerald-600 dark:text-emerald-400'
}

function QuotaList({ account }: { account: AgAccount }) {
  const models = account.quota?.models ?? []
  if (models.length === 0) {
    return <div className="text-xs text-muted-foreground">暂无额度数据，点刷新拉取</div>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {models.map((m) => (
        <span
          key={m.id}
          className="rounded-md border px-1.5 py-0.5 font-mono text-[11px]"
          title={m.resetTime ? `重置时间：${new Date(m.resetTime).toLocaleString('zh-CN')}` : undefined}
        >
          {m.id} <span className={quotaColor(m.remainingFraction)}>{formatPercent(m.remainingFraction)}</span>
        </span>
      ))}
    </div>
  )
}

/**
 * Antigravity 账号池：Google 登录添加账号，/ag/v1 在这些账号间轮询。
 * 登录在系统浏览器里完成，回调由 kiro-rs 在本机回环地址接收。
 */
export function AntigravityDialog({ open, onOpenChange }: AntigravityDialogProps) {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useAgAccounts(open)
  const refresh = useRefreshAgAccount()
  const setDisabled = useSetAgAccountDisabled()
  const remove = useDeleteAgAccount()
  const [loggingIn, setLoggingIn] = useState(false)
  const pollTimer = useRef<number | null>(null)

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
    setLoggingIn(false)
  }

  useEffect(() => stopPolling, [])

  const handleLogin = async () => {
    try {
      setLoggingIn(true)
      const { sessionId, authUrl } = await startAgOAuth()
      window.open(authUrl, '_blank')
      toast.info('已在浏览器打开 Google 登录页，完成后回到这里')
      pollTimer.current = window.setInterval(async () => {
        try {
          const status = await getAgOAuthStatus(sessionId)
          if (status.status === 'pending') return
          stopPolling()
          if (status.status === 'success') {
            toast.success(`已添加 ${status.email}`)
            queryClient.invalidateQueries({ queryKey: ['ag-accounts'] })
          } else {
            toast.error(`登录失败：${status.error ?? '未知错误'}`)
          }
        } catch (e) {
          stopPolling()
          toast.error(`查询登录状态失败：${extractErrorMessage(e)}`)
        }
      }, OAUTH_POLL_MS)
    } catch (e) {
      stopPolling()
      toast.error(`无法开始登录：${extractErrorMessage(e)}`)
    }
  }

  const handleRefresh = (account: AgAccount) => {
    refresh.mutate(account.id, {
      onSuccess: () => toast.success(`${account.email} 已刷新`),
      onError: (e) => toast.error(`刷新失败：${extractErrorMessage(e)}`),
    })
  }

  const handleDelete = (account: AgAccount) => {
    if (!window.confirm(`删除 ${account.email}？删除后需要重新登录才能再用。`)) return
    remove.mutate(account.id, {
      onSuccess: () => toast.success(`已删除 ${account.email}`),
      onError: (e) => toast.error(`删除失败：${extractErrorMessage(e)}`),
    })
  }

  const accounts = data?.accounts ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Antigravity 账号池</DialogTitle>
          <DialogDescription>
            客户端设 ANTHROPIC_BASE_URL=http://127.0.0.1:端口/ag，API Key 与 /v1 相同。
            {data?.dbPath && <span className="block font-mono text-[11px]">{data.dbPath}</span>}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">共 {accounts.length} 个账号</div>
          <Button onClick={handleLogin} disabled={loggingIn} size="sm" className="h-8 px-3 text-xs">
            <LogIn className="mr-1.5 h-3.5 w-3.5" />
            {loggingIn ? '等待浏览器登录...' : '用 Google 登录添加'}
          </Button>
        </div>

        {isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">加载中...</div>
        ) : error ? (
          <div className="py-6 text-center text-sm text-destructive">
            {extractErrorMessage(error)}（kiro-rs 未启用 Antigravity 账号库时不可用）
          </div>
        ) : accounts.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">还没有账号</div>
        ) : (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {accounts.map((a) => (
              <div key={a.id} className="space-y-1.5 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      #{a.id} {a.email}
                      {a.tier && <span className="ml-2 text-xs font-normal text-muted-foreground">{a.tier}</span>}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      project: {a.projectId ?? '未获取'}
                      {a.lastUsedMs && ` · 上次使用 ${new Date(a.lastUsedMs).toLocaleString('zh-CN')}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Switch
                      checked={!a.disabled}
                      onCheckedChange={(checked) => setDisabled.mutate({ id: a.id, disabled: !checked })}
                      title={a.disabled ? '已禁用' : '已启用'}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleRefresh(a)}
                      disabled={refresh.isPending && refresh.variables === a.id}
                      title="刷新 token 与额度"
                    >
                      <RefreshCw className={`h-4 w-4 ${refresh.isPending && refresh.variables === a.id ? 'animate-spin' : ''}`} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(a)}
                      title="删除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {a.lastError && <div className="text-xs text-destructive">{a.lastError}</div>}
                <QuotaList account={a} />
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
