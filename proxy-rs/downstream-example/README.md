# 下游接口参考实现

抢号器在自动下单模式下需要你提供两个本地接口。这个目录是可直接运行的参考实现。

| 文件           | 用途                               |
| -------------- | ---------------------------------- |
| `API.md`       | **接口契约**，以此为准             |
| `server.mjs`   | 零依赖参考实现（Node 内置 `http`） |
| `selftest.mjs` | 服务端自测，39 项                  |

## 跑起来

```bash
DOWNSTREAM_API_KEY=your-secret node server.mjs
```

然后在抢号监控页把「下游地址」填 `http://127.0.0.1:12889`，「下游 API Key」填
`your-secret`，打开「推送给下游」开关。

环境变量：

| 变量                   | 默认        | 说明                                    |
| ---------------------- | ----------- | --------------------------------------- |
| `DOWNSTREAM_API_KEY`   | 无（必填）  | 校验 `x-api-key` 用；不设则拒绝一切请求 |
| `DOWNSTREAM_PORT`      | `12889`     | 监听端口                                |
| `DOWNSTREAM_HOST`      | `127.0.0.1` | 监听地址，默认只听 loopback             |
| `DOWNSTREAM_BASE_PATH` | 空          | 路径前缀，如 `/hooks`                   |
| `DOWNSTREAM_WANTED`    | `1`         | 初始需求水位（还想收几个号）            |

## 自测

```bash
node selftest.mjs
```

起真实 HTTP 服务、用裸 `fetch` 打，覆盖鉴权、无副作用、幂等、入参校验、超大请求体、
并发重推。**不 mock 任何东西。**

两边契约是否真的对得上，由仓库里的端到端测试保证：

```bash
npx vitest run test/integration/ksk-hunter-downstream.test.ts
```

它起同一个 `server.mjs`，用抢号器真实的 `downstreamClient` 和 `KskHunterManager`
去打，验证「问要不要 → 下单 → 验活 → 推送 → 下游落库」整条链路。
单侧 mock 测试发现不了「文档写 `need`、实现读 `needed`」这类字段名走偏，这个能。

## 联调辅助接口

不属于契约，只为方便手动验证（同样要带 `x-api-key`）：

```bash
# 改需求水位：设成 0 可验证抢号器确实不下单
curl -X POST http://127.0.0.1:12889/admin/demand \
  -H 'x-api-key: your-secret' -H 'content-type: application/json' \
  -d '{"wanted":3}'

# 看已收到哪些号（key 已脱敏）
curl http://127.0.0.1:12889/admin/received -H 'x-api-key: your-secret'
```

## 拿去改成生产实现时

参考实现用进程内 `Map` 存已收到的号，**重启即丢**。换成数据库时注意：

- **`key` 上必须有唯一索引**。重试会推同一个 key，靠它保证幂等。
- **落库成功后才回 `ok: true`**。先回 ok 再异步写库，写失败就静默丢号了。
- **日志别记 `key` 明文**。参考实现只记 `ksk_xxx...yyyy`。
- **`/need-account` 要快且无副作用**。它每 3 秒可能被调一次，且问了不一定真收到号。

详见 `API.md` 末尾的实现清单。
