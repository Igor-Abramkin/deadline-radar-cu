import { escape } from "./format.mjs";

// The page behind PUBLIC_URL: one-tap subscribe links and the plain feed
// address for calendars without a subscribe link.
export function subscribePage(feedUrl) {
  const webcal = feedUrl.replace(/^https?:/, "webcal:");
  const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
  const url = escape(feedUrl);
  return `<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Дедлайны ЦУ в календаре</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; color: #1a1a1a; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  p { color: #555; }
  a.button { display: block; padding: .8rem 1rem; margin: .5rem 0; border-radius: .6rem; background: #f2f2f2; color: inherit; text-decoration: none; font-weight: 600; }
  a.button:hover { background: #e6e6e6; }
  input { width: 100%; box-sizing: border-box; padding: .6rem; font: inherit; border: 1px solid #ccc; border-radius: .5rem; }
  li { margin: .35rem 0; }
</style>
<h1>Дедлайны ЦУ в календаре</h1>
<p>Все дедлайны из LMS. Календарь обновляется сам: новые задания и переносы появятся без повторной подписки.</p>
<a class="button" href="${escape(webcal)}">Apple Календарь, Outlook</a>
<a class="button" href="${escape(google)}">Google Календарь</a>
<p>Или скопируй адрес и добавь его в календарь как подписку по ссылке:</p>
<input readonly value="${url}" onclick="this.select()">
<ul>
  <li><b>Яндекс Календарь:</b> «Новый календарь» → «Подписаться на календарь», вставить адрес.</li>
  <li><b>Google:</b> Другие календари → «+» → «Добавить по URL». Google перечитывает подписки раз в несколько часов, свежие переносы видны в боте раньше.</li>
</ul>
</html>
`;
}
