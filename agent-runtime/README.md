# Cinderdeck agent runtime

This directory contains Cinderdeck’s embedded desktop interface, backend, and mobile companion. Projects group conversations by folder. The macOS host provides capture history, app identity and whole-app updates, and manages the private desktop process.

Build the complete application with the [Cinderdeck build guide](../docs/UNIFIED_APP.md). The complete runtime source is merged through T3 Code revision `12b9845d1c5aec2bfede36b313adfc5098a2fb93`, including the previously deferred dependency, provider and companion changes. [Source provenance and ownership adaptations](upstream-integration.json) record this snapshot; live provider and device behavior requires separate validation.

The runtime incorporates MIT-licensed source originally from T3 Code. Its [original license](LICENSE), copyright notices, and bundled third-party acknowledgments are preserved.
