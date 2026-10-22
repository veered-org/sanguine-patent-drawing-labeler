// Sanguine: the page. Everything runs in the browser; the drawing never leaves it, except
// when you ask Claude with your own API key (then the sheet images go to Anthropic's API).
// Coordinates: "source pt" = PDF points on a source page (top-left origin, as shown);
// "sheet pt" = points on an output sheet; the engine works in sheet px (S px per pt).
(function () {
  'use strict';
  const E = window.SanguineEngine;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const PPTX_URL = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.1/+esm';
  const S = 2;                                        // px per pt for display and placement
  const PAPER = { letter: [612, 792], a4: [595.28, 841.89] };
  const MARGIN = { t: 72, l: 72, r: 45, b: 27 };      // 37 CFR 1.84(g): 2.5, 2.5, 1.5, 1.0 cm
  const PAD = { l: 58, r: 58, t: 34, b: 70 };         // room for numerals around an enlarged figure
  const MAXSC = 1.6;
  const LINE_W = 0.8, SHEETNUM_FS = 12, NOTE_FS = 14;
  const ARROW_L = 7, ARROW_W = 2.4;                   // arrowhead length and half-width, pt
  const PROJECT_NAME = 'sanguine-project.json';       // the attachment inside an editable PDF
  const $ = id => document.getElementById(id);

  let doc = null;            // {name, kind, mime, bytes, pages: [{w, h, pj|img, canvas, ink}]}
  let st = freshState();
  let sheets = [];
  let surfaces = [];
  let mode = 'labels', tool = 'select', zoomPt = 1, activePart = null, pendingProject = null;
  let selection = [];        // [{kind: 'label'|'note'|'figlabel'|'fig', id}], last = primary
  let helv = null, helvB = null, spaceHeld = false;
  const undoStack = [], redoStack = [];

  function freshState() {
    return { figures: [], parts: [], labels: [], notes: [], figLabels: {}, nextId: 1,
             opts: { layout: 'keep', paper: 'letter', sheetnums: false, figlabels: true, curves: true, fs: 14, figfs: 20 } };
  }
  // Older project files lack notes and leader styles.
  function upgradeState(s) {
    const f = freshState();
    s.opts = Object.assign(f.opts, s.opts || {});
    s.notes = s.notes || []; s.figLabels = s.figLabels || {};
    for (const l of s.labels || []) { if (!l.style) l.style = 'line'; if (!l.alts) l.alts = []; }
    return s;
  }
  const nid = () => st.nextId++;

  // Liberation Sans has Helvetica/Arial metrics and, unlike the PDF standard fonts, can be
  // embedded, which Patent Center requires.
  const FONT_URLS = ['fonts/LiberationSans-Regular.ttf', 'fonts/LiberationSans-Bold.ttf'];
  let fontBytes = null;
  const fontsReady = (async () => {
    fontBytes = await Promise.all(FONT_URLS.map(u => fetch(u).then(r => { if (!r.ok) throw new Error(u); return r.arrayBuffer(); })));
    const d = await PDFLib.PDFDocument.create();
    d.registerFontkit(window.fontkit);
    helv = await d.embedFont(fontBytes[0]);
    helvB = await d.embedFont(fontBytes[1]);
    try { await document.fonts.load('14px AlzSans'); await document.fonts.load('bold 14px AlzSans'); } catch (e) { /* canvas falls back to Helvetica/Arial */ }
  })().catch(err => { console.error(err); status('The label font did not load; reload the page.', 'bad'); });
  function measure(text, bold, size) {
    const f = bold ? helvB : helv;
    return [f ? f.widthOfTextAtSize(text, size) : text.length * size * 0.556, size * 0.72];
  }
  const measurePx = t => measure(t, false, st.opts.fs).map(v => v * S);
  const canvasFont = (size, bold) => `${bold ? 'bold ' : ''}${size}px AlzSans, Helvetica, Arial, sans-serif`;

  // ---------------------------------------------------------------- helpers
  let toastTimer = null;
  function status(msg, cls) {
    const el = $('toast');
    clearTimeout(toastTimer);
    if (!msg) { el.classList.remove('on'); return; }
    el.textContent = msg; el.className = 'toast on ' + (cls || '');
    toastTimer = setTimeout(() => el.classList.remove('on'), cls === 'bad' ? 12000 : 6000);
  }
  function download(data, name, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const baseName = () => doc ? doc.name.replace(/\.[^.]+$/, '').replace(/-labeled(-editable)?$/, '') : 'drawing';
  function loadScript(src) {
    return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  }
  function loadImage(url) {
    return new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const xmlEsc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function numKey(t) { const [b, s] = E.splitNumeral(t); return [isNaN(+b) ? 1e9 : +b, s]; }
  function cmpNum(a, b) { const x = numKey(a), y = numKey(b); return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0); }
  function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function fromB64(b) { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const add = (p, d) => [p[0] + d[0], p[1] + d[1]];

  // ---------------------------------------------------------------- undo
  const whitesOf = s => JSON.stringify((s.notes || []).filter(n => n.kind === 'white'));
  function snapshot() {
    undoStack.push(JSON.stringify(st)); if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0; updateUndoButtons();
  }
  async function restoreState(json) {
    const prev = upgradeState(JSON.parse(json));
    const relayout = JSON.stringify([prev.figures, prev.opts]) !== JSON.stringify([st.figures, st.opts]) || whitesOf(prev) !== whitesOf(st);
    st = prev; selection = selection.filter(exists); syncOptsToUI();
    if (relayout) await rebuild(false); else { renderLists(); drawAll(); }
    updateUndoButtons();
  }
  async function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(st)); await restoreState(undoStack.pop()); }
  async function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(st)); await restoreState(redoStack.pop()); }
  function updateUndoButtons() { $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length; }

  // ---------------------------------------------------------------- selection
  const isSel = (kind, id) => selection.some(s => s.kind === kind && s.id === id);
  const primary = () => selection[selection.length - 1] || null;
  function select(kind, id, toggle) {
    if (kind == null) { selection = []; return; }
    if (toggle && isSel(kind, id)) selection = selection.filter(s => !(s.kind === kind && s.id === id));
    else if (toggle) selection.push({ kind, id });
    else selection = [{ kind, id }];
  }
  function exists(s) {
    if (s.kind === 'label') return st.labels.some(l => l.id === s.id);
    if (s.kind === 'note') return st.notes.some(n => n.id === s.id);
    if (s.kind === 'figlabel') return !!st.figLabels[s.id];
    if (s.kind === 'fig') return !!figById(s.id);
    return false;
  }
  const only = kind => selection.length === 1 && selection[0].kind === kind ? selection[0].id : null;
  const selLabel = () => { const id = only('label'); return id == null ? null : st.labels.find(l => l.id === id); };
  const selNote = () => { const id = only('note'); return id == null ? null : st.notes.find(n => n.id === id); };

  // ---------------------------------------------------------------- figures & sheets
  const figById = id => st.figures.find(f => f.id === id);
  const partById = id => st.parts.find(p => p.id === id);
  const labelText = l => l.text != null && l.text !== '' ? l.text : (partById(l.part) || {}).n || '?';
  const figLabelText = f => 'FIG. ' + f.num;

  async function renderSource(p) {
    const c = document.createElement('canvas');
    c.width = Math.round(p.w * S); c.height = Math.round(p.h * S);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    if (p.pj) await p.pj.render({ canvasContext: ctx, viewport: p.pj.getViewport({ scale: S }), intent: 'print' }).promise;
    else ctx.drawImage(p.img, 0, 0, c.width, c.height);
    p.canvas = c;
    p.ink = E.inkFromRGBA(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    // "FIG. 3" captions drawn on the sheet: kept out of the figure boxes
    const caps = E.findCaptions(p.ink, c.width, c.height, S);
    p.capsPx = caps; p.caps = caps.map(b => b.map(v => v / S));
    p.figInk = p.ink;
    if (caps.length) {
      p.figInk = p.ink.slice();
      for (const b of caps) for (let y = Math.max(0, b[1] - 2); y < Math.min(c.height, b[3] + 2); y++) p.figInk.fill(0, y * c.width + Math.max(0, b[0] - 2), y * c.width + Math.min(c.width, b[2] + 2));
    }
  }
  // The caption drawn for a figure: the nearest one below or beside it, unless it was
  // whited out. On split sheets the crop leaves it out, so the figure gets a new label.
  const figCaption = f => st.opts.layout === 'split' ? null : drawnCaption(f);
  function drawnCaption(f) {
    const P = doc && doc.pages[f.page];
    if (!P || !P.caps) return null;
    const gap = (a, b) => Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3], 0);
    const mine = st.figures.filter(o => o.page === f.page);
    return P.caps.find(c => gap(c, f.box) < 60 && mine.every(o => gap(c, o.box) >= gap(c, f.box)) &&
      !st.notes.some(n => n.kind === 'white' && n.page === f.page && inBox([(c[0] + c[2]) / 2, (c[1] + c[3]) / 2], normRect(n.a, n.b), 0))) || null;
  }

  function findAllFigures() {
    st.figures = [];
    doc.pages.forEach((p, i) => {
      let boxes = E.findFigures(p.figInk, p.canvas.width, p.canvas.height, S, p.capsPx).map(b => b.map(v => v / S));
      if (!boxes.length) boxes = [[MARGIN.l, MARGIN.t, p.w - MARGIN.r, p.h - MARGIN.b]];
      for (const b of boxes) {
        const pad = 4;
        st.figures.push({ id: nid(), page: i, box: [Math.max(0, b[0] - pad), Math.max(0, b[1] - pad), Math.min(p.w, b[2] + pad), Math.min(p.h, b[3] + pad)], num: '' });
      }
    });
    renumberFigures();
  }
  // Figures take the numbers written in their captions when most of them can be read
  // and the rest follow from their neighbours (between 3 and 4b comes 4a); otherwise
  // they are numbered in order.
  function renumberFigures() {
    const read = fillNumbers(st.figures.map(f => { const c = drawnCaption(f); return c && captionNumber(f.page, c); }));
    st.figures.forEach((f, i) => { f.num = read ? read[i] : String(i + 1); });
  }
  function fillNumbers(read) {
    if (!read.length || read.filter(Boolean).length < 0.6 * read.length) return null;
    const parse = t => { const m = /^(\d+)([a-z]?)$/i.exec(t || ''); return m && { n: +m[1], s: m[2] }; };
    const shift = (c, d) => String.fromCharCode(c.charCodeAt(0) + d);
    const out = read.slice();
    for (let i = 0; i < out.length; i++) {
      if (out[i]) continue;
      const p = parse(out[i - 1]), q = parse(read.slice(i + 1).find(Boolean)), nextKnown = !!read[i + 1];
      let g = null;
      if (p && p.s) g = p.n + shift(p.s, 1);                              // 5a -> 5b
      else if (q && q.s && nextKnown && q.s.toLowerCase() > 'a') g = q.n + shift(q.s, -1);   // -> 4a before 4b
      else if (p) g = String(p.n + 1);
      else if (q && nextKnown && !q.s && q.n > 1) g = String(q.n - 1);
      if (!g) return null;
      out[i] = g;
    }
    return new Set(out).size === out.length ? out : null;
  }

  // Reads the number in a drawn caption ("FIG. 4a") by matching each mark against the
  // letters and digits of a few common typefaces. Returns null when it is not sure.
  const GW = 8, GH = 12;
  let glyphs = null;
  function glyphVec(get, x0, y0, w, h) {          // share of ink in each cell of a GW x GH grid
    const v = new Float32Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      const ax = Math.floor(x0 + gx * w / GW), bx = Math.max(ax + 1, Math.ceil(x0 + (gx + 1) * w / GW));
      const ay = Math.floor(y0 + gy * h / GH), by = Math.max(ay + 1, Math.ceil(y0 + (gy + 1) * h / GH));
      let n = 0, t = 0;
      for (let y = ay; y < by; y++) for (let x = ax; x < bx; x++) { t++; n += get(x, y); }
      v[gy * GW + gx] = n / t;
    }
    return v;
  }
  function glyphTemplates() {
    if (glyphs) return glyphs;
    glyphs = [];
    const c = document.createElement('canvas'); c.width = 90; c.height = 100;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    for (const fam of ['AlzSans', 'Arial', 'Helvetica', 'sans-serif', 'Times New Roman', 'serif'])
      for (const style of ['', 'italic ', 'bold ']) {
        let capH = 0;
        for (const ch of 'H0123456789abcdefghABCDEFGI') {
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 90, 100);
          ctx.fillStyle = '#000'; ctx.font = `${style}64px ${fam}`; ctx.fillText(ch, 12, 80);
          const d = ctx.getImageData(0, 0, 90, 100).data, get = (x, y) => d[(y * 90 + x) * 4] < 128 ? 1 : 0;
          let x0 = 90, y0 = 100, x1 = -1, y1 = -1;
          for (let y = 0; y < 100; y++) for (let x = 0; x < 90; x++) if (get(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          if (x1 < 0) continue;
          if (!capH) capH = y1 - y0 + 1;                  // 'H' comes first: the capital height
          glyphs.push({ ch, ar: (x1 - x0 + 1) / (y1 - y0 + 1), hr: (y1 - y0 + 1) / capH, v: glyphVec(get, x0, y0, x1 - x0 + 1, y1 - y0 + 1) });
        }
      }
    return glyphs;
  }
  function captionNumber(page, cap) {
    const P = doc.pages[page]; if (!P || !P.ink) return null;
    const W = P.canvas.width, H = P.canvas.height, ink = P.ink;
    const lh = (cap[3] - cap[1]) * S;
    const bx = [Math.max(0, Math.floor(cap[0] * S) - 2), Math.max(0, Math.floor(cap[1] * S) - 2),
                Math.min(W, Math.ceil(cap[2] * S + 0.8 * lh)), Math.min(H, Math.ceil(cap[3] * S) + 2)];
    // the marks in the caption, left to right; pieces stacked over each other are one mark
    const seen = new Uint8Array((bx[2] - bx[0]) * (bx[3] - bx[1])), marks = [];
    const at = (x, y) => (y - bx[1]) * (bx[2] - bx[0]) + (x - bx[0]);
    for (let y = bx[1]; y < bx[3]; y++) for (let x = bx[0]; x < bx[2]; x++) {
      if (!ink[y * W + x] || seen[at(x, y)]) continue;
      const m = [x, y, x, y], q = [[x, y]]; seen[at(x, y)] = 1;
      while (q.length) {
        const [a, b] = q.pop();
        if (a < m[0]) m[0] = a; if (a > m[2]) m[2] = a; if (b < m[1]) m[1] = b; if (b > m[3]) m[3] = b;
        for (const [u, w] of [[a - 1, b], [a + 1, b], [a, b - 1], [a, b + 1]])
          if (u >= bx[0] && u < bx[2] && w >= bx[1] && w < bx[3] && ink[w * W + u] && !seen[at(u, w)]) { seen[at(u, w)] = 1; q.push([u, w]); }
      }
      marks.push(m);
    }
    marks.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < marks.length; i++) {
      const a = marks[i - 1], b = marks[i], ov = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      if (ov > 0.5 * Math.min(a[2] - a[0], b[2] - b[0])) { marks[i - 1] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; marks.splice(i--, 1); }
    }
    const big = marks.filter(m => m[3] - m[1] + 1 >= 0.45 * lh);       // drops the period and specks
    if (big.length < 4) return null;
    const T = glyphTemplates();
    const capH = big[0][3] - big[0][1] + 1;                   // the F
    const read = (m, allowed) => {
      const w = m[2] - m[0] + 1, h = m[3] - m[1] + 1, ar = w / h, hr = h / capH;
      const v = glyphVec((x, y) => ink[y * W + x], m[0], m[1], w, h);
      const by = {};                                       // closest template per character
      for (const t of T) {
        if (!allowed.includes(t.ch)) continue;
        let d = 0; for (let i = 0; i < v.length; i++) d += Math.abs(v[i] - t.v[i]);
        d = d / v.length + 0.4 * Math.abs(Math.log(ar / t.ar)) + 0.6 * Math.abs(Math.log(hr / t.hr));
        if (!(t.ch in by) || d < by[t.ch]) by[t.ch] = d;
      }
      const r = Object.entries(by).sort((a, b) => a[1] - b[1]);
      const best = { ch: r[0][0], d: r[0][1], d2: r[1] ? r[1][1] : 9 };
      return best;
    };
    // "FIG" first (an italic serif F reads much like an E), then digits and a letter
    const fig = big.slice(0, 3).map(m => read(m, 'FIGABCDEH'));
    if (!/^[FE]IG$/.test(fig.map(r => r.ch).join('')) || fig.some(r => r.d > 0.3)) return null;
    let num = '';
    for (const [i, m] of big.slice(3).entries()) {
      const r = read(m, i ? '0123456789abcdefghABCDEFGH' : '0123456789');
      if (r.d > 0.3 || r.d2 - r.d < 0.03) return null;
      num += r.ch;
    }
    return /^\d+[a-hA-H]?$/.test(num) ? num : null;
  }

  function buildSheets() {
    sheets = [];
    if (st.opts.layout === 'keep') {
      doc.pages.forEach((p, i) => {
        const figs = st.figures.filter(f => f.page === i);
        sheets.push({ w: p.w, h: p.h, page: i, figs: figs.map(f => ({ fig: f.id, page: i, sc: 1, ox: f.box[0], oy: f.box[1], clip: f.box.slice() })) });
      });
    } else {
      const [PW, PH] = PAPER[st.opts.paper];
      const top = st.opts.sheetnums ? PAD.t + 14 : PAD.t;
      for (const f of st.figures) {
        const clip = f.box, cw = clip[2] - clip[0], ch = clip[3] - clip[1];
        const bx = [MARGIN.l + PAD.l, MARGIN.t + top, PW - MARGIN.r - PAD.r, PH - MARGIN.b - PAD.b];
        const sc = Math.min((bx[2] - bx[0]) / cw, (bx[3] - bx[1]) / ch, MAXSC);
        const ox = bx[0] + ((bx[2] - bx[0]) - cw * sc) / 2, oy = bx[1] + ((bx[3] - bx[1]) - ch * sc) / 2;
        sheets.push({ w: PW, h: PH, page: null, figs: [{ fig: f.id, page: f.page, sc, ox, oy, clip: clip.slice() }] });
      }
    }
    sheets.forEach((sh, i) => { sh.idx = i; });
  }

  // White-outs live on a source page; this is where they land on a sheet (sheet pt).
  const normRect = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  function whiteRectFor(n, sh) {
    const r = normRect(n.a, n.b);
    if (sh.page != null) return n.page === sh.page ? r : null;
    for (const g of sh.figs) if (g.page === n.page) {
      const c = [Math.max(r[0], g.clip[0]), Math.max(r[1], g.clip[1]), Math.min(r[2], g.clip[2]), Math.min(r[3], g.clip[3])];
      if (c[2] > c[0] && c[3] > c[1]) return T(g, [c[0], c[1]]).concat(T(g, [c[2], c[3]]));
    }
    return null;
  }
  const whiteRects = sh => st.notes.filter(n => n.kind === 'white').map(n => whiteRectFor(n, sh)).filter(Boolean);

  // Draws a sheet's drawing (no labels) at `scale` px per pt, white-outs applied.
  async function paintSheet(sh, scale) {
    const c = document.createElement('canvas');
    c.width = Math.round(sh.w * scale); c.height = Math.round(sh.h * scale);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    if (sh.page != null) {
      const p = doc.pages[sh.page];
      if (scale === S) ctx.drawImage(p.canvas, 0, 0);
      else if (p.pj) await p.pj.render({ canvasContext: ctx, viewport: p.pj.getViewport({ scale }), intent: 'print' }).promise;
      else ctx.drawImage(p.img, 0, 0, c.width, c.height);
    } else for (const g of sh.figs) {
      const p = doc.pages[g.page], cw = g.clip[2] - g.clip[0], ch = g.clip[3] - g.clip[1];
      if (p.pj) {
        // pdf.js ignores a clip on the target canvas, so render the piece on its own canvas
        const t = document.createElement('canvas');
        t.width = Math.max(1, Math.round(cw * g.sc * scale)); t.height = Math.max(1, Math.round(ch * g.sc * scale));
        const vp = p.pj.getViewport({ scale: scale * g.sc, offsetX: -g.clip[0] * g.sc * scale, offsetY: -g.clip[1] * g.sc * scale });
        await p.pj.render({ canvasContext: t.getContext('2d'), viewport: vp, intent: 'print' }).promise;
        ctx.drawImage(t, Math.round(g.ox * scale), Math.round(g.oy * scale));
      } else {
        const k = p.img.naturalWidth / p.w;
        ctx.drawImage(p.img, g.clip[0] * k, g.clip[1] * k, cw * k, ch * k, g.ox * scale, g.oy * scale, cw * g.sc * scale, ch * g.sc * scale);
      }
    }
    ctx.fillStyle = '#fff';
    for (const r of whiteRects(sh)) ctx.fillRect(r[0] * scale, r[1] * scale, (r[2] - r[0]) * scale, (r[3] - r[1]) * scale);
    return c;
  }

  async function renderSheet(sh) {
    sh.canvas = await paintSheet(sh, S);
    const W = sh.canvas.width, H = sh.canvas.height;
    sh.ink = E.inkFromRGBA(sh.canvas.getContext('2d').getImageData(0, 0, W, H).data, W, H);
    sh.eng = null;
    sh.figInk = {};
    for (const g of sh.figs) {
      const r = sheetRect(g);
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (let y = Math.max(0, Math.floor(r[1] * S)); y < Math.min(H, r[3] * S); y++)
        for (let x = Math.max(0, Math.floor(r[0] * S)); x < Math.min(W, r[2] * S); x++)
          if (sh.ink[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      sh.figInk[g.fig] = x1 > x0 ? [x0, y0, x1, y1] : r.map(v => v * S);
    }
  }
  async function renderSheets() { for (const sh of sheets) await renderSheet(sh); }
  async function refreshPage(page) {      // after a white-out changes
    for (const sh of sheets) if (sh.page === page || sh.figs.some(g => g.page === page)) {
      await renderSheet(sh);
      for (const l of labelsOn(sh)) recross(l, sh);
      if (st.opts.figlabels) placeFigLabels(sh, true);
    }
    renderLists(); drawAll();
  }
  const sheetRect = g => [g.ox, g.oy, g.ox + (g.clip[2] - g.clip[0]) * g.sc, g.oy + (g.clip[3] - g.clip[1]) * g.sc];
  function engineFor(sh) {
    if (!sh.eng) {
      const sight = [MARGIN.l * S, MARGIN.t * S, (sh.w - MARGIN.r) * S, (sh.h - MARGIN.b) * S];
      sh.eng = new E.Sheet(sh.ink, sh.canvas.width, sh.canvas.height, S, sight);
    }
    return sh.eng;
  }
  function sheetOfFig(figId) { return sheets.find(sh => sh.figs.some(g => g.fig === figId)); }
  function placementOf(figId) { const sh = sheetOfFig(figId); return sh && sh.figs.find(g => g.fig === figId); }
  const T = (g, p) => [g.ox + g.sc * (p[0] - g.clip[0]), g.oy + g.sc * (p[1] - g.clip[1])];
  const Ti = (g, p) => [g.clip[0] + (p[0] - g.ox) / g.sc, g.clip[1] + (p[1] - g.oy) / g.sc];
  const labelsOn = sh => st.labels.filter(l => sh.figs.some(g => g.fig === l.fig));
  const notesOn = sh => st.notes.filter(n => n.kind === 'white' ? whiteRectFor(n, sh) : sh.figs.some(g => g.fig === n.fig));
  function figAt(sh, q) {
    return sh.figs.find(x => inBox(q, sheetRect(x), 0)) ||
           sh.figs.slice().sort((a, b) => dist(q, sheetRect(a)) - dist(q, sheetRect(b)))[0];
  }

  // Where a note sits on a sheet: text gets a box, lines get two ends (sheet pt).
  function noteGeom(n, sh) {
    if (n.kind === 'white') { const r = whiteRectFor(n, sh); return r && { box: r }; }
    const g = sh.figs.find(x => x.fig === n.fig); if (!g) return null;
    if (n.kind === 'text') {
      const a = T(g, n.a), sz = n.size || NOTE_FS, [w] = measure(n.text || ' ', !!n.bold, sz);
      return { a, box: [a[0], a[1] - 0.74 * sz, a[0] + w, a[1] + 0.22 * sz] };
    }
    const a = T(g, n.a), b = T(g, n.b);
    return { a, b, box: normRect(a, b) };
  }
  const noteScale = (n, sh) => n.kind === 'white'
    ? (sh.page != null ? 1 : (sh.figs.find(g => g.page === n.page) || { sc: 1 }).sc)
    : (placementOf(n.fig) || { sc: 1 }).sc;

  async function rebuild(resetPositions) {
    if (!doc) return;
    if (resetPositions) {
      for (const l of st.labels) { l.pos = null; l.pinned = false; }
      st.figLabels = {};
    }
    buildSheets();
    await renderSheets();
    renderLists(); buildSurfaces();
  }

  // ---------------------------------------------------------------- leaders
  // A leader is a straight line from the tip to the numeral, or a quadratic curve when
  // it has a control point. Arrow leaders get a filled head at the tip; "none" means an
  // underlined numeral that sits on the surface it names (37 CFR 1.84(q)).
  function leaderPts(pos) {
    if (!pos.ctrl) return [pos.tip, pos.end];
    const out = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20, u = 1 - t;
      out.push([u * u * pos.tip[0] + 2 * u * t * pos.ctrl[0] + t * t * pos.end[0], u * u * pos.tip[1] + 2 * u * t * pos.ctrl[1] + t * t * pos.end[1]]);
    }
    return out;
  }
  const leaderMid = pos => pos.ctrl
    ? [0.25 * pos.tip[0] + 0.5 * pos.ctrl[0] + 0.25 * pos.end[0], 0.25 * pos.tip[1] + 0.5 * pos.ctrl[1] + 0.25 * pos.end[1]]
    : [(pos.tip[0] + pos.end[0]) / 2, (pos.tip[1] + pos.end[1]) / 2];
  function fixEnd(pos) { pos.end = E.edgePoint(pos.ctrl || pos.tip, pos.box, 1.8); }
  function arrowHead(tip, from) {
    const dx = tip[0] - from[0], dy = tip[1] - from[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const b = [tip[0] - ux * ARROW_L, tip[1] - uy * ARROW_L];
    return [tip, [b[0] - uy * ARROW_W, b[1] + ux * ARROW_W], [b[0] + uy * ARROW_W, b[1] - ux * ARROW_W]];
  }
  function recross(l, sh) {
    if (!l.pos) return;
    sh = sh || sheetOfFig(l.fig); if (!sh) return;
    l.pos.cross = l.style === 'none' ? 0 : engineFor(sh).crossingsPath(leaderPts(l.pos).map(px))[0];
  }
  function underlinedPos(l, sh) {      // a numeral without a leader, centred on its spot
    const g = sh.figs.find(x => x.fig === l.fig), t = T(g, l.tip), [w, h] = measure(labelText(l), false, st.opts.fs);
    const box = [t[0] - w / 2, t[1] - h / 2, t[0] + w / 2, t[1] + h / 2];
    return { box, tip: t, end: t, cross: 0 };
  }
  function setStyle(l, style) {
    const sh = sheetOfFig(l.fig); if (!sh) return;
    const was = l.style; l.style = style;
    if (style === 'none') { l.pos = underlinedPos(l, sh); l.pinned = true; }
    else if (was === 'none') { l.pinned = false; placeOne(l); }
    recross(l, sh);
  }

  // ---------------------------------------------------------------- placement
  function sheetNumBox(sh) {
    if (!st.opts.sheetnums) return null;
    const t = (sh.idx + 1) + '/' + sheets.length, [w, h] = measure(t, false, SHEETNUM_FS);
    const y = MARGIN.t + 6;
    return { text: t, box: [sh.w / 2 - w / 2, y, sh.w / 2 + w / 2, y + h] };
  }
  function itemFor(l, sh) {
    const g = sh.figs.find(x => x.fig === l.fig), fi = sh.figInk[l.fig];
    return {
      key: l.id, text: labelText(l),
      tips: [l.tip].concat(l.alts || []).map(p => T(g, p).map(v => v * S)),
      center: fi ? [(fi[0] + fi[2]) / 2, (fi[1] + fi[3]) / 2] : null,
    };
  }
  const px = b => b.map(v => v * S), pt = b => b.map(v => v / S);
  function obstaclesFor(sh, skip, withFigLabels) {
    const boxes = [], segs = [];
    for (const l of labelsOn(sh)) if (l.pos && !skip(l)) {
      boxes.push(px(l.pos.box));
      if (l.style !== 'none') { const p = leaderPts(l.pos); for (let i = 1; i < p.length; i++) segs.push([px(p[i - 1]), px(p[i])]); }
    }
    for (const n of notesOn(sh)) {
      const gm = noteGeom(n, sh); if (!gm || n.kind === 'white') continue;
      if (n.kind === 'text') boxes.push(px(gm.box)); else segs.push([px(gm.a), px(gm.b)]);
    }
    if (withFigLabels) for (const g of sh.figs) { const fl = st.figLabels[g.fig]; if (fl && fl.box && st.opts.figlabels) boxes.push(px(fl.box)); }
    const sn = sheetNumBox(sh); if (sn) boxes.push(px(sn.box));
    return { boxes, segs };
  }
  function applyResult(l, r) {
    l.pos = r ? { box: pt(r.box), tip: pt(r.tip), end: pt(r.end), cross: r.crossings } : null;
    if (r && r.ctrl) l.pos.ctrl = pt(r.ctrl);
  }

  function placeOne(l) {
    const sh = sheetOfFig(l.fig); if (!sh) return;
    if (l.style === 'none') { l.pos = underlinedPos(l, sh); return; }
    const eng = engineFor(sh);
    const res = eng.place([itemFor(l, sh)], measurePx, obstaclesFor(sh, o => o === l, true), { straight: !st.opts.curves });
    applyResult(l, res[l.id]);
  }

  async function placeAll(only) {
    if (!doc) return;
    snapshot();
    status('Placing…');
    await new Promise(r => setTimeout(r, 20));
    if (only) for (const l of only) l.pinned = false;
    for (const sh of sheets) {
      const eng = engineFor(sh);
      const mine = labelsOn(sh);
      for (const l of mine) if (l.style === 'none' && !l.pos) l.pos = underlinedPos(l, sh);
      const pinnedFL = sh.figs.filter(g => (st.figLabels[g.fig] || {}).pinned);
      const movable = l => !l.pinned && l.style !== 'none' && (!only || only.includes(l));
      const obst = obstaclesFor(sh, movable, false);
      for (const g of pinnedFL) obst.boxes.push(px(st.figLabels[g.fig].box));
      const todo = mine.filter(movable);
      if (only && !todo.length) continue;
      const res = eng.place(todo.map(l => itemFor(l, sh)), measurePx, obst, { straight: !st.opts.curves });
      for (const l of todo) applyResult(l, res[l.id]);
      if (st.opts.figlabels && !only) placeFigLabels(sh, false);
      await new Promise(r => setTimeout(r, 0));
    }
    status('');
    renderLists(); drawAll();
  }
  // "FIG. n" under each figure that has no caption of its own. missingOnly: keep the
  // labels already there.
  function placeFigLabels(sh, missingOnly) {
    const eng = engineFor(sh);
    const done = labelsOn(sh).filter(l => l.pos).map(l => ({ box: px(l.pos.box), tip: px(l.pos.tip), end: px(l.pos.end) }));
    const sn = sheetNumBox(sh); if (sn) done.push({ box: px(sn.box), tip: [0, 0], end: [0, 0] });
    for (const n of notesOn(sh)) { const gm = noteGeom(n, sh); if (gm && n.kind === 'text') done.push({ box: px(gm.box), tip: [0, 0], end: [0, 0] }); }
    for (const g of sh.figs) {
      const f = figById(g.fig), cur = st.figLabels[g.fig];
      if (figCaption(f)) { delete st.figLabels[g.fig]; continue; }
      if (cur && (cur.pinned || missingOnly)) { done.push({ box: px(cur.box), tip: [0, 0], end: [0, 0] }); continue; }
      const wh = measure(figLabelText(f), true, st.opts.figfs).map(v => v * S);
      const box = eng.placeFigLabel(sh.figInk[g.fig], wh, done, sh.figs.filter(o => o !== g).map(o => sh.figInk[o.fig]));
      st.figLabels[g.fig] = { box: pt(box), pinned: false };
      done.push({ box, tip: [0, 0], end: [0, 0] });
    }
  }
  function report() {
    const placed = st.labels.filter(l => l.pos).length, missing = st.labels.length - placed;
    const crossing = st.labels.filter(l => l.pos && l.pos.cross).length;
    $('report').innerHTML = st.labels.length ? `<span class="pill ok">${placed} placed</span> ` +
      (crossing ? `<span class="pill warn">${crossing} cross a line</span> ` : '') +
      (missing ? `<span class="pill bad">${missing} without room</span>` : '') : '';
  }

  // ---------------------------------------------------------------- lists
  function renderLists() {
    const fl = $('figlist');
    fl.innerHTML = st.figures.map(f => `<tr data-id="${f.id}" class="${isSel('fig', f.id) ? 'active' : ''}">
      <td style="width:44px;color:var(--muted)">FIG.</td><td class="num"><input value="${esc(f.num)}" data-k="num"></td>
      <td style="color:var(--muted);font-size:12px">sheet ${f.page + 1}${figCaption(f) ? ' <span style="white-space:nowrap" title="The drawing already has this caption, so no FIG. label is added. White it out to get a new one.">· caption</span>' : ''}</td>
      <td class="x"><button class="x" data-a="up" title="Move up">↑</button></td>
      <td class="x"><button class="x" data-a="dn" title="Move down">↓</button></td>
      <td class="x"><button class="x" data-a="del" title="Remove">×</button></td></tr>`).join('');
    const counts = {};
    for (const l of st.labels) counts[l.part] = (counts[l.part] || 0) + 1;
    $('partlist').innerHTML = st.parts.map(p => `<tr data-id="${p.id}" class="${activePart === p.id ? 'active' : ''}">
      <td class="num"><input value="${esc(p.n)}" data-k="n"></td><td><input value="${esc(p.name)}" data-k="name"></td>
      <td class="cnt" title="labels placed">${counts[p.id] || ''}</td><td class="x"><button class="x" data-a="del" title="Remove">×</button></td></tr>`).join('');
    const ap = partById(activePart);
    $('activepart').innerHTML = mode !== 'labels' ? '' : ap
      ? `Click the drawing to label <b>${esc(ap.n)} ${esc(ap.name)}</b> <button class="btn alt sm" id="nextpart" title="Tab">Next part ›</button>`
      : (st.parts.length ? 'Pick a part in the list, then click it on the drawing' : '');
    const np = $('nextpart'); if (np) np.onclick = nextPart;
    report(); renderProps(); renderChecks();
    for (const s of surfaces) s.box.className = 'sheetbox tool-' + tool;
  }
  function nextPart() {
    if (!st.parts.length) return;
    const i = st.parts.findIndex(p => p.id === activePart);
    activePart = st.parts[(i + 1) % st.parts.length].id;
    renderLists(); drawAll();
  }

  // The panel for whatever is selected.
  function renderProps() {
    const el = $('props');
    const n = selection.length, l = selLabel(), note = selNote(), fl = only('figlabel');
    let h = '', removable = n === 1;
    if (!n) h = '<span class="hint" style="margin:0">Click a numeral, leader, text or line to change it. Use the tools above the drawing to add text, lines, arrows or white-out.</span>';
    else if (l) {
      const opts = st.parts.map(p => `<option value="${p.id}"${p.id === l.part ? ' selected' : ''}>${esc(p.n)} ${esc(p.name)}</option>`).join('');
      h = `<div class="ttl">Numeral ${esc(labelText(l))}</div>
        <div class="row"><label>Text <input type="text" data-p="ltext" value="${esc(labelText(l))}" style="width:70px"></label>
          <label>Part <select data-p="lpart" style="max-width:150px">${opts}</select></label></div>
        <div class="row"><span>Leader</span><div class="seg sm" data-p="lstyle">
          <button data-v="line" class="${l.style === 'line' ? 'on' : ''}">Line</button><button data-v="arrow" class="${l.style === 'arrow' ? 'on' : ''}">Arrow</button><button data-v="none" class="${l.style === 'none' ? 'on' : ''}" title="No leader: the numeral is underlined and sits on the surface it names">Underlined</button></div></div>
        <div class="row">${l.pos && l.pos.ctrl ? '<button class="btn alt sm" data-p="straight">Straighten</button>' : '<span class="hint" style="margin:0">Drag the leader to curve it.</span>'}
          <label class="ck"><input type="checkbox" data-p="lpin"${l.pinned ? ' checked' : ''}> Keep here</label>
          <button class="btn alt sm" data-p="replace" title="Let the labeler choose a spot for this numeral again">Place again</button></div>`;
    } else if (note && note.kind === 'text') {
      h = `<div class="ttl">Text</div>
        <div class="row"><input type="text" data-p="ntext" value="${esc(note.text)}" style="flex:1"></div>
        <div class="row"><label>Size <input type="number" data-p="nsize" min="6" max="48" value="${note.size || NOTE_FS}" style="width:58px"> pt</label>
          <label class="ck"><input type="checkbox" data-p="nbold"${note.bold ? ' checked' : ''}> Bold</label></div>`;
    } else if (note && (note.kind === 'line' || note.kind === 'arrow')) {
      h = `<div class="ttl">${note.kind === 'arrow' ? 'Arrow' : 'Line'}</div>
        <div class="row"><label class="ck"><input type="checkbox" data-p="narrow"${note.kind === 'arrow' ? ' checked' : ''}> Arrowhead</label>
        <button class="btn alt sm" data-p="nflip" title="Put the arrowhead on the other end">Reverse</button></div>
        <span class="hint" style="margin:0">Drag an end to move it.</span>`;
    } else if (note && note.kind === 'white') {
      h = '<div class="ttl">White-out</div><span class="hint" style="margin:0">Hides that part of the drawing in the labeled PDF and PowerPoint (handy for old numerals or stray marks). Drag a corner to resize.</span>';
    } else if (fl != null) {
      const f = figById(fl);
      h = `<div class="ttl">FIG. label</div><div class="row"><label>FIG. <input type="text" data-p="fnum" value="${esc(f ? f.num : '')}" style="width:60px"></label></div>`;
    } else {
      removable = false;
      const labels = selection.filter(s => s.kind === 'label').length;
      h = `<div class="ttl">${n} selected</div><div class="row">${labels ? '<button class="btn alt sm" data-p="replace">Place again</button>' : ''}<button class="btn alt sm" data-p="del">Remove</button></div>`;
    }
    if (removable) h += '<div class="row" style="margin-bottom:0"><button class="btn alt sm" data-p="del">Remove</button></div>';
    el.innerHTML = h;
  }
  $('props').addEventListener('change', e => {
    const k = e.target.dataset.p, v = e.target.value; if (!k) return;
    const l = selLabel(), note = selNote();
    snapshot();
    if (l && k === 'ltext') setLabelText(l, v.trim());
    else if (l && k === 'lpart') { l.part = +v; l.text = null; resizeLabel(l); activePart = l.part; }
    else if (l && k === 'lpin') l.pinned = e.target.checked;
    else if (note && k === 'ntext') { note.text = v; if (!v.trim()) st.notes = st.notes.filter(n => n !== note); }
    else if (note && k === 'nsize') note.size = clamp(+v || NOTE_FS, 6, 48);
    else if (note && k === 'nbold') note.bold = e.target.checked;
    else if (note && k === 'narrow') note.kind = e.target.checked ? 'arrow' : 'line';
    else if (k === 'fnum') { const f = figById(only('figlabel')); if (f) f.num = v.trim(); }
    renderLists(); drawAll();
  });
  $('props').addEventListener('click', async e => {
    const b = e.target.closest('[data-p],[data-v]'); if (!b) return;
    const l = selLabel(), note = selNote();
    if (b.dataset.v && l) { snapshot(); setStyle(l, b.dataset.v); }
    else if (b.dataset.p === 'straight' && l) { snapshot(); delete l.pos.ctrl; fixEnd(l.pos); recross(l); }
    else if (b.dataset.p === 'replace') { await placeAll(st.labels.filter(x => isSel('label', x.id))); return; }
    else if (b.dataset.p === 'nflip' && note) { snapshot(); [note.a, note.b] = [note.b, note.a]; }
    else if (b.dataset.p === 'del') { await removeSelected(); return; }
    else return;
    renderLists(); drawAll();
  });
  function setLabelText(l, v) {
    const own = partById(l.part), other = st.parts.find(p => p.n === v && p !== own);
    if (other) { l.part = other.id; l.text = null; activePart = other.id; }      // typed another part's numeral
    else l.text = !v || (own && v === own.n) ? null : v;
    resizeLabel(l);
  }
  function resizeLabel(l) {
    if (!l.pos) return;
    const [w, h] = measure(labelText(l), false, st.opts.fs), b = l.pos.box;
    if (l.style === 'none') { const cx = (b[0] + b[2]) / 2; l.pos.box = [cx - w / 2, b[3] - h, cx + w / 2, b[3]]; }
    else l.pos.box = [b[0], b[3] - h, b[0] + w, b[3]];
    if (l.style !== 'none') fixEnd(l.pos);
    recross(l);
  }

  // Things worth a second look before filing.
  let issueTargets = [];
  function renderChecks() {
    const items = [];
    const fnum = id => (figById(id) || {}).num;
    const sortL = st.labels.slice().sort((a, b) => st.figures.indexOf(figById(a.fig)) - st.figures.indexOf(figById(b.fig)) || cmpNum(labelText(a), labelText(b)));
    for (const l of sortL) if (!l.pos) items.push({ cls: 'bad', text: `${labelText(l)} in FIG. ${fnum(l.fig)} found no room: drag it into place`, label: l });
    const inSight = (sh, b) => sh && b[0] >= MARGIN.l - 0.5 && b[1] >= MARGIN.t - 0.5 && b[2] <= sh.w - MARGIN.r + 0.5 && b[3] <= sh.h - MARGIN.b + 0.5;
    for (const l of sortL) if (l.pos && !inSight(sheetOfFig(l.fig), l.pos.box)) items.push({ cls: 'bad', text: `${labelText(l)} in FIG. ${fnum(l.fig)} is in the margin (37 CFR 1.84(g))`, label: l });
    if (st.opts.figlabels) for (const f of st.figures) { const fl = st.figLabels[f.id]; if (fl && fl.box && !inSight(sheetOfFig(f.id), fl.box)) items.push({ cls: 'bad', text: `The FIG. ${f.num} label is in the margin (37 CFR 1.84(g))` }); }
    const touches = l => {             // the tip sits on a drawn line
      const sh = sheetOfFig(l.fig); if (!sh || !sh.ink || !l.pos) return true;
      const e = engineFor(sh), x = Math.round(l.pos.tip[0] * S), y = Math.round(l.pos.tip[1] * S);
      for (let yy = y - 3; yy <= y + 3; yy++) for (let xx = x - 3; xx <= x + 3; xx++)
        if (xx >= 0 && yy >= 0 && xx < e.W && yy < e.H && e.ink[yy * e.W + xx]) return true;
      return false;
    };
    for (const l of sortL) if (l.pos && l.style !== 'none' && !touches(l)) items.push({ cls: 'bad', text: `${labelText(l)} in FIG. ${fnum(l.fig)}: the leader does not touch a line of the drawing`, label: l });
    for (const l of sortL) if (l.pos && l.pos.cross) items.push({ cls: '', text: `${labelText(l)} in FIG. ${fnum(l.fig)}: the leader crosses ${l.pos.cross} line${l.pos.cross > 1 ? 's' : ''}`, label: l });
    // 37 CFR 1.84(p)(3): numbers and letters at least 0.32 cm (1/8 inch, 9 pt) high;
    // Liberation Sans digits stand 1409/2048 of the font size
    if (st.labels.length && st.opts.fs * 1409 / 2048 < 9) items.push({ cls: 'bad', text: `Numerals at ${st.opts.fs} pt are under 1/8 inch tall (37 CFR 1.84(p)(3)): use 13 pt or more` });
    if (st.notes.some(n => n.kind === 'text' && (n.size || NOTE_FS) * 1409 / 2048 < 9)) items.push({ cls: '', text: 'Some text is under 1/8 inch tall (37 CFR 1.84(p)(3))' });
    const seen = {};
    for (const p of st.parts) { if (seen[p.n]) items.push({ cls: 'bad', text: `Numeral ${p.n} is used for two parts (${seen[p.n]}, ${p.name})` }); seen[p.n] = p.name; }
    const fseen = {};
    for (const f of st.figures) { if (!f.num) items.push({ cls: 'bad', text: 'A figure has no number' }); else if (fseen[f.num]) items.push({ cls: 'bad', text: `Two figures are numbered FIG. ${f.num}` }); fseen[f.num] = 1; }
    if (st.labels.length) for (const p of st.parts) if (!st.labels.some(l => l.part === p.id)) items.push({ cls: 'info', text: `${p.n} ${p.name} is not shown in any figure`, part: p });
    const rank = { bad: 0, '': 1, info: 2 };
    items.sort((a, b) => rank[a.cls] - rank[b.cls]);         // stable: problems first
    issueTargets = items;
    $('issues').innerHTML = items.length ? items.slice(0, 200).map((it, i) => `<li class="${it.cls}" data-i="${i}">${esc(it.text)}</li>`).join('')
      : (st.labels.length ? '<li class="info">Nothing to flag. Still look at every leader.</li>' : '');
  }
  $('issues').addEventListener('click', e => {
    const li = e.target.closest('li'); if (!li || li.dataset.i == null) return;
    const it = issueTargets[+li.dataset.i];
    if (it.label) showLabel(it.label);
    else if (it.part) { activePart = it.part.id; setMode('labels'); renderLists(); drawAll(); }
  });
  function orderedLabels() {
    return st.labels.slice().sort((a, b) => sheets.indexOf(sheetOfFig(a.fig)) - sheets.indexOf(sheetOfFig(b.fig)) ||
      st.figures.indexOf(figById(a.fig)) - st.figures.indexOf(figById(b.fig)) || cmpNum(labelText(a), labelText(b)));
  }
  function stepLabel(dir) {
    const ls = orderedLabels(); if (!ls.length) return;
    const cur = selLabel(), i = cur ? ls.indexOf(cur) : -1;
    showLabel(ls[(i + dir + ls.length) % ls.length]);
    const l = selLabel();
    status(`${ls.indexOf(l) + 1} of ${ls.length}: ${labelText(l)} ${(partById(l.part) || {}).name || ''} in FIG. ${(figById(l.fig) || {}).num}`);
  }
  function showLabel(l) {
    if (mode !== 'labels') setMode('labels');
    select('label', l.id); activePart = l.part; renderLists(); drawAll();
    const sh = sheetOfFig(l.fig), s = surfaces.find(x => x.ref === sh); if (!s) return;
    const g = sh.figs.find(x => x.fig === l.fig), b = l.pos ? l.pos.box : T(g, l.tip).concat(T(g, l.tip));
    if (zoomPt < 1.6) { zoomPt = 1.6; applyZoom(); }
    const v = $('view');
    v.scrollTo({ left: s.box.offsetLeft + (b[0] + b[2]) / 2 * zoomPt - v.clientWidth / 2,
                 top: s.box.offsetTop + (b[1] + b[3]) / 2 * zoomPt - v.clientHeight / 2, behavior: 'smooth' });
  }
  $('prevl').onclick = () => stepLabel(-1);
  $('nextl').onclick = () => stepLabel(1);

  $('figlist').addEventListener('click', async e => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const id = +tr.dataset.id, i = st.figures.findIndex(f => f.id === id), a = e.target.dataset.a;
    if (a === 'del') { snapshot(); removeFigure(id); await rebuild(false); return; }
    if (a === 'up' || a === 'dn') {
      const j = a === 'up' ? i - 1 : i + 1; if (j < 0 || j >= st.figures.length) return;
      snapshot();
      [st.figures[i], st.figures[j]] = [st.figures[j], st.figures[i]];
      const nums = st.figures.map(f => f.num);
      [st.figures[i].num, st.figures[j].num] = [nums[j], nums[i]];
      await rebuild(false); return;
    }
    if (e.target.tagName !== 'INPUT') { select('fig', id); renderLists(); drawAll(); }
  });
  $('figlist').addEventListener('change', e => {
    const tr = e.target.closest('tr'), f = figById(+tr.dataset.id);
    snapshot(); f.num = e.target.value.trim(); renderLists(); drawAll();
  });
  function removeFigure(id) {
    st.labels = st.labels.filter(l => l.fig !== id);
    st.notes = st.notes.filter(n => n.kind === 'white' || n.fig !== id);
    st.figures = st.figures.filter(f => f.id !== id); delete st.figLabels[id];
    selection = selection.filter(exists);
  }
  $('partlist').addEventListener('click', e => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const id = +tr.dataset.id;
    if (e.target.dataset.a === 'del') {
      const n = st.labels.filter(l => l.part === id).length;
      if (n && !confirm(`Remove this part and its ${n} label${n > 1 ? 's' : ''}?`)) return;
      snapshot();
      st.parts = st.parts.filter(p => p.id !== id); st.labels = st.labels.filter(l => l.part !== id);
      selection = selection.filter(exists);
      if (activePart === id) activePart = null;
      renderLists(); drawAll(); return;
    }
    activePart = activePart === id && e.target.tagName !== 'INPUT' ? null : id;
    if (mode !== 'labels') setMode('labels');
    if (tool !== 'select') setTool('select');
    renderLists(); drawAll();
    if (e.target.tagName === 'INPUT') { const k = e.target.dataset.k; const inp = $('partlist').querySelector(`tr[data-id="${id}"] input[data-k="${k}"]`); if (inp) inp.focus(); }
  });
  $('partlist').addEventListener('change', e => {
    const tr = e.target.closest('tr'), p = partById(+tr.dataset.id); snapshot();
    if (e.target.dataset.k === 'n') renameNumeral(p, e.target.value.trim()); else p.name = e.target.value.trim();
    for (const l of st.labels) if (l.part === p.id) resizeLabel(l);
    renderLists(); drawAll();
  });
  function renameNumeral(p, n) {
    const old = p.n; p.n = n;
    for (const l of st.labels) if (l.part === p.id && l.text) {
      const [b, s] = E.splitNumeral(l.text);
      if (b === E.splitNumeral(old)[0]) l.text = E.splitNumeral(n)[0] + s;
    }
  }
  function nextNumeral() {
    let m = 8;
    for (const p of st.parts) { const b = parseInt(p.n, 10); if (!isNaN(b) && b > m) m = b; }
    return String(m + (m % 2 ? 1 : 2));
  }
  function addParts(text) {
    let added = 0;
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/^\s*[-*•]\s*/, '').trim(); if (!line) continue;
      let n = null, name = line;
      let m = line.match(/^(\d+[A-Za-z']*)\s*[-–—.:)]?\s+(.+)$/);
      if (m) { n = m[1]; name = m[2]; }
      else if ((m = line.match(/^(.+?)\s*[-–—:,(]?\s*(\d+[A-Za-z']*)\)?$/))) { n = m[2]; name = m[1]; }
      if (st.parts.some(p => (n && p.n === n) || p.name.toLowerCase() === name.toLowerCase())) continue;
      st.parts.push({ id: nid(), n: n || nextNumeral(), name });
      added++;
    }
    return added;
  }
  $('addparts').onclick = () => {
    snapshot();
    const n = addParts($('partsin').value);
    if (n) { $('partsin').value = ''; activePart = st.parts[st.parts.length - n].id; select(null); }
    renderLists(); drawAll();
  };
  function renumberParts(order) {
    if (!st.parts.length) return;
    snapshot();
    order.forEach((p, i) => renameNumeral(p, String(10 + 2 * i)));
    st.parts = order;
    for (const l of st.labels) resizeLabel(l);
    renderLists(); drawAll();
  }
  $('renumber').onclick = () => renumberParts(st.parts.slice());
  // The way draftsmen number: by the figure a part first shows in, then clockwise round
  // that figure from its left side. Parts not shown yet keep their order at the end.
  $('renumberfig').onclick = () => {
    const key = new Map();
    st.figures.forEach((f, fi) => {
      const sh = sheetOfFig(f.id), fb = sh && sh.figInk[f.id]; if (!fb) return;
      const c = [(fb[0] + fb[2]) / 2 / S, (fb[1] + fb[3]) / 2 / S];
      for (const l of st.labels) if (l.fig === f.id && l.pos && !key.has(l.part)) {
        const m = [(l.pos.box[0] + l.pos.box[2]) / 2, (l.pos.box[1] + l.pos.box[3]) / 2];
        const a = (Math.atan2(m[0] - c[0], c[1] - m[1]) + 2 * Math.PI + 1.75) % (2 * Math.PI);   // 0 just below 9 o'clock
        key.set(l.part, fi * 10 + a);
      }
    });
    renumberParts(st.parts.slice().sort((p, q) => (key.has(p.id) ? key.get(p.id) : 1e9) - (key.has(q.id) ? key.get(q.id) : 1e9)));
  };

  // ---------------------------------------------------------------- surfaces & drawing
  function buildSurfaces() {
    const host = $('sheets'); host.innerHTML = ''; surfaces = [];
    $('empty').style.display = doc ? 'none' : '';
    if (!doc) return;
    const list = mode === 'figs' ? doc.pages.map((p, i) => ({ kind: 'page', ref: p, idx: i, w: p.w, h: p.h }))
                                 : sheets.map(sh => ({ kind: 'sheet', ref: sh, idx: sh.idx, w: sh.w, h: sh.h }));
    for (const s of list) {
      const box = document.createElement('div'); box.className = 'sheetbox tool-' + tool;
      const cap = document.createElement('div'); cap.className = 'cap';
      cap.textContent = s.kind === 'page' ? `Sheet ${s.idx + 1} as drawn` : `Sheet ${s.idx + 1} of ${sheets.length}`;
      const c = document.createElement('canvas');
      c.width = Math.round(s.w * S); c.height = Math.round(s.h * S);
      box.appendChild(cap); box.appendChild(c); host.appendChild(box);
      s.box = box; s.canvas = c; s.ctx = c.getContext('2d');
      bindPointer(s);
      surfaces.push(s);
    }
    applyZoom(); drawAll();
  }
  function applyZoom() {
    for (const s of surfaces) { s.box.style.width = (s.w * zoomPt) + 'px'; s.box.style.height = (s.h * zoomPt) + 'px'; }
    $('zval').textContent = Math.round(zoomPt / (96 / 72) * 100) + '%';
  }
  function fitWidth() {
    const vw = $('view').clientWidth - 40, maxW = Math.max(...surfaces.map(s => s.w), 1);
    zoomPt = clamp(vw / maxW, 0.3, 2.5); applyZoom();
  }
  function fitPage() {
    const v = $('view'), maxW = Math.max(...surfaces.map(s => s.w), 1), maxH = Math.max(...surfaces.map(s => s.h), 1);
    zoomPt = clamp(Math.min((v.clientWidth - 40) / maxW, (v.clientHeight - 50) / maxH), 0.3, 2.5); applyZoom();
  }
  function drawAll() { for (const s of surfaces) draw(s); scheduleSave(); }
  const accentColor = () => getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#9E1B32';

  function draw(s) {
    const ctx = s.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(s.ref.canvas, 0, 0);
    ctx.setTransform(S, 0, 0, S, 0, 0);
    const tol = 1 / zoomPt, accent = accentColor();
    // the sight area (37 CFR 1.84 margins)
    ctx.strokeStyle = 'rgba(158,27,50,.25)'; ctx.setLineDash([6 * tol, 4 * tol]); ctx.lineWidth = tol;
    ctx.strokeRect(MARGIN.l, MARGIN.t, s.w - MARGIN.l - MARGIN.r, s.h - MARGIN.t - MARGIN.b);
    ctx.setLineDash([]);
    if (s.kind === 'page') return drawFigBoxes(s, tol);
    const sh = s.ref, single = selection.length === 1;
    const hl = (b, strong) => { ctx.fillStyle = strong ? 'rgba(201,162,39,.38)' : 'rgba(201,162,39,.18)'; ctx.fillRect(b[0] - 2, b[1] - 2, b[2] - b[0] + 4, b[3] - b[1] + 4); };
    const dot = (p, filled, r) => { ctx.beginPath(); ctx.arc(p[0], p[1], (r || 3.6) * tol, 0, 7); if (filled) { ctx.fillStyle = accent; ctx.fill(); } else { ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = accent; ctx.lineWidth = 1.3 * tol; ctx.stroke(); } };
    // white-outs show as a faint outline here only
    for (const n of notesOn(sh)) if (n.kind === 'white') {
      const r = whiteRectFor(n, sh), on = isSel('note', n.id);
      ctx.strokeStyle = on ? accent : 'rgba(40,110,200,.45)'; ctx.lineWidth = (on ? 1.4 : 0.9) * tol; ctx.setLineDash([4 * tol, 3 * tol]);
      ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]); ctx.setLineDash([]);
      if (on && single) for (const c of corners(r)) dot(c, true, 3);
    }
    ctx.textBaseline = 'alphabetic';
    for (const l of labelsOn(sh)) {
      const on = isSel('label', l.id), act = l.part === activePart;
      const g = sh.figs.find(x => x.fig === l.fig);
      if (!l.pos) {
        const t = T(g, l.tip);
        ctx.strokeStyle = '#B0342B'; ctx.lineWidth = 1.5 * tol;
        ctx.beginPath(); ctx.moveTo(t[0] - 4 * tol, t[1] - 4 * tol); ctx.lineTo(t[0] + 4 * tol, t[1] + 4 * tol); ctx.moveTo(t[0] + 4 * tol, t[1] - 4 * tol); ctx.lineTo(t[0] - 4 * tol, t[1] + 4 * tol); ctx.stroke();
        ctx.fillStyle = '#B0342B'; ctx.font = canvasFont(st.opts.fs); ctx.fillText(labelText(l) + '?', t[0] + 6 * tol, t[1] - 6 * tol);
        if (on) dot(t, true);
        continue;
      }
      const P = l.pos;
      if (on || act) hl(P.box, on);
      ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineWidth = LINE_W;
      if (l.style !== 'none') {
        const p = leaderPts(P);
        ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]); for (const q of p.slice(1)) ctx.lineTo(q[0], q[1]); ctx.stroke();
        if (l.style === 'arrow') { const h = arrowHead(P.tip, P.ctrl || P.end); ctx.beginPath(); ctx.moveTo(h[0][0], h[0][1]); ctx.lineTo(h[1][0], h[1][1]); ctx.lineTo(h[2][0], h[2][1]); ctx.closePath(); ctx.fill(); }
      }
      ctx.font = canvasFont(st.opts.fs);
      ctx.fillText(labelText(l), P.box[0], P.box[3]);
      if (l.style === 'none') { ctx.beginPath(); ctx.moveTo(P.box[0], P.box[3] + 1.6); ctx.lineTo(P.box[2], P.box[3] + 1.6); ctx.stroke(); }
      if (P.cross) { ctx.fillStyle = '#E08A00'; ctx.beginPath(); ctx.arc(P.box[2] + 3, P.box[1], 2.2, 0, 7); ctx.fill(); }
      if (on && single && l.style !== 'none') {
        dot(P.tip, true);
        dot(leaderMid(P), false, 3);
        for (const a of l.alts || []) { const t = T(g, a); ctx.strokeStyle = accent; ctx.lineWidth = tol; ctx.beginPath(); ctx.arc(t[0], t[1], 3 * tol, 0, 7); ctx.stroke(); }
      }
    }
    if (st.opts.figlabels) for (const g of sh.figs) {
      const fl = st.figLabels[g.fig], f = figById(g.fig); if (!fl || !fl.box || !f) continue;
      if (isSel('figlabel', g.fig)) hl(fl.box, true);
      ctx.fillStyle = '#000'; ctx.font = canvasFont(st.opts.figfs, true);
      ctx.fillText(figLabelText(f), fl.box[0], fl.box[3]);
    }
    for (const n of notesOn(sh)) {
      if (n.kind === 'white') continue;
      const gm = noteGeom(n, sh), on = isSel('note', n.id);
      ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; ctx.lineWidth = LINE_W;
      if (n.kind === 'text') {
        if (on) hl(gm.box, true);
        ctx.fillStyle = '#000'; ctx.font = canvasFont(n.size || NOTE_FS, n.bold); ctx.fillText(n.text || '', gm.a[0], gm.a[1]);
        if (!n.text) { ctx.strokeStyle = accent; ctx.lineWidth = tol; ctx.strokeRect(gm.box[0], gm.box[1], 8, gm.box[3] - gm.box[1]); }
      } else {
        if (on) { ctx.strokeStyle = 'rgba(201,162,39,.55)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(gm.a[0], gm.a[1]); ctx.lineTo(gm.b[0], gm.b[1]); ctx.stroke(); ctx.strokeStyle = '#000'; ctx.lineWidth = LINE_W; }
        ctx.beginPath(); ctx.moveTo(gm.a[0], gm.a[1]); ctx.lineTo(gm.b[0], gm.b[1]); ctx.stroke();
        if (n.kind === 'arrow') { const h = arrowHead(gm.b, gm.a); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.moveTo(h[0][0], h[0][1]); ctx.lineTo(h[1][0], h[1][1]); ctx.lineTo(h[2][0], h[2][1]); ctx.closePath(); ctx.fill(); }
        if (on && single) { dot(gm.a, true, 3); dot(gm.b, true, 3); }
      }
    }
    const sn = sheetNumBox(sh);
    if (sn) { ctx.fillStyle = '#000'; ctx.font = canvasFont(SHEETNUM_FS); ctx.fillText(sn.text, sn.box[0], sn.box[3]); }
    if (s.marquee) {
      const r = normRect(s.marquee[0], s.marquee[1]);
      ctx.fillStyle = 'rgba(201,162,39,.12)'; ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
      ctx.strokeStyle = accent; ctx.lineWidth = tol; ctx.setLineDash([4 * tol, 3 * tol]); ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]); ctx.setLineDash([]);
    }
    if (s.preview) {
      const { kind, a, b } = s.preview;
      ctx.strokeStyle = kind === 'white' ? accent : '#000'; ctx.lineWidth = kind === 'white' ? tol : LINE_W;
      if (kind === 'white') { const r = normRect(a, b); ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]); ctx.setLineDash([4 * tol, 3 * tol]); ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]); ctx.setLineDash([]); }
      else { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); if (kind === 'arrow') { const h = arrowHead(b, a); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.moveTo(h[0][0], h[0][1]); ctx.lineTo(h[1][0], h[1][1]); ctx.lineTo(h[2][0], h[2][1]); ctx.closePath(); ctx.fill(); } }
    }
  }
  function drawFigBoxes(s, tol) {
    const ctx = s.ctx, accent = accentColor();
    for (const f of st.figures.filter(f => f.page === s.idx)) {
      const b = f.box, on = isSel('fig', f.id);
      ctx.strokeStyle = accent; ctx.lineWidth = (on ? 2.2 : 1.2) * tol;
      ctx.fillStyle = on ? 'rgba(201,162,39,.10)' : 'rgba(158,27,50,.04)';
      ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      const tag = 'FIG. ' + f.num;
      ctx.font = `600 ${12 * tol}px Lexend, Arial, sans-serif`;
      const w = ctx.measureText(tag).width + 10 * tol;
      ctx.fillStyle = accent; ctx.fillRect(b[0], b[1] - 17 * tol, w, 17 * tol);
      ctx.fillStyle = '#fff'; ctx.fillText(tag, b[0] + 5 * tol, b[1] - 5 * tol);
      if (on) { ctx.fillStyle = accent; for (const [x, y] of corners(b)) ctx.fillRect(x - 4 * tol, y - 4 * tol, 8 * tol, 8 * tol); }
    }
  }
  const corners = b => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];

  // ---------------------------------------------------------------- pointer
  function bindPointer(s) {
    const c = s.canvas;
    const at = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * s.w, (e.clientY - r.top) / r.height * s.h]; };
    let drag = null;
    c.addEventListener('pointerdown', e => {
      if (e.button !== 0 || spaceHeld) return;
      const p = at(e), tol = 7 / zoomPt;
      drag = s.kind === 'page' ? figDown(s, p, tol, e) : labelDown(s, p, tol, e);
      if (drag) { c.setPointerCapture(e.pointerId); drag.start = p; drag.moved = false; e.stopPropagation(); }
    });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = at(e), dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
      if (!drag.moved && Math.hypot(dx, dy) * zoomPt < 3) return;
      if (!drag.moved) { if (!drag.nosnap) snapshot(); drag.moved = true; }
      if (drag.move) drag.move(p, dx, dy);
      draw(s);
    });
    const up = async e => {
      if (!drag) return;
      const p = at(e), d = drag; drag = null;
      if (d.moved && d.end) await d.end(p); else if (!d.moved && d.click) await d.click(p);
      renderLists(); drawAll();
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', e => { if (s.kind === 'sheet') labelDblClick(s, at(e), 7 / zoomPt); });
  }
  const inBox = (p, b, pad) => p[0] >= b[0] - pad && p[0] <= b[2] + pad && p[1] >= b[1] - pad && p[1] <= b[3] + pad;
  const dist = (p, b) => Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[2]), Math.max(b[1] - p[1], 0, p[1] - b[3]));
  function distPoly(p, pts) {
    let m = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, 0, 1);
      m = Math.min(m, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
    }
    return m;
  }

  function figDown(s, p, tol) {
    const figs = st.figures.filter(f => f.page === s.idx);
    const cur = only('fig') != null && figs.find(f => f.id === only('fig'));
    if (cur) {
      const ci = corners(cur.box).findIndex(([x, y]) => Math.abs(x - p[0]) < tol * 1.3 && Math.abs(y - p[1]) < tol * 1.3);
      if (ci >= 0) {
        const b0 = cur.box.slice();
        return { move: q => { const b = b0.slice(); if (ci === 0 || ci === 3) b[0] = q[0]; else b[2] = q[0]; if (ci < 2) b[1] = q[1]; else b[3] = q[1];
                               cur.box = normRect([b[0], b[1]], [b[2], b[3]]); },
                 end: () => afterFigChange() };
      }
    }
    const hit = figs.slice().reverse().find(f => inBox(p, f.box, 0));
    if (hit) {
      select('fig', hit.id); renderLists(); drawAll();
      const b0 = hit.box.slice();
      return { move: (q, dx, dy) => { hit.box = [b0[0] + dx, b0[1] + dy, b0[2] + dx, b0[3] + dy]; }, end: () => afterFigChange() };
    }
    select(null); renderLists(); drawAll();
    let nf = null;
    return {
      move: (q) => {
        if (!nf) { nf = { id: nid(), page: s.idx, box: [p[0], p[1], p[0], p[1]], num: '' }; st.figures.push(nf); select('fig', nf.id); }
        nf.box = normRect(p, q);
      },
      end: () => {
        if (!nf) return;
        if (nf.box[2] - nf.box[0] < 20 || nf.box[3] - nf.box[1] < 20) { st.figures = st.figures.filter(f => f !== nf); select(null); return; }
        // a box drawn around several found figures (an exploded view) replaces them
        const inside = f => f !== nf && f.page === nf.page && overlap(f.box, nf.box) > 0.8 &&
          (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]) < (nf.box[2] - nf.box[0]) * (nf.box[3] - nf.box[1]);
        const gone = st.figures.filter(inside);
        if (gone.length) {
          for (const l of st.labels) if (gone.some(g => g.id === l.fig)) l.fig = nf.id;
          for (const n of st.notes) if (gone.some(g => g.id === n.fig)) n.fig = nf.id;
          st.figures = st.figures.filter(f => !inside(f));
          for (const g of gone) delete st.figLabels[g.id];
        }
        // keep FIG order: by sheet, then top-to-bottom
        st.figures.sort((a, b) => a.page - b.page || (a === nf || b === nf ? a.box[1] - b.box[1] : 0));
        renumberFigures();
        return afterFigChange();
      },
    };
  }
  async function afterFigChange() {
    // tips stay put on the source page; positions on an enlarged sheet no longer fit
    if (st.opts.layout === 'split') for (const l of st.labels) if (l.style !== 'none') { l.pos = null; l.pinned = false; }
    await rebuild(false);
    if (st.opts.layout === 'split') for (const l of st.labels) if (l.style === 'none') { const sh = sheetOfFig(l.fig); if (sh) l.pos = underlinedPos(l, sh); }
  }

  // What is under the pointer on a sheet, topmost first.
  function hitTest(sh, p, tol) {
    const ns = notesOn(sh);
    for (const n of ns.slice().reverse()) {
      if (n.kind === 'white') continue;
      const gm = noteGeom(n, sh);
      if (n.kind === 'text' ? inBox(p, gm.box, 3) : distPoly(p, [gm.a, gm.b]) < tol) return { kind: 'note', id: n.id };
    }
    if (st.opts.figlabels) for (const g of sh.figs) { const fl = st.figLabels[g.fig]; if (fl && fl.box && inBox(p, fl.box, 3)) return { kind: 'figlabel', id: g.fig }; }
    const mine = labelsOn(sh).filter(l => l.pos);
    const num = mine.slice().reverse().find(l => inBox(p, l.pos.box, 3));
    if (num) return { kind: 'label', id: num.id };
    const lead = mine.find(l => l.style !== 'none' && distPoly(p, leaderPts(l.pos)) < tol * 0.8);
    if (lead) return { kind: 'label', id: lead.id, leader: true };
    for (const n of ns.slice().reverse()) if (n.kind === 'white' && inBox(p, whiteRectFor(n, sh), 0)) return { kind: 'note', id: n.id };
    return null;
  }

  // Drag handles of the one selected item.
  function handleDown(s, p, tol) {
    const sh = s.ref, l = selLabel(), n = selNote();
    const near = q => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol * 1.2;
    if (l && l.pos && l.style !== 'none' && labelsOn(sh).includes(l)) {
      if (near(l.pos.tip)) return {
        move: q => { l.pos.tip = q; fixEnd(l.pos); },
        end: q => {
          const eng = engineFor(sh), sp = eng.snap(q[0] * S, q[1] * S, Math.round(10 * S));
          const tp = sp ? pt(sp) : q, g = sh.figs.find(x => x.fig === l.fig);
          l.tip = Ti(g, tp); l.alts = []; l.pos.tip = tp; fixEnd(l.pos); recross(l, sh);
        },
      };
      if (near(leaderMid(l.pos))) return bendDrag(l, sh);
    }
    if (n && (n.kind === 'line' || n.kind === 'arrow')) {
      const gm = noteGeom(n, sh), g = gm && sh.figs.find(x => x.fig === n.fig);
      if (gm) for (const k of ['a', 'b']) if (near(gm[k])) return { move: q => { n[k] = Ti(g, q); } };
    }
    if (n && n.kind === 'white') {
      const r = whiteRectFor(n, sh); if (!r) return null;
      const ci = corners(r).findIndex(near);
      if (ci >= 0) {
        const sc = noteScale(n, sh), a0 = n.a.slice(), b0 = n.b.slice(), nr = normRect(a0, b0);
        return {
          move: (q, dx, dy) => { const b = nr.slice(); if (ci === 0 || ci === 3) b[0] += dx / sc; else b[2] += dx / sc; if (ci < 2) b[1] += dy / sc; else b[3] += dy / sc; n.a = [b[0], b[1]]; n.b = [b[2], b[3]]; },
          end: () => refreshPage(n.page),
        };
      }
    }
    return null;
  }
  function bendDrag(l, sh) {
    return {
      move: q => { const P = l.pos; P.ctrl = [2 * q[0] - (P.tip[0] + P.end[0]) / 2, 2 * q[1] - (P.tip[1] + P.end[1]) / 2]; fixEnd(P); },
      end: () => {
        const P = l.pos, m = leaderMid(P), c = [(P.tip[0] + P.end[0]) / 2, (P.tip[1] + P.end[1]) / 2];
        if (Math.hypot(m[0] - c[0], m[1] - c[1]) < 1.5) delete P.ctrl;
        fixEnd(P); l.pinned = true; recross(l, sh);
      },
    };
  }

  // Moves everything selected by (dx, dy) sheet pt, from positions captured in `base`.
  function captureSelection() {
    const base = [];
    for (const s of selection) {
      if (s.kind === 'label') { const l = st.labels.find(x => x.id === s.id); if (l && l.pos) base.push({ l, box: l.pos.box.slice(), ctrl: l.pos.ctrl && l.pos.ctrl.slice(), tip: l.tip.slice(), ptip: l.pos.tip.slice() }); }
      else if (s.kind === 'note') { const n = st.notes.find(x => x.id === s.id); if (n) base.push({ n, a: n.a.slice(), b: n.b && n.b.slice(), sc: noteScale(n, sheetOfFig(n.fig) || sheets.find(sh => whiteRectFor(n, sh))) }); }
      else if (s.kind === 'figlabel') { const fl = st.figLabels[s.id]; if (fl) base.push({ fl, box: fl.box.slice() }); }
    }
    return base;
  }
  function moveBase(base, dx, dy) {
    const d = [dx, dy];
    for (const b of base) {
      if (b.l) {
        const P = b.l.pos;
        P.box = [b.box[0] + dx, b.box[1] + dy, b.box[2] + dx, b.box[3] + dy];
        if (b.ctrl) P.ctrl = [b.ctrl[0] + dx / 2, b.ctrl[1] + dy / 2];
        if (b.l.style === 'none') { const g = placementOf(b.l.fig); P.tip = P.end = add(b.ptip, d); b.l.tip = [b.tip[0] + dx / g.sc, b.tip[1] + dy / g.sc]; }
        else fixEnd(P);
      } else if (b.n) {
        b.n.a = [b.a[0] + dx / b.sc, b.a[1] + dy / b.sc];
        if (b.b) b.n.b = [b.b[0] + dx / b.sc, b.b[1] + dy / b.sc];
      } else if (b.fl) b.fl.box = [b.box[0] + dx, b.box[1] + dy, b.box[2] + dx, b.box[3] + dy];
    }
  }
  async function afterMove(base) {
    const pages = new Set();
    for (const b of base) {
      if (b.l) { b.l.pinned = true; recross(b.l); }
      else if (b.fl) b.fl.pinned = true;
      else if (b.n && b.n.kind === 'white') pages.add(b.n.page);
    }
    for (const p of pages) await refreshPage(p);
  }

  function labelDown(s, p, tol, e) {
    const sh = s.ref;
    if (tool === 'text') return { nosnap: true, click: q => addTextNote(s, q) };
    if (tool === 'line' || tool === 'arrow' || tool === 'white') {
      const kind = tool;
      return {
        nosnap: true,
        move: q => { s.preview = { kind, a: p, b: q }; },
        end: q => { s.preview = null; addDragNote(s, kind, p, q); if (kind !== 'white') setTool('select'); },   // white-out stays on: erasing takes several boxes
        click: () => status(kind === 'white' ? 'Drag a box over what should disappear.' : 'Drag from one end of the line to the other.'),
      };
    }
    if (!e.shiftKey && selection.length === 1) { const h = handleDown(s, p, tol); if (h) return h; }
    const hit = hitTest(sh, p, tol);
    if (hit) {
      if (e.shiftKey) { select(hit.kind, hit.id, true); renderLists(); drawAll(); return null; }
      if (!isSel(hit.kind, hit.id)) select(hit.kind, hit.id);
      if (hit.kind === 'label') activePart = st.labels.find(l => l.id === hit.id).part;
      renderLists(); drawAll();
      if (hit.leader && selection.length === 1) return bendDrag(st.labels.find(l => l.id === hit.id), sh);
      const base = captureSelection();
      return { move: (q, dx, dy) => moveBase(base, dx, dy), end: () => afterMove(base) };
    }
    // empty paper: a box selects, a click labels
    return {
      nosnap: true,
      move: q => { s.marquee = [p, q]; },
      end: q => {
        const r = normRect(p, q); s.marquee = null;
        if (!e.shiftKey) selection = [];
        for (const l of labelsOn(sh)) if (l.pos && boxesMeet(l.pos.box, r) && !isSel('label', l.id)) selection.push({ kind: 'label', id: l.id });
        for (const n of notesOn(sh)) { const gm = noteGeom(n, sh); if (gm && boxesMeet(gm.box, r) && !(n.kind === 'white' && !inBox(gm.box.slice(0, 2), r, 0)) && !isSel('note', n.id)) selection.push({ kind: 'note', id: n.id }); }
        for (const g of sh.figs) { const fl = st.figLabels[g.fig]; if (st.opts.figlabels && fl && fl.box && boxesMeet(fl.box, r) && !isSel('figlabel', g.fig)) selection.push({ kind: 'figlabel', id: g.fig }); }
      },
      click: q => {
        const selL = selLabel();
        if (e.shiftKey && selL && labelsOn(sh).includes(selL)) return addAlt(selL, sh, q);
        if (!activePart) { select(null); return; }
        addLabel(sh, q);
      },
    };
  }
  const boxesMeet = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

  function addAlt(l, sh, q) {        // another spot on the same part the leader may point to
    const g = sh.figs.find(x => x.fig === l.fig), sp = engineFor(sh).snap(q[0] * S, q[1] * S);
    if (!sp) { status('No line there to point at.', 'warn'); return; }
    snapshot();
    l.alts = (l.alts || []).concat([Ti(g, pt(sp))]);
    l.pinned = false; placeOne(l); status('Added another spot the leader may point to.');
  }
  async function addLabel(sh, q) {
    let gg = figAt(sh, q);
    if (!gg) {       // a sheet with no figure on it: treat the whole sheet as one
      if (st.opts.layout !== 'keep') return;
      snapshot();
      st.figures.push({ id: nid(), page: sh.page, box: [0, 0, sh.w, sh.h], num: String(st.figures.length + 1) });
      await rebuild(false); status('Added a figure for that sheet; click again.');
      return;
    }
    const sp = engineFor(sh).snap(q[0] * S, q[1] * S);
    if (!sp) { status('Click on a line of the part (nothing to point at there).', 'warn'); return; }
    snapshot();
    const l = { id: nid(), part: activePart, text: null, fig: gg.fig, tip: Ti(gg, pt(sp)), alts: [], pos: null, pinned: false, style: 'line' };
    st.labels.push(l); placeOne(l); select('label', l.id);
    status(l.pos ? '' : 'No clear room for that numeral: drag it somewhere, or remove it.', l.pos ? '' : 'warn');
  }
  function addTextNote(s, q) {
    const sh = s.ref, g = figAt(sh, q);
    if (!g) { status('Add a figure on this sheet first.', 'warn'); return; }
    snapshot();
    const n = { id: nid(), kind: 'text', fig: g.fig, a: Ti(g, [q[0], q[1] + NOTE_FS * 0.36]), text: '', size: NOTE_FS, bold: false };
    st.notes.push(n); select('note', n.id); setTool('select');
    drawAll(); inlineEdit(s, 'note', n.id);
  }
  async function addDragNote(s, kind, a, b) {
    const sh = s.ref;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 4) return;
    snapshot();
    if (kind === 'white') {
      const g = sh.page != null ? null : figAt(sh, a);
      const page = sh.page != null ? sh.page : g && g.page; if (page == null) return;
      const conv = q => g ? Ti(g, q) : q;
      const n = { id: nid(), kind: 'white', page, a: conv(a), b: conv(b) };
      st.notes.push(n); select('note', n.id);
      await refreshPage(page);
      return;
    }
    const g = figAt(sh, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    if (!g) { status('Add a figure on this sheet first.', 'warn'); return; }
    const n = { id: nid(), kind, fig: g.fig, a: Ti(g, a), b: Ti(g, b) };
    st.notes.push(n); select('note', n.id);
  }

  function labelDblClick(s, p, tol) {
    if (tool !== 'select') return;
    const sh = s.ref, hit = hitTest(sh, p, tol); if (!hit) return;
    if (hit.kind === 'label' && hit.leader) {
      const l = st.labels.find(x => x.id === hit.id);
      if (l.pos.ctrl) { snapshot(); delete l.pos.ctrl; fixEnd(l.pos); recross(l, sh); renderLists(); drawAll(); }
      return;
    }
    if (hit.kind === 'note' && st.notes.find(n => n.id === hit.id).kind !== 'text') return;
    select(hit.kind, hit.id); renderLists(); drawAll();
    inlineEdit(s, hit.kind, hit.id);
  }
  // Edits a numeral, a FIG. label or a text note right on the drawing.
  function inlineEdit(s, kind, id) {
    const sh = s.ref;
    let box, value, size, bold = false, commit, cancel = () => {};
    if (kind === 'label') {
      const l = st.labels.find(x => x.id === id); if (!l || !l.pos) return;
      box = l.pos.box; value = labelText(l); size = st.opts.fs;
      commit = v => { if (v === labelText(l)) return; snapshot(); setLabelText(l, v); };
    } else if (kind === 'figlabel') {
      const f = figById(id), fl = st.figLabels[id]; if (!f || !fl) return;
      box = fl.box; value = f.num; size = st.opts.figfs; bold = true;
      commit = v => { const n = v.replace(/^fig(ure)?s?\.?\s*/i, ''); if (n === f.num) return; snapshot(); f.num = n; };
    } else {
      const n = st.notes.find(x => x.id === id); if (!n) return;
      box = noteGeom(n, sh).box; value = n.text; size = n.size || NOTE_FS; bold = !!n.bold;
      const fresh = !n.text;
      commit = v => { if (!v) { st.notes = st.notes.filter(x => x !== n); selection = selection.filter(exists); } else if (v !== n.text) { if (!fresh) snapshot(); n.text = v; } };
      cancel = () => { if (fresh) { st.notes = st.notes.filter(x => x !== n); selection = selection.filter(exists); } };
    }
    const inp = document.createElement('input');
    inp.className = 'inline'; inp.value = value;
    Object.assign(inp.style, {
      left: (box[0] - 3) * zoomPt + 'px', top: (box[1] - size * 0.22) * zoomPt + 'px',
      fontSize: size * zoomPt + 'px', fontWeight: bold ? 'bold' : 'normal',
      width: Math.max(70, (box[2] - box[0] + size * 3) * zoomPt) + 'px',
    });
    s.box.appendChild(inp); inp.focus(); inp.select();
    let done = false;
    const finish = ok => { if (done) return; done = true; inp.remove(); if (ok) commit(inp.value.trim()); else cancel(); renderLists(); drawAll(); };
    inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('input', () => { inp.style.width = Math.max(70, (measure(inp.value, bold, size)[0] + size * 3) * zoomPt) + 'px'; });
  }

  async function removeSelected() {
    if (!selection.length) return;
    snapshot();
    const pages = new Set();
    for (const s of selection) {
      if (s.kind === 'label') st.labels = st.labels.filter(l => l.id !== s.id);
      else if (s.kind === 'note') { const n = st.notes.find(x => x.id === s.id); if (n && n.kind === 'white') pages.add(n.page); st.notes = st.notes.filter(x => x.id !== s.id); }
      else if (s.kind === 'figlabel') delete st.figLabels[s.id];
      else if (s.kind === 'fig') { removeFigure(s.id); selection = []; await rebuild(false); return; }
    }
    selection = [];
    for (const p of pages) await refreshPage(p);
    renderLists(); drawAll();
  }

  function setTool(t) {
    tool = t;
    for (const b of $('toolset').children) b.classList.toggle('on', b.dataset.t === t);
    if (t !== 'select' && mode !== 'labels') setMode('labels');
    for (const s of surfaces) s.box.className = 'sheetbox tool-' + t;
    const tips = { text: 'Click where the text goes.', line: 'Drag to draw a line.', arrow: 'Drag to draw an arrow; the head goes where you let go.', white: 'Drag boxes over what should disappear from the drawing; Esc when done.' };
    if (tips[t]) status(tips[t]);
  }
  $('toolset').onclick = e => { const b = e.target.closest('button'); if (b) setTool(b.dataset.t); };

  document.addEventListener('keydown', async e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || $('pastemodal').classList.contains('on') || $('claudemodal').classList.contains('on');
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) await redo(); else await undo(); return; }
    if (mod && k === 'y' && !typing) { e.preventDefault(); await redo(); return; }
    if (typing) return;
    if (e.key === ' ' && doc) { e.preventDefault(); if (!spaceHeld) { spaceHeld = true; $('view').classList.add('pan'); } return; }
    if (mod && k === 'a' && mode === 'labels') {
      e.preventDefault();
      selection = st.labels.filter(l => l.pos).map(l => ({ kind: 'label', id: l.id })).concat(st.notes.map(n => ({ kind: 'note', id: n.id })));
      renderLists(); drawAll(); return;
    }
    if (mod) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) { e.preventDefault(); await removeSelected(); return; }
    if (e.key === 'Escape') { selection = []; activePart = null; if (tool !== 'select') setTool('select'); renderLists(); drawAll(); return; }
    if (e.key.startsWith('Arrow') && selection.length && mode === 'labels') {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      snapshot(); const base = captureSelection(); moveBase(base, d[0], d[1]); await afterMove(base); renderLists(); drawAll(); return;
    }
    if (e.key === 'Tab' && doc && st.parts.length && mode === 'labels') { e.preventDefault(); nextPart(); return; }
    const tools = { v: 'select', t: 'text', l: 'line', a: 'arrow', w: 'white' };
    if (tools[k] && doc) { setTool(tools[k]); return; }
    if (e.key === ']') stepLabel(1); else if (e.key === '[') stepLabel(-1);
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') { spaceHeld = false; $('view').classList.remove('pan'); } });
  window.addEventListener('blur', () => { spaceHeld = false; $('view').classList.remove('pan'); });

  // Zoom with Ctrl+wheel around the pointer; pan with Space-drag or the middle button.
  const view = $('view');
  view.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey) || !surfaces.length) return;
    e.preventDefault();
    const s = surfaces.find(x => { const b = x.box.getBoundingClientRect(); return e.clientY >= b.top && e.clientY <= b.bottom; }) || surfaces[0];
    const b0 = s.box.getBoundingClientRect(), fx = (e.clientX - b0.left) / b0.width, fy = (e.clientY - b0.top) / b0.height;
    zoomPt = clamp(zoomPt * Math.exp(-e.deltaY * 0.0018), 0.3, 6); applyZoom();
    const b1 = s.box.getBoundingClientRect();
    view.scrollLeft += b1.left + fx * b1.width - e.clientX; view.scrollTop += b1.top + fy * b1.height - e.clientY;
  }, { passive: false });
  let pan = null;
  view.addEventListener('pointerdown', e => {
    if (!(e.button === 1 || (e.button === 0 && spaceHeld))) return;
    e.preventDefault(); view.setPointerCapture(e.pointerId);
    pan = { x: e.clientX, y: e.clientY, l: view.scrollLeft, t: view.scrollTop };
  });
  view.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });   // no autoscroll
  view.addEventListener('pointermove', e => { if (pan) { view.scrollLeft = pan.l - (e.clientX - pan.x); view.scrollTop = pan.t - (e.clientY - pan.y); } });
  view.addEventListener('pointerup', () => { pan = null; });
  function zoomBy(f) {
    const cx = view.scrollLeft + view.clientWidth / 2, cy = view.scrollTop + view.clientHeight / 2, z0 = zoomPt;
    zoomPt = clamp(zoomPt * f, 0.3, 6); applyZoom();
    view.scrollLeft = cx * zoomPt / z0 - view.clientWidth / 2; view.scrollTop = cy * zoomPt / z0 - view.clientHeight / 2;
  }
  $('zin').onclick = () => zoomBy(1.25);
  $('zout').onclick = () => zoomBy(1 / 1.25);
  $('zfit').onclick = fitPage;
  $('zwidth').onclick = fitWidth;
  $('undo').onclick = () => undo();
  $('redo').onclick = () => redo();

  // ---------------------------------------------------------------- open / options
  async function openFile(f) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.json$/i.test(f.name) || /json/.test(f.type)) return openProjectText(new TextDecoder().decode(bytes));
    return openBytes(f.name, f.type, bytes);
  }
  // Opens a drawing. With `restore`, the labels come back as saved.
  let openSeq = 0;
  async function openBytes(name, type, bytes, restore, note) {
    status('Opening ' + name + '…');
    const seq = ++openSeq;                     // a file opened meanwhile wins
    try {
      await fontsReady;
      let d;
      if (/pdf/i.test(type) || /\.pdf$/i.test(name)) {
        const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
        if (!restore) {
          // a labeled PDF saved with "Editable PDF" carries the original drawing and the labels
          const att = await pdf.getAttachments().catch(() => null);
          const a = att && Object.values(att).find(x => x && x.filename === PROJECT_NAME);
          if (a) return openProjectText(new TextDecoder().decode(a.content), 'Opened the editable PDF: everything can be changed again.');
        }
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) { const pj = await pdf.getPage(i); const vp = pj.getViewport({ scale: 1 }); pages.push({ w: vp.width, h: vp.height, pj }); }
        d = { name, kind: 'pdf', mime: 'application/pdf', bytes, pages };
      } else {
        const mime = type || (/\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png');
        const img = await loadImage(URL.createObjectURL(new Blob([bytes], { type: mime })));
        const k = 72 / 200;                       // scans are usually 200 dpi
        d = { name, kind: 'image', bytes, mime, pages: [{ w: img.naturalWidth * k, h: img.naturalHeight * k, img }] };
      }
      for (const p of d.pages) { await renderSource(p); if (seq !== openSeq) return; }
      doc = d;
      $('fname').textContent = `${name} · ${d.pages.length} sheet${d.pages.length > 1 ? 's' : ''}`;
      undoStack.length = 0; redoStack.length = 0; selection = []; activePart = null;
      if (!restore && pendingProject && pendingProject.file && pendingProject.file.pages === doc.pages.length) { restore = pendingProject.state; note = 'Project restored.'; }
      pendingProject = null;
      if (restore) st = upgradeState(restore);
      else {
        const keepParts = st.parts;
        st = freshState(); st.parts = keepParts.map(p => ({ ...p })); st.nextId = 1 + Math.max(0, ...st.parts.map(p => p.id));
        if (doc.kind === 'image' || !doc.pages.every(p => isPaper(p))) st.opts.layout = 'split';
        const p0 = doc.pages[0]; if (Math.abs(Math.min(p0.w, p0.h) - PAPER.a4[0]) < 8) st.opts.paper = 'a4';
        findAllFigures();
      }
      syncOptsToUI(); updateUndoButtons();
      await rebuild(false);
      fitPage();
      if (st.labels.length && !st.labels.some(l => l.pos)) await placeAll();
      status(note || '');
      saveFile();
    } catch (err) {
      console.error(err); status('Could not open that file: ' + err.message, 'bad');
    }
  }
  const isPaper = p => Object.values(PAPER).some(([w, h]) => (Math.abs(p.w - w) < 8 && Math.abs(p.h - h) < 8) || (Math.abs(p.w - h) < 8 && Math.abs(p.h - w) < 8));

  function syncOptsToUI() {
    $('layout').value = st.opts.layout; $('paper').value = st.opts.paper;
    $('sheetnums').checked = st.opts.sheetnums; $('figlabels').checked = st.opts.figlabels; $('curves').checked = st.opts.curves; $('fs').value = st.opts.fs;
  }
  const relayout = async () => { await afterFigChange(); fitPage(); await placeAll(); };
  $('layout').onchange = async () => { snapshot(); st.opts.layout = $('layout').value; if (st.opts.layout === 'split' && !st.opts.sheetnums) st.opts.sheetnums = true; syncOptsToUI(); for (const l of st.labels) { l.pos = null; l.pinned = false; } st.figLabels = {}; await relayout(); };
  $('paper').onchange = async () => { snapshot(); st.opts.paper = $('paper').value; if (st.opts.layout === 'split') await relayout(); };
  $('sheetnums').onchange = async () => { snapshot(); st.opts.sheetnums = $('sheetnums').checked; if (st.opts.layout === 'split') await relayout(); else drawAll(); };
  $('figlabels').onchange = () => { snapshot(); st.opts.figlabels = $('figlabels').checked; if (st.opts.figlabels) placeAll(); else drawAll(); };
  $('fs').onchange = () => { snapshot(); st.opts.fs = clamp(+$('fs').value || 14, 10, 24); for (const l of st.labels) { if (l.style !== 'none') l.pinned = false; else resizeLabel(l); } placeAll(); };
  $('curves').onchange = () => { snapshot(); st.opts.curves = $('curves').checked; placeAll(); };
  $('placeall').onclick = () => placeAll();
  // Each numeral only has to appear once: drop the copies whose leaders cross two or
  // more lines when the same numeral is shown cleanly in another figure, then re-place.
  $('tidy').onclick = async () => {
    if (!doc) return;
    let dropped = 0;
    for (let round = 0; round < 3; round++) {
      const bad = st.labels.filter(l => l.pos && l.pos.cross >= 2 && !l.pinned && st.labels.some(o =>
        o !== l && o.fig !== l.fig && labelText(o) === labelText(l) && o.pos && o.pos.cross <= 1));
      if (!bad.length) break;
      if (!round) snapshot();
      st.labels = st.labels.filter(l => !bad.includes(l)); dropped += bad.length;
      const n = undoStack.length; await placeAll(); undoStack.length = n;
    }
    selection = selection.filter(exists);
    status(dropped ? `Left out ${dropped} crowded repeat${dropped > 1 ? 's' : ''} (Ctrl+Z brings them back).` : 'Nothing to leave out.');
  };
  $('refind').onclick = async () => {
    if (!doc) return;
    if (st.labels.length && !confirm('Finding the figures again removes the labels placed so far. Go ahead?')) return;
    snapshot(); st.labels = []; st.notes = st.notes.filter(n => n.kind === 'white'); st.figLabels = {}; selection = []; findAllFigures(); await rebuild(false);
  };

  const drop = $('drop'), fileIn = $('file');
  drop.onclick = () => fileIn.click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') fileIn.click(); };
  fileIn.onchange = () => { if (fileIn.files[0]) openFile(fileIn.files[0]); fileIn.value = ''; };
  for (const el of [drop, view]) {
    el.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    el.addEventListener('dragleave', () => drop.classList.remove('over'));
    el.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) openFile(f); });
  }
  function setMode(m) {
    mode = m;
    for (const b of $('modes').children) b.classList.toggle('on', b.dataset.m === m);
    $('toolset').style.visibility = m === 'labels' ? '' : 'hidden';
    selection = selection.filter(s => (m === 'figs') === (s.kind === 'fig'));
    buildSurfaces(); renderLists();
  }
  $('modes').onclick = e => { const m = e.target.dataset.m; if (m && m !== mode) setMode(m); };

  // ---------------------------------------------------------------- exports
  function need() { if (!doc) { status('Open a drawing first.', 'warn'); return false; } return true; }

  async function exportPdf(editable) {
    if (!need()) return;
    status('Writing the PDF…');
    const { PDFDocument, rgb, degrees } = PDFLib;
    await fontsReady;
    const out = await PDFDocument.create();
    out.registerFontkit(window.fontkit);
    const f = await out.embedFont(fontBytes[0], { subset: true }), fb = await out.embedFont(fontBytes[1], { subset: true });
    const cache = new Map();
    const src = doc.kind === 'pdf' ? await PDFDocument.load(doc.bytes, { ignoreEncryption: true }) : null;
    const black = rgb(0, 0, 0), white = rgb(1, 1, 1);
    const tri = (pg, H, h) => pg.drawSvgPath(`M ${h[0][0]} ${h[0][1]} L ${h[1][0]} ${h[1][1]} L ${h[2][0]} ${h[2][1]} Z`, { x: 0, y: H, color: black, borderWidth: 0 });
    for (const sh of sheets) {
      const pg = out.addPage([sh.w, sh.h]), H = sh.h;
      const regions = sh.page != null
        ? [{ page: sh.page, clip: [0, 0, doc.pages[sh.page].w, doc.pages[sh.page].h], dest: [0, 0, sh.w, sh.h] }]
        : sh.figs.map(g => ({ page: g.page, clip: g.clip, dest: sheetRect(g) }));
      for (const r of regions) await drawRegion(out, pg, src, r, H, degrees, cache);
      for (const r of whiteRects(sh)) pg.drawRectangle({ x: r[0], y: H - r[3], width: r[2] - r[0], height: r[3] - r[1], color: white, borderWidth: 0 });
      for (const l of labelsOn(sh)) if (l.pos) {
        const { tip, end, box, ctrl } = l.pos;
        if (l.style !== 'none') {
          if (ctrl) pg.drawSvgPath(`M ${tip[0]} ${tip[1]} Q ${ctrl[0]} ${ctrl[1]} ${end[0]} ${end[1]}`, { x: 0, y: H, borderColor: black, borderWidth: LINE_W });
          else pg.drawLine({ start: { x: tip[0], y: H - tip[1] }, end: { x: end[0], y: H - end[1] }, thickness: LINE_W, color: black });
          if (l.style === 'arrow') tri(pg, H, arrowHead(tip, ctrl || end));
        }
        pg.drawText(labelText(l), { x: box[0], y: H - box[3], size: st.opts.fs, font: f, color: black });
        if (l.style === 'none') pg.drawLine({ start: { x: box[0], y: H - box[3] - 1.6 }, end: { x: box[2], y: H - box[3] - 1.6 }, thickness: LINE_W, color: black });
      }
      for (const n of notesOn(sh)) {
        const gm = noteGeom(n, sh); if (!gm || n.kind === 'white') continue;
        if (n.kind === 'text') { if (n.text) pg.drawText(n.text, { x: gm.a[0], y: H - gm.a[1], size: n.size || NOTE_FS, font: n.bold ? fb : f, color: black }); }
        else {
          pg.drawLine({ start: { x: gm.a[0], y: H - gm.a[1] }, end: { x: gm.b[0], y: H - gm.b[1] }, thickness: LINE_W, color: black });
          if (n.kind === 'arrow') tri(pg, H, arrowHead(gm.b, gm.a));
        }
      }
      if (st.opts.figlabels) for (const g of sh.figs) {
        const fl = st.figLabels[g.fig], fig = figById(g.fig);
        if (fl && fl.box) pg.drawText(figLabelText(fig), { x: fl.box[0], y: H - fl.box[3], size: st.opts.figfs, font: fb, color: black });
      }
      const sn = sheetNumBox(sh);
      if (sn) pg.drawText(sn.text, { x: sn.box[0], y: H - sn.box[3], size: SHEETNUM_FS, font: f, color: black });
    }
    out.setTitle(baseName() + ' (labeled)'); out.setCreator('Sanguine patent drawing labeler'); out.setProducer('pdf-lib');
    if (editable) await out.attach(new TextEncoder().encode(JSON.stringify(projectData())), PROJECT_NAME,
      { mimeType: 'application/json', description: 'Sanguine labels: open this PDF in the labeler to keep editing' });
    download(await out.save(), baseName() + (editable ? '-labeled-editable.pdf' : '-labeled.pdf'), 'application/pdf');
    status((editable ? 'Editable PDF downloaded: open it here again to keep editing. File the plain Labeled PDF.' : 'PDF downloaded.') + unplacedNote());
  }
  function unplacedNote() {
    const n = st.labels.filter(l => !l.pos).length;
    return n ? ` ${n} label${n > 1 ? 's' : ''} had no room and ${n > 1 ? 'are' : 'is'} left out.` : '';
  }

  // One piece of a source page, kept as vectors for PDFs. Each source page is embedded
  // once (so a sheet's scanned image is not copied per figure) and clipped to the piece.
  async function drawRegion(out, pg, src, r, sheetH, degrees, cache) {
    const P = doc.pages[r.page], cw = r.clip[2] - r.clip[0];
    const sc = (r.dest[2] - r.dest[0]) / cw;
    const toPdf = b => [b[0], sheetH - b[3], b[2] - b[0], b[3] - b[1]];      // x, y, w, h
    const [cx, cy, cwP, chP] = toPdf(r.dest);
    const L = PDFLib;
    pg.pushOperators(L.pushGraphicsState(), L.rectangle(cx, cy, cwP, chP), L.clip(), L.endPath());
    if (src) {
      let emb = cache.get(r.page);
      if (!emb) { emb = await out.embedPage(src.getPage(r.page)); cache.set(r.page, emb); }
      const vp = P.pj.getViewport({ scale: 1 });
      const rot = ((vp.rotation % 360) + 360) % 360;
      // where the whole (as-shown) page lands, then undo the page rotation around it
      const full = [r.dest[0] - r.clip[0] * sc, r.dest[1] - r.clip[1] * sc, r.dest[0] + (P.w - r.clip[0]) * sc, r.dest[1] + (P.h - r.clip[1]) * sc];
      const [X, Y, DW, DH] = toPdf(full);
      const o = { xScale: sc, yScale: sc };
      if (rot === 0) Object.assign(o, { x: X, y: Y });
      else if (rot === 90) Object.assign(o, { x: X, y: Y + DH, rotate: degrees(-90) });
      else if (rot === 180) Object.assign(o, { x: X + DW, y: Y + DH, rotate: degrees(180) });
      else Object.assign(o, { x: X + DW, y: Y, rotate: degrees(90) });
      pg.drawPage(emb, o);
    } else {
      let im = cache.get('img');
      if (!im) {
        im = doc.mime === 'image/jpeg' ? await out.embedJpg(doc.bytes) : await out.embedPng(await pngBytes(P.img));
        cache.set('img', im);
      }
      pg.drawImage(im, { x: cx - r.clip[0] * sc, y: cy + chP - P.h * sc + r.clip[1] * sc, width: P.w * sc, height: P.h * sc });
    }
    pg.pushOperators(L.popGraphicsState());
  }
  async function pngBytes(img) {
    if (doc.mime === 'image/png') return doc.bytes;
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0);
    return new Promise(ok => c.toBlob(b => b.arrayBuffer().then(ok), 'image/png'));
  }

  async function exportPptx() {
    if (!need()) return;
    status('Writing the PowerPoint…');
    if (!window.PptxGenJS) await loadScript(PPTX_URL);
    const pptx = new PptxGenJS();
    const sh0 = sheets[0];
    pptx.defineLayout({ name: 'SHEET', width: sh0.w / 72, height: sh0.h / 72 });
    pptx.layout = 'SHEET';
    const I = v => v / 72, BLACK = '000000';
    for (const sh of sheets) {
      const slide = pptx.addSlide();
      const c = await paintSheet(sh, 300 / 72);
      slide.addImage({ data: c.toDataURL('image/png'), x: 0, y: 0, w: I(sh.w), h: I(sh.h) });
      const text = (t, box, size, bold, underline) => slide.addText(t, {
        x: I(box[0] - size * 0.1), y: I(box[3] - size * 0.93), w: I(box[2] - box[0] + size * 0.4), h: I(size * 1.2),
        fontFace: 'Arial', fontSize: size, bold: !!bold, underline: underline ? { style: 'sng' } : undefined,
        color: BLACK, margin: 0, valign: 'top', fit: 'none', wrap: false,
      });
      // a straight line; `head` puts an arrowhead at a or b
      const line = (a, b, head) => {
        const flipH = (b[0] - a[0]) * (b[1] - a[1]) < 0;
        const aIsBegin = a[1] < b[1] || (a[1] === b[1] && a[0] <= b[0]);   // the shape runs from its top end
        const ln = { color: BLACK, width: LINE_W };
        if (head) ln[(head === 'a') === aIsBegin ? 'beginArrowType' : 'endArrowType'] = 'triangle';
        slide.addShape(pptx.ShapeType.line, {
          x: I(Math.min(a[0], b[0])), y: I(Math.min(a[1], b[1])),
          w: I(Math.abs(b[0] - a[0]) || 0.01), h: I(Math.abs(b[1] - a[1]) || 0.01), flipH, line: ln,
        });
      };
      for (const l of labelsOn(sh)) if (l.pos) {
        const { tip, end, box, ctrl } = l.pos;
        if (l.style !== 'none' && ctrl) {
          const all = [tip, end, ctrl];
          const x0 = Math.min(...all.map(q => q[0])), y0 = Math.min(...all.map(q => q[1]));
          const x1 = Math.max(...all.map(q => q[0])), y1 = Math.max(...all.map(q => q[1]));
          const ln = { color: BLACK, width: LINE_W }; if (l.style === 'arrow') ln.beginArrowType = 'triangle';
          slide.addShape(pptx.ShapeType.custGeom, {
            x: I(x0), y: I(y0), w: I(Math.max(x1 - x0, 0.5)), h: I(Math.max(y1 - y0, 0.5)), line: ln,
            points: [{ x: I(tip[0] - x0), y: I(tip[1] - y0) }, { x: I(end[0] - x0), y: I(end[1] - y0), curve: { type: 'quadratic', x1: I(ctrl[0] - x0), y1: I(ctrl[1] - y0) } }],
          });
        } else if (l.style !== 'none') line(tip, end, l.style === 'arrow' ? 'a' : null);
        text(labelText(l), box, st.opts.fs, false, l.style === 'none');
      }
      for (const n of notesOn(sh)) {
        const gm = noteGeom(n, sh); if (!gm || n.kind === 'white') continue;
        if (n.kind === 'text') { if (n.text) text(n.text, gm.box.slice(0, 3).concat([gm.a[1]]), n.size || NOTE_FS, n.bold); }
        else line(gm.a, gm.b, n.kind === 'arrow' ? 'b' : null);
      }
      if (st.opts.figlabels) for (const g of sh.figs) { const fl = st.figLabels[g.fig]; if (fl && fl.box) text(figLabelText(figById(g.fig)), fl.box, st.opts.figfs, true); }
      const sn = sheetNumBox(sh); if (sn) text(sn.text, sn.box, SHEETNUM_FS);
    }
    const blob = await pptx.write({ outputType: 'blob' });
    download(blob, baseName() + '-labeled.pptx');
    status('PowerPoint downloaded: the drawing is a picture; the numerals, leaders and notes are editable.' + unplacedNote());
  }

  // Reference numeral list rows: one per numeral as written (26a, 26b...), in numeral order.
  function partRows() {
    const rows = [];
    const figOrder = new Map(st.figures.map((f, i) => [f.id, i]));
    for (const p of st.parts) {
      const byText = new Map();
      for (const l of st.labels.filter(l => l.part === p.id)) {
        const t = labelText(l);
        if (!byText.has(t)) byText.set(t, new Set());
        byText.get(t).add(l.fig);
      }
      if (!byText.size) rows.push({ n: p.n, name: p.name, figs: [] });
      for (const [t, figs] of byText) rows.push({ n: t, name: p.name, figs: [...figs].filter(figById).sort((a, b) => figOrder.get(a) - figOrder.get(b)).map(id => figById(id).num) });
    }
    rows.sort((a, b) => cmpNum(a.n, b.n));
    return rows;
  }
  function figsText(nums) {
    if (!nums.length) return '';
    if (nums.length === 1) return 'FIG. ' + nums[0];
    const parts = [];
    if (nums.every(n => /^\d+$/.test(n))) {
      const v = nums.map(Number).sort((a, b) => a - b);
      for (let i = 0; i < v.length;) {
        let j = i; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
        parts.push(j - i >= 2 ? `${v[i]}–${v[j]}` : j > i ? `${v[i]}, ${v[j]}` : `${v[i]}`);
        i = j + 1;
      }
    } else parts.push(...nums);
    const all = parts.join(', ');
    const k = all.lastIndexOf(', ');
    return 'FIGS. ' + (k < 0 ? all : all.slice(0, k) + ' and ' + all.slice(k + 2));
  }
  function exportTxt() {
    const rows = partRows();
    const w = Math.max(4, ...rows.map(r => r.n.length));
    const txt = 'REFERENCE NUMERAL LIST\n' + baseName() + '\n\n' +
      rows.map(r => `${r.n.padEnd(w)}  ${r.name}${r.figs.length ? '  (' + figsText(r.figs) + ')' : ''}`).join('\n') + '\n';
    download(txt, baseName() + '-parts.txt', 'text/plain;charset=utf-8');
  }
  function exportCsv() {
    const q = s => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    const csv = 'numeral,element,figures\r\n' + partRows().map(r => [r.n, r.name, figsText(r.figs)].map(q).join(',')).join('\r\n') + '\r\n';
    download('﻿' + csv, baseName() + '-parts.csv', 'text/csv;charset=utf-8');
  }
  async function exportDocx() {
    const rows = partRows();
    const R = (t, o = {}) => `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${o.b ? '<w:b/>' : ''}<w:sz w:val="${o.sz || 24}"/></w:rPr><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r>`;
    const P = (runs, o = {}) => `<w:p><w:pPr>${o.center ? '<w:jc w:val="center"/>' : ''}<w:spacing w:after="${o.after == null ? 120 : o.after}"/></w:pPr>${runs}</w:p>`;
    const cell = (t, w, o = {}) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${o.shade ? '<w:shd w:val="clear" w:color="auto" w:fill="E7E9EE"/>' : ''}</w:tcPr>${P(R(t, o), { after: 0 })}</w:tc>`;
    const widths = [1500, 4800, 2700];
    const allFigs = st.figures.map(f => f.num);
    const body = P(R('REFERENCE NUMERAL LIST', { b: true, sz: 28 }), { center: true }) +
      P(R(baseName() + (allFigs.length ? '  —  ' + figsText(allFigs) : ''), { sz: 22 }), { center: true, after: 240 }) +
      `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b)}" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders>` +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('') +
      `</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
      `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell('Numeral', widths[0], { b: true, shade: true })}${cell('Element', widths[1], { b: true, shade: true })}${cell('Shown in', widths[2], { b: true, shade: true })}</w:tr>` +
      rows.map(r => `<w:tr>${cell(r.n, widths[0])}${cell(r.name, widths[1])}${cell(figsText(r.figs), widths[2])}</w:tr>`).join('') + '</w:tbl>' +
      // a start on the specification's list of figures, to fill in
      (st.figures.length ? P('', { after: 240 }) + P(R('BRIEF DESCRIPTION OF THE DRAWINGS', { b: true }), { after: 200 }) +
        st.figures.map((f, i) => P(R(`FIG. ${f.num} is ${f.view ? (/^[aeiou]/i.test(f.view) ? 'an ' : 'a ') + f.view : 'a ________ view of ________'}${i === st.figures.length - 1 ? '.' : ';'}`))).join('') : '');
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const z = new JSZip();
    z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    z.file('word/document.xml', docXml);
    download(await z.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), baseName() + '-parts.docx');
  }
  const failed = what => err => { console.error(err); status(what + ' failed: ' + err.message, 'bad'); };
  $('expdf').onclick = () => exportPdf(false).catch(failed('PDF'));
  $('expedit').onclick = () => exportPdf(true).catch(failed('PDF'));
  $('expptx').onclick = () => exportPptx().catch(failed('PowerPoint'));
  $('exdocx').onclick = () => exportDocx().catch(failed('Word file'));
  $('extxt').onclick = exportTxt;
  $('excsv').onclick = exportCsv;

  // ---------------------------------------------------------------- saving work
  // A project file carries the drawing itself, so it opens on its own anywhere.
  function projectData() {
    return { app: 'sanguine', version: 2, file: { name: doc.name, pages: doc.pages.length, type: doc.mime, data: toB64(doc.bytes) }, state: st };
  }
  $('save').onclick = () => {
    if (!need()) return;
    download(JSON.stringify(projectData()), baseName() + '-labels.json', 'application/json');
    status('Saved. Open that file here (or drop it on the page) to keep editing.');
  };
  $('load').onclick = () => $('loadfile').click();
  $('loadfile').onchange = async () => { const f = $('loadfile').files[0]; $('loadfile').value = ''; if (f) openFile(f); };
  async function openProjectText(text, note) {
    try {
      const proj = JSON.parse(text);
      if (!['sanguine', 'alizarin'].includes(proj.app) || !proj.state) throw new Error('not a Sanguine project file');
      if (proj.file && proj.file.data) return openBytes(proj.file.name, proj.file.type || 'application/pdf', fromB64(proj.file.data), proj.state, note || 'Your work is back: everything can be changed.');
      // version 1 files hold only the labels: the drawing has to be opened separately
      if (doc && proj.file && proj.file.pages === doc.pages.length) {
        snapshot(); st = upgradeState(proj.state); syncOptsToUI(); await rebuild(false); status('Project opened.');
      } else {
        pendingProject = proj;
        status(`Now open the drawing${proj.file ? ' (' + proj.file.name + ')' : ''} and the labels come back.`);
      }
    } catch (err) { status('Could not read that project: ' + err.message, 'bad'); }
  }

  // Work in progress is kept in this browser (IndexedDB), so a reload loses nothing.
  const DB = (() => {
    let p = null;
    const open = () => p || (p = new Promise((ok, bad) => {
      const r = indexedDB.open('sanguine', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
    }));
    const tx = (m, fn) => open().then(db => new Promise((ok, bad) => {
      const t = db.transaction('kv', m), q = fn(t.objectStore('kv'));
      t.oncomplete = () => ok(q.result); t.onerror = () => bad(t.error);
    }));
    return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)) };
  })();
  let saveTimer = null;
  function scheduleSave() {
    if (!doc) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { DB.set('state', { name: doc.name, state: JSON.stringify(st), savedAt: Date.now() }).catch(() => {}); } catch (e) { /* storage unavailable */ }
    }, 700);
  }
  function saveFile() {
    try { DB.set('file', { name: doc.name, type: doc.mime, bytes: doc.bytes }).catch(() => {}); } catch (e) { /* storage unavailable */ }
  }
  (async () => {
    try {
      const [file, saved] = await Promise.all([DB.get('file'), DB.get('state')]);
      if (!file || !saved || saved.name !== file.name || doc) return;
      $('restorebox').style.display = '';
      const n = JSON.parse(saved.state).labels.length;
      $('restoreinfo').textContent = `${file.name}, ${n} label${n === 1 ? '' : 's'}, ${new Date(saved.savedAt).toLocaleString()}`;
      $('restore').onclick = () => openBytes(file.name, file.type, file.bytes, JSON.parse(saved.state), 'Picked up where you left off.');
    } catch (e) { /* no saved work */ }
  })();

  // ---------------------------------------------------------------- Claude
  // Each sheet as drawn, with a percent grid so positions can be read off it.
  function gridCanvas(i) {
    const p = doc.pages[i], c = document.createElement('canvas');
    c.width = p.canvas.width; c.height = p.canvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(p.canvas, 0, 0);
    const W = c.width, H = c.height;
    ctx.font = `600 ${Math.round(W / 80)}px Arial, sans-serif`; ctx.textBaseline = 'top';
    for (let k = 0; k <= 100; k += 5) {
      const major = k % 10 === 0;
      ctx.strokeStyle = major ? 'rgba(0,120,255,.55)' : 'rgba(0,120,255,.22)'; ctx.lineWidth = major ? 1.5 : 1;
      ctx.beginPath(); ctx.moveTo(W * k / 100, 0); ctx.lineTo(W * k / 100, H); ctx.moveTo(0, H * k / 100); ctx.lineTo(W, H * k / 100); ctx.stroke();
      if (major && k > 0 && k < 100) {
        ctx.fillStyle = 'rgba(0,90,220,.9)';
        ctx.fillText(String(k), W * k / 100 + 3, 3); ctx.fillText(String(k), W * k / 100 + 3, H - W / 60);
        ctx.fillText(String(k), 3, H * k / 100 + 3); ctx.fillText(String(k), W - W / 30, H * k / 100 + 3);
      }
    }
    return c;
  }
  async function gridImages() {
    if (!need()) return;
    status('Drawing the grids…');
    const z = new JSZip();
    for (let i = 0; i < doc.pages.length; i++) z.file(`sheet-${i + 1}.png`, await new Promise(ok => gridCanvas(i).toBlob(ok, 'image/png')));
    download(await z.generateAsync({ type: 'blob' }), baseName() + '-sheets-with-grid.zip');
    status('Give Claude these images (unzip first) along with the prompt.');
  }
  function claudePrompt() {
    const figs = doc ? st.figures.map(f => {
      const P = doc.pages[f.page], b = f.box;
      return `  FIG. ${f.num}: sheet ${f.page + 1}, box ${[b[0] / P.w, b[1] / P.h, b[2] / P.w, b[3] / P.h].map(v => Math.round(v * 100)).join(', ')}` +
        (figCaption(f) ? ' (it has a caption drawn under or beside it: use the number written there)' : '');
    }).join('\n') : '';
    const parts = st.parts.map(p => `  ${p.n} ${p.name}`).join('\n');
    return `I am preparing the drawings for a patent application and need reference numerals added. The attached images are the drawing sheets, one per sheet${doc ? ` (${doc.pages.length} in all)` : ''}, with a blue grid: the numbers along the edges are percent of the sheet's width (left to right) and height (top to bottom).

Please:
1. Identify each separate figure (view)${figs ? '. These are the figures I have; keep their numbers unless they are wrong:\n' + figs : ', numbered FIG. 1, FIG. 2 … in reading order (or as already numbered on the sheets).'}
2. List the parts and features the specification will refer to. ${parts ? 'Use these numerals and names, and add any part that is missing:\n' + parts + '\n' : 'Give each one a reference numeral: even numbers from 10 upward (10, 12, 14 …), in order of importance, the same numeral for the same part in every figure.'} Use letter suffixes (26a, 26b) only for identical parts that the text must tell apart.
3. For every figure in which a part is visible, give a point that lies exactly ON a drawn line of that part (never in empty space or inside a hollow outline), as [x, y] in grid percent with one decimal. If the part is easy to hit in more than one place, give up to four points; the first is the preferred one. Skip a part in a figure where it cannot be seen.

Answer with only this JSON, nothing else:
{
  "figures": [{"fig": "1", "sheet": 1, "box": [x0, y0, x1, y1], "view": "front perspective view of the walker"}],
  "parts":   [{"n": "10", "name": "frame"}],
  "labels":  [{"fig": "1", "n": "10", "at": [[x, y], [x, y]]}]
}
("box" is the figure's extent in grid percent: left, top, right, bottom. "view" says what the figure shows, as it would follow "FIG. 1 is a" in the Brief Description of the Drawings.)`;
  }
  const ANSWER_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['figures', 'parts', 'labels'],
    properties: {
      figures: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fig', 'sheet', 'box', 'view'],
        properties: { fig: { type: 'string' }, sheet: { type: 'integer' }, box: { type: 'array', items: { type: 'number' } }, view: { type: 'string' } } } },
      parts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'name'],
        properties: { n: { type: 'string' }, name: { type: 'string' } } } },
      labels: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fig', 'n', 'at'],
        properties: { fig: { type: 'string' }, n: { type: 'string' }, at: { type: 'array', items: { type: 'array', items: { type: 'number' } } } } } },
    },
  };
  let claudeRun = null;
  function readKey() { try { return localStorage.getItem('sanguine.apikey') || ''; } catch (e) { return ''; } }
  $('askclaude').onclick = () => {
    if (!need()) return;
    const k = readKey();
    $('apikey').value = k; $('rememberkey').checked = !!k; $('claudestatus').textContent = '';
    $('claudego').disabled = false; $('claudemodal').classList.add('on');
    (k ? $('claudego') : $('apikey')).focus();
  };
  $('claudecancel').onclick = () => { if (claudeRun) claudeRun.abort(); $('claudemodal').classList.remove('on'); };
  $('claudego').onclick = async () => {
    const key = $('apikey').value.trim(), cs = $('claudestatus');
    if (!key) { cs.textContent = 'Paste your API key first.'; cs.className = 'status warn'; return; }
    try { if ($('rememberkey').checked) localStorage.setItem('sanguine.apikey', key); else localStorage.removeItem('sanguine.apikey'); } catch (e) { /* storage unavailable */ }
    $('claudego').disabled = true; cs.className = 'status';
    const t0 = Date.now(), n = doc.pages.length;
    const tick = setInterval(() => { cs.textContent = `Claude is looking at ${n} sheet${n > 1 ? 's' : ''}… ${Math.round((Date.now() - t0) / 1000)} s (usually a minute or two)`; }, 500);
    let Anthropic = null;
    try {
      ({ default: Anthropic } = await import(SDK_URL));
      const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
      const content = [];
      for (let i = 0; i < n; i++) {
        content.push({ type: 'text', text: `Sheet ${i + 1}:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: gridCanvas(i).toDataURL('image/png').split(',')[1] } });
      }
      content.push({ type: 'text', text: claudePrompt() });
      claudeRun = client.beta.messages.stream({
        model: $('cmodel').value,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high', format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
        messages: [{ role: 'user', content }],
      });
      const msg = await claudeRun.finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.');
      if (msg.stop_reason === 'max_tokens') throw new Error('the answer was cut off; try fewer sheets at a time.');
      const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const count = await importClaude(text, $('claudereplace').checked);
      $('claudemodal').classList.remove('on');
      status(`Claude labeled ${count} spots. Check each leader: [ and ] step through them.`);
    } catch (err) {
      console.error(err);
      let m = err.message || String(err);
      if (Anthropic && err instanceof Anthropic.APIUserAbortError) m = 'Stopped.';
      else if (Anthropic && err instanceof Anthropic.AuthenticationError) m = 'That API key was not accepted.';
      else if (Anthropic && err instanceof Anthropic.PermissionDeniedError) m = 'That API key is not allowed to do this (check its workspace and billing).';
      else if (Anthropic && err instanceof Anthropic.RateLimitError) m = 'Too many requests just now; wait a minute and try again.';
      else if (Anthropic && err instanceof Anthropic.APIConnectionError) m = 'Could not reach Anthropic (offline, or blocked by the network).';
      else if (!Anthropic) m = 'Could not load the Claude library: ' + m;
      cs.textContent = m; cs.className = 'status bad';
    } finally {
      clearInterval(tick); claudeRun = null; $('claudego').disabled = false;
    }
  };

  $('prompt').onclick = async () => {
    const t = claudePrompt();
    try { await navigator.clipboard.writeText(t); status('Prompt copied. Paste it into Claude together with the sheet images.'); }
    catch (e) { $('pastebox').value = t; $('pastemodal').classList.add('on'); $('pastestatus').textContent = 'Copy the prompt from the box (the clipboard was not available).'; }
  };
  $('paste').onclick = () => { $('pastebox').value = ''; $('pastestatus').textContent = ''; $('pastemodal').classList.add('on'); $('pastebox').focus(); };
  $('pastecancel').onclick = () => $('pastemodal').classList.remove('on');
  $('pasteok').onclick = async () => {
    try {
      const n = await importClaude($('pastebox').value, $('pastereplace').checked);
      $('pastemodal').classList.remove('on');
      status(`Imported ${n} labels. Check each leader: [ and ] step through them.`);
    } catch (err) { console.error(err); $('pastestatus').textContent = 'Could not read that: ' + err.message; }
  };

  function parseJsonLoose(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('no JSON found');
    return JSON.parse(text.slice(a, b + 1).replace(/,\s*([\]}])/g, '$1'));
  }
  async function importClaude(text, replace) {
    if (!doc) throw new Error('open the drawing first');
    const j = parseJsonLoose(text);
    const pts = v => (Array.isArray(v) && typeof v[0] === 'number' ? [v] : (v || [])).filter(q => Array.isArray(q) && q.length >= 2);
    let frac = 1;
    const all = [].concat(...(j.labels || []).map(l => pts(l.at)), ...(j.figures || []).map(f => [f.box || []]));
    if (all.length && all.every(q => q.every(v => v <= 1.0001))) frac = 100;       // fractions instead of percent
    const toPt = (page, q) => { const P = doc.pages[page]; return [q[0] * frac / 100 * P.w, q[1] * frac / 100 * P.h]; };
    snapshot();
    if (replace) { st.labels = []; st.figLabels = {}; selection = []; }
    if (Array.isArray(j.figures) && j.figures.length) {
      const nf = [];
      for (const f of j.figures) {
        const page = Math.max(0, Math.min(doc.pages.length - 1, (+(f.sheet || f.page) || 1) - 1));
        if (!Array.isArray(f.box) || f.box.length < 4) continue;
        const a = toPt(page, [f.box[0], f.box[1]]), b = toPt(page, [f.box[2], f.box[3]]);
        const old = st.figures.find(o => o.page === page && o.num === String(f.fig));
        nf.push({ id: old && !nf.some(x => x.id === old.id) ? old.id : nid(), page, num: String(f.fig), box: normRect(a, b),
                  view: typeof f.view === 'string' ? f.view.trim().replace(/^an? /i, '').replace(/[.;]+$/, '') : (old && old.view) || '' });
      }
      if (nf.length) {
        // Claude's boxes are rough: fit each one to the ink inside it
        for (const f of nf) { const t = inkBox(f.page, f.box); if (t) f.box = t; }
        st.labels = st.labels.filter(l => nf.some(f => f.id === l.fig));
        st.notes = st.notes.filter(n => n.kind === 'white' || nf.some(f => f.id === n.fig));
        st.figures = nf;
      }
    }
    for (const p of j.parts || []) {
      const n = String(p.n || '').trim(), name = String(p.name || '').trim(); if (!n) continue;
      const ex = st.parts.find(q => q.n === n);
      if (ex) { if (!ex.name) ex.name = name; } else st.parts.push({ id: nid(), n, name });
    }
    await rebuild(false);
    let count = 0;
    for (const l of j.labels || []) {
      const n = String(l.n || l.numeral || '').trim(); if (!n) continue;
      const f = st.figures.find(x => x.num === String(l.fig)); if (!f) continue;
      let part = st.parts.find(p => p.n === n) || st.parts.find(p => p.n === E.splitNumeral(n)[0]);
      if (!part) { part = { id: nid(), n: E.splitNumeral(n)[0], name: String(l.name || '') }; st.parts.push(part); }
      const sh = sheetOfFig(f.id), g = placementOf(f.id); if (!sh) continue;
      const eng = engineFor(sh);
      const tips = [];
      for (const q of pts(l.at)) {
        const s = T(g, toPt(f.page, q)).map(v => v * S);
        const sp = eng.snap(s[0], s[1], Math.round(12 * S)) || eng.snap(s[0], s[1], Math.round(24 * S)) || s;
        tips.push(Ti(g, pt(sp)));
      }
      if (!tips.length) continue;
      st.labels.push({ id: nid(), part: part.id, text: n === part.n ? null : n, fig: f.id, tip: tips[0], alts: tips.slice(1), pos: null, pinned: false, style: 'line' });
      count++;
    }
    renderLists();
    const n = undoStack.length; await placeAll(); undoStack.length = n;
    setMode('labels');
    return count;
  }
  // The extent of the ink inside a (slightly enlarged) box on a source page, padded.
  function inkBox(page, box) {
    const P = doc.pages[page], W = P.canvas.width, H = P.canvas.height, m = 6;
    const x0 = Math.max(0, Math.floor((box[0] - m) * S)), y0 = Math.max(0, Math.floor((box[1] - m) * S));
    const x1 = Math.min(W, Math.ceil((box[2] + m) * S)), y1 = Math.min(H, Math.ceil((box[3] + m) * S));
    let a = W, b = H, c = -1, d = -1;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (P.figInk[y * W + x]) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
    if (c < 0) return null;
    return [Math.max(0, a / S - 4), Math.max(0, b / S - 4), Math.min(P.w, c / S + 4), Math.min(P.h, d / S + 4)];
  }
  function overlap(a, b) {
    const ov = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    return ov / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  }
  $('gridimgs').onclick = () => gridImages().catch(failed('The images'));

  // The sample: a flashlight drawing and the answer Claude gave for it.
  async function demo() {
    const b = new Uint8Array(await fetch('examples/flashlight.pdf').then(r => r.arrayBuffer()));
    await openBytes('flashlight.pdf', 'application/pdf', b);
    const n = await importClaude(await fetch('examples/flashlight-claude.json').then(r => r.text()), true);
    undoStack.length = 0; updateUndoButtons();
    status(`Sample loaded: ${n} labels placed from Claude's answer. Drag a numeral, or drag a leader to curve it.`);
  }
  $('demo').onclick = () => demo().catch(err => status('Could not load the sample: ' + err.message, 'bad'));
  if (/[?&]demo\b/.test(location.search)) demo().catch(err => status('Could not load the sample: ' + err.message, 'bad'));

  updateUndoButtons(); renderLists();
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (surfaces.length) fitPage(); }, 150); });
  window.__sanguine = { get st() { return st; }, get sheets() { return sheets; }, get selection() { return selection; }, importClaude, placeAll, openBytes, exportPdf, projectData };
})();
