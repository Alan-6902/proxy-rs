import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProxyPoolScheduler,
  type ProxyPoolStoreSlice
} from '../../src/main/proxy/proxyPoolScheduler'
import {
  DEFAULT_PROXY_POOL_CONFIG,
  type ProxyEntry,
  type ProxyPoolConfig,
  type ProxyValidationResult
} from '../../src/shared/proxyPool'

function makeEntry(id: string, overrides: Partial<ProxyEntry> = {}): ProxyEntry {
  return {
    id,
    url: `http://127.0.0.1:${9000 + Number(id.replace(/\D/g, '') || 0)}`,
    protocol: 'http',
    host: '127.0.0.1',
    port: 9000,
    status: 'untested',
    usedCount: 0,
    failCount: 0,
    enabled: true,
    createdAt: 1000,
    ...overrides
  }
}

/** 内存版 store，模拟主进程 electron-store + accountStoreCoordinator 的读改写 */
function makeHarness(options: {
  entries: ProxyEntry[]
  config?: Partial<ProxyPoolConfig>
  validate?: (url: string) => Promise<ProxyValidationResult> | ProxyValidationResult
}) {
  const data: ProxyPoolStoreSlice = {
    proxyPool: Object.fromEntries(options.entries.map((e) => [e.id, e])),
    proxyPoolConfig: { ...DEFAULT_PROXY_POOL_CONFIG, ...options.config }
  }
  const notified: Array<{ entries: ProxyEntry[] }> = []
  const validatedUrls: string[] = []
  /** 记录并发峰值，用于验证 concurrency 生效 */
  let inFlight = 0
  let peakInFlight = 0

  const scheduler = new ProxyPoolScheduler({
    readStore: async () => data,
    mutateStore: async (mutator) => {
      const next = mutator(data)
      if (!next) return
      data.proxyPool = next.proxyPool
      data.proxyPoolConfig = next.proxyPoolConfig
    },
    validate: async ({ url }) => {
      validatedUrls.push(url)
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      try {
        return options.validate ? await options.validate(url) : { success: true, latencyMs: 100 }
      } finally {
        inFlight--
      }
    },
    notifyRenderer: (payload) => notified.push(payload)
  })

  return {
    scheduler,
    data,
    notified,
    validatedUrls,
    get peakInFlight() {
      return peakInFlight
    },
    entry: (id: string): ProxyEntry | undefined => data.proxyPool?.[id]
  }
}

describe('代理池定时验活调度器', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  describe('启动条件', () => {
    it('autoValidateIntervalMin 为 0 时不启动', async () => {
      const h = makeHarness({ entries: [makeEntry('1')], config: { autoValidateIntervalMin: 0 } })
      await h.scheduler.start()
      expect(h.scheduler.isRunning).toBe(false)
      h.scheduler.stop()
    })

    it('autoValidateIntervalMin 为负数时不启动', async () => {
      const h = makeHarness({ entries: [makeEntry('1')], config: { autoValidateIntervalMin: -5 } })
      await h.scheduler.start()
      expect(h.scheduler.isRunning).toBe(false)
      h.scheduler.stop()
    })

    it('配置了正间隔则启动，stop 后停止', async () => {
      const h = makeHarness({ entries: [makeEntry('1')], config: { autoValidateIntervalMin: 30 } })
      await h.scheduler.start()
      expect(h.scheduler.isRunning).toBe(true)
      h.scheduler.stop()
      expect(h.scheduler.isRunning).toBe(false)
    })

    it('重复 start 幂等，不会累积多个定时器', async () => {
      const h = makeHarness({ entries: [makeEntry('1')], config: { autoValidateIntervalMin: 30 } })
      await h.scheduler.start()
      await h.scheduler.start()
      await h.scheduler.restart()
      expect(h.scheduler.isRunning).toBe(true)
      h.scheduler.stop()
      expect(h.scheduler.isRunning).toBe(false)
    })
  })

  describe('验活执行与结果落盘', () => {
    it('只验活 enabled 的代理，跳过已停用的', async () => {
      const h = makeHarness({
        entries: [
          makeEntry('1', { enabled: true }),
          makeEntry('2', { enabled: false }),
          makeEntry('3', { enabled: true })
        ]
      })
      const count = await h.scheduler.runOnce()
      expect(count).toBe(2)
      expect(h.validatedUrls).toHaveLength(2)
      expect(h.entry('2')?.status).toBe('untested') // 未被碰过
    })

    it('成功结果写入 status/latency/lastTestedAt', async () => {
      const h = makeHarness({
        entries: [makeEntry('1')],
        validate: () => ({ success: true, latencyMs: 250, externalIp: '1.2.3.4' })
      })
      await h.scheduler.runOnce()
      const e = h.entry('1')!
      expect(e.status).toBe('alive')
      expect(e.latencyMs).toBe(250)
      expect(e.lastTestedAt).toBeGreaterThan(0)
      expect(e.lastError).toBeUndefined()
      expect(e.failCount).toBe(0)
    })

    it('高延迟标记为 slow 而非 alive', async () => {
      const h = makeHarness({
        entries: [makeEntry('1')],
        validate: () => ({ success: true, latencyMs: 5000 })
      })
      await h.scheduler.runOnce()
      expect(h.entry('1')?.status).toBe('slow')
    })

    it('失败结果累加 failCount 并记录错误', async () => {
      const h = makeHarness({
        entries: [makeEntry('1', { failCount: 1 })],
        validate: () => ({ success: false, error: 'HTTP 502' })
      })
      await h.scheduler.runOnce()
      const e = h.entry('1')!
      expect(e.status).toBe('dead')
      expect(e.failCount).toBe(2)
      expect(e.lastError).toBe('HTTP 502')
    })

    it('validate 抛异常不影响其它代理，异常条目记为失败', async () => {
      const h = makeHarness({
        entries: [makeEntry('1'), makeEntry('2')],
        validate: (url) => {
          if (url.endsWith('9001')) throw new Error('boom')
          return { success: true, latencyMs: 100 }
        }
      })
      const count = await h.scheduler.runOnce()
      expect(count).toBe(2)
      expect(h.entry('1')?.status).toBe('dead')
      expect(h.entry('1')?.lastError).toBe('boom')
      expect(h.entry('2')?.status).toBe('alive')
    })

    it('池为空时不写盘不通知', async () => {
      const h = makeHarness({ entries: [] })
      expect(await h.scheduler.runOnce()).toBe(0)
      expect(h.notified).toHaveLength(0)
    })
  })

  describe('自动停用与轮换代理保护', () => {
    it('失败达阈值且池中有多条可用时自动停用', async () => {
      const h = makeHarness({
        entries: [
          makeEntry('1', { failCount: 2, status: 'alive' }),
          makeEntry('2', { status: 'alive' })
        ],
        config: { autoDisableDead: true, failureThreshold: 3 },
        validate: (url) =>
          url.endsWith('9001')
            ? { success: false, error: 'dead' }
            : { success: true, latencyMs: 100 }
      })
      await h.scheduler.runOnce()
      expect(h.entry('1')?.enabled).toBe(false)
      expect(h.entry('2')?.enabled).toBe(true)
    })

    it('池中仅剩一条可用时不自动停用，避免退化为直连', async () => {
      const h = makeHarness({
        entries: [makeEntry('1', { failCount: 5, status: 'alive' })],
        config: { autoDisableDead: true, failureThreshold: 3 },
        validate: () => ({ success: false, error: 'dead' })
      })
      await h.scheduler.runOnce()
      expect(h.entry('1')?.enabled).toBe(true)
      expect(h.entry('1')?.status).toBe('dead')
    })

    it('autoDisableDead 关闭时不停用', async () => {
      const h = makeHarness({
        entries: [makeEntry('1', { failCount: 9 }), makeEntry('2')],
        config: { autoDisableDead: false, failureThreshold: 1 },
        validate: () => ({ success: false, error: 'dead' })
      })
      await h.scheduler.runOnce()
      expect(h.entry('1')?.enabled).toBe(true)
    })
  })

  describe('并发控制', () => {
    it('并发数不超过配置值', async () => {
      const entries = Array.from({ length: 10 }, (_, i) => makeEntry(String(i + 1)))
      const h = makeHarness({
        entries,
        config: { autoValidateConcurrency: 3 },
        validate: async () => {
          await new Promise((r) => setTimeout(r, 5))
          return { success: true, latencyMs: 10 }
        }
      })
      await h.scheduler.runOnce()
      expect(h.peakInFlight).toBeLessThanOrEqual(3)
      expect(h.validatedUrls).toHaveLength(10)
    })

    it('并发数超过条目数时按条目数收敛', async () => {
      const h = makeHarness({
        entries: [makeEntry('1'), makeEntry('2')],
        config: { autoValidateConcurrency: 50 },
        validate: async () => {
          await new Promise((r) => setTimeout(r, 5))
          return { success: true, latencyMs: 10 }
        }
      })
      await h.scheduler.runOnce()
      expect(h.peakInFlight).toBeLessThanOrEqual(2)
    })
  })

  describe('防重入', () => {
    it('前一轮未完成时 runOnce 直接返回 0，不重复验活', async () => {
      let release: (() => void) | null = null
      const gate = new Promise<void>((r) => {
        release = r
      })
      const h = makeHarness({
        entries: [makeEntry('1')],
        validate: async () => {
          await gate
          return { success: true, latencyMs: 10 }
        }
      })
      const first = h.scheduler.runOnce()
      const second = await h.scheduler.runOnce()
      expect(second).toBe(0)
      release!()
      await first
      expect(h.validatedUrls).toHaveLength(1)
    })
  })

  describe('与渲染进程并发写的竞态', () => {
    it('验活期间条目被删除，则丢弃该结果而非复活它', async () => {
      // 用 validate 回调本身模拟「验活在途时渲染进程删掉了这条代理」：
      // 1 号验活成功返回，但结果写盘前它已从 store 消失。
      let harness: ReturnType<typeof makeHarness>
      harness = makeHarness({
        entries: [makeEntry('1'), makeEntry('2')],
        validate: (url) => {
          if (url.endsWith('9001')) {
            delete (harness.data.proxyPool as Record<string, ProxyEntry>)['1']
          }
          return { success: true, latencyMs: 100 }
        }
      })
      const count = await harness.scheduler.runOnce()
      // 1 号不该被验活结果"复活"回 store
      expect(harness.entry('1')).toBeUndefined()
      // 只有 2 号的结果被应用
      expect(count).toBe(1)
      expect(harness.notified[0].entries.map((e) => e.id)).toEqual(['2'])
    })

    it('结果以盘上最新状态为基准合并，不整份覆盖', async () => {
      const h = makeHarness({
        entries: [makeEntry('1'), makeEntry('2', { label: '原标注' })],
        validate: () => ({ success: true, latencyMs: 100 })
      })
      await h.scheduler.runOnce()
      // 未参与本轮的字段（label）应当保留
      expect(h.entry('2')?.label).toBe('原标注')
      expect(h.entry('2')?.status).toBe('alive')
    })
  })

  describe('结果通知', () => {
    it('落盘后推送渲染进程', async () => {
      const h = makeHarness({ entries: [makeEntry('1'), makeEntry('2')] })
      await h.scheduler.runOnce()
      expect(h.notified).toHaveLength(1)
      expect(h.notified[0].entries.map((e) => e.id).sort()).toEqual(['1', '2'])
    })
  })

  describe('心跳间隔节流', () => {
    it('未到间隔时 tick 不验活，到点后才跑', async () => {
      const h = makeHarness({ entries: [makeEntry('1')], config: { autoValidateIntervalMin: 30 } })
      // 首次 tick：lastRunAt 为 0，立即跑一轮
      await h.scheduler.tick()
      expect(h.validatedUrls).toHaveLength(1)
      // 紧接着再 tick：距上次不足 30 分钟，应跳过
      await h.scheduler.tick()
      expect(h.validatedUrls).toHaveLength(1)

      // 把时间推到 30 分钟后
      const realNow = Date.now
      try {
        vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31 * 60_000)
        await h.scheduler.tick()
        expect(h.validatedUrls).toHaveLength(2)
      } finally {
        vi.mocked(Date.now).mockRestore()
      }
    })
  })

  describe('运行期间配置被关闭', () => {
    it('tick 发现间隔被改为 0 时自行停表', async () => {
      const h = makeHarness({ entries: [makeEntry('1')], config: { autoValidateIntervalMin: 1 } })
      await h.scheduler.start()
      expect(h.scheduler.isRunning).toBe(true)
      // 模拟用户关掉定时验活
      h.data.proxyPoolConfig = { ...h.data.proxyPoolConfig, autoValidateIntervalMin: 0 }
      await h.scheduler.tick()
      expect(h.scheduler.isRunning).toBe(false)
      expect(h.validatedUrls).toHaveLength(0)
    })
  })
})
