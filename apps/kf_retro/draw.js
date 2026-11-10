'use strict';
/**
 * draw.js - кирпичики старых приборов: циферблат, хромовый ободок, стрелка с тенью, барабанный
 * одометр, контрольная лампа, часы. Углы - градусы по часовой стрелке от 12 часов.
 * Всё рисуется теми же вызовами, что и в остальных приложениях (canvas.js / record.js).
 */
const { withAlpha, mix } = require('./kit/canvas');
const { angleOf, drumDigits } = require('./needles');

const RAD = Math.PI / 180;
/** capture.list = [] - needle() не рисует, а складывает { cx, cy, ang, o } (вывод на приборы) */
const capture = { list: null };
const pt = (cx, cy, a, r) => [cx + Math.sin(a * RAD) * r, cy - Math.cos(a * RAD) * r];

/** риски шкалы: n делений от a0 до a1, каждая every-я - крупная */
function ticks(c, cx, cy, o) {
    const n = o.n, every = o.every || 1;
    for (let i = 0; i <= n; i++) {
        const a = o.a0 + (o.a1 - o.a0) * i / n, major = i % every === 0;
        if (o.skip && o.skip(i, major)) continue;
        const len = major ? o.lenMajor : o.len;
        const p0 = pt(cx, cy, a, o.r - len), p1 = pt(cx, cy, a, o.r);
        c.line(p0[0], p0[1], p1[0], p1[1], major ? o.wMajor : o.w, major ? (o.colorMajor || o.color) : o.color);
    }
}

/** цифры по дуге: labels равномерно от a0 до a1 */
function numbers(c, cx, cy, o) {
    const k = o.labels.length - 1;
    o.labels.forEach((s, i) => {
        if (s === '' || s === null) return;
        const a = o.a0 + (o.a1 - o.a0) * (k ? i / k : 0), p = pt(cx, cy, a, o.r);
        c.text(String(s), p[0], p[1] + o.size * 0.36, o.size, o.color, { align: 'center', font: o.font || 'label', literal: true });
    });
}

/** цветная зона шкалы (красная зона тахометра) от значения from до to */
function zone(c, cx, cy, r0, r1, min, max, a0, a1, from, to, color) {
    c.arc(cx, cy, r0, r1, angleOf(from, min, max, a0, a1), angleOf(to, min, max, a0, a1), color);
}

/** хромовый (или чёрный) ободок снаружи радиуса r, толщиной w */
function bezel(c, cx, cy, r, w, kind) {
    if (kind === 'black') {
        c.arc(cx, cy, r, r + w, 0, 360, '#141414');
        c.arc(cx, cy, r + w - 2, r + w, 0, 360, '#2c2c2c');
        c.arc(cx, cy, r, r + 1.5, 0, 360, '#000000');
        return;
    }
    if (kind === 'thin') {
        c.arc(cx, cy, r, r + w, 0, 360, '#4a4d52');
        c.arc(cx, cy, r + w * 0.3, r + w * 0.7, -70, 70, withAlpha('#e8ecf0', 0.6));
        return;
    }
    c.arc(cx, cy, r, r + w, 0, 360, '#70757c');
    c.arc(cx, cy, r + w * 0.12, r + w * 0.88, -85, 85, withAlpha('#eef1f4', 0.55));
    c.arc(cx, cy, r + w * 0.12, r + w * 0.88, 110, 250, withAlpha('#1c1d20', 0.55));
    c.arc(cx, cy, r + w * 0.3, r + w * 0.55, -40, 30, withAlpha('#ffffff', 0.5));
    c.arc(cx, cy, r, r + 1.5, 0, 360, '#1a1a1a');
    c.arc(cx, cy, r + w - 1.5, r + w, 0, 360, withAlpha('#ffffff', 0.35));
}

/** круглое лицо прибора с лёгким затемнением к краю */
function face(c, cx, cy, r, color, edge) {
    c.circle(cx, cy, r, color);
    c.arc(cx, cy, r * 0.86, r, 0, 360, withAlpha(edge || '#000000', 0.35));
    c.arc(cx, cy, r * 0.94, r, 0, 360, withAlpha(edge || '#000000', 0.35));
}

/**
 * стрелка: тонкий клин от хвоста к острию. o = { len, tail, w (у основания), tip (у острия), color,
 * shadow (true), glow (цвет свечения) }
 */
function needle(c, cx, cy, ang, o) {
    // на приборах (cluster.js) стрелки - отдельные поворачиваемые слои: собираем их, не рисуя
    if (capture.list) { capture.list.push({ cx, cy, ang, o }); return; }
    const perp = (p, d) => [p[0] + Math.sin((ang + 90) * RAD) * d, p[1] - Math.cos((ang + 90) * RAD) * d];
    const shape = (dx, dy, grow, col) => {
        const tip = pt(cx + dx, cy + dy, ang, o.len + grow), tail = pt(cx + dx, cy + dy, ang, -(o.tail || 0) - grow);
        const tw = (o.tip || 2) / 2 + grow, bw = (o.w || 8) / 2 + grow;
        c.quad([perp(tip, tw), perp(tip, -tw), perp(tail, -bw), perp(tail, bw)], col);
    };
    if (o.shadow !== false) shape(4, 6, 0, [0, 0, 0, 110]);
    if (o.glow) shape(0, 0, 3, withAlpha(o.glow, 0.28));
    shape(0, 0, 0, o.color);
    if (o.tipColor) { // кончик другого цвета (красный у «Копейки»)
        const L = o.tipLen || 34, a = pt(cx, cy, ang, o.len - L), b = pt(cx, cy, ang, o.len - 1);
        c.line(a[0], a[1], b[0], b[1], (o.tip || 2) + 1.5, o.tipColor);
    }
    if (o.stripe) { // светлая полоска по центру (стрелки BMW)
        const a = pt(cx, cy, ang, o.len * 0.25), b = pt(cx, cy, ang, o.len - 4);
        c.line(a[0], a[1], b[0], b[1], 1.5, withAlpha('#ffffff', 0.45));
    }
}

/** колпачок оси стрелки */
function hub(c, cx, cy, r, color, ring) {
    c.circle(cx + 2, cy + 3, r, [0, 0, 0, 120]);
    c.circle(cx, cy, r, ring || '#5b5f65');
    c.circle(cx, cy, r * 0.78, color || '#111111');
    c.circle(cx - r * 0.25, cy - r * 0.3, r * 0.25, withAlpha('#ffffff', 0.18));
}

/**
 * барабанный одометр: n барабанов шириной cw и высотой h, левый верхний угол x, y. Последний барабан
 * крутится плавно (roll). mask - цвет лица вокруг окна (закрывает уехавшую цифру).
 * o = { bg, fg, lastBg, lastFg, mask, frame, size }
 */
function drum(c, x, y, n, cw, h, value, o) {
    const d = drumDigits(value, n), size = o.size || h * 0.78;
    for (let i = 0; i < n; i++) {
        const last = i === n - 1, bx = x + i * cw;
        c.fillRect(bx + 1, y, cw - 2, h, last ? (o.lastBg || o.bg) : o.bg);
        c.gradientRect(bx + 1, y, cw - 2, h * 0.3, [[0, [0, 0, 0, 120]], [1, [0, 0, 0, 0]]]);
        c.gradientRect(bx + 1, y + h * 0.7, cw - 2, h * 0.3, [[0, [0, 0, 0, 0]], [1, [0, 0, 0, 120]]]);
        const col = last ? (o.lastFg || o.fg) : o.fg, ch = d.digits[i];
        if (last && d.roll > 0.01) {
            // последний барабан крутится: цифра уезжает вверх, снизу выезжает следующая. GPU обрезает
            // по окну (clip), а программная отрисовка - маской цвета лица прямо над и под окном
            const off = d.roll * h, next = String((Number(ch) + 1) % 10);
            if (c.clip) c.clip(bx + 1, y, cw - 2, h);
            c.text(ch, bx + cw / 2, y + h / 2 + size * 0.36 - off, size, col, { align: 'center', font: o.font || 'num', literal: true });
            c.text(next, bx + cw / 2, y + h / 2 + size * 0.36 - off + h, size, col, { align: 'center', font: o.font || 'num', literal: true });
            if (c.noclip) c.noclip();
            c.fillRect(bx - 1, y - size * 0.7, cw + 2, size * 0.7 - 3, o.mask);
            c.fillRect(bx - 1, y + h + 3, cw + 2, size * 0.7, o.mask);
        } else c.text(ch, bx + cw / 2, y + h / 2 + size * 0.36, size, col, { align: 'center', font: o.font || 'num', literal: true });
    }
    if (o.frame) c.strokeRoundRect(x - 3, y - 3, n * cw + 6, h + 6, 4, 2, o.frame);
}

/** контрольная лампа: тёмное стекло, горит - светится цветом */
function lamp(c, x, y, w, h, text, on, color, size) {
    c.roundRect(x, y, w, h, 5, on ? color : withAlpha(mix('#000000', color, 0.18), 1));
    if (on) c.roundRect(x - 3, y - 3, w + 6, h + 6, 8, withAlpha(color, 0.25));
    c.strokeRoundRect(x, y, w, h, 5, 1.5, withAlpha('#000000', 0.7));
    c.text(text, x + w / 2, y + h / 2 + (size || 15) * 0.36, size || 15, on ? '#111111' : withAlpha(mix('#000000', color, 0.55), 1), { align: 'center', font: 'bold', literal: true });
}

/** круглая лампочка с подписью снизу */
function bulb(c, x, y, r, text, on, color, textColor) {
    c.circle(x, y, r + 3, '#1a1a1a');
    c.circle(x, y, r, on ? color : mix('#000000', color, 0.2));
    if (on) c.circle(x, y, r + 8, withAlpha(color, 0.22));
    c.circle(x - r * 0.3, y - r * 0.35, r * 0.3, withAlpha('#ffffff', on ? 0.5 : 0.12));
    if (text) c.text(text, x, y + r + 20, 15, textColor || '#bbbbbb', { align: 'center', font: 'bold', literal: true });
}

/** стрелки часов. time = { h, m, s } */
function clockHands(c, cx, cy, r, time, o) {
    if (!time) return;
    const ha = ((time.h % 12) + time.m / 60) * 30, ma = (time.m + time.s / 60) * 6, sa = time.s * 6;
    needle(c, cx, cy, ha, { len: r * 0.5, tail: r * 0.1, w: 9, tip: 4, color: o.hand });
    needle(c, cx, cy, ma, { len: r * 0.78, tail: r * 0.12, w: 7, tip: 3, color: o.hand });
    if (o.second) needle(c, cx, cy, sa, { len: r * 0.84, tail: r * 0.2, w: 2.5, tip: 1.5, color: o.second, shadow: false });
    hub(c, cx, cy, Math.max(5, r * 0.08), o.hub || '#111111', o.hubRing);
}

/** циферблат часов: 60 рисок, 12 крупных, цифры 12 / 3 / 6 / 9 */
function clockFace(c, cx, cy, r, o) {
    ticks(c, cx, cy, { a0: 0, a1: 354, n: 59, every: 5, r: r - 6, len: 6, lenMajor: 14, w: 1.5, wMajor: 3.5, color: o.tick });
    [['12', 0], ['3', 90], ['6', 180], ['9', 270]].forEach((p) => {
        const q = pt(cx, cy, p[1], r - 34);
        c.text(p[0], q[0], q[1] + o.size * 0.36, o.size, o.num, { align: 'center', font: o.font || 'label', literal: true });
    });
}

/** заклёпка / винт */
function rivet(c, x, y, r) {
    c.circle(x + 1, y + 1.5, r, [0, 0, 0, 110]);
    c.circle(x, y, r, '#8b9089');
    c.circle(x - r * 0.3, y - r * 0.3, r * 0.4, withAlpha('#ffffff', 0.35));
}

/** «дерево» под приборами (полосы волокон) */
function wood(c, x, y, w, h) {
    c.gradientRect(x, y, w, h, [[0, '#5a3418'], [0.5, '#7a4a22'], [1, '#3e220e']]);
    for (let i = 0; i < 9; i++) {
        const yy = y + 3 + i * (h - 6) / 8, wave = (i * 37) % 23;
        for (let k = 0; k < 8; k++) {
            const xa = x + k * w / 8, xb = xa + w / 8;
            c.line(xa, yy + ((k + wave) % 3) - 1, xb, yy + ((k + 1 + wave) % 3) - 1, 1.2, withAlpha(i % 2 ? '#2a160a' : '#9a6634', 0.35));
        }
    }
    c.fillRect(x, y, w, 2, withAlpha('#000000', 0.5));
}

/** хромовая планка */
function chromeBar(c, x, y, w, h) {
    c.gradientRect(x, y, w, h, [[0, '#f2f4f6'], [0.35, '#9aa0a6'], [0.55, '#5a5f65'], [1, '#d4d8dc']]);
}

module.exports = { RAD, capture, pt, ticks, numbers, zone, bezel, face, needle, hub, drum, lamp, bulb, clockHands, clockFace, rivet, wood, chromeBar, withAlpha, mix };
