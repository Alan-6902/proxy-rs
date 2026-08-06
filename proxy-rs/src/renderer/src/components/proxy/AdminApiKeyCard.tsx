import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, KeyRound, RefreshCw, ShieldOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { askConfirm } from '@/components/ui/confirmDialogStore'

export function AdminApiKeyCard({ isEn }: { isEn: boolean }): React.ReactNode {
  const [configured, setConfigured] = useState(false)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [manualKey, setManualKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const result = await window.api.proxyAdminKeyStatus()
      setConfigured(result.configured)
      if ('success' in result && result.success === false)
        setError(isEn ? 'Unable to read admin key status.' : '无法读取管理员密钥状态。')
    } catch {
      setError(isEn ? 'Unable to read admin key status.' : '无法读取管理员密钥状态。')
    }
  }, [isEn])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const reveal = async (
    operation: () => Promise<{ success: boolean; adminApiKey?: string; error?: string }>
  ) => {
    setBusy(true)
    try {
      const result = await operation()
      if (result.success && result.adminApiKey) {
        setError(null)
        setConfigured(true)
        setRevealedKey(result.adminApiKey)
        setManualKey('')
      } else {
        setError(isEn ? 'Unable to update admin API key.' : '无法更新管理员 API 密钥。')
      }
    } catch {
      setError(isEn ? 'Unable to update admin API key.' : '无法更新管理员 API 密钥。')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!revealedKey) return
    try {
      await navigator.clipboard.writeText(revealedKey)
      setError(null)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setError(isEn ? 'Unable to copy admin API key.' : '无法复制管理员 API 密钥。')
    }
  }

  const clear = async () => {
    if (
      !(await askConfirm({
        title: isEn ? 'Revoke this admin API key?' : '确定撤销该管理员 API 密钥？',
        description: isEn
          ? 'Existing admin clients will immediately lose access and must be reconfigured with a new key.'
          : '现有管理客户端将立即失去访问权限，需要用新密钥重新配置。',
        confirmText: isEn ? 'Revoke' : '撤销',
        cancelText: isEn ? 'Cancel' : '取消',
        tone: 'danger'
      }))
    )
      return
    setBusy(true)
    try {
      const result = await window.api.proxyAdminKeyClear()
      if (result.success) {
        setError(null)
        setConfigured(false)
        setRevealedKey(null)
      } else setError(isEn ? 'Unable to revoke admin API key.' : '无法撤销管理员 API 密钥。')
    } catch {
      setError(isEn ? 'Unable to revoke admin API key.' : '无法撤销管理员 API 密钥。')
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    if (
      configured &&
      !(await askConfirm({
        title: isEn ? 'Rotate this admin API key?' : '确定轮换该管理员 API 密钥？',
        description: isEn
          ? 'Existing admin clients will lose access until they are updated with the new key.'
          : '现有管理客户端在更新为新密钥前将失去访问权限。',
        confirmText: isEn ? 'Rotate' : '轮换',
        cancelText: isEn ? 'Cancel' : '取消',
        tone: 'warning'
      }))
    )
      return
    await reveal(() => window.api.proxyAdminKeyRotate())
  }

  const setManual = async () => {
    if (
      configured &&
      !(await askConfirm({
        title: isEn ? 'Replace this admin API key?' : '确定替换该管理员 API 密钥？',
        description: isEn
          ? 'Existing admin clients will lose access until they are updated with the new key.'
          : '现有管理客户端在更新为新密钥前将失去访问权限。',
        confirmText: isEn ? 'Replace' : '替换',
        cancelText: isEn ? 'Cancel' : '取消',
        tone: 'warning'
      }))
    )
      return
    await reveal(() => window.api.proxyAdminKeySet(manualKey))
  }

  return (
    <Card className="border-amber-500/30">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-amber-600" />
          <CardTitle className="text-lg">{isEn ? 'Admin API Key' : '管理员 API 密钥'}</CardTitle>
        </div>
        <CardDescription>
          {isEn
            ? 'Separate credential for /admin/* only. It cannot call model APIs.'
            : '仅用于 /admin/* 的独立高权限凭证，不能调用模型接口。'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm">
          {configured
            ? isEn
              ? 'Configured'
              : '已配置'
            : isEn
              ? 'Not configured: Admin API is disabled.'
              : '未配置：管理 API 已禁用。'}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {revealedKey && (
          <div className="flex gap-2">
            <Input readOnly value={revealedKey} aria-label="Admin API key shown once" />
            <Button variant="outline" onClick={copy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void rotate()} disabled={busy}>
            <RefreshCw className="mr-1 h-4 w-4" />
            {configured ? (isEn ? 'Rotate' : '轮换') : isEn ? 'Generate' : '生成'}
          </Button>
          {configured && (
            <Button variant="outline" onClick={() => void clear()} disabled={busy}>
              <ShieldOff className="mr-1 h-4 w-4" />
              {isEn ? 'Revoke' : '撤销'}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Input
            type="password"
            value={manualKey}
            onChange={(event) => setManualKey(event.target.value)}
            placeholder={isEn ? 'Paste an admin key' : '粘贴管理员密钥'}
          />
          <Button
            variant="outline"
            disabled={busy || !manualKey.trim()}
            onClick={() => void setManual()}
          >
            {isEn ? 'Set' : '手动录入'}
          </Button>
        </div>
        {revealedKey && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {isEn
              ? 'Copy it now. The key is only shown for this operation.'
              : '请现在复制；密钥仅在本次操作中展示。'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
