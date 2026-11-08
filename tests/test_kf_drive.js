'use strict';
// node tests/test_kf_drive.js - езда по дням и рейтинг (apps/kf_probeg/drive.js), топливо за день (logbook.js)
const assert = require('assert');
const { Drive, rate, sum, dayKey } = require('../apps/kf_probeg/drive');
const { Logbook } = require('../apps/kf_probeg/logbook');

const t0 = new Date(2026, 10, 8, 9, 0, 0).getTime(), key = dayKey(t0);
let dv = new Drive(null), t = t0;
const feed = (kmh, ms) => { const dKm = kmh * ms / 3600000; t += ms; dv.speed(t, kmh, dKm, kmh > 0.5 ? ms : 0); };

// плавный разгон 0 -> 90 за 30 с (0,83 м/с^2), 20 мин на 90, плавное торможение
for (let v = 0; v <= 90; v += 0.3) feed(v, 100);
for (let i = 0; i < 12000; i++) feed(90, 100);
for (let v = 90; v >= 0; v -= 0.3) feed(v, 100);
let d = dv.day(key);
near(d.km, 30 + 0.375 * 2, 0.2, 'путь');
assert.strictEqual(d.acc + d.brk, 0, 'плавно - без резких');
assert.ok(Math.abs(d.vmax - 90) < 0.5);
let r = rate(d);
assert.ok(r.score >= 85 && r.label === 'Экономично', 'рейтинг плавной езды ' + r.score);

// три резких разгона 0 -> 60 за 5 с (3,3 м/с^2) и три резких торможения 60 -> 0 за 4 с (4,2 м/с^2)
for (let k = 0; k < 3; k++) {
    for (let v = 0; v <= 60; v += 1.2) feed(v, 100);
    for (let i = 0; i < 100; i++) feed(60, 100);
    for (let v = 60; v >= 0; v -= 1.5) feed(v, 100);
    for (let i = 0; i < 50; i++) feed(0, 100);
}
d = dv.day(key);
assert.strictEqual(d.acc, 3, 'резких разгонов ' + d.acc);
assert.strictEqual(d.brk, 3, 'резких торможений ' + d.brk);
// резкие повороты по датчику
dv.lat(t, 1); dv.lat(t + 100, 4.5); dv.lat(t + 200, 4.8); dv.lat(t + 300, 1); dv.lat(t + 400, -4.2);
assert.strictEqual(dv.day(key).turn, 2);
r = rate(dv.day(key));
assert.ok(r.score < 85, 'резкая езда снижает рейтинг: ' + r.score);
assert.ok(rate({ km: 2 }) === null, 'меньше 5 км - без рейтинга');

// неделя и сохранение
const back = new Drive(JSON.parse(JSON.stringify(dv)));
assert.strictEqual(back.day(key).acc, 3);
assert.strictEqual(sum([back.day(key), null, { km: 10, vmax: 130, moveMs: 1, acc: 1, brk: 0, turn: 0, posA: 0, posT: 0 }]).vmax, 130);
assert.strictEqual(back.list(t0, 7).length, 7);

// топливо за день: уровень падает 60 -> 52 л, всплеск вверх (уклон) не считается, заправка тоже
const lb = new Logbook(null);
let tt = t0;
for (let i = 0; i < 5; i++) lb.feed(tt += 1000, { odo: 1000, tank: 60, speed: 0 });
for (let k = 1; k <= 80; k++) lb.feed(tt += 10000, { odo: 1000 + k, tank: 60 - k * 0.1, speed: 80 });
for (let i = 0; i < 6; i++) lb.feed(tt += 1000, { odo: 1080, tank: 54, speed: 0 });     // +2 л - не заправка
for (let i = 0; i < 6; i++) lb.feed(tt += 1000, { odo: 1080, tank: 75, speed: 0 });     // заправка
near(lb.fuel[key], 8, 0.3, 'литров за день');
console.log('kf_probeg drive: ok');

function near(a, b, tol, what) { assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' вместо ' + b); }
