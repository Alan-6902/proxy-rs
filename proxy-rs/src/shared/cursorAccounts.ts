/**
 * Cursor 账号管理：主进程与渲染层共用的类型、IPC 通道名与纯解析函数。
 *
 * 数据模型与解析逻辑移植自 cockpit-tools（jlcodes99/cockpit-tools）的 Cursor 模块，
 * 字段改为本仓库惯用的 camelCase；时间戳统一为毫秒。
 */

export const CURSOR_ACCOUNTS_CHANNEL = {
  list: 'cursor-accounts-list',
  remove: 'cursor-accounts-remove',
  importJson: 'cursor-accounts-import-json',
  importLocal: 'cursor-accounts-import-local',
  addToken: 'cursor-accounts-add-token',
  export: 'cursor-accounts-export',
  refresh: 'cursor-accounts-refresh',
  refreshAll: 'cursor-accounts-refresh-all',
  updateTags: 'cursor-accounts-update-tags',
  inject: 'cursor-accounts-inject',
  currentId: 'cursor-accounts-current-id',
  oauthStart: 'cursor-accounts-oauth-start',
  oauthComplete: 'cursor-accounts-oauth-complete',
  oauthCancel: 'cursor-accounts-oauth-cancel',
  storePath: 'cursor-accounts-store-path',
  changed: 'cursor-accounts-changed'
} as const

export interface CursorAccount {
  id: string
  email: string
  /** WorkOS 用户 id（`user_xxx`），账号去重的第一优先身份。 */
  authId?: string
  name?: string
  tags: string[]

  accessToken: string
  refreshToken?: string

  membershipType?: string
  subscriptionStatus?: string
  signUpType?: string

  /** Cursor 客户端 `cursorAuth/*` 那组键的镜像，键名沿用 Cursor 自己的 camelCase。 */
  authRaw?: Record<string, unknown>
  /** `cursor.com/api/usage-summary` 的原始响应。 */
  usageRaw?: Record<string, unknown>
  /** `DashboardService/GetSandUsageStatus` 的原始响应：Grok Bot 的周额度。 */
  botUsageRaw?: Record<string, unknown>
  /** 预付 credit 余额（美分）。undefined 表示还没查过或查失败，0 表示查到了但没有余额。 */
  creditBalanceCents?: number

  status?: string
  statusReason?: string
  quotaQueryLastError?: string
  quotaQueryLastErrorAt?: number
  usageUpdatedAt?: number

  createdAt: number
  lastUsed: number
}

export interface CursorOAuthStartResult {
  loginId: string
  verificationUri: string
  expiresIn: number
  intervalSeconds: number
}

export interface CursorRefreshAllSummary {
  total: number
  success: number
  failed: { id: string; email: string; error: string }[]
}

/** 切号结果。Cursor 正在运行时不能直接改它的数据库，先回 `needsClose` 让用户确认。 */
export type CursorInjectResult =
  | { status: 'done'; email: string; relaunched: boolean }
  | { status: 'needsClose'; email: string }

export interface CursorInjectOptions {
  /** 用户已确认：先退出正在运行的 Cursor 再写入，写完重新拉起。 */
  closeCursor?: boolean
}

export type CursorPlanBadge =
  | 'FREE'
  | 'PRO'
  | 'PRO_PLUS'
  | 'ENTERPRISE'
  | 'FREE_TRIAL'
  | 'ULTRA'
  | 'UNKNOWN'

export const CURSOR_PLAN_BADGES: readonly CursorPlanBadge[] = [
  'FREE',
  'PRO',
  'PRO_PLUS',
  'ENTERPRISE',
  'FREE_TRIAL',
  'ULTRA',
  'UNKNOWN'
]

export type CursorPlanTone = 'ultra' | 'enterprise' | 'team' | 'plus' | 'pro' | 'free' | 'unknown'

function normalizeMembershipType(membershipType?: string | null): string {
  const normalized = (membershipType || '').toLowerCase().trim()
  if (!normalized) return ''
  if (normalized === 'pro_student') return 'pro'
  if (normalized === 'business' || normalized === 'team') return 'enterprise'
  return normalized
}

function readAuthRawString(account: CursorAccount, ...keys: string[]): string | null {
  const raw = account.authRaw
  if (!raw) return null
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function parseBoolLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.toLowerCase().trim()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return null
}

function readAuthRawBool(account: CursorAccount, ...keys: string[]): boolean | null {
  const raw = account.authRaw
  if (!raw) return null
  for (const key of keys) {
    const parsed = parseBoolLike(raw[key])
    if (parsed !== null) return parsed
  }
  return null
}

/**
 * 企业版与团队版在 membershipType 上都是 enterprise，只能靠 stripe profile 里的
 * 团队字段区分。
 */
function isEnterpriseAccount(account: CursorAccount): boolean {
  const explicit = readAuthRawBool(account, 'isEnterprise', 'is_enterprise')
  if (explicit !== null) return explicit

  const teamMembershipType = readAuthRawString(
    account,
    'teamMembershipType',
    'team_membership_type'
  )
  if (teamMembershipType) {
    const normalized = teamMembershipType.toLowerCase()
    if (normalized.includes('enterprise')) return true
    if (normalized.includes('self_serve') || normalized.includes('selfserve')) return false
  }

  const isTeamMember = readAuthRawBool(account, 'isTeamMember', 'is_team_member')
  if (isTeamMember !== null) return !isTeamMember

  return false
}

export function getCursorPlanBadge(account: CursorAccount): CursorPlanBadge {
  const membership = normalizeMembershipType(account.membershipType)
  switch (membership) {
    case 'free':
      return 'FREE'
    case 'pro':
      return 'PRO'
    case 'pro_plus':
      return 'PRO_PLUS'
    case 'enterprise':
      return 'ENTERPRISE'
    case 'free_trial':
      return 'FREE_TRIAL'
    case 'ultra':
      return 'ULTRA'
    default:
      return membership ? (membership.toUpperCase() as CursorPlanBadge) : 'UNKNOWN'
  }
}

export function getCursorPlanDisplayName(account: CursorAccount): string {
  const plan = getCursorPlanBadge(account)
  const isTrialing = (account.subscriptionStatus || '').toLowerCase().trim() === 'trialing'

  switch (plan) {
    case 'ENTERPRISE':
      return isEnterpriseAccount(account) ? 'Enterprise' : 'Team'
    case 'ULTRA':
      return 'Ultra'
    case 'PRO_PLUS':
      return isTrialing ? 'Pro+ Trial' : 'Pro+'
    case 'PRO':
      return isTrialing ? 'Pro Trial' : 'Pro'
    case 'FREE_TRIAL':
      return 'Pro Trial'
    case 'FREE':
      return 'Free'
    default:
      return 'Unknown'
  }
}

export function getCursorPlanTone(account: CursorAccount): CursorPlanTone {
  switch (normalizeMembershipType(account.membershipType)) {
    case 'ultra':
      return 'ultra'
    case 'enterprise':
      return isEnterpriseAccount(account) ? 'enterprise' : 'team'
    case 'pro_plus':
      return 'plus'
    case 'pro':
    case 'free_trial':
      return 'pro'
    case 'free':
      return 'free'
    default:
      return 'unknown'
  }
}

export function getCursorAccountDisplayEmail(account: CursorAccount): string {
  const email = account.email?.trim()
  if (email) return email
  const name = account.name?.trim()
  if (name) return name
  return account.id
}

export interface CursorUsage {
  /** 套餐额度已用百分比（0–100），未取到用量时为 null。 */
  planUsedPercent: number | null
  allowanceResetAt: number | null
  planUsedCents: number | null
  planLimitCents: number | null
  /** 套餐内已用（breakdown.included），缺 breakdown 时回落到 used。 */
  includedSpendCents: number | null
  /** 官方赠送的超额免费用量（breakdown.bonus），Ultra 用满套餐后会继续涨。 */
  bonusSpendCents: number | null
  /** 本周期总消耗（breakdown.total）。 */
  totalSpendCents: number | null
  totalPercentUsed: number | null
  autoPercentUsed: number | null
  apiPercentUsed: number | null
  onDemandUsedCents: number | null
  onDemandLimitCents: number | null
  teamOnDemandUsedCents: number | null
  teamOnDemandLimitCents: number | null
  onDemandEnabled: boolean | null
  onDemandLimitType: string | null
  isUnlimited: boolean
}

export interface CursorOnDemandSummary {
  isTeamLimit: boolean
  usedCents: number
  limitCents: number | null
  hasFixedLimit: boolean
  isUnlimited: boolean
  isDisabled: boolean
}

const EMPTY_USAGE: CursorUsage = {
  planUsedPercent: null,
  allowanceResetAt: null,
  planUsedCents: null,
  planLimitCents: null,
  includedSpendCents: null,
  bonusSpendCents: null,
  totalSpendCents: null,
  totalPercentUsed: null,
  autoPercentUsed: null,
  apiPercentUsed: null,
  onDemandUsedCents: null,
  onDemandLimitCents: null,
  teamOnDemandUsedCents: null,
  teamOnDemandLimitCents: null,
  onDemandEnabled: null,
  onDemandLimitType: null,
  isUnlimited: false
}

function getPath(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** 接口可能返回 camelCase 或 snake_case，多个候选键取第一个能解析成有限数字的。 */
function pickNumber(obj: unknown, ...candidateKeys: string[]): number | null {
  if (obj == null || typeof obj !== 'object') return null
  const record = obj as Record<string, unknown>
  for (const key of candidateKeys) {
    const value = record[key]
    if (value !== undefined && value !== null) {
      const n = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

function pickBoolean(obj: unknown, ...candidateKeys: string[]): boolean | null {
  if (obj == null || typeof obj !== 'object') return null
  const record = obj as Record<string, unknown>
  for (const key of candidateKeys) {
    const parsed = parseBoolLike(record[key])
    if (parsed !== null) return parsed
  }
  return null
}

export function getCursorUsage(account: CursorAccount): CursorUsage {
  const raw = account.usageRaw
  if (!raw || typeof raw !== 'object') return EMPTY_USAGE

  const plan =
    getPath(raw, 'individualUsage', 'plan') ??
    getPath(raw, 'individual_usage', 'plan') ??
    getPath(raw, 'planUsage') ??
    getPath(raw, 'plan_usage')
  const individualOnDemand =
    getPath(raw, 'individualUsage', 'onDemand') ?? getPath(raw, 'individual_usage', 'onDemand')
  const teamOnDemand =
    getPath(raw, 'teamUsage', 'onDemand') ?? getPath(raw, 'team_usage', 'onDemand')
  const spendLimitUsage = getPath(raw, 'spendLimitUsage') ?? getPath(raw, 'spend_limit_usage')
  const onDemand = individualOnDemand ?? spendLimitUsage

  const totalPct = pickNumber(plan, 'totalPercentUsed', 'total_percent_used')
  const autoPct = pickNumber(plan, 'autoPercentUsed', 'auto_percent_used')
  const apiPct = pickNumber(plan, 'apiPercentUsed', 'api_percent_used')
  const planUsed = pickNumber(plan, 'used', 'totalSpend', 'total_spend')
  const planLimit = pickNumber(plan, 'limit')
  const breakdown = getPath(plan, 'breakdown')
  const includedSpend = pickNumber(breakdown, 'included') ?? planUsed
  const bonusSpend = pickNumber(breakdown, 'bonus')
  const totalSpend = pickNumber(breakdown, 'total')
  const odUsed = pickNumber(
    onDemand,
    'used',
    'totalSpend',
    'total_spend',
    'individualUsed',
    'individual_used'
  )
  const odLimit = pickNumber(
    onDemand,
    'limit',
    'individualLimit',
    'individual_limit',
    'pooledLimit',
    'pooled_limit'
  )
  const teamOdUsed =
    pickNumber(teamOnDemand, 'used') ??
    pickNumber(spendLimitUsage, 'pooledUsed', 'pooled_used', 'overallUsed', 'overall_used')
  const teamOdLimit =
    pickNumber(teamOnDemand, 'limit') ??
    pickNumber(spendLimitUsage, 'pooledLimit', 'pooled_limit', 'overallLimit', 'overall_limit')
  const odEnabled = pickBoolean(individualOnDemand, 'enabled')
  const isUnlimited = raw.isUnlimited === true || raw.is_unlimited === true
  const limitTypeRaw =
    raw.limitType ??
    raw.limit_type ??
    (spendLimitUsage && typeof spendLimitUsage === 'object'
      ? ((spendLimitUsage as Record<string, unknown>).limitType ??
        (spendLimitUsage as Record<string, unknown>).limit_type)
      : undefined)
  const onDemandLimitType =
    typeof limitTypeRaw === 'string' && limitTypeRaw.trim()
      ? limitTypeRaw.trim().toLowerCase()
      : null

  const billingEndRaw = raw.billingCycleEnd ?? raw.billing_cycle_end
  let resetAt: number | null = null
  if (typeof billingEndRaw === 'string' && billingEndRaw) {
    const ts = new Date(billingEndRaw).getTime()
    if (Number.isFinite(ts)) resetAt = ts
  }

  const ratioPct =
    planUsed != null && planLimit != null && planLimit > 0 ? (planUsed / planLimit) * 100 : null
  const totalBase = totalPct ?? ratioPct
  // 用了但不足 1% 时显示 1%，避免进度条看起来像没动
  const planUsedPercent =
    totalBase == null
      ? null
      : totalBase > 0 && totalBase < 1
        ? 1
        : Math.min(100, Math.max(0, totalBase))

  return {
    planUsedPercent,
    allowanceResetAt: resetAt,
    planUsedCents: planUsed,
    planLimitCents: planLimit,
    includedSpendCents: includedSpend,
    bonusSpendCents: bonusSpend,
    totalSpendCents: totalSpend,
    totalPercentUsed: totalPct,
    autoPercentUsed: autoPct,
    apiPercentUsed: apiPct,
    onDemandUsedCents: odUsed,
    onDemandLimitCents: odLimit,
    teamOnDemandUsedCents: teamOdUsed,
    teamOnDemandLimitCents: teamOdLimit,
    onDemandEnabled: odEnabled,
    onDemandLimitType,
    isUnlimited
  }
}

export function getCursorOnDemandSummary(usage: CursorUsage): CursorOnDemandSummary {
  const isTeamLimit = (usage.onDemandLimitType || '').toLowerCase() === 'team'
  // 团队账号只看团队口径；团队字段缺失时才回落到个人字段
  const usedCents = isTeamLimit
    ? (usage.teamOnDemandUsedCents ?? usage.onDemandUsedCents ?? 0)
    : (usage.onDemandUsedCents ?? 0)
  const limitCents = isTeamLimit
    ? (usage.teamOnDemandLimitCents ?? usage.onDemandLimitCents ?? null)
    : (usage.onDemandLimitCents ?? null)
  const hasFixedLimit = limitCents != null && limitCents > 0
  const isUnlimited = !hasFixedLimit && usage.onDemandEnabled === true && !isTeamLimit
  const isDisabled = !hasFixedLimit && !isUnlimited

  return { isTeamLimit, usedCents, limitCents, hasFixedLimit, isUnlimited, isDisabled }
}

export interface CursorBotUsage {
  /** 该账号的套餐是否包含 Bot 额度；false 时界面不展示这一项。 */
  hasLimit: boolean
  /** 本周期已用百分比（0–100）。 */
  usedPercent: number | null
  periodStartAt: number | null
  nextResetAt: number | null
  /** 接口给的套餐名，如 "Grok Bot Plan"。 */
  planLabel: string | null
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const ts = new Date(value).getTime()
  return Number.isFinite(ts) ? ts : null
}

/** Grok Bot 周额度。没拉过返回 null；拉过但套餐不含 Bot 额度时 hasLimit=false。 */
export function getCursorBotUsage(account: CursorAccount): CursorBotUsage | null {
  const raw = account.botUsageRaw
  if (!raw || typeof raw !== 'object') return null
  const hasLimit =
    parseBoolLike(raw.hasNonZeroIncludedLimit ?? raw.has_non_zero_included_limit) === true
  const usedRaw = pickNumber(raw, 'usagePercent', 'usage_percent')
  const usedPercent = usedRaw == null ? null : Math.min(100, Math.max(0, usedRaw))
  const planLabel =
    typeof raw.grokPlanLabel === 'string' && raw.grokPlanLabel.trim()
      ? raw.grokPlanLabel.trim()
      : null
  return {
    hasLimit,
    usedPercent,
    periodStartAt: parseIsoTimestamp(raw.currentPeriodStart ?? raw.current_period_start),
    nextResetAt: parseIsoTimestamp(raw.nextResetTimestampUtc ?? raw.next_reset_timestamp_utc),
    planLabel
  }
}

export function formatCursorUsageDollars(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

export function isCursorAccountBanned(account: CursorAccount): boolean {
  const status = (account.status || '').toLowerCase()
  const reason = (account.statusReason || '').toLowerCase()
  return (
    status === 'banned' ||
    status === 'ban' ||
    status === 'forbidden' ||
    reason.includes('banned') ||
    reason.includes('forbidden') ||
    reason.includes('suspended') ||
    reason.includes('disabled') ||
    reason.includes('封禁') ||
    reason.includes('禁用')
  )
}

export function hasCursorQuotaData(account: CursorAccount): boolean {
  return account.usageRaw != null
}

export function hasCursorQuotaQueryError(account: CursorAccount): boolean {
  return Boolean(account.quotaQueryLastError?.trim())
}
