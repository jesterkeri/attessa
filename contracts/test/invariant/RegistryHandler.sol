// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {EnclaveRegistry, IEnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {MockNitroValidator, MockIdentityRegistry, MockSelfRegistry} from "../mocks/Mocks.sol";
import {AttestationKit} from "../utils/AttestationKit.sol";

/// Drives EnclaveRegistry as three actors (owner, operator, stranger) and keeps a reference
/// model of SPEC §3.4 built only from its own ghost state. Every call's outcome (success, or the
/// exact revert data) is compared with the model; disagreements are counted in `mismatches`.
contract RegistryHandler is CommonBase, StdCheats, StdUtils, AttestationKit {
    uint8 internal constant NONE = 0;
    uint8 internal constant ACTIVE = 1; // ReleaseStatus.Approved / EndpointStatus.Active / SignerStatus.Active
    uint8 internal constant R_DEPRECATED = 2;
    uint8 internal constant R_REVOKED = 3;
    uint8 internal constant E_RETIRED = 2;
    uint8 internal constant S_REVOKED = 2;

    uint8 internal constant N_RELEASES = 3; // release index 3 is a debug build (PCR0 all zero)
    uint8 internal constant DEBUG_RELEASE = 3;
    uint8 internal constant N_ORIGINS = 2;
    uint8 internal constant N_KEYS = 4;
    uint256 internal constant SELF_OWNER_ID = 7;
    uint256 internal constant SELF_STRANGER_ID = 8;

    EnclaveRegistry public immutable registry;
    MockNitroValidator public immutable nitro;
    MockIdentityRegistry public immutable identity;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public stranger = makeAddr("stranger");
    address[3] internal actors;
    address[2] internal payTos;
    uint256[3] internal agents = [uint256(1), 2, 3];
    string[2] internal origins = ["https://a.example", "https://b.example"];
    bytes32[2] public originHashes;
    bytes32 public constant UNKNOWN_ORIGIN = keccak256("https://c.example");
    bytes[3][4] internal pcrSets;
    bytes32[4] public releaseIds;
    Vm.Wallet[4] internal keys;

    // ---- reference model (ghost state, updated only from what the model says succeeded)
    struct GEndpoint {
        uint256 agentId;
        address payTo;
        address operator;
        uint8 status;
    }

    struct GSigner {
        uint256 agentId;
        uint8 rIdx;
        uint8 oIdx;
        address operator;
        uint64 registeredAt;
        uint64 expiresAt;
        uint8 status;
        bool everRevoked;
    }

    mapping(uint256 => mapping(uint8 => uint8)) public gRelease;
    mapping(uint256 => mapping(uint8 => bool)) public gReleaseEverRevoked;
    GEndpoint[2] internal gEndpoints;
    GSigner[4] internal gSigners;
    mapping(uint256 => uint256) public gSelfLink;

    // ---- property counters (all must stay zero)
    uint256 public mismatches; // outcome or revert data differed from the model
    string public lastMismatch;
    uint256 public unauthorized; // INV-5: a state change by someone other than ownerOf / endpoint operator
    uint256 public inv1Violations; // signer != address(keccak(public_key[1:])) on success
    uint256 public inv2Violations; // release not Approved for the agent at registration, or wrong releaseId
    uint256 public inv3Violations; // zero PCR or ts outside the window on success
    uint256 public inv4Violations; // user_data not the exact binding on success
    uint256 public inv24Violations; // renew changed something other than expiresAt/attestationHash

    // ---- coverage
    uint256 public registered;
    uint256 public renewed;
    uint256 public rotations;

    constructor(EnclaveRegistry registry_, MockNitroValidator nitro_, MockIdentityRegistry identity_) {
        registry = registry_;
        nitro = nitro_;
        identity = identity_;
        actors = [owner, operator, stranger];
        payTos = [makeAddr("payToA"), makeAddr("payToB")];
        for (uint256 i = 0; i < N_ORIGINS; i++) {
            originHashes[i] = keccak256(bytes(origins[i]));
        }
        bytes memory a = _fill(0x11, 48);
        bytes memory b = _fill(0x22, 48);
        pcrSets[0] = [a, b, _fill(0x33, 48)];
        pcrSets[1] = [a, b, _fill(0x44, 48)];
        pcrSets[2] = [a, b, _fill(0x55, 48)];
        pcrSets[3] = [new bytes(48), b, _fill(0x33, 48)];
        for (uint256 i = 0; i < 4; i++) {
            releaseIds[i] = keccak256(abi.encodePacked(pcrSets[i][0], pcrSets[i][1], pcrSets[i][2]));
        }
        for (uint256 i = 0; i < N_KEYS; i++) {
            keys[i] = vm.createWallet(string(abi.encodePacked("enclave key ", vm.toString(i))));
        }
    }

    // ================================================================ actions

    function approveRelease(uint256 actorSeed, uint256 agentSeed, uint256 rSeed) external {
        address actor = actors[actorSeed % 3];
        uint256 agent = agents[agentSeed % 3];
        uint8 r = uint8(rSeed % N_RELEASES);
        bytes memory expected;
        if (actor != _ownerOf(agent)) expected = _e(EnclaveRegistry.NotOwner.selector);
        else if (gRelease[agent][r] != NONE) expected = _e(EnclaveRegistry.ReleaseExists.selector);

        vm.prank(actor);
        try registry.approveRelease(agent, pcrSets[r][0], pcrSets[r][1], pcrSets[r][2], "src") {
            _outcome(true, "", expected, "approveRelease");
            _ownerOnly(actor, agent);
            if (expected.length == 0) gRelease[agent][r] = ACTIVE;
        } catch (bytes memory err) {
            _outcome(false, err, expected, "approveRelease");
        }
    }

    function setReleaseStatus(uint256 actorSeed, uint256 agentSeed, uint256 rSeed, uint256 toSeed) external {
        address actor = actors[actorSeed % 3];
        uint256 agent = agents[agentSeed % 3];
        uint8 r = uint8(rSeed % N_RELEASES);
        uint8 to = uint8(toSeed % 4);
        uint8 from = gRelease[agent][r];
        bool allowed = (from == ACTIVE && (to == R_DEPRECATED || to == R_REVOKED))
            || (from == R_DEPRECATED && (to == ACTIVE || to == R_REVOKED));
        bytes memory expected;
        if (actor != _ownerOf(agent)) expected = _e(EnclaveRegistry.NotOwner.selector);
        else if (!allowed) expected = _e(EnclaveRegistry.InvalidTransition.selector);

        vm.prank(actor);
        try registry.setReleaseStatus(agent, releaseIds[r], IEnclaveRegistry.ReleaseStatus(to)) {
            _outcome(true, "", expected, "setReleaseStatus");
            _ownerOnly(actor, agent);
            if (expected.length == 0) {
                gRelease[agent][r] = to;
                if (to == R_REVOKED) gReleaseEverRevoked[agent][r] = true;
            }
        } catch (bytes memory err) {
            _outcome(false, err, expected, "setReleaseStatus");
        }
    }

    function addEndpoint(uint256 actorSeed, uint256 agentSeed, uint256 oSeed, uint256 opSeed, uint256 payToSeed)
        external
    {
        address actor = actors[actorSeed % 3];
        uint256 agent = agents[agentSeed % 3];
        uint8 o = uint8(oSeed % N_ORIGINS);
        address op = opSeed % 2 == 0 ? operator : owner;
        address pay = payTos[payToSeed % 2];
        GEndpoint storage g = gEndpoints[o];
        bytes memory expected;
        if (actor != _ownerOf(agent)) expected = _e(EnclaveRegistry.NotOwner.selector);
        else if (g.status == ACTIVE) expected = _e(EnclaveRegistry.OriginTaken.selector);

        vm.prank(actor);
        try registry.addEndpoint(agent, origins[o], pay, op) {
            _outcome(true, "", expected, "addEndpoint");
            _ownerOnly(actor, agent);
            if (expected.length == 0) {
                if (g.status == E_RETIRED && g.operator != op) rotations++;
                gEndpoints[o] = GEndpoint(agent, pay, op, ACTIVE);
            }
        } catch (bytes memory err) {
            _outcome(false, err, expected, "addEndpoint");
        }
    }

    function retireEndpoint(uint256 actorSeed, uint256 oSeed) external {
        address actor = actors[actorSeed % 3];
        uint8 o = uint8(oSeed % N_ORIGINS);
        GEndpoint storage g = gEndpoints[o];
        bytes memory expected;
        // A never-added origin has agentId 0, whose ownerOf reverts.
        if (g.status == NONE || actor != _ownerOf(g.agentId)) expected = _e(EnclaveRegistry.NotOwner.selector);
        else if (g.status != ACTIVE) expected = _e(EnclaveRegistry.EndpointNotActive.selector);

        uint256 agentBefore = registry.endpoints(originHashes[o]).agentId;
        vm.prank(actor);
        try registry.retireEndpoint(originHashes[o]) {
            _outcome(true, "", expected, "retireEndpoint");
            _ownerOnly(actor, agentBefore);
            if (expected.length == 0) g.status = E_RETIRED;
        } catch (bytes memory err) {
            _outcome(false, err, expected, "retireEndpoint");
        }
    }

    function revokeSigner(uint256 actorSeed, uint256 kSeed) external {
        address actor = actors[actorSeed % 3];
        uint8 k = uint8(kSeed % N_KEYS);
        GSigner storage g = gSigners[k];
        bytes memory expected;
        if (g.status == NONE || actor != _ownerOf(g.agentId)) expected = _e(EnclaveRegistry.NotOwner.selector);
        else if (g.status != ACTIVE) expected = _e(EnclaveRegistry.SignerNotActive.selector);

        uint256 agentBefore = registry.signers(keys[k].addr).agentId;
        vm.prank(actor);
        try registry.revokeSigner(keys[k].addr) {
            _outcome(true, "", expected, "revokeSigner");
            _ownerOnly(actor, agentBefore);
            if (expected.length == 0) {
                g.status = S_REVOKED;
                g.everRevoked = true;
            }
        } catch (bytes memory err) {
            _outcome(false, err, expected, "revokeSigner");
        }
    }

    function linkSelfAgent(uint256 actorSeed, uint256 agentSeed, uint256 selfSeed) external {
        address actor = actors[actorSeed % 3];
        uint256 agent = agents[agentSeed % 3];
        uint256 selfId = selfSeed % 2 == 0 ? SELF_OWNER_ID : SELF_STRANGER_ID;
        address selfOwner = selfId == SELF_OWNER_ID ? owner : stranger;
        bytes memory expected;
        if (actor != _ownerOf(agent)) expected = _e(EnclaveRegistry.NotOwner.selector);
        else if (actor != selfOwner) expected = _e(EnclaveRegistry.SelfLinkInvalid.selector);

        vm.prank(actor);
        try registry.linkSelfAgent(agent, selfId) {
            _outcome(true, "", expected, "linkSelfAgent");
            _ownerOnly(actor, agent);
            if (expected.length == 0) gSelfLink[agent] = selfId;
        } catch (bytes memory err) {
            _outcome(false, err, expected, "linkSelfAgent");
        }
    }

    /// Attestation knobs shared by register and renew.
    struct Knobs {
        uint8 r; // release index (3 = debug)
        int256 tsOffset; // seconds from now
        uint256 ms; // sub-second part
        uint8 fault; // 0 none, 1-5 corrupt user_data word, 6 null public_key
    }

    function _knobs(uint256 rSeed, uint256 tsSeed, uint256 faultSeed) internal pure returns (Knobs memory n) {
        n.r = uint8(rSeed % (N_RELEASES + 1));
        n.tsOffset = int256(tsSeed % 2121) - 2000; // [-2000, 120]
        n.ms = (tsSeed / 2121) % 1000;
        uint256 f = faultSeed % 16;
        n.fault = f >= 1 && f <= 6 ? uint8(f) : 0;
    }

    /// Per-call context for registerSigner (kept in memory to stay under the stack limit).
    struct Reg {
        address actor;
        uint256 agent;
        uint8 o;
        uint8 k;
        bool releaseApprovedNow; // read from the registry before the call
        bool endpointActiveNow;
        address operatorNow;
    }

    function registerSigner(
        uint256 actorSeed,
        uint256 agentSeed,
        uint256 oSeed,
        uint256 kSeed,
        uint256 rSeed,
        uint256 tsSeed,
        uint256 faultSeed
    ) external {
        Reg memory c;
        c.o = uint8(oSeed % N_ORIGINS);
        // A quarter of picks go to the endpoint's own operator and agent, so success paths are reached.
        c.actor = actorSeed % 4 == 3 ? gEndpoints[c.o].operator : actors[actorSeed % 3];
        c.agent = agentSeed % 4 == 3 ? gEndpoints[c.o].agentId : agents[agentSeed % 3];
        c.k = uint8(kSeed % N_KEYS);
        Knobs memory n = _knobs(rSeed, tsSeed, faultSeed);
        AttInput memory a = _input(n, c.k, c.agent, originHashes[c.o]);
        bytes memory att = _attest(nitro, a);
        bytes memory expected = _registerExpected(c, n);

        c.releaseApprovedNow =
            registry.releases(c.agent, releaseIds[n.r]).status == IEnclaveRegistry.ReleaseStatus.Approved;
        IEnclaveRegistry.Endpoint memory eNow = registry.endpoints(originHashes[c.o]);
        c.endpointActiveNow = eNow.status == IEnclaveRegistry.EndpointStatus.Active;
        c.operatorNow = eNow.operator;

        vm.prank(c.actor);
        try registry.registerSigner(c.agent, originHashes[c.o], att, "") returns (address signer) {
            _outcome(true, "", expected, "registerSigner");
            _afterRegister(c, n, a, signer);
            if (expected.length == 0) {
                gSigners[c.k] = GSigner(
                    c.agent,
                    n.r,
                    c.o,
                    gEndpoints[c.o].operator,
                    uint64(block.timestamp),
                    uint64(block.timestamp) + 604800,
                    ACTIVE,
                    false
                );
                registered++;
            }
        } catch (bytes memory err) {
            _outcome(false, err, expected, "registerSigner");
        }
    }

    function _registerExpected(Reg memory c, Knobs memory n) internal view returns (bytes memory expected) {
        GEndpoint storage e = gEndpoints[c.o];
        if (e.status != ACTIVE) return _e(EnclaveRegistry.EndpointInactive.selector);
        if (e.agentId != c.agent) return _e(EnclaveRegistry.EndpointMismatch.selector);
        if (c.actor != e.operator) return _e(EnclaveRegistry.NotOperator.selector);
        expected = _attestationError(n, c.agent);
        if (expected.length == 0 && gSigners[c.k].status != NONE) expected = _e(EnclaveRegistry.SignerExists.selector);
    }

    /// Direct property checks on a successful registration (independent of the model).
    function _afterRegister(Reg memory c, Knobs memory n, AttInput memory a, address signer) internal {
        if (c.actor != c.operatorNow || !c.endpointActiveNow) unauthorized++;
        if (signer != address(uint160(uint256(keccak256(_slice64(a.publicKey)))))) inv1Violations++;
        IEnclaveRegistry.Signer memory s = registry.signers(signer);
        if (!c.releaseApprovedNow || s.releaseId != releaseIds[n.r] || n.r == DEBUG_RELEASE) inv2Violations++;
        if (!_inWindow(n) || n.r == DEBUG_RELEASE) inv3Violations++;
        if (keccak256(a.userData) != keccak256(_binding(registry, c.agent, originHashes[c.o]))) inv4Violations++;
    }

    function renewSigner(
        uint256 actorSeed,
        uint256 kSeed,
        uint256 otherKeySeed,
        uint256 rSeed,
        uint256 tsSeed,
        uint256 faultSeed
    ) external {
        uint8 k = uint8(kSeed % N_KEYS);
        address actor = actorSeed % 4 == 3 ? gEndpoints[gSigners[k].oIdx].operator : actors[actorSeed % 3];
        // Mostly the same key and release; sometimes another one.
        uint8 kAtt = otherKeySeed % 4 == 0 ? uint8((k + 1) % N_KEYS) : k;
        GSigner storage g = gSigners[k];
        Knobs memory n = _knobs(rSeed, tsSeed, faultSeed);
        if (rSeed % 4 != 0) n.r = g.rIdx;
        AttInput memory a = _input(n, kAtt, g.agentId, originHashes[g.oIdx]);
        bytes memory att = _attest(nitro, a);

        bytes memory expected;
        GEndpoint storage e = gEndpoints[g.oIdx];
        if (g.status != ACTIVE || block.timestamp >= g.expiresAt) {
            expected = _e(EnclaveRegistry.SignerNotActive.selector);
        } else if (e.status != ACTIVE) {
            expected = _e(EnclaveRegistry.EndpointInactive.selector);
        } else if (e.agentId != g.agentId) {
            expected = _e(EnclaveRegistry.EndpointMismatch.selector);
        } else if (actor != e.operator || e.operator != g.operator) {
            expected = _e(EnclaveRegistry.NotOperator.selector);
        } else {
            expected = _attestationError(n, g.agentId);
            if (expected.length == 0 && kAtt != k) expected = _e(EnclaveRegistry.SignerMismatch.selector);
            if (expected.length == 0 && n.r != g.rIdx) expected = _e(EnclaveRegistry.ReleaseMismatch.selector);
        }

        IEnclaveRegistry.Signer memory before = registry.signers(keys[k].addr);
        IEnclaveRegistry.Endpoint memory eNow = registry.endpoints(before.originHash);
        vm.prank(actor);
        try registry.renewSigner(keys[k].addr, att, "") {
            _outcome(true, "", expected, "renewSigner");
            IEnclaveRegistry.Signer memory s = registry.signers(keys[k].addr);
            if (
                before.status != IEnclaveRegistry.SignerStatus.Active || block.timestamp >= before.expiresAt
                    || actor != eNow.operator || eNow.operator != before.operator || kAtt != k || !_inWindow(n)
                    || releaseIds[n.r] != before.releaseId
            ) inv24Violations++;
            if (
                s.agentId != before.agentId || s.releaseId != before.releaseId || s.originHash != before.originHash
                    || s.operator != before.operator || s.registeredAt != before.registeredAt
                    || s.status != before.status || s.expiresAt != block.timestamp + 604800
                    || s.attestationHash != keccak256(_tbsOf(a))
            ) inv24Violations++;
            if (keccak256(a.userData) != keccak256(_binding(registry, before.agentId, before.originHash))) {
                inv4Violations++;
            }
            if (expected.length == 0) {
                g.expiresAt = uint64(block.timestamp) + 604800;
                renewed++;
            }
        } catch (bytes memory err) {
            _outcome(false, err, expected, "renewSigner");
        }
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 3 days));
    }

    // ========================================================== reference model

    /// SPEC §3.4 checkSigner, from ghost state only.
    function modelCheck(uint8 k, bytes32 originHash) public view returns (IEnclaveRegistry.Check) {
        GSigner storage s = gSigners[k];
        if (s.status == NONE) return IEnclaveRegistry.Check.UNKNOWN_SIGNER;
        if (s.status == S_REVOKED) return IEnclaveRegistry.Check.SIGNER_REVOKED;
        if (block.timestamp >= s.expiresAt) return IEnclaveRegistry.Check.SIGNER_EXPIRED;
        if (originHashes[s.oIdx] != originHash) return IEnclaveRegistry.Check.ENDPOINT_MISMATCH;
        GEndpoint storage e = gEndpoints[s.oIdx];
        if (e.status != ACTIVE) return IEnclaveRegistry.Check.ENDPOINT_INACTIVE;
        if (e.agentId != s.agentId) return IEnclaveRegistry.Check.AGENT_MISMATCH;
        if (e.operator != s.operator) return IEnclaveRegistry.Check.OPERATOR_MISMATCH;
        if (gRelease[s.agentId][s.rIdx] != ACTIVE) return IEnclaveRegistry.Check.RELEASE_NOT_APPROVED;
        return IEnclaveRegistry.Check.OK;
    }

    /// registerSigner steps 3-7 for the handler's attestation knobs (the mock validator accepts all).
    function _attestationError(Knobs memory n, uint256 agent) internal view returns (bytes memory) {
        if (n.tsOffset > 60) return _e(EnclaveRegistry.AttestationFromFuture.selector);
        if (n.tsOffset < -1800) return _e(EnclaveRegistry.AttestationStale.selector);
        if (n.r == DEBUG_RELEASE) return _e(EnclaveRegistry.DebugPcrs.selector);
        if (gRelease[agent][n.r] != ACTIVE) return _e(EnclaveRegistry.ReleaseNotApproved.selector);
        if (n.fault >= 1 && n.fault <= 5) {
            return abi.encodeWithSelector(EnclaveRegistry.BindingMismatch.selector, n.fault);
        }
        if (n.fault == 6) return _e(EnclaveRegistry.InvalidPublicKey.selector);
        return "";
    }

    // ================================================================ views

    function keyAddr(uint8 k) external view returns (address) {
        return keys[k].addr;
    }

    function gSigner(uint8 k) external view returns (GSigner memory) {
        return gSigners[k];
    }

    function gEndpoint(uint8 o) external view returns (GEndpoint memory) {
        return gEndpoints[o];
    }

    // =============================================================== helpers

    function _input(Knobs memory n, uint8 k, uint256 agent, bytes32 originHash)
        internal
        view
        returns (AttInput memory a)
    {
        a.timestampMs = uint64(uint256(int256(block.timestamp) + n.tsOffset) * 1000 + n.ms);
        a.pcr0 = pcrSets[n.r][0];
        a.pcr1 = pcrSets[n.r][1];
        a.pcr2 = pcrSets[n.r][2];
        a.userData = _binding(registry, agent, originHash);
        if (n.fault >= 1 && n.fault <= 5) {
            uint256 at = uint256(n.fault - 1) * 32 + 31;
            a.userData[at] = a.userData[at] ^ 0x01;
        }
        a.publicKey = _publicKey(keys[k].publicKeyX, keys[k].publicKeyY);
        if (n.fault == 6) a.nullMask = NULL_PUBLIC_KEY;
    }

    function _inWindow(Knobs memory n) internal pure returns (bool) {
        return n.tsOffset >= -1800 && n.tsOffset <= 60;
    }

    function _slice64(bytes memory pk) internal pure returns (bytes memory out) {
        out = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            out[i] = pk[i + 1];
        }
    }

    function _ownerOf(uint256 agent) internal view returns (address) {
        if (agent == 1 || agent == 2) return owner;
        if (agent == 3) return stranger;
        return address(0);
    }

    /// INV-5, read from the identity registry at call time (independent of the model).
    function _ownerOnly(address actor, uint256 agent) internal {
        try identity.ownerOf(agent) returns (address o) {
            if (o != actor) unauthorized++;
        } catch {
            unauthorized++;
        }
    }

    function _e(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    function _outcome(bool ok, bytes memory err, bytes memory expected, string memory label) internal {
        bool expectOk = expected.length == 0;
        if (ok != expectOk || (!ok && keccak256(err) != keccak256(expected))) {
            mismatches++;
            lastMismatch = label;
        }
    }
}
