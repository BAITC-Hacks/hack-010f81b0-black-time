const normalize = text => text.toLocaleLowerCase().trim().replace(/[.!?]+$/u, '').trim();

// Used only to distinguish a new named item from contextual "add 5 of it".
function cartTarget(text) {
  return text.replace(/(?:^|\s)\d+\s*(?:дана|шт(?:ук[аи]?)?)(?=\s|$)/gu, ' ')
    .replace(/(?:маған|мне|одан|осыдан|оның|оны|этого|его|это|этот|товар|тауар|пожалуйста|керек|нуж(?:но|ен|на)|себетке|корзину|добав[\p{L}]*|қос[\p{L}]*|\bв\b)/giu, ' ')
    .replace(/(?:^|\s)в(?=\s|$)/gu, ' ').replace(/[,:;.!?]/gu, ' ').trim();
}
function infoTarget(text) {
  return text.replace(/[,:;.!?]/gu, ' ').split(/\s+/u)
    .filter(word => word && !/^(?:сертификат[\p{L}]*|сипаттама[\p{L}]*|характеристик[\p{L}]*|описани[\p{L}]*|баға[\p{L}]*|цена|цену|цены|қалдық[\p{L}]*|остат[\p{L}]*|қойма[\p{L}]*|склад[\p{L}]*|кернеу[\p{L}]*|вольт|напряжени[\p{L}]*|қуат[\p{L}]*|мощност[\p{L}]*|наличи[\p{L}]*|қолда|қандай|қанша|тұрады|бар|ма|ме|ба|бе|по|бойынша|мне|маған|оның|оған|одан|осы|осының|тауар[\p{L}]*|товар[\p{L}]*|этого|его|это|этот|на|в|есть|у|ли|какой|какая|какие|сколько|стоит)$/u.test(word))
    .join(' ');
}

// Exact confirmations only: a purchase request is never a confirmation.
export function recognize(text) {
  const t = normalize(text);
  if (/^(иә|ия|да|растаймын|подтверждаю)([, ]+(себетке қос|добавь в корзину))?$/u.test(t)) return { intent: 'confirm' };
  if (/^(жоқ|жок|нет|бас тартамын|отмена|қоспа|не добавляй)$/u.test(t)) return { intent: 'cancel' };
  const qty = t.match(/(?:^|\s)(\d+)\s*(?:дана|шт(?:ук[аи]?)?)(?:\s|$)/u);
  const quantity = qty ? Number(qty[1]) : null;
  const productId = t.match(/(?:^|\s)id\s*[:#]?\s*(\d+)/u)?.[1];
  const sku = t.match(/(?:артикул|sku)\s*[:#]?\s*([\p{L}\d._-]+)/u)?.[1];
  const entities = { quantity, productId: productId ? Number(productId) : null, sku: sku ?? null };
  if (/себетке өт|себетті аш|рәсімде|оформить|открой корзину|перейти.*корзин/u.test(t)) return { intent: 'checkout', ...entities };
  if (/төлем|жеткізу|минимал|мин\.? партия|ең аз партия|оплат|доставк|шарттар|условия покупки/u.test(t)) {
    const terms = [];
    if (/төлем|оплат/u.test(t)) terms.push('payment');
    if (/жеткізу|доставк/u.test(t)) terms.push('delivery');
    if (/минимал|мин\.? партия|ең аз партия/u.test(t)) terms.push('minimum_order');
    return { intent: 'purchase_terms', terms: terms.length ? terms : ['payment', 'delivery', 'minimum_order'], ...entities };
  }
  if (/аналог|балама|ұқсас|альтернатив/u.test(t)) return { intent: 'alternatives', ...entities };
  if (/сертификат|сипаттама|характеристик|описани|баға|бағасы|цена|қанша тұрады|сколько стоит|қалдық|остаток|кернеу|вольт|напряжени|қуат|мощност|наличи|қолда бар/u.test(t)) {
    const field = /сертификат/u.test(t) ? 'certificate_url' : /баға|цена|тұрады|сколько стоит/u.test(t) ? 'price' : /қалдық|остаток/u.test(t) ? (/қойма|склад/u.test(t) ? 'warehouse_stocks' : 'stock') : /наличи|қолда бар/u.test(t) ? 'availability' : /кернеу|вольт|напряжени/u.test(t) ? 'voltage' : /қуат|мощност/u.test(t) ? 'power' : /описани/u.test(t) ? 'description' : /сипаттама/u.test(t) ? 'details' : 'attributes';
    return { intent: 'product_info', target: infoTarget(t), field, ...entities };
  }
  if (/себетке қос|добав.*корзин|дана.*керек|шт.*нуж|одан.*қос|қосшы/u.test(t) || (quantity !== null && /керек|нуж|қос|добав/u.test(t)) || /^\d+\s*(?:дана|шт(?:ук[аи]?)?)$/u.test(t)) return { intent: 'cart_request', target: cartTarget(t), ...entities };
  if (/ізде|тауып|табу|керек|найди|найти|ищу|нужен|нужна|бар ма/u.test(t)) return { intent: 'search', query: text, ...entities };
  // Explicit references are resolved against session IDs/SKUs by the reducer.
  if (entities.productId || entities.sku) return { intent: 'fallback', ...entities };
  if (/^(сәлем|салем|здравствуйте|привет|рахмет|спасибо|hello|hi)$/u.test(t)) return { intent: 'greeting', ...entities };
  // Short catalogue phrases and supplier articles can be pasted without a verb.
  if (/^[\p{L}\d][\p{L}\d\s._/+×*()–-]{0,159}$/u.test(t) && t.split(/\s+/u).length <= 6 && !/есептеп|проект|жоба|игнор|ignore|инструкц|пароль|prompt|system|менеджер|помоги|көмек|көмектес|как|қалай/u.test(t)) return { intent: 'search', query: text, ...entities };
  return { intent: 'fallback', ...entities };
}
