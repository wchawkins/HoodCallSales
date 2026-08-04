# HOOD Covered Call Screener

A lightweight static dashboard (for GitHub Pages) that screens candidate
covered-call strikes/expirations for HOOD, ranked by annualized premium yield
within a target delta band. Not financial advice — see the disclaimer on the
page itself.

## How it works

- `scripts/fetch_and_score.py` pulls the HOOD spot price and call option chain
  from Yahoo Finance (via `yfinance`, no API key needed), estimates each
  contract's delta from its implied volatility (Black-Scholes, no dividend
  yield), computes annualized premium yield, and writes the result to
  `data/latest.json`.
- `.github/workflows/update-data.yml` runs that script on a schedule
  (every 15 minutes, roughly during market hours) and commits the updated
  `data/latest.json` back to `main`. The script itself checks real NYSE
  market hours (`America/New_York`, 9:30am-4:00pm, Mon-Fri) and skips the
  fetch/commit if the market is closed, so the cron window is just a coarse
  outer bound.
- `index.html` / `assets/app.js` / `assets/style.css` are a static page that
  reads `data/latest.json` and lets you filter/sort candidates client-side
  (delta range, DTE range, minimum open interest).

## One-time setup

1. **Push this repo to GitHub** (already configured to push to
   `wchawkins/HoodCallSales`).
2. **Enable GitHub Pages**: repo Settings → Pages → Build and deployment →
   Source: "Deploy from a branch" → Branch: `main`, folder: `/ (root)`.
3. **Enable Actions write permissions**: repo Settings → Actions → General →
   Workflow permissions → "Read and write permissions" (needed so the
   scheduled workflow can commit `data/latest.json` back to the repo).
4. The workflow will start running on its cron schedule automatically. To
   populate data immediately instead of waiting, go to the Actions tab →
   "Update covered call data" → Run workflow.

## Editing your position

Edit `config.json` — `sharesOwned`, `existingShortCall.strike`, and
`existingShortCall.expiration` — whenever you roll or open a new covered
call. The next scheduled run picks up the change automatically.

## Local development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/fetch_and_score.py --force   # --force bypasses the market-hours check
python3 -m http.server 8000                 # then open http://localhost:8000
```

## Limitations

- Yahoo Finance data is unofficial/delayed and occasionally flaky; the
  workflow will simply keep last-known-good data in `data/latest.json` if a
  run fails partway (commit only happens on success).
- Delta is estimated from IV via Black-Scholes, not the broker/exchange's
  quoted delta — treat it as directional, not exact.
- Annualized yield assumes the current premium rate repeats every period,
  which real option premiums do not.
