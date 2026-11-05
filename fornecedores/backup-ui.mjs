export function createBackupStatus(client,parent){
 const box=document.createElement('section');box.className='backup-status';box.setAttribute('aria-label','Backup dos dados');box.setAttribute('aria-live','polite');parent.append(box);
 let stopped=false;
 async function refresh(){
  try{
   const{data:s,error}=await client.rpc('fin_backup_status');if(stopped)return;
   if(error||!s)throw Error();
   const stamp=s.lastSuccess?new Date(s.lastSuccess).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):null;
   const old=stamp&&Date.now()-Date.parse(s.lastSuccess)>24*3600*1000&&s.currentRevision!==s.lastRevision;
   let label=!s.enabled?'Backup automático ainda não ativado':s.error?'Backup pendente · nova tentativa automática':s.currentRevision!==s.lastRevision?'Alterações aguardando cópia automática':stamp?'Dados copiados e conferidos':'Primeira cópia aguardando execução';
   if(old)label='Atenção: alterações sem cópia há mais de 24 horas';
   box.dataset.state=!s.enabled||s.error||old?'warning':s.currentRevision===s.lastRevision?'ok':'pending';
   box.replaceChildren();const title=document.createElement('strong');title.textContent=label;
   const detail=document.createElement('span');detail.textContent=stamp?'Última cópia: '+stamp+' (Brasília).':'Nenhuma cópia confirmada ainda.';
   const note=document.createElement('small');note.textContent='Verificação a cada 5 minutos. Versões anteriores preservadas. Sem comprovantes.';
   box.append(title,detail,note);
   if(s.enabled&&s.spreadsheetId){const a=document.createElement('a');a.href='https://docs.google.com/spreadsheets/d/'+encodeURIComponent(s.spreadsheetId)+'/edit';a.target='_blank';a.rel='noopener';a.textContent='Abrir backup no Google';box.append(a)}
  }catch{if(!stopped){box.dataset.state='warning';box.textContent='Não foi possível consultar o backup. A última cópia não foi confirmada nesta consulta.'}}
 }
 const timer=setInterval(refresh,60000);
 return{refresh,stop(){stopped=true;clearInterval(timer);box.remove()}};
}
