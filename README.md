# Market Options Dashboard

Local dashboard for watching SPY or another ticker with near real-time quotes, candles, Bollinger Bands, EMA 21, optional MA 20/40/100/200, a market strip, and a near-the-money options table.

## Improvements In This Build

This copy adds quality-of-life and robustness changes over the base dashboard:

- **Remembers your view** - last ticker, timeframe, and moving-average toggles persist in `localStorage`.
- **Live status indicator** - a pulsing dot by the price shows whether the 3s quote poll is healthy, reconnecting, or paused.
- **Price flash** - the headline price briefly flashes green/red on each tick (respects `prefers-reduced-motion`).
- **Keyboard shortcuts** - press `1`-`5` to switch timeframe (1m / 15m / 1h / 1d / 1w).
- **Pauses when hidden** - polling stops while the browser tab is in the background and refreshes instantly on return, saving requests.
- **Server-side cache** - the strip and options endpoints are cached briefly (`DASHBOARD_STRIP_CACHE_TTL`, `DASHBOARD_OPTIONS_CACHE_TTL`) so many open tabs don't hammer the upstream providers.
- **`/api/health`** - a JSON health/status endpoint for monitoring.
- **Cross-platform timezone** - `tzdata` is declared in `requirements.txt`, and a missing tz database now fails with a clear install hint instead of a stack trace.
- **Docker port fix** - the image no longer hardcodes the port, so platforms that inject `$PORT` work out of the box.
- A favicon is included (no more 404 in the network log).

## Start The App

On Windows, double-click `start.bat`.

Or run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

Then open:

```text
http://127.0.0.1:8765/
```

## Configure It

Copy `.env.example` to `.env`, then edit the values.

Useful settings:

```text
DASHBOARD_DEFAULT_SYMBOL=SPY
DASHBOARD_OPTION_BUDGET=80
DASHBOARD_OPTION_TARGET_PREMIUM=1.07
DASHBOARD_MARKET_STRIP=SPY:SPY,QQQ:QQQ,IWM:IWM,DIA:DIA,VIX:^VIX
DASHBOARD_MAG7_STRIP=AAPL:AAPL,MSFT:MSFT,NVDA:NVDA,AMZN:AMZN,META:META,GOOGL:GOOGL,TSLA:TSLA
DASHBOARD_REFERRAL_LINKS=Robinhood|https://your-link;Chase|https://your-link;Charles Schwab|https://your-link
```

The `.env` file is ignored by Git, so each user can keep their own settings.

Referral links are optional. If you use them in production, label them clearly as referral or affiliate links and follow the terms for each broker or bank.

## Data Sources

This app does not include any personal Robinhood login, account number, token, or private connection.

Current sources:

- Stock/ETF quote and search: Robinhood public endpoints.
- Option contract instruments: Robinhood public option instrument endpoint.
- Option bid/ask/Greeks: Cboe delayed quotes, with Yahoo fallback when needed.
- Historical candles: Yahoo Finance backfill plus local Robinhood quote samples recorded while the app is running.
- VIX: Yahoo Finance, because the Robinhood public stock quote endpoint does not expose `^VIX`.

For authenticated Robinhood account data, each user must configure their own secure connection outside this GitHub repo. Do not commit tokens, cookies, account numbers, or `.env` files.

## GitHub Notes

Before publishing, check:

```powershell
git status
```

The local `robinhood-history.json` file is intentionally ignored because it can get large and belongs to the local machine.

## Repository Contents

Tracked files include:

- `index.html`, `styles.css`, `app.js`: dashboard frontend.
- `server.py`: local API server and data-source adapter.
- `start.bat`, `start.ps1`: Windows launchers.
- `.env.example`: user configuration template.
- `requirements.txt`: declares `tzdata` (the app's own code is otherwise standard-library only).
- `Dockerfile`, `.dockerignore`, `render.yaml`, `DEPLOYMENT.md`: production/deployment helpers.
- `.github/workflows/smoke-test.yml`: basic GitHub Actions check.

Ignored local files:

- `.env`: private user settings.
- `robinhood-history.json`: local quote history collected while the app runs.
- `__pycache__/` and logs.
