'use strict';

require('dotenv').config();

const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { Client } = require('discord.js-selfbot-v13');
const QuestManagerBridge = require('./quests/manager');
const { MessageScheduler } = require('./automation/messages');
const { AutoFeatures } = require('./automation/autoFeatures');
const { purgeOwn, sendTo, massDm } = require('./automation/utility');
const { validateKey } = require('./lib/license');
const { listCustomers, getCustomer, getCustomerByDiscordId, addCustomer, updateCustomer, deleteCustomer } = require('./lib/customers');
const { resetAllSubscriberKeys, scheduleDaily, stopSchedule, getLastReset, saveLastReset } = require('./lib/keyReset');

const app = express();
const CONFIG_PATH = path.join(__dirname, 'config.yml');
const SETTINGS_PATH = path.join(__dirname, 'data', 'settings.json');
const HISTORY_PATH = path.join(__dirname, 'data', 'quest-history.json');
const ACCOUNTS_PATH = path.join(__dirname, 'data', 'accounts.json');
const LICENSE_PATH = path.join(__dirname, 'data', 'license.json');
const isVercel = process.env.VERCEL === '1' || !!process.env.VERCEL_URL;

const DEFAULT_CONFIG = {
    token: 'PASTE_YOUR_TOKEN_HERE',
    panel_pass: 'admin',
    admin_key: 'onyxadmin',
    status: 'online',
    rpc: {
        enabled: true,
        type: 'PLAYING',
        name: 'Onyx',
        application_id: '',
        details: '',
        state: '',
        stream_url: 'https://twitch.tv/discord',
        show_elapsed: false,
        large_image: '',
        large_text: '',
        small_image: '',
        small_text: '',
        button1_text: '',
        button1_url: '',
        button2_text: '',
        button2_url: ''
    },
    custom_status: {
        enabled: false,
        text: '',
        emoji: ''
    }
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─────────────────────────────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────────────────────────────
function deepMerge(base, extra) {
    if (!extra || typeof extra !== 'object') return base;
    const out = Array.isArray(base) ? [...base] : { ...base };

    for (const [key, value] of Object.entries(extra)) {
        if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            base &&
            typeof base[key] === 'object' &&
            !Array.isArray(base[key])
        ) {
            out[key] = deepMerge(base[key], value);
        } else {
            out[key] = value;
        }
    }

    return out;
}

function ensureConfigExists() {
    if (isVercel) return false;

    if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, yaml.dump(DEFAULT_CONFIG, { lineWidth: -1 }));
        console.log('[Config] Created missing config.yml');
        return true;
    }

    return true;
}

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            if (!isVercel) ensureConfigExists();
            return deepMerge({}, DEFAULT_CONFIG);
        }

        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = yaml.load(raw) || {};
        return deepMerge(DEFAULT_CONFIG, parsed);
    } catch (e) {
        console.error('[Config] Read error:', e.message);
        return deepMerge({}, DEFAULT_CONFIG);
    }
}

function saveConfig(data) {
    if (isVercel) return;
    fs.writeFileSync(CONFIG_PATH, yaml.dump(data, { lineWidth: -1 }));
}

function getPanelPass() {
    const cfg = loadConfig();
    return cfg.panel_pass || process.env.PANEL_PASS || 'admin';
}

function getAdminKey() {
    const cfg = loadConfig();
    return cfg.admin_key || process.env.ADMIN_KEY || null;
}

function isAdminRequest(req) {
    const key = getAdminKey();
    if (!key) return req.cookies.adminAuth === 'unrestricted';
    return req.cookies.adminAuth === key;
}

// ─────────────────────────────────────────────────────────────────────────────
// License
// ─────────────────────────────────────────────────────────────────────────────
function loadLicense() {
    try {
        if (!fs.existsSync(LICENSE_PATH)) return null;
        return JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8'));
    } catch { return null; }
}

function saveLicense(data) {
    const dir = path.dirname(LICENSE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LICENSE_PATH, JSON.stringify(data, null, 2));
}

// Returns true when the panel should allow access (license valid or no secret set)
function isLicensed() {
    if (isVercel) return true;
    const stored = loadLicense();
    if (!stored?.key) return false;
    const result = validateKey(stored.key);
    return result.valid;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extended settings + quest history
// ─────────────────────────────────────────────────────────────────────────────
const SETTINGS_DEFAULTS = {
    webhookUrl: '',
    questNotifications: false,
    autoClaimQuests: false,
    presenceRotation: { enabled: false, intervalMinutes: 5, presences: [] },
    idleSpoof: { enabled: false, timeoutMinutes: 10 },
    keywordAlerts: { enabled: false, keywords: [] }
};

function loadSettings() {
    try {
        if (!fs.existsSync(SETTINGS_PATH)) return { ...SETTINGS_DEFAULTS };
        return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
    } catch { return { ...SETTINGS_DEFAULTS }; }
}

function saveSettings(data) {
    if (isVercel) return;
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
}

function loadQuestHistory() {
    try {
        if (!fs.existsSync(HISTORY_PATH)) return [];
        return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    } catch { return []; }
}

function appendQuestHistory(entry) {
    if (isVercel) return;
    const history = loadQuestHistory();
    history.unshift(entry);
    if (history.length > 200) history.splice(200);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function sendWebhook(url, payload) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return Promise.resolve();
    return new Promise((resolve) => {
        try {
            const parsedUrl = new URL(url);
            const body = JSON.stringify(payload);
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Onyx/1.5.0' }
            };
            const mod = parsedUrl.protocol === 'https:' ? https : http;
            const req = mod.request(options, (res) => { res.resume(); res.on('end', resolve); });
            req.on('error', (e) => { console.error('[Webhook]', e.message); resolve(); });
            req.write(body);
            req.end();
        } catch (e) { console.error('[Webhook]', e.message); resolve(); }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Discord presence
// ─────────────────────────────────────────────────────────────────────────────
let discordClient = null;
let clientState = 'disconnected';
let clientError = '';
let currentTag = '';
let refreshInterval = null;
let configWatcher = null;
let presenceStart = null;
let questBridge = null;
let rotationInterval = null;
let rotationIndex = 0;
let idleSpoofTimer = null;
let lastActivityTime = Date.now();

const messageScheduler = new MessageScheduler(() => discordClient);
const autoFeatures = new AutoFeatures();

function isHttpUrl(u) {
    return typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://'));
}

function buildPresence(cfg) {
    const rpc = cfg.rpc || {};
    const activities = [];

    if (rpc.enabled === false) {
        return { status: cfg.status || 'online', activities };
    }

    const act = {
        type: (rpc.type || 'PLAYING').toUpperCase(),
        name: rpc.name || 'Onyx'
    };

    if (rpc.application_id) act.application_id = String(rpc.application_id);
    if (rpc.details) act.details = rpc.details;
    if (rpc.state) act.state = rpc.state;

    const assets = {};
    if (rpc.large_image) {
        assets.large_image = rpc.large_image;
        if (rpc.large_text) assets.large_text = rpc.large_text;
    }
    if (rpc.small_image) {
        assets.small_image = rpc.small_image;
        if (rpc.small_text) assets.small_text = rpc.small_text;
    }
    if (Object.keys(assets).length) act.assets = assets;

    const buttons = [];
    const buttonUrls = [];

    if (rpc.button1_text && isHttpUrl(rpc.button1_url)) {
        buttons.push(rpc.button1_text);
        buttonUrls.push(rpc.button1_url);
    }
    if (rpc.button2_text && isHttpUrl(rpc.button2_url)) {
        buttons.push(rpc.button2_text);
        buttonUrls.push(rpc.button2_url);
    }

    if (buttons.length) {
        act.buttons = buttons;
        act.metadata = { button_urls: buttonUrls };
    }

    if (rpc.show_elapsed) {
        act.timestamps = { start: presenceStart || Date.now() };
    }

    activities.push(act);

    // Custom status (the line under your username) — separate activity
    const custom = cfg.custom_status || {};
    if (custom.enabled && (custom.text || custom.emoji)) {
        const customAct = {
            type: 'CUSTOM',
            name: 'Custom Status',
            state: custom.text || ' '
        };
        if (custom.emoji) {
            const m = /<(a)?:(\w+):(\d+)>/.exec(custom.emoji);
            customAct.emoji = m
                ? { name: m[2], id: m[3], animated: !!m[1] }
                : { name: custom.emoji, id: null, animated: false };
        }
        activities.push(customAct);
    }

    return { status: cfg.status || 'online', activities };
}

async function applyPresence() {
    if (!discordClient || clientState !== 'connected') return;

    try {
        const cfg = loadConfig();
        await discordClient.user.setPresence(buildPresence(cfg));
        console.log('[RPC] Presence updated');
    } catch (e) {
        console.error('[RPC] Presence error:', e.message);
    }
}

async function applyGameSpoof(appId, appName) {
    if (!discordClient || clientState !== 'connected') return;
    try {
        const cfg = loadConfig();
        const spoofedCfg = {
            ...cfg,
            rpc: { ...cfg.rpc, enabled: true, type: 'PLAYING', name: appName, application_id: appId }
        };
        await discordClient.user.setPresence(buildPresence(spoofedCfg));
        console.log(`[RPC] Game spoofed: ${appName} (${appId})`);
    } catch (e) {
        console.error('[RPC] Game spoof error:', e.message);
    }
}

function startPresenceRotation(presences, intervalMs) {
    if (rotationInterval) { clearInterval(rotationInterval); rotationInterval = null; }
    if (!presences || presences.length < 2) return;
    rotationIndex = 0;
    rotationInterval = setInterval(async () => {
        if (!discordClient || clientState !== 'connected') return;
        rotationIndex = (rotationIndex + 1) % presences.length;
        const p = presences[rotationIndex];
        try {
            const cfg = loadConfig();
            const merged = { ...cfg, rpc: { ...cfg.rpc, ...p, enabled: true } };
            await discordClient.user.setPresence(buildPresence(merged));
        } catch (e) {}
    }, Math.max(30000, intervalMs));
    console.log(`[Rotation] Started — ${presences.length} presences, ${Math.round(intervalMs / 60000)}m interval`);
}

function stopPresenceRotation() {
    if (rotationInterval) { clearInterval(rotationInterval); rotationInterval = null; }
    rotationIndex = 0;
}

function startIdleSpoofTimer(timeoutMs) {
    stopIdleSpoofTimer();
    lastActivityTime = Date.now();
    idleSpoofTimer = setInterval(async () => {
        if (!discordClient || clientState !== 'connected') return;
        if (Date.now() - lastActivityTime >= timeoutMs) {
            try {
                const cfg = loadConfig();
                const p = buildPresence(cfg);
                p.status = 'idle';
                await discordClient.user.setPresence(p);
            } catch (e) {}
        }
    }, 60000);
}

function stopIdleSpoofTimer() {
    if (idleSpoofTimer) { clearInterval(idleSpoofTimer); idleSpoofTimer = null; }
}

function resetActivityTime() {
    lastActivityTime = Date.now();
}

function stopClient() {
    stopPresenceRotation();
    stopIdleSpoofTimer();
    try { stopSchedule(); } catch {}
    try { messageScheduler.stop(); } catch {}
    try { autoFeatures.unbind(); } catch {}

    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }

    if (configWatcher) {
        try {
            configWatcher.close();
        } catch {}
        configWatcher = null;
    }

    if (discordClient) {
        try {
            discordClient.destroy();
        } catch {}
        discordClient = null;
    }

    clientState = 'disconnected';
    clientError = '';
    currentTag = '';
    presenceStart = null;
}

async function connectClient(token) {
    if (isVercel) return;

    stopClient();

    clientState = 'connecting';
    clientError = '';
    discordClient = new Client({ checkUpdate: false });

    discordClient.once('ready', async () => {
        clientState = 'connected';
        currentTag = discordClient.user?.tag || '';
        presenceStart = Date.now();

        console.log(`[RPC] Logged in as ${currentTag}`);

        await applyPresence();

        try { messageScheduler.initialize(); } catch (e) { console.error('[Messages] init:', e.message); }
        try {
            const settings = loadSettings();
            autoFeatures.setWebhookFn((payload) => sendWebhook(settings.webhookUrl, payload));
            autoFeatures.bind(discordClient);
        } catch (e) { console.error('[Auto] bind:', e.message); }

        // Start presence rotation / idle spoof from saved settings
        try {
            const settings = loadSettings();
            if (settings.presenceRotation?.enabled && settings.presenceRotation.presences?.length >= 2) {
                startPresenceRotation(settings.presenceRotation.presences, (settings.presenceRotation.intervalMinutes || 5) * 60000);
            }
            if (settings.idleSpoof?.enabled) {
                startIdleSpoofTimer((settings.idleSpoof.timeoutMinutes || 10) * 60000);
            }
        } catch (e) { console.error('[Settings] startup:', e.message); }

        try { scheduleDaily(discordClient); } catch (e) { console.error('[KeyReset] Schedule error:', e.message); }

        refreshInterval = setInterval(() => {
            applyPresence().catch(() => {});
        }, 5 * 60 * 1000);

        if (fs.existsSync(CONFIG_PATH)) {
            configWatcher = fs.watch(CONFIG_PATH, async (event) => {
                if (event === 'change') {
                    await applyPresence();
                }
            });
        }
    });

    discordClient.on('error', (err) => {
        clientError = err.message;
        console.error('[RPC] Client error:', clientError);
    });

    try {
        await discordClient.login(token);
    } catch (e) {
        clientState = 'error';
        clientError = e.message;
        console.error('[RPC] Login error:', e.message);
    }
}

function getQuestBridge() {
    if (clientState !== 'connected') return null;
    const cfg = loadConfig();
    const token = (cfg.token || '').trim().replace(/^["']|["']$/g, '');
    questBridge = new QuestManagerBridge(token);

    questBridge.setGameSpoofCallback(async (appId, appName) => {
        resetActivityTime();
        if (appId && appName) await applyGameSpoof(appId, appName);
        else await applyPresence();
    });

    questBridge.setQuestCompleteCallback(async ({ id, name, appId, success, completedAt }) => {
        const settings = loadSettings();
        appendQuestHistory({ id, name, appId, success, completedAt });

        if (success && settings.autoClaimQuests) {
            try {
                await questBridge?.client?.rest?.post(`/quests/${id}/claim-rewards`, { body: {} });
                console.log(`[Quests] Auto-claimed rewards for ${name}`);
            } catch (e) { console.error('[Quests] Auto-claim error:', e.message); }
        }

        if (success && settings.questNotifications && settings.webhookUrl) {
            await sendWebhook(settings.webhookUrl, {
                username: 'Onyx',
                embeds: [{
                    title: '✅ Quest Completed',
                    description: `**${name}** has been completed`,
                    fields: [{ name: 'Game', value: name, inline: true }, { name: 'Time', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true }],
                    color: 0x06b6d4,
                    timestamp: completedAt
                }]
            });
        }
    });

    return questBridge;
}

// ─────────────────────────────────────────────────────────────────────────────
// API Routes
// ─────────────────────────────────────────────────────────────────────────────
// Reset idle timer on any authenticated API activity
app.use('/api', (req, res, next) => { resetActivityTime(); next(); });

// ─────────────────────────────────────────────────────────────────────────────
// License routes (must be before auth middleware)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/activate', (req, res) => {
    if (isVercel || !process.env.LICENSE_SECRET) return res.redirect('/panel');
    if (isLicensed()) return res.redirect('/panel');
    res.render('activate');
});

app.post('/api/activate', (req, res) => {
    if (isVercel) return res.json({ success: true, tier: 'Unlimited', daysLeft: null });
    try {
        const { key } = req.body || {};
        if (!key) return res.json({ success: false, error: 'No key provided' });
        const result = validateKey(key);
        if (!result.valid) return res.json({ success: false, error: result.error || 'Invalid or expired key' });
        saveLicense({
            key: result.key,
            tier: result.tier,
            tierCode: result.tierCode,
            expiresAt: result.expiresAt,
            activatedAt: new Date().toISOString()
        });
        res.json({ success: true, tier: result.tier, daysLeft: result.daysLeft });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/license', (req, res) => {
    if (isVercel || !process.env.LICENSE_SECRET) {
        return res.json({ success: true, licensed: true, tier: 'Unrestricted', devMode: true });
    }
    const stored = loadLicense();
    if (!stored) return res.json({ success: true, licensed: false });
    const result = validateKey(stored.key);
    res.json({
        success: true,
        licensed: result.valid,
        tier: result.tier,
        tierCode: result.tierCode,
        expiresAt: result.expiresAt,
        daysLeft: result.daysLeft,
        expired: result.expired,
        activatedAt: stored.activatedAt,
        keyPreview: stored.key ? stored.key.slice(0, 14) + '…' : null
    });
});

app.post('/api/license/deactivate', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        if (fs.existsSync(LICENSE_PATH)) fs.unlinkSync(LICENSE_PATH);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// License gate — redirect unlicensed users to /activate
app.use((req, res, next) => {
    if (isVercel || !process.env.LICENSE_SECRET) return next();
    const skip = req.path === '/activate' || req.path === '/api/activate' ||
                 req.path === '/login' || req.path.startsWith('/api/login') || req.path.startsWith('/public') ||
                 req.path === '/portal' || req.path.startsWith('/api/portal');
    if (skip) return next();
    if (!isLicensed()) return res.redirect('/activate');
    next();
});

app.get('/login', (req, res) => {
    if (isVercel) return res.redirect('/');
    res.render('login', { hasAdminKey: !!getAdminKey() });
});

app.post('/api/login', (req, res) => {
    const { password, licenseKey } = req.body || {};
    if (password !== getPanelPass()) return res.json({ success: false, error: 'Invalid password' });
    const cookieOpts = { maxAge: 86400000, httpOnly: true };
    res.cookie('auth', password, cookieOpts);
    const adminKey = getAdminKey();
    if (adminKey) {
        if (licenseKey && licenseKey.trim() !== adminKey) {
            return res.json({ success: false, error: 'Invalid admin key' });
        }
        if (licenseKey && licenseKey.trim() === adminKey) {
            res.cookie('adminAuth', adminKey, cookieOpts);
        }
    } else {
        res.cookie('adminAuth', 'unrestricted', cookieOpts);
    }
    res.json({ success: true });
});

app.use((req, res, next) => {
    if (isVercel || req.path === '/login' || req.path.startsWith('/api/login') || req.path.startsWith('/public') ||
        req.path === '/portal' || req.path.startsWith('/api/portal')) return next();
    const auth = req.cookies.auth;
    if (auth === getPanelPass()) return next();
    res.redirect('/login');
});

app.get('/api/config', (req, res) => {
    res.json({ success: true, config: loadConfig() });
});

app.post('/api/config', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });

    try {
        const current = loadConfig();
        if (req.body && typeof req.body.token === 'string') {
            req.body.token = req.body.token.trim().replace(/^["']|["']$/g, '');
        }
        const updated = deepMerge(current, req.body || {});
        saveConfig(updated);
        
        if (req.body && req.body.token !== undefined && req.body.token !== current.token) {
            if (clientState === 'connected' || clientState === 'connecting' || clientState === 'error') {
                await connectClient(updated.token);
            }
        } else {
            await applyPresence();
        }
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/start', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });

    try {
        const cfg = loadConfig();
        if (!cfg.token || cfg.token === 'PASTE_YOUR_TOKEN_HERE') {
            return res.json({ success: false, error: 'Token not set' });
        }

        let token = cfg.token.trim().replace(/^["']|["']$/g, '');
        questBridge = null;
        await connectClient(token);

        setTimeout(() => {
            res.json({
                success: clientState !== 'error',
                state: clientState,
                error: clientError,
                tag: currentTag
            });
        }, 3500);
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/status', (req, res) => {
    if (isVercel) return res.json({ state: 'disconnected', error: '', tag: '' });
    res.json({ state: clientState, error: clientError, tag: currentTag });
});

app.post('/api/stop', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });

    stopClient();
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Messaging — scheduled (one-time) and recurring (interval)
// ─────────────────────────────────────────────────────────────────────────────
function requireConnected(res) {
    if (!discordClient || clientState !== 'connected') {
        res.json({ success: false, error: 'Discord client not connected' });
        return false;
    }
    return true;
}

app.get('/api/messages', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    res.json({ success: true, ...messageScheduler.list() });
});

app.post('/api/messages/scheduled', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    if (!requireConnected(res)) return;
    try {
        const entry = messageScheduler.addScheduled(req.body || {});
        res.json({ success: true, entry });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.delete('/api/messages/scheduled/:id', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    messageScheduler.removeScheduled(req.params.id);
    res.json({ success: true });
});

app.post('/api/messages/recurring', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    if (!requireConnected(res)) return;
    try {
        const entry = messageScheduler.addRecurring(req.body || {});
        res.json({ success: true, entry });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.delete('/api/messages/recurring/:id', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    messageScheduler.removeRecurring(req.params.id);
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto features (AFK / auto-react / auto-reply)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/auto', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    res.json({ success: true, config: autoFeatures.config() });
});

app.post('/api/auto', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        const next = autoFeatures.update(req.body || {});
        res.json({ success: true, config: next });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Utility — purge / dm / massdm
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/util/purge', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    if (!requireConnected(res)) return;
    try {
        const { channelId, count } = req.body || {};
        if (!channelId) return res.json({ success: false, error: 'channelId required' });
        const deleted = await purgeOwn(discordClient, channelId, count || 10);
        res.json({ success: true, deleted });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/util/send', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    if (!requireConnected(res)) return;
    try {
        const { targetId, message } = req.body || {};
        if (!targetId || !message) return res.json({ success: false, error: 'targetId and message required' });
        await sendTo(discordClient, targetId, message);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/util/massdm', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    if (!requireConnected(res)) return;
    try {
        const { ids, message, delayMs } = req.body || {};
        if (!Array.isArray(ids) || ids.length === 0 || !message) {
            return res.json({ success: false, error: 'ids[] and message required' });
        }
        const result = await massDm(discordClient, ids, message, Math.max(1000, parseInt(delayMs, 10) || 1500));
        res.json({ success: true, ...result });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Updates feed (consumed by landing page)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/updates', (req, res) => {
    try {
        const file = path.join(__dirname, 'data', 'updates.json');
        const raw = fs.readFileSync(file, 'utf8');
        res.type('application/json').send(raw);
    } catch (e) {
        res.json({ updates: [] });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Quest API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/quests', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });

    const bridge = getQuestBridge();
    if (!bridge) return res.json({ success: false, error: 'Not connected — set a token first' });

    try {
        const quests = await bridge.fetchQuests();
        res.json({ success: true, quests });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/quests/start', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });

    const bridge = getQuestBridge();
    if (!bridge) return res.json({ success: false, error: 'Not connected — set a token first' });
    if (bridge.isRunning) return res.json({ success: false, error: 'Quests already running' });

    const { questId } = req.body || {};
    res.json({ success: true });

    if (questId) bridge.startOne(questId).catch(() => {});
    else bridge.startAll().catch(() => {});
});

app.post('/api/quests/stop', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });

    if (questBridge) questBridge.stopAll();
    res.json({ success: true });
});

app.get('/api/quests/status', (req, res) => {
    if (isVercel) return res.json({ isRunning: false, currentQuest: null, logs: [] });

    const bridge = questBridge;
    res.json({
        isRunning: bridge?.isRunning || false,
        currentQuest: bridge?.currentQuestInfo || null,
        logs: bridge?.globalLogs || []
    });
});

app.post('/api/quests/clear-logs', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });

    if (questBridge) questBridge.clearLogs();
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Token validator
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/validate-token', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        const cfg = loadConfig();
        const token = (cfg.token || '').trim().replace(/^["']|["']$/g, '');
        if (!token || token === 'PASTE_YOUR_TOKEN_HERE') {
            return res.json({ success: false, error: 'No token configured' });
        }
        const result = await new Promise((resolve) => {
            const options = {
                hostname: 'discord.com',
                path: '/api/v10/users/@me',
                method: 'GET',
                headers: { 'Authorization': token, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            };
            const req2 = https.request(options, (r) => {
                let data = '';
                r.on('data', c => data += c);
                r.on('end', () => resolve({ status: r.statusCode, body: data }));
            });
            req2.on('error', (e) => resolve({ status: 0, body: e.message }));
            req2.end();
        });
        if (result.status === 200) {
            const user = JSON.parse(result.body);
            res.json({ success: true, user: { id: user.id, username: user.username, discriminator: user.discriminator, avatar: user.avatar } });
        } else {
            res.json({ success: false, error: `HTTP ${result.status}` });
        }
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Extended settings
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
    if (isVercel) return res.json(SETTINGS_DEFAULTS);
    res.json({ success: true, settings: loadSettings() });
});

app.post('/api/settings', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        const current = loadSettings();
        const updated = { ...current, ...req.body };
        saveSettings(updated);

        // Apply rotation changes immediately
        stopPresenceRotation();
        if (updated.presenceRotation?.enabled && updated.presenceRotation.presences?.length >= 2 && clientState === 'connected') {
            startPresenceRotation(updated.presenceRotation.presences, (updated.presenceRotation.intervalMinutes || 5) * 60000);
        }

        // Apply idle spoof changes
        stopIdleSpoofTimer();
        if (updated.idleSpoof?.enabled && clientState === 'connected') {
            startIdleSpoofTimer((updated.idleSpoof.timeoutMinutes || 10) * 60000);
        }

        // Update webhook in autoFeatures
        autoFeatures.setWebhookFn((payload) => sendWebhook(updated.webhookUrl, payload));

        res.json({ success: true, settings: updated });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Quest history
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/quests/history', (req, res) => {
    if (isVercel) return res.json({ success: true, history: [] });
    res.json({ success: true, history: loadQuestHistory() });
});

app.delete('/api/quests/history', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        fs.writeFileSync(HISTORY_PATH, '[]');
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard stats
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
    if (isVercel) return res.json({ state: 'disconnected', questsToday: 0, questsTotal: 0 });
    const history = loadQuestHistory();
    const today = new Date().toDateString();
    const questsToday = history.filter(h => h.success && new Date(h.completedAt).toDateString() === today).length;
    const questsTotal = history.filter(h => h.success).length;
    let ping = null;
    let avatar = null;
    let userId = null;
    if (discordClient && clientState === 'connected') {
        ping = discordClient.ws.ping || null;
        try { avatar = discordClient.user?.displayAvatarURL({ format: 'png', size: 128 }); } catch {}
        userId = discordClient.user?.id || null;
    }
    res.json({
        success: true, state: clientState, tag: currentTag, userId, avatar,
        uptimeMs: presenceStart ? Date.now() - presenceStart : 0,
        ping, questsToday, questsTotal,
        recentHistory: history.slice(0, 5)
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// DM Inbox
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/dms', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    if (!requireConnected(res)) return;
    try {
        const dmChannels = discordClient.channels.cache.filter(c => c.type === 'DM');
        const result = [];
        for (const [, channel] of dmChannels) {
            const recipient = channel.recipient;
            if (!recipient) continue;
            let lastMessage = null;
            try {
                const msgs = await channel.messages.fetch({ limit: 1 });
                const msg = msgs.first();
                if (msg) lastMessage = { id: msg.id, content: msg.content.slice(0, 100), authorId: msg.author.id, timestamp: msg.createdTimestamp };
            } catch {}
            result.push({
                id: channel.id,
                recipientId: recipient.id,
                recipientName: recipient.username,
                recipientAvatar: (() => { try { return recipient.displayAvatarURL({ format: 'png', size: 64 }); } catch { return null; } })(),
                lastMessage
            });
        }
        result.sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
        res.json({ success: true, channels: result.slice(0, 60) });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/dms/:channelId/messages', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    if (!requireConnected(res)) return;
    try {
        const channel = await discordClient.channels.fetch(req.params.channelId);
        if (!channel || channel.type !== 'DM') return res.json({ success: false, error: 'Channel not found' });
        const msgs = await channel.messages.fetch({ limit: 50 });
        const messages = msgs.map(m => ({
            id: m.id,
            content: m.content,
            authorId: m.author.id,
            authorName: m.author.username,
            authorAvatar: (() => { try { return m.author.displayAvatarURL({ format: 'png', size: 32 }); } catch { return null; } })(),
            timestamp: m.createdTimestamp,
            isSelf: m.author.id === discordClient.user.id
        })).sort((a, b) => a.timestamp - b.timestamp);
        res.json({ success: true, messages, selfId: discordClient.user.id });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/dms/:channelId/send', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    if (!requireConnected(res)) return;
    try {
        const { message } = req.body || {};
        if (!message) return res.json({ success: false, error: 'message required' });
        const channel = await discordClient.channels.fetch(req.params.channelId);
        if (!channel) return res.json({ success: false, error: 'Channel not found' });
        const sent = await channel.send(message);
        res.json({ success: true, messageId: sent.id });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Server browser
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/servers', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    if (!requireConnected(res)) return;
    try {
        const guilds = discordClient.guilds.cache.map(g => ({
            id: g.id,
            name: g.name,
            icon: (() => { try { return g.iconURL({ format: 'png', size: 64 }); } catch { return null; } })(),
            memberCount: g.memberCount,
            ownerId: g.ownerId,
            isOwner: g.ownerId === discordClient.user.id,
            joinedAt: g.joinedTimestamp
        })).sort((a, b) => a.name.localeCompare(b.name));
        res.json({ success: true, guilds, total: guilds.length });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-account
// ─────────────────────────────────────────────────────────────────────────────
function loadAccounts() {
    try {
        if (!fs.existsSync(ACCOUNTS_PATH)) return [];
        return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
    } catch { return []; }
}

function saveAccounts(accounts) {
    if (isVercel) return;
    const dir = path.dirname(ACCOUNTS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2));
}

app.get('/api/accounts', (req, res) => {
    if (isVercel) return res.json({ success: true, accounts: [] });
    const accounts = loadAccounts().map(a => ({
        id: a.id, nickname: a.nickname, active: a.active, addedAt: a.addedAt,
        tokenPreview: a.token ? a.token.slice(0, 12) + '…' : ''
    }));
    res.json({ success: true, accounts });
});

app.post('/api/accounts', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    const { nickname, token } = req.body || {};
    if (!nickname || !token) return res.json({ success: false, error: 'nickname and token required' });
    const accounts = loadAccounts();
    const id = crypto.randomUUID();
    if (accounts.length === 0) {
        // First account auto-becomes active
        accounts.push({ id, nickname, token: token.trim(), addedAt: new Date().toISOString(), active: true });
    } else {
        accounts.push({ id, nickname, token: token.trim(), addedAt: new Date().toISOString(), active: false });
    }
    saveAccounts(accounts);
    res.json({ success: true, id });
});

app.delete('/api/accounts/:id', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    const accounts = loadAccounts().filter(a => a.id !== req.params.id);
    saveAccounts(accounts);
    res.json({ success: true });
});

app.post('/api/accounts/switch', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    const { id } = req.body || {};
    const accounts = loadAccounts();
    const account = accounts.find(a => a.id === id);
    if (!account) return res.json({ success: false, error: 'Account not found' });
    accounts.forEach(a => { a.active = a.id === id; });
    saveAccounts(accounts);
    const cfg = loadConfig();
    cfg.token = account.token;
    saveConfig(cfg);
    await connectClient(account.token);
    setTimeout(() => {
        res.json({ success: clientState !== 'error', state: clientState, tag: currentTag, error: clientError });
    }, 3500);
});

// ─────────────────────────────────────────────────────────────────────────────
// Config backup & restore
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/backup', (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        const backup = {
            _version: '1.6.0',
            _exportedAt: new Date().toISOString(),
            config: loadConfig(),
            settings: loadSettings(),
            autoFeatures: autoFeatures.config(),
            messages: messageScheduler.list(),
            questHistory: loadQuestHistory()
        };
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="onyx-backup-${Date.now()}.json"`);
        res.send(JSON.stringify(backup, null, 2));
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/restore', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        const data = req.body;
        const restored = [];
        if (data.config) { saveConfig({ ...loadConfig(), ...data.config }); restored.push('config'); }
        if (data.settings) { saveSettings({ ...loadSettings(), ...data.settings }); restored.push('settings'); }
        if (data.autoFeatures) { autoFeatures.update(data.autoFeatures); restored.push('automation'); }
        if (restored.includes('config') && clientState === 'connected') await applyPresence();
        res.json({ success: true, restored });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Customer admin — requires admin key cookie
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/admin', (req, res, next) => {
    if (!isAdminRequest(req)) return res.status(403).json({ success: false, error: 'Admin access required' });
    next();
});

app.get('/api/admin/customers', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        const customers = await listCustomers();
        res.json({ success: true, customers, lastReset: getLastReset() || null });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/admin/customers', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        const { discordId, discordTag, tier, portalPin } = req.body || {};
        if (!discordId) return res.json({ success: false, error: 'discordId required' });
        const customer = await addCustomer({ discordId, discordTag, tier, portalPin });
        res.json({ success: true, customer });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.patch('/api/admin/customers/:id', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        const allowed = ['active', 'discordTag', 'tier', 'portalPin'];
        const updates = {};
        for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
        const customer = await updateCustomer(req.params.id, updates);
        res.json({ success: true, customer });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/admin/customers/:id', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        await deleteCustomer(req.params.id);
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/admin/customers/:id/dm-key', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    if (!requireConnected(res)) return;
    try {
        const customer = await getCustomer(req.params.id);
        if (!customer) return res.json({ success: false, error: 'Customer not found' });
        if (!customer.currentKey) return res.json({ success: false, error: 'No key assigned yet — reset keys first' });
        const user = await discordClient.users.fetch(customer.discordId);
        const dm = await user.createDM();
        const expStr = customer.keyExpiresAt ? new Date(customer.keyExpiresAt).toDateString() : 'Never';
        await dm.send(
            `🔑 **Your Onyx key!**\n\`\`\`\n${customer.currentKey}\n\`\`\`` +
            `\n⏰ Valid until: **${expStr}**\n\nActivate at your panel → \`/activate\``
        );
        res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/admin/keys/reset', async (req, res) => {
    if (isVercel) return res.status(403).json({ success: false, error: 'Access Denied' });
    try {
        const result = await resetAllSubscriberKeys(discordClient);
        if (result.count > 0 || result.total > 0) saveLastReset();
        res.json({ success: true, ...result });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Customer portal (public — no auth)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/portal', (req, res) => {
    res.render('portal');
});

app.post('/api/portal/key', async (req, res) => {
    try {
        const { discordId, portalPin } = req.body || {};
        if (!discordId || !portalPin) return res.json({ success: false, error: 'Discord ID and PIN required' });
        const customer = await getCustomerByDiscordId(discordId.trim());
        if (!customer) return res.json({ success: false, error: 'Customer not found — check your Discord ID' });
        if (customer.portalPin !== portalPin.trim().toUpperCase()) return res.json({ success: false, error: 'Invalid PIN' });
        if (!customer.active) return res.json({ success: false, error: 'Your subscription is not active' });
        if (!customer.currentKey) return res.json({ success: false, error: 'No key assigned yet — contact your seller' });
        const expiry = customer.keyExpiresAt ? new Date(customer.keyExpiresAt) : null;
        if (expiry && Date.now() > expiry.getTime()) {
            return res.json({ success: false, error: 'Your key has expired — wait for the next daily reset' });
        }
        res.json({ success: true, key: customer.currentKey, tier: customer.tier, expiresAt: customer.keyExpiresAt });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pages
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    if (isVercel) {
        res.sendFile(path.join(__dirname, 'landing.html'));
    } else {
        const auth = req.cookies.auth;
        if (auth === getPanelPass()) {
            res.redirect('/panel');
        } else {
            res.redirect('/login');
        }
    }
});

app.get('/panel', (req, res) => {
    if (isVercel) {
        return res.status(403).send('Access Denied');
    }

    res.render('index', { isAdmin: isAdminRequest(req) });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;

if (!isVercel) {
    app.listen(PORT, async () => {
        console.log(`[Onyx] Panel running on port ${PORT}  password: ${getPanelPass()}`);

        // Auto-connect if a valid token is configured
        const cfg = loadConfig();
        const token = (cfg.token || '').trim().replace(/^["']|["']$/g, '');
        if (token && token !== 'PASTE_YOUR_TOKEN_HERE') {
            console.log('[Onyx] Token found — auto-connecting...');
            await connectClient(token);
        }
    });
}

// Vercel may still load the file, but it should not try to hold a server open.
module.exports = app;

process.on('SIGINT', () => {
    if (refreshInterval) clearInterval(refreshInterval);
    if (configWatcher) {
        try {
            configWatcher.close();
        } catch {}
    }
    if (discordClient) {
        try {
            discordClient.destroy();
        } catch {}
    }
    process.exit(0);
});
