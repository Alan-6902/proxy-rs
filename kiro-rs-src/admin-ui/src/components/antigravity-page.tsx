import { useEffect, useRef, useState } from 'react'
import { Copy, Layers, LogIn, LogOut, Moon, RefreshCw, Sparkles, Sun } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { AntigravityAccountCard } from '@/components/antigravity-account-card'
import { AntigravityModelDialog } from '@/components/antigravity-model-dialog'
import { useAgAccounts } from '@/hooks/use-credentials'
import { getAgOAuthStatus, refreshAgAccount, startAgOAuth } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'

interface AntigravityPageProps {
  onLogout: () => void
}

/** 登录进度轮询间隔 */
const OAUTH_POLL_MS = 1500

/** 账号卡片拖动后的顺序（账号 id 列表）存在 localStorage 的键 */
const CARD_ORDER_STORAGE_KEY = 'ag-account-card-order'

const loadCardOrder = (): number[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CARD_ORDER_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : []
  } catch {
    return []
  }
}

const saveCardOrder = (ids: number[]) => {
  try {
    localStorage.setItem(CARD_ORDER_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // 存储不可用时只在本次会话内生效
  }
}

/**
 * Antigravity 独立反代：Google 登录添加账号，独立端口的 /v1 在账号间轮询。
 * 登录在系统浏览器里完成，回调由 antigravity-rs 在本机回环地址接收。
 */
export function AntigravityPage({ onLogout }: AntigravityPageProps) {
  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch, isFetching } = useAgAccounts(true)
  const [loggingIn, setLoggingIn] = useState(false)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const activeSession = useRef<string | null>(null)
  const pollTimer = useRef<number | null>(null)
  const [darkMode, setDarkMode] = useState(() => document.documentElement.classList.contains('dark'))

  const toggleDarkMode = () => {
    setDarkMode(!darkMode)
    document.documentElement.classList.toggle('dark')
  }

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
    activeSession.current = null
    setLoggingIn(false)
    setAuthUrl(null)
  }

  useEffect(() => stopPolling, [])

  const handleLogin = async () => {
    try {
      setLoggingIn(true)
      const { sessionId, authUrl } = await startAgOAuth()
      activeSession.current = sessionId
      setAuthUrl(authUrl)
      pollTimer.current = window.setInterval(async () => {
        try {
          const status = await getAgOAuthStatus(sessionId)
          if (activeSession.current !== sessionId || status.status === 'pending') return
          stopPolling()
          if (status.status === 'success') {
            toast.success(`已添加 ${status.email}`)
            queryClient.invalidateQueries({ queryKey: ['ag-accounts'] })
          } else {
            toast.error(`登录失败：${status.error ?? '未知错误'}`)
          }
        } catch (e) {
          if (activeSession.current !== sessionId) return
          stopPolling()
          toast.error(`查询授权状态失败，请重新开始：${extractErrorMessage(e)}`)
        }
      }, OAUTH_POLL_MS)
    } catch (e) {
      stopPolling()
      toast.error(`无法开始登录：${extractErrorMessage(e)}`)
    }
  }

  const accounts = data?.accounts ?? []
  const available = accounts.filter((a) => !a.disabled).length
  // 「最近使用」：最后调用时间最新的账号
  const currentId = accounts.reduce<{ id: number; at: number } | null>(
    (best, a) => (a.lastUsedMs && (!best || a.lastUsedMs > best.at) ? { id: a.id, at: a.lastUsedMs } : best),
    null,
  )?.id

  // 卡片顺序只影响展示，存在浏览器本地；新账号排在末尾
  const [order, setOrder] = useState<number[]>(loadCardOrder)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const rank = (id: number) => {
    const i = order.indexOf(id)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  const sortedAccounts = [...accounts].sort((x, y) => rank(x.id) - rank(y.id) || x.id - y.id)

  const moveCard = (id: number, toIndex: number) => {
    const ids = sortedAccounts.map((a) => a.id)
    const from = ids.indexOf(id)
    const to = Math.min(Math.max(toIndex, 0), ids.length - 1)
    if (from === -1 || from === to) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    setOrder(ids)
    saveCardOrder(ids)
  }

  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState({ current: 0, total: 0 })
  // 逐个刷新，避免同时打上游；单号失败不中断其它账号
  const handleRefreshAll = async () => {
    const targets = accounts.filter((a) => !a.disabled)
    if (targets.length === 0) return
    setRefreshingAll(true)
    let failed = 0
    for (const [i, a] of targets.entries()) {
      setRefreshProgress({ current: i + 1, total: targets.length })
      try {
        await refreshAgAccount(a.id)
      } catch {
        failed += 1
      }
    }
    setRefreshingAll(false)
    queryClient.invalidateQueries({ queryKey: ['ag-accounts'] })
    if (failed === 0) toast.success(`已刷新 ${targets.length} 个账号的额度`)
    else toast.error(`${failed}/${targets.length} 个账号刷新失败，详见各账号错误信息`)
  }

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="mx-auto flex min-h-[64px] max-w-[1600px] items-center justify-between gap-4 px-4 py-2.5 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="brand-mark shrink-0"><Sparkles className="h-5 w-5" /></div>
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="truncate text-[17px] font-bold leading-none tracking-[-0.025em]">Antigravity Admin</div>
              <span className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
              <div className="hidden items-center gap-1.5 text-xs font-medium text-muted-foreground sm:flex">
                <span className="telemetry-dot" aria-hidden="true" />
                <span className="whitespace-nowrap">账号控制台</span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <span className="hidden max-w-[22rem] truncate rounded-xl border bg-card/70 px-3 py-1.5 font-mono text-xs text-muted-foreground lg:inline" title="客户端 ANTHROPIC_BASE_URL，请求走 /v1/messages，API Key 用配置里的访问密钥">
              ANTHROPIC_BASE_URL={window.location.origin}
            </span>
            <Button variant="ghost" size="icon" onClick={toggleDarkMode} className="h-9 w-9 rounded-xl" aria-label="切换深浅色主题" title="切换深浅色主题">
              {darkMode ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={() => void refetch()} disabled={isFetching} className="h-9 w-9 rounded-xl" aria-label="刷新账号列表" title="刷新账号列表">
              <RefreshCw className={`h-[18px] w-[18px] ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="icon" onClick={onLogout} className="h-9 w-9 rounded-xl" aria-label="退出登录" title="退出登录">
              <LogOut className="h-[18px] w-[18px]" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1680px] px-4 pb-10 pt-4 md:px-8">
        <section className="credential-toolbar mb-3" aria-labelledby="ag-account-list-title">
          <div className="credential-toolbar__summary">
            <div className="flex min-w-0 items-baseline gap-2.5">
              <h1 id="ag-account-list-title" className="whitespace-nowrap text-lg font-semibold tracking-tight">账号管理</h1>
              <span className="text-xs tabular-nums text-muted-foreground">{accounts.length} 条</span>
            </div>
            <div className="credential-toolbar__stats" aria-label="账号统计">
              <span className="credential-toolbar__stat"><span>总数</span><strong>{accounts.length}</strong></span>
              <span className="credential-toolbar__stat"><span>可用</span><strong className="text-emerald-600 dark:text-emerald-400">{available}</strong></span>
              <span className="credential-toolbar__stat min-w-0"><span>最近使用</span><strong className="max-w-[14rem] truncate" title={accounts.find((account) => account.id === currentId)?.email}>{accounts.find((account) => account.id === currentId)?.email ?? '—'}</strong></span>
            </div>
          </div>
          <div className="credential-toolbar__actions [&_button]:rounded-lg">
            <Button onClick={() => setModelDialogOpen(true)} size="sm" variant="outline" className="h-8 px-2.5 text-xs">
              <Layers className="mr-1.5 h-3.5 w-3.5" />模型目录
            </Button>
            {accounts.length > 0 && (
              <Button onClick={() => void handleRefreshAll()} size="sm" variant="outline" className="h-8 px-2.5 text-xs" disabled={refreshingAll}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshingAll ? 'animate-spin' : ''}`} />
                {refreshingAll ? `${refreshProgress.current}/${refreshProgress.total}` : '更新额度'}
              </Button>
            )}
            <Button onClick={handleLogin} disabled={loggingIn} size="sm" className="h-8 px-2.5 text-xs shadow-[0_6px_18px_hsl(var(--primary)/0.18)]">
              <LogIn className="mr-1.5 h-3.5 w-3.5" />
              {loggingIn ? (authUrl ? '等待授权完成' : '正在生成链接...') : '添加账号'}
            </Button>
          </div>
        </section>

        {authUrl && (
          <section className="control-deck mb-3 space-y-3 p-4" aria-label="Google 授权">
            <p className="text-sm" role="status">复制下方链接到浏览器，完成 Google 授权后，这里会自动添加账号。</p>
            <label htmlFor="ag-auth-url" className="block text-sm font-medium">授权链接</label>
            <textarea
              id="ag-auth-url"
              readOnly
              value={authUrl}
              rows={3}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full resize-none rounded-md border bg-background p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(authUrl)
                  toast.success('授权链接已复制')
                } catch {
                  toast.error('复制失败，请选中上方链接手动复制')
                }
              }}><Copy className="mr-2 h-4 w-4" />复制链接</Button>
              <Button variant="ghost" onClick={stopPolling}>取消等待</Button>
            </div>
          </section>
        )}

        {isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">加载中...</div>
        ) : error ? (
          <div className="py-6 text-center text-sm text-destructive">
            {extractErrorMessage(error)}（antigravity-rs 未启用 Antigravity 账号库时不可用）
          </div>
        ) : accounts.length === 0 ? (
          <div className="control-deck border-dashed py-14 text-center text-sm text-muted-foreground">还没有账号，点「添加账号」用 Google 登录</div>
        ) : (
          <div className="credential-grid grid gap-3">
            {sortedAccounts.map((a, index) => (
              <AntigravityAccountCard
                key={a.id}
                account={a}
                isCurrent={a.id === currentId}
                drag={{
                  dragging: draggingId === a.id,
                  onDragStart: () => setDraggingId(a.id),
                  onDragOver: () => {
                    if (draggingId !== null && draggingId !== a.id) moveCard(draggingId, index)
                  },
                  onDragEnd: () => setDraggingId(null),
                  onMove: (step) => moveCard(a.id, index + step),
                }}
              />
            ))}
          </div>
        )}
      </main>
      <AntigravityModelDialog open={modelDialogOpen} onOpenChange={setModelDialogOpen} />
    </div>
  )
}
