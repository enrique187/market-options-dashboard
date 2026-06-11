const state = {
  symbol: "SPY",
  instrumentName: "SPDR S&P 500 ETF",
  timeframe: "1m",
  candles: [],
  quoteCandles: [],
  meta: {},
  quoteMeta: {},
  liveQuote: null,
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  emaSeries: null,
  vwapSeries: null,
  upperBandSeries: null,
  lowerBandSeries: null,
  maSeries: {},
  levelLines: [],
  marketStripItems: [],
  maEnabled: {
    20: false,
    40: false,
    100: false,
    200: false,
  },
  refreshTimer: null,
  liveTimer: null,
  optionsTimer: null,
  marketStripTimer: null,
  mag7Timer: null,
  marketClockTimer: null,
  marketClockSyncTimer: null,
  marketClock: null,
  marketClockReceivedAt: 0,
  searchTimer: null,
  fittedOnce: false,
  lastRenderedPrice: null,
  polling: false,
};

const PREFS_KEY = "spyDashboardPrefs";
const VALID_FRAMES = ["1m", "15m", "1h", "1d", "1w"];
const THEME_KEY = "dashboard-theme";

// ── Theme helpers ────────────────────────────────────────────────

function getChartThemeOptions(theme) {
  if (theme === "light") {
    return {
      layout: {
        background: { type: "solid", color: "#f8f9fb" },
        textColor: "#6b7280",
      },
      grid: {
        vertLines: { color: "rgba(107,114,128,.15)" },
        horzLines: { color: "rgba(107,114,128,.20)" },
      },
      rightPriceScale: { borderColor: "#d1d5db" },
      timeScale: { borderColor: "#d1d5db" },
    };
  }
  // dark (default)
  return {
    layout: {
      background: { type: "solid", color: "#0c0d0f" },
      textColor: "#a5abb5",
    },
    grid: {
      vertLines: { color: "rgba(165,171,181,.11)" },
      horzLines: { color: "rgba(165,171,181,.16)" },
    },
    rightPriceScale: { borderColor: "#323842" },
    timeScale: { borderColor: "#323842" },
  };
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  if (elements.themeToggle) {
    elements.themeToggle.textContent = theme === "light" ? "☾" : "☀︎";
    elements.themeToggle.setAttribute("aria-label", theme === "light" ? "Switch to dark theme" : "Switch to light theme");
  }
  if (state.chart) {
    state.chart.applyOptions(getChartThemeOptions(theme));
  }
}

function initTheme() {
  const saved = (() => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } })();
  const theme = saved === "light" || saved === "dark" ? saved : "dark";
  applyTheme(theme);
  if (elements.themeToggle) {
    elements.themeToggle.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "dark";
      const next = current === "dark" ? "light" : "dark";
      try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
      applyTheme(next);
    });
  }
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    // Ignore storage failures (private mode, quota) - prefs are best-effort.
  }
}

const appConfig = {
  defaultSymbol: "SPY",
  defaultName: "SPDR S&P 500 ETF",
  optionBudget: 80,
  optionTargetPremium: 1.07,
  referralLinks: [],
};

const elements = {
  indexStrip: document.querySelector("#indexStrip"),
  mag7Tape: document.querySelector("#mag7Tape"),
  clockTime: document.querySelector("#clockTime"),
  clockDate: document.querySelector("#clockDate"),
  marketSessionBadge: document.querySelector("#marketSessionBadge"),
  marketCountdown: document.querySelector("#marketCountdown"),
  readBias: document.querySelector("#readBias"),
  readBiasDetail: document.querySelector("#readBiasDetail"),
  readVwap: document.querySelector("#readVwap"),
  readVwapDetail: document.querySelector("#readVwapDetail"),
  readVix: document.querySelector("#readVix"),
  readVixDetail: document.querySelector("#readVixDetail"),
  readConfirmations: document.querySelector("#readConfirmations"),
  readConfirmationsDetail: document.querySelector("#readConfirmationsDetail"),
  levelsGrid: document.querySelector("#levelsGrid"),
  levelsMeta: document.querySelector("#levelsMeta"),
  chart: document.querySelector("#chart"),
  loading: document.querySelector("#loading"),
  tooltip: document.querySelector("#tooltip"),
  price: document.querySelector("#price"),
  change: document.querySelector("#change"),
  liveDot: document.querySelector("#liveDot"),
  liveLabel: document.querySelector("#liveLabel"),
  marketState: document.querySelector("#marketState"),
  bid: document.querySelector("#bid"),
  ask: document.querySelector("#ask"),
  range: document.querySelector("#range"),
  volume: document.querySelector("#volume"),
  timeframes: document.querySelector("#timeframes"),
  maToggles: document.querySelector("#maToggles"),
  sourceStatus: document.querySelector("#sourceStatus"),
  ticker: document.querySelector("#ticker"),
  instrumentName: document.querySelector("#instrumentName"),
  symbolSearch: document.querySelector("#symbolSearch"),
  symbolInput: document.querySelector("#symbolInput"),
  searchResults: document.querySelector("#searchResults"),
  optionsRows: document.querySelector("#optionsRows"),
  optionsMeta: document.querySelector("#optionsMeta"),
  optionsSource: document.querySelector("#optionsSource"),
  budgetStatus: document.querySelector("#budgetStatus"),
  targetStatus: document.querySelector("#targetStatus"),
  referralLinks: document.querySelector("#referralLinks"),
  themeToggle: document.querySelector("#themeToggle"),
};

let optionBudget = appConfig.optionBudget;
let maxPremium = optionBudget / 100;
let alertPremium = appConfig.optionTargetPremium;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const etPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

elements.timeframes.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-frame]");
  if (!button) return;
  setTimeframe(button.dataset.frame);
});

elements.maToggles.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-ma]");
  if (!button) return;
  const period = Number(button.dataset.ma);
  state.maEnabled[period] = !state.maEnabled[period];
  button.setAttribute("aria-pressed", String(state.maEnabled[period]));
  savePrefs({ maEnabled: state.maEnabled });
  renderTradingViewChart();
});

elements.symbolSearch.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = elements.symbolInput.value.trim();
  if (!raw) return;
  const match = await findBestSymbol(raw);
  changeSymbol(match.symbol, match.name);
});

elements.symbolInput.addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  const query = elements.symbolInput.value.trim();
  if (!query) {
    elements.searchResults.hidden = true;
    elements.searchResults.innerHTML = "";
    return;
  }
  state.searchTimer = setTimeout(() => searchSymbols(query), 220);
});

document.addEventListener("click", (event) => {
  if (!elements.symbolSearch.contains(event.target)) {
    elements.searchResults.hidden = true;
  }
});

window.addEventListener("resize", () => {
  if (!state.chart) return;
  state.chart.applyOptions({
    width: elements.chart.clientWidth,
    height: elements.chart.clientHeight,
  });
});

// Number keys 1-5 jump between timeframes (ignored while typing in a field).
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest("input, textarea, select")) return;
  const frame = VALID_FRAMES[Number(event.key) - 1];
  if (frame) setTimeframe(frame);
});

// Pause polling while the tab is hidden, then refresh immediately on return.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    startPolling();
  }
});

boot();

async function boot() {
  initTheme();
  await loadConfig();
  restorePrefs();
  initTradingViewChart();
  setTimeframe(state.timeframe);
  startPolling();
  startMarketClock();
}

function restorePrefs() {
  const prefs = loadPrefs();
  if (prefs.symbol) {
    state.symbol = sanitizeSymbol(prefs.symbol);
    state.instrumentName = prefs.name || state.symbol;
    elements.ticker.textContent = state.symbol;
    elements.instrumentName.textContent = state.instrumentName;
    document.title = `${state.symbol} Market Dashboard`;
  }
  if (VALID_FRAMES.includes(prefs.timeframe)) {
    state.timeframe = prefs.timeframe;
  }
  if (prefs.maEnabled) {
    for (const period of [20, 40, 100, 200]) {
      state.maEnabled[period] = Boolean(prefs.maEnabled[period]);
      const button = elements.maToggles.querySelector(`button[data-ma="${period}"]`);
      if (button) button.setAttribute("aria-pressed", String(state.maEnabled[period]));
    }
  }
}

function startPolling() {
  if (state.polling) return;
  state.polling = true;
  loadData();
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(loadData, state.timeframe === "1m" ? 60000 : 120000);
  startLivePolling();
  startOptionsPolling();
  startMarketStripPolling();
}

function stopPolling() {
  state.polling = false;
  clearInterval(state.refreshTimer);
  clearInterval(state.liveTimer);
  clearInterval(state.optionsTimer);
  clearInterval(state.marketStripTimer);
  clearInterval(state.mag7Timer);
  setLive(false, "paused");
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`Config ${response.status}`);
    const config = await response.json();
    applyConfig(config);
  } catch (error) {
    console.warn("Using default dashboard config", error);
    applyConfig(appConfig);
  }
}

function applyConfig(config) {
  appConfig.defaultSymbol = sanitizeSymbol(config.defaultSymbol || appConfig.defaultSymbol);
  appConfig.defaultName = config.defaultName || appConfig.defaultSymbol;
  appConfig.optionBudget = Number(config.optionBudget || appConfig.optionBudget);
  appConfig.optionTargetPremium = Number(config.optionTargetPremium || appConfig.optionTargetPremium);
  appConfig.referralLinks = Array.isArray(config.referralLinks) ? config.referralLinks : [];
  state.symbol = appConfig.defaultSymbol;
  state.instrumentName = appConfig.defaultName;
  optionBudget = appConfig.optionBudget;
  maxPremium = optionBudget / 100;
  alertPremium = appConfig.optionTargetPremium;
  elements.ticker.textContent = state.symbol;
  elements.instrumentName.textContent = state.instrumentName;
  elements.budgetStatus.textContent = `$${optionBudget} budget - waiting for ask`;
  elements.targetStatus.textContent = `${money.format(alertPremium)} target - waiting for ask`;
  document.title = `${state.symbol} Market Dashboard`;
  renderReferralLinks();
}

function initTradingViewChart() {
  const LightweightCharts = window.LightweightCharts;
  const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";
  const themeOpts = getChartThemeOptions(currentTheme);
  state.chart = LightweightCharts.createChart(elements.chart, {
    width: elements.chart.clientWidth,
    height: elements.chart.clientHeight,
    autoSize: true,
    layout: {
      ...themeOpts.layout,
      attributionLogo: true,
    },
    grid: themeOpts.grid,
    rightPriceScale: {
      ...themeOpts.rightPriceScale,
      scaleMargins: { top: 0.08, bottom: 0.12 },
    },
    timeScale: {
      ...themeOpts.timeScale,
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
    },
  });

  state.candleSeries = addSeries("Candlestick", {
    upColor: "#3bcf8e",
    downColor: "#ff6b6b",
    borderUpColor: "#3bcf8e",
    borderDownColor: "#ff6b6b",
    wickUpColor: "#3bcf8e",
    wickDownColor: "#ff6b6b",
  });

  state.volumeSeries = addSeries("Histogram", {
    color: "rgba(98, 168, 255, .28)",
    priceFormat: { type: "volume" },
    priceScaleId: "volume",
    lastValueVisible: false,
    priceLineVisible: false,
  });
  state.chart.priceScale("volume").applyOptions({
    scaleMargins: { top: 0.82, bottom: 0 },
  });

  state.emaSeries = addSeries("Line", {
    color: "#62a8ff",
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  state.vwapSeries = addSeries("Line", {
    color: "#21d4d4",
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  state.upperBandSeries = addSeries("Line", {
    color: "#62a8ff",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  state.lowerBandSeries = addSeries("Line", {
    color: "#62a8ff",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  state.maSeries[20] = addSeries("Line", {
    color: "#f4bd50",
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  state.maSeries[40] = addSeries("Line", {
    color: "#ff6b6b",
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  state.maSeries[100] = addSeries("Line", {
    color: "#3bcf8e",
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  state.maSeries[200] = addSeries("Line", {
    color: "#b28cff",
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
  });

  state.chart.subscribeCrosshairMove(showTradingViewTooltip);
}

function addSeries(type, options) {
  const LightweightCharts = window.LightweightCharts;
  if (state.chart.addSeries && LightweightCharts[`${type}Series`]) {
    return state.chart.addSeries(LightweightCharts[`${type}Series`], options);
  }
  if (type === "Candlestick") return state.chart.addCandlestickSeries(options);
  if (type === "Histogram") return state.chart.addHistogramSeries(options);
  return state.chart.addLineSeries(options);
}

function setTimeframe(timeframe) {
  state.timeframe = timeframe;
  state.fittedOnce = false;
  savePrefs({ timeframe });
  for (const button of elements.timeframes.querySelectorAll("button")) {
    const isActive = button.dataset.frame === timeframe;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  }
  loadData();
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(loadData, timeframe === "1m" ? 60000 : 120000);
}

async function loadData() {
  elements.loading.hidden = false;
  elements.loading.textContent = "Loading";
  try {
    const requests = [
      fetch(`/api/spy?symbol=${encodeURIComponent(state.symbol)}&timeframe=${encodeURIComponent(state.timeframe)}`, { cache: "no-store" }),
    ];
    if (state.timeframe !== "1m") {
      requests.push(fetch(`/api/spy?symbol=${encodeURIComponent(state.symbol)}&timeframe=1m`, { cache: "no-store" }));
    }

    const responses = await Promise.all(requests);
    const payload = await responses[0].json();
    if (!responses[0].ok) throw new Error(payload.error || "Market data unavailable");

    state.candles = normalizeCandles(payload.candles || []);
    state.meta = payload.meta || {};
    state.liveQuote = payload.liveQuote || null;
    if (state.liveQuote) applyQuoteToCandles(state.liveQuote);

    if (responses[1]) {
      const quotePayload = await responses[1].json();
      if (responses[1].ok) {
        state.quoteCandles = normalizeCandles(quotePayload.candles || []);
        state.quoteMeta = quotePayload.meta || {};
        state.liveQuote = quotePayload.liveQuote || state.liveQuote;
        if (state.liveQuote) applyQuoteToCandles(state.liveQuote);
      }
    } else {
      state.quoteCandles = state.candles;
      state.quoteMeta = state.meta;
    }

    updateSummary();
    renderTradingViewChart();
    elements.loading.hidden = true;
  } catch (error) {
    elements.loading.textContent = error.message;
  }
}

function startLivePolling() {
  clearInterval(state.liveTimer);
  state.liveTimer = setInterval(loadLiveQuote, 3000);
}

function startOptionsPolling() {
  loadOptions();
  clearInterval(state.optionsTimer);
  state.optionsTimer = setInterval(loadOptions, 30000);
}

function startMarketStripPolling() {
  loadMarketStrip();
  loadMag7Strip();
  clearInterval(state.marketStripTimer);
  state.marketStripTimer = setInterval(loadMarketStrip, 10000);
  clearInterval(state.mag7Timer);
  state.mag7Timer = setInterval(loadMag7Strip, 10000);
}

function startMarketClock() {
  loadMarketClock();
  clearInterval(state.marketClockSyncTimer);
  state.marketClockSyncTimer = setInterval(loadMarketClock, 30000);
  clearInterval(state.marketClockTimer);
  state.marketClockTimer = setInterval(renderMarketClock, 1000);
}

async function loadMarketClock() {
  try {
    const response = await fetch("/api/market-clock", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Clock unavailable");
    state.marketClock = payload;
    state.marketClockReceivedAt = Date.now();
    renderMarketClock();
  } catch (error) {
    elements.marketSessionBadge.textContent = "Clock unavailable";
    elements.marketSessionBadge.className = "marketSessionBadge closed";
    elements.marketCountdown.textContent = error.message;
  }
}

function renderMarketClock() {
  if (!state.marketClock) return;
  const elapsed = Date.now() - state.marketClockReceivedAt;
  const now = new Date(state.marketClock.nowEpochMs + elapsed);
  const next = new Date(state.marketClock.nextEventEpochMs);
  const remainingMs = Math.max(0, next.getTime() - now.getTime());

  elements.clockTime.textContent = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(now) + " ET";
  elements.clockDate.textContent = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(now);
  elements.marketSessionBadge.textContent = state.marketClock.label;
  elements.marketSessionBadge.className = `marketSessionBadge ${state.marketClock.status}`;
  elements.marketCountdown.textContent = `${state.marketClock.nextEventLabel} in ${formatDuration(remainingMs)} - ${state.marketClock.detail}`;
}

async function loadMarketStrip() {
  try {
    const response = await fetch("/api/market-strip", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Indexes unavailable");
    renderMarketStrip(payload.items || []);
  } catch (error) {
    elements.indexStrip.innerHTML = `<div class="indexCard loadingIndex">${escapeHtml(error.message)}</div>`;
  }
}

function renderMarketStrip(items) {
  state.marketStripItems = items;
  renderMarketRead();
  elements.indexStrip.innerHTML = items.map((item) => {
    if (item.error) {
      return `<div class="indexCard"><div class="indexTop"><span class="indexSymbol">${escapeHtml(item.symbol)}</span><span class="indexChange">Error</span></div><div class="indexPrice">--</div></div>`;
    }
    const direction = item.change == null ? "" : item.change >= 0 ? "up" : "down";
    const sign = item.change == null || item.change < 0 ? "" : "+";
    const price = money.format(item.price);
    const change = item.change == null ? "--" : `${sign}${item.change.toFixed(2)} (${sign}${item.changePercent.toFixed(2)}%)`;
    return `
      <div class="indexCard">
        <div class="indexTop">
          <span class="indexSymbol">${escapeHtml(item.symbol)}</span>
          <span class="indexChange ${direction}">${change}</span>
        </div>
        <div class="indexPrice">${price}</div>
      </div>
    `;
  }).join("");
}

async function loadMag7Strip() {
  try {
    const response = await fetch("/api/mag7-strip", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Magnificent 7 unavailable");
    renderMag7Tape(payload.items || []);
  } catch (error) {
    elements.mag7Tape.innerHTML = `<span class="mag7Loading">${escapeHtml(error.message)}</span>`;
  }
}

function renderMag7Tape(items) {
  const cells = items.map((item) => {
    if (item.error) {
      return `<span class="mag7Item"><span class="mag7Symbol">${escapeHtml(item.symbol)}</span><span class="mag7Price">--</span><span class="mag7Change">Error</span></span>`;
    }
    const direction = item.change == null ? "" : item.change >= 0 ? "up" : "down";
    const sign = item.change == null || item.change < 0 ? "" : "+";
    const price = item.price == null ? "--" : money.format(item.price);
    const change = item.change == null ? "--" : `${sign}${item.change.toFixed(2)} (${sign}${item.changePercent.toFixed(2)}%)`;
    return `
      <span class="mag7Item">
        <span class="mag7Symbol">${escapeHtml(item.symbol)}</span>
        <span class="mag7Price">${price}</span>
        <span class="mag7Change ${direction}">${change}</span>
        <span class="mag7Source">RH</span>
      </span>
    `;
  });
  const content = cells.length ? cells.join("") : `<span class="mag7Loading">Waiting for live prices</span>`;
  elements.mag7Tape.innerHTML = content + content;
}

function renderReferralLinks() {
  const links = appConfig.referralLinks
    .filter((link) => link?.label && link?.url)
    .map((link) => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer sponsored">${escapeHtml(link.label)}</a>`);

  elements.referralLinks.innerHTML = links.length
    ? `${links.join("")}<span>Referral links may provide benefits to the owner.</span>`
    : "<span>No referral links configured</span>";
}

async function loadLiveQuote() {
  try {
    const response = await fetch(`/api/quote?symbol=${encodeURIComponent(state.symbol)}`, { cache: "no-store" });
    const quote = await response.json();
    if (!response.ok) {
      setLive(false, "reconnecting");
      return;
    }
    state.liveQuote = quote;
    applyQuoteToCandles(quote);
    updateSummary();
    renderTradingViewChart();
    setLive(true, "live");
  } catch {
    // Keep the last displayed quote if a fast live poll misses.
    setLive(false, "reconnecting");
  }
}

function applyQuoteToCandles(quote) {
  if (!quote?.price || !state.candles.length) return;
  const observedAt = quote.fetchedAt || quote.asOf;
  const timestamp = observedAt ? Math.floor(new Date(observedAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const bucketSize = secondsForFrame(state.timeframe);
  const bucket = timestamp - (timestamp % bucketSize);
  const last = state.candles.at(-1);
  const lastBucket = last ? last.time - (last.time % bucketSize) : null;

  if (last && lastBucket === bucket) {
    last.time = bucket;
    last.high = Math.max(last.high ?? quote.price, quote.price);
    last.low = Math.min(last.low ?? quote.price, quote.price);
    last.close = quote.price;
    last.source = "Robinhood";
  } else if (!last || bucket > last.time) {
    state.candles.push({
      time: bucket,
      open: quote.price,
      high: quote.price,
      low: quote.price,
      close: quote.price,
      volume: 0,
      source: "Robinhood",
    });
  }

  state.candles = normalizeCandles(state.candles);
  if (state.timeframe === "1m") state.quoteCandles = state.candles;
}

function renderTradingViewChart() {
  if (!state.candles.length) return;
  const candles = state.candles.map((candle) => ({
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  }));
  const closes = state.candles.map((candle) => candle.close);
  const ema = emaSeries(closes, 21);
  const bands = bollingerBands(closes, 20, 2);
  const vwap = vwapSeries(state.candles);
  const volume = state.candles.map((candle) => ({
    time: candle.time,
    value: candle.volume || 0,
    color: candle.close >= candle.open ? "rgba(59, 207, 142, .26)" : "rgba(255, 107, 107, .24)",
  }));

  state.candleSeries.setData(candles);
  state.volumeSeries.setData(volume);
  state.emaSeries.setData(lineData(ema));
  state.vwapSeries.setData(lineData(vwap));
  state.upperBandSeries.setData(lineData(bands.map((band) => band?.upper)));
  state.lowerBandSeries.setData(lineData(bands.map((band) => band?.lower)));
  for (const period of [20, 40, 100, 200]) {
    state.maSeries[period].setData(state.maEnabled[period] ? lineData(simpleMovingAverage(closes, period)) : []);
  }

  if (!state.fittedOnce) {
    state.chart.timeScale().fitContent();
    state.fittedOnce = true;
  }
  renderTradingLevels(vwap);
  renderMarketRead(vwap);
}

function renderTradingLevels(vwapValues = []) {
  const levels = computeTradingLevels(vwapValues);
  clearLevelLines();

  const lineConfigs = [
    { key: "previousClose", title: "Prev close", color: "#a5abb5" },
    { key: "premarketHigh", title: "PM high", color: "#f4bd50" },
    { key: "premarketLow", title: "PM low", color: "#f4bd50" },
    { key: "or15High", title: "OR15 high", color: "#3bcf8e" },
    { key: "or15Low", title: "OR15 low", color: "#ff6b6b" },
  ];

  for (const config of lineConfigs) {
    const price = levels[config.key];
    if (price == null) continue;
    state.levelLines.push(state.candleSeries.createPriceLine({
      price,
      color: config.color,
      lineWidth: 1,
      lineStyle: window.LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: config.title,
    }));
  }

  const vwap = lastValid(vwapValues);
  elements.levelsGrid.innerHTML = `
    ${levelBox("Premarket H/L", formatLevelPair(levels.premarketHigh, levels.premarketLow))}
    ${levelBox("Open range 5m", formatLevelPair(levels.or5High, levels.or5Low))}
    ${levelBox("Open range 15m", formatLevelPair(levels.or15High, levels.or15Low))}
    ${levelBox("Previous close", levels.previousClose == null ? "--" : money.format(levels.previousClose))}
    ${levelBox("Day H/L", formatLevelPair(levels.dayHigh, levels.dayLow))}
    ${levelBox("VWAP", vwap == null ? "--" : money.format(vwap))}
  `;
  elements.levelsMeta.textContent = levels.sessionDate ? `${levels.sessionDate} ET - lines: PM, OR15, previous close` : "Building from 1m tape";
}

function clearLevelLines() {
  for (const line of state.levelLines) {
    state.candleSeries?.removePriceLine(line);
  }
  state.levelLines = [];
}

function levelBox(label, value) {
  return `<div class="levelBox"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function formatLevelPair(high, low) {
  if (high == null || low == null) return "--";
  return `${money.format(high)} / ${money.format(low)}`;
}

function computeTradingLevels(vwapValues = []) {
  const candles = state.quoteCandles.length ? state.quoteCandles : state.candles;
  const latest = candles.at(-1);
  if (!latest) return {};
  const latestParts = etParts(latest.time);
  const sessionDate = `${latestParts.month}/${latestParts.day}`;
  const today = candles.filter((candle) => sameEtDate(candle.time, latest.time));
  const premarket = today.filter((candle) => inMinuteRange(candle.time, 4 * 60, 9 * 60 + 30));
  const regular = today.filter((candle) => inMinuteRange(candle.time, 9 * 60 + 30, 16 * 60 + 1));
  const or5 = today.filter((candle) => inMinuteRange(candle.time, 9 * 60 + 30, 9 * 60 + 35));
  const or15 = today.filter((candle) => inMinuteRange(candle.time, 9 * 60 + 30, 9 * 60 + 45));

  return {
    sessionDate,
    previousClose: freshestPreviousClose(),
    premarketHigh: highOf(premarket),
    premarketLow: lowOf(premarket),
    or5High: highOf(or5),
    or5Low: lowOf(or5),
    or15High: highOf(or15),
    or15Low: lowOf(or15),
    dayHigh: highOf(regular.length ? regular : today),
    dayLow: lowOf(regular.length ? regular : today),
    vwap: lastValid(vwapValues),
  };
}

function renderMarketRead(vwapValues = null) {
  const strip = Object.fromEntries(state.marketStripItems.map((item) => [item.symbol, item]));
  const price = state.liveQuote?.price ?? state.candles.at(-1)?.close;
  const latestVwap = lastValid(vwapValues || vwapSeries(state.candles));
  const aboveVwap = price != null && latestVwap != null ? price >= latestVwap : null;
  const spy = strip.SPY;
  const qqq = strip.QQQ;
  const dia = strip.DIA;
  const iwm = strip.IWM;
  const vix = strip.VIX;
  const riskOn = [spy, qqq, dia, iwm].filter((item) => (item?.changePercent ?? 0) > 0).length;
  const riskOff = [spy, qqq, dia, iwm].filter((item) => (item?.changePercent ?? 0) < 0).length;
  const vixUp = (vix?.changePercent ?? 0) > 0;

  let bias = "Wait";
  let biasClass = "neutral";
  let detail = "Need cleaner confirmation";
  if (aboveVwap === true && riskOn >= 3 && !vixUp) {
    bias = "Call bias";
    biasClass = "bullish";
    detail = "Above VWAP, indexes aligned, VIX not fighting";
  } else if (aboveVwap === false && riskOff >= 3 && vixUp) {
    bias = "Put bias";
    biasClass = "bearish";
    detail = "Below VWAP, indexes weak, VIX rising";
  } else if (aboveVwap === true && vixUp) {
    bias = "Caution";
    biasClass = "warning";
    detail = "Price above VWAP but VIX is rising";
  } else if (aboveVwap === false) {
    bias = "Bear lean";
    biasClass = "bearish";
    detail = "Below VWAP; wait for confirmation or reclaim";
  }

  elements.readBias.textContent = bias;
  elements.readBias.className = biasClass;
  elements.readBiasDetail.textContent = detail;
  elements.readVwap.textContent = latestVwap == null ? "--" : money.format(latestVwap);
  elements.readVwap.className = aboveVwap == null ? "neutral" : aboveVwap ? "bullish" : "bearish";
  elements.readVwapDetail.textContent = aboveVwap == null ? "Waiting for intraday volume" : `${state.symbol} is ${aboveVwap ? "above" : "below"} VWAP`;
  elements.readVix.textContent = vix?.price == null ? "--" : money.format(vix.price);
  elements.readVix.className = vixUp ? "bearish" : "bullish";
  elements.readVixDetail.textContent = vix?.changePercent == null ? "Waiting for VIX" : `${vixUp ? "Up" : "Down"} ${Math.abs(vix.changePercent).toFixed(2)}%`;
  elements.readConfirmations.textContent = `${riskOn} up / ${riskOff} down`;
  elements.readConfirmations.className = riskOn > riskOff ? "bullish" : riskOff > riskOn ? "bearish" : "neutral";
  elements.readConfirmationsDetail.textContent = `QQQ ${formatPct(qqq)} - DIA ${formatPct(dia)} - IWM ${formatPct(iwm)}`;
}

async function loadOptions() {
  try {
    const response = await fetch(`/api/options?symbol=${encodeURIComponent(state.symbol)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Options chain unavailable");
    renderOptions(payload);
  } catch (error) {
    elements.optionsRows.innerHTML = `<tr><td colspan="11">${escapeHtml(error.message)}</td></tr>`;
    elements.optionsMeta.textContent = "Chain unavailable";
    elements.budgetStatus.textContent = "$80 budget - chain unavailable";
    elements.targetStatus.textContent = "$1.07 target - chain unavailable";
    elements.targetStatus.classList.remove("alert", "waiting");
  }
}

function renderOptions(payload) {
  const rows = payload.items || [];
  const expiryLabel = payload.expirationChoice === "today" ? "today" : "nearest available";
  elements.optionsMeta.textContent = `${payload.symbol} ${payload.expiration} expiry (${expiryLabel}) - underlying ${money.format(payload.underlyingPrice)} - ${formatDate(new Date(payload.asOf), true)}`;
  elements.optionsSource.textContent = `Underlying: ${payload.quoteSource} - contracts: ${payload.instrumentSource || payload.chainSource} - prices: ${payload.priceSource || payload.chainSource}`;
  updateBudgetStatus(rows);
  updateTargetStatus(rows);
  elements.optionsRows.innerHTML = renderOptionChainRows(rows, payload.underlyingPrice);
}

function renderOptionChainRows(rows, underlyingPrice) {
  const byStrike = new Map();
  for (const row of rows) {
    const strike = Number(row.strike);
    if (!Number.isFinite(strike)) continue;
    const pair = byStrike.get(strike) || { strike, call: null, put: null };
    pair[row.type] = row;
    byStrike.set(strike, pair);
  }

  const pairs = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  if (!pairs.length) return `<tr><td colspan="11">No near ITM contracts found</td></tr>`;
  const atmStrike = pairs.reduce((best, pair) => (
    Math.abs(pair.strike - underlyingPrice) < Math.abs(best.strike - underlyingPrice) ? pair : best
  ), pairs[0]).strike;

  return pairs.map((pair) => {
    const isAtm = pair.strike === atmStrike;
    return `
      ${isAtm ? atmMarkerRow(underlyingPrice) : ""}
      <tr class="${isAtm ? "atmRow" : ""}">
        ${chainSideCells(pair.call, "call")}
        <td class="strikeCell">
          <span>${numberCell(pair.strike)}</span>
          ${isAtm ? `<small>ATM</small>` : ""}
        </td>
        ${chainSideCells(pair.put, "put")}
      </tr>
    `;
  }).join("");
}

function chainSideCells(row, side) {
  if (!row) {
    return `<td class="${side}Cell empty">--</td><td class="${side}Cell empty">--</td><td class="${side}Cell empty">--</td><td class="${side}Cell empty">--</td><td class="${side}Cell empty">--</td>`;
  }
  return `
    <td class="${side}Cell">${priceText(row.bid)}</td>
    <td class="${side}Cell strongPrice">${priceText(row.ask)}</td>
    <td class="${side}Cell">${priceText(row.last)}</td>
    <td class="${side}Cell">${row.delta == null ? "--" : Number(row.delta).toFixed(2)}</td>
    <td class="${side}Cell">${compact.format(row.volume || 0)}</td>
  `;
}

function atmMarkerRow(price) {
  return `
    <tr class="underlyingMarker">
      <td colspan="5"></td>
      <td><span>${money.format(price)}</span></td>
      <td colspan="5"></td>
    </tr>
  `;
}

async function searchSymbols(query) {
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Search unavailable");
    renderSearchResults(payload.results || []);
  } catch {
    elements.searchResults.hidden = true;
  }
}

async function findBestSymbol(query) {
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
    const payload = await response.json();
    const first = response.ok ? payload.results?.[0] : null;
    if (first) return first;
  } catch {
    // Fall back to treating the input as a ticker.
  }
  const symbol = sanitizeSymbol(query);
  return { symbol, name: symbol };
}

function renderSearchResults(results) {
  if (!results.length) {
    elements.searchResults.innerHTML = `<button class="searchResult" type="button"><strong>No matches</strong><span>Try a ticker symbol</span></button>`;
    elements.searchResults.hidden = false;
    return;
  }

  elements.searchResults.innerHTML = results.map((result) => `
    <button class="searchResult" type="button" data-symbol="${escapeHtml(result.symbol)}" data-name="${escapeHtml(result.name)}">
      <strong>${escapeHtml(result.symbol)}</strong>
      <span>${escapeHtml(result.name)}</span>
    </button>
  `).join("");
  elements.searchResults.hidden = false;

  for (const button of elements.searchResults.querySelectorAll("button[data-symbol]")) {
    button.addEventListener("click", () => {
      changeSymbol(button.dataset.symbol, button.dataset.name || button.dataset.symbol);
    });
  }
}

function changeSymbol(symbol, name) {
  state.symbol = sanitizeSymbol(symbol);
  state.instrumentName = name || state.symbol;
  state.candles = [];
  state.quoteCandles = [];
  state.meta = {};
  state.quoteMeta = {};
  state.liveQuote = null;
  state.fittedOnce = false;
  state.lastRenderedPrice = null;
  savePrefs({ symbol: state.symbol, name: state.instrumentName });
  state.candleSeries.setData([]);
  state.volumeSeries.setData([]);
  state.emaSeries.setData([]);
  state.vwapSeries.setData([]);
  state.upperBandSeries.setData([]);
  state.lowerBandSeries.setData([]);
  clearLevelLines();
  for (const series of Object.values(state.maSeries)) {
    series.setData([]);
  }
  elements.ticker.textContent = state.symbol;
  elements.instrumentName.textContent = state.instrumentName;
  elements.symbolInput.value = "";
  elements.searchResults.hidden = true;
  elements.price.textContent = "--";
  elements.change.textContent = "--";
  elements.marketState.textContent = "Loading market data";
  elements.bid.textContent = "--";
  elements.ask.textContent = "--";
  elements.range.textContent = "--";
  elements.volume.textContent = "--";
  elements.optionsRows.innerHTML = `<tr><td colspan="11">Loading</td></tr>`;
  elements.optionsMeta.textContent = "Loading chain";
  document.title = `${state.symbol} Market Dashboard`;
  loadData();
  loadOptions();
}

function updateBudgetStatus(rows) {
  const liveAskRows = rows.filter((row) => row.ask && row.ask > 0);
  const affordable = liveAskRows.filter((row) => row.ask <= maxPremium);
  if (affordable.length) {
    const cheapest = [...affordable].sort((a, b) => a.ask - b.ask)[0];
    elements.budgetStatus.textContent = `$${optionBudget} can buy 1 ${cheapest.strike.toFixed(0)}${cheapest.type === "call" ? "C" : "P"} at ask ${money.format(cheapest.ask)}`;
    return;
  }
  if (liveAskRows.length) {
    const cheapest = [...liveAskRows].sort((a, b) => a.ask - b.ask)[0];
    elements.budgetStatus.textContent = `$${optionBudget} max premium ${money.format(maxPremium)} - cheapest ask ${money.format(cheapest.ask)}`;
    return;
  }
  elements.budgetStatus.textContent = `$${optionBudget} max premium ${money.format(maxPremium)} - waiting for live asks`;
}

function updateTargetStatus(rows) {
  elements.targetStatus.classList.remove("alert", "waiting");
  const liveAskRows = rows.filter((row) => row.ask && row.ask > 0);
  if (liveAskRows.length) {
    const atTarget = liveAskRows
      .filter((row) => row.ask <= alertPremium)
      .sort((a, b) => b.ask - a.ask)[0];
    if (atTarget) {
      elements.targetStatus.textContent = `${contractLabel(atTarget)} is at ${money.format(atTarget.ask)} ask`;
      elements.targetStatus.classList.add("alert");
      document.title = `${contractLabel(atTarget)} ${money.format(atTarget.ask)} - ${state.symbol}`;
      return;
    }
    const closest = [...liveAskRows].sort((a, b) => Math.abs(a.ask - alertPremium) - Math.abs(b.ask - alertPremium))[0];
    elements.targetStatus.textContent = `Closest live ask: ${contractLabel(closest)} at ${money.format(closest.ask)}`;
    elements.targetStatus.classList.add("waiting");
    document.title = `${state.symbol} Market Dashboard`;
    return;
  }

  const lastRows = rows.filter((row) => row.last && row.last > 0);
  if (lastRows.length) {
    const closest = [...lastRows].sort((a, b) => Math.abs(a.last - alertPremium) - Math.abs(b.last - alertPremium))[0];
    elements.targetStatus.textContent = `Closest last: ${contractLabel(closest)} at ${money.format(closest.last)} - waiting for ask`;
    elements.targetStatus.classList.add("waiting");
    document.title = `${state.symbol} Market Dashboard`;
    return;
  }

  elements.targetStatus.textContent = "$1.07 target - waiting for live asks";
  elements.targetStatus.classList.add("waiting");
  document.title = `${state.symbol} Market Dashboard`;
}

function showTradingViewTooltip(param) {
  if (!param?.time || !param.point || !param.seriesData) {
    elements.tooltip.hidden = true;
    return;
  }
  const data = param.seriesData.get(state.candleSeries);
  if (!data) {
    elements.tooltip.hidden = true;
    return;
  }

  elements.tooltip.hidden = false;
  elements.tooltip.innerHTML = `
    <strong>${formatDate(new Date(Number(param.time) * 1000), true)}</strong><br>
    Open ${money.format(data.open)}<br>
    High ${money.format(data.high)}<br>
    Low ${money.format(data.low)}<br>
    Close ${money.format(data.close)}
  `;
  const tipWidth = 176;
  elements.tooltip.style.left = `${Math.min(Math.max(12, param.point.x + 14), elements.chart.clientWidth - tipWidth - 12)}px`;
  elements.tooltip.style.top = `${Math.max(12, param.point.y - 78)}px`;
}

function updateSummary() {
  const selectedLast = state.candles.at(-1);
  const selectedFirst = state.candles.find((candle) => candle.open != null) || state.candles[0];
  const quoteLast = state.quoteCandles.at(-1) || selectedLast;
  const quoteFirst = state.quoteCandles.find((candle) => candle.open != null) || state.quoteCandles[0] || selectedFirst;
  if (!selectedLast || !selectedFirst || !quoteLast || !quoteFirst) return;

  const price = state.liveQuote?.price ?? quoteLast.close;
  const previous = freshestPreviousClose() ?? quoteFirst.open ?? price;
  const change = price - previous;
  const percent = previous ? (change / previous) * 100 : 0;
  const sign = change >= 0 ? "+" : "";

  elements.price.textContent = money.format(price);
  flashPrice(price);
  elements.change.textContent = `${sign}${money.format(change)} (${sign}${percent.toFixed(2)}%)`;
  elements.change.classList.toggle("up", change >= 0);
  elements.change.classList.toggle("down", change < 0);

  const lastDate = state.liveQuote?.asOf ? new Date(state.liveQuote.asOf) : new Date(quoteLast.time * 1000);
  const mode = state.liveQuote?.tradingHalted ? "halted" : (state.liveQuote?.state || state.quoteMeta.marketState || state.meta.marketState || "Market");
  elements.marketState.textContent = `${mode} - ${formatDate(lastDate, true)} - ${labelForFrame(state.timeframe)}`;

  const samples = state.liveQuote?.localSamples ? `${state.liveQuote.localSamples} saved ticks` : "building local tape";
  elements.sourceStatus.textContent = `TradingView chart - Robinhood live every 3s - Yahoo backfill - ${samples}`;

  const visible = state.candles;
  const high = Math.max(...visible.map((candle) => candle.high ?? candle.close));
  const low = Math.min(...visible.map((candle) => candle.low ?? candle.close));
  elements.bid.textContent = state.liveQuote?.bid ? money.format(state.liveQuote.bid) : "--";
  elements.ask.textContent = state.liveQuote?.ask ? money.format(state.liveQuote.ask) : "--";
  elements.range.textContent = `${money.format(low)} - ${money.format(high)}`;
  elements.volume.textContent = compact.format(visible.reduce((sum, candle) => sum + (candle.volume || 0), 0));
}

function freshestPreviousClose() {
  const quoteClose = state.liveQuote?.previousClose;
  const quoteCloseDate = state.liveQuote?.previousCloseDate;
  const metaClose = state.quoteMeta.regularMarketPrice || state.quoteMeta.previousClose;
  if (!quoteClose) return metaClose;
  if (!quoteCloseDate) return quoteClose;

  const today = new Date();
  const previousCloseDate = new Date(`${quoteCloseDate}T12:00:00`);
  const ageInDays = Math.abs(today - previousCloseDate) / 86400000;
  if (ageInDays > 3 && metaClose) return metaClose;
  return quoteClose;
}

function normalizeCandles(candles) {
  const bucketSize = secondsForFrame(state.timeframe);
  const byTime = new Map();
  for (const candle of candles) {
    const close = numberOrNull(candle.close);
    if (!candle.time || close == null) continue;
    const time = candle.time - (candle.time % bucketSize);
    const open = numberOrNull(candle.open) ?? close;
    const high = numberOrNull(candle.high) ?? Math.max(open, close);
    const low = numberOrNull(candle.low) ?? Math.min(open, close);
    byTime.set(time, {
      ...candle,
      time,
      open,
      high,
      low,
      close,
      volume: candle.volume || 0,
    });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function lineData(values) {
  return values.flatMap((value, index) => {
    if (value == null || Number.isNaN(value)) return [];
    return [{ time: state.candles[index].time, value }];
  });
}

function emaSeries(values, period) {
  const multiplier = 2 / (period + 1);
  let previous = null;
  return values.map((value, index) => {
    if (index < period - 1) return null;
    if (previous === null) {
      previous = average(values.slice(index - period + 1, index + 1));
    } else {
      previous = value * multiplier + previous * (1 - multiplier);
    }
    return previous;
  });
}

function bollingerBands(values, period, deviations) {
  return values.map((value, index) => {
    if (index < period - 1) return null;
    const slice = values.slice(index - period + 1, index + 1);
    const mid = average(slice);
    const variance = average(slice.map((item) => (item - mid) ** 2));
    const offset = Math.sqrt(variance) * deviations;
    return { mid, upper: mid + offset, lower: mid - offset };
  });
}

function simpleMovingAverage(values, period) {
  return values.map((value, index) => {
    if (index < period - 1) return null;
    return average(values.slice(index - period + 1, index + 1));
  });
}

function vwapSeries(candles) {
  let runningPv = 0;
  let runningVolume = 0;
  let activeDate = null;

  return candles.map((candle) => {
    const parts = etParts(candle.time);
    const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
    if (dateKey !== activeDate) {
      activeDate = dateKey;
      runningPv = 0;
      runningVolume = 0;
    }

    const volume = Number(candle.volume || 0);
    if (!volume) return runningVolume ? runningPv / runningVolume : null;
    const typical = ((candle.high ?? candle.close) + (candle.low ?? candle.close) + candle.close) / 3;
    runningPv += typical * volume;
    runningVolume += volume;
    return runningPv / runningVolume;
  });
}

function highOf(candles) {
  const values = candles.map((candle) => numberOrNull(candle.high ?? candle.close)).filter((value) => value != null);
  return values.length ? Math.max(...values) : null;
}

function lowOf(candles) {
  const values = candles.map((candle) => numberOrNull(candle.low ?? candle.close)).filter((value) => value != null);
  return values.length ? Math.min(...values) : null;
}

function lastValid(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value != null && !Number.isNaN(value)) return value;
  }
  return null;
}

function sameEtDate(leftTime, rightTime) {
  const left = etParts(leftTime);
  const right = etParts(rightTime);
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function inMinuteRange(epochSeconds, startMinute, endMinute) {
  const parts = etParts(epochSeconds);
  const minute = parts.hour * 60 + parts.minute;
  return minute >= startMinute && minute < endMinute;
}

function etParts(epochSeconds) {
  const parts = Object.fromEntries(etPartsFormatter.formatToParts(new Date(epochSeconds * 1000)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function formatPct(item) {
  if (item?.changePercent == null) return "--";
  const sign = item.changePercent >= 0 ? "+" : "";
  return `${sign}${item.changePercent.toFixed(2)}%`;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function numberOrNull(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number(value);
}

function moneyCell(value) {
  return value == null ? "--" : money.format(value);
}

function priceText(value) {
  return value == null ? "--" : Number(value).toFixed(2);
}

function numberCell(value) {
  return value == null ? "--" : Number(value).toFixed(2);
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function budgetBadge(row) {
  if (!row.ask || row.ask <= 0) return `<span class="budgetBadge wait">WAIT</span>`;
  if (row.ask <= maxPremium) return `<span class="budgetBadge yes">YES</span>`;
  return `<span class="budgetBadge no">NO</span>`;
}

function contractLabel(row) {
  return `${Number(row.strike).toFixed(0)}${row.type === "call" ? "C" : "P"}`;
}

function sanitizeSymbol(value) {
  return String(value || "SPY").toUpperCase().replace(/[^A-Z0-9.\-]/g, "") || "SPY";
}

function setLive(ok, label) {
  if (!elements.liveDot) return;
  elements.liveDot.classList.toggle("ok", ok);
  elements.liveDot.classList.toggle("stale", !ok);
  if (elements.liveLabel) elements.liveLabel.textContent = label;
}

function flashPrice(price) {
  if (price == null || !elements.price) return;
  if (state.lastRenderedPrice != null && price !== state.lastRenderedPrice) {
    const direction = price > state.lastRenderedPrice ? "flashUp" : "flashDown";
    elements.price.classList.remove("flashUp", "flashDown");
    // Force reflow so the animation restarts even on consecutive ticks.
    void elements.price.offsetWidth;
    elements.price.classList.add(direction);
  }
  state.lastRenderedPrice = price;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function secondsForFrame(frame) {
  return {
    "1m": 60,
    "15m": 900,
    "1h": 3600,
    "1d": 86400,
    "1w": 604800,
  }[frame];
}

function labelForFrame(frame) {
  return {
    "1m": "1 minute",
    "15m": "15 minute",
    "1h": "1 hour",
    "1d": "1 day",
    "1w": "1 week",
  }[frame];
}

function formatDate(date, includeTime = false) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: includeTime ? undefined : "numeric",
    hour: includeTime ? "numeric" : undefined,
    minute: includeTime ? "2-digit" : undefined,
  }).format(date);
}
