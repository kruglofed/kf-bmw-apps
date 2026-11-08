'use strict';
/**
 * Пробег и расход - одометр, топливо, бортовой компьютер, пробег по дням и реальный расход по заправкам.
 *
 * Страницы (вкладки сверху):
 *   Сейчас    одометр, пробег за сегодня / 7 / 30 дней, топливо в баке и запас хода, средний расход
 *             и скорость бортового компьютера, путь и время поездки.
 *   Пробег    пробег за сегодня, вчера, неделю, месяц, средний за день и столбцы за 14 дней.
 *   Заправки  расход по уровню бака: текущий бак (км, литры, л/100 км), последние заправки и средний.
 *
 * Источник - только то, что машина сама шлёт головному устройству по SOME/IP (KombiIF - комбинация
 * приборов): ни одного запроса в блоки управления, ничего не записывается в машину. Шкалы те же, что
 * в Live Data (idrive7-apps). Учёт (logbook.js) - в data/logbook.json, несколько кБ, не растёт.
 * Приложение считает, пока оно запущено (и в фоне, пока головное устройство не уснуло); заправку,
 * сделанную при выключенном приложении, оно замечает при следующем запуске.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Logbook, dayKey, per100 } = require('./logbook');

const W = 1600, H = 520;
const KOMBI = 'de.bmw.infotainment.KombiIF', VI = 'de.bmw.infrastructure.VehicleInformation', V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const PAGES = ['Сейчас', 'Пробег', 'Заправки'];
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const CONS = { VERBRAUCH_IN_L_S_100KM: 'л/100 км', VERBRAUCH_IN_MPG_UK: 'mpg', VERBRAUCH_IN_MPG_US: 'mpg US', VERBRAUCH_IN_KM_S_L: 'км/л', 1: 'л/100 км', 2: 'mpg', 3: 'mpg US', 4: 'км/л' };
const SPEEDS = { KM_S_H__KM: 'км/ч', MPH__MLS: 'mph', 1: 'км/ч', 2: 'mph' };
const DAY = 86400000;

const isNum = (x) => typeof x === 'number' && isFinite(x);
/** число из поля структуры (иногда приходит строкой); null - нет данных */
function raw(v, m, max, bad) {
    if (!v || typeof v !== 'object') return null;
    let x = v[m];
    if (typeof x === 'string' && /^\d+$/.test(x)) x = Number(x);
    if (!isNum(x) || (max !== undefined && x >= max) || (bad && bad.indexOf(x) >= 0)) return null;
    return x;
}
/** 54123 -> "54 123" */
const group = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const f1 = (x) => (isNum(x) ? x.toFixed(1).replace('.', ',') : '--');
const km = (x) => (isNum(x) ? group(x) : '--');
const pad2 = (n) => (n < 10 ? '0' : '') + n;
const dateOf = (t) => { const d = new Date(t); return d.getDate() + ' ' + MON[d.getMonth()]; };
const dayLabel = (key) => { const p = key.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]); return d.getDate() + ' ' + WD[d.getDay()]; };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let page = 0;

        /* ---------- что шлёт машина ---------- */
        const car = { odo: null, odoAlt: null, tank: null, range: null, speed: null, bc: null, travel: null, at: 0 };
        const got = () => { car.at = Date.now(); };
        const watch = (iface, handlers, poll) => ctx.signals.watch(iface, '1', handlers, log, poll ? { pollMs: poll } : undefined)
            .then((s) => { if (s.error) log.warn(iface + ': ' + s.error); return s; })
            .catch((e) => log.warn(iface + ': ' + e));
        watch(KOMBI, {
            statusRangeTankStatus: (v) => {
                car.tank = raw(v, 'fluidLevelFuelTank', 255);
                car.range = raw(v, 'range', 4095);
                const o = raw(v, 'mileageKilometre', 16777215);
                if (o !== null && o > 0) car.odo = o;
                got();
            },
            statusBordcomputerAverage: (v) => {
                const c = raw(v, 'consumptionAverage1BC1', undefined, [65535]), s = raw(v, 'speedAverage1BC1', undefined, [65535]);
                const c2 = raw(v, 'consumptionAverage2BC2', undefined, [65535]), s2 = raw(v, 'speedAverage2BC2', undefined, [65535]);
                car.bc = {
                    cons: c === null ? null : c * 0.1, speed: s === null ? null : s * 0.1,
                    cons2: c2 === null ? null : c2 * 0.1, speed2: s2 === null ? null : s2 * 0.1,
                    cu: CONS[v && v.statusUnitOfMeasurementConsumptionBC] || 'л/100 км', su: SPEEDS[v && v.statusUnitOfMeasurementSpeedBC] || 'км/ч',
                };
                got();
            },
            statusBordcomputerTravelData: (v) => {
                const h = raw(v, 'rideDurationHours', 65535), m = raw(v, 'rideDurationMinutes', 60), w = raw(v, 'wayPassed', undefined, [65535]);
                car.travel = { min: h === null || m === null ? null : h * 60 + m, km: w };
                got();
            },
        }, 10000);
        // одометр бывает и в VehicleInformation.Range: им пользуемся, когда комбинация его не прислала
        watch(VI, { Range: (v) => { const o = raw(v, 'mileageKilometre', 16777215); if (o !== null && o > 0) car.odoAlt = o; } });
        watch(V2, { statusCarSpeed2: (v) => { const s = raw(v, 'speedVehicleCentreOfGravity', 65535); car.speed = s === null ? null : s * 0.015625; } });

        /* ---------- учёт ---------- */
        const FILE = path.join(ctx.dataDir, 'logbook.json');
        let saved = null;
        try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* первый запуск */ }
        const lb = new Logbook(saved);
        let savedVer = lb.ver, savedAt = Date.now();
        function save() {
            try {
                fs.writeFileSync(FILE + '.tmp', JSON.stringify(lb));
                fs.renameSync(FILE + '.tmp', FILE);
                savedVer = lb.ver; savedAt = Date.now();
            } catch (e) { log.warn('save logbook: ' + e); }
        }
        // головное устройство засыпает - процесс завершается: учёт сохраняется
        process.on('exit', () => { if (lb.ver !== savedVer) save(); });
        const started = Date.now();
        setInterval(() => {
            try {
                const odo = car.odo !== null ? car.odo : car.odoAlt;
                if (odo === null && car.tank === null) return;
                const r = lb.feed(Date.now(), { odo, tank: car.tank, speed: car.speed });
                if (r.refuel) { log.info('refuel: +' + r.refuel.added + ' l at ' + r.refuel.odo + ' km (' + r.refuel.before + ' -> ' + r.refuel.after + ' l)'); save(); }
                else if (lb.ver !== savedVer && Date.now() - savedAt > 60000) save();
            } catch (e) { log.warn('logbook: ' + (e && e.stack || e)); }
        }, 1000);

        /* ---------- демо (нет данных от машины) ---------- */
        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !car.at && Date.now() - started > 5000);
        const demoT0 = Date.now();
        const demoLb = (() => {
            const d = new Logbook(null), now = Date.now();
            let odo = 53250, tank = 70;
            for (let i = 34; i >= 0; i--) {
                const t = new Date(now - i * DAY); t.setHours(8, 0, 0, 0);
                const run = i === 0 ? 38 : [0, 42, 65, 18, 120, 55, 0, 73][i % 8];
                for (let k = 0; k < 4; k++) d.feed(t.getTime() + k * 1000, { odo, tank, speed: 0 });
                if (tank < 20) {       // заправка
                    tank = 76;
                    for (let k = 0; k < 4; k++) d.feed(t.getTime() + 60000 + k * 1000, { odo, tank, speed: 0 });
                }
                odo += run; tank -= run * (0.108 + 0.02 * ((i * 7) % 5) / 4);
                for (let k = 0; k < 4; k++) d.feed(t.getTime() + 3600000 + k * 1000, { odo, tank, speed: 0 });
            }
            return d;
        })();
        function demoCar() {
            const s = (Date.now() - demoT0) / 1000;
            return { odo: demoLb.odo, tank: demoLb.tank, range: Math.round(demoLb.tank / 11.4 * 100), speed: 62 + 8 * Math.sin(s / 7),
                bc: { cons: 11.6, speed: 46.3, cons2: 10.9, speed2: 51.2, cu: 'л/100 км', su: 'км/ч' }, travel: { min: 72, km: 63 } };
        }

        /* ---------- рисование ---------- */
        const tankSize = () => settings.get('tankSize') || 80;
        function label(cv, t, x, y, s) { cv.text(s.toUpperCase(), x, y, 20, t.dim, { font: 'bold', spacing: 1.5 }); }
        /** подпись, крупное значение, единица; возвращает ширину значения */
        function big(cv, t, x, y, value, unit, size, color) {
            const ok = value !== '--';
            const w = cv.text(value, x, y, size, ok ? color || t.text : t.dim, { font: 'num' });
            if (unit) cv.text(unit, x + w + 10, y, Math.max(22, Math.round(size * 0.36)), t.dim);
            return w;
        }
        function line(cv, t, x, y, w, name, value) {
            cv.text(name, x, y, 26, t.dim);
            cv.text(value, x + w, y, 28, value.indexOf('--') === 0 ? t.dim : t.text, { align: 'right', font: 'bold' });
        }

        function drawNow(cv, t, d, L, now) {
            const st = L.stats(now);
            // одометр
            const p = G.panel(cv, t, 24, 44, 760, 468, 'Одометр'), ex = p.y + p.h - G.BOTTOM;
            big(cv, t, 48, 200, km(d.odo), 'км', 120);
            cv.fillRect(48, 250, 712, 1, withAlpha(t.tick, 0.4));
            const rows = [['Сегодня', st.today], ['За 7 дней', st.week], ['За 30 дней', st.month]];
            rows.forEach((r, i) => line(cv, t, 48, 314 + i * (62 + Math.round(ex / 3)), 712, r[0], isNum(r[1]) ? km(r[1]) + ' км' : '--'));

            // топливо
            G.panel(cv, t, 808, 44, 768, 232, 'Топливо');
            big(cv, t, 832, 172, isNum(d.tank) ? String(Math.round(d.tank)) : '--', 'л', 76);
            cv.text('запас хода', 1552, 124, 22, t.dim, { align: 'right' });
            cv.text(isNum(d.range) ? km(d.range) + ' км' : '--', 1552, 170, 44, isNum(d.range) ? t.text : t.dim, { align: 'right', font: 'bold' });
            const f = isNum(d.tank) ? G.clamp(d.tank / tankSize(), 0, 1) : 0;
            cv.roundRect(832, 196, 720, 14, 7, t.track);
            if (f > 0) cv.roundRect(832, 196, Math.max(14, 720 * f), 14, 7, f < 0.15 ? t.warn : t.accent);
            const c = L.current();
            cv.text('Этот бак: ' + (c && isNum(c.avg) ? f1(c.avg) + ' л/100 км, ' + km(c.km) + ' км' : c ? km(c.km) + ' км, расход после 20 км' : 'ждём данные'),
                832, 252, 24, t.dim);

            // бортовой компьютер
            const bp = G.panel(cv, t, 808, 292, 768, 220, 'Бортовой компьютер'), by = bp.y + bp.h - G.BOTTOM;
            const bc = d.bc || {}, tr = d.travel || {};
            label(cv, t, 832, 372, 'Средний расход');
            big(cv, t, 832, 436 + Math.round(by / 3), isNum(bc.cons) ? f1(bc.cons) : '--', bc.cu || 'л/100 км', 64);
            label(cv, t, 1210, 372, 'Средняя скорость');
            big(cv, t, 1210, 436 + Math.round(by / 3), isNum(bc.speed) ? f1(bc.speed) : '--', bc.su || 'км/ч', 64);
            const trip = [isNum(tr.km) ? km(tr.km) + ' км' : null, isNum(tr.min) ? Math.floor(tr.min / 60) + ':' + pad2(tr.min % 60) + ' ч' : null].filter(Boolean).join('  ·  ');
            cv.text('Поездка: ' + (trip || '--'), 832, 486 + G.toMargin(by, 26), 24, t.dim);
        }

        function drawDays(cv, t, d, L, now) {
            const st = L.stats(now);
            const p = G.panel(cv, t, 24, 44, 600, 468, 'Пробег'), ex = p.y + p.h - G.BOTTOM;
            const days = st.since ? Math.max(1, Math.min(30, Math.round((now - new Date(st.since + 'T00:00:00').getTime()) / DAY) + 1)) : 0;
            const rows = [['Сегодня', st.today], ['Вчера', st.yesterday], ['За 7 дней', st.week], ['С начала месяца', st.thisMonth], ['За 30 дней', st.month],
                ['В среднем за день', days && isNum(st.month) ? st.month / days : null]];
            const gap = 56 + Math.round(ex / rows.length);
            rows.forEach((r, i) => line(cv, t, 48, 140 + i * gap, 552, r[0], isNum(r[1]) ? km(r[1]) + ' км' : '--'));
            cv.text(st.since ? 'учёт с ' + dateOf(new Date(st.since + 'T12:00:00').getTime()) : 'учёт начнётся, когда придёт одометр', 48, 140 + rows.length * gap - 14, 22, t.dim);

            // столбцы за 14 дней
            const cp = G.panel(cv, t, 648, 44, 928, 468, 'По дням, км'), cy = cp.y + cp.h - G.BOTTOM;
            const list = L.daily(now, 14).reverse(), x0 = 680, bw = 54, step = 62, base = 448 + cy, top = 140;
            const max = Math.max(50, Math.max.apply(null, list.map((x) => x[1] || 0)));
            list.forEach((x, i) => {
                const v = x[1], bx = x0 + i * step, today = i === list.length - 1;
                const h = isNum(v) ? Math.round((base - top) * v / max) : 0;
                cv.roundRect(bx, top, bw, base - top, 6, withAlpha(t.track, 0.5));
                if (h > 0) cv.roundRect(bx, base - h, bw, h, 6, today ? t.accent : withAlpha(t.accent, 0.6));
                if (isNum(v) && v > 0) cv.text(String(Math.round(v)), bx + bw / 2, base - h - 10, 20, t.text, { align: 'center', font: 'bold' });
                cv.text(dayLabel(x[0]), bx + bw / 2, base + 30, 18, today ? t.text : t.dim, { align: 'center' });
            });
        }

        function drawFuel(cv, t, d, L, now) {
            const c = L.current(), a = L.average();
            G.panel(cv, t, 24, 44, 760, 200, 'Текущий бак');
            if (!c) cv.text('Ждём одометр и уровень топлива от машины', 48, 150, 26, t.dim);
            else {
                label(cv, t, 48, 118, c.partial ? 'с начала учёта, ' + dateOf(c.since) : 'с заправки ' + dateOf(c.since));
                big(cv, t, 48, 196, isNum(c.avg) ? f1(c.avg) : '--', 'л/100 км', 68, t.accent);
                cv.text(km(c.km) + ' км', 760, 164, 30, t.text, { align: 'right', font: 'bold' });
                cv.text(f1(c.l) + ' л израсходовано', 760, 198, 24, t.dim, { align: 'right' });
                if (!isNum(c.avg)) cv.text('расход - после 20 км', 760, 230, 22, t.dim, { align: 'right' });
            }
            G.panel(cv, t, 808, 44, 768, 200, 'Средний по заправкам');
            big(cv, t, 832, 196, isNum(a.avg) ? f1(a.avg) : '--', 'л/100 км', 68);
            cv.text(a.n ? a.n + ' ' + (a.n === 1 ? 'бак' : a.n < 5 ? 'бака' : 'баков') + ', ' + km(a.km) + ' км' : 'появится после первой заправки', 1552, 164, 24, t.dim, { align: 'right' });

            const tp = G.panel(cv, t, 24, 260, 1552, 252, 'Последние заправки'), ty = tp.y + tp.h - G.BOTTOM;
            const rowH = 38, fit = Math.max(1, Math.floor((156 + ty) / rowH));
            const ps = L.periods.slice().reverse().slice(0, fit);
            const cols = [{ label: 'Дата', w: 260 }, { label: 'Одометр', w: 300, align: 'right' }, { label: 'Залито', w: 260, align: 'right' },
                { label: 'Пробег на баке', w: 340, align: 'right' }, { label: 'Расход', w: 344, align: 'right' }];
            if (ps.some((x) => x.partial)) cv.text('* первый бак: учёт начат не с заправки', 1552, 296, 20, t.dim, { align: 'right' });
            G.table(cv, t, 48, 322, 1504, cols, ps.map((x) => [dateOf(x.end), km(x.odo1) + ' км', isNum(x.added) ? '+' + f1(x.added) + ' л' : '--',
                km(x.km) + ' км', isNum(per100(x.km, x.l)) ? { text: f1(per100(x.km, x.l)) + ' л/100' + (x.partial ? '*' : ''), color: x.partial ? 'dim' : null } : '--']),
            { rowH, size: 24, empty: 'Заправки появятся здесь: приложение замечает, когда уровень в баке вырос на 5 л и больше' });
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), now = Date.now();
            const demo = demoOn();
            const d = demo ? demoCar() : { odo: car.odo !== null ? car.odo : car.odoAlt, tank: car.tank, range: car.range, speed: car.speed, bc: car.bc, travel: car.travel };
            const L = demo ? demoLb : lb;
            [drawNow, drawDays, drawFuel][page](cv, t, d, L, now);
            G.frame(cv, t, PAGES, page, [demo && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }

        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_PAGE', () => go(page + 1));
        ui.onClick('BTN_PREV', () => go(page - 1));
        ctx.onTab((i) => go(i));
        // значения меняются не чаще раза в секунду: 2 кадра в секунду хватает и без GPU
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
