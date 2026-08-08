import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CirclePause,
  CirclePlay,
  Crosshair,
  Edit3,
  Link2,
  Loader2,
  PackageCheck,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ServerCog,
  Trash2,
  TriangleAlert,
  Wallet
} from 'lucide-react'
import {
  DEFAULT_KSK_HUNTER_CONFIG,
  KSK_HUNTER_BUDGET_BLOCK,
  KSK_HUNTER_CHANNEL,
  KSK_HUNTER_CHANNEL_LABEL,
  KSK_HUNTER_DELIVERY_STATE,
  KSK_HUNTER_MODE,
  KSK_HUNTER_POLL_INTERVAL_SECONDS,
  KSK_HUNTER_STATE,
  type KskHunterChannel,
  type KskHunterConfig,
  type KskHunterDeliveryView,
  type KskHunterLinkInput,
  type KskHunterLinkView,
  type KskHunterSnapshot
} from '../../../../shared/kskHunter'
import type { IdcIpcResult } from '../../../../shared/idcSeats'
import { useAccountsStore } from '../../store/accounts'
import { HunterLinkEditorDialog } from '../automation/HunterLinkEditorDialog'
import { HunterReportCard } from '../automation/HunterReportCard'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  PageHeader,
  Select,
  Switch,
  askConfirm
} from '../ui'

const UNGROUPED_OPTION = '__ungrouped__'

type LinkAction = 'toggle' | 'delete'
type BusyKey = { id: string; action: LinkAction | 'delivery' } | null

function formatTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : '—'
}

function stateLabel(snapshot: KskHunterSnapshot | null): string {
  if (!snapshot) return '加载中'
  switch (snapshot.status.state) {
    case KSK_HUNTER_STATE.RUNNING:
      return '正在查询'
    case KSK_HUNTER_STATE.HEALTHY:
      return '监控正常'
    case KSK_HUNTER_STATE.DEGRADED:
      return '部分异常'
    default:
      return '未启动'
  }
}

function stateTone(snapshot: KskHunterSnapshot | null): string {
  if (snapshot?.status.state === KSK_HUNTER_STATE.HEALTHY) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
  }
  if (snapshot?.status.state === KSK_HUNTER_STATE.DEGRADED) {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300'
  }
  if (snapshot?.status.state === KSK_HUNTER_STATE.RUNNING) {
    return 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300'
  }
  return 'border-border bg-muted/40 text-muted-foreground'
}

const DELIVERY_LABEL: Record<string, { text: string; tone: string }> = {
  [KSK_HUNTER_DELIVERY_STATE.PENDING]: {
    text: '待推送',
    tone: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300'
  },
  [KSK_HUNTER_DELIVERY_STATE.DELIVERED]: {
    text: '已交付',
    tone: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
  },
  [KSK_HUNTER_DELIVERY_STATE.FAILED]: {
    text: '推送失败',
    tone: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
  },
  [KSK_HUNTER_DELIVERY_STATE.DEAD_KEY]: {
    text: '验活未通过',
    tone: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300'
  }
}

export function HunterPage(): React.ReactNode {
  const groups = useAccountsStore((state) => state.groups)
  const [snapshot, setSnapshot] = useState<KskHunterSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<BusyKey>(null)
  const [savingConfig, setSavingConfig] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingLink, setEditingLink] = useState<KskHunterLinkView | undefined>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // 配置表单本地态：避免每次输入都打一次 IPC
  const [configDraft, setConfigDraft] = useState<KskHunterConfig>(DEFAULT_KSK_HUNTER_CONFIG)
  const [downstreamApiKey, setDownstreamApiKey] = useState('')
  /** 余额地址是密钥类字段：不回填明文，留空表示保持原值。 */
  const [balanceUrlDrafts, setBalanceUrlDrafts] = useState<Partial<Record<string, string>>>({})

  const applySnapshot = useCallback((next: KskHunterSnapshot): void => {
    setSnapshot(next)
    setConfigDraft({
      targetGroupId: next.config.targetGroupId,
      requestTimeoutSeconds: next.config.requestTimeoutSeconds,
      notifyOnAutoOrder: next.config.notifyOnAutoOrder,
      downstreamEnabled: next.config.downstreamEnabled,
      downstreamBaseUrl: next.config.downstreamBaseUrl,
      dailyLimitCny: next.config.dailyLimitCny,
      billing: next.config.billing,
      allowUnknownPriceOrder: next.config.allowUnknownPriceOrder,
      balanceCheckEnabled: next.config.balanceCheckEnabled
    })
    setBalanceUrlDrafts({})
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await window.api.kskHunterSnapshot()
      if (!result.success) throw new Error(result.error || '加载抢号配置失败')
      applySnapshot(result.data)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [applySnapshot])

  useEffect(() => {
    void load()
    // 状态事件不带 config，不会覆盖用户正在编辑的配置草稿
    return window.api.onKskHunterStatus((event) => {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              status: event.status,
              links: event.links,
              deliveries: event.deliveries,
              spend: event.spend
            }
          : current
      )
    })
  }, [load])

  const groupOptions = useMemo(
    () => [
      { value: UNGROUPED_OPTION, label: '默认（未分组）' },
      ...Array.from(groups.values())
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((group) => ({ value: group.id, label: group.name }))
    ],
    [groups]
  )

  const links = snapshot?.links ?? []
  const deliveries = snapshot?.deliveries ?? []
  const enabledCount = links.filter((link) => link.enabled).length
  const inStockCount = links.filter((link) => link.enabled && link.lastInStock).length
  const budgetBlocked =
    snapshot !== null &&
    (snapshot.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.GLOBAL ||
      snapshot.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.CHANNEL)
  const balanceBlocked = snapshot?.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.BALANCE
  const lowBalanceChannels = (snapshot?.balances ?? []).filter((item) => item.isLow)
  const blockedChannelNames = (snapshot?.status.budgetBlockedChannels ?? [])
    .map((channel) => KSK_HUNTER_CHANNEL_LABEL[channel])
    .join('、')

  const runAction = async (
    key: BusyKey,
    action: () => Promise<IdcIpcResult<KskHunterSnapshot>>,
    successMessage: string
  ): Promise<void> => {
    setBusy(key)
    setError('')
    setNotice('')
    try {
      const result = await action()
      if (!result.success) throw new Error(result.error || '操作失败')
      applySnapshot(result.data)
      setNotice(successMessage)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setBusy(null)
    }
  }

  const handleSaveLink = async (input: KskHunterLinkInput): Promise<void> => {
    const result = editingLink
      ? await window.api.kskHunterUpdateLink(editingLink.id, input)
      : await window.api.kskHunterCreateLink(input)
    if (!result.success) throw new Error(result.error || '保存链接失败')
    applySnapshot(result.data)
    setEditorOpen(false)
    setEditingLink(undefined)
    setNotice(editingLink ? '链接已更新。' : '链接已加入监控。')
  }

  const handleDeleteLink = async (link: KskHunterLinkView): Promise<void> => {
    const confirmed = await askConfirm({
      title: `删除链接“${link.name}”？`,
      description: '将停止监控该链接并删除保存的列表地址与下单地址。已抢到的号不受影响。',
      confirmText: '删除链接',
      cancelText: '取消',
      tone: 'danger',
      holdToConfirmMs: 700
    })
    if (!confirmed) return
    await runAction(
      { id: link.id, action: 'delete' },
      () => window.api.kskHunterDeleteLink(link.id),
      `已删除“${link.name}”。`
    )
  }

  const handleSaveConfig = async (): Promise<void> => {
    setSavingConfig(true)
    setError('')
    setNotice('')
    try {
      // 只提交用户实际填过的余额地址；留空的键省略，主进程会保留原值
      const balanceUrls = Object.fromEntries(
        Object.entries(balanceUrlDrafts).filter(([, url]) => url !== undefined && url !== '')
      )
      const result = await window.api.kskHunterUpdateConfig(
        configDraft,
        downstreamApiKey.trim() || Object.keys(balanceUrls).length > 0
          ? {
              ...(downstreamApiKey.trim() ? { downstreamApiKey: downstreamApiKey.trim() } : {}),
              ...(Object.keys(balanceUrls).length > 0 ? { balanceUrls } : {})
            }
          : undefined
      )
      if (!result.success) throw new Error(result.error || '保存配置失败')
      applySnapshot(result.data)
      setDownstreamApiKey('')
      setNotice('抢号配置已保存。')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSavingConfig(false)
    }
  }

  const handleDeleteDelivery = async (delivery: KskHunterDeliveryView): Promise<void> => {
    const confirmed = await askConfirm({
      title: `删除记录 ${delivery.maskedKey}？`,
      description:
        delivery.state === KSK_HUNTER_DELIVERY_STATE.DELIVERED
          ? '该记录已交付，删除只影响这里的展示。'
          : '该记录尚未交付。删除后主进程不会再尝试推送这个 KSK。',
      confirmText: '删除记录',
      cancelText: '取消',
      tone: 'danger',
      holdToConfirmMs: 700
    })
    if (!confirmed) return
    await runAction(
      { id: delivery.id, action: 'delivery' },
      () => window.api.kskHunterDeleteDelivery(delivery.id),
      '记录已删除。'
    )
  }

  const isBusy = (id: string, action: LinkAction | 'delivery'): boolean =>
    busy?.id === id && busy.action === action

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        eyebrow="KSK HUNTER"
        title="抢号监控"
        description={`每 ${KSK_HUNTER_POLL_INTERVAL_SECONDS} 秒并行查一遍商品聚合站点，开货即提醒或自动下单推送下游。`}
        icon={Crosshair}
        accent="violet"
        badges={
          <>
            <Badge variant="outline">{links.length} 条链接</Badge>
            <Badge variant="outline" className={stateTone(snapshot)}>
              {stateLabel(snapshot)}
            </Badge>
          </>
        }
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                runAction(null, () => window.api.kskHunterRunNow(), '已完成一次全量查询。')
              }
              disabled={loading || enabledCount === 0}
            >
              <Play className="mr-1.5 h-4 w-4" />
              立即查一轮
            </Button>
            <Button
              onClick={() => {
                setEditingLink(undefined)
                setEditorOpen(true)
              }}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              新增链接
            </Button>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          {[
            { label: '监控中', value: enabledCount, icon: Link2, tone: 'text-violet-500' },
            {
              label: '当前有货',
              value: inStockCount,
              icon: PackageCheck,
              tone: 'text-emerald-500'
            },
            {
              label: '今日花费',
              value: `¥${snapshot?.spend.totalCny ?? 0}`,
              icon: Wallet,
              tone: budgetBlocked ? 'text-red-500' : 'text-sky-500'
            },
            {
              label: '待推送 / 待处理',
              value: `${snapshot?.status.pendingDeliveries ?? 0} / ${snapshot?.status.failedDeliveries ?? 0}`,
              icon: TriangleAlert,
              tone: 'text-amber-500'
            }
          ].map((metric) => (
            <Card key={metric.label} className="border-border/70 bg-card/70">
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    {metric.label}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{metric.value}</p>
                </div>
                <metric.icon className={`h-5 w-5 ${metric.tone}`} />
              </CardContent>
            </Card>
          ))}
        </div>

        {budgetBlocked && (
          <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {snapshot?.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.GLOBAL
              ? `全局当日预算已用尽（¥${snapshot.spend.totalCny} / ¥${snapshot.spend.dailyLimitCny}），已暂停自动下单。开货仍会提醒，可手动购买。`
              : `以下渠道当日预算已用尽，已暂停其自动下单：${blockedChannelNames}。开货仍会提醒。`}
          </div>
        )}

        {(balanceBlocked || lowBalanceChannels.length > 0) && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            {balanceBlocked
              ? '余额不足以支付当前商品，已跳过自动下单。充值后自动恢复，无需手动操作。'
              : `以下渠道余额偏低，建议充值：${lowBalanceChannels
                  .map(
                    (item) =>
                      `${KSK_HUNTER_CHANNEL_LABEL[item.channel]}（剩 ${item.amountUnit} ${item.unitLabel}）`
                  )
                  .join('、')}`}
          </div>
        )}

        {(error || notice) && (
          <div
            className={`mb-4 rounded-xl border px-3 py-2 text-sm ${
              error
                ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
            }`}
          >
            {error || notice}
          </div>
        )}

        {snapshot && !snapshot.config.encryptionAvailable && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            系统加密存储不可用，无法保存商品链接 token 与下游 API Key。
          </div>
        )}

        {snapshot?.status.lastError && (
          <div className="mb-4 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {snapshot.status.lastError}
          </div>
        )}

        {/* 今日花费分渠道明细 */}
        {snapshot && (
          <Card className="mb-5 border-border/70 bg-card/70">
            <CardContent className="p-5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Wallet className="h-4 w-4 text-sky-500" />
                <h3 className="text-sm font-semibold">今日花费</h3>
                <span className="text-xs text-muted-foreground">{snapshot.spend.date}</span>
                <div className="ml-auto flex items-baseline gap-1.5">
                  <span className="text-lg font-semibold tabular-nums">
                    ¥{snapshot.spend.totalCny}
                  </span>
                  {snapshot.spend.dailyLimitCny > 0 && (
                    <span className="text-xs text-muted-foreground">
                      / ¥{snapshot.spend.dailyLimitCny} · 剩 ¥{snapshot.spend.remainingCny ?? 0}
                    </span>
                  )}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    共 {snapshot.spend.orderCount} 单
                  </span>
                </div>
              </div>

              {snapshot.spend.dailyLimitCny > 0 && (
                <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full transition-all ${
                      budgetBlocked ? 'bg-red-500' : 'bg-sky-500'
                    }`}
                    style={{
                      width: `${Math.min(100, (snapshot.spend.totalCny / snapshot.spend.dailyLimitCny) * 100)}%`
                    }}
                  />
                </div>
              )}

              <div className="grid gap-2 sm:grid-cols-3">
                {snapshot.spend.byChannel.map((item) => {
                  const exhausted =
                    item.dailyLimitUnit > 0 && item.amountUnit >= item.dailyLimitUnit
                  const balance = snapshot.balances.find((entry) => entry.channel === item.channel)
                  return (
                    <div
                      key={item.channel}
                      className={`rounded-xl border p-3 ${
                        exhausted
                          ? 'border-red-500/30 bg-red-500/[0.06]'
                          : 'border-border/60 bg-muted/15'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs font-medium">
                          {KSK_HUNTER_CHANNEL_LABEL[item.channel]}
                        </p>
                        {exhausted && (
                          <Badge
                            variant="outline"
                            className="border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300"
                          >
                            已用尽
                          </Badge>
                        )}
                      </div>
                      {/* 原币是记账口径，人民币只用于跨渠道对比，所以原币放大字 */}
                      <p className="mt-1 text-lg font-semibold tabular-nums">
                        {item.amountUnit}
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          {item.unitLabel}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {item.unitLabel !== 'CNY' && <>≈ ¥{item.amountCny} · </>}
                        {item.orderCount} 单
                        {item.dailyLimitUnit > 0
                          ? ` · 上限 ${item.dailyLimitUnit}（剩 ${item.remainingUnit ?? 0}）`
                          : ''}
                      </p>
                      {balance?.amountUnit !== undefined && (
                        <p
                          className={`mt-1 border-t border-border/40 pt-1 text-xs ${
                            balance.isLow
                              ? 'text-red-600 dark:text-red-300'
                              : 'text-muted-foreground'
                          }`}
                        >
                          余额 {balance.amountUnit} {balance.unitLabel}
                          {balance.isLow ? ' · 偏低，请充值' : ''}
                        </p>
                      )}
                      {balance?.error && (
                        <p className="mt-1 border-t border-border/40 pt-1 text-xs text-amber-700 dark:text-amber-300">
                          余额查询失败
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* 历史报表：数据来自独立的事件流文件，按需拉取而非跟着状态事件刷 */}
        <HunterReportCard />

        {/* 全局配置 */}
        <Card className="mb-5 border-border/70 bg-card/70">
          <CardContent className="space-y-4 p-5">
            <div className="flex items-center gap-2">
              <ServerCog className="h-4 w-4 text-emerald-500" />
              <h3 className="text-sm font-semibold">抢到号之后</h3>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label>写入账号分组</Label>
                <Select
                  value={configDraft.targetGroupId ?? UNGROUPED_OPTION}
                  options={groupOptions}
                  onChange={(value) =>
                    setConfigDraft({
                      ...configDraft,
                      targetGroupId: value === UNGROUPED_OPTION ? undefined : value
                    })
                  }
                />
              </div>
              <div>
                <Label>请求超时（秒）</Label>
                <Input
                  type="number"
                  min={3}
                  max={120}
                  value={configDraft.requestTimeoutSeconds}
                  onChange={(event) =>
                    setConfigDraft({
                      ...configDraft,
                      requestTimeoutSeconds: Number(event.target.value)
                    })
                  }
                />
              </div>
              <div className="flex items-end pb-2">
                <Switch
                  checked={configDraft.notifyOnAutoOrder}
                  onCheckedChange={(notifyOnAutoOrder) =>
                    setConfigDraft({ ...configDraft, notifyOnAutoOrder })
                  }
                />
                <span className="ml-2 text-xs">自动下单也弹通知</span>
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">推送给下游</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    下单前先 GET /need-account 问下游要不要号；验活通过后 POST /ksk
                    推送。推送失败会自动重试。
                  </p>
                </div>
                <Switch
                  checked={configDraft.downstreamEnabled}
                  onCheckedChange={(downstreamEnabled) =>
                    setConfigDraft({ ...configDraft, downstreamEnabled })
                  }
                  className="mt-0.5"
                />
              </div>
            </div>

            {configDraft.downstreamEnabled && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>下游地址</Label>
                  <Input
                    value={configDraft.downstreamBaseUrl}
                    onChange={(event) =>
                      setConfigDraft({ ...configDraft, downstreamBaseUrl: event.target.value })
                    }
                    className="font-mono text-xs"
                    placeholder="http://127.0.0.1:12889"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    明文 HTTP 只允许 loopback；远程地址必须用 HTTPS。
                  </p>
                </div>
                <div>
                  <Label>下游 API Key</Label>
                  <Input
                    type="password"
                    value={downstreamApiKey}
                    onChange={(event) => setDownstreamApiKey(event.target.value)}
                    placeholder={
                      snapshot?.config.hasDownstreamApiKey
                        ? `${snapshot.config.downstreamApiKeyTail} · 留空保持`
                        : '作为 x-api-key 头发送'
                    }
                  />
                </div>
              </div>
            )}

            <div className="space-y-3 rounded-xl border border-border/60 bg-muted/10 p-3">
              <div className="flex items-center gap-2">
                <Wallet className="h-4 w-4 text-sky-500" />
                <h4 className="text-sm font-medium">每日花费上限与汇率</h4>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>全局每日上限（元）</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={configDraft.dailyLimitCny}
                    onChange={(event) =>
                      setConfigDraft({ ...configDraft, dailyLimitCny: Number(event.target.value) })
                    }
                    placeholder="0 = 不限"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    跨渠道汇总只能用统一货币，所以这一层是人民币；单渠道上限按各自原币填。 填 0
                    不限，本地 00:00 归零。
                  </p>
                </div>
                <div className="flex items-start pt-6">
                  <Switch
                    checked={configDraft.allowUnknownPriceOrder}
                    onCheckedChange={(allowUnknownPriceOrder) =>
                      setConfigDraft({ ...configDraft, allowUnknownPriceOrder })
                    }
                  />
                  <div className="ml-2">
                    <span className="text-xs">商品无价格时仍然下单</span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      关闭更安全：算不出花费就不花钱，也不会漏记账。
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  各渠道计价单位不同（人民币、积分、点数），上限按**原币**填； 「1 单位 = ?
                  元」只用于跨渠道汇总展示。人民币计价的渠道填 1。
                </p>
                {(Object.values(KSK_HUNTER_CHANNEL) as KskHunterChannel[]).map((channel) => {
                  const billing =
                    configDraft.billing[channel] ?? DEFAULT_KSK_HUNTER_CONFIG.billing[channel]
                  const patchBilling = (patch: Partial<typeof billing>): void =>
                    setConfigDraft({
                      ...configDraft,
                      billing: {
                        ...configDraft.billing,
                        [channel]: { ...billing, ...patch }
                      }
                    })
                  return (
                    <div
                      key={channel}
                      className="space-y-2 rounded-lg border border-border/50 bg-background/40 p-2.5"
                    >
                      <div className="grid items-end gap-2 sm:grid-cols-[1fr_80px_90px_1fr_1fr]">
                        <p className="pb-2 text-xs font-medium">
                          {KSK_HUNTER_CHANNEL_LABEL[channel]}
                        </p>
                        <div>
                          <Label className="text-2xs">单位</Label>
                          <Input
                            value={billing.unitLabel}
                            onChange={(event) => patchBilling({ unitLabel: event.target.value })}
                            placeholder="积分"
                            className="font-mono text-xs"
                          />
                        </div>
                        <div>
                          <Label className="text-2xs">1 单位 = ? 元</Label>
                          <Input
                            type="number"
                            min={0}
                            step="0.0001"
                            value={billing.cnyPerUnit}
                            onChange={(event) =>
                              patchBilling({ cnyPerUnit: Number(event.target.value) })
                            }
                          />
                        </div>
                        <div>
                          <Label className="text-2xs">
                            每日上限（{billing.unitLabel || '原币'}）
                          </Label>
                          <Input
                            type="number"
                            min={0}
                            step="1"
                            value={billing.dailyLimitUnit}
                            onChange={(event) =>
                              patchBilling({ dailyLimitUnit: Number(event.target.value) })
                            }
                            placeholder="0 = 不限"
                          />
                        </div>
                        <div>
                          <Label className="text-2xs">余额低于此值提醒</Label>
                          <Input
                            type="number"
                            min={0}
                            step="1"
                            value={billing.lowBalanceThresholdUnit}
                            onChange={(event) =>
                              patchBilling({
                                lowBalanceThresholdUnit: Number(event.target.value)
                              })
                            }
                            placeholder="0 = 不提醒"
                          />
                        </div>
                      </div>
                      {configDraft.balanceCheckEnabled && (
                        <div>
                          <Label className="text-2xs">余额查询地址</Label>
                          <Input
                            type="password"
                            value={balanceUrlDrafts[channel] ?? ''}
                            onChange={(event) =>
                              setBalanceUrlDrafts({
                                ...balanceUrlDrafts,
                                [channel]: event.target.value
                              })
                            }
                            placeholder={
                              snapshot?.config.balanceUrlHints?.[channel]
                                ? `${snapshot.config.balanceUrlHints[channel]} · 留空保持`
                                : 'https://.../api/balance?token=...'
                            }
                            spellCheck={false}
                            className="font-mono text-xs"
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">查询余额并按余额拦单</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      余额不够付这一单就跳过，不白跑一次下单；低于阈值时提醒充值。 余额缓存 60
                      秒，下单后立即失效。
                    </p>
                  </div>
                  <Switch
                    checked={configDraft.balanceCheckEnabled}
                    onCheckedChange={(balanceCheckEnabled) =>
                      setConfigDraft({ ...configDraft, balanceCheckEnabled })
                    }
                    className="mt-0.5"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end border-t border-border/60 pt-3">
              <Button onClick={handleSaveConfig} disabled={savingConfig}>
                {savingConfig && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                保存配置
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 链接列表 */}
        {loading && links.length === 0 ? (
          <div className="grid min-h-48 place-items-center">
            <Loader2 className="h-7 w-7 animate-spin text-violet-500" />
          </div>
        ) : links.length === 0 ? (
          <Card className="border-dashed border-violet-500/25 bg-gradient-to-br from-violet-500/[0.06] to-transparent">
            <CardContent className="flex min-h-56 flex-col items-center justify-center text-center">
              <div className="mb-4 rounded-2xl border border-violet-500/20 bg-violet-500/10 p-4 text-violet-500">
                <Crosshair className="h-7 w-7" />
              </div>
              <h2 className="text-lg font-semibold">还没有监控链接</h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                添加商品聚合站点的列表接口，开货时就会提醒你，或者直接替你下单。
              </p>
              <Button
                className="mt-5"
                onClick={() => {
                  setEditingLink(undefined)
                  setEditorOpen(true)
                }}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                新增链接
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="mb-5 grid gap-3 xl:grid-cols-2">
            {links.map((link) => (
              <Card
                key={link.id}
                className={`overflow-hidden border-border/70 transition-colors ${
                  link.enabled ? 'bg-card/80' : 'bg-muted/20 opacity-80'
                }`}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate font-semibold">{link.name}</h3>
                        {link.enabled && link.lastInStock && (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                          >
                            有货
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {link.listUrlHint || '列表地址未配置'}
                      </p>
                    </div>
                    <Badge variant="outline">{KSK_HUNTER_CHANNEL_LABEL[link.channel]}</Badge>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border/60 bg-muted/15 p-2.5 text-xs">
                    <div>
                      <p className="text-muted-foreground">处置方式</p>
                      <p className="mt-0.5 font-medium">
                        {link.mode === KSK_HUNTER_MODE.AUTO_ORDER ? '自动下单' : '仅提醒'}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">区域限制</p>
                      <p className="mt-0.5 truncate font-mono font-medium">
                        {link.regions.length > 0 ? link.regions.join(', ') : '不限'}
                      </p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-muted-foreground">最近查询</p>
                      <p className="mt-0.5 font-medium">{formatTime(link.lastCheckedAt)}</p>
                    </div>
                  </div>

                  {link.lastError && (
                    <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                      {link.lastError}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2 border-t border-border/60 pt-3">
                    <Button
                      size="sm"
                      variant={link.enabled ? 'outline' : 'default'}
                      onClick={() =>
                        runAction(
                          { id: link.id, action: 'toggle' },
                          () => window.api.kskHunterSetLinkEnabled(link.id, !link.enabled),
                          link.enabled ? `已暂停“${link.name}”。` : `已启用“${link.name}”。`
                        )
                      }
                      disabled={busy !== null}
                    >
                      {isBusy(link.id, 'toggle') ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : link.enabled ? (
                        <CirclePause className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <CirclePlay className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {link.enabled ? '暂停' : '启用'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingLink(link)
                        setEditorOpen(true)
                      }}
                      disabled={busy !== null}
                    >
                      <Edit3 className="mr-1.5 h-3.5 w-3.5" />
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto text-red-500 hover:bg-red-500/10 hover:text-red-500"
                      onClick={() => handleDeleteLink(link)}
                      disabled={busy !== null}
                    >
                      {isBusy(link.id, 'delete') ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      删除
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* 抢到的号与推送状态 */}
        {deliveries.length > 0 && (
          <Card className="border-border/70 bg-card/70">
            <CardContent className="p-5">
              <div className="mb-3 flex items-center gap-2">
                <Send className="h-4 w-4 text-sky-500" />
                <h3 className="text-sm font-semibold">已抢到的 KSK</h3>
                <Badge variant="outline" className="ml-auto">
                  {deliveries.length} 条
                </Badge>
              </div>
              <div className="space-y-2">
                {deliveries.map((delivery) => {
                  const label = DELIVERY_LABEL[delivery.state]
                  const retriable = delivery.state !== KSK_HUNTER_DELIVERY_STATE.DELIVERED
                  return (
                    <div
                      key={delivery.id}
                      className="rounded-xl border border-border/60 bg-muted/15 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{delivery.maskedKey}</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {delivery.region}
                        </span>
                        <Badge variant="outline" className={label.tone}>
                          {label.text}
                        </Badge>
                        {delivery.costCny !== undefined && (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            ¥{delivery.costCny}
                            {delivery.unitLabel &&
                              delivery.unitLabel !== 'CNY' &&
                              delivery.costUnit !== undefined &&
                              `（${delivery.costUnit} ${delivery.unitLabel}）`}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {delivery.linkName} · {formatTime(delivery.createdAt)}
                          {delivery.attempts > 0 ? ` · 已试 ${delivery.attempts} 次` : ''}
                        </span>
                        <div className="ml-auto flex gap-1.5">
                          {retriable && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                runAction(
                                  { id: delivery.id, action: 'delivery' },
                                  () => window.api.kskHunterRetryDelivery(delivery.id),
                                  '已重新排入推送队列。'
                                )
                              }
                              disabled={busy !== null}
                            >
                              {isBusy(delivery.id, 'delivery') ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-500 hover:bg-red-500/10 hover:text-red-500"
                            onClick={() => handleDeleteDelivery(delivery)}
                            disabled={busy !== null}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      {delivery.lastError && (
                        <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
                          {delivery.lastError}
                        </p>
                      )}
                      {delivery.state === KSK_HUNTER_DELIVERY_STATE.PENDING &&
                        delivery.nextAttemptAt && (
                          <p className="mt-1.5 text-xs text-muted-foreground">
                            下次重试 {formatTime(delivery.nextAttemptAt)}
                          </p>
                        )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <HunterLinkEditorDialog
        isOpen={editorOpen}
        link={editingLink}
        onClose={() => {
          setEditorOpen(false)
          setEditingLink(undefined)
        }}
        onSave={handleSaveLink}
      />
    </div>
  )
}
