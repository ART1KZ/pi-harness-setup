# Pi Harness Setup (`pi-harness-setup`)

Полный переносимый сетап окружения **Pi Coding Agent** (`@earendil-works/pi-coding-agent`) со всеми конфигурациями, расширениями, curated skills и шаблонами для быстрой установки на любой новой машине **одной командой**.

> **Важно:** Этот репозиторий относится исключительно к **Pi** (`~/.pi/agent`), а не к OMP (`~/.omp`).
> Все расширения и пакеты устанавливаются **без хардкода версий** (динамически подтягиваются самые свежие версии `@latest` из npm и git).

---

## Быстрая установка одной командой

### Windows (PowerShell)
Запустите в PowerShell:
```powershell
irm https://raw.githubusercontent.com/ART1KZ/pi-harness-setup/main/install.ps1 | iex
```

### Linux & macOS (Bash / Zsh)
Запустите в терминале:
```bash
curl -fsSL https://raw.githubusercontent.com/ART1KZ/pi-harness-setup/main/install.sh | bash
```

---

## Ручная установка (через Git)

```bash
git clone https://github.com/ART1KZ/pi-harness-setup.git
cd pi-harness-setup

# Windows:
.\install.ps1

# Linux / macOS:
./install.sh
```

---

## Что входит в сетап

### 1. Конфигурация Pi (`config/`)
- `settings.json`:
  - Тёмная тема (`dark`).
  - Провайдер по умолчанию: `opencode-go`, модель: `deepseek-v4.1-flash`.
  - Уровень мышления: `max`.
  - Доверие к проектам: `always`.
  - Телеметрия установки отключена (`enableInstallTelemetry: false`).
  - Список пакетов без привязки к номерам версий (`npm:package-name`).
  - Фильтрация встроенных skills (`!**/using-superpowers/**`).
- `models.json`:
  - Кастомный провайдер `opencode-go` с моделью `union-alpha` (контекст 262k, max tokens 131k, Anthropic Messages API, reasoning).
- `AGENTS.md`:
  - Глобальные инструкции для агента: дуальный поиск (Perplexity Pro + OpenAI Responses Web Search), приоритизация Perplexity для широкого поиска, правила стоимости, RTK-оптимизация и Context7 MCP.
- `web-search.json`:
  - Настройки `pi-web-access` (dual search, fetch answer via `gpt-5.6-luna`).
- `mcp-onboarding.json`:
  - Конфиг онбординга MCP-адаптера.
- `auth.example.json`:
  - Шаблон авторизации для API-ключей провайдеров.

### 2. Пакеты и Расширения Pi (`packages` в `settings.json`)
Все пакеты устанавливаются через `pi install` и всегда получают последние версии:
- `npm:pi-perplexity` — интеграция поиска Perplexity Pro.
- `npm:pi-web-access` — многофункциональный веб-поиск и извлечение контента.
- `npm:@narumitw/pi-usage` — отслеживание использования токенов и расходов.
- `npm:pi-mcp-adapter` — адаптер протокола MCP (Model Context Protocol).
- `npm:pi-rtk-optimizer` — интеграция и сжатие вывода терминала через RTK.
- `npm:pi-subagents` — запуск автономных фоновых субагентов.
- `npm:pi-background-tasks` — управление фоновыми процессами и задачами.
- `https://github.com/ART1KZ/omp-antigravity-pro` — Google Antigravity OAuth и failover провайдер.

### 3. Кастомные локальные расширения (`extensions/`)
- `secret-guard/` (`index.ts`, `ssh-key-use.ts`):
  - Позволяет агенту безопасно использовать секреты без риска утечки их значений в контекст модели, файлы сессий или логи.
  - Редактирование вывода инструментов (exact, base64, URL-encoded, hex).
  - Блокировка чтения файлов с ключами и аутентификацией (`auth.json`, `.ssh`, `.aws`, `.env`).
  - Разрешает использование SSH-ключей (`ssh -i`, `scp -i`, `ssh-add`) без возможности их прямого чтения агентом.
- `pi-rtk-optimizer/config.json`:
  - Тонкая настройка фильтрации и сжатия вывода тестов, сборки, git и линтеров.
- `orca-agent-status.ts`, `orca-prefill.ts`, `orca-titlebar-spinner.ts`:
  - Интеграция со статусной строкой, спиннером и буфером префилла Orca IDE.

### 4. Безопасное хранилище секретов (`secrets/`)
- `config.json` — конфигурация политик и белых/чёрных списков путей.
- `setup.ps1` — добавление секретов в Windows DPAPI vault (`CurrentUser`).

### 5. Curated Skills (`skills/`)
22 специализированных навыка, доступных агенту:
- **UI & Frontend Design:** `brandkit`, `design-taste-frontend`, `design-taste-frontend-v1`, `frontend-design`, `gpt-taste`, `high-end-visual-design`, `image-to-code`, `imagegen-frontend-mobile`, `imagegen-frontend-web`, `industrial-brutalist-ui`, `minimalist-ui`, `redesign-existing-projects`, `stitch-design-taste`.
- **Backend & Frameworks:** `nestjs-expert`, `nestjs-patterns`, `nestjs-testing`, `supabase-postgres-best-practices`, `vercel-react-best-practices`.
- **Engineering & Coordination:** `orchestration`, `context7-mcp`, `find-skills`, `full-output-enforcement`.

### 6. MCP Серверы (`mcp/`)
- `mcp.example.json` — конфигурация Context7 MCP сервера для актуальной документации библиотек и фреймворков.

---

## Настройка после установки

### 1. Учётные данные и API-ключи
Отредактируйте `~/.pi/agent/auth.json` или запустите авторизацию:
```bash
pi auth login
```
Для добавления API-ключа `opencode-go`:
```json
{
  "opencode-go": {
    "type": "api_key",
    "key": "ВАШ_КЛЮЧ"
  }
}
```

### 2. Секреты для secret-guard (Windows)
```powershell
# Добавить секрет с маскированным вводом
powershell -NoProfile -File ~/.pi/agent/secrets/setup.ps1 -Add MY_API_KEY

# Проверить список сохранённых секретов
powershell -NoProfile -File ~/.pi/agent/secrets/setup.ps1 -List
```

### 3. Context7 MCP API Key
В файле `~/.config/mcp/mcp.json` укажите ваш ключ:
```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "CONTEXT7_API_KEY": "ВАШ_CONTEXT7_КЛЮЧ"
      },
      "lifecycle": "lazy",
      "directTools": true
    }
  }
}
```

---

## Обновление до самых свежих версий

Чтобы обновить Pi, все установленные расширения и каталоги моделей:

**Windows:**
```powershell
.\update.ps1
# или
pi update --all
```

**Linux / macOS:**
```bash
./update.sh
# или
pi update --all
```

---

## Лицензия
MIT
