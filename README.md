# XRP Payments Monitor

监控 XRP Ledger 的 `payments_count` 指标，当超过阈值时通过本地 Telegram 服务立即提醒，同时每 3 天定时汇报近期数据。

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
| `CHAT_ID` | Telegram Chat ID | - |
| `PAYMENTS_THRESHOLD` | 触发即时报警的阈值 | `2000000` |
| `CHECK_INTERVAL_MS` | 检查间隔（毫秒） | `14400000`（4 小时） |
| `REPORT_INTERVAL_DAYS` | 定期报告间隔（天） | `3` |
| `REPORT_HOUR` | 报告触发时间 - 小时（上海时间） | `16` |
| `REPORT_MINUTE` | 报告触发时间 - 分钟（上海时间） | `38` |

## 通知类型

1. **即时告警** — `payments_count` 超过阈值时立即发送，同一日期只告警一次
2. **定期报告** — 每 3 天在上海时间 16:38 发送最近 3 天的 payments_count 汇总

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
