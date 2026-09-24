#!/bin/sh
# Manually copy an already-issued certificate to an offline Planner server.
# Usage: sh deploy/deploy-renewed-cert.sh DOMAIN FULLCHAIN KEY SSH_TARGET SSH_KEY
set -eu

if [ "$#" -ne 5 ]; then
    echo 'Usage: deploy-renewed-cert.sh DOMAIN FULLCHAIN KEY SSH_TARGET SSH_KEY' >&2
    exit 2
fi
domain=$1
fullchain=$2
private_key=$3
target=$4
ssh_key=$5
ssh_config=${PLANNER_SSH_CONFIG:-/dev/null}

ssh_remote() {
    ssh -F "$ssh_config" -i "$ssh_key" -o BatchMode=yes -o ConnectTimeout=10 "$target" "$@"
}

host_check=$(openssl x509 -in "$fullchain" -noout -checkhost "$domain")
if [ "$host_check" != "Hostname $domain does match certificate" ]; then
    echo 'Certificate does not cover the requested domain' >&2
    exit 1
fi
openssl x509 -in "$fullchain" -noout -checkend 604800 >/dev/null
cert_public=$(openssl x509 -in "$fullchain" -pubkey -noout | openssl dgst -sha256)
key_public=$(openssl pkey -in "$private_key" -pubout 2>/dev/null | openssl dgst -sha256)
if [ "$cert_public" != "$key_public" ]; then
    echo 'Certificate and private key do not match' >&2
    exit 1
fi

local_fingerprint=$(openssl x509 -in "$fullchain" -noout -fingerprint -sha256)
remote_fingerprint=$(ssh_remote 'sudo -n openssl x509 -in /etc/ssl/semester-planner/fullchain.pem -noout -fingerprint -sha256' 2>/dev/null || true)
if [ "$local_fingerprint" = "$remote_fingerprint" ]; then
    echo 'Server already has this certificate.'
    exit 0
fi

stage=$(ssh_remote 'mktemp -d /tmp/planner-tls.XXXXXX')
if ! printf '%s\n' "$stage" | LC_ALL=C grep -Eq '^/tmp/planner-tls\.[A-Za-z0-9]{6}$'; then
    echo 'Unexpected server staging path' >&2
    exit 1
fi
cleanup() { ssh_remote "rm -rf -- '$stage'" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
scp -F "$ssh_config" -i "$ssh_key" -o BatchMode=yes -o ConnectTimeout=10 \
    "$fullchain" "$target:$stage/fullchain.pem"
scp -F "$ssh_config" -i "$ssh_key" -o BatchMode=yes -o ConnectTimeout=10 \
    "$private_key" "$target:$stage/privkey.pem"

ssh_remote "sh -s -- '$stage'" <<'REMOTE'
set -eu
stage=$1
cert_dir=/etc/ssl/semester-planner
sudo -n cp -a "$cert_dir/fullchain.pem" "$cert_dir/fullchain.pem.previous"
sudo -n cp -a "$cert_dir/privkey.pem" "$cert_dir/privkey.pem.previous"
if sudo -n install -m 644 -o root -g root "$stage/fullchain.pem" "$cert_dir/fullchain.pem" &&
   sudo -n install -m 600 -o root -g root "$stage/privkey.pem" "$cert_dir/privkey.pem" &&
   sudo -n nginx -t && sudo -n systemctl reload nginx; then
    echo 'Planner TLS certificate deployed.'
else
    sudo -n cp -a "$cert_dir/fullchain.pem.previous" "$cert_dir/fullchain.pem"
    sudo -n cp -a "$cert_dir/privkey.pem.previous" "$cert_dir/privkey.pem"
    sudo -n nginx -t
    sudo -n systemctl reload nginx
    exit 1
fi
REMOTE
