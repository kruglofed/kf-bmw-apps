'use strict';
// node tests/test_kf_today.js - «Сегодня» и чеки заправок (apps/kf_probeg/today.js, fuel.js)
const assert = require('assert');
const { Today } = require('../apps/kf_probeg/today');
const F = require('../apps/kf_probeg/fuel');
const near = (a, b, e, m) => assert.ok(Math.abs(a - b) <= e, (m || '') + ': ' + a + ' vs ' + b);

/* день: завели в 7:40, поехали, светофор 20 с (не остановка), стоянка 2 мин, заглушили, снова завели */
{
    const t0 = new Date(2026, 10, 10, 7, 40, 0).getTime(), td = new Today(null);
    let t = t0;
    const run = (sec, rpm, kmh) => { for (let i = 0; i < sec; i++) { td.tick(t, rpm, kmh); t += 1000; } };
    run(60, 800, 0);          // прогрев на месте
    run(300, 1500, 50);       // едем
    run(20, 800, 0);          // светофор - не остановка
    run(300, 1500, 40);
    run(120, 800, 0);         // стоим 2 мин - остановка
    run(60, 0, 0);            // заглушили
    run(200, 1600, 60);       // снова завели и поехали
    const d = td.day('2026-11-10');
    assert.strictEqual(d.eng0, t0, 'первый запуск');
    assert.strictEqual(d.starts, 2, 'заводили 2 раза');
    assert.strictEqual(d.stops, 1, 'одна остановка (светофор 20 с - нет)');
    near(d.engMs / 1000, 60 + 300 + 20 + 300 + 120 + 200 - 2, 2, 'двигатель работал');
    near(d.idleMs / 1000, 60 + 20 + 120, 3, 'на месте');
    assert.strictEqual(d.mv0, t0 + 60000, 'начало движения');
    assert.strictEqual(d.mv1, t - 1000, 'конец маршрута - последнее движение');
    // перерыв (головное устройство спало) не засчитывается во время работы
    const before = d.onMs; t += 3600000; td.tick(t, 0, 0);
    assert.strictEqual(td.day('2026-11-10').onMs, before, 'сон не считается');
    // без оборотов (сигнала нет) - движение и остановки всё равно считаются
    const td2 = new Today(null); let u = t0;
    for (let i = 0; i < 100; i++) { td2.tick(u, null, 30); u += 1000; }
    for (let i = 0; i < 40; i++) { td2.tick(u, null, 0); u += 1000; }
    assert.strictEqual(td2.day('2026-11-10').stops, 1);
    assert.strictEqual(td2.day('2026-11-10').starts, 0);
    // сохраняется
    const back = new Today(JSON.parse(JSON.stringify(td)));
    assert.strictEqual(back.day('2026-11-10').starts, 2);
}

/* чеки: сопоставление с замеченными заправками */
{
    const fills = [
        { date: '2026-11-01', time: '09:10', station: 'Лукойл', grade: 'ДТ Евро-5', litres: 60.2, price: 74.5, total: 4485 },
        { date: '2026-11-07', time: '19:30', station: 'Shell', grade: 'V-Power Diesel', litres: 55, price: 79.9, total: 4395 },
        { date: '2026-11-09', time: '12:00', station: 'Газпром', grade: 'ДТ', litres: 10, price: 72, total: 720 },
    ];
    const t1 = new Date(2026, 10, 1, 9, 25).getTime(), t2 = new Date(2026, 10, 7, 21, 0).getTime(), t3 = new Date(2026, 10, 9, 12, 5).getTime();
    const m = F.match([{ t: t1, added: 59 }, { t: t2, added: 54 }, { t: t3, added: 40 }], fills);
    assert.strictEqual(m.get(t1).station, 'Лукойл', 'по времени и объёму');
    assert.strictEqual(m.get(t2).station, 'Shell', 'через 1,5 ч - тоже');
    assert.ok(!m.has(t3), '10 л в чеке и 40 л по баку - не та заправка');
    // баки и сравнение
    const periods = [
        { start: 0, end: t1, km: 300, l: 30, partial: true },
        { start: t1, end: t2, km: 600, l: 66 },          // 11,0
        { start: t2, end: t3, km: 550, l: 66 },          // 12,0
    ];
    const rows = F.tanks(periods, m, 11.5);
    assert.strictEqual(rows.length, 2, 'первый (неполный) бак не сравнивается');
    assert.strictEqual(rows[0].fill.station, 'Shell', 'новые первыми, бак Shell начат заправкой t2');
    near(rows[0].diff, (12 / 11.5 - 1) * 100, 1e-9);
    const st = F.byStation(rows, 11.5);
    assert.strictEqual(st[0].station, 'Лукойл', 'меньший расход первым');
    near(st[0].cons, 11, 1e-9); near(st[0].price, 74.5, 1e-9);
    // цена по чеку бака
    const base = () => 80;
    assert.strictEqual(F.priceAt(t1 + 1000, [t1, t2], m, base), 74.5);
    assert.strictEqual(F.priceAt(t2 + 1000, [t1, t2], m, base), 79.9);
    assert.strictEqual(F.priceAt(t1 - 1000, [t1, t2], m, base), 80, 'до чеков - цена из приложения');
}
console.log('kf_probeg today: ok');
