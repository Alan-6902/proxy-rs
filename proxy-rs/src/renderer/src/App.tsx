import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AccountManager } from './components/accounts'
import { Sidebar, TitleBar, type PageType } from './components/layout'
import {
  HomePage,
  AboutPage,
  SettingsPage,
  ProxyPoolPage,
  DiagnosePage,
  ConfigSyncPage,
  RegisterPage,
  SeatsPage,
  LogsPage,
  TaskManagerPage
} from './components/pages'
import { CloseConfirmDialog } from './components/CloseConfirmDialog'
import { ConfirmDialogHost } from './components/ui'
import { useAccountsStore } from './store/accounts'

// 托盘信息防抖延迟：后台刷新风暴时合并多次跨进程 IPC 为单次
const TRAY_UPDATE_DEBOUNCE_MS = 400
// 后台刷新结果批量化间隔：N 条结果合并到一次 set，避免 N 次 Map 全量复制 + 渲染抖动
const BACKGROUND_RESULT_FLUSH_MS = 120
const LEGACY_WEBHOOK_STORAGE_KEY = 'kiro-webhooks'
const SETTINGS_SHORTCUT_KEY = ','

function App(): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState<PageType>('home')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)

  useEffect(() => {
    const openSettings = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === SETTINGS_SHORTCUT_KEY) {
        event.preventDefault()
        setCurrentPage('settings')
      }
    }
    window.addEventListener('keydown', openSettings)
    return () => window.removeEventListener('keydown', openSettings)
  }, [])

  const {
    loadFromStorage,
    stopAutoTokenRefresh,
    applyBackgroundRefreshResults,
    applyBackgroundCheckResults,
    flushSaveImmediately,
    accounts,
    activeAccountId,
    setActiveAccount,
    checkAndRefreshExpiringTokens
  } = useAccountsStore()

  // 切换到下一个可用账户
  const switchToNextAccount = useCallback(() => {
    const activeAccounts = Array.from(accounts.values()).filter((acc) => acc.status === 'active')
    if (activeAccounts.length <= 1) return

    const currentIndex = activeAccounts.findIndex((acc) => acc.id === activeAccountId)
    const nextIndex = (currentIndex + 1) % activeAccounts.length
    setActiveAccount(activeAccounts[nextIndex].id)
  }, [accounts, activeAccountId, setActiveAccount])

  // 托盘信息防抖：账号 Map 频繁变更（后台刷新风暴）时合并 N 次 IPC 为 1 次
  const trayDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateTrayInfo = useCallback(() => {
    if (trayDebounceRef.current) clearTimeout(trayDebounceRef.current)
    trayDebounceRef.current = setTimeout(() => {
      trayDebounceRef.current = null
      const currentState = useAccountsStore.getState()
      const currentAccounts = currentState.accounts
      const currentActiveId = currentState.activeAccountId

      const accountList = Array.from(currentAccounts.values()).map((acc) => ({
        id: acc.id,
        email: acc.email || 'Unknown',
        idp: acc.idp || 'Unknown',
        status: acc.status
      }))
      window.api.updateTrayAccountList(accountList)

      if (currentActiveId) {
        const activeAccount = currentAccounts.get(currentActiveId)
        if (activeAccount) {
          window.api.updateTrayAccount({
            id: activeAccount.id,
            email: activeAccount.email || 'Unknown',
            idp: activeAccount.idp || 'Unknown',
            status: activeAccount.status,
            subscription: activeAccount.subscription?.title || undefined,
            usage: activeAccount.usage
              ? {
                  usedCredits: activeAccount.usage.current || 0,
                  totalCredits: activeAccount.usage.limit || 0,
                  totalRequests: 0,
                  successRequests: 0,
                  failedRequests: 0
                }
              : undefined
          })
        } else {
          window.api.updateTrayAccount(null)
        }
      } else {
        window.api.updateTrayAccount(null)
      }
    }, TRAY_UPDATE_DEBOUNCE_MS)
  }, [])

  // 应用启动时加载本地数据并恢复自动化。
  useEffect(() => {
    void loadFromStorage()
    localStorage.removeItem(LEGACY_WEBHOOK_STORAGE_KEY)

    return () => {
      stopAutoTokenRefresh()
    }
  }, [loadFromStorage, stopAutoTokenRefresh])

  // 主进程自动拉取 KSK 后刷新账号视图；事件不携带凭证明文。
  useEffect(() => {
    return window.api.onKskAutomationAccountsChanged(() => {
      void loadFromStorage()
    })
  }, [loadFromStorage])

  // 应用内页面跳转（轻量 CustomEvent，供深层组件无需 prop 钻取即可切页）
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<PageType>).detail
      if (detail) setCurrentPage(detail)
    }
    window.addEventListener('navigate-page', handler)
    return () => window.removeEventListener('navigate-page', handler)
  }, [])

  // 本机通知点击后跳转到对应页面。
  useEffect(() => {
    const unsubscribe = window.api.onLocalNotificationNavigate((page) => setCurrentPage(page))
    return () => unsubscribe()
  }, [])

  // 关闭/刷新前强制 flush 防抖中的待保存数据，防止数据丢失
  useEffect(() => {
    const handleBeforeUnload = (): void => {
      void flushSaveImmediately().catch((error) => {
        console.error('Failed to flush accounts before unload:', error)
      })
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      if (trayDebounceRef.current) clearTimeout(trayDebounceRef.current)
    }
  }, [flushSaveImmediately])

  // 账户/激活变化时触发托盘更新（内部防抖 + 直接从 store 读取最新数据，避免 stale closure）
  useEffect(() => {
    updateTrayInfo()
  }, [accounts, activeAccountId, updateTrayInfo])

  // 监听托盘刷新账户事件
  useEffect(() => {
    const unsubscribe = window.api.onTrayRefreshAccount(() => {
      checkAndRefreshExpiringTokens()
      updateTrayInfo()
    })
    return () => {
      unsubscribe()
    }
  }, [checkAndRefreshExpiringTokens, updateTrayInfo])

  // 监听托盘切换账户事件
  useEffect(() => {
    const unsubscribe = window.api.onTraySwitchAccount(() => {
      switchToNextAccount()
    })
    return () => {
      unsubscribe()
    }
  }, [switchToNextAccount])

  // 监听后台刷新结果：缓冲 + 批量化 flush，N 条结果合并为一次 set，消除 Map 复制风暴
  useEffect(() => {
    const refreshBuffer: Array<{ id: string; success: boolean; data?: unknown; error?: string }> =
      []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flush = (): void => {
      flushTimer = null
      if (refreshBuffer.length === 0) return
      const batch = refreshBuffer.splice(0)
      applyBackgroundRefreshResults(batch)
    }

    const unsubscribe = window.api.onBackgroundRefreshResult((data) => {
      refreshBuffer.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flush, BACKGROUND_RESULT_FLUSH_MS)
      }
    })
    return () => {
      unsubscribe()
      if (flushTimer) {
        clearTimeout(flushTimer)
        // 卸载前 flush 剩余结果，防止丢失
        flush()
      }
    }
  }, [applyBackgroundRefreshResults])

  // 监听后台检查结果：同样的批量化策略
  useEffect(() => {
    const checkBuffer: Array<{ id: string; success: boolean; data?: unknown; error?: string }> = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flush = (): void => {
      flushTimer = null
      if (checkBuffer.length === 0) return
      const batch = checkBuffer.splice(0)
      applyBackgroundCheckResults(batch)
    }

    const unsubscribe = window.api.onBackgroundCheckResult((data) => {
      checkBuffer.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flush, BACKGROUND_RESULT_FLUSH_MS)
      }
    })
    return () => {
      unsubscribe()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flush()
      }
    }
  }, [applyBackgroundCheckResults])

  const renderPage = () => {
    switch (currentPage) {
      case 'home':
        return <HomePage />
      case 'accounts':
        return <AccountManager />
      case 'tasks':
        return <TaskManagerPage />
      case 'proxyPool':
        return <ProxyPoolPage />
      case 'register':
        return <RegisterPage />
      case 'seats':
        return <SeatsPage />
      case 'diagnose':
        return <DiagnosePage />
      case 'configSync':
        return <ConfigSyncPage />
      case 'logs':
        return <LogsPage />
      case 'settings':
        return <SettingsPage />
      case 'about':
        return <AboutPage />
      default:
        return <HomePage />
    }
  }

  return (
    <div className="h-screen ambient-bg overflow-hidden flex flex-col">
      <TitleBar />
      <div className="flex-1 min-h-0 flex gap-2 p-2">
        <Sidebar
          currentPage={currentPage}
          onPageChange={setCurrentPage}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
        <main className="flex-1 min-w-0 overflow-hidden rounded-3xl page-surface">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentPage}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="h-full flex flex-col"
            >
              {renderPage()}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <CloseConfirmDialog />
      <ConfirmDialogHost />
    </div>
  )
}

export default App
