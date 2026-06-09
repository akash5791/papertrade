'use strict';

/* ── Constants ── */
const SK = 'papertrade_v4';
const INIT_NSE_BAL    = 500000;
const INIT_CRYPTO_BAL = 10000;

const NSE_SYMS = ['RELIANCE','TCS','INFY','HDFCBANK','ICICIBANK','WIPRO','SBIN','LT','BAJFINANCE','HCLTECH','MARUTI','ASIANPAINT','KOTAKBANK','AXISBANK','TITAN','ONGC','NTPC','POWERGRID','ADANIENT','ADANIPORTS'];
const CRYPTO_SYMS = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','DOT','MATIC','LINK','UNI','ATOM','LTC','BCH'];
const INDEX_TOKENS = { 'NIFTY 50': '26000', 'BANKNIFTY': '26009', 'FINNIFTY': '26037' };

const BASE_PRICES = {
  /* Indices */   '26000':24350, '26009':52100, '26037':23800,
  /* Equity */    'RELIANCE':2850,'TCS':4200,'INFY':1920,'HDFCBANK':1680,'ICICIBANK':1340,
                  'WIPRO':480,'SBIN':820,'LT':3600,'BAJFINANCE':7200,'HCLTECH':1950,
                  'MARUTI':12500,'ASIANPAINT':2900,'KOTAKBANK':1820,'AXISBANK':1150,'TITAN':3400,
                  'ONGC':290,'NTPC':360,'POWERGRID':320,'ADANIENT':2600,'ADANIPORTS':1400,
  /* Crypto */    'BTC':67000,'ETH':3500,'SOL':185,'BNB':580,'XRP':0.62,
                  'DOGE':0.18,'ADA':0.55,'AVAX':38,'DOT':8.5,'MATIC':0.9,
                  'LINK':18,'UNI':12,'ATOM':10,'LTC':88,'BCH':480
};

const NSE_LOT_SIZE = { 'NIFTY 50':50, 'BANKNIFTY':15, 'FINNIFTY':25 };

/* ── State ── */
function defaultState() {
  return {
    nse:    { balance: INIT_NSE_BAL,    trades: [], history: [], pnlHistory: [], apiCfg: null },
    crypto: { balance: INIT_CRYPTO_BAL, trades: [], history: [], pnlHistory: [] }
  };
}

let S           = loadState();
let mode        = 'nse';
let activeTab   = 'positions';
let tradeMode   = 'equity';   // nse: equity | options
let side        = 'buy';
let optType     = 'CE';
let authToken   = null;
let isLive      = false;
let liveQuotes  = {};
let pnlChart    = null;
let tickInterval= null;

/* ── Persistence ── */
function loadState() {
  try { const r = localStorage.getItem(SK); if (r) return JSON.parse(r); } catch(e) {}
  return defaultState();
}
function save() {
  try { localStorage.setItem(SK, JSON.stringify(S)); } catch(e) {}
}

/* ── Formatting ── */
function fmtINR(n, dp = 2) {
  const abs = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (n < 0 ? '-₹' : '₹') + abs;
}
function fmtUSD(n, dp = 2) {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (n < 0 ? '-$' : '$') + abs;
}
function fmt(n, m, dp) {
  return m === 'nse' ? fmtINR(n, dp) : fmtUSD(n, dp ?? (n < 10 ? 4 : 2));
}
function fmtPct(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function today() { return new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }); }
function nowTime() { return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

/* ── Prices ── */
function initPrices() {
  Object.entries(BASE_PRICES).forEach(([k, v]) => { if (!liveQuotes[k]) liveQuotes[k] = v; });
}
function tickPrice(key) {
  const base = BASE_PRICES[key] ?? liveQuotes[key] ?? 100;
  const volatility = base < 5 ? 0.008 : base < 100 ? 0.003 : 0.0015;
  const move = (Math.random() - 0.495) * base * volatility;
  liveQuotes[key] = Math.max(0.001, (liveQuotes[key] ?? base) + move);
}
function tickAll() {
  Object.keys(liveQuotes).forEach(tickPrice);
}
function getLTP(token) {
  return liveQuotes[token] ?? BASE_PRICES[token] ?? 0;
}

/* ── P&L calculation ── */
function tradePnl(t) {
  const cp  = getLTP(t.token);
  const diff = (cp - t.price) * t.qty;
  return t.dir === 'short' ? -diff : diff;
}
function totalPnl(m) {
  return (S[m].trades || []).reduce((a, t) => a + tradePnl(t), 0);
}
function portVal(m) {
  return (S[m].trades || []).reduce((a, t) => a + getLTP(t.token) * t.qty, 0);
}

/* ── Angel One login ── */
async function loginAngelOne(cfg) {
  try {
    const res = await fetch('https://apiconnect.angelbroking.com/rest/auth/angelbroking/user/v1/loginByPassword', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '192.168.1.1',
        'X-ClientPublicIP': '192.168.1.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'X-PrivateKey': cfg.apiKey
      },
      body: JSON.stringify({ clientcode: cfg.clientId, password: cfg.mpin, totp: cfg.totp })
    });
    const data = await res.json();
    if (data.status && data.data?.jwtToken) {
      authToken = data.data.jwtToken;
      isLive    = true;
      S.nse.apiCfg = cfg;
      save();
      return { ok: true };
    }
    return { ok: false, msg: data.message || 'Login failed' };
  } catch (e) {
    return { ok: false, msg: 'Network error — check CORS or run locally' };
  }
}

async function fetchAngelQuotes(tokens) {
  if (!authToken || !tokens.length) return;
  try {
    const res = await fetch('https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken,
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '192.168.1.1',
        'X-ClientPublicIP': '192.168.1.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'X-PrivateKey': S.nse.apiCfg?.apiKey || ''
      },
      body: JSON.stringify({ mode: 'LTP', exchangeTokens: { NSE: tokens } })
    });
    const data = await res.json();
    if (data.status && data.data?.fetched) {
      data.data.fetched.forEach(q => { liveQuotes[q.symbolToken] = parseFloat(q.ltp); });
    }
  } catch (e) { /* silently fall back to simulated */ }
}

/* ── Tick ── */
function onTick() {
  tickAll();
  const tp   = totalPnl(mode);
  const time = nowTime();
  S[mode].pnlHistory.push({ t: time, v: parseFloat(tp.toFixed(2)) });
  if (S[mode].pnlHistory.length > 80) S[mode].pnlHistory.shift();
  save();
  refreshDynamic();
}

/* ── Partial render (metrics + chart without full redraw) ── */
function refreshDynamic() {
  const tp    = totalPnl(mode);
  const pv    = portVal(mode);
  const init  = mode === 'nse' ? INIT_NSE_BAL : INIT_CRYPTO_BAL;
  const total = S[mode].balance + pv;
  const ret   = ((total - init) / init) * 100;

  const me = document.getElementById('metrics-area');
  if (me) me.innerHTML = metricsHTML(tp, total, ret);

  const tb = document.getElementById('ticker-area');
  if (tb) tb.innerHTML = tickerHTML();

  if (activeTab === 'positions') {
    const pt = document.getElementById('pos-table');
    if (pt) pt.innerHTML = posTableHTML();
  }

  if (activeTab === 'chart') updateChart();
}

/* ── Render helpers ── */
function tickerHTML() {
  const items = mode === 'nse'
    ? [{ name: 'NIFTY 50', key: '26000' }, { name: 'BANKNIFTY', key: '26009' }, { name: 'FINNIFTY', key: '26037' }, { name: 'SENSEX', key: '99926004' }]
    : [{ name: 'BTC', key: 'BTC' }, { name: 'ETH', key: 'ETH' }, { name: 'SOL', key: 'SOL' }, { name: 'BNB', key: 'BNB' }];

  return items.map(it => {
    const p    = getLTP(it.key);
    const base = BASE_PRICES[it.key] ?? p;
    const chg  = ((p - base) / base) * 100;
    return `<div class="ticker-item">
      <span class="ticker-name">${it.name}</span>
      <span class="ticker-price">${fmt(p, mode, mode === 'nse' ? 2 : (p < 10 ? 4 : 2))}</span>
      <span class="ticker-chg ${chg >= 0 ? 'up' : 'dn'}">${fmtPct(chg)}</span>
    </div>`;
  }).join('');
}

function metricsHTML(tp, total, ret) {
  return `
    <div class="metric"><div class="metric-label">Total assets</div><div class="metric-val">${fmt(total, mode)}</div></div>
    <div class="metric"><div class="metric-label">Unrealised P&L</div><div class="metric-val ${tp >= 0 ? 'pos' : 'neg'}">${fmt(tp, mode)}</div></div>
    <div class="metric"><div class="metric-label">Return</div><div class="metric-val ${ret >= 0 ? 'pos' : 'neg'}">${fmtPct(ret)}</div></div>
    <div class="metric"><div class="metric-label">Open positions</div><div class="metric-val">${S[mode].trades.length}</div></div>
  `;
}

function posTableHTML() {
  const trades = S[mode].trades;
  if (!trades.length) return `<div class="empty"><div class="empty-icon">📭</div><strong>No open positions</strong><p>Use the order form to place a trade →</p></div>`;

  return `<table class="tbl">
    <thead><tr>
      <th>Symbol</th><th>Type</th><th>Side</th><th>Qty</th>
      <th>Avg price</th><th>LTP</th><th>P&L</th><th></th>
    </tr></thead>
    <tbody>
      ${trades.map((t, i) => {
        const ltp = getLTP(t.token);
        const p   = tradePnl(t);
        const pct = ((ltp - t.price) / t.price) * 100;
        return `<tr>
          <td><span class="sym-cell">${t.sym}</span>${t.optType ? ` <span class="badge badge-${t.optType.toLowerCase()}">${t.optType}</span>` : ''}</td>
          <td><span class="badge badge-${t.type === 'options' ? 'opt' : 'eq'}">${t.type}</span></td>
          <td><span class="badge badge-${t.dir}">${t.dir}</span></td>
          <td class="num-cell">${t.type === 'equity' && mode === 'crypto' ? t.qty.toFixed(4) : t.qty}</td>
          <td class="num-cell">${fmt(t.price, mode)}</td>
          <td class="num-cell" style="color:${ltp >= t.price ? 'var(--green)' : 'var(--red)'}">${fmt(ltp, mode)}</td>
          <td class="num-cell" style="color:${p >= 0 ? 'var(--green)' : 'var(--red)'}">
            ${fmt(p, mode)}<br><span style="font-size:10px;opacity:0.7">${fmtPct(pct)}</span>
          </td>
          <td><button class="xbtn" onclick="closeTrade(${i})" title="Close position">✕</button></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

function historyHTML() {
  const h   = S[mode].history;
  if (!h.length) return `<div class="empty"><div class="empty-icon">🕐</div><strong>No closed trades yet</strong><p>Close a position to see history here.</p></div>`;
  const rp  = h.reduce((a, x) => a + x.pnl, 0);
  const wins = h.filter(x => x.pnl > 0).length;
  return `
    <div class="hist-stats">
      <div class="hstat"><div class="hstat-label">Realised P&L</div><div class="hstat-val ${rp >= 0 ? 'pos' : 'neg'}">${fmt(rp, mode)}</div></div>
      <div class="hstat"><div class="hstat-label">Win rate</div><div class="hstat-val">${Math.round(wins / h.length * 100)}%</div></div>
      <div class="hstat"><div class="hstat-label">Trades</div><div class="hstat-val">${h.length}</div></div>
    </div>
    <table class="tbl">
      <thead><tr><th>Symbol</th><th>Type</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Date</th></tr></thead>
      <tbody>
        ${h.map(x => `<tr>
          <td class="sym-cell">${x.sym}</td>
          <td><span class="badge badge-${x.type === 'options' ? 'opt' : 'eq'}">${x.type}</span></td>
          <td class="num-cell">${x.qty}</td>
          <td class="num-cell">${fmt(x.entry, mode)}</td>
          <td class="num-cell">${fmt(x.exit, mode)}</td>
          <td class="num-cell" style="color:${x.pnl >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:600">${fmt(x.pnl, mode)}</td>
          <td style="color:var(--text3)">${x.date}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}

function chartTabHTML() {
  return `
    <div class="sec-title">Unrealised P&L — last 80 ticks</div>
    <div class="chart-wrap"><canvas id="pnlCanvas" role="img" aria-label="P&L over time line chart">P&L history chart</canvas></div>
  `;
}

function orderFormHTML() {
  const isNse    = mode === 'nse';
  const isOpt    = tradeMode === 'options';
  const syms     = isNse ? NSE_SYMS : CRYPTO_SYMS;
  const idxSyms  = ['NIFTY 50', 'BANKNIFTY', 'FINNIFTY'];

  const expiries = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date();
    d.setDate(d.getDate() + ((4 - d.getDay() + 7) % 7) + i * 7);
    expiries.push(d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }));
  }

  return `
    <div class="sec-title">Order</div>

    ${isNse ? `<div class="seg-row" style="margin-bottom:4px">
      <button class="seg-btn ${tradeMode === 'equity'  ? 'active' : ''}" onclick="setTradeMode('equity')">Equity</button>
      <button class="seg-btn ${tradeMode === 'options' ? 'active' : ''}" onclick="setTradeMode('options')">F&amp;O</button>
    </div>` : ''}

    <div class="side-toggle">
      <button class="stab ${side === 'buy'  ? 'active-buy'  : ''}" onclick="setSide('buy')">▲ Buy</button>
      <button class="stab ${side === 'sell' ? 'active-sell' : ''}" onclick="setSide('sell')">▼ Sell</button>
    </div>

    ${isOpt ? `
      <div class="form-group">
        <label class="form-label">Index</label>
        <select id="o-sym">${idxSyms.map(s => `<option value="${s}">${s}</option>`).join('')}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Expiry</label>
        <select id="o-expiry">${expiries.map(e => `<option value="${e}">${e}</option>`).join('')}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Strike price (₹)</label>
        <input id="o-strike" type="number" step="50" placeholder="e.g. 24400" />
      </div>
      <div class="form-group">
        <label class="form-label">Option type</label>
        <div class="seg-row">
          <button class="seg-btn ${optType === 'CE' ? 'active-ce' : ''}" onclick="setOptType('CE')" style="flex:1;text-align:center">CE — Call</button>
          <button class="seg-btn ${optType === 'PE' ? 'active-pe' : ''}" onclick="setOptType('PE')" style="flex:1;text-align:center">PE — Put</button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Premium ₹ / unit</label>
        <input id="o-price" type="number" step="0.05" placeholder="e.g. 120.50" oninput="calcTotal()" />
      </div>
      <div class="form-group">
        <label class="form-label">Lots (1 lot = ${getLotSize()} units)</label>
        <input id="o-qty" type="number" step="1" min="1" value="1" oninput="calcTotal()" />
      </div>
    ` : `
      <div class="form-group">
        <label class="form-label">Symbol</label>
        <select id="o-sym" onchange="onSymChange(this)">
          ${syms.map(s => `<option value="${s}">${s}</option>`).join('')}
          <option value="__custom__">Custom…</option>
        </select>
      </div>
      <div class="form-group" id="custom-wrap" style="display:none">
        <label class="form-label">Custom symbol</label>
        <input id="o-custom" type="text" placeholder="${isNse ? 'e.g. ONGC' : 'e.g. PEPE'}" />
      </div>
      <div class="form-group">
        <label class="form-label">Price (${isNse ? '₹' : '$'})</label>
        <input id="o-price" type="number" step="${isNse ? '0.05' : '0.0001'}" placeholder="0.00" oninput="calcTotal()" />
      </div>
      <div class="form-group">
        <label class="form-label">${isNse ? 'Quantity (shares)' : 'Quantity (units)'}</label>
        <input id="o-qty" type="number" step="${isNse ? '1' : '0.0001'}" placeholder="${isNse ? '10' : '0.1'}" oninput="calcTotal()" />
      </div>
    `}

    <div class="total-line" id="o-total"></div>
    <button class="${side === 'buy' ? 'btn-buy' : 'btn-sell'}" onclick="placeOrder()">
      ${side === 'buy' ? '▲ Buy' : '▼ Sell'} ${isOpt ? 'Option' : isNse ? 'Shares' : mode === 'crypto' ? 'Crypto' : ''}
    </button>
    <div class="err-msg" id="o-err"></div>
    <div class="divider"></div>
    <button class="btn-reset" onclick="doReset()">↺ Reset ${mode === 'nse' ? 'NSE' : 'Crypto'} portfolio</button>
  `;
}

function getLotSize() {
  const sym = document.getElementById('o-sym')?.value || 'NIFTY 50';
  return NSE_LOT_SIZE[sym] ?? 50;
}

/* ── Full render ── */
function render() {
  const tp    = totalPnl(mode);
  const pv    = portVal(mode);
  const init  = mode === 'nse' ? INIT_NSE_BAL : INIT_CRYPTO_BAL;
  const total = S[mode].balance + pv;
  const ret   = ((total - init) / init) * 100;

  document.getElementById('root').innerHTML = `
    <div class="app">
      <!-- Nav -->
      <nav class="nav">
        <div class="nav-left">
          <div class="logo">Paper<span>Trade</span></div>
          <div class="mode-tabs">
            <button class="mode-tab ${mode === 'nse'    ? 'active-nse'    : ''}" onclick="setMode('nse')">🇮🇳 NSE</button>
            <button class="mode-tab ${mode === 'crypto' ? 'active-crypto' : ''}" onclick="setMode('crypto')">₿ Crypto</button>
          </div>
        </div>
        <div class="nav-right">
          <span style="font-size:11px;color:var(--text3)">
            <span class="${isLive ? 'dot-live' : 'dot-sim'}"></span>${isLive ? 'Live — Angel One' : 'Simulated'}
          </span>
          ${mode === 'nse' && !isLive ? `<button class="btn-connect" onclick="showApiModal()">⚡ Connect Angel One</button>` : ''}
          ${mode === 'nse' && isLive  ? `<span style="font-size:11px;color:var(--green)">✓ Connected</span>` : ''}
          <div class="balance-chip">Cash: <strong>${fmt(S[mode].balance, mode)}</strong></div>
        </div>
      </nav>

      <!-- Ticker -->
      <div class="ticker-bar" id="ticker-area">${tickerHTML()}</div>

      <!-- Metrics -->
      <div class="metrics" id="metrics-area">${metricsHTML(tp, total, ret)}</div>

      <!-- Body -->
      <div class="main">
        <div class="content-panel">
          <div class="content-tabs">
            <button class="ctab ${activeTab === 'positions' ? 'active' : ''}" onclick="setTab('positions')">Positions</button>
            <button class="ctab ${activeTab === 'history'   ? 'active' : ''}" onclick="setTab('history')">History</button>
            <button class="ctab ${activeTab === 'chart'     ? 'active' : ''}" onclick="setTab('chart')">P&L chart</button>
          </div>
          ${activeTab === 'positions' ? `<div id="pos-table">${posTableHTML()}</div>` : ''}
          ${activeTab === 'history'   ? historyHTML()   : ''}
          ${activeTab === 'chart'     ? chartTabHTML()  : ''}
        </div>
        <div class="side-panel" id="order-form">${orderFormHTML()}</div>
      </div>
    </div>
  `;

  if (activeTab === 'chart') setTimeout(initChart, 60);
}

/* ── Chart ── */
function initChart() {
  const canvas = document.getElementById('pnlCanvas');
  if (!canvas) return;
  if (pnlChart) { pnlChart.destroy(); pnlChart = null; }
  const hist = S[mode].pnlHistory;
  const last = hist[hist.length - 1]?.v ?? 0;
  pnlChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: hist.map(p => p.t),
      datasets: [{
        label: 'P&L',
        data: hist.map(p => p.v),
        borderColor: last >= 0 ? '#00c896' : '#ff4f5e',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 10, family: 'JetBrains Mono' }, maxTicksLimit: 8, color: '#555d66' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { font: { size: 10, family: 'JetBrains Mono' }, color: '#555d66', callback: v => fmt(v, mode, 0) }, grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
}

function updateChart() {
  if (!pnlChart) return;
  const hist = S[mode].pnlHistory;
  const last = hist[hist.length - 1]?.v ?? 0;
  pnlChart.data.labels                        = hist.map(p => p.t);
  pnlChart.data.datasets[0].data              = hist.map(p => p.v);
  pnlChart.data.datasets[0].borderColor       = last >= 0 ? '#00c896' : '#ff4f5e';
  pnlChart.update('none');
}

/* ── Modal ── */
function showApiModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'api-modal';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">
        Connect Angel One SmartAPI
        <button class="xbtn" onclick="document.getElementById('api-modal').remove()">✕</button>
      </div>
      <div class="modal-hint">
        Generate API key at <a href="https://smartapi.angelbroking.com" target="_blank">smartapi.angelbroking.com</a><br>
        TOTP secret: My Profile → Security → Authenticator → copy raw secret key
      </div>
      <div class="modal-grid">
        <div class="form-group"><label class="form-label">API Key</label><input id="cfg-key" type="text" placeholder="Your SmartAPI key" /></div>
        <div class="form-group"><label class="form-label">Client ID</label><input id="cfg-client" type="text" placeholder="e.g. A123456" /></div>
        <div class="form-group"><label class="form-label">MPIN</label><input id="cfg-mpin" type="password" placeholder="4-digit trading PIN" /></div>
        <div class="form-group"><label class="form-label">TOTP (current 6-digit code)</label><input id="cfg-totp" type="text" placeholder="123456" maxlength="6" /></div>
        <div class="err-msg" id="cfg-err"></div>
        <div class="modal-actions">
          <button class="btn-primary" id="cfg-submit" onclick="doLogin()">⚡ Connect &amp; fetch live prices</button>
          <button class="btn-secondary" onclick="document.getElementById('api-modal').remove()">Keep using simulated prices</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

/* ── Event handlers ── */
window.setMode = function(m) { mode = m; tradeMode = 'equity'; side = 'buy'; activeTab = 'positions'; render(); };
window.setTab  = function(t) { activeTab = t; render(); };
window.setTradeMode = function(m) { tradeMode = m; render(); };
window.setSide = function(s) { side = s; reRenderForm(); };
window.setOptType = function(t) { optType = t; reRenderForm(); };
window.showApiModal = showApiModal;
window.onSymChange = function(el) {
  const cw = document.getElementById('custom-wrap');
  if (cw) cw.style.display = el.value === '__custom__' ? 'flex' : 'none';
};

function reRenderForm() {
  const fp = document.getElementById('order-form');
  if (fp) fp.innerHTML = orderFormHTML();
}

window.calcTotal = function() {
  const p   = parseFloat(document.getElementById('o-price')?.value);
  const q   = parseFloat(document.getElementById('o-qty')?.value);
  const el  = document.getElementById('o-total');
  if (!el) return;
  if (p > 0 && q > 0) {
    const units = tradeMode === 'options' ? q * getLotSize() : q;
    el.textContent = 'Order total: ' + fmt(p * units, mode);
  } else el.textContent = '';
};

window.placeOrder = function() {
  const err    = document.getElementById('o-err');
  const price  = parseFloat(document.getElementById('o-price')?.value);
  const qtyRaw = parseFloat(document.getElementById('o-qty')?.value);
  const isOpt  = tradeMode === 'options';
  const lotSz  = isOpt ? getLotSize() : 1;
  const qty    = qtyRaw * lotSz;

  let symEl = document.getElementById('o-sym');
  let sym   = symEl?.value === '__custom__'
    ? document.getElementById('o-custom')?.value?.trim().toUpperCase()
    : symEl?.value;

  if (!sym)           { err.textContent = 'Select a symbol';       return; }
  if (!price || price <= 0) { err.textContent = 'Enter a valid price'; return; }
  if (!qty   || qty   <= 0) { err.textContent = 'Enter valid quantity'; return; }

  const cost = price * qty;
  if (side === 'buy' && cost > S[mode].balance) {
    err.textContent = `Insufficient funds — need ${fmt(cost, mode)}`; return;
  }

  let label = sym;
  let token = sym;

  if (isOpt) {
    const strike = document.getElementById('o-strike')?.value;
    const expiry = document.getElementById('o-expiry')?.value;
    if (!strike) { err.textContent = 'Enter strike price'; return; }
    label = `${sym} ${strike}${optType} ${expiry}`;
    token = label;
  }

  if (side === 'buy') S[mode].balance -= cost;

  if (!liveQuotes[token]) liveQuotes[token] = price;

  S[mode].trades.push({
    sym: label, type: isOpt ? 'options' : 'equity',
    optType: isOpt ? optType : null,
    price, qty, token,
    dir: side === 'buy' ? 'long' : 'short'
  });

  S[mode].pnlHistory.push({ t: nowTime(), v: parseFloat(totalPnl(mode).toFixed(2)) });
  save();
  err.textContent = '';
  render();
};

window.closeTrade = function(i) {
  const t  = S[mode].trades[i];
  const ep = getLTP(t.token);
  const p  = tradePnl(t);
  S[mode].balance += ep * t.qty;
  S[mode].history.unshift({ sym: t.sym, type: t.type, qty: t.qty, entry: t.price, exit: ep, pnl: p, dir: t.dir, date: today() });
  S[mode].trades.splice(i, 1);
  S[mode].pnlHistory.push({ t: nowTime(), v: parseFloat(totalPnl(mode).toFixed(2)) });
  save();
  render();
};

window.doReset = function() {
  const label = mode === 'nse' ? '₹5,00,000' : '$10,000';
  if (confirm(`Reset ${mode.toUpperCase()} portfolio and restore ${label}?`)) {
    const cfg = S.nse.apiCfg;
    S[mode] = mode === 'nse'
      ? { balance: INIT_NSE_BAL,    trades: [], history: [], pnlHistory: [], apiCfg: cfg }
      : { balance: INIT_CRYPTO_BAL, trades: [], history: [], pnlHistory: [] };
    if (pnlChart) { pnlChart.destroy(); pnlChart = null; }
    save();
    render();
  }
};

window.doLogin = async function() {
  const btn = document.getElementById('cfg-submit');
  const err = document.getElementById('cfg-err');
  const cfg = {
    apiKey:   document.getElementById('cfg-key')?.value?.trim(),
    clientId: document.getElementById('cfg-client')?.value?.trim(),
    mpin:     document.getElementById('cfg-mpin')?.value?.trim(),
    totp:     document.getElementById('cfg-totp')?.value?.trim()
  };
  if (!cfg.apiKey || !cfg.clientId || !cfg.mpin || !cfg.totp) {
    err.textContent = 'All fields are required'; return;
  }
  btn.textContent = 'Connecting…'; btn.disabled = true;
  const result = await loginAngelOne(cfg);
  if (result.ok) {
    document.getElementById('api-modal')?.remove();
    render();
  } else {
    err.textContent = result.msg;
    btn.textContent = '⚡ Connect & fetch live prices';
    btn.disabled    = false;
  }
};

/* ── Boot ── */
initPrices();

if (tickInterval) clearInterval(tickInterval);
tickInterval = setInterval(onTick, 2000);

render();
