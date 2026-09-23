import Foundation

nonisolated struct GitRepoStatus: Equatable, Sendable {
  var branch = "Unknown"
  var oid = ""
  var upstream: String?
  var ahead = 0
  var behind = 0
  var staged = 0
  var unstaged = 0
  var untracked = 0
  var conflicted = 0
  var changedFiles = 0
  var operation: String?
  var error: String?
  var isDirty: Bool { changedFiles > 0 }
  var isDetached: Bool { branch == "(detached)" }
  var branchLabel: String { isDetached ? "Detached \(oid.prefix(7))" : branch }
  var chip: String {
    branchLabel + (isDirty ? "*" : "") + (ahead > 0 ? " ↑\(ahead)" : "") + (behind > 0 ? " ↓\(behind)" : "")
  }
}

nonisolated enum GitStatusParser {
  static func parse(_ output: String, operation: String? = nil) -> GitRepoStatus {
    var status = GitRepoStatus(operation: operation)
    let records = output.components(separatedBy: "\0")
    var index = 0
    while index < records.count {
      let record = records[index]
      index += 1
      if record.hasPrefix("# ") {
        // Headers use NUL with -z; also accept line-delimited fixtures.
        for header in record.components(separatedBy: "\n") {
          if header.hasPrefix("# branch.head ") { status.branch = String(header.dropFirst(14)) }
          if header.hasPrefix("# branch.oid ") { status.oid = String(header.dropFirst(13)) }
          if header.hasPrefix("# branch.upstream ") { status.upstream = String(header.dropFirst(18)) }
          if header.hasPrefix("# branch.ab ") {
            let counts = header.dropFirst(12).split(separator: " ")
            for count in counts {
              if count.first == "+" { status.ahead = Int(count.dropFirst()) ?? 0 }
              if count.first == "-" { status.behind = Int(count.dropFirst()) ?? 0 }
            }
          }
        }
      } else if record.hasPrefix("1 ") || record.hasPrefix("2 ") {
        let fields = record.split(separator: " ", maxSplits: 2)
        if fields.count > 1 {
          let xy = Array(fields[1])
          if xy.count == 2 {
            if xy[0] != "." { status.staged += 1 }
            if xy[1] != "." { status.unstaged += 1 }
          }
        }
        status.changedFiles += 1
        if record.hasPrefix("2 ") { index += 1 } // Original rename path is the next NUL field.
      } else if record.hasPrefix("? ") { status.untracked += 1; status.changedFiles += 1 }
      else if record.hasPrefix("u ") { status.conflicted += 1; status.changedFiles += 1 }
    }
    return status
  }

  static func recentBranches(_ reflog: String, limit: Int = 8) -> [String] {
    var result: [String] = []
    for entry in reflog.components(separatedBy: "\n") where entry.hasPrefix("checkout: moving from ") {
      guard let range = entry.range(of: " to ", options: .backwards) else { continue }
      let branch = String(entry[range.upperBound...])
      guard !branch.isEmpty, branch != "HEAD", branch.range(of: "^[0-9a-f]{7,40}$", options: .regularExpression) == nil,
        !result.contains(branch) else { continue }
      result.append(branch)
      if result.count >= limit { break }
    }
    return result
  }
}

nonisolated struct GitBranch: Identifiable, Hashable, Sendable {
  let name: String
  let reference: String
  let isRemote: Bool
  var upstream: String?
  var subject: String = ""
  var id: String { reference }
  var displayName: String { isRemote ? String(reference.dropFirst("refs/remotes/".count)) : name }
}

nonisolated struct GitStash: Identifiable, Sendable {
  let reference: String
  let oid: String
  let message: String
  var id: String { oid }
}

nonisolated enum GitDirtyStrategy: Sendable { case requireClean, stash, carry }
