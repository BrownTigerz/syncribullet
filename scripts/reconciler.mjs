// Headless reconciler entry point.
// Run by the container entrypoint alongside the web server, or on its own:
//   PRIVATE_ENCRYPTION_KEY=... node scripts/reconciler.mjs
// Environment:
//   PRIVATE_ENCRYPTION_KEY      decrypts /app/data/pairs.json (required)
//   DATA_DIR                    pairs/status directory (default ./data)
//   RECONCILE_INTERVAL_MINUTES  run interval (default 30)

import { startReconciler } from '../src/reconciler/reconcile.mjs';

startReconciler();
