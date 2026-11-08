'use strict';
/**
 * drive.js - езда по дням: путь, время в движении, средняя и максимальная скорость, резкость
 * (разгоны, торможения, повороты) и рейтинг экономичности 0-100.
 *
 * Продольное ускорение считается по изменению скорости за 1 с (не зависит от уклона дороги), боковое -
 * по датчику машины (CDS2.statusLateralAccelerationMassCenter). Событие ("резкий разгон") - пока
 * ускорение выше порога; следующее засчитывается, только когда ускорение упало ниже 60 % порога.
 *
 *   const dv = new Drive(saved);
 *   dv.speed(now, kmh, dKm, dMs)   скорость и прирост пути / времени в движении из realdist.js
 *   dv.move(now, dKm, dMs)         прирост пути без нового показания скорости
 *   dv.lat(now, ms2)               боковое ускорение, м/с^2
 *   dv.day(key)                    { km, moveMs, vmax, acc, brk, turn, posA, posT } или null
 *   rate(d)                        { score, label, parts } или null (меньше 5 км)
 */
const ACC = 2.5, BRK = -3.0, TURN = 4.0;      // м/с^2: резкий разгон, торможение, поворот
const SMOOTH_MS = 1000, KEEP_DAYS = 60, DAY = 86400000;

const isNum = (x) => typeof x === 'number' && isFinite(x);
const pad = (n) => (n < 10 ? '0' : '') + n;
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const blank = () => ({ km: 0, moveMs: 0, vmax: 0, acc: 0, brk: 0, turn: 0, posA: 0, posT: 0 });

class Drive {
    constructor(saved) {
        const s = saved && typeof saved === 'object' ? saved : {};
        this.days = {};
        if (s.days && typeof s.days === 'object') {
            Object.keys(s.days).forEach((k) => {
                const d = s.days[k];
                if (/^\d{4}-\d\d-\d\d$/.test(k) && d && isNum(d.km)) this.days[k] = Object.assign(blank(), d);
            });
        }
        this.hist = [];             // [t, км/ч] за последние ~2 с
        this.inAcc = false; this.inBrk = false; this.inTurn = false;
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

    /** прирост пути и времени в движении (из realdist.js) */
    move(now, dKm, dMs) {
        const d = this.cur(now);
        if (isNum(dKm) && dKm > 0) { d.km += dKm; this.ver++; }
        if (isNum(dMs) && dMs > 0) d.moveMs += dMs;
    }

    speed(now, kmh, dKm, dMs) {
        this.move(now, dKm, dMs);
        if (!isNum(kmh)) { this.hist = []; return; }
        const d = this.cur(now);
        if (kmh > d.vmax && kmh < 320) { d.vmax = kmh; this.ver++; }
        this.hist.push([now, kmh]);
        while (this.hist.length > 2 && now - this.hist[1][0] >= SMOOTH_MS) this.hist.shift();
        const o = this.hist[0], dt = now - o[0];
        if (dt < SMOOTH_MS * 0.8 || dt > SMOOTH_MS * 3) return;
        const a = (kmh - o[1]) / 3.6 / (dt / 1000);          // м/с^2
        if (a > 0.3 && kmh > 3) { d.posA += a * dt / 1000; d.posT += dt / 1000; }
        if (!this.inAcc && a >= ACC) { this.inAcc = true; d.acc++; this.ver++; } else if (this.inAcc && a < ACC * 0.6) this.inAcc = false;
        if (!this.inBrk && a <= BRK) { this.inBrk = true; d.brk++; this.ver++; } else if (this.inBrk && a > BRK * 0.6) this.inBrk = false;
    }

    lat(now, ms2) {
        if (!isNum(ms2)) return;
        const a = Math.abs(ms2), d = this.cur(now);
        if (!this.inTurn && a >= TURN) { this.inTurn = true; d.turn++; this.ver++; } else if (this.inTurn && a < TURN * 0.6) this.inTurn = false;
    }

    day(key) { return this.days[key] || null; }

    /** последние n дней, новые сверху: [[key, day|null]] */
    list(now, n) {
        const out = [];
        for (let i = 0; i < n; i++) { const k = dayKey(now - i * DAY); out.push([k, this.days[k] || null]); }
        return out;
    }

    toJSON() {
        const days = {};
        Object.keys(this.days).forEach((k) => {
            const d = this.days[k];
            days[k] = { km: Math.round(d.km * 100) / 100, moveMs: Math.round(d.moveMs), vmax: Math.round(d.vmax * 10) / 10,
                acc: d.acc, brk: d.brk, turn: d.turn, posA: Math.round(d.posA * 100) / 100, posT: Math.round(d.posT * 10) / 10 };
        });
        return { days };
    }
}

/** сложение дней (для недели): тот же формат, что день */
function sum(days) {
    const s = blank();
    days.filter(Boolean).forEach((d) => {
        ['km', 'moveMs', 'acc', 'brk', 'turn', 'posA', 'posT'].forEach((f) => { s[f] += d[f] || 0; });
        s.vmax = Math.max(s.vmax, d.vmax || 0);
    });
    return s;
}

/**
 * Рейтинг экономичности, 100 - идеально плавно. Штрафы: резкие разгоны и торможения на 100 км (до 35
 * каждый), резкие повороты (до 15), средний разгон выше 0,5 м/с^2 (до 15).
 */
function rate(d) {
    if (!d || d.km < 5) return null;
    const per = 100 / d.km;
    const A = d.acc * per, B = d.brk * per, C = d.turn * per, P = d.posT > 0 ? d.posA / d.posT : 0;
    const parts = {
        acc: Math.min(35, A * 2.5), brk: Math.min(35, B * 3), turn: Math.min(15, C * 1.5), smooth: Math.min(15, Math.max(0, P - 0.5) * 40),
        perAcc: A, perBrk: B, perTurn: C, avgAcc: P,
    };
    const score = Math.max(0, Math.round(100 - parts.acc - parts.brk - parts.turn - parts.smooth));
    const label = score >= 85 ? 'Экономично' : score >= 70 ? 'Спокойно' : score >= 50 ? 'Активно' : 'Агрессивно';
    return { score, label, parts };
}

module.exports = { Drive, rate, sum, dayKey, ACC, BRK, TURN };
