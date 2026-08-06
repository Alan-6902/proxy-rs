// 席位计划生成：档位 + 数量 → 待创建席位预览
//
// 邮箱前缀复用注册模块的 randomEmailPrefix()（真人名风格），
// 域名复用注册页已配好的 GPTmail 自建域名池。
// 这里不拉起 GptMailService：IdC 场景不需要收 OTP（密码链接由 AWS 直接发到邮箱，
// 用户自己点），只需要生成地址，避免引入 TLS SessionClient 依赖。

import { randomUUID } from 'node:crypto'
import { randomEmailPrefix, randomFullName } from '../registration/names'
import {
  KIRO_TIER,
  MAX_SEATS_PER_PLAN,
  TIER_ALIASES,
  TIER_SEQ_PREFIX,
  type KiroTier,
  type PlannedSeat,
  type SeatQuotaRequest
} from './types'

export { MAX_SEATS_PER_PLAN }

/** 序号补零位数：pro-001 */
const SEQ_PAD = 3

function parseDomains(raw: string): string[] {
  return (raw || '')
    .split(/[\s,;]+/)
    .map((d) => d.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean)
}

/**
 * IdC UserName 允许 letters/marks/symbols/numbers/punctuation，长度 ≤128。
 * 邮箱地址本身符合，直接用邮箱作 UserName，避免维护两套标识。
 */
function splitFullName(fullName: string): { givenName: string; familyName: string } {
  const parts = fullName.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { givenName: 'User', familyName: 'User' }
  if (parts.length === 1) return { givenName: parts[0], familyName: parts[0] }
  // 中间名（John M. Doe 的 M.）丢掉，IdC 只要 given/family
  return { givenName: parts[0], familyName: parts[parts.length - 1] }
}

export interface PlanSeatsOptions {
  quotas: SeatQuotaRequest[]
  /** 域名池，多个用空格/逗号分隔 */
  domains: string
  /**
   * 已占用的邮箱地址（小写），用于避免与现有席位撞号。
   * 通常传入 listAllUsers() 拿到的 username/email 集合。
   */
  takenEmails?: Iterable<string>
  /**
   * 各档位序号起始值，用于续开时接着上次编号。
   * 例如已有 100 个 pro，传 { 'Kiro Pro': 101 } 则新席位从 pro-101 起。
   */
  seqStart?: Partial<Record<KiroTier, number>>
}

/**
 * 生成待创建席位列表。纯函数，不触碰 AWS。
 *
 * 邮箱唯一性：本批内 + takenEmails 去重。同一 prefix 撞了就重新摇，
 * 连续摇不出来则在前缀后加短随机串保底（randomEmailPrefix 本身有约 10% 概率
 * 产出无后缀的纯净组合，重名概率不可忽略）。
 */
export function planSeats(options: PlanSeatsOptions): PlannedSeat[] {
  const domains = parseDomains(options.domains)
  if (domains.length === 0) {
    throw new Error('未配置邮箱域名池。请在注册页或本页设置里填入已解析到收信服务的自建域名')
  }

  const quotas = options.quotas.filter((q) => q.count > 0)
  if (quotas.length === 0) {
    throw new Error('未指定任何档位数量')
  }

  const total = quotas.reduce((sum, q) => sum + q.count, 0)
  if (total > MAX_SEATS_PER_PLAN) {
    throw new Error(`单次最多生成 ${MAX_SEATS_PER_PLAN} 个席位，当前请求 ${total} 个`)
  }

  const taken = new Set<string>()
  for (const e of options.takenEmails ?? []) {
    if (e) taken.add(e.trim().toLowerCase())
  }

  const seats: PlannedSeat[] = []
  let domainCursor = 0

  for (const quota of quotas) {
    const prefix = TIER_SEQ_PREFIX[quota.tier]
    const start = options.seqStart?.[quota.tier] ?? 1

    for (let i = 0; i < quota.count; i++) {
      // 域名池轮转，避免全压在一个域名上
      const domain = domains[domainCursor % domains.length]
      domainCursor++

      let email = ''
      for (let attempt = 0; attempt < 12; attempt++) {
        const candidate = `${randomEmailPrefix()}@${domain}`.toLowerCase()
        if (!taken.has(candidate)) {
          email = candidate
          break
        }
      }
      if (!email) {
        // 保底：加 6 位随机串，撞号概率可忽略
        email = `${randomEmailPrefix()}.${randomUUID().slice(0, 6)}@${domain}`.toLowerCase()
      }
      taken.add(email)

      const fullName = randomFullName()
      const { givenName, familyName } = splitFullName(fullName)

      seats.push({
        rowId: randomUUID(),
        seq: `${prefix}-${String(start + i).padStart(SEQ_PAD, '0')}`,
        tier: quota.tier,
        email,
        username: email,
        givenName,
        familyName,
        displayName: fullName
      })
    }
  }

  return seats
}

/** 规范化前端传来的档位值，认不出来就抛错而不是静默当 Pro */
/** 规范化前端传来的档位值，认不出来就抛错而不是静默当 Pro */
export function normalizeTier(raw: string): KiroTier {
  const key = (raw || '').trim().toLowerCase()
  const canonical = Object.values(KIRO_TIER).find((t) => t.toLowerCase() === key)
  if (canonical) return canonical
  const aliased = TIER_ALIASES[key]
  if (aliased) return aliased
  throw new Error(`无法识别的 Kiro 档位：${raw}`)
}
