'use strict';
/**
 * fuel.js - чеки заправок и качество топлива по АЗС.
 *
 * Чек записывается сюда (ввести его на головном устройстве нечем): дата и время, АЗС, адрес, марка
 * топлива, литры, цена, сумма. Приложение само находит заправку, которую оно заметило по баку
 * (logbook.js), в пределах MATCH_MS по времени и с похожим объёмом, и тогда:
 *   - на вкладке «Заправки» у неё видны АЗС и марка, сумма - по чеку;
 *   - цена бака, залитого по чеку, берётся из чека (priceAt);
 *   - на вкладке «АЗС» расход этого бака попадает в сравнение АЗС и марок.
 *
 * Расход бака зависит не только от топлива: город или трасса, зима, прогревы. Поэтому сравнение -
 * со своим средним, и только по бакам от MIN_KM км.
 *
 *   match(refuels, fills)      Map: время заправки (мс) -> чек.  refuels = [{ t, added }]
 *   tanks(periods, matches, avg, current)  [{ start, end, km, l, cons, diff, fill, now }] - баки, новые первыми;
 *                              current (lb.current()) - текущий бак первой строкой (now)
 *   byStation(rows)            [{ key, station, grade, n, km, cons, diff, price }] - по АЗС и марке
 *   FILLS
 * Node 8: без ?. и ??.
 */
const MATCH_MS = 8 * 3600000, MIN_KM = 50;

// чеки, старые первыми. Пример:
// { date: '2026-11-10', time: '18:20', station: 'Лукойл', place: 'Москва, Алтуфьевское ш., 50', grade: 'ДТ Евро-5', litres: 52.31, price: 74.5, total: 3897 },
const FILLS = [
    { date: '2026-11-10', time: '20:25', station: 'Тебойл', place: 'АЗС 12003 «Каштановая роща», Шолохово, Дмитровское ш., 2а', grade: 'ДТ-Е-К5',
        litres: 66.18, price: 81.11, total: 5367.86 },
];

const isNum = (x) => typeof x === 'number' && isFinite(x);
/** время чека, мс (местное время блока) */
function fillMs(f) {
    const d = String(f.date).split('-').map(Number), t = String(f.time || '12:00').split(':').map(Number);
    return new Date(d[0], d[1] - 1, d[2], t[0] || 0, t[1] || 0).getTime();
}

/** каждой замеченной заправке - ближайший по времени чек с похожим объёмом (каждый чек - один раз) */
function match(refuels, fills) {
    const out = new Map(), used = new Set();
    const list = (fills || FILLS).map((f, i) => ({ f, i, t: fillMs(f) }));
    (refuels || []).slice().sort((a, b) => a.t - b.t).forEach((r) => {
        let best = null;
        list.forEach((c) => {
            if (used.has(c.i)) return;
            const dt = Math.abs(c.t - r.t);
            if (dt > MATCH_MS) return;
            // датчик бака во время заправки запаздывает и чаще недосчитывает: по баку 18 л при 66 л в чеке -
            // та же заправка; а заметно больше, чем в чеке (40 л по баку при 10 л в чеке) - другая
            if (isNum(r.added) && isNum(c.f.litres) && (r.added > c.f.litres * 1.4 + 6 || c.f.litres > r.added * 4 + 20)) return;
            if (!best || dt < best.dt) best = { c, dt };
        });
        if (best) { used.add(best.c.i); out.set(r.t, best.c.f); }
    });
    return out;
}

/** баки с расходом: старт бака - заправка period.start; разница со своим средним, % */
function tanks(periods, matches, avg, current) {
    const cur = current && isNum(current.since) && !current.partial ? [{ start: current.since, km: current.km, l: current.l, now: true }] : [];
    return cur.concat((periods || []).filter((p) => !p.partial).slice().reverse()).map((p) => {
        const cons = p.km >= 20 && p.l > 0 ? p.l / p.km * 100 : null;
        return { start: p.start, end: p.end, km: p.km, l: p.l, cons, diff: isNum(cons) && isNum(avg) && avg > 0 ? (cons / avg - 1) * 100 : null,
            fill: matches.get(p.start) || null, now: !!p.now };
    });
}

/** по АЗС и марке: средний расход (по км), разница со своим средним, цена */
function byStation(rows, avg) {
    const g = {};
    rows.forEach((r) => {
        if (r.now || !r.fill || !isNum(r.cons) || r.km < MIN_KM) return;     // текущий бак - пока не в сравнении
        const key = r.fill.station + ' · ' + (r.fill.grade || '');
        const x = g[key] || (g[key] = { key, station: r.fill.station, grade: r.fill.grade || '', n: 0, km: 0, l: 0, pSum: 0, pN: 0 });
        x.n++; x.km += r.km; x.l += r.l;
        if (isNum(r.fill.price)) { x.pSum += r.fill.price; x.pN++; }
    });
    return Object.keys(g).map((k) => {
        const x = g[k], cons = x.l / x.km * 100;
        return { key: k, station: x.station, grade: x.grade, n: x.n, km: x.km, cons, diff: isNum(avg) && avg > 0 ? (cons / avg - 1) * 100 : null,
            price: x.pN ? x.pSum / x.pN : null };
    }).sort((a, b) => a.cons - b.cons);
}

/** цена в момент t: по чеку бака, из которого топливо, иначе base(t) (prices.js) */
function priceAt(t, refuelTimes, matches, base) {
    let rt = null;
    refuelTimes.forEach((x) => { if (x <= t && (rt === null || x > rt)) rt = x; });
    const f = rt !== null ? matches.get(rt) : null;
    return f && isNum(f.price) ? f.price : base(t);
}

module.exports = { FILLS, match, tanks, byStation, priceAt, fillMs, MATCH_MS, MIN_KM };
