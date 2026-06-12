// Basic Auth Autofill — native messaging host (approach B: LAContext gate)
//
// macOS Touch ID bridge for the Chrome extension. Because hardware-gated
// Keychain items (SecAccessControl / Secure Enclave) require a paid Apple
// Developer signing + provisioning profile, this build uses a software gate:
//   - Touch ID is enforced via LAContext.evaluatePolicy before releasing the key.
//   - The 32-byte "biometric key" itself is stored as an ordinary generic
//     password in the login keychain (no entitlement required).
// Trade-off: the key lives on disk (login keychain), so a local attacker running
// as this user could read it without Touch ID. The master password remains the
// strong recovery path; biometric unlock is a convenience layer.
//
// Protocol: Chrome native messaging (4-byte LE length prefix + JSON) over
// stdin/stdout. One request -> one response. Loops until stdin EOF.
//
// Commands ({"cmd": "..."}):
//   status  -> {ok, enrolled}
//   enroll  -> {ok, key}   // Touch ID, then generate+store key, return it (base64)
//   unlock  -> {ok, key}   // Touch ID, then return stored key (base64)
//   reset   -> {ok}        // delete stored key
// Errors  -> {ok:false, error, code?}

import Foundation
import LocalAuthentication
import Security

let SERVICE = "com.tsuchida.basic-auth-autofill"
let ACCOUNT = "bio-wrap-key"
let REASON = "Basic Auth Autofill のロックを解除"

// MARK: - Native messaging I/O

func readExact(_ n: Int) -> Data? {
    var data = Data()
    while data.count < n {
        let chunk = FileHandle.standardInput.readData(ofLength: n - data.count)
        if chunk.isEmpty { return nil } // EOF
        data.append(chunk)
    }
    return data
}

func readMessage() -> [String: Any]? {
    guard let lenData = readExact(4) else { return nil }
    let len = lenData.withUnsafeBytes { $0.load(as: UInt32.self) }
    if len == 0 || len > 64 * 1024 { return nil }
    guard let body = readExact(Int(len)) else { return nil }
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

func writeMessage(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    var len = UInt32(data.count).littleEndian
    let lenData = Data(bytes: &len, count: 4)
    FileHandle.standardOutput.write(lenData)
    FileHandle.standardOutput.write(data)
}

// MARK: - Touch ID gate

func authenticate() -> (ok: Bool, error: String?) {
    let ctx = LAContext()
    ctx.localizedReason = REASON
    var policyError: NSError?
    // .deviceOwnerAuthentication = Touch ID, with device password as fallback.
    guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
        return (false, "生体認証が利用できません: \(policyError?.localizedDescription ?? "unknown")")
    }
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    var message: String?
    ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: REASON) { success, error in
        ok = success
        if let e = error { message = e.localizedDescription }
        sem.signal()
    }
    sem.wait()
    return (ok, message)
}

// MARK: - Keychain (ordinary generic password, login keychain)

func baseQuery() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: SERVICE,
        kSecAttrAccount as String: ACCOUNT,
    ]
}

func deleteKey() -> OSStatus {
    SecItemDelete(baseQuery() as CFDictionary)
}

func storeKey(_ keyData: Data) -> OSStatus {
    _ = deleteKey()
    var q = baseQuery()
    q[kSecValueData as String] = keyData
    return SecItemAdd(q as CFDictionary, nil)
}

func loadKey() -> (status: OSStatus, data: Data?) {
    var q = baseQuery()
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    return (st, out as? Data)
}

func isEnrolled() -> Bool {
    var q = baseQuery()
    q[kSecReturnAttributes as String] = true
    return SecItemCopyMatching(q as CFDictionary, nil) == errSecSuccess
}

// MARK: - Commands

func enroll() -> [String: Any] {
    let auth = authenticate()
    if !auth.ok { return ["ok": false, "error": auth.error ?? "認証に失敗しました"] }

    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        return ["ok": false, "error": "乱数生成に失敗"]
    }
    let keyData = Data(bytes)
    let st = storeKey(keyData)
    if st != errSecSuccess {
        return ["ok": false, "error": "キーチェーン保存に失敗", "code": Int(st)]
    }
    return ["ok": true, "key": keyData.base64EncodedString()]
}

func unlock() -> [String: Any] {
    if !isEnrolled() { return ["ok": false, "error": "未登録です", "code": Int(errSecItemNotFound)] }
    let auth = authenticate()
    if !auth.ok { return ["ok": false, "error": auth.error ?? "認証に失敗しました"] }

    let result = loadKey()
    if result.status == errSecSuccess, let data = result.data {
        return ["ok": true, "key": data.base64EncodedString()]
    }
    return ["ok": false, "error": "鍵の読み出しに失敗", "code": Int(result.status)]
}

// MARK: - Main loop

while let msg = readMessage() {
    let cmd = msg["cmd"] as? String ?? ""
    let response: [String: Any]
    switch cmd {
    case "status":
        response = ["ok": true, "enrolled": isEnrolled()]
    case "enroll":
        response = enroll()
    case "unlock":
        response = unlock()
    case "reset":
        let st = deleteKey()
        response = (st == errSecSuccess || st == errSecItemNotFound)
            ? ["ok": true]
            : ["ok": false, "error": "削除に失敗", "code": Int(st)]
    default:
        response = ["ok": false, "error": "不明なコマンド: \(cmd)"]
    }
    writeMessage(response)
}
