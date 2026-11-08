// Mantém as operações financeiras dentro do contexto de um único fornecedor.
(function(){
 const F=FinanceCore;
 const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='supplier-workspace.css';document.head.append(stylesheet);
 const operationalPages=new Set(['Contas a pagar','Retiradas','Pagamentos','Produtos e preços','Relatórios']);
 let selectedSupplier='';
 let portfolioFrom='';
 let portfolioTo='';
 let directoryFilter='active';
 const inactive=name=>typeof window.isInactiveSupplier==='function'&&window.isInactiveSupplier(name);
 window.currentWorkspaceSupplier=()=>selectedSupplier;

 function remember(value){
  selectedSupplier=db.suppliers.includes(value)?value:'';
 }
 function normalize(){
  if(!db.suppliers.includes(selectedSupplier))selectedSupplier='';
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

 const priorNavTo=navTo;
 navTo=function(destination){
  if(operationalPages.has(destination)){
   remember('');
   payableSupplier='';
   payableMonth='';
   filter='';
   reportFrom='';
   reportTo='';
  }
  priorNavTo(destination);
 };

 function selectableSuppliers(){return db.suppliers.filter(value=>!inactive(value)||value===selectedSupplier)}
 function options(){return selectableSuppliers().map(value=>`<option value="${esc(value)}" ${value===selectedSupplier?'selected':''}>${esc(value)}${inactive(value)?' · Inativo':''}</option>`).join('')}
 function monthCount(view){return view.months.filter(row=>row[3]>0).length}
 function lastMovement(view){return [...view.activeEntries].sort((a,b)=>b.date.localeCompare(a.date)).at(0)?.date||''}
 function dateLabel(value){return value?value.split('-').reverse().join('/'):'Nenhum movimento'}
 function pageIdentity(){
  const identities={
   'Contas a pagar':{key:'balances',eyebrow:'SALDOS A PAGAR',title:'Consulte os saldos por competência',description:'Veja o que foi comprado, quanto já foi pago e o valor que ainda resta em cada mês.',helper:'Selecione para consultar os meses e registrar pagamentos.',icon:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M8 3v4M16 3v4M3 10h18M8 15h3"></path></svg>'},
   'Retiradas':{key:'purchases',eyebrow:'COMPRAS',title:'Consulte as compras por mês',description:'Acompanhe cada produto, quantidade e valor registrado, organizado no mês correto.',helper:'Selecione para visualizar ou registrar compras.',icon:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"></path><path d="m4.5 7.8 7.5 4.3 7.5-4.3M12 12v9"></path></svg>'},
   'Pagamentos':{key:'payments',eyebrow:'HISTÓRICO DE PAGAMENTOS',title:'Acompanhe pagamentos e abatimentos',description:'Confira quando cada valor foi registrado e quais competências antigas ele ajudou a quitar.',helper:'Selecione para consultar o histórico financeiro.',icon:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"></rect><path d="M3 10h18M7 15h4"></path></svg>'},
   'Produtos e preços':{key:'products',eyebrow:'PRODUTOS E PREÇOS',title:'Consulte o catálogo do fornecedor',description:'Visualize os produtos ativos e o histórico de preços sem alterar registros anteriores.',helper:'Selecione para abrir o catálogo de produtos.',icon:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 12 9 9 9-9-9-9H5a2 2 0 0 0-2 2v7Z"></path><circle cx="8" cy="8" r="1.3"></circle></svg>'},
   'Relatórios':{key:'reports',eyebrow:'RELATÓRIOS',title:'Prepare o relatório de um fornecedor',description:'Reúna compras, pagamentos, abatimentos e saldo em um extrato claro para compartilhamento.',helper:'Selecione para configurar e gerar o relatório.',icon:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10M12 20V4M19 20v-7M3 20h18"></path></svg>'}
  };
  return identities[page]||identities['Contas a pagar'];
 }
 function contextMarkup(){
  const view=selectedSupplier?F.supplierView(db,selectedSupplier):null;
  const identity=pageIdentity(),identityClass=`supplier-context-${identity.key}`;
  if(!view)return `<section class="supplier-context supplier-context-empty ${identityClass}" aria-labelledby="supplierChoiceTitle"><div class="supplier-choice-heading"><div class="supplier-choice-icon">${identity.icon}</div><div class="supplier-choice-copy"><span class="supplier-eyebrow">${identity.eyebrow}</span><h1 id="supplierChoiceTitle">${identity.title}</h1><p>${identity.description}</p></div></div><div class="supplier-switch supplier-switch-primary"><label for="workspaceSupplier"><span>1</span> Escolha o fornecedor</label><select id="workspaceSupplier" onchange="chooseWorkspaceSupplier(this.value)"><option value="">Clique para selecionar</option>${options()}</select><small>${identity.helper}</small></div></section>`;
  const status=inactive(view.supplier)?'<span class="supplier-status inactive">Inativo · somente histórico</span>':'<span class="supplier-status active">Ativo</span>';
  return `<section class="supplier-context ${identityClass} ${inactive(view.supplier)?'is-inactive':''}" aria-label="Fornecedor em uso"><div class="supplier-context-heading"><div class="supplier-context-name"><span class="supplier-context-mini-icon">${identity.icon}</span><div><span class="supplier-eyebrow">${identity.eyebrow} · FORNECEDOR</span><h2>${esc(view.supplier)}</h2>${status}<p>${inactive(view.supplier)?'Histórico e relatórios preservados. Reative para registrar novas compras ou produtos.':'Todas as informações abaixo pertencem somente a este fornecedor.'}</p></div></div><div class="supplier-switch"><label for="workspaceSupplier">Trocar fornecedor</label><select id="workspaceSupplier" onchange="chooseWorkspaceSupplier(this.value)"><option value="">Selecionar outro fornecedor</option>${options()}</select></div></div><div class="supplier-context-metrics"><div><span>Saldo a pagar</span><strong>${money(view.balance)}</strong></div><div><span>Meses em aberto</span><strong>${monthCount(view)}</strong></div><div><span>Produtos ativos</span><strong>${view.products.filter(item=>item.active!==false).length}</strong></div><div><span>Último movimento</span><strong>${dateLabel(lastMovement(view))}</strong></div></div></section>`;
 }
 function selectionRequired(){
  app.innerHTML=contextMarkup();
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
   else visible+=container.querySelectorAll('tbody tr').length;
   hideSupplierColumn(container);
  });
  const search=app.querySelector('.listsearch');if(search&&!search.classList.contains('purchase-history-search'))search.oninput=()=>{const term=search.value.toLocaleLowerCase('pt-BR');app.querySelectorAll('.table tbody tr').forEach(row=>{const supplierCell=[...row.cells].find(cell=>cell.dataset.label==='Fornecedor'),sameSupplier=!supplierCell||supplierCell.textContent.trim()===selectedSupplier;row.hidden=!sameSupplier||!row.textContent.toLocaleLowerCase('pt-BR').includes(term)})};
  if(!visible&&!['Contas a pagar','Relatórios'].includes(page)){const empty=document.createElement('div');empty.className='workspace-empty';empty.innerHTML=`<strong>Nenhum registro para ${esc(selectedSupplier)}</strong><span>Use a ação principal desta tela para criar o primeiro registro.</span>`;app.querySelector('.table')?.after(empty)}
 }
 function renderPurchaseHistory(){
  const groups=F.purchaseMonths(db.entries,selectedSupplier),oldTable=app.querySelector('.table'),oldSearch=app.querySelector('.listsearch');if(!oldTable)return;
  const date=value=>value.split('-').reverse().join('/');
  const html=groups.length?`<div class="purchase-months">${groups.map((group,index)=>`<details class="purchase-month" ${index===0?'open':''}><summary><div><span class="supplier-eyebrow">COMPETÊNCIA</span><strong>${esc(monthLabel(group.month))}</strong><small>${group.activeCount} ${group.activeCount===1?'compra válida':'compras válidas'}${group.cancelledCount?' · '+group.cancelledCount+' cancelada'+(group.cancelledCount===1?'':'s'):''}</small></div><div class="purchase-month-totals"><span>Quantidade <b>${group.quantity}</b></span><span>Total comprado <b>${money(group.total)}</b></span><i aria-hidden="true"></i></div></summary>${table(['Data','Produto','Quantidade','Unitário','Total','Situação','Ações'],group.rows.map(entry=>[date(entry.date),esc(entry.product||'—'),entry.qty,money(entry.unit),money(entry.value),entry.cancelled?'<span class="purchase-status cancelled">Cancelada</span>':'<span class="purchase-status confirmed">Confirmada</span>',entry.cancelled?'—':`<button data-action="edit" data-id="${esc(entry.id)}">Editar</button> <button data-action="cancel" data-id="${esc(entry.id)}">Cancelar</button>`]))}</details>`).join('')}</div>`:'<div class="workspace-empty"><strong>Nenhuma compra registrada</strong><span>Registre a primeira compra deste fornecedor.</span></div>';
  const fragment=document.createRange().createContextualFragment(`<input class="listsearch purchase-history-search" placeholder="Buscar por dia, mês, produto ou valor…" aria-label="Buscar nas compras mensais">${html}`);oldSearch?.remove();oldTable.replaceWith(fragment);
  const search=app.querySelector('.purchase-history-search');if(search)search.oninput=()=>{const term=search.value.toLocaleLowerCase('pt-BR');app.querySelectorAll('.purchase-month').forEach(section=>{let matches=0;section.querySelectorAll('tbody tr').forEach(row=>{row.hidden=!row.textContent.toLocaleLowerCase('pt-BR').includes(term);if(!row.hidden)matches++});section.hidden=!matches;if(term&&matches)section.open=true})};
  app.querySelectorAll('.purchase-month [data-action]').forEach(button=>button.onclick=()=>{const id=button.dataset.id,entry=db.entries.find(item=>item.id===id);if(button.dataset.action==='cancel')cancelEntry(id);else if(entry)openForm(entry.type,id)});
 }
 function renderPaymentHistory(){
  const oldTable=app.querySelector('.table');if(!oldTable)return;
  const ledger=F.allocationLedger(db.entries,selectedSupplier),byId=new Map(ledger.transactions.map(transaction=>[transaction.id,transaction]));
  const groups=F.paymentMonths(db.entries,selectedSupplier),oldSearch=app.querySelector('.listsearch');
  const date=value=>value.split('-').reverse().join('/');
  const destination=entry=>{
   if(entry.cancelled)return'<span class="allocation-muted">Não entra nos saldos</span>';
   const transaction=byId.get(entry.id),parts=(transaction?.allocations||[]).map(allocation=>`<span><b>${esc(monthLabel(allocation.month))}</b>${money(allocation.value)}</span>`);
   if(transaction?.unapplied)parts.push(`<span class="allocation-credit"><b>Crédito disponível</b>${money(transaction.unapplied)}</span>`);
   return parts.length?`<div class="allocation-destinations">${parts.join('')}</div>`:'<span class="allocation-muted">Ainda não utilizado</span>';
  };
  const html=groups.length?`<div class="payment-months">${groups.map((group,index)=>`<details class="payment-month" ${index===0?'open':''}><summary><div><span class="supplier-eyebrow">MÊS DO PAGAMENTO</span><strong>${esc(monthLabel(group.month))}</strong><small>${group.activeCount} ${group.activeCount===1?'movimento válido':'movimentos válidos'}${group.cancelledCount?' · '+group.cancelledCount+' cancelado'+(group.cancelledCount===1?'':'s'):''}</small></div><div class="payment-month-totals"><span>Pagamentos <b>${money(group.payments)}</b></span><span>Abatimentos <b>${money(group.credits)}</b></span><i aria-hidden="true"></i></div></summary>${table(['Data','Movimento','Valor registrado','Destino do valor','Situação','Ações'],group.rows.map(entry=>[date(entry.date),entry.type==='payment'?'<span class="payment-kind paid">Pagamento</span>':'<span class="payment-kind credit">Abatimento</span>',money(entry.value),destination(entry),entry.cancelled?'<span class="purchase-status cancelled">Cancelado</span>':'<span class="purchase-status confirmed">Registrado</span>',entry.cancelled?`<span data-entry-id="${esc(entry.id)}">—</span>`:`<button data-action="edit" data-id="${esc(entry.id)}">Editar</button> <button data-action="cancel" data-id="${esc(entry.id)}">Cancelar</button>`]))}</details>`).join('')}</div>`:'<div class="workspace-empty"><strong>Nenhum pagamento registrado</strong><span>Registre o primeiro pagamento ou abatimento deste fornecedor.</span></div>';
  const fragment=document.createRange().createContextualFragment(`<input class="listsearch payment-history-search" placeholder="Buscar por dia, mês, valor, destino ou observação…" aria-label="Buscar no histórico mensal">${html}`);oldSearch?.remove();oldTable.replaceWith(fragment);
  const search=app.querySelector('.payment-history-search');if(search)search.oninput=()=>{const term=search.value.toLocaleLowerCase('pt-BR');app.querySelectorAll('.payment-month').forEach(section=>{let matches=0;section.querySelectorAll('tbody tr').forEach(row=>{row.hidden=!row.textContent.toLocaleLowerCase('pt-BR').includes(term);if(!row.hidden)matches++});section.hidden=!matches;if(term&&matches)section.open=true})};
  app.querySelectorAll('.payment-month [data-action]').forEach(button=>button.onclick=()=>{const id=button.dataset.id,entry=db.entries.find(item=>item.id===id);if(button.dataset.action==='cancel')cancelEntry(id);else if(entry)openForm(entry.type,id)});
 }
 function contextualizePage(){
  const title=app.querySelector('h1');if(title){const names={'Contas a pagar':'Saldos a pagar','Retiradas':'Compras','Pagamentos':'Histórico de pagamentos','Produtos e preços':'Produtos e preços','Relatórios':'Relatório'};title.textContent=`${names[page]||page} · ${selectedSupplier}`;}
  const subtitle=title?.nextElementSibling;if(subtitle&&page==='Contas a pagar')subtitle.textContent='Consulte uma competência por vez e acompanhe o valor restante deste fornecedor.';
  if(subtitle&&page==='Retiradas')subtitle.textContent='Compras organizadas por mês, mantendo produto, quantidade e valor de cada dia.';
  if(subtitle&&page==='Pagamentos')subtitle.textContent='Pagamentos e abatimentos separados pelo mês em que ocorreram, mantendo o destino de cada valor.';
  if(page==='Contas a pagar'){app.querySelector('.payable-filters>div:first-child')?.remove();const monthLabelElement=app.querySelector('.payable-filters label');if(monthLabelElement)monthLabelElement.textContent='Competência';app.querySelector('.payable-context>div:first-child')?.remove();}
  if(page==='Retiradas')renderPurchaseHistory();
  if(page==='Pagamentos')renderPaymentHistory();
  const first=app.firstElementChild;first?.insertAdjacentHTML('beforebegin',contextMarkup());
  if(inactive(selectedSupplier)&&['Retiradas','Produtos e preços'].includes(page)){app.querySelectorAll('button').forEach(button=>{if(/registrar compra|novo produto|\+ produto/i.test(button.textContent)){button.disabled=true;button.title='Reative o fornecedor para fazer novos lançamentos.'}})}
  scopeTables();window.enhanceFinanceUI?.(app);
 }
 function supplierCards(names=db.suppliers,manageStatus=false){
  return `<section class="supplier-card-grid">${names.map(name=>{const index=supplierIndex(name),view=F.supplierView(db,name),open=monthCount(view),isInactive=inactive(name),statusControl=manageStatus?`<button class="supplier-toggle ${isInactive?'reactivate':'deactivate'}" onclick="toggleSupplier(db.suppliers[${index}])">${isInactive?'Reativar':'Inativar'}</button>`:'';return `<article class="supplier-card ${isInactive?'supplier-card-inactive':''}" data-supplier-status="${isInactive?'inactive':'active'}"><div class="supplier-card-top"><span>${esc(name.slice(0,1).toUpperCase())}</span><em>${isInactive?'Inativo':open?open+' '+(open===1?'mês em aberto':'meses em aberto'):'Sem pendências'}</em></div><h3>${esc(name)}</h3><div class="supplier-card-balance"><span>Saldo a pagar</span><strong>${money(view.balance)}</strong></div><div class="supplier-card-meta"><span>${view.products.filter(item=>item.active!==false).length} produtos ativos</span><span>${view.activeEntries.length} movimentos</span></div><div class="supplier-card-actions"><button class="primary" onclick="openSupplierWorkspace(${index})">Abrir financeiro</button><button onclick="openSupplierWorkspace(${index},'Relatórios')">Ver extrato</button>${statusControl}</div></article>`}).join('')}</section>`;
 }
 function renderDirectory(){
  const tableElement=app.querySelector('.table');if(!tableElement)return;tableElement.replaceWith(document.createRange().createContextualFragment(supplierCards(db.suppliers,true)));
  const search=app.querySelector('.listsearch');if(search){search.placeholder='Buscar fornecedor…';search.oninput=()=>{const term=search.value.toLocaleLowerCase('pt-BR');app.querySelectorAll('.supplier-card').forEach(card=>card.hidden=!card.textContent.toLocaleLowerCase('pt-BR').includes(term))}}
  const title=app.querySelector('h1');if(title)title.textContent='Carteira de fornecedores';const subtitle=title?.nextElementSibling;if(subtitle)subtitle.textContent='Fornecedores inativos continuam disponíveis para histórico, relatórios e totais anuais.';
  const activeCount=db.suppliers.filter(name=>!inactive(name)).length,inactiveCount=db.suppliers.length-activeCount;
  const filters=document.createRange().createContextualFragment(`<div class="supplier-directory-filters" role="group" aria-label="Filtrar fornecedores"><button class="${directoryFilter==='active'?'active':''}" data-filter="active">Ativos <span>${activeCount}</span></button><button class="${directoryFilter==='all'?'active':''}" data-filter="all">Todos <span>${db.suppliers.length}</span></button><button class="${directoryFilter==='inactive'?'active':''}" data-filter="inactive">Inativos <span>${inactiveCount}</span></button></div>`);
  app.querySelector('.supplier-card-grid')?.before(filters);
  const apply=()=>app.querySelectorAll('.supplier-card').forEach(card=>{const status=card.dataset.supplierStatus;card.hidden=directoryFilter!=='all'&&status!==directoryFilter});apply();
  app.querySelectorAll('.supplier-directory-filters button').forEach(button=>button.onclick=()=>{directoryFilter=button.dataset.filter;render()});
 }
 function renderPortfolio(){
  const toolbar=app.querySelector('.toolbar'),tableElement=app.querySelector('.table');if(!toolbar||!tableElement)return;
  const grid=app.querySelector('.grid'),period=F.movementPeriod(db.entries,portfolioFrom,portfolioTo);
  const formatDate=value=>value.split('-').reverse().join('/');
  const periodLabel=portfolioFrom&&portfolioTo?`${formatDate(portfolioFrom)} a ${formatDate(portfolioTo)}`:portfolioFrom?`A partir de ${formatDate(portfolioFrom)}`:portfolioTo?`Até ${formatDate(portfolioTo)}`:'Todo o período';
  const movementLabel=`${period.count} ${period.count===1?'lançamento considerado':'lançamentos considerados'}`;
  if(grid){
   const values=[period.purchases,period.payments,period.credits];
   grid.classList.add('portfolio-totals');grid.setAttribute('aria-live','polite');
   grid.querySelectorAll('.card').forEach((card,index)=>{const total=card.querySelector('strong'),caption=card.querySelector('small');if(total)total.textContent=money(values[index]||0);if(caption)caption.textContent=periodLabel});
   grid.insertAdjacentHTML('beforebegin',`<section class="portfolio-period" aria-labelledby="portfolioPeriodTitle"><div class="portfolio-period-heading"><div><span class="supplier-eyebrow">MOVIMENTAÇÃO FINANCEIRA</span><h2 id="portfolioPeriodTitle">Filtrar totais por data</h2><p>O período altera somente compras, pagamentos e abatimentos. O saldo devedor acima continua mostrando a dívida atual.</p></div><span class="portfolio-period-status"><b>${esc(periodLabel)}</b>${movementLabel}</span></div><div class="portfolio-period-fields"><div><label for="portfolioFrom">Data inicial</label><input id="portfolioFrom" type="date" value="${esc(portfolioFrom)}" max="${esc(portfolioTo)}"></div><div><label for="portfolioTo">Data final</label><input id="portfolioTo" type="date" value="${esc(portfolioTo)}" min="${esc(portfolioFrom)}"></div><button class="primary" onclick="applyPortfolioPeriod()">Aplicar período</button><button onclick="clearPortfolioPeriod()">Limpar filtro</button></div></section>`);
  }
  toolbar.innerHTML='<div><span class="supplier-eyebrow">ACESSO RÁPIDO</span><h2>Abra um fornecedor</h2></div><span class="portfolio-hint">Compras e pagamentos ficam separados por parceiro.</span>';
  tableElement.replaceWith(document.createRange().createContextualFragment(supplierCards(db.suppliers.filter(name=>!inactive(name)))));
  const title=app.querySelector('h1');if(title)title.textContent='Visão geral da carteira';
 }
 window.applyPortfolioPeriod=()=>{
  const from=document.getElementById('portfolioFrom')?.value||'',to=document.getElementById('portfolioTo')?.value||'';
  try{F.movementPeriod(db.entries,from,to);portfolioFrom=from;portfolioTo=to;render()}catch(error){if(typeof announce==='function')announce(error.message);else alert(error.message)}
 };
 window.clearPortfolioPeriod=()=>{portfolioFrom='';portfolioTo='';render()};
 function preselectForm(type,id){
  if(!selectedSupplier||id||!['purchase','payment','credit','product'].includes(type)||!modal.open)return;
  if(inactive(selectedSupplier)&&['purchase','product'].includes(type)){modal.close();return;}
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
