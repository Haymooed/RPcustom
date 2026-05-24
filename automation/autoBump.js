'use strict';

const DISBOARD_ID = '302050872383242240';

class AutoBump {
    constructor() {
        this.enabled = false;
        this.log = [];
        this.nextBumpAt = null;
        this.timer = null;
        this._listener = null;
        this._client = null;
        this._lastChannelId = null;
    }

    attach(client) {
        this._client = client;
        this._listener = (message) => {
            if (!this.enabled) return;
            if (message.author?.id !== DISBOARD_ID) return;

            const embedDesc = (message.embeds?.[0]?.description || '').toLowerCase();
            const content = (message.content || '').toLowerCase();
            const combined = embedDesc + content;

            const isBumpSuccess = combined.includes('bump done') ||
                combined.includes('bumped') ||
                combined.includes('you just bumped') ||
                combined.includes('check it on disboard');

            if (!isBumpSuccess) return;

            // Track the channel for next bump
            this._lastChannelId = message.channel?.id;
            this._scheduleBump(this._lastChannelId);

            const time = new Date().toLocaleTimeString();
            this.log.unshift({ time, message: 'Bump detected — next in 2h', type: 'info' });
            if (this.log.length > 50) this.log.length = 50;
        };
        client.on('messageCreate', this._listener);
    }

    _scheduleBump(channelId) {
        if (this.timer) clearTimeout(this.timer);
        const bumpAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
        this.nextBumpAt = bumpAt.toISOString();
        this.timer = setTimeout(async () => {
            if (!this.enabled) return;
            await this._doBump(channelId);
        }, 2 * 60 * 60 * 1000);
    }

    async _doBump(channelId) {
        if (!this._client) return;
        const time = new Date().toLocaleTimeString();
        try {
            const channel = this._client.channels.cache.get(channelId);
            if (!channel) throw new Error('Channel not found');
            try {
                await channel.sendSlash(DISBOARD_ID, 'bump');
            } catch {
                await channel.send('!d bump');
            }
            this.nextBumpAt = null;
            this.log.unshift({ time, message: 'Bump sent!', type: 'success' });
            if (this.log.length > 50) this.log.length = 50;
        } catch (err) {
            this.log.unshift({ time, message: `Bump failed: ${err.message}`, type: 'error' });
            if (this.log.length > 50) this.log.length = 50;
        }
    }

    async forceNow(channelId, client) {
        if (client) this._client = client;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.nextBumpAt = null;
        const targetId = channelId || this._lastChannelId;
        if (!targetId) return 'No channel ID provided';
        await this._doBump(targetId);
        return 'Bump attempted';
    }

    detach() {
        if (this._client && this._listener) {
            this._client.removeListener('messageCreate', this._listener);
        }
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this._listener = null;
        this._client = null;
    }
}

module.exports = new AutoBump();
