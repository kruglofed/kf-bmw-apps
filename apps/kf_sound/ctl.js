'use strict';
/**
 * ctl.js - переключение двух настроек звука, найденных в каталоге G05:
 *
 *   de.bmw.infotainment.vehicle.VSGSwitch . personalizationASD                       (запись)
 *   de.bmw.powertrain.enginesound.EngineSoundConfiguration . operationIndividualizationEngineSound (запись)
 *
 * Тип значения заранее не известен. Поэтому:
 *   leaf(v)            находит в пришедшей структуре само значение (число / да-нет / строку) и путь к нему
 *   withLeaf(v, p, x)  та же структура с новым значением (для записи)
 *   describe(db, f)    описание поля из каталога: текст и варианты значений (enum), если они там есть
 *   next(x, enums)     следующее значение: да/нет - наоборот, enum - следующий по списку, число без
 *                      списка - по кругу 0, 1, 2
 */

const isPrim = (x) => x === null || ['number', 'boolean', 'string'].indexOf(typeof x) >= 0;

function leaf(v) {
    if (isPrim(v)) return { path: [], value: v };
    if (!v || typeof v !== 'object') return null;
    const stack = [{ node: v, path: [] }];
    while (stack.length) {
        const { node, path } = stack.shift();
        for (const k of Object.keys(node)) {
            const x = node[k];
            if (isPrim(x) && x !== null) return { path: path.concat(k), value: x };
            if (x && typeof x === 'object' && !Buffer.isBuffer(x)) stack.push({ node: x, path: path.concat(k) });
        }
    }
    return null;
}

function withLeaf(v, path, x) {
    if (!path.length) return x;
    const out = JSON.parse(JSON.stringify(v));
    let n = out;
    for (let i = 0; i < path.length - 1; i++) n = n[path[i]];
    n[path[path.length - 1]] = x;
    return out;
}

/** варианты enum из куска каталога: массивы {name, value} или объекты ИМЯ -> число */
function enumsIn(node, out) {
    out = out || [];
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        node.forEach((e) => {
            if (e && typeof e === 'object' && typeof e.name === 'string' && (typeof e.value === 'number' || /^-?\d+$/.test(String(e.value)))) {
                out.push({ name: e.name, value: Number(e.value) });
            } else enumsIn(e, out);
        });
        return out;
    }
    const keys = Object.keys(node);
    const numeric = keys.filter((k) => /^[A-Z][A-Z0-9_]+$/.test(k) && typeof node[k] === 'number');
    if (numeric.length >= 2) numeric.forEach((k) => out.push({ name: k, value: node[k] }));
    keys.forEach((k) => { if (typeof node[k] === 'object') enumsIn(node[k], out); });
    return out;
}

/** ищет в каталоге описание поля и типов, на которые оно ссылается */
function describe(db, field) {
    const hits = [], paths = [], names = new Set();
    let budget = 3000000;
    (function walk(n, trail) {
        if (budget-- <= 0 || !n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach((x, i) => walk(x, trail.concat('[' + i + ']'))); return; }
        if (n.name === field) { hits.push(n); paths.push(trail.join(' > ')); }
        for (const k of Object.keys(n)) {
            if (k === field) { hits.push(n[k]); paths.push(trail.concat(k).join(' > ')); }
            walk(n[k], trail.concat(k));
        }
    })(db, []);
    // имена типов, на которые ссылается поле
    const refs = (o) => { if (!o || typeof o !== 'object') return; for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === 'string' && /type|ref|datatype/i.test(k) && v.length < 120) names.add(v.split(/[.:/]/).pop()); else refs(v); } };
    hits.forEach(refs);
    const types = [];
    if (names.size) {
        budget = 3000000;
        (function walk(n) {
            if (budget-- <= 0 || !n || typeof n !== 'object') return;
            if (Array.isArray(n)) { n.forEach(walk); return; }
            for (const k of Object.keys(n)) {
                if (names.has(k) && n[k] && typeof n[k] === 'object') types.push(n[k]);
                walk(n[k]);
            }
            if (typeof n.name === 'string' && names.has(n.name)) types.push(n);
        })(db);
    }
    const enums = [];
    const seen = new Set();
    hits.concat(types).forEach((h) => enumsIn(h, []).forEach((e) => { const key = e.name + '=' + e.value; if (!seen.has(key)) { seen.add(key); enums.push(e); } }));
    enums.sort((a, b) => a.value - b.value);
    const text = JSON.stringify({ where: paths.slice(0, 3), field: hits.slice(0, 2), types: types.slice(0, 3) });
    const tt = JSON.stringify(types.slice(0, 3));
    return { typesText: tt.length > 400 ? tt.slice(0, 400) + '…' : tt, found: hits.length > 0, paths, enums, text: text.length > 1500 ? text.slice(0, 1500) + '…' : text };
}

function next(x, enums) {
    if (typeof x === 'boolean') return !x;
    if (typeof x === 'number') {
        const vals = (enums || []).map((e) => e.value);
        if (vals.length) { const i = vals.indexOf(x); return vals[(i + 1) % vals.length]; }
        return (x + 1) % 3;
    }
    if (typeof x === 'string') {
        const ns = (enums || []).map((e) => e.name);
        if (ns.length) { const i = ns.indexOf(x); return ns[(i + 1) % ns.length]; }
    }
    return undefined;
}

/** короткая запись значения для экрана */
function show(v, enums) {
    const l = leaf(v);
    if (!l) return v === undefined ? 'нет данных' : JSON.stringify(v).slice(0, 60);
    const e = (enums || []).find((x) => x.value === l.value || x.name === l.value);
    return String(l.value) + (e && e.name !== l.value ? ' (' + e.name + ')' : '');
}

/** описание поля в каталоге (interfaces > iface > fields > field) одной строкой */
function fieldDef(db, iface, field) {
    const n = db && (db.interfaces && db.interfaces[iface] || db[iface]);
    const f = n && n.fields && n.fields[field];
    if (f === undefined) return 'нет в каталоге';
    let s; try { s = JSON.stringify(f); } catch (e) { s = String(e); }
    return s.length > 420 ? s.slice(0, 420) + '…' : s;
}

module.exports = { fieldDef, leaf, withLeaf, describe, enumsIn, next, show };
