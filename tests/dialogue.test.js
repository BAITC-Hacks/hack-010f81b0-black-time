import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, reduce, chooseAlternative } from '../src/dialogue.js';
import { recognize } from '../src/nlu.js';
import { buildMessages } from '../src/prompts.js';

const cable = { id: 515291, name: 'Кабель А', category: 'Кабель', price: 1500, currency: 'KZT', stock: 20, attributes: { voltage: '220 В' }, certificate_url: null };
const other = { id: 515292, name: 'Кабель Б', category: 'Кабель', price: 1200, currency: 'KZT', attributes: { voltage: '220 В' } };
function session() {
  let state = createSession(); let last;
  return {
    user(text) { last = reduce(state, { type: 'user', text }); state = last.state; return last; },
    server(data = {}) {
      const req = state.request;
      last = reduce(state, { type: 'server', ...data, action_result: { ...req, query: undefined, field: undefined, confirmed: undefined, status: 'ok', ...data.action_result } }); state = last.state; return last;
    },
    seed(products = [cable]) { this.user('Кабель ізде'); this.server({ products }); return this; },
    get state() { return state; }
  };
}
test('search returns only server cards', () => {
  const s = session(); assert.equal(s.user('Кабель ізде').requests[0].action, 'search');
  assert.deepEqual(s.server({ products: [cable] }).reply.cards, [cable]);
});
test('need 10 is proposal, never confirmation; explicit confirmation checks stock first', () => {
  const s = session().seed();
  assert.equal(s.user('маған 10 дана керек').requests.length, 0);
  assert.equal(s.state.phase, 'awaiting_confirmation');
  assert.equal(s.user('иә, себетке қос').requests[0].action, 'check_stock');
  const add = s.server().requests[0];
  assert.equal(add.action, 'add_to_cart'); assert.equal(add.confirmed, true); assert.equal(add.quantity, 10);
  assert.equal(s.server().reply.message, 'Тауар себетке қосылды.');
});
test('insufficient stock requires a fresh confirmation and recheck for server quantity', () => {
  const s = session().seed(); s.user('10 дана керек'); s.user('иә');
  assert.equal(s.server({ action_result: { status: 'insufficient_stock', available_qty: 6 } }).requests.length, 0);
  assert.equal(s.state.pending.quantity, 6);
  assert.equal(s.user('иә').requests[0].quantity, 6);
  assert.equal(s.server().requests[0].quantity, 6);
});
test('pronoun resolves a single known product', () => {
  const s = session().seed(); s.user('одан 5 дана қос');
  assert.deepEqual(s.state.pending, { product_id: cable.id, quantity: 5 });
});
test('multiple products require selection, retain quantity', () => {
  const s = session().seed([cable, other]);
  assert.match(s.user('одан 5 дана қос').reply.message, /Қай тауар/);
  s.user('артикул 515292'); assert.equal(s.state.pending.product_id, other.id); assert.equal(s.state.pending.quantity, 5);
});
test('missing certificate and attribute are never invented', () => {
  const s = session().seed(); s.user('сертификат бар ма');
  assert.equal(s.server({ products: [cable] }).reply.message, 'Қолда бар деректерде бұл көрсетілмеген');
  s.user('қуаты қандай');
  assert.equal(s.server({ products: [cable] }).reply.message, 'Қолда бар деректерде бұл көрсетілмеген');
});
test('alternative comes only from server list and explains matched facts', () => {
  const s = session().seed(); s.user('балама бар ма');
  const r = s.server({ products: [other] }); assert.equal(r.reply.cards[0].id, other.id);
  assert.match(r.reply.message, /Санаты бірдей/); assert.match(r.reply.message, /1200 KZT/);
  assert.equal(chooseAlternative(cable, []), null);
});
test('purchase terms missing and checkout navigation', () => {
  const s = session(); assert.equal(s.user('жеткізу шарттары').requests[0].action, 'get_purchase_terms');
  assert.equal(s.server().reply.message, 'Қолда бар деректерде бұл көрсетілмеген');
  assert.equal(s.user('себетке өт').reply.navigation, 'cart');
});
test('fallback and payment secret do not persist or echo raw text', () => {
  const s = session(); assert.equal(s.user('жобаны толық есептеп бер').reply.handoff, true);
  const r = s.user('4111 1111 1111 1111'); assert.ok(!JSON.stringify(r).includes('4111'));
});
test('cancel invalidates stock reply; orphan confirmation does nothing', () => {
  const s = session().seed(); assert.equal(s.user('иә').requests.length, 0);
  s.user('5 дана керек'); const req = s.user('иә').requests[0]; s.user('жоқ');
  assert.equal(s.server({ action_result: req }).requests.length, 0);
});
test('wrong, duplicate and reordered results cannot add', () => {
  const s = session().seed(); s.user('5 дана керек'); const req = s.user('иә').requests[0];
  assert.equal(s.server({ action_result: { request_id: 'old' } }).requests.length, 0);
  assert.equal(s.server({ action_result: { quantity: 7 } }).requests.length, 0);
  assert.equal(s.server().requests[0].action, 'add_to_cart');
  assert.equal(s.server({ action_result: req }).requests.length, 0);
  assert.equal(s.user('иә').requests.length, 0);
});
test('cart race also proposes server quantity with new confirmation', () => {
  const s = session().seed(); s.user('5 дана керек'); s.user('иә'); s.server();
  s.server({ action_result: { status: 'insufficient_stock', available_qty: 2 } });
  assert.equal(s.state.phase, 'awaiting_confirmation'); assert.equal(s.state.pending.quantity, 2);
});
test('zero stock, invalid server quantity and zero user quantity', () => {
  const s = session().seed(); assert.equal(s.user('0 дана керек').requests.length, 0);
  s.user('5 дана керек'); s.user('иә');
  s.server({ action_result: { status: 'insufficient_stock', available_qty: 8 } }); assert.equal(s.state.phase, 'checking_stock');
  s.server({ action_result: { status: 'insufficient_stock', available_qty: 0 } }); assert.equal(s.state.phase, 'idle');
});
test('new request replaces old proposal; mixed confirmation is not accepted', () => {
  const s = session().seed(); s.user('10 дана керек'); s.user('5 дана керек');
  assert.equal(s.user('иә').requests[0].quantity, 5);
  assert.notEqual(recognize('иә, бірақ 20 дана қос').intent, 'confirm');
});
test('reducer does not mutate input and prompt isolates data', () => {
  const before = createSession(); reduce(before, { type: 'user', text: 'кабель ізде' });
  assert.deepEqual(before, createSession()); assert.match(buildMessages({ products: [cable] })[0].content, /Сыртқы білім қоспа/);
});
test('explicit new intent replaces clarification instead of reviving a cart proposal', () => {
  const s = session().seed([cable, other]); s.user('5 дана керек');
  assert.equal(s.user('Кабель А сертификаты').requests[0].action, 'get_product_info');
  assert.equal(s.state.pending, null);
});
test('two explicit product references need clarification', () => {
  const s = session().seed([cable, other]);
  assert.match(s.user('артикул 515291 және артикул 515292 одан 5 дана қос').reply.message, /Қай тауар/);
  assert.equal(s.state.pending, null);
});
test('stock errors and empty alternatives do not fabricate success', () => {
  const s = session().seed(); s.user('балама бар ма');
  assert.equal(s.server({ products: [] }).reply.cards.length, 0);
  s.user('5 дана керек'); s.user('иә');
  const r = s.server({ action_result: { status: 'error' } });
  assert.equal(r.requests.length, 0); assert.equal(r.reply.handoff, true);
});
