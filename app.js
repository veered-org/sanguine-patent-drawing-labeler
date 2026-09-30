// Alizarin: the page. Everything runs in the browser; the drawing never leaves it.
// Coordinates: "source pt" = PDF points on a source page (top-left origin, as shown);
// "sheet pt" = points on an output sheet; the engine works in sheet px (S px per pt).
(function () {
  'use strict';
  const E = window.AlizarinEngine;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const PPTX_URL = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
  const S = 2;                                        // px per pt for display and placement
  const PAPER = { letter: [612, 792], a4: [595.28, 841.89] };
  const MARGIN = { t: 72, l: 72, r: 45, b: 27 };      // 37 CFR 1.84(g): 2.5, 2.5, 1.5, 1.0 cm
  const PAD = { l: 58, r: 58, t: 34, b: 70 };         // room for numerals around an enlarged figure
  const MAXSC = 1.6;
  const LINE_W = 0.8, SHEETNUM_FS = 12;
  const $ = id => document.getElementById(id);

  let doc = null;            // {name, kind, bytes, pages: [{w, h, pj|img, canvas, ink}]}
  let st = freshState();
  let sheets = [];
  let surfaces = [];
  let mode = 'labels', zoomPt = 1, activePart = null, sel = null, pendingProject = null;
  let helv = null, helvB = null;
  const undoStack = [];

  function freshState() {
    return { figures: [], parts: [], labels: [], figLabels: {}, nextId: 1,
             opts: { layout: 'keep', paper: 'letter', sheetnums: false, figlabels: true, fs: 14, figfs: 20 } };
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

  // ---------------------------------------------------------------- helpers
  function status(msg, cls) { const el = $('status'); el.textContent = msg || ''; el.className = 'status ' + (cls || ''); }
  function download(data, name, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const baseName = () => doc ? doc.name.replace(/\.[^.]+$/, '') : 'drawing';
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

  function snapshot() { undoStack.push(JSON.stringify(st)); if (undoStack.length > 60) undoStack.shift(); }
  async function undo() {
    if (!undoStack.length) return;
    const prev = JSON.parse(undoStack.pop());
    const relayout = JSON.stringify([prev.figures, prev.opts]) !== JSON.stringify([st.figures, st.opts]);
    st = prev; syncOptsToUI();
    if (relayout) await rebuild(false); else { renderLists(); drawAll(); }
  }

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
  }

  function findAllFigures() {
    st.figures = [];
    doc.pages.forEach((p, i) => {
      let boxes = E.findFigures(p.ink, p.canvas.width, p.canvas.height, S).map(b => b.map(v => v / S));
      if (!boxes.length) boxes = [[MARGIN.l, MARGIN.t, p.w - MARGIN.r, p.h - MARGIN.b]];
      for (const b of boxes) {
        const pad = 4;
        st.figures.push({ id: nid(), page: i, box: [Math.max(0, b[0] - pad), Math.max(0, b[1] - pad), Math.min(p.w, b[2] + pad), Math.min(p.h, b[3] + pad)], num: '' });
      }
    });
    renumberFigures();
  }
  function renumberFigures() { st.figures.forEach((f, i) => { f.num = String(i + 1); }); }

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

  // Draws a sheet's drawing (no labels) at `scale` px per pt.
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
      return c;
    }
    for (const g of sh.figs) {
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
    return c;
  }

  async function renderSheets() {
    for (const sh of sheets) {
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
    for (const l of labelsOn(sh)) if (l.pos && !skip(l)) { boxes.push(px(l.pos.box)); segs.push([px(l.pos.tip), px(l.pos.end)]); }
    if (withFigLabels) for (const g of sh.figs) { const fl = st.figLabels[g.fig]; if (fl && fl.box && st.opts.figlabels) boxes.push(px(fl.box)); }
    const sn = sheetNumBox(sh); if (sn) boxes.push(px(sn.box));
    return { boxes, segs };
  }
  function applyResult(l, r) {
    l.pos = r ? { box: pt(r.box), tip: pt(r.tip), end: pt(r.end), cross: r.crossings } : null;
  }

  function placeOne(l) {
    const sh = sheetOfFig(l.fig); if (!sh) return;
    const eng = engineFor(sh);
    const res = eng.place([itemFor(l, sh)], measurePx, obstaclesFor(sh, o => o === l, true));
    applyResult(l, res[l.id]);
  }

  async function placeAll() {
    if (!doc) return;
    snapshot();
    status('Placing…');
    await new Promise(r => setTimeout(r, 20));
    let placed = 0, missing = 0, crossing = 0;
    for (const sh of sheets) {
      const eng = engineFor(sh);
      const mine = labelsOn(sh);
      const pinnedFL = sh.figs.filter(g => (st.figLabels[g.fig] || {}).pinned);
      const obst = obstaclesFor(sh, l => !l.pinned, false);
      for (const g of pinnedFL) obst.boxes.push(px(st.figLabels[g.fig].box));
      const todo = mine.filter(l => !l.pinned);
      const res = eng.place(todo.map(l => itemFor(l, sh)), measurePx, obst);
      for (const l of todo) applyResult(l, res[l.id]);
      if (st.opts.figlabels) {
        const done = mine.filter(l => l.pos).map(l => ({ box: px(l.pos.box), tip: px(l.pos.tip), end: px(l.pos.end) }));
        const sn = sheetNumBox(sh); if (sn) done.push({ box: px(sn.box), tip: [0, 0], end: [0, 0] });
        for (const g of sh.figs) {
          const f = figById(g.fig), cur = st.figLabels[g.fig];
          if (cur && cur.pinned) { done.push({ box: px(cur.box), tip: [0, 0], end: [0, 0] }); continue; }
          const wh = measure(figLabelText(f), true, st.opts.figfs).map(v => v * S);
          const box = eng.placeFigLabel(sh.figInk[g.fig], wh, done);
          st.figLabels[g.fig] = { box: pt(box), pinned: false };
          done.push({ box, tip: [0, 0], end: [0, 0] });
        }
      }
      await new Promise(r => setTimeout(r, 0));
    }
    for (const l of st.labels) { if (!l.pos) missing++; else { placed++; if (l.pos.cross) crossing++; } }
    report(placed, missing, crossing);
    status('');
    renderLists(); drawAll();
  }
  function report(placed, missing, crossing) {
    if (placed == null) {
      placed = st.labels.filter(l => l.pos).length; missing = st.labels.length - placed;
      crossing = st.labels.filter(l => l.pos && l.pos.cross).length;
    }
    $('report').innerHTML = st.labels.length ? `<span class="pill ok">${placed} placed</span> ` +
      (crossing ? `<span class="pill warn">${crossing} cross a line</span> ` : '') +
      (missing ? `<span class="pill bad">${missing} without room</span>` : '') : '';
  }

  // ---------------------------------------------------------------- lists
  function renderLists() {
    const fl = $('figlist');
    fl.innerHTML = st.figures.map((f, i) => `<tr data-id="${f.id}" class="${sel && sel.kind === 'fig' && sel.id === f.id ? 'active' : ''}">
      <td style="width:44px;color:var(--muted)">FIG.</td><td class="num"><input value="${esc(f.num)}" data-k="num"></td>
      <td style="color:var(--muted);font-size:12px">sheet ${f.page + 1}</td>
      <td class="x"><button class="x" data-a="up" title="Move up">↑</button></td>
      <td class="x"><button class="x" data-a="dn" title="Move down">↓</button></td>
      <td class="x"><button class="x" data-a="del" title="Remove">×</button></td></tr>`).join('');
    const counts = {};
    for (const l of st.labels) counts[l.part] = (counts[l.part] || 0) + 1;
    $('partlist').innerHTML = st.parts.map(p => `<tr data-id="${p.id}" class="${activePart === p.id ? 'active' : ''}">
      <td class="num"><input value="${esc(p.n)}" data-k="n"></td><td><input value="${esc(p.name)}" data-k="name"></td>
      <td class="cnt" title="labels placed">${counts[p.id] || ''}</td><td class="x"><button class="x" data-a="del" title="Remove">×</button></td></tr>`).join('');
    const ap = partById(activePart);
    $('activepart').innerHTML = ap ? `Click the drawing to label <b>${esc(ap.n)} ${esc(ap.name)}</b>` :
      (st.parts.length ? 'Pick a part in the list, then click it on the drawing' : '');
    const l = sel && sel.kind === 'label' && st.labels.find(x => x.id === sel.id);
    $('labeledit').style.display = l ? '' : 'none';
    if (l) { $('ltext').value = labelText(l); $('lpin').checked = !!l.pinned; }
    report();
  }

  $('figlist').addEventListener('click', async e => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const id = +tr.dataset.id, i = st.figures.findIndex(f => f.id === id), a = e.target.dataset.a;
    if (a === 'del') {
      snapshot();
      st.labels = st.labels.filter(l => l.fig !== id); st.figures.splice(i, 1); delete st.figLabels[id];
      await rebuild(false); drawAll(); return;
    }
    if (a === 'up' || a === 'dn') {
      const j = a === 'up' ? i - 1 : i + 1; if (j < 0 || j >= st.figures.length) return;
      snapshot();
      [st.figures[i], st.figures[j]] = [st.figures[j], st.figures[i]];
      const nums = st.figures.map(f => f.num);
      [st.figures[i].num, st.figures[j].num] = [nums[j], nums[i]];
      await rebuild(false); return;
    }
    if (e.target.tagName !== 'INPUT') { sel = { kind: 'fig', id }; renderLists(); drawAll(); }
  });
  $('figlist').addEventListener('change', e => {
    const tr = e.target.closest('tr'), f = figById(+tr.dataset.id);
    snapshot(); f.num = e.target.value.trim(); if (st.figLabels[f.id]) st.figLabels[f.id].pinned = st.figLabels[f.id].pinned; drawAll();
  });
  $('partlist').addEventListener('click', e => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const id = +tr.dataset.id;
    if (e.target.dataset.a === 'del') {
      const n = st.labels.filter(l => l.part === id).length;
      if (n && !confirm(`Remove this part and its ${n} label${n > 1 ? 's' : ''}?`)) return;
      snapshot();
      st.parts = st.parts.filter(p => p.id !== id); st.labels = st.labels.filter(l => l.part !== id);
      if (activePart === id) activePart = null;
      renderLists(); drawAll(); return;
    }
    activePart = activePart === id && e.target.tagName !== 'INPUT' ? null : id;
    if (mode !== 'labels') setMode('labels');
    renderLists(); drawAll();
    if (e.target.tagName === 'INPUT') { const k = e.target.dataset.k; const inp = $('partlist').querySelector(`tr[data-id="${id}"] input[data-k="${k}"]`); if (inp) inp.focus(); }
  });
  $('partlist').addEventListener('change', e => {
    const tr = e.target.closest('tr'), p = partById(+tr.dataset.id); snapshot();
    if (e.target.dataset.k === 'n') renameNumeral(p, e.target.value.trim()); else p.name = e.target.value.trim();
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
    if (n) { $('partsin').value = ''; if (!activePart) activePart = st.parts[st.parts.length - n].id; }
    renderLists(); drawAll();
  };
  $('renumber').onclick = () => {
    if (!st.parts.length) return;
    snapshot();
    st.parts.forEach((p, i) => renameNumeral(p, String(10 + 2 * i)));
    renderLists(); drawAll();
  };
  $('ltext').addEventListener('change', () => {
    const l = sel && st.labels.find(x => x.id === sel.id); if (!l) return;
    snapshot();
    const v = $('ltext').value.trim(), p = partById(l.part);
    l.text = !v || v === p.n ? null : v;
    if (l.pos) { const [w, h] = measure(labelText(l), false, st.opts.fs); l.pos.box = [l.pos.box[0], l.pos.box[3] - h, l.pos.box[0] + w, l.pos.box[3]]; l.pos.end = E.edgePoint(l.pos.tip, l.pos.box, 1.8); }
    drawAll();
  });
  $('lpin').addEventListener('change', () => {
    const l = sel && st.labels.find(x => x.id === sel.id); if (!l) return;
    snapshot(); l.pinned = $('lpin').checked; drawAll();
  });

  // ---------------------------------------------------------------- surfaces & drawing
  function buildSurfaces() {
    const host = $('sheets'); host.innerHTML = ''; surfaces = [];
    $('empty').style.display = doc ? 'none' : '';
    if (!doc) return;
    const list = mode === 'figs' ? doc.pages.map((p, i) => ({ kind: 'page', ref: p, idx: i, w: p.w, h: p.h }))
                                 : sheets.map(sh => ({ kind: 'sheet', ref: sh, idx: sh.idx, w: sh.w, h: sh.h }));
    for (const s of list) {
      const box = document.createElement('div'); box.className = 'sheetbox';
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
    zoomPt = Math.max(0.3, Math.min(2.5, vw / maxW)); applyZoom();
  }
  function drawAll() { for (const s of surfaces) draw(s); }

  function draw(s) {
    const ctx = s.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(s.kind === 'page' ? s.ref.canvas : s.ref.canvas, 0, 0);
    ctx.setTransform(S, 0, 0, S, 0, 0);
    const tol = 1 / zoomPt;
    // the sight area (37 CFR 1.84 margins)
    ctx.strokeStyle = 'rgba(158,27,50,.25)'; ctx.setLineDash([6 * tol, 4 * tol]); ctx.lineWidth = tol;
    ctx.strokeRect(MARGIN.l, MARGIN.t, s.w - MARGIN.l - MARGIN.r, s.h - MARGIN.t - MARGIN.b);
    ctx.setLineDash([]);
    if (s.kind === 'page') return drawFigBoxes(s, tol);
    const sh = s.ref, accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#9E1B32';
    ctx.textBaseline = 'alphabetic';
    for (const l of labelsOn(sh)) {
      const isSel = sel && sel.kind === 'label' && sel.id === l.id, isAct = l.part === activePart;
      const g = sh.figs.find(x => x.fig === l.fig);
      if (!l.pos) {
        const t = T(g, l.tip);
        ctx.strokeStyle = '#B0342B'; ctx.lineWidth = 1.5 * tol;
        ctx.beginPath(); ctx.moveTo(t[0] - 4 * tol, t[1] - 4 * tol); ctx.lineTo(t[0] + 4 * tol, t[1] + 4 * tol); ctx.moveTo(t[0] + 4 * tol, t[1] - 4 * tol); ctx.lineTo(t[0] - 4 * tol, t[1] + 4 * tol); ctx.stroke();
        ctx.fillStyle = '#B0342B'; ctx.font = `${st.opts.fs}px AlzSans, Helvetica, Arial, sans-serif`; ctx.fillText(labelText(l) + '?', t[0] + 6 * tol, t[1] - 6 * tol);
        continue;
      }
      const { box, tip, end } = l.pos;
      if (isSel || isAct) { ctx.fillStyle = isSel ? 'rgba(201,162,39,.35)' : 'rgba(201,162,39,.18)'; ctx.fillRect(box[0] - 2, box[1] - 2, box[2] - box[0] + 4, box[3] - box[1] + 4); }
      ctx.strokeStyle = '#000'; ctx.lineWidth = LINE_W;
      ctx.beginPath(); ctx.moveTo(tip[0], tip[1]); ctx.lineTo(end[0], end[1]); ctx.stroke();
      ctx.fillStyle = '#000'; ctx.font = `${st.opts.fs}px AlzSans, Helvetica, Arial, sans-serif`;
      ctx.fillText(labelText(l), box[0], box[3]);
      if (l.pos.cross) { ctx.fillStyle = '#E08A00'; ctx.beginPath(); ctx.arc(box[2] + 3, box[1], 2.2, 0, 7); ctx.fill(); }
      if (isSel) {
        ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(tip[0], tip[1], 3.2 * tol * 1.4, 0, 7); ctx.fill();
        for (const a of l.alts || []) { const t = T(g, a); ctx.strokeStyle = accent; ctx.lineWidth = tol; ctx.beginPath(); ctx.arc(t[0], t[1], 3 * tol, 0, 7); ctx.stroke(); }
      }
      if (l.pinned) { ctx.fillStyle = accent; ctx.fillRect(box[0] - 3, box[3] + 1.5, 2, 2); }
    }
    if (st.opts.figlabels) for (const g of sh.figs) {
      const fl = st.figLabels[g.fig], f = figById(g.fig); if (!fl || !fl.box || !f) continue;
      if (sel && sel.kind === 'figlabel' && sel.id === g.fig) { ctx.fillStyle = 'rgba(201,162,39,.35)'; ctx.fillRect(fl.box[0] - 2, fl.box[1] - 2, fl.box[2] - fl.box[0] + 4, fl.box[3] - fl.box[1] + 4); }
      ctx.fillStyle = '#000'; ctx.font = `bold ${st.opts.figfs}px AlzSans, Helvetica, Arial, sans-serif`;
      ctx.fillText(figLabelText(f), fl.box[0], fl.box[3]);
    }
    const sn = sheetNumBox(sh);
    if (sn) { ctx.fillStyle = '#000'; ctx.font = `${SHEETNUM_FS}px AlzSans, Helvetica, Arial, sans-serif`; ctx.fillText(sn.text, sn.box[0], sn.box[3]); }
  }
  function drawFigBoxes(s, tol) {
    const ctx = s.ctx, accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#9E1B32';
    for (const f of st.figures.filter(f => f.page === s.idx)) {
      const b = f.box, isSel = sel && sel.kind === 'fig' && sel.id === f.id;
      ctx.strokeStyle = accent; ctx.lineWidth = (isSel ? 2.2 : 1.2) * tol;
      ctx.fillStyle = isSel ? 'rgba(201,162,39,.10)' : 'rgba(158,27,50,.04)';
      ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      const tag = 'FIG. ' + f.num;
      ctx.font = `600 ${12 * tol}px Lexend, Arial, sans-serif`;
      const w = ctx.measureText(tag).width + 10 * tol;
      ctx.fillStyle = accent; ctx.fillRect(b[0], b[1] - 17 * tol, w, 17 * tol);
      ctx.fillStyle = '#fff'; ctx.fillText(tag, b[0] + 5 * tol, b[1] - 5 * tol);
      if (isSel) { ctx.fillStyle = accent; for (const [x, y] of corners(b)) ctx.fillRect(x - 4 * tol, y - 4 * tol, 8 * tol, 8 * tol); }
    }
  }
  const corners = b => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];

  // ---------------------------------------------------------------- pointer
  function bindPointer(s) {
    const c = s.canvas;
    const at = e => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * s.w, (e.clientY - r.top) / r.height * s.h]; };
    let drag = null;
    c.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const p = at(e), tol = 7 / zoomPt;
      drag = s.kind === 'page' ? figDown(s, p, tol, e) : labelDown(s, p, tol, e);
      if (drag) { c.setPointerCapture(e.pointerId); drag.start = p; drag.moved = false; }
    });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = at(e), dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
      if (!drag.moved && Math.hypot(dx, dy) * zoomPt < 3) return;
      if (!drag.moved) { snapshot(); drag.moved = true; }
      drag.move(p, dx, dy); draw(s);
    });
    const up = e => {
      if (!drag) return;
      const p = at(e), d = drag; drag = null;
      if (d.moved && d.end) d.end(p); else if (!d.moved && d.click) d.click(p);
      renderLists(); drawAll();
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  }
  const inBox = (p, b, pad) => p[0] >= b[0] - pad && p[0] <= b[2] + pad && p[1] >= b[1] - pad && p[1] <= b[3] + pad;

  function figDown(s, p, tol, e) {
    const figs = st.figures.filter(f => f.page === s.idx);
    const cur = sel && sel.kind === 'fig' && figs.find(f => f.id === sel.id);
    if (cur) {
      const ci = corners(cur.box).findIndex(([x, y]) => Math.abs(x - p[0]) < tol * 1.3 && Math.abs(y - p[1]) < tol * 1.3);
      if (ci >= 0) {
        const b0 = cur.box.slice();
        return { move: q => { const b = b0.slice(); if (ci === 0 || ci === 3) b[0] = q[0]; else b[2] = q[0]; if (ci < 2) b[1] = q[1]; else b[3] = q[1];
                               cur.box = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])]; },
                 end: () => afterFigChange() };
      }
    }
    const hit = figs.slice().reverse().find(f => inBox(p, f.box, 0));
    if (hit) {
      sel = { kind: 'fig', id: hit.id }; renderLists(); drawAll();
      const b0 = hit.box.slice();
      return { move: (q, dx, dy) => { hit.box = [b0[0] + dx, b0[1] + dy, b0[2] + dx, b0[3] + dy]; }, end: () => afterFigChange() };
    }
    sel = null; renderLists(); drawAll();
    let nf = null;
    return {
      move: (q) => {
        if (!nf) { nf = { id: nid(), page: s.idx, box: [p[0], p[1], p[0], p[1]], num: '' }; st.figures.push(nf); sel = { kind: 'fig', id: nf.id }; }
        nf.box = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
      },
      end: () => {
        if (!nf) return;
        if (nf.box[2] - nf.box[0] < 20 || nf.box[3] - nf.box[1] < 20) { st.figures = st.figures.filter(f => f !== nf); sel = null; return; }
        // a box drawn around several found figures (an exploded view) replaces them
        const inside = f => f !== nf && f.page === nf.page && overlap(f.box, nf.box) > 0.8 &&
          (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]) < (nf.box[2] - nf.box[0]) * (nf.box[3] - nf.box[1]);
        const gone = st.figures.filter(inside);
        if (gone.length) {
          for (const l of st.labels) if (gone.some(g => g.id === l.fig)) l.fig = nf.id;
          st.figures = st.figures.filter(f => !inside(f));
          for (const g of gone) delete st.figLabels[g.id];
        }
        // keep FIG order: by sheet, then top-to-bottom
        st.figures.sort((a, b) => a.page - b.page || (a === nf || b === nf ? a.box[1] - b.box[1] : 0));
        renumberFigures();
        afterFigChange();
      },
    };
  }
  async function afterFigChange() {
    // tips stay put on the source page; positions on an enlarged sheet no longer fit
    for (const l of st.labels) { const f = figById(l.fig); if (f && st.opts.layout === 'split') { l.pos = null; l.pinned = false; } }
    await rebuild(false);
    if (mode === 'figs') drawAll();
  }

  function labelDown(s, p, tol, e) {
    const sh = s.ref, mine = labelsOn(sh);
    const selL = sel && sel.kind === 'label' && mine.find(l => l.id === sel.id);
    // 1. the tip of the selected label
    if (selL && selL.pos && Math.hypot(p[0] - selL.pos.tip[0], p[1] - selL.pos.tip[1]) < tol * 1.2 && !e.shiftKey) {
      const l = selL;
      return {
        move: q => { l.pos.tip = q; l.pos.end = E.edgePoint(q, l.pos.box, 1.8); },
        end: q => {
          const eng = engineFor(sh), sp = eng.snap(q[0] * S, q[1] * S, Math.round(10 * S));
          const tp = sp ? pt(sp) : q, g = sh.figs.find(x => x.fig === l.fig);
          l.tip = Ti(g, tp); l.alts = []; l.pos.tip = tp; l.pos.end = E.edgePoint(tp, l.pos.box, 1.8);
          l.pos.cross = eng.crossings(px(l.pos.tip), px(l.pos.end))[0];
        },
      };
    }
    // 2. a numeral
    const hit = mine.slice().reverse().find(l => l.pos && inBox(p, l.pos.box, 3));
    if (hit && !e.shiftKey) {
      sel = { kind: 'label', id: hit.id }; activePart = hit.part; renderLists(); drawAll();
      const b0 = hit.pos.box.slice();
      return {
        move: (q, dx, dy) => { hit.pos.box = [b0[0] + dx, b0[1] + dy, b0[2] + dx, b0[3] + dy]; hit.pos.end = E.edgePoint(hit.pos.tip, hit.pos.box, 1.8); },
        end: () => { hit.pinned = true; hit.pos.cross = engineFor(sh).crossings(px(hit.pos.tip), px(hit.pos.end))[0]; },
      };
    }
    // 3. a FIG. label
    if (st.opts.figlabels) for (const g of sh.figs) {
      const fl = st.figLabels[g.fig];
      if (fl && fl.box && inBox(p, fl.box, 3)) {
        sel = { kind: 'figlabel', id: g.fig }; renderLists(); drawAll();
        const b0 = fl.box.slice();
        return { move: (q, dx, dy) => { fl.box = [b0[0] + dx, b0[1] + dy, b0[2] + dx, b0[3] + dy]; }, end: () => { fl.pinned = true; } };
      }
    }
    // 4. shift-click: another spot the selected label may point to
    if (e.shiftKey && selL) {
      return { click: q => {
        snapshot();
        const g = sh.figs.find(x => x.fig === selL.fig), sp = engineFor(sh).snap(q[0] * S, q[1] * S);
        if (!sp) { status('No line there to point at.', 'warn'); return; }
        selL.alts = (selL.alts || []).concat([Ti(g, pt(sp))]);
        selL.pinned = false; placeOne(selL); status('');
      } };
    }
    // 5. a new label for the active part
    return { click: q => {
      if (!activePart) { sel = null; return; }
      const g = sh.figs.find(x => inBox(q, sheetRect(x), 0)) ||
                sh.figs.slice().sort((a, b) => dist(q, sheetRect(a)) - dist(q, sheetRect(b)))[0];
      let gg = g;
      if (!gg) {       // a sheet with no figure on it: treat the whole sheet as one
        if (st.opts.layout !== 'keep') return;
        const f = { id: nid(), page: sh.page, box: [0, 0, sh.w, sh.h], num: String(st.figures.length + 1) };
        snapshot(); st.figures.push(f); rebuild(false).then(() => status('Added a figure for that sheet; click again.'));
        return;
      }
      const sp = engineFor(sh).snap(q[0] * S, q[1] * S);
      if (!sp) { status('Click on a line of the part (nothing to point at there).', 'warn'); return; }
      snapshot();
      const l = { id: nid(), part: activePart, text: null, fig: gg.fig, tip: Ti(gg, pt(sp)), alts: [], pos: null, pinned: false };
      st.labels.push(l); placeOne(l); sel = { kind: 'label', id: l.id }; status(l.pos ? '' : 'No clear room for that numeral: drag it somewhere, or remove it.', l.pos ? '' : 'warn');
    } };
  }
  const dist = (p, b) => Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[2]), Math.max(b[1] - p[1], 0, p[1] - b[3]));

  document.addEventListener('keydown', async e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); await undo(); return; }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      e.preventDefault(); snapshot();
      if (sel.kind === 'label') st.labels = st.labels.filter(l => l.id !== sel.id);
      else if (sel.kind === 'fig') { const id = sel.id; st.labels = st.labels.filter(l => l.fig !== id); st.figures = st.figures.filter(f => f.id !== id); delete st.figLabels[id]; sel = null; await rebuild(false); return; }
      else if (sel.kind === 'figlabel') { delete st.figLabels[sel.id]; }
      sel = null; renderLists(); drawAll();
    }
    if (e.key === 'Escape') { sel = null; activePart = null; renderLists(); drawAll(); }
  });

  // ---------------------------------------------------------------- open / options
  async function openFile(f) {
    status('Opening ' + f.name + '…');
    try {
      await fontsReady;
      const bytes = new Uint8Array(await f.arrayBuffer());
      let d;
      if (/pdf/i.test(f.type) || /\.pdf$/i.test(f.name)) {
        const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
        const pages = [];
        for (let i = 1; i <= pdf.numPages; i++) { const pj = await pdf.getPage(i); const vp = pj.getViewport({ scale: 1 }); pages.push({ w: vp.width, h: vp.height, pj }); }
        d = { name: f.name, kind: 'pdf', bytes, pages };
      } else {
        const img = await loadImage(URL.createObjectURL(f));
        const k = 72 / 200;                       // scans are usually 200 dpi
        d = { name: f.name, kind: 'image', bytes, mime: f.type, pages: [{ w: img.naturalWidth * k, h: img.naturalHeight * k, img }] };
      }
      doc = d;
      $('fname').textContent = `${f.name} · ${d.pages.length} sheet${d.pages.length > 1 ? 's' : ''}`;
      for (const p of doc.pages) await renderSource(p);
      undoStack.length = 0; sel = null; activePart = null;
      if (pendingProject && pendingProject.file && pendingProject.file.pages === doc.pages.length) {
        st = pendingProject.state; pendingProject = null; status('Project restored.');
      } else {
        const keepParts = st.parts;
        st = freshState(); st.parts = keepParts.map(p => ({ ...p })); st.nextId = 1 + Math.max(0, ...st.parts.map(p => p.id));
        if (doc.kind === 'image' || !doc.pages.every(p => isPaper(p))) st.opts.layout = 'split';
        findAllFigures();
        status('');
      }
      syncOptsToUI();
      await rebuild(false);
      fitWidth();
      if (st.labels.length && !st.labels.some(l => l.pos)) await placeAll();
    } catch (err) {
      console.error(err); status('Could not open that file: ' + err.message, 'bad');
    }
  }
  const isPaper = p => Object.values(PAPER).some(([w, h]) => (Math.abs(p.w - w) < 8 && Math.abs(p.h - h) < 8) || (Math.abs(p.w - h) < 8 && Math.abs(p.h - w) < 8));

  function syncOptsToUI() {
    $('layout').value = st.opts.layout; $('paper').value = st.opts.paper;
    $('sheetnums').checked = st.opts.sheetnums; $('figlabels').checked = st.opts.figlabels; $('fs').value = st.opts.fs;
  }
  $('layout').onchange = async () => { snapshot(); st.opts.layout = $('layout').value; if (st.opts.layout === 'split' && !st.opts.sheetnums) { st.opts.sheetnums = true; $('sheetnums').checked = true; } await rebuild(true); fitWidth(); await placeAll(); };
  $('paper').onchange = async () => { snapshot(); st.opts.paper = $('paper').value; if (st.opts.layout === 'split') { await rebuild(true); await placeAll(); } };
  $('sheetnums').onchange = async () => { snapshot(); st.opts.sheetnums = $('sheetnums').checked; if (st.opts.layout === 'split') await rebuild(true), await placeAll(); else drawAll(); };
  $('figlabels').onchange = () => { snapshot(); st.opts.figlabels = $('figlabels').checked; if (st.opts.figlabels) placeAll(); else drawAll(); };
  $('fs').onchange = () => { snapshot(); st.opts.fs = Math.max(10, Math.min(24, +$('fs').value || 14)); for (const l of st.labels) l.pinned = false; placeAll(); };
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
    status(dropped ? `Left out ${dropped} crowded repeat${dropped > 1 ? 's' : ''} (Ctrl+Z brings them back).` : 'Nothing to leave out.');
  };
  $('refind').onclick = async () => {
    if (!doc) return;
    if (st.labels.length && !confirm('Finding the figures again removes the labels placed so far. Go ahead?')) return;
    snapshot(); st.labels = []; st.figLabels = {}; findAllFigures(); await rebuild(false);
  };

  const drop = $('drop'), fileIn = $('file');
  drop.onclick = () => fileIn.click();
  drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') fileIn.click(); };
  fileIn.onchange = () => { if (fileIn.files[0]) openFile(fileIn.files[0]); fileIn.value = ''; };
  for (const el of [drop, $('view')]) {
    el.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    el.addEventListener('dragleave', () => drop.classList.remove('over'));
    el.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) openFile(f); });
  }
  function setMode(m) {
    mode = m;
    for (const b of $('modes').children) b.classList.toggle('on', b.dataset.m === m);
    buildSurfaces();
  }
  $('modes').onclick = e => { const m = e.target.dataset.m; if (m && m !== mode) setMode(m); };
  $('zin').onclick = () => { zoomPt = Math.min(4, zoomPt * 1.2); applyZoom(); };
  $('zout').onclick = () => { zoomPt = Math.max(0.3, zoomPt / 1.2); applyZoom(); };
  $('zfit').onclick = fitWidth;

  // ---------------------------------------------------------------- exports
  function need() { if (!doc) { status('Open a drawing first.', 'warn'); return false; } return true; }

  async function exportPdf() {
    if (!need()) return;
    status('Writing the PDF…');
    const { PDFDocument, rgb, degrees } = PDFLib;
    await fontsReady;
    const out = await PDFDocument.create();
    out.registerFontkit(window.fontkit);
    const f = await out.embedFont(fontBytes[0], { subset: true }), fb = await out.embedFont(fontBytes[1], { subset: true });
    const cache = new Map();
    const src = doc.kind === 'pdf' ? await PDFDocument.load(doc.bytes, { ignoreEncryption: true }) : null;
    const black = rgb(0, 0, 0);
    for (const sh of sheets) {
      const pg = out.addPage([sh.w, sh.h]);
      const regions = sh.page != null
        ? [{ page: sh.page, clip: [0, 0, doc.pages[sh.page].w, doc.pages[sh.page].h], dest: [0, 0, sh.w, sh.h] }]
        : sh.figs.map(g => ({ page: g.page, clip: g.clip, dest: sheetRect(g) }));
      for (const r of regions) await drawRegion(out, pg, src, r, sh.h, degrees, cache);
      for (const l of labelsOn(sh)) if (l.pos) {
        const { tip, end, box } = l.pos;
        pg.drawLine({ start: { x: tip[0], y: sh.h - tip[1] }, end: { x: end[0], y: sh.h - end[1] }, thickness: LINE_W, color: black });
        pg.drawText(labelText(l), { x: box[0], y: sh.h - box[3], size: st.opts.fs, font: f, color: black });
      }
      if (st.opts.figlabels) for (const g of sh.figs) {
        const fl = st.figLabels[g.fig], fig = figById(g.fig);
        if (fl && fl.box) pg.drawText(figLabelText(fig), { x: fl.box[0], y: sh.h - fl.box[3], size: st.opts.figfs, font: fb, color: black });
      }
      const sn = sheetNumBox(sh);
      if (sn) pg.drawText(sn.text, { x: sn.box[0], y: sh.h - sn.box[3], size: SHEETNUM_FS, font: f, color: black });
    }
    out.setTitle(baseName() + ' (labeled)'); out.setCreator('Alizarin patent drawing labeler'); out.setProducer('pdf-lib');
    download(await out.save(), baseName() + '-labeled.pdf', 'application/pdf');
    status('PDF downloaded.' + unplacedNote());
  }
  function unplacedNote() {
    const n = st.labels.filter(l => !l.pos).length;
    return n ? ` ${n} label${n > 1 ? 's' : ''} had no room and ${n > 1 ? 'are' : 'is'} left out.` : '';
  }

  // One piece of a source page, kept as vectors for PDFs. Each source page is embedded
  // once (so a sheet's scanned image is not copied per figure) and clipped to the piece.
  async function drawRegion(out, pg, src, r, sheetH, degrees, cache) {
    const P = doc.pages[r.page], cw = r.clip[2] - r.clip[0], ch = r.clip[3] - r.clip[1];
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
    const I = v => v / 72;
    for (const sh of sheets) {
      const slide = pptx.addSlide();
      const c = await paintSheet(sh, 300 / 72);
      slide.addImage({ data: c.toDataURL('image/png'), x: 0, y: 0, w: I(sh.w), h: I(sh.h) });
      const text = (t, box, size, bold) => slide.addText(t, {
        x: I(box[0] - size * 0.1), y: I(box[3] - size * 0.93), w: I(box[2] - box[0] + size * 0.4), h: I(size * 1.2),
        fontFace: 'Arial', fontSize: size, bold: !!bold, color: '000000', margin: 0, valign: 'top', fit: 'none', wrap: false,
      });
      for (const l of labelsOn(sh)) if (l.pos) {
        const { tip, end, box } = l.pos;
        slide.addShape(pptx.ShapeType.line, {
          x: I(Math.min(tip[0], end[0])), y: I(Math.min(tip[1], end[1])),
          w: I(Math.abs(end[0] - tip[0]) || 0.01), h: I(Math.abs(end[1] - tip[1]) || 0.01),
          flipH: (end[0] - tip[0]) * (end[1] - tip[1]) < 0, line: { color: '000000', width: LINE_W },
        });
        text(labelText(l), box, st.opts.fs);
      }
      if (st.opts.figlabels) for (const g of sh.figs) { const fl = st.figLabels[g.fig]; if (fl && fl.box) text(figLabelText(figById(g.fig)), fl.box, st.opts.figfs, true); }
      const sn = sheetNumBox(sh); if (sn) text(sn.text, sn.box, SHEETNUM_FS);
    }
    const blob = await pptx.write({ outputType: 'blob' });
    download(blob, baseName() + '-labeled.pptx');
    status('PowerPoint downloaded: the drawing is a picture, the numerals and leaders are editable.' + unplacedNote());
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
      rows.map(r => `<w:tr>${cell(r.n, widths[0])}${cell(r.name, widths[1])}${cell(figsText(r.figs), widths[2])}</w:tr>`).join('') + '</w:tbl>';
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const z = new JSZip();
    z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    z.file('word/document.xml', docXml);
    download(await z.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), baseName() + '-parts.docx');
  }
  $('expdf').onclick = () => exportPdf().catch(err => { console.error(err); status('PDF failed: ' + err.message, 'bad'); });
  $('expptx').onclick = () => exportPptx().catch(err => { console.error(err); status('PowerPoint failed: ' + err.message, 'bad'); });
  $('exdocx').onclick = () => exportDocx().catch(err => { console.error(err); status('Word file failed: ' + err.message, 'bad'); });
  $('extxt').onclick = exportTxt;
  $('excsv').onclick = exportCsv;

  // ---------------------------------------------------------------- project files
  $('save').onclick = () => {
    const proj = { app: 'alizarin', version: 1, file: doc ? { name: doc.name, pages: doc.pages.length } : null, state: st };
    download(JSON.stringify(proj, null, 1), baseName() + '-labels.json', 'application/json');
  };
  $('load').onclick = () => $('loadfile').click();
  $('loadfile').onchange = async () => {
    const f = $('loadfile').files[0]; $('loadfile').value = ''; if (!f) return;
    try {
      const proj = JSON.parse(await f.text());
      if (proj.app !== 'alizarin' || !proj.state) throw new Error('not an Alizarin project file');
      if (doc && proj.file && proj.file.pages === doc.pages.length) {
        snapshot(); st = proj.state; syncOptsToUI(); await rebuild(false); status('Project opened.');
      } else {
        pendingProject = proj;
        status(`Now open the drawing${proj.file ? ' (' + proj.file.name + ')' : ''} and the labels come back.`);
      }
    } catch (err) { status('Could not read that project: ' + err.message, 'bad'); }
  };

  // ---------------------------------------------------------------- Claude
  async function gridImages() {
    if (!need()) return;
    status('Drawing the grids…');
    const z = new JSZip();
    for (let i = 0; i < doc.pages.length; i++) {
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
      const blob = await new Promise(ok => c.toBlob(ok, 'image/png'));
      z.file(`sheet-${i + 1}.png`, blob);
    }
    download(await z.generateAsync({ type: 'blob' }), baseName() + '-sheets-with-grid.zip');
    status('Give Claude these images (unzip first) along with the prompt.');
  }
  function claudePrompt() {
    const figs = doc ? st.figures.map(f => {
      const P = doc.pages[f.page], b = f.box;
      return `  FIG. ${f.num}: sheet ${f.page + 1}, box ${[b[0] / P.w, b[1] / P.h, b[2] / P.w, b[3] / P.h].map(v => Math.round(v * 100)).join(', ')}`;
    }).join('\n') : '';
    const parts = st.parts.map(p => `  ${p.n} ${p.name}`).join('\n');
    return `I am preparing the drawings for a patent application and need reference numerals added. The attached images are the drawing sheets, one per sheet${doc ? ` (${doc.pages.length} in all)` : ''}, with a blue grid: the numbers along the edges are percent of the sheet's width (left to right) and height (top to bottom).

Please:
1. Identify each separate figure (view)${figs ? '. These are the figures I have; keep their numbers unless they are wrong:\n' + figs : ', numbered FIG. 1, FIG. 2 … in reading order (or as already numbered on the sheets).'}
2. List the parts and features the specification will refer to. ${parts ? 'Use these numerals and names, and add any part that is missing:\n' + parts + '\n' : 'Give each one a reference numeral: even numbers from 10 upward (10, 12, 14 …), in order of importance, the same numeral for the same part in every figure.'} Use letter suffixes (26a, 26b) only for identical parts that the text must tell apart.
3. For every figure in which a part is visible, give a point that lies exactly ON a drawn line of that part (never in empty space or inside a hollow outline), as [x, y] in grid percent with one decimal. If the part is easy to hit in more than one place, give up to four points; the first is the preferred one. Skip a part in a figure where it cannot be seen.

Answer with only this JSON, nothing else:
{
  "figures": [{"fig": "1", "sheet": 1, "box": [x0, y0, x1, y1]}],
  "parts":   [{"n": "10", "name": "frame"}],
  "labels":  [{"fig": "1", "n": "10", "at": [[x, y], [x, y]]}]
}
("box" is the figure's extent in grid percent: left, top, right, bottom.)`;
  }
  $('prompt').onclick = async () => {
    const t = claudePrompt();
    try { await navigator.clipboard.writeText(t); status('Prompt copied. Paste it into Claude together with the gridded sheet images.'); }
    catch (e) { $('pastebox').value = t; $('pastemodal').classList.add('on'); $('pastestatus').textContent = 'Copy the prompt from the box (the clipboard was not available).'; }
  };
  $('paste').onclick = () => { $('pastebox').value = ''; $('pastestatus').textContent = ''; $('pastemodal').classList.add('on'); $('pastebox').focus(); };
  $('pastecancel').onclick = () => $('pastemodal').classList.remove('on');
  $('pasteok').onclick = async () => {
    try {
      const n = await importClaude($('pastebox').value, $('pastereplace').checked);
      $('pastemodal').classList.remove('on');
      status(`Imported ${n} labels. Check each leader: drag the dot to fix a tip.`);
    } catch (err) { console.error(err); $('pastestatus').textContent = 'Could not read that: ' + err.message; }
  };

  function parseJsonLoose(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('no JSON found');
    return JSON.parse(text.slice(a, b + 1).replace(/,\s*([\]}])/g, '$1'));
  }
  async function importClaude(text, replace) {
    if (!need()) throw new Error('open the drawing first');
    const j = parseJsonLoose(text);
    const pts = v => (Array.isArray(v) && typeof v[0] === 'number' ? [v] : (v || [])).filter(q => Array.isArray(q) && q.length >= 2);
    let frac = 1;
    const all = [].concat(...(j.labels || []).map(l => pts(l.at)), ...(j.figures || []).map(f => [f.box || []]));
    if (all.length && all.every(q => q.every(v => v <= 1.0001))) frac = 100;       // fractions instead of percent
    const toPt = (page, q) => { const P = doc.pages[page]; return [q[0] * frac / 100 * P.w, q[1] * frac / 100 * P.h]; };
    snapshot();
    if (replace) { st.labels = []; st.figLabels = {}; }
    if (Array.isArray(j.figures) && j.figures.length) {
      const nf = [];
      for (const f of j.figures) {
        const page = Math.max(0, Math.min(doc.pages.length - 1, (+(f.sheet || f.page) || 1) - 1));
        if (!Array.isArray(f.box) || f.box.length < 4) continue;
        const a = toPt(page, [f.box[0], f.box[1]]), b = toPt(page, [f.box[2], f.box[3]]);
        const old = st.figures.find(o => o.page === page && o.num === String(f.fig));
        nf.push({ id: old && !nf.some(x => x.id === old.id) ? old.id : nid(), page, num: String(f.fig), box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
      }
      if (nf.length) {
        // keep our own (tighter) box where Claude's roughly matches it
        for (const f of nf) {
          const o = st.figures.find(o => o.page === f.page && overlap(o.box, f.box) > 0.5);
          if (o) f.box = o.box.slice();
        }
        st.labels = st.labels.filter(l => nf.some(f => f.id === l.fig));
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
        const sp = eng.snap(s[0], s[1], Math.round(12 * S)) || s;
        tips.push(Ti(g, pt(sp)));
      }
      if (!tips.length) continue;
      st.labels.push({ id: nid(), part: part.id, text: n === part.n ? null : n, fig: f.id, tip: tips[0], alts: tips.slice(1), pos: null, pinned: false });
      count++;
    }
    renderLists();
    await placeAll();
    setMode('labels');
    return count;
  }
  function overlap(a, b) {
    const ov = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    return ov / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  }
  $('gridimgs').onclick = () => gridImages().catch(err => status('Failed: ' + err.message, 'bad'));

  // The sample: a flashlight drawing and the answer Claude gave for it.
  async function demo() {
    const b = await fetch('examples/flashlight.pdf').then(r => r.blob());
    await openFile(new File([b], 'flashlight.pdf', { type: 'application/pdf' }));
    const n = await importClaude(await fetch('examples/flashlight-claude.json').then(r => r.text()), true);
    status(`Sample loaded: ${n} labels placed from Claude's answer (examples/flashlight-claude.json). Drag any numeral to try it.`);
  }
  $('demo').onclick = () => demo().catch(err => status('Could not load the sample: ' + err.message, 'bad'));
  if (/[?&]demo\b/.test(location.search)) demo();

  window.addEventListener('resize', () => { if (surfaces.length) fitWidth(); });
  window.__alizarin = { get st() { return st; }, get sheets() { return sheets; }, importClaude, placeAll, openFile };
})();
