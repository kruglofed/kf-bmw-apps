'use strict';
/**
 * panels.js - семь приборных панелей в духе машин прошлых лет. Это не копии заводских приборов
 * и без эмблем: своя отрисовка «как тогда» - цвета, шкалы, повадки стрелок.
 *
 * Панель = {
 *   id, title,
 *   sweep        прогон стрелок до упора и обратно при открытии (как у BMW),
 *   needles      { ключ: { src, ...параметры Needle } }; src - что показывает: speed, rpm, coolant, oil, fuel (0..1),
 *   back(c)      неподвижная часть (рисуется один раз и кешируется),
 *   live(c, d, x) стрелки и всё живое; d - данные, x - положения стрелок по ключам
 * }
 * d = { speed, rpm, coolant, oil, fuel, fuelL, odo, time {h,m,s}, gear, stage, range, reserve, hot }.
 * Координаты - экран 1600 x 520, вкладки сверху до y = 44.
 */
const D = require('./draw');
const { angleOf } = require('./needles');

const { pt, withAlpha } = D;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const range = (from, to, step) => { const r = []; for (let v = from; v <= to + 1e-9; v += step) r.push(v); return r; };
const two = (n) => (n < 10 ? '0' : '') + n;
const hhmm = (t) => (t ? two(t.h) + ':' + two(t.m) : '--:--');
const gearText = (d) => (d.stage === 'P' || d.stage === 'R' || d.stage === 'N' ? d.stage : isNum(d.gear) && d.gear > 0 ? 'D' + d.gear : d.stage === 'D' ? 'D' : '');

/** круглый прибор со стрелкой: неподвижная часть */
function dialBack(c, g) {
    if (g.bezel) D.bezel(c, g.cx, g.cy, g.r, g.bezelW || 10, g.bezel);
    D.face(c, g.cx, g.cy, g.r, g.face, g.edge);
    (g.zones || []).forEach((z) => D.zone(c, g.cx, g.cy, g.r - (z.w || 14) - (z.inset || 4), g.r - (z.inset || 4), g.min, g.max, g.a0, g.a1, z.from, z.to, z.color));
    if (g.minor) D.ticks(c, g.cx, g.cy, { a0: g.a0, a1: g.a1, n: g.minor, every: g.minor / g.major, r: g.r - (g.tickInset || 6), len: g.len || 9, lenMajor: g.lenMajor || 20, w: g.tw || 2, wMajor: g.twMajor || 4, color: g.tick, colorMajor: g.tickMajor });
    if (g.labels) D.numbers(c, g.cx, g.cy, { a0: angleOf(g.labelFrom === undefined ? g.min : g.labelFrom, g.min, g.max, g.a0, g.a1), a1: angleOf(g.labelTo === undefined ? g.max : g.labelTo, g.min, g.max, g.a0, g.a1), labels: g.labels, r: g.numR || g.r * 0.72, size: g.numSize || 28, color: g.num, font: g.font });
    (g.texts || []).forEach((t) => c.text(t.s, g.cx + (t.dx || 0), g.cy + t.dy, t.size || 18, t.color || g.num, { align: 'center', font: t.font || 'label', literal: true, spacing: t.spacing || 0 }));
}
/** стрелка прибора */
function dialNeedle(c, g, v, o) {
    if (!isNum(v)) v = g.min;
    const a = angleOf(v, g.min, g.max, g.a0, g.a1);
    D.needle(c, g.cx + (o.px || 0), g.cy + (o.py || 0), a, o);
    if (o.hub !== false) D.hub(c, g.cx + (o.px || 0), g.cy + (o.py || 0), o.hubR || 14, o.hubColor, o.hubRing);
}

/* =================================================================== Москвич: ленточный спидометр */
const MOSK = (() => {
    const X0 = 380, X1 = 1220, VMAX = 180, faceC = '#0b0b0b', num = '#f2eee2';
    const water = { cx: 232, cy: 212, r: 78, min: 40, max: 120, a0: -60, a1: 60, face: faceC, bezel: 'chrome', bezelW: 8, minor: 8, major: 2, tick: num, len: 7, lenMajor: 14,
        labels: ['40', '80', '120'], numSize: 20, numR: 50, num, zones: [{ from: 105, to: 120, color: '#d8331f', w: 8 }], texts: [{ s: 'ВОДА', dy: 44, size: 16 }] };
    const oil = { cx: 232, cy: 398, r: 62, min: 40, max: 140, a0: -60, a1: 60, face: faceC, bezel: 'chrome', bezelW: 7, minor: 10, major: 2, tick: num, len: 6, lenMajor: 12,
        labels: ['40', '90', '140'], numSize: 17, numR: 38, num, texts: [{ s: 'МАСЛО °C', dy: 34, size: 14 }] };
    const fuel = { cx: 1368, cy: 212, r: 78, min: 0, max: 1, a0: -60, a1: 60, face: faceC, bezel: 'chrome', bezelW: 8, minor: 4, major: 2, tick: num, len: 8, lenMajor: 14,
        labels: ['0', '1/2', '1'], numSize: 20, numR: 50, num, zones: [{ from: 0, to: 0.12, color: '#d8331f', w: 8 }], texts: [{ s: 'БЕНЗИН', dy: 44, size: 16 }] };
    const clock = { cx: 1368, cy: 398, r: 62, face: faceC };
    const xOf = (v) => X0 + Math.max(0, Math.min(VMAX * 1.03, v)) / VMAX * (X1 - X0);
    return {
        id: 'moskvich', title: 'Москвич',
        needles: {
            spd: { src: 'speed', min: 0, max: VMAX, w: 7, z: 0.55, cable: 0.02, stopMax: VMAX * 1.03 },
            water: { src: 'coolant', min: 40, max: 120, w: 2, z: 1, stopMin: 38, stopMax: 122 },
            oil: { src: 'oil', min: 40, max: 140, w: 2, z: 1, stopMin: 38, stopMax: 142 },
            fuel: { src: 'fuel', min: 0, max: 1, w: 1, z: 1, stopMin: -0.03, stopMax: 1.03 },
        },
        back(c) {
            c.gradientRect(0, 0, 1600, 520, [[0, '#2b2019'], [1, '#120d0a']]);
            for (let y = 60; y < 520; y += 9) c.fillRect(0, y, 1600, 1, withAlpha('#000000', 0.18));
            c.roundRect(110, 66, 1380, 432, 44, '#0a0a0a');
            c.strokeRoundRect(110, 66, 1380, 432, 44, 5, '#9ea4aa');
            c.strokeRoundRect(117, 73, 1366, 418, 38, 1.5, '#3b3b3b');
            // окно ленты
            c.roundRect(330, 116, 940, 214, 20, '#060606');
            D.chromeBar(c, 330, 108, 940, 8); D.chromeBar(c, 330, 330, 940, 8);
            for (let v = 0; v <= VMAX; v += 5) {
                const x = xOf(v), big = v % 20 === 0, mid = v % 10 === 0;
                c.fillRect(x - (big ? 1.5 : 1), big ? 178 : mid ? 186 : 191, big ? 3 : 2, big ? 24 : mid ? 16 : 11, num);
                if (mid) c.fillRect(x - 1, 256, 2, 10, withAlpha(num, 0.7));
            }
            range(0, VMAX, 20).forEach((v) => c.text(String(v), xOf(v), 166, 30, num, { align: 'center', font: 'label', literal: true }));
            c.fillRect(X0 - 8, 212, X1 - X0 + 16, 38, '#181818');
            c.fillRect(X0 - 8, 212, X1 - X0 + 16, 3, withAlpha('#000000', 0.8));
            c.text('км/ч', 800, 300, 22, withAlpha(num, 0.7), { align: 'center', literal: true });
            [water, oil, fuel].forEach((g) => dialBack(c, g));
            D.bezel(c, clock.cx, clock.cy, clock.r, 7, 'chrome'); D.face(c, clock.cx, clock.cy, clock.r, faceC);
            D.clockFace(c, clock.cx, clock.cy, clock.r, { tick: num, num, size: 16 });
        },
        live(c, d, x) {
            // лента: зелёная до 60, жёлтая до 100, дальше красная
            const v = x.spd, xe = xOf(v), col = v < 60 ? ['#7be08a', '#2c8f3a'] : v < 100 ? ['#ffe07a', '#c79a12'] : ['#ff8a64', '#c1301a'];
            if (xe > X0 + 1) c.gradientRect(X0, 216, xe - X0, 30, [[0, col[0]], [1, col[1]]]);
            c.fillRect(xe - 2, 210, 4, 42, '#fff4e0');
            D.drum(c, 710, 348, 6, 30, 38, d.odo, { bg: '#111', fg: '#eee', lastBg: '#e8e2d0', lastFg: '#111', mask: '#0a0a0a', frame: '#555' });
            dialNeedle(c, water, x.water, { len: 64, tail: 12, w: 6, tip: 2, color: '#ff6a2a', hubR: 9 });
            dialNeedle(c, oil, x.oil, { len: 50, tail: 10, w: 5, tip: 2, color: '#ff6a2a', hubR: 8 });
            dialNeedle(c, fuel, x.fuel, { len: 64, tail: 12, w: 6, tip: 2, color: '#ff6a2a', hubR: 9 });
            D.clockHands(c, clock.cx, clock.cy, clock.r, d.time, { hand: '#f2eee2', second: '#ff6a2a', hub: '#111' });
            D.lamp(c, 520, 420, 110, 34, 'ПОВОРОТ', false, '#38c95a');
            D.lamp(c, 650, 420, 110, 34, 'РЕЗЕРВ', d.reserve, '#ffb020');
            D.lamp(c, 840, 420, 110, 34, 'ПЕРЕГРЕВ', d.hot, '#ff3b2a');
            D.lamp(c, 970, 420, 110, 34, 'ДАЛЬНИЙ', false, '#3d7bff');
        },
    };
})();

/* =================================================================== Жигули: два больших прибора, дёрганый тахометр */
const ZHIG = (() => {
    const faceC = '#080808', num = '#f4f4f2', tick = '#e9e9e6';
    const spd = { cx: 470, cy: 270, r: 185, min: 0, max: 180, a0: -135, a1: 135, face: faceC, bezel: 'chrome', bezelW: 12, minor: 36, major: 9, tick, len: 10, lenMajor: 24, tw: 2, twMajor: 4.5,
        labels: range(0, 180, 20).map(String), numSize: 32, numR: 136, num, texts: [{ s: 'км/ч', dy: -62, size: 22 }] };
    const tach = { cx: 1130, cy: 270, r: 185, min: 0, max: 8, a0: -135, a1: 135, face: faceC, bezel: 'chrome', bezelW: 12, minor: 40, major: 8, tick, len: 10, lenMajor: 24, tw: 2, twMajor: 4.5,
        labels: range(0, 8, 1).map(String), numSize: 36, numR: 136, num, zones: [{ from: 6, to: 8, color: '#d42a1c', w: 22, inset: 6 }],
        texts: [{ s: '×1000 об/мин', dy: 62, size: 20 }] };
    const temp = { cx: 800, cy: 168, r: 70, min: 50, max: 130, a0: -55, a1: 55, face: faceC, bezel: 'chrome', bezelW: 6, minor: 8, major: 4, tick, len: 7, lenMajor: 13,
        labels: ['50', '90', '130'], numSize: 18, numR: 44, num, zones: [{ from: 110, to: 130, color: '#d42a1c', w: 7 }], texts: [{ s: 'ВОДА °C', dy: 40, size: 14 }] };
    const fuel = { cx: 800, cy: 372, r: 70, min: 0, max: 1, a0: -55, a1: 55, face: faceC, bezel: 'chrome', bezelW: 6, minor: 4, major: 2, tick, len: 8, lenMajor: 13,
        labels: ['0', '1/2', '1'], numSize: 18, numR: 44, num, zones: [{ from: 0, to: 0.1, color: '#d42a1c', w: 7 }], texts: [{ s: 'БЕНЗИН', dy: 40, size: 14 }] };
    const N = { tip: 2.5, color: '#ff7a1c', hubColor: '#101010', hubRing: '#8a8f95' };
    return {
        id: 'zhiguli', title: 'Жигули',
        needles: {
            spd: { src: 'speed', min: 0, max: 180, w: 8, z: 0.6, cable: 0.012, stopMax: 186 },
            // тахометр с характером: мало демпфирования, шум и редкие толчки
            rpm: { src: 'rpm', scale: 0.001, min: 0, max: 8, w: 17, z: 0.3, jitter: 0.11, kick: 3.2, kickRate: 1.6, stopMax: 8.3 },
            temp: { src: 'coolant', min: 50, max: 130, w: 2, z: 1, stopMin: 47, stopMax: 133 },
            fuel: { src: 'fuel', min: 0, max: 1, w: 1, z: 1, stopMin: -0.04, stopMax: 1.04 },
        },
        back(c) {
            c.gradientRect(0, 0, 1600, 520, [[0, '#1b1b1b'], [1, '#090909']]);
            c.roundRect(150, 56, 1300, 426, 70, '#040404');
            c.strokeRoundRect(150, 56, 1300, 426, 70, 3, '#2d2d2d');
            D.wood(c, 0, 486, 1600, 34);
            [spd, tach, temp, fuel].forEach((g) => dialBack(c, g));
        },
        live(c, d, x) {
            D.drum(c, 470 - 72, 330, 6, 24, 32, d.odo, { bg: '#151515', fg: '#f0f0f0', lastBg: '#eeeeee', lastFg: '#111', mask: '#080808', frame: '#3a3a3a', size: 26 });
            D.lamp(c, 662, 258, 86, 28, 'ЗАРЯД', false, '#ff3b2a', 13);
            D.lamp(c, 757, 258, 86, 28, 'РЕЗЕРВ', d.reserve, '#ffb020', 13);
            D.lamp(c, 852, 258, 86, 28, 'ПЕРЕГРЕВ', d.hot, '#ff3b2a', 13);
            dialNeedle(c, temp, x.temp, Object.assign({ len: 58, tail: 12, w: 6, hubR: 9 }, N));
            dialNeedle(c, fuel, x.fuel, Object.assign({ len: 58, tail: 12, w: 6, hubR: 9 }, N));
            dialNeedle(c, spd, x.spd, Object.assign({ len: 165, tail: 36, w: 11, hubR: 20 }, N));
            dialNeedle(c, tach, x.rpm, Object.assign({ len: 165, tail: 36, w: 11, hubR: 20 }, N));
        },
    };
})();

/* =================================================================== УАЗ: железная панель, тросик спидометра */
const UAZ = (() => {
    const faceC = '#0c0c0c', num = '#ededea';
    const spd = { cx: 800, cy: 250, r: 168, min: 0, max: 120, a0: -125, a1: 125, face: faceC, bezel: 'chrome', bezelW: 12, minor: 24, major: 6, tick: num, len: 10, lenMajor: 24, tw: 2.5, twMajor: 5,
        labels: range(0, 120, 20).map(String), numSize: 34, numR: 120, num, texts: [{ s: 'км/ч', dy: 58, size: 22 }] };
    const small = (cx, cy, min, max, labels, title, zones) => ({ cx, cy, r: 82, min, max, a0: -50, a1: 50, face: faceC, bezel: 'chrome', bezelW: 8, minor: 8, major: 4, tick: num, len: 8, lenMajor: 16, tw: 2, twMajor: 4,
        labels, numSize: 19, numR: 54, num, zones, texts: [{ s: title, dy: 46, size: 15 }] });
    const fuel = small(380, 162, 0, 1, ['0', '1/2', '1'], 'ТОПЛИВО', [{ from: 0, to: 0.12, color: '#d43a22', w: 8 }]);
    const water = small(380, 366, 40, 120, ['40', '80', '120'], 'ВОДА °C', [{ from: 105, to: 120, color: '#d43a22', w: 8 }]);
    const oil = small(1220, 162, 40, 140, ['40', '90', '140'], 'МАСЛО °C');
    const clock = { cx: 1220, cy: 366, r: 82 };
    const rivets = [[40, 70], [1560, 70], [40, 490], [1560, 490], [560, 66], [1040, 66], [560, 494], [1040, 494]];
    const toggles = ['ФАРЫ', 'ПЕЧКА', 'ДВОРНИК', 'ГАБАРИТ', 'ПОДСВЕТ'];
    const N = { tip: 2.5, color: '#f2f2ee', hubColor: '#141414', hubRing: '#9a9fa4' };
    return {
        id: 'uaz', title: 'УАЗ',
        needles: {
            spd: { src: 'speed', min: 0, max: 120, w: 6.5, z: 0.45, cable: 0.035, kick: 14, kickRate: 0.7, stopMax: 124 },
            fuel: { src: 'fuel', min: 0, max: 1, w: 0.9, z: 1, stopMin: -0.05, stopMax: 1.05 },
            water: { src: 'coolant', min: 40, max: 120, w: 1.8, z: 1, stopMin: 37, stopMax: 123 },
            oil: { src: 'oil', min: 40, max: 140, w: 1.8, z: 1, stopMin: 36, stopMax: 144 },
        },
        back(c) {
            c.gradientRect(0, 0, 1600, 520, [[0, '#5d6752'], [0.5, '#4c5544'], [1, '#353c30']]);
            for (let y = 48; y < 520; y += 4) c.fillRect(0, y, 1600, 1, withAlpha(y % 8 ? '#000000' : '#ffffff', 0.04));
            c.fillRect(0, 60, 1600, 2, withAlpha('#000000', 0.35)); c.fillRect(0, 500, 1600, 2, withAlpha('#000000', 0.35));
            rivets.forEach((p) => D.rivet(c, p[0], p[1], 6));
            [spd, fuel, water, oil].forEach((g) => dialBack(c, g));
            D.bezel(c, clock.cx, clock.cy, clock.r, 8, 'chrome'); D.face(c, clock.cx, clock.cy, clock.r, faceC);
            D.clockFace(c, clock.cx, clock.cy, clock.r, { tick: num, num, size: 18 });
            toggles.forEach((s, i) => {
                const tx = 590 + i * 105;
                c.circle(tx, 452, 14, '#2a2e27'); c.circle(tx, 452, 10, '#8d928a');
                c.line(tx, 452, tx + 6, 432, 7, '#c9cdc6'); c.circle(tx + 6, 432, 5, '#e6e9e3');
                c.text(s, tx, 488, 13, '#d9dccf', { align: 'center', font: 'bold', literal: true });
            });
        },
        live(c, d, x) {
            D.drum(c, 800 - 75, 318, 6, 25, 32, d.odo, { bg: '#151515', fg: '#eee', lastBg: '#e5e5e0', lastFg: '#111', mask: faceC, frame: '#444', size: 24 });
            D.bulb(c, 590, 330, 11, 'РЕЗЕРВ', d.reserve, '#ffb020', '#e3e6da');
            D.bulb(c, 1010, 330, 11, 'ПЕРЕГРЕВ', d.hot, '#ff3b2a', '#e3e6da');
            dialNeedle(c, fuel, x.fuel, Object.assign({ len: 68, tail: 14, w: 6, hubR: 10 }, N));
            dialNeedle(c, water, x.water, Object.assign({ len: 68, tail: 14, w: 6, hubR: 10 }, N));
            dialNeedle(c, oil, x.oil, Object.assign({ len: 68, tail: 14, w: 6, hubR: 10 }, N));
            D.clockHands(c, clock.cx, clock.cy, clock.r, d.time, { hand: '#f2f2ee', second: '#ff5a2a', hub: '#141414', hubRing: '#9a9fa4' });
            dialNeedle(c, spd, x.spd, Object.assign({ len: 150, tail: 30, w: 10, hubR: 18 }, N));
        },
    };
})();

/* =================================================================== Волга: светлые циферблаты, хром, часы */
const VOLGA = (() => {
    const faceC = '#e9e0c6', ink = '#1d1a14';
    const spd = { cx: 800, cy: 262, r: 180, min: 0, max: 180, a0: -140, a1: 140, face: faceC, edge: '#6b5a33', bezel: 'chrome', bezelW: 14, minor: 36, major: 9, tick: ink, len: 10, lenMajor: 22, tw: 2, twMajor: 4,
        labels: range(0, 180, 20).map(String), numSize: 30, numR: 134, num: ink, texts: [{ s: 'км/ч', dy: -66, size: 22 }] };
    const temp = { cx: 432, cy: 262, r: 118, min: 40, max: 120, a0: -65, a1: 65, face: faceC, edge: '#6b5a33', bezel: 'chrome', bezelW: 12, minor: 16, major: 4, tick: ink, len: 9, lenMajor: 18,
        labels: ['40', '60', '80', '100', '120'], numSize: 22, numR: 78, num: ink, zones: [{ from: 105, to: 120, color: '#c3261b', w: 10 }], texts: [{ s: 'ВОДА °C', dy: 50, size: 18 }] };
    const clock = { cx: 1168, cy: 262, r: 118 };
    const FX0 = 640, FX1 = 960;
    return {
        id: 'volga', title: 'Волга',
        needles: {
            spd: { src: 'speed', min: 0, max: 180, w: 6, z: 0.75, cable: 0.008, stopMax: 186 },
            temp: { src: 'coolant', min: 40, max: 120, w: 1.6, z: 1, stopMin: 36, stopMax: 124 },
            fuel: { src: 'fuel', min: 0, max: 1, w: 0.8, z: 1, stopMin: -0.02, stopMax: 1.02 },
        },
        back(c) {
            c.gradientRect(0, 0, 1600, 520, [[0, '#121216'], [1, '#07070a']]);
            c.roundRect(80, 60, 1440, 452, 34, '#18181d');
            D.chromeBar(c, 80, 60, 1440, 10); D.chromeBar(c, 80, 502, 1440, 10);
            [temp, spd].forEach((g) => { c.circle(g.cx, g.cy + 6, g.r + g.bezelW + 8, withAlpha('#000000', 0.55)); dialBack(c, g); });
            c.circle(clock.cx, clock.cy + 6, clock.r + 20, withAlpha('#000000', 0.55));
            D.bezel(c, clock.cx, clock.cy, clock.r, 12, 'chrome'); D.face(c, clock.cx, clock.cy, clock.r, faceC, '#6b5a33');
            D.clockFace(c, clock.cx, clock.cy, clock.r, { tick: ink, num: ink, size: 24 });
            c.text('ЧАСЫ', clock.cx, clock.cy + 54, 16, withAlpha(ink, 0.7), { align: 'center', literal: true });
            // полоса бензина внизу
            c.roundRect(FX0 - 14, 462, FX1 - FX0 + 28, 32, 8, '#0b0b0e');
            c.fillRect(FX0, 478, FX1 - FX0, 3, '#d9d2bd');
            [0, 0.25, 0.5, 0.75, 1].forEach((f) => c.fillRect(FX0 + f * (FX1 - FX0) - 1, 470, 2, f % 0.5 ? 8 : 14, '#d9d2bd'));
            c.fillRect(FX0, 474, (FX1 - FX0) * 0.12, 3, '#c3261b');
            c.text('0', FX0 - 26, 484, 16, '#d9d2bd', { align: 'center', literal: true });
            c.text('1', FX1 + 26, 484, 16, '#d9d2bd', { align: 'center', literal: true });
            c.text('БЕНЗИН', FX0 - 60, 484, 16, '#d9d2bd', { align: 'right', font: 'bold', literal: true });
        },
        live(c, d, x) {
            D.drum(c, 800 - 72, 302, 6, 24, 30, d.odo, { bg: '#1b1b1b', fg: '#f2efe4', lastBg: '#b0261c', lastFg: '#fff', mask: faceC, frame: '#7a6a45', size: 24 });
            dialNeedle(c, temp, x.temp, { len: 98, tail: 22, w: 8, tip: 2, color: '#c3261b', hubR: 13, hubColor: '#222', hubRing: '#b8bcc0' });
            D.clockHands(c, clock.cx, clock.cy, clock.r, d.time, { hand: ink, second: '#c3261b', hub: '#222', hubRing: '#b8bcc0' });
            dialNeedle(c, spd, x.spd, { len: 160, tail: 34, w: 10, tip: 2.5, color: '#c3261b', hubR: 19, hubColor: '#222', hubRing: '#b8bcc0' });
            const fx = FX0 + Math.max(0, Math.min(1, x.fuel)) * (FX1 - FX0);
            c.quad([[fx, 476], [fx + 9, 492], [fx, 490], [fx - 9, 492]], '#ff5a3a');
            D.lamp(c, 150, 460, 130, 34, 'РЕЗЕРВ', d.reserve, '#ffb020');
            D.lamp(c, 1320, 460, 130, 34, 'ПЕРЕГРЕВ', d.hot, '#ff3b2a');
        },
    };
})();

/* =================================================================== Девятка: оранжевая подсветка, столбики */
const NINE = (() => {
    const faceC = '#040404', num = '#ffa53a', tick = '#ffb85e';
    const spd = { cx: 590, cy: 272, r: 188, min: 0, max: 200, a0: -130, a1: 130, face: faceC, bezel: 'black', bezelW: 8, minor: 40, major: 10, tick, len: 9, lenMajor: 22, tw: 2, twMajor: 4,
        labels: range(0, 200, 20).map(String), numSize: 27, numR: 140, num, texts: [{ s: 'км/ч', dy: 60, size: 20 }] };
    const tach = { cx: 1100, cy: 262, r: 158, min: 0, max: 8, a0: -130, a1: 130, face: faceC, bezel: 'black', bezelW: 8, minor: 16, major: 8, tick, len: 9, lenMajor: 22, tw: 2, twMajor: 4,
        labels: range(0, 8, 1).map(String), numSize: 30, numR: 114, num, zones: [{ from: 6, to: 8, color: '#ff2a12', w: 14, inset: 6 }], texts: [{ s: '×1000 об/мин', dy: 54, size: 17 }] };
    const BT = 140, BB = 400;           // столбики: верх и низ
    const bar = (c, x, labels, title, red) => {
        c.roundRect(x - 16, BT - 10, 32, BB - BT + 20, 8, '#090909');
        c.strokeRoundRect(x - 16, BT - 10, 32, BB - BT + 20, 8, 1.5, '#2a2a2a');
        for (let i = 0; i <= 8; i++) { const y = BB - i * (BB - BT) / 8; c.fillRect(x - 10, y - 1, i % 4 ? 8 : 20, 2, tick); }
        if (red) c.fillRect(x + 4, red[0], 4, red[1] - red[0], '#ff2a12');
        labels.forEach((s, i) => c.text(s, x - 26, BB - i * (BB - BT) / (labels.length - 1) + 7, 18, num, { align: 'right', literal: true }));
        c.text(title, x, BB + 46, 15, num, { align: 'center', font: 'bold', literal: true });
    };
    const pointer = (c, x, f) => { const y = BB - Math.max(-0.02, Math.min(1.02, f)) * (BB - BT); c.quad([[x + 12, y], [x + 30, y - 9], [x + 26, y], [x + 30, y + 9]], '#ff4a1c'); c.fillRect(x - 10, y - 1.5, 22, 3, '#ff4a1c'); };
    const N = { tip: 2, color: '#ff3b1f', glow: '#ff3b1f', hubColor: '#0a0a0a', hubRing: '#2c2c2c' };
    return {
        id: 'nine', title: 'Девятка',
        needles: {
            spd: { src: 'speed', min: 0, max: 200, w: 9, z: 0.65, cable: 0.008, stopMax: 205 },
            rpm: { src: 'rpm', scale: 0.001, min: 0, max: 8, w: 15, z: 0.4, jitter: 0.06, kick: 1.6, kickRate: 0.8, stopMax: 8.2 },
            temp: { src: 'coolant', min: 50, max: 130, w: 1.6, z: 1, stopMin: 47, stopMax: 132 },
            fuel: { src: 'fuel', min: 0, max: 1, w: 0.8, z: 1, stopMin: -0.02, stopMax: 1.02 },
        },
        back(c) {
            c.gradientRect(0, 0, 1600, 520, [[0, '#101010'], [1, '#050505']]);
            c.quad([[110, 62], [1490, 62], [1430, 504], [170, 504]], '#121212');
            c.line(110, 62, 1490, 62, 2, '#2c2c2c'); c.line(170, 504, 1430, 504, 2, '#2c2c2c');
            c.line(110, 62, 170, 504, 2, '#2c2c2c'); c.line(1490, 62, 1430, 504, 2, '#2c2c2c');
            [spd, tach].forEach((g) => dialBack(c, g));
            bar(c, 292, ['50', '90', '130'], 'ВОДА', [BT, BT + (BB - BT) * 0.25]);
            bar(c, 1338, ['0', '1/2', '1'], 'ТОПЛИВО', [BB - (BB - BT) * 0.12, BB]);
        },
        live(c, d, x) {
            D.drum(c, 590 - 72, 366, 6, 24, 30, d.odo, { bg: '#0d0d0d', fg: '#ffb35a', lastBg: '#2a1406', lastFg: '#ffd08a', mask: faceC, frame: '#3a2a1a', size: 23 });
            pointer(c, 292, (x.temp - 50) / 80);
            pointer(c, 1338, x.fuel);
            D.lamp(c, 980, 452, 116, 30, 'РЕЗЕРВ', d.reserve, '#ffb020', 14);
            D.lamp(c, 1106, 452, 116, 30, 'ПЕРЕГРЕВ', d.hot, '#ff3b2a', 14);
            dialNeedle(c, spd, x.spd, Object.assign({ len: 168, tail: 34, w: 9, hubR: 18 }, N));
            dialNeedle(c, tach, x.rpm, Object.assign({ len: 140, tail: 30, w: 9, hubR: 16 }, N));
        },
    };
})();

/* =================================================================== BMW 90-х (E39): красно-оранжевая ночная подсветка */
const E39 = (() => {
    const faceC = '#020202', num = '#ff8a24', tick = '#ff8a24';
    const spd = { cx: 520, cy: 270, r: 196, min: 0, max: 260, a0: -125, a1: 125, face: faceC, bezel: 'thin', bezelW: 4, minor: 52, major: 13, tick, len: 9, lenMajor: 20, tw: 2, twMajor: 3.5,
        labels: range(0, 260, 20).map(String), numSize: 24, numR: 152, num, texts: [{ s: 'km/h', dy: -60, size: 20 }] };
    const tach = { cx: 1080, cy: 270, r: 196, min: 0, max: 7, a0: -125, a1: 125, face: faceC, bezel: 'thin', bezelW: 4, minor: 35, major: 7, tick, len: 9, lenMajor: 20, tw: 2, twMajor: 3.5,
        labels: range(0, 7, 1).map(String), numSize: 30, numR: 150, num, zones: [{ from: 4.5, to: 7, color: '#ff2a12', w: 10, inset: 4 }], texts: [{ s: '1/min ×1000', dy: -60, size: 18 }] };
    const fuel = { cx: 520, cy: 392, r: 70, min: 0, max: 1, a0: -48, a1: 48, face: faceC, minor: 4, major: 2, tick, len: 7, lenMajor: 13, labels: ['0', '', '1'], numSize: 18, numR: 50, num,
        zones: [{ from: 0, to: 0.15, color: '#ff2a12', w: 4, inset: 2 }] };
    const temp = { cx: 1080, cy: 392, r: 70, min: 50, max: 130, a0: -48, a1: 48, face: faceC, minor: 8, major: 4, tick, len: 7, lenMajor: 13, labels: ['50', '', '130'], numSize: 17, numR: 50, num,
        zones: [{ from: 115, to: 130, color: '#ff2a12', w: 4, inset: 2 }] };
    const N = { tip: 2, color: '#ff4612', glow: '#ff5a1a', stripe: true, hubColor: '#0d0d0d', hubRing: '#2a2a2a' };
    return {
        id: 'e39', title: 'BMW E39', sweep: true,
        needles: {
            spd: { src: 'speed', min: 0, max: 260, w: 9, z: 0.9, stopMax: 262 },
            rpm: { src: 'rpm', scale: 0.001, min: 0, max: 7, w: 12, z: 0.85, stopMax: 7.05 },
            fuel: { src: 'fuel', min: 0, max: 1, w: 2, z: 1, stopMin: -0.02, stopMax: 1.02 },
            temp: { src: 'coolant', min: 50, max: 130, w: 2, z: 1, stopMin: 48, stopMax: 132 },
        },
        back(c) {
            c.fillRect(0, 0, 1600, 520, '#030303');
            c.roundRect(70, 50, 1460, 462, 210, '#080808');
            c.strokeRoundRect(70, 50, 1460, 462, 210, 2, '#1c1c1c');
            [spd, tach, fuel, temp].forEach((g) => dialBack(c, g));
            c.text('ТОПЛ.', 520, 440, 13, withAlpha(num, 0.8), { align: 'center', font: 'bold', literal: true });
            c.text('°C', 1080, 440, 14, withAlpha(num, 0.8), { align: 'center', font: 'bold', literal: true });
            c.roundRect(726, 140, 148, 270, 12, '#0d0803');
            c.strokeRoundRect(726, 140, 148, 270, 12, 2, '#2a1a0c');
        },
        live(c, d, x) {
            const lcd = '#ff9a3c';
            c.text(hhmm(d.time), 800, 196, 34, lcd, { align: 'center', font: 'num', literal: true });
            c.text(gearText(d) || ' ', 800, 290, 52, lcd, { align: 'center', font: 'num', literal: true });
            c.text(isNum(d.odo) ? String(Math.floor(d.odo)) : '------', 800, 364, 24, lcd, { align: 'center', font: 'num', literal: true });
            c.text('km', 800, 392, 16, withAlpha(lcd, 0.7), { align: 'center', literal: true });
            D.bulb(c, 760, 116, 8, '', d.reserve, '#ffb020'); D.bulb(c, 840, 116, 8, '', d.hot, '#ff3b2a');
            dialNeedle(c, fuel, x.fuel, Object.assign({ len: 56, tail: 0, w: 5, hub: false }, N));
            dialNeedle(c, temp, x.temp, Object.assign({ len: 56, tail: 0, w: 5, hub: false }, N));
            dialNeedle(c, spd, x.spd, Object.assign({ len: 182, tail: 30, w: 9, hubR: 22 }, N));
            dialNeedle(c, tach, x.rpm, Object.assign({ len: 182, tail: 30, w: 9, hubR: 22 }, N));
        },
    };
})();

/* =================================================================== BMW 2010-х (F30): хромовые кольца, экран между приборами */
const F30 = (() => {
    const faceC = '#06070a', num = '#f4f6f8', tick = '#e8ebee', orange = '#ff6a1a';
    const spd = { cx: 462, cy: 274, r: 198, min: 0, max: 260, a0: -125, a1: 125, face: faceC, edge: '#000000', bezel: 'chrome', bezelW: 7, minor: 52, major: 13, tick, len: 8, lenMajor: 20, tw: 1.6, twMajor: 3.5,
        labels: range(0, 260, 20).map(String), numSize: 24, numR: 154, num, texts: [{ s: 'km/h', dy: -68, size: 18, color: withAlpha(num, 0.7) }] };
    const tach = { cx: 1138, cy: 274, r: 198, min: 0, max: 7, a0: -125, a1: 125, face: faceC, edge: '#000000', bezel: 'chrome', bezelW: 7, minor: 35, major: 7, tick, len: 8, lenMajor: 20, tw: 1.6, twMajor: 3.5,
        labels: range(0, 7, 1).map(String), numSize: 30, numR: 152, num, zones: [{ from: 4.5, to: 7, color: '#e3261a', w: 8, inset: 3 }], texts: [{ s: '1/min ×1000', dy: -68, size: 16, color: withAlpha(num, 0.7) }] };
    const oil = { cx: 462, cy: 404, r: 62, min: 70, max: 150, a0: -45, a1: 45, face: faceC, minor: 8, major: 4, tick, len: 6, lenMajor: 12, labels: ['70', '', '150'], numSize: 16, numR: 44, num };
    const fuel = { cx: 1138, cy: 404, r: 62, min: 0, max: 1, a0: -45, a1: 45, face: faceC, minor: 4, major: 2, tick, len: 6, lenMajor: 12, labels: ['0', '', '1'], numSize: 16, numR: 44, num,
        zones: [{ from: 0, to: 0.15, color: orange, w: 4, inset: 2 }] };
    const N = { tip: 2, color: orange, glow: orange, hubColor: '#0d0e10', hubRing: '#7a7f86' };
    return {
        id: 'f30', title: 'BMW F30', sweep: true,
        needles: {
            spd: { src: 'speed', min: 0, max: 260, w: 10, z: 0.92, stopMax: 262 },
            rpm: { src: 'rpm', scale: 0.001, min: 0, max: 7, w: 13, z: 0.9, stopMax: 7.05 },
            oil: { src: 'oil', min: 70, max: 150, w: 2, z: 1, stopMin: 68, stopMax: 152 },
            fuel: { src: 'fuel', min: 0, max: 1, w: 2, z: 1, stopMin: -0.02, stopMax: 1.02 },
        },
        back(c) {
            c.gradientRect(0, 0, 1600, 520, [[0, '#0c0d10'], [1, '#040405']]);
            c.roundRect(60, 52, 1480, 458, 90, '#07080a');
            c.strokeRoundRect(60, 52, 1480, 458, 90, 2, '#1b1d21');
            [spd, tach, oil, fuel].forEach((g) => dialBack(c, g));
            c.text('МАСЛО °C', 462, 450, 12, withAlpha(num, 0.7), { align: 'center', font: 'bold', literal: true });
            c.text('ТОПЛИВО', 1138, 450, 12, withAlpha(num, 0.7), { align: 'center', font: 'bold', literal: true });
            c.roundRect(686, 128, 228, 300, 16, '#0f1114');
            c.gradientRect(690, 132, 220, 120, [[0, withAlpha('#2a3240', 0.35)], [1, withAlpha('#000000', 0)]]);
            c.strokeRoundRect(686, 128, 228, 300, 16, 2, '#2a2d33');
        },
        live(c, d, x) {
            c.text(hhmm(d.time), 800, 168, 24, num, { align: 'center', font: 'num', literal: true });
            c.text(gearText(d) || '-', 800, 262, 70, num, { align: 'center', font: 'num', literal: true });
            c.text(isNum(d.speed) ? String(Math.round(d.speed)) : '--', 800, 322, 34, orange, { align: 'center', font: 'num', literal: true });
            c.text('km/h', 800, 344, 14, withAlpha(num, 0.6), { align: 'center', literal: true });
            c.text(isNum(d.range) ? 'запас ' + d.range + ' км' : ' ', 800, 380, 17, withAlpha(num, 0.85), { align: 'center', literal: true });
            c.text(isNum(d.odo) ? Math.floor(d.odo) + ' km' : ' ', 800, 410, 16, withAlpha(num, 0.6), { align: 'center', literal: true });
            if (d.reserve) D.bulb(c, 730, 170, 8, '', true, '#ffb020');
            if (d.hot) D.bulb(c, 870, 170, 8, '', true, '#ff3b2a');
            dialNeedle(c, oil, x.oil, Object.assign({ len: 50, tail: 0, w: 5, hub: false }, N));
            dialNeedle(c, fuel, x.fuel, Object.assign({ len: 50, tail: 0, w: 5, hub: false }, N));
            dialNeedle(c, spd, x.spd, Object.assign({ len: 186, tail: 28, w: 8, hubR: 24 }, N));
            dialNeedle(c, tach, x.rpm, Object.assign({ len: 186, tail: 28, w: 8, hubR: 24 }, N));
        },
    };
})();

const PANELS = [MOSK, ZHIG, UAZ, VOLGA, NINE, E39, F30];
module.exports = { PANELS, gearText, hhmm };
