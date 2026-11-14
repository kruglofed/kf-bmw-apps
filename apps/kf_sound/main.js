'use strict';
/**
 * Уличный динамик - BMW G05 (iDrive 7, MGU).
 *
 * Наружный динамик активного звука (ASD) включает усилитель RAM, и только в режиме Спорт.
 * Цель - кнопка «включить в любом режиме». Версия 0.1 - разведка: ищет в каталоге SOME/IP
 * головного устройства (/etc/oap/someip/someip-interfaces.json) всё про наружный звук, ASD,
 * режим езды и усилитель, и отмечает, что из этого можно записать или вызвать командой.
 * По этому списку делается следующая версия с кнопкой.
 *
 * Страницы:
 *   Динамик   итог поиска и что делать сейчас (Спорт Индивидуальный как обходной путь)
 *   Найдено   таблица: интерфейс, поле, что это, доступ (чтение / запись / команда)
 *
 * Приложение только читает файл каталога: ни одного запроса в блоки управления, ничего не пишется в машину.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { scan, summary, readCatalog, report } = require('./scan');
const V = require('./view');

const W = 1600, H = 520;
const PAGES = ['Динамик', 'Найдено'];

const DEMO_DB = { interfaces: {
    'de.bmw.infotainment.drivingexcitement.FES': { fields: { statusDrivingExperience: { getter: true, notifier: true }, statusActualValueTorque2: {} } },
    'de.bmw.infotainment.audio.SoundSettings': { fields: { activeSoundDesignMode: { getter: true, setter: true }, loudness: { setter: true } } },
    'de.bmw.infotainment.vehicle.ExteriorSound': { fields: { statusExteriorSpeaker: { getter: true } } },
} };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let page = 0, listPage = 0, listPages = 1;
        const demoOn = () => settings.get('demo') === 'on';

        const st = { cat: null };
        function runScan() {
            if (demoOn()) {
                const found = scan(DEMO_DB);
                st.cat = { path: 'демо', error: null, found, sum: summary(found) };
                return;
            }
            try {
                const r = readCatalog();
                const found = r.data ? scan(r.data) : [];
                st.cat = { path: r.path, error: r.error, found, sum: summary(found) };
                log.info('street scan: ' + found.length + ' matches (' + (r.path || r.error) + ')');
                found.forEach((m) => log.info('  ' + m.iface + ' . ' + m.field + '  [' + m.tag + ']' + (m.write ? ' ' + m.write : '')));
                try { fs.writeFileSync(path.join(ctx.dataDir, 'street-scan.txt'), report(found, r.path || r.error)); } catch (e) { /* не страшно */ }
            } catch (e) {
                st.cat = { path: null, error: String(e), found: [], sum: summary([]) };
                log.warn('street scan: ' + e);
            }
        }
        setImmediate(runScan);
        let lastDemo = demoOn();

        async function render() {
            if (demoOn() !== lastDemo) { lastDemo = demoOn(); runScan(); }
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) V.drawMain(cv, t, st); else listPages = V.drawList(cv, t, st, listPage);
            G.frame(cv, t, PAGES, page, [demoOn() && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }

        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_PAGE', () => {
            if (page === 1 && listPage + 1 < listPages) { listPage++; return render(); }
            listPage = 0; return go(page + 1);
        });
        ui.onClick('BTN_PREV', () => { if (page === 1 && listPage > 0) { listPage--; return render(); } return go(page - 1); });
        ctx.onTab((i) => { listPage = 0; return go(i); });
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('street: first frame')).catch((e) => log.warn('first render: ' + e));
    },
});
