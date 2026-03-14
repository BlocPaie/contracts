import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const RECIPIENT = "0x793b8BfD1fC05786286790DCDFA84424aED3e277";
const AMOUNT = ethers.parseUnits("1000000", 6); // 1,000,000 USDC (6 decimals)

async function main() {
  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../deployments/sepolia.json"), "utf8")
  );
  const mockUsdcAddr = deployment.contracts.MockUSDC;

  const [signer] = await ethers.getSigners();
  console.log("Minting with account:", signer.address);

  const usdc = await ethers.getContractAt("MockERC20", mockUsdcAddr, signer);

  const tx = await usdc.mint(RECIPIENT, AMOUNT);
  console.log("Tx submitted:", tx.hash);
  await tx.wait();

  const balance = await usdc.balanceOf(RECIPIENT);
  console.log(`Done — ${RECIPIENT} balance: ${ethers.formatUnits(balance, 6)} USDC`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
