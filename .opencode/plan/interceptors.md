# План: перехватчики запросов (`intercept/`)

Статус: **не реализовано**. Документ фиксирует контракт и точки интеграции,
заложенные в `src/proxy.ts`, чтобы следующий этап был небольшим диффом.

Связанные изменения уже в коде: `--proxy-to`, маршрутизация `local | proxy | split`
(`planRequest`), `forwardToUpstream`, `mergeResults`, `readUpstreamResult`.

## Зачем

Проксирование (`--proxy-to`) умеет отдавать часть root-полей локально по
`override/<kind>/`, а остальное отправлять в существующий бэкенд. Перехватчики
добавляют третий слой — **изменение пейлоада**:

- до отправки: подменить запрос, переменные, operationName;
- после получения: подменить/дополнить `data`, `errors`, `extensions`.

Область действия — `query`, `mutation` или целая `operation`, по аналогии с
`override/`.

## Layout

```
.backeneko/intercept/                      # user-owned, генератор сюда не пишет
├── queries/<fieldName>.ts                 # перехват root-поля Query
├── mutations/<fieldName>.ts               # перехват root-поля Mutation
└── operations/<operationName>.ts          # перехват целой операции
```

- Каталог лежит рядом с `override/`, но в `MOCK_DIRS` не входит → `generateWorkspace`
  его не создаёт, не перезаписывает и не чистит.
- Hot reload — из коробки: `watchTree` уже рекурсивно смотрит весь воркспейс;
  загрузчик перехватчиков вызывается там же, где `loadMockModules`.
- Анонимная операция матчится файлом `intercept/operations/default.ts`
  (зарезервированное имя).

## Контракт файла

Обычный TS-модуль (грузится тем же способом, что и моки: `Bun.build` +
content-hashed каталог в `.backeneko/cache/`). Экспорты — опциональные функции:

```ts
// .backeneko/intercept/queries/users.ts
export function before(payload: ProxyPayload, ctx: InterceptContext): ProxyPayload {
  return { ...payload, variables: { ...payload.variables, limit: 10 } };
}

export function after(result: InterceptResult, ctx: InterceptContext): InterceptResult {
  return { ...result, data: { ...result.data, users: [] } };
}

// необязательно: сузить условие срабатывания
export function match(ctx: InterceptContext): boolean {
  return ctx.rootFields.includes("users");
}
```

```ts
// .backeneko/intercept/operations/GetUsers.ts
export const mode: "auto" | "proxy" | "local" = "proxy";
```

Типы (`ProxyPayload`, `InterceptContext`, `InterceptResult`) предоставляет
backeneko — см. «Типы для DX».

### `ProxyPayload`

```ts
interface ProxyPayload {
  query: string;
  variables: Record<string, unknown> | null;
  operationName: string | null;
}
```

Для удалённой части это ровно тело, уходящее на апстрим. Для локальной части
`before` может менять `variables`; изменение `query` в локальном маршруте
игнорируется с предупреждением (документ уже разобран и разложен планом).

### `InterceptContext`

```ts
interface InterceptContext {
  operationName: string | null;
  operationType: "query" | "mutation" | "subscription";
  rootFields: string[];        // имена root-полей операции (без алиасов)
  route: "local" | "remote" | "split";
  target: string | null;       // URL апстрима
  rootField?: string;          // для intercept/queries|mutations/<field>
  file: string;                // путь файла перехватчика (для логов)
}
```

### `InterceptResult`

```ts
interface InterceptResult {
  data?: unknown;
  errors?: readonly unknown[];
  extensions?: Record<string, unknown>;
}
```

## Маршрутизация через `intercept/operations/<name>.ts`

`mode` участвует в `planRequest()` **до** выбора per-field маршрута:

| mode | поведение |
| --- | --- |
| `auto` (по умолчанию) | текущая логика: локальные поля по override, остальное — split/proxy |
| `proxy` | вся операция уходит на апстрим, оверрайды игнорируются |
| `local` | вся операция исполняется локально, даже без оверрайдов |

Появление файла `intercept/operations/<name>.ts` само по себе ничего не меняет:
без `mode` это только перехватчик.

## Порядок применения

1. Выбираются все совпавшие перехватчики: файлы `queries|mutations/<field>`
   для каждого root-поля (в порядке появления в операции), затем
   `operations/<operationName>`.
2. `before` вызывается в этом порядке — снаружи внутрь.
3. `after` вызывается в **обратном** порядке — как в onion-middleware: ответ
   проходит тот же путь назад.

Перехватчики применяются и к удалённой, и к локальной части: в split-режиме
каждая часть проходит только через свои перехватчики (по именам полей).

## Ошибки

- Перехватчик бросил исключение → `warn` в лог, пейлоад/результат остаются
  неизменёнными, запрос продолжается. Толерантность — как у загрузчика моков.
- Перехватчик вернул не объект → `warn`, значение игнорируется.

## Интеграция в код

Новый модуль `src/intercept.ts`:

```ts
export interface Interceptor {
  file: string;
  scope: "query" | "mutation" | "operation";
  name: string;
  mode?: "auto" | "proxy" | "local";
  match?(ctx: InterceptContext): boolean;
  before?(payload: ProxyPayload, ctx: InterceptContext): ProxyPayload | Promise<ProxyPayload>;
  after?(result: InterceptResult, ctx: InterceptContext): InterceptResult | Promise<InterceptResult>;
}

export async function loadInterceptors(dir: string, previous?: Interceptor[]): Promise<Interceptor[]>
export function selectInterceptors(interceptors: Interceptor[], ctx: InterceptContext): Interceptor[]
export async function runBefore(selected: Interceptor[], payload: ProxyPayload, ctx: InterceptContext): Promise<ProxyPayload>
export async function runAfter(selected: Interceptor[], result: InterceptResult, ctx: InterceptContext): Promise<InterceptResult>
export function operationMode(interceptors: Interceptor[], operationName: string | null): "auto" | "proxy" | "local"
```

Точки подключения:

| Файл | Изменение |
| --- | --- |
| `src/runtime.ts` | `interceptors: Interceptor[]` (по умолчанию `[]`) |
| `src/cli.ts` | `runtime.interceptors = await loadInterceptors(targetDir)` рядом с `loadMockModules`; перезагрузка в `reloadMocks` |
| `src/server.ts` | в `handleProxiedRequest`: `ctx` → `runBefore` → ветка `proxy`/`split` → `runAfter` перед `json(...)` |
| `src/proxy.ts` | `planRequest` читает `mode` из перехватчиков операции; `forwardToUpstream` не меняется |
| `src/generate.ts` | алиас `@intercept/*` в `workspaceTsconfig()` (если перехватчики импортируют друг друга) и генерация `intercept.d.ts` |

Загрузчик (`loadInterceptors`): обходит `intercept/{queries,mutations,operations}/*.ts`,
собирает через `Bun.build` и импортирует из `cache/<name>-<hash>/` — та же
схема, что `importMockModule` в `src/mocks.ts` (Bun не умеет cache-busting
через query-string и не видит новые файлы в уже импортированном каталоге).

## Типы для DX

Сейчас воркспейс не знает типов backeneko, поэтому `override/`-файлы пишут
сигнатуры вручную (`_parent: unknown, _args: Record<string, unknown>`).

Вариант (рекомендуемый): backeneko генерирует `.backeneko/intercept.d.ts`
(disposable, как `generated/`) с глобальными объявлениями `ProxyPayload`,
`InterceptContext`, `InterceptResult`, и добавляет его в `include` workspace
`tsconfig.json`. Тогда файлы в `intercept/` типизируются без импортов.

Альтернатива: экспорт `backeneko/intercept` из пакета — работает только если
пакет виден из воркспейса (глобальная установка + `node_modules` не гарантированы).

## Тесты (когда дойдём до реализации)

- `intercept/queries/users.ts` с `before` → апстрим получает изменённые переменные;
- `after` → в ответе клиента подменённые данные;
- `intercept/operations/<name>.ts` с `mode: "local"` → операция не уходит на апстрим;
- `mode: "proxy"` → оверрайд игнорируется, запрос уходит целиком;
- порядок: два перехватчика, `before` A→B, `after` B→A;
- брошенное исключение в перехватчике → запрос проходит без изменений;
- hot reload: добавление файла в `intercept/` включает перехват без рестарта;
- анонимная операция → `intercept/operations/default.ts`.

## Открытые вопросы

- Нужен ли `mode` ещё и на уровне `intercept/queries|mutations/<field>.ts`
  (например, «это поле всегда локальное, даже если поле удалено из локальной схемы»)?
- Поддержка `intercept/subscriptions/` — после появления SSE/WS-транспорта.
- Нужна ли возможность перехватывать **до** валидации/парсинга запроса
  (сейчас `before` работает уже с разобранным документом).
