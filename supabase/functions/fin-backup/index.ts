import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {backup} from './backup.mjs';
const b64=(input:string|ArrayBuffer)=>{const a=typeof input==='string'?new TextEncoder().encode(input):new Uint8Array(input);let s='';for(const x of a)s+=String.fromCharCode(x);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
async function token(){
 const account=JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT')||'{}');
 const now=Math.floor(Date.now()/1000),header=b64(JSON.stringify({alg:'RS256',typ:'JWT'}));
 const body=b64(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
 const der=Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'')),c=>c.charCodeAt(0));
 const key=await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(header+'.'+body));
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:header+'.'+body+'.'+b64(signature)}),signal:AbortSignal.timeout(20000)});
 const result=await response.json();if(!response.ok||!result.access_token)throw Error('Autenticação Google recusada');return result.access_token;
}
Deno.serve(async req=>{
 if(req.method!=='POST')return new Response('Método não permitido',{status:405});
 const secret=req.headers.get('x-backup-secret');if(!secret)return new Response('Não autorizado',{status:401});
 const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
 try{
  let access:string;
  const google=async(url:string,init:RequestInit={})=>{access??=await token();const response=await fetch(url,{...init,headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},signal:AbortSignal.timeout(45000)});if(!response.ok)throw Error('Google não confirmou a cópia ('+response.status+')');return response.json()};
  return Response.json(await backup(client,google,secret));
 }catch{console.error('Backup de Fornecedores não confirmado');return Response.json({error:'Backup não confirmado. Nova tentativa automática.'},{status:503})}
});
