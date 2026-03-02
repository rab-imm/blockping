/**
 * index.js — Blockping Activity Bot
 *
 * Continuously deploys and interacts with Solidity smart contracts on an EVM
 * chain.  Every ~1 minute a random action (deploy or call) is performed from
 * a random wallet funded by a master wallet derived from a mnemonic.
 *
 * Usage:  node index.js
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─────────────────────────────────────────────────────────────────────────────
// Config from .env
// ─────────────────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = Number(process.env.CHAIN_ID);
const MNEMONIC = process.env.MNEMONIC;
const FUND_AMOUNT_MIN = parseFloat(process.env.FUND_AMOUNT_MIN || "0.005");
const FUND_AMOUNT_MAX = parseFloat(process.env.FUND_AMOUNT_MAX || "0.02");
const MIN_MASTER_BALANCE = parseFloat(process.env.MIN_MASTER_BALANCE || "0.05");

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────
const WALLETS_FILE = path.join(__dirname, "wallets.json");
const TX_LOGS_FILE = path.join(__dirname, "txLogs.json");
const BOT_LOG_FILE = path.join(__dirname, "bot.log");
const COMPILED_DIR = path.join(__dirname, "compiled");

// ─────────────────────────────────────────────────────────────────────────────
// Contract registry — defines constructor args generators & callable write fns
// ─────────────────────────────────────────────────────────────────────────────
const RANDOM_MESSAGES = [
  "Hello World",
  "GM",
  "Testing 123",
  "Blockchain is cool",
  "Onchain activity",
  "Blockping was here",
  "gn frens",
  "WAGMI",
  "LFG",
  "Building in public",
];

const CONTRACT_SPECS = {
  WUST: {
    file: "WUST.sol",
    constructorArgs: (walletAddr) => [walletAddr],
    writeFns: [
      {
        name: "transfer",
        args: () => [ethers.Wallet.createRandom().address, ethers.parseEther(randomInRange(0.001, 10).toString())],
      },
      {
        name: "approve",
        args: () => [ethers.Wallet.createRandom().address, ethers.parseEther(randomInRange(1, 100).toString())],
      },
      {
        name: "burn",
        args: () => [ethers.parseEther(randomInRange(0.001, 5).toString())],
      },
      { name: "pause", args: () => [] },
      { name: "unpause", args: () => [] },
    ],
  },
  TestRWA: {
    file: "TestRWA.sol",
    constructorArgs: (walletAddr) => [walletAddr],
    writeFns: [
      {
        name: "transfer",
        args: () => [ethers.Wallet.createRandom().address, ethers.parseEther(randomInRange(0.001, 10).toString())],
      },
      {
        name: "approve",
        args: () => [ethers.Wallet.createRandom().address, ethers.parseEther(randomInRange(1, 100).toString())],
      },
      {
        name: "burn",
        args: () => [ethers.parseEther(randomInRange(0.001, 5).toString())],
      },
    ],
  },
  SimpleEscrow: {
    file: "SimpleEscrow.sol",
    constructorArgs: () => [
      ethers.Wallet.createRandom().address, // _seller
      ethers.Wallet.createRandom().address, // _arbiter
    ],
    writeFns: [
      {
        name: "fund",
        args: () => [],
        value: () => ethers.parseEther(randomInRange(0.001, 0.005).toString()),
      },
      { name: "release", args: () => [] },
      { name: "refund", args: () => [] },
    ],
  },
  MYTOKEN: {
    file: "MYTOKEN.sol",
    constructorArgs: (walletAddr) => [walletAddr],
    writeFns: [
      {
        name: "transfer",
        args: () => [ethers.Wallet.createRandom().address, ethers.parseEther(randomInRange(0.001, 10).toString())],
      },
      {
        name: "approve",
        args: () => [ethers.Wallet.createRandom().address, ethers.parseEther(randomInRange(1, 100).toString())],
      },
      {
        name: "burn",
        args: () => [ethers.parseEther(randomInRange(0.001, 5).toString())],
      },
    ],
  },
  MessageBoard: {
    file: "MessageBoard.sol",
    constructorArgs: () => [pickRandom(RANDOM_MESSAGES)],
    writeFns: [
      {
        name: "updateMessage",
        args: () => [pickRandom(RANDOM_MESSAGES)],
      },
    ],
  },
};

const CONTRACT_NAMES = Object.keys(CONTRACT_SPECS);

// ─────────────────────────────────────────────────────────────────────────────
// Globals
// ─────────────────────────────────────────────────────────────────────────────
let provider;
let masterWallet;
let shuttingDown = false;
let cycleRunning = false;

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInRange(min, max) {
  return +(min + Math.random() * (max - min)).toFixed(6);
}

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function logTag() {
  return `[${ts()}]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging — writes to bot.log AND console simultaneously
// ─────────────────────────────────────────────────────────────────────────────
async function log(msg) {
  const line = `${logTag()} ${msg}`;
  console.log(line);
  await fs.appendFile(BOT_LOG_FILE, line + "\n").catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON file helpers (append-mode arrays)
// ─────────────────────────────────────────────────────────────────────────────
async function readJsonArray(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function appendJsonEntry(filePath, entry) {
  const arr = await readJsonArray(filePath);
  arr.push(entry);
  await fs.writeFile(filePath, JSON.stringify(arr, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Compilation — run compile.js if /compiled is missing any contract
// ─────────────────────────────────────────────────────────────────────────────
async function ensureCompiled() {
  let needsCompile = false;

  try {
    const files = await fs.readdir(COMPILED_DIR);
    for (const name of CONTRACT_NAMES) {
      if (!files.includes(`${name}.json`)) {
        needsCompile = true;
        break;
      }
    }
  } catch {
    needsCompile = true;
  }

  if (needsCompile) {
    await log("Compiled artifacts missing — running compile.js ...");
    execSync("node compile.js", { cwd: __dirname, stdio: "inherit" });
    await log("Compilation complete.");
  }
}

function loadArtifact(contractName) {
  const filePath = path.join(COMPILED_DIR, `${contractName}.json`);
  return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select a wallet: 50% chance new, 50% chance reuse from wallets.json.
 * Returns an ethers.Wallet connected to the provider.
 */
async function selectWallet() {
  const existing = await readJsonArray(WALLETS_FILE);
  const reuseExisting = existing.length > 0 && Math.random() < 0.5;

  if (reuseExisting) {
    const entry = pickRandom(existing);
    const wallet = new ethers.Wallet(entry.privateKey, provider);
    await log(`Wallet: REUSED ${wallet.address}`);
    return wallet;
  }

  // Generate fresh wallet
  const fresh = ethers.Wallet.createRandom().connect(provider);
  await appendJsonEntry(WALLETS_FILE, {
    address: fresh.address,
    privateKey: fresh.privateKey,
    createdAt: new Date().toISOString(),
  });
  await log(`Wallet: NEW ${fresh.address}`);
  return fresh;
}

// ─────────────────────────────────────────────────────────────────────────────
// Funding — master wallet tops up sub-wallet if needed
// ─────────────────────────────────────────────────────────────────────────────
async function ensureFunded(wallet) {
  // Wait until master wallet has enough balance
  while (true) {
    const masterBal = await provider.getBalance(masterWallet.address);
    if (masterBal >= ethers.parseEther(MIN_MASTER_BALANCE.toString())) break;

    await log(
      `WARNING: Master wallet balance ${ethers.formatEther(masterBal)} ETH < ` +
        `minimum ${MIN_MASTER_BALANCE} ETH — waiting 30s ...`
    );
    await sleep(30_000);
    if (shuttingDown) return;
  }

  // Check sub-wallet balance
  const balance = await provider.getBalance(wallet.address);
  const needed = ethers.parseEther(FUND_AMOUNT_MIN.toString());

  if (balance >= needed) {
    await log(`Balance: ${ethers.formatEther(balance)} ETH — sufficient`);
    return;
  }

  // Fund with random amount in range
  const amount = randomInRange(FUND_AMOUNT_MIN, FUND_AMOUNT_MAX);
  const value = ethers.parseEther(amount.toString());

  await log(`Funding ${wallet.address} with ${amount} ETH from master ...`);
  const tx = await masterWallet.sendTransaction({
    to: wallet.address,
    value,
  });
  await tx.wait();
  await log(`Funded. TX: ${tx.hash}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deploy action
// ─────────────────────────────────────────────────────────────────────────────
async function deployContract(wallet, contractName) {
  const spec = CONTRACT_SPECS[contractName];
  const artifact = loadArtifact(contractName);

  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet
  );

  const args = spec.constructorArgs(wallet.address);
  await log(`Deploying ${contractName} with args: [${args}]`);

  const contract = await factory.deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();

  const addr = await contract.getAddress();
  await log(
    `Deployed ${contractName} at ${addr} | TX: ${receipt.hash} | Gas: ${receipt.gasUsed}`
  );

  return {
    txHash: receipt.hash,
    contractAddress: addr,
    gasUsed: receipt.gasUsed.toString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Call action — invoke a random write function on a previously deployed contract
// ─────────────────────────────────────────────────────────────────────────────
async function callContract(wallet, contractName) {
  const spec = CONTRACT_SPECS[contractName];
  const artifact = loadArtifact(contractName);

  // Find a deployed address for this contract from txLogs
  const logs = await readJsonArray(TX_LOGS_FILE);
  const deployed = logs.filter(
    (l) =>
      l.contract === contractName &&
      l.action === "deploy" &&
      l.status === "success" &&
      l.contractAddress
  );

  if (deployed.length === 0) {
    await log(
      `No deployed ${contractName} found — switching to DEPLOY action`
    );
    return deployContract(wallet, contractName);
  }

  const target = pickRandom(deployed);
  const fnSpec = pickRandom(spec.writeFns);

  const contract = new ethers.Contract(
    target.contractAddress,
    artifact.abi,
    wallet
  );

  const args = fnSpec.args();
  const overrides = {};
  if (fnSpec.value) overrides.value = fnSpec.value();

  await log(
    `Calling ${contractName}.${fnSpec.name}(${args.map(String).join(", ")}) at ${target.contractAddress}`
  );

  const tx = await contract[fnSpec.name](...args, overrides);
  const receipt = await tx.wait();

  await log(
    `Call SUCCESS | TX: ${receipt.hash} | Gas: ${receipt.gasUsed}`
  );

  return {
    txHash: receipt.hash,
    contractAddress: target.contractAddress,
    gasUsed: receipt.gasUsed.toString(),
    fn: fnSpec.name,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Retry wrapper — up to 3 retries with exponential backoff
// ─────────────────────────────────────────────────────────────────────────────
const BACKOFF = [2000, 5000, 10000];

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const result = await fn();
      return { ...result, retries: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        const delay = BACKOFF[attempt];
        await log(
          `  Attempt ${attempt + 1} failed: ${err.message} — retrying in ${delay / 1000}s`
        );
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single bot cycle
// ─────────────────────────────────────────────────────────────────────────────
async function runCycle() {
  if (shuttingDown) return;
  cycleRunning = true;

  await log("─── CYCLE START ───────────────────────────────────────────");

  const action = Math.random() < 0.5 ? "deploy" : "call";
  const contractName = pickRandom(CONTRACT_NAMES);

  try {
    // 1. Select wallet
    const wallet = await selectWallet();

    // 2. Fund wallet from master
    await ensureFunded(wallet);
    if (shuttingDown) { cycleRunning = false; return; }

    // 3. Execute action
    await log(`Action: ${action.toUpperCase()} | Contract: ${contractName}`);

    const result = await withRetry(() =>
      action === "deploy"
        ? deployContract(wallet, contractName)
        : callContract(wallet, contractName)
    );

    // 4. Log success
    await appendJsonEntry(TX_LOGS_FILE, {
      timestamp: new Date().toISOString(),
      action,
      contract: contractName,
      wallet: wallet.address,
      txHash: result.txHash,
      contractAddress: result.contractAddress || null,
      gasUsed: result.gasUsed,
      status: "success",
      retries: result.retries,
      ...(result.fn ? { function: result.fn } : {}),
    });

    await log(`TX Hash: ${result.txHash} | Status: SUCCESS | Gas: ${result.gasUsed}`);
  } catch (err) {
    // Log failure after all retries exhausted
    await log(`FAILED after retries: ${err.message}`);
    await appendJsonEntry(TX_LOGS_FILE, {
      timestamp: new Date().toISOString(),
      action,
      contract: contractName,
      wallet: "unknown",
      txHash: null,
      contractAddress: null,
      gasUsed: null,
      status: "failed",
      error: err.message,
      retries: 3,
    });
  }

  // Schedule next cycle
  const delay = Math.floor(Math.random() * 60000);
  await log(`─── CYCLE END ── next in ~${Math.round(delay / 1000)}s ───`);
  await log("");
  cycleRunning = false;

  if (!shuttingDown) {
    setTimeout(runCycle, delay);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("\nShutting down gracefully ...");
  shuttingDown = true;
  if (!cycleRunning) process.exit(0);
  // If a cycle is running, it will check shuttingDown and exit cleanly
  const check = setInterval(() => {
    if (!cycleRunning) {
      clearInterval(check);
      console.log("Bot stopped.");
      process.exit(0);
    }
  }, 500);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n  ╔══════════════════════════════════════╗");
  console.log("  ║       BLOCKPING ACTIVITY BOT         ║");
  console.log("  ╚══════════════════════════════════════╝\n");

  // Validate env
  if (!RPC_URL || !MNEMONIC) {
    console.error("ERROR: RPC_URL and MNEMONIC must be set in .env");
    process.exit(1);
  }

  // Provider & master wallet
  provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  masterWallet = ethers.HDNodeWallet.fromMnemonic(
    ethers.Mnemonic.fromPhrase(MNEMONIC),
    "m/44'/60'/0'/0/0"
  ).connect(provider);

  await log(`Master wallet: ${masterWallet.address}`);
  const masterBal = await provider.getBalance(masterWallet.address);
  await log(`Master balance: ${ethers.formatEther(masterBal)} ETH`);
  await log(`RPC: ${RPC_URL}  |  Chain ID: ${CHAIN_ID}`);
  await log("");

  // Compile contracts if needed
  await ensureCompiled();

  // Verify all artifacts load
  for (const name of CONTRACT_NAMES) {
    loadArtifact(name);
  }
  await log(`Loaded ${CONTRACT_NAMES.length} contract artifacts: ${CONTRACT_NAMES.join(", ")}`);
  await log("Bot started — Ctrl+C to stop\n");

  // Kick off first cycle with a small random delay
  const initialDelay = Math.floor(Math.random() * 5000);
  setTimeout(runCycle, initialDelay);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
