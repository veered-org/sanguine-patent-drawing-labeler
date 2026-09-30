// Alizarin placement engine: puts reference numerals and leader lines on a patent
// drawing so that the numerals sit in clear space, the leader lines are short and
// cross as few drawing lines as possible, and no two labels or leaders collide.
//
// Everything works on one rendered sheet at a time:
//   ink     Uint8Array, W*H, 1 where the sheet (without labels) has a dark pixel
//   S       pixels per PDF point (the render scale)
//   sight   [x0, y0, x1, y1] in px: labels must stay inside (the 37 CFR 1.84 margins)
//   items   [{key, text, tips: [[x,y], ...], center: [x,y], fixed: box|null}]
//             tips are candidate points on the part (the first is the one clicked);
//             center is the centre of the figure the part belongs to.
//   measure (text) -> [w, h] in px of the numeral's box
// It is a generalisation of a one-off script written for a single application.
(function (root) {
  'use strict';

  function integral(mask, W, H) {
    const ii = new Int32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0;
      const o = y * W, a = (y + 1) * (W + 1), b = y * (W + 1);
      for (let x = 0; x < W; x++) {
        row += mask[o + x];
        ii[a + x + 1] = ii[b + x + 1] + row;
      }
    }
    return ii;
  }

  function Grid(mask, W, H) {
    this.W = W; this.H = H; this.mask = mask; this.ii = integral(mask, W, H);
  }
  Grid.prototype.sum = function (x0, y0, x1, y1) {
    const W = this.W, H = this.H;
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W, Math.floor(x1)); y1 = Math.min(H, Math.floor(y1));
    if (x1 <= x0 || y1 <= y0) return 0;
    const ii = this.ii, w = W + 1;
    return ii[y1 * w + x1] - ii[y0 * w + x1] - ii[y1 * w + x0] + ii[y0 * w + x0];
  };

  // Square dilation by r pixels, done with the integral image.
  function dilate(grid, r) {
    const W = grid.W, H = grid.H, out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (grid.sum(x - r, y - r, x + r + 1, y + r + 1) > 0) out[y * W + x] = 1;
    return out;
  }

  // The filled outline of the drawing: everything the background cannot reach from
  // the sheet edge once gaps narrower than ~2*close px are sealed.
  function silhouette(ink, W, H, close) {
    const big = dilate(new Grid(ink, W, H), close);
    const outside = new Uint8Array(W * H);
    const stack = [];
    for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
    for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
    while (stack.length) {
      const i = stack.pop();
      if (outside[i] || big[i]) continue;
      outside[i] = 1;
      const x = i % W;
      if (x > 0) stack.push(i - 1);
      if (x < W - 1) stack.push(i + 1);
      if (i >= W) stack.push(i - W);
      if (i < W * (H - 1)) stack.push(i + W);
    }
    // erode the sealed shape back by the same radius (= dilate the outside)
    const og = dilate(new Grid(outside, W, H), close);
    const sil = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) sil[i] = og[i] ? 0 : 1;
    return sil;
  }

  function segInter(p1, p2, p3, p4) {
    const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return o(p3, p4, p1) * o(p3, p4, p2) < 0 && o(p1, p2, p3) * o(p1, p2, p4) < 0;
  }
  function segRect(p, q, r) {
    const [x0, y0, x1, y1] = r;
    for (const t of [p, q]) if (x0 <= t[0] && t[0] <= x1 && y0 <= t[1] && t[1] <= y1) return true;
    const e = [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]];
    return e.some(([a, b]) => segInter(p, q, a, b));
  }
  function ptSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function segGap(s1, s2) {
    return Math.min(ptSeg(s1[0], s2[0], s2[1]), ptSeg(s1[1], s2[0], s2[1]),
                    ptSeg(s2[0], s1[0], s1[1]), ptSeg(s2[1], s1[0], s1[1]));
  }
  function boxesTouch(a, b, pad) {
    return !(a[2] + pad < b[0] || a[0] - pad > b[2] || a[3] + pad < b[1] || a[1] - pad > b[3]);
  }

  // Where the leader line meets the numeral: on a slightly padded box, aimed at the tip.
  function edgePoint(tip, box, pad) {
    const x0 = box[0] - pad, y0 = box[1] - pad, x1 = box[2] + pad, y1 = box[3] + pad;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, dx = tip[0] - cx, dy = tip[1] - cy;
    const t = Math.min(dx ? (x1 - cx) / Math.abs(dx) : 1e9, dy ? (y1 - cy) / Math.abs(dy) : 1e9);
    return [cx + dx * t, cy + dy * t];
  }

  // Prepares a sheet once; place() and friends can then run many times.
  function Sheet(ink, W, H, S, sight) {
    const k = S / 2.7778;                 // the original tuning was at 200 dpi
    this.W = W; this.H = H; this.S = S; this.sight = sight; this.k = k;
    this.ink = ink;
    this.inkd = dilate(new Grid(ink, W, H), Math.max(1, Math.round(2 * k)));
    this.clear = new Grid(this.inkd, W, H);
    this.sil = new Grid(silhouette(ink, W, H, Math.max(4, Math.round(12 * k))), W, H);
  }

  // Nearest ink pixel to (x, y) within r px, or null.
  Sheet.prototype.snap = function (x, y, r) {
    r = r || Math.round(18 * this.k);
    x = Math.round(x); y = Math.round(y);
    let best = null, bd = Infinity;
    for (let yy = Math.max(0, y - r); yy <= Math.min(this.H - 1, y + r); yy++)
      for (let xx = Math.max(0, x - r); xx <= Math.min(this.W - 1, x + r); xx++)
        if (this.ink[yy * this.W + xx]) {
          const d = (xx - x) * (xx - x) + (yy - y) * (yy - y);
          if (d < bd) { bd = d; best = [xx, yy]; }
        }
    return best;
  };

  // How many separate drawing lines the segment p->q crosses (ignoring the first
  // few px at the tip, which sit on the part itself), and how many px are on ink.
  Sheet.prototype.crossings = function (p, q) {
    const skip = Math.round(10 * this.k);
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]), n = Math.floor(L);
    if (n <= skip) return [0, 0];
    let runs = 0, on = 0, prev = 0;
    for (let i = skip; i < n; i++) {
      const t = i / L;
      const x = Math.round(p[0] + (q[0] - p[0]) * t), y = Math.round(p[1] + (q[1] - p[1]) * t);
      const v = (x >= 0 && y >= 0 && x < this.W && y < this.H) ? this.inkd[y * this.W + x] : 0;
      if (v) { on++; if (!prev) runs++; }
      prev = v;
    }
    return [runs, on];
  };

  Sheet.prototype.candidates = function (it, measure) {
    const k = this.k, [w, h] = measure(it.text), s = this.sight;
    if (it.fixed) {
      const box = it.fixed;
      const c = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      const tip = it.tips.reduce((a, b) => Math.hypot(a[0] - c[0], a[1] - c[1]) <= Math.hypot(b[0] - c[0], b[1] - c[1]) ? a : b);
      return [{ cost: 0, box, end: edgePoint(tip, box, 5 * k), tip }];
    }
    const out = [], cl = 10 * k, inner = 30 * k;
    const fc = it.center || [this.W / 2, this.H / 2];
    for (const tip of it.tips) {
      for (let ang = 0; ang < 360; ang += 10) {
        const a = ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
        for (let dist = 48 * k; dist < 760 * k; dist += 16 * k) {
          const cx = tip[0] + ca * dist, cy = tip[1] + sa * dist;
          const box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
          if (box[0] < s[0] || box[1] < s[1] || box[2] > s[2] || box[3] > s[3]) continue;
          if (this.clear.sum(box[0] - cl, box[1] - cl, box[2] + cl, box[3] + cl)) continue;
          const inside = this.sil.sum(box[0] - cl, box[1] - cl, box[2] + cl, box[3] + cl) > 0;
          if (inside && this.clear.sum(box[0] - inner, box[1] - inner, box[2] + inner, box[3] + inner)) continue;
          const end = edgePoint(tip, box, 5 * k);
          const [r, on] = this.crossings(tip, end);
          const L = Math.hypot(tip[0] - end[0], tip[1] - end[1]) / k;
          const v = [tip[0] - fc[0], tip[1] - fc[1]], u = [cx - tip[0], cy - tip[1]];
          const cos = (v[0] * u[0] + v[1] * u[1]) / ((Math.hypot(v[0], v[1]) || 1) * (Math.hypot(u[0], u[1]) || 1));
          const cost = r * 600 + (on / k) * 4 + L * 0.25 + (1 - cos) * 40 + (inside ? 2500 : 0);
          out.push({ cost, box, end, tip });
        }
      }
    }
    out.sort((a, b) => a.cost - b.cost);
    return out.slice(0, 3000);
  };

  // Places every item. Returns {key: {box, tip, end, crossings}} (missing = no room).
  Sheet.prototype.place = function (items, measure, obstacles) {
    const k = this.k, self = this;
    obstacles = obstacles || { boxes: [], segs: [] };
    const its = items.filter(it => it.tips && it.tips.length).map(it => Object.assign({}, it));
    for (const it of its) it.cands = this.candidates(it, measure);

    function ok(it, c, boxes, segs) {
      if (it.fixed) return true;
      const pad = 16 * k;
      for (const b of boxes) if (boxesTouch(c.box, b, pad)) return false;
      const seg = [c.tip, c.end];
      for (const s2 of segs) if (segInter(seg[0], seg[1], s2[0], s2[1]) || segGap(seg, s2) < 20 * k) return false;
      for (const b of boxes) if (segRect(seg[0], seg[1], [b[0] - 5 * k, b[1] - 5 * k, b[2] + 5 * k, b[3] + 5 * k])) return false;
      const pb = [c.box[0] - pad, c.box[1] - pad, c.box[2] + pad, c.box[3] + pad];
      for (const s2 of segs) if (segRect(s2[0], s2[1], pb)) return false;
      return true;
    }
    // Leaders that run close past another part's tip read as pointing at it.
    function dyn(it, c) {
      let near = 0;
      for (const o of its) if (o !== it && o.tips[0] && ptSeg(o.tips[0], c.tip, c.end) < 20 * k) near++;
      return c.cost + 300 * near;
    }
    function pick(it, boxes, segs) {
      let best = null;
      for (const c of it.cands) {
        if (best && c.cost >= best.d) break;
        if (ok(it, c, boxes, segs)) {
          const d = dyn(it, c);
          if (!best || d < best.d) best = { d, c };
        }
      }
      return best ? best.c : null;
    }
    const chosen = new Map();
    function place(order) {
      chosen.clear();
      const boxes = obstacles.boxes.slice(), segs = obstacles.segs.slice();
      for (const it of order) {
        const c = pick(it, boxes, segs); chosen.set(it, c);
        if (c) { boxes.push(c.box); segs.push([c.tip, c.end]); }
      }
    }
    // hardest first: the items with the fewest cheap spots
    let order = its.slice().sort((a, b) =>
      (a.fixed ? 0 : 1) - (b.fixed ? 0 : 1) ||
      a.cands.filter(c => c.cost < 150).length - b.cands.filter(c => c.cost < 150).length);
    place(order);
    for (let i = 0; i < 10; i++) {
      const miss = order.filter(it => !chosen.get(it));
      if (!miss.length) break;
      order = miss.concat(order.filter(it => chosen.get(it)));
      place(order);
    }
    for (let pass = 0; pass < 5; pass++) {
      for (const it of order) {
        const others = order.filter(o => o !== it && chosen.get(o));
        const c = pick(it, obstacles.boxes.concat(others.map(o => chosen.get(o).box)),
                      obstacles.segs.concat(others.map(o => [chosen.get(o).tip, chosen.get(o).end])));
        if (c) chosen.set(it, c);
      }
    }
    const res = {};
    for (const it of its) {
      const c = chosen.get(it);
      if (c) res[it.key] = { box: c.box, tip: c.tip, end: c.end, crossings: self.crossings(c.tip, c.end)[0] };
    }
    return res;
  };

  // "FIG. n": centred under the figure (figBox = its ink extent), in clear space,
  // away from the numerals already placed. Falls back to above/inside if needed.
  Sheet.prototype.placeFigLabel = function (figBox, wh, placed) {
    const k = this.k, s = this.sight, [w, h] = wh;
    const fcx = (figBox[0] + figBox[2]) / 2, c30 = 30 * k, p24 = 24 * k;
    const free = box => {
      if (box[0] < s[0] || box[2] > s[2] || box[1] < s[1] || box[3] > s[3]) return false;
      if (this.clear.sum(box[0] - c30, box[1] - c30, box[2] + c30, box[3] + c30)) return false;
      const pb = [box[0] - p24, box[1] - p24, box[2] + p24, box[3] + p24];
      for (const p of placed) {
        if (boxesTouch(pb, p.box, 0)) return false;
        if (segRect(p.tip, p.end, pb)) return false;
      }
      return true;
    };
    const dxs = [];
    for (let d = 0; d <= 500 * k; d += 10 * k) { dxs.push(d); if (d) dxs.push(-d); }
    for (let dy = 0; dy < 400 * k; dy += 8 * k)
      for (const dx of dxs) {
        const cx = fcx + dx, cy = figBox[3] + 70 * k + dy;
        const box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
        if (free(box)) return box;
      }
    for (let dy = 0; dy < 400 * k; dy += 8 * k) {       // above the figure
      const cy = figBox[1] - 60 * k - dy;
      const box = [fcx - w / 2, cy - h / 2, fcx + w / 2, cy + h / 2];
      if (free(box)) return box;
    }
    const cy = Math.min(s[3] - h / 2, figBox[3] + 50 * k);
    return [fcx - w / 2, cy - h / 2, fcx + w / 2, cy + h / 2];
  };

  // Figure finder: groups the ink on a page into separate drawings. Returns boxes in px,
  // biggest-first-by-reading-order (top to bottom, then left to right).
  function findFigures(ink, W, H, S) {
    const step = Math.max(1, Math.round(S * 2));          // work on a ~36 dpi grid
    const w = Math.ceil(W / step), h = Math.ceil(H / step);
    const g = new Uint8Array(w * h);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink[y * W + x]) g[((y / step) | 0) * w + ((x / step) | 0)] = 1;
    const cellPt = step / S;
    const r = Math.max(1, Math.round(6 / cellPt));        // strokes of one drawing join within ~6 pt
    const d = dilate(new Grid(g, w, h), r);
    const lab = new Int32Array(w * h); let n = 0; let boxes = [];
    for (let i = 0; i < w * h; i++) {
      if (!d[i] || lab[i]) continue;
      n++; let x0 = w, y0 = h, x1 = 0, y1 = 0, cnt = 0; const st = [i]; lab[i] = n;
      while (st.length) {
        const j = st.pop(), x = j % w, y = (j / w) | 0;
        if (g[j]) { cnt++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
        for (const nb of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w])
          if (nb >= 0 && nb < w * h && d[nb] && !lab[nb]) { lab[nb] = n; st.push(nb); }
      }
      if (cnt) boxes.push({ box: [x0 * step, y0 * step, (x1 + 1) * step, (y1 + 1) * step], cnt });
    }
    const area = b => (b[2] - b[0]) * (b[3] - b[1]);
    const ovl = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const gap = (a, b) => Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3], 0);
    const union = (a, b) => ({ box: [Math.min(a.box[0], b.box[0]), Math.min(a.box[1], b.box[1]), Math.max(a.box[2], b.box[2]), Math.max(a.box[3], b.box[3])], cnt: a.cnt + b.cnt });
    // parts drawn inside another part's outline (a hub inside a wheel) belong to it
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < boxes.length && !merged; i++) for (let j = i + 1; j < boxes.length && !merged; j++)
        if (ovl(boxes[i].box, boxes[j].box) > 0.3 * Math.min(area(boxes[i].box), area(boxes[j].box))) {
          boxes[i] = union(boxes[i], boxes[j]); boxes.splice(j, 1); merged = true;
        }
    }
    const total = boxes.reduce((a, b) => a + b.cnt, 0) || 1, pt = S;
    const isBig = b => {
      const w = b.box[2] - b.box[0], h = b.box[3] - b.box[1];
      return b.cnt / total > 0.04 && Math.max(w, h) > 60 * pt && Math.min(w, h) > 20 * pt;
    };
    const keep = boxes.filter(isBig);
    // loose bits near a drawing (a detached fastener, a lead line) join the nearest one;
    // everything else (captions, page numbers, specks) is left out
    for (const b of boxes.filter(b => !isBig(b))) {
      let best = null, bd = 25 * pt;
      for (const k of keep) { const d2 = gap(b.box, k.box); if (d2 < bd) { bd = d2; best = k; } }
      if (best && b.cnt / total > 0.002) Object.assign(best, union(best, b));
    }
    keep.sort((a, b) => {
      const ay = (a.box[1] + a.box[3]) / 2, by = (b.box[1] + b.box[3]) / 2;
      const overlapY = Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1]);
      if (overlapY > 0.3 * Math.min(a.box[3] - a.box[1], b.box[3] - b.box[1])) return a.box[0] - b.box[0];
      return ay - by;
    });
    return keep.map(b => b.box);
  }

  // Dark pixels of an RGBA canvas buffer.
  function inkFromRGBA(data, W, H, threshold) {
    threshold = threshold || 190;
    const ink = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      const a = data[p + 3] / 255;
      const g = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) * a + 255 * (1 - a);
      if (g < threshold) ink[i] = 1;
    }
    return ink;
  }

  // Numerals as they appear in a parts list: "26a" -> base "26", suffix "a".
  function splitNumeral(t) {
    const m = String(t).trim().match(/^(\d+)(.*)$/);
    return m ? [m[1], m[2]] : [String(t).trim(), ''];
  }

  const api = { Sheet, findFigures, inkFromRGBA, edgePoint, splitNumeral, segInter, segRect, boxesTouch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AlizarinEngine = api;
})(typeof self !== 'undefined' ? self : this);
