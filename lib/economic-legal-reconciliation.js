function isHash(v){ return /^sha256:[a-f0-9]{64}$/.test(String(v||"")); }

export function verifyLegalAssetReconciliation(input){
  const reasons=[];
  const canonical=input?.canonical||{};
  const registry=input?.registry||{};
  const custody=input?.custody||{};
  const representation=input?.representation||{};
  const claimed=input?.reconciliation||{};

  if(!canonical.assetId||!canonical.rightId||!canonical.jurisdiction) reasons.push("canonical_identity");
  if(!isHash(canonical.legalInstrumentHash)) reasons.push("canonical_legal_instrument_hash");
  if(!isHash(canonical.rightsHash)) reasons.push("canonical_rights_hash");

  const evidence=new Map();
  const checkEvidence=(source,hash)=>{
    if(!isHash(hash)){ reasons.push(source+":evidence_hash"); return; }
    if(evidence.has(hash)){ reasons.push(source+":evidence_reused_with_"+evidence.get(hash)); return; }
    evidence.set(hash,source);
  };

  const common=(source,record)=>{
    if(record?.assetId!==canonical.assetId) reasons.push(source+":asset_id");
    if(record?.rightId!==canonical.rightId) reasons.push(source+":right_id");
    if(record?.legalInstrumentHash!==canonical.legalInstrumentHash) reasons.push(source+":legal_instrument");
    if(record?.rightsHash!==canonical.rightsHash) reasons.push(source+":rights_hash");
    if(record?.status!=="ACTIVE") reasons.push(source+":status");
    if(record?.externalEffects!==0) reasons.push(source+":external_effects");
    if(record?.final!==false) reasons.push(source+":finality");
    checkEvidence(source,record?.evidenceHash);
  };

  if(registry?.schema!=="aftergraph.authoritative-asset-registry-record/v1") reasons.push("registry:schema");
  if(!registry?.registryId||!isHash(registry?.recordHash)) reasons.push("registry:identity");
  common("registry",registry);

  if(custody?.schema!=="aftergraph.custodial-right-record/v1") reasons.push("custody:schema");
  if(!custody?.custodianId||!custody?.custodyRef||!isHash(custody?.recordHash)||!isHash(custody?.accountFingerprint)) reasons.push("custody:identity");
  common("custody",custody);

  if(representation?.schema!=="aftergraph.ledger-asset-representation-record/v1") reasons.push("representation:schema");
  if(!representation?.network||!representation?.representationId||!isHash(representation?.representationHash)) reasons.push("representation:identity");
  common("representation",representation);

  const validUnderlying=reasons.length===0;
  const expectedState=validUnderlying?"LEGAL_RIGHT_ALIGNED":"LEGAL_RECONCILIATION_REQUIRED";

  if(claimed?.schema!=="aftergraph.economic-legal-reconciliation/v1") reasons.push("claim:schema");
  if(claimed?.assetId!==canonical.assetId) reasons.push("claim:asset_id");
  if(claimed?.rightId!==canonical.rightId) reasons.push("claim:right_id");
  if(claimed?.legalInstrumentHash!==canonical.legalInstrumentHash) reasons.push("claim:legal_instrument");
  if(claimed?.rightsHash!==canonical.rightsHash) reasons.push("claim:rights_hash");
  if(claimed?.final!==false) reasons.push("claim:finality");
  if(claimed?.externalEffects!==0) reasons.push("claim:external_effects");

  if(validUnderlying){
    if(claimed?.state!==expectedState) reasons.push("claim:state");
    if(claimed?.reconciliationRequired!==false) reasons.push("claim:reconciliation");
  }else{
    if(claimed?.state==="LEGAL_RIGHT_ALIGNED") reasons.push("claim:overclaims_alignment");
    if(claimed?.reconciliationRequired!==true) reasons.push("claim:missing_reconciliation");
  }

  return {
    schema:"aftergraph.economic-legal-reconciliation-verification/v1",
    valid:reasons.length===0,
    state:reasons.length===0?"VERIFIED_LEGAL_RIGHT_ALIGNMENT":"LEGAL_RECONCILIATION_REQUIRED",
    legalRightAligned:reasons.length===0,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:[...new Set(reasons)].sort()
  };
}
