// Weekly Monitor API — SINGLE-FILE bundle (no lib/ folder needed). Start: node server.js
import http from 'node:http';

/* UNIVERSE */
// Categorized watchlist. Add/remove tickers here; the engine scores whatever's listed.
// `lists` a ticker can appear in: own, deep, leaps, para.
const UNIVERSE = [
  { ticker: 'AVGO', name: 'Broadcom',            lists: ['own'] },
  { ticker: 'GOOGL', name: 'Alphabet',           lists: ['own', 'deep'] },
  { ticker: 'NVDA', name: 'NVIDIA',              lists: ['own'] },
  { ticker: 'AMZN', name: 'Amazon',              lists: ['own'] },
  { ticker: 'MSFT', name: 'Microsoft',           lists: ['own'] },
  { ticker: 'META', name: 'Meta Platforms',      lists: ['own', 'deep'] },
  { ticker: 'TSM',  name: 'Taiwan Semiconductor', lists: ['own', 'deep'] },
  { ticker: 'MU',   name: 'Micron',              lists: ['leaps', 'para'] },
  { ticker: 'AMD',  name: 'Advanced Micro Devices', lists: ['leaps'] },
  { ticker: 'MRVL', name: 'Marvell',             lists: ['para'] },
  { ticker: 'VRT',  name: 'Vertiv',              lists: ['para'] },
  { ticker: 'IONQ', name: 'IonQ',                lists: ['para'] },
];
const LISTS = ['own', 'deep', 'leaps', 'para'];
const tickersFor = (list) => UNIVERSE.filter(u => u.lists.includes(list));
const allTickers = () => [...new Set(UNIVERSE.map(u => u.ticker))];

/* SCORING */
// ============================================================================
//  Weekly Monitor — SCORING ENGINE
//  Deterministic. Every grade/signal is computed from data with stated inputs.
//  No hidden judgment: change the weights/thresholds below and grades change.
//  This is what makes the output reproducible AND backtestable.
// ============================================================================

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const pct = (a, b) => (b ? (a - b) / b : 0);

// ---- Per-list weighting & curve. Each list grades on its own curve, on purpose.
// weights must sum to ~1. curve shifts the letter mapping (looser/stricter).
const LIST_PROFILE = {
  own:   { w: { value: 0.30, trend: 0.25, entry: 0.20, rating: 0.25 }, curve:  0 },
  deep:  { w: { value: 0.45, trend: 0.20, entry: 0.15, rating: 0.20 }, curve: +3 }, // value-led
  leaps: { w: { value: 0.30, trend: 0.30, entry: 0.25, rating: 0.15 }, curve:  0 }, // trend+timing matter
  para:  { w: { value: 0.40, trend: 0.20, entry: 0.20, rating: 0.20 }, curve: +8 }, // looser curve, asymmetry hunt
};

// ---------------------------------------------------------------------------
//  COMPONENT SCORES (0–100)
// ---------------------------------------------------------------------------

// VALUE: blend analyst-target upside and DCF upside into a 0–100 score.
function valueScore(d) {
  const aUp = (d.targetMean && d.price) ? pct(d.targetMean, d.price) : null;   // analyst
  const dUp = (d.dcf && d.price)        ? pct(d.dcf, d.price)        : null;   // intrinsic
  const ups = [aUp, dUp].filter(v => v != null);
  if (!ups.length) return { score: null, aUp, dUp };
  const blend = ups.reduce((s, v) => s + v, 0) / ups.length;
  // map: -20% -> 0, 0% -> 35, +25% -> 75, +50%+ -> 100  (diminishing)
  const score = clamp(35 + blend * 160);
  return { score, aUp, dUp, blend };
}

// TREND: the guardrail the historical evidence said was missing.
// Above the 200-DMA = constructive; below = don't "buy support", wait to reclaim.
function trendScore(d) {
  if (!d.price || !d.sma200) return { score: null, above200: null };
  const above200 = d.price >= d.sma200;
  const above50  = d.sma50 ? d.price >= d.sma50 : null;
  const golden   = (d.sma50 && d.sma200) ? d.sma50 >= d.sma200 : null; // 50>200
  let s = above200 ? 70 : 25;
  if (golden === true) s += 15; else if (golden === false) s -= 10;
  if (above50 === true) s += 10; else if (above50 === false) s -= 5;
  // distance above 200 rewarded mildly (room), but extreme extension not here (that's entry)
  return { score: clamp(s), above200, above50, golden };
}

// ENTRY/TIMING: best when near support, RSI not hot, not over-extended above 50-DMA.
function entryScore(d) {
  if (!d.price || d.rsi == null) return { score: null };
  let s = 50;
  // RSI: oversold rewarded, overbought penalized
  if (d.rsi <= 35) s += 25; else if (d.rsi <= 45) s += 12;
  else if (d.rsi >= 70) s -= 25; else if (d.rsi >= 60) s -= 10;
  // proximity to support (only meaningful if we have one)
  if (d.support && d.price) {
    const dist = pct(d.price, d.support); // + = above support
    if (dist < 0)            s -= 20;            // below support = broken
    else if (dist <= 0.025)  s += 18;            // at support
    else if (dist <= 0.06)   s += 8;
    else if (dist >= 0.20)   s -= 8;             // far from any floor
  }
  // extension above 50-DMA = chasing
  if (d.sma50) { const ext = pct(d.price, d.sma50); if (ext >= 0.15) s -= 15; else if (ext >= 0.08) s -= 7; }
  return { score: clamp(s) };
}

// RATING: analyst consensus skew + target upside.
function ratingScore(d) {
  const b = d.ratingBuy || 0, h = d.ratingHold || 0, se = d.ratingSell || 0;
  const n = b + h + se;
  if (!n) return { score: null, consensus: null };
  const net = (b - se) / n; // -1..1
  let s = clamp(50 + net * 45);
  const aUp = (d.targetMean && d.price) ? pct(d.targetMean, d.price) : null;
  if (aUp != null) s = clamp(s + clamp(aUp * 60, -15, 20)); // nudge by target upside
  const consensus = net > 0.4 ? 'Strong Buy' : net > 0.15 ? 'Buy' : net > -0.15 ? 'Hold' : 'Sell';
  return { score: s, consensus, net };
}

// ---------------------------------------------------------------------------
//  COMPOSITE -> LETTER, SIGNAL, SIZING, REWARD:RISK
// ---------------------------------------------------------------------------

function letter(composite, curve) {
  const x = composite + curve; // curve loosens (para) or tightens
  if (x >= 86) return 'A';   if (x >= 80) return 'A\u2212';
  if (x >= 74) return 'B+';  if (x >= 66) return 'B';   if (x >= 60) return 'B\u2212';
  if (x >= 54) return 'C+';  if (x >= 46) return 'C';
  return 'C\u2212';
}

// SIGNAL: never "buy support" in a downtrend — that's the documented failure mode.
function signal(d, t) {
  const haveTech = d.price && d.sma200 && d.rsi != null;
  if (!haveTech) return 'VERIFY';
  const above200 = d.price >= d.sma200;
  const distSup  = d.support ? pct(d.price, d.support) : null;
  const hot      = d.rsi >= 66;
  const ext      = d.sma50 ? pct(d.price, d.sma50) >= 0.12 : false;

  if (!above200) return 'CONFIRM';                  // downtrend: wait for reclaim, don't catch the knife
  if (distSup != null && distSup < 0)  return 'CONFIRM'; // below support though above 200 -> needs to hold
  if (distSup != null && distSup <= 0.025 && !hot) return 'BUY'; // at support, uptrend, not hot
  if (hot || ext) return 'WAIT';                    // extended/overbought
  return t.composite >= 74 ? 'BUY' : 'WAIT';
}

function sizing(d, t) {
  // Core for large, high-quality, uptrend; Lottery for small/parabolic.
  const big = (d.marketCap || 0) >= 2e11;
  const mid = (d.marketCap || 0) >= 2e10;
  if (t.list === 'para') return t.composite >= 70 ? 'Starter' : 'Lottery';
  if (t.tr && t.tr.above200 === false) return 'Starter';
  if (big && t.composite >= 78) return 'Core';
  if (mid && t.composite >= 66) return 'Standard';
  return 'Starter';
}

function rewardRisk(d, t) {
  const reward = t.val && t.val.blend != null ? t.val.blend : null; // upside %
  if (reward == null) return { ratio: null, note: 'no target' };
  let risk;
  let note = '';
  if (d.support && d.price && d.price > d.support && t.tr && t.tr.above200) {
    risk = pct(d.price, d.support);              // distance to floor
    if (risk < 0.015) note = 'at support';
  } else if (d.support && d.price && d.price < d.support) {
    return { ratio: null, note: 'below support', reward };
  } else {
    // no clean support / downtrend -> use a regime band by trend
    risk = (t.tr && t.tr.above200) ? 0.12 : 0.20;
    note = 'est band';
  }
  const ratio = risk > 0 ? reward / risk : null;
  return { ratio, reward, risk, note };
}

// ---------------------------------------------------------------------------
//  MAIN
// ---------------------------------------------------------------------------
function scoreTicker(d, list = 'own') {
  const profile = LIST_PROFILE[list] || LIST_PROFILE.own;
  const val = valueScore(d), tr = trendScore(d), en = entryScore(d), ra = ratingScore(d);

  // weighted composite over available components (renormalize weights for missing data)
  const parts = [['value', val.score], ['trend', tr.score], ['entry', en.score], ['rating', ra.score]];
  let wsum = 0, acc = 0, have = 0;
  for (const [k, s] of parts) { if (s != null) { acc += s * profile.w[k]; wsum += profile.w[k]; have++; } }
  const composite = wsum ? acc / wsum : null;

  const t = { list, composite, val, tr, en, ra };
  const grade  = composite == null ? null : letter(composite, profile.curve);
  const sig    = signal(d, t);
  const size   = sizing(d, t);
  const rr     = rewardRisk(d, t);
  const confidence = Math.round((have / 4) * 100); // % of inputs present

  return {
    ticker: d.ticker, name: d.name, list,
    price: d.price ?? null,
    grade, signal: sig, sizing: size,
    composite: composite == null ? null : Math.round(composite),
    components: {
      value: val.score == null ? null : Math.round(val.score),
      trend: tr.score == null ? null : Math.round(tr.score),
      entry: en.score == null ? null : Math.round(en.score),
      rating: ra.score == null ? null : Math.round(ra.score),
    },
    detail: {
      analystUpsidePct: val.aUp == null ? null : +(val.aUp * 100).toFixed(1),
      dcfUpsidePct:     val.dUp == null ? null : +(val.dUp * 100).toFixed(1),
      consensus: ra.consensus, ratingNet: ra.net == null ? null : +ra.net.toFixed(2),
      above200: tr.above200, golden: tr.golden, rsi: d.rsi ?? null,
      support: d.support ?? null, sma50: d.sma50 ?? null, sma200: d.sma200 ?? null,
      rewardRisk: rr.ratio == null ? null : +rr.ratio.toFixed(2), rrNote: rr.note,
      pe: d.pe ?? null,
    },
    confidence,
    asof: new Date().toISOString(),
  };
}
function scoreUniverse(rows, list) {
  return rows.map(r => scoreTicker(r, list))
             .sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
}

/* PROVIDERS */
// ============================================================================
//  DATA PROVIDERS — normalize FMP + Finnhub into the shape the engine expects.
//  Set MOCK=1 (or omit keys) to run on built-in sample data with no network.
//  NOTE: provider JSON shapes change — verify field names against current docs
//  (financialmodelingprep.com/developer/docs , finnhub.io/docs/api).
// ============================================================================
const FMP = 'https://financialmodelingprep.com/api/v3';
const FMPS = 'https://financialmodelingprep.com/stable';
const FH  = 'https://finnhub.io/api/v1';

const num = (v) => (v == null || isNaN(+v) ? null : +v);

async function j(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
  return r.json();
}

// ---- MOCK universe (varied on purpose: an A, a downtrend CONFIRM, an extended WAIT, a lottery)
const MOCK = {
  AVGO: { price: 380, sma50: 405, sma200: 360, rsi: 43, support: 358, targetMean: 524, dcf: 470, pe: 68, marketCap: 1.81e12, ratingBuy: 22, ratingHold: 4, ratingSell: 0 },
  GOOGL:{ price: 346, sma50: 352, sma200: 318, rsi: 52, support: 340, targetMean: 410, dcf: 430, pe: 21, marketCap: 2.1e12, ratingBuy: 24, ratingHold: 5, ratingSell: 1 },
  NVDA: { price: 199, sma50: 206, sma200: 188, rsi: 49, support: 196, targetMean: 299, dcf: 250, pe: 31, marketCap: 4.9e12, ratingBuy: 55, ratingHold: 6, ratingSell: 1 },
  AMZN: { price: 233, sma50: 240, sma200: 244, rsi: 41, support: 236, targetMean: 285, dcf: 300, pe: 38, marketCap: 2.4e12, ratingBuy: 40, ratingHold: 6, ratingSell: 0 }, // below 200 -> CONFIRM
  MSFT: { price: 374, sma50: 372, sma200: 380, rsi: 47, support: 356, targetMean: 470, dcf: 460, pe: 30, marketCap: 2.8e12, ratingBuy: 45, ratingHold: 5, ratingSell: 0 },
  META: { price: 577, sma50: 600, sma200: 540, rsi: 45, support: 560, targetMean: 690, dcf: 700, pe: 24, marketCap: 1.5e12, ratingBuy: 50, ratingHold: 6, ratingSell: 1 },
  TSM:  { price: 443, sma50: 470, sma200: 410, rsi: 44, support: 430, targetMean: 560, dcf: 590, pe: 27, marketCap: 1.0e12, ratingBuy: 30, ratingHold: 2, ratingSell: 0 },
  MU:   { price: 1058, sma50: 980, sma200: 760, rsi: 67, support: 945, targetMean: 1150, dcf: 800, pe: 18, marketCap: 1.2e11, ratingBuy: 28, ratingHold: 5, ratingSell: 2 }, // extended -> WAIT
  AMD:  { price: 178, sma50: 172, sma200: 165, rsi: 55, support: 160, targetMean: 230, dcf: 210, pe: 40, marketCap: 2.9e11, ratingBuy: 35, ratingHold: 8, ratingSell: 1 },
  MRVL: { price: 92,  sma50: 88,  sma200: 78,  rsi: 58, support: 80,  targetMean: 130, dcf: 110, pe: 45, marketCap: 8e10, ratingBuy: 25, ratingHold: 4, ratingSell: 1 },
  VRT:  { price: 118, sma50: 110, sma200: 95,  rsi: 60, support: 100, targetMean: 150, dcf: 135, pe: 42, marketCap: 4.5e10, ratingBuy: 18, ratingHold: 3, ratingSell: 0 },
  IONQ: { price: 38,  sma50: 42,  sma200: 33,  rsi: 48, support: 32,  targetMean: 55,  dcf: 20,  pe: null, marketCap: 9e9, ratingBuy: 6, ratingHold: 3, ratingSell: 2 },
};
function isMock() { return process.env.MOCK === '1' || (!process.env.FMP_KEY && !process.env.FINNHUB_KEY); }
async function fetchTicker(meta) {
  const { ticker, name } = meta;
  if (isMock()) return { ticker, name, ...(MOCK[ticker] || {}) };

  const fmpKey = process.env.FMP_KEY, fhKey = process.env.FINNHUB_KEY;
  const out = { ticker, name };

  try {
    // ---- Finnhub: live quote + recommendation trends + price target
    if (fhKey) {
      const q = await j(`${FH}/quote?symbol=${ticker}&token=${fhKey}`);
      out.price = num(q.c);
      try {
        const rec = (await j(`${FH}/stock/recommendation?symbol=${ticker}&token=${fhKey}`))[0];
        if (rec) { out.ratingBuy = (rec.strongBuy||0)+(rec.buy||0); out.ratingHold = rec.hold||0; out.ratingSell = (rec.sell||0)+(rec.strongSell||0); }
      } catch {}
      try { const pt = await j(`${FH}/stock/price-target?symbol=${ticker}&token=${fhKey}`); out.targetMean = num(pt.targetMean); } catch {}
    }
    // ---- FMP: profile (mktCap, pe), DCF, SMA50/200, RSI, 52w low (support proxy), price target consensus
    if (fmpKey) {
      try { const p = (await j(`${FMP}/profile/${ticker}?apikey=${fmpKey}`))[0]; if (p) { out.price = out.price ?? num(p.price); out.marketCap = num(p.mktCap); out.pe = num(p.pe); out.name = name || p.companyName; out.support = out.support ?? num(p['range'] ? p.range.split('-')[0] : null); } } catch {}
      try { const dcf = (await j(`${FMP}/discounted-cash-flow/${ticker}?apikey=${fmpKey}`))[0]; if (dcf) out.dcf = num(dcf.dcf); } catch {}
      try { const s50 = await j(`${FMP}/technical_indicator/1day/${ticker}?type=sma&period=50&apikey=${fmpKey}`);  out.sma50  = num(s50?.[0]?.sma); } catch {}
      try { const s200= await j(`${FMP}/technical_indicator/1day/${ticker}?type=sma&period=200&apikey=${fmpKey}`); out.sma200 = num(s200?.[0]?.sma); } catch {}
      try { const rsi = await j(`${FMP}/technical_indicator/1day/${ticker}?type=rsi&period=14&apikey=${fmpKey}`);  out.rsi    = num(rsi?.[0]?.rsi); } catch {}
      try { if (out.targetMean == null) { const ptc = (await j(`${FMP}/price-target-consensus/${ticker}?apikey=${fmpKey}`))[0]; out.targetMean = num(ptc?.targetConsensus); } } catch {}
    }
  } catch (e) { out._error = String(e.message || e); }
  return out;
}

/* THESIS */
// ============================================================================
//  THESIS WRITER — one terse line per name, grounded ONLY in the computed data.
//  Uses one batched Claude call per refresh (cheap). Falls back to a
//  deterministic line if no ANTHROPIC_API_KEY (or in mock mode), so the app
//  always has a thesis. The prose is the ONLY non-deterministic layer.
// ============================================================================

const MODEL = process.env.THESIS_MODEL || 'claude-haiku-4-5-20251001';

// Deterministic one-liner built from the numbers — no model needed.
function fallbackThesis(r) {
  const d = r.detail || {};
  const up = d.analystUpsidePct;
  const upTxt = up == null ? '' : (up >= 0 ? `+${up}% to target` : `${up}% vs target`);
  const rsi = d.rsi == null ? '—' : Math.round(d.rsi);
  const dist = (d.support && r.price) ? (r.price - d.support) / r.price : null;
  const atSupport = dist != null && dist >= 0 && dist <= 0.03;

  if (r.signal === 'CONFIRM')
    return `Below its 200-day line — wait for a reclaim before adding${up > 0 ? `; ${upTxt} if it turns` : ''}.`;
  if (r.signal === 'BUY')
    return atSupport
      ? `At support in an uptrend, RSI ${rsi}${up > 0 ? ` — ${upTxt}` : ''}.`
      : `Constructive above its 200-day, RSI ${rsi}${up > 0 ? ` — ${upTxt}` : ''}.`;
  if (r.signal === 'WAIT')
    return (d.rsi != null && d.rsi >= 66)
      ? `Extended (RSI ${rsi}) — let it cool toward support${up > 0 ? `; ${upTxt}` : ''}.`
      : `No clean entry yet — wait for a pullback or firmer setup${up > 0 ? `; ${upTxt}` : ''}.`;
  return `Data incomplete — verify the chart${up != null ? `; ${upTxt}` : ''}.`;
}
async function writeTheses(rows) {
  const key = process.env.ANTHROPIC_API_KEY;
  const fallback = () => Object.fromEntries(rows.map(r => [r.ticker, fallbackThesis(r)]));
  if (!key || isMock()) return fallback();

  const slate = rows.map(r => ({
    t: r.ticker, name: r.name, list: r.list, grade: r.grade, signal: r.signal,
    upside: r.detail?.analystUpsidePct, dcfUpside: r.detail?.dcfUpsidePct,
    above200: r.detail?.above200, rsi: r.detail?.rsi, consensus: r.detail?.consensus,
    rr: r.detail?.rewardRisk, rrNote: r.detail?.rrNote,
  }));
  const system =
    'You write terse equity one-liners for a personal watchlist. For each ticker write ONE plain-English line, max 18 words, ' +
    'stating the setup and the catch, grounded ONLY in the numbers given (valuation vs target/DCF, the 200-day trend, RSI, ' +
    'analyst consensus, reward:risk). No hype, no price predictions, no advice verbs like "buy"/"sell". Respect the signal: ' +
    'CONFIRM = below trend, wait for reclaim; WAIT = extended; BUY = constructive entry; VERIFY = data thin. ' +
    'Return ONLY a JSON object mapping ticker -> string. No markdown, no commentary.';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages: [{ role: 'user', content: 'Slate:\n' + JSON.stringify(slate) }] }),
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const j = await res.json();
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const map = JSON.parse(clean);
    const out = fallback();
    for (const r of rows) if (typeof map[r.ticker] === 'string') out[r.ticker] = map[r.ticker].trim();
    return out;
  } catch (e) {
    const out = fallback(); Object.defineProperty(out, '_error', { value: String(e.message || e), enumerable: false }); return out;
  }
}

/* MACRO */
// ============================================================================
//  MACRO WRITER — a fresh daily market read, written by Claude with live web
//  search. Cached so it costs ~a few cents/day. Falls back to a dated
//  placeholder if no ANTHROPIC_API_KEY.
// ============================================================================

const MACRO_MDL = process.env.MACRO_MODEL || 'claude-sonnet-4-6';
function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function fallbackMacro() {
  return {
    source: 'fallback',
    asof: todayLabel(),
    regime: 'Live macro commentary is off. Set ANTHROPIC_API_KEY on the backend to get a daily written market read here. Your prices and grades still update from the data feed.',
    tape: [], drivers: [], readthrough: '',
  };
}
async function writeMacro() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || isMock()) return fallbackMacro();
  const today = todayLabel();
  const system =
    'You are a market strategist writing the daily macro section of a personal stock dashboard. ' +
    'Use web search to find TODAY\'s US market action and the day\'s key drivers, then return ONLY a JSON object ' +
    '(no markdown, no preamble) with this exact shape: ' +
    '{"asof": string, "regime": string (2-3 plain-English sentences on the current regime), ' +
    '"tape": [{"label": string, "value": string, "tone": "green"|"rose"|"gold"}] (3-4 index/vol moves like S&P, Nasdaq, Russell 2000, VIX), ' +
    '"drivers": [{"title": string, "stance": "Tailwind"|"Headwind"|"Watch", "note": string (1-2 sentences)}] (4-6 items spanning Fed/rates, inflation prints, major earnings, sector rotation, and geopolitics/oil as relevant), ' +
    '"readthrough": string (2-3 sentences on what it means for a tech/AI-heavy watchlist)}. ' +
    'Be concrete and current. No URLs, no hype, no advice verbs. asof must be "' + today + '".';
  const body = {
    model: MACRO_MDL, max_tokens: 1600, system,
    messages: [{ role: 'user', content: 'Write today\'s macro section. Today is ' + today + '. Search for the latest US market action (S&P 500, Nasdaq, Russell 2000, VIX levels and direction), Fed/rate expectations, any inflation data this week, major earnings, sector rotation, and oil/geopolitics, then return the JSON.' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
  };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const j = await res.json();
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const m = text.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(m ? m[0] : text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    obj.source = 'claude';
    if (!obj.asof) obj.asof = today;
    if (!Array.isArray(obj.tape)) obj.tape = [];
    if (!Array.isArray(obj.drivers)) obj.drivers = [];
    return obj;
  } catch (e) {
    const f = fallbackMacro(); f.error = String(e.message || e); return f;
  }
}

/* SERVER */
// ============================================================================
//  Weekly Monitor API — zero-dependency Node server.
//  Pulls live data, runs the scoring engine, serves clean JSON to the PWA.
//  Run:  node server.js           (MOCK auto-on if no API keys)
//        FMP_KEY=.. FINNHUB_KEY=.. node server.js   (live)
// ============================================================================





const PORT = process.env.PORT || 8787;
const TTL  = (+(process.env.CACHE_TTL_MIN || 10)) * 60 * 1000;
const cache = new Map(); // key -> { ts, data }

const fresh = (k) => { const c = cache.get(k); return c && (Date.now() - c.ts < TTL) ? c.data : null; };
const put   = (k, data) => { cache.set(k, { ts: Date.now(), data }); return data; };

const MACRO_TTL = (+(process.env.MACRO_TTL_MIN || 360)) * 60 * 1000; // default 6h
async function buildMacro() {
  const c = cache.get('macro');
  if (c && (Date.now() - c.ts < MACRO_TTL)) return c.data;
  const data = await writeMacro();
  cache.set('macro', { ts: Date.now(), data });
  return data;
}

// fetch every ticker once (throttled), score per list it belongs to
async function buildAll() {
  const hit = fresh('all'); if (hit) return hit;
  const raw = new Map();
  for (const u of UNIVERSE) {            // sequential = gentle on free-tier rate limits
    raw.set(u.ticker, await fetchTicker(u));
    if (!isMock()) await new Promise(r => setTimeout(r, 250));
  }
  const lists = {};
  for (const list of LISTS) {
    const rows = tickersFor(list).map(u => raw.get(u.ticker));
    lists[list] = scoreUniverse(rows, list);
  }
  // "Best Overall" = top composite across lists (note: cross-list curves differ — shown for convenience)
  const overall = Object.values(lists).flat()
    .sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1))
    .filter((v, i, arr) => arr.findIndex(x => x.ticker === v.ticker) === i)
    .slice(0, 12);

  // ---- Thesis layer: one batched Claude call (or deterministic fallback)
  const uniq = []; const seen = new Set();
  for (const lk of LISTS) for (const r of lists[lk]) if (!seen.has(r.ticker)) { seen.add(r.ticker); uniq.push(r); }
  const theses = await writeTheses(uniq);
  const attach = (r) => { r.thesis = theses[r.ticker] || null; return r; };
  for (const lk of LISTS) lists[lk].forEach(attach);
  overall.forEach(attach);
  const thesisSource = (!process.env.ANTHROPIC_API_KEY || isMock()) ? 'fallback' : (theses._error ? 'fallback (api error)' : 'claude');

  return put('all', { asof: new Date().toISOString(), mock: isMock(), thesisSource, lists, overall });
}

const send = (res, code, obj) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',            // PWA on another origin can read it
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, mock: isMock(), ttlMin: TTL / 60000 });
    if (url.pathname === '/api/config') return send(res, 200, {
      lists: LIST_PROFILE,
      note: 'weights per list sum to ~1; curve shifts the letter mapping (looser/stricter). Edit lib/scoring.js to change grades.',
      letterBands: { 'A': '≥86', 'A−': '≥80', 'B+': '≥74', 'B': '≥66', 'B−': '≥60', 'C+': '≥54', 'C': '≥46', 'C−': '<46' },
      signalRule: 'below 200-DMA -> CONFIRM (never "buy support" in a downtrend); at support + uptrend + not hot -> BUY; extended/overbought -> WAIT; thin data -> VERIFY',
    });
    if (url.pathname === '/api/monitor') return send(res, 200, await buildAll());
    if (url.pathname === '/api/macro') return send(res, 200, await buildMacro());
    const mList = url.pathname.match(/^\/api\/list\/(\w+)$/);
    if (mList) { const all = await buildAll(); const l = mList[1]; return l in all.lists ? send(res, 200, { list: l, rows: all.lists[l], asof: all.asof }) : send(res, 404, { error: 'unknown list' }); }
    const mTk = url.pathname.match(/^\/api\/ticker\/([A-Za-z.\-]+)$/);
    if (mTk) { const all = await buildAll(); const sym = mTk[1].toUpperCase(); const row = Object.values(all.lists).flat().find(r => r.ticker === sym); return row ? send(res, 200, row) : send(res, 404, { error: 'not in universe' }); }
    return send(res, 404, { error: 'not found', routes: ['/api/health', '/api/monitor', '/api/list/:list', '/api/ticker/:sym'] });
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`Weekly Monitor API on :${PORT}  (mock=${isMock()})`));
