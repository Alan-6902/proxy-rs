/**
 * 商品聚合站点适配器。
 *
 * 三家站点（Kiro Market / Kiro CEO / Kiro Drop）的列表与下单响应形状各不相同，
 * 这里为每家写一对「解析列表」「解析下单结果」，对外只暴露归一化后的 KskHunterOffer
 * 与 HunterKskCredential，让 runner 不用关心站点差异。
 *
 * 站点响应变动时只需改这个文件。解析失败一律抛错，由 runner 记入该链接的 lastError。
 */

import { isValidKiroApiKey, isValidKiroRegion } from '../../shared/kiroApiKey'
import {
  KSK_HUNTER_CHANNEL,
  type HunterKskCredential,
  type KskHunterChannel,
  type KskHunterOffer
} from '../../shared/kskHunter'

/** 站点用短代号标区域时的映射（截图里的 #key-eu / #key-us）。 */
const ZONE_TO_REGION: Record<string, string> = {
  us: 'us-east-1',
  eu: 'eu-central-1',
  ap: 'ap-southeast-1'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const text = readString(value)
  if (!text) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 从任意文本里认区域。
 * 先认完整 AWS 区域（eu-central-1），再退回短代号（#key-eu → eu-central-1）。
 */
export function resolveOfferRegion(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const text = readString(candidate).toLowerCase()
    if (!text) continue
    const fullRegion = text.match(/[a-z]{2}-[a-z]+-\d/)?.[0]
    if (fullRegion && isValidKiroRegion(fullRegion)) return fullRegion
  }
  for (const candidate of candidates) {
    const text = readString(candidate).toLowerCase()
    if (!text) continue
    const zone = text.match(/\b(us|eu|ap)\b/)?.[1] ?? text.match(/key-(us|eu|ap)/)?.[1]
    const mapped = zone ? ZONE_TO_REGION[zone] : undefined
    if (mapped) return mapped
  }
  return ''
}

/** 把「售罄 / 有货 / 3」这类库存表达统一成数字。 */
function resolveStock(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    if (typeof candidate === 'boolean') return candidate ? 1 : 0
    const numeric = typeof candidate === 'number' ? candidate : undefined
    if (numeric !== undefined && Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric))
    const text = readString(candidate)
    if (!text) continue
    if (/售罄|缺货|sold[\s_-]?out|out[\s_-]?of[\s_-]?stock/i.test(text)) return 0
    if (/有货|in[\s_-]?stock|available/i.test(text)) return 1
    const parsed = Number(text)
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed))
  }
  return 0
}

/** 从常见的包装层里取出商品数组：data / data.list / items / goods / products。 */
function readOfferArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) throw new Error('商品列表接口返回的不是 JSON 对象')
  for (const key of ['data', 'list', 'items', 'goods', 'products', 'result']) {
    const value = payload[key]
    if (Array.isArray(value)) return value
    if (isRecord(value)) {
      for (const innerKey of ['list', 'items', 'goods', 'products', 'records']) {
        const inner = value[innerKey]
        if (Array.isArray(inner)) return inner
      }
    }
  }
  throw new Error('商品列表接口未返回可识别的商品数组')
}

/** code 非 0 视为业务失败；没有 code 字段的站点跳过这层校验。 */
function assertBusinessOk(payload: unknown): void {
  if (!isRecord(payload)) return
  const code = payload.code ?? payload.status
  if (code === undefined || code === null) return
  const numericCode = readNumber(code)
  const isOk =
    numericCode === 0 ||
    numericCode === 200 ||
    code === 'ok' ||
    code === 'success' ||
    payload.success === true
  if (!isOk) {
    throw new Error(
      readString(payload.msg || payload.message) || `接口返回 code=${readString(code)}`
    )
  }
}

/** Kiro Market：商品项平铺，库存在 stock，区域藏在 tag（#key-eu）里。 */
function parseKiroMarketOffers(payload: unknown): KskHunterOffer[] {
  return readOfferArray(payload).flatMap((item) => {
    if (!isRecord(item)) return []
    const goodsId = readString(item.id ?? item.goodsId ?? item.sku)
    if (!goodsId) return []
    return [
      {
        goodsId,
        title: readString(item.title ?? item.name),
        region: resolveOfferRegion(item.tag, item.title, item.name, item.slug),
        stock: resolveStock(item.stock, item.inventory, item.stockText),
        price: readNumber(item.price)
      }
    ]
  })
}

/** Kiro CEO：商品项在 data 下，价格用 CRD 计价，库存字段名是 remain。 */
function parseKiroCeoOffers(payload: unknown): KskHunterOffer[] {
  return readOfferArray(payload).flatMap((item) => {
    if (!isRecord(item)) return []
    const goodsId = readString(item.id ?? item.goods_id ?? item.productId)
    if (!goodsId) return []
    return [
      {
        goodsId,
        title: readString(item.title ?? item.goods_name ?? item.name),
        region: resolveOfferRegion(item.zone, item.tag, item.title, item.goods_name),
        stock: resolveStock(item.remain, item.stock, item.quantity),
        price: readNumber(item.price ?? item.credit ?? item.crd)
      }
    ]
  })
}

/** Kiro Drop：区域直接写在 tag 里（#key-eu-central-1），库存字段是 stock_count。 */
function parseKiroDropOffers(payload: unknown): KskHunterOffer[] {
  return readOfferArray(payload).flatMap((item) => {
    if (!isRecord(item)) return []
    const goodsId = readString(item.id ?? item.item_id ?? item.sku)
    if (!goodsId) return []
    return [
      {
        goodsId,
        title: readString(item.title ?? item.name),
        region: resolveOfferRegion(item.tag, item.region, item.title, item.name),
        stock: resolveStock(item.stock_count, item.stock, item.available),
        price: readNumber(item.price)
      }
    ]
  })
}

/** 解析某站点的商品列表响应。 */
export function parseChannelOffers(channel: KskHunterChannel, payload: unknown): KskHunterOffer[] {
  assertBusinessOk(payload)
  switch (channel) {
    case KSK_HUNTER_CHANNEL.KIRO_MARKET:
      return parseKiroMarketOffers(payload)
    case KSK_HUNTER_CHANNEL.KIRO_CEO:
      return parseKiroCeoOffers(payload)
    case KSK_HUNTER_CHANNEL.KIRO_DROP:
      return parseKiroDropOffers(payload)
  }
}

/** 下单请求体：各站点参数名不同，其余字段一致。 */
export function buildOrderRequestBody(
  channel: KskHunterChannel,
  offer: KskHunterOffer
): Record<string, unknown> {
  switch (channel) {
    case KSK_HUNTER_CHANNEL.KIRO_MARKET:
      return { id: offer.goodsId, num: 1 }
    case KSK_HUNTER_CHANNEL.KIRO_CEO:
      return { goods_id: offer.goodsId, count: 1 }
    case KSK_HUNTER_CHANNEL.KIRO_DROP:
      return { item_id: offer.goodsId, quantity: 1 }
  }
}

/**
 * 从下单响应里挖出 ksk。
 *
 * 各站点嵌套深度不同，与其为每家写死路径（改一次接口就崩），
 * 不如递归找第一个形如 ksk_ 的字符串，再就近认区域。
 */
function findCredentialInPayload(payload: unknown, depth = 0): HunterKskCredential | undefined {
  if (depth > 6) return undefined

  if (typeof payload === 'string') {
    // 支持 `ksk_xxx----eu-central-1` 这类卡密文本
    const key = payload.trim().split('----')[0].trim()
    if (!isValidKiroApiKey(key)) return undefined
    return { key, region: resolveOfferRegion(payload) }
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findCredentialInPayload(item, depth + 1)
      if (found) return found
    }
    return undefined
  }

  if (!isRecord(payload)) return undefined

  // 先看本层显式的 key 字段，能就近拿到同层的区域字段
  for (const keyField of ['key', 'ksk', 'apiKey', 'api_key', 'kiroApiKey', 'card', 'secret']) {
    const candidate = readString(payload[keyField]).split('----')[0].trim()
    if (!isValidKiroApiKey(candidate)) continue
    const region = resolveOfferRegion(
      payload.region,
      payload.aws_region,
      payload.zone,
      payload.tag,
      payload.title,
      payload[keyField]
    )
    return { key: candidate, region }
  }

  for (const value of Object.values(payload)) {
    const found = findCredentialInPayload(value, depth + 1)
    if (!found) continue
    // 内层没认出区域时，用外层的区域字段补
    if (found.region) return found
    return {
      key: found.key,
      region: resolveOfferRegion(payload.region, payload.aws_region, payload.zone, payload.tag)
    }
  }
  return undefined
}

/**
 * 解析下单响应，返回抢到的 ksk。
 * fallbackRegion 用于站点不回区域的情况（用下单时那条商品的区域）。
 */
export function parseOrderedCredential(
  payload: unknown,
  fallbackRegion: string
): HunterKskCredential {
  assertBusinessOk(payload)
  const found = findCredentialInPayload(payload)
  if (!found) throw new Error('下单响应里没有找到 ksk_ 开头的密钥')
  const region = found.region || fallbackRegion
  if (!isValidKiroRegion(region)) {
    throw new Error(`下单成功但无法确定区域（key ••••${found.key.slice(-4)}）`)
  }
  return { key: found.key, region }
}
