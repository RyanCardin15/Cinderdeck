import Foundation

nonisolated struct DictationCommand: Decodable, Equatable {
  let action: String
  let requestID: String
  static func decode(_ data: Data) throws -> Self {
    guard data.count < 512, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == ["action", "requestID"] else { throw DictationError.message("Invalid dictation command.") }
    let value = try JSONDecoder().decode(Self.self, from: data)
    guard ["start", "stop", "cancel"].contains(value.action), UUID(uuidString: value.requestID) != nil else {
      throw DictationError.message("Invalid dictation command.")
    }
    return value
  }
}
