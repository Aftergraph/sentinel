import { createHash } from "node:crypto";
import { verifyLegalAssetReconciliation } from "./economic-legal-reconciliation.js";
import { verifyEvidenceCoherence } from "./economic-evidence-coherence.js";

const HASH=/^sha256:[a-f0-9]{64}$/;
const CLASSES=["custody","registry","representation"];

const sha256=value=>"sha256:"+createHash("sha256").update(value).digest("hex");
const stable=value=>{
  if(value===null||typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return "["+value.map(stable).join(",")+"]";
  return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}";
};

const expectedSchema=sourceClass=>({
  registry:"aftergraph.authoritative-asset-registry-record/v1",
  custody:"aftergraph.custodial-right-record/v1",
  representation:"aftergraph.ledger-asset-representation-record/v1",
}[sourceClass]);

const recordHash=record=>{
  if(record?.schema==="aftergraph.ledger-asset-representation-record/v1") return record?.representationHash;
  return record?.recordHash;
};

const sourceIdentity=(sourceClass,record)=>{
  if(sourceClass==="registry") return record?.registryId;
  if(sourceClass==="custody") return record?.custodianId;
  if(sourceClass==="representation") return record?.network;
  return undefined;
};

export function verifyEconomicEvidenceCampaign(input){
  const pack=input?.pack||{};
  const policy=input?.policy||{};
  const previousGenerations=input?.previousGenerations||{};
  const reasons=[];

  if(pack?.schema!=="aftergraph.economic-evidence-campaign/v1") reasons.push("pack:schema");
  if(!String(pack?.campaignId||"")) reasons.push("pack:campaign_id");
  if(pack?.executionAuthority!==false) reasons.push("pack:execution_authority");
  if(pack?.liveValueEnabled!==false) reasons.push("pack:live_value");
  if(pack?.externalEffects!==0) reasons.push("pack:external_effects");
  if(pack?.final!==false) reasons.push("pack:finality");

  const expectation=pack?.expectation||{};
  if(!String(expectation?.assetId||"")) reasons.push("expectation:asset_id");
  if(!String(expectation?.rightId||"")) reasons.push("expectation:right_id");
  if(!HASH.test(String(expectation?.legalInstrumentHash||""))) reasons.push("expectation:legal_instrument_hash");
  if(!HASH.test(String(expectation?.rightsHash||""))) reasons.push("expectation:rights_hash");

  const snapshots=Array.isArray(pack?.snapshots)?pack.snapshots:[];
  if(snapshots.length!==3) reasons.push("pack:snapshot_count");

  const seenClass=new Set();
  const seenSourceId=new Set();
  const seenEvidence=new Set();
  const byClass=new Map();

  for(const snapshot of snapshots){
    const cls=String(snapshot?.sourceClass||"");
    if(!CLASSES.includes(cls)) reasons.push("snapshot:source_class");
    if(seenClass.has(cls)) reasons.push(cls+":duplicate_source_class");
    seenClass.add(cls);

    const sourceId=String(snapshot?.sourceId||"");
    if(!sourceId) reasons.push(cls+":source_id");
    if(seenSourceId.has(sourceId)) reasons.push(cls+":duplicate_source_id");
    seenSourceId.add(sourceId);

    if(!Number.isSafeInteger(snapshot?.generation)||snapshot.generation<=0) reasons.push(cls+":generation");
    if(!Number.isSafeInteger(snapshot?.observedAtUnix)||snapshot.observedAtUnix<=0) reasons.push(cls+":observed_at_unix");
    if(snapshot?.schema!=="aftergraph.economic-evidence-source-snapshot/v1") reasons.push(cls+":snapshot_schema");
    if(snapshot?.externalEffects!==0) reasons.push(cls+":snapshot_external_effects");
    if(snapshot?.final!==false) reasons.push(cls+":snapshot_finality");

    const evidenceHash=String(snapshot?.evidenceHash||"");
    if(!HASH.test(evidenceHash)) reasons.push(cls+":evidence_hash");
    if(seenEvidence.has(evidenceHash)) reasons.push(cls+":evidence_reused");
    seenEvidence.add(evidenceHash);

    const record=snapshot?.record||{};
    if(snapshot?.recordSchema!==record?.schema) reasons.push(cls+":record_schema_projection");
    if(record?.schema!==expectedSchema(cls)) reasons.push(cls+":record_schema");
    if(record?.evidenceHash!==snapshot?.evidenceHash) reasons.push(cls+":evidence_projection");
    if(recordHash(record)!==snapshot?.recordHash) reasons.push(cls+":record_hash_projection");
    if(sourceIdentity(cls,record)!==sourceId) reasons.push(cls+":source_identity_projection");
    if(record?.assetId!==expectation.assetId) reasons.push(cls+":asset_id");
    if(record?.rightId!==expectation.rightId) reasons.push(cls+":right_id");
    if(record?.legalInstrumentHash!==expectation.legalInstrumentHash) reasons.push(cls+":legal_instrument");
    if(record?.rightsHash!==expectation.rightsHash) reasons.push(cls+":rights_hash");
    if(record?.status!=="ACTIVE") reasons.push(cls+":status");
    if(record?.externalEffects!==0) reasons.push(cls+":record_external_effects");
    if(record?.final!==false) reasons.push(cls+":record_finality");

    const parsed=Math.floor(Date.parse(String(record?.observedAt||""))/1000);
    if(!Number.isFinite(parsed)||parsed!==snapshot?.observedAtUnix) reasons.push(cls+":observed_at_projection");

    byClass.set(cls,snapshot);
  }

  for(const cls of CLASSES) if(!seenClass.has(cls)) reasons.push(cls+":missing");

  const sorted=[...snapshots].sort((a,b)=>String(a.sourceClass).localeCompare(String(b.sourceClass)));
  if(JSON.stringify(snapshots.map(x=>x?.sourceClass))!==JSON.stringify(sorted.map(x=>x?.sourceClass))){
    reasons.push("pack:snapshot_order");
  }

  const separationCore=snapshots.map(s=>({
    sourceClass:s.sourceClass,
    sourceId:s.sourceId,
    generation:s.generation,
    evidenceHash:s.evidenceHash,
  }));
  const expectedSeparation=sha256(stable(separationCore));
  if(pack?.sourceSeparationDigest!==expectedSeparation) reasons.push("pack:source_separation_digest");

  const packCore={
    schema:"aftergraph.economic-evidence-campaign/v1",
    campaignId:pack?.campaignId,
    expectation:pack?.expectation,
    snapshots:pack?.snapshots,
    sourceSeparationDigest:pack?.sourceSeparationDigest,
    executionAuthority:false,
    liveValueEnabled:false,
    externalEffects:0,
    final:false,
  };
  const expectedPackHash=sha256(stable(packCore));
  if(pack?.packHash!==expectedPackHash) reasons.push("pack:hash");

  const registry=byClass.get("registry")?.record;
  const custody=byClass.get("custody")?.record;
  const representation=byClass.get("representation")?.record;

  const legal=verifyLegalAssetReconciliation({
    canonical:{
      assetId:expectation.assetId,
      rightId:expectation.rightId,
      legalInstrumentHash:expectation.legalInstrumentHash,
      rightsHash:expectation.rightsHash,
      jurisdiction:String(input?.jurisdiction||""),
    },
    registry,custody,representation,
    reconciliation:{
      schema:"aftergraph.economic-legal-reconciliation/v1",
      assetId:expectation.assetId,
      rightId:expectation.rightId,
      legalInstrumentHash:expectation.legalInstrumentHash,
      rightsHash:expectation.rightsHash,
      state:"LEGAL_RIGHT_ALIGNED",
      final:false,
      externalEffects:0,
      reconciliationRequired:false,
      evidenceSources:["custody","registry","representation"],
      reasons:[],
    }
  });
  if(!legal.valid) reasons.push("legal:invalid");

  const observations=snapshots.map(s=>({
    sourceClass:s.sourceClass,
    sourceId:s.sourceId,
    evidenceHash:s.evidenceHash,
    observedAtUnix:s.observedAtUnix,
    generation:s.generation,
  }));
  const coherence=verifyEvidenceCoherence({
    policy,observations,previousGenerations,
    coherence:{
      schema:"aftergraph.economic-evidence-coherence/v1",
      state:"TEMPORALLY_COHERENT",
      final:false,
      externalEffects:0,
      refreshRequired:false,
      observedSources:observations.map(o=>o.sourceClass+":"+o.sourceId).sort(),
      oldestObservedAtUnix:Math.min(...observations.map(o=>o.observedAtUnix)),
      newestObservedAtUnix:Math.max(...observations.map(o=>o.observedAtUnix)),
      reasons:[],
    }
  });
  if(!coherence.valid) reasons.push("coherence:invalid");

  const uniqueReasons=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-evidence-campaign-verification/v1",
    valid:uniqueReasons.length===0,
    state:uniqueReasons.length===0?"VERIFIED_EVIDENCE_CAMPAIGN":"EVIDENCE_CAMPAIGN_INVALID",
    campaignId:pack?.campaignId||null,
    packHash:pack?.packHash||null,
    sourceSeparationVerified:uniqueReasons.length===0,
    legalRightAligned:legal.valid,
    temporallyCoherent:coherence.valid,
    executionAuthority:false,
    liveValueEnabled:false,
    maxLiveValue:0,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:uniqueReasons,
  };
}
