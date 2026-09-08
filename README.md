# Ближе всех

Playable-прототип викторины в духе Triviador: игра с ботами, соло-режим и заготовка мультиплеера через Telegram Mini App.

## Что уже есть

- Vite + React + TypeScript.
- Express + Socket.IO backend для комнат с друзьями.
- Числовой раунд с таймером, ботами, сравнением по абсолютной ошибке и тай-брейком по времени ответа.
- Квиз из пяти случайных вопросов, где порядок хода задаётся результатом числового раунда.
- Очки за числовой раунд, правильность и скорость в квизе.
- Экран раскрытия и финальные результаты с повтором партии.

## Команды

```bash
npm run dev
npm run server
npm run build
npm run lint
npm test
```

Для локального теста мультиплеера без Telegram:

```bash
ALLOW_DEV_AUTH=true npm run server
npm run dev
```

Открой три вкладки:

- `http://127.0.0.1:5173/?devUser=Host`
- `http://127.0.0.1:5173/?devUser=Alex`
- `http://127.0.0.1:5173/?devUser=Marina`

## Деплой Backend

Для реального Telegram нужны публичные HTTPS URL для frontend и backend. Локальный `127.0.0.1` виден только на твоем компьютере.

Backend можно развернуть на Render через `deploy/render.yaml`.

Нужные переменные backend:

- `CLIENT_ORIGIN` - HTTPS URL frontend, например `https://quiz.example.com`.
- `TELEGRAM_BOT_TOKEN` - токен Telegram-бота из BotFather.
- `SUPABASE_URL` - опционально, если нужно сохранять комнаты в Supabase.
- `SUPABASE_SERVICE_ROLE_KEY` - опционально, service-role ключ Supabase.

Нужные переменные frontend:

- `VITE_MULTIPLAYER_API_URL` - HTTPS URL backend, например `https://strategi-quiz-backend.onrender.com`.
- `VITE_TELEGRAM_BOT_USERNAME` - username бота без `@`, чтобы приглашения открывались через `startapp`.

Шаблон переменных лежит в `.env.example`.

## Деплой Frontend

Frontend можно развернуть как статический Vite-сайт. В проекте есть конфиги:

- `vercel.json` для Vercel.
- `netlify.toml` для Netlify.
- `.env.production.example` с переменными frontend.

Порядок деплоя:

1. Разверни backend и получи HTTPS URL, например `https://strategi-quiz-backend.onrender.com`.
2. В frontend-хостинге добавь `VITE_MULTIPLAYER_API_URL` со ссылкой на backend.
3. Добавь `VITE_TELEGRAM_BOT_USERNAME` - username Telegram-бота без `@`.
4. Разверни frontend и получи HTTPS URL.
5. В backend-хостинге обнови `CLIENT_ORIGIN` на HTTPS URL frontend.
6. В BotFather укажи frontend URL как Web App / Mini App URL.

## Соло «Своя игра»

Старое соло с вариантами заменено вводом короткого ответа. Отдельный серверный банк
`server/data/jeopardy.json` содержит 29 376 записей: `id`, `question`, `answer`, `topic`.
Исходный `Russian_QA_Jeopardy_dataset_extended.csv` сохранён без изменений (разделитель — табуляция).
Повторный импорт: `python3 scripts/import-jeopardy.py`. Эталон не отправляется браузеру до проверки/пропуска.
Прогресс сохраняется на устройстве под новым ключом `jeopardy-solo-v1`; старые результаты не смешиваются с новым режимом.
Длинные вопросы и ответы разбиваются на части, доступные кнопками без прокрутки.

Для запуска создайте `.env` в корне (он исключён из Git):

```dotenv
OPENAI_API_KEY=ваш_ключ
OPENAI_JUDGE_MODEL=gpt-4.1-mini
ALLOW_DEV_AUTH=true
PORT=4000
```

Запустите `npm run server` и `npm run dev` в двух терминалах. Если сервер на другом
адресе, задайте `VITE_MULTIPLAYER_API_URL` в конфигурации frontend.
В production задайте `OPENAI_API_KEY`, `OPENAI_JUDGE_MODEL`, `TELEGRAM_BOT_TOKEN` и
`CLIENT_ORIGIN` в окружении backend; `ALLOW_DEV_AUTH` должен быть выключен.
Не используйте префикс `VITE_` для ключа OpenAI: он нужен только серверу.

Точные совпадения проверяются локально на сервере; прочие ответы — через OpenAI
Responses API со строгой JSON-схемой. Модель получает только текущие вопрос, тему,
эталон и введённый ответ, без Telegram-профиля; `store: false`.
Документация протокола: https://developers.openai.com/api/docs/guides/structured-outputs
Без ключа работают загрузка вопросов, точные ответы и «Не знаю»; смысловая проверка
показывает сообщение о недоступности и не изменяет статистику. Отказы, таймауты и
некорректный ответ модели также не считаются ошибкой игрока. `clarify` позволяет
уточнить ответ без раскрытия эталона. Запросы ограничены до 30 в минуту на пользователя,
одновременная проверка — одна. Эти лимиты действуют в рамках одного процесса сервера.

Онлайн и боты не используют этот банк: для них потребуется отдельный `question_bank`
с вариантами. Отсутствие этой папки больше не мешает запуску соло.
Тесты смысловой проверки используют имитацию API; качество реального судейства
нужно проверить после настройки ключа на наборе неоднозначных ответов.
