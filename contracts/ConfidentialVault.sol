// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FHE, euint64, euint8, eaddress, ebool, externalEuint64, externalEaddress} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC7984} from "./vendor/interfaces/IERC7984.sol";

contract ConfidentialVault is ZamaEthereumConfig, Ownable {

    // ── Types ──────────────────────────────────────────────────────────

    enum ChequeStatus { NotCreated, Pending, Executed, Cancelled }

    struct ConfidentialCheque {
        bytes32 invoiceHash;    // plaintext
        eaddress payee;         // ENCRYPTED
        euint64 amount;         // ENCRYPTED
        euint8 status;          // ENCRYPTED — must be encrypted for FHE.select conditional update
        uint256 createdAt;      // plaintext
    }

    struct LastError {
        euint8 error;
        uint256 timestamp;
    }

    // ── Errors ──────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidInvoiceHash();
    error InvoiceAlreadyRegistered();
    error InvalidChequeId();

    // ── Events ──────────────────────────────────────────────────────────

    event FundsDeposited(address indexed from);
    event FundsWithdrawn(address indexed to);
    event ChequeCreated(uint256 indexed chequeId, bytes32 indexed invoiceHash);
    // NOTE: This event signals that executeCheque was called, NOT that the payee received tokens.
    // Successful payment is confirmed by watching ConfidentialTransfer from the token contract.
    // Emitting on every call (including non-payee calls) is intentional — it gives off-chain
    // systems a call log — but it must NOT be treated as proof of execution.
    event ChequeExecuteAttempted(uint256 indexed chequeId, address indexed caller);
    event ChequeCancelled(uint256 indexed chequeId);
    event ErrorChanged(address indexed user);

    // ── Immutables ──────────────────────────────────────────────────────

    address public immutable TOKEN;

    // ── State ───────────────────────────────────────────────────────────

    // All arithmetic stays in encrypted space; no on-chain decryption.
    // Available balance = _vaultBalance - _allocatedBalance
    euint64 private _vaultBalance;
    euint64 private _allocatedBalance;

    // Global incrementing ID — cheques are NOT keyed by payee because payee is encrypted.
    uint256 public chequeCount;

    mapping(bytes32 => bool) public invoiceRegistry;

    // Flat storage by chequeId. Anyone may call executeCheque(id); only the real
    // payee gets tokens — verified via encrypted address comparison.
    mapping(uint256 => ConfidentialCheque) private _cheques;

    mapping(address => LastError) private _lastErrors;

    euint8 private _NO_ERROR;
    euint8 private _NOT_ENOUGH_FUNDS;
    euint8 private _NOT_PAYEE;
    euint8 private _NOT_PENDING;

    // ── Constructor ─────────────────────────────────────────────────────

    // Same (address, address) signature as ERC20Vault — VaultFactory compatible.
    constructor(address _owner, address _token) Ownable(_owner) {
        if (_token == address(0)) revert ZeroAddress();
        TOKEN = _token;
        _vaultBalance = FHE.asEuint64(0);
        FHE.allowThis(_vaultBalance);
        _allocatedBalance = FHE.asEuint64(0);
        FHE.allowThis(_allocatedBalance);
        _initializeErrorCodes();
    }

    // ── Owner Functions ─────────────────────────────────────────────────

    /// @notice Deposit encrypted funds into the vault.
    /// @dev Caller must have called confidentialApprove(address(this), ...) on the token first.
    function depositFunds(externalEuint64 encAmount, bytes calldata inputProof) external onlyOwner {
        euint64 amount = FHE.fromExternal(encAmount, inputProof);
        FHE.allowTransient(amount, TOKEN);
        IERC7984(TOKEN).confidentialTransferFrom(msg.sender, address(this), amount);
        _vaultBalance = FHE.add(_vaultBalance, amount);
        FHE.allowThis(_vaultBalance);
        emit FundsDeposited(msg.sender);
    }

    /// @notice Register an invoice and allocate encrypted funds for the payee.
    /// @dev Payee address is encrypted — ACL cannot be granted to payee at registration time.
    ///      If available balance is insufficient, a 0-amount cheque is stored and error code 1 is set.
    function registerInvoice(
        bytes32 invoiceHash,
        externalEaddress encPayee,
        bytes calldata payeeProof,
        externalEuint64 encAmount,
        bytes calldata amountProof,
        address decryptViewer
    ) external onlyOwner {
        if (invoiceHash == bytes32(0)) revert InvalidInvoiceHash();
        if (invoiceRegistry[invoiceHash]) revert InvoiceAlreadyRegistered();

        eaddress payee = FHE.fromExternal(encPayee, payeeProof);
        euint64 amount = FHE.fromExternal(encAmount, amountProof);

        // Compute available balance in encrypted space — no decryption needed.
        euint64 available = FHE.sub(_vaultBalance, _allocatedBalance);
        ebool sufficient = FHE.ge(available, amount);

        // If insufficient funds, effective = 0 (cheque stored but cannot be executed).
        euint64 effective = FHE.select(sufficient, amount, FHE.asEuint64(0));
        _allocatedBalance = FHE.add(_allocatedBalance, effective);
        FHE.allowThis(_allocatedBalance);

        invoiceRegistry[invoiceHash] = true;

        ConfidentialCheque storage cheque = _cheques[chequeCount];
        cheque.invoiceHash = invoiceHash;
        cheque.createdAt = block.timestamp;

        // Grant owner ACL to decrypt payee and amount off-chain.
        // Cannot grant payee ACL here — payee address is encrypted, plaintext unknown.
        cheque.payee = payee;
        FHE.allowThis(payee);
        FHE.allow(payee, msg.sender);

        cheque.amount = effective;
        FHE.allowThis(effective);
        FHE.allow(effective, msg.sender);

        cheque.status = FHE.asEuint8(uint8(ChequeStatus.Pending));
        FHE.allowThis(cheque.status);

        _setLastError(FHE.select(sufficient, _NO_ERROR, _NOT_ENOUGH_FUNDS), msg.sender, decryptViewer);

        emit ChequeCreated(chequeCount, invoiceHash);
        chequeCount++;
    }

    /// @notice Cancel a pending cheque and release its allocated balance.
    /// @dev Status updated via FHE.select — if cheque is not pending, this is a no-op with error code set.
    function cancelCheque(uint256 chequeId, address decryptViewer) external onlyOwner {
        if (chequeId >= chequeCount) revert InvalidChequeId();

        ConfidentialCheque storage cheque = _cheques[chequeId];

        ebool isPending = FHE.eq(cheque.status, FHE.asEuint8(uint8(ChequeStatus.Pending)));

        euint8 newStatus = FHE.select(isPending, FHE.asEuint8(uint8(ChequeStatus.Cancelled)), cheque.status);
        cheque.status = newStatus;
        FHE.allowThis(newStatus);
        FHE.allow(newStatus, owner());

        euint64 deduction = FHE.select(isPending, cheque.amount, FHE.asEuint64(0));
        _allocatedBalance = FHE.sub(_allocatedBalance, deduction);
        FHE.allowThis(_allocatedBalance);

        _setLastError(FHE.select(isPending, _NO_ERROR, _NOT_PENDING), msg.sender, decryptViewer);

        emit ChequeCancelled(chequeId);
    }

    /// @notice Withdraw unallocated funds from the vault.
    /// @dev If amount exceeds available balance, effective withdrawal is 0 and error code 1 is set.
    function withdrawFunds(externalEuint64 encAmount, bytes calldata inputProof, address decryptViewer) external onlyOwner {
        euint64 amount = FHE.fromExternal(encAmount, inputProof);

        euint64 available = FHE.sub(_vaultBalance, _allocatedBalance);
        ebool sufficient = FHE.ge(available, amount);

        euint64 effective = FHE.select(sufficient, amount, FHE.asEuint64(0));
        FHE.allowTransient(effective, TOKEN);
        IERC7984(TOKEN).confidentialTransfer(msg.sender, effective);
        _vaultBalance = FHE.sub(_vaultBalance, effective);
        FHE.allowThis(_vaultBalance);

        _setLastError(FHE.select(sufficient, _NO_ERROR, _NOT_ENOUGH_FUNDS), msg.sender, decryptViewer);

        emit FundsWithdrawn(msg.sender);
    }

    // ── Payee Functions ─────────────────────────────────────────────────

    /// @notice Attempt to execute a cheque. Anyone may call; only the real payee receives tokens.
    /// @dev Payee verified via encrypted address comparison (FHE.eq).
    ///      If caller is not the payee or cheque is not pending, transfer amount is 0.
    ///      Status updated via FHE.select — prevents DoS where a non-payee marks a cheque executed.
    ///      ChequeExecuteAttempted is emitted on every call regardless of outcome.
    ///      Off-chain systems must NOT treat this event as payment confirmation.
    ///      Confirmed payment is the ConfidentialTransfer event emitted by the token contract.
    function executeCheque(uint256 chequeId, address decryptViewer) external {
        if (chequeId >= chequeCount) revert InvalidChequeId();

        ConfidentialCheque storage cheque = _cheques[chequeId];

        ebool isPayee = FHE.eq(cheque.payee, msg.sender);
        ebool isPending = FHE.eq(cheque.status, FHE.asEuint8(uint8(ChequeStatus.Pending)));
        ebool canExecute = FHE.and(isPayee, isPending);

        euint8 newStatus = FHE.select(canExecute, FHE.asEuint8(uint8(ChequeStatus.Executed)), cheque.status);
        cheque.status = newStatus;
        FHE.allowThis(newStatus);
        FHE.allow(newStatus, owner());

        euint64 transferAmount = FHE.select(canExecute, cheque.amount, FHE.asEuint64(0));
        _allocatedBalance = FHE.sub(_allocatedBalance, transferAmount);
        FHE.allowThis(_allocatedBalance);
        _vaultBalance = FHE.sub(_vaultBalance, transferAmount);
        FHE.allowThis(_vaultBalance);

        FHE.allowTransient(transferAmount, TOKEN);
        IERC7984(TOKEN).confidentialTransfer(msg.sender, transferAmount);

        _setLastError(FHE.select(canExecute, _NO_ERROR, _NOT_PAYEE), msg.sender, decryptViewer);

        emit ChequeExecuteAttempted(chequeId, msg.sender);
    }

    // ── View Functions ──────────────────────────────────────────────────

    /// @notice Returns the cheque struct with encrypted handles for payee, amount, and status.
    ///         Callers with ACL permission can decrypt handles off-chain via the Zama SDK.
    function getCheque(uint256 chequeId) external view returns (ConfidentialCheque memory) {
        if (chequeId >= chequeCount) revert InvalidChequeId();
        return _cheques[chequeId];
    }

    function getChequeCount() external view returns (uint256) {
        return chequeCount;
    }

    function getVaultBalance() external view returns (euint64) {
        return _vaultBalance;
    }

    function getAllocatedBalance() external view returns (euint64) {
        return _allocatedBalance;
    }

    /// @notice Grant a secp256k1 viewer address ACL access to decrypt vault balances off-chain.
    ///         Required because Porto (passkey wallet) signs with WebAuthn P256, which is incompatible
    ///         with Zama's secp256k1 ECDSA recovery. The caller generates an ephemeral secp256k1 key,
    ///         calls this function once per session, then signs Zama's EIP-712 locally — no passkey dialog.
    function grantDecryptAccess(address viewer) external onlyOwner {
        FHE.allow(_vaultBalance, viewer);
        FHE.allow(_allocatedBalance, viewer);
    }

    /// @notice Returns the last error handle and timestamp for a user.
    ///         The user can decrypt the euint8 handle off-chain to read the error code.
    function getLastError(address user) external view returns (euint8, uint256) {
        LastError storage e = _lastErrors[user];
        return (e.error, e.timestamp);
    }

    // ── Internal Helpers ─────────────────────────────────────────────────

    function _setLastError(euint8 error, address user, address decryptViewer) internal {
        FHE.allowThis(error);
        FHE.allow(error, decryptViewer);
        _lastErrors[user] = LastError(error, block.timestamp);
        emit ErrorChanged(user);
    }

    function _initializeErrorCodes() internal {
        _NO_ERROR = FHE.allowThis(FHE.asEuint8(0));
        _NOT_ENOUGH_FUNDS = FHE.allowThis(FHE.asEuint8(1));
        _NOT_PAYEE = FHE.allowThis(FHE.asEuint8(2));
        _NOT_PENDING = FHE.allowThis(FHE.asEuint8(3));
    }
}
