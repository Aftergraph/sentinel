#!/usr/bin/env bash
# Install the Sentinel GitHub App as a systemd service on a Debian/Ubuntu VDS.
# Idempotent: safe to re-run after a git pull.
#
#   sudo ops/deploy/install.sh
#
# Leaves /etc/sentinel/github-app.env for the operator to fill: the App ID,
# webhook secret and private key come from the GitHub App registration and
# are never in this repo.
set -euo pipefail

REPO_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET=/opt/sentinel
ETC=/etc/sentinel
STATE=/var/lib/sentinel
UNIT=sentinel-github-app.service

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "run as root (sudo ops/deploy/install.sh)" >&2
    exit 1
  fi
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node is not installed; Sentinel needs Node 20 or newer" >&2
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major < 20 )); then
    echo "node ${major} is too old; Sentinel needs Node 20 or newer" >&2
    exit 1
  fi
}

require_root
check_node

id -u sentinel >/dev/null 2>&1 || useradd --system --home "${TARGET}" --shell /usr/sbin/nologin sentinel

install -d -o sentinel -g sentinel -m 0750 "${TARGET}" "${STATE}"
install -d -o root -g sentinel -m 0750 "${ETC}"

# Ship the runtime slices only; tests, bench and site stay out of /opt.
for path in apps lib mcp bin policies package.json; do
  cp -a "${REPO_SRC}/${path}" "${TARGET}/"
done
chown -R sentinel:sentinel "${TARGET}"

if [[ ! -f "${ETC}/github-app.env" ]]; then
  install -o root -g sentinel -m 0640 "${REPO_SRC}/ops/deploy/github-app.env.example" "${ETC}/github-app.env"
  echo "wrote ${ETC}/github-app.env from the example; fill it before starting"
fi

install -m 0644 "${REPO_SRC}/ops/deploy/${UNIT}" "/etc/systemd/system/${UNIT}"
systemctl daemon-reload
systemctl enable "${UNIT}"

echo
echo "installed. next:"
echo "  1. fill ${ETC}/github-app.env (webhook secret + App ID or token)"
echo "  2. place the App private key at ${ETC}/github-app.pem (root:sentinel, 0640)"
echo "  3. systemctl start ${UNIT} && systemctl status ${UNIT}"
echo "  4. point the Cloudflare Tunnel at the PORT set above in ${ETC}/github-app.env"
echo " (the example ships PORT=8787; 8787 is commonly taken by other local"
echo "     services, so check with 'ss -ltn' before assuming it is free)"
