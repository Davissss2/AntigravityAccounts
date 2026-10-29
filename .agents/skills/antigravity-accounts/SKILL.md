---
name: antigravity-accounts
description: Contexto técnico integral, arquitectura interna, inyección de tokens en state.vscdb, modelos Cloud Code PA, algoritmos de ordenamiento, ciclo de escaneo y UI de la extensión Antigravity Accounts.
---

# Antigravity Accounts — Manual de Arquitectura y Desarrollo

## 1. Visión General del Proyecto
**Antigravity Accounts** es una extensión diseñada exclusivamente para **Antigravity IDE** (basado en Electron/VS Code). Permite gestionar múltiples cuentas de Google, alternar entre ellas sin perder la sesión, supervisar cuotas y tiempos de recarga de modelos de IA (Gemini 3.7 Flash, Gemini 3.5 Flash, Gemini 3.1 Pro, Claude Sonnet/Opus, GPT-OSS 120B), e inyectar credenciales directamente en la base de datos interna SQLite de Antigravity (`state.vscdb`).

---

## 2. Arquitectura de Directorios (Clean Architecture)

```
src/
├── core/
│   ├── constants/app.constants.ts       # Constantes: URLs, endpoints PA, IDs de modelos, claves de storage
│   ├── domain/models/                   # Modelos de dominio (Account, AccountTokens, DeviceProfile, Balance)
│   ├── domain/repositories/             # Interfaces de repositorios (IAccountRepository)
│   └── utils/
│       ├── crypto.utils.ts              # Cifrado AES-256-GCM para copias de seguridad
│       ├── logger.ts                    # Logger centralizado
│       ├── model.utils.ts               # Mapeo y formateo de modelos amigables (friendly names)
│       ├── path.utils.ts                # Resolución multiplataforma de rutas (%APPDATA%\Antigravity IDE)
│       ├── protobuf.utils.ts            # Serialización y deserialización Protobuf para state.vscdb
│       └── version.utils.ts             # Detección de versión de Antigravity
├── features/
│   └── accounts/
│       └── account.service.ts           # Lógica de negocio, auto-rotación, refresco de balances, flujo OAuth
├── infrastructure/
│   ├── auth/oauth.service.ts            # Servidor local HTTP y flujo OAuth 2.0 con Google
│   ├── storage/
│   │   ├── account.repository.impl.ts   # Persistencia segura de cuentas y perfiles
│   │   ├── inject-worker.js             # Worker detached para inyección de SQLite tras cierre de ventana
│   │   └── state-db.service.ts          # Orquestador de inyección en state.vscdb y storage.json
├── presentation/
│   └── providers/
│       ├── accounts-webview.provider.ts # Webview interactiva, ordenamiento, filtrado, barra de progreso
│       └── status-bar.provider.ts       # Item en la barra de estado de Antigravity
├── i18n/
│   ├── i18n.service.ts                  # Servicio de traducción (es, en, ar)
│   └── locales/                         # Archivos de idioma JSON
└── extension.ts                         # Punto de entrada y registro de comandos/providers
```

---

## 3. Mecanismo de Inyección en `state.vscdb` (Account Switching)

Antigravity mantiene la base de datos `state.vscdb` en memoria y sobreescribe el archivo al salir. Por tanto:
1. Se genera un payload con los tokens serializados en **Protobuf** (`antigravityUnifiedStateSync.oauthToken`, `antigravityUnifiedStateSync.userStatus`, `antigravityOnboarding`).
2. Se escribe un perfil de dispositivo aleatorizado (`DeviceProfile`) en `storage.json` y `state.vscdb` para evitar vinculación de cuentas por telemetría.
3. Se inicia un subproceso independiente desacoplado (`inject-worker.js`) con `ELECTRON_RUN_AS_NODE=1`.
4. Se cierra la ventana de Antigravity (lo que provoca el volcado de memoria a disco).
5. El worker espera a que todos los procesos de Antigravity finalicen, inyecta las filas en SQLite con `sql.js` y relanza Antigravity.

---

## 4. Algoritmos de Ordenamiento de Cuentas

1. **Cuenta Activa Anclada (`_pinnedActiveEmail`)**: La cuenta actualmente en uso en Antigravity se mantiene en primera posición.
2. **Orden por Defecto (`default`)**:
   - Primero las cuentas con cuota disponible (> 0%), ordenadas de mayor a menor porcentaje.
   - A continuación, las cuentas con cuota agotada (0%), ordenadas por **tiempo de regeneración más próximo** (las que antes se recargan primero; `diffMs <= 0` cuenta como recarga inmediata).
   - Al final, cuentas con sesión expirada, error o no elegibles.
   - Desempate por nombre / email (`localeCompare`).
3. **Cuota Restante (`quota`)**: Mayor cuota primero; en caso de empate o 0%, menor tiempo hasta recarga.
4. **Tiempo de Regeneración (`quota-regen`)**: Ordenadas ascendentemente por tiempo restante hasta renovación (`nextResetTime`).
5. **Fecha de Adición (`date-added`)**: Cuentas añadidas más recientemente primero.

---

## 5. Ciclo de Escaneo y Barra de Progreso

- **Escaneo de Segmentos**:
  - `all`: Escanea todas las cuentas.
  - `with-quota`: Escanea cuentas activas que tienen cuota > 0%.
  - `without-quota`: Escanea cuentas agotadas (0%), expiradas o con error.
- **Persistencia de la Barra de Progreso**:
  - El estado del escaneo (`isRefreshing`, `currentIndex`, `totalAccounts`, `currentEmail`) se conserva en el backend (`AccountsWebviewProvider`).
  - Si el usuario cambia de pestaña o cierra el panel, al reabrirse se inicializa con el progreso actual sin perderse ni bloquear la interfaz.
- **Insignia de Cuentas con Cuota**:
  - Muestra en la cabecera un contador en tiempo real (`● X/Y con cuota`).
- **Anti-Ban Reforzado**: 
  - Delay aleatorio entre cuentas ampliado a **6s–15s** con jitter durante el escaneo para evitar rate-limiting de Google APIs.
  - Interrupción inmediata (Safety Break) del ciclo de escaneo si se detecta un código **HTTP 429 (Too Many Requests)**, protegiendo todas las cuentas restantes del pool contra bloqueos en cascada.
- **Protección contra Sobre-Refresco (Defaults Seguros)**:
  - `autoRefreshEnabled` desactivado por defecto (`false`) para no disparar peticiones innecesarias al abrir el panel o iniciar el IDE.
  - `refreshIntervalMinutes` fijado a `0` (desactivado por defecto).
  - Eliminado el polling en bucle de 30 segundos sobre la cuenta activa: la verificación periódica sólo se ejecuta si `autoRotateEnabled` está activo, y con un intervalo seguro de 10 minutos.
  - Cooldown de 5 minutos al cambiar de cuenta y 30 segundos de debouncing al refrescar cuentas individuales.
  - User-Agent dinámico que refleja la versión real instalada de Antigravity IDE.

---

## 6. Recomendaciones de Seguridad y Límites de Cuentas (~75–78 Cuentas)

- **Límite máximo recomendado**: No crear ni superar ~75 a 78 cuentas en un mismo entorno / IP / máquina.
- **Motivo**: Los sistemas heurísticos de abuso de Google detectan patrones masivos de creación a partir de ese umbral y proceden a suspender o solicitar verificación inmediata en las cuentas nuevas.
- Mantener un pool de 70 a 78 cuentas activas garantiza rotación continua y máxima vida útil sin bloqueos.
- Se recomienda no abusar del botón de "Refrescar todas las cuentas" manualmente y dejar que el sistema opere con las cuotas cacheadas.

---

## 7. Lecciones Técnicas, Ingeniería Inversa de Antigravity Core y Prevención de Errores

### 7.1. Ingeniería Inversa de la Resolución de Endpoints en Antigravity IDE (`out/main.js`)
Mediante herramientas de ingeniería inversa (REA) sobre el código empaquetado del IDE (`C:\Users\Usuario\AppData\Local\Programs\Antigravity IDE\resources\app\out\main.js`), se extrajo la función canónica de selección de endpoints (`NAl`):
```javascript
function NAl({ isDevMode: e, isGoogleInternal: t, isGcpTos: r, isTierGCPTos: n, cloudCodeUrlOverride: i }) {
  return i || (t && e ? Zis : t ? Dis : r || n === true || n === undefined ? Gis : Uis);
}
// Zis = "https://autopush-cloudcode-pa.sandbox.googleapis.com"
// Dis = "https://preprod-daily-cloudcode-pa.sandbox.googleapis.com"
// Gis = "https://cloudcode-pa.googleapis.com" (PRODUCCIÓN)
// Uis = "https://daily-cloudcode-pa.googleapis.com" (DAILY / PERSONAL SIN GCP TOS)
```

**Regla de Oro:**
- Cuentas de usuario particulares sin acuerdos comerciales GCP ToS (`isGcpTos === false`) deben consultar obligatoriamente `https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`.
- El endpoint de producción `cloudcode-pa.googleapis.com` devuelve de forma estática `remainingFraction: 1` (100%) para todos los modelos en cuentas personales, falseando por completo el saldo real.

### 7.2. El Problema de las Claves Zombi (`gemini-3.8-flash-high` vs `gemini-3.8-flash-tiered`)
- **Causa Raíz de la Discrepancia (Tarjeta en 100% vs Barra Inferior en 4% o 7%)**:
  1. Google PA **nunca** devuelve la clave `gemini-3.8-flash-high`. La clave canónica devuelta por Google es `gemini-3.8-flash-tiered`.
  2. En versiones anteriores de la extensión existía el alias `gemini-3.8-flash-high` guardado en `account.balances` dentro de SQLite (`state.vscdb`).
  3. Cuando se actualizaba la cuenta desde `daily-cloudcode-pa`, Google inyectaba `gemini-3.8-flash-tiered: 4`, pero al hacer spread de balances antiguos (`...oldBalances`), la clave `gemini-3.8-flash-high: 100` permanecía almacenada indefinidamente.
  4. En `model.utils.ts`, ambas claves mapeaban al nombre amigable `"3.8 Flash (High)"`. Al recorrer `Object.entries(balances)`, `gemini-3.8-flash-high` aparecía primero en el orden de iteración y devolvía 100% de inmediato.
  5. En el webview, `friendlyModelMap` registraba primero `gemini-3.8-flash-high` (100%) y descartaba silenciosamente `gemini-3.8-flash-tiered` (4%).
- **Solución Implementada**:
  - `model.utils.ts` (`getModelBalanceValue` y `getModelBalanceEntry`): recopila todas las coincidencias del modelo y prioriza estrictamente las claves canónicas con sufijo `-tiered` sobre alias heredados (`-high`, `-med`).
  - `accounts-webview.provider.ts` y `status-bar.provider.ts`: deduplicación activa por nombre amigable donde la clave `-tiered` sobrescribe cualquier alias previo.
  - `account.service.ts`: `mergeBalancesPreservingResetTime` purga de forma destructiva las claves `gemini-3.8-flash-high` y `gemini-3.8-flash` cuando la clave `-tiered` existe en balances nuevos o antiguos.
  - `extension.ts`: Migración automática de almacenamiento v4 (`storageMigration_v4_done`) que limpia en el arranque de la extensión todas las cuentas persistidas en cualquier equipo o instalación.

### 7.3. Causa y Solución del Temporizador que se Resetea a 59 Minutos al Refrescar
- **Causa 1 (Omisión de Merge en Refresco Individual)**:
  - En `account.service.ts`, `refreshBalancesWorkflow` utilizaba `mergeBalancesPreservingResetTime`, pero `refreshSingleAccountBalance` (el botón de refresco individual de cada tarjeta) guardaba directamente `balances: balanceInfo.balances`.
  - Google devuelve una ventana dinámica relativa de `now + 7 days` para cuentas al 100%. Al pulsar el botón manual de refresco, Google recalculaba la fecha con respecto al segundo exacto de la petición, reseteando la cuenta atrás del usuario a 59 minutos.
  - **Solución**: `refreshSingleAccountBalance` invoca siempre `this.mergeBalancesPreservingResetTime(oldBalances, balanceInfo.balances)` para retener el ciclo original si el saldo se mantiene al 100%.
- **Causa 2 (Competencia Desordenada de Modelos en la Cabecera de la Tarjeta)**:
  - En `accounts-webview.provider.ts`, la variable `nextResetTime` se calculaba buscando la diferencia mínima (`minDiffMs`) sobre todos los modelos devueltos por Google.
  - Modelos terciarios como `gpt-oss-120b-medium` devolvían timestamps ligeramente desfasados con respecto al modelo preferido, monopolizando el contador y provocando saltos bruscos.
  - **Solución**: Si hay un modelo preferido (`preferredModelData`) con `resetTime` en el futuro:
    1. Si está consumido (`< 100%`), su tiempo es la máxima prioridad.
    2. Si está al 100%, solo se cede la cabecera si otro modelo consumido recarga antes. Si todos están al 100%, la cabecera muestra determinísticamente la renovación del modelo preferido.

### 7.4. Barra de Estado Sincronizada y Multiplataforma
- **Barra de Estado**: Antes mostraba una cadena ilegible de 10 porcentajes sin contexto (`💰 100/100/100/100/4/4`). Ahora lee `getModelBalanceEntry` para el modelo preferido y muestra `$(hubot) [Alias] | 💰 [Modelo]: [X]%`, garantizando coincidencia al 100% con la tarjeta del webview.
- **Empaquetado Multiplataforma**: Generar siempre paquetes universales mediante `npx -y @vscode/vsce package` (`antigravity-account-X.X.X.vsix`) sin la bandera `--target win32-x64` para permitir la instalación directa en Ubuntu, Debian, macOS (ARM64/x64) y Windows.

### 7.5. Causa Raíz de Pantalla Negra y Error "ServiceWorker: The document is in an invalid state"
- **Síntoma Reportado por el Usuario**:
  - Tras cambiar de cuenta, reiniciar el IDE o pulsar recargar cuenta, el panel lateral de Antigravity Accounts se queda permanentemente en negro ("da petardazos"), arrojando la notificación de error:
    `Error loading webview: Error: Could not register service worker: InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state..`
- **Causas Raíz Diagnosticadas**:
  1. **Destrucción Masiva y Continua del DOM (`this.refresh()` sin debounce)**:
     - En `accounts-webview.provider.ts`, cada evento de `onAccountsChanged` (disparado cada 3 segundos por el monitor adaptativo de cuota de `extension.ts` o tras actualizar balances) invocaba de inmediato `this.refresh()`.
     - Además, en `resolveWebviewView` se ejecutaba `await this.refresh()` y a los pocos milisegundos una promesa de fondo volvía a llamar incondicionalmente a `await this.refresh()`.
     - Cada `this.refresh()` ejecutaba `this._view.webview.html = html`, destruyendo el iframe y abortando el arranque de Chromium mientras la capa interna de VS Code estaba ejecutando `navigator.serviceWorker.register()`. Al destruirse el documento activo en mitad del registro, Chromium lanza por especificación `InvalidStateError`, y VS Code abandona el webview dejándolo en negro.
  2. **Cierre Forzado Prematuro en Worker de Inyección (`state-db.service.ts`)**:
     - `waitForAntigravityExit` esperaba únicamente 5 segundos antes de lanzar `taskkill /F /PID`. En sistemas con alta carga, Chromium e IndexedDB tardan más de 5s en cerrar y volcar sus archivos LevelDB.
     - Matar los procesos con `/F` corrompía la base de datos de Chromium en `%APPDATA%\Antigravity IDE\Service Worker\Database` y dejaba archivos `LOCK` huérfanos con transacciones pendientes en `000003.log`.
     - Al relanzar el IDE, el Service Worker no podía inicializarse y se bloqueaba.
  3. **Omisión de Content-Security-Policy (CSP)**:
     - El HTML generado carecía de cabecera CSP `<meta http-equiv="Content-Security-Policy">`, provocando restricciones de seguridad en versiones modernas de Chromium/Electron.
- **Solución Quirúrgica Implementada**:
  1. **Cola de Renderizado y Semáforo de Concurrencia (`accounts-webview.provider.ts`)**:
     - Creados flags `_isRendering`, `_renderQueued`, y método `debouncedRefresh(delayMs)`.
     - Comprobación estricta de visibilidad: si el panel está oculto o colapsado (`!this._view.visible`), nunca se sobreescribe `webview.html`; la actualización se retiene y se ejecuta limpiamente al recibir `onDidChangeVisibility`.
     - Limpieza de referencias con `webviewView.onDidDispose`.
     - Eliminada la segunda llamada redundante a `refresh()` en el arranque si la cuenta activa no difiere de la presembrada.
  2. **Auto-Healing de Service Worker (`PathUtils.repairServiceWorkerIfCorrupted`)**:
     - En el arranque de la extensión se comprueba y elimina de forma segura cualquier archivo `LOCK` huérfano en `Service Worker/Database`.
     - Añadido comando de rescate `antigravity-account.repairWebview`.
  3. **Ampliación de Salida Elegante a 12s en Worker de Inyección**:
     - Incrementado el tiempo de espera a 12.000 ms y limpieza de bloqueos antes del relanzamiento.
     - Corregido el doble spawn en Linux/macOS.
  4. **CSP Estricto Incorporado**:
     - Añadido `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src 'unsafe-inline';">`.

### 7.6. Falsos Saltos a 0%, Auto-Switch Indeseado y Lag en Detección de Cuenta (HTTP 429 vs Cuota Real)
- **Síntomas Reportados por el Usuario**:
  1. Al refrescar una cuenta (ej. `account-12`), marcaba 86%, luego 86%, y de repente caía a 0% forzando un cambio de cuenta indeseado.
  2. En otro equipo, cuentas gastadas (0%) aparecían con el 100% de cuota.
  3. Al cambiar de cuenta o iniciar sesión, el plugin tardaba muchos segundos en enterarse de con qué cuenta estaba operando.
- **Causas Raíz Diagnosticadas y Soluciones Quirúrgicas**:
  1. **HTTP 429 no es Agotamiento de Cuota (Bug de Falsa Depleción por Rate Limit)**:
     - **Causa**: En las APIs de Google Cloud / Google GenAI, el código HTTP 429 devuelve canónicamente `status: "RESOURCE_EXHAUSTED"` ("Resource has been exhausted (e.g. check quota)"). Esto representa exclusivamente un límite de peticiones por minuto (Rate Limit temporal), **nunca** el agotamiento del saldo de tokens o cuota mensual de los modelos.
     - En `balance.service.ts`, el bloque `catch` para status 429 comprobaba si el mensaje incluía `'RESOURCE_EXHAUSTED' || 'quota' || 'exhausted'`. Como Google **siempre** devuelve esa cadena en cualquier 429, la función retornaba `{ __isDepleted: true }`. Al recibir esto, la extensión vaciaba los balances de la cuenta a 0%, marcaba `AccountStatus.DEPLETED` y disparaba `triggerAutoRotation`, rotando a otra cuenta forzosamente en plena sesión mientras la cuenta aún disponía de cuota.
     - **Solución**: En HTTP 429, jamás devolver `__isDepleted` ni alterar los balances a cero. Se marca estrictamente `__isRateLimited: true`, conservando los balances y cuotas previas intactas y evitando la rotación automática espuria.
  2. **Endpoint Inconsistente `cloudcode-pa.googleapis.com` (Cuentas al 100% en otros PCs)**:
     - **Causa**: `API.FETCH_MODELS_URLS` contenía un fallback al endpoint de producción `cloudcode-pa.googleapis.com`. En cuentas personales sin acuerdos GCP ToS, este endpoint devuelve modelos vacíos o cuotas estáticas en `1.0` (100%). Si `daily-cloudcode-pa` tardaba más de su agresivo timeout anterior de 3.5s, la petición caía en este endpoint, provocando que cuentas a 0% oscilaran erráticamente al 100%.
     - **Solución**: Removido `cloudcode-pa` de `FETCH_MODELS_URLS`; todas las cuentas usan el endpoint canónico de alta velocidad `daily-cloudcode-pa.googleapis.com`, con su timeout ampliado a 8000ms.
  3. **Empaquetado Autónomo de `sql.js` (Eliminación de `MODULE_NOT_FOUND` en Runtime)**:
     - **Causa**: Al empaquetar con vsce (`--no-dependencies`), `sql.js` (al ser paquete externo con WASM) no se incluía en el `.vsix`, provocando `Error: Cannot find module 'sql.js'` al consultar `state.vscdb`.
     - **Solución**: `scripts/build.js` copia automáticamente `sql-wasm.js` y `sql-wasm.wasm` dentro del directorio `dist/` (y en las carpetas de extensiones del IDE). `state-db.service.ts` carga el binario directamente desde `dist/` con fallback local garantizado.
  4. **Eliminación del Lag de 4 Segundos en la Detección de Cuenta Activa**:
     - **Causa**: `getActiveAntigravityEmail` llamaba a `getNativeAuthEmail()`, que ejecutaba hasta 8 consultas secuenciales `vscode.authentication.getSession` para 4 combinaciones de scopes y 2 proveedores, esperando hasta 2.5s antes de hacer fallback a `state.vscdb` (el cual fallaba con timeout de 1.5s por la falta de `sql.js`).
     - **Solución**: Reducido el timeout de comprobación en memoria a 500ms. La lectura de `state.vscdb` con `sql-wasm` y extracción directa de Protobuf (`field 7` de `userStatus`) se resuelve en menos de 5ms, permitiendo detección inmediata sin congelaciones.
  5. **Eliminación de `retainContextWhenHidden` y Handshake Seguro de Service Worker (Fix Definitivo de InvalidStateError)**:
     - **Causa**: `registerWebviewViewProvider` utilizaba `retainContextWhenHidden: true`. En VS Code y Chromium, retener un contexto de webview lateral mientras está colapsado o mientras se recarga la ventana provoca que el documento del iframe no esté en estado activo de navegación, causando que `navigator.serviceWorker.register()` falle con `InvalidStateError: The document is in an invalid state..`. Además, asignar `this._view.webview.html = html` síncronamente en el mismo microtick de montaje de `resolveWebviewView` interrumpía el handshake inicial de Chromium.
     - **Solución**:
       1. Eliminado `retainContextWhenHidden: true` en `extension.ts`: el estado de las cuentas se mantiene en memoria y en SQLite, renderizándose de forma limpia e instantánea al abrir la vista sin retención zombi en segundo plano.
       2. Introducido un retardo de handshake de 60ms (`setTimeout`) en `resolveWebviewView` antes de inyectar el HTML para permitir que Chromium registre el Service Worker sin colisiones.
       3. Añadido reintento automático resiliente en `refresh()` ante `InvalidStateError`.
       4. Mejorada la rutina de auto-sanación `PathUtils.repairServiceWorkerIfCorrupted` para purgar logs truncados de LevelDB generados por cierres forzados.

### 7.7. Antigravity 1.107.0 — Nuevo Motor de Cuotas (UnifiedStateSync) y Cómo Detectar la Cuota Real

**Contexto:** La actualización de 1.22.2 a **1.107.0** sustituyó la capa de estado por *UnifiedStateSync* (USS) con ciclos de vida propios (`oauthLifecycle`, `userStatusLifecycle`, `modelCreditsLifecycle`…) y cambió por completo la semántica de cuotas de Google Code Assist.

#### 7.7.1. Formatos de `state.vscdb` (sin cambios respecto a 1.22.2)
Las claves siguen siendo `antigravityUnifiedStateSync.oauthToken` y `antigravityUnifiedStateSync.userStatus`, con la estructura `Topic → DataEntry(key, Row(value = base64(payload)))`. El esquema `OAuthTokenInfo` mantiene los mismos campos (1 `accessToken`, 2 `tokenType`, 3 `refreshToken`, 4 `Timestamp{seconds}`, 6 `isGcpTos`), por lo que la inyección existente sigue siendo válida. Verificado decodificando el binario real y comparándolo con `ProtobufUtils.createUnifiedOAuthEntry`.

#### 7.7.2. `antigravityAuthStatus` y el proveedor nativo ya no son fuente de verdad
- La clave `antigravityAuthStatus` **desapareció** del build 1.107 (`0` ocurrencias en `out/main.js`, `workbench.desktop.main.js` y `extensions/agy`).
- El proveedor `antigravity_auth` sigue existiendo en la configuración (`JP.authProviderId`), pero `vscode.authentication.getSession()` puede devolver indefinidamente la cuenta con la que se inició sesión de forma interactiva, aunque USS ya contenga otra.
- **Regla**: la cuenta activa se lee de `state.vscdb` (`userStatus`, campo 7 del Protobuf). Sólo se recurre a la sesión nativa cuando la base de datos no tiene sesión, y los tokens en memoria únicamente se usan si el email coincide con el persistido. De lo contrario, el panel marca como `ACTIVE` una cuenta ya reemplazada.
- **Coste real de `getNativeAuthSession()`**: recorre 2 proveedores × 4 combinaciones de scopes (hasta 8 `vscode.authentication.getSession()` secuenciales) y puede bloquear ~45 s un refresco (medido en trazas: click `10:53:25` → petición API `10:54:13`). Nunca debe llamarse en la ruta caliente sin `Promise.race` con timeout (~1.5 s), y sólo cuando el token de USS falta o caduca en menos de 2 minutos.

#### 7.7.3. El fin de `remainingFraction` como indicador de cuota real
- `POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` (`{"project":"…"}`) ahora devuelve sólo **16 modelos**, todos con `quotaInfo.remainingFraction = 1` y `resetTime` **sintético** igual a `now + 7 días` (ventana semanal deslizante).
- `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` devuelve lo mismo por modelo (`tokenType: "WTUS"`, `remainingFraction: 1`, `resetTime: now + 7 días`).
- Prueba empírica de que es un placeholder: tras refrescar 4 cuentas distintas en minutos consecutivos, todas quedaron al `100%` con `resetTime` exactamente igual al instante del refresco + 7d (p. ej. refresco `11:27` -> reset `11/04T10:27`).
- El límite que **sí** bloquea el chat es una cuota de ventana corta (*"Individual quota reached. Your plan's baseline quota will refresh on …"*), que el IDE obtiene del payload de error de la generación, no de estos endpoints.

#### 7.7.4. APIs canónicas nuevas
- `POST /v1internal:retrieveUserQuotaSummary` (`{"project":"…"}`) → `{ groups: [{ displayName, description, buckets: [{ bucketId ("3p-weekly"), displayName, window, resetTime, remainingFraction }] }] }`. Es el modelo agrupado semanal y sólo describe el grupo *"Claude and GPT models"* en cuentas free-tier; **la ausencia de un grupo Gemini no implica cuota agotada**, así que no debe usarse para marcar 0%.
- `POST /v1internal:retrieveUserQuota` → buckets por modelo con `tokenType` y reset semanal.
- Sin `project` (o con project inválido) ambos devuelven `403 PERMISSION_DENIED` (#3501); con `project` correcto devuelven `200`. Por tanto un `403` es **inconcluyente**, nunca "cuenta agotada".
- `v1internal:loadCodeAssist` sigue siendo la fuente de `cloudaicompanionProject` (`aicode-consumers`), `currentTier` y `paidTier` (`"Antigravity Starter Quota"`).

#### 7.7.5. Sondeo de disponibilidad — **DESCARTADO en 0.3.43**
- El sondeo `generateContent` descrito en versiones anteriores **se eliminó**: la ingeniería inversa de 1.107 (ver 7.8) demuestra que el IDE no lo usa para nada y que produce lecturas falsas (marcaba al 0% familias enteras que la API reporta al 100%).
- Se conserva sólo como referencia histórica: `POST v1internal:generateContent` con `maxOutputTokens: 1` devolvía `200` en cuentas que el IDE bloqueaba y `429` en otras, así que no era una señal fiable.

#### 7.7.6. Claves zombi
- `mergeBalancesPreservingResetTime` debe reconstruir el mapa **sólo** con la respuesta fresca de la API. Fusionar con los balances antiguos mantenía vivas claves que Google ya no devuelve (`gemini-3.1-pro-*`, `gemini-3.6/3.7-flash-*`, `gemini-pro-agent`, `-high/-low/-med`), congeladas en 0% o 100%.
- Medido en `account-33`: 30 claves guardadas frente a 19 devueltas por la API, con 9 zombis al 0%.

#### 7.7.7. Deriva de identidad en `state.vscdb` (identidad ≠ token)
- Síntoma: el panel marca la cuenta A como ACTIVE y su tarjeta muestra 100%, pero el chat falla con *"Individual quota reached"*.
- Causa: `antigravityUnifiedStateSync.userStatus` = **A** mientras `antigravityUnifiedStateSync.oauthToken` pertenece a **B**. Verificación: `POST v1internal:loadCodeAssist` devuelve `currentTier.upgradeSubscriptionUri` con `Email=<dueño real del token>`.
- Origen habitual: adoptar los tokens de la sesión activa y guardarlos bajo el email de la tarjeta que se está refrescando. Ocurría en **tres** rutas (`refreshSingleAccountBalance`, `refreshBalancesWorkflow`, `refreshActiveAccountFast`); desde 0.3.43 todas pasan por `adoptSessionTokens()`.
- Prevención: resolver el dueño con `https://www.googleapis.com/oauth2/v2/userinfo` (`resolveTokenOwner`, cacheado 30 min) antes de `storeTokens` y antes de `injectAccountState`.
- **Nunca** pedir al usuario que borre y vuelva a añadir la cuenta: `ensureCredentialsBelongTo()` repara en el sitio (token actual → refresh token → login de Google con `login_hint` para ese mismo email) conservando alias, perfil de dispositivo e historial.

### 7.8. Antigravity 1.107 — Dónde vive realmente la cuota (REA definitiva)

Todo lo siguiente se verificó leyendo el binario instalado y ejecutando contra la API con el token real de la máquina.

#### 7.8.1. La regla exacta con la que el IDE bloquea el chat
```javascript
// out/main.js
bpe = (model, …) => {
  const q = model?.quotaInfo;
  if (!q || q.remainingFraction > 0) return null;   // sin aviso
  return Lnn(model.label, resetTime, …);             // "Individual quota reached…"
};
```
- **Única condición:** `quotaInfo.remainingFraction === 0` dentro de la respuesta de `v1internal:fetchAvailableModels`. No hay un pool «baseline» separado que consultar.
- El aviso `Your plan's baseline quota will refresh on …` se construye con el `resetTime` de **ese mismo** modelo.
- `listCascadeNuxes`/`retrieveUserQuota*` no participan en la decisión.

#### 7.8.2. Nombre de los topics (UnifiedStateSync)
- `uss-userStatus` → clave de datos `userStatusSentinelKey` → persistida en `ItemTable` como `antigravityUnifiedStateSync.userStatus`.
- `uss-oauth` (**no** `uss-oauthToken`) → clave `oauthTokenInfoSentinelKey` → `antigravityUnifiedStateSync.oauthToken`.
- `out/main.js` (`CloudCodeService`) hace `subscribe("uss-oauth")` y `AF(state)` lee el token de ahí; `getGcpProjectIdFromUSS()` lee `uss-enterprisePreferences` (`enterpriseGcpProjectId`).
- `fetchAvailableModels` se envía con `{ project: this._cloudAiCompanionProject }`, es decir el proyecto del `loadCodeAssist` del arranque, **no** un proyecto hardcodeado.

#### 7.8.3. De dónde obtiene el agente el token
`extensions/agy/vscode/extension.js` resuelve el token en este orden:
1. `oauthToken` explícito del llamante.
2. Extensión compañera `google.cloud-developer-environments-auth` (`getOauthAccessToken`). No viene instalada de fábrica.
3. `~/.gemini/jetski-standalone-oauth-token` (`{ token: { access_token, expiry } }`). Puede no existir.
4. Si ninguno responde, el workbench usa el topic `uss-oauth` (lo que inyecta la extensión).

Consecuencia práctica: el actor autoritativo es el par `userStatus` + `oauthToken` de `state.vscdb`, y `agy.onboarding.lastLoginUsername` (globalState de `google.google-antigravity`) es **solo una etiqueta de la UI**: la pantalla *Antigravity Settings → Account* puede mostrar un email antiguo mientras la sesión real es otra. No usar ese valor para decidir la cuenta activa.

#### 7.8.4. Lecturas consistentes de `state.vscdb`
- `PRAGMA journal_mode = delete` (rollback journal) y el IDE escribe continuamente (`state.vscdb` cambia de mtime cada pocos segundos).
- `sql.js` sobre `fs.readFileSync` **no toma locks**: una lectura puede caer a mitad de transacción y devolver una fila truncada → parsea como «sin sesión» → la consulta de cuota se hace con otra cuenta.
- Solución: `readConsistentSnapshot()` valida el parseo y reintenta (60/180/300/420 ms) antes de rendirse.

#### 7.8.5. Almacén de credencial del agente por plataforma (lo que realmente cambia la cuenta)
| Plataforma | Almacén | Escritura |
|---|---|---|
| Windows | Almacén de credenciales (`LegacyGeneric:target=gemini:antigravity`, usuario `antigravity`) | `CredWrite` vía P/Invoke en `write-cred.ps1` |
| macOS | Llavero (generic password) | `security add-generic-password -U -s gemini:antigravity -a antigravity -w <json>` |
| Linux | libsecret (GNOME Keyring / KWallet) | `secret-tool store service gemini:antigravity username antigravity` con el secreto por stdin |

- El blob es **JSON plano**: `{ token: { access_token, token_type, refresh_token, expiry, expires_in }, auth_method: "consumer", id_token_email: "<cuenta>" }`. `expiry` es ISO-8601 con **7 decimales** y offset (`2026-10-28T14:15:22.3827820+01:00`).
- Tras escribirlo hay que **matar el hub** (`agy.exe` en Windows, `pkill -f 'agy.*--hub'` en macOS/Linux): cachea el token en memoria y solo lo relee al arrancar.
- `%APPDATA%\Antigravity\credential-user-scope` (17 bytes) es el índice del vault, no un secreto; no hay que tocarlo.
- Si el almacén falla, el cambio se aplica solo en `state.vscdb` y se registra el motivo en `.inject-payload.json.worker.log`.

#### 7.8.6. Diagnóstico rápido de «100% pero el IDE bloquea»
1. Leer el token de `antigravityUnifiedStateSync.oauthToken` y llamar a `https://www.googleapis.com/oauth2/v2/userinfo` → dueño real.
2. Llamar a `v1internal:loadCodeAssist` → `cloudaicompanionProject` y `currentTier.upgradeSubscriptionUri` (contiene `Email=`).
3. Llamar a `v1internal:fetchAvailableModels` **con ese project** y buscar `remainingFraction === 0`.
4. Comparar con la fecha del mensaje de error del chat: un aviso de *hace 24 min* puede ser anterior al último reinicio del IDE y no describir la sesión actual.

### 7.9. Antigravity 1.107 — Dónde viven las conversaciones y cómo reabrir el chat correcto

#### 7.9.1. Ruta real de los datos del agente
| Dato | Ruta 1.107 | Ruta heredada (≤1.22) |
|---|---|---|
| Transcript vivo (por conversación) | `~/.gemini/antigravity/brain/<cascadeId>/.system_generated/logs/transcript.jsonl` | `~/.gemini/antigravity-ide/brain/…` |
| Base de la conversación | `~/.gemini/antigravity/conversations/<cascadeId>.db` (+ `-wal`) | `~/.gemini/antigravity-ide/conversations/…` |
| Índice con título y workspace | `~/.gemini/antigravity/conversation_summaries.db` → tabla `conversation_summaries` (`conversation_id`, `title`, `last_modified_time`, `workspace_uris`, `not_fully_idle`) | — |

- **Error clásico**: leer solo `antigravity-ide`. El hub escribe en `antigravity`, así que la conversación más reciente de la carpeta antigua puede tener **días**, de otro proyecto. El reanudado abría ese chat.
- Los ids de conversación son **UUID v4**; se validan con regex antes de usarlos.
- La frescura real se mide con `max(mtime(<id>.db), mtime(<id>.db-wal))`: el `.db` principal puede llevar horas sin cambios porque todo va al WAL.
- El workspace de una conversación se lee buscando `file:///…` dentro del `.db` **y del `-wal`** (primeros MB). `file:///c%3A/...` necesita `decodeURIComponent`.

#### 7.9.2. Reabrir el chat y escribir en él (comandos reales)
```text
antigravity.openConversation <cascadeId>   // 2º arg opcional: path
antigravity.panel.focus
antigravity.addContext <texto>             // mete texto en la caja del chat
antigravity.triggerSend                    // envía lo que haya en la caja
```
- `antigravity.triggerSend` **no escribe nada**: si la caja está vacía, no envía. Hay que llamar antes a `antigravity.addContext` (es el comando que usa el propio agente para «Fix the problems listed in 'Current Problems'»).
- `antigravity.addContext` acepta strings y objetos (`{type:'text', text}`); internamente construye `items[{chunk:{case:'text'}}]` y llama al RPC del webview.
- No existen `antigravity.openChatView` ni `antigravity.sendPromptToAgentPanel`.
- Antes de forzar `openConversation`, comprobar que el id pertenece al **workspace abierto** (`vscode.workspace.workspaceFolders[0]`). Si no se puede verificar, no reabrir nada: el panel ya restaura su propia conversación y forzar otra es lo que produce el «me ha metido en un chat en el que no estaba».

#### 7.9.3. ¿La IA había terminado o se quedó a medias?
El `transcript.jsonl` guarda un JSON por paso con `type`, `status`, `created_at`, `content` y `tool_calls`. La decisión **no** puede basarse en la antigüedad del fichero: un chat terminado hace 20 s y uno interrumpido hace 20 s son indistinguibles por fecha.

| Último paso | Interpretación |
|---|---|
| `PLANNER_RESPONSE` + `content` y sin `tool_calls` | **Terminó** → reabrir el chat, no escribir nada |
| `PLANNER_RESPONSE` con `tool_calls` | Cortado esperando herramientas → reanudar |
| `GENERIC` / `TOOL_RESPONSE` / `TOOL_CALL` | Herramienta ejecutada sin respuesta del modelo → reanudar |
| `USER_INPUT` | Petición sin contestar → reanudar |
| `status` = `RUNNING` / `IN_PROGRESS` / `PENDING` | En curso → reanudar |
| `ERROR_MESSAGE` | Se trata como interrupción solo si el texto contiene keywords de cuota/503 |

- El marcador de reanudación debe combinar esa forma con una ventana de recencia (≥10 min desde el último `mtime`): un run abandonado de hace horas no se reanuda.
- Si `wasWorking` acaba en `false`, `executePendingResume` **sí reabre** la conversación (para no perder el hilo) y **no** escribe el prompt.

### 7.10. Regla de oro del ordenamiento: el mismo número que la tarjeta
- `sortAccounts()` debe ordenar por **exactamente** el porcentaje que imprime la tarjeta: `getModelBalanceEntry(balances, preferredModel)?.value`. Nunca por «el mejor modelo disponible».
- Defecto histórico (corregido en 0.3.52): `getAccountQuotaValue` hacía `if (prefVal > 0) return prefVal;` y, si el modelo preferido estaba a 0 %, caía a un máximo sobre otras claves (`gemini-3.8-*`, `claude-*`, `gpt-oss-*`). Una cuenta agotada para el usuario se ordenaba como 100 % arriba del todo. Medido en esta máquina: **11 cuentas al 0 % colocadas por encima de cuentas con cuota**.
- El tiempo de recarga del orden debe replicar el de la cabecera de la tarjeta: preferido si `< 100 %` (fecha pasada ⇒ disponible ahora), si no el modelo agotado más próximo, y si todo está lleno la fecha del preferido. Las fechas de renovación **en el pasado** de modelos antiguos (p. ej. `gemini-3.7-flash-*` caducados) no son «disponible ahora»: son datos obsoletos y deben ignorarse.
- Estados `token_expired` / `error` / `ineligible` ⇒ cuota 0 y recarga `Infinity`, para que caigan al final en todas las modalidades.
- `AccountStatus` usa valores **en minúsculas** (`'active'`, `'depleted'`, `'token_expired'`…). Comparar contra `'TOKEN_EXPIRED'` nunca acierta.
- Verificación sin IDE: volcar `antigravity.accounts.list` a JSON, cargar `model.utils` con esbuild + Node y comprobar el invariante «ninguna cuenta con tarjeta 0 % aparece antes que una con cuota».






