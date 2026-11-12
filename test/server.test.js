const test = require('node:test');
const assert = require('node:assert/strict');

process.env.FIREBASE_PROJECT_ID = 'legion-test-project';
process.env.REGISTRATION_CODE_SECRET = 'test-secret-with-more-than-thirty-two-characters';

const {
    containsSensitiveField,
    getBearerToken,
    registrationCodeDigest,
    toFcmData
} = require('../server');

test('Bearer token parser accepts only a well-formed bearer header', () => {
    assert.equal(getBearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
    assert.equal(getBearerToken('Basic abc'), undefined);
    assert.equal(getBearerToken('Bearer'), undefined);
});

test('sensitive fields are detected recursively in objects and arrays', () => {
    assert.equal(containsSensitiveField({ message: 'safe' }), false);
    assert.equal(containsSensitiveField({ settings: [{ refresh_token: 'secret' }] }), true);
    assert.equal(containsSensitiveField({ registrationCode: '1234' }), true);
});

test('FCM data contains only non-null values converted to strings', () => {
    assert.deepEqual(toFcmData({ callId: 12, video: false, ignored: null }), {
        callId: '12',
        video: 'false'
    });
    assert.deepEqual(toFcmData([]), {});
});

test('registration code digests normalize the username and code', () => {
    assert.equal(registrationCodeDigest(' Soldier ', ' abcd-1234 '), registrationCodeDigest('soldier', 'ABCD-1234'));
    assert.notEqual(registrationCodeDigest('soldier', 'ABCD-1234'), registrationCodeDigest('soldier', 'DIFFERENT'));
});
