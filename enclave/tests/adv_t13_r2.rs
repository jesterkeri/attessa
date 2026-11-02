//! Adversarial pass 2 on T13 (`parse_strict`, SPEC §4.2, §4.3, INV-16, INV-17).

mod common;

use attessa_enclave::enclave::Enclave;
use attessa_enclave::formats::{jcs, keccak, to_hex};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use common::*;
use serde_json::{json, Value};

fn eval_raw(e: &mut Enclave<FakeNsm>, body: &[u8], inputs_json: &str) -> Value {
    let frame = format!(
        r#"{{"type":"evaluate","requestId":"0x{a}","method":"POST","path":"/v1/evaluate","body":"{b}","paymentId":"0x{d}","inputs":{i}}}"#,
        a = "aa".repeat(32),
        b = B64.encode(body),
        d = "dd".repeat(32),
        i = inputs_json,
    );
    call_raw(e, frame.as_bytes())
}

/// Valid JSON that SPEC allows (other key order, whitespace, escaped keys and values) must
/// still be accepted, and give the same response bytes as the plain form (INV-16).
#[test]
fn adv_r2_equivalent_spellings_are_accepted_and_identical() {
    let (mut e, _) = configured(key_one());
    let b = body("11142220", PAY_TO, SEPOLIA_USDC, "5");
    let plain = inputs(PAY_TO, "0x", "3").to_string();
    let spelled = format!(
        r#" {{ "source" : "forno", "payTo":{{"nonce":"3","balanceWei":"5","code":"0x","address":"{PAY_TO}"}},
            "block":{{"timestamp":"1761782400","number":"123","hash":"0x1234567890123456789012345678901234567890123456789012345678901234"}} }} "#
    );
    let a = eval_raw(&mut e, &b, &plain);
    let s = eval_raw(&mut e, &b, &spelled);
    assert!(a.get("proof").is_some(), "{a}");
    assert_eq!(a["response"], s["response"], "response bytes differ");
    assert_eq!(a["proof"]["inputsHash"], s["proof"]["inputsHash"]);

    // inputsHash == keccak(JCS(response.inputs)) (INV-17).
    let resp: Value =
        serde_json::from_slice(&B64.decode(s["response"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(
        to_hex(&keccak(jcs(&resp["inputs"]).unwrap().as_bytes())),
        s["proof"]["inputsHash"].as_str().unwrap()
    );

    // Escaped type key, shuffled frame keys, escaped body keys.
    let body_escaped = format!(
        r#"{{"amount":"5","asset":"{SEPOLIA_USDC}","payTo":"{PAY_TO}","chainId":"11142220"}}"#
    );
    let r = eval_raw(&mut e, body_escaped.as_bytes(), &plain);
    assert!(r.get("proof").is_some(), "{r}");
    assert_eq!(
        call_raw(&mut e, br#"{"type":"attest"}"#)["signer"],
        "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
    );
}

/// Non-object shapes, at every struct position of every message, are refused.
#[test]
fn adv_r2_non_objects_refused_everywhere() {
    let (mut e, _) = configured(key_one());
    let b = body("11142220", PAY_TO, SEPOLIA_USDC, "5");
    let h = "0x1234567890123456789012345678901234567890123456789012345678901234";
    for inputs_json in [
        format!(
            r#"{{"block":["123","{h}","1"],"payTo":{{"address":"{PAY_TO}","code":"0x","nonce":"3","balanceWei":"5"}},"source":"forno"}}"#
        ),
        format!(
            r#"{{"block":{{"number":"123","hash":"{h}","timestamp":"1"}},"payTo":["{PAY_TO}","0x","3","5"],"source":"forno"}}"#
        ),
        format!(r#"[["123","{h}","1"],["{PAY_TO}","0x","3","5"],"forno"]"#),
        format!(
            r#"{{"block":null,"payTo":{{"address":"{PAY_TO}","code":"0x","nonce":"3","balanceWei":"5"}},"source":"forno"}}"#
        ),
        format!(
            r#"{{"block":{{"number":"123","hash":"{h}","timestamp":"1","number":"124"}},"payTo":{{"address":"{PAY_TO}","code":"0x","nonce":"3","balanceWei":"5"}},"source":"forno"}}"#
        ),
        format!(
            r#"{{"block":{{"number":"123","hash":"{h}","timestamp":"1"}},"payTo":{{"address":"{PAY_TO}","code":"0x","nonce":"3","balanceWei":"5"}},"source":"forno","source":"buy:x"}}"#
        ),
        format!(
            r#"{{"block":{{"number":"123","hash":"{h}","timestamp":"1"}},"payTo":{{"address":"{PAY_TO}","code":"0x","nonce":"3","balanceWei":"5"}},"source":true}}"#
        ),
        format!(r#""{{\"block\":{{}}}}""#),
    ] {
        assert_eq!(
            eval_raw(&mut e, &b, &inputs_json),
            json!({"error": "bad_inputs"}),
            "{inputs_json}"
        );
    }
    for frame in [
        &br#"["attest"]"#[..],
        br#"[{"type":"attest"}]"#,
        br#"{"type":"attest","type":"attest"}"#,
        br#"{"type":"evaluate","type":"attest"}"#,
        br#"{"type":"liveness","challenge":["0x00"]}"#,
        br#"{"type":["attest"]}"#,
        br#"{"type":"attest","x":null}"#,
    ] {
        assert_eq!(
            call_raw(&mut e, frame),
            json!({"error": "bad_frame"}),
            "{}",
            String::from_utf8_lossy(frame)
        );
    }
    // Configure frames before configuration: rpcAllowedChains as object, nested arrays, duplicates.
    let mut fresh = Enclave::new(FakeNsm::with_key(key_one()), fixed_clock);
    for frame in [
        r#"{"type":"configure","chainId":"11142220","registry":"0x1111111111111111111111111111111111111111","agentId":"7","origin":"https://example.com","rpcAllowedChains":{"0":"11142220"}}"#,
        r#"{"type":"configure","chainId":"11142220","registry":"0x1111111111111111111111111111111111111111","agentId":"7","origin":"https://example.com","rpcAllowedChains":[["11142220"]]}"#,
        r#"{"type":"configure","chainId":"11142220","chainId":"42220","registry":"0x1111111111111111111111111111111111111111","agentId":"7","origin":"https://example.com","rpcAllowedChains":[]}"#,
        r#"["configure","11142220","0x1111111111111111111111111111111111111111","7","https://example.com",[]]"#,
    ] {
        assert_eq!(
            call_raw(&mut fresh, frame.as_bytes()),
            json!({"error": "bad_frame"}),
            "{frame}"
        );
    }
    let ok = call(&mut fresh, &configure_msg("7"));
    assert!(
        ok.get("signer").is_some(),
        "one-shot was used up by a refused configure: {ok}"
    );
}
