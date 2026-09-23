'use strict';
// Behavioral tests use a small DOM adapter. Browser layout is checked separately.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const catalogScript=fs.readFileSync(path.join(__dirname,'..','frontend/catalog.js'),'utf8');
const originalScript=fs.readFileSync(path.join(__dirname,'..','frontend/app.js'),'utf8');
const cart=(items=[])=>({mode:'prototype',items,total:items.reduce((s,i)=>s+i.line_total,0),currency:null,cart_url:'/cart'});
const product={id:515291,name:'Legrand 160A',sku:'200300285_',price:64920,currency:null,stock:23,attributes:{Ток:'160 A'},warnings:[],image:null};
const envelope=(overrides={})=>({reply:{message:'Жауап',cards:[],links:{}},confirmation:null,cart:cart(),...overrides});
const jsonResponse=(body,status=200)=>({ok:status<400,status,json:async()=>body});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function harness(t,options={}){
  const ids=new Map(),selectors=new Map(),nodes=[],timers=new Set(),calls=[];
  class Element{
    constructor(){this.children=[];this.listeners={};this.style={};this.dataset={};this._html='';this.hidden=false;this.isConnected=true;this.value='';this.scrollHeight=100;this.classList={toggle(){}};nodes.push(this);}
    set innerHTML(value){this._html=String(value);this.children=[];for(const match of this._html.matchAll(/\bid="([^"]+)"/g))if(!ids.has(match[1]))ids.set(match[1],new Element());}
    get innerHTML(){return this._html;}
    append(node){node.parentElement=this;this.children.push(node);}
    querySelector(selector){if(!this.queries)this.queries=new Map();if(!this.queries.has(selector)){const child=new Element();child.parentElement=this;this.queries.set(selector,child);}return this.queries.get(selector);}
    querySelectorAll(){return this.focusables||[];}
    addEventListener(type,handler){this.listeners[type]=handler;}
    scrollTo(value){this.scrollTop=value.top;}
    setAttribute(name,value){this[name]=value;}
    focus(){document.activeElement=this;}
    remove(){this.isConnected=false;}
    getClientRects(){return this.hidden?[]:[1];}
  }
  for(const match of html.matchAll(/\bid="([^"]+)"/g))ids.set(match[1],new Element());
  const badges=[new Element(),new Element(),new Element()];
  const document={body:new Element(),activeElement:new Element(),listeners:{},
    querySelector(selector){if(selector.startsWith('#')){const [id,...rest]=selector.slice(1).split(' ');const el=ids.get(id);return rest.length?el?.querySelector(rest.join(' ')):el;}if(!selectors.has(selector))selectors.set(selector,new Element());return selectors.get(selector);},
    querySelectorAll(selector){return selector==='.cart-count'?badges:[];},createElement(){return new Element();},getElementById(id){return ids.get(id);},addEventListener(type,handler){this.listeners[type]=handler;}};
  class TestFormData{constructor(){this.entries=[];}append(...args){this.entries.push(args);}}
  const context=vm.createContext({document,Intl,Date,Map,Set,Number,Object,String,Math,console,URL,URLSearchParams,AbortController,DOMException,TypeError,FormData:TestFormData,crypto:{randomUUID},location:{origin:'http://127.0.0.1:8000',pathname:options.pathname||'/',search:''},requestAnimationFrame:fn=>fn(),matchMedia:()=>({matches:true}),
    fetch:async(url,init)=>{calls.push({url,init});if(url==='/api/session')return jsonResponse({session_id:'session',ai_mode:'rules',cart_mode:'prototype',catalog_currency:null,capabilities:{}});if(url==='/api/cart')return jsonResponse(options.cart||cart());return options.fetch?options.fetch(url,init):Promise.reject(new Error('Unexpected request: '+url));},
    setTimeout:(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);return timer;},clearTimeout:timer=>{clearTimeout(timer);timers.delete(timer);}});
  vm.runInContext(catalogScript,context);
  const script=originalScript.replace('  void start();','  globalThis.appTest={state,catalogState,start,api,send,propose,confirm,reject,upload,useAttachment,applyEnvelope,displayProduct,productCard,money,showCart,operation,openModal,closeModal,loadCatalogPage,loadCatalogDetail,backToCatalog,retryCatalog,renderCatalogDetail,catalogPrice,catalogStock,setService(service){catalogService=service;catalogSetupError=null;}};');
  vm.runInContext(script,context);
  const app=context.appTest;
  t.after(()=>{app.closeModal();for(const timer of timers)clearTimeout(timer);});
  return {app,ids,document,badges,Element,calls,context,markup:()=>nodes.map(n=>n.innerHTML).join('\n'),cartCount:()=>app.state.cart.items.reduce((sum,item)=>sum+item.quantity,0)};
}
const result=(page,id=page)=>({page,items:[{id:String(id),name:'Тауар '+id,sku:'SKU-'+id,brand:null,price:null,stock:null,unit:null,description:null,specs:[],image:null,certificates:[]}],hasNext:null,totalPages:null});

test('boot uses real same-origin session/cart and does not seed fabricated products',async t=>{
  const h=harness(t);await h.app.start();assert.equal(h.cartCount(),0);assert.equal(h.app.state.cards.size,0);
  assert.deepEqual(h.calls.map(c=>c.url),['/api/session','/api/cart']);assert.ok(h.calls.every(c=>c.init.credentials==='same-origin'));
  assert.match(h.markup(),/Тестілік себет/);assert.doesNotMatch(h.markup(),/MOCK-001|DEMO-01|128/);
  assert.match(html,/data-action="catalog"/);assert.match(html,/<html lang="kk">/);
});
test('catalog maps actual article/quantity/properties and escapes remote content',async t=>{
  const raw={id:515291,article:'DO-NOT-USE-AS-ID',name:'<img src=x onerror=alert(1)>',price:0,quantity:null,description:'<script>alert(1)</script>',properties:{'<b>Кілт</b>':'<svg onload=alert(1)>'},image:'javascript:alert(1)',certificates:[{name:'<b>PDF</b>',url:'https://files.test/cert.pdf'}]};
  const h=harness(t,{fetch:async url=>jsonResponse(url.endsWith('/515291')?{data:raw}:{data:{page:1,count:20,per_page:20,items:[raw]}})});await h.app.start();h.app.openModal('#catalogOverlay');await h.app.loadCatalogPage(1);
  assert.match(h.ids.get('catalogItems').innerHTML,/data-catalog-detail="515291"/);assert.match(h.ids.get('catalogItems').innerHTML,/&lt;img/);assert.match(h.ids.get('catalogItems').innerHTML,/Қалдық туралы дерек жоқ/);assert.equal(h.ids.get('catalogNext').disabled,false);
  await h.app.loadCatalogDetail('515291');const detail=h.ids.get('productDetail').innerHTML;
  assert.match(detail,/&lt;script&gt;/);assert.match(detail,/&lt;b&gt;Кілт/);assert.doesNotMatch(detail,/javascript:|<script>|<svg onload=/);assert.match(detail,/валюта көрсетілмеген/);assert.equal(h.cartCount(),0);
  assert.ok(h.calls.some(c=>c.url==='http://127.0.0.1:8000/products/515291'));
});
test('later page wins even when earlier response ignores cancellation',async t=>{
  const h=harness(t),first=defer(),second=defer();let signal;
  h.app.setService({list:(page,options)=>{if(page===1){signal=options.signal;return first.promise;}return second.promise;}});
  h.app.openModal('#catalogOverlay');const p1=h.app.loadCatalogPage(1),p2=h.app.loadCatalogPage(2);assert.equal(signal.aborted,true);second.resolve(result(2,222));await p2;first.resolve(result(1,111));await p1;
  assert.equal(h.app.catalogState.page,2);assert.match(h.ids.get('catalogItems').innerHTML,/data-catalog-detail="222"/);assert.doesNotMatch(h.ids.get('catalogItems').innerHTML,/data-catalog-detail="111"/);
});
test('closing and reopening modal ignores stale responses',async t=>{
  const h=harness(t),old=defer(),current=defer();let n=0,signal;
  h.app.setService({list:(_page,options)=>{if(++n===1){signal=options.signal;return old.promise;}return current.promise;}});
  h.app.openModal('#catalogOverlay');const first=h.app.loadCatalogPage(1);h.app.closeModal();assert.equal(signal.aborted,true);h.app.openModal('#catalogOverlay');const second=h.app.loadCatalogPage(1);current.resolve(result(1,222));await second;old.resolve(result(1,111));await first;assert.match(h.ids.get('catalogItems').innerHTML,/222/);assert.doesNotMatch(h.ids.get('catalogItems').innerHTML,/111/);
});
test('back from loading detail retains prior page and rejects stale detail',async t=>{
  const h=harness(t),pending=defer();let signal;h.app.setService({list:async()=>result(2,222),detail:(_id,options)=>{signal=options.signal;return pending.promise;}});
  h.app.openModal('#catalogOverlay');await h.app.loadCatalogPage(2);const detail=h.app.loadCatalogDetail('222');h.app.backToCatalog();assert.equal(signal.aborted,true);pending.resolve(result(2,222).items[0]);await detail;assert.equal(h.app.catalogState.view,'list');assert.equal(h.app.catalogState.page,2);assert.equal(h.ids.get('productDetail').hidden,true);
});
test('catalog HTTP detail is visible, with no fixture fallback and same-page retry',async t=>{
  let n=0;const h=harness(t,{fetch:async()=>++n===1?jsonResponse({detail:'Supplier unavailable'},503):jsonResponse({data:{page:2,items:[{id:202,name:'Real'}]}})});h.app.openModal('#catalogOverlay');await h.app.loadCatalogPage(2);assert.match(h.ids.get('catalogFeedback').innerHTML,/Supplier unavailable/);assert.equal(h.app.catalogState.snapshot,null);h.app.retryCatalog();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.app.catalogState.snapshot.items[0].id,'202');assert.equal(h.calls[0].url,h.calls[1].url);
});
test('empty page stops pagination without zero-page denominator',async t=>{
  const h=harness(t,{fetch:async()=>jsonResponse({data:{page:1,count:0,per_page:20,items:[]}})});h.app.openModal('#catalogOverlay');await h.app.loadCatalogPage(1);assert.match(h.ids.get('catalogFeedback').innerHTML,/Бұл бетте тауар жоқ/);assert.doesNotMatch(h.ids.get('catalogPageLabel').textContent,/\/ 0/);assert.equal(h.ids.get('catalogNext').disabled,true);
});
test('focus trap wraps when focus is outside modal controls',t=>{
  const h=harness(t);h.app.openModal('#catalogOverlay');const first=new h.Element(),last=new h.Element();h.ids.get('catalogOverlay').focusables=[first,last];h.document.activeElement=h.ids.get('catalogPageLabel');let prevented=false;h.document.listeners.keydown({key:'Tab',shiftKey:false,preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(h.document.activeElement,first);h.document.listeners.keydown({key:'Tab',shiftKey:true,preventDefault(){}});assert.equal(h.document.activeElement,last);
});
test('proposal leaves cart empty; explicit confirmation uses server token and prevents double click',async t=>{
  const pending=defer();const h=harness(t,{fetch:async(url,init)=>{
    if(url==='/api/cart/proposal')return jsonResponse(envelope({confirmation:{id:'token',product_id:515291,quantity:2,product}}));
    if(url==='/api/cart/confirm'){assert.equal(JSON.parse(init.body).confirmation_id,'token');return pending.promise;}
    throw new Error(url);
  }});await h.app.start();await h.app.propose('515291',2);assert.equal(h.cartCount(),0);assert.equal(h.app.state.pending.id,'token');assert.match(h.markup(),/валюта көрсетілмеген/);
  const first=h.app.confirm('token');await h.app.confirm('token');assert.equal(h.calls.filter(c=>c.url==='/api/cart/confirm').length,1);
  pending.resolve(jsonResponse(envelope({reply:{message:'Қосылды',links:{cart_url:'/cart'}},cart:cart([{product,quantity:2,line_total:129840}])})));await first;assert.equal(h.cartCount(),2);assert.equal(h.app.state.pending,null);await h.app.confirm('token');assert.equal(h.calls.filter(c=>c.url==='/api/cart/confirm').length,1);assert.match(h.markup(),/Тестілік себетті ашу/);
});
test('unsafe quantities send no mutation; cancellation is server-owned',async t=>{
  const h=harness(t,{fetch:async(url)=>{assert.equal(url,'/api/cart/cancel');return jsonResponse(envelope());}});await h.app.start();for(const qty of [-1,0,1.5,NaN])await h.app.propose('515291',qty);assert.equal(h.calls.length,2);
  h.app.applyEnvelope(envelope({confirmation:{id:'cancel-token',quantity:1,product_id:515291,product}}));await h.app.reject('cancel-token');assert.equal(h.app.state.pending,null);assert.equal(h.cartCount(),0);
});
test('failed mutation retry reuses request ID, and chat carries pending confirmation token',async t=>{
  let attempts=0;const h=harness(t,{fetch:async()=>++attempts===1?jsonResponse({detail:'Retry safely'},504):jsonResponse(envelope())});await h.app.start();h.app.applyEnvelope(envelope({confirmation:{id:'token',product_id:515291,quantity:1,product}}));await h.app.send('Иә, қосу');assert.match(h.markup(),/Retry safely/);const retry=h.app.state.retry;await h.app.operation(retry.path,retry.body,retry.method);const calls=h.calls.filter(c=>c.url==='/api/chat');assert.equal(calls.length,2);assert.equal(calls[0].init.body,calls[1].init.body);assert.equal(JSON.parse(calls[0].init.body).confirmation_id,'token');assert.match(JSON.parse(calls[0].init.body).request_id,/^[0-9a-f-]{36}$/);
});
test('refresh restores server cart and /cart opens the cart drawer',async t=>{
  const h=harness(t,{pathname:'/cart',cart:cart([{product,quantity:2,line_total:129840}])});await h.app.start();assert.equal(h.cartCount(),2);assert.equal(h.app.state.modal,h.ids.get('cartOverlay'));assert.ok(h.badges.every(b=>b.textContent===2));
});
test('upload extracts into editable review only; no automatic chat or confirmation',async t=>{
  const h=harness(t,{fetch:async(url,init)=>{assert.equal(url,'/api/attachments');assert.equal(init.body.entries[0][0],'file');assert.equal(init.headers['Content-Type'],undefined);return jsonResponse({filename:'<test>.pdf',text:'C16 10 дана',notes:['Мәтінді тексеріңіз']});}});await h.app.start();h.app.applyEnvelope(envelope({confirmation:{id:'old-token',product_id:515291,quantity:1,product}}));await h.app.upload({name:'<test>.pdf',size:2000});assert.equal(h.app.state.pending,null);assert.equal(h.ids.get('attachmentText').value,'C16 10 дана');assert.equal(h.app.state.modal,h.ids.get('attachmentOverlay'));assert.equal(h.cartCount(),0);assert.equal(h.calls.length,3);
  h.ids.get('attachmentText').value='C16 2 дана';h.app.useAttachment();assert.equal(h.ids.get('messageInput').value,'C16 2 дана');assert.equal(h.calls.length,3);assert.equal(h.app.state.modal,null);
  for(const file of [{name:'large.pdf',size:11*1024*1024},{name:'program.exe',size:100},{name:'legacy.doc',size:100},{name:'image.png',size:100}])await h.app.upload(file);assert.equal(h.calls.length,3);
});
test('expired session is visible and never silently creates a replacement cart',async t=>{
  const h=harness(t,{fetch:async()=>jsonResponse({detail:'Session expired'},401)});await h.app.start();await h.app.send('ID 515291');assert.equal(h.app.state.expired,true);assert.equal(h.app.state.session,null);assert.match(h.markup(),/Бетті қайта жүктеу/);await h.app.send('Тағы');assert.equal(h.calls.filter(c=>c.url==='/api/session').length,1);assert.equal(h.calls.filter(c=>c.url==='/api/chat').length,1);
});
test('payment secrets are neither sent to the server nor rendered in conversation',async t=>{
  const h=harness(t);await h.app.start();
  for(const text of ['Карта 4111 1111 1111 1111','CVV 321','cvc: 123','пароль secret-password'])await h.app.send(text);
  assert.equal(h.calls.length,2);assert.match(h.markup(),/Төлем деректерін чатқа жібермеңіз/);assert.doesNotMatch(h.markup(),/4111|321|CVV|secret-password/);
});
test('remote cards escape script/URL injection and do not invent currency',t=>{
  const h=harness(t);const markup=h.app.productCard({...product,name:'<img onerror=x>',description:'<script>x</script>',image:'javascript:x',warnings:['<svg onload=x>']});assert.match(markup,/&lt;img/);assert.match(markup,/&lt;svg/);assert.doesNotMatch(markup,/javascript:|<img onerror=|<svg onload=/);assert.match(markup,/валюта көрсетілмеген/);assert.doesNotMatch(markup,/₸/);
});
test('detail shows real warehouse rows, safe certificate and actual minimum quantity',t=>{
  const h=harness(t);const p=h.app.displayProduct({id:515291,name:'Тауар',properties:{KRATNOST_MIN:'6'},stores:[{id:1,name:'<img>',quantity:0},{id:2,name:'Алматы',quantity:null}],certificate_url:'https://ekt.kz/cert.pdf'});h.app.renderCatalogDetail(p);const detail=h.ids.get('productDetail').innerHTML;
  assert.match(detail,/Қоймалар бойынша қалдық/);assert.match(detail,/&lt;img&gt;/);assert.match(detail,/<dd>0<\/dd>/);assert.match(detail,/Қалдық белгісіз/);assert.match(detail,/Ең аз партия: 6/);assert.match(detail,/value="6"/);assert.match(detail,/https:\/\/ekt.kz\/cert.pdf/);assert.doesNotMatch(detail,/₸/);
});
test('frontend contains no supplier credentials, authentication headers or durable secrets',()=>{
  assert.doesNotMatch(originalScript,/apiuser|ApiEkt|Basic\s+[A-Za-z0-9=]+|localStorage|sessionStorage|Authorization/);assert.doesNotMatch(html,/MOCK-001|DEMO-01|Ойдан алынған бағалар/);assert.match(html,/\/frontend\/app\.js/);
});
