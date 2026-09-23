import Foundation

nonisolated enum AnsiParser {
  struct Style: Equatable, Sendable {
    var foreground: Int?
    var bold = false
    var dim = false
  }
  struct Run: Equatable, Sendable { var text: String; let style: Style }
  struct State: Sendable {
    var style = Style()
    mutating func parse(_ text: String) -> [Run] {
      let chars = Array(text.unicodeScalars)
      var runs: [Run] = [], buffer = "", index = 0
      func flush(_ style: Style) { if !buffer.isEmpty { runs.append(.init(text: buffer, style: style)); buffer = "" } }
      while index < chars.count {
        let value = chars[index].value
        if value == 0x1b {
          flush(style); index += 1
          guard index < chars.count else { break }
          if chars[index] == "[" {
            index += 1
            var parameters = ""
            while index < chars.count, !(0x40...0x7e).contains(chars[index].value) {
              parameters.unicodeScalars.append(chars[index]); index += 1
            }
            if index < chars.count, chars[index] == "m" { apply(parameters) }
            index += 1
          } else if chars[index] == "]" {
            index += 1
            while index < chars.count {
              if chars[index].value == 7 { index += 1; break }
              if chars[index].value == 0x1b, index + 1 < chars.count, chars[index + 1] == "\\" { index += 2; break }
              index += 1
            }
          } else { index += 1 }
          continue
        }
        if value == 9 || value == 10 || value >= 32 && value != 127 { buffer.unicodeScalars.append(chars[index]) }
        index += 1
      }
      flush(style)
      return runs
    }
    private mutating func apply(_ parameters: String) {
      let values = parameters.isEmpty ? [0] : parameters.split(separator: ";", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
      var index = 0
      while index < values.count {
        let code = values[index]
        switch code {
        case 0: style = .init()
        case 1: style.bold = true
        case 2: style.dim = true
        case 22: style.bold = false; style.dim = false
        case 30...37: style.foreground = code - 30
        case 90...97: style.foreground = code - 90 + 8
        case 39: style.foreground = nil
        case 38, 48:
          if index + 2 < values.count, values[index + 1] == 5 {
            if code == 38 { style.foreground = min(255, max(0, values[index + 2])) }
            index += 2
          } else if index + 4 < values.count, values[index + 1] == 2 { index += 4 }
        default: break
        }
        index += 1
      }
    }
  }
  static func plainText(_ text: String) -> String { var state = State(); return state.parse(text).map(\.text).joined() }
}
