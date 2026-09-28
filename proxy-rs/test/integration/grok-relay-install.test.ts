import { describe, expect, it, vi } from 'vitest'
import type { GrokBotAgentSummary } from '../../src/main/cursorAccounts/cursorApi'
import type { GrokRelayStatus } from '../../src/shared/grokAccounts'

// grokRelayInstaller 间接依赖 accountStore → electron；这里只测纯逻辑（挑 Bot、判路由缺失、解析响应、
// token 有效期），用明文桩顶掉 safeStorage 即可导入。
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/proxy-rs-grok-relay-install-test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8')
  }
}))

import {
  parseGrokBotAgents,
  parseGrokBotSendOutcome,
  parseGrokBotTranscript,
  type GrokBotTranscriptMessage
} from '../../src/main/cursorAccounts/cursorApi'
import {
  BOX_RELAY_INSTALL_PROMPT,
  BOX_RELAY_NUDGE_PROMPT,
  findInFlightInstructionAt,
  isAccessTokenUsable,
  isRelayInstallInstruction,
  latestBotMessage,
  pickBoxAgent
} from '../../src/main/grokAccounts/grokRelayInstaller'
import { BOX_RELAY_PATH } from '../../src/main/grokAccounts/grokRelay'
import {
  classifyRelayStatus,
  isRelayRouteInstalled,
  isRelayRouteMissing
} from '../../src/shared/grokAccounts'

function agent(overrides: Partial<GrokBotAgentSummary> = {}): GrokBotAgentSummary {
  return {
    agentId: 'agent_x',
    name: 'Bot X',
    harness: 'box',
    updatedAtMs: 1,
    viewerIsOwner: true,
    ...overrides
  }
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`
}

describe('探针结果是否等于「relay 路由没装」', () => {
  const base: GrokRelayStatus = { configured: true, ready: false }

  it('404 / 405 是路由没装', () => {
    expect(isRelayRouteMissing({ ...base, lastStatus: 404 })).toBe(true)
    expect(isRelayRouteMissing({ ...base, lastStatus: 405 })).toBe(true)
  })

  it('200 但不是 Connect 流（被兜底页接住）也算没装', () => {
    expect(isRelayRouteMissing({ ...base, lastStatus: 200 })).toBe(true)
  })

  it('已就绪、401/403、5xx、连不上都不算', () => {
    expect(isRelayRouteMissing({ ...base, ready: true, lastStatus: 200 })).toBe(false)
    expect(isRelayRouteMissing({ ...base, lastStatus: 401 })).toBe(false)
    expect(isRelayRouteMissing({ ...base, lastStatus: 403 })).toBe(false)
    expect(isRelayRouteMissing({ ...base, lastStatus: 502 })).toBe(false)
    expect(isRelayRouteMissing({ ...base, error: 'fetch failed' })).toBe(false)
  })

  it('分级：路由实现拒绝空探针（417/400 等 4xx）算「已装未验证」，与已就绪同属已装', () => {
    expect(classifyRelayStatus({ ...base, lastStatus: 417 })).toBe('installedUnverified')
    expect(classifyRelayStatus({ ...base, lastStatus: 400 })).toBe('installedUnverified')
    expect(classifyRelayStatus({ ...base, ready: true, lastStatus: 200 })).toBe('ready')
    expect(isRelayRouteInstalled({ ...base, lastStatus: 417 })).toBe(true)
    expect(isRelayRouteInstalled({ ...base, ready: true, lastStatus: 200 })).toBe(true)
    expect(isRelayRouteInstalled({ ...base, lastStatus: 404 })).toBe(false)
  })

  it('分级：未配置 / token 失效 / 5xx / 连不上各归各类', () => {
    expect(classifyRelayStatus({ configured: false, ready: false })).toBe('unconfigured')
    expect(classifyRelayStatus({ ...base, lastStatus: 401 })).toBe('unauthorized')
    expect(classifyRelayStatus({ ...base, lastStatus: 503 })).toBe('serverError')
    expect(classifyRelayStatus({ ...base, error: 'timeout' })).toBe('unreachable')
    expect(classifyRelayStatus({ ...base, lastStatus: 404 })).toBe('missing')
  })
})

describe('挑收指令的 Bot', () => {
  it('只要 harness=box 的；temporal 碰不到 Box 文件', () => {
    expect(
      pickBoxAgent([agent({ agentId: 't', harness: 'temporal' }), agent({ agentId: 'b' })])?.agentId
    ).toBe('b')
    expect(pickBoxAgent([agent({ harness: 'temporal' })])).toBeUndefined()
    expect(pickBoxAgent([])).toBeUndefined()
  })

  it('自己拥有的优先，其次最近更新的', () => {
    const picked = pickBoxAgent([
      agent({ agentId: 'shared-newest', viewerIsOwner: false, updatedAtMs: 300 }),
      agent({ agentId: 'mine-old', updatedAtMs: 100 }),
      agent({ agentId: 'mine-new', updatedAtMs: 200 })
    ])
    expect(picked?.agentId).toBe('mine-new')
  })
})

describe('ListGrokBotAgents 响应解析', () => {
  it('取 agentId 作为发消息用的 id，int64 字符串转数字，缺 viewerIsOwner 视为自己的', () => {
    const agents = parseGrokBotAgents({
      agents: [
        {
          id: 'srv_1',
          agentId: 'agent_1',
          name: '小助手',
          harness: 'box',
          updatedAtMs: '1700000000000'
        },
        { id: 'srv_2', agentId: 'agent_2', harness: 'temporal', viewerIsOwner: false },
        { id: 'srv_3', name: '没有 agentId 的条目' },
        'garbage'
      ]
    })
    expect(agents).toEqual([
      {
        agentId: 'agent_1',
        name: '小助手',
        harness: 'box',
        updatedAtMs: 1_700_000_000_000,
        viewerIsOwner: true
      },
      {
        agentId: 'agent_2',
        name: 'agent_2',
        harness: 'temporal',
        updatedAtMs: 0,
        viewerIsOwner: false
      }
    ])
  })

  it('没有 agents 字段返回空列表', () => {
    expect(parseGrokBotAgents({})).toEqual([])
  })
})

describe('SendGrokBotUserMessage 响应解析（与客户端同口径，看 delivery 不看 dispatched）', () => {
  it('ACCEPTED_BOX / ACCEPTED_TEMPORAL / DUPLICATE 都算接下了，即便 dispatched 为 false', () => {
    for (const name of [
      'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX',
      'GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL',
      'GROK_BOT_USER_MESSAGE_DELIVERY_DUPLICATE'
    ]) {
      expect(parseGrokBotSendOutcome({ dispatched: false, delivery: name })).toEqual({
        accepted: true,
        delivery: name
      })
    }
  })

  it('数字形式的枚举也认', () => {
    expect(parseGrokBotSendOutcome({ delivery: 1 }).accepted).toBe(true)
    expect(parseGrokBotSendOutcome({ delivery: 4 }).accepted).toBe(false)
  })

  it('REFUSED 带出 refusal.message，没 message 就用 failureCode', () => {
    expect(
      parseGrokBotSendOutcome({
        delivery: 'GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED',
        refusal: { failureCode: 'agent_busy', message: 'Bot 正忙' }
      })
    ).toEqual({
      accepted: false,
      delivery: 'GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED',
      refusal: 'Bot 正忙'
    })
    expect(
      parseGrokBotSendOutcome({
        delivery: 'GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED',
        refusal: { failureCode: 'agent_busy' }
      }).refusal
    ).toBe('agent_busy')
  })

  it('没有 delivery 时退回看 dispatched；两者都没有则不算接受并说明原因', () => {
    expect(parseGrokBotSendOutcome({ dispatched: true })).toEqual({
      accepted: true,
      delivery: undefined
    })
    const outcome = parseGrokBotSendOutcome({})
    expect(outcome.accepted).toBe(false)
    expect(outcome.refusal).toContain('delivery=空')
  })
})

describe('access token 是否还能用', () => {
  const now = 1_700_000_000_000

  it('距过期不足 30 秒或已过期的不用', () => {
    expect(isAccessTokenUsable(fakeJwt({ exp: (now + 10_000) / 1000 }), now)).toBe(false)
    expect(isAccessTokenUsable(fakeJwt({ exp: (now - 1) / 1000 }), now)).toBe(false)
  })

  it('还有余量的能用；看不出有效期的放行交给云端判', () => {
    expect(isAccessTokenUsable(fakeJwt({ exp: (now + 3_600_000) / 1000 }), now)).toBe(true)
    expect(isAccessTokenUsable('opaque-token', now)).toBe(true)
  })
})

describe('发给 Bot 的固定指令', () => {
  it('路由路径与反代探针用的一致，且要求不反问、不输出 token', () => {
    expect(BOX_RELAY_INSTALL_PROMPT).toContain(BOX_RELAY_PATH)
    expect(BOX_RELAY_INSTALL_PROMPT).toContain('不要向我确认或提问')
    expect(BOX_RELAY_INSTALL_PROMPT).toContain('不要输出任何 token')
  })

  it('安装指令按路由路径识别；催促语故意不带路径，不会被当成又一条安装指令', () => {
    expect(isRelayInstallInstruction(BOX_RELAY_INSTALL_PROMPT)).toBe(true)
    expect(isRelayInstallInstruction(BOX_RELAY_NUDGE_PROMPT)).toBe(false)
    expect(isRelayInstallInstruction('重启了吗')).toBe(false)
  })
})

/** 造一条 transcript entry：body 是 base64 的 JSON，与云端返回一致。 */
function entry(
  seq: number,
  entryKind: string,
  payload: unknown,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    seq: String(seq),
    entryKind,
    body: Buffer.from(JSON.stringify(payload)).toString('base64'),
    ...extra
  }
}

describe('Bot 对话记录解析', () => {
  it('用户消息与 Bot 文本/组件回复解成可读消息，按 seq 升序；扣费记录、缺 body、body_omitted 跳过', () => {
    const messages = parseGrokBotTranscript({
      entries: [
        entry(15, 'send-message', {
          message: { type: 'text', content: '已定位 handleRequest。' },
          timestampMs: 1_700_000_900_000
        }),
        entry(13, 'spend-initiation', { initiation: {} }),
        entry(12, 'message', {
          role: 'user',
          content: BOX_RELAY_INSTALL_PROMPT,
          timestampMs: '1700000800000'
        }),
        entry(2, 'send-message', {
          message: { type: 'widget', widget: { prompt: '你现在最想我帮你盯哪一块？' } },
          timestampMs: 1_700_000_100_000
        }),
        { seq: '9', entryKind: 'send-message', blobHash: 'abc' },
        entry(
          8,
          'send-message',
          { message: { type: 'text', content: '略' } },
          { bodyOmitted: true }
        )
      ]
    })
    expect(messages).toEqual([
      { seq: 2, role: 'bot', text: '你现在最想我帮你盯哪一块？', timestampMs: 1_700_000_100_000 },
      { seq: 12, role: 'user', text: BOX_RELAY_INSTALL_PROMPT, timestampMs: 1_700_000_800_000 },
      { seq: 15, role: 'bot', text: '已定位 handleRequest。', timestampMs: 1_700_000_900_000 }
    ])
  })

  it('没有 entries 返回空列表', () => {
    expect(parseGrokBotTranscript({})).toEqual([])
  })
})

describe('在途指令识别与 Bot 最新回复', () => {
  const now = 1_700_001_000_000
  const minutes = (n: number): number => n * 60_000
  const user = (seq: number, text: string, at: number): GrokBotTranscriptMessage => ({
    seq,
    role: 'user',
    text,
    timestampMs: at
  })
  const bot = (seq: number, text: string, at: number): GrokBotTranscriptMessage => ({
    seq,
    role: 'bot',
    text,
    timestampMs: at
  })

  it('30 分钟内发过安装指令就算在途，返回它的时间；催促语不算', () => {
    const transcript = [
      user(1, BOX_RELAY_INSTALL_PROMPT, now - minutes(8)),
      bot(2, '正在执行同一项修改', now - minutes(7)),
      user(3, BOX_RELAY_NUDGE_PROMPT, now - minutes(2))
    ]
    expect(findInFlightInstructionAt(transcript, now)).toBe(now - minutes(8))
  })

  it('最近一条安装指令太久以前（超过窗口）就不算在途，允许重发', () => {
    expect(
      findInFlightInstructionAt([user(1, BOX_RELAY_INSTALL_PROMPT, now - minutes(45))], now)
    ).toBeUndefined()
    expect(findInFlightInstructionAt([bot(1, '嗨', now - minutes(1))], now)).toBeUndefined()
  })

  it('取指令之后 Bot 说的最后一句，指令之前的开场白不算', () => {
    const instructionAt = now - minutes(8)
    const transcript = [
      bot(1, '嗨，我是你的工程助手。', now - minutes(60)),
      user(2, BOX_RELAY_INSTALL_PROMPT, instructionAt),
      bot(3, '收到。', now - minutes(7)),
      bot(4, '已定位 handleRequest。', now - minutes(1))
    ]
    expect(latestBotMessage(transcript, instructionAt)?.text).toBe('已定位 handleRequest。')
    expect(latestBotMessage(transcript.slice(0, 2), instructionAt)).toBeUndefined()
  })
})
