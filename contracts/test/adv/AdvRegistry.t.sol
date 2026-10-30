// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {EnclaveRegistry, IEnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {RegistryBase} from "../utils/RegistryBase.sol";

/// Adversary pass on T04/T05. Each test passes on the current registry and kills one mutant that
/// survived the whole suite (adv-bench/t04/own.txt, own2.txt). They pin SPEC §3.4 orderings and
/// boundaries the existing tests leave open.
contract AdvRegistryTest is RegistryBase {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 internal constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;

    address internal signer;

    function setUp() public override {
        super.setUp();
        signer = _register();
    }

    function _proof(uint64 issuedAt) internal view returns (IEnclaveRegistry.ExecutionProof memory p) {
        p.agentId = AGENT;
        p.releaseId = releaseId;
        p.requestId = keccak256("adv request id");
        p.requestHash = keccak256("adv request");
        p.responseHash = keccak256("adv response");
        p.inputsHash = keccak256("adv inputs");
        p.paymentId = keccak256("adv nonce");
        p.issuedAt = issuedAt;
        p.expiresAt = issuedAt + 600;
    }

    function _sign(uint256 key, IEnclaveRegistry.ExecutionProof memory p) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, registry.proofDigest(p));
        return abi.encodePacked(r, s, v);
    }

    function _verify(IEnclaveRegistry.ExecutionProof memory p, bytes memory sig)
        internal
        view
        returns (IEnclaveRegistry.Check)
    {
        return registry.verifyProof(p, sig, originHash);
    }

    /// x^(N-2) mod N through the modexp precompile.
    function _invModN(uint256 x) internal view returns (uint256 out) {
        (bool ok, bytes memory ret) = address(0x05)
            .staticcall(abi.encodePacked(uint256(32), uint256(32), uint256(32), x, SECP256K1_N - 2, SECP256K1_N));
        require(ok, "modexp");
        out = abi.decode(ret, (uint256));
    }

    /// SPEC §2.3 "Verifiers reject high-s": s == secp256k1n/2 is the largest low s (EIP-2), so it must
    /// verify. Built with nonce k = 1 (R = G, even y, v = 27) and the private key solved from
    /// s*k = z + r*d. Kills the `>= HALF_N` mutant.
    function test_adv_verify_sEqualsHalfN_isLowS_OK() public {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        uint256 z = uint256(registry.proofDigest(p)) % SECP256K1_N;
        uint256 r = GX;
        uint256 sk = addmod(HALF_N, SECP256K1_N - z, SECP256K1_N); // s*k - z with k = 1
        uint256 d = mulmod(sk, _invModN(r), SECP256K1_N);
        require(d != 0, "degenerate key");
        Vm.Wallet memory w = vm.createWallet(d, "adv half-n key");
        assertEq(ecrecover(registry.proofDigest(p), 27, bytes32(r), bytes32(HALF_N)), w.addr, "construction");

        _register(_input(w));
        assertEq(
            uint8(_verify(p, abi.encodePacked(bytes32(r), bytes32(HALF_N), uint8(27)))),
            uint8(IEnclaveRegistry.Check.OK)
        );
        // One above is high-s.
        assertEq(
            uint8(_verify(p, abi.encodePacked(bytes32(r), bytes32(HALF_N + 1), uint8(27)))),
            uint8(IEnclaveRegistry.Check.BAD_SIGNATURE)
        );
    }

    /// SPEC §3.4 registerSigner step 9: `emit SignerRegistered(…, ts)` carries the attestation's
    /// timestamp, not the block's. The existing test uses ts == now, so either passes.
    function test_adv_SignerRegistered_carriesAttestationTs() public {
        Vm.Wallet memory w = vm.createWallet("adv ts key");
        AttInput memory a = _input(w);
        a.timestampMs = uint64(block.timestamp - 1000) * 1000 + 999;
        bytes memory att = _attest(a);
        vm.expectEmit(address(registry));
        emit IEnclaveRegistry.SignerRegistered(
            w.addr,
            AGENT,
            releaseId,
            originHash,
            operator,
            uint64(block.timestamp) + 604800,
            keccak256(_tbsOf(a)),
            uint64(block.timestamp - 1000)
        );
        vm.prank(operator);
        registry.registerSigner(AGENT, originHash, att, "");
    }

    /// SPEC §3.4 linkSelfAgent: "caller is the owner (NotOwner)" comes before `SelfDisabled`.
    function test_adv_linkSelfAgent_strangerOnNoSelfDeployment_NotOwner() public {
        EnclaveRegistry noSelf = new EnclaveRegistry(address(identity), address(nitro), address(0), false);
        vm.prank(stranger);
        vm.expectRevert(EnclaveRegistry.NotOwner.selector);
        noSelf.linkSelfAgent(AGENT, 1);
    }

    /// SPEC §3.4 verifyProof step 3 "in order": PROOF_EXPIRED before PROOF_CLOCK_SKEW.
    function test_adv_verify_expiredAndSkewed_PROOF_EXPIRED() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp - 700));
        assertEq(uint8(_verify(p, _sign(enclave.privateKey, p))), uint8(IEnclaveRegistry.Check.PROOF_EXPIRED));
    }

    /// SPEC §3.4 verifyProof step 3 "in order": AGENT_MISMATCH before the releaseId check.
    function test_adv_verify_wrongAgentAndRelease_AGENT_MISMATCH() public view {
        IEnclaveRegistry.ExecutionProof memory p = _proof(uint64(block.timestamp));
        p.agentId = AGENT2;
        p.releaseId = keccak256("other release");
        assertEq(uint8(_verify(p, _sign(enclave.privateKey, p))), uint8(IEnclaveRegistry.Check.AGENT_MISMATCH));
    }

    /// SPEC §3.4 registerSigner steps 6 then 7: a bad binding wins over a bad public key.
    function test_adv_register_badBindingAndBadKey_BindingMismatch() public {
        Vm.Wallet memory w = vm.createWallet("adv binding key");
        AttInput memory a = _input(w);
        a.userData = _binding(registry, AGENT2, originHash);
        a.nullMask = NULL_PUBLIC_KEY;
        _expectRegisterRevert(a, abi.encodeWithSelector(EnclaveRegistry.BindingMismatch.selector, uint8(4)));
    }
}
