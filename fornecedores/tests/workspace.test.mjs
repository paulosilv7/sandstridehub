import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sourceUrl=new URL('../supplier-workspace.js',import.meta.url);

function environment(source){
  const app={
    innerHTML:'',
    firstElementChild:null,
    querySelector(){return null},
    querySelectorAll(){return[]}
  };
  const window={};
  const document={
    head:{append(){}},
    createElement(){return{}},
    querySelector(){return null}
  };
  const context={
    FinanceCore:{
      supplierView(){return{months:[],activeEntries:[],products:[],balance:0}},
      purchaseMonths(){return[]},
      allocationLedger(){return{transactions:[],months:[]}}
    },
    document,window,app,
    db:{suppliers:['W-BOX','PECHINCHA LIVRE'],inactiveSuppliers:[],products:[],entries:[]},
    page:'Painel',filter:'',payableSupplier:'',payableMonth:'',reportFrom:'',reportTo:'',
    render(){},openForm(){},modal:{open:false},
    navTo(destination){context.page=destination;context.filter='';context.render()},
    defaultPayableMonth(){return'2026-09'},
    esc(value){return String(value)},money(value){return String(value)},monthLabel(value){return value},
    table(){return''},cancelEntry(){},
    localStorage:{getItem(){return'W-BOX'},setItem(){throw new Error('não deve persistir')},removeItem(){throw new Error('não deve persistir')}}
  };
  vm.runInNewContext(source,context,{filename:'supplier-workspace.js'});
  return context;
}

test('abas operacionais abrem sem fornecedor pré-selecionado',async()=>{
  const source=await readFile(sourceUrl,'utf8');
  const context=environment(source);

  context.window.openSupplierWorkspace(0,'Contas a pagar');
  assert.equal(context.payableSupplier,'W-BOX');

  context.navTo('Pagamentos');
  assert.equal(context.payableSupplier,'');
  assert.equal(context.filter,'');
  assert.match(context.app.innerHTML,/Acompanhe pagamentos e abatimentos/);
  assert.match(context.app.innerHTML,/supplier-context-payments/);
  assert.match(context.app.innerHTML,/Clique para selecionar/);
  assert.doesNotMatch(context.app.innerHTML,/supplier-required-icon/);
  assert.doesNotMatch(context.app.innerHTML,/value="W-BOX" selected/);
});

test('saldos, compras e pagamentos possuem identidades distintas',async()=>{
  const source=await readFile(sourceUrl,'utf8');
  const context=environment(source);

  context.navTo('Contas a pagar');
  const balances=context.app.innerHTML;
  context.navTo('Retiradas');
  const purchases=context.app.innerHTML;
  context.navTo('Pagamentos');
  const payments=context.app.innerHTML;

  assert.match(balances,/Consulte os saldos por competência/);
  assert.match(balances,/supplier-context-balances/);
  assert.match(purchases,/Consulte as compras por mês/);
  assert.match(purchases,/supplier-context-purchases/);
  assert.match(payments,/Acompanhe pagamentos e abatimentos/);
  assert.match(payments,/supplier-context-payments/);
  assert.equal(new Set([balances,purchases,payments]).size,3);
});

test('último fornecedor salvo no navegador não é restaurado',async()=>{
  const source=await readFile(sourceUrl,'utf8');
  const context=environment(source);

  context.navTo('Relatórios');
  assert.equal(context.filter,'');
  assert.match(context.app.innerHTML,/Prepare o relatório de um fornecedor/);
});

test('fornecedores inativos não aparecem nos seletores operacionais',async()=>{
  const source=await readFile(sourceUrl,'utf8');
  const context=environment(source);
  context.window.isInactiveSupplier=name=>name==='PECHINCHA LIVRE';

  context.navTo('Retiradas');

  assert.match(context.app.innerHTML,/W-BOX/);
  assert.doesNotMatch(context.app.innerHTML,/PECHINCHA LIVRE/);
});

test('fornecedor inativo aberto pelo cadastro permanece consultável no próprio contexto',async()=>{
  const source=await readFile(sourceUrl,'utf8');
  const context=environment(source);
  context.window.isInactiveSupplier=name=>name==='PECHINCHA LIVRE';

  context.window.openSupplierWorkspace(1,'Relatórios');

  assert.equal(context.filter,'PECHINCHA LIVRE');
  assert.equal(context.window.currentWorkspaceSupplier(),'PECHINCHA LIVRE');
  assert.equal(context.page,'Relatórios');
});
