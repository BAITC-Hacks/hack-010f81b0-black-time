import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSession, reduce } from '../src/dialogue.js';
import { buildMessages } from '../src/prompts.js';

const product = {
  id: 7, sku: 'ЕКТ-A.01', name: 'Сынақ кабелі', category: 'Кабель',
  description: 'Сервер берген сипаттама', attributes: { voltage: '220 В' },
  price: 1000, currency: 'KZT', stock: 6, availability: 'available',
  warehouse_stocks: [{ warehouse_id: 'alm', name: 'Алматы', quantity: 2 }, { warehouse_id: 'ast', name: 'Астана', quantity: 4 }],
  certificate_url: 'https://ekt.kz/example-certificate.pdf'
};
const alternative = { ...product, id: 8, sku: 'ALT-8', name: 'Балама кабель', price: 900 };
function chat(locale = 'kk') {
  let state = createSession(locale);
  const event = e => { const r = reduce(state, e); state = r.state; return r; };
  return {
    event,
    user: (text, extra = {}) => event({ type: 'user', text, ...extra }),
    server(data = {}) {
      const req = state.request;
      assert.ok(req, 'test must have a pending request');
      const action_result = { request_id: req.request_id, action: req.action, status: 'ok' };
      if (['check_stock', 'add_to_cart'].includes(req.action)) Object.assign(action_result, { product_id: req.product_id, quantity: req.quantity });
      return event({ type: 'server', ...data, action_result: { ...action_result, ...data.action_result } });
    },
    seed(p = product) { this.user(locale === 'ru' ? 'найди кабель' : 'Кабель ізде'); this.server({ products: [p] }); return this; },
    get state() { return state; }
  };
}

test('M1 catalogue cards preserve SKU, description, certificate and each warehouse', () => {
  const s = chat(); s.user('Кабель ізде');
  const r = s.server({ products: [product] });
  assert.deepEqual(r.reply.cards, [product]);
  s.user('артикул ЕКТ-A.01 одан 5 дана қос');
  assert.equal(s.state.pending.product_id, 7);
  assert.equal(s.state.pending.quantity, 5);
});
test('M1 known certificate, attributes, price and availability use fresh server values', () => {
  const s = chat().seed();
  for (const [question, expected] of [['сертификат бар ма', product.certificate_url], ['сипаттамасы қандай', '220 В'], ['бағасы қандай', '1000 KZT'], ['қолда бар ма', 'Бар']]) {
    assert.equal(s.user(question).requests[0].action, 'get_product_info');
    assert.ok(s.server({ products: [product] }).reply.message.includes(expected));
  }
});
test('M1 absent price, stock, certificate and availability are never filled from old cache', () => {
  const s = chat().seed();
  for (const question of ['бағасы қандай', 'қалдық қанша', 'сертификат бар ма', 'қолда бар ма']) {
    s.user(question);
    assert.equal(s.server({ products: [{ id: 7, name: product.name }] }).reply.message, 'Қолда бар деректерде бұл көрсетілмеген');
  }
});
test('M1 warehouse query returns server entries without inventing a total', () => {
  const s = chat().seed(); const r = s.user('қоймалар бойынша қалдық');
  assert.equal(r.requests[0].field, 'warehouse_stocks');
  const output = s.server({ products: [{ ...product, stock: null }] });
  assert.ok(output.reply.message.includes('"quantity":2')); assert.ok(output.reply.message.includes('"quantity":4'));
  assert.equal(output.reply.cards[0].stock, null);
});
test('M1 textual description alone answers a Kazakh description question', () => {
  const s = chat().seed(); s.user('сипаттамасы қандай');
  assert.match(s.server({ products: [{ id: 7, name: product.name, description: 'Тек сервер сипаттамасы' }] }).reply.message, /Тек сервер сипаттамасы/);
});
test('M1 first-turn information query retains its field through catalogue lookup', () => {
  const s = chat(); assert.equal(s.user('артикул ЕКТ-A.01 бағасы қандай').requests[0].action, 'search');
  assert.equal(s.server({ products: [{ id: 7, sku: product.sku, name: product.name }] }).reply.message, 'Қолда бар деректерде бұл көрсетілмеген');
});
test('SKU selection after multiple search results establishes the pronoun context', () => {
  const s = chat(); s.user('Кабель ізде'); s.server({ products: [product, alternative] });
  const req = s.user('артикул ALT-8').requests[0];
  assert.equal(req.action, 'get_product_info'); assert.equal(req.product_id, 8);
  s.server({ products: [alternative] }); s.user('одан 5 дана қос');
  assert.equal(s.state.pending.product_id, 8);
});
test('M2 unavailable search automatically requests and explains a server alternative', () => {
  const s = chat(); s.user('Кабель ізде');
  const r = s.server({ products: [{ ...product, stock: 0, availability: 'unavailable' }] });
  assert.equal(r.requests[0].action, 'get_alternatives'); assert.equal(r.requests[0].product_id, 7);
  const reply = s.server({ products: [alternative] }).reply;
  assert.equal(reply.cards[0].id, 8); assert.match(reply.message, /Санаты бірдей/);
  s.user('одан 5 дана қос'); assert.equal(s.state.pending.product_id, 8);
});
test('M2 empty search requests alternatives by original query; empty alternatives hand off', () => {
  const s = chat(); s.user('Кабель ізде');
  const req = s.server({ products: [] }).requests[0];
  assert.equal(req.action, 'get_alternatives'); assert.equal(req.query, 'Кабель ізде'); assert.equal(req.product_id, undefined);
  const r = s.server({ products: [] }); assert.equal(r.reply.handoff, true); assert.equal(r.requests.length, 0);
});
test('M2 alternatives by query can suggest one server candidate, never an unavailable candidate', () => {
  const s = chat(); s.user('Кабель ізде'); s.server({ products: [] });
  const r = s.server({ products: [{ ...product, stock: 0 }, alternative] });
  assert.equal(r.reply.cards[0].id, 8); assert.match(r.reply.message, /Сервер ұқсас тауар/);
});
test('M2 zero stock on recheck requests an alternative without an add action', () => {
  const s = chat().seed(); s.user('10 дана керек'); s.user('иә');
  const r = s.server({ action_result: { status: 'insufficient_stock', available_qty: 0 } });
  assert.equal(r.requests[0].action, 'get_alternatives'); assert.equal(s.state.pending, null);
});
test('M2 first-turn alternative request survives finding the source product', () => {
  const s = chat(); assert.equal(s.user('артикул ЕКТ-A.01 балама').requests[0].action, 'search');
  assert.equal(s.server({ products: [product] }).requests[0].action, 'get_alternatives');
  assert.equal(s.server({ products: [alternative] }).reply.cards[0].id, 8);
});
test('M3 answers all three purchase terms from supplied values', () => {
  const s = chat(); const req = s.user('сатып алу шарттары').requests[0];
  assert.deepEqual(req.terms, ['payment', 'delivery', 'minimum_order']);
  const r = s.server({ purchase_terms: { payment: 'Шот бойынша', delivery: 'Алып кету', minimum_order: '5 дана' } });
  for (const text of ['Төлем: Шот бойынша', 'Жеткізу: Алып кету', 'Ең аз партия: 5 дана']) assert.ok(r.reply.message.includes(text));
});
test('M3 a missing requested term is not replaced with an unrelated known term', () => {
  const s = chat(); s.user('жеткізу шарттары');
  assert.equal(s.server({ purchase_terms: { payment: 'Шот бойынша' } }).reply.message, 'Қолда бар деректерде бұл көрсетілмеген');
  s.user('сатып алу шарттары');
  assert.match(s.server({ purchase_terms: { payment: 'Шот бойынша' } }).reply.message, /Жеткізу: Қолда бар деректерде бұл көрсетілмеген/);
});
test('M4 quantity change requires confirmation again; display stock does not authorize addition', () => {
  const s = chat().seed(); assert.equal(s.user('10 дана керек').requests.length, 0);
  assert.equal(s.user('иә').requests[0].action, 'check_stock');
  assert.equal(s.server({ action_result: { status: 'insufficient_stock', available_qty: 6 } }).requests.length, 0);
  assert.equal(s.state.pending.quantity, 6);
  assert.equal(s.user('иә').requests[0].quantity, 6);
  assert.equal(s.server().requests[0].action, 'add_to_cart');
});
test('M5 successful addition supplies server cart and checkout links and retains them for navigation', () => {
  const s = chat().seed(); s.user('5 дана керек'); s.user('иә'); s.server();
  const links = { cart_url: 'https://ekt.kz/cart', checkout_url: 'https://ekt.kz/checkout' };
  const r = s.server({ links });
  assert.equal(r.reply.navigation, 'cart'); assert.deepEqual(r.reply.links, links);
  assert.deepEqual(s.user('себетке өт').reply.links, links);
});
test('M5 missing links use only a frontend navigation target, never an invented URL', () => {
  const s = chat().seed(); s.user('5 дана керек'); s.user('иә'); s.server();
  const r = s.server(); assert.equal(r.reply.navigation, 'cart'); assert.equal(r.reply.links, undefined);
  assert.equal(s.user('себетке өт').reply.links, undefined);
});
test('M5 failed or stale cart result does not supply navigation links or success', () => {
  const s = chat().seed(); s.user('5 дана керек'); s.user('иә'); s.server();
  const links = { cart_url: 'https://ekt.kz/cart' };
  assert.equal(s.server({ links, action_result: { request_id: 'stale' } }).reply.navigation, undefined);
  assert.equal(s.server({ links, action_result: { status: 'error' } }).reply.navigation, undefined);
  assert.deepEqual(s.state.links, {});
});
test('Russian search, description, terms, confirmation, insufficient stock and success', () => {
  const s = chat('ru'); assert.match(s.user('найди кабель').reply.message, /Отправлен запрос/);
  s.server({ products: [product] });
  assert.equal(s.user('описание').requests[0].field, 'description');
  assert.match(s.server({ products: [product] }).reply.message, /Описание:/);
  s.user('доставка'); assert.equal(s.server().reply.message, 'В предоставленных данных это не указано');
  assert.match(s.user('нужно 10 шт').reply.message, /добавить 10 шт/);
  assert.equal(s.user('да, добавь в корзину').requests[0].action, 'check_stock');
  assert.match(s.server({ action_result: { status: 'insufficient_stock', available_qty: 6 } }).reply.message, /добавить 6 шт/);
  s.user('да'); s.server(); assert.equal(s.server().reply.message, 'Товар добавлен в корзину.');
});
test('explicit locale, Russian alternatives and fallback; prompt follows requested language', () => {
  const s = chat('ru').seed(); s.user('аналог');
  assert.match(s.server({ products: [alternative] }).reply.message, /Та же категория/);
  assert.match(s.user('???').reply.message, /Уточните вопрос/);
  assert.equal(s.user('???', { locale: 'kk' }).reply.locale, 'kk');
  assert.match(buildMessages({}, 'ru')[0].content, /орысша \(ru\)/);
  assert.throws(() => buildMessages({}, 'en'), /Invalid locale/);
});
test('Excel, Word, PDF and JPEG have an explicit extraction boundary, never grant consent', () => {
  const mimes = ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/pdf', 'image/jpeg'];
  for (const mime_type of mimes) {
    const s = chat().seed(); s.user('5 дана керек');
    const r = s.user('иә', { attachments: [{ id: 'file1', name: 'input', mime_type }] });
    assert.equal(r.reply.attachment_status, 'requires_extraction'); assert.equal(r.requests.length, 0); assert.equal(s.state.pending, null);
  }
  assert.equal(chat().user('', { attachments: [{ id: 'file2', name: 'app', mime_type: 'application/octet-stream' }] }).reply.attachment_status, 'unsupported');
});
test('contract exposes separate SKU, warehouse entries, attachment metadata, locale and cart links', () => {
  const schema = JSON.parse(readFileSync(new URL('../contracts/dialogue.schema.json', import.meta.url), 'utf8'));
  const d = schema.$defs;
  for (const key of Object.keys(product)) assert.ok(d.product.properties[key], `missing product property ${key}`);
  assert.ok(d.userEvent.properties.attachments); assert.ok(d.userEvent.properties.locale);
  assert.ok(d.serverEvent.properties.links); assert.ok(d.reply.properties.links);
  assert.deepEqual(d.warehouseStock.required, ['warehouse_id', 'quantity']);
});
