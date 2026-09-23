const normalize = text => text.toLocaleLowerCase().trim().replace(/[.!?]+$/u, '').trim();

// Exact confirmations only: a purchase request is never a confirmation.
export function recognize(text) {
  const t = normalize(text);
  if (/^(иә|ия|да|растаймын|подтверждаю)([, ]+(себетке қос|добавь в корзину))?$/u.test(t)) return { intent: 'confirm' };
  if (/^(жоқ|жок|нет|бас тартамын|отмена|қоспа|не добавляй)$/u.test(t)) return { intent: 'cancel' };
  const qty = t.match(/(?:^|\s)(\d+)\s*(?:дана|шт(?:ук[аи]?)?)(?:\s|$)/u);
  const quantity = qty ? Number(qty[1]) : null;
  const productId = t.match(/(?:id|артикул)\s*[:#]?\s*(\d+)/u)?.[1];
  const entities = { quantity, productId: productId ? Number(productId) : null };
  if (/себетке өт|себетті аш|рәсімде|оформить|открой корзину|перейти.*корзин/u.test(t)) return { intent: 'checkout', ...entities };
  if (/төлем|жеткізу|минимал|мин\.? партия|ең аз партия|оплат|доставк/u.test(t)) return { intent: 'purchase_terms', ...entities };
  if (/аналог|балама|ұқсас|альтернатив/u.test(t)) return { intent: 'alternatives', ...entities };
  if (/сертификат|сипаттама|характеристик|баға|бағасы|цена|қанша тұрады|қалдық|остаток|кернеу|вольт|қуат|мощност/u.test(t)) {
    const field = /сертификат/u.test(t) ? 'certificate_url' : /баға|цена|тұрады/u.test(t) ? 'price' : /қалдық|остаток/u.test(t) ? 'stock' : /кернеу|вольт/u.test(t) ? 'voltage' : /қуат|мощност/u.test(t) ? 'power' : 'attributes';
    return { intent: 'product_info', field, ...entities };
  }
  if (/себетке қос|добав.*корзин|дана.*керек|шт.*нуж|одан.*қос|қосшы/u.test(t) || (quantity !== null && /керек|нуж|қос|добав/u.test(t))) return { intent: 'cart_request', ...entities };
  if (/ізде|тауып|табу|керек|найди|найти|ищу|нужен|нужна|бар ма/u.test(t)) return { intent: 'search', query: text, ...entities };
  return { intent: 'fallback', ...entities };
}
