#!/usr/bin/env bash
# One-time root step on the VDS. Replaces the hand-written
# /etc/sudoers.d/sentinel-deploy with a single, validated rule.
#
#   sudo bash ops/deploy/install-deploy-sudo.sh nora
#
# The new file is checked with `visudo -cf` BEFORE it is installed, and the
# whole sudoers tree is re-checked after; an invalid file is never left in place.
set -euo pipefail

user="${1:-}"
[[ "${EUID}" -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -n "${user}" ]] || { echo "usage: $0 <runner-user>" >&2; exit 1; }
id -u "${user}" >/dev/null 2>&1 || { echo "no such user: ${user}" >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -o root -g root -m 0755 "${here}/sentinel-deploy" /usr/local/sbin/sentinel-deploy

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/sentinel-deploy\n' "${user}" > "${tmp}"
visudo -cf "${tmp}"

dest=/etc/sudoers.d/sentinel-deploy
if [[ -e "${dest}" ]]; then
  cp -a "${dest}" "${dest}.broken.$(date -u +%Y%m%dT%H%M%SZ)"
  # sudo ignores files with a '.' in their name under sudoers.d, so the backup is inert.
fi
install -o root -g root -m 0440 "${tmp}" "${dest}"
visudo -c
sudo -l -U "${user}" | grep -F /usr/local/sbin/sentinel-deploy
echo "installed ${dest} for ${user}"
