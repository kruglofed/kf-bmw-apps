'use strict';
/**
 * view.js - экраны «Уличного динамика» (1600×520). Только рисование: состояние приходит готовым.
 *
 *   drawMain(cv, t, st)        итог поиска и что делать сейчас
 *   drawList(cv, t, st, page)  таблица найденного, постранично; возвращает число страниц
 *
 * st = { cat: null | { path, error, found, sum } }
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

function verdict(st) {
    const c = st.cat;
    if (!c) return { text: 'Ищу управление динамиком…', color: 'dim' };
    if (c.error && !c.found.length) return { text: 'Каталог сигналов не прочитан', color: 'warn' };
    if (c.sum.writableKey) return { text: 'Есть управление с записью!', color: 'accent' };
    if (c.sum.asd || c.sum.outside) return { text: 'Сигналы звука есть, записи не видно', color: 'warn' };
    return { text: 'Управления звуком с экрана нет', color: 'warn' };
}

function drawMain(cv, t, st) {
    const p1 = G.panel(cv, t, 24, 44, 740, 468, 'Уличный динамик: поиск управления');
    const v = verdict(st);
    cv.text(v.text, 48, 128, 34, t[v.color] || t.text, { font: 'bold' });
    const c = st.cat, s = c ? c.sum : null;
    const rows = [
        ['Наружный звук, динамик', s && s.outside],
        ['Звук мотора (ASD)', s && s.asd],
        ['Режим езды (Комфорт / Спорт)', s && s.mode],
        ['Аудио, усилитель', s && s.audio],
        ['Можно записать или команда', s && s.writable],
    ];
    rows.forEach((r, i) => {
        const y = 190 + i * 48;
        cv.text(r[0], 48, y, 24, t.text);
        cv.text(s ? String(r[1]) : '…', 740, y, 30, i === 4 && s && s.writableKey ? t.accent : t.text, { align: 'right', font: 'num' });
        cv.fillRect(48, y + 22, 692, 1, withAlpha(t.tick, 0.35));
    });
    const where = !c ? '' : c.path === 'демо' ? 'Демо-режим: пример, не данные машины' : c.path ? 'Каталог: ' + c.path : c.error;
    cv.text(where, 48, 452 + G.toMargin(p1.y + p1.h - G.BOTTOM, 0), 18, t.dim);

    G.panel(cv, t, 788, 44, 788, 468, 'Что делать сейчас');
    const L = (txt, y, size, color, bold) => cv.text(txt, 812, y, size || 22, color || t.text, bold ? { font: 'bold' } : undefined);
    if (s && s.writableKey) {
        L('Головное устройство умеет управлять звуком.', 112, 24, t.accent, true);
        L('1. Откройте вкладку «Найдено» (строки с пометкой', 160);
        L('    «запись» или «команда» стоят первыми).', 192);
        L('2. Сфотографируйте экран и пришлите мне.', 232);
        L('3. Следующая версия получит кнопку', 272);
        L('    «Включить уличный динамик» в любом режиме.', 304);
    } else {
        L('Динамиком управляет усилитель RAM по режиму', 112);
        L('езды. Пока нужного поля не видно, работает так:', 144);
        L('Спорт Индивидуальный', 196, 26, t.accent, true);
        L('Подвеска: Комфорт · Рулевое: Комфорт', 234);
        L('Привод: Спорт. Динамик работает, едет мягко', 266);
        L('Или кодирование блока RAM (BimmerCode / E-Sys).', 318, 22, t.dim);
        L('Сфотографируйте вкладку «Найдено» и пришлите:', 372);
        L('по ней решу, можно ли сделать кнопку.', 404);
    }
    L('Приложение только читает. В машину ничего не пишет.', 466, 18, t.dim);
}

function drawList(cv, t, st, page) {
    const p = G.panel(cv, t, 24, 44, 1552, 468, 'Найдено в каталоге головного устройства'), ey = p.y + p.h - G.BOTTOM;
    const c = st.cat;
    if (!c) { cv.text('Читаю каталог…', 48, 150, 28, t.dim); return 1; }
    if (c.error && !c.found.length) {
        cv.text('Каталог не прочитан.', 48, 140, 30, t.warn, { font: 'bold' });
        cv.text(c.error, 48, 182, 22, t.dim);
        cv.text('Сфотографируйте этот экран и пришлите мне: подскажу другой путь.', 48, 222, 22, t.dim);
        return 1;
    }
    cv.text((c.path === 'демо' ? 'Демо-режим · ' : '') + 'Всего ' + c.found.length + ' · сохранено в street-scan.txt', 48, 108, 22, t.dim);
    const rowH = 36, per = Math.max(1, Math.floor((ey + 320) / rowH));
    const total = c.found.length, pages = Math.max(1, Math.ceil(total / per));
    const pg = ((page % pages) + pages) % pages, from = pg * per;
    const cols = [{ label: 'Интерфейс', w: 620 }, { label: 'Поле / сигнал', w: 520 }, { label: 'Что это', w: 250 }, { label: 'Доступ', w: 114 }];
    const rows = c.found.slice(from, from + per).map((m) => {
        const hot = !!m.write && m.key !== 'audio';
        return [
            { text: m.iface, color: hot ? 'accent' : null, font: hot ? 'bold' : null },
            { text: m.field, font: hot ? 'bold' : null },
            { text: m.tag, color: 'dim' },
            { text: m.write || 'чтение', color: m.write ? 'accent' : 'dim' }];
    });
    G.table(cv, t, 48, 130, 1504, cols, rows, { rowH, size: 22, empty: 'Ничего про звук и режим езды не нашлось' });
    cv.text((pages > 1 ? 'Стр. ' + (pg + 1) + '/' + pages + ' — кнопкой «Следующая страница». ' : '') + 'Сфотографируйте экран и пришлите мне.',
        48, 500 + G.toMargin(ey, 0), 20, t.dim);
    return pages;
}

function ctlPanel(cv, t, x, w, c, show) {
    G.panel(cv, t, x, 44, w, 400, c.label);
    const L = (txt, y, size, color, bold) => cv.text(txt, x + 24, y, size || 21, color || t.text, bold ? { font: 'bold' } : undefined);
    cv.text(c.iface.split('.').slice(-1)[0] + ' . ' + c.field, x + 24, 106, 18, t.dim, { literal: true });
    if (c.error) L('Нет связи: ' + String(c.error).slice(0, 60), 262, 20, t.warn);
    L('Сейчас:', 150, 22, t.dim);
    cv.text(c.value === undefined ? 'нет данных' : show(c.value, c.enums), x + w - 24, 150, 30, c.value === undefined ? t.dim : t.accent, { align: 'right', font: 'bold' });
    L('Было при запуске: ' + (c.first === undefined ? '-' : show(c.first, c.enums)), 194, 20, t.dim);
    const en = c.enums && c.enums.length ? c.enums.map((e) => e.value + ' ' + e.name).join(', ') : 'в каталоге не указаны';
    L('Варианты: ' + (en.length > 62 ? en.slice(0, 62) + '…' : en), 228, 20, t.dim);
    if (en.length > 62) L(en.slice(62, 124), 256, 20, t.dim);
    L(c.msg || 'Нажмите кнопку «' + c.button + '» в меню снизу.', 300, 21, c.msgColor ? t[c.msgColor] : t.text);
    const lines = [];
    if (c.raw) lines.push('Структура: ' + c.raw);
    if (c.inst) lines.push('Экземпляры в каталоге: ' + (c.inst.instances.length ? c.inst.instances.join(', ') : 'не указаны') + ' · ' + c.inst.extra);
    (c.probe || []).forEach((r) => lines.push('Установщик, экз. "' + r.inst + '": ' + r.msg));
    if (!lines.length && c.where) lines.push('В каталоге: ' + c.where);
    const out = [];
    lines.forEach((l) => { for (let i = 0; i < l.length && out.length < 6; i += 82) out.push(l.slice(i, i + 82)); });
    out.slice(0, 6).forEach((l, i) => cv.text(l, x + 24, 328 + i * 19, 15, t.dim, { literal: true }));
}

/** страница «Звук»: две настройки с записью и кнопки */
function drawControl(cv, t, st, show) {
    ctlPanel(cv, t, 24, 764, st.ctl.asd, show);
    ctlPanel(cv, t, 812, 764, st.ctl.eng, show);
    const ctl = st.ctl.check ? 'Проверка установщика на обычном сигнале (обороты): ' + st.ctl.check : 'Проверяю установщик…';
    cv.text(ctl, 48, 474, 20, /ок/.test(ctl) ? t.text : t.warn, { literal: true });
    cv.text('Что-то не так: «Вернуть как было». Пишется только настройка головного устройства, как из обычного меню.', 48, 504, 18, t.dim);
}

module.exports = { drawMain, drawList, drawControl, verdict };
