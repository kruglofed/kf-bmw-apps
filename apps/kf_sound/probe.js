'use strict';
/**
 * probe.js - почему установщик не может подключить интерфейс (0.2.0/0.2.1 падали в
 * generateSomeipInterfaces). Прогоняет тот же генератор BMW, что и MainApp при установке
 * (модули из прошивки, как kit/tools/oapgen/gen.js), но внутри приложения и для одного поля,
 * перебирая экземпляры ("1", "*", и те, что указаны в каталоге). Ничего не устанавливает и не пишет:
 * только вызывает generate() в памяти и возвращает текст ошибки.
 *
 *   info(db, iface)                       { keys, instances, extra }  что ещё есть у интерфейса в каталоге
 *   probe(db, iface, field, instances)    [{ inst, ok, msg }]
 */
const fs = require('fs');

const APPMGMT = process.env.OAP_APPMGMT || '/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js';
let gen = null, genErr = null;

function loadGen() {
    if (gen) return gen;
    if (genErr) throw genErr;
    try {
        const text = fs.readFileSync(APPMGMT, 'utf8');
        const m = /"someip-interfaces-generator\/IFConfigGenerator(?:\.js)?":(\d+)/.exec(text);
        if (!m) throw new Error('IFConfigGenerator не найден в ' + APPMGMT);
        const tail = /,\{\},\[\d+\]\)\s*;?\s*$/;
        if (!tail.test(text)) throw new Error('незнакомый формат AppManagement');
        const req = new Function('require', 'return ' + text.replace(tail, ',{},[])'))(require);
        gen = req(m[1]);
        return gen;
    } catch (e) { genErr = e; throw e; }
}

function ifaceNode(db, iface) {
    if (!db) return null;
    if (db.interfaces && db.interfaces[iface]) return db.interfaces[iface];
    return db[iface] || null;
}

function info(db, iface) {
    const n = ifaceNode(db, iface);
    if (!n || typeof n !== 'object') return { keys: [], instances: [], extra: 'интерфейса нет в каталоге' };
    const keys = Object.keys(n);
    const instances = [];
    (function walk(x, k, depth) {
        if (depth > 4 || x === null || x === undefined) return;
        if (/instance/i.test(k || '')) {
            if (Array.isArray(x)) x.forEach((v) => { if (typeof v === 'string' || typeof v === 'number') instances.push(String(v)); else if (v && (v.name || v.id || v.instance)) instances.push(String(v.name || v.id || v.instance)); });
            else if (typeof x === 'string' || typeof x === 'number') instances.push(String(x));
            else if (typeof x === 'object') Object.keys(x).forEach((i) => instances.push(i));
        }
        if (typeof x === 'object') Object.keys(x).forEach((c) => { if (c !== 'fields' && c !== 'methods' && c !== 'broadcasts') walk(x[c], c, depth + 1); });
    })(n, '', 0);
    const rest = {};
    keys.filter((k) => !/^(fields|methods|broadcasts|attributes)$/.test(k)).forEach((k) => { rest[k] = n[k]; });
    let extra = '';
    try { extra = JSON.stringify(rest); } catch (e) { extra = String(e); }
    return { keys, instances: Array.from(new Set(instances)), extra: extra.length > 300 ? extra.slice(0, 300) + '…' : extra };
}

function probe(db, iface, field, instances, flags) {
    let g;
    try { g = loadGen(); } catch (e) { return [{ inst: '-', ok: false, msg: 'генератор: ' + (e && e.message || e) }]; }
    return instances.map((inst) => {
        try {
            const manifest = { proxies: { [iface]: { instances: inst, attributes: { [field]: flags || 'r' } } }, services: {} };
            const out = g.generate(db, manifest);
            return { inst, flags: flags || 'r', ok: true, msg: 'ок, ' + Object.keys(out || {}).length + ' конфиг.' };
        } catch (e) {
            return { inst, flags: flags || 'r', ok: false, msg: String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 140) };
        }
    });
}

module.exports = { info, probe, loadGen, ifaceNode };
