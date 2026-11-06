//! 会话内的任务记录：同一用户提示的工具循环复用任务，响应后进入 processing。
use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::converter::TaskContext;

const MAX_TASKS: usize = 512;
const TASK_IDLE: Duration = Duration::from_secs(2 * 3600);

struct Entry {
    context: TaskContext,
    used: Instant,
}

#[derive(Default)]
pub struct TaskTracker {
    entries: HashMap<String, Entry>,
}

impl TaskTracker {
    pub fn get(&mut self, session: &str, chat: &Value) -> TaskContext {
        let last_user = chat["messages"].as_array().and_then(|messages| messages.iter().enumerate()
            .rev().find(|(_, m)| m["role"] == "user"));
        let seed = match last_user {
            Some((index, message)) => json!([session, index, message["content"]]),
            None => json!([session, -1, null]),
        };
        let key = hex::encode(Sha256::digest(seed.to_string().as_bytes()));
        let now = Instant::now();
        self.entries.retain(|_, entry| now.duration_since(entry.used) < TASK_IDLE);
        if !self.entries.contains_key(&key) && self.entries.len() >= MAX_TASKS
            && let Some(oldest) = self.entries.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone()) {
                self.entries.remove(&oldest);
            }
        let entry = self.entries.entry(key).or_insert_with(|| Entry {
            context: TaskContext {
                id: uuid::Uuid::new_v4().to_string(),
                begin_at_ms: crate::kiro::account_store::now_ms(),
                answered: false,
            },
            used: now,
        });
        entry.used = now;
        entry.context.clone()
    }

    pub fn mark_answered(&mut self, id: &str) {
        if let Some(entry) = self.entries.values_mut().find(|e| e.context.id == id) {
            entry.context.answered = true;
            entry.used = Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_loop_shares_task_but_new_prompt_and_session_do_not() {
        let mut tracker = TaskTracker::default();
        let first = json!({"messages":[{"role":"user","content":"查看文件"}]});
        let a = tracker.get("session", &first);
        assert!(!a.answered);
        tracker.mark_answered(&a.id);
        let loop_chat = json!({"messages":[{"role":"user","content":"查看文件"},
            {"role":"assistant","tool_calls":[{"id":"c1"}]},
            {"role":"tool","tool_call_id":"c1","content":"结果"}]});
        let b = tracker.get("session", &loop_chat);
        assert_eq!(a.id, b.id);
        assert_eq!(a.begin_at_ms, b.begin_at_ms);
        assert!(b.answered);
        assert_ne!(tracker.get("other", &first).id, a.id);
        let next = json!({"messages":[{"role":"user","content":"查看文件"},
            {"role":"assistant","content":"完成"}, {"role":"user","content":"查看文件"}]});
        assert_ne!(tracker.get("session", &next).id, a.id);
    }

    #[test]
    fn task_memory_is_bounded_and_expires() {
        let mut tracker = TaskTracker::default();
        for i in 0..=MAX_TASKS { tracker.get(&i.to_string(), &json!({})); }
        assert_eq!(tracker.entries.len(), MAX_TASKS);
        for e in tracker.entries.values_mut() { e.used = Instant::now() - TASK_IDLE; }
        tracker.get("fresh", &json!({}));
        assert_eq!(tracker.entries.len(), 1);
    }
}
