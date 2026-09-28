-- kiro-rs / proxy-rs 共享账号库 · migration 0001
--
-- 写入分工（方案 §0.2）：
--   kiro-rs：accounts / account_credentials / account_usage / account_counters 的唯一写入方
--   proxy-rs：只写 account_ui（昵称、分组、标签、展示元数据）
--   account_changes 由触发器维护，两端都不直接写
-- 时间一律 UTC Unix 毫秒，列名以 _at_ms 结尾。
-- 只由离线迁移器 / 初始化命令执行；服务启动只校验 user_version。

CREATE TABLE db_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE accounts (
  -- 沿用 kiro-rs 数字凭据 ID，Admin API 与统计按它引用
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- proxy 侧账号 ID；删除后仍占位，保证已删除账号不会被旧快照"复活"
  account_uuid TEXT NOT NULL UNIQUE,
  -- 记录级稳定标识，不随 token 轮换变化（kiro-rs 生成）
  credential_identity TEXT NOT NULL UNIQUE,
  -- 上游账号身份（getUsageLimits 的 userInfo.userId），用于导入去重
  upstream_identity TEXT,
  email TEXT,
  in_pool INTEGER NOT NULL DEFAULT 0 CHECK (in_pool IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  disabled_reason TEXT CHECK (disabled_reason IN (
    'Manual', 'TooManyFailures', 'TooManyRefreshFailures',
    'QuotaExceeded', 'InvalidRefreshToken', 'InvalidConfig')),
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'needs_review', 'reauth_required', 'error')),
  last_error TEXT,
  -- 刷新在途标记：崩溃重启后据此识别"上游可能已轮换"
  refresh_state TEXT NOT NULL DEFAULT 'idle' CHECK (refresh_state IN ('idle', 'running')),
  refresh_started_at_ms INTEGER,
  refresh_base_version INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  consecutive_refresh_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_refresh_failures >= 0),
  subscription_title TEXT,
  deleted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK ((enabled = 1 AND disabled_reason IS NULL) OR (enabled = 0 AND disabled_reason IS NOT NULL)),
  CHECK (
    (refresh_state = 'idle' AND refresh_started_at_ms IS NULL AND refresh_base_version IS NULL)
    OR (refresh_state = 'running' AND refresh_started_at_ms IS NOT NULL
        AND refresh_base_version IS NOT NULL)
  )
);

CREATE UNIQUE INDEX accounts_upstream_identity_live
  ON accounts(upstream_identity)
  WHERE upstream_identity IS NOT NULL AND deleted_at_ms IS NULL;
CREATE INDEX accounts_pool ON accounts(in_pool, enabled, deleted_at_ms);

CREATE TABLE account_credentials (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  -- 每次凭据写入加一；刷新结果按它做条件写
  credential_version INTEGER NOT NULL DEFAULT 0 CHECK (credential_version >= 0),
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('oauth', 'api_key')),
  -- social / idc / api_key
  auth_method TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at_ms INTEGER,
  kiro_api_key TEXT,
  client_id TEXT,
  client_secret TEXT,
  profile_arn TEXT,
  region TEXT,
  auth_region TEXT,
  api_region TEXT,
  machine_id TEXT,
  endpoint TEXT,
  proxy_url TEXT,
  proxy_username TEXT,
  proxy_password TEXT,
  -- proxy 侧登录来源（BuilderId / Enterprise / Github / Google）与 IdC startUrl
  provider TEXT,
  start_url TEXT,
  -- proxy 侧其余非秘密凭据配置（preferredEndpoint 等），JSON 对象
  extra_json TEXT NOT NULL DEFAULT '{}',
  updated_at_ms INTEGER NOT NULL,
  CHECK ((auth_kind = 'api_key' AND kiro_api_key IS NOT NULL) OR auth_kind = 'oauth')
);

CREATE TABLE account_usage (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  -- 查询序号：只发布 completed_seq 不小于当前的结果，拦截逆序返回
  requested_seq INTEGER NOT NULL DEFAULT 0,
  completed_seq INTEGER NOT NULL DEFAULT 0,
  -- 上游 getUsageLimits 原样响应（JSON），proxy 用自己的解析逻辑展示
  raw_json TEXT,
  used_amount REAL,
  limit_amount REAL,
  reset_at_ms INTEGER,
  observed_at_ms INTEGER,
  attempted_at_ms INTEGER,
  sync_state TEXT NOT NULL DEFAULT 'never'
    CHECK (sync_state IN ('never', 'running', 'ok', 'error')),
  error_message TEXT,
  -- 迁移时从旧 proxy 数据带入的 {usage, subscription}，raw_json 为空时展示用
  legacy_json TEXT,
  CHECK (completed_seq <= requested_seq)
);

CREATE TABLE account_ui (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  nickname TEXT,
  group_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  -- 其余展示元数据（注册密码、idp、visitorId、createdAt 等），JSON 对象
  metadata_json TEXT NOT NULL DEFAULT '{}',
  row_version INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE account_counters (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  last_used_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE account_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  -- 变更来源表名，proxy 据此区分"自己写的 UI 字段"与 kiro-rs 的更新
  kind TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL
);
CREATE INDEX account_changes_time ON account_changes(occurred_at_ms);

CREATE TRIGGER accounts_ai AFTER INSERT ON accounts BEGIN
  INSERT INTO account_changes(account_id, kind, occurred_at_ms)
  VALUES (NEW.id, 'accounts', CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER accounts_au AFTER UPDATE ON accounts BEGIN
  INSERT INTO account_changes(account_id, kind, occurred_at_ms)
  VALUES (NEW.id, 'accounts', CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER account_credentials_ai AFTER INSERT ON account_credentials BEGIN
  INSERT INTO account_changes(account_id, kind, occurred_at_ms)
  VALUES (NEW.account_id, 'account_credentials', CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER account_credentials_au AFTER UPDATE ON account_credentials BEGIN
  INSERT INTO account_changes(account_id, kind, occurred_at_ms)
  VALUES (NEW.account_id, 'account_credentials', CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER account_usage_ai AFTER INSERT ON account_usage BEGIN
  INSERT INTO account_changes(account_id, kind, occurred_at_ms)
  VALUES (NEW.account_id, 'account_usage', CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER account_usage_au AFTER UPDATE ON account_usage BEGIN
  INSERT INTO account_changes(account_id, kind, occurred_at_ms)
  VALUES (NEW.account_id, 'account_usage', CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER account_counters_ai AFTER INSERT ON account_counters BEGIN
  INSERT INTO account_changes(account_id, kind, occurred_at_ms)
  VALUES (NEW.account_id, 'account_counters', CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER account_counters_au AFTER UPDATE ON account_counters BEGIN
  INSERT INTO account_changes(account_id, kind, occurred_at_ms)
  VALUES (NEW.account_id, 'account_counters', CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER account_ui_ai AFTER INSERT ON account_ui BEGIN
  INSERT INTO account_changes(account_id, kind, occurred_at_ms)
  VALUES (NEW.account_id, 'account_ui', CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
CREATE TRIGGER account_ui_au AFTER UPDATE ON account_ui BEGIN
  INSERT INTO account_changes(account_id, kind, occurred_at_ms)
  VALUES (NEW.account_id, 'account_ui', CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
