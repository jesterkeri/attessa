// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IEnclaveRegistry} from "../src/EnclaveRegistry.sol";

/// SPEC §2.5 header grammars in Solidity, for INV-18. Test-only: the registry never parses headers.
/// This exists to show each grammar reads the same way in Solidity as in TypeScript and Rust, by
/// running every case in vectors/headers.json through it (VectorsTest).
library HeaderGrammar {
    /// Why a header was refused. The names match the `reason` values in vectors/headers.json.
    enum Err {
        None,
        Base64,
        NotJcs,
        UnknownField,
        MissingField,
        FieldGrammar
    }

    struct AttestedProof {
        IEnclaveRegistry.ExecutionProof proof;
        bytes signature;
        address signer;
    }

    /// `<unixSeconds>` is held to a safe JS integer, the bound the TypeScript parser applies.
    uint256 internal constant MAX_UNIX_SECONDS = 2 ** 53 - 1;
    uint256 internal constant SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    uint256 internal constant SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    // ------------------------------------------------------------ scalar grammars

    /// `X-Request-Id` and `X-Attest-Challenge`: `0x[0-9a-f]{64}`.
    function parseBytes32(string memory v) internal pure returns (bool ok, bytes32 out) {
        bytes memory s = bytes(v);
        bytes memory b;
        (ok, b) = _hex(s, 0, s.length, 32);
        if (ok) out = bytes32(b);
    }

    /// `Retry-After`: whole seconds, `0|[1-9][0-9]*`.
    function isRetryAfter(string memory v) internal pure returns (bool) {
        bytes memory s = bytes(v);
        return _digits(s, 0, s.length);
    }

    /// `X-Attest-Payer-Sig`: `<unixSeconds>.<0x65-byte-hex>`.
    function parsePayerSig(string memory v)
        internal
        pure
        returns (bool ok, uint256 unixSeconds, bytes memory signature)
    {
        bytes memory s = bytes(v);
        uint256 dot = s.length;
        for (uint256 i = 0; i < s.length; i++) {
            if (s[i] == ".") {
                dot = i;
                break;
            }
        }
        if (dot == s.length) return (false, 0, "");
        (ok, unixSeconds) = _uint(s, 0, dot, MAX_UNIX_SECONDS);
        if (!ok) return (false, 0, "");
        (ok, signature) = _hex(s, dot + 1, s.length, 65);
        if (!ok) return (false, 0, "");
    }

    /// The ASCII string the payer signs: `attested-exec:results:<requestId lowercase>:<unixSeconds>`.
    function payerSigMessage(string memory requestId, uint256 unixSeconds) internal pure returns (bytes memory) {
        bytes memory id = bytes(requestId);
        bytes memory lower = new bytes(id.length);
        for (uint256 i = 0; i < id.length; i++) {
            bytes1 c = id[i];
            lower[i] = (c >= "A" && c <= "Z") ? bytes1(uint8(c) + 32) : c;
        }
        return abi.encodePacked("attested-exec:results:", lower, ":", _decimal(unixSeconds));
    }

    /// EIP-191 `personal_sign` digest of `payerSigMessage`.
    function payerSigDigest(string memory requestId, uint256 unixSeconds) internal pure returns (bytes32) {
        bytes memory m = payerSigMessage(requestId, unixSeconds);
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", _decimal(m.length), m));
    }

    /// SPEC §2.3 signature rules: 65 bytes r ‖ s ‖ v, v in {27, 28}, high-s rejected. address(0) on refusal.
    function recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v = uint8(sig[64]);
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
        }
        if (v != 27 && v != 28) return address(0);
        if (uint256(r) == 0 || uint256(r) >= SECP256K1_N) return address(0);
        if (uint256(s) == 0 || uint256(s) > SECP256K1_N_HALF) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // --------------------------------------------------------------- base64

    /// RFC 4648 standard alphabet with padding, canonical: non-empty, length a multiple of 4,
    /// `=` only as trailing padding, and the bits under the padding zero.
    function decodeBase64(string memory v) internal pure returns (bool ok, bytes memory out) {
        bytes memory s = bytes(v);
        uint256 n = s.length;
        if (n == 0 || n % 4 != 0) return (false, "");
        uint256 pad = s[n - 1] == "=" ? (s[n - 2] == "=" ? 2 : 1) : 0;
        out = new bytes((n / 4) * 3 - pad);
        uint256 acc;
        uint256 o;
        for (uint256 i = 0; i < n - pad; i++) {
            (bool okC, uint256 x) = _b64(s[i]);
            if (!okC) return (false, "");
            acc = (acc << 6) | x;
            if (i % 4 == 3) {
                out[o++] = bytes1(uint8(acc >> 16));
                out[o++] = bytes1(uint8(acc >> 8));
                out[o++] = bytes1(uint8(acc));
                acc = 0;
            }
        }
        if (pad == 2) {
            if (acc & 0xf != 0) return (false, "");
            out[o] = bytes1(uint8(acc >> 4));
        } else if (pad == 1) {
            if (acc & 0x3 != 0) return (false, "");
            out[o] = bytes1(uint8(acc >> 10));
            out[o + 1] = bytes1(uint8(acc >> 2));
        }
        return (true, out);
    }

    function _b64(bytes1 c) private pure returns (bool, uint256) {
        if (c >= "A" && c <= "Z") return (true, uint8(c) - 65);
        if (c >= "a" && c <= "z") return (true, uint8(c) - 71);
        if (c >= "0" && c <= "9") return (true, uint8(c) + 4);
        if (c == "+") return (true, 62);
        if (c == "/") return (true, 63);
        return (false, 0);
    }

    // ------------------------------------------------------- X-Attested-Proof

    // Field errors. The lowest set bit is the reason, in the order the T03 oracle checks them.
    uint256 private constant TOP_UNKNOWN = 1;
    uint256 private constant TOP_MISSING = 2;
    uint256 private constant PROOF_NOT_OBJECT = 4;
    uint256 private constant PROOF_UNKNOWN = 8;
    uint256 private constant PROOF_MISSING = 16;
    uint256 private constant BAD_FIELD = 32;

    // `seen` bits: proof fields 0-8 in JCS key order, then proof, signature, signer.
    uint256 private constant PROOF_FIELDS = (1 << 9) - 1;
    uint256 private constant SEEN_PROOF = 1 << 9;
    uint256 private constant SEEN_SIGNATURE = 1 << 10;
    uint256 private constant SEEN_SIGNER = 1 << 11;
    uint256 private constant TOP_FIELDS = SEEN_PROOF | SEEN_SIGNATURE | SEEN_SIGNER;

    /// `X-Attested-Proof`: base64 of JCS `{"proof":{...strings...},"signature":"0x...","signer":"0x..."}`.
    ///
    /// Reasons rank as in vectors/headers.json: base64, then not_jcs (the text is not valid UTF-8 JSON
    /// in RFC 8785 canonical form, checked over every value, nested ones included), then a top-level
    /// value that is not an object (field_grammar), then unknown/missing top-level fields, `proof`
    /// not an object, unknown/missing proof fields, and last a field value off its §2.3 grammar.
    function decodeAttestedProof(string memory v) internal pure returns (Err, AttestedProof memory out) {
        (bool ok, bytes memory text) = decodeBase64(v);
        AttestedProof memory empty;
        if (!ok) return (Err.Base64, empty);
        if (!_isJcs(text)) return (Err.NotJcs, empty);
        if (text[0] != "{") return (Err.FieldGrammar, empty);
        uint256 bad = _members(text, 0, false, out);
        if (bad == 0) return (Err.None, out);
        bad &= ~bad + 1;
        if (bad == TOP_UNKNOWN || bad == PROOF_UNKNOWN) return (Err.UnknownField, empty);
        if (bad == TOP_MISSING || bad == PROOF_MISSING) return (Err.MissingField, empty);
        return (Err.FieldGrammar, empty);
    }

    /// Field errors of the canonical object at b[i] (the header, or its `proof` when `proof` is set).
    function _members(bytes memory b, uint256 i, bool proof, AttestedProof memory out)
        private
        pure
        returns (uint256 bad)
    {
        uint256 seen;
        i++;
        while (b[i] != "}") {
            if (b[i] == ",") i++;
            uint256 ks = i + 1;
            i = _end(b, i);
            uint256 ke = i - 1;
            uint256 vs = i + 1;
            i = _end(b, vs);
            if (proof) {
                uint256 f = 0;
                while (f < 9 && !_keyIs(b, ks, ke, _proofKey(f))) {
                    f++;
                }
                if (f == 9) {
                    bad |= PROOF_UNKNOWN;
                } else {
                    seen |= 1 << f;
                    if (!_field(b, vs, i, f, out)) bad |= BAD_FIELD;
                }
            } else if (_keyIs(b, ks, ke, "proof")) {
                seen |= SEEN_PROOF;
                bad |= b[vs] == "{" ? _members(b, vs, true, out) : PROOF_NOT_OBJECT;
            } else if (_keyIs(b, ks, ke, "signature")) {
                seen |= SEEN_SIGNATURE;
                if (!_field(b, vs, i, 9, out)) bad |= BAD_FIELD;
            } else if (_keyIs(b, ks, ke, "signer")) {
                seen |= SEEN_SIGNER;
                if (!_field(b, vs, i, 10, out)) bad |= BAD_FIELD;
            } else {
                bad |= TOP_UNKNOWN;
            }
        }
        if (proof && seen != PROOF_FIELDS) bad |= PROOF_MISSING;
        if (!proof && seen != TOP_FIELDS) bad |= TOP_MISSING;
    }

    /// End of the value at b[i] in text already known to be valid JSON. Iterative, so depth is free.
    function _end(bytes memory b, uint256 i) private pure returns (uint256) {
        uint256 depth;
        bool str;
        for (;; i++) {
            bytes1 c = b[i];
            if (str) {
                if (c == "\\") {
                    i++;
                } else if (c == '"') {
                    str = false;
                    if (depth == 0) return i + 1;
                }
            } else if (c == '"') {
                str = true;
            } else if (c == "{" || c == "[") {
                depth++;
            } else if (c == "}" || c == "]" || c == ",") {
                if (depth == 0) return i;
                if (c != "," && --depth == 0) return i + 1;
            }
        }
    }

    /// Proof fields in JCS key order (0-8), then signature (9) and signer (10).
    function _proofKey(uint256 f) private pure returns (bytes memory) {
        if (f == 0) return "agentId";
        if (f == 1) return "expiresAt";
        if (f == 2) return "inputsHash";
        if (f == 3) return "issuedAt";
        if (f == 4) return "paymentId";
        if (f == 5) return "releaseId";
        if (f == 6) return "requestHash";
        if (f == 7) return "requestId";
        return "responseHash";
    }

    /// Whether the value b[vs:ve] is a string matching field f's grammar (SPEC §2.3 JSON encoding:
    /// integers decimal, bytes lowercase hex, addresses lowercase). An escape never matches one.
    function _field(bytes memory b, uint256 vs, uint256 ve, uint256 f, AttestedProof memory out)
        private
        pure
        returns (bool good)
    {
        if (b[vs] != '"') return false;
        (vs, ve) = (vs + 1, ve - 1);
        IEnclaveRegistry.ExecutionProof memory p = out.proof;
        uint256 n;
        bytes memory h;
        if (f == 0) {
            (good, n) = _uint(b, vs, ve, type(uint256).max);
            p.agentId = n;
        } else if (f == 1 || f == 3) {
            (good, n) = _uint(b, vs, ve, type(uint64).max);
            if (f == 1) p.expiresAt = uint64(n);
            else p.issuedAt = uint64(n);
        } else if (f == 9) {
            (good, h) = _hex(b, vs, ve, 65);
            out.signature = h;
        } else if (f == 10) {
            (good, h) = _hex(b, vs, ve, 20);
            if (good) out.signer = address(bytes20(h));
        } else {
            (good, h) = _hex(b, vs, ve, 32);
            bytes32 w = good ? bytes32(h) : bytes32(0);
            if (f == 2) p.inputsHash = w;
            else if (f == 4) p.paymentId = w;
            else if (f == 5) p.releaseId = w;
            else if (f == 6) p.requestHash = w;
            else if (f == 7) p.requestId = w;
            else p.responseHash = w;
        }
    }

    // ---------------------------------------------------- RFC 8785 (JCS) form

    /// Whether b is valid UTF-8 JSON in RFC 8785 canonical form: what TS core's
    /// `jcs(JSON.parse(text)) === text` accepts. No whitespace; strings escape only `"`, `\` and
    /// control characters, in ECMAScript's form; members sorted by UTF-16 code units with no
    /// duplicates; numbers as ECMAScript Number::toString prints them. Iterative, so nesting depth
    /// costs memory, not EVM stack. A frame is bit 0 object, bit 1 has a previous key, then that
    /// key's start and end.
    function _isJcs(bytes memory b) private pure returns (bool) {
        uint256[] memory st = new uint256[](b.length);
        uint256 d;
        uint256 i;
        bool ok;
        while (true) {
            bytes1 c = _at(b, i);
            if (c == "{" || c == "[") {
                bool obj = c == "{";
                i++;
                if (_at(b, i) == (obj ? bytes1("}") : bytes1("]"))) {
                    i++;
                } else {
                    st[d++] = obj ? 1 : 0;
                    if (obj) {
                        (ok, i) = _key(b, st, d - 1, i);
                        if (!ok) return false;
                    }
                    continue;
                }
            } else {
                (ok, i) = _scalar(b, i);
                if (!ok) return false;
            }
            // A value ended: close containers until one has a next element.
            while (true) {
                if (d == 0) return i == b.length;
                bool inObj = st[d - 1] & 1 == 1;
                c = _at(b, i++);
                if (c == ",") {
                    if (inObj) {
                        (ok, i) = _key(b, st, d - 1, i);
                        if (!ok) return false;
                    }
                    break;
                }
                if (c != (inObj ? bytes1("}") : bytes1("]"))) return false;
                d--;
            }
        }
    }

    function _at(bytes memory b, uint256 i) private pure returns (bytes1) {
        return i < b.length ? b[i] : bytes1(0);
    }

    /// A member key and its colon; the key must sort strictly after the frame's previous one.
    function _key(bytes memory b, uint256[] memory st, uint256 d, uint256 i) private pure returns (bool, uint256) {
        (bool ok, uint256 j) = _str(b, i);
        if (!ok || _at(b, j) != ":") return (false, 0);
        uint256 f = st[d];
        if (f & 2 != 0 && !_keyLess(b, (f >> 8) & type(uint64).max, f >> 72, i + 1, j - 1)) return (false, 0);
        st[d] = 3 | ((i + 1) << 8) | ((j - 1) << 72);
        return (true, j + 1);
    }

    function _scalar(bytes memory b, uint256 i) private pure returns (bool, uint256) {
        bytes1 c = _at(b, i);
        if (c == '"') return _str(b, i);
        if (c == "t") return _word(b, i, "true");
        if (c == "f") return _word(b, i, "false");
        if (c == "n") return _word(b, i, "null");
        return _number(b, i);
    }

    function _word(bytes memory b, uint256 i, bytes memory w) private pure returns (bool, uint256) {
        for (uint256 k = 0; k < w.length; k++) {
            if (_at(b, i + k) != w[k]) return (false, 0);
        }
        return (true, i + w.length);
    }

    /// A canonical string token at b[i]: well-formed UTF-8 (as a fatal TextDecoder reads it), no raw
    /// control character, and only the escapes JSON.stringify writes: \" \\ \b \f \n \r \t, and
    /// \u00xx (lowercase) for the other control characters.
    function _str(bytes memory b, uint256 i) private pure returns (bool, uint256) {
        if (_at(b, i) != '"') return (false, 0);
        i++;
        while (i < b.length) {
            uint8 c = uint8(b[i]);
            if (c == 0x22) return (true, i + 1);
            if (c == 0x5c) {
                bytes1 e = _at(b, i + 1);
                if (e == "u") {
                    if (_at(b, i + 2) != "0" || _at(b, i + 3) != "0") return (false, 0);
                    (bool okH, uint8 hi) = _nibble(_at(b, i + 4));
                    (bool okL, uint8 lo) = _nibble(_at(b, i + 5));
                    uint8 x = hi * 16 + lo;
                    if (!okH || !okL || x >= 0x20 || (x >= 8 && x <= 10) || x == 12 || x == 13) return (false, 0);
                    i += 6;
                } else if (e == '"' || e == "\\" || e == "b" || e == "f" || e == "n" || e == "r" || e == "t") {
                    i += 2;
                } else {
                    return (false, 0);
                }
                continue;
            }
            if (c < 0x20) return (false, 0);
            if (c < 0x80) {
                i++;
                continue;
            }
            // No overlong forms, surrogates, or code points above U+10FFFF.
            uint256 n;
            uint8 lo1 = 0x80;
            uint8 hi1 = 0xbf;
            if (c >= 0xc2 && c <= 0xdf) {
                n = 1;
            } else if (c >= 0xe0 && c <= 0xef) {
                n = 2;
                if (c == 0xe0) lo1 = 0xa0;
                if (c == 0xed) hi1 = 0x9f;
            } else if (c >= 0xf0 && c <= 0xf4) {
                n = 3;
                if (c == 0xf0) lo1 = 0x90;
                if (c == 0xf4) hi1 = 0x8f;
            } else {
                return (false, 0);
            }
            if (i + n >= b.length) return (false, 0);
            for (uint256 k = 1; k <= n; k++) {
                uint8 x = uint8(b[i + k]);
                if (x < (k == 1 ? lo1 : 0x80) || x > (k == 1 ? hi1 : 0xbf)) return (false, 0);
            }
            i += n + 1;
        }
        return (false, 0);
    }

    /// The code point at b[i] inside a canonical string token, and where the next one starts.
    function _cp(bytes memory b, uint256 i) private pure returns (uint256 cp, uint256 next) {
        uint256 c = uint8(b[i]);
        if (c == 0x5c) {
            bytes1 e = b[i + 1];
            if (e == "u") {
                (, uint8 hi) = _nibble(b[i + 4]);
                (, uint8 lo) = _nibble(b[i + 5]);
                return (uint256(hi) * 16 + lo, i + 6);
            }
            if (e == "b") cp = 8;
            else if (e == "t") cp = 9;
            else if (e == "n") cp = 10;
            else if (e == "f") cp = 12;
            else if (e == "r") cp = 13;
            else cp = uint8(e);
            return (cp, i + 2);
        }
        if (c < 0x80) return (c, i + 1);
        uint256 n = c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3;
        cp = c & (0x3f >> n);
        for (uint256 k = 1; k <= n; k++) {
            cp = (cp << 6) | (uint256(uint8(b[i + k])) & 0x3f);
        }
        return (cp, i + n + 1);
    }

    /// Key a sorts before key b in UTF-16 code units (RFC 8785 §3.2.3). Code points U+E000-U+FFFF
    /// sort after the surrogate pairs of U+10000 and up, so they are lifted above them.
    function _keyLess(bytes memory b, uint256 aS, uint256 aE, uint256 bS, uint256 bE) private pure returns (bool) {
        while (aS < aE && bS < bE) {
            (uint256 x, uint256 nextA) = _cp(b, aS);
            (uint256 y, uint256 nextB) = _cp(b, bS);
            if (x != y) {
                if (x >= 0xe000 && x < 0x10000) x += 0x200000;
                if (y >= 0xe000 && y < 0x10000) y += 0x200000;
                return x < y;
            }
            (aS, bS) = (nextA, nextB);
        }
        return aS == aE && bS < bE;
    }

    function _isDigit(bytes1 c) private pure returns (bool) {
        return c >= "0" && c <= "9";
    }

    /// A JSON number at b[i] that is canonical (RFC 8785 §3.2.2.3): exactly ECMAScript
    /// Number::toString of the double it parses to, so finite, not -0, and printed from the
    /// shortest digits that round to that double.
    function _number(bytes memory b, uint256 i) private pure returns (bool, uint256) {
        uint256 start = i;
        bool neg = _at(b, i) == "-";
        if (neg) i++;
        uint256 intS = i;
        while (_isDigit(_at(b, i))) {
            i++;
        }
        uint256 nInt = i - intS;
        if (nInt == 0 || (nInt > 1 && b[intS] == "0")) return (false, 0);
        uint256 fracS = i;
        if (_at(b, i) == ".") {
            fracS = ++i;
            while (_isDigit(_at(b, i))) {
                i++;
            }
            if (i == fracS) return (false, 0);
        }
        uint256 nd = nInt + i - fracS;
        int256 ex;
        if (_at(b, i) == "e" || _at(b, i) == "E") {
            i++;
            bool eNeg = _at(b, i) == "-";
            if (eNeg || _at(b, i) == "+") i++;
            uint256 es = i;
            while (_isDigit(_at(b, i))) {
                // A canonical exponent has at most three digits.
                if (i - es == 3) return (false, 0);
                ex = ex * 10 + int256(uint256(uint8(b[i])) - 48);
                i++;
            }
            if (i == es) return (false, 0);
            if (eNeg) ex = -ex;
        }
        return (_canonical(b, start, i, nInt, fracS, nd, ex), i);
    }

    /// Whether the number b[start:end] (nInt integer digits, fraction digits from fracS, nd digits in
    /// all, exponent ex) is exactly Number::toString of its double.
    function _canonical(bytes memory b, uint256 start, uint256 end, uint256 nInt, uint256 fracS, uint256 nd, int256 ex)
        private
        pure
        returns (bool)
    {
        bool neg = b[start] == "-";
        // Significant digits s (k of them) with value s * 10^e10.
        (uint256 s, uint256 k, uint256 last) = _significand(b, neg ? start + 1 : start, nInt, fracS, nd);
        if (k == 0) return end - start == 1;
        if (k > 17) return false;
        int256 e10 = int256(nInt) - 1 - int256(last) + ex;
        if (e10 + int256(k) < -323 || e10 + int256(k) > 309) return false;
        if (keccak256(_numberText(neg, s, k, e10 + int256(k))) != keccak256(_slice(b, start, end))) return false;
        return _shortest(s, k, e10);
    }

    /// The digits of b[intS:intS+nInt] ++ b[fracS:...] (nd in all) without leading or trailing zeros:
    /// their value s, count k (0 for zero, 18 for more than 17), and the index of the last one.
    function _significand(bytes memory b, uint256 intS, uint256 nInt, uint256 fracS, uint256 nd)
        private
        pure
        returns (uint256 s, uint256 k, uint256 last)
    {
        uint256 first = nd;
        for (uint256 j = 0; j < nd; j++) {
            if (b[j < nInt ? intS + j : fracS + j - nInt] != "0") {
                if (first == nd) first = j;
                last = j;
            }
        }
        if (first == nd) return (0, 0, 0);
        if (last - first >= 17) return (0, 18, last);
        for (uint256 j = first; j <= last; j++) {
            s = s * 10 + uint8(b[j < nInt ? intS + j : fracS + j - nInt]) - 48;
        }
        return (s, last - first + 1, last);
    }

    /// ECMAScript Number::toString layout of (-1)^neg * 0.s * 10^n, s having k digits.
    function _numberText(bool neg, uint256 s, uint256 k, int256 n) private pure returns (bytes memory out) {
        bytes memory d = _decimal(s);
        if (int256(k) <= n && n <= 21) {
            out = abi.encodePacked(d, _zeros(uint256(n) - k));
        } else if (0 < n && n <= 21) {
            out = abi.encodePacked(_slice(d, 0, uint256(n)), ".", _slice(d, uint256(n), k));
        } else if (-6 < n && n <= 0) {
            out = abi.encodePacked("0.", _zeros(uint256(-n)), d);
        } else {
            int256 e = n - 1;
            out = abi.encodePacked(
                d[0],
                k > 1 ? abi.encodePacked(".", _slice(d, 1, k)) : bytes(""),
                e < 0 ? "e-" : "e+",
                _decimal(uint256(e < 0 ? -e : e))
            );
        }
        if (neg) out = abi.encodePacked("-", out);
    }

    function _zeros(uint256 n) private pure returns (bytes memory z) {
        z = new bytes(n);
        for (uint256 k = 0; k < n; k++) {
            z[k] = "0";
        }
    }

    function _slice(bytes memory b, uint256 from, uint256 to) private pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 k = from; k < to; k++) {
            out[k - from] = b[k];
        }
    }

    /// Whether s * 10^e10 (s of k digits, no trailing zero) is the shortest decimal naming its
    /// double, and the closest to it among those as short (ties to even), so Number::toString
    /// prints these digits. The double D = M * 2^E is found exactly with big integers; then no
    /// number on the coarser 10^(e10+1) grid, and no nearer neighbour of s, may round to D.
    function _shortest(uint256 s, uint256 k, int256 e10) private pure returns (bool) {
        // An integer up to 2^53 is its own double, and no shorter digits round to it.
        if (e10 >= 0 && e10 <= 16 && s * 10 ** uint256(e10) <= 2 ** 53) return true;
        // bl = floor(log2(s * 10^e10)): estimate, then correct exactly.
        int256 bl = int256(_bitLen(s)) - 1 + (e10 * 3321928095) / 1e9;
        while (_cmp(_big(s, _pos(e10 - bl), _pos(e10)), _big(1, _pos(bl - e10), _pos(-e10))) < 0) {
            bl--;
        }
        while (_cmp(_big(s, _pos(e10 - bl - 1), _pos(e10)), _big(1, _pos(bl + 1 - e10), _pos(-e10))) >= 0) {
            bl++;
        }
        int256 e = bl - 52 < -1074 ? int256(-1074) : bl - 52;
        // In units of 2^(e-2), x * 10^e10 is x * R / Q.
        (uint256[] memory r, uint256[] memory q) = _units(e10, e);
        uint256[] memory sr = _mul(r, s);
        uint256 f; // floor(s * 10^e10 / 2^(e-2)), below 2^55
        for (uint256 bit = 1 << 54; bit != 0; bit >>= 1) {
            if (_cmp(_mul(q, f | bit), sr) <= 0) f |= bit;
        }
        uint256 m = f >> 2;
        if (f & 3 == 3 || (f & 3 == 2 && (m & 1 == 1 || _cmp(_mul(q, f), sr) != 0))) m++;
        if (m == 1 << 53) {
            (m, e) = (1 << 52, e + 1);
            (r, q) = _units(e10, e);
        }
        if (m == 0 || e > 971) return false; // rounds to zero, or to Infinity
        // D = 4m; what rounds to it lies in (lo, hi), ends included when m is even.
        uint256[4] memory w = [4 * m - (m == 1 << 52 && e > -1074 ? 1 : 2), 4 * m + 2, m & 1, m];
        return _shortestAt(r, q, s, k, w);
    }

    /// The checks of _shortest once D is known: w = [lo, hi, m odd, m] in units of 2^(e-2).
    function _shortestAt(uint256[] memory r, uint256[] memory q, uint256 s, uint256 k, uint256[4] memory w)
        private
        pure
        returns (bool)
    {
        uint256 m = w[3];
        if (k > 1 && (_in(r, q, (s / 10) * 10, 1, w) || _in(r, q, (s / 10 + 1) * 10, 1, w))) return false;
        // The neighbour below 1 is 9 on the next finer grid.
        uint256 num = s == 1 ? 9 : s - 1;
        uint256 den = s == 1 ? 10 : 1;
        if (_in(r, q, num, den, w)) {
            int256 c = _cmp(_mul(q, 8 * m * den), _mul(r, num + s * den));
            if (c < 0 || (c == 0 && s & 1 == 1 && num & 1 == 0)) return false;
        }
        if (_in(r, q, s + 1, 1, w)) {
            int256 c = _cmp(_mul(q, 8 * m), _mul(r, 2 * s + 1));
            if (c > 0 || (c == 0 && s & 1 == 1)) return false;
        }
        return true;
    }

    /// Whether (num / den) * 10^e10 rounds to D, given w = [lo, hi, m odd, m] in units of 2^(e-2).
    function _in(uint256[] memory r, uint256[] memory q, uint256 num, uint256 den, uint256[4] memory w)
        private
        pure
        returns (bool)
    {
        uint256[] memory x = _mul(r, num);
        int256 a = _cmp(x, _mul(q, w[0] * den));
        int256 z = _cmp(x, _mul(q, w[1] * den));
        return w[2] == 0 ? (a >= 0 && z <= 0) : (a > 0 && z < 0);
    }

    function _units(int256 e10, int256 e) private pure returns (uint256[] memory r, uint256[] memory q) {
        r = _big(1, _pos(e10 - e + 2), _pos(e10));
        q = _big(1, _pos(e - 2 - e10), _pos(-e10));
    }

    function _pos(int256 x) private pure returns (uint256) {
        return x > 0 ? uint256(x) : 0;
    }

    function _bitLen(uint256 x) private pure returns (uint256 n) {
        for (; x != 0; x >>= 1) {
            n++;
        }
    }

    // Big integers: LIMBS little-endian 128-bit limbs. 1152 bits covers every comparison above,
    // since |e10| <= 340 and the double's exponent is within 2^-1076..2^971.
    uint256 private constant LIMBS = 9;

    /// x * 2^p2 * 5^p5, for x below 2^128.
    function _big(uint256 x, uint256 p2, uint256 p5) private pure returns (uint256[] memory a) {
        a = new uint256[](LIMBS);
        a[0] = x;
        for (; p5 >= 27; p5 -= 27) {
            _mulIn(a, 5 ** 27);
        }
        _mulIn(a, 5 ** p5);
        for (; p2 >= 64; p2 -= 64) {
            _mulIn(a, 1 << 64);
        }
        _mulIn(a, 1 << p2);
    }

    function _mul(uint256[] memory a, uint256 m) private pure returns (uint256[] memory c) {
        c = new uint256[](LIMBS);
        for (uint256 j = 0; j < LIMBS; j++) {
            c[j] = a[j];
        }
        _mulIn(c, m);
    }

    /// a *= m, for m up to 2^64.
    function _mulIn(uint256[] memory a, uint256 m) private pure {
        uint256 carry;
        for (uint256 j = 0; j < LIMBS; j++) {
            uint256 t = a[j] * m + carry;
            a[j] = t & type(uint128).max;
            carry = t >> 128;
        }
        require(carry == 0, "HeaderGrammar: big integer overflow");
    }

    function _cmp(uint256[] memory a, uint256[] memory b) private pure returns (int256) {
        for (uint256 j = LIMBS; j > 0; j--) {
            if (a[j - 1] != b[j - 1]) return a[j - 1] < b[j - 1] ? int256(-1) : int256(1);
        }
        return 0;
    }

    // -------------------------------------------------------------- helpers

    function _keyIs(bytes memory b, uint256 s, uint256 e, bytes memory key) private pure returns (bool) {
        if (e - s != key.length) return false;
        for (uint256 k = 0; k < key.length; k++) {
            if (b[s + k] != key[k]) return false;
        }
        return true;
    }

    function _nibble(bytes1 c) private pure returns (bool, uint8) {
        if (c >= "0" && c <= "9") return (true, uint8(c) - 48);
        if (c >= "a" && c <= "f") return (true, uint8(c) - 87);
        return (false, 0);
    }

    /// s[from:to] is `0x` followed by exactly 2n lowercase hex digits.
    function _hex(bytes memory s, uint256 from, uint256 to, uint256 n) private pure returns (bool, bytes memory out) {
        if (to - from != 2 + 2 * n || s[from] != "0" || s[from + 1] != "x") return (false, "");
        out = new bytes(n);
        for (uint256 k = 0; k < n; k++) {
            (bool okH, uint8 hi) = _nibble(s[from + 2 + 2 * k]);
            (bool okL, uint8 lo) = _nibble(s[from + 3 + 2 * k]);
            if (!okH || !okL) return (false, "");
            out[k] = bytes1(hi * 16 + lo);
        }
        return (true, out);
    }

    /// s[from:to] is `0|[1-9][0-9]*`.
    function _digits(bytes memory s, uint256 from, uint256 to) private pure returns (bool) {
        if (to <= from) return false;
        if (s[from] == "0" && to - from > 1) return false;
        for (uint256 k = from; k < to; k++) {
            if (s[k] < "0" || s[k] > "9") return false;
        }
        return true;
    }

    /// s[from:to] is `0|[1-9][0-9]*` with a value at most `max`.
    function _uint(bytes memory s, uint256 from, uint256 to, uint256 max) private pure returns (bool, uint256 v) {
        if (!_digits(s, from, to)) return (false, 0);
        for (uint256 k = from; k < to; k++) {
            uint256 d = uint8(s[k]) - 48;
            if (v > (max - d) / 10) return (false, 0);
            v = v * 10 + d;
        }
        return (true, v);
    }

    function _decimal(uint256 v) private pure returns (bytes memory out) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) {
            len++;
        }
        out = new bytes(len);
        for (; v != 0; v /= 10) {
            out[--len] = bytes1(uint8(48 + (v % 10)));
        }
    }
}
