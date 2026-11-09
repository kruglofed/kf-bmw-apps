'use strict';
// node tests/test_kf_prices.js - цена топлива по бакам (prices.js) и стоимость дня (logbook.fuelCost)
const assert = require('assert');
const { Prices } = require('../apps/kf_probeg/prices');
const { Logbook } = require('../apps/kf_probeg/logbook');
const { dayKey } = require('../apps/kf_probeg/drive');

const H = 3600000, t0 = new Date(2026, 10, 9, 8, 0, 0).getTime(), key = dayKey(t0);
const pr = new Prices(null, 81);
assert.strictEqual(pr.at(t0), 81);

// день: ~4 л из первого бака, заправка, ~3 л из второго
const lb = new Logbook(null);
let t = t0;
for (let i = 0; i < 5; i++) lb.feed(t += 1000, { odo: 100, tank: 20, speed: 0 });
for (let k = 1; k <= 40; k++) lb.feed(t += 10000, { odo: 100 + k, tank: 20 - k * 0.1, speed: 70 });
let refuelT = null;
for (let i = 0; i < 6; i++) { const r = lb.feed(t += 1000, { odo: 140, tank: 70, speed: 0 }); if (r.refuel) refuelT = r.refuel.t; }
assert.ok(refuelT);
for (let k = 1; k <= 30; k++) lb.feed(t += 10000, { odo: 140 + k, tank: 70 - k * 0.1, speed: 70 });
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.01, what + ': ' + a + ' вместо ' + b);
// медиана уровня отстаёт на несколько показаний, поэтому литров чуть меньше 7
assert.ok(Math.abs(lb.fuel[key] - 7) < 1, 'литров за день: ' + lb.fuel[key]);
const by = lb.fuelBy[key], tanks = Object.keys(by).map(Number).sort();
assert.strictEqual(tanks.length, 2, 'топливо из двух баков');
const l1 = by[tanks[0]], l2 = by[tanks[1]];
near(l1 + l2, lb.fuel[key], 'литры по бакам');
near(lb.fuelCost(key, (x) => pr.at(x)), lb.fuel[key] * 81, 'всё по 81');

// после заправки цена стала 84,50: меняется только второй бак
pr.set(lb.fill.t, 84.5);
assert.strictEqual(pr.at(refuelT - 1), 81);
assert.strictEqual(pr.at(refuelT + 1), 84.5);
near(lb.fuelCost(key, (x) => pr.at(x)), l1 * 81 + l2 * 84.5, 'по цене каждого бака');

// поправка той же заправки ещё раз заменяет запись, а не добавляет
pr.set(lb.fill.t, 84.6);
assert.strictEqual(pr.list.length, 1);
assert.strictEqual(pr.at(t), 84.6);

// сохранение
const back = new Prices(JSON.parse(JSON.stringify(pr)), 70);
assert.strictEqual(back.at(t), 84.6);
assert.strictEqual(back.at(t0), 81, 'начальная цена сохраняется');
const lb2 = new Logbook(JSON.parse(JSON.stringify(lb)));
near(lb2.fuelCost(key, (x) => back.at(x)), l1 * 81 + l2 * 84.6, 'после загрузки');
console.log('kf_probeg prices: ok');
