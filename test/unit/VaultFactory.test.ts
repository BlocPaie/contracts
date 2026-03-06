import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { VaultFactory } from "../../typechain-types";

describe("VaultFactory", function () {
  const VAULT_TYPE = ethers.keccak256(ethers.toUtf8Bytes("ERC20Vault"));

  async function deployFixture() {
    const [deployer, user1, user2] = await ethers.getSigners();
    const usdcAddress = ethers.Wallet.createRandom().address;

    const factory = await (await ethers.getContractFactory("VaultFactory")).connect(deployer).deploy() as VaultFactory;

    const ERC20VaultFactory = await ethers.getContractFactory("ERC20Vault");
    const vaultCreationCode = ERC20VaultFactory.bytecode;

    return { factory, deployer, user1, user2, usdcAddress, vaultCreationCode };
  }

  // ── registerVaultType ─────────────────────────────────────────────

  describe("registerVaultType", function () {
    it("stores bytecode", async function () {
      const { factory, deployer, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);
      const stored = await factory.vaultBytecode(VAULT_TYPE);
      expect(stored.length).to.be.greaterThan(2); // "0x" is empty
    });

    it("emits VaultTypeRegistered with code hash", async function () {
      const { factory, deployer, vaultCreationCode } = await loadFixture(deployFixture);
      await expect(factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode))
        .to.emit(factory, "VaultTypeRegistered")
        .withArgs(VAULT_TYPE, ethers.keccak256(vaultCreationCode));
    });

    it("reverts if not owner", async function () {
      const { factory, user1, vaultCreationCode } = await loadFixture(deployFixture);
      await expect(factory.connect(user1).registerVaultType(VAULT_TYPE, vaultCreationCode))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(user1.address);
    });

    it("reverts if already registered", async function () {
      const { factory, deployer, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);
      await expect(factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode))
        .to.be.revertedWithCustomError(factory, "VaultTypeAlreadyRegistered");
    });

    it("reverts if empty bytecode", async function () {
      const { factory, deployer } = await loadFixture(deployFixture);
      await expect(factory.connect(deployer).registerVaultType(VAULT_TYPE, "0x"))
        .to.be.revertedWithCustomError(factory, "EmptyBytecode");
    });
  });

  // ── updateVaultType ───────────────────────────────────────────────

  describe("updateVaultType", function () {
    it("updates existing bytecode", async function () {
      const { factory, deployer, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);

      const newCode = ethers.concat([vaultCreationCode, "0x00"]);
      await factory.connect(deployer).updateVaultType(VAULT_TYPE, newCode);

      expect(ethers.keccak256(await factory.vaultBytecode(VAULT_TYPE))).to.equal(ethers.keccak256(newCode));
    });

    it("emits VaultTypeUpdated with old and new hashes", async function () {
      const { factory, deployer, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);

      const newCode = ethers.concat([vaultCreationCode, "0x00"]);
      await expect(factory.connect(deployer).updateVaultType(VAULT_TYPE, newCode))
        .to.emit(factory, "VaultTypeUpdated")
        .withArgs(VAULT_TYPE, ethers.keccak256(vaultCreationCode), ethers.keccak256(newCode));
    });

    it("reverts if not registered", async function () {
      const { factory, deployer, vaultCreationCode } = await loadFixture(deployFixture);
      await expect(factory.connect(deployer).updateVaultType(VAULT_TYPE, vaultCreationCode))
        .to.be.revertedWithCustomError(factory, "VaultTypeNotRegistered");
    });

    it("reverts if empty bytecode", async function () {
      const { factory, deployer, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);
      await expect(factory.connect(deployer).updateVaultType(VAULT_TYPE, "0x"))
        .to.be.revertedWithCustomError(factory, "EmptyBytecode");
    });
  });

  // ── removeVaultType ───────────────────────────────────────────────

  describe("removeVaultType", function () {
    it("removes bytecode", async function () {
      const { factory, deployer, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);
      await factory.connect(deployer).removeVaultType(VAULT_TYPE);
      const stored = await factory.vaultBytecode(VAULT_TYPE);
      expect(stored).to.equal("0x");
    });

    it("emits VaultTypeRemoved", async function () {
      const { factory, deployer, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);
      await expect(factory.connect(deployer).removeVaultType(VAULT_TYPE))
        .to.emit(factory, "VaultTypeRemoved")
        .withArgs(VAULT_TYPE);
    });

    it("reverts if not registered", async function () {
      const { factory, deployer } = await loadFixture(deployFixture);
      await expect(factory.connect(deployer).removeVaultType(VAULT_TYPE))
        .to.be.revertedWithCustomError(factory, "VaultTypeNotRegistered");
    });

    it("reverts if not owner", async function () {
      const { factory, deployer, user1, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);
      await expect(factory.connect(user1).removeVaultType(VAULT_TYPE))
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(user1.address);
    });
  });

  // ── createVault ───────────────────────────────────────────────────

  describe("createVault", function () {
    async function parseVaultCreated(factory: VaultFactory, tx: any): Promise<string> {
      const receipt = await tx.wait();
      const event = receipt!.logs.map((l: any) => {
        try { return factory.interface.parseLog({ topics: l.topics as string[], data: l.data }); }
        catch { return null; }
      }).find((e: any) => e?.name === "VaultCreated");
      return event!.args.vault;
    }

    it("deploys vault with correct owner and token", async function () {
      const { factory, deployer, user1, usdcAddress, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);

      const tx = await factory.connect(user1).createVault(VAULT_TYPE, usdcAddress);
      const vaultAddr = await parseVaultCreated(factory, tx);

      const vault = await ethers.getContractAt("ERC20Vault", vaultAddr);
      expect(await vault.owner()).to.equal(user1.address);
      expect(await vault.USDC()).to.equal(usdcAddress);
    });

    it("emits VaultCreated event", async function () {
      const { factory, deployer, user1, usdcAddress, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);

      const tx = await factory.connect(user1).createVault(VAULT_TYPE, usdcAddress);
      const vaultAddr = await parseVaultCreated(factory, tx);
      expect(vaultAddr).to.not.equal(ethers.ZeroAddress);
    });

    it("tracks vaults in arrays", async function () {
      const { factory, deployer, user1, usdcAddress, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);

      const tx = await factory.connect(user1).createVault(VAULT_TYPE, usdcAddress);
      const vaultAddr = await parseVaultCreated(factory, tx);

      expect(await factory.vaultCount()).to.equal(1);
      expect(await factory.vaultCountByOwner(user1.address)).to.equal(1);
      expect(await factory.vaults(0)).to.equal(vaultAddr);
      expect(await factory.vaultsByOwner(user1.address, 0)).to.equal(vaultAddr);
    });

    it("reverts for unregistered type", async function () {
      const { factory, user1, usdcAddress } = await loadFixture(deployFixture);
      await expect(factory.connect(user1).createVault(VAULT_TYPE, usdcAddress))
        .to.be.revertedWithCustomError(factory, "VaultTypeNotRegistered");
    });

    it("supports multiple vaults from same owner", async function () {
      const { factory, deployer, user1, usdcAddress, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);

      const tx1 = await factory.connect(user1).createVault(VAULT_TYPE, usdcAddress);
      const tx2 = await factory.connect(user1).createVault(VAULT_TYPE, usdcAddress);
      const addr1 = await parseVaultCreated(factory, tx1);
      const addr2 = await parseVaultCreated(factory, tx2);

      expect(addr1).to.not.equal(addr2);
      expect(await factory.vaultCount()).to.equal(2);
      expect(await factory.vaultCountByOwner(user1.address)).to.equal(2);
    });

    it("supports multiple vaults from different owners", async function () {
      const { factory, deployer, user1, user2, usdcAddress, vaultCreationCode } = await loadFixture(deployFixture);
      await factory.connect(deployer).registerVaultType(VAULT_TYPE, vaultCreationCode);

      const tx1 = await factory.connect(user1).createVault(VAULT_TYPE, usdcAddress);
      const tx2 = await factory.connect(user2).createVault(VAULT_TYPE, usdcAddress);
      const addr1 = await parseVaultCreated(factory, tx1);
      const addr2 = await parseVaultCreated(factory, tx2);

      expect(addr1).to.not.equal(addr2);
      expect(await factory.vaultCount()).to.equal(2);
      expect(await factory.vaultCountByOwner(user1.address)).to.equal(1);
      expect(await factory.vaultCountByOwner(user2.address)).to.equal(1);
    });
  });
});
