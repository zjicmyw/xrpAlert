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
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || CHAT_ID;
const TELEGRAM_DAILY_CHAT_ID = process.env.TELEGRAM_DAILY_CHAT_ID || CHAT_ID;
const PAYMENTS_THRESHOLD = getNumberEnv("PAYMENTS_THRESHOLD", 2000000);
const CHECK_INTERVAL_MS = getNumberEnv("CHECK_INTERVAL_MS", 14400000);
const REPORT_INTERVAL_DAYS = getNumberEnv("REPORT_INTERVAL_DAYS", 3);
const REPORT_HOUR = getNumberEnv("REPORT_HOUR", 16);
const REPORT_MINUTE = getNumberEnv("REPORT_MINUTE", 38);
const ASPECTA_ENABLED = getBooleanEnv("ASPECTA_ENABLED", true);
const ASPECTA_API_URL =
  process.env.ASPECTA_API_URL ||
  "https://aspecta.ai/api/hermes/trading/arena-popular-assets";
const ASPECTA_KLINE_URL =
  process.env.ASPECTA_KLINE_URL ||
  "https://aspecta.ai/api/hermes/trading/k-line";
const ASPECTA_TRADING_CONFIG_ID = process.env.ASPECTA_TRADING_CONFIG_ID || "1";
const ASPECTA_ORDER_BY = process.env.ASPECTA_ORDER_BY || "-popularity";
const ASPECTA_URL_NAME = process.env.ASPECTA_URL_NAME || "TradingAttention";
const ASPECTA_MONITORED_ASSETS =
  process.env.ASPECTA_MONITORED_ASSETS || "Ostium,DAPPOS";
const ASPECTA_MONITORED_ASSET_NAMES = parseAspectaMonitoredAssets(
  ASPECTA_MONITORED_ASSETS
);
const ASPECTA_MONITORED_ASSET_SET = new Set(ASPECTA_MONITORED_ASSET_NAMES);
const ASPECTA_CHECK_INTERVAL_MS = getNumberEnv(
  "ASPECTA_CHECK_INTERVAL_MS",
  300000
);
const ASPECTA_CHANGE_THRESHOLD_PERCENT = getNumberEnv(
  "ASPECTA_CHANGE_THRESHOLD_PERCENT",
  10
);
const ASPECTA_REPEAT_PRICE_DELTA_PERCENT = getNumberEnv(
  "ASPECTA_REPEAT_PRICE_DELTA_PERCENT",
  5
);
const ASPECTA_REPEAT_ALERT_WINDOW_HOURS = getNumberEnv(
  "ASPECTA_REPEAT_ALERT_WINDOW_HOURS",
  24
);
const ASPECTA_REPEAT_PRICE_DELTA_PERCENT_AFTER_10_ALERTS = getNumberEnv(
  "ASPECTA_REPEAT_PRICE_DELTA_PERCENT_AFTER_10_ALERTS",
  10
);
const ASPECTA_REPEAT_PRICE_DELTA_PERCENT_AFTER_20_ALERTS = getNumberEnv(
  "ASPECTA_REPEAT_PRICE_DELTA_PERCENT_AFTER_20_ALERTS",
  20
);
const ASPECTA_PRICE_DECIMALS = getNumberEnv("ASPECTA_PRICE_DECIMALS", 18);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, ".monitor-state.json");
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const ASPECTA_REPEAT_ALERT_WINDOW_MS =
  Math.max(1, ASPECTA_REPEAT_ALERT_WINDOW_HOURS) * 60 * 60 * 1000;
const RUN_ONCE = process.argv.indexOf("--once") !== -1;

let lastAlertDate = null;
let lastReportDate = null;
let aspectaAlerts = {};

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return;
  }

  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    lastAlertDate = state && state.lastAlertDate ? state.lastAlertDate : null;
    lastReportDate = state && state.lastReportDate ? state.lastReportDate : null;
    aspectaAlerts =
      state && state.aspectaAlerts && typeof state.aspectaAlerts === "object"
        ? state.aspectaAlerts
        : {};
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
    aspectaAlerts: aspectaAlerts,
  };

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function getNumberEnv(name, defaultValue) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : defaultValue;
}

function getBooleanEnv(name, defaultValue) {
  const value = process.env[name];

  if (value == null || value === "") {
    return defaultValue;
  }

  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function normalizeAspectaMonitorName(value) {
  if (value == null) {
    return "";
  }

  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseAspectaMonitoredAssets(value) {
  return String(value || "")
    .split(",")
    .map(normalizeAspectaMonitorName)
    .filter(Boolean);
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

function formatPercent(value) {
  const prefix = value > 0 ? "+" : "";
  return prefix + value.toFixed(2) + "%";
}

function formatAspectaRawPrice(value, tokenSymbol) {
  if (value == null || value === "") {
    return "unknown";
  }

  let raw;
  try {
    raw = BigInt(String(value));
  } catch (error) {
    return String(value);
  }

  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const base = 10n ** BigInt(ASPECTA_PRICE_DECIMALS);
  const whole = absolute / base;
  const fraction = absolute % base;
  let fractionText = fraction
    .toString()
    .padStart(ASPECTA_PRICE_DECIMALS, "0")
    .slice(0, 6)
    .replace(/0+$/, "");

  if (fraction > 0n && fractionText === "") {
    fractionText = "000001";
  }

  const amount =
    (negative ? "-" : "") +
    whole.toString() +
    (fractionText ? "." + fractionText : "");
  return tokenSymbol ? amount + " " + tokenSymbol : amount;
}

function parseAspectaRawPrice(value) {
  if (value == null || value === "") {
    return null;
  }

  try {
    const raw = BigInt(String(value));
    const negative = raw < 0n;
    const absolute = negative ? -raw : raw;
    const base = 10n ** BigInt(ASPECTA_PRICE_DECIMALS);
    const whole = absolute / base;
    const fraction = absolute % base;
    const parsed = Number(whole) + Number(fraction) / Number(base);
    return negative ? -parsed : parsed;
  } catch (error) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}

function formatAspectaPriceNumber(value) {
  if (!Number.isFinite(value)) {
    return "unknown";
  }

  return value.toFixed(6).replace(/\.?0+$/, "");
}

function formatAspectaPriceAmount(value, tokenSymbol) {
  const amount = formatAspectaPriceNumber(value);
  return tokenSymbol && amount !== "unknown"
    ? amount + " " + tokenSymbol
    : amount;
}

function formatAspectaPriceDelta(value, tokenSymbol) {
  if (!Number.isFinite(value)) {
    return "unknown";
  }

  const prefix = value > 0 ? "+" : "";
  const amount = prefix + formatAspectaPriceNumber(value);
  return tokenSymbol ? amount + " " + tokenSymbol : amount;
}

function formatAspectaTemplatePrice(value) {
  if (!Number.isFinite(value)) {
    return "$unknown";
  }

  const truncated = Math.trunc(value * 1000) / 1000;
  return "$" + truncated.toFixed(3);
}

async function sendTelegram(message, chatId) {
  const response = await fetch(TELEGRAM_SERVICE_URL + "/send-message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({
      chatId: chatId,
      message: message,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error("Telegram service error: " + response.status + " - " + body);
  }

  return response.json();
}

function buildAspectaRequestUrl() {
  const url = new URL(ASPECTA_API_URL);
  url.searchParams.set("trading_config_id", ASPECTA_TRADING_CONFIG_ID);
  url.searchParams.set("order_by", ASPECTA_ORDER_BY);
  url.searchParams.set("url_name", ASPECTA_URL_NAME);
  return url.toString();
}

function buildAspectaKlineRequestUrl(mover) {
  const url = new URL(ASPECTA_KLINE_URL);
  url.searchParams.set("project_address", mover.walletAddress);
  url.searchParams.set("offset", "24");
  url.searchParams.set("window_type", "1h");
  return url.toString();
}

async function fetchAspectaPopularAssets() {
  const response = await fetch(buildAspectaRequestUrl(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "xrp-alert-monitor/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      "Aspecta API request failed: " +
        response.status +
        " " +
        response.statusText
    );
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error("Aspecta API returned invalid data");
  }

  return data;
}

async function fetchAspectaPriceSnapshot(mover) {
  if (!mover.walletAddress) {
    return null;
  }

  const response = await fetch(buildAspectaKlineRequestUrl(mover), {
    headers: {
      Accept: "application/json",
      "User-Agent": "xrp-alert-monitor/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      "Aspecta K-line request failed: " +
        response.status +
        " " +
        response.statusText
    );
  }

  const data = await response.json();
  const firstResult = Array.isArray(data) ? data[0] : data;
  const kline = firstResult && Array.isArray(firstResult.k_line)
    ? firstResult.k_line
    : [];

  if (kline.length === 0) {
    return null;
  }

  const sorted = kline.slice().sort(function sortByTime(a, b) {
    return Number(a.started_at || 0) - Number(b.started_at || 0);
  });
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const beforeRaw = first.open_price || first.close_price;
  const nowRaw = last.close_price || last.open_price;

  return {
    beforeRaw: beforeRaw,
    nowRaw: nowRaw,
    beforePrice: parseAspectaRawPrice(beforeRaw),
    nowPrice: parseAspectaRawPrice(nowRaw),
    beforeText: formatAspectaRawPrice(beforeRaw, mover.paymentToken),
    nowText: formatAspectaRawPrice(nowRaw, mover.paymentToken),
  };
}

function getAspectaAssetTitle(item) {
  const asset = item && item.asset ? item.asset : {};
  const projectData = asset.project_data ? asset.project_data : {};

  return (
    projectData.title ||
    projectData.project_name ||
    asset.wallet_address ||
    asset.name ||
    "unknown"
  );
}

function getAspectaAssetMatchKeys(item) {
  const asset = item && item.asset ? item.asset : {};
  const projectData = asset.project_data ? asset.project_data : {};
  const values = [
    projectData.title,
    projectData.project_name,
    projectData.symbol,
    projectData.ticker,
    asset.name,
    asset.symbol,
    asset.ticker,
    asset.wallet_address,
    asset.id,
    item && item.id,
  ];

  return values.map(normalizeAspectaMonitorName).filter(Boolean);
}

function normalizeAspectaAsset(item) {
  const asset = item && item.asset ? item.asset : {};
  const rawChange =
    item && item.price_change_24h != null
      ? item.price_change_24h
      : asset.price_change_24h;
  const changeRatio = Number(rawChange);

  if (!Number.isFinite(changeRatio)) {
    return null;
  }

  return {
    key: String(asset.id || item.id || getAspectaAssetTitle(item)),
    arenaId: item.id,
    assetId: asset.id,
    title: getAspectaAssetTitle(item),
    changePercent: changeRatio * 100,
    paymentToken: asset.payment_token_symbol || "",
    walletAddress: asset.wallet_address || "",
    matchKeys: getAspectaAssetMatchKeys(item),
  };
}

function isAspectaMonitoredAsset(asset) {
  if (ASPECTA_MONITORED_ASSET_SET.size === 0) {
    return true;
  }

  return asset.matchKeys.some(function hasMonitoredName(matchKey) {
    return ASPECTA_MONITORED_ASSET_SET.has(matchKey);
  });
}

function getAspectaMonitoredAssets(items) {
  return items
    .map(normalizeAspectaAsset)
    .filter(function filterValidAsset(asset) {
      return asset && Number.isFinite(asset.changePercent);
    })
    .filter(isAspectaMonitoredAsset)
    .map(function addMoverType(asset) {
      return Object.assign({ moverType: "Monitored Asset" }, asset);
    });
}

function getAspectaThresholdDecision(mover) {
  if (!mover) {
    return {
      shouldCheck: false,
      reason: "missing",
    };
  }

  const breached =
    mover.changePercent >= ASPECTA_CHANGE_THRESHOLD_PERCENT ||
    mover.changePercent <= -ASPECTA_CHANGE_THRESHOLD_PERCENT;

  if (!breached) {
    return {
      shouldCheck: false,
      reason: "below threshold",
    };
  }

  return {
    shouldCheck: true,
    reason: "threshold breached",
  };
}

function hasUsableAspectaPriceSnapshot(priceSnapshot) {
  return (
    priceSnapshot &&
    priceSnapshot.beforeRaw != null &&
    priceSnapshot.nowRaw != null &&
    Number.isFinite(Number(priceSnapshot.beforePrice)) &&
    Number.isFinite(Number(priceSnapshot.nowPrice))
  );
}

function getAspectaInitialPrice(previous, priceSnapshot, tokenSymbol) {
  const previousInitialPrice = Number(previous && previous.initialPriceValue);

  if (previous && Number.isFinite(previousInitialPrice)) {
    return {
      raw: previous.initialPriceRaw,
      value: previousInitialPrice,
      text:
        previous.initialPriceText ||
        formatAspectaPriceAmount(
          previousInitialPrice,
          previous.initialPriceToken || tokenSymbol
        ),
      token: previous.initialPriceToken || tokenSymbol || "",
    };
  }

  return {
    raw: priceSnapshot.beforeRaw,
    value: Number(priceSnapshot.beforePrice),
    text: priceSnapshot.beforeText,
    token: tokenSymbol || "",
  };
}

function pruneAspectaAlertTimestamps(timestamps, nowMs) {
  if (!Array.isArray(timestamps)) {
    return [];
  }

  const cutoffMs = nowMs - ASPECTA_REPEAT_ALERT_WINDOW_MS;
  const seen = new Set();

  return timestamps
    .filter(function filterRecentTimestamp(timestamp) {
      const parsed = Date.parse(timestamp);
      return Number.isFinite(parsed) && parsed >= cutoffMs && parsed <= nowMs;
    })
    .sort()
    .filter(function filterDuplicateTimestamp(timestamp) {
      if (seen.has(timestamp)) {
        return false;
      }

      seen.add(timestamp);
      return true;
    });
}

function getAspectaRecentAlertTimestamps(previous, nowMs) {
  const timestamps = previous && Array.isArray(previous.recentAlertTimestamps)
    ? previous.recentAlertTimestamps.slice()
    : [];

  if (timestamps.length === 0 && previous && previous.lastAlertAt) {
    timestamps.push(previous.lastAlertAt);
  }

  return pruneAspectaAlertTimestamps(timestamps, nowMs);
}

function getAspectaRepeatPriceDeltaPercent(recentAlertCount) {
  if (recentAlertCount >= 20) {
    return ASPECTA_REPEAT_PRICE_DELTA_PERCENT_AFTER_20_ALERTS;
  }

  if (recentAlertCount >= 10) {
    return ASPECTA_REPEAT_PRICE_DELTA_PERCENT_AFTER_10_ALERTS;
  }

  return ASPECTA_REPEAT_PRICE_DELTA_PERCENT;
}

function getAspectaRepeatPriceThreshold(initialPrice, repeatPriceDeltaPercent) {
  if (!Number.isFinite(initialPrice)) {
    return NaN;
  }

  return (
    Math.abs(initialPrice) *
    repeatPriceDeltaPercent /
    100
  );
}

function getAspectaAlertDecision(mover, priceSnapshot, nowMs) {
  const previous = aspectaAlerts[mover.key];

  if (!previous) {
    return {
      shouldSend: true,
      reason: "first trigger",
      previous: previous,
    };
  }

  const recentAlertTimestamps = getAspectaRecentAlertTimestamps(
    previous,
    nowMs
  );
  const recentAlertCount = recentAlertTimestamps.length;
  const repeatPriceDeltaPercent = getAspectaRepeatPriceDeltaPercent(
    recentAlertCount
  );
  const previousPrice = Number(previous.lastPriceValue);

  if (!Number.isFinite(previousPrice)) {
    return {
      shouldSend: false,
      shouldUpdateBaseline: true,
      reason: "price baseline initialized for existing alert",
      previous: previous,
      recentAlertTimestamps: recentAlertTimestamps,
    };
  }

  const initialPrice = getAspectaInitialPrice(
    previous,
    priceSnapshot,
    mover.paymentToken
  );
  const repeatPriceThreshold = getAspectaRepeatPriceThreshold(
    initialPrice.value,
    repeatPriceDeltaPercent
  );

  if (!Number.isFinite(repeatPriceThreshold) || repeatPriceThreshold <= 0) {
    return {
      shouldSend: false,
      shouldUpdateBaseline: true,
      reason: "initial price baseline unavailable",
      previous: previous,
      recentAlertTimestamps: recentAlertTimestamps,
    };
  }

  const priceDelta = Number(priceSnapshot.nowPrice) - previousPrice;

  if (Math.abs(priceDelta) >= repeatPriceThreshold) {
    return {
      shouldSend: true,
      reason: "repeat price delta",
      previous: previous,
      priceDelta: priceDelta,
      repeatPriceThreshold: repeatPriceThreshold,
      repeatPriceDeltaPercent: repeatPriceDeltaPercent,
      recentAlertCount: recentAlertCount,
      recentAlertTimestamps: recentAlertTimestamps,
      initialPrice: initialPrice,
    };
  }

  return {
    shouldSend: false,
    reason:
      "repeat price delta " +
      formatAspectaPriceAmount(Math.abs(priceDelta), mover.paymentToken) +
      " below " +
      formatAspectaPriceAmount(repeatPriceThreshold, mover.paymentToken) +
      " (" +
      repeatPriceDeltaPercent.toFixed(2) +
      "% of initial price; 24h alerts: " +
      recentAlertCount +
      ")",
    previous: previous,
    priceDelta: priceDelta,
    repeatPriceThreshold: repeatPriceThreshold,
    repeatPriceDeltaPercent: repeatPriceDeltaPercent,
    recentAlertCount: recentAlertCount,
    recentAlertTimestamps: recentAlertTimestamps,
    initialPrice: initialPrice,
  };
}

function buildAspectaAlertState(
  mover,
  priceSnapshot,
  alertAt,
  recordType,
  previous,
  recentAlertTimestamps
) {
  const initialPrice = getAspectaInitialPrice(
    previous,
    priceSnapshot,
    mover.paymentToken
  );
  const alertAtMs = Number.isFinite(Date.parse(alertAt))
    ? Date.parse(alertAt)
    : Date.now();
  const existingAlertTimestamps = Array.isArray(recentAlertTimestamps)
    ? recentAlertTimestamps
    : getAspectaRecentAlertTimestamps(previous, alertAtMs);
  const updatedAlertTimestamps =
    recordType === "alert"
      ? existingAlertTimestamps.concat(alertAt)
      : existingAlertTimestamps;
  const prunedAlertTimestamps = pruneAspectaAlertTimestamps(
    updatedAlertTimestamps,
    alertAtMs
  );

  return {
    lastAlertAt:
      recordType === "alert"
        ? alertAt
        : previous && previous.lastAlertAt
          ? previous.lastAlertAt
          : null,
    lastChangePercent: mover.changePercent,
    lastMoverType: mover.moverType,
    title: mover.title,
    assetId: mover.assetId || null,
    lastPriceRaw: priceSnapshot.nowRaw != null ? String(priceSnapshot.nowRaw) : null,
    lastPriceValue: Number(priceSnapshot.nowPrice),
    lastPriceText: priceSnapshot.nowText,
    lastPriceToken: mover.paymentToken || "",
    lastPriceRecordType: recordType,
    lastPriceRecordedAt: alertAt,
    initialPriceRaw:
      initialPrice.raw != null ? String(initialPrice.raw) : null,
    initialPriceValue: Number(initialPrice.value),
    initialPriceText: initialPrice.text,
    initialPriceToken: initialPrice.token,
    recentAlertTimestamps: prunedAlertTimestamps,
  };
}

async function sendAspectaAlert(mover, decision, priceSnapshot) {
  const previous = decision.previous;
  const previousPrice = previous ? Number(previous.lastPriceValue) : NaN;
  const beforePrice = Number(priceSnapshot.beforePrice);
  const nowPrice = Number(priceSnapshot.nowPrice);
  const pricePath = Number.isFinite(previousPrice)
    ? formatAspectaTemplatePrice(beforePrice) +
      "  ->" +
      formatAspectaTemplatePrice(previousPrice) +
      " -> " +
      formatAspectaTemplatePrice(nowPrice)
    : formatAspectaTemplatePrice(beforePrice) +
      " -> " +
      formatAspectaTemplatePrice(nowPrice);

  const message =
    "Aspecta : " +
    mover.title +
    "\n" +
    pricePath +
    "（" +
    formatPercent(mover.changePercent) +
    "）";

  return sendTelegram(message, TELEGRAM_ALERT_CHAT_ID);
}

async function maybeSendAspectaAlert(mover, timestamp) {
  const thresholdDecision = getAspectaThresholdDecision(mover);

  if (!thresholdDecision.shouldCheck) {
    console.log(
      "[" +
        timestamp +
        "] Aspecta " +
        (mover ? mover.moverType + " " + mover.title : "mover") +
        " not alerted: " +
        thresholdDecision.reason
    );
    return;
  }

  let priceSnapshot;
  try {
    priceSnapshot = await fetchAspectaPriceSnapshot(mover);
  } catch (error) {
    console.error(
      "[" +
        timestamp +
        "] Aspecta price snapshot error for " +
        mover.title +
        ": " +
        error.message
    );
  }

  if (!hasUsableAspectaPriceSnapshot(priceSnapshot)) {
    console.log(
      "[" +
        timestamp +
        "] Aspecta " +
        mover.moverType +
        " " +
        mover.title +
        " not alerted: price snapshot unavailable"
    );
    return;
  }

  const decisionTimeMs = Date.now();
  const decision = getAspectaAlertDecision(
    mover,
    priceSnapshot,
    decisionTimeMs
  );

  if (decision.shouldUpdateBaseline) {
    const now = new Date().toISOString();
    aspectaAlerts[mover.key] = buildAspectaAlertState(
      mover,
      priceSnapshot,
      now,
      "baseline",
      decision.previous,
      decision.recentAlertTimestamps
    );
    saveState();
    console.log(
      "[" +
        timestamp +
        "] Aspecta " +
        mover.moverType +
        " " +
        mover.title +
        " not alerted: " +
        decision.reason +
        " at " +
        priceSnapshot.nowText
    );
    return;
  }

  if (!decision.shouldSend) {
    console.log(
      "[" +
        timestamp +
        "] Aspecta " +
        mover.moverType +
        " " +
        mover.title +
        " not alerted: " +
        decision.reason
    );
    return;
  }

  console.log(
    "[" +
      timestamp +
      "] Aspecta " +
      mover.moverType +
      " alert triggered for " +
      mover.title +
      " at " +
      formatPercent(mover.changePercent)
  );
  await sendAspectaAlert(mover, decision, priceSnapshot);
  const now = new Date().toISOString();
  aspectaAlerts[mover.key] = buildAspectaAlertState(
    mover,
    priceSnapshot,
    now,
    "alert",
    decision.previous,
    decision.recentAlertTimestamps
  );
  saveState();
  console.log(
    "[" +
      timestamp +
      "] Aspecta " +
      mover.moverType +
      " alert sent for " +
      mover.title
  );
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

  return sendTelegram(message, TELEGRAM_ALERT_CHAT_ID);
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

  return sendTelegram(message, TELEGRAM_DAILY_CHAT_ID);
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
  console.log(
    "Alert chat ID configured: " + (TELEGRAM_ALERT_CHAT_ID ? "yes" : "no")
  );
  console.log(
    "Daily chat ID configured: " + (TELEGRAM_DAILY_CHAT_ID ? "yes" : "no")
  );
  console.log("API key configured: " + (API_KEY ? "yes" : "no"));
  console.log("Aspecta monitor: " + (ASPECTA_ENABLED ? "enabled" : "disabled"));
  if (ASPECTA_ENABLED) {
    console.log("Aspecta monitored assets: " + ASPECTA_MONITORED_ASSETS);
    console.log(
      "Aspecta interval: " +
        ASPECTA_CHECK_INTERVAL_MS / 1000 +
        "s (" +
        ASPECTA_CHECK_INTERVAL_MS / 60000 +
        "m)"
    );
    console.log(
      "Aspecta threshold: " +
        formatPercent(ASPECTA_CHANGE_THRESHOLD_PERCENT) +
        " | repeat price delta: " +
        ASPECTA_REPEAT_PRICE_DELTA_PERCENT.toFixed(2) +
        "% / " +
        ASPECTA_REPEAT_PRICE_DELTA_PERCENT_AFTER_10_ALERTS.toFixed(2) +
        "% after 10 alerts / " +
        ASPECTA_REPEAT_PRICE_DELTA_PERCENT_AFTER_20_ALERTS.toFixed(2) +
        "% after 20 alerts in " +
        ASPECTA_REPEAT_ALERT_WINDOW_HOURS +
        "h"
    );
  }
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

async function checkAspecta() {
  if (!ASPECTA_ENABLED) {
    return;
  }

  const timestamp = new Date().toISOString();
  console.log(
    "[" +
      timestamp +
      "] Checking Aspecta monitored assets: " +
      ASPECTA_MONITORED_ASSETS
  );

  try {
    const items = await fetchAspectaPopularAssets();
    const assets = getAspectaMonitoredAssets(items);

    if (assets.length === 0) {
      console.log(
        "[" +
          timestamp +
          "] Aspecta monitored assets not found: " +
          ASPECTA_MONITORED_ASSETS
      );
      return;
    }

    console.log(
      "[" +
        timestamp +
        "] Aspecta monitored assets: " +
        assets
          .map(function formatMonitoredAsset(asset) {
            return asset.title + " " + formatPercent(asset.changePercent);
          })
          .join(" | ")
    );

    for (const asset of assets) {
      await maybeSendAspectaAlert(asset, timestamp);
    }
  } catch (error) {
    console.error("[" + timestamp + "] Aspecta error: " + error.message);
  }
}

async function main() {
  loadState();
  logRuntimeConfig();
  await check();
  await checkAspecta();

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

    if (ASPECTA_ENABLED) {
      setInterval(function runScheduledAspectaCheck() {
        checkAspecta().catch(function handleAspectaCheckError(error) {
          console.error(
            "[" +
              new Date().toISOString() +
              "] Unexpected Aspecta interval error: " +
              error.message
          );
        });
      }, ASPECTA_CHECK_INTERVAL_MS);
    }
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
