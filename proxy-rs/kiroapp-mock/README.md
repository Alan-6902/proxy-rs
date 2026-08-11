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

| 方法 | 路径               | 说明                                                                                 |
| ---- | ------------------ | ------------------------------------------------------------------------------------ |
| GET  | `/api/me/stock`    | 商品状态。按官方文档返回库存、价格与余额；必须带 `X-API-Key`。                       |
| POST | `/api/me/purchase` | 下单并返回格式合法的假 `ksk_`；必须带 `X-API-Key`，支持 `client_order_id` 幂等重放。 |
| POST | `/admin/stock`     | 联调辅助：改 `stock_eu` / `stock_us` / `price_eu` / `price_us`。                     |
| GET  | `/admin/sold`      | 联调辅助：看已卖出的号（脱敏）。                                                     |

### `/api/me/stock` 的契约

登录后的官方 `/api-docs` 给出的核心响应为：

```json
{
  "stock": 0,
  "price": 30,
  "price_min": 30,
  "price_max": 50,
  "balance": 1000,
  "stock_eu": 0,
  "stock_us": 0
}
```

注意它**不是商品列表形状**：没有商品数组，库存与价格按区域拆成平铺字段。
所以 `parseKiroAppOffers` 走的是「按区域合成 offer」而不是 `readOfferArray`。
mock 额外保留 `price_eu` / `price_us`，用于覆盖区域价格解析；真实接口只给 `price` 时
解析器会自动回退到这个统一价格。

### `/api/me/purchase` 的契约

请求体为 `{count, region, client_order_id}`；`client_order_id` 必须是 32 位小写 hex。
同一幂等键和相同参数重放时返回原订单、`replayed: true`，不重复扣库存；同一幂等键
配不同参数返回 409。成功响应包含 `purchased`、`requested`、`remaining`、
`unit_price`、`total_debit`、`order_id` 与 `keys[]`。

官方令牌以 `km_` 开头，可用 `Authorization: Bearer` 或 `X-API-Key`；抢号器复用现有
渠道鉴权能力，统一发送 `X-API-Key`。

## 自测

```bash
node kiroapp-mock/selftest.mjs
```

覆盖字段完整性、API Key 校验、库存扣减、幂等重放、售罄、key 不重复与并发不超卖。

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

| 字段         | 填                                        |
| ------------ | ----------------------------------------- |
| 渠道         | KiroApp                                   |
| API Key      | `km_mock_token`                           |
| 商品列表地址 | `https://127.0.0.1:12890/api/me/stock`    |
| 下单地址     | `https://127.0.0.1:12890/api/me/purchase` |
| 处置方式     | 先「仅提醒」跑通读取，再切「自动下单」    |

放货（触发一次抢号）：

```bash
curl -k -X POST https://127.0.0.1:12890/admin/stock \
  -H 'content-type: application/json' -d '{"stock_eu":1}'
```

`stock_eu` 从 0 改成 1 就是一次「放货边沿」，抢号报表里会记一条 `restock`。
