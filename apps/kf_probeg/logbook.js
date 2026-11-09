'use strict';
/**
 * logbook.js - пробег по дням и реальный расход по заправкам, только из того, что машина сама шлёт
 * головному устройству: одометр (km) и топливо в баке (л) от комбинации приборов.
 *
 * Одометр здесь - любой счётчик км, который только растёт: приложение передаёт реальный пробег,
 * посчитанный по скорости (realdist.js), а не одометр машины.
 *
 * Пробег. Для каждого дня хранятся первое и последнее показание одометра. Пробег за период = последнее
 * показание сейчас минус последнее показание до начала периода; дни, когда приложение не работало,
 * попадают в период того показания, которое пришло после них, поэтому километры не теряются.
 *
 * Заправки. Уровень бака сглаживается медианой последних показаний. Если он стал выше самого низкого
 * уровня с прошлой заправки на REFUEL_L литров и больше, пока машина стоит, это заправка. Расход за бак =
 * (уровень после прошлой заправки - уровень перед этой) / км между ними. Пока заправка не замечена ни
 * разу, отсчёт идёт от первого показания (бак помечен "неполный").
 *
 *   const lb = new Logbook(savedObject);
 *   lb.feed(now, { odo, tank, speed })   // примерно раз в секунду; null = сейчас не известно
 *       -> { refuel: {...} | null }      // замеченная заправка
 *   lb.kmSince(dayKey), lb.stats(now), lb.daily(now, n), lb.current(), lb.periods, lb.average()
 *   lb.fuel[dayKey]                      литров ушло из бака за день (по уровню, без заправок)
 *   lb.fuelCost(dayKey, priceAt)         стоимость этих литров: каждый литр - по цене бака, из которого он
 *                                        ушёл (priceAt(время заправки) из prices.js)
 *   lb.toJSON()
 */
const REFUEL_L = 5;          // рост уровня на столько литров и больше - заправка
const WINDOW = 7;            // показаний бака для медианы
const WINDOW_MS = 120000;    // старше этого показание в медиану не идёт
const KEEP_DAYS = 120, KEEP_PERIODS = 12;
const MAX_JUMP_KM = 3000;    // скачок одометра больше этого между показаниями - ошибка сигнала
const DAY = 86400000;

const isNum = (x) => typeof x === 'number' && isFinite(x);
const pad = (n) => (n < 10 ? '0' : '') + n;
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const round = (x, d) => Math.round(x * Math.pow(10, d)) / Math.pow(10, d);
const per100 = (km, l) => (isNum(km) && isNum(l) && km >= 20 && l > 0 ? l / km * 100 : null);
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

class Logbook {
    constructor(saved) {
        const s = saved && typeof saved === 'object' ? saved : {};
        this.days = {};
        if (s.days && typeof s.days === 'object') {
            Object.keys(s.days).forEach((k) => {
                const v = s.days[k];
                if (/^\d{4}-\d\d-\d\d$/.test(k) && Array.isArray(v) && isNum(v[0]) && isNum(v[1])) this.days[k] = [v[0], v[1]];
            });
        }
        this.odo = isNum(s.odo) ? s.odo : null;                     // последнее показание одометра
        this.fill = s.fill && isNum(s.fill.odo) && isNum(s.fill.tank) ? s.fill : null;   // с последней заправки
        this.low = isNum(s.low) ? s.low : null;                     // самый низкий уровень бака с последней заправки
        this.tank = isNum(s.tank) ? s.tank : null;                  // последний сглаженный уровень
        this.periods = Array.isArray(s.periods) ? s.periods.filter((p) => p && isNum(p.km) && isNum(p.l)).slice(-KEEP_PERIODS) : [];
        this.fuel = {};                                             // день -> литров ушло из бака
        if (s.fuel && typeof s.fuel === 'object') Object.keys(s.fuel).forEach((k) => { if (isNum(s.fuel[k])) this.fuel[k] = s.fuel[k]; });
        this.fuelBy = {};                                           // день -> { время заправки бака: литров }
        if (s.fuelBy && typeof s.fuelBy === 'object') Object.keys(s.fuelBy).forEach((k) => { if (s.fuelBy[k] && typeof s.fuelBy[k] === 'object') this.fuelBy[k] = s.fuelBy[k]; });
        this.win = [];                                              // [t, литры] - не сохраняется
        this.ver = 0;
    }

    feed(now, x) {
        let refuel = null;
        const odo = isNum(x.odo) && x.odo > 0 ? Math.round(x.odo * 100) / 100 : null;
        if (odo !== null) this.feedOdo(now, odo);
        if (isNum(x.tank) && x.tank >= 0 && x.tank < 200) refuel = this.feedTank(now, x.tank, isNum(x.speed) ? x.speed : null);
        return { refuel };
    }

    feedOdo(now, odo) {
        if (this.odo !== null && odo < this.odo) return;            // одометр назад не идёт: помеха
        if (this.odo !== null && odo - this.odo > MAX_JUMP_KM) {
            // большой скачок принимается, только если три показания подряд его подтверждают
            // (долгая поездка, пока приложение не работало), иначе это помеха
            const j = this.jump;
            this.jump = j && Math.abs(j.odo - odo) < 5 ? { odo, n: j.n + 1 } : { odo, n: 1 };
            if (this.jump.n < 3) return;
        }
        this.jump = null;
        const k = dayKey(now), d = this.days[k];
        if (!d) this.days[k] = [odo, odo];
        else if (d[1] !== odo) d[1] = odo;
        else if (this.odo === odo) return;
        this.odo = odo;
        this.ver++;
        const keys = Object.keys(this.days).sort();
        while (keys.length > KEEP_DAYS) delete this.days[keys.shift()];
    }

    feedTank(now, litres, speed) {
        this.win.push([now, litres]);
        while (this.win.length && (this.win.length > WINDOW || now - this.win[0][0] > WINDOW_MS)) this.win.shift();
        if (this.win.length < 3) return null;
        const lv = round(median(this.win.map((w) => w[1])), 1);
        if (lv !== this.tank) { this.tank = lv; this.ver++; }
        const odo = this.odo;
        if (!this.fill) {
            if (odo === null) return null;
            this.fill = { t: now, odo, tank: lv, partial: true };
            this.low = lv; this.ver++;
            return null;
        }
        if (this.low === null || lv < this.low) {
            if (this.low !== null) {
                // расход за день: насколько опустился самый низкий уровень с заправки
                const k = dayKey(now);
                this.fuel[k] = round((this.fuel[k] || 0) + this.low - lv, 2);
                const by = this.fuelBy[k] || (this.fuelBy[k] = {}), ft = String(this.fill.t);
                by[ft] = round((by[ft] || 0) + this.low - lv, 2);
                const keys = Object.keys(this.fuel).sort();
                while (keys.length > KEEP_DAYS) { const old = keys.shift(); delete this.fuel[old]; delete this.fuelBy[old]; }
            }
            this.low = lv; this.ver++; return null;
        }
        const standing = speed === null || speed < 3;
        if (standing && lv - this.low >= REFUEL_L && odo !== null) {
            const f = this.fill, km = odo - f.odo, l = round(f.tank - this.low, 1);
            const refuel = { t: now, odo, before: this.low, after: lv, added: round(lv - this.low, 1) };
            if (km >= 1) {
                this.periods.push({ start: f.t, end: now, odo0: f.odo, odo1: odo, km, l, added: refuel.added, partial: !!f.partial });
                while (this.periods.length > KEEP_PERIODS) this.periods.shift();
            }
            this.fill = { t: now, odo, tank: lv, added: refuel.added };
            this.low = lv;
            this.win = [];
            this.ver++;
            return refuel;
        }
        return null;
    }

    /** км с начала дня key (включительно) до последнего показания; null без данных */
    kmSince(key) {
        if (this.odo === null) return null;
        const keys = Object.keys(this.days).sort();
        let base = null;
        keys.forEach((k) => { if (k < key) base = this.days[k][1]; });
        if (base === null) {
            const first = keys.find((k) => k >= key);
            if (!first) return 0;
            base = this.days[first][0];
        }
        return Math.max(0, this.odo - base);
    }

    /** { today, yesterday, week, month, thisMonth, since } в км */
    stats(now) {
        const today = dayKey(now), y = dayKey(now - DAY), d = new Date(now);
        const monthStart = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01';
        const t = this.kmSince(today), ty = this.kmSince(y);
        const keys = Object.keys(this.days).sort();
        return {
            today: t,
            yesterday: t === null || ty === null ? null : ty - t,
            week: this.kmSince(dayKey(now - 6 * DAY)),
            month: this.kmSince(dayKey(now - 29 * DAY)),
            thisMonth: this.kmSince(monthStart),
            since: keys.length ? keys[0] : null,
        };
    }

    /** пробег по дням за последние n дней, новые сверху: [[key, km|null]] */
    daily(now, n) {
        const out = [];
        for (let i = 0; i < n; i++) {
            const k = dayKey(now - i * DAY), next = dayKey(now - (i - 1) * DAY);
            const a = this.kmSince(k), b = i === 0 ? 0 : this.kmSince(next);
            const known = !!this.days[k];
            out.push([k, a === null ? null : known ? a - b : 0]);
        }
        return out;
    }

    /** стоимость топлива за день; null - не известно */
    fuelCost(key, priceAt) {
        const by = this.fuelBy[key];
        if (!by) return isNum(this.fuel[key]) ? this.fuel[key] * priceAt(Date.now()) : null;
        return Object.keys(by).reduce((a, ft) => a + by[ft] * priceAt(Number(ft)), 0);
    }

    /** текущий бак: { km, l, avg, since, partial } или null */
    current() {
        const f = this.fill;
        if (!f || this.odo === null || this.tank === null) return null;
        const km = Math.max(0, this.odo - f.odo), l = Math.max(0, round(f.tank - this.tank, 1));
        return { km, l, avg: per100(km, l), since: f.t, odo: f.odo, partial: !!f.partial, added: f.added || null };
    }

    /** средний расход по сохранённым бакам: { km, l, avg } */
    average() {
        const ps = this.periods.filter((p) => p.km >= 20);
        const km = ps.reduce((a, p) => a + p.km, 0), l = ps.reduce((a, p) => a + p.l, 0);
        return { km, l, avg: per100(km, l), n: ps.length };
    }

    toJSON() {
        return { v: 2, odo: this.odo, tank: this.tank, low: this.low, fill: this.fill, periods: this.periods, days: this.days, fuel: this.fuel, fuelBy: this.fuelBy };
    }
}

module.exports = { Logbook, dayKey, per100, REFUEL_L };
