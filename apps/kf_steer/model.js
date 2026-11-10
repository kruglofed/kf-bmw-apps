'use strict';
/**
 * model.js - расчёты «Рулёжки» без экрана (их проверяет tests/test_kf_steer.js).
 *
 * Знаки везде одни: плюс = вправо. Угол руля и колёс плюс - поворот вправо, рыскание плюс - машина
 * вращается по часовой (вправо), боковое ускорение плюс - к правому борту.
 *
 *   decodeSteer(raw)            сырое слово угла руля -> градусы руля или null (служебные коды, мусор)
 *   new SteerFilter()           два источника угла руля -> одно чистое значение без скачков
 *   new SignLearner()           подстраивает знак рыскания / бокового ускорения под знак руля
 *   frontWheels(sw, ratio)      углы левого и правого переднего колеса (Аккерман)
 *   rearModel(front, kmh)       угол задних колёс по алгоритму интегральной рейки (модель)
 *   rearFromYaw(...)            угол задних колёс, обратно посчитанный по рысканию (проверка модели)
 *   wheelSpeeds(...)            скорость и обороты каждого колеса по скорости и рысканию
 *   driveForces(...)            тяга (или торможение) на каждом колесе: всего - по ускорению, доли - модель xDrive
 *
 * Node 8: без ?. и ??.
 */

// BMW G05 xDrive30d (с водителем)
const CAR = {
    L: 2.975,          // колёсная база, м
    trackF: 1.666,     // колея перед, м
    trackR: 1.687,     // колея зад, м
    mass: 2250,        // кг
    rTyre: 0.37,       // динамический радиус колеса, м (275/45 R20, 265/50 R19 - около 0,37)
    crr: 0.012,        // сопротивление качению
    cdA: 0.95,         // Cx * площадь, м²
    rearMax: 3.0,      // интегральная рейка G05: задние колёса до 3°
};
const G0 = 9.80665;
const MAX_SW = 800;               // больше этого руль G05 не поворачивается: всё, что дальше, - мусор
const STALE_MS = 3000;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => clamp(x, 0, 1);
const RAD = Math.PI / 180;

/**
 * ActualSteeringAngleDriver.actualValueSteeringAngleDriver: 16 бит со знаком, 0,04395° на единицу.
 * 0x7FFF, 0x8000 и 0xFFFF - «нет значения» / «ошибка»: раньше 0x8000 превращался в -1440°, и колёса
 * на кадр улетали влево до упора.
 */
function decodeSteer(raw) {
    let r = raw;
    if (typeof r === 'string' && /^-?\d+$/.test(r)) r = Number(r);
    if (!isNum(r)) return null;
    r = Math.round(r);
    if (r < -32768 || r > 65535) return null;
    const s = r >= 32768 ? r - 65536 : r;
    if (s === -32768 || s === 32767 || r === 65535) return null;
    const deg = s * 0.04395;
    return Math.abs(deg) > MAX_SW ? null : deg;
}

/**
 * Угол руля приходит в двух полях: ActualSteeringAngleDriver (с контрольной суммой) и
 * actualSteeringAngleDriverNoCRC. Раньше оба писали в одно значение по очереди, и если они
 * расходились, картинка дёргалась. Теперь главное - поле с CRC; второе берётся, только если
 * главное молчит больше 0,5 с. Одиночный скачок дальше, чем руль физически успеет повернуться,
 * не принимается, пока следующее значение его не подтвердит.
 */
class SteerFilter {
    constructor() {
        this.src = {};            // src -> { v, at }
        this.v = null; this.at = 0; this.source = null;
        this.pending = null;
        this.spikes = 0; this.bad = 0; this.badAlt = 0; this.disagree = 0; this.n = 0;
    }
    feed(src, deg, now) {
        if (!isNum(deg)) { if (src === 'crc') this.bad++; else this.badAlt++; return; }
        this.src[src] = { v: deg, at: now };
        const main = this.src.crc;
        if (src !== 'crc' && main && now - main.at < 500) {
            if (Math.abs(main.v - deg) > 15) this.disagree++;
            return;
        }
        if (this.v !== null && now - this.at < 600) {
            const dt = Math.max(0.02, (now - this.at) / 1000);
            const allowed = 60 + 1000 * dt;         // руль быстрее ~1000°/с не крутят
            if (Math.abs(deg - this.v) > allowed) {
                const p = this.pending;
                if (!(p && Math.abs(deg - p.v) < 30 && now - p.at < 600)) {
                    this.pending = { v: deg, at: now };
                    this.spikes++;
                    return;
                }
            }
        }
        this.pending = null;
        this.v = deg; this.at = now; this.source = src; this.n++;
    }
    value(now) { return this.v !== null && now - this.at < STALE_MS ? this.v : null; }
}

/**
 * Знак рыскания и бокового ускорения у BMW может быть обратным нашему (у них плюс - влево). На ходу
 * в повороте руль, рыскание и ускорение направлены в одну сторону - по этому знак подбирается сам.
 */
class SignLearner {
    constructor() { this.score = 0; }
    feed(sw, x, kmh, minX) {
        if (!(isNum(sw) && isNum(x) && isNum(kmh))) return;
        if (kmh < 12 || Math.abs(sw) < 25 || Math.abs(x) < minX) return;
        this.score = clamp(this.score + (sw * x > 0 ? 1 : -1), -60, 60);
    }
    sign() { return this.score <= -5 ? -1 : 1; }
}

/** Передние колёса: средний угол = руль / передаточное число; внутреннее колесо круче (Аккерман). */
function frontWheels(sw, ratio, car) {
    car = car || CAR;
    if (!isNum(sw)) return null;
    const mean = clamp(sw / (ratio || 15), -42, 42);
    if (Math.abs(mean) < 0.05) return { mean, left: mean, right: mean };
    const R = car.L / Math.tan(Math.abs(mean) * RAD), half = car.trackF / 2;
    const inner = Math.atan(car.L / (R - half)) / RAD, outer = Math.atan(car.L / (R + half)) / RAD;
    const sg = mean > 0 ? 1 : -1;
    // поворот вправо: правое колесо внутреннее
    return mean > 0 ? { mean, left: sg * outer, right: sg * inner } : { mean, left: sg * inner, right: sg * outer };
}

/**
 * Интегральная активная рейка G05: до ~60 км/ч задние колёса поворачивают в обратную сторону
 * (до 3°, машина разворачивается короче), выше - в ту же сторону, что и передние (устойчивость при
 * перестроении). Это модель алгоритма, а не показание датчика.
 */
function rearModel(front, kmh, car) {
    car = car || CAR;
    if (!isNum(front)) return null;
    const v = isNum(kmh) ? Math.max(0, kmh) : 0;
    let k;
    if (v <= 60) k = -0.085 * clamp01((60 - v) / 40);      // полная обратная фаза до 20 км/ч
    else k = 0.12 * clamp01((v - 60) / 40);                  // попутная фаза с 60, полностью к 100 км/ч
    return clamp(front * k, -car.rearMax, car.rearMax);
}

/**
 * Обратный счёт угла задних колёс по рысканию: в установившемся повороте
 * рыскание = v · (tg δперед − tg δзад) / L. Поправка на недостаточную поворачиваемость ~2°/g.
 * Надёжно только на 8–60 км/ч и при боковом ускорении до 0,35 g; иначе null.
 */
function rearFromYaw(front, yawDps, kmh, gLat, car) {
    car = car || CAR;
    if (!(isNum(front) && isNum(yawDps) && isNum(kmh))) return null;
    if (kmh < 8 || kmh > 60 || (isNum(gLat) && Math.abs(gLat) > 0.35)) return null;
    if (Math.abs(front) < 2) return null;
    const v = kmh / 3.6, eff = front - 2.0 * (isNum(gLat) ? gLat : 0);
    const t = Math.tan(eff * RAD) - (yawDps * RAD) * car.L / v;
    const d = Math.atan(t) / RAD;
    return Math.abs(d) > 8 ? null : d;
}

/**
 * Скорость каждого колеса (км/ч и об/мин). Кузов вращается с рысканием ω вокруг вертикали;
 * точка на расстоянии y от оси машины (плюс - вправо) едет со скоростью v − ω·y вдоль, а поперёк
 * ось едет со скоростью, которую задают её колёса. В повороте наружные колёса крутятся быстрее,
 * передние - быстрее задних (они идут по большему радиусу). Без рыскания ω берётся из геометрии.
 */
function wheelSpeeds(kmh, yawDps, front, rear, car) {
    car = car || CAR;
    if (!isNum(kmh)) return null;
    const vx = Math.max(0, kmh) / 3.6, dr = isNum(rear) ? rear : 0, df = isNum(front) ? front : 0;
    const w = isNum(yawDps) ? yawDps * RAD : vx * (Math.tan(df * RAD) - Math.tan(dr * RAD)) / car.L;
    const vyR = vx * Math.tan(dr * RAD), vyF = vyR + w * car.L;
    const one = (y, vy) => {
        const v = Math.hypot(Math.max(0, vx - w * y), vy);
        return { kmh: v * 3.6, rpm: v / (2 * Math.PI * car.rTyre) * 60 };
    };
    const r = {
        fl: one(-car.trackF / 2, vyF), fr: one(car.trackF / 2, vyF),
        rl: one(-car.trackR / 2, vyR), rr: one(car.trackR / 2, vyR),
    };
    const avg = (r.fl.rpm + r.fr.rpm + r.rl.rpm + r.rr.rpm) / 4;
    ['fl', 'fr', 'rl', 'rr'].forEach((k) => { r[k].diff = avg > 5 ? (r[k].rpm / avg - 1) * 100 : 0; });
    r.avgRpm = avg;
    return r;
}

/**
 * Тяга на колёсах. Всего: m·a (датчик ускорения уже учитывает уклон) + качение + воздух.
 * Деление перёд/зад - модель xDrive: муфта раздатки (VTG) в равномерном движении отдаёт почти всё
 * назад, при разгоне подключает перёд (до ~45 %, с места до ~55 %), в повороте снова больше
 * назад - для поворачиваемости. Межколёсные дифференциалы свободные: левое и правое колесо оси
 * получают одинаковую тягу, а крутятся с разной скоростью. Торможение: ~60 % на переднюю ось.
 */
function driveForces(s, car) {
    car = car || CAR;
    s = s || {};
    const kmh = isNum(s.kmh) ? Math.max(0, s.kmh) : null, gL = s.gLong, gY = isNum(s.gLat) ? Math.abs(s.gLat) : 0;
    if (!isNum(gL) || kmh === null) return null;
    const v = kmh / 3.6, m = car.mass;
    let F = m * G0 * gL;
    if (kmh > 1) F += car.crr * m * G0 + 0.5 * 1.2 * car.cdA * v * v;
    let mode = 'drive', front;
    if (kmh < 1 && Math.abs(gL) < 0.03) { F = 0; mode = 'idle'; }
    if (F >= 0) {
        const a = F / (m * G0);
        front = 0.10 + 0.35 * clamp01(a / 0.30);
        if (kmh < 25) front += 0.10 * clamp01(a / 0.15);
        front -= 0.15 * clamp01((gY - 0.25) / 0.30) * clamp01(a / 0.10 + 0.3);
        front = clamp(front, 0.05, 0.55);
        if (F < 300) mode = mode === 'idle' ? 'idle' : 'coast';
    } else { mode = 'brake'; front = 0.60; }
    const Ff = F * front, Fr = F - Ff;
    return {
        total: F, front: Ff, rear: Fr, shareF: front, mode,
        wheels: { fl: Ff / 2, fr: Ff / 2, rl: Fr / 2, rr: Fr / 2 },
    };
}

module.exports = { CAR, G0, MAX_SW, decodeSteer, SteerFilter, SignLearner, frontWheels, rearModel, rearFromYaw, wheelSpeeds, driveForces, clamp, isNum };
