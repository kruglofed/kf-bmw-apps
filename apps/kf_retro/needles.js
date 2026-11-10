'use strict';
/**
 * needles.js - как ведут себя стрелки старых приборов (без экрана, проверяет tests/test_kf_retro.js).
 *
 *   const n = new Needle({ min: 0, max: 180, w: 9, z: 0.55, jitter: 0, cable: 0.012 });
 *   n.update(target, dt, rnd, k)  -> положение стрелки в единицах шкалы
 *
 * Стрелка - груз на пружине с демпфером: w - собственная частота (1/с), z - демпфирование
 * (меньше 1 - перелетает и качается). Сверху:
 *   jitter  дрожание (тахометр «Жигулей»): шум в единицах шкалы и случайные толчки kick;
 *   cable   «гуляние» от тросика спидометра: доля показания, качается ~3 Гц и растёт со скоростью;
 *   упоры   stopMin / stopMax: стрелка о них стукается и отскакивает (пропала связь - падает на ноль).
 * k - общий множитель дрожания из настроек (0 - выкл, 1 - как в жизни, 2 - сильно).
 * Node 8: без ?. и ??.
 */
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** детерминированный генератор (для тестов и демо) */
function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

class Needle {
    constructor(o) {
        o = o || {};
        this.min = isNum(o.min) ? o.min : 0;
        this.max = isNum(o.max) ? o.max : 100;
        this.stopMin = isNum(o.stopMin) ? o.stopMin : this.min;
        this.stopMax = isNum(o.stopMax) ? o.stopMax : this.max + (this.max - this.min) * 0.03;
        this.rest = isNum(o.rest) ? o.rest : this.stopMin;   // куда падает без сигнала
        this.w = o.w || 10;
        this.z = isNum(o.z) ? o.z : 0.7;
        this.jitter = o.jitter || 0;
        this.kick = o.kick || 0;          // размах толчка (единиц шкалы в секунду)
        this.kickRate = o.kickRate || 0;  // толчков в секунду
        this.cable = o.cable || 0;
        this.x = this.rest; this.v = 0; this.t = 0; this.nz = 0;
        this.sweepUntil = 0;
    }
    /** прогон до максимума и обратно (как у BMW при включении) */
    sweep(ms) { this.sweepT = 0; this.sweepMs = ms || 1400; }
    update(target, dt, rnd, k) {
        rnd = rnd || Math.random;
        k = isNum(k) ? k : 1;
        dt = clamp(isNum(dt) ? dt : 0, 0, 0.25);
        this.t += dt;
        let T = isNum(target) ? target : this.rest;
        if (isNum(this.sweepT)) {
            this.sweepT += dt * 1000;
            const half = this.sweepMs / 2;
            if (this.sweepT < half) T = this.max;
            else if (this.sweepT < this.sweepMs) T = this.min;
            else this.sweepT = null;
        }
        const live = isNum(target) && !isNum(this.sweepT);
        if (live && k > 0) {
            if (this.jitter) {
                // сглаженный шум ~6 Гц
                const a = Math.min(1, dt * 38);
                this.nz += ((rnd() - 0.5) * 2 * this.jitter * k - this.nz) * a;
                T += this.nz;
            }
            if (this.cable) {
                const amp = this.cable * k * T * (0.6 + 0.4 * Math.sin(this.t * 0.9));
                T += amp * Math.sin(this.t * 2 * Math.PI * 2.8);
            }
            if (this.kickRate && rnd() < this.kickRate * k * dt) this.v += (rnd() - 0.5) * 2 * this.kick * k;
        }
        // пружина + демпфер, мелкими шагами
        let left = dt;
        while (left > 1e-9) {
            const h = Math.min(left, 0.004);
            const a = this.w * this.w * (T - this.x) - 2 * this.z * this.w * this.v;
            this.v += a * h; this.x += this.v * h;
            if (this.x < this.stopMin) { this.x = this.stopMin; if (this.v < 0) this.v = -this.v * 0.25; }
            if (this.x > this.stopMax) { this.x = this.stopMax; if (this.v > 0) this.v = -this.v * 0.25; }
            left -= h;
        }
        return this.x;
    }
}

/** угол стрелки (градусы по часовой от 12 часов) для значения v на шкале min..max -> a0..a1 */
function angleOf(v, min, max, a0, a1) {
    const f = (v - min) / (max - min);
    return a0 + f * (a1 - a0);
}

/**
 * Барабан одометра: машина присылает целые км, а последний барабан у старых приборов крутится
 * плавно. Между сменами показания доля км досчитывается по скорости (и не уходит за 0,99).
 */
class OdoRoll {
    constructor() { this.km = null; this.frac = 0; }
    update(odoKm, kmh, dt) {
        if (isNum(odoKm)) {
            if (this.km === null || odoKm !== this.km) { this.km = odoKm; this.frac = 0; }
        }
        if (this.km !== null && isNum(kmh) && kmh > 0) this.frac = Math.min(0.99, this.frac + kmh / 3600 * clamp(dt, 0, 0.25));
        return this.km === null ? null : this.km + this.frac;
    }
}

/** цифры барабанов: value с долей -> { digits: '012345', roll: доля последнего барабана } */
function drumDigits(value, n) {
    if (!isNum(value) || value < 0) return { digits: '0'.repeat(n), roll: 0 };
    const whole = Math.floor(value), s = String(whole % Math.pow(10, n));
    return { digits: '0'.repeat(Math.max(0, n - s.length)) + s, roll: value - whole };
}

module.exports = { Needle, OdoRoll, drumDigits, angleOf, rng, clamp, isNum };
