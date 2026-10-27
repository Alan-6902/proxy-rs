//! Kiro 模型目录
//!
//! 由 Admin 手动触发，用选定账号调 `ListAvailableModels` 拉取完整目录并持久化；
//! `/v1/models` 只读最近一次刷新的结果，每个系列只保留上下文最大、版本最新的一个。
//! 请求侧的模型映射与上下文窗口也优先查这里，新版本无需改代码即可直通。

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::http_client::{ProxyConfig, build_client};
use crate::kiro::model::credentials::KiroCredentials;
use crate::kiro::token_manager::runtime_user_agents;
use crate::model::config::Config;

/// 目录文件名（与 config.json 同目录）
pub const CATALOG_FILE_NAME: &str = "model_catalog.json";
/// Claude 模型对外只暴露 thinking 变体
pub const THINKING_SUFFIX: &str = "-thinking";
const CLAUDE_PREFIX: &str = "claude-";
const GPT_PREFIX: &str = "gpt-";
const OWNER_ANTHROPIC: &str = "anthropic";
const OWNER_OPENAI: &str = "openai";
const OWNER_KIRO: &str = "kiro";

const LIST_MODELS_ORIGIN: &str = "AI_EDITOR";
const LIST_MODELS_PAGE_SIZE: u32 = 50;
/// nextToken 异常时防止无限翻页
const LIST_MODELS_MAX_PAGES: usize = 20;
const LIST_MODELS_TIMEOUT_SECS: u64 = 60;

/// 尚未手动刷新过时的兜底目录：(Kiro modelId, maxInputTokens, maxOutputTokens)
const FALLBACK_MODELS: &[(&str, i32, i32)] = &[
    ("claude-opus-5.5", 1_000_000, 128_000),
    ("claude-sonnet-5", 1_000_000, 128_000),
    ("claude-haiku-4.5", 200_000, 64_000),
    ("claude-fable-5.1", 1_000_000, 128_000),
    ("gpt-5.6-sol", 272_000, 128_000),
    ("gpt-5.6-terra", 272_000, 128_000),
    ("gpt-5.6-luna", 272_000, 128_000),
];

/// `ListAvailableModels` 返回的单个模型（只保留用得到的字段）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KiroModelInfo {
    pub model_id: String,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub model_provider: Option<String>,
    #[serde(default)]
    pub token_limits: Option<TokenLimits>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenLimits {
    #[serde(default)]
    pub max_input_tokens: Option<i32>,
    #[serde(default)]
    pub max_output_tokens: Option<i32>,
}

impl KiroModelInfo {
    fn max_input_tokens(&self) -> i32 {
        self.token_limits
            .as_ref()
            .and_then(|l| l.max_input_tokens)
            .unwrap_or(0)
    }

    fn max_output_tokens(&self) -> i32 {
        self.token_limits
            .as_ref()
            .and_then(|l| l.max_output_tokens)
            .unwrap_or(0)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListAvailableModelsPage {
    #[serde(default)]
    models: Vec<KiroModelInfo>,
    #[serde(default)]
    next_token: Option<String>,
}

/// 一次手动刷新的结果（原样保存全部模型，筛选在读取时做）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    /// 刷新时间（Unix 秒）
    pub fetched_at: i64,
    /// 本次拉取用到的凭据
    pub credential_ids: Vec<u64>,
    /// 各账号目录的并集
    pub models: Vec<KiroModelInfo>,
}

/// 对外暴露的模型
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposedModel {
    pub id: String,
    pub kiro_model_id: String,
    pub display_name: String,
    pub owned_by: String,
    pub created: i64,
    pub context_window: i32,
    pub max_tokens: i32,
}

/// ListAvailableModels HTTP 错误（401 时调用方刷新 token 重试一次）
#[derive(Debug)]
pub struct ListModelsHttpError {
    pub status: u16,
    pub message: String,
}

impl fmt::Display for ListModelsHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ListModelsHttpError {}

struct CatalogStore {
    path: Option<PathBuf>,
    snapshot: RwLock<Option<CatalogSnapshot>>,
}

static STORE: OnceLock<CatalogStore> = OnceLock::new();

/// 启动时调用一次：从 `path` 加载上次刷新的目录（文件不存在视为未刷新过）
pub fn init(path: Option<PathBuf>) {
    let snapshot = path.as_deref().and_then(load_snapshot);
    if let Some(s) = &snapshot {
        tracing::info!("已加载模型目录：{} 个模型（{}）", s.models.len(), CATALOG_FILE_NAME);
    }
    let _ = STORE.set(CatalogStore {
        path,
        snapshot: RwLock::new(snapshot),
    });
}

fn load_snapshot(path: &Path) -> Option<CatalogSnapshot> {
    let content = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&content) {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!("模型目录文件解析失败，按未刷新处理: {}", e);
            None
        }
    }
}

/// 最近一次刷新的目录
pub fn snapshot() -> Option<CatalogSnapshot> {
    STORE.get().and_then(|s| s.snapshot.read().clone())
}

/// 替换目录：先落盘再生效，落盘失败则保持旧目录
pub fn replace(snapshot: CatalogSnapshot) -> anyhow::Result<()> {
    let store = STORE
        .get()
        .ok_or_else(|| anyhow::anyhow!("模型目录未初始化"))?;
    if let Some(path) = &store.path {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&snapshot)?)?;
        std::fs::rename(&tmp, path)?;
    }
    *store.snapshot.write() = Some(snapshot);
    Ok(())
}

/// 把一个账号的目录并入总目录；同 modelId 取上下文更大的那份
pub fn merge_models(merged: &mut Vec<KiroModelInfo>, incoming: Vec<KiroModelInfo>) {
    for model in incoming {
        match merged.iter_mut().find(|m| m.model_id == model.model_id) {
            Some(existing) if model.max_input_tokens() > existing.max_input_tokens() => {
                *existing = model
            }
            Some(_) => {}
            None => merged.push(model),
        }
    }
}

/// 把请求里的模型名解析为目录中的 Kiro modelId（忽略大小写与 thinking 后缀）
pub fn resolve_model_id(requested: &str) -> Option<String> {
    let lower = requested.to_lowercase();
    let base = lower.strip_suffix(THINKING_SUFFIX).unwrap_or(&lower);
    let snapshot = STORE.get()?.snapshot.read();
    snapshot
        .as_ref()?
        .models
        .iter()
        .find(|m| m.model_id.eq_ignore_ascii_case(base))
        .map(|m| m.model_id.clone())
}

/// 目录里记录的上下文窗口（未刷新或上游没给时返回 None）
pub fn context_window(kiro_model_id: &str) -> Option<i32> {
    let snapshot = STORE.get()?.snapshot.read();
    snapshot
        .as_ref()?
        .models
        .iter()
        .find(|m| m.model_id.eq_ignore_ascii_case(kiro_model_id))
        .map(KiroModelInfo::max_input_tokens)
        .filter(|&w| w > 0)
}

/// `/v1/models` 输出：最近一次刷新的目录，没有则用兜底目录
pub fn exposed_models() -> Vec<ExposedModel> {
    match snapshot() {
        Some(s) => build_exposed(&s.models, s.fetched_at),
        None => build_exposed(&fallback_models(), 0),
    }
}

fn fallback_models() -> Vec<KiroModelInfo> {
    FALLBACK_MODELS
        .iter()
        .map(|&(id, input, output)| KiroModelInfo {
            model_id: id.to_string(),
            model_name: None,
            model_provider: None,
            token_limits: Some(TokenLimits {
                max_input_tokens: Some(input),
                max_output_tokens: Some(output),
            }),
        })
        .collect()
}

fn build_exposed(models: &[KiroModelInfo], created: i64) -> Vec<ExposedModel> {
    select_latest_per_family(models)
        .into_iter()
        .map(|m| {
            let name = m.model_name.clone().unwrap_or_else(|| m.model_id.clone());
            let is_claude = m.model_id.starts_with(CLAUDE_PREFIX);
            ExposedModel {
                id: if is_claude {
                    format!("{}{}", m.model_id, THINKING_SUFFIX)
                } else {
                    m.model_id.clone()
                },
                kiro_model_id: m.model_id.clone(),
                display_name: if is_claude {
                    format!("{} (Thinking)", name)
                } else {
                    name
                },
                owned_by: owner_of(m),
                created,
                context_window: m.max_input_tokens(),
                max_tokens: m.max_output_tokens(),
            }
        })
        .collect()
}

fn owner_of(model: &KiroModelInfo) -> String {
    if model.model_id.starts_with(CLAUDE_PREFIX) {
        OWNER_ANTHROPIC.to_string()
    } else if model.model_id.starts_with(GPT_PREFIX) {
        OWNER_OPENAI.to_string()
    } else {
        model
            .model_provider
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(str::to_lowercase)
            .unwrap_or_else(|| OWNER_KIRO.to_string())
    }
}

/// 拆出模型的「系列」与「版本号」：ID 去掉数字段即系列，数字段依次组成版本。
///
/// `claude-opus-5.5` → (`claude-opus`, [5, 5])；`gpt-5.6-sol` → (`gpt-sol`, [5, 6])；
/// `minimax-m2.5` → (`minimax-m`, [2, 5])
fn family_and_version(model_id: &str) -> (String, Vec<u64>) {
    let mut family = Vec::new();
    let mut version = Vec::new();
    for token in model_id.to_lowercase().split('-') {
        let digits_at = token.find(|c: char| c.is_ascii_digit()).unwrap_or(token.len());
        let (name, digits) = token.split_at(digits_at);
        if digits.chars().all(|c| c.is_ascii_digit() || c == '.') {
            if !name.is_empty() {
                family.push(name.to_string());
            }
            version.extend(digits.split('.').filter_map(|p| p.parse::<u64>().ok()));
        } else {
            family.push(token.to_string());
        }
    }
    (family.join("-"), version)
}

/// 每个系列只留一个：上下文最大的优先，同容量取版本最新的
fn select_latest_per_family(models: &[KiroModelInfo]) -> Vec<&KiroModelInfo> {
    let mut best: Vec<(String, Vec<u64>, &KiroModelInfo)> = Vec::new();
    for model in models {
        let (family, version) = family_and_version(&model.model_id);
        match best.iter_mut().find(|(f, _, _)| *f == family) {
            Some(slot) => {
                let current = (slot.2.max_input_tokens(), &slot.1);
                if (model.max_input_tokens(), &version) > current {
                    *slot = (family, version, model);
                }
            }
            None => best.push((family, version, model)),
        }
    }
    best.into_iter().map(|(_, _, m)| m).collect()
}

/// 调 `ListAvailableModels` 拉取该凭据可见的全部模型（自动翻页）
pub(crate) async fn list_available_models(
    credentials: &KiroCredentials,
    config: &Config,
    token: &str,
    proxy: Option<&ProxyConfig>,
) -> anyhow::Result<Vec<KiroModelInfo>> {
    let region = credentials.effective_api_region(config);
    let host = format!("q.{}.amazonaws.com", region);
    let (user_agent, amz_user_agent) = runtime_user_agents(credentials, config);
    let client = build_client(proxy, LIST_MODELS_TIMEOUT_SECS, config.tls_backend)?;

    let mut models = Vec::new();
    let mut next_token: Option<String> = None;
    for _ in 0..LIST_MODELS_MAX_PAGES {
        let mut url = format!(
            "https://{}/ListAvailableModels?origin={}&maxResults={}",
            host, LIST_MODELS_ORIGIN, LIST_MODELS_PAGE_SIZE
        );
        if let Some(profile_arn) = &credentials.profile_arn {
            url.push_str(&format!("&profileArn={}", urlencoding::encode(profile_arn)));
        }
        if let Some(t) = &next_token {
            url.push_str(&format!("&nextToken={}", urlencoding::encode(t)));
        }

        let mut request = client
            .get(&url)
            .header("x-amz-user-agent", &amz_user_agent)
            .header("user-agent", &user_agent)
            .header("host", &host)
            .header("amz-sdk-invocation-id", uuid::Uuid::new_v4().to_string())
            .header("amz-sdk-request", "attempt=1; max=1")
            .header("Authorization", format!("Bearer {}", token))
            .header("Connection", "close");
        if credentials.is_api_key_credential() {
            request = request.header("tokentype", "API_KEY");
        }

        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(ListModelsHttpError {
                status: status.as_u16(),
                message: format!("获取模型目录失败: {} {}", status, body),
            }
            .into());
        }

        let page: ListAvailableModelsPage = response.json().await?;
        models.extend(page.models);
        match page.next_token.filter(|t| !t.is_empty()) {
            Some(t) => next_token = Some(t),
            None => return Ok(models),
        }
    }
    anyhow::bail!("ListAvailableModels 翻页超过 {} 页，已中止", LIST_MODELS_MAX_PAGES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, input: i32) -> KiroModelInfo {
        KiroModelInfo {
            model_id: id.to_string(),
            model_name: None,
            model_provider: None,
            token_limits: Some(TokenLimits {
                max_input_tokens: Some(input),
                max_output_tokens: Some(64_000),
            }),
        }
    }

    fn selected_ids(models: &[KiroModelInfo]) -> Vec<String> {
        build_exposed(models, 0).into_iter().map(|m| m.id).collect()
    }

    #[test]
    fn family_and_version_splits_numeric_segments() {
        assert_eq!(family_and_version("claude-opus-5.5"), ("claude-opus".into(), vec![5, 5]));
        assert_eq!(family_and_version("claude-opus-5"), ("claude-opus".into(), vec![5]));
        assert_eq!(family_and_version("gpt-5.6-sol"), ("gpt-sol".into(), vec![5, 6]));
        assert_eq!(family_and_version("minimax-m2.5"), ("minimax-m".into(), vec![2, 5]));
        assert_eq!(family_and_version("claude-3.7-sonnet"), ("claude-sonnet".into(), vec![3, 7]));
        assert_eq!(family_and_version("auto"), ("auto".into(), vec![]));
    }

    #[test]
    fn keeps_latest_1m_version_per_family_with_thinking_ids() {
        let models = vec![
            model("claude-opus-4.8", 1_000_000),
            model("claude-opus-5.5", 1_000_000),
            model("claude-opus-5", 1_000_000),
            model("claude-sonnet-4.5", 200_000),
            model("claude-sonnet-5", 1_000_000),
            model("claude-haiku-4.5", 200_000),
            model("claude-fable-5.1", 1_000_000),
        ];
        assert_eq!(
            selected_ids(&models),
            vec![
                "claude-opus-5.5-thinking",
                "claude-sonnet-5-thinking",
                "claude-haiku-4.5-thinking",
                "claude-fable-5.1-thinking",
            ]
        );
    }

    #[test]
    fn larger_context_beats_newer_version() {
        let models = vec![model("claude-opus-6", 200_000), model("claude-opus-5.5", 1_000_000)];
        assert_eq!(selected_ids(&models), vec!["claude-opus-5.5-thinking"]);
    }

    #[test]
    fn newer_1m_version_replaces_old_one() {
        let models = vec![model("claude-opus-5.5", 1_000_000), model("claude-opus-5.6", 1_000_000)];
        assert_eq!(selected_ids(&models), vec!["claude-opus-5.6-thinking"]);
    }

    #[test]
    fn non_claude_models_keep_base_id_and_one_per_family() {
        let models = vec![
            model("minimax-m2.1", 196_000),
            model("minimax-m2.5", 196_000),
            model("gpt-5.6-sol", 272_000),
            model("gpt-5.6-luna", 272_000),
            model("deepseek-3.2", 164_000),
        ];
        assert_eq!(
            selected_ids(&models),
            vec!["minimax-m2.5", "gpt-5.6-sol", "gpt-5.6-luna", "deepseek-3.2"]
        );
    }

    #[test]
    fn merge_keeps_union_and_larger_context() {
        let mut merged = vec![model("claude-sonnet-4.5", 200_000)];
        merge_models(
            &mut merged,
            vec![model("claude-sonnet-4.5", 1_000_000), model("claude-opus-5.5", 1_000_000)],
        );
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].max_input_tokens(), 1_000_000);
        assert_eq!(merged[1].model_id, "claude-opus-5.5");
    }

    #[test]
    fn fallback_follows_same_selection() {
        let ids = selected_ids(&fallback_models());
        assert!(ids.contains(&"claude-opus-5.5-thinking".to_string()));
        assert!(ids.contains(&"gpt-5.6-terra".to_string()));
        assert!(ids.iter().all(|id| !id.starts_with(CLAUDE_PREFIX) || id.ends_with(THINKING_SUFFIX)));
    }

    #[test]
    fn page_parses_kiro_response() {
        let page: ListAvailableModelsPage = serde_json::from_str(
            r#"{"models":[{"modelId":"claude-opus-5.5","modelName":"claude-opus-5.5",
                "tokenLimits":{"maxInputTokens":1000000,"maxOutputTokens":128000},
                "rateMultiplier":2.2}],"nextToken":null}"#,
        )
        .unwrap();
        assert_eq!(page.models[0].max_input_tokens(), 1_000_000);
        assert_eq!(page.models[0].max_output_tokens(), 128_000);
        assert!(page.next_token.is_none());
    }
}
