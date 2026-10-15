# Evidencia de selección del conector Kutxabank

Fecha de inicio: 2026-09-14. Rama: `feat/26-kutxabank-card-sync`.

## Estado

Descubrimiento en curso, actualizado el 2026-09-15. Se ha leído el listado real de tarjetas en una sesión de Edge abierta por el titular y se ha repetido la consulta de un periodo cerrado y otro abierto. El DOM es la fuente candidata de automatización. Existe un lector de filas con pruebas sintéticas, todavía sin integrar en la aplicación; faltan sesión, identidad, cobertura histórica y sincronización.

| Comprobación | Evidencia | Resultado |
|---|---|---|
| Enable Banking | El usuario informa que ve cuentas, pero no sus tarjetas | Insuficiente para sus tarjetas; conservar AIS para cuentas |
| Alternativas gratuitas | Investigación enlazada debajo | Ninguna con cobertura real de sus tarjetas acreditada |
| Portal público | Se abrió la página oficial de tarjetas y se observó el enlace Banca online | Accesible |
| Banca online desde navegador integrado | El intento de abrir el enlace oficial devolvió `net::ERR_BLOCKED_BY_CLIENT` antes del login | Bloqueo de la herramienta/navegador; no demuestra incompatibilidad de Kutxabank con automatización local |
| Autenticación bancaria | El titular abrió una sesión autenticada y compartió Edge | Acceso al resumen y a movimientos de tarjetas confirmado |
| Listado de tarjetas | Dos tarjetas seleccionables; columnas Fecha, Concepto, Fecha imputación, Importe y Situación | Lectura repetida de agosto y septiembre confirmada en una tarjeta; cobertura histórica pendiente |
| Exportación automatizada | Control DESCARGAR XLS; al pulsarlo navega a `pages/comun/descargar.jsp` | Edge muestra `ERR_BLOCKED_BY_CLIENT`, también en la nueva sesión del 15 de septiembre |
| Exportación manual sin depuración | El titular informa que desconectar la depuración permite descargar. Archivo indicado localizado y leído localmente | XLS BIFF8, una hoja, cuatro columnas y 20 filas de movimientos; no demuestra descarga automatizada |
| JSON autenticado | No investigado | Sin evidencia |

Se leyeron movimientos en la pestaña compartida y en el archivo indicado; no se guardaron datos bancarios reales en el repositorio, fixtures ni documentos de evidencia. No se capturaron credenciales ni se exportó la sesión. No se intentó eludir los bloqueos. La relación entre depuración y descarga procede de la prueba comunicada por el titular; su causa interna no está diagnosticada.

## Observaciones del portal autenticado

- Ruta observada: `pages/tarjetas/tarjetas_movimientos_seleccion.iface`.
- Filtros visibles: últimos (máximo tres meses), última semana, últimos quince días, último mes, hoy y entre fechas. Su presencia no acredita que se haya comprobado cada intervalo ni toda la historia.
- El listado contiene compras, devoluciones, pagos de recibo y una operación marcada como pendiente. La nota del portal define esta última como operación autorizada pendiente de recibir.
- Los números completos de tarjeta aparecen en controles y pueden aparecer dentro del concepto de pago de recibo. Cualquier futura extracción debe eliminar esos números antes de persistir conceptos, registros de diagnóstico o datos brutos.
- El enlace observado tiene ID `formListado:resourceExcel`; las tablas `formListado:data` y `formListado:dataContent`. Son observaciones de esta sesión, no una garantía de estabilidad.
- Archivo examinado: BIFF8 dentro de contenedor OLE, 62 468 bytes. Cabeceras en fila 7, fila 8 vacía y movimientos desde fila 9: A fecha (texto dmy), B concepto, C fecha valor (texto dmy), D importe de la operación (número). Coincide con las posiciones configuradas, pero el importador actual exige XLSX y no puede leerlo directamente.
- El XLS carece de columna Situación. Los asteriscos encontrados están en descripciones de comercios, por lo que no sirven para inferir estado pendiente. No se ha comparado cada fila del archivo con la tabla ni se ha acreditado cómo representa las autorizaciones pendientes.
- Consulta DOM de agosto de 2026: 10 filas, ninguna marcada pendiente; repetición idéntica de las cinco celdas de todas las filas. Consulta del 1 al 15 de septiembre: 9 filas, una `P (*)`; repetición también idéntica. Comparación en memoria, sin conservar los datos.
- La primera introducción de fechas dejó vacío el extremo final: el portal devolvió movimientos posteriores al mes solicitado. Al rellenarlo y verificar los campos antes de MOSTRAR, todas las fechas quedaron dentro del intervalo. El futuro controlador debe verificar ambos extremos y validar el rango devuelto.
- Cada movimiento ocupa una fila exterior con otra fila anidada: contar todos los `tr` duplica el recuento. Selector observado de filas: `[id="formListado:dataContent"] > tbody > tr`; las cinco celdas están dentro de cada fila y tienen IDs terminados en `gridContent-0-0` a `gridContent-0-4`.
- Segunda tarjeta: al cambiar de producto el portal deja una pantalla sin consulta; hay que seleccionar Movimientos y después el periodo. Últimos devuelve 20 filas sin controles visibles de paginación; este recuento no acredita que sean todos los movimientos de tres meses.
- Al consultar en la segunda tarjeta del 1 de junio al 15 de septiembre, el portal mostró «Autorización de consulta»: algunas consultas requieren autorización adicional mediante clave recibida en el móvil. Se dejó el desafío para el titular; no se introdujo ni solicitó compartir el código. El conector deberá suspender esa consulta y conservar el estado pendiente de autorización, sin interpretar la tabla ausente como cero movimientos.
- El titular completó esa autorización el 15 de septiembre. Se recorrió el intervalo completo dos veces: cuatro páginas de 20, 20, 20 y 5 filas (65 movimientos). Las cinco celdas de cada fila fueron idénticas entre recorridos, y todas las fechas quedaron dentro del intervalo. La primera página muestra SIGUIENTES; las intermedias ANTERIORES y SIGUIENTES; la última solo ANTERIORES. IDs observados: `formListado:siguiente` y `formListado:anterior`.
- Las actualizaciones son asíncronas: una lectura inmediata tras MOSTRAR o SIGUIENTES puede devolver la página anterior. Debe esperarse un estado coherente, comprobar que una consulta nueva empieza sin ANTERIORES y detenerse ante páginas repetidas. Si dos páginas legítimas fueran completamente indistinguibles, la respuesta segura es declarar lectura incompleta; no eliminar movimientos por suposición.

## Lector preparado durante el descubrimiento

`src/cards/kutxabank-table.ts` valida las cinco cabeceras observadas, fechas reales, importes EUR con formato español y estado `P (*)`. Conserva un estado vacío como `unspecified`, sin inventar que esté contabilizado. Mantiene compras iguales, oculta secuencias de números de tarjeta y rechaza el lote ante una fila inesperada sin incluir datos de origen en el error.

No abre navegadores, descarga XLS, persiste datos ni sustituye al importador manual. Sus 13 pruebas son enteramente sintéticas; no acreditan por sí solas el conector de extremo a extremo.

`src/cards/kutxabank-history.ts` añade recorrido mediante un lector inyectado, sin incluir todavía el controlador real de navegador. Acumula todas las páginas antes de devolverlas, valida producto e intervalo efectivo, comprueba fechas de movimientos y controles de anterior/siguiente, limita páginas, respeta cancelación y rechaza repeticiones o interrupciones. Los errores del navegador se sustituyen por códigos seguros. Sus 14 pruebas sintéticas incluyen autorización, sesión caducada, actualización pendiente, página antigua al reiniciar y respuesta vacía después de una página no final.

## Reutilización comprobada en el repositorio

El ejemplo `config/card-import-profiles.example.json` ya define un formato Kutxabank: datos desde fila 9, fecha A, descripción B, fecha valor C, importe D, formato dmy, coma decimal y EUR. Es configuración existente, no confirmación de que el portal actual descargue ese formato.

La prueba existente `deduplicates overlapping Kutxabank workbooks and categorizes new rows` en `tests/unit/card-import-service.test.ts` usa ficheros sintéticos y comprueba importaciones solapadas, repetición y categorización. Esto permite evaluar reutilización si la descarga real coincide; no acredita descarga automatizada ni cobertura bancaria.

## Próxima comprobación

La lectura DOM paginada se selecciona como mecanismo candidato: se ha demostrado sobre compras reales, dos tarjetas, periodo abierto/cerrado y repetición de todas las páginas de un intervalo autorizado. Quedan por validar identidad estable, caducidad/restauración de sesión y conexión local empaquetable. Determinar la semántica del estado vacío y conciliar archivo y DOM antes de tratar esos movimientos como contabilizados. No se ha acreditado el máximo histórico disponible ni terminado la integración.

La autorización del intervalo amplio ya está resuelta; no hay un código pendiente de introducir. La evidencia de 65 filas corresponde al intervalo probado, no a todo el historial de la tarjeta.

## Verificación de la base

`npm run check` terminó con código 0: lint y typecheck correctos; 54 archivos de pruebas pasados, 282 tests pasados y 2 omitidos. Ejecución realizada antes de modificar código de aplicación. No prueba la funcionalidad todavía no implementada.

Tras añadir el lector, `npm run check` terminó con código 0 el 2026-09-15: lint y typecheck correctos; 55 archivos de pruebas pasados, 295 tests pasados y 2 omitidos. Incluye las 13 pruebas nuevas del lector, ejecutadas primero en rojo y después en verde. No se ha verificado aún un conector integrado ni su empaquetado.

Última verificación, tras añadir el recorrido paginado: `npm run check` terminó con código 0, lint y typecheck correctos; 56 archivos, 309 pruebas pasadas y 2 omitidas. El recorrido añade 14 pruebas; no sustituye la validación pendiente del controlador de navegador y la integración de escritorio.

## Verificación de la integración — 2026-09-16

La implementación ya conecta el lector con una fuente local de tarjetas, persistencia transaccional, ventana Electron aislada, IPC, panel de escritorio, conciliación explícita y exportación. Las decisiones vigentes están en el [plan actualizado](../superpowers/plans/2026-09-14-issue-26-kutxabank-card-sync.md) y la [guía de uso](kutxabank-card-sync.md).

- `npm run check`: código 0; lint y TypeScript correctos; 61 archivos, 362 pruebas pasadas y 2 omitidas.
- `npm run build`: código 0, incluidos los recursos del escritorio.
- `npm run audit:production`: código 0, cero vulnerabilidades.
- `npm run desktop:dist`: generación local comprobada, ABI de SQLite empaquetado y migraciones hasta v14 correctas. El primer intento restringido falló por acceso de MSBuild; la repetición con permisos de compilación pasó.
- Tras las correcciones visuales se regeneró el portable con `electron-builder` y se repitieron `desktop:verify-package` y `desktop:package-bundle`, ambos con código 0. Artefacto local: `release/portable/Kakebo-Harvester-1.0.2-x64-complete-package.zip`. No se publicó ninguna release.
- Comprobación visual del renderer con un puente IPC sintético local: selección de tarjeta/conexión, activación de sincronización y presentación del resultado. Corregidos estados ocultos y etiquetas accesibles. No se accedió a datos bancarios en esta prueba.
- No se ha probado todavía el acceso real desde Electron. La sesión Edge compartida ya no estaba disponible al retomar la validación. No se acreditan las redirecciones del login, MFA, lectura repetida de ambas tarjetas o restauración de sesión dentro del paquete.

La evidencia anterior de Edge acredita la fuente y su formato; la comprobación del paquete acredita su construcción y base de datos. Ninguna equivale a aceptación de extremo a extremo del conector ni justifica cerrar la issue.

## Incidencia de apertura — 16 de septiembre de 2026

El titular informa de cierre inmediato con `SOURCE_UNAVAILABLE`. El enlace directo a `Gestor` con `PreLoginFuncion` falla también al abrirlo desde Edge compartido (`ERR_BLOCKED_BY_CLIENT`); ese error del navegador no demuestra por sí solo la causa exacta dentro de Electron.

Se observa la entrada habitual en `https://portal.kutxabank.es/cs/Satellite/kb/es/banca-personal`. Su formulario apunta al `Gestor` de `www.kutxabank.es`; tras el login realizado por el titular aparece una segunda pestaña en la ruta de resumen ya conocida. El controlador inicial denegaba todas las ventanas nuevas y solo permitía el origen de banca interna.

Corrección: abrir la página pública observada, admitir únicamente esa página adicional y una ventana bancaria secundaria en la misma partición efímera. El formulario y su envío permanecen bajo control del banco; no se leen ni retransmiten credenciales en la aplicación. Se bloquean destinos ajenos y ventanas adicionales. Cerrar cualquiera de las ventanas termina el grupo y descarta la sesión. Los fallos de apertura distinguen `NAVIGATION_BLOCKED` y `BANK_LOAD_FAILED`, sin devolver URLs ni tokens. Las pruebas de regresión reprodujeron los fallos antes de corregirlos. El siguiente intento del titular con el paquete actualizado sigue siendo necesario para confirmar Electron.

Una redirección de un iframe que no esté permitida bloquea ese iframe, sin destruir la ventana principal. Verificación posterior: `npm run check`, código 0, 61 archivos, 367 pruebas pasadas y 2 omitidas. Se mantiene la comprobación bancaria real como pendiente.

El portable corregido se generó con `npm run desktop:dist`, código 0; SQLite empaquetado, migración v14 y ZIP completo verificados. Los cinco archivos cambiados de aplicación coinciden byte a byte con la compilación dentro de `app.asar`. Se restauró y comprobó el módulo SQLite para Node en el entorno de desarrollo. No se ha realizado ninguna importación bancaria real con esta versión.

## Cierre tras introducir credenciales — 17 de septiembre de 2026

El titular confirma que la entrada pública ya permanece abierta. Tras introducir sus credenciales observa una o dos ventanas y después se cierran todas. Aún no se conoce el evento inicial: el controlador destruye todo el grupo cuando se cierra un miembro, y también destruye una ventana ante una ruta no permitida. No se ha ampliado la lista de rutas ni cambiado esa política sin evidencia del recorrido real.

La versión de diagnóstico conserva los últimos 128 eventos del intento actual en `kutxabank-browser-diagnostic.json`, junto a la base de datos configurada. Al abrir una sesión nueva reemplaza el intento anterior. Registra ventanas numeradas, cierres en cascada, decisiones de navegación y popup, códigos numéricos de fallos de carga y del proceso. Solo conserva nombres de páginas bancarias con formato estático restringido; elimina parámetros de sesión, consultas, fragmentos y destinos externos. No lee formularios, credenciales, códigos, cookies, cabeceras ni movimientos para este diagnóstico. No se envía a ningún servidor. Se puede eliminar el archivo tras revisar la incidencia.

Los errores conocidos de navegación, cierre y proceso ya no se convierten indiscriminadamente en `SOURCE_UNAVAILABLE`. Las pruebas reproducen esa pérdida de causa y verifican el registro, su límite, el reinicio entre sesiones y el aislamiento de fallos al escribirlo. Falta reproducir el acceso real con esta versión para identificar y corregir el cierre; la instrumentación no acredita que el login esté resuelto.

Validación: `npm run check`, código 0, 61 archivos, 372 pruebas pasadas y 2 omitidas. `npm run desktop:dist`, código 0, incluido SQLite empaquetado, migración v14 y ZIP completo. Los cinco archivos de aplicación modificados coinciden byte a byte con los del `app.asar` generado.

El siguiente intento del titular sí identifica el cierre: se admite el popup y varias navegaciones a `Gestor`; a continuación, la ventana 2 se bloquea al navegar a `/NASApp/BesaideNet2/pages/login/login_poslogin.iface`. Se cierra esa ventana y después la ventana 1 en cascada. No consta fallo del proceso ni denegación de un segundo popup como causa de este intento.

Se añade esa página intermedia a la política de navegación de producción, compartida con las pruebas para comprobar la configuración real. Tres pruebas reprodujeron el cierre antes del cambio (`will-navigate`, `will-redirect`, `did-navigate`); comprueban también que una página desconocida del mismo banco sigue bloqueada. Se conserva el diagnóstico para detectar cualquier siguiente etapa aún no observada. Esta corrección resuelve el bloqueo identificado; la aceptación del login completo requiere un nuevo intento real.

Una segunda traza, producida al aceptar las cookies inmediatamente después de abrir la ventana, muestra otro cierre: la entrada pública se admite, la ventana 1 se destruye sin solicitud normal de cierre y después termina una navegación permitida a la misma entrada. No hay navegación bloqueada, popup, fallo de carga registrado ni caída del proceso. La secuencia corresponde a la cancelación `ERR_ABORTED` de la carga inicial cuando la aceptación de cookies inicia una recarga antes de que `loadURL` haya terminado; el controlador trataba cualquier rechazo de esa promesa como fallo y destruía la ventana.

La corrección conserva la ventana únicamente cuando el rechazo es exactamente `ERR_ABORTED`, la ventana sigue viva y su URL actual continúa dentro de la política. Los fallos de red, destinos inesperados y redirecciones bloqueadas mantienen el cierre seguro. El diagnóstico registra el caso como `load-aborted-continued` sin guardar consultas ni datos del formulario. La prueba de regresión reprodujo primero `BANK_LOAD_FAILED` y el cierre, y después confirmó que la ventana sigue disponible.

Validación conjunta de ambas correcciones: `npm run check`, código 0, 61 archivos, 376 pruebas pasadas y 2 omitidas. `npm run desktop:dist`, código 0; SQLite empaquetado y migraciones hasta v14 correctos, y ZIP completo verificado. Los cinco archivos modificados del runtime coinciden byte a byte con los incluidos en `app.asar`. Falta repetir ambos recorridos en la aplicación real: aceptar cookies de inmediato y completar el login.

## Cierre posterior al segundo factor — 22 de septiembre de 2026

El intento real confirma que la recarga rápida de cookies se conserva (`load-aborted-continued`) y que `login_poslogin.iface` se admite. La ventana de autorización adicional permanece abierta durante unos 23 segundos, hasta que el titular introduce y acepta el código del móvil. Después se permiten dos navegaciones a `Gestor`, seguidas por una navegación bloqueada bajo el mismo origen bancario que la primera versión del diagnóstico resumía como `bank-other-path`; el cierre de la ventana 2 provoca el cierre en cascada de la ventana 1. No consta caída del proceso, popup denegado ni fallo de red.

La página pública de Kutxabank indexada identifica `login_poslogin.iface` como «Autorización de acceso» y explica que ciertos accesos requieren una autorización adicional mediante teléfono móvil. La ruta posterior no aparece publicada. No se amplía toda la aplicación bancaria: se mejora el diagnóstico para conservar únicamente pathnames bajo `/NASApp/BesaideNet2/` con caracteres y longitud limitados, eliminando parámetros de sesión, consulta y fragmentos, y sustituyendo segmentos que parezcan identificadores largos. La prueba de regresión falló primero con `bank-other-path` y después conservó solo la ruta estática esperada sin `jsessionid`, código ni valores de consulta. Se necesita otro intento real para identificar la ruta posterior al segundo factor antes de modificar la política.

La repetición con la traza ampliada identifica `/NASApp/BesaideNet2/pages/login/entradaBanca.iface` inmediatamente después de aceptar el código. Se permiten previamente `login_poslogin.iface` y dos transiciones a `Gestor`; después se bloquea esa página y se cierran ambas ventanas en cascada. Se añade únicamente `entradaBanca.iface` a la política de autenticación. Las tres variantes de navegación de Electron (`will-navigate`, `will-redirect` y `did-navigate`) reprodujeron primero el cierre y después admitieron la ruta, mientras una página desconocida del mismo directorio continúa bloqueada.

Tras varias etapas legítimas dentro del mismo directorio de autenticación, se sustituye la enumeración página a página por el prefijo funcional `/NASApp/BesaideNet2/pages/login/`. No se admite todo el dominio ni toda la aplicación `BesaideNet2`: continúan bloqueadas las áreas no configuradas, incluida una ruta sintética bajo `pages/pagos/`. Resumen, movimientos de tarjetas y la página común en blanco mantienen sus permisos específicos. Las pruebas ejercitan esta frontera en los tres eventos de navegación de Electron.

## Primer intento de sincronización — 22 de septiembre de 2026

El titular completa el login, ve el resumen de cuentas y tarjetas y crea una conexión nueva seleccionando el 1 de septiembre como inicio. La aplicación devuelve `SOURCE_UNAVAILABLE`. La auditoría local registra el intento entre `12:53:17.100Z` y `12:53:17.685Z`, con ese intervalo y sin conexión, tarjeta ni movimiento persistidos. Por tanto, repetir «Crear nueva» no duplica datos locales. La duración de 585 ms es compatible con un fallo temprano al preparar la consulta, pero no demuestra que la fecha elegida sea inválida.

La traza de navegador es una sesión distinta y más larga. Alcanza la página de movimientos de tarjetas a `12:52:26Z` y permanece abierta hasta que Kutxabank navega a `/NASApp/BesaideNet2/pages/comun/timeout.jsp` a `12:58:59Z`. Esa página de caducidad provocaba el cierre por la política de rutas, pero ocurre más de cinco minutos después y no explica el fallo de sincronización de 585 ms. Se admite ahora como estado bancario conocido para que el lector pueda informar de sesión caducada.

El controlador ocultaba la causa interna de cualquier acción del DOM tras `SOURCE_UNAVAILABLE`. Se añade un evento `action-failed` que identifica solo la etapa (`select-card`, `show-movements`, `set-date-range`, `show-results` o `next-page`) y una razón perteneciente a un vocabulario seguro. No conserva fechas, selectores, HTML, textos, URLs, datos financieros ni el mensaje libre de la excepción. La prueba de regresión comprueba tanto la etapa de fechas como la ausencia del intervalo solicitado. Hace falta repetir la sincronización con el paquete actualizado para conocer la etapa real antes de cambiar la automatización del formulario.

La repetición instrumentada identifica `action-failed` en `set-date-range` con razón `missing-control`. La auditoría termina en 181 ms y mantiene cero conexiones, tarjetas y movimientos de Kutxabank. La fecha seleccionada no es la causa: el controlador pulsaba Movimientos y continuaba antes de que el renderizado asíncrono hubiera creado los controles del intervalo. La primera corrección esperó erróneamente todos esos controles antes de activar «Entre fechas». La siguiente prueba real agotó ese límite en 20,355 segundos y registró `show-movements / missing-control`, también sin persistir datos. La secuencia corregida espera primero «Entre fechas», lo activa y solo entonces espera los seis campos que Kutxabank crea de forma asíncrona. La prueba de regresión rechaza expresamente cualquier lectura de esos campos anterior a la activación y simula dos lecturas prematuras posteriores antes de continuar. Queda pendiente repetir el intento en el portal real con este orden.

La siguiente ejecución muestra visualmente el radio «Entre fechas» marcado, sin que aparezcan los campos. La traza termina en `set-date-range / page-update-timeout`: el clic programático sobre el `input` cambia su estado, pero no ejecuta la interacción visible que el portal enlaza a su etiqueta. No hay navegación ni fallo de proceso entre ambos eventos; más tarde la sesión llega a la página de caducidad permitida. El controlador activa ahora la etiqueta `label` asociada al radio, equivalente al clic visible del titular, y después espera los campos. La regresión diferencia expresamente ambos comportamientos: pulsar solo el input no habilita el formulario sintético y pulsar la etiqueta sí lo hace. Esta corrección requiere una nueva comprobación real.

La etiqueta sintética tampoco desplegó los campos en la siguiente prueba real: dos eventos `set-date-range / missing-control`. En la pestaña autenticada de Edge se examinó exclusivamente el control «Entre fechas». El `input` tiene `onmousedown="...activarClick(form, this, event)"` y un `onclick` que envía el cambio al servidor. Un clic real de Edge dejó el radio marcado y, tras la actualización asíncrona, creó los seis campos `calendarioDesde_cmb_*` y `calendarioHasta_cmb_*`. `element.click()` y `label.click()` no emiten `mousedown`, que es la diferencia causal observada. El controlador utiliza ahora `webContents.sendInputEvent` para enviar movimiento, pulsación y liberación sobre la etiqueta visible; después espera los seis campos. La regresión exige la pulsación de ratón antes de permitir que aparezcan. Falta comprobar esta versión dentro del paquete Electron real.

El titular probó el ejecutable con la pulsación real de ratón y confirmó que la sincronización termina. Esa prueba confirma el recorrido «Entre fechas» en Electron; no acredita todavía las otras cuatro opciones disponibles. La pantalla del banco muestra también «Últimos (máx. 3 meses)», «Últimos quince días», «Hoy», «Última semana» y «Último mes». Kakebo no ofrece «Últimos (máx. 3 meses)»; para las otras cuatro opciones selecciona el radio bancario por su etiqueta visible y comprueba su estado al recibir la tabla, sin rellenar los campos de fecha. Se mantienen intervalos internos para la auditoría y el procesamiento local; los movimientos aceptados para los periodos predefinidos determinan el rango efectivo de persistencia. Los casos sintéticos de elección del periodo y de páginas obsoletas están cubiertos; falta la prueba real de cada opción disponible.

## Bloqueo al abrir el portable con catálogo — 23 de septiembre de 2026

El titular informó de que la interfaz quedaba en los textos iniciales en inglés («Starting HTTPS callback…», «Production Loading…») y no aceptaba clics. El módulo `kutxabank-period.js`, importado por el renderer, contenía `import { z } from "zod"`; el cargador de módulos del navegador no resuelve ese identificador de paquete. La comprobación previa de assets solo verificaba que existieran los archivos, por lo que el empaquetado había pasado sin ejecutar el grafo de módulos del renderer. Se añadió una comprobación que recorre sus importaciones relativas en los JavaScript compilados y rechaza dependencias bare. Falló sobre `zod` en el paquete afectado y pasó tras mover el esquema de validación al workflow del proceso principal, dejando el módulo de periodos sin dependencias de Node. La nueva copia debe validarse abriéndola en el equipo del titular; las pruebas estáticas no sustituyen esa comprobación visual.

## Preparación de la versión 2.0.0 — 24 de septiembre de 2026

El titular confirmó durante el desarrollo que el recorrido completo de sincronización de ambas tarjetas y de todas las páginas funcionó con el periodo **Entre fechas**. Esa comprobación precede a la última variante, que añade saldo persistente, eliminación del catálogo y huella de identidad; no se declara validada esta última variante con una sesión bancaria real. Las otras opciones temporales tampoco tienen aún una prueba real documentada.

La revisión de la rama frente a `origin/main` detectó una asociación insegura por los cuatro últimos dígitos. Se sustituyó por una huella HMAC-SHA-256 calculada en el proceso principal con la clave privada local. El número completo no se persiste, y la huella no llega al renderer ni a `cards.json`. Se añadieron regresiones para tarjetas distintas con la misma terminación, reconexión tras desconectar, recuperación de una tarjeta eliminada sin duplicar su historial y propagación de fallos de SQLite como errores locales en lugar de avisos bancarios. La migración 017 permite terminaciones coincidentes y conserva los datos previos del catálogo; los catálogos de prueba sin huella no se vinculan automáticamente por su terminación.

Validación final de esta rama: `npm run check`, código 0, 62 archivos, 410 pruebas pasadas y 2 omitidas; `npm run audit:production`, código 0, sin vulnerabilidades; `npm run desktop:dist`, código 0, con ABI de SQLite empaquetado, migraciones hasta v17 y ZIP completo verificados. Se restauró la compilación nativa de SQLite para Node y se repitió `npm run check` tras el empaquetado. No se creó etiqueta ni se publicó una release.

## Referencias

- [Investigación y diseño](../superpowers/specs/2026-09-14-issue-26-kutxabank-research-design.md).
- [Plan de implementación](../superpowers/plans/2026-09-14-issue-26-kutxabank-card-sync.md).
- [Página pública de Kutxabank examinada](https://clientes.kutxabank.es/es/tarjetas-pagos/).
