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
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { Needle, OdoRoll, isNum } = require('./needles');
const { PANELS } = require('./panels');

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
        function open(i) {
            idx = (i + PANELS.length) % PANELS.length;
            const p = PANELS[idx];
            needles = {};
            Object.keys(p.needles).forEach((k) => { needles[k] = new Needle(p.needles[k]); if (p.sweep) needles[k].sweep(1500); });
            if (settings.get('panel') !== p.id) { try { settings.set('panel', p.id); } catch (e) { log.warn('save panel: ' + e); } }
            log.info('retro: panel ' + p.id);
        }
        open(idx);

        let last = 0;
        async function render() {
            const now = Date.now(), dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
            last = now;
            const p = PANELS[idx], d = data(dt), k = JITTER[settings.get('jitter')] === undefined ? 1 : JITTER[settings.get('jitter')];
            const x = {};
            Object.keys(p.needles).forEach((key) => {
                const s = p.needles[key], v = d[s.src];
                x[key] = needles[key].update(isNum(v) ? v * (s.scale || 1) : null, dt, Math.random, k);
            });
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear('#000000');
            cv.blit(G.layer('retro|' + p.id, W, H, (c) => p.back(c), cv.textScale), 0, 0);
            p.live(cv, d, x);
            G.frame(cv, t, PANELS.map((q) => q.title), idx, [d.demo && { text: 'DEMO' }]);
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
