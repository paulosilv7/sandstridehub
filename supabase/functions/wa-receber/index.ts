// Recebe os webhooks do WAHA (WhatsApp lido em modo SOMENTE LEITURA) e guarda só o que é lançamento.
// Esta função NÃO envia nada ao WhatsApp e NÃO grava compras: só cria mensagens e pendentes (wa_*).
// Autenticação: assinatura HMAC-SHA512 do corpo (cabeçalho X-Webhook-Hmac) com o segredo WAHA_HMAC_KEY.
// Implantar com verify_jwt=false (o WAHA não tem JWT do Supabase; a assinatura é a autenticação).
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {ler,numero,diaSP,horaSP} from './parse.mjs';

const hex=(buf:ArrayBuffer)=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
async function assinaturaValida(corpo:string,recebida:string|null){
 const chave=Deno.env.get('WAHA_HMAC_KEY');
 if(!chave||!recebida)return false; // sem segredo configurado, nada é aceito
 const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(chave),{name:'HMAC',hash:'SHA-512'},false,['sign']);
 const esperada=hex(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(corpo)));
 const a=new TextEncoder().encode(esperada),b=new TextEncoder().encode(recebida.trim().toLowerCase());
 if(a.length!==b.length)return false;
 let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];
 return d===0;
}

// ID curto da mensagem (o mesmo no evento original, na edição e na exclusão).
const idCurto=(id:unknown)=>{const s=String(id??'');const m=/(?:^|_)([0-9A-F]{16,40})(?:_|$)/i.exec(s);return m?m[1].toUpperCase():s;};

Deno.serve(async request=>{
 if(request.method!=='POST')return new Response('Method not allowed',{status:405});
 const corpo=await request.text();
 if(!await assinaturaValida(corpo,request.headers.get('x-webhook-hmac')))return new Response('Unauthorized',{status:401});
 let evento:any;try{evento=JSON.parse(corpo)}catch{return new Response('Bad request',{status:400})}
 const tipo=String(evento?.event??'');
 if(!['message','message.edited','message.revoked'].includes(tipo))return Response.json({ok:true,ignorado:'evento'});
 const p=evento.payload??{};
 const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
 try{
  const agora=Math.floor(Date.now()/1000);
  const ts=Number(p.timestamp)||agora;
  const diaEnvio=diaSP(ts);
  const idOriginal=tipo==='message'?p.id:(p.editedMessageId??p.revokedMessageId??p.before?.id??p.after?.id??p.id);
  const grupo=String(tipo==='message'?p.from:(p.from??p.chatId??p.before?.from??p.after?.from??''));

  // 1) Só grupos. Conversa privada nunca é guardada.
  if(!grupo.endsWith('@g.us')){await client.rpc('wa_contar_descarte',{p_grupo:'privado',p_dia:diaEnvio,p_motivo:'nao_grupo'});return Response.json({ok:true,descartada:'nao_grupo'})}

  // 2) Só grupos cadastrados e ativos.
  const{data:g,error:eg}=await client.from('wa_grupos').select('jid,fornecedor,formato,remetentes,ativo').eq('jid',grupo).maybeSingle();
  if(eg)throw eg;
  if(!g||!g.ativo){await client.rpc('wa_contar_descarte',{p_grupo:grupo,p_dia:diaEnvio,p_motivo:'grupo_nao_permitido'});return Response.json({ok:true,descartada:'grupo'})}

  const id=idCurto(idOriginal);
  const recalcular=async(dia:string)=>{
   // Depois das 17h (ou de dias passados) o pendente é atualizado na hora; antes, o fechamento das 17h cuida disso.
   const hoje=diaSP(agora);
   if(dia<hoje||(dia===hoje&&horaSP(agora)>=17)){const{error}=await client.rpc('wa_fechar_dia',{p_dia:dia,p_fornecedor:g.fornecedor});if(error)throw error}
  };

  // 3) Mensagem apagada: sai do cálculo, e o pendente é refeito/avisado.
  if(tipo==='message.revoked'){
   const{data:m,error}=await client.from('wa_mensagens').update({status:'apagada'}).eq('id',id).eq('grupo',grupo).select('dia').maybeSingle();
   if(error)throw error;
   if(m)await recalcular(m.dia);
   return Response.json({ok:true,apagada:!!m});
  }

  // 4) Só remetentes autorizados (lista vazia = sem filtro, apenas na fase de teste).
  const remetente=numero(p.participant??p._data?.author??p._data?.key?.participant??p._data?.participant??p.author??'');
  const permitidos=(g.remetentes??[]).map(numero).filter(Boolean);
  if(permitidos.length&&!permitidos.includes(remetente)){await client.rpc('wa_contar_descarte',{p_grupo:grupo,p_dia:diaEnvio,p_motivo:'remetente'});return Response.json({ok:true,descartada:'remetente'})}
  if(tipo==='message'&&p.fromMe===true){await client.rpc('wa_contar_descarte',{p_grupo:grupo,p_dia:diaEnvio,p_motivo:'propria'});return Response.json({ok:true,descartada:'propria'})}

  // 5) Só texto no formato de lançamento. Conversa comum é descartada sem guardar o texto.
  const texto=String(p.body??p.text??p.caption??'');
  const r=ler(g.formato,texto,diaEnvio);
  if(r.tipo==='ignorar'){
   // Editada para virar conversa comum? Se já guardávamos, deixa de valer.
   if(tipo==='message.edited'){const{data:m}=await client.from('wa_mensagens').update({status:'apagada'}).eq('id',id).eq('grupo',grupo).select('dia').maybeSingle();if(m)await recalcular(m.dia)}
   await client.rpc('wa_contar_descarte',{p_grupo:grupo,p_dia:diaEnvio,p_motivo:'formato'});
   return Response.json({ok:true,descartada:'formato'});
  }

  const dia=r.tipo==='ok'?r.dia:diaEnvio;
  const linha={id,grupo,remetente:remetente||null,enviada_em:new Date(ts*1000).toISOString(),dia,texto:texto.slice(0,5000),
   itens:r.tipo==='ok'?r.itens:null,total_declarado:r.tipo==='ok'?r.total:null,status:r.tipo==='ok'?'valida':'revisao'};
  const{error}=await client.from('wa_mensagens').upsert(linha,{onConflict:'id'}); // mesma mensagem nunca duplica; edição substitui
  if(error)throw error;
  await recalcular(dia);
  return Response.json({ok:true,status:linha.status,dia,motivo:r.tipo==='revisao'?r.motivo:undefined});
 }catch(e){
  console.error('wa-receber falhou',e?.message??e);
  return Response.json({error:'falha ao processar'},{status:500}); // o WAHA tenta de novo
 }
});
