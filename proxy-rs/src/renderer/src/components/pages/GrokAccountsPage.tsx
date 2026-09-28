import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bot,
  CheckCircle2,
  Loader2,
  LogIn,
  Play,
  RefreshCw,
  Search,
  Signal,
  SignalLow,
  Timer,
  Trash2,
  Waypoints,
  Wrench
} from 'lucide-react'
import {
  classifyRelayStatus,
  isRelayRouteMissing,
  type GrokAccountCursorInfo,
  type GrokAccountView,
  type GrokRelayStatus
} from '../../../../shared/grokAccounts'
import { Button, Card, CardContent, Input, PageHeader, askConfirm } from '../ui'
import { cn } from '@/lib/utils'
import { useGrokRelayInstallStore } from '../../store/grokRelayInstall'
import {
  PLAN_BADGE_CLASS,
  daysUntil,
  errorText,
  formatCompactDateTime,
  percentText,
  usageBarClass,
  usageTextClass
} from '../cursor/_helpers'

function displayName(account: GrokAccountView): string {
  return account.email || account.name || `${account.scope.slice(0, 12)}…`
}

/** 套餐徽标，与 Cursor 账号卡片同一套实底配色；订阅状态与用量刷新时间放 tooltip。 */
function PlanBadge({ info }: { info: GrokAccountCursorInfo }): React.ReactNode {
  const title = [
    `订阅状态 ${info.subscriptionStatus ?? '未知'}`,
    info.usageUpdatedAt != null ? `用量更新于 ${formatCompactDateTime(info.usageUpdatedAt)}` : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span
      className={cn(
        'shrink-0 rounded-md px-2 py-0.5 text-2xs font-bold uppercase tracking-wide',
        PLAN_BADGE_CLASS[info.planTone]
      )}
      title={title}
    >
      {info.planName}
    </span>
  )
}

/** Bot 周额度：有额度画进度条；账号库没拉过或套餐不含 Bot 时给一行说明，位置不留空。 */
function BotQuota({ info }: { info: GrokAccountCursorInfo }): React.ReactNode {
  const usage = info.botUsage
  if (!usage) {
    return (
      <p
        className="text-2xs text-muted-foreground"
        title="账号库还没拉到这个号的 Bot 用量，去「Cursor 账号」页刷新一次即可"
      >
        Bot 额度未同步
      </p>
    )
  }
  if (!usage.hasLimit) {
    return (
      <p className="text-2xs text-muted-foreground" title={usage.planLabel ?? undefined}>
        套餐不含 Bot 额度
      </p>
    )
  }
  const percent = usage.usedPercent
  const title = [
    usage.planLabel,
    `已用 ${percentText(percent)}`,
    usage.nextResetAt != null ? `重置时间 ${formatCompactDateTime(usage.nextResetAt)}` : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 text-2xs" title={title}>
      <span className="flex items-center gap-1 whitespace-nowrap text-muted-foreground">
        Bot 额度（周）
        {usage.nextResetAt != null && (
          <span className="inline-flex items-center gap-0.5 text-3xs text-muted-foreground/70">
            <Timer className="h-2.5 w-2.5" />
            {daysUntil(usage.nextResetAt)} 天
          </span>
        )}
      </span>
      <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out',
            usageBarClass(percent ?? 0)
          )}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
      <span
        className={cn(
          'min-w-[2.5rem] text-right font-semibold tabular-nums',
          usageTextClass(percent)
        )}
      >
        {percentText(percent)}
      </span>
    </div>
  )
}

interface RelayView {
  label: string
  tone: string
  icon: typeof Signal
  /** 悬停说明：这个状态是什么意思、该做什么。 */
  title: string
}

const RELAY_OK_TONE = 'text-emerald-500'
const RELAY_WARN_TONE = 'text-amber-500'

/** 探针的分级结果 → 文案。探针只能可靠判断「路由在不在」，端到端是否可用以 Cursor 实际使用为准。 */
function relayText(status: GrokRelayStatus | null): RelayView {
  if (!status) {
    return { label: '未知', tone: 'text-muted-foreground', icon: SignalLow, title: '还没探测过' }
  }
  const code = status.lastStatus != null ? `HTTP ${status.lastStatus}` : (status.error ?? '')
  switch (classifyRelayStatus(status)) {
    case 'unconfigured':
      return {
        label: 'relay 未配置',
        tone: RELAY_WARN_TONE,
        icon: SignalLow,
        title: '本机没有 relay 配置，点某张卡的「同步 relay」或「切换」生成'
      }
    case 'ready':
      return {
        label: 'relay 已就绪',
        tone: RELAY_OK_TONE,
        icon: Signal,
        title: '探针拿到了完整的 Connect 流，路由在且端到端通'
      }
    case 'installedUnverified':
      return {
        label: 'relay 路由已装',
        tone: RELAY_OK_TONE,
        icon: Signal,
        title: `路由在，但这个 Box 的实现拒绝了探针的空请求（${code}）。Cursor 发的是真请求不受影响，以实际使用为准`
      }
    case 'missing':
      return {
        label: 'relay 路由未装',
        tone: RELAY_WARN_TONE,
        icon: SignalLow,
        title: `Box 网关通了但没有这条路由（${code}），点扳手让它的 Bot 安装`
      }
    case 'unauthorized':
      return {
        label: 'relay token 失效',
        tone: RELAY_WARN_TONE,
        icon: SignalLow,
        title: `Box 拒绝了本机保存的连接 token（${code}），去 Grok Bot 里重新打开这个号的 Bot 刷新连接，再点「同步 relay」`
      }
    case 'serverError':
      return {
        label: 'relay 异常',
        tone: RELAY_WARN_TONE,
        icon: SignalLow,
        title: `Box 网关返回 ${code}，Box 可能在重启或出错，稍后再探`
      }
    case 'unreachable':
      return {
        label: 'relay 连不上',
        tone: RELAY_WARN_TONE,
        icon: SignalLow,
        title: `连不上 Box 网关：${status.error ?? '未知错误'}`
      }
  }
}

/** 顶部「在用」区的一个角色：Grok 客户端登着谁 / 本机 relay 指向谁。 */
interface RoleLabel {
  icon: typeof Signal
  label: string
  /** 图标颜色类：登录号用主色，relay 跟探针状态。 */
  tone: string
}

/**
 * 顶部「在用」区的一格。一格对应一个号，标签说明它顶着哪个角色；登录号和 relay 号是同一个时合成一格、
 * 两个标签并排，免得同一张卡出现两次。account 为空表示这个角色目前没有对应的号，用 fallback 说明。
 */
interface FeaturedSlot {
  key: string
  roles: RoleLabel[]
  account: GrokAccountView | undefined
  fallback: string
}

const ROLE_LOGIN: RoleLabel = { icon: LogIn, label: 'Grok 当前登录号', tone: 'text-primary' }

export function GrokAccountsPage(): React.ReactNode {
  const [accounts, setAccounts] = useState<GrokAccountView[]>([])
  const [currentScope, setCurrentScope] = useState<string | null>(null)
  const [relay, setRelay] = useState<GrokRelayStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')
  const [switchingScope, setSwitchingScope] = useState<string | null>(null)
  const [syncingScope, setSyncingScope] = useState<string | null>(null)
  const [removingScope, setRemovingScope] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  // 装 relay 路由要跑几分钟，状态放在跨页面的 store 里，切走再切回还能看到进度
  const {
    installingScope,
    progress: installProgress,
    outcome: installOutcome,
    run: runRelayInstall,
    consumeOutcome: consumeInstallOutcome
  } = useGrokRelayInstallStore()

  const load = useCallback(async (): Promise<void> => {
    setError('')
    try {
      const [listResult, currentResult] = await Promise.all([
        window.api.grokAccountsList(),
        window.api.grokAccountsCurrentScope()
      ])
      if (!listResult.success) throw new Error(listResult.error)
      setAccounts(listResult.data)
      setCurrentScope(currentResult.success ? currentResult.data : null)
    } catch (loadError) {
      setError(errorText(loadError, '读取 Grok 账号失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  /** 探一次 relay 并写进状态；把结果也返回给调用方，切号后要据此决定是否自动装路由。 */
  const probe = useCallback(async (): Promise<GrokRelayStatus | null> => {
    setProbing(true)
    try {
      const result = await window.api.grokAccountsRelayStatus()
      if (!result.success) return null
      setRelay(result.data)
      return result.data
    } finally {
      setProbing(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void probe()
    const offGrok = window.api.onGrokAccountsChanged(() => {
      void load()
      void probe()
    })
    // 订阅与 Bot 额度来自 Cursor 账号库，那边刷新过用量后这里也要重拉
    const offCursor = window.api.onCursorAccountsChanged(() => {
      void load()
    })
    return () => {
      offGrok()
      offCursor()
    }
  }, [load, probe])

  // 安装结束（不论页面当时在不在）都从 store 拿结果展示一次，然后重新探一次 relay
  useEffect(() => {
    if (!installOutcome) return
    if (installOutcome.error) {
      setError(installOutcome.error)
    } else if (installOutcome.notice) {
      setError('')
      setNotice(installOutcome.notice)
    }
    consumeInstallOutcome()
    void probe()
  }, [installOutcome, consumeInstallOutcome, probe])

  // relay 指向的号和 Grok 登录的号是两回事：前者决定本机流量走谁的 Bot，后者只是客户端里登着谁
  const relayScope = relay?.configured && relay.scope ? relay.scope : undefined

  // 号池：在用的两个号（登录号、relay 号）挪到上面单独放，这里只剩其余的号
  const pool = useMemo(() => {
    const query = search.trim().toLowerCase()
    const list = accounts.filter(
      (account) =>
        account.scope !== currentScope &&
        account.scope !== relayScope &&
        (!query ||
          [account.email, account.name, account.scope]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(query))
    )
    // 已在 Grok 里的号在前（切起来不用写盘）；同组内按 Bot 最近活跃排
    return list.sort((a, b) => {
      if (a.inGrok !== b.inGrok) return a.inGrok ? -1 : 1
      return (b.boxSavedAt ?? 0) - (a.boxSavedAt ?? 0)
    })
  }, [accounts, currentScope, relayScope, search])

  /**
   * 让这个号的 Bot 给自己的 Box 装 relay 路由，并等到探针通过。auto=true 是切号后自动触发，
   * 提示语接在切号结果后面；手动点按钮时单独提示。
   */
  const handleEnsureRelayRoute = async (
    account: GrokAccountView,
    options: { auto?: boolean; prefix?: string } = {}
  ): Promise<void> => {
    setError('')
    if (!options.auto) setNotice('')
    // 结果由上面的 effect 从 store 里取出来展示，这里只需等它跑完
    await runRelayInstall({
      scope: account.scope,
      name: displayName(account),
      prefix: options.prefix
    })
  }

  const handleSwitch = async (account: GrokAccountView): Promise<void> => {
    const name = displayName(account)
    setSwitchingScope(account.scope)
    setError('')
    setNotice('')
    try {
      let result = await window.api.grokAccountsSwitch(account.scope)
      if (!result.success) throw new Error(result.error)
      if (result.data.status === 'needsClose') {
        const confirmed = await askConfirm({
          title: account.inGrok ? `切换到 ${name}` : `导入并切换到 ${name}`,
          description: account.inGrok
            ? 'Grok Bot 正在运行。切号要先退出它（会请它正常退出），改写当前登录的号后再自动重开，并把本机反代的 relay 指向这个号的 Bot。Grok Bot 里未完成的对话请先处理。'
            : '这个号还不在 Grok 客户端里。Grok Bot 正在运行，要先退出它（会请它正常退出），把这个号从 Cursor 账号库写进 Grok 并设为当前号，再自动重开。Grok Bot 里未完成的对话请先处理。',
          confirmText: '退出 Grok 并切换',
          tone: 'warning'
        })
        if (!confirmed) return
        result = await window.api.grokAccountsSwitch(account.scope, { closeGrok: true })
        if (!result.success) throw new Error(result.error)
      }
      if (result.data.status === 'done') {
        const parts: string[] = [
          result.data.imported ? `已把 ${name} 写进 Grok 并切换过去` : `已切换到 ${name}`
        ]
        parts.push(result.data.relaunched ? 'Grok 已重启' : '下次打开 Grok 生效')
        if (result.data.relaySynced) parts.push('relay 已指向该号')
        else if (!result.data.hasBox) parts.push('该号还没建 Bot，去 Grok 里新建后再同步 relay')
        else parts.push('relay 同步失败，可手动重试')
        setNotice(parts.join('，'))
        const status = await probe()
        // relay 已指向新号但它的 Box 上还没有 relay 路由：新号（或 Box 被重建过）都会这样，直接让它的 Bot 去装
        if (result.data.relaySynced && status && isRelayRouteMissing(status)) {
          parts.push('Box 上还没装 relay 路由，正在让它的 Bot 安装')
          setNotice(parts.join('，'))
          setSwitchingScope(null)
          await handleEnsureRelayRoute(account, { auto: true, prefix: `已切换到 ${name}` })
        }
      }
    } catch (switchError) {
      setError(errorText(switchError, '切换失败'))
    } finally {
      setSwitchingScope(null)
    }
  }

  const handleSyncRelay = async (account: GrokAccountView): Promise<void> => {
    const name = displayName(account)
    setSyncingScope(account.scope)
    setError('')
    setNotice('')
    try {
      const result = await window.api.grokAccountsSyncRelay(account.scope)
      if (!result.success) throw new Error(result.error)
      setRelay(result.data)
      const state = classifyRelayStatus(result.data)
      const parts = [
        state === 'ready'
          ? `已把 relay 指向 ${name}，探活通过，本机流量现在走它的 Bot`
          : state === 'installedUnverified'
            ? `已把 relay 指向 ${name}，路由在（这个 Box 的实现拒绝了探针的空请求，以 Cursor 实际使用为准），本机流量现在走它的 Bot`
            : state === 'missing'
              ? `已把 relay 指向 ${name}，但它的 Box 上还没装 relay 路由，点扳手让它的 Bot 安装`
              : `已把 relay 指向 ${name}，但探活未通过（${relayText(result.data).label}）`
      ]
      // 同步 relay 不动 Grok 客户端的登录号，说清楚，免得以为切号没生效
      if (currentScope && currentScope !== account.scope) {
        const currentName = accounts.find((item) => item.scope === currentScope)
        parts.push(
          `Grok 客户端登录的仍是${currentName ? ` ${displayName(currentName)}` : '原来的号'}，要连客户端一起切请点「切换」`
        )
      }
      setNotice(parts.join('；'))
    } catch (syncError) {
      setError(errorText(syncError, '同步 relay 失败'))
    } finally {
      setSyncingScope(null)
    }
  }

  const handleRemove = async (account: GrokAccountView): Promise<void> => {
    const name = displayName(account)
    // 删除本身就要确认，把「可能要退出 Grok」一并说清，免得连弹两次
    const confirmed = await askConfirm({
      title: `从 Grok 客户端移除 ${name}`,
      description:
        '只删掉 Grok 客户端里这个号的登录态，Cursor 账号库不受影响，之后仍可从卡片重新导入。若 Grok Bot 正在运行，会先请它退出、删完再自动重开。',
      confirmText: '移除',
      tone: 'danger'
    })
    if (!confirmed) return
    setRemovingScope(account.scope)
    setError('')
    setNotice('')
    try {
      const result = await window.api.grokAccountsRemove(account.scope, { closeGrok: true })
      if (!result.success) throw new Error(result.error)
      if (result.data.status === 'done') {
        setNotice(
          result.data.relaunched
            ? `已从 Grok 客户端移除 ${name}，Grok 已重启`
            : `已从 Grok 客户端移除 ${name}`
        )
      }
    } catch (removeError) {
      setError(errorText(removeError, '移除失败'))
    } finally {
      setRemovingScope(null)
    }
  }

  const currentAccount = currentScope
    ? accounts.find((account) => account.scope === currentScope)
    : undefined
  const inGrokCount = accounts.filter((account) => account.inGrok).length
  const relayView = relayText(relay)
  const relayTarget = relayScope
    ? accounts.find((account) => account.scope === relayScope)
    : undefined
  // relay 指向的卡片呼吸灯配色：路由在（能用）绿色，其余状态琥珀色提醒
  const relayState = relay ? classifyRelayStatus(relay) : undefined
  const relayHealthy = relayState === 'ready' || relayState === 'installedUnverified'

  // 顶部「在用」区：两个角色各一格；同一个号同时顶着两个角色时合成一格
  const roleRelay: RoleLabel = { icon: Waypoints, label: 'relay 当前指向', tone: relayView.tone }
  const loginFallback = currentScope
    ? `Grok 当前登录的号不在列表里（${currentScope.slice(0, 12)}…），刷新一次或重新打开 Grok`
    : '未识别当前号：Grok 客户端里没有已登录的号，点下方某张卡的「切换」即可登录'
  const relayFallback = relayScope
    ? `${relayView.label}：指向的号不在列表里（${relayScope}），点某张卡的「同步 relay」重新指向`
    : `${relayView.label}：${relayView.title}`
  const featured: FeaturedSlot[] =
    currentAccount && relayTarget && currentAccount.scope === relayTarget.scope
      ? [{ key: 'both', roles: [ROLE_LOGIN, roleRelay], account: currentAccount, fallback: '' }]
      : [
          { key: 'login', roles: [ROLE_LOGIN], account: currentAccount, fallback: loginFallback },
          { key: 'relay', roles: [roleRelay], account: relayTarget, fallback: relayFallback }
        ]

  /** 一张账号卡。顶部在用区和下方号池用的是同一张，样式不区分，只是位置不同。 */
  const renderAccountCard = (account: GrokAccountView): React.ReactNode => {
    const isCurrent = account.scope === currentScope
    const isRelayTarget = relayTarget?.scope === account.scope
    return (
      <Card
        key={account.scope}
        className={cn(
          'relative flex h-full flex-col overflow-hidden bg-solid-card',
          isCurrent && 'border-transparent active-glow-border',
          // 不是当前号时用边框色先把 relay 指向的卡从一排里挑出来，呼吸灯再叠在上面
          isRelayTarget &&
            !isCurrent &&
            (relayHealthy ? 'border-emerald-500/50' : 'border-amber-500/50')
        )}
      >
        {isRelayTarget && (
          <span
            aria-hidden
            className={cn('relay-breathing', !relayHealthy && 'relay-breathing-warn')}
          />
        )}
        <CardContent className="flex flex-1 flex-col gap-3 p-4">
          <div className="flex items-center gap-2">
            <span className="type-title min-w-0 flex-1 truncate text-sm" title={account.scope}>
              {displayName(account)}
            </span>
            {account.cursor && <PlanBadge info={account.cursor} />}
            {isCurrent && (
              <span className="shrink-0 rounded-full bg-primary/15 px-2 py-px text-2xs font-medium text-primary">
                当前
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-2xs">
            {!account.inGrok && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-sky-500/12 px-2 py-px font-medium text-sky-600 dark:text-sky-400"
                title="只在 Cursor 账号库里，还没写进 Grok 客户端；点「导入并切换」会顺手写入"
              >
                未导入 Grok
              </span>
            )}
            {account.hasBox ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-px font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                已建 Bot
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/12 px-2 py-px font-medium text-amber-600 dark:text-amber-400">
                未建 Bot
              </span>
            )}
            {isRelayTarget && (
              <span
                className={cn('inline-flex items-center gap-1', relayView.tone)}
                title={`本机反代当前把流量转到这个号的 Bot。${relayView.title}`}
              >
                <relayView.icon className="h-3 w-3" />
                relay 指向此号 · {relayView.label}
              </span>
            )}
            {isCurrent && relayTarget && !isRelayTarget && (
              <span
                className="inline-flex items-center gap-1 text-amber-500"
                title={`Grok 客户端登录的是这个号，但本机流量走的是 ${displayName(relayTarget)} 的 Bot；点这张卡的「重新切换」可把 relay 拉回来`}
              >
                <SignalLow className="h-3 w-3" />
                relay 在别的号上
              </span>
            )}
          </div>

          {account.cursor ? (
            <BotQuota info={account.cursor} />
          ) : (
            <p
              className="text-2xs text-muted-foreground"
              title="这个号是直接在 Grok 里登录的，Cursor 账号库里没有它；到「Cursor 账号」页添加同一个号后就能看到订阅与 Bot 额度"
            >
              未关联 Cursor 账号库
            </p>
          )}

          {account.boxSavedAt != null && (
            <p
              className="font-mono text-2xs text-muted-foreground tabular-nums"
              title={`Bot 连接最近更新 ${formatCompactDateTime(account.boxSavedAt)}`}
            >
              Bot 更新于 {formatCompactDateTime(account.boxSavedAt)}
            </p>
          )}

          {installingScope === account.scope && (
            <p className="flex items-center gap-1.5 text-2xs text-sky-600 dark:text-sky-400">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              {installProgress?.scope === account.scope
                ? installProgress.message
                : '正在装 relay 路由…'}
            </p>
          )}

          <div className="mt-auto flex items-center gap-2 border-t border-border/50 pt-2.5">
            <Button
              size="sm"
              className="flex-1"
              variant={isCurrent ? 'outline' : 'default'}
              onClick={() => void handleSwitch(account)}
              disabled={switchingScope === account.scope}
              title={
                isCurrent
                  ? '已是当前号，可重切一次以刷新 relay'
                  : account.inGrok
                    ? '切换：把这个号设为 Grok 当前登录号并同步 relay'
                    : '导入并切换：把这个号从 Cursor 账号库写进 Grok、设为当前登录号并同步 relay'
              }
            >
              {switchingScope === account.scope ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {isCurrent ? '重新切换' : account.inGrok ? '切换' : '导入并切换'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleSyncRelay(account)}
              disabled={syncingScope === account.scope || !account.hasBox}
              title={
                account.hasBox
                  ? '只把反代 relay 指向这个号的 Bot 并探活：本机流量随即走它的 Bot，但不重启客户端、不改 Grok 当前登录的号（那个要点「切换」）'
                  : '该号还没建 Bot，先在 Grok 里建好'
              }
            >
              {syncingScope === account.scope ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Signal className="h-4 w-4" />
              )}
              同步 relay
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 px-2 text-muted-foreground hover:text-foreground"
              onClick={() => void handleEnsureRelayRoute(account)}
              disabled={installingScope !== null || !account.hasBox}
              title={
                account.hasBox
                  ? '装 relay 路由：让这个号的 Bot 给自己的 Box 打补丁，开出反代要走的 relay 路由（新号或 Box 被重建后需要）'
                  : '该号还没建 Bot，没有 Box 可装'
              }
              aria-label="装 relay 路由"
            >
              {installingScope === account.scope ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wrench className="h-4 w-4" />
              )}
            </Button>
            {account.inGrok && (
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 px-2 text-muted-foreground hover:text-red-500"
                onClick={() => void handleRemove(account)}
                disabled={isCurrent || removingScope === account.scope}
                title={
                  isCurrent
                    ? '当前正在用的号不能删，先切到别的号'
                    : '从 Grok 客户端移除这个号（Cursor 账号库不动）'
                }
                aria-label="从 Grok 客户端移除"
              >
                {removingScope === account.scope ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      <PageHeader
        title="Grok 账号"
        eyebrow="Grok Bot Accounts"
        icon={Bot}
        accent="violet"
        description="本机流量都走 Grok 代理，所以只切 Grok 就够了：「切换」把某个号设为 Grok 当前登录号并重启客户端，同时把反代用的 relay 指到这个号的 Bot；「同步 relay」只改流量走向、不动客户端登录的号。卡片同时列出 Cursor 账号库里的号，还没进 Grok 的号点切换时会顺手写进去；切过去后若它的 Box 上还没有 relay 路由，会自动让它的 Bot 安装。新号首次要先在 Grok Bot 里建好 Bot。"
        badges={
          accounts.length > 0 && (
            <span className="text-xs text-muted-foreground">
              共 {accounts.length} 个 · Grok 里 {inGrokCount} 个
            </span>
          )
        }
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void probe()}
            disabled={probing}
            title="重新探测本机反代能否通过 relay 打到 Bot"
          >
            {probing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            探测 relay
          </Button>
        }
      />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {error && (
          <div className="whitespace-pre-wrap break-all rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        )}
        {notice && (
          <p className="break-all rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-600 dark:text-sky-300">
            {notice}
          </p>
        )}

        {loading ? (
          <div className="grid h-32 place-items-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <>
            {/* 顶部：在用的号。登录号、relay 号各一格，卡片与号池里的是同一张，只是挪了位置 */}
            <div className="stagger-children grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
              {featured.map((slot) => (
                <div key={slot.key} className="flex flex-col gap-1.5">
                  <p className="type-eyebrow flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1">
                    {slot.roles.map((role, index) => (
                      <span key={role.label} className="inline-flex items-center gap-1.5">
                        {index > 0 && <span aria-hidden>·</span>}
                        <role.icon className={cn('h-3.5 w-3.5', role.tone)} />
                        {role.label}
                      </span>
                    ))}
                  </p>
                  {slot.account ? (
                    renderAccountCard(slot.account)
                  ) : (
                    <div className="grid h-full min-h-32 place-items-center rounded-2xl border border-dashed border-border/60 p-4 text-center text-sm text-muted-foreground">
                      {slot.fallback}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* 下方：号池，只放没在用的号 */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="type-eyebrow px-1">
                号池
                {search.trim() ? ` · 匹配 ${pool.length} 个` : ''}
              </p>
              <div className="relative w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索邮箱、名称…"
                  className="pl-8"
                />
              </div>
            </div>

            {pool.length === 0 ? (
              <div className="grid h-32 place-items-center rounded-xl border border-dashed border-border/60 px-4 text-center text-sm text-muted-foreground">
                {accounts.length === 0
                  ? 'Grok Bot 里没有已登录的账号，Cursor 账号库里也没有可用的号。先到「Cursor 账号」页添加账号，或直接在 Grok Bot 里登录。'
                  : search.trim()
                    ? '没有符合搜索条件的账号'
                    : '没有别的号了，所有账号都在上面用着'}
              </div>
            ) : (
              <div className="stagger-children grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
                {pool.map((account) => renderAccountCard(account))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
