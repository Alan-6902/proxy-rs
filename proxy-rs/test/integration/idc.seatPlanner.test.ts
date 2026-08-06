// 席位规划器测试：档位配额 → 预览行

import { describe, expect, it } from 'vitest'
import { MAX_SEATS_PER_PLAN, normalizeTier, planSeats } from '../../src/main/idc/seatPlanner'
import { KIRO_TIER } from '../../src/main/idc/types'

describe('planSeats', () => {
  it('generates the requested count per tier with sequential ids', () => {
    const seats = planSeats({
      quotas: [
        { tier: KIRO_TIER.PRO, count: 3 },
        { tier: KIRO_TIER.POWER, count: 2 }
      ],
      domains: 'example.com'
    })

    expect(seats).toHaveLength(5)
    expect(seats.filter((s) => s.tier === KIRO_TIER.PRO).map((s) => s.seq)).toEqual([
      'pro-001',
      'pro-002',
      'pro-003'
    ])
    expect(seats.filter((s) => s.tier === KIRO_TIER.POWER).map((s) => s.seq)).toEqual([
      'power-001',
      'power-002'
    ])
  })

  it('produces unique emails on the configured domain and mirrors them as usernames', () => {
    const seats = planSeats({
      quotas: [{ tier: KIRO_TIER.PRO, count: 60 }],
      domains: 'seats.example.com'
    })

    const emails = seats.map((s) => s.email)
    expect(new Set(emails).size).toBe(60)
    for (const seat of seats) {
      expect(seat.email.endsWith('@seats.example.com')).toBe(true)
      expect(seat.email).toBe(seat.email.toLowerCase())
      // username 与 email 保持一致，避免维护两套标识
      expect(seat.username).toBe(seat.email)
      expect(seat.displayName.length).toBeGreaterThan(0)
      expect(seat.givenName.length).toBeGreaterThan(0)
      expect(seat.familyName.length).toBeGreaterThan(0)
    }
  })

  it('rotates across a multi-domain pool', () => {
    const seats = planSeats({
      quotas: [{ tier: KIRO_TIER.PRO, count: 6 }],
      domains: 'a.example.com, b.example.com  c.example.com'
    })
    const domains = seats.map((s) => s.email.split('@')[1])
    expect(new Set(domains)).toEqual(new Set(['a.example.com', 'b.example.com', 'c.example.com']))
  })

  it('avoids emails already taken', () => {
    // 先生成一批，把它们当作已存在，再生成同样多的一批，两批不得有交集
    const first = planSeats({
      quotas: [{ tier: KIRO_TIER.PRO, count: 30 }],
      domains: 'dup.example.com'
    })
    const taken = first.map((s) => s.email)
    const second = planSeats({
      quotas: [{ tier: KIRO_TIER.PRO, count: 30 }],
      domains: 'dup.example.com',
      takenEmails: taken
    })
    const overlap = second.filter((s) => taken.includes(s.email))
    expect(overlap).toEqual([])
  })

  it('continues sequence numbering from seqStart', () => {
    const seats = planSeats({
      quotas: [{ tier: KIRO_TIER.POWER, count: 2 }],
      domains: 'example.com',
      seqStart: { [KIRO_TIER.POWER]: 101 }
    })
    expect(seats.map((s) => s.seq)).toEqual(['power-101', 'power-102'])
  })

  it('strips @ prefix and normalizes domain case', () => {
    const seats = planSeats({
      quotas: [{ tier: KIRO_TIER.PRO, count: 1 }],
      domains: '@Seats.Example.COM'
    })
    expect(seats[0].email.endsWith('@seats.example.com')).toBe(true)
  })

  it('rejects an empty domain pool', () => {
    expect(() =>
      planSeats({ quotas: [{ tier: KIRO_TIER.PRO, count: 1 }], domains: '   ' })
    ).toThrow(/域名池/)
  })

  it('rejects a plan with no positive quota', () => {
    expect(() =>
      planSeats({ quotas: [{ tier: KIRO_TIER.PRO, count: 0 }], domains: 'example.com' })
    ).toThrow(/档位数量/)
  })

  it('caps the batch size to avoid runaway spend', () => {
    expect(() =>
      planSeats({
        quotas: [{ tier: KIRO_TIER.PRO, count: MAX_SEATS_PER_PLAN + 1 }],
        domains: 'example.com'
      })
    ).toThrow(new RegExp(String(MAX_SEATS_PER_PLAN)))
  })
})

describe('normalizeTier', () => {
  it('accepts canonical names and common aliases', () => {
    expect(normalizeTier('Kiro Pro')).toBe(KIRO_TIER.PRO)
    expect(normalizeTier('kiro pro+')).toBe(KIRO_TIER.PRO_PLUS)
    expect(normalizeTier('POWER')).toBe(KIRO_TIER.POWER)
    expect(normalizeTier('pro_plus')).toBe(KIRO_TIER.PRO_PLUS)
  })

  it('throws instead of silently defaulting on unknown input', () => {
    expect(() => normalizeTier('Kiro Ultra')).toThrow(/无法识别/)
    expect(() => normalizeTier('')).toThrow(/无法识别/)
  })
})
