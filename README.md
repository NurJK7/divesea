# DiveSea — NFT marketplace (лабораторные №2–№4)

Фронтенд (HTML/CSS/JS) + бэкенд на Node.js (Express) + база данных SQLite.

**Публичная ссылка на сайт:** `https://ВСТАВЬТЕ-ССЫЛКУ-NETLIFY.netlify.app`
**Сервер (API):** `https://ВСТАВЬТЕ-ССЫЛКУ-RENDER.onrender.com/api/health`

## Запуск локально
1. Установи Node.js 22.13 или новее (рекомендуется 24): https://nodejs.org
2. В папке проекта выполни:
   ```
   npm install
   npm start
   ```
3. Открой http://localhost:3000

Настройки лежат в файле `.env` (порт, имя файла базы, CORS, стартовый баланс, cookie). Шаблон: `.env.example`. База `divesea.db` создаётся и заполняется тестовыми данными (8 NFT) автоматически. Для сброса останови сервер и удали файлы `divesea.db*`.

## Структура проекта
```
server.js          сервер Express: REST API, SQLite, таймер лотов
package.json       зависимости и команда запуска (npm start)
.env / .env.example  настройки (секреты не попадают в git)
netlify.toml       публикация клиентской части на Netlify (+ прокси /api на сервер)
render.yaml        публикация сервера на Render
public/            клиентская часть (раздаётся как статика)
  index.html, auth.html, profile.html, create.html, contact.html, about.html, terms.html, privacy.html
  config.js        адрес API (API_URL)
  css/style.css    стили
  js/common.js     общие функции: api() на fetch, уведомления (toast), индикатор загрузки, таймеры
  js/*.js          скрипты страниц (home, auth, profile, create, contact)
  images/          изображения
```

## Работа с API из браузера (Fetch API, async/await)
- Все запросы идут через функцию `api()` в `public/js/common.js`: `fetch` с `async/await`, таймаут 12 секунд.
- Данные для страниц загружаются GET-запросами и отрисовываются динамически; формы (вход, создание NFT, Sell, ставки, контакты) отправляются POST/PATCH/DELETE без перезагрузки страницы.
- Состояния интерфейса:
  - **индикатор загрузки (spinner)** при загрузке списков, а на кнопках на время запроса;
  - **выплывающие уведомления (toast)** при ошибках сети, таймауте и ошибках сервера (`try...catch` в `api()` и в обработчиках);
  - если список не загрузился, вместо пустой страницы показывается сообщение и кнопка **Retry**.

## Схема базы данных

| Таблица | Поля | Назначение |
|---|---|---|
| **users** | `id` INTEGER **PK** AUTOINCREMENT, `username` TEXT UNIQUE, `email` TEXT UNIQUE, `email_verified` INTEGER (0), `salt` TEXT, `password_hash` TEXT, `nickname` TEXT, `avatar` TEXT, `balance` REAL (по умолчанию 10) | пользователи |
| **sessions** | `token` TEXT **PK**, `user_id` INTEGER **FK → users.id** | сессии входа |
| **nfts** | `id` INTEGER **PK** AUTOINCREMENT, `title` TEXT, `image` TEXT, `price` REAL, `buy_now` INTEGER (0/1), `ends_in` TEXT, `owner_id` INTEGER **FK → users.id** (NULL, если не продана), `creator_id` INTEGER **FK → users.id** (NULL у тестовых), `seller_id` INTEGER **FK → users.id** (кто сейчас продаёт; NULL — продажи нет), `ends_at` INTEGER (время окончания лота, мс; NULL — не на продаже), `image` — файл из `images/` или загруженная картинка (data URL, квадрат 400×400) | NFT на маркетплейсе |
| **messages** | `id` INTEGER **PK** AUTOINCREMENT, `user_id` INTEGER **FK → users.id** (NULL, если не вошёл), `name`, `email`, `topic`, `message` TEXT, `created_at` TEXT | сообщения из формы «Contact us» |
| **activity** | `id` INTEGER **PK** AUTOINCREMENT, `user_id` INTEGER **FK → users.id**, `nft_id` INTEGER **FK → nfts.id**, `type` TEXT ('bid', 'buy', 'list', 'sale', 'expired'), `amount` REAL, `created_at` TEXT | ставки и покупки |

Связи:
- users 1 — N nfts по `owner_id` (владелец) и по `creator_id` (создатель);
- users 1 — N activity, nfts 1 — N activity;
- users 1 — N sessions.

## REST API

Базовый адрес: `http://localhost:3000/api`

### CRUD для NFT
| Метод | Путь | Доступ | Описание |
|---|---|---|---|
| GET | `/nfts` | всем | список NFT на продаже. Параметры: `search` (по названию), `type` (`instant` / `auction`), `sort` (`oldest`, `newest`, `price_asc`, `price_desc`); неверное значение → 400 |
| GET | `/nfts/:id` | всем | одна NFT по ID (404, если нет) |
| POST | `/nfts` | вошедший | создать NFT: `{ "title", "image", "price", "buy_now", "duration" }` → 201 (`duration` — минуты: 1, 5, 60, 1440 (по умолчанию), 4320). Копии запрещены: то же название (без учёта регистра) или та же картинка → 409 |
| PATCH | `/nfts/:id` | продавец | изменить свой активный лот: `title` (только создатель), `price`, `buy_now`. 403 — чужой, 409 — цена/тип после ставок или такое название уже есть |
| DELETE | `/nfts/:id` | продавец | удалить свой непроданный NFT → 204 (если NFT куплен и выставлен повторно — снимает с продажи) |

### Остальное
| Метод | Путь | Описание |
|---|---|---|
| POST | `/register`, `/login`, `/logout` | регистрация (username, email, password), вход, выход |
| GET / PATCH | `/me` | профиль, смена ника и фото |
| GET | `/me/collection`, `/me/activity`, `/me/listings` | мои NFT, история, мои объявления |
| GET | `/nfts/:id/bids` | история ставок |
| POST | `/nfts/:id/bid`, `/nfts/:id/buy` | ставка, мгновенная покупка |
| POST | `/nfts/:id/sell` | выставить купленный NFT на продажу заново: `{ "price", "buy_now", "duration" }` |
| GET | `/health` | проверка, что сервер работает |
| POST | `/contact` | сообщение из формы «Contact us» (сохраняется в таблицу `messages`) |

### Примеры (curl)
```
curl http://localhost:3000/api/nfts
curl "http://localhost:3000/api/nfts?search=sun&type=instant&sort=price_desc"
curl http://localhost:3000/api/nfts/3

curl -c cookie.txt -H "Content-Type: application/json" -d '{"username":"alice","email":"alice@mail.com","password":"secret1"}' http://localhost:3000/api/register
curl -b cookie.txt -H "Content-Type: application/json" -d '{"title":"My art","image":"nft-blue.png","price":2.5,"buy_now":true}' http://localhost:3000/api/nfts
curl -b cookie.txt -X PATCH -H "Content-Type: application/json" -d '{"price":3}' http://localhost:3000/api/nfts/9
curl -b cookie.txt -X DELETE http://localhost:3000/api/nfts/9
```
В `image` можно передать файл из `images/` (`nft-orange.svg`, `nft-blue.png`, `nft-pink.png`, `nft-white.png`) или свою картинку как data URL (JPEG/PNG/WebP, квадрат 400×400, до ~300 КБ).

## CORS и .env
- CORS настроен через пакет `cors`: разрешены только источники из `CORS_ORIGIN` в `.env`.
- Все настройки подключения вынесены в `.env` (загружаются пакетом `dotenv`).

## Таймер лотов
- При создании NFT и при Sell выбирается время листинга: 1 минута, 5 минут, 1 час, 24 часа или 3 дня.
- Когда время вышло, сервер сам завершает лот (проверка перед каждым запросом к API и раз в 5 секунд):
  - **аукцион со ставками** — NFT получает самая высокая ставка, у которой хватает денег (если у лучшего ставщика не хватает, переходит к следующему); деньги списываются у покупателя и идут продавцу;
  - **никто не купил** — NFT возвращается продавцу в коллекцию (в активности запись «expired»);
  - **тестовые лоты площадки** без продавца продлеваются на 24 часа.
- Страница показывает живой обратный отсчёт и сама обновляет списки, когда время лота вышло.

## Публикация (деплой)
Клиентская часть — **Netlify** (папка `public`), сервер с базой — **Render**. Netlify проксирует запросы `/api/*` на Render (правило в `netlify.toml`), поэтому браузер видит один домен и вход по cookie работает.

1. Загрузить проект в репозиторий GitHub (без `.env` и `divesea.db` — они в `.gitignore`).
2. **Render:** New → Blueprint (или Web Service), выбрать репозиторий. Настройки возьмутся из `render.yaml`. В переменную `CORS_ORIGIN` вписать адрес сайта на Netlify.
3. В `netlify.toml` заменить `REPLACE-WITH-YOUR-APP.onrender.com` на адрес сервера на Render.
4. **Netlify:** Add new site → Import from Git, выбрать тот же репозиторий (папка публикации `public` берётся из `netlify.toml`).
5. Вписать полученные ссылки в начало этого файла.

Примечание: на бесплатном тарифе Render сервер «засыпает» при простое (первый запрос идёт около минуты), а файл базы после перезапуска сбрасывается — тестовые данные создаются заново.
