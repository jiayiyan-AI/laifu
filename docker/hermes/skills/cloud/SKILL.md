# cloud (P1 placeholder)

This file is a placeholder so `entrypoint.sh` can symlink
`/opt/hermes-skills/cloud` → `~/.hermes/skills/cloud` without
the target being empty.

The directory name (`cloud`) matches the entitlement feature key, so the
entrypoint's `for feature in $DESIRED; do TARGET="$SKILLS_SOURCE/$feature"`
loop finds it without needing a feature → directory mapping table.

The actual `cloud-publish` CLI implementation (the agent-callable tool that
publishes files to Azure Blob) lands in P3.
