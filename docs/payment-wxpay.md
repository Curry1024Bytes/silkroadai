# 微信支付直连接入指南

## 概述

本项目通过直接对接 **微信支付 APIv3** 实现收款。使用 **公钥模式** 验签（非平台证书模式），支持以下产品：

| 产品        | API                           | 场景                                   |
| ----------- | ----------------------------- | -------------------------------------- |
| Native 支付 | `/v3/pay/transactions/native` | PC 扫码支付（生成 `weixin://` 二维码） |
| H5 支付     | `/v3/pay/transactions/h5`     | 移动端浏览器拉起微信                   |

> H5 支付需要在微信支付商户后台单独签约开通。如果未开通，移动端会自动降级到 Native 扫码。

## 前置条件

1. 注册 [微信支付商户平台](https://pay.weixin.qq.com/)，获取 **商户号 (mchid)**
2. 在 [微信开放平台](https://open.weixin.qq.com/) 创建应用，获取 **APPID**
3. 在商户后台 → API 安全 → 配置以下内容：
    - **APIv3 密钥**（32 字节随机字符串）
    - **商户 API 私钥**（RSA 2048，下载 PEM 文件）
    - **微信支付公钥**（用于验签通知，注意区别于平台证书）
    - **微信支付公钥 ID**（与公钥配套的 serial/key ID）
    - **商户证书序列号**（用于签名请求的 Authorization header）

## 密钥说明

微信支付 APIv3 公钥模式涉及 **多组密钥**：

| 密钥                | 来源              | 用途                      | 对应环境变量          |
| ------------------- | ----------------- | ------------------------- | --------------------- |
| **商户 API 私钥**   | 商户后台生成/下载 | 对 API 请求签名           | `WXPAY_PRIVATE_KEY`   |
| **微信支付公钥**    | 商户后台获取      | 验证异步通知签名          | `WXPAY_PUBLIC_KEY`    |
| **微信支付公钥 ID** | 与公钥配套        | 匹配通知中的 serial       | `WXPAY_PUBLIC_KEY_ID` |
| **商户证书序列号**  | 商户后台查看      | 放入 Authorization header | `WXPAY_CERT_SERIAL`   |
| **APIv3 密钥**      | 商户后台设置      | AES-GCM 解密通知内容      | `WXPAY_API_V3_KEY`    |

> **公钥模式 vs 平台证书模式**：本项目使用公钥模式，直接用微信支付公钥验签，不需要定期拉取/更新平台证书，部署更简单。

## 环境变量

```env
# ── 必需 ──
WXPAY_APP_ID=wx1234567890abcdef          # 微信开放平台 APPID
WXPAY_MCH_ID=1234567890                   # 微信支付商户号
WXPAY_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...  # 商户 API 私钥 (RSA PEM)
WXPAY_API_V3_KEY=your32bytesrandomstring  # APIv3 密钥 (32字节)
WXPAY_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\n...     # 微信支付公钥 (PEM)
WXPAY_PUBLIC_KEY_ID=PUB_KEY_ID_xxxxxx     # 微信支付公钥 ID
WXPAY_CERT_SERIAL=SERIAL_NUMBER_xxxxxx    # 商户证书序列号
WXPAY_NOTIFY_URL=https://pay.example.com/api/wxpay/notify  # 异步通知地址

# ── 启用渠道 ──
PAYMENT_PROVIDERS=wxpay         # 逗号分隔，可同时含 easypay,alipay,wxpay,stripe
ENABLED_PAYMENT_TYPES=wxpay     # 前端展示哪些支付方式
```

### 私钥格式

`WXPAY_PRIVATE_KEY` 需要完整的 PEM 格式。在 Docker Compose 中推荐使用 `|-` 多行写法：

```yaml
# docker-compose.yml
services:
    app:
        environment:
            WXPAY_PRIVATE_KEY: |-
                -----BEGIN PRIVATE KEY-----
                MIIEvQIBADANBgkqhkiG9w0BAQEFAASC...
                ...
                -----END PRIVATE KEY-----
```

或者在 `.env` 中用 `\n` 表示换行：

```env
WXPAY_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEvQI...\n-----END PRIVATE KEY-----
```

`WXPAY_PUBLIC_KEY` 同理，支持裸 Base64 或完整 PEM（裸 Base64 会自动补全 header/footer）。

## 架构

```
用户浏览器
    │
    ├── PC：前端显示 code_url 二维码 → 用户微信扫码 → 完成付款
    │        ↓
    │    POST /v3/pay/transactions/native → 返回 code_url (weixin://wxpay/...)
    │
    └── Mobile：跳转 h5_url → 拉起微信客户端付款
             ↓
         POST /v3/pay/transactions/h5 → 返回 h5_url
         (如果 H5 未签约，自动 fallback 到 Native)

微信支付服务器
    │
    └── POST /api/wxpay/notify  ← 异步通知（event_type=TRANSACTION.SUCCESS）
         │
         ├── 验签（RSA-SHA256 + 微信支付公钥）
         ├── 校验 serial 匹配 WXPAY_PUBLIC_KEY_ID
         ├── 校验 timestamp 不超过 5 分钟
         ├── AES-256-GCM 解密 resource（使用 APIv3 密钥）
         └── 调用 handlePaymentNotify() → 订单状态流转 → 充值/订阅履约
```

### 签名机制

**请求签名** (Authorization header)：

```
签名串 = HTTP方法\n请求URL\n时间戳\n随机串\n请求体\n
签名 = RSA-SHA256(签名串, 商户私钥)
Authorization: WECHATPAY2-SHA256-RSA2048 mchid="...",serial_no="...",nonce_str="...",timestamp="...",signature="..."
```

**通知验签**：

```
验签串 = 时间戳\n随机串\nJSON body\n
验证 = RSA-SHA256.verify(验签串, 微信支付公钥, Wechatpay-Signature header)
```

**通知解密**：

```
明文 = AES-256-GCM.decrypt(
    ciphertext,
    key = APIv3密钥,
    nonce = resource.nonce,
    aad = resource.associated_data
)
```

## 文件结构

```
src/lib/wxpay/
├── provider.ts   # WxpayProvider 实现 PaymentProvider 接口
├── client.ts     # Native/H5 下单、查询、关闭、退款、解密通知、验签
├── types.ts      # TypeScript 类型定义
└── index.ts      # 导出入口

src/app/api/wxpay/
└── notify/route.ts   # 异步通知接收端点
```

## 支持的 API 能力

| 能力        | API                                          | 说明                           |
| ----------- | -------------------------------------------- | ------------------------------ |
| Native 下单 | `POST /v3/pay/transactions/native`           | 返回 `code_url` 用于生成二维码 |
| H5 下单     | `POST /v3/pay/transactions/h5`               | 返回 `h5_url` 拉起微信         |
| 查询订单    | `GET /v3/pay/transactions/out-trade-no/{id}` | 主动查询交易状态               |
| 关闭订单    | `POST /v3/pay/.../close`                     | 超时关单                       |
| 退款        | `POST /v3/refund/domestic/refunds`           | 原路退款                       |
| 异步通知    | POST 回调                                    | RSA-SHA256 验签 + AES-GCM 解密 |

## 与 wechatpay-node-v3 的关系

项目使用 [`wechatpay-node-v3`](https://www.npmjs.com/package/wechatpay-node-v3) 库来生成请求签名 (`getSignature`) 和构建 Authorization header (`getAuthorization`)。实际的 HTTP 请求和通知验签/解密逻辑由项目自己实现（使用原生 `fetch` 和 Node.js `crypto`）。

## 注意事项

- **H5 支付降级**：如果 H5 支付返回 `NO_AUTH` 错误（未签约），自动 fallback 到 Native 扫码模式。
- **金额单位**：微信 API 使用 **分** 为单位，项目内部使用 **元**。`client.ts` 中 `yuanToFen()` 自动转换。
- **通知时效**：通知中的 `timestamp` 与服务器时间差超过 5 分钟将被拒绝。
- **默认限额**：单笔 ¥1000，单日 ¥10000（可通过环境变量 `MAX_DAILY_AMOUNT_WXPAY_DIRECT` 调整）。
- **WxPay 实例缓存**：`getPayInstance()` 使用模块级单例，避免重复解析密钥。
- **通知响应格式**：微信要求成功返回 `{"code":"SUCCESS","message":"成功"}`，失败返回 `{"code":"FAIL","message":"处理失败"}`。

## 常见问题

### Q: 通知验签失败

检查以下几点：

1. `WXPAY_PUBLIC_KEY` 是否是 **微信支付公钥**（不是商户公钥或平台证书）
2. `WXPAY_PUBLIC_KEY_ID` 是否与通知 header 中的 `Wechatpay-Serial` 匹配
3. 服务器时间是否准确（NTP 同步）

### Q: H5 支付报 NO_AUTH

需要在微信支付商户后台 → 产品中心 → H5 支付 → 申请开通，并配置 H5 支付域名。未开通前项目会自动降级为 Native 扫码。

### Q: 如何获取微信支付公钥？

微信支付商户后台 → API 安全 → 微信支付公钥。注意这是 2024 年后推出的公钥模式，区别于之前的平台证书模式。如果你的商户号不支持公钥模式，需要联系微信支付升级。
