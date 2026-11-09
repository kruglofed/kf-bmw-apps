'use strict';
/**
 * Рулёжка - разведчик углов рулевого управления для BMW MGU (iDrive 7).
 *
 * Две страницы:
 *   Углы      вид машины сверху: руль крутишь - передние колёса поворачиваются на экране. Рядом живые
 *             числа: угол руля (°), рыскание (°/с), ускорения вбок/вперёд (g), скорость (км/ч), у каждого
 *             минимум и максимум с запуска. Задние колёса на картинке подсвечиваются, как только мы
 *             подключим их сигнал (пока он не найден - см. «Каталог»).
 *   Каталог   читает список всех сигналов головного устройства (/etc/oap/someip/someip-interfaces.json)
 *             и показывает все поля про рулёжку и оси - прежде всего кандидатов на угол задней оси.
 *             Эти имена нужны, чтобы вывести поворот задних колёс по-настоящему.
 *
 * Приложение только читает данные: ни одного запроса в блоки управления, ничего не пишется в машину.
 * Подтверждённые сигналы взяты из Live Data (idrive7-apps): угол руля - de.bmw.chassis.SteeringAngle,
 * рыскание и ускорения - CDS2, скорость - Vehicle2. Угла ЗАДНЕЙ оси в известных приложениях нет, его и
 * ищет «Каталог».
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { scan, readCatalog } = require('./catalog');

const W = 1600, H = 520;
const STEER = 'de.bmw.chassis.SteeringAngle', CDS2 = 'de.bmw.infotainment.vehicle.CDS2', V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const PAGES = ['Углы', 'Каталог'];
const G0 = 9.80665, STALE_MS = 3000;

const isNum = (x) => typeof x === 'number' && isFinite(x);
const f1 = (x) => (isNum(x) ? x.toFixed(1).replace('.', ',') : '--');
const f2 = (x) => (isNum(x) ? x.toFixed(2).replace('.', ',') : '--');
const i0 = (x) => (isNum(x) ? String(Math.round(x)) : '--');

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let page = 0;

        /* ---------- живые сигналы ---------- */
        const S = {};   // id -> { v, at, min, max }
        function put(id, v) {
            if (!isNum(v)) return;
            const s = S[id] || (S[id] = { v: null, at: 0, min: Infinity, max: -Infinity });
            s.v = v; s.at = Date.now();
            if (v < s.min) s.min = v;
            if (v > s.max) s.max = v;
        }
        const fresh = (id) => { const s = S[id]; return s && Date.now() - s.at < STALE_MS ? s.v : null; };
        const num = (v, m, bad) => {
            let x = v && v[m];
            if (typeof x === 'string' && /^-?\d+$/.test(x)) x = Number(x);
            if (!isNum(x) || (bad && bad.indexOf(x) >= 0)) return null;
            return x;
        };
        const watch = (iface, handlers, poll) => ctx.signals.watch(iface, '1', handlers, log, poll ? { pollMs: poll } : undefined)
            .then((s) => { if (s && s.error) log.warn(iface + ': ' + s.error); return s; })
            .catch((e) => log.warn(iface + ': ' + e));

        const steer = (v) => { const r = num(v, 'actualValueSteeringAngleDriver', [65535]); if (r !== null) put('steer', (r >= 32768 ? r - 65536 : r) * 0.04395); };
        watch(STEER, { ActualSteeringAngleDriver: steer, actualSteeringAngleDriverNoCRC: steer });
        watch(CDS2, {
            statusYawVelocityVehicle: (v) => { const r = num(v, 'yawVelocityVehicle', [65535]); if (r !== null) put('yaw', r * 0.005 - 163.84); },
            statusLateralAccelerationMassCenter: (v) => { const r = num(v, 'lateralAccelerationCentreOfGravity', [65535]); if (r !== null) put('gLat', (r * 0.002 - 65) / G0); },
            statusLongitudinalAccelerationMassCenter: (v) => { const r = num(v, 'longitudinalAccelerationCentreOfGravity', [65535]); if (r !== null) put('gLong', (r * 0.002 - 65) / G0); },
        }, 10000);
        watch(V2, { statusCarSpeed2: (v) => { const r = num(v, 'speedVehicleCentreOfGravity', [65535]); if (r !== null) put('speed', r * 0.015625); } }, 10000);

        /* ---------- демо (нет данных от машины) ---------- */
        const started = Date.now();
        const anyData = () => Object.keys(S).some((k) => S[k].at);
        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !anyData() && Date.now() - started > 5000);
        function demo() {
            const s = (Date.now() - started) / 1000, sw = 360 * Math.sin(s / 4);
            return { steer: sw, yaw: 6 * Math.sin(s / 4 + 0.3), gLat: 0.25 * Math.sin(s / 4 + 0.3), gLong: 0.05 * Math.cos(s / 3), speed: 24 + 6 * Math.sin(s / 5) };
        }

        /* ---------- каталог ---------- */
        let scanDone = false, cat = null;     // { path, error, matches }
        function runScan() {
            if (scanDone) return;
            scanDone = true;
            if (demoOn()) {
                const demoDb = { interfaces: {
                    'de.bmw.chassis.SteeringAngle': { fields: { ActualSteeringAngleDriver: {} } },
                    'de.bmw.chassis.RearAxleSteering': { fields: { statusRearAxleSteeringAngle: {} } },
                    'de.bmw.infotainment.vehicle.CDS2': { fields: { statusYawVelocityVehicle: {}, statusLateralAccelerationMassCenter: {} } },
                } };
                cat = { path: 'демо', error: null, matches: scan(demoDb) };
                return;
            }
            try {
                const r = readCatalog();
                cat = { path: r.path, error: r.error, matches: r.data ? scan(r.data) : [] };
                if (cat.matches.length) {
                    log.info('steer scan: ' + cat.matches.length + ' matches in ' + r.path);
                    cat.matches.forEach((m) => log.info('  ' + m.iface + ' . ' + m.field + '  [' + m.tag + ']'));
                    try { fs.writeFileSync(path.join(ctx.dataDir, 'steer-scan.txt'),
                        cat.matches.map((m) => m.iface + '\t' + m.field + '\t' + m.tag).join('\n')); } catch (e) { /* ignore */ }
                } else log.info('steer scan: no matches (' + (r.path || r.error) + ')');
            } catch (e) { cat = { path: null, error: String(e), matches: [] }; log.warn('steer scan: ' + e); }
        }

        /* ---------- рисование ---------- */
        const ratio = () => Number(settings.get('steerRatio')) || 15;
        function label(cv, t, x, y, s) { cv.text(s.toUpperCase(), x, y, 20, t.dim, { font: 'bold', spacing: 1.5 }); }
        function wheel(cv, cx, cy, angDeg, len, wid, color) {
            const a = angDeg * Math.PI / 180, dx = Math.sin(a) * len / 2, dy = -Math.cos(a) * len / 2;
            cv.line(cx - dx, cy - dy, cx + dx, cy + dy, wid, color);
        }
        /** вид машины сверху, передние колёса по углу руля; задние - по rear, если есть */
        function drawCar(cv, t, x, y, w, h, steerWheelDeg, rearDeg) {
            const bx = x + w * 0.30, bw = w * 0.40, by = y + 30, bh = h - 70, cxF = bx + bw / 2;
            const front = isNum(steerWheelDeg) ? G.clamp(steerWheelDeg / ratio(), -45, 45) : 0;
            // корпус
            cv.roundRect(bx, by, bw, bh, 34, withAlpha(t.text, 0.10));
            cv.strokeRoundRect(bx, by, bw, bh, 34, 2, withAlpha(t.text, 0.3));
            cv.text('нос', cxF, by - 4, 18, t.dim, { align: 'center' });
            const axF = by + bh * 0.26, axR = by + bh * 0.80, tw = bw / 2 + 26, wl = 78, ww = 26;
            // ось (линии)
            cv.line(cxF - tw, axF, cxF + tw, axF, 3, withAlpha(t.text, 0.25));
            cv.line(cxF - tw, axR, cxF + tw, axR, 3, withAlpha(t.text, 0.25));
            // передние колёса - поворачиваются
            wheel(cv, cxF - tw, axF, front, wl, ww, t.accent);
            wheel(cv, cxF + tw, axF, front, wl, ww, t.accent);
            // задние
            const rok = isNum(rearDeg);
            wheel(cv, cxF - tw, axR, rok ? rearDeg : 0, wl, ww, rok ? t.accent : withAlpha(t.text, 0.35));
            wheel(cv, cxF + tw, axR, rok ? rearDeg : 0, wl, ww, rok ? t.accent : withAlpha(t.text, 0.35));
            cv.text(isNum(front) ? 'перёд ' + (front >= 0 ? '+' : '') + f1(front) + '°' : 'перёд --', cxF, axF - wl / 2 - 24, 20, t.text, { align: 'center', font: 'bold' });
            cv.text(rok ? 'зад ' + f1(rearDeg) + '°' : 'зад: сигнал ищем в «Каталоге»', cxF, axR + wl / 2 + 10, 20, rok ? t.text : t.dim, { align: 'center' });
        }

        function readRow(cv, t, x, y, w, name, id, unit, fmt, dead) {
            const s = S[id], live = fresh(id), v = demoOn() ? dem[id] : live;
            cv.text(name, x, y, 26, (v === null && !demoOn()) ? t.dim : t.text);
            const vx = x + w;
            cv.text(isNum(v) ? fmt(v) + ' ' + unit : (s && !s.at ? '--' : 'нет сигнала'), vx, y, 30, isNum(v) ? t.text : t.dim, { align: 'right', font: 'bold' });
            if (s && s.at && isFinite(s.min)) {
                const range = dead ? 'размах ' + fmt(s.max - s.min) : fmt(s.min) + ' … ' + fmt(s.max);
                cv.text(range + ' ' + unit, vx, y + 26, 19, t.dim, { align: 'right' });
            }
        }

        let dem = {};
        function drawAngles(cv, t) {
            const d = demoOn() ? demo() : null; dem = d || {};
            const sw = d ? d.steer : fresh('steer');
            drawCar(cv, t, 24, 56, 900, 452, sw, null);
            // числа справа
            const px = 956, p = G.panel(cv, t, 940, 44, 636, 468, 'Живые значения'), ey = p.y + p.h - G.BOTTOM;
            label(cv, t, px, 128, 'Угол руля');
            cv.text(isNum(sw) ? (sw >= 0 ? '+' : '') + i0(sw) + '°' : '--', 1552, 120, 60, isNum(sw) ? t.accent : t.dim, { align: 'right', font: 'num' });
            cv.text(isNum(sw) ? (sw > 5 ? 'вправо' : sw < -5 ? 'влево' : 'прямо') : 'крути руль на месте', px, 158, 22, t.dim);
            cv.fillRect(px, 192, 596, 1, withAlpha(t.tick, 0.4));
            const rows = [['Рыскание', 'yaw', '°/с', f1], ['Ускорение вбок', 'gLat', 'g', f2], ['Ускорение вперёд', 'gLong', 'g', f2], ['Скорость', 'speed', 'км/ч', i0]];
            const gap = 48 + Math.round(ey / rows.length);
            rows.forEach((r, i) => readRow(cv, t, px, 244 + i * gap, 596, r[0], r[1], r[2], r[3]));
            cv.text('Выверни руль до упора влево и вправо на месте — передние колёса на картинке повторяют.', 24, 500 + G.toMargin(ey, 0), 20, t.dim);
        }

        function drawCatalog(cv, t) {
            runScan();
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'Сигналы рулёжки и осей в каталоге головного устройства'), ey = p.y + p.h - G.BOTTOM;
            if (!cat) { cv.text('Читаю каталог…', 48, 150, 28, t.dim); return; }
            if (cat.error && !cat.matches.length) {
                cv.text('Каталог не прочитан.', 48, 140, 30, t.warn, { font: 'bold' });
                cv.text(cat.error, 48, 182, 22, t.dim);
                cv.text('Возможно, у приложения нет доступа к файлу. Сообщи мне — подскажу другой путь.', 48, 222, 22, t.dim);
                return;
            }
            const head = cat.path === 'демо' ? 'Демо-режим: пример того, что покажет поиск на машине'
                : 'Найдено ' + cat.matches.length + ' · ' + cat.path + ' · сохранено в steer-scan.txt';
            cv.text(head, 48, 92, 22, t.dim);
            const rear = cat.matches.filter((m) => m.tag === 'задняя ось');
            cv.text(rear.length ? '★ Похоже на заднюю ось: ' + rear.length + ' — по ним и сделаю задние колёса' : 'Явного сигнала задней оси не видно — пришли мне фото всего списка',
                48, 120, 22, rear.length ? t.accent : t.warn);
            const rowH = 36, per = Math.max(1, Math.floor((ey + 300) / rowH));
            const total = cat.matches.length, pages = Math.max(1, Math.ceil(total / per));
            const pg = ((catPage % pages) + pages) % pages, from = pg * per;
            const cols = [{ label: 'Интерфейс', w: 720 }, { label: 'Поле / сигнал', w: 620 }, { label: 'Что это', w: 212 }];
            const rows = cat.matches.slice(from, from + per).map((m) => [
                { text: m.iface, color: m.tag === 'задняя ось' ? 'accent' : null, font: m.tag === 'задняя ось' ? 'bold' : null },
                { text: m.field, font: m.tag === 'задняя ось' ? 'bold' : null },
                { text: m.tag, color: 'dim' }]);
            G.table(cv, t, 48, 150, 1504, cols, rows, { rowH, size: 23, empty: 'Ничего про рулёжку и оси в каталоге не нашлось' });
            cv.text((total > per ? 'Стр. ' + (pg + 1) + '/' + pages + ' — кнопкой «Следующая страница». ' : '') + 'Сфотографируй экран и пришли мне.',
                48, 500 + G.toMargin(ey, 0), 20, t.dim);
        }

        let catPage = 0;
        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) drawAngles(cv, t); else drawCatalog(cv, t);
            G.frame(cv, t, PAGES, page, [demoOn() && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }

        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_PAGE', () => { if (page === 1) { catPage++; return render(); } return go(page + 1); });
        ui.onClick('BTN_PREV', () => { if (page === 1 && catPage > 0) { catPage--; return render(); } return go(page - 1); });
        ctx.onTab((i) => { catPage = 0; return go(i); });
        ctx.loop('MAIN', 4, render);
        render().then(() => log.info('steer: first frame')).catch((e) => log.warn('first render: ' + e));
    },
});
