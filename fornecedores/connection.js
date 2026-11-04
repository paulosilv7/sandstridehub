(async()=>{
 const empty=()=>({suppliers:[],products:[],entries:[],audit:[]});
 let client,store,ready=false,generation=0,savedControls=[];
 db=empty();const main=document.querySelector('main'),notice=document.querySelector('.notice');
 notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');
 document.querySelector('main > p.tiny').textContent='Fornecedores · Central Sandstride · Compras, pagamentos e saldos mensais.';
 const gateStyle=document.createElement('style');gateStyle.textContent='[hidden]{display:none!important}';document.head.append(gateStyle);
 const originalRender=render,originalOpen=openForm;
 const authPanel=document.createElement('section');authPanel.className='card';authPanel.style.maxWidth='480px';authPanel.style.margin='40px auto';main.insertBefore(authPanel,document.getElementById('nav'));
 function status(message,kind=''){notice.textContent=message;notice.dataset.kind=kind;notice.setAttribute('role',kind==='error'?'alert':'status');}
 function lock(){generation++;ready=false;db=empty();window.FinanceAttachments?.reset();document.body.classList.remove('finance-ready','finance-busy');document.getElementById('nav').hidden=true;app.hidden=true;authPanel.hidden=false;modal.close();}
 function setBusy(value){document.body.classList.toggle('finance-busy',value);if(value){savedControls=[...document.querySelectorAll('#form input,#form select,#form button')].map(control=>[control,control.disabled]);savedControls.forEach(([control])=>control.disabled=true)}else{savedControls.forEach(([control,disabled])=>{if(control.isConnected)control.disabled=disabled});savedControls=[]}const saveButton=document.querySelector('#form footer .primary');if(saveButton)saveButton.setAttribute('aria-busy',String(value));updateButton.disabled=value;logout.disabled=value;}
 function showState(){db=structuredClone(store.state);ready=true;document.body.classList.add('finance-ready');authPanel.hidden=true;app.hidden=false;document.getElementById('nav').hidden=false;render();}
 function failure(error){let message=error?.code==='40001'?'Outra pessoa atualizou os dados. A lista foi atualizada; confira os campos e salve novamente.':error?.code==='42501'?'Seu usuário não tem acesso ao financeiro.':error?.message&&/vigência|histórico|cancelado|total|quantidade|duplicado|limite|precisão/i.test(error.message)?error.message:'Não foi possível confirmar a gravação. Os campos foram mantidos; confira os dados antes de tentar novamente.';status(message,'error');return message;}
 render=function(){if(ready)originalRender()};
 openForm=function(type,id){if(ready&&!store.busy&&!window.FinanceAttachments?.busy)originalOpen(type,id)};
 const user=document.querySelector('.user'),name=document.createElement('span'),updateButton=document.createElement('button'),logout=document.createElement('button'),home=document.createElement('a');
 const icon=path=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+path+'</svg>';
 function headerAction(element,label,svg){element.className='header-action';element.setAttribute('aria-label',label);element.dataset.tooltip=label;element.innerHTML=icon(svg);}
 updateButton.type='button';logout.type='button';home.href='/';
 headerAction(home,'Voltar à central','<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>');
 headerAction(updateButton,'Atualizar dados','<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8"/>');
 headerAction(logout,'Sair da conta','<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4m5-4 4-4-4-4m-5 4h12"/>');
 name.className='header-account';name.textContent='L';name.tabIndex=0;user.classList.add('header-tools');user.setAttribute('role','toolbar');user.setAttribute('aria-label','Ações de Fornecedores');user.style.display='flex';user.replaceChildren(home,name,updateButton,logout);document.body.append(user);
 async function refresh(){if(store.busy||modal.open||window.FinanceAttachments?.busy)return;const epoch=generation;setBusy(true);try{await store.refresh();if(epoch!==generation)return;showState();await window.FinanceAttachments?.refresh();status('Financeiro compartilhado · Dados atualizados.')}catch(e){if(epoch===generation)failure(e)}finally{setBusy(false)}}
 save=async function(){if(!ready||store.busy){status('Aguarde a conclusão da operação atual.','error');return false}const epoch=generation;const pending=structuredClone(db);setBusy(true);status('Salvando no Supabase…');try{const result=await store.commit(pending);if(epoch!==generation)return false;showState();status(result.refreshPending?'Registro salvo e confirmado. Atualize a lista quando a conexão voltar.':result.reconciled?'Registro já confirmado no banco. Nenhum lançamento duplicado foi criado.':'Registro salvo no Supabase.','success');return true;}catch(e){if(epoch===generation){if(store.state){db=structuredClone(store.state);render()}failure(e)}return false;}finally{setBusy(false)}};
 cancelEntry=async function(id){if(!ready||store.busy)return;const record=db.entries.find(e=>e.id===id);if(!record||record.cancelled)return;if(!confirm('Cancelar o lançamento de '+money(record.value)+' de '+record.supplier+'? O saldo será recalculado e o histórico será preservado.'))return;const next=structuredClone(db);next.entries.find(e=>e.id===id).cancelled=true;db=next;await save();};
 updateButton.onclick=refresh;
 logout.onclick=async()=>{if(store?.busy||window.FinanceAttachments?.busy)return;try{const{error}=await client.auth.signOut({scope:'local'});if(error)throw error;lock();loginView()}catch(e){status('Não foi possível sair. Confira sua conexão e tente novamente.','error')}};
 function loginView(){location.replace('/?next=%2Ffornecedores%2F')}
 function unavailable(message){lock();authPanel.replaceChildren();const title=document.createElement('h2');title.textContent='Financeiro indisponível';const text=document.createElement('p');text.textContent=message;const back=document.createElement('a');back.href='/';back.textContent='Voltar à central';const retry=document.createElement('button');retry.textContent='Tentar novamente';retry.onclick=()=>location.reload();authPanel.append(title,text,back,document.createElement('br'),retry);status('Não foi possível carregar os dados.','error');}
 lock();status('Conectando ao financeiro…');authPanel.textContent='Carregando seus dados…';const config=window.SANDSTRIDE_SUPABASE;
 if(!config?.url||!config?.publishableKey){unavailable('A conexão com o banco não foi configurada.');return}
 try{
  const [{createClient},{FinanceStore},{ReceiptStore,validateReceipt}]=await Promise.all([import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm'),import('./finance-store.mjs'),import('./receipts.mjs')]);
  client=createClient(config.url,config.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});store=new FinanceStore(client,FinanceCore.validateSnapshot);
  client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){lock();loginView()}});
  const{data:{session},error}=await client.auth.getSession();if(error)throw error;if(!session){loginView();return}
  window.FinanceReceipts=new ReceiptStore(client);window.FinanceReceipts.validate=validateReceipt;
  name.textContent=session.user.email.slice(0,1).toLocaleUpperCase('pt-BR');name.dataset.tooltip=session.user.email+' · Administrador';name.setAttribute('aria-label',name.dataset.tooltip);await refresh();
  if(!ready)unavailable('Não foi possível carregar o financeiro. Confira sua conexão e o acesso do seu usuário.');
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&ready&&!store.busy&&!modal.open)refresh()});
 }catch(e){unavailable('Confira sua conexão e tente carregar novamente. Seus dados continuam no banco.');}
})();
