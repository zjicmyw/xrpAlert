module.exports = {
  apps: [
    {
      name: "xrp-alert",
      script: "monitor.js",
      cwd: __dirname,
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "150M",
      env: {},
    },
  ],
};
