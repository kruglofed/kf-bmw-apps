'use strict';
// node tests/test_kf_retro.js - стрелки «Ретро-приборов» (apps/kf_retro/needles.js)
const assert = require('assert');
const N = require('../apps/kf_retro/needles');
const near = (a, b, e, msg) => assert.ok(Math.abs(a - b) <= e, (msg || '') + ': ' + a + ' vs ' + b);
const run = (n, target, sec, rnd, k) => { let x; for (let i = 0; i < sec * 60; i++) x = n.update(target, 1 / 60, rnd, k); return x; };

/* спокойная стрелка доходит до значения и стоит */
{
    const n = new N.Needle({ min: 0, max: 180, w: 10, z: 0.8 });
    near(run(n, 90, 3), 90, 0.05, 'дошла до 90');
    near(n.update(90, 1 / 60), 90, 0.05, 'стоит');
}

/* мало демпфирования - перелетает */
{
    const n = new N.Needle({ min: 0, max: 8000, w: 14, z: 0.35 });
    let peak = 0;
    for (let i = 0; i < 120; i++) peak = Math.max(peak, n.update(3000, 1 / 60));
    assert.ok(peak > 3200, 'перелёт ' + peak);
}

/* дрожание тахометра: на постоянных оборотах стрелка не стоит, но держится рядом */
{
    const rnd = N.rng(7);
    const n = new N.Needle({ min: 0, max: 8000, w: 16, z: 0.45, jitter: 90, kick: 2500, kickRate: 1.2 });
    run(n, 2000, 2, rnd);
    let lo = Infinity, hi = -Infinity, sum = 0, cnt = 0;
    for (let i = 0; i < 600; i++) { const x = n.update(2000, 1 / 60, rnd); lo = Math.min(lo, x); hi = Math.max(hi, x); sum += x; cnt++; }
    assert.ok(hi - lo > 60, 'дрожит: размах ' + (hi - lo));
    assert.ok(hi - lo < 1200, 'но не улетает: ' + (hi - lo));
    near(sum / cnt, 2000, 80, 'в среднем на месте');
    // дрожание выключено
    const q = new N.Needle({ min: 0, max: 8000, w: 16, z: 0.45, jitter: 90, kick: 2500, kickRate: 1.2 });
    run(q, 2000, 3, rnd, 0);
    let qlo = Infinity, qhi = -Infinity;
    for (let i = 0; i < 300; i++) { const x = q.update(2000, 1 / 60, rnd, 0); qlo = Math.min(qlo, x); qhi = Math.max(qhi, x); }
    assert.ok(qhi - qlo < 1, 'без дрожания стоит');
}

/* тросик спидометра: на скорости гуляет, на месте нет */
{
    const n = new N.Needle({ min: 0, max: 120, w: 9, z: 0.6, cable: 0.02 });
    run(n, 80, 3);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 180; i++) { const x = n.update(80, 1 / 60); lo = Math.min(lo, x); hi = Math.max(hi, x); }
    assert.ok(hi - lo > 0.4, 'гуляет: ' + (hi - lo));
    const s = new N.Needle({ min: 0, max: 120, w: 9, z: 0.6, cable: 0.02 });
    near(run(s, 0, 2), 0, 1e-6, 'на месте стоит');
}

/* упоры: больше шкалы - упирается; нет сигнала - падает на ноль */
{
    const n = new N.Needle({ min: 0, max: 120, w: 9, z: 0.7, stopMax: 124 });
    assert.ok(run(n, 180, 3) <= 124, 'упор 124');
    near(run(n, 180, 3), 124, 0.01, 'лежит на упоре');
    near(run(n, null, 4), 0, 0.01, 'без сигнала на нуле');
}

/* прогон BMW: сначала к максимуму, потом назад и к значению */
{
    const n = new N.Needle({ min: 0, max: 260, w: 9, z: 0.9 });
    n.sweep(1400);
    let peak = 0;
    for (let i = 0; i < 42; i++) peak = Math.max(peak, n.update(0, 1 / 60));
    assert.ok(peak > 200, 'дошла почти до максимума: ' + peak);
    near(run(n, 50, 4), 50, 0.1, 'после прогона - к значению');
}

/* угол */
near(N.angleOf(90, 0, 180, -135, 135), 0, 1e-9);
near(N.angleOf(0, 0, 180, -135, 135), -135, 1e-9);
near(N.angleOf(180, 0, 180, -135, 135), 135, 1e-9);

/* одометр */
{
    const o = new N.OdoRoll();
    assert.strictEqual(o.update(null, 50, 0.1), null);
    near(o.update(12345, 0, 0.1), 12345, 1e-9);
    near(o.update(12345, 36, 0.1 * 10 / 10), 12345.001, 1e-6, '36 км/ч за 0,1 с = 1 м');
    for (let i = 0; i < 1000; i++) o.update(12345, 180, 0.25);
    near(o.update(12345, 180, 0.25), 12345.99, 1e-9, 'не уходит за следующий км');
    near(o.update(12346, 60, 0), 12346, 1e-9, 'новый км - с нуля');
    assert.strictEqual(N.drumDigits(12345.4, 6).digits, '012345');
    near(N.drumDigits(12345.4, 6).roll, 0.4, 1e-9);
    assert.strictEqual(N.drumDigits(1234567.2, 6).digits, '234567', 'лишние разряды отбрасываются');
    assert.strictEqual(N.drumDigits(null, 5).digits, '00000');
}
console.log('kf_retro needles: ok');
