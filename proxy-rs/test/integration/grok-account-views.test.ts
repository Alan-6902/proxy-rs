import { describe, expect, it, vi } from 'vitest'
import type { CursorAccount } from '../../src/shared/cursorAccounts'

// grokAccountManager 间接依赖 accountStore → electron；这里只测纯函数（拼卡片列表、按 scope 建索引），
// 用明文桩顶掉 safeStorage 即可导入。
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/proxy-rs-grok-views-test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8')
  }
}))

import {
  buildGrokAccountViews,
  indexCursorAccountsByScope
} from '../../src/main/grokAccounts/grokAccountManager'
import { grokAccountScope } from '../../src/main/grokAccounts/grokLocalState'

function account(overrides: Partial<CursorAccount> = {}): CursorAccount {
  return {
    id: 'cursor_x',
    email: 'a@example.com',
    tags: [],
    accessToken: 'token-a',
    createdAt: 1,
    lastUsed: 1,
    ...overrides
  }
}

/** 造一个结构合法的 JWT（sub 决定 scope），与 grok-accounts.test 同一套写法。 */
function fakeJwt(sub: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub, exp: 9999999999 })}.sig`
}

describe('Cursor 账号库按 Grok scope 建索引', () => {
  it('scope 与 Grok 侧同一套规则（sha256(jwt.sub)）', () => {
    const token = fakeJwt('user_idx')
    const index = indexCursorAccountsByScope([account({ accessToken: token })])
    expect([...index.keys()]).toEqual([grokAccountScope(token)])
  })

  it('没有 access token 的号算不出 scope，直接略过', () => {
    const index = indexCursorAccountsByScope([account({ accessToken: '' as unknown as string })])
    expect(index.size).toBe(0)
  })
})

describe('Grok 账号视图：Grok 里的号 ∪ Cursor 账号库里的号', () => {
  const token = fakeJwt('user_pro')
  const scope = grokAccountScope(token)
  const grokAccount = { scope, email: 'pro@x.com', name: 'Pro' }

  it('Grok 里的号对上 Cursor 库同一 sub 的号，带出套餐与 Bot 周额度', () => {
    const [view] = buildGrokAccountViews([grokAccount], new Map([[scope, 1_700_000_000_000]]), [
      account({
        accessToken: token,
        membershipType: 'pro',
        subscriptionStatus: 'active',
        usageUpdatedAt: 1_700_000_100_000,
        botUsageRaw: {
          hasNonZeroIncludedLimit: true,
          usagePercent: 35,
          grokPlanLabel: 'Grok Bot Plan',
          nextResetTimestampUtc: '2026-09-21T00:00:00Z'
        }
      })
    ])
    expect(view).toMatchObject({ scope, inGrok: true, hasBox: true, boxSavedAt: 1_700_000_000_000 })
    expect(view.cursor).toMatchObject({
      planName: 'Pro',
      planTone: 'pro',
      subscriptionStatus: 'active',
      usageUpdatedAt: 1_700_000_100_000,
      botUsage: { hasLimit: true, usedPercent: 35, planLabel: 'Grok Bot Plan' }
    })
    expect(view.cursor?.botUsage?.nextResetAt).toBe(Date.parse('2026-09-21T00:00:00Z'))
  })

  it('账号库里没拉过 Bot 用量时 botUsage 为 null，但套餐仍能显示', () => {
    const [view] = buildGrokAccountViews([grokAccount], new Map(), [
      account({ accessToken: token, membershipType: 'pro_plus', subscriptionStatus: 'trialing' })
    ])
    expect(view.hasBox).toBe(false)
    expect(view.cursor).toMatchObject({ planName: 'Pro+ Trial', planTone: 'plus', botUsage: null })
  })

  it('直接在 Grok 里登录、账号库没有的号照常列出，只是不带 cursor 字段', () => {
    const [view] = buildGrokAccountViews([grokAccount], new Map(), [])
    expect(view).toMatchObject({ scope, inGrok: true })
    expect(view.cursor).toBeUndefined()
  })

  it('Cursor 库里还没进 Grok 的正常号也列出来，标 inGrok=false 并带套餐；box 台账里有它就算已建 Bot', () => {
    const otherToken = fakeJwt('user_only_in_cursor')
    const otherScope = grokAccountScope(otherToken)
    const views = buildGrokAccountViews([grokAccount], new Map([[otherScope, 1_600_000_000_000]]), [
      account({ accessToken: token, membershipType: 'pro' }),
      account({
        id: 'cursor_only',
        email: 'only@x.com',
        name: 'Only',
        accessToken: otherToken,
        membershipType: 'ultra'
      })
    ])
    expect(views).toHaveLength(2)
    const only = views.find((view) => view.scope === otherScope)
    expect(only).toMatchObject({
      email: 'only@x.com',
      name: 'Only',
      inGrok: false,
      hasBox: true,
      boxSavedAt: 1_600_000_000_000
    })
    expect(only?.cursor).toMatchObject({ planName: 'Ultra', planTone: 'ultra' })
  })

  it('Cursor 库里的封禁号不列（切过去也用不了）；已在 Grok 里的封禁号仍照常列', () => {
    const bannedOnlyToken = fakeJwt('user_banned_only')
    const views = buildGrokAccountViews([grokAccount], new Map(), [
      account({ accessToken: token, membershipType: 'pro', status: 'banned' }),
      account({ id: 'banned_only', accessToken: bannedOnlyToken, status: 'banned' }),
      account({ id: 'reason', accessToken: fakeJwt('user_reason'), statusReason: '账号已被封禁' })
    ])
    expect(views.map((view) => view.scope)).toEqual([scope])
    expect(views[0].inGrok).toBe(true)
  })

  it('Cursor 库里空邮箱的号写成 undefined，交给卡片用名字/scope 兜底', () => {
    const [view] = buildGrokAccountViews([], new Map(), [
      account({ email: '', name: 'Nameless', accessToken: fakeJwt('user_noemail') })
    ])
    expect(view.email).toBeUndefined()
    expect(view.name).toBe('Nameless')
  })

  it('两边都空时返回空列表', () => {
    expect(buildGrokAccountViews([], new Map(), [])).toEqual([])
  })
})
