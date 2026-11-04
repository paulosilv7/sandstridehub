// Carregar após interface.js, apenas depois de instalar e testar 001_finance.sql.
// Configuração pública em window.SANDSTRIDE_SUPABASE; nunca usar service_role.
(async()=>{
 const empty=()=>({suppliers:[],products:[],entries:[],audit:[]});
 let client,revision=0,lastConfirmed=empty(),busy=false,ready=false;
 db=empty();
 const main=document.querySelector('main'),notice=document.querySelector('.notice');
 notice.textContent='Carregando o financeiro da central Sandstride…';
 document.querySelector('main > p.tiny').textContent='Fornecedores · Central Sandstride · Compras, pagamentos e saldos mensais.';
 const gateStyle=document.createElement('style');gateStyle.textContent='[hidden]{display:none!important}';document.head.append(gateStyle);
 const existingRender=render,existingOpen=openForm;
 const authPanel=document.createElement('section');authPanel.className='card';authPanel.style.maxWidth='480px';authPanel.style.margin='40px auto';
 main.insertBefore(authPanel,document.getElementById('nav'));
 const status=document.createElement('p');status.setAttribute('role','status');status.textContent='Conectando ao financeiro…';authPanel.append(status);
 function lock(){ready=false;db=empty();lastConfirmed=empty();document.body.classList.remove('finance-ready');document.getElementById('nav').hidden=true;app.hidden=true;authPanel.hidden=false;modal.close();}
 render=function(){if(!ready)return;existingRender();};
 openForm=function(type,id){if(!ready||busy)return;existingOpen(type,id);};
 // Estes lançamentos são apenas documentos financeiros; não executam transferências bancárias.
 const updateButton=document.createElement('button');updateButton.type='button';updateButton.textContent='Atualizar dados';updateButton.style.marginLeft='12px';
 const logout=document.createElement('button');logout.type='button';logout.textContent='Sair';logout.style.marginLeft='8px';
 const user=document.querySelector('.user');user.style.display='flex';user.style.alignItems='center';user.style.flexWrap='wrap';user.style.gap='8px';
 const name=document.createElement('span');const home=document.createElement('a');home.href='/';home.textContent='Central';home.style.marginLeft='12px';user.replaceChildren(name,updateButton,home,logout);
 async function load(){const {data,error}=await client.rpc('fin_read');if(error)throw error;revision=data.revision;db={suppliers:data.suppliers,products:data.products,entries:data.entries,audit:[]};lastConfirmed=structuredClone(db);ready=true;document.body.classList.add('finance-ready');authPanel.hidden=true;app.hidden=false;document.getElementById('nav').hidden=false;render();notice.textContent='Financeiro compartilhado · Dados salvos no Supabase · Acesso restrito.';}
 function failure(error){notice.textContent='Não foi possível concluir a operação. '+(error?.code==='40001'?'Outro usuário atualizou os dados. Atualize a tela e repita o lançamento.':error?.code==='42501'?'Seu usuário não tem acesso ao financeiro.':'Confira sua conexão e tente novamente.');}
 save=async function(){if(!ready||busy){db=structuredClone(lastConfirmed);return}busy=true;const pending=structuredClone(db);notice.textContent='Salvando no Supabase…';document.getElementById('form').querySelector('footer .primary').disabled=true;try{const{error}=await client.rpc('fin_commit',{expected_revision:revision,payload:pending});if(error)throw error;await load();notice.textContent='Registro salvo no Supabase.';}catch(error){db=structuredClone(lastConfirmed);render();failure(error);}finally{busy=false;document.getElementById('form').querySelector('footer .primary').disabled=false}};
 updateButton.onclick=async()=>{if(busy||modal.open)return;try{await load()}catch(e){failure(e)}};
 logout.onclick=async()=>{if(busy)return;await client.auth.signOut({scope:'local'});lock();loginView();};
 function loginView(message='Entre com o mesmo e-mail e senha da central Sandstride.'){
  if(window.SANDSTRIDE_SUPABASE?.sharedLogin){location.replace('/?next=%2Ffornecedores%2F');return;}
  authPanel.replaceChildren();let title=document.createElement('h2');title.textContent='Acessar o financeiro';let intro=document.createElement('p');intro.textContent=message;let form=document.createElement('form');form.innerHTML='<label for="financeEmail">E-mail</label><input id="financeEmail" name="email" type="email" autocomplete="username" required><label for="financePassword">Senha</label><input id="financePassword" name="password" type="password" autocomplete="current-password" required><button class="primary" style="width:100%;margin-top:22px">Entrar</button><p role="status" class="muted"></p>';authPanel.append(title,intro,form);
  form.onsubmit=async ev=>{ev.preventDefault();let button=form.querySelector('button'),msg=form.querySelector('[role=status]');button.disabled=true;msg.textContent='Entrando…';try{let {data,error}=await client.auth.signInWithPassword({email:form.elements.email.value.trim(),password:form.elements.password.value});form.elements.password.value='';if(error)throw error;name.textContent=data.user.email+' · Administrador';await load();}catch(e){msg.textContent=e?.code==='42501'?'Este usuário não tem acesso ao financeiro.':'Não foi possível entrar. Confira suas credenciais e a conexão.';}finally{button.disabled=false}};
 }
 lock();
 const config=window.SANDSTRIDE_SUPABASE;
 if(!config?.url||!config?.publishableKey){status.textContent='Integração ainda não configurada. O banco está em preparação.';return;}
 try{
  const {createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  client=createClient(config.url,config.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  client.auth.onAuthStateChange((event)=>{if(event==='SIGNED_OUT'){lock();loginView();}});
  const {data:{session},error}=await client.auth.getSession();if(error)throw error;
  if(session){name.textContent=session.user.email+' · Administrador';try{await load()}catch(e){lock();authPanel.replaceChildren(status);status.textContent=e?.code==='42501'?'Seu usuário não tem acesso ao financeiro.':'O financeiro ainda não está disponível. A migração do banco precisa ser aplicada e validada.';const back=document.createElement('a');back.href='/';back.textContent='Voltar à central';authPanel.append(back);}}
  else loginView();
  // Atualiza ao retornar à aba, sem interromper um formulário aberto.
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&ready&&!busy&&!modal.open)load().catch(failure)});
 }catch(e){lock();authPanel.replaceChildren(status);status.textContent='Não foi possível conectar. Verifique a conexão e recarregue a página.';}
})();
