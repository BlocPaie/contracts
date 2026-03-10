import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // ── Deploy MockUSDC ────────────────────────────────────────────────
  const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  console.log("MockUSDC deployed to:", usdcAddr);

  // ── Deploy ConfidentialUSDC ────────────────────────────────────────
  // No gateway address needed — fulfillUnwrap is trustless via FHE.checkSignatures.
  // Anyone can call fulfillUnwrap with a valid KMS decryption proof.
  // On Sepolia: obtain proofs from https://relayer.testnet.zama.org
  const confidentialUsdc = await (await ethers.getContractFactory("ConfidentialUSDC")).deploy(usdcAddr);
  await confidentialUsdc.waitForDeployment();
  const confidentialUsdcAddr = await confidentialUsdc.getAddress();
  console.log("ConfidentialUSDC deployed to:", confidentialUsdcAddr);

  // ── Deploy VaultFactory ────────────────────────────────────────────
  const factory = await (await ethers.getContractFactory("VaultFactory")).deploy();
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("VaultFactory deployed to:", factoryAddr);

  // ── Register ERC20Vault type ───────────────────────────────────────
  const ERC20_VAULT_TYPE = ethers.keccak256(ethers.toUtf8Bytes("ERC20Vault"));
  const erc20VaultCode = (await ethers.getContractFactory("ERC20Vault")).bytecode;
  const tx1 = await factory.registerVaultType(ERC20_VAULT_TYPE, erc20VaultCode);
  await tx1.wait();
  console.log("ERC20Vault type registered:", ERC20_VAULT_TYPE);

  // ── Register ConfidentialVault type ───────────────────────────────
  const CONF_VAULT_TYPE = ethers.keccak256(ethers.toUtf8Bytes("ConfidentialVault"));
  const confVaultCode = (await ethers.getContractFactory("ConfidentialVault")).bytecode;
  const tx2 = await factory.registerVaultType(CONF_VAULT_TYPE, confVaultCode);
  await tx2.wait();
  console.log("ConfidentialVault type registered:", CONF_VAULT_TYPE);

  // ── Summary ────────────────────────────────────────────────────────
  console.log("\nDeployment complete:");
  console.log("  MockUSDC:          ", usdcAddr);
  console.log("  ConfidentialUSDC:  ", confidentialUsdcAddr);
  console.log("  VaultFactory:      ", factoryAddr);
  console.log("  ERC20Vault type:   ", ERC20_VAULT_TYPE);
  console.log("  ConfVault type:    ", CONF_VAULT_TYPE);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

