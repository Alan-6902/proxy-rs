//! 使用临时空库验证两个真实二进制的生命周期隔离，不访问用户运行数据。
use std::{path::PathBuf, process::{Child, Command, Stdio}, time::Duration};

struct Fixture {
    directory: PathBuf,
    children: Vec<Child>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
        let trash = PathBuf::from(std::env::var_os("HOME").expect("HOME")).join(".Trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::rename(&self.directory, trash.join(self.directory.file_name().unwrap())).unwrap();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

async fn wait_ready(client: &reqwest::Client, url: &str) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Ok(response) = client.get(url).header("x-api-key", "test-admin-key").send().await
                && response.status().is_success() {
                    return response.json().await.unwrap();
                }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await.expect("服务应在规定时间内就绪")
}

async fn stop_on_stdin_eof(child: &mut Child) {
    drop(child.stdin.take());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }).await.expect("关闭 stdin 应退出对应进程");
}

#[tokio::test]
async fn services_have_separate_databases_ports_and_lifetimes() {
    let directory = std::env::temp_dir().join(format!("independent-proxies-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let mut fixture = Fixture { directory, children: vec![] };
    let kiro_port = free_port();
    let mut ag_port = free_port();
    while ag_port == kiro_port { ag_port = free_port(); }
    let config = fixture.directory.join("config.json");
    std::fs::write(&config, serde_json::to_vec(&serde_json::json!({
        "host": "127.0.0.1", "port": kiro_port, "antigravityPort": ag_port,
        "apiKey": "test-api-key", "adminApiKey": "test-admin-key",
        // antigravity-rs 启动时强制要求 OAuth 客户端配置（见 config.rs），测试只需占位值。
        "antigravityOauthClientId": "test-client-id.apps.googleusercontent.com",
        "antigravityOauthClientSecret": "test-client-secret",
    })).unwrap()).unwrap();
    let ag_db = fixture.directory.join("antigravity.sqlite3");
    let kiro_db = fixture.directory.join("accounts.sqlite3");
    let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
    let ag_info_url = format!("http://127.0.0.1:{ag_port}/api/admin/service/info");
    let kiro_info_url = format!("http://127.0.0.1:{kiro_port}/api/admin/store/info");

    // Kiro 库还不存在时 AG 必须能启动，证明不依赖 Kiro 凭据池。
    fixture.children.push(Command::new(env!("CARGO_BIN_EXE_antigravity-rs"))
        .arg("--config").arg(&config).arg("--antigravity-db").arg(&ag_db)
        .arg("--exit-on-stdin-eof").stdin(Stdio::piped())
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
    let ag_info = wait_ready(&client, &ag_info_url).await;
    assert_eq!(ag_info["service"], "antigravity");
    assert_eq!(ag_info["databasePath"], ag_db.canonicalize().unwrap().to_str().unwrap());
    assert!(!kiro_db.exists());
    assert!(client.get(&kiro_info_url).send().await.is_err());

    let initialized = Command::new(env!("CARGO_BIN_EXE_kiro-rs"))
        .arg("--config").arg(&config).arg("--account-db").arg(&kiro_db)
        .arg("--init-account-db").output().unwrap();
    assert!(initialized.status.success());
    fixture.children.push(Command::new(env!("CARGO_BIN_EXE_kiro-rs"))
        .arg("--config").arg(&config).arg("--account-db").arg(&kiro_db)
        .arg("--exit-on-stdin-eof").stdin(Stdio::piped())
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
    wait_ready(&client, &kiro_info_url).await;
    assert_ne!(fixture.children[0].id(), fixture.children[1].id());
    assert_eq!(client.get(format!("http://127.0.0.1:{ag_port}/api/admin/credentials"))
        .header("x-api-key", "test-admin-key").send().await.unwrap().status(), 404);

    // 停 AG 不影响 Kiro；随后重启 AG，再停 Kiro，AG 仍然可用。
    stop_on_stdin_eof(&mut fixture.children[0]).await;
    wait_ready(&client, &kiro_info_url).await;
    fixture.children.push(Command::new(env!("CARGO_BIN_EXE_antigravity-rs"))
        .arg("--config").arg(&config).arg("--antigravity-db").arg(&ag_db)
        .arg("--exit-on-stdin-eof").stdin(Stdio::piped())
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
    wait_ready(&client, &ag_info_url).await;
    stop_on_stdin_eof(&mut fixture.children[1]).await;
    wait_ready(&client, &ag_info_url).await;
    stop_on_stdin_eof(&mut fixture.children[2]).await;
}
