import { useState, useEffect } from 'react'
import { storage } from '@/lib/storage'
import { LoginPage } from '@/components/login-page'
import { Dashboard } from '@/components/dashboard'
import { AntigravityPage } from '@/components/antigravity-page'
import { QoderPage } from '@/components/qoder-page'
import { Toaster } from '@/components/ui/sonner'

/** 同一份前端由三个进程各自托管，按管理路径区分页面 */
const PAGE_TITLES = {
  kiro: 'Kiro Admin',
  antigravity: 'Antigravity 反代',
  qoder: 'Qoder 反代',
} as const

type Page = keyof typeof PAGE_TITLES

const currentPage = (): Page => {
  const path = window.location.pathname.replace(/\/$/, '')
  if (path === '/admin/antigravity') return 'antigravity'
  if (path === '/admin/qoder') return 'qoder'
  return 'kiro'
}

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const page = currentPage()

  useEffect(() => {
    document.title = PAGE_TITLES[page]
  }, [page])

  useEffect(() => {
    // 检查是否已经有保存的 API Key
    if (storage.getApiKey()) {
      setIsLoggedIn(true)
    }
  }, [])

  const handleLogin = () => {
    setIsLoggedIn(true)
  }

  const handleLogout = () => {
    storage.removeApiKey()
    setIsLoggedIn(false)
  }

  const content = page === 'antigravity'
    ? <AntigravityPage onLogout={handleLogout} />
    : page === 'qoder'
      ? <QoderPage onLogout={handleLogout} />
      : <Dashboard onLogout={handleLogout} />

  return (
    <>
      {isLoggedIn ? content : <LoginPage onLogin={handleLogin} title={PAGE_TITLES[page]} />}
      <Toaster position="top-right" />
    </>
  )
}

export default App
