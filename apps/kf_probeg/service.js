'use strict';
/**
 * service.js - техобслуживание по реальному пробегу и по времени.
 *
 * Сервисные интервалы машины (CBS) считает комбинация приборов по своему одометру; если он считает
 * не всё, масло и остальное перехаживаются. Здесь каждый пункт отмечается "сделано" на реальном
 * пробеге (тот же счётчик, что у logbook.js), а срок - что наступит раньше: км или месяцы.
 *
 *   const sv = new Service(saved);
 *   sv.items(opts)                пункты для двигателя и интервала масла из настроек
 *   sv.status(item, odo, now)     { last, kmLeft, daysLeft, frac, state: 'none'|'ok'|'soon'|'due' }
 *   sv.press(id, odo, now)        кнопка "отметить": первое нажатие просит подтвердить, второе в
 *                                 течение CONFIRM_MS отмечает; нажатие по только что отмеченному
 *                                 пункту (UNDO_MS) отменяет отметку
 *       -> { kind: 'confirm'|'done'|'undone'|'noodo', item }
 *   sv.receipt(id, t, km, est)    пункт сделан по заказ-наряду (не сохраняется, задаётся при каждом запуске)
 *   sv.toJSON()
 */
const CONFIRM_MS = 6000, UNDO_MS = 120000, KEEP = 6;
const MONTH = 30.44 * 86400000;

// интервалы - распространённые для G05 в российских условиях (короче, чем у BMW), их видно на экране
const BASE = [
    { id: 'oil', name: 'Масло и масляный фильтр', km: 10000, months: 12 },
    { id: 'air', name: 'Воздушный фильтр', km: 30000, months: 24 },
    { id: 'cabin', name: 'Салонный фильтр', km: 15000, months: 12 },
    { id: 'plugs', name: 'Свечи зажигания', km: 60000, months: 48, engine: 'petrol' },
    { id: 'fuel', name: 'Топливный фильтр', km: 60000, months: 48, engine: 'diesel' },
    { id: 'brake', name: 'Тормозная жидкость', km: null, months: 24 },
    { id: 'pads', name: 'Осмотр тормозов', km: 15000, months: 12 },
    { id: 'atf', name: 'Масло АКПП', km: 60000, months: null },
    { id: 'axles', name: 'Масло раздатки и редукторов', km: 60000, months: null },
];

const isNum = (x) => typeof x === 'number' && isFinite(x);

class Service {
    constructor(saved) {
        const s = saved && typeof saved === 'object' ? saved : {};
        this.log = {};
        if (s.log && typeof s.log === 'object') {
            Object.keys(s.log).forEach((k) => {
                const a = Array.isArray(s.log[k]) ? s.log[k].filter((e) => e && isNum(e.t) && isNum(e.km)) : [];
                if (a.length) this.log[k] = a.slice(-KEEP);
            });
        }
        this.pending = null;      // { id, t } - ждём подтверждения
        this.rcpt = {};           // id -> { t, km, rcpt: true, est } - из заказ-нарядов (costs.js), не сохраняется
        this.ver = 0;
    }

    /** opts: { engine: 'petrol'|'diesel'|'both', oilKm } */
    items(opts) {
        const o = opts || {};
        return BASE.filter((b) => !b.engine || o.engine === 'both' || b.engine === (o.engine || 'petrol'))
            .map((b) => (b.id === 'oil' && isNum(o.oilKm) ? Object.assign({}, b, { km: o.oilKm }) : b));
    }

    /** последняя отметка: своя кнопкой или из заказ-наряда - что позже */
    last(id) {
        const a = this.log[id], m = a && a.length ? a[a.length - 1] : null, r = this.rcpt[id] || null;
        return m && r ? (r.t > m.t ? r : m) : m || r;
    }

    /** пункт сделан по заказ-наряду: дата и реальный пробег тогда (est - пробег примерный) */
    receipt(id, t, km, est) {
        if (!isNum(t) || !isNum(km)) { delete this.rcpt[id]; return; }
        this.rcpt[id] = { t, km: Math.round(km), rcpt: true, est: !!est };
    }

    status(item, odo, now) {
        const last = this.last(item.id);
        if (!last) return { last: null, kmLeft: null, daysLeft: null, frac: null, state: 'none' };
        const kmLeft = isNum(item.km) && isNum(odo) ? item.km - (odo - last.km) : null;
        const daysLeft = isNum(item.months) ? Math.floor((last.t + item.months * MONTH - now) / 86400000) : null;
        const fk = kmLeft === null ? null : kmLeft / item.km;
        const ft = daysLeft === null ? null : daysLeft / (item.months * 30.44);
        const frac = fk === null ? ft : ft === null ? fk : Math.min(fk, ft);
        const due = (kmLeft !== null && kmLeft <= 0) || (daysLeft !== null && daysLeft <= 0);
        const soon = (kmLeft !== null && kmLeft <= Math.max(1000, item.km * 0.1)) || (daysLeft !== null && daysLeft <= 30);
        return { last, kmLeft, daysLeft, frac, state: due ? 'due' : soon ? 'soon' : 'ok' };
    }

    press(id, odo, now) {
        const lg = this.log[id], last = lg && lg.length ? lg[lg.length - 1] : null;
        if (last && last.fresh && now - last.t < UNDO_MS && (!this.pending || this.pending.id !== id)) {
            this.log[id].pop();
            if (!this.log[id].length) delete this.log[id];
            this.pending = null; this.ver++;
            return { kind: 'undone', id };
        }
        if (!isNum(odo)) { this.pending = null; return { kind: 'noodo', id }; }
        if (this.pending && this.pending.id === id && now - this.pending.t < CONFIRM_MS) {
            const a = this.log[id] || (this.log[id] = []);
            if (a.length && a[a.length - 1].fresh) delete a[a.length - 1].fresh;
            a.push({ t: now, km: Math.round(odo), fresh: true });
            while (a.length > KEEP) a.shift();
            this.pending = null; this.ver++;
            return { kind: 'done', id };
        }
        this.pending = { id, t: now };
        return { kind: 'confirm', id };
    }

    /** ждёт ли пункт id подтверждения сейчас */
    confirming(id, now) { return !!(this.pending && this.pending.id === id && now - this.pending.t < CONFIRM_MS); }

    /** сброс отметки "можно отменить" у отметок старше UNDO_MS (чтобы она не жила после перезапуска) */
    settle(now) {
        Object.keys(this.log).forEach((k) => {
            const e = this.log[k][this.log[k].length - 1];
            if (e.fresh && now - e.t >= UNDO_MS) { delete e.fresh; this.ver++; }
        });
    }

    toJSON() { return { log: this.log }; }
}

module.exports = { Service, BASE, CONFIRM_MS, UNDO_MS };
