# Crypto Payment Service

[![CI/CD Pipeline](https://github.com/doottoy/crypto_payment/actions/workflows/depoly.yml/badge.svg)](https://github.com/doottoy/crypto_payment/actions/workflows/depoly.yml)

API service for crypto payouts across EVM (ETH Sepolia, Base Sepolia, Arbitrum Sepolia, BSC testnet, Polygon Amoy), Litecoin Testnet, Solana devnet (SOL & SPL/Token-2022), and Tron Nile (TRX/TRC20). Handles signing, fee selection, RPC failover, and Telegram alerts.

## Overview video

https://github.com/user-attachments/assets/32003c83-d35a-4c6c-bdb8-25ae06ace65c

A 2-minute overview: one HTTP API for payouts on EVM chains, Solana, Tron and Litecoin. It covers single, multi-send and batch payouts, the Sepolia → L2 ETH bridge, local signing, RPC failover, receipt checks, idempotent EVM retries via `request_id`, Telegram alerts and a one-container deploy.

## What you'll get
- Single payouts and batched multi-send per chain.
- Telegram alerts with explorer links for success and errors.
- EVM fee helpers (maxPriorityFee/maxFee bumping, provider failover).
- SPL/Token-2022 on Solana; TRX/TRC20 on Tron; Litecoin Testnet support.
- Native ETH bridging from Sepolia to Base/Arbitrum Sepolia (L1→L2 deposits).

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
| Chain                    | Single                      | Multi-send                      | Batch-send (Native + ERC20)     |
|--------------------------|-----------------------------|---------------------------------|---------------------------------|
| EVM (native/ERC20)       | `POST /payout/evm`          | `POST /payout/evm/multi_send`   | `POST /payout/evm/batch_send`   |
| Litecoin                 | `POST /payout/ltc`          | `POST /payout/ltc/multi_send`   | -                               |
| Solana (SOL/SPL/2022)    | `POST /payout/solana`       | `POST /payout/solana/multi_send`| -                               |
| Tron (TRX/TRC20)         | `POST /payout/tron`         | `POST /payout/tron/multi_send`  | -                               |
| Bridge ETH (L1→L2)       | `POST /bridge/eth`          | -                               | -                               |

All endpoints respond with:
```json
{ "tx_id": "transaction_hash" }
```

### Errors
Every failure is answered with JSON, never with an HTML page or a stack trace. `error` is a readable message, `code` is stable and meant for assertions, `details` is present when there is more to say:
```json
{
  "error": "data.amount: must be a non-negative decimal number such as \"0.1\"",
  "code": "invalid_request",
  "details": [{ "path": "data.amount", "message": "must be a non-negative decimal number such as \"0.1\"" }]
}
```

HTTP statuses are the ones the service always answered with: 400 when the request cannot be read, 404 for an unknown route, 409 for a `request_id` conflict, 500 for anything that failed while processing. Tell failures apart by `code`:

| `code` | HTTP | Meaning |
|---|---|---|
| `invalid_request` | 400 | A field is missing or malformed; `details` lists every field |
| `invalid_json` | 400 | The body is not valid JSON |
| `not_found` | 404 | No such route |
| `idempotency_conflict` | 409 | The `request_id` was already used with a different payload |
| `insufficient_funds` | 500 | The sender cannot cover the amount and the fee |
| `tx_reverted` | 500 | The transaction was mined but reverted, nothing was paid; `details.tx_id` is its hash |
| `nonce_taken` | 500 | Another transaction used the nonce, nothing was paid |
| `rpc_unavailable` | 500 | Every RPC provider of the network failed |
| `invalid_address` | 500 | The Litecoin node rejected an address |
| `wallet_not_found` | 500 | The Litecoin wallet named in `account` is not loaded |
| `node_error` | 500 | The Litecoin node failed for another reason |
| `internal_error` | 500 | Anything else |

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
    "private_key": "...",
    "wait_for_receipt": true,
    "request_id": "uuid-or-stable-client-id"
  }
}
```
Omit `contract` to send native ETH instead of ERC20.
Set `wait_for_receipt` to `false` to return `tx_id` immediately after submission; the service will wait for the receipt in the background.
Pass a stable `request_id` on client retries so the same payout request can be safely replayed without creating a new transaction.

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
    "multi_send_contract": "0x...",
    "wait_for_receipt": true,
    "request_id": "uuid-or-stable-client-id"
  }
}
```

### EVM (batch-send)
`POST /payout/evm/batch_send`
Allows sending both native currency and multiple ERC20 tokens in a single transaction. Automatically converts amounts based on decimals and approves tokens if allowance is insufficient.
```json
{
  "data": {
    "payway": "eth",
    "private_key": "...",
    "currency": "ETH",
    "batch_send_contract": "0x...",
    "native_transfers": [
      {
        "to": "0x...",
        "amount": "0.015"
      }
    ],
    "token_transfers": [
      {
        "token_address": "0x...",
        "to": "0x...",
        "amount": "1"
      }
    ]
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
`method` may be omitted. The service always calls `sendtoaddress` on the node, any other value is rejected with `invalid_request`. Amounts have at most 8 decimal places.

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

### Bridge (native ETH, L1 → L2)
`POST /bridge/eth`
Deposits native ETH from Sepolia (L1) to an L2 - Base Sepolia (OP Stack) or Arbitrum Sepolia (Nitro). The source chain is always Sepolia.
```json
{
  "data": {
    "destination": "base",
    "amount": "0.01",
    "payee_address": "0x...",
    "private_key": "...",
    "wait_for_receipt": true,
    "request_id": "uuid-or-stable-client-id"
  }
}
```
- `destination`: `base` or `arbitrum`.
- Omit `payee_address` to bridge to the sender's own address on the L2; provide it to credit a different recipient. (For Arbitrum with a custom recipient the service uses a retryable ticket, reading the submission fee and L2 gas price on-chain.)
- The returned `tx_id` is the **L1 deposit hash**; funds arrive on the L2 asynchronously (≈1-3 min for Base, ≈10-15 min for Arbitrum).
- `request_id` gives the same idempotency behaviour as the EVM payout endpoints.

## Observability
- Logs to stdout with timestamps and network tags.
- Telegram alerts via `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (skipped when they are not set).
- `GET /health` answers `{ "status": "ok", "version": "1.4.4", "uptime_s": 42 }`. Docker uses it as the container healthcheck, and the deploy job fails when the new container does not turn healthy within a minute.

## Development
- Build: `npm run app:build`
- Start: `npm run app:start` (uses `PORT` or 3000)
- Unit tests: `npm run test:unit`. They run offline against local mock nodes, and CI runs them before every deploy.
- Lint: `npm run lint` (auto-fix: `npm run lint-fix`)

## Deployment
GitHub Actions workflow `.github/workflows/depoly.yml` builds and deploys on pushes to `main`. Configure required secrets/env vars in repo settings.

## Contributing
Contributions are welcome. See [CONTRIBUTING.md](https://github.com/doottoy/crypto_payment/blob/main/CONTRIBUTING.md) before opening PRs.
