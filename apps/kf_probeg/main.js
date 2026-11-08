'use strict';
/**
 * Пробег и расход - реальный пробег по скорости машины (не по одометру), топливо, пробег по дням
 * и реальный расход по заправкам.
 *
 * Страницы (вкладки сверху):
 *   Сейчас    реальный пробег и одометр машины рядом, сколько из реального пути насчитал одометр,
 *             топливо и запас хода, эта поездка (путь, время в движении, средняя скорость).
 *   Пробег    реальный пробег за сегодня, вчера, неделю, месяц, средний за день, столбцы за 14 дней.
 *   Заправки  расход по уровню бака на реальные км: текущий бак, последние заправки и средний.
 *   ТО        масло, фильтры, жидкости по реальному пробегу и времени (service.js): что когда сделано,
 *             сколько осталось. Пункт выбирается кнопкой "Следующий пункт" или касанием, отмечается
 *             кнопкой "Отметить: сделано" (второе нажатие подтверждает, ещё одно в течение 2 мин - отмена).
 *
 * Реальный путь (realdist.js) - сумма скорость x время по скорости центра масс машины
 * (Vehicle2.statusCarSpeed2), которую машина считает по колёсам. Одометр машины только показывается
 * для сравнения. Все остальные цифры (дни, заправки) - на реальных км.
 *
 * Источник - только то, что машина сама шлёт головному устройству по SOME/IP: ни одного запроса в
 * блоки управления, ничего не записывается в машину. Учёт - в data/probeg.json, несколько кБ.
 * Приложение работает в фоне с запуска головного устройства до его сна; км, проеханные, когда
 * головное устройство выключено (например, его перезагрузка в пути), не считаются.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Logbook, per100 } = require('./logbook');
const { RealDistance } = require('./realdist');
const { Service } = require('./service');

const W = 1600, H = 520;
const KOMBI = 'de.bmw.infotainment.KombiIF', VI = 'de.bmw.infrastructure.VehicleInformation', V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const PAGES = ['Сейчас', 'Пробег', 'Заправки', 'ТО'];
const SVC_PAGE = 3;
const MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const CONS = { VERBRAUCH_IN_L_S_100KM: 'л/100 км', VERBRAUCH_IN_MPG_UK: 'mpg', VERBRAUCH_IN_MPG_US: 'mpg US', VERBRAUCH_IN_KM_S_L: 'км/л', 1: 'л/100 км', 2: 'mpg', 3: 'mpg US', 4: 'км/л' };
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
        const car = { odo: null, odoAlt: null, tank: null, range: null, speed: null, bc: null, at: 0 };
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
                const c = raw(v, 'consumptionAverage1BC1', undefined, [65535]);
                car.bc = { cons: c === null ? null : c * 0.1, cu: CONS[v && v.statusUnitOfMeasurementConsumptionBC] || 'л/100 км' };
                got();
            },
        }, 10000);
        // одометр бывает и в VehicleInformation.Range: им пользуемся, когда комбинация его не прислала
        watch(VI, { Range: (v) => { const o = raw(v, 'mileageKilometre', 16777215); if (o !== null && o > 0) car.odoAlt = o; } });
        // скорость - основа реального пробега: на каждое показание, и опрос раз в 2 с на случай, когда
        // скорость не меняется и уведомлений нет
        watch(V2, { statusCarSpeed2: (v) => {
            const s = raw(v, 'speedVehicleCentreOfGravity', 65535);
            car.speed = s === null ? null : s * 0.015625;
            rd.speed(Date.now(), car.speed);
            got();
        } }, 2000);

        /* ---------- учёт ---------- */
        const FILE = path.join(ctx.dataDir, 'probeg.json');
        let saved = null;
        try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* первый запуск */ }
        if (!saved || saved.v !== 2) saved = {};
        const calib = () => 1 + (Number(settings.get('calib')) || 0) / 100;
        const offset = () => (Number(settings.get('realBase')) || 0) * 1000;
        const rd = new RealDistance(saved.real, calib());
        const lb = new Logbook(saved.log);
        const sv = new Service(saved.service);
        const verOf = () => lb.ver + ':' + rd.ver + ':' + sv.ver;
        let savedVer = verOf(), savedAt = Date.now();
        function save() {
            try {
                fs.writeFileSync(FILE + '.tmp', JSON.stringify({ v: 2, real: rd, log: lb, service: sv }));
                fs.renameSync(FILE + '.tmp', FILE);
                savedVer = verOf(); savedAt = Date.now();
            } catch (e) { log.warn('save: ' + e); }
        }
        // головное устройство засыпает - процесс завершается: учёт сохраняется
        process.on('exit', () => { if (verOf() !== savedVer) save(); });
        process.on('SIGTERM', () => { if (verOf() !== savedVer) save(); process.exit(0); });
        const started = Date.now();
        setInterval(() => {
            try {
                const now = Date.now();
                rd.calib = calib();
                rd.tick(now);
                sv.settle(now);
                const carOdo = car.odo !== null ? car.odo : car.odoAlt;
                if (carOdo !== null) rd.car(carOdo);
                // в учёт дней и заправок идёт реальный пробег без поправки: поправка лишь сдвигает показ
                const odo = rd.odo(0);
                if (odo === null && car.tank === null) return;
                const r = lb.feed(now, { odo, tank: car.tank, speed: car.speed });
                if (r.refuel) { log.info('refuel: +' + r.refuel.added + ' l at real ' + Math.round(r.refuel.odo) + ' km (' + r.refuel.before + ' -> ' + r.refuel.after + ' l)'); save(); }
                else if (verOf() !== savedVer && now - savedAt > 30000) save();
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
            return { real: demoLb.odo, carOdo: 41980 + Math.round((demoLb.odo - 53250) * 0.35), ratio: 0.35, carOdo0: 41980, since: Date.now() - 34 * DAY, tank: demoLb.tank,
                range: Math.round(demoLb.tank / 11.4 * 100), speed: 62 + 8 * Math.sin(s / 7),
                trip: { km: 23.4 + s / 60, moveMs: 31 * 60000 + s * 1000 }, bc: { cons: 31.8, cu: 'л/100 км' } };
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
            // реальный пробег и одометр машины рядом
            const p = G.panel(cv, t, 24, 44, 760, 468, 'Реальный пробег'), ex = p.y + p.h - G.BOTTOM;
            big(cv, t, 48, 196, km(d.real), 'км', 112, t.accent);
            cv.fillRect(48, 240, 712, 1, withAlpha(t.tick, 0.4));
            const rows = [['Сегодня', isNum(st.today) ? km(st.today) + ' км' : '--'], ['За 7 дней', isNum(st.week) ? km(st.week) + ' км' : '--'],
                ['Одометр машины', isNum(d.carOdo) ? km(d.carOdo) + ' км' : '--'],
                ['Одометр насчитал', isNum(d.ratio) ? Math.round(d.ratio * 100) + ' % пути' : '--']];
            const gap = 52 + Math.round(ex / rows.length);
            rows.forEach((r, i) => line(cv, t, 48, 292 + i * gap, 712, r[0], r[1]));
            if (d.since) cv.text('учёт с ' + dateOf(d.since) + (isNum(d.carOdo0) ? ', одометр тогда ' + km(d.carOdo0) + ' км' : ''), 48, 292 + rows.length * gap - 16, 20, t.dim);

            // топливо; запас хода - по реальному расходу, когда он уже известен
            G.panel(cv, t, 808, 44, 768, 232, 'Топливо');
            big(cv, t, 832, 172, isNum(d.tank) ? String(Math.round(d.tank)) : '--', 'л', 76);
            const c = L.current(), a = L.average(), avg = c && isNum(c.avg) && c.km >= 100 ? c.avg : isNum(a.avg) ? a.avg : c && isNum(c.avg) ? c.avg : null;
            const range = isNum(avg) && isNum(d.tank) ? d.tank / avg * 100 : d.range;
            cv.text(isNum(avg) ? 'запас хода, реальный' : 'запас хода (машина)', 1552, 124, 22, t.dim, { align: 'right' });
            cv.text(isNum(range) ? km(range) + ' км' : '--', 1552, 170, 44, isNum(range) ? t.text : t.dim, { align: 'right', font: 'bold' });
            const f = isNum(d.tank) ? G.clamp(d.tank / tankSize(), 0, 1) : 0;
            cv.roundRect(832, 196, 720, 14, 7, t.track);
            if (f > 0) cv.roundRect(832, 196, Math.max(14, 720 * f), 14, 7, f < 0.15 ? t.warn : t.accent);
            cv.text('Этот бак: ' + (c && isNum(c.avg) ? f1(c.avg) + ' л/100 км, ' + km(c.km) + ' км' : c ? km(c.km) + ' км, расход после 20 км' : 'ждём данные'),
                832, 252, 24, t.dim);

            // эта поездка - по реальному пути, с запуска головного устройства
            const bp = G.panel(cv, t, 808, 292, 768, 220, 'Эта поездка'), by = bp.y + bp.h - G.BOTTOM;
            const tr = d.trip || {}, min = isNum(tr.moveMs) ? Math.round(tr.moveMs / 60000) : null;
            const vs = isNum(tr.km) && tr.moveMs > 60000 ? tr.km / (tr.moveMs / 3600000) : null;
            const yv = 436 + Math.round(by / 3);
            label(cv, t, 832, 372, 'Путь');
            big(cv, t, 832, yv, isNum(tr.km) ? f1(tr.km) : '--', 'км', 56);
            label(cv, t, 1090, 372, 'В движении');
            big(cv, t, 1090, yv, min === null ? '--' : Math.floor(min / 60) + ':' + pad2(min % 60), 'ч', 56);
            label(cv, t, 1330, 372, 'Ср. скорость');
            big(cv, t, 1330, yv, isNum(vs) ? String(Math.round(vs)) : '--', 'км/ч', 56);
            const bc = d.bc || {};
            cv.text('БК машины: ' + (isNum(bc.cons) ? f1(bc.cons) + ' ' + (bc.cu || 'л/100 км') : '--') + ', считает по одометру', 832, 486 + G.toMargin(by, 26), 22, t.dim);
        }

        function drawDays(cv, t, d, L, now) {
            const st = L.stats(now);
            const p = G.panel(cv, t, 24, 44, 600, 468, 'Пробег'), ex = p.y + p.h - G.BOTTOM;
            const days = st.since ? Math.max(1, Math.min(30, Math.round((now - new Date(st.since + 'T00:00:00').getTime()) / DAY) + 1)) : 0;
            const rows = [['Сегодня', st.today], ['Вчера', st.yesterday], ['За 7 дней', st.week], ['С начала месяца', st.thisMonth], ['За 30 дней', st.month],
                ['В среднем за день', days && isNum(st.month) ? st.month / days : null]];
            const gap = 56 + Math.round(ex / rows.length);
            rows.forEach((r, i) => line(cv, t, 48, 140 + i * gap, 552, r[0], isNum(r[1]) ? km(r[1]) + ' км' : '--'));
            cv.text(st.since ? 'учёт с ' + dateOf(new Date(st.since + 'T12:00:00').getTime()) : 'учёт начнётся с первой поездки', 48, 140 + rows.length * gap - 14, 22, t.dim);

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
            const cols = [{ label: 'Дата', w: 260 }, { label: 'Реальный пробег', w: 300, align: 'right' }, { label: 'Залито', w: 260, align: 'right' },
                { label: 'Пробег на баке', w: 340, align: 'right' }, { label: 'Расход', w: 344, align: 'right' }];
            if (ps.some((x) => x.partial)) cv.text('* первый бак: учёт начат не с заправки', 1552, 296, 20, t.dim, { align: 'right' });
            G.table(cv, t, 48, 322, 1504, cols, ps.map((x) => [dateOf(x.end), km(x.odo1 + (demoOn() ? 0 : offset())) + ' км', isNum(x.added) ? '+' + f1(x.added) + ' л' : '--',
                km(x.km) + ' км', isNum(per100(x.km, x.l)) ? { text: f1(per100(x.km, x.l)) + ' л/100' + (x.partial ? '*' : ''), color: x.partial ? 'dim' : null } : '--']),
            { rowH, size: 24, empty: 'Заправки появятся здесь: приложение замечает, когда уровень в баке вырос на 5 л и больше' });
        }

        /* ---------- ТО ---------- */
        let sel = 0, note = null;              // выбранный пункт; подсказка после нажатия { text, until }
        const svcItems = () => sv.items({ engine: settings.get('engine') || 'petrol', oilKm: Number(settings.get('oilKm')) || 10000 });
        const SV_TOP = 100, SV_ROW = 38;
        let svRowH = SV_ROW;               // высота строки на последнем кадре - для касаний
        function when(days) {
            if (days === null) return '';
            const a = Math.abs(days), m = Math.round(a / 30.44);
            const txt = a < 45 ? a + ' дн' : m < 24 ? m + ' мес' : Math.round(a / 365) + ' г';
            return days <= 0 ? 'срок прошёл ' + txt + ' назад' : 'через ' + txt;
        }
        function drawService(cv, t, d, L, now, demo) {
            const items = svcItems(), odo = demo ? demoLb.odo : rd.odo(0), off = demo ? 0 : offset();
            if (sel >= items.length) sel = 0;
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'Техобслуживание по реальному пробегу'), ey = p.y + p.h - G.BOTTOM;
            const cols = [{ label: 'Пункт', w: 470 }, { label: 'Интервал', w: 250 }, { label: 'Последний раз', w: 330 }, { label: 'Осталось', w: 220, align: 'right' }, { label: 'Срок', w: 234, align: 'right' }];
            const rows = items.map((it, i) => {
                const st = demo ? demoSvc(it, odo, now) : sv.status(it, odo, now);
                const color = st.state === 'due' ? 'crit' : st.state === 'soon' ? 'warn' : null;
                const iv = [isNum(it.km) ? group(it.km) + ' км' : null, isNum(it.months) ? (it.months % 12 ? it.months + ' мес' : it.months / 12 + (it.months === 12 ? ' год' : ' г')) : null].filter(Boolean).join(' / ');
                const conf = !demo && sv.confirming(it.id, now);
                return [{ text: it.name, color: i === sel ? 'accent' : null, font: i === sel ? 'bold' : null },
                    { text: iv, color: 'dim' },
                    st.last ? km(st.last.km + off) + ' км, ' + dateOf(st.last.t) : { text: conf ? 'нажмите ещё раз' : 'не отмечено', color: conf ? 'warn' : 'dim' },
                    st.kmLeft === null ? '' : { text: (st.kmLeft < 0 ? '−' : '') + km(Math.abs(st.kmLeft)) + ' км', color },
                    { text: when(st.daysLeft), color: st.daysLeft !== null && st.daysLeft <= 30 ? color || 'warn' : 'dim' }];
            });
            const rowH = svRowH = SV_ROW + Math.max(0, Math.floor(ey / items.length));
            cv.roundRect(36, SV_TOP + 30 + sel * rowH, 1528, rowH, 6, withAlpha(t.accent, 0.12));
            cv.fillRect(36, SV_TOP + 30 + sel * rowH + 6, 4, rowH - 12, t.accent);
            G.table(cv, t, 48, SV_TOP, 1504, cols, rows, { rowH, size: 24, stripe: false });
            const msg = note && now < note.until ? note.text
                : 'Выберите пункт кнопкой «Следующий пункт» или касанием и нажмите «Отметить: сделано», когда работа сделана';
            cv.text(msg, 48, 492 + ey, 22, note && now < note.until ? t.text : t.dim);
        }
        // цифры для демо: часть пунктов сделана, одно просрочено
        function demoSvc(it, odo, now) {
            const ago = { oil: [10300, 300], air: [12000, 300], cabin: [8600, 200], brake: [0, 690], pads: [8600, 200], atf: [null, 0] }[it.id];
            if (!ago || ago[0] === null) return { last: null, kmLeft: null, daysLeft: null, state: 'none' };
            const fake = new Service({ log: { [it.id]: [{ t: now - ago[1] * DAY, km: odo - ago[0] }] } });
            return fake.status(it, odo, now);
        }
        const overdue = () => {
            const odo = rd.odo(0);
            return svcItems().filter((it) => { const st = sv.status(it, odo, Date.now()); return st.state === 'due'; }).length;
        };
        function pressDone() {
            if (page !== SVC_PAGE) return go(SVC_PAGE);
            const it = svcItems()[sel], now = Date.now();
            if (demoOn()) { note = { until: now + 6000, text: 'Демо-режим: отметки не сохраняются' }; return render(); }
            const r = sv.press(it.id, rd.odo(0), now);
            const at = rd.odo(offset());
            note = { until: now + 6000, text: r.kind === 'confirm' ? 'Отметить «' + it.name + '» сделанным на ' + km(at) + ' км? Нажмите «Отметить» ещё раз'
                : r.kind === 'done' ? '«' + it.name + '» отмечено на ' + km(at) + ' км. Ошиблись - нажмите «Отметить» в течение 2 минут'
                    : r.kind === 'undone' ? 'Отметка «' + it.name + '» отменена'
                        : 'Реальный пробег ещё не известен: нужен одометр от машины' };
            if (r.kind === 'done' || r.kind === 'undone') save();
            return render();
        }
        function nextItem() {
            if (page !== SVC_PAGE) return go(SVC_PAGE);
            sel = (sel + 1) % svcItems().length; note = null; sv.pending = null;
            return render();
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), now = Date.now();
            const demo = demoOn();
            const d = demo ? demoCar() : { real: rd.odo(offset()), carOdo: car.odo !== null ? car.odo : car.odoAlt, carOdo0: rd.carOdo0, since: rd.start,
                ratio: rd.ratio(), tank: car.tank, range: car.range, speed: car.speed, trip: rd.trip, bc: car.bc };
            const L = demo ? demoLb : lb;
            [drawNow, drawDays, drawFuel, drawService][page](cv, t, d, L, now, demo);
            const late = demo ? 0 : overdue();
            G.frame(cv, t, PAGES, page, [demo && { text: 'DEMO' }, late && { text: 'ТО: ' + late, color: 'crit' }]);
            await ui.image('MAIN_GFX', cv);
        }

        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_PAGE', () => go(page + 1));
        ui.onClick('BTN_ITEM', nextItem);
        ui.onClick('BTN_DONE', pressDone);
        ctx.onTab((i) => go(i));
        // касание строки на странице ТО выбирает пункт
        ctx.onTap((x, y) => {
            if (page !== SVC_PAGE) return;
            const n = svcItems().length, i = Math.floor((y - SV_TOP - 30) / svRowH);
            if (i >= 0 && i < n && i !== sel) { sel = i; note = null; sv.pending = null; render(); }
        });
        // значения меняются не чаще раза в секунду: 2 кадра в секунду хватает и без GPU
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
