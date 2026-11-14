# Contributing to the Cinderdeck runtime

The runtime is maintained as part of the Cinderdeck macOS app and its mobile companion.
Follow the [repository contribution guide](../CONTRIBUTING.md), [root instructions](../AGENTS.md)
and [runtime instructions](AGENTS.md).

Use the Node and pnpm versions pinned in `package.json`, install dependencies with
`pnpm install --frozen-lockfile`, and run focused tests plus the affected package typechecks.
Use synthetic data and disposable state; preserve unrelated local changes.

Build the complete app with `../scripts/build-unified.sh`. Native Cinderdeck owns app identity,
capture permissions, workspace services and whole-app updates. Preserve protocol fixtures,
persisted compatibility identifiers, original licenses and copyright notices.

Run `python3 ../scripts/check-repository.py` for the product-boundary and branding audit.
Whole-app release preparation follows [the manual release guide](../docs/RELEASES.md).
Describe checks, compatibility choices and any unverified behavior in the pull request.
