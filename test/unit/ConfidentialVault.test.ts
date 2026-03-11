import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ConfidentialUSDC, ConfidentialVault, MockERC20, VaultFactory } from "../../typechain-types";

describe("ConfidentialVault", function () {
  const INV_HASH = ethers.keccak256(ethers.toUtf8Bytes("INV-001"));
  const AMOUNT = 1_000n;
  const VAULT_TYPE = ethers.keccak256(ethers.toUtf8Bytes("ConfidentialVault"));

  // ── Fixture ──────────────────────────────────────────────────────────

  async function deployFixture() {
    const [_deployer, owner, payee, stranger] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6) as MockERC20;

    const token = (await (
      await ethers.getContractFactory("ConfidentialUSDC")
    ).deploy(await usdc.getAddress())) as ConfidentialUSDC;
    await hre.fhevm.assertCoprocessorInitialized(token, "ConfidentialUSDC");

    const vaultFactory = await (await ethers.getContractFactory("VaultFactory")).deploy() as VaultFactory;
    await vaultFactory.registerVaultType(VAULT_TYPE, (await ethers.getContractFactory("ConfidentialVault")).bytecode);

    const tx = await vaultFactory.connect(owner).createVault(VAULT_TYPE, await token.getAddress());
    const receipt = await tx.wait();
    const event = receipt!.logs.map((l: any) => {
      try { return vaultFactory.interface.parseLog({ topics: l.topics as string[], data: l.data }); }
      catch { return null; }
    }).find((e: any) => e?.name === "VaultCreated");
    const vault = await ethers.getContractAt("ConfidentialVault", event!.args.vault) as ConfidentialVault;
    await hre.fhevm.assertCoprocessorInitialized(vault, "ConfidentialVault");

    // Wrap USDC → cUSDC for owner, then grant vault operator rights for transferFrom
    await usdc.mint(owner.address, 100_000n);
    await usdc.connect(owner).approve(await token.getAddress(), 100_000n);
    await token.connect(owner).wrap(owner.address, 100_000n);
    await token
      .connect(owner)
      .setOperator(await vault.getAddress(), 281474976710655n); // uint48 max

    return { vault, token, usdc, owner, payee, stranger, vaultFactory };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  async function encryptU64(
    contractAddr: string,
    signerAddr: string,
    value: bigint
  ) {
    const { externalEuint, inputProof } = await hre.fhevm.encryptUint(
      FhevmType.euint64,
      value,
      contractAddr,
      signerAddr
    );
    return { enc: externalEuint, proof: inputProof };
  }

  async function encryptForInvoice(
    contractAddr: string,
    signerAddr: string,
    payeeAddr: string,
    amount: bigint
  ) {
    const [encU64, encAddr] = await Promise.all([
      hre.fhevm.encryptUint(FhevmType.euint64, amount, contractAddr, signerAddr),
      hre.fhevm.encryptAddress(payeeAddr, contractAddr, signerAddr),
    ]);
    return {
      encPayee: encAddr.externalEaddress,
      payeeProof: encAddr.inputProof,
      encAmount: encU64.externalEuint,
      amountProof: encU64.inputProof,
    };
  }

  async function decryptU64(
    handle: string,
    contractAddr: string,
    user: HardhatEthersSigner
  ): Promise<bigint> {
    return hre.fhevm.userDecryptEuint(FhevmType.euint64, handle, contractAddr, user);
  }

  async function decryptU8(
    handle: string,
    contractAddr: string,
    user: HardhatEthersSigner
  ): Promise<bigint> {
    return hre.fhevm.userDecryptEuint(FhevmType.euint8, handle, contractAddr, user);
  }

  async function decryptAddress(
    handle: string,
    contractAddr: string,
    user: HardhatEthersSigner
  ): Promise<string> {
    return hre.fhevm.userDecryptEaddress(handle, contractAddr, user);
  }

  // ── depositFunds ─────────────────────────────────────────────────────

  describe("depositFunds", function () {
    it("increases vault token balance", async function () {
      const { vault, token, owner } = await deployFixture(); // fresh deploy — avoids cursor issue
      const vaultAddr = await vault.getAddress();
      const { enc, proof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).depositFunds(enc, proof);

      // Use debug decrypt (mock-only, no ACL restriction) to read vault's encrypted balance
      const handle = await token.confidentialBalanceOf(vaultAddr);
      const balance = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, handle);
      expect(balance).to.equal(AMOUNT);
    });

    it("emits FundsDeposited", async function () {
      const { vault, owner } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      const { enc, proof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await expect(vault.connect(owner).depositFunds(enc, proof))
        .to.emit(vault, "FundsDeposited")
        .withArgs(owner.address);
    });

    it("reverts if not owner", async function () {
      const { vault, stranger } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      const { enc, proof } = await encryptU64(vaultAddr, stranger.address, AMOUNT);
      await expect(vault.connect(stranger).depositFunds(enc, proof))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    });
  });

  // ── registerInvoice ──────────────────────────────────────────────────

  describe("registerInvoice", function () {
    it("stores cheque with decryptable payee, amount and Pending status", async function () {
      const { vault, token, owner, payee } = await deployFixture(); // fresh deploy — avoids cursor issue
      const vaultAddr = await vault.getAddress();

      // Deposit funds first so the cheque is created with the full amount
      const { enc, proof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).depositFunds(enc, proof);

      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault
        .connect(owner)
        .registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof);

      const cheque = await vault.getCheque(0);
      const decPayee = await decryptAddress(cheque.payee, vaultAddr, owner);
      const decAmount = await decryptU64(cheque.amount, vaultAddr, owner);
      // status ACL is only granted to owner after cancel/execute; use debugger in tests
      const decStatus = await hre.fhevm.debugger.decryptEuint(FhevmType.euint8, cheque.status);

      expect(decPayee.toLowerCase()).to.equal(payee.address.toLowerCase());
      expect(decAmount).to.equal(AMOUNT);
      expect(decStatus).to.equal(1n); // ChequeStatus.Pending
    });

    it("increments chequeCount after registration", async function () {
      const { vault, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      expect(await vault.chequeCount()).to.equal(0n);

      const inv1 = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv1.encPayee, inv1.payeeProof, inv1.encAmount, inv1.amountProof);
      expect(await vault.chequeCount()).to.equal(1n);

      const INV_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("INV-002"));
      const inv2 = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH_2, inv2.encPayee, inv2.payeeProof, inv2.encAmount, inv2.amountProof);
      expect(await vault.chequeCount()).to.equal(2n);
    });

    it("reverts InvalidInvoiceHash on zero hash", async function () {
      const { vault, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await expect(
        vault.connect(owner).registerInvoice(ethers.ZeroHash, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof)
      ).to.be.revertedWithCustomError(vault, "InvalidInvoiceHash");
    });

    it("reverts InvoiceAlreadyRegistered on duplicate hash", async function () {
      const { vault, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof);
      const inv2 = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await expect(
        vault.connect(owner).registerInvoice(INV_HASH, inv2.encPayee, inv2.payeeProof, inv2.encAmount, inv2.amountProof)
      ).to.be.revertedWithCustomError(vault, "InvoiceAlreadyRegistered");
    });

    it("sets _NOT_ENOUGH_FUNDS error when amount exceeds vault balance", async function () {
      const { vault, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      // No deposit — vault has 0 balance; any non-zero amount triggers the error
      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof);
      const [errorHandle] = await vault.getLastError(owner.address);
      const errorCode = await decryptU8(errorHandle, vaultAddr, owner);
      expect(errorCode).to.equal(1n); // _NOT_ENOUGH_FUNDS
    });

    it("emits ChequeCreated with id 0 and invoiceHash", async function () {
      const { vault, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await expect(
        vault.connect(owner).registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof)
      )
        .to.emit(vault, "ChequeCreated")
        .withArgs(0n, INV_HASH);
    });
  });

  // ── cancelCheque ─────────────────────────────────────────────────────

  describe("cancelCheque", function () {
    it("sets status to Cancelled and emits ChequeCancelled", async function () {
      const { vault, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();

      const { enc, proof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).depositFunds(enc, proof);

      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof);

      await expect(vault.connect(owner).cancelCheque(0))
        .to.emit(vault, "ChequeCancelled")
        .withArgs(0n);

      const cheque = await vault.getCheque(0);
      const decStatus = await decryptU8(cheque.status, vaultAddr, owner);
      expect(decStatus).to.equal(3n); // ChequeStatus.Cancelled

      const [errorHandle] = await vault.getLastError(owner.address);
      const errorCode = await decryptU8(errorHandle, vaultAddr, owner);
      expect(errorCode).to.equal(0n); // _NO_ERROR

      // Allocated balance should be released back to 0
      await vault.connect(owner).requestAllocatedBalanceDecryption();
      const allocHandle = await vault.getAllocatedBalance();
      const allocBalance = await decryptU64(allocHandle, vaultAddr, owner);
      expect(allocBalance).to.equal(0n);
    });

    it("sets _NOT_PENDING error and leaves status unchanged when cheque is not pending", async function () {
      const { vault, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();

      const { enc, proof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).depositFunds(enc, proof);

      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof);

      // First cancel succeeds
      await vault.connect(owner).cancelCheque(0);

      // Second cancel on already-cancelled cheque
      await vault.connect(owner).cancelCheque(0);

      const cheque = await vault.getCheque(0);
      const decStatus = await decryptU8(cheque.status, vaultAddr, owner);
      expect(decStatus).to.equal(3n); // still Cancelled

      const [errorHandle] = await vault.getLastError(owner.address);
      const errorCode = await decryptU8(errorHandle, vaultAddr, owner);
      expect(errorCode).to.equal(3n); // _NOT_PENDING

      // Allocated balance must not change on a failed cancel
      await vault.connect(owner).requestAllocatedBalanceDecryption();
      const allocHandle = await vault.getAllocatedBalance();
      const allocBalance = await decryptU64(allocHandle, vaultAddr, owner);
      expect(allocBalance).to.equal(0n); // was already 0 after first cancel; second cancel must not corrupt it
    });

    it("cancel after executeCheque: error = _NOT_PENDING, allocated balance unchanged", async function () {
      const { vault, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      const INV_HASH_2 = ethers.keccak256(ethers.toUtf8Bytes("INV-002"));

      // Deposit enough for 2 invoices
      const { enc, proof } = await encryptU64(vaultAddr, owner.address, AMOUNT * 2n);
      await vault.connect(owner).depositFunds(enc, proof);

      // Register 2 invoices — allocatedBalance = 2 * AMOUNT
      const inv1 = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv1.encPayee, inv1.payeeProof, inv1.encAmount, inv1.amountProof);
      const inv2 = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH_2, inv2.encPayee, inv2.payeeProof, inv2.encAmount, inv2.amountProof);

      // Execute cheque 0 — allocatedBalance drops to AMOUNT (cheque 1 still allocated)
      await vault.connect(payee).executeCheque(0);

      // Attempt to cancel the now-executed cheque 0
      await vault.connect(owner).cancelCheque(0);

      const [errorHandle] = await vault.getLastError(owner.address);
      const errorCode = await decryptU8(errorHandle, vaultAddr, owner);
      expect(errorCode).to.equal(3n); // _NOT_PENDING

      // Allocated balance must remain AMOUNT — cheque 1 is still pending
      await vault.connect(owner).requestAllocatedBalanceDecryption();
      const allocHandle = await vault.getAllocatedBalance();
      const allocBalance = await decryptU64(allocHandle, vaultAddr, owner);
      expect(allocBalance).to.equal(AMOUNT);
    });

    it("reverts InvalidChequeId on out-of-range id", async function () {
      const { vault, owner } = await deployFixture();
      await expect(vault.connect(owner).cancelCheque(0))
        .to.be.revertedWithCustomError(vault, "InvalidChequeId");
    });

    it("reverts OwnableUnauthorizedAccount if not owner", async function () {
      const { vault, stranger } = await deployFixture();
      await expect(vault.connect(stranger).cancelCheque(0))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    });
  });

  // ── executeCheque ────────────────────────────────────────────────────

  describe("executeCheque", function () {
    it("real payee receives tokens, error code = 0, emits ChequeExecuteAttempted", async function () {
      const { vault, token, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();

      const { enc, proof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).depositFunds(enc, proof);

      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof);

      await expect(vault.connect(payee).executeCheque(0))
        .to.emit(vault, "ChequeExecuteAttempted")
        .withArgs(0n, payee.address);

      const balanceHandle = await token.confidentialBalanceOf(payee.address);
      const balance = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, balanceHandle);
      expect(balance).to.equal(AMOUNT);

      const [errorHandle] = await vault.getLastError(payee.address);
      const errorCode = await decryptU8(errorHandle, vaultAddr, payee);
      expect(errorCode).to.equal(0n); // _NO_ERROR

      const cheque = await vault.getCheque(0);
      const decStatus = await decryptU8(cheque.status, vaultAddr, owner);
      expect(decStatus).to.equal(2n); // ChequeStatus.Executed
    });

    it("wrong caller receives 0 tokens, error code = 2, emits ChequeExecuteAttempted", async function () {
      const { vault, token, owner, payee, stranger } = await deployFixture();
      const vaultAddr = await vault.getAddress();

      const { enc, proof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).depositFunds(enc, proof);

      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof);

      await expect(vault.connect(stranger).executeCheque(0))
        .to.emit(vault, "ChequeExecuteAttempted")
        .withArgs(0n, stranger.address);

      const balanceHandle = await token.confidentialBalanceOf(stranger.address);
      const balance = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, balanceHandle);
      expect(balance).to.equal(0n);

      const [errorHandle] = await vault.getLastError(stranger.address);
      const errorCode = await decryptU8(errorHandle, vaultAddr, stranger);
      expect(errorCode).to.equal(2n); // _NOT_PAYEE
    });

    it("reverts InvalidChequeId on out-of-range id", async function () {
      const { vault, payee } = await deployFixture();
      await expect(vault.connect(payee).executeCheque(0))
        .to.be.revertedWithCustomError(vault, "InvalidChequeId");
    });

    it("second call by real payee after execution: error = _NOT_PAYEE, balance unchanged", async function () {
      const { vault, token, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();

      const { enc, proof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).depositFunds(enc, proof);

      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof);

      // First execute — succeeds
      await vault.connect(payee).executeCheque(0);

      // Second execute — cheque is no longer Pending
      await vault.connect(payee).executeCheque(0);

      const balanceHandle = await token.confidentialBalanceOf(payee.address);
      const balance = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, balanceHandle);
      expect(balance).to.equal(AMOUNT); // unchanged from first execution

      const [errorHandle] = await vault.getLastError(payee.address);
      const errorCode = await decryptU8(errorHandle, vaultAddr, payee);
      expect(errorCode).to.equal(2n); // _NOT_PAYEE (canExecute = false when not pending)
    });
  });

  // ── withdrawFunds ────────────────────────────────────────────────────

  describe("withdrawFunds", function () {
    it("withdraws unallocated funds, owner balance increases, emits FundsWithdrawn, error = 0", async function () {
      const { vault, token, owner } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      const tokenAddr = await token.getAddress();

      const { enc: depEnc, proof: depProof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).depositFunds(depEnc, depProof);

      // Snapshot balances before withdraw
      const vaultBalBefore = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(vaultAddr));
      const ownerBalBefore = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(owner.address));
      expect(vaultBalBefore).to.equal(AMOUNT);
      expect(ownerBalBefore).to.equal(100_000n - AMOUNT);

      const { enc: witEnc, proof: witProof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await expect(vault.connect(owner).withdrawFunds(witEnc, witProof))
        .to.emit(vault, "FundsWithdrawn")
        .withArgs(owner.address);

      // Balances after withdraw
      const vaultBalAfter = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(vaultAddr));
      const ownerBalAfter = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(owner.address));
      expect(vaultBalAfter).to.equal(0n);
      expect(ownerBalAfter).to.equal(100_000n);

      const [errorHandle] = await vault.getLastError(owner.address);
      const errorCode = await decryptU8(errorHandle, vaultAddr, owner);
      expect(errorCode).to.equal(0n); // _NO_ERROR
    });
    it("amount exceeds available balance: withdrawal is 0, balances unchanged, error = _NOT_ENOUGH_FUNDS", async function () {
      const { vault, token, owner } = await deployFixture();
      const vaultAddr = await vault.getAddress();

      const { enc: depEnc, proof: depProof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).depositFunds(depEnc, depProof);

      const vaultBalBefore = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(vaultAddr));
      const ownerBalBefore = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(owner.address));
      expect(vaultBalBefore).to.equal(AMOUNT);
      expect(ownerBalBefore).to.equal(100_000n - AMOUNT);

      // Try to withdraw more than the vault holds — effective transfer = 0
      const { enc: witEnc, proof: witProof } = await encryptU64(vaultAddr, owner.address, AMOUNT * 2n);
      await vault.connect(owner).withdrawFunds(witEnc, witProof);

      const vaultBalAfter = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(vaultAddr));
      const ownerBalAfter = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(owner.address));
      expect(vaultBalAfter).to.equal(AMOUNT);
      expect(ownerBalAfter).to.equal(100_000n - AMOUNT);

      const [errorHandle] = await vault.getLastError(owner.address);
      const errorCode = await decryptU8(errorHandle, vaultAddr, owner);
      expect(errorCode).to.equal(1n); // _NOT_ENOUGH_FUNDS
    });
    it("cannot withdraw funds locked by a registered invoice", async function () {
      const { vault, token, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();

      const { enc: depEnc, proof: depProof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).depositFunds(depEnc, depProof);

      // Register an invoice that allocates the full deposit
      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof);

      const vaultBalBefore = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(vaultAddr));
      const ownerBalBefore = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(owner.address));

      // Attempt to withdraw the allocated amount — available balance is 0
      const { enc: witEnc, proof: witProof } = await encryptU64(vaultAddr, owner.address, AMOUNT);
      await vault.connect(owner).withdrawFunds(witEnc, witProof);

      const vaultBalAfter = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(vaultAddr));
      const ownerBalAfter = await hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(owner.address));
      expect(vaultBalAfter).to.equal(vaultBalBefore);
      expect(ownerBalAfter).to.equal(ownerBalBefore);

      const [errorHandle] = await vault.getLastError(owner.address);
      const errorCode = await decryptU8(errorHandle, vaultAddr, owner);
      expect(errorCode).to.equal(1n); // _NOT_ENOUGH_FUNDS
    });
  });

  // ── View Functions ───────────────────────────────────────────────────

  describe("View Functions", function () {
    it("getLastError returns non-zero timestamp after a state-changing call", async function () {
      const { vault, owner, payee } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      const inv = await encryptForInvoice(vaultAddr, owner.address, payee.address, AMOUNT);
      await vault.connect(owner).registerInvoice(INV_HASH, inv.encPayee, inv.payeeProof, inv.encAmount, inv.amountProof);
      const [, timestamp] = await vault.getLastError(owner.address);
      expect(timestamp).to.be.gt(0n);
    });

    it("requestAllocatedBalanceDecryption reverts if not owner", async function () {
      const { vault, stranger } = await deployFixture();
      await expect(vault.connect(stranger).requestAllocatedBalanceDecryption())
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
    });
  });

  // ── Constructor ──────────────────────────────────────────────────────

  describe("Constructor", function () {
    it("sets TOKEN and owner correctly", async function () {
      const { vault, token, owner } = await deployFixture();
      expect(await vault.TOKEN()).to.equal(await token.getAddress());
      expect(await vault.owner()).to.equal(owner.address);
    });

    it("reverts ZeroAddress on zero token address", async function () {
      const [_, owner] = await ethers.getSigners();
      const vaultFactory = await (await ethers.getContractFactory("VaultFactory")).deploy() as VaultFactory;
      await vaultFactory.registerVaultType(VAULT_TYPE, (await ethers.getContractFactory("ConfidentialVault")).bytecode);
      await expect(vaultFactory.connect(owner).createVault(VAULT_TYPE, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(vaultFactory, "DeploymentFailed");
    });
  });
});
