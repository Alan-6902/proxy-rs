import { Notification } from 'electron'
import type { TraySettings } from './tray'

export enum LocalNoticeKind {
  AccountSuspended = 'account-suspended',
  TokenRefreshFailed = 'token-refresh-failed',
  RegistrationRiskPaused = 'registration-risk-paused',
  RegistrationBatchCompleted = 'registration-batch-completed',
  KskHunterInStock = 'ksk-hunter-in-stock',
  KskHunterOrdered = 'ksk-hunter-ordered',
  KskHunterBudgetExhausted = 'ksk-hunter-budget-exhausted',
  KskHunterLowBalance = 'ksk-hunter-low-balance'
}

type LocalNoticeTarget = 'accounts' | 'register' | 'hunter'
export type LocalNoticeLanguage = 'zh' | 'en'

interface LocalNoticeTemplate {
  title: string
  body: string
  target: LocalNoticeTarget
}

interface LocalNoticeInput {
  accountId?: string
  batchId?: string
  /** 抢号通知的去重键：同一链接 + 商品在冷却期内只提醒一次。 */
  hunterKey?: string
  /** 抢号通知的正文覆盖：正文要带上商品名与区域。 */
  bodyOverride?: string
}

const NOTICE_TEMPLATES: Record<
  LocalNoticeLanguage,
  Record<LocalNoticeKind, LocalNoticeTemplate>
> = {
  zh: {
    [LocalNoticeKind.AccountSuspended]: {
      title: '账号需要处理',
      body: '检测到一个账号已被暂停，请在账号管理中查看。',
      target: 'accounts'
    },
    [LocalNoticeKind.TokenRefreshFailed]: {
      title: '账号刷新失败',
      body: '一个账号的后台凭据刷新失败，请在账号管理中查看。',
      target: 'accounts'
    },
    [LocalNoticeKind.RegistrationRiskPaused]: {
      title: '注册任务已暂停',
      body: '检测到严重风控信号，批量注册已自动暂停。',
      target: 'register'
    },
    [LocalNoticeKind.RegistrationBatchCompleted]: {
      title: '批量注册已完成',
      body: '一批注册任务已结束，请在注册页面查看结果。',
      target: 'register'
    },
    [LocalNoticeKind.KskHunterInStock]: {
      title: 'KSK 开货了',
      body: '监控的链接检测到有货，请尽快下单。',
      target: 'hunter'
    },
    [LocalNoticeKind.KskHunterOrdered]: {
      title: 'KSK 已自动下单',
      body: '已抢到一个 KSK，正在验活并推送下游。',
      target: 'hunter'
    },
    [LocalNoticeKind.KskHunterBudgetExhausted]: {
      title: '抢号预算已用尽',
      body: '当日花费已达上限，已暂停自动下单；开货仍会提醒。',
      target: 'hunter'
    },
    [LocalNoticeKind.KskHunterLowBalance]: {
      title: '抢号余额不足',
      body: '渠道余额已低于设定阈值，请及时充值。',
      target: 'hunter'
    }
  },
  en: {
    [LocalNoticeKind.AccountSuspended]: {
      title: 'Account needs attention',
      body: 'An account was suspended. Review it in Account Manager.',
      target: 'accounts'
    },
    [LocalNoticeKind.TokenRefreshFailed]: {
      title: 'Account refresh failed',
      body: 'A background credential refresh failed. Review it in Account Manager.',
      target: 'accounts'
    },
    [LocalNoticeKind.RegistrationRiskPaused]: {
      title: 'Registration paused',
      body: 'A serious risk signal paused the registration batch.',
      target: 'register'
    },
    [LocalNoticeKind.RegistrationBatchCompleted]: {
      title: 'Registration batch completed',
      body: 'A registration batch finished. Review the results on the registration page.',
      target: 'register'
    },
    [LocalNoticeKind.KskHunterInStock]: {
      title: 'KSK back in stock',
      body: 'A monitored link is in stock. Order it now.',
      target: 'hunter'
    },
    [LocalNoticeKind.KskHunterOrdered]: {
      title: 'KSK ordered automatically',
      body: 'A KSK was purchased and is being verified before delivery.',
      target: 'hunter'
    },
    [LocalNoticeKind.KskHunterBudgetExhausted]: {
      title: 'Hunter budget exhausted',
      body: 'Daily spend limit reached. Auto-ordering paused; alerts continue.',
      target: 'hunter'
    },
    [LocalNoticeKind.KskHunterLowBalance]: {
      title: 'Hunter balance low',
      body: 'A channel balance fell below the configured threshold. Top up soon.',
      target: 'hunter'
    }
  }
}

const ACCOUNT_SUSPENDED_DEDUP_MS = 30 * 60_000
const TOKEN_REFRESH_FAILED_DEDUP_MS = 15 * 60_000
const REGISTRATION_RISK_PAUSED_DEDUP_MS = 10 * 60_000
const REGISTRATION_BATCH_COMPLETED_DEDUP_MS = 24 * 60 * 60_000
/**
 * 抢号是 3 秒一轮，同一批货会被连着发现很多次。
 * 按「链接 + 商品」去重 5 分钟，避免一批货刷出几十条通知；
 * 下单通知每单一条（去重键含 key 尾号），只做极短去重防重复触发。
 */
const KSK_HUNTER_IN_STOCK_DEDUP_MS = 5 * 60_000
const KSK_HUNTER_ORDERED_DEDUP_MS = 30_000
/** 预算用尽提醒一天一次就够；去重键带日期，跨天自然会再提醒一次。 */
const KSK_HUNTER_BUDGET_DEDUP_MS = 6 * 60 * 60_000
/** 余额提醒：别太频繁催充值，但也要在余额继续下滑时还能再提醒。 */
const KSK_HUNTER_LOW_BALANCE_DEDUP_MS = 60 * 60_000
const LAST_SENT_RETENTION_MS = REGISTRATION_BATCH_COMPLETED_DEDUP_MS
const MAX_NOTICES_PER_MINUTE = 5
const NOTICE_RATE_WINDOW_MS = 60_000

export class LocalNotificationService {
  private readonly lastSentAt = new Map<string, number>()
  private readonly recentNoticeTimes: number[] = []

  constructor(
    private readonly getTraySettings: () => TraySettings,
    private readonly getLanguage: () => LocalNoticeLanguage,
    private readonly onClick: (target: LocalNoticeTarget) => void
  ) {}

  notify(kind: LocalNoticeKind, input: LocalNoticeInput = {}): void {
    if (!this.getTraySettings().showNotifications || !Notification.isSupported()) return

    const now = Date.now()
    this.pruneRateWindow(now)
    this.pruneLastSentAt(now)
    if (this.recentNoticeTimes.length >= MAX_NOTICES_PER_MINUTE) return

    const dedupKey = this.getDedupKey(kind, input)
    const dedupMs = this.getDedupInterval(kind)
    const lastSent = this.lastSentAt.get(dedupKey)
    if (lastSent && now - lastSent < dedupMs) return

    try {
      const template = NOTICE_TEMPLATES[this.getLanguage()][kind]
      const notification = new Notification({
        title: template.title,
        body: input.bodyOverride || template.body
      })
      notification.on('click', () => {
        try {
          this.onClick(template.target)
        } catch {
          /* notification clicks must not affect app flow */
        }
      })
      notification.show()
      this.lastSentAt.set(dedupKey, now)
      this.recentNoticeTimes.push(now)
    } catch {
      /* system notification support can change at runtime */
    }
  }

  private getDedupKey(kind: LocalNoticeKind, input: LocalNoticeInput): string {
    if (kind === LocalNoticeKind.RegistrationBatchCompleted) {
      return `${kind}:${input.batchId || 'unknown'}`
    }
    if (kind === LocalNoticeKind.AccountSuspended || kind === LocalNoticeKind.TokenRefreshFailed) {
      return `${kind}:${input.accountId || 'unknown'}`
    }
    if (
      kind === LocalNoticeKind.KskHunterInStock ||
      kind === LocalNoticeKind.KskHunterOrdered ||
      kind === LocalNoticeKind.KskHunterBudgetExhausted ||
      kind === LocalNoticeKind.KskHunterLowBalance
    ) {
      return `${kind}:${input.hunterKey || 'unknown'}`
    }
    return kind
  }

  private getDedupInterval(kind: LocalNoticeKind): number {
    switch (kind) {
      case LocalNoticeKind.AccountSuspended:
        return ACCOUNT_SUSPENDED_DEDUP_MS
      case LocalNoticeKind.TokenRefreshFailed:
        return TOKEN_REFRESH_FAILED_DEDUP_MS
      case LocalNoticeKind.RegistrationRiskPaused:
        return REGISTRATION_RISK_PAUSED_DEDUP_MS
      case LocalNoticeKind.RegistrationBatchCompleted:
        return REGISTRATION_BATCH_COMPLETED_DEDUP_MS
      case LocalNoticeKind.KskHunterInStock:
        return KSK_HUNTER_IN_STOCK_DEDUP_MS
      case LocalNoticeKind.KskHunterOrdered:
        return KSK_HUNTER_ORDERED_DEDUP_MS
      case LocalNoticeKind.KskHunterBudgetExhausted:
        return KSK_HUNTER_BUDGET_DEDUP_MS
      case LocalNoticeKind.KskHunterLowBalance:
        return KSK_HUNTER_LOW_BALANCE_DEDUP_MS
    }
  }

  private pruneRateWindow(now: number): void {
    while (this.recentNoticeTimes[0] && now - this.recentNoticeTimes[0] >= NOTICE_RATE_WINDOW_MS) {
      this.recentNoticeTimes.shift()
    }
  }

  private pruneLastSentAt(now: number): void {
    for (const [key, sentAt] of this.lastSentAt) {
      if (now - sentAt >= LAST_SENT_RETENTION_MS) this.lastSentAt.delete(key)
    }
  }
}
