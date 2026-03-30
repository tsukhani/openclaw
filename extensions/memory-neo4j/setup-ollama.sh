#!/usr/bin/env bash
# Setup Ollama with the default embedding model for memory-neo4j.
#
# Usage:
#   bash setup-ollama.sh
#
# Prerequisites:
#   - Ollama installed (https://ollama.com)
#   - Ollama server running (`ollama serve` or system service)

set -euo pipefail

EMBEDDING_MODEL="${1:-mxbai-embed-large}"

echo "memory-neo4j: pulling embedding model '$EMBEDDING_MODEL'..."
ollama pull "$EMBEDDING_MODEL"

echo ""
echo "Done. Configure the plugin with:"
echo ""
echo '  "embedding": {'
echo '    "provider": "ollama",'
echo "    \"model\": \"$EMBEDDING_MODEL\","
echo '    "baseUrl": "http://localhost:11434"'
echo '  }'
