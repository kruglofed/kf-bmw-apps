'use strict';
/**
 * scan.js - поиск в каталоге SOME/IP всего, что машина «видит» вокруг себя: модель окружения
 * (объекты: машины, пешеходы, велосипеды), ассистенты (DASS), парктроник (PDC), разметка.
 * Для каждого поля - есть ли чтение (getter) и подписка (notifier): только такие поля приложение
 * сможет показывать вживую.
 *
 *   const found = scan(db)   // [{ iface, field, ref, r, s, tag }]
 */
const fs = require('fs');

const PATHS = ['/etc/oap/someip/someip-interfaces.json', '/opt/oap/someip/someip-interfaces.json'];

const TAGS = [
    { tag: 'объекты вокруг', re: /environmentalmodel|objectlist|trafficparticipant|surroundingobject|fusionobject|objectfusion/i },
    { tag: 'ассистенты', re: /\.dass\.|dass\b|dasstypes|acc\b|lanekeep|laneassist|adas|drivingassist/i },
    { tag: 'парктроник', re: /pdc|parkdistance|parkingassist|parkassist|ultrasonic|parkdistancecontrol|topview|surroundview|panorama/i },
    { tag: 'разметка / дорога', re: /lane(?!guidance)|roadmodel|roadgeometry|trafficsign|speedlimitinfo/i },
];
const tagOf = (s) => { for (const t of TAGS) if (t.re.test(s)) return t.tag; return null; };

function scan(db) {
    const ifs = (db && db.interfaces) || {};
    const out = [];
    Object.keys(ifs).forEach((iface) => {
        const n = ifs[iface] || {};
        const fields = n.fields || {};
        const itag = tagOf(iface);
        Object.keys(fields).forEach((f) => {
            const tag = itag || tagOf(f);
            if (!tag) return;
            const d = fields[f] || {};
            out.push({ iface, field: f, ref: String(d.dataRef || '').split('.').pop(), r: !!d.getter, s: !!d.notifier, w: !!d.setter, tag });
        });
        Object.keys(n.events || n.broadcasts || {}).forEach((e) => {
            const tag = itag || tagOf(e);
            if (tag) out.push({ iface, field: e, ref: 'событие', r: false, s: true, w: false, tag, event: true });
        });
    });
    const order = TAGS.map((t) => t.tag);
    out.sort((a, b) => (b.s - a.s) || (b.r - a.r) || order.indexOf(a.tag) - order.indexOf(b.tag) || a.iface.localeCompare(b.iface) || a.field.localeCompare(b.field));
    return out;
}

function summary(found) {
    const s = { total: found.length, live: 0, read: 0, ifaces: 0, byTag: {} };
    const ifs = new Set();
    found.forEach((m) => { if (m.s) s.live++; if (m.r) s.read++; ifs.add(m.iface); s.byTag[m.tag] = (s.byTag[m.tag] || 0) + (m.s ? 1 : 0); });
    s.ifaces = ifs.size;
    return s;
}

function readCatalog() {
    for (const p of PATHS) { try { return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch (e) { /* дальше */ } }
    return { path: null, data: null, error: 'каталог не прочитан (' + PATHS[0] + ')' };
}

function report(found) {
    return found.map((m) => [m.iface, m.field, m.ref, (m.r ? 'r' : '-') + (m.s ? 's' : '-') + (m.w ? 'w' : '-'), m.tag].join('\t')).join('\n');
}

module.exports = { scan, summary, readCatalog, report, tagOf };
