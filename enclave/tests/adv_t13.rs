//! Adversarial tests for T13 (SPEC §4.2, §4.3). Each test names the rule it holds the enclave to.

mod common;

use attessa_enclave::enclave::Enclave;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use common::*;
use serde_json::json;

/// SPEC §4.3: the request body has a strict schema, a JSON object
/// `{"chainId","payTo","asset","amount"}`. A JSON array of the four values is not that schema
/// and must be `bad_request`, never a signed proof.
#[test]
fn adv_request_body_as_json_array_is_bad_request() {
    let (mut e, _) = configured(key_one());
    let array_body = format!(r#"["11142220","{PAY_TO}","{SEPOLIA_USDC}","5"]"#).into_bytes();
    let reply = call(
        &mut e,
        &evaluate_msg(&array_body, inputs(PAY_TO, "0x", "3")),
    );
    assert_eq!(
        reply,
        json!({"error": "bad_request"}),
        "enclave replied {reply}"
    );
}

/// SPEC §4.3: inputs are the object `{"block":{…},"payTo":{…},"source":…}` and the enclave
/// checks "the field grammar, else `bad_inputs`". Positional arrays are not that grammar.
#[test]
fn adv_inputs_as_json_arrays_are_bad_inputs() {
    let (mut e, _) = configured(key_one());
    let b = body("11142220", PAY_TO, SEPOLIA_USDC, "5");
    let array_inputs = json!([
        ["123", format!("0x{}", "12".repeat(32)), "1761782400"],
        [PAY_TO, "0x", "3", "5"],
        "forno"
    ]);
    let reply = call(&mut e, &evaluate_msg(&b, array_inputs));
    assert_eq!(
        reply,
        json!({"error": "bad_inputs"}),
        "enclave replied {reply}"
    );
}

/// SPEC §4.2: requests are JSON objects such as `{"type":"attest"}`. `["attest"]` is not one.
#[test]
fn adv_attest_frame_as_json_array_is_bad_frame() {
    let (mut e, _) = configured(key_one());
    let reply = call_raw(&mut e, br#"["attest"]"#);
    assert_eq!(
        reply,
        json!({"error": "bad_frame"}),
        "enclave replied {reply}"
    );
}

/// Attacks that the enclave stopped (kept as regression guards).
#[test]
fn adv_probes_that_hold() {
    use attessa_enclave::enclave::sign;
    use attessa_enclave::formats::{keccak, to_hex};
    use k256::ecdsa::SigningKey;

    // Low-s and correct recovery id over 3,000 digests and 3 keys.
    for k in [[0x5au8; 32], [0x01; 32], [0x7f; 32]] {
        let key = SigningKey::from_slice(&k).unwrap();
        let want = {
            let p = key.verifying_key().to_sec1_point(false);
            to_hex(&keccak(&p.as_bytes()[1..])[12..])
        };
        for i in 0..1000u32 {
            let d = keccak(&i.to_be_bytes());
            assert_eq!(recover(&d, &to_hex(&sign(&key, &d))), want);
        }
    }

    let (mut e, attested) = configured(key_one());
    let bad = |e: &mut Enclave<FakeNsm>, f: &[u8]| call_raw(e, f);
    // Duplicate type keys, non-UTF-8, lone surrogate, number for string, trailing garbage.
    for f in [
        &br#"{"type":"attest","type":"attest"}"#[..],
        b"{\"type\":\"att\xffest\"}",
        br#"{"type":"liveness","challenge":"\ud800"}"#,
        br#"{"type":"liveness","challenge":1}"#,
        br#"{"type":"attest"}x"#,
        br#"{"type":"attest"}{"type":"attest"}"#,
        br#"{"type":"attest","x":"1"}"#,
        br#"{"type":"Attest"}"#,
        br#"null"#,
    ] {
        assert_eq!(
            bad(&mut e, f),
            json!({"error": "bad_frame"}),
            "{}",
            String::from_utf8_lossy(f)
        );
    }
    // Second configure in any shape (including array and different binding) changes nothing.
    let before = attested.lock().unwrap().clone();
    let mut other = configure_msg("8");
    other["origin"] = json!("https://evil.example");
    assert_eq!(call(&mut e, &other), json!({"error": "bad_frame"}));
    assert_eq!(
        call_raw(&mut e, br#"["configure","1","0x1111111111111111111111111111111111111111","8","https://evil.example",[]]"#),
        json!({"error": "bad_frame"})
    );
    let r = call(&mut e, &json!({"type": "attest"}));
    let after = attested.lock().unwrap().clone();
    assert_eq!(after.last(), before.last(), "binding changed");
    assert_eq!(r["signer"], "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");

    // Duplicate keys in body and inputs, body with BOM, body of 2,049 bytes.
    let dup_inputs = format!(
        r#"{{"type":"evaluate","requestId":"0x{a}","method":"POST","path":"/","body":"{b}","paymentId":"0x{d}","inputs":{{"block":{{"number":"1","hash":"0x{h}","timestamp":"1"}},"payTo":{{"address":"{p}","code":"0x","nonce":"1","balanceWei":"1","nonce":"0"}},"source":"forno"}}}}"#,
        a = "aa".repeat(32),
        b = B64.encode(body("11142220", PAY_TO, SEPOLIA_USDC, "5")),
        d = "dd".repeat(32),
        h = "12".repeat(32),
        p = PAY_TO,
    );
    assert_eq!(
        call_raw(&mut e, dup_inputs.as_bytes()),
        json!({"error": "bad_inputs"})
    );
    let mut bom = b"\xef\xbb\xbf".to_vec();
    bom.extend(body("11142220", PAY_TO, SEPOLIA_USDC, "5"));
    assert_eq!(
        call(&mut e, &evaluate_msg(&bom, inputs(PAY_TO, "0x", "3"))),
        json!({"error": "bad_request"})
    );
}
