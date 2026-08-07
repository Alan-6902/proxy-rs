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
  parseKskProviderResponse,
  providerUrlHint
} from '../../src/shared/kskAutomation'
import {
  cleanupInvalidLocalAdminCredentials,
  resolveLocalAdminApiBase,
  syncKskAccountsToLocalAdmin,
  type KskAutomationFetch
} from '../../src/main/kskAutomation/localAdminClient'
import {
  isPermanentKskCredentialError,
  KSK_CREDENTIAL_VALIDATION_CONCURRENCY,
  mapWithConcurrency,
  removeMatchingInvalidKskAccounts
} from '../../src/main/kskAutomation/credentialCleanup'
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

  it('清理时只删除明确永久失效的 API Key，临时错误和非 KSK 凭据都保留', async () => {
    const requests: string[] = []
    const fetchImpl: KskAutomationFetch = async (url, init) => {
      requests.push(`${init.method} ${url}`)
      if (url.endsWith('/credentials') && init.method === 'GET') {
        return jsonResponse({
          credentials: [
            { id: 1, authMethod: 'api_key' },
            { id: 2, authMethod: 'api_key' },
            { id: 3, authMethod: 'api_key' },
            { id: 4, authMethod: 'social' }
          ]
        })
      }
      if (url.endsWith('/credentials/1/balance')) return jsonResponse({ remaining: 10 })
      if (url.endsWith('/credentials/2/balance')) {
        return jsonResponse({ error: 'Kiro API key AccessDeniedException: HTTP 403' }, 502)
      }
      if (url.endsWith('/credentials/3/balance')) {
        return jsonResponse({ error: 'upstream temporarily unavailable' }, 503)
      }
      if (url.endsWith('/credentials/2') && init.method === 'DELETE') return jsonResponse({})
      return jsonResponse({}, 404)
    }

    const result = await cleanupInvalidLocalAdminCredentials({
      baseUrl: 'http://127.0.0.1:12888/admin',
      adminApiKey: 'admin_secret',
      timeoutSeconds: 5,
      fetchImpl
    })

    expect(result).toEqual({
      checked: 3,
      removed: 1,
      retainedTransient: 1,
      errors: []
    })
    expect(requests).toContain('DELETE http://127.0.0.1:12888/api/admin/credentials/2')
    expect(requests).not.toContain('DELETE http://127.0.0.1:12888/api/admin/credentials/3')
    expect(requests.some((request) => request.includes('/credentials/4/balance'))).toBe(false)
  })

  it.each([
    ['HTTP 401', true],
    ['HTTP 403', true],
    ['HTTP 423', true],
    ['AccountSuspendedException', true],
    ['HTTP 429', false],
    ['HTTP 503', false],
    ['fetch failed', false]
  ])('永久失效分类 %s => %s', (message, expected) => {
    expect(isPermanentKskCredentialError(new Error(message))).toBe(expected)
  })

  it('本机 Admin 模式下不会把无凭据语义的 401 当成账号永久失效', () => {
    expect(
      isPermanentKskCredentialError(new Error('本机 Admin 请求失败: HTTP 401'), {
        requireExplicitCredentialSignal: true
      })
    ).toBe(false)
    expect(
      isPermanentKskCredentialError(new Error('UnauthorizedException'), {
        requireExplicitCredentialSignal: true
      })
    ).toBe(false)
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
      { key: KSK_ONE, region: 'us-east-1', groupId: 'ksk', claimId: undefined }
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
    expect(cleanupProxyAccounts).toHaveBeenCalledWith('ksk')
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
