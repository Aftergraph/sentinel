import crypto from 'node:crypto';

const TASK_CONTRACT_GIT_BLOB_SHA = 'fbdecac2a3ca85bb53d6b2baf1229cdd74cc5e12';
const TASK_IDS = ['pq-exact-001', 'pq-code-001', 'pq-json-001', 'pq-tool-001', 'pq-constraints-001'];

function subset(expected, actual) {
  if (Array.isArray(expected)) return JSON.stringify(expected) === JSON.stringify(actual);
  if (expected && typeof expected === 'object') {
    return actual && typeof actual === 'object' && !Array.isArray(actual)
      && Object.entries(expected).every(([key, value]) => key in actual && subset(value, actual[key]));
  }
  return expected === actual;
}

function parseToolArguments(call) {
  const raw = call?.function?.arguments ?? call?.arguments ?? {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw && typeof raw === 'object' ? raw : null;
}

function scoreObservation(observation) {
  const text = String(observation.outputText ?? '');
  if (observation.id === 'pq-exact-001') return text.trim() === 'AFTERGRAPH-LING-OK';
  if (observation.id === 'pq-code-001') return text.trim() === '[4, 16]';
  if (observation.id === 'pq-json-001') {
    try { return subset({ status: 'ok', value: 42 }, JSON.parse(text)); } catch { return false; }
  }
  if (observation.id === 'pq-tool-001') {
    return (observation.toolCalls ?? []).some((call) => {
      const name = call?.function?.name ?? call?.name;
      return name === 'lookup_user' && subset({ user_id: 17 }, parseToolArguments(call));
    });
  }
  if (observation.id === 'pq-constraints-001') return text.trim() === 'ALPHA BETA GAMMA.';
  throw new Error(`unknown task id: ${observation.id}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function verifyCapturedCampaign(document) {
  if (document?.campaign !== 'ling-openrouter-qualification-001') throw new Error('unexpected campaign');
  if (document?.model !== 'inclusionai/ling-3.0-flash-vl:free') throw new Error('unexpected model route');
  if (document?.task_contract_git_blob_sha !== TASK_CONTRACT_GIT_BLOB_SHA) throw new Error('unexpected task contract');
  if (!Array.isArray(document.trials) || document.trials.length < 1) throw new Error('trials required');

  const rescored = [];
  let mismatches = 0;
  for (const [trialIndex, trial] of document.trials.entries()) {
    if (!Array.isArray(trial.results) || trial.results.length !== TASK_IDS.length) throw new Error(`trial ${trialIndex + 1}: expected five results`);
    const ids = trial.results.map((result) => result.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify([...TASK_IDS].sort())) throw new Error(`trial ${trialIndex + 1}: task set mismatch`);
    for (const result of trial.results) {
      const independentlyPassed = scoreObservation(result);
      if (typeof result.passed !== 'boolean') throw new Error('runner pass claim must be boolean');
      if (result.passed !== independentlyPassed) mismatches += 1;
      rescored.push({ trial: trialIndex + 1, task_id: result.id, runner_passed: result.passed, independently_passed: independentlyPassed });
    }
  }

  const independentlyPassed = rescored.filter((item) => item.independently_passed).length;
  const aggregatePassRate = independentlyPassed / rescored.length;
  const attestationCore = {
    verifier: 'sentinel:model-evidence-verifier:v2',
    campaign: document.campaign,
    model: document.model,
    task_contract_git_blob_sha: TASK_CONTRACT_GIT_BLOB_SHA,
    observations: rescored.length,
    independently_passed: independentlyPassed,
    aggregate_pass_rate: aggregatePassRate,
    score_mismatches: mismatches,
    verdict: mismatches === 0 ? 'PASS' : 'FAIL',
    rescored,
  };
  return {
    ...attestationCore,
    attestation_sha256: crypto.createHash('sha256').update(canonicalJson(attestationCore)).digest('hex'),
  };
}
