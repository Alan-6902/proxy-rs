//! Qoder 账号库：独立 SQLite 文件（qoder.sqlite3），与 Kiro / Antigravity 互不相干
//!
//! 连接参数沿用账号库约定（WAL、FULL 同步、busy_timeout）。请求路径只读内存快照；
//! 成功 / 失败计数先在内存累加，由 [`QoderStore::flush_counts`] 批量落盘。
//!
//! PAT / access token / refresh token 不落 SQLite：`pat` 列恒为空串、两个 token 列恒为 NULL，
//! 凭证只在 [`SecretVault`]（生产为 macOS 钥匙串）里，按 uid 合并进内存快照。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, bail};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::vault::{SecretMap, SecretVault, Secrets};
use crate::common::sqlite;
use crate::kiro::account_store::now_ms;

/// 当前 schema 版本 = 迁移脚本条数；库里的 user_version 落后时按顺序补跑
pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;
const ENABLED_MODEL_IDS_KEY: &str = "enabled_model_ids";
const MODEL_OVERRIDES_KEY: &str = "model_overrides";
/// 账号库文件权限：仅属主可读写
#[cfg(unix)]
const OWNER_ONLY_MODE: u32 = 0o600;

const MIGRATION_0001: &str = "
CREATE TABLE accounts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    uid              TEXT NOT NULL UNIQUE,
    name             TEXT,
    email            TEXT,
    pat              TEXT NOT NULL,
    access_token     TEXT,
    refresh_token    TEXT,
    expires_at_ms    INTEGER,
    user_type        TEXT,
    org_id           TEXT,
    org_name         TEXT,
    disabled         INTEGER NOT NULL DEFAULT 0,
    quota_json       TEXT,
    quota_updated_ms INTEGER,
    last_error       TEXT,
    last_used_ms     INTEGER,
    success_count    INTEGER NOT NULL DEFAULT 0,
    failure_count    INTEGER NOT NULL DEFAULT 0,
    created_ms       INTEGER NOT NULL,
    updated_ms       INTEGER NOT NULL
);
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

/// v2：累计消耗。`consumed_total` 跨额度周期累加，`quota_used_base` 是上次快照里本周期的已用量
const MIGRATION_0002: &str = "
ALTER TABLE accounts ADD COLUMN consumed_total REAL NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN quota_used_base REAL;
";

const MIGRATIONS: [&str; 2] = [MIGRATION_0001, MIGRATION_0002];

const SELECT_COLUMNS: &str = "id, uid, name, email, pat, access_token, refresh_token, expires_at_ms, \
     user_type, org_id, org_name, disabled, quota_json, quota_updated_ms, last_error, last_used_ms, \
     success_count, failure_count, consumed_total, quota_used_base";

/// 额度 JSON 里带 `used` 的资源包：个人版是 userQuota / addOnQuota，企业版是 orgResourcePackage
const QUOTA_PARTS: [&str; 3] = ["userQuota", "addOnQuota", "orgResourcePackage"];

/// 本周期已用量：各资源包 `used` 之和；上游一个都没给时返回 None，不动累计
fn quota_used(quota: &Value) -> Option<f64> {
    QUOTA_PARTS.iter().filter_map(|k| quota[k]["used"].as_f64()).reduce(|a, b| a + b)
}

/// 库里的一个 Qoder 账号
#[derive(Debug, Clone)]
pub struct QoderAccount {
    pub id: i64,
    pub uid: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub pat: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub user_type: Option<String>,
    pub org_id: Option<String>,
    pub org_name: Option<String>,
    pub disabled: bool,
    pub quota: Option<serde_json::Value>,
    pub quota_updated_ms: Option<i64>,
    pub last_error: Option<String>,
    pub last_used_ms: Option<i64>,
    pub success_count: i64,
    pub failure_count: i64,
    /// 累计消耗的 credits，跨额度周期累加
    pub consumed_total: f64,
    /// 上次额度快照里的本周期已用量；None 表示还没记过
    pub quota_used_base: Option<f64>,
}

/// 管理页给单个模型的配置；字段为空表示用上游默认
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOverride {
    /// 对外模型名；空表示用原名（上游 key）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// 上下文窗口（tokens），必须是该模型支持的档位
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i64>,
    /// 思考强度；设置后覆盖客户端请求里的强度
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

impl ModelOverride {
    pub fn is_empty(&self) -> bool {
        self.alias.is_none() && self.context_window.is_none() && self.effort.is_none()
    }
}

/// 模型 key → 配置
pub type ModelOverrides = std::collections::BTreeMap<String, ModelOverride>;

/// 换证得到的账号资料
pub struct NewAccount<'a> {
    pub uid: &'a str,
    pub name: Option<&'a str>,
    pub email: Option<&'a str>,
    pub pat: &'a str,
    pub access_token: &'a str,
    pub refresh_token: Option<&'a str>,
    pub expires_at_ms: i64,
    pub user_type: Option<&'a str>,
    pub org_id: Option<&'a str>,
    pub org_name: Option<&'a str>,
}

/// 对外展示的账号摘要：不含 PAT 与 token，只给 PAT 末 4 位便于辨认
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QoderAccountView {
    pub id: i64,
    pub uid: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub pat_tail: String,
    pub user_type: Option<String>,
    pub org_name: Option<String>,
    pub disabled: bool,
    pub expires_at_ms: Option<i64>,
    pub quota: Option<serde_json::Value>,
    pub quota_updated_ms: Option<i64>,
    pub last_error: Option<String>,
    pub last_used_ms: Option<i64>,
    pub success_count: i64,
    pub failure_count: i64,
    pub consumed_total: f64,
}

impl From<&QoderAccount> for QoderAccountView {
    fn from(a: &QoderAccount) -> Self {
        let tail: String = a.pat.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        Self {
            id: a.id,
            uid: a.uid.clone(),
            name: a.name.clone(),
            email: a.email.clone(),
            pat_tail: tail,
            user_type: a.user_type.clone(),
            org_name: a.org_name.clone(),
            disabled: a.disabled,
            expires_at_ms: a.expires_at_ms,
            quota: a.quota.clone(),
            quota_updated_ms: a.quota_updated_ms,
            last_error: a.last_error.clone(),
            last_used_ms: a.last_used_ms,
            success_count: a.success_count,
            failure_count: a.failure_count,
            consumed_total: a.consumed_total,
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
struct PendingCounts {
    success: i64,
    failure: i64,
}

pub struct QoderStore {
    conn: Mutex<Connection>,
    path: PathBuf,
    vault: Arc<dyn SecretVault>,
    /// 保险箱内容的内存副本，按 uid；只在持有连接锁时修改
    secrets: Mutex<SecretMap>,
    cache: Mutex<Option<Arc<[Arc<QoderAccount>]>>>,
    pending: Mutex<HashMap<i64, PendingCounts>>,
}

/// 库里是明文 PAT / token：主库文件先建成（或收紧为）仅属主可读写，
/// SQLite 创建 -wal / -shm 时沿用主库的权限位
#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    std::fs::OpenOptions::new().write(true).create(true).truncate(false).mode(OWNER_ONLY_MODE).open(path)
        .with_context(|| format!("创建 {}", path.display()))?;
    for file in [path.to_path_buf(), PathBuf::from(format!("{}-wal", path.display())),
                 PathBuf::from(format!("{}-shm", path.display()))] {
        if file.exists() {
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(OWNER_ONLY_MODE))
                .with_context(|| format!("收紧 {} 的权限", file.display()))?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

/// 旧版本把凭证明文写在库里：搬进保险箱后清空，并 VACUUM + 截断 WAL，旧页里也不留明文
fn migrate_plaintext(conn: &mut Connection, vault: &dyn SecretVault, secrets: &mut SecretMap) -> anyhow::Result<()> {
    let legacy: Vec<(String, Secrets)> = conn.prepare(
        "SELECT uid, pat, access_token, refresh_token FROM accounts
         WHERE pat != '' OR access_token IS NOT NULL OR refresh_token IS NOT NULL")?
        .query_map([], |r| Ok((r.get(0)?, Secrets { pat: r.get(1)?, access_token: r.get(2)?, refresh_token: r.get(3)? })))?
        .collect::<rusqlite::Result<_>>()?;
    if legacy.is_empty() {
        return Ok(());
    }
    let mut next = secrets.clone();
    for (uid, s) in legacy.iter().cloned() {
        // 保险箱里已有的更新，库里残留的只补缺
        next.entry(uid).or_insert(s);
    }
    vault.save(&next)?;
    *secrets = next;
    conn.execute("UPDATE accounts SET pat = '', access_token = NULL, refresh_token = NULL", [])?;
    conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")?;
    tracing::info!("已把 {} 个 Qoder 账号的凭证从账号库迁入钥匙串", legacy.len());
    Ok(())
}

fn row_to_account(row: &Row<'_>) -> rusqlite::Result<QoderAccount> {
    let id: i64 = row.get(0)?;
    let quota: Option<String> = row.get(12)?;
    Ok(QoderAccount {
        id,
        uid: row.get(1)?,
        name: row.get(2)?,
        email: row.get(3)?,
        pat: row.get(4)?,
        access_token: row.get(5)?,
        refresh_token: row.get(6)?,
        expires_at_ms: row.get(7)?,
        user_type: row.get(8)?,
        org_id: row.get(9)?,
        org_name: row.get(10)?,
        disabled: row.get::<_, i64>(11)? != 0,
        quota: quota.and_then(|s| serde_json::from_str(&s)
            .inspect_err(|e| tracing::warn!("Qoder 账号 #{id} 的额度 JSON 解析失败，按无额度处理: {e}"))
            .ok()),
        quota_updated_ms: row.get(13)?,
        last_error: row.get(14)?,
        last_used_ms: row.get(15)?,
        success_count: row.get(16)?,
        failure_count: row.get(17)?,
        consumed_total: row.get(18)?,
        quota_used_base: row.get(19)?,
    })
}

impl QoderStore {
    /// 打开账号库；文件不存在时新建并初始化 schema
    pub fn open_or_create(path: &Path, vault: Arc<dyn SecretVault>) -> anyhow::Result<Self> {
        let existed = path.exists();
        restrict_to_owner(path)?;
        let mut conn = Connection::open(path).with_context(|| format!("打开 {}", path.display()))?;
        sqlite::configure(&conn)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version == 0 {
            let empty: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
            if existed && empty != 0 {
                bail!("{} 不是可识别的 Qoder 账号库（user_version=0 且非空）", path.display());
            }
        } else if version > SCHEMA_VERSION {
            bail!("{} 不是可识别的 Qoder 账号库（user_version={version}）", path.display());
        }
        if version < SCHEMA_VERSION {
            let tx = conn.transaction()?;
            for migration in &MIGRATIONS[version as usize..] {
                tx.execute_batch(migration)?;
            }
            tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
            tx.commit()?;
        }
        let mut secrets = vault.load()?;
        migrate_plaintext(&mut conn, vault.as_ref(), &mut secrets)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
            vault,
            secrets: Mutex::new(secrets),
            cache: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 写操作：持有连接锁时让快照失效
    fn write<T>(&self, f: impl FnOnce(&mut Connection) -> anyhow::Result<T>) -> anyhow::Result<T> {
        let mut conn = self.conn.lock();
        let result = f(&mut conn);
        *self.cache.lock() = None;
        result
    }

    /// 账号表的内存快照（计数不含未落盘增量）
    pub fn snapshot(&self) -> anyhow::Result<Arc<[Arc<QoderAccount>]>> {
        if let Some(accounts) = self.cache.lock().as_ref() {
            return Ok(accounts.clone());
        }
        let conn = self.conn.lock();
        if let Some(accounts) = self.cache.lock().as_ref() {
            return Ok(accounts.clone());
        }
        let mut stmt = conn.prepare_cached(&format!("SELECT {SELECT_COLUMNS} FROM accounts ORDER BY id"))?;
        let secrets = self.secrets.lock();
        let accounts: Arc<[Arc<QoderAccount>]> = stmt.query_map([], row_to_account)?
            .map(|r| r.map(|mut a| {
                // 凭证只认保险箱；库里即使残留了什么也不用
                let s = secrets.get(&a.uid).cloned().unwrap_or_default();
                a.pat = s.pat;
                a.access_token = s.access_token;
                a.refresh_token = s.refresh_token;
                Arc::new(a)
            }))
            .collect::<rusqlite::Result<_>>()?;
        *self.cache.lock() = Some(accounts.clone());
        Ok(accounts)
    }

    /// 全部账号，计数含未落盘增量（管理接口用）
    pub fn list(&self) -> anyhow::Result<Vec<QoderAccount>> {
        let pending = self.pending.lock();
        Ok(self.snapshot()?.iter().map(|a| {
            let mut account = QoderAccount::clone(a);
            if let Some(p) = pending.get(&a.id) {
                account.success_count += p.success;
                account.failure_count += p.failure;
            }
            account
        }).collect())
    }

    pub fn get(&self, id: i64) -> anyhow::Result<Option<QoderAccount>> {
        Ok(self.list()?.into_iter().find(|a| a.id == id))
    }

    /// 改保险箱：先写进系统凭证库，成功后才更新内存副本
    fn update_secrets(&self, f: impl FnOnce(&mut SecretMap)) -> anyhow::Result<()> {
        let mut secrets = self.secrets.lock();
        let mut next = secrets.clone();
        f(&mut next);
        self.vault.save(&next)?;
        *secrets = next;
        Ok(())
    }

    fn uid_of(conn: &Connection, id: i64) -> anyhow::Result<Option<String>> {
        Ok(conn.query_row("SELECT uid FROM accounts WHERE id = ?1", [id], |r| r.get(0)).optional()?)
    }

    /// 按 uid 新增或覆盖：同一账号重新粘贴 PAT 时替换凭证，保留 id 与禁用状态。
    /// 凭证先进保险箱，失败就不建账号
    pub fn upsert(&self, a: &NewAccount<'_>) -> anyhow::Result<i64> {
        let now = now_ms();
        self.write(|conn| {
            self.update_secrets(|m| {
                m.insert(a.uid.to_string(), Secrets {
                    pat: a.pat.to_string(),
                    access_token: Some(a.access_token.to_string()),
                    refresh_token: a.refresh_token.map(str::to_string),
                });
            })?;
            Ok(conn.query_row(
            "INSERT INTO accounts (uid, name, email, pat, access_token, refresh_token, expires_at_ms,
                                   user_type, org_id, org_name, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
             ON CONFLICT(uid) DO UPDATE SET
                 name = COALESCE(excluded.name, accounts.name),
                 email = COALESCE(excluded.email, accounts.email),
                 pat = excluded.pat,
                 access_token = excluded.access_token,
                 refresh_token = excluded.refresh_token,
                 expires_at_ms = excluded.expires_at_ms,
                 user_type = COALESCE(excluded.user_type, accounts.user_type),
                 org_id = COALESCE(excluded.org_id, accounts.org_id),
                 org_name = COALESCE(excluded.org_name, accounts.org_name),
                 last_error = NULL,
                 updated_ms = excluded.updated_ms
             RETURNING id",
            params![a.uid, a.name, a.email, "", None::<&str>, None::<&str>, a.expires_at_ms,
                a.user_type, a.org_id, a.org_name, now],
            |r| r.get(0),
        )?)
        })
    }

    /// 续期后回写；上游没给新 refresh token 时保留旧的
    pub fn update_tokens(&self, id: i64, access_token: &str, refresh_token: Option<&str>, expires_at_ms: i64)
        -> anyhow::Result<()> {
        self.write(|conn| {
            let Some(uid) = Self::uid_of(conn, id)? else { return Ok(()) };
            self.update_secrets(|m| {
                let s = m.entry(uid).or_default();
                s.access_token = Some(access_token.to_string());
                if let Some(rt) = refresh_token {
                    s.refresh_token = Some(rt.to_string());
                }
            })?;
            conn.execute(
                "UPDATE accounts SET expires_at_ms = ?2, last_error = NULL, updated_ms = ?3 WHERE id = ?1",
                params![id, expires_at_ms, now_ms()],
            )?;
            Ok(())
        })
    }

    /// 存额度快照，并把本周期已用量相对上次快照的增量计入累计消耗。
    /// 第一次记（没有基线）把当前已用量整段计入，累计从一开始就和上游显示的已用对得上；
    /// 已用量比基线小视为周期重置，新周期的已用量整段计入。
    pub fn update_quota(&self, id: i64, quota: &Value) -> anyhow::Result<()> {
        let now = now_ms();
        let used = quota_used(quota);
        self.write(|conn| {
            match used {
                Some(used) => conn.execute(
                    "UPDATE accounts SET quota_json = ?2, quota_updated_ms = ?3,
                         consumed_total = consumed_total + CASE
                             WHEN quota_used_base IS NULL OR ?4 < quota_used_base THEN ?4
                             ELSE ?4 - quota_used_base END,
                         quota_used_base = ?4
                     WHERE id = ?1",
                    params![id, quota.to_string(), now, used])?,
                None => conn.execute("UPDATE accounts SET quota_json = ?2, quota_updated_ms = ?3 WHERE id = ?1",
                    params![id, quota.to_string(), now])?,
            };
            Ok(())
        })
    }

    pub fn set_error(&self, id: i64, error: Option<&str>) -> anyhow::Result<()> {
        self.write(|conn| {
            conn.execute("UPDATE accounts SET last_error = ?2, updated_ms = ?3 WHERE id = ?1",
                params![id, error, now_ms()])?;
            Ok(())
        })
    }

    pub fn set_disabled(&self, id: i64, disabled: bool) -> anyhow::Result<bool> {
        self.write(|conn| Ok(conn.execute(
            "UPDATE accounts SET disabled = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, disabled as i64, now_ms()],
        )? > 0))
    }

    pub fn touch_used(&self, id: i64) -> anyhow::Result<()> {
        self.write(|conn| {
            conn.execute("UPDATE accounts SET last_used_ms = ?2 WHERE id = ?1", params![id, now_ms()])?;
            Ok(())
        })
    }

    pub fn delete(&self, id: i64) -> anyhow::Result<bool> {
        let mut pending = self.pending.lock();
        let n = self.write(|conn| {
            let Some(uid) = Self::uid_of(conn, id)? else { return Ok(0) };
            let n = conn.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
            self.update_secrets(|m| { m.remove(&uid); })?;
            Ok(n)
        })?;
        pending.remove(&id);
        Ok(n > 0)
    }

    pub fn record(&self, id: i64, success: bool) {
        let mut pending = self.pending.lock();
        let entry = pending.entry(id).or_default();
        if success { entry.success += 1 } else { entry.failure += 1 }
    }

    /// 计数增量一个事务写进库；失败时放回，下次再试
    pub fn flush_counts(&self) -> anyhow::Result<usize> {
        let mut pending = self.pending.lock();
        if pending.is_empty() {
            return Ok(0);
        }
        let batch = std::mem::take(&mut *pending);
        let result = self.write(|conn| {
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare_cached(
                    "UPDATE accounts SET success_count = success_count + ?2,
                         failure_count = failure_count + ?3 WHERE id = ?1")?;
                for (id, c) in &batch {
                    stmt.execute(params![id, c.success, c.failure])?;
                }
            }
            tx.commit()?;
            Ok(batch.len())
        });
        if result.is_err() {
            for (id, c) in batch {
                let entry = pending.entry(id).or_default();
                entry.success += c.success;
                entry.failure += c.failure;
            }
        }
        result
    }

    /// 未设置为 None（全选）；Some([]) 表示明确不输出任何模型
    pub fn enabled_model_ids(&self) -> anyhow::Result<Option<Vec<String>>> {
        let value: Option<String> = self.conn.lock()
            .query_row("SELECT value FROM settings WHERE key = ?1", [ENABLED_MODEL_IDS_KEY], |r| r.get(0))
            .optional()?;
        value.map(|json| serde_json::from_str(&json).context("读取模型目录选择")).transpose()
    }

    pub fn model_overrides(&self) -> anyhow::Result<ModelOverrides> {
        let value: Option<String> = self.conn.lock()
            .query_row("SELECT value FROM settings WHERE key = ?1", [MODEL_OVERRIDES_KEY], |r| r.get(0))
            .optional()?;
        Ok(value.map(|json| serde_json::from_str(&json).context("读取模型配置")).transpose()?.unwrap_or_default())
    }

    pub fn set_model_overrides(&self, overrides: &ModelOverrides) -> anyhow::Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![MODEL_OVERRIDES_KEY, serde_json::to_string(overrides)?],
            )?;
            Ok(())
        })
    }

    pub fn set_enabled_model_ids(&self, ids: &[String]) -> anyhow::Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![ENABLED_MODEL_IDS_KEY, serde_json::to_string(ids)?],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qoder-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    fn trash(dir: &Path) {
        let trash = PathBuf::from(std::env::var_os("HOME").unwrap()).join(".Trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::rename(dir, trash.join(dir.file_name().unwrap())).unwrap();
    }

    fn mem() -> Arc<dyn SecretVault> {
        Arc::new(super::super::vault::MemoryVault::default())
    }

    /// 库文件里任何位置（含 WAL）都不能出现这些字节
    fn assert_absent(dir: &Path, needles: &[&str]) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            for n in needles {
                assert!(!bytes.windows(n.len()).any(|w| w == n.as_bytes()), "明文 {n} 出现在库文件里");
            }
        }
    }

    #[test]
    fn secrets_live_only_in_vault() {
        let dir = temp_dir();
        let path = dir.join("q.sqlite3");
        let vault = mem();
        let store = QoderStore::open_or_create(&path, vault.clone()).unwrap();
        let id = store.upsert(&NewAccount { access_token: "AT-SECRET-1", refresh_token: Some("RT-SECRET-1"),
            ..sample("u9", "pt-SECRET-PAT") }).unwrap();
        store.update_tokens(id, "AT-SECRET-2", Some("RT-SECRET-2"), 5).unwrap();
        let a = store.get(id).unwrap().unwrap();
        assert_eq!((a.pat.as_str(), a.access_token.as_deref(), a.refresh_token.as_deref()),
            ("pt-SECRET-PAT", Some("AT-SECRET-2"), Some("RT-SECRET-2")));
        assert_eq!(vault.load().unwrap()["u9"].pat, "pt-SECRET-PAT");
        assert_absent(&dir, &["SECRET"]);
        // 重开后从保险箱恢复
        drop(store);
        let store = QoderStore::open_or_create(&path, vault.clone()).unwrap();
        assert_eq!(store.get(id).unwrap().unwrap().access_token.as_deref(), Some("AT-SECRET-2"));
        assert!(store.delete(id).unwrap());
        assert!(vault.load().unwrap().is_empty());
        drop(store);
        trash(&dir);
    }

    /// 保险箱写失败时不建账号
    #[test]
    fn vault_failure_blocks_upsert() {
        struct Broken;
        impl SecretVault for Broken {
            fn load(&self) -> anyhow::Result<SecretMap> { Ok(SecretMap::new()) }
            fn save(&self, _: &SecretMap) -> anyhow::Result<()> { anyhow::bail!("denied") }
        }
        let dir = temp_dir();
        let store = QoderStore::open_or_create(&dir.join("q.sqlite3"), Arc::new(Broken)).unwrap();
        assert!(store.upsert(&sample("u1", "pt-x")).is_err());
        assert!(store.snapshot().unwrap().is_empty());
        drop(store);
        trash(&dir);
    }

    /// v1 库（明文凭证、无累计列）打开时：凭证迁入保险箱，schema 补到最新
    #[test]
    fn legacy_plaintext_is_migrated_and_scrubbed() {
        let dir = temp_dir();
        let path = dir.join("q.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATION_0001).unwrap();
            conn.execute_batch("PRAGMA user_version = 1;").unwrap();
            conn.execute("INSERT INTO accounts (uid, pat, access_token, refresh_token, created_ms, updated_ms)
                          VALUES ('u1', 'pt-LEGACYPAT', 'LEGACYAT', 'LEGACYRT', 1, 1)", []).unwrap();
        }
        let vault = mem();
        let store = QoderStore::open_or_create(&path, vault.clone()).unwrap();
        let a = &store.snapshot().unwrap()[0];
        assert_eq!((a.pat.as_str(), a.refresh_token.as_deref()), ("pt-LEGACYPAT", Some("LEGACYRT")));
        assert_eq!((a.consumed_total, a.quota_used_base), (0.0, None));
        assert_eq!(vault.load().unwrap()["u1"].access_token.as_deref(), Some("LEGACYAT"));
        drop(store);
        assert_absent(&dir, &["LEGACY"]);
        let conn = Connection::open(&path).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
        drop(conn);
        trash(&dir);
    }

    /// 累计消耗：首次快照整段计入，之后按增量累加，已用量回落视为周期重置
    #[test]
    fn consumed_total_accumulates_across_quota_periods() {
        let dir = temp_dir();
        let store = QoderStore::open_or_create(&dir.join("q.sqlite3"), mem()).unwrap();
        let id = store.upsert(&sample("u1", "pt-x")).unwrap();
        let consumed = |store: &QoderStore| store.get(id).unwrap().unwrap().consumed_total;
        // 上游没给 used：只存快照，不动累计
        store.update_quota(id, &serde_json::json!({"isQuotaExceeded": false})).unwrap();
        assert_eq!(consumed(&store), 0.0);
        // 企业版：首次看到 447 整段计入
        store.update_quota(id, &serde_json::json!({"orgResourcePackage": {"used": 447.0, "remaining": 98758.0}})).unwrap();
        assert_eq!(consumed(&store), 447.0);
        // 同周期增长：只加增量
        store.update_quota(id, &serde_json::json!({"orgResourcePackage": {"used": 500.0}})).unwrap();
        assert_eq!(consumed(&store), 500.0);
        // 周期重置：已用量回落到 30，整段计入
        store.update_quota(id, &serde_json::json!({"orgResourcePackage": {"used": 30.0}})).unwrap();
        assert_eq!(consumed(&store), 530.0);
        // 个人版：userQuota + addOnQuota 的 used 求和
        store.update_quota(id, &serde_json::json!({"userQuota": {"used": 40.0}, "addOnQuota": {"used": 5.0}})).unwrap();
        assert_eq!(consumed(&store), 545.0);
        // 重新粘贴 PAT 不清累计；对外视图带 consumedTotal
        store.upsert(&sample("u1", "pt-y")).unwrap();
        let a = store.get(id).unwrap().unwrap();
        assert_eq!((a.consumed_total, a.quota_used_base), (545.0, Some(45.0)));
        assert_eq!(serde_json::to_value(QoderAccountView::from(&a)).unwrap()["consumedTotal"], 545.0);
        drop(store);
        trash(&dir);
    }

    fn sample<'a>(uid: &'a str, pat: &'a str) -> NewAccount<'a> {
        NewAccount {
            uid, name: Some("n"), email: None, pat, access_token: "at", refresh_token: Some("rt"),
            expires_at_ms: 1, user_type: Some("teams"), org_id: None, org_name: None,
        }
    }

    #[test]
    fn upsert_keeps_id_and_disabled_and_hides_secrets() {
        let dir = temp_dir();
        let store = QoderStore::open_or_create(&dir.join("q.sqlite3"), mem()).unwrap();
        let id = store.upsert(&sample("u1", "pt-aaaa1111")).unwrap();
        store.set_disabled(id, true).unwrap();
        assert_eq!(store.upsert(&NewAccount { user_type: None, ..sample("u1", "pt-bbbb2222") }).unwrap(), id);
        let a = store.get(id).unwrap().unwrap();
        assert_eq!((a.pat.as_str(), a.disabled, a.user_type.as_deref()), ("pt-bbbb2222", true, Some("teams")));
        let view = serde_json::to_value(QoderAccountView::from(&a)).unwrap();
        assert_eq!(view["patTail"], "2222");
        let text = view.to_string();
        assert!(!text.contains("pt-bbbb") && !text.contains("\"at\"") && !text.contains("\"rt\""));
        store.update_tokens(id, "at2", None, 9).unwrap();
        let a = store.get(id).unwrap().unwrap();
        assert_eq!((a.access_token.as_deref(), a.refresh_token.as_deref()), (Some("at2"), Some("rt")));
        drop(store);
        trash(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn db_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let path = dir.join("q.sqlite3");
        let vault = mem();
        let store = QoderStore::open_or_create(&path, vault.clone()).unwrap();
        store.upsert(&sample("u3", "pt-perm")).unwrap();
        for name in ["q.sqlite3", "q.sqlite3-wal", "q.sqlite3-shm"] {
            let mode = std::fs::metadata(dir.join(name)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, OWNER_ONLY_MODE, "{name}");
        }
        drop(store);
        // 已存在的宽权限库再次打开时收紧
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        drop(QoderStore::open_or_create(&path, vault).unwrap());
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, OWNER_ONLY_MODE);
        trash(&dir);
    }

    #[test]
    fn counts_and_model_selection_persist() {
        let dir = temp_dir();
        let path = dir.join("q.sqlite3");
        let vault = mem();
        let store = QoderStore::open_or_create(&path, vault.clone()).unwrap();
        let id = store.upsert(&sample("u2", "pt-x")).unwrap();
        store.record(id, true);
        store.record(id, false);
        assert_eq!(store.snapshot().unwrap()[0].success_count, 0);
        assert_eq!(store.get(id).unwrap().unwrap().success_count, 1);
        assert_eq!(store.flush_counts().unwrap(), 1);
        assert_eq!(store.enabled_model_ids().unwrap(), None);
        store.set_enabled_model_ids(&[]).unwrap();
        drop(store);
        let store = QoderStore::open_or_create(&path, vault.clone()).unwrap();
        let a = store.get(id).unwrap().unwrap();
        assert_eq!((a.success_count, a.failure_count), (1, 1));
        assert_eq!(store.enabled_model_ids().unwrap(), Some(vec![]));
        assert!(store.model_overrides().unwrap().is_empty());
        let mut overrides = ModelOverrides::new();
        overrides.insert("k1".into(), ModelOverride { alias: Some("a".into()), context_window: Some(1), effort: None });
        store.set_model_overrides(&overrides).unwrap();
        assert_eq!(store.model_overrides().unwrap(), overrides);
        assert!(store.delete(id).unwrap());
        assert!(store.snapshot().unwrap().is_empty());
        drop(store);

        let foreign = dir.join("foreign.sqlite3");
        Connection::open(&foreign).unwrap().execute_batch("CREATE TABLE t(x);").unwrap();
        assert!(QoderStore::open_or_create(&foreign, mem()).is_err());
        trash(&dir);
    }
}
