// 席位管理编排：开通 / 查询 / 改档 / 取消 / 删除
//
// 所有操作幂等：已存在的用户与订阅走 skipped 而非 failed，中断后可重跑。

import {
  AwsApiError,
  createAssignment,
  createUser,
  deleteAssignment,
  deleteUser,
  listAllUsers,
  listInstances,
  listUserSubscriptions,
  sendPasswordResetEmail,
  updateAssignment,
  type SsoInstance
} from './awsClient'
import {
  DEFAULT_SEAT_CONCURRENCY,
  SUBSCRIPTION_TYPE_TO_TIER,
  TIER_TO_ASSIGNMENT_TYPE,
  type BatchOpResult,
  type BatchOpTarget,
  type ExistingSeat,
  type KiroTier,
  type PlannedSeat,
  type ProvisionSummary,
  type ResolvedCredentials,
  type SeatInventory,
  type SeatProgressEvent,
  type SeatProvisionResult
} from './types'

export type { BatchOpResult, BatchOpTarget, ProvisionSummary, SeatInventory, SeatProgressEvent }

/** 并发度上限。内部订阅 API 限流较紧，默认与参考实现一致 */
export const DEFAULT_CONCURRENCY = DEFAULT_SEAT_CONCURRENCY
const MAX_CONCURRENCY = 20

export type ProgressReporter = (event: SeatProgressEvent) => void

/** 有界并发跑任务，保持结果顺序与输入一致 */
async function runPooled<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY, items.length || 1))
  const results = new Array<R>(items.length)
  let cursor = 0

  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}

function errText(err: unknown): string {
  if (err instanceof AwsApiError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

// ============ 开通席位 ============

export interface ProvisionOptions {
  credentials: ResolvedCredentials
  seats: PlannedSeat[]
  /** 是否发送密码设置邮件。链接 1 小时过期 */
  sendPasswordEmail: boolean
  concurrency?: number
  onProgress?: ProgressReporter
  signal?: AbortSignal
}

/**
 * 执行席位开通：建号 →（可选）发密码邮件 → 挂档位。
 *
 * 单个席位的三步串行执行：建号失败就不必发邮件和挂订阅。
 * 席位之间并发，受 concurrency 限制。
 */
export async function provisionSeats(options: ProvisionOptions): Promise<ProvisionSummary> {
  const { credentials, seats, sendPasswordEmail, onProgress, signal } = options
  const report = onProgress ?? ((): void => {})

  report({ kind: 'phase', phase: 'resolve-instance', message: '正在获取 Identity Center 实例…' })
  const instance = await listInstances(credentials)
  report({ kind: 'log', message: `Identity Store: ${instance.identityStoreId}` })

  // 预取现有用户，命中已存在时直接拿 userId，省掉逐个 GetUserId
  report({ kind: 'phase', phase: 'load-existing', message: '正在读取现有用户…' })
  const existingByUsername = new Map<string, string>()
  try {
    for (const u of await listAllUsers(credentials, instance.identityStoreId)) {
      if (u.username) existingByUsername.set(u.username.toLowerCase(), u.userId)
    }
    report({ kind: 'log', message: `现有用户 ${existingByUsername.size} 个` })
  } catch (err) {
    // 读不到不阻塞开通：撞号时会走 ConflictException 分支，只是拿不到 userId
    report({ kind: 'log', message: `读取现有用户失败（不影响开通）：${errText(err)}` })
  }

  report({ kind: 'phase', phase: 'provision', message: `开始开通 ${seats.length} 个席位…` })

  let done = 0
  let aborted = false

  const results = await runPooled(
    seats,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (seat) => {
      const result: SeatProvisionResult = {
        seq: seat.seq,
        email: seat.email,
        username: seat.username,
        tier: seat.tier,
        createUser: 'failed',
        resetPassword: 'not-attempted',
        subscribe: 'not-attempted'
      }

      if (signal?.aborted) {
        aborted = true
        result.createUser = 'skipped'
        result.error = '已取消'
        return result
      }

      // --- step 1: 建号 ---
      try {
        result.userId = await createUser(credentials, instance.identityStoreId, seat)
        result.createUser = 'ok'
      } catch (err) {
        if (err instanceof AwsApiError && err.isConflict) {
          result.createUser = 'skipped'
          const known = existingByUsername.get(seat.username.toLowerCase())
          if (known) {
            result.userId = known
          } else {
            result.error = '用户已存在但未能解析 UserId，请刷新席位列表后重试'
          }
        } else {
          result.error = errText(err)
          done++
          report({ kind: 'seat-done', result, done, total: seats.length })
          return result
        }
      }

      if (!result.userId) {
        done++
        report({ kind: 'seat-done', result, done, total: seats.length })
        return result
      }

      // --- step 2: 密码设置邮件 ---
      if (sendPasswordEmail && !signal?.aborted) {
        try {
          await sendPasswordResetEmail(credentials, result.userId)
          result.resetPassword = 'ok'
        } catch (err) {
          result.resetPassword = 'failed'
          // 发邮件失败不阻断挂订阅：席位仍然有效，事后可重发
          result.error = [result.error, `密码邮件：${errText(err)}`].filter(Boolean).join('; ')
        }
      }

      // --- step 3: 挂档位 ---
      if (!signal?.aborted) {
        try {
          await createAssignment(credentials, result.userId, TIER_TO_ASSIGNMENT_TYPE[seat.tier])
          result.subscribe = 'ok'
        } catch (err) {
          if (err instanceof AwsApiError && err.isConflict) {
            result.subscribe = 'skipped'
          } else {
            result.subscribe = 'failed'
            result.error = [result.error, `订阅：${errText(err)}`].filter(Boolean).join('; ')
          }
        }
      }

      done++
      report({ kind: 'seat-done', result, done, total: seats.length })
      return result
    }
  )

  const summary: ProvisionSummary = {
    identityStoreId: instance.identityStoreId,
    results,
    usersCreated: results.filter((r) => r.createUser === 'ok').length,
    usersSkipped: results.filter((r) => r.createUser === 'skipped').length,
    usersFailed: results.filter((r) => r.createUser === 'failed').length,
    emailsSent: results.filter((r) => r.resetPassword === 'ok').length,
    emailsFailed: results.filter((r) => r.resetPassword === 'failed').length,
    subscribed: results.filter((r) => r.subscribe === 'ok').length,
    subscribeSkipped: results.filter((r) => r.subscribe === 'skipped').length,
    subscribeFailed: results.filter((r) => r.subscribe === 'failed').length,
    aborted: aborted || Boolean(signal?.aborted)
  }

  report({
    kind: 'phase',
    phase: 'done',
    message:
      `完成：建号 ${summary.usersCreated} 新增 / ${summary.usersSkipped} 已存在 / ${summary.usersFailed} 失败，` +
      `订阅 ${summary.subscribed} 成功 / ${summary.subscribeSkipped} 已有 / ${summary.subscribeFailed} 失败`
  })

  return summary
}

// ============ 查询现有席位 ============

/** 拉取现有席位全景：用户 × 订阅 */
export async function fetchSeatInventory(credentials: ResolvedCredentials): Promise<SeatInventory> {
  const instance: SsoInstance = await listInstances(credentials)
  const [users, subscriptions] = await Promise.all([
    listAllUsers(credentials, instance.identityStoreId),
    listUserSubscriptions(credentials, instance.instanceArn)
  ])

  const usersById = new Map(users.map((u) => [u.userId, u]))
  const subscribedIds = new Set<string>()
  const seats: ExistingSeat[] = []
  const orphanSubscriptions: string[] = []

  for (const sub of subscriptions) {
    subscribedIds.add(sub.userId)
    const user = usersById.get(sub.userId)
    if (!user) {
      orphanSubscriptions.push(sub.userId)
      continue
    }
    const tier = SUBSCRIPTION_TYPE_TO_TIER[sub.subscriptionType]
    seats.push({
      userId: user.userId,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      tier,
      rawSubscriptionType: tier ? undefined : sub.subscriptionType,
      status: sub.status,
      activationDate: sub.activationDate
    })
  }

  return {
    identityStoreId: instance.identityStoreId,
    instanceArn: instance.instanceArn,
    seats,
    orphanSubscriptions,
    unsubscribedUsers: users.filter((u) => !subscribedIds.has(u.userId))
  }
}

// ============ 批量维护操作 ============

/** 批量改档位 */
export async function changeTiers(opts: {
  credentials: ResolvedCredentials
  targets: BatchOpTarget[]
  tier: KiroTier
  concurrency?: number
  onProgress?: ProgressReporter
}): Promise<BatchOpResult[]> {
  const subscriptionType = TIER_TO_ASSIGNMENT_TYPE[opts.tier]
  let done = 0
  return runPooled(opts.targets, opts.concurrency ?? DEFAULT_CONCURRENCY, async (target) => {
    const result: BatchOpResult = {
      userId: target.userId,
      username: target.username,
      status: 'failed'
    }
    try {
      await updateAssignment(opts.credentials, target.userId, subscriptionType)
      result.status = 'ok'
    } catch (err) {
      // 没有现存订阅时 UpdateAssignment 会失败，退回 CreateAssignment
      if (err instanceof AwsApiError && err.isNotFound) {
        try {
          await createAssignment(opts.credentials, target.userId, subscriptionType)
          result.status = 'ok'
        } catch (createErr) {
          result.error = errText(createErr)
        }
      } else {
        result.error = errText(err)
      }
    }
    done++
    opts.onProgress?.({
      kind: 'log',
      message: `改档 ${target.username}: ${result.status}`,
      done,
      total: opts.targets.length
    })
    return result
  })
}

/** 批量取消订阅（保留用户，停止计费） */
export async function unsubscribeSeats(opts: {
  credentials: ResolvedCredentials
  targets: BatchOpTarget[]
  concurrency?: number
  onProgress?: ProgressReporter
}): Promise<BatchOpResult[]> {
  let done = 0
  return runPooled(opts.targets, opts.concurrency ?? DEFAULT_CONCURRENCY, async (target) => {
    const result: BatchOpResult = {
      userId: target.userId,
      username: target.username,
      status: 'failed'
    }
    try {
      await deleteAssignment(opts.credentials, target.userId)
      result.status = 'ok'
    } catch (err) {
      if (err instanceof AwsApiError && err.isNotFound) {
        result.status = 'skipped'
      } else {
        result.error = errText(err)
      }
    }
    done++
    opts.onProgress?.({
      kind: 'log',
      message: `取消订阅 ${target.username}: ${result.status}`,
      done,
      total: opts.targets.length
    })
    return result
  })
}

/**
 * 批量删除用户。不可逆。
 * 先取消订阅再删用户：留着订阅直接删用户会产生孤儿订阅记录。
 */
export async function deleteSeats(opts: {
  credentials: ResolvedCredentials
  identityStoreId: string
  targets: BatchOpTarget[]
  concurrency?: number
  onProgress?: ProgressReporter
}): Promise<BatchOpResult[]> {
  let done = 0
  return runPooled(opts.targets, opts.concurrency ?? DEFAULT_CONCURRENCY, async (target) => {
    const result: BatchOpResult = {
      userId: target.userId,
      username: target.username,
      status: 'failed'
    }

    // 尽力取消订阅，失败也继续删用户
    try {
      await deleteAssignment(opts.credentials, target.userId)
    } catch {
      /* 无订阅或取消失败都不阻断删除 */
    }

    try {
      await deleteUser(opts.credentials, opts.identityStoreId, target.userId)
      result.status = 'ok'
    } catch (err) {
      if (err instanceof AwsApiError && err.isNotFound) {
        result.status = 'skipped'
      } else {
        result.error = errText(err)
      }
    }
    done++
    opts.onProgress?.({
      kind: 'log',
      message: `删除 ${target.username}: ${result.status}`,
      done,
      total: opts.targets.length
    })
    return result
  })
}

/** 批量重发密码设置邮件（链接 1 小时过期，过期后需重发） */
export async function resendPasswordEmails(opts: {
  credentials: ResolvedCredentials
  targets: BatchOpTarget[]
  concurrency?: number
  onProgress?: ProgressReporter
}): Promise<BatchOpResult[]> {
  let done = 0
  return runPooled(opts.targets, opts.concurrency ?? DEFAULT_CONCURRENCY, async (target) => {
    const result: BatchOpResult = {
      userId: target.userId,
      username: target.username,
      status: 'failed'
    }
    try {
      await sendPasswordResetEmail(opts.credentials, target.userId)
      result.status = 'ok'
    } catch (err) {
      result.error = errText(err)
    }
    done++
    opts.onProgress?.({
      kind: 'log',
      message: `重发密码邮件 ${target.username}: ${result.status}`,
      done,
      total: opts.targets.length
    })
    return result
  })
}
