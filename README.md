# EVM Transaction Service
[![Build Status](https://github.com/doottoy/evm_payout_service/actions/workflows/deploy.yml/badge.svg)](https://github.com/doottoy/evm_payout_service/actions/workflows/deploy.yml)

## Overview

This project provides a service for handling EVM transactions. The primary functionality includes creating single payouts as well as multi-send transactions.

## Features

- **Single Payouts:** Initiate transactions to transfer funds to a single address.
- **Multi-Send:** Efficiently send transactions to multiple addresses in a single batch.

## Getting Started

### Prerequisites

- Node.js (version 18 or higher)
- Docker and Docker Compose

### Installation

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/doottoy/evm_payout_service.git
   cd evm_payout_service

2. **Install Dependencies:**

    ```bash
    npm install

### Running service locally
1. **Build the Project:**

    ```bash
    npm run build

2. **Start project:**

    ```bash
    npm run start

### Running service with Docker
- To start the service locally using Docker, build and Run the Docker Containers:

    ```bash
    docker-compose up --build -d
