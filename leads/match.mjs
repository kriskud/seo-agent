// Отбор заказов под услуги iamonline: Telegram-боты, Mini Apps, CRM, SaaS, лендинги.
// Регэкспы, а не LLM: дёшево, предсказуемо, легко поправить руками.

export const SERVICES = {
  bot: /(телеграм|telegram|\bтг\b|\btg\b)[\s-]*(бот|bot)|чат-?бот|chat ?bot|\bбот[а-я]*\b.{0,30}\b(тг|телеграм|telegram|записи|заявок|оплат)|telegram bot/i,
  miniApp: /mini ?app|мини[- ]?ап|web ?app.{0,20}(telegram|телеграм)|приложени[а-я]* (в|для|внутри) (телеграм|telegram|тг)/i,
  crm: /\bcrm\b|\bсрм\b|\bцрм\b|уч[её]т(а|ом)? (клиентов|заявок|записей)|онлайн-?запис|запис[ьи] клиентов|личн(ый|ого) кабинет/i,
  saas: /\bsaas\b|сервис (по|с) подписк|подписочн(ый|ого) сервис|subscription (app|service|platform)/i,
  site: /лендинг|landing ?page|сайт-?визитк|одностраничн|сайт для (услуг|компании|мастера|салона|студии|эксперта|курса)|(создать|сделать|разработ[а-я]*|нужен|требуется) (сайт|лендинг)|(сайт|лендинг) (с нуля|под ключ)/i,
};

// Не наш профиль или то, за что Кристина не берётся (спам, накрутки, CMS-подряды).
export const EXCLUDE = /парс(инг|ер|ить)|накрут|инвайт|спам|рассылк[а-я]* в лс|арбитраж|казино|ставк[аи] на (спорт|матч)|букмекер|\bкрипт(о|овалют)|airdrop|nft|\b1с\b|битрикс|bitrix|wordpress|\bwp\b|тильд|tilda|opencart|wix|флуд|ботоферм|фарм[а-я]* аккаунт|\bсмм\b|\bsmm\b|нужен (ux\/ui[- ]|веб-)?дизайнер|ux\/ui[- ]дизайнер|отзыв[а-я]* на|выкуп|\bпродам\b|\bfor sale\b|\[for hire\]/i;

export function matchServices(text) {
  return Object.entries(SERVICES).filter(([, rx]) => rx.test(text)).map(([k]) => k);
}

/** Бюджет из строки: «Бюджет: 6 000 ₽», «до 50000 руб», «$500», «500 usd». */
export function parseBudget(text) {
  const t = text.replace(/&#8381;|₽/g, ' руб').replace(/ /g, ' ');
  const rub = /(?:бюджет|до|от|цена|оплата)?[:\s]*([\d][\d\s]{2,9})\s*(?:руб|р\.|rub)/i.exec(t);
  if (rub) return { amount: Number(rub[1].replace(/\s/g, '')), currency: 'RUB' };
  const usd = /\$\s*([\d][\d,]{1,7})|([\d][\d,]{1,7})\s*(?:usd|\$)/i.exec(t);
  if (usd) return { amount: Number((usd[1] ?? usd[2]).replace(/,/g, '')), currency: 'USD' };
  return null;
}

/** Подходит ли заказ: есть услуга, нет стоп-слов, бюджет не ниже порога (если известен). */
export function qualify(lead, config) {
  const text = `${lead.title}\n${lead.text}`;
  if (EXCLUDE.test(text)) return null;
  const services = matchServices(text);
  if (!services.length) return null;
  const budget = lead.budget ?? parseBudget(text);
  if (budget) {
    const min = budget.currency === 'USD' ? config.minBudgetUsd : config.minBudgetRub;
    if (budget.amount > 0 && budget.amount < min) return null;
  }
  return { ...lead, services, budget };
}
