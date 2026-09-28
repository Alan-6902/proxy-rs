/**
 * 给某个号的 Box 装 relay 路由，替代在 Grok Bot 聊天框里手敲那段指令。
 *
 * 背景：本机反代打的是 Box 网关上的 `BOX_RELAY_PATH`，但这条路由不是 Box 自带的，要让跑在 Box 里的 Bot
 * 给 sand-host 打补丁才有。一个号一个 Box，所以每个新号（以及 Box 被云端重建/升级后）都得来一次。
 *
 * 做法不碰 Grok 客户端：客户端聊天框发出去的消息本来就是 Cursor 云端 GrokBotService 的
 * SendGrokBotUserMessage，用该号自己的 session token 就能调。流程 = 探针确认路由确实没装 → 找到该号
 * 跑在 Box 里的 Bot → 读它的对话记录：这条指令已经在处理就不重发，否则发 → 轮询探针直到路由真的通。
 * 成败只看探针；对话记录只用来判断是否在途、把 Bot 最新一句话显示出来，以及在它长时间沉默时催一下
 * （人工操作时也是这么「重启了吗」催出来的）。
 */

import { randomUUID } from 'node:crypto'
import {
  extractAccessTokenExpiresAt,
  listGrokBotAgents,
  listGrokBotTranscript,
  sendGrokBotUserMessage,
  type GrokBotAgentSummary,
  type GrokBotTranscriptMessage
} from '../cursorAccounts/cursorApi'
import { loadCursorAccounts } from '../cursorAccounts/accountStore'
import type {
  GrokRelayInstallProgress,
  GrokRelayInstallResult,
  GrokRelayStatus
} from '../../shared/grokAccounts'
import {
  classifyRelayStatus,
  isRelayRouteInstalled,
  isRelayRouteMissing
} from '../../shared/grokAccounts'
import { indexCursorAccountsByScope } from './grokAccountManager'
import { deriveGrokOsCryptKey, readGrokAccounts, readGrokKeychainPassword } from './grokLocalState'
import { BOX_RELAY_PATH, probeBoxRelay } from './grokRelay'

/** Bot 跑在该号 Box 里时的 harness 值；temporal 是云端工作流，碰不到 Box 的文件。 */
const BOX_HARNESS = 'box'
/** 两次探针之间的间隔：Bot 改文件、重启 sand host 都要时间，探太密没意义。 */
const INSTALL_POLL_INTERVAL_MS = 10_000
/** 每隔几次探针刷一次对话记录，把 Bot 最新一句话带给界面。 */
const TRANSCRIPT_REFRESH_EVERY_N_POLLS = 3
/** 一次安装最多等这么久。实测这类 Bot 慢的时候要十几分钟，5 分钟会误报超时。 */
const INSTALL_TIMEOUT_MS = 15 * 60_000
/** 对话里这么久以内发过同一条指令就视为在途，不再重发——重发只会让 Bot 反复「核对进度」，还多扣额度。 */
const PROMPT_IN_FLIGHT_WINDOW_MS = 30 * 60_000
/** Bot 沉默超过这么久且路由仍没通，就催一句；人工操作时也是靠「重启了吗」催出来的。 */
const NUDGE_AFTER_SILENCE_MS = 4 * 60_000
/** 一次安装最多催几次，避免 Bot 卡死时无限刷屏。 */
const MAX_NUDGES = 2
/** 读多少条对话记录足够覆盖「最近一次指令 + 之后的回复」。 */
const TRANSCRIPT_LIMIT = 30
/** 界面上 Bot 最新一句话最多显示这么长。 */
const BOT_MESSAGE_EXCERPT_LENGTH = 80
/** access token 至少还要活这么久才拿去调云端，免得请求半路失效。 */
const ACCESS_TOKEN_MIN_REMAINING_MS = 30_000

/**
 * 发给 Bot 的固定指令，与手动在 Grok 里输入的内容一致，多加了「不要反问、改完自检」，避免它像人聊天
 * 那样先问一句再动手。
 */
export const BOX_RELAY_INSTALL_PROMPT =
  `备份 /home/box/sand-host/host-main.cjs，然后在现有受鉴权 gateway 的 handleRequest 中加入 POST 路由 ` +
  `${BOX_RELAY_PATH}：复用现有 isAuthorized 和 gateway 鉴权；把 Connect 请求流原样转发到后端 ` +
  `InferenceService.Stream，移除客户端带来的 Authorization，改用 Box 内现有的 Grok Bot token provider 写入 ` +
  `Bearer；保留响应流、背压和中止处理。改完立刻重启 sand host（supervisor 忙就强制拉起），并自检：` +
  `无鉴权请求该路由应返回 401。不要向我确认或提问，直接执行；全程不要输出任何 token。`

/** Bot 沉默太久时的催促语。故意不带路由路径，免得被当成又一条安装指令。 */
export const BOX_RELAY_NUDGE_PROMPT =
  '探针显示 relay 路由仍未生效（POST 该路径返回 404）。请继续把改动收尾：保存后立刻重启 sand host' +
  '（supervisor 忙就强制拉起），用无鉴权请求自检返回 401，然后只回复结果。不要重新开工，不要输出任何 token。'

export type RelayInstallProgressSink = (progress: GrokRelayInstallProgress) => void

/** 正在装的 scope，避免界面重复点或自动触发叠加，给同一个 Bot 发两遍指令。 */
const installing = new Set<string>()

/**
 * 从「能跑在 Box 里的 Bot」里挑一个收指令：只看 harness=box，自己拥有的优先，再按最近更新排。
 * 一个号的 Box 只有一个，里面任何一个 Bot 都能改到 sand-host，所以选谁都行，选最近活跃的最稳。
 */
export function pickBoxAgent(agents: GrokBotAgentSummary[]): GrokBotAgentSummary | undefined {
  return agents
    .filter((agent) => agent.harness === BOX_HARNESS)
    .sort((a, b) => {
      if (a.viewerIsOwner !== b.viewerIsOwner) return a.viewerIsOwner ? -1 : 1
      return b.updatedAtMs - a.updatedAtMs
    })[0]
}

/** 一条用户消息是不是「装 relay 路由」的指令：认路由路径，措辞以后改了也照样能对上。 */
export function isRelayInstallInstruction(text: string): boolean {
  return text.includes(BOX_RELAY_PATH)
}

/**
 * 对话里最近一条装路由的指令；只算 window 以内的，太久以前的那次不管成败都当过期，允许重发。
 * 返回它的时间戳，没有则 undefined。
 */
export function findInFlightInstructionAt(
  transcript: GrokBotTranscriptMessage[],
  now = Date.now(),
  windowMs = PROMPT_IN_FLIGHT_WINDOW_MS
): number | undefined {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i]
    if (message.role !== 'user' || !isRelayInstallInstruction(message.text)) continue
    if (message.timestampMs !== undefined && now - message.timestampMs <= windowMs) {
      return message.timestampMs
    }
    return undefined
  }
  return undefined
}

/** Bot 在 sinceMs 之后说的最后一句话，供界面展示与判断它是否沉默。 */
export function latestBotMessage(
  transcript: GrokBotTranscriptMessage[],
  sinceMs: number
): GrokBotTranscriptMessage | undefined {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i]
    if (message.role === 'bot' && (message.timestampMs ?? 0) >= sinceMs) return message
  }
  return undefined
}

function excerpt(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > BOT_MESSAGE_EXCERPT_LENGTH
    ? `${single.slice(0, BOT_MESSAGE_EXCERPT_LENGTH)}…`
    : single
}

/** access token 还够用（非 JWT 的看不出有效期，也放行让云端判）。 */
export function isAccessTokenUsable(accessToken: string, now = Date.now()): boolean {
  const expiresAt = extractAccessTokenExpiresAt(accessToken)
  return expiresAt === undefined || expiresAt > now + ACCESS_TOKEN_MIN_REMAINING_MS
}

/**
 * 找这个号还没过期的 access token：Grok 账号库里的那份优先（客户端自己会续），其次 Cursor 账号库。
 * 两边都过期就不硬刷——在这里换 token 会让 refresh token 轮换，把 Grok 或账号库里的那份作废。
 */
async function resolveAccessToken(scope: string): Promise<string> {
  const candidates: string[] = []
  const grokAccount = (await readGrokAccounts()).find((account) => account.scope === scope)
  if (grokAccount?.accessToken) candidates.push(grokAccount.accessToken)
  try {
    const cursorAccount = indexCursorAccountsByScope(await loadCursorAccounts()).get(scope)
    if (cursorAccount?.accessToken) candidates.push(cursorAccount.accessToken)
  } catch {
    // 账号库读不到就只用 Grok 里的那份
  }
  const usable = candidates.find((token) => isAccessTokenUsable(token))
  if (!usable) {
    throw new Error(
      candidates.length === 0
        ? 'Grok 客户端和 Cursor 账号库里都没有这个号的 token'
        : '这个号的 access token 已过期：到「Cursor 账号」页刷新一下它，或在 Grok 里重新登录后再试'
    )
  }
  return usable
}

/** 探针既不是「路由在」也不是「路由没装」时的解释，直接给用户看。 */
function describeUnexpectedProbe(status: GrokRelayStatus): string {
  switch (classifyRelayStatus(status)) {
    case 'unauthorized':
      return 'Box 网关拒绝了本机保存的连接 token，去 Grok Bot 里重新打开一次这个号的 Bot 再试'
    case 'unreachable':
      return `连不上这个号的 Box 网关：${status.error ?? '未知错误'}`
    default:
      return `Box 网关返回了 ${status.lastStatus ?? '未知状态'}，Box 可能在重启或出错，稍后再试`
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 确保某个号的 Box 上有 relay 路由：已经通就直接返回；没装就让它的 Bot 去装并等到探针通过或超时。
 * 会抛错的情形：该号没建 box / box 连接过期、token 过期、找不到 Box 里的 Bot、云端拒收消息。
 */
export async function ensureBoxRelayRoute(
  scope: string,
  onProgress: RelayInstallProgressSink = () => {}
): Promise<GrokRelayInstallResult> {
  if (installing.has(scope)) throw new Error('这个号正在装 relay 路由，等它结束')
  installing.add(scope)
  const startedAt = Date.now()
  const elapsed = (): number => Date.now() - startedAt
  try {
    onProgress({ scope, phase: 'probing', message: '探测这个号 Box 上的 relay 路由…' })
    const key = deriveGrokOsCryptKey(await readGrokKeychainPassword())
    const initial = await probeBoxRelay(scope, { key })
    // 路由在就算成功——有的 Box 实现会拒绝探针的空请求（如 417），但 Cursor 的真请求照样能走
    if (isRelayRouteInstalled(initial)) {
      return { status: 'ready', scope, installed: false, elapsedMs: elapsed() }
    }
    if (!isRelayRouteMissing(initial)) throw new Error(describeUnexpectedProbe(initial))

    onProgress({ scope, phase: 'resolvingAgent', message: '查找这个号跑在 Box 里的 Bot…' })
    const accessToken = await resolveAccessToken(scope)
    const agent = pickBoxAgent(await listGrokBotAgents(accessToken))
    if (!agent) {
      throw new Error('这个号还没有跑在 Box 里的 Bot，先在 Grok Bot 里新建一个再装路由')
    }

    const send = async (text: string, what: string): Promise<void> => {
      const outcome = await sendGrokBotUserMessage(accessToken, {
        agentId: agent.agentId,
        messageId: randomUUID(),
        text
      })
      if (!outcome.accepted) {
        throw new Error(
          `Bot「${agent.name}」没有接下${what}${outcome.refusal ? `：${outcome.refusal}` : ''}`
        )
      }
      console.log(
        `[GrokRelayInstall] ${what}已发给 ${agent.name}（${outcome.delivery ?? 'dispatched'}）`
      )
    }
    const readTranscript = (): Promise<GrokBotTranscriptMessage[]> =>
      listGrokBotTranscript(accessToken, { agentId: agent.agentId, limit: TRANSCRIPT_LIMIT })

    // 先看对话：同一条指令最近已经发过、Bot 正在做，就别再发一遍打断它
    let transcript = await readTranscript()
    let instructionAt = findInFlightInstructionAt(transcript)
    if (instructionAt === undefined) {
      onProgress({ scope, phase: 'sending', message: `给 Bot「${agent.name}」发送安装指令…` })
      await send(BOX_RELAY_INSTALL_PROMPT, '这条指令')
      instructionAt = Date.now()
    } else {
      const minutesAgo = Math.max(1, Math.round((Date.now() - instructionAt) / 60_000))
      onProgress({
        scope,
        phase: 'waiting',
        message: `Bot「${agent.name}」${minutesAgo} 分钟前已收到这条指令、还在处理，不重复发送，等它完成…`
      })
    }
    // Bot 最近说的话：给界面看，也用来判断它是否沉默
    let lastBot = latestBotMessage(transcript, instructionAt)
    let lastActivityAt = Math.max(instructionAt, lastBot?.timestampMs ?? 0)
    let nudges = 0

    let attempt = 0
    let last = initial
    while (elapsed() < INSTALL_TIMEOUT_MS) {
      await sleep(INSTALL_POLL_INTERVAL_MS)
      attempt += 1
      // 重启 sand host 期间网关会短暂连不上，这是预期中的，继续等
      last = await probeBoxRelay(scope, { key })
      if (isRelayRouteInstalled(last)) {
        return {
          status: 'ready',
          scope,
          installed: true,
          agentName: agent.name,
          elapsedMs: elapsed()
        }
      }
      if (attempt % TRANSCRIPT_REFRESH_EVERY_N_POLLS === 0) {
        try {
          transcript = await readTranscript()
          lastBot = latestBotMessage(transcript, instructionAt)
          lastActivityAt = Math.max(lastActivityAt, lastBot?.timestampMs ?? 0)
        } catch (error) {
          console.warn(
            `[GrokRelayInstall] 读对话记录失败，继续等: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      // Bot 半天没动静，像人工那样催一句；催过也算一次活动，别连着催
      if (nudges < MAX_NUDGES && Date.now() - lastActivityAt > NUDGE_AFTER_SILENCE_MS) {
        nudges += 1
        onProgress({
          scope,
          phase: 'sending',
          message: `Bot「${agent.name}」沉默了一会儿，催它收尾（第 ${nudges} 次）…`
        })
        await send(BOX_RELAY_NUDGE_PROMPT, '催促')
        lastActivityAt = Date.now()
      }
      onProgress({
        scope,
        phase: 'waiting',
        message:
          `等 Bot「${agent.name}」改完并重启 sand host（第 ${attempt} 次探测）` +
          (lastBot ? ` · Bot：${excerpt(lastBot.text)}` : '…')
      })
    }
    return {
      status: 'timeout',
      scope,
      agentName: agent.name,
      elapsedMs: elapsed(),
      lastStatus: last.lastStatus,
      lastBotMessage: lastBot ? excerpt(lastBot.text) : undefined
    }
  } finally {
    installing.delete(scope)
  }
}
