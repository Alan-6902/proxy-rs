import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * 交付账本与结算管理器的端到端验证：**真实读写文件**。
 *
 * 与 downstream-settlement.test.ts 的分工：那份用注入的内存实现验聚合口径；
 * 这份走真实 fs（临时目录）验落盘链路——加密往返、按 id 幂等、CSV 真的写到磁盘、
 * 结算顺序、以及「导出不推进锚点」这个容易写反的约束。
 *
 * 只 mock safeStorage（测试环境没有系统钥匙串），fs 用真的。
 */

const testDir = join(tmpdir(), `proxy-rs-downstream-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => testDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    // 用 base64 假装加密：能验证「写进去的能读回来」，也能确认落盘的不是可读明文
    encryptString: (value: string) => Buffer.from(value, 'utf-8').toString('base64'),
    decryptString: (buffer: Buffer) => Buffer.from(buffer.toString(), 'base64').toString('utf-8')
  },
  ipcMain: { handle: () => undefined },
  shell: { openPath: async () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))

import {
  DOWNSTREAM_CSV_DIR_NAME,
  downstreamCsvFileName,
  downstreamDateKeyToStart,
  type DownstreamDelivery,
  type DownstreamLedgerUsage
} from '../../src/shared/downstreamSettlement'
import { KSK_HUNTER_CHANNEL } from '../../src/shared/kskHunter'
import { KSK_LEDGER_STATE } from '../../src/shared/kskLedger'
import {
  deliveryLedgerStorePath,
  loadDeliveryLedger,
  recordDownstreamDelivery
} from '../../src/main/downstreamSettlement/deliveryLedgerStore'
import { DownstreamSettlementManager } from '../../src/main/downstreamSettlement/settlementManager'

const VALID_KEY = 'ksk_AbCdEf0123456789abcdef'
const SECOND_KEY = 'ksk_ZyXwVu9876543210zyxwvu'

function at(date: string, hour = 0): number {
  const start = downstreamDateKeyToStart(date)
  if (start === undefined) throw new Error(`bad date: ${date}`)
  return start + hour * 3_600_000
}

function makeDelivery(overrides: Partial<DownstreamDelivery> = {}): DownstreamDelivery {
  return {
    id: 'd1',
    accountId: 'acc-1',
    key: VALID_KEY,
    maskedKey: 'ksk_...cdef',
    region: 'eu-central-1',
    channel: KSK_HUNTER_CHANNEL.KIRO_MARKET,
    linkId: 'link-1',
    linkName: 'Kiro Market · eu',
    groupId: 'group-1',
    purchasedAt: at('2026-08-01', 10),
    deliveredAt: at('2026-08-01', 10),
    attempts: 1,
    costUnit: 35,
    costCny: 30,
    unitLabel: '积分',
    ...overrides
  }
}

function usageOf(entries: Record<string, number>): Record<string, DownstreamLedgerUsage> {
  return Object.fromEntries(
    Object.entries(entries).map(([accountId, usedCredits]) => [
      accountId,
      { accountId, usedCredits, usageLimit: 1000, state: KSK_LEDGER_STATE.ALIVE }
    ])
  )
}

beforeEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true })
  await fs.mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true })
})

describe('交付账本落盘', () => {
  it('缺文件时按空账本，不抛错', async () => {
    await expect(loadDeliveryLedger()).resolves.toMatchObject({
      deliveries: [],
      settlements: []
    })
  })

  it('加密往返：写进去能读回来，且磁盘上不是可读明文', async () => {
    await recordDownstreamDelivery(makeDelivery())

    const raw = await fs.readFile(deliveryLedgerStorePath(), 'utf-8')
    // 完整 key 不能以明文形式出现在文件里
    expect(raw).not.toContain(VALID_KEY)

    const state = await loadDeliveryLedger()
    expect(state.deliveries).toHaveLength(1)
    expect(state.deliveries[0].key).toBe(VALID_KEY)
    expect(state.deliveries[0].groupId).toBe('group-1')
  })

  it('文件权限只给本人读写', async () => {
    await recordDownstreamDelivery(makeDelivery())
    const stat = await fs.stat(deliveryLedgerStorePath())
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('按 id 幂等：重复记账不产生第二条，也不覆盖首次的交付时刻', async () => {
    await recordDownstreamDelivery(makeDelivery({ deliveredAt: at('2026-08-01', 10) }))
    await recordDownstreamDelivery(makeDelivery({ deliveredAt: at('2026-08-01', 15) }))

    const state = await loadDeliveryLedger()
    expect(state.deliveries).toHaveLength(1)
    // 首次那条的时刻才是真正的交付时刻
    expect(state.deliveries[0].deliveredAt).toBe(at('2026-08-01', 10))
  })

  it('并发写不互相覆盖：写操作串行化', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        recordDownstreamDelivery(
          makeDelivery({
            id: `d${index}`,
            accountId: `acc-${index}`,
            key: index % 2 === 0 ? VALID_KEY : SECOND_KEY
          })
        )
      )
    )

    const state = await loadDeliveryLedger()
    expect(state.deliveries).toHaveLength(8)
  })
})

describe('结算管理器', () => {
  function makeManager(input: {
    usage: Record<string, DownstreamLedgerUsage>
    csvDir?: string
  }): DownstreamSettlementManager {
    return new DownstreamSettlementManager({
      readCsvDir: async () => input.csvDir,
      userDataDir: () => testDir,
      readLedgerUsage: async () => input.usage,
      readGroupNames: async () => ({ 'group-1': '下游A' }),
      log: vi.fn()
    })
  }

  const defaultCsvDir = (): string => join(testDir, DOWNSTREAM_CSV_DIR_NAME)

  it('默认导出目录落 userData 子目录；相对路径按未配置处理', async () => {
    await expect(makeManager({ usage: {} }).resolveCsvDir()).resolves.toBe(defaultCsvDir())
    // 相对路径的基准取决于进程 cwd，打包后不可预测，必须回落到默认目录
    await expect(makeManager({ usage: {}, csvDir: './somewhere' }).resolveCsvDir()).resolves.toBe(
      defaultCsvDir()
    )
  })

  it('配了绝对路径就用它', async () => {
    const custom = join(testDir, 'custom-out')
    await expect(makeManager({ usage: {}, csvDir: custom }).resolveCsvDir()).resolves.toBe(custom)
  })

  it('导出真的写出 CSV 文件，含完整 key 与分组名，权限 0600', async () => {
    await recordDownstreamDelivery(makeDelivery())
    const manager = makeManager({ usage: usageOf({ 'acc-1': 60 }) })

    const path = await manager.exportDay('2026-08-01')
    expect(path).toBe(join(defaultCsvDir(), downstreamCsvFileName('2026-08-01')))

    const csv = await fs.readFile(path, 'utf-8')
    expect(csv).toContain(VALID_KEY)
    expect(csv).toContain('下游A')
    expect(csv.split('\n')[1]).toContain('是')

    const stat = await fs.stat(path)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('导出不推进锚点：当天导十次结果一致', async () => {
    await recordDownstreamDelivery(makeDelivery())
    const manager = makeManager({ usage: usageOf({ 'acc-1': 60 }) })

    await manager.exportDay('2026-08-01')
    const first = await fs.readFile(
      join(defaultCsvDir(), downstreamCsvFileName('2026-08-01')),
      'utf-8'
    )
    await manager.exportDay('2026-08-01')
    const second = await fs.readFile(
      join(defaultCsvDir(), downstreamCsvFileName('2026-08-01')),
      'utf-8'
    )

    expect(second).toBe(first)
    // 锚点没动，账本里还是「没结算过」
    const state = await loadDeliveryLedger()
    expect(state.deliveries[0].settledCredits).toBeUndefined()
    expect(state.settlements).toEqual([])
  })

  it('结算落定稿并推进锚点，再结算一次积分为 0', async () => {
    await recordDownstreamDelivery(makeDelivery())
    const manager = makeManager({ usage: usageOf({ 'acc-1': 150 }) })

    await manager.settleDay('2026-08-01')
    const afterFirst = await loadDeliveryLedger()
    expect(afterFirst.settlements).toHaveLength(1)
    expect(afterFirst.settlements[0]).toMatchObject({ date: '2026-08-01', credits: 150 })
    expect(afterFirst.deliveries[0].settledCredits).toBe(150)
    expect(afterFirst.lastSettledDate).toBe('2026-08-01')

    await manager.settleDay('2026-08-01')
    const afterSecond = await loadDeliveryLedger()
    // 定稿被覆盖成新的一次（积分 0），而不是叠加出两条记录
    expect(afterSecond.settlements).toHaveLength(1)
    expect(afterSecond.settlements[0].credits).toBe(0)
  })

  it('报表读得出刚落的定稿，且日期切换互不干扰', async () => {
    await recordDownstreamDelivery(makeDelivery())
    const manager = makeManager({ usage: usageOf({ 'acc-1': 150 }) })
    await manager.settleDay('2026-08-01')

    const settled = await manager.report({ date: '2026-08-01' })
    expect(settled.settled).toBe(true)
    expect(settled.credits).toBe(150)
    expect(settled.deliveries).toBe(1)
    expect(settled.rows[0].groupName).toBe('下游A')
    // 页面拿到的行不含完整 key
    expect(JSON.stringify(settled.rows)).not.toContain(VALID_KEY)

    const empty = await manager.report({ date: '2026-08-02' })
    expect(empty.deliveries).toBe(0)
    expect(empty.settled).toBe(false)
  })

  it('台账读失败不炸：积分按未知处理，锚点不推进', async () => {
    await recordDownstreamDelivery(makeDelivery())
    const manager = new DownstreamSettlementManager({
      readCsvDir: async () => undefined,
      userDataDir: () => testDir,
      readLedgerUsage: async () => {
        throw new Error('台账文件损坏')
      },
      log: vi.fn()
    })

    await manager.settleDay('2026-08-01')
    const state = await loadDeliveryLedger()
    expect(state.settlements[0].credits).toBe(0)
    // 锚点没推进，台账恢复后还能补上这段消耗
    expect(state.deliveries[0].settledCredits).toBeUndefined()
  })

  it('关机几天后 settleNow 逐日补齐，每天各一份 CSV', async () => {
    // 8/1 交付；把「今天」固定成 8/5，则 8/1-8/4 都该被补齐
    await recordDownstreamDelivery(makeDelivery())
    vi.useFakeTimers()
    vi.setSystemTime(new Date(at('2026-08-05', 9)))
    try {
      const manager = makeManager({ usage: usageOf({ 'acc-1': 400 }) })
      await manager.settleNow()

      const files = (await fs.readdir(defaultCsvDir())).sort()
      expect(files).toEqual([
        downstreamCsvFileName('2026-08-01'),
        downstreamCsvFileName('2026-08-02'),
        downstreamCsvFileName('2026-08-03'),
        downstreamCsvFileName('2026-08-04')
      ])

      const state = await loadDeliveryLedger()
      expect(state.lastSettledDate).toBe('2026-08-04')
      // 那 400 积分记在最早那个未结算日，其余日子归 0，总数不重复计
      const total = state.settlements.reduce((sum, item) => sum + item.credits, 0)
      expect(total).toBe(400)
      expect(state.settlements.find((item) => item.date === '2026-08-01')?.credits).toBe(400)
    } finally {
      vi.useRealTimers()
    }
  })

  it('没有交付记录时不生成任何 CSV', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(at('2026-08-05', 9)))
    try {
      await makeManager({ usage: {} }).settleNow()
      // 目录都不该被建出来，更不该有一堆空文件
      await expect(fs.readdir(defaultCsvDir())).rejects.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})
