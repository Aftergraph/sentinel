function nonEmpty(value){return typeof value==='string'&&value.trim()!==''?value.trim():null;}

function repositoryParts(repository){
  const value=nonEmpty(repository);
  const match=value?.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u);
  return match?{owner:match[1],repo:match[2]}:null;
}

function parseEvidenceRef(value){
  const raw=nonEmpty(value);
  if(!raw)return null;
  let url;
  try{url=new URL(raw);}catch{return null;}
  if(url.protocol!=='https:'||url.hostname!=='github.com')return null;
  const m=url.pathname.match(/^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/?$/u);
  if(!m)return null;
  const params=new URLSearchParams(url.hash.startsWith('#')?url.hash.slice(1):'');
  const proof=nonEmpty(params.get('proof'));
  const step=nonEmpty(params.get('step'));
  return {raw,owner:m[1],repo:m[2],runId:m[3],proof,step};
}

function ownerCoversChangedPaths(canonicalOwner,repository,changedPaths){
  const value=nonEmpty(canonicalOwner);
  if(!value||!Array.isArray(changedPaths)||changedPaths.length===0)return false;
  const split=value.indexOf(':');
  if(split<1)return false;
  const ownerRepo=value.slice(0,split);
  const prefix=value.slice(split+1).replace(/^\/+|\/+$/gu,'');
  if(ownerRepo!==repository||!prefix)return false;
  return changedPaths.every(path=>{
    const p=nonEmpty(path)?.replace(/^\/+|\/+$/gu,'');
    return !!p&&(p===prefix||p.startsWith(prefix+'/')||prefix.startsWith(p+'/'));
  });
}

async function readJson(fetchImpl,url,token,timeoutMs){
  let response;
  const headers={
    accept:'application/vnd.github+json',
    'x-github-api-version':'2022-11-28',
    'user-agent':'aftergraph-sentinel-simplification-observer',
  };
  if(typeof token==='string'&&token)headers.authorization=`Bearer ${token}`;
  try{
    response=await fetchImpl(url,{headers,signal:AbortSignal.timeout(timeoutMs)});
  }catch{
    return {ok:false,kind:'unavailable'};
  }
  if(!response?.ok){
    // An unauthenticated 404 is ambiguous with a private repository. Never
    // turn missing authority into a negative verification verdict.
    if(response?.status===404)return {ok:false,kind:token?'missing':'unavailable'};
    return {ok:false,kind:'unavailable'};
  }
  try{return {ok:true,value:await response.json()};}
  catch{return {ok:false,kind:'unavailable'};}
}

export function createGitHubSimplificationObserver({
  token,
  fetchImpl=fetch,
  apiBase='https://api.github.com',
  observerRef='sentinel:observer:github-actions',
  timeoutMs=5000,
}={}){
  if(token!==undefined&&token!==null&&(typeof token!=='string'||Buffer.byteLength(token,'utf8')<20)){
    throw new Error('github_token_invalid');
  }
  if(typeof fetchImpl!=='function')throw new Error('fetch_required');
  const observer=nonEmpty(observerRef);
  if(!observer)throw new Error('observer_ref_required');
  let api;
  try{api=new URL(apiBase);}catch{throw new Error('github_api_base_required');}
  if(api.protocol!=='https:'&&api.hostname!=='127.0.0.1'&&api.hostname!=='localhost'){
    throw new Error('github_api_https_required');
  }

  return async function observeSimplification({
    subject,
    evidence,
    obligationIds,
    evidenceRefs,
  }={}){
    const repository=nonEmpty(subject?.repository);
    const parts=repositoryParts(repository);
    const baseline=nonEmpty(subject?.baselineRevision);
    const final=nonEmpty(subject?.finalRevision);
    const obligations=Array.isArray(evidence?.body?.obligations)?evidence.body.obligations:null;
    const changedPaths=Array.isArray(evidence?.body?.changedPaths)?evidence.body.changedPaths:null;
    const canonicalOwner=nonEmpty(evidence?.body?.canonicalOwner);
    const expectedIds=Array.isArray(obligationIds)?[...obligationIds]:[];
    const claimedRefs=Array.isArray(evidenceRefs)?[...new Set(evidenceRefs.filter(nonEmpty))]:[];

    if(!parts||!baseline||!final||!obligations||!changedPaths||!canonicalOwner||expectedIds.length===0){
      return {status:'INDETERMINATE',observerRef:observer,evidenceRefs:[]};
    }

    const obligationMap=new Map();
    for(const item of obligations){
      const id=nonEmpty(item?.id);
      const refs=Array.isArray(item?.evidenceRefs)?item.evidenceRefs.filter(nonEmpty):[];
      if(!id||obligationMap.has(id)||refs.length===0){
        return {status:'FAIL',observerRef:observer,evidenceRefs:[]};
      }
      obligationMap.set(id,refs);
    }
    for(const id of expectedIds){
      if(!obligationMap.has(id))return {status:'FAIL',observerRef:observer,evidenceRefs:[]};
    }

    const commitUrls=[
      new URL(`/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/commits/${encodeURIComponent(baseline)}`,api),
      new URL(`/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/commits/${encodeURIComponent(final)}`,api),
    ];
    for(const url of commitUrls){
      const result=await readJson(fetchImpl,url,token,timeoutMs);
      if(!result.ok){
        return {
          status:result.kind==='missing'?'FAIL':'INDETERMINATE',
          observerRef:observer,
          evidenceRefs:[],
        };
      }
    }

    if(!ownerCoversChangedPaths(canonicalOwner,repository,changedPaths)){
      return {status:'FAIL',observerRef:observer,evidenceRefs:[]};
    }

    const cache=new Map();
    const resolveRun=async ref=>{
      if(cache.has(ref.runId))return cache.get(ref.runId);
      const runUrl=new URL(`/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/actions/runs/${ref.runId}`,api);
      const run=await readJson(fetchImpl,runUrl,token,timeoutMs);
      if(!run.ok){cache.set(ref.runId,run);return run;}
      const value=run.value;
      if(value?.head_sha!==final||value?.status!=='completed'||value?.conclusion!=='success'){
        const failed={ok:false,kind:'contradiction'};
        cache.set(ref.runId,failed);
        return failed;
      }
      const passed={ok:true,value};
      cache.set(ref.runId,passed);
      return passed;
    };

    const jobsCache=new Map();
    const stepPassed=async(ref,step)=>{
      let jobs=jobsCache.get(ref.runId);
      if(!jobs){
        const jobsUrl=new URL(`/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/actions/runs/${ref.runId}/jobs?per_page=100`,api);
        jobs=await readJson(fetchImpl,jobsUrl,token,timeoutMs);
        jobsCache.set(ref.runId,jobs);
      }
      if(!jobs.ok)return jobs;
      const matched=(jobs.value?.jobs||[]).flatMap(job=>Array.isArray(job.steps)?job.steps:[])
        .find(candidate=>candidate?.name===step);
      if(!matched||matched.status!=='completed'||matched.conclusion!=='success'){
        return {ok:false,kind:'contradiction'};
      }
      return {ok:true,value:matched};
    };

    const resolved=[];
    for(const id of expectedIds){
      const refsForObligation=obligationMap.get(id)||[];
      let obligationPassed=false;
      for(const raw of refsForObligation){
        const ref=parseEvidenceRef(raw);
        if(!ref||ref.owner!==parts.owner||ref.repo!==parts.repo||ref.proof!==id){
          return {status:'FAIL',observerRef:observer,evidenceRefs:resolved};
        }
        const run=await resolveRun(ref);
        if(!run.ok){
          return {
            status:run.kind==='unavailable'?'INDETERMINATE':'FAIL',
            observerRef:observer,
            evidenceRefs:resolved,
          };
        }
        if(id==='behavior-preserved'){
          if(!ref.step){
            return {status:'FAIL',observerRef:observer,evidenceRefs:resolved};
          }
          const step=await stepPassed(ref,ref.step);
          if(!step.ok){
            return {
              status:step.kind==='unavailable'?'INDETERMINATE':'FAIL',
              observerRef:observer,
              evidenceRefs:resolved,
            };
          }
        }
        resolved.push(raw);
        obligationPassed=true;
      }
      if(!obligationPassed)return {status:'FAIL',observerRef:observer,evidenceRefs:resolved};
    }

    const resolvedSet=new Set(resolved);
    if(claimedRefs.some(ref=>!resolvedSet.has(ref))){
      return {status:'INDETERMINATE',observerRef:observer,evidenceRefs:resolved};
    }
    return {status:'PASS',observerRef:observer,evidenceRefs:[...new Set(resolved)].sort()};
  };
}
