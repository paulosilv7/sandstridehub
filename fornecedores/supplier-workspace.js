// Mantém as operações financeiras dentro do contexto de um único fornecedor.
(function(){
 const F=FinanceCore,storageKey='sandstride-finance-active-supplier-v1';
 const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='supplier-workspace.css';document.head.append(stylesheet);
 const operationalPages=new Set(['Contas a pagar','Retiradas','Pagamentos','Produtos e preços','Relatórios']);
 let selectedSupplier='';
 try{selectedSupplier=localStorage.getItem(storageKey)||''}catch{}

 function remember(value){
  selectedSupplier=db.suppliers.includes(value)?value:'';
  try{selectedSupplier?localStorage.setItem(storageKey,selectedSupplier):localStorage.removeItem(storageKey)}catch{}
 }
 function normalize(){
  if(!db.suppliers.length)return;
  if(!db.suppliers.includes(selectedSupplier))selectedSupplier=db.suppliers.length===1?db.suppliers[0]:'';
  if(selectedSupplier)remember(selectedSupplier);
 }
 function supplierIndex(value){return db.suppliers.indexOf(value)}
 function setSupplier(value,destination){
  remember(value);
  if(selectedSupplier){payableSupplier=selectedSupplier;payableMonth=defaultPayableMonth(selectedSupplier);filter=selectedSupplier;}
  if(destination)page=destination;
  render();
 }
 window.chooseWorkspaceSupplier=value=>setSupplier(value);
 window.openSupplierWorkspace=(index,destination='Contas a pagar')=>{const value=db.suppliers[index];if(value)setSupplier(value,destination)};

 function options(){return db.suppliers.map(value=>`<option value="${esc(value)}" ${value===selectedSupplier?'selected':''}>${esc(value)}</option>`).join('')}
 function monthCount(view){return view.months.filter(row=>row[3]>0).length}
 function lastMovement(view){return [...view.activeEntries].sort((a,b)=>b.date.localeCompare(a.date)).at(0)?.date||''}
 function dateLabel(value){return value?value.split('-').reverse().join('/'):'Nenhum movimento'}
 function contextMarkup(){
  const view=selectedSupplier?F.supplierView(db,selectedSupplier):null;
  return `<section class="supplier-context" aria-label="Fornecedor em uso"><div class="supplier-context-heading"><div><span class="supplier-eyebrow">ESPAÇO DO FORNECEDOR</span><h2>${view?esc(view.supplier):'Escolha quem deseja consultar'}</h2><p>${view?'Todas as informações abaixo pertencem somente a este fornecedor.':'Selecione um fornecedor antes de consultar ou lançar informações.'}</p></div><div class="supplier-switch"><label for="workspaceSupplier">Fornecedor ativo</label><select id="workspaceSupplier" onchange="chooseWorkspaceSupplier(this.value)"><option value="">Selecionar fornecedor</option>${options()}</select></div></div>${view?`<div class="supplier-context-metrics"><div><span>Saldo a pagar</span><strong>${money(view.balance)}</strong></div><div><span>Meses em aberto</span><strong>${monthCount(view)}</strong></div><div><span>Produtos ativos</span><strong>${view.products.filter(item=>item.active!==false).length}</strong></div><div><span>Último movimento</span><strong>${dateLabel(lastMovement(view))}</strong></div></div>`:''}</section>`;
 }
 function selectionRequired(){
  app.innerHTML=`${contextMarkup()}<section class="supplier-required"><div class="supplier-required-icon" aria-hidden="true">→</div><div><span>PRIMEIRO PASSO</span><h1>Selecione um fornecedor</h1><p>Compras, pagamentos, produtos, competências e relatórios serão exibidos separadamente para evitar lançamentos na conta errada.</p></div></section>`;
  window.enhanceFinanceUI?.(app);
 }
 function hideSupplierColumn(tableElement){
  if(!tableElement)return;const headers=[...tableElement.querySelectorAll('th')],index=headers.findIndex(header=>header.textContent.trim()==='Fornecedor');if(index<0)return;
  headers[index].classList.add('workspace-supplier-column');tableElement.querySelectorAll('tbody tr').forEach(row=>row.cells[index]?.classList.add('workspace-supplier-column'));
 }
 function scopeTables(){
  let visible=0;
  app.querySelectorAll('.table').forEach(container=>{
   const headers=[...container.querySelectorAll('th')],supplierColumn=headers.findIndex(header=>header.textContent.trim()==='Fornecedor');
   if(supplierColumn>=0)container.querySelectorAll('tbody tr').forEach(row=>{const match=row.cells[supplierColumn]?.textContent.trim()===selectedSupplier;row.hidden=!match;if(match)visible++});
   hideSupplierColumn(container);
  });
  const search=app.querySelector('.listsearch');if(search)search.oninput=()=>{const term=search.value.toLocaleLowerCase('pt-BR');app.querySelectorAll('.table tbody tr').forEach(row=>{const supplierCell=[...row.cells].find(cell=>cell.dataset.label==='Fornecedor'),sameSupplier=supplierCell?.textContent.trim()===selectedSupplier;row.hidden=!sameSupplier||!row.textContent.toLocaleLowerCase('pt-BR').includes(term)})};
  if(!visible&&!['Contas a pagar','Relatórios'].includes(page)){const empty=document.createElement('div');empty.className='workspace-empty';empty.innerHTML=`<strong>Nenhum registro para ${esc(selectedSupplier)}</strong><span>Use a ação principal desta tela para criar o primeiro registro.</span>`;app.querySelector('.table')?.after(empty)}
 }
 function contextualizePage(){
  const title=app.querySelector('h1');if(title){const names={'Contas a pagar':'Saldos a pagar','Retiradas':'Compras','Pagamentos':'Histórico de pagamentos','Produtos e preços':'Produtos e preços','Relatórios':'Relatório'};title.textContent=`${names[page]||page} · ${selectedSupplier}`;}
  const subtitle=title?.nextElementSibling;if(subtitle&&page==='Contas a pagar')subtitle.textContent='Consulte uma competência por vez e acompanhe o valor restante deste fornecedor.';
  if(page==='Contas a pagar'){app.querySelector('.payable-filters>div:first-child')?.remove();const monthLabelElement=app.querySelector('.payable-filters label');if(monthLabelElement)monthLabelElement.textContent='Competência';app.querySelector('.payable-context>div:first-child')?.remove();}
  const first=app.firstElementChild;first?.insertAdjacentHTML('beforebegin',contextMarkup());
  scopeTables();window.enhanceFinanceUI?.(app);
 }
 function supplierCards(){
  return `<section class="supplier-card-grid">${db.suppliers.map((name,index)=>{const view=F.supplierView(db,name),open=monthCount(view);return `<article class="supplier-card"><div class="supplier-card-top"><span>${esc(name.slice(0,1).toUpperCase())}</span><em>${open?open+' '+(open===1?'mês em aberto':'meses em aberto'):'Sem pendências'}</em></div><h3>${esc(name)}</h3><div class="supplier-card-balance"><span>Saldo a pagar</span><strong>${money(view.balance)}</strong></div><div class="supplier-card-meta"><span>${view.products.filter(item=>item.active!==false).length} produtos ativos</span><span>${view.activeEntries.length} movimentos</span></div><div class="supplier-card-actions"><button class="primary" onclick="openSupplierWorkspace(${index})">Abrir financeiro</button><button onclick="openSupplierWorkspace(${index},'Relatórios')">Ver extrato</button></div></article>`}).join('')}</section>`;
 }
 function renderDirectory(){
  const tableElement=app.querySelector('.table');if(!tableElement)return;tableElement.replaceWith(document.createRange().createContextualFragment(supplierCards()));
  const search=app.querySelector('.listsearch');if(search){search.placeholder='Buscar fornecedor…';search.oninput=()=>{const term=search.value.toLocaleLowerCase('pt-BR');app.querySelectorAll('.supplier-card').forEach(card=>card.hidden=!card.textContent.toLocaleLowerCase('pt-BR').includes(term))}}
  const title=app.querySelector('h1');if(title)title.textContent='Carteira de fornecedores';const subtitle=title?.nextElementSibling;if(subtitle)subtitle.textContent='Escolha um fornecedor para abrir seu espaço financeiro individual.';
 }
 function renderPortfolio(){
  const toolbar=app.querySelector('.toolbar'),tableElement=app.querySelector('.table');if(!toolbar||!tableElement)return;
  toolbar.innerHTML='<div><span class="supplier-eyebrow">ACESSO RÁPIDO</span><h2>Abra um fornecedor</h2></div><span class="portfolio-hint">Compras e pagamentos ficam separados por parceiro.</span>';
  tableElement.replaceWith(document.createRange().createContextualFragment(supplierCards()));
  const title=app.querySelector('h1');if(title)title.textContent='Visão geral da carteira';
 }
 function preselectForm(type,id){
  if(!selectedSupplier||id||!['purchase','payment','credit','product'].includes(type)||!modal.open)return;
  const form=document.getElementById('form'),supplier=form.elements.namedItem('supplier');if(!supplier)return;
  supplier.value=selectedSupplier;supplier.dispatchEvent(new Event('change',{bubbles:true}));
  const fixed=document.createElement('input');fixed.type='hidden';fixed.name='supplier';fixed.value=selectedSupplier;supplier.name='supplierDisplay';supplier.disabled=true;
  supplier.closest('.select-field')?.after(fixed);
  const note=document.createElement('div');note.className='supplier-form-context';note.innerHTML=`<span>FORNECEDOR DESTE LANÇAMENTO</span><strong>${esc(selectedSupplier)}</strong><small>Confira o nome antes de salvar.</small>`;document.getElementById('fields').prepend(note);
 }

 const priorRender=render;
 render=function(){
  normalize();
  if(page==='Contas a pagar'&&db.suppliers.includes(payableSupplier)&&payableSupplier!==selectedSupplier)remember(payableSupplier);
  if(page==='Relatórios'&&db.suppliers.includes(filter)&&filter!==selectedSupplier)remember(filter);
  if(operationalPages.has(page)&&selectedSupplier){payableSupplier=selectedSupplier;if(!payableMonth)payableMonth=defaultPayableMonth(selectedSupplier);filter=selectedSupplier;}
  priorRender();
  if(page==='Painel')renderPortfolio();else if(page==='Fornecedores')renderDirectory();else if(operationalPages.has(page)){if(!selectedSupplier)selectionRequired();else contextualizePage();}
 };
 const priorOpen=openForm;openForm=function(type,id){priorOpen(type,id);preselectForm(type,id)};
 render();
})();
