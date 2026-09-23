import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSession, reduce, chooseAlternative } from '../src/dialogue.js';

const bridge = fileURLToPath(new URL('../src/bridge.js', import.meta.url));
const product = { id: 7, sku: '0007_', name: 'Кабель А', category: 'Кабель', stock: 10, attributes: { voltage: '220 В' } };
function chat(seed = false) {
  let state = createSession();
  const event = e => { const output = reduce(state, e); state = output.state; return output; };
  const api = {
    user: text => event({ type: 'user', text }),
    server(data = {}) { return event({ type: 'server', ...data, action_result: { ...state.request, status: 'ok', ...data.action_result } }); },
    get state() { return state; }
  };
  if (seed) { api.user('Кабель'); api.server({ products: [product] }); }
  return api;
}

test('one-shot bridge uses JSON stdin/stdout and round-trips state in UTF-8', () => {
  const first = spawnSync(process.execPath, [bridge], { input: JSON.stringify({ state: null, event: { type: 'user', text: 'Legrand' } }), encoding: 'utf8' });
  assert.equal(first.status, 0); assert.equal(first.stderr, '');
  const output = JSON.parse(first.stdout);
  assert.equal(output.requests[0].action, 'search');
  const second = spawnSync(process.execPath, [bridge], { input: JSON.stringify({ state: output.state, event: { type: 'server', products: [product], action_result: { ...output.requests[0], status: 'ok' } } }), encoding: 'utf8' });
  assert.equal(second.status, 0); assert.equal(JSON.parse(second.stdout).reply.cards[0].name, product.name);
});
test('bridge errors are machine-readable and do not echo input or stack traces', () => {
  const output = spawnSync(process.execPath, [bridge], { input: '{secret:do-not-echo', encoding: 'utf8' });
  assert.equal(output.status, 1); assert.deepEqual(JSON.parse(output.stdout), { error: 'dialogue_error' }); assert.equal(output.stderr, '');
});
test('explicit fresh ID fetches detail directly and establishes context', () => {
  const c = chat(); const req = c.user('id 7').requests[0];
  assert.equal(req.action, 'get_product_info'); assert.equal(req.product_id, 7);
  c.server({ products: [product] }); c.user('одан 2 дана қос'); assert.equal(c.state.pending.product_id, 7);
});
test('numeric article never resolves to a product ID with a different SKU', () => {
  const c = chat(true); const result = c.user('артикул 7 бағасы');
  assert.equal(result.requests[0].action, 'search'); assert.equal(c.state.pending, null);
});
test('first named cart request retains quantity through search and still requires consent', () => {
  const c = chat(); assert.equal(c.user('Кабель А 3 дана керек').requests[0].action, 'search');
  const result = c.server({ products: [product] });
  assert.deepEqual(c.state.pending, { product_id: 7, quantity: 3 }); assert.equal(result.requests.length, 0);
  assert.equal(c.user('иә').requests[0].action, 'check_stock');
});
test('a named new cart item replaces earlier focus instead of proposing the old item', () => {
  const c = chat(true); assert.equal(c.user('Legrand 3 дана керек').requests[0].action, 'search'); assert.equal(c.state.pending, null);
});
test('a question naming a new product never reads stale focus data', () => {
  const c = chat(true); const request = c.user('ABB бағасы қандай').requests[0];
  assert.equal(request.action, 'search'); assert.equal(c.state.lookup.field, 'price');
  const answer = c.server({ products: [{ ...product, id: 9, name: 'ABB', price: 123 }] });
  assert.match(answer.reply.message, /123/); assert.deepEqual(c.state.focusIds, [9]);
});
test('fresh ID cart requests use detail lookup and retain quantity', () => {
  const c = chat(); assert.equal(c.user('id 7: 3 дана керек').requests[0].action, 'get_product_info');
  c.server({ products: [product] }); assert.deepEqual(c.state.pending, { product_id: 7, quantity: 3 });
});
test('clarifications retain selected product and accept a quantity-only answer', () => {
  const c = chat(true); c.user('себетке қос'); assert.equal(c.state.clarification.intent, 'cart_request');
  c.user('3'); assert.deepEqual(c.state.pending, { product_id: 7, quantity: 3 });
});
test('a quantity without a selected product asks for the item and preserves quantity', () => {
  const c = chat(); assert.equal(c.user('3 дана керек').requests.length, 0);
  assert.equal(c.user('Legrand').requests[0].action, 'search');
  c.server({ products: [product] }); assert.equal(c.state.pending.quantity, 3);
});
test('Russian contextual addition does not search for prepositions', () => {
  const c = chat(true); c.user('добавь 3 шт в корзину'); assert.equal(c.state.pending.quantity, 3);
});
test('untrusted URLs cannot become local cart navigation, but /cart is allowed', () => {
  for (const [link, accepted] of [['/cart', true], ['/cart?view=items', true], ['//evil.test', false], ['/cart\\evil', false], ['javascript:alert(1)', false]]) {
    const c = chat(true); c.user('2 дана керек'); c.user('иә'); c.server();
    const result = c.server({ links: { cart_url: link } });
    assert.equal(Boolean(result.reply.links), accepted);
  }
});
test('catalogue warnings and media survive the boundary, currency is not invented', () => {
  const c = chat(); c.user('Кабель');
  const enriched = { ...product, price: 99, image: 'https://ekt.kz/image.jpg', url: 'https://ekt.kz/product', warnings: ['160 А / 250 А'], minimum_order: 2, order_multiple: 2 };
  const result = c.server({ products: [enriched] });
  assert.deepEqual(result.reply.cards[0], enriched); assert.match(result.reply.message, /160 А/);
  c.user('бағасы'); const answer = c.server({ products: [enriched] }); assert.ok(!answer.reply.message.includes('KZT'));
});
test('cheap or shared-brand candidates with unknown stock are not technical alternatives', () => {
  const source = { ...product, attributes: { voltage: '220 В', brand: 'A' } };
  assert.equal(chooseAlternative(source, [{ ...product, id: 8, stock: null }]), null);
  assert.equal(chooseAlternative(source, [{ ...product, id: 8, attributes: { brand: 'A' } }]), null);
  assert.equal(chooseAlternative({ ...source, attributes: { OBYEM: 'Кабель' } }, [{ ...product, id: 8, attributes: { OBYEM: 'Кабель' } }]), null);
  assert.equal(chooseAlternative(source, [{ ...product, id: 8, category: 'Лампа' }]), null);
  assert.equal(chooseAlternative(source, [{ ...product, id: 8 }]).product.id, 8);
});
test('safe backend error explanation does not turn a failed cart operation into success', () => {
  const c = chat(true); c.user('2 дана керек'); c.user('иә');
  const result = c.server({ action_result: { status: 'error' }, message: 'Себет қосылымы бапталмаған.' });
  assert.equal(result.reply.message, 'Себет қосылымы бапталмаған.'); assert.equal(result.reply.handoff, true); assert.equal(result.reply.navigation, undefined);
});
test('equivalent technical formatting accepted by backend remains an eligible alternative', () => {
  const candidate = { ...product, id: 8, attributes: { voltage: '220 в' } };
  const result = chooseAlternative(product, [candidate]);
  assert.equal(result.product.id, 8); assert.match(result.reasons.join(' '), /voltage: 220 В/);
});
test('technical attributes use readable labels while raw catalogue properties and warnings remain in cards', () => {
  const attributes = {
    NOMINALNOE_NAPRYAZHENIE: '400В', voltage: '400В', NOMINALNYY_TOK: '250 А',
    KOLICHESTVO_POLYUSOV: '3', NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST: '18кА',
    TIP_USTANOVKI: 'Винтовое', TORGOVAYA_MARKA: 'Legrand', 'Protection rating': 'IP20',
    CML2_TRAITS: ['internal inventory'], CML2_BAR_CODE: 'barcode', BRAND_PRIORITY: '1',
    NOVINKA: 'Да', SPETSPREDLOZHENIE: 'Нет', RECOMMEND: ['8'], IMYAKARTINKI: 'brand.jpg'
  };
  const c = chat(true);
  c.user('сипаттамасы қандай');
  const details = { ...product, attributes, warnings: ['160 А / 250 А'] };
  const result = c.server({ products: [details] });
  assert.match(result.reply.message, /Кернеу: 400В\nНоминалды ток: 250 А/);
  assert.equal(result.reply.message.match(/Кернеу: 400В/gu).length, 1);
  assert.match(result.reply.message, /Полюстер саны: 3/);
  assert.match(result.reply.message, /Protection rating: IP20/);
  assert.match(result.reply.message, /160 А \/ 250 А/);
  assert.doesNotMatch(result.reply.message, /CML2|BRAND_PRIORITY|NOVINKA|SPETSPREDLOZHENIE|RECOMMEND|IMYAKARTINKI|internal inventory|barcode/);
  assert.deepEqual(result.reply.cards[0].attributes, attributes);
  c.user('характеристики');
  const russian = c.server({ products: [details] });
  assert.match(russian.reply.message, /Напряжение: 400В/);
  assert.match(russian.reply.message, /Номинальный ток: 250 А/);
  assert.match(russian.reply.message, /Торговая марка: Legrand/);
});
