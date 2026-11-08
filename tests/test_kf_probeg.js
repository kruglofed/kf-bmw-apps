'use strict';
// node tests/test_kf_probeg.js - логика пробега и заправок (apps/kf_probeg/logbook.js)
const assert = require('assert');
const { Logbook, dayKey } = require('../apps/kf_probeg/logbook');

const DAY = 86400000, H = 3600000;
const t0 = new Date(2026, 10, 1, 8, 0, 0).getTime();     // 1 ноября 2026, 08:00

let lb = new Logbook(null);
// утро: бак 60 л, одометр 54 000
for (let i = 0; i < 5; i++) lb.feed(t0 + i * 1000, { odo: 54000, tank: 60, speed: 0 });
assert.strictEqual(lb.odo, 54000);
assert.strictEqual(lb.tank, 60);
assert.ok(lb.fill && lb.fill.partial, 'первый бак - неполный');

// едем 100 км за день, бак падает до 48 л
let t = t0 + 10000;
for (let km = 1; km <= 100; km++) {
    t += 36000;
    lb.feed(t, { odo: 54000 + km, tank: 60 - km * 0.12, speed: 100 });
}
assert.strictEqual(lb.odo, 54100);
let cur = lb.current();
assert.strictEqual(cur.km, 100);
assert.ok(Math.abs(cur.l - 12) < 0.3, 'израсходовано ~12 л, вышло ' + cur.l);
assert.ok(Math.abs(cur.avg - 12) < 0.3);

// помеха: одометр назад и всплеск бака в движении - игнорируются
lb.feed(t + 1000, { odo: 53000, tank: 70, speed: 80 });
assert.strictEqual(lb.odo, 54100);
assert.ok(!lb.periods.length);

// следующий день: заправка на стоянке до 75 л
const t1 = t0 + DAY + 2 * H;
let refuel = null;
for (let i = 0; i < 6; i++) {
    const r = lb.feed(t1 + i * 1000, { odo: 54100, tank: 75, speed: 0 });
    if (r.refuel) refuel = r.refuel;
}
assert.ok(refuel, 'заправка замечена');
assert.ok(Math.abs(refuel.added - 27) < 0.5, 'залито ~27 л, вышло ' + refuel.added);
assert.strictEqual(lb.periods.length, 1);
assert.strictEqual(lb.periods[0].km, 100);
assert.ok(lb.periods[0].partial);
assert.strictEqual(lb.current().km, 0);
assert.ok(!lb.current().partial);

// мелкий рост уровня (уклон) - не заправка
for (let i = 0; i < 6; i++) lb.feed(t1 + 60000 + i * 1000, { odo: 54100, tank: 77, speed: 0 });
assert.strictEqual(lb.periods.length, 1);

// пробег по дням: вчера (1 ноября) 100 км, сегодня 0, затем 40
assert.deepStrictEqual(lb.stats(t1).today, 0);
assert.deepStrictEqual(lb.stats(t1).yesterday, 100);
for (let km = 1; km <= 40; km++) lb.feed(t1 + H + km * 40000, { odo: 54100 + km, tank: 75, speed: 60 });
let st = lb.stats(t1 + 2 * H);
assert.strictEqual(st.today, 40);
assert.strictEqual(st.yesterday, 100);
assert.strictEqual(st.week, 140);
const daily = lb.daily(t1 + 2 * H, 3);
assert.deepStrictEqual(daily.map((d) => d[1]), [40, 100, 0]);

// пропущенные дни: приложение не работало 3 дня, за них 300 км - попадают в день, когда пришло показание
const t5 = t0 + 5 * DAY;
lb.feed(t5, { odo: 54440, tank: 40, speed: 0 });
st = lb.stats(t5);
assert.strictEqual(st.today, 300);
assert.strictEqual(st.week, 440);

// сохранение и загрузка
const back = new Logbook(JSON.parse(JSON.stringify(lb)));
assert.strictEqual(back.odo, 54440);
assert.strictEqual(back.periods.length, 1);
assert.deepStrictEqual(back.stats(t5), st);

// большой скачок одометра принимается после трёх подтверждений
lb.feed(t5 + 1000, { odo: 60000 });
assert.strictEqual(lb.odo, 54440);
lb.feed(t5 + 2000, { odo: 60000 }); lb.feed(t5 + 3000, { odo: 60001 });
assert.strictEqual(lb.odo, 60001);

assert.strictEqual(dayKey(t0), '2026-11-01');
console.log('kf_probeg logbook: ok');
