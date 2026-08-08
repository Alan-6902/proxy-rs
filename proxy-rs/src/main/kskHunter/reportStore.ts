/**
 * 抢号报表事件流的持久化。
 *
 * 为什么独立于 ksk-hunter.enc：
 * - 加密 store 里的 spend 只留 14 天、deliveries 只留 200 条，都会被裁掉，撑不起历史报表；
 * - 报表事件不含 KSK 明文、不含站点 token，也不含脱敏 key，没有加密的必要，
 *   明文 JSONL 反而让用户能直接拿去做别的分析；
 * - 走独立文件就不用挤加密 store 那条 mutation 队列（3 秒一轮的抢号在用）。
 *
 * 只追加、不裁剪：历史全量保留是明确需求。事件只记成果节点（放货边沿、下单、
 * 交付、验活失败、拦单），不记每轮轮询，所以一年也就万级行数。
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  HUNTER_REPORT_EVENT,
  type HunterReportEvent,
  type HunterReportEventType
} from '../../shared/hunterReport'
import { KSK_HUNTER_BUDGET_BLOCK, KSK_HUNTER_CHANNEL } from '../../shared/kskHunter'
import type { KskHunterBudgetBlock, KskHunterChannel } from '../../shared/kskHunter'

const STORE_FILE = 'ksk-hunter-report.jsonl'

let mutationQueue: Promise<void> = Promise.resolve()

export function hunterReportStorePath(): string {
  return join(app.getPath('userData'), STORE_FILE)
}

function readNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

function readType(value: unknown): HunterReportEventType | null {
  const types = Object.values(HUNTER_REPORT_EVENT) as string[]
  return typeof value === 'string' && types.includes(value)
    ? (value as HunterReportEventType)
    : null
}

function readChannel(value: unknown): KskHunterChannel | null {
  const channels = Object.values(KSK_HUNTER_CHANNEL) as string[]
  return typeof value === 'string' && channels.includes(value) ? (value as KskHunterChannel) : null
}

function readReason(value: unknown): KskHunterBudgetBlock | undefined {
  const reasons = Object.values(KSK_HUNTER_BUDGET_BLOCK) as string[]
  return typeof value === 'string' && reasons.includes(value)
    ? (value as KskHunterBudgetBlock)
    : undefined
}

/** 纯函数便于测试：认不出类型或渠道的行直接丢，宁可少一条也不要污染聚合。 */
export function normalizeHunterReportEvent(value: unknown): HunterReportEvent | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const at = readNumber(source.at)
  const type = readType(source.type)
  const channel = readChannel(source.channel)
  if (at === undefined || at <= 0 || !type || !channel) return null
  return {
    at: Math.floor(at),
    type,
    channel,
    linkId: typeof source.linkId === 'string' ? source.linkId : '',
    linkName: typeof source.linkName === 'string' ? source.linkName : '未命名链接',
    region: typeof source.region === 'string' && source.region ? source.region : undefined,
    offerCount: readNumber(source.offerCount),
    costUnit: readNumber(source.costUnit),
    costCny: readNumber(source.costCny),
    unitLabel:
      typeof source.unitLabel === 'string' && source.unitLabel ? source.unitLabel : undefined,
    reason: readReason(source.reason)
  }
}

/** 逐行解析 JSONL。单行坏掉（写盘中途断电）只丢那一行，不让整份历史读不出来。 */
export function parseHunterReportEvents(raw: string): HunterReportEvent[] {
  const events: HunterReportEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const event = normalizeHunterReportEvent(JSON.parse(trimmed))
      if (event) events.push(event)
    } catch {
      continue
    }
  }
  return events.sort((a, b) => a.at - b.at)
}

export async function loadHunterReportEvents(): Promise<HunterReportEvent[]> {
  try {
    return parseHunterReportEvents(await fs.readFile(hunterReportStorePath(), 'utf-8'))
  } catch {
    // 缺文件或整份读不出来都按空历史处理：报表是观测数据，不该阻塞抢号
    return []
  }
}

/** 追加一条事件。写操作串行化，避免并行下单时两条记录交错写坏同一行。 */
export async function appendHunterReportEvent(event: HunterReportEvent): Promise<void> {
  let resolveResult: () => void
  let rejectResult: (reason?: unknown) => void
  const result = new Promise<void>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  mutationQueue = mutationQueue
    .then(async () => {
      const path = hunterReportStorePath()
      await fs.mkdir(dirname(path), { recursive: true })
      await fs.appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 })
      resolveResult()
    })
    .catch((error) => {
      rejectResult(error)
    })
  return result
}
