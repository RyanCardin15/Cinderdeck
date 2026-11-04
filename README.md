# Cinderdeck

Cinderdeck is a macOS build of T3 Code with the Cinderdeck logo and a native capture history. Add a project folder in the main window to group its agent conversations. The desktop runtime and mobile companion come from [T3 Code](https://github.com/pingdotgg/t3code/tree/9e855385).

Press **⌘⇧H** to open History, or use your existing custom shortcut. Browse All Captures, Screenshots, Videos, GIFs, and Clipboard Text. You can enable or pause clipboard collection inside the panel.

## Build

On macOS with Xcode and Rust installed, build a local app with:

```sh
./scripts/build-unified.sh --configuration Debug --output-dir "$PWD/.build/delivery"
```

The app uses a fresh T3 session store. Earlier Cinderdeck agent sessions and multi-repository workspace definitions stay in their original storage. Native capture history and shortcut preferences continue to use their existing storage.

See [the build guide](docs/UNIFIED_APP.md), [release instructions](docs/RELEASES.md), and [license notices](NOTICE).
