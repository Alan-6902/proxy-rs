import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Play,
  Square,
  RefreshCw,
  Copy,
  Check,
  Server,
  Activity,
  AlertCircle,
  Globe,
  Zap,
  Loader2,
  FileText,
  Eye,
  EyeOff,
  Dices,
  Cpu,
  UserCheck,
  RotateCcw,
  Users,
  Clock,
  Settings2
} from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Label,
  SegmentedTabs,
  Switch,
  SwitchTile,
  Badge,
  Select
} from '../ui'
import { ProxySecurityPanel } from './ProxySecurityPanel'
import { useAccountsStore } from '../../store/accounts'
import { useTranslation } from '../../hooks/useTranslation'
import { useEscapeClose } from '@/hooks/useEscapeClose'
import { ProxyLogsDialog } from './ProxyLogsDialog'
import { ProxyDetailedLogsDialog } from './ProxyDetailedLogsDialog'
import { ModelsDialog } from './ModelsDialog'
import { ModelMappingDialog } from './ModelMappingDialog'
import { AccountSelectDialog } from './AccountSelectDialog'
import { ApiKeyManager } from './ApiKeyManager'
import { ClientConfigDialog } from './ClientConfigDialog'
import { ProxyStatsGrid } from './ProxyStatsGrid'
import { ProxyAccountPoolCard } from './ProxyAccountPoolCard'
import type { ProxyPoolAccountSnapshot } from '../../../../shared/proxyAccountPoolSnapshot'
import { createPortal } from 'react-dom'

/** 反代配置默认值：原先散在各 onChange 与 value 兜底里的字面量，统一到这里。 */
const DEFAULT_PROXY_PORT = 5580
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_PAYLOAD_LIMIT_KB = 153600
const DEFAULT_TOKEN_BUFFER_RESERVE = 20000
const DEFAULT_SELECTION_STRATEGY = 'round-robin'
const DEFAULT_SELECTION_MODE = 'all'

/** 池状态回读间隔：冷却到期 / 配额重置不伴随请求，需要定时刷新才能反映到列表。 */
const POOL_REFRESH_INTERVAL_MS = 10_000

/** 监听地址：0.0.0.0 = 所有网卡（外网可达），127.0.0.1 = 仅本机。 */
const HOST_ANY = '0.0.0.0'
const HOST_LOOPBACK = '127.0.0.1'

/** 「未分组」在轮询范围里的伪分组 id，与 main/proxy 侧约定一致。 */
const UNGROUPED_GROUP_ID = '__ungrouped__'
/** 分组未设置颜色时的兜底色。 */
const GROUP_FALLBACK_COLOR = '#888'

type ApiKeyFormat = 'sk' | 'simple' | 'token'
const API_KEY_FORMAT_OPTIONS: Array<{ value: ApiKeyFormat; label: string }> = [
  { value: 'sk', label: 'sk-xxx' },
  { value: 'simple', label: 'PROXY_KEY' },
  { value: 'token', label: 'KEY:TOKEN' }
]

/** 配置分区：把 20+ 项按关注点切成三屏，首屏只留启动前必看的连接项。 */
type ConfigTab = 'connection' | 'rotation' | 'advanced'
const CONFIG_TABS: Array<{
  value: ConfigTab
  labelZh: string
  labelEn: string
  icon: React.ElementType
  hintZh: string
  hintEn: string
}> = [
  {
    value: 'connection',
    labelZh: '连接',
    labelEn: 'Connection',
    icon: Globe,
    hintZh: '监听端口、地址与访问鉴权',
    hintEn: 'Listen port, host and access auth'
  },
  {
    value: 'rotation',
    labelZh: '轮询',
    labelEn: 'Rotation',
    icon: Users,
    hintZh: '账号池的选号策略与范围',
    hintEn: 'How the account pool picks accounts'
  },
  {
    value: 'advanced',
    labelZh: '高级',
    labelEn: 'Advanced',
    icon: Settings2,
    hintZh: '上游端点、重试、载荷与工具行为',
    hintEn: 'Upstream endpoint, retries, payload and tools'
  }
]

interface ProxyStats {
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalTokens: number
  totalCredits: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  startTime: number
}

interface SessionStats {
  totalRequests: number
  successRequests: number
  failedRequests: number
  startTime: number
}

interface ModelMappingRule {
  id: string
  name: string
  enabled: boolean
  type: 'replace' | 'alias' | 'loadbalance'
  sourceModel: string
  targetModels: string[]
  weights?: number[]
  priority: number
  apiKeyIds?: string[]
}

interface ApiKeyInfo {
  id: string
  name: string
  key: string
  enabled: boolean
}

interface ProxyConfig {
  enabled: boolean
  port: number
  host: string
  apiKey?: string
  apiKeys?: ApiKeyInfo[]
  enableMultiAccount: boolean
  selectedAccountId?: string
  logRequests: boolean
  logStreamEvents?: boolean
  maxRetries?: number
  preferredEndpoint?: 'codewhisperer' | 'amazonq' | 'amazonq-cli'
  autoStart?: boolean
  clientDrivenToolExecution?: boolean
  disableTools?: boolean
  payloadSizeLimitKB?: number
  enableTokenBufferReserve?: boolean
  tokenBufferReserve?: number
  autoSwitchOnQuotaExhausted?: boolean
  accountSelectionStrategy?: 'round-robin' | 'sticky'
  // 多账号轮询范围（与 main/proxy/types.ts 保持一致）
  multiAccountSelectionMode?: 'all' | 'groups'
  multiAccountGroupIds?: string[]
  modelMappings?: ModelMappingRule[]
  // v1.8 安全 / 限流 / 可观测
  maxRequestBodyBytes?: number
  allowedIPs?: string[]
  deniedIPs?: string[]
  allowExternalWithoutApiKey?: boolean
  rateLimitPerKeyPerMinute?: number
  sessionAffinityEnabled?: boolean
  keepAliveTimeoutMs?: number
  headersTimeoutMs?: number
  recentRequestsLimit?: number
  enableMetrics?: boolean
  fallbackPort?: number
  enableAuditLog?: boolean
}

// 反代请求日志：模块级持久化 + 单次订阅，避免切到其它页面 unmount 后日志清空、中间请求事件丢失
type RecentLogEntry = {
  time: string
  path: string
  model?: string
  status: number
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
  credits?: number
  responseTime?: number
  messagePreview?: string
  error?: string
}
let _proxyRecentLogs: RecentLogEntry[] = []
let _refSetProxyRecentLogs: ((v: RecentLogEntry[]) => void) | null = null
let _proxyResponseListenerRegistered = false
function ensureProxyResponseListenerRegistered(): void {
  if (_proxyResponseListenerRegistered) return
  _proxyResponseListenerRegistered = true
  window.api.onProxyResponse((info) => {
    const now = new Date()
    const year = now.getFullYear()
    const month = (now.getMonth() + 1).toString().padStart(2, '0')
    const day = now.getDate().toString().padStart(2, '0')
    const hours = now.getHours().toString().padStart(2, '0')
    const minutes = now.getMinutes().toString().padStart(2, '0')
    const seconds = now.getSeconds().toString().padStart(2, '0')
    const ms = now.getMilliseconds().toString().padStart(3, '0')
    const fullTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`
    _proxyRecentLogs = [
      {
        time: fullTime,
        path: info.path,
        model: info.model,
        status: info.status,
        tokens: info.tokens,
        inputTokens: info.inputTokens,
        outputTokens: info.outputTokens,
        cacheReadTokens: info.cacheReadTokens,
        reasoningTokens: info.reasoningTokens,
        credits: info.credits,
        responseTime: info.responseTime,
        messagePreview: info.messagePreview,
        error: info.error
      },
      ..._proxyRecentLogs.slice(0, 99)
    ]
    _refSetProxyRecentLogs?.(_proxyRecentLogs)
  })
}

import {
  buildAccountsSyncSignature as buildAccountSyncSignature,
  hasUpstreamKiroCredential,
  isProxyRotationEnabled
} from '../../types/account'

export function ProxyPanel() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [isRunning, setIsRunning] = useState(false)
  const [config, setConfig] = useState<ProxyConfig>({
    enabled: false,
    port: DEFAULT_PROXY_PORT,
    host: HOST_LOOPBACK,
    enableMultiAccount: true,
    logRequests: true,
    clientDrivenToolExecution: true
  })
  const [stats, setStats] = useState<ProxyStats | null>(null)
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null)
  const [accountCount, setAccountCount] = useState(0)
  const [availableCount, setAvailableCount] = useState(0)
  const [poolAccounts, setPoolAccounts] = useState<ProxyPoolAccountSnapshot[]>([])
  const [poolNextCandidateId, setPoolNextCandidateId] = useState<string | null>(null)
  const [poolStrategy, setPoolStrategy] = useState<'round-robin' | 'sticky'>(
    DEFAULT_SELECTION_STRATEGY
  )
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recentLogs, setRecentLogs] = useState<RecentLogEntry[]>(_proxyRecentLogs)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)
  const [syncSuccess, setSyncSuccess] = useState(false)
  const [refreshSuccess, setRefreshSuccess] = useState(false)
  const [showLogsDialog, setShowLogsDialog] = useState(false)
  const [showDetailedLogsDialog, setShowDetailedLogsDialog] = useState(false)
  const [showModelsDialog, setShowModelsDialog] = useState(false)
  const [showClientConfigDialog, setShowClientConfigDialog] = useState(false)
  const [showModelMappingDialog, setShowModelMappingDialog] = useState(false)
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([])
  const [showAccountSelectDialog, setShowAccountSelectDialog] = useState(false)
  const [showApiKeyManager, setShowApiKeyManager] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [apiKeyFormat, setApiKeyFormat] = useState<ApiKeyFormat>('sk')
  const [apiKeyCopied, setApiKeyCopied] = useState(false)
  const [apiKeyGenerated, setApiKeyGenerated] = useState(false)
  const [configTab, setConfigTab] = useState<ConfigTab>('connection')

  useEscapeClose(showApiKeyManager, () => setShowApiKeyManager(false))

  const accounts = useAccountsStore((state) => state.accounts)
  const groups = useAccountsStore((state) => state.groups)

  // 生成随机 API Key
  const generateApiKey = useCallback(() => {
    const randomHex = (len: number) => {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
      return Array.from(
        { length: len },
        () => chars[Math.floor(Math.random() * chars.length)]
      ).join('')
    }

    let newKey: string
    switch (apiKeyFormat) {
      case 'sk':
        newKey = `sk-${randomHex(48)}`
        break
      case 'simple':
        newKey = `PROXY_KEY_${randomHex(32).toUpperCase()}`
        break
      case 'token':
        newKey = `PROXY_KEY:${randomHex(32)}`
        break
      default:
        newKey = `sk-${randomHex(48)}`
    }

    setConfig((prev) => ({ ...prev, apiKey: newKey }))
    window.api.proxyUpdateConfig({ apiKey: newKey })
    setShowApiKey(true)
    setApiKeyGenerated(true)
    setTimeout(() => setApiKeyGenerated(false), 1500)
  }, [apiKeyFormat])

  // 复制 API Key
  const copyApiKey = useCallback(() => {
    if (config.apiKey) {
      navigator.clipboard.writeText(config.apiKey)
      setApiKeyCopied(true)
      setTimeout(() => setApiKeyCopied(false), 1500)
    }
  }, [config.apiKey])

  // 获取状态
  const fetchStatus = useCallback(async () => {
    try {
      const result = await window.api.proxyGetStatus()
      setIsRunning(result.running)
      if (result.config) {
        const cfg = result.config as ProxyConfig & { selectedAccountIds?: string[] }
        // 将 selectedAccountIds 数组转换为单个 selectedAccountId
        if (cfg.selectedAccountIds && cfg.selectedAccountIds.length > 0) {
          cfg.selectedAccountId = cfg.selectedAccountIds[0]
        }
        const clientDrivenToolExecution = cfg.clientDrivenToolExecution !== false
        setConfig({
          ...cfg,
          clientDrivenToolExecution
        })
      }
      if (result.stats) {
        setStats(result.stats as ProxyStats)
      }
      if (result.sessionStats) {
        setSessionStats(result.sessionStats as SessionStats)
      }

      const accountsResult = await window.api.proxyGetAccounts()
      setAccountCount(accountsResult.accounts.length)
      setAvailableCount(accountsResult.availableCount)
      setPoolAccounts(accountsResult.accounts)
      setPoolNextCandidateId(accountsResult.nextCandidateId)
      setPoolStrategy(accountsResult.strategy)
    } catch (err) {
      console.error('Failed to fetch proxy status:', err)
    }
  }, [])

  const loadAvailableModels = useCallback(async () => {
    try {
      const result = await window.api.proxyGetModels()
      if (result.success && result.models) {
        setAvailableModels(
          result.models.map((m: { id: string; name?: string }) => ({
            id: m.id,
            name: m.name || m.id
          }))
        )
      }
    } catch {}
  }, [])

  // 同步账号到反代池
  // override 用于「改了分组配置立即重同步」场景：setConfig 后闭包里的 config 可能是旧值，
  // 调用方传入新模式 / 新分组 ids，强制覆盖。
  const syncAccounts = useCallback(
    async (override?: { mode?: 'all' | 'groups'; groupIds?: string[] }) => {
      setIsSyncing(true)
      setSyncSuccess(false)
      try {
        const selMode = override?.mode ?? config.multiAccountSelectionMode ?? 'all'
        const selGroupIds = override?.groupIds ?? config.multiAccountGroupIds ?? []
        let candidates = Array.from(accounts.values()).filter(
          (acc) => acc.status === 'active' && hasUpstreamKiroCredential(acc.credentials)
        )

        // 多账号轮询 + 'groups' 范围：按选中分组过滤（'__ungrouped__' 表示未分组账号）
        if (config.enableMultiAccount && selMode === 'groups') {
          const gids = new Set(selGroupIds)
          candidates = candidates.filter((acc) => {
            if (!acc.groupId) return gids.has(UNGROUPED_GROUP_ID)
            return gids.has(acc.groupId)
          })
        }

        const proxyAccounts = candidates.map((acc) => ({
          id: acc.id,
          email: acc.email,
          // 禁用的账号也要传：它们仍入池（在池里标不可用），否则反代页看不到、开关点不回来
          proxyEnabled: isProxyRotationEnabled(acc),
          accessToken: acc.credentials.accessToken,
          kiroApiKey: acc.credentials?.kiroApiKey,
          credentialKind:
            acc.credentials?.credentialKind ||
            (acc.credentials?.kiroApiKey ? 'kiro_api_key' : 'oauth'),
          refreshToken: acc.credentials?.refreshToken,
          profileArn: acc.profileArn || acc.credentials?.profileArn,
          expiresAt: acc.credentials?.expiresAt,
          // Token 刷新所需字段
          clientId: acc.credentials?.clientId,
          clientSecret: acc.credentials?.clientSecret,
          region: acc.credentials?.region || 'us-east-1',
          authMethod: acc.credentials?.authMethod,
          provider: acc.credentials?.provider || acc.idp,
          // 透传分组 ID：后端 getAvailableAccount 可据此做二次过滤（双保险），即便前端忘了重同步也安全
          groupId: acc.groupId
        }))

        const result = await window.api.proxySyncAccounts(proxyAccounts)
        if (result.success) {
          setAccountCount(result.accountCount || 0)
          await fetchStatus()
          setSyncSuccess(true)
          setTimeout(() => setSyncSuccess(false), 2000)
        }
      } catch (err) {
        console.error('Failed to sync accounts:', err)
      } finally {
        setIsSyncing(false)
      }
    },
    [
      accounts,
      fetchStatus,
      config.enableMultiAccount,
      config.multiAccountSelectionMode,
      config.multiAccountGroupIds
    ]
  )

  // 启动服务器
  const handleStart = async () => {
    setError(null)
    try {
      // 先同步账号
      await syncAccounts()

      const result = await window.api.proxyStart({
        port: config.port,
        host: config.host,
        apiKey: config.apiKey,
        enableMultiAccount: config.enableMultiAccount,
        logRequests: config.logRequests,
        clientDrivenToolExecution: config.clientDrivenToolExecution !== false,
        disableTools: config.disableTools
      })

      if (result.success) {
        setIsRunning(true)
        await fetchStatus()
      } else {
        setError(result.error || (isEn ? 'Failed to start' : '启动失败'))
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // 停止服务器
  const handleStop = async () => {
    setError(null)
    try {
      const result = await window.api.proxyStop()
      if (result.success) {
        setIsRunning(false)
        setStats(null)
      } else {
        setError(result.error || (isEn ? 'Failed to stop' : '停止失败'))
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // 复制地址（0.0.0.0 对人不可读，复制为 localhost）
  const copyAddress = () => {
    const displayHost = config.host === HOST_ANY ? 'localhost' : config.host
    const address = `http://${displayHost}:${config.port}`
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 刷新模型缓存
  const handleRefreshModels = async () => {
    setIsRefreshingModels(true)
    setRefreshSuccess(false)
    try {
      const result = await window.api.proxyRefreshModels()
      if (result.success) {
        await loadAvailableModels()
        setRefreshSuccess(true)
        setTimeout(() => setRefreshSuccess(false), 2000)
      } else {
        setError(result.error || (isEn ? 'Failed to refresh models' : '刷新模型失败'))
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsRefreshingModels(false)
    }
  }

  // 加载历史日志
  useEffect(() => {
    window.api.proxyLoadLogs().then((result) => {
      if (result.success && result.logs.length > 0) {
        setRecentLogs(result.logs)
      }
    })
  }, [])

  // 保存日志（防抖）
  useEffect(() => {
    if (recentLogs.length === 0) return
    const timer = setTimeout(() => {
      window.api.proxySaveLogs(recentLogs)
    }, 2000)
    return () => clearTimeout(timer)
  }, [recentLogs])

  // 初始化
  useEffect(() => {
    fetchStatus()
    loadAvailableModels()

    // 监听事件
    const unsubRequest = window.api.onProxyRequest((info) => {
      console.log('[Proxy] Request:', info)
    })

    // onProxyResponse：模块级单次订阅；这里只注册 setter 通道 + 拉取请求触发统计刷新
    ensureProxyResponseListenerRegistered()
    _refSetProxyRecentLogs = setRecentLogs
    // 触发一次统计刷新即可（统计有独立的 fetchStatus，不依赖订阅）
    const unsubStatsHook = window.api.onProxyResponse(() => {
      fetchStatus()
    })

    const unsubError = window.api.onProxyError((err) => {
      console.error('[Proxy] Error:', err)
      setError(err)
    })

    const unsubStatus = window.api.onProxyStatusChange((status) => {
      setIsRunning(status.running)
      if (status.running) {
        setConfig((prev) => ({ ...prev, port: status.port }))
      }
    })

    return () => {
      unsubRequest()
      unsubStatsHook()
      unsubError()
      unsubStatus()
      _refSetProxyRecentLogs = null
    }
  }, [fetchStatus, loadAvailableModels])

  // 用 ref 持有最新的 syncAccounts，避免把它放进下方 effect 依赖导致循环重触发
  const syncAccountsRef = useRef(syncAccounts)
  useEffect(() => {
    syncAccountsRef.current = syncAccounts
  }, [syncAccounts])

  /**
   * 账号集合签名：只反映"参与同步的账号 id + 分组"，**不含** token / 用量 / 状态时间戳。
   * 这样后台 token 刷新、用量更新等高频变动不会触发重新同步（避免按钮疯狂闪烁），
   * 仅在真正增删账号 / 改分组时才同步。token 更新由主进程账号池自身刷新逻辑处理。
   */
  const accountsSyncSignature = useMemo(
    () => buildAccountSyncSignature(accounts.values()),
    [accounts]
  )

  // 账号集合变化时同步（防抖 600ms + 仅签名变化才触发；跳过首次 mount 避免每次进页面都同步）
  const syncMountedRef = useRef(false)
  useEffect(() => {
    if (!isRunning) return
    if (!syncMountedRef.current) {
      syncMountedRef.current = true
      return
    }
    const timer = setTimeout(() => {
      void syncAccountsRef.current()
    }, 600)
    return () => clearTimeout(timer)
  }, [accountsSyncSignature, isRunning])

  // 实时更新运行时间
  const [uptime, setUptime] = useState(0)
  useEffect(() => {
    if (!isRunning || !stats) {
      setUptime(0)
      return
    }

    // 立即计算一次
    setUptime(Math.floor((Date.now() - stats.startTime) / 1000))

    // 每秒更新
    const timer = setInterval(() => {
      setUptime(Math.floor((Date.now() - stats.startTime) / 1000))
    }, 1000)

    return () => clearInterval(timer)
  }, [isRunning, stats])

  /**
   * 池状态定时回读。冷却到期、配额重置这类变化不伴随请求，
   * 纯靠 onProxyResponse 事件驱动会让列表停在旧值。
   */
  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => void fetchStatus(), POOL_REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [isRunning, fetchStatus])

  // 重置累计请求统计后立即回读，避免 UI 停在旧数值
  const handleResetRequestStats = useCallback(async () => {
    await window.api.proxyResetRequestStats()
    const result = await window.api.proxyGetStatus()
    if (result.stats) setStats(result.stats as ProxyStats)
    if (result.sessionStats) setSessionStats(result.sessionStats as SessionStats)
  }, [])

  const isPublicHost = config.host === HOST_ANY

  /** 可参与轮询的账号（活跃 + 具备上游凭据），分组计数与范围统计都基于这一份。 */
  const rotatableAccounts = useMemo(
    () =>
      Array.from(accounts.values()).filter(
        (a) => a.status === 'active' && hasUpstreamKiroCredential(a.credentials)
      ),
    [accounts]
  )

  /** 当前轮询范围命中的账号数：'all' 是全部，'groups' 按选中分组过滤。 */
  const rotationAccountTotal = useMemo(() => {
    if ((config.multiAccountSelectionMode || DEFAULT_SELECTION_MODE) === 'all')
      return rotatableAccounts.length
    const selectedGids = new Set(config.multiAccountGroupIds || [])
    return rotatableAccounts.filter((a) =>
      !a.groupId ? selectedGids.has(UNGROUPED_GROUP_ID) : selectedGids.has(a.groupId)
    ).length
  }, [rotatableAccounts, config.multiAccountSelectionMode, config.multiAccountGroupIds])

  /**
   * 分段标签上的状态徽标：分区把内容折叠起来了，用徽标把每屏的关键状态留在表面，
   * 免得为了确认「轮询开着没」而逐个点开。
   */
  const tabBadges: Record<ConfigTab, React.ReactNode> = {
    connection: isPublicHost ? (isEn ? 'LAN' : '外网') : null,
    rotation: config.enableMultiAccount ? rotationAccountTotal : isEn ? 'Single' : '单号',
    advanced: config.disableTools ? (isEn ? 'No tools' : '无工具') : null
  }

  const activeTabMeta = CONFIG_TABS.find((tab) => tab.value === configTab) ?? CONFIG_TABS[0]

  return (
    <div className="space-y-4">
      {/* 运行指标：置顶，进页面先看到数据，配置卡下沉 */}
      {isRunning && (
        <ProxyStatsGrid
          stats={stats}
          sessionStats={sessionStats}
          availableCount={availableCount}
          accountCount={accountCount}
          uptime={uptime}
          isEn={isEn}
          onResetRequestStats={handleResetRequestStats}
        />
      )}

      {/* 账号池明细：谁最近在用、下一个是谁、不可用的为什么 */}
      {isRunning && (
        <ProxyAccountPoolCard
          accounts={poolAccounts}
          nextCandidateId={poolNextCandidateId}
          strategy={poolStrategy}
          isEn={isEn}
          onRefresh={fetchStatus}
        />
      )}

      {/* 服务控制台：头部状态 + 操作 + 分段配置 */}
      <Card className="hover-lift relative z-10">
        {/* 顶部受光细线，跟随主题渐变 —— 与 page-hero 同一套物理感。
            两端已渐隐到透明，不需要 overflow-hidden 裁圆角（那会剪掉端点下拉）。 */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--gradient-from)_60%,transparent)_24%,color-mix(in_srgb,var(--gradient-to)_60%,transparent)_74%,transparent)]"
        />
        <CardHeader className="gap-4 pb-4">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="flex min-w-0 items-center gap-3">
              <div
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ring-1 transition-colors duration-300 ${
                  isRunning
                    ? 'bg-success/12 text-success ring-success/25'
                    : 'bg-primary/10 text-primary ring-primary/20'
                }`}
              >
                <Server className="h-5 w-5" strokeWidth={1.9} />
              </div>
              <div className="min-w-0">
                <CardTitle className="type-title text-base text-foreground">
                  {isEn ? 'Kiro API Proxy' : 'Kiro API 反代'}
                </CardTitle>
                <CardDescription className="text-xs">
                  {isEn
                    ? 'Provides OpenAI and Claude compatible API endpoints'
                    : '提供 OpenAI 和 Claude 兼容的 API 端点'}
                </CardDescription>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* 运行中直接把服务地址提到头部：这是启动后最常复制的东西 */}
              {isRunning && (
                <button
                  type="button"
                  onClick={copyAddress}
                  title={isEn ? 'Copy address' : '复制服务地址'}
                  className="group flex items-center gap-2 rounded-xl border border-[var(--glass-border-strong)] bg-[var(--glass-bg-subtle)] py-1.5 pl-3 pr-2 backdrop-blur-md transition-colors hover:border-primary/35 hover:bg-[var(--glass-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <span className="type-code text-foreground">
                    {config.host === '0.0.0.0' ? 'localhost' : config.host}:{config.port}
                  </span>
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary" />
                  )}
                </button>
              )}
              <Badge
                variant={isRunning ? 'default' : 'secondary'}
                className={
                  isRunning
                    ? 'flex items-center gap-1.5 border border-success/30 bg-success/12 pr-2.5 text-success'
                    : 'flex items-center gap-1.5 bg-muted pr-2.5 text-muted-foreground'
                }
              >
                <span className="relative flex h-2 w-2">
                  {isRunning && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                  )}
                  <span
                    className={
                      isRunning
                        ? 'relative inline-flex h-2 w-2 rounded-full bg-success'
                        : 'relative inline-flex h-2 w-2 rounded-full bg-muted-foreground'
                    }
                  ></span>
                </span>
                {isRunning ? (isEn ? 'Running' : '运行中') : isEn ? 'Stopped' : '已停止'}
              </Badge>
            </div>
          </div>

          {/* 控制按钮 */}
          <div className="flex flex-wrap items-center gap-2">
            {!isRunning ? (
              <Button onClick={handleStart} className="gap-2">
                <Play className="h-4 w-4" />
                {isEn ? 'Start Service' : '启动服务'}
              </Button>
            ) : (
              <Button onClick={handleStop} variant="destructive" className="gap-2">
                <Square className="h-4 w-4" />
                {isEn ? 'Stop Service' : '停止服务'}
              </Button>
            )}
            <Button
              onClick={() => void syncAccounts()}
              variant="outline"
              className="gap-2"
              disabled={!isRunning || isSyncing}
            >
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : syncSuccess ? (
                <Check className="h-4 w-4 text-success" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {isSyncing
                ? isEn
                  ? 'Syncing...'
                  : '同步中...'
                : syncSuccess
                  ? isEn
                    ? 'Synced!'
                    : '已同步'
                  : isEn
                    ? 'Sync Accounts'
                    : '同步账号'}
            </Button>
            <Button
              onClick={handleRefreshModels}
              variant="outline"
              className="gap-2"
              disabled={!isRunning || isRefreshingModels}
            >
              {isRefreshingModels ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : refreshSuccess ? (
                <Check className="h-4 w-4 text-success" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {isRefreshingModels
                ? isEn
                  ? 'Refreshing...'
                  : '刷新中...'
                : refreshSuccess
                  ? isEn
                    ? 'Refreshed!'
                    : '已刷新'
                  : isEn
                    ? 'Refresh Models'
                    : '刷新模型'}
            </Button>
            <Button
              onClick={() => setShowModelsDialog(true)}
              variant="outline"
              className="gap-2"
              disabled={!isRunning}
            >
              <Cpu className="h-4 w-4" />
              {isEn ? 'View Models' : '查看模型'}
            </Button>
            <Button
              onClick={() => setShowClientConfigDialog(true)}
              variant="outline"
              className="gap-2"
            >
              <Settings2 className="h-4 w-4" />
              {isEn ? 'Configure Clients' : '一键配置'}
            </Button>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-destructive/25 bg-destructive/8 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}

          {/* 分段导航：把 20+ 配置项按关注点分成三屏，首屏只留连接必填项 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 pt-4">
            <SegmentedTabs
              value={configTab}
              onChange={setConfigTab}
              layoutId="proxy-config-tab"
              ariaLabel={isEn ? 'Proxy settings sections' : '反代配置分区'}
              items={CONFIG_TABS.map((tab) => ({
                value: tab.value,
                label: isEn ? tab.labelEn : tab.labelZh,
                icon: tab.icon,
                badge: tabBadges[tab.value]
              }))}
            />
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {isEn ? activeTabMeta.hintEn : activeTabMeta.hintZh}
            </p>
          </div>
        </CardHeader>

        <CardContent className="pb-6">
          {/* ── 连接 ── 端口 / 监听地址 / API Key，启动服务前必看的三项 */}
          {configTab === 'connection' && (
            <div className="space-y-4">
              <div className="grid grid-cols-12 gap-3">
                <Field label={isEn ? 'Port' : '端口'} htmlFor="port" className="col-span-3">
                  <Input
                    id="port"
                    type="number"
                    value={config.port}
                    onChange={(e) => {
                      const newPort = parseInt(e.target.value) || DEFAULT_PROXY_PORT
                      setConfig((prev) => ({ ...prev, port: newPort }))
                      window.api.proxyUpdateConfig({ port: newPort })
                    }}
                    disabled={isRunning}
                    className="h-9 type-code"
                  />
                </Field>

                <Field
                  label={isEn ? 'Host' : '监听地址'}
                  htmlFor="host"
                  className="col-span-4"
                  hint={
                    isPublicHost
                      ? isEn
                        ? 'LAN access enabled. Set an API Key and allow port through firewall.'
                        : '已开启外网访问，建议设置 API Key + 防火墙放行端口'
                      : isEn
                        ? 'Loopback only. Toggle Public for LAN access.'
                        : '仅本机访问，开启「外网」可让局域网设备访问'
                  }
                  labelAction={
                    <div className="flex items-center gap-1.5">
                      <Label
                        htmlFor="publicAccess"
                        className={`cursor-pointer text-2xs font-semibold uppercase tracking-[0.08em] ${
                          isPublicHost ? 'text-warning' : 'text-muted-foreground'
                        }`}
                      >
                        {isEn ? 'Public' : '外网'}
                      </Label>
                      <Switch
                        id="publicAccess"
                        checked={isPublicHost}
                        onCheckedChange={async (checked) => {
                          const newHost = checked ? HOST_ANY : HOST_LOOPBACK
                          setConfig((prev) => ({ ...prev, host: newHost }))
                          await window.api.proxyUpdateConfig({ host: newHost })
                          if (isRunning) {
                            try {
                              await window.api.proxyStop()
                              await new Promise((r) => setTimeout(r, 200))
                              await window.api.proxyStart()
                            } catch (err) {
                              console.error('[Proxy] Failed to restart after host change:', err)
                              setError(err instanceof Error ? err.message : String(err))
                            }
                          }
                        }}
                        className="scale-75"
                      />
                    </div>
                  }
                >
                  <Input
                    id="host"
                    value={config.host}
                    onChange={(e) => {
                      const newHost = e.target.value
                      setConfig((prev) => ({ ...prev, host: newHost }))
                      window.api.proxyUpdateConfig({ host: newHost })
                    }}
                    disabled={isRunning}
                    className={`h-9 type-code ${isPublicHost ? 'border-warning/50' : ''}`}
                  />
                </Field>

                <Field
                  label={isEn ? 'API Key (Optional)' : 'API Key (可选)'}
                  htmlFor="apiKey"
                  className="col-span-5"
                  hint={
                    isEn
                      ? 'When set, requests must provide this key in Authorization or X-Api-Key header'
                      : '设置后，请求需在 Authorization 或 X-Api-Key 头中提供此密钥'
                  }
                  labelAction={
                    <>
                      <Select
                        value={apiKeyFormat}
                        options={API_KEY_FORMAT_OPTIONS}
                        onChange={(v) => setApiKeyFormat(v as ApiKeyFormat)}
                        className="w-[112px] h-7 text-xs [&>button]:h-7 [&>button]:py-0 [&>button]:px-2.5"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={generateApiKey}
                        disabled={isRunning}
                        title={isEn ? 'Generate' : '随机生成'}
                      >
                        {apiKeyGenerated ? (
                          <Check className="h-3.5 w-3.5 text-success" />
                        ) : (
                          <Dices className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      {config.apiKey && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={copyApiKey}
                          title={isEn ? 'Copy' : '复制'}
                        >
                          {apiKeyCopied ? (
                            <Check className="h-3.5 w-3.5 text-success" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setShowApiKeyManager(true)}
                        title={isEn ? 'Manage Multiple API Keys' : '管理多个 API Key'}
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  }
                >
                  <div className="relative">
                    <Input
                      id="apiKey"
                      type={showApiKey ? 'text' : 'password'}
                      placeholder={isEn ? 'Leave empty to skip auth' : '留空则不验证'}
                      value={config.apiKey || ''}
                      onChange={(e) => {
                        const newApiKey = e.target.value || undefined
                        setConfig((prev) => ({ ...prev, apiKey: newApiKey }))
                        window.api.proxyUpdateConfig({ apiKey: newApiKey })
                      }}
                      disabled={isRunning}
                      className="h-9 pr-9 type-code"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-full px-2.5 hover:bg-transparent"
                      onClick={() => setShowApiKey(!showApiKey)}
                      title={showApiKey ? (isEn ? 'Hide' : '隐藏') : isEn ? 'Show' : '显示'}
                    >
                      {showApiKey ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </Field>
              </div>

              {/* 外网 + 无 Key 是真实暴露风险，单独提示而不是只把边框染黄 */}
              {isPublicHost && (
                <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-warning">
                  <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span>
                    {config.apiKey
                      ? isEn
                        ? `LAN devices reach this proxy at http://<this-machine-IP>:${config.port} — keep the port firewalled to trusted networks.`
                        : `局域网设备可通过 http://<本机IP>:${config.port} 访问，请只在可信网络放行该端口`
                      : isEn
                        ? 'Listening on all interfaces without an API Key: anyone on the network can spend your quota. Set an API Key above.'
                        : '正在监听所有网卡且未设置 API Key，同网段任何人都能消耗你的额度，建议先设置 API Key'}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2.5">
                <SwitchTile
                  id="autoStart"
                  icon={Play}
                  title={isEn ? 'Auto Start' : '随软件启动'}
                  description={isEn ? 'Start proxy when app launches' : '打开应用时自动启动反代'}
                  checked={config.autoStart || false}
                  onCheckedChange={(checked) => {
                    setConfig((prev) => ({ ...prev, autoStart: checked }))
                    window.api.proxyUpdateConfig({ autoStart: checked })
                  }}
                />
                <SwitchTile
                  id="logRequests"
                  icon={FileText}
                  title={isEn ? 'Log Requests' : '记录日志'}
                  description={isEn ? 'Keep per-request history' : '保留每次请求的记录'}
                  checked={config.logRequests}
                  onCheckedChange={(checked) => {
                    setConfig((prev) => ({ ...prev, logRequests: checked }))
                    window.api.proxyUpdateConfig({ logRequests: checked })
                  }}
                />
                <SwitchTile
                  id="logStreamEvents"
                  icon={Activity}
                  title={isEn ? 'Stream Events' : '流式日志'}
                  description={isEn ? 'Verbose SSE event dump' : '记录 SSE 逐事件明细'}
                  checked={config.logStreamEvents || false}
                  onCheckedChange={(checked) => {
                    setConfig((prev) => ({ ...prev, logStreamEvents: checked }))
                    window.api.proxyUpdateConfig({ logStreamEvents: checked })
                  }}
                />
              </div>
            </div>
          )}
          {/* ── 轮询 ── 账号池怎么挑账号；本区配置均支持运行时热更新 */}
          {configTab === 'rotation' && (
            <div className="space-y-4">
              <SwitchTile
                id="multiAccount"
                icon={Users}
                title={isEn ? 'Multi-Account Rotation' : '多账号轮询'}
                description={
                  config.enableMultiAccount
                    ? isEn
                      ? 'Requests spread across the account pool'
                      : '请求分摊到账号池中的多个账号'
                    : isEn
                      ? 'All requests use one fixed account'
                      : '所有请求固定使用单个账号'
                }
                checked={config.enableMultiAccount}
                onCheckedChange={(checked) => {
                  setConfig((prev) => ({ ...prev, enableMultiAccount: checked }))
                  window.api.proxyUpdateConfig({ enableMultiAccount: checked })
                }}
              />

              {config.enableMultiAccount ? (
                <div className="space-y-4 rounded-2xl border border-[var(--glass-border-strong)] bg-[var(--glass-bg-subtle)] p-4">
                  {/* 选择策略 */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="w-20 shrink-0 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      {isEn ? 'Strategy' : '选择策略'}
                    </span>
                    <SegmentedTabs
                      size="sm"
                      layoutId="proxy-rotation-strategy"
                      ariaLabel={isEn ? 'Account selection strategy' : '账号选择策略'}
                      value={config.accountSelectionStrategy || DEFAULT_SELECTION_STRATEGY}
                      onChange={(strategy) => {
                        setConfig((prev) => ({ ...prev, accountSelectionStrategy: strategy }))
                        window.api.proxyUpdateConfig({ accountSelectionStrategy: strategy })
                      }}
                      items={[
                        { value: 'round-robin', label: isEn ? 'Round-Robin' : '轮询' },
                        { value: 'sticky', label: isEn ? 'Sticky' : '粘滞' }
                      ]}
                    />
                    <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                      {(config.accountSelectionStrategy || DEFAULT_SELECTION_STRATEGY) ===
                      'round-robin'
                        ? isEn
                          ? 'Each request rotates to next account (load balanced)'
                          : '每次请求轮询到下一个账号（负载均衡）'
                        : isEn
                          ? 'Stay on success account until failure (preserves prompt cache)'
                          : '成功后粘住该账号直到失败（保留 prompt cache）'}
                    </span>
                  </div>

                  {/* 轮询范围：全部账号 / 指定分组 */}
                  {(() => {
                    const selMode = config.multiAccountSelectionMode || DEFAULT_SELECTION_MODE
                    const selectedGids = new Set(config.multiAccountGroupIds || [])
                    const sortedGroups = Array.from(groups.values()).sort(
                      (a, b) => (a.order ?? 0) - (b.order ?? 0)
                    )
                    const ungroupedCount = rotatableAccounts.filter((a) => !a.groupId).length
                    const countByGroup = new Map<string, number>()
                    for (const a of rotatableAccounts)
                      if (a.groupId)
                        countByGroup.set(a.groupId, (countByGroup.get(a.groupId) || 0) + 1)
                    const toggleGid = (gid: string): void => {
                      const next = new Set(selectedGids)
                      if (next.has(gid)) next.delete(gid)
                      else next.add(gid)
                      const ids = Array.from(next)
                      setConfig((prev) => ({ ...prev, multiAccountGroupIds: ids }))
                      window.api.proxyUpdateConfig({ multiAccountGroupIds: ids })
                      // 关键：立即用新分组 ids 重新同步账号池，避免「改了分组但反代仍用旧账号」的体感 bug
                      void syncAccounts({ mode: 'groups', groupIds: ids })
                    }
                    return (
                      <div className="space-y-3 border-t border-border/60 pt-4">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <span className="w-20 shrink-0 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                            {isEn ? 'Scope' : '轮询范围'}
                          </span>
                          <SegmentedTabs
                            size="sm"
                            layoutId="proxy-rotation-scope"
                            ariaLabel={isEn ? 'Rotation scope' : '轮询范围'}
                            value={selMode}
                            onChange={(mode) => {
                              setConfig((prev) => ({ ...prev, multiAccountSelectionMode: mode }))
                              window.api.proxyUpdateConfig({ multiAccountSelectionMode: mode })
                              // 关键：切换 all/groups 立即重新同步账号池
                              void syncAccounts({ mode, groupIds: Array.from(selectedGids) })
                            }}
                            items={[
                              { value: 'all', label: isEn ? 'All Accounts' : '全部账号' },
                              { value: 'groups', label: isEn ? 'Specific Groups' : '指定分组' }
                            ]}
                          />
                          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                            {selMode === 'all'
                              ? isEn
                                ? `${rotationAccountTotal} active accounts`
                                : `${rotationAccountTotal} 个活跃账号`
                              : isEn
                                ? `${rotationAccountTotal} accounts in selected groups`
                                : `已选分组共 ${rotationAccountTotal} 个账号`}
                          </span>
                        </div>

                        {/* 分组多选 chip：仅 groups 模式 */}
                        {selMode === 'groups' && (
                          <div className="flex flex-wrap items-center gap-1.5 pl-[92px]">
                            {/* 未分组特殊 chip */}
                            <button
                              type="button"
                              onClick={() => toggleGid(UNGROUPED_GROUP_ID)}
                              className={`flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-medium transition-all ${
                                selectedGids.has(UNGROUPED_GROUP_ID)
                                  ? 'border-muted-foreground/30 bg-muted text-foreground'
                                  : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground'
                              }`}
                            >
                              {selectedGids.has(UNGROUPED_GROUP_ID) && (
                                <Check className="h-3 w-3" />
                              )}
                              <span>{isEn ? 'Ungrouped' : '未分组'}</span>
                              <span className="text-2xs opacity-70">({ungroupedCount})</span>
                            </button>
                            {/* 用户分组 chips */}
                            {sortedGroups.map((group) => {
                              const isSel = selectedGids.has(group.id)
                              const count = countByGroup.get(group.id) || 0
                              return (
                                <button
                                  key={group.id}
                                  type="button"
                                  onClick={() => toggleGid(group.id)}
                                  className={`flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-medium transition-all ${
                                    isSel
                                      ? 'text-foreground'
                                      : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground'
                                  }`}
                                  style={
                                    isSel
                                      ? {
                                          backgroundColor:
                                            (group.color || GROUP_FALLBACK_COLOR) + '22',
                                          borderColor: (group.color || GROUP_FALLBACK_COLOR) + '66'
                                        }
                                      : undefined
                                  }
                                >
                                  {isSel && (
                                    <Check
                                      className="h-3 w-3"
                                      style={{ color: group.color || undefined }}
                                    />
                                  )}
                                  <span
                                    className="h-2 w-2 flex-shrink-0 rounded-full"
                                    style={{
                                      backgroundColor: group.color || GROUP_FALLBACK_COLOR
                                    }}
                                  />
                                  <span>{group.name}</span>
                                  <span className="text-2xs opacity-70">({count})</span>
                                </button>
                              )
                            })}
                            {sortedGroups.length === 0 && (
                              <span className="text-xs italic text-muted-foreground">
                                {isEn
                                  ? 'No groups defined yet. Create groups in Account Manager first.'
                                  : '尚未定义任何分组，请先在账户管理中创建分组'}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              ) : (
                /* 关闭多账号轮询：固定账号 + 额度耗尽是否自动切换 */
                <div className="space-y-3 rounded-2xl border border-[var(--glass-border-strong)] bg-[var(--glass-bg-subtle)] p-4">
                  <Field label={isEn ? 'Fixed Account' : '固定账号'}>
                    <Button
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => setShowAccountSelectDialog(true)}
                    >
                      <UserCheck className="mr-2 h-4 w-4" />
                      {config.selectedAccountId
                        ? (() => {
                            const acc = accounts.get(config.selectedAccountId)
                            return acc
                              ? acc.email || acc.id.substring(0, 12) + '...'
                              : isEn
                                ? 'First Available'
                                : '第一个可用账号'
                          })()
                        : isEn
                          ? 'First Available'
                          : '第一个可用账号'}
                    </Button>
                  </Field>
                  <SwitchTile
                    id="autoSwitchOnQuotaExhausted"
                    icon={RotateCcw}
                    title={isEn ? 'Auto-switch on Quota Exhausted' : '额度耗尽自动切换'}
                    description={
                      isEn
                        ? 'Fall back to another account when quota runs out'
                        : '当前账号额度用尽时自动换下一个'
                    }
                    checked={config.autoSwitchOnQuotaExhausted || false}
                    onCheckedChange={(checked) => {
                      setConfig((prev) => ({ ...prev, autoSwitchOnQuotaExhausted: checked }))
                      window.api.proxyUpdateConfig({ autoSwitchOnQuotaExhausted: checked })
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {/* ── 高级 ── 端点 / 重试 / 载荷 / 工具与裁剪 */}
          {configTab === 'advanced' && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-x-3 gap-y-4 overflow-visible">
                <Field
                  label={isEn ? 'Preferred Endpoint' : '首选端点'}
                  htmlFor="preferredEndpoint"
                  className="relative z-20"
                >
                  <Select
                    value={config.preferredEndpoint || ''}
                    options={[
                      {
                        value: '',
                        label: isEn ? 'Auto Select' : '自动选择',
                        description: isEn
                          ? 'Auto select based on availability'
                          : '根据可用性自动选择端点'
                      },
                      {
                        value: 'codewhisperer',
                        label: 'CodeWhisperer',
                        description: isEn ? 'IDE mode endpoint' : 'IDE 模式端点'
                      },
                      {
                        value: 'amazonq',
                        label: 'AmazonQ',
                        description: isEn
                          ? 'IDE mode (q.amazonaws.com)'
                          : 'IDE 模式 (q.amazonaws.com)'
                      },
                      {
                        value: 'amazonq-cli',
                        label: 'AmazonQ CLI',
                        description: isEn
                          ? 'CLI mode (SendMessageStreaming)'
                          : 'CLI 模式 (SendMessageStreaming)'
                      }
                    ]}
                    onChange={(value) => {
                      const endpoint = (value || undefined) as ProxyConfig['preferredEndpoint']
                      setConfig((prev) => ({ ...prev, preferredEndpoint: endpoint }))
                      window.api.proxyUpdateConfig({ preferredEndpoint: endpoint })
                    }}
                    placeholder={isEn ? 'Select endpoint' : '选择端点'}
                  />
                </Field>

                <Field label={isEn ? 'Max Retries' : '最大重试次数'} htmlFor="maxRetries">
                  <Input
                    id="maxRetries"
                    type="number"
                    min={0}
                    max={10}
                    value={config.maxRetries || DEFAULT_MAX_RETRIES}
                    onChange={(e) => {
                      const retries = parseInt(e.target.value) || DEFAULT_MAX_RETRIES
                      setConfig((prev) => ({ ...prev, maxRetries: retries }))
                      window.api.proxyUpdateConfig({ maxRetries: retries })
                    }}
                    disabled={isRunning}
                    className="h-9 type-code"
                  />
                </Field>

                <Field
                  label={isEn ? 'Payload (KB)' : 'Payload (KB)'}
                  htmlFor="payloadSizeLimit"
                  hint={
                    isEn
                      ? 'When payload exceeds this limit, oldest tool results will be truncated. Default 1536KB (1.5MB).'
                      : '超过此限制时，最旧工具结果将被截断。默认 1536KB (1.5MB)'
                  }
                >
                  <Input
                    id="payloadSizeLimit"
                    type="number"
                    min={256}
                    max={204800}
                    step={1024}
                    value={config.payloadSizeLimitKB || DEFAULT_PAYLOAD_LIMIT_KB}
                    onChange={(e) => {
                      const kb = parseInt(e.target.value) || DEFAULT_PAYLOAD_LIMIT_KB
                      setConfig((prev) => ({ ...prev, payloadSizeLimitKB: kb }))
                      window.api.proxyUpdateConfig({ payloadSizeLimitKB: kb })
                    }}
                    disabled={isRunning}
                    className="h-9 type-code"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <SwitchTile
                  id="clientDrivenToolExecution"
                  icon={Cpu}
                  title={isEn ? 'Client-driven Tool Execution' : '客户端驱动工具执行'}
                  description={
                    config.clientDrivenToolExecution !== false
                      ? isEn
                        ? 'Client runs tools (recommended)'
                        : '由客户端执行工具（推荐）'
                      : isEn
                        ? 'Proxy fabricates tool results'
                        : '由代理伪造工具结果'
                  }
                  hint={
                    isEn
                      ? 'Recommended for OpenCode and Claude Code. Disable only when the proxy should fabricate tool results.'
                      : '推荐用于 OpenCode 和 Claude Code。仅在需要代理伪造工具结果时关闭。'
                  }
                  checked={config.clientDrivenToolExecution !== false}
                  onCheckedChange={(checked) => {
                    setConfig((prev) => ({ ...prev, clientDrivenToolExecution: checked }))
                    window.api.proxyUpdateConfig({ clientDrivenToolExecution: checked })
                  }}
                  disabled={isRunning}
                />
                <SwitchTile
                  id="disableTools"
                  icon={Zap}
                  title={isEn ? 'Disable Tools' : '禁用工具调用'}
                  description={
                    config.disableTools
                      ? isEn
                        ? 'Tool definitions stripped from requests'
                        : '请求中的工具定义会被移除'
                      : isEn
                        ? 'Tool definitions passed through'
                        : '工具定义正常透传'
                  }
                  hint={
                    isEn
                      ? 'When enabled, the proxy strips all tool definitions from requests.'
                      : '启用后代理会从请求中移除所有工具定义，适用于纯聊天。'
                  }
                  checked={config.disableTools || false}
                  onCheckedChange={(checked) => {
                    setConfig((prev) => ({ ...prev, disableTools: checked }))
                    window.api.proxyUpdateConfig({ disableTools: checked })
                  }}
                  disabled={isRunning}
                />
              </div>

              {/* Token Buffer 预留：开关决定输入框是否可用，两者绑成一行 */}
              <div className="space-y-2.5 rounded-2xl border border-[var(--glass-border-strong)] bg-[var(--glass-bg-subtle)] p-4">
                <SwitchTile
                  id="enableTokenBufferReserve"
                  icon={Clock}
                  title={
                    isEn
                      ? 'Token Buffer Reserve (auto-trim history)'
                      : 'Token Buffer 预留 (自动裁旧 history)'
                  }
                  description={
                    config.enableTokenBufferReserve
                      ? isEn
                        ? `Trim history ${(config.tokenBufferReserve || DEFAULT_TOKEN_BUFFER_RESERVE).toLocaleString()} tokens below the context window`
                        : `在 context window 之下预留 ${(config.tokenBufferReserve || DEFAULT_TOKEN_BUFFER_RESERVE).toLocaleString()} token 触发裁剪`
                      : isEn
                        ? 'Never trims old messages'
                        : '不裁剪任何旧消息'
                  }
                  hint={
                    isEn
                      ? 'When enabled, reserves N tokens below context window for trim (e.g. 200K → trim at 180K). When disabled, never trims.'
                      : '启用后从模型 context window 预留 N 个 token 作为裁剪阈值（例：200K → 180K 裁剪）。关闭时不裁剪任何旧消息。'
                  }
                  checked={config.enableTokenBufferReserve || false}
                  onCheckedChange={(checked) => {
                    setConfig((prev) => ({ ...prev, enableTokenBufferReserve: checked }))
                    window.api.proxyUpdateConfig({ enableTokenBufferReserve: checked })
                  }}
                  disabled={isRunning}
                />
                <Field
                  label={isEn ? 'Reserved Tokens' : '预留 Token 数'}
                  htmlFor="tokenBufferReserve"
                >
                  <Input
                    id="tokenBufferReserve"
                    type="number"
                    min={5000}
                    max={150000}
                    step={1000}
                    value={config.tokenBufferReserve || DEFAULT_TOKEN_BUFFER_RESERVE}
                    onChange={(e) => {
                      const tokens = parseInt(e.target.value) || DEFAULT_TOKEN_BUFFER_RESERVE
                      setConfig((prev) => ({ ...prev, tokenBufferReserve: tokens }))
                      window.api.proxyUpdateConfig({ tokenBufferReserve: tokens })
                    }}
                    disabled={isRunning || !config.enableTokenBufferReserve}
                    placeholder={
                      isEn
                        ? `Reserve tokens (default ${DEFAULT_TOKEN_BUFFER_RESERVE})`
                        : `预留 token 数（默认 ${DEFAULT_TOKEN_BUFFER_RESERVE}）`
                    }
                    className="h-9 type-code"
                  />
                </Field>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 最近请求日志：紧跟服务控制台，便于启动后立即观察请求 */}
      {recentLogs.length > 0 && (
        <Card className="hover-lift">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-primary/10">
                  <Activity className="h-4 w-4 text-primary" />
                </div>
                {isEn ? 'Recent Requests' : '最近请求'}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  {recentLogs.length}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setShowLogsDialog(true)}
                >
                  <FileText className="h-3 w-3 mr-1" />
                  {isEn ? 'View All' : '查看全部'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setShowDetailedLogsDialog(true)}
                >
                  <Activity className="h-3 w-3 mr-1" />
                  {isEn ? 'Detailed Logs' : '详细日志'}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="max-h-[150px] overflow-y-auto text-xs font-mono space-y-0.5">
              {recentLogs.slice(0, 5).map((log, idx) => (
                <div
                  key={idx}
                  className="grid gap-2 py-1 px-2 rounded hover:bg-muted/50 items-center"
                  style={{
                    gridTemplateColumns: '2fr 1fr 1.2fr 0.5fr 0.8fr 0.8fr 0.8fr 0.8fr 0.6fr'
                  }}
                >
                  <span className="text-muted-foreground whitespace-nowrap text-left">
                    {log.time}
                  </span>
                  <span className="truncate text-left" title={log.path}>
                    {log.path}
                  </span>
                  <span className="truncate text-left text-muted-foreground" title={log.model}>
                    {log.model ? log.model.replace('anthropic.', '').replace('-v1:0', '') : '-'}
                  </span>
                  <span
                    className={`text-center ${log.status >= 400 ? 'text-destructive' : 'text-success'}`}
                  >
                    {log.status}
                  </span>
                  <span className="text-muted-foreground text-right">
                    {log.inputTokens ? log.inputTokens.toLocaleString() : '-'}
                  </span>
                  <span className="text-muted-foreground text-right">
                    {log.outputTokens ? log.outputTokens.toLocaleString() : '-'}
                  </span>
                  <span className="text-success text-right">
                    {log.cacheReadTokens ? log.cacheReadTokens.toLocaleString() : '-'}
                  </span>
                  <span className="text-muted-foreground text-right">
                    {log.credits ? log.credits.toFixed(4) : '-'}
                  </span>
                  <span className="text-muted-foreground text-right">
                    {log.responseTime ? `${(log.responseTime / 1000).toFixed(1)}s` : '-'}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* v1.8 反代安全 / 可观测设置（独立卡片，可折叠） */}
      <ProxySecurityPanel
        config={config as unknown as Parameters<typeof ProxySecurityPanel>[0]['config']}
        setConfig={setConfig as unknown as Parameters<typeof ProxySecurityPanel>[0]['setConfig']}
        isRunning={isRunning}
        isEn={isEn}
      />

      {/* API 端点说明 */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <Globe className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'API Endpoints' : 'API 端点'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1/chat/completions</code>
            <span className="text-xs text-muted-foreground">
              {isEn ? 'OpenAI Compatible' : 'OpenAI 兼容'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1/responses</code>
            <span className="text-xs text-muted-foreground">
              {isEn ? 'OpenAI Responses' : 'OpenAI Responses'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1/messages</code>
            <span className="text-xs text-muted-foreground">
              {isEn ? 'Claude Compatible' : 'Claude 兼容'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">/anthropic/v1/messages</code>
            <span className="text-xs text-muted-foreground">
              {isEn ? 'Claude Code' : 'Claude Code'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">
              /v1/messages/count_tokens
            </code>
            <span className="text-xs text-muted-foreground">
              {isEn ? 'Token Count' : 'Token 计数'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1/models</code>
            <span className="text-xs text-muted-foreground">
              {isEn ? 'Model List' : '模型列表'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">
              /v1beta/models/*:generateContent
            </code>
            <span className="text-xs text-muted-foreground">
              {isEn ? 'Gemini Compatible' : 'Gemini 兼容'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1beta/models</code>
            <span className="text-xs text-muted-foreground">
              {isEn ? 'Gemini Models' : 'Gemini 模型'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
            <code className="text-muted-foreground flex-1 font-mono">/health</code>
            <span className="text-xs text-muted-foreground">
              {isEn ? 'Health Check' : '健康检查'}
            </span>
          </div>
          <div className="border-t pt-2 mt-2 space-y-1.5">
            <div className="text-xs text-muted-foreground mb-1">
              {isEn ? 'Admin API (Requires API Key)' : '管理 API (需要 API Key)'}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
              <code className="text-muted-foreground flex-1 font-mono">/admin/stats</code>
              <span className="text-xs text-muted-foreground">
                {isEn ? 'Detailed Stats' : '详细统计'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
              <code className="text-muted-foreground flex-1 font-mono">/admin/accounts</code>
              <span className="text-xs text-muted-foreground">
                {isEn ? 'Account List' : '账号列表'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
              <code className="text-muted-foreground flex-1 font-mono">/admin/logs</code>
              <span className="text-xs text-muted-foreground">
                {isEn ? 'Request Logs' : '请求日志'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 功能说明 */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Supported Features' : '支持的功能'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">
                {isEn ? 'Auto Token Refresh' : 'Token 自动刷新'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'Request Retry' : '请求重试机制'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">
                {isEn ? 'Multi-Account Rotation' : '多账号轮询'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">
                {isEn ? 'IDC/Social Auth' : 'IDC/Social 认证'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">
                {isEn ? 'Agentic Mode Detection' : 'Agentic 模式检测'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">
                {isEn ? 'Thinking Mode Support' : 'Thinking 模式支持'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'Image Processing' : '图像处理'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'Usage Statistics' : '使用量统计'}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 日志弹窗 */}
      <ProxyLogsDialog
        open={showLogsDialog}
        onOpenChange={setShowLogsDialog}
        logs={recentLogs}
        totalCredits={stats?.totalCredits || 0}
        totalTokens={(stats?.inputTokens || 0) + (stats?.outputTokens || 0)}
        onClearLogs={() => {
          setRecentLogs([])
          window.api.proxySaveLogs([])
        }}
        onResetCredits={async () => {
          await window.api.proxyResetCredits()
          fetchStatus()
        }}
        onResetTokens={async () => {
          await window.api.proxyResetTokens()
          fetchStatus()
        }}
        isEn={isEn}
      />

      {/* 详细日志弹窗 */}
      <ProxyDetailedLogsDialog
        open={showDetailedLogsDialog}
        onOpenChange={setShowDetailedLogsDialog}
      />

      {/* 模型列表弹窗 */}
      <ModelsDialog
        open={showModelsDialog}
        onOpenChange={setShowModelsDialog}
        isEn={isEn}
        onOpenModelMapping={async () => {
          // 获取可用模型列表
          try {
            const result = await window.api.proxyGetModels()
            if (result.success && result.models) {
              setAvailableModels(
                result.models.map((m: { id: string; name?: string }) => ({
                  id: m.id,
                  name: m.name || m.id
                }))
              )
            }
          } catch {
            // 忽略错误
          }
          setShowModelsDialog(false)
          setShowModelMappingDialog(true)
        }}
        mappingCount={config.modelMappings?.length || 0}
      />

      <ClientConfigDialog
        open={showClientConfigDialog}
        onOpenChange={setShowClientConfigDialog}
        isEn={isEn}
      />

      {/* 模型映射弹窗 */}
      <ModelMappingDialog
        open={showModelMappingDialog}
        onOpenChange={setShowModelMappingDialog}
        isEn={isEn}
        mappings={config.modelMappings || []}
        onMappingsChange={(mappings) => {
          setConfig((prev) => ({ ...prev, modelMappings: mappings }))
          window.api.proxyUpdateConfig({ modelMappings: mappings })
        }}
        apiKeys={(config.apiKeys || []).map((k) => ({ id: k.id, name: k.name }))}
        availableModels={availableModels}
      />

      {/* 账号选择弹窗 */}
      <AccountSelectDialog
        open={showAccountSelectDialog}
        onOpenChange={setShowAccountSelectDialog}
        accounts={accounts}
        selectedAccountId={config.selectedAccountId}
        onSelect={(accountId) => {
          setConfig((prev) => ({ ...prev, selectedAccountId: accountId }))
          window.api.proxyUpdateConfig({ selectedAccountIds: accountId ? [accountId] : [] })
        }}
        isEn={isEn}
      />

      {/* API Key 管理弹窗 */}
      {showApiKeyManager &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setShowApiKeyManager(false)}
            />
            <div className="relative bg-background rounded-lg shadow-lg w-[800px] max-h-[80vh] overflow-y-auto p-4">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">
                  {isEn ? 'API Key Management' : 'API Key 管理'}
                </h2>
                <Button variant="ghost" size="icon" onClick={() => setShowApiKeyManager(false)}>
                  ✕
                </Button>
              </div>
              <ApiKeyManager />
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
