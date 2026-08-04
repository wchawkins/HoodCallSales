#!/usr/bin/env python3
"""
Pulls HOOD stock + call option chain data from Yahoo Finance (via yfinance),
scores candidate covered-call strikes/expirations, and writes data/latest.json
for the static dashboard to read.

No API key required. Intended to run on a schedule via GitHub Actions
(.github/workflows/update-data.yml), which also handles committing the output.
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
OUTPUT_PATH = ROOT / "data" / "latest.json"

NY_TZ = ZoneInfo("America/New_York")


def load_config() -> dict:
    with CONFIG_PATH.open() as f:
        return json.load(f)


def market_is_open(now_ny: datetime) -> bool:
    if now_ny.weekday() >= 5:  # Sat/Sun
        return False
    open_t = now_ny.replace(hour=9, minute=30, second=0, microsecond=0)
    close_t = now_ny.replace(hour=16, minute=0, second=0, microsecond=0)
    return open_t <= now_ny <= close_t


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_call_delta(spot: float, strike: float, years: float, rate: float, iv: float) -> float | None:
    """Black-Scholes call delta = N(d1). Assumes no dividend yield."""
    if spot <= 0 or strike <= 0 or years <= 0 or iv is None or iv <= 0:
        return None
    d1 = (math.log(spot / strike) + (rate + 0.5 * iv * iv) * years) / (iv * math.sqrt(years))
    return norm_cdf(d1)


def mid_price(bid: float, ask: float, last: float) -> float:
    if bid and ask and bid > 0 and ask > 0:
        return round((bid + ask) / 2, 4)
    return round(last or 0, 4)


def build_candidates(ticker: yf.Ticker, spot: float, cfg: dict, now_utc: datetime) -> list[dict]:
    screen = cfg["screen"]
    min_dte, max_dte = screen["minDteFetch"], screen["maxDteFetch"]
    min_delta, max_delta = screen["minDeltaFetch"], screen["maxDeltaFetch"]
    rate = screen["riskFreeRate"]

    candidates = []
    for exp_str in ticker.options:
        exp_date = datetime.strptime(exp_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        dte = (exp_date - now_utc).days
        if dte < min_dte or dte > max_dte:
            continue

        try:
            chain = ticker.option_chain(exp_str)
        except Exception as exc:  # yfinance occasionally fails a single expiration
            print(f"  skip {exp_str}: {exc}", file=sys.stderr)
            continue

        calls = chain.calls
        years = dte / 365.0

        for _, row in calls.iterrows():
            strike = float(row["strike"])
            if strike <= spot:
                continue  # only OTM calls are relevant for a covered call

            iv = float(row["impliedVolatility"]) if row.get("impliedVolatility") == row.get("impliedVolatility") else None
            delta = bs_call_delta(spot, strike, years, rate, iv)
            if delta is None or delta < min_delta or delta > max_delta:
                continue

            premium = mid_price(float(row.get("bid") or 0), float(row.get("ask") or 0), float(row.get("lastPrice") or 0))
            if premium <= 0:
                continue

            annualized_yield_pct = (premium / spot) * (365.0 / dte) * 100.0
            pct_otm = (strike - spot) / spot * 100.0

            candidates.append({
                "expiration": exp_str,
                "dte": dte,
                "strike": strike,
                "pctOtm": round(pct_otm, 2),
                "premium": premium,
                "impliedVolatility": round(iv, 4) if iv else None,
                "delta": round(delta, 4),
                "annualizedYieldPct": round(annualized_yield_pct, 2),
                "volume": int(row["volume"]) if row.get("volume") == row.get("volume") else 0,
                "openInterest": int(row["openInterest"]) if row.get("openInterest") == row.get("openInterest") else 0,
            })

    candidates.sort(key=lambda c: c["annualizedYieldPct"], reverse=True)
    return candidates


def existing_position_snapshot(ticker: yf.Ticker, cfg: dict, spot: float) -> dict:
    pos = cfg["existingShortCall"]
    snapshot = {
        "strike": pos["strike"],
        "expiration": pos["expiration"],
        "sharesOwned": cfg["sharesOwned"],
        "isInTheMoney": spot > pos["strike"],
        "currentPremium": None,
    }
    try:
        chain = ticker.option_chain(pos["expiration"])
        row = chain.calls[chain.calls["strike"] == pos["strike"]]
        if not row.empty:
            r = row.iloc[0]
            snapshot["currentPremium"] = mid_price(
                float(r.get("bid") or 0), float(r.get("ask") or 0), float(r.get("lastPrice") or 0)
            )
    except Exception as exc:
        print(f"  couldn't snapshot existing position: {exc}", file=sys.stderr)
    return snapshot


def main() -> int:
    cfg = load_config()
    force = "--force" in sys.argv

    now_utc = datetime.now(timezone.utc)
    now_ny = now_utc.astimezone(NY_TZ)

    if not force and not market_is_open(now_ny):
        print("Market closed; skipping fetch.")
        return 0

    ticker = yf.Ticker(cfg["ticker"])
    fast_info = ticker.fast_info
    spot = float(fast_info["lastPrice"])

    candidates = build_candidates(ticker, spot, cfg, now_utc)
    existing = existing_position_snapshot(ticker, cfg, spot)

    output = {
        "generatedAtUtc": now_utc.isoformat(),
        "ticker": cfg["ticker"],
        "spotPrice": spot,
        "existingPosition": existing,
        "screenDefaults": {
            "minDelta": cfg["screen"]["minDeltaDefault"],
            "maxDelta": cfg["screen"]["maxDeltaDefault"],
            "minDte": cfg["screen"]["minDteDefault"],
            "maxDte": cfg["screen"]["maxDteDefault"],
        },
        "candidates": candidates,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {len(candidates)} candidates to {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
