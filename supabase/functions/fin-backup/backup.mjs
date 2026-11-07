const enc=new TextEncoder();
export async function checksum(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('')}
export function validateSnapshot(p){
 if(p?.format!=='sandstride-fornecedores-v1'||!/^\d+$/.test(p.revision))throw Error('Formato de backup inválido');
 for(const key of ['suppliers','products','prices','entries','history'])if(!Array.isArray(p[key]))throw Error('Backup incompleto');
 const suppliers=new Set(p.suppliers.map(s=>s.name)),products=new Set(p.products.map(x=>x.id)),ids=new Set();
 for(const supplier of p.suppliers)if(typeof supplier.active!=='undefined'&&typeof supplier.active!=='boolean')throw Error('Situação de fornecedor inválida');
 if(suppliers.size!==p.suppliers.length||products.size!==p.products.length)throw Error('Cadastros duplicados');
 for(const x of p.products)if(!suppliers.has(x.supplier))throw Error('Fornecedor ausente');
 for(const x of p.prices)if(!products.has(x.product_id)||!/^\d+$/.test(x.cents)||BigInt(x.cents)<=0n)throw Error('Preço inválido');
 for(const x of p.entries){
  if(ids.has(x.id)||!suppliers.has(x.supplier)||!['purchase','payment','credit'].includes(x.type)||!/^\d+$/.test(x.value)||BigInt(x.value)<=0n)throw Error('Lançamento inválido');
  ids.add(x.id);
  if(x.type==='purchase'&&(!/^\d+$/.test(x.qty)||!/^\d+$/.test(x.unit)||BigInt(x.qty)<=0n||BigInt(x.unit)<=0n||BigInt(x.qty)*BigInt(x.unit)!==BigInt(x.value)))throw Error('Total da compra inválido');
 }
 return p;
}
const currency=value=>({currency:String(value)});
const money=value=>{let n=BigInt(value),sign=n<0n?'-':'';if(n<0n)n=-n;return sign+'R$ '+String(n/100n).replace(/\B(?=(\d{3})+(?!\d))/g,'.')+','+String(n%100n).padStart(2,'0')};
const cell=v=>{
 if(v&&typeof v==='object'&&'currency' in v){const n=Number(v.currency)/100;return Number.isFinite(n)&&BigInt(Math.round(n*100))===BigInt(v.currency)?{userEnteredValue:{numberValue:n},userEnteredFormat:{numberFormat:{type:'CURRENCY',pattern:'"R$" #,##0.00;[Red]-"R$" #,##0.00'}}}:{userEnteredValue:{stringValue:money(v.currency)}}}
 return{userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:v===null||v===undefined?'':String(v)}};
};
const row=values=>({values:values.map(cell)});
const day=v=>v?String(v).slice(0,10).split('-').reverse().join('/'):'';
const timestamp=v=>v?new Date(v).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'';
const typeName={purchase:'Compra',payment:'Pagamento',credit:'Abatimento'};
export function readableViews(p,capturedAt){
 const active=p.entries.filter(e=>!e.cancelled),sum=(list,type)=>list.filter(e=>e.type===type).reduce((n,e)=>n+BigInt(e.value),0n);
 const total=type=>sum(active,type),productById=new Map(p.products.map(x=>[x.id,x]));
 const supplierRows=p.suppliers.map(s=>{const es=active.filter(e=>e.supplier===s.name),b=sum(es,'purchase'),pay=sum(es,'payment'),credit=sum(es,'credit');return[s.name,s.active===false?'Inativo':'Ativo',currency(b),currency(pay),currency(credit),currency(b-pay-credit),es.filter(e=>e.type==='purchase').length]});
 const final=total('purchase')-total('payment')-total('credit');
 return{
  Resumo:[['SANDSTRIDE | FORNECEDORES'],['Cópia dos dados em '+timestamp(capturedAt)+' · Brasília'],['Compras',currency(total('purchase')),'Pagamentos',currency(total('payment')),'Saldo a pagar',currency(final)],['Saldo = compras − pagamentos − abatimentos. Cancelados ficam fora dos totais.'],['Fornecedor','Situação','Compras (R$)','Pagamentos (R$)','Abatimentos (R$)','Saldo (R$)','Compras registradas'],...supplierRows,['TOTAL','',currency(total('purchase')),currency(total('payment')),currency(total('credit')),currency(final),active.filter(e=>e.type==='purchase').length],[],['Como consultar'],['Lancamentos: cada compra, pagamento ou abatimento, com data e valor em reais.'],['Precos: histórico dos preços por produto e início da vigência.'],['Esta planilha é uma cópia automática: faça os lançamentos no sistema.'],['Valores negativos no saldo representam crédito com o fornecedor.']],
  Fornecedores:[['Fornecedor','Situação','Compras (R$)','Pagamentos (R$)','Abatimentos (R$)','Saldo a pagar (R$)','Compras registradas'],...supplierRows],
  Produtos:[['Fornecedor','Produto','Preço vigente (R$)','Vigente desde'],...p.products.map(x=>{const date=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});const price=p.prices.filter(v=>v.product_id===x.id&&v.valid_from<=date).sort((a,b)=>a.valid_from.localeCompare(b.valid_from)).at(-1);return[x.supplier,x.name,price?currency(price.cents):'Sem preço vigente',price?day(price.valid_from):'']})],
  Precos:[['Fornecedor','Produto','Vigente desde','Preço unitário (R$)'],...p.prices.map(x=>[productById.get(x.product_id)?.supplier,productById.get(x.product_id)?.name,day(x.valid_from),currency(x.cents)])],
  Lancamentos:[['Data','Fornecedor','Movimento','Produto / descrição','Quantidade','Unitário (R$)','Total (R$)','Situação','Observação','ID técnico'],...p.entries.map(x=>[day(x.date),x.supplier,typeName[x.type],x.product||'—',x.qty===null?'—':Number(x.qty),x.unit===null?'—':currency(x.unit),currency(x.value),x.cancelled?'Cancelado':'Registrado',String(x.note||'').slice(0,5000),x.id])],
  Historico:[['Data e hora (Brasília)','Registro','Ação','Descrição','Autor (ID técnico)'],...p.history.map(x=>{const record=x.new_record||x.old_record||{},entity={fin_suppliers:'Fornecedor',fin_products:'Produto',fin_prices:'Preço',fin_entries:'Lançamento'}[x.entity]||x.entity,operation=x.operation==='INSERT'?'Cadastro':x.operation==='UPDATE'?'Alteração':x.operation;return[timestamp(x.at),entity,operation,[record.name||record.supplier||'',record.product||'',record.type?typeName[record.type]:'',record.value?money(record.value):record.cents?money(record.cents):'',record.cancelled?'Cancelado':''].filter(Boolean).join(' · '),x.actor||'']})],
  Controle:[['INFORMAÇÕES DE RECUPERAÇÃO'],['Revisão',p.revision],['Data da cópia (Brasília)',timestamp(capturedAt)],['Comprovantes','Não incluídos'],['Consulta','Abra a aba Resumo. Os valores nas abas de consulta estão em reais.'],['Precisão','As versões v_ preservam os centavos exatos para restauração.'],['Não editar','As abas são atualizadas automaticamente pelo sistema.']]
 };
}
export function restoreChunks(rows){
 const text=rows.slice(5).map(r=>r[0]||'').join('');
 return {text,payload:validateSnapshot(JSON.parse(text)),digest:rows[3]?.[0]};
}
export async function planBackup(job,metadata){
 const p=validateSnapshot(job.payload),text=JSON.stringify(p),digest=await checksum(text);
 if(enc.encode(text).length>8_000_000)throw Error('Backup excedeu 8 MB. Amplie o destino antes de continuar.');
 const version='v_'+p.revision;
 const views=readableViews(p,job.capturedAt);
 const chunks=Array.from({length:Math.ceil(text.length/30000)},(_,i)=>[text.slice(i*30000,(i+1)*30000)]);
 const archive=[['sandstride-fornecedores-v1'],[p.revision],[job.capturedAt],[digest],['JSON em partes: concatenar A6 até a última linha'],...chunks];
 const requests=[],sheets=metadata.sheets||[],existing=new Map(sheets.map(s=>[s.properties.title,s.properties]));
 let next=Math.max(0,...sheets.map(s=>s.properties.sheetId))+1;
 for(const [title,values] of Object.entries({...views,[version]:archive})){
  // Uma versão confirmada é imutável; o chamador verifica a cópia antes de retomar.
  if(title===version&&existing.has(version))continue;
  let prop=existing.get(title),width=Math.max(...values.map(r=>r.length)),height=Math.max(values.length,10);
  if(!prop){prop={sheetId:next++,title};requests.push({addSheet:{properties:{...prop,gridProperties:{rowCount:height,columnCount:width,frozenRowCount:1}}}})}
  else{
   if(title==='Resumo')requests.push({unmergeCells:{range:{sheetId:prop.sheetId,startRowIndex:0,endRowIndex:prop.gridProperties.rowCount,startColumnIndex:0,endColumnIndex:prop.gridProperties.columnCount}}});
   requests.push({updateSheetProperties:{properties:{sheetId:prop.sheetId,gridProperties:{rowCount:Math.max(height,prop.gridProperties.rowCount),columnCount:Math.max(width,prop.gridProperties.columnCount)}},fields:'gridProperties.rowCount,gridProperties.columnCount'}});
   requests.push({updateCells:{range:{sheetId:prop.sheetId},fields:'userEnteredValue'}});
  }
  requests.push({updateCells:{start:{sheetId:prop.sheetId,rowIndex:0,columnIndex:0},rows:values.map(row),fields:'userEnteredValue,userEnteredFormat.numberFormat'}});
  requests.push({repeatCell:{range:{sheetId:prop.sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:width},cell:{userEnteredFormat:{backgroundColor:{red:.1,green:.11,blue:.1},textFormat:{bold:true,foregroundColor:{red:1,green:1,blue:1}}}},fields:'userEnteredFormat'}});
  if(title===version)requests.push({updateSheetProperties:{properties:{sheetId:prop.sheetId,hidden:true},fields:'hidden'}});
  else{
   const range={sheetId:prop.sheetId,startRowIndex:0,endRowIndex:height,startColumnIndex:0,endColumnIndex:width};
   requests.push({repeatCell:{range,cell:{userEnteredFormat:{textFormat:{fontFamily:'Arial',fontSize:11},verticalAlignment:'MIDDLE',wrapStrategy:'CLIP'}},fields:'userEnteredFormat.textFormat.fontFamily,userEnteredFormat.textFormat.fontSize,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy'}});
   requests.push({updateDimensionProperties:{range:{sheetId:prop.sheetId,dimension:'COLUMNS',startIndex:0,endIndex:width},properties:{pixelSize:170},fields:'pixelSize'}});
   requests.push({updateDimensionProperties:{range:{sheetId:prop.sheetId,dimension:'ROWS',startIndex:0,endIndex:height},properties:{pixelSize:32},fields:'pixelSize'}});
   const widths={Lancamentos:[110,145,120,190,90,120,145,120,420],Produtos:[160,260,170,160],Precos:[160,260,160,170],Historico:[190,140,120,480]}[title];
   widths?.forEach((pixelSize,index)=>requests.push({updateDimensionProperties:{range:{sheetId:prop.sheetId,dimension:'COLUMNS',startIndex:index,endIndex:index+1},properties:{pixelSize},fields:'pixelSize'}}));
   if(title==='Historico')requests.push({updateDimensionProperties:{range:{sheetId:prop.sheetId,dimension:'COLUMNS',startIndex:4,endIndex:Math.max(width,prop.gridProperties?.columnCount||width)},properties:{hiddenByUser:true},fields:'hiddenByUser'}});
   requests.push({updateSheetProperties:{properties:{sheetId:prop.sheetId,hidden:title==='Controle',gridProperties:{frozenRowCount:title==='Resumo'?5:1,hideGridlines:true},...(title==='Resumo'?{index:0}:{})},fields:'hidden,gridProperties.frozenRowCount,gridProperties.hideGridlines'+(title==='Resumo'?',index':'')}});
   if(title==='Resumo'){
    requests.push({repeatCell:{range:{...range,endRowIndex:1},cell:{userEnteredFormat:{textFormat:{bold:true,fontSize:18}}},fields:'userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize'}});
    values.forEach((line,index)=>{if(line.length===1)requests.push({mergeCells:{range:{sheetId:prop.sheetId,startRowIndex:index,endRowIndex:index+1,startColumnIndex:0,endColumnIndex:7},mergeType:'MERGE_ALL'}})});
    requests.push({repeatCell:{range:{sheetId:prop.sheetId,startRowIndex:4,endRowIndex:5,startColumnIndex:0,endColumnIndex:7},cell:{userEnteredFormat:{backgroundColor:{red:.75,green:.8,blue:.96},textFormat:{bold:true}}},fields:'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold'}});
    requests.push({repeatCell:{range:{sheetId:prop.sheetId,startRowIndex:5,endRowIndex:6+supplierRowsLength(p),startColumnIndex:5,endColumnIndex:6},cell:{userEnteredFormat:{textFormat:{bold:true},backgroundColor:{red:.94,green:.96,blue:1}}},fields:'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor'}});
   }
   if(title==='Lancamentos'){
    requests.push({updateDimensionProperties:{range:{sheetId:prop.sheetId,dimension:'COLUMNS',startIndex:8,endIndex:9},properties:{pixelSize:420},fields:'pixelSize'}});
    requests.push({updateDimensionProperties:{range:{sheetId:prop.sheetId,dimension:'COLUMNS',startIndex:9,endIndex:Math.max(width,prop.gridProperties?.columnCount||width)},properties:{hiddenByUser:true},fields:'hiddenByUser'}});
   }
  }
 }
 return{requests,version,digest,text,existing:existing.has(version)};
}
const supplierRowsLength=p=>p.suppliers.length;
export async function backup(client,google,secret){
 const rpc=async(name,args)=>{const r=await client.rpc(name,args);if(r.error)throw Error('Falha no controle de backup');return r.data};
 const job=await rpc('fin_backup_claim',{candidate:secret});
 if(job.disabled||job.busy||job.unchanged)return job;
 const base=`https://sheets.googleapis.com/v4/spreadsheets/${job.spreadsheetId}`;
 try{
  const metadata=await google(base+'?fields=sheets.properties');
  const plan=await planBackup(job,metadata);
  const read=async()=>{
   const values=await google(`${base}/values/${encodeURIComponent(plan.version+'!A1:A')}`);
   const restored=restoreChunks(values.values||[]);
   if(restored.digest!==plan.digest||await checksum(restored.text)!==plan.digest||restored.text!==plan.text)throw Error('A verificação da cópia no Google falhou');
  };
  if(plan.existing)await read();
  // Atualização das abas e criação da versão na mesma operação atômica do Sheets.
  await google(base+':batchUpdate',{method:'POST',body:JSON.stringify({requests:plan.requests})});
  await read();
  await rpc('fin_backup_finish',{candidate:secret,lease:job.lease,rev:job.revision,digest:plan.digest});
  return{ok:true,revision:job.revision};
 }catch(error){
  await rpc('fin_backup_finish',{candidate:secret,lease:job.lease,rev:job.revision,digest:null,failure:'Não foi possível confirmar a cópia no Google. Nova tentativa automática.'}).catch(()=>{});
  throw error;
 }
}
