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
console.log('ok');
