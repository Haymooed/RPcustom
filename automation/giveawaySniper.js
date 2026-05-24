'use strict';

const GIVEAWAY_BOT_IDS = new Set([
    '294882584201003009',
    '235148962103951360',
    '716708136736702515',
    '603058554387046400',
    '507990905283215370',
    '1162372076418584628'
]);

class GiveawaySniper {
    constructor() {
        this.enabled = false;
        this.delay = 0;
        this.log = [];
        this.stats = { entered: 0, failed: 0 };
        this._listener = null;
        this._client = null;
    }

    attach(client) {
        this._client = client;
        this._listener = async (message) => {
            if (!this.enabled) return;
            if (!message.author?.bot) return;
            if (!GIVEAWAY_BOT_IDS.has(message.author.id)) return;

            const content = (message.content || '').toLowerCase();
            const embedText = (message.embeds || []).map(em =>
                [em.title, em.description, em.footer?.text].filter(Boolean).join(' ')
            ).join(' ').toLowerCase();
            const combined = content + ' ' + embedText;

            const hasGiveaway = combined.includes('giveaway') || combined.includes('🎉');
            const hasReact = combined.includes('react') || combined.includes('enter') || combined.includes('join') || combined.includes('🎉');
            if (!hasGiveaway || !hasReact) return;

            const server = message.guild?.name || 'DM';
            const time = new Date().toLocaleTimeString();
            // Extract prize from embed title or content
            let prize = '—';
            for (const em of (message.embeds || [])) {
                if (em.title) { prize = em.title; break; }
            }
            if (prize === '—' && content) {
                const lines = content.split('\n').filter(Boolean);
                if (lines.length) prize = lines[0].slice(0, 60);
            }

            if (this.delay > 0) await new Promise(r => setTimeout(r, this.delay));

            try {
                await message.react('🎉');
                this.stats.entered++;
                this.log.unshift({ time, server, prize, status: 'Entered', type: 'success' });
            } catch (err) {
                this.stats.failed++;
                this.log.unshift({ time, server, prize, status: `Failed: ${err.message}`, type: 'error' });
            }
            if (this.log.length > 50) this.log.length = 50;
        };
        client.on('messageCreate', this._listener);
    }

    detach() {
        if (this._client && this._listener) {
            this._client.removeListener('messageCreate', this._listener);
        }
        this._listener = null;
        this._client = null;
    }
}

module.exports = new GiveawaySniper();
