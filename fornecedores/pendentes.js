// Tela "Pendentes": lançamentos que a Sandy montou a partir dos grupos do WhatsApp.
// Nada vira compra sozinho: a pessoa confere, corrige e aprova; a gravação usa o mesmo save()/fin_commit das outras telas.
(function(){
 const C=PendentesCore,F=FinanceCore,NAV='Pendentes';
 const css=document.createElement('link');css.rel='stylesheet';css.href='pendentes.css';document.head.append(css);
 const ICON='<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/><path d="m9 12 2 2 4-4"/></svg>';
 const br=iso=>String(iso).split('-').reverse().join('/');
 const hora=iso=>new Date(iso).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
 const client=()=>window.SandstrideClient;
 let estado={carregado:false,carregando:false,erro:'',em:0,pendentes:[],itens:{},originais:{},mensagens:[],grupos:[],n:0,nEm:0};
 let alterados=new Set(),ocupado=false,aviso='';

 function ativos(fornecedor){return db.products.filter(p=>p.supplier===fornecedor&&p.active!==false)}
 function itensDe(p){return estado.itens[p.id]||[]}
 function resolver(p){try{return C.resolver(F,db,p,itensDe(p))}catch(e){return{ok:false,linhas:[],quantidade:0,total:0,declarado:null,diferenca:null,problemas:[e.message||'Não foi possível conferir.']}}}

 async function carregar(){
  const c=client();if(!c){estado.erro='A conexão ainda não está pronta. Tente atualizar.';return}
  if(estado.carregando)return;estado.carregando=true;
  try{
   const desde=new Date(Date.now()-14*864e5).toISOString().slice(0,10);
   const [pend,grupos]=await Promise.all([
    c.from('wa_pendentes').select('*').gte('data',desde).order('data',{ascending:false}).order('fornecedor'),
    c.from('wa_grupos').select('jid,fornecedor,formato,ativo')]);
   if(pend.error)throw pend.error;if(grupos.error)throw grupos.error;
   const ids=pend.data.map(p=>p.id),jids=grupos.data.map(g=>g.jid);
   const [itens,msgs]=await Promise.all([
    ids.length?c.from('wa_pendentes_itens').select('*').in('pendente_id',ids).order('ordem'):{data:[]},
    jids.length?c.from('wa_mensagens').select('id,grupo,remetente,enviada_em,dia,texto,status').in('grupo',jids).gte('dia',desde).order('enviada_em'):{data:[]}]);
   if(itens.error)throw itens.error;if(msgs.error)throw msgs.error;
   estado.pendentes=pend.data;estado.grupos=grupos.data;estado.mensagens=msgs.data;
   for(const p of pend.data){
    const lista=itens.data.filter(i=>i.pendente_id===p.id);
    estado.originais[p.id]=Object.fromEntries(lista.map(i=>[i.id,{produto_id:i.produto_id,qtd:i.qtd}]));
    if(!alterados.has(p.id))estado.itens[p.id]=lista.map(i=>({id:i.id,tipo:i.tipo,modelo_texto:i.modelo_texto,produto_id:i.produto_id,qtd:i.qtd}));
   }
   estado.n=pend.data.filter(p=>p.status==='aberto').length;estado.nEm=Date.now();
   estado.erro='';estado.carregado=true;estado.em=Date.now();
  }catch(e){estado.erro=e?.code==='42501'||/permission|policy/i.test(e?.message||'')?'Seu usuário não tem acesso aos pendentes.':'Não foi possível carregar os pendentes. Confira a conexão e atualize.';console.error('pendentes',e)}
  finally{estado.carregando=false}
 }

 function mensagensDe(p){
  const jids=estado.grupos.filter(g=>g.fornecedor===p.fornecedor).map(g=>g.jid);
  return estado.mensagens.filter(m=>jids.includes(m.grupo)&&m.dia===p.data);
 }
 const opcoes=(lista,atual,vazio)=>`<option value="">${esc(vazio)}</option>`+lista.map(x=>`<option value="${esc(x.id)}" ${x.id===atual?'selected':''}>${esc(x.name)}</option>`).join('');
 function linhasHtml(p){
  const lista=ativos(p.fornecedor);
  return itensDe(p).map(i=>`<tr data-item="${esc(i.id)}"><td><span class="wa-tipo ${i.tipo}">${i.tipo==='abate'?'Abatimento':'Linha'}</span></td><td class="wa-veio">${esc(i.modelo_texto||'—')}</td><td><select aria-label="${i.tipo==='abate'?'Abater de qual modelo':'Modelo'}" data-campo="produto">${opcoes(lista,i.produto_id,i.tipo==='abate'?'De qual modelo abater?':'Escolha o modelo')}</select></td><td><input data-campo="qtd" inputmode="numeric" autocomplete="off" aria-label="Quantidade" value="${esc(i.qtd)}"></td></tr>`).join('');
 }
 function resumoHtml(p){
  const r=resolver(p),ja=C.jaLancado(db.entries,p.id).length>0;
  const compara=r.declarado===null?'<span class="wa-nota">A mensagem não trouxe total para conferir.</span>'
   :r.diferenca===0?'<span class="wa-ok">Confere com o total da mensagem.</span>'
   :`<span class="wa-diverge">Diferente do total da mensagem (${money(r.declarado)}): ${r.diferenca>0?'+':'−'} ${money(Math.abs(r.diferenca))}. Confira no WhatsApp.</span>`;
  const itens=r.linhas.length?`<ul class="wa-final">${r.linhas.map(l=>`<li><span>${esc(l.nome)}${l.abatido?` <small>(${l.bruta} − ${l.abatido} cancelados)</small>`:''}</span><span>${l.qtd} × ${money(l.unit)}</span><b>${money(l.value)}</b></li>`).join('')}</ul>`:'';
  const probs=r.problemas.length?`<ul class="wa-problemas">${r.problemas.map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`:'';
  const jaTxt=ja?'<p class="wa-aviso">Esta compra já foi gravada no financeiro. Ao aprovar, o pendente só será marcado como aprovado, sem duplicar.</p>':'';
  return `<div class="wa-total"><div><span>Quantidade</span><strong>${r.quantidade} pares</strong></div><div><span>Total calculado pelo preço do dia</span><strong>${money(r.total)}</strong></div></div><p>${compara}</p>${itens}${probs}${jaTxt}`;
 }
 function cardHtml(p){
  const msgs=mensagensDe(p),editado=alterados.has(p.id)||p.editado;
  return `<article class="wa-card" data-id="${esc(p.id)}"><header><div><span class="supplier-eyebrow">PENDENTE DO WHATSAPP</span><h2>${esc(p.fornecedor)}</h2><small>Compra do dia ${br(p.data)}</small></div><span class="wa-badge ${editado?'edit':''}">${editado?'Corrigido por você':'Lido da mensagem'}</span></header>
  ${p.aviso?`<p class="wa-aviso">${esc(p.aviso)}</p>`:''}
  <div class="wa-tabela"><table><thead><tr><th></th><th>Como veio na mensagem</th><th>Modelo</th><th>Pares</th></tr></thead><tbody>${linhasHtml(p)}</tbody></table></div>
  <div class="wa-resumo">${resumoHtml(p)}</div>
  <details class="wa-msgs"><summary>Mensagens lidas (${msgs.length})</summary>${msgs.map(m=>`<div class="wa-msg ${m.status}"><small>${hora(m.enviada_em)}${m.status==='apagada'?' · apagada':''}${m.status==='revisao'?' · não entendida':''}</small><pre>${esc(m.texto)}</pre></div>`).join('')||'<p class="wa-nota">Nenhuma mensagem guardada para este dia.</p>'}</details>
  <footer><button type="button" data-acao="descartar">Descartar</button><button type="button" data-acao="salvar">Salvar correções</button><button type="button" class="primary" data-acao="aprovar">Aprovar e lançar compra</button></footer></article>`;
 }
 function revisaoHtml(){
  const abertos=new Set(estado.pendentes.filter(p=>p.status==='aberto').map(p=>p.fornecedor+'|'+p.data));
  const lista=estado.mensagens.filter(m=>m.status==='revisao').map(m=>({m,g:estado.grupos.find(g=>g.jid===m.grupo)})).filter(({m,g})=>g&&!abertos.has(g.fornecedor+'|'+m.dia));
  if(!lista.length)return '';
  return `<section class="wa-revisao"><h2>Mensagens que o sistema não entendeu</h2><p class="muted">Nenhum pendente foi criado a partir delas. Veja o texto e lance a compra manualmente em <a href="#" data-ir="Retiradas">Compras</a>.</p>${lista.map(({m,g})=>`<div class="wa-msg revisao"><small>${esc(g.fornecedor)} · ${br(m.dia)} ${hora(m.enviada_em)}</small><pre>${esc(m.texto)}</pre></div>`).join('')}</section>`;
 }
 function recentesHtml(){
  const lista=estado.pendentes.filter(p=>p.status!=='aberto');if(!lista.length)return '';
  return `<details class="wa-recentes"><summary>Já resolvidos nos últimos 14 dias (${lista.length})</summary><div class="table"><table><thead><tr><th>Dia</th><th>Fornecedor</th><th>Situação</th><th>Ordem de compra</th></tr></thead><tbody>${lista.map(p=>`<tr><td>${br(p.data)}</td><td>${esc(p.fornecedor)}</td><td>${p.status==='aprovado'?'Aprovado':'Descartado'}</td><td>${esc(p.order_id||'—')}</td></tr>`).join('')}</tbody></table></div></details>`;
 }
 function paint(){
  if(page!==NAV)return;
  const abertos=estado.pendentes.filter(p=>p.status==='aberto');
  let corpo;
  if(estado.erro)corpo=`<div class="form-error" role="alert">${esc(estado.erro)}</div>`;
  else if(!estado.carregado)corpo='<div class="wa-vazio">Carregando pendentes…</div>';
  else if(!estado.grupos.length)corpo='<div class="wa-vazio"><strong>Nenhum grupo de fornecedor cadastrado ainda.</strong><span>Quando os grupos forem cadastrados, os pendentes aparecem aqui.</span></div>';
  else corpo=(abertos.length?abertos.map(cardHtml).join(''):'<div class="wa-vazio"><strong>Nenhum pendente aberto.</strong><span>O fechamento do dia acontece às 17h. Pendentes novos aparecem aqui.</span></div>')+revisaoHtml()+recentesHtml();
  app.innerHTML=`<div class="wa-pagina"><h1>Pendentes do WhatsApp</h1><p class="muted">Pares lidos nos grupos dos fornecedores. Confira, corrija o que precisar e aprove para lançar a compra.</p>${aviso?`<div class="wa-aviso" role="status">${esc(aviso)}</div>`:''}${corpo}</div>`;
 }
 function atualizarCard(card){
  const p=estado.pendentes.find(x=>x.id===card.dataset.id);if(!p)return;
  card.querySelector('.wa-resumo').innerHTML=resumoHtml(p);
  const badge=card.querySelector('.wa-badge');badge.textContent='Corrigido por você';badge.classList.add('edit');
 }

 /* ---------- gravação ---------- */
 async function usuario(){const{data}=await client().auth.getUser();if(!data?.user)throw new Error('Sessão expirada. Entre novamente.');return data.user.id}
 async function persistirItens(p){
  const c=client(),orig=estado.originais[p.id]||{};
  for(const i of itensDe(p)){
   const o=orig[i.id];if(o&&o.produto_id===i.produto_id&&Number(o.qtd)===Number(i.qtd))continue;
   const qtd=C.inteiro(i.qtd);if(qtd===null)throw new Error('Quantidade inválida em "'+(i.modelo_texto||'item')+'".');
   const r=await c.from('wa_pendentes_itens').update({produto_id:i.produto_id||null,qtd}).eq('id',i.id);if(r.error)throw r.error;
  }
  // Aprende o apelido: da próxima vez o modelo já vem escolhido.
  for(const i of itensDe(p)){
   const o=orig[i.id];if(i.tipo!=='linha'||!i.produto_id||(o&&o.produto_id)||!i.modelo_texto||i.modelo_texto==='Soma do dia')continue;
   const a=C.norm(i.modelo_texto);if(!a)continue;
   const r=await c.from('wa_apelidos').upsert({fornecedor:p.fornecedor,apelido:a,produto_id:i.produto_id},{onConflict:'fornecedor,apelido'});if(r.error)console.error('apelido',r.error);
  }
 }
 async function travar(fn){
  if(ocupado)return;ocupado=true;aviso='';document.body.classList.add('wa-ocupado');
  try{await fn()}catch(e){console.error('pendentes',e);aviso=e?.message&&!e.code?e.message:'Não foi possível concluir. Nada foi duplicado; confira e tente de novo.'}
  finally{ocupado=false;document.body.classList.remove('wa-ocupado');while(estado.carregando)await new Promise(r=>setTimeout(r,80));await carregar();paint()}
 }
 async function salvar(p){
  await travar(async()=>{
   await persistirItens(p);
   const r=await client().from('wa_pendentes').update({editado:true,atualizado_em:new Date().toISOString()}).eq('id',p.id).eq('status','aberto');if(r.error)throw r.error;
   alterados.delete(p.id);aviso='Correções salvas. O fechamento das 17h não vai sobrescrever o que você ajustou.';
  });
 }
 async function descartar(p){
  if(!confirm(`Descartar o pendente de ${p.fornecedor} do dia ${br(p.data)}? Nada será lançado no financeiro.`))return;
  await travar(async()=>{
   const r=await client().from('wa_pendentes').update({status:'descartado',atualizado_em:new Date().toISOString()}).eq('id',p.id).eq('status','aberto');if(r.error)throw r.error;
   alterados.delete(p.id);aviso='Pendente descartado.';
  });
 }
 async function aprovar(p){
  const r=resolver(p);if(!r.ok){aviso='Corrija os pontos em vermelho antes de aprovar.';paint();return}
  if(typeof window.isInactiveSupplier==='function'&&window.isInactiveSupplier(p.fornecedor)){aviso=p.fornecedor+' está inativo. Reative o fornecedor antes de aprovar.';paint();return}
  const ja=C.jaLancado(db.entries,p.id);
  if(!ja.length){
   const ok=confirm(`CONFIRA ANTES DE LANÇAR\n\nFornecedor: ${p.fornecedor}\nData: ${br(p.data)}\nQuantidade total: ${r.quantidade}\nValor total: ${money(r.total)}\n\nOs dados acima estão corretos?`);if(!ok)return;
  }
  await travar(async()=>{
   let orderId=C.orderIdFor(p.id,p.data);
   if(ja.length)orderId=ja[0].purchaseOrderId||orderId;
   else{
    const ids=r.linhas.map((_,i)=>C.entryId(p.id,i));
    const entries=F.purchaseEntries(db,p.fornecedor,p.data,r.linhas.map(l=>({product:l.produtoId,qty:l.qtd,unit:l.unit})),'Lançado pelo WhatsApp · pendente '+p.id.slice(0,8),ids,orderId);
    const next=structuredClone(db);next.entries.push(...entries);F.validateSnapshot(next);db=next;
    const salvo=await save();
    if(!salvo)throw new Error('A compra não foi gravada no financeiro. Confira a mensagem no topo da tela e tente de novo.');
   }
   const user=await usuario();
   await persistirItens(p);
   const up=await client().from('wa_pendentes').update({status:'aprovado',order_id:orderId,aprovado_em:new Date().toISOString(),aprovado_por:user,editado:true,atualizado_em:new Date().toISOString()}).eq('id',p.id).eq('status','aberto');
   if(up.error)throw new Error('A compra foi gravada, mas não consegui marcar o pendente como aprovado. Clique em Aprovar de novo: a compra não será duplicada.');
   alterados.delete(p.id);aviso=`Compra lançada: ${r.quantidade} pares de ${p.fornecedor}, ${money(r.total)}.`;
  });
 }

 /* ---------- eventos ---------- */
 app.addEventListener('click',ev=>{
  const ir=ev.target.closest('[data-ir]');if(ir&&page===NAV){ev.preventDefault();navTo(ir.dataset.ir);return}
  const botao=ev.target.closest('[data-acao]');if(!botao||page!==NAV||ocupado)return;
  const card=botao.closest('.wa-card'),p=estado.pendentes.find(x=>x.id===card?.dataset.id);if(!p)return;
  if(botao.dataset.acao==='aprovar')aprovar(p);else if(botao.dataset.acao==='salvar')salvar(p);else if(botao.dataset.acao==='descartar')descartar(p);
 });
 function mudou(ev){
  const campo=ev.target.dataset?.campo;if(!campo||page!==NAV)return;
  const card=ev.target.closest('.wa-card'),linha=ev.target.closest('tr[data-item]');if(!card||!linha)return;
  const p=estado.pendentes.find(x=>x.id===card.dataset.id),item=itensDe(p).find(i=>i.id===linha.dataset.item);if(!item)return;
  if(campo==='produto')item.produto_id=ev.target.value||null;else item.qtd=ev.target.value.trim();
  alterados.add(p.id);atualizarCard(card);
 }
 app.addEventListener('input',mudou);app.addEventListener('change',mudou);

 /* ---------- menu e contador ---------- */
 function marcarMenu(){
  const nav=document.getElementById('nav');if(!nav||nav.querySelector('[data-pend]'))return;
  const b=document.createElement('button');b.type='button';b.dataset.pend='1';b.className=page===NAV?'active':'';b.onclick=()=>navTo(NAV);b.innerHTML='<span>'+ICON+'</span>'+NAV;
  if(estado.n)b.dataset.n=String(estado.n);
  const primeiro=nav.firstElementChild;if(primeiro)primeiro.after(b);else nav.append(b);
 }
 async function contador(){
  if(!client()||Date.now()-estado.nEm<20000)return;estado.nEm=Date.now();
  try{const r=await client().from('wa_pendentes').select('id',{count:'exact',head:true}).eq('status','aberto');if(r.error)return;estado.n=r.count||0;const b=document.querySelector('#nav [data-pend]');if(b){if(estado.n)b.dataset.n=String(estado.n);else delete b.dataset.n}}catch{}
 }
 const anterior=render;
 render=function(){
  anterior();marcarMenu();
  if(page===NAV){paint();if(!estado.carregando&&Date.now()-estado.em>4000)carregar().then(paint)}
  else{aviso='';contador()}
 };
 render();
})();
