// Line diffs for the /update page: Myers' algorithm on the changed middle (common start and end trimmed first).
// diffLines(a, b) → [{t: " " | "-" | "+", a: old line no., b: new line no., s: text}]

const split = s => { if (s == null || s === "") return []; const L = String(s).split("\n"); if (L[L.length - 1] === "") L.pop(); return L; };

function myers(A, B, maxD) {
  const N = A.length, M = B.length, off = maxD + 1, V = new Int32Array(2 * maxD + 3), trace = [];
  V[off + 1] = 0;
  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1, y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= N && y >= M) {
        trace.push(V.slice(off - d, off + d + 1));
        const ops = []; let X = N, Y = M;
        for (let e = d; e > 0; e--) {
          const P = trace[e - 1], kk = X - Y, at = j => P[j + e - 1];
          const down = kk === -e || (kk !== e && at(kk - 1) < at(kk + 1)), pk = down ? kk + 1 : kk - 1, px = at(pk), py = px - pk;
          while (X > px && Y > py) { ops.push([" ", X - 1, Y - 1]); X--; Y--; }
          if (down) { ops.push(["+", null, Y - 1]); Y--; } else { ops.push(["-", X - 1, null]); X--; }
        }
        while (X > 0 && Y > 0) { ops.push([" ", X - 1, Y - 1]); X--; Y--; }
        return ops.reverse();
      }
    }
    trace.push(V.slice(off - d, off + d + 1));
  }
  return null;
}

export function diffLines(a, b, { maxD = 1500 } = {}) {
  const A = split(a), B = split(b);
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0; while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const midA = A.slice(p, A.length - q), midB = B.slice(p, B.length - q);
  const out = [];
  for (let i = 0; i < p; i++) out.push({ t: " ", a: i + 1, b: i + 1, s: A[i] });
  const ops = midA.length && midB.length ? myers(midA, midB, Math.min(maxD, midA.length + midB.length)) : null;
  if (ops) for (const [t, x, y] of ops) out.push({ t, a: x == null ? null : p + x + 1, b: y == null ? null : p + y + 1, s: t === "+" ? midB[y] : midA[x] });
  else { // one side empty, or too different to align: everything old out, everything new in
    midA.forEach((s, i) => out.push({ t: "-", a: p + i + 1, b: null, s }));
    midB.forEach((s, i) => out.push({ t: "+", a: null, b: p + i + 1, s }));
  }
  for (let i = 0; i < q; i++) { const ai = A.length - q + i, bi = B.length - q + i; out.push({ t: " ", a: ai + 1, b: bi + 1, s: A[ai] }); }
  return out;
}

export const stats = ops => ops.reduce((s, o) => (o.t === "+" ? s.add++ : o.t === "-" ? s.del++ : 0, s), { add: 0, del: 0 });

// Groups changes into hunks with `ctx` unchanged lines around each.
export function hunks(ops, ctx = 3) {
  const out = []; let cur = null, lastChange = -Infinity;
  ops.forEach((o, i) => {
    if (o.t === " ") return;
    if (cur && i - lastChange <= 2 * ctx + 1) { for (let j = lastChange + 1; j <= i; j++) cur.lines.push(ops[j]); }
    else { if (cur) cur.lines.push(...ops.slice(lastChange + 1, Math.min(ops.length, lastChange + 1 + ctx))); cur = { lines: ops.slice(Math.max(0, i - ctx), i + 1) }; out.push(cur); }
    lastChange = i;
  });
  if (cur) cur.lines.push(...ops.slice(lastChange + 1, Math.min(ops.length, lastChange + 1 + ctx)));
  for (const h of out) { const f = h.lines.find(l => l.a != null), g = h.lines.find(l => l.b != null); h.a = f ? f.a : 0; h.b = g ? g.b : 0; }
  return out;
}
