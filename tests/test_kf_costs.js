'use strict';
// node tests/test_kf_costs.js - стоимость ТО на 1 км (apps/kf_probeg/costs.js)
const assert = require('assert');
const C = require('../apps/kf_probeg/costs');
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' вместо ' + b);

// заказ-наряд разложен по пунктам без потерь
C.RECEIPTS.forEach((r) => assert.strictEqual(r.items.reduce((a, x) => a + x.cost, 0), r.total, 'сумма пунктов = итог ' + r.no));

// последний наряд по каждому пункту: масло 18 200/10 000 + воздушный 3 200/8 000 + салонный 3 100/8 000
// + топливный 7 500/15 000 + масло раздатки 9 500/60 000 + раздатка 61 500/100 000 + крышка 20 000/100 000
let to = C.toPerKm({ oilKm: 10000 });
near(to.total, 1.82 + 0.4 + 0.3875 + 0.5 + 9500 / 60000 + 0.615 + 0.2, 0.001, 'ТО руб/км');
near(C.toPerKm({ oilKm: 8000 }).items.find((x) => x.id === 'oil').perKm, 2.275, 0.001, 'масло раз в 8 000');
near(to.items.find((x) => x.id === 'oil').perKm, 1.82, 0.001, 'масло');

// мало ездим: салонный фильтр раз в год выходит раньше 15 000 км - километр дороже
to = C.toPerKm({ oilKm: 10000, kmPerDay: 10 });
near(to.items.find((x) => x.id === 'cabin').km, 12 * 30.44 * 10, 0.1, 'салонный по времени');

// оплачено в промежутке
assert.strictEqual(C.paid(new Date('2026-10-01').getTime(), new Date('2026-11-10').getTime()), 52000);
assert.strictEqual(C.paid(new Date('2026-08-01').getTime(), new Date('2026-11-10').getTime()), 155600);
assert.strictEqual(C.paid(new Date('2026-11-01').getTime(), new Date('2026-11-10').getTime()), 0);
console.log('kf_probeg costs: ok');

// пробег на дату наряда: одометр с наряда +1050 при доле 0,35 = 3000 реальных км назад
{
    const oct = C.RECEIPTS.find((x) => x.no === '1919144');
    const r = C.receiptKm(oct, 60000, 98950, 0.35);
    near(r.km, 57000, 0.01, 'реальный пробег на наряд');
    assert.strictEqual(C.receiptKm(oct, 60000, 98950, null).km, 58950, 'без доли - как одометр');
    assert.strictEqual(C.receiptKm(oct, 60000, 90000, 0.35), null, 'одометр меньше, чем в наряде');
    // на вкладке ТО: отметка из наряда, своя кнопкой - если позже
    const { Service } = require('../apps/kf_probeg/service');
    const sv = new Service({ log: { oil: [{ t: C.dateMs('2026-01-01'), km: 40000 }] } });
    sv.receipt('oil', C.dateMs('2026-10-27'), r.km, true);
    assert.strictEqual(sv.last('oil').km, 57000);
    const st = sv.status({ id: 'oil', km: 8000, months: 12 }, 60000, C.dateMs('2026-11-10'));
    assert.strictEqual(st.kmLeft, 5000, 'осталось до масла');
    assert.ok(!JSON.stringify(sv.toJSON()).includes('57000'), 'наряд не сохраняется в журнал');
}
console.log('kf_probeg costs receipts: ok');
