// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {DeployValidatorStack} from "../../script/DeployValidatorStack.s.sol";
import {DeployRegistry} from "../../script/DeployRegistry.s.sol";

/// Stands in for `forge script --broadcast`: the test runner cannot enter that context without sending.
contract BroadcastingValidatorStack is DeployValidatorStack {
    bool internal broadcasting;

    function setBroadcasting(bool b) external {
        broadcasting = b;
    }

    function _inBroadcastContext() internal view override returns (bool) {
        return broadcasting;
    }

    function runWith(address admin) external returns (ValidatorStack memory) {
        return _run(admin);
    }

    function refused(uint256 chainId, bool ctx) external pure returns (bool) {
        return _mainnetSendRefused(chainId, ctx);
    }

    function startBroadcast() external returns (address) {
        return _startBroadcast();
    }
}

contract BroadcastingRegistry is DeployRegistry {
    bool internal broadcasting;

    function setBroadcasting(bool b) external {
        broadcasting = b;
    }

    function _inBroadcastContext() internal view override returns (bool) {
        return broadcasting;
    }

    function runWith(address validator) external returns (address) {
        return address(_run(validator));
    }
}

/// T30: DeployBase accepts chain 42220 so `forge script` can simulate the mainnet deploy, but a real send
/// through it would be an untagged mainnet creation. Simulation (dry run) works; broadcast and resume
/// are refused. Limit: the Test context cannot be switched to ScriptBroadcast without sending, so the
/// guard's logic is tested through the `_inBroadcastContext` seam, and the cheatcode itself is only
/// shown here to answer false in the test context.
contract MainnetSendGuardTest is Test {
    address internal constant ADMIN = address(0xA11CE);
    string internal constant REFUSAL =
        "Celo mainnet (42220) is deployed with scripts/tagged-deploy.mjs (attribution suffix); forge script may only simulate there";
    BroadcastingValidatorStack internal stack;

    function setUp() public {
        stack = new BroadcastingValidatorStack();
    }

    function test_logic_refusesOnlyMainnetBroadcast() public view {
        assertTrue(stack.refused(42220, true));
        assertFalse(stack.refused(42220, false));
        assertFalse(stack.refused(11142220, true));
        assertFalse(stack.refused(11142220, false));
        assertFalse(stack.refused(1, true));
    }

    function test_mainnet_broadcast_refusedBeforeAnythingIsDeployed() public {
        vm.chainId(42220);
        stack.setBroadcasting(true);
        vm.expectRevert(bytes(REFUSAL));
        stack.runWith(ADMIN);
    }

    function test_mainnet_startBroadcast_refused() public {
        vm.chainId(42220);
        stack.setBroadcasting(true);
        vm.expectRevert(bytes(REFUSAL));
        stack.startBroadcast();
    }

    function test_mainnet_simulation_stillWorks() public {
        vm.chainId(42220);
        stack.setBroadcasting(false);
        DeployValidatorStack.ValidatorStack memory s = stack.runWith(ADMIN);
        assertTrue(address(s.nitroValidator).code.length != 0);
    }

    function test_sepolia_broadcast_isNotRefused() public {
        vm.chainId(11142220);
        stack.setBroadcasting(true);
        DeployValidatorStack.ValidatorStack memory s = stack.runWith(ADMIN);
        assertTrue(address(s.nitroValidator).code.length != 0);
    }

    function test_registryScript_mainnet_broadcast_refused() public {
        BroadcastingRegistry r = new BroadcastingRegistry();
        vm.chainId(42220);
        r.setBroadcasting(true);
        vm.expectRevert(bytes(REFUSAL));
        r.runWith(address(0x1234));
    }

    /// The real cheatcode, in the forge test context: not a broadcast.
    function test_realContext_inTest_isNotBroadcast() public view {
        assertTrue(vm.isContext(VmSafe.ForgeContext.Test));
        assertFalse(vm.isContext(VmSafe.ForgeContext.ScriptBroadcast));
        assertFalse(vm.isContext(VmSafe.ForgeContext.ScriptResume));
    }
}
