// Отбор заказов под услуги iamonline: Telegram-боты, Mini Apps, CRM, SaaS, лендинги.
// Регэкспы, а не LLM: дёшево, предсказуемо, легко поправить руками.

const WORD = '[\\p{L}\\p{N}_]';

/**
 * Регэксп с границей слова, которая видит кириллицу. ASCII-`\b` для «тг» или
 * «срм» не срабатывает (кириллица для него не словесный символ), поэтому `\b`
 * здесь разворачивается в «с одной из сторон не буква и не цифра».
 */
export function unicodeRegex(source, flags = 'iu') {
  return new RegExp(source.replaceAll('\\b', `(?:(?<!${WORD})|(?!${WORD}))`), flags);
}

export const SERVICES = {
  bot: unicodeRegex('(телеграм|telegram|\\bтг\\b|\\btg\\b)[\\s-]*(бот|bot)|чат[- ]?бот|chat ?bot|(разработчик|программист)[а-я]* (телеграм-?|тг-?|чат-?)?бот(а|ов)\\b|(сделать|написать|создать|сделает|напишет) (телеграм-?|тг-?|чат-?)?бот(а)?\\b|\\bбот[а-я]*\\b.{0,30}\\b(тг|телеграм|telegram|записи|заявок|оплат)|telegram bot|whatsapp bot|\\bbot\\b.{0,25}(telegram|booking|orders|payments)'),
  miniApp: unicodeRegex('mini ?app|мини[- ]?ап(п|ы|а|е|ов)?\\b|web ?app.{0,20}(telegram|телеграм)|приложени[а-я]* (в|для|внутри) (телеграм|telegram|тг)|telegram web app'),
  crm: unicodeRegex('\\bcrm\\b|\\bсрм\\b|\\bцрм\\b|уч[её]т(а|ом)? (клиентов|заявок|записей)|онлайн-?запис|запис[ьи] клиентов|личн(ый|ого) кабинет|booking (system|software|app|platform)|appointment (booking|scheduling|system)|scheduling (app|system|software)|client (management|database)'),
  saas: unicodeRegex('\\bsaas\\b|сервис (по|с) подписк|подписочн(ый|ого) сервис|subscription (app|service|platform)|web app(lication)?|internal tool|dashboard for'),
  site: unicodeRegex('лендинг|landing ?page|сайт-?визитк|одностраничн|сайт для (услуг|компании|мастера|салона|студии|эксперта|курса)|(создать|сделать|разработ[а-я]*|нужен|требуется) (сайт|лендинг)|(сайт|лендинг) (с нуля|под ключ)|one[- ]pager|website for'),
};

// Не наш профиль или то, за что Кристина не берётся (спам, накрутки, CMS-подряды).
export const EXCLUDE = unicodeRegex('парс(инг|ер|ить)|накрут|инвайт|спам|рассылк[а-я]* в лс|арбитраж|казино|ставк[аи] на (спорт|матч)|букмекер|\\bкрипт(о|овалют)|airdrop|\\bnft\\b|\\b1с\\b|битрикс|bitrix|wordpress|\\bwp\\b|тильд|tilda|opencart|\\bwix\\b|флуд|ботоферм|фарм[а-я]* аккаунт|\\bсмм\\b|\\bsmm\\b|(нужен|ищем|ищу|требуется|требуются) (ux\\/ui[- ]|веб-|web-|графическ(ий|ого) )?дизайнер|ux\\/ui[- ]дизайнер|моушн-?дизайнер|motion[- ]designer|\\bпродуктовый дизайнер\\b|капч|антидетект|\\brp\\b|аризона|\\bsamp\\b|minecraft|майнкрафт|roblox|роблокс|discord|дискорд|отзыв[а-я]* на|\\bвыкуп\\b|\\bпродам\\b|\\bfor sale\\b|\\[for hire\\]');

// Полная занятость в штат — не проектный заказ, Кристина такое не берёт.
export const VACANCY = unicodeRegex('оформление по тк|\\bтк рф\\b|полная занятост|фултайм|full[- ]?time|график 5\\/2|испытательн(ый|ого) срок|соцпакет|\\bдмс\\b|\\bоклад\\b|\\bз\\/п\\b|зарплат|\\bв штат\\b|\\bвакансия\\b|\\bвакансии\\b|\\bhr\\b|резюме и портфолио присылайте|\\bсобеседовани');

// Реклама и накрутка подписчиков в каналах-«заказниках».
export const PROMO = unicodeRegex('перейти к боту|подпишись|подписывайтесь|подписаться на канал|наш канал|#реклама|реклам(а|ный пост) в канале|промокод|розыгрыш|бесплатн(ый|ая) (вебинар|курс|марафон|интенсив)|приглашаем на курс|набор на обучение|заработок (от|до) \\d|t\\.me\\/\\+');

// «Ищу/нужен/требуется…» — глагол запроса.
const SEEK = '(ищу|ищем|ищет|ищется|нужен|нужна|нужно|нужны|требуется|требуются|подскажите|посоветуйте|порекомендуйте|разыскива[а-я]*|в поиске|кто (может|сможет|сделает|делал|возьм[её]тся)|хочу заказать|готов[ы]? (оплатить|заплатить)|looking for|seeking|need|needed|want to hire|we are hiring|wanted|anyone (know|who can)|can anyone (recommend|build)|recommendations? for)';
// …и то, что ищут. Важно именно соседство: «нужен бот» — наш лид,
// «ищу монтажёра, оплата через бота» — нет.
const OUR_TARGET = '(разработчик|программист|девелопер|developer|freelancer|contractor|engineer|\\bбот\\b|\\bбота\\b|\\bbot\\b|\\bcrm\\b|\\bсрм\\b|mini ?app|мини[- ]?ап|сайт|лендинг|landing|приложени|автоматизаци|web app|подрядчик|исполнител|студи[юя] разработки|команд[уы] разработки|чат-?бот|онлайн-?запис|личный кабинет)';
const NEAR = '[^.!?\\n]{0,60}';

/** Кто-то ищет исполнителя именно под наши услуги. */
export const SEEKING = unicodeRegex(`\\b${SEEK}\\b${NEAR}${OUR_TARGET}`);

// Ищут не разработку: дизайнера, продакта, копирайтера и прочие роли.
// Проверяем связку «глагол запроса + роль», чтобы не выбросить заказ вида
// «нужен бот для менеджеров по продажам».
export const NOT_OUR_ROLE = unicodeRegex(`\\b${SEEK}\\b[^.!?\\n]{0,30}(дизайнер|designer|продакт|проджект|project manager|product manager|аналитик|копирайтер|редактор|таргетолог|маркетолог|монтаж[её]р|видеограф|фотограф|рекрутер|менеджер по продажам|менеджер проект|оператор|бухгалтер|юрист|тестировщик|\\bqa\\b|devops|\\bsre\\b|системн(ый|ого) администратор|сисадмин|преподавател|методист|куратор|модератор|ассистент|продюсер)`);

// Исполнитель предлагает себя — такое в лиды не берём.
export const OFFERING = unicodeRegex('ищу (работу|заказы|проекты|подработку)|мо[ие] услуги|мо[её] портфолио|\\bрезюме\\b|возьмусь за|сделаю (бота|сайт|лендинг|crm)|разработаю (бота|сайт|лендинг)|(разработка|создание)[^.\\n]{0,40}от \\d[\\d\\s]*(₽|руб)|под ключ от \\d|(когда|кому|зачем|почему|нужен ли|как сильно|насколько)[^.!?\\n]{0,30}нуж(ен|на|но|ны) (чат-?|телеграм-?)?(бот|crm|сайт|лендинг)|опыт (работы )?\\d+ (год|года|лет)|\\bprice list\\b|seeking work|seeking freelance\\b|\\bhire me\\b|available for (work|hire|projects)|my (portfolio|rates)|\\bi (can|will) build\\b|\\[for hire\\]');

export function matchServices(text) {
  return Object.entries(SERVICES).filter(([, rx]) => rx.test(text)).map(([k]) => k);
}

/** Текст похож на запрос исполнителя, а не на самопрезентацию фрилансера. */
export function hasIntent(text) {
  return SEEKING.test(text) && !OFFERING.test(text) && !NOT_OUR_ROLE.test(text);
}

/**
 * Бюджет из строки: «Бюджет: 6 000 ₽», «до 50000 руб», «$500», «500 usd».
 * Часовые ставки («$40/hr») бюджетом не считаем: порог проекта к ним не применим,
 * и сравнение отбросило бы нормальный заказ.
 */
export function parseBudget(text) {
  if (/(\d[\d\s,.]*)\s*(?:\$|usd|руб[а-я]*|₽)?\s*(?:\/|за |в |per )\s*(?:hr\b|hour|час|\bч\b)/i.test(text)) return null;
  const t = text.replace(/&#8381;|₽/g, ' руб').replace(/ /g, ' ');
  const rub = /(?:бюджет|до|от|цена|оплата)?[:\s]*([\d][\d\s]{2,9})\s*(?:руб|р\.|rub)/i.exec(t);
  if (rub) return { amount: Number(rub[1].replace(/\s/g, '')), currency: 'RUB' };
  const usd = /\$\s*([\d][\d,]{1,7})|([\d][\d,]{1,7})\s*(?:usd|\$)/i.exec(t);
  if (usd) return { amount: Number((usd[1] ?? usd[2]).replace(/,/g, '')), currency: 'USD' };
  return null;
}

/**
 * Подходит ли заказ: есть услуга, нет стоп-слов, бюджет не ниже порога.
 * Для свободных текстов (`kind: 'post'` — каналы, форумы, выдача поиска)
 * дополнительно требуем намерение «ищу исполнителя»: на биржах это даёт сам
 * формат заказа, а в канале половина сообщений — вакансии и самореклама.
 */
export function qualify(lead, config) {
  const text = `${lead.title}\n${lead.text}`;
  if (EXCLUDE.test(text) || VACANCY.test(text)) return null;
  // intentText — где искать намерение, если текст смешанный: в сниппете
  // выдачи вопрос идёт вперемешку с чужими ответами («если тебе нужен бот…»).
  if (lead.kind === 'post' && (PROMO.test(text) || !hasIntent(lead.intentText ?? text))) return null;
  const services = matchServices(text);
  if (!services.length) return null;
  const budget = lead.budget ?? parseBudget(text);
  if (budget) {
    const min = budget.currency === 'USD' ? config.minBudgetUsd : config.minBudgetRub;
    if (budget.amount > 0 && budget.amount < min) return null;
  }
  return { ...lead, services, budget };
}
