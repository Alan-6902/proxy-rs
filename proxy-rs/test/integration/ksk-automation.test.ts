import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { mailer, createTransport } = vi.hoisted(() => {
  const mailer = { sendMail: vi.fn(), close: vi.fn() }
  return { mailer, createTransport: vi.fn(() => mailer) }
})

vi.mock('nodemailer', () => ({ default: { createTransport } }))
import {
  DEFAULT_KSK_AUTOMATION_CONFIG,
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
import { resolveLocalAdminCredentialPayload } from '../../src/shared/localAdminPush'
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
    ]
  ])('拒绝推送：%s', (_name, candidate, reasonPart) => {
    const resolved = resolveLocalAdminCredentialPayload(candidate)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toContain(reasonPart)
  })

  it('新建后调用余额验活，余额失败仍算推送成功', async () => {
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
      if (url.endsWith('/credentials/7/balance')) return jsonResponse({ error: 'boom' }, 503)
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
      verified: false,
      authMethod: 'social'
    })
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET http://127.0.0.1:12888/api/admin/credentials',
      'POST http://127.0.0.1:12888/api/admin/credentials',
      'GET http://127.0.0.1:12888/api/admin/credentials/7/balance'
    ])
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
