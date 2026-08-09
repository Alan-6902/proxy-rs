import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { mailer, createTransport } = vi.hoisted(() => {
  const mailer = { sendMail: vi.fn(), close: vi.fn() }
  return { mailer, createTransport: vi.fn(() => mailer) }
})

vi.mock('nodemailer', () => ({ default: { createTransport } }))
import {
  DEFAULT_KSK_AUTOMATION_CONFIG,
  KSK_AUTOMATION_LOG_LIMIT,
  KSK_AUTOMATION_STATE,
  KSK_AUTOMATION_STORE_VERSION,
  KSK_AUTOMATION_TASK_TYPE,
  KSK_LIVENESS_PROBE_MESSAGE,
  parseKskProviderResponse,
  providerUrlHint
} from '../../src/shared/kskAutomation'
import {
  deleteLocalAdminCredentialsByKey,
  pushAccountToLocalAdmin,
  resolveLocalAdminApiBase,
  syncKskAccountsToLocalAdmin,
  type KskAutomationFetch
} from '../../src/main/kskAutomation/localAdminClient'
import {
  resolveLocalAdminCredentialPayload,
  type LocalAdminPushResult
} from '../../src/shared/localAdminPush'
import {
  KSK_CLEANUP_FALLBACK_MODEL,
  KSK_PROBE_VERDICT,
  classifyKskProbeError,
  KSK_CREDENTIAL_VALIDATION_CONCURRENCY,
  mapWithConcurrency,
  pickCheapestModelId,
  removeMatchingInvalidKskAccounts,
  resolveKskLivenessMessage
} from '../../src/main/kskAutomation/credentialCleanup'
import { KiroUpstreamError, type KiroModel } from '../../src/main/proxy/kiroApi'
import { KskAutomationManager } from '../../src/main/kskAutomation/syncManager'
import {
  normalizeKskAutomationStorePayload,
  type PersistedKskAutomationStore,
  type PersistedKskAutomationTask
} from '../../src/main/kskAutomation/configStore'
import { sendKskAddedEmail, type KskEmailConfig } from '../../src/main/kskAutomation/emailNotifier'

const KSK_ONE = 'ksk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const KSK_TWO = 'ksk_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const TASK_ID = 'task-one'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function automationTask(
  overrides: Partial<PersistedKskAutomationTask> = {}
): PersistedKskAutomationTask {
  return {
    id: TASK_ID,
    name: '自动拉取 KSK',
    type: KSK_AUTOMATION_TASK_TYPE,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    config: { ...DEFAULT_KSK_AUTOMATION_CONFIG, providerEnabled: true },
    secrets: {
      providerUrl: 'https://provider.example/get?token=secret',
      smtpPassword: '',
      localAdminApiKey: ''
    },
    ...overrides
  }
}

function managerStore(task: PersistedKskAutomationTask): PersistedKskAutomationStore {
  return { version: KSK_AUTOMATION_STORE_VERSION, tasks: [task] }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('KSK Provider 响应解析', () => {
  it('配置视图只显示 URL 与 token 尾号，不回传完整密钥', () => {
    const hint = providerUrlHint('https://provider.example/get?token=top_secret_1234')
    expect(hint).toContain('https://provider.example/get')
    expect(hint).toContain('••••1234')
    expect(hint).not.toContain('top_secret')
  })

  it.each([
    {
      name: '优先使用 aws_region',
      account: { key: KSK_ONE, zone: 'eu', aws_region: 'us-east-1', status: 'active' },
      expectedRegion: 'us-east-1'
    },
    {
      name: 'aws_region 缺失时按 zone 映射',
      account: { key: KSK_ONE, zone: 'eu', status: 'active' },
      expectedRegion: 'eu-central-1'
    }
  ])('$name', ({ account, expectedRegion }) => {
    const result = parseKskProviderResponse({
      code: 0,
      msg: 'ok',
      data: [{ claimId: 88, account }]
    })
    expect(result.credentials).toEqual([{ key: KSK_ONE, region: expectedRegion, claimId: '88' }])
    expect(result.rejectedCount).toBe(0)
  })

  it('过滤 inactive、非法 key、未知区域和响应内重复项', () => {
    const result = parseKskProviderResponse({
      code: 0,
      data: [
        { account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } },
        { account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } },
        { account: { key: KSK_TWO, aws_region: 'us-east-1', status: 'inactive' } },
        { account: { key: 'bad', aws_region: 'us-east-1', status: 'active' } },
        { account: { key: KSK_TWO, zone: 'unknown', status: 'active' } }
      ]
    })
    expect(result.credentials).toHaveLength(1)
    expect(result.rejectedCount).toBe(4)
  })

  it('上游 code 非 0 时拒绝把 data 当成新凭据', () => {
    expect(() => parseKskProviderResponse({ code: 7, msg: 'blocked', data: [] })).toThrow('blocked')
  })
})

describe('本机 Admin 地址与同步验活', () => {
  it.each([
    ['http://127.0.0.1:12888/admin', 'http://127.0.0.1:12888/api/admin'],
    ['http://localhost:12888/api/admin/', 'http://localhost:12888/api/admin'],
    ['https://internal.example.com/admin', 'https://internal.example.com/api/admin']
  ])('把 %s 归一化为 %s', (input, expected) => {
    expect(resolveLocalAdminApiBase(input)).toBe(expected)
  })

  it('拒绝向非 loopback 的明文 HTTP 发送 Admin API Key', () => {
    expect(() => resolveLocalAdminApiBase('http://10.0.0.8:12888/admin')).toThrow('HTTPS')
  })

  it('只补齐缺失 KSK，并在创建后调用 balance 验活', async () => {
    const existingHash = createHash('sha256').update(KSK_ONE).digest('hex')
    const requests: Array<{ url: string; method: string; body?: unknown }> = []
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      requests.push({
        url,
        method: init.method,
        body: init.body ? (JSON.parse(init.body) as unknown) : undefined
      })
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({ credentials: [{ apiKeyHash: existingHash }] })
      }
      if (url.endsWith('/credentials') && init.method === 'POST') {
        return jsonResponse({ credentialId: 42 })
      }
      if (url.endsWith('/credentials/42/balance')) return jsonResponse({ currentUsage: 1 })
      return jsonResponse({}, 404)
    }

    const result = await syncKskAccountsToLocalAdmin({
      accounts: [
        { kiroApiKey: KSK_ONE, region: 'us-east-1' },
        { kiroApiKey: KSK_TWO, region: 'eu-central-1' }
      ],
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl
    })

    expect(result).toMatchObject({
      discovered: 2,
      skippedExisting: 1,
      synced: 1,
      verified: 1,
      errors: []
    })
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET http://127.0.0.1:12888/api/admin/credentials',
      'POST http://127.0.0.1:12888/api/admin/credentials',
      'GET http://127.0.0.1:12888/api/admin/credentials/42/balance'
    ])
    expect(requests[1].body).toEqual({
      authMethod: 'api_key',
      kiroApiKey: KSK_TWO,
      authRegion: 'eu-central-1',
      apiRegion: 'eu-central-1',
      priority: 0
    })
  })

  it('删除 Admin 上本地已不存在的 api_key 残留，且不碰 oauth 凭据', async () => {
    const staleHash = createHash('sha256').update(KSK_TWO).digest('hex')
    const keptHash = createHash('sha256').update(KSK_ONE).digest('hex')
    const requests: string[] = []
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      requests.push(`${init.method} ${url}`)
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({
          credentials: [
            { id: 7, apiKeyHash: keptHash, authMethod: 'api_key', maskedApiKey: 'ksk_...GusP' },
            { id: 8, apiKeyHash: staleHash, authMethod: 'api_key', maskedApiKey: 'ksk_...1DaC' },
            // oauth 凭据不在本函数输入范围内，不能因为「本地没这个 hash」就删
            { id: 9, refreshTokenHash: 'oauth-hash', authMethod: 'social' }
          ]
        })
      }
      if (url.endsWith('/credentials/8/disabled') && init.method === 'POST') {
        return jsonResponse({})
      }
      if (url.endsWith('/credentials/8') && init.method === 'DELETE') return jsonResponse({})
      return jsonResponse({}, 404)
    }

    const result = await syncKskAccountsToLocalAdmin({
      accounts: [{ kiroApiKey: KSK_ONE, region: 'us-east-1' }],
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl
    })

    expect(result).toMatchObject({
      discovered: 1,
      skippedExisting: 1,
      synced: 0,
      pruned: 1,
      prunedMaskedKeys: ['ksk_...1DaC'],
      errors: []
    })
    // Admin 只收已禁用的凭据，所以启用中的残留必须先禁用再删
    expect(requests).toEqual([
      'GET http://127.0.0.1:12888/api/admin/credentials',
      'POST http://127.0.0.1:12888/api/admin/credentials/8/disabled',
      'DELETE http://127.0.0.1:12888/api/admin/credentials/8'
    ])
  })

  it('残留凭据已禁用时直接删，不重复发禁用请求', async () => {
    const staleHash = createHash('sha256').update(KSK_TWO).digest('hex')
    const requests: string[] = []
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      requests.push(`${init.method} ${url}`)
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({
          credentials: [
            {
              id: 8,
              apiKeyHash: staleHash,
              authMethod: 'api_key',
              maskedApiKey: 'ksk_...1DaC',
              disabled: true
            }
          ]
        })
      }
      if (url.endsWith('/credentials/8') && init.method === 'DELETE') return jsonResponse({})
      return jsonResponse({}, 404)
    }

    const result = await syncKskAccountsToLocalAdmin({
      accounts: [],
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl
    })

    expect(result).toMatchObject({ pruned: 1, errors: [] })
    expect(requests).toEqual([
      'GET http://127.0.0.1:12888/api/admin/credentials',
      'DELETE http://127.0.0.1:12888/api/admin/credentials/8'
    ])
  })

  it('残留删除失败只记 error，不阻断后续新增', async () => {
    const staleHash = createHash('sha256').update(KSK_ONE).digest('hex')
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({
          credentials: [
            { id: 8, apiKeyHash: staleHash, authMethod: 'api_key', maskedApiKey: 'ksk_...1DaC' }
          ]
        })
      }
      if (url.endsWith('/credentials/8/disabled') && init.method === 'POST') {
        return jsonResponse({})
      }
      if (url.endsWith('/credentials/8') && init.method === 'DELETE') {
        return jsonResponse({ error: 'busy' }, 500)
      }
      if (url.endsWith('/credentials') && init.method === 'POST') {
        return jsonResponse({ credentialId: 42 })
      }
      if (url.endsWith('/credentials/42/balance')) return jsonResponse({ currentUsage: 1 })
      return jsonResponse({}, 404)
    }

    const result = await syncKskAccountsToLocalAdmin({
      accounts: [{ kiroApiKey: KSK_TWO, region: 'eu-central-1' }],
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl
    })

    expect(result).toMatchObject({ pruned: 0, synced: 1, verified: 1 })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('ksk_...1DaC')
  })

  it('按本地验活结论删除反代凭据：只删 hash 命中的 api_key，不碰其它凭据', async () => {
    const requests: string[] = []
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      requests.push(`${init.method} ${url}`)
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({
          credentials: [
            { id: 1, authMethod: 'api_key', apiKeyHash: sha256Hex(KSK_ONE) },
            { id: 2, authMethod: 'api_key', apiKeyHash: sha256Hex(KSK_TWO) },
            // 同一个 hash 但走 social：不是 KSK，不该动
            { id: 3, authMethod: 'social', apiKeyHash: sha256Hex(KSK_ONE) }
          ]
        })
      }
      if (url.endsWith('/credentials/1/disabled') && init.method === 'POST') {
        return jsonResponse({})
      }
      if (url.endsWith('/credentials/1') && init.method === 'DELETE') return jsonResponse({})
      return jsonResponse({}, 404)
    }

    const result = await deleteLocalAdminCredentialsByKey({
      keys: [KSK_ONE],
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl
    })

    expect(result).toEqual({ checked: 1, removed: 1, retainedTransient: 0, errors: [] })
    expect(requests).toContain('POST http://127.0.0.1:12888/api/admin/credentials/1/disabled')
    expect(requests).toContain('DELETE http://127.0.0.1:12888/api/admin/credentials/1')
    expect(requests).not.toContain('DELETE http://127.0.0.1:12888/api/admin/credentials/2')
    expect(requests).not.toContain('DELETE http://127.0.0.1:12888/api/admin/credentials/3')
    // 不再打 balance 探测：判活权全在本地
    expect(requests.some((request) => request.includes('/balance'))).toBe(false)
  })

  it('没有待删 key 时一个 Admin 请求都不发', async () => {
    const fetchImpl = vi.fn<KskAutomationFetch>()
    const result = await deleteLocalAdminCredentialsByKey({
      keys: [],
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl
    })
    expect(result).toEqual({ checked: 0, removed: 0, retainedTransient: 0, errors: [] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('删除失败只记错误，不影响同批其它凭据', async () => {
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({
          credentials: [
            { id: 1, authMethod: 'api_key', apiKeyHash: sha256Hex(KSK_ONE) },
            { id: 2, authMethod: 'api_key', apiKeyHash: sha256Hex(KSK_TWO) }
          ]
        })
      }
      if (url.endsWith('/disabled') && init.method === 'POST') return jsonResponse({})
      if (url.endsWith('/credentials/2') && init.method === 'DELETE') return jsonResponse({})
      return jsonResponse({ error: 'boom' }, 500)
    }

    const result = await deleteLocalAdminCredentialsByKey({
      keys: [KSK_ONE, KSK_TWO],
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl
    })

    expect(result).toMatchObject({ checked: 2, removed: 1 })
    expect(result.errors).toHaveLength(1)
  })

  it('验活消息留空时回落到与账号页一致的默认提示词', () => {
    expect(resolveKskLivenessMessage('')).toBe(KSK_LIVENESS_PROBE_MESSAGE)
    expect(resolveKskLivenessMessage('   ')).toBe(KSK_LIVENESS_PROBE_MESSAGE)
    expect(resolveKskLivenessMessage(undefined)).toBe(KSK_LIVENESS_PROBE_MESSAGE)
    expect(resolveKskLivenessMessage(' say hi ')).toBe('say hi')
  })

  it.each([
    [401, undefined, KSK_PROBE_VERDICT.PERMANENTLY_INVALID],
    [403, undefined, KSK_PROBE_VERDICT.PERMANENTLY_INVALID],
    [403, 'TEMPORARILY_SUSPENDED', KSK_PROBE_VERDICT.PERMANENTLY_INVALID],
    [402, 'MONTHLY_REQUEST_COUNT', KSK_PROBE_VERDICT.PERMANENTLY_INVALID],
    // 402 缺 MONTHLY_REQUEST_COUNT 时归 NONE，仍是不可重试的 4xx，按失效处理
    [402, undefined, KSK_PROBE_VERDICT.PERMANENTLY_INVALID],
    // 400 是我们的 payload 有问题（模型 ID 不存在），与账号有效性无关
    [400, 'INVALID_MODEL_ID', KSK_PROBE_VERDICT.TRANSIENT],
    [429, undefined, KSK_PROBE_VERDICT.TRANSIENT],
    [500, undefined, KSK_PROBE_VERDICT.TRANSIENT],
    [503, undefined, KSK_PROBE_VERDICT.TRANSIENT]
  ])('发消息验活分类 HTTP %s / %s => %s', (statusCode, reason, expected) => {
    expect(classifyKskProbeError(new KiroUpstreamError({ statusCode, reason, code: reason }))).toBe(
      expected
    )
  })

  it('无 statusCode 的网络错误按 transient 保留账号', () => {
    expect(classifyKskProbeError(new TypeError('fetch failed'))).toBe(KSK_PROBE_VERDICT.TRANSIENT)
  })

  it('按 rateMultiplier 选最便宜的模型，倍率缺失的排最后', () => {
    const models = [
      { modelId: 'claude-opus-4.5', rateMultiplier: 5 },
      { modelId: 'claude-haiku-4.5', rateMultiplier: 0.3 },
      { modelId: 'claude-sonnet-4.5', rateMultiplier: 1 },
      { modelId: 'mystery-model' }
    ] as KiroModel[]

    expect(pickCheapestModelId(models)).toBe('claude-haiku-4.5')
  })

  it('同倍率时按 modelId 稳定选择，跳过废弃模型与空列表', () => {
    const tied = [
      { modelId: 'model-b', rateMultiplier: 1 },
      { modelId: 'model-a', rateMultiplier: 1 }
    ] as KiroModel[]
    expect(pickCheapestModelId(tied)).toBe('model-a')

    const deprecated = [
      { modelId: 'cheap-but-dead', rateMultiplier: 0.1, status: 'DEPRECATED' },
      { modelId: 'alive', rateMultiplier: 2 }
    ] as KiroModel[]
    expect(pickCheapestModelId(deprecated)).toBe('alive')

    expect(pickCheapestModelId([])).toBeUndefined()
    expect(pickCheapestModelId([{ status: 'DEPRECATED' }] as KiroModel[])).toBeUndefined()
    expect(KSK_CLEANUP_FALLBACK_MODEL).toBe('claude-haiku-4.5')
  })

  it('上游验活使用固定并发上限并保持结果顺序', async () => {
    let active = 0
    let maxActive = 0
    const result = await mapWithConcurrency(
      Array.from({ length: 12 }, (_, index) => index),
      KSK_CREDENTIAL_VALIDATION_CONCURRENCY,
      async (value) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active--
        return value * 2
      }
    )

    expect(maxActive).toBe(KSK_CREDENTIAL_VALIDATION_CONCURRENCY)
    expect(result).toEqual(Array.from({ length: 12 }, (_, index) => index * 2))
  })

  it('删除落盘前重新核对 ID、Key 和分组，并同步清除绑定与当前账号', () => {
    const current = {
      accounts: {
        removable: {
          groupId: 'ksk',
          credentials: { credentialKind: 'kiro_api_key', kiroApiKey: KSK_ONE }
        },
        keyChanged: {
          groupId: 'ksk',
          credentials: { credentialKind: 'kiro_api_key', kiroApiKey: KSK_TWO }
        },
        otherGroup: {
          groupId: 'other',
          credentials: { credentialKind: 'kiro_api_key', kiroApiKey: KSK_ONE }
        }
      },
      activeAccountId: 'removable',
      accountProxyBindings: { removable: 'proxy-a', keyChanged: 'proxy-b' },
      groups: { ksk: { id: 'ksk', name: 'KSK' } }
    }
    const invalid = new Map([
      ['removable', { key: KSK_ONE, groupId: 'ksk' }],
      ['keyChanged', { key: KSK_ONE, groupId: 'ksk' }],
      ['otherGroup', { key: KSK_ONE, groupId: 'ksk' }]
    ])

    const result = removeMatchingInvalidKskAccounts(current, invalid)

    expect(result.removedIds).toEqual(['removable'])
    expect(result.data.accounts).not.toHaveProperty('removable')
    expect(result.data.accounts).toHaveProperty('keyChanged')
    expect(result.data.accounts).toHaveProperty('otherGroup')
    expect(result.data.accountProxyBindings).toEqual({ keyChanged: 'proxy-b' })
    expect(result.data.activeAccountId).toBeNull()
    expect(current.accounts).toHaveProperty('removable')
  })
})

describe('单账号推送到本机 Admin', () => {
  const REFRESH_TOKEN = 'refresh-token-value'

  it.each([
    [
      'ksk 账号映射为 api_key 并双写区域',
      { credentialKind: 'kiro_api_key' as const, kiroApiKey: KSK_ONE, region: 'eu-central-1' },
      {
        authMethod: 'api_key',
        priority: 0,
        kiroApiKey: KSK_ONE,
        authRegion: 'eu-central-1',
        apiRegion: 'eu-central-1'
      }
    ],
    [
      'clientId/Secret 齐备映射为 idc',
      {
        refreshToken: REFRESH_TOKEN,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        region: 'us-east-1'
      },
      {
        authMethod: 'idc',
        priority: 0,
        refreshToken: REFRESH_TOKEN,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authRegion: 'us-east-1'
      }
    ],
    [
      '仅 refreshToken 映射为 social，且不写 apiRegion',
      { refreshToken: REFRESH_TOKEN, region: 'us-east-1' },
      {
        authMethod: 'social',
        priority: 0,
        refreshToken: REFRESH_TOKEN,
        authRegion: 'us-east-1'
      }
    ],
    [
      'authMethod=IdC 且凭据齐备映射为 idc',
      {
        refreshToken: REFRESH_TOKEN,
        authMethod: 'IdC' as const,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        region: 'us-east-1'
      },
      {
        authMethod: 'idc',
        priority: 0,
        refreshToken: REFRESH_TOKEN,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authRegion: 'us-east-1'
      }
    ],
    [
      'authMethod=social 的账号即便带 clientId/Secret 也走 social',
      {
        refreshToken: REFRESH_TOKEN,
        authMethod: 'social' as const,
        clientId: 'client-id',
        clientSecret: 'client-secret',
        region: 'us-east-1'
      },
      {
        authMethod: 'social',
        priority: 0,
        refreshToken: REFRESH_TOKEN,
        authRegion: 'us-east-1'
      }
    ]
  ])('%s', (_name, candidate, expectedPayload) => {
    const resolved = resolveLocalAdminCredentialPayload(candidate)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(JSON.parse(JSON.stringify(resolved.payload))).toEqual(expectedPayload)
  })

  it.each([
    [
      'ksk 账号缺少合法区域',
      { credentialKind: 'kiro_api_key' as const, kiroApiKey: KSK_ONE },
      '区域'
    ],
    ['ksk 值不是合法的 Kiro API Key', { kiroApiKey: 'not-a-ksk' }, 'Kiro API Key'],
    ['OAuth 账号缺少 refreshToken', { clientId: 'client-id' }, 'Refresh Token'],
    [
      'IdC 只填了一半凭据',
      { refreshToken: REFRESH_TOKEN, clientId: 'client-id' },
      'Client ID 和 Client Secret'
    ],
    [
      'authMethod=IdC 但 clientId/Secret 为空串',
      {
        refreshToken: REFRESH_TOKEN,
        authMethod: 'IdC' as const,
        clientId: '',
        clientSecret: '',
        region: 'us-east-1'
      },
      'Client ID 和 Client Secret'
    ]
  ])('拒绝推送：%s', (_name, candidate, reasonPart) => {
    const resolved = resolveLocalAdminCredentialPayload(candidate)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toContain(reasonPart)
  })

  it('新建时按映射结果发 POST，并用余额接口确认 Admin 能用这条凭据', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = []
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      requests.push({
        url,
        method: init.method,
        body: init.body ? (JSON.parse(init.body) as unknown) : undefined
      })
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({ credentials: [] })
      }
      if (url.endsWith('/credentials') && init.method === 'POST') {
        return jsonResponse({ credentialId: 7 })
      }
      if (url.endsWith('/credentials/7/balance')) return jsonResponse({ balance: 1 })
      return jsonResponse({}, 404)
    }

    const result = await pushAccountToLocalAdmin({
      candidate: { refreshToken: REFRESH_TOKEN },
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl
    })

    expect(result).toEqual({
      status: 'created',
      credentialId: '7',
      verified: true,
      authMethod: 'social',
      // 这个用例没注入探针，只过了 balance 那一关
      probeVerdict: 'skipped'
    })
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET http://127.0.0.1:12888/api/admin/credentials',
      'POST http://127.0.0.1:12888/api/admin/credentials',
      'GET http://127.0.0.1:12888/api/admin/credentials/7/balance'
    ])
    expect(requests[1].body).toMatchObject({
      authMethod: 'social',
      refreshToken: REFRESH_TOKEN,
      priority: 0
    })
  })

  /**
   * 推送 + 验活的公共桩：GET 判重返回空池，POST 建 id=9，DELETE 记账。
   * balance 与发消息验活分别可控，用来单独测两道门禁。
   */
  const runPushWithProbe = async (
    probe: (() => Promise<{ verdict: string; error?: string }>) | undefined,
    options: { deleteFails?: boolean; balanceFails?: boolean; disableFails?: boolean } = {}
  ): Promise<{ result: LocalAdminPushResult; calls: string[] }> => {
    const calls: string[] = []
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      calls.push(`${init.method} ${url}`)
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({ credentials: [] })
      }
      if (url.endsWith('/credentials') && init.method === 'POST') {
        return jsonResponse({ credentialId: 9 })
      }
      if (url.endsWith('/credentials/9/balance')) {
        return options.balanceFails
          ? jsonResponse({ error: 'boom' }, 503)
          : jsonResponse({ balance: 1 })
      }
      // 刚建的凭据是启用状态，回滚删除会先走禁用
      if (url.endsWith('/credentials/9/disabled') && init.method === 'POST') {
        return options.disableFails ? jsonResponse({ error: 'locked' }, 500) : jsonResponse({})
      }
      if (url.endsWith('/credentials/9') && init.method === 'DELETE') {
        return options.deleteFails ? jsonResponse({ error: 'nope' }, 500) : jsonResponse({})
      }
      return jsonResponse({}, 404)
    }

    const result = await pushAccountToLocalAdmin({
      candidate: { refreshToken: REFRESH_TOKEN },
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl,
      probeLiveness: probe as never
    })
    return { result, calls }
  }

  const expectPushRejection = async (
    probe: (() => Promise<{ verdict: string; error?: string }>) | undefined,
    options: { deleteFails?: boolean; balanceFails?: boolean; disableFails?: boolean },
    expected: RegExp
  ): Promise<void> => {
    await expect(runPushWithProbe(probe, options)).rejects.toThrow(expected)
  }

  it('两道门禁都过才返回 created，且不删凭据', async () => {
    const { result, calls } = await runPushWithProbe(async () => ({ verdict: 'alive' }))

    expect(result).toEqual({
      status: 'created',
      credentialId: '9',
      verified: true,
      authMethod: 'social',
      probeVerdict: 'alive'
    })
    expect(calls).toEqual([
      'GET http://127.0.0.1:12888/api/admin/credentials',
      'POST http://127.0.0.1:12888/api/admin/credentials',
      'GET http://127.0.0.1:12888/api/admin/credentials/9/balance'
    ])
  })

  it.each([
    ['账号已失效', 'permanently_invalid', '账号已失效'],
    // transient 也算不通过：宁可推送失败让用户重推，也不把不确定的凭据留在池子里
    ['暂时无法确认', 'transient', '上游 503']
  ])('发消息验活不通过就删凭据并抛错：%s', async (_name, verdict, error) => {
    const calls: string[] = []
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      calls.push(`${init.method} ${url}`)
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({ credentials: [] })
      }
      if (url.endsWith('/credentials') && init.method === 'POST') {
        return jsonResponse({ credentialId: 9 })
      }
      if (url.endsWith('/credentials/9/balance')) return jsonResponse({ balance: 1 })
      if (url.endsWith('/credentials/9/disabled') && init.method === 'POST') {
        return jsonResponse({})
      }
      if (url.endsWith('/credentials/9') && init.method === 'DELETE') return jsonResponse({})
      return jsonResponse({}, 404)
    }

    await expect(
      pushAccountToLocalAdmin({
        candidate: { refreshToken: REFRESH_TOKEN },
        baseUrl: 'http://127.0.0.1:12888/admin',
        adminApiKey: 'admin_secret',
        timeoutSeconds: 5,
        fetchImpl,
        probeLiveness: (async () => ({ verdict, error })) as never
      })
    ).rejects.toThrow(new RegExp(`发消息验活未通过.*${error}.*已从 Admin 删除该凭据`))
    expect(calls).toContain('POST http://127.0.0.1:12888/api/admin/credentials/9/disabled')
    expect(calls).toContain('DELETE http://127.0.0.1:12888/api/admin/credentials/9')
  })

  it('Admin 用不了该凭据（余额接口失败）时删凭据并抛错，不再发消息验活', async () => {
    const probe = vi.fn()
    await expect(runPushWithProbe(probe as never, { balanceFails: true })).rejects.toThrow(
      /本机 Admin 无法使用该凭据.*已从 Admin 删除该凭据/
    )
    expect(probe).not.toHaveBeenCalled()
  })

  it('验活不过且删除也失败时，错误里点明需要手动清理', async () => {
    await expectPushRejection(
      async () => ({ verdict: 'permanently_invalid', error: '账号已失效' }),
      { deleteFails: true },
      /删除凭据 #9 失败，需要手动清理/
    )
  })

  it('回滚时禁用失败也算删除失败，错误里点明需要手动清理', async () => {
    await expectPushRejection(
      async () => ({ verdict: 'permanently_invalid', error: '账号已失效' }),
      { disableFails: true },
      /删除凭据 #9 失败，需要手动清理/
    )
  })

  it('Admin 已有同一凭据时不跑验活', async () => {
    const hash = createHash('sha256').update(REFRESH_TOKEN).digest('hex')
    const probe = vi.fn()
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({ credentials: [{ id: 4, refreshTokenHash: hash }] })
      }
      return jsonResponse({}, 404)
    }

    const result = await pushAccountToLocalAdmin({
      candidate: { refreshToken: REFRESH_TOKEN },
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl,
      probeLiveness: probe as never
    })

    expect(result).toMatchObject({ status: 'existing', probeVerdict: 'skipped' })
    expect(probe).not.toHaveBeenCalled()
  })

  it.each([
    [
      'api_key 按 apiKeyHash 判重',
      { credentialKind: 'kiro_api_key' as const, kiroApiKey: KSK_ONE, region: 'us-east-1' },
      (hash: string) => ({ id: 3, apiKeyHash: hash }),
      KSK_ONE
    ],
    [
      'OAuth 按 refreshTokenHash 判重',
      { refreshToken: REFRESH_TOKEN },
      (hash: string) => ({ id: 3, refreshTokenHash: hash }),
      REFRESH_TOKEN
    ]
  ])('已存在时返回 existing 且不再创建：%s', async (_name, candidate, buildRemote, secret) => {
    const hash = createHash('sha256').update(secret).digest('hex')
    const methods: string[] = []
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      methods.push(`${init.method} ${url}`)
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({ credentials: [buildRemote(hash)] })
      }
      return jsonResponse({}, 404)
    }

    const result = await pushAccountToLocalAdmin({
      candidate,
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl
    })

    expect(result).toMatchObject({ status: 'existing', credentialId: '3', verified: false })
    expect(methods).toEqual(['GET http://127.0.0.1:12888/api/admin/credentials'])
  })

  it('凭据不可映射时不发任何请求', async () => {
    const fetchImpl = vi.fn<KskAutomationFetch>()
    await expect(
      pushAccountToLocalAdmin({
        candidate: { clientId: 'client-id' },
        baseUrl: 'http://127.0.0.1:12888/admin',
        adminApiKey: 'admin_secret',
        timeoutSeconds: 5,
        fetchImpl
      })
    ).rejects.toThrow('Refresh Token')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('KSK 任务存储迁移', () => {
  it('把旧单例配置迁移为一条可管理任务并保留全部密钥', () => {
    const store = normalizeKskAutomationStorePayload(
      {
        config: {
          ...DEFAULT_KSK_AUTOMATION_CONFIG,
          providerEnabled: true,
          providerGroupId: 'ksk',
          localAdminEnabled: true,
          localAdminGroupId: 'ksk'
        },
        secrets: {
          providerUrl: 'https://provider.example/get?token=legacy',
          smtpPassword: 'smtp-secret',
          localAdminApiKey: 'admin-secret'
        }
      },
      1234
    )

    expect(store).toMatchObject({ version: KSK_AUTOMATION_STORE_VERSION })
    expect(store.tasks).toHaveLength(1)
    expect(store.tasks[0]).toMatchObject({
      id: 'legacy-ksk-automation',
      name: '自动拉取 KSK',
      enabled: true,
      createdAt: 1234,
      config: { providerGroupId: 'ksk', localAdminGroupId: 'ksk' },
      secrets: {
        providerUrl: 'https://provider.example/get?token=legacy',
        smtpPassword: 'smtp-secret',
        localAdminApiKey: 'admin-secret'
      }
    })
    expect(store.tasks[0].config.cleanupInvalidOnAdd).toBe(true)
  })
})

describe('KSK 自动拉取调度', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('一轮只导入 Provider 返回的有效 KSK，并带入配置分组', async () => {
    vi.useFakeTimers()
    const imported: Array<{ key: string; region: string; groupId?: string }> = []
    const task = automationTask({
      config: { ...DEFAULT_KSK_AUTOMATION_CONFIG, providerEnabled: true, providerGroupId: 'ksk' }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () =>
        jsonResponse({
          code: 0,
          data: [
            { account: { key: KSK_ONE, zone: 'us', aws_region: 'us-east-1', status: 'active' } }
          ]
        }),
      importCredential: async (input) => {
        imported.push(input)
        return { ...input, added: true }
      },
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    const status = await manager.runNow(TASK_ID)
    manager.stop()

    expect(imported).toEqual([
      {
        key: KSK_ONE,
        region: 'us-east-1',
        groupId: 'ksk',
        claimId: undefined,
        liveness: { model: '', message: '' }
      }
    ])
    expect(status).toMatchObject({
      state: KSK_AUTOMATION_STATE.HEALTHY,
      lastFetchedCount: 1,
      lastAddedCount: 1,
      totalAddedCount: 1
    })
  })

  it('只有本轮新增 KSK 时才触发目标分组清理，并回写清理统计', async () => {
    vi.useFakeTimers()
    let added = true
    const cleanupProxyAccounts = vi.fn(async () => ({
      checked: 5,
      removed: 2,
      retainedTransient: 0,
      errors: []
    }))
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: true,
        providerGroupId: 'ksk',
        cleanupInvalidOnAdd: true
      }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () =>
        jsonResponse({
          code: 0,
          data: [{ account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } }]
        }),
      importCredential: async (input) => {
        const wasAdded = added
        added = false
        return { ...input, added: wasAdded }
      },
      readLocalAdminAccounts: async () => [],
      cleanupProxyAccounts,
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    const first = await manager.runNow(task.id)
    const second = await manager.runNow(task.id)
    manager.stop()

    expect(cleanupProxyAccounts).toHaveBeenCalledTimes(1)
    expect(cleanupProxyAccounts).toHaveBeenCalledWith('ksk', { model: '', message: '' })
    expect(first).toMatchObject({
      lastCleanupCheckedCount: 5,
      lastCleanupRemovedCount: 2,
      lastCleanupRetainedCount: 0
    })
    expect(second).toMatchObject({
      lastAddedCount: 0,
      lastCleanupCheckedCount: 0,
      lastCleanupRemovedCount: 0
    })
  })

  it('邮件发送失败时保留待通知 KSK，并在下一轮重试', async () => {
    vi.useFakeTimers()
    const sendAddedEmail = vi
      .fn()
      .mockRejectedValueOnce(new Error('smtp unavailable'))
      .mockResolvedValueOnce(1)
    let importCount = 0
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: true,
        emailEnabled: true,
        smtpHost: 'smtp.example.com',
        smtpFrom: 'bot@example.com',
        smtpTo: 'owner@example.com'
      },
      secrets: {
        providerUrl: 'https://provider.example/get?token=secret',
        smtpPassword: 'smtp_secret',
        localAdminApiKey: ''
      }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () =>
        jsonResponse({
          code: 0,
          data: [
            {
              account: {
                key: KSK_ONE,
                zone: 'us',
                aws_region: 'us-east-1',
                status: 'active'
              }
            }
          ]
        }),
      importCredential: async (input) => ({ ...input, added: importCount++ === 0 }),
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      sendAddedEmail
    })

    const failedStatus = await manager.runNow(TASK_ID)
    const retriedStatus = await manager.runNow(TASK_ID)
    manager.stop()

    expect(failedStatus.state).toBe(KSK_AUTOMATION_STATE.DEGRADED)
    expect(failedStatus.lastAddedCount).toBe(1)
    expect(sendAddedEmail).toHaveBeenCalledTimes(2)
    expect(sendAddedEmail.mock.calls[1][1]).toEqual([{ key: KSK_ONE, region: 'us-east-1' }])
    expect(retriedStatus).toMatchObject({
      state: KSK_AUTOMATION_STATE.HEALTHY,
      lastAddedCount: 0,
      lastEmailedCount: 1,
      totalAddedCount: 1
    })
  })

  it('清理误删刚入库的 KSK 时，下一轮不会为同一个 key 再发一封邮件', async () => {
    vi.useFakeTimers()
    const sendAddedEmail = vi.fn(
      async (_config, credentials: Array<{ key: string }>) => credentials.length
    )
    // 模拟真实 store：入库即存在，被清理删除后再次入库会重新算作「新增」
    const stored = new Set<string>()
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: true,
        providerGroupId: 'ksk',
        cleanupInvalidOnAdd: true,
        emailEnabled: true,
        smtpHost: 'smtp.example.com',
        smtpFrom: 'bot@example.com',
        smtpTo: 'owner@example.com'
      },
      secrets: {
        providerUrl: 'https://provider.example/get?token=secret',
        smtpPassword: 'smtp_secret',
        localAdminApiKey: ''
      }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () =>
        jsonResponse({
          code: 0,
          data: [{ account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } }]
        }),
      importCredential: async (input) => {
        if (stored.has(input.key)) return { ...input, added: false }
        stored.add(input.key)
        return { ...input, added: true }
      },
      // 验活把刚入库的号判成失效并删掉（新 key 尚未在上游生效时会这样）
      cleanupProxyAccounts: async () => {
        const removed = stored.delete(KSK_ONE) ? 1 : 0
        return { checked: 1, removed, retainedTransient: 0, errors: [] }
      },
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      sendAddedEmail
    })

    await manager.runNow(TASK_ID)
    await manager.runNow(TASK_ID)
    manager.stop()

    const emailedBatches = sendAddedEmail.mock.calls
      .map((call) => call[1])
      .filter((credentials) => credentials.length > 0)
    expect(emailedBatches).toEqual([[{ key: KSK_ONE, region: 'us-east-1' }]])
  })

  it('被清理判失效的 KSK 不再重复入库，也不再触发清理', async () => {
    vi.useFakeTimers()
    const importedKeys: string[] = []
    const stored = new Set<string>()
    const cleanupProxyAccounts = vi.fn(async () => ({
      checked: 1,
      removed: stored.delete(KSK_ONE) ? 1 : 0,
      retainedTransient: 0,
      errors: [],
      removedKeys: [KSK_ONE]
    }))
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: true,
        providerGroupId: 'ksk',
        cleanupInvalidOnAdd: true
      }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () =>
        jsonResponse({
          code: 0,
          data: [{ account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } }]
        }),
      importCredential: async (input) => {
        importedKeys.push(input.key)
        if (stored.has(input.key)) return { ...input, added: false }
        stored.add(input.key)
        return { ...input, added: true }
      },
      cleanupProxyAccounts,
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    const first = await manager.runNow(TASK_ID)
    const second = await manager.runNow(TASK_ID)
    manager.stop()

    // 第一轮入库一次并被清理删掉；第二轮该 key 已拉黑，连 importCredential 都不该再调
    expect(importedKeys).toEqual([KSK_ONE])
    expect(cleanupProxyAccounts).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ lastAddedCount: 1, lastCleanupRemovedCount: 1 })
    // 拉取数仍按 Provider 实际返回计，跳过的号不该从统计里消失
    expect(second).toMatchObject({ lastFetchedCount: 1, lastAddedCount: 0 })
  })

  it('单个 KSK 验活失败不会阻断同一响应里的后续有效 KSK', async () => {
    vi.useFakeTimers()
    const imported: string[] = []
    const task = automationTask()
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () =>
        jsonResponse({
          code: 0,
          data: [
            { account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } },
            { account: { key: KSK_TWO, aws_region: 'eu-central-1', status: 'active' } }
          ]
        }),
      importCredential: async (input) => {
        if (input.key === KSK_ONE) throw new Error('disabled')
        imported.push(input.key)
        return { ...input, added: true }
      },
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      log: vi.fn()
    })

    const status = await manager.runNow(TASK_ID)
    manager.stop()

    expect(imported).toEqual([KSK_TWO])
    expect(status).toMatchObject({
      state: KSK_AUTOMATION_STATE.DEGRADED,
      lastFetchedCount: 2,
      lastAddedCount: 1,
      totalAddedCount: 1,
      lastError: '1 条 KSK 验活或入库失败'
    })
  })

  it('验活未通过的 KSK 不入库、不发邮件，并被拉黑不再重试', async () => {
    vi.useFakeTimers()
    const importedKeys: string[] = []
    const sendAddedEmail = vi.fn<typeof sendKskAddedEmail>(async () => 1)
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: true,
        emailEnabled: true,
        smtpHost: 'smtp.example.com',
        smtpFrom: 'bot@example.com',
        smtpTo: 'owner@example.com'
      }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () =>
        jsonResponse({
          code: 0,
          data: [
            { account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } },
            { account: { key: KSK_TWO, aws_region: 'eu-central-1', status: 'active' } }
          ]
        }),
      importCredential: async (input) => {
        importedKeys.push(input.key)
        if (input.key === KSK_ONE) return { ...input, added: false, rejected: true }
        return { ...input, added: true }
      },
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      sendAddedEmail,
      log: vi.fn()
    })

    const first = await manager.runNow(TASK_ID)
    const second = await manager.runNow(TASK_ID)
    manager.stop()

    // 第二轮 KSK_ONE 已拉黑，只会再验 KSK_TWO
    expect(importedKeys).toEqual([KSK_ONE, KSK_TWO, KSK_TWO])
    expect(first).toMatchObject({
      state: KSK_AUTOMATION_STATE.DEGRADED,
      lastFetchedCount: 2,
      lastAddedCount: 1,
      lastRejectedCount: 1,
      lastError: '1 条 KSK 验活未通过，未入库'
    })
    expect(second).toMatchObject({ lastRejectedCount: 0 })
    // 只给通过验活的号发信
    expect(sendAddedEmail.mock.calls[0][1]).toEqual([{ key: KSK_TWO, region: 'eu-central-1' }])
  })

  it('本地验活判死的号会连带从本机 Admin 删掉，且先删后同步', async () => {
    vi.useFakeTimers()
    const adminCalls: string[] = []
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: true,
        providerGroupId: 'ksk',
        cleanupInvalidOnAdd: true,
        localAdminEnabled: true,
        localAdminGroupId: 'ksk'
      },
      secrets: {
        providerUrl: 'https://provider.example/get?token=secret',
        smtpPassword: '',
        localAdminApiKey: 'admin_secret'
      }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () =>
        jsonResponse({
          code: 0,
          data: [
            { account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } },
            { account: { key: KSK_TWO, aws_region: 'eu-central-1', status: 'active' } }
          ]
        }),
      localAdminFetchImpl: async (url, init) => {
        adminCalls.push(`${init.method} ${url.replace('http://127.0.0.1:12888/api/admin', '')}`)
        if (url.endsWith('/credentials') && init.method === 'GET') {
          return jsonResponse({
            credentials: [{ id: 7, authMethod: 'api_key', apiKeyHash: sha256Hex(KSK_ONE) }]
          })
        }
        return jsonResponse({ credentialId: 9 })
      },
      importCredential: async (input) => {
        if (input.key === KSK_ONE) return { ...input, added: false, rejected: true }
        return { ...input, added: true }
      },
      readLocalAdminAccounts: async () => [{ kiroApiKey: KSK_TWO, region: 'eu-central-1' }],
      cleanupProxyAccounts: async () => ({
        checked: 1,
        removed: 0,
        retainedTransient: 0,
        errors: []
      }),
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      log: vi.fn()
    })

    await manager.runNow(TASK_ID)
    manager.stop()

    /*
     * 判死的 KSK_ONE 在 Admin 上被删；本轮的同步必须排在删除之后，
     * 否则会把刚判死的号又推回反代。用 lastIndexOf 取本轮那次 POST——
     * 任务启用本机 Admin 时 start() 会先跑一次开机同步，那次不在本断言范围内。
     */
    const deleteIndex = adminCalls.indexOf('DELETE /credentials/7')
    expect(deleteIndex).toBeGreaterThanOrEqual(0)
    expect(adminCalls.lastIndexOf('POST /credentials')).toBeGreaterThan(deleteIndex)
  })

  it('一个都没新增但抓出挂号时，反代那边照样清理', async () => {
    vi.useFakeTimers()
    const adminCalls: string[] = []
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: true,
        localAdminEnabled: true,
        localAdminGroupId: 'ksk'
      },
      secrets: {
        providerUrl: 'https://provider.example/get?token=secret',
        smtpPassword: '',
        localAdminApiKey: 'admin_secret'
      }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () =>
        jsonResponse({
          code: 0,
          data: [{ account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } }]
        }),
      localAdminFetchImpl: async (url, init) => {
        adminCalls.push(`${init.method} ${url.replace('http://127.0.0.1:12888/api/admin', '')}`)
        if (url.endsWith('/credentials') && init.method === 'GET') {
          return jsonResponse({
            credentials: [{ id: 7, authMethod: 'api_key', apiKeyHash: sha256Hex(KSK_ONE) }]
          })
        }
        return jsonResponse({})
      },
      importCredential: async (input) => ({ ...input, added: false, rejected: true }),
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      log: vi.fn()
    })

    await manager.runNow(TASK_ID)
    manager.stop()

    expect(adminCalls).toContain('DELETE /credentials/7')
  })

  it('任务里配置的验活模型与消息会透传给入库和全量清理', async () => {
    vi.useFakeTimers()
    const livenessSeen: Array<unknown> = []
    const cleanupProxyAccounts = vi.fn(async () => ({
      checked: 1,
      removed: 0,
      retainedTransient: 0,
      errors: []
    }))
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: true,
        providerGroupId: 'ksk',
        cleanupInvalidOnAdd: true,
        livenessModel: 'claude-sonnet-4.5',
        livenessMessage: 'ping'
      }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () =>
        jsonResponse({
          code: 0,
          data: [{ account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } }]
        }),
      importCredential: async (input) => {
        livenessSeen.push(input.liveness)
        return { ...input, added: true }
      },
      readLocalAdminAccounts: async () => [],
      cleanupProxyAccounts,
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    await manager.runNow(TASK_ID)
    manager.stop()

    const expected = { model: 'claude-sonnet-4.5', message: 'ping' }
    expect(livenessSeen).toEqual([expected])
    expect(cleanupProxyAccounts).toHaveBeenCalledWith('ksk', expected)
  })

  it('不同任务按各自 Provider 和目标分组独立执行', async () => {
    vi.useFakeTimers()
    const first = automationTask({
      id: 'task-us',
      config: { ...DEFAULT_KSK_AUTOMATION_CONFIG, providerEnabled: true, providerGroupId: 'us' },
      secrets: {
        providerUrl: 'https://provider.example/us?token=one',
        smtpPassword: '',
        localAdminApiKey: ''
      }
    })
    const second = automationTask({
      id: 'task-eu',
      config: { ...DEFAULT_KSK_AUTOMATION_CONFIG, providerEnabled: true, providerGroupId: 'eu' },
      secrets: {
        providerUrl: 'https://provider.example/eu?token=two',
        smtpPassword: '',
        localAdminApiKey: ''
      }
    })
    const tasks = [first, second]
    const imported: Array<{ key: string; groupId?: string }> = []
    const manager = new KskAutomationManager({
      readStore: async () => ({ version: KSK_AUTOMATION_STORE_VERSION, tasks }),
      readTask: async (taskId) => tasks.find((task) => task.id === taskId),
      fetchImpl: async (url) =>
        jsonResponse({
          code: 0,
          data: [
            {
              account: {
                key: url.includes('/us?') ? KSK_ONE : KSK_TWO,
                aws_region: url.includes('/us?') ? 'us-east-1' : 'eu-central-1',
                status: 'active'
              }
            }
          ]
        }),
      importCredential: async (input) => {
        imported.push({ key: input.key, groupId: input.groupId })
        return { ...input, added: true }
      },
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    await manager.runNow(first.id)
    await manager.runNow(second.id)
    manager.stop()

    expect(imported).toEqual([
      { key: KSK_ONE, groupId: 'us' },
      { key: KSK_TWO, groupId: 'eu' }
    ])
  })

  it('暂停任务后拒绝手动执行且不安排下一轮', async () => {
    const task = automationTask({ enabled: false })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: vi.fn(),
      importCredential: vi.fn(),
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    await manager.start()
    expect(manager.snapshot(task.id)).toMatchObject({
      state: KSK_AUTOMATION_STATE.IDLE,
      running: false,
      nextRunAt: undefined
    })
    await expect(manager.runNow(task.id)).rejects.toThrow('已暂停')
    manager.stop()
  })

  it('本机 Admin 同步使用独立直连 fetch，不复用 Provider 代理链', async () => {
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: false,
        localAdminEnabled: true,
        localAdminGroupId: 'ksk'
      },
      secrets: {
        providerUrl: '',
        smtpPassword: '',
        localAdminApiKey: 'admin-secret'
      }
    })
    const providerFetch = vi.fn()
    const localAdminFetch = vi.fn(async (url: string, init: { method: string }) => {
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({ credentials: [] })
      }
      if (url.endsWith('/credentials') && init.method === 'POST') {
        return jsonResponse({ credentialId: 9 })
      }
      if (url.endsWith('/credentials/9/balance')) return jsonResponse({ currentUsage: 0 })
      return jsonResponse({}, 404)
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: providerFetch,
      localAdminFetchImpl: localAdminFetch,
      importCredential: vi.fn(),
      readLocalAdminAccounts: async () => [{ kiroApiKey: KSK_ONE, region: 'us-east-1' }],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    await manager.syncLocalAdminNow(task.id)
    manager.stop()

    expect(providerFetch).not.toHaveBeenCalled()
    expect(localAdminFetch).toHaveBeenCalled()
  })

  it('同步分组读到 0 个账号时不发任何 Admin 请求，避免清空反代凭据', async () => {
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: false,
        localAdminEnabled: true,
        localAdminGroupId: 'ksk'
      },
      secrets: { providerUrl: '', smtpPassword: '', localAdminApiKey: 'admin-secret' }
    })
    const localAdminFetch = vi.fn()
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: vi.fn(),
      localAdminFetchImpl: localAdminFetch,
      importCredential: vi.fn(),
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    const status = await manager.syncLocalAdminNow(task.id)
    manager.stop()

    expect(localAdminFetch).not.toHaveBeenCalled()
    expect(status.logs.map((entry) => entry.message)).toContain(
      '同步分组内没有可用的 Kiro API Key 账号，跳过本轮同步（不清理反代凭据）'
    )
  })

  it('同步时把 Admin 上本地已不存在的凭据清理数记进状态与日志', async () => {
    const staleHash = createHash('sha256').update(KSK_TWO).digest('hex')
    const task = automationTask({
      config: {
        ...DEFAULT_KSK_AUTOMATION_CONFIG,
        providerEnabled: false,
        localAdminEnabled: true,
        localAdminGroupId: 'ksk'
      },
      secrets: { providerUrl: '', smtpPassword: '', localAdminApiKey: 'admin-secret' }
    })
    const localAdminFetch = vi.fn(async (url: string, init: { method: string }) => {
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({
          credentials: [
            { id: 8, apiKeyHash: staleHash, authMethod: 'api_key', maskedApiKey: 'ksk_...1DaC' }
          ]
        })
      }
      if (url.endsWith('/credentials/8/disabled') && init.method === 'POST') {
        return jsonResponse({})
      }
      if (url.endsWith('/credentials/8') && init.method === 'DELETE') return jsonResponse({})
      if (url.endsWith('/credentials') && init.method === 'POST') {
        return jsonResponse({ credentialId: 9 })
      }
      if (url.endsWith('/credentials/9/balance')) return jsonResponse({ currentUsage: 0 })
      return jsonResponse({}, 404)
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: vi.fn(),
      localAdminFetchImpl: localAdminFetch,
      importCredential: vi.fn(),
      readLocalAdminAccounts: async () => [{ kiroApiKey: KSK_ONE, region: 'us-east-1' }],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    const status = await manager.syncLocalAdminNow(task.id)
    manager.stop()

    expect(status.lastLocalAdminPrunedCount).toBe(1)
    expect(status.logs.map((entry) => entry.message)).toContain(
      '已从本机 Admin 清理 1 个本地已不存在的凭据：ksk_...1DaC'
    )
  })

  it('定时轮次执行中点击立即执行会等待同一轮最终结果', async () => {
    vi.useFakeTimers()
    const task = automationTask()
    let finishFetch: ((response: Response) => void) | undefined
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishFetch = resolve
        })
    )
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl,
      importCredential: async (input) => ({ ...input, added: true }),
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    const first = manager.runNow(task.id)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const second = manager.runNow(task.id)
    finishFetch?.(jsonResponse({ code: 0, data: [] }))
    const [firstStatus, secondStatus] = await Promise.all([first, second])
    manager.stop()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(firstStatus.state).toBe(KSK_AUTOMATION_STATE.HEALTHY)
    expect(secondStatus.state).toBe(KSK_AUTOMATION_STATE.HEALTHY)
  })

  it('把每轮的拉取结果与失败原因记进运行日志', async () => {
    vi.useFakeTimers()
    const task = automationTask({
      config: { ...DEFAULT_KSK_AUTOMATION_CONFIG, providerEnabled: true, providerGroupId: 'ksk' }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            code: 0,
            data: [{ account: { key: KSK_ONE, aws_region: 'us-east-1', status: 'active' } }]
          })
        )
        .mockRejectedValueOnce(new Error('provider unreachable')),
      importCredential: async (input) => ({ ...input, added: true }),
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      log: vi.fn()
    })

    await manager.runNow(task.id)
    const status = await manager.runNow(task.id)
    manager.stop()

    const messages = status.logs.map((entry) => entry.message)
    expect(messages).toContain('本轮拉到 1 条，新增 1 个')
    expect(messages).toContain('轮询失败：provider unreachable')
    expect(status.logs.at(-1)).toMatchObject({ level: 'error' })
    expect(status.logs.every((entry) => entry.at > 0)).toBe(true)
  })

  it('运行日志超过上限时只保留最近的条目', async () => {
    vi.useFakeTimers()
    const task = automationTask({
      config: { ...DEFAULT_KSK_AUTOMATION_CONFIG, providerEnabled: true }
    })
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () => jsonResponse({ code: 0, data: [] }),
      importCredential: async (input) => ({ ...input, added: false }),
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn(),
      log: vi.fn()
    })

    // 每轮至少写 2 条（手动触发 + 本轮汇总），跑满上限即可验证环形裁剪
    for (let round = 0; round < KSK_AUTOMATION_LOG_LIMIT; round++) {
      await manager.runNow(task.id)
    }
    const status = await manager.runNow(task.id)
    manager.stop()

    expect(status.logs).toHaveLength(KSK_AUTOMATION_LOG_LIMIT)
    expect(status.logs.at(-1)?.message).toBe('本轮拉到 0 条，新增 0 个')
  })

  it('未启动的任务各自拿到独立的空日志数组', async () => {
    const task = automationTask()
    const manager = new KskAutomationManager({
      readStore: async () => managerStore(task),
      readTask: async (taskId) => (taskId === task.id ? task : undefined),
      fetchImpl: async () => jsonResponse({ code: 0, data: [] }),
      importCredential: async (input) => ({ ...input, added: false }),
      readLocalAdminAccounts: async () => [],
      notifyStatus: vi.fn(),
      notifyAccountsChanged: vi.fn()
    })

    const first = manager.snapshot('missing-a')
    const second = manager.snapshot('missing-b')
    first.logs.push({ at: 1, level: 'info', message: '污染' })

    expect(second.logs).toEqual([])
  })
})

describe('KSK 新增邮件收件人', () => {
  const credentials = [{ key: KSK_ONE, region: 'us-east-1' }]

  afterEach(() => {
    createTransport.mockClear()
    mailer.sendMail.mockClear()
    mailer.close.mockClear()
  })

  function emailConfig(overrides: Partial<KskEmailConfig> = {}): KskEmailConfig {
    return {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      username: '',
      password: '',
      from: 'Proxy RS <bot@example.com>',
      to: 'owner@example.com',
      ...overrides
    }
  }

  it('只按收件人列表投递，不再隐式抄送发件邮箱', async () => {
    await sendKskAddedEmail(emailConfig(), credentials)
    expect(mailer.sendMail.mock.calls[0][0]).toMatchObject({
      from: 'Proxy RS <bot@example.com>',
      to: ['owner@example.com']
    })
    expect(mailer.sendMail.mock.calls[0][0].cc).toBeUndefined()
  })

  it('收件邮箱支持逗号分隔多个地址', async () => {
    await sendKskAddedEmail(
      emailConfig({ to: 'owner@example.com, Me <bot@example.com>' }),
      credentials
    )
    expect(mailer.sendMail.mock.calls[0][0].to).toEqual([
      'owner@example.com',
      'Me <bot@example.com>'
    ])
  })

  it('同一地址重复填写只投递一次，忽略显示名与大小写', async () => {
    await sendKskAddedEmail(
      emailConfig({ to: 'owner@example.com, Owner <OWNER@example.com>' }),
      credentials
    )
    expect(mailer.sendMail.mock.calls[0][0].to).toEqual(['owner@example.com'])
  })

  it('收件邮箱只填分隔符时拒绝发送', async () => {
    await expect(sendKskAddedEmail(emailConfig({ to: ' , ' }), credentials)).rejects.toThrow(
      '收件人'
    )
    expect(mailer.sendMail).not.toHaveBeenCalled()
  })

  it('没有新增时不发信', async () => {
    await expect(sendKskAddedEmail(emailConfig(), [])).resolves.toBe(0)
    expect(mailer.sendMail).not.toHaveBeenCalled()
  })

  it('关闭隐式 TLS 时强制要求 STARTTLS', async () => {
    await sendKskAddedEmail(emailConfig({ port: 587, secure: false }), credentials)
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: true })
    )
  })
})
