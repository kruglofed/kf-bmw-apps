'use strict';
/**
 * cluster.js - ретро-панель на приборной панели (KOMBI, 12,3" 1920x720) через сервис cluster-render
 * (Store: источник robertnisipeanu/idrive-apps, инструмент cluster-render). Его Node-клиент лежит на
 * блоке в /var/opt/cluster-render/current/cluster_render_client.js: берём его оттуда, свой не возим.
 *
 * Цель `panel` - весь экран приборов поверх штатных стрелок и ПОД контрольными лампами BMW (так у
 * cluster-render, проверено на машине): аварийные лампы видны всегда.
 *
 * Как рисуется, чтобы канал до приборов (~8 МБ/с на всех) не забивался:
 *   фон     одна картинка на панель (back), уходит один раз при смене панели;
 *   стрелки каждая - маленькая картинка, которую поворачивает сам блок приборов: шлём только
 *           угол (`rotate`) 25 раз в секунду; тень - такой же слой, сдвинутый вниз-вправо;
 *   живое   одометр, лампы, цифры, лента «Москвича» - прозрачный слой поверх стрелок,
 *           перерисовывается 6 раз в секунду, уходят только изменившиеся квадраты.
 * Экран 1600x520 центрального дисплея ложится на приборы в масштабе 1,2 (1920x624, по центру).
 *
 *   const out = new ClusterOut(log);
 *   out.available()                 есть ли cluster-render на блоке
 *   out.show(panel, d, x)           каждые 40 мс, пока показываем; panel - из panels.js
 *   out.hide()                      убрать всё (приборы BMW снова видны)
 *   out.state                       'нет cluster-render' | 'ждём приборы' | 'на приборах' | 'выкл'
 */
const fs = require('fs');
const { ScaledCanvas } = require('./kit/canvas');
const D = require('./draw');

const CLIENT = process.env.KF_CLUSTER_CLIENT || '/var/opt/cluster-render/current/cluster_render_client.js';   // env - для проверки на компьютере
const TW = 1920, TH = 720, S = 1.2, CW = 1920, CH = 624, OY = Math.round((TH - CH) / 2);
const LIVE_MS = 166, TILE_W = 64, TILE_H = 48;

const buf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length);

/** картинка одной стрелки, острием вверх; ось в (pw, ph) пикселях картинки */
function needleImage(o, shadow) {
    const pad = 4 + (o.glow ? 4 : 0);
    const lw = Math.max(o.w || 8, (o.tip || 2) + 2) + pad * 2, lh = o.len + (o.tail || 0) + pad * 2;
    const c = new ScaledCanvas(lw, lh, S);
    c.clear([0, 0, 0, 0]);
    const cx = lw / 2, cy = pad + o.len;
    const saved = D.capture.list;
    D.capture.list = null;
    const st = shadow ? Object.assign({}, o, { color: [0, 0, 0, 110], glow: null, tipColor: null, stripe: false, shadow: false }) : Object.assign({}, o, { shadow: false });
    D.needle(c, cx, cy, 0, st);
    D.capture.list = saved;
    return { px: buf(c.canvas.d), w: c.canvas.w, h: c.canvas.h, pw: cx * S, ph: cy * S };
}

/** изменившиеся квадраты (по плиткам), склеенные в полосы; null - ничего не изменилось */
function dirtyRects(cur, prev, w, h) {
    const runs = [];
    for (let ty = 0; ty < h; ty += TILE_H) {
        const th = Math.min(TILE_H, h - ty);
        let start = -1;
        for (let tx = 0; tx <= w; tx += TILE_W) {
            let dirty = false;
            if (tx < w) {
                const tw = Math.min(TILE_W, w - tx);
                for (let y = ty; y < ty + th && !dirty; y++) {
                    const a = (y * w + tx) * 4, b = a + tw * 4;
                    if (cur.compare(prev, a, b, a, b) !== 0) dirty = true;
                }
            }
            if (dirty && start < 0) start = tx;
            if (!dirty && start >= 0) { runs.push({ x: start, y: ty, w: Math.min(tx, w) - start, h: th }); start = -1; }
        }
    }
    if (!runs.length) return null;
    // одинаковые по ширине полосы друг под другом - в один прямоугольник
    const out = [];
    runs.forEach((r) => {
        const up = out.find((q) => q.x === r.x && q.w === r.w && q.y + q.h === r.y);
        if (up) up.h += r.h; else out.push(r);
    });
    return out;
}
function packRects(data, w, rects) {
    let n = 0;
    rects.forEach((r) => { n += r.w * r.h * 4; });
    const b = Buffer.alloc(n);
    let off = 0;
    rects.forEach((r) => {
        for (let y = r.y; y < r.y + r.h; y++) { const a = (y * w + r.x) * 4; data.copy(b, off, a, a + r.w * 4); off += r.w * 4; }
    });
    return b;
}

class ClusterOut {
    constructor(log) {
        this.log = log;
        this.cr = null; this.Client = null; this.tried = 0;
        this.panelId = null; this.bg = null; this.live = null; this.hands = [];
        this.liveCv = null; this.prev = null; this.liveAt = 0;
        this.state = 'выкл'; this.shown = false;
    }
    available() {
        if (this.Client) return true;
        if (Date.now() - this.tried < 30000) return false;      // ставят ли сервис - смотрим раз в 30 с
        this.tried = Date.now();
        try {
            if (!fs.existsSync(CLIENT)) { this.state = 'нет cluster-render'; return false; }
            this.Client = require(CLIENT).ClusterRender;
            this.log.info('cluster: client ' + CLIENT);
            return true;
        } catch (e) { this.state = 'нет cluster-render'; this.log.warn('cluster client: ' + e); return false; }
    }
    _connect() {
        if (this.cr) return;
        const cr = this.cr = new this.Client('kf_retro', process.env.KF_CLUSTER_SOCK || undefined);
        cr.on('layer', (ref, state, reason) => {
            if (this.bg && ref === this.bg) {
                this.state = state === 'shown' ? 'на приборах' : 'ждём приборы';
                if (state !== 'shown') this.log.info('cluster: panel ' + state + (reason ? ' (' + reason + ')' : ''));
            }
        });
        cr.on('target', (name, state, holder, reason) => { if (name === 'panel') this.log.info('cluster: target ' + state + (holder ? ' holder ' + holder : '') + (reason ? ' ' + reason : '')); });
        cr.on('refused', (op, ref, reason) => this.log.warn('cluster: refused ' + op + ' ' + ref + ': ' + reason));
        cr.on('disconnected', () => { this.state = 'ждём приборы'; });
        // после переподключения клиент сам делает слои заново со всеми пикселями и углами
        cr.connect();
        this.state = 'ждём приборы';
    }
    _drop() {
        if (!this.cr) return;
        if (this.bg) this.cr.drop(this.bg);
        if (this.live) this.cr.drop(this.live);
        this.hands.forEach((h) => { this.cr.drop(h.ref); if (h.sh) this.cr.drop(h.sh); });
        (this.masks || []).forEach((r) => this.cr.drop(r)); this.masks = [];
        this.bg = this.live = null; this.hands = []; this.panelId = null; this.prev = null;
    }
    /** новая панель: фон и пустой живой слой */
    _build(p) {
        this._drop();
        const c = new ScaledCanvas(1600, 520, S);
        c.clear('#000000');
        p.back(c);
        this.bg = this.cr.image({ target: 'panel', klass: 'content', z: 0, x: 0, y: OY, w: CW, h: CH, iw: CW, ih: CH });
        this.cr.pixels(this.bg, null, Buffer.from(buf(c.canvas.d)));
        this.liveCv = new ScaledCanvas(1600, 520, S);
        this.liveCv.clear([0, 0, 0, 0]);
        this.prev = Buffer.from(buf(this.liveCv.canvas.d));
        this.live = this.cr.image({ target: 'panel', klass: 'content', z: 100, x: 0, y: OY, w: CW, h: CH, iw: CW, ih: CH });
        this.cr.pixels(this.live, null, Buffer.from(this.prev));
        // чёрные поля сверху и снизу картинки (1920x624 на экране 1920x720) поверх стрелок: длинная
        // стрелка «Копейки» с осью ниже окна не вылезает за край
        const band = Buffer.alloc(CW * OY * 4);
        for (let i = 3; i < band.length; i += 4) band[i] = 255;
        this.masks = [0, OY + CH].map((y) => { const r = this.cr.image({ target: 'panel', klass: 'content', z: 101, x: 0, y, w: CW, h: OY, iw: CW, ih: OY }); this.cr.pixels(r, null, band); return r; });
        this.panelId = p.id; this.liveAt = 0;
        this.log.info('cluster: panel ' + p.id + ' built');
    }
    _hand(i, n) {
        const ni = needleImage(n.o, false);
        const at = (img, dx, dy) => ({ x: Math.round(n.cx * S + dx - img.pw), y: Math.round(OY + n.cy * S + dy - img.ph) });
        const p0 = at(ni, 0, 0);
        const h = { len: n.o.len, ang: n.ang, sy: 1 };
        h.ref = this.cr.image({ target: 'panel', klass: 'content', z: 20 + i, x: p0.x, y: p0.y, w: ni.w, h: ni.h, iw: ni.w, ih: ni.h,
            px: ni.pw, py: ni.ph, sampling: 'bilinear', rotate: n.ang });
        this.cr.pixels(h.ref, null, ni.px);
        if (n.o.shadow !== false) {
            const si = needleImage(n.o, true), p1 = at(si, 4 * S, 6 * S);
            h.sh = this.cr.image({ target: 'panel', klass: 'content', z: 10, x: p1.x, y: p1.y, w: si.w, h: si.h, iw: si.w, ih: si.h,
                px: si.pw, py: si.ph, sampling: 'bilinear', rotate: n.ang });
            this.cr.pixels(h.sh, null, si.px);
        }
        return h;
    }
    show(p, d, x) {
        if (!this.available()) return;
        this._connect();
        if (this.panelId !== p.id) this._build(p);
        // живой слой не чаще 6 раз в секунду и не дороже ~12 % процессора (на блоке он медленнее ПК):
        // интервал растёт, если перерисовка дорогая. Стрелки от этого не зависят
        const now = Date.now(), gap = Math.max(LIVE_MS, (this.liveCost || 0) * 8), redraw = now - this.liveAt >= gap;
        // стрелки: собрать без рисования; живой слой - на том же проходе, когда пора
        D.capture.list = [];
        if (redraw) {
            this.liveAt = now;
            this.liveCv.clear([0, 0, 0, 0]);
            p.live(this.liveCv, d, x);
        } else p.live(NOOP, d, x);
        const list = D.capture.list;
        D.capture.list = null;
        list.forEach((n, i) => {
            let h = this.hands[i];
            if (!h) { h = this.hands[i] = this._hand(i, n); return; }
            const sy = n.o.len / h.len, set = {};
            if (Math.abs(n.ang - h.ang) > 0.04) { set.rotate = n.ang; h.ang = n.ang; }
            if (Math.abs(sy - h.sy) > 0.002) { set.sy = sy; h.sy = sy; }
            if (set.rotate !== undefined || set.sy !== undefined) { this.cr.set(h.ref, set); if (h.sh) this.cr.set(h.sh, set); }
        });
        if (redraw) {
            const cur = buf(this.liveCv.canvas.d), rects = dirtyRects(cur, this.prev, CW, CH);
            if (rects) {
                this.cr.pixels(this.live, rects, packRects(cur, CW, rects));
                cur.copy(this.prev);
            }
            const cost = Date.now() - now;
            this.liveCost = this.liveCost ? this.liveCost * 0.8 + cost * 0.2 : cost;
        }
        this.shown = true;
    }
    hide() {
        if (this.shown) this.log.info('cluster: hidden');
        this._drop();
        if (this.cr) { try { this.cr.close(); } catch (e) { /* ignore */ } this.cr = null; }
        this.shown = false;
        if (this.state !== 'нет cluster-render') this.state = 'выкл';
    }
}

/** холст, который ничего не рисует (только чтобы собрать углы стрелок между перерисовками) */
const NOOP = new Proxy({}, { get: (t, k) => (k === 'clip' || k === 'noclip' ? undefined : () => NOOP) });

module.exports = { ClusterOut, dirtyRects, packRects, needleImage, CLIENT, OY, S };
