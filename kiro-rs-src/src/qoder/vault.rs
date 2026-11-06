//! Qoder 凭证保险箱：PAT / access token / refresh token 只存 macOS 钥匙串，不落 SQLite
//!
//! 全部账号合成一个钥匙串条目（JSON，按 uid 索引）：钥匙串按条目授权，
//! 一个条目意味着二进制重新打包后只弹一次「允许访问」。
//! 条目的访问控制默认只信任创建它的程序，其他程序读取会弹窗要求你确认。

use std::collections::HashMap;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// 钥匙串条目的 service 名；account 名用账号库的绝对路径，不同库互不覆盖
pub const KEYCHAIN_SERVICE: &str = "com.proxy-rs.qoder";

/// 一个账号的全部凭证
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    pub pat: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
}

pub type SecretMap = HashMap<String, Secrets>;

pub trait SecretVault: Send + Sync {
    /// 读出全部凭证；条目不存在时返回空表
    fn load(&self) -> anyhow::Result<SecretMap>;
    /// 整体覆盖写入
    fn save(&self, secrets: &SecretMap) -> anyhow::Result<()>;
}

/// macOS 登录钥匙串
#[cfg(target_os = "macos")]
pub struct KeychainVault {
    service: String,
    account: String,
}

#[cfg(target_os = "macos")]
impl KeychainVault {
    pub fn new(service: impl Into<String>, account: impl Into<String>) -> Self {
        Self { service: service.into(), account: account.into() }
    }

    /// 删除条目（测试清理用）；不存在也算成功
    pub fn delete(&self) -> anyhow::Result<()> {
        match security_framework::passwords::delete_generic_password(&self.service, &self.account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(anyhow::anyhow!("删除钥匙串条目失败: {e}")),
        }
    }
}

/// errSecItemNotFound
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[cfg(target_os = "macos")]
impl SecretVault for KeychainVault {
    fn load(&self) -> anyhow::Result<SecretMap> {
        match security_framework::passwords::get_generic_password(&self.service, &self.account) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| anyhow::anyhow!("钥匙串里的 Qoder 凭证格式无效: {e}")),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(SecretMap::new()),
            // 用户点了「拒绝」或钥匙串被锁时走这里：宁可启动失败，也不退回明文
            Err(e) => Err(anyhow::anyhow!("读取钥匙串失败（是否在弹窗里点了拒绝？）: {e}")),
        }
    }

    fn save(&self, secrets: &SecretMap) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec(secrets)?;
        security_framework::passwords::set_generic_password(&self.service, &self.account, &bytes)
            .map_err(|e| anyhow::anyhow!("写入钥匙串失败: {e}"))
    }
}

/// 进程内保险箱：只用于测试，进程退出即消失
#[derive(Default)]
pub struct MemoryVault {
    inner: Mutex<SecretMap>,
}

impl SecretVault for MemoryVault {
    fn load(&self) -> anyhow::Result<SecretMap> {
        Ok(self.inner.lock().clone())
    }

    fn save(&self, secrets: &SecretMap) -> anyhow::Result<()> {
        *self.inner.lock() = secrets.clone();
        Ok(())
    }
}

/// 生产用保险箱。只支持 macOS：其他平台没有等价的系统凭证库，直接拒绝启动而不是退回明文
pub fn system_vault(account: &str) -> anyhow::Result<Box<dyn SecretVault>> {
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(KeychainVault::new(KEYCHAIN_SERVICE, account)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        anyhow::bail!("Qoder 凭证只支持存进 macOS 钥匙串，当前平台不可用")
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// 真实写读删登录钥匙串；会在钥匙串里短暂留下一个测试条目，默认不跑：
    /// `cargo test --lib qoder::vault -- --ignored`
    #[test]
    #[ignore]
    fn keychain_roundtrip() {
        let vault = KeychainVault::new(format!("{KEYCHAIN_SERVICE}.test"), uuid::Uuid::new_v4().to_string());
        assert!(vault.load().unwrap().is_empty());
        let mut map = SecretMap::new();
        map.insert("u1".into(), Secrets { pat: "pt-1".into(), access_token: Some("a".into()), refresh_token: None });
        vault.save(&map).unwrap();
        assert_eq!(vault.load().unwrap(), map);
        map.get_mut("u1").unwrap().refresh_token = Some("r".into());
        vault.save(&map).unwrap();
        assert_eq!(vault.load().unwrap(), map);
        vault.delete().unwrap();
        assert!(vault.load().unwrap().is_empty());
    }
}
