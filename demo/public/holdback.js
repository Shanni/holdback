/* Holdback widget: held offers, bids and guaranteed purchases on any product page. No deps.
 *
 *   <script src="https://YOUR-MARKET/holdback.js" defer></script>
 *   <div data-holdback-item="monkey-3"></div>
 *
 * Every offer, bid and purchase is a hold on the shopper's card (an authorization): captured when the deal
 * clears, released otherwise. Guaranteed purchases are charged at once and refundable inside the window.
 *
 * Options, on the script tag or on a mount element (mount wins):
 *   data-market / data-holdback-market   market server URL (default: where holdback.js was loaded from)
 *   data-theme                           "light" (default) | "dark" | "auto"
 *   data-buyer-name                      name shown to the seller (default: "Shopper XXXX")
 * Theme from the host page's CSS: --holdback-accent, --holdback-on-accent, --holdback-radius, --holdback-font.
 * Events (bubble out of the mount, detail = { item, hold }): holdback:hold, holdback:purchase, holdback:release, holdback:refund.
 * JS: Holdback.mount(el, itemId), Holdback.open(itemId), Holdback.market, Holdback.onChange(fn).
 */
(() => {
  "use strict";
  if (window.Holdback) return;

  const script = document.currentScript;
  const firstMount = document.querySelector("[data-holdback-market]");
  const MARKET = String(
    (script && script.dataset.market) || (firstMount && firstMount.dataset.holdbackMarket) ||
    (script && script.src ? new URL(script.src, location.href).origin : location.origin),
  ).replace(/\/+$/, "");
  const THEME = (script && script.dataset.theme) || "light";
  const LS_BUYER = `holdback.buyer@${MARKET}`;

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => n == null || n === "" || isNaN(n) ? "–" : (Number.isInteger(+n) ? String(+n) : (+n).toFixed(2));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const MECH = { "buy-now": "Buy now", offers: "Make an offer", auction: "Live auction", dutch: "Price dropping" };
  const WHY = { "buy-now": "Why a fixed price?", offers: "Why offers?", auction: "Why an auction?", dutch: "Why a falling price?" };

  // processor reference (authorization id), shown as plain text
  const holdRef = (h) => h && h.ref ? `<span class="hr" title="Payment reference">${esc(h.ref)}</span>` : "";
  const refundable = (h) => !!h && h.status === "captured" && !!h.refundableUntil && Date.parse(h.refundableUntil) > Date.now();
  const fmtDate = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""; };
  const chip = (st) => `<span class="chip ${esc(st)}">${esc(st)}</span>`;

  function monkey(hue) {
    hue = Number(hue) || 0;
    const f = `hsl(${hue} 45% 42%)`, face = `hsl(${hue} 55% 78%)`, bg = `hsl(${(hue + 160) % 360} 60% 88%)`;
    return `<svg viewBox="0 0 120 120" role="img" aria-label="artwork"><rect width="120" height="120" fill="${bg}"/>
      <circle cx="28" cy="58" r="15" fill="${f}"/><circle cx="92" cy="58" r="15" fill="${f}"/>
      <circle cx="28" cy="58" r="8" fill="${face}"/><circle cx="92" cy="58" r="8" fill="${face}"/>
      <circle cx="60" cy="60" r="36" fill="${f}"/><ellipse cx="60" cy="70" rx="24" ry="20" fill="${face}"/>
      <ellipse cx="48" cy="52" rx="9" ry="10" fill="${face}"/><ellipse cx="72" cy="52" rx="9" ry="10" fill="${face}"/>
      <circle cx="49" cy="54" r="4" fill="#1d1b16"/><circle cx="71" cy="54" r="4" fill="#1d1b16"/>
      <ellipse cx="60" cy="68" rx="5" ry="3" fill="#1d1b16" opacity=".7"/>
      <path d="M50 78 Q60 86 70 78" stroke="#1d1b16" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;
  }
  const imgUrl = (src) => { try { return new URL(src, MARKET + "/").href; } catch { return src; } };
  const art = (it) => it.image ? `<img src="${esc(imgUrl(it.image))}" alt="">` : monkey(it.hue);
  const shipped = (it) => it.kind === "physical";
  const LOCK = `<svg class="lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;

  // ------------------------------------------------------------------ styles (shared by every shadow root)
  const CSS = `
  :host { all: initial; display: block; font-family: var(--holdback-font, inherit); font-size: 14px; line-height: 1.5; color: var(--ink);
    --accent: var(--holdback-accent, #121212); --on-accent: var(--holdback-on-accent, #ffffff); --r: var(--holdback-radius, 8px);
    --bg: #ffffff; --sunken: #f6f6f4; --ink: #121212; --ink-2: #333333; --muted: #6b6b6b; --line: rgba(0,0,0,.12); --line-2: rgba(0,0,0,.3);
    --held: #8a4a00; --held-bg: #fff4e0; --cap: #067647; --cap-bg: #e7f7ee; --ref: #3e4c7a; --ref-bg: #eef2f8; --err: #b42318; --err-bg: #fef3f2;
    --seller: color-mix(in srgb, var(--accent) 7%, var(--bg)); -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
  :host([data-theme="dark"]) { --bg: #141414; --sunken: #1c1c1c; --ink: #f2f2f2; --ink-2: #d6d6d6; --muted: #a0a0a0; --line: rgba(255,255,255,.14); --line-2: rgba(255,255,255,.4);
    --held: #fdb022; --held-bg: #2a1f0a; --cap: #47cd89; --cap-bg: #0a2a1b; --ref: #a4b6e0; --ref-bg: #172034; --err: #fda29b; --err-bg: #3a1512;
    --accent: var(--holdback-accent, #f2f2f2); --on-accent: var(--holdback-on-accent, #121212); --seller: color-mix(in srgb, var(--accent) 10%, var(--bg)); }
  @media (prefers-color-scheme: dark) { :host([data-theme="auto"]) { --bg: #141414; --sunken: #1c1c1c; --ink: #f2f2f2; --ink-2: #d6d6d6; --muted: #a0a0a0; --line: rgba(255,255,255,.14); --line-2: rgba(255,255,255,.4);
    --held: #fdb022; --held-bg: #2a1f0a; --cap: #47cd89; --cap-bg: #0a2a1b; --ref: #a4b6e0; --ref-bg: #172034; --err: #fda29b; --err-bg: #3a1512;
    --accent: var(--holdback-accent, #f2f2f2); --on-accent: var(--holdback-on-accent, #121212); --seller: color-mix(in srgb, var(--accent) 10%, var(--bg)); } }
  * { box-sizing: border-box; }
  button, input { font: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  a { color: inherit; }
  .muted { color: var(--muted); }
  .cur { font-size: .85em; color: var(--muted); font-weight: 500; }
  .hr { color: var(--muted); font-size: 12px; white-space: nowrap; font-family: ui-monospace, Menlo, monospace; }
  .lock { width: 12px; height: 12px; flex: none; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; padding: 0 8px; line-height: 20px; border-radius: 999px; white-space: nowrap; text-transform: capitalize; }
  .chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .chip.held { background: var(--held-bg); color: var(--held); } .chip.captured { background: var(--cap-bg); color: var(--cap); } .chip.refunded { background: var(--ref-bg); color: var(--ref); }
  .chip.released { background: var(--sunken); color: var(--muted); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 18px; border-radius: var(--r); border: 1px solid var(--accent);
    background: var(--accent); color: var(--on-accent); font-weight: 600; cursor: pointer; white-space: nowrap; transition: opacity .15s; }
  .btn:hover:not(:disabled) { opacity: .88; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn.ghost { background: transparent; color: var(--ink); border-color: var(--line-2); }
  .btn.ghost:hover:not(:disabled) { opacity: 1; background: var(--sunken); }
  .btn.small { min-height: 30px; padding: 0 12px; font-size: 13px; font-weight: 500; }
  .btn.block { width: 100%; }
  input[type=number], input[type=text] { height: 44px; padding: 0 12px; border: 1px solid var(--line-2); border-radius: var(--r); background: var(--bg); min-width: 0; width: 100%; }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
  input:disabled { background: var(--sunken); color: var(--muted); }

  /* inline block (sits under the store's own buy buttons) */
  .blk { border: 1px solid var(--line); border-radius: var(--r); background: var(--bg); padding: 14px 16px; display: grid; gap: 10px; }
  .blk .top { display: flex; align-items: baseline; justify-content: space-between; gap: 6px 12px; flex-wrap: wrap; }
  .blk .mech { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 8px; }
  .live { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; box-shadow: 0 0 0 3px rgba(229,72,77,.18); flex: none; }
  .blk .facts { color: var(--muted); font-size: 13px; }
  .blk .facts b { color: var(--ink); font-weight: 600; }
  .blk .mine { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 10px; border-radius: var(--r); background: var(--sunken); font-size: 13px; }
  .blk .trust { display: flex; gap: 6px; align-items: flex-start; color: var(--muted); font-size: 12px; }
  .blk .trust .lock { margin-top: 3px; }
  .blk .trust b { color: var(--ink-2); font-weight: 600; }
  .blk.sold .mech { color: var(--cap); }
  .skel { height: 14px; border-radius: 4px; background: var(--sunken); }

  /* drawer */
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.36); opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 2147483000; }
  .sheet { position: fixed; top: 0; right: 0; bottom: 0; width: min(440px, 100vw); background: var(--bg); color: var(--ink); z-index: 2147483001;
    transform: translateX(100%); transition: transform .24s cubic-bezier(.2,.8,.2,1); display: flex; flex-direction: column; box-shadow: -12px 0 40px rgba(0,0,0,.18); }
  :host([open]) .scrim { opacity: 1; pointer-events: auto; }
  :host([open]) .sheet { transform: none; }
  @media (max-width: 560px) {
    .sheet { top: auto; left: 0; width: 100vw; max-height: 92vh; border-radius: 14px 14px 0 0; transform: translateY(100%); box-shadow: 0 -12px 40px rgba(0,0,0,.18); }
  }
  @media (prefers-reduced-motion: reduce) { .scrim, .sheet { transition: none; } }
  .hd { display: grid; grid-template-columns: 56px minmax(0,1fr) auto; gap: 12px; align-items: center; padding: 16px 16px 12px; border-bottom: 1px solid var(--line); }
  .hd .art svg, .hd .art img { width: 56px; height: 56px; border-radius: calc(var(--r) * .75); display: block; object-fit: cover; }
  .hd h2 { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.25; overflow-wrap: anywhere; }
  .hd .sub { font-size: 13px; color: var(--muted); }
  .x { width: 36px; height: 36px; border-radius: 50%; border: 0; background: var(--sunken); cursor: pointer; font-size: 18px; line-height: 1; }
  .tabs { display: flex; gap: 4px; padding: 8px 16px 0; border-bottom: 1px solid var(--line); }
  .tabs button { border: 0; background: none; padding: 8px 4px 10px; margin-right: 14px; cursor: pointer; color: var(--muted); font-weight: 500; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
  .bd { flex: 1; overflow-y: auto; padding: 16px; display: grid; gap: 16px; align-content: start; }
  .why { padding: 10px 12px; border-radius: var(--r); background: var(--seller); font-size: 13px; color: var(--ink-2); }
  .why b { display: block; font-size: 12px; color: var(--ink); }
  .pricebox { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .pricebox .big { font-size: 28px; font-weight: 600; letter-spacing: -.02em; }
  .pricebox .muted { font-size: 13px; }
  .lbl { font-size: 12px; font-weight: 600; color: var(--ink-2); margin-bottom: 6px; display: block; }
  .row { display: flex; gap: 8px; }
  .stack { display: grid; gap: 8px; }
  .qchips { display: flex; flex-wrap: wrap; gap: 6px; }
  .qchip { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--bg); cursor: pointer; color: var(--ink-2); }
  .qchip:hover { border-color: var(--ink); color: var(--ink); }
  .thread { display: grid; gap: 10px; padding: 12px; border-radius: var(--r); background: var(--sunken); max-height: 260px; overflow-y: auto; font-size: 13px; }
  .thread:empty { display: none; }
  .turn { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
  .turn.s { align-items: flex-start; }
  .turn .h { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .turn .h b { color: var(--ink); }
  .bubble { max-width: 88%; padding: 7px 11px; border-radius: 12px 12px 2px 12px; background: var(--accent); color: var(--on-accent); overflow-wrap: anywhere; }
  .turn.s .bubble { background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 12px 12px 12px 2px; }
  .readtag { font-size: 11px; padding: 0 6px; border-radius: 999px; background: var(--seller); color: var(--ink-2); }
  .flow { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 0; font-size: 12px; color: var(--muted); counter-reset: s; }
  .flow > div { padding: 8px 8px 0; border-top: 2px solid var(--line); }
  .flow > div.on { border-top-color: var(--accent); color: var(--ink); }
  .flow b { display: block; font-size: 12px; color: inherit; }
  .note { font-size: 13px; padding: 10px 12px; border-radius: var(--r); background: var(--cap-bg); color: var(--cap); }
  .note:empty, .err:empty { display: none; }
  .err { font-size: 13px; padding: 10px 12px; border-radius: var(--r); background: var(--err-bg); color: var(--err); }
  .hint { font-size: 12px; color: var(--muted); }
  .list { display: grid; border: 1px solid var(--line); border-radius: var(--r); }
  .li { display: grid; grid-template-columns: 40px minmax(0,1fr) auto; gap: 10px; align-items: center; padding: 10px 12px; }
  .li + .li { border-top: 1px solid var(--line); }
  .li .art svg, .li .art img { width: 40px; height: 40px; border-radius: 6px; display: block; }
  .li .nm { font-weight: 500; overflow-wrap: anywhere; }
  .li .meta { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .li .r { display: grid; gap: 4px; justify-items: end; text-align: right; }
  .empty { color: var(--muted); font-size: 13px; padding: 12px; }
  .ft { border-top: 1px solid var(--line); padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; gap: 8px 12px; flex-wrap: wrap; font-size: 12px; color: var(--muted); }
  .ft .card b { color: var(--ink); font-size: 14px; }
  .ft .by { display: inline-flex; gap: 6px; align-items: center; }
  `;

  // ------------------------------------------------------------------ state
  let S = null;                      // market snapshot
  let me = null;                     // Buyer
  const mounts = new Map();          // element -> { itemId, root }
  const listeners = new Set();
  const notes = {};                  // itemId -> last action result (html)
  let lastErr = "";
  let prevMine = new Map();          // holdId -> status, to fire events on change

  const items = () => (S && S.items) || [];
  const itemById = (id) => items().find((i) => i.id === id);
  const isMine = (h) => !!me && (h.buyer === me.name || h.buyer === me.id);
  const myHolds = () => { const out = []; for (const it of items()) for (const h of it.holds || []) if (isMine(h)) out.push([it, h]); return out; };
  const myTurns = (it) => (me && it && it.negotiations && (it.negotiations[me.name] || it.negotiations[me.id])) || [];
  const myBuyer = () => me && S && (S.buyers || []).find((x) => x.id === me.id);
  const myBalance = () => { const b = myBuyer(); return b ? b.balance : me && me.balance; };
  const myCard = () => { const b = myBuyer(); return (b && b.card) || (me && me.card) || ""; };
  const boughtByMe = (it) => it.status === "sold" && me && (it.soldTo === me.name || it.soldTo === me.id);

  // ------------------------------------------------------------------ API
  async function api(method, path, body) {
    const r = await fetch(MARKET + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await r.json(); } catch {}
    if (!r.ok) { const e = new Error((data && data.error) || `${r.status} ${r.statusText}`); e.status = r.status; throw e; }
    return data;
  }
  let creating = null;
  function ensureBuyer(force) {
    if (creating) return creating;
    creating = (async () => {
      const id = force ? null : lsGet(LS_BUYER);
      if (id) {
        try { me = await api("GET", `/api/buyers/${encodeURIComponent(id)}`); if (me && me.id) return me; }
        catch (e) { if (!e.status || e.status >= 500) throw e; }
      }
      const name = (script && script.dataset.buyerName) || `Shopper ${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
      me = await api("POST", "/api/buyers", { name, kind: "human" });
      lsSet(LS_BUYER, me.id);
      return me;
    })().finally(() => { creating = null; });
    return creating;
  }
  async function act(itemId, fn) {
    lastErr = "";
    try {
      if (!me) await ensureBuyer();
      try { return await fn(); }
      catch (e) {
        if (/unknown buyer|buyer not found|no such buyer|no buyer/i.test(e.message)) { await ensureBuyer(true); return await fn(); }
        throw e;
      }
    } catch (e) { lastErr = e.message; }
    finally { renderAll(); }
  }

  // ------------------------------------------------------------------ inline block
  function countdown(endsAt) { return `<span class="cd" data-ends="${esc(endsAt)}"></span>`; }

  function myLine(it) {
    const held = (it.holds || []).filter((h) => isMine(h) && h.status === "held");
    const turns = myTurns(it), last = turns[turns.length - 1];
    if (boughtByMe(it)) {
      const h = (it.holds || []).find((x) => isMine(x) && x.status === "captured");
      return `<div class="mine">${chip(h ? h.status : "captured")} You bought this for <b>${fmt(it.soldFor)}</b> USD ${holdRef(h)}</div>`;
    }
    if (!held.length) return last && last.from === "seller" && last.action === "decline" ? `<div class="mine">${chip("released")} Your offer was declined. The hold is released; nothing was charged.</div>` : "";
    const h = held[held.length - 1];
    const ctr = last && last.from === "seller" && last.action === "counter" ? ` · seller countered <b>${fmt(last.amount)}</b>` : "";
    const lead = it.auction && h.kind === "bid" ? (it.auction.leader === me.name || it.auction.leader === me.id ? " · you're leading" : " · you've been outbid") : "";
    return `<div class="mine">${chip("held")} Your ${esc(h.kind)} of <b>${fmt(h.amount)}</b> is held on your card${ctr}${lead}</div>`;
  }

  function blockHTML(it) {
    if (!S) return `<div class="blk"><div class="skel" style="width:40%"></div><div class="skel" style="width:70%"></div><div class="skel" style="height:44px"></div></div>`;
    if (!it) return `<div class="blk"><div class="facts">Holdback offers aren't available for this product.</div></div>`;
    const trust = it.guarantee
      ? `<div class="trust">${LOCK}<span><b>Money back, no questions.</b> Refund it yourself within ${esc(it.guarantee)}${shipped(it) ? " if it doesn't arrive or isn't as described" : ""}; no seller approval needed. Protected by Holdback.</span></div>`
      : `<div class="trust">${LOCK}<span><b>Your card is held, not charged.</b> You're charged only when the deal clears; otherwise the hold is released. Protected by Holdback.</span></div>`;
    if (it.status === "sold") {
      const bought = boughtByMe(it) ? (it.holds || []).find((h) => isMine(h) && h.status === "captured") : null;
      return `<div class="blk sold"><div class="top"><span class="mech">Sold</span><span class="facts">for <b>${fmt(it.soldFor)}</b> USD</span></div>${myLine(it)}${it.guarantee && refundable(bought) ? `<div class="facts">${shipped(it) ? `On its way. If it doesn't arrive or isn't as described, refund it yourself until ${esc(fmtDate(bought.refundableUntil))}.` : `${esc(it.guarantee)} guarantee: you can refund it yourself until ${esc(fmtDate(bought.refundableUntil))}.`}</div><button class="btn ghost block" data-open>Manage your purchase</button>` : ""}</div>`;
    }
    if (it.status !== "listed") return `<div class="blk"><div class="top"><span class="mech">No longer for sale</span></div><div class="facts">Every hold on this item was released; nobody was charged.</div></div>`;
    let mech = MECH[it.mechanism] || it.mechanism, facts = "", cta = "";
    switch (it.mechanism) {
      case "offers":
        facts = `Asking <b>${fmt(it.ask)}</b> USD · the seller replies instantly`;
        cta = "Make an offer"; break;
      case "auction": {
        const a = it.auction || {};
        mech = a.closed ? "Auction closed" : `<span class="live"></span>Live auction · ${countdown(a.endsAt)}`;
        facts = `${a.price != null ? `Current price <b>${fmt(a.price)}</b>` : `Starts at <b>${fmt(it.ask)}</b>`} · ${a.bids || 0} bid${a.bids === 1 ? "" : "s"} · reserve ${a.reserveMet ? "met" : "not met"}`;
        cta = "Place a bid"; break;
      }
      case "dutch":
        facts = `Now <b>${fmt(it.price)}</b> USD, down from ${fmt(it.ask)} · falls until someone buys`;
        cta = `Buy now at ${fmt(it.price)}`; break;
      default:
        mech = shipped(it) ? "Buy with delivery protection" : it.guarantee ? `Buy with a ${esc(it.guarantee)} guarantee` : "Buy now";
        facts = shipped(it) ? `<b>${fmt(it.price ?? it.ask)}</b> USD · refund it yourself within ${esc(it.guarantee)} if it doesn't arrive or isn't as described`
          : it.guarantee ? `<b>${fmt(it.price ?? it.ask)}</b> USD · refund it yourself within ${esc(it.guarantee)}, no questions` : `<b>${fmt(it.price ?? it.ask)}</b> USD · charged when you buy`;
        cta = `Buy · ${fmt(it.price ?? it.ask)} USD`;
    }
    return `<div class="blk"><div class="top"><span class="mech">${mech}</span></div><div class="facts">${facts}</div>${myLine(it)}
      <button class="btn block" data-open>${cta}</button>${trust}</div>`;
  }

  // ------------------------------------------------------------------ drawer
  let drawer = null;   // { host, root, itemId, tab, opener }
  function ensureDrawer() {
    if (drawer) return drawer;
    const host = document.createElement("div");
    host.setAttribute("data-holdback-drawer", "");
    host.dataset.theme = THEME;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div class="scrim" part="scrim"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="t" tabindex="-1">
        <div class="hd"><div class="art" id="art"></div><div style="min-width:0"><h2 id="t"></h2><div class="sub" id="sub"></div></div><button class="x" id="x" aria-label="Close">×</button></div>
        <div class="tabs" role="tablist"><button role="tab" data-tab="item" aria-selected="true">This item</button><button role="tab" data-tab="holds" aria-selected="false">Your holds</button></div>
        <div class="bd" id="bd"></div>
        <div class="ft"><span class="card" id="card">Setting up your card…</span><span class="by">${LOCK} Holdback · card holds</span></div>
      </div>`;
    document.body.appendChild(host);
    drawer = { host, root, itemId: null, tab: "item", opener: null, cache: new Map() };
    const $ = (id) => root.getElementById(id);
    $("x").onclick = close;
    root.querySelector(".scrim").onclick = close;
    root.querySelector(".tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) { drawer.tab = b.dataset.tab; drawer.cache.clear(); renderDrawer(); } };
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
      if (e.key === "Tab") { // keep focus inside the sheet
        const f = [...root.querySelectorAll("button:not(:disabled), input:not(:disabled), a[href]")];
        if (!f.length) return;
        const i = f.indexOf(root.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
      if (e.key === "Enter" && e.target.matches("input")) { const b = e.target.closest(".row")?.querySelector(".btn"); if (b && !b.disabled) b.click(); }
    });
    $("bd").addEventListener("click", onDrawerClick);
    return drawer;
  }
  function open(itemId, opener) {
    const d = ensureDrawer();
    if (d.itemId !== itemId) { d.cache.clear(); lastErr = ""; }
    d.itemId = itemId; d.tab = "item"; d.opener = opener || document.activeElement;
    // the drawer lives under <body>, so copy the opening block's theme and CSS variables onto it
    const src = opener && opener.nodeType === 1 ? opener : null;
    d.host.dataset.theme = (src && src.dataset.theme) || THEME;
    if (src) { const cs = getComputedStyle(src); for (const v of ["--holdback-accent", "--holdback-on-accent", "--holdback-radius", "--holdback-font"]) { const x = cs.getPropertyValue(v).trim(); if (x) d.host.style.setProperty(v, x); else d.host.style.removeProperty(v); } }
    d.host.style.fontFamily = src ? getComputedStyle(src).fontFamily : "";
    d.host.setAttribute("open", "");
    renderDrawer();
    requestAnimationFrame(() => d.root.querySelector(".sheet").focus());
    ensureBuyer().then(() => fetch(`${MARKET}/api/items/${encodeURIComponent(itemId)}?buyerId=${encodeURIComponent(me.id)}`)).catch(() => {}); // registers as a watcher
  }
  function close() {
    if (!drawer || !drawer.host.hasAttribute("open")) return;
    drawer.host.removeAttribute("open");
    if (drawer.opener && drawer.opener.focus) drawer.opener.focus();
  }

  function turnHTML(t) {
    const amt = `<b>${fmt(t.amount)}</b>`;
    if (t.from === "buyer") {
      const v = { offer: `You offered ${amt}`, accept: `You accepted ${amt}`, walk_away: "You walked away" }[t.action] || esc(t.action);
      return `<div class="turn"><div class="h">${v}</div>${t.message ? `<div class="bubble">${esc(t.message)}</div>` : ""}</div>`;
    }
    const v = { counter: `Seller countered ${amt}`, accept: `Seller accepted ${amt}`, decline: `Seller declined${t.amount ? ` · ask ${amt}` : ""}`, walk_away: "Seller closed the talks" }[t.action] || esc(t.action);
    const read = t.read && t.read.length ? `<span class="readtag" title="What the seller agent picked up from your message">read: ${esc(t.read.map((x) => x.replace("_", " ")).join(", "))}</span>` : "";
    return `<div class="turn s"><div class="h">${v} ${read}</div>${t.message ? `<div class="bubble">${esc(t.message)}</div>` : ""}</div>`;
  }

  // money-flow strip: where this buyer's money is for this item
  function flowHTML(it) {
    const mine = (it.holds || []).filter(isMine);
    const h = mine[mine.length - 1];
    const st = h ? h.status : null;
    const win = refundable(h);
    const done = st === "captured" ? (win ? `charged · refundable until ${esc(fmtDate(h.refundableUntil))}` : "charged") : st === "released" ? "released, never charged" : st === "refunded" ? "refunded to you" : "charged or released";
    return `<div class="flow" aria-label="Where your money is"><div class="${h ? "on" : ""}"><b>1 · Held</b>authorized on your card</div>
      <div class="${st ? "on" : ""}"><b>2 · Deal</b>${win ? (shipped(it) ? "ordered, shipping" : "bought, refund window open") : it.status === "sold" && st === "captured" ? "cleared" : st === "held" ? "waiting on the seller" : "accept, win or buy"}</div>
      <div class="${st && st !== "held" ? "on" : ""}"><b>3 · Settled</b>${done}</div></div>`;
  }

  // the form for the item's current mechanism; rebuilt only when its key changes, so typing is never lost
  function formHTML(it) {
    if (it.status !== "listed") return "";
    switch (it.mechanism) {
      case "offers": return `<div class="stack">
          <div class="thread" id="thread"></div>
          <div id="counter"></div>
          <div><label class="lbl" for="msg">Message to the seller <span class="muted">(optional)</span></label>
            <input id="msg" type="text" maxlength="280" autocomplete="off" placeholder="Explain your offer or ask about the piece"></div>
          <div class="qchips"><button class="qchip" data-fill="I'm a student — any flexibility?">I'm a student — any flexibility?</button><button class="qchip" data-fill="Huge fan of this series!">Huge fan of this series!</button><button class="qchip" data-fill="Is it one of a kind?">Is it one of a kind?</button></div>
          <div class="row"><input id="amt" type="number" min="1" step="1" inputmode="numeric" placeholder="Your offer (ask ${fmt(it.ask)})" aria-label="Offer amount"><button class="btn" data-act="offer">Make offer</button></div>
          <div class="hint">Your offer is a hold on your card, not a charge, while the seller agent decides. A new offer replaces the old one, and the old hold is released.</div>
          <button class="btn ghost block" data-act="buy">Or buy at ask · ${fmt(it.ask)} USD</button></div>`;
      case "auction": return `<div class="stack">
          <div><label class="lbl" for="amt">Your maximum bid</label>
          <div class="row"><input id="amt" type="number" min="1" step="1" inputmode="numeric" placeholder="e.g. ${fmt(Math.max(it.ask, ((it.auction && it.auction.price) || 0) + 5))}" aria-label="Maximum bid"><button class="btn" data-act="bid">Place bid</button></div></div>
          <div class="hint">Proxy bidding: your maximum is held on your card, but if you win you pay the second-highest bid + 1. Bids are binding until the auction closes; losing holds are released then.</div></div>`;
      default: return `<div class="stack" id="buybox"></div>`;
    }
  }

  function itemTab(it) {
    const d = drawer;
    const key = `${it.id}|${it.mechanism}|${it.status}`;
    if (d.cache.get("formKey") !== key) {
      for (const k of [...d.cache.keys()]) if (k !== "art") d.cache.delete(k); // fresh elements: forget what was written
      d.cache.set("formKey", key);
      d.root.getElementById("bd").innerHTML = `
        ${it.reason ? `<div class="why"><b>${esc(WHY[it.mechanism] || "Why this way of selling?")} · the seller agent says</b><span id="reason"></span></div>` : ""}
        <div class="pricebox" id="price"></div>
        <div id="form">${formHTML(it)}</div>
        <div class="note" id="note" aria-live="polite"></div><div class="err" id="err" role="alert"></div>
        <div id="flow"></div>`;
      const q = d.root.getElementById("amt"); if (q) q.value = "";
    }
    const $ = (id) => d.root.getElementById(id);
    const set = (id, html) => { const el = $(id); if (el && d.cache.get(id) !== html) { d.cache.set(id, html); el.innerHTML = html; return true; } return false; };
    set("reason", esc(it.reason));
    const a = it.auction || {};
    set("price", it.status === "sold" ? `<span class="big">${fmt(it.soldFor)}</span><span class="muted">USD · ${boughtByMe(it) ? "you bought this" : "sold"}</span>`
      : it.status !== "listed" ? `<span class="muted">No longer for sale.</span>`
      : it.mechanism === "auction" ? `<span class="big">${fmt(a.price ?? it.ask)}</span><span class="muted">USD now · ${a.bids || 0} bids · ${a.closed ? "closed" : countdown(a.endsAt)}</span>`
      : it.mechanism === "dutch" ? `<span class="big">${fmt(it.price)}</span><span class="muted">USD now · started at ${fmt(it.ask)}, dropping</span>`
      : it.mechanism === "offers" ? `<span class="big">${fmt(it.ask)}</span><span class="muted">USD asking · offers welcome</span>`
      : `<span class="big">${fmt(it.price ?? it.ask)}</span><span class="muted">USD${shipped(it) ? ` · ${esc(it.guarantee)} delivery protection` : it.guarantee ? ` · ${esc(it.guarantee)} money-back guarantee` : ""}</span>`);
    const turns = myTurns(it);
    if (set("thread", turns.slice(-12).map(turnHTML).join(""))) { const t = $("thread"); t.scrollTop = t.scrollHeight; }
    const last = turns[turns.length - 1];
    const counter = last && last.from === "seller" && last.action === "counter" ? last : null;
    const heldOffer = (it.holds || []).some((h) => isMine(h) && h.kind === "offer" && h.status === "held");
    set("counter", counter ? `<div class="row"><button class="btn" data-act="accept" style="flex:1">Accept ${fmt(counter.amount)} USD</button><button class="btn ghost" data-act="walk">Walk away</button></div>`
      : heldOffer ? `<div class="row"><button class="btn ghost block" data-act="walk">Withdraw my offer</button></div>` : "");
    if (it.status === "listed" && (it.mechanism === "buy-now" || it.mechanism === "dutch")) {
      const p = it.mechanism === "dutch" ? it.price : it.price ?? it.ask;
      set("buybox", `<button class="btn block" data-act="buy">Buy now · ${fmt(p)} USD</button>
        <div class="hint">${shipped(it) ? `Your card is charged now. If it doesn't arrive or isn't as described, refund it yourself from “Your holds” within ${esc(it.guarantee)}, no seller approval needed.` : it.guarantee ? `Your card is charged now. Not happy? Refund it yourself from “Your holds” within ${esc(it.guarantee)}, no seller approval needed.` : it.mechanism === "dutch" ? "The price falls on a schedule. Buying charges the current price at once." : "Buying charges your card at once."}</div>`);
    }
    set("note", notes[it.id] || "");
    set("err", esc(lastErr));
    set("flow", flowHTML(it));
  }

  function holdsTab() {
    const mine = myHolds().slice().reverse();
    const html = mine.length ? `<div class="list">${mine.map(([it, h]) => `<div class="li"><span class="art">${art(it)}</span>
        <span style="min-width:0"><span class="nm">${esc(it.name)}</span><span class="meta">${esc(h.kind)} · ${h.captured != null && h.captured < h.amount ? `${fmt(h.captured)} of ${fmt(h.amount)}, ${fmt(h.amount - h.captured)} released` : fmt(h.amount)} USD${refundable(h) ? ` · refundable until ${esc(fmtDate(h.refundableUntil))}` : ""}</span></span>
        <span class="r">${chip(h.status)}${h.status === "held" && h.kind === "offer" ? `<button class="btn ghost small" data-reclaim="${esc(h.id)}">Withdraw</button>` : refundable(h) ? `<button class="btn ghost small" data-reclaim="${esc(h.id)}">Refund</button>` : holdRef(h)}</span></div>`).join("")}</div>
        <div class="hint">A hold reserves money on your card without charging it. Withdraw an offer the seller hasn't taken, or refund a guaranteed purchase inside its window. Bids stay binding until the auction closes.</div>
        <div class="err" id="err" role="alert">${esc(lastErr)}</div>`
      : `<div class="empty">No holds yet. Make an offer, bid or buy, and the held payment shows up here.</div>`;
    if (drawer.cache.get("holds") !== html) { drawer.cache.set("holds", html); drawer.cache.delete("formKey"); drawer.root.getElementById("bd").innerHTML = html; }
  }

  function renderDrawer() {
    const d = drawer;
    if (!d || !d.host.hasAttribute("open")) return;
    const $ = (id) => d.root.getElementById(id);
    const it = itemById(d.itemId);
    $("t").textContent = it ? it.name : "Loading…";
    $("sub").textContent = it ? (it.status === "listed" ? MECH[it.mechanism] || it.mechanism : it.status === "sold" ? "Sold" : "Closed") : "";
    const artHtml = it ? art(it) : "";
    if (d.cache.get("art") !== artHtml) { d.cache.set("art", artHtml); $("art").innerHTML = artHtml; }
    const n = myHolds().filter(([, h]) => h.status === "held").length;
    for (const b of d.root.querySelectorAll("[data-tab]")) {
      b.setAttribute("aria-selected", String(b.dataset.tab === d.tab));
      if (b.dataset.tab === "holds") b.textContent = n ? `Your holds (${n} open)` : "Your holds";
    }
    if (d.tab === "holds") holdsTab(); else if (it) { d.cache.delete("holds"); itemTab(it); }
    $("card").innerHTML = me ? `${esc(me.name)}${myCard() ? ` · ${esc(myCard())}` : ""} · <b>${fmt(myBalance())}</b> USD available` : "Setting up your card…";
    tick();
  }

  async function onDrawerClick(e) {
    const d = drawer, $ = (id) => d.root.getElementById(id);
    const fill = e.target.closest("[data-fill]");
    if (fill) { $("msg").value = fill.dataset.fill; $("msg").focus(); return; }
    const rc = e.target.closest("[data-reclaim]");
    if (rc) { rc.disabled = true; await act(null, () => api("POST", `/api/holds/${encodeURIComponent(rc.dataset.reclaim)}/reclaim`, { buyerId: me.id })); return; }
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled) return;
    const it = itemById(d.itemId); if (!it) return;
    const path = `/api/items/${encodeURIComponent(it.id)}`;
    const msg = () => { const m = $("msg") && $("msg").value.trim().slice(0, 280); return m ? { message: m } : {}; };
    const clearMsg = () => { if ($("msg")) $("msg").value = ""; };
    const amount = () => { const v = Math.round(Number($("amt") && $("amt").value)); if (!v || v <= 0) throw new Error("Enter an amount."); return v; };
    b.disabled = true;
    await act(it.id, async () => {
      if (b.dataset.act === "offer") {
        const r = await api("POST", `${path}/offer`, { buyerId: me.id, amount: amount(), ...msg() });
        clearMsg(); $("amt").value = "";
        notes[it.id] = r && r.reply && r.reply.action === "decline" ? "The seller declined, so your hold was released. Nothing was charged." : r && r.reply && r.reply.action === "accept" ? `Deal! Charged ${fmt(r.hold && (r.hold.captured ?? r.hold.amount))} USD and the item is yours. ${holdRef(r.hold)}` : "";
      } else if (b.dataset.act === "accept") {
        const r = await api("POST", `${path}/respond`, { buyerId: me.id, action: "accept", ...msg() });
        clearMsg();
        notes[it.id] = `Deal! Charged ${fmt(r.hold && (r.hold.captured ?? r.hold.amount))} USD and the item is yours. ${holdRef(r.hold)}`;
      } else if (b.dataset.act === "walk") {
        await api("POST", `${path}/respond`, { buyerId: me.id, action: "walk_away", ...msg() });
        clearMsg(); notes[it.id] = "You walked away. Your hold is released; nothing was charged.";
      } else if (b.dataset.act === "bid") {
        const max = amount();
        const r = await api("POST", `${path}/bid`, { buyerId: me.id, max });
        $("amt").value = "";
        const lead = r && r.item && r.item.auction && r.item.auction.leader;
        notes[it.id] = `Bid placed: up to ${fmt(max)} USD is held on your card. ${lead && (lead === me.name || lead === me.id) ? "You're leading." : "You're not leading yet."} ${holdRef(r && r.hold)}`;
      } else if (b.dataset.act === "buy") {
        const r = await api("POST", `${path}/buy`, { buyerId: me.id });
        const h = r && r.hold;
        const until = esc(h && h.refundableUntil ? fmtDate(h.refundableUntil) : it.guarantee || "");
        notes[it.id] = shipped(it) ? `Ordered. Charged ${fmt(h && (h.captured ?? h.amount))} USD. If it doesn't arrive or isn't as described, refund it from “Your holds” until ${until}. ${holdRef(h)}`
          : it.guarantee ? `Bought. Charged ${fmt(h && (h.captured ?? h.amount))} USD, refundable from “Your holds” until ${until} if you change your mind. ${holdRef(h)}`
          : `Bought for ${fmt(h && (h.captured ?? h.amount))} USD. ${holdRef(h)}`;
      }
    });
    b.disabled = false;
  }

  // ------------------------------------------------------------------ mounts
  function mount(el, itemId) {
    if (mounts.has(el)) { mounts.get(el).itemId = itemId || mounts.get(el).itemId; renderMount(el); return; }
    const id = itemId || el.dataset.holdbackItem;
    if (!id) return;
    const root = el.attachShadow ? (el.shadowRoot || el.attachShadow({ mode: "open" })) : el;
    root.innerHTML = `<style>${CSS}</style><div class="w"></div>`;
    // the shadow host is the mount itself: theme attribute lives on it
    if (!el.dataset.theme) el.dataset.theme = THEME;
    root.addEventListener("click", (e) => { if (e.target.closest("[data-open]")) open(mounts.get(el).itemId, el); });
    mounts.set(el, { itemId: id, root, html: "" });
    renderMount(el);
  }
  function renderMount(el) {
    const m = mounts.get(el); if (!m) return;
    const html = blockHTML(itemById(m.itemId));
    if (m.html !== html) { m.html = html; m.root.querySelector(".w").innerHTML = html; }
  }
  function scan(root = document) {
    for (const el of root.querySelectorAll("[data-holdback-item]")) if (!mounts.has(el)) mount(el);
  }

  // ------------------------------------------------------------------ events for the host page
  let seeded = false;   // first time we know both the snapshot and the buyer: remember existing holds, fire nothing
  function fireEvents() {
    if (!me || !S) return;
    if (!seeded) { seeded = true; for (const [, h] of myHolds()) prevMine.set(h.id, h.status); return; }
    const next = new Map();
    for (const [it, h] of myHolds()) {
      next.set(h.id, h.status);
      const was = prevMine.get(h.id);
      if (was === h.status) continue;
      let type = null;
      if (h.status === "refunded") type = "holdback:refund";        // was charged, money returned
      else if (h.status === "released") type = "holdback:release";   // authorization voided, never charged
      else if (h.status === "captured") type = "holdback:purchase";
      else if (h.status === "held" && was === undefined) type = "holdback:hold";
      if (!type) continue;
      const targets = [...mounts].filter(([, m]) => m.itemId === it.id).map(([el]) => el);
      const detail = { item: it, hold: h };
      if (!targets.length) targets.push(document);
      for (const t of targets) t.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    }
    prevMine = next;
  }

  function renderAll() {
    for (const el of mounts.keys()) {
      if (!el.isConnected) { mounts.delete(el); continue; }
      renderMount(el);
    }
    renderDrawer();
    tick();
  }

  function tick() {
    const now = Date.now();
    const roots = [...[...mounts.values()].map((m) => m.root), drawer && drawer.root].filter(Boolean);
    for (const r of roots) for (const el of r.querySelectorAll(".cd[data-ends]")) {
      const end = Date.parse(el.dataset.ends);
      const s = isNaN(end) ? null : Math.max(0, Math.round((end - now) / 1000));
      el.textContent = s == null ? "live" : s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left` : "closing…";
    }
  }

  function connect() {
    const es = new EventSource(`${MARKET}/events`);
    es.onmessage = (e) => {
      try { S = JSON.parse(e.data); } catch { return; }
      fireEvents();
      renderAll();
      for (const fn of listeners) { try { fn(S); } catch (err) { console.error(err); } }
    };
  }

  function boot() {
    scan();
    new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1) { if (n.matches("[data-holdback-item]")) mount(n); scan(n); } })
      .observe(document.body, { childList: true, subtree: true });
    connect();
    ensureBuyer().then(() => { fireEvents(); renderAll(); }).catch((e) => { lastErr = `Card setup failed: ${e.message}`; renderAll(); });
    setInterval(tick, 500);
  }

  window.Holdback = {
    market: MARKET,
    mount, open, close,
    onChange(fn) { listeners.add(fn); if (S) fn(S); return () => listeners.delete(fn); },
    get buyer() { return me; },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
