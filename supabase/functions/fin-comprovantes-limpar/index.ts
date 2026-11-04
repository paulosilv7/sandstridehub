import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {cleanup} from './cleanup.mjs';
Deno.serve(async request=>{
 if(request.method!=='POST')return new Response('Method not allowed',{status:405});
 const secret=request.headers.get('x-cleanup-secret');
 if(!secret)return new Response('Unauthorized',{status:401});
 try{
  const body=await request.json();
  const dryRun=body.dryRun!==false;
  const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
  const{data:authorization,error:authError}=await client.rpc('fin_receipt_cleanup_auth',{candidate:secret});
  if(authError||!authorization?.valid)return new Response('Unauthorized',{status:401});
  if(!dryRun&&!authorization.enabled)return new Response('Limpeza definitiva desativada',{status:409});
  const result=await cleanup(client,{dryRun});
  console.log(JSON.stringify(result));
  return Response.json(result,{status:result.failed?503:200});
 }catch{console.error('Falha na limpeza de comprovantes');return Response.json({error:'Falha na limpeza de comprovantes'},{status:500});}
});
