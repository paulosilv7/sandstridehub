(function(root){
 'use strict';
 const MAX=9007199254740991n;
 function integer(value,label='Valor'){if(!Number.isSafeInteger(value))throw new Error(label+' fora do limite de precisão.');return value;}
 function checked(value){if(value>MAX||value< -MAX)throw new Error('O total excede o limite de precisão permitido.');return Number(value);}
 function parseCents(input){
  let s=String(input??'').trim().replace(/^R\$\s*/,'');
  if(s.includes(',')){
   if(!/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(s))throw new Error('Informe o valor no formato 1.234,56, com até duas casas decimais.');
   s=s.replace(/\./g,'').replace(',','.');
  }
  if(!/^\d+(?:\.\d{1,2})?$/.test(s))throw new Error('Informe um valor positivo com até duas casas decimais.');
  const [whole,decimal='']=s.split('.');const cents=BigInt(whole)*100n+BigInt(decimal.padEnd(2,'0'));
  if(cents<=0n)throw new Error('O valor deve ser maior que zero.');return checked(cents);
 }
 function formatInput(cents){integer(cents);let n=BigInt(cents);return `${n/100n},${String(n%100n).padStart(2,'0')}`;}
 function formatMoney(cents){integer(cents);let n=BigInt(cents),negative=n<0n;if(negative)n=-n;return `${negative?'− ':''}R$ ${new Intl.NumberFormat('pt-BR').format(n/100n)},${String(n%100n).padStart(2,'0')}`;}
 function quantity(value){if(!/^[1-9]\d*$/.test(String(value).trim()))throw new Error('A quantidade deve ser um número inteiro maior que zero.');return checked(BigInt(String(value).trim()));}
 function total(qty,cents){quantity(qty);integer(cents);if(cents<=0)throw new Error('Preço inválido.');return checked(BigInt(qty)*BigInt(cents));}
 function validDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('Informe uma data válida.');let d=new Date(value+'T12:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value||Number(value.slice(0,4))<1900)throw new Error('Informe uma data válida.');return value;}
 function monthRange(value){
  if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)||Number(value.slice(0,4))<1900)throw new Error('Informe uma competência válida.');
  const [year,month]=value.split('-').map(Number),lastDay=new Date(Date.UTC(year,month,0)).getUTCDate();
  return{from:validDate(value+'-01'),to:validDate(value+'-'+String(lastDay).padStart(2,'0'))};
 }
 function businessDate(date=new Date()){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);return ['year','month','day'].map(t=>parts.find(p=>p.type===t).value).join('-');}
 function priceAt(prices,date){validDate(date);return [...prices].filter(p=>p.date<=date).sort((a,b)=>a.date.localeCompare(b.date)).at(-1)||null;}
 function sum(entries,type){return checked(entries.filter(e=>!e.cancelled&&(!type||e.type===type)).reduce((n,e)=>n+BigInt(integer(e.value)),0n));}
 function allocationLedger(entries,supplier){
  const movements=entries.filter(entry=>!entry.cancelled&&entry.supplier===supplier).map((entry,order)=>({...entry,_order:order})).sort((a,b)=>a.date.localeCompare(b.date)||a._order-b._order);
  const monthMap=new Map(),debts=[],pending=[],transactions=[];
  const add=(left,right)=>checked(BigInt(integer(left))+BigInt(integer(right)));
  function monthFor(value){
   const month=validDate(value).slice(0,7);let bucket=monthMap.get(month);
   if(!bucket){bucket={month,purchases:0,payments:0,credits:0,remaining:0,allocations:[]};monthMap.set(month,bucket);debts.push(bucket);debts.sort((a,b)=>a.month.localeCompare(b.month));}
   return bucket;
  }
  function drain(){
   while(pending.length){
    const reduction=pending[0],debt=debts.find(bucket=>bucket.remaining>0);if(!debt)break;
    const value=Math.min(reduction.unapplied,debt.remaining);if(value<=0)break;
    const existing=reduction.allocations.find(allocation=>allocation.month===debt.month);if(existing)existing.value=add(existing.value,value);else reduction.allocations.push({month:debt.month,value});debt.allocations.push({entryId:reduction.id,date:reduction.date,type:reduction.type,value});
    debt.remaining-=value;reduction.unapplied-=value;
    if(reduction.type==='payment')debt.payments=add(debt.payments,value);else debt.credits=add(debt.credits,value);
    if(reduction.unapplied===0)pending.shift();
   }
  }
  movements.forEach((entry,order)=>{
   if(entry.type==='purchase'){
    const bucket=monthFor(entry.date);bucket.purchases=add(bucket.purchases,entry.value);bucket.remaining=add(bucket.remaining,entry.value);drain();return;
   }
   const reduction={id:entry.id||'movement-'+order,date:validDate(entry.date),type:entry.type,value:integer(entry.value),allocations:[],unapplied:integer(entry.value)};
   transactions.push(reduction);pending.push(reduction);drain();
  });
  const months=[...monthMap.values()].sort((a,b)=>a.month.localeCompare(b.month)).map(bucket=>({...bucket,applied:add(bucket.payments,bucket.credits)}));
  const unapplied=checked(pending.reduce((total,item)=>total+BigInt(item.unapplied),0n));
  return{months,transactions,unapplied,balance:checked(months.reduce((total,item)=>total+BigInt(item.remaining),0n)-BigInt(unapplied))};
 }
 function monthly(entries,supplier){return allocationLedger(entries,supplier).months.map(row=>[row.month,row.purchases,row.applied,row.remaining]);}
 function purchaseMonths(entries,supplier){
  const groups=new Map();entries.forEach((entry,order)=>{if(entry.supplier!==supplier||entry.type!=='purchase')return;validDate(entry.date);const month=entry.date.slice(0,7);if(!groups.has(month))groups.set(month,[]);groups.get(month).push({...entry,_order:order})});
  return[...groups.entries()].sort(([a],[b])=>b.localeCompare(a)).map(([month,rows])=>{rows.sort((a,b)=>b.date.localeCompare(a.date)||b._order-a._order);const active=rows.filter(entry=>!entry.cancelled);return{month,rows,total:sum(active,'purchase'),quantity:checked(active.reduce((value,entry)=>value+BigInt(quantity(entry.qty)),0n)),activeCount:active.length,cancelledCount:rows.length-active.length}});
 }
 function paymentMonths(entries,supplier){
  const groups=new Map();entries.forEach((entry,order)=>{if(entry.supplier!==supplier||entry.type==='purchase')return;validDate(entry.date);const month=entry.date.slice(0,7);if(!groups.has(month))groups.set(month,[]);groups.get(month).push({...entry,_order:order})});
  return[...groups.entries()].sort(([a],[b])=>b.localeCompare(a)).map(([month,rows])=>{rows.sort((a,b)=>b.date.localeCompare(a.date)||b._order-a._order);const active=rows.filter(entry=>!entry.cancelled);return{month,rows,payments:sum(active,'payment'),credits:sum(active,'credit'),activeCount:active.length,cancelledCount:rows.length-active.length}});
 }
 function name(input){let value=String(input??'').normalize('NFKC').trim().replace(/\s+/g,' ');if(!value||value.length>200||/[\u0000-\u001f\u007f]/.test(value))throw new Error('Informe um nome entre 1 e 200 caracteres.');return value;}
 function nameKey(input){return name(input).toLocaleLowerCase('pt-BR');}
 function validateSnapshot(db){
  let suppliers=new Set();for(const supplier of db.suppliers){let key=nameKey(supplier);if(suppliers.has(key))throw new Error('Há fornecedores com nomes duplicados.');suppliers.add(key);}
  if(db.inactiveSuppliers!==undefined){if(!Array.isArray(db.inactiveSuppliers))throw new Error('Situação de fornecedor inválida.');let inactive=new Set();for(const supplier of db.inactiveSuppliers){const key=nameKey(supplier);if(inactive.has(key)||!suppliers.has(key))throw new Error('Situação de fornecedor inválida.');inactive.add(key);}}
  let ids=new Set(),products=new Set();for(const p of db.products){if(ids.has(p.id))throw new Error('Produto duplicado.');ids.add(p.id);if(typeof p.active!=='undefined'&&typeof p.active!=='boolean')throw new Error('Situação de produto inválida.');if(!db.suppliers.includes(p.supplier))throw new Error('Fornecedor do produto não encontrado.');let key=p.supplier+'\0'+nameKey(p.name);if(products.has(key))throw new Error('Este produto já está cadastrado para o fornecedor.');products.add(key);if(!p.prices.length)throw new Error('Cadastre o preço do produto.');let dates=new Set();for(const price of p.prices){validDate(price.date);if(dates.has(price.date))throw new Error('Vigência de preço duplicada.');dates.add(price.date);if(integer(price.value)<=0)throw new Error('Preço inválido.');}}
  ids=new Set();for(const e of db.entries){if(ids.has(e.id))throw new Error('Lançamento duplicado.');ids.add(e.id);validDate(e.date);if(!['purchase','payment','credit'].includes(e.type)||integer(e.value)<=0)throw new Error('Lançamento inválido.');if(!db.suppliers.includes(e.supplier))throw new Error('Fornecedor não encontrado.');if(e.type==='purchase'&&total(e.qty,e.unit)!==e.value)throw new Error('O total da compra não confere.');}
  for(const type of ['purchase','payment','credit'])sum(db.entries,type);sum(db.entries);
  return db;
 }
 function report(entries,supplier,from='',to=''){
  if(from)validDate(from);if(to)validDate(to);if(from&&to&&from>to)throw new Error('A data inicial deve ser anterior à data final.');
  const all=entries.filter(e=>!e.cancelled&&e.supplier===supplier).map((e,i)=>({...e,_order:i})).sort((a,b)=>a.date.localeCompare(b.date)||a._order-b._order);
  const signed=e=>BigInt(e.type==='purchase'?e.value:-e.value);
  let opening=checked(all.filter(e=>from&&e.date<from).reduce((v,e)=>v+signed(e),0n)),balance=opening;
  const rows=all.filter(e=>(!from||e.date>=from)&&(!to||e.date<=to)).map(e=>{balance=checked(BigInt(balance)+signed(e));return {...e,balance};});
  return{opening,closing:balance,rows,purchases:sum(rows,'purchase'),payments:sum(rows,'payment'),credits:sum(rows,'credit')};
 }
 function movementPeriod(entries,from='',to=''){
  if(from)validDate(from);if(to)validDate(to);if(from&&to&&from>to)throw new Error('A data inicial deve ser anterior ou igual à data final.');
  const rows=entries.filter(entry=>!entry.cancelled&&(!from||entry.date>=from)&&(!to||entry.date<=to));
  rows.forEach(entry=>validDate(entry.date));
  return{rows,count:rows.length,purchases:sum(rows,'purchase'),payments:sum(rows,'payment'),credits:sum(rows,'credit')};
 }
 function supplierView(db,supplier){
  if(!db.suppliers.includes(supplier))throw new Error('Fornecedor não encontrado.');
  const entries=db.entries.filter(entry=>entry.supplier===supplier),activeEntries=entries.filter(entry=>!entry.cancelled),products=db.products.filter(product=>product.supplier===supplier);
  const purchases=sum(activeEntries,'purchase'),payments=sum(activeEntries,'payment'),credits=sum(activeEntries,'credit');
  return{supplier,entries,activeEntries,products,purchases,payments,credits,balance:checked(BigInt(purchases)-BigInt(payments)-BigInt(credits)),months:monthly(db.entries,supplier)};
 }
 const api={parseCents,formatInput,formatMoney,quantity,total,validDate,monthRange,businessDate,priceAt,sum,allocationLedger,monthly,purchaseMonths,paymentMonths,name,nameKey,validateSnapshot,report,movementPeriod,supplierView};
 root.FinanceCore=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
