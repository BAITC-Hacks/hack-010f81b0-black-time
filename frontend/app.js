/* Browser state contains presentation only. The backend owns sessions, selection and cart. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = {session:null,expired:false,cart:{items:[],total:null,currency:null},cards:new Map(),pending:null,busy:false,sequence:0,modal:null,focusBeforeModal:null,toastTimer:null,retry:null};
  const catalogState = {view:'list',page:1,snapshot:null,loading:false,controller:null,version:0,lastRequest:null,selectedId:null};
  const CATALOG_CONFIG = {mode:'api',baseUrl:location.origin,timeoutMs:35000};
  let catalogService, catalogSetupError;
  try { catalogService=CatalogData.createService(CATALOG_CONFIG); } catch(error) { catalogSetupError=error; }
  const time = () => new Intl.DateTimeFormat('kk-KZ',{hour:'2-digit',minute:'2-digit'}).format(new Date());
  const money = (amount,currency=state.session?.catalog_currency) => amount == null ? 'Бағасы көрсетілмеген' : new Intl.NumberFormat('kk-KZ').format(amount)+(currency?' '+currency:' · валюта көрсетілмеген');
  const count = () => state.cart.items.reduce((sum,item)=>sum+item.quantity,0);
  const scrollToEnd = () => requestAnimationFrame(()=>$('#messages').scrollTo({top:$('#messages').scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));
  function showToast(text){clearTimeout(state.toastTimer);$('#toast').textContent=text;$('#toast').hidden=false;state.toastTimer=setTimeout(()=>$('#toast').hidden=true,5000);}
  function message(role,html){const node=document.createElement('div');node.className='message '+role;node.innerHTML=(role==='assistant'?`<div class="message-avatar">${icon('spark')}</div>`:'')+`<div class="message-body">${role==='assistant'?'<div class="message-name">ekt.kz кеңесшісі</div>':''}${html}<div class="message-time">${time()}</div></div>`;$('#messages').append(node);scrollToEnd();return node;}
  const say=text=>message('assistant',`<div class="bubble">${escapeHTML(text)}</div>`);
  const customer=text=>message('user',`<div class="bubble">${escapeHTML(text)}</div>`);
  function uuid(){return crypto.randomUUID();}
  function errorText(error){return error?.message || 'Сұранысты орындау мүмкін болмады.';}
  async function api(path,{method='GET',body,signal,timeoutMs=120000}={}){
    const controller=new AbortController();
    const onAbort=()=>controller.abort();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    if(signal){signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)controller.abort();}
    try{
      const form=typeof FormData!=='undefined'&&body instanceof FormData;
      const response=await fetch(path,{method,credentials:'same-origin',headers:body!==undefined&&!form?{Accept:'application/json','Content-Type':'application/json'}:{Accept:'application/json'},body:body===undefined?undefined:form?body:JSON.stringify(body),signal:controller.signal});
      let data;
      try{data=await response.json();}catch(_){throw new Error('Сервер жарамды JSON жауабын қайтармады.');}
      if(!response.ok){
        if(response.status===401){state.expired=true;state.session=null;clearPending();$('#connectionStatus').textContent='Сессия аяқталды';}
        const e=new Error(response.status===401?'Сессия уақыты аяқталды. Жұмысты жалғастыру үшін бетті қайта жүктеңіз.':typeof data.detail==='string'?data.detail:`Сұраныс қатесі (HTTP ${response.status}).`);e.status=response.status;throw e;
      }
      return data;
    }catch(error){
      if(error.name==='AbortError')throw new Error('Жауап күту уақыты аяқталды. Қайта көру батырмасын қолданыңыз.');
      if(error instanceof TypeError)throw new Error('Серверге қосылу мүмкін болмады. Backend жұмысын тексеріңіз.');
      throw error;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
  }
  function busy(value){state.busy=value;$('#sendButton').disabled=value;$('#attachButton').disabled=value;document.querySelectorAll('[data-confirm],[data-propose],[data-remove],[data-cancel]').forEach(el=>el.disabled=value||(el.dataset.propose&&state.cards.get(el.dataset.propose)?.stock===0));}
  function displayProduct(raw){
    const p=CatalogData.normalizeProduct(raw);
    p.currency=raw.currency??state.session?.catalog_currency??null;
    p.warnings=Array.isArray(raw.warnings)?raw.warnings.filter(x=>typeof x==='string'):[];
    p.url=CatalogData.safeHttpUrl(raw.url);
    p.order_multiple=raw.order_multiple??null;
    return p;
  }
  function catalogPicture(p){const url=CatalogData.safeHttpUrl(p.image);return url?`<div class="catalog-picture"><img src="${escapeHTML(url)}" alt="${escapeHTML(p.name||'Тауар суреті')}" loading="lazy" referrerpolicy="no-referrer"></div>`:`<div class="catalog-picture">${icon('box')}<span>Сурет берілмеген</span></div>`;}
  function catalogPrice(p){return escapeHTML(money(p.price,p.currency??state.session?.catalog_currency));}
  function catalogStock(p){if(p.stock==null)return '<span class="pill catalog-stock-unknown">Қалдық туралы дерек жоқ</span>';if(p.stock===0)return '<span class="pill catalog-stock-empty">Қоймада жоқ</span>';return `<span class="pill catalog-stock-ok">${escapeHTML(p.stock)} бірлік қолда бар</span>`;}
  function productControls(p){
    state.cards.set(p.id,p);
    const value=Number.isSafeInteger(p.minimum_order)&&p.minimum_order>0?p.minimum_order:1;
    return `<div class="product-bottom"><div class="price">${catalogPrice(p)}</div><label class="small" for="qty-${p.id}-${state.sequence}">Саны</label><input id="qty-${p.id}-${state.sequence++}" data-quantity="${p.id}" aria-label="Тауар саны" type="number" min="1" step="1" value="${value}" style="width:65px;padding:7px;border:1px solid #dce7dd;border-radius:6px"><button class="primary add-product" data-propose="${p.id}" ${p.stock===0?'disabled':''}>Себетке ұсыну</button></div>`;
  }
  function productCard(raw){const p=displayProduct(raw);return `<article class="product-card"><div class="product-main">${catalogPicture(p)}<div class="product-info"><div class="product-kicker">ID: ${escapeHTML(p.id)} · ${escapeHTML(p.sku||'Артикул жоқ')}</div><h3 class="product-title">${escapeHTML(p.name||'Атауы көрсетілмеген')}</h3>${catalogStock(p)}<p class="product-spec">${escapeHTML(p.specs.slice(0,4).map(s=>s.label+': '+s.value).join(' · '))}</p></div></div>${p.warnings.map(w=>`<p class="product-warning">${escapeHTML(w)}</p>`).join('')}${productControls(p)}<button class="inline-link" data-catalog-detail="${p.id}">Толық сипаттама</button><div class="source-note">Дерек: ekt.kz · Қалдық растау кезінде қайта тексеріледі</div></article>`;}
  function clearPending(){if(state.pending?.node)state.pending.node.querySelector('.confirmation').innerHTML='<div class="confirmation-status">Ұсыныс жабылды немесе жаңартылды</div>';state.pending=null;}
  function showConfirmation(confirmation){
    clearPending();if(!confirmation)return;
    const p=confirmation.product||state.cards.get(String(confirmation.product_id));
    const name=p?.name||`ID ${confirmation.product_id}`;
    const price=typeof p?.price==='number'?p.price:null;
    const currency=p?.currency??state.session?.catalog_currency;
    const total=price===null?null:price*confirmation.quantity;
    const node=message('assistant',`<div class="confirmation"><p class="confirmation-title">Тестілік себетке қосуды растайсыз ба?</p><p class="confirmation-detail">${escapeHTML(name)} × ${escapeHTML(confirmation.quantity)}<br>Бірлік бағасы: ${escapeHTML(money(price,currency))}<br>Сома: ${escapeHTML(money(total,currency))}<br>Бұл — ekt.kz себеті емес.</p><div class="confirm-actions"><button class="primary" data-confirm="${escapeHTML(confirmation.id)}">Иә, қосу</button><button class="secondary" data-cancel="${escapeHTML(confirmation.id)}">Жоқ, бас тарту</button></div></div>`);
    state.pending={...confirmation,node};
  }
  function applyEnvelope(envelope){
    clearPending();
    if(envelope.cart){state.cart=envelope.cart;renderCart();}
    const reply=envelope.reply||{};
    if(reply.message)say(reply.message);
    for(const p of reply.cards||[])message('assistant',productCard(p));
    const links=Array.isArray(reply.links)?reply.links:Object.entries(reply.links||{}).map(([key,url])=>({url,label:key==='cart_url'?'Себет':'Сілтемені ашу'}));
    for(const link of links){const href=typeof link==='string'?link:link.url||link.href;const title=typeof link==='string'?'Сілтемені ашу':link.label||link.title||'Сілтемені ашу';if(href==='/cart')message('assistant','<button class="secondary" data-action="cart">Тестілік себетті ашу</button>');else {const url=CatalogData.safeHttpUrl(href);if(url)message('assistant',`<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(title)}</a>`);}}
    if(envelope.confirmation)showConfirmation(envelope.confirmation);
  }
  function errorReply(error,operation){
    const canRetry=!error.status||error.status>=500;
    state.retry=canRetry?operation:null;
    say(errorText(error));
    if(canRetry)message('assistant','<button class="secondary retry-action" data-action="retry-operation">Қайта көру</button>');
    if(error.status===401)message('assistant','<button class="secondary" data-action="reload-page">Бетті қайта жүктеу</button>');
  }
  async function operation(path,body,method='POST'){
    if(state.busy)return false;
    busy(true);state.retry=null;
    const waiting=message('assistant','<div class="bubble"><span class="typing"><i></i><i></i><i></i><span class="typing-label">Жауап дайындалуда…</span></span></div>');
    try{
      if(!state.session)await initSession();
      const result=await api(path,{method,body});
      if(method==='DELETE'){state.cart=result;renderCart();clearPending();}else applyEnvelope(result);
      return true;
    }catch(error){errorReply(error,{path,body,method});return false;}
    finally{waiting.remove();busy(false);}
  }
  async function send(text){
    text=String(text||'').trim();if(!text||state.busy)return false;
    if(/(?:\d[ -]?){13,19}|\b(?:cvv|cvc)\b|пароль/iu.test(text)){
      openChat();closeModal();say('Төлем деректерін чатқа жібермеңіз. Бұл чат оларды өңдемейді.');return false;
    }
    openChat();closeModal();customer(text);
    const body={message:text,request_id:uuid()};
    if(state.pending)body.confirmation_id=state.pending.id;
    return operation('/api/chat',body);
  }
  async function propose(id,quantity){
    if(!Number.isSafeInteger(Number(id))||Number(id)<1||!Number.isSafeInteger(quantity)||quantity<1){showToast('Саны 1-ден басталатын бүтін сан болуы керек.');return false;}
    closeModal();openChat();
    return operation('/api/cart/proposal',{product_id:Number(id),quantity,request_id:uuid()});
  }
  async function confirm(id){if(state.busy||!state.pending||state.pending.id!==id)return false;return operation('/api/cart/confirm',{confirmation_id:id,request_id:uuid()});}
  async function reject(id){if(state.busy||!state.pending||state.pending.id!==id)return false;return operation('/api/cart/cancel',{});}
  function renderCart(){
    document.querySelectorAll('.cart-count').forEach(el=>el.textContent=count());
    $('#cartTotal').textContent=money(state.cart.total,state.cart.currency);$('#checkoutNote').hidden=true;
    $('#miniCartContent').innerHTML=state.cart.items.length?`<div class="mini-cart-total"><span>${count()} бірлік</span><strong>${escapeHTML(money(state.cart.total,state.cart.currency))}</strong></div><button class="secondary mini-cart-link" data-action="cart">Тестілік себетті ашу</button>`:`<div class="mini-empty">${icon('bag')}<p>Себет әзірге бос</p><span>Тестілік себет — ekt.kz себеті емес</span></div>`;
    $('#cartItems').innerHTML=state.cart.items.length?state.cart.items.map(item=>{const p=displayProduct(item.product);return `<article class="cart-row">${catalogPicture(p)}<div class="cart-row-info"><h3>${escapeHTML(p.name)}</h3><p>${item.quantity} × ${catalogPrice(p)}</p><strong>${escapeHTML(money(item.line_total,state.cart.currency))}</strong></div><button class="icon-button" data-remove="${p.id}" aria-label="Тауарды себеттен алып тастау">${icon('close')}</button></article>`;}).join(''):`<div class="cart-empty">${icon('bag')}<h3>Себетіңіз бос</h3><p>Каталогтан тауарды таңдаңыз. Қосу үшін жеке растау қажет.</p></div>`;
  }
  async function showCart(){
    openModal('#cartOverlay');
    if(state.busy)return;
    try{if(!state.session)await initSession();state.cart=await api('/api/cart');renderCart();}catch(error){showToast(errorText(error));}
  }
  function openChat(){$('#chatWindow').hidden=false;$('#closedPlaceholder').hidden=true;$('#chatLauncher').setAttribute('aria-expanded','true');$('#chatLauncher span').textContent='Чатты жасыру';scrollToEnd();}
  function closeChat(){$('#chatWindow').hidden=true;$('#closedPlaceholder').hidden=false;$('#chatLauncher').setAttribute('aria-expanded','false');$('#chatLauncher span').textContent='Кеңесшімен сөйлесу';$('#chatLauncher').focus();}
  function openModal(selector){if(state.modal)closeModal();state.focusBeforeModal=document.activeElement;state.modal=$(selector);state.modal.hidden=false;$('#appShell').inert=true;document.body.style.overflow='hidden';state.modal.querySelector('[data-action="close-modal"]').focus();}
  function closeModal(){if(!state.modal)return;if(state.modal===$('#catalogOverlay'))cancelCatalogRequest();state.modal.hidden=true;state.modal=null;$('#appShell').inert=false;document.body.style.overflow='';if(state.focusBeforeModal?.isConnected)state.focusBeforeModal.focus();}

    function cancelCatalogRequest(){
      catalogState.version++;
      if(catalogState.controller)catalogState.controller.abort();
      catalogState.controller=null;catalogState.loading=false;
      $('#catalogBody').setAttribute('aria-busy','false');
    }
    function startCatalogRequest(request){
      cancelCatalogRequest();catalogState.loading=true;catalogState.lastRequest=request;
      catalogState.controller=new AbortController();
      $('#catalogBody').setAttribute('aria-busy','true');
      return {version:catalogState.version,signal:catalogState.controller.signal};
    }
    function isCurrentCatalogRequest(request){
      return request.version===catalogState.version && state.modal===$('#catalogOverlay') && !$('#catalogOverlay').hidden;
    }
    function setCatalogView(view){
      catalogState.view=view;
      $('#catalogTitle').textContent=view==='detail'?'Тауар туралы':'Тауарлар каталогы';
      $('#catalogSubtitle').textContent='ekt.kz каталогының нақты деректері';
      $('#catalogSourceLabel').innerHTML=icon('box')+'ekt.kz каталогы';
      $('#catalogBack').hidden=view!=='detail';
      $('#catalogPagination').hidden=view!=='list';
      $('#catalogItems').hidden=view!=='list';
      $('#productDetail').hidden=view!=='detail';
      $('#catalogBody').scrollTop=0;
    }
    function updateCatalogPagination(){
      const page=catalogState.page,data=catalogState.snapshot;
      $('#catalogPrev').disabled=catalogState.loading||page<=1;
      $('#catalogNext').disabled=catalogState.loading||!data||data.hasNext===false;
      $('#catalogPageLabel').textContent=catalogState.loading?`${page}-бет жүктелуде…`:data?`${page}${data.totalPages>0?' / '+data.totalPages:''}-бет · ${data.items.length} тауар`:`${page}-бет`;
      $('#catalogPageNote').textContent=data?.totalPages===0?'Каталог бос':data?.hasNext===null?'Беттердің жалпы саны берілмеген. Келесі бетті бөлек тексеруге болады.':data?.hasNext===false?'Соңғы бет':CATALOG_CONFIG.mode==='demo'?'Демо деректер нақты каталогты сипаттамайды.':'';
    }
    function showCatalogLoading(kind){
      $('#catalogFeedback').className='catalog-feedback';
      $('#catalogFeedback').innerHTML=`<div class="catalog-loading"><span class="catalog-spinner" aria-hidden="true"></span>${kind==='detail'?'Тауар мәліметі жүктелуде…':'Тауарлар жүктелуде…'}</div>`;
      $('#productDetail').innerHTML='';
      $('#catalogItems').innerHTML=kind==='list'?Array.from({length:6},()=>'<div class="catalog-skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i></div>').join(''):'';
      updateCatalogPagination();
    }
    function catalogErrorMessage(error){
      if(error?.code==='CONFIG')return 'Каталог қызметі әлі бапталмаған. Сервер адресі мен қосылу параметрлері қажет.';
      if(error?.code==='TIMEOUT')return 'Сервер жауабы тым ұзақ күтілді. Қайта көріңіз.';
      if(error?.code==='NETWORK')return 'Серверге қосылу мүмкін болмады. Интернет қосылымын тексеріп, қайта көріңіз.';
      if(error?.code==='INVALID_JSON'||error?.code==='SCHEMA')return 'Каталог деректері күтілген пішімде келмеді. Қызмет баптауларын тексеру қажет.';
      if(error?.status===404)return catalogState.view==='detail'?'Бұл тауар табылмады. Каталогтан басқа тауарды таңдаңыз.':'Каталог қызметі табылмады. Қосылу адресін тексеру қажет.';
      if(error?.status===401||error?.status===403)return 'Каталогты ашуға рұқсат қажет. Сервердің қолжетімділігін нақтылау керек.';
      return errorText(error);
    }
    function showCatalogError(error){
      $('#catalogItems').innerHTML='';$('#productDetail').innerHTML='';
      $('#catalogFeedback').className='catalog-feedback catalog-error';
      $('#catalogFeedback').innerHTML=`${icon('info')}<h3>Жүктеу мүмкін болмады</h3><p>${escapeHTML(catalogErrorMessage(error))}</p><button class="primary" data-action="catalog-retry">${icon('refresh')}Қайта көру</button>`;
      updateCatalogPagination();
    }
    function renderCatalogList(){
      setCatalogView('list');const data=catalogState.snapshot;
      if(!data)return;
      $('#productDetail').innerHTML='';
      if(!data.items.length){
        $('#catalogItems').innerHTML='';$('#catalogFeedback').className='catalog-feedback catalog-empty';
        $('#catalogFeedback').innerHTML=`${icon('box')}<h3>Бұл бетте тауар жоқ</h3><p>${catalogState.page>1?'Алдыңғы бетке оралып, басқа тауарларды қарап көріңіз.':'Каталог әзірге бос. Кейінірек қайта жүктеп көріңіз.'}</p><button class="secondary" data-action="catalog-retry">${icon('refresh')}Қайта жүктеу</button>`;
      }else{
        $('#catalogFeedback').className='catalog-feedback';
        $('#catalogFeedback').innerHTML=`<span class="sr-only">${data.items.length} тауар жүктелді</span>`;
        $('#catalogItems').innerHTML=data.items.map(p=>`<article class="catalog-item">${catalogPicture(p)}${catalogStock(p)}<h3>${escapeHTML(p.name||'Атауы көрсетілмеген')}</h3><div class="catalog-sku">${p.sku?'Артикул: '+escapeHTML(p.sku):'Артикул берілмеген'}<br>ID: ${escapeHTML(p.id)}</div><div class="price">${catalogPrice(p)}</div><button class="secondary" data-catalog-detail="${escapeHTML(p.id)}" aria-label="${escapeHTML(p.name||'Тауар')}: толық мәлімет">Толығырақ${icon('arrow')}</button></article>`).join('');
      }
      updateCatalogPagination();
    }
    async function loadCatalogPage(page,focus=false){
      if(!Number.isSafeInteger(page)||page<1)return;
      catalogState.page=page;catalogState.snapshot=null;catalogState.selectedId=null;
      setCatalogView('list');const request=startCatalogRequest({kind:'list',page});showCatalogLoading('list');
      try{
        if(catalogSetupError)throw catalogSetupError;
        const data=await catalogService.list(page,{signal:request.signal});
        if(!isCurrentCatalogRequest(request))return;
        catalogState.snapshot=data;catalogState.page=data.page;catalogState.loading=false;renderCatalogList();
        if(focus)focusCatalogNavigation();
      }catch(error){
        if(!isCurrentCatalogRequest(request)||error?.name==='AbortError')return;
        catalogState.loading=false;showCatalogError(error);
      }finally{
        if(request.version===catalogState.version){catalogState.loading=false;catalogState.controller=null;$('#catalogBody').setAttribute('aria-busy','false');updateCatalogPagination();}
      }
    }
    function renderCatalogDetail(p){
      $('#catalogFeedback').className='catalog-feedback';
      $('#catalogFeedback').innerHTML='<span class="sr-only">Тауар мәліметі жүктелді</span>';
      const specs=p.specs.length?'<dl class="detail-specs">'+p.specs.map(s=>'<div class="detail-spec-row"><dt>'+escapeHTML(s.label)+'</dt><dd>'+escapeHTML(s.value)+'</dd></div>').join('')+'</dl>':'<p>Техникалық сипаттамалар берілмеген.</p>';
      const documents=p.certificates.length?p.certificates.map(cert=>'<a class="detail-document" href="'+escapeHTML(cert.url)+'" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">'+icon('file')+'<span>'+escapeHTML(cert.name||'Сертификат')+'</span>'+icon('arrow')+'</a>').join(''):'<p>Сертификат сілтемелері берілмеген.</p>';
      const stores=p.stores?.length?'<dl class="detail-specs">'+p.stores.map(s=>'<div class="detail-spec-row"><dt>'+escapeHTML(s.name||'Қойма атауы көрсетілмеген')+'</dt><dd>'+escapeHTML(s.quantity==null?'Қалдық белгісіз':s.quantity)+'</dd></div>').join('')+'</dl>':'<p>Қоймалар бойынша қалдық берілмеген.</p>';
      $('#productDetail').innerHTML='<div class="detail-lead">'+catalogPicture(p)+'<div>'+catalogStock(p)+'<h3>'+escapeHTML(p.name||'Атауы көрсетілмеген')+'</h3><div class="detail-meta">ID: '+escapeHTML(p.id)+(p.sku?'<br>Артикул: '+escapeHTML(p.sku):'')+(p.brand?'<br>Өндіруші: '+escapeHTML(p.brand):'')+'</div><div class="price">'+catalogPrice(p)+'</div>'+productControls(p)+'<p class="small">Ең аз партия: '+escapeHTML(p.minimum_order==null?'Дерек берілмеген':p.minimum_order)+'</p><button class="secondary" data-select-product="'+p.id+'">Кеңесшіден сұрау</button></div></div><section class="detail-block"><h4>Тауар сипаттамасы</h4><p>'+escapeHTML(p.description||'Сипаттама берілмеген.')+'</p></section><section class="detail-block"><h4>Техникалық сипаттамалар</h4>'+specs+'</section><section class="detail-block"><h4>Қоймалар бойынша қалдық</h4>'+stores+'</section><section class="detail-block"><h4>Сертификаттар</h4>'+documents+'</section><div class="detail-demo-note">Деректер ekt.kz-тен өзгеріссіз беріледі. Сипаттамалар қайшы келсе, кеңесші арқылы нақтылаңыз. Тестілік себет — ekt.kz себеті емес.</div>';
    }
    async function loadCatalogDetail(id){
      catalogState.selectedId=String(id);setCatalogView('detail');
      const request=startCatalogRequest({kind:'detail',id:String(id)});showCatalogLoading('detail');$('#catalogBack').focus();
      try{
        if(catalogSetupError)throw catalogSetupError;
        const p=await catalogService.detail(id,{signal:request.signal});
        if(!isCurrentCatalogRequest(request))return;
        catalogState.loading=false;renderCatalogDetail(p);
      }catch(error){
        if(!isCurrentCatalogRequest(request)||error?.name==='AbortError')return;
        catalogState.loading=false;showCatalogError(error);
      }finally{
        if(request.version===catalogState.version){catalogState.loading=false;catalogState.controller=null;$('#catalogBody').setAttribute('aria-busy','false');}
      }
    }
    function retryCatalog(){
      const previous=catalogState.lastRequest;if(!previous||catalogState.loading)return;
      if(previous.kind==='detail')void loadCatalogDetail(previous.id);else void loadCatalogPage(previous.page);
    }
    function focusCatalogNavigation(){
      const next=$('#catalogNext'),previous=$('#catalogPrev');
      if(!next.disabled)next.focus();else if(!previous.disabled)previous.focus();else $('#catalogOverlay').querySelector('[data-action="close-modal"]').focus();
    }
    function backToCatalog(){
      cancelCatalogRequest();catalogState.selectedId=null;
      if(catalogState.snapshot){catalogState.lastRequest={kind:'list',page:catalogState.page};renderCatalogList();focusCatalogNavigation();}
      else void loadCatalogPage(catalogState.page,true);
    }
    function showCatalog(){
      openModal('#catalogOverlay');void loadCatalogPage(1);
    }


  async function upload(file){
    if(!file||state.busy)return;
    if(file.size>10*1024*1024){showToast('Файл 10 МБ-тан аспауы керек.');return;}
    if(!/\.(pdf|xlsx|xls|docx|jpe?g)$/i.test(file.name)){showToast('PDF, XLSX/XLS, DOCX немесе JPEG файлын таңдаңыз.');return;}
    clearPending();busy(true);$('#attachmentHint').hidden=false;$('#attachmentHint').textContent='Файл мәтіні алынуда…';
    try{
      if(!state.session)await initSession();
      const body=new FormData();body.append('file',file);
      const result=await api('/api/attachments',{method:'POST',body});
      $('#attachmentText').value=result.text||'';
      $('#attachmentNotes').textContent=[result.filename||file.name,...result.notes||[]].join('\n');
      openModal('#attachmentOverlay');
    }catch(error){say(errorText(error));}
    finally{busy(false);$('#fileInput').value='';$('#attachmentHint').textContent='Файл мәтінін тексеріп, қажет болса түзетіңіз. Хабарламаны өзіңіз жібересіз.';}
  }
  function useAttachment(){const text=$('#attachmentText').value.trim();if(!text){showToast('Алдымен тауар атауын немесе артикулын жазыңыз.');return;}$('#messageInput').value=text.slice(0,12000);closeModal();openChat();$('#messageInput').focus();resizeComposer();}
  function resizeComposer(){const input=$('#messageInput');input.style.height='33px';input.style.height=Math.min(input.scrollHeight,100)+'px';}
  let sessionRequest=null;
  async function initSession(){
    if(state.expired){const error=new Error('Сессия аяқталды. Бетті қайта жүктеңіз.');error.status=401;throw error;}
    if(sessionRequest)return sessionRequest;
    sessionRequest=(async()=>{
      state.session=await api('/api/session');
      $('#assistantMode').textContent=state.session.ai_mode==='rules'?'ЕРЕЖЕЛЕР':'КЕҢЕСШІ';
      $('#connectionStatus').textContent='Қосылды';
      return state.session;
    })();
    try{return await sessionRequest;}finally{sessionRequest=null;}
  }
  async function start(){
    $('#messages').innerHTML='<div class="day-divider">Бүгін</div>';
    say('Сәлем! Тауар атауын, артикулын немесе ID нөмірін жазыңыз. Каталогтан таңдап, сипаттамасын, бағасын және қалдығын қарай аласыз.');
    say('Кеңесші ережелер арқылы жұмыс істейді. Тестілік себет — ekt.kz себеті емес; тауар тек жеке растаудан кейін қосылады.');
    renderCart();busy(true);
    try{await initSession();state.cart=await api('/api/cart');renderCart();if(location.pathname==='/cart')openModal('#cartOverlay');}
    catch(error){$('#connectionStatus').textContent='Байланыс жоқ';say(errorText(error));}
    finally{busy(false);}
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button,[data-action]');if(!button||button.disabled)return;
    if(button.dataset.prompt){void send(button.dataset.prompt);return;}
    if(button.dataset.catalogDetail){if(state.modal!==$('#catalogOverlay'))openModal('#catalogOverlay');void loadCatalogDetail(button.dataset.catalogDetail);return;}
    if(button.dataset.selectProduct){void send('ID '+button.dataset.selectProduct);return;}
    if(button.dataset.propose){const parent=button.closest('.product-bottom');const quantity=Number(parent.querySelector('[data-quantity]').value);void propose(button.dataset.propose,quantity);return;}
    if(button.dataset.confirm){void confirm(button.dataset.confirm);return;}
    if(button.dataset.cancel){void reject(button.dataset.cancel);return;}
    if(button.dataset.remove){void operation('/api/cart/items/'+encodeURIComponent(button.dataset.remove),undefined,'DELETE');return;}
    switch(button.dataset.action){
      case 'catalog':showCatalog();break;
      case 'cart':void showCart();break;
      case 'close-modal':closeModal();break;
      case 'catalog-prev':void loadCatalogPage(catalogState.page-1,true);break;
      case 'catalog-next':void loadCatalogPage(catalogState.page+1,true);break;
      case 'catalog-back':backToCatalog();break;
      case 'catalog-retry':retryCatalog();break;
      case 'open-chat':openChat();break;
      case 'close-chat':closeChat();break;
      case 'toggle-chat':$('#chatWindow').hidden?openChat():closeChat();break;
      case 'attachment-use':useAttachment();break;
      case 'reload-page':location.reload();break;
      case 'retry-operation':if(state.retry&&!state.busy){const r=state.retry;void operation(r.path,r.body,r.method);}break;
      case 'reset':if(!state.busy){$('#messages').innerHTML='';say('Чат көрінісі тазаланды. Сервердегі таңдау мен себет сақталды.');if(state.pending){const pending=state.pending;state.pending=null;showConfirmation(pending);}}break;
      case 'about':say('Кеңесші ekt.kz каталогының деректерін қолданады. Диалог ережелер арқылы өңделеді. Сатып алу шарттары тек расталған дерекпен беріледі. Себет — осы прототиптің тестілік себеті.');openChat();break;
    }
  });
  $('#messageForm').addEventListener('submit',event=>{event.preventDefault();if(!$('#messageInput').value.trim()||state.busy)return;const value=$('#messageInput').value;$('#messageInput').value='';resizeComposer();void send(value);});
  $('#messageInput').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('#messageForm').requestSubmit();}});
  $('#messageInput').addEventListener('input',resizeComposer);
  $('#searchForm').addEventListener('submit',event=>{event.preventDefault();if(state.busy||!$('#catalogSearch').value.trim())return;void send($('#catalogSearch').value);$('#catalogSearch').value='';});
  $('#brandHome').addEventListener('click',event=>{event.preventDefault();openChat();});
  $('#attachButton').addEventListener('click',()=>$('#fileInput').click());
  $('#fileInput').addEventListener('change',event=>void upload(event.target.files?.[0]));
  $('#checkoutButton').addEventListener('click',()=>$('#checkoutNote').hidden=false);
  document.addEventListener('error',event=>{if(event.target.tagName==='IMG'&&event.target.closest('.catalog-picture'))event.target.parentElement.innerHTML=icon('box')+'<span>Сурет жүктелмеді</span>';},true);
  document.querySelectorAll('.modal-overlay').forEach(overlay=>overlay.addEventListener('click',event=>{if(event.target===overlay)closeModal();}));
  document.addEventListener('keydown',event=>{
    if(!state.modal)return;
    if(event.key==='Escape'){event.preventDefault();closeModal();return;}
    if(event.key==='Tab'){
      const focusables=[...state.modal.querySelectorAll('button:not(:disabled),[href],input,textarea,[tabindex="0"]')].filter(el=>el.getClientRects().length);
      const first=focusables[0],last=focusables[focusables.length-1];
      if(!first){event.preventDefault();state.modal.querySelector('[role="dialog"]').focus();}
      else if(!focusables.includes(document.activeElement)){event.preventDefault();(event.shiftKey?last:first).focus();}
      else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
  void start();
})();
