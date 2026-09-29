import { ElectronAPI } from '@electron-toolkit/preload'
import type { IpcResult } from '../shared/ipcResult'
import type {
  KskAutomationStatusEvent,
  KskAutomationTaskInput,
  KskAutomationTaskView
} from '../shared/kskAutomation'
import type { LocalAdminPushCandidate, LocalAdminPushResult } from '../shared/localAdminPush'
import type {
  CursorAccount,
  CursorAutoRefreshSettings,
  CursorCockpitImportSummary,
  CursorCredentialImportSummary,
  CursorInjectOptions,
  CursorInjectResult,
  CursorOAuthStartResult,
  CursorRefreshAllSummary
} from '../shared/cursorAccounts'
import type {
  GrokAccountView,
  GrokRelayInstallProgress,
  GrokRelayInstallResult,
  GrokRelayStatus,
  GrokRemoveResult,
  GrokSwitchResult
} from '../shared/grokAccounts'

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
}

interface RefreshResult {
  success: boolean
  /** 托管账号只返回操作结果，不返回 OAuth 凭据。 */
  adminManaged?: boolean
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

/** 切换 Kiro CLI 账号的结果；成功时带切号前刷新得到的新凭据 */
interface SwitchAccountCliResult {
  success: boolean
  data?: {
    /** 写入的 kiro-cli 数据库路径 */
    dbPath: string
    accessToken: string
    refreshToken: string
    expiresAt: number
    credentialRevision?: string
  }
  error?: string
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
  accountDbDelete: (
    ids: string[]
  ) => Promise<{ success: boolean; failed: Array<{ id: string; reason: string }> }>
  accountDbSetInPool: (
    accountId: string,
    inPool: boolean
  ) => Promise<{ success: boolean; error?: string }>
  accountDbAccountsWithSecrets: (ids: string[]) => Promise<Record<string, unknown> | null>
  accountDbStatus: () => Promise<{
    enabled: boolean
    dbPath?: string
    databaseId?: string
    kiroRsState?: string
    kiroRsDetail?: string
    pending?: number
    error?: string
  }>
  onAccountDbChanged: (callback: () => void) => () => void
  onKiroCliNeedsReauth: (callback: (payload: { accountId: string }) => void) => () => void
  saveAccounts: (data: AccountData) => Promise<void>
  refreshAccountToken: (account: unknown) => Promise<RefreshResult>
  switchAccountCli: (accountId: string) => Promise<SwitchAccountCliResult>
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
    syncInfo?: boolean,
    refreshManaged?: boolean
  ) => Promise<{ success: boolean; completed: number; successCount: number; failedCount: number }>
  onBackgroundRefreshProgress: (
    callback: (data: { completed: number; total: number; success: number; failed: number }) => void
  ) => () => void
  onBackgroundRefreshResult: (
    callback: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void
  ) => () => void

  // 已交给本机反代托管的账号 id 集合
  getAdminManagedIds: () => Promise<string[]>
  onAdminManagedChanged: (callback: (ids: string[]) => void) => () => void

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

  onLocalNotificationNavigate: (callback: (page: 'accounts') => void) => () => void

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

  kskAutomationList: () => Promise<IpcResult<KskAutomationTaskView[]>>
  kskAutomationCreate: (
    input: KskAutomationTaskInput
  ) => Promise<IpcResult<KskAutomationTaskView[]>>
  kskAutomationUpdate: (
    taskId: string,
    input: KskAutomationTaskInput
  ) => Promise<IpcResult<KskAutomationTaskView[]>>
  kskAutomationSetEnabled: (
    taskId: string,
    enabled: boolean
  ) => Promise<IpcResult<KskAutomationTaskView[]>>
  kskAutomationDelete: (taskId: string) => Promise<IpcResult<KskAutomationTaskView[]>>
  kskAutomationSyncNow: (taskId: string) => Promise<IpcResult<KskAutomationStatusEvent>>
  kskAutomationSyncLocalAdminNow: (taskId: string) => Promise<IpcResult<KskAutomationStatusEvent>>
  kskAutomationCleanupNow: (taskId: string) => Promise<IpcResult<KskAutomationStatusEvent>>
  kskAutomationPushAccountToLocalAdmin: (
    candidate: LocalAdminPushCandidate
  ) => Promise<IpcResult<LocalAdminPushResult>>
  onKskAutomationStatus: (callback: (event: KskAutomationStatusEvent) => void) => () => void
  onKskAutomationAccountsChanged: (callback: () => void) => () => void
  cursorAccountsList: () => Promise<IpcResult<CursorAccount[]>>
  cursorAccountsCurrentId: () => Promise<IpcResult<string | null>>
  cursorAccountsRemove: (ids: string[]) => Promise<IpcResult<void>>
  cursorAccountsImportJson: (json: string, tags?: string[]) => Promise<IpcResult<CursorAccount[]>>
  cursorAccountsImportLocal: (tags?: string[]) => Promise<IpcResult<CursorAccount>>
  cursorAccountsImportCockpit: (tags?: string[]) => Promise<IpcResult<CursorCockpitImportSummary>>
  cursorAccountsAddToken: (
    input: string,
    tags?: string[]
  ) => Promise<IpcResult<CursorCredentialImportSummary>>
  cursorAccountsExport: (ids: string[]) => Promise<IpcResult<string>>
  cursorAccountsRefresh: (id: string) => Promise<IpcResult<CursorAccount>>
  cursorAccountsRefreshAll: () => Promise<IpcResult<CursorRefreshAllSummary>>
  cursorAccountsUpdateTags: (id: string, tags: string[]) => Promise<IpcResult<CursorAccount>>
  cursorAccountsInject: (
    id: string,
    options?: CursorInjectOptions
  ) => Promise<IpcResult<CursorInjectResult>>
  cursorAccountsOAuthStart: () => Promise<IpcResult<CursorOAuthStartResult>>
  cursorAccountsOAuthComplete: (
    loginId: string,
    tags?: string[]
  ) => Promise<IpcResult<CursorAccount>>
  cursorAccountsOAuthCancel: (loginId?: string) => Promise<IpcResult<null>>
  cursorAccountsRevealStore: () => Promise<IpcResult<string>>
  cursorAccountsGetSettings: () => Promise<IpcResult<CursorAutoRefreshSettings>>
  cursorAccountsUpdateSettings: (
    patch: Partial<CursorAutoRefreshSettings>
  ) => Promise<IpcResult<CursorAutoRefreshSettings>>
  onCursorAccountsChanged: (callback: () => void) => () => void
  grokAccountsList: () => Promise<IpcResult<GrokAccountView[]>>
  grokAccountsCurrentScope: () => Promise<IpcResult<string | null>>
  grokAccountsSwitch: (
    scope: string,
    options?: { closeGrok?: boolean }
  ) => Promise<IpcResult<GrokSwitchResult>>
  grokAccountsRemove: (
    scope: string,
    options?: { closeGrok?: boolean }
  ) => Promise<IpcResult<GrokRemoveResult>>
  grokAccountsSyncRelay: (scope: string) => Promise<IpcResult<GrokRelayStatus>>
  grokAccountsRelayStatus: () => Promise<IpcResult<GrokRelayStatus>>
  grokAccountsEnsureRelayRoute: (scope: string) => Promise<IpcResult<GrokRelayInstallResult>>
  onGrokRelayInstallProgress: (callback: (progress: GrokRelayInstallProgress) => void) => () => void
  onGrokAccountsChanged: (callback: () => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: KiroApi
  }
}
