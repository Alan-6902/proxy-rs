import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountDb } from '../../src/main/accountDb/db'
import {
  AccountDataBridge,
  wrapStoreWithBridge,
  type RawStore
} from '../../src/main/accountDb/bridge'
import { toAccount, toImportRequest } from '../../src/main/accountDb/projection'
import { planMigration, rollbackAccountDb } from '../../src/main/accountDb/migrate'
import { managedEntryOf, defaultAccountDbConfig } from '../../src/main/accountDb/runtime'
import type { KiroRsAdminTarget } from '../../src/main/accountDb/adminApi'

const MIGRATION = readFileSync(
  resolve(import.meta.dirname, '../../../kiro-rs-src/migrations/0001_init.sql'),
  'utf8'
)

/** 按 kiro-rs 的方式建一个测试库（migration + db_meta + user_version） */
function createDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'account-db-test-'))
  const path = join(dir, 'accounts.sqlite3')
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(MIGRATION)
  db.prepare("INSERT INTO db_meta VALUES (1, 'db-test-id', 1)").run()
  db.prepare("INSERT INTO schema_migrations VALUES (1, 'x', 1)").run()
  db.pragma('user_version = 1')
  db.close()
  return path
}

interface SeedAccount {
  uuid: string
  email?: string
  refreshToken?: string
  kiroApiKey?: string
  authMethod?: string
  inPool?: boolean
  enabled?: boolean
  disabledReason?: string
  raw?: unknown
  nickname?: string
}

/** 模拟 kiro-rs 写入一行账号 */
function seed(path: string, a: SeedAccount): number {
  const db = new Database(path)
  const now = Date.now()
  const id = Number(
    db
      .prepare(
        `INSERT INTO accounts(account_uuid, credential_identity, email, in_pool, enabled,
           disabled_reason, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        a.uuid,
        `ident-${a.uuid}`,
        a.email ?? null,
        a.inPool ? 1 : 0,
        a.enabled === false ? 0 : 1,
        a.enabled === false ? (a.disabledReason ?? 'Manual') : null,
        now,
        now
      ).lastInsertRowid
  )
  const isKey = Boolean(a.kiroApiKey)
  db.prepare(
    `INSERT INTO account_credentials(account_id, auth_kind, auth_method, access_token, refresh_token,
       kiro_api_key, expires_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    isKey ? 'api_key' : 'oauth',
    isKey ? 'api_key' : (a.authMethod ?? 'social'),
    isKey ? null : 'at-db',
    a.refreshToken ?? null,
    a.kiroApiKey ?? null,
    now + 3_600_000,
    now
  )
  db.prepare(
    `INSERT INTO account_usage(account_id, raw_json, observed_at_ms, sync_state, requested_seq, completed_seq)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run(id, a.raw ? JSON.stringify(a.raw) : null, a.raw ? now : null, a.raw ? 'ok' : 'never')
  db.prepare(`INSERT INTO account_ui(account_id, nickname, updated_at_ms) VALUES (?, ?, ?)`).run(
    id,
    a.nickname ?? null,
    now
  )
  db.prepare('INSERT INTO account_counters(account_id, updated_at_ms) VALUES (?, ?)').run(id, now)
  db.close()
  return id
}

class MemoryStore implements RawStore {
  data = new Map<string, unknown>()
  path = '/tmp/fake-store.json'
  get(key: string, defaultValue?: unknown): unknown {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : defaultValue
  }
  set(key: string, value: unknown): void {
    this.data.set(key, structuredClone(value))
  }
  has(key: string): boolean {
    return this.data.has(key)
  }
}

const RAW_USAGE = {
  usageBreakdownList: [
    {
      resourceType: 'CREDIT',
      usageLimitWithPrecision: 50,
      currentUsageWithPrecision: 10,
      freeTrialInfo: {
        freeTrialStatus: 'ACTIVE',
        usageLimitWithPrecision: 500,
        currentUsageWithPrecision: 5
      },
      bonuses: [{ status: 'ACTIVE', bonusCode: 'B', usageLimit: 20, currentUsage: 1 }]
    }
  ],
  subscriptionInfo: { subscriptionTitle: 'KIRO PRO+' },
  userInfo: { userId: 'user-1', email: 'u@example.com' }
}

const TARGET: KiroRsAdminTarget = {
  baseUrl: 'http://127.0.0.1:1/api/admin',
  adminApiKey: 'k',
  timeoutMs: 1000
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('AccountDb', () => {
  it('路径写错时报错且不创建文件', () => {
    const path = join(tmpdir(), `missing-${Date.now()}.sqlite3`)
    expect(() => new AccountDb(path)).toThrow()
    expect(existsSync(path)).toBe(false)
  })

  it('schema 版本不一致时拒绝读写', () => {
    const path = createDb()
    const raw = new Database(path)
    raw.pragma('user_version = 99')
    raw.close()
    expect(() => new AccountDb(path)).toThrow(/schema/)
  })

  it('writeUi 内容不变时不写，变化时写并产生 UI 变更', () => {
    const path = createDb()
    const id = seed(path, { uuid: 'a', refreshToken: 'rt' })
    const db = new AccountDb(path)
    const before = db.anyChangeSeq()
    const fields = { nickname: 'n', groupId: 'g', tags: ['t'], metadata: {} }
    expect(db.writeUi(id, fields)).toBe(true)
    expect(db.writeUi(id, fields)).toBe(false)
    expect(db.anyChangeSeq()).toBeGreaterThan(before)
    // UI 写入不计入 proxy 关心的跨端变化
    const watched = db.changeSeq()
    db.writeUi(id, { ...fields, nickname: 'm' })
    expect(db.changeSeq()).toBe(watched)
    db.close()
  })
})

describe('projection', () => {
  it('额度按上游原样 JSON 解析（CREDIT + 试用 + 奖励），订阅按标题映射', () => {
    const path = createDb()
    seed(path, { uuid: 'a', refreshToken: 'rt', raw: RAW_USAGE })
    const db = new AccountDb(path)
    const account = toAccount(db.listRows()[0])
    const usage = account.usage as { current: number; limit: number; bonuses: unknown[] }
    expect(usage.limit).toBe(570)
    expect(usage.current).toBe(16)
    expect(usage.bonuses).toHaveLength(1)
    expect((account.subscription as { type: string }).type).toBe('Pro_Plus')
    expect(account.userId).toBeUndefined()
    expect(account.email).toBe('u@example.com')
    expect(account.status).toBe('active')
    db.close()
  })

  it('禁用原因映射为卡片状态；API Key 账号标记 credentialKind', () => {
    const path = createDb()
    seed(path, {
      uuid: 'bad',
      refreshToken: 'rt',
      enabled: false,
      disabledReason: 'InvalidRefreshToken'
    })
    seed(path, { uuid: 'key', kiroApiKey: 'ksk_x' })
    const db = new AccountDb(path)
    const [bad, key] = db.listRows().map(toAccount)
    expect(bad.status).toBe('expired')
    expect((key.credentials as { credentialKind: string }).credentialKind).toBe('kiro_api_key')
    db.close()
  })

  it('导入请求按账号认证方式映射，缺字段时拒绝', () => {
    const social = toImportRequest({
      id: 'p1',
      email: 'a@example.com',
      nickname: 'nick',
      tags: ['t'],
      credentials: {
        refreshToken: 'rt',
        authMethod: 'social',
        region: 'us-east-1',
        accessToken: 'at',
        expiresAt: 123
      }
    })
    expect(social.ok && social.body).toMatchObject({
      accountUuid: 'p1',
      inPool: false,
      authMethod: 'social',
      refreshToken: 'rt',
      accessToken: 'at',
      expiresAtMs: 123,
      apiRegion: 'us-east-1',
      nickname: 'nick'
    })
    const idc = toImportRequest({
      id: 'p2',
      credentials: { refreshToken: 'rt', authMethod: 'IdC', region: 'us-east-1' }
    })
    expect(idc.ok).toBe(false)
  })
})

describe('AccountDataBridge', () => {
  let path: string
  let raw: MemoryStore
  let db: AccountDb

  beforeEach(() => {
    path = createDb()
    raw = new MemoryStore()
    db = new AccountDb(path)
  })
  afterEach(() => db.close())

  it('get：设置原样返回，账号 = 库投影 + 待导入', () => {
    seed(path, { uuid: 'db-1', refreshToken: 'rt-db', nickname: 'from-db' })
    raw.set('accountData', {
      theme: 'dark',
      accounts: { 'pending-1': { id: 'pending-1', credentials: { refreshToken: 'rt-p' } } }
    })
    const bridge = new AccountDataBridge(db, raw)
    const data = bridge.get(null)!
    expect(data.theme).toBe('dark')
    expect(Object.keys(data.accounts!).sort()).toEqual(['db-1', 'pending-1'])
    expect(data.accounts!['db-1'].nickname).toBe('from-db')
  })

  it('set：库中账号只写 UI；旧快照的凭据写不回去；已删除账号不复活', () => {
    const id = seed(path, { uuid: 'db-1', refreshToken: 'rt-db' })
    const gone = seed(path, { uuid: 'gone', refreshToken: 'rt-gone' })
    const conn = new Database(path)
    conn.prepare('UPDATE accounts SET deleted_at_ms = 1 WHERE id = ?').run(gone)
    conn.close()
    const onPending = vi.fn()
    const bridge = new AccountDataBridge(db, raw, { onPending })
    bridge.set({
      theme: 'light',
      accounts: {
        'db-1': {
          id: 'db-1',
          nickname: 'renamed',
          tags: ['x'],
          credentials: { refreshToken: 'STALE' }
        },
        gone: { id: 'gone', credentials: { refreshToken: 'rt-gone' } },
        fresh: { id: 'fresh', credentials: { refreshToken: 'rt-new' } }
      }
    })
    const row = db.listRows().find((r) => r.id === id)!
    expect(row.nickname).toBe('renamed')
    expect(row.refreshToken).toBe('rt-db')
    expect(bridge.pendingIds()).toEqual(['fresh'])
    expect(onPending).toHaveBeenCalledOnce()
    expect((raw.get('accountData') as { theme: string }).theme).toBe('light')
  })

  it('set 不因快照缺少账号而删除库中账号', () => {
    seed(path, { uuid: 'db-1', refreshToken: 'rt' })
    const bridge = new AccountDataBridge(db, raw)
    bridge.set({ accounts: {} })
    expect(db.listRows()).toHaveLength(1)
  })

  it('syncPending：导入成功移出待导入，失败保留', async () => {
    raw.set('accountData', {
      accounts: {
        ok: { id: 'ok', credentials: { refreshToken: 'rt', authMethod: 'social' } },
        fail: { id: 'fail', credentials: { refreshToken: 'rt2', authMethod: 'social' } },
        broken: { id: 'broken', credentials: {} }
      }
    })
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return body.accountUuid === 'ok'
        ? jsonResponse(200, { credentialId: 9, created: true })
        : jsonResponse(400, { error: { message: 'nope' } })
    }) as unknown as typeof fetch
    const bridge = new AccountDataBridge(db, raw, { fetchImpl })
    const result = await bridge.syncPending(TARGET)
    expect(result.imported).toEqual(['ok'])
    expect(result.failed.map((f) => f.id).sort()).toEqual(['broken', 'fail'])
    expect(bridge.pendingIds().sort()).toEqual(['broken', 'fail'])
  })

  it('deleteAccounts：库中账号经 kiro-rs 彻底删除，待导入直接丢弃', async () => {
    const id = seed(path, { uuid: 'db-1', refreshToken: 'rt' })
    raw.set('accountData', { accounts: { p: { id: 'p', credentials: {} } } })
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`)
      return jsonResponse(200, { success: true })
    }) as unknown as typeof fetch
    const bridge = new AccountDataBridge(db, raw, { fetchImpl })
    expect(await bridge.deleteAccounts(['db-1', 'p'], TARGET)).toEqual([])
    expect(calls).toEqual([`DELETE ${TARGET.baseUrl}/credentials/${id}?purge=true`])
    expect(bridge.pendingIds()).toEqual([])
    // kiro-rs 未就绪时库中账号删除失败并报告原因
    expect((await bridge.deleteAccounts(['db-1'], null))[0].reason).toMatch(/未运行/)
  })

  it('代理绑定：只在 proxy 有绑定且不同时下发，没有绑定不清除', async () => {
    const id = seed(path, { uuid: 'db-1', refreshToken: 'rt' })
    seed(path, { uuid: 'db-2', refreshToken: 'rt2' })
    const bodies: unknown[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push([url, JSON.parse(String(init?.body))])
      return jsonResponse(200, { success: true })
    }) as unknown as typeof fetch
    const bridge = new AccountDataBridge(db, raw, {
      fetchImpl,
      proxyUrlFor: (accountId) => (accountId === 'db-1' ? 'socks5://p:1' : undefined)
    })
    expect(await bridge.syncProxyBindings(TARGET)).toBe(1)
    expect(bodies).toEqual([
      [`${TARGET.baseUrl}/credentials/${id}/proxy`, { proxyUrl: 'socks5://p:1' }]
    ])
  })

  it('wrapStoreWithBridge 只拦截 accountData，其余透传（含对象形式 set）', () => {
    seed(path, { uuid: 'db-1', refreshToken: 'rt' })
    const bridge = new AccountDataBridge(db, raw)
    const wrapped = wrapStoreWithBridge(raw, bridge)
    wrapped.set('usageApiType', 'rest')
    expect(wrapped.get('usageApiType')).toBe('rest')
    ;(wrapped as unknown as { set(v: object): void }).set({
      accountData: { accounts: { 'db-1': { id: 'db-1', nickname: 'z' } } }
    })
    expect(db.listRows()[0].nickname).toBe('z')
    expect(Object.keys((wrapped.get('accountData') as { accounts: object }).accounts)).toEqual([
      'db-1'
    ])
    expect(wrapped.path).toBe(raw.path)
  })
})

describe('托管来源', () => {
  it('库中每个账号都映射为托管条目（proxy 不本地刷新）', () => {
    const path = createDb()
    seed(path, { uuid: 'a', refreshToken: 'rt', authMethod: 'idc' })
    seed(path, { uuid: 'b', kiroApiKey: 'ksk_b' })
    const db = new AccountDb(path)
    const entries = db.listRows().map(managedEntryOf)
    expect(entries.map((e) => [e.accountId, e.authMethod])).toEqual([
      ['a', 'idc'],
      ['b', 'api_key']
    ])
    db.close()
  })
})

describe('迁移', () => {
  function writeCredentials(dir: string, creds: unknown[]): string {
    const file = join(dir, 'credentials.json')
    writeFileSync(file, JSON.stringify(creds))
    return file
  }

  it('planMigration：登记表 / 相同凭据关联，冲突与无法导入单独列出', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-plan-'))
    const credentialsPath = writeCredentials(dir, [
      { id: 1, refreshToken: 'rt-1' },
      { id: 2, kiroApiKey: 'ksk_2' }
    ])
    const raw = new MemoryStore()
    raw.set('accountData', {
      accounts: {
        byRegistry: { id: 'byRegistry', email: 'a@x.io', credentials: { refreshToken: 'rotated' } },
        bySecret: {
          id: 'bySecret',
          email: 'a@x.io',
          credentials: { kiroApiKey: 'ksk_2', credentialKind: 'kiro_api_key', region: 'us-east-1' }
        },
        dup: { id: 'dup', credentials: { refreshToken: 'rt-1', authMethod: 'social' } },
        local: { id: 'local', credentials: { refreshToken: 'rt-local', authMethod: 'social' } },
        broken: { id: 'broken', credentials: {} }
      }
    })
    const plan = planMigration({
      config: defaultAccountDbConfig(),
      userDataDir: dir,
      rawStore: raw,
      registry: [{ accountId: 'byRegistry', credentialId: '1', authMethod: 'social', pushedAt: 1 }],
      kiroRsBinary: '/nonexistent',
      credentialsPath
    })
    expect(plan.linked).toEqual([
      { accountId: 'byRegistry', credentialId: 1, by: 'registry' },
      { accountId: 'bySecret', credentialId: 2, by: 'secret' }
    ])
    expect(plan.conflicts.map((c) => c.accountId)).toEqual(['dup'])
    expect(plan.toImport.sort()).toEqual(['dup', 'local'])
    expect(plan.notImportable.map((n) => n.accountId)).toEqual(['broken'])
    expect(plan.duplicateEmails).toEqual(['a@x.io'])
  })

  it('rollbackAccountDb：库中最新凭据写回，号池账号导出为 kiro-rs 凭据文件', () => {
    const path = createDb()
    seed(path, { uuid: 'pool', refreshToken: 'rt-latest', inPool: true })
    seed(path, { uuid: 'local', refreshToken: 'rt-local' })
    const dir = mkdtempSync(join(tmpdir(), 'rollback-'))
    const raw = new MemoryStore()
    raw.set('accountData', { theme: 'x', accounts: { pending: { id: 'pending' } } })
    const config = { ...defaultAccountDbConfig(), enabled: true, dbPath: path }
    const result = rollbackAccountDb({
      config,
      userDataDir: dir,
      rawStore: raw,
      credentialsDir: dir
    })
    const data = raw.get('accountData') as {
      theme: string
      accounts: Record<string, { credentials?: { refreshToken?: string } }>
    }
    expect(data.theme).toBe('x')
    expect(Object.keys(data.accounts).sort()).toEqual(['local', 'pending', 'pool'])
    expect(data.accounts.pool.credentials?.refreshToken).toBe('rt-latest')
    const exported = JSON.parse(readFileSync(result.credentialsFile, 'utf8'))
    expect(exported).toHaveLength(1)
    expect(exported[0].refreshToken).toBe('rt-latest')
    const saved = JSON.parse(readFileSync(join(dir, 'account-db.json'), 'utf8'))
    expect(saved.enabled).toBe(false)
  })
})
