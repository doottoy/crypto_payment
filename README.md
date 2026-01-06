# Crypto Payment Service

[![CI/CD Pipeline](https://github.com/doottoy/crypto_payment/actions/workflows/depoly.yml/badge.svg)](https://github.com/doottoy/crypto_payment/actions/workflows/depoly.yml)

API service for crypto payouts across EVM (ETH Sepolia, Base Sepolia, Arbitrum Sepolia, BSC testnet, Polygon Amoy), Litecoin Testnet, Solana devnet (SOL & SPL/Token-2022), and Tron Nile (TRX/TRC20). Handles signing, fee selection, RPC failover, and Telegram alerts.

## What you'll get
- Single payouts and batched multi-send per chain.
- Telegram alerts with explorer links for success and errors.
- EVM fee helpers (maxPriorityFee/maxFee bumping, provider failover).
- SPL/Token-2022 on Solana; TRX/TRC20 on Tron; Litecoin Testnet support.

## Supported networks
- EVM: ETH Sepolia, Base Sepolia, Arbitrum Sepolia, BSC testnet, Polygon Amoy
- Litecoin: Litecoin Testnet
- Solana: devnet (SOL, SPL, Token-2022)
- Tron: Nile (TRX, TRC20)

## Prerequisites
- Node.js 18+
- Access to the necessary RPC endpoints and private keys for the chains you use
- Telegram bot token and chat id (for alerts)

## Setup
1) Install dependencies
```bash
npm install
```

2) Create `.env` in the repo root
```bash
# Litecoin Core RPC
RPC_URL=litecoin_core_host
RPC_USER=litecoin_core_user
RPC_PASS=litecoin_core_password

# Telegram bot (alerts)
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Test automation (optional)
AUTOMATION_EVM_PRIVATE_KEY=...
AUTOMATION_SERVICE_PRIVATE_KEY=...
AUTOMATION_SERVICE_EMAIL=...
AUTOMATION_GOOGLE_TOKEN=...
AUTOMATION_SERVICE_SCOPES=...
```

3) Build and run
```bash
npm run app:build
npm run app:start   # PORT defaults to 3000
```

## API overview
| Chain                    | Single                      | Multi-send                      |
|--------------------------|-----------------------------|---------------------------------|
| EVM (native/ERC20)       | `POST /payout/evm`          | `POST /payout/evm/multi_send`   |
| Litecoin                 | `POST /payout/ltc`          | `POST /payout/ltc/multi_send`   |
| Solana (SOL/SPL/2022)    | `POST /payout/solana`       | `POST /payout/solana/multi_send`|
| Tron (TRX/TRC20)         | `POST /payout/tron`         | `POST /payout/tron/multi_send`  |

All endpoints respond with:
```json
{ "tx_id": "transaction_hash" }
```

### EVM (single)
`POST /payout/evm`
```json
{
  "data": {
    "payway": "eth",
    "payee_address": "0x...",
    "amount": "0.1",
    "contract": "0x...",
    "currency": "ETH",
    "private_key": "..."
  }
}
```
Omit `contract` to send native ETH instead of ERC20.

### EVM (multi-send)
`POST /payout/evm/multi_send`
```json
{
  "data": {
    "payway": "eth",
    "recipients": [
      { "address": "0x...", "amount": "0.05" },
      { "address": "0x...", "amount": "0.05" }
    ],
    "currency": "ETH",
    "private_key": "...",
    "multi_send_contract": "0x..."
  }
}
```

### Litecoin (single)
`POST /payout/ltc`
```json
{
  "data": {
    "method": "sendtoaddress",
    "payee_address": "LTC...",
    "amount": "1.0",
    "payway": "LTC",
    "currency": "LTC"
  }
}
```

### Litecoin (multi)
`POST /payout/ltc/multi_send`
```json
{
  "data": {
    "method": "sendmany",
    "payway": "LTC",
    "currency": "LTC",
    "recipients": [
      { "address": "LTC...", "amount": "0.5" },
      { "address": "LTC...", "amount": "0.5" }
    ],
    "comment": "Payment for services",
    "minconf": 1,
    "account": "wallet_label"
  }
}
```

### Solana (SOL or SPL/Token-2022)
`POST /payout/solana`
```json
{
  "data": {
    "payway": "sol",
    "currency": "SOL",
    "amount": "0.1",
    "payee_address": "5x...",
    "private_key": "...",
    "token_mint": null,
    "is_token_2022": false
  }
}
```
Set `token_mint` and `is_token_2022: true` for Token-2022; set `token_mint` for classic SPL tokens.

### Solana (multi)
`POST /payout/solana/multi_send`
```json
{
  "data": {
    "private_key": "...",
    "currency": "SOL",
    "token_mint": null,
    "recipients": [
      { "address": "5x...", "amount": "0.05" },
      { "address": "5y...", "amount": "0.05" }
    ]
  }
}
```

### Tron (single)
`POST /payout/tron`
```json
{
  "data": {
    "payway": "tron",
    "payee_address": "T...",
    "amount": "0.1",
    "contract": "T...",
    "currency": "TRX",
    "private_key": "..."
  }
}
```
For TRC20, set `payway` to `trc20`, provide `contract`, and set `currency` accordingly.

### Tron (multi)
`POST /payout/tron/multi_send`
```json
{
  "data": {
    "payway": "tron",
    "recipients": [
      { "address": "T...", "amount": "0.05" },
      { "address": "T...", "amount": "0.05" }
    ],
    "private_key": "...",
    "currency": "TRX",
    "multi_send_contract": "T...",
    "token_contract": "T..."
  }
}
```
`token_contract` is required for TRC20 multi-send; omit for TRX.

## Observability
- Logs to stdout with timestamps and network tags.
- Telegram alerts via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

## Development
- Build: `npm run app:build`
- Start: `npm run app:start` (uses `PORT` or 3000)
- Tests: `npm run tests:start`
- Lint: `npm run lint` (auto-fix: `npm run lint-fix`)

## Deployment
GitHub Actions workflow `.github/workflows/depoly.yml` builds and deploys on pushes to `main`. Configure required secrets/env vars in repo settings.

## Contributing
Contributions are welcome. See [CONTRIBUTING.md](https://github.com/doottoy/crypto_payment/blob/main/CONTRIBUTING.md) before opening PRs.
