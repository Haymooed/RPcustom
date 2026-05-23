const { ClientQuest } = require('./client');

class QuestManagerBridge {
    constructor(token) {
        this.token = token.replace('Bot ', '');
        this.client = new ClientQuest(this.token);

        this.client.connect().catch(err => {
            this.log('system', `Gateway Error: ${err.message}`);
        });

        this.globalLogs = [];
        this.activeManager = null;
        this.isRunning = false;
        this.currentQuestInfo = null;
        this.gameSpoofCallback = null;
        this.onQuestComplete = null;
        this._activePlayQuests = 0;
    }

    get activeQuests() { return new Map(); }

    log(questId, msg) {
        let line = '';
        const time = new Date().toLocaleTimeString();

        if (msg) {
            line = msg;
        } else {
            line = questId;
        }

        if (!line.startsWith('[')) {
            line = `[${time}] ${line}`;
        }

        this.globalLogs.push(line);
        if (this.globalLogs.length > 500) this.globalLogs.shift();
        console.log('[Quest]', line);
    }

    clearLogs() {
        this.globalLogs = [];
        this.log('system', 'Logs cleared.');
    }

    setGameSpoofCallback(fn) {
        this.gameSpoofCallback = fn;
    }

    setQuestCompleteCallback(fn) {
        this.onQuestComplete = fn;
    }

    _isPlayQuest(q) {
        const cfg = q.config.task_config || q.config.task_config_v2;
        return !!(cfg?.tasks && 'PLAY_ON_DESKTOP' in cfg.tasks);
    }

    async _startPlaySpoof(appId, appName) {
        this._activePlayQuests++;
        if (this.gameSpoofCallback) {
            await this.gameSpoofCallback(appId, appName).catch(() => {});
        }
    }

    async _endPlaySpoof() {
        this._activePlayQuests = Math.max(0, this._activePlayQuests - 1);
        if (this._activePlayQuests === 0 && this.gameSpoofCallback) {
            await this.gameSpoofCallback(null, null).catch(() => {});
        }
    }

    // Fetch available quests — returns array of { id, name, game, appId, type, completed, expired }
    async fetchQuests() {
        const manager = await this.client.fetchQuests();
        this.activeManager = manager;
        manager.setLogger((msg) => this.log(msg));
        return manager.list().map(q => ({
            id: q.id,
            name: q.config.messages?.quest_name || q.config.application?.name || q.id,
            game: q.config.application?.name || null,
            appId: q.config.application?.id || null,
            completed: q.isCompleted(),
            expired: q.isExpired(),
            type: (() => {
                const cfg = q.config.task_config || q.config.task_config_v2;
                return cfg?.tasks ? Object.keys(cfg.tasks)[0] : 'UNKNOWN';
            })(),
        }));
    }

    async startAll() {
        if (this.isRunning) {
            this.log('system', 'Already running.');
            return;
        }

        this.isRunning = true;
        this.log('system', 'Starting Quest Protocol...');

        try {
            const manager = await this.client.fetchQuests();
            this.activeManager = manager;

            manager.setLogger((msg) => this.log(msg));

            const validQuests = manager.filterQuestsValid();
            this.log('system', `Found ${validQuests.length} valid quests.`);

            if (validQuests.length === 0) {
                this.log('system', 'No quests to do.');
                this.isRunning = false;
                return;
            }

            // Run all quests in parallel (roxy-plus style)
            const promises = validQuests.map(async (q) => {
                const appName = q.config.messages?.quest_name || q.config.application?.name || q.id;
                const appId = q.config.application?.id || null;
                this.currentQuestInfo = { id: q.id, name: appName, appId };

                const isPlay = this._isPlayQuest(q);

                await new Promise(r => setTimeout(r, Math.random() * 5000));

                if (isPlay && appId) await this._startPlaySpoof(appId, appName);
                let success = false;
                try {
                    await manager.doingQuest(q);
                    success = true;
                } catch (e) {
                    if (e.message !== 'Stopped') {
                        this.log(q.id, `Error: ${e.message}`);
                    }
                } finally {
                    if (isPlay && appId) await this._endPlaySpoof();
                    if (this.onQuestComplete) {
                        await this.onQuestComplete({ id: q.id, name: appName, appId, success, completedAt: new Date().toISOString() }).catch(() => {});
                    }
                }
            });

            await Promise.all(promises);
            this.log('system', 'All quests finished processing.');

        } catch (error) {
            this.log('system', `Critical Error: ${error.message}`);
        } finally {
            this.isRunning = false;
            this.currentQuestInfo = null;
            this.activeManager = null;
            this.client.destroy().catch(() => {});
        }
    }

    // Start a single quest by ID (kept for panel UI compatibility)
    async startOne(questId) {
        if (this.isRunning) { this.log('system', 'Already running.'); return; }
        this.isRunning = true;
        this.log('system', `Starting quest ${questId}...`);
        try {
            let manager = this.activeManager;
            if (!manager) {
                manager = await this.client.fetchQuests();
                this.activeManager = manager;
                manager.setLogger((msg) => this.log(msg));
            }
            const quest = manager.get(questId);
            if (!quest) { this.log('system', `Quest ${questId} not found.`); return; }
            if (quest.isCompleted()) { this.log('system', 'Quest already completed.'); return; }
            if (quest.isExpired()) { this.log('system', 'Quest has expired.'); return; }

            const appName = quest.config.messages?.quest_name || quest.config.application?.name || quest.id;
            const appId = quest.config.application?.id || null;
            this.currentQuestInfo = { id: quest.id, name: appName, appId };

            const isPlay = this._isPlayQuest(quest);

            await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

            if (isPlay && appId) await this._startPlaySpoof(appId, appName);
            let success = false;
            try {
                await manager.doingQuest(quest);
                success = true;
                this.log('system', 'Quest finished.');
            } finally {
                if (isPlay && appId) await this._endPlaySpoof();
                if (this.onQuestComplete) {
                    await this.onQuestComplete({ id: quest.id, name: appName, appId, success, completedAt: new Date().toISOString() }).catch(() => {});
                }
            }
        } catch (error) {
            if (error.message !== 'Stopped') {
                this.log('system', `Error: ${error.message}`);
            }
        } finally {
            this.isRunning = false;
            this.currentQuestInfo = null;
            this.activeManager = null;
            this.client.destroy().catch(() => {});
        }
    }

    stopAll() {
        if (this.activeManager) {
            this.activeManager.stopAll();
            this.log('system', 'Stopping all tasks immediately...');
        } else {
            this.log('system', 'Nothing to stop.');
        }
        this.isRunning = false;
    }
}

module.exports = QuestManagerBridge;
