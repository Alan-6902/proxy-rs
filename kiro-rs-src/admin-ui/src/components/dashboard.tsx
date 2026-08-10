import { useState, useEffect, useRef } from 'react'
import {
  Activity,
  CheckCircle2,
  Database,
  FileUp,
  Gauge,
  LogOut,
  Moon,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { storage } from '@/lib/storage'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CredentialCard } from '@/components/credential-card'
import { BalanceDialog } from '@/components/balance-dialog'
import { AddCredentialDialog } from '@/components/add-credential-dialog'
import { BatchImportDialog } from '@/components/batch-import-dialog'
import { KamImportDialog } from '@/components/kam-import-dialog'
import { BatchVerifyDialog, type VerifyResult } from '@/components/batch-verify-dialog'
import { useCredentials, useDeleteCredential, useResetFailure, useSetDisabled, useLoadBalancingMode, useSetLoadBalancingMode } from '@/hooks/use-credentials'
import { getCredentialBalance, forceRefreshToken } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { BalanceResponse } from '@/types/api'

interface DashboardProps {
  onLogout: () => void
}

export function Dashboard({ onLogout }: DashboardProps) {
  const [selectedCredentialId, setSelectedCredentialId] = useState<number | null>(null)
  const [balanceDialogOpen, setBalanceDialogOpen] = useState(false)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [batchImportDialogOpen, setBatchImportDialogOpen] = useState(false)
  const [kamImportDialogOpen, setKamImportDialogOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyProgress, setVerifyProgress] = useState({ current: 0, total: 0 })
  const [verifyResults, setVerifyResults] = useState<Map<number, VerifyResult>>(new Map())
  const [balanceMap, setBalanceMap] = useState<Map<number, BalanceResponse>>(new Map())
  const [loadingBalanceIds, setLoadingBalanceIds] = useState<Set<number>>(new Set())
  const [queryingInfo, setQueryingInfo] = useState(false)
  const [queryInfoProgress, setQueryInfoProgress] = useState({ current: 0, total: 0 })
  const [batchRefreshing, setBatchRefreshing] = useState(false)
  const [batchRefreshProgress, setBatchRefreshProgress] = useState({ current: 0, total: 0 })
  const cancelVerifyRef = useRef(false)
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 12
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return document.documentElement.classList.contains('dark')
    }
    return false
  })

  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch } = useCredentials()
  const { mutate: resetFailure } = useResetFailure()
  const { mutateAsync: setDisabledAsync } = useSetDisabled()
  const { mutateAsync: deleteCredentialAsync } = useDeleteCredential()
  const { data: loadBalancingData, isLoading: isLoadingMode } = useLoadBalancingMode()
  const { mutate: setLoadBalancingMode, isPending: isSettingMode } = useSetLoadBalancingMode()

  // 计算分页
  const totalPages = Math.ceil((data?.credentials.length || 0) / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const currentCredentials = data?.credentials.slice(startIndex, endIndex) || []

  // 当前页待查余额的凭据（禁用的查不出东西，跳过）
  const queryableIds = currentCredentials.filter(c => !c.disabled).map(c => c.id)
  /*
   * 作为 effect 依赖用的稳定标识。不能直接依赖 currentCredentials：
   * useCredentials 每 30 秒轮询一次，数组每轮都是新引用，会把自动查询变成
   * 每 30 秒重打一遍上游。
   */
  const queryableIdsKey = queryableIds.join(',')

  // 当凭据列表变化时重置到第一页
  useEffect(() => {
    setCurrentPage(1)
  }, [data?.credentials.length])

  // 只保留当前仍存在的凭据缓存，避免删除后残留旧数据
  useEffect(() => {
    if (!data?.credentials) {
      setBalanceMap(new Map())
      setLoadingBalanceIds(new Set())
      return
    }

    const validIds = new Set(data.credentials.map(credential => credential.id))

    setBalanceMap(prev => {
      const next = new Map<number, BalanceResponse>()
      prev.forEach((value, id) => {
        if (validIds.has(id)) {
          next.set(id, value)
        }
      })
      return next.size === prev.size ? prev : next
    })

    setLoadingBalanceIds(prev => {
      if (prev.size === 0) {
        return prev
      }
      const next = new Set<number>()
      prev.forEach(id => {
        if (validIds.has(id)) {
          next.add(id)
        }
      })
      return next.size === prev.size ? prev : next
    })
  }, [data?.credentials])

  const toggleDarkMode = () => {
    setDarkMode(!darkMode)
    document.documentElement.classList.toggle('dark')
  }

  const handleViewBalance = (id: number) => {
    setSelectedCredentialId(id)
    setBalanceDialogOpen(true)
  }

  const handleRefresh = () => {
    refetch()
    toast.success('已刷新凭据列表')
  }

  const handleLogout = () => {
    storage.removeApiKey()
    queryClient.clear()
    onLogout()
  }

  // 选择管理
  const toggleSelect = (id: number) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedIds(newSelected)
  }

  const deselectAll = () => {
    setSelectedIds(new Set())
  }

  /*
   * 删掉一条凭据。后端只收已禁用的，所以启用中的先禁用再删。
   * 让界面替用户补上这一步，而不是把它们算作"跳过"——用户勾了就是要删。
   */
  const removeCredential = async (id: number, disabled: boolean) => {
    if (!disabled) {
      await setDisabledAsync({ id, disabled: true })
    }
    await deleteCredentialAsync(id)
  }

  // 批量删除选中的凭据（启用中的会先自动禁用）
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要删除的凭据')
      return
    }

    const targets = Array.from(selectedIds)
      .map(id => data?.credentials.find(c => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))

    if (targets.length === 0) {
      toast.error('选中的凭据已不存在，请刷新后重试')
      return
    }

    const enabledCount = targets.filter(c => !c.disabled).length
    const enabledText = enabledCount > 0 ? `其中 ${enabledCount} 个还在启用中，将先自动禁用。` : ''

    if (!confirm(`确定要删除 ${targets.length} 个凭据吗？此操作无法撤销。${enabledText}`)) {
      return
    }

    let successCount = 0
    let failCount = 0

    for (const credential of targets) {
      try {
        await removeCredential(credential.id, credential.disabled)
        successCount++
      } catch (error) {
        failCount++
        toast.error(`凭据 #${credential.id} 删除失败: ${extractErrorMessage(error)}`)
      }
    }

    if (failCount === 0) {
      toast.success(`成功删除 ${successCount} 个凭据`)
    } else {
      toast.warning(`批量删除：成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    deselectAll()
  }

  // 批量恢复异常
  const handleBatchResetFailure = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要恢复的凭据')
      return
    }

    const failedIds = Array.from(selectedIds).filter(id => {
      const cred = data?.credentials.find(c => c.id === id)
      return cred && (cred.failureCount > 0 || cred.refreshFailureCount > 0)
    })

    if (failedIds.length === 0) {
      toast.error('选中的凭据中没有失败的凭据')
      return
    }

    let successCount = 0
    let failCount = 0

    for (const id of failedIds) {
      try {
        await new Promise<void>((resolve, reject) => {
          resetFailure(id, {
            onSuccess: () => {
              successCount++
              resolve()
            },
            onError: (err) => {
              failCount++
              reject(err)
            }
          })
        })
      } catch (error) {
        // 错误已在 onError 中处理
      }
    }

    if (failCount === 0) {
      toast.success(`成功恢复 ${successCount} 个凭据`)
    } else {
      toast.warning(`成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    deselectAll()
  }

  // 批量刷新 Token
  const handleBatchForceRefresh = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要刷新的凭据')
      return
    }

    const enabledIds = Array.from(selectedIds).filter(id => {
      const cred = data?.credentials.find(c => c.id === id)
      return cred && !cred.disabled
    })

    if (enabledIds.length === 0) {
      toast.error('选中的凭据中没有启用的凭据')
      return
    }

    setBatchRefreshing(true)
    setBatchRefreshProgress({ current: 0, total: enabledIds.length })

    let successCount = 0
    let failCount = 0

    for (let i = 0; i < enabledIds.length; i++) {
      try {
        await forceRefreshToken(enabledIds[i])
        successCount++
      } catch {
        failCount++
      }
      setBatchRefreshProgress({ current: i + 1, total: enabledIds.length })
    }

    setBatchRefreshing(false)
    queryClient.invalidateQueries({ queryKey: ['credentials'] })

    if (failCount === 0) {
      toast.success(`成功刷新 ${successCount} 个凭据的 Token`)
    } else {
      toast.warning(`刷新 Token：成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    deselectAll()
  }

  // 一键清除所有已禁用凭据
  const handleClearAll = async () => {
    if (!data?.credentials || data.credentials.length === 0) {
      toast.error('没有可清除的凭据')
      return
    }

    const disabledCredentials = data.credentials.filter(credential => credential.disabled)

    if (disabledCredentials.length === 0) {
      toast.error('没有可清除的已禁用凭据')
      return
    }

    if (!confirm(`确定要清除所有 ${disabledCredentials.length} 个已禁用凭据吗？此操作无法撤销。`)) {
      return
    }

    let successCount = 0
    let failCount = 0

    for (const credential of disabledCredentials) {
      try {
        await removeCredential(credential.id, credential.disabled)
        successCount++
      } catch (error) {
        failCount++
        toast.error(`凭据 #${credential.id} 清除失败: ${extractErrorMessage(error)}`)
      }
    }

    if (failCount === 0) {
      toast.success(`成功清除所有 ${successCount} 个已禁用凭据`)
    } else {
      toast.warning(`清除已禁用凭据：成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    deselectAll()
  }

  /*
   * 逐个查余额，不并发。上游对同一账号的高频查询会触发风控，串行是刻意的。
   * 后端 /balance 有 5 分钟缓存，重复调用同一条命中缓存不会打到上游。
   */
  const queryBalances = async (ids: number[]) => {
    setQueryingInfo(true)
    setQueryInfoProgress({ current: 0, total: ids.length })

    let successCount = 0
    let failCount = 0

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]

      setLoadingBalanceIds(prev => {
        const next = new Set(prev)
        next.add(id)
        return next
      })

      try {
        const balance = await getCredentialBalance(id)
        successCount++

        setBalanceMap(prev => {
          const next = new Map(prev)
          next.set(id, balance)
          return next
        })
      } catch {
        failCount++
      } finally {
        setLoadingBalanceIds(prev => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }

      setQueryInfoProgress({ current: i + 1, total: ids.length })
    }

    setQueryingInfo(false)
    return { successCount, failCount }
  }

  // 手动点「查询信息」：强制重查当前页全部，拿最新数据
  const handleQueryCurrentPageInfo = async () => {
    if (queryableIds.length === 0) {
      toast.error('当前页没有可查询的启用凭据')
      return
    }

    const { successCount, failCount } = await queryBalances(queryableIds)

    if (failCount === 0) {
      toast.success(`查询完成：成功 ${successCount}/${queryableIds.length}`)
    } else {
      toast.warning(`查询完成：成功 ${successCount} 个，失败 ${failCount} 个`)
    }
  }

  /*
   * 进入页面或翻页后自动补齐当前页的余额，省掉每次手点「查询信息」。
   * 只查 balanceMap 里还没有的，已经查过的不重复打上游——手动按钮才做强制重查。
   * autoQueryRunningRef 防止上一轮还没跑完就被下一轮插进来（两个循环会同时改
   * loadingBalanceIds，进度条也会互相打乱）。
   */
  const autoQueryRunningRef = useRef(false)
  useEffect(() => {
    if (autoQueryRunningRef.current || queryableIds.length === 0) return

    const missing = queryableIds.filter(id => !balanceMap.has(id))
    if (missing.length === 0) return

    autoQueryRunningRef.current = true
    queryBalances(missing).finally(() => {
      autoQueryRunningRef.current = false
    })
    // balanceMap 故意不进依赖：它在查询过程中会被逐条写入，会让 effect 自我重触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryableIdsKey])

  // 批量验活
  const handleBatchVerify = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要验活的凭据')
      return
    }

    // 初始化状态
    setVerifying(true)
    cancelVerifyRef.current = false
    const ids = Array.from(selectedIds)
    setVerifyProgress({ current: 0, total: ids.length })

    let successCount = 0

    // 初始化结果，所有凭据状态为 pending
    const initialResults = new Map<number, VerifyResult>()
    ids.forEach(id => {
      initialResults.set(id, { id, status: 'pending' })
    })
    setVerifyResults(initialResults)
    setVerifyDialogOpen(true)

    // 开始验活
    for (let i = 0; i < ids.length; i++) {
      // 检查是否取消
      if (cancelVerifyRef.current) {
        toast.info('已取消验活')
        break
      }

      const id = ids[i]

      // 更新当前凭据状态为 verifying
      setVerifyResults(prev => {
        const newResults = new Map(prev)
        newResults.set(id, { id, status: 'verifying' })
        return newResults
      })

      try {
        const balance = await getCredentialBalance(id)
        successCount++

        // 更新为成功状态
        setVerifyResults(prev => {
          const newResults = new Map(prev)
          newResults.set(id, {
            id,
            status: 'success',
            usage: `${balance.currentUsage}/${balance.usageLimit}`
          })
          return newResults
        })
      } catch (error) {
        // 更新为失败状态
        setVerifyResults(prev => {
          const newResults = new Map(prev)
          newResults.set(id, {
            id,
            status: 'failed',
            error: extractErrorMessage(error)
          })
          return newResults
        })
      }

      // 更新进度
      setVerifyProgress({ current: i + 1, total: ids.length })

      // 添加延迟防止封号（最后一个不需要延迟）
      if (i < ids.length - 1 && !cancelVerifyRef.current) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    setVerifying(false)

    if (!cancelVerifyRef.current) {
      toast.success(`验活完成：成功 ${successCount}/${ids.length}`)
    }
  }

  // 取消验活
  const handleCancelVerify = () => {
    cancelVerifyRef.current = true
    setVerifying(false)
  }

  // 切换负载均衡模式
  const handleToggleLoadBalancing = () => {
    const currentMode = loadBalancingData?.mode || 'priority'
    const newMode = currentMode === 'priority' ? 'balanced' : 'priority'

    setLoadBalancingMode(newMode, {
      onSuccess: () => {
        const modeName = newMode === 'priority' ? '优先级模式' : '均衡负载模式'
        toast.success(`已切换到${modeName}`)
      },
      onError: (error) => {
        toast.error(`切换失败: ${extractErrorMessage(error)}`)
      }
    })
  }

  const totalCredentials = data?.total || 0
  const availableCredentials = data?.available || 0

  if (isLoading) {
    return (
      <div className="admin-shell flex min-h-screen items-center justify-center p-6">
        <div className="control-deck w-full max-w-sm p-8 text-center">
          <div className="brand-mark mx-auto mb-5">
            <Server className="h-5 w-5" />
          </div>
          <div className="mx-auto mb-4 h-1.5 w-24 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-2/3 animate-pulse rounded-full bg-primary" />
          </div>
          <p className="font-console-display text-lg">正在接入控制平面</p>
          <p className="mt-1 text-sm text-muted-foreground">同步凭据与运行状态...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="admin-shell flex min-h-screen items-center justify-center p-4">
        <Card className="control-deck w-full max-w-md border-destructive/30">
          <CardContent className="pt-6 text-center">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-destructive/10 text-destructive">
              <Activity className="h-5 w-5" />
            </div>
            <div className="font-console-display mb-2 text-xl">控制平面连接失败</div>
            <p className="text-muted-foreground mb-4">{(error as Error).message}</p>
            <div className="space-x-2">
              <Button onClick={() => refetch()}>重试</Button>
              <Button variant="outline" onClick={handleLogout}>重新登录</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="admin-shell">
      {/* 顶部导航 */}
      <header className="admin-topbar">
        <div className="mx-auto flex min-h-[64px] max-w-[1600px] items-center justify-between gap-4 px-4 py-2.5 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="brand-mark shrink-0">
              <Server className="h-5 w-5" />
            </div>
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="truncate text-[17px] font-bold leading-none tracking-[-0.025em]">Kiro Admin</div>
              <span className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
              <div className="hidden items-center gap-1.5 text-xs font-medium text-muted-foreground sm:flex">
                <span className="telemetry-dot" aria-hidden="true" />
                <span className="whitespace-nowrap">凭据控制台</span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleLoadBalancing}
              disabled={isLoadingMode || isSettingMode}
              title="切换负载均衡模式"
              aria-label={`切换负载均衡模式，当前为${loadBalancingData?.mode === 'balanced' ? '均衡负载模式' : '优先级模式'}`}
              className="h-9 gap-2 rounded-xl bg-card/70 px-2.5 shadow-sm sm:px-3"
            >
              <Gauge className="h-4 w-4 text-primary" />
              <span className="hidden md:inline">
                {isLoadingMode ? '加载中...' : (loadBalancingData?.mode === 'priority' ? '优先级模式' : '均衡负载')}
              </span>
            </Button>
            <Button variant="ghost" size="icon" onClick={toggleDarkMode} className="h-9 w-9 rounded-xl" aria-label="切换深浅色主题" title="切换深浅色主题">
              {darkMode ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={handleRefresh} className="h-9 w-9 rounded-xl" aria-label="刷新凭据列表" title="刷新凭据列表">
              <RefreshCw className="h-[18px] w-[18px]" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleLogout} className="h-9 w-9 rounded-xl" aria-label="退出登录" title="退出登录">
              <LogOut className="h-[18px] w-[18px]" />
            </Button>
          </div>
        </div>
      </header>

      {/* 主内容 */}
      <main className="mx-auto max-w-[1680px] px-4 pb-10 pt-4 md:px-8">
        <section className="credential-toolbar mb-3" aria-labelledby="credential-list-title">
          <div className="credential-toolbar__summary">
            <div className="flex min-w-0 items-baseline gap-2.5">
              <h1 id="credential-list-title" className="whitespace-nowrap text-lg font-semibold tracking-tight">凭据管理</h1>
              <span className="text-xs tabular-nums text-muted-foreground">{data?.credentials.length || 0} 条</span>
            </div>
            <div className="credential-toolbar__stats" aria-label="凭据统计">
              <span className="credential-toolbar__stat"><span>总数</span><strong>{totalCredentials}</strong></span>
              <span className="credential-toolbar__stat"><span>可用</span><strong className="text-emerald-600 dark:text-emerald-400">{availableCredentials}</strong></span>
              <span className="credential-toolbar__stat"><span>当前</span><strong>#{data?.currentId || '-'}</strong></span>
            </div>
          </div>

          <div className="credential-toolbar__actions [&_button]:rounded-lg">
                {verifying && !verifyDialogOpen && (
                  <Button onClick={() => setVerifyDialogOpen(true)} size="sm" variant="secondary" className="h-8 px-2.5 text-xs">
                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {verifyProgress.current}/{verifyProgress.total}
                  </Button>
                )}
                {data?.credentials && data.credentials.length > 0 && (
                  <Button
                    onClick={handleQueryCurrentPageInfo}
                    size="sm"
                    variant="outline"
                    className="h-8 px-2.5 text-xs"
                    disabled={queryingInfo}
                    title="更新当前页凭据额度"
                  >
                    <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${queryingInfo ? 'animate-spin' : ''}`} />
                    {queryingInfo ? `${queryInfoProgress.current}/${queryInfoProgress.total}` : '更新额度'}
                  </Button>
                )}
                {data?.credentials && data.credentials.length > 0 && (
                  <Button onClick={handleClearAll} size="sm" variant="outline" className="h-8 px-2.5 text-xs text-destructive hover:text-destructive">
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    清理禁用
                  </Button>
                )}
                <Button onClick={() => setKamImportDialogOpen(true)} size="sm" variant="outline" className="h-8 px-2.5 text-xs" title="从 Kiro Account Manager 导入">
                  <FileUp className="mr-1.5 h-3.5 w-3.5" />
                  KAM 导入
                </Button>
                <Button onClick={() => setBatchImportDialogOpen(true)} size="sm" variant="outline" className="h-8 px-2.5 text-xs">
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  批量导入
                </Button>
                <Button onClick={() => setAddDialogOpen(true)} size="sm" className="h-8 px-2.5 text-xs shadow-[0_6px_18px_hsl(var(--primary)/0.18)]">
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  添加凭据
                </Button>
          </div>

          {selectedIds.size > 0 && (
              <div className="credential-toolbar__selection">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="rounded-full">已选 {selectedIds.size}</Badge>
                  <Button onClick={deselectAll} size="sm" variant="ghost" className="h-7 rounded-full px-2 text-xs">取消</Button>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5 [&_button]:h-7 [&_button]:rounded-lg [&_button]:px-2 [&_button]:text-xs">
                  <Button onClick={handleBatchVerify} size="sm" variant="outline"><CheckCircle2 className="mr-1 h-3.5 w-3.5" />验活</Button>
                  <Button onClick={handleBatchForceRefresh} size="sm" variant="outline" disabled={batchRefreshing}>
                    <RefreshCw className={`mr-1 h-3.5 w-3.5 ${batchRefreshing ? 'animate-spin' : ''}`} />
                    {batchRefreshing ? `${batchRefreshProgress.current}/${batchRefreshProgress.total}` : '刷新 Token'}
                  </Button>
                  <Button onClick={handleBatchResetFailure} size="sm" variant="outline"><RotateCcw className="mr-1 h-3.5 w-3.5" />恢复</Button>
                  <Button onClick={handleBatchDelete} size="sm" variant="destructive"><Trash2 className="mr-1 h-3.5 w-3.5" />删除</Button>
                </div>
              </div>
          )}
        </section>

        {/* 凭据列表 */}
        <div className="space-y-3">
          {data?.credentials.length === 0 ? (
            <Card className="control-deck border-dashed">
              <CardContent className="flex flex-col items-center py-14 text-center">
                <div className="metric-icon mb-4 h-12 w-12 rounded-2xl">
                  <Database className="h-5 w-5" />
                </div>
                <div className="font-console-display text-xl text-foreground">凭据池还是空的</div>
                <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">添加单个凭据，或使用批量导入快速建立可调度的账号池。</p>
                <Button onClick={() => setAddDialogOpen(true)} size="sm" className="mt-5 rounded-xl">
                  <Plus className="mr-2 h-4 w-4" />
                  添加第一条凭据
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="credential-grid grid gap-3">
                {currentCredentials.map((credential) => (
                  <CredentialCard
                    key={credential.id}
                    credential={credential}
                    onViewBalance={handleViewBalance}
                    selected={selectedIds.has(credential.id)}
                    onToggleSelect={() => toggleSelect(credential.id)}
                    balance={balanceMap.get(credential.id) || null}
                    loadingBalance={loadingBalanceIds.has(credential.id)}
                  />
                ))}
              </div>

              {/* 分页控件 */}
              {totalPages > 1 && (
                <div className="control-deck mt-7 flex flex-wrap items-center justify-center gap-3 px-4 py-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-xl bg-background/60"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    上一页
                  </Button>
                  <span className="px-2 text-center text-xs font-semibold tabular-nums text-muted-foreground sm:text-sm">
                    第 {currentPage} / {totalPages} 页（共 {data?.credentials.length} 个凭据）
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-xl bg-background/60"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {/* 余额对话框 */}
      <BalanceDialog
        credentialId={selectedCredentialId}
        open={balanceDialogOpen}
        onOpenChange={setBalanceDialogOpen}
      />

      {/* 添加凭据对话框 */}
      <AddCredentialDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
      />

      {/* 批量导入对话框 */}
      <BatchImportDialog
        open={batchImportDialogOpen}
        onOpenChange={setBatchImportDialogOpen}
      />

      {/* KAM 账号导入对话框 */}
      <KamImportDialog
        open={kamImportDialogOpen}
        onOpenChange={setKamImportDialogOpen}
      />

      {/* 批量验活对话框 */}
      <BatchVerifyDialog
        open={verifyDialogOpen}
        onOpenChange={setVerifyDialogOpen}
        verifying={verifying}
        progress={verifyProgress}
        results={verifyResults}
        onCancel={handleCancelVerify}
      />
    </div>
  )
}
