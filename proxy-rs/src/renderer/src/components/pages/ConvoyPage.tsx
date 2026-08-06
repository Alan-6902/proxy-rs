/**
 * 自动车凭证页面
 *
 * 两个独立来源，都注入反代账号池、都不落盘：
 *   1. 自动车登录 Key（x-api-key）→ 每分钟自动拉取全部凭证
 *   2. 手填上游 Kiro API Key（ksk_...）→ 区域非必填，留空即自动探测
 *
 * 安全：登录 Key 与凭证明文全程只在主进程内流转，页面只拿到脱敏状态。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  TriangleAlert,
  Truck,
  XCircle
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  PageHeader,
  Switch,
  askConfirm
} from '../ui'
import { cn } from '@/lib/utils'
import {
  CONVOY_ALERT_KIND,
  CONVOY_CREDENTIAL_STATUS,
  CONVOY_REGION_PROBE_ORDER,
  CONVOY_STATE,
  DEFAULT_CONVOY_SYNC_CONFIG,
  MIN_POLL_INTERVAL_SECONDS,
  formatCents,
  toCents,
  type ConvoyAlertKind,
  type ConvoyCredentialStatus,
  type ConvoyState,
  type ConvoySyncConfig,
  type ConvoySyncStatus,
  type ManualConvoyKeyResult
} from '../../../../shared/convoyCredentials'

/** 手填 Key 的编辑行 */
interface ManualKeyRow {
  id: string
  key: string
  region: string
}

type BusyKind = 'idle' | 'saving' | 'syncing' | 'probing'

/** 状态徽章配色：健康绿、降级黄、需人工介入红 */
const STATE_STYLE: Record<ConvoyState, { className: string; zh: string; en: string }> = {
  [CONVOY_STATE.IDLE]: {
    className: 'bg-muted text-muted-foreground border-border',
    zh: '未启用',
    en: 'Idle'
  },
  [CONVOY_STATE.HEALTHY]: {
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    zh: '运行正常',
    en: 'Healthy'
  },
  [CONVOY_STATE.DEGRADED]: {
    className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
    zh: '拉取失败中',
    en: 'Degraded'
  },
  [CONVOY_STATE.NOT_ON_BOARD]: {
    className: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
    zh: '未在自动车上',
    en: 'Not on board'
  },
  [CONVOY_STATE.UNAUTHORIZED]: {
    className: 'bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30',
    zh: '登录 Key 失效',
    en: 'Unauthorized'
  },
  [CONVOY_STATE.BLOCKED]: {
    className: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
    zh: '计费门禁阻断',
    en: 'Billing blocked'
  }
}

const CREDENTIAL_STATUS_STYLE: Record<ConvoyCredentialStatus, string> = {
  [CONVOY_CREDENTIAL_STATUS.ACTIVE]:
    'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  [CONVOY_CREDENTIAL_STATUS.EXPIRED]:
    'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  [CONVOY_CREDENTIAL_STATUS.UNAVAILABLE]: 'bg-muted text-muted-foreground border-border'
}

const ALERT_STYLE: Record<ConvoyAlertKind, string> = {
  [CONVOY_ALERT_KIND.PULL_FAILED]: 'text-amber-700 dark:text-amber-300',
  [CONVOY_ALERT_KIND.UNAUTHORIZED]: 'text-red-700 dark:text-red-400',
  [CONVOY_ALERT_KIND.NOT_ON_BOARD]: 'text-sky-700 dark:text-sky-300',
  [CONVOY_ALERT_KIND.INSUFFICIENT]: 'text-orange-700 dark:text-orange-300',
  [CONVOY_ALERT_KIND.LOW_BALANCE]: 'text-orange-700 dark:text-orange-300',
  [CONVOY_ALERT_KIND.BILLING_LIMIT]: 'text-orange-700 dark:text-orange-300',
  [CONVOY_ALERT_KIND.SNAPSHOT_STALE]: 'text-amber-700 dark:text-amber-300',
  [CONVOY_ALERT_KIND.SNAPSHOT_EMPTY]: 'text-amber-700 dark:text-amber-300',
  [CONVOY_ALERT_KIND.INSECURE_HTTP]: 'text-red-700 dark:text-red-400'
}

function formatTime(at?: number): string {
  return at ? new Date(at).toLocaleTimeString() : '—'
}

function newRowId(): string {
  return `mk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function ConvoyPage(): React.JSX.Element {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  const [config, setConfig] = useState<ConvoySyncConfig>({ ...DEFAULT_CONVOY_SYNC_CONFIG })
  const [status, setStatus] = useState<ConvoySyncStatus | null>(null)
  const [encryptionAvailable, setEncryptionAvailable] = useState(true)
  /** 登录 Key 输入框：留空表示不改动已保存的 Key */
  const [convoyKeyInput, setConvoyKeyInput] = useState('')
  const [manualRows, setManualRows] = useState<ManualKeyRow[]>([])
  const [manualResults, setManualResults] = useState<ManualConvoyKeyResult[]>([])
  const [busy, setBusy] = useState<BusyKind>('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** 金额输入用元为单位的文本，保存时才换算成分 */
  const [chargeText, setChargeText] = useState({
    maxChargePerPull: formatCents(DEFAULT_CONVOY_SYNC_CONFIG.maxChargePerPullCents),
    dailyChargeLimit: formatCents(DEFAULT_CONVOY_SYNC_CONFIG.dailyChargeLimitCents),
    minBalanceAlert: formatCents(DEFAULT_CONVOY_SYNC_CONFIG.minBalanceAlertCents)
  })
  /** 已从主进程同步过配置，避免首帧覆盖用户正在输入的内容 */
  const hydrated = useRef(false)

  const applyStatus = useCallback((next: ConvoySyncStatus) => {
    setStatus(next)
    setManualResults(next.manualKeys)
  }, [])

  const refresh = useCallback(async () => {
    const result = await window.api.convoyStatus()
    if (!result.success) {
      setError(result.error)
      return
    }
    const { encryptionAvailable: available, config: savedConfig, ...rest } = result.data
    setEncryptionAvailable(available)
    applyStatus(rest)
    if (!hydrated.current) {
      hydrated.current = true
      setConfig(savedConfig)
      setChargeText({
        maxChargePerPull: formatCents(savedConfig.maxChargePerPullCents),
        dailyChargeLimit: formatCents(savedConfig.dailyChargeLimitCents),
        minBalanceAlert: formatCents(savedConfig.minBalanceAlertCents)
      })
    }
  }, [applyStatus])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 主进程每轮结束都会推状态，页面不必自己轮询
  useEffect(() => window.api.onConvoyStatus(applyStatus), [applyStatus])

  const isBusy = busy !== 'idle'
  const stateStyle = STATE_STYLE[status?.state ?? CONVOY_STATE.IDLE]

  /** 配置里的金额以分存，输入框以元编辑，保存时统一换算 */
  const buildConfigToSave = useCallback(
    (): Partial<ConvoySyncConfig> => ({
      ...config,
      maxChargePerPullCents: toCents(chargeText.maxChargePerPull),
      dailyChargeLimitCents: toCents(chargeText.dailyChargeLimit),
      minBalanceAlertCents: toCents(chargeText.minBalanceAlert)
    }),
    [chargeText, config]
  )

  const handleSave = useCallback(async () => {
    setBusy('saving')
    setError('')
    setNotice('')
    try {
      const result = await window.api.convoySaveConfig({
        config: buildConfigToSave(),
        // 留空表示保留已保存的 Key，不误清
        convoyKey: convoyKeyInput.trim() ? convoyKeyInput.trim() : undefined
      })
      if (!result.success) {
        setError(result.error)
        return
      }
      setConvoyKeyInput('')
      setConfig(result.data.config)
      setNotice(isEn ? 'Saved. Polling restarted.' : '已保存，轮询已按新配置重启。')
      await refresh()
    } finally {
      setBusy('idle')
    }
  }, [buildConfigToSave, convoyKeyInput, isEn, refresh])

  const handleClear = useCallback(async () => {
    const confirmed = await askConfirm({
      title: isEn ? 'Clear convoy key and config?' : '清除登录 Key 与配置？',
      description: isEn
        ? 'The encrypted file will be removed and the current snapshot dropped. Pulled credentials leave the proxy pool.'
        : '加密文件将被删除，当前快照一并丢弃，已拉取的凭证会从反代账号池摘除。',
      tone: 'warning'
    })
    if (!confirmed) return
    setBusy('saving')
    try {
      const result = await window.api.convoyClearConfig()
      if (!result.success) {
        setError(result.error)
        return
      }
      hydrated.current = false
      setConvoyKeyInput('')
      setNotice(isEn ? 'Cleared.' : '已清除。')
      await refresh()
    } finally {
      setBusy('idle')
    }
  }, [isEn, refresh])

  /** 手动同步可能真实扣费，先让用户确认 */
  const handleSyncNow = useCallback(async () => {
    const confirmed = await askConfirm({
      title: isEn ? 'Pull credentials now?' : '立即拉取凭证？',
      description: isEn
        ? 'New credentials that were never fetched before are charged by the upstream. Billing limits still apply.'
        : '上游会对此前未取过的新凭证计费，计费门禁仍然生效。',
      tone: 'warning'
    })
    if (!confirmed) return
    setBusy('syncing')
    setError('')
    setNotice('')
    try {
      const result = await window.api.convoySyncNow()
      if (!result.success) {
        setError(result.error)
      } else {
        setNotice(isEn ? 'Snapshot updated.' : '快照已更新。')
      }
      await refresh()
    } finally {
      setBusy('idle')
    }
  }, [isEn, refresh])

  const handleApplyManualKeys = useCallback(async () => {
    const payload = manualRows
      .map((row) => ({ id: row.id, key: row.key.trim(), region: row.region.trim() || undefined }))
      .filter((row) => row.key.length > 0)

    setBusy('probing')
    setError('')
    setNotice('')
    try {
      const result = await window.api.convoySetManualKeys(payload)
      if (!result.success) {
        setError(result.error)
        return
      }
      setManualResults(result.data)
      const okCount = result.data.filter((item) => item.ok).length
      setNotice(
        isEn
          ? `${okCount}/${result.data.length} keys verified and injected.`
          : `${result.data.length} 个 Key 中 ${okCount} 个验活成功并已注入反代池。`
      )
      await refresh()
    } finally {
      setBusy('idle')
    }
  }, [isEn, manualRows, refresh])

  const handleClearManualKeys = useCallback(async () => {
    setBusy('probing')
    try {
      await window.api.convoyClearManualKeys()
      setManualRows([])
      setManualResults([])
      await refresh()
    } finally {
      setBusy('idle')
    }
  }, [refresh])

  const resultById = useMemo(
    () => new Map(manualResults.map((item) => [item.id, item])),
    [manualResults]
  )

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Truck}
        accent="indigo"
        title={isEn ? 'Auto Convoy' : '自动车凭证'}
        description={
          isEn
            ? 'Pull shared Kiro credentials every minute, or paste upstream API keys directly. Both feed the API proxy pool and are never written to disk.'
            : '每分钟从自动车拉取共享凭证，也可直接粘贴上游 API Key。两者都注入 API 反代账号池，均不落盘。'
        }
      />

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}
      {notice && !error && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {!encryptionAvailable && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {isEn
              ? 'OS encrypted storage is unavailable, so the convoy key cannot be saved. Manual keys still work for this session.'
              : '系统加密存储不可用，无法保存登录 Key（拒绝明文落盘）。手填 Key 在本次会话内仍可使用。'}
          </span>
        </div>
      )}

      {/* ============ 运行状态 ============ */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">{isEn ? 'Sync status' : '同步状态'}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={cn('font-medium', stateStyle.className)}>
              {isEn ? stateStyle.en : stateStyle.zh}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={handleSyncNow}
              disabled={isBusy || !status?.hasConvoyKey}
            >
              {busy === 'syncing' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {isEn ? 'Sync now' : '立即同步'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <StatCell
              label={isEn ? 'Usable credentials' : '可分配凭证'}
              value={`${status?.snapshot?.activeCount ?? 0} / ${status?.snapshot?.totalCount ?? 0}`}
            />
            <StatCell
              label={isEn ? 'Snapshot version' : '快照版本'}
              value={status?.snapshot?.versionShort ?? '—'}
              mono
            />
            <StatCell
              label={isEn ? 'Last success' : '最近成功'}
              value={formatTime(status?.lastSuccessAt)}
            />
            <StatCell
              label={isEn ? 'Next run' : '下轮时间'}
              value={formatTime(status?.nextRunAt)}
            />
            <StatCell
              label={isEn ? 'Charged today' : '当日计费'}
              value={formatCents(status?.todayChargedCents ?? 0)}
            />
            <StatCell
              label={isEn ? 'Balance' : '余额'}
              value={
                status?.balanceAfterCents === undefined
                  ? '—'
                  : formatCents(status.balanceAfterCents)
              }
            />
            <StatCell
              label={isEn ? 'Undelivered' : '未发放'}
              value={String(status?.snapshot?.insufficientCount ?? 0)}
            />
            <StatCell
              label={isEn ? 'Consecutive failures' : '连续失败'}
              value={String(status?.consecutiveFailures ?? 0)}
            />
          </div>

          {status?.blockedReason && (
            <div className="flex items-start gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm text-orange-700 dark:text-orange-300">
              <Ban className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-all">{status.blockedReason}</span>
            </div>
          )}
          {status?.lastError && !status.blockedReason && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <Clock className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-all">{status.lastError}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ============ 自动车配置 ============ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {isEn ? 'Convoy key & polling' : '自动车登录 Key 与轮询'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[260px] flex-1">
              <Label className="text-xs">
                {isEn ? 'Convoy login key (x-api-key)' : '自动车登录 Key（x-api-key）'}
              </Label>
              <Input
                type="password"
                value={convoyKeyInput}
                onChange={(e) => setConvoyKeyInput(e.target.value)}
                placeholder={
                  status?.hasConvoyKey
                    ? `${isEn ? 'Saved' : '已保存'} ${status.convoyKeyTail ?? ''} · ${isEn ? 'leave blank to keep' : '留空保持不变'}`
                    : isEn
                      ? 'Paste the convoy login key'
                      : '粘贴自动车登录 Key'
                }
                spellCheck={false}
              />
            </div>
            <div className="w-32">
              <Label className="text-xs">{isEn ? 'Interval (s)' : '轮询间隔（秒）'}</Label>
              <Input
                type="number"
                min={MIN_POLL_INTERVAL_SECONDS}
                value={config.pollIntervalSeconds}
                onChange={(e) =>
                  setConfig({ ...config, pollIntervalSeconds: Number(e.target.value) })
                }
              />
            </div>
            <div className="w-32">
              <Label className="text-xs">{isEn ? 'Timeout (s)' : '请求超时（秒）'}</Label>
              <Input
                type="number"
                min={1}
                value={config.requestTimeoutSeconds}
                onChange={(e) =>
                  setConfig({ ...config, requestTimeoutSeconds: Number(e.target.value) })
                }
              />
            </div>
          </div>

          <div>
            <Label className="text-xs">{isEn ? 'Upstream base URL' : '上游基础地址'}</Label>
            <Input
              value={config.baseUrl}
              onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
              placeholder={DEFAULT_CONVOY_SYNC_CONFIG.baseUrl}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Label className="text-xs">
                {isEn ? 'Max new credentials / pull' : '单次新增凭证上限'}
              </Label>
              <Input
                type="number"
                min={0}
                value={config.maxNewCredentialsPerPull}
                onChange={(e) =>
                  setConfig({ ...config, maxNewCredentialsPerPull: Number(e.target.value) })
                }
              />
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'Max charge / pull' : '单次金额上限'}</Label>
              <Input
                value={chargeText.maxChargePerPull}
                onChange={(e) => setChargeText({ ...chargeText, maxChargePerPull: e.target.value })}
                className="font-mono"
              />
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'Daily charge limit' : '每日金额上限'}</Label>
              <Input
                value={chargeText.dailyChargeLimit}
                onChange={(e) => setChargeText({ ...chargeText, dailyChargeLimit: e.target.value })}
                className="font-mono"
              />
            </div>
            <div>
              <Label className="text-xs">{isEn ? 'Low balance alert' : '余额告警阈值'}</Label>
              <Input
                value={chargeText.minBalanceAlert}
                onChange={(e) => setChargeText({ ...chargeText, minBalanceAlert: e.target.value })}
                className="font-mono"
              />
            </div>
          </div>

          <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
            <ToggleRow
              checked={config.enabled}
              onChange={(checked) => setConfig({ ...config, enabled: checked })}
              label={isEn ? 'Enable automatic pulling' : '启用每分钟自动拉取'}
              hint={
                isEn
                  ? 'Off keeps the current snapshot but stops all upstream calls.'
                  : '关闭后停止一切上游调用，当前快照保留至各凭证自身过期。'
              }
            />
            <ToggleRow
              checked={config.allowInitialCharge}
              onChange={(checked) => setConfig({ ...config, allowInitialCharge: checked })}
              label={isEn ? 'Allow first-time charge' : '允许首次计费'}
              hint={
                isEn
                  ? 'Off means the first pull only estimates the cost and waits for your confirmation.'
                  : '关闭时首轮只给出预估数量与金额，确认后再开放完整拉取。'
              }
            />
            <ToggleRow
              checked={config.allowInsecureHttp}
              onChange={(checked) => setConfig({ ...config, allowInsecureHttp: checked })}
              label={isEn ? 'Allow plaintext HTTP' : '允许明文 HTTP'}
              hint={
                isEn
                  ? 'Required only if the upstream has no HTTPS. The login key travels in cleartext.'
                  : '仅当上游没有 HTTPS 时才需要开启，登录 Key 会以明文过网，存在中间人风险。'
              }
              danger
            />
          </div>

          {status?.pendingInitialEstimate && (
            <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm text-sky-700 dark:text-sky-300">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {isEn
                  ? `Estimated ${status.pendingInitialEstimate.credentialCount} new credentials, about ${formatCents(status.pendingInitialEstimate.estimatedChargeCents)}. Enable "Allow first-time charge" to proceed.`
                  : `预计新增 ${status.pendingInitialEstimate.credentialCount} 个凭证、约 ${formatCents(status.pendingInitialEstimate.estimatedChargeCents)} 元。确认后请开启「允许首次计费」。`}
              </span>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button className="rounded-xl" onClick={handleSave} disabled={isBusy}>
              {busy === 'saving' ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-4 w-4" />
              )}
              {isEn ? 'Save & restart polling' : '保存并重启轮询'}
            </Button>
            <Button
              variant="outline"
              className="rounded-xl"
              onClick={handleClear}
              disabled={isBusy}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              {isEn ? 'Clear key & config' : '清除 Key 与配置'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ============ 手填上游 Key ============ */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            {isEn ? 'Upstream API keys (manual)' : '手填上游 API Key'}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="rounded-xl"
            onClick={() => setManualRows([...manualRows, { id: newRowId(), key: '', region: '' }])}
            disabled={isBusy}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {isEn ? 'Add key' : '添加一行'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="rounded-xl border border-primary/15 bg-primary/[0.04] px-3 py-2 text-xs text-primary">
            {isEn
              ? `Region is optional. Leave it blank and each key is probed across ${CONVOY_REGION_PROBE_ORDER.join(' / ')} — whichever returns 200 is used. These keys live in memory only and are injected into the proxy pool after verification.`
              : `区域（国家）非必填：留空时会依次探测 ${CONVOY_REGION_PROBE_ORDER.join(' / ')}，哪个返回 200 就用哪个。这些 Key 只驻留内存，验活成功后注入反代账号池。`}
          </p>

          {manualRows.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {isEn ? 'No manual keys yet.' : '尚未添加手填 Key。'}
            </p>
          )}

          {manualRows.map((row) => {
            const result = resultById.get(row.id)
            return (
              <div key={row.id} className="flex flex-wrap items-start gap-2">
                <div className="min-w-[240px] flex-1">
                  <Input
                    value={row.key}
                    onChange={(e) =>
                      setManualRows(
                        manualRows.map((item) =>
                          item.id === row.id ? { ...item, key: e.target.value } : item
                        )
                      )
                    }
                    placeholder="ksk_..."
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                  {result && (
                    <p
                      className={cn(
                        'mt-1 flex items-center gap-1 text-xs',
                        result.ok
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : 'text-red-700 dark:text-red-400'
                      )}
                    >
                      {result.ok ? (
                        <CheckCircle2 className="h-3 w-3 shrink-0" />
                      ) : (
                        <XCircle className="h-3 w-3 shrink-0" />
                      )}
                      <span className="break-all">
                        {result.ok
                          ? `${result.maskedKey} → ${result.resolvedRegion}${result.email ? ` · ${result.email}` : ''}`
                          : `${result.maskedKey} — ${result.error ?? ''}`}
                      </span>
                    </p>
                  )}
                </div>
                <div className="w-40">
                  <Input
                    value={row.region}
                    onChange={(e) =>
                      setManualRows(
                        manualRows.map((item) =>
                          item.id === row.id ? { ...item, region: e.target.value } : item
                        )
                      )
                    }
                    placeholder={isEn ? 'auto-detect' : '留空自动探测'}
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 shrink-0 rounded-xl text-muted-foreground hover:text-red-600"
                  onClick={() => setManualRows(manualRows.filter((item) => item.id !== row.id))}
                  disabled={isBusy}
                  aria-label={isEn ? 'Remove key' : '删除该行'}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )
          })}

          <div className="flex flex-wrap gap-2">
            <Button
              className="rounded-xl"
              onClick={handleApplyManualKeys}
              disabled={isBusy || manualRows.every((row) => !row.key.trim())}
            >
              {busy === 'probing' ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
              )}
              {isEn ? 'Verify & inject' : '验活并注入'}
            </Button>
            <Button
              variant="outline"
              className="rounded-xl"
              onClick={handleClearManualKeys}
              disabled={isBusy || (manualRows.length === 0 && manualResults.length === 0)}
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              {isEn ? 'Clear all' : '全部清除'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ============ 快照明细（脱敏） ============ */}
      {status?.snapshot && status.snapshot.credentials.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {isEn ? 'Snapshot detail' : '快照明细'}
              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                {status.snapshot.versionShort}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/60 text-2xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">ID</th>
                    <th className="px-3 py-2 text-left font-medium">{isEn ? 'Status' : '状态'}</th>
                    <th className="px-3 py-2 text-left font-medium">{isEn ? 'Type' : '类型'}</th>
                    <th className="px-3 py-2 text-left font-medium">
                      {isEn ? 'Credential' : '凭证'}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">Region</th>
                    <th className="px-3 py-2 text-left font-medium">
                      {isEn ? 'Expires' : '过期时间'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {status.snapshot.credentials.map((credential) => (
                    <tr key={credential.id} className="border-t border-border/50">
                      <td className="px-3 py-2 font-mono text-xs">{credential.id}</td>
                      <td className="px-3 py-2">
                        <Badge
                          variant="outline"
                          className={cn('text-2xs', CREDENTIAL_STATUS_STYLE[credential.status])}
                        >
                          {credential.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {credential.type || '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {credential.maskedCredential || '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{credential.region ?? '—'}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {formatTime(credential.expiresAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ============ 告警 ============ */}
      {status && status.alerts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{isEn ? 'Alerts' : '告警'}</CardTitle>
          </CardHeader>
          <CardContent className="max-h-56 space-y-1.5 overflow-y-auto">
            {status.alerts.map((alert, index) => (
              <p key={`${alert.at}-${index}`} className="flex items-start gap-2 text-xs">
                <span className="shrink-0 font-mono text-muted-foreground">
                  {formatTime(alert.at)}
                </span>
                <span className={cn('break-all', ALERT_STYLE[alert.kind])}>{alert.message}</span>
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/** 开关行：标题 + 说明 + Switch */
function ToggleRow({
  checked,
  onChange,
  label,
  hint,
  danger
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint: string
  danger?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p
          className={cn(
            'text-sm font-medium',
            danger && checked && 'text-red-700 dark:text-red-400'
          )}
        >
          {label}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/** 状态格子：小标题 + 值 */
function StatCell({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
      <p className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-sm font-medium', mono && 'font-mono')}>{value}</p>
    </div>
  )
}
