/**
 * compile.js — Solidity Compiler
 *
 * Compiles every .sol file in /contracts using solc and writes
 * ABI + bytecode JSON to /compiled/<ContractName>.json.
 * OpenZeppelin imports are resolved from node_modules.
 */

const solc = require("solc");
const fs = require("fs/promises");
const path = require("path");

const CONTRACTS_DIR = path.join(__dirname, "contracts");
const COMPILED_DIR = path.join(__dirname, "compiled");
const NODE_MODULES = path.join(__dirname, "node_modules");

// ── Import resolver for solc ────────────────────────────────────────────────
function findImports(importPath) {
  // Resolve @openzeppelin and any other node_modules imports
  const candidates = [
    path.join(NODE_MODULES, importPath),
    path.join(CONTRACTS_DIR, importPath),
  ];

  for (const candidate of candidates) {
    try {
      // Use synchronous read because solc's import callback is synchronous
      const content = require("fs").readFileSync(candidate, "utf8");
      return { contents: content };
    } catch {
      // try next candidate
    }
  }

  return { error: `File not found: ${importPath}` };
}

// ── Compile a single .sol file ──────────────────────────────────────────────
async function compileSolFile(filePath) {
  const fileName = path.basename(filePath);
  const source = await fs.readFile(filePath, "utf8");

  const input = {
    language: "Solidity",
    sources: {
      [fileName]: { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(
    solc.compile(JSON.stringify(input), { import: findImports })
  );

  // Check for errors (warnings are OK)
  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === "error");
    if (fatal.length > 0) {
      console.error(`\n  Compilation errors in ${fileName}:`);
      fatal.forEach((e) => console.error(`    ${e.formattedMessage}`));
      throw new Error(`Failed to compile ${fileName}`);
    }
    // Print warnings
    const warnings = output.errors.filter((e) => e.severity === "warning");
    warnings.forEach((w) =>
      console.warn(`  [WARN] ${fileName}: ${w.message}`)
    );
  }

  // Extract every contract defined in this file
  const fileContracts = output.contracts[fileName];
  if (!fileContracts) {
    throw new Error(`No contracts found in ${fileName}`);
  }

  const results = [];
  for (const [contractName, contractData] of Object.entries(fileContracts)) {
    const artifact = {
      contractName,
      abi: contractData.abi,
      bytecode: "0x" + contractData.evm.bytecode.object,
    };

    const outPath = path.join(COMPILED_DIR, `${contractName}.json`);
    await fs.writeFile(outPath, JSON.stringify(artifact, null, 2));
    results.push(contractName);
  }

  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Blockping Solidity Compiler ===\n");

  // Ensure compiled output directory exists
  await fs.mkdir(COMPILED_DIR, { recursive: true });

  // Discover .sol files
  const files = (await fs.readdir(CONTRACTS_DIR)).filter((f) =>
    f.endsWith(".sol")
  );

  if (files.length === 0) {
    console.log("  No .sol files found in /contracts");
    return;
  }

  console.log(`  Found ${files.length} contract file(s):\n`);

  let totalContracts = 0;

  for (const file of files) {
    const filePath = path.join(CONTRACTS_DIR, file);
    try {
      const compiled = await compileSolFile(filePath);
      compiled.forEach((name) => console.log(`  ✓  ${file} → ${name}.json`));
      totalContracts += compiled.length;
    } catch (err) {
      console.error(`  ✗  ${file} — ${err.message}`);
    }
  }

  console.log(`\n  Done. ${totalContracts} contract(s) compiled to /compiled\n`);
}

main().catch((err) => {
  console.error("Compiler failed:", err);
  process.exit(1);
});
