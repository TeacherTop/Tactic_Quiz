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

## Настройки игры с ботами

Кнопка «Битва умов» открывает отдельный экран. Сложность, число соперников,
размер карты и выбранные темы автоматически сохраняются в `quiz-bot-settings-v1`.
По умолчанию: средний уровень, два бота, 19 сот, все доступные категории.

Загрузчик читает JSON из `question_bank`, включая `question_text` и `question_num`.
Темы объединяются по полю `category`, без разделения в интерфейсе по типу вопроса.
Для числовых дуэлей используются числовые вопросы выбранных тем; при их отсутствии
можно использовать вопросы тех же тем с числовым эталоном. Если и таких вопросов
нет, последняя сота разыгрывается обычным вопросом, а при двух правильных ответах
в битве защитник удерживает территорию. Вопросы вне выбранных тем не подмешиваются.

Параметры фиксируются в состоянии при старте матча. Карты имеют радиус 1, 2 или 3
(7, 19 и 37 сот); при одном сопернике участвуют только игрок и Алекс.
