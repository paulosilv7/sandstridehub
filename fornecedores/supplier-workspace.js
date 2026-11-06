// Mantém as operações financeiras dentro do contexto de um único fornecedor.
(function(){
 const F=FinanceCore;
 const stylesheet=document.createElement('link');stylesheet.rel='stylesheet';stylesheet.href='supplier-workspace.css';document.head.append(stylesheet);
 const operationalPages=new Set(['Contas a pagar','Retiradas','Pagamentos','Produtos e preços','Relatórios']);
 let selectedSupplier='';

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

 function options(){return db.suppliers.map(value=>`<option value="${esc(value)}" ${value===selectedSupplier?'selected':''}>${esc(value)}</option>`).join('')}
 function monthCount(view){return view.months.filter(row=>row[3]>0).length}
 function lastMovement(view){return [...view.activeEntries].sort((a,b)=>b.date.localeCompare(a.date)).at(0)?.date||''}
 function dateLabel(value){return value?value.split('-').reverse().join('/'):'Nenhum movimento'}
 function contextMarkup(){
  const view=selectedSupplier?F.supplierView(db,selectedSupplier):null;
  if(!view)return `<section class="supplier-context supplier-context-empty" aria-labelledby="supplierChoiceTitle"><div class="supplier-choice-heading"><span class="supplier-eyebrow">COMECE POR AQUI</span><h1 id="supplierChoiceTitle">Qual fornecedor deseja consultar?</h1><p>Escolha abaixo para abrir somente as compras, pagamentos, produtos, saldos e relatórios desse fornecedor.</p></div><div class="supplier-switch supplier-switch-primary"><label for="workspaceSupplier"><span>1</span> Escolha o fornecedor</label><select id="workspaceSupplier" onchange="chooseWorkspaceSupplier(this.value)"><option value="">Clique para selecionar</option>${options()}</select><small>Nenhum dado será misturado com os demais fornecedores.</small></div></section>`;
  return `<section class="supplier-context" aria-label="Fornecedor em uso"><div class="supplier-context-heading"><div><span class="supplier-eyebrow">ESPAÇO DO FORNECEDOR</span><h2>${esc(view.supplier)}</h2><p>Todas as informações abaixo pertencem somente a este fornecedor.</p></div><div class="supplier-switch"><label for="workspaceSupplier">Trocar fornecedor</label><select id="workspaceSupplier" onchange="chooseWorkspaceSupplier(this.value)"><option value="">Selecionar outro fornecedor</option>${options()}</select></div></div><div class="supplier-context-metrics"><div><span>Saldo a pagar</span><strong>${money(view.balance)}</strong></div><div><span>Meses em aberto</span><strong>${monthCount(view)}</strong></div><div><span>Produtos ativos</span><strong>${view.products.filter(item=>item.active!==false).length}</strong></div><div><span>Último movimento</span><strong>${dateLabel(lastMovement(view))}</strong></div></div></section>`;
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
