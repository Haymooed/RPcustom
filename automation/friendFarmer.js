'use strict';

class FriendFarmer {
    constructor() {
        this.running = false;
        this.log = [];
        this.stats = { sent: 0, failed: 0, skipped: 0 };
    }

    async start(client, options = {}) {
        if (this.running) return;
        this.running = true;
        this.stats = { sent: 0, failed: 0, skipped: 0 };

        const {
            serverId,
            limit = 50,
            delay = 1000,
            skipFriends = true
        } = options;

        const logEntry = (msg, type) => {
            const time = new Date().toLocaleTimeString();
            this.log.unshift({ time, message: msg, type });
            if (this.log.length > 100) this.log.length = 100;
        };

        if (!serverId) {
            logEntry('No server ID provided', 'error');
            this.running = false;
            return;
        }

        try {
            const guild = client.guilds.cache.get(serverId);
            if (!guild) {
                logEntry(`Server ${serverId} not found`, 'error');
                this.running = false;
                return;
            }

            logEntry(`Starting in "${guild.name}" — limit ${limit}`, 'info');

            // Fetch members
            let members;
            try {
                await guild.members.fetch({ limit: Math.min(parseInt(limit) || 50, 1000) });
                members = guild.members.cache;
            } catch {
                members = guild.members.cache;
            }

            let processed = 0;
            const maxLimit = parseInt(limit) || 50;

            for (const [, member] of members) {
                if (!this.running) break;
                if (processed >= maxLimit) break;

                const user = member.user;

                // Skip bots
                if (user.bot) { this.stats.skipped++; continue; }

                // Skip self
                if (user.id === client.user?.id) { this.stats.skipped++; continue; }

                // Skip existing friends
                if (skipFriends) {
                    const rel = client.relationships?.cache?.get(user.id);
                    const relType = rel?.type;
                    if (relType === 1) { // 1 = friend
                        this.stats.skipped++;
                        continue;
                    }
                }

                processed++;

                try {
                    // Try the selfbot API method first
                    try {
                        await client.user.sendFriendRequest(user.id);
                    } catch {
                        // Fallback: REST
                        const res = await fetch('https://discord.com/api/v9/users/@me/relationships', {
                            method: 'POST',
                            headers: {
                                'Authorization': client.token,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ type: 1, user_id: user.id })
                        });
                        if (!res.ok && res.status !== 204) {
                            const body = await res.json().catch(() => ({}));
                            throw new Error(body.message || `HTTP ${res.status}`);
                        }
                    }
                    this.stats.sent++;
                    logEntry(`Sent request to ${user.username}`, 'success');
                } catch (err) {
                    this.stats.failed++;
                    logEntry(`Failed ${user.username}: ${err.message}`, 'error');
                }

                if (this.running && delay > 0) {
                    await new Promise(r => setTimeout(r, parseInt(delay) || 1000));
                }
            }

            logEntry(`Done — ${this.stats.sent} sent, ${this.stats.failed} failed, ${this.stats.skipped} skipped`, 'info');
        } catch (err) {
            this.log.unshift({ time: new Date().toLocaleTimeString(), message: `Error: ${err.message}`, type: 'error' });
        } finally {
            this.running = false;
        }
    }

    stop() {
        this.running = false;
    }
}

module.exports = new FriendFarmer();
