/**
 * 下游对账的结算调度。
 *
 * 每 DOWNSTREAM_SETTLEMENT_TICK_MINUTES 分钟检查一次有没有未结算的过去日期，
 * 有就逐日补齐：写当天的 CSV、落定稿记录、推进积分锚点。
 *
 * 为什么是 tick + 补齐，不是午夜定时：
 * - 定时到 00:00 那套要处理系统睡眠、时区变更、夏令时，脆且难验证；
 * - 桌面应用可能整天没开。tick 天然覆盖「关机三天再打开」——一次补三天，
 *   每天各自一份 CSV 与定稿记录，积分区间起止如实反映那段跨度。
 *
 * 结算与导出是两个操作，刻意分开：
 * - `exportDay` 纯读，算行集写 CSV，不动锚点。给「立即导出当天」用。
 * - `settleDay` 先导出再推进锚点。只在日结算时调。
 * 手动导出当天如果推进了锚点，当天余下时间产生的积分就被算进「已结算」，
 * 日增量会缺一块。
 */

import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  DOWNSTREAM_CSV_DIR_NAME,
  DOWNSTREAM_REPORT_WINDOW_DAYS,
  DOWNSTREAM_SETTLEMENT_TICK_MINUTES,
  buildDownstreamCsv,
  computeDownstreamSettlement,
  downstreamCsvFileName,
  downstreamDateKeyToStart,
  downstreamDayStart,
  summarizeDownstreamDaily,
  summarizeDownstreamDay,
  type DownstreamCsvRow,
  type DownstreamLedgerUsage,
  type DownstreamReport
} from '../../shared/downstreamSettlement'
import { hunterLocalDateKey } from '../../shared/kskHunter'
import {
  commitDownstreamSettlement,
  loadDeliveryLedger,
  type DeliveryLedgerState
} from './deliveryLedgerStore'

export interface DownstreamSettlementDeps {
  /** 读 CSV 导出目录（抢号配置里的 csvExportDir）；未配置时返回 undefined 走默认目录。 */
  readCsvDir: () => Promise<string | undefined>
  /** 默认导出目录的父目录，正常是 app.getPath('userData')。 */
  userDataDir: () => string
  /** 台账当前消耗，按账号 id 索引。台账读不到时返回空对象（不是抛错）。 */
  readLedgerUsage: () => Promise<Record<string, DownstreamLedgerUsage>>
  /** 分组 id → 名字，供报表展示分组名。 */
  readGroupNames?: () => Promise<Record<string, string>>
  log?: (message: string) => void
}

export class DownstreamSettlementManager {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private tickPromise: Promise<void> | null = null

  constructor(private readonly deps: DownstreamSettlementDeps) {}

  async start(): Promise<void> {
    this.stopped = false
    // 启动后稍等再跑第一轮：让 store 与台账就绪，也避免和抢号启动挤在同一刻
    this.scheduleNext(20_000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runTick()
    }, delayMs)
  }

  /** 并发调用合并到同一次执行，避免手动触发撞上定时 tick 重复结算。 */
  private runTick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise
    this.tickPromise = this.executeTick().finally(() => {
      this.tickPromise = null
    })
    return this.tickPromise
  }

  /** 立刻跑一轮结算补齐，供页面手动触发。 */
  async settleNow(): Promise<void> {
    await this.runTick()
  }

  private async executeTick(): Promise<void> {
    try {
      const state = await loadDeliveryLedger()
      const pending = this.pendingDates(state)
      for (const date of pending) await this.settleDay(date)
      if (pending.length > 0) {
        this.log(`已结算 ${pending.length} 天：${pending.join('、')}`)
      }
    } catch (error) {
      this.log(`结算失败：${this.message(error)}`)
    } finally {
      this.scheduleNext(DOWNSTREAM_SETTLEMENT_TICK_MINUTES * 60_000)
    }
  }

  /**
   * 待结算的日期列表，从早到晚。
   *
   * 只结算**已经过去**的自然日：当天还在产生交付与消耗，定稿了数字就不再变，
   * 会漏掉当天剩下的部分。
   *
   * 起点取「最后一次结算的次日」与「最早一条交付」的较晚者。没有交付记录时
   * 返回空——没号可对账，不必凭空生成一堆空 CSV。
   */
  private pendingDates(state: DeliveryLedgerState): string[] {
    if (state.deliveries.length === 0) return []
    const todayStart = downstreamDayStart(Date.now())
    const earliest = Math.min(...state.deliveries.map((item) => item.deliveredAt))

    let cursor = downstreamDayStart(earliest)
    if (state.lastSettledDate) {
      const lastStart = downstreamDateKeyToStart(state.lastSettledDate)
      if (lastStart !== undefined) {
        const next = new Date(lastStart)
        next.setDate(next.getDate() + 1)
        cursor = Math.max(cursor, next.getTime())
      }
    }

    const dates: string[] = []
    // 上限兜底：账本被改坏出现 1970 年的交付时刻时，别在这里跑几万轮
    const maxDays = 400
    while (cursor < todayStart && dates.length < maxDays) {
      dates.push(hunterLocalDateKey(cursor))
      const next = new Date(cursor)
      next.setDate(next.getDate() + 1)
      cursor = next.getTime()
    }
    // 超出上限说明历史缺口过大，跳到最近 maxDays 天，避免无限积压
    if (dates.length >= maxDays) {
      this.log(`未结算的历史超过 ${maxDays} 天，只补最近 ${maxDays} 天`)
    }
    return dates
  }

  /** CSV 导出目录。用户配了就用配的（必须是绝对路径），否则落 userData 下的子目录。 */
  async resolveCsvDir(): Promise<string> {
    const configured = (await this.deps.readCsvDir())?.trim()
    // 相对路径的解释基准取决于进程 cwd，打包后不可预测，一律按未配置处理
    if (configured && isAbsolute(configured)) return configured
    return join(this.deps.userDataDir(), DOWNSTREAM_CSV_DIR_NAME)
  }

  /**
   * 导出某一天的 CSV，返回文件路径。
   *
   * 纯读，不动锚点。覆盖同名文件：同一天可能先手动导一次、午夜再自动结算一次，
   * 覆盖比生成两份带后缀的文件好——对账时不用猜哪份是准的。
   */
  async exportDay(date: string): Promise<string> {
    const state = await loadDeliveryLedger()
    const usage = await this.readUsageSafely()
    const groupNames = await this.readGroupNamesSafely()
    const report = summarizeDownstreamDay({
      deliveries: state.deliveries,
      settlements: state.settlements,
      usage,
      groupNames,
      date
    })

    // 完整 key 从账本里现取：报表行刻意不带它（那个类型会过 IPC）
    const keyById = new Map(state.deliveries.map((item) => [item.id, item.key]))
    const rows: DownstreamCsvRow[] = report.rows.map((row) => ({
      ...row,
      key: keyById.get(row.id) ?? ''
    }))

    const dir = await this.resolveCsvDir()
    await fs.mkdir(dir, { recursive: true })
    const path = join(dir, downstreamCsvFileName(date))
    // 0o600：这份文件是磁盘上唯一存在完整 key 明文的地方
    await fs.writeFile(path, buildDownstreamCsv(rows, date), { encoding: 'utf-8', mode: 0o600 })
    return path
  }

  /**
   * 结算某一天：先导出 CSV，再落定稿并推进锚点。
   *
   * 顺序不能反。CSV 是长期存档，落定稿之前先把它写成功——反过来的话导出失败
   * 就再也导不出这一天了（锚点已推进，积分增量算不回来）。
   */
  async settleDay(date: string): Promise<void> {
    await this.exportDay(date)
    const state = await loadDeliveryLedger()
    const usage = await this.readUsageSafely()
    const now = Date.now()
    const computed = computeDownstreamSettlement({
      deliveries: state.deliveries,
      usage,
      date,
      at: now
    })
    await commitDownstreamSettlement({
      date,
      settlement: computed.settlement,
      deliveries: computed.deliveries,
      now
    })
  }

  /** 某一天的完整报表：日明细 + 按天汇总 + 导出目录。 */
  async report(input?: { date?: string; days?: number }): Promise<DownstreamReport> {
    const state = await loadDeliveryLedger()
    const usage = await this.readUsageSafely()
    const groupNames = await this.readGroupNamesSafely()
    const now = Date.now()
    const days = input?.days ?? DOWNSTREAM_REPORT_WINDOW_DAYS
    const day = summarizeDownstreamDay({
      deliveries: state.deliveries,
      settlements: state.settlements,
      usage,
      groupNames,
      date: input?.date,
      now
    })
    return {
      ...day,
      days,
      daily: summarizeDownstreamDaily({
        deliveries: state.deliveries,
        settlements: state.settlements,
        usage,
        days,
        now
      }),
      csvDir: await this.resolveCsvDir()
    }
  }

  /**
   * 台账读失败时按空处理。
   *
   * 空 usage 会让所有积分列显示「未知」而不是 0，且 `computeDownstreamSettlement`
   * 不会推进查不到的号的锚点——下一轮台账恢复后能补上，不会永久丢账。
   */
  private async readUsageSafely(): Promise<Record<string, DownstreamLedgerUsage>> {
    try {
      return await this.deps.readLedgerUsage()
    } catch (error) {
      this.log(`读取台账消耗失败，本轮积分按未知处理：${this.message(error)}`)
      return {}
    }
  }

  private async readGroupNamesSafely(): Promise<Record<string, string>> {
    try {
      return (await this.deps.readGroupNames?.()) ?? {}
    } catch {
      // 分组名只影响展示，查不到就显示空
      return {}
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private log(message: string): void {
    this.deps.log?.(`[DownstreamSettlement] ${message}`)
  }
}
