import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpDown,
  Ban,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  Mail,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
  XCircle,
  Zap
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
  Select,
  Switch,
  askConfirm
} from '../ui'
import { cn } from '@/lib/utils'
import {
  COMMON_AWS_REGIONS,
  DEFAULT_SEAT_CONCURRENCY,
  KIRO_TIER,
  KIRO_TIER_ORDER,
  TIER_MONTHLY_CREDITS,
  TIER_MONTHLY_PRICE_USD,
  estimateMonthlyCost,
  type BatchOpResult,
  type ExistingSeat,
  type IdcCredentialConfig,
  type KiroTier,
  type PlannedSeat,
  type ProvisionSummary,
  type SeatInventory,
  type SeatQuotaRequest
} from '../../../../shared/idcSeats'

/** 未保存凭据时的初始值 */
const EMPTY_CREDENTIALS: IdcCredentialConfig = { source: 'manual', region: 'us-east-1' }

type BusyKind = 'idle' | 'testing' | 'planning' | 'provisioning' | 'loading-inventory' | 'batch'

interface LogLine {
  id: number
  text: string
}

/** 档位徽章配色：按价格递增加深，方便一眼区分成本 */
const TIER_BADGE: Record<KiroTier, string> = {
  [KIRO_TIER.PRO]: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
  [KIRO_TIER.PRO_PLUS]:
    'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30',
  [KIRO_TIER.POWER]: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30'
}

function TierBadge({ tier, raw }: { tier?: KiroTier; raw?: string }): React.ReactNode {
  if (!tier) {
    return (
      <Badge variant="outline" className="font-mono text-2xs">
        {raw || '—'}
      </Badge>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-2xs font-medium',
        TIER_BADGE[tier]
      )}
    >
      {tier}
    </span>
  )
}

function StepIcon({
  status
}: {
  status: 'ok' | 'skipped' | 'failed' | 'not-attempted'
}): React.ReactNode {
  if (status === 'ok')
    return <CheckCircle2 className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
  if (status === 'skipped') return <Ban className="w-3.5 h-3.5 text-muted-foreground" />
  if (status === 'failed') return <XCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
  return (
    <span className="inline-block w-3.5 h-3.5 rounded-full border border-dashed border-border" />
  )
}

export function SeatsPage(): React.ReactNode {
  const { language } = useTranslation()
  const isEn = language === 'en'

  // ---- 凭据 ----
  const [creds, setCreds] = useState<IdcCredentialConfig>(EMPTY_CREDENTIALS)
  const [profiles, setProfiles] = useState<string[]>([])
  const [credStatus, setCredStatus] = useState<{
    encryptionAvailable: boolean
    hasSaved: boolean
    accessKeyIdTail?: string
  } | null>(null)
  const [connInfo, setConnInfo] = useState<{
    identityStoreId: string
    seatCount: number
    unsubscribedCount: number
  } | null>(null)

  // ---- 计划 ----
  const [quotas, setQuotas] = useState<SeatQuotaRequest[]>([{ tier: KIRO_TIER.PRO, count: 10 }])
  const [domains, setDomains] = useState('')
  const [sendPasswordEmail, setSendPasswordEmail] = useState(true)
  const [concurrency, setConcurrency] = useState(DEFAULT_SEAT_CONCURRENCY)
  const [planned, setPlanned] = useState<PlannedSeat[]>([])
  const [summary, setSummary] = useState<ProvisionSummary | null>(null)

  // ---- 库存 ----
  const [inventory, setInventory] = useState<SeatInventory | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchTier, setBatchTier] = useState<KiroTier>(KIRO_TIER.PRO)

  // ---- 运行态 ----
  const [busy, setBusy] = useState<BusyKind>('idle')
  const [error, setError] = useState('')
  const [logs, setLogs] = useState<LogLine[]>([])
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const logIdRef = useRef(0)
  const logBoxRef = useRef<HTMLDivElement | null>(null)

  const appendLog = useCallback((text: string) => {
    setLogs((prev) => {
      const next = [...prev, { id: logIdRef.current++, text }]
      // 只留最近 300 行，避免长批次把内存和 DOM 撑爆
      return next.length > 300 ? next.slice(-300) : next
    })
  }, [])

  // 订阅主进程进度事件
  useEffect(() => {
    const off = window.api.onIdcProgress((event) => {
      if (event.message) appendLog(event.message)
      if (event.kind === 'seat-done' && event.result) {
        const r = event.result
        const mark = r.createUser === 'failed' || r.subscribe === 'failed' ? '✗' : '✓'
        appendLog(`${mark} ${r.seq}  ${r.email}  ${r.tier}${r.error ? `  — ${r.error}` : ''}`)
      }
      if (typeof event.done === 'number' && typeof event.total === 'number') {
        setProgress({ done: event.done, total: event.total })
      }
    })
    return off
  }, [appendLog])

  // 日志自动滚到底
  useEffect(() => {
    const box = logBoxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [logs])

  // 首次加载：读已保存凭据状态与本机 profile 列表
  useEffect(() => {
    void (async () => {
      const [status, profileList] = await Promise.all([
        window.api.idcCredentialStatus(),
        window.api.idcListProfiles()
      ])
      if (status.success) {
        setCredStatus(status.data)
        if (status.data.hasSaved) {
          setCreds((prev) => ({
            ...prev,
            source: status.data.source ?? prev.source,
            region: status.data.region || prev.region,
            profile: status.data.profile
          }))
        }
      }
      if (profileList.success) setProfiles(profileList.data)
    })()
  }, [])

  const totalSeats = useMemo(() => quotas.reduce((s, q) => s + Math.max(0, q.count), 0), [quotas])
  const monthlyCost = useMemo(() => estimateMonthlyCost(quotas), [quotas])

  /** 手填模式下必须有 AK/SK 才能发请求；profile 模式只要选了 profile */
  const credsReady = useMemo(() => {
    if (creds.source === 'manual')
      return Boolean(creds.accessKeyId?.trim() && creds.secretAccessKey?.trim())
    return true
  }, [creds])

  const inventoryCost = useMemo(() => {
    if (!inventory) return 0
    return inventory.seats.reduce(
      (sum, s) => sum + (s.tier ? TIER_MONTHLY_PRICE_USD[s.tier] : 0),
      0
    )
  }, [inventory])

  const run = useCallback(
    async <T,>(
      kind: BusyKind,
      fn: () => Promise<{ success: true; data: T } | { success: false; error: string }>
    ): Promise<T | null> => {
      setBusy(kind)
      setError('')
      try {
        const res = await fn()
        if (!res.success) {
          setError(res.error)
          appendLog(`✗ ${res.error}`)
          return null
        }
        return res.data
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        appendLog(`✗ ${msg}`)
        return null
      } finally {
        setBusy('idle')
      }
    },
    [appendLog]
  )

  const handleTest = useCallback(async () => {
    setConnInfo(null)
    const data = await run('testing', () => window.api.idcTestConnection(creds))
    if (data) {
      setConnInfo(data)
      appendLog(
        isEn
          ? `Connected. Identity Store ${data.identityStoreId} · ${data.seatCount} subscribed, ${data.unsubscribedCount} without subscription`
          : `连接成功。Identity Store ${data.identityStoreId} · 已订阅 ${data.seatCount} 个，未订阅 ${data.unsubscribedCount} 个`
      )
    }
  }, [appendLog, creds, isEn, run])

  const handleSaveCreds = useCallback(async () => {
    const data = await run('idle', () => window.api.idcSaveCredentials(creds))
    if (data) {
      const status = await window.api.idcCredentialStatus()
      if (status.success) setCredStatus(status.data)
      appendLog(isEn ? 'Credentials saved (OS-encrypted).' : '凭据已保存（系统加密存储）。')
    }
  }, [appendLog, creds, isEn, run])

  const handleClearCreds = useCallback(async () => {
    const confirmed = await askConfirm({
      title: isEn ? 'Clear saved credentials?' : '清除已保存的凭据？',
      description: isEn
        ? 'The encrypted credential file will be removed. You will need to re-enter the keys.'
        : '加密的凭据文件将被删除，之后需要重新填写密钥。',
      tone: 'warning'
    })
    if (!confirmed) return
    await window.api.idcClearCredentials()
    const status = await window.api.idcCredentialStatus()
    if (status.success) setCredStatus(status.data)
    appendLog(isEn ? 'Saved credentials cleared.' : '已清除保存的凭据。')
  }, [appendLog, isEn])

  const handlePlan = useCallback(async () => {
    setSummary(null)
    setProgress(null)
    const data = await run('planning', () =>
      window.api.idcPlanSeats({
        credentials: creds,
        quotas: quotas.filter((q) => q.count > 0).map((q) => ({ tier: q.tier, count: q.count })),
        domains
      })
    )
    if (data) {
      setPlanned(data.seats)
      appendLog(
        isEn
          ? `Generated ${data.seats.length} seat(s) for review.`
          : `已生成 ${data.seats.length} 个待开通席位，请核对后执行。`
      )
    }
  }, [appendLog, creds, domains, isEn, quotas, run])

  const handleProvision = useCallback(async () => {
    if (planned.length === 0) return
    const cost = planned.reduce((sum, s) => sum + TIER_MONTHLY_PRICE_USD[s.tier], 0)
    const confirmed = await askConfirm({
      title: isEn ? `Provision ${planned.length} seat(s)?` : `确认开通 ${planned.length} 个席位？`,
      description: isEn
        ? `This creates real users and paid Kiro subscriptions in your AWS account. Estimated cost: $${cost}/month. Existing users and subscriptions are skipped.`
        : `将在你的 AWS 账号里真实建号并挂付费 Kiro 订阅，预计月度成本 $${cost}。已存在的用户与订阅会自动跳过。`,
      tone: 'warning',
      confirmText: isEn ? 'Provision' : '开始开通'
    })
    if (!confirmed) return

    setProgress({ done: 0, total: planned.length })
    const data = await run('provisioning', () =>
      window.api.idcProvision({
        credentials: creds,
        seats: planned,
        sendPasswordEmail,
        concurrency
      })
    )
    if (data) {
      setSummary(data)
      // 开通后刷新库存，让下方列表反映最新状态
      const inv = await window.api.idcInventory(creds)
      if (inv.success) setInventory(inv.data)
    }
  }, [concurrency, creds, isEn, planned, run, sendPasswordEmail])

  const handleLoadInventory = useCallback(async () => {
    const data = await run('loading-inventory', () => window.api.idcInventory(creds))
    if (data) {
      setInventory(data)
      setSelected(new Set())
      appendLog(
        isEn
          ? `Loaded ${data.seats.length} subscribed seat(s), ${data.unsubscribedUsers.length} user(s) without subscription.`
          : `已加载 ${data.seats.length} 个已订阅席位，${data.unsubscribedUsers.length} 个未订阅用户。`
      )
    }
  }, [appendLog, creds, isEn, run])

  const selectedTargets = useMemo(() => {
    if (!inventory) return []
    const all = [
      ...inventory.seats.map((s) => ({ userId: s.userId, username: s.username })),
      ...inventory.unsubscribedUsers.map((u) => ({ userId: u.userId, username: u.username }))
    ]
    return all.filter((t) => selected.has(t.userId))
  }, [inventory, selected])

  const afterBatch = useCallback(
    async (results: BatchOpResult[], label: string) => {
      const ok = results.filter((r) => r.status === 'ok').length
      const skipped = results.filter((r) => r.status === 'skipped').length
      const failed = results.filter((r) => r.status === 'failed')
      appendLog(`${label}: ${ok} ok / ${skipped} skipped / ${failed.length} failed`)
      for (const f of failed) appendLog(`  ✗ ${f.username}: ${f.error}`)
      const inv = await window.api.idcInventory(creds)
      if (inv.success) {
        setInventory(inv.data)
        setSelected(new Set())
      }
    },
    [appendLog, creds]
  )

  const handleChangeTier = useCallback(async () => {
    if (selectedTargets.length === 0) return
    const confirmed = await askConfirm({
      title: isEn
        ? `Change ${selectedTargets.length} seat(s) to ${batchTier}?`
        : `将 ${selectedTargets.length} 个席位改为 ${batchTier}？`,
      description: isEn
        ? `New monthly cost for these seats: $${TIER_MONTHLY_PRICE_USD[batchTier] * selectedTargets.length}.`
        : `这些席位改档后的月度成本：$${TIER_MONTHLY_PRICE_USD[batchTier] * selectedTargets.length}。`,
      tone: 'warning'
    })
    if (!confirmed) return
    const data = await run('batch', () =>
      window.api.idcChangeTier({
        credentials: creds,
        targets: selectedTargets,
        tier: batchTier,
        concurrency
      })
    )
    if (data) await afterBatch(data, isEn ? 'Change tier' : '改档')
  }, [afterBatch, batchTier, concurrency, creds, isEn, run, selectedTargets])

  const handleUnsubscribe = useCallback(async () => {
    if (selectedTargets.length === 0) return
    const confirmed = await askConfirm({
      title: isEn
        ? `Cancel ${selectedTargets.length} subscription(s)?`
        : `取消 ${selectedTargets.length} 个席位的订阅？`,
      description: isEn
        ? 'Users are kept but lose Kiro access and stop incurring cost.'
        : '用户保留，但会失去 Kiro 访问权限并停止计费。',
      tone: 'warning'
    })
    if (!confirmed) return
    const data = await run('batch', () =>
      window.api.idcUnsubscribe({ credentials: creds, targets: selectedTargets, concurrency })
    )
    if (data) await afterBatch(data, isEn ? 'Unsubscribe' : '取消订阅')
  }, [afterBatch, concurrency, creds, isEn, run, selectedTargets])

  const handleResendPassword = useCallback(async () => {
    if (selectedTargets.length === 0) return
    const data = await run('batch', () =>
      window.api.idcResendPassword({ credentials: creds, targets: selectedTargets, concurrency })
    )
    if (data) await afterBatch(data, isEn ? 'Resend password email' : '重发密码邮件')
  }, [afterBatch, concurrency, creds, isEn, run, selectedTargets])

  const handleDelete = useCallback(async () => {
    if (selectedTargets.length === 0) return
    const confirmed = await askConfirm({
      title: isEn
        ? `Delete ${selectedTargets.length} user(s)?`
        : `删除 ${selectedTargets.length} 个用户？`,
      description: isEn
        ? 'This is irreversible. Subscriptions are cancelled first, then the users are removed from the Identity Store.'
        : '此操作不可恢复。会先取消订阅，然后从 Identity Store 中删除这些用户。',
      tone: 'danger',
      confirmText: isEn ? 'Delete' : '删除'
    })
    if (!confirmed) return
    const data = await run('batch', () =>
      window.api.idcDeleteSeats({ credentials: creds, targets: selectedTargets, concurrency })
    )
    if (data) await afterBatch(data, isEn ? 'Delete users' : '删除用户')
  }, [afterBatch, concurrency, creds, isEn, run, selectedTargets])

  /** 导出席位 CSV。序号列仅系统内对账用，AWS 侧没有这个字段 */
  const exportCsv = useCallback(
    (
      rows: {
        seq?: string
        email: string
        username: string
        tier?: KiroTier
        displayName?: string
      }[],
      filename: string
    ) => {
      const header = 'Seq,Email,UserName,DisplayName,KiroTier'
      const escape = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
      const body = rows
        .map((r) =>
          [r.seq ?? '', r.email, r.username, r.displayName ?? '', r.tier ?? '']
            .map((v) => escape(String(v)))
            .join(',')
        )
        .join('\n')
      const blob = new Blob([`${header}\n${body}\n`], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    },
    []
  )

  const busyLabel = isEn ? 'Working…' : '处理中…'
  const isBusy = busy !== 'idle'

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Users}
        accent="indigo"
        title={isEn ? 'Kiro Seats' : 'Kiro 席位分配'}
        description={
          isEn
            ? 'Bulk-provision Identity Center users and assign paid Kiro tiers from your own AWS account.'
            : '从你的 AWS 母号批量开通 Identity Center 用户并分配付费 Kiro 档位。'
        }
      />

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      {/* ============ 凭据 ============ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{isEn ? 'AWS credentials' : 'AWS 凭据'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-44">
              <Label className="text-xs">{isEn ? 'Source' : '凭据来源'}</Label>
              <Select
                value={creds.source}
                onChange={(value) =>
                  setCreds({ ...creds, source: value as IdcCredentialConfig['source'] })
                }
                options={[
                  { value: 'manual', label: isEn ? 'Enter keys here' : '在此填写密钥' },
                  { value: 'profile', label: isEn ? 'Local ~/.aws profile' : '本机 ~/.aws profile' }
                ]}
              />
            </div>
            <div className="w-44">
              <Label className="text-xs">Region</Label>
              <Select
                value={creds.region}
                onChange={(value) => setCreds({ ...creds, region: value })}
                options={COMMON_AWS_REGIONS.map((r) => ({ value: r, label: r }))}
              />
            </div>
            {creds.source === 'profile' && (
              <div className="w-56">
                <Label className="text-xs">Profile</Label>
                <Select
                  value={creds.profile ?? ''}
                  onChange={(value) => setCreds({ ...creds, profile: value })}
                  options={[
                    { value: '', label: 'default' },
                    ...profiles.map((p) => ({ value: p, label: p }))
                  ]}
                />
              </div>
            )}
          </div>

          {creds.source === 'manual' && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label className="text-xs">Access Key ID</Label>
                <Input
                  value={creds.accessKeyId ?? ''}
                  onChange={(e) => setCreds({ ...creds, accessKeyId: e.target.value })}
                  placeholder="AKIA…"
                  spellCheck={false}
                />
              </div>
              <div>
                <Label className="text-xs">Secret Access Key</Label>
                <Input
                  type="password"
                  value={creds.secretAccessKey ?? ''}
                  onChange={(e) => setCreds({ ...creds, secretAccessKey: e.target.value })}
                  placeholder="••••••••"
                  spellCheck={false}
                />
              </div>
              <div>
                <Label className="text-xs">
                  Session Token{' '}
                  <span className="text-muted-foreground">({isEn ? 'optional' : '可选'})</span>
                </Label>
                <Input
                  type="password"
                  value={creds.sessionToken ?? ''}
                  onChange={(e) => setCreds({ ...creds, sessionToken: e.target.value })}
                  placeholder={isEn ? 'for temporary (STS) credentials' : '临时凭据才需要'}
                  spellCheck={false}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleTest} disabled={isBusy || !credsReady} size="sm">
              {busy === 'testing' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="mr-1.5 h-3.5 w-3.5" />
              )}
              {isEn ? 'Test connection' : '测试连接'}
            </Button>
            <Button
              onClick={handleSaveCreds}
              disabled={isBusy || !credsReady}
              variant="outline"
              size="sm"
            >
              {isEn ? 'Save' : '保存凭据'}
            </Button>
            {credStatus?.hasSaved && (
              <Button onClick={handleClearCreds} disabled={isBusy} variant="outline" size="sm">
                {isEn ? 'Clear saved' : '清除已保存'}
              </Button>
            )}
            {credStatus?.hasSaved && credStatus.accessKeyIdTail && (
              <span className="text-xs text-muted-foreground">
                {isEn ? 'Saved key ending' : '已保存密钥尾号'} ····{credStatus.accessKeyIdTail}
              </span>
            )}
          </div>

          {credStatus && !credStatus.encryptionAvailable && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {isEn
                ? 'OS-level encryption is unavailable, so credentials cannot be saved. They will not be written to disk in plain text.'
                : '当前系统未提供加密存储，无法保存凭据。不会以明文写入磁盘，每次需要手填。'}
            </p>
          )}

          {connInfo && (
            <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-400">
              Identity Store <span className="font-mono">{connInfo.identityStoreId}</span> ·{' '}
              {isEn
                ? `${connInfo.seatCount} subscribed, ${connInfo.unsubscribedCount} without subscription`
                : `已订阅 ${connInfo.seatCount} 个，未订阅 ${connInfo.unsubscribedCount} 个`}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ============ 生成计划 ============ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{isEn ? 'Plan new seats' : '生成开通计划'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">{isEn ? 'Email domain pool' : '邮箱域名池'}</Label>
            <Input
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
              placeholder={
                isEn
                  ? 'seats.example.com  another.example.com'
                  : 'seats.example.com  另一个域名.com（空格或逗号分隔）'
              }
              spellCheck={false}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {isEn
                ? 'Addresses are generated as realistic-looking names on these domains. Use a domain whose mail you can actually receive — the AWS password link expires in 1 hour and users log in with this address long-term.'
                : '会在这些域名下生成真人名风格的地址。必须用你能实际收信的域名：AWS 密码设置链接 1 小时过期，且用户之后长期用这个地址登录。'}
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{isEn ? 'Tiers and counts' : '档位与数量'}</Label>
            {quotas.map((quota, index) => (
              <div key={index} className="flex items-center gap-2">
                <Select
                  className="w-56"
                  value={quota.tier}
                  onChange={(value) => {
                    const next = [...quotas]
                    next[index] = { ...next[index], tier: value as KiroTier }
                    setQuotas(next)
                  }}
                  options={KIRO_TIER_ORDER.map((t) => ({
                    value: t,
                    label: t,
                    description: `$${TIER_MONTHLY_PRICE_USD[t]}/mo · ${TIER_MONTHLY_CREDITS[t]} credits`
                  }))}
                />
                <Input
                  type="number"
                  min={0}
                  className="w-28"
                  value={quota.count}
                  onChange={(e) => {
                    const next = [...quotas]
                    next[index] = {
                      ...next[index],
                      count: Math.max(0, Number(e.target.value) || 0)
                    }
                    setQuotas(next)
                  }}
                />
                <span className="w-28 text-xs text-muted-foreground">
                  ${TIER_MONTHLY_PRICE_USD[quota.tier] * Math.max(0, quota.count)}/mo
                </span>
                {quotas.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setQuotas(quotas.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // 默认补一个还没用过的档位，省一次下拉操作
                const used = new Set(quotas.map((q) => q.tier))
                const nextTier = KIRO_TIER_ORDER.find((t) => !used.has(t)) ?? KIRO_TIER.PRO
                setQuotas([...quotas, { tier: nextTier, count: 10 }])
              }}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {isEn ? 'Add tier' : '添加档位'}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch checked={sendPasswordEmail} onCheckedChange={setSendPasswordEmail} />
              <span className="text-sm">
                {isEn ? 'Send password setup email' : '发送密码设置邮件'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs">{isEn ? 'Concurrency' : '并发'}</Label>
              <Input
                type="number"
                min={1}
                max={20}
                className="w-20"
                value={concurrency}
                onChange={(e) =>
                  setConcurrency(Math.min(20, Math.max(1, Number(e.target.value) || 1)))
                }
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button onClick={handlePlan} disabled={isBusy || !domains.trim() || totalSeats === 0}>
              {busy === 'planning' ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="mr-1.5 h-4 w-4" />
              )}
              {isEn ? `Generate ${totalSeats} seat(s)` : `生成 ${totalSeats} 个席位`}
            </Button>
            <span className="text-sm text-muted-foreground">
              {isEn ? 'Estimated' : '预计'}{' '}
              <span className="font-semibold text-foreground">${monthlyCost}</span>/mo
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ============ 预览 ============ */}
      {planned.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">
              {isEn ? `Review ${planned.length} seat(s)` : `核对 ${planned.length} 个待开通席位`}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportCsv(planned, `kiro-seats-plan-${Date.now()}.csv`)}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                CSV
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPlanned([])} disabled={isBusy}>
                {isEn ? 'Discard' : '放弃'}
              </Button>
              <Button size="sm" onClick={handleProvision} disabled={isBusy}>
                {busy === 'provisioning' ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                )}
                {isEn ? 'Provision' : '确认开通'}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="max-h-72 overflow-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-2 py-1.5 font-medium">{isEn ? 'Seq' : '序号'}</th>
                    <th className="px-2 py-1.5 font-medium">Email / UserName</th>
                    <th className="px-2 py-1.5 font-medium">{isEn ? 'Display name' : '显示名'}</th>
                    <th className="px-2 py-1.5 font-medium">{isEn ? 'Tier' : '档位'}</th>
                  </tr>
                </thead>
                <tbody>
                  {planned.map((seat) => (
                    <tr key={seat.rowId} className="border-b border-border/50 last:border-0">
                      <td className="px-2 py-1 font-mono text-muted-foreground">{seat.seq}</td>
                      <td className="px-2 py-1 font-mono">{seat.email}</td>
                      <td className="px-2 py-1">{seat.displayName}</td>
                      <td className="px-2 py-1">
                        <TierBadge tier={seat.tier} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {isEn
                ? 'The Seq column is local bookkeeping only — it is not written to any AWS field.'
                : '序号列仅本地对账用，不会写入 AWS 侧任何字段。'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ============ 进度与结果 ============ */}
      {(progress || summary || logs.length > 0) && (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">{isEn ? 'Progress' : '执行进度'}</CardTitle>
            <div className="flex items-center gap-2">
              {busy === 'provisioning' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void window.api.idcCancelProvision()}
                >
                  {isEn ? 'Cancel' : '取消'}
                </Button>
              )}
              {logs.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setLogs([])}>
                  {isEn ? 'Clear log' : '清空日志'}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {progress && progress.total > 0 && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{isBusy ? busyLabel : isEn ? 'Done' : '已完成'}</span>
                  <span className="font-mono">
                    {progress.done} / {progress.total}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-violet-500 transition-all"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {summary && (
              <div className="grid gap-2 sm:grid-cols-3">
                <SummaryStat
                  label={isEn ? 'Users' : '建号'}
                  ok={summary.usersCreated}
                  skipped={summary.usersSkipped}
                  failed={summary.usersFailed}
                  isEn={isEn}
                />
                <SummaryStat
                  label={isEn ? 'Password emails' : '密码邮件'}
                  ok={summary.emailsSent}
                  failed={summary.emailsFailed}
                  isEn={isEn}
                />
                <SummaryStat
                  label={isEn ? 'Subscriptions' : '订阅'}
                  ok={summary.subscribed}
                  skipped={summary.subscribeSkipped}
                  failed={summary.subscribeFailed}
                  isEn={isEn}
                />
              </div>
            )}

            {summary?.aborted && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {isEn
                  ? 'Cancelled before finishing. Re-running is safe — existing seats are skipped.'
                  : '已在完成前取消。可以安全重跑，已存在的席位会自动跳过。'}
              </p>
            )}

            {summary && summary.results.some((r) => r.error) && (
              <div className="max-h-48 overflow-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-2 py-1.5 font-medium">{isEn ? 'Seq' : '序号'}</th>
                      <th className="px-2 py-1.5 font-medium">Email</th>
                      <th
                        className="px-2 py-1.5 font-medium"
                        title={isEn ? 'create / email / subscribe' : '建号 / 邮件 / 订阅'}
                      >
                        {isEn ? 'Steps' : '步骤'}
                      </th>
                      <th className="px-2 py-1.5 font-medium">{isEn ? 'Error' : '错误'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.results
                      .filter((r) => r.error)
                      .map((r) => (
                        <tr key={r.seq} className="border-b border-border/50 last:border-0">
                          <td className="px-2 py-1 font-mono text-muted-foreground">{r.seq}</td>
                          <td className="px-2 py-1 font-mono">{r.email}</td>
                          <td className="px-2 py-1">
                            <span className="inline-flex items-center gap-1">
                              <StepIcon status={r.createUser} />
                              <StepIcon status={r.resetPassword} />
                              <StepIcon status={r.subscribe} />
                            </span>
                          </td>
                          <td className="px-2 py-1 break-all text-red-600 dark:text-red-400">
                            {r.error}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            {logs.length > 0 && (
              <div
                ref={logBoxRef}
                className="max-h-56 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-2xs leading-relaxed"
              >
                {logs.map((line) => (
                  <div key={line.id} className="break-all">
                    {line.text}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ============ 现有席位 ============ */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">
            {isEn ? 'Existing seats' : '现有席位'}
            {inventory && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {isEn
                  ? `${inventory.seats.length} subscribed · $${inventoryCost}/mo · ${inventory.unsubscribedUsers.length} unsubscribed`
                  : `已订阅 ${inventory.seats.length} · $${inventoryCost}/月 · 未订阅 ${inventory.unsubscribedUsers.length}`}
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {inventory && inventory.seats.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportCsv(inventory.seats, `kiro-seats-inventory-${Date.now()}.csv`)}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                CSV
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleLoadInventory}
              disabled={isBusy || !credsReady}
            >
              {busy === 'loading-inventory' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {isEn ? 'Load' : '加载'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {!inventory ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {isEn
                ? 'Click Load to fetch current seats from AWS.'
                : '点击「加载」从 AWS 拉取当前席位。'}
            </p>
          ) : (
            <>
              {selectedTargets.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                  <span className="text-xs text-muted-foreground">
                    {isEn
                      ? `${selectedTargets.length} selected`
                      : `已选 ${selectedTargets.length} 个`}
                  </span>
                  <Select
                    className="w-36"
                    value={batchTier}
                    onChange={(value) => setBatchTier(value as KiroTier)}
                    options={KIRO_TIER_ORDER.map((t) => ({ value: t, label: t }))}
                  />
                  <Button size="sm" variant="outline" onClick={handleChangeTier} disabled={isBusy}>
                    <ArrowUpDown className="mr-1.5 h-3.5 w-3.5" />
                    {isEn ? 'Change tier' : '改档'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleResendPassword}
                    disabled={isBusy}
                  >
                    <Mail className="mr-1.5 h-3.5 w-3.5" />
                    {isEn ? 'Resend password' : '重发密码邮件'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleUnsubscribe} disabled={isBusy}>
                    <Ban className="mr-1.5 h-3.5 w-3.5" />
                    {isEn ? 'Unsubscribe' : '取消订阅'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleDelete} disabled={isBusy}>
                    <Trash2 className="mr-1.5 h-3.5 w-3.5 text-red-500" />
                    {isEn ? 'Delete users' : '删除用户'}
                  </Button>
                </div>
              )}

              <SeatTable
                inventory={inventory}
                selected={selected}
                onToggle={(userId) => {
                  const next = new Set(selected)
                  if (next.has(userId)) next.delete(userId)
                  else next.add(userId)
                  setSelected(next)
                }}
                onToggleAll={(userIds, checked) => {
                  const next = new Set(selected)
                  for (const id of userIds) {
                    if (checked) next.add(id)
                    else next.delete(id)
                  }
                  setSelected(next)
                }}
                isEn={isEn}
              />

              {inventory.orphanSubscriptions.length > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {isEn
                    ? `${inventory.orphanSubscriptions.length} subscription(s) reference users that no longer exist in the Identity Store.`
                    : `有 ${inventory.orphanSubscriptions.length} 条订阅指向已不存在的用户（脏数据，仍可能计费）。`}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryStat({
  label,
  ok,
  skipped,
  failed,
  isEn
}: {
  label: string
  ok: number
  skipped?: number
  failed: number
  isEn: boolean
}): React.ReactNode {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-3 text-sm">
        <span className="text-green-600 dark:text-green-400">
          {ok} {isEn ? 'ok' : '成功'}
        </span>
        {skipped !== undefined && (
          <span className="text-muted-foreground">
            {skipped} {isEn ? 'skipped' : '跳过'}
          </span>
        )}
        <span className={failed > 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}>
          {failed} {isEn ? 'failed' : '失败'}
        </span>
      </div>
    </div>
  )
}

function SeatTable({
  inventory,
  selected,
  onToggle,
  onToggleAll,
  isEn
}: {
  inventory: SeatInventory
  selected: Set<string>
  onToggle: (userId: string) => void
  onToggleAll: (userIds: string[], checked: boolean) => void
  isEn: boolean
}): React.ReactNode {
  type Row = ExistingSeat & { subscribed: boolean }
  const rows: Row[] = [
    ...inventory.seats.map((s) => ({ ...s, subscribed: true })),
    ...inventory.unsubscribedUsers.map((u) => ({ ...u, subscribed: false }))
  ]
  const allIds = rows.map((r) => r.userId)
  const allChecked = allIds.length > 0 && allIds.every((id) => selected.has(id))

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text)
  }

  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        {isEn ? 'No users in this Identity Store yet.' : '这个 Identity Store 里还没有用户。'}
      </p>
    )
  }

  return (
    <div className="max-h-96 overflow-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="w-8 px-2 py-1.5">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(e) => onToggleAll(allIds, e.target.checked)}
                aria-label={isEn ? 'Select all seats' : '全选席位'}
              />
            </th>
            <th className="px-2 py-1.5 font-medium">Email / UserName</th>
            <th className="px-2 py-1.5 font-medium">{isEn ? 'Display name' : '显示名'}</th>
            <th className="px-2 py-1.5 font-medium">{isEn ? 'Tier' : '档位'}</th>
            <th className="px-2 py-1.5 font-medium">{isEn ? 'Status' : '状态'}</th>
            <th className="w-8 px-2 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.userId}
              className={cn(
                'border-b border-border/50 last:border-0',
                !row.subscribed && 'bg-muted/20'
              )}
            >
              <td className="px-2 py-1">
                <input
                  type="checkbox"
                  checked={selected.has(row.userId)}
                  onChange={() => onToggle(row.userId)}
                  aria-label={`${isEn ? 'Select' : '选择'} ${row.username}`}
                />
              </td>
              <td className="px-2 py-1 font-mono">{row.username || row.email}</td>
              <td className="px-2 py-1">{row.displayName}</td>
              <td className="px-2 py-1">
                {row.subscribed ? (
                  <TierBadge tier={row.tier} raw={row.rawSubscriptionType} />
                ) : (
                  <span className="text-2xs text-muted-foreground">{isEn ? 'none' : '无订阅'}</span>
                )}
              </td>
              <td className="px-2 py-1 text-muted-foreground">
                {row.subscribed ? row.status || '—' : isEn ? 'not billed' : '未计费'}
              </td>
              <td className="px-2 py-1">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => copy(row.username || row.email)}
                  title={isEn ? 'Copy address' : '复制地址'}
                >
                  <Copy className="h-3 w-3" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
