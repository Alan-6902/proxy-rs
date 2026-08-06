// 自动车同步的纯函数：金额定点、过期判定、门禁、退避、HTTPS 门禁、区域探测顺序

import { describe, expect, it } from 'vitest'
import {
  CONVOY_BACKOFF_SECONDS,
  CONVOY_CREDENTIAL_STATUS,
  CONVOY_REGION_PROBE_ORDER,
  backoffDelayMs,
  checkBaseUrlSecurity,
  evaluateBillingGuard,
  formatCents,
  isCredentialUsable,
  joinConvoyUrl,
  localDateKey,
  maskSecretTail,
  resolveExpiresAt,
  resolveRegionProbeOrder,
  sanitizeConvoyKey,
  toCents
} from '../../src/shared/convoyCredentials'

describe('金额定点换算', () => {
  it('数字与字符串金额都换成整数分', () => {
    expect(toCents(2)).toBe(200)
    expect(toCents(2.5)).toBe(250)
    expect(toCents('97.00')).toBe(9700)
    expect(toCents('0.07')).toBe(7)
    expect(toCents('12')).toBe(1200)
  })

  it('第三位小数四舍五入，不走二进制浮点', () => {
    expect(toCents('2.675')).toBe(268)
    expect(toCents('2.674')).toBe(267)
  })

  it('非法与空值一律按 0 处理，不抛错', () => {
    expect(toCents(undefined)).toBe(0)
    expect(toCents(null)).toBe(0)
    expect(toCents('abc')).toBe(0)
    expect(toCents('')).toBe(0)
    expect(toCents(Number.NaN)).toBe(0)
  })

  it('负金额保留符号', () => {
    expect(toCents('-1.50')).toBe(-150)
  })

  it('累加多笔金额不产生浮点误差', () => {
    const amounts = ['0.10', '0.20', '0.30']
    const total = amounts.reduce((sum, value) => sum + toCents(value), 0)
    expect(total).toBe(60)
    expect(formatCents(total)).toBe('0.60')
  })

  it('展示格式固定两位小数', () => {
    expect(formatCents(9700)).toBe('97.00')
    expect(formatCents(7)).toBe('0.07')
    expect(formatCents(-150)).toBe('-1.50')
  })
})

describe('aliveSecs 时间语义', () => {
  it('按「从拉取时刻起的剩余秒数」推算过期时间', () => {
    expect(resolveExpiresAt(1_000_000, 120)).toBe(1_000_000 + 120_000)
  })

  it('非正数或非法值视为不设过期，不当成绝对时间戳', () => {
    expect(resolveExpiresAt(1_000_000, 0)).toBeUndefined()
    expect(resolveExpiresAt(1_000_000, -5)).toBeUndefined()
    expect(resolveExpiresAt(1_000_000, undefined)).toBeUndefined()
    expect(resolveExpiresAt(1_000_000, 'abc')).toBeUndefined()
  })

  it('过期边界：到点即不可用，未到点可用', () => {
    const base = { status: CONVOY_CREDENTIAL_STATUS.ACTIVE, expiresAt: 2_000 }
    expect(isCredentialUsable(base, 1_999)).toBe(true)
    expect(isCredentialUsable(base, 2_000)).toBe(false)
    expect(isCredentialUsable(base, 2_001)).toBe(false)
  })

  it('无过期时间的 active 条目一直可用；非 active 一律不可用', () => {
    expect(isCredentialUsable({ status: CONVOY_CREDENTIAL_STATUS.ACTIVE }, Date.now())).toBe(true)
    expect(
      isCredentialUsable({ status: CONVOY_CREDENTIAL_STATUS.UNAVAILABLE, expiresAt: undefined }, 0)
    ).toBe(false)
    expect(isCredentialUsable({ status: CONVOY_CREDENTIAL_STATUS.EXPIRED }, 0)).toBe(false)
  })
})

describe('计费门禁', () => {
  const config = {
    allowInitialCharge: true,
    maxNewCredentialsPerPull: 5,
    maxChargePerPullCents: 2000,
    dailyChargeLimitCents: 10000
  }

  it('预估新增为 0 时放行：重复拉取不重复计费', () => {
    const decision = evaluateBillingGuard({
      estimatedNewCount: 0,
      farePerCredentialCents: 500,
      todayChargedCents: 9999,
      hasAcquiredHistory: true,
      config: { ...config, allowInitialCharge: false }
    })
    expect(decision.allowed).toBe(true)
    expect(decision.estimatedChargeCents).toBe(0)
  })

  it('首次启动默认阻止未知费用', () => {
    const decision = evaluateBillingGuard({
      estimatedNewCount: 2,
      farePerCredentialCents: 200,
      todayChargedCents: 0,
      hasAcquiredHistory: false,
      config: { ...config, allowInitialCharge: false }
    })
    expect(decision.allowed).toBe(false)
    expect(decision.estimatedChargeCents).toBe(400)
    expect(decision.reason).toContain('首次拉取')
  })

  it('显式允许首次计费后放行', () => {
    const decision = evaluateBillingGuard({
      estimatedNewCount: 2,
      farePerCredentialCents: 200,
      todayChargedCents: 0,
      hasAcquiredHistory: false,
      config
    })
    expect(decision.allowed).toBe(true)
  })

  it('新增数量超过单次上限时拒绝', () => {
    const decision = evaluateBillingGuard({
      estimatedNewCount: 6,
      farePerCredentialCents: 1,
      todayChargedCents: 0,
      hasAcquiredHistory: true,
      config
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('单次上限 5')
  })

  it('单次金额超过上限时拒绝', () => {
    const decision = evaluateBillingGuard({
      estimatedNewCount: 3,
      farePerCredentialCents: 1000,
      todayChargedCents: 0,
      hasAcquiredHistory: true,
      config
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('20.00')
  })

  it('叠加当日累计后超过每日上限时拒绝', () => {
    const decision = evaluateBillingGuard({
      estimatedNewCount: 2,
      farePerCredentialCents: 500,
      todayChargedCents: 9500,
      hasAcquiredHistory: true,
      config
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('每日上限')
  })

  it('车费未知时按 0 估算，仅受数量上限约束', () => {
    const decision = evaluateBillingGuard({
      estimatedNewCount: 3,
      farePerCredentialCents: undefined,
      todayChargedCents: 0,
      hasAcquiredHistory: true,
      config
    })
    expect(decision.allowed).toBe(true)
    expect(decision.estimatedChargeCents).toBe(0)
  })
})

describe('退避与日期滚动', () => {
  it('按连续失败次数取退避序列，超出后维持最后一档', () => {
    const noJitter = (): number => 0.5 // 0.5 → jitter 系数 0
    expect(backoffDelayMs(1, noJitter)).toBe(CONVOY_BACKOFF_SECONDS[0] * 1000)
    expect(backoffDelayMs(4, noJitter)).toBe(CONVOY_BACKOFF_SECONDS[3] * 1000)
    expect(backoffDelayMs(99, noJitter)).toBe(CONVOY_BACKOFF_SECONDS[3] * 1000)
  })

  it('抖动落在 ±20% 区间内且不低于 1 秒', () => {
    const lowest = backoffDelayMs(1, () => 0)
    const highest = backoffDelayMs(1, () => 1)
    expect(lowest).toBe(4000)
    expect(highest).toBe(6000)
    expect(backoffDelayMs(0, () => 0)).toBeGreaterThanOrEqual(1000)
  })

  it('日期键按本地日历日生成', () => {
    const at = new Date(2026, 7, 6, 23, 59).getTime()
    expect(localDateKey(at)).toBe('2026-08-06')
  })
})

describe('安全门禁', () => {
  it('默认拒绝向 http 发送登录 Key', () => {
    expect(checkBaseUrlSecurity('http://kiro.example.com/api/user', false)).toContain('明文 HTTP')
  })

  it('显式放行后 http 通过', () => {
    expect(checkBaseUrlSecurity('http://kiro.example.com/api/user', true)).toBeNull()
  })

  it('https 无需放行即通过', () => {
    expect(checkBaseUrlSecurity('https://kiro.example.com/api/user', false)).toBeNull()
  })

  it('非法 URL 与非 http(s) 协议一律拒绝', () => {
    expect(checkBaseUrlSecurity('not-a-url', true)).toBeTruthy()
    expect(checkBaseUrlSecurity('ftp://kiro.example.com', true)).toBeTruthy()
  })

  it('脱敏只暴露尾 4 位', () => {
    expect(maskSecretTail('convoy-key-abcdefgh')).toBe('***efgh')
    expect(maskSecretTail('ab')).toBe('***')
    expect(maskSecretTail('')).toBe('')
  })

  it('清洗粘贴带入的不可见字符：否则上游会判 Key 无效且极难排查', () => {
    // 零宽空格 / 零宽连字 / BOM / 不换行空格，肉眼都看不出来
    expect(sanitizeConvoyKey('\u200Bconvoy-key-1234\u200D')).toBe('convoy-key-1234')
    expect(sanitizeConvoyKey('\uFEFFconvoy-key-1234')).toBe('convoy-key-1234')
    expect(sanitizeConvoyKey('convoy\u00A0key\u00A01234')).toBe('convoykey1234')
    // 包裹引号与常规空白同样剥掉
    expect(sanitizeConvoyKey('  "convoy-key-1234"  ')).toBe('convoy-key-1234')
    expect(sanitizeConvoyKey("'convoy-key-1234'\n")).toBe('convoy-key-1234')
    // 干净的 Key 不受影响
    expect(sanitizeConvoyKey('convoy-key-1234')).toBe('convoy-key-1234')
    expect(sanitizeConvoyKey('')).toBe('')
  })

  it('URL 拼接容忍两侧多余斜杠', () => {
    expect(joinConvoyUrl('http://h/api/user/', '/me/auto-ride')).toBe(
      'http://h/api/user/me/auto-ride'
    )
    expect(joinConvoyUrl('http://h/api/user', 'me/auto-ride')).toBe(
      'http://h/api/user/me/auto-ride'
    )
  })
})

describe('区域探测顺序', () => {
  it('显式区域只试它，不悄悄换到别的区域', () => {
    expect(resolveRegionProbeOrder('eu-central-1')).toEqual(['eu-central-1'])
    expect(resolveRegionProbeOrder('  US-EAST-1  ')).toEqual(['us-east-1'])
  })

  it('未指定区域时按候选顺序全试', () => {
    expect(resolveRegionProbeOrder(undefined)).toEqual([...CONVOY_REGION_PROBE_ORDER])
    expect(resolveRegionProbeOrder('   ')).toEqual([...CONVOY_REGION_PROBE_ORDER])
  })
})
