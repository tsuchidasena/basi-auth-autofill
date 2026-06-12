// Basic Auth Autofill — native messaging host
//
// Bridges the Chrome extension to macOS Touch ID via LocalAuthentication +
// Keychain. Holds a random 32-byte "biometric key" in the login keychain,
// access-controlled so that reading it requires Touch ID (or device passcode).
//
// Protocol: Chrome native messaging (4-byte LE length prefix + JSON body) over
// stdin/stdout. One request -> one response. Loops until stdin EOF.
//
// Commands (JSON {"cmd": "..."}):
//   status  -> {ok, enrolled}
//   enroll  -> {ok, key}        // generates + stores key, returns it once (base64)
//   unlock  -> {ok, key}        // Touch ID, then returns the stored key (base64)
//   reset   -> {ok}             // deletes the stored key
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

// MARK: - Keychain

func deleteKey() -> OSStatus {
    let q: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: SERVICE,
        kSecAttrAccount as String: ACCOUNT,
    ]
    return SecItemDelete(q as CFDictionary)
}

func enroll() -> [String: Any] {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        return ["ok": false, "error": "乱数生成に失敗"]
    }
    let keyData = Data(bytes)

    var acError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
        .userPresence, // Touch ID, with device passcode as fallback
        &acError
    ) else {
        return ["ok": false, "error": "アクセス制御の作成に失敗"]
    }

    _ = deleteKey() // replace any existing enrollment

    let addQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: SERVICE,
        kSecAttrAccount as String: ACCOUNT,
        kSecValueData as String: keyData,
        kSecAttrAccessControl as String: access,
    ]
    let status = SecItemAdd(addQuery as CFDictionary, nil)
    if status != errSecSuccess {
        return ["ok": false, "error": "キーチェーン保存に失敗", "code": Int(status)]
    }
    return ["ok": true, "key": keyData.base64EncodedString()]
}

func unlock() -> [String: Any] {
    let context = LAContext()
    context.localizedReason = REASON
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: SERVICE,
        kSecAttrAccount as String: ACCOUNT,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
        kSecUseAuthenticationContext as String: context,
    ]
    var out: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &out)
    if status == errSecSuccess, let data = out as? Data {
        return ["ok": true, "key": data.base64EncodedString()]
    }
    if status == errSecItemNotFound {
        return ["ok": false, "error": "未登録です", "code": Int(status)]
    }
    if status == errSecUserCanceled || status == errSecAuthFailed {
        return ["ok": false, "error": "認証がキャンセル/失敗しました", "code": Int(status)]
    }
    return ["ok": false, "error": "解錠に失敗", "code": Int(status)]
}

func status() -> [String: Any] {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: SERVICE,
        kSecAttrAccount as String: ACCOUNT,
        kSecReturnAttributes as String: true,
        kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
    ]
    let st = SecItemCopyMatching(query as CFDictionary, nil)
    // Item present but gated by biometrics => errSecInteractionNotAllowed.
    let enrolled = (st == errSecSuccess || st == errSecInteractionNotAllowed)
    return ["ok": true, "enrolled": enrolled]
}

// MARK: - Main loop

while let msg = readMessage() {
    let cmd = msg["cmd"] as? String ?? ""
    let response: [String: Any]
    switch cmd {
    case "status": response = status()
    case "enroll": response = enroll()
    case "unlock": response = unlock()
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
