'use strict';
/**
 * catalog.js - поиск сигналов рулёжки и осей в каталоге SOME/IP головного устройства.
 *
 * Головное устройство держит полный список интерфейсов и полей в
 * /etc/oap/someip/someip-interfaces.json. Приложение подписаться может только на то, что объявлено в
 * его app.json, но ПРОЧИТАТЬ этот файл - может целиком. Так мы находим точные имена сигналов (в том
 * числе угла задней оси, если он вообще приходит на экран), чтобы потом вписать их в приложение.
 *
 *   const { path, error } = readCatalog();      // пробует несколько путей
 *   const matches = scan(json);                 // [{ iface, field, tag }] про рулёжку/оси
 */
const fs = require('fs');

const PATHS = [
    '/etc/oap/someip/someip-interfaces.json',
    '/opt/oap/someip/someip-interfaces.json',
    '/etc/someip/someip-interfaces.json',
    '/data/oap/someip/someip-interfaces.json',
];

// что ищем и как помечаем; порядок задаёт приоритет сортировки
const TAGS = [
    { tag: 'задняя ось', re: /(rear|hinter|hinten).*(axle|achse|steer|lenk|winkel|angle|wheel|rad)|(axle|achse).*(rear|hinter)|hinterachslenk|rearaxlesteer|rearwheelsteer|integrallenk|hsr/i },
    { tag: 'ось', re: /(axle|achse)(?!erator)/i },
    { tag: 'руль/поворот', re: /steer|lenk(?!rad_heiz)|lenkwinkel|steeringangle/i },
    { tag: 'угол', re: /winkel|angle/i },
    { tag: 'рыскание/крен', re: /yaw|gier|wank|roll|nick|pitch/i },
    { tag: 'колесо', re: /radwinkel|wheelangle|wheelsteer/i },
];
// мусор: педали, дроссель, прицеп, геометрия
const SKIP = /pedal|fahrped|drossel|throttle|accelerat|gaspedal|trailer|anhaeng|rectangle|triangle|angular(?!velocity)/i;
// похоже на имя интерфейса: de.bmw.chassis.SteeringAngle и т.п.
const IFACE = /^[a-z][a-z0-9]*(\.[a-z0-9_]+){2,}$/i;
const ISBMW = /bmw|chassis|infotainment|powertrain|infrastructure|vehicle/i;

function tagOf(name) {
    if (SKIP.test(name)) return null;
    for (const t of TAGS) if (t.re.test(name)) return t.tag;
    return null;
}

/** глубокий обход каталога: собирает поля, чьё имя похоже на рулёжку/оси, с ближайшим интерфейсом */
function scan(root) {
    const out = [], seen = Object.create(null);
    let budget = 4000000;
    function add(iface, field, tag) {
        const key = (iface || '?') + '\u0000' + field;
        if (seen[key]) return;
        seen[key] = 1;
        out.push({ iface: iface || '?', field, tag });
    }
    function walk(node, iface) {
        if (budget-- <= 0 || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const v of node) walk(v, iface); return; }
        for (const k of Object.keys(node)) {
            const isIface = IFACE.test(k) && ISBMW.test(k);
            const nextIface = isIface ? k : iface;
            const tag = tagOf(k);
            if (tag) add(isIface ? k : nextIface, isIface ? '(весь интерфейс)' : k, tag);
            const v = node[k];
            if (typeof v === 'string') { const vt = tagOf(v); if (vt && v.length < 80) add(nextIface, v, vt); }
            else walk(v, nextIface);
        }
    }
    walk(root, null);
    const order = TAGS.map((t) => t.tag);
    out.sort((a, b) => order.indexOf(a.tag) - order.indexOf(b.tag) || a.iface.localeCompare(b.iface) || a.field.localeCompare(b.field));
    return out;
}

function readCatalog(paths) {
    const tried = paths || PATHS;
    for (const p of tried) {
        try {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            return { path: p, data, error: null };
        } catch (e) { /* next */ }
    }
    return { path: null, data: null, error: 'каталог не прочитан (' + tried[0] + ')' };
}

module.exports = { scan, readCatalog, tagOf, PATHS };
