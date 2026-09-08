import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Download,
  FolderOpen,
  Loader2,
  MousePointer2,
  Plus,
  RefreshCw,
  Search,
  Trash2
} from 'lucide-react'
import {
  CURSOR_AUTO_REFRESH_DEFAULT_SETTINGS,
  CURSOR_AUTO_REFRESH_INTERVAL_OPTIONS,
  getCursorAccountDisplayEmail,
  getCursorPlanBadge,
  getCursorPlanDisplayName,
  getCursorUsage,
  hasCursorQuotaQueryError,
  isCursorAccountBanned,
  type CursorAccount,
  type CursorAutoRefreshSettings,
  type CursorPlanBadge
} from '../../../../shared/cursorAccounts'
import { Button, Input, PageHeader, Select, Toggle, askConfirm } from '../ui'
import {
  CursorAccountCard,
  CursorAddAccountDialog,
  CursorExportDialog,
  CursorTagDialog
} from '../cursor'
import { errorText } from '../cursor/_helpers'

type SortKey = 'lastUsed' | 'usage' | 'email'

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'lastUsed', label: '最近使用' },
  { key: 'usage', label: '用量' },
  { key: 'email', label: '邮箱' }
]

/** 特殊筛选值，与套餐名互斥地放在同一组按钮里。 */
const FILTER_ABNORMAL = '__abnormal__'
const FILTER_QUOTA_FAILED = '__quota_failed__'

const INTERVAL_OPTIONS = CURSOR_AUTO_REFRESH_INTERVAL_OPTIONS.map((minutes) => ({
  value: String(minutes),
  label: `每 ${minutes} 分钟`
}))

function matchesSearch(account: CursorAccount, query: string): boolean {
  if (!query) return true
  const haystack = [
    account.email,
    account.name,
    account.id,
    account.membershipType,
    ...account.tags
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

function usageOf(account: CursorAccount): number {
  return getCursorUsage(account).planUsedPercent ?? -1
}

export function CursorAccountsPage(): React.ReactNode {
  const [accounts, setAccounts] = useState<CursorAccount[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<SortKey>('lastUsed')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set())
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [injectingId, setInjectingId] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [tagTarget, setTagTarget] = useState<CursorAccount | null>(null)
  const [exportIds, setExportIds] = useState<string[] | null>(null)

  const [autoRefresh, setAutoRefresh] = useState<CursorAutoRefreshSettings>(
    CURSOR_AUTO_REFRESH_DEFAULT_SETTINGS
  )
  const [savingSettings, setSavingSettings] = useState(false)

  useEffect(() => {
    void window.api.cursorAccountsGetSettings().then((result) => {
      if (result.success) setAutoRefresh(result.data)
    })
  }, [])

  const updateAutoRefresh = async (patch: Partial<CursorAutoRefreshSettings>): Promise<void> => {
    setSavingSettings(true)
    try {
      const result = await window.api.cursorAccountsUpdateSettings(patch)
      if (!result.success) throw new Error(result.error)
      setAutoRefresh(result.data)
    } catch (settingsError) {
      setError(errorText(settingsError, '保存自动刷新设置失败'))
    } finally {
      setSavingSettings(false)
    }
  }

  const load = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const [listResult, currentResult] = await Promise.all([
        window.api.cursorAccountsList(),
        window.api.cursorAccountsCurrentId()
      ])
      if (!listResult.success) throw new Error(listResult.error)
      setAccounts(listResult.data)
      setCurrentId(currentResult.success ? currentResult.data : null)
      // 被删掉的账号从多选里清掉
      setSelected((prev) => {
        const alive = new Set(listResult.data.map((account) => account.id))
        const next = new Set([...prev].filter((id) => alive.has(id)))
        return next.size === prev.size ? prev : next
      })
    } catch (loadError) {
      setError(errorText(loadError, '读取 Cursor 账号库失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return window.api.onCursorAccountsChanged(() => {
      void load()
    })
  }, [load])

  const knownTags = useMemo(() => {
    const set = new Map<string, string>()
    for (const account of accounts) {
      for (const tag of account.tags) set.set(tag.toLowerCase(), tag)
    }
    return [...set.values()].sort((a, b) => a.localeCompare(b))
  }, [accounts])

  const planFilterOptions = useMemo(() => {
    const counts = new Map<CursorPlanBadge, { label: string; count: number }>()
    for (const account of accounts) {
      const badge = getCursorPlanBadge(account)
      const entry = counts.get(badge) ?? { label: getCursorPlanDisplayName(account), count: 0 }
      entry.count += 1
      counts.set(badge, entry)
    }
    return [...counts.entries()].map(([key, value]) => ({ key, ...value }))
  }, [accounts])

  const abnormalCount = useMemo(
    () =>
      accounts.filter(
        (account) => isCursorAccountBanned(account) || account.status?.toLowerCase() === 'error'
      ).length,
    [accounts]
  )
  const quotaFailedCount = useMemo(
    () => accounts.filter(hasCursorQuotaQueryError).length,
    [accounts]
  )

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase()
    const planFilters = new Set(
      [...filters].filter((item) => item !== FILTER_ABNORMAL && item !== FILTER_QUOTA_FAILED)
    )
    const list = accounts.filter((account) => {
      if (!matchesSearch(account, query)) return false
      if (planFilters.size > 0 && !planFilters.has(getCursorPlanBadge(account))) return false
      if (
        filters.has(FILTER_ABNORMAL) &&
        !(isCursorAccountBanned(account) || account.status?.toLowerCase() === 'error')
      ) {
        return false
      }
      if (filters.has(FILTER_QUOTA_FAILED) && !hasCursorQuotaQueryError(account)) return false
      return true
    })
    // 当前使用的号永远排最前
    return list.sort((a, b) => {
      if (a.id === currentId) return -1
      if (b.id === currentId) return 1
      switch (sort) {
        case 'usage':
          return usageOf(b) - usageOf(a)
        case 'email':
          return getCursorAccountDisplayEmail(a).localeCompare(getCursorAccountDisplayEmail(b))
        default:
          return b.lastUsed - a.lastUsed
      }
    })
  }, [accounts, currentId, filters, search, sort])

  const toggleFilter = (value: string): void => {
    setFilters((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allVisibleSelected = visible.length > 0 && visible.every((item) => selected.has(item.id))
  const toggleSelectAll = (): void => {
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((item) => item.id)))
  }

  const handleRefresh = async (account: CursorAccount): Promise<void> => {
    setRefreshingIds((prev) => new Set(prev).add(account.id))
    setError('')
    try {
      const result = await window.api.cursorAccountsRefresh(account.id)
      if (!result.success) throw new Error(result.error)
      setNotice(`已刷新 ${getCursorAccountDisplayEmail(result.data)}`)
    } catch (refreshError) {
      setError(errorText(refreshError, '刷新失败'))
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev)
        next.delete(account.id)
        return next
      })
    }
  }

  const handleRefreshAll = async (): Promise<void> => {
    setRefreshingAll(true)
    setError('')
    setNotice('')
    try {
      const result = await window.api.cursorAccountsRefreshAll()
      if (!result.success) throw new Error(result.error)
      const { total, success, failed } = result.data
      setNotice(
        `已刷新 ${success}/${total} 个账号${failed.length > 0 ? `，${failed.length} 个失败` : ''}`
      )
      if (failed.length > 0) {
        setError(failed.map((item) => `${item.email || item.id}: ${item.error}`).join('\n'))
      }
    } catch (refreshError) {
      setError(errorText(refreshError, '批量刷新失败'))
    } finally {
      setRefreshingAll(false)
    }
  }

  const handleInject = async (account: CursorAccount): Promise<void> => {
    const email = getCursorAccountDisplayEmail(account)
    setInjectingId(account.id)
    setError('')
    setNotice('')
    try {
      let result = await window.api.cursorAccountsInject(account.id)
      if (!result.success) throw new Error(result.error)
      if (result.data.status === 'needsClose') {
        const confirmed = await askConfirm({
          title: `切换到 ${email}`,
          description:
            'Cursor 正在运行。切号要先退出 Cursor（会先请它正常退出，以便保存窗口与工作区状态），写入新账号的登录态后再自动重新打开。Cursor 里未保存的改动请先保存。',
          confirmText: '退出 Cursor 并切换',
          tone: 'warning'
        })
        if (!confirmed) return
        result = await window.api.cursorAccountsInject(account.id, { closeCursor: true })
        if (!result.success) throw new Error(result.error)
      }
      if (result.data.status === 'done') {
        setNotice(
          result.data.relaunched
            ? `已切换到 ${email}，Cursor 已重新启动`
            : `已切换到 ${email}，下次打开 Cursor 生效`
        )
      }
    } catch (injectError) {
      setError(errorText(injectError, '切换失败'))
    } finally {
      setInjectingId(null)
    }
  }

  const handleDelete = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return
    const targets = accounts.filter((account) => ids.includes(account.id))
    const confirmed = await askConfirm({
      title:
        ids.length === 1
          ? `删除 ${getCursorAccountDisplayEmail(targets[0])}`
          : `删除 ${ids.length} 个账号`,
      description:
        '只从本地账号库移除，不影响 Cursor 服务端账号，也不会改动本机 Cursor 当前登录态。删除后 token 不可找回，需要的话先导出。',
      confirmText: '删除',
      tone: 'danger'
    })
    if (!confirmed) return
    setError('')
    try {
      const result = await window.api.cursorAccountsRemove(ids)
      if (!result.success) throw new Error(result.error)
      setNotice(`已删除 ${ids.length} 个账号`)
      setSelected(new Set())
    } catch (deleteError) {
      setError(errorText(deleteError, '删除失败'))
    }
  }

  const handleRevealStore = async (): Promise<void> => {
    const result = await window.api.cursorAccountsRevealStore()
    if (!result.success) {
      setError(result.error || '打开账号库文件失败')
      return
    }
    setNotice(`账号库文件（已加密）：${result.data}`)
  }

  const currentAccount = currentId ? accounts.find((item) => item.id === currentId) : undefined

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <PageHeader
        title="Cursor 账号"
        eyebrow="Cursor Accounts"
        icon={MousePointer2}
        accent="indigo"
        description="管理多个 Cursor 账号：浏览器登录或导入 token 入库，一键切换本机 Cursor 登录的号，查看套餐与用量。切号会改写本机 Cursor 的登录态，所以 Cursor 需要先退出。"
        badges={
          accounts.length > 0 && (
            <span className="text-xs text-muted-foreground">
              共 {accounts.length} 个
              {currentAccount
                ? ` · 本机在用 ${getCursorAccountDisplayEmail(currentAccount)}`
                : ' · 本机登录的号不在库里'}
            </span>
          )
        }
        actions={
          <>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" />
              添加账号
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleRefreshAll()}
              disabled={refreshingAll || accounts.length === 0}
              title="刷新所有未封禁账号的套餐与用量"
            >
              {refreshingAll ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              全部刷新
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setExportIds(accounts.map((item) => item.id))}
              disabled={accounts.length === 0}
            >
              <Download className="h-4 w-4" />
              导出全部
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleRevealStore()}
              title="账号库是 safeStorage 加密文件，不含明文 token"
            >
              <FolderOpen className="h-4 w-4" />
              账号库文件
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {error && (
          <div className="whitespace-pre-wrap break-all rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        )}
        {notice && (
          <p className="break-all rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-600 dark:text-sky-300">
            {notice}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索邮箱、标签、套餐…"
              className="pl-8"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {planFilterOptions.map((option) => (
              <Button
                key={option.key}
                size="sm"
                variant={filters.has(option.key) ? 'default' : 'ghost'}
                onClick={() => toggleFilter(option.key)}
              >
                {option.label} <span className="text-2xs opacity-70">{option.count}</span>
              </Button>
            ))}
            {abnormalCount > 0 && (
              <Button
                size="sm"
                variant={filters.has(FILTER_ABNORMAL) ? 'destructive' : 'ghost'}
                onClick={() => toggleFilter(FILTER_ABNORMAL)}
              >
                异常 <span className="text-2xs opacity-70">{abnormalCount}</span>
              </Button>
            )}
            {quotaFailedCount > 0 && (
              <Button
                size="sm"
                variant={filters.has(FILTER_QUOTA_FAILED) ? 'default' : 'ghost'}
                onClick={() => toggleFilter(FILTER_QUOTA_FAILED)}
              >
                用量拉取失败 <span className="text-2xs opacity-70">{quotaFailedCount}</span>
              </Button>
            )}
          </div>
          <div
            className="ml-auto flex items-center gap-2"
            title="后台按间隔刷新所有未封禁账号的套餐、用量、Bot 额度与余额；关掉后只能手动刷新"
          >
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Toggle
                size="sm"
                checked={autoRefresh.enabled}
                disabled={savingSettings}
                onChange={(enabled) => void updateAutoRefresh({ enabled })}
              />
              自动刷新
            </label>
            <Select
              value={String(autoRefresh.intervalMinutes)}
              options={INTERVAL_OPTIONS}
              disabled={savingSettings || !autoRefresh.enabled}
              onChange={(value) => void updateAutoRefresh({ intervalMinutes: Number(value) })}
              className="w-32 text-xs"
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">排序</span>
            {SORT_OPTIONS.map((option) => (
              <Button
                key={option.key}
                size="sm"
                variant={sort === option.key ? 'default' : 'ghost'}
                onClick={() => setSort(option.key)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        {visible.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleSelectAll}
                className="h-3.5 w-3.5 rounded"
              />
              全选当前 {visible.length} 个
            </label>
            {selected.size > 0 && (
              <>
                <span>已选 {selected.size} 个</span>
                <Button size="sm" variant="outline" onClick={() => setExportIds([...selected])}>
                  <Download className="h-4 w-4" />
                  导出选中
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-red-600 dark:text-red-400"
                  onClick={() => void handleDelete([...selected])}
                >
                  <Trash2 className="h-4 w-4" />
                  删除选中
                </Button>
              </>
            )}
          </div>
        )}

        {loading ? (
          <div className="grid h-32 place-items-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <div className="grid h-40 place-items-center rounded-xl border border-dashed border-border/60 text-center text-sm text-muted-foreground">
            {accounts.length === 0 ? (
              <div className="space-y-2">
                <p>还没有 Cursor 账号。</p>
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="h-4 w-4" />
                  添加第一个账号
                </Button>
              </div>
            ) : (
              '没有符合筛选条件的账号'
            )}
          </div>
        ) : (
          <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
            {visible.map((account) => (
              <CursorAccountCard
                key={account.id}
                account={account}
                isCurrent={account.id === currentId}
                selected={selected.has(account.id)}
                refreshing={refreshingIds.has(account.id) || refreshingAll}
                injecting={injectingId === account.id}
                onToggleSelect={() => toggleSelect(account.id)}
                onInject={() => void handleInject(account)}
                onRefresh={() => void handleRefresh(account)}
                onEditTags={() => setTagTarget(account)}
                onExport={() => setExportIds([account.id])}
                onDelete={() => void handleDelete([account.id])}
              />
            ))}
          </div>
        )}
      </div>

      <CursorAddAccountDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(_added, message, warning) => {
          setNotice(message)
          setError(warning ?? '')
        }}
      />
      <CursorTagDialog
        account={tagTarget}
        knownTags={knownTags}
        onClose={() => setTagTarget(null)}
        onSaved={(account) => setNotice(`已更新 ${getCursorAccountDisplayEmail(account)} 的标签`)}
      />
      <CursorExportDialog
        ids={exportIds}
        onClose={() => setExportIds(null)}
        onExported={(message) => setNotice(message)}
      />
    </div>
  )
}
