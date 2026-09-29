import { useState, useCallback } from 'react'
import {
  Archive,
  Download,
  Upload,
  FileJson,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { Card, CardContent, CardHeader, CardTitle, Button, Label, Switch, PageHeader } from '../ui'
import { APP_NAME, APP_PACKAGE_NAME, APP_PORTABLE_CONFIG_ID } from '../../../../shared/appIdentity'

/**
 * 配置同步页面
 *
 * 把"非敏感的应用配置"（主题、语言、自动刷新等 App 设置）
 * 导出为单一 JSON 文件，方便在多台电脑之间同步。
 *
 * 敏感数据（账号凭据、refreshToken 等）不会被导出，
 * 它们走「账号管理 - 导出」专用通道（独立加密）。
 */

interface PortableConfig {
  version: 1 | 2
  exportedAt: string
  app: string
  /** v1 遗留字段：读取时忽略，避免恢复外部通知端点。 */
  webhooks?: Array<Record<string, unknown>>
  /** App 设置（部分非敏感字段） */
  appSettings?: {
    theme?: string
    darkMode?: boolean
    language?: string
    autoRefreshEnabled?: boolean
    autoRefreshInterval?: number
    autoRefreshConcurrency?: number
    statusCheckInterval?: number
    privacyMode?: boolean
    usagePrecision?: boolean
    autoSwitchEnabled?: boolean
    autoSwitchThreshold?: number
    autoSwitchInterval?: number
  }
}

export function ConfigSyncPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const store = useAccountsStore()

  // 导出选项（默认全开）
  const [opts, setOpts] = useState({
    appSettings: true,
    /** 启用密码加密：使用用户密码 + Web Crypto AES-GCM */
    encrypt: false
  })
  const [encryptPassword, setEncryptPassword] = useState('')

  const [lastExportSize, setLastExportSize] = useState<number | null>(null)
  const [lastImportResult, setLastImportResult] = useState<{
    success: boolean
    counts?: Record<string, number>
    ignoredLegacyWebhooks?: number
    error?: string
  } | null>(null)

  const handleExport = useCallback(async (): Promise<void> => {
    const payload: PortableConfig = {
      version: 2,
      exportedAt: new Date().toISOString(),
      app: APP_PORTABLE_CONFIG_ID
    }

    if (opts.appSettings) {
      payload.appSettings = {
        theme: store.theme,
        darkMode: store.darkMode,
        language: store.language,
        autoRefreshEnabled: store.autoRefreshEnabled,
        autoRefreshInterval: store.autoRefreshInterval,
        autoRefreshConcurrency: store.autoRefreshConcurrency,
        statusCheckInterval: store.statusCheckInterval,
        privacyMode: store.privacyMode,
        usagePrecision: store.usagePrecision,
        autoSwitchEnabled: store.autoSwitchEnabled,
        autoSwitchThreshold: store.autoSwitchThreshold,
        autoSwitchInterval: store.autoSwitchInterval
      }
    }

    let outputText = JSON.stringify(payload, null, 2)
    let extension = 'json'

    // C4: 可选加密
    if (opts.encrypt) {
      if (!encryptPassword.trim()) {
        alert(isEn ? 'Please enter encryption password' : '请输入加密密码')
        return
      }
      try {
        outputText = await encryptText(outputText, encryptPassword)
        extension = 'kcfg'
      } catch (err) {
        alert(isEn ? `Encryption failed: ${err}` : `加密失败: ${err}`)
        return
      }
    }

    setLastExportSize(outputText.length)

    const blob = new Blob([outputText], {
      type: opts.encrypt ? 'application/octet-stream' : 'application/json'
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${APP_PACKAGE_NAME}-config-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.${extension}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [opts, store, encryptPassword, isEn])

  const handleImport = useCallback(
    async (file: File): Promise<void> => {
      try {
        let text = await file.text()
        // C4: 加密文件自动识别 + 弹窗输入密码解密
        if (file.name.endsWith('.kcfg') || text.startsWith('KCFG1:')) {
          const pwd = prompt(isEn ? 'Enter decryption password:' : '请输入解密密码：')
          if (!pwd) return
          try {
            text = await decryptText(text, pwd)
          } catch (err) {
            setLastImportResult({
              success: false,
              error: `解密失败：${err instanceof Error ? err.message : String(err)}`
            })
            return
          }
        }
        const data = JSON.parse(text) as PortableConfig
        if (data.app !== APP_PORTABLE_CONFIG_ID) {
          setLastImportResult({
            success: false,
            error: `文件不是有效的 ${APP_NAME} 配置（app 标识不匹配）`
          })
          return
        }

        const counts: Record<string, number> = {}
        let ignoredLegacyWebhooks = 0

        // v1 Webhook 配置已退役；不读取、不恢复任何端点或凭据。
        if (data.webhooks && data.webhooks.length > 0) {
          ignoredLegacyWebhooks = data.webhooks.length
        }

        // App 设置
        if (data.appSettings) {
          const s = data.appSettings
          if (s.theme != null) store.setTheme(s.theme)
          if (s.darkMode != null) store.setDarkMode(s.darkMode)
          if (s.language != null) store.setLanguage(s.language as 'auto' | 'en' | 'zh')
          if (s.autoRefreshEnabled != null)
            store.setAutoRefresh(s.autoRefreshEnabled, s.autoRefreshInterval)
          if (s.autoRefreshConcurrency != null)
            store.setAutoRefreshConcurrency(s.autoRefreshConcurrency)
          if (s.statusCheckInterval != null) store.setStatusCheckInterval(s.statusCheckInterval)
          if (s.privacyMode != null) store.setPrivacyMode(s.privacyMode)
          if (s.usagePrecision != null) store.setUsagePrecision(s.usagePrecision)
          if (s.autoSwitchEnabled != null)
            store.setAutoSwitch(s.autoSwitchEnabled, s.autoSwitchThreshold, s.autoSwitchInterval)
          counts['App 设置'] = 1
        }

        setLastImportResult({ success: true, counts, ignoredLegacyWebhooks })
      } catch (err) {
        setLastImportResult({
          success: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },
    [store]
  )

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto stagger-children">
      <PageHeader
        accent="indigo"
        icon={Archive}
        eyebrow={isEn ? 'Data' : '数据'}
        title={isEn ? 'Config Sync' : '配置同步'}
        description={
          isEn
            ? 'Export & import non-sensitive app preferences for multi-device sync.'
            : '导出/导入非敏感的应用偏好，用于多设备同步'
        }
      />

      {/* 安全提示 */}
      <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/10">
        <CardContent className="py-3 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs space-y-1">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              {isEn ? 'Security Notice' : '安全提示'}
            </p>
            <p className="text-muted-foreground">
              {isEn
                ? 'This export does NOT include account credentials, refresh tokens, or other sensitive secrets — use "Account Export" (under Accounts page) for those.'
                : '本页导出"不包含"账号凭据、Refresh Token 等敏感数据。账号导出请走"账户管理 → 导出"专用通道。'}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 导出 */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Download className="h-4 w-4 text-primary" />
            {isEn ? 'Export' : '导出'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <ExportToggle
              label={
                isEn ? 'App Settings (theme/lang/auto-refresh)' : 'App 设置（主题/语言/自动刷新）'
              }
              checked={opts.appSettings}
              onChange={(v) => setOpts((p) => ({ ...p, appSettings: v }))}
            />
          </div>

          <div className="border-t pt-3 flex items-center gap-3 flex-wrap">
            {/* C4: 加密导出 */}
            <div className="flex items-center gap-2">
              <Switch
                checked={opts.encrypt}
                onCheckedChange={(v) => setOpts((p) => ({ ...p, encrypt: v }))}
              />
              <Label className="text-xs cursor-pointer flex items-center gap-1.5">
                <ShieldAlert className="h-3.5 w-3.5 text-green-500" />
                {isEn ? 'Encrypt (AES-GCM)' : '加密导出 (AES-GCM)'}
              </Label>
            </div>
            {opts.encrypt && (
              <input
                type="password"
                value={encryptPassword}
                onChange={(e) => setEncryptPassword(e.target.value)}
                placeholder={isEn ? 'Password...' : '加密密码...'}
                className="h-8 px-2 rounded-md border bg-background text-xs flex-1 max-w-xs"
              />
            )}
            <Button
              className="ml-auto"
              onClick={handleExport}
              disabled={opts.encrypt && !encryptPassword.trim()}
            >
              <FileJson className="h-4 w-4 mr-2" />
              {isEn ? 'Export' : '导出'}
            </Button>
          </div>

          {lastExportSize !== null && (
            <p className="text-2xs text-muted-foreground">
              {isEn
                ? `Last export: ${(lastExportSize / 1024).toFixed(1)} KB`
                : `上次导出大小: ${(lastExportSize / 1024).toFixed(1)} KB`}
            </p>
          )}
        </CardContent>
      </Card>

      {/* 导入 */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />
            {isEn ? 'Import' : '导入'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Label className="text-xs">
            {isEn
              ? 'Choose a previously exported config JSON. Duplicates will be merged/skipped automatically.'
              : '选择之前导出的配置 JSON 文件。重复项会自动合并/跳过。'}
          </Label>
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept="application/json,.json"
              className="text-xs"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleImport(file)
                e.currentTarget.value = ''
              }}
            />
          </div>

          {lastImportResult && (
            <div
              className={`p-3 rounded-lg border ${
                lastImportResult.success
                  ? 'border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/10'
                  : 'border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/10'
              }`}
            >
              {lastImportResult.success ? (
                <>
                  <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-300">
                    <CheckCircle2 className="h-4 w-4" />
                    {lastImportResult.ignoredLegacyWebhooks
                      ? isEn
                        ? 'Import Completed with Legacy Webhooks Ignored'
                        : '导入完成（已忽略旧版 Webhook）'
                      : isEn
                        ? 'Import Successful'
                        : '导入成功'}
                  </div>
                  {lastImportResult.ignoredLegacyWebhooks && (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                      {isEn
                        ? `${lastImportResult.ignoredLegacyWebhooks} legacy webhook configuration(s) were ignored and not imported.`
                        : `已忽略 ${lastImportResult.ignoredLegacyWebhooks} 条旧版 Webhook 配置，未导入。`}
                    </p>
                  )}
                  {lastImportResult.counts && (
                    <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
                      {Object.entries(lastImportResult.counts).map(([k, v]) => (
                        <div key={k} className="flex justify-between">
                          <span className="text-muted-foreground">{k}</span>
                          <span className="font-mono tabular-nums">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium">{isEn ? 'Import Failed' : '导入失败'}</div>
                    <div className="text-xs mt-0.5">{lastImportResult.error}</div>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ExportToggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.ReactNode {
  return (
    <label className="flex items-center gap-2 p-2 rounded hover:bg-muted/40 cursor-pointer">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-sm">{label}</span>
    </label>
  )
}

// ============ AES-GCM 加密辅助（C4） ============

const ENC_PREFIX = 'KCFG1:'
const PBKDF2_ITER = 100_000

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder()
  // 用 .slice() 拿到独立的 ArrayBuffer 视图，规避 TypeScript 5 严格 ArrayBufferLike 类型问题
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password).slice().buffer,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.slice().buffer, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i])
  return btoa(s)
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

async function encryptText(plaintext: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt)
  const plaintextBytes = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.slice().buffer },
    key,
    plaintextBytes.slice().buffer
  )
  return `${ENC_PREFIX}${b64encode(salt)}.${b64encode(iv)}.${b64encode(ciphertext)}`
}

async function decryptText(envelope: string, password: string): Promise<string> {
  if (!envelope.startsWith(ENC_PREFIX)) throw new Error('Not an encrypted KCFG payload')
  const parts = envelope.slice(ENC_PREFIX.length).split('.')
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format')
  const [saltB64, ivB64, ctB64] = parts
  const salt = b64decode(saltB64)
  const iv = b64decode(ivB64)
  const ct = b64decode(ctB64)
  const key = await deriveKey(password, salt)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.slice().buffer },
    key,
    ct.slice().buffer
  )
  return new TextDecoder().decode(plaintext)
}
