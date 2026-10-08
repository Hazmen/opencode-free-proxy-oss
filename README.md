# [English] opencode-free-proxy

**English** | [Русский](#русская-версия)

A local **OpenAI-compatible** (`/v1/chat/completions`) and **Anthropic-compatible**
(`/v1/messages`) endpoint for [OpenCode](https://opencode.ai) free-tier models —
with **real tool calling**, **reasoning effort**, **image attachments**,
**auto-fetching free models**, and an optional
Windows **tray icon + autostart**.

Point any client at it — Cursor, Continue, Cline, Claude Code, aider, opencode CLI,
Deepseek Harness, raw `curl` — wherever it asks for *Base URL* + *API key*.

> Author's note: "I regret practically vibecoding this, shoulda written the thing myself."
>
> I originally built this for myself and then decided to put it out in the open —
> free models want to be free. Forked from
> [bigdata2211it-web/opencode-free-proxy](https://github.com/bigdata2211it-web/opencode-free-proxy),
> heavily reworked (see *How it works*).

## Prerequisites

1. Node.js ≥ 18
2. [opencode CLI](https://opencode.ai) installed and logged in to Zen (this is what
   carries your free quota — the proxy borrows your login, it never sees your key
   leave your machine):

```bash
npm i -g opencode-ai
opencode auth login   # choose "OpenCode Zen", paste the key from https://opencode.ai/auth
```

## 30-second setup

```bash
git clone <this-repo>.git
cd opencode-free-proxy
npm install
node server.mjs
```

First run in a fresh folder: execute one CLI call there so opencode registers the
project, then start the proxy:

```bash
opencode run "hi" --model opencode/space-bunny-free
node server.mjs
```

Done. Server is at `http://localhost:6446`. API keys live in `api-keys.json`
(auto-generated on first run, git-ignored) — **paste one wherever your client
asks for an API key.**

## Free models (auto-fetched)

On startup (and every 6h after) the proxy reads the public Zen catalog
(`GET https://opencode.ai/zen/v1/models`, no auth needed) and serves every free
model it finds (`*-free` + `big-pickle`, minus a small denylist). **New free
models appear in `GET /v1/models` automatically — no proxy update needed.**
If the fetch fails (offline), the baked-in list below is used.

Baked-in fallback (verified working at release time):

| Model | Notes |
|-------|-------|
| `muse-spark-1.3-contributor-free` | Recommended daily driver, 1M context |
| `big-pickle` | Stealth, free for a limited time |
| `space-bunny-free` | Stealth, free for a limited time |
| `mimo-v2.6-flash-free` | 200k context |
| `ling-3.0-flash-fin-free` | 262k context |
| `ling-3.1-flash-free` | 262k context |
| `longcat-2.5-preview-free` | Preview |
| `nemotron-3-ultra-free` | NVIDIA |
| `nemotron-3.5-lightning-free` | NVIDIA |
| `fledge-alpha-free` | Alpha, region-locked in some countries |

Known-excluded: `jev-1.13-free` (different upstream endpoint, errors server-side),
`mimo-v2.5-free` (deprecated upstream). Override with `MODEL_DENYLIST=""` if you
want to try them anyway.

## API

### OpenAI — `POST /v1/chat/completions`

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

Tool calling (standard loop — model requests, **your client executes locally**,
results go back):

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "messages": [{"role": "user", "content": "Weather in Paris?"}],
    "tools": [{"type": "function", "function": {
      "name": "get_weather",
      "description": "Get weather for a city",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
    }}]
  }'
```

### Anthropic — `POST /v1/messages`

```bash
curl http://localhost:6446/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "system": "You are helpful.",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

`tool_use` / `tool_result` blocks are supported in both directions.

### Reasoning effort

Pass OpenAI-style `reasoning_effort` (or `{ "reasoning": { "effort": ... } }`) —
the proxy maps it to the model's native `--variant` flag. Supported values
depend on the model (see `VARIANTS` in `server.mjs`, sourced from
`opencode models opencode --verbose`); unknown values return HTTP 400 listing
what the model accepts. Example: `"reasoning_effort": "high"`.

### Images

Vision works through attachments: OpenAI `image_url` (base64 `data:` URLs) and
Anthropic `image` blocks are saved to temp files and handed to the model via
`opencode run --file`. Remote URLs can't be fetched by the proxy and are passed
as URL-only placeholders (max 4 noted in the prompt).

### Other endpoints

| Method | Path | What |
|--------|------|------|
| `GET` | `/v1/models` | List models (auto-fetched) |
| `GET` | `/health` | Health + version + backend |

### Auth

`Authorization: Bearer KEY` and `x-api-key: KEY` both work everywhere.
KEY = any value from your local `api-keys.json`.

## Client setups

### Any OpenAI-compatible client (Cursor / Continue / Cline / aider / ...)

- Base URL: `http://localhost:6446/v1` (or `http://YOUR_HOST:6446/v1` over LAN)
- API Key: from `api-keys.json`
- Model: e.g. `muse-spark-1.3-contributor-free`

### opencode CLI as a client

`~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "free": {
      "name": "free",
      "type": "openai",
      "apiKey": "YOUR_KEY",
      "baseURL": "http://localhost:6446/v1",
      "models": {
        "free/muse-spark-1.3-contributor-free": {
          "id": "muse-spark-1.3-contributor-free",
          "name": "free/muse-spark-1.3-contributor-free",
          "attachment": true,
          "reasoning": true
        }
      }
    }
  }
}
```

### Claude Code (Anthropic format)

- Base URL: `http://YOUR_HOST:6446`, key from `api-keys.json`, uses `/v1/messages`.

## Windows: tray + autostart (optional)

- Double-click `start-hidden.vbs` — proxy starts with a tray icon
  (status, restart, open keys, exit). No hardcoded paths — fully portable.
- For autostart: create a shortcut to `start-hidden.vbs` in `shell:startup`.

## Deploy on a VPS

```bash
git clone <this-repo>.git
cd opencode-free-proxy
npm install
node server.mjs            # foreground
# or
nohup node server.mjs > proxy.log 2>&1 &   # background
```

systemd unit:

```ini
# /etc/systemd/system/opencode-proxy.service
[Unit]
Description=OpenCode Free Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-proxy
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=PROXY_PORT=6446

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now opencode-proxy
```

## Environment variables

| Variable | Default | What |
|----------|---------|------|
| `PROXY_PORT` | `6446` | Server port |
| `KEYS_FILE` | `./api-keys.json` | Proxy API keys file |
| `OPENCODE_BIN` | auto-detected | Path to the opencode binary |
| `CLI_WORKDIR` | proxy dir | Directory the CLI runs in (must be an opencode project) |
| `CLI_TIMEOUT_MS` | `240000` | Per-request CLI timeout |
| `ZEN_MODELS_URL` | `https://opencode.ai/zen/v1/models` | Catalog URL for auto-fetch |
| `MODELS_REFRESH_MS` | `21600000` (6h) | Re-fetch interval, `0` disables |
| `MODEL_DENYLIST` | `jev-1.13-free,mimo-v2.5-free` | Comma-separated ids to hide |

## How it works

```
Your client ── OpenAI/Anthropic, key from api-keys.json ──► proxy
                                                              │ spawns genuine
                                                              │ `opencode run`
                                                              ▼
                                                     opencode.ai/zen (your login/quota)
```

Why a CLI backend instead of plain HTTPS forwarding? Since ~Sep 2026 the
anonymous Zen lane is rejected with
`FreeTierError: free tier can only be used from within OpenCode` — no header
combination passes (verified against opencode sources, exact UA/ids/project,
Node/Bun transports, HTTP/1.1+2). Executing requests through the genuine CLI
binary is what passes the gate. Consequences: ~10–20s latency per request and
replayed (not live) streaming.

Tool calling: your `tools` schemas are forwarded as definitions, the model
requests calls, the proxy returns standard `tool_calls`/`tool_use` — execution
stays on your side. The CLI's own shell tools are never exposed to clients.
Every CLI run goes through the prompt-only `proxy-bridge` agent
(`.opencode/agents/proxy-bridge.md`, auto-created on start): the model is told
to never touch its native tools — they act on the wrong directory and get
permission-rejected — and to emit fenced `tool_call` blocks with exact
snake_case keys instead. (Disabling native tools via permission config is not
possible: any agent with `permission: deny` makes Zen answer 403.)

## Privacy

Your Zen key never leaves your machine (read from opencode's own `auth.json`
only by the local CLI process). `api-keys.json` / `cli-sessions.json` are
git-ignored. The proxy dials only `opencode.ai`.

## License

MIT

---

<a id="русская-версия"></a>
# [Русский] opencode-free-proxy

**[English](#opencode-free-proxy)** | **Русский**

Локальный **OpenAI-совместимый** (`/v1/chat/completions`) и
**Anthropic-совместимый** (`/v1/messages`) endpoint для бесплатных моделей
[OpenCode](https://opencode.ai) — с **настоящим tool calling**, **уровнем мышления**, **аттачментами картинок**,
**автоподтягиванием бесплатных моделей** и опциональной иконкой в трее Windows
+ автозапуском.

Подключается любой клиент — Cursor, Continue, Cline, Claude Code, aider,
opencode CLI, Deepseek Harness, голый `curl` — везде, где просят *Base URL* +
*API key*.

> Заметка автора: "I regret practically vibecoding this, shoulda written the thing myself."
>
> Изначально делал для себя, потом решил выложить в открытый доступ —
> бесплатные модели должны быть бесплатными. Форк
> [bigdata2211it-web/opencode-free-proxy](https://github.com/bigdata2211it-web/opencode-free-proxy),
> сильно переработан (см. *Как это работает*).

## Требования

1. Node.js ≥ 18
2. Установленный и залогиненный в Zen [opencode CLI](https://opencode.ai)
   (именно он везёт твою бесплатную квоту — прокси пользуется твоим логином,
   ключ никуда с машины не уходит):

```bash
npm i -g opencode-ai
opencode auth login   # выбери "OpenCode Zen", вставь ключ с https://opencode.ai/auth
```

## Установка за 30 секунд

```bash
git clone <this-repo>.git
cd opencode-free-proxy
npm install
node server.mjs
```

Первый запуск в новой папке: выполни там один вызов CLI, чтобы opencode
зарегистрировал проект, потом стартуй прокси:

```bash
opencode run "hi" --model opencode/space-bunny-free
node server.mjs
```

Готово. Сервер на `http://localhost:6446`. API-ключи лежат в `api-keys.json`
(создаётся сам при первом старте, в git не идёт) — **его и вставляй везде, где
клиент просит API key.**

## Бесплатные модели (автофетч)

На старте (и дальше каждые 6 часов) прокси читает публичный каталог Zen
(`GET https://opencode.ai/zen/v1/models`, без авторизации) и отдаёт все
найденные бесплатные модели (`*-free` + `big-pickle`, минус небольшой denylist).
**Новые бесплатные модели появляются в `GET /v1/models` сами — обновлять прокси
не нужно.** Если fetch упал (офлайн), используется вшитый список ниже.

Вшитый запасной список (работоспособность проверена на момент релиза):

| Модель | Заметки |
|--------|---------|
| `muse-spark-1.3-contributor-free` | Основная на каждый день, контекст 1M |
| `big-pickle` | Стелс, бесплатна ограниченное время |
| `space-bunny-free` | Стелс, бесплатна ограниченное время |
| `mimo-v2.6-flash-free` | Контекст 200k |
| `ling-3.0-flash-fin-free` | Контекст 262k |
| `ling-3.1-flash-free` | Контекст 262k |
| `longcat-2.5-preview-free` | Preview |
| `nemotron-3-ultra-free` | NVIDIA |
| `nemotron-3.5-lightning-free` | NVIDIA |
| `fledge-alpha-free` | Alpha, в части стран недоступна |

Исключены заведомо: `jev-1.13-free` (другой endpoint, сервер отдаёт ошибку),
`mimo-v2.5-free` (deprecated). Хочешь попробовать anyway —
`MODEL_DENYLIST=""`.

## API

### OpenAI — `POST /v1/chat/completions`

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

Вызов инструментов (стандартный цикл — модель просит, **исполняет твой клиент
локально**, результаты возвращаются):

```bash
curl http://localhost:6446/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "messages": [{"role": "user", "content": "Weather in Paris?"}],
    "tools": [{"type": "function", "function": {
      "name": "get_weather",
      "description": "Get weather for a city",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
    }}]
  }'
```

### Anthropic — `POST /v1/messages`

```bash
curl http://localhost:6446/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "muse-spark-1.3-contributor-free",
    "system": "You are helpful.",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 1024,
    "stream": true
  }'
```

Блоки `tool_use` / `tool_result` поддерживаются в обе стороны.

### Уровень мышления (reasoning effort)

Передай OpenAI-стиль `reasoning_effort` (или `{ "reasoning": { "effort": ... } }`) —
прокси смаппит его в нативный флаг модели `--variant`. Допустимые значения зависят
от модели (см. `VARIANTS` в `server.mjs`, источник — `opencode models opencode --verbose`);
неизвестные вернут HTTP 400 со списком допустимых. Пример: `"reasoning_effort": "high"`.

### Картинки

Vision работает через аттачменты: OpenAI `image_url` (base64 `data:`) и Anthropic-блоки
`image` сохраняются во временные файлы и уходят модели через `opencode run --file`.
Удалённые URL прокси скачать не может — уходят плейсхолдером (первые 4 — текстом в промпте).

### Остальные endpoint'ы

| Метод | Путь | Что |
|-------|------|-----|
| `GET` | `/v1/models` | Список моделей (автофетч) |
| `GET` | `/health` | Health + версия + backend |

### Авторизация

`Authorization: Bearer KEY` и `x-api-key: KEY` работают везде.
KEY = любое значение из локального `api-keys.json`.

## Настройка клиентов

### Любой OpenAI-совместимый клиент (Cursor / Continue / Cline / aider / ...)

- Base URL: `http://localhost:6446/v1` (по сети — `http://YOUR_HOST:6446/v1`)
- API Key: из `api-keys.json`
- Модель: например `muse-spark-1.3-contributor-free`

### opencode CLI как клиент

`~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "free": {
      "name": "free",
      "type": "openai",
      "apiKey": "YOUR_KEY",
      "baseURL": "http://localhost:6446/v1",
      "models": {
        "free/muse-spark-1.3-contributor-free": {
          "id": "muse-spark-1.3-contributor-free",
          "name": "free/muse-spark-1.3-contributor-free",
          "attachment": true,
          "reasoning": true
        }
      }
    }
  }
}
```

### Claude Code (формат Anthropic)

- Base URL: `http://YOUR_HOST:6446`, ключ из `api-keys.json`, endpoint `/v1/messages`.

## Windows: трей + автозапуск (опционально)

- Двойной клик по `start-hidden.vbs` — прокси стартует с иконкой в трее
  (статус, рестарт, ключи, выход). Хардкодов путей нет — полностью портативно.
- Для автозапуска: ярлык на `start-hidden.vbs` в `shell:startup`.

## Деплой на VPS

```bash
git clone <this-repo>.git
cd opencode-free-proxy
npm install
node server.mjs            # на переднем плане
# или
nohup node server.mjs > proxy.log 2>&1 &   # фоном
```

systemd-юнит:

```ini
# /etc/systemd/system/opencode-proxy.service
[Unit]
Description=OpenCode Free Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/opencode-proxy
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=PROXY_PORT=6446

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now opencode-proxy
```

## Переменные окружения

| Переменная | Дефолт | Что |
|------------|--------|-----|
| `PROXY_PORT` | `6446` | Порт сервера |
| `KEYS_FILE` | `./api-keys.json` | Файл API-ключей прокси |
| `OPENCODE_BIN` | автоопределение | Путь до бинарника opencode |
| `CLI_WORKDIR` | папка прокси | Папка, в которой работает CLI (должна быть opencode-проектом) |
| `CLI_TIMEOUT_MS` | `240000` | Таймаут одного запроса к CLI |
| `ZEN_MODELS_URL` | `https://opencode.ai/zen/v1/models` | URL каталога для автофетча |
| `MODELS_REFRESH_MS` | `21600000` (6ч) | Интервал перечитывания, `0` — выкл |
| `MODEL_DENYLIST` | `jev-1.13-free,mimo-v2.5-free` | id через запятую, которые скрыть |

## Как это работает

```
Твой клиент ── OpenAI/Anthropic, ключ из api-keys.json ──► прокси
                                                              │ запускает настоящий
                                                              │ `opencode run`
                                                              ▼
                                                     opencode.ai/zen (твой логин/квота)
```

Почему backend на CLI, а не прямая пересылка HTTPS? Примерно с сентября 2026
анонимная Zen-линия режется с
`FreeTierError: free tier can only be used from within OpenCode` — не проходит
вообще никакая комбинация заголовков (проверено по исходникам opencode, точные
UA/id/project, транспорты Node/Bun, HTTP/1.1+2). Гейт проходит только настоящий
CLI-бинарник. Следствия: ~10–20с латентности на запрос и реплей-стриминг
(не живой по токенам).

Tool calling: твои схемы `tools` уходят модели определениями, модель просит
вызовы, прокси отдаёт стандартные `tool_calls`/`tool_use` — исполнение остаётся
на твоей стороне. Шелл-тулзы самого CLI клиентам не светятся. Каждый CLI-запуск
идёт через prompt-only агента `proxy-bridge`
(`.opencode/agents/proxy-bridge.md`, создаётся сам при старте): модели запрещено
трогать нативные тулзы — они бьют по чужой директории и валятся в
permission-rejected — вместо этого она эмитит fenced-блоки `tool_call` с точным
snake_case. (Отключить нативные тулзы конфигом пермишенов нельзя: любой агент с
`permission: deny` получает от Zen 403.)

## Приватность

Твой Zen-ключ не покидает машину (его читает только локальный CLI-процесс из
своего `auth.json`). `api-keys.json` / `cli-sessions.json` в git-игноре. Прокси
стучится только в `opencode.ai`.

## Лицензия

MIT
