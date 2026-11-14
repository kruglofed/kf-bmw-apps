'use strict';
/**
 * scan.js - поиск в каталоге SOME/IP головного устройства всего, что связано с наружным
 * динамиком, активным звуком мотора (ASD) и режимом езды (Комфорт / Спорт).
 *
 * Внешний динамик включает усилитель (RAM) по режиму езды. Если головное устройство само умеет
 * этим управлять (настройка «Звук мотора», режим ASD и т.п.), в каталоге будет поле или метод
 * с таким именем - и, главное, с возможностью записи. Тогда следующей версией появится кнопка.
 *
 *   const { path, data, error } = readCatalog();
 *   const found = scan(data);   // [{ iface, field, tag, write }]
 *   summary(found)              // { asd, outside, mode, audio, writable, writableKey }
 */
const fs = require('fs');

const PATHS = [
    '/etc/oap/someip/someip-interfaces.json',
    '/opt/oap/someip/someip-interfaces.json',
    '/etc/someip/someip-interfaces.json',
    '/data/oap/someip/someip-interfaces.json',
];

// порядок задаёт приоритет: первое совпадение решает метку
const TAGS = [
    { tag: 'наружный звук', key: 'outside', re: /exterior.?(sound|speaker|audio|laut)|aussen.?(laut|klang|sound|schall)|external.?(sound|speaker)|outside.?(sound|speaker)|avas|pedestrian|fussgaenger|fussg|acousticvehicle|acoustic.?(warn|protect)|vsp(?![a-z])/i },
    { tag: 'звук мотора / ASD', key: 'asd', re: /activesound|(^|[^a-z])asd|asd(?![a-z])|enginesound|motorsound|motorklang|soundgenerat|soundsymposer|symposer|soundactuat|klangaktor|sounddesign|exhaustsound|auspuffklang|abgasklappe|exhaustflap|exhaustvalve|sportsound|sportklang|motorgeraeusch|enginenoise/i },
    { tag: 'режим езды', key: 'mode', re: /drivingexperience|fahrerlebnis|driveexperience|drivemode|drivingmode|fahrmodus|fahrprogramm|fesmode|(^|[^a-z])fes(?![a-z])|sportmode|comfortmode|sportplus|sportindividual|comfortindividual|modeselect|driveselect|drivelogic/i },
    { tag: 'аудио / усилитель', key: 'audio', re: /amplifier|verstaerker|receiveraudio|audiomodule|soundsetting|klangeinstell|audiosetting|tonesetting|equali[sz]er|surround|loudness|speaker|lautsprecher/i },
];
// мусор: телефон, речь, навигационные подсказки, рингтоны
const SKIP = /ringtone|phone|telefon|speech|voice|sprach|navi.?(prompt|announce)|announcement|beep|chime|gong|tts/i;
const IFACE = /^[a-z][a-z0-9]*(\.[a-z0-9_]+){2,}$/i;
const ISBMW = /bmw|chassis|infotainment|powertrain|infrastructure|vehicle|harman|audio|sound|drivingexcitement/i;
// признаки того, что поле можно записать или что это метод (команда)
const WRITE_KEYS = /^(setter|set|writable|write|hassetter|isWritable)$/i;
const METHOD_PARENT = /^(methods|method|requests|operations|functions)$/i;

function tagOf(name) {
    if (typeof name !== 'string' || SKIP.test(name)) return null;
    for (const t of TAGS) if (t.re.test(name)) return t;
    return null;
}

/** true, если описание поля говорит, что его можно записать (setter) */
function writable(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    for (const k of Object.keys(node)) {
        if (WRITE_KEYS.test(k)) { const v = node[k]; if (v === true || (v && typeof v === 'object') || (typeof v === 'string' && v && v !== 'false')) return true; }
        if (/^flags?$/i.test(k) && typeof node[k] === 'string' && /w/i.test(node[k])) return true;
    }
    return false;
}

function scan(root) {
    const out = [], seen = Object.create(null);
    let budget = 4000000;
    function add(iface, field, t, write) {
        const key = (iface || '?') + '\u0000' + field;
        if (seen[key]) { if (write) seen[key].write = write; return; }
        const m = { iface: iface || '?', field, tag: t.tag, key: t.key, write: write || '' };
        seen[key] = m; out.push(m);
    }
    function walk(node, iface, parentKey) {
        if (budget-- <= 0 || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const v of node) walk(v, iface, parentKey); return; }
        for (const k of Object.keys(node)) {
            const isIface = IFACE.test(k) && ISBMW.test(k);
            const nextIface = isIface ? k : iface;
            const v = node[k];
            const t = tagOf(k);
            if (t) {
                const w = isIface ? '' : METHOD_PARENT.test(parentKey || '') ? 'команда' : writable(v) ? 'запись' : '';
                add(isIface ? k : nextIface, isIface ? '(весь интерфейс)' : k, t, w);
            }
            if (typeof v === 'string') { const vt = tagOf(v); if (vt && v.length < 80) add(nextIface, v, vt, ''); }
            else walk(v, nextIface, k);
        }
    }
    walk(root, null, null);
    const order = TAGS.map((t) => t.tag);
    out.sort((a, b) => (b.write ? 1 : 0) - (a.write ? 1 : 0) || order.indexOf(a.tag) - order.indexOf(b.tag)
        || a.iface.localeCompare(b.iface) || a.field.localeCompare(b.field));
    return out;
}

function summary(found) {
    const s = { asd: 0, outside: 0, mode: 0, audio: 0, writable: 0, writableKey: 0 };
    for (const m of found) {
        s[m.key]++;
        if (m.write) { s.writable++; if (m.key === 'asd' || m.key === 'outside' || m.key === 'mode') s.writableKey++; }
    }
    return s;
}

function readCatalog(paths) {
    const tried = paths || PATHS;
    for (const p of tried) {
        try { return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')), error: null }; } catch (e) { /* дальше */ }
    }
    return { path: null, data: null, error: 'каталог не прочитан (' + tried[0] + ')' };
}

/** текст для файла street-scan.txt */
function report(found, where) {
    const s = summary(found);
    return ['Уличный динамик: поиск в ' + (where || '?'),
        'наружный звук ' + s.outside + ', ASD ' + s.asd + ', режим езды ' + s.mode + ', аудио ' + s.audio + ', с записью/командой ' + s.writable, '']
        .concat(found.map((m) => m.iface + '\t' + m.field + '\t' + m.tag + (m.write ? '\t' + m.write : ''))).join('\n');
}

module.exports = { scan, summary, readCatalog, report, tagOf, writable, PATHS };
