import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // Deploy VaultFactory
  const factory = await (await ethers.getContractFactory("VaultFactory")).deploy();
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("VaultFactory deployed to:", factoryAddr);

  // Register ERC20Vault type
  const VAULT_TYPE = ethers.keccak256(ethers.toUtf8Bytes("ERC20Vault"));
  const vaultCreationCode = (await ethers.getContractFactory("ERC20Vault")).bytecode;
  const tx = await factory.registerVaultType(VAULT_TYPE, vaultCreationCode);
  await tx.wait();
  console.log("ERC20Vault type registered:", VAULT_TYPE);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
