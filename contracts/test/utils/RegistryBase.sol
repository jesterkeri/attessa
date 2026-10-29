// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {EnclaveRegistry, IEnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {MockNitroValidator, MockIdentityRegistry, MockSelfRegistry} from "../mocks/Mocks.sol";
import {AttestationKit} from "./AttestationKit.sol";

/// One agent owned by `owner`, one approved release, one Active endpoint run by `operator`.
abstract contract RegistryBase is Test, AttestationKit {
    uint256 internal constant AGENT = 1;
    uint256 internal constant AGENT2 = 2;
    uint256 internal constant START = 1_800_000_000;
    string internal constant ORIGIN = "https://seller.example";
    string internal constant ORIGIN_B = "https://other.example";
    string internal constant SOURCE_REF = "git+https://github.com/jesterkeri/attessa@0123abc";

    MockIdentityRegistry internal identity;
    MockSelfRegistry internal selfReg;
    MockNitroValidator internal nitro;
    EnclaveRegistry internal registry;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal operator2 = makeAddr("operator2");
    address internal stranger = makeAddr("stranger");
    address internal payTo = makeAddr("payTo");

    bytes internal pcr0;
    bytes internal pcr1;
    bytes internal pcr2;
    bytes32 internal releaseId;
    bytes32 internal originHash;
    Vm.Wallet internal enclave;

    function setUp() public virtual {
        vm.warp(START);
        identity = new MockIdentityRegistry();
        selfReg = new MockSelfRegistry();
        nitro = new MockNitroValidator();
        registry = new EnclaveRegistry(address(identity), address(nitro), address(selfReg), false);
        identity.setOwner(AGENT, owner);
        identity.setOwner(AGENT2, owner);

        pcr0 = _fill(0x11, 48);
        pcr1 = _fill(0x22, 48);
        pcr2 = _fill(0x33, 48);
        vm.prank(owner);
        releaseId = registry.approveRelease(AGENT, pcr0, pcr1, pcr2, SOURCE_REF);
        vm.prank(owner);
        originHash = registry.addEndpoint(AGENT, ORIGIN, payTo, operator);
        enclave = vm.createWallet("enclave");
    }

    /// A valid attestation input for `w` bound to (AGENT, ORIGIN), timestamped now.
    function _input(Vm.Wallet memory w) internal view returns (AttInput memory a) {
        a.timestampMs = uint64(block.timestamp) * 1000;
        a.pcr0 = pcr0;
        a.pcr1 = pcr1;
        a.pcr2 = pcr2;
        a.userData = _binding(registry, AGENT, originHash);
        a.publicKey = _publicKey(w.publicKeyX, w.publicKeyY);
    }

    function _attest(AttInput memory a) internal returns (bytes memory) {
        return _attest(nitro, a);
    }

    function _register(AttInput memory a) internal returns (address) {
        bytes memory att = _attest(a);
        vm.prank(operator);
        return registry.registerSigner(AGENT, originHash, att, "");
    }

    function _register() internal returns (address) {
        return _register(_input(enclave));
    }

    function _expectRegisterRevert(AttInput memory a, bytes memory err) internal {
        bytes memory att = _attest(a);
        vm.prank(operator);
        vm.expectRevert(err);
        registry.registerSigner(AGENT, originHash, att, "");
    }

    function _err(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    function _code(address signer, bytes32 origin) internal view returns (IEnclaveRegistry.Check code) {
        (code,,) = registry.checkSigner(signer, origin);
    }

    function _rotateOperator(address newOperator) internal {
        vm.startPrank(owner);
        registry.retireEndpoint(originHash);
        registry.addEndpoint(AGENT, ORIGIN, payTo, newOperator);
        vm.stopPrank();
    }
}
