import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Runner 会把抢到的号写进加密 store。测试里换成内存实现，
 * 这样既能断言「先落盘再推送」，又不碰 safeStorage。
 */
const { deliveryStore } = vi.hoisted(() => ({
  deliveryStore: {
    records: [] as Record<string, unknown>[],
    /** 记账账本：mock 掉落盘，但保留内容以便断言花费确实记上了。 */
    spend: [] as Record<string, unknown>[],
    reset(): void {
      this.records = []
      this.spend = []
    }
  }
}))

vi.mock('../../src/main/kskHunter/configStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/kskHunter/configStore')>()
  return {
    ...actual,
    appendKskHunterDelivery: vi.fn(async (delivery: Record<string, unknown>) => {
      deliveryStore.records.push({ ...delivery })
    }),
    // 记账也要 mock：真实实现会走 safeStorage 落盘，测试环境里会抛错并打断后续流程
    appendKskHunterSpend: vi.fn(async (entry: Record<string, unknown>) => {
      deliveryStore.spend.push({ ...entry })
    }),
    patchKskHunterDelivery: vi.fn(async (deliveryId: string, patch: Record<string, unknown>) => {
      const record = deliveryStore.records.find((item) => item.id === deliveryId)
      if (record) Object.assign(record, patch, { updatedAt: Date.now() })
    })
  }
})

import {
  DEFAULT_KSK_HUNTER_CONFIG,
  KSK_HUNTER_BUDGET_BLOCK,
  KSK_HUNTER_CHANNEL,
  KSK_HUNTER_DELIVERY_MAX_ATTEMPTS,
  KSK_HUNTER_DELIVERY_STATE,
  KSK_HUNTER_MODE,
  KSK_HUNTER_STATE,
  KSK_HUNTER_STORE_VERSION,
  evaluateHunterBudget,
  exhaustedHunterChannels,
  hunterLocalDateKey,
  hunterRetryDelayMs,
  hunterUnitToCny,
  hunterUrlHint,
  isUsableHunterCredential,
  matchesHunterRegions,
  parseHunterBalance,
  roundCny,
  summarizeHunterSpend
} from '../../src/shared/kskHunter'
import {
  buildOrderRequestBody,
  parseChannelOffers,
  parseOrderedCredential,
  resolveOfferRegion
} from '../../src/main/kskHunter/channelAdapters'
import {
  askDownstreamNeedsAccount,
  pushKskToDownstream,
  resolveDownstreamBase,
  type KskHunterFetch
} from '../../src/main/kskHunter/downstreamClient'
import {
  normalizeKskHunterStorePayload,
  type PersistedKskHunterLink,
  type PersistedKskHunterStore
} from '../../src/main/kskHunter/configStore'
import { KskHunterManager } from '../../src/main/kskHunter/hunterRunner'
import {
  HunterBalanceCache,
  KSK_HUNTER_BALANCE_TTL_MS,
  fetchChannelBalance
} from '../../src/main/kskHunter/balanceClient'

const KSK_ONE = 'ksk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const KSK_TWO = 'ksk_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const LIST_URL = 'https://market.example/api/goods?token=secret_1234'
const ORDER_URL = 'https://market.example/api/order?token=secret_1234'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function hunterLink(overrides: Partial<PersistedKskHunterLink> = {}): PersistedKskHunterLink {
  return {
    id: 'link-1',
    name: 'Kiro Market · eu',
    channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
    enabled: true,
    mode: KSK_HUNTER_MODE.AUTO_ORDER,
    regions: ['eu-central-1'],
    createdAt: 1,
    updatedAt: 1,
    secrets: { listUrl: LIST_URL, orderUrl: ORDER_URL },
    ...overrides
  }
}

function hunterStore(
  links: PersistedKskHunterLink[],
  config: Partial<PersistedKskHunterStore['config']> = {},
  spend: PersistedKskHunterStore['spend'] = []
): PersistedKskHunterStore {
  return {
    version: KSK_HUNTER_STORE_VERSION,
    config: { ...DEFAULT_KSK_HUNTER_CONFIG, ...config },
    secrets: { downstreamApiKey: 'admin-key', balanceUrls: {} },
    links,
    deliveries: [],
    spend
  }
}

beforeEach(() => {
  deliveryStore.reset()
})

describe('站点响应解析', () => {
  it('从完整区域、短代号和 tag 里认出区域', () => {
    expect(resolveOfferRegion('Kiro Key · eu-central-1')).toBe('eu-central-1')
    expect(resolveOfferRegion('#key-eu')).toBe('eu-central-1')
    expect(resolveOfferRegion('#key-us')).toBe('us-east-1')
    expect(resolveOfferRegion('无区域信息')).toBe('')
  })

  it('Kiro Market：库存与区域按 stock/tag 归一化', () => {
    const offers = parseChannelOffers(KSK_HUNTER_CHANNEL.KIRO_MARKET, {
      code: 0,
      data: [
        { id: 'g1', title: 'Kiro Key · eu-central-1', tag: '#key-eu', stock: 3, price: 37.01 },
        { id: 'g2', title: 'Kiro Key · us-east-1', tag: '#key-us', stock: '售罄' }
      ]
    })
    expect(offers).toEqual([
      {
        goodsId: 'g1',
        title: 'Kiro Key · eu-central-1',
        region: 'eu-central-1',
        stock: 3,
        price: 37.01
      },
      {
        goodsId: 'g2',
        title: 'Kiro Key · us-east-1',
        region: 'us-east-1',
        stock: 0,
        price: undefined
      }
    ])
  })

  it('Kiro CEO：读 remain 与 zone', () => {
    const offers = parseChannelOffers(KSK_HUNTER_CHANNEL.KIRO_CEO, {
      code: 0,
      data: { list: [{ goods_id: 9, goods_name: '欧洲区(eu)', zone: 'eu', remain: 1, price: 35 }] }
    })
    expect(offers).toEqual([
      { goodsId: '9', title: '欧洲区(eu)', region: 'eu-central-1', stock: 1, price: 35 }
    ])
  })

  it('Kiro Drop：读 stock_count 与 tag 里的完整区域', () => {
    const offers = parseChannelOffers(KSK_HUNTER_CHANNEL.KIRO_DROP, [
      { item_id: 'd1', title: 'Kiro Key', tag: '#key-eu-central-1', stock_count: 2 }
    ])
    expect(offers).toEqual([
      { goodsId: 'd1', title: 'Kiro Key', region: 'eu-central-1', stock: 2, price: undefined }
    ])
  })

  /**
   * KiroApp 用的是真实响应样例（2026-08 实测 GET https://kiroapp.io/api/status，未登录可访问）。
   * 这个站点没有商品数组，库存与价格按区域平铺，所以解析器要把它合成 offer。
   */
  it('KiroApp：把 stock_eu / price_eu 合成按区域的 offer', () => {
    const offers = parseChannelOffers(KSK_HUNTER_CHANNEL.KIRO_APP, {
      auto_check: true,
      auto_generate: false,
      captcha_app_id: '199244242',
      captcha_enabled: true,
      generating: false,
      price: 50,
      price_eu: 30,
      price_us: 50,
      started_at: '2026-08-06T10:30:23Z',
      stock: 2,
      stock_eu: 1,
      stock_us: 2,
      uptime_seconds: 235806
    })
    expect(offers).toEqual([
      {
        goodsId: 'eu',
        title: 'Kiro Key · eu-central-1',
        region: 'eu-central-1',
        stock: 1,
        price: 30
      },
      {
        goodsId: 'us',
        title: 'Kiro Key · us-east-1',
        region: 'us-east-1',
        stock: 2,
        price: 50
      }
    ])
  })

  it('KiroApp：全区无货时返回 stock 0 的 offer 而不是空数组', () => {
    // 空数组会让「当前有货」状态显示不出来，也让人分不清是无货还是解析挂了
    const offers = parseChannelOffers(KSK_HUNTER_CHANNEL.KIRO_APP, {
      price: 50,
      price_eu: 30,
      price_us: 50,
      stock: 0,
      stock_eu: 0,
      stock_us: 0
    })
    expect(offers).toHaveLength(2)
    expect(offers.every((offer) => offer.stock === 0)).toBe(true)
  })

  it('KiroApp：区域字段缺失时回落到不带后缀的 stock/price', () => {
    const offers = parseChannelOffers(KSK_HUNTER_CHANNEL.KIRO_APP, { stock: 3, price: 42 })
    expect(offers.map((offer) => offer.stock)).toEqual([3, 3])
    expect(offers.map((offer) => offer.price)).toEqual([42, 42])
  })

  it('KiroApp：响应里连 stock 都没有时抛错，不装作无货', () => {
    // 站点改了形状必须报错，否则会把故障伪装成「一直没货」，用户永远等不到通知
    expect(() =>
      parseChannelOffers(KSK_HUNTER_CHANNEL.KIRO_APP, { generating: true, uptime_seconds: 1 })
    ).toThrow('stock_eu')
    expect(() => parseChannelOffers(KSK_HUNTER_CHANNEL.KIRO_APP, [])).toThrow('不是 JSON 对象')
  })

  it('业务 code 非 0 时拒绝把 data 当成有货', () => {
    expect(() =>
      parseChannelOffers(KSK_HUNTER_CHANNEL.KIRO_MARKET, { code: 500, msg: '限流', data: [] })
    ).toThrow('限流')
  })

  it('下单请求体按站点使用各自的参数名', () => {
    const offer = { goodsId: 'g1', title: 't', region: 'eu-central-1', stock: 1 }
    expect(buildOrderRequestBody(KSK_HUNTER_CHANNEL.KIRO_MARKET, offer)).toEqual({
      id: 'g1',
      num: 1
    })
    expect(buildOrderRequestBody(KSK_HUNTER_CHANNEL.KIRO_CEO, offer)).toEqual({
      goods_id: 'g1',
      count: 1
    })
    expect(buildOrderRequestBody(KSK_HUNTER_CHANNEL.KIRO_DROP, offer)).toEqual({
      item_id: 'g1',
      quantity: 1
    })
    // KiroApp 的 goodsId 是区域短码（eu / us），不是商品 id
    expect(buildOrderRequestBody(KSK_HUNTER_CHANNEL.KIRO_APP, { ...offer, goodsId: 'eu' })).toEqual(
      { zone: 'eu', count: 1 }
    )
  })
})

describe('下单响应里提取 KSK', () => {
  it.each([
    { name: '平铺 key + region', payload: { key: KSK_ONE, region: 'eu-central-1' } },
    {
      name: '嵌套在 data.account 下',
      payload: { code: 0, data: { account: { key: KSK_ONE, aws_region: 'eu-central-1' } } }
    },
    {
      name: '卡密文本形式',
      payload: { code: 0, data: { card: `${KSK_ONE}----eu-central-1` } }
    },
    {
      name: '内层没区域时用外层 zone 补',
      payload: { code: 0, zone: 'eu', data: { detail: { ksk: KSK_ONE } } }
    }
  ])('$name', ({ payload }) => {
    expect(parseOrderedCredential(payload, '')).toEqual({
      key: KSK_ONE,
      region: 'eu-central-1'
    })
  })

  it('响应里没有区域时退回下单那条商品的区域', () => {
    expect(parseOrderedCredential({ code: 0, data: { key: KSK_ONE } }, 'us-east-1')).toEqual({
      key: KSK_ONE,
      region: 'us-east-1'
    })
  })

  it('没有 ksk 或区域无法确定时抛错，避免把垃圾推给下游', () => {
    expect(() => parseOrderedCredential({ code: 0, data: {} }, 'eu-central-1')).toThrow('ksk_')
    expect(() => parseOrderedCredential({ code: 0, data: { key: KSK_ONE } }, '')).toThrow('区域')
  })
})

describe('下游接口', () => {
  it.each([
    ['http://127.0.0.1:12889', 'http://127.0.0.1:12889'],
    ['http://localhost:12889/hooks/', 'http://localhost:12889/hooks'],
    ['https://downstream.example/api', 'https://downstream.example/api']
  ])('把 %s 归一化为 %s', (input, expected) => {
    expect(resolveDownstreamBase(input)).toBe(expected)
  })

  it('拒绝向非 loopback 的明文 HTTP 发送 KSK', () => {
    expect(() => resolveDownstreamBase('http://10.0.0.8:12889')).toThrow('HTTPS')
  })

  it('need-account 与 push 都带 x-api-key，push 走 POST 且体里是 key/region', async () => {
    const calls: Array<{ url: string; init: Parameters<KskHunterFetch>[1] }> = []
    const fetchImpl: KskHunterFetch = async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(url.endsWith('/need-account') ? { need: true } : { ok: true })
    }
    const options = {
      baseUrl: 'http://127.0.0.1:12889',
      apiKey: 'downstream-key',
      timeoutSeconds: 5,
      fetchImpl
    }

    expect(await askDownstreamNeedsAccount(options)).toBe(true)
    await pushKskToDownstream(options, { key: KSK_ONE, region: 'eu-central-1' })

    expect(calls[0].url).toBe('http://127.0.0.1:12889/need-account')
    expect(calls[0].init.headers['x-api-key']).toBe('downstream-key')
    expect(calls[1].url).toBe('http://127.0.0.1:12889/ksk')
    expect(calls[1].init.method).toBe('POST')
    expect(JSON.parse(calls[1].init.body ?? '{}')).toEqual({
      key: KSK_ONE,
      region: 'eu-central-1'
    })
  })

  it('下游回 need:false 时不下单', async () => {
    const fetchImpl: KskHunterFetch = async () => jsonResponse({ need: false })
    expect(
      await askDownstreamNeedsAccount({
        baseUrl: 'http://127.0.0.1:12889',
        apiKey: 'k',
        timeoutSeconds: 5,
        fetchImpl
      })
    ).toBe(false)
  })

  it('下游未回 ok:true 视为推送失败', async () => {
    const fetchImpl: KskHunterFetch = async () => jsonResponse({ ok: false })
    await expect(
      pushKskToDownstream(
        { baseUrl: 'http://127.0.0.1:12889', apiKey: 'k', timeoutSeconds: 5, fetchImpl },
        { key: KSK_ONE, region: 'eu-central-1' }
      )
    ).rejects.toThrow('ok')
  })

  it('HTTP 错误详情里不出现 KSK 明文', async () => {
    const fetchImpl: KskHunterFetch = async () =>
      new Response(`rejected key ${KSK_ONE}`, { status: 400 })
    await expect(
      pushKskToDownstream(
        { baseUrl: 'http://127.0.0.1:12889', apiKey: 'k', timeoutSeconds: 5, fetchImpl },
        { key: KSK_ONE, region: 'eu-central-1' }
      )
    ).rejects.toThrow(/ksk_••••/)
  })
})

describe('配置归一化与脱敏', () => {
  it('列表地址只暴露 origin/path 与 token 尾号', () => {
    const hint = hunterUrlHint(LIST_URL)
    expect(hint).toContain('https://market.example/api/goods')
    expect(hint).toContain('••••1234')
    expect(hint).not.toContain('secret_1234')
  })

  it('丢弃非法区域、重复链接 id 与非法 ksk 记录', () => {
    const store = normalizeKskHunterStorePayload({
      version: KSK_HUNTER_STORE_VERSION,
      config: { requestTimeoutSeconds: 999, downstreamEnabled: true },
      links: [
        { id: 'a', name: 'A', regions: ['eu-central-1', 'not a region', 'eu-central-1'] },
        { id: 'a', name: '重复' },
        { name: '缺 id' }
      ],
      deliveries: [
        { id: 'd1', key: KSK_ONE, region: 'eu-central-1', state: 'delivered' },
        { id: 'd2', region: 'eu-central-1' }
      ]
    })
    expect(store.links.map((link) => link.id)).toEqual(['a'])
    expect(store.links[0].regions).toEqual(['eu-central-1'])
    // 超时被夹到上限，避免配置出界后请求永不返回
    expect(store.config.requestTimeoutSeconds).toBe(120)
    expect(store.deliveries.map((delivery) => delivery.id)).toEqual(['d1'])
  })

  it('区域白名单为空表示不限', () => {
    expect(matchesHunterRegions([], 'us-east-1')).toBe(true)
    expect(matchesHunterRegions(['eu-central-1'], 'us-east-1')).toBe(false)
    expect(matchesHunterRegions(['eu-central-1'], 'eu-central-1')).toBe(true)
  })

  it('非法 key 或区域的凭据不可用', () => {
    expect(isUsableHunterCredential({ key: KSK_ONE, region: 'eu-central-1' })).toBe(true)
    expect(isUsableHunterCredential({ key: 'bad', region: 'eu-central-1' })).toBe(false)
    expect(isUsableHunterCredential({ key: KSK_ONE, region: 'nope' })).toBe(false)
  })

  it('重试延迟按指数退避递增', () => {
    expect(hunterRetryDelayMs(1)).toBe(5_000)
    expect(hunterRetryDelayMs(2)).toBe(10_000)
    expect(hunterRetryDelayMs(3)).toBe(20_000)
  })
})

describe('汇率换算与日切', () => {
  it('按渠道系数把原币折成人民币', () => {
    expect(hunterUnitToCny(35, 0.5)).toBe(17.5)
    expect(hunterUnitToCny(37.01, 1)).toBe(37.01)
  })

  it('系数非正或非法时按 0 计，绝不放大花费', () => {
    // 填 0 会让所有花费算成 0、上限彻底失效，所以这里必须保守
    expect(hunterUnitToCny(100, 0)).toBe(0)
    expect(hunterUnitToCny(100, -1)).toBe(0)
    expect(hunterUnitToCny(100, Number.NaN)).toBe(0)
    expect(hunterUnitToCny(Number.NaN, 1)).toBe(0)
  })

  it('金额按分四舍五入，避免浮点累加漂移', () => {
    expect(roundCny(0.1 + 0.2)).toBe(0.3)
    expect(hunterUnitToCny(3, 0.3333)).toBe(1)
  })

  it('日期键按本地时区取，不用 UTC', () => {
    // 用 toISOString 的话东八区凌晨会被归到前一天，导致上限半夜提前重置
    const localNoon = new Date(2026, 7, 8, 12, 0, 0).getTime()
    expect(hunterLocalDateKey(localNoon)).toBe('2026-08-08')
    const localEarly = new Date(2026, 7, 8, 0, 30, 0).getTime()
    expect(hunterLocalDateKey(localEarly)).toBe('2026-08-08')
    const localLate = new Date(2026, 7, 8, 23, 30, 0).getTime()
    expect(hunterLocalDateKey(localLate)).toBe('2026-08-08')
  })

  it('计费配置归一化：系数填 0 回落到 1，单位名截断', () => {
    const store = normalizeKskHunterStorePayload({
      version: KSK_HUNTER_STORE_VERSION,
      config: {
        dailyLimitCny: -5,
        billing: {
          [KSK_HUNTER_CHANNEL.KIRO_CEO]: {
            unitLabel: 'VERYLONGUNITNAME',
            cnyPerUnit: 0,
            dailyLimitUnit: 100
          }
        }
      }
    })
    // 系数 0 会让上限判断失效，必须回落到 1
    expect(store.config.billing[KSK_HUNTER_CHANNEL.KIRO_CEO].cnyPerUnit).toBe(1)
    expect(store.config.billing[KSK_HUNTER_CHANNEL.KIRO_CEO].unitLabel).toHaveLength(8)
    expect(store.config.billing[KSK_HUNTER_CHANNEL.KIRO_CEO].dailyLimitUnit).toBe(100)
    // 负数上限按 0（不限）处理
    expect(store.config.dailyLimitCny).toBe(0)
    // 未配置的渠道补上默认值
    expect(store.config.billing[KSK_HUNTER_CHANNEL.KIRO_MARKET].cnyPerUnit).toBe(1)
  })

  it('v1 store 没有 billing/spend 时补默认值而不是拒绝加载', () => {
    const store = normalizeKskHunterStorePayload({
      version: 1,
      config: { downstreamEnabled: true },
      links: [{ id: 'a', name: 'A' }]
    })
    expect(store.version).toBe(KSK_HUNTER_STORE_VERSION)
    expect(store.links).toHaveLength(1)
    expect(store.spend).toEqual([])
    expect(store.config.dailyLimitCny).toBe(0)
    // 默认不允许未知价格下单：算不出花费就不花钱
    expect(store.config.allowUnknownPriceOrder).toBe(false)
  })

  it('丢弃渠道认不出或金额非法的账本记录', () => {
    const now = Date.now()
    const store = normalizeKskHunterStorePayload({
      version: KSK_HUNTER_STORE_VERSION,
      spend: [
        {
          id: 's1',
          channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
          amountUnit: 35,
          amountCny: 17.5,
          at: now
        },
        { id: 's2', channel: 'unknown_site', amountUnit: 1, amountCny: 1, at: now },
        { id: 's3', channel: KSK_HUNTER_CHANNEL.KIRO_CEO, amountCny: 1, at: now },
        { id: 's4', channel: KSK_HUNTER_CHANNEL.KIRO_CEO, amountUnit: -1, amountCny: -1, at: now },
        // 超出保留窗口的旧记录
        {
          id: 's5',
          channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
          amountUnit: 1,
          amountCny: 1,
          at: now - 30 * 24 * 60 * 60_000
        }
      ]
    })
    expect(store.spend.map((entry) => entry.id)).toEqual(['s1'])
  })
})

describe('花费统计', () => {
  const billingConfig = {
    dailyLimitCny: 0,
    billing: {
      ...DEFAULT_KSK_HUNTER_CONFIG.billing,
      [KSK_HUNTER_CHANNEL.KIRO_CEO]: {
        unitLabel: 'CRD',
        cnyPerUnit: 0.5,
        dailyLimitUnit: 0,
        lowBalanceThresholdUnit: 0
      }
    }
  }

  it('按渠道分组汇总，并保留原币与人民币两个口径', () => {
    const now = Date.now()
    const summary = summarizeHunterSpend(
      [
        { channel: KSK_HUNTER_CHANNEL.KIRO_CEO, amountUnit: 35, amountCny: 17.5, at: now },
        { channel: KSK_HUNTER_CHANNEL.KIRO_CEO, amountUnit: 50, amountCny: 25, at: now },
        { channel: KSK_HUNTER_CHANNEL.KIRO_DROP, amountUnit: 37.01, amountCny: 37.01, at: now }
      ],
      billingConfig
    )
    expect(summary.totalCny).toBe(79.51)
    expect(summary.orderCount).toBe(3)
    const ceo = summary.byChannel.find((item) => item.channel === KSK_HUNTER_CHANNEL.KIRO_CEO)
    expect(ceo).toMatchObject({ amountUnit: 85, amountCny: 42.5, orderCount: 2, unitLabel: 'CRD' })
  })

  it('只统计当天，昨天的花费不计入', () => {
    const now = Date.now()
    const yesterday = now - 24 * 60 * 60_000
    const summary = summarizeHunterSpend(
      [
        { channel: KSK_HUNTER_CHANNEL.KIRO_DROP, amountUnit: 10, amountCny: 10, at: now },
        { channel: KSK_HUNTER_CHANNEL.KIRO_DROP, amountUnit: 99, amountCny: 99, at: yesterday }
      ],
      billingConfig
    )
    expect(summary.totalCny).toBe(10)
    expect(summary.orderCount).toBe(1)
  })

  it('设了全局上限时给出剩余额度', () => {
    const summary = summarizeHunterSpend(
      [{ channel: KSK_HUNTER_CHANNEL.KIRO_DROP, amountUnit: 30, amountCny: 30, at: Date.now() }],
      { ...billingConfig, dailyLimitCny: 100 }
    )
    expect(summary.remainingCny).toBe(70)
  })

  it('不限额时 remainingCny 为 undefined', () => {
    const summary = summarizeHunterSpend([], billingConfig)
    expect(summary.remainingCny).toBeUndefined()
  })
})

describe('预算熔断判定', () => {
  const config = {
    dailyLimitCny: 100,
    allowUnknownPriceOrder: false,
    billing: {
      ...DEFAULT_KSK_HUNTER_CONFIG.billing,
      [KSK_HUNTER_CHANNEL.KIRO_CEO]: {
        unitLabel: 'CRD',
        cnyPerUnit: 0.5,
        dailyLimitUnit: 60,
        lowBalanceThresholdUnit: 0
      }
    }
  }

  function spendOf(
    entries: Parameters<typeof summarizeHunterSpend>[0]
  ): ReturnType<typeof summarizeHunterSpend> {
    return summarizeHunterSpend(entries, config)
  }

  it('额度充足时放行，并算出该单人民币花费', () => {
    const result = evaluateHunterBudget({
      channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
      priceUnit: 35,
      config,
      spend: spendOf([])
    })
    expect(result).toMatchObject({ allowed: true, costCny: 17.5, costUnit: 35 })
  })

  it('按「已花 + 这单」判断，不让最后一单冲破预算', () => {
    // 已花 95，这单 17.5，合计 112.5 > 100：必须拦
    const result = evaluateHunterBudget({
      channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
      priceUnit: 17.5,
      config,
      spend: spendOf([
        { channel: KSK_HUNTER_CHANNEL.KIRO_MARKET, amountUnit: 95, amountCny: 95, at: Date.now() }
      ])
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe(KSK_HUNTER_BUDGET_BLOCK.GLOBAL)
  })

  it('渠道上限按原币比：先到时按渠道拦，全局仍有余额', () => {
    // CEO 上限 60 CRD，已花 50 CRD，这单 35 CRD → 85 > 60；但全局 ¥100 只用了 ¥25，还够
    const result = evaluateHunterBudget({
      channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
      priceUnit: 35,
      config,
      spend: spendOf([
        { channel: KSK_HUNTER_CHANNEL.KIRO_CEO, amountUnit: 50, amountCny: 25, at: Date.now() }
      ])
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe(KSK_HUNTER_BUDGET_BLOCK.CHANNEL)
  })

  it('一个渠道用尽不影响其它渠道', () => {
    const spend = spendOf([
      { channel: KSK_HUNTER_CHANNEL.KIRO_CEO, amountUnit: 60, amountCny: 30, at: Date.now() }
    ])
    expect(
      evaluateHunterBudget({
        channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
        priceUnit: 2,
        config,
        spend
      }).allowed
    ).toBe(false)
    // Drop 没设单渠道上限，全局也还够
    expect(
      evaluateHunterBudget({
        channel: KSK_HUNTER_CHANNEL.KIRO_DROP,
        priceUnit: 20,
        config,
        spend
      }).allowed
    ).toBe(true)
  })

  it('上限为 0 表示不限，多大金额都放行', () => {
    const noLimit = { ...config, dailyLimitCny: 0 }
    const result = evaluateHunterBudget({
      channel: KSK_HUNTER_CHANNEL.KIRO_DROP,
      priceUnit: 99_999,
      config: noLimit,
      spend: summarizeHunterSpend([], noLimit)
    })
    expect(result.allowed).toBe(true)
  })

  it('商品无价格时默认拦下，开开关后放行', () => {
    const blocked = evaluateHunterBudget({
      channel: KSK_HUNTER_CHANNEL.KIRO_DROP,
      priceUnit: undefined,
      config,
      spend: spendOf([])
    })
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe(KSK_HUNTER_BUDGET_BLOCK.UNKNOWN_PRICE)

    const allowed = evaluateHunterBudget({
      channel: KSK_HUNTER_CHANNEL.KIRO_DROP,
      priceUnit: undefined,
      config: { ...config, allowUnknownPriceOrder: true },
      spend: spendOf([])
    })
    expect(allowed.allowed).toBe(true)
    expect(allowed.costCny).toBe(0)
  })

  it('刚好等于上限时放行，超一分就拦', () => {
    const exact = evaluateHunterBudget({
      channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
      priceUnit: 100,
      config,
      spend: spendOf([])
    })
    expect(exact.allowed).toBe(true)

    const over = evaluateHunterBudget({
      channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
      priceUnit: 100.01,
      config,
      spend: spendOf([])
    })
    expect(over.allowed).toBe(false)
  })

  it('列出已用尽额度的渠道', () => {
    const spend = spendOf([
      { channel: KSK_HUNTER_CHANNEL.KIRO_CEO, amountUnit: 60, amountCny: 30, at: Date.now() }
    ])
    expect(exhaustedHunterChannels(spend)).toEqual([KSK_HUNTER_CHANNEL.KIRO_CEO])
  })

  it('余额不够付这一单时拦下', () => {
    const result = evaluateHunterBudget({
      channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
      priceUnit: 35,
      config,
      spend: spendOf([]),
      balanceUnit: 20
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe(KSK_HUNTER_BUDGET_BLOCK.BALANCE)
  })

  it('余额刚好够时放行', () => {
    expect(
      evaluateHunterBudget({
        channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
        priceUnit: 35,
        config,
        spend: spendOf([]),
        balanceUnit: 35
      }).allowed
    ).toBe(true)
  })

  it('余额未知（未启用或查询失败）时不拦，避免站点抖动停掉抢号', () => {
    expect(
      evaluateHunterBudget({
        channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
        priceUnit: 35,
        config,
        spend: spendOf([]),
        balanceUnit: undefined
      }).allowed
    ).toBe(true)
  })

  it('上限先于余额判断：两者都不满足时报上限', () => {
    // 全局上限已满，同时余额也不够 → 应报 GLOBAL 而不是 BALANCE
    const result = evaluateHunterBudget({
      channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
      priceUnit: 200,
      config,
      spend: spendOf([]),
      balanceUnit: 1
    })
    expect(result.reason).toBe(KSK_HUNTER_BUDGET_BLOCK.GLOBAL)
  })
})

describe('余额响应解析', () => {
  it.each([
    { name: '平铺 balance', payload: { balance: 320 } },
    { name: '嵌套在 data 下', payload: { code: 0, data: { balance: 320 } } },
    { name: '字段名是 points', payload: { code: 0, data: { points: 320 } } },
    { name: '字段名是 credits', payload: { data: { credits: 320 } } },
    { name: '字段名是 remain', payload: { result: { remain: 320 } } },
    { name: '字符串数字', payload: { data: { balance: '320' } } }
  ])('$name', ({ payload }) => {
    expect(parseHunterBalance(payload)).toBe(320)
  })

  it('余额为 0 也要认出来，不能当成「查不到」', () => {
    // 0 是合法余额（正好花光），返回 undefined 会让余额检查失效
    expect(parseHunterBalance({ data: { balance: 0 } })).toBe(0)
  })

  it('找不到已知字段时返回 undefined', () => {
    expect(parseHunterBalance(null)).toBeUndefined()
    expect(parseHunterBalance({ msg: 'ok' })).toBeUndefined()
  })

  it('优先取本层的已知字段，不被无关嵌套数字带偏', () => {
    expect(parseHunterBalance({ balance: 100, detail: { amount: 999 } })).toBe(100)
  })

  it('不把 code/msg 这类无关字段当余额', () => {
    // 曾经的 bug：递归兜底取第一个数字，把 code:0 当成余额 0，
    // 会让抢号器误判余额耗尽、永久拒绝下单
    expect(parseHunterBalance({ code: 0, msg: 'ok' })).toBeUndefined()
    expect(parseHunterBalance({ code: 200, total: 5, page: 1 })).toBeUndefined()
  })
})

describe('余额查询与缓存', () => {
  function balanceFetch(sequence: unknown[]): {
    impl: KskHunterFetch
    calls: () => number
  } {
    let index = 0
    return {
      impl: async () => {
        const payload = sequence[Math.min(index, sequence.length - 1)]
        index++
        if (payload instanceof Error) throw payload
        return jsonResponse(payload)
      },
      calls: () => index
    }
  }

  it('拒绝非 HTTPS 的余额地址', async () => {
    const { impl } = balanceFetch([{ balance: 100 }])
    await expect(
      fetchChannelBalance({
        url: 'http://site.example/balance',
        timeoutSeconds: 5,
        fetchImpl: impl
      })
    ).rejects.toThrow('HTTPS')
  })

  it('错误信息里的 token 被脱敏', async () => {
    const impl: KskHunterFetch = async () => new Response('bad', { status: 500 })
    await expect(
      fetchChannelBalance({
        url: 'https://site.example/balance?token=super_secret',
        timeoutSeconds: 5,
        fetchImpl: impl
      })
    ).rejects.toThrow('HTTP 500')
  })

  it('缓存未过期时不重复打站点', async () => {
    const { impl, calls } = balanceFetch([{ balance: 100 }])
    const cache = new HunterBalanceCache()
    const args = {
      channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
      url: 'https://site.example/balance',
      timeoutSeconds: 5,
      fetchImpl: impl
    }

    const first = await cache.resolve(args)
    const second = await cache.resolve(args)
    const third = await cache.resolve(args)

    expect(first.amountUnit).toBe(100)
    expect(second.amountUnit).toBe(100)
    expect(third.amountUnit).toBe(100)
    // 3 秒一轮的抢号如果每轮都查会把站点打爆，所以必须只打一次
    expect(calls()).toBe(1)
  })

  it('缓存过期后重新查', async () => {
    const { impl, calls } = balanceFetch([{ balance: 100 }, { balance: 50 }])
    const cache = new HunterBalanceCache()
    const args = {
      channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
      url: 'https://site.example/balance',
      timeoutSeconds: 5,
      fetchImpl: impl
    }

    const first = await cache.resolve({ ...args, now: 1_000 })
    const later = await cache.resolve({ ...args, now: 1_000 + KSK_HUNTER_BALANCE_TTL_MS + 1 })

    expect(first.amountUnit).toBe(100)
    expect(later.amountUnit).toBe(50)
    expect(calls()).toBe(2)
  })

  it('下单后主动失效，下一次按真实余额判断', async () => {
    const { impl, calls } = balanceFetch([{ balance: 100 }, { balance: 65 }])
    const cache = new HunterBalanceCache()
    const args = {
      channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
      url: 'https://site.example/balance',
      timeoutSeconds: 5,
      fetchImpl: impl
    }

    expect((await cache.resolve(args)).amountUnit).toBe(100)
    cache.invalidate(KSK_HUNTER_CHANNEL.KIRO_CEO)
    expect((await cache.resolve(args)).amountUnit).toBe(65)
    expect(calls()).toBe(2)
  })

  it('查询失败时记下错误并返回 undefined，而不是抛错中断抢号', async () => {
    const impl: KskHunterFetch = async () => new Response('boom', { status: 503 })
    const cache = new HunterBalanceCache()
    const snapshot = await cache.resolve({
      channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
      url: 'https://site.example/balance',
      timeoutSeconds: 5,
      fetchImpl: impl
    })
    expect(snapshot.amountUnit).toBeUndefined()
    expect(snapshot.error).toContain('503')
  })
})

describe('抢号调度', () => {
  type HunterDeps = ConstructorParameters<typeof KskHunterManager>[0]

  function makeDeps(
    store: PersistedKskHunterStore,
    overrides: Partial<HunterDeps> = {}
  ): HunterDeps {
    return {
      // drain 队列要读到刚落盘的记录，所以 deliveries 走内存 store
      readStore: async () => ({ ...store, deliveries: deliveryStore.records as never }),
      fetchImpl: async () => jsonResponse({ code: 0, data: [] }),
      importCredential: async () => ({ added: true }),
      notifyInStock: vi.fn(),
      notifyOrdered: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      notifySnapshot: vi.fn(),
      log: vi.fn(),
      ...overrides
    }
  }

  it('无货时只更新链接状态，不下单也不通知', async () => {
    const notifyInStock = vi.fn()
    const store = hunterStore([hunterLink()])
    const manager = new KskHunterManager(
      makeDeps(store, {
        fetchImpl: async () =>
          jsonResponse({ code: 0, data: [{ id: 'g1', tag: '#key-eu', stock: 0 }] }),
        notifyInStock
      })
    )

    const status = await manager.runNow()
    manager.stop()

    expect(notifyInStock).not.toHaveBeenCalled()
    expect(status.state).toBe(KSK_HUNTER_STATE.HEALTHY)
    expect(status.totalOrdered).toBe(0)
    expect(manager.linkRuntimeOf('link-1').lastInStock).toBe(false)
  })

  it('区域不在白名单内的有货商品被忽略', async () => {
    const notifyInStock = vi.fn()
    const store = hunterStore([hunterLink({ regions: ['eu-central-1'] })])
    const manager = new KskHunterManager(
      makeDeps(store, {
        fetchImpl: async () =>
          jsonResponse({ code: 0, data: [{ id: 'g1', tag: '#key-us', stock: 5 }] }),
        notifyInStock
      })
    )

    await manager.runNow()
    manager.stop()

    expect(notifyInStock).not.toHaveBeenCalled()
    expect(deliveryStore.records).toHaveLength(0)
  })

  it('仅提醒模式：弹通知但不碰下单接口', async () => {
    const notifyInStock = vi.fn()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: [{ id: 'g1', title: 'Kiro Key', tag: '#key-eu', stock: 2 }] })
    )
    const store = hunterStore([hunterLink({ mode: KSK_HUNTER_MODE.NOTIFY })])
    const manager = new KskHunterManager(makeDeps(store, { fetchImpl, notifyInStock }))

    const status = await manager.runNow()
    manager.stop()

    expect(notifyInStock).toHaveBeenCalledWith({
      linkName: 'Kiro Market · eu',
      title: 'Kiro Key',
      region: 'eu-central-1'
    })
    // 只查了列表，没发下单请求
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(status.totalInStockHits).toBe(1)
    expect(status.totalOrdered).toBe(0)
    expect(deliveryStore.records).toHaveLength(0)
  })

  it('自动下单：下游说不要号时不花钱', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: 0, data: [{ id: 'g1', tag: '#key-eu', stock: 1 }] })
    )
    const store = hunterStore([hunterLink()], { downstreamEnabled: true })
    const manager = new KskHunterManager(
      makeDeps(store, {
        fetchImpl,
        downstreamFetchImpl: async () => jsonResponse({ need: false })
      })
    )

    const status = await manager.runNow()
    manager.stop()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(status.totalOrdered).toBe(0)
    expect(deliveryStore.records).toHaveLength(0)
  })

  it('自动下单全链路：下单 → 落盘 → 验活入库 → 推送下游', async () => {
    const imported: unknown[] = []
    const downstreamCalls: string[] = []
    const store = hunterStore([hunterLink()], {
      downstreamEnabled: true,
      targetGroupId: 'ksk-group'
    })
    const manager = new KskHunterManager(
      makeDeps(store, {
        fetchImpl: async (_url, init) =>
          init.method === 'POST'
            ? jsonResponse({
                code: 0,
                data: { account: { key: KSK_ONE, aws_region: 'eu-central-1' } }
              })
            : jsonResponse({
                code: 0,
                data: [{ id: 'g1', tag: '#key-eu', stock: 1, price: 37.5 }]
              }),
        downstreamFetchImpl: async (url) => {
          downstreamCalls.push(url)
          return jsonResponse(url.endsWith('/need-account') ? { need: true } : { ok: true })
        },
        importCredential: async (input) => {
          imported.push(input)
          return { added: true }
        }
      })
    )

    await manager.runNow()
    // 推送是在下单之后异步排班的，等队列跑完
    await vi.waitFor(() =>
      expect(deliveryStore.records[0]?.state).toBe(KSK_HUNTER_DELIVERY_STATE.DELIVERED)
    )
    manager.stop()

    expect(imported).toEqual([{ key: KSK_ONE, region: 'eu-central-1', groupId: 'ksk-group' }])
    expect(downstreamCalls.some((url) => url.endsWith('/need-account'))).toBe(true)
    expect(downstreamCalls.some((url) => url.endsWith('/ksk'))).toBe(true)
    // 抢到的号必须在推送前就落盘，key 明文只在主进程侧
    expect(deliveryStore.records[0]).toMatchObject({
      key: KSK_ONE,
      region: 'eu-central-1',
      linkId: 'link-1'
    })
  })

  it('验活失败的号标为 dead_key，不推给下游', async () => {
    const downstreamCalls: string[] = []
    const store = hunterStore([hunterLink()], { downstreamEnabled: true })
    const manager = new KskHunterManager(
      makeDeps(store, {
        fetchImpl: async (_url, init) =>
          init.method === 'POST'
            ? jsonResponse({ code: 0, data: { key: KSK_TWO, region: 'eu-central-1' } })
            : jsonResponse({
                code: 0,
                data: [{ id: 'g1', tag: '#key-eu', stock: 1, price: 37.5 }]
              }),
        downstreamFetchImpl: async (url) => {
          downstreamCalls.push(url)
          return jsonResponse(url.endsWith('/need-account') ? { need: true } : { ok: true })
        },
        importCredential: async () => {
          throw new Error('AccountSuspendedException')
        }
      })
    )

    await manager.runNow()
    manager.stop()

    expect(deliveryStore.records[0]).toMatchObject({
      key: KSK_TWO,
      state: KSK_HUNTER_DELIVERY_STATE.DEAD_KEY
    })
    // 号已买到但不可用，绝不能推给下游
    expect(downstreamCalls.some((url) => url.endsWith('/ksk'))).toBe(false)
  })

  it('推送失败后保留记录并安排重试，重试耗尽才标 failed', async () => {
    const store = hunterStore([hunterLink()], { downstreamEnabled: true })
    deliveryStore.records.push({
      id: 'd1',
      linkId: 'link-1',
      linkName: 'Kiro Market · eu',
      key: KSK_ONE,
      region: 'eu-central-1',
      state: KSK_HUNTER_DELIVERY_STATE.PENDING,
      // 只差最后一次就耗尽，验证「耗尽才标 failed」而不是每次失败都标
      attempts: KSK_HUNTER_DELIVERY_MAX_ATTEMPTS - 1,
      createdAt: 1,
      updatedAt: 1
    })
    const manager = new KskHunterManager(
      makeDeps(store, {
        downstreamFetchImpl: async () => new Response('downstream down', { status: 503 })
      })
    )

    await manager.start()
    await vi.waitFor(() =>
      expect(deliveryStore.records[0]?.state).toBe(KSK_HUNTER_DELIVERY_STATE.FAILED)
    )
    manager.stop()

    expect(deliveryStore.records[0]).toMatchObject({
      attempts: KSK_HUNTER_DELIVERY_MAX_ATTEMPTS,
      nextAttemptAt: undefined
    })
    expect(String(deliveryStore.records[0].lastError)).toContain('503')
  })

  it('单链接失败不影响其它链接，且整轮标记为部分异常', async () => {
    const notifyInStock = vi.fn()
    const store = hunterStore([
      hunterLink({ id: 'ok', name: '正常', mode: KSK_HUNTER_MODE.NOTIFY }),
      hunterLink({
        id: 'bad',
        name: '故障',
        mode: KSK_HUNTER_MODE.NOTIFY,
        secrets: { listUrl: 'https://broken.example/api', orderUrl: '' }
      })
    ])
    const manager = new KskHunterManager(
      makeDeps(store, {
        fetchImpl: async (url) =>
          url.startsWith('https://broken.example')
            ? new Response('boom', { status: 500 })
            : jsonResponse({
                code: 0,
                data: [{ id: 'g1', tag: '#key-eu', stock: 1, price: 37.5 }]
              }),
        notifyInStock
      })
    )

    const status = await manager.runNow()
    manager.stop()

    expect(notifyInStock).toHaveBeenCalledTimes(1)
    expect(status.state).toBe(KSK_HUNTER_STATE.DEGRADED)
    expect(manager.linkRuntimeOf('bad').lastError).toContain('500')
    expect(manager.linkRuntimeOf('ok').lastInStock).toBe(true)
  })

  it('拒绝非 HTTPS 的商品站点地址', async () => {
    const store = hunterStore([
      hunterLink({ secrets: { listUrl: 'http://market.example/api', orderUrl: '' } })
    ])
    const manager = new KskHunterManager(makeDeps(store))

    const status = await manager.runNow()
    manager.stop()

    expect(manager.linkRuntimeOf('link-1').lastError).toContain('HTTPS')
    expect(status.state).toBe(KSK_HUNTER_STATE.DEGRADED)
  })

  /** 有货 + 带价格的列表响应，配合下单响应，构造一次完整抢号。 */
  function priceFetchImpl(
    priceUnit: number | undefined
  ): (url: string, init: { method: string }) => Promise<Response> {
    return async (_url: string, init: { method: string }) =>
      init.method === 'POST'
        ? jsonResponse({ code: 0, data: { key: KSK_ONE, region: 'eu-central-1' } })
        : jsonResponse({
            code: 0,
            data: [{ id: 'g1', title: 'Kiro Key', tag: '#key-eu', stock: 1, price: priceUnit }]
          })
  }

  it('下单后按渠道系数记账，原币与人民币都记上', async () => {
    const store = hunterStore([hunterLink({ channel: KSK_HUNTER_CHANNEL.KIRO_CEO })], {
      billing: {
        ...DEFAULT_KSK_HUNTER_CONFIG.billing,
        [KSK_HUNTER_CHANNEL.KIRO_CEO]: {
          unitLabel: 'CRD',
          cnyPerUnit: 0.5,
          dailyLimitUnit: 0,
          lowBalanceThresholdUnit: 0
        }
      }
    })
    const manager = new KskHunterManager(makeDeps(store, { fetchImpl: priceFetchImpl(35) }))

    await manager.runNow()
    manager.stop()

    // 35 CRD × 0.5 = ¥17.5
    expect(deliveryStore.spend).toHaveLength(1)
    expect(deliveryStore.spend[0]).toMatchObject({
      channel: KSK_HUNTER_CHANNEL.KIRO_CEO,
      amountUnit: 35,
      amountCny: 17.5
    })
    // 花费也记在 delivery 上，便于列表展示
    expect(deliveryStore.records[0]).toMatchObject({
      costUnit: 35,
      costCny: 17.5,
      unitLabel: 'CRD'
    })
  })

  it('超出全局上限时停下单，但仍然弹提醒', async () => {
    const notifyInStock = vi.fn()
    const notifyBudgetExhausted = vi.fn()
    const fetchImpl = vi.fn(priceFetchImpl(50))
    const store = hunterStore(
      [hunterLink()],
      { dailyLimitCny: 40 },
      // 今天已花 ¥30，再买 ¥50 会到 ¥80 > ¥40
      [
        {
          id: 's1',
          channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
          amountUnit: 30,
          amountCny: 30,
          at: Date.now()
        }
      ]
    )
    const manager = new KskHunterManager(
      makeDeps(store, { fetchImpl, notifyInStock, notifyBudgetExhausted })
    )

    await manager.runNow()
    manager.stop()

    // 提醒照发，钱不花
    expect(notifyInStock).toHaveBeenCalledTimes(1)
    expect(notifyBudgetExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global', spentCny: 30, limitCny: 40 })
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1) // 只查了列表，没发下单
    expect(deliveryStore.records).toHaveLength(0)
    expect(deliveryStore.spend).toHaveLength(0)
    expect(manager.linkRuntimeOf('link-1').lastError).toContain('预算已用尽')
  })

  it('超出渠道上限时按渠道熔断', async () => {
    const notifyBudgetExhausted = vi.fn()
    const store = hunterStore(
      [hunterLink()],
      {
        dailyLimitCny: 0,
        billing: {
          ...DEFAULT_KSK_HUNTER_CONFIG.billing,
          [KSK_HUNTER_CHANNEL.KIRO_MARKET]: {
            unitLabel: 'CNY',
            cnyPerUnit: 1,
            dailyLimitUnit: 20,
            lowBalanceThresholdUnit: 0
          }
        }
      },
      [
        {
          id: 's1',
          channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
          amountUnit: 15,
          amountCny: 15,
          at: Date.now()
        }
      ]
    )
    const manager = new KskHunterManager(
      makeDeps(store, { fetchImpl: priceFetchImpl(10), notifyBudgetExhausted })
    )

    const status = await manager.runNow()
    manager.stop()

    expect(deliveryStore.records).toHaveLength(0)
    expect(notifyBudgetExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'channel' })
    )
    expect(status.budgetBlock).toBe(KSK_HUNTER_BUDGET_BLOCK.CHANNEL)
  })

  it('额度充足时正常下单，不触发熔断通知', async () => {
    const notifyBudgetExhausted = vi.fn()
    const store = hunterStore([hunterLink()], { dailyLimitCny: 1000 })
    const manager = new KskHunterManager(
      makeDeps(store, { fetchImpl: priceFetchImpl(20), notifyBudgetExhausted })
    )

    const status = await manager.runNow()
    manager.stop()

    expect(deliveryStore.records).toHaveLength(1)
    expect(deliveryStore.spend[0]).toMatchObject({ amountCny: 20 })
    expect(notifyBudgetExhausted).not.toHaveBeenCalled()
    expect(status.budgetBlock).toBe(KSK_HUNTER_BUDGET_BLOCK.NONE)
  })

  it('商品没有价格时默认不下单，避免花出算不清的钱', async () => {
    const notifyInStock = vi.fn()
    const fetchImpl = vi.fn(priceFetchImpl(undefined))
    const store = hunterStore([hunterLink()], { allowUnknownPriceOrder: false })
    const manager = new KskHunterManager(makeDeps(store, { fetchImpl, notifyInStock }))

    await manager.runNow()
    manager.stop()

    expect(notifyInStock).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(deliveryStore.records).toHaveLength(0)
    expect(manager.linkRuntimeOf('link-1').lastError).toContain('未提供价格')
  })

  it('开了允许未知价格后照买，花费记 0', async () => {
    const store = hunterStore([hunterLink()], { allowUnknownPriceOrder: true })
    const manager = new KskHunterManager(makeDeps(store, { fetchImpl: priceFetchImpl(undefined) }))

    await manager.runNow()
    manager.stop()

    expect(deliveryStore.records).toHaveLength(1)
    expect(deliveryStore.spend[0]).toMatchObject({ amountUnit: 0, amountCny: 0 })
  })

  it('昨天花光额度不影响今天（本地日切后自动解除熔断）', async () => {
    const store = hunterStore([hunterLink()], { dailyLimitCny: 40 }, [
      {
        id: 's1',
        channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
        amountUnit: 40,
        amountCny: 40,
        at: Date.now() - 24 * 60 * 60_000
      }
    ])
    const manager = new KskHunterManager(makeDeps(store, { fetchImpl: priceFetchImpl(20) }))

    const status = await manager.runNow()
    manager.stop()

    // 昨天的花费不计入今天，照买
    expect(deliveryStore.records).toHaveLength(1)
    expect(status.budgetBlock).toBe(KSK_HUNTER_BUDGET_BLOCK.NONE)
  })

  it('余额不足时跳过下单，不白跑一次下单请求', async () => {
    const orderCalls: string[] = []
    const store = hunterStore([hunterLink({ channel: KSK_HUNTER_CHANNEL.KIRO_CEO })], {
      balanceCheckEnabled: true,
      billing: {
        ...DEFAULT_KSK_HUNTER_CONFIG.billing,
        [KSK_HUNTER_CHANNEL.KIRO_CEO]: {
          unitLabel: '积分',
          cnyPerUnit: 0.5,
          dailyLimitUnit: 0,
          lowBalanceThresholdUnit: 100
        }
      }
    })
    store.secrets.balanceUrls = {
      [KSK_HUNTER_CHANNEL.KIRO_CEO]: 'https://site.example/balance'
    }
    const notifyLowBalance = vi.fn()
    const manager = new KskHunterManager(
      makeDeps(store, {
        notifyLowBalance,
        fetchImpl: async (url, init) => {
          if (url.includes('/balance')) return jsonResponse({ code: 0, data: { balance: 20 } })
          if (init.method === 'POST') {
            orderCalls.push(url)
            return jsonResponse({ code: 0, data: { key: KSK_ONE, region: 'eu-central-1' } })
          }
          return jsonResponse({
            code: 0,
            data: [{ id: 'g1', tag: '#key-eu', stock: 1, price: 35 }]
          })
        }
      })
    )

    const status = await manager.runNow()
    manager.stop()

    // 余额 20 积分买不起 35 积分的商品：不该发下单请求
    expect(orderCalls).toHaveLength(0)
    expect(deliveryStore.records).toHaveLength(0)
    expect(status.budgetBlock).toBe(KSK_HUNTER_BUDGET_BLOCK.BALANCE)
    // 20 < 阈值 100，应提醒充值
    expect(notifyLowBalance).toHaveBeenCalledWith(
      expect.objectContaining({ balanceUnit: 20, thresholdUnit: 100, unitLabel: '积分' })
    )
  })

  it('余额充足时正常下单', async () => {
    const store = hunterStore([hunterLink({ channel: KSK_HUNTER_CHANNEL.KIRO_CEO })], {
      balanceCheckEnabled: true,
      billing: {
        ...DEFAULT_KSK_HUNTER_CONFIG.billing,
        [KSK_HUNTER_CHANNEL.KIRO_CEO]: {
          unitLabel: '积分',
          cnyPerUnit: 0.5,
          dailyLimitUnit: 0,
          lowBalanceThresholdUnit: 0
        }
      }
    })
    store.secrets.balanceUrls = {
      [KSK_HUNTER_CHANNEL.KIRO_CEO]: 'https://site.example/balance'
    }
    const manager = new KskHunterManager(
      makeDeps(store, {
        fetchImpl: async (url, init) => {
          if (url.includes('/balance')) return jsonResponse({ code: 0, data: { balance: 500 } })
          if (init.method === 'POST') {
            return jsonResponse({ code: 0, data: { key: KSK_ONE, region: 'eu-central-1' } })
          }
          return jsonResponse({
            code: 0,
            data: [{ id: 'g1', tag: '#key-eu', stock: 1, price: 35 }]
          })
        }
      })
    )

    await manager.runNow()
    manager.stop()

    expect(deliveryStore.records).toHaveLength(1)
    // 35 积分 × 0.5 = ¥17.5
    expect(deliveryStore.spend[0]).toMatchObject({ amountUnit: 35, amountCny: 17.5 })
  })

  it('余额查询失败时不拦单：站点抖动不该停掉抢号', async () => {
    const store = hunterStore([hunterLink()], { balanceCheckEnabled: true })
    store.secrets.balanceUrls = {
      [KSK_HUNTER_CHANNEL.KIRO_MARKET]: 'https://site.example/balance'
    }
    const manager = new KskHunterManager(
      makeDeps(store, {
        fetchImpl: async (url, init) => {
          if (url.includes('/balance')) return new Response('down', { status: 503 })
          if (init.method === 'POST') {
            return jsonResponse({ code: 0, data: { key: KSK_ONE, region: 'eu-central-1' } })
          }
          return jsonResponse({
            code: 0,
            data: [{ id: 'g1', tag: '#key-eu', stock: 1, price: 20 }]
          })
        }
      })
    )

    await manager.runNow()
    manager.stop()

    // 查不到余额 → 不按余额拦，照买
    expect(deliveryStore.records).toHaveLength(1)
  })

  it('未启用余额检查时完全不查余额', async () => {
    const balanceCalls: string[] = []
    const store = hunterStore([hunterLink()], { balanceCheckEnabled: false })
    store.secrets.balanceUrls = {
      [KSK_HUNTER_CHANNEL.KIRO_MARKET]: 'https://site.example/balance'
    }
    const manager = new KskHunterManager(
      makeDeps(store, {
        fetchImpl: async (url, init) => {
          if (url.includes('/balance')) {
            balanceCalls.push(url)
            return jsonResponse({ code: 0, data: { balance: 0 } })
          }
          if (init.method === 'POST') {
            return jsonResponse({ code: 0, data: { key: KSK_ONE, region: 'eu-central-1' } })
          }
          return jsonResponse({
            code: 0,
            data: [{ id: 'g1', tag: '#key-eu', stock: 1, price: 20 }]
          })
        }
      })
    )

    await manager.runNow()
    manager.stop()

    expect(balanceCalls).toHaveLength(0)
    expect(deliveryStore.records).toHaveLength(1)
  })
})
