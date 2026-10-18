// UHE chart-pattern finder. Pure functions shared by the data engine (Node) and the browser.
// Input: bars [{t, o, h, l, c, v}] oldest → newest on any timeframe. Output: the patterns that are
// forming now or broke out in the last few bars, with the key level, measured-move target and stop.
// Patterns are probabilities, not promises: many fail. Treat them as one more input next to the checklist.

export const TIMEFRAMES = ["1m", "5m", "10m", "30m", "1h", "4h", "1d", "1w"];
export const PATTERNS = {
  hs: { name: "Head & shoulders", bias: "bear", what: "Three peaks, the middle one highest. A close below the neckline often starts a drop." },
  ihs: { name: "Inverse head & shoulders", bias: "bull", what: "Three troughs, the middle one lowest. A close above the neckline often starts a rise." },
  dt: { name: "Double top", bias: "bear", what: "Two failed pushes at the same high. Breaking the dip between them points lower." },
  db: { name: "Double bottom", bias: "bull", what: "Two holds at the same low. Breaking the bounce high between them points higher." },
  asc: { name: "Ascending triangle", bias: "bull", what: "Flat ceiling, rising lows. Buyers keep stepping in higher until the ceiling breaks." },
  desc: { name: "Descending triangle", bias: "watch", what: "Flat floor, falling highs. A break above the falling line is bullish; a break of the floor is bearish." },
  bflag: { name: "Bull flag", bias: "bull", what: "A sharp rise, then a small orderly pullback. A break of the flag's top often continues the rise." },
  sflag: { name: "Bear flag", bias: "bear", what: "A sharp drop, then a small bounce. A break of the flag's bottom often continues the drop." },
  cup: { name: "Cup & handle", bias: "bull", what: "A rounded U back to the old high, a small dip (handle), then a breakout over the rim." },
  fwedge: { name: "Falling wedge", bias: "bull", what: "Lower highs and lower lows that squeeze together. Usually breaks upward." },
  rwedge: { name: "Rising wedge", bias: "bear", what: "Higher highs and higher lows that squeeze together. Usually breaks downward." },
  sym: { name: "Wedge (symmetrical)", bias: "watch", what: "Lower highs and higher lows squeezing to a point. Trade the direction of the break." }
};

const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const r = (x, d = 4) => x == null || !isFinite(x) ? null : +(+x).toFixed(d);
export function atrOf(b) {
  if (b.length < 3) return 0;
  const tr = []; for (let i = 1; i < b.length; i++) tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
  const s = tr.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || avg(tr); // median: robust to gap bars
}
// Least-squares line through points [[x, y], ...] → {m, k, at(x)}
function fit(pts) {
  const n = pts.length, mx = avg(pts.map(p => p[0])), my = avg(pts.map(p => p[1]));
  let num = 0, den = 0; for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  const m = den ? num / den : 0, k = my - m * mx;
  return { m, k, at: x => m * x + k, n };
}
// Zigzag swing points: a high/low is confirmed once price moves `thr` against it. The last pivot is the live extreme.
export function zigzag(b, thr) {
  const P = []; if (b.length < 3) return P;
  let dir = 0, ext = { i: 0, p: b[0].c };
  let hi = { i: 0, p: b[0].h }, lo = { i: 0, p: b[0].l };
  for (let i = 1; i < b.length; i++) {
    const x = b[i];
    if (dir >= 0) { if (x.h >= hi.p) hi = { i, p: x.h }; }
    if (dir <= 0) { if (x.l <= lo.p) lo = { i, p: x.l }; }
    // a swing is confirmed only by a later bar moving `thr` away from it
    if (dir === 0) {
      if (hi.p - x.l >= thr && hi.i < i) { P.push({ ...hi, t: "H" }); dir = -1; lo = { i, p: x.l }; }
      else if (x.h - lo.p >= thr && lo.i < i) { P.push({ ...lo, t: "L" }); dir = 1; hi = { i, p: x.h }; }
    } else if (dir > 0 && hi.i < i && hi.p - x.l >= thr) { P.push({ ...hi, t: "H" }); dir = -1; lo = { i, p: x.l }; }
    else if (dir < 0 && lo.i < i && x.h - lo.p >= thr) { P.push({ ...lo, t: "L" }); dir = 1; hi = { i, p: x.h }; }
  }
  const last = dir > 0 ? { ...hi, t: "H", live: true } : dir < 0 ? { ...lo, t: "L", live: true } : null;
  if (last && (!P.length || P[P.length - 1].i !== last.i)) P.push(last);
  return P;
}
// If the latest close is beyond line(i) (above when up = true), the bar where that run beyond the line began; else -1.
// `from` stops the walk at the pattern's last swing so an old cross never counts.
function crossAt(b, from, line, up, pad = 0) {
  const beyond = i => up ? b[i].c > line(i) + pad : b[i].c < line(i) - pad;
  let i = b.length - 1; if (!beyond(i)) return -1;
  while (i - 1 > from && beyond(i - 1)) i--;
  return i;
}
const volBoost = (b, i, from) => { if (i < 0 || !b[i].v) return 0; const base = avg(b.slice(Math.max(0, from), i).map(x => x.v || 0)); return base && b[i].v >= 1.5 * base ? 10 : 0; };
// Down-sampled closes plus the key line(s), so the page can draw a mini chart of the pattern.
function sketch(b, from, lines) {
  from = Math.max(0, from - 3); const seg = b.slice(from), step = Math.max(1, Math.ceil(seg.length / 32)), dp = seg[0].c >= 10 ? 2 : 4;
  const px = []; for (let i = 0; i < seg.length; i += step) px.push(r(seg[i].c, dp)); if ((seg.length - 1) % step) px.push(r(seg[seg.length - 1].c, dp));
  const X = i => r((i - from) / step, 1);
  return { px, ln: lines.map(([i1, p1, i2, p2]) => [X(i1), r(p1, dp), X(i2), r(p2, dp)]) };
}

export function findPatterns(bars, opt = {}) {
  const b = (bars || []).filter(x => x && isFinite(x.c) && isFinite(x.h) && isFinite(x.l)).slice(-(opt.max || 260));
  const n = b.length; if (n < 30) return [];
  const A = atrOf(b) || 1e-9, last = b[n - 1].c, rng = Math.max(...b.map(x => x.h)) - Math.min(...b.map(x => x.l));
  const P = zigzag(b, Math.max((opt.k || 2) * A, 0.05 * rng)), out = [];
  const fresh = opt.fresh || Math.max(6, Math.min(12, Math.round(n * 0.05)));
  const recentPivot = p => p && p.i >= P[Math.max(0, P.length - 3)].i; // among the last pivots
  const add = (id, o) => { const d = PATTERNS[id]; out.push({ id, name: d.name, bias: o.bias || d.bias, status: o.status, conf: Math.max(20, Math.min(95, Math.round(o.conf))), level: r(o.level), target: r(o.target), stop: r(o.stop), start: b[o.from].t, end: b[n - 1].t, at: o.at != null && o.at >= 0 ? b[o.at].t : null, sk: sketch(b, o.from, o.lines || []) }); };
  const live = (brk, lvlOK) => brk >= 0 ? (n - 1 - brk <= fresh && lvlOK ? "break" : null) : "forming";

  // ---- reversal patterns from the last pivots
  for (let k = P.length - 1; k >= 2; k--) {
    const [p1, p2, p3] = [P[k - 2], P[k - 1], P[k]];
    if (k < P.length - 2) break; // only patterns whose last pivot is recent
    if (P[k].live) continue;      // the second top / right shoulder must be confirmed (price already turned away from it)
    // Double top / bottom: p1 & p3 equal extremes, p2 the dip/bounce between; neckline = p2
    const tol = Math.max(A, 0.15 * Math.abs(p2.p - Math.max(p1.p, p3.p)));
    if (p1.t === "H" && p3.t === "H" && Math.abs(p1.p - p3.p) <= tol && Math.min(p1.p, p3.p) - p2.p >= 2.5 * A && p3.i - p1.i >= 6) {
      const prior = P[k - 3], top = Math.max(p1.p, p3.p), h = top - p2.p, brk = crossAt(b, p3.i, () => p2.p, false), st = live(brk, last > p2.p - h);
      if (st && (!prior || prior.p < p2.p)) add("dt", { status: st === "break" ? "breakdown" : "forming", conf: 55 + (prior ? 10 : 0) + (Math.abs(p1.p - p3.p) < 0.5 * A ? 10 : 0) + volBoost(b, brk, p1.i), level: p2.p, target: p2.p - h, stop: top + 0.25 * A, from: prior ? prior.i : p1.i, at: brk, lines: [[p1.i, p2.p, n - 1, p2.p]] });
    }
    if (p1.t === "L" && p3.t === "L" && Math.abs(p1.p - p3.p) <= tol && p2.p - Math.max(p1.p, p3.p) >= 2.5 * A && p3.i - p1.i >= 6) {
      const prior = P[k - 3], bot = Math.min(p1.p, p3.p), h = p2.p - bot, brk = crossAt(b, p3.i, () => p2.p, true), st = live(brk, last < p2.p + h);
      if (st && (!prior || prior.p > p2.p)) add("db", { status: st === "break" ? "breakout" : "forming", conf: 55 + (prior ? 10 : 0) + (Math.abs(p1.p - p3.p) < 0.5 * A ? 10 : 0) + volBoost(b, brk, p1.i), level: p2.p, target: p2.p + h, stop: bot - 0.25 * A, from: prior ? prior.i : p1.i, at: brk, lines: [[p1.i, p2.p, n - 1, p2.p]] });
    }
    // Head & shoulders: H L H L H (or inverse) ending at P[k]
    if (k >= 4) {
      const [a, x, hd, y, c] = P.slice(k - 4, k + 1);
      const neck = i => x.p + (y.p - x.p) * (i - x.i) / ((y.i - x.i) || 1);
      if (a.t === "H" && hd.t === "H" && c.t === "H" && hd.p > Math.max(a.p, c.p) + 0.5 * A && Math.abs(a.p - c.p) <= Math.max(1.5 * A, 0.3 * (hd.p - neck(hd.i)))) {
        const h = hd.p - neck(hd.i), brk = crossAt(b, c.i, neck, false), st = live(brk, last > neck(n - 1) - h), prior = P[k - 5];
        if (st && h >= 3 * A && (!prior || prior.p < Math.min(x.p, y.p))) add("hs", { status: st === "break" ? "breakdown" : "forming", conf: 60 + (Math.abs(a.p - c.p) < A ? 10 : 0) + (prior ? 5 : 0) + volBoost(b, brk, a.i), level: neck(n - 1), target: neck(n - 1) - h, stop: c.p + 0.25 * A, from: prior ? prior.i : a.i, at: brk, lines: [[x.i, neck(x.i), n - 1, neck(n - 1)]] });
      }
      if (a.t === "L" && hd.t === "L" && c.t === "L" && hd.p < Math.min(a.p, c.p) - 0.5 * A && Math.abs(a.p - c.p) <= Math.max(1.5 * A, 0.3 * (neck(hd.i) - hd.p))) {
        const h = neck(hd.i) - hd.p, brk = crossAt(b, c.i, neck, true), st = live(brk, last < neck(n - 1) + h), prior = P[k - 5];
        if (st && h >= 3 * A && (!prior || prior.p > Math.max(x.p, y.p))) add("ihs", { status: st === "break" ? "breakout" : "forming", conf: 60 + (Math.abs(a.p - c.p) < A ? 10 : 0) + (prior ? 5 : 0) + volBoost(b, brk, a.i), level: neck(n - 1), target: neck(n - 1) + h, stop: c.p - 0.25 * A, from: prior ? prior.i : a.i, at: brk, lines: [[x.i, neck(x.i), n - 1, neck(n - 1)]] });
      }
    }
  }

  // ---- triangles and wedges from the last 5–7 pivots (needs 2+ highs and 2+ lows)
  for (const cnt of [7, 6, 5]) {
    const PC = P.filter(p => !p.live); if (PC.length < cnt) continue;
    const seg = PC.slice(-cnt), H = seg.filter(p => p.t === "H"), L = seg.filter(p => p.t === "L");
    if (H.length < 2 || L.length < 2) continue;
    const from = seg[0].i, span = n - 1 - from; if (span < 12) continue;
    const up = fit(H.map(p => [p.i, p.p])), dn = fit(L.map(p => [p.i, p.p]));
    const flat = A * 0.05, w0 = up.at(from) - dn.at(from), w1 = up.at(n - 1) - dn.at(n - 1);
    if (!(w0 > 0) || !(w1 > 0) || w1 > 0.8 * w0 || w0 < 3 * A) continue; // must squeeze
    const fitOK = H.every(p => Math.abs(p.p - up.at(p.i)) <= 1.2 * A) && L.every(p => Math.abs(p.p - dn.at(p.i)) <= 1.2 * A);
    if (!fitOK) continue;
    const lastPiv = seg[seg.length - 1]; const bu = crossAt(b, lastPiv.i, up.at, true, 0.1 * A), bd = crossAt(b, lastPiv.i, dn.at, false, 0.1 * A);
    const brkUp = bu >= 0 && n - 1 - bu <= fresh, brkDn = bd >= 0 && n - 1 - bd <= fresh;
    const st = brkUp ? "breakout" : brkDn ? "breakdown" : bu < 0 && bd < 0 ? "forming" : null; if (!st) continue;
    const touches = H.length + L.length, conf = 50 + Math.min(20, (touches - 4) * 7) + volBoost(b, brkUp ? bu : bd, from);
    const lines = [[from, up.at(from), n - 1, up.at(n - 1)], [from, dn.at(from), n - 1, dn.at(n - 1)]];
    let id;
    if (Math.abs(up.m) <= flat && dn.m > flat) id = "asc";
    else if (Math.abs(dn.m) <= flat && up.m < -flat) id = "desc";
    else if (up.m < -flat && dn.m < -flat) id = "fwedge";
    else if (up.m > flat && dn.m > flat) id = "rwedge";
    else if (up.m < -flat && dn.m > flat) id = "sym";
    if (!id) continue;
    const bias = st === "breakout" ? "bull" : st === "breakdown" ? "bear" : PATTERNS[id].bias;
    const height = w0, lvl = st === "breakdown" ? dn.at(n - 1) : up.at(n - 1);
    add(id, { status: st, bias, conf, level: lvl, target: st === "breakdown" ? lvl - height : (st === "breakout" ? lvl + height : (PATTERNS[id].bias === "bear" ? dn.at(n - 1) - height : up.at(n - 1) + height)),
      stop: st === "breakdown" ? up.at(n - 1) : dn.at(n - 1), from, at: brkUp ? bu : brkDn ? bd : null, lines });
    break;
  }

  // ---- flags: a sharp pole then a small, orderly counter-move inside a channel
  for (const dir of [1, -1]) {
    const look = Math.min(n - 4, 45); let j = -1, ext = dir > 0 ? -Infinity : Infinity;
    for (let i = n - look; i <= n - 4; i++) { const v = dir > 0 ? b[i].h : b[i].l; if (dir > 0 ? v > ext : v < ext) { ext = v; j = i; } }
    if (j < 3) continue;
    let s0 = j, base = dir > 0 ? b[j].l : b[j].h;
    for (let i = j; i >= Math.max(0, j - 20); i--) { const v = dir > 0 ? b[i].l : b[i].h; if (dir > 0 ? v < base : v > base) { base = v; s0 = i; } }
    const pole = Math.abs(ext - base), poleBars = j - s0; if (pole < 4 * A || poleBars < 2 || pole / poleBars < 0.6 * A) continue;
    const fl = b.slice(j + 1), flen = fl.length; if (flen < 3 || flen > Math.max(20, 2.5 * poleBars)) continue;
    const chan = m => { // channel through the first m flag bars, widened so every bar sits inside it
      const body = fl.slice(0, m), X = i => j + 1 + i;
      const retr = dir > 0 ? ext - Math.min(...body.map(x => x.l)) : Math.max(...body.map(x => x.h)) - ext;
      if (retr > 0.5 * pole || retr < 0.5 * A) return null;
      const cf = fit(body.map((x, i) => [X(i), x.c])); if (dir * cf.m > 0.15 * A) return null; // drifts against the pole or sideways
      if (dir > 0 ? Math.max(...body.map(x => x.h)) > ext + 0.25 * A : Math.min(...body.map(x => x.l)) < ext - 0.25 * A) return null;
      const hu = Math.max(...body.map((x, i) => x.c - cf.at(X(i)))), hd = Math.min(...body.map((x, i) => x.c - cf.at(X(i))));
      return { m, retr, top: i => cf.at(i) + hu, bot: i => cf.at(i) + hd, body };
    };
    let best = null;
    for (let m = flen - 1; m >= Math.max(3, flen - fresh); m--) { // a breakout: the bar right after the flag closes outside it
      const ch = chan(m); if (!ch) continue;
      const x = fl[m], i = j + 1 + m;
      if (dir > 0 ? x.c > ch.top(i) + 0.25 * A && x.c > fl[m - 1].h : x.c < ch.bot(i) - 0.25 * A && x.c < fl[m - 1].l) { const back = dir > 0 ? last < ch.bot(n - 1) : last > ch.top(n - 1); if (!back) best = { ch, brk: i }; break; }
    }
    if (!best) { const ch = chan(flen); if (ch && (dir > 0 ? last >= ch.bot(n - 1) - 0.25 * A : last <= ch.top(n - 1) + 0.25 * A)) best = { ch, brk: -1 }; }
    if (!best) continue;
    const { ch, brk } = best, st = brk >= 0 ? (dir > 0 ? "breakout" : "breakdown") : "forming";
    const lvl = dir > 0 ? ch.top(n - 1) : ch.bot(n - 1), id = dir > 0 ? "bflag" : "sflag", ce = j + ch.m;
    add(id, { status: st, conf: 55 + (ch.retr < 0.38 * pole ? 10 : 0) + (ch.m <= poleBars * 1.5 ? 5 : 0) + volBoost(b, brk, j + 1), level: lvl, target: lvl + dir * pole,
      stop: dir > 0 ? Math.min(...ch.body.map(x => x.l)) : Math.max(...ch.body.map(x => x.h)), from: s0, at: brk, lines: [[j + 1, ch.top(j + 1), ce, ch.top(ce)], [j + 1, ch.bot(j + 1), ce, ch.bot(ce)]] });
  }

  // ---- cup & handle on closes: rim → rounded bottom → back to the rim → small handle → break over the rim
  {
    const W = Math.min(n, 150), o = n - W, c = b.slice(o).map(x => x.c);
    let r1 = 0; for (let i = 1; i < Math.floor(W * 0.45); i++) if (c[i] > c[r1]) r1 = i;
    let bt = r1; for (let i = r1; i < W; i++) if (c[i] < c[bt]) bt = i;
    const depth = c[r1] - c[bt], tolRim = Math.max(1.5 * A, 0.15 * depth);
    let r2 = -1; for (let i = bt + 5; i < W; i++) if (c[i] >= c[r1] - tolRim) { r2 = i; break; }
    if (r2 > 0 && depth >= 4 * A && depth <= 0.5 * c[r1] && bt - r1 >= 5) {
      let pk = r2; for (let i = r2; i < Math.min(W, r2 + 6); i++) if (c[i] > c[pk]) pk = i;
      const rim = Math.max(c[r1], c[pk]), brk0 = crossAt(b, o + pk, () => rim, true, 0.1 * A), bi = brk0 >= 0 ? brk0 - o : -1;
      const cupLen = pk - r1, hnd = c.slice(pk + 1, bi >= 0 ? bi : W), hLow = hnd.length ? Math.min(...hnd) : c[pk], hDepth = c[pk] - hLow;
      const lowZone = c.slice(r1, pk + 1).filter(v => v <= c[bt] + depth / 3).length; // U-shape: time spent near the bottom
      if (cupLen >= 15 && lowZone >= 0.2 * cupLen && hnd.length >= 2 && hnd.length <= cupLen / 2 && hDepth <= 0.5 * depth && hDepth >= 0.3 * A) {
        const brk = bi >= 0 ? o + bi : -1, st = brk >= 0 ? (n - 1 - brk <= fresh ? "breakout" : null) : (last >= hLow && last >= rim - 0.4 * depth ? "forming" : null);
        if (st) add("cup", { status: st, conf: 55 + (lowZone >= 0.35 * cupLen ? 10 : 0) + (Math.abs(c[r1] - c[pk]) < A ? 10 : 0) + volBoost(b, brk, o + r1), level: rim, target: rim + depth, stop: o + pk < n ? hLow - 0.25 * A : null, from: o + r1, at: brk, lines: [[o + r1, rim, n - 1, rim]] });
      }
    }
  }

  // newest/most confident first; one entry per pattern type
  const seen = new Set();
  return out.sort((x, y) => (y.status !== "forming") - (x.status !== "forming") || y.conf - x.conf).filter(p => !seen.has(p.id) && seen.add(p.id)).slice(0, opt.limit || 4);
}

// Merge bars into bigger ones by a key function (e.g. 5m → 10m, 1h → 4h).
export function aggregate(bars, keyOf) {
  const out = []; let cur = null, ck = null;
  for (const x of bars) {
    const k = keyOf(x.t);
    if (k !== ck) { if (cur) out.push(cur); cur = { t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v || 0 }; ck = k; }
    else { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; cur.v += x.v || 0; }
  }
  if (cur) out.push(cur);
  return out;
}
// Summary used by the screen: bullish / bearish counts and the best pattern per side.
export function patternSummary(byTf) {
  const all = []; for (const tf of TIMEFRAMES) for (const p of (byTf && byTf[tf]) || []) all.push({ ...p, tf });
  const bull = all.filter(p => p.bias === "bull"), bear = all.filter(p => p.bias === "bear");
  const best = a => a.slice().sort((x, y) => (y.status !== "forming") - (x.status !== "forming") || y.conf - x.conf)[0] || null;
  return { all, bull, bear, bestBull: best(bull), bestBear: best(bear) };
}
