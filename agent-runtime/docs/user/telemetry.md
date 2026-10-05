# Product usage data

Cinderdeck builds have no inherited telemetry destination or cloud account. Runtime product telemetry is disabled by default, and packaging clears the former product’s analytics and relay configuration.

The optional analytics service can record provider, model, reasoning effort, permission mode, turn result, duration and main-agent token totals when deliberately configured by a maintainer. It excludes prompts, responses, file contents, credentials, conversation IDs, raw provider events and child-agent output. `DECKHAND_TELEMETRY_ENABLED=false` disables that service in a development runtime.

Local diagnostic logs remain available for troubleshooting. Review a diagnostics report before sharing it; nothing is uploaded automatically.
