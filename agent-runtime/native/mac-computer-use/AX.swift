import AppKit
import ApplicationServices
import Foundation

enum AX {
  static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
      ? value : nil
  }

  static func string(_ value: CFTypeRef?) -> String? {
    guard let value else { return nil }
    if let text = value as? String { return text }
    if let text = value as? NSAttributedString { return text.string }
    if CFGetTypeID(value) == CFBooleanGetTypeID() {
      return CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false"
    }
    if let number = value as? NSNumber { return number.stringValue }
    if let url = value as? URL { return url.absoluteString }
    return nil
  }

  static func bool(_ value: CFTypeRef?) -> Bool? {
    guard let value, CFGetTypeID(value) == CFBooleanGetTypeID() else {
      return (value as? NSNumber)?.boolValue
    }
    return CFBooleanGetValue((value as! CFBoolean))
  }

  static func point(_ value: CFTypeRef?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
  }

  static func size(_ value: CFTypeRef?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
  }

  static func frame(_ element: AXUIElement) -> CGRect? {
    guard let origin = point(copy(element, kAXPositionAttribute)),
      let size = size(copy(element, kAXSizeAttribute))
    else { return nil }
    return CGRect(origin: origin, size: size)
  }

  static func elements(_ value: CFTypeRef?) -> [AXUIElement] {
    guard let array = value as? [AnyObject] else { return [] }
    return array.compactMap {
      CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil
    }
  }

  static func actions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success, let names = names as? [String]
    else { return [] }
    return names
  }

  /// Fetches several attributes in one IPC round trip; missing ones are nil.
  static func many(_ element: AXUIElement, _ attributes: [String]) -> [CFTypeRef?] {
    var values: CFArray?
    guard
      AXUIElementCopyMultipleAttributeValues(
        element, attributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
        == .success, let array = values as? [AnyObject], array.count == attributes.count
    else { return attributes.map { copy(element, $0) } }
    return array.map { value in
      if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError {
        return nil
      }
      return value
    }
  }
}

/// Human-readable action labels. Standard AX actions map to fixed names and
/// custom actions ("Name:Delete\nTarget:…") use their Name field.
func actionLabel(_ raw: String) -> String? {
  switch raw {
  case "AXPress", "AXScrollToVisible": return nil
  case "AXShowMenu": return "Show Menu"
  case "AXRaise": return "Raise"
  case "AXIncrement": return "Increment"
  case "AXDecrement": return "Decrement"
  case "AXConfirm": return "Confirm"
  case "AXCancel": return "Cancel"
  case "AXPick": return "Pick"
  case "AXShowAlternateUI": return "Show Alternate UI"
  case "AXShowDefaultUI": return "Show Default UI"
  default:
    if raw.hasPrefix("Name:") {
      return raw.dropFirst(5).split(separator: "\n").first.map(String.init)
    }
    return raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
  }
}

/// Per-app element registry. Identity keys (ancestor path + role + label +
/// sibling ordinal) map to stable indexes, so an unchanged element keeps its
/// index across reads and the server can send diffs.
final class ElementStore {
  var nextID = 1
  var keyToID: [String: Int] = [:]
  var elements: [Int: (element: AXUIElement, frame: CGRect?)] = [:]
  var window: AXUIElement?
  var windowID: CGWindowID?

  func id(for key: String) -> Int {
    if let id = keyToID[key] { return id }
    if keyToID.count > 40_000 {
      keyToID.removeAll()
    }
    let id = nextID
    nextID += 1
    keyToID[key] = id
    return id
  }
}

enum Stores {
  private static let lock = NSLock()
  private static var stores: [String: ElementStore] = [:]
  private static var recent: [String] = []
  static func store(_ bundleId: String) -> ElementStore {
    lock.lock()
    defer { lock.unlock() }
    recent.removeAll { $0 == bundleId }
    recent.append(bundleId)
    if let store = stores[bundleId] { return store }
    let store = ElementStore()
    stores[bundleId] = store
    if recent.count > 300 { stores.removeValue(forKey: recent.removeFirst()) }
    return store
  }
}

private let alwaysListed: Set<String> = [
  "AXWindow", "AXSheet", "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
  "AXMenuButton", "AXComboBox", "AXTextField", "AXTextArea", "AXSearchField", "AXSlider",
  "AXIncrementor", "AXLink", "AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem", "AXTabGroup",
  "AXTable", "AXOutline", "AXList", "AXDisclosureTriangle", "AXColorWell", "AXToolbar",
  "AXWebArea", "AXHeading", "AXDateField", "AXStepper", "AXRadioGroup", "AXSegmentedControl",
  "AXBrowser",
]
private let rowLike: Set<String> = ["AXTable", "AXOutline", "AXList", "AXBrowser"]
private let attributes = [
  kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute,
  kAXDescriptionAttribute, kAXHelpAttribute, kAXIdentifierAttribute, kAXEnabledAttribute,
  kAXFocusedAttribute, kAXSelectedAttribute, "AXExpanded", kAXPlaceholderValueAttribute,
  kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute, "AXURL",
]

private func clip(_ text: String?, _ limit: Int) -> String? {
  guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
    return nil
  }
  return text.count > limit ? String(text.prefix(limit)) + "…" : text
}

struct TreeWalk {
  let store: ElementStore
  let windowFrame: CGRect?
  let maxNodes: Int
  let deadline: Date
  var nodes: [[String: Any]] = []
  var truncated = false

  mutating func visit(
    _ element: AXUIElement, parentKey: String, siblings: inout [String: Int], parent: Int,
    depth: Int, inMenu: Bool = false
  ) {
    guard depth < 60 else { return }
    guard nodes.count < maxNodes, Date() < deadline else {
      truncated = true
      return
    }
    let values = AX.many(element, attributes)
    let role = AX.string(values[0]) ?? "AXUnknown"
    let subrole = AX.string(values[1])
    let title = clip(AX.string(values[2]), 200)
    let rawValue = values[3]
    let value: String? =
      rawValue.flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? nil : clip(AX.string($0), 400) }
    let description = clip(AX.string(values[4]), 200)
    let help = clip(AX.string(values[5]), 120)
    let identifier = clip(AX.string(values[6]), 80)
    let enabled = AX.bool(values[7]) ?? true
    let focused = AX.bool(values[8]) ?? false
    let selected = AX.bool(values[9]) ?? false
    let expanded = AX.bool(values[10])
    let placeholder = clip(AX.string(values[11]), 120)
    var frame: CGRect?
    if let origin = AX.point(values[12]), let size = AX.size(values[13]) {
      frame = CGRect(origin: origin, size: size)
    }
    let menuish = inMenu || role.hasPrefix("AXMenu")
    // Skip subtrees that lie entirely outside the target window.
    if let frame, let windowFrame, !menuish, frame.width > 0, frame.height > 0,
      !frame.intersects(windowFrame.insetBy(dx: -4, dy: -4))
    {
      return
    }
    let label = identifier ?? title ?? description ?? ""
    let base = "\(role):\(label.prefix(40))"
    let ordinal = siblings[base, default: 0]
    siblings[base] = ordinal + 1
    let key = "\(parentKey)/\(base)#\(ordinal)"

    let rawActions = AX.actions(element)
    let actionable = rawActions.contains { ["AXPress", "AXConfirm", "AXPick", "AXIncrement"].contains($0) }
    let emit =
      alwaysListed.contains(role) || title != nil || description != nil
      || (value != nil && role != "AXGroup") || actionable || focused
    var current = parent
    var childDepth = depth
    if emit {
      let id = store.id(for: key)
      store.elements[id] = (element, frame)
      var node: [String: Any] = ["id": id, "parent": parent, "depth": depth, "role": role]
      if let subrole { node["subrole"] = subrole }
      if let title { node["title"] = title }
      if let value { node["value"] = value }
      if let description { node["description"] = description }
      if let help, help != title, help != description { node["help"] = help }
      if let placeholder { node["placeholder"] = placeholder }
      if let identifier { node["identifier"] = identifier }
      if let url = clip(AX.string(values[15]), 200), role == "AXLink" || role == "AXWebArea" {
        node["url"] = url
      }
      if !enabled { node["disabled"] = true }
      if focused { node["focused"] = true }
      if selected { node["selected"] = true }
      if let expanded { node["expanded"] = expanded }
      let labels = rawActions.compactMap(actionLabel)
      if !labels.isEmpty { node["actions"] = Array(labels.prefix(8)) }
      nodes.append(node)
      current = id
      childDepth = depth + 1
    }
    // Closed menus keep their items in the tree; only open ones are listed.
    if role == "AXMenuBarItem" && !selected { return }
    var children = AX.elements(values[14])
    if rowLike.contains(role) {
      let rows = AX.elements(AX.copy(element, kAXVisibleRowsAttribute))
      if !rows.isEmpty { children = rows }
    }
    var counts: [String: Int] = [:]
    for child in children.prefix(400) {
      visit(
        child, parentKey: key, siblings: &counts, parent: current, depth: childDepth,
        inMenu: menuish)
      if truncated { return }
    }
  }
}
