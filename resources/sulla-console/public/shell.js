const routes={
  overview:{title:'Overview',service:'accounts',audience:'sulla-accounts',href:'/services/accounts/?view=overview'},
  people:{title:'People',service:'accounts',audience:'sulla-accounts',href:'/services/accounts/?view=people'},
  devices:{title:'Devices',service:'accounts',audience:'sulla-accounts',href:'/services/accounts/?view=devices'},
  files:{title:'Files',service:'files',audience:'sulla-files',href:'/services/files/'},
  'audit-log':{title:'Audit Log',service:'vault',audience:'sulla-vault',href:'/services/vault/audit'},
  'agents-pods':{title:'Agents & pods',service:'agents',audience:'sulla-agents',href:'/services/agents/'},
  workflows:{title:'Workflows',service:'workflows',audience:'sulla-workflows',href:'/services/workflows/'},
  settings:{title:'Settings',service:'accounts',audience:'sulla-accounts',href:'/services/accounts/?view=settings'},
  projects:{title:'Projects',service:'projects',audience:'sulla-projects',href:'/services/projects/'},
};
const frame=document.getElementById('service-frame');
const empty=document.getElementById('empty-state');
const title=document.getElementById('service-title');
const status=document.getElementById('service-status');
const connection=document.getElementById('connection');
const shell=document.getElementById('console-shell');
const gate=document.getElementById('auth-gate');
const origin=window.location.origin;
const sessions=new Map();
const refreshTimers=new Map();
let organizationId='';
let identityKey='';
let account=null;
let active=null;
let loadTimer=0;
let accountTimer=0;

function cookie(name){return document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith(`${name}=`))?.slice(name.length+1)??''}
function setStatus(message,state='idle'){status.textContent=message;status.className=state==='error'?'error':'';connection.dataset.state=state}
function send(message){if(active&&frame.contentWindow)frame.contentWindow.postMessage(message,origin)}
function forgetSession(service){sessions.delete(service);window.clearTimeout(refreshTimers.get(service));refreshTimers.delete(service)}
function wipeFrame(reason){
  window.clearTimeout(loadTimer);
  if(active)send({type:'sulla.service.lock',version:1,service:active.route.service,reason});
  frame.hidden=true;
  frame.src='about:blank';
  frame.title='Sulla service';
  active=null;
  document.body.classList.remove('service-open');
  document.getElementById('back').hidden=true;
  document.getElementById('header-title').hidden=false;
  document.querySelectorAll('[data-area]').forEach(item=>item.classList.remove('active'));
}
function lockAll(reason){wipeFrame(reason);for(const service of [...sessions.keys()])forgetSession(service)}
function returnTarget(){return `${location.pathname}${location.search}`}
function showGate(message='Accounts protects every service with one session.'){
  lockAll('authentication-required');
  account=null;organizationId='';identityKey='';
  window.clearTimeout(accountTimer);
  shell.hidden=true;gate.hidden=false;
  document.getElementById('auth-message').textContent=message;
  document.getElementById('gate-signin').href=`/accounts-api/v1/web/login?returnTo=${encodeURIComponent(returnTarget())}`;
}
function showShell(){gate.hidden=true;shell.hidden=false}
async function loadAccountSession(){
  const response=await fetch('/accounts-api/v1/web/session',{credentials:'include',cache:'no-store'});
  if(!response.ok){const error=new Error('Sign in through Accounts first.');error.authenticationRequired=response.status===401||response.status===403;throw error}
  const next=await response.json();
  const selected=next.organizations?.find(item=>item.id===organizationId)??next.organizations?.[0];
  if(!selected?.id)throw new Error('Your Accounts session does not have an organization.');
  const nextIdentity=JSON.stringify(next.identity??null);
  if((organizationId&&organizationId!==selected.id)||(identityKey&&identityKey!==nextIdentity))lockAll(organizationId!==selected.id?'organization-change':'identity-change');
  organizationId=selected.id;identityKey=nextIdentity;account=next;
  renderAccount(next,selected);showShell();
  window.clearTimeout(accountTimer);accountTimer=window.setTimeout(verifyAccount,60_000);
  return next;
}
async function verifyAccount(){try{await loadAccountSession()}catch(error){showGate(error instanceof Error?error.message:'Your Accounts session ended.')}}
async function mintSession(route){
  await loadAccountSession();
  const csrf=decodeURIComponent(cookie('sulla-console-csrf'));
  if(!csrf){const error=new Error('Sign in through Accounts first.');error.authenticationRequired=true;throw error}
  const response=await fetch('/accounts-api/v1/web/ui-sessions',{method:'POST',credentials:'include',cache:'no-store',headers:{'Content-Type':'application/json','X-Sulla-CSRF':csrf},body:JSON.stringify({service:route.service,audience:route.audience,organizationId})});
  if(!response.ok){const error=new Error(response.status===401?'Sign in through Accounts first.':'This account cannot open that service.');error.authenticationRequired=response.status===401;throw error}
  const session=await response.json();
  if(session.service!==route.service||session.audience!==route.audience||session.organizationId!==organizationId||typeof session.token!=='string'||!Number.isFinite(Date.parse(session.expiresAt)))throw new Error('Accounts returned an invalid service session.');
  sessions.set(route.service,session);
  window.clearTimeout(refreshTimers.get(route.service));
  const refreshIn=Math.max(10_000,Date.parse(session.expiresAt)-Date.now()-60_000);
  refreshTimers.set(route.service,window.setTimeout(()=>{if(active?.route.service!==route.service)return forgetSession(route.service);void deliverSession(route)},refreshIn));
  return session;
}
async function deliverSession(route){
  try{
    let session=sessions.get(route.service);
    if(!session||session.organizationId!==organizationId||Date.parse(session.expiresAt)-Date.now()<60_000)session=await mintSession(route);
    if(active?.route!==route)return;
    send({type:'sulla.service.session',version:1,service:route.service,token:session.token,expiresAt:session.expiresAt,organizationId:session.organizationId,email:account?.identity?.email});
    setStatus('Connected','connected');
  }catch(error){
    forgetSession(route.service);
    if(error?.authenticationRequired){showGate('Your Accounts session ended. Sign in again to continue.');return}
    if(active?.route===route){wipeFrame('authentication-failed');empty.hidden=false;setStatus(error instanceof Error?error.message:'Session unavailable','error')}
  }
}
function areaFromLocation(){const value=new URL(location.href).searchParams.get('area');return value&&routes[value]?value:null}
function urlForArea(area){const url=new URL('/console/',origin);if(area)url.searchParams.set('area',area);return `${url.pathname}${url.search}`}
function openArea(area){
  wipeFrame('navigation');
  if(!area){title.textContent='Console';empty.hidden=false;setStatus('Choose a section','idle');return}
  const route=routes[area];
  active={area,route};
  title.textContent=route.title;
  setStatus('Connecting…','idle');
  document.querySelector(`[data-area="${area}"]`)?.classList.add('active');
  frame.title=`Sulla ${route.title}`;
  frame.src=route.href;
  empty.hidden=true;frame.hidden=false;
  document.body.classList.add('service-open');
  document.getElementById('back').hidden=false;
  document.getElementById('header-title').hidden=true;
  loadTimer=window.setTimeout(()=>{if(active?.route===route&&status.textContent==='Connecting…')setStatus('Service unavailable','error')},8000);
}
function navigate(area){
  const depth=Number.isInteger(history.state?.sullaConsoleDepth)?history.state.sullaConsoleDepth:0;
  history.pushState({sullaConsoleDepth:depth+1,area},'',urlForArea(area));
  openArea(area);
}
function backToConsole(){
  if((history.state?.sullaConsoleDepth??0)>0){history.back();return}
  history.replaceState({sullaConsoleDepth:0,area:null},'',urlForArea(null));openArea(null);
}
document.querySelectorAll('[data-area]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.area)));
document.getElementById('back').addEventListener('click',backToConsole);
window.addEventListener('popstate',()=>openArea(areaFromLocation()));
window.addEventListener('message',event=>{
  if(event.origin!==origin||event.source!==frame.contentWindow||!active)return;
  const message=event.data;
  if(!message||message.version!==1||message.service!==active.route.service)return;
  if(message.type==='sulla.service.ready'){window.clearTimeout(loadTimer);setStatus('Authenticating…','idle');void deliverSession(active.route);return}
  if(message.type==='sulla.service.activity'){setStatus('Connected','connected');return}
  if(message.type==='sulla.service.expired'){
    forgetSession(active.route.service);wipeFrame('session-expired');
    history.replaceState({sullaConsoleDepth:0,area:null},'',urlForArea(null));
    empty.hidden=false;setStatus('Session expired. Reopen the section.','error');return;
  }
  if(message.type==='sulla.console.navigate'&&active.route.service==='accounts'&&message.destination==='projects')navigate('projects');
});
window.addEventListener('pagehide',()=>{lockAll('pagehide');organizationId='';identityKey='';account=null});
window.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&account)void verifyAccount()});

function renderAccount(value,selected){
  const picker=document.getElementById('organization');
  picker.replaceChildren(...value.organizations.map(org=>{const option=document.createElement('option');option.value=org.id;option.textContent=org.name||org.slug||org.id;return option}));
  picker.value=organizationId;
  document.getElementById('organization-name').textContent=selected.name||selected.slug||'Sulla Server';
  document.getElementById('organization-label').hidden=value.organizations.length<2;
  document.getElementById('signout').hidden=false;document.getElementById('signin').hidden=true;
  document.getElementById('account-status').textContent='Signed in';
}
document.getElementById('organization').addEventListener('change',event=>{lockAll('organization-change');organizationId=event.target.value;openArea(areaFromLocation())});
document.getElementById('signout').addEventListener('click',async()=>{
  lockAll('signout');
  try{
    const response=await fetch('/accounts-api/v1/web/logout',{method:'POST',credentials:'include',headers:{'X-Sulla-CSRF':decodeURIComponent(cookie('sulla-console-csrf'))}});
    if(!response.ok)throw new Error('Sign out failed');
    history.replaceState({sullaConsoleDepth:0,area:null},'',urlForArea(null));showGate('You are signed out.');
  }catch{showShell();document.getElementById('account-status').textContent='Sign out failed. Please retry.';setStatus('Sign out failed','error')}
});

history.replaceState({sullaConsoleDepth:0,area:areaFromLocation()},'',location.href);
document.getElementById('signin').href=`/accounts-api/v1/web/login?returnTo=${encodeURIComponent(returnTarget())}`;
void loadAccountSession().then(()=>openArea(areaFromLocation())).catch(error=>showGate(error instanceof Error?error.message:'Sign in through Accounts first.'));
