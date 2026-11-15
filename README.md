# TrendGrid autopilot (paper trading)

Runs by itself on GitHub every 30 minutes. No server, no API keys, no browser needed.
It pulls Binance public market data, runs an adaptive grid-scalping paper account, and saves
everything in this repo (`docs/data/`). A web page (GitHub Pages) shows the results.
Paper trading only: it never places real orders.

**The strategy in one paragraph.** Each coin (default SOL, XRP, DOGE) gets a 25-level limit-order
grid spanning +/-10% around an anchor price. Every day at 00:00 UTC the bot compares yesterday's
close to the coin's 50-day average: above it the grid buys dips and sells bumps (long grid),
below it the grid sells bumps and buys them back lower (short grid). When price runs 6% or more
in the grid's favour the whole grid slides halfway toward price (locking the run); if price breaks
the band against the grid everything is flattened and the bot pauses 24h. Risk rules: a coin stops
for the day after 4 straight losing trades or 2 grid stop-outs; the whole account stops for the day
at -2.5% equity; a month down -8% means flat for 7 days. Position size is 2% of equity per grid
level, re-sized weekly. Maker fee 0.02% per fill, taker + 0.1% slippage on every forced exit.

## Set up (about 10 minutes, once)
1. On github.com click **New repository**. Name it `trendgrid`, choose **Public**, click Create.
2. Click **uploading an existing file** and drag in everything from this folder
   (`.github`, `docs`, `scanner`, `config.json`, `README.md`), then **Commit changes**.
   - If the hidden `.github` folder does not upload: click **Add file > Create new file**, type
     `.github/workflows/scan.yml` as the name and paste the content of that file from this folder.
3. **Settings > Pages**: Source = *Deploy from a branch*, Branch = `main`, folder = `/docs`, Save.
   Your page address appears there after a minute or two.
4. **Actions** tab: if GitHub asks, click *I understand my workflows, enable them*. Open
   **TrendGrid scan** and click **Run workflow**. The first run takes 1-3 minutes.
5. Open your Pages address. Bookmark it. That is all — it updates by itself.

The repo ships with the paper account already started 45 days ago, so the page opens with
history. To restart the account from today instead: edit `config.json` on GitHub and delete the
`"startMs"` line.

## Settings
Edit `config.json` on GitHub (pencil icon). The next scan rebuilds the whole paper account
with the new values.

| key | default | meaning |
|---|---|---|
| `startEquity` | 300 | paper account size in USDT |
| `symbols` | SOL, XRP, DOGE | coins to run grids on (BTC/ETH also work) |
| `perLevelPct` | 0.02 | USDT per grid level = equity x this (re-sized weekly) |
| `levels` | 25 | grid levels per coin |
| `band` | 0.10 | half-width of the grid (+/-10% around the anchor) |
| `maxDailyLossPct` | 0.025 | day stops when equity is down 2.5% from the day's start |
| `monthlyKillPct` | 0.08 | flat for 7 days when the month is down 8% |
| `startMs` | (set) | delete the line to restart the account from today |

## Optional phone alerts (Telegram)
Create a bot with @BotFather, send it a message, find your chat id, then in the repo
**Settings > Secrets and variables > Actions** add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
You get a message whenever trades close or a risk rule fires.

## Things to know (honest notes)
- **This is a paper account.** Fills are simulated at the exact grid level prices along each
  hourly candle's path. A real maker queue fills slightly worse. Judge the account after
  3 months and 500+ closed trades, not after a good week.
- **Funding.** Real funding rates are charged every 8h when the futures API is reachable.
  GitHub's US servers usually cannot reach it; then funding is not charged at all — with the
  currently negative alt funding that makes the short grids look slightly better than reality.
- **Data source.** The scanner prefers Binance's public spot-mirror API (works from GitHub),
  and falls back to the futures API. The dashboard says which one it used.
- GitHub pauses scheduled jobs after 60 days with no human activity in the repo. If the page
  says the data is old, open the Actions tab and re-enable the workflow.
- **Going live later is a separate step.** GitHub Pages only shows the dashboard; real trading
  needs the same engine on a small VPS with exchange API keys (trade-only permission). Run the
  paper account first and treat it as the interview for the strategy.
- Backtests and paper results are not a promise of future results. This is not financial advice.
