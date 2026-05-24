'use strict';

const fs = require('fs');
const path = require('path');
const { generateKey } = require('./license');
const { getActiveSubscribers, updateCustomer } = require('./customers');

const STATE_PATH = path.join(__dirname, '..', 'data', 'reset-state.json');

function getLastReset() {
    try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).lastReset || 0; } catch { return 0; }
}

function saveLastReset() {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ lastReset: Date.now() }));
}

async function resetAllSubscriberKeys(discordClient) {
    let subscribers;
    try { subscribers = await getActiveSubscribers(); }
    catch (e) {
        console.error('[KeyReset] Failed to fetch subscribers:', e.message);
        return { count: 0, total: 0, errors: [e.message] };
    }

    let count = 0;
    const errors = [];

    for (const customer of subscribers) {
        try {
            const result = generateKey(customer.tier || 'monthly');
            await updateCustomer(customer.id, {
                currentKey: result.key,
                keyExpiresAt: result.expiresAt,
                lastKeyReset: new Date().toISOString()
            });

            if (discordClient && customer.discordId) {
                try {
                    const user = await discordClient.users.fetch(customer.discordId);
                    const dm = await user.createDM();
                    const expStr = result.expiresAt ? new Date(result.expiresAt).toDateString() : 'Never';
                    await dm.send(
                        `🔑 **Your Onyx key has been renewed!**\n\`\`\`\n${result.key}\n\`\`\`` +
                        `\n⏰ Valid until: **${expStr}**\n\n` +
                        `Activate at your panel URL → \`/activate\``
                    );
                } catch (dmErr) {
                    console.error(`[KeyReset] DM failed for ${customer.discordId}:`, dmErr.message);
                }
            }
            count++;
        } catch (e) {
            console.error(`[KeyReset] Error for customer ${customer.id}:`, e.message);
            errors.push({ id: customer.id, error: e.message });
        }
    }

    console.log(`[KeyReset] Reset ${count}/${subscribers.length} keys — ${new Date().toISOString()}`);
    return { count, total: subscribers.length, errors };
}

let resetTimer = null;

function scheduleDaily(discordClient) {
    if (resetTimer) { clearInterval(resetTimer); resetTimer = null; }

    const checkAndReset = () => {
        if (Date.now() - getLastReset() >= 24 * 60 * 60 * 1000) {
            resetAllSubscriberKeys(discordClient)
                .then(r => { if (r.count > 0 || r.total > 0) saveLastReset(); })
                .catch(e => console.error('[KeyReset] Daily reset error:', e.message));
        }
    };

    checkAndReset();
    resetTimer = setInterval(checkAndReset, 60 * 60 * 1000);
    console.log('[KeyReset] Daily reset scheduler started');
}

function stopSchedule() {
    if (resetTimer) { clearInterval(resetTimer); resetTimer = null; }
}

module.exports = { resetAllSubscriberKeys, scheduleDaily, stopSchedule, getLastReset, saveLastReset };
