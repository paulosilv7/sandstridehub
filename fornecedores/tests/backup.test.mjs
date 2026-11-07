import test from 'node:test';
import assert from 'node:assert/strict';
import {backup,planBackup,restoreChunks,checksum,validateSnapshot,readableViews} from '../../supabase/functions/fin-backup/backup.mjs';
const payload=()=>({format:'sandstride-fornecedores-v1',revision:'7',suppliers:[{name:'=Fornecedor',active:false,created_at:'2026-11-05'}],products:[{id:'p',supplier:'=Fornecedor',name:'Tênis'}],prices:[{product_id:'p',valid_from:'2026-01-01',cents:'37'}],entries:[{id:'e',supplier:'=Fornecedor',type:'purchase',date:'2026-11-05',product:'Tênis',qty:'3',unit:'37',value:'111',cancelled:false,note:'á漢字'.repeat(30000)}],history:[{id:'9007199254740993',operation:'INSERT'}]});
function fake({fail=false,corrupt=false,existing=false}={}){
 const p=payload(),job={revision:p.revision,lease:'lease',spreadsheetId:'sheet',capturedAt:'2026-11-05T12:00:00Z',payload:p};
 const state={done:[],reads:0,writes:[],archive:null};
 const client={rpc:async(name,args)=>name==='fin_backup_claim'?{data:job}:{data:state.done.push(args)}};
 const google=async(url,init)=>{
  if(url.includes('?fields='))return{sheets:existing?[{properties:{sheetId:1,title:'v_7',gridProperties:{rowCount:10,columnCount:1}}}]:[]};
  if(url.includes(':batchUpdate')){if(fail)throw Error('offline');const req=JSON.parse(init.body).requests;state.writes.push(req);const add=req.find(x=>x.addSheet?.properties.title==='v_7');if(add){const id=add.addSheet.properties.sheetId;state.archive=req.find(x=>x.updateCells?.start?.sheetId===id).updateCells.rows.map(r=>r.values.map(c=>c.userEnteredValue.stringValue));}return{}};
  state.reads++;if(existing&&!state.archive){const plan=await planBackup(job,{sheets:[]});state.archive=plan.requests.filter(x=>x.updateCells?.rows).at(-1).updateCells.rows.map(r=>r.values.map(c=>c.userEnteredValue.stringValue));}
  const values=structuredClone(state.archive);if(corrupt)values[3][0]='0'.repeat(64);return{values};
 };
 return{state,client,google};
}
test('backup restaura texto Unicode, IDs grandes, centavos e observações sem fórmulas',async()=>{
 const f=fake();await backup(f.client,f.google,'secret');assert.equal(f.state.done.length,1);assert.equal(f.state.done[0].failure,undefined);
 const restored=restoreChunks(f.state.archive);assert.deepEqual(restored.payload,payload());assert.equal(await checksum(restored.text),restored.digest);
 const cells=f.state.writes[0].flatMap(x=>x.updateCells?.rows||[]).flatMap(r=>r.values);assert.ok(cells.every(c=>!('formulaValue' in c.userEnteredValue)));
});
test('falha Google não confirma backup e libera nova tentativa',async()=>{const f=fake({fail:true});await assert.rejects(()=>backup(f.client,f.google,'secret'));assert.ok(f.state.done[0].failure);});
test('cópia divergente é recusada, sem sinal verde falso',async()=>{const f=fake({corrupt:true});await assert.rejects(()=>backup(f.client,f.google,'secret'));assert.ok(f.state.done[0].failure);});
test('resposta perdida retoma versão existente sem criar outra nem sobrescrevê-la',async()=>{const f=fake({existing:true});await backup(f.client,f.google,'secret');assert.equal(f.state.reads,2);assert.ok(!f.state.writes[0].some(x=>x.addSheet?.properties.title==='v_7'));});
test('formato incompleto e total inconsistente impedem cópia',()=>{assert.throws(()=>validateSnapshot({}));const p=payload();p.entries[0].value='112';assert.throws(()=>validateSnapshot(p),/Total/)});
test('execução ocupada/desativada/sem mudanças não acessa Google',async()=>{for(const flag of ['busy','disabled','unchanged']){const client={rpc:async()=>({data:{[flag]:true}})};await backup(client,()=>{throw Error('não deve chamar')},'secret')}});
test('consulta exibe reais e nomes, preservando cancelados fora do resumo',async()=>{
 const p=payload();p.entries.push({...p.entries[0],id:'cancelado',value:'999',qty:'27',cancelled:true});
 const views=readableViews(p,'2026-11-05T12:00:00Z');assert.equal(views.Lancamentos[1][0],'05/11/2026');assert.equal(views.Lancamentos[1][2],'Compra');assert.equal(views.Resumo[2][1].currency,'111');assert.equal(views.Resumo[2][5].currency,'111');assert.equal(views.Fornecedores[1][1],'Inativo');assert.equal(views.Precos[1][1],'Tênis');
 const plan=await planBackup({payload:p,capturedAt:'2026-11-05T12:00:00Z'},{sheets:[]});
 const cells=plan.requests.flatMap(x=>x.updateCells?.rows||[]).flatMap(r=>r.values);assert.ok(cells.some(c=>c.userEnteredValue.numberValue===1.11&&c.userEnteredFormat.numberFormat.type==='CURRENCY'));
});
