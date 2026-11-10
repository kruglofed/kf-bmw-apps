'use strict';
/**
 * Рулёжка - колёса, рулёжка и полный привод BMW G05 на экране MGU (iDrive 7).
 *
 * Две страницы:
 *   Колёса    вид машины сверху. Передние колёса поворачиваются за рулём (каждое под своим углом -
 *             внутреннее круче), задние - по модели интегральной рейки: до ~60 км/ч против передних
 *             (до 3°), выше - в ту же сторону. У каждого колеса шкалы: как быстро оно крутится
 *             (об/мин и разница с остальными в %) и какая на нём тяга или торможение (кН). В центре -
 *             как xDrive делит тягу между осями. Справа живые числа с минимумом и максимумом.
 *   Каталог   ищет в списке сигналов головного устройства (/etc/oap/someip/someip-interfaces.json)
 *             угол задней оси, обороты колёс и сигналы раздатки xDrive - чтобы заменить модели
 *             настоящими данными.
 *
 * Что настоящее, а что посчитано:
 *   датчики   угол руля, рыскание, ускорения, скорость, момент мотора;
 *   расчёт    углы передних колёс (руль / передаточное число, Аккерман), обороты каждого колеса
 *             (скорость + рыскание: геометрия, не датчики колёс), тяга всего (масса × ускорение +
 *             сопротивления);
 *   модель    угол задних колёс и деление тяги перёд/зад - их сигналов машина экрану пока не отдаёт.
 *
 * Приложение только читает данные: ни одного запроса в блоки управления, ничего не пишется в машину.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha, mix } = require('./kit/canvas');
const { scan, readCatalog } = require('./catalog');
const M = require('./model');

const W = 1600, H = 520;
const STEER = 'de.bmw.chassis.SteeringAngle', CDS2 = 'de.bmw.infotainment.vehicle.CDS2', V2 = 'de.bmw.infotainment.vehicle.Vehicle2',
    FES = 'de.bmw.infotainment.drivingexcitement.FES';
const PAGES = ['Колёса', 'Каталог'];
const STALE_MS = 3000, RAD = Math.PI / 180;
const RPM_MAX = 1200;          // шкала оборотов колеса (~165 км/ч)
const KN_MAX = 6;              // шкала тяги на колесо, кН

const isNum = M.isNum;
const sgn = (x) => (x > 0 ? '+' : x < 0 ? '-' : '');
const fx = (x, d) => Math.abs(x).toFixed(d).replace('.', ',');
const f1 = (x) => (isNum(x) ? sgn(Math.round(x * 10)) + fx(x, 1) : '--');
const f2 = (x) => (isNum(x) ? sgn(Math.round(x * 100)) + fx(x, 2) : '--');
const i0 = (x) => (isNum(x) ? (Math.round(x) < 0 ? '-' : '') + Math.abs(Math.round(x)) : '--');

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        let page = 0;

        /* ---------- живые сигналы ---------- */
        const S = {};   // id -> { v, at, min, max }
        function put(id, v) {
            if (!isNum(v)) return;
            const s = S[id] || (S[id] = { v: null, at: 0, min: Infinity, max: -Infinity });
            s.v = v; s.at = Date.now();
            if (v < s.min) s.min = v;
            if (v > s.max) s.max = v;
        }
        const fresh = (id) => { const s = S[id]; return s && Date.now() - s.at < STALE_MS ? s.v : null; };
        const num = (v, m, bad) => {
            let x = v && v[m];
            if (typeof x === 'string' && /^-?\d+$/.test(x)) x = Number(x);
            if (!isNum(x) || (bad && bad.indexOf(x) >= 0)) return null;
            return x;
        };
        const watch = (iface, handlers, poll) => ctx.signals.watch(iface, '1', handlers, log, poll ? { pollMs: poll } : undefined)
            .then((s) => { if (s && s.error) log.warn(iface + ': ' + s.error); return s; })
            .catch((e) => log.warn(iface + ': ' + e));

        // угол руля: два поля, главное - с CRC; служебные коды и одиночные скачки отбрасываются
        const steerF = new M.SteerFilter();
        const dir = () => (settings.get('steerDir') === 'invert' ? -1 : 1);
        const steerFrom = (src) => (v) => {
            const now = Date.now(), raw = v && v.actualValueSteeringAngleDriver, d = M.decodeSteer(raw);
            steerF.feed(src, d === null ? null : d * dir(), now);
            if (steerF.at === now && steerF.source === src) put('steer', steerF.v);
        };
        watch(STEER, { ActualSteeringAngleDriver: steerFrom('crc'), actualSteeringAngleDriverNoCRC: steerFrom('nocrc') });
        watch(CDS2, {
            statusYawVelocityVehicle: (v) => { const r = num(v, 'yawVelocityVehicle', [65535]); if (r !== null) put('yaw', r * 0.005 - 163.84); },
            statusLateralAccelerationMassCenter: (v) => { const r = num(v, 'lateralAccelerationCentreOfGravity', [65535]); if (r !== null) put('gLat', (r * 0.002 - 65) / M.G0); },
            statusLongitudinalAccelerationMassCenter: (v) => { const r = num(v, 'longitudinalAccelerationCentreOfGravity', [65535]); if (r !== null) put('gLong', (r * 0.002 - 65) / M.G0); },
        }, 10000);
        watch(V2, { statusCarSpeed2: (v) => { const r = num(v, 'speedVehicleCentreOfGravity', [65535]); if (r !== null) put('speed', r * 0.015625); } }, 10000);
        watch(FES, { statusActualValueTorque2: (v) => { const r = num(v, 'actualValueTorqueCrankshaft', [65535]); if (r !== null && r < 4095) put('torque', r * 0.5 - 1023.5); } }, 10000);

        // знаки рыскания и бокового ускорения подстраиваются под руль (у BMW плюс может быть влево)
        const yawSign = new M.SignLearner(), latSign = new M.SignLearner();
        let lastLearn = 0;

        /* ---------- демо (нет данных от машины) ---------- */
        const started = Date.now();
        const anyData = () => Object.keys(S).some((k) => S[k].at);
        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !anyData() && Date.now() - started > 5000);
        /** 24-секундный круг: руль на месте, разгон, повороты, торможение */
        function demo() {
            const s = ((Date.now() - started) / 1000) % 24;
            let kmh, gLong, sw;
            if (s < 6) { kmh = 0; gLong = 0; sw = 520 * Math.sin(s / 6 * 2 * Math.PI); }
            else if (s < 11) { kmh = (s - 6) * 8; gLong = 8 / 3.6 / M.G0 + 0.02; sw = 0; }
            else if (s < 18) { kmh = 40; gLong = 0.03; sw = 140 * Math.sin((s - 11) / 7 * 2 * Math.PI); }
            else { kmh = Math.max(0, 40 - (s - 18) * 8); gLong = kmh > 0 ? -8 / 3.6 / M.G0 : 0; sw = 0; }
            const fw = M.frontWheels(sw, ratio()), dr = M.rearModel(fw.mean, kmh), v = kmh / 3.6;
            const yaw = v * (Math.tan(fw.mean * RAD) - Math.tan(dr * RAD)) / M.CAR.L / RAD;
            return { steer: sw, yaw, gLat: v * yaw * RAD / M.G0, gLong, speed: kmh, torque: gLong > 0.05 ? 380 : gLong < -0.05 ? -20 : 90 };
        }

        /* ---------- каталог ---------- */
        let scanDone = false, cat = null;     // { path, error, matches }
        function runScan() {
            if (scanDone) return;
            scanDone = true;
            if (demoOn()) {
                const demoDb = { interfaces: {
                    'de.bmw.chassis.SteeringAngle': { fields: { ActualSteeringAngleDriver: {} } },
                    'de.bmw.chassis.RearAxleSteering': { fields: { statusRearAxleSteeringAngle: {} } },
                    'de.bmw.chassis.WheelSpeed': { fields: { statusWheelSpeedFrontLeft: {} } },
                    'de.bmw.infotainment.vehicle.CDS2': { fields: { statusYawVelocityVehicle: {}, statusLateralAccelerationMassCenter: {} } },
                } };
                cat = { path: 'демо', error: null, matches: scan(demoDb) };
                return;
            }
            try {
                const r = readCatalog();
                cat = { path: r.path, error: r.error, matches: r.data ? scan(r.data) : [] };
                if (cat.matches.length) {
                    log.info('steer scan: ' + cat.matches.length + ' matches in ' + r.path);
                    cat.matches.forEach((m) => log.info('  ' + m.iface + ' . ' + m.field + '  [' + m.tag + ']'));
                    try { fs.writeFileSync(path.join(ctx.dataDir, 'steer-scan.txt'),
                        cat.matches.map((m) => m.iface + '\t' + m.field + '\t' + m.tag).join('\n')); } catch (e) { /* ignore */ }
                } else log.info('steer scan: no matches (' + (r.path || r.error) + ')');
            } catch (e) { cat = { path: null, error: String(e), matches: [] }; log.warn('steer scan: ' + e); }
        }

        /* ---------- состояние кадра ---------- */
        const ratio = () => Number(settings.get('steerRatio')) || 15;
        const tread = { fl: 0, fr: 0, rl: 0, rr: 0 };   // фаза рисунка протектора, px
        let lastFrame = 0;

        /** все значения для кадра: живые (или демо) + посчитанное */
        function frame() {
            const now = Date.now(), d = demoOn() ? demo() : null;
            const sw = d ? d.steer : steerF.value(now);
            const yawRaw = d ? d.yaw : fresh('yaw'), latRaw = d ? d.gLat : fresh('gLat');
            const gLong = d ? d.gLong : fresh('gLong'), kmh = d ? d.speed : fresh('speed'), torque = d ? d.torque : fresh('torque');
            if (!d && now - lastLearn > 100) { lastLearn = now; yawSign.feed(sw, yawRaw, kmh, 2); latSign.feed(sw, latRaw, kmh, 0.05); }
            const yaw = isNum(yawRaw) ? yawRaw * (d ? 1 : yawSign.sign()) : null;
            const gLat = isNum(latRaw) ? latRaw * (d ? 1 : latSign.sign()) : null;
            // картинка - плавно (пружина), числа - как есть
            const swVis = G.smooth('sw', sw, 14);
            const front = M.frontWheels(sw, ratio()), frontVis = M.frontWheels(swVis, ratio());
            const rear = front ? M.rearModel(front.mean, kmh) : null;
            const rearVis = G.smooth('rear', frontVis ? M.rearModel(frontVis.mean, kmh) : null, 10);
            const rearYaw = front ? M.rearFromYaw(front.mean, yaw, kmh, gLat) : null;
            const speeds = M.wheelSpeeds(kmh, yaw, front && front.mean, rear);
            const drive = M.driveForces({ kmh, gLong, gLat });
            return { d, sw, yaw, gLat, gLong, kmh, torque, front, frontVis, rear, rearVis, rearYaw: G.smooth('ry', rearYaw, 3), speeds, drive };
        }

        /* ---------- рисование ---------- */
        function label(cv, t, x, y, s, align) { cv.text(s.toUpperCase(), x, y, 18, t.dim, { font: 'bold', spacing: 1.5, align: align || 'left' }); }

        /** шина сверху: прямоугольник под углом, с бегущим рисунком протектора */
        function tyre(cv, t, cx, cy, ang, len, wid, phase, glow, live) {
            const a = ang * RAD, ux = Math.sin(a), uy = -Math.cos(a), vx = Math.cos(a), vy = Math.sin(a);
            const h = len / 2, w = wid / 2;
            const P = (p, q) => [cx + ux * p + vx * q, cy + uy * p + vy * q];
            if (glow) cv.quad([P(h + 5, w + 5), P(h + 5, -w - 5), P(-h - 5, -w - 5), P(-h - 5, w + 5)], glow);
            cv.quad([P(h, w), P(h, -w), P(-h, -w), P(-h, w)], live ? withAlpha(t.text, 0.85) : withAlpha(t.text, 0.3));
            cv.quad([P(h - 3, w - 3), P(h - 3, -w + 3), P(-h + 3, -w + 3), P(-h + 3, w - 3)], mix(t.bg, t.track, 0.6));
            const pitch = 14;
            for (let p = -h + 6 + (((phase % pitch) + pitch) % pitch); p < h - 4; p += pitch) {
                const A = P(p, w - 6), B = P(p, -w + 6);
                cv.line(A[0], A[1], B[0], B[1], 3, live ? withAlpha(t.text, 0.55) : withAlpha(t.text, 0.18));
            }
        }

        /** шкала у колеса: обороты и тяга. side: -1 слева от машины, +1 справа */
        function wheelGauge(cv, t, x, y, w, name, ang, sp, force, mode) {
            const rpm = sp ? sp.rpm : null;
            label(cv, t, x, y, name);
            cv.text(isNum(ang) ? f1(ang) + '°' : '', x + w, y, 20, t.dim, { align: 'right' });
            // обороты
            cv.text(isNum(rpm) ? String(Math.round(rpm)) : '--', x, y + 34, 30, isNum(rpm) ? t.text : t.dim, { font: 'num' });
            cv.text('об/мин', x + 74, y + 34, 18, t.dim);
            if (sp && isNum(sp.diff) && rpm > 5) {
                const big = Math.abs(sp.diff) >= 0.5;
                cv.text(f1(sp.diff) + ' %', x + w, y + 34, 22, big ? (sp.diff > 0 ? t.accent2 : t.warn) : t.dim, { align: 'right', font: 'bold' });
            }
            const by = y + 44;
            cv.fillRect(x, by, w, 8, t.track);
            if (isNum(rpm) && rpm > 0) cv.fillRect(x, by, Math.max(2, w * M.clamp(rpm / RPM_MAX, 0, 1)), 8, t.accent);
            // тяга
            const kn = isNum(force) ? force / 1000 : null;
            const word = mode === 'brake' ? 'тормоз' : mode === 'idle' ? 'тяга' : 'тяга';
            cv.text(word, x, y + 78, 20, t.dim);
            cv.text(isNum(kn) ? fx(kn, 1) + ' кН' : '--', x + w, y + 78, 22, isNum(kn) ? (kn < -0.05 ? t.warn : t.text) : t.dim, { align: 'right', font: 'bold' });
            const ty = y + 88, mid = x + w / 2;
            cv.fillRect(x, ty, w, 10, t.track);
            cv.fillRect(mid - 1, ty - 3, 2, 16, withAlpha(t.tick, 0.9));
            if (isNum(kn) && Math.abs(kn) > 0.02) {
                const len = (w / 2) * M.clamp(Math.abs(kn) / KN_MAX, 0, 1);
                if (kn > 0) cv.fillRect(mid, ty, Math.max(2, len), 10, t.accent2);
                else cv.fillRect(mid - Math.max(2, len), ty, Math.max(2, len), 10, t.warn);
            }
        }

        function drawCar(cv, t, F) {
            const now = Date.now(), dt = lastFrame ? Math.min(0.25, (now - lastFrame) / 1000) : 0;
            lastFrame = now;
            const cx = 474, bw = 300, bx = cx - bw / 2, by = 86, bh = 396;
            const axF = 172, axR = 420, half = 180, tl = 84, tw = 30;
            const live = !!F.front;
            // корпус
            cv.roundRect(bx, by, bw, bh, 46, withAlpha(t.text, 0.07));
            cv.strokeRoundRect(bx, by, bw, bh, 46, 2, withAlpha(t.text, 0.28));
            cv.roundRect(bx + 34, by + 112, bw - 68, 46, 12, withAlpha(t.text, 0.06));     // лобовое
            cv.roundRect(bx + 40, by + bh - 86, bw - 80, 34, 10, withAlpha(t.text, 0.05));   // заднее
            // оси и полуоси
            cv.line(cx - half, axF, cx + half, axF, 4, withAlpha(t.text, 0.16));
            cv.line(cx - half, axR, cx + half, axR, 4, withAlpha(t.text, 0.16));
            cv.line(cx, axF + 26, cx, axR - 26, 4, withAlpha(t.text, 0.10));             // карданы от раздатки
            // колёса
            const fv = F.frontVis, sp = F.speeds, dr = F.drive;
            const ang = { fl: fv ? fv.left : 0, fr: fv ? fv.right : 0, rl: isNum(F.rearVis) ? F.rearVis : 0, rr: isNum(F.rearVis) ? F.rearVis : 0 };
            const pos = { fl: [cx - half, axF], fr: [cx + half, axF], rl: [cx - half, axR], rr: [cx + half, axR] };
            ['fl', 'fr', 'rl', 'rr'].forEach((k) => {
                const v = sp ? sp[k].kmh : 0;
                tread[k] += Math.min(300, v * 12) * dt;
                const f = dr ? dr.wheels[k] : 0, frac = M.clamp(Math.abs(f) / (KN_MAX * 1000), 0, 1);
                const glow = dr && frac > 0.02 ? withAlpha(f > 0 ? t.accent2 : t.warn, 0.15 + 0.55 * frac) : null;
                tyre(cv, t, pos[k][0], pos[k][1], ang[k], tl, tw, tread[k], glow, live || (k[0] === 'r' && isNum(F.rearVis)));
            });
            // подписи углов
            const fm = F.front ? F.front.mean : null;
            cv.text(isNum(fm) ? 'перёд ' + f1(fm) + '°' : 'перёд --', cx, by - 12, 24, live ? t.text : t.dim, { align: 'center', font: 'bold' });
            cv.text(isNum(F.rear) ? 'зад ' + f1(F.rear) + '°  · модель рейки' : 'зад --', cx, 508, 21, isNum(F.rear) ? t.text : t.dim, { align: 'center' });
            // xDrive в центре
            const share = dr && dr.mode !== 'idle' ? dr.shareF : null;
            const modeTxt = !dr ? 'нет данных' : dr.mode === 'brake' ? 'торможение' : dr.mode === 'idle' ? 'стоим' : dr.mode === 'coast' ? 'накат' : 'тяга';
            cv.text('XDRIVE', cx, 250, 18, t.dim, { align: 'center', font: 'bold', spacing: 2 });
            cv.text(modeTxt, cx, 276, 22, dr && dr.mode === 'brake' ? t.warn : t.text, { align: 'center' });
            const sx = cx - 9, sy = 292, sh = 70;
            cv.fillRect(sx, sy, 18, sh, t.track);
            if (isNum(share)) {
                const fc = dr.mode === 'brake' ? t.warn : t.accent2;
                cv.fillRect(sx, sy, 18, sh * share, fc);
                cv.fillRect(sx, sy + sh * share, 18, sh * (1 - share), withAlpha(fc, 0.45));
            }
            cv.text(isNum(share) ? 'перёд ' + Math.round(share * 100) + ' %' : 'перёд --', sx - 12, sy + 16, 20, t.text, { align: 'right' });
            cv.text(isNum(share) ? 'зад ' + Math.round((1 - share) * 100) + ' %' : 'зад --', sx + 30, sy + sh - 2, 20, t.text);
            cv.text(dr ? (dr.mode === 'brake' ? 'тормозит ' : 'всего ') + fx(dr.total / 1000, 1) + ' кН' : '', cx, sy + sh + 28, 20, t.dim, { align: 'center' });
            // шкалы у колёс
            const gw = 222, xl = 34, xr = cx + half + tw / 2 + 22;
            const names = { fl: 'Л перед', fr: 'П перед', rl: 'Л зад', rr: 'П зад' };
            [['fl', xl, axF], ['fr', xr, axF], ['rl', xl, axR], ['rr', xr, axR]].forEach((g) => {
                const k = g[0], a = k[0] === 'f' ? (F.front ? F.front[k === 'fl' ? 'left' : 'right'] : null) : F.rear;
                wheelGauge(cv, t, g[1], g[2] - 44, gw, names[k], a, sp && sp[k], dr ? dr.wheels[k] : null, dr && dr.mode);
            });
        }

        /** k: знак, подобранный под руль (минимум и максимум с ним меняются местами) */
        function readRow(cv, t, x, y, w, name, id, unit, fmt, v, k) {
            const s = S[id];
            cv.text(name, x, y, 23, isNum(v) ? t.text : t.dim);
            if (s && s.at && isFinite(s.min) && !demoOn()) {
                const a = k === -1 ? -s.max : s.min, b = k === -1 ? -s.min : s.max;
                cv.text(fmt(a) + ' … ' + fmt(b), x + 330, y, 18, t.dim, { align: 'right' });
            }
            cv.text(isNum(v) ? fmt(v) + ' ' + unit : (s && s.at ? 'нет сигнала' : '--'), x + w, y, 27, isNum(v) ? t.text : t.dim, { align: 'right', font: 'bold' });
        }

        function drawWheels(cv, t) {
            const F = frame();
            drawCar(cv, t, F);
            const px = 960, pw = 596;
            G.panel(cv, t, 940, 44, 636, 468, 'Живые значения');
            label(cv, t, px, 122, 'Угол руля');
            const sw = F.sw;
            cv.text(isNum(sw) ? f1(sw).replace(/,\d$/, '') + '°' : '--', px + pw, 124, 58, isNum(sw) ? t.accent : t.dim, { align: 'right', font: 'num' });
            cv.text(isNum(sw) ? (sw > 5 ? 'вправо' : sw < -5 ? 'влево' : 'прямо') : 'нет сигнала руля', px, 156, 22, isNum(sw) ? t.text : t.dim);
            if (!F.d && (steerF.spikes || steerF.bad || steerF.disagree)) {
                cv.text('отсеяно: скачков ' + steerF.spikes + ', пустых ' + steerF.bad + (steerF.disagree ? ', расхождений полей ' + steerF.disagree : ''),
                    px + pw, 156, 17, t.dim, { align: 'right' });
            }
            cv.fillRect(px, 176, pw, 1, withAlpha(t.tick, 0.4));
            const rows = [
                ['Рыскание', 'yaw', '°/с', f1, F.yaw, yawSign.sign()], ['Ускорение вбок', 'gLat', 'g', f2, F.gLat, latSign.sign()], ['Ускорение вперёд', 'gLong', 'g', f2, F.gLong],
                ['Скорость', 'speed', 'км/ч', i0, F.kmh], ['Момент мотора', 'torque', 'Нм', i0, F.torque],
            ];
            rows.forEach((r, i) => readRow(cv, t, px, 214 + i * 42, pw, r[0], r[1], r[2], r[3], r[4], r[5]));
            cv.fillRect(px, 422, pw, 1, withAlpha(t.tick, 0.4));
            cv.text('Зад по рысканию (проверка модели): ' + (isNum(F.rearYaw) ? '~' + f1(F.rearYaw) + '°' : 'нужно ехать 8–60 км/ч с поворотом'),
                px, 450, 19, isNum(F.rearYaw) ? t.text : t.dim);
            cv.text('Обороты колёс - по скорости и рысканию. Доли xDrive и угол зада -', px, 476, 18, t.dim);
            cv.text('модель: машина этих сигналов на экран не даёт (ищем в «Каталоге»).', px, 498, 18, t.dim);
        }

        function drawCatalog(cv, t) {
            runScan();
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'Сигналы рулёжки, колёс и xDrive в каталоге головного устройства'), ey = p.y + p.h - G.BOTTOM;
            if (!cat) { cv.text('Читаю каталог…', 48, 150, 28, t.dim); return; }
            if (cat.error && !cat.matches.length) {
                cv.text('Каталог не прочитан.', 48, 140, 30, t.warn, { font: 'bold' });
                cv.text(cat.error, 48, 182, 22, t.dim);
                cv.text('Возможно, у приложения нет доступа к файлу. Сообщи мне — подскажу другой путь.', 48, 222, 22, t.dim);
                return;
            }
            const head = cat.path === 'демо' ? 'Демо-режим: пример того, что покажет поиск на машине'
                : 'Найдено ' + cat.matches.length + ' · ' + cat.path + ' · сохранено в steer-scan.txt';
            cv.text(head, 48, 108, 22, t.dim);
            const key = { 'задняя ось': 1, 'xDrive': 1, 'колесо': 1 };
            const hot = cat.matches.filter((m) => key[m.tag]);
            cv.text(hot.length ? 'Задняя ось, колёса, xDrive: ' + hot.length + ' — по ним заменю модели настоящими данными'
                : 'Сигналов задней оси, колёс и xDrive не видно — пришли мне фото всего списка', 48, 138, 22, hot.length ? t.accent : t.warn);
            const rowH = 36, per = Math.max(1, Math.floor((ey + 290) / rowH));
            const total = cat.matches.length, pages = Math.max(1, Math.ceil(total / per));
            const pg = ((catPage % pages) + pages) % pages, from = pg * per;
            const cols = [{ label: 'Интерфейс', w: 720 }, { label: 'Поле / сигнал', w: 620 }, { label: 'Что это', w: 212 }];
            const rows = cat.matches.slice(from, from + per).map((m) => [
                { text: m.iface, color: key[m.tag] ? 'accent' : null, font: key[m.tag] ? 'bold' : null },
                { text: m.field, font: key[m.tag] ? 'bold' : null },
                { text: m.tag, color: 'dim' }]);
            G.table(cv, t, 48, 160, 1504, cols, rows, { rowH, size: 23, empty: 'Ничего про рулёжку, колёса и оси в каталоге не нашлось' });
            cv.text((total > per ? 'Стр. ' + (pg + 1) + '/' + pages + ' — кнопкой «Следующая страница». ' : '') + 'Сфотографируй экран и пришли мне.',
                48, 500 + G.toMargin(ey, 0), 20, t.dim);
        }

        let catPage = 0;
        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) drawWheels(cv, t); else drawCatalog(cv, t);
            G.frame(cv, t, PAGES, page, [demoOn() && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }

        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_PAGE', () => { if (page === 1) { catPage++; return render(); } return go(page + 1); });
        ui.onClick('BTN_PREV', () => { if (page === 1 && catPage > 0) { catPage--; return render(); } return go(page - 1); });
        ctx.onTab((i) => { catPage = 0; return go(i); });
        ctx.loop('MAIN', 6, render);
        render().then(() => log.info('steer: first frame')).catch((e) => log.warn('first render: ' + e));
    },
});
