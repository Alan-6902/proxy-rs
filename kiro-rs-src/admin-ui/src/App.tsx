import { useState, useEffect } from 'react'
import { storage } from '@/lib/storage'
import { LoginPage } from '@/components/login-page'
import { Dashboard } from '@/components/dashboard'
import { AntigravityPage } from '@/components/antigravity-page'
import { Toaster } from '@/components/ui/sonner'

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const antigravity = window.location.pathname.replace(/\/$/, '') === '/admin/antigravity'

  useEffect(() => {
    document.title = antigravity ? 'Antigravity 反代' : 'Kiro Admin'
  }, [antigravity])

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

  return (
    <>
      {isLoggedIn ? (
        antigravity ? <AntigravityPage onLogout={handleLogout} /> : <Dashboard onLogout={handleLogout} />
      ) : (
        <LoginPage onLogin={handleLogin} title={antigravity ? 'Antigravity 反代' : 'Kiro Admin'} />
      )}
      <Toaster position="top-right" />
    </>
  )
}

export default App
