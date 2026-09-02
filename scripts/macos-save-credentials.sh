#!/bin/zsh
set -euo pipefail

ACCOUNT_NAME="${USER:-librus-user}"

read "LIBRUS_EMAIL?E-mail Konta LIBRUS: "
read -s "LIBRUS_PASSWORD?Hasło Konta LIBRUS: "
print

if [[ -z "$LIBRUS_EMAIL" || -z "$LIBRUS_PASSWORD" ]]; then
  print -u2 "E-mail i hasło nie mogą być puste."
  exit 1
fi

/usr/bin/security add-generic-password -U -a "$ACCOUNT_NAME" -s librus-readonly-mcp-email -w "$LIBRUS_EMAIL"
/usr/bin/security add-generic-password -U -a "$ACCOUNT_NAME" -s librus-readonly-mcp-password -w "$LIBRUS_PASSWORD"
unset LIBRUS_PASSWORD

print "Dane zapisano w pęku kluczy macOS."
