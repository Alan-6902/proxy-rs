/**
 * proxy-rs 侧的共享账号库访问层。
 *
 * 写入分工（改造方案 §0.2）：proxy-rs 只写 account_ui（昵称、分组、标签、展示元数据），
 * 其余表由 kiro-rs 写。凭据、刷新、额度、入池、新增、删除都经 kiro-rs Admin API。
 * 唯一例外是离线迁移器（kiro-rs 未运行时），见 migrate.ts。
 *
 * 连接参数与 kiro-rs 一致（P0 验证过）：WAL + synchronous=FULL + fullfsync；只打开已存在的
 * 文件，路径写错不会静默建空库。
 */

import Database from 'better-sqlite3'

/** 与 kiro-rs `SCHEMA_VERSION` 一致；不一致拒绝读写 */
export const ACCOUNT_DB_SCHEMA_VERSION = 1
const BUSY_TIMEOUT_MS = 5000

/** 跨端变化中 proxy 需要关心的种类：UI 是自己写的，计数器变化太频繁且不影响卡片 */
const WATCHED_CHANGE_KINDS = ['accounts', 'account_credentials', 'account_usage'] as const

export interface AccountDbRow {
  id: number
  accountUuid: string
  credentialIdentity: string
  upstreamIdentity: string | null
  email: string | null
  inPool: boolean
  enabled: boolean
  disabledReason: string | null
  priority: number
  status: string
  lastError: string | null
  subscriptionTitle: string | null
  createdAtMs: number
  credentialVersion: number
  authKind: 'oauth' | 'api_key'
  authMethod: string
  accessToken: string | null
  refreshToken: string | null
  expiresAtMs: number | null
  kiroApiKey: string | null
  clientId: string | null
  clientSecret: string | null
  profileArn: string | null
  region: string | null
  authRegion: string | null
  apiRegion: string | null
  machineId: string | null
  endpoint: string | null
  proxyUrl: string | null
  provider: string | null
  startUrl: string | null
  extraJson: string
  rawUsageJson: string | null
  legacyUsageJson: string | null
  usageObservedAtMs: number | null
  usageSyncState: string
  usageError: string | null
  nickname: string | null
  groupId: string | null
  tagsJson: string
  metadataJson: string
  successCount: number
  lastUsedAtMs: number | null
}

export interface AccountUiFields {
  nickname: string | null
  groupId: string | null
  tags: string[]
  metadata: Record<string, unknown>
}

const SELECT_ROWS = `
  SELECT a.id, a.account_uuid AS accountUuid, a.credential_identity AS credentialIdentity,
         a.upstream_identity AS upstreamIdentity, a.email, a.in_pool AS inPool,
         a.enabled, a.disabled_reason AS disabledReason, a.priority, a.status,
         a.last_error AS lastError, a.subscription_title AS subscriptionTitle,
         a.created_at_ms AS createdAtMs,
         c.credential_version AS credentialVersion, c.auth_kind AS authKind,
         c.auth_method AS authMethod, c.access_token AS accessToken,
         c.refresh_token AS refreshToken, c.expires_at_ms AS expiresAtMs,
         c.kiro_api_key AS kiroApiKey, c.client_id AS clientId, c.client_secret AS clientSecret,
         c.profile_arn AS profileArn, c.region, c.auth_region AS authRegion,
         c.api_region AS apiRegion, c.machine_id AS machineId, c.endpoint,
         c.proxy_url AS proxyUrl, c.provider, c.start_url AS startUrl, c.extra_json AS extraJson,
         u.raw_json AS rawUsageJson, u.legacy_json AS legacyUsageJson,
         u.observed_at_ms AS usageObservedAtMs, u.sync_state AS usageSyncState,
         u.error_message AS usageError,
         ui.nickname, ui.group_id AS groupId, ui.tags_json AS tagsJson,
         ui.metadata_json AS metadataJson,
         COALESCE(n.success_count, 0) AS successCount, n.last_used_at_ms AS lastUsedAtMs
  FROM accounts a
  JOIN account_credentials c ON c.account_id = a.id
  LEFT JOIN account_usage u ON u.account_id = a.id
  LEFT JOIN account_ui ui ON ui.account_id = a.id
  LEFT JOIN account_counters n ON n.account_id = a.id
  WHERE a.deleted_at_ms IS NULL
  ORDER BY a.priority, a.id`

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export class AccountDb {
  private readonly db: Database.Database

  constructor(readonly path: string) {
    this.db = new Database(path, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS })
    const mode = this.db.pragma('journal_mode = WAL', { simple: true })
    if (String(mode).toLowerCase() !== 'wal') {
      this.db.close()
      throw new Error(`账号库无法启用 WAL（journal_mode=${String(mode)}）`)
    }
    this.db.pragma('synchronous = FULL')
    this.db.pragma('fullfsync = ON')
    this.db.pragma('checkpoint_fullfsync = ON')
    this.db.pragma('foreign_keys = ON')
    const version = Number(this.db.pragma('user_version', { simple: true }))
    if (version !== ACCOUNT_DB_SCHEMA_VERSION) {
      this.db.close()
      throw new Error(
        `账号库 schema 版本 ${version} 与本程序支持的 ${ACCOUNT_DB_SCHEMA_VERSION} 不一致，拒绝读写`
      )
    }
  }

  close(): void {
    this.db.close()
  }

  databaseId(): string {
    const row = this.db
      .prepare('SELECT database_id AS id FROM db_meta WHERE singleton = 1')
      .get() as { id: string } | undefined
    if (!row) throw new Error('账号库缺少 db_meta')
    return row.id
  }

  /** 全部未删除账号 */
  listRows(): AccountDbRow[] {
    return (this.db.prepare(SELECT_ROWS).all() as Array<Record<string, unknown>>).map((row) => ({
      ...(row as unknown as AccountDbRow),
      inPool: row.inPool === 1,
      enabled: row.enabled === 1
    }))
  }

  /** 已删除账号的 UUID（旧快照里还带着它们时据此忽略，防止"复活"） */
  deletedUuids(): Set<string> {
    const rows = this.db
      .prepare('SELECT account_uuid AS uuid FROM accounts WHERE deleted_at_ms IS NOT NULL')
      .all() as Array<{ uuid: string }>
    return new Set(rows.map((r) => r.uuid))
  }

  /** proxy 关心的跨端变化水位（单调递增；清理旧记录不影响最大值） */
  changeSeq(): number {
    const placeholders = WATCHED_CHANGE_KINDS.map(() => '?').join(', ')
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM account_changes WHERE kind IN (${placeholders})`
      )
      .get(...WATCHED_CHANGE_KINDS) as { seq: number }
    return row.seq
  }

  /** 全表水位（含 UI），用于投影缓存失效 */
  anyChangeSeq(): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM account_changes')
      .get() as {
      seq: number
    }
    return row.seq
  }

  /** 写 UI 字段；内容未变时不写（避免无意义的变更记录）。返回是否写入。 */
  writeUi(accountId: number, fields: AccountUiFields): boolean {
    const result = this.db
      .prepare(
        `UPDATE account_ui
         SET nickname = @nickname, group_id = @groupId, tags_json = @tagsJson,
             metadata_json = @metadataJson, row_version = row_version + 1, updated_at_ms = @now
         WHERE account_id = @accountId
           AND (nickname, group_id, tags_json, metadata_json)
               IS NOT (@nickname, @groupId, @tagsJson, @metadataJson)`
      )
      .run({
        accountId,
        nickname: fields.nickname,
        groupId: fields.groupId,
        tagsJson: stableJson(fields.tags ?? []),
        metadataJson: stableJson(fields.metadata ?? {}),
        now: Date.now()
      })
    return result.changes > 0
  }

  /**
   * 在线一致性备份（SQLite Backup API）。写入过程中另一端照常读写，备份得到的是某一时刻的
   * 完整快照；不能用直接复制 .sqlite3 文件代替（WAL 里还没 checkpoint 的事务会丢）。
   */
  async backupTo(destination: string): Promise<void> {
    await this.db.backup(destination)
  }

  /** 底层连接，仅供离线迁移器使用 */
  get connection(): Database.Database {
    return this.db
  }
}
