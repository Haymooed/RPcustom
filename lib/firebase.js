'use strict';

const fs = require('fs');
const path = require('path');

let db = null;
let initialized = false;

function getCredentials() {
    // 1. FIREBASE_SERVICE_ACCOUNT — paste the entire JSON file contents as one env var
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            if (sa.project_id && sa.client_email && sa.private_key) {
                return { projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key };
            }
        } catch (e) { console.error('[Firebase] FIREBASE_SERVICE_ACCOUNT parse error:', e.message); }
    }

    // 2. Individual env vars (FIREBASE_PROJECT_ID etc.)
    if (process.env.FIREBASE_PROJECT_ID) {
        return {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
        };
    }

    // 3. config.yml (gitignored, used on Pelican)
    try {
        const yaml = require('js-yaml');
        const configPath = path.join(__dirname, '..', 'config.yml');
        const config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
        const fb = config.firebase;
        if (fb?.project_id && fb?.client_email && fb?.private_key) {
            return {
                projectId: fb.project_id,
                clientEmail: fb.client_email,
                privateKey: String(fb.private_key).replace(/\\n/g, '\n')
            };
        }
    } catch {}

    return null;
}

function getDb() {
    if (initialized) return db;
    initialized = true;

    const creds = getCredentials();
    if (!creds) return null;

    try {
        const admin = require('firebase-admin');
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(creds) });
        }
        db = admin.firestore();
        console.log('[Firebase] Firestore connected');
        return db;
    } catch (e) {
        console.error('[Firebase] Init error:', e.message);
        return null;
    }
}

module.exports = { getDb };
