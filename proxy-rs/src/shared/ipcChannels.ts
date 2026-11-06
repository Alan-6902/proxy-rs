/**
 * 主进程与 preload 之间的 IPC 通道名。两侧都从这里取，改名只改一处，拼错 key 过不了 typecheck；
 * 一侧有、另一侧没有的通道由 test/integration/ipcChannels.test.ts 对账兜底。
 *
 * KSK 自动化与 Serena 的通道分别见 shared/kskAutomation.ts、shared/serena.ts。
 */

/** 请求 / 响应：渲染层 ipcRenderer.invoke ↔ 主进程 ipcMain.handle */
export const IPC = {
  accountDbAccountsWithSecrets: 'account-db:accounts-with-secrets',
  accountDbDelete: 'account-db:delete',
  accountDbSetInPool: 'account-db:set-in-pool',
  accountDbStatus: 'account-db:status',
  accountGetModels: 'account-get-models',
  accountGetSubscriptionUrl: 'account-get-subscription-url',
  accountGetSubscriptions: 'account-get-subscriptions',
  appLogsClear: 'app-logs-clear',
  appLogsCount: 'app-logs-count',
  appLogsGet: 'app-logs-get',
  backgroundBatchCheck: 'background-batch-check',
  backgroundBatchRefresh: 'background-batch-refresh',
  cancelBuilderIdLogin: 'cancel-builder-id-login',
  cancelIamSsoLogin: 'cancel-iam-sso-login',
  cancelSocialLogin: 'cancel-social-login',
  checkAccountStatus: 'check-account-status',
  diagnoseAccountLiveness: 'diagnose:account-liveness',
  diagnoseRun: 'diagnose:run',
  exchangeSocialToken: 'exchange-social-token',
  exportToFile: 'export-to-file',
  getAdminManagedIds: 'get-admin-managed-ids',
  getAppVersion: 'get-app-version',
  getKiroAvailableModels: 'get-kiro-available-models',
  getShowWindowShortcut: 'get-show-window-shortcut',
  getTraySettings: 'get-tray-settings',
  getUsageApiType: 'get-usage-api-type',
  importFromFile: 'import-from-file',
  importFromSsoToken: 'import-from-sso-token',
  kiroAdminView: 'kiro-admin-view',
  kiroCliCurrentAccount: 'kiro-cli-current-account',
  loadAccounts: 'load-accounts',
  openSubscriptionWindow: 'open-subscription-window',
  pollBuilderIdAuth: 'poll-builder-id-auth',
  pollIamSsoAuth: 'poll-iam-sso-auth',
  refreshAccountToken: 'refresh-account-token',
  saveAccounts: 'save-accounts',
  saveTraySettings: 'save-tray-settings',
  setProxy: 'set-proxy',
  setShowWindowShortcut: 'set-show-window-shortcut',
  setUsageApiType: 'set-usage-api-type',
  startBuilderIdLogin: 'start-builder-id-login',
  startIamSsoLogin: 'start-iam-sso-login',
  startSocialLogin: 'start-social-login',
  switchAccountCli: 'switch-account-cli',
  verifyAccountCredentials: 'verify-account-credentials',
  windowGetPlatform: 'window-get-platform',
  windowIsMaximized: 'window-is-maximized'
} as const

/** 单向消息：主进程 webContents.send → 渲染层 ipcRenderer.on，或渲染层 ipcRenderer.send → 主进程 ipcMain.on */
export const IPC_EVENT = {
  accountDbChanged: 'account-db-changed',
  accountDbStatus: 'account-db-status',
  adminManagedChanged: 'admin-managed-changed',
  authCallback: 'auth-callback',
  backgroundCheckResult: 'background-check-result',
  backgroundRefreshResult: 'background-refresh-result',
  closeConfirmResponse: 'close-confirm-response',
  closeIncognitoBrowser: 'close-incognito-browser',
  kiroCliAccountChanged: 'kiro-cli-account-changed',
  kiroCliNeedsReauth: 'kiro-cli-needs-reauth',
  localNotificationNavigate: 'local-notification-navigate',
  openExternal: 'open-external',
  openIncognitoBrowser: 'open-incognito-browser',
  showCloseConfirmDialog: 'show-close-confirm-dialog',
  socialAuthCallback: 'social-auth-callback',
  trayRefreshAccount: 'tray-refresh-account',
  traySwitchAccount: 'tray-switch-account',
  updateTrayAccount: 'update-tray-account',
  updateTrayAccountList: 'update-tray-account-list',
  updateTrayLanguage: 'update-tray-language',
  windowClose: 'window-close',
  windowMaximizeChanged: 'window-maximize-changed',
  windowMaximizeToggle: 'window-maximize-toggle',
  windowMinimize: 'window-minimize'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
export type IpcEventChannel = (typeof IPC_EVENT)[keyof typeof IPC_EVENT]
