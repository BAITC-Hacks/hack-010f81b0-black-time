'use strict';

// Behavioral tests with a lightweight DOM adapter, not browser layout tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const originalScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function harness(t, options = {}) {
  const ids = new Map(), selectors = new Map(), nodes = [], timers = new Set();
  class Element {
    constructor() {
      this.children=[];this.listeners={};this.style={};this.dataset={};this._html='';
      this.hidden=false;this.isConnected=true;this.value='';this.scrollHeight=100;
      this.classList={toggle(){}};nodes.push(this);
    }
    set innerHTML(value) {
      this._html=String(value);this.children=[];
      for(const match of this._html.matchAll(/\bid="([^"]+)"/g))if(!ids.has(match[1]))ids.set(match[1],new Element());
    }
    get innerHTML() { return this._html; }
    append(node) { node.parentElement=this;this.children.push(node); }
    querySelector(selector) {
      if(!this.queries)this.queries=new Map();
      if(!this.queries.has(selector)){const child=new Element();child.parentElement=this;this.queries.set(selector,child);}
      return this.queries.get(selector);
    }
    querySelectorAll() { return this.focusables||[]; }
    addEventListener(type,handler) { this.listeners[type]=handler; }
    scrollTo(value) { this.scrollTop=value.top; }
    setAttribute(name,value) { this[name]=value; }
    focus() { document.activeElement=this; }
    remove() { this.isConnected=false; }
    getClientRects() { return this.hidden?[]:[1]; }
  }
  for(const match of html.matchAll(/\bid="([^"]+)"/g))ids.set(match[1],new Element());
  const badges=[new Element(),new Element(),new Element(),new Element()];
  const document={
    body:new Element(),activeElement:new Element(),listeners:{},
    querySelector(selector){
      if(selector.startsWith('#')){const [id,...rest]=selector.slice(1).split(' ');const el=ids.get(id);return rest.length?el?.querySelector(rest.join(' ')):el;}
      if(!selectors.has(selector))selectors.set(selector,new Element());return selectors.get(selector);
    },
    querySelectorAll(selector){return selector==='.cart-count'?badges:[];},
    createElement(){return new Element();},getElementById(id){return ids.get(id);},
    addEventListener(type,handler){this.listeners[type]=handler;}
  };
  const context=vm.createContext({document,Intl,Date,Map,Set,Number,Object,String,Math,console,
    URL,URLSearchParams,AbortController,DOMException,location:{search:options.query||''},
    requestAnimationFrame:fn=>fn(),matchMedia:()=>({matches:true}),
    fetch:options.fetch||(()=>{throw new Error('Unexpected real network request');}),
    setTimeout:(fn,ms)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},ms);timers.add(timer);return timer;},
    clearTimeout:timer=>{clearTimeout(timer);timers.delete(timer);}
  });
  let script=originalScript;
  if(options.api)script=script.replace("mode: 'demo', // 'api'", "mode: 'api', // 'api'").replace("baseUrl: '', // Your team's", "baseUrl: 'https://backend.test/api', // Your team's");
  if(options.invalidConfig)script=script.replace("mode: 'demo', // 'api'", "mode: 'api', // 'api'");
  const end='    seed();\n  })();';
  assert.ok(script.includes(end),'app initialization marker exists');
  script=script.replace(end,`    globalThis.appTest={state,catalogState,replyTo,askConfirmation,confirm,reject,seed,send,openModal,closeModal,showCatalog,loadCatalogPage,loadCatalogDetail,backToCatalog,retryCatalog,renderCatalogList,renderCatalogDetail,catalogPrice,catalogStock,escapeHTML,setService(service){catalogService=service;catalogSetupError=null;}};\n${end}`);
  vm.runInContext(script,context);
  const app=context.appTest;
  t.after(()=>{app.closeModal();for(const timer of timers)clearTimeout(timer);});
  return {app,ids,document,badges,context,Element,markup:()=>nodes.map(n=>n.innerHTML).join('\n'),cartCount:()=>[...app.state.cart.values()].reduce((a,b)=>a+b,0)};
}
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const result=(page,id=page)=>({page,items:[{id:String(id),name:'Тауар '+id,sku:'SKU-'+id,brand:null,price:null,stock:null,unit:null,description:null,specs:[],image:null,certificates:[]}],hasNext:null,totalPages:null});
const jsonResponse=body=>({ok:true,status:200,json:async()=>body});

test('demo boot works offline and mobile composer has a catalog entry',t=>{
  const h=harness(t);assert.equal(h.cartCount(),0);assert.equal(h.app.state.cards.size,1);
  const composer=html.slice(html.indexOf('<div class="composer">'),html.indexOf('<aside class="right-rail"'));
  assert.match(composer,/data-action="catalog"/);
  assert.match(html,/<html lang="kk">/);
});

test('catalog loads two pages and opens a detail while demo cart stays unchanged',async t=>{
  const h=harness(t);h.app.openModal('#catalogOverlay');
  await h.app.loadCatalogPage(1);
  const firstIds=h.app.catalogState.snapshot.items.map(p=>p.id);
  assert.equal(firstIds.length,20);assert.equal(h.ids.get('catalogPrev').disabled,true);
  await h.app.loadCatalogPage(2,true);
  const second=h.app.catalogState.snapshot;
  assert.equal(second.items.length,20);assert.equal(second.items[0].id,'515291');
  assert.ok(second.items.every(p=>!firstIds.includes(p.id)));
  assert.equal(h.ids.get('catalogNext').disabled,true);
  assert.equal(h.document.activeElement,h.ids.get('catalogPrev'));
  await h.app.loadCatalogDetail(second.items[0].id);
  assert.match(h.ids.get('productDetail').innerHTML,/ID: 515291/);
  assert.equal(h.cartCount(),0);h.app.backToCatalog();
  assert.equal(h.app.catalogState.page,2);assert.equal(h.app.catalogState.view,'list');
  assert.equal(h.ids.get('catalogItems').hidden,false);
});

test('API requests use product ID, escape remote text, and keep unknown fields unknown',async t=>{
  const calls=[];
  const raw={id:515291,sku:'DO-NOT-USE-AS-ID',name:'<img src=x onerror=alert(1)>',price:0,stock:null,description:'<script>alert(1)</script>',specs:{'<b>Кілт</b>':'<svg onload=alert(1)>'},image:'javascript:alert(1)',certificates:[{name:'<b>PDF</b>',url:'https://files.test/cert.pdf'},{url:'javascript:alert(1)'}]};
  const h=harness(t,{api:true,fetch:async(url,init)=>{calls.push({url,init});return jsonResponse(url.endsWith('/515291')?{data:raw}:{data:{page:1,items:[raw]}});}});
  h.app.openModal('#catalogOverlay');await h.app.loadCatalogPage(1);
  assert.match(h.ids.get('catalogItems').innerHTML,/data-catalog-detail="515291"/);
  assert.match(h.ids.get('catalogItems').innerHTML,/&lt;img/);
  assert.match(h.ids.get('catalogItems').innerHTML,/Қалдық туралы дерек жоқ/);
  assert.doesNotMatch(h.ids.get('catalogItems').innerHTML,/<img src=x/);
  assert.equal(h.ids.get('catalogNext').disabled,false,'unknown pagination stays navigable');
  await h.app.loadCatalogDetail('515291');
  assert.deepEqual(calls.map(c=>c.url),['https://backend.test/api/products?page=1','https://backend.test/api/products/515291']);
  assert.ok(calls.every(c=>c.init.credentials==='omit'&&c.init.method==='GET'));
  const detail=h.ids.get('productDetail').innerHTML;
  assert.match(detail,/&lt;script&gt;/);assert.match(detail,/&lt;b&gt;Кілт/);
  assert.doesNotMatch(detail,/javascript:|<script>|<svg onload=/);
  assert.match(detail,/href="https:\/\/files.test\/cert.pdf"/);
  assert.equal(h.cartCount(),0);
});

test('a later page request wins even when the old response ignores cancellation',async t=>{
  const h=harness(t),first=defer(),second=defer();let signal;
  h.app.setService({list:(page,options)=>{if(page===1){signal=options.signal;return first.promise;}return second.promise;}});
  h.app.openModal('#catalogOverlay');const p1=h.app.loadCatalogPage(1);const p2=h.app.loadCatalogPage(2);
  assert.equal(signal.aborted,true);second.resolve(result(2,222));await p2;
  first.resolve(result(1,111));await p1;
  assert.equal(h.app.catalogState.page,2);assert.match(h.ids.get('catalogItems').innerHTML,/data-catalog-detail="222"/);
  assert.doesNotMatch(h.ids.get('catalogItems').innerHTML,/data-catalog-detail="111"/);
});

test('closing then reopening the modal ignores an old request',async t=>{
  const h=harness(t),old=defer(),current=defer();let n=0,oldSignal;
  h.app.setService({list:(page,{signal})=>{n++;if(n===1){oldSignal=signal;return old.promise;}return current.promise;}});
  h.app.openModal('#catalogOverlay');const first=h.app.loadCatalogPage(1);h.app.closeModal();assert.equal(oldSignal.aborted,true);
  h.app.openModal('#catalogOverlay');const second=h.app.loadCatalogPage(1);
  current.resolve(result(1,222));await second;old.resolve(result(1,111));await first;
  assert.match(h.ids.get('catalogItems').innerHTML,/data-catalog-detail="222"/);
  assert.doesNotMatch(h.ids.get('catalogItems').innerHTML,/data-catalog-detail="111"/);
});

test('back from a loading detail preserves the page and rejects stale detail content',async t=>{
  const h=harness(t),pending=defer();let detailSignal;
  h.app.setService({list:async()=>result(2,222),detail:(id,{signal})=>{detailSignal=signal;return pending.promise;}});
  h.app.openModal('#catalogOverlay');await h.app.loadCatalogPage(2);
  const detail=h.app.loadCatalogDetail('222');h.app.backToCatalog();assert.equal(detailSignal.aborted,true);
  pending.resolve(result(2,222).items[0]);await detail;
  assert.equal(h.app.catalogState.view,'list');assert.equal(h.ids.get('productDetail').hidden,true);
  assert.equal(h.app.catalogState.page,2);assert.equal(h.app.catalogState.loading,false);
});

test('API failure is visible without fallback, and retry requests the same page',async t=>{
  let attempts=0;const urls=[];
  const h=harness(t,{api:true,fetch:async url=>{urls.push(url);if(++attempts===1)throw new TypeError('Offline');return jsonResponse({data:{page:2,items:[{id:202,name:'Нақты жауап'}],has_next:false}});}});
  h.app.openModal('#catalogOverlay');await h.app.loadCatalogPage(2);
  assert.match(h.ids.get('catalogFeedback').innerHTML,/Қайта көру/);assert.equal(h.app.catalogState.snapshot,null);
  assert.equal(h.ids.get('catalogItems').innerHTML,'');assert.equal(h.ids.get('catalogPrev').disabled,false);
  h.app.retryCatalog();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(urls.length,2);assert.equal(urls[0],urls[1]);
  assert.equal(h.app.catalogState.snapshot.items[0].id,'202');
});

test('invalid API setup does not break the demo chat',async t=>{
  const h=harness(t,{invalidConfig:true});assert.equal(h.app.state.cards.size,1);
  h.app.openModal('#catalogOverlay');await h.app.loadCatalogPage(1);
  assert.match(h.ids.get('catalogFeedback').innerHTML,/әлі бапталмаған/);
  assert.equal(h.app.catalogState.snapshot,null);h.app.closeModal();
  h.app.replyTo('10 дана керек');assert.equal(h.app.state.pending.qty,10);
});

test('empty demo has no zero-page denominator and no active next button',async t=>{
  const h=harness(t,{query:'?catalogDemo=empty'});h.app.openModal('#catalogOverlay');await h.app.loadCatalogPage(1);
  assert.match(h.ids.get('catalogFeedback').innerHTML,/Бұл бетте тауар жоқ/);
  assert.doesNotMatch(h.ids.get('catalogPageLabel').textContent,/\/ 0/);
  assert.equal(h.ids.get('catalogPrev').disabled,true);assert.equal(h.ids.get('catalogNext').disabled,true);
});

test('focus trap wraps from an element outside its focusable list',t=>{
  const h=harness(t);h.app.openModal('#catalogOverlay');
  const first=new h.Element(),last=new h.Element();h.ids.get('catalogOverlay').focusables=[first,last];
  h.document.activeElement=h.ids.get('catalogPageLabel');let prevented=false;
  h.document.listeners.keydown({key:'Tab',shiftKey:false,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(h.document.activeElement,first);
  h.document.activeElement=first;h.document.listeners.keydown({key:'Tab',shiftKey:true,preventDefault(){}});
  assert.equal(h.document.activeElement,last);
});

test('demo cart requires exact confirmation, rejects replay and honors combined stock',t=>{
  const h=harness(t),app=h.app;
  app.replyTo('10 дана керек');assert.equal(h.cartCount(),0);app.replyTo('иә');assert.equal(h.cartCount(),0);
  const id=app.state.pending.id;app.confirm(id);app.confirm(id);assert.equal(h.cartCount(),10);
  assert.ok(h.badges.every(b=>b.textContent===10));
  app.replyTo('119 дана керек');assert.equal(app.state.pending,null);
  app.replyTo('118 дана керек');app.replyTo('Иә, қосу');assert.equal(h.cartCount(),128);
  app.replyTo('1 дана керек');assert.equal(app.state.pending,null);assert.equal(h.cartCount(),128);
});

test('invalid replacement quantities invalidate earlier offers; metre input is supported',t=>{
  const h=harness(t),app=h.app;
  app.replyTo('10 дана керек');const old=app.state.pending.id;app.replyTo('200 дана керек');
  app.confirm(old);assert.equal(h.cartCount(),0);assert.equal(app.state.pending,null);
  for(const value of ['-1 дана','0 дана','1,5 дана']){app.replyTo(value);assert.equal(app.state.pending,null);}
  app.replyTo('кабель 10 м');assert.equal(app.state.pending.productId,'cable');assert.equal(app.state.pending.qty,10);
  app.reject(app.state.pending.id);assert.equal(h.cartCount(),0);
});

test('attachments remain metadata-only and escape filenames; checkout remains a UI notice',t=>{
  const h=harness(t),input=h.ids.get('fileInput');
  input.listeners.change({target:{files:[{name:'жоба <test>.pdf',size:2048}],value:'test'}});
  assert.match(h.markup(),/жоба &lt;test&gt;\.pdf/);
  const before=h.ids.get('messages').children.length;
  for(const file of [{name:'large.pdf',size:11*1024*1024},{name:'program.exe',size:100}])input.listeners.change({target:{files:[file],value:'test'}});
  assert.equal(h.ids.get('messages').children.length,before);
  h.ids.get('checkoutButton').listeners.click();assert.equal(h.ids.get('checkoutNote').hidden,false);
  assert.equal(h.cartCount(),0);
});

test('no original supplier credentials, auth headers or durable storage are shipped',()=>{
  assert.doesNotMatch(originalScript,/apiuser|ApiEkt|Basic\s+[A-Za-z0-9=]+|localStorage|sessionStorage|headers:\s*\{[^}]*Authorization/);
});
