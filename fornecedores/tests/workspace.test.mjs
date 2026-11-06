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
    db:{suppliers:['W-BOX','PECHINCHA LIVRE'],products:[],entries:[]},
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
  assert.match(context.app.innerHTML,/Selecione um fornecedor/);
  assert.doesNotMatch(context.app.innerHTML,/value="W-BOX" selected/);
});

test('último fornecedor salvo no navegador não é restaurado',async()=>{
  const source=await readFile(sourceUrl,'utf8');
  const context=environment(source);

  context.navTo('Relatórios');
  assert.equal(context.filter,'');
  assert.match(context.app.innerHTML,/Escolha quem deseja consultar/);
});
