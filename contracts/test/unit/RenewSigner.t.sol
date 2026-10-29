// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {EnclaveRegistry, IEnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {RegistryBase} from "../utils/RegistryBase.sol";

/// SPEC §3.4 renewSigner.
contract RenewSignerTest is RegistryBase {
    address internal signer;

    function setUp() public override {
        super.setUp();
        signer = _register();
    }

    /// A fresh attestation from the same key, `secondsLater` after registration.
    function _freshInput(uint256 secondsLater) internal returns (AttInput memory a) {
        vm.warp(START + secondsLater);
        a = _input(enclave);
    }

    function _renew(address caller, AttInput memory a) internal {
        bytes memory att = _attest(a);
        vm.prank(caller);
        registry.renewSigner(signer, att, "");
    }

    function _expectRenewRevert(address caller, AttInput memory a, bytes memory err) internal {
        bytes memory att = _attest(a);
        vm.prank(caller);
        vm.expectRevert(err);
        registry.renewSigner(signer, att, "");
    }

    /// Only expiresAt and attestationHash change.
    function test_renewSigner_extendsActiveUnexpired() public {
        IEnclaveRegistry.Signer memory before = registry.signers(signer);
        AttInput memory a = _freshInput(3 days);
        bytes32 tbsHash = keccak256(_tbsOf(a));
        uint64 expected = uint64(START + 3 days + 604800);
        bytes memory att = _attest(a);

        vm.expectEmit(address(registry));
        emit IEnclaveRegistry.SignerRenewed(signer, AGENT, expected, tbsHash, uint64(START + 3 days));
        vm.prank(operator);
        registry.renewSigner(signer, att, "");

        IEnclaveRegistry.Signer memory s = registry.signers(signer);
        assertEq(s.expiresAt, expected);
        assertEq(s.attestationHash, tbsHash);
        assertTrue(s.attestationHash != before.attestationHash);
        assertEq(s.agentId, before.agentId);
        assertEq(s.releaseId, before.releaseId);
        assertEq(s.originHash, before.originHash);
        assertEq(s.operator, before.operator);
        assertEq(s.registeredAt, before.registeredAt);
        assertEq(uint8(s.status), uint8(IEnclaveRegistry.SignerStatus.Active));
    }

    /// One second before expiry is still renewable.
    function test_renewSigner_lastSecond() public {
        _renew(operator, _freshInput(604800 - 1));
        assertEq(registry.signers(signer).expiresAt, START + 604799 + 604800);
    }

    // ------------------------------------------------------- SignerNotActive

    function test_renewSigner_expired_SignerNotActive() public {
        _expectRenewRevert(operator, _freshInput(604800), _err(EnclaveRegistry.SignerNotActive.selector));
    }

    function test_renewSigner_revoked_SignerNotActive() public {
        vm.prank(owner);
        registry.revokeSigner(signer);
        _expectRenewRevert(operator, _freshInput(10), _err(EnclaveRegistry.SignerNotActive.selector));
    }

    function test_renewSigner_unknown_SignerNotActive() public {
        Vm.Wallet memory other = vm.createWallet("never registered");
        bytes memory att = _attest(_input(other));
        vm.prank(operator);
        vm.expectRevert(EnclaveRegistry.SignerNotActive.selector);
        registry.renewSigner(other.addr, att, "");
    }

    // -------------------------------------------------------------- endpoint

    function test_renewSigner_EndpointInactive() public {
        vm.prank(owner);
        registry.retireEndpoint(originHash);
        _expectRenewRevert(operator, _freshInput(10), _err(EnclaveRegistry.EndpointInactive.selector));
    }

    /// The origin was retired and re-added for another agent.
    function test_renewSigner_EndpointMismatch() public {
        vm.startPrank(owner);
        registry.retireEndpoint(originHash);
        registry.addEndpoint(AGENT2, ORIGIN, payTo, operator);
        vm.stopPrank();
        _expectRenewRevert(operator, _freshInput(10), _err(EnclaveRegistry.EndpointMismatch.selector));
    }

    // ----------------------------------------------------------- NotOperator

    function test_renewSigner_NotOperator_nonOperator() public {
        AttInput memory a = _freshInput(10);
        address[3] memory callers = [owner, stranger, operator2];
        for (uint256 i = 0; i < 3; i++) {
            _expectRenewRevert(callers[i], a, _err(EnclaveRegistry.NotOperator.selector));
        }
    }

    /// After rotation the new operator can't renew the old operator's signer (e.operator != s.operator).
    function test_renewSigner_NotOperator_newOperatorAfterRotation() public {
        _rotateOperator(operator2);
        _expectRenewRevert(operator2, _freshInput(10), _err(EnclaveRegistry.NotOperator.selector));
    }

    /// ...and the old operator no longer is the endpoint's operator.
    function test_renewSigner_NotOperator_oldOperatorAfterRotation() public {
        _rotateOperator(operator2);
        _expectRenewRevert(operator, _freshInput(10), _err(EnclaveRegistry.NotOperator.selector));
    }

    // --------------------------------------------------------- re-proof steps

    function test_renewSigner_SignerMismatch() public {
        AttInput memory a = _freshInput(10);
        Vm.Wallet memory other = vm.createWallet("other enclave");
        a.publicKey = _publicKey(other.publicKeyX, other.publicKeyY);
        _expectRenewRevert(operator, a, _err(EnclaveRegistry.SignerMismatch.selector));
    }

    /// Same key, a different (also approved) release.
    function test_renewSigner_ReleaseMismatch() public {
        bytes memory p2 = _fill(0x44, 48);
        vm.prank(owner);
        registry.approveRelease(AGENT, pcr0, pcr1, p2, SOURCE_REF);
        AttInput memory a = _freshInput(10);
        a.pcr2 = p2;
        _expectRenewRevert(operator, a, _err(EnclaveRegistry.ReleaseMismatch.selector));
    }

    function test_renewSigner_ReleaseNotApproved_deprecated() public {
        vm.prank(owner);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Deprecated);
        _expectRenewRevert(operator, _freshInput(10), _err(EnclaveRegistry.ReleaseNotApproved.selector));
    }

    function test_renewSigner_AttestationStale() public {
        AttInput memory a = _freshInput(1 days);
        a.timestampMs = uint64(block.timestamp - 1801) * 1000;
        _expectRenewRevert(operator, a, _err(EnclaveRegistry.AttestationStale.selector));
    }

    function test_renewSigner_AttestationFromFuture() public {
        AttInput memory a = _freshInput(1 days);
        a.timestampMs = uint64(block.timestamp + 61) * 1000;
        _expectRenewRevert(operator, a, _err(EnclaveRegistry.AttestationFromFuture.selector));
    }

    function test_renewSigner_futureWithinSkew_noUnderflow() public {
        AttInput memory a = _freshInput(1 days);
        a.timestampMs = uint64(block.timestamp + 60) * 1000;
        _renew(operator, a);
    }

    function test_renewSigner_DebugPcrs() public {
        AttInput memory a = _freshInput(10);
        a.pcr1 = new bytes(48);
        _expectRenewRevert(operator, a, _err(EnclaveRegistry.DebugPcrs.selector));
    }

    function test_renewSigner_BindingMismatch() public {
        AttInput memory a = _freshInput(10);
        a.userData = _binding(registry, AGENT, keccak256(bytes(ORIGIN_B)));
        _expectRenewRevert(operator, a, abi.encodeWithSelector(EnclaveRegistry.BindingMismatch.selector, uint8(5)));
    }

    function test_renewSigner_InvalidPublicKey() public {
        AttInput memory a = _freshInput(10);
        a.nullMask = NULL_PUBLIC_KEY;
        _expectRenewRevert(operator, a, _err(EnclaveRegistry.InvalidPublicKey.selector));
    }

    function test_renewSigner_validatorRevertPropagates() public {
        AttInput memory a = _freshInput(10);
        bytes memory att = _attest(a);
        nitro.setRejectAll(true);
        vm.prank(operator);
        vm.expectRevert(bytes("mock: invalid sig"));
        registry.renewSigner(signer, att, "");
    }
}
