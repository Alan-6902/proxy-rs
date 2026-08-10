import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
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
import type { HunterReport } from '../shared/hunterReport'
import type { KskLedgerReport, KskLedgerSort } from '../shared/kskLedger'
import type { LocalAdminPushCandidate, LocalAdminPushResult } from '../shared/localAdminPush'
import type {
  LocalAdminExhaustedCleanupSummary,
  LocalAdminStatsSnapshot,
  LocalAdminUsageRefreshSummary
} from '../shared/localAdminStats'

// Custom APIs for renderer
type UpstreamKiroCredentialInput =
  | string
  | {
      credentialKind?: 'oauth' | 'kiro_api_key'
      accessToken?: string
      kiroApiKey?: string
    }

const api = {
  // 打开外部链接
  openExternal: (url: string): void => {
    ipcRenderer.send('open-external', url)
  },
  openIncognitoBrowser: (url: string): void => {
    ipcRenderer.send('open-incognito-browser', url)
  },
  closeIncognitoBrowser: (): void => {
    ipcRenderer.send('close-incognito-browser')
  },

  // 获取应用版本
  getAppVersion: (): Promise<string> => {
    return ipcRenderer.invoke('get-app-version')
  },

  // 监听 OAuth 回调
  onAuthCallback: (callback: (data: { code: string; state: string }) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { code: string; state: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('auth-callback', handler)
    return () => {
      ipcRenderer.removeListener('auth-callback', handler)
    }
  },

  // 账号管理 - 加载账号数据
  loadAccounts: (): Promise<unknown> => {
    return ipcRenderer.invoke('load-accounts')
  },

  // 账号管理 - 保存账号数据
  saveAccounts: (data: unknown): Promise<void> => {
    return ipcRenderer.invoke('save-accounts', data)
  },

  // 账号管理 - 刷新 Token
  refreshAccountToken: (account: unknown): Promise<unknown> => {
    return ipcRenderer.invoke('refresh-account-token', account)
  },

  // 账号管理 - 检查账号状态
  checkAccountStatus: (account: unknown): Promise<unknown> => {
    return ipcRenderer.invoke('check-account-status', account)
  },

  // 后台批量刷新账号（在主进程执行，不阻塞 UI）
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
  ): Promise<{
    success: boolean
    completed: number
    successCount: number
    failedCount: number
  }> => {
    return ipcRenderer.invoke('background-batch-refresh', accounts, concurrency, syncInfo)
  },

  // 监听后台刷新进度
  onBackgroundRefreshProgress: (
    callback: (data: { completed: number; total: number; success: number; failed: number }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { completed: number; total: number; success: number; failed: number }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('background-refresh-progress', handler)
    return () => {
      ipcRenderer.removeListener('background-refresh-progress', handler)
    }
  },

  // 监听后台刷新结果（单个账号）
  onBackgroundRefreshResult: (
    callback: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; success: boolean; data?: unknown; error?: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('background-refresh-result', handler)
    return () => {
      ipcRenderer.removeListener('background-refresh-result', handler)
    }
  },

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
  ): Promise<{
    success: boolean
    completed: number
    successCount: number
    failedCount: number
  }> => {
    return ipcRenderer.invoke('background-batch-check', accounts, concurrency)
  },

  // 监听后台检查进度
  onBackgroundCheckProgress: (
    callback: (data: { completed: number; total: number; success: number; failed: number }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { completed: number; total: number; success: number; failed: number }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('background-check-progress', handler)
    return () => {
      ipcRenderer.removeListener('background-check-progress', handler)
    }
  },

  // 监听后台检查结果（单个账号）
  onBackgroundCheckResult: (
    callback: (data: { id: string; success: boolean; data?: unknown; error?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { id: string; success: boolean; data?: unknown; error?: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('background-check-result', handler)
    return () => {
      ipcRenderer.removeListener('background-check-result', handler)
    }
  },

  // 文件操作 - 导出到文件
  exportToFile: (data: string, filename: string): Promise<boolean> => {
    return ipcRenderer.invoke('export-to-file', data, filename)
  },

  // 文件操作 - 从文件导入
  importFromFile: (): Promise<string | null> => {
    return ipcRenderer.invoke('import-from-file')
  },

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
  }): Promise<{
    success: boolean
    data?: {
      email: string
      userId: string
      accessToken: string
      refreshToken: string
      expiresIn?: number
      subscriptionType: string
      subscriptionTitle: string
      usage: { current: number; limit: number }
      daysRemaining?: number
      expiresAt?: number
    }
    error?: string
  }> => {
    return ipcRenderer.invoke('verify-account-credentials', credentials)
  },

  // 从 AWS SSO Token (x-amz-sso_authn) 导入账号
  importFromSsoToken: (
    bearerToken: string,
    region?: string
  ): Promise<{
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
    }
    error?: { message: string }
  }> => {
    return ipcRenderer.invoke('import-from-sso-token', bearerToken, region || 'us-east-1')
  },

  // ============ 手动登录 API ============

  // 启动 Builder ID 手动登录
  startBuilderIdLogin: (
    region?: string
  ): Promise<{
    success: boolean
    userCode?: string
    verificationUri?: string
    expiresIn?: number
    interval?: number
    error?: string
  }> => {
    return ipcRenderer.invoke('start-builder-id-login', region || 'us-east-1')
  },

  // 轮询 Builder ID 授权状态
  pollBuilderIdAuth: (
    region?: string
  ): Promise<{
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
  }> => {
    return ipcRenderer.invoke('poll-builder-id-auth', region || 'us-east-1')
  },

  // 取消 Builder ID 登录
  cancelBuilderIdLogin: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cancel-builder-id-login')
  },

  // 启动 IAM Identity Center SSO 登录 (Authorization Code flow)
  startIamSsoLogin: (
    startUrl: string,
    region?: string
  ): Promise<{
    success: boolean
    authorizeUrl?: string
    expiresIn?: number
    error?: string
  }> => {
    return ipcRenderer.invoke('start-iam-sso-login', startUrl, region || 'us-east-1')
  },

  // 轮询 IAM SSO 授权状态
  pollIamSsoAuth: (
    region?: string
  ): Promise<{
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
  }> => {
    return ipcRenderer.invoke('poll-iam-sso-auth', region || 'us-east-1')
  },

  // 完成 IAM SSO 登录 (用授权码换取 token)
  completeIamSsoLogin: (
    code: string
  ): Promise<{
    success: boolean
    completed?: boolean
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  }> => {
    return ipcRenderer.invoke('complete-iam-sso-login', code)
  },

  // 取消 IAM SSO 登录
  cancelIamSsoLogin: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cancel-iam-sso-login')
  },

  // 启动 Social Auth 登录 (Google/GitHub)
  startSocialLogin: (
    provider: 'Google' | 'Github'
  ): Promise<{
    success: boolean
    loginUrl?: string
    state?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('start-social-login', provider)
  },

  // 交换 Social Auth token
  exchangeSocialToken: (
    code: string,
    state: string
  ): Promise<{
    success: boolean
    accessToken?: string
    refreshToken?: string
    profileArn?: string
    expiresIn?: number
    authMethod?: string
    provider?: string
    error?: string
  }> => {
    return ipcRenderer.invoke('exchange-social-token', code, state)
  },

  // 取消 Social Auth 登录
  cancelSocialLogin: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('cancel-social-login')
  },

  // 监听 Social Auth 回调
  onSocialAuthCallback: (
    callback: (data: { code?: string; state?: string; error?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { code?: string; state?: string; error?: string }
    ): void => {
      callback(data)
    }
    ipcRenderer.on('social-auth-callback', handler)
    return () => {
      ipcRenderer.removeListener('social-auth-callback', handler)
    }
  },

  // 代理设置
  setProxy: (
    enabled: boolean,
    url: string
  ): Promise<{ success: boolean; error?: string; normalizedUrl?: string }> => {
    return ipcRenderer.invoke('set-proxy', enabled, url)
  },

  // 获取当前账号可用模型（诊断功能使用）
  getKiroAvailableModels: (): Promise<{
    models: Array<{ id: string; name: string; description: string }>
    error?: string
  }> => {
    return ipcRenderer.invoke('get-kiro-available-models')
  },

  // ============ 应用日志 ============

  // 获取应用运行日志
  appLogsGet: (
    count?: number
  ): Promise<
    Array<{ timestamp: string; level: string; category: string; message: string; data?: unknown }>
  > => {
    return ipcRenderer.invoke('app-logs-get', count)
  },

  // 清除应用运行日志
  appLogsClear: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('app-logs-clear')
  },

  // 获取应用运行日志数量
  appLogsCount: (): Promise<number> => {
    return ipcRenderer.invoke('app-logs-count')
  },

  notifyLocal: (
    kind: 'registration-risk-paused' | 'registration-batch-completed',
    input?: { batchId?: string }
  ): Promise<void> => {
    return ipcRenderer.invoke('local-notification', kind, input)
  },

  onLocalNotificationNavigate: (
    callback: (page: 'accounts' | 'register' | 'hunter') => void
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      page: 'accounts' | 'register' | 'hunter'
    ): void => callback(page)
    ipcRenderer.on('local-notification-navigate', handler)
    return () => ipcRenderer.off('local-notification-navigate', handler)
  },

  // 获取账户可用模型列表
  accountGetModels: (
    credential: UpstreamKiroCredentialInput,
    region?: string,
    profileArn?: string,
    provider?: string,
    authMethod?: string,
    accountId?: string
  ): Promise<{
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
  }> => {
    return ipcRenderer.invoke(
      'account-get-models',
      credential,
      region,
      profileArn,
      provider,
      authMethod,
      accountId
    )
  },

  // 获取可用订阅列表
  accountGetSubscriptions: (
    credential: UpstreamKiroCredentialInput,
    region?: string,
    profileArn?: string,
    provider?: string,
    authMethod?: string,
    accountId?: string
  ): Promise<{
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
  }> => {
    return ipcRenderer.invoke(
      'account-get-subscriptions',
      credential,
      region,
      profileArn,
      provider,
      authMethod,
      accountId
    )
  },

  // 获取订阅管理/支付链接
  accountGetSubscriptionUrl: (
    credential: UpstreamKiroCredentialInput,
    subscriptionType?: string,
    region?: string,
    profileArn?: string,
    provider?: string,
    authMethod?: string,
    accountId?: string
  ): Promise<{ success: boolean; error?: string; url?: string; status?: string }> => {
    return ipcRenderer.invoke(
      'account-get-subscription-url',
      credential,
      subscriptionType,
      region,
      profileArn,
      provider,
      authMethod,
      accountId
    )
  },

  // 在新窗口打开订阅链接
  openSubscriptionWindow: (url: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('open-subscription-window', url)
  },

  // ============ Usage API 类型设置 ============

  // 获取 Usage API 类型
  getUsageApiType: (): Promise<'rest' | 'cbor'> => {
    return ipcRenderer.invoke('get-usage-api-type')
  },

  // 设置 Usage API 类型
  setUsageApiType: (type: 'rest' | 'cbor'): Promise<{ success: boolean; type: string }> => {
    return ipcRenderer.invoke('set-usage-api-type', type)
  },

  // ============ 自定义 titlebar API ============
  window: {
    minimize: (): void => ipcRenderer.send('window-minimize'),
    maximizeToggle: (): void => ipcRenderer.send('window-maximize-toggle'),
    close: (): void => ipcRenderer.send('window-close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window-is-maximized'),
    getPlatform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke('window-get-platform'),
    onMaximizeChange: (callback: (isMaximized: boolean) => void): (() => void) => {
      const handler = (_event: any, isMaximized: boolean): void => callback(isMaximized)
      ipcRenderer.on('window-maximize-changed', handler)
      return () => ipcRenderer.removeListener('window-maximize-changed', handler)
    }
  },

  // ============ 托盘相关 API ============

  // 获取显示主窗口快捷键
  getShowWindowShortcut: (): Promise<string> => ipcRenderer.invoke('get-show-window-shortcut'),

  // 设置显示主窗口快捷键
  setShowWindowShortcut: (shortcut: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('set-show-window-shortcut', shortcut),

  // 获取托盘设置
  getTraySettings: (): Promise<{
    enabled: boolean
    closeAction: 'ask' | 'minimize' | 'quit'
    showNotifications: boolean
    minimizeOnStart: boolean
  }> => {
    return ipcRenderer.invoke('get-tray-settings')
  },

  // 保存托盘设置
  saveTraySettings: (settings: {
    enabled?: boolean
    closeAction?: 'ask' | 'minimize' | 'quit'
    showNotifications?: boolean
    minimizeOnStart?: boolean
  }): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('save-tray-settings', settings)
  },

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
  ): void => {
    ipcRenderer.send('update-tray-account', account)
  },

  // 更新托盘账户列表
  updateTrayAccountList: (
    accounts: {
      id: string
      email: string
      idp: string
      status: string
    }[]
  ): void => {
    ipcRenderer.send('update-tray-account-list', accounts)
  },

  // 刷新托盘菜单
  refreshTrayMenu: (): void => {
    ipcRenderer.send('refresh-tray-menu')
  },

  // 更新托盘语言
  updateTrayLanguage: (language: 'en' | 'zh'): void => {
    ipcRenderer.send('update-tray-language', language)
  },

  // 监听托盘刷新账户事件
  onTrayRefreshAccount: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('tray-refresh-account', handler)
    return () => {
      ipcRenderer.removeListener('tray-refresh-account', handler)
    }
  },

  // 监听托盘切换账户事件
  onTraySwitchAccount: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('tray-switch-account', handler)
    return () => {
      ipcRenderer.removeListener('tray-switch-account', handler)
    }
  },

  // 监听显示关闭确认对话框事件
  onShowCloseConfirmDialog: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback()
    }
    ipcRenderer.on('show-close-confirm-dialog', handler)
    return () => {
      ipcRenderer.removeListener('show-close-confirm-dialog', handler)
    }
  },

  // 发送关闭确认对话框响应
  sendCloseConfirmResponse: (
    action: 'minimize' | 'quit' | 'cancel',
    rememberChoice: boolean
  ): void => {
    ipcRenderer.send('close-confirm-response', action, rememberChoice)
  },

  // ============ 注册功能 API ============

  // 启动自动注册
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
  }): Promise<{ success: boolean; result?: unknown; error?: string }> => {
    return ipcRenderer.invoke('registration-start-auto', config)
  },

  // 手动模式 Phase1: 初始化 OIDC + 设备授权
  registrationManualPhase1: (config: {
    proxy?: string
    password?: string
    fullName?: string
  }): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('registration-manual-phase1', config)
  },

  // 手动模式 Phase2: 设置邮箱 -> 发送 OTP
  registrationManualPhase2: (
    email: string,
    fullName?: string
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('registration-manual-phase2', email, fullName)
  },

  // 手动模式 Phase3: 验证码 -> 完成
  registrationManualPhase3: (
    otp: string
  ): Promise<{ success: boolean; result?: unknown; error?: string }> => {
    return ipcRenderer.invoke('registration-manual-phase3', otp)
  },

  // 取消注册
  registrationCancel: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('registration-cancel')
  },

  // ============ 代理池 API ============
  /**
   * 验活单个代理：使用 undici ProxyAgent 通过指定代理 URL 请求测试 URL
   * @returns latencyMs / externalIp（如果测试 URL 返回 IP）
   */
  proxyPoolValidate: (params: {
    url: string
    testUrl?: string
    timeoutMs?: number
    upstreamProxy?: string
  }): Promise<{ success: boolean; latencyMs?: number; externalIp?: string; error?: string }> => {
    return ipcRenderer.invoke('proxy-pool:validate', params)
  },

  /** 代理链分阶段诊断（用于定位"上游/目标/端到端"哪一层失败） */
  proxyPoolDiagnoseChain: (params: {
    targetUrl: string
    upstreamProxy: string
    testHost?: string
    testPort?: number
  }): Promise<{
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
  }> => {
    return ipcRenderer.invoke('proxy-pool:diagnose-chain', params)
  },

  /**
   * 重启主进程的代理池定时验活调度器。
   * 改了 autoValidateIntervalMin 后必须调用，否则新间隔要等下次应用启动才生效。
   */
  proxyPoolRestartScheduler: (): Promise<{
    success: boolean
    running?: boolean
    error?: string
  }> => {
    return ipcRenderer.invoke('proxy-pool:restart-scheduler')
  },

  /** 订阅主进程定时验活的结果，用于刷新 UI */
  onProxyPoolValidated: (callback: (payload: { entries: ProxyEntry[] }) => void): (() => void) => {
    const listener = (_e: unknown, payload: { entries: ProxyEntry[] }): void => callback(payload)
    ipcRenderer.on('proxy-pool-validated', listener)
    return () => ipcRenderer.removeListener('proxy-pool-validated', listener)
  },

  // ============ 诊断 API ============
  /** 测试一个 URL 的连通性（GET，5 秒超时，不带代理特殊处理由主进程默认逻辑） */
  diagnoseHttpProbe: (params: {
    url: string
    method?: 'GET' | 'HEAD'
    timeoutMs?: number
  }): Promise<{
    success: boolean
    latencyMs?: number
    status?: number
    error?: string
  }> => {
    return ipcRenderer.invoke('diagnose:http-probe', params)
  },

  // ============ 一键诊断 ============
  diagnoseRun: (params: {
    proxyUrl?: string
    targets: Array<{
      id: string
      label: string
      url: string
      timeoutMs?: number
      expectStatus?: number[]
    }>
  }): Promise<{
    results: Array<{
      id: string
      label: string
      url: string
      success: boolean
      httpStatus?: number
      latencyMs?: number
      error?: string
    }>
  }> => {
    return ipcRenderer.invoke('diagnose:run', params)
  },

  /**
   * 账号测活：给指定账号的指定模型发一条测试消息，验证是否正常返回
   */
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
  }): Promise<{
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
  }> => {
    return ipcRenderer.invoke('diagnose:account-liveness', params)
  },

  // 获取注册状态
  registrationStatus: (): Promise<{ inProgress: boolean }> => {
    return ipcRenderer.invoke('registration-status')
  },

  // Proton 邮箱：打开登录窗口（首次需手动登录，之后 session 持久化复用）
  protonOpenLogin: (
    proxy?: string
  ): Promise<{ success: boolean; loggedIn: boolean; error?: string }> => {
    return ipcRenderer.invoke('proton-open-login', proxy)
  },

  // Proton 邮箱：查询登录态（不弹窗）
  protonLoginStatus: (proxy?: string): Promise<{ loggedIn: boolean }> => {
    return ipcRenderer.invoke('proton-login-status', proxy)
  },

  // Proton 邮箱：关闭窗口（保留登录态）
  protonClose: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('proton-close')
  },

  // 监听注册日志
  onRegistrationLog: (callback: (msg: string) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: string | { message: string; taskId?: string }
    ): void => {
      const msg = typeof data === 'string' ? data : data.message
      callback(msg)
    }
    ipcRenderer.on('registration-log', handler)
    return () => {
      ipcRenderer.removeListener('registration-log', handler)
    }
  },

  /** 监听注册流程的实时 step 事件（用于批量任务的"当前步骤"可视化） */
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
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: Parameters<typeof callback>[0]
    ): void => {
      callback(data)
    }
    ipcRenderer.on('registration-step', handler)
    return () => {
      ipcRenderer.removeListener('registration-step', handler)
    }
  },

  // 监听注册完成
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
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      result: {
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
      }
    ): void => {
      callback(result)
    }
    ipcRenderer.on('registration-complete', handler)
    return () => {
      ipcRenderer.removeListener('registration-complete', handler)
    }
  },

  // ===== AWS Identity Center 席位管理 =====

  /** 查询凭据保存状态（不回传密钥本体，仅回传尾 4 位用于识别） */
  idcCredentialStatus: (): Promise<
    IdcIpcResult<{
      encryptionAvailable: boolean
      hasSaved: boolean
      source?: 'manual' | 'profile'
      region?: string
      profile?: string
      accessKeyIdTail?: string
    }>
  > => ipcRenderer.invoke('idc-credential-status'),

  /** 保存凭据配置。系统加密不可用时会失败（拒绝明文落盘 AK/SK） */
  idcSaveCredentials: (config: IdcCredentialConfig): Promise<IdcIpcResult<{ saved: boolean }>> =>
    ipcRenderer.invoke('idc-save-credentials', config),

  idcClearCredentials: (): Promise<IdcIpcResult<{ cleared: boolean }>> =>
    ipcRenderer.invoke('idc-clear-credentials'),

  /** 列出本机 ~/.aws 下可用 profile */
  idcListProfiles: (): Promise<IdcIpcResult<string[]>> => ipcRenderer.invoke('idc-list-profiles'),

  /** 连通性自检：验证签名可用、能读到 Identity Center 实例 */
  idcTestConnection: (
    config: IdcCredentialConfig
  ): Promise<
    IdcIpcResult<{
      identityStoreId: string
      region: string
      seatCount: number
      unsubscribedCount: number
    }>
  > => ipcRenderer.invoke('idc-test-connection', config),

  /** 生成席位预览（不触碰 AWS 写操作） */
  idcPlanSeats: (input: {
    credentials: IdcCredentialConfig
    quotas: { tier: string; count: number }[]
    domains: string
    avoidExisting?: boolean
  }): Promise<IdcIpcResult<{ seats: IdcPlannedSeat[]; maxPerPlan: number }>> =>
    ipcRenderer.invoke('idc-plan-seats', input),

  /** 执行开通：建号 →（可选）发密码邮件 → 挂档位 */
  idcProvision: (input: {
    credentials: IdcCredentialConfig
    seats: IdcPlannedSeat[]
    sendPasswordEmail: boolean
    concurrency?: number
  }): Promise<IdcIpcResult<IdcProvisionSummary>> => ipcRenderer.invoke('idc-provision', input),

  idcCancelProvision: (): Promise<IdcIpcResult<{ cancelled: boolean }>> =>
    ipcRenderer.invoke('idc-cancel-provision'),

  /** 拉取现有席位全景 */
  idcInventory: (config: IdcCredentialConfig): Promise<IdcIpcResult<IdcSeatInventory>> =>
    ipcRenderer.invoke('idc-inventory', config),

  idcChangeTier: (input: {
    credentials: IdcCredentialConfig
    targets: IdcBatchTarget[]
    tier: string
    concurrency?: number
  }): Promise<IdcIpcResult<IdcBatchOpResult[]>> => ipcRenderer.invoke('idc-change-tier', input),

  idcUnsubscribe: (input: {
    credentials: IdcCredentialConfig
    targets: IdcBatchTarget[]
    concurrency?: number
  }): Promise<IdcIpcResult<IdcBatchOpResult[]>> => ipcRenderer.invoke('idc-unsubscribe', input),

  /** 删除用户（不可逆）。会先尝试取消订阅再删号 */
  idcDeleteSeats: (input: {
    credentials: IdcCredentialConfig
    targets: IdcBatchTarget[]
    concurrency?: number
  }): Promise<IdcIpcResult<IdcBatchOpResult[]>> => ipcRenderer.invoke('idc-delete-seats', input),

  /** 重发密码设置邮件（链接 1 小时过期） */
  idcResendPassword: (input: {
    credentials: IdcCredentialConfig
    targets: IdcBatchTarget[]
    concurrency?: number
  }): Promise<IdcIpcResult<IdcBatchOpResult[]>> => ipcRenderer.invoke('idc-resend-password', input),

  /** 监听席位操作进度 */
  onIdcProgress: (callback: (event: IdcProgressEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: IdcProgressEvent): void => {
      callback(data)
    }
    ipcRenderer.on('idc-progress', handler)
    return () => {
      ipcRenderer.removeListener('idc-progress', handler)
    }
  },

  kskAutomationList: (): Promise<IdcIpcResult<KskAutomationTaskView[]>> =>
    ipcRenderer.invoke('ksk-automation-list'),

  kskAutomationCreate: (
    input: KskAutomationTaskInput
  ): Promise<IdcIpcResult<KskAutomationTaskView[]>> =>
    ipcRenderer.invoke('ksk-automation-create', input),

  kskAutomationUpdate: (
    taskId: string,
    input: KskAutomationTaskInput
  ): Promise<IdcIpcResult<KskAutomationTaskView[]>> =>
    ipcRenderer.invoke('ksk-automation-update', taskId, input),

  kskAutomationSetEnabled: (
    taskId: string,
    enabled: boolean
  ): Promise<IdcIpcResult<KskAutomationTaskView[]>> =>
    ipcRenderer.invoke('ksk-automation-set-enabled', taskId, enabled),

  kskAutomationDelete: (taskId: string): Promise<IdcIpcResult<KskAutomationTaskView[]>> =>
    ipcRenderer.invoke('ksk-automation-delete', taskId),

  kskAutomationSyncNow: (taskId: string): Promise<IdcIpcResult<KskAutomationStatusEvent>> =>
    ipcRenderer.invoke('ksk-automation-sync-now', taskId),

  kskAutomationSyncLocalAdminNow: (
    taskId: string
  ): Promise<IdcIpcResult<KskAutomationStatusEvent>> =>
    ipcRenderer.invoke('ksk-automation-sync-local-admin-now', taskId),

  /** 立刻对目标分组全量发消息验活，删掉判死的号（同时清掉反代上的对应凭据）。 */
  kskAutomationCleanupNow: (taskId: string): Promise<IdcIpcResult<KskAutomationStatusEvent>> =>
    ipcRenderer.invoke('ksk-automation-cleanup-now', taskId),

  /** 把单个账号的凭据推送到本机 Admin（复用任务里已保存的 Admin URL / API Key）。 */
  kskAutomationPushAccountToLocalAdmin: (
    candidate: LocalAdminPushCandidate
  ): Promise<IdcIpcResult<LocalAdminPushResult>> =>
    ipcRenderer.invoke('ksk-automation-push-account-to-local-admin', candidate),

  onKskAutomationStatus: (callback: (event: KskAutomationStatusEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: KskAutomationStatusEvent): void => {
      callback(data)
    }
    ipcRenderer.on('ksk-automation-status-changed', handler)
    return () => ipcRenderer.removeListener('ksk-automation-status-changed', handler)
  },

  onKskAutomationAccountsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('ksk-automation-accounts-changed', handler)
    return () => ipcRenderer.removeListener('ksk-automation-accounts-changed', handler)
  },

  kskHunterSnapshot: (): Promise<IdcIpcResult<KskHunterSnapshot>> =>
    ipcRenderer.invoke('ksk-hunter-snapshot'),

  kskHunterUpdateConfig: (
    config: Partial<KskHunterConfig>,
    secrets?: KskHunterSecretInput
  ): Promise<IdcIpcResult<KskHunterSnapshot>> =>
    ipcRenderer.invoke('ksk-hunter-update-config', config, secrets),

  kskHunterCreateLink: (input: KskHunterLinkInput): Promise<IdcIpcResult<KskHunterSnapshot>> =>
    ipcRenderer.invoke('ksk-hunter-create-link', input),

  kskHunterUpdateLink: (
    linkId: string,
    input: KskHunterLinkInput
  ): Promise<IdcIpcResult<KskHunterSnapshot>> =>
    ipcRenderer.invoke('ksk-hunter-update-link', linkId, input),

  kskHunterSetLinkEnabled: (
    linkId: string,
    enabled: boolean
  ): Promise<IdcIpcResult<KskHunterSnapshot>> =>
    ipcRenderer.invoke('ksk-hunter-set-link-enabled', linkId, enabled),

  kskHunterDeleteLink: (linkId: string): Promise<IdcIpcResult<KskHunterSnapshot>> =>
    ipcRenderer.invoke('ksk-hunter-delete-link', linkId),

  kskHunterRunNow: (): Promise<IdcIpcResult<KskHunterSnapshot>> =>
    ipcRenderer.invoke('ksk-hunter-run-now'),

  kskHunterRetryDelivery: (deliveryId: string): Promise<IdcIpcResult<KskHunterSnapshot>> =>
    ipcRenderer.invoke('ksk-hunter-retry-delivery', deliveryId),

  kskHunterDeleteDelivery: (deliveryId: string): Promise<IdcIpcResult<KskHunterSnapshot>> =>
    ipcRenderer.invoke('ksk-hunter-delete-delivery', deliveryId),

  kskHunterReport: (days?: number): Promise<IdcIpcResult<HunterReport>> =>
    ipcRenderer.invoke('ksk-hunter-report', days),

  kskHunterRevealReportFile: (): Promise<IdcIpcResult<string>> =>
    ipcRenderer.invoke('ksk-hunter-reveal-report-file'),

  kskHunterLedgerReport: (
    days?: number,
    sort?: KskLedgerSort
  ): Promise<IdcIpcResult<KskLedgerReport>> =>
    ipcRenderer.invoke('ksk-hunter-ledger-report', days, sort),

  kskHunterClearLedger: (): Promise<IdcIpcResult<KskLedgerReport>> =>
    ipcRenderer.invoke('ksk-hunter-clear-ledger'),

  kskHunterRevealLedgerFile: (): Promise<IdcIpcResult<string>> =>
    ipcRenderer.invoke('ksk-hunter-reveal-ledger-file'),

  onKskHunterStatus: (callback: (event: KskHunterStatusEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: KskHunterStatusEvent): void => {
      callback(data)
    }
    ipcRenderer.on('ksk-hunter-status-changed', handler)
    return () => ipcRenderer.removeListener('ksk-hunter-status-changed', handler)
  },

  localAdminStatsSnapshot: (): Promise<IdcIpcResult<LocalAdminStatsSnapshot>> =>
    ipcRenderer.invoke('local-admin-stats-snapshot'),

  localAdminStatsRefreshNow: (): Promise<IdcIpcResult<LocalAdminStatsSnapshot>> =>
    ipcRenderer.invoke('local-admin-stats-refresh-now'),

  localAdminStatsRefreshUsage: (): Promise<IdcIpcResult<LocalAdminUsageRefreshSummary>> =>
    ipcRenderer.invoke('local-admin-stats-refresh-usage'),

  /** 删掉本机 Admin 上额度已耗尽的凭据，并连带清掉本地账号库里的对应账号。 */
  localAdminStatsCleanupExhausted: (): Promise<IdcIpcResult<LocalAdminExhaustedCleanupSummary>> =>
    ipcRenderer.invoke('local-admin-stats-cleanup-exhausted'),

  localAdminStatsClearSamples: (): Promise<IdcIpcResult<LocalAdminStatsSnapshot>> =>
    ipcRenderer.invoke('local-admin-stats-clear-samples'),

  localAdminStatsClearBuckets: (): Promise<IdcIpcResult<LocalAdminStatsSnapshot>> =>
    ipcRenderer.invoke('local-admin-stats-clear-buckets'),

  onLocalAdminStatsChanged: (
    callback: (snapshot: LocalAdminStatsSnapshot) => void
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: LocalAdminStatsSnapshot): void => {
      callback(data)
    }
    ipcRenderer.on('local-admin-stats-changed', handler)
    return () => ipcRenderer.removeListener('local-admin-stats-changed', handler)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
