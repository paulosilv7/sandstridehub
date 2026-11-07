// Uso: node fornecedores/restore-backup.mjs exportacao-da-aba-versao.json restauracao.sql
// Entrada: {"values":[["sandstride-fornecedores-v1"], ...]} lida da aba v_REVISÃO.
// Gera SQL de conferência em schema separado; nunca conecta nem altera a produção.
import fs from 'node:fs/promises';
import {restoreChunks,checksum} from '../supabase/functions/fin-backup/backup.mjs';
const[input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Informe o JSON exportado da versão e o caminho do SQL de conferência.');
const recovered=restoreChunks(JSON.parse(await fs.readFile(input,'utf8')).values);
if(await checksum(recovered.text)!==recovered.digest)throw Error('SHA-256 divergente. Não restaurar.');
// Backups anteriores à situação do fornecedor não têm `active`; preserve a
// compatibilidade tratando-os como ativos, que era o comportamento original.
const payload=structuredClone(recovered.payload);
payload.suppliers=payload.suppliers.map(supplier=>({...supplier,active:supplier.active!==false}));
const schema='fin_restore_'+recovered.payload.revision;
const literal=value=>"'"+JSON.stringify(value).replace(/'/g,"''")+"'::jsonb";
let sql=`-- Apenas conferência isolada. Execute após instalar as migrações da ferramenta.\nbegin;\ncreate schema ${schema};\n`;
for(const key of ['suppliers','products','prices','entries','history']){
 sql+=`create table ${schema}.${key} (like public.fin_${key} including defaults including constraints);\n`;
 sql+=`insert into ${schema}.${key} select * from jsonb_populate_recordset(null::${schema}.${key},${literal(payload[key])});\n`;
 sql+=`select '${key}' as tabela,count(*) as registros from ${schema}.${key};\n`;
}
sql+=`select coalesce(sum(case when cancelled then 0 when type='purchase' then value else -value end),0) as saldo_centavos from ${schema}.entries;\ncommit;\n`;
await fs.writeFile(output,sql,{flag:'wx'});
console.log('Integridade conferida. SQL de recuperação isolada gerado para revisão',recovered.payload.revision);
