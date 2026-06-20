module.exports = {
  apps: [{
    name: "darkpools-trader",
    script: "index.js",
    args: "run",
    cwd: __dirname,
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "500M",
    env: {
      NODE_ENV: "production",
    },
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: "logs/pm2-error.log",
    out_file: "logs/pm2-output.log",
    merge_logs: true,
    min_uptime: "30s",
    max_restarts: 10,
    restart_delay: 5000,
    stop_exit_codes: [0],
  }],
};
