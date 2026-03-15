import { ethers, network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  // ── Deploy MockUSDC ────────────────────────────────────────────────
  const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
  await usdc.deploymentTransaction()!.wait(5);
  const usdcAddr = await usdc.getAddress();
  console.log("MockUSDC deployed to:", usdcAddr);

  // ── Deploy ConfidentialUSDC ────────────────────────────────────────
  // No gateway address needed — fulfillUnwrap is trustless via FHE.checkSignatures.
  // Anyone can call fulfillUnwrap with a valid KMS decryption proof.
  // On Sepolia: obtain proofs from https://relayer.testnet.zama.org
  const confidentialUsdc = await (await ethers.getContractFactory("ConfidentialUSDC")).deploy(usdcAddr);
  await confidentialUsdc.deploymentTransaction()!.wait(5);
  const confidentialUsdcAddr = await confidentialUsdc.getAddress();
  console.log("ConfidentialUSDC deployed to:", confidentialUsdcAddr);

  // ── Deploy VaultFactory ────────────────────────────────────────────
  const factory = await (await ethers.getContractFactory("VaultFactory")).deploy();
  await factory.deploymentTransaction()!.wait(5);
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

  // ── Save deployment ───────────────────────────────────────────────
  const deployment = {
    network: network.name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    contracts: {
      MockUSDC: usdcAddr,
      ConfidentialUSDC: confidentialUsdcAddr,
      VaultFactory: factoryAddr,
    },
    vaultTypes: {
      ERC20Vault: ERC20_VAULT_TYPE,
      ConfidentialVault: CONF_VAULT_TYPE,
    },
  };

  const deploymentsDir = path.join(__dirname, "../deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const outPath = path.join(deploymentsDir, `${network.name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));

  // ── Summary ────────────────────────────────────────────────────────
  console.log("\nDeployment complete:");
  console.log("  MockUSDC:          ", usdcAddr);
  console.log("  ConfidentialUSDC:  ", confidentialUsdcAddr);
  console.log("  VaultFactory:      ", factoryAddr);
  console.log("  ERC20Vault type:   ", ERC20_VAULT_TYPE);
  console.log("  ConfVault type:    ", CONF_VAULT_TYPE);
  console.log(`\nSaved to deployments/${network.name}.json`);

  // ── Verify on Etherscan (skipped on local networks) ───────────────
  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log("\nVerifying contracts on Etherscan...");

    await run("verify:verify", {
      address: usdcAddr,
      contract: "contracts/MockERC20.sol:MockERC20",
      constructorArguments: ["USD Coin", "USDC", 6],
    });
    console.log("  MockUSDC verified");

    await run("verify:verify", {
      address: confidentialUsdcAddr,
      contract: "contracts/ConfidentialUSDC.sol:ConfidentialUSDC",
      constructorArguments: [usdcAddr],
    });
    console.log("  ConfidentialUSDC verified");

    await run("verify:verify", {
      address: factoryAddr,
      contract: "contracts/VaultFactory.sol:VaultFactory",
      constructorArguments: [],
    });
    console.log("  VaultFactory verified");

    // Deploy one sample vault of each type and verify it.
    // Etherscan's "Similar Match" then auto-applies the source to every
    // vault deployed from the frontend via the factory (same runtime bytecode).
    const erc20VaultTx = await factory.createVault(ERC20_VAULT_TYPE, usdcAddr);
    const erc20VaultReceipt = await erc20VaultTx.wait(5);
    const erc20VaultAddr = erc20VaultReceipt!.logs
      .map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "VaultCreated")!.args.vault;

    await run("verify:verify", {
      address: erc20VaultAddr,
      contract: "contracts/ERC20Vault.sol:ERC20Vault",
      constructorArguments: [deployer.address, usdcAddr],
    });
    console.log("  ERC20Vault sample verified (auto-matches all future ERC20Vault deployments)");

    const confVaultTx = await factory.createVault(CONF_VAULT_TYPE, confidentialUsdcAddr);
    const confVaultReceipt = await confVaultTx.wait(5);
    const confVaultAddr = confVaultReceipt!.logs
      .map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "VaultCreated")!.args.vault;

    await run("verify:verify", {
      address: confVaultAddr,
      contract: "contracts/ConfidentialVault.sol:ConfidentialVault",
      constructorArguments: [deployer.address, confidentialUsdcAddr],
    });
    console.log("  ConfidentialVault sample verified (auto-matches all future ConfidentialVault deployments)");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

