// Proves the update-manifest format `.github/workflows/release.yml`'s "Build
// update-manifest fragment" and "Merge per-platform update manifests" steps produce is
// one `tauri-plugin-updater` (the real dependency this app ships) actually accepts —
// not an assumption about the format, a real client parsing a real signed manifest.
//
// Uses a disposable keypair generated with `tauri signer generate` purely for this test;
// it has no connection to the real updater key and signs nothing anyone will ever install.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use tauri_plugin_updater::UpdaterExt;

// Disposable test keypair + a signature of a throwaway payload, both generated locally
// for this test only:
//   npx tauri signer generate -w test.key
//   echo test-artifact-payload > test-artifact.bin
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... npx tauri signer sign -f test.key \
//     --app-version 0.7.1 test-artifact.bin
const TEST_PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDREN0M2ODg1OTA5MkY4RTYKUldUbStKS1FoV2g4VFI2cjQ3VVRMYlhOMHRoamhON2x1aUVxeVk1d1pIcXVvaGFCbm9hM3N2dlQK";
const TEST_SIGNATURE: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUbStKS1FoV2g4VGFYdzIrQ3FZNkxmam92alJYMVBhaE9lOXhENnVwOS9kWVFtOFdkS1B0Unpad3RmYy9wYkRTSkt2a3VFc2NyTTliaUV3d0NRSjd4QjFHYS8rNDZCa2c4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyOTc2NDgwCWZpbGU6dGVzdC1hcnRpZmFjdC5iaW4JdmVyc2lvbjowLjcuMQpWMkI4Z2xxVzFVTXNuQm1icnhMSUhkR3hGV0xPWW40Ylp6WlJLWXBua1dPbWFZcUN3VWdMVzRJQ2JhVzJldW8zK2dWT1ZsQWd2WDBqK1kySTh0TU9DQT09Cg==";

#[test]
fn generated_manifest_fragment_is_understood_by_the_real_updater_client() {
    // Exactly the shape the release workflow's Python merge step writes: top-level
    // version/notes/pub_date, a `platforms` map keyed `{os}-{arch}` with url+signature.
    let manifest = serde_json::json!({
        "version": "0.7.1",
        "notes": "",
        "pub_date": "2026-10-25T18:28:00.123456+00:00",
        "platforms": {
            "linux-x86_64": {
                "signature": TEST_SIGNATURE,
                "url": "https://example.invalid/Driftleaf_0.7.1_amd64.AppImage",
            }
        }
    });
    let body = manifest.to_string();

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind local test server");
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().expect("accept one connection");
        let mut reader = BufReader::new(&mut socket);
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0, "request truncated");
            if line == "\r\n" {
                break;
            }
        }
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body,
        )
        .unwrap();
    });

    // mock_app()'s bare context has no `plugins.updater` entry at all, and the plugin's
    // own config deserializer rejects a missing key outright (treats it as JSON null,
    // not an empty object) — give it one explicitly.
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".to_string(), serde_json::json!({ "pubkey": TEST_PUBLIC_KEY }));
    let app = tauri::test::mock_builder().build(context).expect("build mock app");
    app.handle()
        .plugin(tauri_plugin_updater::Builder::new().pubkey(TEST_PUBLIC_KEY).build())
        .expect("register updater plugin");

    let update = tauri::async_runtime::block_on(async {
        app.handle()
            .updater_builder()
            .endpoints(vec![format!("http://{address}").parse().unwrap()])
            .expect("http endpoint accepted in a debug test build")
            .build()
            .expect("build updater")
            .check()
            .await
    })
    .expect("manifest fetch and signature verification");

    server.join().unwrap();

    let update = update.expect("0.7.1 must be reported available over the mock app's 0.0.0 version");
    assert_eq!(update.version, "0.7.1");
    assert_eq!(update.signature, TEST_SIGNATURE);
    assert_eq!(
        update.download_url.as_str(),
        "https://example.invalid/Driftleaf_0.7.1_amd64.AppImage"
    );
}
