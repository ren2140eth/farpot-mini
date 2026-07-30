// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// TEMPORARY — Phase 1 toolchain smoke test. Proves the solc pin, both remappings, and that
// `forge test` runs. Deleted in Phase 2 once the real interfaces and tests land.

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

contract ScaffoldTest is Test {
    function test_remappings_and_solc_pin() public pure {
        // solady resolves, and fullMulDiv is the exact helper `claim` will use for the
        // pro-rata split (design §4, invariant I5/I7).
        assertEq(FixedPointMathLib.fullMulDiv(1_000_000, 3, 7), 428_571);
        // Floors, never rounds up — the property the dust bound depends on.
        assertEq(FixedPointMathLib.fullMulDiv(10, 1, 3), 3);
    }

    function test_forge_std_available() public {
        // forge-std resolves and cheatcodes work.
        vm.chainId(8453);
        assertEq(block.chainid, 8453);
    }
}
