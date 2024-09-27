# Crypto Payment Service

[![CI/CD Pipeline](https://github.com/doottoy/crypto_payment/actions/workflows/depoly.yml/badge.svg)](https://github.com/doottoy/crypto_payment/actions/workflows/depoly.yml)

## Overview

The Crypto Payment Service provides a robust platform for handling cryptocurrency transactions. The service supports both single and multi-send transactions for various cryptocurrencies, including ETH/BSC/Arbitrum/Base (EVM) and Litecoin (LTC).

## Features

- **Single Payouts:** Transfer funds to a single address with specified amount.
- **Multi-Send:** Efficiently send funds to multiple addresses in a single transaction.
- **Support for EVM and LTC:** Includes support for Ethereum-compatible networks and Litecoin transactions.
- **Error Handling and Notifications:** Comprehensive error handling with notifications sent via Telegram.
- **Environment Configurations:** Flexible configuration through environment variables.

## Installation

To get started with the Crypto Payment Service, follow these steps:

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/your-repo/crypto_payment.git
   cd crypto_payment

2. **Install Dependencies:**
   ```bash
   npm install

3. **Setup Environment Variables:**
- Create a `.env` file in the root directory and add the required environment variables:
   ```bash
    #===================================================================
    # Main ENV
    #===================================================================
    RPC_URL=litecoin_core_host
    RPC_USER=litecoin_core_user
    RPC_PASS=litecoin_core_password
    TELEGRAM_API_KEY=your_telegram_api_key
    TELEGRAM_CHAT_ID=your_telegram_chat_id
  
    #===================================================================
    # ENV for testing
    #===================================================================
    AUTOMATION_EVM_PRIVATE_KEY=address_private_key
    AUTOMATION_SERVICE_PRIVATE_KEY=google_service_account_private_key
    AUTOMATION_SERVICE_EMAIL=google_service_account
    AUTOMATION_GOOGLE_TOKEN=google_sheet_with_test_data
    AUTOMATION_SERVICE_SCOPES=google_sheet_scopes

4. **Build the Project:**
   ```bash
   npm run app:build
   
5. **Start the Server:**
   ```bash
   npm run app:start

## API Endpoints

**Single EVM Payout**

- **Endpoint:** `/payout/evm`
- **Method:** POST
- **Request Body:**
```json
{
  "data": {
    "payway": "ETH",
    "payee_address": "0x...",
    "amount": "0.1",
    "contract": "0x...",
    "currency": "ETH",
    "private_key": "your_private_key"
  }
}
```

**Multi-Send EVM**

- **Endpoint:** `/payout/evm/multi_send`
- **Method:** `POST`
- **Request Body:**
```json
{
  "data": {
    "payway": "ETH",
    "recipients": [
      {"address": "0x...", "amount": "0.05"},
      {"address": "0x...", "amount": "0.05"}
    ],
    "private_key": "your_private_key",
    "currency": "ETH",
    "multi_send_contract": "0x..."
  }
}
```

**Single LTC Payout**

- **Endpoint:** `/payout/ltc`
- **Method:** `POST`
- **Request Body:**
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

**Multi-Send LTC**

- **Endpoint:** `/payout/ltc/multi_send`
- **Method:** `POST`
- **Request Body:**
```json
{
  "data": {
    "method": "sendmany",
    "payway": "LTC",
    "currency": "LTC",
    "recipients": [
      {"address": "LTC...", "amount": "0.5"},
      {"address": "LTC...", "amount": "0.5"}
    ],
    "comment": "Payment for services",
    "minconf": 1,
    "account": "account_name"
  }
}
```

## General Response Format

All API endpoints return a response with the following structure:

```json
{
  "tx_id": "transaction_hash"
}
```

## Development

To run tests, use:
```bash
npm run tests:start
```

To lint the code, use:
```bash
npm run lint
```

To automatically fix linting issues, use:
```bash
npm run lint-fix
```

## Deployment

Deployment is managed through GitHub Actions. Changes to the main branch will trigger automatic deployment to the server. Ensure that your configuration and secrets are set up correctly in GitHub Actions.

## Contributing
I welcome contributions to the Crypto Payment Service. Please refer to the [contributing guidelines](https://github.com/doottoy/crypto_payment/blob/main/CONTRIBUTING.md) for more information.
