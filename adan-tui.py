#!/usr/bin/env python3
"""
ADAN BLOOMBERG TERMINAL v6.0
Dense 5-panel trading dashboard with native Brier Protocol integration.
Keys: 1-9 focus panels | r refresh | q quit
"""
import json
import os
import time
from datetime import datetime, timezone

import httpx
from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal, Vertical, ScrollableContainer
from textual.widgets import Static, DataTable, Log
from textual.reactive import reactive
from textual import work

API_BASE = "http://localhost:3141"
DIR      = os.path.expanduser("~/.adan-pred")
LOG_FILE = os.path.join(DIR, "adan.log")

# ── Helpers ───────────────────────────────────────────────────────────────────

def load_json(filename):
    try:
        with open(os.path.join(DIR, filename)) as f:
            return json.load(f)
    except Exception:
        return {}

def load_jsonl_tail(filename, n=50):
    try:
        with open(os.path.join(DIR, filename)) as f:
            lines = f.readlines()
        out = []
        for l in lines[-n:]:
            try: out.append(json.loads(l.strip()))
            except Exception: pass
        return out
    except Exception:
        return []

def spark(values, width=16):
    if not values:
        return "[#333333]── no data ──[/]"
    chars = " ▁▂▃▄▅▆▇█"
    mn, mx = min(values), max(values)
    rng = mx - mn if mx != mn else 1
    r = ""
    for v in values[-width:]:
        idx = max(0, min(8, int(((v - mn) / rng) * 8)))
        r += f"[{'#00ff44' if v >= 0 else '#ff3322'}]{chars[idx]}[/]"
    return r

def gauge(val, mx=100, w=10, col="#ff8800"):
    pct   = max(0.0, min(1.0, val / max(mx, 1e-9)))
    filled = round(pct * w)
    return f"[{col}]{'█' * filled}[/][#222222]{'░' * (w - filled)}[/]"

def bc(b):  # brier colour
    return "#00ff44" if b <= 0.18 else "#ffaa00" if b <= 0.22 else "#ff3322"

PULSE  = ["◉", "◎", "◉", "●", "◉", "◎"]
HEART  = ["♡", "♥", "♡", "♥♥", "♡", "♥"]
BRAIN  = ["◈", "◇", "◈", "◆", "◈", "◇"]

# ── CSS ───────────────────────────────────────────────────────────────────────

CSS = """
Screen {
    background: #050505;
    color: #ff8800;
}

/* ── Header ticker strip ── */
#header-bar {
    height: 1;
    background: #ff8800;
    color: #000000;
    text-style: bold;
    layout: horizontal;
}
.hd { width: 1fr; content-align: center middle; }

/* ── Main 5×4 grid ── */
#main-grid {
    layout: grid;
    grid-size: 5 4;
    grid-rows: 1fr 1fr 1fr 8;
    grid-columns: 1fr 1fr 1fr 1fr 1fr;
    margin: 0;
    padding: 0;
}

/* Grid placement */
#panel-vault      { row-span: 2; }
#panel-positions  { column-span: 2; }
#panel-history    { column-span: 2; }
#panel-voice      { column-span: 2; }
#panel-brier-log  { column-span: 2; }
#panel-logs       { column-span: 5; }

/* Panel chrome */
.panel {
    border: round #2a2a2a;
    background: #050505;
    padding: 0 1;
    margin: 0;
}
.panel:focus { border: round #ff8800; }

/* Title bars — Bloomberg palette */
.t-amber  { color: #000; text-style: bold; background: #ff8800; text-align: center; width: 100%; }
.t-green  { color: #000; text-style: bold; background: #008833; text-align: center; width: 100%; }
.t-gold   { color: #000; text-style: bold; background: #cc9900; text-align: center; width: 100%; }
.t-cyan   { color: #000; text-style: bold; background: #007799; text-align: center; width: 100%; }
.t-purple { color: #fff; text-style: bold; background: #551199; text-align: center; width: 100%; }
.t-red    { color: #fff; text-style: bold; background: #991111; text-align: center; width: 100%; }
.t-blue   { color: #fff; text-style: bold; background: #113399; text-align: center; width: 100%; }

DataTable { height: 1fr; background: #050505; color: #ff8800; }
DataTable > .datatable--header { background: #140a00; color: #ff8800; text-style: bold; }
DataTable > .datatable--cursor { background: #251200; }
Log { height: 1fr; color: #cc6600; background: #020202; }
#voice-scroll { height: 1fr; }
"""

# ── App ───────────────────────────────────────────────────────────────────────

class BloombergV6(App):
    CSS     = CSS
    TITLE   = "ADAN BLOOMBERG TERMINAL v6.0"
    BINDINGS = [
        ("q", "quit",            "Quit"),
        ("r", "force_refresh",   "Refresh"),
        ("1", "focus_panel('panel-vault')",     "Vault"),
        ("2", "focus_panel('panel-positions')", "Positions"),
        ("3", "focus_panel('panel-brier')",     "Brier"),
        ("4", "focus_panel('panel-regime')",    "Regime"),
        ("5", "focus_panel('panel-history')",   "History"),
        ("6", "focus_panel('panel-brain')",     "Brain"),
        ("7", "focus_panel('panel-voice')",     "Voice"),
        ("8", "focus_panel('panel-children')",  "Children"),
        ("9", "focus_panel('panel-brier-log')", "Brier Log"),
    ]

    tick = reactive(0)

    def compose(self) -> ComposeResult:
        # ── TICKER STRIP ──────────────────────────────────────────────────────
        with Horizontal(id="header-bar"):
            yield Static(" ADAN BLOOMBERG v6.0 ", classes="hd")
            yield Static("…", id="hd-prices",  classes="hd")
            yield Static("…", id="hd-brier",   classes="hd")
            yield Static("…", id="hd-mode",    classes="hd")
            yield Static("…", id="hd-clock",   classes="hd")

        with Container(id="main-grid"):

            # ── COL 1 ROWS 1-2: SOVEREIGN VAULT (row-span:2) ─────────────────
            with Vertical(id="panel-vault", classes="panel"):
                yield Static(" SOVEREIGN VAULT ", classes="t-amber")
                yield Static("…", id="vault-data")

            # ── ROW 1 COLS 2-3: ACTIVE ORDER BOOK ────────────────────────────
            with Vertical(id="panel-positions", classes="panel"):
                yield Static(" ACTIVE ORDER BOOK ", classes="t-green")
                yield DataTable(id="dt-pos")

            # ── ROW 1 COL 4: BRIER PROTOCOL ──────────────────────────────────
            with Vertical(id="panel-brier", classes="panel"):
                yield Static(" BRIER PROTOCOL ", classes="t-gold")
                yield Static("…", id="brier-data")

            # ── ROW 1 COL 5: MARKET REGIME ───────────────────────────────────
            with Vertical(id="panel-regime", classes="panel"):
                yield Static(" MARKET REGIME ", classes="t-cyan")
                yield Static("…", id="regime-data")

            # ── ROW 2 COLS 2-3: RECENT SETTLEMENTS ───────────────────────────
            with Vertical(id="panel-history", classes="panel"):
                yield Static(" RECENT SETTLEMENTS ", classes="t-amber")
                yield DataTable(id="dt-hist")

            # ── ROW 2 COL 4: NEURAL BRAIN ────────────────────────────────────
            with Vertical(id="panel-brain", classes="panel"):
                yield Static(" NEURAL BRAIN ", classes="t-purple")
                yield Static("…", id="brain-data")

            # ── ROW 2 COL 5: EVOLUTION ───────────────────────────────────────
            with Vertical(id="panel-evolution", classes="panel"):
                yield Static(" EVOLUTION ", classes="t-purple")
                yield Static("…", id="evo-data")

            # ── ROW 3 COLS 1-2: ADAN VOICE ───────────────────────────────────
            with Vertical(id="panel-voice", classes="panel"):
                yield Static(" ADAN VOICE — Messages to Lord ", classes="t-red")
                with ScrollableContainer(id="voice-scroll"):
                    yield Static("…", id="voice-data")

            # ── ROW 3 COL 3: CHILDREN SWARM ──────────────────────────────────
            with Vertical(id="panel-children", classes="panel"):
                yield Static(" CHILDREN SWARM ", classes="t-blue")
                yield Static("…", id="children-data")

            # ── ROW 3 COLS 4-5: BRIER TRADE LOG ──────────────────────────────
            with Vertical(id="panel-brier-log", classes="panel"):
                yield Static(" BRIER TRADE LOG ", id="brier-log-title", classes="t-gold")
                yield DataTable(id="dt-brier")

            # ── ROW 4 FULL: NEUROLOGICAL STREAM ──────────────────────────────
            with Vertical(id="panel-logs", classes="panel"):
                yield Static(" NEUROLOGICAL STREAM ", classes="t-amber")
                yield Log(id="live-log", highlight=True)

    def on_mount(self) -> None:
        self.query_one("#dt-pos",  DataTable).add_columns("Market", "Sd", "Stake", "Edge%", "Conf", "T-Left")
        self.query_one("#dt-hist", DataTable).add_columns("Time", "Asset", "Sd", "Result", "PnL", "Edge%")
        self.query_one("#dt-brier",DataTable).add_columns("Time", "Market", "Sd", "Entry", "Amt")
        self._frame = 0
        self.set_interval(2.0, self.refresh_data)
        self.set_interval(0.8, self.pulse_tick)
        self.tail_log()

    def pulse_tick(self) -> None:
        self._frame = (self._frame + 1) % len(PULSE)
        self.tick   = self._frame
        try:
            self.query_one("#hd-clock", Static).update(
                f"[b]{datetime.now().strftime('%H:%M:%S')}[/]  UTC{datetime.now(timezone.utc).strftime('%H:%M')}"
            )
        except Exception:
            pass

    def action_force_refresh(self) -> None:
        self.refresh_data()

    def action_focus_panel(self, panel_id: str) -> None:
        try:
            self.query_one(f"#{panel_id}").focus()
        except Exception:
            pass

    # ── DATA REFRESH ──────────────────────────────────────────────────────────

    @work(exclusive=True, thread=True)
    def refresh_data(self) -> None:
        state, metrics = {}, {}
        try:
            with httpx.Client(timeout=4.0) as client:
                state   = client.get(f"{API_BASE}/api/state").json()
                metrics = client.get(f"{API_BASE}/api/training-metrics").json()
        except Exception:
            pass

        local = {
            "pnl":          load_json("pnl.json"),
            "regime":       load_json("market_regime.json"),
            "evolution":    load_json("evolution_params.json"),
            "moe":          load_json("moe_weights.json"),
            "metacalib":    load_json("metacalib.json"),
            "soul_rules":   load_json("soul_rules.json"),
            "soul_memory":  load_json("soul_memory_v2.json"),
            "messages":     load_json("lord_messages.json"),
            "online":       load_json("online_model.json"),
            "ensemble":     load_json("ensemble_weights.json"),
            "positions":    load_json("positions.json"),
            "monologue":    load_jsonl_tail("inner_monologue.jsonl", 3),
            "forecast":     load_json("forecast_stats.json"),
            "config":       load_json("config.json"),
            "pin":          load_json("pin_scores.json"),
            "brier_status": load_json("brier_status.json"),
            "brier_trades": load_jsonl_tail("brier_reported.jsonl", 50),
        }
        self.call_from_thread(self.update_all, state, metrics, local)

    # ── UI UPDATE ─────────────────────────────────────────────────────────────

    def update_all(self, state, metrics, local):
        try:
            self._do_update(state, metrics, local)
        except Exception as e:
            try: self.query_one("#vault-data", Static).update(f"[#ff3322]UI Error: {e}[/]")
            except Exception: pass

    def _do_update(self, state, metrics, local):
        frame = getattr(self, "_frame", 0)
        pulse = PULSE[frame % len(PULSE)]
        heart = HEART[frame % len(HEART)]
        brain = BRAIN[frame % len(BRAIN)]

        # ── Base metrics ──
        pnl      = local.get("pnl", {}) or state.get("pnl", {})
        pos      = local.get("positions", {}) or state.get("positions", {})
        trades   = pnl.get("trades", 0)
        wins     = pnl.get("wins", 0)
        fund     = pnl.get("fund", 10000)
        net      = fund - 10000
        wr       = (wins / max(1, trades)) * 100
        brier_l  = pnl.get("brierScore", 0.25)
        streak   = pnl.get("streak", 0)
        open_pos = pos.get("open",   []) if isinstance(pos, dict) else []
        closed   = pos.get("closed", []) if isinstance(pos, dict) else []
        now      = datetime.now(timezone.utc)
        today_s  = now.strftime("%Y-%m-%d")

        today_T  = [t for t in closed if (t.get("resolvedAt") or t.get("entryTime") or "").startswith(today_s)]
        today_W  = len([t for t in today_T if t.get("result") == "WIN"])
        today_wr = (today_W / max(1, len(today_T))) * 100
        today_pnl= sum(t.get("pnl", 0) for t in today_T)
        streak_s = f"[#00ff44]+{streak}W[/]" if streak > 0 else f"[#ff3322]{streak}L[/]" if streak < 0 else "[#666]0[/]"

        # ── Precompute shared MoE data (used by brain + children) ──
        moe      = local.get("moe", {})
        experts  = moe.get("experts", {}) if isinstance(moe, dict) else {}
        sorted_experts = sorted(
            [(k, v) for k, v in experts.items() if isinstance(v, dict)],
            key=lambda x: x[1].get("gateScore", 0), reverse=True
        )[:6]

        soul_rules = local.get("soul_rules", {})
        n_rules    = len(soul_rules) if isinstance(soul_rules, list) else \
                     len(soul_rules.get("rules", [])) if isinstance(soul_rules, dict) else 0
        soul_mem   = local.get("soul_memory", {})
        n_beliefs  = len(soul_mem.get("beliefs", [])) if isinstance(soul_mem, dict) else 0

        # ── HEADER TICKER ──
        prices  = state.get("state", {}).get("prices", {})
        tickers = []
        for sym in ["BTC", "ETH", "SOL", "XRP"]:
            p  = prices.get(f"{sym}USDT", {})
            pr = p.get("price", 0)
            ch = p.get("change", 0)
            if pr > 0:
                arr = "▲" if ch > 0 else "▼" if ch < 0 else "─"
                tickers.append(f"{sym} ${pr:,.0f} {arr}{abs(ch):.1f}%")
        self.query_one("#hd-prices", Static).update(
            "  ".join(tickers) if tickers else "[#444]waiting for price feed...[/]"
        )

        bs = local.get("brier_status", {}) or {}
        if bs.get("connected"):
            self.query_one("#hd-brier", Static).update(
                f"[#cc9900]BRIER[/] [{bc(bs['brierScore'])}]{bs['brierScore']:.4f}[/]"
                f"  [#888]WR[/] {bs['winRate']*100:.1f}%"
                f"  [#888]{bs['totalTrades']}T[/]"
            )
        else:
            self.query_one("#hd-brier", Static).update("[#333]BRIER: not connected[/]")

        mode_s = f"[b]{heart}[/] ACTIVE ({len(open_pos)} open)" if open_pos else f"[b]{pulse}[/] SCANNING"
        self.query_one("#hd-mode", Static).update(f"PAPER  {mode_s}")

        # ── SOVEREIGN VAULT ──
        profit_pct = ((fund / 10000) - 1) * 100
        recent_pnls = [float(t.get("pnl", 0)) for t in closed[-40:]]
        vault_txt = (
            f"\n[#555]{'─' * 20}[/]\n"
            f"[#888]Fund[/]\n"
            f"[b #00ff44]  ${fund:,.2f}[/]\n"
            f"[#888]Profit[/]\n"
            f"[b {'#00ff44' if profit_pct>=0 else '#ff3322'}]  {profit_pct:+.2f}%[/]"
            f"  [#555](${net:+,.0f})[/]\n"
            f"[#555]{'─' * 20}[/]\n"
            f"[#888]Win Rate[/]\n"
            f"  [b #fff]{wr:.1f}%[/]\n"
            f"  {gauge(wr, 100, 14, '#00aa33')}\n"
            f"[#888]Trades[/]  [#fff]{trades}[/]\n"
            f"[#555]{wins}W / {trades - wins}L[/]\n"
            f"[#888]Brier[/]   [{bc(brier_l)}]{brier_l:.4f}[/]\n"
            f"[#888]Streak[/]  {streak_s}\n"
            f"[#555]{'─' * 20}[/]\n"
            f"[#888]PnL Spark[/]\n  {spark(recent_pnls, 16)}\n"
            f"[#555]{'─' * 20}[/]\n"
            f"[#888]Today[/] [#555]{today_s[-5:]}[/]\n"
            f"  [#fff]{len(today_T)}T[/]  "
            f"[{'#00ff44' if today_wr>53 else '#ffaa00' if today_wr>50 else '#ff3322'}]{today_wr:.0f}%WR[/]\n"
            f"  [{'#00ff44' if today_pnl>=0 else '#ff3322'}]${today_pnl:+,.0f}[/]\n"
        )
        self.query_one("#vault-data", Static).update(vault_txt)

        # ── ACTIVE ORDER BOOK ──
        dt_pos = self.query_one("#dt-pos", DataTable)
        dt_pos.clear()
        for p in open_pos:
            title = (p.get("marketTitle") or p.get("asset", "?"))[:26]
            side  = p.get("side", "?")
            side_s= f"[#00ff44]{side}[/]" if side == "YES" else f"[#ff3322]{side}[/]"
            stake = f"${p.get('stake', 0):.0f}"
            edge  = f"{p.get('edge', 0)*100:.1f}%"
            conf  = f"{p.get('confidence', 0)}%"
            closes= p.get("closesAt", "")
            if closes:
                try:
                    left = (datetime.fromisoformat(closes.replace("Z", "+00:00")) - now).total_seconds()
                    left_s = f"{int(left)}s" if left > 0 else "[#ff3322]EXP[/]"
                except Exception:
                    left_s = "?"
            else:
                left_s = "?"
            dt_pos.add_row(title, side_s, stake, edge, conf, left_s)

        # ── BRIER PROTOCOL PANEL ──
        if bs.get("connected"):
            b_brier  = bs.get("brierScore", 0)
            b_wr     = bs.get("winRate", 0)
            b_trades = bs.get("totalTrades", 0)
            b_status = bs.get("status", "?")
            b_slug   = bs.get("slug", "?")
            b_sync   = (bs.get("lastSync") or "")[-11:-3]
            b_tier1  = bs.get("tier1", False)
            tier_s   = "[#cc9900]⭐ TIER 1  SHARP[/]"  if b_brier <= 0.18 else \
                       "[#ffaa00]✓  CALIBRATED[/]"     if b_brier <= 0.25 else \
                       "[#ff3322]⚠  MISCALIBRATED[/]"
            penalty  = "+0%" if b_brier <= 0.18 else "+1% edge" if b_brier <= 0.25 else "+3% edge"
            brier_txt = (
                f"\n[#00ff44]🟢 CONNECTED[/]\n"
                f"[#555]{b_slug}[/]\n"
                f"[#444]{'─' * 18}[/]\n"
                f"[#888]Brier Score[/]\n"
                f"  [{bc(b_brier)}][b]{b_brier:.4f}[/][/]\n"
                f"  {gauge(b_brier, 0.40, 12, bc(b_brier))}\n"
                f"[#888]Win Rate[/]\n"
                f"  [#fff]{b_wr*100:.1f}%[/]\n"
                f"[#888]Trades[/]    [#fff]{b_trades}[/]\n"
                f"[#888]Status[/]    [#00ff44]{b_status}[/]\n"
                f"[#444]{'─' * 18}[/]\n"
                f"{tier_s}\n"
                f"[#555]Penalty: {penalty}[/]\n"
                f"[#444]{'─' * 18}[/]\n"
                f"[#555]Sync {b_sync}[/]\n"
            )
        elif not bs:
            brier_txt = (
                f"\n[#444]⚫ NOT CONFIGURED[/]\n\n"
                f"[#555]Add to .env:[/]\n"
                f"[#333]BRIER_URL=\nBRIER_BOT_SLUG=\nBRIER_INGEST_KEY=[/]\n"
            )
        else:
            brier_txt = f"\n[#ff3322]🔴 DISCONNECTED[/]\n[#555]{bs.get('error','No connection')}[/]\n"
        self.query_one("#brier-data", Static).update(brier_txt)

        # ── MARKET REGIME ──
        rd       = local.get("regime", {})
        r_name   = rd.get("regime") or rd.get("lastResult", {}).get("regime", "UNKNOWN")
        r_conf   = rd.get("confidence") or rd.get("lastResult", {}).get("confidence", 0)
        r_samp   = rd.get("sampleCount") or rd.get("samples", 0)
        r_feat   = rd.get("features") or rd.get("lastResult", {}).get("features", {})
        mc       = local.get("metacalib", {})
        mc_mult  = mc.get("multiplier", 1.0) if isinstance(mc, dict) else 1.0
        rcol     = {"TRENDING":"#00ff44","MEAN_REVERTING":"#0099bb",
                    "VOLATILE":"#ff3322","EVENT":"#ff0000","RANGING":"#ffaa00"}.get(r_name,"#888")
        pin      = local.get("pin", {})
        pin_sc   = pin.get("scores", pin) if isinstance(pin, dict) else {}
        pin_al   = [f"{s}={v.get('pin_score',0):.2f}" for s, v in pin_sc.items()
                    if isinstance(v, dict) and v.get("pin_score", 0) > 0.3]

        regime_txt = (
            f"\n[b {rcol}]{r_name}[/]\n"
            f"  [#888]Conf[/] {gauge(r_conf*100, 100, 8, rcol)} [#fff]{r_conf*100:.0f}%[/]\n"
            f"  [#888]Samp[/] [#fff]{r_samp}[/]\n"
            f"[#444]{'─' * 18}[/]\n"
            f"  [#888]MetaCalib[/] [{'#00ff44' if mc_mult>0.9 else '#ffaa00' if mc_mult>0.8 else '#ff3322'}]{mc_mult:.3f}[/]\n"
        )
        if r_feat:
            regime_txt += f"[#444]{'─' * 18}[/]\n"
            for k, v in list(r_feat.items())[:4]:
                regime_txt += f"  [#666]{k}[/] [#fff]{v:.4f}[/]\n"
        if pin_al:
            regime_txt += f"[#ff3322]PIN ▲[/] {','.join(pin_al[:2])}\n"
        self.query_one("#regime-data", Static).update(regime_txt)

        # ── RECENT SETTLEMENTS ──
        dt_hist = self.query_one("#dt-hist", DataTable)
        dt_hist.clear()
        for t in reversed(closed[-16:]):
            ts    = (t.get("resolvedAt") or "")[-11:-3]
            asset = (t.get("asset") or "?")[:6].upper()
            side  = t.get("side", "?")
            side_s= f"[#00ff44]{side}[/]" if side == "YES" else f"[#ff3322]{side}[/]"
            won   = t.get("won", False)
            res_s = "[#00ff44]WIN [/]" if won else "[#ff3322]LOSS[/]"
            pv    = float(t.get("pnl", 0))
            pnl_s = f"[#00ff44]+${pv:.0f}[/]" if pv >= 0 else f"[#ff3322]-${abs(pv):.0f}[/]"
            edge  = f"{t.get('edge', 0)*100:.1f}%"
            dt_hist.add_row(ts, asset, side_s, res_s, pnl_s, edge)

        # ── NEURAL BRAIN ──
        try:
            ensemble   = local.get("ensemble", {})
            ens_w      = ensemble.get("weights", {}) if isinstance(ensemble, dict) else {}
            online     = local.get("online") or {}
            monologue  = local.get("monologue") or []

            brain_txt  = f"\n[#888]MoE[/] [#fff]{len(experts)}[/] experts\n"
            for name, exp in sorted_experts[:4]:
                gt   = exp.get("gateScore", 0) or 0
                t_   = exp.get("trades", 0) or 0
                w_   = exp.get("wins", 0) or 0
                ewr  = (w_ / max(1, t_) * 100)
                ecol = "#00ff44" if ewr > 55 else "#ffaa00" if ewr > 50 else "#ff3322"
                brain_txt += f"  [#ff8800]{name[:9]:9s}[/] {gauge(gt, 4, 6, '#7722cc')} [{ecol}]{ewr:.0f}%[/]\n"

            if ens_w and isinstance(ens_w, dict):
                brain_txt += f"[#444]{'─' * 18}[/]\n[#888]Ensemble[/]\n"
                for k, v in list(ens_w.items())[:4]:
                    if isinstance(v, (int, float)):
                        brain_txt += f"  [#777]{k[:5]}[/] {gauge(v*100, 100, 7, '#007799')} [#fff]{v:.2f}[/]\n"

            brain_txt += (
                f"[#444]{'─' * 18}[/]\n"
                f"[#888]Updates[/] [#fff]{online.get('totalUpdates', 0)}[/]\n"
                f"[#888]Rules[/]   [#fff]{n_rules}[/]  [#888]Beliefs[/] [#fff]{n_beliefs}[/]\n"
            )
            if monologue:
                thought = (monologue[-1].get("thought") or monologue[-1].get("reflection") or "")[:75]
                brain_txt += f"[#444][i]{thought}…[/i][/]\n"
            self.query_one("#brain-data", Static).update(brain_txt)
        except Exception as e:
            self.query_one("#brain-data", Static).update(f"[#ff3322]Brain err: {e}[/]")

        # ── EVOLUTION ──
        try:
            evo      = local.get("evolution", {}) if isinstance(local.get("evolution"), dict) else {}
            gen      = evo.get("generation", 0) or 0
            best_fit = evo.get("bestFitness") or evo.get("lastFitness", 0) or 0
            evo_p    = evo.get("params") or evo.get("bestParams", {}) or {}
            history  = evo.get("history", []) or []
            forecast = local.get("forecast", {}) if isinstance(local.get("forecast"), dict) else {}

            evo_txt = (
                f"\n[#888]Gen[/]   [b #aa44ff]{gen}[/]\n"
                f"[#888]Fit[/]   [#fff]{best_fit:.4f}[/]\n"
            )
            if evo_p and isinstance(evo_p, dict):
                evo_txt += f"[#444]{'─' * 18}[/]\n"
                for k, v in list(evo_p.items())[:5]:
                    if isinstance(v, (int, float)):
                        evo_txt += f"  [#666]{k[:11]:11s}[/] [#fff]{v:.4f}[/]\n"
            if history and isinstance(history, list):
                fit_vals = [h.get("fitness", 0) for h in history if isinstance(h, dict)]
                if fit_vals:
                    evo_txt += f"[#444]{'─' * 18}[/]\n{spark(fit_vals, 15)}\n"
            if forecast:
                ft = forecast.get("total", 0) or 0
                fc = forecast.get("correct", 0) or 0
                evo_txt += f"[#444]{'─' * 18}[/]\n[#888]Forecaster[/] [#fff]{(fc/max(1,ft))*100:.0f}%[/] [#555]({ft}T)[/]\n"
            evo_txt += f"[#888]Soul[/]  [#fff]{n_rules}R[/] [#888]/[/] [#fff]{n_beliefs}B[/]\n"
            self.query_one("#evo-data", Static).update(evo_txt)
        except Exception as e:
            self.query_one("#evo-data", Static).update(f"[#ff3322]Evo err: {e}[/]")

        # ── ADAN VOICE ──
        try:
            messages = local.get("messages", [])
            if isinstance(messages, list) and messages:
                tags = {"request":"[#ffaa00]REQ[/]","warning":"[#ff3322]WRN[/]",
                        "insight":"[#00ff44]INS[/]","milestone":"[#cc9900]MIL[/]",
                        "fear":"[#ff2222]FER[/]"}
                voice_txt = ""
                for m in reversed(messages[-12:]):
                    if not isinstance(m, dict): continue
                    ts  = (m.get("ts") or "")[-11:-3]
                    tag = tags.get(m.get("type", ""), f"[#555]{(m.get('type','?')[:3]).upper()}[/]")
                    msg = (m.get("message") or "")[:110]
                    mk  = " [#ff8800]●[/]" if not m.get("read") else ""
                    voice_txt += f"[#444]{ts}[/] {tag}{mk} {msg}\n"
                self.query_one("#voice-data", Static).update(voice_txt)
        except Exception as e:
            self.query_one("#voice-data", Static).update(f"[#ff3322]Voice err: {e}[/]")

        # ── CHILDREN SWARM ──
        try:
            config  = local.get("config", {}) if isinstance(local.get("config"), dict) else {}
            mesa    = config.get("mesaRedonda", {})
            parents = mesa.get("parents", []) if isinstance(mesa, dict) else []

            ch_txt = ""
            active_experts = [(n, e) for n, e in sorted_experts if (e.get("trades", 0) or 0) > 0][:5]
            if active_experts:
                ch_txt += "[#888]Top Traders[/]\n"
                for name, exp in active_experts:
                    t_  = exp.get("trades", 0) or 0
                    w_  = exp.get("wins", 0) or 0
                    ewr = (w_ / max(1, t_) * 100)
                    ec  = "#00ff44" if ewr > 55 else "#ffaa00" if ewr > 50 else "#ff3322"
                    ch_txt += f"  [#ff8800]{name[:12]:12s}[/] [{ec}]{ewr:.0f}%[/] [#555]{t_}T[/]\n"
            if parents:
                ch_txt += f"[#444]{'─' * 18}[/]\n[#888]Mesa[/]\n"
                for p in parents[:4]:
                    if not isinstance(p, dict): continue
                    ch_txt += f"  [#ff8800]{p.get('id','?'):6s}[/] [#555]{(p.get('role') or '?')[:10]}[/]\n"
            if not ch_txt:
                ch_txt = "[#333]No swarm data yet[/]"
            self.query_one("#children-data", Static).update(ch_txt)
        except Exception as e:
            self.query_one("#children-data", Static).update(f"[#ff3322]Swarm err: {e}[/]")

        # ── BRIER TRADE LOG ──
        try:
            bt_all  = local.get("brier_trades", []) or []
            bt_count= len(bt_all)
            self.query_one("#brier-log-title", Static).update(
                f" BRIER TRADE LOG ({bt_count} total) "
            )
            dt_bt = self.query_one("#dt-brier", DataTable)
            dt_bt.clear()
            if bt_all:
                for t in reversed(bt_all[-20:]):
                    ts    = (t.get("ts") or "")[-11:-3]
                    title = (t.get("marketTitle") or "?")[:20]
                    side  = t.get("side", "?")
                    side_s= f"[#00ff44]{side}[/]" if side == "YES" else f"[#ff3322]{side}[/]"
                    entry = f"{t.get('entryPrice', 0):.3f}"
                    amt   = f"${t.get('amount', 0):.0f}"
                    dt_bt.add_row(ts, title, side_s, entry, amt)
            else:
                dt_bt.add_row("─", "[#333]no bets reported yet[/]", "─", "─", "─")
        except Exception as e:
            pass

    # ── LOG TAIL ──────────────────────────────────────────────────────────────

    @work(exclusive=True, thread=True)
    def tail_log(self):
        try:
            log = self.query_one("#live-log", Log)
            if os.path.exists(LOG_FILE):
                with open(LOG_FILE) as f:
                    lines = f.readlines()
                for line in lines[-10:]:
                    s = line.strip()
                    if s: self.call_from_thread(log.write_line, s)
            self.call_from_thread(log.write_line, ">>> NEURAL LINK ESTABLISHED")
            with open(LOG_FILE) as f:
                f.seek(0, 2)
                while True:
                    line = f.readline()
                    if line:
                        s = line.strip()
                        if s: self.call_from_thread(log.write_line, s)
                    else:
                        time.sleep(0.4)
        except Exception as e:
            try:
                self.call_from_thread(self.query_one("#live-log", Log).write_line, f"Log error: {e}")
            except Exception:
                pass


if __name__ == "__main__":
    BloombergV6().run()
