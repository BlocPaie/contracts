// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "../vendor/token/ERC7984/ERC7984.sol";

contract MockConfidentialERC20 is ZamaEthereumConfig, ERC7984 {
    constructor() ERC7984("Confidential USDC", "cUSDC", "") {}

    function mint(address to, uint64 amount) external {
        _mint(to, FHE.asEuint64(amount));
    }
}
