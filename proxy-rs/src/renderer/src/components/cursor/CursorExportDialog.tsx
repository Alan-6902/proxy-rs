import { useEffect, useState } from 'react'
import { Check, Clipboard, Download, Eye, EyeOff, Loader2 } from 'lucide-react'
import { Badge, Button } from '../ui'
import { CursorDialogShell } from './CursorDialogShell'
import { errorText } from './_helpers'

interface CursorExportDialogProps {
  /** 要导出的账号 id；null 表示关闭。 */
  ids: string[] | null
  onClose: () => void
  onExported: (message: string) => void
}

/** 预览时把 token 打码，避免录屏 / 截图时泄露；复制与保存的是完整内容。 */
function maskTokens(json: string): string {
  return json.replace(
    /("(?:accessToken|refreshToken)"\s*:\s*")([^"]{12})[^"]*(")/g,
    (_match, prefix: string, head: string, suffix: string) => `${prefix}${head}…${suffix}`
  )
}

export function CursorExportDialog({
  ids,
  onClose,
  onExported
}: CursorExportDialogProps): React.ReactNode {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!ids) return
    let cancelled = false
    setLoading(true)
    setError('')
    setContent('')
    setRevealed(false)
    void window.api
      .cursorAccountsExport(ids)
      .then((result) => {
        if (cancelled) return
        if (!result.success) throw new Error(result.error)
        setContent(result.data)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorText(loadError, '导出失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ids])

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const filename = `cursor-accounts-${new Date().toISOString().slice(0, 10)}.json`
      const ok = await window.api.exportToFile(content, filename)
      if (ok) {
        onExported(`已导出 ${ids?.length ?? 0} 个 Cursor 账号到 ${filename}`)
        onClose()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <CursorDialogShell
      open={ids !== null}
      onClose={onClose}
      title="导出 Cursor 账号"
      icon={Download}
      badge={<Badge variant="secondary">{ids?.length ?? 0} 个</Badge>}
      widthClassName="w-[640px]"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button variant="outline" onClick={() => void copy()} disabled={!content || copied}>
            {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
            {copied ? '已复制' : '复制 JSON'}
          </Button>
          <Button onClick={() => void save()} disabled={!content || saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            保存文件
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          JSON 含 access / refresh token 明文，可直接再导回本应用或 cockpit-tools。请妥善保管。
        </p>
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">预览</span>
          <Button size="sm" variant="ghost" onClick={() => setRevealed((prev) => !prev)}>
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            {revealed ? '隐藏 token' : '显示 token'}
          </Button>
        </div>
        {loading ? (
          <div className="grid h-24 place-items-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <pre className="max-h-[45vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-2xs leading-relaxed">
            {revealed ? content : maskTokens(content)}
          </pre>
        )}
      </div>
    </CursorDialogShell>
  )
}
