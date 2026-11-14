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
 *   Звук      обе настройки: варианты из каталога, что записано, ответ машины; кнопки
 *             «следующее значение» и «Сбросить запрос»
 *   Итог      итог поиска по каталогу
 *   Найдено   таблица найденного (интерфейс, поле, что это, доступ)
 *
 * Оба поля только на запись (getter/notifier нет - установщик падал на флагах r/s), поэтому
 * текущее значение не известно: кнопка перебирает варианты перечисления из каталога, а
 * «Сбросить запрос» пишет значение по умолчанию (15 - «нет запроса»).
 * Пишет только эти две настройки и только по кнопке.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { scan, summary, readCatalog, report } = require('./scan');
const C = require('./ctl');
const V = require('./view');

const W = 1600, H = 520;
const PAGES = ['Звук', 'Итог', 'Найдено'];

const DEMO_DB = { interfaces: {
    'de.bmw.infotainment.vehicle.VSGSwitch': { fields: { personalizationASD: { dataRef: 'x.VehicleTypes.OperationPersonalizationASDWrapper', setter: { id: 2 } } } },
    'de.bmw.powertrain.enginesound.EngineSoundConfiguration': { fields: { operationIndividualizationEngineSound: { dataRef: 'x.EngineSoundTypes.OperationIndividualizationEngineSoundWrapper', setter: { id: 1 } } } },
    'de.bmw.infotainment.drivingexcitement.FES': { fields: { statusDrivingExperience: { getter: true } } },
}, types: [
    { name: 'OperationPersonalizationASDWrapper', type: 'struct', members: [{ dataRef: 'x.PersonalisationASD', defaultValue: 15, name: 'personalisationRequestASD' }] },
    { name: 'PersonalisationASD', type: 'enumeration', enumerators: [{ name: 'OFF', value: 0 }, { name: 'ON', value: 1 }, { name: 'SIGNAL_INVALID', value: 15 }] },
    { name: 'OperationIndividualizationEngineSoundWrapper', type: 'struct', members: [
        { dataRef: 'x.OperationAdjustProminenceEngineSoundVehicle', defaultValue: 15, name: 'operationAdjustProminenceEngineSoundVehicleStartup' },
        { dataRef: 'x.OperationAdjustProminenceEngineSoundVehicle', defaultValue: 15, name: 'operationAdjustProminenceEngineSoundVehicle' }] },
    { name: 'OperationAdjustProminenceEngineSoundVehicle', type: 'enumeration', enumerators: [{ name: 'LOW', value: 1 }, { name: 'MEDIUM', value: 2 }, { name: 'HIGH', value: 3 }, { name: 'NO_REQUEST', value: 15 }] },
] };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let page = 0, listPage = 0, listPages = 1;
        const demoOn = () => settings.get('demo') === 'on';

        const st = {
            cat: null,
            ctl: {
                asd: { label: 'Звук мотора (ASD): вкл / выкл', button: 'ASD: следующее значение', iface: 'de.bmw.infotainment.vehicle.VSGSwitch', field: 'personalizationASD' },
                eng: { label: 'Звук мотора в режиме Индивидуальный', button: 'Звук мотора: следующее', iface: 'de.bmw.powertrain.enginesound.EngineSoundConfiguration', field: 'operationIndividualizationEngineSound' },
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
                CTL.forEach((c) => {
                    const n = data.interfaces && data.interfaces[c.iface];
                    const f = n && n.fields && n.fields[c.field];
                    c.def = C.fieldDef(data, c.iface, c.field);
                    c.rt = C.resolveType(data, f && f.dataRef || c.field);
                    c.opts = C.options(c.rt);
                    lines.push(c.field + ' type: ' + JSON.stringify(c.rt));
                    log.info('type ' + c.field + ': ' + JSON.stringify({ kind: c.rt.kind, members: c.rt.members.map((m) => [m.name, m.def, m.enums]) }));
                });
                CTL.forEach(connect);
                if (!demoOn()) {
                    try { fs.writeFileSync(path.join(ctx.dataDir, 'street-types.txt'), lines.join('\n\n')); } catch (e) { /* не страшно */ }
                }
            }
        }
        setImmediate(runScan);
        let lastDemo = demoOn();

        /* ---------- запись (поля только на запись: прочитать текущее значение машина не даёт) ---------- */
        // proxy строится после разбора каталога: нужен тип значения
        async function connect(c) {
            if (demoOn()) return;
            try {
                c.p = await ctx.signals.proxy(c.iface, '1'); c.error = null; log.info('proxy ' + c.iface + ' ok');
                ctx.signals.onAvailable(c.p, (a) => { c.avail = a; log.info('available ' + c.iface + ': ' + a); render(); }).catch(() => {});
            }
            catch (e) { c.error = String(e); log.warn('proxy ' + c.iface + ': ' + e); }
            render();
        }

        async function write(c, v, what) {
            if (demoOn()) { c.msg = 'Демо: ' + what; c.msgColor = 'accent'; return render(); }
            if (!c.p) { c.msg = 'Нет связи с ' + c.iface.split('.').pop() + (c.error ? ': ' + String(c.error).slice(0, 40) : ''); c.msgColor = 'warn'; return render(); }
            c.msg = what + '…'; c.msgColor = null; render();
            try {
                try { await ctx.signals.set(c.p, c.field, v, 5000); }
                catch (e) {
                    // на случай, если привязка всё же хочет число
                    if (!/not a number/i.test(String(e)) || !c.lastOpt) throw e;
                    v = C.buildValue(c.rt, c.lastOpt, true);
                    await ctx.signals.set(c.p, c.field, v, 5000);
                }
                log.info('set ' + c.field + ' = ' + JSON.stringify(v) + ' ok');
                c.msg = what + ': машина приняла'; c.msgColor = 'accent';
            } catch (e) {
                log.warn('set ' + c.field + ' = ' + JSON.stringify(v) + ': ' + e);
                c.msg = 'Машина не приняла: ' + String(e).slice(0, 60); c.msgColor = 'warn';
            }
            return render();
        }

        function step(c) {
            const opts = c.opts || [];
            if (!opts.length) { c.msg = 'Варианты значений не найдены в каталоге, пришлите фото экрана'; c.msgColor = 'warn'; return render(); }
            c.idx = ((c.idx === undefined ? -1 : c.idx) + 1) % opts.length;
            const o = opts[c.idx];
            c.written = o; c.lastOpt = o;
            return write(c, C.buildValue(c.rt, o), 'Записываю «' + C.ru(o.name) + '» (' + o.name + ')');
        }

        async function reset() {
            for (const c of CTL) {
                if (!c.rt) continue;
                const n = C.neutral(c.rt);
                if (!n) { c.msg = 'Нет значения «без изменений» в каталоге'; continue; }
                c.written = n; c.lastOpt = n; c.idx = -1;
                await write(c, C.buildValue(c.rt, n), 'Сброс: ' + n.name);
            }
            return render();
        }

        /* ---------- кадр ---------- */
        async function render() {
            if (demoOn() !== lastDemo) { lastDemo = demoOn(); runScan(); }
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) V.drawControl(cv, t, st);
            else if (page === 1) V.drawMain(cv, t, st);
            else listPages = V.drawList(cv, t, st, listPage);
            G.frame(cv, t, PAGES, page, [demoOn() && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }

        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_ASD', () => { page = 0; return step(st.ctl.asd); });
        ui.onClick('BTN_ENG', () => { page = 0; return step(st.ctl.eng); });
        ui.onClick('BTN_RESTORE', () => { page = 0; return reset(); });
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
