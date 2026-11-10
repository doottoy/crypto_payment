/*
 * Loaded first by `npm run test:unit` (mocha --require). dotenv never overrides a variable that is already set, so
 * blanking these before any module loads .env keeps unit tests away from the real Telegram chat and Litecoin node.
 * Tests that need a node point RPC_URL at a local mock server themselves.
 */
for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'RPC_URL', 'RPC_USER', 'RPC_PASS']) {
    process.env[key] = '';
}

// The payout journal lives in memory during tests, nothing is written under ./data
process.env.DATA_DIR = ':memory:';
