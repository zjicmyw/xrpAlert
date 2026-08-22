# XRP Payments Monitor

监控 XRP Ledger 的 `payments_count` 指标，当超过阈值时通过本地 Telegram 服务立即提醒，同时每 3 天定时汇报近期数据。
同时监控 Aspecta Trade 页面里指定的白名单资产，24h Change 超过阈值时发送异常提醒。

数据来源：https://xrpscan.com/metrics

## 快速开始

```bash
npm install
npm run pm2
```

或直接运行（无 PM2）：`npm start`

## 配置

在 `.env` 文件中配置：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `XRPSCAN_METRICS_URL` | XRPScan 指标 API | `https://api.xrpscan.com/api/v1/metrics/metric` |
| `TELEGRAM_SERVICE_URL` | 本地 Telegram 服务地址 | `http://localhost:3000` |
| `API_KEY` | Telegram 服务 API 密钥 | - |
| `TELEGRAM_ALERT_CHAT_ID` | 异常提醒 Telegram Chat ID | - |
| `TELEGRAM_DAILY_CHAT_ID` | 日报总结 Telegram Chat ID | - |
| `CHAT_ID` | 兼容旧配置：当上面两个变量未设置时作为回退 Chat ID | - |
| `PAYMENTS_THRESHOLD` | 触发即时报警的阈值 | `2000000` |
| `CHECK_INTERVAL_MS` | 检查间隔（毫秒） | `14400000`（4 小时） |
| `REPORT_INTERVAL_DAYS` | 定期报告间隔（天） | `3` |
| `REPORT_HOUR` | 报告触发时间 - 小时（上海时间） | `16` |
| `REPORT_MINUTE` | 报告触发时间 - 分钟（上海时间） | `38` |
| `ASPECTA_ENABLED` | 是否启用 Aspecta Top Gainer / Top Loser 监控 | `true` |
| `ASPECTA_API_URL` | Aspecta 页面使用的数据接口 | `https://aspecta.ai/api/hermes/trading/arena-popular-assets` |
| `ASPECTA_KLINE_URL` | Aspecta K-line 接口，用于获取 24h 前和当前价格 | `https://aspecta.ai/api/hermes/trading/k-line` |
| `ASPECTA_TRADING_CONFIG_ID` | Aspecta trading config id | `1` |
| `ASPECTA_ORDER_BY` | Aspecta 接口排序参数 | `-popularity` |
| `ASPECTA_URL_NAME` | Aspecta arena 名称参数 | `TradingAttention` |
| `ASPECTA_MONITORED_ASSETS` | Aspecta 监控白名单，逗号分隔；大小写不敏感 | `Ostium,DAPPOS` |
| `ASPECTA_CHECK_INTERVAL_MS` | Aspecta 检查间隔（毫秒） | `300000`（5 分钟） |
| `ASPECTA_CHANGE_THRESHOLD_PERCENT` | Aspecta 首次触发阈值（百分比） | `10` |
| `ASPECTA_REPEAT_PRICE_DELTA_PERCENT` | 同一标的再次提醒所需的最小当前价格变化，按初始价格计算；`5` 表示至少变化 `初始价格 * 5%` | `5` |
| `ASPECTA_REPEAT_ALERT_WINDOW_HOURS` | 重复提醒计数窗口 | `24` |
| `ASPECTA_REPEAT_PRICE_DELTA_PERCENT_AFTER_10_ALERTS` | 24 小时内已有 10 次提醒后，再次提醒所需的初始价格变化比例 | `10` |
| `ASPECTA_REPEAT_PRICE_DELTA_PERCENT_AFTER_20_ALERTS` | 24 小时内已有 20 次提醒后，再次提醒所需的初始价格变化比例 | `20` |
| `ASPECTA_PRICE_DECIMALS` | Aspecta K-line 价格小数位 | `18` |

## 通知类型

1. **即时告警** — `payments_count` 超过阈值时立即发送到 `TELEGRAM_ALERT_CHAT_ID`，同一日期只告警一次
2. **定期报告** — 每 3 天在上海时间 16:38 发送最近 3 天的 payments_count 汇总到 `TELEGRAM_DAILY_CHAT_ID`
3. **Aspecta 异常提醒** — 每 5 分钟只检查 `ASPECTA_MONITORED_ASSETS` 白名单资产；24h Change 首次超过 ±10% 时发送到 `TELEGRAM_ALERT_CHAT_ID`。同一标的后续只有当当前价格距离上次记录价格至少再变化 `初始价格 * 5%` 时才再次提醒；最近 24 小时已有 10 次提醒后提升到 `初始价格 * 10%`，已有 20 次提醒后提升到 `初始价格 * 20%`。
   提醒内容使用短模板：`Aspecta : 标的`，下一行显示 `24h 前价格 -> 上次提醒价 -> 当前价格（24h Change）`。

## 运行模式

- `npm run pm2` — 使用 PM2 启动并常驻（推荐）
- `npm start` — 前台运行，每 4 小时检查一次
- `npm run dev` — 单次检查后退出

### PM2 常用命令

```bash
pm2 list              # 查看进程
pm2 logs xrp-alert    # 查看日志
pm2 stop xrp-alert    # 停止
pm2 restart xrp-alert # 重启
pm2 delete xrp-alert  # 移除
pm2 save              # 保存当前进程列表（开机自启需配合 pm2 startup）
```

## Telegram 接口

脚本会向 `{TELEGRAM_SERVICE_URL}/send-message` 发送 POST 请求：

```
POST /send-message
Header: x-api-key: {API_KEY}
Body: { "chatId": "...", "message": "..." }
```
