import SwiftUI

struct BranchPickerPopover: View {
  @ObservedObject var viewModel: StacksViewModel
  @State private var query = ""
  @FocusState private var focused: Bool
  private var matching: [GitBranch] { viewModel.branches.filter { query.isEmpty || $0.displayName.localizedCaseInsensitiveContains(query) } }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Switch \(viewModel.branchPicker?.repo.id ?? "repo")").font(.headline)
      TextField("Search branches", text: $query).textFieldStyle(.roundedBorder).focused($focused)
      if viewModel.loadingBranches { ProgressView().frame(maxWidth: .infinity) }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 4) {
          group("Recent", branches: viewModel.recentBranches.compactMap { name in matching.first { !$0.isRemote && $0.name == name } })
          group("Local", branches: matching.filter { !$0.isRemote })
          group("Remote", branches: matching.filter { remote in remote.isRemote && !viewModel.branches.contains(where: { local in !local.isRemote && local.name == remote.name }) })
          if matching.isEmpty && !viewModel.loadingBranches { Text("No matching branches").foregroundColor(.secondary).font(.caption) }
        }
      }
      Text("Remote branches create a local tracking branch.").font(.caption2).foregroundColor(.secondary)
    }.padding(14).frame(width: 315, height: 330).onAppear { focused = true }
  }
  @ViewBuilder private func group(_ title: String, branches: [GitBranch]) -> some View {
    if !branches.isEmpty {
      Text(title.uppercased()).font(.caption2.weight(.semibold)).foregroundColor(.secondary).padding(.top, 6)
      ForEach(branches) { branch in
        Button { viewModel.chooseBranch(branch) } label: {
          VStack(alignment: .leading, spacing: 2) {
            Label(branch.displayName, systemImage: "arrow.triangle.branch").font(.system(size: 12, weight: .medium))
            if !branch.subject.isEmpty { Text(branch.subject).font(.caption2).foregroundColor(.secondary).lineLimit(1) }
          }.frame(maxWidth: .infinity, alignment: .leading).padding(5).contentShape(Rectangle())
        }.buttonStyle(.plain)
      }
    }
  }
}

struct StackBranchPickerSheet: View {
  @ObservedObject var viewModel: StacksViewModel
  @State private var query = ""
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Switch workspace to branch").font(.title2.weight(.semibold))
      Text("Repos that do not have the branch keep their current branch.").foregroundColor(.secondary)
      TextField("Search branches", text: $query).textFieldStyle(.roundedBorder)
      if viewModel.loadingBranches { ProgressView() }
      List(viewModel.stackBranches.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) { choice in
        Button { viewModel.chooseStackBranch(choice) } label: {
          HStack { Text(choice.name); Spacer(); Text("\(choice.branches.count) of \(viewModel.selectedDefinition?.repos.count ?? 0) repos").foregroundColor(.secondary) }
        }.buttonStyle(.plain)
      }
      HStack { Spacer(); Button("Cancel") { viewModel.stackBranchPicker = false }.keyboardShortcut(.cancelAction) }
    }.padding(20).frame(width: 480, height: 390)
  }
}
