# Deployment

This app is a small Python HTTP server plus static frontend files.

## Local

On Windows, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

Then open:

```text
http://127.0.0.1:8765/
```

## Environment Variables

Use `.env` locally or platform environment variables in production.

Important variables:

```text
DASHBOARD_HOST=0.0.0.0
PORT=8765
DASHBOARD_DEFAULT_SYMBOL=SPY
DASHBOARD_OPTION_BUDGET=60
DASHBOARD_OPTION_TARGET_PREMIUM=0.75
DASHBOARD_MARKET_STRIP=SPY:SPY,QQQ:QQQ,IWM:IWM,DIA:DIA,VIX:^VIX
DASHBOARD_MAG7_STRIP=AAPL:AAPL,MSFT:MSFT,NVDA:NVDA,AMZN:AMZN,META:META,GOOGL:GOOGL,TSLA:TSLA
```

Do not commit `.env`, tokens, cookies, account numbers, or `robinhood-history.json`.

## Docker

Build:

```powershell
docker build -t spy-dashboard .
```

Run:

```powershell
docker run --rm -p 8765:8765 spy-dashboard
```

## Render

This repository includes `render.yaml`. Create a new Render Blueprint from the GitHub repository, then set any production environment variables you need.

