import * as fs from "fs";
import * as path from "path";

const CONTRACTS = [
  "VaultFactory",
  "ERC20Vault",
  "ConfidentialVault",
  "ConfidentialUSDC",
  "MockERC20",
];

async function main() {
  const artifactsDir = path.join(__dirname, "../artifacts/contracts");
  const abiDir = path.join(__dirname, "../abi");
  fs.mkdirSync(abiDir, { recursive: true });

  for (const name of CONTRACTS) {
    const artifactPath = findArtifact(artifactsDir, `${name}.json`);
    if (!artifactPath) {
      console.warn(`Artifact not found for ${name} — run 'npx hardhat compile' first`);
      continue;
    }
    const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const outPath = path.join(abiDir, `${name}.json`);
    fs.writeFileSync(outPath, JSON.stringify(abi, null, 2));
    console.log(`Exported ${name}.json`);
  }

  console.log(`\nABIs written to abi/`);
}

function findArtifact(dir: string, filename: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const result = findArtifact(full, filename);
      if (result) return result;
    } else if (entry.name === filename && !entry.name.endsWith(".dbg.json")) {
      return full;
    }
  }
  return null;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
