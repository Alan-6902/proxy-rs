import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  getCursorBotUsage,
  getCursorOnDemandSummary,
  getCursorPlanDisplayName,
  getCursorPlanTone,
  getCursorUsage,
  isCursorAccountBanned,
  type CursorAccount
} from '../../src/shared/cursorAccounts'
import {
  accessTokenNeedsRefresh,
  buildSessionCookie,
  extractAuthIdFromAccessToken,
  extractWorkosUserId,
  normalizeCursorSignUpType,
  parseCreditGrantsBalance,
  resolveMembershipFromStripeProfile
} from '../../src/main/cursorAccounts/cursorApi'
import {
  CURSOR_STATE_KEY,
  readLocalCursorAuth,
  writeLocalCursorAuth
} from '../../src/main/cursorAccounts/cursorLocalState'
import { parseCursorSessionCredentials } from '../../src/main/cursorAccounts/cursorOAuth'

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`
}

function account(overrides: Partial<CursorAccount> = {}): CursorAccount {
  return {
    id: 'cursor_test',
    email: 'a@example.com',
    tags: [],
    accessToken: 'token',
    createdAt: 1,
    lastUsed: 1,
    ...overrides
  }
}

describe('Cursor 用量解析', () => {
  it('解析 usage-summary 的 camelCase 结构并折算按需额度', () => {
    const usage = getCursorUsage(
      account({
        usageRaw: {
          billingCycleEnd: '2026-10-01T00:00:00Z',
          individualUsage: {
            plan: {
              totalPercentUsed: 42.4,
              autoPercentUsed: 10,
              apiPercentUsed: 0,
              used: 848,
              limit: 2000
            },
            onDemand: { used: 300, limit: 5000, enabled: true }
          }
        }
      })
    )
    expect(usage.planUsedPercent).toBeCloseTo(42.4)
    expect(usage.planUsedCents).toBe(848)
    expect(usage.planLimitCents).toBe(2000)
    expect(usage.allowanceResetAt).toBe(Date.parse('2026-10-01T00:00:00Z'))
    const onDemand = getCursorOnDemandSummary(usage)
    expect(onDemand).toMatchObject({ usedCents: 300, limitCents: 5000, hasFixedLimit: true })
  })

  it('兼容 snake_case，没有百分比时按 used/limit 折算；不足 1% 显示 1%', () => {
    const usage = getCursorUsage(
      account({ usageRaw: { individual_usage: { plan: { used: 1, limit: 2000 } } } })
    )
    expect(usage.totalPercentUsed).toBeNull()
    expect(usage.planUsedPercent).toBe(1)
  })

  it('团队 limitType 优先取团队按需字段', () => {
    const usage = getCursorUsage(
      account({
        usageRaw: {
          limitType: 'team',
          individualUsage: { plan: { totalPercentUsed: 5 }, onDemand: { used: 10, limit: 100 } },
          teamUsage: { onDemand: { used: 700, limit: 10000 } }
        }
      })
    )
    expect(getCursorOnDemandSummary(usage)).toMatchObject({
      isTeamLimit: true,
      usedCents: 700,
      limitCents: 10000
    })
  })

  it('没拉过用量时全部为空', () => {
    const usage = getCursorUsage(account())
    expect(usage.planUsedPercent).toBeNull()
    expect(getCursorOnDemandSummary(usage).isDisabled).toBe(true)
  })

  it('Ultra 用满套餐后 used 停在 limit，赠送与合计从 breakdown 取；缺 breakdown 时 included 回落到 used', () => {
    const ultra = getCursorUsage(
      account({
        usageRaw: {
          individualUsage: {
            plan: {
              used: 40000,
              limit: 40000,
              breakdown: { included: 40000, bonus: 211004, total: 251004 },
              totalPercentUsed: 71.7
            }
          }
        }
      })
    )
    expect(ultra).toMatchObject({
      includedSpendCents: 40000,
      bonusSpendCents: 211004,
      totalSpendCents: 251004
    })
    const plain = getCursorUsage(
      account({ usageRaw: { individualUsage: { plan: { used: 1234, limit: 2000 } } } })
    )
    expect(plain).toMatchObject({
      includedSpendCents: 1234,
      bonusSpendCents: null,
      totalSpendCents: null
    })
  })
})

describe('Cursor credit 余额解析', () => {
  it('空对象即余额 0；有余额时取美分并四舍五入；负数和垃圾值按 0', () => {
    expect(parseCreditGrantsBalance({})).toBe(0)
    expect(parseCreditGrantsBalance({ creditBalanceCents: 1250 })).toBe(1250)
    expect(parseCreditGrantsBalance({ credit_balance_cents: '99.6' })).toBe(100)
    expect(parseCreditGrantsBalance({ creditBalanceCents: -5 })).toBe(0)
    expect(parseCreditGrantsBalance({ creditBalanceCents: 'abc' })).toBe(0)
  })
})

describe('Cursor Bot 周额度解析', () => {
  it('解析 GetSandUsageStatus 的实际响应', () => {
    const bot = getCursorBotUsage(
      account({
        botUsageRaw: {
          currentPeriodStart: '2026-09-06T22:25:13.832Z',
          nextResetTimestampUtc: '2026-09-13T22:25:13.832Z',
          usagePercent: 22.587294,
          hasAvailableUsage: true,
          hasNonZeroIncludedLimit: true,
          grokPlanLabel: 'Grok Bot Plan'
        }
      })
    )
    expect(bot).toMatchObject({
      hasLimit: true,
      planLabel: 'Grok Bot Plan',
      periodStartAt: Date.parse('2026-09-06T22:25:13.832Z'),
      nextResetAt: Date.parse('2026-09-13T22:25:13.832Z')
    })
    expect(bot?.usedPercent).toBeCloseTo(22.587294)
  })

  it('套餐不含 Bot 额度时 hasLimit=false；没拉过时为 null；兼容 snake_case 与字符串布尔', () => {
    expect(
      getCursorBotUsage(account({ botUsageRaw: { hasNonZeroIncludedLimit: false } }))?.hasLimit
    ).toBe(false)
    expect(getCursorBotUsage(account())).toBeNull()
    const snake = getCursorBotUsage(
      account({
        botUsageRaw: { has_non_zero_included_limit: 'true', usage_percent: '140' }
      })
    )
    expect(snake).toMatchObject({ hasLimit: true, usedPercent: 100, planLabel: null })
  })
})

describe('Cursor 套餐展示', () => {
  it('企业与团队都记作 enterprise，靠 stripe 团队字段区分', () => {
    const team = account({
      membershipType: 'enterprise',
      authRaw: { teamMembershipType: 'self_serve', isTeamMember: true }
    })
    const enterprise = account({ membershipType: 'business', authRaw: { isEnterprise: true } })
    expect(getCursorPlanDisplayName(team)).toBe('Team')
    expect(getCursorPlanTone(team)).toBe('team')
    expect(getCursorPlanDisplayName(enterprise)).toBe('Enterprise')
    expect(getCursorPlanTone(enterprise)).toBe('enterprise')
  })

  it('trialing 状态在 Pro / Pro+ 后加 Trial 后缀', () => {
    expect(
      getCursorPlanDisplayName(account({ membershipType: 'pro', subscriptionStatus: 'trialing' }))
    ).toBe('Pro Trial')
    expect(getCursorPlanDisplayName(account({ membershipType: 'pro_plus' }))).toBe('Pro+')
    expect(getCursorPlanDisplayName(account({ membershipType: 'pro_student' }))).toBe('Pro')
  })

  it('封禁识别同时看 status 与 statusReason', () => {
    expect(isCursorAccountBanned(account({ status: 'banned' }))).toBe(true)
    expect(isCursorAccountBanned(account({ statusReason: '账号已被封禁' }))).toBe(true)
    expect(isCursorAccountBanned(account({ status: 'active' }))).toBe(false)
  })
})

describe('Cursor JWT 工具', () => {
  const future = Math.floor(Date.now() / 1000) + 3600
  const token = fakeJwt({ sub: 'auth0|user_01ABC', exp: future })

  it('从 sub 取 authId 与 WorkOS 用户 id，并拼出用量接口 cookie', () => {
    expect(extractAuthIdFromAccessToken(token)).toBe('auth0|user_01ABC')
    expect(extractWorkosUserId(token)).toBe('user_01ABC')
    expect(buildSessionCookie(token)).toBe(`WorkosCursorSessionToken=user_01ABC%3A%3A${token}`)
  })

  it('sub 不是 user_ 前缀时拼不出 cookie', () => {
    expect(buildSessionCookie(fakeJwt({ sub: 'someone' }))).toBeUndefined()
    expect(extractAuthIdFromAccessToken('not-a-jwt')).toBeUndefined()
  })

  it('临近过期或解析不出 exp 都判定需要刷新', () => {
    expect(accessTokenNeedsRefresh(token)).toBe(false)
    expect(accessTokenNeedsRefresh(fakeJwt({ exp: Math.floor(Date.now() / 1000) + 60 }))).toBe(true)
    expect(accessTokenNeedsRefresh('garbage')).toBe(true)
  })

  it('订阅类型取舍与注册方式命名', () => {
    expect(
      resolveMembershipFromStripeProfile({
        membershipType: 'free',
        individualMembershipType: 'pro'
      })
    ).toBe('pro')
    expect(
      resolveMembershipFromStripeProfile({
        membershipType: 'enterprise',
        individualMembershipType: 'pro'
      })
    ).toBe('enterprise')
    expect(resolveMembershipFromStripeProfile({ individualMembershipType: 'free' })).toBe('free')
    expect(normalizeCursorSignUpType('SIGN_UP_TYPE_GITHUB')).toBe('Github')
    expect(normalizeCursorSignUpType('SIGN_UP_TYPE_GROK')).toBe('Grok')
    expect(normalizeCursorSignUpType('other')).toBe('other')
  })
})

describe('Cursor 会话凭据解析', () => {
  const jwtA = fakeJwt({ sub: 'auth0|user_AAA111', exp: 9999999999 })
  const jwtB = fakeJwt({ sub: 'auth0|user_BBB222', exp: 9999999999 })

  it('识别 cookie 值的三种写法：明文 ::、URL 编码 %3A%3A、带 cookie 名', () => {
    const { credentials, unrecognized } = parseCursorSessionCredentials(
      [
        `user_AAA111::${jwtA}`,
        `user_BBB222%3A%3A${jwtB}`,
        `WorkosCursorSessionToken=user_AAA111%3A%3A${jwtA}; Path=/; Secure`
      ].join('\n')
    )
    expect(unrecognized).toEqual([])
    // 第三行和第一行是同一个 token，去重后只剩两条
    expect(credentials).toEqual([
      { userId: 'user_AAA111', token: jwtA },
      { userId: 'user_BBB222', token: jwtB }
    ])
  })

  it('从整段 Cookie 请求头里挑出会话 token；裸 JWT 从 sub 推 userId', () => {
    const header = `_ga=GA1.1; WorkosCursorSessionToken=user_AAA111%3A%3A${jwtA}; other=1`
    expect(parseCursorSessionCredentials(header).credentials).toEqual([
      { userId: 'user_AAA111', token: jwtA }
    ])
    expect(parseCursorSessionCredentials(jwtB).credentials).toEqual([
      { userId: 'user_BBB222', token: jwtB }
    ])
  })

  it('接受浏览器插件导出的 cookie JSON（数组 / 对象 / cookies 字段）', () => {
    const exported = JSON.stringify([
      { name: 'other', value: 'x' },
      { name: 'WorkosCursorSessionToken', value: `user_AAA111%3A%3A${jwtA}` }
    ])
    expect(parseCursorSessionCredentials(exported).credentials).toEqual([
      { userId: 'user_AAA111', token: jwtA }
    ])
    const wrapped = JSON.stringify({
      cookies: [{ name: 'WorkosCursorSessionToken', value: `user_BBB222::${jwtB}` }]
    })
    expect(parseCursorSessionCredentials(wrapped).credentials).toEqual([
      { userId: 'user_BBB222', token: jwtB }
    ])
  })

  it('认不出的行单独列出，空输入返回空', () => {
    const result = parseCursorSessionCredentials(`hello world\nuser_AAA111::${jwtA}\n\n`)
    expect(result.credentials).toHaveLength(1)
    expect(result.unrecognized).toEqual(['hello world'])
    expect(parseCursorSessionCredentials('   ')).toEqual({ credentials: [], unrecognized: [] })
  })
})

describe('Cursor state.vscdb 读写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-rs-cursor-vscdb-'))
  const dbPath = join(dir, 'state.vscdb')

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('写入账号登录态后能按 Cursor 的键原样读回', () => {
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath)
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    db.close()

    expect(readLocalCursorAuth(dbPath)).toBeNull()

    const token = fakeJwt({ sub: 'auth0|user_XYZ', exp: 9999999999 })
    writeLocalCursorAuth(
      account({
        email: 'switch@example.com',
        accessToken: token,
        refreshToken: 'rt',
        membershipType: 'pro',
        subscriptionStatus: 'active'
      }),
      dbPath
    )

    const payload = readLocalCursorAuth(dbPath)
    expect(payload).toMatchObject({
      email: 'switch@example.com',
      accessToken: token,
      refreshToken: 'rt',
      membershipType: 'pro',
      subscriptionStatus: 'active',
      authId: 'auth0|user_XYZ'
    })
    expect(payload?.authRaw).toMatchObject({ cachedEmail: 'switch@example.com' })

    const verify = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    const legacy = verify
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get(CURSOR_STATE_KEY.legacyEmail) as { value: string }
    verify.close()
    expect(legacy.value).toBe('switch@example.com')
  })

  it('数据库文件不存在时读返回 null、写直接报错', () => {
    const missing = join(dir, 'missing.vscdb')
    expect(readLocalCursorAuth(missing)).toBeNull()
    expect(() => writeLocalCursorAuth(account(), missing)).toThrow('state.vscdb 不存在')
  })
})
