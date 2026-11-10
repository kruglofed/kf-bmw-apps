'use strict';
/**
 * realdist.js - реальный пробег по скорости машины, независимо от одометра.
 *
 * Одометр в комбинации приборов может считать не всё (например, со стоп-пробегом), а скорость
 * центра масс машины (Vehicle2.statusCarSpeed2, считается из скоростей колёс) остаётся настоящей:
 * иначе бы врал спидометр. Путь = сумма скорость x время между показаниями.
 *
 *   const rd = new RealDistance(saved);
 *   rd.speed(now, kmh)   на каждое показание скорости (null - скорость неизвестна)
 *   rd.tick(now)         раз в секунду: досчитывает, если скорость давно не менялась
 *   rd.car(odo)          показание одометра машины - для сравнения
 *   rd.odo(offsetKm)     реальный пробег: одометр при первом запуске + насчитанное + поправка
 *   rd.counted, rd.trip, rd.ratio(), rd.toJSON()
 *
 * Скорость, которая не меняется, приходит реже, поэтому последнее показание держится до HOLD_MS;
 * дальше путь не считается (машина уснула, сигнал пропал).
 */
const HOLD_MS = 10000;    // столько держим последнюю скорость, если новых показаний нет
const MAX_KMH = 320;

const isNum = (x) => typeof x === 'number' && isFinite(x);

class RealDistance {
    constructor(saved, calib) {
        const s = saved && typeof saved === 'object' ? saved : {};
        this.carOdo0 = isNum(s.carOdo0) ? s.carOdo0 : null;   // одометр машины при начале учёта
        this.counted = isNum(s.counted) ? s.counted : 0;        // км по скорости с начала учёта
        this.start = isNum(s.start) ? s.start : null;           // когда начат учёт
        this.carOdo = null;                                      // одометр машины сейчас
        this.calib = isNum(calib) ? calib : 1;
        this.last = null;                                        // [t, км/ч] последнего показания
        this.at = null;                                          // до какого момента уже досчитано
        this.trip = { km: 0, moveMs: 0 };                        // с запуска головного устройства
        this.ver = 0;
    }

    add(now) {
        if (!this.last || this.at === null) return;
        const to = Math.min(now, this.last[0] + HOLD_MS);
        const dt = to - this.at;
        if (dt <= 0) return;
        this.at = to;
        const v = this.last[1];
        if (v <= 0.5) return;
        const km = v * this.calib * dt / 3600000;
        this.counted += km;
        this.trip.km += km;
        this.trip.moveMs += dt;
        this.ver++;
    }

    speed(now, kmh) {
        if (!isNum(kmh) || kmh < 0 || kmh > MAX_KMH) { this.add(now); this.last = null; this.at = null; return; }
        this.add(now);
        this.last = [now, kmh];
        this.at = now;
        if (this.start === null) { this.start = now; this.ver++; }
    }

    tick(now) { this.add(now); }

    car(odo) {
        if (!isNum(odo) || odo <= 0) return;
        this.carOdo = odo;
        if (this.carOdo0 === null) { this.carOdo0 = odo; this.ver++; }
    }

    /** реальный пробег, км; null, пока одометр машины ни разу не пришёл */
    odo(offsetKm) {
        if (this.carOdo0 === null) return null;
        return this.carOdo0 + this.counted + (isNum(offsetKm) ? offsetKm : 0);
    }

    /** какую долю реального пути насчитал одометр машины с начала учёта (0.34 = 34 %) */
    ratio() {
        if (this.carOdo0 === null || this.carOdo === null || this.counted < 5) return null;
        return Math.max(0, this.carOdo - this.carOdo0) / this.counted;
    }

    toJSON() { return { carOdo0: this.carOdo0, counted: Math.round(this.counted * 1000) / 1000, start: this.start }; }
}

/**
 * Реальный запас хода, км.
 * Лучше всего - остаток в баке на реальный расход (л/100 км по реальным км).
 * Пока расхода нет - запас хода машины, пересчитанный в реальные км: машина считает его
 * в км своего одометра, а одометр насчитывает только долю ratio реального пути.
 * Возвращает { km, how: 'cons' | 'ratio' } или null.
 */
function realRange(tank, avg, carRange, ratio) {
    if (isNum(tank) && isNum(avg) && avg > 0) return { km: tank / avg * 100, how: 'cons' };
    if (isNum(carRange) && carRange >= 0 && isNum(ratio) && ratio >= 0.05 && ratio <= 1.2) return { km: carRange / ratio, how: 'ratio' };
    return null;
}

module.exports = { RealDistance, realRange };
