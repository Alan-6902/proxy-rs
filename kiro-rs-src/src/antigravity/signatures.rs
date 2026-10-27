//! 工具调用的 thought signature 缓存
//!
//! Anthropic 格式的 tool_use 块没有签名字段，客户端下一轮回传时会丢掉。
//! 上游要求回放 functionCall 时带上原签名，所以按 tool_use id 在内存里记一份。

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

const MAX_ENTRIES: usize = 2000;
const TTL: Duration = Duration::from_secs(60 * 60);

fn cache() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn remember(tool_id: &str, signature: &str) {
    let mut map = cache().lock();
    let now = Instant::now();
    if map.len() >= MAX_ENTRIES {
        map.retain(|_, (_, at)| now.duration_since(*at) < TTL);
        // 仍然满：丢掉最旧的一半
        if map.len() >= MAX_ENTRIES {
            let mut ages: Vec<(String, Instant)> = map.iter().map(|(k, (_, at))| (k.clone(), *at)).collect();
            ages.sort_by_key(|(_, at)| *at);
            for (k, _) in ages.into_iter().take(MAX_ENTRIES / 2) {
                map.remove(&k);
            }
        }
    }
    map.insert(tool_id.to_string(), (signature.to_string(), now));
}

pub fn lookup(tool_id: &str) -> Option<String> {
    let map = cache().lock();
    map.get(tool_id)
        .filter(|(_, at)| at.elapsed() < TTL)
        .map(|(sig, _)| sig.clone())
}
