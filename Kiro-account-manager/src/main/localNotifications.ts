import { Notification } from 'electron'
import type { TraySettings } from './tray'

export enum LocalNoticeKind {
  AccountSuspended = 'account-suspended',
  ProxyAllAccountsExhausted = 'proxy-all-accounts-exhausted',
  TokenRefreshFailed = 'token-refresh-failed',
  RegistrationRiskPaused = 'registration-risk-paused',
  RegistrationBatchCompleted = 'registration-batch-completed'
}

type LocalNoticeTarget = 'accounts' | 'proxy' | 'register'
export type LocalNoticeLanguage = 'zh' | 'en'

interface LocalNoticeTemplate {
  title: string
  body: string
  target: LocalNoticeTarget
}

interface LocalNoticeInput {
  accountId?: string
  batchId?: string
}

const NOTICE_TEMPLATES: Record<LocalNoticeLanguage, Record<LocalNoticeKind, LocalNoticeTemplate>> = {
  zh: {
    [LocalNoticeKind.AccountSuspended]: { title: '账号需要处理', body: '检测到一个账号已被暂停，请在账号管理中查看。', target: 'accounts' },
    [LocalNoticeKind.ProxyAllAccountsExhausted]: { title: '反代账号暂不可用', body: '账号池当前没有可用账号，请在反代页面查看。', target: 'proxy' },
    [LocalNoticeKind.TokenRefreshFailed]: { title: '账号刷新失败', body: '一个账号的后台凭据刷新失败，请在账号管理中查看。', target: 'accounts' },
    [LocalNoticeKind.RegistrationRiskPaused]: { title: '注册任务已暂停', body: '检测到严重风控信号，批量注册已自动暂停。', target: 'register' },
    [LocalNoticeKind.RegistrationBatchCompleted]: { title: '批量注册已完成', body: '一批注册任务已结束，请在注册页面查看结果。', target: 'register' }
  },
  en: {
    [LocalNoticeKind.AccountSuspended]: { title: 'Account needs attention', body: 'An account was suspended. Review it in Account Manager.', target: 'accounts' },
    [LocalNoticeKind.ProxyAllAccountsExhausted]: { title: 'Proxy accounts unavailable', body: 'No proxy account is currently available. Review the proxy page.', target: 'proxy' },
    [LocalNoticeKind.TokenRefreshFailed]: { title: 'Account refresh failed', body: 'A background credential refresh failed. Review it in Account Manager.', target: 'accounts' },
    [LocalNoticeKind.RegistrationRiskPaused]: { title: 'Registration paused', body: 'A serious risk signal paused the registration batch.', target: 'register' },
    [LocalNoticeKind.RegistrationBatchCompleted]: { title: 'Registration batch completed', body: 'A registration batch finished. Review the results on the registration page.', target: 'register' }
  }
}

const ACCOUNT_SUSPENDED_DEDUP_MS = 30 * 60_000
const TOKEN_REFRESH_FAILED_DEDUP_MS = 15 * 60_000
const PROXY_ALL_ACCOUNTS_EXHAUSTED_DEDUP_MS = 5 * 60_000
const REGISTRATION_RISK_PAUSED_DEDUP_MS = 10 * 60_000
const REGISTRATION_BATCH_COMPLETED_DEDUP_MS = 24 * 60 * 60_000
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
      const notification = new Notification({ title: template.title, body: template.body })
      notification.on('click', () => {
        try { this.onClick(template.target) } catch { /* notification clicks must not affect app flow */ }
      })
      notification.show()
      this.lastSentAt.set(dedupKey, now)
      this.recentNoticeTimes.push(now)
    } catch { /* system notification support can change at runtime */ }
  }

  private getDedupKey(kind: LocalNoticeKind, input: LocalNoticeInput): string {
    if (kind === LocalNoticeKind.RegistrationBatchCompleted) {
      return `${kind}:${input.batchId || 'unknown'}`
    }
    if (kind === LocalNoticeKind.AccountSuspended || kind === LocalNoticeKind.TokenRefreshFailed) {
      return `${kind}:${input.accountId || 'unknown'}`
    }
    return kind
  }

  private getDedupInterval(kind: LocalNoticeKind): number {
    switch (kind) {
      case LocalNoticeKind.AccountSuspended:
        return ACCOUNT_SUSPENDED_DEDUP_MS
      case LocalNoticeKind.TokenRefreshFailed:
        return TOKEN_REFRESH_FAILED_DEDUP_MS
      case LocalNoticeKind.ProxyAllAccountsExhausted:
        return PROXY_ALL_ACCOUNTS_EXHAUSTED_DEDUP_MS
      case LocalNoticeKind.RegistrationRiskPaused:
        return REGISTRATION_RISK_PAUSED_DEDUP_MS
      case LocalNoticeKind.RegistrationBatchCompleted:
        return REGISTRATION_BATCH_COMPLETED_DEDUP_MS
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
