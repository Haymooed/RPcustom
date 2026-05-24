'use strict';

const GIFT_REGEX = /discord(?:app)?\.com\/gifts\/([A-Za-z0-9]+)|discord\.gift\/([A-Za-z0-9]+)/g;

class NitroSniper {
    constructor() {
        this.enabled = false;
        this.log = [];
        this.stats = { attempts: 0, success: 0, invalid: 0, used: 0 };
        this._listener = null;
    }

    attach(client) {
        this._listener = (message) => {
            if (!this.enabled) return;
            const content = message.content || '';
            const matches = new Set();
            let m;
            GIFT_REGEX.lastIndex = 0;
            while ((m = GIFT_REGEX.exec(content)) !== null) {
                const code = m[1] || m[2];
                if (code) matches.add(code);
            }
            // Also scan embeds
            for (const embed of (message.embeds || [])) {
                const text = [embed.url, embed.description, embed.title].filter(Boolean).join(' ');
                GIFT_REGEX.lastIndex = 0;
                while ((m = GIFT_REGEX.exec(text)) !== null) {
                    const code = m[1] || m[2];
                    if (code) matches.add(code);
                }
            }
            for (const code of matches) {
                this.redeem(code, message, client).catch(() => {});
            }
        };
        client.on('messageCreate', this._listener);
        this._client = client;
    }

    async redeem(code, message, client) {
        this.stats.attempts++;
        const start = Date.now();
        const server = message.guild?.name || message.channel?.recipient?.username || 'DM';
        const time = new Date().toLocaleTimeString();
        let icon, result, type;
        try {
            const res = await fetch(`https://discord.com/api/v9/entitlements/gift-codes/${code}/redeem`, {
                method: 'POST',
                headers: {
                    'Authorization': client.token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({})
            });
            const latency = Date.now() - start;
            if (res.status === 200) {
                this.stats.success++;
                icon = '✅';
                result = `Redeemed in ${latency}ms`;
                type = 'success';
            } else {
                let body = {};
                try { body = await res.json(); } catch {}
                const errCode = body?.code;
                if (errCode === 50050) {
                    this.stats.used++;
                    icon = '🔁';
                    result = `Already used (${latency}ms)`;
                    type = 'used';
                } else if (errCode === 10038) {
                    this.stats.invalid++;
                    icon = '❌';
                    result = `Invalid code (${latency}ms)`;
                    type = 'invalid';
                } else {
                    icon = '⚠️';
                    result = `Error ${res.status}${errCode ? ` (${errCode})` : ''} (${latency}ms)`;
                    type = 'error';
                }
            }
        } catch (err) {
            icon = '⚠️';
            result = `Fetch error: ${err.message}`;
            type = 'error';
        }

        this.log.unshift({ icon, code, message: result, type, server, time });
        if (this.log.length > 100) this.log.length = 100;
    }

    detach() {
        if (this._client && this._listener) {
            this._client.removeListener('messageCreate', this._listener);
        }
        this._listener = null;
        this._client = null;
    }
}

module.exports = new NitroSniper();
