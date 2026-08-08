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
  KskAutomationStatusEvent,
  KskAutomationTaskInput,
  KskAutomationTaskView
} from '../shared/kskAutomation'
import type {
  KskHunterConfig,
  KskHunterLinkInput,
  KskHunterSecretInput,
  KskHunterSnapshot,
  KskHunterStatusEvent
} from '../shared/kskHunter'
import type { LocalAdminPushCandidate, LocalAdminPushResult } from '../shared/localAdminPush'
import type {
  LocalAdminStatsSnapshot,
  LocalAdminUsageRefreshSummary
} from '../shared/localAdminStats'

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

/** Kiro IDE 自己 refresh 完写回 token 文件、被检测到后通知 renderer 的 payload */
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
  closeIncognitoBrowser: () => void
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

  // ============ 应用日志 ============

  // 获取应用运行日志
  appLogsGet: (
    count?: number
  ) => Promise<
    Array<{ timestamp: string; level: string; category: string; message: string; data?: unknown }>
  >

  // 清除应用运行日志
  appLogsClear: () => Promise<{ success: boolean }>

  // 获取应用运行日志数量
  appLogsCount: () => Promise<number>

  notifyLocal: (
    kind: 'registration-risk-paused' | 'registration-batch-completed',
    input?: { batchId?: string }
  ) => Promise<void>
  onLocalNotificationNavigate: (
    callback: (page: 'accounts' | 'register' | 'hunter') => void
  ) => () => void

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

  // ============ Usage API 类型设置 ============

  // 获取 Usage API 类型
  getUsageApiType: () => Promise<'rest' | 'cbor'>

  // 设置 Usage API 类型
  setUsageApiType: (type: 'rest' | 'cbor') => Promise<{ success: boolean; type: string }>

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

  // 账号测活：给指定账号 + 模型发测试消息
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
      credentialKind?: 'oauth' | 'kiro_api_key'
      kiroApiKey?: string
      preferredEndpoint?: 'codewhisperer' | 'amazonq' | 'amazonq-cli'
      endpointFallbackOrder?: Array<'codewhisperer' | 'amazonq' | 'amazonq-cli'>
      endpointFallbackAfterFailures?: number
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

  kskAutomationList: () => Promise<IdcIpcResult<KskAutomationTaskView[]>>
  kskAutomationCreate: (
    input: KskAutomationTaskInput
  ) => Promise<IdcIpcResult<KskAutomationTaskView[]>>
  kskAutomationUpdate: (
    taskId: string,
    input: KskAutomationTaskInput
  ) => Promise<IdcIpcResult<KskAutomationTaskView[]>>
  kskAutomationSetEnabled: (
    taskId: string,
    enabled: boolean
  ) => Promise<IdcIpcResult<KskAutomationTaskView[]>>
  kskAutomationDelete: (taskId: string) => Promise<IdcIpcResult<KskAutomationTaskView[]>>
  kskAutomationSyncNow: (taskId: string) => Promise<IdcIpcResult<KskAutomationStatusEvent>>
  kskAutomationSyncLocalAdminNow: (
    taskId: string
  ) => Promise<IdcIpcResult<KskAutomationStatusEvent>>
  kskAutomationPushAccountToLocalAdmin: (
    candidate: LocalAdminPushCandidate
  ) => Promise<IdcIpcResult<LocalAdminPushResult>>
  onKskAutomationStatus: (callback: (event: KskAutomationStatusEvent) => void) => () => void
  onKskAutomationAccountsChanged: (callback: () => void) => () => void
  kskHunterSnapshot: () => Promise<IdcIpcResult<KskHunterSnapshot>>
  kskHunterUpdateConfig: (
    config: Partial<KskHunterConfig>,
    secrets?: KskHunterSecretInput
  ) => Promise<IdcIpcResult<KskHunterSnapshot>>
  kskHunterCreateLink: (input: KskHunterLinkInput) => Promise<IdcIpcResult<KskHunterSnapshot>>
  kskHunterUpdateLink: (
    linkId: string,
    input: KskHunterLinkInput
  ) => Promise<IdcIpcResult<KskHunterSnapshot>>
  kskHunterSetLinkEnabled: (
    linkId: string,
    enabled: boolean
  ) => Promise<IdcIpcResult<KskHunterSnapshot>>
  kskHunterDeleteLink: (linkId: string) => Promise<IdcIpcResult<KskHunterSnapshot>>
  kskHunterRunNow: () => Promise<IdcIpcResult<KskHunterSnapshot>>
  kskHunterRetryDelivery: (deliveryId: string) => Promise<IdcIpcResult<KskHunterSnapshot>>
  kskHunterDeleteDelivery: (deliveryId: string) => Promise<IdcIpcResult<KskHunterSnapshot>>
  onKskHunterStatus: (callback: (event: KskHunterStatusEvent) => void) => () => void
  localAdminStatsSnapshot: () => Promise<IdcIpcResult<LocalAdminStatsSnapshot>>
  localAdminStatsRefreshNow: () => Promise<IdcIpcResult<LocalAdminStatsSnapshot>>
  localAdminStatsRefreshUsage: () => Promise<IdcIpcResult<LocalAdminUsageRefreshSummary>>
  localAdminStatsClearSamples: () => Promise<IdcIpcResult<LocalAdminStatsSnapshot>>
  localAdminStatsClearBuckets: () => Promise<IdcIpcResult<LocalAdminStatsSnapshot>>
  onLocalAdminStatsChanged: (callback: (snapshot: LocalAdminStatsSnapshot) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: KiroApi
  }
}
