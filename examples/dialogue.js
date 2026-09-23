import { createSession, reduce } from '../src/dialogue.js';
let state = createSession();
function turn(event) {
  const output = reduce(state, event); state = output.state;
  console.log(JSON.stringify({ reply: output.reply, requests: output.requests }, null, 2));
}
turn({ type: 'user', text: 'Кабель ізде' });
turn({ type: 'server', products: [{ id: 515291, name: 'Демо кабель' }], action_result: { request_id: 'r1', action: 'search', status: 'ok' } });
turn({ type: 'user', text: 'одан 10 дана қос' });
turn({ type: 'user', text: 'иә, себетке қос' });
turn({ type: 'server', action_result: { request_id: 'r2', action: 'check_stock', product_id: 515291, quantity: 10, status: 'insufficient_stock', available_qty: 6 } });
turn({ type: 'user', text: 'иә' });
turn({ type: 'server', action_result: { request_id: 'r3', action: 'check_stock', product_id: 515291, quantity: 6, status: 'ok' } });
turn({ type: 'server', action_result: { request_id: 'r4', action: 'add_to_cart', product_id: 515291, quantity: 6, status: 'ok' } });
