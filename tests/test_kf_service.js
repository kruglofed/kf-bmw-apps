'use strict';
// node tests/test_kf_service.js - ТО по реальному пробегу (apps/kf_probeg/service.js)
const assert = require('assert');
const { Service, UNDO_MS } = require('../apps/kf_probeg/service');

const DAY = 86400000, t0 = new Date(2026, 10, 8, 12, 0, 0).getTime();
let sv = new Service(null);
const items = sv.items({ engine: 'petrol', oilKm: 8000 });
assert.ok(items.some((i) => i.id === 'plugs') && !items.some((i) => i.id === 'fuel'), 'бензин: свечи, без топливного фильтра');
assert.strictEqual(items.find((i) => i.id === 'oil').km, 8000, 'интервал масла из настроек');
assert.strictEqual(sv.items({ engine: 'both' }).length, 9);
const oil = items.find((i) => i.id === 'oil'), brake = items.find((i) => i.id === 'brake');

assert.strictEqual(sv.status(oil, 50000, t0).state, 'none');
// без реального пробега отметить нельзя
assert.strictEqual(sv.press('oil', null, t0).kind, 'noodo');
// первое нажатие - подтверждение, второе - отметка
assert.strictEqual(sv.press('oil', 50000, t0).kind, 'confirm');
assert.ok(sv.confirming('oil', t0 + 1000));
assert.strictEqual(sv.press('oil', 50000, t0 + 2000).kind, 'done');
let st = sv.status(oil, 55000, t0 + 100 * DAY);
assert.strictEqual(st.kmLeft, 3000);
assert.strictEqual(st.state, 'ok');
assert.strictEqual(sv.status(oil, 57500, t0).state, 'soon');
assert.strictEqual(sv.status(oil, 58100, t0).state, 'due');
assert.strictEqual(sv.status(oil, 51000, t0 + 366 * DAY).state, 'due', 'по времени');

// подтверждение просрочилось - снова просит подтвердить
assert.strictEqual(sv.press('brake', 50000, t0).kind, 'confirm');
assert.strictEqual(sv.press('brake', 50000, t0 + 10000).kind, 'confirm');
assert.strictEqual(sv.press('brake', 50000, t0 + 11000).kind, 'done');
st = sv.status(brake, 99999, t0 + 700 * DAY);
assert.strictEqual(st.kmLeft, null, 'тормозная жидкость - только по времени');
assert.ok(st.daysLeft > 0 && st.daysLeft < 40 && st.state === 'soon');

// отмена только что сделанной отметки
assert.strictEqual(sv.press('brake', 50000, t0 + 20000).kind, 'undone');
assert.strictEqual(sv.status(brake, 50000, t0).state, 'none');

// спустя UNDO_MS отметка закрепляется: нажатие снова просит подтверждения новой замены
sv.settle(t0 + 2000 + UNDO_MS);
assert.strictEqual(sv.press('oil', 60000, t0 + 3 * UNDO_MS).kind, 'confirm');
assert.strictEqual(sv.press('oil', 60000, t0 + 3 * UNDO_MS + 500).kind, 'done');
assert.strictEqual(sv.log.oil.length, 2);

const back = new Service(JSON.parse(JSON.stringify(sv)));
assert.strictEqual(back.last('oil').km, 60000);
console.log('kf_probeg service: ok');
