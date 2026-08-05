import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, DatabaseZap, RefreshCw, ShieldAlert } from 'lucide-react'
import type {
  LegacyKiroRsMigrationIpcErrorCode,
  LegacyKiroRsMigrationIpcScanPreview,
  LegacyKiroRsMigrationIpcSelection
} from '../../../../shared/legacyKiroRsMigrationIpc'
import { Button, Card, CardContent, CardHeader, CardTitle, Label, Switch } from '../ui'

import {
  defaultLegacyKiroRsMigrationSelection,
  hasLegacyKiroRsMigrationSelection,
  isLegacyKiroRsMigrationRecoveryBlocked,
  legacyKiroRsMigrationRecoveryText,
  type LegacyKiroRsMigrationRecoveryStatus
} from './legacyKiroRsMigrationViewModel'

type ViewState = 'idle' | 'loading' | 'scanning' | 'preview' | 'applying' | 'succeeded' | 'failed'

import { legacyKiroRsMigrationRecoveryStatusForError } from './legacyKiroRsMigrationViewModel'

const errorText = (code: LegacyKiroRsMigrationIpcErrorCode, isEn: boolean): string => {
  const messages: Partial<Record<LegacyKiroRsMigrationIpcErrorCode, [string, string]>> = {
    INVALID_REQUEST: ['Request was rejected for safety.', '请求因安全校验被拒绝。'],
    PROXY_RUNNING: [
      'Stop the proxy before changing migrated data.',
      '请先停止代理，再修改迁移数据。'
    ],
    SOURCE_FILE_MISSING: ['No legacy kiro-rs data was found.', '未发现旧版 kiro-rs 数据。'],
    ROLLBACK_NOT_AVAILABLE: [
      'No completed migration is available to roll back.',
      '当前没有可回滚的已完成迁移。'
    ],
    SCAN_NOT_AVAILABLE: [
      'Scan expired. Scan again before applying.',
      '扫描已过期，请重新扫描后再应用。'
    ],
    STALE_SCAN: ['Source or target changed. Scan again.', '源数据或目标数据已变化，请重新扫描。'],
    ENCRYPTION_UNAVAILABLE: [
      'System encryption is unavailable. Migration remains locked.',
      '系统加密能力不可用，迁移仍保持锁定。'
    ],
    JOURNAL_INVALID: [
      'The encrypted migration journal is invalid. Keep the proxy stopped.',
      '加密迁移日志无效，请保持代理停止。'
    ],
    MANUAL_INTERVENTION: [
      'Migration needs manual intervention. Keep the proxy stopped.',
      '迁移需要人工处理，请保持代理停止。'
    ],
    RECOVERY_REQUIRED: ['Finish migration recovery before continuing.', '继续前请先完成迁移恢复。'],
    CLEANUP_PENDING: ['Migration journal cleanup is still pending.', '迁移日志仍待清理。'],
    DEPENDENCY_FAILED: [
      'Migration service is unavailable. Try again later.',
      '迁移服务暂不可用，请稍后重试。'
    ]
  }
  const fallback: [string, string] = [
    'Migration could not be completed safely.',
    '迁移未能安全完成。'
  ]
  return (messages[code] ?? fallback)[isEn ? 0 : 1]
}

export function LegacyKiroRsMigrationCard({ isEn }: { isEn: boolean }): React.ReactNode {
  const [state, setState] = useState<ViewState>('idle')
  const [preview, setPreview] = useState<LegacyKiroRsMigrationIpcScanPreview | null>(null)
  const [selection, setSelection] = useState<LegacyKiroRsMigrationIpcSelection>({
    accounts: false,
    inboundApiKey: false,
    adminApiKey: false
  })
  const [proxyRunning, setProxyRunning] = useState(false)
  const [recoveryStatus, setRecoveryStatus] = useState<LegacyKiroRsMigrationRecoveryStatus>('none')
  const [rollbackAvailable, setRollbackAvailable] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const handleFailure = useCallback(
    (errorCode: LegacyKiroRsMigrationIpcErrorCode): void => {
      if (errorCode === 'PROXY_RUNNING') setProxyRunning(true)
      const blockedStatus = legacyKiroRsMigrationRecoveryStatusForError(errorCode)
      if (blockedStatus) {
        setRecoveryStatus(blockedStatus)
        setRollbackAvailable(false)
        setConfirmRollback(false)
      }
      setMessage(errorText(errorCode, isEn))
      setState('failed')
    },
    [isEn]
  )
  const recover = useCallback(async (): Promise<void> => {
    setState('loading')
    setMessage(null)
    const result = await window.api.legacyKiroRsMigration.recover()
    if (!result.ok) {
      handleFailure(result.errorCode)
      return
    }

    const nextStatus = result.value.status
    const recoveryMessage = legacyKiroRsMigrationRecoveryText(nextStatus, isEn)
    setProxyRunning(result.value.proxyRunning)
    setRecoveryStatus(nextStatus)
    setRollbackAvailable(result.value.rollbackAvailable)
    if (!result.value.rollbackAvailable) setConfirmRollback(false)
    if (recoveryMessage) {
      setMessage(recoveryMessage)
      setState('failed')
      return
    }
    setState('idle')
  }, [handleFailure, isEn])

  useEffect(() => {
    const unsubscribe = window.api.onProxyStatusChange((status) => {
      setProxyRunning(status.running)
    })
    void recover()
    return unsubscribe
  }, [recover])

  const recoveryBlocked = isLegacyKiroRsMigrationRecoveryBlocked(recoveryStatus)
  const hasSelection = hasLegacyKiroRsMigrationSelection(selection)
  const scanExpired = preview ? preview.expiresAt <= Date.now() : false
  const busy = state === 'loading' || state === 'scanning' || state === 'applying'

  const scan = async (): Promise<void> => {
    if (recoveryBlocked) return
    setState('scanning')
    setMessage(null)
    const result = await window.api.legacyKiroRsMigration.scan()
    if (!result.ok) {
      setMessage(errorText(result.errorCode, isEn))
      setState('failed')
      return
    }

    setPreview(result.value)
    setSelection(defaultLegacyKiroRsMigrationSelection(result.value))
    setState('preview')
  }

  const apply = async (): Promise<void> => {
    if (!preview || proxyRunning || recoveryBlocked || !hasSelection) return
    if (preview.expiresAt <= Date.now()) {
      handleFailure('SCAN_NOT_AVAILABLE')
      return
    }

    setState('applying')
    setMessage(null)
    const result = await window.api.legacyKiroRsMigration.apply(preview.scanId, selection)
    if (!result.ok) {
      handleFailure(result.errorCode)
      return
    }

    if (result.value.status === 'applied') {
      setRecoveryStatus('rollback_available')
      setRollbackAvailable(true)
      setMessage(
        isEn
          ? `Migration completed: ${result.value.migratedCount} account(s).`
          : `迁移完成：${result.value.migratedCount} 个账号。`
      )
    } else {
      setMessage(isEn ? 'No selected data required changes.' : '所选数据无需变更。')
    }
    setState('succeeded')
  }

  const rollback = async (): Promise<void> => {
    if (proxyRunning || recoveryBlocked) return
    setState('applying')
    setMessage(null)
    const result = await window.api.legacyKiroRsMigration.rollback()
    if (!result.ok) {
      handleFailure(result.errorCode)
      return
    }

    setRollbackAvailable(false)
    setConfirmRollback(false)
    if (result.value.status === 'cleanup_pending') {
      setRecoveryStatus('cleanup_pending')
      setMessage(legacyKiroRsMigrationRecoveryText('cleanup_pending', isEn))
      setState('failed')
      return
    }

    setRecoveryStatus('none')
    setMessage(
      isEn
        ? `Migration rolled back: ${result.value.migratedCount} account(s).`
        : `迁移已回滚：${result.value.migratedCount} 个账号。`
    )
    setState('succeeded')
  }

  const settingToggle = (
    key: 'inboundApiKey' | 'adminApiKey',
    label: string,
    setting: LegacyKiroRsMigrationIpcScanPreview['settings']['inboundApiKey']
  ): React.ReactNode => (
    <div className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2 text-xs">
      <div>
        <span className="font-medium">{label}</span>
        <span className="ml-2 font-mono text-muted-foreground">{setting}</span>
      </div>
      <Switch
        checked={selection[key]}
        disabled={setting !== 'target_empty' || busy}
        onCheckedChange={(checked) => setSelection((previous) => ({ ...previous, [key]: checked }))}
      />
    </div>
  )

  return (
    <Card className="border-slate-300/80 bg-gradient-to-br from-slate-50/70 to-background dark:border-slate-700 dark:from-slate-950/40">
      <CardHeader className="border-b border-dashed border-slate-300 pb-3 dark:border-slate-700">
        <CardTitle className="flex items-center gap-2 text-base">
          <DatabaseZap className="h-4 w-4 text-sky-700 dark:text-sky-400" />
          {isEn ? 'Legacy kiro-rs migration ledger' : '旧版 kiro-rs 迁移账本'}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {isEn
            ? 'Scans local legacy data, shows only redacted identifiers, then applies one audited transaction.'
            : '扫描本机旧版数据，只显示脱敏标识，再以单次可审计事务应用。'}
        </p>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        {preview && (
          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            <div>
              <b>{preview.accounts.new}</b>
              <p className="text-muted-foreground">{isEn ? 'new' : '新增'}</p>
            </div>
            <div>
              <b>{preview.accounts.existing}</b>
              <p className="text-muted-foreground">{isEn ? 'existing' : '已有'}</p>
            </div>
            <div>
              <b>{preview.accounts.duplicate}</b>
              <p className="text-muted-foreground">{isEn ? 'duplicate' : '重复'}</p>
            </div>
            <div>
              <b>{preview.settings.unsupportedCount}</b>
              <p className="text-muted-foreground">{isEn ? 'unsupported' : '不支持'}</p>
            </div>
          </div>
        )}

        {preview && (
          <>
            <div className="rounded-md bg-slate-900 px-3 py-2 font-mono text-[10px] tracking-wide text-slate-200">
              {preview.accounts.redactedIds.length
                ? preview.accounts.redactedIds.join(' · ')
                : isEn
                  ? 'No credential identifiers'
                  : '无凭据标识'}
            </div>
            <div className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2 text-xs">
              <Label>{isEn ? 'Accounts (new only)' : '账号（仅新增）'}</Label>
              <Switch
                checked={selection.accounts}
                disabled={preview.accounts.new === 0 || busy}
                onCheckedChange={(checked) =>
                  setSelection((previous) => ({ ...previous, accounts: checked }))
                }
              />
            </div>
            {settingToggle(
              'inboundApiKey',
              isEn ? 'Inbound API key' : '入站 API Key',
              preview.settings.inboundApiKey
            )}
            {settingToggle(
              'adminApiKey',
              isEn ? 'Admin API key' : '管理 API Key',
              preview.settings.adminApiKey
            )}
            {!hasSelection && (
              <p className="text-xs text-muted-foreground">
                {isEn ? 'Nothing new is available to apply.' : '没有可应用的新数据。'}
              </p>
            )}
            {scanExpired && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {isEn ? 'This preview has expired. Scan again.' : '此预览已过期，请重新扫描。'}
              </p>
            )}
          </>
        )}

        {proxyRunning && (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            {isEn
              ? 'Proxy is running. Apply and rollback are disabled until it stops.'
              : '代理正在运行。停止后才可应用或回滚。'}
          </div>
        )}

        {message && (
          <div
            className={`flex gap-2 rounded-md p-2 text-xs ${
              state === 'failed'
                ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
            }`}
          >
            {state === 'failed' ? (
              <ShieldAlert className="h-4 w-4 shrink-0" />
            ) : (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            )}
            {message}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {recoveryBlocked ? (
            <Button size="sm" variant="outline" onClick={() => void recover()} disabled={busy}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
              {isEn ? 'Retry recovery' : '重试恢复'}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void scan()} disabled={busy}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
              {isEn ? 'Scan legacy data' : '扫描旧版数据'}
            </Button>
          )}

          {preview && !recoveryBlocked && (
            <Button
              size="sm"
              onClick={() => void apply()}
              disabled={busy || proxyRunning || !hasSelection || scanExpired}
            >
              {isEn ? 'Apply selected' : '应用所选'}
            </Button>
          )}

          {rollbackAvailable && !confirmRollback && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || proxyRunning || recoveryBlocked}
              onClick={() => setConfirmRollback(true)}
            >
              {isEn ? 'Rollback migration' : '回滚迁移'}
            </Button>
          )}

          {rollbackAvailable && confirmRollback && (
            <div className="flex items-center gap-2 text-xs">
              <span>{isEn ? 'Restore the pre-migration snapshot?' : '恢复迁移前快照？'}</span>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || proxyRunning || recoveryBlocked}
                onClick={() => void rollback()}
              >
                {isEn ? 'Confirm rollback' : '确认回滚'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmRollback(false)}
              >
                {isEn ? 'Cancel' : '取消'}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
