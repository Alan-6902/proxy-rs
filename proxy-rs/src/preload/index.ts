import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { IpcResult } from '../shared/ipcResult'
import type {
  KskAutomationStatusEvent,
  KskAutomationTaskInput,
  KskAutomationTaskView
} from '../shared/kskAutomation'
import type { LocalAdminPushCandidate, LocalAdminPushResult } from '../shared/localAdminPush'
import {
  CURSOR_ACCOUNTS_CHANNEL,
  type CursorAccount,
  type CursorAutoRefreshSettings,
  type CursorCockpitImportSummary,
  type CursorCredentialImportSummary,
  type CursorInjectOptions,
  type CursorInjectResult,
  type CursorOAuthStartResult,
  type CursorRefreshAllSummary
} from '../shared/cursorAccounts'
import {
  GROK_ACCOUNTS_CHANNEL,
  type GrokAccountView,
  type GrokRelayInstallProgress,
  type GrokRelayInstallResult,
  type GrokRelayStatus,
  type GrokRemoveResult,
  type GrokSwitchResult
} from '../shared/grokAccounts'

// Custom APIs for renderer
type UpstreamKiroCredentialInput =
  | string
  | {
      credentialKind?: 'oauth' | 'kiro_api_key'
      accessToken?: string
      kiroApiKey?: string
    }

interface AccountDbStatusView {
  enabled: boolean
  dbPath?: string
  databaseId?: string
  kiroRsState?: string
  kiroRsDetail?: string
  pending?: number
  error?: string
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

  // 账号库模式：删除账号（经 kiro-rs）。旧模式下为空操作，删除仍由 saveAccounts 快照完成
  accountDbDelete: (
    ids: string[]
  ): Promise<{ success: boolean; failed: Array<{ id: string; reason: string }> }> => {
    return ipcRenderer.invoke('account-db:delete', ids)
  },

  // 账号库模式：加入 / 移出反代号池
  accountDbSetInPool: (
    accountId: string,
    inPool: boolean
  ): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('account-db:set-in-pool', accountId, inPool)
  },

  // 账号库模式：取带凭据的账号（导出 / 复制凭据；普通列表已脱敏）。非账号库模式返回 null
  accountDbAccountsWithSecrets: (ids: string[]): Promise<Record<string, unknown> | null> => {
    return ipcRenderer.invoke('account-db:accounts-with-secrets', ids)
  },

  // 账号库模式：状态（是否启用、kiro-rs 子进程状态、待导入数量）
  accountDbStatus: (): Promise<AccountDbStatusView> => ipcRenderer.invoke('account-db:status'),

  /*
   * 账号库模式：CLI 当前账号的 Refresh Token 已失效（多半是 kiro-cli 自己刷新过一次，
   * 把库里那份轮换作废）。渲染层据此提示重新登录该账号。
   */
  onKiroCliNeedsReauth: (callback: (payload: { accountId: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { accountId: string }): void => {
      callback(payload)
    }
    ipcRenderer.on('kiro-cli-needs-reauth', handler)
    return () => {
      ipcRenderer.removeListener('kiro-cli-needs-reauth', handler)
    }
  },

  // 账号库模式：kiro-rs 更新了凭据 / 额度 / 状态（事件不带数据，收到后重新加载账号）
  onAccountDbChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('account-db-changed', handler)
    return () => {
      ipcRenderer.removeListener('account-db-changed', handler)
    }
  },

  // 账号管理 - 刷新 Token
  refreshAccountToken: (account: unknown): Promise<unknown> => {
    return ipcRenderer.invoke('refresh-account-token', account)
  },

  // 账号管理 - 切换为 Kiro CLI 当前账号
  switchAccountCli: (accountId: string): Promise<unknown> => {
    return ipcRenderer.invoke('switch-account-cli', accountId)
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
    syncInfo?: boolean,
    refreshManaged?: boolean
  ): Promise<{
    success: boolean
    completed: number
    successCount: number
    failedCount: number
  }> => {
    return ipcRenderer.invoke(
      'background-batch-refresh',
      accounts,
      concurrency,
      syncInfo,
      refreshManaged
    )
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

  // 已交给本机反代托管的账号 id 集合（渲染层据此把 CLI 切号等入口置灰）
  getAdminManagedIds: (): Promise<string[]> => ipcRenderer.invoke('get-admin-managed-ids'),

  onAdminManagedChanged: (callback: (ids: string[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ids: string[]): void => {
      callback(ids)
    }
    ipcRenderer.on('admin-managed-changed', handler)
    return () => {
      ipcRenderer.removeListener('admin-managed-changed', handler)
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

  onLocalNotificationNavigate: (callback: (page: 'accounts') => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, page: 'accounts'): void => callback(page)
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

  kskAutomationList: (): Promise<IpcResult<KskAutomationTaskView[]>> =>
    ipcRenderer.invoke('ksk-automation-list'),

  kskAutomationCreate: (
    input: KskAutomationTaskInput
  ): Promise<IpcResult<KskAutomationTaskView[]>> =>
    ipcRenderer.invoke('ksk-automation-create', input),

  kskAutomationUpdate: (
    taskId: string,
    input: KskAutomationTaskInput
  ): Promise<IpcResult<KskAutomationTaskView[]>> =>
    ipcRenderer.invoke('ksk-automation-update', taskId, input),

  kskAutomationSetEnabled: (
    taskId: string,
    enabled: boolean
  ): Promise<IpcResult<KskAutomationTaskView[]>> =>
    ipcRenderer.invoke('ksk-automation-set-enabled', taskId, enabled),

  kskAutomationDelete: (taskId: string): Promise<IpcResult<KskAutomationTaskView[]>> =>
    ipcRenderer.invoke('ksk-automation-delete', taskId),

  kskAutomationSyncNow: (taskId: string): Promise<IpcResult<KskAutomationStatusEvent>> =>
    ipcRenderer.invoke('ksk-automation-sync-now', taskId),

  kskAutomationSyncLocalAdminNow: (taskId: string): Promise<IpcResult<KskAutomationStatusEvent>> =>
    ipcRenderer.invoke('ksk-automation-sync-local-admin-now', taskId),

  /** 立刻对目标分组全量发消息验活，删掉判死的号（同时清掉反代上的对应凭据）。 */
  kskAutomationCleanupNow: (taskId: string): Promise<IpcResult<KskAutomationStatusEvent>> =>
    ipcRenderer.invoke('ksk-automation-cleanup-now', taskId),

  /** 把单个账号的凭据推送到本机 Admin（复用任务里已保存的 Admin URL / API Key）。 */
  kskAutomationPushAccountToLocalAdmin: (
    candidate: LocalAdminPushCandidate
  ): Promise<IpcResult<LocalAdminPushResult>> =>
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

  // ============ Cursor 账号管理 ============
  cursorAccountsList: (): Promise<IpcResult<CursorAccount[]>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.list),

  /** 本机 Cursor 当前登录的号在账号库里的 id；没匹配上为 null。 */
  cursorAccountsCurrentId: (): Promise<IpcResult<string | null>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.currentId),

  cursorAccountsRemove: (ids: string[]): Promise<IpcResult<void>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.remove, ids),

  // 下面几个新增入口的 tags 是「本次添加要打的标签」，入库时一并写上，不用再单独改一次

  cursorAccountsImportJson: (
    json: string,
    tags: string[] = []
  ): Promise<IpcResult<CursorAccount[]>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.importJson, json, tags),

  cursorAccountsImportLocal: (tags: string[] = []): Promise<IpcResult<CursorAccount>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.importLocal, tags),

  /** 从本机 cockpit-tools（~/.antigravity_cockpit）整批导入 Cursor 账号。 */
  cursorAccountsImportCockpit: (
    tags: string[] = []
  ): Promise<IpcResult<CursorCockpitImportSummary>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.importCockpit, tags),

  /**
   * 粘贴 WorkosCursorSessionToken cookie 值或 access token（每行一条）批量入库。
   * 主进程会替用户走完 Cursor 登录握手，拿到带 refresh token 的正式凭据。
   */
  cursorAccountsAddToken: (
    input: string,
    tags: string[] = []
  ): Promise<IpcResult<CursorCredentialImportSummary>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.addToken, input, tags),

  cursorAccountsExport: (ids: string[]): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.export, ids),

  cursorAccountsRefresh: (id: string): Promise<IpcResult<CursorAccount>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.refresh, id),

  cursorAccountsRefreshAll: (): Promise<IpcResult<CursorRefreshAllSummary>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.refreshAll),

  cursorAccountsUpdateTags: (id: string, tags: string[]): Promise<IpcResult<CursorAccount>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.updateTags, id, tags),

  /** 切号：把账号写进本机 Cursor 的登录态。Cursor 在运行时先返回 needsClose 等用户确认。 */
  cursorAccountsInject: (
    id: string,
    options?: CursorInjectOptions
  ): Promise<IpcResult<CursorInjectResult>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.inject, id, options),

  cursorAccountsOAuthStart: (): Promise<IpcResult<CursorOAuthStartResult>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.oauthStart),

  /** 阻塞到用户在浏览器完成登录（最长 5 分钟），成功即返回入库后的账号。 */
  cursorAccountsOAuthComplete: (
    loginId: string,
    tags: string[] = []
  ): Promise<IpcResult<CursorAccount>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.oauthComplete, loginId, tags),

  cursorAccountsOAuthCancel: (loginId?: string): Promise<IpcResult<null>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.oauthCancel, loginId),

  cursorAccountsRevealStore: (): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.storePath),

  cursorAccountsGetSettings: (): Promise<IpcResult<CursorAutoRefreshSettings>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.settingsGet),

  /** 改后台自动刷新的开关/间隔，主进程调度器随即按新设置重排。 */
  cursorAccountsUpdateSettings: (
    patch: Partial<CursorAutoRefreshSettings>
  ): Promise<IpcResult<CursorAutoRefreshSettings>> =>
    ipcRenderer.invoke(CURSOR_ACCOUNTS_CHANNEL.settingsUpdate, patch),

  onCursorAccountsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CURSOR_ACCOUNTS_CHANNEL.changed, handler)
    return () => ipcRenderer.removeListener(CURSOR_ACCOUNTS_CHANNEL.changed, handler)
  },

  // ============ Grok Bot 账号管理（切号 + 同步 relay） ============
  grokAccountsList: (): Promise<IpcResult<GrokAccountView[]>> =>
    ipcRenderer.invoke(GROK_ACCOUNTS_CHANNEL.list),

  /** 本机 Grok Bot 当前激活账号的 scope；未登录为 null。 */
  grokAccountsCurrentScope: (): Promise<IpcResult<string | null>> =>
    ipcRenderer.invoke(GROK_ACCOUNTS_CHANNEL.currentScope),

  /** 切号：（不在 Grok 里就先从 Cursor 账号库写入）改 active + 重启 Grok + 同步 relay。Grok 在运行时先返回 needsClose 等确认。 */
  grokAccountsSwitch: (
    scope: string,
    options?: { closeGrok?: boolean }
  ): Promise<IpcResult<GrokSwitchResult>> =>
    ipcRenderer.invoke(GROK_ACCOUNTS_CHANNEL.switch, scope, options),

  /** 从 Grok 客户端移除一个号（Cursor 账号库不动）。Grok 在运行时先返回 needsClose 等确认。 */
  grokAccountsRemove: (
    scope: string,
    options?: { closeGrok?: boolean }
  ): Promise<IpcResult<GrokRemoveResult>> =>
    ipcRenderer.invoke(GROK_ACCOUNTS_CHANNEL.remove, scope, options),

  /** 只把反代 relay 配置重新指向某个号的 box 并探活，不重启客户端。 */
  grokAccountsSyncRelay: (scope: string): Promise<IpcResult<GrokRelayStatus>> =>
    ipcRenderer.invoke(GROK_ACCOUNTS_CHANNEL.syncRelay, scope),

  /** 探活：本机反代当前能否通过 relay 打到 box。 */
  grokAccountsRelayStatus: (): Promise<IpcResult<GrokRelayStatus>> =>
    ipcRenderer.invoke(GROK_ACCOUNTS_CHANNEL.relayStatus),

  /** 确保某个号的 Box 上有 relay 路由：没装就让它的 Bot 去装并等到探针通过。可能跑几分钟，进度走下面的事件。 */
  grokAccountsEnsureRelayRoute: (scope: string): Promise<IpcResult<GrokRelayInstallResult>> =>
    ipcRenderer.invoke(GROK_ACCOUNTS_CHANNEL.ensureRelayRoute, scope),

  onGrokRelayInstallProgress: (
    callback: (progress: GrokRelayInstallProgress) => void
  ): (() => void) => {
    const handler = (_event: unknown, progress: GrokRelayInstallProgress): void =>
      callback(progress)
    ipcRenderer.on(GROK_ACCOUNTS_CHANNEL.relayInstallProgress, handler)
    return () => ipcRenderer.removeListener(GROK_ACCOUNTS_CHANNEL.relayInstallProgress, handler)
  },

  onGrokAccountsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(GROK_ACCOUNTS_CHANNEL.changed, handler)
    return () => ipcRenderer.removeListener(GROK_ACCOUNTS_CHANNEL.changed, handler)
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
