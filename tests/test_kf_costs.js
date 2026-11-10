'use strict';
// node tests/test_kf_costs.js - стоимость ТО на 1 км (apps/kf_probeg/costs.js)
const assert = require('assert');
const C = require('../apps/kf_probeg/costs');
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' вместо ' + b);

// заказ-наряд разложен по пунктам без потерь
C.RECEIPTS.forEach((r) => assert.strictEqual(r.items.reduce((a, x) => a + x.cost, 0), r.total, 'сумма пунктов = итог ' + r.no));

// 27.10.2026: масло 1,82 + воздушный 0,107 + салонный 0,207 + топливный 0,125 + крышка 0,2
let to = C.toPerKm({ oilKm: 10000 });
near(to.total, 2.459, 0.001, 'ТО руб/км');
near(to.items.find((x) => x.id === 'oil').perKm, 1.82, 0.001, 'масло');

// мало ездим: салонный фильтр раз в год выходит раньше 15 000 км - километр дороже
to = C.toPerKm({ oilKm: 10000, kmPerDay: 20 });
near(to.items.find((x) => x.id === 'cabin').km, 12 * 30.44 * 20, 0.1, 'салонный по времени');

// оплачено в промежутке
assert.strictEqual(C.paid(new Date('2026-10-01').getTime(), new Date('2026-11-10').getTime()), 52000);
assert.strictEqual(C.paid(new Date('2026-11-01').getTime(), new Date('2026-11-10').getTime()), 0);
console.log('kf_probeg costs: ok');
