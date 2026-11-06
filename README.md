# Proxy RS

一个仓库两套代码，运行时是客户端 / 服务端关系：

| 目录 | 是什么 | 技术栈 | 文档 |
|---|---|---|---|
| [`proxy-rs/`](proxy-rs/) | 桌面端：账号管理、KSK 任务、反代管理页 | Electron + React + TypeScript | [README](proxy-rs/README.md) · [账号库切换与点测](proxy-rs/docs/账号库切换与点测.md) |
| [`kiro-rs-src/`](kiro-rs-src/) | 反代：凭据池、Admin API、Admin 页面（含 Antigravity / Qoder 两个独立进程） | Rust (axum) + React | [README](kiro-rs-src/README.md) · [构建与部署](kiro-rs-src/docs/构建与部署.md) |

`proxy-rs` 通过 `src/main/accountDb/adminApi.ts` 等模块调 `kiro-rs-src` 的 `/api/admin/*`；
**改 Admin 接口字段时两边要一起改**，TS 侧用 zod 按 Rust 的 `admin/types.rs` 做运行时校验。

## 开发

```bash
# 桌面端
cd proxy-rs && npm ci
npm run typecheck && npm run lint && npm run test:unit
npm run dev

# 反代（rust-embed 编译期需要 admin-ui/dist，先构建前端）
cd kiro-rs-src/admin-ui && pnpm install && pnpm build
cd .. && cargo clippy --all-targets && cargo test
```

- 两套代码的检查由 `.github/workflows/check.yml` 在每次 push / PR 上执行。
- 打包与安装到本机：`cd proxy-rs && npm run deploy:current`，详见 [kiro-rs-src/docs/构建与部署.md](kiro-rs-src/docs/构建与部署.md)。
- 只产出 macOS 包：kiro-rs 子进程按运行机架构构建并作为 `extraResources` 打进 App。

## 运行时位置

kiro-rs 打包在 `/Applications/Proxy RS.app` 里，由 proxy-rs 作为子进程拉起。运行配置在
`~/kiro-rs/config/config.json`，账号与全部 token 在 `~/kiro-rs/data/accounts.sqlite3`。

给 AI 代理的导览见 [AGENTS.md](AGENTS.md)，本机部署步骤见 [Agent本机部署步骤.md](Agent本机部署步骤.md)。

## 许可证

[AGPL-3.0](LICENSE)
