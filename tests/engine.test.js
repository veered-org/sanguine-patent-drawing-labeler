// node tests/engine.test.js
// A synthetic drawing (a box with a circle inside and a separate small square) to
// check that numerals land in clear space, inside the sight area, without collisions.
'use strict';
const assert = require('assert');
const E = require('../engine.js');

const S = 2, W = 612 * S, H = 792 * S;
const ink = new Uint8Array(W * H);
const set = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) ink[y * W + x] = 1; };
function rect(x0, y0, x1, y1) { for (let x = x0; x <= x1; x++) { set(x, y0); set(x, y1); } for (let y = y0; y <= y1; y++) { set(x0, y); set(x1, y); } }
function circle(cx, cy, r) { for (let a = 0; a < 3600; a++) { const t = a / 1800 * Math.PI; set(Math.round(cx + r * Math.cos(t)), Math.round(cy + r * Math.sin(t))); } }
rect(300, 300, 900, 800); circle(600, 550, 150); rect(500, 1100, 700, 1300);

const sight = [72 * S, 72 * S, (612 - 45) * S, (792 - 27) * S];
const sheet = new E.Sheet(ink, W, H, S, sight);
const measure = t => [t.length * 8 * S, 10 * S];

// snapping lands on ink
const tip = sheet.snap(603, 395);
assert(tip && ink[tip[1] * W + tip[0]], 'snap finds ink');

const items = [
  { key: 'a', text: '10', tips: [sheet.snap(300, 500)], center: [600, 550] },
  { key: 'b', text: '12', tips: [sheet.snap(600, 402)], center: [600, 550] },
  { key: 'c', text: '14', tips: [sheet.snap(900, 700)], center: [600, 550] },
  { key: 'd', text: '16', tips: [sheet.snap(600, 1100)], center: [600, 1200] },
  { key: 'e', text: '18', tips: [sheet.snap(750, 550)], center: [600, 550] },
];
const t0 = Date.now();
const res = sheet.place(items, measure);
console.log('placed in', Date.now() - t0, 'ms');
for (const it of items) {
  const r = res[it.key];
  assert(r, it.text + ' placed');
  const [x0, y0, x1, y1] = r.box;
  assert(x0 >= sight[0] && y0 >= sight[1] && x1 <= sight[2] && y1 <= sight[3], it.text + ' inside sight');
  let inkIn = 0;
  for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) inkIn += ink[y * W + x];
  assert.strictEqual(inkIn, 0, it.text + ' numeral on clear paper');
  console.log(it.text, r.box.map(Math.round).join(','), 'crossings', r.crossings);
}
const keys = Object.keys(res);
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
  const a = res[keys[i]], b = res[keys[j]];
  assert(!E.boxesTouch(a.box, b.box, 0), 'numerals apart');
  assert(!E.segInter(a.tip, a.end, b.tip, b.end), 'leaders do not cross');
}
// 18 points at the circle from inside the box: the leader must cross the box or circle
// line at most once, never twice.
assert(res.e.crossings <= 1, 'short way out');

const figs = E.findFigures(ink, W, H, S);
console.log('figures', figs.map(b => b.map(Math.round).join(',')));
assert.strictEqual(figs.length, 2, 'two separate drawings found');
assert(figs[0][1] < figs[1][1], 'reading order');

const fl = sheet.placeFigLabel(figs[1], [60 * S, 14 * S], Object.values(res));
assert(fl[1] > 1300, 'FIG. label under the figure');
assert.deepStrictEqual(E.splitNumeral('26a'), ['26', 'a']);
// a drawn caption: five letter-sized marks on one baseline, clear paper round them
assert.strictEqual(E.findCaptions(ink, W, H, S).length, 0, 'no caption on the drawing');
for (let i = 0; i < 5; i++) rect(520 + i * 24, 1400, 536 + i * 24, 1428);
const caps = E.findCaptions(ink, W, H, S);
assert.strictEqual(caps.length, 1, 'caption found');
assert(caps[0][1] >= 1400 && caps[0][3] <= 1430, 'caption box');
// grey, unevenly lit paper (a photographed sketch): the paper is not ink, the lines are
{
  const w = 400, h = 300, g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = 120 + Math.round(60 * x / w);
  for (let x = 50; x < 350; x++) g[150 * w + x] = g[151 * w + x] = 40 + Math.round(30 * x / w);
  const m = E.inkFromGray(g, w, h);
  let n = 0; for (const v of m) n += v;
  assert(m[150 * w + 200] && m[151 * w + 300], 'lines are ink');
  assert(n < 700, 'grey paper is not ink (' + n + ')');
}
// a caption no big drawing claims gathers the small drawing beside it
{
  const w = 1224, h = 1584, m = new Uint8Array(w * h);
  const put = (x, y) => { m[y * w + x] = 1; };
  const box = (x0, y0, x1, y1) => { for (let x = x0; x <= x1; x++) { put(x, y0); put(x, y1); } for (let y = y0; y <= y1; y++) { put(x0, y); put(x1, y); } };
  box(400, 200, 1000, 900);                       // the big figure
  box(300, 960, 340, 1040);                       // a small part below its left corner
  const caps = [[620, 960, 740, 990], [360, 1000, 480, 1030]];
  assert.strictEqual(E.findFigures(m, w, h, 2).length, 1, 'without captions the small part joins the big one');
  const figs2 = E.findFigures(m, w, h, 2, caps);
  assert.strictEqual(figs2.length, 2, 'its own caption makes the small part a figure');
}
// a leader that would cross a line bends round it when it can
{
  const w = 800, h = 800, m = new Uint8Array(w * h);
  for (let y = 100; y < 700; y++) m[y * w + 400] = 1;            // a long vertical line
  for (let x = 400; x < 700; x++) m[400 * w + x] = 1;            // a branch to the right
  const sh = new E.Sheet(m, w, h, 2, [20, 20, 780, 780]);
  const tip = sh.snap(560, 400), meas = t => [t.length * 16, 20];
  const straight = sh.place([{ key: 'a', text: '10', tips: [tip], center: [400, 400] }], meas, null, { straight: true }).a;
  const curved = sh.place([{ key: 'a', text: '10', tips: [tip], center: [400, 400] }], meas).a;
  assert(straight && curved, 'both placed');
  assert(curved.crossings <= straight.crossings, 'curves never cross more');
}
// stipple dots are not lines to a leader
{
  const w = 600, h = 600, m = new Uint8Array(w * h);
  for (let y = 200; y < 400; y += 6) for (let x = 200; x < 400; x += 6) m[y * w + x] = 1;
  const sh = new E.Sheet(m, w, h, 2, [0, 0, 600, 600]);
  assert.strictEqual(sh.crossings([300, 300], [500, 300])[0], 0, 'no lines crossed in stippling');
  assert(sh.clear.sum(290, 290, 310, 310) > 0, 'but the stippling is not clear paper');
}
console.log('ok');
