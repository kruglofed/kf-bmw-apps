'use strict';
// node tests/test_kf_sound.js - поиск управления наружным динамиком (apps/kf_sound/scan.js)
const assert = require('assert');
const { scan, summary, tagOf, writable, report } = require('../apps/kf_sound/scan');

assert.strictEqual(tagOf('statusExteriorSpeaker').key, 'outside');
assert.strictEqual(tagOf('activeSoundDesignMode').key, 'asd');
assert.strictEqual(tagOf('statusASD').key, 'asd');
assert.strictEqual(tagOf('statusDrivingExperience').key, 'mode');
assert.strictEqual(tagOf('FahrerlebnisSchalter').key, 'mode');
assert.strictEqual(tagOf('amplifierVolume').key, 'audio');
assert.strictEqual(tagOf('phoneRingtoneVolume'), null, 'телефон - мимо');
assert.strictEqual(tagOf('statusCarSpeed2'), null);
assert.strictEqual(tagOf('fastDisplay'), null, 'asd внутри слова - мимо');

assert.ok(writable({ getter: true, setter: true }));
assert.ok(writable({ flags: 'rw' }));
assert.ok(!writable({ getter: true, notifier: true }));
assert.ok(!writable({ setter: false }));

const db = { interfaces: {
    'de.bmw.infotainment.drivingexcitement.FES': { fields: { statusDrivingExperience: { getter: true }, statusActualValueTorque2: {} } },
    'de.bmw.infotainment.audio.SoundSettings': { fields: { activeSoundDesignMode: { setter: true }, loudness: { setter: true } },
        methods: { setExteriorSoundProfile: {} } },
    'de.bmw.infotainment.telephone.Phone': { fields: { ringtone: {} } },
} };
const f = scan(db);
const find = (field) => f.find((m) => m.field === field);
assert.strictEqual(find('activeSoundDesignMode').write, 'запись');
assert.strictEqual(find('activeSoundDesignMode').iface, 'de.bmw.infotainment.audio.SoundSettings');
assert.strictEqual(find('setExteriorSoundProfile').write, 'команда');
assert.strictEqual(find('statusDrivingExperience').write, '');
assert.ok(!find('ringtone'));
assert.ok(f[0].write, 'записываемое - первым');
const s = summary(f);
assert.strictEqual(s.writableKey, 2, 'ASD-запись и команда наружного звука');
assert.ok(s.mode >= 1 && s.asd >= 1 && s.outside >= 1);
assert.ok(/ASD 1/.test(report(f, 'x')));
assert.deepStrictEqual(scan({}), []);
console.log('kf_sound scan: ok');
