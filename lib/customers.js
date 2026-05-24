'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('./firebase');
const { generateKey } = require('./license');

const LOCAL_PATH = path.join(__dirname, '..', 'data', 'customers.json');

function loadLocal() {
    try {
        if (!fs.existsSync(LOCAL_PATH)) return [];
        return JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
    } catch { return []; }
}

function saveLocal(data) {
    const dir = path.dirname(LOCAL_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCAL_PATH, JSON.stringify(data, null, 2));
}

async function listCustomers() {
    const db = getDb();
    if (db) {
        try {
            const snap = await db.collection('customers').orderBy('createdAt', 'desc').get();
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (e) { console.error('[Customers] Firestore list error:', e.message); }
    }
    return loadLocal();
}

async function getCustomer(id) {
    const db = getDb();
    if (db) {
        try {
            const doc = await db.collection('customers').doc(id).get();
            if (!doc.exists) return null;
            return { id: doc.id, ...doc.data() };
        } catch (e) { console.error('[Customers] Firestore get error:', e.message); }
    }
    return loadLocal().find(c => c.id === id) || null;
}

async function getCustomerByDiscordId(discordId) {
    const db = getDb();
    if (db) {
        try {
            const snap = await db.collection('customers').where('discordId', '==', String(discordId)).limit(1).get();
            if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
        } catch (e) { console.error('[Customers] Firestore query error:', e.message); }
    }
    return loadLocal().find(c => c.discordId === String(discordId)) || null;
}

async function getCustomerByPin(discordId, pin) {
    const normalPin = String(pin).trim().toUpperCase();
    const db = getDb();
    if (db) {
        try {
            // Single-field query (compound queries can silently fail without a composite index)
            // then filter by PIN in memory — handles multiple customers with same Discord ID too
            const snap = await db.collection('customers').where('discordId', '==', String(discordId)).get();
            if (!snap.empty) {
                const doc = snap.docs.find(d => d.data().portalPin === normalPin);
                if (doc) return { id: doc.id, ...doc.data() };
                return null;
            }
        } catch (e) { console.error('[Customers] Firestore query error:', e.message); }
    }
    const local = loadLocal();
    return local.find(c => c.discordId === String(discordId) && c.portalPin === normalPin) || null;
}

async function addCustomer({ discordId, discordTag = '', tier = 'monthly', portalPin = '' }) {
    const id = crypto.randomUUID();
    const customer = {
        id,
        discordId: String(discordId).trim(),
        discordTag: String(discordTag).trim(),
        tier,
        portalPin: String(portalPin).trim().toUpperCase() || crypto.randomBytes(3).toString('hex').toUpperCase(),
        active: true,
        currentKey: null,
        keyExpiresAt: null,
        lastKeyReset: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    try {
        const keyResult = generateKey(tier);
        customer.currentKey = keyResult.key;
        customer.keyExpiresAt = keyResult.expiresAt;
        customer.lastKeyReset = new Date().toISOString();
    } catch (e) { console.error('[Customers] Key gen on add failed:', e.message); }

    const db = getDb();
    if (db) {
        try {
            await db.collection('customers').doc(id).set(customer);
            return customer;
        } catch (e) { console.error('[Customers] Firestore add error:', e.message); }
    }

    const customers = loadLocal();
    customers.unshift(customer);
    saveLocal(customers);
    return customer;
}

async function updateCustomer(id, updates) {
    const patch = { ...updates, updatedAt: new Date().toISOString() };
    const db = getDb();
    if (db) {
        try {
            await db.collection('customers').doc(id).update(patch);
            return getCustomer(id);
        } catch (e) { console.error('[Customers] Firestore update error:', e.message); }
    }

    const customers = loadLocal();
    const idx = customers.findIndex(c => c.id === id);
    if (idx === -1) return null;
    customers[idx] = { ...customers[idx], ...patch };
    saveLocal(customers);
    return customers[idx];
}

async function deleteCustomer(id) {
    const db = getDb();
    if (db) {
        try {
            await db.collection('customers').doc(id).delete();
            return;
        } catch (e) { console.error('[Customers] Firestore delete error:', e.message); }
    }
    saveLocal(loadLocal().filter(c => c.id !== id));
}

async function getActiveSubscribers() {
    const all = await listCustomers();
    return all.filter(c => c.active);
}

module.exports = {
    listCustomers, getCustomer, getCustomerByDiscordId, getCustomerByPin,
    addCustomer, updateCustomer, deleteCustomer, getActiveSubscribers
};
