// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CertManager} from "nitro-validator/CertManager.sol";
import {P384Verifier} from "nitro-validator/P384Verifier.sol";
import {DeployValidatorStack} from "../../script/DeployValidatorStack.s.sol";

/// The validator-stack script on both supported chains. It deploys the production CertManager on
/// 42220 as on 11142220 (never CertManagerDemo), keeps the admin guard, and refuses every other chain.
contract DeployValidatorStackTest is Test {
    address internal constant ADMIN = address(0xA11CE);
    DeployValidatorStack internal script;

    function setUp() public {
        script = new DeployValidatorStack();
        // setEnv is process-wide and tests share it: every test sets its own admin.
        vm.setEnv("ATTESSA_ADMIN", vm.toString(ADMIN));
    }

    function _checkProduction(DeployValidatorStack.ValidatorStack memory s) internal {
        assertEq(
            address(s.certManager).codehash, address(new CertManager(s.p384Verifier, address(1), address(1))).codehash
        );
        assertEq(address(s.p384Verifier).codehash, address(new P384Verifier()).codehash);
        assertEq(s.certManager.owner(), ADMIN);
        assertEq(address(s.nitroValidator.certManager()), address(s.certManager));
        assertEq(address(s.nitroValidator.p384Verifier()), address(s.p384Verifier));
    }

    function test_mainnet_deploysProductionCertManager() public {
        vm.chainId(42220);
        vm.setEnv("ATTESSA_ADMIN", vm.toString(ADMIN));
        _checkProduction(script.run());
    }

    function test_sepolia_deploysProductionCertManager() public {
        vm.chainId(11142220);
        vm.setEnv("ATTESSA_ADMIN", vm.toString(ADMIN));
        _checkProduction(script.run());
    }

    function test_otherChains_refused() public {
        uint256[3] memory ids = [uint256(1), 44787, 31337];
        for (uint256 i = 0; i < ids.length; i++) {
            vm.chainId(ids[i]);
            vm.expectRevert(bytes("Celo mainnet (42220) or Celo Sepolia (11142220) only"));
            script.run();
        }
    }

    function test_mainnet_adminMustNotBeDeployer() public {
        vm.chainId(42220);
        // Under forge test the default sender stands in for the deployer.
        vm.setEnv("ATTESSA_ADMIN", vm.toString(DEFAULT_SENDER_FOR_TEST));
        vm.expectRevert(bytes("ATTESSA_ADMIN must be the cold admin key, not the deployer"));
        script.run();
    }

    address internal constant DEFAULT_SENDER_FOR_TEST = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    function test_zeroAdmin_refused() public {
        vm.chainId(42220);
        vm.setEnv("ATTESSA_ADMIN", vm.toString(address(0)));
        vm.expectRevert(bytes("ATTESSA_ADMIN is zero"));
        script.run();
    }
}
