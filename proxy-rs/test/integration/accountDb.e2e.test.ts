/**
 * 端到端：真实 kiro-rs 二进制 + proxy 侧迁移器 / 子进程托管 / 账号库桥。
 *
 * 只用假凭据；kiro-rs 配置的全局代理指向本地不存在的端口，任何上游请求都在本机失败，
 * 不会有数据发往外部。kiro-rs 未构建（target/release/kiro-rs 不存在）时跳过。
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountDb } from '../../src/main/accountDb/db'
import { AccountDataBridge, type RawStore } from '../../src/main/accountDb/bridge'
import { KiroRsProcess } from '../../src/main/accountDb/kiroRsProcess'
import { runMigration } from '../../src/main/accountDb/migrate'
import { adminRequest } from '../../src/main/accountDb/adminApi'
import type { AccountDbConfig } from '../../src/main/accountDb/runtime'

const BIN = resolve(import.meta.dirname, '../../../kiro-rs-src/target/release/kiro-rs')

class MemoryStore implements RawStore {
  data = new Map<string, unknown>()
  constructor(readonly path: string) {}
  get(key: string, defaultValue?: unknown): unknown {
    return this.data.has(key) ? structuredClone(this.data.get(key)) : defaultValue
  }
  set(key: string, value: unknown): void {
    this.data.set(key, structuredClone(value))
  }
}

async function freePort(): Promise<number> {
  return await new Promise((done) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => done(port))
    })
  })
}

describe.skipIf(!existsSync(BIN))('账号库端到端（真实 kiro-rs）', () => {
  it('迁移 → 拉起子进程 → 导入新账号 → 改 UI → 删除', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'account-db-e2e-'))
    const port = await freePort()
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        host: '0.0.0.0',
        port,
        apiKey: 'e2e-api-key-000000',
        adminApiKey: 'e2e-admin-key-000000',
        region: 'us-east-1',
        proxyUrl: 'http://127.0.0.1:9'
      })
    )
    const credentialsPath = join(dir, 'credentials.json')
    writeFileSync(
      credentialsPath,
      JSON.stringify([
        { id: 4, authMethod: 'api_key', kiroApiKey: 'ksk_e2ePool0001', email: 'pool@example.com' }
      ])
    )
    const storeFile = join(dir, 'proxy-store.json')
    writeFileSync(storeFile, '{}')
    const raw = new MemoryStore(storeFile)
    raw.set('accountData', {
      theme: 'dark',
      groups: { g1: { id: 'g1', name: 'G1' } },
      accounts: {
        // 与 kiro-rs 凭据相同 → 迁移时关联
        'proxy-linked': {
          id: 'proxy-linked',
          email: 'pool@example.com',
          nickname: '已推送',
          groupId: 'g1',
          tags: ['t1'],
          credentials: {
            credentialKind: 'kiro_api_key',
            kiroApiKey: 'ksk_e2ePool0001',
            region: 'us-east-1'
          },
          usage: { current: 1, limit: 10 }
        },
        // 只在 proxy 的账号 → 启动后经 kiro-rs 导入
        'proxy-local': {
          id: 'proxy-local',
          email: 'local@example.com',
          nickname: '本地号',
          credentials: {
            credentialKind: 'kiro_api_key',
            kiroApiKey: 'ksk_e2eLocal0002',
            region: 'us-east-1'
          }
        }
      }
    })
    const config: AccountDbConfig = {
      enabled: false,
      dbPath: join(dir, 'data', 'accounts.sqlite3'),
      kiroRs: { configPath, manage: true }
    }

    // 1. 迁移
    const plan = await runMigration(
      {
        config,
        userDataDir: dir,
        rawStore: raw,
        registry: [],
        kiroRsBinary: BIN,
        credentialsPath,
        log: () => {}
      },
      { dryRun: false }
    )
    expect(plan.linked).toEqual([{ accountId: 'proxy-linked', credentialId: 4, by: 'secret' }])
    expect(plan.toImport).toEqual(['proxy-local'])

    const db = new AccountDb(config.dbPath)
    let rows = db.listRows()
    expect(rows.map((r) => [r.id, r.accountUuid, r.nickname, r.inPool])).toEqual([
      [4, 'proxy-linked', '已推送', true]
    ])
    const bridge = new AccountDataBridge(db, raw)
    expect(bridge.pendingIds()).toEqual(['proxy-local'])

    // 2. 拉起 kiro-rs 子进程
    const proc = new KiroRsProcess({
      binary: BIN,
      configPath,
      dbPath: config.dbPath,
      host: '127.0.0.1',
      port,
      adminApiKey: 'e2e-admin-key-000000',
      expectedDatabaseId: db.databaseId()
    })
    await proc.start()
    try {
      const target = proc.target()!

      // 3. 导入待导入账号（不入池）
      const synced = await bridge.syncPending(target)
      expect(synced).toEqual({ imported: ['proxy-local'], failed: [] })
      rows = db.listRows()
      const local = rows.find((r) => r.accountUuid === 'proxy-local')!
      expect(local.inPool).toBe(false)
      expect(local.nickname).toBe('本地号')
      expect(bridge.pendingIds()).toEqual([])

      // Admin 列表保持号池语义：只有已入池的那个
      const pool = await adminRequest<{ credentials: Array<{ id: number }> }>(
        target,
        '/credentials'
      )
      expect(pool.credentials.map((c) => c.id)).toEqual([4])
      const all = await adminRequest<{ credentials: Array<{ id: number }> }>(
        target,
        '/credentials?all=true'
      )
      expect(all.credentials.map((c) => c.id).sort()).toEqual([4, local.id])

      // 4. proxy 改 UI：只写 account_ui；旧快照里的凭据不会覆盖库
      const data = bridge.get(null)!
      expect(data.theme).toBe('dark')
      const accounts = data.accounts!
      accounts['proxy-local'].nickname = '改名'
      ;(accounts['proxy-local'].credentials as Record<string, unknown>).kiroApiKey = 'ksk_STALE0'
      bridge.set(data)
      rows = db.listRows()
      const after = rows.find((r) => r.accountUuid === 'proxy-local')!
      expect(after.nickname).toBe('改名')
      expect(after.kiroApiKey).toBe('ksk_e2eLocal0002')

      // 5. "推送到反代"：Admin 添加同一凭据 = 入池
      await adminRequest(target, '/credentials', {
        method: 'POST',
        body: { authMethod: 'api_key', kiroApiKey: 'ksk_e2eLocal0002' }
      })
      expect(db.listRows().find((r) => r.accountUuid === 'proxy-local')!.inPool).toBe(true)

      // 6. 删除账号
      expect(await bridge.deleteAccounts(['proxy-local'], target)).toEqual([])
      expect(db.listRows().map((r) => r.accountUuid)).toEqual(['proxy-linked'])
      // 已删除账号出现在旧快照里也不会复活
      bridge.set({ accounts: { 'proxy-local': { id: 'proxy-local', credentials: {} } } })
      expect(bridge.pendingIds()).toEqual([])
    } finally {
      await proc.stop()
      db.close()
    }
  })
})
