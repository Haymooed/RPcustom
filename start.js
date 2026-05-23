const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_URL = "https://github.com/Haymooed/Onyx";
const WORK_DIR = '/home/container';

function run(command, { optional = false, silent = false } = {}) {
    try {
        if (!silent) console.log(`> ${command}`);
        execSync(command, { stdio: silent ? 'pipe' : 'inherit', cwd: WORK_DIR, shell: true });
        return true;
    } catch (error) {
        if (!silent) console.error(`Failed: ${command}`);
        if (!optional) process.exit(1);
        return false;
    }
}

// 0. Wipe ALL npm caches from previous runs — this is the main cause of ENOSPC
//    Each crashed install leaves behind cached tarballs that pile up across restarts.
run('rm -rf /tmp/.npm-cache /tmp/npm-c /root/.npm /home/container/.npm /tmp/npm-cache-* ~/.npm', { optional: true, silent: true });

// 1. Smart Update (Git)
if (!fs.existsSync(path.join(WORK_DIR, '.git'))) {
    console.log("Initial setup: Cloning repository...");
    run(`git init`);
    run(`git remote add origin ${REPO_URL}`);
    run(`git fetch --depth=1 origin main`);
    run(`git reset --hard origin/main`);
} else {
    console.log("Checking for updates...");
    run(`git fetch --depth=1 origin main`, { silent: true });
    const local = execSync('git rev-parse HEAD', { cwd: WORK_DIR }).toString().trim();
    const remote = execSync('git rev-parse FETCH_HEAD', { cwd: WORK_DIR }).toString().trim();
    if (local !== remote) {
        console.log("Updates found! Updating...");
        run(`git reset --hard origin/main`);
    } else {
        console.log("Already up to date.");
    }
}

// 2. Install dependencies
//    --ignore-scripts  → skip native binary compilation (not needed, saves ~100MB)
//    --omit=optional   → skip firebase-admin and other heavy optional packages
//    --legacy-peer-deps→ allow discord.js-selfbot-v13 (v13 era) alongside @discordjs v2
//    --cache /tmp/npm-c → isolated throwaway cache dir
const NPM = 'npm install --no-package-lock --omit=optional --legacy-peer-deps --ignore-scripts --no-fund --no-audit --cache /tmp/npm-c';

const nodeModulesExist = fs.existsSync(path.join(WORK_DIR, 'node_modules'));
if (!nodeModulesExist) {
    console.log("Installing dependencies...");
    run(NPM);
} else {
    console.log("Verifying dependencies...");
    run(`${NPM} --prefer-offline`, { silent: true });
}

// 3. Wipe the install cache immediately — we don't need it anymore
run('rm -rf /tmp/npm-c', { optional: true, silent: true });

// 4. Start the server
console.log("Starting the server...");
run(`node server.js`);
