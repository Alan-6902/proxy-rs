# 本仓库导览

一个仓库两套代码，运行时是客户端/服务端关系：

| 目录 | 是什么 | 技术栈 |
|---|---|---|
| `proxy-rs/` | 桌面端：账号管理、抢号、统计、KSK 台账、下游对账 | Electron + React + TypeScript |
| `kiro-rs-src/` | 反代：凭据池、Admin API、Admin 页面 | Rust (axum) + React |

`proxy-rs` 通过 `src/main/kskAutomation/localAdminClient.ts` 调 `kiro-rs-src` 的
`/api/admin/credentials`。**改 Admin 接口字段时两边要一起改**，同仓的意义就在这里。

## 常用文档

- 反代改完怎么打镜像、怎么部署到本机 → `kiro-rs-src/docs/构建与部署.md`
- 抢号报表的数据口径 → `proxy-rs/docs/抢号报表数据.md`
- 跟下游对账收款的数据口径与 CSV 存档 → `proxy-rs/docs/下游对账数据.md`
- 接入新的抢号渠道 → `proxy-rs/docs/接入新抢号渠道.md`

## 两个容易踩的点

**`kiro-rs-src` 直接 `cargo build` 会失败。** `rust-embed` 编译期需要
`admin-ui/dist`，而它是 gitignore 的构建产物。先
`cd kiro-rs-src/admin-ui && pnpm install && pnpm build`。走 `docker build` 则不受影响。

**`kiro-rs-src` 已与上游断开。** 它是 `hank9999/kiro.rs` 的 fork 拷贝，移入单仓时
丢掉了 git 关联，上游更新只能手工 diff 对。

## 部署目录在仓库外

本机跑的反代由 `~/kiro-rs/docker-compose.yml` 声明，配置和真实凭据在
`~/kiro-rs/config/`。改那里的文件等于动生产，**先跟用户确认**；凭据文件不要回显明文。
