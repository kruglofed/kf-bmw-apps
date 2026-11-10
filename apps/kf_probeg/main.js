'use strict';
/**
 * Пробег и расход - реальный пробег по скорости машины (не по одометру), топливо, пробег по дням
 * и реальный расход по заправкам.
 *
 * Страницы (вкладки сверху):
 *   Сейчас    реальный пробег и одометр машины рядом, сколько из реального пути насчитал одометр,
 *             топливо и запас хода, эта поездка (путь, время в движении, средняя скорость).
 *   Неделя    по дням за 7 дней: км, время в движении, средняя и максимальная скорость, топливо (л и руб),
 *             расход и рейтинг стиля; итог за неделю.
 *   Стиль     рейтинг экономичности 0-100 за сегодня и за неделю (drive.js): резкие разгоны, торможения,
 *             повороты на 100 км и средний разгон, совет, что больше всего снижает рейтинг.
 *   Пробег    реальный пробег за сегодня, вчера, неделю, месяц, средний за день, столбцы за 14 дней.
 *   Заправки  расход по уровню бака на реальные км: текущий бак, цена топлива, последние заправки
 *             (залито, цена, сумма) и средний. Цена (prices.js) - для бака: меняется кнопками "Цена
 *             топлива" в меню и действует с последней заправки, прошлые баки сохраняют свою цену.
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
const { RealDistance, realRange } = require('./realdist');
const { Service } = require('./service');
const { Drive, rate, sum, dayKey } = require('./drive');
const { Prices } = require('./prices');
const Costs = require('./costs');

const W = 1600, H = 520;
const KOMBI = 'de.bmw.infotainment.KombiIF', VI = 'de.bmw.infrastructure.VehicleInformation', V2 = 'de.bmw.infotainment.vehicle.Vehicle2';
const PAGES = ['Сейчас', 'Неделя', 'Стиль', 'Пробег', 'Заправки', 'Расходы', 'ТО'];
const SVC_PAGE = PAGES.indexOf('ТО');
const LEVEL_ERR_L = 1.5;     // погрешность расхода по датчику бака, л
const CDS2 = 'de.bmw.infotainment.vehicle.CDS2';
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
            const now = Date.now(), k0 = rd.counted, m0 = rd.trip.moveMs;
            rd.speed(now, car.speed);
            dv.speed(now, car.speed, rd.counted - k0, rd.trip.moveMs - m0);
            got();
        } }, 2000);
        // боковое ускорение - для резких поворотов (шкала как в G-Force: x 0,002 - 65 м/с^2)
        watch(CDS2, { statusLateralAccelerationMassCenter: (v) => {
            const a = raw(v, 'lateralAccelerationCentreOfGravity', 65535);
            if (a !== null) dv.lat(Date.now(), a * 0.002 - 65);
        } });

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
        const dv = new Drive(saved.drive);
        // первая цена - из настройки прошлой версии, если она была задана
        const pr = new Prices(saved.prices, Number(settings.get('fuelPrice')) || 81);
        const verOf = () => lb.ver + ':' + rd.ver + ':' + sv.ver + ':' + dv.ver + ':' + pr.ver;
        let savedVer = verOf(), savedAt = Date.now();
        function save() {
            try {
                fs.writeFileSync(FILE + '.tmp', JSON.stringify({ v: 2, real: rd, log: lb, service: sv, drive: dv, prices: pr }));
                fs.renameSync(FILE + '.tmp', FILE);
                savedVer = verOf(); savedAt = Date.now();
            } catch (e) { log.warn('save: ' + e); }
        }
        // головное устройство засыпает - процесс завершается: учёт сохраняется
        process.on('exit', () => { if (verOf() !== savedVer) save(); });
        process.on('SIGTERM', () => { if (verOf() !== savedVer) save(); process.exit(0); });
        const started = Date.now();
        let fuelNote = null;               // после заправки: напоминание проверить цену { until, refuel }
        setInterval(() => {
            try {
                const now = Date.now();
                rd.calib = calib();
                const k0 = rd.counted, m0 = rd.trip.moveMs;
                rd.tick(now);
                dv.move(now, rd.counted - k0, rd.trip.moveMs - m0);
                sv.settle(now);
                const carOdo = car.odo !== null ? car.odo : car.odoAlt;
                if (carOdo !== null) rd.car(carOdo);
                // пункты из заказ-нарядов - на вкладку ТО, с реальным пробегом на дату наряда
                Costs.RECEIPTS.forEach((rc) => {
                    const k = Costs.receiptKm(rc, rd.odo(0), carOdo, rd.counted >= 50 ? rd.ratio() : null);
                    rc.items.forEach((it) => { if (k) sv.receipt(it.id, Costs.dateMs(rc.date), k.km, k.est); });
                });
                // в учёт дней и заправок идёт реальный пробег без поправки: поправка лишь сдвигает показ
                const odo = rd.odo(0);
                if (odo === null && car.tank === null) return;
                const r = lb.feed(now, { odo, tank: car.tank, speed: car.speed });
                if (r.refuel) fuelNote = { until: now + 30 * 60000, refuel: r.refuel };
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
        const demoDv = (() => {
            const d = new Drive(null), now = Date.now();
            const runs = [[38, 41, 112, 2, 3, 1], [42, 37, 96, 1, 1, 0], [65, 52, 131, 4, 2, 1], [18, 28, 74, 2, 3, 0], [120, 78, 148, 3, 2, 1], [55, 44, 104, 6, 7, 3], [0], [73, 61, 127, 1, 1, 0]];
            for (let i = 0; i < 8; i++) {
                const r = runs[i]; if (!r[0]) continue;
                d.days[dayKey(now - i * DAY)] = { km: r[0], moveMs: r[0] / r[1] * 3600000, vmax: r[2], acc: r[3], brk: r[4], turn: r[5], posA: 0.62 * r[0] * 9, posT: r[0] * 9 };
            }
            return d;
        })();
        const demoPr = (() => {
            const ends = demoLb.periods.map((x) => x.end);
            const list = [[78.9], [80.2], [81]].map((p, i) => ({ t: ends[ends.length - 3 + i], p: p[0] })).filter((e) => e.t);
            return new Prices({ first: 78.5, list }, 81);
        })();
        function demoCar() {
            const s = (Date.now() - demoT0) / 1000;
            return { real: demoLb.odo, carOdo: 41980 + Math.round((demoLb.odo - 53250) * 0.35), ratio: 0.35, carOdo0: 41980, since: Date.now() - 34 * DAY, tank: demoLb.tank,
                range: Math.round(demoLb.tank / 11.4 * 100 * 0.35), ratioOk: 0.35, speed: 62 + 8 * Math.sin(s / 7),
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

        /** датчик бака меряет с точностью около 1,5 л: на малом пути расход ещё неточный */
        function errNote(k) {
            if (!isNum(k) || k >= 300) return '';
            return ' ±' + f1(LEVEL_ERR_L / k * 100);
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
            // два запаса хода рядом: что пишет машина (в км её одометра) и реальный
            const rr = realRange(d.tank, avg, d.range, d.ratioOk);
            cv.text('запас хода, машина', 1250, 124, 22, t.dim, { align: 'right' });
            cv.text(isNum(d.range) ? km(d.range) + ' км' : '--', 1250, 170, 40, isNum(d.range) ? t.text : t.dim, { align: 'right', font: 'bold' });
            cv.text(rr && rr.how === 'ratio' ? 'реальный, примерно' : 'запас хода, реальный', 1552, 124, 22, t.dim, { align: 'right' });
            cv.text(rr ? (rr.how === 'ratio' ? '≈' : '') + km(rr.km) + ' км' : '--', 1552, 170, 44, rr ? t.accent : t.dim, { align: 'right', font: 'bold' });
            const f = isNum(d.tank) ? G.clamp(d.tank / tankSize(), 0, 1) : 0;
            cv.roundRect(832, 196, 720, 14, 7, t.track);
            if (f > 0) cv.roundRect(832, 196, Math.max(14, 720 * f), 14, 7, f < 0.15 ? t.warn : t.accent);
            cv.text('Реальный расход: ' + (c && isNum(c.avg) ? f1(c.avg) + ' л/100 км' + errNote(c.km) + ' (' + f1(c.l) + ' л из бака на ' + km(c.km) + ' км)' : c ? 'после 20 км, пока ' + km(c.km) + ' км' : 'ждём данные'),
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
            cv.text('БК машины: ' + (isNum(bc.cons) ? f1(bc.cons) + ' ' + (bc.cu || 'л/100 км') : '--') + ' - по стоп-пробегу, неверно', 832, 486 + G.toMargin(by, 26), 22, t.dim);
        }

        const P = () => (demoOn() ? demoPr : pr);
        const price = () => P().at(Date.now());
        const rubl = (x) => (isNum(x) ? x.toFixed(2).replace('.', ',') : '--');
        const rub = (x) => (isNum(x) ? group(x) + ' руб' : '--');
        const scoreColor = (t, sc) => (sc === null ? t.dim : sc >= 85 ? t.accent : sc >= 70 ? t.text : sc >= 50 ? t.warn : t.crit);
        /** день: { km, moveMs, vmax, avg, fuel, cost, cons, rate } */
        function dayInfo(dd, fuel, cost) {
            const k = dd ? dd.km : 0, l = isNum(fuel) ? fuel : null;
            return {
                km: dd ? k : null, moveMs: dd ? dd.moveMs : null, vmax: dd && dd.vmax > 0 ? dd.vmax : null,
                avg: dd && dd.moveMs > 60000 ? k / (dd.moveMs / 3600000) : null,
                fuel: l, cost: l === null ? null : isNum(cost) ? cost : l * price(), cons: l !== null && k >= 20 ? l / k * 100 : null, rate: rate(dd),
            };
        }
        const hm = (ms) => { if (!isNum(ms)) return '--'; const m = Math.round(ms / 60000); return Math.floor(m / 60) + ':' + pad2(m % 60); };

        function drawWeek(cv, t, d, L, now, demo) {
            const D = demo ? demoDv : dv;
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'Последние 7 дней'), ey = p.y + p.h - G.BOTTOM;
            const list = D.list(now, 7);
            const cols = [{ label: 'День', w: 170 }, { label: 'Км', w: 140, align: 'right' }, { label: 'В движении', w: 170, align: 'right' },
                { label: 'Ср. скорость', w: 180, align: 'right' }, { label: 'Макс.', w: 150, align: 'right' }, { label: 'Топливо', w: 150, align: 'right' },
                { label: 'Стоимость', w: 170, align: 'right' }, { label: 'Реальн. расход', w: 190, align: 'right' }, { label: 'Стиль', w: 184, align: 'right' }];
            const row = (name, x, bold) => [{ text: name, font: bold ? 'bold' : null }, isNum(x.km) ? km(x.km) : '--', hm(x.moveMs),
                isNum(x.avg) ? Math.round(x.avg) + ' км/ч' : '--', isNum(x.vmax) ? Math.round(x.vmax) + ' км/ч' : '--',
                isNum(x.fuel) ? f1(x.fuel) + ' л' : '--', rub(x.cost), isNum(x.cons) ? f1(x.cons) + ' л/100' : '--',
                x.rate ? { text: String(x.rate.score), font: 'bold', color: x.rate.score >= 85 ? 'accent' : x.rate.score >= 70 ? null : x.rate.score >= 50 ? 'warn' : 'crit' } : '--'];
            const at = (x) => P().at(x), costOf = (k) => L.fuelCost(k, at);
            const rows = list.map((e) => row(dayLabel(e[0]), e[1] ? dayInfo(e[1], L.fuel[e[0]], costOf(e[0])) : { km: null }));
            const all = sum(list.map((e) => e[1])), fuelAll = list.reduce((a, e) => a + (L.fuel[e[0]] || 0), 0);
            const costAll = list.reduce((a, e) => a + (costOf(e[0]) || 0), 0);
            rows.push(row('За неделю', dayInfo(all.km > 0 ? all : null, fuelAll || null, costAll || null), true));
            const rowH = 38 + Math.max(0, Math.floor(ey / 8));
            G.table(cv, t, 48, 100, 1504, cols, rows, { rowH, size: 23 });
            cv.fillRect(40, 130 + 7 * rowH, 1520, 1, withAlpha(t.tick, 0.5));
            cv.text('Топливо - по уровню в баке (точность около 1 л за день), стоимость - по цене бака, из которого оно ушло. Расход - для дней от 20 км',
                48, 492 + ey, 20, t.dim);
        }

        const TIPS = {
            acc: 'Больше всего баллов снимают резкие разгоны: нажимайте газ плавнее, разгон съедает больше всего топлива',
            brk: 'Больше всего баллов снимают резкие торможения: держите дистанцию и отпускайте газ заранее',
            turn: 'Больше всего баллов снимают резкие повороты: сбавляйте скорость до поворота',
            smooth: 'Средний разгон высокий: педаль газа можно нажимать мягче',
        };
        function drawStyle(cv, t, d, L, now, demo) {
            const D = demo ? demoDv : dv;
            const today = D.day(dayKey(now)), r = rate(today);
            const p = G.panel(cv, t, 24, 44, 760, 468, 'Стиль сегодня'), ey = p.y + p.h - G.BOTTOM;
            big(cv, t, 48, 200, r ? String(r.score) : '--', 'из 100', 120, scoreColor(t, r ? r.score : null));
            cv.text(r ? r.label : 'после 5 км за день', 760, 200, 34, r ? scoreColor(t, r.score) : t.dim, { align: 'right', font: 'bold' });
            cv.fillRect(48, 236, 712, 1, withAlpha(t.tick, 0.4));
            const per = (n, x) => (r ? n + ' (' + f1(x) + ' на 100 км)' : '--');
            const rows = [['Резкие разгоны', today ? per(today.acc, r && r.parts.perAcc) : '--'], ['Резкие торможения', today ? per(today.brk, r && r.parts.perBrk) : '--'],
                ['Резкие повороты', today ? per(today.turn, r && r.parts.perTurn) : '--'], ['Средний разгон', r ? f1(r.parts.avgAcc) + ' м/с²' : '--']];
            const gap = 52 + Math.round(ey / 4);
            rows.forEach((x, i) => line(cv, t, 48, 286 + i * gap, 712, x[0], x[1]));
            cv.text('резкие: разгон от 2,5 м/с², торможение от 3 м/с², поворот от 4 м/с²', 48, 286 + 4 * gap - 18, 20, t.dim);

            // неделя: рейтинг по дням
            const list = D.list(now, 7).reverse(), wr = rate(sum(list.map((e) => e[1])));
            const wp = G.panel(cv, t, 808, 44, 768, 468, 'За 7 дней'), wy = wp.y + wp.h - G.BOTTOM;
            big(cv, t, 832, 170, wr ? String(wr.score) : '--', wr ? wr.label.toLowerCase() : 'из 100', 84, scoreColor(t, wr ? wr.score : null));
            const x0 = 836, bw = 80, step = 100, base = 380 + Math.round(wy / 2), top = 210;
            list.forEach((e, i) => {
                const dr = rate(e[1]), bx = x0 + i * step, h = dr ? Math.round((base - top) * dr.score / 100) : 0;
                cv.roundRect(bx, top, bw, base - top, 6, withAlpha(t.track, 0.5));
                if (h > 0) cv.roundRect(bx, base - h, bw, h, 6, withAlpha(scoreColor(t, dr.score), i === list.length - 1 ? 1 : 0.7));
                cv.text(dr ? String(dr.score) : '', bx + bw / 2, base - h - 10, 20, t.text, { align: 'center', font: 'bold' });
                cv.text(dayLabel(e[0]), bx + bw / 2, base + 28, 18, i === list.length - 1 ? t.text : t.dim, { align: 'center' });
            });
            // совет: что больше всего снижает рейтинг за неделю
            let tip = wr ? 'Отличная плавная езда - так и дальше' : 'Рейтинг появится после первых 5 км';
            if (wr && wr.score < 85) {
                const worst = ['acc', 'brk', 'turn', 'smooth'].sort((a, b) => wr.parts[b] - wr.parts[a])[0];
                tip = TIPS[worst];
            }
            const lines = cv.textWidth(tip, 20) > 712 ? wrap(cv, tip, 20, 712) : [tip];
            lines.slice(0, 2).forEach((s, i) => cv.text(s, 832, 462 + wy + i * 26 - (lines.length > 1 ? 26 : 0), 20, t.dim));
        }
        function wrap(cv, text, size, w) {
            const out = []; let cur = '';
            text.split(' ').forEach((word) => {
                const next = cur ? cur + ' ' + word : word;
                if (cv.textWidth(next, size) > w && cur) { out.push(cur); cur = word; } else cur = next;
            });
            if (cur) out.push(cur);
            return out;
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
            const c = L.current(), a = L.average(), Pr = P(), demo = demoOn();
            G.panel(cv, t, 24, 44, 500, 200, 'Реальный расход, этот бак');
            if (!c) cv.text('Ждём данные от машины', 48, 150, 24, t.dim);
            else {
                label(cv, t, 48, 118, c.partial ? 'с начала учёта, ' + dateOf(c.since) : 'с заправки ' + dateOf(c.since));
                big(cv, t, 48, 196, isNum(c.avg) ? f1(c.avg) : '--', 'л/100', 64, t.accent);
                cv.text(km(c.km) + ' км', 500, 164, 28, t.text, { align: 'right', font: 'bold' });
                cv.text(f1(c.l) + ' л', 500, 198, 24, t.dim, { align: 'right' });
                if (!isNum(c.avg)) cv.text('расход - после 20 км', 500, 230, 20, t.dim, { align: 'right' });
            }

            // цена топлива этого бака
            G.panel(cv, t, 540, 44, 520, 200, 'Цена топлива');
            const since = L.fill ? L.fill.t : null, cur = Pr.at(since !== null ? since : now);
            label(cv, t, 564, 118, since !== null && !L.fill.partial ? 'этот бак, с заправки ' + dateOf(since) : 'этот бак');
            const fn = fuelNote && now < fuelNote.until && !demo ? fuelNote : null;
            const hint = fn ? 'Залито ' + f1(fn.refuel.added) + ' л. Цена другая? Кнопки «Цена топлива»'
                : priceNote && now < priceNote.until ? priceNote.text : 'меняется кнопками «Цена топлива» в меню';
            const hl = wrap(cv, hint, 20, 472);
            const hs = hl.slice(0, 2), warnTxt = fn || (priceNote && now < priceNote.until);
            big(cv, t, 564, hs.length > 1 ? 178 : 196, rubl(cur), 'руб/л', hs.length > 1 ? 56 : 64);
            hs.forEach((x, i) => cv.text(x, 564, 230 + (i - hs.length + 1) * 22, 19, warnTxt ? t.warn : t.dim));

            G.panel(cv, t, 1076, 44, 500, 200, 'Реальный, средний');
            big(cv, t, 1100, 196, isNum(a.avg) ? f1(a.avg) : '--', 'л/100', 64);
            cv.text(a.n ? a.n + ' ' + (a.n === 1 ? 'бак' : a.n < 5 ? 'бака' : 'баков') + ', ' + km(a.km) + ' км' : 'после первой заправки', 1552, 118, 22, t.dim, { align: 'right' });
            if (isNum(a.avg)) cv.text('~' + group(a.avg * cur) + ' руб / 100 км', 1552, 152, 22, t.dim, { align: 'right' });

            const tp = G.panel(cv, t, 24, 260, 1552, 252, 'Последние заправки'), ty = tp.y + tp.h - G.BOTTOM;
            const rowH = 38, fit = Math.max(1, Math.floor((156 + ty) / rowH));
            const ps = L.periods.slice().reverse().slice(0, fit);
            const cols = [{ label: 'Дата', w: 170 }, { label: 'Реальный пробег', w: 250, align: 'right' }, { label: 'Залито', w: 170, align: 'right' },
                { label: 'Цена', w: 190, align: 'right' }, { label: 'Сумма', w: 200, align: 'right' }, { label: 'Пробег на баке', w: 250, align: 'right' },
                { label: 'Реальный расход', w: 274, align: 'right' }];
            if (ps.some((x) => x.partial)) cv.text('* первый бак: учёт начат не с заправки', 1552, 296, 20, t.dim, { align: 'right' });
            G.table(cv, t, 48, 322, 1504, cols, ps.map((x) => {
                const p = Pr.at(x.end);
                return [dateOf(x.end), km(x.odo1 + (demo ? 0 : offset())) + ' км', isNum(x.added) ? '+' + f1(x.added) + ' л' : '--',
                    rubl(p) + ' руб', isNum(x.added) ? group(x.added * p) + ' руб' : '--', km(x.km) + ' км',
                    isNum(per100(x.km, x.l)) ? { text: f1(per100(x.km, x.l)) + ' л/100' + (x.partial ? '*' : ''), color: x.partial ? 'dim' : null } : '--'];
            }),
            { rowH, size: 24, empty: 'Заправки появятся здесь: приложение замечает, когда уровень в баке вырос на 5 л и больше' });
        }

        /* ---------- расходы: топливо и ТО на 1 км ---------- */
        const rk = (x) => (isNum(x) ? x.toFixed(2).replace('.', ',') : '--');
        /** средний расход, л/100: текущий бак от 100 км, иначе средний по бакам, иначе текущий */
        function avgCons(L) {
            const c = L.current(), a = L.average();
            return c && isNum(c.avg) && c.km >= 100 ? c.avg : isNum(a.avg) ? a.avg : c && isNum(c.avg) ? c.avg : null;
        }
        /** откуда взят расход: км, на которых он посчитан (для оценки точности) */
        function consKm(L) {
            const c = L.current(), a = L.average();
            return c && isNum(c.avg) && c.km >= 100 ? c.km : isNum(a.avg) ? a.km : c && isNum(c.avg) ? c.km : null;
        }
        /** деньги на топливо за дни fromKey..toKey (по уровню в баке и цене бака) */
        function fuelSpent(L, fromKey, toKey) {
            const at = (x) => P().at(x);
            return Object.keys(L.fuel).filter((k) => k >= fromKey && k <= toKey).reduce((a, k) => a + (L.fuelCost(k, at) || 0), 0);
        }
        function drawCosts(cv, t, d, L, now) {
            const st = L.stats(now);
            const days = st.since ? Math.round((now - new Date(st.since + 'T00:00:00').getTime()) / DAY) + 1 : 0;
            const kmPerDay = days >= 7 && isNum(st.month) ? st.month / Math.min(30, days) : null;
            const to = Costs.toPerKm({ oilKm: Number(settings.get('oilKm')) || 10000, kmPerDay });
            const cons = avgCons(L), fuelKm = isNum(cons) ? cons * price() / 100 : null;
            const allKm = isNum(fuelKm) ? fuelKm + to.total : null;

            const p = G.panel(cv, t, 24, 44, 600, 468, 'Стоимость 1 км'), ex = p.y + p.h - G.BOTTOM;
            big(cv, t, 48, 186, isNum(allKm) ? rk(allKm) : rk(to.total) + '+', 'руб/км', 88, t.accent);
            cv.fillRect(48, 222, 552, 1, withAlpha(t.tick, 0.4));
            line(cv, t, 48, 266, 552, 'Топливо' + (isNum(cons) ? ' (реальн. ' + f1(cons) + errNote(consKm(L)) + ' л/100)' : ''), isNum(fuelKm) ? rk(fuelKm) + ' руб/км' : '-- нужен расход');
            line(cv, t, 48, 310, 552, 'Техобслуживание', rk(to.total) + ' руб/км');
            const gap = 26 + Math.round(ex / 6);
            to.items.forEach((it, i) => {
                const y = 352 + i * gap;
                cv.text(it.name + ': ' + group(it.cost) + ' руб / ' + km(it.km) + ' км', 64, y, 20, t.dim);
                cv.text(rk(it.perKm), 600, y, 20, t.dim, { align: 'right' });
            });

            const today = dayKey(now), y = dayKey(now - DAY), dd = new Date(now);
            const mStart = dd.getFullYear() + '-' + pad2(dd.getMonth() + 1) + '-01';
            const per = [['Сегодня', st.today, today, today], ['Вчера', st.yesterday, y, y], ['За 7 дней', st.week, dayKey(now - 6 * DAY), today],
                ['С начала месяца', st.thisMonth, mStart, today], ['За 30 дней', st.month, dayKey(now - 29 * DAY), today]];
            const rp = G.panel(cv, t, 648, 44, 928, 468, 'Потрачено'), ry = rp.y + rp.h - G.BOTTOM;
            const cols = [{ label: 'Период', w: 240 }, { label: 'Реальные км', w: 170, align: 'right' }, { label: 'Топливо', w: 170, align: 'right' },
                { label: 'ТО', w: 150, align: 'right' }, { label: 'Всего', w: 174, align: 'right' }];
            const rows = per.map((r) => {
                const k = isNum(r[1]) ? r[1] : null, f = k === null ? null : fuelSpent(L, r[2], r[3]), s = k === null ? null : k * to.total;
                return [r[0], k === null ? '--' : km(k), rub(f), rub(s), { text: k === null ? '--' : rub(f + s), font: 'bold' }];
            });
            const rowH = 44 + Math.max(0, Math.floor(ry / 5));
            G.table(cv, t, 672, 100, 904, cols, rows, { rowH, size: 25 });
            const pay = Costs.RECEIPTS.slice(-1)[0];
            cv.text('Топливо - сколько ушло из бака по его цене. ТО - доля по км: ' + rk(to.total) + ' руб за каждый км', 672, 440 + ry, 20, t.dim);
            if (pay) cv.text('Последний заказ-наряд: ' + group(pay.total) + ' руб, ' + dateOf(new Date(pay.date + 'T12:00:00').getTime())
                + '. Оплачено за 30 дней: ' + rub(Costs.paid(now - 30 * DAY, now)), 672, 470 + ry, 20, t.dim);
        }

        /* ---------- цена топлива: кнопки ---------- */
        const FUEL_PAGE = PAGES.indexOf('Заправки');
        let priceNote = null;
        function priceStep(delta) {
            if (page !== FUEL_PAGE) return go(FUEL_PAGE);
            const now = Date.now();
            if (demoOn()) { priceNote = { until: now + 6000, text: 'Демо-режим: цена не сохраняется' }; return render(); }
            // цена - для бака, который сейчас в машине: с последней заправки (или с начала учёта)
            const from = lb.fill ? lb.fill.t : now, p = pr.set(from, pr.at(from) + delta);
            fuelNote = null;
            priceNote = { until: now + 8000, text: rubl(p) + ' руб/л ' + (lb.fill && !lb.fill.partial ? 'с заправки ' + dateOf(from) : 'с начала учёта') + ', всё пересчитано' };
            save();
            return render();
        }

        /* ---------- ТО ---------- */
        let sel = 0, note = null;              // выбранный пункт; подсказка после нажатия { text, until }
        const svcItems = () => sv.items({ engine: settings.get('engine') || 'diesel', oilKm: Number(settings.get('oilKm')) || 10000 });
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
                    st.last ? (st.last.est ? '≈' : '') + km(st.last.km + off) + ' км, ' + dateOf(st.last.t) + (st.last.rcpt ? ' (наряд)' : '') : { text: conf ? 'нажмите ещё раз' : 'не отмечено', color: conf ? 'warn' : 'dim' },
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
                ratio: rd.ratio(), ratioOk: rd.counted >= 50 ? rd.ratio() : null, tank: car.tank, range: car.range, speed: car.speed, trip: rd.trip, bc: car.bc };
            const L = demo ? demoLb : lb;
            [drawNow, drawWeek, drawStyle, drawDays, drawFuel, drawCosts, drawService][page](cv, t, d, L, now, demo);
            const late = demo ? 0 : overdue();
            G.frame(cv, t, PAGES, page, [demo && { text: 'DEMO' }, late && { text: 'ТО: ' + late, color: 'crit' }]);
            await ui.image('MAIN_GFX', cv);
        }

        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_PAGE', () => go(page + 1));
        ui.onClick('BTN_ITEM', nextItem);
        ui.onClick('BTN_DONE', pressDone);
        ui.onClick('BTN_PRICE_UP', () => priceStep(1));
        ui.onClick('BTN_PRICE_DN', () => priceStep(-1));
        ui.onClick('BTN_PRICE_UP_K', () => priceStep(0.1));
        ui.onClick('BTN_PRICE_DN_K', () => priceStep(-0.1));
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
