import { useCallback, useEffect, useState } from 'react'
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
  Settings2,
  Trash2,
  TriangleAlert,
  Wallet
} from 'lucide-react'
import {
  KSK_HUNTER_BUDGET_BLOCK,
  KSK_HUNTER_CHANNEL_LABEL,
  KSK_HUNTER_DELIVERY_STATE,
  KSK_HUNTER_MODE,
  KSK_HUNTER_POLL_INTERVAL_SECONDS,
  KSK_HUNTER_STATE,
  type KskHunterConfig,
  type KskHunterDeliveryState,
  type KskHunterDeliveryView,
  type KskHunterLinkInput,
  type KskHunterLinkView,
  type KskHunterSecretInput,
  type KskHunterSnapshot
} from '../../../../shared/kskHunter'
import type { IdcIpcResult } from '../../../../shared/idcSeats'
import { HunterConfigDialog } from '../automation/HunterConfigDialog'
import { HunterLinkEditorDialog } from '../automation/HunterLinkEditorDialog'
import { HunterReportCard } from '../automation/HunterReportCard'
import { Badge, Button, Card, CardContent, PageHeader, askConfirm } from '../ui'

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

const DELIVERY_LABEL: Record<KskHunterDeliveryState, { text: string; tone: string }> = {
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
  const [snapshot, setSnapshot] = useState<KskHunterSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<BusyKey>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [editingLink, setEditingLink] = useState<KskHunterLinkView | undefined>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const applySnapshot = useCallback((next: KskHunterSnapshot): void => {
    setSnapshot(next)
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
              spend: event.spend,
              balances: event.balances
            }
          : current
      )
    })
  }, [load])

  const links = snapshot?.links ?? []
  const deliveries = snapshot?.deliveries ?? []
  const enabledCount = links.filter((link) => link.enabled).length
  const inStockCount = links.filter((link) => link.enabled && link.lastInStock).length
  const pendingCount = deliveries.filter(
    (delivery) => delivery.state === KSK_HUNTER_DELIVERY_STATE.PENDING
  ).length
  const failedCount = deliveries.filter(
    (delivery) =>
      delivery.state === KSK_HUNTER_DELIVERY_STATE.FAILED ||
      delivery.state === KSK_HUNTER_DELIVERY_STATE.DEAD_KEY
  ).length
  const budgetBlocked =
    snapshot !== null &&
    (snapshot.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.GLOBAL ||
      snapshot.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.CHANNEL)
  const balanceBlocked = snapshot?.status.budgetBlock === KSK_HUNTER_BUDGET_BLOCK.BALANCE
  const lowBalanceChannels = (snapshot?.balances ?? []).filter((item) => item.isLow)
  const blockedChannelNames = (snapshot?.status.budgetBlockedChannels ?? [])
    .map((channel) => KSK_HUNTER_CHANNEL_LABEL[channel])
    .join('、')
  const spendHint = snapshot
    ? `${snapshot.spend.orderCount} 单 · ${
        snapshot.spend.dailyLimitCny > 0
          ? `上限 ¥${snapshot.spend.dailyLimitCny} · 剩余 ¥${snapshot.spend.remainingCny ?? 0}`
          : '不限额'
      }`
    : '0 单 · 等待快照'

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

  const handleSaveConfig = async (
    config: Partial<KskHunterConfig>,
    secrets?: KskHunterSecretInput
  ): Promise<void> => {
    setError('')
    setNotice('')
    const result = await window.api.kskHunterUpdateConfig(config, secrets)
    if (!result.success) throw new Error(result.error || '保存配置失败')
    applySnapshot(result.data)
    setNotice('全局配置已保存。')
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
        description={`每 ${KSK_HUNTER_POLL_INTERVAL_SECONDS} 秒并行查一遍商品聚合站点（部分渠道按站点要求放慢），开货即提醒或自动下单推送下游。`}
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
          <div className="flex flex-wrap justify-end gap-2">
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
            <Button variant="outline" onClick={() => setConfigOpen(true)} disabled={!snapshot}>
              <Settings2 className="mr-1.5 h-4 w-4" />
              全局配置
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
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-wide">全部 Job</h2>
          <span className="text-xs text-muted-foreground">汇总当前所有配置链接</span>
        </div>
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          {[
            {
              label: '全部 Job · 启用 / 总数',
              value: `${enabledCount} / ${links.length}`,
              icon: Link2,
              tone: 'text-violet-500',
              hint: undefined
            },
            {
              label: '当前有货',
              value: inStockCount,
              icon: PackageCheck,
              tone: 'text-emerald-500',
              hint: undefined
            },
            {
              label: '今日花费',
              value: `¥${snapshot?.spend.totalCny ?? 0}`,
              icon: Wallet,
              tone: budgetBlocked ? 'text-red-500' : 'text-sky-500',
              hint: spendHint
            },
            {
              label: '待推送 / 待处理',
              value: `${pendingCount} / ${failedCount}`,
              icon: TriangleAlert,
              tone: 'text-amber-500',
              hint: undefined
            }
          ].map((metric) => (
            <Card key={metric.label} className="border-border/70 bg-card/70">
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    {metric.label}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{metric.value}</p>
                  {metric.hint && (
                    <p className="mt-0.5 text-2xs tabular-nums text-muted-foreground">
                      {metric.hint}
                    </p>
                  )}
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

        {/* 历史报表：数据来自独立的事件流文件，按需拉取而非跟着状态事件刷 */}
        <HunterReportCard />

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
          <div className="mb-5 overflow-hidden rounded-xl border border-border/70 bg-card/70">
            <div className="hidden border-b border-border/60 bg-muted/20 px-4 py-2 text-2xs uppercase tracking-[0.16em] text-muted-foreground lg:grid lg:grid-cols-[minmax(220px,1.4fr)_minmax(150px,1fr)_minmax(120px,0.7fr)_minmax(150px,1fr)_auto] lg:items-center lg:gap-4">
              <span>Job / 渠道</span>
              <span>模式 / 区域</span>
              <span>库存 / 状态</span>
              <span>花费 / 队列 / 最近检查</span>
              <span>操作</span>
            </div>
            {links.map((link) => {
              const linkSpend = snapshot?.spend.byLink.find((item) => item.linkId === link.id)
              const linkDeliveries = deliveries.filter((delivery) => delivery.linkId === link.id)
              const linkPending = linkDeliveries.filter(
                (delivery) => delivery.state === KSK_HUNTER_DELIVERY_STATE.PENDING
              ).length
              const linkFailed = linkDeliveries.filter(
                (delivery) =>
                  delivery.state === KSK_HUNTER_DELIVERY_STATE.FAILED ||
                  delivery.state === KSK_HUNTER_DELIVERY_STATE.DEAD_KEY
              ).length
              const statusLabel = !link.enabled
                ? '已暂停'
                : link.lastError
                  ? '异常'
                  : link.running
                    ? '运行中'
                    : '等待轮询'
              const statusTone = !link.enabled
                ? 'border-border bg-muted/50 text-muted-foreground'
                : link.lastError
                  ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300'
                  : link.running
                    ? 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300'
                    : 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300'
              const stockLabel = !link.enabled
                ? link.lastInStock
                  ? '上次有货'
                  : '已暂停'
                : link.lastInStock
                  ? '有货'
                  : link.lastCheckedAt
                    ? '无货'
                    : '未检查'
              const stockTone = !link.enabled
                ? 'text-muted-foreground'
                : link.lastInStock
                  ? 'text-emerald-500'
                  : link.lastCheckedAt
                    ? 'text-muted-foreground'
                    : 'text-amber-500'
              return (
                <div
                  key={link.id}
                  className={`grid gap-3 border-b border-border/60 p-4 last:border-b-0 lg:grid-cols-[minmax(220px,1.4fr)_minmax(150px,1fr)_minmax(120px,0.7fr)_minmax(150px,1fr)_auto] lg:items-center lg:gap-4 ${link.enabled ? 'bg-card/60' : 'bg-muted/15'}`}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold">{link.name}</h3>
                      <Badge variant="outline" className={statusTone}>
                        {statusLabel}
                      </Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {KSK_HUNTER_CHANNEL_LABEL[link.channel]} ·{' '}
                      {link.listUrlHint || '列表地址未配置'}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-muted-foreground">模式</p>
                      <p className="mt-0.5 font-medium">
                        {link.mode === KSK_HUNTER_MODE.AUTO_ORDER ? '自动下单' : '仅提醒'}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-muted-foreground">区域</p>
                      <p className="mt-0.5 truncate font-mono font-medium">
                        {link.regions.length > 0 ? link.regions.join(', ') : '不限'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">库存</p>
                      <p className={`mt-0.5 font-semibold ${stockTone}`}>{stockLabel}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">队列</p>
                      <p className="mt-0.5 font-medium tabular-nums">{linkPending} 待推送</p>
                      <p className="font-medium tabular-nums">{linkFailed} 待处理</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                    <div>
                      <p className="text-muted-foreground">今日花费</p>
                      <p className="mt-0.5 font-semibold tabular-nums">
                        ¥{linkSpend?.amountCny ?? 0}
                      </p>
                      <p className="text-2xs tabular-nums text-muted-foreground">
                        {linkSpend?.orderCount ?? 0} 单
                      </p>
                      {linkSpend && linkSpend.unitLabel !== 'CNY' && (
                        <p className="text-2xs text-muted-foreground">
                          {linkSpend.amountUnit} {linkSpend.unitLabel}
                        </p>
                      )}
                    </div>
                    <div>
                      <p className="text-muted-foreground">最近检查</p>
                      <p className="mt-0.5 font-medium">{formatTime(link.lastCheckedAt)}</p>
                    </div>
                    <div className="col-span-2 sm:col-span-1">
                      <p className="text-muted-foreground">最近错误</p>
                      <p
                        className="mt-0.5 truncate font-medium text-amber-600 dark:text-amber-300"
                        title={link.lastError}
                      >
                        {link.lastError || '—'}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
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
                      配置
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-500 hover:bg-red-500/10 hover:text-red-500"
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
                </div>
              )
            })}
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

      <HunterConfigDialog
        isOpen={configOpen}
        snapshot={snapshot}
        onClose={() => setConfigOpen(false)}
        onSave={handleSaveConfig}
      />
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
