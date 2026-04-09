#!/bin/bash
# PostToolUse hook for Edit/Write: detect when source files change and remind to rebuild.
# The kg CLI uses tsx (no build step needed), but if someone does `npm run build`
# for the dist/ output, this flags that dist/ is stale.

# Read the tool input from stdin
INPUT=$(cat)

# Extract the file path from the tool input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$FILE_PATH" ] && exit 0

# Only care about TypeScript source files in this repo
KG_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
case "$FILE_PATH" in
  "$KG_DIR"/src/*.ts)
    # Check if dist/ exists and is now stale
    if [ -d "$KG_DIR/dist" ]; then
      echo '{"hookSpecificOutput":{"additionalContext":"<kg-rebuild-reminder>Source files changed. Run `cd ~/src/knowledge-graph && npm run build` to update dist/ if needed. The kg CLI uses tsx directly so it picks up changes immediately.</kg-rebuild-reminder>"}}'
    fi
    ;;
esac

exit 0
