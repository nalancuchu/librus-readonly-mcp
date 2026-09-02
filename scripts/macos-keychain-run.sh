#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
ACCOUNT_NAME="${USER:-librus-user}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LIBRUS_PORTAL_EMAIL="$(/usr/bin/security find-generic-password -a "$ACCOUNT_NAME" -s librus-readonly-mcp-email -w)"
export LIBRUS_PORTAL_PASSWORD="$(/usr/bin/security find-generic-password -a "$ACCOUNT_NAME" -s librus-readonly-mcp-password -w)"
export LIBRUS_ATTACHMENT_DIR="${LIBRUS_ATTACHMENT_DIR:-$HOME/Documents/LibrusAttachments}"

NODE_COMMAND="${LIBRUS_NODE_BINARY:-$(command -v node || true)}"
if [[ -z "$NODE_COMMAND" ]]; then
  print -u2 "Nie znaleziono Node.js. Zainstaluj Node 22 lub ustaw LIBRUS_NODE_BINARY."
  exit 1
fi

exec "$NODE_COMMAND" "$PROJECT_DIR/src/server.js"
