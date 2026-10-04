import Foundation

extension StackControlService {
  /// Existing same-UID socket authentication plus a capability held only by the owned shell/backend.
  func handleUnifiedUI(_ method: String, params: JSONValue, actor: StackActor) throws -> JSONValue {
    guard let fields = params.objectValue else { throw StackControlError.invalid("Pass a native UI object") }
    if method == "integration.ui.host" {
      guard fields.isEmpty else { throw StackControlError.invalid("Host status does not accept arguments") }
      return AgentShellController.shared.status()
    }
    guard method == "integration.ui.open", actor.pid != nil,
      Set(fields.keys).isSubset(of: ["installationID", "token", "surface", "mode", "workspaceID"]),
      let installationID = fields["installationID"]?.stringValue,
      installationID == (try integrationStore()).installationID,
      let token = fields["token"]?.stringValue, token.utf8.count <= 160,
      AgentShellController.shared.authorizesUI(token: token) else {
      throw StackControlError(code: "unauthorized", message: "Native UI requires the owned application connection")
    }
    let uiFields = fields.filter { ["surface", "mode", "workspaceID"].contains($0.key) }
    let request = try AgentShellUIRequest.decode(JSONEncoder().encode(JSONValue.object(uiFields)))
    try AgentShellNativeUI.open(request)
    return .object(["opened": .string(request.surface)])
  }
}
