# Blockping Activity Bot

EVM activity bot that continuously deploys and interacts with Solidity smart contracts from randomized wallets.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your RPC URL, chain ID, and mnemonic

# 3. Compile contracts
npm run compile

# 4. Start the bot
npm start
```

## How It Works

Every ~60 seconds the bot:

1. **Picks a random action** — deploy a new contract or call a function on an existing one
2. **Selects a wallet** — 50% chance fresh wallet, 50% chance reuse from `wallets.json`
3. **Funds the wallet** from the master wallet (derived from your mnemonic) if needed
4. **Executes the action** with up to 3 retries on failure
5. **Logs everything** to `bot.log` and `txLogs.json`

## Contracts

| Contract | Type | Write Functions |
|---|---|---|
| WUST | ERC20 + Pausable | transfer, approve, burn, pause, unpause |
| TestRWA | ERC20 | transfer, approve, burn |
| SimpleEscrow | Escrow | fund (payable), release, refund |
| MYTOKEN | ERC20 | transfer, approve, burn |
| MessageBoard | Messaging | updateMessage |

## Files

- `index.js` — main bot loop
- `compile.js` — compiles Solidity to ABI + bytecode
- `contracts/` — Solidity source files
- `compiled/` — auto-generated compilation artifacts
- `wallets.json` — wallet store (append-only)
- `txLogs.json` — transaction log (append-only)
- `bot.log` — human-readable log

## Environment Variables

| Variable | Description |
|---|---|
| `RPC_URL` | JSON-RPC endpoint |
| `CHAIN_ID` | EVM chain ID |
| `MNEMONIC` | BIP-39 mnemonic for master wallet |
| `FUND_AMOUNT_MIN` | Min ETH to send when funding wallets |
| `FUND_AMOUNT_MAX` | Max ETH to send when funding wallets |
| `MIN_MASTER_BALANCE` | Pause funding if master drops below this |

## Stopping

Press `Ctrl+C` — the bot finishes the current cycle before exiting.
