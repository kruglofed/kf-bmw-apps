'use strict';
/**
 * prices.js - цена топлива по заправкам.
 *
 * Цена задаётся для бака: она действует с момента заправки, с которой залито топливо, до следующей
 * смены цены. Поэтому поправить цену можно и через несколько дней после заправки - пересчитаются
 * все дни и заправки с этого бака, а прошлые баки сохранят свою цену.
 *
 *   const pr = new Prices(saved, 81);
 *   pr.at(t)          цена, руб/л, действующая в момент t
 *   pr.set(from, p)   цена p с момента from (заправки); более поздние записи заменяются
 *   pr.toJSON()
 */
const KEEP = 100, MIN = 10, MAX = 500;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const round2 = (x) => Math.round(x * 100) / 100;

class Prices {
    constructor(saved, first) {
        const s = saved && typeof saved === 'object' ? saved : {};
        this.first = isNum(s.first) ? s.first : isNum(first) ? first : 81;   // цена до первой записи
        this.list = Array.isArray(s.list) ? s.list.filter((e) => e && isNum(e.t) && isNum(e.p)).sort((a, b) => a.t - b.t) : [];
        this.ver = 0;
    }

    at(t) {
        let p = this.first;
        for (const e of this.list) { if (e.t <= t) p = e.p; else break; }
        return p;
    }

    set(from, p) {
        p = round2(Math.min(MAX, Math.max(MIN, p)));
        this.list = this.list.filter((e) => e.t < from);
        this.list.push({ t: from, p });
        while (this.list.length > KEEP) this.list.shift();
        this.ver++;
        return p;
    }

    toJSON() { return { list: this.list, first: this.first }; }
}

module.exports = { Prices };
