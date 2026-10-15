const path = require('node:path');

if (!process.env.FRESH_ME_NODE24 || !path.isAbsolute(process.env.FRESH_ME_NODE24)) {
  throw new Error('Set FRESH_ME_NODE24 to the absolute path of the Node 24 executable before starting this ecosystem file.');
}

module.exports = {
  apps: [{
    name: 'fresh-me-api',
    cwd: path.resolve(__dirname, '..'),
    script: 'src/index.js',
    interpreter: process.env.FRESH_ME_NODE24,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 3000,
    min_uptime: '10s',
    max_restarts: 10,
    kill_timeout: 20000,
    time: true,
    env: { NODE_ENV: 'production' }
  }]
};
