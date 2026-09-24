# Kutxabank card synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. No iniciar implementación hasta que el usuario la solicite. No hacer commits ni push sin solicitud explícita.

**Goal:** Obtener automáticamente los movimientos de tarjetas Kutxabank sin cuota recurrente, manteniendo cuentas AIS, importación manual y trazabilidad contable.

**Architecture:** Conservar `bank_connections -> accounts -> transactions`. Mantener Enable Banking para cuentas y añadir una frontera mínima de conectores para la fuente de tarjetas probada. Reutilizar normalización, deduplicación, categorización, auditoría y exportación; separar extracción bancaria de tratamiento económico.

**Tech Stack:** TypeScript, Node >=22.19.0, Electron, SQLite/better-sqlite3, Zod, Vitest y módulos existentes. La implementación utiliza una ventana Electron aislada; no añade Playwright ni dependencias nuevas.

**Spec:** [Investigación y diseño](../specs/2026-09-14-issue-26-kutxabank-research-design.md).

## Estado de ejecución — 2026-09-16

Esta sección sustituye las decisiones provisionales y los estados históricos de las tareas que siguen. El usuario autorizó la implementación. La rama sigue siendo `feat/26-kutxabank-card-sync`; no se han hecho commits ni push.

- Implementados: lector del formato observado, recorrido completo antes de persistir, conexión local y tarjetas con UUID, importación transaccional y deduplicación por ámbito, ventana Electron aislada con sesión efímera, IPC validado, panel de tarjetas, conciliación explícita y reversible, columnas de gasto y referencia en exportación.
- Identidad: asociación explícita entre la tarjeta de la sesión y un producto local. Los últimos cuatro dígitos sirven para mostrar y detectar incompatibilidad, nunca como clave. No se reescribe el historial AIS ni se introduce una migración global de claves. La migración 014 contiene las relaciones de conciliación.
- Integración: fuente adicional que conserva la orquestación AIS existente. Se descarta el refactor general de adaptadores para limitar el cambio a Kutxabank.
- Sesión: partición en memoria nueva en cada apertura. El titular inicia sesión y responde a MFA en el banco. No hay sincronización desatendida mientras la ventana está cerrada ni almacenamiento persistente de cookies.
- Contabilidad: el usuario confirma dos filas concretas. No hay exclusión por similitud ni sugerencias automáticas. Importe original intacto; contribución cero para una liquidación confirmada o la copia descartada de un duplicado. Cambios posteriores de importe/divisa invalidan el tratamiento y exigen revisión.
- Verificación bancaria disponible: dos tarjetas, periodo abierto/cerrado y 65 filas paginadas repetidas en Edge. Esto acredita la fuente, no la integración Electron.
- Pendiente para cerrar la issue: flujo real desde el portable (login/redirecciones, dos tarjetas, MFA, repetición, cierre/reapertura), comprobación visual de la interfaz y revisión final de la integración. Las pruebas sintéticas no sustituyen estos puntos. No hay una sesión Edge compartida disponible al retomar el 16 de septiembre.

Las tareas originales siguientes conservan el razonamiento de diseño; sus contratos de migración global, adaptador neutral, cifrado de sesiones persistentes y sugerencias automáticas no describen código entregado. La guía de uso vigente está en [Tarjetas Kutxabank](../../banking/kutxabank-card-sync.md).

## Restricciones globales

- Kutxabank tarjetas primero; BBVA y préstamos no bloquean.
- El usuario ya probó Enable Banking: detecta cuentas, no sus tarjetas. No repetir esta investigación como condición para avanzar al fallback.
- No hay todavía prueba del conector local ni proveedor alternativo gratuito con cobertura acreditada. Esta incertidumbre se resuelve en tarea 1 antes de implementar endpoints/selectores.
- Cero cuotas recurrentes; solo cuentas propias/autorizadas; sin operaciones bancarias de escritura ni bypass de MFA.
- Sin secretos, perfiles de navegador ni datos reales en Git, logs, exports de diagnóstico o CI.
- UI/documentación en castellano; nombres técnicos y comentarios en inglés. Conservar también localización inglesa existente.
- Preservar cambios ajenos. Rama de planificación: `feat/26-kutxabank-card-sync`; base `96afced891f9352003c35fefd5fe00486e11df0e` de `origin/main`.
- Ejecución autorizada por el usuario después de la planificación. Consultar el estado actual anterior; los fragmentos de las tareas originales describen el diseño inicial, no resultados de pruebas.

## Orden y entregables

1. Evidencia de extracción y decisión de conector.
2. Identidad de productos y migración compatible.
3. Contratos neutros, adaptador AIS y orquestación.
4. Conector seleccionado, sesión segura y extracción automática.
5. Liquidaciones y conciliación entre fuentes.
6. Integración de escritorio, exportación y capacidades parciales.
7. Verificación completa, prueba real y documentación de entrega.

Cada tarea tiene su ciclo de pruebas y revisión. No empezar tareas 2–6 hasta que 1 demuestre acceso a compras reales. Se pueden preparar fixtures sintéticos durante 1. Revisar `AGENTS.md`, estado Git y manifiesto de migraciones al empezar ejecución; si main avanzó, no mezclar cambios ni renumerar migraciones ya publicadas sin revisar la base.

## Tarea 1: demostrar una fuente gratuita de movimientos Kutxabank

**Archivos:** actualizar la matriz y decisión de la spec; crear `docs/banking/kutxabank-connector-evidence.md` con resultados no sensibles. No añadir capturas reales. Instrumentación temporal de la prueba en almacenamiento local privado fuera de Git; no convertirse automáticamente en código productivo.

**Entrada:** prueba negativa AIS comunicada por usuario y fuentes de la spec. **Salida:** mecanismo elegido, formato, capacidades, reglas observadas de sesión/paginación y condiciones gratuitas, con fecha y límites.

- [x] Registrar el caso comunicado de Enable Banking como insuficiente para tarjetas. Tipo de tarjeta y fecha de la prueba no comunicados; no se exige repetirla.
- [ ] Comprobar si existe acceso ya habilitado a un candidato gratuito. GoCardless solo si el usuario tiene alta válida; otros proveedores requieren condiciones personales gratuitas permanentes y prueba CARD. Una demo o prueba de 90 días no supera este criterio.
- [ ] Si aparece API directa oficial, verificar requisitos productivos y acceso a tarjetas. No inferirlos del certificado genérico sandbox. Si no hay candidato acreditado, avanzar al portal local.
- [ ] Abrir una sesión local dedicada de Kutxabank durante la ejecución autorizada. El titular introduce login/MFA en el banco. Identificar exclusivamente pantallas de consulta y los controles efectivos de producto, periodo y descarga.
- [ ] Probar exportación estructurada de un periodo cerrado y el periodo abierto. Verificar si el fichero contiene compras individuales, divisas, devoluciones, cuotas y fechas; comparar localmente número de filas e importes con el portal. Inspeccionar el contenido sin enviarlo a terceros ni al repositorio.
- [ ] Si no hay exportación suficiente, observar peticiones de lectura realizadas por ese flujo autorizado. Registrar solo esquema anonimizado y restricciones; no copiar cookies, cabeceras o URLs con tokens. Si tampoco hay datos estructurados, probar lectura DOM con paginación completa y detección de virtualización.
- [ ] Repetir la extracción y caducar/cerrar sesión de prueba: confirmar repetibilidad y necesidad de interacción, sin bucles de intentos ni evasión de seguridad.
- [ ] Crear fixtures nuevos enteramente sintéticos que reflejen el esquema observado. Incluir dos compras iguales legítimas, devolución, pending/booked, cuota, dos páginas y página de sesión caducada. No «anonimizar» superficialmente un HAR completo.
- [ ] Completar decisión: selected-source, versión de formato observada, booked/pending/balances, histórico, paginación, login/MFA, coste, límites y problemas. Preferencia: API gratuita acreditada; descarga local; lectura estructurada de sesión; DOM.

**Cierre:** al menos una fuente devuelve compras reales y se repite sin descarga/importación manual. Si ninguna funciona, documentar el impedimento y continuar investigación específica; no ejecutar un conector imaginario ni cerrar la issue. El usuario no necesita aprobar una supuesta solución todavía no probada.

**Progreso 2026-09-14:** página pública de Kutxabank accesible; el navegador integrado bloqueó la banca online antes del login con `ERR_BLOCKED_BY_CLIENT`. Se solicitó acceso interactivo del titular desde su navegador habitual. Véase [evidencia de ejecución](../../banking/kutxabank-connector-evidence.md). La tarea 1 no está completada y el bloqueo no demuestra incompatibilidad del banco.

**Progreso 2026-09-15:** sesión compartida de Edge accesible. El titular demuestra descarga manual al desconectar la depuración; con ella activa se reproduce `ERR_BLOCKED_BY_CLIENT`. Archivo real inspeccionado localmente: XLS BIFF8, cuatro columnas, datos desde fila 9, sin columna Situación. No equivale al XLSX aceptado actualmente.

La tabla DOM se ha leído dos veces para agosto (10 filas) y septiembre hasta el día 15 (9 filas, una pendiente), con resultados idénticos en cada repetición. Se prioriza este mecanismo como candidato porque conserva Situación y funciona con la conexión activa. Quedan pendientes límites de historial/paginación, segunda tarjeta, identidad y caducidad de sesión.

**Ajuste del orden dentro de tarea 1:** preparar el lector puro `src/cards/kutxabank-table.ts` y sus fixtures sintéticos antes de la integración de tareas 2–6. Las 13 pruebas verifican formato observado, pendientes, duplicados legítimos y eliminación de números de tarjeta; no conectan con la aplicación ni acreditan automatización completa. No convertir una situación vacía en `booked` hasta confirmar su significado. En la automatización verificar ambos campos de fecha antes de MOSTRAR y el intervalo de todas las filas devueltas.

Segunda tarjeta: Últimos devuelve 20 filas; un intervalo amplio solicita autorización adicional por móvil. Se ha dejado el desafío al titular. El controlador necesita distinguir selección sin consulta, desafío de autorización, sesión caducada y tabla vacía legítima; ninguna pantalla sin tabla debe cerrar una sincronización como correcta. Verificación del lector y regresiones: `npm run check`, 55 archivos, 295 pruebas pasadas y 2 omitidas. La tarea 1 continúa abierta hasta resolver las comprobaciones restantes.

**Actualización tras autorización del titular:** intervalo del 1 de junio al 15 de septiembre recorrido dos veces, 65 movimientos en cuatro páginas (20/20/20/5), idénticos entre recorridos y dentro de fechas. Se ha observado el fin por desaparición de SIGUIENTES, conservando ANTERIORES. La lectura DOM paginada queda seleccionada como mecanismo candidato para la implementación. El bloqueo de código móvil está resuelto; quedan validación de identidad, semántica contable y sesión/runtime de la aplicación.

Se añade `src/cards/kutxabank-history.ts` con 14 pruebas sintéticas: recorrido completo, contexto de producto/fechas, repetición de páginas, autorización, sesión caducada, carga pendiente, cancelación y protección de errores. Es una pieza sin controlador de navegador ni persistencia; tareas 2–7 siguen pendientes. El controlador deberá esperar a que termine cada actualización y comprobar la primera página al reiniciar una consulta.

## Tarea 2: identidad estable y migración sin perder historial

**Archivos a crear:** `src/products/product-identity.ts`, `tests/unit/product-identity.test.ts`, `tests/unit/product-identity-migration.test.ts`; nueva migración `014_product_identity.sql` y entrada en `src/storage/migrations/manifest.json` si 014 sigue libre.

**Archivos a modificar:** `src/storage/repositories/account-repository.ts`, `src/transactions/transaction-mapper.ts`, `src/transactions/movement-key.ts`, `src/transactions/deduplication.ts`, `src/settings/accounts-config-store.ts`; pruebas correspondientes y `migration-manifest.test.ts`.

**Contrato de nueva clave**, independiente del identificador mutable del proveedor:

```ts
export interface ProductScope {
  provider: string;
  environment: "sandbox" | "production";
  connectionId: string;
  productId: string;
}
export function productScopeKey(scope: ProductScope): string;
// Implementation: sha256(stableJson([scope.provider, scope.environment,
//   scope.connectionId, scope.productId])). productId is accounts.id.
```

- [ ] Escribir primero pruebas de aislamiento y ejecutarlas en rojo. Caso mínimo:

```ts
import { expect, test } from "vitest";
import { productScopeKey } from "../../src/products/product-identity.js";

test("isolates the same external product across connections", () => {
  const scope = { provider: "kutxabank-browser", environment: "production" as const,
    connectionId: "person-a", productId: "local-card" };
  expect(productScopeKey(scope)).not.toBe(
    productScopeKey({ ...scope, connectionId: "person-b" })
  );
  expect(productScopeKey(scope)).not.toBe(
    productScopeKey({ ...scope, environment: "sandbox" })
  );
});
```

- [ ] Implementar aliases externos vinculados a `accounts.id`, únicos por conexión/esquema/valor; conexión ya fija proveedor/entorno. Conservar IDs locales al renovar sesión; validar compatibilidad de tipo antes de unir aliases. Dos coincidencias contradictorias generan conflicto visible, sin `mergeAccount` automático.
- [ ] Mantener hashes IBAN existentes; aceptar solo descriptores no IBAN documentados/comprobados. No usar nombre, máscara ni cuatro dígitos como identidad. Decisión posterior del 24-09-2026 para Kutxabank: el titular autorizó una huella HMAC-SHA-256 del PAN observado, calculada con la clave local y sin persistir el número completo, para distinguir tarjetas con la misma terminación entre sesiones. Las tarjetas anteriores sin huella no se vinculan automáticamente por los cuatro dígitos.
- [ ] Diseñar migración transaccional de claves de movimiento y aliases legacy. Enumerar todas las referencias a `movement_key` y baselines XLSX antes de actualizar; conservar resolución de referencias antiguas. No regenerar transacciones ni cambiar cuenta/revisión/categoría por heurística.
- [ ] Cubrir renovación UID con identidad estable, colisión entre personas, varios productos con máscara igual, tarjeta sin IBAN, renovación ambigua y datos legacy. Repetir importación tras migración: cero inserts nuevos para filas existentes.
- [ ] Ejecutar pruebas de migración y regresión de deduplicación/exportación; revisar diff de SQL y fixtures. Si faltan datos para reparar una colisión histórica, registrar revisión requerida en lugar de inventar atribución.

Comando: `npm test -- tests/unit/product-identity.test.ts tests/unit/product-identity-migration.test.ts tests/unit/account-repository.test.ts tests/unit/reauthorization.test.ts tests/unit/movement-key.test.ts tests/unit/deduplication.test.ts tests/unit/csv-exporter.test.ts tests/unit/migration-manifest.test.ts`.

## Tarea 3: contrato común y adaptación de Enable Banking

**Crear:** `src/providers/contracts.ts`, `src/providers/provider-registry.ts`, `src/providers/enable-banking-provider.ts`, `tests/unit/provider-contract.test.ts`, `tests/unit/provider-routing.test.ts`.

**Modificar:** `src/application/create-application.ts`, `src/sync/sync-service.ts`, `src/sync/sync-runner.ts`, `src/auth/authorization-service.ts`, `src/auth/disconnect-service.ts`, `src/cli.ts`, mapper y configuración; mover tipos de entrada neutros desde `enable-banking/schemas.ts` conservando validación específica en el adaptador.

**Contratos propuestos:** `TransactionInput` es el tipo estructural hoy denominado `ProviderTransaction`, trasladado al dominio de transacciones; no hacer que otro conector importe el SDK AIS. Las fechas y decimales se validan al entrar, no se convierten a float.

```ts
import type { TransactionInput } from "../transactions/transaction-input.js";
export type Capability = "unknown" | "supported" | "unsupported";
export interface ProductCapabilities {
  balances: Capability; booked: Capability; pending: Capability;
}
export interface ConnectionContext {
  id: string; provider: string; environment: "sandbox" | "production";
}
export interface FinancialProduct {
  externalId: string; type: string | null; label: string | null;
  currency: string | null;
  identifiers: Array<{ scheme: string; value: string; stable: boolean }>;
  capabilities: ProductCapabilities;
}
export interface FinancialBalance {
  amount: string; currency: string; type: string | null;
  referenceDate: string | null;
}
export interface TransactionPage {
  transactions: TransactionInput[]; nextCursor: string | null;
}
export interface PageRequest {
  product: FinancialProduct; dateFrom: string; dateTo: string;
  cursor: string | null; signal: AbortSignal;
}
export interface FinancialProvider {
  readonly id: string;
  ensureSession(context: ConnectionContext, interactive: boolean): Promise<void>;
  discover(context: ConnectionContext): Promise<{
    products: FinancialProduct[]; complete: boolean;
  }>;
  balances(context: ConnectionContext, product: FinancialProduct): Promise<FinancialBalance[]>;
  transactions(context: ConnectionContext, request: PageRequest): Promise<TransactionPage>;
  disconnect(context: ConnectionContext): Promise<void>;
}
```

- [ ] Crear `src/transactions/transaction-input.ts` en esta tarea; definir ahí el tipo trasladado y actualizar imports. Añadir pruebas en rojo de enrutamiento: cada conexión usa su proveedor y sesión, manual-card no pasa por AIS, proveedor desconocido se rechaza sin llamada de red.
- [ ] Implementar registry con instancias por proveedor y credenciales seleccionadas por conexión/perfil de aplicación, no por alias visible. Mantener compatibilidad de la configuración AIS actual como perfil por defecto.
- [ ] Adaptar Enable Banking sin cambiar endpoints ni scopes. Pasar `provider` desde conexión al mapper; usar clave estable de tarea 2. Mantener códigos/Retry-After/PSU context y reautorización existentes dentro del adaptador.
- [ ] Cambiar consultas hardcodeadas de sync/listado/desconexión solo donde corresponda; evitar que el nuevo conector intente descifrar una sesión AIS o viceversa. Añadir capacidades desconocidas por defecto, no convertir errores temporales en unsupported.
- [ ] Unificar ciclo de páginas: conservar límites actuales de filas/bytes/páginas, cursor repetido, ventanas y buffer/commit. Descubrimiento `complete=false` nunca desactiva productos ausentes. Error posterior no avanza watermark ni produce export completo engañoso.
- [ ] Verificar fallos parciales: tarjeta sin saldo no bloquea booked, cuenta con fallo no bloquea otra conexión, 429 difiere reintento, sesión caducada solicita autenticación sin resetear datos.

Comandos: `npm test -- tests/unit/provider-contract.test.ts tests/unit/provider-routing.test.ts tests/unit/sync-accounts-selection.test.ts tests/unit/sync-balances.test.ts tests/unit/sync-runtime-reauthorization.test.ts tests/unit/rate-limit-persistence.test.ts tests/integration/pagination.test.ts`; `npm run typecheck`.

## Tarea 4: conector seleccionado y secretos locales

**Ruta recomendada actualmente:** `kutxabank-browser`; solo si tarea 1 la demuestra. Si aparece API gratuita acreditada, usar su adaptador con los mismos contratos y omitir infraestructura de navegador innecesaria. La elección y nombres concretos del adaptador se registran en el documento de evidencia antes de esta tarea.

**Crear para ruta local:** `src/providers/kutxabank/browser-provider.ts`, `src/providers/kutxabank/statement-parser.ts`, `src/providers/kutxabank/session-store.ts`, `tests/unit/kutxabank-statement-parser.test.ts`, `tests/unit/kutxabank-session-store.test.ts`, `tests/integration/kutxabank-browser.test.ts`, fixtures sintéticos en `tests/fixtures/kutxabank/`.

**Modificar:** registry, `src/config.ts`, `src/desktop/runtime-paths.ts`, `src/desktop/main.ts`, `src/logger.ts`, `src/storage/raw-store.ts`; `package.json`, lockfile y scripts de paquete solo si hay nueva dependencia. Reutilizar límites XLSX de `src/cards/xlsx-limits.ts`; extraer utilidades de lectura de `card-import-service.ts` únicamente donde la prueba demuestre formato compartido.

**Sesiones:** almacenar blobs cifrados fuera de Git bajo entorno/conexión. Puerto inyectable para test y runtime:

```ts
export interface SessionVault {
  load(environment: string, connectionId: string): Promise<Uint8Array | null>;
  save(environment: string, connectionId: string, plaintext: Uint8Array): Promise<void>;
  remove(environment: string, connectionId: string): Promise<void>;
}
```

- [ ] Escribir pruebas en rojo de round-trip, aislamiento por conexión/entorno, blob manipulado, cifrado no disponible y eliminación. Ninguna llamada a `save` debe dejar la cadena sintética secreta en disco/log. Usar backend simulado en Vitest y prueba real Windows separada.
- [ ] Implementar vault mediante `safeStorage` de Electron/DPAPI en main y acceso restringido. Si cifrado no disponible, exigir sesión efímera/login, sin fallback a plaintext. DPAPI protege frente a otros usuarios, no frente a todos los procesos del mismo usuario; no prometer más. No guardar contraseña/PIN/OTP; inicialmente persistir solo estado mínimo reutilizable si la prueba lo permite.
- [ ] Lanzar contexto dedicado, nunca perfil personal habitual ni puerto CDP público. Login visible cuando haga falta, restauración de estado descifrado en memoria. Sin trazas, vídeo, HAR o screenshots reales por defecto. No exponer cookies ni respuestas del banco al renderer de Kakebo.
- [ ] Implementar exclusivamente el mecanismo observado en tarea 1. Para descarga, esperar evento y final de archivo; validar formato y producto; leer todas las páginas/periodos; normalizar con parser puro. Para JSON/DOM, validar estructura y fin real del listado. Selectores y rutas bancarias se obtienen de la evidencia; no se fijan valores inventados en este plan.
- [ ] Entregar `TransactionInput` con origen de conexión y referencias estables del extracto cuando existan. Para filas sin ID, mantener ocurrencias y contexto de ciclo; el hash del fichero no es identidad de todas las compras. Probar extractos solapados y mismos importes en días distintos.
- [ ] Restringir automatización a operaciones de lectura observadas; no usar una regla solo por verbo HTTP porque consultas pueden ser POST. Lista permitida de operaciones/dominios, cierre ante navegación o esquema inesperados; no sortear MFA/CAPTCHA/antibot.
- [ ] Emitir códigos seguros (`REAUTHENTICATION_REQUIRED`, `FORMAT_CHANGED`, `RATE_LIMITED`, `INCOMPLETE_PAGE`) sin interpolar cuerpo HTML/URL/token. Limitar reintentos y permitir cancelación; eliminar temporales al terminar; fallo de limpieza posterior al commit se informa sin perder movimientos ya guardados.
- [ ] Pruebas de integración con portal sintético local: sesión caducada, descarga incompleta, dos tarjetas, dos personas, paginación, cambio DOM, cancelación y repetición idempotente. Ningún acceso real en CI.
- [ ] Verificar navegador disponible en paquete portable: resolver ejecutable/versión, mensajes si falta, ciclo de inicio/cierre sin procesos huérfanos. Si se incorpora Chromium, incluirlo explícitamente en empaquetado; no asumir que el Electron instalado equivale al navegador requerido por Playwright.

Comandos: `npm test -- tests/unit/kutxabank-statement-parser.test.ts tests/unit/kutxabank-session-store.test.ts tests/integration/kutxabank-browser.test.ts tests/unit/raw-store.test.ts tests/unit/card-import-service.test.ts`; `npm run build`.

Referencias técnicas: [estado autenticado Playwright](https://playwright.dev/docs/auth), [descargas](https://playwright.dev/docs/downloads), [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

## Tarea 5: liquidaciones y conciliación entre fuentes

**Crear:** `src/transactions/economic-treatment.ts`, `src/transactions/source-reconciliation.ts`, `tests/unit/economic-treatment.test.ts`, `tests/unit/source-reconciliation.test.ts`, migración `015_transaction_reconciliation.sql` si sigue libre.

**Modificar:** repositorio de transacciones, exportador, configuración de columnas, auditoría y manifiesto de migración. Guardar relaciones de productos, conciliaciones, motivo/estado y cambios del usuario; no borrar filas origen.

**Contrato numérico de exportación:** `expenseAmount` positivo para gasto, negativo para devolución, cero para traslado confirmado o fila no representativa. Monedas nunca se agregan entre sí.

```ts
export function expenseContribution(input: {
  amount: string;
  treatment: "normal" | "internal-transfer" | "review-required";
  representative: boolean;
}): string;
```

- [ ] Escribir pruebas en rojo, incluyendo este ejemplo de aceptación:

```ts
import { expect, test } from "vitest";
import { expenseContribution } from "../../src/transactions/economic-treatment.js";
test("retains settlement without counting it as another purchase", () => {
  expect(expenseContribution({ amount: "-120", treatment: "internal-transfer",
    representative: true })).toBe("0");
  expect(expenseContribution({ amount: "-50", treatment: "normal",
    representative: true })).toBe("50");
  expect(expenseContribution({ amount: "10", treatment: "normal",
    representative: true })).toBe("-10");
});
```

- [ ] Implementar aritmética exacta de strings; `normal` y `review-required` conservan contribución de importe, sin exclusión silenciosa. Estado review-required se comunica como total sin conciliar. `representative=false` solo surge de conciliación confirmada, nunca de similitud automática.
- [ ] Guardar vínculo tarjeta/cuenta de cargo, ciclo y referencias. Proponer liquidación por evidencia de fuente, cobertura del ciclo e importe/divisa; confirmar automáticamente solo cuando sea inequívoco. Probar pagos parciales, cuotas, devolución, intereses, comisión y ciclo incompleto. No clasificar intereses como transferencia de principal.
- [ ] Implementar sugerencias manual/automático solo entre productos explícitamente asociados. Coincidencias múltiples requieren selección; dos compras iguales no colapsan. Confirmar/revertir modifica relación y contribución, deja filas y auditoría intactas.
- [ ] Probar persistencia de conciliación tras reimportar/reautorizar y migración. Contribución de compras -50/-30/-40 + liquidación -120 confirmada = 120 EUR. Todas las filas y sus importes originales siguen consultables.
- [ ] Ejecutar `npm test -- tests/unit/economic-treatment.test.ts tests/unit/source-reconciliation.test.ts tests/unit/deduplication.test.ts tests/unit/csv-exporter.test.ts`.

## Tarea 6: escritorio, exportación y capacidades parciales

**Modificar:** `src/desktop/contracts.ts`, `main.ts`, `preload.cjs`, `renderer.ts`, `index.html`, `locales/es.json`, `locales/en.json`, `account-settings.ts`, `src/export/csv-exporter.ts`, `src/settings/export-settings-store.ts`, `src/storage/repositories/desktop-run-repository.ts`, `src/desktop/audit-renderer.ts`. Crear `tests/unit/product-capabilities.test.ts` y `tests/unit/product-review.test.ts`; extender pruebas actuales de configuración/exportación/IPC aplicables.

- [ ] Diseñar con las skills UI aplicables al ejecutar esta tarea. Reutilizar componentes y modales de la app; mostrar banco, conexión, origen, tipo, alias y capacidades. «Conectar tarjetas Kutxabank» conserva la conexión AIS de cuentas.
- [ ] Exponer controles independientes de sync/export existentes; distinguir no disponible, no observado, fallo temporal y requiere autenticación. Saldos ausentes no se representan como cero; LOAN solo saldo no bloquea booked de tarjetas.
- [ ] Añadir revisión explícita de identidad ambigua, vínculo manual/automático y liquidación; confirmar/revertir bajo lock y con entrada validada en main. IPC recibe IDs locales y decisiones, nunca secretos o rutas bancarias arbitrarias.
- [ ] Incorporar `economicTreatment`, `expenseAmount`, `reconciliationReference` a columnas configurables con migración del perfil que preserva orden y preferencias. Añadir perfil/vista de gasto conciliado explícito; conservar Amount original. Tests de round-trip XLSX/CSV y comparación del ejemplo 120 EUR, sin sumar divisas diferentes.
- [ ] Mantener colores/baselines por fuente: importaciones manuales siguen cards; sincronización automática banking. Una sincronización no borra el resaltado del otro origen.
- [ ] Evitar incluir límite de crédito como saldo patrimonial. Para préstamos con desglose desconocido, mostrar información original y revisión, sin inventar principal/interés.
- [ ] Ejecutar `npm test -- tests/unit/product-capabilities.test.ts tests/unit/product-review.test.ts tests/unit/account-settings.test.ts tests/unit/csv-exporter.test.ts tests/unit/desktop-run-repository.test.ts tests/unit/localization-store.test.ts`; `npm run verify:desktop-assets`.

## Tarea 7: entrega verificable

**Modificar:** `README.md`, `docs/DESKTOP_APP.md`, `docs/PORTABLE_PACKAGE.md`, documento de evidencia y matriz; `.env.example`/configuraciones de ejemplo solo con campos no sensibles realmente incorporados.

- [ ] Ejecutar en Windows `npm run check` y `npm run build`. Corregir fallos introducidos; registrar cualquier fallo ajeno sin ocultarlo ni declarar validación completa.
- [ ] Si se añadió dependencia/runtime, ejecutar `npm run audit:production`, `npm run desktop:dist` y comprobación del portable con el nuevo conector; verificar también SQLite empaquetado y cierre de procesos. No publicar release.
- [ ] Validar UI completa en paquete: conectar, login/MFA, seleccionar dos productos, sync, reintento, revisión, exportación, desconexión y reapertura. Verificar que desconectar tarjetas no revoca AIS de cuentas.
- [ ] Ejecutar protocolo real de la spec para el conector seleccionado, con titular: dos extracciones repetibles, periodo cerrado/abierto, renovación, liquidación y comparación local contra portal. Completar matriz con fecha real, límites observados y resultado. Una prueba simulada no cumple aceptación bancaria.
- [ ] Verificar aislamiento de personas/conexiones con fixtures y, cuando estén disponibles, conexiones reales autorizadas. BBVA se investiga separadamente; su ausencia no retrasa Kutxabank. Mantener condiciones de uso de cada perfil de proveedor.
- [ ] Confirmar que secretos, sesiones y datos reales no aparecen en Git, logs, raw, error UI ni exports de diagnóstico. Auditar archivos nuevos concretos, sin imprimir posibles valores secretos.
- [ ] Documentar frecuencia, ordenador encendido, login periódico, recuperación tras cambio del banco y vuelta a XLSX. Si ninguna fuente gratuita funciona, no cerrar #26: reportar el resultado concreto.
- [ ] Revisar `git diff --check`, diff completo y estado; no commit/push salvo petición explícita. Entregar evidencia y limitaciones restantes.

## Cobertura de criterios de la issue

| Criterios | Tarea y evidencia de cierre |
|---|---|
| Prueba Enable Banking y matriz | 1: resultado aportado por usuario con procedencia; completar detalles sin bloquear fallback |
| Alternativa gratuita y extracción práctica | 1 + 4 + 7: fuente real repetible y condiciones vigentes |
| BBVA investigado sin bloquear | Spec documental + 7 cuando haya conexión |
| Selección y capacidades por producto | 3 + 6 |
| Multiconexión, identidad sin PAN, renovación | 2 + 3 + 4 + 7 |
| Normalización, categoría, auditoría, export | 3 + 5 + 6 |
| Liquidaciones sin doble gasto | 5 + 6 + ejemplo real de 7 |
| XLSX conservado y procedencia | 4 + 5 + regresiones de importación/export |
| Secretos fuera de Git, cifrado y errores seguros | 4 + 7 |
| Pruebas CI sin credenciales reales | 2–6 con fixtures sintéticos |
| Documentación de límites/autenticación | 1 + 7 |

## Verificación de esta entrega de planificación

La entrega inicial añadió la spec y este plan, con revisión de fuentes, referencias, cobertura y estado Git. La ejecución posterior se registra en el documento de evidencia; no se afirma que la feature funcione hasta completar las comprobaciones de la tarea 7.

## Ampliación solicitada durante la validación (22 de septiembre de 2026)

- [x] Conservar un catálogo local por conexión y el estado de cada casilla de sincronización en SQLite. Una nueva detección añade tarjetas sin borrar ni desmarcar las ausentes.
- [x] Procesar cada tarjeta marcada por separado; devolver avisos por tarjeta al final y continuar con las demás. Rechazar asociaciones ambiguas basadas solo en los cuatro últimos dígitos.
- [x] Mostrar el catálogo sin sesión bancaria y sincronizarlo mediante una nueva detección interna, sin exigir «Actualizar tarjetas» para cada ejecución.
- [x] Reproducir en la ventana bancaria la opción de periodo elegida entre las seis observadas. «Entre fechas» conserva su formulario. Las pruebas sintéticas comprueban la selección nativa y el aislamiento por tarjeta.
- [x] Ejecutar `npm run check`: 62 archivos, 386 pruebas pasadas y 2 omitidas.
- [ ] Validar en el portable actualizado las casillas persistentes, la ausencia de una tarjeta y los cinco periodos predefinidos. Comprobar el resultado y la exportación de cada tarjeta frente al portal.
