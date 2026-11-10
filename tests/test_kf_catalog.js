'use strict';
// node tests/test_kf_catalog.js - поиск сигналов рулёжки в каталоге (apps/kf_steer/catalog.js)
const assert = require('assert');
const { scan, tagOf } = require('../apps/kf_steer/catalog');

// каталог примерно той формы, что на блоке: интерфейс -> { fields: { имя: {...} } }
const db = {
    interfaces: {
        'de.bmw.chassis.SteeringAngle': { fields: { ActualSteeringAngleDriver: { member: 'actualValueSteeringAngleDriver' } } },
        'de.bmw.infotainment.vehicle.CDS2': { fields: { statusYawVelocityVehicle: {}, statusLateralAccelerationMassCenter: {} } },
        'de.bmw.chassis.RearAxleSteering': { fields: { statusRearAxleSteeringAngle: { member: 'angleRearAxle' } } },
        'de.bmw.powertrain.Powertrain': { fields: { AngleAcceleratorPedal: {}, ActualValueRPMWheel: {} } },
        'de.bmw.body.Doors': { fields: { statusDoorFrontLeft: {} } },
    },
};
const m = scan(db);
const has = (f) => m.some((x) => x.field === f);
assert.ok(has('ActualSteeringAngleDriver'), 'нашёл угол руля');
assert.ok(has('statusRearAxleSteeringAngle'), 'нашёл угол задней оси');
assert.ok(m.some((x) => x.iface === 'de.bmw.chassis.RearAxleSteering' && x.field === '(весь интерфейс)'), 'интерфейс задней оси помечен');
assert.ok(has('statusYawVelocityVehicle'), 'нашёл рыскание');
assert.ok(!has('AngleAcceleratorPedal'), 'педаль газа отброшена');
assert.ok(!has('statusDoorFrontLeft'), 'двери не при чём');

// угол задней оси идёт первым (тег «задняя ось»)
assert.strictEqual(m[0].tag, 'задняя ось', 'первым идёт задняя ось, а не ' + m[0].tag);
assert.ok(has('angleRearAxle'), 'имя члена задней оси тоже найдено');
// интерфейс определён верно
assert.strictEqual(m.find((x) => x.field === 'ActualSteeringAngleDriver').iface, 'de.bmw.chassis.SteeringAngle');

// немецкие имена и вложенность
const de = scan({ x: { 'de.bmw.chassis.Lenkung': { LenkwinkelHinterachse: {}, lenkradwinkel: {} } } });
assert.ok(de.some((x) => x.field === 'LenkwinkelHinterachse' && x.tag === 'задняя ось'));

// колёса и привод
assert.strictEqual(tagOf('statusWheelSpeedFrontLeft'), 'колесо');
assert.strictEqual(tagOf('ActualValueRPMWheel'), 'колесо');
assert.strictEqual(tagOf('statusTorqueDistributionXDrive'), 'xDrive');
assert.strictEqual(tagOf('VtgClutchTorque'), 'xDrive');
assert.ok(has('ActualValueRPMWheel'), 'обороты колеса найдены');

// теги
assert.strictEqual(tagOf('AngleAcceleratorPedal'), null);
assert.strictEqual(tagOf('statusSteeringAngle'), 'руль/поворот');
assert.ok(tagOf('yawVelocityVehicle'));

// пустой/мусорный ввод не падает
assert.deepStrictEqual(scan(null), []);
assert.deepStrictEqual(scan({ a: [1, 2, 'steer'] }).length >= 0, true);
console.log('kf_steer catalog: ok');
