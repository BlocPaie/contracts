import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ERC20Vault, MockERC20, VaultFactory } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ERC20Vault", function () {
  const AMOUNT = 1000n * 10n ** 6n;
  const INV_HASH = ethers.keccak256(ethers.toUtf8Bytes("INV-001"));
  const VAULT_TYPE = ethers.keccak256(ethers.toUtf8Bytes("ERC20Vault"));

  async function parseVaultCreated(vaultFactory: VaultFactory, tx: any): Promise<string> {
    const receipt = await tx.wait();
    const event = receipt!.logs.map((l: any) => {
      try { return vaultFactory.interface.parseLog({ topics: l.topics as string[], data: l.data }); }
      catch { return null; }
    }).find((e: any) => e?.name === "VaultCreated");
    return event!.args.vault;
  }

  async function deployFixture() {
    const [_deployer, owner, contractor, stranger] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6) as MockERC20;

    const vaultFactory = await (await ethers.getContractFactory("VaultFactory")).deploy() as VaultFactory;
    await vaultFactory.registerVaultType(VAULT_TYPE, (await ethers.getContractFactory("ERC20Vault")).bytecode);

    const tx = await vaultFactory.connect(owner).createVault(VAULT_TYPE, await usdc.getAddress());
    const vault = await ethers.getContractAt("ERC20Vault", await parseVaultCreated(vaultFactory, tx)) as ERC20Vault;

    await usdc.mint(owner.address, 100_000n * 10n ** 6n);
    await usdc.connect(owner).approve(await vault.getAddress(), ethers.MaxUint256);

    return { vault, usdc, owner, contractor, stranger, vaultFactory };
  }

  // ── Constructor ─────────────────────────────────────────────────────

  describe("Constructor", function () {
    it("sets owner", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      expect(await vault.owner()).to.equal(owner.address);
    });

    it("sets USDC", async function () {
      const { vault, usdc } = await loadFixture(deployFixture);
      expect(await vault.USDC()).to.equal(await usdc.getAddress());
    });

    it("reverts on zero USDC address", async function () {
      const [_, owner] = await ethers.getSigners();
      const vaultFactory = await (await ethers.getContractFactory("VaultFactory")).deploy() as VaultFactory;
      await vaultFactory.registerVaultType(VAULT_TYPE, (await ethers.getContractFactory("ERC20Vault")).bytecode);
      await expect(vaultFactory.connect(owner).createVault(VAULT_TYPE, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(vaultFactory, "DeploymentFailed");
    });
  });

  // ── depositFunds ────────────────────────────────────────────────────

  describe("depositFunds", function () {
    it("transfers tokens to vault", async function () {
      const { vault, usdc, owner } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(AMOUNT);
    });

    it("emits FundsDeposited event", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      await expect(vault.connect(owner).depositFunds(AMOUNT))
        .to.emit(vault, "FundsDeposited")
        .withArgs(AMOUNT);
    });

    it("reverts if not owner", async function () {
      const { vault, stranger } = await loadFixture(deployFixture);
      await expect(vault.connect(stranger).depositFunds(AMOUNT))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    });

    it("reverts if zero amount", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      await expect(vault.connect(owner).depositFunds(0))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts if no approval", async function () {
      const { usdc, stranger, vaultFactory } = await loadFixture(deployFixture);
      const tx = await vaultFactory.connect(stranger).createVault(VAULT_TYPE, await usdc.getAddress());
      const vault2 = await ethers.getContractAt("ERC20Vault", await parseVaultCreated(vaultFactory, tx));
      await usdc.mint(stranger.address, AMOUNT);
      await expect(vault2.connect(stranger).depositFunds(AMOUNT)).to.be.reverted;
    });
  });

  // ── withdrawFunds ───────────────────────────────────────────────────

  describe("withdrawFunds", function () {
    it("transfers tokens to owner", async function () {
      const { vault, usdc, owner } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      const balanceBefore = await usdc.balanceOf(owner.address);
      await vault.connect(owner).withdrawFunds(AMOUNT);
      expect(await usdc.balanceOf(owner.address)).to.equal(balanceBefore + AMOUNT);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0);
    });

    it("emits FundsWithdrawn event", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await expect(vault.connect(owner).withdrawFunds(AMOUNT))
        .to.emit(vault, "FundsWithdrawn")
        .withArgs(AMOUNT);
    });

    it("reverts if not owner", async function () {
      const { vault, usdc, owner, stranger } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await expect(vault.connect(stranger).withdrawFunds(AMOUNT))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    });

    it("reverts if zero amount", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      await expect(vault.connect(owner).withdrawFunds(0))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts if exceeds available balance", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await expect(vault.connect(owner).withdrawFunds(AMOUNT + 1n))
        .to.be.revertedWithCustomError(vault, "InsufficientAvailableBalance");
    });

    it("respects allocated balance", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 600n * 10n ** 6n);

      // Only 400e6 available
      await expect(vault.connect(owner).withdrawFunds(500n * 10n ** 6n))
        .to.be.revertedWithCustomError(vault, "InsufficientAvailableBalance");

      // 400e6 should succeed
      await vault.connect(owner).withdrawFunds(400n * 10n ** 6n);
    });
  });

  // ── registerInvoice ─────────────────────────────────────────────────

  describe("registerInvoice", function () {
    it("creates cheque with correct fields", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);

      expect(await vault.allocatedBalance()).to.equal(500n * 10n ** 6n);
      expect(await vault.invoiceRegistry(INV_HASH)).to.be.true;

      const cheque = await vault.getCheque(contractor.address, 0);
      expect(cheque.invoiceHash).to.equal(INV_HASH);
      expect(cheque.amount).to.equal(500n * 10n ** 6n);
      expect(cheque.status).to.equal(0); // Pending
    });

    it("emits ChequeCreated event", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await expect(vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n))
        .to.emit(vault, "ChequeCreated")
        .withArgs(contractor.address, 0, INV_HASH, 500n * 10n ** 6n);
    });

    it("increments cheque id per payee", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);

      const tx0 = await vault.connect(owner).registerInvoice(
        ethers.keccak256(ethers.toUtf8Bytes("INV-1")), contractor.address, 100n * 10n ** 6n
      );
      const tx1 = await vault.connect(owner).registerInvoice(
        ethers.keccak256(ethers.toUtf8Bytes("INV-2")), contractor.address, 100n * 10n ** 6n
      );

      const receipt0 = await tx0.wait();
      const receipt1 = await tx1.wait();
      const event0 = receipt0!.logs.map(l => { try { return vault.interface.parseLog({ topics: l.topics as string[], data: l.data }); } catch { return null; } }).find(e => e?.name === "ChequeCreated");
      const event1 = receipt1!.logs.map(l => { try { return vault.interface.parseLog({ topics: l.topics as string[], data: l.data }); } catch { return null; } }).find(e => e?.name === "ChequeCreated");

      expect(event0!.args.chequeId).to.equal(0);
      expect(event1!.args.chequeId).to.equal(1);
    });

    it("reverts if not owner", async function () {
      const { vault, stranger, contractor } = await loadFixture(deployFixture);
      await expect(vault.connect(stranger).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    });

    it("reverts if zero invoice hash", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await expect(vault.connect(owner).registerInvoice(ethers.ZeroHash, contractor.address, 500n * 10n ** 6n))
        .to.be.revertedWithCustomError(vault, "InvalidInvoiceHash");
    });

    it("reverts if zero payee", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await expect(vault.connect(owner).registerInvoice(INV_HASH, ethers.ZeroAddress, 500n * 10n ** 6n))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("reverts if zero amount", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await expect(vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 0))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts if duplicate invoice hash", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);
      await expect(vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n))
        .to.be.revertedWithCustomError(vault, "InvoiceAlreadyRegistered");
    });

    it("reverts if insufficient funds", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await expect(vault.connect(owner).registerInvoice(INV_HASH, contractor.address, AMOUNT + 1n))
        .to.be.revertedWithCustomError(vault, "InsufficientAvailableBalance");
    });
  });

  // ── executeCheque ───────────────────────────────────────────────────

  describe("executeCheque", function () {
    it("transfers to payee and updates state", async function () {
      const { vault, usdc, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);

      const balanceBefore = await usdc.balanceOf(contractor.address);
      await vault.connect(contractor).executeCheque(0);

      expect(await usdc.balanceOf(contractor.address)).to.equal(balanceBefore + 500n * 10n ** 6n);
      expect(await vault.allocatedBalance()).to.equal(0);

      const cheque = await vault.getCheque(contractor.address, 0);
      expect(cheque.status).to.equal(1); // Executed
    });

    it("emits ChequeExecuted event", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);
      await expect(vault.connect(contractor).executeCheque(0))
        .to.emit(vault, "ChequeExecuted")
        .withArgs(contractor.address, 0);
    });

    it("reverts if not payee (stranger has no cheques)", async function () {
      const { vault, owner, contractor, stranger } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);
      await expect(vault.connect(stranger).executeCheque(0))
        .to.be.revertedWithCustomError(vault, "InvalidChequeId");
    });

    it("reverts if owner calls but is not payee", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);
      await expect(vault.connect(owner).executeCheque(0))
        .to.be.revertedWithCustomError(vault, "InvalidChequeId");
    });

    it("reverts if invalid cheque id", async function () {
      const { vault, contractor } = await loadFixture(deployFixture);
      await expect(vault.connect(contractor).executeCheque(999))
        .to.be.revertedWithCustomError(vault, "InvalidChequeId");
    });

    it("reverts if already executed", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);
      await vault.connect(contractor).executeCheque(0);
      await expect(vault.connect(contractor).executeCheque(0))
        .to.be.revertedWithCustomError(vault, "ChequeNotPending");
    });

    it("reverts if cancelled", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);
      await vault.connect(owner).cancelCheque(contractor.address, 0);
      await expect(vault.connect(contractor).executeCheque(0))
        .to.be.revertedWithCustomError(vault, "ChequeNotPending");
    });
  });

  // ── cancelCheque ────────────────────────────────────────────────────

  describe("cancelCheque", function () {
    it("cancels and updates state", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);
      await vault.connect(owner).cancelCheque(contractor.address, 0);

      expect(await vault.allocatedBalance()).to.equal(0);
      const cheque = await vault.getCheque(contractor.address, 0);
      expect(cheque.status).to.equal(2); // Cancelled
    });

    it("emits ChequeCancelled event", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);
      await expect(vault.connect(owner).cancelCheque(contractor.address, 0))
        .to.emit(vault, "ChequeCancelled")
        .withArgs(contractor.address, 0);
    });

    it("releases allocated balance for withdrawal", async function () {
      const { vault, usdc, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 600n * 10n ** 6n);
      expect(await vault.allocatedBalance()).to.equal(600n * 10n ** 6n);

      await vault.connect(owner).cancelCheque(contractor.address, 0);
      expect(await vault.allocatedBalance()).to.equal(0);

      await vault.connect(owner).withdrawFunds(AMOUNT);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0);
    });

    it("reverts if not owner", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);
      await expect(vault.connect(contractor).cancelCheque(contractor.address, 0))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(contractor.address);
    });

    it("reverts if not pending (already executed)", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, contractor.address, 500n * 10n ** 6n);
      await vault.connect(contractor).executeCheque(0);
      await expect(vault.connect(owner).cancelCheque(contractor.address, 0))
        .to.be.revertedWithCustomError(vault, "ChequeNotPending");
    });

    it("reverts if invalid cheque id", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await expect(vault.connect(owner).cancelCheque(contractor.address, 0))
        .to.be.revertedWithCustomError(vault, "InvalidChequeId");
    });
  });

  // ── View Functions ──────────────────────────────────────────────────

  describe("View Functions", function () {
    it("getCheque reverts on invalid id", async function () {
      const { vault, contractor } = await loadFixture(deployFixture);
      await expect(vault.getCheque(contractor.address, 0))
        .to.be.revertedWithCustomError(vault, "InvalidChequeId");
    });

    it("getCheques returns empty for new payee", async function () {
      const { vault, contractor } = await loadFixture(deployFixture);
      const cheques = await vault.getCheques(contractor.address);
      expect(cheques.length).to.equal(0);
    });

    it("getCheques returns all cheques", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      await vault.connect(owner).registerInvoice(ethers.keccak256(ethers.toUtf8Bytes("INV-1")), contractor.address, 100n * 10n ** 6n);
      await vault.connect(owner).registerInvoice(ethers.keccak256(ethers.toUtf8Bytes("INV-2")), contractor.address, 200n * 10n ** 6n);
      await vault.connect(owner).registerInvoice(ethers.keccak256(ethers.toUtf8Bytes("INV-3")), contractor.address, 300n * 10n ** 6n);

      const cheques = await vault.getCheques(contractor.address);
      expect(cheques.length).to.equal(3);
      expect(cheques[0].amount).to.equal(100n * 10n ** 6n);
      expect(cheques[1].amount).to.equal(200n * 10n ** 6n);
      expect(cheques[2].amount).to.equal(300n * 10n ** 6n);
    });

    it("getChequeCount returns correct count", async function () {
      const { vault, owner, contractor } = await loadFixture(deployFixture);
      await vault.connect(owner).depositFunds(AMOUNT);
      expect(await vault.getChequeCount(contractor.address)).to.equal(0);

      await vault.connect(owner).registerInvoice(ethers.keccak256(ethers.toUtf8Bytes("INV-1")), contractor.address, 100n * 10n ** 6n);
      await vault.connect(owner).registerInvoice(ethers.keccak256(ethers.toUtf8Bytes("INV-2")), contractor.address, 200n * 10n ** 6n);
      expect(await vault.getChequeCount(contractor.address)).to.equal(2);
    });
  });
});
