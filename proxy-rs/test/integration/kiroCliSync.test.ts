import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  adoptKiroCliIntoAccountDb,
  KIRO_CLI_NOT_IN_DB_RECHECK_MS,
  hashRefreshToken,
  readKiroCliSyncState,
  syncKiroCliFromAccountDb,
  writeKiroCliSyncState,
  KIRO_CLI_SYNC_KEY,
  type KiroCliSyncState,
  type KiroCliSyncStore
} from '../../src/main/accountDb/kiroCliSync'
import {
  buildKiroCliRefreshSyncSql,
  KIRO_CLI_AUTH_KEY,
  type KiroCliCurrentToken,
  type KiroCliRefreshedCredentials
} from '../../src/main/kiroCli/cliCredentials'
import type { AccountDbRow } from '../../src/main/accountDb/db'

function memoryStore(initial?: unknown): KiroCliSyncStore & { value: unknown } {
  return {
    value: initial,
    get(key: string, defaultValue?: unknown) {
      return key === KIRO_CLI_SYNC_KEY ? (this.value ?? defaultValue) : defaultValue
    },
    set(key: string, value: unknown) {
      if (key === KIRO_CLI_SYNC_KEY) this.value = value
    },
    delete(key: string) {
      if (key === KIRO_CLI_SYNC_KEY) this.value = undefined
    }
  }
}

function row(overrides: Partial<AccountDbRow> = {}): AccountDbRow {
  return {
    id: 7,
    accountUuid: 'acc-1',
    credentialIdentity: 'ident',
    upstreamIdentity: null,
    email: null,
    inPool: true,
    enabled: true,
    disabledReason: null,
    priority: 0,
    status: 'ready',
    lastError: null,
    subscriptionTitle: null,
    createdAtMs: 1,
    credentialVersion: 2,
    authKind: 'oauth',
    authMethod: 'social',
    accessToken: 'at-new',
    refreshToken: 'rt-new',
    expiresAtMs: Date.now() + 3_600_000,
    kiroApiKey: null,
    clientId: null,
    clientSecret: null,
    profileArn: null,
    region: null,
    authRegion: null,
    apiRegion: null,
    machineId: null,
    endpoint: null,
    proxyUrl: null,
    provider: 'Google',
    startUrl: null,
    extraJson: '{}',
    rawUsageJson: null,
    legacyUsageJson: null,
    usageObservedAtMs: null,
    usageSyncState: 'never',
    usageError: null,
    nickname: null,
    groupId: null,
    tagsJson: '[]',
    metadataJson: '{}',
    successCount: 0,
    lastUsedAtMs: null,
    ...overrides
  }
}

describe('CLI 同步状态', () => {
  it('只存哈希，不落 token 明文', () => {
    const store = memoryStore()
    writeKiroCliSyncState(store, {
      accountId: 'acc-1',
      refreshTokenHash: hashRefreshToken('rt-old'),
      credentialVersion: 1
    })
    expect(JSON.stringify(store.value)).not.toContain('rt-old')
    expect(readKiroCliSyncState(store)?.refreshTokenHash).toBe(
      createHash('sha256').update('rt-old').digest('hex')
    )
  })

  it('结构损坏时视为没有映射', () => {
    expect(readKiroCliSyncState(memoryStore({ accountId: 1 }))).toBeNull()
    expect(readKiroCliSyncState(memoryStore(null))).toBeNull()
  })
})

type CliWrite = (
  oldRefreshToken: string,
  refreshed: KiroCliRefreshedCredentials,
  dbPath?: string
) => Promise<void>
type WriteMock = ReturnType<typeof vi.fn<CliWrite>>

describe('syncKiroCliFromAccountDb', () => {
  const state = {
    accountId: 'acc-1',
    refreshTokenHash: hashRefreshToken('rt-old'),
    credentialVersion: 1
  }

  function harness(
    current: KiroCliCurrentToken | null,
    stored = state
  ): {
    store: ReturnType<typeof memoryStore>
    write: WriteMock
    readCurrent: () => Promise<KiroCliCurrentToken | null>
  } {
    return {
      store: memoryStore(stored),
      write: vi.fn<CliWrite>(async () => {}),
      readCurrent: async () => current
    }
  }

  it('社交账号：版本变化时用 CLI 当前 token 匹配并写入新凭据', async () => {
    const { store, write, readCurrent } = harness({
      key: KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN,
      refreshToken: 'rt-old',
      provider: 'google'
    })
    const outcome = await syncKiroCliFromAccountDb({ store, row: row(), readCurrent, write })
    expect(outcome).toEqual({ status: 'synced', accountId: 'acc-1', credentialVersion: 2 })
    expect(write).toHaveBeenCalledOnce()
    const [oldToken, refreshed] = write.mock.calls[0]
    expect(oldToken).toBe('rt-old')
    expect(refreshed).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' })
    // 映射推进到新版本与新哈希，下一轮不会重复写
    expect(readKiroCliSyncState(store)).toEqual({
      accountId: 'acc-1',
      refreshTokenHash: hashRefreshToken('rt-new'),
      credentialVersion: 2
    })
    const again = await syncKiroCliFromAccountDb({
      store,
      row: row(),
      readCurrent: async () => ({ key: KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN, refreshToken: 'rt-new' }),
      write
    })
    expect(again.status).toBe('skipped')
    expect(write).toHaveBeenCalledOnce()
  })

  it('IdC 账号同样同步（CLI 里是 odic 键）', async () => {
    const { store, write, readCurrent } = harness({
      key: KIRO_CLI_AUTH_KEY.OIDC_TOKEN,
      refreshToken: 'rt-old'
    })
    const outcome = await syncKiroCliFromAccountDb({
      store,
      row: row({ authMethod: 'idc', provider: 'BuilderId', clientId: 'cid', clientSecret: 'sec' }),
      readCurrent,
      write
    })
    expect(outcome.status).toBe('synced')
    expect(write).toHaveBeenCalledOnce()
  })

  it('CLI 里的凭据不是管理器写的那份：放弃同步并清掉映射', async () => {
    const { store, write, readCurrent } = harness({
      key: KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN,
      refreshToken: 'rt-user-logged-in-manually'
    })
    const outcome = await syncKiroCliFromAccountDb({ store, row: row(), readCurrent, write })
    expect(outcome.status).toBe('detached')
    expect(write).not.toHaveBeenCalled()
    expect(readKiroCliSyncState(store)).toBeNull()
  })

  it('CLI 已退出登录：清掉映射', async () => {
    const { store, write, readCurrent } = harness(null)
    const outcome = await syncKiroCliFromAccountDb({ store, row: row(), readCurrent, write })
    expect(outcome.status).toBe('detached')
    expect(readKiroCliSyncState(store)).toBeNull()
  })

  it('账号已从库中删除：清掉映射', async () => {
    const { store, write, readCurrent } = harness({
      key: KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN,
      refreshToken: 'rt-old'
    })
    const outcome = await syncKiroCliFromAccountDb({ store, row: null, readCurrent, write })
    expect(outcome.status).toBe('detached')
    expect(write).not.toHaveBeenCalled()
  })

  it('kiro-rs 刷新失败标记 reauth_required：报需要重新登录，不覆盖 CLI', async () => {
    const { store, write, readCurrent } = harness({
      key: KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN,
      refreshToken: 'rt-old'
    })
    const outcome = await syncKiroCliFromAccountDb({
      store,
      row: row({ status: 'reauth_required' }),
      readCurrent,
      write
    })
    expect(outcome).toEqual({ status: 'needs-reauth', accountId: 'acc-1' })
    expect(write).not.toHaveBeenCalled()
    // 映射保留：重新登录后还要继续同步
    expect(readKiroCliSyncState(store)).not.toBeNull()
  })

  it('没有映射（CLI 不是管理器切的号）时什么都不做', async () => {
    const store = memoryStore()
    const write = vi.fn<CliWrite>(async () => {})
    const outcome = await syncKiroCliFromAccountDb({ store, row: row(), write })
    expect(outcome.status).toBe('skipped')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('同步 SQL', () => {
  it('只更新 refresh_token 与旧值相同的那条，社交与 IdC 两个键都覆盖', () => {
    const sql = buildKiroCliRefreshSyncSql('rt-old', {
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresIn: 3600
    })
    expect(sql).toContain(KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN)
    expect(sql).toContain(KIRO_CLI_AUTH_KEY.OIDC_TOKEN)
    expect(sql).toContain("json_extract(value, '$.refresh_token') = 'rt-old'")
    expect(sql).toContain("'$.access_token', 'at-new'")
    expect(sql.startsWith('BEGIN IMMEDIATE;')).toBe(true)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
  })

  it('上游没轮换 refresh token 时沿用旧值', () => {
    const sql = buildKiroCliRefreshSyncSql('rt-old', { accessToken: 'at-new' })
    expect(sql).toContain("'$.refresh_token', 'rt-old'")
  })
})

describe('CLI 数据库真实读写', () => {
  it('切号写入后能读回；同步只改匹配的那条，不碰别的账号', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const Database = (await import('better-sqlite3')).default
    const { buildKiroCliSwitchSql, readKiroCliCurrentToken, syncRefreshedKiroCliCredentials } =
      await import('../../src/main/kiroCli/cliCredentials')

    const dbPath = join(mkdtempSync(join(tmpdir(), 'kiro-cli-')), 'data.sqlite3')
    const db = new Database(dbPath)
    db.exec(
      'CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT);'
    )
    // 另一个账号的遗留条目：同步不该动它
    db.prepare('INSERT INTO auth_kv VALUES (?, ?)').run(
      'codewhisperer:odic:token',
      JSON.stringify({ refresh_token: 'rt-other', access_token: 'at-other' })
    )
    db.close()

    // 切号（社交）
    const write = new Database(dbPath)
    write.exec(
      buildKiroCliSwitchSql({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresAt: new Date().toISOString(),
        region: 'us-east-1',
        socialProvider: 'Google'
      })
    )
    write.close()

    const current = await readKiroCliCurrentToken(dbPath)
    expect(current).toMatchObject({
      key: KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN,
      refreshToken: 'rt-1',
      provider: 'google'
    })

    // 同步 kiro-rs 的续期结果
    await syncRefreshedKiroCliCredentials(
      'rt-1',
      { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 3600 },
      dbPath
    )
    expect((await readKiroCliCurrentToken(dbPath))?.refreshToken).toBe('rt-2')
    const after = new Database(dbPath)
    const social = JSON.parse(
      (
        after
          .prepare('SELECT value FROM auth_kv WHERE key = ?')
          .get(KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN) as { value: string }
      ).value
    )
    expect(social.access_token).toBe('at-2')
    // 切号已清掉旧版键，同步也没有把它带回来
    expect(after.prepare('SELECT COUNT(*) c FROM auth_kv').get()).toEqual({ c: 1 })
    after.close()
  })
})

describe('adoptKiroCliIntoAccountDb（CLI 自己刷新过 → 收编进账号库）', () => {
  const cliToken = (overrides: Partial<KiroCliCurrentToken> = {}): KiroCliCurrentToken => ({
    key: KIRO_CLI_AUTH_KEY.SOCIAL_TOKEN,
    refreshToken: 'rt-cli',
    accessToken: 'at-cli',
    expiresAtMs: Date.now() + 3_600_000,
    provider: 'github',
    region: 'us-east-1',
    ...overrides
  })
  const synced = (refreshToken: string, credentialVersion = 2): KiroCliSyncState => ({
    accountId: 'acc-1',
    refreshTokenHash: hashRefreshToken(refreshToken),
    credentialVersion
  })

  it('CLI 自己刷新过：交给 kiro-rs 收编，并把映射更新到新凭据与新版本', async () => {
    const store = memoryStore(synced('rt-new'))
    const adopt = vi.fn(async () => ({
      outcome: 'adopted' as const,
      credentialId: 7,
      credentialVersion: 3
    }))
    const outcome = await adoptKiroCliIntoAccountDb({
      store,
      rows: [row()],
      adopt,
      notInDb: new Map(),
      readCurrent: async () => cliToken()
    })
    expect(outcome).toEqual({ status: 'adopted', accountId: 'acc-1', credentialVersion: 3 })
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        accountUuid: 'acc-1',
        authMethod: 'social',
        accessToken: 'at-cli',
        refreshToken: 'rt-cli'
      })
    )
    expect(readKiroCliSyncState(store)).toEqual(synced('rt-cli', 3))
  })

  it('CLI 与库里是同一份：不调 kiro-rs，只补映射', async () => {
    const store = memoryStore()
    const adopt = vi.fn()
    const outcome = await adoptKiroCliIntoAccountDb({
      store,
      rows: [row({ refreshToken: 'rt-cli' })],
      adopt,
      notInDb: new Map(),
      readCurrent: async () => cliToken()
    })
    expect(outcome).toEqual({ status: 'linked', accountId: 'acc-1' })
    expect(adopt).not.toHaveBeenCalled()
    expect(readKiroCliSyncState(store)?.refreshTokenHash).toBe(hashRefreshToken('rt-cli'))
  })

  it('CLI 仍是上次写进去的那份：交给正向同步，不收编', async () => {
    const adopt = vi.fn()
    const outcome = await adoptKiroCliIntoAccountDb({
      store: memoryStore(synced('rt-cli')),
      rows: [row()],
      adopt,
      notInDb: new Map(),
      readCurrent: async () => cliToken()
    })
    expect(outcome.status).toBe('skipped')
    expect(adopt).not.toHaveBeenCalled()
  })

  it('不在账号库中：清掉映射，10 分钟内不再问 kiro-rs', async () => {
    const store = memoryStore(synced('rt-new'))
    const notInDb = new Map<string, number>()
    const adopt = vi.fn(async () => ({ outcome: 'not_found' as const }))
    let now = 1_000
    const run = (): ReturnType<typeof adoptKiroCliIntoAccountDb> =>
      adoptKiroCliIntoAccountDb({
        store,
        rows: [row()],
        adopt,
        notInDb,
        now: () => now,
        readCurrent: async () => cliToken()
      })
    expect(await run()).toEqual({ status: 'not-in-db' })
    expect(readKiroCliSyncState(store)).toBeNull()
    expect((await run()).status).toBe('skipped')
    now += KIRO_CLI_NOT_IN_DB_RECHECK_MS
    await run()
    expect(adopt).toHaveBeenCalledTimes(2)
  })

  it('CLI 里这份比库里旧：记下映射让正向同步把新凭据写给 CLI', async () => {
    const store = memoryStore()
    const outcome = await adoptKiroCliIntoAccountDb({
      store,
      rows: [row()],
      adopt: async () => ({ outcome: 'stale', credentialId: 7, credentialVersion: 2 }),
      notInDb: new Map(),
      readCurrent: async () => cliToken()
    })
    expect(outcome).toEqual({ status: 'linked', accountId: 'acc-1' })
    expect(readKiroCliSyncState(store)).toEqual({
      accountId: 'acc-1',
      refreshTokenHash: hashRefreshToken('rt-cli'),
      credentialVersion: -1
    })
  })

  it('IdC：带上 CLI 自己的客户端注册；缺注册时跳过', async () => {
    const adopt = vi.fn(async () => ({
      outcome: 'adopted' as const,
      credentialId: 7,
      credentialVersion: 3
    }))
    const idc = cliToken({
      key: KIRO_CLI_AUTH_KEY.OIDC_TOKEN,
      clientId: 'cid',
      clientSecret: 'csec'
    })
    await adoptKiroCliIntoAccountDb({
      store: memoryStore(),
      rows: [row()],
      adopt,
      notInDb: new Map(),
      readCurrent: async () => idc
    })
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ authMethod: 'idc', clientId: 'cid', clientSecret: 'csec' })
    )
    const skipped = await adoptKiroCliIntoAccountDb({
      store: memoryStore(),
      rows: [row()],
      adopt,
      notInDb: new Map(),
      readCurrent: async () => ({ ...idc, clientSecret: undefined })
    })
    expect(skipped.status).toBe('skipped')
    expect(adopt).toHaveBeenCalledTimes(1)
  })

  it('kiro-rs 调用失败：返回失败，不改映射', async () => {
    const store = memoryStore(synced('rt-new'))
    const outcome = await adoptKiroCliIntoAccountDb({
      store,
      rows: [row()],
      adopt: async () => {
        throw new Error('kiro-rs 未就绪')
      },
      notInDb: new Map(),
      readCurrent: async () => cliToken()
    })
    expect(outcome).toEqual({ status: 'failed', error: 'kiro-rs 未就绪' })
    expect(readKiroCliSyncState(store)).toEqual(synced('rt-new'))
  })
})
