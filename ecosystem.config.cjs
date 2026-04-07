module.exports = {
  apps: [
    {
      name: "xrp-alert",
      script: "monitor.js",
      cwd: __dirname,
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: "150M",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
