import Foundation
import Security

enum Operation: String {
    case set
    case get
    case delete
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

guard CommandLine.arguments.count == 4,
      let operation = Operation(rawValue: CommandLine.arguments[1]) else {
    fail("Usage: youtube-mcp-keychain set|get|delete SERVICE ACCOUNT")
}

let service = CommandLine.arguments[2]
let account = CommandLine.arguments[3]
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]

switch operation {
case .set:
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    guard !secret.isEmpty else { fail("Refusing to store an empty Keychain value.") }

    let updateStatus = SecItemUpdate(
        query as CFDictionary,
        [kSecValueData as String: secret] as CFDictionary
    )
    if updateStatus == errSecSuccess {
        exit(0)
    }
    if updateStatus != errSecItemNotFound {
        fail("SecItemUpdate failed: \(updateStatus)")
    }

    var addQuery = query
    addQuery[kSecValueData as String] = secret
    addQuery[kSecAttrLabel as String] = service
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    guard addStatus == errSecSuccess else { fail("SecItemAdd failed: \(addStatus)") }

case .get:
    var getQuery = query
    getQuery[kSecReturnData as String] = true
    getQuery[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(getQuery as CFDictionary, &result)
    if status == errSecItemNotFound {
        exit(44)
    }
    guard status == errSecSuccess, let data = result as? Data else {
        fail("SecItemCopyMatching failed: \(status)")
    }
    FileHandle.standardOutput.write(data)

case .delete:
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound {
        exit(44)
    }
    guard status == errSecSuccess else { fail("SecItemDelete failed: \(status)") }
}
