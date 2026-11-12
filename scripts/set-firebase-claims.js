const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

async function main() {
    const [uid, accessArg, adminArg] = process.argv.slice(2);
    if (!uid || !['grant', 'revoke'].includes(accessArg) || !['admin', 'user'].includes(adminArg)) {
        throw new Error('Usage: node scripts/set-firebase-claims.js <firebase-uid> <grant|revoke> <admin|user>');
    }
    const app = getApps()[0] || initializeApp({
        credential: applicationDefault(),
        ...(process.env.FIREBASE_PROJECT_ID ? { projectId: process.env.FIREBASE_PROJECT_ID } : {})
    });
    const auth = getAuth(app);
    const user = await auth.getUser(uid);
    const customClaims = { ...user.customClaims };
    if (accessArg === 'grant') customClaims.legionAccess = true;
    else {
        delete customClaims.legionAccess;
        delete customClaims.legionUsername;
        delete customClaims.admin;
    }
    if (accessArg === 'grant' && adminArg === 'admin') customClaims.admin = true;
    else if (accessArg === 'grant') delete customClaims.admin;
    await auth.setCustomUserClaims(uid, customClaims);
    console.log(`Updated service access for Firebase UID ${uid}.`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
