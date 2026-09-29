import { Notification } from 'electron'
import type { TraySettings } from './tray'

export enum LocalNoticeKind {
  AccountSuspended = 'account-suspended',
  TokenRefreshFailed = 'token-refresh-failed'
}

type LocalNoticeTarget = 'accounts'
export type LocalNoticeLanguage = 'zh' | 'en'

interface LocalNoticeTemplate {
  title: string
  body: string
  target: LocalNoticeTarget
}

interface LocalNoticeInput {
  accountId?: string
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
    }
  }
}

const ACCOUNT_SUSPENDED_DEDUP_MS = 30 * 60_000
const TOKEN_REFRESH_FAILED_DEDUP_MS = 15 * 60_000
const LAST_SENT_RETENTION_MS = ACCOUNT_SUSPENDED_DEDUP_MS
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
        body: template.body
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
