# Cinderdeck

This repository builds one Cinderdeck macOS super app and its mobile companion. Native code is in `Cinderdeck/`; the embedded agent/chat/preview runtime and companion are in `agent-runtime/`. Start with README.md, docs/UNIFIED_APP.md and docs/STRUCTURE.md; follow agent-runtime/AGENTS.md for runtime changes.

Use `scripts/build-unified.sh` to build the complete app. Native Cinderdeck owns app identity, capture permissions, services, lanes, logs, recordings and Sparkle updates. The Cinderdeck runtime is a private bundled child with no separate product release. Do not reintroduce the former T3 website, relay deployment, installers or upstream patch policy. Preserve licenses, original copyright notices, protocol fixtures and compatibility storage keys.

Preserve unrelated uncommitted work. Stop only processes you started and tracked; never kill by name or path matching. Never use live user data for development. Run checks appropriate to the changed surfaces and describe any unverified runtime behavior. Do not install, launch a browser/device, publish, merge or create a PR without authorization for that action. Repository-wide cleanup warrants package typechecks and build validation.
