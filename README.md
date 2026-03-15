# BlocPaie Contracts

Solidity smart contracts for confidential on-chain payroll. Two vault types — a transparent ERC-20 vault and a privacy-preserving confidential vault powered by Zama's fhEVM — deployed and managed through a shared factory.

## About BlocPaie

BlocPaie is an invoice-to-payment platform where companies create on-chain payroll vaults and pay contractors on Ethereum — while every salary amount, payee identity, and payment status stays fully encrypted on-chain via Zama's Fully Homomorphic Encryption. Nobody on-chain, including the contract itself, can read salary values in plaintext.

The blockchain acts as a **verifiability layer** — every payment registration, execution, and cancellation is permanently recorded on-chain with a cryptographic commitment, without exposing the underlying amounts or identities. This makes payroll auditable by regulatory authorities without compromising employee privacy.

## Known Limitations

**Ephemeral decrypt keypair** — Zama's KMS validates `userDecrypt` requests via secp256k1 ECDSA signatures. Smart contract wallets using WebAuthn P-256 passkeys (e.g. Porto) cannot sign KMS requests directly. As a workaround, the frontend generates a short-lived secp256k1 keypair (`decryptViewer`), grants it ACL access on-chain via `TFHE.allow`, uses it to sign the KMS request, then discards it. This costs an extra on-chain transaction per decrypt. EIP-1271 support in the Zama KMS would eliminate this — the KMS could call `isValidSignature` on any smart contract wallet to authorise decryption directly.

## Contracts

### VaultFactory
Ownable factory that registers vault type bytecode and deploys new vault instances via `create`. Each vault type is identified by a `keccak256` key.

```
deployVault(bytes32 typeKey, address token) → vaultAddress
```

Vault type keys (registered at deploy):
- `ERC20Vault`: `keccak256("ERC20Vault")` = `0x874a5851...`
- `ConfidentialVault`: `keccak256("ConfidentialVault")` = `0xd05bd75f...`

---

### ERC20Vault
Plain ERC-20 payroll vault. Amounts, payee addresses, and cheque statuses are all public on-chain.

| Function | Who | Description |
|----------|-----|-------------|
| `depositFunds(uint256)` | Owner | Transfer USDC into vault |
| `withdrawFunds(uint256)` | Owner | Pull unused funds back |
| `registerCheque(address payee, uint256 amount, bytes32 hash)` | Owner | Create a payable cheque → `chequeId` |
| `executeCheque(uint256 chequeId)` | Payee | Collect salary — transfers USDC |
| `cancelCheque(uint256 chequeId)` | Owner | Cancel before execution |

ChequeId is a per-payee array index that resets per payee.

---

### ConfidentialVault
Encrypted payroll vault. Payee address, salary amount, and cheque status are all stored as FHE ciphertexts via Zama's coprocessor. Nobody on-chain — including the contract itself — can read these values in plaintext.

| Function | Who | Description |
|----------|-----|-------------|
| `depositFunds(bytes32 einput, bytes proof)` | Owner | Deposit encrypted cUSDC |
| `withdrawFunds(bytes32 einput, bytes proof, address viewer)` | Owner | Withdraw encrypted amount |
| `registerCheque(address encPayee, bytes32 einput, bytes proof, bytes32 hash, address viewer)` | Owner | Register encrypted cheque → `chequeId` |
| `executeCheque(uint256 chequeId, address viewer)` | Payee | Execute — FHE verifies payee, transfers cUSDC |
| `cancelCheque(uint256 chequeId, address viewer)` | Owner | Cancel |
| `getLastError(address) → (euint8, uint256)` | Anyone | Read encrypted error code + timestamp |

ChequeId is a global incrementing counter (payee is encrypted — cannot key by address).

**Soft error model** — encrypted `euint8` status codes; no reverts on FHE conditions:

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Insufficient vault funds |
| `2` | Not the correct payee |
| `3` | Cheque not in pending state |

---

### ConfidentialUSDC (cUSDC)
ERC-7984 confidential token wrapper around USDC. All balances, transfers, and allowances are FHE-encrypted.

| Function | Description |
|----------|-------------|
| `wrap(uint256)` | Deposit USDC, receive cUSDC |
| `unwrap(address from, address to, bytes32 einput, bytes proof)` | Initiate unwrap — step 1 of 2 |
| `finalizeUnwrap(euint64 handle, uint64 cleartext, bytes proof)` | Complete unwrap — step 2 of 2 |
| `grantBalanceDecryptAccess(address viewer)` | Grant a viewer ACL to decrypt caller's cUSDC balance |
| `confidentialBalanceOf(address)` | Returns encrypted balance handle |

> **Unwrap is a two-step process.** After `unwrap` confirms, call `instance.publicDecrypt([handle])` via the Zama relayer SDK to get the cleartext and decryption proof, then call `finalizeUnwrap` to complete the transfer.

---

## Deployed Addresses (Ethereum Sepolia)

| Contract | Address |
|----------|---------|
| VaultFactory | `0x619B322e1D722F86294B4d7dF92B42c89B3456aB` |
| MockUSDC | `0xe89D1caF047aEc9F7f0F3623F799F3bc321fFc9c` |
| ConfidentialUSDC (cUSDC) | `0x8a486Fa9c123ADc482d383f9fe8A48adaD7fBc17` |

---

## Setup

```bash
npm install
```

### Environment

Create a `.env` file:

```env
SEPOLIA_RPC_URL=https://rpc.sepolia.org
DEPLOYER_PRIVATE_KEY=0x...
```

---

## Commands

```bash
# Compile + generate TypeChain types
npx hardhat compile

# Run all 88 tests
npx hardhat test

# Deploy to Sepolia
npx hardhat run scripts/deploy.ts --network sepolia

# Export ABIs to frontend/lib/abis/
npx hardhat run scripts/export-abi.ts --network sepolia

# Sync vault bytecode to frontend (for createVault calls)
npx hardhat run scripts/update-vault-bytecode.ts --network sepolia

# Mint test USDC to an address
npx hardhat run scripts/mint-usdc.ts --network sepolia
```

---

## Tests

88 tests across unit and integration suites. All tests use `VaultFactory` for vault deployment.

| Suite | Tests | Focus |
|-------|-------|-------|
| `ERC20Vault.test.ts` | 40 | Deposit, withdraw, cheque lifecycle, permissions, edge cases |
| `VaultFactory.test.ts` | 21 | Type registration, deployment, ownership |
| `ConfidentialVault.test.ts` | 25 | FHE operations, encrypted errors, ACL, error codes |
| `PayrollFlow.test.ts` | 1 | End-to-end ERC-20 payroll |
| `ConfidentialVaultFlow.test.ts` | 1 | End-to-end confidential payroll |

---

## Architecture Notes

**Single immutable token per vault** — set at construction. Multiple tokens require multiple vaults.

**Encrypted status prevents griefing** — plaintext cheque status would let anyone mark a cheque as executed with a zero transfer. Encrypting the status closes this attack vector.

**`FHE.allowTransient` before every token call** — required for single-transaction ACL grants when calling the cUSDC token within a vault operation.

**ACL resets on every FHE operation** — new ciphertext handles are created on each mutation. `requestAllocatedBalanceDecryption()` must be called after mutations to re-grant the vault owner ACL on the new balance handle.

**`setOperator` not `approve`** — ERC-7984 uses `setOperator` for token authorization, not the standard ERC-20 `approve`.

**`ChequeExecuteAttempted` ≠ payment** — this event is always emitted regardless of FHE outcome. Payment is confirmed by a `ConfidentialTransfer` event on the cUSDC contract.

---

## Directory Structure

```
contracts/
├── contracts/
│   ├── ERC20Vault.sol
│   ├── ConfidentialVault.sol
│   ├── VaultFactory.sol
│   ├── ConfidentialUSDC.sol
│   ├── interfaces/IERC7984.sol
│   ├── test/MockERC20.sol
│   └── vendor/                  # vendored ERC-7984 (dep conflict workaround)
├── test/
│   ├── unit/
│   └── integration/
├── scripts/
│   ├── deploy.ts
│   ├── export-abi.ts
│   ├── update-vault-bytecode.ts
│   └── mint-usdc.ts
├── deployments/
│   └── sepolia.json
└── hardhat.config.ts
```
