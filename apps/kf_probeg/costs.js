'use strict';
/**
 * costs.js - сколько стоит километр: топливо отдельно, ТО отдельно.
 *
 * ТО. Каждый заказ-наряд разложен по пунктам; работы и расходники отнесены к своему пункту. Стоимость
 * пункта делится на его интервал: замена масла за 18 200 руб раз в 10 000 км = 1,82 руб/км. Если пункт
 * меняется и по времени (салонный фильтр раз в год), а за это время выходит меньше км, интервал
 * берётся по времени: тогда километр дороже. Разовый ремонт делится на срок службы детали.
 * Для каждого пункта берётся последний заказ-наряд, в котором он есть.
 *
 * Заказ-наряды записаны здесь, потому что ввести их на головном устройстве нечем.
 * Новый - добавить в RECEIPTS (дата, сумма, пункты с суммами; сумма пунктов = итог по наряду).
 *
 *   toPerKm(opts)          { total, items: [{ id, name, cost, km, perKm, date }] }
 *                          opts: { oilKm, kmPerDay }  (kmPerDay - средний пробег в день, если известен)
 *   paid(fromMs, toMs)     сколько оплачено за ТО в этот промежуток, руб
 *   RECEIPTS, LIFE
 */
const MONTH_DAYS = 30.44;

// срок службы, км и месяцы; null - нет ограничения. Масло - из настроек приложения.
const LIFE = {
    oil: { name: 'Масло и фильтр', km: 10000, months: 12 },
    air: { name: 'Воздушный фильтр', km: 30000, months: 24 },
    cabin: { name: 'Салонный фильтр', km: 15000, months: 12 },
    fuel: { name: 'Топливный фильтр', km: 60000, months: 48 },
    oilcap: { name: 'Крышка масл. фильтра', km: 100000, months: null },   // разовый ремонт
};

const RECEIPTS = [
    {
        date: '2026-10-27', no: '1919144', total: 52000,
        items: [
            // работы 900 + сброс интервала 300; масло 7 л 14 000, фильтр 2 400, очиститель 600
            { id: 'oil', cost: 900 + 300 + 14000 + 2400 + 600 },
            { id: 'air', cost: 600 + 2600 },
            { id: 'cabin', cost: 600 + 2500 },
            { id: 'fuel', cost: 1500 + 6000 },
            { id: 'oilcap', cost: 0 + 20000 },
        ],
    },
];

const isNum = (x) => typeof x === 'number' && isFinite(x);
const dateMs = (s) => new Date(s + 'T12:00:00').getTime();

/** интервал пункта в км: по км или по времени, что наступит раньше */
function lifeKm(id, opts) {
    const L = LIFE[id], o = opts || {};
    let km = id === 'oil' && isNum(o.oilKm) ? o.oilKm : L.km;
    if (isNum(L.months) && isNum(o.kmPerDay) && o.kmPerDay > 0) km = Math.min(km, L.months * MONTH_DAYS * o.kmPerDay);
    return km;
}

function toPerKm(opts, receipts) {
    const last = {};
    (receipts || RECEIPTS).forEach((r) => r.items.forEach((it) => {
        if (!LIFE[it.id]) return;
        if (!last[it.id] || last[it.id].date <= r.date) last[it.id] = { cost: it.cost, date: r.date };
    }));
    const items = Object.keys(LIFE).filter((id) => last[id]).map((id) => {
        const km = lifeKm(id, opts);
        return { id, name: LIFE[id].name, cost: last[id].cost, km, perKm: last[id].cost / km, date: last[id].date };
    });
    return { total: items.reduce((a, x) => a + x.perKm, 0), items };
}

function paid(fromMs, toMs, receipts) {
    return (receipts || RECEIPTS).filter((r) => { const t = dateMs(r.date); return t >= fromMs && t <= toMs; })
        .reduce((a, r) => a + r.total, 0);
}

module.exports = { toPerKm, paid, lifeKm, RECEIPTS, LIFE };
