'use strict';
// node tests/test_kf_around.js - поиск данных окружения (apps/kf_around/scan.js)
const assert = require('assert');
const { scan, summary } = require('../apps/kf_around/scan');
const db = { interfaces: {
    'de.bmw.environmentalmodel.object.Object': { fields: { objectList: { dataRef: 'a.ObjectList', getter: { id: 0 }, notifier: { id: 1 } }, objectCount: { getter: { id: 2 } } } },
    'de.bmw.dass.pad.Pdc': { fields: { distances: { dataRef: 'a.Dist', notifier: { id: 3 } } } },
    'de.bmw.infotainment.vehicle.CDS': { fields: { statusEngineSpeed2: { getter: {}, notifier: {} } } },
} };
const f = scan(db);
assert.strictEqual(f.length, 3, 'обороты - мимо');
assert.ok(f[0].s && f[0].r && f[0].field === 'objectList', 'вживую и с чтением - первыми');
const s = summary(f);
assert.strictEqual(s.live, 2); assert.strictEqual(s.read, 2); assert.strictEqual(s.ifaces, 2);
console.log('kf_around scan: ok');
