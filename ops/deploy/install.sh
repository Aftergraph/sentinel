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

# This script runs as root and copies whatever sits in REPO_SRC into /opt, which
# systemd then executes as the service account. Without an ownership check, any
# unprivileged account that can write the checkout — including the CI runner
# account via the `sentinel-deploy install` verb — becomes root by writing an
# apps/github/app.js and asking for it to be installed. Refuse a checkout the
# invoking user can modify.
require_trusted_source() {
  local owner
  owner="$(stat -c '%U' "${REPO_SRC}" 2>/dev/null || echo unknown)"
  if [[ "${owner}" != "root" ]]; then
    echo "refusing to install from a checkout owned by '${owner}': ${REPO_SRC}" >&2
    echo "a root-privileged copy must not read a user-writable tree." >&2
    echo "clone as root (e.g. /root/sentinel-src) and run this from there." >&2
    exit 1
  fi
  if [[ -n "$(find "${REPO_SRC}/apps" "${REPO_SRC}/lib" "${REPO_SRC}/ops" \
        -user "$(id -u nobody 2>/dev/null || echo 65534)" -print -quit 2>/dev/null)" ]]; then
    echo "refusing to install: files under ${REPO_SRC} are not all root-owned" >&2
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

# Fail before touching the host when a credential the service needs is already
# known to be wrong. Previously the installer validated nothing but root and the
# Node version, so a missing key or a taken port was discovered only as a
# crash-looping unit after the fact.
check_prerequisites() {
  local key="${ETC}/github-app.pem" env_file="${ETC}/github-app.env" port
  if [[ ! -f "${key}" ]]; then
    echo "note: ${key} is absent — the service will fail closed until it exists" >&2
  else
    local mode owner
    mode="$(stat -c '%a' "${key}")"
    owner="$(stat -c '%U:%G' "${key}")"
    if [[ "${mode}" != "640" || "${owner}" != "root:sentinel" ]]; then
      echo "refusing: ${key} is ${owner} ${mode}; expected root:sentinel 0640" >&2
      exit 1
    fi
  fi
  if [[ -f "${env_file}" ]]; then
    local app_id
    app_id="$(awk -F= '$1=="GITHUB_APP_ID" {print $2; exit}' "${env_file}" 2>/dev/null || true)"
    if [[ -n "${app_id}" && ! "${app_id}" =~ ^[0-9]+$ ]]; then
      echo "refusing: GITHUB_APP_ID in ${env_file} is not numeric ('${app_id}')" >&2
      exit 1
    fi
    port="$(awk -F= '$1=="PORT" {print $2; exit}' "${env_file}" 2>/dev/null || true)"
    port="${port:-8787}"
    # On a redeploy the running unit itself holds the port; only warn otherwise.
    if ! systemctl is-active --quiet "${UNIT}" 2>/dev/null \
        && command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE "[:.]${port}[[:space:]]"; then
      echo "warning: PORT ${port} from ${env_file} is already in use; set a free port" >&2
    fi
  fi
}

require_root
require_trusted_source
check_node
check_prerequisites

id -u sentinel >/dev/null 2>&1 || useradd --system --home "${TARGET}" --shell /usr/sbin/nologin sentinel

install -d -o sentinel -g sentinel -m 0750 "${TARGET}" "${STATE}"
install -d -o root -g sentinel -m 0750 "${ETC}"

# Ship the runtime slices only; tests, bench and site stay out of /opt.
for path in apps lib mcp bin policies package.json; do
  cp -a "${REPO_SRC}/${path}" "${TARGET}/"
done
# Code stays root-owned and read-only to the service account. The earlier
# `chown -R sentinel:sentinel "${TARGET}"` let the running process rewrite its
# own apps/ and lib/, so anything that reached the webhook path persisted across
# restarts. Only ${STATE} is writable at runtime.
chown -R root:root "${TARGET}"
find "${TARGET}" -type d -exec chmod 0755 {} +
find "${TARGET}" -type f -exec chmod 0644 {} +

if [[ ! -f "${ETC}/github-app.env" ]]; then
  install -o root -g sentinel -m 0640 "${REPO_SRC}/ops/deploy/github-app.env.example" "${ETC}/github-app.env"
  echo "wrote ${ETC}/github-app.env from the example; fill it before starting"
fi

install -m 0644 "${REPO_SRC}/ops/deploy/${UNIT}" "/etc/systemd/system/${UNIT}"
systemctl daemon-reload

# Validate the unit before enabling it, so a typo'd directive fails the install
# instead of surfacing as a unit that silently fails to start later.
# Fail on verify's exit status only. The previous form piped through `grep -v`
# under `!`, which inverted the result: a clean unit (no output) made grep exit
# 1 and failed the install, while a broken unit with any output passed.
if command -v systemd-analyze >/dev/null 2>&1; then
  verify_rc=0
  verify_out="$(systemd-analyze verify "/etc/systemd/system/${UNIT}" 2>&1)" || verify_rc=$?
  if [[ -n "${verify_out}" ]]; then
    printf '%s\n' "${verify_out}" | grep -vE '^$' >&2 || true
  fi
  if [[ "${verify_rc}" -ne 0 ]]; then
    echo "unit ${UNIT} failed systemd-analyze verify (exit ${verify_rc})" >&2
    exit 1
  fi
fi

# Keep the root-owned deploy wrapper in step with this revision. install.sh
# already runs as root from the checkout, so this adds no new trust; it only
# saves a manual re-run of install-deploy-sudo.sh when the wrapper gains a verb.
if [[ -e /usr/local/sbin/sentinel-deploy ]]; then
  install -o root -g root -m 0755 "${REPO_SRC}/ops/deploy/sentinel-deploy" /usr/local/sbin/sentinel-deploy
fi
systemctl enable "${UNIT}"

# Pick up new code now rather than leaving the previous revision running until
# someone notices. Previously the installer enabled the unit and stopped, so
# `install.sh && systemctl status` could report the OLD revision as healthy.
if systemctl is-active --quiet "${UNIT}"; then
  systemctl restart "${UNIT}"
  echo "restarted ${UNIT} onto this revision"
fi

echo
echo "installed. next:"
echo "  1. fill ${ETC}/github-app.env (webhook secret + App ID or token)"
echo "  2. place the App private key at ${ETC}/github-app.pem (root:sentinel, 0640)"
echo "  3. systemctl start ${UNIT} && systemctl status ${UNIT}"
echo "  4. point the Cloudflare Tunnel at 127.0.0.1:${PORT:-8787} from ${ETC}/github-app.env"
echo "     (the service binds loopback by default; set SENTINEL_BIND_HOST only if"
echo "     you have a specific reason, and never 0.0.0.0 on a public host)"
