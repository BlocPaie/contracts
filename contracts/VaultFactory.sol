// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract VaultFactory is Ownable {
    // ── Events ──────────────────────────────────────────────────────────

    event VaultTypeRegistered(bytes32 indexed vaultType, bytes32 codeHash);
    event VaultTypeUpdated(bytes32 indexed vaultType, bytes32 oldCodeHash, bytes32 newCodeHash);
    event VaultTypeRemoved(bytes32 indexed vaultType);
    event VaultCreated(address indexed vault, address indexed owner, bytes32 indexed vaultType);

    // ── Errors ──────────────────────────────────────────────────────────

    error VaultTypeNotRegistered();
    error VaultTypeAlreadyRegistered();
    error DeploymentFailed();
    error EmptyBytecode();

    // ── State ───────────────────────────────────────────────────────────

    mapping(bytes32 => bytes) public vaultBytecode;
    address[] public vaults;
    mapping(address => address[]) public vaultsByOwner;

    // ── Constructor ─────────────────────────────────────────────────────

    constructor() Ownable(msg.sender) {}

    // ── Owner Functions ─────────────────────────────────────────────────

    function registerVaultType(bytes32 vaultType, bytes calldata creationCode) external onlyOwner {
        if (creationCode.length == 0) revert EmptyBytecode();
        if (vaultBytecode[vaultType].length != 0) revert VaultTypeAlreadyRegistered();
        vaultBytecode[vaultType] = creationCode;
        emit VaultTypeRegistered(vaultType, keccak256(creationCode));
    }

    function updateVaultType(bytes32 vaultType, bytes calldata creationCode) external onlyOwner {
        if (creationCode.length == 0) revert EmptyBytecode();
        bytes storage existing = vaultBytecode[vaultType];
        if (existing.length == 0) revert VaultTypeNotRegistered();
        bytes32 oldCodeHash = keccak256(existing);
        vaultBytecode[vaultType] = creationCode;
        emit VaultTypeUpdated(vaultType, oldCodeHash, keccak256(creationCode));
    }

    function removeVaultType(bytes32 vaultType) external onlyOwner {
        if (vaultBytecode[vaultType].length == 0) revert VaultTypeNotRegistered();
        delete vaultBytecode[vaultType];
        emit VaultTypeRemoved(vaultType);
    }

    // ── Vault Deployment ────────────────────────────────────────────────

    function createVault(bytes32 vaultType, address token) external returns (address vault) {
        bytes memory bytecode = vaultBytecode[vaultType];
        if (bytecode.length == 0) revert VaultTypeNotRegistered();

        bytes memory deployCode = abi.encodePacked(bytecode, abi.encode(msg.sender, token));

        assembly {
            vault := create(0, add(deployCode, 0x20), mload(deployCode))
        }
        if (vault == address(0)) revert DeploymentFailed();

        vaults.push(vault);
        vaultsByOwner[msg.sender].push(vault);

        emit VaultCreated(vault, msg.sender, vaultType);
    }

    // ── View Functions ──────────────────────────────────────────────────

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function vaultCountByOwner(address _owner) external view returns (uint256) {
        return vaultsByOwner[_owner].length;
    }
}
