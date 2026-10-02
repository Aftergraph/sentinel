# Deploying the Sentinel GitHub App on a VDS

The review slice is a plain Node 20 process that receives GitHub webhooks and
owns one verdict card per PR. This page covers the host side. Cloudflare
ingress is in [cloudflare.md](cloudflare.md); nothing here opens a public port.

## What the operator has to create first

Two things cannot come from this repo, because both are minted inside GitHub
and are secrets:

1. **A GitHub App registration** (org settings, Developer settings, GitHub
   Apps). Webhook URL is the tunnel hostname plus `/webhooks/github`, and the
   webhook secret is a random string you keep. Permissions: pull requests
   read and write, contents read, checks write when
   `SENTINEL_GITHUB_CHECKS=1`. Subscribe to the `pull_request` and
   `installation` events.
2. **The App private key** (the PEM downloaded once at registration), placed
   on the host at `/etc/sentinel/github-app.pem` as `root:sentinel`, mode
   `0640`.

A PAT in `GITHUB_TOKEN` works for a first smoke test, but App credentials win
when both are present, and only App mode gives the per-installation token the
card writer expects.

## Install

```bash
git clone https://github.com/Aftergraph/sentinel.git /srv/sentinel-src
cd /srv/sentinel-src
sudo ops/deploy/install.sh
```

The script creates the `sentinel` system user, copies the runtime slices to
`/opt/sentinel`, creates `/var/lib/sentinel` for the ledger, memory and
installation store, seeds `/etc/sentinel/github-app.env` from the example, and
enables the unit. It refuses to run on Node older than 20 and never
overwrites an env file that already exists, so re-running it after a
`git pull` is safe.

## Fill the environment

`/etc/sentinel/github-app.env` needs GitHub auth (`GITHUB_APP_ID` with
`GITHUB_APP_KEY_FILE`, or `GITHUB_TOKEN`) and one of two ingress modes:

- **Webhook mode:** `GITHUB_WEBHOOK_SECRET`, equal to the secret in the GitHub
  App's webhook settings. Signed deliveries are verified; unsigned ones get 401.
- **Poll-only mode:** no secret, `SENTINEL_GITHUB_POLL=1` and GitHub App
  credentials. Sentinel polls installed repos, PRs and PR comments outbound;
  `POST /webhooks/github` always answers 503, and `/healthz` reports
  `webhookEnabled: false`.

The app still fails closed: no secret and no poll mode, or poll mode without
App credentials, exits 1 and systemd reports the unit as failed rather than
serving an unauthenticated webhook endpoint.

## Start and verify

```bash
sudo systemctl start sentinel-github-app
systemctl status sentinel-github-app
journalctl -u sentinel-github-app -f
```

A healthy boot logs `sentinel github-app listening on :8787`. Open a pull
request against any installed repo and the verdict card appears on it; the
card is patched in place on later pushes, and a HEAD that moves mid-review
produces a STALE card instead of a verdict on a superseded commit.

## Upgrading

```bash
cd /srv/sentinel-src && git pull
sudo ops/deploy/install.sh
sudo systemctl restart sentinel-github-app
```

State in `/var/lib/sentinel` survives the upgrade, so receipts keep chaining
into the same ledger.

## Deploy sudo (one-time root step)

The deploy workflow runs as the runner user (`nora` on `vps-ci-01`) and needs root for a fixed set of verbs. Those verbs live in one root-owned wrapper, `/usr/local/sbin/sentinel-deploy` (`preflight`, `install`, `restart`, `revision`, `port`, `hashes`, `diagnose`). sudo is granted for that single path, with no wildcards and no argument matching:

```bash
sudo bash ops/deploy/install-deploy-sudo.sh nora
```

The script validates the new rule with `visudo -cf` before installing it, keeps the old `/etc/sudoers.d/sentinel-deploy` as an inert `*.broken.<timestamp>` backup (sudo skips files containing a dot), re-checks the full tree with `visudo -c`, and prints the resulting `sudo -l` line. Re-run it after any change to `ops/deploy/sentinel-deploy`.
