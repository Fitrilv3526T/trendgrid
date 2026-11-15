'use strict';
/* TrendGrid autopilot: runs on GitHub Actions every 30 min. Fetches Binance public data,
   replays the deterministic paper account, writes docs/data/state.json (+ CSVs).
   No API keys. Paper trading only — it never places real orders. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const C = require('./core.js');
const { DEFAULTS, HOUR, DAY } = C;
const ROOT = path.join(__dirname, '..'), DATA = path.join(ROOT, 'docs', 'data');
const CFG_PATH = path.join(ROOT, 'config.json');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* data sources in priority order: the public spot mirror works from US servers
   (GitHub Actions), the futures API has the real perp candles but is US-blocked */
const SOURCES = [
  { name: 'spot mirror', limit: 1000, kline: (s, tf, q) => `https://data-api.binance.vision/api/v3/klines?symbol=${s}&interval=${tf}&${q}` },
  { name: 'futures API', limit: 1500, kline: (s, tf, q) => `https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${tf}&${q}` },
  { name: 'spot API', limit: 1000, kline: (s, tf, q) => `https://api.binance.com/api/v3/klines?symbol=${s}&interval=${tf}&${q}` }
];

async function jget(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status === 418) { await sleep(3000 * (t + 1)); continue; }
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return await r.json();
    } catch (e) { if (e.status === 451 || e.status === 403 || t === tries - 1) throw e; await sleep(700 * (t + 1)); }
  }
}

function toBars(rows) {
  const n = rows.length, b = { t: new Array(n), o: new Array(n), h: new Array(n), l: new Array(n), c: new Array(n) };
  for (let i = 0; i < n; i++) { const r = rows[i]; b.t[i] = r[0]; b.o[i] = +r[1]; b.h[i] = +r[2]; b.l[i] = +r[3]; b.c[i] = +r[4]; }
  return b;
}

async function pickSource() {
  const forced = process.env.TRENDGRID_SOURCE;
  for (const src of SOURCES) {
    if (forced && src.name !== forced) continue;
    try {
      const r = await jget(src.kline('BTCUSDT', '1h', 'limit=2'), 2);
      if (Array.isArray(r) && r.length) { log('data source:', src.name); return src; }
    } catch (e) { log(src.name + ' unavailable (' + (e.status || e.message) + ')'); }
  }
  throw new Error('no Binance data source reachable');
}

async function fetchHourly(src, sym, fromMs, nowMs) {
  const b = { t: [], o: [], h: [], l: [], c: [] };
  let start = fromMs;
  for (let page = 0; page < 10; page++) {
    const rows = await jget(src.kline(sym, '1h', `startTime=${start}&limit=${src.limit}`));
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) if (r[0] >= fromMs) { b.t.push(r[0]); b.o.push(+r[1]); b.h.push(+r[2]); b.l.push(+r[3]); b.c.push(+r[4]); }
    if (rows.length < src.limit || rows[rows.length - 1][0] >= nowMs) break;
    start = rows[rows.length - 1][0] + HOUR;
  }
  return b;
}

async function fetchFunding(sym, fromMs) {
  /* real perp funding (futures API only; usually blocked on US servers). Map(ms -> rate) */
  const map = new Map();
  let start = fromMs;
  for (let page = 0; page < 5; page++) {
    let rows;
    try { rows = await jget(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${start}&limit=1000`, 2); } catch (e) { return null; }
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) map.set(r.fundingTime, +r.fundingRate);
    if (rows.length < 1000) break;
    start = rows[rows.length - 1].fundingTime + 1;
  }
  return map.size ? map : null;
}

const r6 = (x) => Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : null;
const r2 = (x) => Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
const iso = (ms) => new Date(ms).toISOString();

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  let user = {}; try { user = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) {}
  const cfg = Object.assign({}, DEFAULTS, user);
  const now = Date.now();
  if (!cfg.startMs) {
    cfg.startMs = now; user.startMs = now;
    fs.writeFileSync(CFG_PATH, JSON.stringify(user, null, 2) + '\n');
    log('paper account starts now:', iso(now));
  }
  const effStart = Math.max(cfg.startMs, now - cfg.maxHistoryDays * DAY);
  const fromHour = Math.floor(effStart / HOUR) * HOUR;

  const src = await pickSource();
  const data = { symbols: {}, funding: {}, startMs: effStart, nowMs: now };
  for (const s of cfg.symbols) {
    const d1rows = await jget(src.kline(s, '1d', 'limit=400'));
    const d1 = toBars(d1rows);
    const h1 = await fetchHourly(src, s, fromHour, now);
    if (h1.t.length < 24 || d1.t.length < 60) { log(s + ': not enough data, skipped'); continue; }
    data.symbols[s] = { h1, d1 };
    log(`${s}: ${h1.t.length} hourly / ${d1.t.length} daily candles`);
  }
  if (!Object.keys(data.symbols).length) throw new Error('no symbols with data');

  let fundNote = 'funding rates not available from this server (futures API blocked): funding on grid positions is NOT charged. With currently negative alt funding that makes short-grid results slightly optimistic.';
  const funds = [];
  for (const s of Object.keys(data.symbols)) funds.push(await fetchFunding(s, effStart));
  let anyFund = false;
  Object.keys(data.symbols).forEach((s, i) => { if (funds[i]) { data.funding[s] = funds[i]; anyFund = true; } });
  if (anyFund) fundNote = 'real funding rates included (charged on open grid positions every 8h)';
  log('funding:', anyFund ? 'included' : 'not available');

  const res = C.simulate(data, cfg);
  log(`equity ${res.equityNow.toFixed(2)} U, ${res.stats.totalTrades} trades, ${res.stats.openLots} open lots, ${res.events.length} events`);

  /* ---------- state.json ---------- */
  const eq = res.equityCurve;
  const eqBefore = (ms) => { let v = cfg.startEquity; for (const p of eq) { if (p.t <= ms) v = p.eq; else break; } return v; };
  const monthStartMs = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const days30 = res.days.filter(d => d.day > now - 31 * DAY);
  const rts30 = days30.length ? days30.reduce((a, d) => a + d.rts, 0) / 30 : 0;
  const todayRec = res.days.length && res.days[res.days.length - 1].day === Math.floor(now / DAY) * DAY ? res.days[res.days.length - 1] : null;

  const symbolsOut = {};
  for (const [s, x] of Object.entries(res.symbols)) {
    symbolsOut[s] = {
      dir: x.dir, anchor: r6(x.anchor), lastPx: r6(x.lastPx), ema50: r6(x.ema50),
      priceVsEmaPct: r2(x.priceVsEmaPct), driftPct: r2(x.driftPct),
      openLots: x.lots.length,
      lots: x.lots.map(l => ({ lvl: l.j, qty: r6(l.qty), entry: r6(l.entry), openMs: l.openMs, fund: r6(l.fund || 0), unreal: r6(l.unreal) })),
      pausedUntilMs: x.pausedUntilMs, pausedForDay: x.pausedForDay,
      rtsToday: x.rtsToday, stopoutsToday: x.stopoutsToday, consecLosses: x.consecLosses
    };
  }
  const state = {
    updatedMs: now, source: src.name, fundNote,
    cfg: {
      startMs: cfg.startMs, startEquity: cfg.startEquity, symbols: Object.keys(data.symbols),
      levels: cfg.levels, band: cfg.band, trailFrac: cfg.trailFrac, buf: cfg.buf, emaLen: cfg.emaLen,
      perLevelPct: cfg.perLevelPct, minPerLevel: cfg.minPerLevel,
      makerFee: cfg.makerFee, takerFee: cfg.takerFee, slip: cfg.slip,
      maxConsecLosses: cfg.maxConsecLosses, maxStopoutsPerDay: cfg.maxStopoutsPerDay,
      maxDailyLossPct: cfg.maxDailyLossPct, monthlyKillPct: cfg.monthlyKillPct, killIdleDays: cfg.killIdleDays
    },
    effectiveStartMs: res.startMs,
    equityNow: r2(res.equityNow), returnPct: r2((res.equityNow / cfg.startEquity - 1) * 100),
    monthPct: r2((res.equityNow / eqBefore(monthStartMs - 1) - 1) * 100),
    last30Pct: r2((res.equityNow / eqBefore(now - 30 * DAY) - 1) * 100),
    maxDD: res.stats.maxDD, killed: res.killed, killUntilMs: res.killUntilMs,
    totals: {
      trades: res.stats.totalTrades, wins: res.stats.wins,
      winRate: r2(res.stats.winRate * 100), avgPnl: r6(res.stats.avgPnl),
      feesPaid: r2(res.stats.feesPaid), fundTotal: r2(res.stats.fundTotal),
      rtsPerDay30: Math.round(rts30 * 10) / 10,
      todayRts: todayRec ? todayRec.rts : 0, todayPnl: todayRec ? r2(todayRec.realized) : 0,
      daysRunning: Math.max(1, Math.round((now - cfg.startMs) / DAY))
    },
    symbols: symbolsOut,
    equity: eq, days: res.days.slice(-90),
    closed: res.trades.slice(-400).map(t => ({ closeMs: t.closeMs, openMs: t.openMs, sym: t.sym, side: t.side, reason: t.reason, entry: r6(t.entry), exit: r6(t.exit), qty: r6(t.qty), pnl: r6(t.pnl), fund: r6(t.fund || 0) })),
    events: res.events.slice(-300).map(e => { const o = { ms: e.ms, type: e.type }; if (e.sym) o.sym = e.sym; if (e.dir) o.dir = e.dir; if (e.px) o.px = r6(e.px); if (e.why) o.why = e.why; if (Number.isFinite(e.eq)) o.eq = e.eq; if (e.until) o.until = e.until; if (e.perLevel) o.perLevel = e.perLevel; return o; })
  };

  /* ---------- commit policy: only when something changed, or every 6 hours ---------- */
  const fp = crypto.createHash('md5').update(JSON.stringify([
    Object.entries(res.symbols).map(([s, x]) => s + '|' + x.lots.map(l => l.j + ':' + l.openMs).join(',')).sort(),
    res.trades.length, res.events.length, Math.round(res.equityNow * 100)
  ])).digest('hex');
  const seenPath = path.join(DATA, 'seen.json');
  let seen = {}; try { seen = JSON.parse(fs.readFileSync(seenPath, 'utf8')); } catch (e) {}
  const changed = fp !== seen.fp, stale = now - (seen.lastCommitMs || 0) > 6 * HOUR;
  const write = changed || stale || !fs.existsSync(path.join(DATA, 'state.json'));
  if (write) {
    fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(DATA, 'closed_trades.csv'),
      'close_utc,sym,side,reason,entry,exit,qty,pnl_usd,funding_usd\n' +
      res.trades.slice(-3000).map(t => [iso(t.closeMs), t.sym, t.side === 1 ? 'long' : 'short', t.reason, t.entry, t.exit, t.qty.toFixed(6), t.pnl.toFixed(6), (t.fund || 0).toFixed(6)].join(',')).join('\n') + '\n');
    fs.writeFileSync(path.join(DATA, 'day_log.csv'),
      'date,rts,trades,realized_usd,eq_end,stopouts,day_stop\n' +
      res.days.slice(-180).map(d => [new Date(d.day).toISOString().slice(0, 10), d.rts, d.trades, d.realized.toFixed(4), (d.eqEnd || 0).toFixed(2), d.stopouts, '"' + (d.dayStop || '') + '"'].join(',')).join('\n') + '\n');
    seen.fp = fp; seen.lastCommitMs = now;
    log('state written');
  } else log('state unchanged (skipped)');
  fs.writeFileSync(seenPath, JSON.stringify(seen));

  /* ---------- optional Telegram summary ---------- */
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (tok && chat) {
    const freshTrades = res.trades.filter(t => t.closeMs > now - 2 * HOUR);
    const freshEvents = res.events.filter(e => ['flip', 'stopout', 'daystop', 'kill', 'resume'].includes(e.type) && e.ms > now - 2 * HOUR);
    if (freshTrades.length || freshEvents.length) {
      const lines = ['TrendGrid paper update', `Equity ${res.equityNow.toFixed(2)} U (${((res.equityNow / cfg.startEquity - 1) * 100).toFixed(2)}%), today ${todayRec ? todayRec.rts + ' RTs ' + (todayRec.realized >= 0 ? '+' : '') + todayRec.realized.toFixed(2) + ' U' : '-'}`];
      for (const e of freshEvents.slice(-4)) {
        if (e.type === 'flip') lines.push(`${e.sym}: direction flip -> ${e.dir > 0 ? 'LONG grid' : 'SHORT grid'}`);
        else if (e.type === 'stopout') lines.push(`${e.sym}: grid stop-out, flat 24h`);
        else if (e.type === 'daystop') lines.push(`${e.sym === 'ALL' ? 'PORTFOLIO' : e.sym}: done for the day (${e.why})`);
        else if (e.type === 'kill') lines.push(`MONTHLY KILL-SWITCH: flat for ${cfg.killIdleDays} days`);
        else if (e.type === 'resume') lines.push('kill-switch over, trading resumed');
      }
      for (const t of freshTrades.slice(-6)) lines.push(`${t.side === 1 ? 'LONG' : 'SHORT'} ${t.sym.replace('USDT', '')} ${t.reason} ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)} U`);
      try {
        await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: lines.join('\n') }) });
      } catch (e) { log('telegram failed'); }
    }
  }
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
