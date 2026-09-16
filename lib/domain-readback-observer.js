function nonEmpty(value){return typeof value==='string'&&value.trim()!==''?value.trim():null;}

export function createDomainReadbackObserver({observerRef,observe}={}){
  const ref=nonEmpty(observerRef);
  if(!ref)throw new Error('observer_ref_required');
  if(typeof observe!=='function')throw new Error('observe_required');
  return async function domainReadbackObserver({subject,evidence}={}){
    let observed;
    try{observed=await observe({subject,evidence});}
    catch{return {status:'INDETERMINATE',observerRef:ref,evidenceRefs:[]};}
    if(!observed||typeof observed!=='object'||Array.isArray(observed)){
      return {status:'INDETERMINATE',observerRef:ref,evidenceRefs:[]};
    }
    const evidenceRef=nonEmpty(observed.evidenceRef);
    const evidenceRefs=evidenceRef?[evidenceRef]:[];
    if(observed.status==='MATCH'&&evidenceRef)return {status:'PASS',observerRef:ref,evidenceRefs};
    if(observed.status==='MISMATCH'&&evidenceRef)return {status:'FAIL',observerRef:ref,evidenceRefs};
    return {status:'INDETERMINATE',observerRef:ref,evidenceRefs};
  };
}
