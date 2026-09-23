'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'frontend/catalog.js'), 'utf8');
const testedModule = { exports: {} };
new Function('module', source)(testedModule);
const { createService, normalizeProduct, parsePage, safeHttpUrl } = testedModule.exports;

const API_CONFIG = { mode: 'api', baseUrl: 'https://backend.example/api', timeoutMs: 300 };
const response = body => ({ ok: true, status: 200, json: async () => body });
const hasCode = code => error => error.name === 'CatalogError' && error.code === code;

test('demo-only URL scenario cannot disable the API catalog', () => {
  assert.doesNotThrow(() => createService({ ...API_CONFIG, demoScenario: 'not-a-demo-scenario' }));
});

async function withFetch(mock, operation) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await operation(); }
  finally { globalThis.fetch = previous; }
}

test('missing optional product values stay null without invented product information', () => {
  assert.deepEqual(normalizeProduct({ id: 515291 }), {
    id: '515291', sku: null, brand: null, name: null, price: null, stock: null,
    unit: null, description: null, specs: [], image: null, certificates: [], stores: [], minimum_order: null
  });
});

test('field mapping supports nested paths, zero prices/stocks and literal untrusted text', () => {
  const product = normalizeProduct({
    id: ' 515291 ', title: '<img src=x onerror=alert(1)>', ref: 'SKU-OTHER',
    money: { value: '0' }, warehouses: { sum: '12' },
    dimensions: [{ label: 'Полюс саны', value: 2 }, { name: 'Түсі', value: 'Ақ' }]
  }, { fields: { name: 'title', sku: 'ref', price: 'money.value', stock: 'warehouses.sum', specs: 'dimensions' } });
  assert.equal(product.id, '515291');
  assert.equal(product.name, '<img src=x onerror=alert(1)>');
  assert.equal(product.sku, 'SKU-OTHER');
  assert.equal(product.price, 0);
  assert.equal(product.stock, 12);
  assert.deepEqual(product.specs, [{ label: 'Полюс саны', value: '2' }, { label: 'Түсі', value: 'Ақ' }]);
  assert.equal(normalizeProduct({ id: 1, stock: 0 }).stock, 0);
});

test('actual warehouse quantities, minimum order and certificate URL are preserved without defaults', () => {
  const item=normalizeProduct({id:515291,article:'200300285_',properties:{KRATNOST_MIN:'6'},stores:[{id:13,name:'Алматы',quantity:0},{id:14,name:'Қойма',quantity:null},{name:'<img>',quantity:5}],certificate_url:'https://ekt.kz/cert.pdf'});
  assert.equal(item.minimum_order,6);assert.equal(item.sku,'200300285_');
  assert.deepEqual(item.stores,[{id:'13',name:'Алматы',quantity:0},{id:'14',name:'Қойма',quantity:null},{id:null,name:'<img>',quantity:5}]);
  assert.deepEqual(item.certificates,[{name:null,url:'https://ekt.kz/cert.pdf'}]);
  assert.equal(normalizeProduct({id:1,certificate_url:'javascript:alert(1)',properties:{KRATNOST_MIN:'unknown'}}).certificates.length,0);
  assert.equal(normalizeProduct({id:1,properties:{KRATNOST_MIN:'unknown'}}).minimum_order,null);
});

test('invalid numeric values never become valid prices or stock', () => {
  for (const value of ['', '   ', '1500 ₸', '1,500', '0x10', '20 units', 'Infinity', true, {}, [], -1, NaN, Infinity]) {
    const result = normalizeProduct({ id: 1, price: value, stock: value });
    assert.equal(result.price, null, 'price: ' + String(value));
    assert.equal(result.stock, null, 'stock: ' + String(value));
  }
  assert.equal(normalizeProduct({ id: 1, price: '15.50', stock: '15.50' }).price, 15.5);
  assert.equal(normalizeProduct({ id: 1, price: '15.50', stock: '15.50' }).stock, 15.5);
});

test('missing, empty and non-scalar IDs are schema errors; SKU cannot substitute for ID', () => {
  for (const id of [undefined, null, '', ' ', {}, [], true, NaN, Infinity, 0, -1, 'part/1', '1?x=1', '1.2', Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(() => normalizeProduct({ id, sku: '515291' }), hasCode('SCHEMA'));
  }
  assert.equal(normalizeProduct({ id: '001' }).id, '1');
  assert.throws(() => normalizeProduct([]), hasCode('SCHEMA'));
});

test('dot-segment IDs are rejected before they can leave the detail route', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return response({ data: { id: 'x' } }); }, async () => {
    for (const id of ['.', '..', ' .. ']) {
      assert.throws(() => normalizeProduct({ id }), hasCode('SCHEMA'));
      await assert.rejects(createService(API_CONFIG).detail(id), hasCode('CONFIG'));
    }
    assert.equal(calls, 0);
  });
});

test('image and certificate links accept safe HTTP URLs and resolve relative paths', () => {
  const item = normalizeProduct({
    id: 1, image: '/photos/a.jpg',
    certificates: [{ name: 'Сертификат', url: 'documents/1.pdf' }, { url: 'javascript:alert(1)' }, '/certificates/b.pdf']
  }, { baseUrl: 'https://backend.example/api' });
  assert.equal(item.image, 'https://backend.example/photos/a.jpg');
  assert.deepEqual(item.certificates, [
    { name: 'Сертификат', url: 'https://backend.example/api/documents/1.pdf' },
    { name: null, url: 'https://backend.example/certificates/b.pdf' }
  ]);
  for (const url of ['javascript:alert(1)', 'data:image/png,abc', 'file:///tmp/1', 'https://user:secret@host.example/a', 'https://host.example/\na']) {
    assert.equal(safeHttpUrl(url), null, url);
  }
  assert.equal(safeHttpUrl('https://example.org/a?q=1#part'), 'https://example.org/a?q=1#part');
  assert.equal(safeHttpUrl('/relative'), null);
});

test('short/empty pages do not imply pagination; duplicate IDs are removed', () => {
  const page = parsePage({ data: { page: 1, items: [{ id: 1, name: 'Бірінші' }, { id: '1', name: 'Екінші' }, { id: 2 }] } }, 1);
  assert.deepEqual(page.items.map(item => item.id), ['1', '2']);
  assert.equal(page.items[0].name, 'Бірінші');
  assert.equal(page.hasNext, null);
  assert.equal(page.totalPages, null);
  assert.equal(parsePage({ data: { items: [] } }, 2).hasNext, false);
});

test('mapped pagination metadata and page index are validated', () => {
  const config = { pagination: { hasNext: 'pagination.more', totalPages: 'pagination.pages' } };
  const first = parsePage({ data: { page: '1', items: [], pagination: { more: true, pages: 2 } } }, 1, config);
  assert.deepEqual(first, { items: [], page: 1, hasNext: true, totalPages: 2 });
  const last = parsePage({ data: { items: [], total_pages: '2' } }, 2);
  assert.equal(last.hasNext, false);
  assert.equal(parsePage({ data: { items: [], total_pages: 0 } }, 1).totalPages, 0);
  assert.equal(parsePage({ data: { items: [], has_next: false } }, 1).hasNext, false);
  assert.throws(() => parsePage({ data: { page: 2, items: [] } }, 1), hasCode('SCHEMA'));
  assert.throws(() => parsePage({ data: { page: null, items: [] } }, 1), hasCode('SCHEMA'));
  assert.throws(() => parsePage({ data: { items: [], has_next: 'false' } }, 1), hasCode('SCHEMA'));
  assert.throws(() => parsePage({ data: { items: [], total_pages: 1.5 } }, 1), hasCode('SCHEMA'));
  assert.throws(() => parsePage({ data: { items: [], total_pages: 1, has_next: true } }, 1), hasCode('SCHEMA'));
  assert.throws(() => parsePage({ data: { items: [{ id: 1 }], total_pages: 0 } }, 1), hasCode('SCHEMA'));
  assert.throws(() => parsePage({ data: { items: [{ id: 1 }], total_pages: 2 } }, 3), hasCode('SCHEMA'));
  assert.deepEqual(parsePage({ data: { items: [], total_pages: 2 } }, 3), { items: [], page: 3, hasNext: false, totalPages: 2 });
});

test('malformed list envelope and missing product ID fail visibly', () => {
  for (const payload of [null, [], {}, { data: [] }, { data: { items: {} } }, { data: { items: [{ sku: 'a' }] } }]) {
    assert.throws(() => parsePage(payload, 1), hasCode('SCHEMA'));
  }
  assert.throws(() => parsePage({ data: { items: [] } }, 0), hasCode('CONFIG'));
});

test('API configuration rejects absent, unsafe and credential-bearing URLs synchronously', () => {
  for (const baseUrl of ['', undefined, '/relative', 'ftp://example.org', 'https://user:secret@example.org', 'https://example.org?key=a', 'https://example.org#x', 'https://example.org?']) {
    assert.throws(() => createService({ mode: 'api', baseUrl }), hasCode('CONFIG'));
  }
  assert.throws(() => createService({ mode: 'other' }), hasCode('CONFIG'));
  assert.throws(() => createService({ timeoutMs: 0 }), hasCode('CONFIG'));
  assert.doesNotThrow(() => createService({ mode: 'demo', baseUrl: '' }));
});

test('API list uses GET /products?page=N and same-origin session credentials', async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({ url, options });
    return response({ data: { page: 2, items: [{ id: 515291, sku: 'NOT-ID' }] } });
  }, async () => {
    const result = await createService(API_CONFIG).list(2);
    assert.equal(result.items[0].id, '515291');
    assert.equal(calls[0].url, 'https://backend.example/api/products?page=2');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.deepEqual(calls[0].options.headers, { Accept: 'application/json' });
    assert.ok(calls[0].options.signal instanceof AbortSignal);
  });
});

test('API detail uses positive numeric ID and rejects mismatches or wrong envelopes', async () => {
  await withFetch(async url => {
    assert.equal(url, 'https://backend.example/api/products/515291');
    return response({ data: { id: 515291, sku: 'different-sku', name: 'Тауар' } });
  }, async () => assert.equal((await createService(API_CONFIG).detail('515291')).id, '515291'));
  await withFetch(async () => response({ data: { id: 2 } }), async () => {
    await assert.rejects(createService(API_CONFIG).detail(1), hasCode('SCHEMA'));
  });
  for (const payload of [{ data: [{ id: 1 }] }, { data: { sku: '1' } }, { result: { id: 1 } }]) {
    await withFetch(async () => response(payload), async () => {
      await assert.rejects(createService(API_CONFIG).detail(1), hasCode('SCHEMA'));
    });
  }
});

test('HTTP, network and JSON errors are distinct and preserve HTTP status', async () => {
  await withFetch(async () => ({ ok: false, status: 401, json: () => { throw new Error('must not parse'); } }), async () => {
    await assert.rejects(createService(API_CONFIG).list(1), error => hasCode('HTTP')(error) && error.status === 401);
  });
  await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
    await assert.rejects(createService(API_CONFIG).list(1), hasCode('NETWORK'));
  });
  await withFetch(async () => ({ ok: true, json: async () => { throw new SyntaxError('HTML'); } }), async () => {
    await assert.rejects(createService(API_CONFIG).list(1), hasCode('INVALID_JSON'));
  });
});

test('timeout rejects and aborts transport even when fetch ignores AbortSignal', async () => {
  let transportSignal;
  await withFetch((_url, options) => {
    transportSignal = options.signal;
    return new Promise(() => {});
  }, async () => {
    await assert.rejects(createService({ ...API_CONFIG, timeoutMs: 15 }).list(1), hasCode('TIMEOUT'));
    assert.equal(transportSignal.aborted, true);
  });
});

test('timeout also covers body parsing after response headers have arrived', async () => {
  await withFetch(async () => ({ ok: true, json: () => new Promise(() => {}) }), async () => {
    await assert.rejects(createService({ ...API_CONFIG, timeoutMs: 15 }).list(1), hasCode('TIMEOUT'));
  });
});

test('caller cancellation before a request prevents fetch', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await withFetch(async () => { calls++; return response({ data: { items: [] } }); }, async () => {
    await assert.rejects(createService(API_CONFIG).list(1, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 0);
  });
});

test('caller cancellation during body parsing is AbortError and aborts transport', async () => {
  const controller = new AbortController();
  let transportSignal;
  await withFetch(async (_url, options) => {
    transportSignal = options.signal;
    return { ok: true, json: () => { controller.abort('navigation'); return new Promise(() => {}); } };
  }, async () => {
    await assert.rejects(createService(API_CONFIG).detail(1, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(transportSignal.aborted, true);
  });
});

test('completed request removes caller listeners and does not later abort transport', async () => {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  let transportSignal;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { added++; return originalAdd(...args); };
  controller.signal.removeEventListener = (...args) => { removed++; return originalRemove(...args); };
  await withFetch(async (_url, options) => {
    transportSignal = options.signal;
    return response({ data: { items: [] } });
  }, async () => {
    await createService({ ...API_CONFIG, timeoutMs: 15 }).list(1, { signal: controller.signal });
    assert.equal(added, 1);
    assert.equal(removed, 1);
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(transportSignal.aborted, false);
  });
});

test('demo has two independent pages of 20 products and matching detail fixture', async () => {
  const service = createService({ mode: 'demo', fields: { name: 'unknown' } });
  const [first, second] = await Promise.all([service.list(1), service.list(2)]);
  assert.equal(first.items.length, 20);
  assert.equal(second.items.length, 20);
  assert.equal(second.items[0].id, '515291');
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 40);
  assert.equal(first.hasNext, true);
  assert.equal(second.hasNext, false);
  assert.equal(first.totalPages, 2);
  assert.ok(first.items.some(item => item.stock === null));
  assert.ok(first.items.some(item => item.price === null));
  assert.ok(first.items.some(item => item.stock === 0));
  assert.ok(first.items.every(item => item.name));
  assert.deepEqual(await service.detail(515291), second.items[0]);
});

test('demo error fails the first list once; retry returns products', async () => {
  const service = createService({ mode:'demo', demoScenario: 'error' });
  await assert.rejects(service.list(1), hasCode('NETWORK'));
  assert.equal((await service.list(1)).items.length, 20);
});

test('empty and slow demo scenarios are visible, cancellable and make no API requests', async () => {
  await withFetch(async () => { throw new Error('demo must not fetch'); }, async () => {
    assert.deepEqual(await createService({ mode:'demo', demoScenario: 'empty' }).list(1), { items: [], page: 1, hasNext: false, totalPages: 0 });
    const controller = new AbortController();
    const pending = createService({ mode:'demo', demoScenario: 'slow' }).list(1, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(createService({ mode:'demo', demoScenario: 'slow', timeoutMs: 15 }).list(1), hasCode('TIMEOUT'));
  });
});
