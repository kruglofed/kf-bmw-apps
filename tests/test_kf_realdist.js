'use strict';
// node tests/test_kf_realdist.js - реальный пробег по скорости (apps/kf_probeg/realdist.js)
const assert = require('assert');
const { RealDistance } = require('../apps/kf_probeg/realdist');

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' вместо ' + b);
const t0 = 1700000000000;

// час на 90 км/ч, показания 10 раз в секунду = 90 км
let rd = new RealDistance(null);
rd.car(41000);
for (let i = 0; i <= 36000; i++) rd.speed(t0 + i * 100, 90);
near(rd.counted, 90, 0.01, 'час на 90');
near(rd.odo(0), 41090, 0.01, 'реальный пробег');

// одометр со стоп-пробегом насчитал треть
rd.car(41030);
near(rd.ratio(), 1 / 3, 0.001, 'доля одометра');

// постоянная скорость: уведомлений нет, но опрос раз в 2 с - путь считается без потерь
rd = new RealDistance(null);
for (let i = 0; i <= 1800; i++) { rd.speed(t0 + i * 2000, 60); rd.tick(t0 + i * 2000 + 1000); }
near(rd.counted, 60, 0.05, 'час на 60 опросом');

// показания пропали (головное устройство уснуло): держим скорость 10 с, дальше не считаем
rd = new RealDistance(null);
rd.speed(t0, 36);                 // 36 км/ч = 10 м/с
for (let i = 1; i <= 600; i++) rd.tick(t0 + i * 1000);
near(rd.counted, 0.1, 0.0001, 'после пропажи сигнала');
rd.speed(t0 + 3600000, 0);        // через час - стоим
near(rd.counted, 0.1, 0.0001, 'пропуск не считается');

// стоянка и неизвестная скорость не добавляют путь; нелепая скорость - отбрасывается
rd = new RealDistance(null);
for (let i = 0; i <= 600; i++) rd.speed(t0 + i * 1000, 0);
rd.speed(t0 + 601000, null); rd.speed(t0 + 602000, 900);
assert.strictEqual(rd.counted, 0);

// поправка +2 %
rd = new RealDistance(null, 1.02);
for (let i = 0; i <= 3600; i++) rd.speed(t0 + i * 1000, 100);
near(rd.counted, 102, 0.01, 'поправка');
near(rd.trip.moveMs, 3600000, 1, 'время в движении');

// сохранение
const back = new RealDistance(JSON.parse(JSON.stringify(rd)));
near(back.counted, 102, 0.01, 'после загрузки');
assert.strictEqual(back.odo(5000), null, 'без одометра реального пробега нет');
back.car(50000);
near(back.odo(5000), 50000 + 102 + 5000, 0.01, 'с поправкой пробега');
console.log('kf_probeg realdist: ok');

// запас хода: по реальному расходу, а пока его нет - запас машины / долю одометра
{
    const { realRange } = require('../apps/kf_probeg/realdist');
    let r = realRange(60, 10, 200, 0.35);
    assert.strictEqual(r.how, 'cons'); near(r.km, 600, 0.01, 'запас по расходу');
    r = realRange(60, null, 200, 0.4);
    assert.strictEqual(r.how, 'ratio'); near(r.km, 500, 0.01, 'запас по доле одометра');
    assert.strictEqual(realRange(60, null, 200, null), null, 'без доли одометра не угадываем');
    assert.strictEqual(realRange(null, null, null, 0.4), null, 'без данных');
    assert.strictEqual(realRange(60, null, 200, 0.01), null, 'неправдоподобная доля');
}
