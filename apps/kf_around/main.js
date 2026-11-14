'use strict';
/**
 * Вокруг машины - BMW G05 (iDrive 7, MGU). Цель - вид сверху, как у Tesla: своя машина в центре,
 * вокруг машины, пешеходы и препятствия, которые видят камеры, радары и парктроник.
 *
 * Версия 0.1 - разведка: в каталоге SOME/IP ищутся интерфейсы модели окружения, ассистентов,
 * парктроника и разметки; для каждого поля показано, можно ли его читать (r) и получать вживую (s).
 * По этому списку следующая версия подпишется на нужные поля и нарисует картинку.
 *
 * Страницы: Итог (сколько нашлось и чего), Найдено (таблица). Ничего не пишет в машину.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { scan, summary, readCatalog, report } = require('./scan');

const W = 1600, H = 520;
const PAGES = ['Итог', 'Найдено'];

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let page = 0, listPage = 0, listPages = 1;
        const st = { found: null, sum: null, path: null, error: null };

        setImmediate(() => {
            try {
                const r = readCatalog();
                st.path = r.path; st.error = r.error;
                st.found = r.data ? scan(r.data) : [];
                st.sum = summary(st.found);
                log.info('around scan: ' + st.found.length + ' fields, live ' + st.sum.live);
                try { fs.writeFileSync(path.join(ctx.dataDir, 'around-scan.txt'), report(st.found)); } catch (e) { /* не страшно */ }
            } catch (e) { st.error = String(e); st.found = []; st.sum = summary([]); }
            render();
        });

        function drawSummary(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Вокруг машины: что машина отдаёт приложениям');
            if (!st.sum) { cv.text('Читаю каталог…', 48, 140, 28, t.dim); return; }
            if (st.error && !st.found.length) { cv.text(st.error, 48, 140, 24, t.warn, { literal: true }); return; }
            const s = st.sum;
            cv.text('Полей найдено: ' + s.total + ' в ' + s.ifaces + ' интерфейсах', 48, 128, 30, t.text, { font: 'bold' });
            cv.text('Можно получать вживую (подписка): ' + s.live + ' · можно читать: ' + s.read, 48, 176, 24, s.live ? t.accent : t.warn);
            let y = 236;
            Object.keys(s.byTag).forEach((k) => { cv.text(k + ': вживую ' + s.byTag[k], 48, y, 24, t.text); y += 40; });
            cv.text('Откройте «Найдено» и сфотографируйте первые страницы: поля с подпиской стоят первыми.', 48, 440, 22, t.dim);
            cv.text('Список сохранён в around-scan.txt. Приложение только читает каталог.', 48, 476, 18, t.dim);
        }

        function drawList(cv, t) {
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'Найдено'), ey = p.y + p.h - G.BOTTOM;
            const f = st.found || [];
            const rowH = 34, per = Math.max(1, Math.floor((ey + 330) / rowH));
            listPages = Math.max(1, Math.ceil(f.length / per));
            const pg = ((listPage % listPages) + listPages) % listPages;
            const cols = [{ label: 'Интерфейс', w: 560 }, { label: 'Поле', w: 440 }, { label: 'Тип', w: 330 }, { label: 'r s', w: 70 }, { label: 'Что', w: 100 }];
            const rows = f.slice(pg * per, pg * per + per).map((m) => [
                { text: m.iface.replace(/^de\.bmw\./, ''), color: m.s ? 'accent' : null },
                { text: m.field, font: m.s ? 'bold' : null },
                { text: m.ref, color: 'dim' },
                { text: (m.r ? 'r' : '·') + ' ' + (m.s ? 's' : '·'), color: m.s ? 'accent' : 'dim' },
                { text: m.tag.split(' ')[0], color: 'dim' }]);
            G.table(cv, t, 48, 110, 1504, cols, rows, { rowH, size: 20, empty: 'Ничего не нашлось' });
            cv.text('Стр. ' + (pg + 1) + '/' + listPages + ' — «Следующая страница». r — читать, s — вживую.', 48, 500 + G.toMargin(ey, 0), 18, t.dim);
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) drawSummary(cv, t); else drawList(cv, t);
            G.frame(cv, t, PAGES, page, []);
            await ui.image('MAIN_GFX', cv);
        }
        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_PAGE', () => { if (page === 1 && listPage + 1 < listPages) { listPage++; return render(); } listPage = 0; return go(page + 1); });
        ui.onClick('BTN_PREV', () => { if (page === 1 && listPage > 0) { listPage--; return render(); } return go(page - 1); });
        ctx.onTab((i) => { listPage = 0; return go(i); });
        ctx.loop('MAIN', 2, render);
        render().catch((e) => log.warn('first render: ' + e));
    },
});
