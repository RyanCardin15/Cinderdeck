#!/usr/bin/env bash
# Persistent local signing, or one-time certificate creation for release secrets.
# Usage: ./scripts/create-signing-cert.sh [--local] [cert-name] [validity-days]
set -euo pipefail
umask 077

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
LOCAL_ONLY=0
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: $0 [--local] [cert-name] [validity-days]"
  echo "--local: reuse/create a local identity without exporting or printing its private key."
  echo "Without --local: create a release identity and print an encrypted P12 for GitHub Secrets."
  exit 0
fi
if [[ "${1:-}" == "--local" ]]; then
  LOCAL_ONLY=1
  shift
fi
[[ $# -le 2 ]] || fail "Usage: $0 [--local] [cert-name] [validity-days]"
DEFAULT_NAME="Cinderdeck Self-Signed"
if [[ "$LOCAL_ONLY" == 1 ]]; then DEFAULT_NAME="Cinderdeck Local Development"; fi
CERT_NAME="${1:-$DEFAULT_NAME}"
VALIDITY_DAYS="${2:-3650}"
[[ "$(uname -s)" == Darwin ]] || fail "This script requires macOS."
# These values are inserted into an OpenSSL configuration, not shell code.
[[ "$CERT_NAME" =~ ^[a-zA-Z0-9._\ \(\)-]+$ ]] || fail "Use letters, numbers, spaces, dots, underscores, parentheses, or hyphens in the certificate name."
[[ "$VALIDITY_DAYS" =~ ^[1-9][0-9]{0,4}$ ]] || fail "Validity must be a positive number of days (at most five digits)."
KEYCHAIN="${CINDERDECK_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
[[ -f "$KEYCHAIN" ]] || fail "Keychain not found: $KEYCHAIN"

# Match the entire name, not a substring. Never rotate a local identity silently:
# a new certificate with the same display name still invalidates TCC grants.
IDENTITIES=$(security find-identity -v -p codesigning "$KEYCHAIN")
MATCHES=$(printf '%s\n' "$IDENTITIES" | awk -F '"' -v name="$CERT_NAME" '$2 == name { split($1, fields, " "); print fields[2] }')
if [[ -n "$MATCHES" ]]; then
  [[ "$MATCHES" != *$'\n'* ]] || fail "Multiple valid identities named '$CERT_NAME'; resolve the duplicate certificates in Keychain Access."
  echo "Reusing code-signing identity: $CERT_NAME ($MATCHES)"
  if [[ "$LOCAL_ONLY" == 0 ]]; then
    echo "No new certificate created. Export the existing identity from Keychain Access for release secrets."
  fi
  exit 0
fi
if security find-certificate -c "$CERT_NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  fail "A certificate named '$CERT_NAME' exists but is not a valid signing identity. Unlock the keychain and check its private key, expiry, and Code Signing trust in Keychain Access; refusing to replace it."
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
P12_PATH="$TEMP_DIR/signing-cert.p12"
echo "Creating '$CERT_NAME' in $KEYCHAIN (valid for $VALIDITY_DAYS days)."
cat > "$TEMP_DIR/cert.cfg" <<CONFIG
[ req ]
default_bits       = 2048
distinguished_name = req_dn
prompt             = no
x509_extensions    = codesign
[ req_dn ]
CN = $CERT_NAME
O  = Cinderdeck
[ codesign ]
basicConstraints = critical, CA:false
keyUsage         = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CONFIG
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$TEMP_DIR/key.pem" -out "$TEMP_DIR/cert.pem" \
  -days "$VALIDITY_DAYS" -config "$TEMP_DIR/cert.cfg" 2>/dev/null

if [[ "$LOCAL_ONLY" == 1 ]]; then
  P12_PASSWORD=$(uuidgen)
elif [[ -n "${CINDERDECK_P12_PASSWORD:-}" ]]; then
  # Supplied by setup-release-signing.sh, which uploads the export itself.
  P12_PASSWORD="$CINDERDECK_P12_PASSWORD"
else
  printf 'Password for the P12 export (SELF_SIGNED_CERT_PASSWORD): ' >&2
  read -rs P12_PASSWORD
  printf '\n' >&2
  [[ -n "$P12_PASSWORD" ]] || fail "Password cannot be empty."
fi
# macOS security import cannot read OpenSSL 3's default PKCS#12 encryption.
# Explicit compatible algorithms work with both Apple's LibreSSL and OpenSSL 3.
export P12_PASSWORD
openssl pkcs12 -export -out "$P12_PATH" \
  -inkey "$TEMP_DIR/key.pem" -in "$TEMP_DIR/cert.pem" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout env:P12_PASSWORD
security import "$P12_PATH" -P "$P12_PASSWORD" -t cert -f pkcs12 \
  -T /usr/bin/codesign -k "$KEYCHAIN"
unset P12_PASSWORD
# Trust only for code signing in the current user's domain (no admin -d).
# macOS may ask for the login password to authorize this one-time change.
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TEMP_DIR/cert.pem"
IDENTITIES=$(security find-identity -v -p codesigning "$KEYCHAIN")
MATCHES=$(printf '%s\n' "$IDENTITIES" | awk -F '"' -v name="$CERT_NAME" '$2 == name { split($1, fields, " "); print fields[2] }')
[[ -n "$MATCHES" && "$MATCHES" != *$'\n'* ]] || fail "Certificate imported, but no unique valid signing identity is available. Check Code Signing trust in Keychain Access."
echo "Code-signing identity ready: $CERT_NAME ($MATCHES)"

if [[ "$LOCAL_ONLY" == 0 ]]; then
  echo "Add SELF_SIGNED_CERT_PASSWORD and the following SELF_SIGNED_CERT_P12 to GitHub Secrets."
  echo "This encrypted export contains your private key; do not commit it or share the output."
  echo "--- BEGIN BASE64 ---"
  base64 < "$P12_PATH"
  echo "--- END BASE64 ---"
fi
