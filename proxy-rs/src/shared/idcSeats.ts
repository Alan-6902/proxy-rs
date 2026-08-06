/**
 * AWS Identity Center 席位管理共享定义（主进程 + preload + 渲染进程共用）
 *
 * 「母号」= 已开通 Identity Center 与 Kiro 企业版的 AWS 账号。
 * 席位 = 该账号 Identity Store 里的一个用户 + 挂在其上的一个 Kiro 订阅档位。
 *
 * 放在 shared/ 的理由：档位常量与价格同时被主进程（构造 API 请求）和
 * 渲染进程（成本预估、下拉选项）使用，两边各写一份必然逐渐走偏。
 */

/** Kiro 档位规范显示名 */
export const KIRO_TIER = {
  PRO: 'Kiro Pro',
  PRO_PLUS: 'Kiro Pro+',
  POWER: 'Kiro Power'
} as const

export type KiroTier = (typeof KIRO_TIER)[keyof typeof KIRO_TIER]

/** 档位下拉顺序：按价格升序 */
export const KIRO_TIER_ORDER: KiroTier[] = [KIRO_TIER.PRO, KIRO_TIER.PRO_PLUS, KIRO_TIER.POWER]

/**
 * 写路径档位 → CreateAssignment / UpdateAssignment 的 subscriptionType。
 * 对应内部 API AmazonQDeveloperService（SigV4 service: q）。
 */
export const TIER_TO_ASSIGNMENT_TYPE: Record<KiroTier, string> = {
  [KIRO_TIER.PRO]: 'Q_DEVELOPER_STANDALONE_PRO',
  [KIRO_TIER.PRO_PLUS]: 'Q_DEVELOPER_STANDALONE_PRO_PLUS',
  [KIRO_TIER.POWER]: 'Q_DEVELOPER_STANDALONE_POWER'
}

/**
 * 读路径 subscriptionType → 档位显示名。
 *
 * 注意读写两侧前缀不同：ListUserSubscriptions 返回 KIRO_ENTERPRISE_*，
 * 而 CreateAssignment 收 Q_DEVELOPER_STANDALONE_*，两边靠显示名对接。
 * 这里两套前缀都收，避免 AWS 换用其中一套后读不出档位。
 */
export const SUBSCRIPTION_TYPE_TO_TIER: Record<string, KiroTier> = {
  KIRO_ENTERPRISE_PRO: KIRO_TIER.PRO,
  KIRO_ENTERPRISE_PRO_PLUS: KIRO_TIER.PRO_PLUS,
  KIRO_ENTERPRISE_POWER: KIRO_TIER.POWER,
  Q_DEVELOPER_STANDALONE_PRO: KIRO_TIER.PRO,
  Q_DEVELOPER_STANDALONE_PRO_PLUS: KIRO_TIER.PRO_PLUS,
  Q_DEVELOPER_STANDALONE_POWER: KIRO_TIER.POWER
}

/** 档位月度单价（美元），用于成本预估 */
export const TIER_MONTHLY_PRICE_USD: Record<KiroTier, number> = {
  [KIRO_TIER.PRO]: 20,
  [KIRO_TIER.PRO_PLUS]: 40,
  [KIRO_TIER.POWER]: 200
}

/** 档位月度 credits，用于展示 */
export const TIER_MONTHLY_CREDITS: Record<KiroTier, number> = {
  [KIRO_TIER.PRO]: 1000,
  [KIRO_TIER.PRO_PLUS]: 2000,
  [KIRO_TIER.POWER]: 10000
}

/** 档位别名 → 规范显示名（大小写不敏感，兼容 CSV 与 CLI 习惯写法） */
export const TIER_ALIASES: Record<string, KiroTier> = {
  pro: KIRO_TIER.PRO,
  'pro+': KIRO_TIER.PRO_PLUS,
  proplus: KIRO_TIER.PRO_PLUS,
  pro_plus: KIRO_TIER.PRO_PLUS,
  power: KIRO_TIER.POWER,
  'kiro pro': KIRO_TIER.PRO,
  'kiro pro+': KIRO_TIER.PRO_PLUS,
  'kiro power': KIRO_TIER.POWER
}

/** 席位序号前缀：仅系统内用于对账，不写入 AWS 侧任何字段 */
export const TIER_SEQ_PREFIX: Record<KiroTier, string> = {
  [KIRO_TIER.PRO]: 'pro',
  [KIRO_TIER.PRO_PLUS]: 'proplus',
  [KIRO_TIER.POWER]: 'power'
}

/** 单次生成上限，防止误填大数直接烧钱 */
export const MAX_SEATS_PER_PLAN = 500

/** 默认并发度。内部订阅 API 限流较紧 */
export const DEFAULT_SEAT_CONCURRENCY = 5

// ============ 凭据 ============

/** 凭据来源：手填 AK/SK，或读本机 ~/.aws/credentials 的指定 profile */
export type IdcCredentialSource = 'manual' | 'profile'

export interface IdcCredentialConfig {
  source: IdcCredentialSource
  region: string
  /** source=manual 时必填 */
  accessKeyId?: string
  secretAccessKey?: string
  /** 临时凭据（STS）才有 */
  sessionToken?: string
  /** source=profile 时使用，留空则 default */
  profile?: string
}

/** 常用 region，供下拉预填 */
export const COMMON_AWS_REGIONS = [
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'eu-central-1',
  'ap-northeast-1',
  'ap-southeast-1',
  'ap-southeast-2'
] as const

// ============ 席位计划 ============

/** 一条档位配额需求：某档位要开多少个席位 */
export interface SeatQuotaRequest {
  tier: KiroTier
  count: number
}

/** 生成出来的待创建席位（预览行，尚未落地到 AWS） */
export interface PlannedSeat {
  /** 前端行标识，非 AWS 字段 */
  rowId: string
  /** 系统内序号，如 pro-001，仅用于对账 */
  seq: string
  tier: KiroTier
  email: string
  /** IdC UserName，与 email 一致，避免维护两套标识 */
  username: string
  givenName: string
  familyName: string
  displayName: string
}

// ============ 执行结果 ============

export type SeatStepStatus = 'ok' | 'skipped' | 'failed'

export interface SeatProvisionResult {
  seq: string
  email: string
  username: string
  tier: KiroTier
  /** AWS 侧 UserId，创建成功或命中已存在时有值 */
  userId?: string
  createUser: SeatStepStatus
  resetPassword: SeatStepStatus | 'not-attempted'
  subscribe: SeatStepStatus | 'not-attempted'
  error?: string
}

export interface ProvisionSummary {
  identityStoreId: string
  results: SeatProvisionResult[]
  usersCreated: number
  usersSkipped: number
  usersFailed: number
  emailsSent: number
  emailsFailed: number
  subscribed: number
  subscribeSkipped: number
  subscribeFailed: number
  /** 被中途取消时为 true，未跑到的席位保持 not-attempted */
  aborted: boolean
}

/** 查询到的现有席位 */
export interface ExistingSeat {
  userId: string
  username: string
  email: string
  displayName: string
  tier?: KiroTier
  /** 未落在已知映射表里时保留原始 subscriptionType，便于排查 */
  rawSubscriptionType?: string
  status?: string
  activationDate?: string
}

/** Identity Store 里的用户（未必有 Kiro 订阅） */
export interface IdcUser {
  userId: string
  username: string
  email: string
  displayName: string
}

export interface SeatInventory {
  identityStoreId: string
  instanceArn: string
  seats: ExistingSeat[]
  /** 有订阅但在 Identity Store 里查不到的 userId，通常是脏数据 */
  orphanSubscriptions: string[]
  /** 已建号但没挂任何 Kiro 订阅的用户（不计费） */
  unsubscribedUsers: IdcUser[]
}

// ============ 批量维护 ============

export interface BatchOpTarget {
  userId: string
  username: string
}

export interface BatchOpResult {
  userId: string
  username: string
  status: 'ok' | 'skipped' | 'failed'
  error?: string
}

// ============ 进度事件 ============

export interface SeatProgressEvent {
  kind: 'log' | 'seat-done' | 'phase'
  message?: string
  phase?: string
  /** kind=seat-done 时携带该席位的最终结果 */
  result?: SeatProvisionResult
  /** 已完成数 / 总数，用于进度条 */
  done?: number
  total?: number
}

/** 统一 IPC 返回信封 */
export type IdcIpcResult<T> = { success: true; data: T } | { success: false; error: string }

/** 汇总一批席位的月度成本（美元） */
export function estimateMonthlyCost(quotas: SeatQuotaRequest[]): number {
  return quotas.reduce((sum, q) => sum + TIER_MONTHLY_PRICE_USD[q.tier] * Math.max(0, q.count), 0)
}
