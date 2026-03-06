import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("PayrollFlow (integration)", function () {
  const VAULT_TYPE = ethers.keccak256(ethers.toUtf8Bytes("ERC20Vault"));

  async function fullSetupFixture() {
    const [deployer, contractor1, contractor2] = await ethers.getSigners();

    // Deploy mock USDC
    const usdc = await (await ethers.getContractFactory("MockERC20"))
      .connect(deployer)
      .deploy("USD Coin", "USDC", 6);

    // Deploy factory and register vault type
    const factory = await (await ethers.getContractFactory("VaultFactory"))
      .connect(deployer)
      .deploy();
    const vaultCreationCode = (await ethers.getContractFactory("ERC20Vault")).bytecode;
    await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);

    // Create vault via factory
    const tx = await factory.connect(deployer).createVault(VAULT_TYPE, await usdc.getAddress());
    const receipt = await tx.wait();
    const event = receipt!.logs.map((l: any) => {
      try { return factory.interface.parseLog({ topics: l.topics as string[], data: l.data }); }
      catch { return null; }
    }).find((e: any) => e?.name === "VaultCreated");
    const vaultAddr = event!.args.vault;

    const vault = await ethers.getContractAt("ERC20Vault", vaultAddr);

    // Mint USDC to deployer and approve vault
    const depositAmount = 10_000n * 10n ** 6n; // 10,000 USDC
    await usdc.mint(deployer.address, depositAmount);
    await usdc.connect(deployer).approve(vaultAddr, depositAmount);

    return { deployer, contractor1, contractor2, usdc, factory, vault, vaultAddr, depositAmount };
  }

  it("end-to-end: factory deploy → deposit → 3 invoices → execute/cancel → withdraw", async function () {
    const { deployer, contractor1, contractor2, usdc, vault, vaultAddr, depositAmount } =
      await loadFixture(fullSetupFixture);

    // ── Deposit funds ─────────────────────────────────────────────────
    await vault.connect(deployer).depositFunds(depositAmount);
    expect(await usdc.balanceOf(vaultAddr)).to.equal(depositAmount);

    // ── Register 3 invoices ───────────────────────────────────────────
    const inv1 = ethers.keccak256(ethers.toUtf8Bytes("INV-001"));
    const inv2 = ethers.keccak256(ethers.toUtf8Bytes("INV-002"));
    const inv3 = ethers.keccak256(ethers.toUtf8Bytes("INV-003"));

    const amt1 = 1_000n * 10n ** 6n; // 1,000 USDC
    const amt2 = 2_000n * 10n ** 6n; // 2,000 USDC
    const amt3 = 500n * 10n ** 6n;   // 500 USDC

    // Invoice 1 & 2 to contractor1, invoice 3 to contractor2
    const tx1 = await vault.connect(deployer).registerInvoice(inv1, contractor1.address, amt1);
    const tx2 = await vault.connect(deployer).registerInvoice(inv2, contractor2.address, amt2);
    const tx3 = await vault.connect(deployer).registerInvoice(inv3, contractor1.address, amt3);

    // Parse cheque IDs from events
    const parseChequeId = async (tx: any) => {
      const receipt = await tx.wait();
      const event = receipt!.logs.map((l: any) => {
        try { return vault.interface.parseLog({ topics: l.topics as string[], data: l.data }); }
        catch { return null; }
      }).find((e: any) => e?.name === "ChequeCreated");
      return event!.args.chequeId;
    };

    const chequeId1 = await parseChequeId(tx1); // contractor1, cheque 0
    const chequeId2 = await parseChequeId(tx2); // contractor2, cheque 0
    const chequeId3 = await parseChequeId(tx3); // contractor1, cheque 1

    expect(await vault.allocatedBalance()).to.equal(amt1 + amt2 + amt3);

    // ── Execute cheque 1 (contractor1 claims 1,000 USDC) ──────────────
    const c1BalBefore = await usdc.balanceOf(contractor1.address);
    await vault.connect(contractor1).executeCheque(chequeId1);
    expect(await usdc.balanceOf(contractor1.address)).to.equal(c1BalBefore + amt1);

    // ── Cancel cheque 3 (owner cancels contractor1's second cheque) ────
    await vault.connect(deployer).cancelCheque(contractor1.address, chequeId3);

    // Allocated should now only hold cheque 2 (amt2)
    expect(await vault.allocatedBalance()).to.equal(amt2);

    // ── Execute cheque 2 (contractor2 claims 2,000 USDC) ──────────────
    const c2BalBefore = await usdc.balanceOf(contractor2.address);
    await vault.connect(contractor2).executeCheque(chequeId2);
    expect(await usdc.balanceOf(contractor2.address)).to.equal(c2BalBefore + amt2);

    // All allocated funds resolved
    expect(await vault.allocatedBalance()).to.equal(0);

    // ── Withdraw remaining (10,000 - 1,000 - 2,000 = 7,000 USDC) ─────
    const remaining = depositAmount - amt1 - amt2;
    const deployerBalBefore = await usdc.balanceOf(deployer.address);
    await vault.connect(deployer).withdrawFunds(remaining);
    expect(await usdc.balanceOf(deployer.address)).to.equal(deployerBalBefore + remaining);

    // Vault is empty
    expect(await usdc.balanceOf(vaultAddr)).to.equal(0);

    // ── Verify cheque statuses ────────────────────────────────────────
    const c1 = await vault.getCheque(contractor1.address, chequeId1);
    const c2 = await vault.getCheque(contractor2.address, chequeId2);
    const c3 = await vault.getCheque(contractor1.address, chequeId3);
    expect(c1.status).to.equal(1); // Executed
    expect(c2.status).to.equal(1); // Executed
    expect(c3.status).to.equal(2); // Cancelled
  });
});
