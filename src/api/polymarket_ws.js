// src/api/polymarket_ws.js
// Polymarket CLOB WebSocket — Real-time Order Book Level 2
// Connects to wss://ws-subscriptions-clob.polymarket.com/ws/market
// Detects smart money flow, whale orders, and depth shifts
// No auth required for market channel

import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import dns from 'dns';

const WS_HOST = 'ws-subscriptions-clob.polymarket.com';
const WS_URL = `wss://${WS_HOST}/ws/market`;
// ISP DNS blocks Polymarket hosts. The REST client bypasses via dns.resolve4
// on 1.1.1.1, but `new WebSocket(url)` uses dns.lookup (getaddrinfo), which
// dns.setServers does NOT affect — so we pass a custom lookup that resolves
// through 1.1.1.1 explicitly. Same trick, right layer.
dns.setServers(['1.1.1.1', '8.8.8.8']);
function cfLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.resolve4(hostname, (err, addrs) => {
    if (err || !addrs?.length) return callback(err || new Error('no A records'));
    if (options && options.all) return callback(null, addrs.map(a => ({ address: a, family: 4 })));
    callback(null, addrs[0], 4);
  });
}
const HEARTBEAT_INTERVAL = 10_000; // 10s — Polymarket requirement
const RECONNECT_DELAY = 5_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const DIR = path.join(process.env.HOME, '.adan-pred');
const WHALE_LOG_PATH = path.join(DIR, 'whale_flow.jsonl');
const MAX_WHALE_LOG_LINES = 500;

// Whale detection thresholds
const WHALE_SIZE_THRESHOLD = 500;    // $500+ single level = whale
const DEPTH_SHIFT_THRESHOLD = 0.30;  // 30% depth change in one update = significant
const WALL_THRESHOLD = 2000;         // $2000+ at a single price = wall

export class PolymarketWS {

  constructor() {
    this.ws = null;
    this.heartbeatTimer = null;
    this.reconnectAttempts = 0;
    this.subscribedAssets = new Set();
    this.connected = false;

    // Live order book state per asset_id
    this.books = {};  // asset_id -> { bids: [], asks: [], lastUpdate: Date, spread: number }

    // Smart money signals (consumed by SNAKE/brain)
    this.signals = {}; // asset_id -> { whaleFlow, depthImbalance, wallDetected, ... }

    // Stats
    this.stats = { messagesReceived: 0, bookUpdates: 0, whalesDetected: 0, connectedSince: null };
  }

  // ── CONNECT ──
  connect(assetIds = []) {
    if (this.ws && this.connected) {
      // Already connected — just subscribe to new assets
      this._subscribe(assetIds);
      return;
    }

    try {
      this.ws = new WebSocket(WS_URL, { lookup: cfLookup, servername: WS_HOST, headers: { Host: WS_HOST } });

      this.ws.on('open', () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.stats.connectedSince = new Date().toISOString();
        console.log('[POLY-WS] 🔌 Connected to Polymarket CLOB WebSocket');

        // Subscribe to initial assets
        if (assetIds.length > 0) {
          this._subscribe(assetIds);
        }

        // Start heartbeat
        this._startHeartbeat();
      });

      this.ws.on('message', (raw) => {
        this.stats.messagesReceived++;
        try {
          const data = JSON.parse(raw.toString());
          this._handleMessage(data);
        } catch (e) {
          // Might be PONG or non-JSON — ignore
          const text = raw.toString();
          if (text !== 'PONG') {
            // Try parsing as array (Polymarket sometimes sends arrays)
            try {
              const arr = JSON.parse(text);
              if (Array.isArray(arr)) {
                for (const item of arr) this._handleMessage(item);
              }
            } catch {}
          }
        }
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        this._stopHeartbeat();
        console.log(`[POLY-WS] Connection closed (${code}). Reconnecting...`);
        this._reconnect();
      });

      this.ws.on('error', (err) => {
        console.log(`[POLY-WS] Error: ${err.message}`);
      });

    } catch (e) {
      console.log(`[POLY-WS] Failed to connect: ${e.message}`);
      this._reconnect();
    }
  }

  // ── SUBSCRIBE to market assets ──
  _subscribe(assetIds) {
    if (!this.ws || !this.connected) return;

    const newIds = assetIds.filter(id => !this.subscribedAssets.has(id));
    if (newIds.length === 0) return;

    // Polymarket allows max 500 assets per connection
    const toSubscribe = newIds.slice(0, 500 - this.subscribedAssets.size);

    const msg = JSON.stringify({
      assets_ids: toSubscribe,
      type: 'market',
      custom_feature_enabled: true,
    });

    this.ws.send(msg);
    for (const id of toSubscribe) this.subscribedAssets.add(id);
    console.log(`[POLY-WS] 📡 Subscribed to ${toSubscribe.length} assets (total: ${this.subscribedAssets.size})`);
  }

  // ── Add assets dynamically (called from main loop when new markets found) ──
  addAssets(assetIds) {
    if (!assetIds || assetIds.length === 0) return;
    if (!this.connected) {
      this.connect(assetIds);
      return;
    }
    this._subscribe(assetIds);
  }

  // ── HEARTBEAT — send PING every 10s ──
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.connected) {
        try {
          this.ws.ping(); // Standard WS control frame
          this.ws.send('{"type":"ping"}'); // App-level ping (Polymarket CLOB)
        } catch {}
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── RECONNECT with exponential backoff ──
  _reconnect() {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log('[POLY-WS] Max reconnect attempts reached. Will retry next scan cycle.');
      this.reconnectAttempts = 0;
      return;
    }

    this.reconnectAttempts++;
    const delay = RECONNECT_DELAY * Math.pow(1.5, this.reconnectAttempts - 1);
    console.log(`[POLY-WS] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    setTimeout(() => {
      const assets = [...this.subscribedAssets];
      this.subscribedAssets.clear();
      this.connect(assets);
    }, delay);
  }

  // ── HANDLE incoming messages ──
  _handleMessage(data) {
    if (!data || !data.event_type) return;

    if (data.event_type === 'book') {
      this._processBook(data);
    } else if (data.event_type === 'price_change') {
      this._processPriceChange(data);
    }
    // Ignore other event types for now (last_trade_price, etc)
  }

  // ── PROCESS order book snapshot/update ──
  _processBook(data) {
    const assetId = data.asset_id;
    if (!assetId) return;

    this.stats.bookUpdates++;

    const bids = (data.bids || []).map(b => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    })).sort((a, b) => b.price - a.price); // Best bid first

    const asks = (data.asks || []).map(a => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    })).sort((a, b) => a.price - b.price); // Best ask first

    const prevBook = this.books[assetId];

    // Calculate metrics
    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 1;
    const spread = bestAsk - bestBid;
    const midPrice = (bestBid + bestAsk) / 2;

    // Depth within 5 cents of mid
    const bidDepth = bids.filter(b => midPrice - b.price <= 0.05).reduce((s, b) => s + b.size, 0);
    const askDepth = asks.filter(a => a.price - midPrice <= 0.05).reduce((s, a) => s + a.size, 0);
    const totalDepth = bidDepth + askDepth;
    const depthImbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;
    // +1 = all bids (bullish), -1 = all asks (bearish)

    // Store book
    this.books[assetId] = {
      bids, asks, bestBid, bestAsk, spread, midPrice,
      bidDepth, askDepth, depthImbalance,
      lastUpdate: Date.now(),
    };

    // ── SMART MONEY DETECTION ──
    const signal = {
      depthImbalance: parseFloat(depthImbalance.toFixed(3)),
      spread: parseFloat(spread.toFixed(4)),
      bidDepth: Math.round(bidDepth),
      askDepth: Math.round(askDepth),
      bestBid, bestAsk, midPrice,
      whaleOrders: [],
      walls: [],
      depthShift: 0,
      smartMoneyDirection: 'NEUTRAL', // 'BUY', 'SELL', 'NEUTRAL'
      lastUpdate: Date.now(),
    };

    // Detect whale orders (large single-level size)
    for (const bid of bids) {
      if (bid.size >= WHALE_SIZE_THRESHOLD) {
        signal.whaleOrders.push({ side: 'BID', price: bid.price, size: Math.round(bid.size) });
      }
      if (bid.size >= WALL_THRESHOLD) {
        signal.walls.push({ side: 'BID', price: bid.price, size: Math.round(bid.size) });
      }
    }
    for (const ask of asks) {
      if (ask.size >= WHALE_SIZE_THRESHOLD) {
        signal.whaleOrders.push({ side: 'ASK', price: ask.price, size: Math.round(ask.size) });
      }
      if (ask.size >= WALL_THRESHOLD) {
        signal.walls.push({ side: 'ASK', price: ask.price, size: Math.round(ask.size) });
      }
    }

    // Detect depth shift (big change from previous snapshot)
    if (prevBook) {
      const prevTotal = prevBook.bidDepth + prevBook.askDepth;
      if (prevTotal > 0) {
        const bidChange = (bidDepth - prevBook.bidDepth) / Math.max(prevTotal, 1);
        const askChange = (askDepth - prevBook.askDepth) / Math.max(prevTotal, 1);
        signal.depthShift = parseFloat((bidChange - askChange).toFixed(3));

        if (Math.abs(signal.depthShift) >= DEPTH_SHIFT_THRESHOLD) {
          signal.smartMoneyDirection = signal.depthShift > 0 ? 'BUY' : 'SELL';
        }
      }
    }

    // Depth imbalance signal
    if (Math.abs(depthImbalance) > 0.3 && signal.smartMoneyDirection === 'NEUTRAL') {
      signal.smartMoneyDirection = depthImbalance > 0 ? 'BUY' : 'SELL';
    }

    this.signals[assetId] = signal;

    // Log whale events
    if (signal.whaleOrders.length > 0) {
      this.stats.whalesDetected++;
      this._logWhale(assetId, signal);
    }
  }

  // ── PROCESS price change events ──
  _processPriceChange(data) {
    const assetId = data.asset_id;
    if (!assetId || !this.signals[assetId]) return;

    // Update mid price from price change
    if (data.price) {
      this.signals[assetId].lastTradePrice = parseFloat(data.price);
    }
  }

  // ── LOG whale activity ──
  _logWhale(assetId, signal) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const entry = {
        ts: new Date().toISOString(),
        assetId: assetId.slice(0, 20) + '...',
        direction: signal.smartMoneyDirection,
        whales: signal.whaleOrders.length,
        walls: signal.walls.length,
        bidDepth: signal.bidDepth,
        askDepth: signal.askDepth,
        imbalance: signal.depthImbalance,
        spread: signal.spread,
      };
      fs.appendFileSync(WHALE_LOG_PATH, JSON.stringify(entry) + '\n');

      // Prune log
      try {
        const lines = fs.readFileSync(WHALE_LOG_PATH, 'utf8').trim().split('\n');
        if (lines.length > MAX_WHALE_LOG_LINES) {
          fs.writeFileSync(WHALE_LOG_PATH, lines.slice(-MAX_WHALE_LOG_LINES).join('\n') + '\n');
        }
      } catch {}
    } catch {}
  }

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC API — Used by ADAN brain/SNAKE
  // ═══════════════════════════════════════════════════════════════

  // Get smart money signal for a specific asset
  getSignal(assetId) {
    return this.signals[assetId] || null;
  }

  // Get order book for a specific asset
  getBook(assetId) {
    return this.books[assetId] || null;
  }

  // Get signal by searching across all subscribed assets (fuzzy match by partial ID)
  findSignal(partialId) {
    for (const [id, signal] of Object.entries(this.signals)) {
      if (id.includes(partialId) || partialId.includes(id.slice(0, 20))) {
        return signal;
      }
    }
    return null;
  }

  // Get prompt context for LLM (injected into brain prompts alongside SNAKE)
  getPromptContext(assetId) {
    const signal = this.signals[assetId];
    if (!signal) return '';

    const age = (Date.now() - signal.lastUpdate) / 1000;
    if (age > 120) return ''; // Stale data (>2min)

    const lines = ['━━━ POLYMARKET LIVE ORDER BOOK (WebSocket L2) ━━━'];
    lines.push(`Bid: ${signal.bestBid.toFixed(2)} | Ask: ${signal.bestAsk.toFixed(2)} | Spread: ${(signal.spread * 100).toFixed(1)}¢ | Mid: ${signal.midPrice.toFixed(3)}`);
    lines.push(`Depth: ${signal.bidDepth} bids vs ${signal.askDepth} asks | Imbalance: ${(signal.depthImbalance * 100).toFixed(0)}% ${signal.depthImbalance > 0.2 ? '(BID HEAVY)' : signal.depthImbalance < -0.2 ? '(ASK HEAVY)' : '(BALANCED)'}`);

    if (signal.smartMoneyDirection !== 'NEUTRAL') {
      lines.push(`⚡ SMART MONEY FLOW: ${signal.smartMoneyDirection} — depth shifted ${(signal.depthShift * 100).toFixed(0)}%`);
    }
    if (signal.whaleOrders.length > 0) {
      lines.push(`🐋 WHALE ORDERS: ${signal.whaleOrders.map(w => `${w.side} $${w.size} @${w.price.toFixed(2)}`).join(' | ')}`);
    }
    if (signal.walls.length > 0) {
      lines.push(`🧱 WALLS: ${signal.walls.map(w => `${w.side} $${w.size} @${w.price.toFixed(2)}`).join(' | ')}`);
    }

    return lines.join('\n');
  }

  // Summary for dashboard
  getStatus() {
    return {
      connected: this.connected,
      subscribedAssets: this.subscribedAssets.size,
      booksTracked: Object.keys(this.books).length,
      activeSignals: Object.values(this.signals).filter(s => Date.now() - s.lastUpdate < 120000).length,
      whalesDetected: this.stats.whalesDetected,
      messagesReceived: this.stats.messagesReceived,
      bookUpdates: this.stats.bookUpdates,
      connectedSince: this.stats.connectedSince,
    };
  }

  // Disconnect
  disconnect() {
    this._stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.subscribedAssets.clear();
    console.log('[POLY-WS] Disconnected');
  }
}

export const polymarketWS = new PolymarketWS();
