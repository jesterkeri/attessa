// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {EnclaveRegistry, IEnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {RegistryBase} from "../utils/RegistryBase.sol";

/// SPEC §3.4 registerSigner, steps 1-9 in order.
contract RegisterSignerTest is RegistryBase {
    // ------------------------------------------------------------ success

    /// None → Active. Every stored field comes from tbs via Ptrs; attestationHash = keccak256(tbs).
    function test_registerSigner_storesFromTbs() public {
        AttInput memory a = _input(enclave);
        bytes memory att = _attest(a);
        bytes32 tbsHash = keccak256(_tbsOf(a));
        assertTrue(tbsHash != keccak256(att), "mock tbs must differ from attestation");

        vm.expectEmit(address(registry));
        emit IEnclaveRegistry.SignerRegistered(
            enclave.addr, AGENT, releaseId, originHash, operator, uint64(START) + 604800, tbsHash, uint64(START)
        );
        vm.prank(operator);
        address signer = registry.registerSigner(AGENT, originHash, att, "");

        assertEq(signer, enclave.addr);
        IEnclaveRegistry.Signer memory s = registry.signers(signer);
        assertEq(s.agentId, AGENT);
        assertEq(s.releaseId, releaseId);
        assertEq(s.releaseId, keccak256(abi.encodePacked(pcr0, pcr1, pcr2)));
        assertEq(s.originHash, originHash);
        assertEq(s.operator, operator);
        assertEq(s.registeredAt, START);
        assertEq(s.expiresAt, START + 604800);
        assertEq(uint8(s.status), uint8(IEnclaveRegistry.SignerStatus.Active));
        assertEq(s.attestationHash, tbsHash);
    }

    /// The signer is derived from public_key only: another key's attestation registers that key.
    function test_registerSigner_signerIsPublicKeyAddress() public {
        Vm.Wallet memory other = vm.createWallet("other enclave");
        address signer = _register(_input(other));
        assertEq(signer, other.addr);
        assertEq(uint8(registry.signers(enclave.addr).status), uint8(IEnclaveRegistry.SignerStatus.None));
    }

    // ------------------------------------------------------- step 1: endpoint

    function test_registerSigner_EndpointInactive_unknown() public {
        bytes memory att = _attest(_input(enclave));
        vm.prank(operator);
        vm.expectRevert(EnclaveRegistry.EndpointInactive.selector);
        registry.registerSigner(AGENT, keccak256("https://nobody.example"), att, "");
    }

    function test_registerSigner_EndpointInactive_retired() public {
        vm.prank(owner);
        registry.retireEndpoint(originHash);
        _expectRegisterRevert(_input(enclave), _err(EnclaveRegistry.EndpointInactive.selector));
    }

    function test_registerSigner_EndpointMismatch() public {
        AttInput memory a = _input(enclave);
        a.userData = _binding(registry, AGENT2, originHash);
        bytes memory att = _attest(a);
        vm.prank(operator);
        vm.expectRevert(EnclaveRegistry.EndpointMismatch.selector);
        registry.registerSigner(AGENT2, originHash, att, "");
    }

    function test_registerSigner_NotOperator() public {
        bytes memory att = _attest(_input(enclave));
        address[3] memory callers = [owner, stranger, operator2];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(EnclaveRegistry.NotOperator.selector);
            registry.registerSigner(AGENT, originHash, att, "");
        }
    }

    /// After rotation only the new operator registers, and the signer records it.
    function test_registerSigner_afterOperatorRotation() public {
        _rotateOperator(operator2);
        bytes memory att = _attest(_input(enclave));
        vm.prank(operator);
        vm.expectRevert(EnclaveRegistry.NotOperator.selector);
        registry.registerSigner(AGENT, originHash, att, "");
        vm.prank(operator2);
        address signer = registry.registerSigner(AGENT, originHash, att, "");
        assertEq(registry.signers(signer).operator, operator2);
    }

    // ------------------------------------------------------ step 2: validator

    function test_registerSigner_validatorRevertPropagates() public {
        bytes memory att = _attest(_input(enclave));
        nitro.setRejectAll(true);
        vm.prank(operator);
        vm.expectRevert(bytes("mock: invalid sig"));
        registry.registerSigner(AGENT, originHash, att, "");
    }

    /// Without the 64-byte prefix stripped, the tbs is unknown to the validator.
    function test_registerSigner_tbsIsNotAttestation() public {
        AttInput memory a = _input(enclave);
        _attest(a);
        vm.prank(operator);
        vm.expectRevert(bytes("mock: unknown tbs"));
        registry.registerSigner(AGENT, originHash, abi.encodePacked(_junk(), _junk(), _tbsOf(a)), "");
    }

    // ---------------------------------------------------- step 3: freshness

    function _registerAt(int256 offsetSeconds, uint256 extraMs) internal returns (address) {
        AttInput memory a = _input(enclave);
        a.timestampMs = uint64(uint256(int256(START) + offsetSeconds) * 1000 + extraMs);
        return _register(a);
    }

    function _expectAt(int256 offsetSeconds, uint256 extraMs, bytes4 selector) internal {
        AttInput memory a = _input(enclave);
        a.timestampMs = uint64(uint256(int256(START) + offsetSeconds) * 1000 + extraMs);
        _expectRegisterRevert(a, _err(selector));
    }

    function test_age_1799s_ok() public {
        _registerAt(-1799, 0);
    }

    function test_age_1800s_ok() public {
        _registerAt(-1800, 0);
    }

    function test_age_1801s_AttestationStale() public {
        _expectAt(-1801, 0, EnclaveRegistry.AttestationStale.selector);
    }

    /// ts = floor(ms / 1000): (now - 1800) s + 999 ms floors to age 1800.
    function test_age_msFloored_1800s_ok() public {
        _registerAt(-1800, 999);
    }

    /// (now - 1801) s + 999 ms is 1800.001 s old but floors to age 1801.
    function test_age_msFloored_1801s_AttestationStale() public {
        _expectAt(-1801, 999, EnclaveRegistry.AttestationStale.selector);
    }

    function test_age_0s_ok() public {
        _registerAt(0, 0);
    }

    /// ts in (now, now + 60] has age 0 and must not underflow.
    function test_future_1s_ok() public {
        _registerAt(1, 0);
    }

    function test_future_59s_ok() public {
        _registerAt(59, 0);
    }

    function test_future_60s_ok() public {
        _registerAt(60, 0);
    }

    function test_future_60s999ms_ok() public {
        _registerAt(60, 999);
    }

    function test_future_61s_AttestationFromFuture() public {
        _expectAt(61, 0, EnclaveRegistry.AttestationFromFuture.selector);
    }

    function testFuzz_freshnessWindow(int256 offset) public {
        offset = bound(offset, -100_000, 100_000);
        AttInput memory a = _input(enclave);
        a.timestampMs = uint64(uint256(int256(START) + offset) * 1000);
        if (offset > 60) {
            _expectRegisterRevert(a, _err(EnclaveRegistry.AttestationFromFuture.selector));
        } else if (offset < -1800) {
            _expectRegisterRevert(a, _err(EnclaveRegistry.AttestationStale.selector));
        } else {
            _register(a);
        }
    }

    // ---------------------------------------------------------- step 4: PCRs

    function test_DebugPcrs_pcr0() public {
        AttInput memory a = _input(enclave);
        a.pcr0 = new bytes(48);
        _expectRegisterRevert(a, _err(EnclaveRegistry.DebugPcrs.selector));
    }

    function test_DebugPcrs_pcr1() public {
        AttInput memory a = _input(enclave);
        a.pcr1 = new bytes(48);
        _expectRegisterRevert(a, _err(EnclaveRegistry.DebugPcrs.selector));
    }

    function test_DebugPcrs_pcr2() public {
        AttInput memory a = _input(enclave);
        a.pcr2 = new bytes(48);
        _expectRegisterRevert(a, _err(EnclaveRegistry.DebugPcrs.selector));
    }

    function test_InvalidPcr_null() public {
        uint8[3] memory masks = [NULL_PCR0, NULL_PCR1, NULL_PCR2];
        for (uint256 i = 0; i < 3; i++) {
            AttInput memory a = _input(enclave);
            a.nullMask = masks[i];
            _expectRegisterRevert(a, _err(EnclaveRegistry.InvalidPcr.selector));
        }
    }

    /// 64 ‖ 32 ‖ 48 bytes concatenate to the same 144 bytes as an approved 48 ‖ 48 ‖ 48 release,
    /// so the per-PCR length check is what stops it.
    function test_InvalidPcr_lengthShiftCollision() public {
        AttInput memory a = _input(enclave);
        bytes memory all = abi.encodePacked(pcr0, pcr1, pcr2);
        a.pcr0 = new bytes(64);
        a.pcr1 = new bytes(32);
        a.pcr2 = new bytes(48);
        for (uint256 i = 0; i < 144; i++) {
            if (i < 64) a.pcr0[i] = all[i];
            else if (i < 96) a.pcr1[i - 64] = all[i];
            else a.pcr2[i - 96] = all[i];
        }
        assertEq(keccak256(abi.encodePacked(a.pcr0, a.pcr1, a.pcr2)), releaseId);
        _expectRegisterRevert(a, _err(EnclaveRegistry.InvalidPcr.selector));
    }

    // ------------------------------------------------------- step 5: release

    function test_ReleaseNotApproved_unknown() public {
        AttInput memory a = _input(enclave);
        a.pcr2 = _fill(0x44, 48);
        _expectRegisterRevert(a, _err(EnclaveRegistry.ReleaseNotApproved.selector));
    }

    function test_ReleaseNotApproved_deprecated() public {
        vm.prank(owner);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Deprecated);
        _expectRegisterRevert(_input(enclave), _err(EnclaveRegistry.ReleaseNotApproved.selector));
    }

    function test_ReleaseNotApproved_revoked() public {
        vm.prank(owner);
        registry.setReleaseStatus(AGENT, releaseId, IEnclaveRegistry.ReleaseStatus.Revoked);
        _expectRegisterRevert(_input(enclave), _err(EnclaveRegistry.ReleaseNotApproved.selector));
    }

    /// Approval is per agent: a release approved for AGENT2 only doesn't count for AGENT.
    function test_ReleaseNotApproved_approvedForOtherAgent() public {
        bytes memory p2 = _fill(0x44, 48);
        vm.prank(owner);
        registry.approveRelease(AGENT2, pcr0, pcr1, p2, SOURCE_REF);
        AttInput memory a = _input(enclave);
        a.pcr2 = p2;
        _expectRegisterRevert(a, _err(EnclaveRegistry.ReleaseNotApproved.selector));
    }

    // ---------------------------------------------------- step 6: user_data

    function _expectBinding(AttInput memory a, uint8 field) internal {
        _expectRegisterRevert(a, abi.encodeWithSelector(EnclaveRegistry.BindingMismatch.selector, field));
    }

    function test_BindingMismatch_0_null() public {
        AttInput memory a = _input(enclave);
        a.nullMask = NULL_USER_DATA;
        _expectBinding(a, 0);
    }

    function test_BindingMismatch_0_short() public {
        AttInput memory a = _input(enclave);
        a.userData = _fill(0x01, 159);
        _expectBinding(a, 0);
    }

    function test_BindingMismatch_0_long() public {
        AttInput memory a = _input(enclave);
        a.userData = abi.encodePacked(_binding(registry, AGENT, originHash), bytes1(0));
        _expectBinding(a, 0);
    }

    function test_BindingMismatch_1_typehash() public {
        AttInput memory a = _input(enclave);
        a.userData = abi.encode(keccak256("other"), block.chainid, address(registry), AGENT, originHash);
        _expectBinding(a, 1);
    }

    function test_BindingMismatch_2_chainId() public {
        AttInput memory a = _input(enclave);
        a.userData = abi.encode(registry.BINDING_TYPEHASH(), block.chainid + 1, address(registry), AGENT, originHash);
        _expectBinding(a, 2);
    }

    function test_BindingMismatch_3_registry() public {
        AttInput memory a = _input(enclave);
        a.userData = abi.encode(registry.BINDING_TYPEHASH(), block.chainid, address(nitro), AGENT, originHash);
        _expectBinding(a, 3);
    }

    function test_BindingMismatch_4_agentId() public {
        AttInput memory a = _input(enclave);
        a.userData = _binding(registry, AGENT2, originHash);
        _expectBinding(a, 4);
    }

    function test_BindingMismatch_5_originHash() public {
        AttInput memory a = _input(enclave);
        a.userData = _binding(registry, AGENT, keccak256(bytes(ORIGIN_B)));
        _expectBinding(a, 5);
    }

    /// Any 160-byte user_data other than the exact binding is rejected.
    function testFuzz_BindingMismatch_random(bytes32[5] memory words) public {
        bytes memory ud = abi.encodePacked(words[0], words[1], words[2], words[3], words[4]);
        vm.assume(keccak256(ud) != keccak256(_binding(registry, AGENT, originHash)));
        AttInput memory a = _input(enclave);
        a.userData = ud;
        bytes memory att = _attest(a);
        vm.prank(operator);
        try registry.registerSigner(AGENT, originHash, att, "") {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), EnclaveRegistry.BindingMismatch.selector);
        }
    }

    // --------------------------------------------------- step 7: public_key

    function test_InvalidPublicKey_null() public {
        AttInput memory a = _input(enclave);
        a.nullMask = NULL_PUBLIC_KEY;
        _expectRegisterRevert(a, _err(EnclaveRegistry.InvalidPublicKey.selector));
    }

    function test_InvalidPublicKey_64bytes() public {
        AttInput memory a = _input(enclave);
        a.publicKey = abi.encodePacked(enclave.publicKeyX, enclave.publicKeyY);
        _expectRegisterRevert(a, _err(EnclaveRegistry.InvalidPublicKey.selector));
    }

    function test_InvalidPublicKey_66bytes() public {
        AttInput memory a = _input(enclave);
        a.publicKey = abi.encodePacked(_publicKey(enclave.publicKeyX, enclave.publicKeyY), bytes1(0));
        _expectRegisterRevert(a, _err(EnclaveRegistry.InvalidPublicKey.selector));
    }

    function test_InvalidPublicKey_compressedPrefix() public {
        AttInput memory a = _input(enclave);
        a.publicKey = abi.encodePacked(bytes1(0x02), enclave.publicKeyX, enclave.publicKeyY);
        _expectRegisterRevert(a, _err(EnclaveRegistry.InvalidPublicKey.selector));
    }

    // -------------------------------------------------------- step 8: unique

    function test_SignerExists() public {
        _register();
        vm.warp(START + 5);
        _expectRegisterRevert(_input(enclave), _err(EnclaveRegistry.SignerExists.selector));
    }

    /// The same key can't be bound to a second origin either.
    function test_SignerExists_otherOrigin() public {
        _register();
        vm.prank(owner);
        bytes32 h2 = registry.addEndpoint(AGENT, ORIGIN_B, payTo, operator);
        AttInput memory a = _input(enclave);
        a.userData = _binding(registry, AGENT, h2);
        bytes memory att = _attest(a);
        vm.prank(operator);
        vm.expectRevert(EnclaveRegistry.SignerExists.selector);
        registry.registerSigner(AGENT, h2, att, "");
    }
}
