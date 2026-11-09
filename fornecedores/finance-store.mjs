// Uma única operação por vez. Nunca volta ao estado antigo após confirmação de gravação.
const normalizeEntry=e=>({id:e.id,type:e.type,date:e.date,supplier:e.supplier,product:e.product??null,qty:e.qty??null,unit:e.unit??null,value:e.value,note:e.note||'',cancelled:!!e.cancelled,purchaseOrderId:e.purchaseOrderId??null});
const normalizeProduct=p=>({id:p.id,supplier:p.supplier,name:p.name,active:p.active!==false,prices:[...p.prices].sort((a,b)=>a.date.localeCompare(b.date))});
const normalizeInactive=value=>[...(value||[])].sort((a,b)=>a.localeCompare(b,'pt-BR'));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function containsChanges(before,pending,server){
 let changes=0;
 for(const name of pending.suppliers){if(!before.suppliers.includes(name)){changes++;if(!server.suppliers.includes(name))return false;}}
 if(!same(normalizeInactive(before.inactiveSuppliers),normalizeInactive(pending.inactiveSuppliers))){changes++;if(!same(normalizeInactive(server.inactiveSuppliers),normalizeInactive(pending.inactiveSuppliers)))return false;}
 for(const p of pending.products){const old=before.products.find(x=>x.id===p.id);if(!old||!same(normalizeProduct(old),normalizeProduct(p))){changes++;const found=server.products.find(x=>x.id===p.id);if(!found||!same(normalizeProduct(found),normalizeProduct(p)))return false;}}
 for(const e of pending.entries){const old=before.entries.find(x=>x.id===e.id);if(!old||!same(normalizeEntry(old),normalizeEntry(e))){changes++;const found=server.entries.find(x=>x.id===e.id);if(!found||!same(normalizeEntry(found),normalizeEntry(e)))return false;}}
 return changes>0;
}
export class FinanceStore{
 constructor(client,validate){this.client=client;this.validate=validate;this.busy=false;this.state=null;this.revision=null;}
 accept(data){if(!data||!Number.isSafeInteger(data.revision)||data.revision<0)throw new Error('Resposta financeira inválida.');const state={suppliers:data.suppliers,inactiveSuppliers:data.inactiveSuppliers||[],products:data.products.map(p=>({...p,active:p.active!==false})),entries:data.entries,audit:[]};this.validate(state);this.state=structuredClone(state);this.revision=data.revision;return this.state;}
 async read(){const result=await this.client.rpc('fin_read');if(result.error)throw result.error;return this.accept(result.data);}
 async refresh(){if(this.busy)throw new Error('Aguarde a operação atual.');this.busy=true;try{return await this.read()}finally{this.busy=false}}
 async commit(payload){
  if(this.busy)throw new Error('Aguarde a operação atual.');if(!this.state)throw new Error('Carregue os dados antes de salvar.');this.validate(payload);this.busy=true;const before=structuredClone(this.state),pending=structuredClone(payload);
  try{
   let result;try{result=await this.client.rpc('fin_commit',{expected_revision:this.revision,payload:pending});if(result.error)throw result.error;}catch(error){
    // Uma queda de rede pode ocorrer depois de o banco ter confirmado a transação.
    // Reconciliar evita criar outro lançamento quando o usuário tenta novamente.
    try{await this.read();if(error?.code!=='40001'&&containsChanges(before,pending,this.state))return{saved:true,reconciled:true};}catch{}
    throw error;
   }
   if(!Number.isSafeInteger(result.data))throw new Error('Confirmação de gravação inválida.');
   this.state=pending;this.revision=result.data;
   try{await this.read();return{saved:true}}catch{return{saved:true,refreshPending:true}}
  }finally{this.busy=false}
 }
}
