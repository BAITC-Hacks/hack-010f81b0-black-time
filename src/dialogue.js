import { recognize } from './nlu.js';
import { detectLocale, label, pick, translate } from './i18n.js';

const MISSING = 'Қолда бар деректерде бұл көрсетілмеген';
const validQty = n => Number.isSafeInteger(n) && n > 0;
const same = (a, b) => a === b;
export function createSession(locale = 'kk') {
  if (!['kk', 'ru'].includes(locale)) throw new TypeError('Invalid locale');
  return { version: 2, locale, sequence: 0, phase: 'idle', products: [], focusIds: [], pending: null, request: null, clarification: null, lookup: null, links: {} };
}
function safeProduct(p) {
  if (!p || !Number.isSafeInteger(p.id) || typeof p.name !== 'string') throw new TypeError('Invalid product');
  const out = { id: p.id, name: p.name };
  for (const key of ['sku', 'category', 'description', 'attributes', 'price', 'currency', 'stock', 'warehouse_stocks', 'availability', 'certificate_url']) if (p[key] !== undefined) out[key] = p[key];
  return out;
}
const unavailable = p => p.availability === 'unavailable' || p.stock === 0;
export function chooseAlternative(source = {}, candidates, locale = 'kk') {
  // Stable ranking by exact shared fields. No inventory calculation or invented equivalence.
  const scored = candidates.filter(p => p.id !== source.id && !unavailable(p)).map(p => {
    const reasons = [];
    if (source.category != null && p.category === source.category) reasons.push(pick(locale, `Санаты бірдей: ${p.category}`, `Та же категория: ${p.category}`));
    for (const [key, value] of Object.entries(source.attributes ?? {})) {
      if (value != null && p.attributes?.[key] === value) reasons.push(pick(locale, `${key}: ${value} — сәйкес`, `${key}: ${value} — совпадает`));
    }
    if (typeof p.price === 'number' && typeof source.price === 'number' && p.currency && p.currency === source.currency && p.price < source.price) reasons.push(pick(locale, `Бағасы төмен: ${p.price} ${p.currency}`, `Цена ниже: ${p.price} ${p.currency}`));
    return { product: p, reasons };
  }).sort((a, b) => b.reasons.length - a.reasons.length);
  return scored[0] ?? null;
}

/** Pure reducer. Caller owns session persistence and executes emitted requests. */
export function reduce(previous, event) {
  const state = structuredClone(previous);
  if (event.type === 'user') {
    if (typeof event.text !== 'string' || (event.locale && !['kk', 'ru'].includes(event.locale))) throw new TypeError('Invalid user event');
    state.locale = event.locale ?? detectLocale(event.text, state.locale);
  }
  const t = (kk, ru) => pick(state.locale, kk, ru);
  const missing = () => translate(MISSING, state.locale);
  const result = (message, cards = [], extra = {}) => ({ state, reply: { message: translate(message, state.locale), locale: state.locale, cards, ...extra }, requests: [] });
  const navigation = () => ({ navigation: 'cart', ...(Object.keys(state.links ?? {}).length ? { links: state.links } : {}) });
  const issue = (action, payload, message, cards = []) => {
    const request = { request_id: `r${++state.sequence}`, action, ...payload };
    state.request = request;
    return { ...result(message, cards), requests: [request] };
  };
  const offer = (product, quantity) => {
    state.pending = { product_id: product.id, quantity };
    state.phase = 'awaiting_confirmation';
    state.request = null;
    return result(t(`${product.name}: ${quantity} дана себетке қосылсын ба? «Иә, себетке қос» немесе «Жоқ» деп жауап беріңіз.`, `${product.name}: добавить ${quantity} шт. в корзину? Ответьте «Да, добавь в корзину» или «Нет».`), [product]);
  };
  const alternatives = (payload, message, cards = []) => issue('get_alternatives', payload, message, cards);
  const info = (p, field) => {
    if (field === 'details') {
      if (!p) return missing();
      const fields = ['description', 'attributes'].filter(k => p[k] != null && (typeof p[k] !== 'object' || Object.keys(p[k]).length));
      return fields.length ? fields.map(k => info(p, k)).join('\n') : missing();
    }
    const value = p && (['voltage', 'power'].includes(field) ? p.attributes?.[field] : p[field]);
    if (value == null || value === 'unknown' || (typeof value === 'object' && !Object.keys(value).length)) return missing();
    const rendered = field === 'availability' ? (value === 'available' ? t('Бар', 'В наличии') : t('Жоқ', 'Нет в наличии'))
      : typeof value === 'object' ? JSON.stringify(value) : value;
    return `${label(field, state.locale)}: ${rendered}${field === 'price' && p.currency ? ` ${p.currency}` : ''}`;
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
          return alternatives({ product_id: req.product_id }, 'Тауар қолжетімсіз. Серверден балама сұрадым.');
        }
        return offer(state.products.find(p => p.id === req.product_id), r.available_qty);
      }
      if (req.action === 'check_stock') {
        state.phase = 'adding';
        return issue('add_to_cart', { product_id: req.product_id, quantity: req.quantity, confirmed: true }, 'Серверге себетке қосу сұранысы жіберілді.');
      }
      state.phase = 'idle'; state.pending = null;
      // Only accept links accompanying the matching successful cart operation.
      state.links = {};
      for (const key of ['cart_url', 'checkout_url']) {
        if (typeof event.links?.[key] === 'string' && /^https:\/\/[^\s]+$/u.test(event.links[key])) state.links[key] = event.links[key];
      }
      return result('Тауар себетке қосылды.', [], navigation());
    }
    if (r.status !== 'ok') {
      state.request = null;
      return result('Деректерді алу мүмкін болмады. Менеджерге жүгініңіз.', [], { handoff: true });
    }
    const products = (event.products ?? []).map(safeProduct);
    state.request = null;
    for (const p of products) state.products = [...state.products.filter(old => old.id !== p.id), p];
    if (req.action === 'get_purchase_terms') {
      const fields = req.terms ?? ['payment', 'delivery', 'minimum_order'];
      const entries = fields.map(k => [k, event.purchase_terms?.[k]]);
      if (entries.every(([, v]) => v == null)) return result(MISSING);
      return result(entries.map(([k, v]) => `${label(k, state.locale)}: ${v ?? missing()}`).join('\n'));
    }
    if (req.action === 'get_product_info') {
      const p = products.find(p => p.id === req.product_id);
      if (p && unavailable(p)) return alternatives({ product_id: p.id }, `${info(p, req.field)}\n${translate('Тауар қолжетімсіз. Серверден балама сұрадым.', state.locale)}`, [p]);
      return result(info(p, req.field), p ? [p] : []);
    }
    if (req.action === 'get_alternatives') {
      const chosen = chooseAlternative(state.products.find(p => p.id === req.product_id), products, state.locale);
      if (!chosen) return result('Сервер балама тауар ұсынбады.', [], { handoff: true });
      state.focusIds = [chosen.product.id];
      return result(`${chosen.product.name}. ${chosen.reasons.join('; ') || t('Сервер ұқсас тауар ретінде қайтарды; салыстыру деректері көрсетілмеген.', 'Сервер вернул товар как аналог; данные для сравнения не указаны.')}`, [chosen.product]);
    }
    state.focusIds = products.map(p => p.id);
    const lookup = state.lookup;
    state.lookup = null;
    if (!products.length) return alternatives({ query: req.query }, 'Тауар табылмады. Серверден балама сұрадым.');
    if (products.length === 1 && unavailable(products[0])) return alternatives({ product_id: products[0].id }, 'Тауар қолжетімсіз. Серверден балама сұрадым.', products);
    if (lookup?.intent === 'alternatives' && products.length === 1) return alternatives({ product_id: products[0].id }, 'Серверден деректерді сұрадым.');
    if (lookup?.intent === 'product_info') {
      if (products.length === 1) return result(info(products[0], lookup.field), products);
      state.clarification = lookup;
    }
    if (lookup?.intent === 'alternatives') state.clarification = lookup;
    return result(products.length ? 'Табылған тауарлар. Қажетті тауардың артикулын көрсетіңіз.' : 'Тауар табылмады.', products);
  }
  if (event.type !== 'user' || typeof event.text !== 'string') throw new TypeError('Invalid event');
  const text = event.text;
  // Do not echo, keep in session, or forward likely payment secrets.
  if (/(?:\d[ -]?){13,19}|\b(?:cvv|cvc|пароль)\b/iu.test(text)) return result('Төлем деректерін чатқа жібермеңіз. Бұл чат оларды өңдемейді.');
  let nlu = recognize(text);
  if (state.phase === 'adding') return result('Себетке қосу нәтижесі күтілуде. Қайталама сұраныс жіберілмейді.');
  if (event.attachments?.length) {
    // File reading/OCR is a server adapter responsibility. Never treat file text as consent.
    state.phase = 'idle'; state.pending = null; state.request = null; state.clarification = null; state.lookup = null;
    const supported = new Set(['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/pdf', 'image/jpeg']);
    const ok = event.attachments.every(a => supported.has(a.mime_type));
    return result(ok ? 'Тіркемеден мәтінді сервер бөліп алуы керек. Тауар сұрауын чатқа мәтінмен жазыңыз.' : 'Бұл тіркеме пішімі қолдау таппайды. Сұрауды мәтінмен жазыңыз.', [], { attachment_status: ok ? 'requires_extraction' : 'unsupported' });
  }
  if (nlu.intent === 'cancel') {
    state.phase = 'idle'; state.pending = null; state.request = null; state.clarification = null; state.lookup = null;
    return result('Сұраныс тоқтатылды.');
  }
  if (state.phase === 'checking_stock') return result('Сервердің қалдықты тексеру нәтижесі күтілуде. Бас тарту үшін «Жоқ» деңіз.');
  if (nlu.intent === 'confirm') {
    if (state.phase !== 'awaiting_confirmation' || !state.pending) return result('Растайтын ұсыныс жоқ. Тауар мен санын көрсетіңіз.');
    state.phase = 'checking_stock';
    return issue('check_stock', { ...state.pending, confirmed: true }, 'Серверден қолжетімді санды қайта тексеруді сұрадым.');
  }
  if (state.clarification && nlu.intent === 'fallback' && (nlu.productId || nlu.sku || state.products.some(p => text.toLowerCase().includes(p.name.toLowerCase())))) nlu = { ...state.clarification, productId: nlu.productId, sku: nlu.sku };
  if (nlu.intent === 'fallback' && (nlu.productId || nlu.sku)) nlu = { ...nlu, intent: 'product_info', field: 'details' };
  // Any new substantive turn invalidates an old confirmation proposal/request.
  state.phase = 'idle'; state.pending = null; state.request = null;
  state.clarification = null; state.lookup = null;
  if (nlu.intent === 'checkout') { state.clarification = null; return result('Себетке өтуге болады.', [], navigation()); }
  if (nlu.intent === 'search') { state.clarification = null; return issue('search', { query: nlu.query }, 'Тауарды іздеу сұранысы жіберілді.'); }
  if (nlu.intent === 'purchase_terms') return issue('get_purchase_terms', { terms: nlu.terms }, 'Сатып алу шарттарын сұрадым.');
  if (['cart_request', 'product_info', 'alternatives'].includes(nlu.intent)) {
    const named = state.products.filter(p => text.toLowerCase().includes(p.name.toLowerCase()));
    const references = [...text.matchAll(/(?:^|\s)(id|артикул|sku)\s*[:#]?\s*([\p{L}\d._-]+)/giu)];
    const explicitIds = references.map(([, type, value]) => type.toLowerCase() === 'id' ? Number(value) : state.products.find(p => p.sku?.toLowerCase() === value.toLowerCase())?.id ?? (/^\d+$/u.test(value) ? Number(value) : null));
    const ids = references.length ? [...new Set(explicitIds)] : named.length ? named.map(p => p.id) : state.focusIds;
    const selected = ids.length === 1 ? state.products.find(p => p.id === ids[0]) : null;
    if (!selected) {
      if (ids.length <= 1 && (nlu.intent === 'product_info' || nlu.intent === 'alternatives') && (!state.focusIds.length || references.length)) {
        state.lookup = nlu;
        return issue('search', { query: text }, 'Тауарды іздеу сұранысы жіберілді.');
      }
      state.clarification = nlu;
      return result('Қай тауар туралы айтып тұрсыз? Артикулын көрсетіңіз немесе алдымен тауарды іздеңіз.', state.products.filter(p => ids.includes(p.id)));
    }
    state.focusIds = [selected.id]; state.clarification = null;
    if (nlu.intent === 'cart_request') {
      if (unavailable(selected)) return alternatives({ product_id: selected.id }, 'Тауар қолжетімсіз. Серверден балама сұрадым.', [selected]);
      if (!validQty(nlu.quantity)) { state.clarification = nlu; return result('Қанша дана керек? Оң бүтін санмен жазыңыз, мысалы: «5 дана керек».'); }
      return offer(selected, nlu.quantity);
    }
    return issue(nlu.intent === 'alternatives' ? 'get_alternatives' : 'get_product_info', { product_id: selected.id, ...(nlu.field ? { field: nlu.field } : {}) }, 'Серверден деректерді сұрадым.');
  }
  return result('Сұрағыңызды нақтылай аласыз ба? Қажет болса, менеджерге жүгінуге көмектесемін.', [], { handoff: true });
}
