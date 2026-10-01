import { createHash } from "node:crypto";
import { verifySettlementCorrelation } from "./economic-settlement-correlation.js";
import { verifyLegalAssetReconciliation } from "./economic-legal-reconciliation.js";
import { verifyEvidenceCoherence } from "./economic-evidence-coherence.js";
import { verifyLiveCanaryAssurance } from "./economic-live-canary-assurance.js";

const HASH=/^sha256:[a-f0-9]{64}$/;
const SECRET_KEY=/(private.?key|secret|bearer.?token|access.?token|password|mnemonic|seed)/i;

function canonicalize(value){
  if(value===null||typeof value==="string"||typeof value==="boolean") return value;
  if(typeof value==="number"){
    if(!Number.isFinite(value)) throw new Error("nonfinite_number");
    return value;
  }
  if(Array.isArray(value)) return value.map(canonicalize);
  if(typeof value==="object"){
    const out={};
    for(const key of Object.keys(value).sort()){
      const child=value[key];
      if(child===undefined) throw new Error("undefined_value");
      if(SECRET_KEY.test(key)) throw new Error("secret_field");
      out[key]=canonicalize(child);
    }
    return out;
  }
  throw new Error("non_json_value");
}

function canonicalJson(value){ return JSON.stringify(canonicalize(value)); }
function hash(value){ return "sha256:"+createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function chainEntry(sequence,kind,subject,artifactHash,previousEntryHash){
  const body={sequence,kind,subject,artifactHash,previousEntryHash};
  return {...body,entryHash:hash(body)};
}

export function verifyEconomicEvidencePack(input){
  const reasons=[];
  const pack=input?.pack||{};
  const components=input?.components||{};

  let correlation,legal,coherence,assurance;
  try{ correlation=verifySettlementCorrelation(components.settlementCorrelation); }
  catch{ reasons.push("component:correlation_exception"); }
  try{ legal=verifyLegalAssetReconciliation(components.legalReconciliation); }
  catch{ reasons.push("component:legal_exception"); }
  try{ coherence=verifyEvidenceCoherence(components.evidenceCoherence); }
  catch{ reasons.push("component:coherence_exception"); }
  try{ assurance=verifyLiveCanaryAssurance(components.liveCanaryAssurance); }
  catch{ reasons.push("component:assurance_exception"); }

  if(!correlation?.valid) reasons.push("component:correlation_invalid");
  if(!legal?.valid) reasons.push("component:legal_invalid");
  if(!coherence?.valid) reasons.push("component:coherence_invalid");
  if(!assurance?.readyForLiveCanaryReview) reasons.push("component:assurance_not_ready");

  if(pack?.schema!=="aftergraph.economic-evidence-pack/v1") reasons.push("pack:schema");
  if(!pack?.campaignId) reasons.push("pack:campaign_id");
  if(!pack?.economicTransactionId) reasons.push("pack:transaction_id");
  if(!pack?.assetId||!pack?.rightId) reasons.push("pack:asset_right");
  if(!HASH.test(String(pack?.legalBindingHash||""))) reasons.push("pack:legal_binding_hash");
  if(!Number.isInteger(pack?.generatedAtUnix)||pack.generatedAtUnix<=0) reasons.push("pack:generated_at");
  if(pack?.immutable!==true) reasons.push("pack:immutable");
  if(pack?.containsCredentials!==false) reasons.push("pack:credentials");
  if(pack?.liveValueEnabled!==false) reasons.push("pack:live_value");
  if(pack?.maxLiveValue!==0) reasons.push("pack:max_live_value");
  if(pack?.final!==false) reasons.push("pack:finality");
  if(pack?.externalEffects!==0) reasons.push("pack:external_effects");

  const settlementInput=components.settlementCorrelation||{};
  const legalInput=components.legalReconciliation||{};
  const coherenceInput=components.evidenceCoherence||{};
  if(pack?.economicTransactionId!==settlementInput?.economicTransactionId) reasons.push("binding:transaction_id");
  if(pack?.legalBindingHash!==settlementInput?.legalBindingHash) reasons.push("binding:legal_binding_hash");
  if(pack?.assetId!==legalInput?.canonical?.assetId) reasons.push("binding:asset_id");
  if(pack?.rightId!==legalInput?.canonical?.rightId) reasons.push("binding:right_id");

  let expectedDigests={};
  try{
    expectedDigests={
      settlementCorrelation:hash(components.settlementCorrelation),
      legalReconciliation:hash(components.legalReconciliation),
      evidenceCoherence:hash(components.evidenceCoherence),
      liveCanaryAssurance:hash(components.liveCanaryAssurance)
    };
  }catch(e){
    reasons.push("component:canonicalization");
  }

  for(const key of ["settlementCorrelation","legalReconciliation","evidenceCoherence","liveCanaryAssurance"]){
    if(pack?.componentDigests?.[key]!==expectedDigests[key]) reasons.push("digest:"+key);
  }

  const captures=Array.isArray(pack?.sourceCaptures)?[...pack.sourceCaptures]:[];
  const expectedClasses=new Set(["registry","custody","representation"]);
  const seenClasses=new Set();
  const seenEvidence=new Set();
  const observations=Array.isArray(coherenceInput?.observations)?coherenceInput.observations:[];
  const obsByClass=new Map(observations.map(x=>[x?.sourceClass,x]));
  const legalByClass={
    registry:legalInput?.registry,
    custody:legalInput?.custody,
    representation:legalInput?.representation
  };
  const legalSourceId={
    registry:legalInput?.registry?.registryId,
    custody:legalInput?.custody?.custodianId,
    representation:legalInput?.representation?.network
  };

  for(const capture of captures){
    const cls=capture?.sourceClass;
    if(!expectedClasses.has(cls)){ reasons.push("source:class"); continue; }
    if(seenClasses.has(cls)) reasons.push("source:duplicate_class");
    seenClasses.add(cls);
    if(!capture?.sourceId) reasons.push("source:id");
    if(!HASH.test(String(capture?.evidenceHash||""))) reasons.push("source:evidence_hash");
    if(seenEvidence.has(capture?.evidenceHash)) reasons.push("source:evidence_reused");
    seenEvidence.add(capture?.evidenceHash);
    if(!Number.isInteger(capture?.generation)||capture.generation<=0) reasons.push("source:generation");
    if(!Number.isInteger(capture?.observedAtUnix)||capture.observedAtUnix<=0) reasons.push("source:observed_at");

    const obs=obsByClass.get(cls);
    const record=legalByClass[cls];
    if(capture?.sourceId!==obs?.sourceId||capture?.sourceId!==legalSourceId[cls]) reasons.push("binding:"+cls+"_source_id");
    if(capture?.evidenceHash!==obs?.evidenceHash||capture?.evidenceHash!==record?.evidenceHash) reasons.push("binding:"+cls+"_evidence_hash");
    if(capture?.generation!==obs?.generation) reasons.push("binding:"+cls+"_generation");
    if(capture?.observedAtUnix!==obs?.observedAtUnix) reasons.push("binding:"+cls+"_observed_at");
  }
  for(const cls of expectedClasses) if(!seenClasses.has(cls)) reasons.push("source:missing_"+cls);

  const sortedCaptures=[...captures].sort((a,b)=>String(a.sourceClass).localeCompare(String(b.sourceClass)));
  const chainInputs=[
    ...sortedCaptures.map(x=>({kind:"source:"+x.sourceClass,subject:x.sourceId,hash:x.evidenceHash})),
    {kind:"component:settlement-correlation",subject:pack?.economicTransactionId,hash:expectedDigests.settlementCorrelation},
    {kind:"component:legal-reconciliation",subject:String(pack?.assetId||"")+":"+String(pack?.rightId||""),hash:expectedDigests.legalReconciliation},
    {kind:"component:evidence-coherence",subject:pack?.campaignId,hash:expectedDigests.evidenceCoherence},
    {kind:"component:live-canary-assurance",subject:pack?.campaignId,hash:expectedDigests.liveCanaryAssurance}
  ];
  const expectedChain=[];
  let prev=null;
  try{
    for(let i=0;i<chainInputs.length;i++){
      const item=chainInputs[i];
      const entry=chainEntry(i+1,item.kind,item.subject,item.hash,prev);
      expectedChain.push(entry); prev=entry.entryHash;
    }
  }catch{ reasons.push("chain:canonicalization"); }

  if(JSON.stringify(pack?.evidenceChain||[])!==JSON.stringify(expectedChain)) reasons.push("chain:mismatch");

  const manifestBody={
    schema:"aftergraph.economic-evidence-pack/v1",
    campaignId:pack?.campaignId,
    economicTransactionId:pack?.economicTransactionId,
    assetId:pack?.assetId,
    rightId:pack?.rightId,
    legalBindingHash:pack?.legalBindingHash,
    generatedAtUnix:pack?.generatedAtUnix,
    sourceCaptures:sortedCaptures,
    componentDigests:expectedDigests,
    evidenceChain:expectedChain,
    immutable:true,
    containsCredentials:false,
    liveValueEnabled:false,
    maxLiveValue:0,
    final:false,
    externalEffects:0
  };
  try{
    if(pack?.manifestHash!==hash(manifestBody)) reasons.push("manifest:hash");
  }catch{ reasons.push("manifest:canonicalization"); }

  const unique=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-evidence-pack-verification/v1",
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_IMMUTABLE_EVIDENCE_PACK":"INVALID",
    evidencePackVerified:unique.length===0,
    readyForLiveCanaryReview:unique.length===0 && assurance?.readyForLiveCanaryReview===true,
    executionAuthority:false,
    liveValueEnabled:false,
    maxLiveValue:0,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:unique
  };
}
