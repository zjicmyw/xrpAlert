require("dotenv").config();
const fetch = require("node-fetch");

const XRPSCAN_METRICS_URL =
  process.env.XRPSCAN_METRICS_URL ||
  "https://api.xrpscan.com/api/v1/metrics/metric";
const TELEGRAM_SERVICE_URL =
  process.env.TELEGRAM_SERVICE_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY;
const CHAT_ID = process.env.CHAT_ID;
const PAYMENTS_THRESHOLD = Number(process.env.PAYMENTS_THRESHOLD) || 2_000_000;
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS) || 14_400_000;
const REPORT_INTERVAL_DAYS = Number(process.env.REPORT_INTERVAL_DAYS) || 3;
const REPORT_HOUR = Number(process.env.REPORT_HOUR) ?? 16;
const REPORT_MINUTE = Number(process.env.REPORT_MINUTE) ?? 38;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const RUN_ONCE = process.argv.includes("--once");

let lastAlertDate = null;
let lastReportDate = null;

function getShanghaiNow() {
  const utc = new Date();
  return new Date(utc.getTime() + SHANGHAI_OFFSET_MS);
}

function getShanghaiDateString(date) {
  const d = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

async function fetchAllMetrics() {
  const response = await fetch(XRPSCAN_METRICS_URL);
  if (!response.ok) {
    throw new Error(
      `XRPScan API request failed: ${response.status} ${response.statusText}`
    );
  }
  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("XRPScan API returned empty or invalid data");
  }
  return data;
}

function formatNumber(num) {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return String(num);
}

async function sendTelegram(text) {
  const response = await fetch(`${TELEGRAM_SERVICE_URL}/send-message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({ chatId: CHAT_ID, message: text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram service error: ${response.status} - ${body}`);
  }

  return response.json();
}

async function sendThresholdAlert(date, paymentsCount) {
  const message =
    `🚨 XRP Payments Alert\n\n` +
    `📅 Date: ${date}\n` +
    `💰 Payments Count: ${formatNumber(paymentsCount)} (${paymentsCount.toLocaleString()})\n` +
    `⚠️ Threshold: ${formatNumber(PAYMENTS_THRESHOLD)}\n\n` +
    `Source: https://xrpscan.com/metrics`;

  return sendTelegram(message);
}

async function sendPeriodicReport(recentEntries) {
  const lines = recentEntries.map((entry) => {
    const date = entry.date?.slice(0, 10) || "unknown";
    const count = entry.metric?.payments_count ?? 0;
    const volume = entry.metric?.payments_volume ?? 0;
    const exceeded = count > PAYMENTS_THRESHOLD ? " ⚠️" : " ✅";
    return (
      `  ${date}  |  ${formatNumber(count)} (${count.toLocaleString()})  |  ` +
      `${formatNumber(volume)} XRP${exceeded}`
    );
  });

  const message =
    `📊 XRP Payments 定期报告\n\n` +
    `最近 ${recentEntries.length} 天数据：\n` +
    `${"—".repeat(20)}\n` +
    `  日期        |  Payments Count  |  Volume\n` +
    `${"—".repeat(20)}\n` +
    lines.join("\n") +
    `\n${"—".repeat(20)}\n` +
    `⚠️ 门槛: ${formatNumber(PAYMENTS_THRESHOLD)}\n` +
    `🕐 上海时间: ${getShanghaiNow().toISOString().slice(0, 19).replace("T", " ")}\n\n` +
    `Source: https://xrpscan.com/metrics`;

  return sendTelegram(message);
}

function shouldSendReport() {
  const now = getShanghaiNow();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const todayStr = now.toISOString().slice(0, 10);

  if (lastReportDate === todayStr) return false;
  if (hour < REPORT_HOUR || (hour === REPORT_HOUR && minute < REPORT_MINUTE)) {
    return false;
  }

  if (lastReportDate === null) return true;

  const lastDate = new Date(lastReportDate + "T00:00:00Z");
  const today = new Date(todayStr + "T00:00:00Z");
  const daysDiff = Math.floor(
    (today.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000)
  );
  return daysDiff >= REPORT_INTERVAL_DAYS;
}

async function check() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Checking XRP Ledger payments_count...`);

  try {
    const allMetrics = await fetchAllMetrics();
    const latest = allMetrics[allMetrics.length - 1];
    const date = latest.date?.slice(0, 10) || "unknown";
    const paymentsCount = latest.metric?.payments_count;

    if (paymentsCount == null) {
      console.log(`[${timestamp}] payments_count not found in latest metric`);
      return;
    }

    console.log(
      `[${timestamp}] Date: ${date} | payments_count: ${paymentsCount.toLocaleString()} | Threshold: ${PAYMENTS_THRESHOLD.toLocaleString()}`
    );

    if (paymentsCount > PAYMENTS_THRESHOLD) {
      if (lastAlertDate === date) {
        console.log(
          `[${timestamp}] Already alerted for ${date}, skipping duplicate`
        );
      } else {
        console.log(
          `[${timestamp}] ⚠️ THRESHOLD EXCEEDED! Sending Telegram alert...`
        );
        await sendThresholdAlert(date, paymentsCount);
        lastAlertDate = date;
        console.log(`[${timestamp}] ✅ Threshold alert sent`);
      }
    } else {
      console.log(`[${timestamp}] Below threshold`);
    }

    if (shouldSendReport()) {
      const recentDays = REPORT_INTERVAL_DAYS;
      const recentEntries = allMetrics.slice(-recentDays);
      console.log(
        `[${timestamp}] 📊 Sending periodic report (last ${recentDays} days)...`
      );
      await sendPeriodicReport(recentEntries);
      lastReportDate = getShanghaiNow().toISOString().slice(0, 10);
      console.log(`[${timestamp}] ✅ Periodic report sent`);
    }
  } catch (error) {
    console.error(`[${timestamp}] Error: ${error.message}`);
  }
}

async function main() {
  console.log("=== XRP Payments Monitor ===");
  console.log(`Threshold: ${PAYMENTS_THRESHOLD.toLocaleString()}`);
  console.log(
    `Check interval: ${CHECK_INTERVAL_MS / 1000}s (${CHECK_INTERVAL_MS / 3_600_000}h)`
  );
  console.log(
    `Periodic report: every ${REPORT_INTERVAL_DAYS} days at ${String(REPORT_HOUR).padStart(2, "0")}:${String(REPORT_MINUTE).padStart(2, "0")} Shanghai time`
  );
  console.log(`Telegram service: ${TELEGRAM_SERVICE_URL}`);
  console.log(`Run mode: ${RUN_ONCE ? "single check" : "continuous"}\n`);

  await check();

  if (!RUN_ONCE) {
    setInterval(check, CHECK_INTERVAL_MS);
  }
}

main();
