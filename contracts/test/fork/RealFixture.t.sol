// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {NitroValidator} from "nitro-validator/NitroValidator.sol";
import {CertManager} from "nitro-validator/CertManager.sol";
import {ICertManager} from "nitro-validator/ICertManager.sol";
import {P384Verifier} from "nitro-validator/P384Verifier.sol";
import {Sha2Ext} from "nitro-validator/Sha2Ext.sol";
import {CborDecode, CborElement, LibCborElement} from "nitro-validator/CborDecode.sol";
import {LibBytes} from "nitro-validator/LibBytes.sol";
import {P384HintCollector} from "../../lib/nitro-validator/test/helpers/HintedNitroTestHelpers.sol";
import {EnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {NitroFixture} from "./NitroFixture.sol";

interface IIdentityRegistryWrite {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address);
}

/// Exposes NitroValidator's parser so the test can find the fixture's certs before they're cached.
contract NitroParseHarness is NitroValidator {
    constructor(CertManager c, P384Verifier p) NitroValidator(c, p) {}

    function parse(bytes memory tbs) external pure returns (Ptrs memory) {
        return _parseAttestation(tbs);
    }
}

/// T07: base's real Nitro fixture against EnclaveRegistry on a Celo Sepolia fork, with the
/// production P384Verifier -> CertManager -> NitroValidator stack (never CertManagerDemo) and the
/// live ERC-8004 Identity Registry. Run with `--fork-url` Celo Sepolia; skipped elsewhere.
contract RealFixtureTest is Test {
    using CborDecode for bytes;
    using LibCborElement for CborElement;
    using LibBytes for bytes;

    uint256 internal constant CELO_SEPOLIA = 11142220;
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant SELF = 0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379;
    uint256 internal constant GAS_CEILING = 16_000_000;
    uint256 internal constant MODEXP_FLOOR_DELTA = 300; // EIP-7883 floor 500 - EIP-2565 floor 200 (upstream's projection)
    string internal constant ORIGIN = "https://seller.attessa.example";

    uint64 internal fixtureTs = NitroFixture.TIMESTAMP_MS / 1000;
    address internal owner = makeAddr("agent owner");
    address internal operator = makeAddr("operator");

    P384Verifier internal p384;
    CertManager internal certManager;
    NitroParseHarness internal validator;
    EnclaveRegistry internal registry;
    P384HintCollector internal collector;

    bytes internal attestation;
    bytes internal tbs;
    bytes internal sig;
    bytes internal hints;
    ICertManager.VerifiedCert internal leaf;
    uint256 internal agentId;
    bytes32 internal originHash;

    function setUp() public {
        if (block.chainid != CELO_SEPOLIA) return;
        vm.warp(fixtureTs + 60);

        p384 = new P384Verifier();
        certManager = new CertManager(p384, address(this), address(this));
        validator = new NitroParseHarness(certManager, p384);
        registry = new EnclaveRegistry(IDENTITY, address(validator), SELF, false);
        collector = new P384HintCollector();

        attestation = NitroFixture.attestation();
        assertEq(keccak256(attestation), NitroFixture.FIXTURE_HASH, "fixture bytes changed");
        (tbs, sig) = validator.decodeAttestationTbs(attestation);
        leaf = _cacheCertBundle(tbs);
        hints = collector.collectVerifyHints(Sha2Ext.sha384(tbs, 0, tbs.length), sig, leaf.pubKey);

        vm.startPrank(owner);
        agentId = IIdentityRegistryWrite(IDENTITY).register("https://seller.attessa.example/agent.json");
        NitroValidator.Ptrs memory ptrs = validator.parse(tbs);
        registry.approveRelease(
            agentId, tbs.slice(ptrs.pcrs[0]), tbs.slice(ptrs.pcrs[1]), tbs.slice(ptrs.pcrs[2]), "base fixture"
        );
        originHash = registry.addEndpoint(agentId, ORIGIN, owner, operator);
        vm.stopPrank();
        assertEq(IIdentityRegistryWrite(IDENTITY).ownerOf(agentId), owner);
    }

    function _onFork() internal {
        if (block.chainid != CELO_SEPOLIA) vm.skip(true);
    }

    /// Upstream's cold-cache sequence: each CA cert, then the leaf, against the production CertManager.
    function _cacheCertBundle(bytes memory t) internal returns (ICertManager.VerifiedCert memory) {
        NitroValidator.Ptrs memory ptrs = validator.parse(t);
        bytes32 parentHash;
        for (uint256 i = 0; i < ptrs.cabundle.length; ++i) {
            bytes memory caCert = t.slice(ptrs.cabundle[i]);
            bytes memory h;
            if (i != 0) h = collector.collectCertSignatureHints(caCert, certManager.loadVerified(parentHash).pubKey);
            parentHash = certManager.verifyCACertWithHints(caCert, parentHash, h);
        }
        bytes memory clientCert = t.slice(ptrs.cert);
        bytes memory ch = collector.collectCertSignatureHints(clientCert, certManager.loadVerified(parentHash).pubKey);
        return certManager.verifyClientCertWithHints(clientCert, parentHash, ch);
    }

    function _expectBindingMismatch0(bytes memory att) internal {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(EnclaveRegistry.BindingMismatch.selector, uint8(0)));
        registry.registerSigner(agentId, originHash, att, hints);
    }

    /// (a) The genuine, non-debug fixture passes NitroValidator, freshness, the zero-PCR check and
    /// the release check, then fails on its 20-byte user_data.
    function test_realFixture_a_registerReverts_BindingMismatch0() public {
        _onFork();
        NitroValidator.Ptrs memory ptrs = validator.validateAttestationWithHints(tbs, sig, hints);
        assertEq(ptrs.timestamp, NitroFixture.TIMESTAMP_MS);
        assertEq(block.timestamp - ptrs.timestamp / 1000, 60);
        for (uint256 i = 0; i < 3; i++) {
            bytes memory pcr = tbs.slice(ptrs.pcrs[i]);
            assertEq(pcr.length, 48);
            assertTrue(keccak256(pcr) != keccak256(new bytes(48)), "debug PCR");
        }
        assertFalse(ptrs.userData.isNull());
        assertEq(ptrs.userData.length(), 20);
        assertTrue(ptrs.publicKey.isNull());

        _expectBindingMismatch0(attestation);
    }

    /// (b) Re-encode the COSE_Sign1 with a padded unprotected header carrying chosen content (a
    /// map holding an attacker public_key, a valid-looking user_data binding and filler). The
    /// header isn't signed and isn't in tbs, so keccak256(tbs) and the revert are unchanged.
    function test_realFixture_b_paddedUnprotectedHeader_sameTbsSameRevert() public {
        _onFork();
        (bytes memory padded, uint256 k) = _padUnprotectedHeader(attestation);
        console.log("unprotected header bytes K:", k);
        assertEq(padded.length, attestation.length - 1 + k);
        assertTrue(keccak256(padded) != keccak256(attestation));

        (bytes memory tbs2, bytes memory sig2) = validator.decodeAttestationTbs(padded);
        assertEq(keccak256(tbs2), keccak256(tbs), "tbs changed");
        assertEq(sig2, sig);
        validator.validateAttestationWithHints(tbs2, sig2, hints);

        _expectBindingMismatch0(padded);
        _expectBindingMismatch0(attestation);
    }

    /// (c) validateAttestationWithHints on a warm cache stays under 16,000,000 gas, measured and
    /// projected to post-Fusaka MODEXP pricing (+300 per MODEXP call, upstream's method). The
    /// registerSigner line is the whole transaction: execution to the BindingMismatch revert,
    /// 21,000 base, and 16 gas per calldata byte (attestation + hints), also projected.
    function test_realFixture_c_validateGas_under16M() public {
        _onFork();
        // Memory copies first, so storage reads of the test's own state aren't metered.
        bytes memory t = tbs;
        bytes memory s = sig;
        bytes memory h = hints;
        bytes memory att = attestation;
        uint256 agent = agentId;
        bytes32 origin = originHash;
        (, uint256 modexpCalls) = collector.collectVerifyProfile(Sha2Ext.sha384(t, 0, t.length), s, leaf.pubKey);

        uint256 g0 = gasleft();
        validator.validateAttestationWithHints(t, s, h);
        uint256 validateGas = g0 - gasleft();
        uint256 validateProjected = validateGas + modexpCalls * MODEXP_FLOOR_DELTA;

        vm.prank(operator);
        g0 = gasleft();
        try registry.registerSigner(agent, origin, att, h) {
            revert("fixture must not register");
        } catch {}
        uint256 registerGas = g0 - gasleft();
        uint256 registerProjected =
            21_000 + registerGas + modexpCalls * MODEXP_FLOOR_DELTA + (att.length + h.length) * 16;

        console.log("validateAttestationWithHints gas (measured)            :", validateGas);
        console.log("validateAttestationWithHints gas (projected post-Fusaka):", validateProjected);
        console.log("registerSigner gas to BindingMismatch (measured)       :", registerGas);
        console.log("registerSigner tx gas (projected post-Fusaka, calldata):", registerProjected);
        console.log("hint bytes / MODEXP calls                              :", hints.length, modexpCalls);
        assertLt(validateGas, GAS_CEILING);
        assertLt(validateProjected, GAS_CEILING);
        assertLt(registerProjected, GAS_CEILING);
    }

    /// Replaces the fixture's empty unprotected header (0xa0) with
    /// {"public_key": 0x04‖X‖Y, "user_data": abi.encode(binding), "pad": 512 bytes}.
    function _padUnprotectedHeader(bytes memory att) internal returns (bytes memory padded, uint256 k) {
        uint256 offset = att[0] == 0xD2 ? 2 : 1;
        CborElement protectedPtr = att.byteStringAt(offset);
        uint256 uStart = protectedPtr.end();
        uint256 uEnd = att.skipValue(uStart);
        assertEq(uEnd - uStart, 1, "fixture unprotected header is not an empty map");
        assertEq(uint8(att[uStart]), 0xa0);

        bytes memory header = _chosenHeader();
        k = header.length;
        padded = abi.encodePacked(_slice(att, 0, uStart), header, _slice(att, uEnd, att.length - uEnd));
    }

    function _chosenHeader() internal returns (bytes memory) {
        Vm.Wallet memory attacker = vm.createWallet("attacker enclave");
        bytes memory binding =
            abi.encode(registry.BINDING_TYPEHASH(), block.chainid, address(registry), agentId, originHash);
        bytes memory filler = new bytes(512);
        for (uint256 i = 0; i < filler.length; i++) {
            filler[i] = bytes1(uint8(i * 7 + 3));
        }
        return abi.encodePacked(
            hex"a3",
            hex"6a",
            "public_key",
            hex"5841",
            bytes1(0x04),
            attacker.publicKeyX,
            attacker.publicKeyY,
            hex"69",
            "user_data",
            hex"58a0",
            binding,
            hex"63",
            "pad",
            hex"590200",
            filler
        );
    }

    function _slice(bytes memory b, uint256 start, uint256 len) internal pure returns (bytes memory) {
        return b.slice(start, len);
    }
}
