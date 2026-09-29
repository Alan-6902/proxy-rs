import { app, shell, BrowserWindow, ipcMain, dialog, globalShortcut } from 'electron'
import {
  buildKiroCredentialRefreshSingleflightKey,
  KiroCredentialRefreshSingleflight,
  mergeAccountDataPreservingRotatedKiroCredentials,
  mergeRotatedKiroCredentials,
  shouldReuseCanonicalKiroCredentials,
  type RotatedKiroCredentialUpdate
} from './kiroCredentialRefresh'
import {
  createKiroCliSocialRenewal,
  kiroCliDbExists,
  KIRO_CLI_RENEWAL_INTERVAL_MS,
  KIRO_CLI_RENEWAL_LEAD_MS,
  resolveKiroCliDbPath,
  resolveKiroCliSocialProvider,
  switchKiroCliAccount,
  syncRefreshedKiroCliCredentials,
  type KiroCliSocialToken
} from './kiroCli/cliCredentials'
import {
  APP_ACCOUNT_STORE_ENCRYPTION_KEY,
  APP_ACCOUNT_STORE_NAME,
  APP_DATA_DIRECTORY_NAME,
  APP_ID,
  APP_NAME,
  APP_PROTOCOL_SCHEME,
  APP_SOCIAL_AUTH_REDIRECT_URI,
  isAppCallbackUrl
} from '../shared/appIdentity'
import { AccountStoreCoordinator } from './accountStoreCoordinator'
import {
  ADMIN_MANAGED_REFRESH_SUPPRESSED,
  adminManagedEntry,
  adminManagedIdsSnapshot,
  isAdminManagedAccount,
  isAdminManagedRefreshToken,
  reconcileManagedAccounts,
  reloadAdminManagedIds,
  setAdminManagedChangeListener,
  setAdminManagedRefreshTokenResolver
} from './adminManaged/gate'
import {
  refreshManagedAccountFromAdmin,
  syncManagedAccountFromAdmin
} from './adminManaged/accountSync'
import { startManagedAccountRefresh } from './adminManaged/startup'
import { recordAdminManagedAccount } from './adminManaged/registryStore'
import { matchRemoteCredentialToLocalAccount } from '../shared/adminManaged'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { writeFile, readFile } from 'fs/promises'
import { encode, decode } from 'cbor-x'
import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Dispatcher
} from 'undici'
import icon from '../../resources/icon.png?asset'
import { buildBackgroundRefreshPlan, type ProxyAccount } from './proxy/types'
import {
  fetchKiroModels,
  fetchSubscriptionToken,
  fetchAvailableSubscriptions,
  callKiroApi,
  fetchEnterpriseProfileArn,
  getEnterpriseFallbackArn,
  isPlaceholderProfileArn,
  KIRO_BUILDER_ID_PLACEHOLDER_ARN,
  KIRO_SOCIAL_PROFILE_ARN
} from './proxy/kiroApi'
import { openaiToKiro } from './proxy/translator'
import {
  getElectronProxySettings,
  getSystemProxy,
  redactProxyUrl,
  safeCreateProxyAgent,
  type ElectronProxyCredentials
} from './proxy/systemProxy'
import { proxyLogStore, interceptConsole } from './proxy/logger'
import { registerIPCHandlers as registerRegistrationHandlers } from './registration/ipc-handlers'
import { registerProxyPoolIpcHandlers, validateProxyEntry } from './ipc/proxyPool'
import { KskAutomationManager } from './kskAutomation/syncManager'
import {
  KSK_CLEANUP_FALLBACK_MODEL,
  KSK_CLEANUP_MAX_OUTPUT_TOKENS,
  KSK_CLEANUP_PROBE_TIMEOUT_MS,
  KSK_CREDENTIAL_VALIDATION_CONCURRENCY,
  KSK_PROBE_VERDICT,
  classifyKskProbeError,
  mapWithConcurrency,
  pickCheapestModelId,
  removeMatchingInvalidKskAccounts,
  resolveKskLivenessMessage,
  type KskCredentialCleanupResult,
  type KskProbeVerdict
} from './kskAutomation/credentialCleanup'
import { loadKskAutomationStore, loadKskAutomationTask } from './kskAutomation/configStore'
import {
  registerKskAutomationIpcHandlers,
  resolveLocalAdminTarget,
  sendKskAutomationAccountsChanged,
  sendKskAutomationStatus
} from './kskAutomation/ipc-handlers'
import type { KskLivenessOptions, ProviderKskCredential } from '../shared/kskAutomation'
import {
  deleteLocalAdminCredentialsById,
  readRemoteCredentials,
  remoteCredentialId,
  requestJson,
  resolveLocalAdminApiBase,
  sha256Hex,
  type KskAutomationFetch,
  type LocalAdminProbeOutcome
} from './kskAutomation/localAdminClient'
import { LOCAL_ADMIN_PROBE_VERDICT, type LocalAdminPushCandidate } from '../shared/localAdminPush'
import {
  EMPTY_LOCAL_ADMIN_EXHAUSTED_CLEANUP,
  resolveSubscriptionTypeFromTitle,
  selectExhaustedLocalAdminCredentials,
  type LocalAdminCredentialStats,
  type LocalAdminExhaustedCleanupSummary
} from '../shared/localAdminStats'
import { LocalAdminStatsManager } from './localAdminStats/statsManager'
import { fetchLocalAdminUsage } from './localAdminStats/statsClient'
import {
  registerLocalAdminStatsIpcHandlers,
  sendLocalAdminStatsSnapshot
} from './localAdminStats/ipc-handlers'
import { KskHunterManager } from './kskHunter/hunterRunner'
import {
  hunterLocalDateKey,
  isHunterOAuthCredential,
  KSK_HUNTER_CHANNEL_LABEL,
  type HunterOAuthCredential,
  type KskHunterRuntimeNotification
} from '../shared/kskHunter'
import { loadKskHunterStore } from './kskHunter/configStore'
import { registerKskHunterIpcHandlers, sendKskHunterStatus } from './kskHunter/ipc-handlers'
import { KSK_LEDGER_RETIRE_REASON, resolveLedgerState } from '../shared/kskLedger'
import {
  loadKskLedger,
  markKskLedgerRetired,
  updateKskLedgerFromAccounts
} from './kskHunter/ledgerStore'
import { updateKskHunterConfig } from './kskHunter/configStore'
import { DownstreamSettlementManager } from './downstreamSettlement/settlementManager'
import { registerDownstreamSettlementIpcHandlers } from './downstreamSettlement/ipc-handlers'
import {
  registerCursorAccountsIpcHandlers,
  sendCursorAccountsChanged
} from './cursorAccounts/ipc-handlers'
import { registerGrokAccountsIpcHandlers } from './grokAccounts/ipc-handlers'
import { CursorAutoRefreshScheduler } from './cursorAccounts/refreshScheduler'
import type { DownstreamLedgerUsage } from '../shared/downstreamSettlement'
import { ProxyPoolScheduler, type ProxyPoolStoreSlice } from './proxy/proxyPoolScheduler'
import {
  LocalNotificationService,
  LocalNoticeKind,
  type LocalNoticeLanguage
} from './localNotifications'
import {
  createTray,
  destroyTray,
  updateTrayMenu,
  updateCurrentAccount,
  updateAccountList,
  setTrayTooltip,
  updateTrayLanguage,
  type TraySettings,
  defaultTraySettings
} from './tray'

app.setName(APP_NAME)
// PROXY_RS_USER_DATA_DIR：联调用独立 userData（账号库配置、electron-store、单实例锁随之隔离），
// 可在本机正式版运行时安全地起第二个实例做验证
app.setPath(
  'userData',
  process.env.PROXY_RS_USER_DATA_DIR?.trim() ||
    join(app.getPath('appData'), APP_DATA_DIRECTORY_NAME)
)

// ============ 自动更新配置 ============
// ============ Kiro API 调用 ============
const KIRO_API_BASE = 'https://app.kiro.dev/service/KiroWebPortalService/operation'
// REST API 端点配置 - 官方 Kiro 插件仅支持 us-east-1 和 eu-central-1
const KIRO_REST_API_ENDPOINTS: Record<string, string> = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com'
}

// 根据 SSO 区域映射到最近的 REST API 端点
function getRestApiBase(ssoRegion?: string): string {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS['us-east-1']
  // 如果是支持的端点区域，直接使用
  if (KIRO_REST_API_ENDPOINTS[ssoRegion]) return KIRO_REST_API_ENDPOINTS[ssoRegion]
  // EU 区域映射到 eu-central-1
  if (ssoRegion.startsWith('eu-')) return KIRO_REST_API_ENDPOINTS['eu-central-1']
  // 其他区域默认 us-east-1
  return KIRO_REST_API_ENDPOINTS['us-east-1']
}

// 获取备用 REST API 端点（用于 fallback）
function getFallbackRestApiBase(ssoRegion?: string): string {
  const primary = getRestApiBase(ssoRegion)
  // 返回另一个端点作为 fallback
  return primary === KIRO_REST_API_ENDPOINTS['eu-central-1']
    ? KIRO_REST_API_ENDPOINTS['us-east-1']
    : KIRO_REST_API_ENDPOINTS['eu-central-1']
}

// API 类型配置
type UsageApiType = 'rest' | 'cbor'
let currentUsageApiType: UsageApiType = 'rest' // 默认使用 REST API (GetUsageLimits)

export function setUsageApiType(type: UsageApiType): void {
  currentUsageApiType = type
  console.log(`[API] Usage API type set to: ${type}`)
}

export function getUsageApiType(): UsageApiType {
  return currentUsageApiType
}

// 获取网络代理 agent（用户设置代理优先于系统代理）
function getNetworkAgent(): Dispatcher | undefined {
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  const envAgent = safeCreateProxyAgent(envProxy)
  if (envAgent) return envAgent
  return safeCreateProxyAgent(getSystemProxy())
}

// 本机 Admin 会携带管理密钥与完整 KSK，必须强制直连，不能复用应用/系统代理。
const localAdminDirectAgent = new Agent()

/**
 * 通用 fetch 函数
 * @param url 请求 URL
 * @param options fetch 选项
 * @param overrideProxyUrl 可选：账号绑定的代理 URL（优先级最高，覆盖全局代理逻辑）
 *
 * 优先级：overrideProxyUrl > 用户设置代理 > 系统代理 > 直连
 */
async function fetchWithAppProxy(
  url: string,
  options: RequestInit,
  overrideProxyUrl?: string
): Promise<Response> {
  // 优先尝试账号绑定代理
  if (overrideProxyUrl) {
    const accountAgent = safeCreateProxyAgent(overrideProxyUrl)
    if (accountAgent) {
      return (await undiciFetch(url, {
        ...options,
        dispatcher: accountAgent
      } as UndiciRequestInit)) as unknown as Response
    }
  }
  const agent = getNetworkAgent()
  if (agent) {
    return (await undiciFetch(url, {
      ...options,
      dispatcher: agent
    } as UndiciRequestInit)) as unknown as Response
  }
  return await fetch(url, options)
}

// ============ OIDC Token 刷新 ============
interface OidcRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
  /**
   * 这次刷新被托管闸门拦下：该账号已推给本机反代，token 由反代维护。
   *
   * 必须与「刷新失败」区分开——调用方据此提示「由反代托管」，而不是把卡片标红。
   * 用可选字段而不是拆联合类型，是为了让既有调用点的成功语义保持不变。
   */
  suppressedByAdmin?: boolean
}

// 社交登录 (GitHub/Google) 的 Token 刷新端点
const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'

// ============ 代理设置 ============

let activeElectronProxyCredentials: ElectronProxyCredentials | undefined

app.on('login', (event, _webContents, _details, authInfo, callback) => {
  const credentials = activeElectronProxyCredentials
  if (
    !credentials ||
    !authInfo.isProxy ||
    authInfo.host !== credentials.host ||
    authInfo.port !== credentials.port
  ) {
    return
  }

  event.preventDefault()
  callback(credentials.username, credentials.password)
})

/**
 * 规范化代理 URL，确保 protocol://host:port 格式。
 * 容错处理用户常见的格式错误：
 *   http:127.0.0.1:7890     → http://127.0.0.1:7890   (缺 //)
 *   http:/127.0.0.1:7890    → http://127.0.0.1:7890   (单 /)
 *   127.0.0.1:7890          → http://127.0.0.1:7890   (无 protocol)
 *   http://127.0.0.1:7890   → http://127.0.0.1:7890   (已规范)
 */
export function normalizeProxyUrl(url: string): string {
  const trimmed = (url || '').trim()
  if (!trimmed) return ''
  // 已是标准 protocol:// 前缀
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) return trimmed
  // 有 protocol: 但缺/少 //
  const m = trimmed.match(/^([a-z][a-z0-9+\-.]*):(\/*)(.+)$/i)
  if (m) return `${m[1]}://${m[3]}`
  // 无 protocol，默认 http
  return `http://${trimmed}`
}

// 设置代理环境变量
function applyProxySettings(enabled: boolean, url: string): void {
  if (enabled && url) {
    const normalized = normalizeProxyUrl(url)
    const electronProxy = getElectronProxySettings(normalized)
    activeElectronProxyCredentials = electronProxy?.credentials
    process.env.HTTP_PROXY = normalized
    process.env.HTTPS_PROXY = normalized
    process.env.http_proxy = normalized
    process.env.https_proxy = normalized
    const redactedNormalized = redactProxyUrl(normalized)
    if (normalized !== url) {
      console.log(`[Proxy] Enabled: ${redactedNormalized} (代理地址已规范化)`)
    } else {
      console.log(`[Proxy] Enabled: ${redactedNormalized}`)
    }
  } else {
    activeElectronProxyCredentials = undefined
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.http_proxy
    delete process.env.https_proxy
    console.log('[Proxy] Disabled')
  }
}

// ============ 内置无痕浏览器 ============
let privateBrowserWindow: BrowserWindow | null = null
let privateBrowserSessionSequence = 0

// 使用隐私模式打开浏览器
function closePrivateBrowserWindow(): void {
  if (privateBrowserWindow && !privateBrowserWindow.isDestroyed()) {
    privateBrowserWindow.close()
  }
}

function openBrowserInPrivateMode(url: string): void {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    console.error('[Browser] Refused to open non-HTTP URL in the built-in browser')
    return
  }

  closePrivateBrowserWindow()

  const partition = `incognito-browser-${process.pid}-${privateBrowserSessionSequence++}`
  const browserWindow = new BrowserWindow({
    title: `${APP_NAME} 无痕浏览器`,
    width: 1100,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })

  privateBrowserWindow = browserWindow

  const chromeUserAgent = browserWindow.webContents.session
    .getUserAgent()
    .replace(/\sElectron\/[^\s]+/g, '')
  browserWindow.webContents.setUserAgent(chromeUserAgent)

  const appProxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  const electronProxy = getElectronProxySettings(appProxyUrl)

  browserWindow.on('closed', () => {
    if (privateBrowserWindow === browserWindow) {
      privateBrowserWindow = null
    }
  })

  const handleProtocolNavigation = (
    event: { preventDefault: () => void },
    navigationUrl: string
  ): void => {
    if (!isAppCallbackUrl(navigationUrl)) return

    // 必须拦下：放行的话系统会把 kiro:// 交给 Kiro IDE
    event.preventDefault()
    handleProtocolUrl(navigationUrl)
    // 不在此处关窗：协议回调只代表拿到 code，账号是否成功入库由渲染进程决定，
    // 由渲染进程在流程终态调用 close-incognito-browser 关闭
  }

  browserWindow.webContents.on('will-navigate', handleProtocolNavigation)
  browserWindow.webContents.on('will-redirect', handleProtocolNavigation)

  browserWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(
      `[Browser] Built-in incognito browser failed to load (${errorCode}): ${errorDescription}`
    )
  })

  void (async () => {
    if (electronProxy) {
      await browserWindow.webContents.session.setProxy({ proxyRules: electronProxy.proxyRules })
      console.log(
        `[Browser] Built-in incognito browser using proxy: ${redactProxyUrl(appProxyUrl!)}`
      )
    }
    await browserWindow.loadURL(url)
  })().catch((error) => {
    console.error('[Browser] Failed to open URL in built-in incognito browser:', error)
  })
}

// IdC (BuilderId) 的 OIDC Token 刷新
async function refreshOidcToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  proxyUrl?: string // 账号绑定的代理 URL（可选，优先级最高）
): Promise<OidcRefreshResult> {
  console.log(
    `[OIDC] Refreshing token with clientId: ${clientId.substring(0, 20)}...${proxyUrl ? ' [via bound proxy]' : ''}`
  )

  const url = `https://oidc.${region}.amazonaws.com/token`

  const payload = {
    clientId,
    clientSecret,
    refreshToken,
    grantType: 'refresh_token'
  }

  try {
    const response = await fetchWithAppProxy(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      },
      proxyUrl
    )

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[OIDC] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }

    const data = await response.json()
    console.log(`[OIDC] Token refreshed successfully, expires in ${data.expiresIn}s`)

    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken, // 可能不返回新的 refreshToken
      expiresIn: data.expiresIn
    }
  } catch (error) {
    console.error(`[OIDC] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 社交登录 (GitHub/Google) 的 Token 刷新
async function refreshSocialToken(
  refreshToken: string,
  proxyUrl?: string // 账号绑定的代理 URL（可选，优先级最高）
): Promise<OidcRefreshResult> {
  console.log(`[Social] Refreshing token...${proxyUrl ? ' [via bound proxy]' : ''}`)

  const url = `${KIRO_AUTH_ENDPOINT}/refreshToken`

  try {
    const response = await fetchWithAppProxy(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getKiroUserAgent()
        },
        body: JSON.stringify({ refreshToken })
      },
      proxyUrl
    )

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[Social] Refresh failed: ${response.status} - ${errorText}`)
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }

    const data = await response.json()
    console.log(`[Social] Token refreshed successfully, expires in ${data.expiresIn}s`)

    return {
      success: true,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresIn: data.expiresIn
    }
  } catch (error) {
    console.error(`[Social] Refresh error:`, error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

// 通用 Token 刷新 - 根据 authMethod 选择刷新方式
async function refreshTokenByMethod(
  token: string,
  clientId: string,
  clientSecret: string,
  region: string = 'us-east-1',
  authMethod?: string,
  proxyUrl?: string // 账号绑定的代理 URL（可选，优先级最高）
): Promise<OidcRefreshResult> {
  // 如果是社交登录，使用 Kiro Auth Service 刷新
  if (authMethod === 'social') {
    return refreshSocialToken(token, proxyUrl)
  }
  // 否则使用 OIDC 刷新 (IdC/BuilderId)
  return refreshOidcToken(token, clientId, clientSecret, region, proxyUrl)
}

function generateInvocationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// Kiro 版本和 User-Agent 生成
const KIRO_VERSION = '0.6.18'

function getKiroUserAgent(): string {
  return `aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E KiroIDE-${KIRO_VERSION}`
}

function getKiroAmzUserAgent(): string {
  return `aws-sdk-js/1.0.18 KiroIDE-${KIRO_VERSION}`
}

// ============ AWS SSO 设备授权流程 ============
interface SsoAuthResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresIn?: number
  error?: string
}

async function ssoDeviceAuth(
  bearerToken: string,
  region: string = 'us-east-1'
): Promise<SsoAuthResult> {
  const oidcBase = `https://oidc.${region}.amazonaws.com`
  const portalBase = 'https://portal.sso.us-east-1.amazonaws.com'
  const startUrl = 'https://view.awsapps.com/start'
  const scopes = [
    'codewhisperer:analysis',
    'codewhisperer:completions',
    'codewhisperer:conversations',
    'codewhisperer:taskassist',
    'codewhisperer:transformations'
  ]

  let clientId: string, clientSecret: string
  let deviceCode: string, userCode: string
  let deviceSessionToken: string
  let interval = 1

  // Step 1: 注册 OIDC 客户端
  console.log('[SSO] Step 1: Registering OIDC client...')
  try {
    const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: APP_NAME,
        clientType: 'public',
        scopes,
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        issuerUrl: startUrl
      })
    })
    if (!regRes.ok) throw new Error(`Register failed: ${regRes.status}`)
    const regData = (await regRes.json()) as { clientId: string; clientSecret: string }
    clientId = regData.clientId
    clientSecret = regData.clientSecret
    console.log(`[SSO] Client registered: ${clientId.substring(0, 30)}...`)
  } catch (e) {
    return { success: false, error: `注册客户端失败: ${e}` }
  }

  // Step 2: 发起设备授权
  console.log('[SSO] Step 2: Starting device authorization...')
  try {
    const devRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, startUrl })
    })
    if (!devRes.ok) throw new Error(`Device auth failed: ${devRes.status}`)
    const devData = (await devRes.json()) as {
      deviceCode: string
      userCode: string
      interval?: number
    }
    deviceCode = devData.deviceCode
    userCode = devData.userCode
    interval = devData.interval || 1
    console.log(`[SSO] Device code obtained, user_code: ${userCode}`)
  } catch (e) {
    return { success: false, error: `设备授权失败: ${e}` }
  }

  // Step 3: 验证 Bearer Token (whoAmI)
  console.log('[SSO] Step 3: Verifying bearer token...')
  try {
    const whoRes = await fetchWithAppProxy(`${portalBase}/token/whoAmI`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' }
    })
    if (!whoRes.ok) throw new Error(`whoAmI failed: ${whoRes.status}`)
    console.log('[SSO] Bearer token verified')
  } catch (e) {
    return { success: false, error: `Token 验证失败: ${e}` }
  }

  // Step 4: 获取设备会话令牌
  console.log('[SSO] Step 4: Getting device session token...')
  try {
    const sessRes = await fetchWithAppProxy(`${portalBase}/session/device`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    if (!sessRes.ok) throw new Error(`Device session failed: ${sessRes.status}`)
    const sessData = (await sessRes.json()) as { token: string }
    deviceSessionToken = sessData.token
    console.log('[SSO] Device session token obtained')
  } catch (e) {
    return { success: false, error: `获取设备会话失败: ${e}` }
  }

  // Step 5: 接受用户代码
  console.log('[SSO] Step 5: Accepting user code...')
  let deviceContext: { deviceContextId?: string; clientId?: string; clientType?: string } | null =
    null
  try {
    const acceptRes = await fetchWithAppProxy(`${oidcBase}/device_authorization/accept_user_code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://view.awsapps.com/' },
      body: JSON.stringify({ userCode, userSessionId: deviceSessionToken })
    })
    if (!acceptRes.ok) throw new Error(`Accept user code failed: ${acceptRes.status}`)
    const acceptData = (await acceptRes.json()) as {
      deviceContext?: { deviceContextId?: string; clientId?: string; clientType?: string }
    }
    deviceContext = acceptData.deviceContext || null
    console.log('[SSO] User code accepted')
  } catch (e) {
    return { success: false, error: `接受用户代码失败: ${e}` }
  }

  // Step 6: 批准授权
  if (deviceContext?.deviceContextId) {
    console.log('[SSO] Step 6: Approving authorization...')
    try {
      const approveRes = await fetchWithAppProxy(
        `${oidcBase}/device_authorization/associate_token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Referer: 'https://view.awsapps.com/' },
          body: JSON.stringify({
            deviceContext: {
              deviceContextId: deviceContext.deviceContextId,
              clientId: deviceContext.clientId || clientId,
              clientType: deviceContext.clientType || 'public'
            },
            userSessionId: deviceSessionToken
          })
        }
      )
      if (!approveRes.ok) throw new Error(`Approve failed: ${approveRes.status}`)
      console.log('[SSO] Authorization approved')
    } catch (e) {
      return { success: false, error: `批准授权失败: ${e}` }
    }
  }

  // Step 7: 轮询获取 Token
  console.log('[SSO] Step 7: Polling for token...')
  const startTime = Date.now()
  const timeout = 120000 // 2 分钟超时

  while (Date.now() - startTime < timeout) {
    await new Promise((r) => setTimeout(r, interval * 1000))

    try {
      const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.ok) {
        const tokenData = (await tokenRes.json()) as {
          accessToken: string
          refreshToken: string
          expiresIn?: number
        }
        console.log('[SSO] Token obtained successfully!')
        return {
          success: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }
      }

      if (tokenRes.status === 400) {
        const errData = (await tokenRes.json()) as { error?: string }
        if (errData.error === 'authorization_pending') {
          continue // 继续轮询
        } else if (errData.error === 'slow_down') {
          interval += 5
        } else {
          return { success: false, error: `Token 获取失败: ${errData.error}` }
        }
      }
    } catch (e) {
      console.error('[SSO] Token poll error:', e)
    }
  }

  return { success: false, error: '授权超时，请重试' }
}

type UpstreamKiroCredential =
  | string
  | {
      credentialKind?: 'oauth'
      accessToken: string
      kiroApiKey?: never
      idp?: string
    }
  | {
      credentialKind: 'kiro_api_key'
      accessToken?: never
      kiroApiKey: string
      idp?: string
    }

function resolveUpstreamKiroCredential(input: {
  credentialKind?: 'oauth' | 'kiro_api_key'
  accessToken?: string
  kiroApiKey?: string
  idp?: string
}): Exclude<UpstreamKiroCredential, string> {
  const kiroApiKey = input.kiroApiKey?.trim()
  const credentialKind = input.credentialKind ?? (kiroApiKey ? 'kiro_api_key' : 'oauth')
  if (credentialKind === 'kiro_api_key') {
    if (!kiroApiKey) throw new Error('Missing Kiro API key')
    return { credentialKind, kiroApiKey, idp: input.idp }
  }

  const accessToken = input.accessToken?.trim()
  if (!accessToken) throw new Error('Missing OAuth access token')
  return { credentialKind: 'oauth', accessToken, idp: input.idp }
}

function getUpstreamKiroAuth(
  credential: UpstreamKiroCredential,
  fallbackIdp = 'BuilderId'
): {
  accessToken: string
  isApiKey: boolean
  idp: string
  headers: Record<string, string>
} {
  const source =
    typeof credential === 'string'
      ? resolveUpstreamKiroCredential({ accessToken: credential })
      : resolveUpstreamKiroCredential(credential)
  const isApiKey = source.credentialKind === 'kiro_api_key'
  const accessToken = isApiKey ? source.kiroApiKey : source.accessToken
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` }
  if (isApiKey) headers.tokentype = 'API_KEY'
  return { accessToken, isApiKey, idp: source.idp || fallbackIdp, headers }
}

async function kiroApiRequest<T>(
  operation: string,
  body: Record<string, unknown>,
  credential: UpstreamKiroCredential,
  idp: string = 'BuilderId',
  email?: string,
  proxyUrl?: string
): Promise<T> {
  const auth = getUpstreamKiroAuth(credential, idp)
  const logTag = email || 'upstream-account'
  console.log(`[Kiro API] ${operation} [${logTag}] ${auth.idp}`)
  const headers: Record<string, string> = {
    accept: 'application/cbor',
    'content-type': 'application/cbor',
    'smithy-protocol': 'rpc-v2-cbor',
    'amz-sdk-invocation-id': generateInvocationId(),
    'amz-sdk-request': 'attempt=1; max=1',
    'x-amz-user-agent': getKiroAmzUserAgent(),
    ...auth.headers
  }
  if (!auth.isApiKey) headers.cookie = `Idp=${auth.idp}; AccessToken=${auth.accessToken}`

  const response = await fetchWithAppProxy(
    `${KIRO_API_BASE}/${operation}`,
    { method: 'POST', headers, body: Buffer.from(encode(body)) },
    proxyUrl
  )

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`
    const errorBuffer = await response.arrayBuffer()
    try {
      const errorData = decode(Buffer.from(errorBuffer)) as {
        __type?: string
        message?: string
        reason?: string
        code?: string
      }
      const errorType = errorData.__type?.split('#').pop()
      const reason = errorData.reason || errorData.code
      errorMessage = [`HTTP ${response.status}`, errorType, reason, errorData.message]
        .filter(Boolean)
        .join(': ')
      console.error('[Kiro API] Error:', { status: response.status, errorType, reason })
    } catch {
      console.error('[Kiro API] Error response was not CBOR:', response.status)
    }
    throw new Error(errorMessage)
  }

  const result = decode(Buffer.from(await response.arrayBuffer())) as T
  console.log(`[Kiro API] ${operation} [${logTag}] → ${response.status}`)
  return result
}

// ============ GetUsageLimits REST API (官方格式) ============
interface UsageLimitsResponse {
  // REST API 实际返回 usageBreakdownList（不是 usageBreakdowns）
  usageBreakdownList?: Array<{
    type?: string
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    overageCharges?: number
    currentOverages?: number
    freeTrialUsage?: {
      currentUsage?: number
      currentUsageWithPrecision?: number
      usageLimit?: number
      usageLimitWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string
    }
    // REST API 直接返回 freeTrialInfo（与 freeTrialUsage 结构相同）
    freeTrialInfo?: {
      currentUsage?: number
      currentUsageWithPrecision?: number
      usageLimit?: number
      usageLimitWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: number | string
    }
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      description?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: number | string // REST API 返回数字时间戳
      redeemedAt?: number | string
      status?: string
    }>
  }>
  nextDateReset?: number | string // Unix 时间戳（秒）或 ISO 字符串
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageSettings?: {
    overageStatus?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

// 辅助函数：将 Unix 时间戳（秒）或 ISO 字符串转换为 ISO 字符串
function normalizeResetDate(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') {
    // Unix 时间戳（秒），转换为毫秒后创建 Date
    return new Date(value * 1000).toISOString()
  }
  return value
}

async function fetchRestApi(
  baseUrl: string,
  path: string,
  credential: UpstreamKiroCredential,
  proxyUrl?: string
): Promise<Response> {
  const auth = getUpstreamKiroAuth(credential)
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...auth.headers,
    'User-Agent': getKiroUserAgent(),
    'x-amz-user-agent': getKiroAmzUserAgent()
  }
  const url = `${baseUrl}${path}`
  return await fetchWithAppProxy(url, { method: 'GET', headers }, proxyUrl)
}

async function getUsageLimitsRest(
  credential: UpstreamKiroCredential,
  profileArn?: string,
  ssoRegion?: string,
  email?: string,
  proxyUrl?: string
): Promise<UsageLimitsResponse> {
  const logTag = email || 'upstream-account'
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] region=${ssoRegion || 'default'}`)

  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true'
  })
  if (profileArn) params.set('profileArn', profileArn)
  const path = `/getUsageLimits?${params.toString()}`
  const primaryBase = getRestApiBase(ssoRegion)
  const fallbackBase = getFallbackRestApiBase(ssoRegion)

  let response = await fetchRestApi(primaryBase, path, credential, proxyUrl)
  if (response.status === 403) {
    console.log(`[Kiro REST API] Primary 403, fallback → ${fallbackBase}`)
    response = await fetchRestApi(fallbackBase, path, credential, proxyUrl)
  }
  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[Kiro REST API] GetUsageLimits failed: ${response.status}`)
    throw new Error(`HTTP ${response.status}: ${errorText}`)
  }

  const result = await response.json()
  console.log(`[Kiro REST API] GetUsageLimits [${logTag}] → ${response.status}`)
  return result
}

// 统一的用量查询接口 - 根据配置选择 API 类型
interface UnifiedUsageResponse {
  usageBreakdownList?: Array<{
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    type?: string
    freeTrialInfo?: {
      freeTrialStatus?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialExpiry?: string
    }
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: string
      status?: string
    }>
  }>
  nextDateReset?: string
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    status?: string
    type?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

async function getUsageAndLimits(
  accessToken: UpstreamKiroCredential,
  idp: string = 'BuilderId',
  profileArn?: string,
  ssoRegion?: string, // SSO 区域，用于选择正确的 REST API 端点
  email?: string, // 用于日志标识
  proxyUrl?: string
): Promise<UnifiedUsageResponse> {
  if (
    currentUsageApiType === 'rest' ||
    (typeof accessToken !== 'string' && accessToken.credentialKind === 'kiro_api_key')
  ) {
    // 使用 REST API (GetUsageLimits)
    const result = await getUsageLimitsRest(accessToken, profileArn, ssoRegion, email, proxyUrl)
    // REST API 返回的字段名和 CBOR API 相同，直接返回
    return {
      usageBreakdownList: result.usageBreakdownList?.map((b) => ({
        resourceType: b.resourceType || b.type,
        displayName: b.displayName,
        displayNamePlural: b.displayNamePlural,
        currentUsage: b.currentUsage,
        currentUsageWithPrecision: b.currentUsageWithPrecision,
        usageLimit: b.usageLimit,
        usageLimitWithPrecision: b.usageLimitWithPrecision,
        currency: b.currency,
        unit: b.unit,
        overageRate: b.overageRate,
        overageCap: b.overageCap,
        type: b.type,
        // REST API 直接返回 freeTrialInfo，CBOR API 返回 freeTrialUsage
        freeTrialInfo: b.freeTrialInfo
          ? {
              freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
              usageLimit: b.freeTrialInfo.usageLimit,
              usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
              currentUsage: b.freeTrialInfo.currentUsage,
              currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
              // REST API 返回数字时间戳，需要转换为 ISO 字符串
              freeTrialExpiry:
                typeof b.freeTrialInfo.freeTrialExpiry === 'number'
                  ? new Date(b.freeTrialInfo.freeTrialExpiry * 1000).toISOString()
                  : b.freeTrialInfo.freeTrialExpiry
            }
          : b.freeTrialUsage
            ? {
                freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
                usageLimit: b.freeTrialUsage.usageLimit,
                usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
                currentUsage: b.freeTrialUsage.currentUsage,
                currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
                freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
              }
            : undefined,
        // 转换 bonuses 中的时间戳为 ISO 字符串
        bonuses: b.bonuses?.map((bonus) => ({
          ...bonus,
          expiresAt:
            typeof bonus.expiresAt === 'number'
              ? new Date(bonus.expiresAt * 1000).toISOString()
              : bonus.expiresAt
        }))
      })),
      // REST API 返回的 nextDateReset 是 Unix 时间戳（秒），需要转换为 ISO 字符串
      nextDateReset: normalizeResetDate(result.nextDateReset),
      subscriptionInfo: result.subscriptionInfo,
      overageConfiguration: result.overageConfiguration,
      userInfo: result.userInfo
    }
  } else {
    // 使用 CBOR API (GetUserUsageAndLimits)
    // CBOR API (app.kiro.dev) 是网页端门户，仅支持 BuilderId 认证
    // Enterprise/IdC 账号可能返回 401，需要 fallback 到 REST API
    try {
      return await kiroApiRequest<UnifiedUsageResponse>(
        'GetUserUsageAndLimits',
        { isEmailRequired: true, origin: 'KIRO_IDE' },
        accessToken,
        idp,
        email,
        proxyUrl
      )
    } catch (cborError) {
      const errorMsg = cborError instanceof Error ? cborError.message : ''
      // CBOR 401/403 时自动 fallback 到 REST API
      if (errorMsg.includes('401') || errorMsg.includes('403')) {
        console.log(`[API] CBOR API failed (${errorMsg}), falling back to REST API...`)
        const result = await getUsageLimitsRest(accessToken, profileArn, ssoRegion, email, proxyUrl)
        return {
          usageBreakdownList: result.usageBreakdownList?.map((b) => ({
            resourceType: b.resourceType || b.type,
            displayName: b.displayName,
            displayNamePlural: b.displayNamePlural,
            currentUsage: b.currentUsage,
            currentUsageWithPrecision: b.currentUsageWithPrecision,
            usageLimit: b.usageLimit,
            usageLimitWithPrecision: b.usageLimitWithPrecision,
            currency: b.currency,
            unit: b.unit,
            overageRate: b.overageRate,
            overageCap: b.overageCap,
            type: b.type,
            freeTrialInfo: b.freeTrialInfo
              ? {
                  freeTrialStatus: b.freeTrialInfo.freeTrialStatus,
                  usageLimit: b.freeTrialInfo.usageLimit,
                  usageLimitWithPrecision: b.freeTrialInfo.usageLimitWithPrecision,
                  currentUsage: b.freeTrialInfo.currentUsage,
                  currentUsageWithPrecision: b.freeTrialInfo.currentUsageWithPrecision,
                  freeTrialExpiry:
                    typeof b.freeTrialInfo.freeTrialExpiry === 'number'
                      ? new Date(b.freeTrialInfo.freeTrialExpiry * 1000).toISOString()
                      : b.freeTrialInfo.freeTrialExpiry
                }
              : b.freeTrialUsage
                ? {
                    freeTrialStatus: b.freeTrialUsage.freeTrialStatus,
                    usageLimit: b.freeTrialUsage.usageLimit,
                    usageLimitWithPrecision: b.freeTrialUsage.usageLimitWithPrecision,
                    currentUsage: b.freeTrialUsage.currentUsage,
                    currentUsageWithPrecision: b.freeTrialUsage.currentUsageWithPrecision,
                    freeTrialExpiry: b.freeTrialUsage.freeTrialExpiry
                  }
                : undefined,
            bonuses: b.bonuses?.map((bonus) => ({
              ...bonus,
              expiresAt:
                typeof bonus.expiresAt === 'number'
                  ? new Date(bonus.expiresAt * 1000).toISOString()
                  : bonus.expiresAt
            }))
          })),
          nextDateReset: normalizeResetDate(result.nextDateReset as unknown as number | string),
          subscriptionInfo: result.subscriptionInfo,
          overageConfiguration: result.overageConfiguration,
          userInfo: result.userInfo
        }
      }
      throw cborError
    }
  }
}

// GetUserInfo API - 只需要 accessToken 即可调用
interface UserInfoResponse {
  email?: string
  userId?: string
  idp?: string
  status?: string
  featureFlags?: string[]
}

async function getUserInfo(
  accessToken: string,
  idp: string = 'BuilderId',
  email?: string,
  proxyUrl?: string
): Promise<UserInfoResponse> {
  return kiroApiRequest<UserInfoResponse>(
    'GetUserInfo',
    { origin: 'KIRO_IDE' },
    accessToken,
    idp,
    email,
    proxyUrl
  )
}

// 定义自定义协议
const PROTOCOL_PREFIX = APP_PROTOCOL_SCHEME

// electron-store 实例（延迟初始化）
let store: {
  get: (key: string, defaultValue?: unknown) => unknown
  set: (key: string, value: unknown) => void
  path: string
} | null = null

// 最后保存的数据（用于崩溃恢复）
let lastSavedData: unknown = null

import { getNextWindowZoomLevel, resolveWindowZoomAction } from './windowZoom'
import { wrapStoreWithBridge, type RawStore } from './accountDb/bridge'
import { withoutSecrets, type AccountLike } from './accountDb/projection'
import {
  accountDbAccountsWithSecrets,
  accountDbAdminTarget,
  accountDbBackupPayload,
  accountDbBridge,
  accountDbStatus,
  activateAccountDb,
  defaultAccountDbConfig,
  accountDbRow,
  ensureFreshAccountDbCredential,
  isAccountDbMode,
  loadAccountDbConfig,
  startAccountDbWatcher,
  startManagedKiroRs,
  stopAccountDbWatcher,
  stopManagedKiroRs,
  type AccountDbConfig
} from './accountDb/runtime'
import { rollbackAccountDb, runMigration } from './accountDb/migrate'
import {
  clearKiroCliSyncState,
  hashRefreshToken,
  readKiroCliSyncState,
  syncKiroCliFromAccountDb,
  writeKiroCliSyncState
} from './accountDb/kiroCliSync'
import { setInPool as setAccountInPool } from './accountDb/adminApi'
import { loadAdminManagedEntries } from './adminManaged/registryStore'
const accountStoreCoordinator = new AccountStoreCoordinator()
type CanonicalKiroCredentialRefreshResult = OidcRefreshResult & {
  expiresAt?: number
  credentialRevision?: string
  reusedCanonical?: boolean
}
const kiroCredentialRefreshSingleflight = new KiroCredentialRefreshSingleflight<OidcRefreshResult>()
const CREDENTIAL_REFRESH_UNAVAILABLE = 'CREDENTIAL_REFRESH_UNAVAILABLE'
const DIAGNOSE_USER_AGENT = 'ProxyRS-Diagnose/1.0'
const EMPTY_ACCOUNT_DATA = {
  accounts: {},
  groups: {},
  tags: {},
  activeAccountId: null
} as const

async function runCredentialRefreshOperation<T>(
  _blockedResult: T,
  operation: () => Promise<T>
): Promise<T> {
  return operation()
}

async function persistRotatedKiroCredentials(
  accountId: string,
  expectedRefreshToken: string | undefined,
  expectedCredentialRevision: string | undefined,
  update: Omit<RotatedKiroCredentialUpdate, 'credentialRevision'>
): Promise<string | null> {
  return accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    if (!store) return null
    const current = store.get('accountData', null)
    const credentialRevision = randomUUID()
    const next = mergeRotatedKiroCredentials(
      current,
      accountId,
      expectedRefreshToken,
      expectedCredentialRevision,
      { ...update, credentialRevision }
    )
    if (!next) return null
    store.set('accountData', next)
    lastSavedData = next
    await createBackup(next)
    return credentialRevision
  })
}

type CanonicalKiroCredentials = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  credentialRevision?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: string
}

async function readCanonicalKiroCredentials(
  accountId: string
): Promise<CanonicalKiroCredentials | null> {
  return accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    if (!store) return null
    const accountData = store.get('accountData', null) as {
      accounts?: Record<string, { credentials?: CanonicalKiroCredentials }>
    } | null
    return accountData?.accounts?.[accountId]?.credentials ?? null
  })
}

type KiroRefreshTransportCandidate = {
  accountId: string
  clientId: string
  clientSecret: string
  region: string
  authMethod?: string
  proxyUrl?: string
}

async function readCanonicalKiroRefreshTransportCandidates(
  refreshToken: string
): Promise<KiroRefreshTransportCandidate[]> {
  return accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    if (!store) return []
    const accountData = store.get('accountData', EMPTY_ACCOUNT_DATA) as {
      accounts?: Record<string, { credentials?: CanonicalKiroCredentials }>
      accountProxyBindings?: Record<string, string>
      proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
    }
    const bindings = accountData.accountProxyBindings ?? {}
    const proxyPool = accountData.proxyPool ?? {}
    return Object.entries(accountData.accounts ?? {})
      .flatMap(([accountId, account]) => {
        const credentials = account.credentials
        if (credentials?.refreshToken !== refreshToken) return []
        const proxyId = bindings[accountId]
        const proxy = proxyId ? proxyPool[proxyId] : undefined
        return [
          {
            accountId,
            clientId: credentials.clientId || '',
            clientSecret: credentials.clientSecret || '',
            region: credentials.region || 'us-east-1',
            authMethod: credentials.authMethod,
            proxyUrl: proxy?.enabled && proxy.status !== 'dead' ? proxy.url : undefined
          }
        ]
      })
      .sort((left, right) =>
        left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0
      )
  })
}

/**
 * 读取账号绑定的出口代理 URL（代理池的「N 账号一个 IP」特性）。
 * 代理被停用或判死时回退到全局出口（undefined）。
 */
function readAccountBoundProxyUrl(accountId: string): string | undefined {
  if (!accountId || !store) return undefined
  try {
    const accountData = store.get('accountData', EMPTY_ACCOUNT_DATA) as {
      accountProxyBindings?: Record<string, string>
      proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
    }
    const proxyId = accountData.accountProxyBindings?.[accountId]
    if (!proxyId) return undefined
    const proxy = accountData.proxyPool?.[proxyId]
    if (!proxy?.enabled || proxy.status === 'dead') return undefined
    return proxy.url
  } catch (err) {
    console.warn('[Store] Failed to read account bound proxy:', err)
    return undefined
  }
}

function canonicalCredentialResult(
  credentials: CanonicalKiroCredentials
): CanonicalKiroCredentialRefreshResult {
  if (!credentials.accessToken || !credentials.refreshToken) {
    return { success: false, error: 'Canonical credential is incomplete' }
  }
  return {
    success: true,
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    expiresIn: credentials.expiresAt
      ? Math.max(0, Math.ceil((credentials.expiresAt - Date.now()) / 1000))
      : undefined,
    credentialRevision: credentials.credentialRevision,
    reusedCanonical: true
  }
}

function refreshKiroCredentialsSingleflight(params: {
  refreshToken: string
  clientId: string
  clientSecret: string
  region: string
  authMethod?: string
  proxyUrl?: string
}): Promise<OidcRefreshResult> {
  const key = buildKiroCredentialRefreshSingleflightKey(params)
  return kiroCredentialRefreshSingleflight.run(key, async () => {
    const storedCandidates = await readCanonicalKiroRefreshTransportCandidates(params.refreshToken)
    const candidates =
      storedCandidates.length > 0
        ? storedCandidates
        : [
            {
              accountId: 'unmanaged',
              clientId: params.clientId,
              clientSecret: params.clientSecret,
              region: params.region,
              authMethod: params.authMethod,
              proxyUrl: params.proxyUrl
            }
          ]
    let lastResult: OidcRefreshResult = {
      success: false,
      error: 'No credential refresh transport available'
    }
    for (const candidate of candidates) {
      lastResult = await refreshTokenByMethod(
        params.refreshToken,
        candidate.clientId,
        candidate.clientSecret,
        candidate.region,
        candidate.authMethod,
        candidate.proxyUrl
      )
      if (lastResult.success) {
        await syncKiroCliAfterRefresh(params.refreshToken, lastResult)
        return lastResult
      }
    }
    return lastResult
  })
}

/**
 * 所有刷新（手动、后台批量、状态检查、验活）都经过 singleflight，在这里统一同步 CLI：
 * 旧 refresh token 一旦轮换就失效，CLI 若还拿着它会被登出。只改 CLI 里与旧 token
 * 匹配的那条，刷新别的账号不影响 CLI。同步失败只记日志，不影响刷新结果。
 */
async function syncKiroCliAfterRefresh(
  oldRefreshToken: string,
  refreshed: OidcRefreshResult
): Promise<void> {
  if (!refreshed.accessToken) return
  try {
    await syncRefreshedKiroCliCredentials(oldRefreshToken, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresIn: refreshed.expiresIn
    })
  } catch (error) {
    console.warn(
      '[KiroCLI] 刷新后同步 CLI 凭据失败:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

/** proxy 自己调上游（模型、订阅、验活）需要的凭据与区域信息 */
interface UpstreamCallContext {
  credential: Exclude<UpstreamKiroCredential, string>
  region?: string
  profileArn?: string
  provider?: string
  authMethod?: string
  proxyUrl?: string
  /** 账号库凭据版本，401 重试时回传给 kiro-rs */
  credentialVersion?: number
}

/**
 * 账号库模式下 proxy 调上游前的取值：先请 kiro-rs 确保 token 新鲜，再从库里读。
 * 非账号库模式或账号未入库时返回 null，调用方沿用渲染层传来的凭据。
 */
async function accountDbUpstreamContext(
  accountId: string | undefined,
  options: { expectedCredentialVersion?: number; force?: boolean } = {}
): Promise<UpstreamCallContext | { error: string } | null> {
  if (!accountId) return null
  const row = accountDbRow(accountId)
  if (!row) return null
  const fresh = await ensureFreshAccountDbCredential({
    accountId,
    expectedCredentialVersion: options.expectedCredentialVersion ?? row.credentialVersion,
    force: options.force
  })
  if (!fresh) return null
  if (!fresh.success || !fresh.accessToken) return { error: fresh.error ?? '无法取得可用凭据' }
  const latest = accountDbRow(accountId) ?? row
  return {
    credential: resolveUpstreamKiroCredential(
      latest.authKind === 'api_key'
        ? {
            credentialKind: 'kiro_api_key',
            kiroApiKey: fresh.accessToken,
            idp: latest.provider ?? undefined
          }
        : {
            credentialKind: 'oauth',
            accessToken: fresh.accessToken,
            idp: latest.provider ?? undefined
          }
    ),
    region: latest.apiRegion ?? latest.authRegion ?? latest.region ?? undefined,
    profileArn: latest.profileArn ?? undefined,
    provider: latest.provider ?? undefined,
    authMethod:
      latest.authKind === 'api_key' ? undefined : latest.authMethod === 'idc' ? 'IdC' : 'social',
    proxyUrl: latest.proxyUrl ?? undefined,
    credentialVersion: Number(fresh.credentialRevision)
  }
}

/** 401 时按账号库凭据版本重试一次：版本已变就用新 token，否则请 kiro-rs 刷新 */
async function withAccountDbRetry<T>(
  accountId: string | undefined,
  run: (context: UpstreamCallContext | null) => Promise<T>,
  initial: UpstreamCallContext | null
): Promise<T> {
  try {
    return await run(initial)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const unauthorized = message.includes('401') || message.includes('Unauthorized')
    if (!unauthorized || !initial?.credentialVersion || !accountId) throw error
    const retry = await accountDbUpstreamContext(accountId, {
      expectedCredentialVersion: initial.credentialVersion,
      force: true
    })
    if (!retry || 'error' in retry) throw error
    console.log(`[AccountDb] 上游 401，已请 kiro-rs 刷新后重试：${accountId}`)
    return await run(retry)
  }
}

async function refreshStoredKiroCredentials(params: {
  accountId: string
  expectedRefreshToken: string
  expectedCredentialRevision?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: string
  proxyUrl?: string
}): Promise<CanonicalKiroCredentialRefreshResult> {
  /*
   * 账号库模式：刷新只在 kiro-rs 发生。这里把请求转过去并返回库中最新凭据，
   * 于是所有入口（手动刷新、状态检查的 401 重试、后台批量、验活、诊断）都自动走新协议。
   * expectedCredentialRevision 是调用方所用 token 的版本，传给 kiro-rs 用于判断
   * "是否已被别处轮换"：已轮换则直接复用新 token，不再多轮换一次。
   */
  const fresh = await ensureFreshAccountDbCredential({
    accountId: params.accountId,
    expectedCredentialVersion: Number(params.expectedCredentialRevision) || undefined
  })
  if (fresh) {
    return fresh.success
      ? {
          ...fresh,
          expiresIn: fresh.expiresAt
            ? Math.max(0, Math.ceil((fresh.expiresAt - Date.now()) / 1000))
            : undefined
        }
      : { success: false, error: fresh.error }
  }

  /*
   * 权威闸门：账号已托管给反代时本地一律不刷。
   *
   * 放在函数最前面而不是散到各调用点——绕过 singleflight 的入口有七八处
   * （手动刷新、CLI 切号、验活、401 重试、导入验活……），散着堵必然漏一处，
   * 漏掉的那处就会重新变成双边抢刷。堵在这里之后，各调用点只需把
   * suppressedByAdmin 映射成合适的提示文案。
   */
  if (isAdminManagedAccount(params.accountId)) {
    return {
      success: false,
      suppressedByAdmin: true,
      error: ADMIN_MANAGED_REFRESH_SUPPRESSED
    }
  }

  const canonical = await readCanonicalKiroCredentials(params.accountId)
  if (!canonical?.refreshToken) {
    return { success: false, error: 'Canonical credential not found' }
  }
  if (
    shouldReuseCanonicalKiroCredentials(
      canonical,
      params.expectedRefreshToken,
      params.expectedCredentialRevision
    )
  ) {
    return canonicalCredentialResult(canonical)
  }

  const refreshResult = await refreshKiroCredentialsSingleflight({
    refreshToken: canonical.refreshToken,
    clientId: canonical.clientId || params.clientId || '',
    clientSecret: canonical.clientSecret || params.clientSecret || '',
    region: canonical.region || params.region || 'us-east-1',
    authMethod: canonical.authMethod || params.authMethod,
    proxyUrl: params.proxyUrl
  })
  if (!refreshResult.success || !refreshResult.accessToken) return refreshResult

  const expiresAt = Date.now() + (refreshResult.expiresIn ?? 3600) * 1000
  const credentialRevision = await persistRotatedKiroCredentials(
    params.accountId,
    canonical.refreshToken,
    canonical.credentialRevision,
    {
      accessToken: refreshResult.accessToken,
      refreshToken: refreshResult.refreshToken || canonical.refreshToken,
      expiresAt
    }
  )
  if (!credentialRevision) {
    const latest = await readCanonicalKiroCredentials(params.accountId)
    return latest
      ? canonicalCredentialResult(latest)
      : { success: false, error: 'Credential changed during refresh' }
  }
  return {
    ...refreshResult,
    refreshToken: refreshResult.refreshToken || canonical.refreshToken,
    expiresAt,
    credentialRevision
  }
}

async function refreshUnmanagedKiroCredentials(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region: string,
  authMethod?: string,
  proxyUrl?: string
): Promise<CanonicalKiroCredentialRefreshResult> {
  /*
   * 这条路径只拿得到 refreshToken（推送探针、导入前验活），没有 accountId，
   * 所以走反查判断托管关系。反查要读账号库，代价不低——只在这两个低频入口用，
   * 不进定时刷新。
   */
  if (await isAdminManagedRefreshToken(refreshToken)) {
    return {
      success: false,
      suppressedByAdmin: true,
      error: ADMIN_MANAGED_REFRESH_SUPPRESSED
    }
  }

  return refreshKiroCredentialsSingleflight({
    refreshToken,
    clientId,
    clientSecret,
    region,
    authMethod,
    proxyUrl
  })
}

function sendRendererEvent(channel: string, value: unknown): void {
  mainWindow?.webContents.send(channel, value)
}

// ============ Kiro CLI 切号与社交凭据续期 ============

type StoredKiroAccountForCli = {
  idp?: string
  profileArn?: string
  credentials?: CanonicalKiroCredentials & {
    provider?: string
    profileArn?: string
    credentialKind?: string
    kiroApiKey?: string
  }
}

async function readStoredKiroAccountForCli(
  accountId: string
): Promise<StoredKiroAccountForCli | null> {
  return accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    if (!store) return null
    const accountData = store.get('accountData', null) as {
      accounts?: Record<string, StoredKiroAccountForCli>
    } | null
    return accountData?.accounts?.[accountId] ?? null
  })
}

/** 写进 CLI 凭据的 profileArn，与 Kiro Account Manager 的 resolveProfileArnForWrite 同口径 */
function resolveKiroCliProfileArn(
  account: StoredKiroAccountForCli,
  isSocial: boolean,
  region: string
): string {
  const stored = account.profileArn || account.credentials?.profileArn
  if (stored && !isPlaceholderProfileArn(stored)) return stored
  if (isSocial) return KIRO_SOCIAL_PROFILE_ARN
  const provider = account.credentials?.provider || account.idp
  if (provider === 'Enterprise' || account.credentials?.authMethod === 'external_idp') {
    return getEnterpriseFallbackArn(region)
  }
  return KIRO_BUILDER_ID_PLACEHOLDER_ARN
}

type KiroCliSwitchResult = {
  dbPath: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  credentialRevision?: string
}

/**
 * 把账号切成 Kiro CLI 当前账号。
 * 切号前强制刷新一次：拿到新 access token，轮换后的凭据先落回账号库，再写 CLI。
 */
async function switchAccountToKiroCli(accountId: string): Promise<KiroCliSwitchResult> {
  const account = await readStoredKiroAccountForCli(accountId)
  const credentials = account?.credentials
  if (!account || !credentials) throw new Error('账号不存在或尚未保存')
  if (credentials.credentialKind === 'kiro_api_key' || credentials.kiroApiKey) {
    throw new Error('Kiro API Key 账号无法切换到 Kiro CLI')
  }
  if (!credentials.refreshToken) throw new Error('缺少 Refresh Token')
  /*
   * 托管账号不能切到 Kiro CLI：它的 refreshToken 早已被反代轮换作废，写进 CLI 的
   * 会是一份死凭据——用户看到「切换成功」，CLI 那边立刻提示登录失效。挡在这里
   * 比让它静默失效好。
   *
   * 账号库模式例外：凭据在库里、kiro-rs 会持续续期，切号写进 CLI 的是当前有效值，
   * 之后由 accountDb/kiroCliSync 把每次续期结果同步给 CLI（CLI 自己那套刷新
   * 因为看到的 token 一直新鲜而不会触发）。
   */
  if (!isAccountDbMode() && isAdminManagedAccount(accountId)) {
    throw new Error('该账号由反代托管，凭据不在本地维护，无法切换到 Kiro CLI')
  }

  const socialProvider = resolveKiroCliSocialProvider(credentials.provider, account.idp)
  const isSocial = socialProvider !== undefined || credentials.authMethod === 'social'
  if (isSocial && !socialProvider) {
    throw new Error('社交登录账号缺少 provider（Github / Google）')
  }
  if (!isSocial && (!credentials.clientId || !credentials.clientSecret)) {
    throw new Error('缺少 OIDC 凭证 (clientId/clientSecret)')
  }

  const dbPath = resolveKiroCliDbPath()
  if (!(await kiroCliDbExists(dbPath))) {
    throw new Error(`未找到 Kiro CLI 数据库（${dbPath}），请先安装并运行一次 kiro-cli`)
  }

  const region = credentials.region || 'us-east-1'
  const refreshed = await refreshStoredKiroCredentials({
    accountId,
    expectedRefreshToken: credentials.refreshToken,
    expectedCredentialRevision: credentials.credentialRevision,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    region,
    authMethod: isSocial ? 'social' : credentials.authMethod,
    proxyUrl: readAccountBoundProxyUrl(accountId)
  })
  if (!refreshed.success || !refreshed.accessToken || !refreshed.refreshToken) {
    throw new Error(`切号前刷新失败：${refreshed.error || '未知错误'}`)
  }

  const expiresAt = refreshed.expiresAt ?? Date.now() + (refreshed.expiresIn ?? 3600) * 1000
  await switchKiroCliAccount(
    {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: new Date(expiresAt).toISOString(),
      region,
      profileArn: resolveKiroCliProfileArn(account, isSocial, region),
      socialProvider,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret
    },
    dbPath
  )
  // 账号库模式：记下"CLI 里这份是我们写的"，之后 kiro-rs 每次续期都同步给 CLI。
  // 只存哈希：核对用得上，泄露风险为零。
  if (isAccountDbMode() && store) {
    const row = accountDbRow(accountId)
    writeKiroCliSyncState(store as unknown as Parameters<typeof writeKiroCliSyncState>[0], {
      accountId,
      refreshTokenHash: hashRefreshToken(refreshed.refreshToken),
      credentialVersion: row?.credentialVersion ?? 0
    })
  }
  console.log(`[KiroCLI] 已切换 Kiro CLI 账号 ${accountId}（${socialProvider ?? 'IdC'}）`)
  return {
    dbPath,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt,
    credentialRevision: refreshed.credentialRevision
  }
}

/**
 * CLI 社交凭据临期续期：在账号库里找 refresh_token 与 CLI 相同的账号并刷新。
 * 刷新成功后 singleflight 已把新凭据同步给 CLI，这里再通知渲染进程更新账号。
 */
async function renewKiroCliSocialCredentials(token: KiroCliSocialToken): Promise<void> {
  /*
   * 账号库模式：CLI 的续期统一走 maintainKiroCliFromAccountDb（它按切号时记下的映射
   * 定位账号，社交与 IdC 都覆盖）。这里按 CLI 手里的 refresh token 反查账号，而
   * kiro-rs 续期后 CLI 那份在同步前会短暂落后，反查不到就会退回"让 CLI 自己刷"，
   * 正是要避免的。
   */
  if (isAccountDbMode()) return
  const [candidate] = await readCanonicalKiroRefreshTransportCandidates(token.refresh_token)
  // CLI 当前账号不在账号库里，交给 kiro-cli 自己续期
  if (!candidate) return
  /*
   * 托管账号不在这里续期：凭据由反代独占刷新，kiro-cli 手里那份副本会在反代轮换后
   * 失效。让 CLI 自己拿旧 token 去刷，正是这次改造要消除的双边抢刷。
   */
  if (isAdminManagedAccount(candidate.accountId)) {
    console.warn(
      `[AdminManaged] kiro-cli 试图为托管账号 ${candidate.accountId} 续期，已跳过；` +
        '该副本会在反代轮换凭据后失效，请在反代侧使用或重新登录'
    )
    return
  }
  const canonical = await readCanonicalKiroCredentials(candidate.accountId)
  const result = await refreshStoredKiroCredentials({
    accountId: candidate.accountId,
    expectedRefreshToken: token.refresh_token,
    expectedCredentialRevision: canonical?.credentialRevision,
    region: token.region || candidate.region,
    authMethod: 'social',
    proxyUrl: candidate.proxyUrl
  })
  if (!result.success || !result.accessToken) {
    console.warn('[KiroCLI] 社交凭据续期失败，一分钟后重试:', result.error)
    return
  }
  // 账号库里已有更新的凭据时不会真的发刷新请求，singleflight 也就不会同步 CLI，这里补一次
  if (result.reusedCanonical) await syncKiroCliAfterRefresh(token.refresh_token, result)
  sendRendererEvent('background-refresh-result', {
    id: candidate.accountId,
    success: true,
    data: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      expiresAt: result.expiresAt,
      credentialRevision: result.credentialRevision
    }
  })
  console.log('[KiroCLI] 社交凭据已续期并同步到 CLI')
}

const kiroCliSocialRenewal = createKiroCliSocialRenewal({
  renew: renewKiroCliSocialCredentials
})

const LEGACY_ACCOUNT_DATA_KEYS = ['switchTarget'] as const
const LEGACY_PROACTIVE_RENEWAL_KEY = 'proactiveRenewalEnabled'

function removeLegacyStorageKeys<T extends object>(
  value: T,
  keys: readonly string[]
): { value: T; changed: boolean } {
  const cleaned = { ...value } as T
  const record = cleaned as Record<string, unknown>
  let changed = false

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      delete record[key]
      changed = true
    }
  }

  return { value: cleaned, changed }
}

let initStorePromise: Promise<void> | null = null

async function initStore(): Promise<void> {
  if (store) return
  if (!initStorePromise) {
    initStorePromise = initStoreInternal().catch((error) => {
      store = null
      initStorePromise = null
      throw error
    })
  }
  return initStorePromise
}

/**
 * 代理池定时验活调度器（主进程常驻）。
 *
 * 写盘统一走 accountStoreCoordinator 的同一把锁，与渲染进程的 save-accounts 串行化：
 * 两侧都是 read-modify-write，不加锁会互相覆盖（渲染进程整份写回会抹掉调度器刚写的验活结果）。
 */
const proxyPoolScheduler = new ProxyPoolScheduler({
  readStore: async () => {
    await initStore()
    return (store!.get('accountData', EMPTY_ACCOUNT_DATA) as ProxyPoolStoreSlice | null) ?? null
  },
  mutateStore: async (mutator) =>
    accountStoreCoordinator.runExclusive(async () => {
      await initStore()
      const current = store!.get('accountData', EMPTY_ACCOUNT_DATA) as ProxyPoolStoreSlice
      const next = mutator(current)
      if (!next) return
      store!.set('accountData', next)
      lastSavedData = next
    }),
  validate: (params) => validateProxyEntry(params),
  notifyRenderer: (payload) => {
    mainWindow?.webContents.send('proxy-pool-validated', payload)
  },
  log: (message) => console.log(message)
})

interface KskAutomationAccountData {
  accounts?: Record<string, KskAutomationStoredAccount>
  groups?: Record<string, { id: string; name: string }>
  activeAccountId?: string | null
  accountProxyBindings?: Record<string, string>
  [key: string]: unknown
}

type KskAutomationSubscriptionType = 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams'

interface KskAutomationStoredKskCredentials {
  credentialKind: 'kiro_api_key'
  kiroApiKey: string
  region: string
  provider: 'BuilderId'
}

interface KskAutomationStoredOAuthCredentials {
  credentialKind: 'oauth'
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  /** IdC 刷新区域；沿用现有账号字段语义。 */
  region: string
  /** Kiro usage API 区域，可能与 IdC 刷新区域不同。 */
  apiRegion?: string
  authMethod: 'IdC'
  provider: 'BuilderId'
  profileArn?: string
  expiresAt?: number
}

type KskAutomationStoredCredentials =
  | KskAutomationStoredKskCredentials
  | KskAutomationStoredOAuthCredentials

interface KskAutomationStoredAccount {
  id: string
  email: string
  userId?: string
  nickname?: string
  idp: 'BuilderId'
  profileArn?: string
  groupId?: string
  tags: string[]
  credentials: KskAutomationStoredCredentials
  subscription: Record<string, unknown> & { type: KskAutomationSubscriptionType }
  usage: Record<string, unknown> & {
    current: number
    limit: number
    percentUsed: number
    lastUpdated: number
  }
  status: 'active' | 'error'
  lastError?: string
  isActive: boolean
  createdAt: number
  lastUsedAt: number
  lastCheckedAt: number
}

type KskAutomationStoredKskAccount = KskAutomationStoredAccount & {
  credentials: KskAutomationStoredKskCredentials
}

function isKskAutomationStoredAccount(
  account: KskAutomationStoredAccount
): account is KskAutomationStoredKskAccount {
  return account.credentials?.credentialKind === 'kiro_api_key'
}

/** 抢号链路沿用旧名，实现与 shared 的 resolveSubscriptionTypeFromTitle 是同一份。 */
function resolveKskSubscriptionType(title: string): KskAutomationSubscriptionType {
  return resolveSubscriptionTypeFromTitle(title)
}

function hasStoredKskAccount(data: KskAutomationAccountData, key: string): boolean {
  return Object.values(data.accounts ?? {}).some(
    (account) =>
      account.credentials?.credentialKind === 'kiro_api_key' &&
      account.credentials.kiroApiKey === key
  )
}

function findStoredOAuthAccount(
  data: KskAutomationAccountData,
  input: HunterOAuthCredential
): KskAutomationStoredAccount | undefined {
  return Object.values(data.accounts ?? {}).find(
    (account) =>
      account.credentials?.credentialKind === 'oauth' &&
      (account.credentials.refreshToken === input.refreshToken ||
        (Boolean(input.profileArn) && account.credentials.profileArn === input.profileArn))
  )
}

function hasSameStoredOAuthCredential(
  account: KskAutomationStoredAccount | undefined,
  input: HunterOAuthCredential
): account is KskAutomationStoredAccount & {
  credentials: KskAutomationStoredOAuthCredentials
} {
  if (account?.credentials.credentialKind !== 'oauth') return false
  return (
    account.credentials.accessToken === input.accessToken &&
    account.credentials.refreshToken === input.refreshToken &&
    (input.clientId === undefined || account.credentials.clientId === input.clientId) &&
    (input.clientSecret === undefined || account.credentials.clientSecret === input.clientSecret) &&
    (input.authRegion === undefined || account.credentials.region === input.authRegion) &&
    (input.apiRegion === undefined ||
      (account.credentials.apiRegion || account.credentials.region) === input.apiRegion) &&
    (input.profileArn === undefined || account.credentials.profileArn === input.profileArn) &&
    (input.expiresAt === undefined || account.credentials.expiresAt === input.expiresAt)
  )
}

/**
 * 验活并入库一个 KSK。
 *
 * 顺序是「先发消息验活，通过再拉 usage 建档」：usage 接口对超额和被风控的号照样返回 200，
 * 只靠它把关会让挂号混进账号库，随后又被全量清理删掉，白折腾一轮还发了邮件。
 * 判死的号返回 rejected=true 而不是抛错——调用方要据此拉黑并同步清理反代，
 * 这与「网络抖动导致入库失败」是两件事，不能混在同一个 catch 里。
 */
async function importProviderKskCredential(
  input: ProviderKskCredential & { groupId?: string; liveness?: KskLivenessOptions }
): Promise<
  ProviderKskCredential & {
    added: boolean
    rejected?: boolean
    /**
     * 新建的账号 id 与入库时的额度快照，供抢号台账建档。
     *
     * 只在真的新建了账号时才有：added=false（重复号）与 rejected（验活判死）
     * 两种情况都没有新账号可记。
     */
    accountId?: string
    usageCurrent?: number
    usageLimit?: number
  }
> {
  const duplicate = await accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    const data = store!.get('accountData', EMPTY_ACCOUNT_DATA) as KskAutomationAccountData
    return hasStoredKskAccount(data, input.key)
  })
  if (duplicate) return { ...input, added: false }

  const probeAccount = toKskProbeAccount(input)
  const verdict = await probeKskAccountLiveness(
    probeAccount,
    await resolveKskLivenessModelId(probeAccount, input.liveness?.model),
    resolveKskLivenessMessage(input.liveness?.message)
  )
  if (verdict === KSK_PROBE_VERDICT.PERMANENTLY_INVALID) {
    return { ...input, added: false, rejected: true }
  }
  // TRANSIENT（超时、限流、5xx）不能判死，也不该入库：留给下一轮重试
  if (verdict !== KSK_PROBE_VERDICT.ALIVE) throw new Error('KSK 验活未能确认，稍后重试')

  const usage = await getUsageAndLimits(
    { credentialKind: 'kiro_api_key', kiroApiKey: input.key, idp: 'BuilderId' },
    'BuilderId',
    undefined,
    input.region
  )
  const creditUsage = usage.usageBreakdownList?.find(
    (item) => item.resourceType === 'CREDIT' || item.displayName === 'Credits'
  )
  const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
  const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
  const freeTrialActive = creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE'
  const freeTrialLimit = freeTrialActive
    ? (creditUsage?.freeTrialInfo?.usageLimitWithPrecision ??
      creditUsage?.freeTrialInfo?.usageLimit ??
      0)
    : 0
  const freeTrialCurrent = freeTrialActive
    ? (creditUsage?.freeTrialInfo?.currentUsageWithPrecision ??
      creditUsage?.freeTrialInfo?.currentUsage ??
      0)
    : 0
  const bonuses = (creditUsage?.bonuses ?? [])
    .filter((bonus) => bonus.status === 'ACTIVE')
    .map((bonus) => ({
      code: bonus.bonusCode || '',
      name: bonus.displayName || '',
      current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
      limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
      expiresAt: bonus.expiresAt
    }))
  const totalLimit =
    baseLimit + freeTrialLimit + bonuses.reduce((sum, bonus) => sum + bonus.limit, 0)
  const totalCurrent =
    baseCurrent + freeTrialCurrent + bonuses.reduce((sum, bonus) => sum + bonus.current, 0)
  const subscriptionTitle = usage.subscriptionInfo?.subscriptionTitle || 'Free'
  const expiresAt = usage.nextDateReset ? new Date(usage.nextDateReset).getTime() : undefined
  const now = Date.now()
  const displayName = usage.userInfo?.email || `Kiro API Key ••••${input.key.slice(-4)}`

  return await accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    const current = store!.get('accountData', EMPTY_ACCOUNT_DATA) as KskAutomationAccountData
    if (hasStoredKskAccount(current, input.key)) return { ...input, added: false }
    if (input.groupId && !current.groups?.[input.groupId]) {
      throw new Error('自动拉取目标分组已不存在，请重新选择分组')
    }

    const account: KskAutomationStoredAccount = {
      id: randomUUID(),
      email: displayName,
      userId: usage.userInfo?.userId || undefined,
      nickname: displayName,
      idp: 'BuilderId',
      groupId: input.groupId,
      tags: [],
      credentials: {
        credentialKind: 'kiro_api_key',
        kiroApiKey: input.key,
        region: input.region,
        provider: 'BuilderId'
      },
      subscription: {
        type: resolveKskSubscriptionType(subscriptionTitle),
        title: subscriptionTitle,
        rawType: usage.subscriptionInfo?.type,
        expiresAt,
        daysRemaining: expiresAt
          ? Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)))
          : undefined,
        managementTarget: usage.subscriptionInfo?.subscriptionManagementTarget,
        upgradeCapability: usage.subscriptionInfo?.upgradeCapability,
        overageCapability: usage.subscriptionInfo?.overageCapability
      },
      usage: {
        current: totalCurrent,
        limit: totalLimit,
        percentUsed: totalLimit > 0 ? (totalCurrent / totalLimit) * 100 : 0,
        lastUpdated: now,
        baseLimit,
        baseCurrent,
        freeTrialLimit,
        freeTrialCurrent,
        freeTrialExpiry: creditUsage?.freeTrialInfo?.freeTrialExpiry,
        bonuses,
        nextResetDate: usage.nextDateReset
      },
      status: 'active',
      isActive: false,
      createdAt: now,
      lastUsedAt: now,
      lastCheckedAt: now
    }
    const next = {
      ...current,
      accounts: { ...(current.accounts ?? {}), [account.id]: account }
    }
    store!.set('accountData', next)
    lastSavedData = next
    await createBackup(next)
    // 带回 id 与额度快照：抢号台账要用它们建档并记下买入基线
    return {
      ...input,
      added: true,
      accountId: account.id,
      usageCurrent: totalCurrent,
      usageLimit: totalLimit
    }
  })
}

async function importProviderOAuthCredential(
  input: HunterOAuthCredential & { groupId?: string }
): Promise<{
  added: boolean
  changed?: boolean
  accountId?: string
  usageCurrent?: number
  usageLimit?: number
}> {
  const duplicate = await accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    const data = store!.get('accountData', EMPTY_ACCOUNT_DATA) as KskAutomationAccountData
    return findStoredOAuthAccount(data, input)
  })
  if (hasSameStoredOAuthCredential(duplicate, input)) {
    return {
      added: false,
      accountId: duplicate.id,
      usageCurrent: duplicate.usage.current,
      usageLimit: duplicate.usage.limit
    }
  }

  let usage: UnifiedUsageResponse | undefined
  try {
    usage = await getUsageAndLimits(
      input.accessToken,
      'BuilderId',
      input.profileArn,
      input.apiRegion || input.region
    )
  } catch {
    /*
     * quick-board 已经付费，验活失败不能丢弃凭证；但未确认可用的 token 也不能进入账号池。
     * 先加密入库为 error，后续用户可在账号页重试检查。
     */
  }

  const creditUsage = usage?.usageBreakdownList?.find(
    (item) => item.resourceType === 'CREDIT' || item.displayName === 'Credits'
  )
  const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
  const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
  const freeTrialActive = creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE'
  const freeTrialLimit = freeTrialActive
    ? (creditUsage?.freeTrialInfo?.usageLimitWithPrecision ??
      creditUsage?.freeTrialInfo?.usageLimit ??
      0)
    : 0
  const freeTrialCurrent = freeTrialActive
    ? (creditUsage?.freeTrialInfo?.currentUsageWithPrecision ??
      creditUsage?.freeTrialInfo?.currentUsage ??
      0)
    : 0
  const bonuses = (creditUsage?.bonuses ?? [])
    .filter((bonus) => bonus.status === 'ACTIVE')
    .map((bonus) => ({
      code: bonus.bonusCode || '',
      name: bonus.displayName || '',
      current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
      limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
      expiresAt: bonus.expiresAt
    }))
  const totalLimit =
    baseLimit + freeTrialLimit + bonuses.reduce((sum, bonus) => sum + bonus.limit, 0)
  const totalCurrent =
    baseCurrent + freeTrialCurrent + bonuses.reduce((sum, bonus) => sum + bonus.current, 0)
  const subscriptionTitle = usage?.subscriptionInfo?.subscriptionTitle || 'Free'
  const subscriptionExpiresAt = usage?.nextDateReset
    ? new Date(usage.nextDateReset).getTime()
    : undefined
  const now = Date.now()
  const displayName = usage?.userInfo?.email || `Kiro OAuth · ${input.region}`
  const refreshCapable = Boolean(input.clientId && input.clientSecret)
  const lastError = !usage
    ? 'OAuth 验活未完成，凭证已保留但不会进入可用账号池'
    : !refreshCapable
      ? 'OAuth 凭证缺少 clientId/clientSecret，到期后无法自动刷新'
      : undefined
  const status: KskAutomationStoredAccount['status'] = usage ? 'active' : 'error'
  const credentials: KskAutomationStoredOAuthCredentials = {
    credentialKind: 'oauth',
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    region: input.authRegion || input.region,
    apiRegion: input.apiRegion || input.region,
    authMethod: 'IdC',
    provider: 'BuilderId',
    profileArn: input.profileArn,
    expiresAt: input.expiresAt
  }
  const subscription: KskAutomationStoredAccount['subscription'] = {
    type: resolveKskSubscriptionType(subscriptionTitle),
    title: subscriptionTitle,
    rawType: usage?.subscriptionInfo?.type,
    expiresAt: subscriptionExpiresAt,
    daysRemaining: subscriptionExpiresAt
      ? Math.max(0, Math.ceil((subscriptionExpiresAt - now) / (1000 * 60 * 60 * 24)))
      : undefined,
    managementTarget: usage?.subscriptionInfo?.subscriptionManagementTarget,
    upgradeCapability: usage?.subscriptionInfo?.upgradeCapability,
    overageCapability: usage?.subscriptionInfo?.overageCapability
  }
  const usageSnapshot: KskAutomationStoredAccount['usage'] = {
    current: totalCurrent,
    limit: totalLimit,
    percentUsed: totalLimit > 0 ? (totalCurrent / totalLimit) * 100 : 0,
    lastUpdated: now,
    baseLimit,
    baseCurrent,
    freeTrialLimit,
    freeTrialCurrent,
    freeTrialExpiry: creditUsage?.freeTrialInfo?.freeTrialExpiry,
    bonuses,
    nextResetDate: usage?.nextDateReset
  }

  return accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    const current = store!.get('accountData', EMPTY_ACCOUNT_DATA) as KskAutomationAccountData
    if (input.groupId && !current.groups?.[input.groupId]) {
      throw new Error('自动拉取目标分组已不存在，请重新选择分组')
    }

    const existing = findStoredOAuthAccount(current, input)
    if (hasSameStoredOAuthCredential(existing, input)) {
      return {
        added: false,
        accountId: existing.id,
        usageCurrent: existing.usage.current,
        usageLimit: existing.usage.limit
      }
    }

    if (existing?.credentials.credentialKind === 'oauth') {
      const updatedRefreshCapable = Boolean(
        (input.clientId ?? existing.credentials.clientId) &&
        (input.clientSecret ?? existing.credentials.clientSecret)
      )
      const updatedLastError = !usage
        ? 'OAuth 验活未完成，凭证已保留但不会进入可用账号池'
        : !updatedRefreshCapable
          ? 'OAuth 凭证缺少 clientId/clientSecret，到期后无法自动刷新'
          : undefined
      const updated: KskAutomationStoredAccount = {
        ...existing,
        email: usage?.userInfo?.email || existing.email,
        userId: usage?.userInfo?.userId || existing.userId,
        nickname: usage?.userInfo?.email || existing.nickname,
        profileArn: input.profileArn ?? existing.profileArn,
        groupId: input.groupId ?? existing.groupId,
        credentials: {
          ...existing.credentials,
          ...credentials,
          clientId: input.clientId ?? existing.credentials.clientId,
          clientSecret: input.clientSecret ?? existing.credentials.clientSecret,
          region: input.authRegion ?? existing.credentials.region,
          apiRegion:
            input.apiRegion ?? existing.credentials.apiRegion ?? existing.credentials.region,
          profileArn: input.profileArn ?? existing.credentials.profileArn,
          expiresAt: input.expiresAt ?? existing.credentials.expiresAt
        },
        subscription: usage ? subscription : existing.subscription,
        usage: usage ? usageSnapshot : existing.usage,
        status,
        lastError: updatedLastError,
        isActive: status === 'active' ? existing.isActive : false,
        lastCheckedAt: now
      }
      const next = {
        ...current,
        accounts: { ...(current.accounts ?? {}), [updated.id]: updated }
      }
      store!.set('accountData', next)
      lastSavedData = next
      await createBackup(next)
      return {
        added: false,
        changed: true,
        accountId: updated.id,
        usageCurrent: updated.usage.current,
        usageLimit: updated.usage.limit
      }
    }

    const account: KskAutomationStoredAccount = {
      id: randomUUID(),
      email: displayName,
      userId: usage?.userInfo?.userId || undefined,
      nickname: displayName,
      idp: 'BuilderId',
      profileArn: input.profileArn,
      groupId: input.groupId,
      tags: [],
      credentials,
      subscription,
      usage: usageSnapshot,
      status,
      lastError,
      isActive: false,
      createdAt: now,
      lastUsedAt: now,
      lastCheckedAt: now
    }
    const next = {
      ...current,
      accounts: { ...(current.accounts ?? {}), [account.id]: account }
    }
    store!.set('accountData', next)
    lastSavedData = next
    await createBackup(next)
    return {
      added: true,
      changed: true,
      accountId: account.id,
      usageCurrent: totalCurrent,
      usageLimit: totalLimit
    }
  })
}

/**
 * 决定验活用哪个模型。
 *
 * 查 usage 不能反映账号能否真正出活（超额账号的 usage API 照样通），所以验活必须发一条真实消息。
 * 代价是每个账号烧一点 credits，因此在任务没指定模型时按 rateMultiplier 取最便宜的一个，
 * 并把输出限到几个 token。模型列表拉不到（网络问题 / 这个账号本身就废了）就退回 Haiku。
 */
async function resolveKskLivenessModelId(
  probeAccount: ProxyAccount,
  configured?: string
): Promise<string> {
  const explicit = configured?.trim()
  if (explicit) return explicit
  try {
    const models = await fetchKiroModels(probeAccount)
    return pickCheapestModelId(models) ?? KSK_CLEANUP_FALLBACK_MODEL
  } catch (error) {
    console.warn(
      '[KSK] Failed to list models for liveness probe, falling back to',
      KSK_CLEANUP_FALLBACK_MODEL,
      error
    )
    return KSK_CLEANUP_FALLBACK_MODEL
  }
}

/** 把一个待入库的 KSK 包成能直接调上游的 ProxyAccount。 */
function toKskProbeAccount(input: { key: string; region: string }): ProxyAccount {
  return {
    id: 'ksk-liveness-probe',
    credentialKind: 'kiro_api_key',
    kiroApiKey: input.key,
    region: input.region,
    provider: 'BuilderId'
  }
}

/**
 * 给单个 KSK 发一条验活消息，返回它是否永久失效。
 *
 * 与账号页「批量验活」面板同一条路径（callKiroApi + 同一句测试消息），
 * 差别只是输出上限压到几个 token，且判定结果被映射成 alive / 永久失效 / 暂时无法确认。
 */
async function probeKskAccountLiveness(
  account: ProxyAccount,
  model: string,
  message: string
): Promise<KskProbeVerdict> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), KSK_CLEANUP_PROBE_TIMEOUT_MS)
  try {
    const payload = openaiToKiro({
      model,
      messages: [{ role: 'user', content: message }],
      stream: false,
      max_tokens: KSK_CLEANUP_MAX_OUTPUT_TOKENS
    })
    await callKiroApi(account, payload, controller.signal)
    return KSK_PROBE_VERDICT.ALIVE
  } catch (error) {
    // 超时是我们自己掐断的，不能算账号失效
    if (controller.signal.aborted) return KSK_PROBE_VERDICT.TRANSIENT
    return classifyKskProbeError(error)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 对目标分组的 KSK 全量发消息验活，删掉判死的号。
 *
 * 每次新增账号后都跑一遍：Provider 给的号会随时挂（超额、被封、订阅到期），
 * 只在入库那一刻验过不够。判死的 key 会回给调用方，用于拉黑与清理反代。
 */
/**
 * 单账号推送到本机 Admin 后的可用性测试：用同一份凭据真发一条消息。
 *
 * 为什么不能只靠 Admin 的 balance 接口：超额号的 balance 照样通（见 credentialCleanup 的注释），
 * 而且 balance 通不代表 Admin 拿这份凭据能刷到 token——authMethod 推错时 balance 也可能过。
 * 所以这里走和账号页「验活」按钮同一条路径（callKiroApi + 同一句测试消息）。
 *
 * OAuth 账号只有 refreshToken 时先换一次 accessToken：callKiroApi 要的是 accessToken，
 * 而推送 candidate 里没有它。刷新按账号自己的 authMethod 选 social / OIDC 端点。
 */
async function probeLocalAdminPushCandidateLiveness(
  candidate: LocalAdminPushCandidate
): Promise<LocalAdminProbeOutcome> {
  const isApiKey = candidate.credentialKind === 'kiro_api_key' || Boolean(candidate.kiroApiKey)
  if (!isApiKey) {
    // OAuth token 已由 Admin 独占维护，本地副本的认证失败不能证明远端凭据失效。
    return { verdict: LOCAL_ADMIN_PROBE_VERDICT.SKIPPED }
  }
  const key = candidate.kiroApiKey?.trim()
  if (!key) {
    return { verdict: LOCAL_ADMIN_PROBE_VERDICT.TRANSIENT, error: '账号缺少 Kiro API Key' }
  }
  const probeAccount: ProxyAccount = {
    id: 'local-admin-push-probe',
    credentialKind: 'kiro_api_key',
    kiroApiKey: key,
    region: candidate.region?.trim() || 'us-east-1',
    provider: 'BuilderId'
  }
  const model = await resolveKskLivenessModelId(probeAccount)
  const message = resolveKskLivenessMessage()
  try {
    const verdict = await probeKskAccountLiveness(probeAccount, model, message)
    if (verdict === KSK_PROBE_VERDICT.ALIVE) {
      return { verdict: LOCAL_ADMIN_PROBE_VERDICT.ALIVE }
    }
    return {
      verdict:
        verdict === KSK_PROBE_VERDICT.PERMANENTLY_INVALID
          ? LOCAL_ADMIN_PROBE_VERDICT.PERMANENTLY_INVALID
          : LOCAL_ADMIN_PROBE_VERDICT.TRANSIENT,
      error:
        verdict === KSK_PROBE_VERDICT.PERMANENTLY_INVALID
          ? '发消息验活失败：账号已失效（认证失败 / 封禁 / 配额耗尽）'
          : '发消息验活暂时无法确认（超时 / 限流 / 上游 5xx）'
    }
  } catch (error) {
    return {
      verdict: LOCAL_ADMIN_PROBE_VERDICT.TRANSIENT,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function cleanupInvalidStoredKskAccounts(
  groupId: string | undefined,
  liveness: KskLivenessOptions = {}
): Promise<KskCredentialCleanupResult> {
  const candidates = await accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    const data = store!.get('accountData', EMPTY_ACCOUNT_DATA) as KskAutomationAccountData
    return Object.values(data.accounts ?? {}).filter(
      (account): account is KskAutomationStoredKskAccount =>
        isKskAutomationStoredAccount(account) &&
        account.groupId === groupId &&
        Boolean(account.credentials.kiroApiKey && account.credentials.region)
    )
  })
  const result: KskCredentialCleanupResult = {
    checked: candidates.length,
    removed: 0,
    retainedTransient: 0,
    errors: []
  }
  if (candidates.length === 0) return result

  const toProxyAccount = (account: (typeof candidates)[number]): ProxyAccount => ({
    id: account.id,
    email: account.email,
    credentialKind: 'kiro_api_key',
    kiroApiKey: account.credentials.kiroApiKey,
    region: account.credentials.region,
    provider: 'BuilderId',
    proxyUrl: readAccountBoundProxyUrl(account.id)
  })

  // 模型列表与账号无关（同一批 KSK 走同一上游），拉一次复用，别每个账号都问一遍
  const model = await resolveKskLivenessModelId(toProxyAccount(candidates[0]), liveness.model)
  const message = resolveKskLivenessMessage(liveness.message)
  const permanentlyInvalid = new Map<string, { key: string; groupId?: string }>()

  await mapWithConcurrency(candidates, KSK_CREDENTIAL_VALIDATION_CONCURRENCY, async (account) => {
    const verdict = await probeKskAccountLiveness(toProxyAccount(account), model, message)
    if (verdict === KSK_PROBE_VERDICT.PERMANENTLY_INVALID) {
      permanentlyInvalid.set(account.id, {
        key: account.credentials.kiroApiKey,
        groupId: account.groupId
      })
    } else if (verdict === KSK_PROBE_VERDICT.TRANSIENT) {
      result.retainedTransient++
    }
    return undefined
  })
  if (permanentlyInvalid.size === 0) return result

  const removedIds = await accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    const current = store!.get('accountData', EMPTY_ACCOUNT_DATA) as KskAutomationAccountData
    const { data: next, removedIds } = removeMatchingInvalidKskAccounts(current, permanentlyInvalid)
    if (removedIds.length === 0) return removedIds
    await deleteFromAccountDb(removedIds)
    store!.set('accountData', next)
    lastSavedData = next
    await createBackup(next)
    return removedIds
  })

  // 台账标「验活判死」：与额度耗尽区分开，前者是号废了，后者是号用完了
  const retiredAt = Date.now()
  await Promise.all(
    removedIds.map((accountId) =>
      markKskLedgerRetired({
        accountId,
        at: retiredAt,
        reason: KSK_LEDGER_RETIRE_REASON.INVALID
      }).catch((error) => {
        console.warn('[KskLedger] Failed to mark retired:', error)
      })
    )
  )

  result.removed = removedIds.length
  result.removedKeys = removedIds
    .map((accountId) => permanentlyInvalid.get(accountId)?.key)
    .filter((key): key is string => Boolean(key))
  return result
}

/**
 * 从本地账号库里删掉一批 apiKeyHash 对应的 KSK 账号，返回被删账号的明文 key。
 *
 * Admin 只回哈希，所以匹配方向是「本地逐个账号算 sha256，看在不在目标哈希集合里」。
 * 明文要回给调用方拉黑：只删不拉黑的话，下一轮 Provider 返回同一个号就会重新入库、
 * 再被同步回 Admin，变成删了又回来的死循环。
 */
/** 账号库模式：store.set 不会删库里的账号（快照可能是旧的），删除必须显式走 kiro-rs */
async function deleteFromAccountDb(ids: readonly string[]): Promise<void> {
  const bridge = accountDbBridge()
  if (!bridge || ids.length === 0) return
  // 被删的账号若正是 CLI 当前账号，停止自动同步（CLI 里那份仍可用到过期）
  if (store) {
    const syncStore = store as unknown as Parameters<typeof clearKiroCliSyncState>[0]
    const state = readKiroCliSyncState(syncStore)
    if (state && ids.includes(state.accountId)) clearKiroCliSyncState(syncStore)
  }
  const failed = await bridge.deleteAccounts(ids, accountDbAdminTarget())
  for (const item of failed) console.warn(`[AccountDb] 删除账号 ${item.id} 失败：${item.reason}`)
}

async function removeStoredKskAccountsByHash(
  hashes: ReadonlySet<string>
): Promise<{ removedIds: string[]; removedKeys: string[] }> {
  if (hashes.size === 0) return { removedIds: [], removedKeys: [] }
  return await accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    const current = store!.get('accountData', EMPTY_ACCOUNT_DATA) as KskAutomationAccountData
    const doomed = new Map<string, { key: string; groupId?: string }>()
    for (const account of Object.values(current.accounts ?? {})) {
      if (!isKskAutomationStoredAccount(account)) continue
      const key = account.credentials.kiroApiKey
      if (!key) continue
      if (!hashes.has(sha256Hex(key))) continue
      doomed.set(account.id, { key, groupId: account.groupId })
    }
    if (doomed.size === 0) return { removedIds: [], removedKeys: [] }

    const { data: next, removedIds } = removeMatchingInvalidKskAccounts(current, doomed)
    if (removedIds.length === 0) return { removedIds: [], removedKeys: [] }
    await deleteFromAccountDb(removedIds)
    store!.set('accountData', next)
    lastSavedData = next
    await createBackup(next)
    return {
      removedIds,
      removedKeys: removedIds
        .map((accountId) => doomed.get(accountId)?.key)
        .filter((key): key is string => Boolean(key))
    }
  })
}

/**
 * 删掉本机 Admin 上额度已耗尽的凭据，并同步清掉本地账号库里的对应账号。
 *
 * 为什么两边都要删：syncKskAccountsToLocalAdmin 会把「本地有、Admin 没有」的号重新
 * POST 回 Admin。只删 Admin 的话，下一次同步就把它推回去了。
 *
 * 判定口径是 balance 拉回来的 remaining <= 0（见 selectExhaustedLocalAdminCredentials），
 * 不掺失败计数：那个会被上游 5xx 污染。封禁与认证失效不在这条链路，靠周期性发消息验活。
 */
async function cleanupExhaustedLocalAdminCredentials(
  credentials: readonly LocalAdminCredentialStats[]
): Promise<LocalAdminExhaustedCleanupSummary> {
  const exhausted = selectExhaustedLocalAdminCredentials(credentials)
  const summary: LocalAdminExhaustedCleanupSummary = {
    ...EMPTY_LOCAL_ADMIN_EXHAUSTED_CLEANUP,
    checked: credentials.filter((credential) => credential.usage).length,
    exhausted: exhausted.length,
    removedMaskedKeys: [],
    errors: []
  }
  if (exhausted.length === 0) return summary

  const target = await resolveLocalAdminTarget()
  const removal = await deleteLocalAdminCredentialsById({
    credentials: exhausted.map((credential) => ({
      credentialId: credential.id,
      disabled: credential.disabled
    })),
    baseUrl: target.baseUrl,
    adminApiKey: target.adminApiKey,
    timeoutSeconds: target.timeoutSeconds,
    fetchImpl: localAdminFetchImpl
  })
  summary.removed = removal.deleted.length
  summary.errors.push(...removal.errors)
  summary.removedMaskedKeys = removal.deleted.map(
    (item) => item.maskedApiKey || `#${item.credentialId}`
  )

  const hashes = new Set(
    removal.deleted.map((item) => item.apiKeyHash).filter((hash): hash is string => Boolean(hash))
  )

  try {
    const local = await removeStoredKskAccountsByHash(hashes)
    summary.removedLocalAccounts = local.removedIds.length
    /*
     * 台账标寿终：额度耗尽是号的正常终点，必须与「被手动删掉」区分开，
     * 否则报表里分不清「烧干了」和「不知道为什么没了」。
     *
     * 必须放在这里而不是提前：台账按账号 id 关联，而账号 id 只有本地清理
     * （removeStoredKskAccountsByHash）才知道——Admin 那边只有哈希。
     * 只标不阻塞：台账是观测数据，写失败不该让清理主流程失败。
     */
    const retiredAt = Date.now()
    await Promise.all(
      local.removedIds.map((accountId) =>
        markKskLedgerRetired({
          accountId,
          at: retiredAt,
          reason: KSK_LEDGER_RETIRE_REASON.EXHAUSTED
        }).catch((error) => {
          console.warn('[KskLedger] Failed to mark retired:', error)
        })
      )
    )
    // 拉黑明文，否则下一轮 Provider 拉取会把同一个号重新入库并推回 Admin
    kskAutomationManager.blacklistKeys(local.removedKeys)
    if (local.removedIds.length > 0) sendKskAutomationAccountsChanged(() => mainWindow)
  } catch (error) {
    /*
     * 本地删失败要显式报出来：Admin 上已经删掉了，本地还留着的话下次同步会把它推回去。
     * 用户看到这条错误才知道得手动处理，否则表现为「删了又出现」。
     */
    summary.errors.push(
      `已从 Admin 删除，但清理本地账号失败：${error instanceof Error ? error.message : String(error)}`
    )
  }
  return summary
}

/**
 * 把当前账号库的用量快照并进抢号台账。
 *
 * 挂在 save-accounts 之后：那是所有账号变更的汇合点，账号页默认 5 分钟一轮的
 * 自动刷新（autoRefreshInterval，带 syncInfo）拉完 usage 也会落到那里，
 * 所以台账不需要自己再开一条轮询。
 *
 * 只读账号库、不打网络：usage 是别人已经拉好的，这里只做差分记账。
 * 台账为空（还没抢到过号）时 updateKskLedgerFromAccounts 会直接跳过写盘。
 */
async function syncKskLedgerFromAccounts(): Promise<void> {
  try {
    const observations = await accountStoreCoordinator.runExclusive(async () => {
      await initStore()
      const data = store!.get('accountData', EMPTY_ACCOUNT_DATA) as {
        accounts?: Record<string, { usage?: { current?: number; limit?: number } }>
      }
      return Object.entries(data.accounts ?? {}).map(([accountId, account]) => ({
        accountId,
        currentUsage: account.usage?.current,
        usageLimit: account.usage?.limit
      }))
    })
    await updateKskLedgerFromAccounts({ observations, at: Date.now() })
  } catch (error) {
    // 台账是观测数据，更新失败不该影响账号保存这条主流程
    console.warn('[KskLedger] Failed to sync from accounts:', error)
  }
}

async function readKskAccountsForLocalAdmin(
  groupId: string
): Promise<Array<{ kiroApiKey: string; region: string; email?: string }>> {
  return await accountStoreCoordinator.runExclusive(async () => {
    await initStore()
    const data = store!.get('accountData', EMPTY_ACCOUNT_DATA) as KskAutomationAccountData
    return Object.values(data.accounts ?? {}).flatMap((account) => {
      if (account.groupId !== groupId || !isKskAutomationStoredAccount(account)) {
        return []
      }
      const key = account.credentials.kiroApiKey.trim()
      const region = account.credentials.region.trim()
      if (!key || !region) return []
      // email 带过去给 Admin 当凭据标题；拿不到 userInfo.email 的号那里是占位串，
      // 由 normalizeLocalAdminEmail 在推送前丢掉
      return [{ kiroApiKey: key, region, email: account.email }]
    })
  })
}

const localAdminFetchImpl: KskAutomationFetch = async (url, init) =>
  (await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    dispatcher: localAdminDirectAgent
  })) as unknown as Response

const kskAutomationManager = new KskAutomationManager({
  readStore: loadKskAutomationStore,
  readTask: loadKskAutomationTask,
  fetchImpl: (url, init) =>
    fetchWithAppProxy(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal
    }),
  localAdminFetchImpl,
  importCredential: importProviderKskCredential,
  readLocalAdminAccounts: readKskAccountsForLocalAdmin,
  cleanupProxyAccounts: cleanupInvalidStoredKskAccounts,
  notifyStatus: (status) => sendKskAutomationStatus(() => mainWindow, status),
  notifyAccountsChanged: () => sendKskAutomationAccountsChanged(() => mainWindow),
  log: (message) => console.log(message)
})

/**
 * 反代统计：周期性从本机 Admin 抓成功/失败计数并攒趋势。
 *
 * 连接信息复用 ksk 任务里的「同步到本机 Admin」配置，不另开一处配置项；
 * 没配置时 manager 自己降级为 unconfigured，不发请求。
 */
const localAdminStatsManager = new LocalAdminStatsManager({
  readTarget: async () => {
    try {
      return await resolveLocalAdminTarget()
    } catch {
      // 没有可用配置属于正常状态，交给 manager 标 unconfigured
      return undefined
    }
  },
  fetchImpl: localAdminFetchImpl,
  cleanupExhausted: cleanupExhaustedLocalAdminCredentials,
  /*
   * 每轮用反代当前的凭据列表核对托管登记表：那边已经被删掉的凭据，对应账号要
   * 恢复本地刷新，否则会永远停在「托管」状态、再也不会刷 token。
   * 这条兜住的是绕过本进程的删除路径（Admin UI、curl、容器重建）。
   */
  onCredentialsObserved: async (credentials) => {
    const { dropped } = await reconcileManagedAccounts(
      credentials.map((credential) => ({
        id: credential.id,
        credentialIdentity: credential.credentialIdentity,
        apiKeyHash: credential.apiKeyHash,
        refreshTokenHash: credential.refreshTokenHash
      }))
    )
    for (const item of dropped) {
      console.log(
        `[AdminManaged] 账号 ${item.accountId} 已不在反代（${item.reason}），恢复本地刷新`
      )
    }
  },
  notifySnapshot: (snapshot) => sendLocalAdminStatsSnapshot(() => mainWindow, snapshot),
  log: (message) => console.log(message)
})

/**
 * 抢号器：3 秒一轮盯商品聚合站点。
 *
 * 复用 importProviderKskCredential 做验活兼入库（它会先发一条测试消息验活，
 * 通过才落库），避免再写一份 KSK 落库逻辑。抢号器不带自己的验活参数，
 * 走默认口径：自动挑最便宜的模型 + 内置测试消息。
 */
let kskHunterSnapshotQueue: Promise<void> = Promise.resolve()

// manager 的通知钩子是同步触发的；串行化异步 IPC，避免 start/final 乱序，失败后继续接下一条。
function queueKskHunterSnapshot(runtime: KskHunterRuntimeNotification): void {
  const send = (): Promise<void> => sendKskHunterStatus(() => mainWindow, kskHunterManager, runtime)
  const next = kskHunterSnapshotQueue.then(send, send)
  kskHunterSnapshotQueue = next.catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[KskHunter] 快照推送失败：${message}`)
  })
}

const kskHunterManager = new KskHunterManager({
  readStore: loadKskHunterStore,
  fetchImpl: (url, init) =>
    fetchWithAppProxy(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal
    }),
  // 下游是 loopback，必须绕开系统代理；与本机 Admin 复用同一个直连 agent
  downstreamFetchImpl: localAdminFetchImpl,
  importCredential: async (input) => {
    if (isHunterOAuthCredential(input)) {
      return importProviderOAuthCredential(input)
    }
    const result = await importProviderKskCredential(input)
    // 验活判死的号必须抛错：抢号器据此把记录标 dead_key 并拒绝推给下游
    if (result.rejected) throw new Error('发消息验活未通过，该号已不可用')
    // accountId 与额度快照透传给台账：前者是关联主键，后者是买入基线
    return {
      added: result.added,
      accountId: result.accountId,
      usageCurrent: result.usageCurrent,
      usageLimit: result.usageLimit
    }
  },
  notifyInStock: ({ linkName, title, region }) => {
    localNotifications.notify(LocalNoticeKind.KskHunterInStock, {
      hunterKey: `${linkName}:${title}:${region}`,
      bodyOverride: `${linkName} · ${title}${region ? `（${region}）` : ''} 已开货，尽快下单。`
    })
  },
  notifyOrdered: ({ linkName, maskedKey, region }) => {
    localNotifications.notify(LocalNoticeKind.KskHunterOrdered, {
      hunterKey: `${linkName}:${maskedKey}`,
      bodyOverride: `${linkName} 已抢到 ${maskedKey}（${region}），正在验活并入库。`
    })
  },
  // 台账报表要显示分组名；台账只存 id，分组可改名，所以每次现查
  readGroupNames: async () =>
    accountStoreCoordinator.runExclusive(async () => {
      await initStore()
      const data = store!.get('accountData', EMPTY_ACCOUNT_DATA) as {
        groups?: Record<string, { name?: string }>
      }
      return Object.fromEntries(
        Object.entries(data.groups ?? {}).map(([id, group]) => [id, group.name || id])
      )
    }),
  notifyAccountsChanged: () => sendKskAutomationAccountsChanged(() => mainWindow),
  notifyBudgetExhausted: ({ scope, channelLabel, spentCny, limitCny }) => {
    // 去重键带本地日期，跨天会再提醒一次。全局是人民币，渠道是原币，所以不硬写 ¥
    const unit = scope === 'global' ? '¥' : ''
    localNotifications.notify(LocalNoticeKind.KskHunterBudgetExhausted, {
      hunterKey: `${hunterLocalDateKey()}:${scope}:${channelLabel ?? 'all'}`,
      bodyOverride:
        `${scope === 'global' ? '全局' : channelLabel} 当日花费 ${unit}${spentCny} 已达上限 ${unit}${limitCny}，` +
        '已暂停自动下单；开货仍会提醒。'
    })
  },
  notifyLowBalance: ({ channel, balanceUnit, thresholdUnit, unitLabel }) => {
    localNotifications.notify(LocalNoticeKind.KskHunterLowBalance, {
      hunterKey: `${hunterLocalDateKey()}:${channel}`,
      bodyOverride: `${KSK_HUNTER_CHANNEL_LABEL[channel]} 余额仅剩 ${balanceUnit} ${unitLabel}（阈值 ${thresholdUnit}），请及时充值。`
    })
  },
  notifySnapshot: (runtime) => {
    queueKskHunterSnapshot(runtime)
  },
  log: (message) => console.log(message)
})

/**
 * 下游对账：把交付账本 + 台账消耗结算成每日 CSV 与可查报表。
 *
 * 积分口径来自抢号台账（它已经处理过按月重置的结转），这里只做区间差分，
 * 不自己再拉一遍 usage——账号页 5 分钟一轮的刷新已经在更新台账了。
 */
const downstreamSettlementManager = new DownstreamSettlementManager({
  readCsvDir: async () => (await loadKskHunterStore()).config.csvExportDir,
  userDataDir: () => app.getPath('userData'),
  readLedgerUsage: async () => {
    const entries = await loadKskLedger()
    return Object.fromEntries(
      entries.map((entry): [string, DownstreamLedgerUsage] => [
        entry.accountId,
        {
          accountId: entry.accountId,
          usedCredits: entry.usedCredits,
          usageLimit: entry.usageLimit,
          state: resolveLedgerState(entry)
        }
      ])
    )
  },
  // 分组名要现查：交付账本只存 id，分组随时可能改名或被删
  readGroupNames: async () =>
    accountStoreCoordinator.runExclusive(async () => {
      await initStore()
      const data = store!.get('accountData', EMPTY_ACCOUNT_DATA) as {
        groups?: Record<string, { name?: string }>
      }
      return Object.fromEntries(
        Object.entries(data.groups ?? {}).map(([id, group]) => [id, group.name || id])
      )
    }),
  log: (message) => console.log(message)
})

/** 未经账号库包装的 electron-store（迁移 / 回滚用） */
let rawAccountStore: (RawStore & { path: string }) | null = null
/** 账号库模式启用但打不开时的原因，启动后弹窗提示 */
let accountDbStartupError: string | null = null
/** 账号库模式下 CLI 当前账号的续期兜底定时器 */
let accountDbCliTimer: NodeJS.Timeout | null = null

/** 账号绑定的出口代理（与 readAccountBoundProxyUrl 同一判据），供账号库同步给 kiro-rs */
function resolveBoundProxyUrl(
  accountId: string,
  data: Record<string, unknown>
): string | undefined {
  const bindings = data.accountProxyBindings as Record<string, string> | undefined
  const pool = data.proxyPool as
    | Record<string, { url?: string; enabled?: boolean; status?: string }>
    | undefined
  const proxyId = bindings?.[accountId]
  const proxy = proxyId ? pool?.[proxyId] : undefined
  if (!proxy?.enabled || proxy.status === 'dead') return undefined
  return proxy.url
}

function resolveKiroRsBinary(config: AccountDbConfig): string {
  if (config.kiroRs.binary) return config.kiroRs.binary
  return app.isPackaged
    ? join(process.resourcesPath, 'kiro-rs')
    : join(app.getAppPath(), '..', 'kiro-rs-src', 'target', 'release', 'kiro-rs')
}

async function initStoreInternal(): Promise<void> {
  const Store = (await import('electron-store')).default
  const path = await import('path')

  const storeInstance = new Store({
    name: APP_ACCOUNT_STORE_NAME,
    encryptionKey: APP_ACCOUNT_STORE_ENCRYPTION_KEY
  })

  store = storeInstance as unknown as typeof store
  rawAccountStore = storeInstance as unknown as RawStore & { path: string }

  // 账号库模式（account-db.json enabled=true）：账号读写转到共享 SQLite，见 accountDb/bridge.ts。
  // 库打不开时不退回 electron-store 里的旧账号，只报错。
  const accountDbConfig = loadAccountDbConfig(app.getPath('userData'))
  if (accountDbConfig?.enabled) {
    try {
      const bridge = activateAccountDb({
        config: accountDbConfig,
        rawStore: storeInstance as unknown as RawStore,
        proxyUrlFor: resolveBoundProxyUrl
      })
      store = wrapStoreWithBridge(storeInstance, bridge) as unknown as typeof store
      console.log(`[AccountDb] 账号库模式已启用：${accountDbConfig.dbPath}`)
    } catch (error) {
      accountDbStartupError = error instanceof Error ? error.message : String(error)
      console.error('[AccountDb] 账号库打开失败，账号数据不可用：', accountDbStartupError)
    }
  }

  // 尝试从备份恢复数据（如果主数据损坏）。备份优先读加密 .enc，兼容旧明文 .json
  // 账号库模式跳过：旧备份里的 token 可能已被轮换作废，恢复回来会被当成新账号重新导入
  try {
    const mainData = storeInstance.get('accountData')
    if (!mainData && !isAccountDbMode()) {
      try {
        const { readSecureBackup } = await import('./secureBackup')
        const backupData = (await readSecureBackup(path.dirname(storeInstance.path))) as {
          accounts?: unknown
        } | null
        if (backupData?.accounts) {
          console.log('[Store] Restoring data from backup...')
          storeInstance.set('accountData', backupData)
          console.log('[Store] Data restored from backup successfully')
        }
      } catch {
        // 备份也不存在，忽略
      }
    }
  } catch (error) {
    console.error('[Store] Error checking backup:', error)
  }

  // 一次性兼容清洗：只删除已移除功能的顶层键，其他数据（含凭据）原样保留。
  try {
    if (storeInstance.has(LEGACY_PROACTIVE_RENEWAL_KEY)) {
      storeInstance.delete(LEGACY_PROACTIVE_RENEWAL_KEY)
    }

    const accountData = storeInstance.get('accountData')
    if (accountData && typeof accountData === 'object' && !Array.isArray(accountData)) {
      const cleaned = removeLegacyStorageKeys(accountData, LEGACY_ACCOUNT_DATA_KEYS)
      if (cleaned.changed) storeInstance.set('accountData', cleaned.value)
    }
  } catch (error) {
    console.error('[Store] Legacy settings cleanup failed:', error)
  }

  try {
    migrateAccountDataIfNeeded()
  } catch (error) {
    console.error('[Store] Account data migration failed:', error)
  }

  // 恢复保存的 Usage API 类型
  const savedUsageApiType = storeInstance.get('usageApiType') as 'rest' | 'cbor' | undefined
  if (savedUsageApiType) {
    setUsageApiType(savedUsageApiType)
  }
}

/**
 * 账号数据迁移（已停用）：曾用于清理 profileArn 占位符，
 * 但 Kiro IDE 内部逻辑依赖该字段存在，移除后导致严重问题，已回退。
 * 保留函数壳和标记写入，防止旧版本回滚时重复执行。
 */
function migrateAccountDataIfNeeded(): void {
  if (!store) return
  const MIGRATION_KEY = 'accountDataMigration'
  const FLAG = 'builderIdArn'
  const migrationState = (store.get(MIGRATION_KEY, {}) as Record<string, number>) || {}
  const accountData = store.get('accountData') as
    | {
        accounts?: Record<
          string,
          { id?: string; provider?: string; profileArn?: string; email?: string }
        >
      }
    | null
    | undefined

  if (!accountData?.accounts) {
    if (!migrationState[FLAG]) {
      store.set(MIGRATION_KEY, { ...migrationState, [FLAG]: 1 })
    }
    return
  }

  // profileArn 占位符不再清理 —— Kiro IDE 内部逻辑依赖该字段存在
  // 保留迁移标记写入以避免旧版本回滚时重复执行

  if (!migrationState[FLAG]) {
    store.set(MIGRATION_KEY, { ...migrationState, [FLAG]: 1 })
  }
}

// ============ 备份节流配置 ============
// 备份是为容灾兜底，不需要每次保存都全量重写文件，按时间节流即可大幅降低磁盘 IO。
const BACKUP_THROTTLE_MS = 5 * 60 * 1000 // 5 分钟最多写一次备份
let lastBackupTime = 0
let pendingBackupData: unknown = null
let pendingBackupTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 创建数据备份（节流）
 * - 距上次备份不足 BACKUP_THROTTLE_MS 时，仅记录数据指针，不立即写盘
 * - 节流窗口结束后，自动 flush 最新一份数据
 * - 退出前可手动调用 flushBackupNow() 强制写盘
 */
async function createBackup(data: unknown): Promise<void> {
  pendingBackupData = accountDbBackupPayload(data)
  const now = Date.now()
  const elapsed = now - lastBackupTime

  if (elapsed >= BACKUP_THROTTLE_MS) {
    // 节流窗口已过，立即写盘
    await writeBackupNow()
    return
  }

  // 在节流窗口内：调度一次延迟 flush（如果尚未调度）
  if (!pendingBackupTimer) {
    const delay = BACKUP_THROTTLE_MS - elapsed
    pendingBackupTimer = setTimeout(() => {
      pendingBackupTimer = null
      void writeBackupNow()
    }, delay)
  }
}

/**
 * 真正执行备份写盘。仅当 pendingBackupData 非空时写入。
 */
async function writeBackupNow(): Promise<void> {
  if (!store || pendingBackupData == null) return
  const data = pendingBackupData
  pendingBackupData = null
  lastBackupTime = Date.now()
  try {
    const path = await import('path')
    const { writeSecureBackup, isSecureBackupAvailable } = await import('./secureBackup')
    await writeSecureBackup(path.dirname(store.path), data)
    console.log(
      `[Backup] Data backup created (${isSecureBackupAvailable() ? 'encrypted' : 'plaintext-fallback'})`
    )
  } catch (error) {
    console.error('[Backup] Failed to create backup:', error)
  }
}

/**
 * 强制 flush 待写的备份（用于退出前兜底）
 */
async function flushBackupNow(): Promise<void> {
  if (pendingBackupTimer) {
    clearTimeout(pendingBackupTimer)
    pendingBackupTimer = null
  }
  if (pendingBackupData != null) {
    await writeBackupNow()
  }
}

let mainWindow: BrowserWindow | null = null

// ============ 账号池 token 主动刷新（主进程调度，不依赖窗口存活）============
//
// 背景：原先只有渲染进程的 setInterval 调度池内 token 刷新，窗口最小化到托盘后会被
// Chromium 后台节流，导致 token 过期数分钟才刷新。这里把"调度"搬到主进程：主进程定时器
// 不受窗口可见性影响，到点读 store 里的账号、刷新即将过期的 token，结果经
// background-refresh-result 事件回流给渲染进程持久化（窗口隐藏但仍存活）。
// 渲染进程定时器保留（已关后台节流）做信息同步/自动换号；两边的 token 刷新由
// poolRefreshInFlightIds 去重，避免对同一 refreshToken 并发刷新把其中一个用作废。
type BackgroundRefreshAccount = {
  id: string
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
}
/** background-batch-refresh 的核心实现（由 IPC 与主进程调度器共用）。在 whenReady 中赋值。 */
let backgroundBatchRefreshImpl:
  | ((
      accounts: BackgroundRefreshAccount[],
      concurrency?: number,
      syncInfo?: boolean
    ) => Promise<{
      success: boolean
      completed: number
      successCount: number
      failedCount: number
      error?: string
    }>)
  | null = null
/** 正在刷新中的账号 ID 去重集合，渲染进程与主进程调度器共享，防止同一 refreshToken 被并发刷新。 */
const poolRefreshInFlightIds = new Set<string>()
let mainPoolRefreshTimer: NodeJS.Timeout | null = null

/** 主进程侧的封禁/挂起判定，镜像渲染进程的 isBannedAccountError */
function isBannedAccountErrorMain(error?: string): boolean {
  if (!error) return false
  const e = error.toLowerCase()
  return (
    e.includes('accountsuspendedexception') ||
    e.includes('account suspended') ||
    e.includes('temporarily_suspended') ||
    e.includes('temporarily suspended') ||
    e.includes('已封禁') ||
    /\b423\b/.test(e)
  )
}

/** 刷新提前量：≥ 2× 检查间隔且不少于 10 分钟，确保 token 不会在两次 tick 之间过期。 */
function mainTokenRefreshLeadMs(intervalMin: number): number {
  return Math.max(intervalMin * 2 * 60 * 1000, 10 * 60 * 1000)
}

/** 读取 store 里的账号，刷新即将过期的池内 token（仅刷 token，信息同步仍由渲染进程负责）。 */
async function runMainPoolTokenRefreshTick(): Promise<void> {
  if (!backgroundBatchRefreshImpl) return
  try {
    if (!store) {
      await initStore()
    }
    if (!store) return
    const data = store.get('accountData') as
      | {
          accounts?: Record<
            string,
            {
              id?: string
              email?: string
              idp?: string
              profileArn?: string
              lastError?: string
              credentials?: {
                refreshToken?: string
                credentialRevision?: string
                clientId?: string
                clientSecret?: string
                region?: string
                authMethod?: string
                accessToken?: string
                provider?: string
                profileArn?: string
                expiresAt?: number
                credentialKind?: 'oauth' | 'kiro_api_key'
                kiroApiKey?: string
              }
            }
          >
          autoRefreshEnabled?: boolean
          autoRefreshInterval?: number
          autoRefreshConcurrency?: number
        }
      | undefined
    if (!data?.accounts) return
    if (data.autoRefreshEnabled === false) return

    const intervalMin = Math.max(1, data.autoRefreshInterval ?? 5)
    const leadMs = mainTokenRefreshLeadMs(intervalMin)
    const concurrency = Math.max(1, Math.min(500, data.autoRefreshConcurrency ?? 100))
    const now = Date.now()

    const toRefresh: BackgroundRefreshAccount[] = []
    for (const [id, acc] of Object.entries(data.accounts)) {
      const creds = acc?.credentials
      const refreshPlan = buildBackgroundRefreshPlan(creds || {}, true)
      if (!refreshPlan.shouldRefreshToken || !creds?.refreshToken) continue
      /*
       * 已交给反代托管的账号由反代独占刷新，本地跳过。
       * 放在入队之前，省掉在途记账与每轮一次的刷屏日志。
       */
      if (isAdminManagedAccount(id)) continue
      if (isBannedAccountErrorMain(acc.lastError)) continue
      const expiresAt = creds.expiresAt
      if (!expiresAt || expiresAt - now > leadMs) continue
      toRefresh.push({
        id,
        idp: acc.idp,
        profileArn: acc.profileArn,
        needsTokenRefresh: true,
        credentials: {
          credentialKind: refreshPlan.credentialKind,
          kiroApiKey: refreshPlan.kiroApiKey,
          refreshToken: creds.refreshToken,
          credentialRevision: creds.credentialRevision,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          region: creds.region,
          authMethod: creds.authMethod,
          accessToken: refreshPlan.accessToken,
          provider: creds.provider,
          profileArn: creds.profileArn
        }
      })
    }

    if (toRefresh.length === 0) return
    console.log(
      `[MainPoolRefresh] ${toRefresh.length} token(s) expiring within ${Math.round(leadMs / 60000)}min, refreshing...`
    )
    await backgroundBatchRefreshImpl(toRefresh, concurrency, false)
  } catch (err) {
    console.warn('[MainPoolRefresh] tick failed:', err instanceof Error ? err.message : err)
  }
}

/** 启动主进程池 token 刷新调度器（不依赖窗口可见/存活）。 */
function startMainPoolTokenRefresh(): void {
  stopMainPoolTokenRefresh()
  // 启动后稍等片刻先跑一次（让 store 与账号池就绪），之后每分钟检查一次；
  // 实际是否需要刷新由 runMainPoolTokenRefreshTick 内按 expiresAt + 提前量判定。
  setTimeout(() => {
    void runMainPoolTokenRefreshTick()
  }, 15_000)
  mainPoolRefreshTimer = setInterval(() => {
    void runMainPoolTokenRefreshTick()
  }, 60_000)
  console.log('[MainPoolRefresh] Scheduler started (main process, checks every 60s)')
}

function stopMainPoolTokenRefresh(): void {
  if (mainPoolRefreshTimer) {
    clearInterval(mainPoolRefreshTimer)
    mainPoolRefreshTimer = null
  }
}

// ============ 托盘相关变量 ============
let traySettings: TraySettings = { ...defaultTraySettings }
let isQuitting = false // 标记是否真正退出应用
let resolvedNotificationLanguage: LocalNoticeLanguage = 'zh'
const RENDERER_NOTICE_KINDS = new Set<LocalNoticeKind>([
  LocalNoticeKind.RegistrationRiskPaused,
  LocalNoticeKind.RegistrationBatchCompleted
])
const localNotifications = new LocalNotificationService(
  () => traySettings,
  () => resolvedNotificationLanguage,
  (page) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('local-notification-navigate', page)
  }
)

// ============ 全局快捷键设置 ============
let showWindowShortcut = process.platform === 'darwin' ? 'Command+Shift+K' : 'Ctrl+Shift+K'

// 加载快捷键设置
async function loadShortcutSettings(): Promise<void> {
  try {
    await initStore()
    const saved = store?.get('showWindowShortcut') as string | undefined
    if (saved) {
      showWindowShortcut = saved
    }
  } catch (error) {
    console.error('[Shortcut] Failed to load shortcut settings:', error)
  }
}

// 保存快捷键设置
async function saveShortcutSettings(): Promise<void> {
  try {
    await initStore()
    store?.set('showWindowShortcut', showWindowShortcut)
  } catch (error) {
    console.error('[Shortcut] Failed to save shortcut settings:', error)
  }
}

// 注册显示主窗口的快捷键
function registerShowWindowShortcut(): void {
  // 先注销所有已注册的快捷键
  globalShortcut.unregisterAll()

  if (!showWindowShortcut) return

  try {
    const success = globalShortcut.register(showWindowShortcut, () => {
      if (mainWindow) {
        // macOS: 显示窗口时恢复 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show()
        }
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    })
    if (success) {
      console.log(`[Shortcut] Registered: ${showWindowShortcut}`)
    } else {
      console.warn(`[Shortcut] Failed to register: ${showWindowShortcut}`)
    }
  } catch (error) {
    console.error('[Shortcut] Error registering shortcut:', error)
  }
}
let currentProxyAccount: {
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
} | null = null
let allAccounts: { id: string; email: string; idp: string; status: string }[] = []

// 加载托盘设置
async function loadTraySettings(): Promise<void> {
  try {
    await initStore()
    const saved = store?.get('traySettings') as TraySettings | undefined
    if (saved) {
      traySettings = { ...defaultTraySettings, ...saved }
    }
  } catch (error) {
    console.error('[Tray] Failed to load tray settings:', error)
  }
}

// 保存托盘设置
async function saveTraySettings(): Promise<void> {
  try {
    await initStore()
    store?.set('traySettings', traySettings)
  } catch (error) {
    console.error('[Tray] Failed to save tray settings:', error)
  }
}

// 初始化托盘
function initTray(): void {
  if (!traySettings.enabled) return

  createTray({
    onShowWindow: () => {
      if (mainWindow) {
        if (process.platform === 'darwin' && app.dock) app.dock.show()
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    },
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
    onRefreshAccount: async () => {
      mainWindow?.webContents.send('tray-refresh-account')
    },
    onSwitchAccount: async () => {
      mainWindow?.webContents.send('tray-switch-account')
    },
    getCurrentAccount: () => currentProxyAccount,
    getAccountList: () => allAccounts
  })

  setTrayTooltip(`${APP_NAME} v${app.getVersion()}`)
}

function createWindow(): void {
  // Create the browser window.
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    title: `${APP_NAME} v${app.getVersion()}`,
    width: 1200, // 刚好容纳 3 列卡片 (340*3 + 16*2 + 边距)
    height: 1200,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon,
    // 自定义 titlebar：mac 保留红绿黄灯 + 隐藏标题栏；win/linux 完全无 frame
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    // 不透明窗口（关闭透明 + Mica/Vibrancy 避免桌面元素干扰）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 关闭后台节流：最小化到托盘后窗口被隐藏，Chromium 默认会把渲染进程里的
      // setInterval（含 token 自动刷新定时器）重度降频（对齐到约每分钟甚至更慢），
      // 导致挂托盘时 token 过期好几分钟才刷新。关掉它保证定时器照常运行。
      backgroundThrottling: false
    }
  })

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const action = resolveWindowZoomAction(input)
    if (!action || !mainWindow) return

    event.preventDefault()
    const currentLevel = mainWindow.webContents.getZoomLevel()
    mainWindow.webContents.setZoomLevel(getNextWindowZoomLevel(currentLevel, action))
  })

  // ============ 自定义 titlebar IPC ============
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window-maximize-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window-maximize-changed', false))

  mainWindow.on('ready-to-show', () => {
    // 设置带版本号的标题（HTML 加载后会覆盖初始标题）
    mainWindow?.setTitle(`${APP_NAME} v${app.getVersion()}`)
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    // 托盘最小化逻辑 - 必须同步检查并调用 preventDefault
    if (traySettings.enabled && !isQuitting) {
      if (traySettings.closeAction === 'minimize') {
        // 直接最小化到托盘
        event.preventDefault()
        mainWindow?.hide()
        // macOS: 隐藏窗口时隐藏 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.hide()
        }
        return
      } else if (traySettings.closeAction === 'ask' && mainWindow) {
        // 询问用户 - 先阻止关闭，再异步处理
        event.preventDefault()
        // 通知渲染进程显示自定义对话框
        mainWindow.webContents.send('show-close-confirm-dialog')
        return
      }
      // closeAction === 'quit' 时继续关闭流程
    }

    // 窗口关闭前把账号写入排到事务锁后，避免覆盖恢复或迁移结果。
    if (lastSavedData && store) {
      void accountStoreCoordinator.runExclusive(async () => {
        try {
          console.log('[Window] Saving data before close...')
          store!.set('accountData', lastSavedData)
          await createBackup(lastSavedData)
          console.log('[Window] Data saved successfully')
        } catch (error) {
          console.error('[Window] Failed to save data:', error)
        }
      })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 注册自定义协议
function registerProtocol(): void {
  // 先注销旧的注册（防止上次异常退出未注销）
  unregisterProtocol()

  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [join(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Registered ${PROTOCOL_PREFIX}:// protocol`)
}

// 注销自定义协议 (应用退出时调用)
function unregisterProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX, process.execPath, [join(process.argv[1])])
    }
  } else {
    app.removeAsDefaultProtocolClient(PROTOCOL_PREFIX)
  }
  console.log(`[Protocol] Unregistered ${PROTOCOL_PREFIX}:// protocol`)
}

// 处理协议 URL (用于 OAuth 回调)
function handleProtocolUrl(url: string): void {
  if (!url.startsWith(`${PROTOCOL_PREFIX}://`)) return

  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.replace(/^\/+/, '')

    // 处理 auth 回调
    if (pathname === 'auth/callback' || urlObj.host === 'auth') {
      const code = urlObj.searchParams.get('code')
      const state = urlObj.searchParams.get('state')

      if (code && state && mainWindow) {
        mainWindow.webContents.send('auth-callback', { code, state })
        mainWindow.focus()
      }
    }
  } catch (error) {
    console.error('Failed to parse protocol URL:', error)
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // 初始化日志系统（尽早拦截，确保所有 console 输出都进入日志存储）
  proxyLogStore.initialize(app.getPath('userData'))
  interceptConsole()
  await initStore()

  // 账号库迁移 / 回滚命令行（改造方案 P5）：执行完即退出，不进入正常启动
  if (
    process.argv.some(
      (arg) => arg.startsWith('--migrate-account-db') || arg === '--rollback-account-db'
    )
  ) {
    await runAccountDbCommand(process.argv)
    return
  }
  if (accountDbStartupError) {
    dialog.showErrorBox(
      '账号库不可用',
      `${accountDbStartupError}\n\n账号操作已停用，请检查账号库文件后重启。`
    )
  }
  if (isAccountDbMode()) void startAccountDbServices()

  // 注册自定义协议
  registerProtocol()

  // 加载托盘设置并初始化托盘
  await loadTraySettings()
  initTray()

  // Set app user model id for windows
  electronApp.setAppUserModelId(APP_ID)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC: 打开外部链接
  ipcMain.on('open-external', (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url)
    }
  })

  ipcMain.on('open-incognito-browser', (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      openBrowserInPrivateMode(url)
    }
  })

  // 登录流程走到终态（账号已入库 / 失败 / 取消）后，由渲染进程关闭无痕浏览器
  ipcMain.on('close-incognito-browser', () => {
    closePrivateBrowserWindow()
  })

  // ============ 注册功能 IPC ============
  registerRegistrationHandlers(() => mainWindow)

  // 代理池定时验活：读盘自启，不依赖渲染进程是否打开过代理池页面
  void proxyPoolScheduler.start().catch((err) => {
    console.warn('[ProxyPoolScheduler] Failed to start:', err)
  })

  // ============ KSK Provider 自动拉取与本机 Admin 同步 IPC ============
  registerKskAutomationIpcHandlers({
    getManager: () => kskAutomationManager,
    getMainWindow: () => mainWindow,
    localAdminFetchImpl,
    probeLocalAdminPushLiveness: probeLocalAdminPushCandidateLiveness
  })
  void kskAutomationManager.start().catch((err) => {
    console.warn('[KskAutomation] Failed to start:', err)
  })

  // ============ 反代统计（本机 Admin 成功/失败/用量）IPC ============
  registerLocalAdminStatsIpcHandlers({
    getManager: () => localAdminStatsManager,
    getMainWindow: () => mainWindow
  })
  void localAdminStatsManager.start().catch((err) => {
    console.warn('[LocalAdminStats] Failed to start:', err)
  })

  // ============ KSK 抢号（商品聚合站点监控）IPC ============
  registerKskHunterIpcHandlers({
    getManager: () => kskHunterManager,
    getMainWindow: () => mainWindow
  })
  void kskHunterManager.start().catch((err) => {
    console.warn('[KskHunter] Failed to start:', err)
  })

  // ============ 下游对账（交付账本、每日 CSV 存档）IPC ============
  registerDownstreamSettlementIpcHandlers({
    getManager: () => downstreamSettlementManager,
    getMainWindow: () => mainWindow,
    saveCsvDir: async (dir) => {
      await updateKskHunterConfig({ csvExportDir: dir }, undefined)
    }
  })
  void downstreamSettlementManager.start().catch((err) => {
    console.warn('[DownstreamSettlement] Failed to start:', err)
  })

  // ============ Cursor 账号管理（多账号、切号、用量）IPC ============
  const cursorAutoRefreshScheduler = new CursorAutoRefreshScheduler({
    onRefreshed: () => sendCursorAccountsChanged(() => mainWindow)
  })
  registerCursorAccountsIpcHandlers({
    getMainWindow: () => mainWindow,
    getScheduler: () => cursorAutoRefreshScheduler
  })
  void cursorAutoRefreshScheduler.start().catch((err) => {
    console.warn('[CursorAutoRefresh] Failed to start:', err)
  })

  // ============ Grok Bot 账号管理（切号 + 同步 relay）IPC ============
  registerGrokAccountsIpcHandlers({
    getMainWindow: () => mainWindow
  })

  // ============ 托盘相关 IPC ============

  // IPC: 获取托盘设置
  ipcMain.handle('get-tray-settings', () => {
    return traySettings
  })

  // 渲染进程只能请求固定类型的本机通知，文案由主进程统一生成。
  ipcMain.handle(
    'local-notification',
    (_event, kind: LocalNoticeKind, input?: { batchId?: string }) => {
      if (!RENDERER_NOTICE_KINDS.has(kind)) return
      localNotifications.notify(kind, {
        batchId: typeof input?.batchId === 'string' ? input.batchId : undefined
      })
    }
  )

  // ============ 自定义 titlebar IPC ============
  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize-toggle', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window-close', () => mainWindow?.close())
  ipcMain.handle('window-is-maximized', () => !!mainWindow?.isMaximized())
  ipcMain.handle('window-get-platform', () => process.platform)

  // IPC: 获取显示主窗口快捷键
  ipcMain.handle('get-show-window-shortcut', () => {
    return showWindowShortcut
  })

  // IPC: 设置显示主窗口快捷键
  ipcMain.handle('set-show-window-shortcut', async (_event, shortcut: string) => {
    try {
      showWindowShortcut = shortcut
      await saveShortcutSettings()
      registerShowWindowShortcut()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // IPC: 保存托盘设置
  ipcMain.handle('save-tray-settings', async (_event, settings: Partial<TraySettings>) => {
    try {
      traySettings = { ...traySettings, ...settings }
      await saveTraySettings()

      // 根据设置启用/禁用托盘
      if (settings.enabled !== undefined) {
        if (settings.enabled) {
          initTray()
        } else {
          destroyTray()
        }
      }

      return { success: true }
    } catch (error) {
      console.error('[Tray] Failed to save settings:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // IPC: 更新托盘账户信息（从渲染进程调用）
  ipcMain.on('update-tray-account', (_event, account: typeof currentProxyAccount) => {
    currentProxyAccount = account
    updateCurrentAccount(account)

    // 更新托盘提示
    if (account) {
      setTrayTooltip(`${APP_NAME}\n当前账户: ${account.email}`)
    } else {
      setTrayTooltip(`${APP_NAME} v${app.getVersion()}`)
    }
  })

  // IPC: 更新托盘账户列表（从渲染进程调用）
  ipcMain.on('update-tray-account-list', (_event, accounts: typeof allAccounts) => {
    allAccounts = accounts
    updateAccountList(accounts)
  })

  // IPC: 刷新托盘菜单
  ipcMain.on('refresh-tray-menu', () => {
    updateTrayMenu()
  })

  // IPC: 更新托盘语言
  ipcMain.on('update-tray-language', (_event, language: 'en' | 'zh') => {
    resolvedNotificationLanguage = language
    updateTrayLanguage(language)
  })

  // IPC: 关闭确认对话框响应
  ipcMain.on(
    'close-confirm-response',
    (_event, action: 'minimize' | 'quit' | 'cancel', rememberChoice: boolean) => {
      if (action === 'minimize') {
        mainWindow?.hide()
        // macOS: 隐藏窗口时隐藏 Dock 图标
        if (process.platform === 'darwin' && app.dock) {
          app.dock.hide()
        }
      } else if (action === 'quit') {
        // 如果用户选择记住选择
        if (rememberChoice) {
          traySettings.closeAction = 'quit'
          saveTraySettings()
        }
        isQuitting = true
        app.quit()
      }
      // cancel 时不做任何操作

      // 如果用户选择记住"最小化"选择
      if (action === 'minimize' && rememberChoice) {
        traySettings.closeAction = 'minimize'
        saveTraySettings()
      }
    }
  )

  // IPC: 获取应用版本
  ipcMain.handle('get-app-version', () => {
    return app.getVersion()
  })

  // ============ 一键诊断 ============
  /**
   * 测试一组目标 URL 的连通性（用于诊断面板）
   * 支持指定代理 URL；返回每个目标的延迟与错误
   */
  ipcMain.handle(
    'diagnose:run',
    async (
      _event,
      params: {
        proxyUrl?: string
        targets: Array<{
          id: string
          label: string
          url: string
          timeoutMs?: number
          expectStatus?: number[]
        }>
      }
    ) => {
      const { proxyUrl, targets } = params || {}
      const agent = proxyUrl ? safeCreateProxyAgent(proxyUrl) : undefined

      const results = await Promise.all(
        (targets || []).map(async (t) => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), t.timeoutMs ?? 8000)
          const start = Date.now()
          try {
            const init: UndiciRequestInit = {
              method: 'GET',
              signal: controller.signal,
              headers: { 'User-Agent': DIAGNOSE_USER_AGENT }
            }
            if (agent) init.dispatcher = agent
            const resp = await undiciFetch(t.url, init)
            const latencyMs = Date.now() - start
            const expected = t.expectStatus
            const ok = expected
              ? expected.includes(resp.status)
              : resp.status >= 200 && resp.status < 400
            return {
              id: t.id,
              label: t.label,
              url: t.url,
              success: ok,
              httpStatus: resp.status,
              latencyMs,
              error: ok ? undefined : `HTTP ${resp.status}`
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            return {
              id: t.id,
              label: t.label,
              url: t.url,
              success: false,
              latencyMs: Date.now() - start,
              error: controller.signal.aborted ? '超时' : errMsg
            }
          } finally {
            clearTimeout(timer)
          }
        })
      )

      return { results }
    }
  )

  // ============ 代理池验活 ============
  // 手动验活 + 代理链诊断的 IPC handler 已拆分到独立模块，便于后续维护
  registerProxyPoolIpcHandlers()

  // ============ 代理池定时验活 ============
  /**
   * 定时验活由主进程常驻调度器负责（原先挂在渲染进程 ProxyPoolPage 的 useEffect 上，
   * 页面切走或进程重启就失效）。渲染进程改了 autoValidateIntervalMin 后调用此接口重启调度。
   */
  ipcMain.handle('proxy-pool:restart-scheduler', async () => {
    try {
      await proxyPoolScheduler.start()
      return { success: true, running: proxyPoolScheduler.isRunning }
    } catch (err) {
      console.error('[proxy-pool:restart-scheduler] error:', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ============ 通用 HTTP 诊断探测 ============
  /**
   * 使用应用代理设置发起一次 GET/HEAD 请求，返回延迟、状态码、错误信息。
   * 用于"一键诊断"面板中检测 Kiro API / 邮箱服务 / 公网连通性。
   */
  ipcMain.handle(
    'diagnose:http-probe',
    async (
      _event,
      params: {
        url: string
        method?: 'GET' | 'HEAD'
        timeoutMs?: number
      }
    ) => {
      const { url, method = 'GET', timeoutMs = 5000 } = params || {}
      if (!url) return { success: false, error: 'Missing url' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const start = Date.now()
      try {
        const resp = await fetchWithAppProxy(url, {
          method,
          signal: controller.signal,
          headers: { 'User-Agent': DIAGNOSE_USER_AGENT }
        })
        const latencyMs = Date.now() - start
        return { success: resp.ok, latencyMs, status: resp.status }
      } catch (err) {
        const isAbort = controller.signal.aborted
        return {
          success: false,
          latencyMs: Date.now() - start,
          error: isAbort
            ? `Timeout (${timeoutMs}ms)`
            : err instanceof Error
              ? err.message
              : String(err)
        }
      } finally {
        clearTimeout(timer)
      }
    }
  )

  // IPC: 账号测活 —— 给指定账号的指定模型发一条真实消息（callKiroApi）
  // 给指定模型发一条测试消息，验证账号是否能正常返回，用于一键诊断"账号测活"功能
  ipcMain.handle(
    'diagnose:account-liveness',
    async (
      _event,
      params: {
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
      }
    ) =>
      runCredentialRefreshOperation(
        { success: false as const, error: CREDENTIAL_REFRESH_UNAVAILABLE, latencyMs: 0 },
        async () => {
          const acc = params?.account
          const model = (params?.model || 'claude-sonnet-4.5').trim()
          const message = (params?.message || 'Hi, reply with "pong" only.').trim()
          const timeoutMs = params?.timeoutMs ?? 45000
          const start = Date.now()

          /*
           * 托管账号的 token 由反代维护，本地这份要么已过期、要么根本刷不出来，
           * 发不出消息级验活。改用反代的余额接口：能查出余额就说明反代拿这份凭据
           * 成功通过了上游认证，比「本地 token 还在」更接近事实。
           *
           * 局限：反代对「不允许查额度」的账号（如 Enterprise）会返回错误，这类
           * 账号在这里会显示验活失败，而它其实可能是好的。要彻底解决得靠反代新增
           * 一个发消息探针端点。
           */
          if (acc?.id && isAdminManagedAccount(acc.id)) {
            const managedEntry = adminManagedEntry(acc.id)
            if (!managedEntry) {
              return { success: false, error: '托管登记缺失，请重新推送该账号', latencyMs: 0 }
            }
            const probeStart = Date.now()
            try {
              const target = await resolveLocalAdminTarget()
              const { usage, errors } = await fetchLocalAdminUsage(
                { ...target, fetchImpl: localAdminFetchImpl },
                [managedEntry.credentialId],
                undefined,
                true
              )
              if (usage.size > 0) {
                return { success: true, latencyMs: Date.now() - probeStart }
              }
              return {
                success: false,
                error: errors[0] ?? '反代未返回该凭据的余额',
                latencyMs: Date.now() - probeStart
              }
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                latencyMs: Date.now() - probeStart
              }
            }
          }

          const isApiKeyAccount = acc?.credentialKind === 'kiro_api_key'
          if (!acc || (isApiKeyAccount ? !acc.kiroApiKey : !acc.accessToken)) {
            return { success: false, error: '账号缺少上游凭据', latencyMs: 0 }
          }

          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          try {
            // 1) Token 即将过期/已过期 → 先刷新（走账号绑定代理）
            let accessToken = acc.accessToken
            let refreshedCredentials:
              | {
                  accessToken: string
                  refreshToken?: string
                  expiresAt?: number
                  credentialRevision?: string
                }
              | undefined
            const needsRefresh = acc.expiresAt ? acc.expiresAt - Date.now() < 60_000 : false
            if (!isApiKeyAccount && needsRefresh && acc.refreshToken) {
              try {
                const r = acc.id
                  ? await refreshStoredKiroCredentials({
                      accountId: acc.id,
                      expectedRefreshToken: acc.refreshToken,
                      expectedCredentialRevision: acc.credentialRevision,
                      clientId: acc.clientId,
                      clientSecret: acc.clientSecret,
                      region: acc.region,
                      authMethod: acc.authMethod,
                      proxyUrl: acc.proxyUrl
                    })
                  : await refreshUnmanagedKiroCredentials(
                      acc.refreshToken,
                      acc.clientId || '',
                      acc.clientSecret || '',
                      acc.region || 'us-east-1',
                      acc.authMethod,
                      acc.proxyUrl
                    )
                if (r.success && r.accessToken) {
                  accessToken = r.accessToken
                  refreshedCredentials = {
                    accessToken: r.accessToken,
                    refreshToken: r.refreshToken || acc.refreshToken,
                    expiresAt: r.expiresAt ?? Date.now() + (r.expiresIn ?? 3600) * 1000,
                    credentialRevision: r.credentialRevision
                  }
                }
              } catch {
                /* 刷新失败则用原 token 尝试，让真实错误暴露出来 */
              }
            }

            // 2) 构建 ProxyAccount（callKiroApi 需要的账号结构）
            const proxyAccount: ProxyAccount = {
              id: acc.id || 'diagnose',
              email: acc.email,
              accessToken,
              refreshToken: acc.refreshToken,
              clientId: acc.clientId,
              clientSecret: acc.clientSecret,
              region: acc.region || 'us-east-1',
              authMethod: acc.authMethod,
              provider: acc.provider,
              profileArn: acc.profileArn,
              proxyUrl: acc.proxyUrl,
              expiresAt: acc.expiresAt,
              credentialKind: acc.credentialKind,
              kiroApiKey: acc.kiroApiKey,
              preferredEndpoint: acc.preferredEndpoint,
              endpointFallbackOrder: acc.endpointFallbackOrder,
              endpointFallbackAfterFailures: acc.endpointFallbackAfterFailures
            }

            // 3) 构建最小 OpenAI chat 请求 → 转 Kiro payload
            const payload = openaiToKiro(
              {
                model,
                messages: [{ role: 'user', content: message }],
                stream: false,
                max_tokens: 64
              },
              proxyAccount.profileArn
            )

            // 4) 调用 Kiro API
            const result = await callKiroApi(proxyAccount, payload, controller.signal)
            const latencyMs = Date.now() - start
            const content = (result.content || '').trim()
            return {
              success: true,
              latencyMs,
              model,
              content: content.slice(0, 500),
              usage: {
                inputTokens: result.usage?.inputTokens || 0,
                outputTokens: result.usage?.outputTokens || 0,
                credits: result.usage?.credits || 0
              },
              credentials: refreshedCredentials
            }
          } catch (err) {
            const isAbort = controller.signal.aborted
            const rawMsg = err instanceof Error ? err.message : String(err)
            return {
              success: false,
              latencyMs: Date.now() - start,
              model,
              error: isAbort ? `超时 (${timeoutMs}ms)` : rawMsg
            }
          } finally {
            clearTimeout(timer)
          }
        }
      )
  )

  // IPC: 加载账号数据
  ipcMain.handle('load-accounts', async () => {
    try {
      await initStore()
      const data = store!.get('accountData', EMPTY_ACCOUNT_DATA)
      if (!isAccountDbMode() || !data || typeof data !== 'object') return data
      // 账号库模式：普通列表不下发 token 明文，只给"有没有"的标志
      const record = data as { accounts?: Record<string, AccountLike> }
      return {
        ...record,
        accounts: Object.fromEntries(
          Object.entries(record.accounts ?? {}).map(([id, account]) => [
            id,
            withoutSecrets(account)
          ])
        )
      }
    } catch (error) {
      console.error('Failed to load accounts:', error)
      return null
    }
  })

  // IPC: 取带凭据的账号（导出 / 复制凭据这类显式操作；账号库模式下列表已脱敏）
  ipcMain.handle('account-db:accounts-with-secrets', async (_event, ids: unknown) => {
    await initStore()
    if (!isAccountDbMode()) return null
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    return accountDbAccountsWithSecrets(list)
  })

  // IPC: 删除账号（账号库模式经 kiro-rs 删除；旧模式由 save-accounts 快照完成，这里无操作）
  ipcMain.handle('account-db:delete', async (_event, ids: unknown) => {
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    const bridge = accountDbBridge()
    if (!bridge) return { success: true, failed: [] }
    const failed = await accountStoreCoordinator.runExclusive(() =>
      bridge.deleteAccounts(list, accountDbAdminTarget())
    )
    return { success: failed.length === 0, failed }
  })

  // IPC: 加入 / 移出反代号池（账号库模式；号池成员才接反代请求）
  ipcMain.handle('account-db:set-in-pool', async (_event, accountId: string, inPool: boolean) => {
    await initStore()
    const row = accountDbRow(accountId)
    if (!row) return { success: false, error: '账号尚未进入账号库，请稍后重试' }
    const target = accountDbAdminTarget()
    if (!target) return { success: false, error: 'kiro-rs 尚未就绪' }
    try {
      await setAccountInPool(target, row.id, inPool)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // IPC: 账号库状态（是否启用、kiro-rs 子进程状态、待导入数量）
  ipcMain.handle('account-db:status', () => ({
    ...accountDbStatus(),
    error: accountDbStartupError ?? undefined
  }))

  // IPC: 保存账号数据
  ipcMain.handle('save-accounts', async (_event, data) => {
    await accountStoreCoordinator.runExclusive(async () => {
      try {
        await initStore()
        const current = store!.get('accountData', EMPTY_ACCOUNT_DATA)
        const merged = mergeAccountDataPreservingRotatedKiroCredentials(current, data)
        store!.set('accountData', merged)

        // 保存最后的数据（用于崩溃恢复）
        lastSavedData = merged

        // 每次保存时也创建备份
        await createBackup(merged)
      } catch (error) {
        console.error('Failed to save accounts:', error)
        throw error
      }
    })
    // 所有账号入口最终都会落到 save-accounts；在锁外合并触发，避免网络请求占住账号存储锁。
    kskAutomationManager.queueLocalAdminSync()
    // 同理在锁外更新台账：账号页 5 分钟一轮的用量刷新最终也落到这里
    void syncKskLedgerFromAccounts()
  })

  // IPC: 刷新账号 Token（支持 IdC 和社交登录）
  ipcMain.handle('refresh-account-token', async (_event, account) =>
    runCredentialRefreshOperation(
      { success: false as const, error: { message: CREDENTIAL_REFRESH_UNAVAILABLE } },
      async () => {
        try {
          const managed = adminManagedEntry(account?.id)
          if (managed) {
            if (managed.authMethod === 'api_key') {
              return { success: false, error: { message: 'Kiro API key accounts cannot refresh' } }
            }
            const target = await resolveLocalAdminTarget()
            await refreshManagedAccountFromAdmin(
              { ...target, fetchImpl: localAdminFetchImpl },
              managed.credentialId
            )
            return { success: true, adminManaged: true }
          }
          const {
            credentialKind,
            kiroApiKey,
            refreshToken,
            credentialRevision,
            clientId,
            clientSecret,
            region,
            authMethod,
            provider
          } = account.credentials || {}
          if (credentialKind === 'kiro_api_key' || kiroApiKey) {
            return { success: false, error: { message: 'Kiro API key accounts cannot refresh' } }
          }

          if (!refreshToken) {
            return { success: false, error: { message: '缺少 Refresh Token' } }
          }

          // 社交登录只需要 refreshToken，IdC 登录需要 clientId 和 clientSecret
          if (authMethod !== 'social' && (!clientId || !clientSecret)) {
            return {
              success: false,
              error: { message: '缺少 OIDC 刷新凭证 (clientId/clientSecret)' }
            }
          }

          // 查找账号绑定的代理 URL（账号池中已有 proxyUrl 字段）
          const boundProxyUrl = readAccountBoundProxyUrl(account.id || '')

          console.log(
            `[IPC] Refreshing token (authMethod: ${authMethod || 'IdC'})...${boundProxyUrl ? ' [via bound proxy]' : ''}`
          )

          // 根据 authMethod 选择刷新方式（透传账号绑定代理）
          const refreshResult = await refreshStoredKiroCredentials({
            accountId: account.id || '',
            expectedRefreshToken: refreshToken,
            expectedCredentialRevision: credentialRevision,
            clientId,
            clientSecret,
            region,
            authMethod,
            proxyUrl: boundProxyUrl
          })

          if (!refreshResult.success || !refreshResult.accessToken) {
            return { success: false, error: { message: refreshResult.error || 'Token 刷新失败' } }
          }

          const newAccess = refreshResult.accessToken
          const newRefresh = refreshResult.refreshToken || refreshToken
          const expiresIn = refreshResult.expiresIn ?? 3600

          // 刷新后自动获取 profileArn（仅 Enterprise 需要调 API，其他类型不调）
          let resolvedEnterpriseArn: string | undefined
          const existingProfileArn = account.profileArn || account.credentials?.profileArn
          if (!existingProfileArn) {
            const isEnt = provider === 'Enterprise' || authMethod === 'external_idp'
            if (isEnt) {
              try {
                resolvedEnterpriseArn = await fetchEnterpriseProfileArn({
                  id: account.id || '',
                  accessToken: newAccess,
                  region: region || 'us-east-1',
                  provider,
                  authMethod: authMethod as 'IdC' | 'social' | 'idc' | 'external_idp' | undefined
                })
                if (resolvedEnterpriseArn) {
                  console.log(
                    `[Refresh] Enterprise profileArn auto-resolved: ${resolvedEnterpriseArn}`
                  )
                }
              } catch (e) {
                console.warn('[Refresh] Failed to fetch Enterprise profileArn:', e)
              }
            }
            // BuilderId/Social 不调 API，不需要返回 profileArn（用 resolveProfileArn 兜底）
          }

          return {
            success: true,
            data: {
              accessToken: newAccess,
              refreshToken: newRefresh,
              expiresIn,
              expiresAt: refreshResult.expiresAt,
              credentialRevision: refreshResult.credentialRevision,
              // Enterprise 自动获取的 profileArn（renderer 需要存储到账号数据）
              profileArn: resolvedEnterpriseArn || undefined
            }
          }
        } catch (error) {
          return {
            success: false,
            error: { message: error instanceof Error ? error.message : 'Unknown error' }
          }
        }
      }
    )
  )

  // IPC: 把账号切换为 Kiro CLI 当前账号（只传 accountId，凭据由主进程从账号库读取）
  ipcMain.handle('switch-account-cli', async (_event, accountId: string) => {
    try {
      if (typeof accountId !== 'string' || !accountId) throw new Error('缺少账号 ID')
      return { success: true, data: await switchAccountToKiroCli(accountId) }
    } catch (error) {
      console.error('[KiroCLI] 切换失败:', error instanceof Error ? error.message : error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Kiro CLI 切换失败'
      }
    }
  })

  // IPC: 从 SSO Token 导入账号 (x-amz-sso_authn)
  ipcMain.handle(
    'import-from-sso-token',
    async (_event, bearerToken: string, region: string = 'us-east-1') => {
      console.log('[IPC] import-from-sso-token called')

      try {
        // 执行 SSO 设备授权流程
        const ssoResult = await ssoDeviceAuth(bearerToken, region)

        if (!ssoResult.success || !ssoResult.accessToken) {
          return { success: false, error: { message: ssoResult.error || 'SSO 授权失败' } }
        }

        // 并行获取用户信息和使用量
        interface UsageBreakdownItem {
          resourceType?: string
          currentUsage?: number
          currentUsageWithPrecision?: number
          usageLimit?: number
          usageLimitWithPrecision?: number
          displayName?: string
          displayNamePlural?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          freeTrialInfo?: {
            currentUsage?: number
            currentUsageWithPrecision?: number
            usageLimit?: number
            usageLimitWithPrecision?: number
            freeTrialExpiry?: string
            freeTrialStatus?: string
          }
          bonuses?: Array<{
            bonusCode?: string
            displayName?: string
            currentUsage?: number
            currentUsageWithPrecision?: number
            usageLimit?: number
            usageLimitWithPrecision?: number
            expiresAt?: string
          }>
        }
        interface UsageApiResponse {
          userInfo?: { email?: string; userId?: string }
          subscriptionInfo?: {
            type?: string
            subscriptionTitle?: string
            upgradeCapability?: string
            overageCapability?: string
            subscriptionManagementTarget?: string
          }
          usageBreakdownList?: UsageBreakdownItem[]
          nextDateReset?: string
          overageConfiguration?: { overageEnabled?: boolean; overageStatus?: string }
        }

        let userInfo: UserInfoResponse | undefined
        let usageData: UsageApiResponse | undefined

        try {
          console.log('[SSO] Fetching user info and usage data...')
          const [userInfoResult, usageResult] = await Promise.all([
            getUserInfo(ssoResult.accessToken).catch((e) => {
              console.error('[SSO] getUserInfo failed:', e)
              return undefined
            }),
            getUsageAndLimits(ssoResult.accessToken, 'BuilderId', undefined, region).catch((e) => {
              console.error('[SSO] getUsageAndLimits failed:', e)
              return undefined
            })
          ])
          userInfo = userInfoResult
          usageData = usageResult
          console.log('[SSO] userInfo:', userInfo?.email)
          console.log('[SSO] usageData:', usageData?.subscriptionInfo?.subscriptionTitle)
        } catch (e) {
          console.error('[IPC] API calls failed:', e)
        }

        // 解析使用量数据
        const creditUsage = usageData?.usageBreakdownList?.find((b) => b.resourceType === 'CREDIT')
        const subscriptionTitle = usageData?.subscriptionInfo?.subscriptionTitle || 'KIRO'

        // 规范化订阅类型（注意检查顺序：先检查更具体的类型）
        let subscriptionType = 'Free'
        const titleUpper = subscriptionTitle.toUpperCase()
        if (
          titleUpper.includes('PRO+') ||
          titleUpper.includes('PRO_PLUS') ||
          titleUpper.includes('PROPLUS')
        ) {
          subscriptionType = 'Pro_Plus'
        } else if (titleUpper.includes('POWER')) {
          subscriptionType = 'Enterprise'
        } else if (titleUpper.includes('PRO')) {
          subscriptionType = 'Pro'
        } else if (titleUpper.includes('ENTERPRISE')) {
          subscriptionType = 'Enterprise'
        } else if (titleUpper.includes('TEAMS')) {
          subscriptionType = 'Teams'
        }

        // 基础额度（使用精确小数）
        const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
        const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

        // 试用额度（使用精确小数）
        let freeTrialLimit = 0,
          freeTrialCurrent = 0,
          freeTrialExpiry: string | undefined
        if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
          freeTrialLimit =
            creditUsage.freeTrialInfo.usageLimitWithPrecision ??
            creditUsage.freeTrialInfo.usageLimit ??
            0
          freeTrialCurrent =
            creditUsage.freeTrialInfo.currentUsageWithPrecision ??
            creditUsage.freeTrialInfo.currentUsage ??
            0
          freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
        }

        // 奖励额度（使用精确小数）
        const bonuses = (creditUsage?.bonuses || []).map((b) => ({
          code: b.bonusCode || '',
          name: b.displayName || '',
          current: b.currentUsageWithPrecision ?? b.currentUsage ?? 0,
          limit: b.usageLimitWithPrecision ?? b.usageLimit ?? 0,
          expiresAt: b.expiresAt
        }))

        const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((s, b) => s + b.limit, 0)
        const totalCurrent =
          baseCurrent + freeTrialCurrent + bonuses.reduce((s, b) => s + b.current, 0)

        return {
          success: true,
          data: {
            accessToken: ssoResult.accessToken,
            refreshToken: ssoResult.refreshToken,
            clientId: ssoResult.clientId,
            clientSecret: ssoResult.clientSecret,
            region: ssoResult.region,
            expiresIn: ssoResult.expiresIn,
            email: usageData?.userInfo?.email || userInfo?.email,
            userId: usageData?.userInfo?.userId || userInfo?.userId,
            idp: userInfo?.idp || 'BuilderId',
            status: userInfo?.status,
            subscriptionType,
            subscriptionTitle,
            subscription: {
              managementTarget: usageData?.subscriptionInfo?.subscriptionManagementTarget,
              upgradeCapability: usageData?.subscriptionInfo?.upgradeCapability,
              overageCapability: usageData?.subscriptionInfo?.overageCapability
            },
            usage: {
              current: totalCurrent,
              limit: totalLimit,
              baseLimit,
              baseCurrent,
              freeTrialLimit,
              freeTrialCurrent,
              freeTrialExpiry,
              bonuses,
              nextResetDate: usageData?.nextDateReset,
              resourceDetail: creditUsage
                ? {
                    displayName: creditUsage.displayName,
                    displayNamePlural: creditUsage.displayNamePlural,
                    resourceType: creditUsage.resourceType,
                    currency: creditUsage.currency,
                    unit: creditUsage.unit,
                    overageRate: creditUsage.overageRate,
                    overageCap: creditUsage.overageCap,
                    overageEnabled:
                      usageData?.overageConfiguration?.overageStatus === 'ENABLED' ||
                      usageData?.overageConfiguration?.overageEnabled === true
                  }
                : undefined
            },
            daysRemaining: usageData?.nextDateReset
              ? Math.max(
                  0,
                  Math.ceil((new Date(usageData.nextDateReset).getTime() - Date.now()) / 86400000)
                )
              : undefined
          }
        }
      } catch (error) {
        console.error('[IPC] import-from-sso-token error:', error)
        return {
          success: false,
          error: { message: error instanceof Error ? error.message : 'Unknown error' }
        }
      }
    }
  )

  // IPC: 检查账号状态（支持自动刷新 Token）
  ipcMain.handle('check-account-status', async (_event, account) => {
    console.log(`[IPC] check-account-status [${account?.email || 'unknown'}]`)

    interface Bonus {
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      status?: string
      expiresAt?: string // API 返回的是 expiresAt
    }

    interface FreeTrialInfo {
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string
    }

    interface UsageBreakdown {
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      displayName?: string
      displayNamePlural?: string
      resourceType?: string
      currency?: string
      unit?: string
      overageRate?: number
      overageCap?: number
      bonuses?: Bonus[]
      freeTrialInfo?: FreeTrialInfo
    }

    interface SubscriptionInfo {
      subscriptionTitle?: string
      type?: string
      upgradeCapability?: string
      overageCapability?: string
      subscriptionManagementTarget?: string
    }

    interface UserInfo {
      email?: string
      userId?: string
    }

    interface OverageConfiguration {
      overageEnabled?: boolean
      overageStatus?: string
    }

    interface UsageResponse {
      daysUntilReset?: number
      nextDateReset?: string
      usageBreakdownList?: UsageBreakdown[]
      overageConfiguration?: OverageConfiguration
      subscriptionInfo?: SubscriptionInfo
      userInfo?: UserInfo
    }

    // 解析 API 响应的辅助函数
    const parseUsageResponse = (
      result: UsageResponse,
      newCredentials?: {
        accessToken: string
        refreshToken?: string
        expiresIn?: number
        expiresAt?: number
        credentialRevision?: string
      },
      userInfo?: UserInfoResponse
    ) => {
      console.log(`[Kiro API] Usage [${account?.email || userInfo?.email || 'unknown'}]`, result)

      // 解析 Credits 使用量（resourceType 为 CREDIT）
      const creditUsage = result.usageBreakdownList?.find(
        (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
      )

      // 解析使用量（详细，使用精确小数）
      // 基础额度
      const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
      const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

      // 试用额度
      let freeTrialLimit = 0
      let freeTrialCurrent = 0
      let freeTrialExpiry: string | undefined
      if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
        freeTrialLimit =
          creditUsage.freeTrialInfo.usageLimitWithPrecision ??
          creditUsage.freeTrialInfo.usageLimit ??
          0
        freeTrialCurrent =
          creditUsage.freeTrialInfo.currentUsageWithPrecision ??
          creditUsage.freeTrialInfo.currentUsage ??
          0
        freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
      }

      // 奖励额度
      const bonusesData: {
        code: string
        name: string
        current: number
        limit: number
        expiresAt?: string
      }[] = []
      if (creditUsage?.bonuses) {
        for (const bonus of creditUsage.bonuses) {
          if (bonus.status === 'ACTIVE') {
            bonusesData.push({
              code: bonus.bonusCode || '',
              name: bonus.displayName || '',
              current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
              limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
              expiresAt: bonus.expiresAt
            })
          }
        }
      }

      // 计算总额度
      const totalLimit =
        baseLimit + freeTrialLimit + bonusesData.reduce((sum, b) => sum + b.limit, 0)
      const totalUsed =
        baseCurrent + freeTrialCurrent + bonusesData.reduce((sum, b) => sum + b.current, 0)
      const nextResetDate = result.nextDateReset

      // 解析订阅类型
      const subscriptionTitle = result.subscriptionInfo?.subscriptionTitle ?? 'Free'
      let subscriptionType = account.subscription?.type ?? 'Free'
      if (subscriptionTitle.toUpperCase().includes('PRO')) {
        subscriptionType = 'Pro'
      } else if (subscriptionTitle.toUpperCase().includes('ENTERPRISE')) {
        subscriptionType = 'Enterprise'
      } else if (subscriptionTitle.toUpperCase().includes('TEAMS')) {
        subscriptionType = 'Teams'
      }

      // 解析重置时间并计算剩余天数
      let expiresAt: number | undefined
      let daysRemaining: number | undefined
      if (result.nextDateReset) {
        expiresAt = new Date(result.nextDateReset).getTime()
        const now = Date.now()
        daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)))
      }

      // 资源详情
      const resourceDetail = creditUsage
        ? {
            resourceType: creditUsage.resourceType,
            displayName: creditUsage.displayName,
            displayNamePlural: creditUsage.displayNamePlural,
            currency: creditUsage.currency,
            unit: creditUsage.unit,
            overageRate: creditUsage.overageRate,
            overageCap: creditUsage.overageCap,
            overageEnabled:
              result.overageConfiguration?.overageStatus === 'ENABLED' ||
              result.overageConfiguration?.overageEnabled === true
          }
        : undefined

      return {
        success: true,
        data: {
          status:
            !userInfo?.status || userInfo.status === 'Active' || userInfo.status === 'Stale'
              ? 'active'
              : 'error',
          email: result.userInfo?.email,
          userId: result.userInfo?.userId,
          idp: userInfo?.idp,
          userStatus: userInfo?.status,
          featureFlags: userInfo?.featureFlags,
          subscriptionTitle,
          usage: {
            current: totalUsed,
            limit: totalLimit,
            percentUsed: totalLimit > 0 ? totalUsed / totalLimit : 0,
            lastUpdated: Date.now(),
            baseLimit,
            baseCurrent,
            freeTrialLimit,
            freeTrialCurrent,
            freeTrialExpiry,
            bonuses: bonusesData,
            nextResetDate,
            resourceDetail
          },
          subscription: {
            type: subscriptionType,
            title: subscriptionTitle,
            rawType: result.subscriptionInfo?.type,
            expiresAt,
            daysRemaining,
            upgradeCapability: result.subscriptionInfo?.upgradeCapability,
            overageCapability: result.subscriptionInfo?.overageCapability,
            managementTarget: result.subscriptionInfo?.subscriptionManagementTarget
          },
          // 如果刷新了 token，返回新的凭证
          newCredentials: newCredentials
            ? {
                accessToken: newCredentials.accessToken,
                refreshToken: newCredentials.refreshToken,
                expiresAt:
                  newCredentials.expiresAt ??
                  (newCredentials.expiresIn
                    ? Date.now() + newCredentials.expiresIn * 1000
                    : undefined),
                credentialRevision: newCredentials.credentialRevision
              }
            : undefined
        }
      }
    }

    /*
     * 托管账号不走上游。
     *
     * 本地已经没有它的有效 token（刷新被闸门停掉），createSession / getUsageAndLimits
     * 必然 401，随后那次「401 补刷」也会被闸门拦下。直接改从反代读余额与订阅，
     * 顺带把 401 重试分支整段绕开。
     *
     * 反代不可达时如实报错、不退回直连：退回必然伴随一次刷新，等于重新引入双边抢刷。
     */
    if (isAdminManagedAccount(account?.id)) {
      const entry = adminManagedEntry(account.id)
      if (!entry) {
        return { success: false, error: { message: '托管登记缺失，请重新推送该账号' } }
      }
      try {
        const target = await resolveLocalAdminTarget()
        const synced = await syncManagedAccountFromAdmin(
          { ...target, fetchImpl: localAdminFetchImpl },
          entry.credentialId,
          Date.now(),
          true
        )
        if (synced.status !== 'active') {
          return { success: false, error: { message: synced.errorMessage || '反代状态同步失败' } }
        }
        return {
          success: true,
          data: {
            status: synced.status,
            email: account.email,
            subscriptionTitle: synced.subscription?.title,
            usage: synced.usage,
            subscription: synced.subscription,
            // 托管账号的 token 由反代维护，本地没有新凭据可回写
            newCredentials: undefined
          }
        }
      } catch (error) {
        return {
          success: false,
          error: { message: error instanceof Error ? error.message : String(error) }
        }
      }
    }

    try {
      const {
        accessToken,
        refreshToken,
        credentialRevision,
        clientId,
        clientSecret,
        region,
        apiRegion,
        authMethod,
        provider,
        profileArn,
        kiroApiKey,
        credentialKind
      } = account.credentials || {}
      const upstreamCredential = resolveUpstreamKiroCredential({
        credentialKind,
        accessToken,
        kiroApiKey,
        idp: provider || account.idp
      })
      // 账号库模式：凭据以库为准（渲染层不再持有明文），先请 kiro-rs 确保新鲜
      const dbContext = await accountDbUpstreamContext(account.id)
      if (dbContext && 'error' in dbContext) {
        return { success: false, error: { message: dbContext.error } }
      }
      const upstreamAuth = getUpstreamKiroAuth(dbContext?.credential ?? upstreamCredential)

      // 查询账号绑定的代理（账号池）
      const boundProxyUrl = dbContext?.proxyUrl ?? readAccountBoundProxyUrl(account.id || '')

      // 确定正确的 idp：优先使用 credentials.provider，否则回退到 account.idp
      // 社交登录使用实际的 provider (Github/Google)，IdC 使用 BuilderId
      let idp = 'BuilderId'
      if (authMethod === 'social') {
        idp = provider || account.idp || 'BuilderId'
      } else if (provider) {
        idp = provider
      }

      if (!upstreamAuth.accessToken) {
        return { success: false, error: { message: '缺少上游 Kiro 凭据' } }
      }

      // 第一次尝试：使用当前 accessToken
      try {
        // 并行调用 GetUserInfo 和 getUsageAndLimits
        const [userInfoResult, usageResult] = await Promise.all([
          upstreamAuth.isApiKey
            ? Promise.resolve(undefined)
            : getUserInfo(upstreamAuth.accessToken, idp, account?.email, boundProxyUrl).catch(
                (err: Error) => {
                  if (err.message.includes('423') || err.message.includes('AccountSuspended'))
                    throw err
                  return undefined
                }
              ),
          getUsageAndLimits(
            dbContext?.credential ?? upstreamCredential,
            idp,
            dbContext?.profileArn ?? (account.profileArn || profileArn),
            dbContext?.region ?? (apiRegion || region),
            account?.email,
            boundProxyUrl
          )
        ])
        return parseUsageResponse(usageResult, undefined, userInfoResult)
      } catch (apiError) {
        const errorMsg = apiError instanceof Error ? apiError.message : ''

        // 检查是否是明确封禁错误（423 或 AccountSuspendedException）
        if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
          console.log('[IPC] Account suspended/banned')
          return {
            success: false,
            error: { message: errorMsg, isBanned: true }
          }
        }

        // 检查是否是 401 错误（token 过期）
        // 社交登录只需要 refreshToken，IdC 登录需要 clientId 和 clientSecret
        const canRefresh = refreshToken && (authMethod === 'social' || (clientId && clientSecret))
        if (errorMsg.includes('401') && canRefresh) {
          return runCredentialRefreshOperation(
            { success: false as const, error: { message: CREDENTIAL_REFRESH_UNAVAILABLE } },
            async () => {
              console.log(
                `[IPC] Token expired, attempting to refresh (authMethod: ${authMethod || 'IdC'})...${boundProxyUrl ? ' [via bound proxy]' : ''}`
              )

              // 尝试刷新 token - 根据 authMethod 选择刷新方式（透传账号代理）
              const refreshResult = await refreshStoredKiroCredentials({
                accountId: account.id || '',
                expectedRefreshToken: refreshToken,
                expectedCredentialRevision: credentialRevision,
                clientId,
                clientSecret,
                region,
                authMethod,
                proxyUrl: boundProxyUrl
              })

              if (refreshResult.success && refreshResult.accessToken) {
                console.log('[IPC] Token refreshed, retrying API call...')

                // 用新 token 并行调用 GetUserInfo 和 getUsageAndLimits
                const [userInfoResult, usageResult] = await Promise.all([
                  getUserInfo(refreshResult.accessToken, idp, account?.email, boundProxyUrl).catch(
                    (err: Error) => {
                      if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                        throw err
                      }
                      return undefined
                    }
                  ),
                  getUsageAndLimits(
                    refreshResult.accessToken,
                    idp,
                    undefined,
                    apiRegion || region,
                    account?.email,
                    boundProxyUrl
                  )
                ])

                // 返回结果并包含新凭证
                return parseUsageResponse(
                  usageResult,
                  {
                    accessToken: refreshResult.accessToken,
                    refreshToken: refreshResult.refreshToken,
                    expiresIn: refreshResult.expiresIn,
                    expiresAt: refreshResult.expiresAt,
                    credentialRevision: refreshResult.credentialRevision
                  },
                  userInfoResult
                )
              } else {
                console.error('[IPC] Token refresh failed:', refreshResult.error)
                return {
                  success: false as const,
                  error: { message: `Token 过期且刷新失败: ${refreshResult.error}` }
                }
              }
            }
          )
        }

        // 不是 401 或没有刷新凭证，抛出原错误
        throw apiError
      }
    } catch (error) {
      console.error('check-account-status error:', error)
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Unknown error' }
      }
    }
  })

  // IPC: 后台批量刷新账号（在主进程执行，不阻塞 UI）
  /**
   * 托管账号在后台轮询里的处理：不发 token 刷新请求，改为从反代读用量与订阅状态。
   *
   * 返回值表示这一轮是否算成功——「跳过同步」（syncInfo=false）也算成功，它不是失败。
   *
   * 特意不弹 TokenRefreshFailed 通知：那个通知的语义是「token 刷新失败」，而托管账号
   * 压根没刷 token；上百个托管号每 5 分钟误报一次会把通知系统淹掉。
   */
  async function syncManagedAccountIntoBatch(
    account: BackgroundRefreshAccount,
    syncInfo: boolean,
    refreshManaged: boolean = false
  ): Promise<boolean> {
    const accountId = account.id
    const entry = accountId ? adminManagedEntry(accountId) : undefined
    if (!accountId || !entry) return true

    // syncInfo=false 的轮次只关心 token，托管账号没有 token 可刷，省掉这次 loopback
    if (!syncInfo && !refreshManaged) return true

    try {
      const target = await resolveLocalAdminTarget()
      const adminTarget = { ...target, fetchImpl: localAdminFetchImpl }
      if (refreshManaged && entry.authMethod !== 'api_key') {
        await refreshManagedAccountFromAdmin(adminTarget, entry.credentialId)
      }
      const synced = syncInfo
        ? await syncManagedAccountFromAdmin(
            adminTarget,
            entry.credentialId,
            Date.now(),
            refreshManaged
          )
        : {
            status: 'active' as const,
            usage: undefined,
            subscription: undefined,
            errorMessage: undefined
          }
      // 账号库模式：kiro-rs 已把上游原样额度写进库，用它补全 base / bonus / 试用明细
      const projected = syncInfo ? accountDbBridge()?.projectedAccount(accountId) : undefined
      if (projected && synced.status === 'active') {
        synced.usage = projected.usage as typeof synced.usage
        synced.subscription = projected.subscription as typeof synced.subscription
      }
      sendRendererEvent('background-refresh-result', {
        id: accountId,
        success: synced.status === 'active',
        error: synced.errorMessage,
        data: {
          usage: synced.usage,
          subscription: synced.subscription,
          status: synced.status,
          errorMessage: synced.errorMessage
        }
      })
      return synced.status === 'active'
    } catch (error) {
      sendRendererEvent('background-refresh-result', {
        id: accountId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

  const ADMIN_MANAGED_ADOPTION_KEY = 'adminManagedAdoptionDone'

  /**
   * 升级时的一次性认领：把反代里已有的凭据认回本地账号并登记为托管。
   *
   * 不做的话，改造前推给反代的账号在登记表里没有条目，升级后会立刻恢复本地刷新、
   * 重新开始双边抢刷——而烧号不可逆。
   *
   * 认领结果直接落盘、不要求用户先确认：漏认的代价是继续烧号，误认的代价只是该账号
   * 暂时不本地刷新（UI 可一键取消）。两边代价不对称，所以宁枉勿纵。
   */
  async function runAdminManagedAdoptionOnce(): Promise<void> {
    if (!store) return
    // 账号库模式：库里的账号全部由 kiro-rs 管理，不需要认领
    if (isAccountDbMode()) return
    if (store.get(ADMIN_MANAGED_ADOPTION_KEY, false) === true) return

    try {
      const accountData = store.get('accountData') as
        | {
            accounts?: Record<
              string,
              { email?: string; credentials?: { refreshToken?: string; kiroApiKey?: string } }
            >
          }
        | undefined
      const accounts = Object.entries(accountData?.accounts ?? {}).map(([id, account]) => {
        const refreshToken = account.credentials?.refreshToken?.trim()
        const kiroApiKey = account.credentials?.kiroApiKey?.trim()
        return {
          id,
          email: account.email,
          refreshTokenHash: refreshToken ? sha256Hex(refreshToken) : undefined,
          kiroApiKeyHash: kiroApiKey ? sha256Hex(kiroApiKey) : undefined
        }
      })
      if (accounts.length === 0) return

      const target = await resolveLocalAdminTarget()
      const payload = await requestJson(
        localAdminFetchImpl,
        `${resolveLocalAdminApiBase(target.baseUrl)}/credentials`,
        target.adminApiKey.trim(),
        Math.max(3, target.timeoutSeconds) * 1000,
        { method: 'GET' }
      )

      const { claimed, ambiguousEmail } = matchRemoteCredentialToLocalAccount({
        accounts,
        remote: readRemoteCredentials(payload)
          .map((credential) => ({
            id: remoteCredentialId(credential) ?? '',
            credentialIdentity: credential.credentialIdentity,
            email: credential.email,
            authMethod: credential.authMethod,
            apiKeyHash: credential.apiKeyHash,
            refreshTokenHash: credential.refreshTokenHash
          }))
          .filter((credential) => credential.id.length > 0),
        now: Date.now()
      })

      for (const entry of claimed) {
        await recordAdminManagedAccount(entry)
      }
      await reloadAdminManagedIds()
      store.set(ADMIN_MANAGED_ADOPTION_KEY, true)
      console.log(
        `[AdminManaged] 认领完成：${claimed.length} 个账号登记为反代托管` +
          (ambiguousEmail.length > 0 ? `；${ambiguousEmail.length} 个因邮箱在本地重复未认领` : '')
      )
    } catch (error) {
      // 反代未配置或不可达：不落 flag，下次启动重试
      console.warn(
        '[AdminManaged] 认领未完成（反代不可达或未配置），下次启动重试：',
        error instanceof Error ? error.message : error
      )
    }
  }

  const backgroundBatchRefresh = async (
    accounts: BackgroundRefreshAccount[],
    concurrency: number = 10,
    syncInfo: boolean = true,
    refreshManaged: boolean = false
  ): Promise<{
    success: boolean
    completed: number
    successCount: number
    failedCount: number
    error?: string
  }> => {
    console.log(
      `[BackgroundRefresh] Starting batch refresh for ${accounts.length} accounts, concurrency: ${concurrency}, syncInfo: ${syncInfo}`
    )

    let completed = 0
    let success = 0
    let failed = 0

    // 串行处理每批，避免并发过高
    for (let i = 0; i < accounts.length; i += concurrency) {
      const batch = accounts.slice(i, i + concurrency)

      await Promise.allSettled(
        batch.map(async (account) => {
          // 去重：渲染进程定时器与主进程调度器可能同时触发刷新，
          // 对同一账号并发刷新会让其中一个用到被 rotate 作废的旧 refreshToken。
          // 已在途则跳过本次（不计入成败，等在途那次的结果回流即可）。
          if (account.id && poolRefreshInFlightIds.has(account.id)) {
            return
          }
          /*
           * 托管账号由反代独占刷新：本地既不发刷新请求，也不能把闸门拦下当成失败
           * （否则每一轮都会弹「账号刷新失败」）。用量与订阅状态改从反代读。
           */
          if (isAdminManagedAccount(account.id)) {
            const ok = await syncManagedAccountIntoBatch(account, syncInfo, refreshManaged)
            completed++
            if (ok) success++
            else failed++
            return
          }
          const needsTokenRefresh = account.needsTokenRefresh !== false // 默认为 true（兼容旧版本）
          const refreshPlan = buildBackgroundRefreshPlan(account.credentials, needsTokenRefresh)
          if (account.id) poolRefreshInFlightIds.add(account.id)
          const isApiKey =
            buildBackgroundRefreshPlan(account.credentials, false).credentialKind === 'kiro_api_key'
          try {
            const {
              refreshToken,
              credentialRevision,
              clientId,
              clientSecret,
              region,
              authMethod,
              provider
            } = account.credentials

            // 查询账号绑定的代理
            const boundProxyUrl = readAccountBoundProxyUrl(account.id)

            // 确定正确的 idp
            let idp = 'BuilderId'
            if (authMethod === 'social') {
              idp = provider || account.idp || 'BuilderId'
            } else if (provider) {
              idp = provider
            }

            let newAccessToken = refreshPlan.accessToken
            let newRefreshToken = refreshToken
            let newExpiresIn: number | undefined
            let newExpiresAt: number | undefined
            let newCredentialRevision = credentialRevision

            // API key 从不执行 OAuth 刷新；OAuth 保持原有刷新路径。
            if (refreshPlan.shouldRefreshToken) {
              if (!refreshToken) {
                failed++
                completed++
                if (account.id) {
                  localNotifications.notify(LocalNoticeKind.TokenRefreshFailed, {
                    accountId: account.id
                  })
                }
                return
              }

              // 刷新 Token（透传账号绑定代理）
              const refreshResult = await refreshStoredKiroCredentials({
                accountId: account.id,
                expectedRefreshToken: refreshToken,
                expectedCredentialRevision: credentialRevision,
                clientId,
                clientSecret,
                region,
                authMethod,
                proxyUrl: boundProxyUrl
              })

              if (!refreshResult.success) {
                failed++
                completed++
                if (account.id) {
                  localNotifications.notify(LocalNoticeKind.TokenRefreshFailed, {
                    accountId: account.id
                  })
                }
                // 通知渲染进程刷新失败
                sendRendererEvent('background-refresh-result', {
                  id: account.id,
                  success: false,
                  error: refreshResult.error
                })
                return
              }

              newAccessToken = refreshResult.accessToken || refreshPlan.accessToken
              newRefreshToken = refreshResult.refreshToken || refreshToken
              newExpiresIn = refreshResult.expiresIn ?? 3600
              newExpiresAt = refreshResult.expiresAt
              newCredentialRevision = refreshResult.credentialRevision
              if (!newAccessToken) {
                failed++
                completed++
                return
              }
            }

            // Enterprise 账号：后台刷新后自动获取 profileArn（BuilderId/Social 不需要调 API）
            const existingProfileArn = account.profileArn || account.credentials?.profileArn
            let resolvedBgProfileArn: string | undefined
            const isEnt =
              (provider || account.idp) === 'Enterprise' || authMethod === 'external_idp'
            if (!isApiKey && !existingProfileArn && newAccessToken && isEnt) {
              try {
                resolvedBgProfileArn = await fetchEnterpriseProfileArn({
                  id: account.id || '',
                  accessToken: newAccessToken,
                  region: region || 'us-east-1',
                  provider: provider || account.idp,
                  authMethod: authMethod as 'IdC' | 'social' | 'idc' | 'external_idp' | undefined
                })
                if (resolvedBgProfileArn) {
                  console.log(
                    `[BackgroundRefresh] Enterprise profileArn auto-resolved: ${resolvedBgProfileArn} (${account.id})`
                  )
                }
              } catch (e) {
                console.warn(
                  `[BackgroundRefresh] Failed to fetch Enterprise profileArn for ${account.id}:`,
                  e
                )
              }
            }

            // 获取账号信息
            if (!newAccessToken && !isApiKey) {
              failed++
              completed++
              return
            }

            // 根据 syncInfo 决定是否检测账户信息
            let parsedUsage:
              | {
                  current: number
                  limit: number
                  baseCurrent: number
                  baseLimit: number
                  freeTrialCurrent: number
                  freeTrialLimit: number
                  freeTrialExpiry?: string
                  bonuses: Array<{
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
              | undefined
            let userInfoData: UserInfoResponse | undefined
            let subscriptionData:
              | {
                  type: string
                  title: string
                  daysRemaining?: number
                  expiresAt?: number
                  overageCapability?: string
                  upgradeCapability?: string
                  subscriptionManagementTarget?: string
                }
              | undefined
            let status = 'active'
            let errorMessage: string | undefined

            if (syncInfo) {
              // 调用 getUsageAndLimits API（根据配置选择 REST 或 CBOR 格式）
              try {
                interface UsageBreakdownItem {
                  resourceType?: string
                  displayName?: string
                  currentUsage?: number
                  currentUsageWithPrecision?: number
                  usageLimit?: number
                  usageLimitWithPrecision?: number
                  freeTrialInfo?: {
                    freeTrialStatus?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    freeTrialExpiry?: string
                  }
                  bonuses?: Array<{
                    bonusCode?: string
                    displayName?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    expiresAt?: string
                    status?: string
                  }>
                }
                interface UsageResponse {
                  usageBreakdownList?: UsageBreakdownItem[]
                  nextDateReset?: string
                  subscriptionInfo?: {
                    subscriptionTitle?: string
                    type?: string
                    overageCapability?: string
                    upgradeCapability?: string
                    subscriptionManagementTarget?: string
                  }
                  overageConfiguration?: {
                    overageStatus?: string
                    overageEnabled?: boolean
                    overageLimit?: number | null
                  }
                }
                const upstreamCredential: UpstreamKiroCredential = isApiKey
                  ? { credentialKind: 'kiro_api_key', kiroApiKey: refreshPlan.kiroApiKey || '' }
                  : newAccessToken!
                const rawUsage = (await getUsageAndLimits(
                  upstreamCredential,
                  idp,
                  account.profileArn,
                  region
                )) as UsageResponse

                // 解析使用量数据
                const creditUsage = rawUsage.usageBreakdownList?.find(
                  (b) => b.resourceType === 'CREDIT'
                )
                const baseCurrent =
                  creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
                const baseLimit =
                  creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
                let freeTrialCurrent = 0
                let freeTrialLimit = 0
                let freeTrialExpiry: string | undefined
                if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
                  freeTrialCurrent =
                    creditUsage.freeTrialInfo.currentUsageWithPrecision ??
                    creditUsage.freeTrialInfo.currentUsage ??
                    0
                  freeTrialLimit =
                    creditUsage.freeTrialInfo.usageLimitWithPrecision ??
                    creditUsage.freeTrialInfo.usageLimit ??
                    0
                  freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
                }
                const bonuses: Array<{
                  code: string
                  name: string
                  current: number
                  limit: number
                  expiresAt?: string
                }> = []
                if (creditUsage?.bonuses) {
                  for (const bonus of creditUsage.bonuses) {
                    if (bonus.status === 'ACTIVE') {
                      bonuses.push({
                        code: bonus.bonusCode || '',
                        name: bonus.displayName || '',
                        current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                        limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                        expiresAt: bonus.expiresAt
                      })
                    }
                  }
                }
                const totalLimit =
                  baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
                const totalCurrent =
                  baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)

                parsedUsage = {
                  current: totalCurrent,
                  limit: totalLimit,
                  baseCurrent,
                  baseLimit,
                  freeTrialCurrent,
                  freeTrialLimit,
                  freeTrialExpiry,
                  bonuses,
                  nextResetDate: rawUsage.nextDateReset,
                  resourceDetail: creditUsage
                    ? {
                        displayName: creditUsage.displayName,
                        displayNamePlural: (creditUsage as { displayNamePlural?: string })
                          .displayNamePlural,
                        resourceType: creditUsage.resourceType,
                        currency: (creditUsage as { currency?: string }).currency,
                        unit: (creditUsage as { unit?: string }).unit,
                        overageRate: (creditUsage as { overageRate?: number }).overageRate,
                        overageCap: (creditUsage as { overageCap?: number }).overageCap,
                        overageEnabled:
                          rawUsage.overageConfiguration?.overageStatus === 'ENABLED' ||
                          rawUsage.overageConfiguration?.overageEnabled === true
                      }
                    : undefined
                }

                // 解析订阅信息（注意检查顺序：先检查更具体的类型）
                const subscriptionTitle = rawUsage.subscriptionInfo?.subscriptionTitle || 'Free'
                let subscriptionType = 'Free'
                const titleUpper = subscriptionTitle.toUpperCase()
                if (
                  titleUpper.includes('PRO+') ||
                  titleUpper.includes('PRO_PLUS') ||
                  titleUpper.includes('PROPLUS')
                ) {
                  subscriptionType = 'Pro_Plus'
                } else if (titleUpper.includes('POWER')) {
                  subscriptionType = 'Enterprise'
                } else if (titleUpper.includes('PRO')) {
                  subscriptionType = 'Pro'
                } else if (titleUpper.includes('ENTERPRISE')) {
                  subscriptionType = 'Enterprise'
                } else if (titleUpper.includes('TEAMS')) {
                  subscriptionType = 'Teams'
                }

                // 计算剩余天数和到期时间
                let daysRemaining: number | undefined
                let expiresAt: number | undefined
                if (rawUsage.nextDateReset) {
                  expiresAt = new Date(rawUsage.nextDateReset).getTime()
                  daysRemaining = Math.max(
                    0,
                    Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24))
                  )
                }

                subscriptionData = {
                  type: subscriptionType,
                  title: subscriptionTitle,
                  daysRemaining,
                  expiresAt,
                  overageCapability: rawUsage.subscriptionInfo?.overageCapability,
                  upgradeCapability: rawUsage.subscriptionInfo?.upgradeCapability,
                  subscriptionManagementTarget:
                    rawUsage.subscriptionInfo?.subscriptionManagementTarget
                }
              } catch (apiError) {
                const errMsg = apiError instanceof Error ? apiError.message : String(apiError)
                const safeErrorMessage = isApiKey ? 'API key usage sync failed' : errMsg
                console.log(
                  `[BackgroundRefresh] Usage API error for ${account.id}:`,
                  safeErrorMessage
                )
                if (errMsg.includes('AccountSuspendedException') || errMsg.includes('423')) {
                  status = 'error'
                  errorMessage = isApiKey ? 'API key account suspended' : errMsg
                }
              }

              // API key 没有 OAuth 用户信息端点，跳过该调用。
              if (refreshPlan.shouldFetchUserInfo)
                try {
                  userInfoData = await getUserInfo(newAccessToken!, idp)
                } catch (apiError) {
                  const errMsg = apiError instanceof Error ? apiError.message : String(apiError)
                  if (errMsg.includes('AccountSuspendedException') || errMsg.includes('423')) {
                    status = 'error'
                    errorMessage = errMsg
                  }
                }
            }

            success++
            completed++

            // 通知渲染进程更新账号
            sendRendererEvent('background-refresh-result', {
              id: account.id,
              success: true,
              data: {
                ...(isApiKey
                  ? {}
                  : {
                      accessToken: newAccessToken,
                      refreshToken: newRefreshToken,
                      expiresIn: newExpiresIn,
                      credentialRevision: newCredentialRevision,
                      expiresAt: newExpiresAt
                    }),
                profileArn: resolvedBgProfileArn || undefined,
                usage: parsedUsage,
                subscription: subscriptionData,
                userInfo: syncInfo ? userInfoData : undefined,
                status,
                errorMessage
              }
            })
          } catch (e) {
            failed++
            completed++
            if (account.id) {
              localNotifications.notify(LocalNoticeKind.TokenRefreshFailed, {
                accountId: account.id
              })
            }
            sendRendererEvent('background-refresh-result', {
              id: account.id,
              success: false,
              error: isApiKey
                ? 'API key background sync failed'
                : e instanceof Error
                  ? e.message
                  : 'Unknown error'
            })
          } finally {
            if (account.id) poolRefreshInFlightIds.delete(account.id)
          }
        })
      )

      // 通知进度
      mainWindow?.webContents.send('background-refresh-progress', {
        completed,
        total: accounts.length,
        success,
        failed
      })

      // 批次间延迟，让主进程有喘息时间
      if (i + concurrency < accounts.length) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    console.log(`[BackgroundRefresh] Completed: ${success} success, ${failed} failed`)
    return { success: true, completed, successCount: success, failedCount: failed }
  }
  // 暴露给主进程调度器复用（startMainPoolTokenRefresh）
  backgroundBatchRefreshImpl = backgroundBatchRefresh
  ipcMain.handle(
    'background-batch-refresh',
    (
      _event,
      accounts: BackgroundRefreshAccount[],
      concurrency: number = 10,
      syncInfo: boolean = true,
      refreshManaged: boolean = false
    ) => backgroundBatchRefresh(accounts, concurrency, syncInfo, refreshManaged)
  )
  /*
   * 托管登记表必须在刷新调度启动前加载完，并注入反查实现。
   *
   * 顺序不能反：调度器启动 15 秒后就跑第一轮，若那时 registry 还没读进来，
   * managedIds 是空集，已托管的账号会被本地刷一次——正是要避免的事。
   */
  setAdminManagedRefreshTokenResolver(async (refreshToken) => {
    const candidates = await readCanonicalKiroRefreshTransportCandidates(refreshToken)
    return candidates[0]?.accountId
  })
  // 托管集合一变就推给渲染进程，用于把 CLI 切号之类的入口置灰
  setAdminManagedChangeListener((ids) => sendRendererEvent('admin-managed-changed', ids))
  await startManagedAccountRefresh({
    reload: reloadAdminManagedIds,
    adopt: runAdminManagedAdoptionOnce,
    start: () => {
      // CLI start() 会立即检查临期凭据，主池也必须等托管初始化完成。
      kiroCliSocialRenewal.start()
      startMainPoolTokenRefresh()
    }
  })

  // 渲染进程启动时拉一次托管集合（事件只推增量，首帧需要主动取）
  ipcMain.handle('get-admin-managed-ids', () => [...adminManagedIdsSnapshot()])

  // IPC: 后台批量检查账号状态（不刷新 Token，只检查状态）
  ipcMain.handle(
    'background-batch-check',
    async (
      _event,
      accounts: Array<{
        id: string
        email: string
        credentials: {
          credentialKind?: 'oauth' | 'kiro_api_key'
          accessToken?: string
          kiroApiKey?: string
          profileArn?: string
          refreshToken?: string
          clientId?: string
          clientSecret?: string
          region?: string
          authMethod?: string
          provider?: string
        }
        idp?: string
      }>,
      concurrency: number = 10
    ) => {
      console.log(
        `[BackgroundCheck] Starting batch check for ${accounts.length} accounts, concurrency: ${concurrency}`
      )

      let completed = 0
      let success = 0
      let failed = 0

      // 串行处理每批
      for (let i = 0; i < accounts.length; i += concurrency) {
        const batch = accounts.slice(i, i + concurrency)

        await Promise.allSettled(
          batch.map(async (account) => {
            try {
              const managed = adminManagedEntry(account.id)
              if (managed) {
                const target = await resolveLocalAdminTarget()
                const synced = await syncManagedAccountFromAdmin(
                  { ...target, fetchImpl: localAdminFetchImpl },
                  managed.credentialId,
                  Date.now(),
                  true
                )
                const ok = synced.status === 'active'
                sendRendererEvent('background-check-result', {
                  id: account.id,
                  success: ok,
                  data: synced,
                  error: synced.errorMessage
                })
                completed++
                if (ok) success++
                else failed++
                return
              }
              const { accessToken, kiroApiKey, credentialKind, authMethod, provider } =
                account.credentials
              const upstreamCredential = resolveUpstreamKiroCredential({
                credentialKind,
                accessToken,
                kiroApiKey,
                idp: provider || account.idp
              })
              const upstreamAuth = getUpstreamKiroAuth(upstreamCredential)

              // 确定 idp
              let idp = account.idp || 'BuilderId'
              if (authMethod === 'social' && provider) {
                idp = provider
              }

              // 调用 API 获取用量和用户信息（根据配置选择 REST 或 CBOR 格式）
              const [usageRes, userInfoRes] = await Promise.allSettled([
                getUsageAndLimits(
                  upstreamCredential,
                  idp,
                  account.credentials.profileArn,
                  account.credentials?.region,
                  account.email
                ) as Promise<{
                  usageBreakdownList?: Array<{
                    resourceType?: string
                    displayName?: string
                    usageLimit?: number
                    usageLimitWithPrecision?: number
                    currentUsage?: number
                    currentUsageWithPrecision?: number
                    freeTrialInfo?: {
                      freeTrialStatus?: string
                      usageLimit?: number
                      usageLimitWithPrecision?: number
                      currentUsage?: number
                      currentUsageWithPrecision?: number
                      freeTrialExpiry?: string
                    }
                    bonuses?: Array<{
                      bonusCode?: string
                      displayName?: string
                      usageLimit?: number
                      usageLimitWithPrecision?: number
                      currentUsage?: number
                      currentUsageWithPrecision?: number
                      expiresAt?: string
                      status?: string
                    }>
                  }>
                  nextDateReset?: string
                  subscriptionInfo?: {
                    subscriptionTitle?: string
                    type?: string
                    overageCapability?: string
                    upgradeCapability?: string
                    subscriptionManagementTarget?: string
                  }
                  overageConfiguration?: {
                    overageStatus?: string
                    overageEnabled?: boolean
                    overageLimit?: number | null
                  }
                  userInfo?: {
                    email?: string
                    userId?: string
                  }
                }>,
                upstreamAuth.isApiKey
                  ? Promise.resolve(null)
                  : kiroApiRequest<{
                      email?: string
                      userId?: string
                      status?: string
                      idp?: string
                    }>(
                      'GetUserInfo',
                      { origin: 'KIRO_IDE' },
                      upstreamAuth.accessToken,
                      idp,
                      account.email
                    ).catch((err: Error) => {
                      // 封禁错误不能吞掉，需要在后续逻辑中检测
                      if (err.message.includes('423') || err.message.includes('AccountSuspended')) {
                        throw err
                      }
                      return null
                    })
              ])

              // 解析响应（kiroApiRequest 直接返回数据或抛出异常）
              let usageData: {
                current: number
                limit: number
                baseCurrent?: number
                baseLimit?: number
                freeTrialCurrent?: number
                freeTrialLimit?: number
                freeTrialExpiry?: string
                bonuses?: Array<{
                  code: string
                  name: string
                  current: number
                  limit: number
                  expiresAt?: string
                }>
                nextResetDate?: string
              } | null = null
              let subscriptionData: {
                type: string
                title: string
                daysRemaining?: number
                expiresAt?: number
                overageCapability?: string
                upgradeCapability?: string
                subscriptionManagementTarget?: string
              } | null = null
              let resourceDetail:
                | {
                    displayName?: string
                    displayNamePlural?: string
                    resourceType?: string
                    currency?: string
                    unit?: string
                    overageRate?: number
                    overageCap?: number
                    overageEnabled?: boolean
                  }
                | undefined
              let userInfoData: {
                email?: string
                userId?: string
                status?: string
              } | null = null
              let status = 'active'
              let errorMessage: string | undefined

              // 处理用量响应
              if (usageRes.status === 'fulfilled') {
                const rawUsage = usageRes.value
                // 解析 Credits 使用量（和单个检查一致）
                const creditUsage = rawUsage.usageBreakdownList?.find(
                  (b) => b.resourceType === 'CREDIT' || b.displayName === 'Credits'
                )

                const baseCurrent =
                  creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
                const baseLimit =
                  creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
                let freeTrialCurrent = 0
                let freeTrialLimit = 0
                let freeTrialExpiry: string | undefined
                if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
                  freeTrialLimit =
                    creditUsage.freeTrialInfo.usageLimitWithPrecision ??
                    creditUsage.freeTrialInfo.usageLimit ??
                    0
                  freeTrialCurrent =
                    creditUsage.freeTrialInfo.currentUsageWithPrecision ??
                    creditUsage.freeTrialInfo.currentUsage ??
                    0
                  freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
                }

                // 解析 bonuses
                const bonuses: Array<{
                  code: string
                  name: string
                  current: number
                  limit: number
                  expiresAt?: string
                }> = []
                if (creditUsage?.bonuses) {
                  for (const bonus of creditUsage.bonuses) {
                    if (bonus.status === 'ACTIVE') {
                      bonuses.push({
                        code: bonus.bonusCode || '',
                        name: bonus.displayName || '',
                        current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                        limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                        expiresAt: bonus.expiresAt
                      })
                    }
                  }
                }

                const totalLimit =
                  baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
                const totalCurrent =
                  baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)

                usageData = {
                  current: totalCurrent,
                  limit: totalLimit,
                  baseCurrent,
                  baseLimit,
                  freeTrialCurrent,
                  freeTrialLimit,
                  freeTrialExpiry,
                  bonuses,
                  nextResetDate: rawUsage.nextDateReset
                }

                // 解析资源详情（含超额信息）
                if (creditUsage) {
                  resourceDetail = {
                    displayName: creditUsage.displayName,
                    displayNamePlural: (creditUsage as { displayNamePlural?: string })
                      .displayNamePlural,
                    resourceType: creditUsage.resourceType,
                    currency: (creditUsage as { currency?: string }).currency,
                    unit: (creditUsage as { unit?: string }).unit,
                    overageRate: (creditUsage as { overageRate?: number }).overageRate,
                    overageCap: (creditUsage as { overageCap?: number }).overageCap,
                    overageEnabled:
                      rawUsage.overageConfiguration?.overageStatus === 'ENABLED' ||
                      rawUsage.overageConfiguration?.overageEnabled === true
                  }
                }

                // 解析订阅信息（注意检查顺序：先检查更具体的类型）
                const subscriptionTitle = rawUsage.subscriptionInfo?.subscriptionTitle ?? 'Free'
                let subscriptionType = 'Free'
                const titleUpper = subscriptionTitle.toUpperCase()
                if (
                  titleUpper.includes('PRO+') ||
                  titleUpper.includes('PRO_PLUS') ||
                  titleUpper.includes('PROPLUS')
                ) {
                  subscriptionType = 'Pro_Plus'
                } else if (titleUpper.includes('POWER')) {
                  subscriptionType = 'Enterprise'
                } else if (titleUpper.includes('PRO')) {
                  subscriptionType = 'Pro'
                } else if (titleUpper.includes('ENTERPRISE')) {
                  subscriptionType = 'Enterprise'
                } else if (titleUpper.includes('TEAMS')) {
                  subscriptionType = 'Teams'
                }

                // 计算剩余天数和到期时间
                let daysRemaining: number | undefined
                let expiresAt: number | undefined
                if (rawUsage.nextDateReset) {
                  expiresAt = new Date(rawUsage.nextDateReset).getTime()
                  daysRemaining = Math.max(
                    0,
                    Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24))
                  )
                }

                subscriptionData = {
                  type: subscriptionType,
                  title: subscriptionTitle,
                  daysRemaining,
                  expiresAt,
                  overageCapability: rawUsage.subscriptionInfo?.overageCapability,
                  upgradeCapability: rawUsage.subscriptionInfo?.upgradeCapability,
                  subscriptionManagementTarget:
                    rawUsage.subscriptionInfo?.subscriptionManagementTarget
                }
              } else if (usageRes.status === 'rejected') {
                // API 调用失败（可能是封禁或 Token 过期）
                const errorMsg = usageRes.reason?.message || String(usageRes.reason)
                console.log(`[BackgroundCheck] Usage API failed for ${account.email}:`, errorMsg)
                if (errorMsg.includes('AccountSuspendedException') || errorMsg.includes('423')) {
                  status = 'error'
                  errorMessage = errorMsg
                } else if (errorMsg.includes('401')) {
                  status = 'expired'
                  errorMessage = 'Token 已过期，请刷新'
                } else {
                  status = 'error'
                  errorMessage = errorMsg
                }
              }

              // 处理用户信息响应
              if (userInfoRes.status === 'fulfilled' && userInfoRes.value) {
                const rawUserInfo = userInfoRes.value
                userInfoData = {
                  email: rawUserInfo.email,
                  userId: rawUserInfo.userId,
                  status: rawUserInfo.status
                }
                // 检查用户状态（Stale 视为正常，仅 Suspended/Disabled 等视为异常）
                if (
                  rawUserInfo.status &&
                  rawUserInfo.status !== 'Active' &&
                  rawUserInfo.status !== 'Stale' &&
                  status !== 'error'
                ) {
                  status = 'error'
                  errorMessage = `用户状态异常: ${rawUserInfo.status}`
                }
              } else if (userInfoRes.status === 'rejected') {
                // GetUserInfo 失败（封禁错误会到这里）
                const errMsg = userInfoRes.reason?.message || String(userInfoRes.reason)
                if (errMsg.includes('423') || errMsg.includes('AccountSuspended')) {
                  status = 'error'
                  errorMessage = errMsg
                }
              }

              success++
              completed++

              // 通知渲染进程更新账号
              sendRendererEvent('background-check-result', {
                id: account.id,
                success: true,
                data: {
                  usage: usageData ? { ...usageData, resourceDetail } : null,
                  subscription: subscriptionData,
                  userInfo: userInfoData,
                  status,
                  errorMessage
                }
              })
            } catch (e) {
              failed++
              completed++
              sendRendererEvent('background-check-result', {
                id: account.id,
                success: false,
                error: e instanceof Error ? e.message : 'Unknown error'
              })
            }
          })
        )

        // 通知进度
        mainWindow?.webContents.send('background-check-progress', {
          completed,
          total: accounts.length,
          success,
          failed
        })

        // 批次间延迟
        if (i + concurrency < accounts.length) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      console.log(`[BackgroundCheck] Completed: ${success} success, ${failed} failed`)
      return { success: true, completed, successCount: success, failedCount: failed }
    }
  )

  // IPC: 导出到文件
  ipcMain.handle('export-to-file', async (_event, data: string, filename: string) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出账号数据',
        defaultPath: filename,
        filters: [{ name: 'JSON Files', extensions: ['json'] }]
      })

      if (!result.canceled && result.filePath) {
        await writeFile(result.filePath, data, 'utf-8')
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to export:', error)
      return false
    }
  })

  // IPC: 从文件导入
  ipcMain.handle('import-from-file', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '导入账号数据',
        filters: [
          { name: '所有支持的格式', extensions: ['json', 'csv', 'txt'] },
          { name: 'JSON Files', extensions: ['json'] },
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'TXT Files', extensions: ['txt'] }
        ],
        properties: ['openFile']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0]
        const content = await readFile(filePath, 'utf-8')
        const ext = filePath.split('.').pop()?.toLowerCase() || 'json'
        return { content, format: ext }
      }
      return null
    } catch (error) {
      console.error('Failed to import:', error)
      return null
    }
  })

  // IPC: 验证凭证并获取账号信息（用于添加账号）
  ipcMain.handle(
    'verify-account-credentials',
    async (
      _event,
      credentials: {
        refreshToken?: string
        clientId?: string
        clientSecret?: string
        credentialKind?: 'oauth' | 'kiro_api_key'
        kiroApiKey?: string
        region?: string
        authMethod?: string
        provider?: string // 'BuilderId', 'Github', 'Google' 等
      }
    ) =>
      runCredentialRefreshOperation(
        { success: false as const, error: CREDENTIAL_REFRESH_UNAVAILABLE },
        async () => {
          console.log('[IPC] verify-account-credentials called')

          try {
            const {
              refreshToken,
              clientId,
              clientSecret,
              credentialKind,
              kiroApiKey,
              region = 'us-east-1',
              authMethod,
              provider
            } = credentials

            if (credentialKind === 'kiro_api_key' || kiroApiKey) {
              const normalizedKey = kiroApiKey?.trim()
              if (!normalizedKey) return { success: false, error: '请填写 Kiro API Key' }

              const usageResult = await getUsageAndLimits(
                {
                  credentialKind: 'kiro_api_key',
                  kiroApiKey: normalizedKey,
                  idp: provider || 'BuilderId'
                },
                provider || 'BuilderId',
                undefined,
                region
              )
              const creditUsage = usageResult.usageBreakdownList?.find(
                (item) => item.resourceType === 'CREDIT' || item.displayName === 'Credits'
              )
              const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
              const baseCurrent =
                creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
              const freeTrialActive = creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE'
              const freeTrialLimit = freeTrialActive
                ? (creditUsage?.freeTrialInfo?.usageLimitWithPrecision ??
                  creditUsage?.freeTrialInfo?.usageLimit ??
                  0)
                : 0
              const freeTrialCurrent = freeTrialActive
                ? (creditUsage?.freeTrialInfo?.currentUsageWithPrecision ??
                  creditUsage?.freeTrialInfo?.currentUsage ??
                  0)
                : 0
              const bonuses = (creditUsage?.bonuses ?? [])
                .filter((bonus) => bonus.status === 'ACTIVE')
                .map((bonus) => ({
                  code: bonus.bonusCode || '',
                  name: bonus.displayName || '',
                  current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                  limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                  expiresAt: bonus.expiresAt
                }))
              const totalLimit =
                baseLimit + freeTrialLimit + bonuses.reduce((sum, bonus) => sum + bonus.limit, 0)
              const totalUsed =
                baseCurrent +
                freeTrialCurrent +
                bonuses.reduce((sum, bonus) => sum + bonus.current, 0)
              const subscriptionTitle = usageResult.subscriptionInfo?.subscriptionTitle || 'Free'
              const upperTitle = subscriptionTitle.toUpperCase()
              const subscriptionType =
                upperTitle.includes('PRO+') || upperTitle.includes('PRO_PLUS')
                  ? 'Pro_Plus'
                  : upperTitle.includes('PRO')
                    ? 'Pro'
                    : upperTitle.includes('ENTERPRISE') || upperTitle.includes('POWER')
                      ? 'Enterprise'
                      : upperTitle.includes('TEAMS')
                        ? 'Teams'
                        : 'Free'
              const expiresAt = usageResult.nextDateReset
                ? new Date(usageResult.nextDateReset).getTime()
                : undefined

              return {
                success: true,
                data: {
                  email: usageResult.userInfo?.email || '',
                  userId: usageResult.userInfo?.userId || '',
                  accessToken: '',
                  refreshToken: '',
                  subscriptionType,
                  subscriptionTitle,
                  subscription: {
                    rawType: usageResult.subscriptionInfo?.type,
                    managementTarget: usageResult.subscriptionInfo?.subscriptionManagementTarget,
                    upgradeCapability: usageResult.subscriptionInfo?.upgradeCapability,
                    overageCapability: usageResult.subscriptionInfo?.overageCapability
                  },
                  usage: {
                    current: totalUsed,
                    limit: totalLimit,
                    baseLimit,
                    baseCurrent,
                    freeTrialLimit,
                    freeTrialCurrent,
                    freeTrialExpiry: creditUsage?.freeTrialInfo?.freeTrialExpiry,
                    bonuses,
                    nextResetDate: usageResult.nextDateReset,
                    resourceDetail: creditUsage
                      ? {
                          displayName: creditUsage.displayName,
                          displayNamePlural: creditUsage.displayNamePlural,
                          resourceType: creditUsage.resourceType,
                          currency: creditUsage.currency,
                          unit: creditUsage.unit,
                          overageRate: creditUsage.overageRate,
                          overageCap: creditUsage.overageCap,
                          overageEnabled:
                            usageResult.overageConfiguration?.overageStatus === 'ENABLED' ||
                            usageResult.overageConfiguration?.overageEnabled === true
                        }
                      : undefined
                  },
                  daysRemaining: expiresAt
                    ? Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
                    : undefined,
                  expiresAt
                }
              }
            }

            // 确定 idp：社交登录使用 provider，IdC 也需要根据 provider 区分 BuilderId 和 Enterprise
            const idp =
              provider &&
              (provider === 'Enterprise' || provider === 'Github' || provider === 'Google')
                ? provider
                : 'BuilderId'

            // 社交登录只需要 refreshToken，IdC 需要 clientId 和 clientSecret
            if (!refreshToken) {
              return { success: false, error: '请填写 Refresh Token' }
            }
            if (authMethod !== 'social' && (!clientId || !clientSecret)) {
              return { success: false, error: '请填写 Client ID 和 Client Secret' }
            }

            // Step 1: 使用合适的方式刷新获取 accessToken
            console.log(`[Verify] Step 1: Refreshing token (authMethod: ${authMethod || 'IdC'})...`)
            const refreshResult = await refreshUnmanagedKiroCredentials(
              refreshToken,
              clientId || '',
              clientSecret || '',
              region,
              authMethod
            )

            if (!refreshResult.success || !refreshResult.accessToken) {
              return { success: false, error: `Token 刷新失败: ${refreshResult.error}` }
            }

            console.log('[Verify] Step 2: Getting user info...')

            // Step 2: 调用 GetUserUsageAndLimits 获取用户信息
            interface Bonus {
              bonusCode?: string
              displayName?: string
              usageLimit?: number
              usageLimitWithPrecision?: number
              currentUsage?: number
              currentUsageWithPrecision?: number
              status?: string
              expiresAt?: string // API 返回的是 expiresAt
            }

            interface FreeTrialInfo {
              usageLimit?: number
              usageLimitWithPrecision?: number
              currentUsage?: number
              currentUsageWithPrecision?: number
              freeTrialStatus?: string
              freeTrialExpiry?: string
            }

            interface UsageBreakdown {
              usageLimit?: number
              usageLimitWithPrecision?: number
              currentUsage?: number
              currentUsageWithPrecision?: number
              resourceType?: string
              displayName?: string
              displayNamePlural?: string
              currency?: string
              unit?: string
              overageRate?: number
              overageCap?: number
              bonuses?: Bonus[]
              freeTrialInfo?: FreeTrialInfo
            }

            interface UsageResponse {
              nextDateReset?: string
              usageBreakdownList?: UsageBreakdown[]
              subscriptionInfo?: {
                subscriptionTitle?: string
                type?: string
                subscriptionManagementTarget?: string
                upgradeCapability?: string
                overageCapability?: string
              }
              overageConfiguration?: { overageEnabled?: boolean; overageStatus?: string }
              userInfo?: { email?: string; userId?: string }
            }

            const usageResult = (await getUsageAndLimits(
              refreshResult.accessToken,
              idp,
              undefined,
              region
            )) as UsageResponse

            // 解析用户信息
            const email = usageResult.userInfo?.email || ''
            const userId = usageResult.userInfo?.userId || ''

            // 解析订阅类型（注意检查顺序：先检查更具体的类型）
            const subscriptionTitle = usageResult.subscriptionInfo?.subscriptionTitle || 'Free'
            let subscriptionType = 'Free'
            const titleUpper = subscriptionTitle.toUpperCase()
            if (
              titleUpper.includes('PRO+') ||
              titleUpper.includes('PRO_PLUS') ||
              titleUpper.includes('PROPLUS')
            ) {
              subscriptionType = 'Pro_Plus'
            } else if (titleUpper.includes('POWER')) {
              subscriptionType = 'Enterprise'
            } else if (titleUpper.includes('PRO')) {
              subscriptionType = 'Pro'
            } else if (titleUpper.includes('ENTERPRISE')) {
              subscriptionType = 'Enterprise'
            } else if (titleUpper.includes('TEAMS')) {
              subscriptionType = 'Teams'
            }

            // 解析使用量（详细，使用精确小数）
            const creditUsage = usageResult.usageBreakdownList?.find(
              (b) => b.resourceType === 'CREDIT'
            )

            // 基础额度
            const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
            const baseCurrent =
              creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

            // 试用额度
            let freeTrialLimit = 0
            let freeTrialCurrent = 0
            let freeTrialExpiry: string | undefined
            if (creditUsage?.freeTrialInfo?.freeTrialStatus === 'ACTIVE') {
              freeTrialLimit =
                creditUsage.freeTrialInfo.usageLimitWithPrecision ??
                creditUsage.freeTrialInfo.usageLimit ??
                0
              freeTrialCurrent =
                creditUsage.freeTrialInfo.currentUsageWithPrecision ??
                creditUsage.freeTrialInfo.currentUsage ??
                0
              freeTrialExpiry = creditUsage.freeTrialInfo.freeTrialExpiry
            }

            // 奖励额度
            const bonuses: {
              code: string
              name: string
              current: number
              limit: number
              expiresAt?: string
            }[] = []
            if (creditUsage?.bonuses) {
              for (const bonus of creditUsage.bonuses) {
                if (bonus.status === 'ACTIVE') {
                  bonuses.push({
                    code: bonus.bonusCode || '',
                    name: bonus.displayName || '',
                    current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
                    limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
                    expiresAt: bonus.expiresAt
                  })
                }
              }
            }

            // 计算总额度
            const totalLimit =
              baseLimit + freeTrialLimit + bonuses.reduce((sum, b) => sum + b.limit, 0)
            const totalUsed =
              baseCurrent + freeTrialCurrent + bonuses.reduce((sum, b) => sum + b.current, 0)

            // 计算重置剩余天数
            let daysRemaining: number | undefined
            let expiresAt: number | undefined
            const nextResetDate = usageResult.nextDateReset
            if (nextResetDate) {
              expiresAt = new Date(nextResetDate).getTime()
              daysRemaining = Math.max(
                0,
                Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24))
              )
            }

            console.log('[Verify] Success! Email:', email)

            // Enterprise 账号：验证时自动获取 profileArn（BuilderId/Social 不需要调 API）
            let enterpriseProfileArn: string | undefined
            const isEnt = provider === 'Enterprise' || authMethod === 'external_idp'
            if (isEnt) {
              try {
                enterpriseProfileArn = await fetchEnterpriseProfileArn({
                  id: '',
                  accessToken: refreshResult.accessToken!,
                  region: region || 'us-east-1',
                  provider,
                  authMethod: authMethod as 'IdC' | 'social' | 'idc' | 'external_idp' | undefined
                })
                if (enterpriseProfileArn) {
                  console.log(
                    `[Verify] Enterprise profileArn auto-resolved: ${enterpriseProfileArn}`
                  )
                }
              } catch (e) {
                console.warn('[Verify] Failed to fetch Enterprise profileArn:', e)
              }
            }

            return {
              success: true,
              data: {
                email,
                userId,
                accessToken: refreshResult.accessToken,
                refreshToken: refreshResult.refreshToken || refreshToken,
                expiresIn: refreshResult.expiresIn,
                profileArn: enterpriseProfileArn || undefined,
                subscriptionType,
                subscriptionTitle,
                subscription: {
                  rawType: usageResult.subscriptionInfo?.type,
                  managementTarget: usageResult.subscriptionInfo?.subscriptionManagementTarget,
                  upgradeCapability: usageResult.subscriptionInfo?.upgradeCapability,
                  overageCapability: usageResult.subscriptionInfo?.overageCapability
                },
                usage: {
                  current: totalUsed,
                  limit: totalLimit,
                  baseLimit,
                  baseCurrent,
                  freeTrialLimit,
                  freeTrialCurrent,
                  freeTrialExpiry,
                  bonuses,
                  nextResetDate,
                  resourceDetail: creditUsage
                    ? {
                        displayName: creditUsage.displayName,
                        displayNamePlural: creditUsage.displayNamePlural,
                        resourceType: creditUsage.resourceType,
                        currency: creditUsage.currency,
                        unit: creditUsage.unit,
                        overageRate: creditUsage.overageRate,
                        overageCap: creditUsage.overageCap,
                        overageEnabled:
                          usageResult.overageConfiguration?.overageStatus === 'ENABLED' ||
                          usageResult.overageConfiguration?.overageEnabled === true
                      }
                    : undefined
                },
                daysRemaining,
                expiresAt
              }
            }
          } catch (error) {
            console.error('[Verify] Error:', error)
            return { success: false, error: error instanceof Error ? error.message : '验证失败' }
          }
        }
      )
  )

  // ============ 手动登录相关 IPC ============

  // 存储当前登录状态
  let currentLoginState: {
    type: 'builderid' | 'social' | 'iamsso'
    // BuilderId / IAM SSO 相关
    clientId?: string
    clientSecret?: string
    deviceCode?: string
    userCode?: string
    verificationUri?: string
    interval?: number
    expiresAt?: number
    startUrl?: string // IAM SSO 专用
    redirectUri?: string // IAM SSO Authorization Code flow
    region?: string // IAM SSO region
    // Social Auth 相关
    codeVerifier?: string
    codeChallenge?: string
    oauthState?: string
    provider?: string
  } | null = null

  // IPC: 启动 Builder ID 手动登录
  ipcMain.handle('start-builder-id-login', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Starting Builder ID login...')

    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const startUrl = 'https://view.awsapps.com/start'
    const scopes = [
      'codewhisperer:completions',
      'codewhisperer:analysis',
      'codewhisperer:conversations',
      'codewhisperer:transformations',
      'codewhisperer:taskassist'
    ]

    try {
      // Step 1: 注册 OIDC 客户端
      console.log('[Login] Step 1: Registering OIDC client...')
      const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientName: APP_NAME,
          clientType: 'public',
          scopes,
          grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
          issuerUrl: startUrl
        })
      })

      if (!regRes.ok) {
        const errText = await regRes.text()
        return { success: false, error: `注册客户端失败: ${errText}` }
      }

      const regData = await regRes.json()
      const clientId = regData.clientId
      const clientSecret = regData.clientSecret
      console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

      // Step 2: 发起设备授权
      console.log('[Login] Step 2: Starting device authorization...')
      const authRes = await fetchWithAppProxy(`${oidcBase}/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret, startUrl })
      })

      if (!authRes.ok) {
        const errText = await authRes.text()
        return { success: false, error: `设备授权失败: ${errText}` }
      }

      const authData = await authRes.json()
      const {
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete,
        interval = 5,
        expiresIn = 600
      } = authData
      console.log('[Login] Device code obtained, user_code:', userCode)

      // 保存登录状态
      currentLoginState = {
        type: 'builderid',
        clientId,
        clientSecret,
        deviceCode,
        userCode,
        verificationUri,
        interval,
        expiresAt: Date.now() + expiresIn * 1000
      }

      return {
        success: true,
        userCode,
        verificationUri: verificationUriComplete || verificationUri,
        expiresIn,
        interval
      }
    } catch (error) {
      console.error('[Login] Error:', error)
      return { success: false, error: error instanceof Error ? error.message : '登录失败' }
    }
  })

  // IPC: 轮询 Builder ID 授权状态
  ipcMain.handle('poll-builder-id-auth', async (_event, region: string = 'us-east-1') => {
    console.log('[Login] Polling for authorization...')

    if (!currentLoginState || currentLoginState.type !== 'builderid') {
      return { success: false, error: '没有进行中的登录' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      currentLoginState = null
      return { success: false, error: '授权已过期，请重新开始' }
    }

    const oidcBase = `https://oidc.${region}.amazonaws.com`
    const { clientId, clientSecret, deviceCode } = currentLoginState

    try {
      const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode
        })
      })

      if (tokenRes.status === 200) {
        const tokenData = await tokenRes.json()
        console.log('[Login] Authorization successful!')

        const result = {
          success: true,
          completed: true,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          clientId,
          clientSecret,
          region,
          expiresIn: tokenData.expiresIn
        }

        currentLoginState = null
        return result
      } else if (tokenRes.status === 400) {
        const errData = await tokenRes.json()
        const error = errData.error

        if (error === 'authorization_pending') {
          return { success: true, completed: false, status: 'pending' }
        } else if (error === 'slow_down') {
          if (currentLoginState) {
            currentLoginState.interval = (currentLoginState.interval || 5) + 5
          }
          return { success: true, completed: false, status: 'slow_down' }
        } else if (error === 'expired_token') {
          currentLoginState = null
          return { success: false, error: '设备码已过期' }
        } else if (error === 'access_denied') {
          currentLoginState = null
          return { success: false, error: '用户拒绝授权' }
        } else {
          currentLoginState = null
          return { success: false, error: `授权错误: ${error}` }
        }
      } else {
        return { success: false, error: `未知响应: ${tokenRes.status}` }
      }
    } catch (error) {
      console.error('[Login] Poll error:', error)
      return { success: false, error: error instanceof Error ? error.message : '轮询失败' }
    }
  })

  // IPC: 取消 Builder ID 登录
  ipcMain.handle('cancel-builder-id-login', async () => {
    console.log('[Login] Cancelling Builder ID login...')
    currentLoginState = null
    return { success: true }
  })

  // IAM SSO 本地服务器和状态
  let iamSsoServer: ReturnType<typeof import('http').createServer> | null = null
  let iamSsoResult: {
    completed: boolean
    success: boolean
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresIn?: number
    error?: string
  } | null = null

  // IPC: 启动 IAM Identity Center SSO 登录 (使用 Authorization Code Grant with PKCE)
  ipcMain.handle(
    'start-iam-sso-login',
    async (_event, startUrl: string, region: string = 'us-east-1') => {
      console.log('[Login] Starting IAM Identity Center SSO login (Authorization Code flow)...')
      console.log('[Login] Start URL:', startUrl)

      // 验证 startUrl 格式
      if (!startUrl || !startUrl.startsWith('https://')) {
        return { success: false, error: 'SSO Start URL 必须以 https:// 开头' }
      }

      const crypto = await import('crypto')
      const http = await import('http')

      const oidcBase = `https://oidc.${region}.amazonaws.com`
      const scopes = [
        'codewhisperer:completions',
        'codewhisperer:analysis',
        'codewhisperer:conversations',
        'codewhisperer:transformations',
        'codewhisperer:taskassist'
      ]

      try {
        // Step 1: 注册 OIDC 客户端 (使用 authorization_code grant type)
        console.log('[Login] Step 1: Registering OIDC client...')
        const regRes = await fetchWithAppProxy(`${oidcBase}/client/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientName: APP_NAME,
            clientType: 'public',
            scopes,
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris: ['http://127.0.0.1/oauth/callback'],
            issuerUrl: startUrl
          })
        })

        if (!regRes.ok) {
          const errText = await regRes.text()
          console.error('[Login] IAM SSO client registration failed:', regRes.status, errText)

          if (errText.includes('UnauthorizedException') || errText.includes('access denied')) {
            return {
              success: false,
              error:
                '授权失败：您的组织可能未配置 Amazon Q Developer 访问权限。请联系组织管理员在 IAM Identity Center 中启用相关权限。'
            }
          }

          return { success: false, error: `注册客户端失败: ${errText}` }
        }

        const regData = await regRes.json()
        const clientId = regData.clientId
        const clientSecret = regData.clientSecret
        console.log('[Login] Client registered:', clientId.substring(0, 30) + '...')

        // Step 2: 生成 PKCE 和 state
        const codeVerifier = crypto.randomBytes(32).toString('base64url')
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
        const state = crypto.randomUUID()

        // Step 3: 启动本地 HTTP 服务器接收回调
        console.log('[Login] Step 2: Starting local OAuth callback server...')

        // 关闭之前的服务器
        if (iamSsoServer) {
          iamSsoServer.close()
          iamSsoServer = null
        }

        // 找一个可用端口
        const port = await new Promise<number>((resolve, reject) => {
          const server = http.createServer()
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address()
            if (addr && typeof addr === 'object') {
              const p = addr.port
              server.close(() => resolve(p))
            } else {
              reject(new Error('无法获取端口'))
            }
          })
        })

        const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
        console.log('[Login] Redirect URI:', redirectUri)

        // 重置结果
        iamSsoResult = null

        // 创建回调服务器
        iamSsoServer = http.createServer(async (req, res) => {
          const url = new URL(req.url || '', `http://127.0.0.1:${port}`)

          if (url.pathname === '/oauth/callback') {
            const code = url.searchParams.get('code')
            const returnedState = url.searchParams.get('state')
            const error = url.searchParams.get('error')

            if (error) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end('<html><body><h1>授权失败</h1><p>您可以关闭此窗口。</p></body></html>')
              iamSsoResult = { completed: true, success: false, error: `授权失败: ${error}` }
              return
            }

            if (returnedState !== state) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end('<html><body><h1>授权失败</h1><p>状态不匹配，请重试。</p></body></html>')
              iamSsoResult = { completed: true, success: false, error: '状态不匹配' }
              return
            }

            if (code) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end('<html><body><h1>授权成功！</h1><p>正在获取令牌，请稍候...</p></body></html>')

              // 自动完成 token 交换
              try {
                const tokenRes = await fetchWithAppProxy(`${oidcBase}/token`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    clientId,
                    clientSecret,
                    grantType: 'authorization_code',
                    redirectUri,
                    code,
                    codeVerifier
                  })
                })

                if (!tokenRes.ok) {
                  const errText = await tokenRes.text()
                  console.error('[Login] Token exchange failed:', tokenRes.status, errText)
                  iamSsoResult = {
                    completed: true,
                    success: false,
                    error: `获取 Token 失败: ${errText}`
                  }
                } else {
                  const tokenData = await tokenRes.json()
                  console.log('[Login] IAM SSO Authorization successful!')
                  iamSsoResult = {
                    completed: true,
                    success: true,
                    accessToken: tokenData.accessToken,
                    refreshToken: tokenData.refreshToken,
                    clientId,
                    clientSecret,
                    region,
                    expiresIn: tokenData.expiresIn
                  }
                }
              } catch (tokenError) {
                console.error('[Login] Token exchange error:', tokenError)
                iamSsoResult = {
                  completed: true,
                  success: false,
                  error: tokenError instanceof Error ? tokenError.message : '获取 Token 失败'
                }
              }
            } else {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
              res.end('<html><body><h1>授权失败</h1><p>未收到授权码。</p></body></html>')
              iamSsoResult = { completed: true, success: false, error: '未收到授权码' }
            }
          } else {
            res.writeHead(404)
            res.end('Not Found')
          }
        })

        iamSsoServer.listen(port, '127.0.0.1', () => {
          console.log('[Login] OAuth callback server listening on port', port)
        })

        // Step 4: 构建授权 URL 并打开浏览器
        const authorizeParams = new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: redirectUri,
          scopes: scopes.join(','),
          state: state,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256'
        })
        const authorizeUrl = `${oidcBase}/authorize?${authorizeParams.toString()}`
        console.log('[Login] Opening browser for authorization...')

        // 保存登录状态
        currentLoginState = {
          type: 'iamsso',
          clientId,
          clientSecret,
          codeVerifier,
          redirectUri,
          region,
          startUrl,
          expiresAt: Date.now() + 600000
        }

        // 返回授权 URL，前端会打开浏览器
        return {
          success: true,
          authorizeUrl,
          expiresIn: 600
        }
      } catch (error) {
        console.error('[Login] Error:', error)
        return { success: false, error: error instanceof Error ? error.message : '登录失败' }
      }
    }
  )

  // IPC: 轮询 IAM SSO 授权状态 (检查本地服务器是否收到回调)
  ipcMain.handle('poll-iam-sso-auth', async () => {
    if (!currentLoginState || currentLoginState.type !== 'iamsso') {
      return { success: false, error: '没有进行中的 IAM SSO 登录' }
    }

    if (Date.now() > (currentLoginState.expiresAt || 0)) {
      if (iamSsoServer) {
        iamSsoServer.close()
        iamSsoServer = null
      }
      iamSsoResult = null
      currentLoginState = null
      return { success: false, error: '授权已过期，请重新开始' }
    }

    // 检查是否已收到回调并完成 token 交换
    if (iamSsoResult) {
      const result = { ...iamSsoResult }
      if (result.completed) {
        // 清理状态
        if (iamSsoServer) {
          iamSsoServer.close()
          iamSsoServer = null
        }
        iamSsoResult = null
        currentLoginState = null
      }
      return result
    }

    // 还在等待回调
    return { success: true, completed: false, status: 'pending' }
  })

  // IPC: 取消 IAM SSO 登录
  ipcMain.handle('cancel-iam-sso-login', async () => {
    console.log('[Login] Cancelling IAM SSO login...')
    if (iamSsoServer) {
      iamSsoServer.close()
      iamSsoServer = null
    }
    iamSsoResult = null
    currentLoginState = null
    return { success: true }
  })

  // IPC: 启动 Social Auth 登录 (Google/GitHub)
  ipcMain.handle('start-social-login', async (_event, provider: 'Google' | 'Github') => {
    console.log(`[Login] Starting ${provider} Social Auth login in built-in incognito browser...`)

    const crypto = await import('crypto')

    // 生成 PKCE
    const codeVerifier = crypto.randomBytes(64).toString('base64url').substring(0, 128)
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    const oauthState = crypto.randomBytes(32).toString('base64url')

    // 构建登录 URL
    const redirectUri = APP_SOCIAL_AUTH_REDIRECT_URI
    const loginUrl = new URL(`${KIRO_AUTH_ENDPOINT}/login`)
    loginUrl.searchParams.set('idp', provider)
    loginUrl.searchParams.set('redirect_uri', redirectUri)
    loginUrl.searchParams.set('code_challenge', codeChallenge)
    loginUrl.searchParams.set('code_challenge_method', 'S256')
    loginUrl.searchParams.set('state', oauthState)

    // 保存登录状态
    currentLoginState = {
      type: 'social',
      codeVerifier,
      codeChallenge,
      oauthState,
      provider
    }

    const urlStr = loginUrl.toString()
    console.log(`[Login] Opening browser for ${provider} login...`)

    openBrowserInPrivateMode(urlStr)

    return {
      success: true,
      loginUrl: urlStr,
      state: oauthState
    }
  })

  // IPC: 交换 Social Auth token
  ipcMain.handle('exchange-social-token', async (_event, code: string, state: string) => {
    console.log('[Login] Exchanging Social Auth token...')

    if (!currentLoginState || currentLoginState.type !== 'social') {
      return { success: false, error: '没有进行中的社交登录' }
    }

    // 验证 state
    if (state !== currentLoginState.oauthState) {
      currentLoginState = null
      return { success: false, error: '状态参数不匹配，可能存在安全风险' }
    }

    const { codeVerifier, provider } = currentLoginState
    const redirectUri = APP_SOCIAL_AUTH_REDIRECT_URI

    try {
      const tokenRes = await fetchWithAppProxy(`${KIRO_AUTH_ENDPOINT}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri
        })
      })

      if (!tokenRes.ok) {
        const errText = await tokenRes.text()
        currentLoginState = null
        return { success: false, error: `Token 交换失败: ${errText}` }
      }

      const tokenData = await tokenRes.json()
      console.log('[Login] Token exchange successful!')

      const result = {
        success: true,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        profileArn: tokenData.profileArn,
        expiresIn: tokenData.expiresIn,
        authMethod: 'social' as const,
        provider
      }

      currentLoginState = null
      return result
    } catch (error) {
      console.error('[Login] Token exchange error:', error)
      currentLoginState = null
      return { success: false, error: error instanceof Error ? error.message : 'Token 交换失败' }
    }
  })

  // IPC: 取消 Social Auth 登录
  ipcMain.handle('cancel-social-login', async () => {
    console.log('[Login] Cancelling Social Auth login...')
    currentLoginState = null
    return { success: true }
  })

  // IPC: 设置代理
  ipcMain.handle('set-proxy', async (_event, enabled: boolean, url: string) => {
    const normalizedUrl = enabled && url ? normalizeProxyUrl(url) : url
    const electronProxy = getElectronProxySettings(normalizedUrl)
    console.log(
      `[IPC] set-proxy called: enabled=${enabled}, url=${normalizedUrl ? redactProxyUrl(normalizedUrl) : ''}${normalizedUrl !== url ? ' (代理地址已规范化)' : ''}`
    )
    try {
      applyProxySettings(enabled, url)

      // 同时设置 Electron 的 session 代理
      if (mainWindow) {
        const session = mainWindow.webContents.session
        if (enabled && electronProxy) {
          await session.setProxy({ proxyRules: electronProxy.proxyRules })
        } else {
          await session.setProxy({ proxyRules: '' })
        }
      }

      return { success: true, normalizedUrl }
    } catch (error) {
      console.error('[Proxy] Failed to set proxy:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============ 诊断模型查询 IPC ============

  // IPC: 获取当前账号可用模型（诊断功能使用）
  ipcMain.handle('get-kiro-available-models', async () => {
    try {
      if (!store) return { models: [] }
      const accountData = store.get('accountData') as { accounts?: Record<string, any> } | undefined
      if (!accountData?.accounts) return { models: [] }

      const allAccounts = Object.values(accountData.accounts) as any[]
      const account =
        allAccounts.find(
          (acc: any) =>
            acc.isActive && (acc.credentials?.accessToken || acc.credentials?.kiroApiKey)
        ) ||
        allAccounts.find(
          (acc: any) =>
            acc.status === 'active' && (acc.credentials?.accessToken || acc.credentials?.kiroApiKey)
        )
      if (!account) return { models: [] }

      const credential = resolveUpstreamKiroCredential({
        credentialKind: account.credentials?.credentialKind,
        accessToken: account.credentials?.accessToken,
        kiroApiKey: account.credentials?.kiroApiKey,
        idp: account.credentials?.provider || account.idp
      })
      // 账号库模式：凭据以库为准，先请 kiro-rs 确保新鲜
      const context = await accountDbUpstreamContext(account.id)
      if (context && 'error' in context) {
        console.warn('[Diagnose] 账号库凭据不可用：', context.error)
        return { models: [] }
      }
      const models = await fetchKiroModels({
        id: account.id,
        email: account.email,
        ...(context?.credential ?? credential),
        refreshToken: account.credentials?.refreshToken,
        profileArn: context?.profileArn ?? (account.profileArn || account.credentials?.profileArn),
        expiresAt: account.credentials?.expiresAt,
        clientId: account.credentials?.clientId,
        clientSecret: account.credentials?.clientSecret,
        region: context?.region ?? (account.credentials?.region || 'us-east-1'),
        authMethod: context?.authMethod ?? account.credentials?.authMethod,
        proxyUrl: context?.proxyUrl
      } as ProxyAccount)
      return {
        models: models.map((m) => ({
          id: m.modelId,
          name: m.modelName,
          description: m.description
        }))
      }
    } catch (error) {
      console.error('[Diagnose] Failed to fetch available models:', error)
      return {
        models: [],
        error: error instanceof Error ? error.message : 'Failed to fetch models'
      }
    }
  })

  // IPC: 获取账户可用模型列表
  ipcMain.handle(
    'account-get-models',
    async (
      _event,
      credentialInput: UpstreamKiroCredential,
      region?: string,
      profileArn?: string,
      provider?: string,
      authMethod?: string,
      accountId?: string
    ) => {
      try {
        const credential =
          typeof credentialInput === 'string'
            ? resolveUpstreamKiroCredential({ accessToken: credentialInput })
            : resolveUpstreamKiroCredential(credentialInput)
        const boundProxyUrl = accountId ? readAccountBoundProxyUrl(accountId) : undefined
        // 账号库模式：凭据不经渲染层，先请 kiro-rs 确保新鲜再从库里取
        const context = await accountDbUpstreamContext(accountId)
        if (context && 'error' in context)
          return { success: false, error: context.error, models: [] }
        const models = await withAccountDbRetry(
          accountId,
          (fresh) =>
            fetchKiroModels({
              id: accountId || 'model-list-request',
              ...(fresh?.credential ?? credential),
              region: fresh?.region || region || 'us-east-1',
              profileArn: fresh?.profileArn ?? profileArn,
              provider: fresh?.provider ?? provider,
              authMethod: (fresh?.authMethod ?? authMethod) as ProxyAccount['authMethod'],
              proxyUrl: fresh?.proxyUrl ?? boundProxyUrl
            } as ProxyAccount),
          context
        )
        return {
          success: true,
          models: models.map((m) => ({
            id: m.modelId,
            name: m.modelName,
            description: m.description,
            inputTypes: m.supportedInputTypes,
            maxInputTokens: m.tokenLimits?.maxInputTokens,
            maxOutputTokens: m.tokenLimits?.maxOutputTokens,
            rateMultiplier: m.rateMultiplier,
            rateUnit: m.rateUnit
          }))
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get models',
          models: []
        }
      }
    }
  )

  // IPC: 获取可用订阅列表
  ipcMain.handle(
    'account-get-subscriptions',
    async (
      _event,
      credentialInput: UpstreamKiroCredential,
      region?: string,
      profileArn?: string,
      provider?: string,
      authMethod?: string,
      accountId?: string
    ) => {
      try {
        const credential =
          typeof credentialInput === 'string'
            ? resolveUpstreamKiroCredential({ accessToken: credentialInput })
            : resolveUpstreamKiroCredential(credentialInput)
        const context = await accountDbUpstreamContext(accountId)
        if (context && 'error' in context)
          return { success: false, error: context.error, plans: [] }
        const result = await withAccountDbRetry(
          accountId,
          (fresh) =>
            fetchAvailableSubscriptions({
              id: accountId || 'subscription-request',
              ...(fresh?.credential ?? credential),
              region: fresh?.region || region || 'us-east-1',
              profileArn: fresh?.profileArn ?? profileArn,
              provider: fresh?.provider ?? provider,
              authMethod: fresh?.authMethod ?? authMethod,
              proxyUrl: fresh?.proxyUrl
            } as ProxyAccount),
          context
        )
        if (result.subscriptionPlans) {
          return { success: true, plans: result.subscriptionPlans, disclaimer: result.disclaimer }
        }
        return { success: false, error: 'No subscription plans returned', plans: [] }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get subscriptions',
          plans: []
        }
      }
    }
  )

  // IPC: 获取订阅管理/支付链接
  ipcMain.handle(
    'account-get-subscription-url',
    async (
      _event,
      credentialInput: UpstreamKiroCredential,
      subscriptionType?: string,
      region?: string,
      profileArn?: string,
      provider?: string,
      authMethod?: string,
      accountId?: string
    ) => {
      try {
        const credential =
          typeof credentialInput === 'string'
            ? resolveUpstreamKiroCredential({ accessToken: credentialInput })
            : resolveUpstreamKiroCredential(credentialInput)
        const context = await accountDbUpstreamContext(accountId)
        if (context && 'error' in context) return { success: false, error: context.error }
        const result = await withAccountDbRetry(
          accountId,
          (fresh) =>
            fetchSubscriptionToken(
              {
                id: accountId || 'subscription-request',
                ...(fresh?.credential ?? credential),
                region: fresh?.region || region || 'us-east-1',
                profileArn: fresh?.profileArn ?? profileArn,
                provider: fresh?.provider ?? provider,
                authMethod: fresh?.authMethod ?? authMethod,
                proxyUrl: fresh?.proxyUrl
              } as ProxyAccount,
              subscriptionType
            ),
          context
        )
        if (result.encodedVerificationUrl)
          return { success: true, url: result.encodedVerificationUrl, status: result.status }
        return { success: false, error: result.message || 'No subscription URL returned' }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get subscription URL'
        }
      }
    }
  )

  // IPC: 在系统默认浏览器无痕模式中打开订阅链接
  ipcMain.handle('open-subscription-window', async (_event, url: string) => {
    try {
      openBrowserInPrivateMode(url)
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to open URL'
      }
    }
  })

  // 更新协议处理函数以支持 Social Auth 回调
  const originalHandleProtocolUrl = handleProtocolUrl
  // @ts-ignore - 重新定义协议处理
  handleProtocolUrl = (url: string): void => {
    if (!isAppCallbackUrl(url)) return

    try {
      const urlObj = new URL(url)

      // 处理 Social Auth 回调
      if (url.includes('authenticate-success') || url.includes('auth')) {
        const code = urlObj.searchParams.get('code')
        const state = urlObj.searchParams.get('state')
        const error = urlObj.searchParams.get('error')

        if (error) {
          console.log('[Login] Auth callback error:', error)
          if (mainWindow) {
            mainWindow.webContents.send('social-auth-callback', { error })
            mainWindow.focus()
          }
          return
        }

        if (code && state && mainWindow) {
          console.log('[Login] Auth callback received, code:', code.substring(0, 20) + '...')
          mainWindow.webContents.send('social-auth-callback', { code, state })
          mainWindow.focus()
        }
        return
      }

      // 调用原始处理函数处理其他协议
      originalHandleProtocolUrl(url)
    } catch (error) {
      console.error('Failed to parse protocol URL:', error)
    }
  }

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow) {
      // macOS: 点击 Dock 图标时显示主窗口
      if (process.platform === 'darwin' && app.dock) {
        app.dock.show()
      }
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  // 加载并注册全局快捷键
  await loadShortcutSettings()
  registerShowWindowShortcut()
})

// Windows/Linux: 处理第二个实例和协议 URL
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Windows: 协议 URL 会作为命令行参数传入
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL_PREFIX}://`))
    if (url) {
      handleProtocolUrl(url)
    }

    // 聚焦主窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// macOS: 处理协议 URL
app.on('open-url', (_event, url) => {
  handleProtocolUrl(url)
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

async function runAccountDbCommand(argv: readonly string[]): Promise<void> {
  const userDataDir = app.getPath('userData')
  const config = loadAccountDbConfig(userDataDir) ?? defaultAccountDbConfig()
  const credentialsArg = argv.find((arg) => arg.startsWith('--kiro-credentials='))
  const credentialsPath =
    credentialsArg?.slice('--kiro-credentials='.length) ??
    join(dirname(config.kiroRs.configPath), 'credentials.json')
  try {
    if (!rawAccountStore) throw new Error('electron-store 未初始化')
    if (argv.includes('--rollback-account-db')) {
      rollbackAccountDb({
        config,
        userDataDir,
        rawStore: rawAccountStore,
        credentialsDir: dirname(credentialsPath)
      })
    } else {
      if (config.enabled) throw new Error('账号库模式已启用，无需再次迁移')
      await runMigration(
        {
          config,
          userDataDir,
          rawStore: rawAccountStore,
          registry: await loadAdminManagedEntries(),
          kiroRsBinary: resolveKiroRsBinary(config),
          credentialsPath,
          proxyUrlFor: resolveBoundProxyUrl
        },
        { dryRun: !argv.includes('--migrate-account-db=apply') }
      )
    }
    app.exit(0)
  } catch (error) {
    console.error('[AccountDb] 命令失败：', error instanceof Error ? error.message : error)
    app.exit(1)
  }
}

/**
 * kiro-rs 续期后把新凭据同步给 kiro-cli。
 *
 * 只在"CLI 当前那份确实是管理器写入的"时覆盖；被用户手动改过就停止同步并提示。
 */
async function syncKiroCliAfterAccountDbChange(): Promise<void> {
  if (!store) return
  const syncStore = store as unknown as Parameters<typeof syncKiroCliFromAccountDb>[0]['store']
  const state = readKiroCliSyncState(syncStore)
  if (!state) return
  try {
    const outcome = await syncKiroCliFromAccountDb({
      store: syncStore,
      row: accountDbRow(state.accountId)
    })
    if (outcome.status === 'synced') {
      console.log(
        `[KiroCLI] 已把账号 ${outcome.accountId} 的新凭据同步给 CLI（版本 ${outcome.credentialVersion}）`
      )
    } else if (outcome.status === 'detached') {
      console.warn(`[KiroCLI] 停止自动同步：${outcome.reason}`)
    } else if (outcome.status === 'needs-reauth') {
      console.warn(
        `[KiroCLI] 账号 ${outcome.accountId} 需要重新登录：账号库中的 Refresh Token 已失效（CLI 可能自行刷新过一次）`
      )
      sendRendererEvent('kiro-cli-needs-reauth', { accountId: outcome.accountId })
    }
  } catch (error) {
    console.warn('[KiroCLI] 同步失败：', error instanceof Error ? error.message : error)
  }
}

/**
 * 账号库模式下 CLI 当前账号的续期兜底。
 *
 * kiro-rs 后台每分钟会刷新临期凭据，正常情况下 CLI 只需等同步。这里多一道：CLI 手里的
 * token 临期时主动请 kiro-rs 确保新鲜，避免"proxy 在跑但恰好错过 kiro-rs 那一轮"。
 * 与社交专用的 kiroCliSocialRenewal 不同，它覆盖社交与 IdC 两种账号。
 */
async function maintainKiroCliFromAccountDb(): Promise<void> {
  if (!store) return
  const state = readKiroCliSyncState(store as unknown as Parameters<typeof readKiroCliSyncState>[0])
  if (!state) return
  const row = accountDbRow(state.accountId)
  if (!row) return
  const expiringSoon =
    row.expiresAtMs === null || row.expiresAtMs - Date.now() <= KIRO_CLI_RENEWAL_LEAD_MS
  if (expiringSoon) {
    const fresh = await ensureFreshAccountDbCredential({
      accountId: state.accountId,
      expectedCredentialVersion: row.credentialVersion
    })
    if (fresh && !fresh.success) {
      console.warn(`[KiroCLI] 续期 CLI 当前账号失败：${fresh.error}`)
    }
  }
  await syncKiroCliAfterAccountDbChange()
}

/** 账号库模式的后台服务：拉起 kiro-rs 子进程、监听跨端变化推给渲染进程 */
async function startAccountDbServices(): Promise<void> {
  startAccountDbWatcher(() => {
    sendRendererEvent('account-db-changed', null)
    void syncKiroCliAfterAccountDbChange()
  })
  // CLI 当前账号的续期兜底；与 kiro-rs 后台那轮互不冲突（ensure-fresh 幂等）
  accountDbCliTimer = setInterval(() => {
    void maintainKiroCliFromAccountDb()
  }, KIRO_CLI_RENEWAL_INTERVAL_MS)
  const config = loadAccountDbConfig(app.getPath('userData'))
  if (!config) return
  try {
    await startManagedKiroRs({
      binary: resolveKiroRsBinary(config),
      onLog: (line) => console.log(`[kiro-rs] ${line}`),
      onStateChange: (state, detail) => {
        console.log(`[kiro-rs] 状态：${state}${detail ? `（${detail}）` : ''}`)
        sendRendererEvent('account-db-status', { ...accountDbStatus(), error: detail })
      }
    })
  } catch (error) {
    console.error('[kiro-rs] 启动失败：', error instanceof Error ? error.message : error)
  }
}

// 应用退出前注销 URI 协议处理器并保存数据
app.on('will-quit', async (event) => {
  // 防止重复处理
  if (isQuitting) return

  // 停止主进程池 token 刷新调度器
  stopMainPoolTokenRefresh()
  // 停止代理池定时验活调度器
  proxyPoolScheduler.stop()
  // 停止 KSK Provider 轮询与后续调度
  kskAutomationManager.stop()
  // 停止 KSK 抢号轮询与推送重试
  kskHunterManager.stop()
  // 停止反代统计采样
  localAdminStatsManager.stop()
  void localAdminDirectAgent.close()
  stopAccountDbWatcher()
  if (accountDbCliTimer) {
    clearInterval(accountDbCliTimer)
    accountDbCliTimer = null
  }

  // 防止应用立即退出，先保存数据
  if (lastSavedData && store) {
    event.preventDefault()
    isQuitting = true

    // 设置超时，确保 3 秒后强制退出（防止关机阻塞）
    const forceQuitTimer = setTimeout(() => {
      console.log('[Exit] Force quit due to timeout')
      unregisterProtocol()
      app.exit(0)
    }, 3000)

    try {
      await accountStoreCoordinator.runExclusive(async () => {
        console.log('[Exit] Saving data before quit...')
        store!.set('accountData', lastSavedData)
        // 退出场景跳过节流，确保备份立即落盘
        await createBackup(lastSavedData)
        await flushBackupNow()
        // 强制落盘代理日志（异步节流中的尾巴数据）
        try {
          const { proxyLogStore } = await import('./proxy/logger')
          await proxyLogStore.flushSaveNow()
        } catch (err) {
          console.error('[Exit] Failed to flush proxy logs:', err)
        }
        // 释放共享的 TLS ModuleClient（worker pool + DLL）
        try {
          const { shutdownTlsClientPool } = await import('./registration/tlsClientPool')
          await shutdownTlsClientPool()
        } catch (err) {
          console.error('[Exit] Failed to shutdown TLS client pool:', err)
        }
      })
      console.log('[Exit] Data saved successfully')
    } catch (error) {
      console.error('[Exit] Failed to save data:', error)
    }
    // kiro-rs 与 proxy 同生共死：先让它把统计写完再退出
    await stopManagedKiroRs().catch((error) =>
      console.error('[Exit] Failed to stop kiro-rs:', error)
    )

    clearTimeout(forceQuitTimer)
    unregisterProtocol()
    app.exit(0)
  } else {
    void stopManagedKiroRs()
    unregisterProtocol()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
