'use strict';
/* ===== TrendGrid engine: EMA50-directed sliding grid scalper (paper trading) =====
   Pure functions: no DOM, no network, no time-of-day calls. Deterministic replay
   from candles, so every scan rebuilds the identical paper account.
   Strategy ported 1:1 from the validated Python reference (no lookahead):
   - Direction per symbol per UTC day = prior day's close vs its daily EMA50 (above=long grid, below=short grid)
   - Grid: `levels` limit levels spanning anchor*(1-band)..anchor*(1+band), maker fills at level prices
   - Slide: when price drifts >= trailFrac half-bands the profitable way, flatten and re-anchor halfway to price
   - Catastrophic stop: adverse break beyond the band + buffer -> flatten, pause 24h
   - Day risk (per symbol): maxConsecLosses losing trades or maxStopoutsPerDay stops -> flat until next UTC day
   - Portfolio: -maxDailyLossPct from day-start equity -> everything flat until next UTC day
   - Month: -monthlyKillPct from month-start equity -> flat for killIdleDays
   - Sizing: perLevelPct of equity per level, re-sized weekly (Mon 00:00 UTC); maker/taker fees + slippage */

const HOUR = 3600000, DAY = 86400000;

const DEFAULTS = {
  startEquity: 300,
  symbols: ['SOLUSDT', 'XRPUSDT', 'DOGEUSDT'],
  levels: 25,
  band: 0.10,
  trailFrac: 0.60,
  buf: 0.01,
  emaLen: 50,
  perLevelPct: 0.02,
  minPerLevel: 2,
  makerFee: 0.0002,
  takerFee: 0.0005,
  slip: 0.001,
  maxConsecLosses: 4,
  maxStopoutsPerDay: 2,
  maxDailyLossPct: 0.025,
  monthlyKillPct: 0.08,
  killIdleDays: 7,
  maxHistoryDays: 120
};

function ema(a, n) { const o = new Array(a.length), al = 2 / (n + 1); o[0] = a[0]; for (let i = 1; i < a.length; i++) o[i] = al * a[i] + (1 - al) * o[i - 1]; return o; }
const dayKeyOf = (t) => Math.floor(t / DAY);
const monthKeyOf = (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

/* Direction per UTC day from the PRIOR day's close vs EMA (no lookahead).
   Returns { map: Map(dayStartMs -> {dir, close, ema}), lastClose, lastEma }. */
function buildDirs(d1, cfg, fromDay, toDay) {
  const closes = d1.c, e = ema(closes, cfg.emaLen), n = closes.length, map = new Map();
  for (let i = 1; i < n; i++) {
    const dk = dayKeyOf(d1.t[i]);
    if (dk >= fromDay && dk <= toDay) map.set(dk, { dir: closes[i - 1] > e[i - 1] ? 1 : -1, close: closes[i - 1], ema: e[i - 1] });
  }
  return { map, lastClose: closes[n - 1], lastEma: e[n - 1] };
}

function mkLevels(anchor, cfg) {
  const step = 2 * cfg.band * anchor / (cfg.levels - 1), out = new Array(cfg.levels);
  for (let j = 0; j < cfg.levels; j++) out[j] = anchor * (1 - cfg.band) + step * j;
  return out;
}

/* data = { symbols: { SYM: { h1: bars, d1: bars } }, funding: { SYM: Map(ms -> rate) }, startMs, nowMs }
   bars = { t: [ms...], o: [], h: [], l: [], c: [] }  (h1: hourly, last candle may be forming)
   Returns the complete paper-account state. */
function simulate(data, cfg) {
  const syms = Object.keys(data.symbols);
  const plain = !!cfg.plain;
  const t0 = Math.max(...syms.map(s => data.symbols[s].h1.t[0]));
  const tEnd = Math.max(...syms.map(s => data.symbols[s].h1.t[data.symbols[s].h1.t.length - 1]));
  const fromDay = dayKeyOf(t0), toDay = dayKeyOf(tEnd);

  const dirs = {}, lastInfo = {};
  for (const s of syms) { const r = buildDirs(data.symbols[s].d1, cfg, fromDay - 1, toDay); dirs[s] = r.map; lastInfo[s] = { close: r.lastClose, ema: r.lastEma }; }

  const st = {};
  for (const s of syms) {
    const b = data.symbols[s].h1;
    st[s] = {
      dir: (dirs[s].get(fromDay) || { dir: -1 }).dir,
      anchor: b.c[0], lv: null, lots: new Map(),
      ptr: 0, prevPx: b.o[0], lastPx: b.c[0],
      pausedUntilMs: -1, pausedForDay: false,
      consecLosses: 0, stopoutsToday: 0, rtsToday: 0, tradesToday: 0, pnlToday: 0,
      driftPct: 0, slideCount: 0
    };
    st[s].lv = mkLevels(st[s].anchor, cfg);
  }

  let cash = cfg.startEquity;
  let perLevel = plain ? (cfg.perLevelFixed || 6) : Math.max(cfg.minPerLevel, cfg.startEquity * cfg.perLevelPct);
  let dayKeyCur = fromDay, dayStartEq = cfg.startEquity, lastEq = cfg.startEquity;
  let monthKeyCur = monthKeyOf(t0), monthStartEq = cfg.startEquity;
  let killUntilMs = -1, killed = false;
  const trades = [], events = [], equityCurve = [], days = [];
  let dayRec = null, feesPaid = 0, fundTotal = 0, maxDD = 0, peak = cfg.startEquity;

  const openLotsCount = () => syms.reduce((a, s) => a + st[s].lots.size, 0);
  const unrealized = (s) => { let u = 0; for (const l of st[s].lots.values()) u += l.qty * (st[s].lastPx - l.entry) * st[s].dir; return u; };
  const equity = () => cash + syms.reduce((a, s) => a + unrealized(s), 0);

  function newDayRec(dk) {
    dayRec = { day: dk * DAY, rts: 0, trades: 0, realized: 0, stopouts: 0, dayStop: '', kill: false, eqEnd: NaN, dirs: {} };
    for (const s of syms) dayRec.dirs[s] = st[s].dir;
  }
  newDayRec(fromDay);

  function closeDay(dk) {
    if (!dayRec) return;
    dayRec.eqEnd = lastEq;
    days.push(dayRec);
    equityCurve.push({ t: dk * DAY, eq: Math.round(lastEq * 100) / 100 });
    if (lastEq > peak) peak = lastEq;
    maxDD = Math.min(maxDD, lastEq / peak - 1);
    dayRec = null;
  }

  function recTrade(s, lot, exitPx, reason, T) {
    const pnl = lot.qty * (exitPx - lot.entry) * st[s].dir - lot.qty * exitPx * (cfg.takerFee + cfg.slip);
    cash += pnl;
    feesPaid += lot.qty * exitPx * (cfg.takerFee + cfg.slip);
    trades.push({ sym: s, side: st[s].dir, reason, openMs: lot.openMs, closeMs: T, entry: lot.entry, exit: exitPx, qty: lot.qty, pnl, fund: lot.fund });
    if (reason === 'grid') { st[s].rtsToday++; dayRec.rts++; }
    st[s].tradesToday++; dayRec.trades++; st[s].pnlToday += pnl; dayRec.realized += pnl;
    if (!plain) {
      if (pnl < 0) st[s].consecLosses++; else if (pnl > 0) st[s].consecLosses = 0;
    }
    return pnl;
  }

  function flattenSym(s, px, reason, T) {
    for (const [j, lot] of [...st[s].lots]) { recTrade(s, lot, px, reason, T); st[s].lots.delete(j); }
  }

  function candleAt(s, T) {
    const b = data.symbols[s].h1, x = st[s];
    while (x.ptr < b.t.length - 1 && b.t[x.ptr] < T) x.ptr++;
    if (b.t[x.ptr] === T) {
      const c = { o: b.o[x.ptr], h: b.h[x.ptr], l: b.l[x.ptr], c: b.c[x.ptr] };
      x.lastPx = c.c;
      return c;
    }
    return { o: x.lastPx, h: x.lastPx, l: x.lastPx, c: x.lastPx, gap: true };
  }

  for (let T = t0; T <= tEnd; T += HOUR) {
    const dk = dayKeyOf(T);
    if (dk !== dayKeyCur) {
      closeDay(dayKeyCur);
      dayKeyCur = dk;
      dayStartEq = lastEq;
      newDayRec(dk);
      if (!plain) {
        for (const s of syms) { st[s].consecLosses = 0; st[s].stopoutsToday = 0; st[s].pausedForDay = false; st[s].rtsToday = 0; st[s].tradesToday = 0; st[s].pnlToday = 0; }
        const dow = new Date(T).getUTCDay();
        if (dow === 1) { perLevel = Math.max(cfg.minPerLevel, lastEq * cfg.perLevelPct); events.push({ ms: T, type: 'resize', perLevel: Math.round(perLevel * 100) / 100, eq: Math.round(lastEq * 100) / 100 }); }
        const mk = monthKeyOf(T);
        if (mk !== monthKeyCur) { monthKeyCur = mk; monthStartEq = lastEq; }
        if (killed && T >= killUntilMs) {
          killed = false; monthStartEq = lastEq;
          for (const s of syms) { st[s].anchor = st[s].lastPx; st[s].lv = mkLevels(st[s].anchor, cfg); }
          events.push({ ms: T, type: 'resume', eq: Math.round(lastEq * 100) / 100 });
        } else if (!killed && monthStartEq > 0 && lastEq < monthStartEq * (1 - cfg.monthlyKillPct)) {
          killed = true; killUntilMs = T + cfg.killIdleDays * DAY;
          for (const s of syms) flattenSym(s, st[s].lastPx, 'kill', T);
          events.push({ ms: T, type: 'kill', eq: Math.round(lastEq * 100) / 100, until: killUntilMs });
          dayRec.kill = true;
        }
      }
      // daily direction update (both modes)
      for (const s of syms) {
        const nd = dirs[s].get(dk);
        if (nd && nd.dir !== st[s].dir) {
          const c = candleAt(s, T);
          const px = c.gap ? st[s].lastPx : c.o;
          flattenSym(s, px, 'flip', T);
          st[s].dir = nd.dir; st[s].anchor = px; st[s].lv = mkLevels(px, cfg);
          events.push({ ms: T, type: 'flip', sym: s, dir: nd.dir, px });
          dayRec.dirs[s] = nd.dir;
        }
      }
    }

    if (!killed) {
      for (const s of syms) {
        const x = st[s];
        if (x.pausedForDay || T < x.pausedUntilMs) { const cc = candleAt(s, T); x.prevPx = cc.c; continue; }
        const c = candleAt(s, T);

        // funding on lots held across an 8h boundary (real rates when available)
        const fr = data.funding && data.funding[s];
        if (fr && !plain && fr.has(T)) {
          const rate = fr.get(T);
          for (const lot of x.lots.values()) {
            if (lot.openMs < T) {
              const f = -x.dir * rate * lot.qty * c.o;
              cash += f; lot.fund += f;
            }
          }
        }

        // fills along the candle path (wick-aware; maker at level prices)
        const pts = c.c >= c.o ? [c.o, c.l, c.h, c.c] : [c.o, c.h, c.l, c.c];
        const seq = [x.prevPx, ...pts];
        for (let k = 1; k < seq.length; k++) {
          const p0 = seq[k - 1], p1 = seq[k];
          for (let j = 0; j < cfg.levels; j++) {
            const L = x.lv[j];
            if (x.dir > 0) {
              if (p0 > L && p1 <= L && !x.lots.has(j)) {
                const q = perLevel / L; cash -= q * L * cfg.makerFee; feesPaid += q * L * cfg.makerFee;
                x.lots.set(j, { qty: q, entry: L, openMs: T, fund: 0 });
              }
              if (p0 < L && p1 >= L && x.lots.has(j - 1)) {
                const lot = x.lots.get(j - 1);
                const pnl = lot.qty * (L - lot.entry) - lot.qty * L * cfg.makerFee;
                cash += pnl; feesPaid += lot.qty * L * cfg.makerFee;
                trades.push({ sym: s, side: 1, reason: 'grid', openMs: lot.openMs, closeMs: T, entry: lot.entry, exit: L, qty: lot.qty, pnl, fund: lot.fund });
                x.lots.delete(j - 1); x.rtsToday++; dayRec.rts++; x.tradesToday++; dayRec.trades++; x.pnlToday += pnl; dayRec.realized += pnl;
                if (!plain) { if (pnl < 0) x.consecLosses++; else if (pnl > 0) x.consecLosses = 0; }
              }
            } else {
              if (p0 < L && p1 >= L && !x.lots.has(j)) {
                const q = perLevel / L; cash -= q * L * cfg.makerFee; feesPaid += q * L * cfg.makerFee;
                x.lots.set(j, { qty: q, entry: L, openMs: T, fund: 0 });
              }
              if (p0 > L && p1 <= L && x.lots.has(j + 1)) {
                const lot = x.lots.get(j + 1);
                const pnl = lot.qty * (lot.entry - L) - lot.qty * L * cfg.makerFee;
                cash += pnl; feesPaid += lot.qty * L * cfg.makerFee;
                trades.push({ sym: s, side: -1, reason: 'grid', openMs: lot.openMs, closeMs: T, entry: lot.entry, exit: L, qty: lot.qty, pnl, fund: lot.fund });
                x.lots.delete(j + 1); x.rtsToday++; dayRec.rts++; x.tradesToday++; dayRec.trades++; x.pnlToday += pnl; dayRec.realized += pnl;
                if (!plain) { if (pnl < 0) x.consecLosses++; else if (pnl > 0) x.consecLosses = 0; }
              }
            }
          }
        }
        x.prevPx = c.c;

        // slide / catastrophic stop on close
        const drift = x.dir > 0 ? (c.c - x.anchor) / (x.anchor * cfg.band) : (x.anchor - c.c) / (x.anchor * cfg.band);
        x.driftPct = drift * 100;
        if (drift >= cfg.trailFrac) {
          flattenSym(s, c.c, 'slide', T);
          x.anchor = x.anchor + (c.c - x.anchor) * 0.5;
          x.lv = mkLevels(x.anchor, cfg);
          x.slideCount++;
          events.push({ ms: T, type: 'slide', sym: s, px: c.c });
        } else if (drift <= -(1 + cfg.buf)) {
          flattenSym(s, c.c, 'stopout', T);
          x.stopoutsToday++; dayRec.stopouts++;
          x.anchor = c.c; x.lv = mkLevels(c.c, cfg);
          x.pausedUntilMs = T + 24 * HOUR;
          events.push({ ms: T, type: 'stopout', sym: s, px: c.c, driftPct: Math.round(x.driftPct * 100) / 100 });
          if (!plain && x.stopoutsToday >= cfg.maxStopoutsPerDay) {
            x.pausedForDay = true; dayRec.dayStop = dayRec.dayStop || (s + ': 2 stop-outs');
            events.push({ ms: T, type: 'daystop', sym: s, why: 'stopouts' });
          }
        }

        // consecutive-loss day stop (full mode)
        if (!plain && x.consecLosses >= cfg.maxConsecLosses && x.lots.size) {
          flattenSym(s, c.c, 'daystop', T);
          x.pausedForDay = true; dayRec.dayStop = dayRec.dayStop || (s + ': ' + cfg.maxConsecLosses + ' losses in a row');
          events.push({ ms: T, type: 'daystop', sym: s, why: 'consec' });
        }
      }

      // portfolio equity day stop (full mode)
      lastEq = equity();
      if (!plain && openLotsCount() > 0 && lastEq <= dayStartEq * (1 - cfg.maxDailyLossPct)) {
        for (const s of syms) {
          if (st[s].lots.size) flattenSym(s, st[s].lastPx, 'daystop', T);
          st[s].pausedForDay = true;
        }
        dayRec.dayStop = dayRec.dayStop || 'equity -' + (cfg.maxDailyLossPct * 100) + '%';
        events.push({ ms: T, type: 'daystop', sym: 'ALL', why: 'equity', eq: Math.round(lastEq * 100) / 100 });
      }
    } else {
      for (const s of syms) { const cc = candleAt(s, T); st[s].prevPx = cc.c; }
      lastEq = equity();
    }
  }
  closeDay(dayKeyCur);
  lastEq = equity();
  const lastPt = { t: dayKeyOf(tEnd) * DAY, eq: Math.round(lastEq * 100) / 100 };
  if (equityCurve.length && equityCurve[equityCurve.length - 1].t === lastPt.t) equityCurve[equityCurve.length - 1] = lastPt;
  else equityCurve.push(lastPt);
  if (lastEq > peak) peak = lastEq;
  maxDD = Math.min(maxDD, lastEq / peak - 1);

  const wins = trades.filter(t => t.pnl > 0).length;
  const symbolsOut = {};
  for (const s of syms) {
    const x = st[s];
    symbolsOut[s] = {
      dir: x.dir, anchor: x.anchor, driftPct: Math.round(x.driftPct * 100) / 100,
      lots: [...x.lots.entries()].map(([j, l]) => ({ j, qty: l.qty, entry: l.entry, openMs: l.openMs, fund: l.fund, unreal: l.qty * (x.lastPx - l.entry) * x.dir })),
      pausedUntilMs: x.pausedUntilMs > 0 ? x.pausedUntilMs : null, pausedForDay: x.pausedForDay,
      rtsToday: x.rtsToday, stopoutsToday: x.stopoutsToday, consecLosses: x.consecLosses,
      lastPx: x.lastPx, priceVsEmaPct: (x.lastPx / lastInfo[s].ema - 1) * 100, ema50: lastInfo[s].ema,
      slideCount: x.slideCount
    };
  }
  const fundSum = trades.reduce((a, t) => a + (t.fund || 0), 0);
  return {
    startMs: t0, nowMs: tEnd, equityNow: lastEq, equityCurve, days, trades, events,
    symbols: symbolsOut, killed, killUntilMs: killed ? killUntilMs : null,
    stats: {
      totalTrades: trades.length, wins, winRate: trades.length ? wins / trades.length : 0,
      avgPnl: trades.length ? trades.reduce((a, t) => a + t.pnl, 0) / trades.length : 0,
      feesPaid, fundTotal: fundSum, maxDD, openLots: openLotsCount()
    }
  };
}

if (typeof module !== 'undefined') module.exports = { DEFAULTS, ema, buildDirs, mkLevels, simulate, HOUR, DAY };
