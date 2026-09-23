
(function (root) {
  'use strict';

  const DEFAULT_FIELDS = Object.freeze({
    name: 'name', sku: 'sku', brand: 'brand', price: 'price', stock: 'stock',
    unit: 'unit', description: 'description', specs: 'specs', image: 'image',
    certificates: 'certificates'
  });
  const DEFAULT_PAGINATION = Object.freeze({ hasNext: 'has_next', totalPages: 'total_pages' });
  const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  class CatalogError extends Error {
    constructor(code, message, status) {
      super(message);
      this.name = 'CatalogError';
      this.code = code;
      if (status !== undefined) this.status = status;
    }
  }

  function schemaError(message) {
    return new CatalogError('SCHEMA', message);
  }

  function safeHttpUrl(value, baseUrl) {
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const url = new URL(value.trim(), baseUrl || undefined);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function resolveBaseUrl(value) {
    const safe = safeHttpUrl(value);
    if (!safe) throw new CatalogError('CONFIG', 'Backend адресін http:// немесе https:// түрінде көрсетіңіз.');
    const url = new URL(safe);
    if (url.search || url.hash || String(value).includes('?') || String(value).includes('#')) {
      throw new CatalogError('CONFIG', 'Backend адресінде сұрау параметрлері мен # белгісі болмауы керек.');
    }
    return url.href.replace(/\/+$/, '') + '/';
  }

  function atPath(value, path) {
    if (typeof path !== 'string' || !path.trim()) return undefined;
    const keys = path.split('.');
    for (const key of keys) {
      if (!key || ['__proto__', 'prototype', 'constructor'].includes(key) ||
          value === null || typeof value !== 'object' || !owns(value, key)) return undefined;
      value = value[key];
    }
    return value;
  }

  function textValue(value) {
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
    return null;
  }

  function numberValue(value) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
      value = Number(text);
    }
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  function integerValue(value) {
    const number = numberValue(value);
    return Number.isSafeInteger(number) ? number : null;
  }

  function productId(value, code) {
    if ((typeof value === 'string' && /^\d+$/.test(value.trim())) || typeof value === 'number') {
      const number=Number(value);
      if(Number.isSafeInteger(number)&&number>0)return String(number);
    }
    throw new CatalogError(code || 'SCHEMA', 'Тауардың жарамды id өрісі жоқ.');
  }

  function pageNumber(value, code) {
    const page = integerValue(value);
    if (page === null || page < 1) {
      throw new CatalogError(code || 'CONFIG', 'Бет нөмірі 1-ден басталатын бүтін сан болуы керек.');
    }
    return page;
  }

  function normalizeSpecs(value) {
    const pairs = Array.isArray(value)
      ? value.filter(isRecord).map(item => [item.label ?? item.name, item.value])
      : isRecord(value) ? Object.entries(value) : [];
    return pairs.map(([label, content]) => ({ label: textValue(label), value: textValue(content) }))
      .filter(item => item.label !== null && item.value !== null);
  }

  function normalizeCertificates(value, baseUrl) {
    const entries = Array.isArray(value) ? value : value == null ? [] : [value];
    return entries.map(item => {
      if (typeof item === 'string') return { name: null, url: safeHttpUrl(item, baseUrl) };
      if (!isRecord(item)) return null;
      return { name: textValue(item.name ?? item.title), url: safeHttpUrl(item.url, baseUrl) };
    }).filter(item => item && item.url);
  }

  function normalizeProduct(raw, config) {
    if (!isRecord(raw)) throw schemaError('Тауар деректері объект түрінде келуі керек.');
    config = config || {};
    const fields = Object.assign({}, DEFAULT_FIELDS, config.fields || {});
    const baseUrl = config.baseUrl ? resolveBaseUrl(config.baseUrl) : undefined;
    const read = field => atPath(raw, fields[field]);
    const stores=raw.warehouse_stocks ?? raw.stores;
    const certificates=normalizeCertificates(read('certificates'), baseUrl);
    const certificateUrl=safeHttpUrl(raw.certificate_url,baseUrl);
    if(certificateUrl&&!certificates.some(item=>item.url===certificateUrl))certificates.push({name:null,url:certificateUrl});
    return {
      id: productId(raw.id),
      sku: textValue(read('sku') ?? raw.article),
      brand: textValue(read('brand') ?? raw.properties?.TORGOVAYA_MARKA),
      name: textValue(read('name')),
      price: numberValue(read('price')),
      stock: numberValue(read('stock') ?? raw.quantity),
      unit: textValue(read('unit')),
      description: textValue(read('description')),
      specs: normalizeSpecs(read('specs') ?? raw.attributes ?? raw.properties),
      image: safeHttpUrl(read('image'), baseUrl),
      certificates,
      stores: Array.isArray(stores)?stores.filter(isRecord).map(store=>({id:textValue(store.id ?? store.warehouse_id),name:textValue(store.name),quantity:numberValue(store.quantity)})):[],
      minimum_order: numberValue(raw.minimum_order ?? raw.properties?.KRATNOST_MIN)
    };
  }

  function parsePage(payload, requestedPage, config) {
    const page = pageNumber(requestedPage);
    if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.items)) {
      throw schemaError('Backend жауабында data.items массиві табылмады.');
    }
    const data = payload.data;
    if (owns(data, 'page') && pageNumber(data.page, 'SCHEMA') !== page) {
      throw schemaError('Backend басқа бетті қайтарды. Сұралған бет: ' + page + '.');
    }
    const pagination = Object.assign({}, DEFAULT_PAGINATION, config && config.pagination || {});
    const rawNext = atPath(data, pagination.hasNext);
    const rawTotal = atPath(data, pagination.totalPages);
    let hasNext = null;
    let totalPages = null;
    if (rawNext !== undefined && rawNext !== null) {
      if (typeof rawNext !== 'boolean') throw schemaError('Келесі бет белгісі boolean түрінде болуы керек.');
      hasNext = rawNext;
    }
    if (rawTotal !== undefined && rawTotal !== null) {
      totalPages = integerValue(rawTotal);
      if (totalPages === null) throw schemaError('Жалпы бет саны теріс емес бүтін сан болуы керек.');
      if (data.items.length && page > totalPages) {
        throw schemaError('Тауарлар тізімі жалпы бет санына сәйкес емес.');
      }
      const expectedNext = page < totalPages;
      if (hasNext !== null && hasNext !== expectedNext) throw schemaError('Беттер туралы мәліметтер бір-біріне сәйкес емес.');
      hasNext = expectedNext;
    }
    const seen = new Set();
    const items = [];
    for (const raw of data.items) {
      const item = normalizeProduct(raw, config);
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
    // count is the number on this page, never the entire catalog size.
    if (!items.length && hasNext === null) hasNext = false;
    return { items, page, hasNext, totalPages };
  }

  function abortError() {
    if (typeof DOMException !== 'undefined') return new DOMException('Сұраныс тоқтатылды.', 'AbortError');
    const error = new Error('Сұраныс тоқтатылды.');
    error.name = 'AbortError';
    return error;
  }

  function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Барлық демо дерек ойдан алынған. 515291 тек беттерді тексеруге арналған мысал ID.
  const DEMO_PRODUCTS = Array.from({ length: 40 }, (_, index) => {
    const category = index % 5;
    const names = ['Автоматты ажыратқыш', 'Күштік кабель', 'Жарықдиодты шам', 'Розетка', 'Модульдік контактор'];
    const details = ['C сипаттамасы, 230 В', 'Мыс өткізгіш, 3 × 2,5 мм²', '12 Вт, 4000 К', 'Жерге қосу, 16 А', '2 полюс, 25 А'];
    const id = index === 20 ? 515291 : 910001 + index;
    return {
      id,
      name: names[category] + ' DEMO-' + String(index + 1).padStart(2, '0'),
      sku: 'DEMO-' + String(index + 1).padStart(4, '0'),
      brand: ['Демо Электро', 'Демо Кабель', 'Демо Жарық'][index % 3],
      price: index === 8 ? null : [1500, 480, 1200, 1750, 6800][category] + Math.floor(index / 5) * 100,
      stock: index === 7 ? null : index % 6 === 3 ? 0 : 15 + (index * 7) % 90,
      unit: category === 1 ? 'м' : 'дана',
      description: details[category] + '. Интерфейсті тексеруге арналған ойдан алынған тауар.',
      specs: { 'Үлгі': 'DEMO-' + (index + 1), 'Серия': 'Демонстрациялық', 'Сипаттама': details[category] },
      image: null,
      certificates: []
    };
  });

  function createService(config) {
    config = config || {};
    const mode = config.mode === undefined ? 'api' : config.mode;
    if (!['api', 'demo'].includes(mode)) throw new CatalogError('CONFIG', 'Дерек режимі demo немесе api болуы керек.');
    const timeoutMs = config.timeoutMs === undefined ? 10000 : config.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
      throw new CatalogError('CONFIG', 'Сұраныстың күту уақытын оң санмен көрсетіңіз.');
    }
    const baseUrl = mode === 'api' ? resolveBaseUrl(config.baseUrl) : '';
    const settings = {
      baseUrl,
      fields: Object.assign({}, DEFAULT_FIELDS, config.fields || {}),
      pagination: Object.assign({}, DEFAULT_PAGINATION, config.pagination || {})
    };
    const demoScenario = mode === 'demo' ? (config.demoScenario || 'normal') : 'normal';
    if (!['normal', 'empty', 'error', 'slow'].includes(demoScenario)) {
      throw new CatalogError('CONFIG', 'Белгісіз демо сценарийі.');
    }
    let shouldFailFirstList = demoScenario === 'error';

    async function request(operation, callerSignal) {
      if (callerSignal && callerSignal.aborted) throw abortError();
      const controller = new AbortController();
      let terminate;
      let termination;
      const cancellation = new Promise((_, reject) => { terminate = reject; });
      function stop(error) {
        if (termination) return;
        termination = error;
        controller.abort(error);
        terminate(error);
      }
      const onAbort = () => stop(abortError());
      const timer = setTimeout(() => stop(new CatalogError('TIMEOUT', 'Backend жауабы күту уақытынан асты. Қайта көріңіз.')), timeoutMs);
      if (callerSignal) {
        callerSignal.addEventListener('abort', onAbort, { once: true });
        if (callerSignal.aborted) onAbort();
      }
      try {
        const execution = Promise.resolve().then(() => {
          if (termination) throw termination;
          return operation(controller.signal);
        });
        return await Promise.race([execution, cancellation]);
      } catch (error) {
        throw termination || error;
      } finally {
        clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener('abort', onAbort);
      }
    }

    async function getJson(path, signal) {
      let response;
      try {
        response = await fetch(new URL(path, baseUrl).href, {
          method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', signal
        });
      } catch (error) {
        if (signal.aborted) throw abortError();
        throw new CatalogError('NETWORK', 'Backend-пен байланыс орнамады. Сервер адресін, интернетті және CORS баптауын тексеріңіз.');
      }
      if (!response.ok) {
        let detail;
        try { detail = (await response.json()).detail; } catch (_) { /* Preserve HTTP status. */ }
        throw new CatalogError('HTTP', typeof detail === 'string' ? detail : 'Backend сұранысты орындай алмады (HTTP ' + response.status + ').', response.status);
      }
      try {
        return await response.json();
      } catch (error) {
        if (signal.aborted) throw abortError();
        throw new CatalogError('INVALID_JSON', 'Backend жарамды JSON жауабын қайтармады.');
      }
    }

    async function list(value, options) {
      const page = pageNumber(value === undefined ? 1 : value);
      return request(async signal => {
        if (mode === 'api') {
          const payload = await getJson('products?page=' + page, signal);
          return parsePage(payload, page, settings);
        }
        const failThisRequest = shouldFailFirstList;
        shouldFailFirstList = false;
        await delay(demoScenario === 'slow' ? 1800 : 180, signal);
        if (failThisRequest) throw new CatalogError('NETWORK', 'Демо байланыс қатесі. «Қайта көру» батырмасын басыңыз.');
        const empty = demoScenario === 'empty';
        const items = empty ? [] : DEMO_PRODUCTS.slice((page - 1) * 20, page * 20);
        // Демо деректердің өрістері тұрақты; API mapping баптауы демоны өзгертпейді.
        return parsePage({ data: { page, items, total_pages: empty ? 0 : 2 } }, page);
      }, options && options.signal);
    }

    async function detail(value, options) {
      const id = productId(value, 'CONFIG');
      return request(async signal => {
        let item;
        if (mode === 'api') {
          const payload = await getJson('products/' + encodeURIComponent(id), signal);
          if (!isRecord(payload) || !isRecord(payload.data)) throw schemaError('Backend жауабында data тауар объектісі табылмады.');
          item = normalizeProduct(payload.data, settings);
        } else {
          await delay(demoScenario === 'slow' ? 1800 : 180, signal);
          const raw = DEMO_PRODUCTS.find(product => String(product.id) === id);
          if (!raw) throw new CatalogError('HTTP', 'Демо каталогта бұл тауар табылмады.', 404);
          item = normalizeProduct(raw);
        }
        if (item.id !== id) throw schemaError('Backend сұралған тауардан басқа id қайтарды.');
        return item;
      }, options && options.signal);
    }

    return Object.freeze({ list, detail });
  }

  root.CatalogData = Object.freeze({ createService, normalizeProduct, parsePage, safeHttpUrl });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.CatalogData;
})(globalThis);
