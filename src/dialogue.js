import { recognize } from './nlu.js';

const MISSING = 'Қолда бар деректерде бұл көрсетілмеген';
const validQty = n => Number.isSafeInteger(n) && n > 0;
const same = (a, b) => a === b;
export function createSession() {
  return { version: 1, sequence: 0, phase: 'idle', products: [], focusIds: [], pending: null, request: null, clarification: null };
}
function safeProduct(p) {
  if (!p || !Number.isSafeInteger(p.id) || typeof p.name !== 'string') throw new TypeError('Invalid product');
  const out = { id: p.id, name: p.name };
  for (const key of ['category', 'attributes', 'price', 'currency', 'stock', 'certificate_url']) if (p[key] !== undefined) out[key] = p[key];
  return out;
}
export function chooseAlternative(source, candidates) {
  // Stable ranking by exact shared fields. No inventory calculation or invented equivalence.
  const scored = candidates.filter(p => p.id !== source.id).map(p => {
    const reasons = [];
    if (source.category != null && p.category === source.category) reasons.push(`Санаты бірдей: ${p.category}`);
    for (const [key, value] of Object.entries(source.attributes ?? {})) {
      if (value != null && p.attributes?.[key] === value) reasons.push(`${key}: ${value} — сәйкес`);
    }
    if (typeof p.price === 'number' && typeof source.price === 'number' && p.currency && p.currency === source.currency && p.price < source.price) reasons.push(`Бағасы төмен: ${p.price} ${p.currency}`);
    return { product: p, reasons };
  }).sort((a, b) => b.reasons.length - a.reasons.length);
  return scored[0] ?? null;
}

/** Pure reducer. Caller owns session persistence and executes emitted requests. */
export function reduce(previous, event) {
  const state = structuredClone(previous);
  const result = (message, cards = [], extra = {}) => ({ state, reply: { message, cards, ...extra }, requests: [] });
  const issue = (action, payload, message, cards = []) => {
    const request = { request_id: `r${++state.sequence}`, action, ...payload };
    state.request = request;
    return { ...result(message, cards), requests: [request] };
  };
  const offer = (product, quantity) => {
    state.pending = { product_id: product.id, quantity };
    state.phase = 'awaiting_confirmation';
    state.request = null;
    return result(`${product.name}: ${quantity} дана себетке қосылсын ба? «Иә, себетке қос» немесе «Жоқ» деп жауап беріңіз.`, [product]);
  };
  if (event.type === 'server') {
    const r = event.action_result;
    const req = state.request;
    if (!req || !r || r.request_id !== req.request_id || r.action !== req.action) return result('Ескірген немесе сәйкес емес сервер жауабы еленбеді.');
    if (['check_stock', 'add_to_cart'].includes(req.action)) {
      if (!same(r.product_id, req.product_id) || !same(r.quantity, req.quantity)) return result('Сервер жауабындағы тауар немесе сан сұранысқа сәйкес емес.');
      if (!['ok', 'insufficient_stock', 'error'].includes(r.status)) return result('Сервер нәтижесі жарамсыз.');
      if (r.status === 'insufficient_stock' && (!Number.isSafeInteger(r.available_qty) || r.available_qty < 0 || r.available_qty >= req.quantity)) return result('Сервер ұсынған сан жарамсыз.');
      state.request = null;
      if (r.status === 'error') {
        state.phase = 'idle'; state.pending = null;
        return result('Әрекет орындалғаны расталмады. Менеджерге жүгініңіз.', [], { handoff: true });
      }
      if (r.status === 'insufficient_stock') {
        if (r.available_qty === 0) {
          state.phase = 'idle'; state.pending = null;
          return result('Сервер дерегі бойынша қолжетімді саны — 0. Балама сұрауға болады.');
        }
        return offer(state.products.find(p => p.id === req.product_id), r.available_qty);
      }
      if (req.action === 'check_stock') {
        state.phase = 'adding';
        return issue('add_to_cart', { product_id: req.product_id, quantity: req.quantity, confirmed: true }, 'Серверге себетке қосу сұранысы жіберілді.');
      }
      state.phase = 'idle'; state.pending = null;
      return result('Тауар себетке қосылды.');
    }
    if (r.status !== 'ok') {
      state.request = null;
      return result('Деректерді алу мүмкін болмады. Менеджерге жүгініңіз.', [], { handoff: true });
    }
    const products = (event.products ?? []).map(safeProduct);
    state.request = null;
    for (const p of products) state.products = [...state.products.filter(old => old.id !== p.id), p];
    if (req.action === 'get_purchase_terms') {
      const entries = Object.entries(event.purchase_terms ?? {}).filter(([, v]) => v != null);
      return result(entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join('\n') : MISSING);
    }
    if (req.action === 'get_product_info') {
      const p = products.find(p => p.id === req.product_id);
      const value = p && (req.field === 'voltage' || req.field === 'power' ? p.attributes?.[req.field] : p[req.field]);
      return result(value == null || (typeof value === 'object' && !Object.keys(value).length) ? MISSING : `${req.field}: ${typeof value === 'object' ? JSON.stringify(value) : value}`, p ? [p] : []);
    }
    if (req.action === 'get_alternatives') {
      const chosen = chooseAlternative(state.products.find(p => p.id === req.product_id), products);
      if (!chosen) return result('Сервер балама тауар ұсынбады.');
      state.focusIds = [chosen.product.id];
      return result(`${chosen.product.name}. ${chosen.reasons.join('; ') || 'Сервер ұқсас тауар ретінде қайтарды; салыстыру деректері көрсетілмеген.'}`, [chosen.product]);
    }
    state.focusIds = products.map(p => p.id);
    return result(products.length ? 'Табылған тауарлар. Қажетті тауардың артикулын көрсетіңіз.' : 'Тауар табылмады.', products);
  }
  if (event.type !== 'user' || typeof event.text !== 'string') throw new TypeError('Invalid event');
  const text = event.text;
  // Do not echo, keep in session, or forward likely payment secrets.
  if (/(?:\d[ -]?){13,19}|\b(?:cvv|cvc|пароль)\b/iu.test(text)) return result('Төлем деректерін чатқа жібермеңіз. Бұл чат оларды өңдемейді.');
  let nlu = recognize(text);
  if (state.phase === 'adding') return result('Себетке қосу нәтижесі күтілуде. Қайталама сұраныс жіберілмейді.');
  if (nlu.intent === 'cancel') {
    state.phase = 'idle'; state.pending = null; state.request = null; state.clarification = null;
    return result('Сұраныс тоқтатылды.');
  }
  if (state.phase === 'checking_stock') return result('Сервердің қалдықты тексеру нәтижесі күтілуде. Бас тарту үшін «Жоқ» деңіз.');
  if (nlu.intent === 'confirm') {
    if (state.phase !== 'awaiting_confirmation' || !state.pending) return result('Растайтын ұсыныс жоқ. Тауар мен санын көрсетіңіз.');
    state.phase = 'checking_stock';
    return issue('check_stock', { ...state.pending, confirmed: true }, 'Серверден қолжетімді санды қайта тексеруді сұрадым.');
  }
  if (state.clarification && nlu.intent === 'fallback' && (nlu.productId || state.products.some(p => text.toLowerCase().includes(p.name.toLowerCase())))) nlu = { ...state.clarification, productId: nlu.productId };
  // Any new substantive turn invalidates an old confirmation proposal/request.
  state.phase = 'idle'; state.pending = null; state.request = null;
  state.clarification = null;
  if (nlu.intent === 'checkout') { state.clarification = null; return result('Себетке өтуге болады.', [], { navigation: 'cart' }); }
  if (nlu.intent === 'search') { state.clarification = null; return issue('search', { query: nlu.query }, 'Тауарды іздеу сұранысы жіберілді.'); }
  if (nlu.intent === 'purchase_terms') return issue('get_purchase_terms', {}, 'Сатып алу шарттарын сұрадым.');
  if (['cart_request', 'product_info', 'alternatives'].includes(nlu.intent)) {
    const named = state.products.filter(p => text.toLowerCase().includes(p.name.toLowerCase()));
    const explicitIds = [...text.matchAll(/(?:id|артикул)\s*[:#]?\s*(\d+)/giu)].map(m => Number(m[1]));
    const ids = explicitIds.length ? [...new Set(explicitIds)] : named.length ? named.map(p => p.id) : state.focusIds;
    const selected = ids.length === 1 ? state.products.find(p => p.id === ids[0]) : null;
    if (!selected) {
      state.clarification = nlu;
      return result('Қай тауар туралы айтып тұрсыз? Артикулын көрсетіңіз немесе алдымен тауарды іздеңіз.', state.products.filter(p => ids.includes(p.id)));
    }
    state.focusIds = [selected.id]; state.clarification = null;
    if (nlu.intent === 'cart_request') {
      if (!validQty(nlu.quantity)) { state.clarification = nlu; return result('Қанша дана керек? Оң бүтін санмен жазыңыз, мысалы: «5 дана керек».'); }
      return offer(selected, nlu.quantity);
    }
    return issue(nlu.intent === 'alternatives' ? 'get_alternatives' : 'get_product_info', { product_id: selected.id, ...(nlu.field ? { field: nlu.field } : {}) }, 'Серверден деректерді сұрадым.');
  }
  return result('Сұрағыңызды нақтылай аласыз ба? Қажет болса, менеджерге жүгінуге көмектесемін.', [], { handoff: true });
}
