# Issue 26: investigación y diseño de sincronización de tarjetas Kutxabank

Fecha: 2026-09-14. Estado: propuesta para revisión; investigación documental y del código completada. El usuario informa de una prueba real de Enable Banking que descubre cuentas pero no sus tarjetas. El agente no ha repetido esa prueba ni accedido a banca real.

Issue: [#26](https://github.com/esanzruzafa/Kakebo-Harvester/issues/26), consultada mediante el conector GitHub; actualización de la issue: 2026-09-14T18:51:09Z.

Base examinada: `origin/main`, commit `96afced891f9352003c35fefd5fe00486e11df0e`. Rama creada desde esa referencia tras `git fetch origin main`: `feat/26-kutxabank-card-sync`.

## 1. Objetivo y alcance

Obtener automáticamente movimientos de tarjetas de crédito Kutxabank sin cuotas recurrentes, integrarlos en los procesos existentes y conservar la importación XLSX. BBVA y préstamos son secundarios. El éxito no consiste en añadir una etiqueta CARD: requiere movimientos reales, identidad estable, recuperación tras autenticación y ausencia de doble contabilización.

La versión actual de la issue permite automatización local autenticada como último recurso. Sustituye la antigua restricción de limitar la solución a AIS. Durante esta investigación el usuario confirmó: «hasta donde he probado Enable banking no es alternativa ya que no detecta mis tarjetas, solo cuentas». Para este caso se considera insuficiente para tarjetas, manteniéndolo para cuentas. No se exige repetir su prueba como requisito previo para investigar el fallback. Este documento no ejecuta acceso bancario, crea consentimientos, modifica la visibilidad del repositorio ni inicia implementación.

«Automático» significa extracción, procesamiento y sincronización sin descargar/importar extractos manualmente cada vez. Puede requerir login o MFA periódico. No se promete ejecución desatendida indefinida ni funcionamiento mientras el ordenador esté apagado.

## 2. Hallazgos del código

| Área | Situación verificada en main | Consecuencia |
|---|---|---|
| Modelo | `001_initial.sql` ya contiene `bank_connections -> accounts -> transactions`, tipos, proveedor y entorno | Conservar tablas y claves; «producto financiero» será el concepto de dominio, sin renombrar toda la base |
| Esquemas | `src/enable-banking/schemas.ts` acepta `cash_account_type`, `product`, hashes y cuentas sin IBAN | No existe un filtro general que descarte CARD/LOAN por su tipo |
| Descubrimiento | `AuthorizationService` guarda cuentas de la sesión; `SyncService.syncAccounts` recorre IDs autorizados | Instrumentar el resultado recibido, no inventar productos a partir del nombre del banco |
| Identidad | `stableIdentificationHashes` en `account-repository.ts` admite únicamente descriptores que contienen `account.account_id.iban` | Los hashes válidos no IBAN se ignoran; un UID nuevo puede crear otra tarjeta |
| Colisiones | `mapTransaction` usa `identification_hash ?? account.id` para claves y fija `provider = enable-banking` | Revisar aislamiento de claves por conexión/proveedor/entorno y migración de referencias |
| Acoplamiento | `sync-service.ts`, autorización, CLI y composición usan `EnableBankingClient`; consultas filtran `enable-banking` | Un segundo conector requiere una frontera explícita, no sustituir globalmente cadenas |
| Selección | Repositorio y `account-settings.ts` ya gestionan alias, sync/export y bloqueo de sincronización | Extender el contrato existente con tipo, origen y capacidades |
| Procesamiento | Mapper, deduplicación, ventanas, paginación y `SyncRunner` ya existen | Conservar reconciliación pending/booked, ocurrencias idénticas, límites y auditoría |
| XLSX | `CardImportService` gestiona identidad por perfil, origen `manual-card` y filas repetidas | No etiquetar descargas automáticas como manuales ni fusionarlas por importe/fecha |
| Exportación | `CsvExporter` expone proveedor y tipo; resalta manual-card como cards y demás como banking | Mantener esta semántica de procedencia; CARD no implica cambiar el color de origen |
| Contabilidad | `normalizeDecimal` clasifica débito como expense; no existe tratamiento específico de liquidaciones | Añadir significado económico separado del signo del movimiento |
| Secretos | `RawStore.write` serializa payload completo si retainRawData; logger redacta rutas concretas | No reutilizar capturas raw generales para respuestas de autenticación del nuevo conector |

Pruebas existentes relevantes: `account-repository`, `reauthorization`, `sync-accounts-selection`, `sync-balances`, `sync-runtime-reauthorization`, `deduplication`, `movement-key`, `card-import-service`, `csv-exporter`, `raw-store`, `rate-limit-persistence` y `tests/integration/pagination.test.ts`.

## 3. Investigación de alternativas

Fuentes consultadas el 2026-09-14. «Sin evidencia» significa no demostrado en esta investigación, no imposibilidad técnica. Una API genérica, un banco en un catálogo o un sandbox no prueban acceso a tarjetas personales.

| Alternativa | Evidencia y gratuidad | Cobertura Kutxabank tarjeta | Evaluación |
|---|---|---|---|
| Enable Banking | Uso personal gratuito de cuentas vinculadas, con límites y condiciones [S1, S2]. Modelo CARD/LOAN [S3] | Usuario informa que aparecen cuentas, no sus tarjetas | Mantener para cuentas; insuficiente para el objetivo de tarjetas observado; no es candidato principal |
| GoCardless Bank Account Data/Nordigen | API documentada [S6]. Actual Budget advierte que el alta está cerrada y sus instrucciones de registro están obsoletas [S7] | No verificada | Solo candidato si ya existe una cuenta habilitada y se confirma gratuidad/acceso vigente; no basar la entrega en un alta nueva |
| Tink | FAQ ofrece sandbox gratuito y contratación Enterprise [S8] | No verificada | No cumple gratuidad permanente acreditada; sandbox no sirve como solución real |
| Salt Edge | Test permite datos reales previa aprobación; términos limitan normalmente Test a 90 días; Live se cotiza [S9, S10] | No verificada | Puede ayudar a evaluar cobertura; no es una alternativa gratuita permanente demostrada |
| TrueLayer | Data API comercial y capacidades de datos [S11] | No verificada en fuentes consultadas | No se ha acreditado a la vez Kutxabank CARD, alta personal y coste cero; no priorizar implementación |
| Powens | Plataforma y demo públicas [S12] | No verificada | Misma condición: exigir evidencia de tarjeta y condiciones gratuitas antes de desarrollar |
| Fintonic/OpenInsights | Oferta de agregación orientada a empresas [S13] | No verificada para API personal | App de consumo o marketing no equivale a API reutilizable gratuita |
| Wallet/BudgetBakers | REST API publicada [S14] | No verificada | Requiere además verificar precio de sincronización bancaria, tarjeta y acceso API; añade almacenamiento en tercero; no seleccionado |
| PSD2 directo Kutxabank/Redsys | Matriz bancaria pública, guía TPP y certificados [S4, S5] | Operaciones card-accounts enumeradas sin marca de soporte | No asumir que eliminar el agregador añade datos; acceso productivo personal gratuito no acreditado |
| API documentada de cliente | No localizada en documentación pública consultada | Sin evidencia | Investigar con el banco si aparece una interfaz oficial; no inventar endpoints |
| Portal local: descarga automática | Kutxabank anuncia consulta de movimientos de tarjeta online [S15] | Visibilidad documentada; extracción aún no probada | Primer fallback local a probar si existe exportación estructurada; coste proveedor cero, login/MFA y mantenimiento del flujo |
| Portal local: peticiones de lectura en sesión | Deben observarse en navegación propia autorizada | Sin prueba | Preferible a interpretar HTML cuando el portal entrega JSON estable; endpoints internos no son una API pública ni contrato estable |
| Portal local: extracción DOM | Mismo portal [S15] | Sin prueba | Última variante: más frágil ante cambios, paginación y filas virtualizadas; fallo cerrado |
| Woob / conectores libres | Catálogo público sin coincidencia Kutxabank ni BBVA en consulta [S16] | No encontrada | No hay conector listo demostrado; adoptar otro runtime solo si aparece uno mantenido y probado |
| XLSX manual | Implementado localmente | Depende del extracto disponible | Recuperación permanente; no satisface por sí sola la automatización requerida |

No se recomienda email/SMS/notificaciones como fuente canónica: una alerta no demuestra histórico completo, saldo, anulaciones ni asiento definitivo. C43 o un cargo mensual de cuenta tampoco permite reconstruir las compras detalladas. Los SDKs, herramientas de presupuesto y librerías de automatización no aportan por sí mismos acceso bancario.

### Evidencia relevante de Redsys

En la matriz específica de Kutxabank, las filas de cuentas y movimientos `/accounts` tienen `x`; las de `/card-accounts`, saldos y movimientos de tarjeta aparecen sin esa marca [S4]. Esto es un indicio documental desfavorable, no una prueba de la respuesta de Enable Banking a un consentimiento concreto. Tampoco debe confundirse Kutxabank con LABORAL Kutxa.

La documentación de BBVA examinada no contiene `card-accounts` [S17]. No permite declarar incompatibilidad definitiva; BBVA conserva una investigación propia sin bloquear Kutxabank.

### Restricción importante para varias personas

Los términos gratuitos de Enable Banking vinculan el acceso a las cuentas del usuario del panel que las enlazó [S1]. El aislamiento técnico entre personas A/B debe existir, pero no implica automáticamente que una sola aplicación gratuita pueda servir a ambas. Verificar condiciones y, si procede, usar un perfil de aplicación y secretos independiente por titular/conexión. No ampliar de hecho el uso gratuito a terceros por compartir la clave actual.

## 4. Decisión propuesta

Tres enfoques: extender solo Enable Banking (menor coste, riesgo de no resolver Kutxabank); crear una plataforma general de conectores por adelantado (más trabajo sin demostrar datos); realizar descubrimiento y después implementar una frontera mínima más un conector elegido. Se recomienda el tercero.

Secuencia de decisión:

1. Incorporar la prueba del usuario: Enable Banking devuelve cuentas, no sus tarjetas. Se avanza a alternativas, conservándolo para cuentas. Completar fecha/producto/whitelist de esa evidencia cuando estén disponibles, sin bloquear el fallback.
2. Reabrir la opción AIS para tarjetas solo si aparece evidencia nueva de cobertura. En ese caso compras booked completas bastarían aunque falten pending, balances o préstamos.
3. Comprobar candidatos gratuitos con acceso vigente. Descartar para entrega aquellos que solo ofrecen sandbox, evaluación temporal o una promesa comercial sin acceso personal gratuito.
4. Evaluar API directa documentada solo si puede accederse legítimamente con coste cero y ofrece más datos. La existencia de Redsys no basta; verificar requisitos de alta/certificados productivos.
5. Si lo anterior no resuelve la tarjeta, realizar prueba local del portal: exportación estructurada automática; si no existe, datos de lectura de la sesión; por último DOM. Elegir una sola variante demostrada.
6. Si ninguna ruta funciona, registrar el bloqueo concreto y los resultados; mantener issue abierta. No convertir una hipótesis en «soportado» ni cerrar la issue con importación manual.

No se enviaron consultas a soporte ni se dieron de alta proveedores. No se ha acreditado un proveedor alternativo que cumpla simultáneamente cobertura de las tarjetas del usuario y gratuidad permanente. La siguiente prueba técnica recomendada es el portal local de Kutxabank, empezando por descarga estructurada automática. No se implementará un conector basado solo en hipótesis de endpoints o selectores.

## 5. Protocolo de descubrimiento real

Precondiciones: titular presente para el consentimiento/login/MFA, selección explícita de entorno y conexión, almacenamiento de prueba separado de la base habitual. No reutilizar ni abrir secretos del repositorio para investigar documentación. La fase real se ejecutará al implementar el plan, no como efecto de redactarlo. Los pasos AIS describen el protocolo de contraste si hay evidencia nueva o para BBVA; no obligan a repetir la prueba negativa ya aportada por el usuario.

1. Crear diagnóstico de solo lectura con salida por lista permitida: proveedor, banco, entorno, tipo de cliente, método de autenticación, tipos de producto, capacidades, número de filas/páginas, límites observados y códigos de error seguros. Usar aliases sintéticos P1/P2; no exportar IDs reales, importes, descripciones, hashes bancarios ni sesiones.
2. Seleccionar exactamente Kutxabank ES/personal y comprobar qué productos se pueden vincular en el panel y autorizar. Registrar el método efectivo, duración anunciada y `valid_until` real por separado.
3. Enumerar todos los productos de la sesión y consultar sus detalles. Clasificar ausencia, error de permisos/whitelist, fallo temporal y no soportado como resultados diferentes.
4. Para cada tarjeta: consultar saldo, booked y pending cuando existan; probar ventanas de 7, 30 y 90 días, después ampliar solo hasta el límite permitido. Medir disponibilidad observada, no «histórico máximo» si no se ha alcanzado el límite.
5. Recorrer todas las páginas respetando límites y `Retry-After`. Probar ventana solapada y segunda sincronización: los mismos movimientos no deben insertarse de nuevo; una página vacía con continuación no termina por sí sola el recorrido.
6. Comparar localmente contra el portal un periodo cerrado y el periodo abierto: número de compras, importes y divisas, devoluciones, cuotas, pendientes y liquidación. Solo guardar resultados agregados/sintéticos en Git.
7. Renovar autorización y verificar identidad del producto, conservación de historial y separación de otra conexión. No deducir estabilidad de una única sesión.
8. Medir login/MFA, expiración, revocación, histórico, paginación y reintentos del fallback con el mismo protocolo. Cuando haya MFA, estado «Requiere autenticación»; nunca repetir intentos indefinidamente.
9. Observar al menos dos ejecuciones separadas, una renovación y un ciclo de liquidación disponible. Si no hay pending en el periodo observado, anotarlo como no observado, no no soportado.

Volumen provisional para evaluar gratuidad: hasta tres conexiones, cuatro productos por conexión, una sincronización diaria y reintentos manuales respetando cuota. Estimar peticiones = descubrimiento + productos × (saldos + páginas) por ejecución; medir valores reales antes de activar frecuencia. No afirmar que un plan gratuito soporta este volumen sin comprobar sus límites.

## 6. Matriz de compatibilidad inicial

Las casillas «no probado» requieren evidencia durante implementación. Los estados finales serán supported, partial o unsupported. Se añade not-tested para no falsear una prueba inexistente. La columna Kutxabank/AIS incorpora la prueba comunicada por el usuario, sin presentarla como verificación independiente del agente; no se conoce su fecha exacta ni los detalles de whitelist y consentimiento.

| Campo | Kutxabank / Enable Banking | BBVA / Enable Banking | Kutxabank / fallback local |
|---|---|---|---|
| País / perfil | ES / personal objetivo | ES / personal objetivo | ES / personal objetivo |
| Autenticación | Método ASPSP por medir | Método ASPSP por medir | Login/MFA del portal por observar |
| Integración | AIS existente | AIS existente | Variante por elegir tras prueba |
| Tipos expuestos | Cuentas, según usuario; tipo técnico no comunicado | No probado | No probado |
| Descubrimiento de tarjetas | No detectadas, según usuario | No probado | No probado |
| Saldos de tarjeta | Inaccesibles por ausencia de tarjeta | No probado | No probado |
| Movimientos booked | Inaccesibles por ausencia de tarjeta | No probado | No probado |
| Movimientos pending | Inaccesibles por ausencia de tarjeta | No probado | No probado |
| Histórico disponible | No probado | No probado | No probado |
| Paginación / fechas | No probado | No probado | No probado |
| Duración consentimiento/sesión | No probada | No probada | No probada |
| Reautorización / identidad | No probada | No probada | No probada |
| Liquidaciones / duplicados | No probado | No probado | No probado |
| Límites / errores | No medidos | No medidos | No medidos |
| Fecha de prueba real | No comunicada; resultado comunicado 2026-09-14 | Sin prueba | Sin prueba |
| Estado | partial para banco; unsupported para tarjetas en prueba comunicada | not-tested | not-tested |

Añadir una columna por proveedor realmente evaluado y por producto con comportamientos diferentes. Nunca trasladar el resultado de una persona, tarjeta o perfil empresarial a otro sin evidencia.

## 7. Diseño de implementación

### Productos, identidad y migración

Conservar `accounts.id` como identidad local. Añadir metadatos de capacidades con estados unknown/supported/unsupported para balances, booked y pending, tipo original y nombre descriptivo por separado. Los errores temporales no alteran capacidades de forma permanente.

Identidad en dos niveles: clave local inmutable de producto; aliases de identificadores externos dentro de proveedor + entorno + conexión. Para Enable Banking conservar el tratamiento IBAN y permitir descriptores no IBAN documentados y comprobados, no cualquier cadena. Un UID de sesión es alias temporal, no identidad estable entre autorizaciones. En colisión o ausencia de evidencia no fusionar: pedir vinculación local explícita y auditable. Los cuatro últimos dígitos/nombre/importe nunca bastan para fusionar tarjetas. La propuesta inicial evitaba cualquier identidad derivada del PAN. El 24-09-2026 el titular eligió expresamente una huella HMAC-SHA-256 con clave local para Kutxabank; el PAN completo no se guarda ni se expone al renderer, y los catálogos previos sin huella no se asocian automáticamente por su terminación.

Antes de introducir claves de movimiento v2, congelar fixtures de datos heredados. La migración debe preservar categorías, revisión, auditoría y referencias de exportación. Mantener una tabla de aliases legacy -> clave canónica para reimportaciones y referencias anteriores. No recalcular hashes silenciosamente ni recrear movimientos. Si se detecta una colisión ya existente, reportarla sin atribuir retroactivamente titularidad que la base no conserva.

### Frontera de conectores

Definir contratos neutros de conexión, producto, saldo, transacción de entrada, página y error. El adaptador Enable Banking traduce su esquema; la normalización compartida conserva decimales exactos y reglas existentes. El proveedor se obtiene de la conexión, nunca se acepta arbitrariamente desde el renderer. Los métodos del conector cubren sesión, descubrimiento, saldos, páginas y desconexión; no contienen operaciones bancarias de escritura.

El orquestador común conserva ventanas, límites de memoria/páginas, locks, auditoría, categorización y exportación. Las peculiaridades de cursor, autenticación y respuestas permanecen dentro del conector. No añadir frameworks ni otros runtimes antes de demostrar el segundo conector. Manual-card conserva su entrada actual.

### Fallback de portal

Contexto de navegador separado por entorno y conexión. Primero login interactivo sin guardar contraseña; persistir sesión solo si aporta utilidad y se protege mediante almacén de Windows/cifrado ligado al usuario. No guardar `storageState`, cookies o perfiles completos en JSON sin cifrar. Evitar archivos temporales descifrados: restaurar estado en memoria; fallar si la protección no está disponible.

Estados: disconnected, authenticating, ready, syncing, reauthentication-required, rate-limited, failed. Permitir cancelación, impedir solapamientos y limitar reintentos. Bloquear navegación fuera de dominios de autenticación observados/permitidos. Sin bypass de MFA, CAPTCHA, antifraude o certificado TLS.

Para descarga: directorio privado por ejecución fuera de Git; esperar finalización, comprobar tamaño/extensión/contenido y límites XLSX, procesar sin intervención, limpiar después de confirmar transacción local. Mantener `kutxabank-browser` como origen, no simular una importación manual. Si el formato es PDF, valorar parser específico solo después de verificar el formato real; no usar OCR como primera opción para datos contables.

Para peticiones/DOM: endpoints y selectores salen exclusivamente de observación autorizada. Validar esquema, producto, periodo, moneda, total de filas y final de paginación; ante cambio de estructura, detener y conservar cursor anterior. No interpretar login caducado como lista vacía ni marcar productos inactivos por descubrimiento incompleto.

### Liquidaciones y coexistencia

Añadir tratamiento económico persistente (normal, internal-transfer, review-required), evidencia y vínculo auditable. Conservar `amount`, `direction`, `movement_key` y fila original. Compras representan gasto; liquidaciones confirmadas tienen contribución al gasto cero. Nunca excluir por una coincidencia textual genérica o solo porque la suma coincide.

Vincular tarjeta y cuenta de cargo explícitamente. Confirmación automática únicamente con referencia fiable de liquidación/ciclo y cobertura completa del detalle. Casos ambiguos se revisan. Si faltan compras de parte del ciclo, no excluir silenciosamente toda la liquidación. Intereses/comisiones separados siguen siendo gasto; principal de préstamo es financiación/transferencia solo con desglose fiable.

La exportación debe conservar trazabilidad: añadir `economicTreatment`, `expenseAmount` y referencia de conciliación. Para compras -50/-30/-40 y liquidación -120: importes originales totalizan -240, contribución de gasto totaliza 120; la liquidación permanece visible con contribución 0. El perfil orientado a gasto debe usar esa contribución, no sumar Amount sin filtrar. No afirmar que añadir una categoría por sí sola evita doble conteo en hojas externas.

Manual y automático mantienen filas separadas. Una vinculación explícita de productos permite sugerir equivalencias por importe/divisa/fechas/descripción/comercio. Solo una conciliación confirmada define la fila representativa para gasto; no borrar automáticamente. Revertir conciliación debe restaurar la contribución y dejar auditoría.

### Préstamos y capacidades parciales

Un producto con solo saldo debe poder mostrarse/exportarse sin fallar la conexión. No deducir pendiente de pago a partir de crédito disponible ni sumar límites de crédito como patrimonio. Separar principal, intereses y comisiones si la fuente los distingue; si no, conservar movimiento y marcar revisión. Este trabajo no bloquea la entrega de tarjetas Kutxabank.

## 8. Criterios para seleccionar y entregar

Seleccionar el conector solo cuando existan compras reales, condiciones gratuitas vigentes y un recorrido repetible con MFA permitido. La entrega requiere aislamiento A/B, reautorización, exportación verificable, liquidación trazable y fallback manual intacto. BBVA y LOAN pueden quedar documentados como no probados o parciales sin impedir Kutxabank.

Riesgos principales: falta de exposición AIS; límites del modo personal multiusuario; cambios de portal; identidad sin identificador estable; claves heredadas; liquidaciones parciales; persistencia insegura de sesión. Cada riesgo tiene una prueba o condición de decisión en el plan asociado.

## 9. Fuentes

- S1: [Enable Banking: términos vigentes](https://enablebanking.com/terms/) — precio, cuentas vinculadas, alcance personal y límites.
- S2: [Enable Banking: changelog diciembre 2025](https://enablebanking.com/blog/2026/01/15/enable-banking-changelog-december-2025) — confirmación de uso personal gratuito.
- S3: [Enable Banking: API](https://enablebanking.com/docs/api/reference/) y [panel](https://enablebanking.com/docs/api/control-panel/) — modelos, sesiones, metadatos y vinculación.
- S4: [Redsys: matriz Kutxabank](https://market.apis-i.redsys.es/psd2/xs2a/nodos/kutxabank).
- S5: [Redsys: guía](https://market.apis-i.redsys.es/psd2/xs2a/guia) y [cambios](https://market.apis-i.redsys.es/psd2/xs2a/releasenotes) — contexto TPP y certificados; no equivalen a habilitación personal productiva.
- S6: [GoCardless: Bank Account Data](https://docs.gocardless.com/docs/bank-account-data/quickstart-guide).
- S7: [Actual Budget: integración GoCardless](https://actualbudget.org/docs/advanced/bank-sync/gocardless/) — advertencia de alta publicada por el proyecto integrador.
- S8: [Tink: FAQ](https://tink.com/faq/).
- S9: [Salt Edge: términos](https://www.saltedge.com/legal/terms_of_service).
- S10: [Salt Edge: documentación](https://docs.saltedge.com/general/v5/).
- S11: [TrueLayer: Data](https://truelayer.com/data/).
- S12: [Powens](https://www.powens.com/) y [demo](https://demo.powens.com/).
- S13: [Fintonic: OpenInsights](https://www.fintonic.com/blog/open-banking-data-insights/).
- S14: [BudgetBakers: API](https://budgetbakers.com/en/products/wallet/integrations/rest-api/).
- S15: [Kutxabank: tarjetas y movimientos online](https://clientes.kutxabank.es/es/tarjetas-pagos/).
- S16: [Woob: catálogo de módulos](https://woob.tech/modules).
- S17: [Redsys: matriz BBVA](https://market.apis-i.redsys.es/psd2/xs2a/nodos/bbva).
