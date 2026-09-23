module.exports = {
  apps: [{
    name: 'opensea-bot',
    script: 'bot.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 50,
    min_uptime: '30s',
    restart_delay: 5000,
    max_memory_restart: '300M',
    time: true,
  }],
};
