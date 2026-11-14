'use strict';
/**
 * Уличный динамик - BMW G05 (iDrive 7, MGU).
 *
 * Наружный динамик активного звука (ASD) включает усилитель RAM, штатно только в режиме Спорт.
 * В каталоге G05 нашлись две настройки головного устройства с записью:
 *   VSGSwitch.personalizationASD                                  - включение ASD (персонализация)
 *   EngineSoundConfiguration.operationIndividualizationEngineSound - звук мотора в Индивидуальном режиме
 *
 * Страницы:
 *   Звук      обе настройки: текущее значение, варианты из каталога, кнопки «переключить» и «вернуть»
 *   Итог      итог поиска по каталогу
 *   Найдено   таблица найденного (интерфейс, поле, что это, доступ)
 *
 * Пишет только эти две настройки головного устройства (как обычное меню iDrive) и только по кнопке.
 * Первое прочитанное значение запоминается: «Вернуть как было» записывает его обратно.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { scan, summary, readCatalog, report } = require('./scan');
const C = require('./ctl');
const P = require('./probe');
const V = require('./view');

const W = 1600, H = 520;
const PAGES = ['Звук', 'Итог', 'Найдено'];
// true - только вместе с интерфейсами в app.json "signals" (с ними 0.2.0/0.2.1 не ставились)
const CONNECT = false;

const DEMO_DB = { interfaces: {
    'de.bmw.infotainment.vehicle.VSGSwitch': { fields: { personalizationASD: { getter: true, setter: true } } },
    'de.bmw.powertrain.enginesound.EngineSoundConfiguration': { fields: { operationIndividualizationEngineSound: { getter: true, setter: true } } },
    'de.bmw.infotainment.drivingexcitement.FES': { fields: { statusDrivingExperience: { getter: true } } },
} };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let page = 0, listPage = 0, listPages = 1;
        const demoOn = () => settings.get('demo') === 'on';

        const st = {
            cat: null,
            ctl: {
                asd: { label: 'Звук мотора (ASD): вкл / выкл', button: 'ASD: переключить', iface: 'de.bmw.infotainment.vehicle.VSGSwitch', field: 'personalizationASD' },
                eng: { label: 'Звук мотора в режиме Индивидуальный', button: 'Звук мотора: следующий', iface: 'de.bmw.powertrain.enginesound.EngineSoundConfiguration', field: 'operationIndividualizationEngineSound' },
            },
        };
        const CTL = [st.ctl.asd, st.ctl.eng];

        /* ---------- каталог: поиск и описание двух настроек ---------- */
        function runScan() {
            let data = null, where = null, error = null;
            if (demoOn()) { data = DEMO_DB; where = 'демо'; }
            else {
                try { const r = readCatalog(); data = r.data; where = r.path; error = r.error; } catch (e) { error = String(e); }
            }
            const found = data ? scan(data) : [];
            st.cat = { path: where, error, found, sum: summary(found) };
            if (!demoOn()) {
                log.info('street scan: ' + found.length + ' matches (' + (where || error) + ')');
                try { fs.writeFileSync(path.join(ctx.dataDir, 'street-scan.txt'), report(found, where || error)); } catch (e) { /* не страшно */ }
            }
            if (data) {
                const lines = [];
                CTL.forEach((c) => {
                    try { const d = C.describe(data, c.field); c.enums = d.enums; c.where = (d.paths || []).join(' | ') || 'не найдено'; c.typesText = d.typesText; lines.push(c.field + ': ' + d.text); log.info('describe ' + c.field + ': ' + d.text); }
                    catch (e) { log.warn('describe ' + c.field + ': ' + e); }
                });
                if (!demoOn()) {
                    // почему установщик не подключает эти интерфейсы: тот же генератор, что у MainApp
                    try {
                        const chk = P.probe(data, 'de.bmw.infotainment.vehicle.CDS', 'statusEngineSpeed2', ['1'])[0];
                        st.ctl.check = chk.ok ? 'ок' : 'ошибка: ' + chk.msg;
                        lines.push('check CDS: ' + JSON.stringify(chk));
                        CTL.forEach((c) => {
                            c.inst = P.info(data, c.iface);
                                                        // 0.2.3: «Requested read … but no getter available» - поле только на запись.
                            // Проверяем запись (w) и подписку (s) по отдельности на экземплярах 1 и *
                            c.probe = P.probe(data, c.iface, c.field, ['1', '*'], 'w').concat(P.probe(data, c.iface, c.field, ['1'], 's'));
                            c.def = C.fieldDef(data, c.iface, c.field);
                            lines.push(c.iface + ' info: ' + JSON.stringify(c.inst) + '\nprobe: ' + JSON.stringify(c.probe));
                            log.info('probe ' + c.iface + ': ' + JSON.stringify(c.probe));
                        });
                    } catch (e) { st.ctl.check = 'ошибка: ' + e; log.warn('probe: ' + e); }
                    try { fs.writeFileSync(path.join(ctx.dataDir, 'street-types.txt'), lines.join('\n\n')); } catch (e) { /* не страшно */ }
                }
            }
        }
        setImmediate(runScan);
        let lastDemo = demoOn();

        /* ---------- живые значения ---------- */
        function got(c, v) {
            c.value = v; c.at = Date.now();
            if (c.first === undefined) { c.first = v; log.info('first ' + c.field + ' = ' + JSON.stringify(v)); }
            try { c.raw = JSON.stringify(v); } catch (e) { c.raw = String(v); }
        }
        // 0.2.0/0.2.1 с этими интерфейсами в app.json не ставились (generateSomeipInterfaces): пока
        // они не объявлены, связи нет - страница показывает, где поля лежат в каталоге
        CTL.forEach((c) => {
            if (!CONNECT) { c.error = 'не подключено в этой версии'; return; }
            ctx.signals.watch(c.iface, '1', { [c.field]: (v) => got(c, v) }, log, { pollMs: 3000 })
                .then((s) => { c.sub = s; if (s && s.error) c.error = s.error; })
                .catch((e) => { c.error = String(e); log.warn(c.iface + ': ' + e); });
        });

        async function reread(c) {
            const p = c.sub && c.sub.proxy;
            if (!p || !p.getValue) return;
            try { got(c, await p.getValue(c.field, 3000)); } catch (e) { /* придёт подпиской */ }
        }

        async function write(c, v, what) {
            const p = c.sub && c.sub.proxy;
            if (!p) { c.msg = 'Нет связи с ' + c.iface.split('.').pop() + ', записать нельзя'; c.msgColor = 'warn'; return render(); }
            c.msg = what + '…'; c.msgColor = null; render();
            try {
                await ctx.signals.set(p, c.field, v, 5000);
                log.info('set ' + c.field + ' = ' + JSON.stringify(v) + ' ok');
                c.msg = what + ': машина приняла'; c.msgColor = 'accent';
            } catch (e) {
                log.warn('set ' + c.field + ' = ' + JSON.stringify(v) + ': ' + e);
                c.msg = 'Машина не приняла: ' + String(e).slice(0, 50); c.msgColor = 'warn';
            }
            setTimeout(() => reread(c).then(render), 600);
            return render();
        }

        function step(c) {
            if (demoOn()) { const l = C.leaf(c.value === undefined ? { value: 0 } : c.value); got(c, C.withLeaf(c.value === undefined ? { value: 0 } : c.value, l.path, C.next(l.value, c.enums))); c.msg = 'Демо: значение переключено'; return render(); }
            if (c.value === undefined) { c.msg = 'Машина ещё не прислала значение, пробовать нечего'; c.msgColor = 'warn'; return render(); }
            const l = C.leaf(c.value);
            const nx = l ? C.next(l.value, c.enums) : undefined;
            if (nx === undefined) { c.msg = 'Непонятный тип значения, пришлите фото экрана'; c.msgColor = 'warn'; return render(); }
            return write(c, C.withLeaf(c.value, l.path, nx), C.show(c.value, c.enums) + ' на ' + String(nx));
        }

        async function restore() {
            for (const c of CTL) {
                if (c.first === undefined || JSON.stringify(c.first) === JSON.stringify(c.value)) { c.msg = 'Уже как было'; c.msgColor = null; continue; }
                if (demoOn()) { got(c, c.first); c.msg = 'Демо: вернул'; continue; }
                await write(c, c.first, 'Возвращаю ' + C.show(c.first, c.enums));
            }
            return render();
        }

        /* ---------- кадр ---------- */
        async function render() {
            if (demoOn() !== lastDemo) { lastDemo = demoOn(); runScan(); }
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) V.drawControl(cv, t, st, C.show);
            else if (page === 1) V.drawMain(cv, t, st);
            else listPages = V.drawList(cv, t, st, listPage);
            G.frame(cv, t, PAGES, page, [demoOn() && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }

        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_ASD', () => { page = 0; return step(st.ctl.asd); });
        ui.onClick('BTN_ENG', () => { page = 0; return step(st.ctl.eng); });
        ui.onClick('BTN_RESTORE', () => { page = 0; return restore(); });
        ui.onClick('BTN_PAGE', () => {
            if (page === 2 && listPage + 1 < listPages) { listPage++; return render(); }
            listPage = 0; return go(page + 1);
        });
        ui.onClick('BTN_PREV', () => { if (page === 2 && listPage > 0) { listPage--; return render(); } return go(page - 1); });
        ctx.onTab((i) => { listPage = 0; return go(i); });
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('street: first frame')).catch((e) => log.warn('first render: ' + e));
    },
});
