import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const deploymentPath = path.join(__dirname, `../deployments/${network.name}.json`);
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`No deployment found for network "${network.name}". Run the deploy script first.`);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const factoryAddr = deployment.contracts.VaultFactory;
  const vaultTypes: Record<string, string> = deployment.vaultTypes;

  const [signer] = await ethers.getSigners();
  console.log("Updating with account:", signer.address);
  console.log("VaultFactory:", factoryAddr);

  const factory = await ethers.getContractAt("VaultFactory", factoryAddr, signer);

  for (const [name, typeKey] of Object.entries(vaultTypes)) {
    const newBytecode = (await ethers.getContractFactory(name)).bytecode;
    const onChainBytecode = await factory.vaultBytecode(typeKey);

    if (ethers.keccak256(newBytecode) === ethers.keccak256(onChainBytecode)) {
      console.log(`\n${name}: bytecode unchanged, skipping.`);
      continue;
    }

    console.log(`\n${name}: bytecode changed, updating...`);
    const tx = await factory.updateVaultType(typeKey, newBytecode);
    console.log("  Tx submitted:", tx.hash);
    await tx.wait();
    console.log("  Done.");
  }

  console.log("\nFinished.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
