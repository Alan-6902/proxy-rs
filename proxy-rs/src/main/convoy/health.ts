/**
 * 同步器状态与告警（方案第 14 节）
 *
 * 硬约束：本模块不接收也不输出任何凭证明文。传进来的 message 必须已经脱敏，
 * 调用方只传状态码、数量、金额这类安全信息。
 */

import {
  CONVOY_ALERT_KIND,
  CONVOY_STATE,
  formatCents,
  localDateKey,
  type ConvoyAlert,
  type ConvoyAlertKind,
  type ConvoyState
} from '../../shared/convoyCredentials'
import { redactString } from '../utils/redact'

/** 告警环形缓冲长度：够 UI 看最近情况，又不会无限增长 */
const MAX_ALERTS = 50

/** 计费累计：按本地日历日滚动 */
interface DailyCharge {
  date: string
  cents: number
}

export class ConvoyHealthReporter {
  private state: ConvoyState = CONVOY_STATE.IDLE
  private lastAttemptAt?: number
  private lastSuccessAt?: number
  private consecutiveFailures = 0
  private lastError?: string
  private blockedReason?: string
  private daily: DailyCharge = { date: localDateKey(Date.now()), cents: 0 }
  private totalNewlyChargedCount = 0
  private balanceAfterCents?: number
  private alerts: ConvoyAlert[] = []

  constructor(private readonly log: (message: string) => void = () => {}) {}

  get currentState(): ConvoyState {
    return this.state
  }

  get failures(): number {
    return this.consecutiveFailures
  }

  get todayChargedCents(): number {
    this.rollDailyIfNeeded(Date.now())
    return this.daily.cents
  }

  snapshotStatusFields(): {
    state: ConvoyState
    lastAttemptAt?: number
    lastSuccessAt?: number
    consecutiveFailures: number
    lastError?: string
    blockedReason?: string
    todayChargedCents: number
    todayChargeDate: string
    totalNewlyChargedCount: number
    balanceAfterCents?: number
    alerts: ConvoyAlert[]
  } {
    this.rollDailyIfNeeded(Date.now())
    return {
      state: this.state,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      blockedReason: this.blockedReason,
      todayChargedCents: this.daily.cents,
      todayChargeDate: this.daily.date,
      totalNewlyChargedCount: this.totalNewlyChargedCount,
      balanceAfterCents: this.balanceAfterCents,
      alerts: [...this.alerts]
    }
  }

  markAttempt(at: number = Date.now()): void {
    this.lastAttemptAt = at
  }

  markIdle(): void {
    this.state = CONVOY_STATE.IDLE
    this.blockedReason = undefined
  }

  /** 一轮成功：清零失败计数与阻断原因 */
  markSuccess(info: {
    at?: number
    activeCount: number
    versionShort: string
    newlyChargedCount: number
    totalChargedCents: number
    balanceAfterCents?: number
    insufficientCount: number
    minBalanceAlertCents: number
  }): void {
    const at = info.at ?? Date.now()
    this.state = CONVOY_STATE.HEALTHY
    this.lastSuccessAt = at
    this.consecutiveFailures = 0
    this.lastError = undefined
    this.blockedReason = undefined
    this.recordCharge(at, info.newlyChargedCount, info.totalChargedCents, info.balanceAfterCents)

    this.log(
      `[Convoy] 快照更新 version=${info.versionShort} 有效凭证=${info.activeCount} ` +
        `新计费=${info.newlyChargedCount}个/${formatCents(info.totalChargedCents)} ` +
        `余额=${info.balanceAfterCents === undefined ? '未知' : formatCents(info.balanceAfterCents)} ` +
        `未发放=${info.insufficientCount}`
    )

    if (info.insufficientCount > 0) {
      this.pushAlert(
        CONVOY_ALERT_KIND.INSUFFICIENT,
        `有 ${info.insufficientCount} 个凭证未发放（余额或额度不足）`,
        at
      )
    }
    if (
      info.balanceAfterCents !== undefined &&
      info.balanceAfterCents < info.minBalanceAlertCents
    ) {
      this.pushAlert(
        CONVOY_ALERT_KIND.LOW_BALANCE,
        `余额 ${formatCents(info.balanceAfterCents)} 低于告警阈值 ${formatCents(info.minBalanceAlertCents)}`,
        at
      )
    }
    if (info.activeCount === 0) {
      this.pushAlert(CONVOY_ALERT_KIND.SNAPSHOT_EMPTY, '快照中有效凭证数为 0', at)
    }
  }

  /** 一轮失败：累加失败计数，连续 3 轮触发告警 */
  markFailure(message: string, at: number = Date.now()): void {
    this.state = CONVOY_STATE.DEGRADED
    this.consecutiveFailures++
    this.lastError = redactString(message)
    this.log(`[Convoy] 本轮失败（连续 ${this.consecutiveFailures} 次）: ${this.lastError}`)
    if (this.consecutiveFailures >= 3) {
      this.pushAlert(
        CONVOY_ALERT_KIND.PULL_FAILED,
        `连续 ${this.consecutiveFailures} 轮拉取失败：${this.lastError}`,
        at
      )
    }
  }

  /** 401 / 403：暂停拉取等人工处理 */
  markUnauthorized(message: string, at: number = Date.now()): void {
    this.state = CONVOY_STATE.UNAUTHORIZED
    this.consecutiveFailures++
    this.lastError = redactString(message)
    this.pushAlert(CONVOY_ALERT_KIND.UNAUTHORIZED, this.lastError, at)
  }

  markNotOnBoard(at: number = Date.now()): void {
    const changed = this.state !== CONVOY_STATE.NOT_ON_BOARD
    this.state = CONVOY_STATE.NOT_ON_BOARD
    this.lastError = undefined
    // 未上车是稳定状态，每轮都告警会把缓冲刷满，只在状态变化时报一次
    if (changed) {
      this.pushAlert(CONVOY_ALERT_KIND.NOT_ON_BOARD, '当前不在自动车上，已跳过计费接口', at)
    }
  }

  /** 计费门禁阻断 */
  markBlocked(reason: string, at: number = Date.now()): void {
    const changed = this.blockedReason !== reason
    this.state = CONVOY_STATE.BLOCKED
    this.blockedReason = redactString(reason)
    if (changed) {
      this.pushAlert(CONVOY_ALERT_KIND.BILLING_LIMIT, this.blockedReason, at)
    }
  }

  /** 超过两个轮询周期没有有效快照 */
  markSnapshotStale(intervalSeconds: number, at: number = Date.now()): void {
    this.pushAlert(
      CONVOY_ALERT_KIND.SNAPSHOT_STALE,
      `超过 ${intervalSeconds * 2} 秒没有成功拉取到快照`,
      at
    )
  }

  /** 明文 HTTP 被显式放行：高优先级安全告警（方案第 12 节） */
  markInsecureHttp(baseUrl: string, at: number = Date.now()): void {
    let host = 'unknown'
    try {
      host = new URL(baseUrl).host
    } catch {
      /* URL 非法时门禁已拦下，这里只是兜底 */
    }
    this.pushAlert(
      CONVOY_ALERT_KIND.INSECURE_HTTP,
      `已按显式配置通过明文 HTTP 向 ${host} 发送登录 Key，存在中间人风险`,
      at
    )
  }

  clearAlerts(): void {
    this.alerts = []
  }

  /** 以完整接口返回的权威字段记账（方案 9.3） */
  private recordCharge(
    at: number,
    newlyChargedCount: number,
    totalChargedCents: number,
    balanceAfterCents?: number
  ): void {
    this.rollDailyIfNeeded(at)
    this.daily.cents += Math.max(0, totalChargedCents)
    this.totalNewlyChargedCount += Math.max(0, newlyChargedCount)
    if (balanceAfterCents !== undefined) this.balanceAfterCents = balanceAfterCents
  }

  private rollDailyIfNeeded(at: number): void {
    const key = localDateKey(at)
    if (this.daily.date !== key) this.daily = { date: key, cents: 0 }
  }

  private pushAlert(kind: ConvoyAlertKind, message: string, at: number): void {
    this.alerts.unshift({ at, kind, message })
    if (this.alerts.length > MAX_ALERTS) this.alerts.length = MAX_ALERTS
    this.log(`[Convoy][alert:${kind}] ${message}`)
  }
}
