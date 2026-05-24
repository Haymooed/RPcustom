'use strict';

const NITRO_TYPES = { 0: 'None', 1: 'Classic', 2: 'Full', 3: 'Basic' };

async function checkTokens(tokens) {
    const results = [];
    for (const token of tokens) {
        await new Promise(r => setTimeout(r, 100));
        try {
            const res = await fetch('https://discord.com/api/v9/users/@me', {
                headers: {
                    'Authorization': token,
                    'Content-Type': 'application/json'
                }
            });
            if (res.status === 200) {
                const data = await res.json();
                const nitroType = data.premium_type || 0;
                results.push({
                    token,
                    valid: true,
                    username: data.username,
                    discriminator: data.discriminator || '0',
                    id: data.id,
                    email: data.email || null,
                    phone: data.phone || null,
                    nitro: nitroType > 0,
                    nitroType: NITRO_TYPES[nitroType] || 'Unknown',
                    reason: null
                });
            } else if (res.status === 401) {
                results.push({ token, valid: false, username: null, discriminator: null, id: null, email: null, phone: null, nitro: false, nitroType: null, reason: 'Invalid token' });
            } else if (res.status === 403) {
                results.push({ token, valid: false, username: null, discriminator: null, id: null, email: null, phone: null, nitro: false, nitroType: null, reason: 'Locked / quarantined' });
            } else if (res.status === 429) {
                results.push({ token, valid: false, username: null, discriminator: null, id: null, email: null, phone: null, nitro: false, nitroType: null, reason: 'Rate limited' });
            } else {
                results.push({ token, valid: false, username: null, discriminator: null, id: null, email: null, phone: null, nitro: false, nitroType: null, reason: `HTTP ${res.status}` });
            }
        } catch (err) {
            results.push({ token, valid: false, username: null, discriminator: null, id: null, email: null, phone: null, nitro: false, nitroType: null, reason: err.message });
        }
    }
    return results;
}

module.exports = { checkTokens };
