#!/bin/sh

set -eu

endpoint="${R2_ENDPOINT:-http://cloudflare-r2:9000}"
bucket="${R2_BUCKET:-cinderdeck-r2-local}"
access_key="${R2_ACCESS_KEY_ID:-minioadmin}"
secret_key="${R2_SECRET_ACCESS_KEY:-minioadmin123}"

until mc alias set r2 "$endpoint" "$access_key" "$secret_key" >/dev/null 2>&1; do
  sleep 1
done

mc mb --ignore-existing "r2/$bucket" >/dev/null 2>&1
mc anonymous set public "r2/$bucket" >/dev/null 2>&1

echo "MinIO bucket ready for R2-style testing: $bucket"
