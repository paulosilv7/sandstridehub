// Regras puras dos pendentes do WhatsApp (sem tela, sem rede). Usado pela tela e pelos testes.
(function(root){
 'use strict';
 const norm=t=>String(t??'').trim().replace(/\s+/g,' ').toLowerCase();
 const br=iso=>String(iso).split('-').reverse().join('/');
 // Ordem de compra e IDs dos itens saem do ID do pendente: aprovar duas vezes nunca duplica a compra.
 function orderIdFor(pendenteId,date){
  const token=String(pendenteId).replace(/-/g,'').slice(0,8).toUpperCase();
  if(!/^[A-F0-9]{8}$/.test(token))throw new Error('Identificação do pendente inválida.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Data do pendente inválida.');
  return 'OC-'+date.replaceAll('-','')+'-'+token;
 }
 const entryPrefix=pendenteId=>'wa-'+pendenteId+'-';
 const entryId=(pendenteId,index)=>entryPrefix(pendenteId)+(index+1);
 const jaLancado=(entries,pendenteId)=>entries.filter(e=>typeof e.id==='string'&&e.id.startsWith(entryPrefix(pendenteId)));
 const inteiro=v=>/^[1-9]\d{0,5}$/.test(String(v).trim())?Number(String(v).trim()):null;

 // itens: [{tipo:'linha'|'abate', modelo_texto, produto_id, qtd}]
 // Cada abatimento sai da quantidade do modelo escolhido. Linhas do mesmo modelo se somam.
 function resolver(F,db,pendente,itens){
  const problemas=[],porProduto=new Map(),abates=[];
  const produtos=db.products.filter(p=>p.supplier===pendente.fornecedor);
  const achar=id=>produtos.find(p=>p.id===id);
  const linhasBrutas=itens.filter(i=>i.tipo==='linha');
  if(!linhasBrutas.length)problemas.push('Não há nenhuma linha para lançar.');
  for(const item of itens){
   const rotulo=item.modelo_texto||'item';
   const qtd=inteiro(item.qtd);
   if(qtd===null){problemas.push(`Quantidade inválida em "${rotulo}".`);continue}
   if(!item.produto_id){problemas.push(item.tipo==='abate'?`Escolha de qual modelo sair os ${qtd} pares cancelados.`:`Escolha o modelo de "${rotulo}".`);continue}
   const produto=achar(item.produto_id);
   if(!produto){problemas.push(`O modelo escolhido para "${rotulo}" não pertence a ${pendente.fornecedor}.`);continue}
   if(item.tipo==='linha'){
    if(produto.active===false){problemas.push(`${produto.name} está inativo. Reative o produto antes de aprovar.`);continue}
    const atual=porProduto.get(produto.id)||{produto,qtd:0,abatido:0};atual.qtd+=qtd;porProduto.set(produto.id,atual);
   }else abates.push({produto,qtd});
  }
  for(const a of abates){
   const alvo=porProduto.get(a.produto.id);
   if(!alvo){problemas.push(`${a.produto.name} não tem pares na lista para abater ${a.qtd}.`);continue}
   alvo.abatido+=a.qtd;
  }
  const linhas=[];let total=0,quantidade=0;
  for(const {produto,qtd,abatido} of porProduto.values()){
   const liquida=qtd-abatido;
   if(liquida<0){problemas.push(`${produto.name}: abatimento (${abatido}) maior que a quantidade (${qtd}).`);continue}
   if(liquida===0)continue;
   let preco=null;try{preco=F.priceAt(produto.prices,pendente.data)}catch{}
   if(!preco){problemas.push(`${produto.name} não tem preço vigente em ${br(pendente.data)}.`);continue}
   const value=F.total(liquida,preco.value);
   linhas.push({produtoId:produto.id,nome:produto.name,qtd:liquida,bruta:qtd,abatido,unit:preco.value,value});
   total+=value;quantidade+=liquida;
  }
  if(!problemas.length&&!linhas.length)problemas.push('Depois dos abatimentos não sobrou nenhum par para lançar.');
  const declarado=pendente.total_declarado==null?null:Number(pendente.total_declarado);
  return{ok:problemas.length===0,linhas,quantidade,total,declarado,diferenca:declarado===null?null:total-declarado,problemas};
 }
 const api={norm,orderIdFor,entryPrefix,entryId,jaLancado,resolver,inteiro};
 root.PendentesCore=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
