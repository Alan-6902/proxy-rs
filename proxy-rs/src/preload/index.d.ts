import { ElectronAPI } from '@electron-toolkit/preload'
import type { ProxyEntry } from '../shared/proxyPool'
import type {
  BatchOpResult as IdcBatchOpResult,
  BatchOpTarget as IdcBatchTarget,
  IdcCredentialConfig,
  IdcIpcResult,
  PlannedSeat as IdcPlannedSeat,
  ProvisionSummary as IdcProvisionSummary,
  SeatInventory as IdcSeatInventory,
  SeatProgressEvent as IdcProgressEvent
} from '../shared/idcSeats'
import type {
  ConvoySyncConfig,
  ConvoySyncStatus,
  ManualConvoyKey,
  ManualConvoyKeyResult
} from '../shared/convoyCredentials'

interface AccountData {
  accounts: Record<string, unknown>
  groups: Record<string, unknown>
  tags: Record<string, unknown>
  activeAccountId: string | null
  autoRefreshEnabled: boolean
  autoRefreshInterval: number
  autoRefreshConcurrency?: number
  autoRefreshSyncInfo?: boolean
  statusCheckInterval: number
  privacyMode?: boolean
  usagePrecision?: boolean
  proxyEnabled?: boolean
  proxyUrl?: string
  autoSwitchEnabled?: boolean
  autoSwitchThreshold?: number
  autoSwitchInterval?: number
  theme?: string
  darkMode?: boolean
  language?: 'auto' | 'en' | 'zh'
  // 代理池
  proxyPool?: Record<string, unknown>
  proxyPoolConfig?: unknown
  /** 轮询光标：上次选中的代理 id（旧版本为数字下标，加载时会丢弃） */
  proxyPoolCursor?: string
  /** 账号-代理绑定映射 */
  accountProxyBindings?: Record<string, string>
}

interface RefreshResult {
  success: boolean
  data?: {
    accessToken: string
    refreshToken?: string
    expiresIn: number
    expiresAt?: number
    credentialRevision?: string
    /** Enterprise 账号刷新时主进程自动获取的真实 profileArn */
    profileArn?: string
  }
  error?: { message: string }
}

/** Kiro IDE 自己 refresh 完写回 token 文件、被反代检测到后通知 renderer 的 payload */
interface BonusData {
  code: string
  name: string
  current: number
  limit: number
  expiresAt?: string
}

interface ResourceDetail {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  overageEnabled?: boolean
}

interface StatusResult {
  success: boolean
  data?: {
    status: string
    email?: string
    userId?: string
    idp?: string // 身份提供商：BuilderId, Google, Github 等
    userStatus?: string // 用户状态：Active 等
    featureFlags?: string[] // 特性开关
    subscriptionTitle?: string
    usage?: {
      current: number
      limit: number
      percentUsed: number
      lastUpdated: number
      baseLimit?: number
      baseCurrent?: number
      freeTrialLimit?: number
      freeTrialCurrent?: number
      freeTrialExpiry?: string
      bonuses?: BonusData[]
      nextResetDate?: string
      resourceDetail?: ResourceDetail
    }
    subscription?: {
      type: string
      title?: string
      rawType?: string
      expiresAt?: number
      daysRemaining?: number
      upgradeCapability?: string
      overageCapability?: string
      managementTarget?: string
    }
    // 如果 token 被刷新，返回新凭证
    newCredentials?: {
      accessToken: string
      refreshToken?: string
      expiresAt?: number
      credentialRevision?: string
    }
  }
  error?: { message: string }
}

type UpstreamKiroCredentialInput =
  | string
  | {
      credentialKind?: 'oauth' | 'kiro_api_key'
      accessToken?: string
      kiroApiKey?: string
    }

interface KiroApi {
  openExternal: (url: string) => void
  openIncognitoBrowser: (url: string) => void
  getAppVersion: () => Promise<string>
  onAuthCallback: (callback: (data: { code: string; state: string }) => void) => () => void

  // 账号管理
  loadAccounts: () => Promise<AccountData | null>
  saveAccounts: (data: AccountData) => Promise<void>
  refreshAccountToken: (account: unknown) => Promise<RefreshResult>
  checkAccountStatus: (account: unknown) => Promise<StatusResult>

  // 后台批量刷新（主进程执行，不阻塞 UI）
  backgroundBatchRefresh: (
    accounts: Array<{
      id: string
      email: string
      idp?: string
      profileArn?: string
      needsTokenRefresh?: boolean
      credentials: {
        credentialKind?: 'oauth' | 'kiro_api_key'
        kiroApiKey?: string
        refreshToken?: string
        credentialRevision?: string
        clientId?: string
        clientSecret?: string
        region?: string
        authMethod?: string
        accessToken?: string
        provider?: string
        profileArn?: string
      }
    }>,
    concurrency?: number,
    syncInfo?: boolean
  ) => Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }>
  onBackgroundRefreshProgress: (
    callback: (data: { completed: number; total: number; success: number; failed: number }) => void
  ) => () => void
  onBackgroundRefreshResult: (
    callback: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void
  ) => () => void

  // 后台批量检查账号状态（不刷新 Token）
  backgroundBatchCheck: (
    accounts: Array<{
      id: string
      email: string
      credentials: {
        credentialKind?: 'oauth' | 'kiro_api_key'
        accessToken?: string
        kiroApiKey?: string
        refreshToken?: string
        clientId?: string
        clientSecret?: string
        region?: string
        authMethod?: string
        provider?: string
      }
      idp?: string
    }>,
    concurrency?: number
  ) => Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }>
  onBackgroundCheckProgress: (
    callback: (data: { completed: number; total: number; success: number; failed: number }) => void
  ) => () => void
  onBackgroundCheckResult: (
    callback: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void
  ) => () => void

  // 文件操作
  exportToFile: (data: string, filename: string) => Promise<boolean>
  importFromFile: () => Promise<{ content: string; format: string } | null>

  // 验证凭证并获取账号信息
  verifyAccountCredentials: (credentials: {
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    credentialKind?: 'oauth' | 'kiro_api_key'
    kiroApiKey?: string
    region?: string
    authMethod?: string // 'IdC' 或 'social'
    provider?: string // 'BuilderId', 'Github', 'Google'
  }) => Promise<{
    success: boolean
    data?: {
      email: string
      userId: string
      accessToken: string
      refreshToken: string
      expiresIn?: number
      subscriptionType: string
      subscriptionTitle: string
      subscription?: {
        rawType?: string
        managementTarget?: string
        upgradeCapability?: string
        overageCapability?: string
      }
      usage: {
        current: number
        limit: number
        baseLimit?: number
        baseCurrent?: number
        freeTrialLimit?: number
        freeTrialCurrent?: number
        freeTrialExpiry?: string
        bonuses?: Array<{
          code: string
          name: string
          current: number
          limit: number
          expiresAt?: string
        }>
        nextResetDate?: string
        resourceDetail?: {
          displayName?: string
          displayNamePlural?: string
          resourceType?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          overageEnabled?: boolean
        }
      }
      daysRemaining?: number
      expiresAt?: number
      profileArn?: string
    }
    error?: string
  }>

  // 从 AWS SSO Token (x-amz-sso_authn) 导入账号
  importFromSsoToken: (
    bearerToken: string,
    region?: string
  ) => Promise<{
    success: boolean
    data?: {
      accessToken: string
      refreshToken: string
      clientId: string
      clientSecret: string
      region: string
      expiresIn?: number
      email?: string
      userId?: string
      idp?: string
      status?: string
      subscriptionType?: string
      subscriptionTitle?: string
      subscription?: {
        managementTarget?: string
        upgradeCapability?: string
        overageCapability?: string
      }
      usage?: {
        current: number
        limit: number
        baseLimit?: number
        baseCurrent?: number
        freeTrialLimit?: number
        freeTrialCurrent?: number
        freeTrialExpiry?: string
        bonuses?: Array<{
          code: string
          name: string
          current: number
          limit: number
          expiresAt?: string
        }>
        nextResetDate?: string
        resourceDetail?: {
          displayName?: string
          displayNamePlural?: string
          resourceType?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          overageEnabled?: boolean
        }
      }
      daysRemaining?: number
    }
    error?: { message: string }
  }>

  // ============ 手动登录 API ============

  // 启动 Builder ID 手动登录
  startBuilderIdLogin: (region?: string) => Promise<{
    success: boolean
    userCode?: string
    verificationUri?: string
    expiresIn?: number
    interval?: number
    error?: string
  }>

  // 轮询 Builder ID 授权状态
  pollBuilderIdAuth: (region?: string) => Promise<{
    success: boolean
    completed?: boolean
    status?: string
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  }>

  // 取消 Builder ID 登录
  cancelBuilderIdLogin: () => Promise<{ success: boolean }>

  // 启动 IAM Identity Center SSO 登录 (Authorization Code flow)
  startIamSsoLogin: (
    startUrl: string,
    region?: string
  ) => Promise<{
    success: boolean
    authorizeUrl?: string
    expiresIn?: number
    error?: string
  }>

  // 轮询 IAM SSO 授权状态
  pollIamSsoAuth: (region?: string) => Promise<{
    success: boolean
    completed?: boolean
    status?: string
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  }>

  // 取消 IAM SSO 登录
  cancelIamSsoLogin: () => Promise<{ success: boolean }>

  // 启动 Social Auth 登录 (Google/GitHub)
  startSocialLogin: (provider: 'Google' | 'Github') => Promise<{
    success: boolean
    loginUrl?: string
    state?: string
    error?: string
  }>

  // 交换 Social Auth token
  exchangeSocialToken: (
    code: string,
    state: string
  ) => Promise<{
    success: boolean
    accessToken?: string
    refreshToken?: string
    profileArn?: string
    expiresIn?: number
    authMethod?: string
    provider?: string
    error?: string
  }>

  // 取消 Social Auth 登录
  cancelSocialLogin: () => Promise<{ success: boolean }>

  // 监听 Social Auth 回调
  onSocialAuthCallback: (
    callback: (data: { code?: string; state?: string; error?: string }) => void
  ) => () => void

  // 代理设置
  setProxy: (
    enabled: boolean,
    url: string
  ) => Promise<{ success: boolean; error?: string; normalizedUrl?: string }>

  // 获取当前账号可用模型（诊断功能使用）
  getKiroAvailableModels: () => Promise<{
    models: Array<{ id: string; name: string; description: string }>
    error?: string
  }>

  // ============ Kiro API 反代服务器 ============

  // 启动反代服务器
  proxyStart: (config?: {
    port?: number
    host?: string
    apiKey?: string
    enableMultiAccount?: boolean
    logRequests?: boolean
    clientDrivenToolExecution?: boolean
    disableTools?: boolean
    modelThinkingMode?: Record<string, boolean>
    thinkingOutputFormat?: 'auto' | 'reasoning_content' | 'thinking' | 'think'
  }) => Promise<{ success: boolean; port?: number; error?: string }>

  // 停止反代服务器
  proxyStop: () => Promise<{ success: boolean; error?: string }>

  // 获取反代服务器状态
  proxyGetStatus: () => Promise<{
    running: boolean
    config: unknown
    stats: unknown
    sessionStats?: {
      totalRequests: number
      successRequests: number
      failedRequests: number
      startTime: number
    }
  }>

  // 重置累计 credits
  proxyResetCredits: () => Promise<{ success: boolean }>

  // 重置累计 tokens
  proxyResetTokens: () => Promise<{ success: boolean }>

  // 重置请求统计
  proxyResetRequestStats: () => Promise<{ success: boolean }>

  // 获取反代详细日志
  proxyGetLogs: (
    count?: number
  ) => Promise<
    Array<{ timestamp: string; level: string; category: string; message: string; data?: unknown }>
  >

  // 清除反代详细日志
  proxyClearLogs: () => Promise<{ success: boolean }>

  // 获取反代日志数量
  proxyGetLogsCount: () => Promise<number>

  // 更新反代服务器配置
  proxyUpdateConfig: (
    config: Record<string, unknown>
  ) => Promise<{ success: boolean; config?: unknown; error?: string }>
  proxyAdminKeyStatus: () => Promise<{ configured: boolean; success?: boolean; error?: string }>
  proxyAdminKeyRotate: () => Promise<{ success: boolean; adminApiKey?: string; error?: string }>
  proxyAdminKeySet: (
    adminApiKey: string
  ) => Promise<{ success: boolean; adminApiKey?: string; error?: string }>
  proxyAdminKeyClear: () => Promise<{ success: boolean; error?: string }>

  // ============ v1.8 反代安全 / 可观测 IPC ============
  proxySelfSignedCertInfo: () => Promise<{
    success: boolean
    cert?: string
    key?: string
    fingerprint?: string
    notBefore?: number
    notAfter?: number
    subject?: string
    altNames?: string[]
    error?: string
  }>
  proxySelfSignedCertRegenerate: () => Promise<{
    success: boolean
    cert?: string
    key?: string
    fingerprint?: string
    notBefore?: number
    notAfter?: number
    subject?: string
    altNames?: string[]
    error?: string
  }>
  proxyNeedsRestart: () => Promise<{ needsRestart: boolean }>
  proxyRestart: () => Promise<{ success: boolean; error?: string }>
  proxyAuditLog: () => Promise<{
    entries: Array<{ ts: number; type: string; data: Record<string, unknown> }>
  }>
  notifyLocal: (
    kind: 'registration-risk-paused' | 'registration-batch-completed',
    input?: { batchId?: string }
  ) => Promise<void>
  onLocalNotificationNavigate: (
    callback: (page: 'accounts' | 'proxy' | 'register') => void
  ) => () => void

  // 添加账号到反代池
  proxyAddAccount: (
    account: {
      id: string
      email?: string
      refreshToken?: string
      profileArn?: string
      expiresAt?: number
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: string
      provider?: string
    } & UpstreamKiroCredentialInput
  ) => Promise<{ success: boolean; accountCount?: number; error?: string }>

  // 从反代池移除账号
  proxyRemoveAccount: (
    accountId: string
  ) => Promise<{ success: boolean; accountCount?: number; error?: string }>

  // 同步账号到反代池（批量更新）
  proxySyncAccounts: (
    accounts: Array<
      {
        id: string
        email?: string
        refreshToken?: string
        profileArn?: string
        expiresAt?: number
        clientId?: string
        clientSecret?: string
        region?: string
        authMethod?: string
        provider?: string
      } & UpstreamKiroCredentialInput
    >
  ) => Promise<{ success: boolean; accountCount?: number; error?: string }>

  // 获取反代池账号列表
  proxyGetAccounts: () => Promise<{ accounts: unknown[]; availableCount: number }>

  // 重置反代池状态
  proxyResetPool: () => Promise<{ success: boolean; error?: string }>

  // 手动解除账号封禁标记
  proxyClearAccountSuspended: (accountId: string) => Promise<{ success: boolean; error?: string }>

  // 刷新模型缓存
  proxyRefreshModels: () => Promise<{ success: boolean; error?: string }>

  // 获取可用模型列表
  proxyGetModels: () => Promise<{
    success: boolean
    error?: string
    models: Array<{
      id: string
      name: string
      description: string
      inputTypes?: string[]
      maxInputTokens?: number | null
      maxOutputTokens?: number | null
      rateMultiplier?: number
      rateUnit?: string
    }>
    fromCache?: boolean
  }>

  proxyConfigureClients: (input: {
    clients: Array<'claudeCode' | 'opencode' | 'codex' | 'gemini' | 'hermes' | 'openclaw'>
    modelId: string
    modelName?: string
    models?: Array<{
      id: string
      name?: string
      inputTypes?: string[]
      maxInputTokens?: number | null
      maxOutputTokens?: number | null
    }>
  }) => Promise<{
    success: boolean
    error?: string
    proxyOrigin: string
    openaiBaseUrl: string
    results: Array<{
      client: 'claudeCode' | 'opencode' | 'codex' | 'gemini' | 'hermes' | 'openclaw'
      success: boolean
      paths: string[]
      backupPaths: string[]
      error?: string
    }>
  }>

  // 获取账户可用模型列表
  accountGetModels: (
    credential: UpstreamKiroCredentialInput,
    region?: string,
    profileArn?: string,
    provider?: string,
    authMethod?: string,
    accountId?: string
  ) => Promise<{
    success: boolean
    error?: string
    models: Array<{
      id: string
      name: string
      description: string
      inputTypes?: string[]
      maxInputTokens?: number | null
      maxOutputTokens?: number | null
      rateMultiplier?: number
      rateUnit?: string
    }>
  }>

  // 获取可用订阅列表
  accountGetSubscriptions: (
    credential: UpstreamKiroCredentialInput,
    region?: string,
    profileArn?: string,
    provider?: string,
    authMethod?: string,
    accountId?: string
  ) => Promise<{
    success: boolean
    error?: string
    plans: Array<{
      name: string
      qSubscriptionType: string
      description: {
        title: string
        billingInterval: string
        featureHeader: string
        features: string[]
      }
      pricing: { amount: number; currency: string }
    }>
    disclaimer?: string[]
  }>

  // 获取订阅管理/支付链接
  accountGetSubscriptionUrl: (
    credential: UpstreamKiroCredentialInput,
    subscriptionType?: string,
    region?: string,
    profileArn?: string,
    provider?: string,
    authMethod?: string,
    accountId?: string
  ) => Promise<{ success: boolean; error?: string; url?: string; status?: string }>

  // 在新窗口打开订阅链接
  openSubscriptionWindow: (url: string) => Promise<{ success: boolean; error?: string }>

  // 保存代理日志
  proxySaveLogs: (
    logs: Array<{ time: string; path: string; status: number; tokens?: number }>
  ) => Promise<{ success: boolean; error?: string }>

  // 加载代理日志
  proxyLoadLogs: () => Promise<{
    success: boolean
    logs: Array<{ time: string; path: string; status: number; tokens?: number }>
  }>

  // 监听反代请求事件
  onProxyRequest: (
    callback: (info: { path: string; method: string; accountId?: string }) => void
  ) => () => void

  // 监听反代响应事件
  onProxyResponse: (
    callback: (info: {
      path: string
      model?: string
      status: number
      tokens?: number
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      reasoningTokens?: number
      credits?: number
      responseTime?: number
      error?: string
    }) => void
  ) => () => void

  // 监听反代错误事件
  onProxyError: (callback: (error: string) => void) => () => void

  // 监听反代状态变化事件
  onProxyStatusChange: (
    callback: (status: { running: boolean; port: number }) => void
  ) => () => void

  // 监听反代账号被封禁事件（TEMPORARILY_SUSPENDED / AccountSuspendedException）
  onProxyAccountSuspended: (
    callback: (info: {
      id: string
      email?: string
      reason: string
      message: string
      suspendedAt: number
    }) => void
  ) => () => void

  // 监听反代账号更新事件（token 刷新 / Enterprise profileArn 自愈）
  onProxyAccountUpdate: (
    callback: (info: {
      id: string
      accessToken?: string
      refreshToken?: string
      expiresAt?: number
      credentialRevision?: string
      profileArn?: string
    }) => void
  ) => () => void

  // ============ Usage API 类型设置 ============

  // 获取 Usage API 类型
  getUsageApiType: () => Promise<'rest' | 'cbor'>

  // 设置 Usage API 类型
  setUsageApiType: (type: 'rest' | 'cbor') => Promise<{ success: boolean; type: string }>

  // ============ API Key 管理 ============

  // 获取所有 API Keys
  proxyGetApiKeys: () => Promise<{
    success: boolean
    apiKeys: Array<{
      id: string
      name: string
      key: string
      enabled: boolean
      createdAt: number
      lastUsedAt?: number
      usage: {
        totalRequests: number
        totalCredits: number
        totalInputTokens: number
        totalOutputTokens: number
        daily: Record<
          string,
          { requests: number; credits: number; inputTokens: number; outputTokens: number }
        >
      }
    }>
    error?: string
  }>

  // 添加 API Key
  proxyAddApiKey: (apiKey: {
    name: string
    key?: string
    format?: 'sk' | 'simple' | 'token'
    creditsLimit?: number
  }) => Promise<{
    success: boolean
    apiKey?: {
      id: string
      name: string
      key: string
      format?: 'sk' | 'simple' | 'token'
      enabled: boolean
      createdAt: number
      creditsLimit?: number
      usage: {
        totalRequests: number
        totalCredits: number
        totalInputTokens: number
        totalOutputTokens: number
        daily: Record<
          string,
          { requests: number; credits: number; inputTokens: number; outputTokens: number }
        >
      }
    }
    error?: string
  }>

  // 更新 API Key
  proxyUpdateApiKey: (
    id: string,
    updates: { name?: string; key?: string; enabled?: boolean; creditsLimit?: number | null }
  ) => Promise<{
    success: boolean
    apiKey?: {
      id: string
      name: string
      key: string
      format?: 'sk' | 'simple' | 'token'
      enabled: boolean
      createdAt: number
      creditsLimit?: number
      usage: {
        totalRequests: number
        totalCredits: number
        totalInputTokens: number
        totalOutputTokens: number
        daily: Record<
          string,
          { requests: number; credits: number; inputTokens: number; outputTokens: number }
        >
      }
    }
    error?: string
  }>

  // 删除 API Key
  proxyDeleteApiKey: (id: string) => Promise<{ success: boolean; error?: string }>

  // 重置 API Key 用量统计
  proxyResetApiKeyUsage: (id: string) => Promise<{ success: boolean; error?: string }>

  // ============ 自定义 titlebar API ============
  window: {
    minimize: () => void
    maximizeToggle: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    getPlatform: () => Promise<NodeJS.Platform>
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
  }

  // ============ 托盘相关 API ============

  // 获取托盘设置
  getShowWindowShortcut: () => Promise<string>
  setShowWindowShortcut: (shortcut: string) => Promise<{ success: boolean; error?: string }>
  getTraySettings: () => Promise<{
    enabled: boolean
    closeAction: 'ask' | 'minimize' | 'quit'
    showNotifications: boolean
    minimizeOnStart: boolean
  }>

  // 保存托盘设置
  saveTraySettings: (settings: {
    enabled?: boolean
    closeAction?: 'ask' | 'minimize' | 'quit'
    showNotifications?: boolean
    minimizeOnStart?: boolean
  }) => Promise<{ success: boolean; error?: string }>

  // 更新托盘当前账户信息
  updateTrayAccount: (
    account: {
      id: string
      email: string
      idp: string
      status: string
      subscription?: string
      usage?: {
        usedCredits: number
        totalCredits: number
        totalRequests: number
        successRequests: number
        failedRequests: number
      }
    } | null
  ) => void

  // 更新托盘账户列表
  updateTrayAccountList: (
    accounts: {
      id: string
      email: string
      idp: string
      status: string
    }[]
  ) => void

  // 刷新托盘菜单
  refreshTrayMenu: () => void

  // 更新托盘语言
  updateTrayLanguage: (language: 'en' | 'zh') => void

  // 监听托盘刷新账户事件
  onTrayRefreshAccount: (callback: () => void) => () => void

  // 监听托盘切换账户事件
  onTraySwitchAccount: (callback: () => void) => () => void

  // 监听显示关闭确认对话框事件
  onShowCloseConfirmDialog: (callback: () => void) => () => void

  // 发送关闭确认对话框响应
  sendCloseConfirmResponse: (
    action: 'minimize' | 'quit' | 'cancel',
    rememberChoice: boolean
  ) => void

  // ============ 注册功能 API ============

  registrationStartAuto: (config: {
    proxy?: string
    upstreamProxy?: string
    strictProxy?: boolean
    moEmailBaseURL?: string
    moEmailAPIKey?: string
    useOutlook?: boolean
    outlookData?: string
    useTempMailPlus?: boolean
    tempMailPlusEmail?: string
    tempMailPlusEpin?: string
    tempMailPlusDomain?: string
    useProton?: boolean
    protonEmail?: string
    useGptMail?: boolean
    gptMailBaseURL?: string
    gptMailInboxEmail?: string
    gptMailDomain?: string
    gptMailPrefix?: string
    gptMailPrivatePassword?: string
    password?: string
    fullName?: string
    taskId?: string
  }) => Promise<{ success: boolean; result?: unknown; error?: string }>

  registrationManualPhase1: (config: {
    proxy?: string
    password?: string
    fullName?: string
  }) => Promise<{ success: boolean; error?: string }>

  registrationManualPhase2: (
    email: string,
    fullName?: string
  ) => Promise<{ success: boolean; error?: string }>

  registrationManualPhase3: (
    otp: string
  ) => Promise<{ success: boolean; result?: unknown; error?: string }>

  registrationCancel: () => Promise<{ success: boolean }>

  registrationStatus: () => Promise<{ inProgress: boolean }>

  protonOpenLogin: (
    proxy?: string
  ) => Promise<{ success: boolean; loggedIn: boolean; error?: string }>

  protonLoginStatus: (proxy?: string) => Promise<{ loggedIn: boolean }>

  protonClose: () => Promise<{ success: boolean }>

  // 代理池验活
  proxyPoolValidate: (params: {
    url: string
    testUrl?: string
    timeoutMs?: number
    upstreamProxy?: string
  }) => Promise<{ success: boolean; latencyMs?: number; externalIp?: string; error?: string }>

  proxyPoolDiagnoseChain: (params: {
    targetUrl: string
    upstreamProxy: string
    testHost?: string
    testPort?: number
  }) => Promise<{
    success: boolean
    error?: string
    diagnose?: {
      upstreamReachable: boolean
      upstreamError?: string
      upstreamRtMs?: number
      targetReachable: boolean
      targetError?: string
      targetRtMs?: number
      targetStatus?: number
      targetStatusText?: string
      targetBodySnippet?: string
      endToEndOk?: boolean
      endToEndError?: string
      endToEndRtMs?: number
    }
  }>

  /** 重启主进程代理池定时验活调度器（改了 autoValidateIntervalMin 后需调用） */
  proxyPoolRestartScheduler: () => Promise<{ success: boolean; running?: boolean; error?: string }>

  /** 订阅主进程定时验活结果，返回取消订阅函数 */
  onProxyPoolValidated: (callback: (payload: { entries: ProxyEntry[] }) => void) => () => void

  // 诊断：通用 HTTP 探测
  diagnoseHttpProbe: (params: {
    url: string
    method?: 'GET' | 'HEAD'
    timeoutMs?: number
  }) => Promise<{
    success: boolean
    latencyMs?: number
    status?: number
    error?: string
  }>

  // 账号-代理绑定（反代分桶）
  accountSetProxyBinding: (
    accountId: string,
    proxyUrl: string | undefined
  ) => Promise<{ success: boolean }>
  accountSetEndpointConfig: (
    accountId: string,
    config: {
      preferredEndpoint?: 'codewhisperer' | 'amazonq' | 'amazonq-cli'
      endpointFallbackAfterFailures?: number
    }
  ) => Promise<{ success: boolean }>

  // 一键诊断
  diagnoseRun: (params: {
    proxyUrl?: string
    targets: Array<{
      id: string
      label: string
      url: string
      timeoutMs?: number
      expectStatus?: number[]
    }>
  }) => Promise<{
    results: Array<{
      id: string
      label: string
      url: string
      success: boolean
      httpStatus?: number
      latencyMs?: number
      error?: string
    }>
  }>

  // 账号测活：指定账号 + 模型走反代逻辑发测试消息
  diagnoseAccountLiveness: (params: {
    account: {
      id?: string
      email?: string
      accessToken?: string
      refreshToken?: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: 'social' | 'idc' | 'IdC' | 'external_idp'
      provider?: string
      profileArn?: string
      expiresAt?: number
      credentialRevision?: string
      proxyUrl?: string
    }
    model?: string
    message?: string
    timeoutMs?: number
  }) => Promise<{
    success: boolean
    latencyMs: number
    model?: string
    content?: string
    usage?: { inputTokens: number; outputTokens: number; credits: number }
    credentials?: {
      accessToken: string
      refreshToken?: string
      expiresAt?: number
      credentialRevision?: string
    }
    error?: string
  }>

  onRegistrationLog: (callback: (msg: string) => void) => () => void

  onRegistrationStep: (
    callback: (data: {
      taskId?: string
      event: {
        name:
          | 'init'
          | 'proxy-chain-ready'
          | 'tls-ready'
          | 'exit-ip'
          | 'oidc'
          | 'device'
          | 'email-created'
          | 'portal'
          | 'workflow-init'
          | 'submit-email'
          | 'signup'
          | 'send-otp'
          | 'waiting-otp'
          | 'otp-received'
          | 'create-identity'
          | 'set-password'
          | 'sso-workflow'
          | 'sso-token'
          | 'verify-alive'
          | 'done'
        ts: number
        email?: string
        exitIp?: string
        extra?: Record<string, unknown>
      }
    }) => void
  ) => () => void

  onRegistrationComplete: (
    callback: (result: {
      status: 'success' | 'failed'
      email: string
      password?: string
      error?: string
      clientId?: string
      clientSecret?: string
      refreshToken?: string
      accessToken?: string
      region?: string
      provider?: string
      verify?: Record<string, unknown>
    }) => void
  ) => () => void

  // ===== AWS Identity Center 席位管理 =====

  /** 查询凭据保存状态（不回传密钥本体，仅回传尾 4 位用于识别） */
  idcCredentialStatus: () => Promise<
    IdcIpcResult<{
      encryptionAvailable: boolean
      hasSaved: boolean
      source?: 'manual' | 'profile'
      region?: string
      profile?: string
      accessKeyIdTail?: string
    }>
  >

  /** 保存凭据配置。系统加密不可用时会失败（拒绝明文落盘 AK/SK） */
  idcSaveCredentials: (config: IdcCredentialConfig) => Promise<IdcIpcResult<{ saved: boolean }>>

  idcClearCredentials: () => Promise<IdcIpcResult<{ cleared: boolean }>>

  /** 列出本机 ~/.aws 下可用 profile */
  idcListProfiles: () => Promise<IdcIpcResult<string[]>>

  /** 连通性自检：验证签名可用、能读到 Identity Center 实例 */
  idcTestConnection: (config: IdcCredentialConfig) => Promise<
    IdcIpcResult<{
      identityStoreId: string
      region: string
      seatCount: number
      unsubscribedCount: number
    }>
  >

  /** 生成席位预览（不触碰 AWS 写操作） */
  idcPlanSeats: (input: {
    credentials: IdcCredentialConfig
    quotas: { tier: string; count: number }[]
    domains: string
    avoidExisting?: boolean
  }) => Promise<IdcIpcResult<{ seats: IdcPlannedSeat[]; maxPerPlan: number }>>

  /** 执行开通：建号 →（可选）发密码邮件 → 挂档位 */
  idcProvision: (input: {
    credentials: IdcCredentialConfig
    seats: IdcPlannedSeat[]
    sendPasswordEmail: boolean
    concurrency?: number
  }) => Promise<IdcIpcResult<IdcProvisionSummary>>

  idcCancelProvision: () => Promise<IdcIpcResult<{ cancelled: boolean }>>

  /** 拉取现有席位全景 */
  idcInventory: (config: IdcCredentialConfig) => Promise<IdcIpcResult<IdcSeatInventory>>

  idcChangeTier: (input: {
    credentials: IdcCredentialConfig
    targets: IdcBatchTarget[]
    tier: string
    concurrency?: number
  }) => Promise<IdcIpcResult<IdcBatchOpResult[]>>

  idcUnsubscribe: (input: {
    credentials: IdcCredentialConfig
    targets: IdcBatchTarget[]
    concurrency?: number
  }) => Promise<IdcIpcResult<IdcBatchOpResult[]>>

  /** 删除用户（不可逆）。会先尝试取消订阅再删号 */
  idcDeleteSeats: (input: {
    credentials: IdcCredentialConfig
    targets: IdcBatchTarget[]
    concurrency?: number
  }) => Promise<IdcIpcResult<IdcBatchOpResult[]>>

  /** 重发密码设置邮件（链接 1 小时过期） */
  idcResendPassword: (input: {
    credentials: IdcCredentialConfig
    targets: IdcBatchTarget[]
    concurrency?: number
  }) => Promise<IdcIpcResult<IdcBatchOpResult[]>>

  /** 监听席位操作进度 */
  onIdcProgress: (callback: (event: IdcProgressEvent) => void) => () => void

  // ============ 自动车凭证同步 ============

  /** 读取同步状态（含脱敏快照与当前配置） */
  convoyStatus: () => Promise<
    IdcIpcResult<ConvoySyncStatus & { encryptionAvailable: boolean; config: ConvoySyncConfig }>
  >

  /** 保存配置与登录 Key。convoyKey 省略表示保留原值，空串表示清除 */
  convoySaveConfig: (input: {
    config: Partial<ConvoySyncConfig>
    convoyKey?: string
  }) => Promise<IdcIpcResult<{ config: ConvoySyncConfig; hasConvoyKey: boolean }>>

  /** 清除配置与登录 Key */
  convoyClearConfig: () => Promise<IdcIpcResult<{ cleared: boolean }>>

  /** 立即触发一轮同步。注意可能产生真实计费 */
  convoySyncNow: () => Promise<IdcIpcResult<{ synced: boolean }>>

  /** 覆盖手填上游 Key 列表，主进程逐条探测区域后注入反代池 */
  convoySetManualKeys: (keys: ManualConvoyKey[]) => Promise<IdcIpcResult<ManualConvoyKeyResult[]>>

  /** 清空手填上游 Key */
  convoyClearManualKeys: () => Promise<IdcIpcResult<{ cleared: boolean }>>

  /** 监听同步状态变化 */
  onConvoyStatus: (callback: (status: ConvoySyncStatus) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: KiroApi
  }
}
