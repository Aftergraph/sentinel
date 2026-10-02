// Single-writer election for the GitHub App slice.
//
// Two Sentinel instances polling the same installation through the same App
// will post duplicate PR comments and duplicate check runs for every head, and
// neither instance can see the other's local state, so no amount of local
// de-duplication fixes it. On 2026-10-02 both vds:8788 and vps:8787 were
// running this poller against Aftergraph/sentinel simultaneously.
//
// GitHub itself is the coordination point: it is the one store both instances
// already reach, and the App already holds `contents: read`. The canonical
// instance is named in a small file tracked in a repo; every instance re-reads
// it before each cycle and stands down unless it is named.
//
// Deliberately fail-closed: if an owner file is configured but cannot be read
// or parsed, the instance stands down rather than assuming it is the owner. A
// reviewer that cannot prove it is the single writer must not act as one.
import { hostname } from "node:os";

export const DEFAULT_OWNER_FILE = "Aftergraph/sentinel:sentinel-owner.json:main";
export const DEFAULT_INSTANCE_ID = null; // resolved to hostname at call time

// "owner/repo:path@ref" -> { repo, path, ref }
export function parseOwnerSpec(spec) {
  if (typeof spec !== "string" || !spec.trim()) return null;
  const at = spec.lastIndexOf("@");
  const ref = at > -1 ? spec.slice(at + 1) : "main";
  const withoutRef = at > -1 ? spec.slice(0, at) : spec;
  const colon = withoutRef.indexOf(":");
  const repo = colon > -1 ? withoutRef.slice(0, colon) : withoutRef;
  const path = colon > -1 ? withoutRef.slice(colon + 1) : "sentinel-owner.json";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !path) return null;
  return { repo, path, ref };
}

export function instanceIdOf(explicit) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  try {
    return hostname();
  } catch {
    return "unknown-host";
  }
}

/**
 * Decide whether this process may act as the single writer.
 * Returns { enabled, isOwner, owner, instanceId, reason }.
 * `enabled:false` means no owner file is configured — the pre-election
 * behaviour, kept so a single-instance deployment is unaffected.
 */
export async function resolveOwnership({ platform, ownerSpec, instanceId } = {}) {
  const self = instanceIdOf(instanceId);
  const parsed = parseOwnerSpec(ownerSpec);
  if (!parsed) {
    return { enabled: false, isOwner: true, owner: null, instanceId: self, reason: "no owner file configured" };
  }
  if (!platform || typeof platform.getFileContent !== "function") {
    return { enabled: true, isOwner: false, owner: null, instanceId: self, reason: "platform cannot read the owner file (fail closed)" };
  }

  let raw;
  try {
    raw = await platform.getFileContent(parsed.repo, parsed.path, parsed.ref);
  } catch (err) {
    return {
      enabled: true, isOwner: false, owner: null, instanceId: self,
      reason: `cannot read owner file ${parsed.repo}:${parsed.path}@${parsed.ref} (fail closed): ${err?.message || err}`,
    };
  }

  let owner;
  try {
    const parsedJson = JSON.parse(raw);
    owner = parsedJson && typeof parsedJson.owner === "string" ? parsedJson.owner.trim() : null;
  } catch (err) {
    return {
      enabled: true, isOwner: false, owner: null, instanceId: self,
      reason: `owner file is not valid JSON (fail closed): ${err?.message || err}`,
    };
  }
  if (!owner) {
    return {
      enabled: true, isOwner: false, owner: null, instanceId: self,
      reason: `owner file has no "owner" field (fail closed): ${parsed.repo}:${parsed.path}`,
    };
  }
  return {
    enabled: true,
    isOwner: owner === self,
    owner,
    instanceId: self,
    reason: owner === self
      ? `this instance owns the review loop (${self})`
      : `another instance owns the review loop (${owner}); this instance is ${self}`,
  };
}
