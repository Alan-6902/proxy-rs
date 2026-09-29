# 本仓库导览

一个仓库两套代码，运行时是客户端/服务端关系：

| 目录 | 是什么 | 技术栈 |
|---|---|---|
| `proxy-rs/` | 桌面端：账号管理、KSK 任务、Cursor / Grok 账号 | Electron + React + TypeScript |
| `kiro-rs-src/` | 反代：凭据池、Admin API、Admin 页面 | Rust (axum) + React |

`proxy-rs` 通过 `src/main/kskAutomation/localAdminClient.ts` 调 `kiro-rs-src` 的
`/api/admin/credentials`。**改 Admin 接口字段时两边要一起改**，同仓的意义就在这里。

## 常用文档

- 反代改完怎么打包进 App、怎么替换本机正在用的版本 → `kiro-rs-src/docs/构建与部署.md`
- 账号库模式（共享 SQLite、kiro-rs 由 proxy 拉起）的点测、切换、回滚与旧文件清理 → `proxy-rs/docs/账号库切换与点测.md`

## 两个容易踩的点

**`kiro-rs-src` 直接 `cargo build` 会失败。** `rust-embed` 编译期需要
`admin-ui/dist`，而它是 gitignore 的构建产物。先
`cd kiro-rs-src/admin-ui && pnpm install && pnpm build`。走 `proxy-rs/scripts/build-kiro-rs.sh` 则不受影响。

**`kiro-rs-src` 已与上游断开。** 它是 `hank9999/kiro.rs` 的 fork 拷贝，移入单仓时
丢掉了 git 关联，上游更新只能手工 diff 对。

## 部署目录在仓库外

kiro-rs 不再跑在 Docker 里：它打包在 `/Applications/Proxy RS.app` 里，由 proxy-rs 作为子进程拉起。
运行配置在 `~/kiro-rs/config/config.json`，账号与全部 token 在 `~/kiro-rs/data/accounts.sqlite3`。
改那里的文件等于动正在用的数据，**先跟用户确认**；凭据与账号库内容不要回显明文。
