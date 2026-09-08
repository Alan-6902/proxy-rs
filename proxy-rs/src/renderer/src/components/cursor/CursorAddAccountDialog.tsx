import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Database,
  ExternalLink,
  FileJson,
  Globe,
  KeyRound,
  Loader2,
  Plus,
  ShieldOff,
  Upload
} from 'lucide-react'
import type { CursorAccount } from '../../../../shared/cursorAccounts'
import { Button, SegmentedTabs, type SegmentedTabItem } from '../ui'
import { CursorDialogShell } from './CursorDialogShell'
import { errorText } from './_helpers'

type AddTab = 'oauth' | 'token' | 'json' | 'local'

const TAB_ITEMS: SegmentedTabItem<AddTab>[] = [
  { value: 'token', label: 'Cookie / Token', icon: KeyRound },
  { value: 'oauth', label: '浏览器登录', icon: Globe },
  { value: 'json', label: 'JSON 导入', icon: FileJson },
  { value: 'local', label: '本机导入', icon: Database }
]

const TOKEN_PLACEHOLDER = `user_01ABC...::eyJhbGciOiJIUzI1NiIs...
eyJhbGciOiJIUzI1NiIs...
每行一条，可一次贴多个；整段 Cookie 头或浏览器导出的 cookie JSON 也行`
const JSON_PLACEHOLDER = `[
  { "access_token": "eyJhbGciOiJIUzI1NiIs...", "email": "a@example.com" },
  { "access_token": "eyJhbGciOiJIUzI1NiIs...", "email": "b@example.com" }
]`

const TEXTAREA_CLASS =
  'w-full rounded-lg border border-foreground/15 bg-[var(--glass-bg)] px-3 py-2 font-mono text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/30'

interface CursorAddAccountDialogProps {
  open: boolean
  onClose: () => void
  /** 入库成功后回调；message 用于页面顶部提示，warning 是部分失败时的明细。 */
  onAdded: (accounts: CursorAccount[], message: string, warning?: string) => void
}

export function CursorAddAccountDialog({
  open,
  onClose,
  onAdded
}: CursorAddAccountDialogProps): React.ReactNode {
  const [tab, setTab] = useState<AddTab>('token')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [token, setToken] = useState('')
  const [json, setJson] = useState('')
  const [oauthUrl, setOauthUrl] = useState('')
  const [oauthLoginId, setOauthLoginId] = useState('')
  const [urlCopied, setUrlCopied] = useState(false)
  const [usedIncognito, setUsedIncognito] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeLoginIdRef = useRef('')

  const resetOauth = useCallback((): void => {
    activeLoginIdRef.current = ''
    setOauthUrl('')
    setOauthLoginId('')
    setUsedIncognito(false)
  }, [])

  const cancelOauth = useCallback((): void => {
    const loginId = activeLoginIdRef.current
    if (loginId) void window.api.cursorAccountsOAuthCancel(loginId)
    if (usedIncognito) window.api.closeIncognitoBrowser()
    resetOauth()
  }, [resetOauth, usedIncognito])

  const handleClose = useCallback((): void => {
    cancelOauth()
    setError('')
    onClose()
  }, [cancelOauth, onClose])

  // 弹窗被卸载时把进行中的登录会话一并取消，避免主进程继续轮询 5 分钟
  useEffect(() => {
    if (!open) return undefined
    return () => {
      const loginId = activeLoginIdRef.current
      if (loginId) void window.api.cursorAccountsOAuthCancel(loginId)
    }
  }, [open])

  const finish = (accounts: CursorAccount[], message: string, warning?: string): void => {
    onAdded(accounts, message, warning)
    setToken('')
    setJson('')
    setError('')
    resetOauth()
    onClose()
  }

  const startOauth = async (incognito: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const started = await window.api.cursorAccountsOAuthStart()
      if (!started.success) throw new Error(started.error)
      const { loginId, verificationUri } = started.data
      activeLoginIdRef.current = loginId
      setOauthLoginId(loginId)
      setOauthUrl(verificationUri)
      setUsedIncognito(incognito)
      if (incognito) window.api.openIncognitoBrowser(verificationUri)
      else window.api.openExternal(verificationUri)

      const completed = await window.api.cursorAccountsOAuthComplete(loginId)
      // 用户已取消或重新发起了新会话，这次结果作废
      if (activeLoginIdRef.current !== loginId) return
      if (incognito) window.api.closeIncognitoBrowser()
      if (!completed.success) throw new Error(completed.error)
      finish([completed.data], `已登录并保存 ${completed.data.email || completed.data.id}`)
    } catch (loginError) {
      setError(errorText(loginError, '登录失败'))
      resetOauth()
    } finally {
      setBusy(false)
    }
  }

  const copyOauthUrl = async (): Promise<void> => {
    await navigator.clipboard.writeText(oauthUrl)
    setUrlCopied(true)
    setTimeout(() => setUrlCopied(false), 1500)
  }

  const submitToken = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.api.cursorAccountsAddToken(token)
      if (!result.success) throw new Error(result.error)
      const { added, failed } = result.data
      const failedText = failed.map((item) => `${item.label}: ${item.error}`).join('\n')
      if (added.length === 0) {
        throw new Error(failedText || '没有可入库的凭据')
      }
      const withoutRefresh = added.filter((item) => !item.viaHandshake).length
      const emails = added.map((item) => item.account.email || item.account.id).join('、')
      const message =
        `已添加 ${added.length} 个账号：${emails}` +
        (withoutRefresh > 0 ? `（${withoutRefresh} 个握手未通过，只按 access token 入库）` : '')
      finish(
        added.map((item) => item.account),
        message,
        failed.length > 0 ? `${failed.length} 条失败：\n${failedText}` : undefined
      )
    } catch (submitError) {
      setError(errorText(submitError, '保存失败'))
    } finally {
      setBusy(false)
    }
  }

  const submitJson = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.api.cursorAccountsImportJson(json)
      if (!result.success) throw new Error(result.error)
      finish(result.data, `已导入 ${result.data.length} 个账号`)
    } catch (submitError) {
      setError(errorText(submitError, '导入失败'))
    } finally {
      setBusy(false)
    }
  }

  const submitLocal = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.api.cursorAccountsImportLocal()
      if (!result.success) throw new Error(result.error)
      finish([result.data], `已从本机 Cursor 导入 ${result.data.email || result.data.id}`)
    } catch (submitError) {
      setError(errorText(submitError, '导入失败'))
    } finally {
      setBusy(false)
    }
  }

  const submitCockpit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await window.api.cursorAccountsImportCockpit()
      if (!result.success) throw new Error(result.error)
      const { imported, skipped } = result.data
      const skippedText = skipped.map((item) => `${item.id}: ${item.error}`).join('\n')
      if (imported.length === 0) throw new Error(skippedText || '没有可导入的账号')
      finish(
        imported,
        `已从 Cockpit Tools 导入 ${imported.length} 个账号（同一账号已合并）`,
        skipped.length > 0 ? `${skipped.length} 个跳过：\n${skippedText}` : undefined
      )
    } catch (submitError) {
      setError(errorText(submitError, '从 Cockpit Tools 导入失败'))
    } finally {
      setBusy(false)
    }
  }

  const pickJsonFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      setJson(await file.text())
      setError('')
    } catch (readError) {
      setError(errorText(readError, '读取文件失败'))
    }
  }

  const waiting = Boolean(oauthLoginId)

  return (
    <CursorDialogShell
      open={open}
      onClose={handleClose}
      title="添加 Cursor 账号"
      icon={Plus}
      footer={
        <>
          <Button
            variant="outline"
            onClick={waiting ? cancelOauth : handleClose}
            disabled={busy && !waiting}
          >
            {waiting ? '取消登录' : '关闭'}
          </Button>
          {tab === 'token' && (
            <Button onClick={() => void submitToken()} disabled={busy || !token.trim()}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              {busy ? '握手并入库…' : '添加'}
            </Button>
          )}
          {tab === 'json' && (
            <Button onClick={() => void submitJson()} disabled={busy || !json.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              导入
            </Button>
          )}
          {tab === 'local' && (
            <>
              <Button variant="outline" onClick={() => void submitCockpit()} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Database className="h-4 w-4" />
                )}
                从 Cockpit Tools 导入全部
              </Button>
              <Button onClick={() => void submitLocal()} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Database className="h-4 w-4" />
                )}
                从本机 Cursor 导入
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <SegmentedTabs
          value={tab}
          items={TAB_ITEMS}
          onChange={(next) => {
            if (waiting) cancelOauth()
            setError('')
            setTab(next)
          }}
          layoutId="cursor-add-tabs"
          size="sm"
          ariaLabel="添加方式"
          disabled={busy && !waiting}
        />

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        )}

        {tab === 'oauth' && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              在浏览器里完成 Cursor 登录，token 会自动回到这里入库。要加第二个号时用无痕窗口，
              否则浏览器会直接用当前已登录的 Cursor 账号。
            </p>
            {!waiting ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void startOauth(false)} disabled={busy}>
                  <Globe className="h-4 w-4" />
                  用系统浏览器登录
                </Button>
                <Button variant="outline" onClick={() => void startOauth(true)} disabled={busy}>
                  <ShieldOff className="h-4 w-4" />
                  用无痕窗口登录
                </Button>
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border border-border/60 p-3">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  等待浏览器完成登录…（最长 5 分钟）
                </div>
                <p className="break-all rounded-lg bg-muted px-2.5 py-2 font-mono text-2xs text-muted-foreground">
                  {oauthUrl}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void copyOauthUrl()}>
                    {urlCopied ? (
                      <Check className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                    复制链接
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      usedIncognito
                        ? window.api.openIncognitoBrowser(oauthUrl)
                        : window.api.openExternal(oauthUrl)
                    }
                  >
                    <ExternalLink className="h-4 w-4" />
                    重新打开
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'token' && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              直接粘贴 <code className="rounded bg-muted px-1">WorkosCursorSessionToken</code> 的
              cookie 值。我会用它替你完成一次 Cursor 登录握手，换回带 refresh token
              的正式凭据再入库，然后自动拉取邮箱、套餐与用量——不用再开无痕窗口手动加 cookie。裸
              access token 也可以。
            </p>
            <textarea
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={TOKEN_PLACEHOLDER}
              rows={6}
              spellCheck={false}
              className={TEXTAREA_CLASS}
            />
          </div>
        )}

        {tab === 'json' && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              支持本应用导出的 JSON、cockpit-tools 导出的 JSON，以及只含
              <code className="mx-1 rounded bg-muted px-1">access_token</code>/
              <code className="mx-1 rounded bg-muted px-1">email</code>
              的最简数组。同一账号重复导入会合并而不是新建。
            </p>
            <textarea
              value={json}
              onChange={(event) => setJson(event.target.value)}
              placeholder={JSON_PLACEHOLDER}
              rows={8}
              spellCheck={false}
              className={TEXTAREA_CLASS}
            />
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(event) => void pickJsonFile(event)}
              />
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4" />
                选择 JSON 文件
              </Button>
            </div>
          </div>
        )}

        {tab === 'local' && (
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">从本机 Cursor 导入</span>
              ：读取 Cursor 客户端当前登录的账号（来自它的 state.vscdb），Cursor 不需要退出。
            </p>
            <p>
              <span className="font-medium text-foreground">从 Cockpit Tools 导入全部</span>
              ：解开 <code className="rounded bg-muted px-1">~/.antigravity_cockpit</code> 里
              cockpit-tools 的加密账号库，把它所有 Cursor 账号（含标签、套餐、用量）一次导进来，
              同一账号自动合并。cockpit-tools 那边的数据不会被改动。
            </p>
          </div>
        )}
      </div>
    </CursorDialogShell>
  )
}
