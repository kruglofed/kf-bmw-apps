'use strict';
/**
 * today.js - день по времени: когда машину завели и когда закончили ехать, сколько работал двигатель
 * (и сколько из этого на месте), сколько раз заводили, сколько было остановок.
 *
 * Зовётся раз в секунду: tick(now, rpm, kmh). rpm - обороты двигателя (CDS.statusEngineSpeed2), null -
 * не известно; kmh - скорость. Промежуток между вызовами больше 5 с не засчитывается (головное
 * устройство спало).
 *
 *   const td = new Today(saved);
 *   td.tick(now, rpm, kmh)
 *   td.day(key) -> { on0, on1, onMs, eng0, eng1, engMs, idleMs, starts, stops, mv0, mv1 } или null
 *     on0/on1      первое и последнее время, когда приложение работало (машина включена)
 *     eng0/eng1    первый запуск и последняя работа двигателя; engMs - сколько работал; idleMs - на месте
 *     starts       сколько раз заводили (переход от «не работает» к «работает»)
 *     stops        остановки: после движения машина стояла STOP_MS и дольше (светофор, пробка, парковка)
 *     mv0/mv1      начало и конец движения за день (конец маршрута - mv1)
 * Node 8: без ?. и ??.
 */
const ENGINE_RPM = 400;        // ниже - двигатель не работает (на выбеге гибрида бывает 160)
const MOVE_KMH = 3, STILL_KMH = 1, STOP_MS = 30000, GAP_MS = 5000, KEEP_DAYS = 60;

const isNum = (x) => typeof x === 'number' && isFinite(x);
const pad = (n) => (n < 10 ? '0' : '') + n;
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const blank = () => ({ on0: null, on1: null, onMs: 0, eng0: null, eng1: null, engMs: 0, idleMs: 0, starts: 0, stops: 0, mv0: null, mv1: null });

class Today {
    constructor(saved) {
        const s = saved && typeof saved === 'object' ? saved : {};
        this.days = {};
        if (s.days && typeof s.days === 'object') {
            Object.keys(s.days).forEach((k) => { if (/^\d{4}-\d\d-\d\d$/.test(k) && s.days[k] && typeof s.days[k] === 'object') this.days[k] = Object.assign(blank(), s.days[k]); });
        }
        this.last = null;          // время прошлого вызова
        this.running = false;      // двигатель работал на прошлом вызове
        this.moved = false;        // было движение после последней засчитанной остановки
        this.still = null;         // с какого момента машина стоит
        this.counted = false;      // эта остановка уже засчитана
        this.ver = 0;
    }

    cur(now) {
        const k = dayKey(now);
        if (!this.days[k]) {
            this.days[k] = blank();
            const keys = Object.keys(this.days).sort();
            while (keys.length > KEEP_DAYS) delete this.days[keys.shift()];
        }
        return this.days[k];
    }

    tick(now, rpm, kmh) {
        const d = this.cur(now), dt = this.last !== null && now > this.last && now - this.last <= GAP_MS ? now - this.last : 0;
        this.last = now;
        if (d.on0 === null) d.on0 = now;
        d.on1 = now; d.onMs += dt;
        // двигатель
        if (isNum(rpm)) {
            const run = rpm >= ENGINE_RPM;
            if (run) {
                if (!this.running) { d.starts++; this.ver++; }
                if (d.eng0 === null) d.eng0 = now;
                d.eng1 = now; d.engMs += dt;
                if (isNum(kmh) && kmh < STILL_KMH) d.idleMs += dt;
            }
            this.running = run;
        }
        // движение и остановки
        if (isNum(kmh)) {
            if (kmh >= MOVE_KMH) {
                if (d.mv0 === null) { d.mv0 = now; this.ver++; }
                d.mv1 = now;
                this.moved = true; this.still = null; this.counted = false;
            } else if (kmh < STILL_KMH && this.moved) {
                if (this.still === null) this.still = now;
                if (!this.counted && now - this.still >= STOP_MS) { d.stops++; this.counted = true; this.moved = false; this.ver++; }
            }
        }
    }

    day(key) { return this.days[key] || null; }

    toJSON() { return { days: this.days }; }
}

module.exports = { Today, ENGINE_RPM, STOP_MS };
