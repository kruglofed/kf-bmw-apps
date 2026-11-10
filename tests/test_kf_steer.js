'use strict';
// node tests/test_kf_steer.js - расчёты «Рулёжки» (apps/kf_steer/model.js)
const assert = require('assert');
const M = require('../apps/kf_steer/model');
const near = (a, b, e, msg) => assert.ok(Math.abs(a - b) <= e, (msg || '') + ': ' + a + ' vs ' + b);

/* --- декодирование угла руля --- */
near(M.decodeSteer(1000), 43.95, 0.01, 'плюс');
near(M.decodeSteer(65536 - 1000), -43.95, 0.01, 'минус в беззнаковом виде');
near(M.decodeSteer(-1000), -43.95, 0.01, 'минус со знаком');
near(M.decodeSteer('1000'), 43.95, 0.01, 'строка');
assert.strictEqual(M.decodeSteer(0x8000), null, '0x8000 больше не превращается в -1440°');
assert.strictEqual(M.decodeSteer(0x7FFF), null, '0x7FFF');
assert.strictEqual(M.decodeSteer(0xFFFF), null, '0xFFFF');
assert.strictEqual(M.decodeSteer(30000), null, '1318° руля не бывает');
assert.strictEqual(M.decodeSteer(undefined), null);
assert.strictEqual(M.decodeSteer('abc'), null);

/* --- фильтр: два источника и скачки --- */
{
    const f = new M.SteerFilter();
    let t = 0;
    f.feed('crc', 100, t);
    f.feed('nocrc', -300, t + 20);            // второе поле расходится - игнор, пока главное живое
    assert.strictEqual(f.value(t + 20), 100, 'главное поле - с CRC');
    assert.strictEqual(f.disagree, 1);
    f.feed('crc', 110, t += 50);
    f.feed('crc', -700, t += 50);             // одиночный скачок
    assert.strictEqual(f.value(t), 110, 'скачок не принят');
    f.feed('crc', 115, t += 50);
    assert.strictEqual(f.value(t), 115, 'после скачка - нормально');
    assert.strictEqual(f.spikes, 1);
    // настоящий быстрый поворот принимается
    f.feed('crc', 160, t += 50);
    assert.strictEqual(f.value(t), 160, 'быстрый поворот 900°/с проходит');
    // резкая смена, подтверждённая вторым значением, принимается
    f.feed('crc', 500, t += 50);
    f.feed('crc', 505, t += 50);
    assert.strictEqual(f.value(t), 505, 'подтверждённое значение принято');
    // главное поле замолчало - работает запасное
    f.feed('nocrc', 480, t += 700);
    assert.strictEqual(f.value(t), 480, 'запасное поле, когда главное молчит');
    assert.strictEqual(f.value(t + 4000), null, 'устаревает');
    f.feed('crc', null, t); assert.strictEqual(f.bad, 1);
}

/* --- знак рыскания подбирается под руль --- */
{
    const s = new M.SignLearner();
    assert.strictEqual(s.sign(), 1);
    for (let i = 0; i < 10; i++) s.feed(90, -8, 30, 2);   // руль вправо, рыскание «минус» - у BMW плюс влево
    assert.strictEqual(s.sign(), -1);
    for (let i = 0; i < 3; i++) s.feed(90, -8, 5, 2);     // на месте не учится
    assert.strictEqual(s.score, -10);
}

/* --- передние колёса: Аккерман --- */
{
    const w = M.frontWheels(300, 15);
    near(w.mean, 20, 1e-9);
    assert.ok(w.right > w.mean && w.left < w.mean && w.left > 0, 'вправо: правое (внутреннее) круче');
    const l = M.frontWheels(-300, 15);
    assert.ok(l.left < l.mean && l.right > l.mean && l.right < 0, 'влево: левое круче');
    near(M.frontWheels(0, 15).left, 0, 1e-9);
    assert.strictEqual(M.frontWheels(null, 15), null);
    near(M.frontWheels(2000, 15).mean, 42, 1e-9, 'упор');
}

/* --- задняя ось --- */
{
    near(M.rearModel(35, 0), -2.975, 1e-6, 'на месте - против передних');
    assert.ok(M.rearModel(35, 0) < 0 && M.rearModel(-35, 0) > 0);
    near(M.rearModel(45, 5), -3, 1e-9, 'не больше 3°');
    near(M.rearModel(10, 60), 0, 1e-9, 'на 60 км/ч - прямо');
    assert.ok(M.rearModel(3, 120) > 0, 'на трассе - в ту же сторону');
    assert.ok(Math.abs(M.rearModel(10, 40)) < Math.abs(M.rearModel(10, 10)), 'с ростом скорости меньше');

    // обратный счёт по рысканию: построим рыскание из известного угла и получим его обратно
    const v = 20 / 3.6, df = 15, dr = -1.2;
    const yaw = v * (Math.tan(df * Math.PI / 180) - Math.tan(dr * Math.PI / 180)) / M.CAR.L * 180 / Math.PI;
    near(M.rearFromYaw(df, yaw, 20, 0), dr, 0.01, 'рыскание -> зад');
    assert.strictEqual(M.rearFromYaw(df, yaw, 3, 0), null, 'слишком медленно');
    assert.strictEqual(M.rearFromYaw(df, yaw, 20, 0.5), null, 'слишком резкий поворот');
}

/* --- колёса крутятся по-разному --- */
{
    const s = M.wheelSpeeds(30, 12, 10, -0.8);       // поворот вправо
    assert.ok(s.fl.rpm > s.fr.rpm, 'вправо: левое переднее (наружное) быстрее');
    assert.ok(s.rl.rpm > s.rr.rpm, 'левое заднее быстрее правого');
    assert.ok(s.fl.rpm > s.rl.rpm, 'переднее быстрее заднего');
    near((s.fl.diff + s.fr.diff + s.rl.diff + s.rr.diff) / 4, 0, 1e-9);
    const st = M.wheelSpeeds(60, 0, 0, 0);
    near(st.fl.rpm, st.rr.rpm, 1e-9, 'прямо - одинаково');
    near(st.fl.rpm, (60 / 3.6) / (2 * Math.PI * M.CAR.rTyre) * 60, 1e-6);
    const z = M.wheelSpeeds(0, null, 30, 0);
    near(z.fl.rpm, 0, 1e-9, 'на месте - стоят');
    // без рыскания - из геометрии, наружное всё равно быстрее
    const g = M.wheelSpeeds(20, null, -15, 1);
    assert.ok(g.fr.rpm > g.fl.rpm, 'влево: правое быстрее');
}

/* --- тяга --- */
{
    const cruise = M.driveForces({ kmh: 60, gLong: 0, gLat: 0 });
    assert.ok(cruise.total > 0 && cruise.shareF < 0.2, 'равномерно - почти всё назад');
    near(cruise.wheels.rl, cruise.wheels.rr, 1e-9, 'свободный дифференциал - поровну');
    const hard = M.driveForces({ kmh: 10, gLong: 0.4, gLat: 0 });
    assert.ok(hard.shareF > 0.45, 'с места в пол - перёд подключён');
    near(hard.total, M.CAR.mass * M.G0 * 0.4 + M.CAR.crr * M.CAR.mass * M.G0 + 0.5 * 1.2 * M.CAR.cdA * Math.pow(10 / 3.6, 2), 1e-6);
    const corner = M.driveForces({ kmh: 60, gLong: 0.15, gLat: 0.5 });
    const straight = M.driveForces({ kmh: 60, gLong: 0.15, gLat: 0 });
    assert.ok(corner.shareF < straight.shareF, 'в повороте больше назад');
    const brake = M.driveForces({ kmh: 50, gLong: -0.4 });
    assert.strictEqual(brake.mode, 'brake');
    assert.ok(brake.front < brake.rear && brake.front < 0, 'перёд тормозит сильнее');
    assert.strictEqual(M.driveForces({ kmh: 0, gLong: 0.01 }).mode, 'idle');
    assert.strictEqual(M.driveForces({ kmh: 0, gLong: 0.01 }).total, 0);
    assert.strictEqual(M.driveForces({ kmh: 30 }), null);
}

console.log('kf_steer model: ok');
