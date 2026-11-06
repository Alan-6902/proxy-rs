// 凭据状态响应
export interface CredentialsStatusResponse {
  total: number
  available: number
  currentId: number
  credentials: CredentialStatusItem[]
}

// 单个凭据状态
export interface CredentialStatusItem {
  id: number
  priority: number
  disabled: boolean
  failureCount: number
  isCurrent: boolean
  expiresAt: string | null
  authMethod: string | null
  hasProfileArn: boolean
  email?: string
  refreshTokenHash?: string
  apiKeyHash?: string
  maskedApiKey?: string
  successCount: number
  lastUsedAt: string | null
  hasProxy: boolean
  proxyUrl?: string
  refreshFailureCount: number
  disabledReason?: string
  endpoint: string
  /** 实际生效的 Auth Region（Token 刷新用），后端已回退到全局配置 */
  authRegion: string
  /** 实际生效的 API Region（API 请求用），后端已回退到全局配置 */
  apiRegion: string
  /** 是否在反代号池中。共享账号库模式下可能为 false（账号由 proxy-rs 管理但不参与反代） */
  inPool?: boolean
  /** kiro-cli 当前登录的账号：由 kiro-cli 刷新，kiro-rs 不刷新它 */
  externalRefresh?: boolean
  /** 账号库凭据版本 */
  credentialVersion?: number
}

/** 共享账号库信息：enabled=false 时是传统的 credentials.json 模式 */
export interface StoreInfoResponse {
  enabled: boolean
  databaseId?: string | null
  path?: string | null
}

// 余额响应
export interface BalanceResponse {
  id: number
  subscriptionTitle: string | null
  currentUsage: number
  usageLimit: number
  remaining: number
  usagePercentage: number
  nextResetAt: number | null
}

// 模型目录里每系列一个的候选；enabled 为 true 才出现在 /v1/models
export interface CatalogModel {
  id: string
  family: string
  enabled: boolean
  kiroModelId: string
  displayName: string
  ownedBy: string
  created: number
  contextWindow: number
  maxTokens: number
}

// 模型目录：fetchedAt 为空表示从未刷新，models 是兜底目录
export interface ModelCatalogResponse {
  fetchedAt: number | null
  credentialIds: number[]
  upstreamCount: number
  models: CatalogModel[]
}

// 成功响应
export interface SuccessResponse {
  success: boolean
  message: string
}

// 请求类型
export interface SetDisabledRequest {
  disabled: boolean
}

export interface SetPriorityRequest {
  priority: number
}

// 添加凭据请求
export interface AddCredentialRequest {
  refreshToken?: string
  authMethod?: 'social' | 'idc' | 'api_key'
  clientId?: string
  clientSecret?: string
  priority?: number
  authRegion?: string
  apiRegion?: string
  machineId?: string
  proxyUrl?: string
  proxyUsername?: string
  proxyPassword?: string
  kiroApiKey?: string
  endpoint?: string
}

// 添加凭据响应
export interface AddCredentialResponse {
  success: boolean
  message: string
  credentialId: number
  email?: string
}

// === Antigravity 账号池（/ag/v1） ===

export interface AgQuotaModel {
  id: string
  displayName: string | null
  remainingFraction: number
  resetTime: string | null
}

/** retrieveUserQuotaSummary 的一个窗口桶，window 形如 "5h" / "weekly" */
export interface AgQuotaBucket {
  bucketId: string | null
  window: string | null
  displayName: string | null
  remainingFraction: number | null
  resetTime: string | null
}

export interface AgQuotaGroup {
  displayName: string | null
  buckets: AgQuotaBucket[]
}

export interface AgAccount {
  id: number
  email: string
  name: string | null
  projectId: string | null
  tier: string | null
  disabled: boolean
  expiresAtMs: number | null
  /** groups 为空表示分组额度接口没拉到，按模型额度兜底展示 */
  quota: { models: AgQuotaModel[]; groups?: AgQuotaGroup[] } | null
  quotaUpdatedMs: number | null
  lastError: string | null
  lastUsedMs: number | null
  successCount: number
  failureCount: number
  refreshFailureCount: number
}

export interface AgAccountsResponse {
  accounts: AgAccount[]
  dbPath: string
}


export interface AgCatalogModel {
  id: string
  displayName: string
  contextWindow: number
  enabled: boolean
  /** 当前模型列表里有这个模型的启用账号 id */
  accountIds: number[]
}

export interface AgModelCatalogResponse {
  models: AgCatalogModel[]
}

export interface AgScanResult {
  id: number
  email: string
  ok: boolean
  error: string | null
}

export interface AgModelScanResponse extends AgModelCatalogResponse {
  scan: AgScanResult[]
}

export interface AgOAuthStart {
  sessionId: string
  authUrl: string
}

export interface AgOAuthStatus {
  status: 'pending' | 'success' | 'error'
  email?: string
  error?: string
}

// === Qoder 账号池 ===

/** 上游 /api/v2/quota/usage 原样返回，字段按需读取 */
export interface QoderQuotaPart {
  total?: number
  used?: number
  remaining?: number
  percentage?: number
  unit?: string
}

export interface QoderQuota {
  isQuotaExceeded?: boolean
  totalUsagePercentage?: number
  expiresAt?: number
  userQuota?: QoderQuotaPart
  addOnQuota?: QoderQuotaPart
  /** 企业版账号的组织资源包：只有 used / remaining，没有 total */
  orgResourcePackage?: QoderQuotaPart
}

export interface QoderAccount {
  id: number
  uid: string
  name: string | null
  email: string | null
  patTail: string
  userType: string | null
  orgName: string | null
  disabled: boolean
  expiresAtMs: number | null
  quota: QoderQuota | null
  quotaUpdatedMs: number | null
  lastError: string | null
  lastUsedMs: number | null
  successCount: number
  failureCount: number
  /** 反代累计记录的消耗 credits，跨额度周期累加 */
  consumedTotal: number
}

export interface QoderAccountsResponse {
  accounts: QoderAccount[]
  dbPath: string
}

/** 管理页给单个模型的配置；不填表示用上游默认 */
export interface QoderModelOverride {
  alias?: string
  contextWindow?: number
  effort?: string
}

export interface QoderCatalogModel {
  /** 上游 key */
  id: string
  /** 对外模型名：配了别名为别名，否则同 id */
  publicId: string
  displayName: string
  /** 实际生效的上下文窗口 */
  contextWindow: number
  maxOutput: number
  isReasoning: boolean
  enabled: boolean
  /** 上游支持的上下文档位（升序） */
  contextWindows: number[]
  defaultContextWindow: number | null
  /** 上游支持的思考强度，含 none 表示可关闭 */
  efforts: string[]
  defaultEffort: string | null
  /** 上游用量倍率，null 表示未提供；0 是有效倍率 */
  priceFactor: number | null
  originalPriceFactor: number | null
  isFree: boolean
  override: QoderModelOverride
}

export interface QoderModelCatalogResponse {
  models: QoderCatalogModel[]
}
