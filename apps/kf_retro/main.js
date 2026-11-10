'use strict';
/**
 * Ретро-приборы - приборные панели в духе старых машин на экране MGU (iDrive 7).
 *
 * Семь панелей, переключаются вкладками сверху, кнопками «Следующая / Предыдущая панель» или в
 * настройках (выбранная запоминается): Москвич (ленточный спидометр, без тахометра), Жигули
 * (дёрганый тахометр), УАЗ (железная панель, гуляющая стрелка спидометра), Волга (светлые
 * циферблаты и часы), Девятка (оранжевая подсветка, столбики), BMW E39 и BMW F30 (прогон стрелок
 * при открытии).
 *
 * Показания настоящие: скорость, обороты, температура воды и масла, топливо в баке, одометр,
 * передача, запас хода. Повадки стрелок (инерция, дрожание, тросик) - needles.js; дрожание
 * настраивается. Приложение только читает данные машины.
 *
 * На приборную панель (12,3" за рулём) выбранная панель выводится через сервис cluster-render
 * (cluster.js), если он установлен из Store: поверх штатных стрелок, под контрольными лампами BMW.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { Needle, OdoRoll, isNum } = require('./needles');
const { PANELS } = require('./panels');
const { ClusterOut } = require('./cluster');

const W = 1600, H = 520;
const KOMBI = 'de.bmw.infotainment.KombiIF';
const JITTER = { off: 0, real: 1, strong: 2 };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;

        /* ---------- данные ---------- */
        const tank = { litres: null, range: null, odo: null };
        const raw = (v, m, bad) => { let x = v && v[m]; if (typeof x === 'string' && /^\d+$/.test(x)) x = Number(x); return isNum(x) && x !== bad ? x : null; };
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'gear'], {
            [KOMBI]: {
                statusRangeTankStatus: (v) => {
                    const l = raw(v, 'fluidLevelFuelTank', 255), r = raw(v, 'range', 4095), o = raw(v, 'mileageKilometre', 16777215);
                    if (l !== null) tank.litres = l;
                    if (r !== null) tank.range = r;
                    if (o !== null && o > 0) tank.odo = o;
                },
            },
        });
        car.setRedline(4800);        // демо - как дизель 30d

        const odo = new OdoRoll();
        let demoKm = 123456.0;
        const tankSize = () => Number(settings.get('tankSize')) || 80;
        function clock() {
            const off = Number(settings.get('tz'));
            const t = new Date(Date.now() + (isNum(off) ? off : 3) * 3600000);
            return { h: t.getUTCHours(), m: t.getUTCMinutes(), s: t.getUTCSeconds() };
        }
        function data(dt) {
            const c = car.data(), demo = !!c.demo;
            if (demo) demoKm += (c.speed || 0) / 3600 * dt;
            const litres = demo ? 52 : tank.litres;
            const d = {
                demo, speed: isNum(c.speed) ? c.speed : null, rpm: isNum(c.rpm) ? c.rpm : null,
                coolant: isNum(c.coolant) ? c.coolant : null, oil: isNum(c.oil) ? c.oil : null,
                fuelL: litres, fuel: isNum(litres) ? Math.max(0, Math.min(1.05, litres / tankSize())) : null,
                range: demo ? 610 : tank.range, gear: c.gear, stage: c.stage, time: clock(),
            };
            d.odo = odo.update(demo ? Math.floor(demoKm) : tank.odo, d.speed, dt);
            d.reserve = isNum(litres) && litres < 10;
            d.hot = isNum(d.coolant) && d.coolant >= 112;
            return d;
        }

        /* ---------- панели ---------- */
        const ids = PANELS.map((p) => p.id);
        let idx = Math.max(0, ids.indexOf(settings.get('panel')));
        let needles = {};
        let last = 0, frameD = null, frameX = {};
        function open(i) {
            idx = (i + PANELS.length) % PANELS.length;
            const p = PANELS[idx];
            needles = {}; frameD = null;
            Object.keys(p.needles).forEach((k) => { needles[k] = new Needle(p.needles[k]); if (p.sweep) needles[k].sweep(1500); });
            if (settings.get('panel') !== p.id) { try { settings.set('panel', p.id); } catch (e) { log.warn('save panel: ' + e); } }
            log.info('retro: panel ' + p.id);
        }
        open(idx);

        /* один шаг физики стрелок до «сейчас»: его зовут и экран (до 60 раз в секунду), и вывод на
         * приборы (25 раз), стрелки двигаются по реальному времени, сколько бы раз ни звали */
        function step() {
            const now = Date.now(), dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
            if (frameD && dt < 0.004) return;
            last = now;
            const p = PANELS[idx], d = data(dt), k = JITTER[settings.get('jitter')] === undefined ? 1 : JITTER[settings.get('jitter')];
            const x = {};
            Object.keys(p.needles).forEach((key) => {
                const s = p.needles[key], v = d[s.src];
                x[key] = needles[key].update(isNum(v) ? v * (s.scale || 1) : null, dt, Math.random, k);
            });
            frameD = d; frameX = x;
        }

        /* ---------- на приборную панель (cluster-render) ----------
         * Только с живой скоростью от машины: в демо, без сигнала скорости или когда провайдер скорости
         * пропал, картинка с приборов убирается и снова видны приборы BMW. */
        const out = new ClusterOut(log);
        const speedLive = () => car.subs.some((s) => s && s.iface === 'de.bmw.infotainment.vehicle.Vehicle2' && s.available) && isNum(car.live.speed);
        let clusterOk = false;
        setInterval(() => {
            try {
                step();
                const want = settings.get('cluster') !== 'off' && !frameD.demo && speedLive();
                if (want) { out.show(PANELS[idx], frameD, frameX); clusterOk = out.state === 'на приборах'; } else if (out.shown) { out.hide(); clusterOk = false; }
                if (!want && settings.get('cluster') !== 'off') out.available();
            } catch (e) { log.warn('cluster tick: ' + e); }
        }, 40);
        function badges(d) {
            const b = [d.demo && { text: 'DEMO' }];
            if (settings.get('cluster') === 'off') return b;
            if (clusterOk) b.push({ text: 'НА ПРИБОРАХ' });
            else if (out.state === 'нет cluster-render') b.push({ text: 'НЕТ CLUSTER-RENDER', color: 'warn' });
            else if (out.shown) b.push({ text: 'ЖДЁМ ПРИБОРЫ', color: 'warn' });
            return b;
        }

        async function render() {
            step();
            const p = PANELS[idx], d = frameD, x = frameX;
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear('#000000');
            cv.blit(G.layer('retro|' + p.id, W, H, (c) => p.back(c), cv.textScale), 0, 0);
            p.live(cv, d, x);
            G.frame(cv, t, PANELS.map((q) => q.title), idx, badges(d));
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_NEXT', () => { open(idx + 1); return render(); });
        ui.onClick('BTN_PREV', () => { open(idx - 1); return render(); });
        ctx.onTab((i) => { open(i); return render(); });
        if (settings.onChange) settings.onChange((key) => { if (key === 'panel' && ids.indexOf(settings.get('panel')) !== idx) open(Math.max(0, ids.indexOf(settings.get('panel')))); });
        ctx.loop('MAIN', 8, render);
        render().then(() => log.info('retro: first frame')).catch((e) => log.warn('first render: ' + e));
    },
});
