# 题词：将 Antigravity（agy）反代内化到 Proxy RS

> 用途：给后续开发 / Agent 实现用的需求题词。
> 仓库：`/Users/ma/cache/AI/kiro-rs/proxy-rs`（Proxy RS，下称 **Proxy RS**）
> 背景时间：2026-08（本机已有可跑通的外部 agy 方案，计划收编进 Proxy RS）

---

## 1. 一句话目标

在 Proxy RS 现有「Kiro 上游反代」能力之上，**新增 Antigravity（agy / Google Cloud Code）作为一等上游 Provider**，让用户在 Proxy RS 内完成：Google 账号管理 → 本地 Anthropic 兼容反代 → 一键配置 Claude Code / CC Switch，**不再依赖外部 `antigravity-claude-proxy`（acc）+ 手工脚本**。

---

## 2. 现状（As-Is）

### 2.1 Proxy RS 已有（可复用）

- Electron + React 桌面端，主进程内嵌 **API 反代**（`src/main/proxy/`）
- 已支持：OpenAI / Claude Messages / Gemini 兼容、SSE、多账号轮询、断路器、Token 刷新、用量统计、API Key 鉴权
- 一键配置客户端：`claudeCode | opencode | codex | gemini | hermes | openclaw`（`clientConfig.ts`）
- 账号-出站代理 N:1 分桶、代理池、任务中心、诊断面板
- 文档：`docs/API-Proxy-Guide.md`

### 2.2 本机临时方案（To-Be 收编对象）

当前为「外挂」链路，已验证可跑通 Opus 4.6 Thinking：

```text
Claude Code
  → CC Switch 供应商 agy-opus46
  → ANTHROPIC_BASE_URL=http://127.0.0.1:65530
  → ANTHROPIC_AUTH_TOKEN=代理密码（非 Google 凭证）
  → antigravity-claude-proxy (acc)
  → Google OAuth / Antigravity Cloud Code
  → claude-opus-4-6-thinking（约 1M 上下文）
```

本机落点（仅作迁移参考，勿当长期架构）：

| 路径 | 作用 |
|------|------|
| `~/agy-proxy/{start,stop,status}.sh` | 固定 `PORT=65530` 启停 |
| `~/.config/antigravity-proxy/config.json` | `port` / `apiKey` / `webuiPassword` |
| `~/Desktop/doc/agy->ccswitch/README.md` | 操作说明 |
| CC Switch DB `agy-opus46` | 写入 `~/.claude/settings.json` |

踩过的坑（内化时必须规避）：

1. **端口**：TCP ≤65535；`acc` CLI 的 status 只认环境变量 `PORT`，配置文件 `port` 不够
2. **双 Key 分离**：上游 Google OAuth ≠ 客户端访问代理的 `apiKey`（对齐 kiro-ksk：`ksk_` 只进代理，代理密码进 CC Switch）
3. **acc WebUI「Apply to Claude CLI」会写死 `localhost:8080`**，覆盖正确 Base URL → ConnectionRefused
4. **进程假死**：端口 LISTEN 但 `/health` 超时，需可观测 + 一键重启
5. **健康检查鉴权**：`/health` 走 `x-webui-password`；`/v1/*` 走 `x-api-key` / Bearer

---

## 3. 目标架构（To-Be）

```text
                    ┌──────────────────────────────────────┐
                    │                 Proxy RS                   │
                    │  ┌────────────┐  ┌─────────────────┐ │
 Claude Code /      │  │ Account    │  │ Proxy Gateway   │ │
 CC Switch /        │  │ Pool       │  │  - kiro         │ │
 其它客户端  ──────►│  │ - kiro     │─►│  - agy (新增)   │ │
 ANTHROPIC_*        │  │ - agy(新)  │  │  统一 /v1/*     │ │
                    │  └────────────┘  └────────┬────────┘ │
                    │                           │          │
                    │              �┘  └────────┬────────┘ │
                    │                           │          │
                    │              ┌────────────┴───────┐  │
                    │              ▼                    ▼  │
                    │         Kiro 后端          Antigravity│
                    │                           Cloud Code │
                    └──────────────────────────────────────┘
```

原则：

- **对外只暴露一套 Anthropic / OpenAI 兼容入口**（可多端口或 path 前缀区分 provider，但客户端体验统一）
- **上游凭证永不进入 Claude Code / CC Switch**；客户端只拿 Proxy RS 代理密码
- **Provider 可插拔**：`kiro` 与 `agy` 并行，可分别启停、分账号池、分路由策略
- **一键配置客户端**复用现有 `clientConfig`，扩展 agy 默认模型映射

---

## 4. 功能需求

### 4.1 P0（必须）

1. **agy 账号管理**
   - 添加 Google / Antigravity 账号（OAuth 浏览器流 + 可选从本机 Antigravity 会话导入）
   - 列表：邮箱、状态、配额（至少 Opus/Sonnet 剩余比例与 reset 时间）、最后使用时间
   - 删除 / 禁用 / 手动刷新配额
   - 多账号轮询（复用现有断路器 / 粘滞 / 退避策略，按 provider 隔离）

2. **agy 上游适配器**
   - 入：Anthropic `POST /v1/messages`（及现有已支持的 Claude Code 行为）
   - 出：Antigravity Cloud Code / Google Generative AI 包装协议（参考 acc / 社区实现，自研或可替换模块，**不强制长期依赖外部 acc 进程**）
   - 支持：SSE 流式、thinking blocks、tool use、模型名映射
   - 默认模型：`claude-opus-4-6-thinking`；Sonnet/Haiku 映射可配，默认 `claude-sonnet-4-6`

3. **统一本地反代网关**
   - 可配置 host/port（建议默认避开 8080；示例可用 `65530` 或用户自选）
   - 可选 `apiKey`（客户端 `ANTHROPIC_AUTH_TOKEN` / `x-api-key`）
   - `/health`、账号限额摘要、管理 API（对齐现有 admin 能力）
   - 启动 / 停止 / 重启；托盘状态；假死检测（LISTEN 无响应则告警+可自动重启）

4. **一键配置 Claude Code**
   - 写入或生成与 CC Switch 兼容的供应商配置字段：
     - `ANTHROPIC_BASE_URL` = Proxy RS 反代地址（**无错误默认 8080**）
     - `ANTHROPIC_AUTH_TOKEN` = Proxy RS 代理密码
     - `ANTHROPIC_MODEL` / `DEFAULT_OPUS/SONNET/HAIKU` = agy 模型 ID
   - 支持「仅生成 JSON / 直接写入 `~/.claude/settings.json` / 导出给 CC Switch」三种模式（至少前两种）
   - **禁止**实现会把 Base URL 静默改回 8080 的 Apply 逻辑

5. **可观测**
   - 请求日志（可开关）、失败分类（鉴权 / 上游配额 / 协议错误 / 网络）
   - 本机通知：代理挂掉、账号全不可用、配额耗尽

### 4.2 P1（重要）

- Provider 路由：按模型前缀 / 显式 header / 独立 path（如 `/agy/v1/messages` vs `/kiro/v1/messages`）选择上游
- CC Switch：一键导出「供应商」JSON 或说明字段表（名称建议 `agy-opus46`）
- 与现有出站代理池联动：agy 账号也可绑定 SOCKS/HTTP，刷新与推理同出口
- WebUI 密码与 API Key 分离（对齐 acc：`webuiPassword` vs `apiKey`）

### 4.3 P2（可选）

- 内嵌精简 Dashboard（账号/配额/延迟）
- 从 `~/.config/antigravity-proxy` 一键迁移账号与配置
- launchd / 开机自启 Proxy RS 反代子服务
- OpenClaw / Hermes 等其它客户端 agy 预设

---

## 5. 非目标（明确不做）

- 不破解、不绕过付费墙、不批量共享他人订阅（合规与 ToS 自负，产品文案需提示风险）
- 不在首期重写全部 Kiro 反代；agy 以 **新 Provider 模块** 接入，避免大爆炸重构
- 不强制用户卸载外部 acc；可并存一个版本，但默认路径应是「只用 Proxy RS」
- 不做公网暴露反代（默认 `127.0.0.1`）

---

## 6. 客户端契约（验收用）

### 6.1 Claude Code / CC Switch 期望字段

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<PROXY_RS_API_KEY>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:<PORT>",
    "ANTHROPIC_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-4-6",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-4-6",
    "ENABLE_EXPERIMENTAL_MCP_CLI": "true",
    "API_TIMEOUT_MS": "3000000"
  },
  "model": "opus"
}
```

### 6.2 冒烟命令

```bash
# 健康
curl -sS "http://127.0.0.1:<PORT>/health" \
  -H "x-api-key: <PROXY_RS_API_KEY>"   # 或项目统一的健康鉴权头

# Messages
curl -sS "http://127.0.0.1:<PORT>/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <PROXY_RS_API_KEY>" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-6-thinking",
    "max_tokens": 64,
    "messages": [{"role":"user","content":"只回复：ok"}]
  }'
```

期望：HTTP 200，正文含 assistant text（如 `ok`），thinking 可选透传。

### 6.3 端到端

1. Proxy RS 内添加至少 1 个 agy 账号且配额可见
2. 启动反代
3. 一键配置 Claude Code
4. 新终端 `claude` 对话成功
5. 停止反代后 Claude Code 应失败；重启反代后恢复

---

## 7. 实现指引（给开发 / Agent）

### 7.1 建议落点

| 模块 | 建议路径 |
|------|----------|
| agy 协议适配 | `src/main/proxy/providers/agy/`（新建） |
| 账号存储 | 扩展现有账号模型：`provider: 'kiro' \| 'agy'` |
| UI | 反代页增加 Provider Tab；或独立「Antigravity」账号页 |
| 一键配置 | 扩展 `clientConfig.ts` 的模型默认值与 Base URL 生成 |
| 测试 | `test/integration/proxy.agy-*.test.ts`（mock 上游） |

### 7.2 设计约束

- **外科手术式改动**：先加 Provider，不重写 translator 全家桶
- **魔法值下沉**：端口默认值、模型 ID、header 名进常量/枚举
- **流式**：`proxy_buffering` 类问题在 Node 层注意不缓冲完整 SSE
- **鉴权**：管理面与数据面密钥分离
- **错误语义**：上游配额空 → 503 + 可读信息；客户端密钥错 → 401

### 7.3 参考实现（只读对照，勿直接 vendoring 违规协议细节进公开文档时可模糊处理）

- 本机已跑通：`antigravity-claude-proxy`（acc）行为与坑
- Proxy RS 现有：`src/main/proxy/proxyServer.ts`、`translator.ts`、`clientConfig.ts`
- 操作手册：`~/Desktop/doc/agy->ccswitch/README.md`

### 7.4 风险文案（产品必须露出）

使用 Antigravity / Google 账号做第三方反代可能违反 Google / Anthropic 服务条款，存在封号风险；建议非主号；用户自担风险。

---

## 8. 里程碑建议

| 阶段 | 交付 | 验收 |
|------|------|------|
| M1 | agy 适配器 + 单账号 + `/v1/messages` 非流式/流式 | curl 冒烟通过 |
| M2 | 多账号轮询 + 配额面板 + 启停/假死检测 | 账号耗尽可切换；挂起可重启 |
| M3 | 一键配置 Claude Code + 导出 CC Switch 字段 | 新终端 `claude` 可用 |
| M4 | 与 Kiro Provider 并存路由 + 出站代理绑定 | 同端口或分 path 稳定分流 |
| M5 | 迁移向导（从 acc/本机配置导入）+ 文档更新 | 可卸载外部 acc |

---

## 9. 给 Agent 的执行指令（可直接粘贴开干）

```text
你在仓库 proxy-rs（Proxy RS）中工作。
目标：把本机已验证的 Antigravity（agy）Claude 反代能力内化为 Proxy RS 的一等 Provider，
使 Claude Code 只需指向 Proxy RS 本地反代即可使用 claude-opus-4-6-thinking，无需外部 acc。

约束：
1. 复用现有 src/main/proxy 架构，新增 provider=agy，不要推倒重来。
2. 严格双 Key：Google OAuth 只存 Proxy RS；客户端只用代理 apiKey。
3. 一键配置严禁默认写 localhost:8080；Base URL 必须等于当前 Proxy RS 反代实际 host:port。
4. 先交付 M1–M3；每阶段用 curl 冒烟 + 尽可能补 integration test。
5. 代码风格贴合现有 TypeScript/Electron；魔法值抽常量；中文 UI 文案与现有 i18n 一致。
6. 在 UI/关于或首次启用处提示 ToS 风险。

完成标准：见本文档第 6 节验收契约。
```

---

## 10. 一句话记忆

```text
Kiro 凭证 / Google 凭证 → 只进 Proxy RS
代理密码 → 只给 Claude Code / CC Switch
agy 不再外挂 acc，而成为 Proxy RS 的一个上游 Provider
```
