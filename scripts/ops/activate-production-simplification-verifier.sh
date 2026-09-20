#!/usr/bin/env bash
set -euo pipefail
umask 077

EXPECTED_HOST="${SENTINEL_EXPECTED_HOST:-vmi3517816}"
SENTINEL_REVISION="${SENTINEL_REVISION:-3189785fc8ce866244c51f9611f93d19c191331c}"
SENTINEL_REPO_URL="${SENTINEL_REPO_URL:-https://github.com/Aftergraph/sentinel.git}"
SENTINEL_ROOT="/opt/aftergraph/sentinel"
SENTINEL_STATE="/var/lib/sentinel"
SENTINEL_CONFIG_DIR="/etc/sentinel"
SENTINEL_ENV="$SENTINEL_CONFIG_DIR/sentinel.env"
SENTINEL_UNIT="/etc/systemd/system/aftergraph-sentinel.service"
SENTINEL_SERVICE="aftergraph-sentinel.service"
SENTINEL_URL="http://127.0.0.1:8787"
WORKS_ROOT="/root/works-venture"
WORKS_ENV="/etc/works/works.env"
WORKS_BRIDGE_ENV="/etc/aftergraph/v21-bridge.env"
WORKS_HELPER="$WORKS_ROOT/scripts/ops/works-verifier-credential.sh"
WORKS_SERVICE="works-api.service"
WORKS_URL="http://127.0.0.1:18191"
SKILL_DIGEST="sha256:6e2482aec50e3e5f24c751108a81a444f3706dd67265b6b174336a05c25402c5"

fail() {
  printf 'sentinel-production-activation: FAIL: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "run as root"
[[ "$(hostname -s)" == "$EXPECTED_HOST" ]] || fail "wrong host: expected $EXPECTED_HOST"
[[ "$SENTINEL_REVISION" =~ ^[a-f0-9]{40}$ ]] || fail "SENTINEL_REVISION must be a 40-character commit SHA"

for cmd in bash chown chmod cp curl date git grep install mktemp mv node npm openssl python3 readlink rm runuser stat systemctl useradd getent; do
  require_cmd "$cmd"
done

[[ -x "$WORKS_HELPER" ]] || fail "canonical WORKS verifier helper missing: $WORKS_HELPER"
[[ -f "$WORKS_ENV" && ! -L "$WORKS_ENV" ]] || fail "canonical WORKS env missing or symlinked"
[[ "$(readlink -f -- "$WORKS_ENV")" == "$WORKS_ENV" ]] || fail "canonical WORKS env redirected"
[[ "$(stat -c '%u:%g' "$WORKS_ENV")" == "0:0" ]] || fail "WORKS env must be root-owned"
systemctl is-active --quiet "$WORKS_SERVICE" || fail "$WORKS_SERVICE is not active"
curl -fsS --max-time 2 "$WORKS_URL/healthz" >/dev/null || fail "WORKS health check failed"

BACKUP_ROOT="$(mktemp -d /run/sentinel-production-activation.XXXXXX)"
STAGE=""
AUTH_HEADER=""
WORK_BODY=""
SENTINEL_BODY=""
SENTINEL_RESPONSE=""
WORK_RESPONSE=""
SOURCE_REPLACED=false
ENV_REPLACED=false
UNIT_REPLACED=false
WORKS_ACTIVATED=false
HAD_SOURCE=false
HAD_ENV=false
HAD_UNIT=false
WAS_SENTINEL_ACTIVE=false

if [[ -d "$SENTINEL_ROOT" ]]; then
  HAD_SOURCE=true
  cp -a -- "$SENTINEL_ROOT" "$BACKUP_ROOT/source"
fi
if [[ -f "$SENTINEL_ENV" ]]; then
  HAD_ENV=true
  cp -a -- "$SENTINEL_ENV" "$BACKUP_ROOT/sentinel.env"
fi
if [[ -f "$SENTINEL_UNIT" ]]; then
  HAD_UNIT=true
  cp -a -- "$SENTINEL_UNIT" "$BACKUP_ROOT/aftergraph-sentinel.service"
fi
if systemctl is-active --quiet "$SENTINEL_SERVICE" 2>/dev/null; then
  WAS_SENTINEL_ACTIVE=true
fi

cleanup_sensitive() {
  WORKS_BEARER=""
  WORKS_ENROLL_SECRET=""
  WORKS_VERIFIER_TOKEN=""
  rm -f -- "${AUTH_HEADER:-}" "${WORK_BODY:-}" "${SENTINEL_BODY:-}" "${SENTINEL_RESPONSE:-}" "${WORK_RESPONSE:-}" 2>/dev/null || true
}

rollback() {
  local rc=$?
  trap - ERR INT TERM HUP
  set +e
  cleanup_sensitive

  if [[ "$UNIT_REPLACED" == true ]]; then
    if [[ "$HAD_UNIT" == true ]]; then
      cp -a -- "$BACKUP_ROOT/aftergraph-sentinel.service" "$SENTINEL_UNIT"
    else
      rm -f -- "$SENTINEL_UNIT"
    fi
  fi
  if [[ "$ENV_REPLACED" == true ]]; then
    if [[ "$HAD_ENV" == true ]]; then
      cp -a -- "$BACKUP_ROOT/sentinel.env" "$SENTINEL_ENV"
    else
      rm -f -- "$SENTINEL_ENV"
    fi
  fi
  if [[ "$SOURCE_REPLACED" == true ]]; then
    rm -rf --one-file-system "$SENTINEL_ROOT"
    if [[ "$HAD_SOURCE" == true ]]; then
      mv -- "$BACKUP_ROOT/source" "$SENTINEL_ROOT"
    fi
  fi

  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ "$WAS_SENTINEL_ACTIVE" == true ]]; then
    systemctl restart "$SENTINEL_SERVICE" >/dev/null 2>&1 || true
  else
    systemctl stop "$SENTINEL_SERVICE" >/dev/null 2>&1 || true
  fi

  if [[ "$WORKS_ACTIVATED" == true && -f "$BACKUP_ROOT/works.env" ]]; then
    cp -a -- "$BACKUP_ROOT/works.env" "$WORKS_ENV"
    systemctl restart "$WORKS_SERVICE" >/dev/null 2>&1 || true
  fi

  [[ -z "$STAGE" ]] || rm -rf --one-file-system "$STAGE" 2>/dev/null || true
  rm -rf --one-file-system "$BACKUP_ROOT" 2>/dev/null || true
  printf 'sentinel-production-activation: rolled back after failure\n' >&2
  exit "$rc"
}
trap rollback ERR INT TERM HUP

# 1. Activate the canonical WORKS verifier credential in-place.
WORKS_STATUS_BEFORE="$("$WORKS_HELPER" status)"
case "$WORKS_STATUS_BEFORE" in
  *'"verification_ingest":"configured"'*) ;;
  *'"verification_ingest":"unconfigured"'*)
    cp -a -- "$WORKS_ENV" "$BACKUP_ROOT/works.env"
    "$WORKS_HELPER" enable >/dev/null
    WORKS_ACTIVATED=true
    ;;
  *) fail "unexpected WORKS verifier status" ;;
esac

WORKS_STATUS_AFTER="$("$WORKS_HELPER" status)"
[[ "$WORKS_STATUS_AFTER" == *'"verification_ingest":"configured"'* ]] || fail "WORKS verifier ingest did not activate"
curl -fsS --max-time 2 "$WORKS_URL/healthz" >/dev/null || fail "WORKS unhealthy after verifier activation"

# 2. Provision a dedicated unprivileged Sentinel identity and state root.
if ! getent passwd sentinel >/dev/null 2>&1; then
  useradd --system --home-dir "$SENTINEL_STATE" --shell /usr/sbin/nologin --user-group sentinel
fi
SENTINEL_ENTRY="$(getent passwd sentinel)"
IFS=: read -r _ _ _ _ _ SENTINEL_HOME SENTINEL_SHELL <<<"$SENTINEL_ENTRY"
[[ "$SENTINEL_HOME" == "$SENTINEL_STATE" ]] || fail "existing sentinel user has unexpected home"
case "$SENTINEL_SHELL" in /usr/sbin/nologin|/sbin/nologin) ;; *) fail "existing sentinel user has unsafe shell" ;; esac

install -d -o root -g root -m 0755 /opt/aftergraph "$SENTINEL_CONFIG_DIR"
install -d -o sentinel -g sentinel -m 0700 "$SENTINEL_STATE"

# 3. Stage the exact reviewed Sentinel revision and run its complete native suite
#    as the unprivileged service identity before replacing production source.
STAGE="$(mktemp -d /opt/aftergraph/.sentinel-stage.XXXXXX)"
chmod 0755 "$STAGE"
git -C "$STAGE" init -q
git -C "$STAGE" remote add origin "$SENTINEL_REPO_URL"
git -C "$STAGE" fetch --quiet --depth=1 origin "$SENTINEL_REVISION"
git -C "$STAGE" checkout --quiet --detach FETCH_HEAD
ACTUAL_REVISION="$(git -C "$STAGE" rev-parse HEAD)"
[[ "$ACTUAL_REVISION" == "$SENTINEL_REVISION" ]] || fail "staged Sentinel revision mismatch"
chown -R root:root "$STAGE"
chmod -R go-w "$STAGE"
runuser -u sentinel -- env HOME="$SENTINEL_STATE" npm --prefix "$STAGE" test >/dev/null

# 4. Build the root-only service environment. Source trusted WORKS env files
#    only inside this root process; no credential value is emitted.
set -a
# shellcheck disable=SC1090
source "$WORKS_ENV"
if [[ -f "$WORKS_BRIDGE_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$WORKS_BRIDGE_ENV"
fi
set +a

WORKS_VERIFIER_TOKEN="${WORKS_VERIFIER_TOKEN:-}"
[[ ${#WORKS_VERIFIER_TOKEN} -ge 32 ]] || fail "WORKS_VERIFIER_TOKEN is unavailable after activation"

ENV_TMP="$(mktemp "$SENTINEL_CONFIG_DIR/.sentinel.env.XXXXXX")"
{
  printf 'SENTINEL_WORKS_URL=%s\n' "$WORKS_URL"
  printf 'SENTINEL_WORKS_VERIFIER_TOKEN=%s\n' "$WORKS_VERIFIER_TOKEN"
  printf 'SENTINEL_DOMAIN_VERIFIER_REF=sentinel:simplification\n'
  printf 'SENTINEL_DOMAIN_VERIFICATION_STORE=%s/verification.json\n' "$SENTINEL_STATE"
  printf 'SENTINEL_LEDGER=%s/ledger.jsonl\n' "$SENTINEL_STATE"
} >"$ENV_TMP"
chown root:root "$ENV_TMP"
chmod 0600 "$ENV_TMP"
mv -f -- "$ENV_TMP" "$SENTINEL_ENV"
ENV_REPLACED=true

# 5. Atomically switch the exact source revision.
SOURCE_REPLACED=true
if [[ -d "$SENTINEL_ROOT" ]]; then
  rm -rf --one-file-system "$SENTINEL_ROOT"
fi
mv -- "$STAGE" "$SENTINEL_ROOT"
STAGE=""
chown -R root:root "$SENTINEL_ROOT"
chmod -R go-w "$SENTINEL_ROOT"

NODE_BIN="$(command -v node)"
[[ "$NODE_BIN" == /* ]] || fail "node binary must resolve to an absolute path"

UNIT_TMP="$(mktemp /etc/systemd/system/.aftergraph-sentinel.service.XXXXXX)"
cat >"$UNIT_TMP" <<UNIT
[Unit]
Description=Aftergraph Sentinel independent verification service
After=network-online.target works-api.service
Wants=network-online.target
Requires=works-api.service

[Service]
Type=simple
User=sentinel
Group=sentinel
WorkingDirectory=$SENTINEL_ROOT
EnvironmentFile=$SENTINEL_ENV
ExecStart=$NODE_BIN $SENTINEL_ROOT/bin/sentinel.js serve --host 127.0.0.1 --port 8787
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=$SENTINEL_STATE

[Install]
WantedBy=multi-user.target
UNIT
chown root:root "$UNIT_TMP"
chmod 0644 "$UNIT_TMP"
mv -f -- "$UNIT_TMP" "$SENTINEL_UNIT"
UNIT_REPLACED=true

systemctl daemon-reload
systemctl enable "$SENTINEL_SERVICE" >/dev/null
systemctl restart "$SENTINEL_SERVICE"

SENTINEL_HEALTHY=false
for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 "$SENTINEL_URL/api/healthz" >/dev/null 2>&1; then
    SENTINEL_HEALTHY=true
    break
  fi
  sleep 0.5
done
[[ "$SENTINEL_HEALTHY" == true ]] || fail "Sentinel failed to become healthy"
systemctl is-active --quiet "$SENTINEL_SERVICE" || fail "Sentinel service is not active"

# 6. Enroll a short-lived WORKS caller without exposing the enrollment secret
#    or bearer in argv, logs, source or persistent config.
WORKS_ENROLL_SECRET="${WORKS_ENROLL_SECRET:-}"
[[ ${#WORKS_ENROLL_SECRET} -ge 1 ]] || fail "WORKS_ENROLL_SECRET unavailable in canonical service env"
ENROLL_BODY="$(python3 -c 'import json,sys; print(json.dumps({"worker_id":"wrkr_sentinel_verifier","challenge":sys.stdin.read()}))' <<<"$WORKS_ENROLL_SECRET")"
ENROLL_RESPONSE="$(printf '%s' "$ENROLL_BODY" | curl -fsS --max-time 5 -X POST   -H 'Content-Type: application/json' --data-binary @- "$WORKS_URL/v1/workers/enroll")"
WORKS_BEARER="$(printf '%s' "$ENROLL_RESPONSE" | python3 -c 'import json,sys; d=json.load(sys.stdin); v=d.get("token",""); assert isinstance(v,str) and v; print(v,end="")')"
ENROLL_BODY=""
ENROLL_RESPONSE=""

AUTH_HEADER="$(mktemp /run/sentinel-work-auth.XXXXXX)"
printf 'Authorization: Bearer %s\n' "$WORKS_BEARER" >"$AUTH_HEADER"
chmod 0600 "$AUTH_HEADER"

# 7. Create a real, harmless WORKS execution and wait for it to become terminal.
WORK_BODY="$(mktemp /run/sentinel-verification-work.XXXXXX.json)"
cat >"$WORK_BODY" <<'JSON'
{
  "queue": true,
  "source": {"type": "cli"},
  "objective": {
    "type": "verify_change",
    "description": "Sentinel live code-simplification verification proof"
  },
  "graph": {
    "nodes": {
      "verify": {
        "id": "verify",
        "run": "true"
      }
    }
  },
  "requirements": {"os": "linux"},
  "policy": {"production_access": false}
}
JSON
WORK_RESPONSE="$(mktemp /run/sentinel-verification-work-response.XXXXXX.json)"
CREATE_STATUS="$(curl -sS --max-time 10 -o "$WORK_RESPONSE" -w '%{http_code}' -X POST   -H @"$AUTH_HEADER" -H 'Content-Type: application/json' --data-binary @"$WORK_BODY" "$WORKS_URL/v1/works")"
[[ "$CREATE_STATUS" == "201" ]] || fail "WORKS proof work creation returned HTTP $CREATE_STATUS"
WORK_ID="$(python3 - "$WORK_RESPONSE" <<'PY'
import json,sys,re
v=json.load(open(sys.argv[1])).get("id","")
assert re.fullmatch(r"wrk_[a-f0-9]{32}",v)
print(v,end="")
PY
)"

WORK_STATE=""
for _ in $(seq 1 120); do
  WORK_STATE="$(curl -fsS --max-time 3 -H @"$AUTH_HEADER" "$WORKS_URL/v1/works/$WORK_ID"     | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state",""),end="")')"
  case "$WORK_STATE" in
    SUCCEEDED) break ;;
    FAILED|CANCELLED) fail "WORKS proof execution became terminal with state $WORK_STATE" ;;
  esac
  sleep 0.5
done
[[ "$WORK_STATE" == "SUCCEEDED" ]] || fail "WORKS proof execution did not reach SUCCEEDED"

# 8. Submit the real 10-task simplification benchmark claim through the live
#    Sentinel runtime. The independent GitHub observer resolves the exact
#    public Actions evidence itself.
OBSERVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SENTINEL_BODY="$(mktemp /run/sentinel-simplification-claim.XXXXXX.json)"
python3 - "$WORK_ID" "$OBSERVED_AT" "$SKILL_DIGEST" "$SENTINEL_BODY" <<'PY'
import json,sys
work_id,observed_at,skill_digest,path=sys.argv[1:]
refs={
  "exact-revision-evidence":"https://github.com/Aftergraph/war-room/actions/runs/35478850558#proof=exact-revision-evidence",
  "repository-native-gates-pass":"https://github.com/Aftergraph/war-room/actions/runs/35478852092#proof=repository-native-gates-pass",
  "behavior-preserved":"https://github.com/Aftergraph/war-room/actions/runs/35478850558#proof=behavior-preserved&step=Canonical%20%2B%20semantic%20equivalence",
  "canonical-owner-preserved":"https://github.com/Aftergraph/war-room/actions/runs/35478852092#proof=canonical-owner-preserved",
}
body={
  "claim":{
    "schema":"aftergraph.code-simplification-output/1.1",
    "repository":"Aftergraph/war-room",
    "baseline_revision":"5c0baed576dda766560d2b471cd303c2b02d847a",
    "final_revision":"720283d58fcd9fea99df444ade2d6a2b06bff0a7",
    "skill_digest_sha256":skill_digest,
    "canonical_owner":"Aftergraph/war-room:desktop/web/app.js",
    "execution_status":"completed",
    "changed_paths":["desktop/web/app.js"],
    "obligations":[
      {"id":key,"claim_status":"pass","evidence_refs":[value]}
      for key,value in refs.items()
    ],
    "evidence_refs":list(refs.values()),
  },
  "missionId":work_id,
  "executorRef":"gpt-5.6-sol:simplifier",
  "observedAt":observed_at,
}
with open(path,"w",encoding="utf-8") as f:
  json.dump(body,f,separators=(",",":"))
PY

SENTINEL_RESPONSE="$(mktemp /run/sentinel-simplification-response.XXXXXX.json)"
VERIFY_STATUS="$(curl -sS --max-time 20 -o "$SENTINEL_RESPONSE" -w '%{http_code}' -X POST   -H 'Content-Type: application/json' --data-binary @"$SENTINEL_BODY"   "$SENTINEL_URL/api/simplification/verify")"
[[ "$VERIFY_STATUS" == "200" ]] || fail "Sentinel live verification returned HTTP $VERIFY_STATUS"

read -r VERDICT RECEIPT_ID < <(python3 - "$SENTINEL_RESPONSE" <<'PY'
import json,sys,re
d=json.load(open(sys.argv[1]))
verdict=d.get("verdict","")
receipt=d.get("receipt",{}).get("receiptId","")
assert verdict=="VERIFIED"
assert re.fullmatch(r"dvr_[a-f0-9]{64}",receipt)
print(verdict,receipt)
PY
)

# 9. Read the exact persisted Sentinel receipt back.
READBACK="$(curl -fsS --max-time 5 "$SENTINEL_URL/api/domain/verification/$RECEIPT_ID")"
printf '%s' "$READBACK" | python3 -c 'import json,sys; d=json.load(sys.stdin); expected=sys.argv[1]; assert d.get("receiptId")==expected and d.get("verdict")=="VERIFIED"' "$RECEIPT_ID"

# 10. Read WORKS evidence projection and require the same immutable receipt.
WORKS_EVIDENCE="$(curl -fsS --max-time 10 "$WORKS_URL/v1/works/$WORK_ID/evidence")"
printf '%s' "$WORKS_EVIDENCE" | python3 -c '
import json,sys
d=json.load(sys.stdin); expected=sys.argv[1]
v=d.get("outcome_verification") or {}
assert v.get("status")=="passed"
assert v.get("verifier_id")=="sentinel:simplification"
assert v.get("evidence_ref")==expected
' "$RECEIPT_ID"

# 11. Final fail-closed and health checks.
WRONG_TOKEN_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 -X POST   -H 'Content-Type: application/json'   -H 'X-WORKS-Verifier-Token: deliberately-wrong-final-probe-000000000000000000'   --data '{"result":"passed","verifier_id":"sentinel:final-probe","evidence_ref":"dvr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","verified_at":"2026-09-20T00:00:00Z"}'   "$WORKS_URL/v1/works/$WORK_ID/verification" || true)"
[[ "$WRONG_TOKEN_STATUS" == "401" ]] || fail "WORKS verifier boundary is not fail-closed after activation"
curl -fsS --max-time 2 "$WORKS_URL/healthz" >/dev/null
curl -fsS --max-time 2 "$SENTINEL_URL/api/healthz" >/dev/null

cleanup_sensitive
rm -rf --one-file-system "$BACKUP_ROOT"
trap - ERR INT TERM HUP

printf '{'
printf '"host":"%s",' "$EXPECTED_HOST"
printf '"sentinel_revision":"%s",' "$SENTINEL_REVISION"
printf '"sentinel_service_active":true,'
printf '"works_health":true,'
printf '"works_verifier_ingest_configured":true,'
printf '"independent_observer":"sentinel:observer:github-actions",'
printf '"simplification_verdict":"VERIFIED",'
printf '"work_id":"%s",' "$WORK_ID"
printf '"receipt_id":"%s",' "$RECEIPT_ID"
printf '"works_projection":"passed",'
printf '"wrong_token_status":401,'
printf '"credential_value_exposed":false'
printf '}\n'
