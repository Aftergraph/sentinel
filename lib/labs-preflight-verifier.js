import { createHash } from "node:crypto";

const SHA1 = /^[a-f0-9]{40}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return "null";
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

const verifyDigest = (doc, field) => {
  const digest = String(doc?.[field] || "");
  if (!SHA256.test(digest)) return false;
  const { [field]: _ignored, ...base } = doc;
  return sha256Hex(canonicalJson(base)).toLowerCase() === digest.toLowerCase();
};

function verifyObservation(observation, reasons, prefix) {
  if (observation?.schemaVersion !== "aftergraph.labs-observation/v1") reasons.push(`${prefix}:schema`);
  if (!String(observation?.adapterId || "").trim()) reasons.push(`${prefix}:adapter_id`);
  if (!String(observation?.capability || "").trim()) reasons.push(`${prefix}:capability`);
  if (!["healthy","degraded","unhealthy","unknown"].includes(observation?.state)) reasons.push(`${prefix}:state`);
  if (observation?.authorityGranted !== false) reasons.push(`${prefix}:authority`);
  if (observation?.maximumClaim !== "OBSERVED") reasons.push(`${prefix}:claim`);
  if (!verifyDigest(observation, "observationDigest")) reasons.push(`${prefix}:digest`);
  if (observation?.subjectRevision !== undefined && !SHA1.test(String(observation.subjectRevision))) {
    reasons.push(`${prefix}:subject_revision`);
  }
}

function verifyBundle(bundle, reasons) {
  if (bundle?.schemaVersion !== "aftergraph.federated-evidence-bundle/v1") reasons.push("http_bundle:schema");
  if (!SHA256.test(String(bundle?.planDigest || ""))) reasons.push("http_bundle:plan_digest");
  if (!Array.isArray(bundle?.layers)) reasons.push("http_bundle:layers");
  if (!Array.isArray(bundle?.unresolvedTargets)) reasons.push("http_bundle:unresolved_targets");
  if (bundle?.authorityGranted !== false) reasons.push("http_bundle:authority");
  if (bundle?.verificationGranted !== false) reasons.push("http_bundle:verification_escalation");
  if (bundle?.scientificValidityGranted !== false) reasons.push("http_bundle:scientific_escalation");
  if (bundle?.maximumClaim !== "OBSERVED") reasons.push("http_bundle:claim");
  if (!verifyDigest(bundle, "bundleDigest")) reasons.push("http_bundle:digest");

  for (const layer of bundle?.layers || []) {
    if (!String(layer?.plane || "").trim()) reasons.push("http_bundle:plane");
    if (!Array.isArray(layer?.observations)) {
      reasons.push("http_bundle:observations");
      continue;
    }
    layer.observations.forEach((observation, index) =>
      verifyObservation(observation, reasons, `http_bundle:observation:${index}`)
    );
  }
}

function verifySutBinding(binding, reasons) {
  if (binding == null) return;
  if (binding?.schemaVersion !== "aftergraph.labs-sut-binding/v1") reasons.push("sut:schema");
  if (binding?.repository !== "Aftergraph/fihim-vnext") reasons.push("sut:repository");
  if (!SHA1.test(String(binding?.sourceRevision || ""))) reasons.push("sut:source_revision");
  if (!SHA256.test(String(binding?.contentDigest || ""))) reasons.push("sut:content_digest");
  if (binding?.immutableSubject !== true) reasons.push("sut:mutable");
  if (binding?.authorityGranted !== false) reasons.push("sut:authority");
  if (binding?.maximumClaim !== "OBSERVED") reasons.push("sut:claim");
  if (!verifyDigest(binding, "bindingDigest")) reasons.push("sut:digest");

  const parse = (value) => {
    const match = String(value || "").replace(/^v/, "").match(/^(\d+)\.(\d+)(?:\.|$)/);
    return match ? `${match[1]}.${match[2]}` : null;
  };
  const requested = parse(binding?.requestedVersion);
  const packaged = parse(binding?.packageVersion);
  if (!requested || !packaged || requested !== packaged) reasons.push("sut:version");
  if (requested && binding?.directoryName !== `fihim-vnext-v${requested}`) reasons.push("sut:directory");
}

export function verifyLabsPreflight(receipt) {
  const reasons = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    reasons.push("receipt:not_object");
  } else {
    if (receipt.schemaVersion !== "aftergraph.labs-preflight/v1") reasons.push("receipt:schema");
    if (!["OBSERVED","DEGRADED","INCOMPLETE"].includes(receipt.state)) reasons.push("receipt:state");
    if (!Array.isArray(receipt.requiredAdapterIds)) reasons.push("receipt:required");
    if (!Array.isArray(receipt.observedAdapterIds)) reasons.push("receipt:observed");
    if (!Array.isArray(receipt.missingAdapterIds)) reasons.push("receipt:missing");
    if (!Array.isArray(receipt.artifactObservations)) reasons.push("receipt:artifacts");
    if (receipt.authorityGranted !== false) reasons.push("receipt:authority");
    if (receipt.verificationGranted !== false) reasons.push("receipt:verification_escalation");
    if (receipt.scientificValidityGranted !== false) reasons.push("receipt:scientific_escalation");
    if (receipt.maximumClaim !== "OBSERVED") reasons.push("receipt:claim");
    if (!verifyDigest(receipt, "receiptDigest")) reasons.push("receipt:digest");

    verifyBundle(receipt.httpBundle, reasons);
    (receipt.artifactObservations || []).forEach((observation, index) =>
      verifyObservation(observation, reasons, `artifact:${index}`)
    );
    verifySutBinding(receipt.sutBinding, reasons);

    const required = new Set(receipt.requiredAdapterIds || []);
    const observed = new Set(receipt.observedAdapterIds || []);
    const expectedMissing = [...required].filter((id) => !observed.has(id)).sort();
    const declaredMissing = [...(receipt.missingAdapterIds || [])].sort();
    if (canonicalJson(expectedMissing) !== canonicalJson(declaredMissing)) reasons.push("receipt:coverage_mismatch");

    const observations = [
      ...(receipt.httpBundle?.layers || []).flatMap((layer) => layer?.observations || []),
      ...(receipt.artifactObservations || [])
    ];
    const unresolved = receipt.httpBundle?.unresolvedTargets || [];
    const degraded = observations.some((observation) => observation?.state !== "healthy");
    const expectedState = expectedMissing.length || unresolved.length
      ? "INCOMPLETE"
      : degraded
        ? "DEGRADED"
        : "OBSERVED";
    if (receipt.state !== expectedState) reasons.push(`receipt:state_mismatch:${expectedState}`);
  }

  const exactSubjects = [
    ...(receipt?.httpBundle?.layers || []).flatMap((layer) => layer?.observations || []),
    ...(receipt?.artifactObservations || [])
  ].filter((observation) => SHA1.test(String(observation?.subjectRevision || ""))).length +
    (receipt?.sutBinding && SHA1.test(String(receipt.sutBinding.sourceRevision || "")) ? 1 : 0);

  const valid = reasons.length === 0;
  const base = {
    schemaVersion: "aftergraph.sentinel-labs-preflight-verification/v1",
    valid,
    state: valid ? "VERIFIED_OBSERVATIONAL_PREFLIGHT" : "INVALID",
    sourceReceiptDigest: receipt?.receiptDigest || null,
    sourceState: receipt?.state || null,
    coverageComplete: valid && (receipt?.missingAdapterIds?.length || 0) === 0 &&
      (receipt?.httpBundle?.unresolvedTargets?.length || 0) === 0,
    exactSubjectCount: exactSubjects,
    authorityGranted: false,
    promotionAuthority: false,
    scientificValidityGranted: false,
    reasons
  };
  return { ...base, verificationDigest: sha256Hex(canonicalJson(base)) };
}
