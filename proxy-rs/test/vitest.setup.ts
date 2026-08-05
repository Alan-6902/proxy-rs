// Proxy integration tests only use loopback and must never inherit app data or credentials.
process.env.ELECTRON_RUN_AS_NODE = '1'
