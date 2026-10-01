import { parseCommand } from "./commands.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  requiredEconomicWorkflows,
  aggregateEconomicWorkflowRuns,
  postEconomicEvidenceCheck,
} from "./economic-checks.js";
import {
  economicEvidenceEnvelopePaths,
  verifyEconomicEvidenceEnvelope,
} from "./economic-evidence.js";

export function defaultPollStatePath() {
  return join(homedir(), ".sentinel", "github-poll-state.json");
}

function pollStatePath(opts = {}) {
  if (typeof opts.pollStatePath === "string") return opts.pollStatePath;
  if (typeof opts.storePath === "string") return join(dirname(opts.storePath), "github-poll-state.json");
  return defaultPollStatePath();
}

function loadState(path) {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("poll state is not an object");
    }
    return value;
  } catch (err) {
    throw new Error("github poll state invalid (" + path + "): " + err.message);
  }
}

function saveState(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

function key(repo, prNumber) {
  return repo + "#" + String(prNumber);
}

function economicFingerprint(required, aggregate, evidenceVerification) {
  return JSON.stringify({
    required,
    rows: aggregate?.rows ?? [],
    ready: aggregate?.ready ?? false,
    success: aggregate?.success ?? false,
    failed: aggregate?.failed ?? false,
    evidenceState: evidenceVerification?.state ?? null,
    evidenceValid: evidenceVerification?.valid ?? null,
    evidenceReasons: evidenceVerification?.reasons ?? [],
  });
}

function allowedRepo(repo, opts) {
  const allow = opts.pollRepos;
  if (!Array.isArray(allow) || allow.length === 0) return true;
  return allow.includes(repo);
}

export async function pollGitHubInstallationOnce({
  platform,
  opts = {},
  routePullRequest,
} = {}) {
  if (!platform || typeof platform.listInstallationRepositories !== "function") {
    throw new Error("github poller requires listInstallationRepositories (fail closed)");
  }
  if (typeof platform.listOpenPRs !== "function") {
    throw new Error("github poller requires listOpenPRs (fail closed)");
  }
  if (typeof routePullRequest !== "function") {
    throw new Error("github poller requires routePullRequest (fail closed)");
  }

  const path = pollStatePath(opts);
  const state = loadState(path);
  const repositories = await platform.listInstallationRepositories();
  const summary = {
    repositories: 0,
    prs: 0,
    reviewed: 0,
    evidenceChecks: 0,
    pendingEvidence: 0,
    errors: [],
  };

  for (const repoInfo of repositories) {
    const repo = repoInfo?.full_name;
    if (typeof repo !== "string" || !repo || !allowedRepo(repo, opts)) continue;
    summary.repositories += 1;

    let prs;
    try {
      prs = await platform.listOpenPRs(repo);
    } catch (err) {
      summary.errors.push(repo + ":list_prs:" + String(err?.message || err));
      continue;
    }

    for (const pr of prs) {
      const prNumber = pr?.number;
      const headSha = pr?.head?.sha;
      const baseSha = pr?.base?.sha;
      if (!prNumber || typeof headSha !== "string" || typeof baseSha !== "string") {
        summary.errors.push(repo + ":malformed_pr");
        continue;
      }
      summary.prs += 1;
      const k = key(repo, prNumber);
      const prior = state[k] ?? {};

      try {
        if (prior.headSha !== headSha) {
          await routePullRequest({
            event: "pull_request",
            payload: {
              action: prior.headSha ? "synchronize" : "opened",
              repository: { full_name: repo },
              pull_request: { number: prNumber },
            },
            platform,
            opts: { ...opts, knownInstallationRepos: [repo] },
          });
          summary.reviewed += 1;
        }

        // PR commands without an issue_comment subscription: read the PR
        // conversation each poll and route new @sentinel comments. The first
        // sighting only records a baseline so history is never replayed.
        let lastCommentId = prior.lastCommentId ?? null;
        if (typeof platform.listComments === "function") {
          const comments = await platform.listComments(repo, prNumber);
          const list = Array.isArray(comments) ? comments : [];
          const maxId = list.reduce((m, c) => (Number(c?.id) > m ? Number(c.id) : m), Number(lastCommentId) || 0);
          if (lastCommentId !== null) {
            const fresh = list
              .filter((c) => Number(c?.id) > Number(lastCommentId) && parseCommand(c?.body))
              .sort((a, b) => Number(a.id) - Number(b.id));
            for (const comment of fresh) {
              await routePullRequest({
                event: "issue_comment",
                payload: {
                  action: "created",
                  repository: { full_name: repo },
                  issue: { number: prNumber, pull_request: {} },
                  comment,
                },
                platform,
                opts: { ...opts, knownInstallationRepos: [repo] },
              });
              summary.commands = (summary.commands || 0) + 1;
            }
          }
          lastCommentId = maxId;
        }

        const diffText = await platform.getDiff(repo, prNumber);
        const required = requiredEconomicWorkflows(diffText);
        let nextEconomicFingerprint = null;

        if (required.length > 0) {
          if (typeof platform.listWorkflowRunsForHead !== "function") {
            throw new Error("platform missing listWorkflowRunsForHead");
          }
          const workflowRuns = await platform.listWorkflowRunsForHead(repo, headSha);
          const aggregate = aggregateEconomicWorkflowRuns({ required, workflowRuns, headSha });

          let evidenceVerification = null;
          if (aggregate.ready && aggregate.success) {
            const envelopePaths = economicEvidenceEnvelopePaths(diffText);
            if (envelopePaths.length > 0) {
              evidenceVerification = await verifyEconomicEvidenceEnvelope({
                repo,
                headSha,
                diffText,
                platform,
              });
            }
          }

          nextEconomicFingerprint = economicFingerprint(required, aggregate, evidenceVerification);

          if (aggregate.ready && nextEconomicFingerprint !== prior.economicFingerprint) {
            if (typeof platform.createCheckRun !== "function" || typeof platform.updateCheckRun !== "function") {
              throw new Error("platform missing check-run API");
            }
            const check = await postEconomicEvidenceCheck({
              api: platform,
              repo,
              prNumber,
              headSha,
              aggregate,
              evidenceVerification,
              opts,
            });
            if (check.posted) summary.evidenceChecks += 1;
          } else if (!aggregate.ready) {
            summary.pendingEvidence += 1;
          }
        }

        state[k] = {
          headSha,
          baseSha,
          economicFingerprint: nextEconomicFingerprint,
          lastCommentId,
          observedAt: new Date().toISOString(),
        };
      } catch (err) {
        summary.errors.push(repo + "#" + String(prNumber) + ":" + String(err?.message || err));
        continue;
      }
    }
  }

  saveState(path, state);
  return summary;
}

export function startGitHubInstallationPoller({
  platform,
  opts = {},
  routePullRequest,
  intervalMs = 30_000,
  onResult = () => {},
  onError = () => {},
} = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 5_000) {
    throw new Error("github poll interval must be an integer >= 5000ms");
  }

  let stopped = false;
  let running = false;
  let timer = null;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await pollGitHubInstallationOnce({ platform, opts, routePullRequest });
      onResult(result);
    } catch (err) {
      onError(err);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, 0);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
