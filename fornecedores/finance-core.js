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
 function monthly(entries,supplier){let rows=entries.filter(e=>!e.cancelled&&e.supplier===supplier);let groups=new Map();rows.filter(e=>e.type==='purchase').forEach(e=>{let month=validDate(e.date).slice(0,7);groups.set(month,checked(BigInt(groups.get(month)||0)+BigInt(e.value)))});let credit=checked(BigInt(sum(rows,'payment'))+BigInt(sum(rows,'credit')));return [...groups.keys()].sort().map(month=>{let purchase=groups.get(month),applied=Math.min(credit,purchase);credit-=applied;return[month,purchase,applied,purchase-applied]});}
 function name(input){let value=String(input??'').normalize('NFKC').trim().replace(/\s+/g,' ');if(!value||value.length>200||/[\u0000-\u001f\u007f]/.test(value))throw new Error('Informe um nome entre 1 e 200 caracteres.');return value;}
 function nameKey(input){return name(input).toLocaleLowerCase('pt-BR');}
 function validateSnapshot(db){
  let suppliers=new Set();for(const supplier of db.suppliers){let key=nameKey(supplier);if(suppliers.has(key))throw new Error('Há fornecedores com nomes duplicados.');suppliers.add(key);}
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
 function supplierView(db,supplier){
  if(!db.suppliers.includes(supplier))throw new Error('Fornecedor não encontrado.');
  const entries=db.entries.filter(entry=>entry.supplier===supplier),activeEntries=entries.filter(entry=>!entry.cancelled),products=db.products.filter(product=>product.supplier===supplier);
  const purchases=sum(activeEntries,'purchase'),payments=sum(activeEntries,'payment'),credits=sum(activeEntries,'credit');
  return{supplier,entries,activeEntries,products,purchases,payments,credits,balance:checked(BigInt(purchases)-BigInt(payments)-BigInt(credits)),months:monthly(db.entries,supplier)};
 }
 const api={parseCents,formatInput,formatMoney,quantity,total,validDate,monthRange,businessDate,priceAt,sum,monthly,name,nameKey,validateSnapshot,report,supplierView};
 root.FinanceCore=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
