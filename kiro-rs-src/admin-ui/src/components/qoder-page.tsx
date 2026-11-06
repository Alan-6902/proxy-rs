import { useState } from 'react'
import { Bot, Layers, LogOut, Moon, Plus, RefreshCw, Sun } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { QoderAccountCard, formatCredits, quotaUnit } from '@/components/qoder-account-card'
import { QoderModelDialog } from '@/components/qoder-model-dialog'
import { QODER_ACCOUNTS_KEY, useAddQoderAccount, useQoderAccounts } from '@/hooks/use-credentials'
import { refreshQoderAccount } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'

/** PAT 前缀，与后端校验一致 */
const PAT_PREFIX = 'pt-'

/**
 * Qoder 国际版独立反代：粘贴 Personal Access Token 添加账号，
 * 独立端口的 /v1/messages 与 /v1/chat/completions 在账号间轮询。
 */
export function QoderPage({ onLogout }: { onLogout: () => void }) {
  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch, isFetching } = useQoderAccounts(true)
  const add = useAddQoderAccount()
  const [pat, setPat] = useState('')
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [darkMode, setDarkMode] = useState(() => document.documentElement.classList.contains('dark'))
  const [refreshingAll, setRefreshingAll] = useState(false)

  const accounts = data?.accounts ?? []
  const available = accounts.filter((a) => !a.disabled).length
  // 禁用的账号也算：消耗是历史，不随状态消失
  const consumedTotal = accounts.reduce((sum, a) => sum + a.consumedTotal, 0)
  const consumedUnit = quotaUnit(accounts.find((a) => a.quota)?.quota)
  const patValid = pat.trim().startsWith(PAT_PREFIX)

  const toggleDarkMode = () => {
    setDarkMode(!darkMode)
    document.documentElement.classList.toggle('dark')
  }

  const handleAdd = () => {
    if (!patValid) return
    add.mutate(pat.trim(), {
      onSuccess: (account) => {
        setPat('')
        toast.success(`已添加 ${account.name || account.email || account.uid}`)
      },
      onError: (e) => toast.error(`添加失败：${extractErrorMessage(e)}`),
    })
  }

  // 逐个刷新，避免同时打上游；单号失败不中断其它账号
  const handleRefreshAll = async () => {
    const targets = accounts.filter((a) => !a.disabled)
    if (targets.length === 0) return
    setRefreshingAll(true)
    let failed = 0
    for (const a of targets) {
      try {
        await refreshQoderAccount(a.id)
      } catch {
        failed += 1
      }
    }
    setRefreshingAll(false)
    void queryClient.invalidateQueries({ queryKey: QODER_ACCOUNTS_KEY })
    if (failed === 0) toast.success(`已刷新 ${targets.length} 个账号`)
    else toast.error(`${failed}/${targets.length} 个账号刷新失败，详见各账号错误信息`)
  }

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="mx-auto flex min-h-[64px] max-w-[1600px] items-center justify-between gap-4 px-4 py-2.5 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="brand-mark shrink-0"><Bot className="h-5 w-5" /></div>
            <div className="truncate text-[17px] font-bold leading-none tracking-[-0.025em]">Qoder Admin</div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <span className="hidden max-w-[26rem] truncate rounded-xl border bg-card/70 px-3 py-1.5 font-mono text-xs text-muted-foreground lg:inline"
              title="Anthropic 客户端设 ANTHROPIC_BASE_URL，OpenAI 客户端用 /v1/chat/completions；API Key 用配置里的访问密钥">
              BASE_URL={window.location.origin}
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
        <section className="credential-toolbar mb-3" aria-labelledby="qoder-account-list-title">
          <div className="credential-toolbar__summary">
            <h1 id="qoder-account-list-title" className="whitespace-nowrap text-lg font-semibold tracking-tight">账号管理</h1>
            <div className="credential-toolbar__stats" aria-label="账号统计">
              <span className="credential-toolbar__stat"><span>总数</span><strong>{accounts.length}</strong></span>
              <span className="credential-toolbar__stat"><span>可用</span><strong className="text-emerald-600 dark:text-emerald-400">{available}</strong></span>
              <span className="credential-toolbar__stat" title="所有账号累计消耗之和，含已禁用账号">
                <span>累计消耗</span><strong>{formatCredits(consumedTotal)} {consumedUnit}</strong>
              </span>
            </div>
          </div>
          <div className="credential-toolbar__actions [&_button]:rounded-lg">
            <Button onClick={() => setModelDialogOpen(true)} size="sm" variant="outline" className="h-8 px-2.5 text-xs">
              <Layers className="mr-1.5 h-3.5 w-3.5" />模型目录
            </Button>
            {accounts.length > 0 && (
              <Button onClick={() => void handleRefreshAll()} size="sm" variant="outline" className="h-8 px-2.5 text-xs" disabled={refreshingAll}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshingAll ? 'animate-spin' : ''}`} />更新额度
              </Button>
            )}
          </div>
        </section>

        <section className="control-deck mb-3 p-4" aria-label="添加 Qoder 账号">
          <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); handleAdd() }}>
            <div className="min-w-0 flex-1">
              <label htmlFor="qoder-pat" className="mb-1 block text-sm font-medium">Personal Access Token</label>
              <Input
                id="qoder-pat"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="pt-..."
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                aria-describedby="qoder-pat-hint"
                className="font-mono"
              />
            </div>
            <Button type="submit" disabled={!patValid || add.isPending} className="h-9">
              <Plus className="mr-1.5 h-4 w-4" />{add.isPending ? '正在换证...' : '添加账号'}
            </Button>
          </form>
          <p id="qoder-pat-hint" className="mt-2 text-xs text-muted-foreground">
            在 Qoder 国际版设置里生成 PAT（以 pt- 开头）。同一账号再次粘贴会替换凭证，保留统计与禁用状态。
          </p>
        </section>

        {isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">加载中...</div>
        ) : error ? (
          <div className="py-6 text-center text-sm text-destructive" role="alert">{extractErrorMessage(error)}</div>
        ) : accounts.length === 0 ? (
          <div className="control-deck border-dashed py-14 text-center text-sm text-muted-foreground">还没有账号，在上方粘贴 PAT 添加</div>
        ) : (
          <div className="credential-grid grid gap-3">
            {accounts.map((a) => <QoderAccountCard key={a.id} account={a} />)}
          </div>
        )}
      </main>
      <QoderModelDialog open={modelDialogOpen} onOpenChange={setModelDialogOpen} />
    </div>
  )
}
