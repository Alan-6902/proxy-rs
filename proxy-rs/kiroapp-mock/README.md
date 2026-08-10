# KiroApp mock 上游

KiroApp（kiroapp.io）渠道的本地假上游，用来**不真花钱**把抢号全链路跑通。

```bash
node kiroapp-mock/server.mjs
```

首次运行会用 `openssl` 在 `.cert/` 下生成自签证书（已 gitignore）。

## 为什么要 HTTPS

`hunterRunner.ts` 的 `fetchJson` 硬约束商品站点必须 `https://`，明文地址直接拒绝、
不给 loopback 开例外。所以 mock 必须起 TLS，不能用 http。

## 接口

| 方法 | 路径                        | 说明 |
| ---- | --------------------------- | ---- |
| GET  | `/api/status`               | 商品状态。**形状照抄真实站点**，字段名一个都没改。不校验 token（真站点未登录也能 GET）。 |
| POST | `/api/order?token=xxx`      | 下单，扣库存并返回一个格式合法的假 `ksk_`。token 不对回 401，售罄回 409。 |
| POST | `/admin/stock`              | 联调辅助：改 `stock_eu` / `stock_us` / `price_eu` / `price_us`。 |
| GET  | `/admin/sold`               | 联调辅助：看已卖出的号（脱敏）。 |

### /api/status 的真实性

这个响应是 2026-08 实测抓的（`curl https://kiroapp.io/api/status`，未登录可访问）：

```json
{
  "auto_check": true, "auto_generate": false,
  "captcha_app_id": "199244242", "captcha_enabled": true, "generating": false,
  "price": 50, "price_eu": 30, "price_us": 50,
  "started_at": "2026-08-06T10:30:23Z",
  "stock": 0, "stock_eu": 0, "stock_us": 0, "uptime_seconds": 235806
}
```

注意它**不是商品列表形状**：没有商品数组，库存与价格按区域拆成平铺字段。
所以 `parseKiroAppOffers` 走的是「按区域合成 offer」而不是 `readOfferArray`。

### /api/order 是推测的 ⚠️

真实站点的下单契约**没拿到**：`/api-docs` 需要登录才渲染，JS chunk 里只有它自己
前端用的 cookie + CSRF 接口（`/api/auth/*`、`/api/status`），没有第三方下单路径。

这里的请求体 `{zone, count}` 与 `channelAdapters.ts` 里 `buildOrderRequestBody` 的
`KIRO_APP` 分支一致，两边都是同一个假设。拿到真实文档后：

- 只是键名不同 → 改 `buildOrderRequestBody` 与本 mock 两处即可；
- 若鉴权要走请求头而不是 URL query → 还得改 `hunterRunner.ts` 的 `fetchJson`，
  那超出渠道适配范围。

## 自测

```bash
node kiroapp-mock/selftest.mjs
```

32 项，覆盖字段完整性、token 校验、库存扣减、售罄、key 不重复、并发不超卖。

抢号器与它的对接验证在 `test/integration/ksk-hunter-kiroapp.test.ts`——那边用真实的
`KskHunterManager` 打这个同一个 server，不 mock fetch。

## 联调

两个服务一起起：

```bash
# 终端 1：假上游
node kiroapp-mock/server.mjs

# 终端 2：下游参考实现
cd downstream-example && DOWNSTREAM_API_KEY=test-key node server.mjs

# 终端 3：应用。自签证书要显式放行，否则主进程连不上
NODE_EXTRA_CA_CERTS=$(pwd)/kiroapp-mock/.cert/mock-cert.pem npm run dev
```

UI 里在「抢号监控」页加一条链接：

| 字段         | 填 |
| ------------ | -- |
| 渠道         | KiroApp |
| 商品列表地址 | `https://127.0.0.1:12890/api/status` |
| 下单地址     | `https://127.0.0.1:12890/api/order?token=mock-token` |
| 处置方式     | 先「仅提醒」跑通读取，再切「自动下单」 |

放货（触发一次抢号）：

```bash
curl -k -X POST https://127.0.0.1:12890/admin/stock \
  -H 'content-type: application/json' -d '{"stock_eu":1}'
```

`stock_eu` 从 0 改成 1 就是一次「放货边沿」，抢号报表里会记一条 `restock`。
