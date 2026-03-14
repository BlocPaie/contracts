import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { ConfidentialUSDC, ConfidentialVault, MockERC20, VaultFactory } from "../../typechain-types";

describe("ConfidentialVault (end-to-end)", function () {
  it("full payroll flow: USDC → wrap → deposit → 3 invoices → execute/cancel → withdraw → unwrap → USDC", async function () {
    const [_deployer, owner, payee1, payee2] = await ethers.getSigners();

    const VAULT_TYPE = ethers.keccak256(ethers.toUtf8Bytes("ConfidentialVault"));

    const DEPOSIT = 10_000n;
    const AMT1 = 3_000n; // payee1, cheque 0
    const AMT2 = 4_000n; // payee2, cheque 1
    const AMT3 = 2_000n; // payee1, cheque 2

    // ── Deploy contracts ──────────────────────────────────────────────
    const usdc = (await (await ethers.getContractFactory("MockERC20"))
      .deploy("USD Coin", "USDC", 6)) as MockERC20;

    const token = (await (await ethers.getContractFactory("ConfidentialUSDC"))
      .deploy(await usdc.getAddress())) as ConfidentialUSDC;
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

    const tokenAddr = await token.getAddress();
    const vaultAddr = await vault.getAddress();
    const usdcAddr = await usdc.getAddress();

    // ── Helpers ───────────────────────────────────────────────────────
    async function encU64ForVault(value: bigint) {
      const { externalEuint, inputProof } = await hre.fhevm.encryptUint(
        FhevmType.euint64, value, vaultAddr, owner.address
      );
      return { enc: externalEuint, proof: inputProof };
    }

    async function encU64ForToken(value: bigint, signerAddr: string) {
      const { externalEuint, inputProof } = await hre.fhevm.encryptUint(
        FhevmType.euint64, value, tokenAddr, signerAddr
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

    async function cUSDCBalance(addr: string): Promise<bigint> {
      return hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(addr));
    }

    async function allocatedBalance(): Promise<bigint> {
      return hre.fhevm.debugger.decryptEuint(FhevmType.euint64, await vault.getAllocatedBalance());
    }

    async function chequeStatus(id: number): Promise<bigint> {
      const cheque = await vault.getCheque(id);
      return hre.fhevm.debugger.decryptEuint(FhevmType.euint8, cheque.status);
    }

    /// Simulate the Zama relayer: call publicDecrypt to obtain the KMS-signed cleartext,
    /// then submit it to finalizeUnwrap for on-chain verification via FHE.checkSignatures.
    /// On Sepolia, this step is done by querying https://relayer.testnet.zama.org.
    async function fulfillUnwrap(unwrapTx: any): Promise<void> {
      const unwrapReceipt = await unwrapTx.wait();
      const unwrapEvent = unwrapReceipt!.logs.map((l: any) => {
        try { return token.interface.parseLog({ topics: l.topics as string[], data: l.data }); }
        catch { return null; }
      }).find((e: any) => e?.name === "UnwrapRequested");

      // ERC7984ERC20Wrapper emits UnwrapRequested(address indexed receiver, euint64 amount)
      const handle: string = unwrapEvent!.args.amount;

      // Simulate relayer: get cleartext + KMS proof (mock KMS signer signs in Hardhat)
      const result = await hre.fhevm.publicDecrypt([handle]);
      const clearAmount = result.clearValues[handle] as bigint;
      const { decryptionProof } = result;

      // Anyone can call finalizeUnwrap — FHE.checkSignatures verifies the KMS proof on-chain
      await token.connect(_deployer).finalizeUnwrap(handle, clearAmount, decryptionProof);
    }

    // ── Company starts with USDC ──────────────────────────────────────
    await usdc.mint(owner.address, DEPOSIT);
    expect(await usdc.balanceOf(owner.address)).to.equal(DEPOSIT);

    // ── Wrap USDC → cUSDC ─────────────────────────────────────────────
    await usdc.connect(owner).approve(tokenAddr, DEPOSIT);
    await token.connect(owner).wrap(owner.address, DEPOSIT);

    expect(await usdc.balanceOf(owner.address)).to.equal(0n);         // USDC fully wrapped
    expect(await usdc.balanceOf(tokenAddr)).to.equal(DEPOSIT);        // USDC held by cUSDC contract
    expect(await cUSDCBalance(owner.address)).to.equal(DEPOSIT);      // cUSDC minted 1:1

    // ── Authorize vault and deposit cUSDC ─────────────────────────────
    await token.connect(owner).setOperator(vaultAddr, 281474976710655n);

    const { enc: depEnc, proof: depProof } = await encU64ForVault(DEPOSIT);
    await vault.connect(owner).depositFunds(depEnc, depProof);

    expect(await cUSDCBalance(vaultAddr)).to.equal(DEPOSIT);
    expect(await cUSDCBalance(owner.address)).to.equal(0n);

    // ── Register 3 invoices ───────────────────────────────────────────
    const INV1 = ethers.keccak256(ethers.toUtf8Bytes("INV-001"));
    const INV2 = ethers.keccak256(ethers.toUtf8Bytes("INV-002"));
    const INV3 = ethers.keccak256(ethers.toUtf8Bytes("INV-003"));

    const inv1 = await encInvoice(payee1.address, AMT1);
    await vault.connect(owner).registerInvoice(INV1, inv1.encPayee, inv1.payeeProof, inv1.encAmount, inv1.amountProof, ethers.ZeroAddress);

    const inv2 = await encInvoice(payee2.address, AMT2);
    await vault.connect(owner).registerInvoice(INV2, inv2.encPayee, inv2.payeeProof, inv2.encAmount, inv2.amountProof, ethers.ZeroAddress);

    const inv3 = await encInvoice(payee1.address, AMT3);
    await vault.connect(owner).registerInvoice(INV3, inv3.encPayee, inv3.payeeProof, inv3.encAmount, inv3.amountProof, ethers.ZeroAddress);

    expect(await vault.chequeCount()).to.equal(3n);
    expect(await allocatedBalance()).to.equal(AMT1 + AMT2 + AMT3);

    // ── payee1 executes cheque 0 (claims AMT1 = 3,000 cUSDC) ─────────
    await vault.connect(payee1).executeCheque(0, ethers.ZeroAddress);
    expect(await cUSDCBalance(payee1.address)).to.equal(AMT1);
    expect(await cUSDCBalance(vaultAddr)).to.equal(DEPOSIT - AMT1);
    expect(await allocatedBalance()).to.equal(AMT2 + AMT3);

    // ── owner cancels cheque 2 (payee1's second invoice, 2,000) ──────
    await vault.connect(owner).cancelCheque(2, ethers.ZeroAddress);
    expect(await allocatedBalance()).to.equal(AMT2);

    // ── payee2 executes cheque 1 (claims AMT2 = 4,000 cUSDC) ─────────
    await vault.connect(payee2).executeCheque(1, ethers.ZeroAddress);
    expect(await cUSDCBalance(payee2.address)).to.equal(AMT2);
    expect(await cUSDCBalance(vaultAddr)).to.equal(DEPOSIT - AMT1 - AMT2);
    expect(await allocatedBalance()).to.equal(0n);

    // ── owner withdraws remaining unallocated cUSDC (3,000) ──────────
    const remaining = DEPOSIT - AMT1 - AMT2;
    const { enc: witEnc, proof: witProof } = await encU64ForVault(remaining);
    await vault.connect(owner).withdrawFunds(witEnc, witProof, ethers.ZeroAddress);

    expect(await cUSDCBalance(vaultAddr)).to.equal(0n);
    expect(await cUSDCBalance(owner.address)).to.equal(remaining);

    // ── Payees requestUnwrap cUSDC → USDC (two-step via gateway) ─────
    // payee1: burn AMT1 cUSDC, gateway decrypts and releases USDC
    const { enc: unwrapEnc1, proof: unwrapProof1 } = await encU64ForToken(AMT1, payee1.address);
    await fulfillUnwrap(await token.connect(payee1)["unwrap(address,address,bytes32,bytes)"](payee1.address, payee1.address, unwrapEnc1, unwrapProof1));

    // payee2: burn AMT2 cUSDC, gateway decrypts and releases USDC
    const { enc: unwrapEnc2, proof: unwrapProof2 } = await encU64ForToken(AMT2, payee2.address);
    await fulfillUnwrap(await token.connect(payee2)["unwrap(address,address,bytes32,bytes)"](payee2.address, payee2.address, unwrapEnc2, unwrapProof2));

    expect(await cUSDCBalance(payee1.address)).to.equal(0n);
    expect(await cUSDCBalance(payee2.address)).to.equal(0n);
    expect(await usdc.balanceOf(payee1.address)).to.equal(AMT1);
    expect(await usdc.balanceOf(payee2.address)).to.equal(AMT2);

    // ── Owner requestUnwrap remaining cUSDC → USDC ────────────────────
    const { enc: unwrapEncOwner, proof: unwrapProofOwner } = await encU64ForToken(remaining, owner.address);
    await fulfillUnwrap(await token.connect(owner)["unwrap(address,address,bytes32,bytes)"](owner.address, owner.address, unwrapEncOwner, unwrapProofOwner));

    expect(await cUSDCBalance(owner.address)).to.equal(0n);
    expect(await usdc.balanceOf(owner.address)).to.equal(remaining);

    // ── Final state: all USDC accounted for ───────────────────────────
    expect(await usdc.balanceOf(payee1.address)).to.equal(AMT1);      // 3,000
    expect(await usdc.balanceOf(payee2.address)).to.equal(AMT2);      // 4,000
    expect(await usdc.balanceOf(owner.address)).to.equal(remaining);  // 3,000 (cancelled cheque returned)
    expect(await usdc.balanceOf(tokenAddr)).to.equal(0n);             // wrapper contract drained

    // ── Final cheque statuses ─────────────────────────────────────────
    expect(await chequeStatus(0)).to.equal(2n); // Executed
    expect(await chequeStatus(1)).to.equal(2n); // Executed
    expect(await chequeStatus(2)).to.equal(3n); // Cancelled
  });
});
