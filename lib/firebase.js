'use strict';

const fs = require('fs');
const path = require('path');

let db = null;
let initialized = false;

function getCredentials() {
    // 1. Try env vars first
    if (process.env.FIREBASE_PROJECT_ID) {
        return {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
        };
    }

    // 2. Fall back to config.yml (already gitignored)
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
