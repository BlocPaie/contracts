import { ethers, network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Usage: npx hardhat run scripts/verify-vault.ts --network sepolia
// Set VAULT_ADDRESS env var to the vault address to verify.
// e.g. VAULT_ADDRESS=0x123... npx hardhat run scripts/verify-vault.ts --network sepolia

async function main() {
  const vaultAddr = process.env.VAULT_ADDRESS;
  if (!vaultAddr) throw new Error("Set VAULT_ADDRESS env var to the vault address to verify.");

  const deploymentPath = path.join(__dirname, `../deployments/${network.name}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment found for network "${network.name}".`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  // Read constructor args directly from the deployed vault.
  const vault = await ethers.getContractAt("ConfidentialVault", vaultAddr);
  const owner = await vault.owner();
  const token = await vault.TOKEN();

  // Determine vault type by checking which type key the factory used.
  const factory = await ethers.getContractAt("VaultFactory", deployment.contracts.VaultFactory);
  const events = await factory.queryFilter(factory.filters.VaultCreated(vaultAddr));

  let contractPath: string;
  if (events.length > 0) {
    const vaultType: string = (events[0] as any).args.vaultType;
    const confVaultType = ethers.keccak256(ethers.toUtf8Bytes("ConfidentialVault"));
    contractPath = vaultType === confVaultType
      ? "contracts/ConfidentialVault.sol:ConfidentialVault"
      : "contracts/ERC20Vault.sol:ERC20Vault";
  } else {
    // Fallback: try ConfidentialVault (has TOKEN() and owner())
    contractPath = "contracts/ConfidentialVault.sol:ConfidentialVault";
  }

  console.log(`Verifying ${contractPath} at ${vaultAddr}`);
  console.log(`  owner: ${owner}`);
  console.log(`  token: ${token}`);

  await run("verify:verify", {
    address: vaultAddr,
    contract: contractPath,
    constructorArguments: [owner, token],
  });

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
