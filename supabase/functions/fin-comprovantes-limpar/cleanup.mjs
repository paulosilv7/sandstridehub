export const RETENTION_MS=90*24*60*60*1000;
export function eligible(receipt,now){return !receipt.deleted_at&&Number.isFinite(Date.parse(receipt.created_at))&&Date.parse(receipt.created_at)<=now-RETENTION_MS;}
export async function cleanup(client,{now=Date.now(),dryRun=true}={}){
 const cutoff=new Date(now-RETENTION_MS).toISOString();
 const{data,error}=await client.from('fin_receipts').select('id,path,created_at,deleted_at').is('deleted_at',null).lte('created_at',cutoff).order('created_at').limit(100);
 if(error)throw error;const candidates=(data||[]).filter(r=>eligible(r,now));
 const result={dryRun,cutoff,candidates:candidates.length,removed:0,failed:0};
 if(dryRun)return result;
 for(const receipt of candidates){
  // Não usar DELETE SQL em storage.objects: a API remove o arquivo físico.
  const{error:removeError}=await client.storage.from('fin-comprovantes').remove([receipt.path]);
  if(removeError){result.failed++;continue;}
  const{error:markError}=await client.from('fin_receipts').update({deleted_at:new Date(now).toISOString()}).eq('id',receipt.id).is('deleted_at',null);
  if(markError){result.failed++;continue;}result.removed++;
 }
 return result;
}
