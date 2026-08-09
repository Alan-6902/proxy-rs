/**
 * 渠道余额查询。
 *
 * 积分/点数制的渠道是预充值的，光靠「今天花了多少」拦不住余额耗尽。
 * 这里按渠道查一次余额，用于：
 * - 余额不够付这一单时直接跳过，不白跑一轮下单请求
 * - 余额低于阈值时提醒充值
 *
 * 余额有缓存：抢号是 3 秒一轮，每轮都查会把站点打爆，也没必要——
 * 余额只在下单后才会变，缓存过期或下单后主动失效即可。
 */

import {
  KSK_HUNTER_CHANNEL_AUTH_HEADER,
  parseHunterBalance,
  type KskHunterChannel
} from '../../shared/kskHunter'
import type { KskHunterFetch } from './downstreamClient'

/**
 * 余额缓存有效期。
 *
 * 取 60 秒：比轮询间隔（3 秒）长得多，避免高频打站点；又短到足以在
 * 别处消耗积分（比如你自己手动买了）之后较快反映出来。下单后会主动失效，
 * 所以本应用自己的消耗不受这个延迟影响。
 */
export const KSK_HUNTER_BALANCE_TTL_MS = 60_000

export interface HunterBalanceSnapshot {
  amountUnit?: number
  checkedAt: number
  error?: string
}

/** 余额查询的错误详情脱敏：地址里可能带 token。 */
function redactBalanceError(value: string): string {
  return value
    .replace(/([?&](?:token|key|apikey)=)[^&\s]+/gi, '$1••••')
    .replace(/ksk_[A-Za-z0-9_-]+/g, 'ksk_••••')
}

export async function fetchChannelBalance(input: {
  url: string
  timeoutSeconds: number
  fetchImpl: KskHunterFetch
  /** 走请求头鉴权的渠道要带密钥（见 KSK_HUNTER_CHANNEL_REQUIRES_API_KEY）。 */
  apiKey?: string
}): Promise<number> {
  const parsed = new URL(input.url)
  if (parsed.protocol !== 'https:') throw new Error('余额查询地址必须使用 HTTPS')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(3, input.timeoutSeconds) * 1000)
  try {
    const response = await input.fetchImpl(parsed.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(input.apiKey ? { [KSK_HUNTER_CHANNEL_AUTH_HEADER]: input.apiKey } : {})
      },
      signal: controller.signal
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`余额查询失败: HTTP ${response.status}`)
    const balance = parseHunterBalance(text ? (JSON.parse(text) as unknown) : {})
    if (balance === undefined) throw new Error('余额响应里没找到可识别的余额字段')
    if (balance < 0) throw new Error(`余额响应异常（${balance}）`)
    return balance
  } catch (error) {
    throw new Error(redactBalanceError(error instanceof Error ? error.message : String(error)))
  } finally {
    clearTimeout(timer)
  }
}

/** 按渠道缓存余额，避免 3 秒一轮把站点打爆。 */
export class HunterBalanceCache {
  private readonly cache = new Map<KskHunterChannel, HunterBalanceSnapshot>()

  /** 读缓存，不发请求。 */
  peek(channel: KskHunterChannel): HunterBalanceSnapshot | undefined {
    return this.cache.get(channel)
  }

  /** 全部缓存快照，供 UI 展示。 */
  entries(): Array<[KskHunterChannel, HunterBalanceSnapshot]> {
    return [...this.cache.entries()]
  }

  /** 下单后余额已变，主动失效，下次判断会重新查。 */
  invalidate(channel: KskHunterChannel): void {
    this.cache.delete(channel)
  }

  /**
   * 取余额，缓存未过期就用缓存。
   *
   * 查询失败时把错误记进缓存并返回 undefined——调用方据此决定「查不到余额就不拦」，
   * 因为拦了会让站点抖动直接停掉抢号，代价比偶尔白跑一次下单大。
   */
  async resolve(input: {
    channel: KskHunterChannel
    url: string
    timeoutSeconds: number
    fetchImpl: KskHunterFetch
    apiKey?: string
    now?: number
  }): Promise<HunterBalanceSnapshot> {
    const now = input.now ?? Date.now()
    const cached = this.cache.get(input.channel)
    if (cached && now - cached.checkedAt < KSK_HUNTER_BALANCE_TTL_MS) return cached

    try {
      const amountUnit = await fetchChannelBalance({
        url: input.url,
        timeoutSeconds: input.timeoutSeconds,
        fetchImpl: input.fetchImpl,
        apiKey: input.apiKey
      })
      const snapshot: HunterBalanceSnapshot = { amountUnit, checkedAt: now }
      this.cache.set(input.channel, snapshot)
      return snapshot
    } catch (error) {
      const snapshot: HunterBalanceSnapshot = {
        amountUnit: undefined,
        checkedAt: now,
        error: error instanceof Error ? error.message : String(error)
      }
      this.cache.set(input.channel, snapshot)
      return snapshot
    }
  }
}
