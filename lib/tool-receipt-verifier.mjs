import { createHash } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const canonical = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
};

export function verifyToolExecutionReceipt(receipt) {
  const reasons = [];
  if (!receipt || typeof receipt !== 'object') reasons.push('receipt_required');
  else {
    if (receipt.schemaVersion !== 'aftergraph.tool-receipt/v1') reasons.push('unsupported_schema');
    if (!String(receipt.invocationId || '').trim()) reasons.push('invocation_id_required');
    if (!String(receipt.toolId || '').trim()) reasons.push('tool_id_required');
    if (!String(receipt.capability || '').trim()) reasons.push('capability_required');
    if (receipt.credentialMaterialExposed !== false) reasons.push('credential_exposure_invalid');
    if (!/^[a-f0-9]{64}$/i.test(String(receipt.receiptDigest || ''))) reasons.push('receipt_digest_invalid');

    if (reasons.length === 0) {
      const { receiptDigest, ...base } = receipt;
      const expected = sha256(canonical(base));
      if (expected !== receiptDigest) reasons.push('receipt_digest_mismatch');
    }
  }

  return {
    schemaVersion: 'aftergraph.tool-receipt-verification/v1',
    status: reasons.length === 0 ? 'VERIFIED' : 'INVALID',
    reasons,
    independent: true,
    authorityGranted: false,
  };
}
