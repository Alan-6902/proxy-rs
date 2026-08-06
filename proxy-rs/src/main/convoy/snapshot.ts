/**
 * 候选快照构建与原子快照存储（方案第 5、7、8 节）
 *
 * 关键约束：
 *   - 构建过程绝不修改当前快照；全部条目校验通过后才一次性替换
 *   - version 为规范化凭证内容的 SHA-256，同内容得到同版本，便于判断是否需要通知消费者
 *   - 快照只存内存，不落盘（用户已确认「只注入反代账号池，不落盘」）
 */

import { createHash } from 'node:crypto'
import {
  CONVOY_CREDENTIAL_STATUS,
  CONVOY_CREDENTIAL_TYPE,
  CONVOY_VERSION_DISPLAY_LENGTH,
  isCredentialUsable,
  maskSecretTail,
  resolveExpiresAt,
  type ConvoyCredentialSnapshot,
  type ConvoySnapshotView,
  type ManagedConvoyCredential
} from '../../shared/convoyCredentials'
import { isValidKiroApiKey, isValidKiroRegion } from '../../shared/kiroApiKey'
import type { ConvoyCredentialsResponse, RawConvoyCredentialItem } from './client'

/** 上游 credential 对象里可能出现的 API Key 字段名 */
const API_KEY_FIELDS = ['apiKey', 'api_key', 'kiroApiKey', 'key'] as const

/** 上游 credential 对象里可能出现的 accessToken 字段名 */
const ACCESS_TOKEN_FIELDS = ['accessToken', 'access_token', 'token'] as const

/** 上游 credential 对象里可能出现的区域字段名 */
const REGION_FIELDS = ['region', 'awsRegion', 'aws_region', 'ssoRegion'] as const

/** 单条凭证被拒的原因，用于审计统计（不含明文） */
export interface RejectedConvoyCredential {
  credentialId: string
  reason: string
}

export interface SnapshotBuildResult {
  snapshot: ConvoyCredentialSnapshot
  /** 未进入可分配池的条目及原因，供告警与 UI 展示 */
  rejected: RejectedConvoyCredential[]
}

/** 契约违规：整份候选快照都不可信，调用方必须保留旧快照 */
export class SnapshotContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotContractError'
  }
}

function readStringField(
  payload: Record<string, unknown>,
  fields: readonly string[]
): string | undefined {
  for (const field of fields) {
    const value = payload[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * 规范化 JSON：对象键排序后序列化，保证同内容得到同哈希。
 * 上游字段顺序变化不应导致 version 变化，否则每轮都会误报「内容已更新」。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]))
  }
  return value
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

/**
 * 把一条原始记录转成内部条目。
 *
 * 结构违规（credential 不是对象却也不是 null、类型不认识、必填字段缺失）
 * 抛 SnapshotContractError；仅仅是「失效 / 未发放 / 已过期」不算违规，
 * 转成 UNAVAILABLE / EXPIRED 进审计统计但不进可分配池。
 */
function toManagedCredential(
  item: RawConvoyCredentialItem,
  fetchedAt: number
): ManagedConvoyCredential {
  if (!item.credential) {
    return {
      id: item.credentialId,
      status: CONVOY_CREDENTIAL_STATUS.UNAVAILABLE,
      type: '',
      payload: {},
      fetchedAt,
      contentHash: sha256(null)
    }
  }

  const payload = item.credential
  const declaredType = typeof payload.type === 'string' ? payload.type.trim() : ''
  const apiKey = readStringField(payload, API_KEY_FIELDS)
  const accessToken = readStringField(payload, ACCESS_TOKEN_FIELDS)
  // 类型字段可能缺失，按实际字段推断，避免因上游少给 type 就整份拒绝
  const type = declaredType || (apiKey ? CONVOY_CREDENTIAL_TYPE.API_KEY : accessToken ? CONVOY_CREDENTIAL_TYPE.OAUTH : '')

  if (type !== CONVOY_CREDENTIAL_TYPE.API_KEY && type !== CONVOY_CREDENTIAL_TYPE.OAUTH) {
    throw new SnapshotContractError(
      `凭证 ${item.credentialId} 的类型 "${type || '(缺失)'}" 不受支持`
    )
  }
  if (type === CONVOY_CREDENTIAL_TYPE.API_KEY) {
    if (!apiKey) {
      throw new SnapshotContractError(`凭证 ${item.credentialId} 声明为 api_key 但缺少 key 字段`)
    }
    if (!isValidKiroApiKey(apiKey)) {
      throw new SnapshotContractError(`凭证 ${item.credentialId} 的 API Key 格式非法`)
    }
  }
  if (type === CONVOY_CREDENTIAL_TYPE.OAUTH && !accessToken) {
    throw new SnapshotContractError(`凭证 ${item.credentialId} 声明为 oauth 但缺少 accessToken`)
  }

  const rawRegion = readStringField(payload, REGION_FIELDS)?.toLowerCase()
  // 区域非法就当没给，交给上层探测；直接透传非法区域只会让上游 403
  const region = rawRegion && isValidKiroRegion(rawRegion) ? rawRegion : undefined
  const expiresAt = resolveExpiresAt(fetchedAt, item.aliveSecs)
  const isActive = item.status === CONVOY_CREDENTIAL_STATUS.ACTIVE
  const expired = expiresAt !== undefined && expiresAt <= fetchedAt

  return {
    id: item.credentialId,
    status: !isActive
      ? CONVOY_CREDENTIAL_STATUS.UNAVAILABLE
      : expired
        ? CONVOY_CREDENTIAL_STATUS.EXPIRED
        : CONVOY_CREDENTIAL_STATUS.ACTIVE,
    type,
    payload,
    apiKey,
    accessToken,
    region,
    fetchedAt,
    expiresAt,
    contentHash: sha256(payload)
  }
}

/**
 * 构建候选快照。任一条目结构违规即抛错，调用方保留旧快照。
 * 合法的空列表会得到一个空快照——按方案第 10 节，这会清空可分配池。
 */
export function buildSnapshot(
  response: ConvoyCredentialsResponse,
  fetchedAt: number = Date.now()
): SnapshotBuildResult {
  const credentials: ManagedConvoyCredential[] = []
  const rejected: RejectedConvoyCredential[] = []

  for (const item of response.credentials) {
    const managed = toManagedCredential(item, fetchedAt)
    credentials.push(managed)
    if (managed.status === CONVOY_CREDENTIAL_STATUS.UNAVAILABLE) {
      rejected.push({
        credentialId: managed.id,
        reason: item.credential ? `上游状态 ${item.status || '未知'}` : '上游未提供明文'
      })
    } else if (managed.status === CONVOY_CREDENTIAL_STATUS.EXPIRED) {
      rejected.push({ credentialId: managed.id, reason: '已超过 aliveSecs 推算的过期时间' })
    }
  }

  // version 只覆盖凭证内容本身：计费字段每轮都变，掺进来会让 version 永不重复，
  // 「内容未变则不通知消费者」的优化就失效了
  const version = sha256(
    credentials.map((c) => ({ id: c.id, status: c.status, hash: c.contentHash }))
  )

  return {
    snapshot: {
      version,
      fetchedAt,
      autoConvoyId: response.autoConvoyId,
      autoConvoyTitle: response.autoConvoyTitle,
      credentials,
      newlyChargedCount: response.newlyChargedCount,
      totalChargedCents: response.totalChargedCents,
      balanceAfterCents: response.balanceAfterCents,
      insufficientCount: response.insufficientCount
    },
    rejected
  }
}

/** 快照里当前可分配的凭证（active 且未过期） */
export function usableCredentials(
  snapshot: ConvoyCredentialSnapshot | null,
  now: number = Date.now()
): ManagedConvoyCredential[] {
  if (!snapshot) return []
  return snapshot.credentials.filter((credential) => isCredentialUsable(credential, now))
}

/** 构建下发渲染进程的脱敏视图：只保留尾 4 位，明文不出主进程 */
export function toSnapshotView(
  snapshot: ConvoyCredentialSnapshot | null,
  now: number = Date.now()
): ConvoySnapshotView | null {
  if (!snapshot) return null
  return {
    version: snapshot.version,
    versionShort: snapshot.version.slice(0, CONVOY_VERSION_DISPLAY_LENGTH),
    fetchedAt: snapshot.fetchedAt,
    autoConvoyId: snapshot.autoConvoyId,
    autoConvoyTitle: snapshot.autoConvoyTitle,
    activeCount: usableCredentials(snapshot, now).length,
    totalCount: snapshot.credentials.length,
    credentials: snapshot.credentials.map((credential) => ({
      id: credential.id,
      status: credential.status,
      type: credential.type,
      maskedCredential: maskSecretTail(credential.apiKey || credential.accessToken || ''),
      region: credential.region,
      expiresAt: credential.expiresAt
    })),
    newlyChargedCount: snapshot.newlyChargedCount,
    totalChargedCents: snapshot.totalChargedCents,
    balanceAfterCents: snapshot.balanceAfterCents,
    insufficientCount: snapshot.insufficientCount
  }
}

/**
 * 原子快照存储。消费者每次只拿到一个不可变引用，替换是整体的。
 *
 * fetchedAt 单调校验：即使锁失效造成偶发双请求，旧响应也不能覆盖新响应
 * （方案第 11 节最后一条）。
 */
export class ConvoySnapshotStore {
  private current: ConvoyCredentialSnapshot | null = null
  private readonly listeners = new Set<(snapshot: ConvoyCredentialSnapshot | null) => void>()

  /** 只读当前快照引用；调用方不得修改返回对象 */
  get snapshot(): ConvoyCredentialSnapshot | null {
    return this.current
  }

  /**
   * 原子替换。返回 false 表示因候选快照更旧而被拒绝。
   * 版本相同也照样替换（计费字段与 fetchedAt 需要更新），但不触发监听器。
   */
  replaceSnapshot(candidate: ConvoyCredentialSnapshot): boolean {
    if (this.current && candidate.fetchedAt < this.current.fetchedAt) return false
    const versionChanged = this.current?.version !== candidate.version
    this.current = candidate
    if (versionChanged) this.notify()
    return true
  }

  /** 清空快照（登录 Key 失效、用户停用同步时调用） */
  clear(): void {
    if (!this.current) return
    this.current = null
    this.notify()
  }

  /** 订阅版本变化，返回取消订阅函数 */
  onSnapshotUpdated(listener: (snapshot: ConvoyCredentialSnapshot | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.current)
      } catch (err) {
        console.warn('[ConvoySnapshot] listener failed:', err instanceof Error ? err.message : err)
      }
    }
  }
}
