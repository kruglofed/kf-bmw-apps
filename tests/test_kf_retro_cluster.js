'use strict';
// node tests/test_kf_retro_cluster.js - поиск изменившихся мест для вывода на приборы (apps/kf_retro/cluster.js)
const assert = require('assert');
const path = require('path');
const Module = require('module');
// cluster.js берёт рисование из ./kit (в сборке); здесь - из kit/runtime
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent) {
    if (req.indexOf('./kit/') === 0) req = path.join(__dirname, '..', 'kit', 'runtime', req.slice(6));
    return orig.call(this, req, parent, ...Array.prototype.slice.call(arguments, 2));
};
const { dirtyRects, packRects } = require('../apps/kf_retro/cluster');

function img(w, h) { return Buffer.alloc(w * h * 4); }
function dot(b, w, x, y) { b[(y * w + x) * 4 + 3] = 255; }
const cover = (rects, x, y) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

for (const w of [240, 1920, 100, 64, 65]) {
    const h = 231, a = img(w, h), b = img(w, h);
    assert.strictEqual(dirtyRects(a, b, w, h), null, 'ничего не изменилось');
    // изменение у правого края (ширина не кратна 64 - раньше терялось)
    dot(a, w, w - 1, 5); dot(a, w, 0, h - 1); dot(a, w, Math.floor(w / 2), 100);
    const r = dirtyRects(a, b, w, h);
    assert.ok(r && cover(r, w - 1, 5) && cover(r, 0, h - 1) && cover(r, Math.floor(w / 2), 100), 'все изменения найдены при ширине ' + w);
    r.forEach((q) => assert.ok(q.x >= 0 && q.y >= 0 && q.x + q.w <= w && q.y + q.h <= h, 'в пределах картинки'));
    const n = r.reduce((s, q) => s + q.w * q.h * 4, 0);
    assert.strictEqual(packRects(a, w, r).length, n, 'упаковано ровно столько байт');
}
console.log('kf_retro cluster: ok');
