const enc=new TextEncoder();
export async function checksum(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('')}
export function validateSnapshot(p){
 if(p?.format!=='sandstride-fornecedores-v1'||!/^\d+$/.test(p.revision))throw Error('Formato de backup inválido');
 for(const key of ['suppliers','products','prices','entries','history'])if(!Array.isArray(p[key]))throw Error('Backup incompleto');
 const suppliers=new Set(p.suppliers.map(s=>s.name)),products=new Set(p.products.map(x=>x.id)),ids=new Set();
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
const cell=v=>({userEnteredValue:{stringValue:v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v)}});
const row=values=>({values:values.map(cell)});
export function restoreChunks(rows){
 const text=rows.slice(5).map(r=>r[0]||'').join('');
 return {text,payload:validateSnapshot(JSON.parse(text)),digest:rows[3]?.[0]};
}
export async function planBackup(job,metadata){
 const p=validateSnapshot(job.payload),text=JSON.stringify(p),digest=await checksum(text);
 if(enc.encode(text).length>8_000_000)throw Error('Backup excedeu 8 MB. Amplie o destino antes de continuar.');
 const version='v_'+p.revision;
 const views={
  Controle:[['SANDSTRIDE — Backup de Fornecedores'],['Revisão',p.revision],['Capturado em UTC',job.capturedAt],['SHA-256',digest],['Comprovantes','Não incluídos'],['Uso','Cópia automática. Não edite as abas v_: contêm as versões para recuperação.'],['Valores','Centavos inteiros preservados como texto, sem arredondamento.'],['Recuperação','Validar SHA-256 e testar em ambiente separado antes de restaurar.']],
  Fornecedores:[['Nome','Criado em'],...p.suppliers.map(x=>[x.name,x.created_at])],
  Produtos:[['ID','Fornecedor','Produto','Criado em'],...p.products.map(x=>[x.id,x.supplier,x.name,x.created_at])],
  Precos:[['Produto ID','Vigente desde','Preço em centavos','Criado em'],...p.prices.map(x=>[x.product_id,x.valid_from,x.cents,x.created_at])],
  Lancamentos:[['ID','Tipo','Data','Fornecedor','Produto','Quantidade','Unitário em centavos','Total em centavos','Observação','Cancelado','Criado em'],...p.entries.map(x=>[x.id,x.type,x.date,x.supplier,x.product,x.qty,x.unit,x.value,x.note,x.cancelled,x.created_at])],
  Historico:[['ID','Autor ID','Data UTC','Entidade','Operação','Antes (JSON)','Depois (JSON)'],...p.history.map(x=>[x.id,x.actor,x.at,x.entity,x.operation,x.old_record,x.new_record])]
 };
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
   requests.push({updateSheetProperties:{properties:{sheetId:prop.sheetId,gridProperties:{rowCount:Math.max(height,prop.gridProperties.rowCount),columnCount:Math.max(width,prop.gridProperties.columnCount)}},fields:'gridProperties.rowCount,gridProperties.columnCount'}});
   requests.push({updateCells:{range:{sheetId:prop.sheetId},fields:'userEnteredValue'}});
  }
  requests.push({updateCells:{start:{sheetId:prop.sheetId,rowIndex:0,columnIndex:0},rows:values.map(row),fields:'userEnteredValue'}});
  requests.push({repeatCell:{range:{sheetId:prop.sheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:width},cell:{userEnteredFormat:{backgroundColor:{red:.1,green:.11,blue:.1},textFormat:{bold:true,foregroundColor:{red:1,green:1,blue:1}}}},fields:'userEnteredFormat'}});
  if(title===version)requests.push({updateSheetProperties:{properties:{sheetId:prop.sheetId,hidden:true},fields:'hidden'}});
  else requests.push({updateDimensionProperties:{range:{sheetId:prop.sheetId,dimension:'COLUMNS',startIndex:0,endIndex:width},properties:{pixelSize:190},fields:'pixelSize'}});
 }
 return{requests,version,digest,text,existing:existing.has(version)};
}
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
