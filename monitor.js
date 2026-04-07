require("dotenv").config();
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const XRPSCAN_METRICS_URL =
  process.env.XRPSCAN_METRICS_URL ||
  "https://api.xrpscan.com/api/v1/metrics/metric";
const TELEGRAM_SERVICE_URL =
  process.env.TELEGRAM_SERVICE_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "";
const CHAT_ID = process.env.CHAT_ID || "";
const PAYMENTS_THRESHOLD = getNumberEnv("PAYMENTS_THRESHOLD", 2000000);
const CHECK_INTERVAL_MS = getNumberEnv("CHECK_INTERVAL_MS", 14400000);
const REPORT_INTERVAL_DAYS = getNumberEnv("REPORT_INTERVAL_DAYS", 3);
const REPORT_HOUR = getNumberEnv("REPORT_HOUR", 16);
const REPORT_MINUTE = getNumberEnv("REPORT_MINUTE", 38);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, ".monitor-state.json");
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const RUN_ONCE = process.argv.indexOf("--once") !== -1;

let lastAlertDate = null;
let lastReportDate = null;

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return;
  }

  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    lastAlertDate = state && state.lastAlertDate ? state.lastAlertDate : null;
    lastReportDate = state && state.lastReportDate ? state.lastReportDate : null;
  } catch (error) {
    console.error(
      "[" +
        new Date().toISOString() +
        "] Failed to load state file " +
        STATE_FILE +
        ": " +
        error.message
    );
  }
}

function saveState() {
  const state = {
    lastAlertDate: lastAlertDate,
    lastReportDate: lastReportDate,
  };

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function getNumberEnv(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

function getShanghaiNow() {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS);
}

function getLatestMetricEntry(allMetrics) {
  if (!Array.isArray(allMetrics) || allMetrics.length === 0) {
    return null;
  }

  return allMetrics[allMetrics.length - 1];
}

function getMetricValue(entry, key, fallback) {
  if (!entry || !entry.metric || entry.metric[key] == null) {
    return fallback;
  }

  return entry.metric[key];
}

async function fetchAllMetrics() {
  const response = await fetch(XRPSCAN_METRICS_URL);

  if (!response.ok) {
    throw new Error(
      "XRPScan API request failed: " +
        response.status +
        " " +
        response.statusText
    );
  }

  const data = await response.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("XRPScan API returned empty or invalid data");
  }

  return data;
}

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(2) + "M";
  }

  if (num >= 1000) {
    return (num / 1000).toFixed(2) + "K";
  }

  return String(num);
}

async function sendTelegram(message) {
  const response = await fetch(TELEGRAM_SERVICE_URL + "/send-message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({
      chatId: CHAT_ID,
      message: message,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error("Telegram service error: " + response.status + " - " + body);
  }

  return response.json();
}

async function sendThresholdAlert(date, paymentsCount) {
  const message =
    "XRP Payments Alert\n\n" +
    "Date: " +
    date +
    "\n" +
    "Payments Count: " +
    formatNumber(paymentsCount) +
    " (" +
    paymentsCount.toLocaleString() +
    ")\n" +
    "Threshold: " +
    formatNumber(PAYMENTS_THRESHOLD) +
    "\n\n" +
    "Source: https://xrpscan.com/metrics";

  return sendTelegram(message);
}

async function sendPeriodicReport(recentEntries) {
  const lines = recentEntries.map(function mapEntry(entry) {
    const date = entry && entry.date ? entry.date.slice(0, 10) : "unknown";
    const count = getMetricValue(entry, "payments_count", 0);
    const volume = getMetricValue(entry, "payments_volume", 0);
    const exceeded = count > PAYMENTS_THRESHOLD ? " EXCEEDED" : "";

    return (
      "  " +
      date +
      " | " +
      formatNumber(count) +
      " (" +
      count.toLocaleString() +
      ") | " +
      formatNumber(volume) +
      " XRP" +
      exceeded
    );
  });

  const separator = "-".repeat(52);
  const message =
    "XRP Payments Periodic Report\n\n" +
    "Recent " +
    recentEntries.length +
    " day(s)\n" +
    separator +
    "\n" +
    "  Date       | Payments Count | Volume\n" +
    separator +
    "\n" +
    lines.join("\n") +
    "\n" +
    separator +
    "\n" +
    "Threshold: " +
    formatNumber(PAYMENTS_THRESHOLD) +
    "\n" +
    "Generated At: " +
    getShanghaiNow().toISOString().slice(0, 19).replace("T", " ") +
    " (Shanghai)\n\n" +
    "Source: https://xrpscan.com/metrics";

  return sendTelegram(message);
}

function shouldSendReport() {
  const now = getShanghaiNow();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const today = now.toISOString().slice(0, 10);

  if (lastReportDate === today) {
    return false;
  }

  if (hour < REPORT_HOUR || (hour === REPORT_HOUR && minute < REPORT_MINUTE)) {
    return false;
  }

  if (lastReportDate === null) {
    return true;
  }

  const lastDate = new Date(lastReportDate + "T00:00:00Z");
  const todayDate = new Date(today + "T00:00:00Z");
  const daysDiff = Math.floor(
    (todayDate.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000)
  );

  return daysDiff >= REPORT_INTERVAL_DAYS;
}

function logRuntimeConfig() {
  console.log("=== XRP Payments Monitor ===");
  console.log("Threshold: " + PAYMENTS_THRESHOLD.toLocaleString());
  console.log(
    "Check interval: " +
      CHECK_INTERVAL_MS / 1000 +
      "s (" +
      CHECK_INTERVAL_MS / 3600000 +
      "h)"
  );
  console.log(
    "Periodic report: every " +
      REPORT_INTERVAL_DAYS +
      " days at " +
      String(REPORT_HOUR).padStart(2, "0") +
      ":" +
      String(REPORT_MINUTE).padStart(2, "0") +
      " Shanghai time"
  );
  console.log("Telegram service: " + TELEGRAM_SERVICE_URL);
  console.log("Chat ID configured: " + (CHAT_ID ? "yes" : "no"));
  console.log("API key configured: " + (API_KEY ? "yes" : "no"));
  console.log("State file: " + STATE_FILE);
  console.log("Run mode: " + (RUN_ONCE ? "single check" : "continuous"));
  console.log("");
}

async function check() {
  const timestamp = new Date().toISOString();
  console.log("[" + timestamp + "] Checking XRP Ledger payments_count...");

  try {
    const allMetrics = await fetchAllMetrics();
    const latest = getLatestMetricEntry(allMetrics);

    if (!latest) {
      console.log("[" + timestamp + "] No metrics received");
      return;
    }

    const date = latest.date ? latest.date.slice(0, 10) : "unknown";
    const paymentsCount = getMetricValue(latest, "payments_count", null);

    if (paymentsCount === null) {
      console.log("[" + timestamp + "] payments_count not found in latest metric");
      return;
    }

    console.log(
      "[" +
        timestamp +
        "] Date: " +
        date +
        " | payments_count: " +
        paymentsCount.toLocaleString() +
        " | Threshold: " +
        PAYMENTS_THRESHOLD.toLocaleString()
    );

    if (paymentsCount > PAYMENTS_THRESHOLD) {
      if (lastAlertDate === date) {
        console.log("[" + timestamp + "] Already alerted for " + date);
      } else {
        console.log("[" + timestamp + "] Threshold exceeded, sending alert...");
        await sendThresholdAlert(date, paymentsCount);
        lastAlertDate = date;
        saveState();
        console.log("[" + timestamp + "] Threshold alert sent");
      }
    } else {
      console.log("[" + timestamp + "] Below threshold");
    }

    if (shouldSendReport()) {
      const recentEntries = allMetrics.slice(-REPORT_INTERVAL_DAYS);
      console.log(
        "[" +
          timestamp +
          "] Sending periodic report for last " +
          REPORT_INTERVAL_DAYS +
          " day(s)..."
      );
      await sendPeriodicReport(recentEntries);
      lastReportDate = getShanghaiNow().toISOString().slice(0, 10);
      saveState();
      console.log("[" + timestamp + "] Periodic report sent");
    }
  } catch (error) {
    console.error("[" + timestamp + "] Error: " + error.message);
  }
}

async function main() {
  loadState();
  logRuntimeConfig();
  await check();

  if (!RUN_ONCE) {
    setInterval(function runScheduledCheck() {
      check().catch(function handleCheckError(error) {
        console.error(
          "[" +
            new Date().toISOString() +
            "] Unexpected interval error: " +
            error.message
        );
      });
    }, CHECK_INTERVAL_MS);
  }
}

process.on("unhandledRejection", function onUnhandledRejection(error) {
  console.error(
    "[" +
      new Date().toISOString() +
      "] Unhandled rejection: " +
      (error && error.stack ? error.stack : error)
  );
});

process.on("uncaughtException", function onUncaughtException(error) {
  console.error(
    "[" +
      new Date().toISOString() +
      "] Uncaught exception: " +
      (error && error.stack ? error.stack : error)
  );
  process.exit(1);
});

main().catch(function handleMainError(error) {
  console.error(
    "[" +
      new Date().toISOString() +
      "] Fatal startup error: " +
      (error && error.stack ? error.stack : error)
  );
  process.exit(1);
});
