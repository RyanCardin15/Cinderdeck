# Cinderdeck

Cinderdeck combines coding agents with native macOS capture history. Add a project folder in the main window to group its agent conversations. Expand a project to see up to ten threads, with unsettled threads first. **Show more** opens a searchable list for that project, including older settled threads. The embedded desktop runtime and mobile companion are maintained in `agent-runtime/`.

Press **⌘⇧H** to open History, or use your existing custom shortcut. Browse All Captures, Screenshots, Videos, GIFs, and Clipboard Text. You can enable or pause clipboard collection inside the panel.

## Build

On macOS with Xcode and Rust installed, build a local app with:

```sh
./scripts/build-unified.sh --configuration Debug --output-dir "$PWD/.build/delivery"
```

The app uses a dedicated session store. Earlier Cinderdeck agent sessions and multi-repository workspace definitions stay in their original storage. Native capture history and shortcut preferences continue to use their existing storage.

See [the build guide](docs/UNIFIED_APP.md), [release instructions](docs/RELEASES.md), and [license notices](NOTICE).
