import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ConfidentialVault, MockConfidentialERC20 } from "../../typechain-types";

describe("ConfidentialVault (end-to-end)", function () {
  it("full payroll flow: deposit → 3 invoices → execute/cancel → withdraw", async function () {
    const [_deployer, owner, payee1, payee2] = await ethers.getSigners();

    // ── Deploy ────────────────────────────────────────────────────────
    const token = (await (
      await ethers.getContractFactory("MockConfidentialERC20")
    ).deploy()) as MockConfidentialERC20;
    await hre.fhevm.assertCoprocessorInitialized(token, "MockConfidentialERC20");

    const vault = (await (
      await ethers.getContractFactory("ConfidentialVault")
    ).deploy(owner.address, await token.getAddress())) as ConfidentialVault;
    await hre.fhevm.assertCoprocessorInitialized(vault, "ConfidentialVault");

    const vaultAddr = await vault.getAddress();

    const DEPOSIT = 10_000n;
    const AMT1 = 3_000n; // payee1, cheque 0
    const AMT2 = 4_000n; // payee2, cheque 1
    const AMT3 = 2_000n; // payee1, cheque 2

    await token.mint(owner.address, DEPOSIT);
    await token.connect(owner).setOperator(vaultAddr, 281474976710655n);

    // ── Helpers ───────────────────────────────────────────────────────
    async function encU64(value: bigint) {
      const { externalEuint, inputProof } = await hre.fhevm.encryptUint(
        FhevmType.euint64, value, vaultAddr, owner.address
      );
      return { enc: externalEuint, proof: inputProof };
    }

    async function encInvoice(payeeAddr: string, amount: bigint) {
      const [encAmount, encAddr] = await Promise.all([
        hre.fhevm.encryptUint(FhevmType.euint64, amount, vaultAddr, owner.address),
        hre.fhevm.encryptAddress(payeeAddr, vaultAddr, owner.address),
      ]);
      return {
        encPayee: encAddr.externalEaddress, payeeProof: encAddr.inputProof,
        encAmount: encAmount.externalEuint, amountProof: encAmount.inputProof,
      };
    }

    async function tokenBalance(addr: string): Promise<bigint> {
      return hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(addr));
    }

    async function allocatedBalance(): Promise<bigint> {
      await vault.connect(owner).requestAllocatedBalanceDecryption();
      return hre.fhevm.userDecryptEuint(FhevmType.euint64, await vault.getAllocatedBalance(), vaultAddr, owner);
    }

    async function chequeStatus(id: number): Promise<bigint> {
      const cheque = await vault.getCheque(id);
      return hre.fhevm.debugger.decryptEuint(FhevmType.euint8, cheque.status);
    }

    // ── Deposit ───────────────────────────────────────────────────────
    const { enc: depEnc, proof: depProof } = await encU64(DEPOSIT);
    await vault.connect(owner).depositFunds(depEnc, depProof);

    expect(await tokenBalance(vaultAddr)).to.equal(DEPOSIT);
    expect(await tokenBalance(owner.address)).to.equal(0n); // fully deposited

    // ── Register 3 invoices ───────────────────────────────────────────
    const INV1 = ethers.keccak256(ethers.toUtf8Bytes("INV-001"));
    const INV2 = ethers.keccak256(ethers.toUtf8Bytes("INV-002"));
    const INV3 = ethers.keccak256(ethers.toUtf8Bytes("INV-003"));

    const inv1 = await encInvoice(payee1.address, AMT1);
    await vault.connect(owner).registerInvoice(INV1, inv1.encPayee, inv1.payeeProof, inv1.encAmount, inv1.amountProof);

    const inv2 = await encInvoice(payee2.address, AMT2);
    await vault.connect(owner).registerInvoice(INV2, inv2.encPayee, inv2.payeeProof, inv2.encAmount, inv2.amountProof);

    const inv3 = await encInvoice(payee1.address, AMT3);
    await vault.connect(owner).registerInvoice(INV3, inv3.encPayee, inv3.payeeProof, inv3.encAmount, inv3.amountProof);

    expect(await vault.chequeCount()).to.equal(3n);
    expect(await allocatedBalance()).to.equal(AMT1 + AMT2 + AMT3);

    // ── payee1 executes cheque 0 (claims AMT1 = 3,000) ───────────────
    await vault.connect(payee1).executeCheque(0);
    expect(await tokenBalance(payee1.address)).to.equal(AMT1);
    expect(await tokenBalance(vaultAddr)).to.equal(DEPOSIT - AMT1);
    expect(await allocatedBalance()).to.equal(AMT2 + AMT3);

    // ── owner cancels cheque 2 (payee1's second invoice, AMT3 = 2,000) ─
    await vault.connect(owner).cancelCheque(2);
    expect(await allocatedBalance()).to.equal(AMT2); // only cheque 1 remains allocated

    // ── payee2 executes cheque 1 (claims AMT2 = 4,000) ───────────────
    await vault.connect(payee2).executeCheque(1);
    expect(await tokenBalance(payee2.address)).to.equal(AMT2);
    expect(await tokenBalance(vaultAddr)).to.equal(DEPOSIT - AMT1 - AMT2);
    expect(await allocatedBalance()).to.equal(0n);

    // ── owner withdraws remaining unallocated funds (3,000) ──────────
    const remaining = DEPOSIT - AMT1 - AMT2;
    const { enc: witEnc, proof: witProof } = await encU64(remaining);
    await vault.connect(owner).withdrawFunds(witEnc, witProof);

    expect(await tokenBalance(vaultAddr)).to.equal(0n);
    expect(await tokenBalance(owner.address)).to.equal(remaining);

    // ── Final state verification ──────────────────────────────────────
    expect(await chequeStatus(0)).to.equal(1n); // Executed
    expect(await chequeStatus(1)).to.equal(1n); // Executed
    expect(await chequeStatus(2)).to.equal(2n); // Cancelled
  });
});
