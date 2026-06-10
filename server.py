from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote as url_quote, urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen
import json
import os
import re
from datetime import date, datetime, time, timedelta, timezone
from threading import Lock
from time import monotonic
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


ROOT = Path(__file__).resolve().parent


# Short-lived response cache so the frequent strip/options pollers do not
# hammer the upstream data providers. Keyed by endpoint, values expire by TTL.
_RESPONSE_CACHE = {}
_CACHE_LOCK = Lock()


def cached(key, ttl, producer):
    now = monotonic()
    with _CACHE_LOCK:
        entry = _RESPONSE_CACHE.get(key)
        if entry and now - entry[0] < ttl:
            return entry[1]
    value = producer()
    with _CACHE_LOCK:
        _RESPONSE_CACHE[key] = (now, value)
    return value


def load_local_env(path):
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_local_env(ROOT / ".env")

HOST = os.getenv("DASHBOARD_HOST", "127.0.0.1")
PORT = int(os.getenv("DASHBOARD_PORT", os.getenv("PORT", "8765")))
DEFAULT_SYMBOL = os.getenv("DASHBOARD_DEFAULT_SYMBOL", "SPY").strip().upper() or "SPY"
DEFAULT_NAME = os.getenv("DASHBOARD_DEFAULT_NAME", "SPDR S&P 500 ETF").strip() or DEFAULT_SYMBOL
OPTION_BUDGET = float(os.getenv("DASHBOARD_OPTION_BUDGET", "60"))
OPTION_TARGET_PREMIUM = float(os.getenv("DASHBOARD_OPTION_TARGET_PREMIUM", "0.75"))
HISTORY_FILE = Path(os.getenv("DASHBOARD_HISTORY_FILE", str(ROOT / "robinhood-history.json")))
if not HISTORY_FILE.is_absolute():
    HISTORY_FILE = ROOT / HISTORY_FILE
HISTORY_LIMIT = int(os.getenv("DASHBOARD_HISTORY_LIMIT", "50000"))
HISTORY_LOCK = Lock()
MARKET_STRIP = os.getenv("DASHBOARD_MARKET_STRIP", "SPY:SPY,QQQ:QQQ,IWM:IWM,DIA:DIA,VIX:^VIX")
MAG7_STRIP = os.getenv("DASHBOARD_MAG7_STRIP", "AAPL:AAPL,MSFT:MSFT,NVDA:NVDA,AMZN:AMZN,META:META,GOOGL:GOOGL,TSLA:TSLA")
REFERRAL_LINKS = os.getenv("DASHBOARD_REFERRAL_LINKS", "")
STRIP_CACHE_TTL = float(os.getenv("DASHBOARD_STRIP_CACHE_TTL", "8"))
OPTIONS_CACHE_TTL = float(os.getenv("DASHBOARD_OPTIONS_CACHE_TTL", "20"))
try:
    MARKET_TZ = ZoneInfo("America/New_York")
except ZoneInfoNotFoundError as exc:
    raise SystemExit(
        "Time zone database not found. On Windows install it with:\n"
        "    pip install tzdata\n"
        "(already listed in requirements.txt)."
    ) from exc

TIMEFRAMES = {
    "1m": {"range": "1d", "interval": "1m", "includePrePost": "true"},
    "15m": {"range": "5d", "interval": "15m", "includePrePost": "true"},
    "1h": {"range": "1mo", "interval": "60m", "includePrePost": "true"},
    "1d": {"range": "1y", "interval": "1d", "includePrePost": "false"},
    "1w": {"range": "5y", "interval": "1wk", "includePrePost": "false"},
}

BUCKET_SECONDS = {
    "1m": 60,
    "15m": 900,
    "1h": 3600,
    "1d": 86400,
    "1w": 604800,
}

ROBINHOOD_HISTORY = {}


def parse_market_strip(value):
    items = []
    for raw_item in str(value or "").split(","):
        raw_item = raw_item.strip()
        if not raw_item:
            continue
        if ":" in raw_item:
            label, symbol = raw_item.split(":", 1)
        else:
            label = symbol = raw_item
        label = label.strip().upper()
        symbol = symbol.strip().upper()
        if label and symbol:
            items.append((label, symbol))
    return items or [("SPY", "SPY"), ("QQQ", "QQQ"), ("IWM", "IWM"), ("DIA", "DIA"), ("VIX", "^VIX")]


def parse_referral_links(value):
    links = []
    for raw_item in str(value or "").split(";"):
        raw_item = raw_item.strip()
        if not raw_item or "|" not in raw_item:
            continue
        label, url = raw_item.split("|", 1)
        label = label.strip()
        url = url.strip()
        if label and url.startswith(("https://", "http://")):
            links.append({"label": label, "url": url})
    return links


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.handle_health()
            return
        if parsed.path == "/api/spy":
            self.handle_chart(parsed)
            return
        if parsed.path == "/api/quote":
            self.handle_quote(parsed)
            return
        if parsed.path == "/api/options":
            self.handle_options(parsed)
            return
        if parsed.path == "/api/search":
            self.handle_search(parsed)
            return
        if parsed.path == "/api/market-strip":
            self.handle_market_strip()
            return
        if parsed.path == "/api/mag7-strip":
            self.handle_mag7_strip()
            return
        if parsed.path == "/api/config":
            self.handle_config()
            return
        if parsed.path == "/api/market-clock":
            self.handle_market_clock()
            return
        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def handle_chart(self, parsed):
        params = parse_qs(parsed.query)
        symbol = sanitize_symbol(params.get("symbol", [DEFAULT_SYMBOL])[0])
        timeframe = params.get("timeframe", ["1m"])[0]
        if timeframe not in TIMEFRAMES:
            self.send_json({"error": "Unsupported timeframe"}, 400)
            return

        config = TIMEFRAMES[timeframe]
        query = "&".join(f"{key}={value}" for key, value in config.items())
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{url_quote(symbol)}?{query}"
        request = Request(url, headers={"User-Agent": "Mozilla/5.0"})

        try:
            with urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            self.send_json({"error": f"Could not fetch market data: {exc}"}, 502)
            return

        try:
            result = payload["chart"]["result"][0]
            quote = result["indicators"]["quote"][0]
            timestamps = result.get("timestamp", [])
            candles = []
            for index, timestamp in enumerate(timestamps):
                close = value_at(quote.get("close", []), index)
                if close is None:
                    continue
                candles.append(
                    {
                        "time": timestamp,
                        "open": value_at(quote.get("open", []), index),
                        "high": value_at(quote.get("high", []), index),
                        "low": value_at(quote.get("low", []), index),
                        "close": close,
                        "volume": value_at(quote.get("volume", []), index),
                    }
                )
            self.send_json(
                    {
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "sources": {
                        "quote": "Robinhood",
                        "history": "Yahoo Finance backfill + local Robinhood quotes",
                    },
                    "liveQuote": record_robinhood_quote(symbol),
                    "robinhoodSamples": len(ROBINHOOD_HISTORY.get(symbol, [])),
                    "meta": result.get("meta", {}),
                    "candles": merge_robinhood_history(symbol, candles, timeframe),
                }
            )
        except Exception as exc:
            self.send_json({"error": f"Unexpected data shape: {exc}"}, 502)

    def handle_quote(self, parsed):
        try:
            params = parse_qs(parsed.query)
            symbol = sanitize_symbol(params.get("symbol", [DEFAULT_SYMBOL])[0])
            self.send_json(record_robinhood_quote(symbol))
        except Exception as exc:
            self.send_json({"error": f"Could not fetch Robinhood quote: {exc}"}, 502)

    def handle_options(self, parsed):
        try:
            params = parse_qs(parsed.query)
            symbol = sanitize_symbol(params.get("symbol", [DEFAULT_SYMBOL])[0])
            # Cboe/Yahoo option data is delayed anyway, so a short cache keeps the
            # heavy three-provider fan-out from running on every 30s client poll.
            self.send_json(cached(f"options:{symbol}", OPTIONS_CACHE_TTL, lambda: build_options_payload(symbol)))
        except Exception as exc:
            self.send_json({"error": f"Could not fetch options chain: {exc}"}, 502)

    def handle_search(self, parsed):
        try:
            params = parse_qs(parsed.query)
            query = params.get("q", [""])[0].strip()
            if len(query) < 1:
                self.send_json({"results": []})
                return
            self.send_json({"results": search_robinhood_instruments(query)})
        except Exception as exc:
            self.send_json({"error": f"Could not search symbols: {exc}"}, 502)

    def handle_market_strip(self):
        items = cached("market-strip", STRIP_CACHE_TTL, lambda: build_quote_strip(parse_market_strip(MARKET_STRIP)))
        self.send_json({"items": items, "asOf": datetime.now(timezone.utc).isoformat()})

    def handle_mag7_strip(self):
        items = cached("mag7-strip", STRIP_CACHE_TTL, lambda: build_quote_strip(parse_market_strip(MAG7_STRIP)))
        self.send_json({"items": items, "asOf": datetime.now(timezone.utc).isoformat()})

    def handle_health(self):
        self.send_json(
            {
                "status": "ok",
                "defaultSymbol": sanitize_symbol(DEFAULT_SYMBOL),
                "time": datetime.now(timezone.utc).isoformat(),
                "trackedSymbols": sorted(ROBINHOOD_HISTORY.keys()),
                "cachedKeys": sorted(_RESPONSE_CACHE.keys()),
            }
        )

    def handle_config(self):
        self.send_json(
            {
                "defaultSymbol": sanitize_symbol(DEFAULT_SYMBOL),
                "defaultName": DEFAULT_NAME,
                "optionBudget": OPTION_BUDGET,
                "optionTargetPremium": OPTION_TARGET_PREMIUM,
                "marketStrip": [{"label": label, "symbol": symbol} for label, symbol in parse_market_strip(MARKET_STRIP)],
                "mag7Strip": [{"label": label, "symbol": symbol} for label, symbol in parse_market_strip(MAG7_STRIP)],
                "referralLinks": parse_referral_links(REFERRAL_LINKS),
                "sources": {
                    "quotes": "Robinhood public quote endpoints",
                    "history": "Yahoo Finance backfill + local Robinhood quote history",
                    "options": "Robinhood public option instruments + Cboe delayed prices/Yahoo fallback",
                },
            }
        )

    def handle_market_clock(self):
        self.send_json(build_market_clock())

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def value_at(values, index):
    if index >= len(values):
        return None
    value = values[index]
    if value is None:
        return None
    return round(value, 6) if isinstance(value, float) else value


def build_quote_strip(symbols):
    items = []
    for label, symbol in symbols:
        try:
            if symbol.startswith("^"):
                item = fetch_yahoo_market_snapshot(label, symbol)
                item["quoteSymbol"] = symbol
                items.append(item)
            else:
                quote = record_robinhood_quote(symbol)
                price = quote.get("price")
                previous = quote.get("previousClose")
                items.append(
                    {
                        "symbol": label,
                        "quoteSymbol": symbol,
                        "price": price,
                        "bid": quote.get("bid"),
                        "ask": quote.get("ask"),
                        "change": round(price - previous, 4) if price is not None and previous is not None else None,
                        "changePercent": round((price - previous) / previous * 100, 4) if price is not None and previous else None,
                        "source": quote.get("source"),
                        "asOf": quote.get("asOf") or quote.get("fetchedAt"),
                    }
                )
        except Exception as exc:
            items.append({"symbol": label, "quoteSymbol": symbol, "error": str(exc)})
    return items


def build_market_clock():
    now = datetime.now(MARKET_TZ)
    session = trading_session_for(now)
    next_event = next_market_event(now, session)
    return {
        "now": now.isoformat(),
        "nowEpochMs": int(now.timestamp() * 1000),
        "timezone": "America/New_York",
        "isOpen": session["status"] in ("premarket", "regular", "afterHours"),
        "status": session["status"],
        "label": session["label"],
        "detail": session["detail"],
        "nextEventLabel": next_event["label"],
        "nextEvent": next_event["time"].isoformat(),
        "nextEventEpochMs": int(next_event["time"].timestamp() * 1000),
    }


def trading_session_for(now):
    schedule = market_schedule(now.date())
    if not schedule:
        return {"status": "closed", "label": "Market closed", "detail": "No regular session today"}

    premarket = datetime.combine(now.date(), time(4, 0), tzinfo=MARKET_TZ)
    open_time = schedule["open"]
    close_time = schedule["close"]
    after_close = datetime.combine(now.date(), time(20, 0), tzinfo=MARKET_TZ)

    if premarket <= now < open_time:
        return {"status": "premarket", "label": "Premarket", "detail": f"Regular open {format_market_time(open_time)}"}
    if open_time <= now < close_time:
        return {"status": "regular", "label": "Market open", "detail": f"Closes {format_market_time(close_time)}"}
    if close_time <= now < after_close:
        return {"status": "afterHours", "label": "After-hours", "detail": "Regular market closed"}
    return {"status": "closed", "label": "Market closed", "detail": "Waiting for next session"}


def next_market_event(now, session):
    today_schedule = market_schedule(now.date())
    if today_schedule:
        open_time = today_schedule["open"]
        close_time = today_schedule["close"]
        after_close = datetime.combine(now.date(), time(20, 0), tzinfo=MARKET_TZ)
        if now < open_time:
            return {"label": "Open", "time": open_time}
        if open_time <= now < close_time:
            return {"label": "Close", "time": close_time}
        if close_time <= now < after_close:
            return {"label": "After-hours close", "time": after_close}

    next_day = now.date() + timedelta(days=1)
    while True:
        schedule = market_schedule(next_day)
        if schedule:
            return {"label": "Open", "time": schedule["open"]}
        next_day += timedelta(days=1)


def market_schedule(day):
    if day.weekday() >= 5 or day in nyse_holidays(day.year):
        return None
    close_hour = 13 if day in nyse_half_days(day.year) else 16
    return {
        "open": datetime.combine(day, time(9, 30), tzinfo=MARKET_TZ),
        "close": datetime.combine(day, time(close_hour, 0), tzinfo=MARKET_TZ),
    }


def nyse_holidays(year):
    holidays = {
        observed(date(year, 1, 1)),
        observed(date(year + 1, 1, 1)),
        third_monday(year, 1),
        third_monday(year, 2),
        good_friday(year),
        last_monday(year, 5),
        observed(date(year, 6, 19)),
        observed(date(year, 7, 4)),
        first_monday(year, 9),
        fourth_thursday(year, 11),
        observed(date(year, 12, 25)),
    }
    return {holiday for holiday in holidays if holiday.year == year}


def nyse_half_days(year):
    days = set()
    day_after_thanksgiving = fourth_thursday(year, 11) + timedelta(days=1)
    if day_after_thanksgiving.weekday() < 5:
        days.add(day_after_thanksgiving)
    christmas_eve = date(year, 12, 24)
    if christmas_eve.weekday() < 5 and christmas_eve not in nyse_holidays(year):
        days.add(christmas_eve)
    july_third = date(year, 7, 3)
    if july_third.weekday() < 5 and date(year, 7, 4).weekday() == 5:
        days.add(july_third)
    return days


def observed(day):
    if day.weekday() == 5:
        return day - timedelta(days=1)
    if day.weekday() == 6:
        return day + timedelta(days=1)
    return day


def first_monday(year, month):
    day = date(year, month, 1)
    return day + timedelta(days=(7 - day.weekday()) % 7)


def third_monday(year, month):
    return first_monday(year, month) + timedelta(days=14)


def fourth_thursday(year, month):
    day = date(year, month, 1)
    offset = (3 - day.weekday()) % 7
    return day + timedelta(days=offset + 21)


def last_monday(year, month):
    day = date(year, month + 1, 1) - timedelta(days=1)
    return day - timedelta(days=(day.weekday() - 0) % 7)


def good_friday(year):
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day) - timedelta(days=2)


def format_market_time(value):
    return value.strftime("%I:%M %p ET").lstrip("0")


def fetch_robinhood_quote(symbol):
    url = f"https://api.robinhood.com/quotes/{url_quote(symbol)}/"
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=10) as response:
        quote = json.loads(response.read().decode("utf-8"))

    regular = parse_price(quote.get("last_trade_price"))
    extended = parse_price(quote.get("last_extended_hours_trade_price") or quote.get("last_non_reg_trade_price"))
    regular_time = quote.get("venue_last_trade_time") or quote.get("last_trade_time") or quote.get("updated_at")
    extended_time = (
        quote.get("last_extended_hours_trade_time")
        or quote.get("venue_last_non_reg_trade_time")
        or quote.get("last_non_reg_trade_time")
    )
    current_price, current_time = choose_latest_price(
        (regular, regular_time),
        (extended, extended_time),
    )

    return {
        "symbol": symbol,
        "source": "Robinhood",
        "price": current_price,
        "regularPrice": regular,
        "extendedPrice": extended,
        "bid": parse_price(quote.get("bid_price")),
        "ask": parse_price(quote.get("ask_price")),
        "bidSize": quote.get("bid_size"),
        "askSize": quote.get("ask_size"),
        "previousClose": parse_price(quote.get("adjusted_previous_close") or quote.get("previous_close")),
        "previousCloseDate": quote.get("previous_close_date"),
        "state": quote.get("state"),
        "tradingHalted": quote.get("trading_halted"),
        "asOf": current_time,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }


def fetch_yahoo_market_snapshot(symbol, yahoo_symbol):
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{url_quote(yahoo_symbol)}?range=1d&interval=1m&includePrePost=true"
    )
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))

    result = payload["chart"]["result"][0]
    meta = result.get("meta", {})
    quote = result["indicators"]["quote"][0]
    closes = [value for value in quote.get("close", []) if value is not None]
    price = round(float(closes[-1]), 4) if closes else parse_price(meta.get("regularMarketPrice"))
    previous = parse_price(meta.get("previousClose") or meta.get("chartPreviousClose"))
    return {
        "symbol": symbol,
        "price": price,
        "bid": None,
        "ask": None,
        "change": round(price - previous, 4) if price is not None and previous is not None else None,
        "changePercent": round((price - previous) / previous * 100, 4) if price is not None and previous else None,
        "source": "Yahoo Finance",
        "asOf": datetime.now(timezone.utc).isoformat(),
    }


def record_robinhood_quote(symbol):
    quote = fetch_robinhood_quote(symbol)
    sample = {
        "time": quote.get("fetchedAt"),
        "venueTime": quote.get("asOf"),
        "fetchedAt": quote.get("fetchedAt"),
        "price": quote.get("price"),
        "bid": quote.get("bid"),
        "ask": quote.get("ask"),
    }
    if sample["price"] is not None:
        with HISTORY_LOCK:
            history = ROBINHOOD_HISTORY.setdefault(symbol, [])
            if not history or history[-1].get("fetchedAt") != sample["fetchedAt"]:
                history.append(sample)
                del history[:-HISTORY_LIMIT]
                save_history()
    quote["localSamples"] = len(ROBINHOOD_HISTORY.get(symbol, []))
    return quote


def merge_robinhood_history(symbol, candles, timeframe):
    robinhood_candles = aggregate_robinhood_history(symbol, timeframe)
    if not robinhood_candles:
        return candles

    bucket_size = BUCKET_SECONDS[timeframe]
    merged = {bucket_for(candle["time"], bucket_size): {**candle, "time": bucket_for(candle["time"], bucket_size)} for candle in candles}
    for candle in robinhood_candles:
        key = bucket_for(candle["time"], bucket_size)
        existing = merged.get(key)
        if existing:
            merged[key] = {
                **existing,
                "time": key,
                "high": max(existing.get("high") or candle["high"], candle["high"]),
                "low": min(existing.get("low") or candle["low"], candle["low"]),
                "close": candle["close"],
                "source": "Robinhood",
            }
        else:
            merged[key] = candle
    return [merged[key] for key in sorted(merged)]


def aggregate_robinhood_history(symbol, timeframe):
    bucket_size = BUCKET_SECONDS[timeframe]
    buckets = {}
    with HISTORY_LOCK:
        samples = list(ROBINHOOD_HISTORY.get(symbol, []))

    for sample in samples:
        price = sample.get("price")
        timestamp = iso_to_epoch(sample.get("time") or sample.get("fetchedAt"))
        if price is None or timestamp is None:
            continue
        bucket = bucket_for(timestamp, bucket_size)
        candle = buckets.setdefault(
            bucket,
            {
                "time": bucket,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "volume": 0,
                "source": "Robinhood",
            },
        )
        candle["high"] = max(candle["high"], price)
        candle["low"] = min(candle["low"], price)
        candle["close"] = price
    return [buckets[key] for key in sorted(buckets)]


def bucket_for(timestamp, bucket_size):
    return timestamp - (timestamp % bucket_size)


def iso_to_epoch(value):
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        return int(datetime.fromisoformat(normalized).timestamp())
    except ValueError:
        return None


def choose_latest_price(*candidates):
    available = []
    for price, timestamp in candidates:
        if price is None:
            continue
        available.append((iso_to_epoch(timestamp) or 0, price, timestamp))
    if not available:
        return None, None
    _, price, timestamp = max(available, key=lambda item: item[0])
    return price, timestamp


def load_history():
    if not HISTORY_FILE.exists():
        return []
    try:
        payload = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        if isinstance(payload, list):
            return {sanitize_symbol(DEFAULT_SYMBOL): payload[-HISTORY_LIMIT:]}
        if isinstance(payload, dict):
            return {sanitize_symbol(symbol): rows[-HISTORY_LIMIT:] for symbol, rows in payload.items() if isinstance(rows, list)}
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def save_history():
    HISTORY_FILE.write_text(json.dumps(ROBINHOOD_HISTORY), encoding="utf-8")


def parse_price(value):
    if value in (None, ""):
        return None
    try:
        return round(float(value), 6)
    except (TypeError, ValueError):
        return None


def today_expiration_epoch():
    today = datetime.now().date()
    return int(datetime.combine(today, time.min, tzinfo=timezone.utc).timestamp())


def build_options_payload(symbol):
    quote = record_robinhood_quote(symbol)
    chain = fetch_yahoo_options(symbol, today_expiration_epoch())
    robinhood_chain = fetch_robinhood_options(symbol, chain.get("expiration"))
    cboe_prices = fetch_cboe_option_prices(symbol, chain.get("expiration"))
    rows = near_itm_options(chain, quote.get("price"))
    rows = merge_robinhood_option_instruments(rows, robinhood_chain)
    rows = merge_cboe_option_prices(rows, cboe_prices)
    return {
        "symbol": symbol,
        "expiration": chain.get("expiration"),
        "expirationChoice": chain.get("expirationChoice"),
        "underlyingPrice": quote.get("price"),
        "quoteSource": "Robinhood",
        "chainSource": "Robinhood instruments + Cboe delayed prices",
        "instrumentSource": "Robinhood",
        "priceSource": "Cboe delayed quotes, Yahoo fallback",
        "asOf": datetime.now(timezone.utc).isoformat(),
        "items": rows,
    }


def fetch_yahoo_options(symbol, preferred_expiration_epoch):
    opener = build_opener(HTTPCookieProcessor())
    headers = {"User-Agent": "Mozilla/5.0"}

    try:
        opener.open(Request("https://fc.yahoo.com", headers=headers), timeout=10)
    except Exception:
        pass
    with opener.open(Request("https://query1.finance.yahoo.com/v1/test/getcrumb", headers=headers), timeout=10) as response:
        crumb = response.read().decode("utf-8").strip()

    base_url = f"https://query1.finance.yahoo.com/v7/finance/options/{url_quote(symbol)}"
    url = f"{base_url}?crumb={crumb}"
    with opener.open(Request(url, headers=headers), timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))

    result = payload["optionChain"]["result"][0]
    expiration_dates = result.get("expirationDates", [])
    if not expiration_dates:
        raise ValueError(f"No options expirations found for {symbol}")

    expiration_epoch = choose_expiration(expiration_dates, preferred_expiration_epoch)
    current_options = result.get("options", [])
    current_expiration = current_options[0].get("expirationDate") if current_options else None
    if current_expiration != expiration_epoch:
        url = f"{base_url}?date={expiration_epoch}&crumb={crumb}"
        with opener.open(Request(url, headers=headers), timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
        result = payload["optionChain"]["result"][0]

    option_block = result["options"][0]
    expiration = datetime.fromtimestamp(option_block["expirationDate"], timezone.utc).date().isoformat()
    return {
        "expiration": expiration,
        "expirationChoice": "today" if expiration_epoch == preferred_expiration_epoch else "nearest_available",
        "expirationEpoch": expiration_epoch,
        "calls": option_block.get("calls", []),
        "puts": option_block.get("puts", []),
    }


def choose_expiration(expiration_dates, preferred_epoch):
    if preferred_epoch in expiration_dates:
        return preferred_epoch
    future_dates = [epoch for epoch in expiration_dates if epoch >= preferred_epoch]
    if future_dates:
        return min(future_dates)
    return max(expiration_dates)


def near_itm_options(chain, underlying_price):
    if underlying_price is None:
        underlying_price = 0

    calls = {
        parse_price(contract.get("strike")): normalize_option(contract, "call", underlying_price)
        for contract in chain.get("calls", [])
        if parse_price(contract.get("strike")) is not None
    }
    puts = {
        parse_price(contract.get("strike")): normalize_option(contract, "put", underlying_price)
        for contract in chain.get("puts", [])
        if parse_price(contract.get("strike")) is not None
    }

    strikes = sorted(set(calls) | set(puts), key=lambda strike: (abs(strike - underlying_price), strike))[:10]
    rows = []
    for strike in sorted(strikes):
        if strike in calls:
            rows.append(calls[strike])
        if strike in puts:
            rows.append(puts[strike])
    return rows


def normalize_option(contract, option_type, underlying_price):
    strike = parse_price(contract.get("strike"))
    last = parse_price(contract.get("lastPrice"))
    bid = parse_price(contract.get("bid"))
    ask = parse_price(contract.get("ask"))
    iv = parse_price(contract.get("impliedVolatility"))
    last_trade = contract.get("lastTradeDate")
    return {
        "type": option_type,
        "contract": contract.get("contractSymbol"),
        "strike": strike,
        "distance": round(abs((strike or 0) - underlying_price), 4),
        "last": last,
        "bid": bid,
        "ask": ask,
        "mid": round((bid + ask) / 2, 4) if bid is not None and ask is not None and (bid or ask) else None,
        "volume": contract.get("volume") or 0,
        "openInterest": contract.get("openInterest") or 0,
        "iv": round(iv * 100, 2) if iv is not None else None,
        "lastTradeTime": datetime.fromtimestamp(last_trade, timezone.utc).isoformat() if last_trade else None,
        "inTheMoney": contract.get("inTheMoney"),
    }


def fetch_robinhood_options(symbol, expiration):
    if not expiration:
        return {}
    url = (
        "https://api.robinhood.com/options/instruments/"
        f"?chain_symbol={url_quote(symbol)}&expiration_dates={url_quote(expiration)}&state=active"
    )
    results = []
    while url:
        request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
        results.extend(payload.get("results", []))
        url = payload.get("next")

    instruments = {}
    for item in results:
        strike = parse_price(item.get("strike_price"))
        option_type = item.get("type")
        if strike is None or option_type not in ("call", "put"):
            continue
        instruments[(option_type, round(strike, 4))] = {
            "optionId": item.get("id"),
            "instrumentUrl": item.get("url"),
            "rhsTradability": item.get("rhs_tradability"),
            "tradability": item.get("tradability"),
            "longStrategyCode": item.get("long_strategy_code"),
            "shortStrategyCode": item.get("short_strategy_code"),
            "source": "Robinhood",
        }
    return instruments


def merge_robinhood_option_instruments(rows, instruments):
    for row in rows:
        key = (row.get("type"), round(row.get("strike") or 0, 4))
        instrument = instruments.get(key)
        if instrument:
            row.update(instrument)
            row["instrumentSource"] = "Robinhood"
        else:
            row["instrumentSource"] = "Unavailable"
    return rows


def fetch_cboe_option_prices(symbol, expiration):
    if not expiration:
        return {}
    url = f"https://cdn.cboe.com/api/global/delayed_quotes/options/{url_quote(symbol)}.json"
    request = Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return {}

    prices = {}
    for item in payload.get("data", {}).get("options", []):
        option_symbol = item.get("option")
        if not option_symbol:
            continue
        parsed = parse_occ_symbol(option_symbol)
        if not parsed or parsed["expiration"] != expiration:
            continue
        prices[(parsed["type"], round(parsed["strike"], 4))] = {
            "contract": option_symbol,
            "last": parse_price(item.get("last_trade_price")),
            "bid": parse_price(item.get("bid")),
            "ask": parse_price(item.get("ask")),
            "mid": mid_price(parse_price(item.get("bid")), parse_price(item.get("ask"))),
            "volume": int(item.get("volume") or 0),
            "openInterest": int(item.get("open_interest") or 0),
            "iv": round(float(item.get("iv")) * 100, 2) if item.get("iv") is not None else None,
            "delta": round(float(item.get("delta")), 4) if item.get("delta") is not None else None,
            "gamma": round(float(item.get("gamma")), 4) if item.get("gamma") is not None else None,
            "theta": round(float(item.get("theta")), 4) if item.get("theta") is not None else None,
            "vega": round(float(item.get("vega")), 4) if item.get("vega") is not None else None,
            "priceSource": "Cboe delayed",
            "lastTradeTime": item.get("last_trade_time"),
        }
    return prices


def merge_cboe_option_prices(rows, prices):
    for row in rows:
        key = (row.get("type"), round(row.get("strike") or 0, 4))
        price = prices.get(key)
        if price:
            row.update(price)
        else:
            row["priceSource"] = "Yahoo Finance fallback"
    return rows


def parse_occ_symbol(option_symbol):
    match = re.match(r"^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$", option_symbol)
    if not match:
        return None
    _, year, month, day, option_type, strike_raw = match.groups()
    expiration = f"20{year}-{month}-{day}"
    return {
        "expiration": expiration,
        "type": "call" if option_type == "C" else "put",
        "strike": int(strike_raw) / 1000,
    }


def mid_price(bid, ask):
    if bid is None or ask is None or not (bid or ask):
        return None
    return round((bid + ask) / 2, 4)


def search_robinhood_instruments(query):
    url = f"https://api.robinhood.com/instruments/?query={url_quote(query)}"
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(request, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    results = []
    for item in payload.get("results", [])[:8]:
        symbol = item.get("symbol")
        if not symbol or item.get("state") != "active":
            continue
        results.append(
            {
                "symbol": sanitize_symbol(symbol),
                "name": item.get("simple_name") or item.get("name") or symbol,
                "type": item.get("type") or "",
                "tradability": item.get("tradability") or "",
            }
        )
    return results


def sanitize_symbol(value):
    symbol = str(value or "SPY").strip().upper()
    symbol = re.sub(r"[^A-Z0-9.\-]", "", symbol)
    return symbol or "SPY"


ROBINHOOD_HISTORY.update(load_history())


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Market dashboard running at http://{HOST}:{PORT}")
    server.serve_forever()
