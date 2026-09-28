/**
 * 离线迁移：electron-store 账号 + kiro-rs credentials.json → 共享账号库（改造方案 §8）。
 *
 * 前提：旧的 kiro-rs（Docker 容器）已停止，没有别的进程在刷新这些 token。
 *
 * 步骤：
 * 1. 备份 electron-store 文件与 credentials.json（原文件不改、不删）
 * 2. `kiro-rs --migrate-from-json` 建库：kiro-rs 凭据保留数字 ID、全部在号池
 * 3. 已推给反代的 proxy 账号（登记表 credentialId，或 refresh token / API Key 相同）
 *    与库里那一行关联：account_uuid 改成 proxy 账号 ID，写入 UI 字段与旧额度；
 *    token 以 kiro-rs 为准（它是改造前真正在刷新的一方）
 * 4. 未关联的 proxy 账号留在 electron-store 作为"待导入"，下次正常启动时经 kiro-rs 导入
 * 5. 写 account-db.json 启用账号库模式
 *
 * 回滚：rollbackAccountDb 把库里的最新凭据写回 electron-store，并在 kiro-rs 配置目录
 * 生成一份 credentials.rollback-*.json（号池账号，保留 ID），不覆盖原文件。
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AdminManagedAccountEntry } from '../../shared/adminManaged'
import { AccountDb } from './db'
import {
  extraCredentialFields,
  toAccount,
  toImportRequest,
  toUiFields,
  type AccountLike
} from './projection'
import { checkPortFree } from './kiroRsProcess'
import {
  KIRO_RS_HOST,
  readKiroRsConnection,
  saveAccountDbConfig,
  ensureAccountDbDir,
  type AccountDbConfig
} from './runtime'
import type { RawStore } from './bridge'

interface KiroRsCredential {
  id?: number
  refreshToken?: string
  kiroApiKey?: string
  email?: string
  [key: string]: unknown
}

export interface MigrationPlan {
  kiroRsCredentials: number
  proxyAccounts: number
  /** proxy 账号 → 库里的 kiro-rs 凭据 ID */
  linked: Array<{ accountId: string; credentialId: number; by: 'registry' | 'secret' }>
  /** 将在下次启动时导入 kiro-rs 的 proxy 账号 */
  toImport: string[]
  /** 无法导入（缺字段等），保留在 electron-store 并在报告中列出 */
  notImportable: Array<{ accountId: string; reason: string }>
  /** 多个 proxy 账号指向同一凭据：只关联第一个，其余按导入处理（导入时会按凭据去重） */
  conflicts: Array<{ accountId: string; credentialId: number; reason: string }>
  /** 同一邮箱出现多次（不自动合并，仅提示） */
  duplicateEmails: string[]
}

export interface MigrationInput {
  config: AccountDbConfig
  userDataDir: string
  /** 未包装的 electron-store */
  rawStore: RawStore & { path: string }
  registry: AdminManagedAccountEntry[]
  kiroRsBinary: string
  credentialsPath: string
  proxyUrlFor?: (accountId: string, data: Record<string, unknown>) => string | undefined
  log?: (line: string) => void
}

function readKiroRsCredentials(path: string): KiroRsCredential[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8').trim()
  if (!text) return []
  const parsed = JSON.parse(text) as KiroRsCredential | KiroRsCredential[]
  return Array.isArray(parsed) ? parsed : [parsed]
}

function proxyAccounts(rawStore: RawStore): {
  data: Record<string, unknown>
  accounts: Record<string, AccountLike>
} {
  const data = (rawStore.get('accountData', null) ?? {}) as Record<string, unknown>
  return { data, accounts: (data.accounts ?? {}) as Record<string, AccountLike> }
}

export function planMigration(input: MigrationInput): MigrationPlan {
  const creds = readKiroRsCredentials(input.credentialsPath)
  const { data, accounts } = proxyAccounts(input.rawStore)
  const credById = new Map(creds.filter((c) => c.id !== undefined).map((c) => [c.id!, c]))
  const credBySecret = new Map<string, number>()
  for (const c of creds) {
    if (c.id === undefined) continue
    if (c.refreshToken) credBySecret.set(`rt:${c.refreshToken}`, c.id)
    if (c.kiroApiKey) credBySecret.set(`ak:${c.kiroApiKey}`, c.id)
  }
  const registryByAccount = new Map(input.registry.map((e) => [e.accountId, e]))

  const plan: MigrationPlan = {
    kiroRsCredentials: creds.length,
    proxyAccounts: Object.keys(accounts).length,
    linked: [],
    toImport: [],
    notImportable: [],
    conflicts: [],
    duplicateEmails: []
  }
  const claimed = new Map<number, string>()
  const emails = new Map<string, number>()

  for (const [accountId, account] of Object.entries(accounts)) {
    const email = typeof account.email === 'string' ? account.email.trim().toLowerCase() : ''
    if (email) emails.set(email, (emails.get(email) ?? 0) + 1)

    const credentials = (account.credentials ?? {}) as Record<string, unknown>
    const registryId = Number(registryByAccount.get(accountId)?.credentialId)
    let target: { id: number; by: 'registry' | 'secret' } | undefined
    if (Number.isInteger(registryId) && credById.has(registryId)) {
      target = { id: registryId, by: 'registry' }
    } else {
      const rt = typeof credentials.refreshToken === 'string' ? credentials.refreshToken : ''
      const ak = typeof credentials.kiroApiKey === 'string' ? credentials.kiroApiKey : ''
      const bySecret = credBySecret.get(`rt:${rt}`) ?? credBySecret.get(`ak:${ak}`)
      if (bySecret !== undefined && (rt || ak)) target = { id: bySecret, by: 'secret' }
    }

    if (target) {
      const owner = claimed.get(target.id)
      if (owner) {
        plan.conflicts.push({
          accountId,
          credentialId: target.id,
          reason: `凭据 #${target.id} 已关联账号 ${owner}`
        })
      } else {
        claimed.set(target.id, accountId)
        plan.linked.push({ accountId, credentialId: target.id, by: target.by })
        continue
      }
    }
    const request = toImportRequest(
      { ...account, id: accountId },
      input.proxyUrlFor?.(accountId, data)
    )
    if (request.ok) plan.toImport.push(accountId)
    else plan.notImportable.push({ accountId, reason: request.reason })
  }
  plan.duplicateEmails = [...emails].filter(([, n]) => n > 1).map(([email]) => email)
  return plan
}

export function formatPlan(plan: MigrationPlan): string {
  const lines = [
    `kiro-rs 凭据：${plan.kiroRsCredentials}`,
    `proxy 账号：${plan.proxyAccounts}`,
    `  关联到已有凭据：${plan.linked.length}（登记表 ${plan.linked.filter((l) => l.by === 'registry').length}，凭据相同 ${plan.linked.filter((l) => l.by === 'secret').length}）`,
    `  启动后导入 kiro-rs：${plan.toImport.length}`,
    `  无法导入（保留在本地，需处理）：${plan.notImportable.length}`,
    `  冲突（多个账号指向同一凭据）：${plan.conflicts.length}`,
    `重复邮箱（不自动合并）：${plan.duplicateEmails.length}`
  ]
  for (const item of plan.notImportable)
    lines.push(`  - 无法导入 ${item.accountId}：${item.reason}`)
  for (const item of plan.conflicts) lines.push(`  - 冲突 ${item.accountId}：${item.reason}`)
  return lines.join('\n')
}

function backupFile(source: string, dir: string): void {
  if (!existsSync(source)) return
  const target = join(dir, basename(source))
  copyFileSync(source, target)
  chmodSync(target, 0o600)
}

export async function runMigration(
  input: MigrationInput,
  options: { dryRun: boolean }
): Promise<MigrationPlan> {
  const log = input.log ?? console.log
  const plan = planMigration(input)
  log(formatPlan(plan))
  if (options.dryRun) {
    log('dry-run：未做任何修改')
    return plan
  }

  const { config } = input
  if (existsSync(config.dbPath)) throw new Error(`账号库已存在，拒绝重复迁移：${config.dbPath}`)
  const { port } = readKiroRsConnection(config.kiroRs.configPath, config.kiroRs.port)
  if (!(await checkPortFree(KIRO_RS_HOST, port))) {
    throw new Error(
      `端口 ${port} 仍被占用：请先停止 Docker 中的 kiro-rs，确保迁移期间没有进程在刷新 token`
    )
  }
  if (!existsSync(input.kiroRsBinary)) throw new Error(`找不到 kiro-rs：${input.kiroRsBinary}`)

  // 1. 备份
  ensureAccountDbDir(config.dbPath)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(dirname(config.dbPath), `migration-backup-${stamp}`)
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  backupFile(input.rawStore.path, backupDir)
  backupFile(input.credentialsPath, backupDir)
  backupFile(join(dirname(input.credentialsPath), 'kiro_stats.json'), backupDir)
  log(`已备份到 ${backupDir}`)

  // 2. kiro-rs 建库
  const migrated = spawnSync(
    input.kiroRsBinary,
    [
      '-c',
      config.kiroRs.configPath,
      '--credentials',
      input.credentialsPath,
      '--account-db',
      config.dbPath,
      '--migrate-from-json'
    ],
    { encoding: 'utf8' }
  )
  if (migrated.status !== 0) {
    throw new Error(
      `kiro-rs 迁移失败：${(migrated.stderr || migrated.stdout).trim().split('\n').pop()}`
    )
  }
  chmodSync(config.dbPath, 0o600)

  // 3. 关联已推给反代的 proxy 账号（kiro-rs 未运行，proxy 此时是唯一写入方）
  const { data, accounts } = proxyAccounts(input.rawStore)
  const db = new AccountDb(config.dbPath)
  try {
    const conn = db.connection
    const link = conn.transaction(() => {
      for (const item of plan.linked) {
        const account = accounts[item.accountId]
        const credentials = (account.credentials ?? {}) as Record<string, unknown>
        const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
        conn
          .prepare('UPDATE accounts SET account_uuid = ?, email = COALESCE(email, ?) WHERE id = ?')
          .run(item.accountId, str(account.email), item.credentialId)
        conn
          .prepare(
            `UPDATE account_credentials
             SET profile_arn = COALESCE(profile_arn, ?), client_id = COALESCE(client_id, ?),
                 client_secret = COALESCE(client_secret, ?), provider = ?, start_url = ?,
                 extra_json = ?
             WHERE account_id = ?`
          )
          .run(
            str(credentials.profileArn) ?? str(account.profileArn),
            str(credentials.clientId),
            str(credentials.clientSecret),
            str(credentials.provider),
            str(credentials.startUrl),
            JSON.stringify(extraCredentialFields(credentials)),
            item.credentialId
          )
        conn
          .prepare(
            'UPDATE account_usage SET legacy_json = ? WHERE account_id = ? AND raw_json IS NULL'
          )
          .run(
            JSON.stringify({ usage: account.usage, subscription: account.subscription }),
            item.credentialId
          )
        db.writeUi(item.credentialId, toUiFields(account))
      }
    })
    link()
  } finally {
    db.close()
  }

  // 4. 已关联的账号从 electron-store 移除，其余留作待导入
  const linkedIds = new Set(plan.linked.map((l) => l.accountId))
  input.rawStore.set('accountData', {
    ...data,
    accounts: Object.fromEntries(Object.entries(accounts).filter(([id]) => !linkedIds.has(id)))
  })

  // 5. 启用账号库模式
  saveAccountDbConfig(input.userDataDir, { ...config, enabled: true })
  log(`迁移完成：${config.dbPath}；下次启动 proxy-rs 即以账号库模式运行`)
  return plan
}

/** 回滚：库中最新凭据写回 electron-store；为 kiro-rs 生成 credentials.rollback-*.json */
export function rollbackAccountDb(input: {
  config: AccountDbConfig
  userDataDir: string
  rawStore: RawStore
  credentialsDir: string
  log?: (line: string) => void
}): { restoredAccounts: number; credentialsFile: string } {
  const log = input.log ?? console.log
  const db = new AccountDb(input.config.dbPath)
  try {
    const rows = db.listRows()
    const { data, accounts: pending } = proxyAccounts(input.rawStore)
    const restored: Record<string, AccountLike> = { ...pending }
    for (const row of rows) {
      const account = toAccount(row)
      delete account.accountDb
      restored[row.accountUuid] = account
    }
    input.rawStore.set('accountData', { ...data, accounts: restored })

    const credentials = rows
      .filter((row) => row.inPool)
      .map((row) => ({
        id: row.id,
        credentialIdentity: row.credentialIdentity,
        accessToken: row.accessToken ?? undefined,
        refreshToken: row.refreshToken ?? undefined,
        profileArn: row.profileArn ?? undefined,
        expiresAt: row.expiresAtMs ? new Date(row.expiresAtMs).toISOString() : undefined,
        authMethod: row.authMethod,
        clientId: row.clientId ?? undefined,
        clientSecret: row.clientSecret ?? undefined,
        priority: row.priority || undefined,
        region: row.region ?? undefined,
        authRegion: row.authRegion ?? undefined,
        apiRegion: row.apiRegion ?? undefined,
        machineId: row.machineId ?? undefined,
        email: row.email ?? undefined,
        subscriptionTitle: row.subscriptionTitle ?? undefined,
        proxyUrl: row.proxyUrl ?? undefined,
        disabled: !row.enabled,
        kiroApiKey: row.kiroApiKey ?? undefined,
        endpoint: row.endpoint ?? undefined
      }))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const credentialsFile = join(input.credentialsDir, `credentials.rollback-${stamp}.json`)
    writeFileSync(credentialsFile, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
    saveAccountDbConfig(input.userDataDir, { ...input.config, enabled: false })
    log(
      `已回滚：${rows.length} 个账号写回 electron-store；kiro-rs 号池凭据导出到 ${credentialsFile}（未覆盖 credentials.json）`
    )
    return { restoredAccounts: rows.length, credentialsFile }
  } finally {
    db.close()
  }
}
