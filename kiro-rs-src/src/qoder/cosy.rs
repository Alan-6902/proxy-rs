//! COSY 协议：请求体编码、设备指纹派生、会话签名
//!
//! - 请求体：标准 Base64 → 首/中/尾三段轮转 → 按自定义字母表逐字符映射，`=` 变 `$`
//! - 会话：16 字节 tempKey，RSA PKCS#1 v1.5 包成 cosy-key；身份 JSON 用 AES-128-CBC
//!   （key = iv = tempKey）加密成 info
//! - 签名：`md5(payload \n cosyKey \n date \n body \n path)`，path 去掉 `/algo` 前缀、不含 query
//!
//! 设备指纹按账号 uid 稳定派生：同一账号永远是同一台设备，不同账号是不同设备。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use md5::{Digest, Md5};
use rsa::pkcs8::DecodePublicKey;
use rsa::{Pkcs1v15Encrypt, RsaPublicKey};
use sha2::Sha256;

use super::consts::{
    COSY_CLIENT_TYPE, COSY_LIST_MACHINE_TYPE, COSY_PRODUCT, COSY_USER_AGENT, COSY_VERSION, machine_os,
};

/// 官方客户端内置的服务端公钥（1024 位，协议层决定，不能换）
const SERVER_PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----";

const STD_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_ALPHABET: &[u8; 64] = b"_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_PAD: u8 = b'=';
const CUSTOM_PAD: u8 = b'$';

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

fn server_key() -> &'static RsaPublicKey {
    static KEY: OnceLock<RsaPublicKey> = OnceLock::new();
    KEY.get_or_init(|| {
        RsaPublicKey::from_public_key_pem(SERVER_PUBLIC_KEY_PEM).expect("内置 Qoder 公钥格式固定")
    })
}

fn map_byte(c: u8, from: &[u8; 64], to: &[u8; 64], from_pad: u8, to_pad: u8) -> Option<u8> {
    if c == from_pad {
        return Some(to_pad);
    }
    from.iter().position(|&x| x == c).map(|i| to[i])
}

/// 请求体编码（出站）
pub fn encode_body(plain: &[u8]) -> String {
    let std = STANDARD.encode(plain).into_bytes();
    let n = std.len();
    let a = n / 3;
    std[n - a..].iter().chain(&std[a..n - a]).chain(&std[..a])
        // 标准 Base64 输出只含字母表字符与 '='，一定能映射
        .filter_map(|&c| map_byte(c, STD_ALPHABET, CUSTOM_ALPHABET, STD_PAD, CUSTOM_PAD))
        .map(char::from)
        .collect()
}

/// 编码的逆运算（测试用）
#[cfg(test)]
fn decode_body(encoded: &str) -> anyhow::Result<Vec<u8>> {
    let mapped = encoded.bytes()
        .map(|c| map_byte(c, CUSTOM_ALPHABET, STD_ALPHABET, CUSTOM_PAD, STD_PAD)
            .ok_or_else(|| anyhow::anyhow!("字符不在 Qoder 字母表中: {c:#x}")))
        .collect::<anyhow::Result<Vec<u8>>>()?;
    let n = mapped.len();
    let a = n / 3;
    let original: Vec<u8> = mapped[n - a..].iter().chain(&mapped[a..n - a]).chain(&mapped[..a]).copied().collect();
    Ok(STANDARD.decode(original)?)
}

/// 键排序、无空白、不转义非 ASCII 的紧凑 JSON；签名字节与它强绑定
fn sorted_compact(fields: &[(&str, &str)]) -> String {
    let map: BTreeMap<&str, &str> = fields.iter().copied().collect();
    serde_json::to_string(&map).unwrap_or_default()
}

fn md5_hex(data: &[u8]) -> String {
    hex::encode(Md5::digest(data))
}

/// 由 uid + salt 稳定派生 UUIDv4 形状的标识（版本位 4、变体位 a）
pub fn derive_id(uid: &str, salt: &str) -> String {
    let uid = if uid.is_empty() { "anonymous" } else { uid };
    let mut h = md5_hex(format!("{salt}:{uid}").as_bytes()).into_bytes();
    h[12] = b'4';
    h[16] = b'a';
    let h = String::from_utf8(h).unwrap_or_default();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// 保留账号已有的稳定 machineId；不再伪造 machineToken、machineType 和 hostname。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub machine_id: String,
    pub hostname: String,
}

impl Device {
    pub fn for_uid(uid: &str) -> Self {
        Self { machine_id: derive_id(uid, "machine"), hostname: local_hostname() }
    }
}

const HOSTNAME_MAX_BYTES: usize = 96;

/// 只允许可打印 ASCII 进入 HTTP 头；非 ASCII 名称用安全片段和摘要保留区分度。
fn safe_hostname(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() { return String::new(); }
    let hash = hex::encode(Sha256::digest(name.as_bytes()));
    let printable = name.bytes().all(|b| (b' '..=b'~').contains(&b));
    let mut safe = if printable { name.to_string() } else {
        let parts: Vec<&str> = name.split(|c: char| !c.is_ascii_graphic()).filter(|p| !p.is_empty()).collect();
        let prefix = parts.join("-");
        format!("{}-{}", if prefix.is_empty() { "unknown" } else { &prefix }, &hash[..8])
    };
    if safe.len() > HOSTNAME_MAX_BYTES {
        let prefix = safe[..HOSTNAME_MAX_BYTES - 9].trim_end_matches(['-', ' ']);
        safe = format!("{prefix}-{}", &hash[..8]);
    }
    safe
}

/// 读取系统主机名；失败时省略该可选头，不生成虚假桌面设备名。
fn local_hostname() -> String {
    #[cfg(unix)]
    {
        static HOSTNAME: OnceLock<String> = OnceLock::new();
        HOSTNAME.get_or_init(|| {
            std::process::Command::new("/bin/hostname").output().ok()
                .filter(|o| o.status.success())
                .map(|o| safe_hostname(&String::from_utf8_lossy(&o.stdout)))
                .unwrap_or_default()
        }).clone()
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").map(|s| safe_hostname(&s)).unwrap_or_default()
    }
}

/// 桌面端签名只携带推理所需身份，refresh token 永不发往推理网关。
fn identity_json(identity: &Identity) -> String {
    sorted_compact(&[
        ("aid", ""), ("name", &identity.name), ("email", ""),
        ("security_oauth_token", &identity.access_token), ("uid", &identity.uid),
    ])
}

/// 写进签名 info 的账号身份
#[derive(Debug, Clone, Default)]
pub struct Identity {
    pub uid: String,
    pub name: String,
    pub access_token: String,
}

/// 单账号的签名会话；access token 轮换后整体重建
pub struct Session {
    uid: String,
    cosy_key: String,
    info: String,
    device: Device,
    machine_os: String,
}

impl Session {
    pub fn new(identity: &Identity) -> anyhow::Result<Self> {
        anyhow::ensure!(!identity.uid.is_empty() && !identity.access_token.is_empty(), "Qoder 会话缺少 uid 或 token");
        // 16 个十六进制字符作 AES-128 的 key/iv，与官方客户端同形（服务端按这串字节解 info）
        let temp_key = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
        let wrapped = server_key().encrypt(&mut rsa::rand_core::OsRng, Pkcs1v15Encrypt, temp_key.as_bytes())?;
        let plain = identity_json(identity);
        let key = temp_key.as_bytes();
        let encrypted = Aes128CbcEnc::new(key.into(), key.into()).encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
        Ok(Self {
            uid: identity.uid.clone(),
            cosy_key: STANDARD.encode(wrapped),
            info: STANDARD.encode(encrypted),
            device: Device::for_uid(&identity.uid),
            machine_os: machine_os(),
        })
    }

    /// 一次请求的完整签名头。`sse` 为推理流时加 hostname 与 cache-control
    pub fn headers(&self, body: &str, url: &str, accept: &str, sse: bool) -> Vec<(&'static str, String)> {
        self.headers_at(body, url, accept, sse, chrono::Utc::now().timestamp(), &uuid::Uuid::new_v4().to_string())
    }

    fn headers_at(&self, body: &str, url: &str, accept: &str, sse: bool, now: i64, request_id: &str)
        -> Vec<(&'static str, String)> {
        let payload = STANDARD.encode(sorted_compact(&[
            ("cosyVersion", COSY_VERSION),
            ("ideVersion", ""),
            ("info", &self.info),
            ("requestId", request_id),
            ("version", "v1"),
        ]));
        let date = now.to_string();
        let sig = md5_hex([payload.as_str(), &self.cosy_key, &date, body, &sign_path(url)].join("\n").as_bytes());
        let mut headers = vec![
            ("cosy-data-policy", "disagree".to_string()),
            ("content-type", "application/json".to_string()),
            ("cosy-business-product", COSY_PRODUCT.to_string()),
            ("cosy-business-type", "agent".to_string()),
            ("cosy-scene", COSY_PRODUCT.to_string()),
            ("cosy-clienttype", COSY_CLIENT_TYPE.to_string()),
            ("cosy-date", date),
            ("cosy-user", self.uid.clone()),
            ("cosy-key", self.cosy_key.clone()),
            ("accept", accept.to_string()),
            ("authorization", format!("Bearer COSY.{payload}.{sig}")),
            ("accept-encoding", "identity".to_string()),
            ("cosy-version", COSY_VERSION.to_string()),
            ("cosy-machineid", self.device.machine_id.clone()),
            ("login-version", "v2".to_string()),
            ("user-agent", COSY_USER_AGENT.to_string()),
            ("cosy-machineos", self.machine_os.clone()),
        ];
        if sse {
            if !self.device.hostname.is_empty() {
                headers.push(("cosy-machinehostname", self.device.hostname.clone()));
            }
            headers.push(("cache-control", "no-cache".to_string()));
        } else {
            // 对齐插件 prepareRequest；聊天没有原生设备身份时省略这些头。
            headers.push(("cosy-clientip", self.device.machine_id.clone()));
            headers.push(("cosy-machinetoken", self.device.machine_id.clone()));
            headers.push(("cosy-machinetype", COSY_LIST_MACHINE_TYPE.to_string()));
        }
        headers
    }
}

/// 签名用的 path：不含 query，去掉 `/algo` 前缀
fn sign_path(url: &str) -> String {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let path = after_scheme.find('/').map(|i| &after_scheme[i..]).unwrap_or("/");
    let path = path.split(['?', '#']).next().unwrap_or("/");
    match path.strip_prefix("/algo") {
        Some("") => "/".to_string(),
        Some(rest) => rest.to_string(),
        None => path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 期望值由参考实现 qoder2api-hub 的 qoder_sign / qoder_fingerprint 生成
    #[test]
    fn encode_matches_reference() {
        assert_eq!(encode_body(b"{}"), "$kwm");
        assert_eq!(encode_body("{\"a\":\"中文\",\"n\":1}".as_bytes()), "*u*ByVxw$G*tQ)PZB*fmYKiBMn*Q");
        for sample in [&b""[..], b"x", b"xy", "长一点的中文 body {\"k\":[1,2,3]}".as_bytes()] {
            assert_eq!(decode_body(&encode_body(sample)).unwrap(), sample);
        }
        assert!(decode_body("~").is_err());
    }

    #[test]
    fn device_matches_reference() {
        let d = Device::for_uid("u-123");
        assert_eq!(d.machine_id, "98b53497-f10c-4475-a88a-9054ddd676f0");
        assert_eq!(d.hostname, local_hostname());
        assert!(d.hostname.is_ascii());
        assert_ne!(Device::for_uid("u-124"), d);
    }

    #[test]
    fn sorted_compact_keeps_unicode_and_sorts() {
        assert_eq!(sorted_compact(&[("b", "x"), ("a", "中/\"")]), "{\"a\":\"中/\\\"\",\"b\":\"x\"}");
    }

    #[test]
    fn sign_path_strips_algo_and_query() {
        assert_eq!(sign_path("https://api3.qoder.sh/algo/api/v2/model/list?Encode=1"), "/api/v2/model/list");
        assert_eq!(sign_path("https://h/algo"), "/");
        assert_eq!(sign_path("https://h/x/y?z"), "/x/y");
    }

#[test]
    fn desktop_headers_and_identity_omit_refresh_and_virtual_device_fields() {
        let identity = Identity { uid: "u-1".into(), access_token: "access-test".into(), ..Default::default() };
        let plain: serde_json::Value = serde_json::from_str(&identity_json(&identity)).unwrap();
        assert_eq!(plain["aid"], "");
        assert_eq!(plain["security_oauth_token"], "access-test");
        assert_eq!(plain.as_object().unwrap().len(), 5);
        assert!(plain.get("refresh_token").is_none());
        let s = Session::new(&identity).unwrap();
        let chat = s.headers_at("BODY", "https://api3.qoder.sh/algo/chat", "text/event-stream", true, 1, "rid");
        for forbidden in ["cosy-clientip", "cosy-machinetoken", "cosy-machinetype"] {
            assert!(!chat.iter().any(|(name, _)| *name == forbidden));
        }
        for (name, expected) in [("cosy-clienttype", "10"), ("cosy-version", "1.1.69"),
            ("cosy-scene", "app"), ("cosy-business-product", "app"), ("cosy-data-policy", "disagree")] {
            assert_eq!(chat.iter().find(|(n, _)| *n == name).unwrap().1, expected);
        }
        let list = s.headers_at("", "https://api3.qoder.sh/algo/list", "application/json", false, 1, "rid");
        for name in ["cosy-clientip", "cosy-machinetoken"] {
            assert_eq!(list.iter().find(|(n, _)| *n == name).unwrap().1, s.device.machine_id);
        }
        assert_eq!(list.iter().find(|(n, _)| *n == "cosy-machinetype").unwrap().1, "5");
        for name in ["Mac.local", "电脑\r\nX-Test: malicious", "", &"long".repeat(100)] {
            let safe = safe_hostname(name);
            assert!(safe.len() <= HOSTNAME_MAX_BYTES && safe.bytes().all(|b| (b' '..=b'~').contains(&b)));
        }
    }

    #[test]
    fn signature_covers_body_and_path() {
        let s = Session::new(&Identity { uid: "u-1".into(), access_token: "t".into(), ..Default::default() }).unwrap();
        let url = "https://api3.qoder.sh/algo/api/v2/model/list?Encode=1";
        let h = s.headers_at("BODY", url, "application/json", false, 1_700_000_000, "rid");
        let get = |k: &str| h.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()).unwrap();
        let bearer = get("authorization");
        let (payload, sig) = bearer.strip_prefix("Bearer COSY.").unwrap().split_once('.').unwrap();
        let expected = md5_hex(format!("{payload}\n{}\n1700000000\nBODY\n/api/v2/model/list", get("cosy-key")).as_bytes());
        assert_eq!(sig, expected);
        let decoded: serde_json::Value = serde_json::from_slice(&STANDARD.decode(payload).unwrap()).unwrap();
        assert_eq!(decoded["cosyVersion"], COSY_VERSION);
        assert_eq!(decoded["requestId"], "rid");
        assert_eq!(STANDARD.decode(get("cosy-key")).unwrap().len(), 128);
        assert!(h.iter().all(|(n, _)| *n != "cosy-machinehostname"));
        let sse = s.headers_at("", url, "text/event-stream", true, 1, "r");
        assert!(sse.iter().any(|(n, _)| *n == "cosy-machinehostname"));
    }
}
