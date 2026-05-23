'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'auto.json');

const DEFAULTS = {
    afk: {
        enabled: false,
        message: "I'm AFK right now — I'll get back to you soon.",
        cooldownMs: 5 * 60 * 1000
    },
    autoReact: {
        enabled: false,
        userTriggers: {},
        textTriggers: {}
    },
    autoReply: {
        enabled: false,
        rules: [],
        cooldownMs: 0
    },
    keywordAlerts: {
        enabled: false,
        keywords: []
    }
};

function ensureDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
    ensureDir();
    if (!fs.existsSync(FILE)) return JSON.parse(JSON.stringify(DEFAULTS));
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return {
            afk: { ...DEFAULTS.afk, ...raw.afk },
            autoReact: { ...DEFAULTS.autoReact, ...raw.autoReact },
            autoReply: { ...DEFAULTS.autoReply, ...raw.autoReply },
            keywordAlerts: { ...DEFAULTS.keywordAlerts, ...raw.keywordAlerts }
        };
    } catch {
        return JSON.parse(JSON.stringify(DEFAULTS));
    }
}

function save(data) {
    ensureDir();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

class AutoFeatures {
    constructor(log) {
        this.log = log || ((m) => console.log('[Auto]', m));
        this.client = null;
        this._afkLastReplied = new Map();
        this._replyLastSent = new Map();
        this._handler = null;
        this.webhookFn = null;
    }

    setWebhookFn(fn) {
        this.webhookFn = fn;
    }

    config() { return load(); }

    update(patch) {
        const cur = load();
        const next = {
            afk: { ...cur.afk, ...(patch.afk || {}) },
            autoReact: { ...cur.autoReact, ...(patch.autoReact || {}) },
            autoReply: { ...cur.autoReply, ...(patch.autoReply || {}) },
            keywordAlerts: { ...cur.keywordAlerts, ...(patch.keywordAlerts || {}) }
        };
        if (patch.afk === undefined && patch.autoReact === undefined && patch.autoReply === undefined && patch.keywordAlerts === undefined) {
            Object.assign(next, patch);
        }
        save(next);
        return next;
    }

    bind(client) {
        this.unbind();
        this.client = client;
        if (!client) return;

        this._handler = async (message) => {
            try {
                if (!message || !message.author) return;
                if (message.author.id === client.user?.id) return;

                const cfg = load();
                const text = message.content || '';
                const lower = text.toLowerCase();
                const isDM = !message.guild;
                const mentioned = message.mentions?.users?.has?.(client.user.id);

                // Auto-react on user/keyword triggers
                if (cfg.autoReact?.enabled) {
                    const userEmojis = cfg.autoReact.userTriggers?.[message.author.id];
                    if (Array.isArray(userEmojis)) {
                        for (const e of userEmojis) await message.react(e).catch(() => {});
                    }
                    for (const [kw, emojis] of Object.entries(cfg.autoReact.textTriggers || {})) {
                        if (!kw) continue;
                        if (lower.includes(kw.toLowerCase())) {
                            for (const e of (emojis || [])) await message.react(e).catch(() => {});
                        }
                    }
                }

                // Auto-reply with per-user cooldown (DM or mention only)
                if (cfg.autoReply?.enabled && (isDM || mentioned)) {
                    for (const rule of (cfg.autoReply.rules || [])) {
                        if (!rule?.match) continue;
                        const m = String(rule.match).toLowerCase();
                        const hit = rule.exact ? lower === m : lower.includes(m);
                        if (hit) {
                            const cooldownMs = cfg.autoReply.cooldownMs || 0;
                            if (cooldownMs > 0) {
                                const last = this._replyLastSent.get(message.author.id) || 0;
                                if (Date.now() - last < cooldownMs) break;
                            }
                            await message.channel.send(String(rule.reply || '')).catch(() => {});
                            this._replyLastSent.set(message.author.id, Date.now());
                            break;
                        }
                    }
                }

                // AFK auto-responder (DMs only, per-user cooldown)
                if (cfg.afk?.enabled && isDM) {
                    const now = Date.now();
                    const last = this._afkLastReplied.get(message.author.id) || 0;
                    if (now - last > (cfg.afk.cooldownMs || 300000)) {
                        this._afkLastReplied.set(message.author.id, now);
                        await message.channel.send(cfg.afk.message || "I'm AFK.").catch(() => {});
                    }
                }

                // Keyword mention alerts → webhook
                if (cfg.keywordAlerts?.enabled && this.webhookFn) {
                    for (const kw of (cfg.keywordAlerts.keywords || [])) {
                        if (!kw) continue;
                        if (lower.includes(kw.toLowerCase())) {
                            await this.webhookFn({
                                username: 'Onyx Alerts',
                                embeds: [{
                                    title: '🔔 Keyword Alert',
                                    description: `**"${kw}"** was mentioned`,
                                    fields: [
                                        { name: 'Author', value: `${message.author.username}`, inline: true },
                                        { name: 'Channel', value: message.channel?.name || 'DM', inline: true },
                                        { name: 'Message', value: text.slice(0, 500) || ' ' }
                                    ],
                                    color: 0x06b6d4,
                                    timestamp: new Date().toISOString()
                                }]
                            }).catch(() => {});
                            break;
                        }
                    }
                }
            } catch (e) {
                this.log(`handler error: ${e.message}`);
            }
        };

        client.on('messageCreate', this._handler);
    }

    unbind() {
        if (this.client && this._handler) {
            try { this.client.off('messageCreate', this._handler); } catch {}
        }
        this.client = null;
        this._handler = null;
    }
}

module.exports = { AutoFeatures };
