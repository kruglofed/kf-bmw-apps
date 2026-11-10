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

/* заправка постепенно: уровень растёт 3 минуты - одна заправка на весь объём, не несколько */
{
    const { Logbook } = require('../apps/kf_probeg/logbook');
    const L = new Logbook(null);
    let t = new Date(2026, 10, 10, 19, 0).getTime(), odo = 1000;
    const feed = (tank, speed, n) => { for (let i = 0; i < (n || 4); i++) { L.feed(t, { odo, tank, speed }); t += 1000; } };
    feed(70, 0, 8);                                       // начало учёта
    for (let k = 0; k < 50; k++) { odo += 10; feed(70 - k, 60, 2); }   // проехали 500 км, бак до 21 л
    const events = [];
    for (let lv = 21; lv <= 87; lv += 0.4) { const r = L.feed(t, { odo, tank: lv, speed: 0 }); if (r.refuel) events.push(r.refuel); t += 1000; }
    feed(87, 0, 20);
    assert.ok(events.length >= 1, 'заправка замечена');
    assert.ok(events.filter((e) => !e.extended).length === 1, 'одна заправка, а не несколько: ' + events.map((e) => e.added).join(', '));
    const last = events[events.length - 1];
    assert.ok(Math.abs(last.added - 66) < 2, 'залито ~66 л, а не 5: ' + last.added);
    assert.ok(Math.abs(L.fill.added - 66) < 2 && Math.abs(L.periods[L.periods.length - 1].added - 66) < 2, 'и в учёте');
    // через 40 мин и 5 км - уже новая заправка, не продолжение
    odo += 5; feed(85, 40, 4); t += 40 * 60000; feed(85, 0, 8);
    const r2 = []; for (let lv = 85; lv <= 95; lv += 0.5) { const r = L.feed(t, { odo, tank: lv, speed: 0 }); if (r.refuel) r2.push(r.refuel); t += 1000; }
    assert.ok(r2.some((e) => !e.extended), 'новая заправка отдельно');
}
/* сохранённая кусками заправка (до 1.9.2) склеивается при загрузке */
{
    const { Logbook } = require('../apps/kf_probeg/logbook');
    const t1 = new Date(2026, 10, 10, 20, 20).getTime();
    const L = new Logbook({ odo: 98557, tank: 40, low: 40, fill: { t: t1 + 4 * 60000, odo: 98557, tank: 40, added: 13 },
        periods: [{ start: t1 - 9 * 86400000, end: t1, odo0: 98000, odo1: 98557, km: 557, l: 60, added: 5 }], days: {} });
    assert.strictEqual(L.fill.added, 18, 'куски сложены');
    assert.strictEqual(L.fill.t, t1, 'заправка - с первого куска');
    assert.strictEqual(L.periods[0].added, 18);
}
console.log('kf_probeg logbook: ok');
