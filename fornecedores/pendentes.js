// Quadro "Pendentes do WhatsApp" no Painel de Fornecedores, logo abaixo do saldo devedor total: lançamentos que a Sandy montou a partir dos grupos.
// Nada vira compra sozinho: a pessoa confere, corrige e aprova; a gravação usa o mesmo save()/fin_commit das outras telas.
(function(){
 const C=PendentesCore,F=FinanceCore,QID='wa-quadro';
 const css=document.createElement('link');css.rel='stylesheet';css.href='pendentes.css';document.head.append(css);
 const br=iso=>String(iso).split('-').reverse().join('/');
 const hora=iso=>new Date(iso).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'});
 const client=()=>window.SandstrideClient;
 let estado={carregado:false,carregando:false,erro:'',em:0,pendentes:[],itens:{},originais:{},mensagens:[],grupos:[],n:0,nEm:0};
 let alterados=new Set(),ocupado=false,aviso='',abertosUI=new Set();

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
 function situacao(p){
  const r=resolver(p);
  if(!r.ok)return{r,cls:'atencao',txt:'Precisa de atenção'};
  if(r.declarado!==null&&r.diferenca!==0)return{r,cls:'diverge',txt:'Total diferente'};
  return{r,cls:'ok',txt:r.declarado===null?'Pronto para conferir':'Confere'};
 }
 function itemHtml(p){
  const msgs=mensagensDe(p),editado=alterados.has(p.id)||p.editado,st=situacao(p),aberto=abertosUI.has(p.id);
  return `<details class="wa-item" data-id="${esc(p.id)}" ${aberto?'open':''}><summary><span class="wa-quem"><strong>${esc(p.fornecedor)}</strong><small>Compra do dia ${br(p.data)}</small></span><span class="wa-num"><b>${st.r.quantidade} pares</b><small>${money(st.r.total)}</small></span><span class="wa-estado ${st.cls}">${st.txt}</span><span class="wa-abrir" aria-hidden="true">Conferir e aprovar</span></summary>
  <div class="wa-corpo"><div class="wa-topo"><span class="wa-badge ${editado?'edit':''}">${editado?'Corrigido por você':'Lido da mensagem'}</span></div>
  ${p.aviso?`<p class="wa-aviso">${esc(p.aviso)}</p>`:''}
  <div class="wa-tabela"><table><thead><tr><th></th><th>Como veio na mensagem</th><th>Modelo</th><th>Pares</th></tr></thead><tbody>${linhasHtml(p)}</tbody></table></div>
  <div class="wa-resumo">${resumoHtml(p)}</div>
  <details class="wa-msgs"><summary>Mensagens lidas (${msgs.length})</summary>${msgs.map(m=>`<div class="wa-msg ${m.status}"><small>${hora(m.enviada_em)}${m.status==='apagada'?' · apagada':''}${m.status==='revisao'?' · não entendida':''}</small><pre>${esc(m.texto)}</pre></div>`).join('')||'<p class="wa-nota">Nenhuma mensagem guardada para este dia.</p>'}</details>
  <footer><button type="button" data-acao="descartar">Descartar</button><button type="button" data-acao="salvar">Salvar correções</button><button type="button" class="primary" data-acao="aprovar">Aprovar e lançar compra</button></footer></div></details>`;
 }
 function revisaoHtml(){
  const abertos=new Set(estado.pendentes.filter(p=>p.status==='aberto').map(p=>p.fornecedor+'|'+p.data));
  const lista=estado.mensagens.filter(m=>m.status==='revisao').map(m=>({m,g:estado.grupos.find(g=>g.jid===m.grupo)})).filter(({m,g})=>g&&!abertos.has(g.fornecedor+'|'+m.dia));
  if(!lista.length)return '';
  return `<details class="wa-sec"><summary>Mensagens que o sistema não entendeu (${lista.length})</summary><p class="wa-nota">Nenhum pendente foi criado a partir delas. Veja o texto e lance a compra manualmente em <a href="#" data-ir="Compras">Compras</a>.</p>${lista.map(({m,g})=>`<div class="wa-msg revisao"><small>${esc(g.fornecedor)} · ${br(m.dia)} ${hora(m.enviada_em)}</small><pre>${esc(m.texto)}</pre></div>`).join('')}</details>`;
 }
 function recentesHtml(){
  const lista=estado.pendentes.filter(p=>p.status!=='aberto');if(!lista.length)return '';
  return `<details class="wa-sec"><summary>Já resolvidos nos últimos 14 dias (${lista.length})</summary><div class="wa-tabela"><table><thead><tr><th>Dia</th><th>Fornecedor</th><th>Situação</th><th>Ordem de compra</th></tr></thead><tbody>${lista.map(p=>`<tr><td>${br(p.data)}</td><td>${esc(p.fornecedor)}</td><td>${p.status==='aprovado'?'Aprovado':'Descartado'}</td><td>${esc(p.order_id||'—')}</td></tr>`).join('')}</tbody></table></div></details>`;
 }
 // Desenha o quadro logo depois do saldo devedor total. Sem nada para decidir (ou sem acesso), não aparece.
 function paint(){
  if(page!=='Painel')return;
  const hero=app.querySelector('.hero');let q=document.getElementById(QID);
  if(!hero){q?.remove();return}
  const abertos=estado.pendentes.filter(p=>p.status==='aberto');
  const revisao=estado.carregado&&!estado.erro?revisaoHtml():'';
  const semAcesso=/não tem acesso/.test(estado.erro);
  if(!estado.carregado&&!estado.erro||semAcesso||(estado.carregado&&!abertos.length&&!revisao&&!aviso)){q?.remove();return}
  let corpo;
  if(estado.erro)corpo=`<div class="form-error" role="alert">${esc(estado.erro)}</div>`;
  else corpo=abertos.map(itemHtml).join('')+revisao+(abertos.length?recentesHtml():'');
  const n=abertos.length;
  const html=`<div class="wa-cab"><div><span class="supplier-eyebrow">PENDENTES DO WHATSAPP</span><h2>${n?(n===1?'1 pedido aguardando aprovação':n+' pedidos aguardando aprovação'):'Nada aguardando aprovação'}</h2></div><p class="wa-nota">Pares lidos nos grupos dos fornecedores. Nada entra no financeiro até você aprovar.</p></div>${aviso?`<div class="wa-aviso" role="status">${esc(aviso)}</div>`:''}${corpo}`;
  if(!q){q=document.createElement('section');q.id=QID;q.className='wa-quadro';q.setAttribute('aria-label','Pendentes do WhatsApp')}
  q.innerHTML=html;
  if(q.previousElementSibling!==hero)hero.after(q);
 }

 // Troca de modelo ou quantidade: refaz só o resumo, a etiqueta de situação e o total da linha do pedido.
 function atualizarCard(card){
  const p=estado.pendentes.find(x=>x.id===card.dataset.id);if(!p)return;
  card.querySelector('.wa-resumo').innerHTML=resumoHtml(p);
  const badge=card.querySelector('.wa-badge');badge.textContent='Corrigido por você';badge.classList.add('edit');
  const st=situacao(p),e=card.querySelector('.wa-estado'),n=card.querySelector('.wa-num');
  e.className='wa-estado '+st.cls;e.textContent=st.txt;n.innerHTML=`<b>${st.r.quantidade} pares</b><small>${money(st.r.total)}</small>`;
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
 const dentro=el=>!!el?.closest?.('#'+QID);
 app.addEventListener('click',ev=>{
  if(!dentro(ev.target))return;
  const ir=ev.target.closest('[data-ir]');if(ir){ev.preventDefault();navTo(ir.dataset.ir);return}
  const botao=ev.target.closest('[data-acao]');if(!botao||ocupado)return;
  const card=botao.closest('.wa-item'),p=estado.pendentes.find(x=>x.id===card?.dataset.id);if(!p)return;
  if(botao.dataset.acao==='aprovar')aprovar(p);else if(botao.dataset.acao==='salvar')salvar(p);else if(botao.dataset.acao==='descartar')descartar(p);
 });
 // Lembra quais pedidos estão abertos: a tela é refeita a cada gravação.
 app.addEventListener('toggle',ev=>{
  const d=ev.target;if(!d.classList?.contains('wa-item'))return;
  if(d.open)abertosUI.add(d.dataset.id);else abertosUI.delete(d.dataset.id);
 },true);
 function mudou(ev){
  const campo=ev.target.dataset?.campo;if(!campo||!dentro(ev.target))return;
  const card=ev.target.closest('.wa-item'),linha=ev.target.closest('tr[data-item]');if(!card||!linha)return;
  const p=estado.pendentes.find(x=>x.id===card.dataset.id),item=itensDe(p).find(i=>i.id===linha.dataset.item);if(!item)return;
  if(campo==='produto')item.produto_id=ev.target.value||null;else item.qtd=ev.target.value.trim();
  alterados.add(p.id);atualizarCard(card);
 }
 app.addEventListener('input',mudou);app.addEventListener('change',mudou);

 /* ---------- ligação com o Painel ---------- */
 const anterior=render;
 render=function(){
  anterior();
  if(page==='Painel'){paint();if(!estado.carregando&&Date.now()-estado.em>4000)carregar().then(paint)}
  else aviso='';
 };
 render();
})();
