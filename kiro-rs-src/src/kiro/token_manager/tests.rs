//! `MultiTokenManager` 的单元测试。从 token_manager.rs 拆出以缩短主文件；
//! 作为子模块仍可访问父模块的私有项。
use super::*;

fn credential_identity_test_path() -> PathBuf {
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("credential-identity-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    directory.join("credentials.json")
}

#[test]
fn test_credential_identity_survives_rotation_and_reload() {
    let path = credential_identity_test_path();
    let manager = MultiTokenManager::new(
        Config::default(),
        vec![KiroCredentials {
            id: Some(7),
            refresh_token: Some("before".into()),
            ..Default::default()
        }],
        None,
        Some(path.clone()),
        true,
    )
    .unwrap();
    let before = serde_json::to_value(&manager.snapshot().entries[0]).unwrap();
    let identity = before["credentialIdentity"]
        .as_str()
        .expect("stable identity")
        .to_owned();
    {
        let mut entries = manager.entries.lock();
        entries[0].credentials.refresh_token = Some("after".into());
    }
    assert!(manager.persist_credentials().unwrap());
    let reloaded = MultiTokenManager::new(
        Config::default(),
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap(),
        None,
        Some(path),
        true,
    )
    .unwrap();
    let after = serde_json::to_value(&reloaded.snapshot().entries[0]).unwrap();
    assert_eq!(after["credentialIdentity"], identity);
    assert_ne!(before["refreshTokenHash"], after["refreshTokenHash"]);
    let recreated = MultiTokenManager::new(
        Config::default(),
        vec![KiroCredentials {
            id: Some(7),
            refresh_token: Some("after".into()),
            ..Default::default()
        }],
        None,
        Some(credential_identity_test_path()),
        true,
    )
    .unwrap();
    assert_ne!(
        serde_json::to_value(&recreated.snapshot().entries[0]).unwrap()["credentialIdentity"],
        identity
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn test_credential_identity_changes_when_numeric_id_is_reused() {
    let manager = MultiTokenManager::new(
        Config::default(),
        vec![],
        None,
        Some(credential_identity_test_path()),
        true,
    )
    .unwrap();
    let credential = KiroCredentials {
        auth_method: Some("api_key".into()),
        kiro_api_key: Some("ksk_test_identity".into()),
        ..Default::default()
    };
    let id = manager.add_credential(credential.clone()).await.unwrap();
    let identity = manager.snapshot().entries[0]
        .credential_identity
        .clone()
        .unwrap();
    manager.set_disabled(id, true).unwrap();
    manager.delete_credential(id).unwrap();
    let reused_id = manager.add_credential(credential).await.unwrap();
    assert_eq!(id, reused_id);
    assert_ne!(
        manager.snapshot().entries[0].credential_identity.as_deref(),
        Some(identity.as_str())
    );
}

#[test]
fn test_credential_identity_persisted_for_single_and_array_formats() {
    for multiple in [false, true] {
        let path = credential_identity_test_path();
        let manager = MultiTokenManager::new(
            Config::default(),
            vec![KiroCredentials {
                id: Some(7),
                refresh_token: Some("test-only".into()),
                ..Default::default()
            }],
            None,
            Some(path.clone()),
            multiple,
        )
        .unwrap();
        let identity = manager.snapshot().entries[0]
            .credential_identity
            .clone()
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value.is_array(), multiple);
        let credentials = if multiple {
            serde_json::from_value(value).unwrap()
        } else {
            vec![serde_json::from_value(value).unwrap()]
        };
        let reloaded =
            MultiTokenManager::new(Config::default(), credentials, None, Some(path), multiple)
                .unwrap();
        assert_eq!(
            reloaded.snapshot().entries[0]
                .credential_identity
                .as_deref(),
            Some(identity.as_str())
        );
    }
}

#[test]
fn test_credential_identity_not_published_when_persistence_fails_or_is_skipped() {
    let directory = credential_identity_test_path()
        .parent()
        .unwrap()
        .to_path_buf();
    for path in [None, Some(directory)] {
        let manager = MultiTokenManager::new(
            Config::default(),
            vec![
                KiroCredentials {
                    id: Some(1),
                    ..Default::default()
                },
                KiroCredentials {
                    id: Some(2),
                    credential_identity: Some("persisted-identity".into()),
                    ..Default::default()
                },
            ],
            None,
            path,
            true,
        )
        .unwrap();
        let entries = manager.snapshot().entries;
        assert_eq!(entries[0].credential_identity, None);
        assert_eq!(
            entries[1].credential_identity.as_deref(),
            Some("persisted-identity")
        );
    }
}

#[test]
fn test_snapshot_hides_identity_until_new_entry_persistence_finishes() {
    let manager = MultiTokenManager::new(
        Config::default(),
        vec![KiroCredentials {
            id: Some(1),
            credential_identity: Some("pending-identity".into()),
            ..Default::default()
        }],
        None,
        None,
        true,
    )
    .unwrap();
    manager.entries.lock()[0].identity_pending = true;
    assert_eq!(manager.snapshot().entries[0].credential_identity, None);
    manager.entries.lock()[0].identity_pending = false;
    assert_eq!(
        manager.snapshot().entries[0].credential_identity.as_deref(),
        Some("pending-identity")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn test_added_credential_identity_not_published_without_persistence() {
    let directory = credential_identity_test_path()
        .parent()
        .unwrap()
        .to_path_buf();
    for path in [None, Some(directory)] {
        let should_fail = path.is_some();
        let manager =
            MultiTokenManager::new(Config::default(), vec![], None, path, true).unwrap();
        let result = manager
            .add_credential(KiroCredentials {
                auth_method: Some("api_key".into()),
                kiro_api_key: Some("ksk_test_identity".into()),
                ..Default::default()
            })
            .await;
        assert_eq!(result.is_err(), should_fail);
        assert_eq!(manager.snapshot().entries[0].credential_identity, None);
    }
}

#[test]
fn test_is_token_expired_with_expired_token() {
    let credentials = KiroCredentials {
        expires_at: Some("2020-01-01T00:00:00Z".to_string()),
        ..Default::default()
    };
    assert!(is_token_expired(&credentials));
}

#[test]
fn test_is_token_expired_with_valid_token() {
    let mut credentials = KiroCredentials::default();
    let future = Utc::now() + Duration::hours(1);
    credentials.expires_at = Some(future.to_rfc3339());
    assert!(!is_token_expired(&credentials));
}

#[test]
fn test_is_token_expired_within_5_minutes() {
    let mut credentials = KiroCredentials::default();
    let expires = Utc::now() + Duration::minutes(3);
    credentials.expires_at = Some(expires.to_rfc3339());
    assert!(is_token_expired(&credentials));
}

#[test]
fn test_is_token_expired_no_expires_at() {
    let credentials = KiroCredentials::default();
    assert!(is_token_expired(&credentials));
}

#[test]
fn test_is_token_expiring_soon_within_10_minutes() {
    let mut credentials = KiroCredentials::default();
    let expires = Utc::now() + Duration::minutes(8);
    credentials.expires_at = Some(expires.to_rfc3339());
    assert!(is_token_expiring_soon(&credentials));
}

#[test]
fn test_is_token_expiring_soon_beyond_10_minutes() {
    let mut credentials = KiroCredentials::default();
    let expires = Utc::now() + Duration::minutes(15);
    credentials.expires_at = Some(expires.to_rfc3339());
    assert!(!is_token_expiring_soon(&credentials));
}

#[test]
fn test_validate_refresh_token_missing() {
    let credentials = KiroCredentials::default();
    let result = validate_refresh_token(&credentials);
    assert!(result.is_err());
}

#[test]
fn test_validate_refresh_token_valid() {
    let credentials = KiroCredentials {
        refresh_token: Some("a".repeat(150)),
        ..Default::default()
    };
    let result = validate_refresh_token(&credentials);
    assert!(result.is_ok());
}

#[test]
fn test_sha256_hex() {
    let result = sha256_hex("test");
    assert_eq!(
        result,
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    );
}

#[tokio::test]
async fn test_refresh_token_rejects_api_key_credential() {
    let config = Config::default();
    let credentials = KiroCredentials {
        kiro_api_key: Some("ksk_test_key_123".to_string()),
        auth_method: Some("api_key".to_string()),
        ..Default::default()
    };

    let result = refresh_token(&credentials, &config, None).await;

    assert!(result.is_err(), "API Key 凭据应被 refresh_token 拒绝");
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("API Key 凭据不支持刷新"),
        "期望错误消息包含 'API Key 凭据不支持刷新'，实际: {}",
        err_msg
    );
}

#[tokio::test]
async fn test_add_credential_reject_duplicate_refresh_token() {
    let config = Config::default();

    let existing = KiroCredentials {
        refresh_token: Some("a".repeat(150)),
        ..Default::default()
    };

    let manager = MultiTokenManager::new(config, vec![existing], None, None, false).unwrap();

    let duplicate = KiroCredentials {
        refresh_token: Some("a".repeat(150)),
        ..Default::default()
    };

    let result = manager.add_credential(duplicate).await;
    assert!(result.is_err());
    assert!(result.err().unwrap().to_string().contains("凭据已存在"));
}

#[tokio::test]
async fn test_add_credential_api_key_success() {
    let config = Config::default();
    let manager = MultiTokenManager::new(config, vec![], None, None, false).unwrap();

    let api_key_cred = KiroCredentials {
        kiro_api_key: Some("ksk_test_key_123".to_string()),
        auth_method: Some("api_key".to_string()),
        ..Default::default()
    };

    let result = manager.add_credential(api_key_cred).await;
    assert!(result.is_ok());
    let id = result.unwrap();
    assert!(id > 0);
    assert_eq!(manager.total_count(), 1);
    assert_eq!(manager.available_count(), 1);
}

#[tokio::test]
async fn test_add_credential_reject_duplicate_api_key() {
    let config = Config::default();

    let existing = KiroCredentials {
        kiro_api_key: Some("ksk_existing_key".to_string()),
        auth_method: Some("api_key".to_string()),
        ..Default::default()
    };

    let manager = MultiTokenManager::new(config, vec![existing], None, None, false).unwrap();

    let duplicate = KiroCredentials {
        kiro_api_key: Some("ksk_existing_key".to_string()),
        auth_method: Some("api_key".to_string()),
        ..Default::default()
    };

    let result = manager.add_credential(duplicate).await;
    assert!(result.is_err());
    assert!(
        result
            .err()
            .unwrap()
            .to_string()
            .contains("kiroApiKey 重复")
    );
}

#[tokio::test]
async fn test_add_credential_api_key_empty_rejected() {
    let config = Config::default();
    let manager = MultiTokenManager::new(config, vec![], None, None, false).unwrap();

    let cred = KiroCredentials {
        kiro_api_key: Some(String::new()),
        auth_method: Some("api_key".to_string()),
        ..Default::default()
    };

    let result = manager.add_credential(cred).await;
    assert!(result.is_err());
    assert!(
        result
            .err()
            .unwrap()
            .to_string()
            .contains("kiroApiKey 为空")
    );
}

#[tokio::test]
async fn test_add_credential_api_key_missing_key_rejected() {
    let config = Config::default();
    let manager = MultiTokenManager::new(config, vec![], None, None, false).unwrap();

    let cred = KiroCredentials {
        auth_method: Some("api_key".to_string()),
        ..Default::default()
    };
    // kiro_api_key is None

    let result = manager.add_credential(cred).await;
    assert!(result.is_err());
    assert!(
        result
            .err()
            .unwrap()
            .to_string()
            .contains("缺少 kiroApiKey")
    );
}

#[tokio::test]
async fn test_add_credential_api_key_and_oauth_coexist() {
    let config = Config::default();

    let oauth_cred = KiroCredentials {
        refresh_token: Some("a".repeat(150)),
        ..Default::default()
    };

    let manager = MultiTokenManager::new(config, vec![oauth_cred], None, None, false).unwrap();

    let api_key_cred = KiroCredentials {
        kiro_api_key: Some("ksk_new_key".to_string()),
        auth_method: Some("api_key".to_string()),
        ..Default::default()
    };

    let result = manager.add_credential(api_key_cred).await;
    assert!(result.is_ok());
    assert_eq!(manager.total_count(), 2);
    assert_eq!(manager.available_count(), 2);
}

// MultiTokenManager 测试

#[test]
fn test_multi_token_manager_new() {
    let config = Config::default();
    let cred1 = KiroCredentials {
        priority: 0,
        ..Default::default()
    };
    let cred2 = KiroCredentials {
        priority: 1,
        ..Default::default()
    };

    let manager =
        MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();
    assert_eq!(manager.total_count(), 2);
    assert_eq!(manager.available_count(), 2);
}

#[test]
fn test_multi_token_manager_empty_credentials() {
    let config = Config::default();
    let result = MultiTokenManager::new(config, vec![], None, None, false);
    // 支持 0 个凭据启动（可通过管理面板添加）
    assert!(result.is_ok());
    let manager = result.unwrap();
    assert_eq!(manager.total_count(), 0);
    assert_eq!(manager.available_count(), 0);
}

#[test]
fn test_multi_token_manager_duplicate_ids() {
    let config = Config::default();
    let cred1 = KiroCredentials {
        id: Some(1),
        ..Default::default()
    };
    let cred2 = KiroCredentials {
        id: Some(1), // 重复 ID
        ..Default::default()
    };

    let result = MultiTokenManager::new(config, vec![cred1, cred2], None, None, false);
    assert!(result.is_err());
    let err_msg = result.err().unwrap().to_string();
    assert!(
        err_msg.contains("重复的凭据 ID"),
        "错误消息应包含 '重复的凭据 ID'，实际: {}",
        err_msg
    );
}

#[test]
fn test_multi_token_manager_api_key_missing_kiro_api_key_auto_disabled() {
    let config = Config::default();

    // auth_method=api_key 但缺少 kiro_api_key → 应被自动禁用
    let bad_cred = KiroCredentials {
        auth_method: Some("api_key".to_string()),
        ..Default::default()
    };
    // kiro_api_key 保持 None

    let good_cred = KiroCredentials {
        refresh_token: Some("valid_token".to_string()),
        ..Default::default()
    };

    let manager =
        MultiTokenManager::new(config, vec![bad_cred, good_cred], None, None, false).unwrap();
    assert_eq!(manager.total_count(), 2);
    assert_eq!(manager.available_count(), 1); // bad_cred 被禁用，只剩 1 个可用
}

#[test]
fn test_multi_token_manager_api_key_with_kiro_api_key_not_disabled() {
    let config = Config::default();

    // auth_method=api_key 且有 kiro_api_key → 不应被禁用
    let cred = KiroCredentials {
        auth_method: Some("api_key".to_string()),
        kiro_api_key: Some("ksk_test123".to_string()),
        ..Default::default()
    };

    let manager = MultiTokenManager::new(config, vec![cred], None, None, false).unwrap();
    assert_eq!(manager.total_count(), 1);
    assert_eq!(manager.available_count(), 1);
}

#[test]
fn test_multi_token_manager_report_failure() {
    let config = Config::default();
    let cred1 = KiroCredentials::default();
    let cred2 = KiroCredentials::default();

    let manager =
        MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

    // 凭据会自动分配 ID（从 1 开始）
    // 前两次失败不会禁用（使用 ID 1）
    assert!(manager.report_failure(1));
    assert!(manager.report_failure(1));
    assert_eq!(manager.available_count(), 2);

    // 第三次失败会禁用第一个凭据
    assert!(manager.report_failure(1));
    assert_eq!(manager.available_count(), 1);

    // 继续失败第二个凭据（使用 ID 2）
    assert!(manager.report_failure(2));
    assert!(manager.report_failure(2));
    assert!(!manager.report_failure(2)); // 所有凭据都禁用了
    assert_eq!(manager.available_count(), 0);
}

#[test]
fn test_multi_token_manager_report_success() {
    let config = Config::default();
    let cred = KiroCredentials::default();

    let manager = MultiTokenManager::new(config, vec![cred], None, None, false).unwrap();

    // 失败两次（使用 ID 1）
    manager.report_failure(1);
    manager.report_failure(1);

    // 成功后重置计数（使用 ID 1）
    manager.report_success(1);

    // 再失败两次不会禁用
    manager.report_failure(1);
    manager.report_failure(1);
    assert_eq!(manager.available_count(), 1);
}

#[test]
fn test_multi_token_manager_switch_to_next() {
    let config = Config::default();
    let cred1 = KiroCredentials {
        refresh_token: Some("token1".to_string()),
        ..Default::default()
    };
    let cred2 = KiroCredentials {
        refresh_token: Some("token2".to_string()),
        ..Default::default()
    };

    let manager =
        MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

    let initial_id = manager.snapshot().current_id;

    // 切换到下一个
    assert!(manager.switch_to_next());
    assert_ne!(manager.snapshot().current_id, initial_id);
}

#[test]
fn test_set_load_balancing_mode_persists_to_config_file() {
    let config_path =
        std::env::temp_dir().join(format!("kiro-load-balancing-{}.json", uuid::Uuid::new_v4()));
    std::fs::write(&config_path, r#"{"loadBalancingMode":"priority"}"#).unwrap();

    let config = Config::load(&config_path).unwrap();
    let manager =
        MultiTokenManager::new(config, vec![KiroCredentials::default()], None, None, false)
            .unwrap();

    manager
        .set_load_balancing_mode("balanced".to_string())
        .unwrap();

    let persisted = Config::load(&config_path).unwrap();
    assert_eq!(persisted.load_balancing_mode, "balanced");
    assert_eq!(manager.get_load_balancing_mode(), "balanced");

    std::fs::remove_file(&config_path).unwrap();
}

#[tokio::test]
async fn test_multi_token_manager_acquire_context_auto_recovers_all_disabled() {
    let config = Config::default();
    let cred1 = KiroCredentials {
        access_token: Some("t1".to_string()),
        expires_at: Some((Utc::now() + Duration::hours(1)).to_rfc3339()),
        ..Default::default()
    };
    let cred2 = KiroCredentials {
        access_token: Some("t2".to_string()),
        expires_at: Some((Utc::now() + Duration::hours(1)).to_rfc3339()),
        ..Default::default()
    };

    let manager =
        MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

    // 凭据会自动分配 ID（从 1 开始）
    for _ in 0..MAX_FAILURES_PER_CREDENTIAL {
        manager.report_failure(1);
    }
    for _ in 0..MAX_FAILURES_PER_CREDENTIAL {
        manager.report_failure(2);
    }

    assert_eq!(manager.available_count(), 0);

    // 应触发自愈：重置失败计数并重新启用，避免必须重启进程
    let ctx = manager.acquire_context(None).await.unwrap();
    assert!(ctx.token == "t1" || ctx.token == "t2");
    assert_eq!(manager.available_count(), 2);
}

#[tokio::test]
async fn test_multi_token_manager_acquire_context_balanced_retries_until_bad_credential_disabled()
 {
    let config = Config {
        load_balancing_mode: "balanced".to_string(),
        ..Default::default()
    };

    let bad_cred = KiroCredentials {
        priority: 0,
        refresh_token: Some("bad".to_string()),
        ..Default::default()
    };

    let good_cred = KiroCredentials {
        priority: 1,
        access_token: Some("good-token".to_string()),
        expires_at: Some((Utc::now() + Duration::hours(1)).to_rfc3339()),
        ..Default::default()
    };

    let manager =
        MultiTokenManager::new(config, vec![bad_cred, good_cred], None, None, false).unwrap();

    let ctx = manager.acquire_context(None).await.unwrap();
    assert_eq!(ctx.id, 2);
    assert_eq!(ctx.token, "good-token");
}

/// 构造两张均可用（token 未过期）的凭据 + 指定粘性开关
fn manager_with_two_live_creds(session_affinity_enabled: bool) -> MultiTokenManager {
    let mut config = Config {
        session_affinity_enabled,
        ..Default::default()
    };
    // balanced 模式下每次都会重新均衡选择，最能暴露粘性是否真的生效
    config.load_balancing_mode = "balanced".to_string();

    let expires = (Utc::now() + Duration::hours(1)).to_rfc3339();

    let c1 = KiroCredentials {
        priority: 0,
        access_token: Some("token-1".to_string()),
        expires_at: Some(expires.clone()),
        ..Default::default()
    };

    let c2 = KiroCredentials {
        priority: 1,
        access_token: Some("token-2".to_string()),
        expires_at: Some(expires),
        ..Default::default()
    };

    MultiTokenManager::new(config, vec![c1, c2], None, None, false).unwrap()
}

#[tokio::test]
async fn test_forced_refresh_reuses_rotation_while_waiting_for_lock() {
    let manager = manager_with_two_live_creds(false);
    let id = manager.entries.lock()[0].id;
    let lock = manager.refresh_lock_for(id);
    let guard = lock.lock().await;
    let refresh = manager.force_refresh_token_for(id);
    tokio::pin!(refresh);
    assert!(futures::poll!(refresh.as_mut()).is_pending());

    // 模拟持锁的反代请求已经完成轮换；旧凭据没有 refreshToken，
    // 若排队请求继续使用旧快照，就会报错。
    manager.entries.lock()[0].credentials.access_token = Some("rotated-token".into());
    drop(guard);

    refresh.await.expect("排队期间已经轮换，应复用新凭据");
    assert_eq!(
        manager.entries.lock()[0]
            .credentials
            .access_token
            .as_deref(),
        Some("rotated-token")
    );
}

#[tokio::test]
async fn test_stale_unauthorized_requests_reuse_current_token() {
    let manager = manager_with_two_live_creds(false);
    let id = manager.entries.lock()[0].id;
    let (first, second) = tokio::join!(
        manager.refresh_token_if_current(id, Some("old-rejected-token")),
        manager.refresh_token_if_current(id, Some("old-rejected-token")),
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(
        manager.entries.lock()[0]
            .credentials
            .access_token
            .as_deref(),
        Some("token-1")
    );
}

#[tokio::test]
async fn test_forced_refresh_rechecks_deleted_credential_after_lock() {
    let manager = manager_with_two_live_creds(false);
    let id = manager.entries.lock()[0].id;
    let lock = manager.refresh_lock_for(id);
    let guard = lock.lock().await;
    let refresh = manager.force_refresh_token_for(id);
    tokio::pin!(refresh);
    assert!(futures::poll!(refresh.as_mut()).is_pending());
    manager.entries.lock().retain(|entry| entry.id != id);
    drop(guard);
    assert!(
        refresh
            .await
            .unwrap_err()
            .to_string()
            .contains("凭据不存在")
    );
}

#[tokio::test]
async fn test_affinity_reuses_same_credential_for_same_hint() {
    let manager = manager_with_two_live_creds(true);

    let first = manager
        .acquire_context_with_affinity(None, Some("session-a"))
        .await
        .unwrap();
    // 首次调用后应记录粘性
    assert_eq!(manager.affinity_entry_count(), 1);

    // 同一 hint 的后续调用应复用同一凭据，即使 balanced 模式本会换人
    for _ in 0..3 {
        let next = manager
            .acquire_context_with_affinity(None, Some("session-a"))
            .await
            .unwrap();
        assert_eq!(next.id, first.id);
    }
}

#[tokio::test]
async fn test_affinity_disabled_does_not_record() {
    let manager = manager_with_two_live_creds(false);

    manager
        .acquire_context_with_affinity(None, Some("session-a"))
        .await
        .unwrap();

    // 开关关闭时不应写入任何粘性映射
    assert_eq!(manager.affinity_entry_count(), 0);
}

#[tokio::test]
async fn test_affinity_distinct_hints_tracked_separately() {
    let manager = manager_with_two_live_creds(true);

    manager
        .acquire_context_with_affinity(None, Some("session-a"))
        .await
        .unwrap();
    manager
        .acquire_context_with_affinity(None, Some("session-b"))
        .await
        .unwrap();

    assert_eq!(manager.affinity_entry_count(), 2);
}

#[tokio::test]
async fn test_affinity_without_hint_records_nothing() {
    let manager = manager_with_two_live_creds(true);

    // 无 metadata 的请求（hint 为 None）不应产生粘性条目
    manager
        .acquire_context_with_affinity(None, None)
        .await
        .unwrap();
    assert_eq!(manager.affinity_entry_count(), 0);
}

#[tokio::test]
async fn test_affinity_falls_back_when_stuck_credential_disabled() {
    let manager = manager_with_two_live_creds(true);

    let first = manager
        .acquire_context_with_affinity(None, Some("session-a"))
        .await
        .unwrap();

    // 禁用粘住的那张凭据，粘性应无声失效并回退到另一张
    manager.set_disabled(first.id, true).unwrap();

    let next = manager
        .acquire_context_with_affinity(None, Some("session-a"))
        .await
        .unwrap();
    assert_ne!(next.id, first.id);
}

#[tokio::test]
async fn test_affinity_plain_acquire_context_stays_unaffected() {
    let manager = manager_with_two_live_creds(true);

    // 不带 hint 的旧入口行为不变，也不写粘性
    manager.acquire_context(None).await.unwrap();
    assert_eq!(manager.affinity_entry_count(), 0);
}

#[test]
fn test_multi_token_manager_report_refresh_failure() {
    let config = Config::default();
    let cred1 = KiroCredentials::default();
    let cred2 = KiroCredentials::default();

    let manager =
        MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

    assert_eq!(manager.available_count(), 2);
    for _ in 0..(MAX_FAILURES_PER_CREDENTIAL - 1) {
        assert!(manager.report_refresh_failure(1));
    }
    assert_eq!(manager.available_count(), 2);

    assert!(manager.report_refresh_failure(1));
    assert_eq!(manager.available_count(), 1);

    let snapshot = manager.snapshot();
    let first = snapshot.entries.iter().find(|e| e.id == 1).unwrap();
    assert!(first.disabled);
    assert_eq!(first.refresh_failure_count, MAX_FAILURES_PER_CREDENTIAL);
    assert_eq!(snapshot.current_id, 2);
}

#[tokio::test]
async fn test_multi_token_manager_refresh_failure_disabled_is_not_auto_recovered() {
    let config = Config::default();
    let cred1 = KiroCredentials::default();
    let cred2 = KiroCredentials::default();

    let manager =
        MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

    for _ in 0..MAX_FAILURES_PER_CREDENTIAL {
        manager.report_refresh_failure(1);
        manager.report_refresh_failure(2);
    }
    assert_eq!(manager.available_count(), 0);

    let err = manager
        .acquire_context(None)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        err.contains("所有凭据均已禁用"),
        "错误应提示所有凭据禁用，实际: {}",
        err
    );
}

#[test]
fn test_multi_token_manager_report_quota_exhausted() {
    let config = Config::default();
    let cred1 = KiroCredentials::default();
    let cred2 = KiroCredentials::default();

    let manager =
        MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

    // 凭据会自动分配 ID（从 1 开始）
    assert_eq!(manager.available_count(), 2);
    assert!(manager.report_quota_exhausted(1));
    assert_eq!(manager.available_count(), 1);

    // 再禁用第二个后，无可用凭据
    assert!(!manager.report_quota_exhausted(2));
    assert_eq!(manager.available_count(), 0);
}

#[tokio::test]
async fn test_multi_token_manager_quota_disabled_is_not_auto_recovered() {
    let config = Config::default();
    let cred1 = KiroCredentials::default();
    let cred2 = KiroCredentials::default();

    let manager =
        MultiTokenManager::new(config, vec![cred1, cred2], None, None, false).unwrap();

    manager.report_quota_exhausted(1);
    manager.report_quota_exhausted(2);
    assert_eq!(manager.available_count(), 0);

    let err = manager
        .acquire_context(None)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        err.contains("所有凭据均已禁用"),
        "错误应提示所有凭据禁用，实际: {}",
        err
    );
    assert_eq!(manager.available_count(), 0);
}

// ============ 凭据级 Region 优先级测试 ============

#[test]
fn test_credential_region_priority_uses_credential_auth_region() {
    // 凭据配置了 auth_region 时，应使用凭据的 auth_region
    let config = Config {
        region: "us-west-2".to_string(),
        ..Default::default()
    };

    let credentials = KiroCredentials {
        auth_region: Some("eu-west-1".to_string()),
        ..Default::default()
    };

    let region = credentials.effective_auth_region(&config);
    assert_eq!(region, "eu-west-1");
}

#[test]
fn test_credential_region_priority_fallback_to_credential_region() {
    // 凭据未配置 auth_region 但配置了 region 时，应回退到凭据.region
    let config = Config {
        region: "us-west-2".to_string(),
        ..Default::default()
    };

    let credentials = KiroCredentials {
        region: Some("eu-central-1".to_string()),
        ..Default::default()
    };

    let region = credentials.effective_auth_region(&config);
    assert_eq!(region, "eu-central-1");
}

#[test]
fn test_credential_region_priority_fallback_to_config() {
    // 凭据未配置 auth_region 和 region 时，应回退到 config
    let config = Config {
        region: "us-west-2".to_string(),
        ..Default::default()
    };

    let credentials = KiroCredentials::default();
    assert!(credentials.auth_region.is_none());
    assert!(credentials.region.is_none());

    let region = credentials.effective_auth_region(&config);
    assert_eq!(region, "us-west-2");
}

#[test]
fn test_multiple_credentials_use_respective_regions() {
    // 多凭据场景下，不同凭据使用各自的 auth_region
    let config = Config {
        region: "ap-northeast-1".to_string(),
        ..Default::default()
    };

    let cred1 = KiroCredentials {
        auth_region: Some("us-east-1".to_string()),
        ..Default::default()
    };

    let cred2 = KiroCredentials {
        region: Some("eu-west-1".to_string()),
        ..Default::default()
    };

    let cred3 = KiroCredentials::default(); // 无 region，使用 config

    assert_eq!(cred1.effective_auth_region(&config), "us-east-1");
    assert_eq!(cred2.effective_auth_region(&config), "eu-west-1");
    assert_eq!(cred3.effective_auth_region(&config), "ap-northeast-1");
}

#[test]
fn test_idc_oidc_endpoint_uses_credential_auth_region() {
    // 验证 IdC OIDC endpoint URL 使用凭据 auth_region
    let config = Config {
        region: "us-west-2".to_string(),
        ..Default::default()
    };

    let credentials = KiroCredentials {
        auth_region: Some("eu-central-1".to_string()),
        ..Default::default()
    };

    let region = credentials.effective_auth_region(&config);
    let refresh_url = format!("https://oidc.{}.amazonaws.com/token", region);

    assert_eq!(refresh_url, "https://oidc.eu-central-1.amazonaws.com/token");
}

#[test]
fn test_social_refresh_endpoint_uses_credential_auth_region() {
    // 验证 Social refresh endpoint URL 使用凭据 auth_region
    let config = Config {
        region: "us-west-2".to_string(),
        ..Default::default()
    };

    let credentials = KiroCredentials {
        auth_region: Some("ap-southeast-1".to_string()),
        ..Default::default()
    };

    let region = credentials.effective_auth_region(&config);
    let refresh_url = format!("https://prod.{}.auth.desktop.kiro.dev/refreshToken", region);

    assert_eq!(
        refresh_url,
        "https://prod.ap-southeast-1.auth.desktop.kiro.dev/refreshToken"
    );
}

#[test]
fn test_api_call_uses_effective_api_region() {
    // 验证 API 调用使用 effective_api_region
    let config = Config {
        region: "us-west-2".to_string(),
        ..Default::default()
    };

    let credentials = KiroCredentials {
        region: Some("eu-west-1".to_string()),
        ..Default::default()
    };

    // 凭据.region 不参与 api_region 回退链
    let api_region = credentials.effective_api_region(&config);
    let api_host = format!("q.{}.amazonaws.com", api_region);

    assert_eq!(api_host, "q.us-west-2.amazonaws.com");
}

#[test]
fn test_api_call_uses_credential_api_region() {
    // 凭据配置了 api_region 时，API 调用应使用凭据的 api_region
    let config = Config {
        region: "us-west-2".to_string(),
        ..Default::default()
    };

    let credentials = KiroCredentials {
        api_region: Some("eu-central-1".to_string()),
        ..Default::default()
    };

    let api_region = credentials.effective_api_region(&config);
    let api_host = format!("q.{}.amazonaws.com", api_region);

    assert_eq!(api_host, "q.eu-central-1.amazonaws.com");
}

#[test]
fn test_credential_region_empty_string_treated_as_set() {
    // 空字符串 auth_region 被视为已设置（虽然不推荐，但行为应一致）
    let config = Config {
        region: "us-west-2".to_string(),
        ..Default::default()
    };

    let credentials = KiroCredentials {
        auth_region: Some("".to_string()),
        ..Default::default()
    };

    let region = credentials.effective_auth_region(&config);
    // 空字符串被视为已设置，不会回退到 config
    assert_eq!(region, "");
}

#[test]
fn test_auth_and_api_region_independent() {
    // auth_region 和 api_region 互不影响
    let config = Config {
        region: "default".to_string(),
        ..Default::default()
    };

    let credentials = KiroCredentials {
        auth_region: Some("auth-only".to_string()),
        api_region: Some("api-only".to_string()),
        ..Default::default()
    };

    assert_eq!(credentials.effective_auth_region(&config), "auth-only");
    assert_eq!(credentials.effective_api_region(&config), "api-only");
}

#[test]
fn test_stats_entry_reads_legacy_file_without_token_fields() {
    // 老版本 kiro_stats.json 没有 input_tokens / output_tokens 两个键。
    // 必须按 0 读入而不是让整份统计解析失败，否则升级后成功次数会全部归零。
    let legacy = r#"{"success_count":128,"last_used_at":"2026-08-08T13:18:31Z"}"#;
    let entry: StatsEntry = serde_json::from_str(legacy).expect("旧格式应能解析");
    assert_eq!(entry.success_count, 128);
    assert_eq!(entry.input_tokens, 0);
    assert_eq!(entry.output_tokens, 0);
}

#[test]
fn test_stats_entry_roundtrip_with_token_fields() {
    let entry = StatsEntry {
        success_count: 7,
        last_used_at: None,
        input_tokens: 12_345,
        output_tokens: 678,
    };
    let json = serde_json::to_string(&entry).expect("序列化应成功");
    let parsed: StatsEntry = serde_json::from_str(&json).expect("反序列化应成功");
    assert_eq!(parsed.success_count, 7);
    assert_eq!(parsed.input_tokens, 12_345);
    assert_eq!(parsed.output_tokens, 678);
}

#[tokio::test]
async fn test_record_token_usage_accumulates_per_credential() {
    let config = Config::default();
    let cred = KiroCredentials {
        refresh_token: Some("rt-1".to_string()),
        ..Default::default()
    };
    let manager = MultiTokenManager::new(config, vec![cred], None, None, false).unwrap();

    let id = manager.snapshot().entries[0].id;
    manager.record_token_usage(id, 100, 20);
    manager.record_token_usage(id, 5, 3);

    let snapshot = manager.snapshot();
    let entry = snapshot.entries.iter().find(|e| e.id == id).unwrap();
    assert_eq!(entry.input_tokens, 105);
    assert_eq!(entry.output_tokens, 23);
    // 记 token 不应影响成功计数：两者由不同事件驱动
    assert_eq!(entry.success_count, 0);
}

#[tokio::test]
async fn test_record_token_usage_ignores_zero_and_unknown_id() {
    let config = Config::default();
    let cred = KiroCredentials {
        refresh_token: Some("rt-1".to_string()),
        ..Default::default()
    };
    let manager = MultiTokenManager::new(config, vec![cred], None, None, false).unwrap();
    let id = manager.snapshot().entries[0].id;

    // 全 0 直接返回，不产生无意义的落盘
    manager.record_token_usage(id, 0, 0);
    // 未知 id（凭据已被删除）不应 panic
    manager.record_token_usage(id + 9999, 50, 50);

    let snapshot = manager.snapshot();
    let entry = snapshot.entries.iter().find(|e| e.id == id).unwrap();
    assert_eq!(entry.input_tokens, 0);
    assert_eq!(entry.output_tokens, 0);
}

// ============ 共享账号库模式 ============

fn db_manager() -> (MultiTokenManager, Arc<AccountStore>, std::path::PathBuf) {
    let (store, path) = crate::kiro::account_store::test_store();
    let store = Arc::new(store);
    let m = MultiTokenManager::new_with_store(Config::default(), store.clone(), None).unwrap();
    (m, store, path)
}

fn live_oauth(rt: &str) -> KiroCredentials {
    KiroCredentials {
        refresh_token: Some(rt.into()),
        access_token: Some(format!("at-{rt}")),
        expires_at: Some((Utc::now() + Duration::hours(1)).to_rfc3339()),
        auth_method: Some("social".into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn db_rotated_save_failure_keeps_new_token_in_memory() {
    let (m, store, _) = db_manager();
    let id = m
        .import_credential(live_oauth("rt-old"), NewAccountMeta::default())
        .unwrap()
        .id;
    let version_before = m.credential_version_of(id);
    store.begin_refresh(id).unwrap();

    // 模拟：上游已轮换，但落库在重试后仍失败（如长时间 BUSY）
    let rotated = live_oauth("rt-new");
    let got = m
        .apply_rotated_save(&store, id, rotated, Err(anyhow::anyhow!("database is locked")))
        .unwrap();
    assert_eq!(got.refresh_token.as_deref(), Some("rt-new"));
    // 内存必须拿着新 refresh token，否则下次刷新会用已作废的旧 token
    assert_eq!(
        m.entry_credentials(id).unwrap().refresh_token.as_deref(),
        Some("rt-new")
    );
    // 版本号不变：下次刷新以同一 base_version 再落库
    assert_eq!(m.credential_version_of(id), version_before);
}

#[tokio::test]
async fn db_rotated_save_conflict_uses_latest_credentials() {
    let (m, store, _) = db_manager();
    let id = m
        .import_credential(live_oauth("rt-old"), NewAccountMeta::default())
        .unwrap()
        .id;
    let got = m
        .apply_rotated_save(
            &store,
            id,
            live_oauth("rt-stale-rotation"),
            Err(CredentialVersionConflict { id }.into()),
        )
        .unwrap();
    // 版本冲突：库里已有别的写入者换上的凭据，不能用本次结果覆盖
    assert_eq!(got.refresh_token.as_deref(), Some("rt-old"));
}

#[tokio::test]
async fn refresh_locks_are_per_credential() {
    let manager = manager_with_two_live_creds(false);
    let (a, b) = {
        let entries = manager.entries.lock();
        (entries[0].id, entries[1].id)
    };
    let lock_a = manager.refresh_lock_for(a);
    let _held = lock_a.lock().await;
    // 凭据 A 正在刷新时，凭据 B 的刷新锁仍可立即拿到
    assert!(manager.refresh_lock_for(b).try_lock().is_ok());
    // 同一凭据拿到的是同一把锁
    assert!(manager.refresh_lock_for(a).try_lock().is_err());
}

#[tokio::test]
async fn db_import_dedups_and_only_pool_members_are_scheduled() {
    let (m, _, _) = db_manager();
    let meta = |uuid: &str, in_pool| NewAccountMeta {
        account_uuid: Some(uuid.into()),
        in_pool,
        ..Default::default()
    };
    let first = m
        .import_credential(live_oauth("rt-a"), meta("p-a", false))
        .unwrap();
    assert!(first.created);
    let a = first.id;
    // 同一 refresh token / 同一 account_uuid 不会重复创建
    assert_eq!(
        m.import_credential(live_oauth("rt-a"), meta("p-x", false))
            .unwrap()
            .id,
        a
    );
    assert_eq!(
        m.import_credential(live_oauth("rt-z"), meta("p-a", false))
            .unwrap()
            .id,
        a
    );
    // 不在号池的账号不参与调度
    assert!(m.acquire_context(None).await.is_err());
    m.set_in_pool(a, true).unwrap();
    assert_eq!(m.acquire_context(None).await.unwrap().id, a);
    m.set_in_pool(a, false).unwrap();
    assert!(m.acquire_context(None).await.is_err());
    assert_eq!(m.snapshot().available, 0);
}

#[tokio::test]
async fn db_auto_disable_reason_survives_restart() {
    let (m, store, _) = db_manager();
    let id = m
        .import_credential(
            live_oauth("rt-a"),
            NewAccountMeta {
                in_pool: true,
                ..Default::default()
            },
        )
        .unwrap()
        .id;
    m.report_quota_exhausted(id);
    drop(m);
    let reloaded = MultiTokenManager::new_with_store(Config::default(), store, None).unwrap();
    let entry = &reloaded.snapshot().entries[0];
    assert!(entry.disabled);
    assert_eq!(entry.disabled_reason.as_deref(), Some("QuotaExceeded"));
}

#[tokio::test]
async fn db_counters_are_flushed_and_reloaded() {
    let (m, store, _) = db_manager();
    let id = m
        .import_credential(
            live_oauth("rt-a"),
            NewAccountMeta {
                in_pool: true,
                ..Default::default()
            },
        )
        .unwrap()
        .id;
    m.report_success(id);
    m.record_token_usage(id, 11, 22);
    m.flush_stats();
    drop(m);
    let reloaded = MultiTokenManager::new_with_store(Config::default(), store, None).unwrap();
    let entry = &reloaded.snapshot().entries[0];
    assert_eq!(entry.success_count, 1);
    assert_eq!((entry.input_tokens, entry.output_tokens), (11, 22));
    assert!(entry.last_used_at.is_some());
}

#[tokio::test]
async fn db_ensure_fresh_reuses_when_version_moved_or_token_valid() {
    let (m, _, _) = db_manager();
    let id = m
        .import_credential(live_oauth("rt-a"), NewAccountMeta::default())
        .unwrap()
        .id;
    // token 有效、未强制：不刷新
    assert_eq!(m.ensure_fresh(id, None, false).await.unwrap(), 0);
    // 调用方持有的版本已落后：即使 force 也直接复用，不再轮换
    assert_eq!(m.ensure_fresh(id, Some(-1), true).await.unwrap(), 0);
}

#[tokio::test]
async fn db_delete_is_soft_and_blocks_reimport_of_same_uuid() {
    let (m, store, _) = db_manager();
    let meta = NewAccountMeta {
        account_uuid: Some("p-a".into()),
        ..Default::default()
    };
    let id = m
        .import_credential(live_oauth("rt-a"), meta.clone())
        .unwrap()
        .id;
    m.set_disabled(id, true).unwrap();
    m.delete_credential(id).unwrap();
    assert!(m.snapshot().entries.is_empty());
    assert!(m.import_credential(live_oauth("rt-b"), meta).is_err());
    let reloaded = MultiTokenManager::new_with_store(Config::default(), store, None).unwrap();
    assert!(reloaded.snapshot().entries.is_empty());
}

#[test]
fn db_json_only_operations_are_rejected_without_store() {
    let m = MultiTokenManager::new(Config::default(), vec![], None, None, false).unwrap();
    assert!(m.set_in_pool(1, true).is_err());
    assert!(
        m.import_credential(live_oauth("rt"), NewAccountMeta::default())
            .is_err()
    );
}

#[tokio::test]
async fn db_add_existing_credential_puts_it_into_pool() {
    let (m, _, _) = db_manager();
    let api = KiroCredentials {
        auth_method: Some("api_key".into()),
        kiro_api_key: Some("ksk_existing_key".into()),
        ..Default::default()
    };
    let id = m
        .import_credential(api.clone(), NewAccountMeta::default())
        .unwrap()
        .id;
    assert!(!m.snapshot().entries[0].in_pool);
    // Admin "添加凭据"遇到库中已有的同一凭据：不报错，改为入池并返回已有 ID
    assert_eq!(m.add_credential(api).await.unwrap(), id);
    assert!(m.snapshot().entries[0].in_pool);
    m.purge_credential(id).unwrap();
    assert!(m.snapshot().entries.is_empty());
}

#[tokio::test]
async fn db_external_refresh_account_is_never_refreshed_by_kiro_rs() {
    let (m, store, _) = db_manager();
    let meta = |uuid: &str, identity: &str| NewAccountMeta {
        account_uuid: Some(uuid.into()),
        upstream_identity: Some(identity.into()),
        in_pool: true,
        ..Default::default()
    };
    let cli = m
        .import_credential(live_oauth("rt-cli"), meta("p-cli", "user-cli"))
        .unwrap();
    let other = m
        .import_credential(live_oauth("rt-other"), meta("p-other", "user-other"))
        .unwrap();
    assert_eq!(
        m.set_external_refresh_account(Some("p-cli")).unwrap(),
        Some(cli.id)
    );
    assert_eq!(m.external_refresh_account(), Some(cli.id));
    let version = m.snapshot().entries[0].credential_version;

    // token 还能用：强制确保新鲜也不刷新，直接给现有版本
    assert_eq!(m.ensure_fresh(cli.id, None, true).await.unwrap(), version);
    // 显式强刷 / 401 强刷：一律拒绝，不碰上游
    let err = m
        .refresh_token_if_current(cli.id, Some("at-rt-cli"))
        .await
        .unwrap_err();
    assert!(err.downcast_ref::<ExternalRefreshPendingError>().is_some());

    // token 过期：不再调度它，请求落到另一个账号；不计失败、不禁用
    let expired = KiroCredentials {
        expires_at: Some((Utc::now() - Duration::minutes(1)).to_rfc3339()),
        ..live_oauth("rt-cli")
    };
    store.replace_credentials(cli.id, &expired).unwrap();
    m.entries
        .lock()
        .iter_mut()
        .find(|e| e.id == cli.id)
        .unwrap()
        .credentials
        .expires_at = expired.expires_at.clone();
    for _ in 0..3 {
        assert_eq!(m.acquire_context(None).await.unwrap().id, other.id);
    }
    let err = m.ensure_fresh(cli.id, None, false).await.unwrap_err();
    assert!(err.downcast_ref::<ExternalRefreshPendingError>().is_some());
    let entry = m
        .entries
        .lock()
        .iter()
        .find(|e| e.id == cli.id)
        .map(|e| (e.disabled, e.refresh_failure_count));
    assert_eq!(entry, Some((false, 0)));

    // kiro-cli 刷新后收编：恢复调度
    let refreshed = live_oauth("rt-cli-2");
    assert!(matches!(
        m.adopt_with_identity(&refreshed, "user-cli").unwrap(),
        AdoptOutcome::Adopted { .. }
    ));
    assert!(
        m.entries
            .lock()
            .iter()
            .find(|e| e.id == cli.id)
            .is_some_and(|e| e.external_refresh && e.schedulable())
    );

    // 取消后恢复由 kiro-rs 刷新
    assert_eq!(m.set_external_refresh_account(None).unwrap(), None);
    assert_eq!(m.external_refresh_account(), None);
    assert!(m.set_external_refresh_account(Some("no-such")).is_err());
}

#[tokio::test]
async fn db_adopt_external_credential_replaces_only_newer_token_of_same_account() {
    let (m, store, _) = db_manager();
    let imported = m
        .import_credential(
            live_oauth("rt-db"),
            NewAccountMeta {
                account_uuid: Some("p-1".into()),
                upstream_identity: Some("user-1".into()),
                in_pool: true,
                ..Default::default()
            },
        )
        .unwrap();
    let base_version = m.snapshot().entries[0].credential_version;
    let machine_before = store.load_all().unwrap()[0].credentials.machine_id.clone();
    let with_expiry = |rt: &str, hours: i64| KiroCredentials {
        expires_at: Some((Utc::now() + Duration::hours(hours)).to_rfc3339()),
        ..live_oauth(rt)
    };

    // 库里已是这份：不动
    assert_eq!(
        m.adopt_with_identity(&live_oauth("rt-db"), "user-1")
            .unwrap(),
        AdoptOutcome::Current {
            id: imported.id,
            credential_version: base_version
        }
    );
    // 别的上游账号：不写
    assert_eq!(
        m.adopt_with_identity(&with_expiry("rt-other", 2), "user-2")
            .unwrap(),
        AdoptOutcome::NotFound
    );
    // 外部这份不比库里新（CLI 里是旧 token）：不能覆盖
    assert_eq!(
        m.adopt_with_identity(&with_expiry("rt-old", 0), "user-1")
            .unwrap(),
        AdoptOutcome::Stale {
            id: imported.id,
            credential_version: base_version
        }
    );
    // kiro-rs 自己的刷新在途时收编：在途结果写不进去，外部这份生效
    let in_flight = store.begin_refresh(imported.id).unwrap();
    let adopted = m
        .adopt_with_identity(&with_expiry("rt-cli", 2), "user-1")
        .unwrap();
    assert_eq!(
        adopted,
        AdoptOutcome::Adopted {
            id: imported.id,
            credential_version: in_flight + 1
        }
    );
    let row = &store.load_all().unwrap()[0];
    assert_eq!(row.credentials.refresh_token.as_deref(), Some("rt-cli"));
    assert_eq!(m.snapshot().entries[0].credential_version, in_flight + 1);
    assert!(
        store
            .save_rotated_credentials(imported.id, Some(in_flight), &live_oauth("rt-late"))
            .is_err(),
        "在途的自身刷新结果不能覆盖收编的凭据"
    );
    // 账号自身配置（机器码）保留
    assert!(row.credentials.machine_id.is_some());
    assert_eq!(row.credentials.machine_id, machine_before);
}

#[tokio::test]
async fn db_relogin_by_upstream_identity_replaces_credentials_in_place() {
    let (m, store, _) = db_manager();
    let meta = |uuid: &str| NewAccountMeta {
        account_uuid: Some(uuid.into()),
        upstream_identity: Some("user-1".into()),
        in_pool: true,
        ..Default::default()
    };
    let first = m
        .import_credential(live_oauth("rt-old"), meta("p-old"))
        .unwrap();
    assert!(first.created);
    // 旧 token 失效被禁用
    m.report_refresh_token_invalid(first.id);
    assert!(m.snapshot().entries[0].disabled);
    // 旧凭据发起的额度查询还没回来
    let stale_seq = store.begin_usage(first.id).unwrap();
    // 在途刷新拿到的基准版本
    let base = store.begin_refresh(first.id).unwrap();

    // 用户重新登录同一个上游账号（proxy 里是一个新账号 ID）
    let relogin = m
        .import_credential(live_oauth("rt-new"), meta("p-new"))
        .unwrap();
    assert_eq!(
        relogin,
        ImportOutcome {
            id: first.id,
            created: false,
            replaced: true
        }
    );
    let entry = &m.snapshot().entries[0];
    assert_eq!(m.snapshot().entries.len(), 1, "不新增行");
    assert!(!entry.disabled, "失效禁用被解除");
    assert_eq!(entry.credential_version, base + 1);
    let row = &store.load_all().unwrap()[0];
    assert_eq!(row.credentials.refresh_token.as_deref(), Some("rt-new"));
    assert!(!row.credentials.disabled);

    // 迟到的旧刷新结果写不进去（版本已变）
    assert!(
        store
            .save_rotated_credentials(first.id, Some(base), &live_oauth("rt-from-old-refresh"))
            .is_err()
    );
    // 旧额度查询的结果被丢弃
    let write = UsageWrite {
        seq: stale_seq,
        raw_json: "{}",
        used_amount: 1.0,
        limit_amount: 1.0,
        reset_at_ms: None,
        subscription_title: None,
        upstream_identity: None,
    };
    assert!(!store.finish_usage(first.id, &write).unwrap());
    assert_eq!(
        store.load_all().unwrap()[0]
            .credentials
            .refresh_token
            .as_deref(),
        Some("rt-new")
    );
}

#[tokio::test]
async fn db_manual_disable_survives_relogin() {
    let (m, _, _) = db_manager();
    let meta = NewAccountMeta {
        upstream_identity: Some("user-2".into()),
        ..Default::default()
    };
    let id = m
        .import_credential(live_oauth("rt-a"), meta.clone())
        .unwrap()
        .id;
    m.set_disabled(id, true).unwrap();
    let again = m.import_credential(live_oauth("rt-b"), meta).unwrap();
    assert!(again.replaced);
    // 手动禁用不是凭据问题，重新登录不应自动解除
    assert!(m.snapshot().entries[0].disabled);
}

#[tokio::test]
async fn a03_a14_pool_toggle_never_touches_credentials() {
    let (m, store, _) = db_manager();
    let id = m
        .import_credential(live_oauth("rt-a"), NewAccountMeta::default())
        .unwrap()
        .id;
    let before = store.load_all().unwrap()[0].credentials.clone();
    m.set_in_pool(id, true).unwrap();
    m.set_in_pool(id, false).unwrap();
    m.set_in_pool(id, true).unwrap();
    let after = &store.load_all().unwrap()[0];
    assert_eq!(after.credential_version, 0, "入池出池不刷新、不轮换");
    assert_eq!(after.credentials.refresh_token, before.refresh_token);
    assert_eq!(after.credentials.access_token, before.access_token);
    assert_eq!(after.credentials.expires_at, before.expires_at);
    // 出池不删除账号
    m.set_in_pool(id, false).unwrap();
    assert_eq!(m.snapshot().entries.len(), 1);
}

#[tokio::test]
async fn a15_late_refresh_result_cannot_revive_deleted_account() {
    let (m, store, _) = db_manager();
    let id = m
        .import_credential(live_oauth("rt-a"), NewAccountMeta::default())
        .unwrap()
        .id;
    let base = store.begin_refresh(id).unwrap();
    m.purge_credential(id).unwrap();
    // 在途刷新回来了：写入账号凭据表不会让账号重新出现
    let _ = store.save_rotated_credentials(id, Some(base), &live_oauth("rt-late"));
    assert!(store.load_all().unwrap().is_empty());
    let reloaded = MultiTokenManager::new_with_store(Config::default(), store, None).unwrap();
    assert!(reloaded.snapshot().entries.is_empty());
}

#[tokio::test]
async fn a08_api_key_account_is_never_refreshed() {
    let (m, store, _) = db_manager();
    let key = KiroCredentials {
        auth_method: Some("api_key".into()),
        kiro_api_key: Some("ksk_no_refresh".into()),
        ..Default::default()
    };
    let id = m
        .import_credential(key, NewAccountMeta::default())
        .unwrap()
        .id;
    // 强制刷新也直接返回当前版本，不进入 OAuth 刷新
    assert_eq!(m.ensure_fresh(id, None, true).await.unwrap(), 0);
    assert_eq!(store.load_all().unwrap()[0].credential_version, 0);
}

#[tokio::test]
async fn a05_concurrent_ensure_fresh_on_valid_token_does_not_refresh() {
    let (m, store, _) = db_manager();
    let m = Arc::new(m);
    let id = m
        .import_credential(live_oauth("rt-a"), NewAccountMeta::default())
        .unwrap()
        .id;
    let tasks: Vec<_> = (0..16)
        .map(|_| {
            let m = m.clone();
            tokio::spawn(async move { m.ensure_fresh(id, None, false).await.unwrap() })
        })
        .collect();
    for task in tasks {
        assert_eq!(task.await.unwrap(), 0);
    }
    assert_eq!(store.load_all().unwrap()[0].credential_version, 0);
}

#[tokio::test]
async fn a40_reimport_after_delete_creates_new_row_without_old_stats() {
    let (m, store, _) = db_manager();
    let meta = |uuid: &str| NewAccountMeta {
        account_uuid: Some(uuid.into()),
        upstream_identity: Some("user-del".into()),
        in_pool: true,
        ..Default::default()
    };
    let old = m
        .import_credential(live_oauth("rt-1"), meta("p-1"))
        .unwrap()
        .id;
    m.report_success(old);
    m.flush_stats();
    m.purge_credential(old).unwrap();
    // 同一上游账号删除后重新导入：已删除行不参与身份匹配，新建一行，唯一索引不冲突
    let again = m
        .import_credential(live_oauth("rt-2"), meta("p-2"))
        .unwrap();
    assert!(again.created && !again.replaced);
    assert_ne!(again.id, old);
    let rows = store.load_all().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].counters.success_count, 0, "旧行统计不被复用");
}
