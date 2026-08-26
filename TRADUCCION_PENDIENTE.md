# Traducción pendiente — BookOS Settings

> **Estado (2026-07-20): APLICADO.** Se completaron los diccionarios `_TOAST_TR_EN`
> (+~100 entradas y 3 regex dinámicos, más fallback a `_UI_TR_EN` en `_toastTr`) y
> `_UI_TR_EN` (+~75 títulos de búsqueda y atributos) en `pages/_common.js`;
> `buds-popup.html` ahora resuelve idioma vía `localStorage.bookos_lang`;
> los resultados de búsqueda (`main.js`) traducen título y conector "en/in".
> Este documento queda como referencia del inventario original.

Catálogo de texto visible al usuario que está **hardcodeado** en el frontend (no pasa por `t('key')` del sistema i18n en `src/modules/i18n.js`). Generado automáticamente vía grep/regex sobre el código — revisar antes de aplicar, puede haber algún falso positivo (interpolaciones, valores dinámicos).

## Resumen

- **Total de cadenas detectadas automáticamente**: ~251 (más los hallazgos manuales de `index.html`, `buds-popup.html`, `main.js` y `home.js` abajo).
- `src/modules/pages.js`: 221 toasts + 26 atributos (placeholder/title/aria-label) sin traducir.
- `src/modules/pages/_common.js`: 4 toasts + 0 atributos (placeholder/title/aria-label) sin traducir.
- `src/index.html`: textos fijos en `placeholder`, `aria-label`, `title`, `<h1>`, mensaje "no resultados" — no usan `t()`.
- `src/buds-popup.html`: ventana emergente de auriculares Buds **completamente hardcodeada en español** ("Descartar", "Conectar", "Conectando…"), sin import de i18n.js.
- `src/main.js`: ~4 strings de toasts de rutinas con fallback `'Rutina'` hardcodeado y patrón `en ${labelOf(s.parent)}` (la palabra "en" queda fija).
- `src/modules/home.js`: **archivo entero sin i18n** — `searchIndex` (25 entradas) y `subSearchIndex` (~150+ entradas) con `title`/`subtitle`/`keywords` hardcodeados en español, se muestran tal cual en resultados de búsqueda.

## Cómo usar este documento

Cada fila trae una **key sugerida** para agregar a `ES`/`EN` en `src/modules/i18n.js` y reemplazar el literal por `t('key')` (o `_tr('texto')` donde ya se usa ese helper local). Las keys son autogeneradas (`prefijo_seccion_NN`) — renombralas libremente, lo importante es que quede una única fuente de verdad por string.

## src/index.html

| Texto original | Ubicación | Key sugerida |
|---|---|---|
| `Toggle sidebar` (aria-label) | línea 7 | `aria_toggle_sidebar` |
| `Mostrar/ocultar barra lateral` (title) | línea 7 | `title_toggle_sidebar` |
| `Minimizar` / `Maximizar` / `Cerrar` (aria-label + title, 3 botones) | línea 10 | `win_minimize`, `win_maximize`, `win_close` |
| `Ajustes` (título del sidebar, ya existe key `settings` en i18n — no se está usando acá) | línea 14 | reusar `settings` |
| `Buscar ajustes...` (placeholder + aria-label, ya existe key `search_placeholder` — no se está usando acá) | línea 15 | reusar `search_placeholder` |
| `Limpiar búsqueda` (aria-label + title) | línea 15 | `search_clear` |
| `No se encontraron resultados` (ya existe key `no_results`, no se usa acá) | línea 16 | reusar `no_results` |
| `<title>` fijo del documento (no está en `<html lang="es">` tampoco se actualiza si el usuario cambia a inglés) | línea 1-3 | — actualizar `lang` dinámicamente y usar JS para el `<title>` |

Nota: `settings`, `search_placeholder` y `no_results` ya se sobrescriben por JS al cargar (`main.js:15-18`) — el HTML estático solo se ve un instante antes de hidratar. Igual conviene que el HTML por defecto ya esté en el idioma correcto para evitar el parpadeo.

## src/buds-popup.html

Ventana standalone (no carga `i18n.js`). Todo está hardcodeado:

| Texto original | Línea | Key sugerida |
|---|---|---|
| `BookOS Buds` (`<title>`) | 6 | `buds_popup_title` |
| `Descartar` (botón) | 88 | `buds_popup_dismiss` |
| `Conectar` (botón) | 89 | `buds_popup_connect` |
| `Conectando…` (estado del botón al hacer click) | 112 | `buds_popup_connecting` |

Para traducir esta ventana hace falta pasarle el idioma actual por query param (igual que se hace con `lang` en `buds_notify_battery`, ver `main.js:620`) y resolver los strings ahí mismo (es un HTML standalone sin acceso a `i18n.js` vía import).

## src/main.js

| Texto original | Línea | Key sugerida | Contexto |
|---|---|---|---|
| `Rutina` (fallback de nombre) | 574 | `routine_fallback_name` | Toast de restauración de rutina |
| `restaurada` | 574 | `routine_restored_suffix` | Toast: `"X" restaurada` |
| `ejecutada automáticamente` | 585 | `routine_executed_auto` | Toast de disparo automático de rutina |
| `ejecutada (${t.value})` | 685 | `routine_executed_value` | Toast de rutina programada por horario |
| `en ${labelOf(s.parent)}` — la palabra "en" fija | 325 | `search_result_in` | Subtítulo de resultado de búsqueda anidado |

## src/modules/home.js — search index (archivo completo sin i18n)

`searchIndex` (25 secciones) usa **los mismos IDs que ya existen como keys en `i18n.js`** (`connections`, `devices`, `ai`, `modes_routines`, `sound`, `notifications`, `display`, `battery`, `lockscreen`, `homescreen`, `wallpaper`, `themes`, `security`, `location`, `emergency`, `accounts`, `advanced`, `digital_health`, `maintenance`, `apps`, `general`, `accessibility`, `updates`, `recovery`, `about` — y sus `_sub` para subtitle). **No hace falta crear keys nuevas para esto**, solo reemplazar los literales de `title`/`subtitle` por `t('connections')`, `t('connections_sub')`, etc. en las ~25 líneas de `searchIndex` (home.js:1-25).

`subSearchIndex` (home.js:30-172 aprox., ~140 entradas) sí necesita keys nuevas — cada entrada tiene `{parent, title, keywords}`. Ejemplos representativos (la lista completa está en el archivo, agrupada por comentarios `// Pantalla`, `// Sonido`, etc.):

| Texto original | Parent | Key sugerida |
|---|---|---|
| `Brillo` | pantalla | `sub_pantalla_brillo` |
| `Modo oscuro` | pantalla | `sub_pantalla_modo_oscuro` |
| `Luz nocturna` | pantalla | `sub_pantalla_luz_nocturna` |
| `Resolución` | pantalla | `sub_pantalla_resolucion` |
| `Tasa de refresco` | pantalla | `sub_pantalla_tasa_refresco` |
| ...~135 entradas más... | varios | seguir patrón `sub_<parent>_<slug>` |

Recomendación práctica: en vez de crear ~140 keys individuales, la forma más barata es generar las keys programáticamente a partir del `title` actual (slugify) y volcar todo el array a un `Object.fromEntries` que se pasa por `t()` al render — así no hay que tocar 140 líneas a mano dos veces (ES/EN).

## src/modules/pages.js — toasts hardcodeados (agrupado por sección)

| Texto original | Archivo:línea | Key sugerida | Contexto |
|---|---|---|---|
| Wi-Fi activado / Wi-Fi desactivado | `src/modules/pages.js:73` | `toast_conexiones_main_page_01` | Conexiones main page |
| Bluetooth activado / Bluetooth desactivado | `src/modules/pages.js:79` | `toast_conexiones_main_page_02` | Conexiones main page |
| Modo Avión activado / Modo Avión desactivado | `src/modules/pages.js:81` | `toast_conexiones_main_page_03` | Conexiones main page |
| Copiado | `src/modules/pages.js:166` | `toast_ethernet_wired_detail_subpage_01` | Ethernet (wired) detail subpage |
| Wi-Fi activado / Wi-Fi desactivado | `src/modules/pages.js:215` | `toast_wi_fi_subpage_01` | Wi-Fi subpage |
| Bluetooth activado / Bluetooth desactivado | `src/modules/pages.js:253` | `toast_bluetooth_subpage_01` | Bluetooth subpage |
| Conectando... | `src/modules/pages.js:312` | `toast_bluetooth_subpage_02` | Bluetooth subpage |
| Conectado a  | `src/modules/pages.js:313` | `toast_bluetooth_subpage_03` | Bluetooth subpage |
| Error al conectar | `src/modules/pages.js:314` | `toast_bluetooth_subpage_04` | Bluetooth subpage |
| true / Desconectado / Conectado | `src/modules/pages.js:338` | `toast_bluetooth_subpage_05` | Bluetooth subpage |
| Error | `src/modules/pages.js:339` | `toast_bluetooth_subpage_06` | Bluetooth subpage |
| Copiado | `src/modules/pages.js:401` | `toast_wifi_network_detail_page_01` | WiFi network detail page |
| Contraseña incorrecta | `src/modules/pages.js:436` | `toast_wifi_network_detail_page_02` | WiFi network detail page |
| Copiado | `src/modules/pages.js:441` | `toast_wifi_network_detail_page_03` | WiFi network detail page |
| Red olvidada | `src/modules/pages.js:449` | `toast_wifi_network_detail_page_04` | WiFi network detail page |
| Error al olvidar la red | `src/modules/pages.js:450` | `toast_wifi_network_detail_page_05` | WiFi network detail page |
| Cambiando a modo oscuro / Cambiando a modo claro | `src/modules/pages.js:606` | `toast_pantalla_01` | Pantalla |
| Modo fluido activado (120 Hz · VRR) / Modo estándar activado (60 Hz) | `src/modules/pages.js:667` | `toast_quick_anchored_popovers_no_sub_01` | Quick anchored popovers (no sub-page navigation) |
| Protección de la vista activada / Protección de la vista desactivada | `src/modules/pages.js:683` | `toast_quick_anchored_popovers_no_sub_02` | Quick anchored popovers (no sub-page navigation) |
| Perfil automático activado | `src/modules/pages.js:700` | `toast_quick_anchored_popovers_no_sub_03` | Quick anchored popovers (no sub-page navigation) |
| aplicar_perfil_color | `src/modules/pages.js:701` | `toast_quick_anchored_popovers_no_sub_04` | Quick anchored popovers (no sub-page navigation) |
| Resolución:  | `src/modules/pages.js:722` | `toast_quick_anchored_popovers_no_sub_05` | Quick anchored popovers (no sub-page navigation) |
| Tiempo de espera:  | `src/modules/pages.js:740` | `toast_quick_anchored_popovers_no_sub_06` | Quick anchored popovers (no sub-page navigation) |
| Estilo guardado | `src/modules/pages.js:775` | `toast_pantalla_sub_pages_01` | Pantalla sub-pages |
| Modo fluido activado (120 Hz · VRR) / Modo estándar activado (60 Hz) | `src/modules/pages.js:823` | `toast_pantalla_sub_pages_02` | Pantalla sub-pages |
| Protector de vista activado / Protector de vista desactivado | `src/modules/pages.js:848` | `toast_pantalla_sub_pages_03` | Pantalla sub-pages |
| Horario guardado | `src/modules/pages.js:861` | `toast_pantalla_sub_pages_04` | Pantalla sub-pages |
| Perfil automático activado | `src/modules/pages.js:881` | `toast_pantalla_sub_pages_05` | Pantalla sub-pages |
| aplicar_perfil_color | `src/modules/pages.js:882` | `toast_pantalla_sub_pages_06` | Pantalla sub-pages |
| Resolución:  | `src/modules/pages.js:909` | `toast_pantalla_sub_pages_07` | Pantalla sub-pages |
| Tiempo de espera:  / .dt | `src/modules/pages.js:930` | `toast_pantalla_sub_pages_08` | Pantalla sub-pages |
| Error al aplicar | `src/modules/pages.js:1077` | `toast_balance_visual_twin_vu_bars_ci_01` | Balance visual — twin VU bars + circular pan knob, iOS-style |
| Balance centrado | `src/modules/pages.js:1082` | `toast_balance_visual_twin_vu_bars_ci_02` | Balance visual — twin VU bars + circular pan knob, iOS-style |
| Volumen cambiado | `src/modules/pages.js:1084` | `toast_balance_visual_twin_vu_bars_ci_03` | Balance visual — twin VU bars + circular pan knob, iOS-style |
| Sonidos de notificación activados / Desactivados | `src/modules/pages.js:1085` | `toast_balance_visual_twin_vu_bars_ci_04` | Balance visual — twin VU bars + circular pan knob, iOS-style |
| Sonidos de interfaz activados / Desactivados | `src/modules/pages.js:1086` | `toast_balance_visual_twin_vu_bars_ci_05` | Balance visual — twin VU bars + circular pan knob, iOS-style |
| Salida:  | `src/modules/pages.js:1095` | `toast_balance_visual_twin_vu_bars_ci_06` | Balance visual — twin VU bars + circular pan knob, iOS-style |
| Entrada:  | `src/modules/pages.js:1103` | `toast_balance_visual_twin_vu_bars_ci_07` | Balance visual — twin VU bars + circular pan knob, iOS-style |
| Ahorro activado · procesos en segundo plano limitados / Rendimiento normal | `src/modules/pages.js:1757` | `toast_history_fallback_hourly_bucket_01` | History fallback (hourly buckets, normalized) |
| Protección guardada (se aplica al iniciar) | `src/modules/pages.js:1781` | `toast_history_fallback_hourly_bucket_02` | History fallback (hourly buckets, normalized) |
| Carga ilimitada | `src/modules/pages.js:1784` | `toast_history_fallback_hourly_bucket_03` | History fallback (hourly buckets, normalized) |
| Atenuación automática activada / Atenuación automática desactivada | `src/modules/pages.js:1787` | `toast_history_fallback_hourly_bucket_04` | History fallback (hourly buckets, normalized) |
| Porcentaje visible en el widget / Porcentaje oculto en el widget | `src/modules/pages.js:1795` | `toast_history_fallback_hourly_bucket_05` | History fallback (hourly buckets, normalized) |
| .perf-mode-name | `src/modules/pages.js:1804` | `toast_history_fallback_hourly_bucket_06` | History fallback (hourly buckets, normalized) |
| error | `src/modules/pages.js:1826` | `toast_history_fallback_hourly_bucket_07` | History fallback (hourly buckets, normalized) |
| Error al aplicar límite de carga | `src/modules/pages.js:1830` | `toast_history_fallback_hourly_bucket_08` | History fallback (hourly buckets, normalized) |
| Carga adaptativa activada | `src/modules/pages.js:1866` | `toast_history_fallback_hourly_bucket_09` | History fallback (hourly buckets, normalized) |
| Carga adaptativa desactivada | `src/modules/pages.js:1874` | `toast_history_fallback_hourly_bucket_10` | History fallback (hourly buckets, normalized) |
| No molestar activado / No molestar desactivado | `src/modules/pages.js:1989` | `toast_notificaciones_01` | Notificaciones |
| Notificaciones en pantalla bloqueada activadas / Desactivadas en bloqueo | `src/modules/pages.js:1993` | `toast_notificaciones_02` | Notificaciones |
| Todas las notificaciones visibles / Sólo notificaciones críticas | `src/modules/pages.js:1997` | `toast_notificaciones_03` | Notificaciones |
| Avisos de actualizaciones activados / Avisos de actualizaciones desactivados | `src/modules/pages.js:2001` | `toast_notificaciones_04` | Notificaciones |
| Popups BookOS activados / Popups BookOS desactivados | `src/modules/pages.js:2005` | `toast_notificaciones_05` | Notificaciones |
| Cuenta atrás visible / Cuenta atrás oculta | `src/modules/pages.js:2009` | `toast_notificaciones_06` | Notificaciones |
| Posición actualizada | `src/modules/pages.js:2013` | `toast_notificaciones_07` | Notificaciones |
| Duración actualizada | `src/modules/pages.js:2017` | `toast_notificaciones_08` | Notificaciones |
| Tema de popups actualizado | `src/modules/pages.js:2021` | `toast_notificaciones_09` | Notificaciones |
| Sonidos activados / Sonidos desactivados | `src/modules/pages.js:2025` | `toast_notificaciones_10` | Notificaciones |
| Abriendo ajustes de notificaciones / No se pudo abrir | `src/modules/pages.js:2033` | `toast_notificaciones_11` | Notificaciones |
| Permiso denegado | `src/modules/pages.js:2084` | `toast_seguridad_01` | Seguridad |
| Cortafuegos activado / Cortafuegos desactivado | `src/modules/pages.js:2085` | `toast_seguridad_02` | Seguridad |
| Bloqueo al reanudar activado / Desactivado | `src/modules/pages.js:2089` | `toast_seguridad_03` | Seguridad |
| Tiempo de bloqueo:  /  min | `src/modules/pages.js:2093` | `toast_seguridad_04` | Seguridad |
| Periodo de gracia actualizado | `src/modules/pages.js:2097` | `toast_seguridad_05` | Seguridad |
| Cámara activada / Cámara bloqueada | `src/modules/pages.js:2101` | `toast_seguridad_06` | Seguridad |
| Error:  / permiso denegado | `src/modules/pages.js:2102` | `toast_seguridad_07` | Seguridad |
| Micrófono activo / Micrófono silenciado | `src/modules/pages.js:2106` | `toast_seguridad_08` | Seguridad |
| Historial activado / Historial desactivado | `src/modules/pages.js:2111` | `toast_seguridad_09` | Seguridad |
| Historial borrado | `src/modules/pages.js:2119` | `toast_seguridad_10` | Seguridad |
| Modo oscuro activado / Modo claro activado | `src/modules/pages.js:2222` | `toast_bookos_color_schemes_01` | BookOS color schemes |
| Aplicando iconos… | `src/modules/pages.js:2254` | `toast_bookos_color_schemes_02` | BookOS color schemes |
| Iconos aplicados / Error | `src/modules/pages.js:2260` | `toast_bookos_color_schemes_03` | BookOS color schemes |
| No se pudieron aplicar los iconos | `src/modules/pages.js:2261` | `toast_bookos_color_schemes_04` | BookOS color schemes |
| Programación activada / Programación desactivada | `src/modules/pages.js:2269` | `toast_bookos_color_schemes_05` | BookOS color schemes |
| Tema aplicado:  | `src/modules/pages.js:2270` | `toast_bookos_color_schemes_06` | BookOS color schemes |
| Programación activada / Programación desactivada | `src/modules/pages.js:2310` | `toast_dark_light_mode_settings_sub_p_01` | Dark/Light mode settings sub-page (automatic schedule) |
| Aplicando iconos… | `src/modules/pages.js:2412` | `toast_tinted_icons_customization_sub_01` | Tinted icons customization sub-page |
| Iconos aplicados / Error | `src/modules/pages.js:2418` | `toast_tinted_icons_customization_sub_02` | Tinted icons customization sub-page |
| No se pudieron aplicar los iconos | `src/modules/pages.js:2419` | `toast_tinted_icons_customization_sub_03` | Tinted icons customization sub-page |
| Tiempo de espera:  /  min | `src/modules/pages.js:2625` | `toast_tinted_icons_customization_sub_04` | Tinted icons customization sub-page |
| pin / Tipo de bloqueo: PIN / Tipo de bloqueo: Contraseña | `src/modules/pages.js:2645` | `toast_tinted_icons_customization_sub_05` | Tinted icons customization sub-page |
| Huella registrada | `src/modules/pages.js:2723` | `toast_tinted_icons_customization_sub_06` | Tinted icons customization sub-page |
| AOD activado / AOD desactivado | `src/modules/pages.js:2746` | `toast_tinted_icons_customization_sub_07` | Tinted icons customization sub-page |
| Book Bar activada / Book Bar desactivada | `src/modules/pages.js:2750` | `toast_tinted_icons_customization_sub_08` | Tinted icons customization sub-page |
| Tema lockscreen activado / Tema lockscreen desactivado | `src/modules/pages.js:2759` | `toast_tema_bookos_lockscreen_01` | Tema BookOS lockscreen |
| Tema SDDM activado / Tema SDDM desactivado | `src/modules/pages.js:2769` | `toast_tema_bookos_sddm_01` | Tema BookOS SDDM |
| Pantalla de inicio actualizada | `src/modules/pages.js:2888` | `toast_tema_bookos_sddm_02` | Tema BookOS SDDM |
| Error:  / desconocido | `src/modules/pages.js:2889` | `toast_tema_bookos_sddm_03` | Tema BookOS SDDM |
| Error al guardar configuración SDDM | `src/modules/pages.js:2890` | `toast_tema_bookos_sddm_04` | Tema BookOS SDDM |
| Error al seleccionar imagen | `src/modules/pages.js:2919` | `toast_tema_bookos_sddm_05` | Tema BookOS SDDM |
| Abriendo previsualización… | `src/modules/pages.js:2981` | `toast_tema_bookos_sddm_06` | Tema BookOS SDDM |
| Error:  / desconocido | `src/modules/pages.js:2982` | `toast_tema_bookos_sddm_07` | Tema BookOS SDDM |
| Error al abrir la previsualización | `src/modules/pages.js:2983` | `toast_tema_bookos_sddm_08` | Tema BookOS SDDM |
| Política de capturas actualizada | `src/modules/pages.js:3057` | `toast_recovery_snapshots_sub_page_be_01` | Recovery / snapshots sub-page (below Updates) |
| Revertido — reinicia para aplicar / Error | `src/modules/pages.js:3064` | `toast_recovery_snapshots_sub_page_be_02` | Recovery / snapshots sub-page (below Updates) |
| Actualizando Flatpak... | `src/modules/pages.js:3133` | `toast_recovery_snapshots_sub_page_be_03` | Recovery / snapshots sub-page (below Updates) |
| Flatpak actualizado | `src/modules/pages.js:3134` | `toast_recovery_snapshots_sub_page_be_04` | Recovery / snapshots sub-page (below Updates) |
| Actualizando AUR... | `src/modules/pages.js:3140` | `toast_recovery_snapshots_sub_page_be_05` | Recovery / snapshots sub-page (below Updates) |
| AUR actualizado | `src/modules/pages.js:3141` | `toast_recovery_snapshots_sub_page_be_06` | Recovery / snapshots sub-page (below Updates) |
| Descargando e instalando actualizaciones... | `src/modules/pages.js:3152` | `toast_recovery_snapshots_sub_page_be_07` | Recovery / snapshots sub-page (below Updates) |
| Error:  / Fallo | `src/modules/pages.js:3154` | `toast_recovery_snapshots_sub_page_be_08` | Recovery / snapshots sub-page (below Updates) |
| Programado para esta noche | `src/modules/pages.js:3190` | `toast_recovery_snapshots_sub_page_be_09` | Recovery / snapshots sub-page (below Updates) |
| Actualizando  | `src/modules/pages.js:3195` | `toast_recovery_snapshots_sub_page_be_10` | Recovery / snapshots sub-page (below Updates) |
| Flatpak actualizado | `src/modules/pages.js:3196` | `toast_recovery_snapshots_sub_page_be_11` | Recovery / snapshots sub-page (below Updates) |
| Actualizando  /  (AUR)... | `src/modules/pages.js:3200` | `toast_recovery_snapshots_sub_page_be_12` | Recovery / snapshots sub-page (below Updates) |
| AUR actualizado | `src/modules/pages.js:3201` | `toast_recovery_snapshots_sub_page_be_13` | Recovery / snapshots sub-page (below Updates) |
| Actualizando  | `src/modules/pages.js:3208` | `toast_recovery_snapshots_sub_page_be_14` | Recovery / snapshots sub-page (below Updates) |
| Error:  / Fallo | `src/modules/pages.js:3210` | `toast_recovery_snapshots_sub_page_be_15` | Recovery / snapshots sub-page (below Updates) |
| No se pudo cambiar el canal | `src/modules/pages.js:3429` | `toast_channel_picker_dialog_3_dot_me_01` | Channel picker dialog (3-dot menu on Updates page) |
| Canal cambiado a | `src/modules/pages.js:3432` | `toast_channel_picker_dialog_3_dot_me_02` | Channel picker dialog (3-dot menu on Updates page) |
| Repositorio BookOS activado / Repositorio BookOS desactivado | `src/modules/pages.js:3473` | `toast_channel_picker_dialog_3_dot_me_03` | Channel picker dialog (3-dot menu on Updates page) |
| Error:  / Fallo | `src/modules/pages.js:3478` | `toast_channel_picker_dialog_3_dot_me_04` | Channel picker dialog (3-dot menu on Updates page) |
| upd_auto_on / upd_auto_off | `src/modules/pages.js:3558` | `toast_up_to_date_but_maybe_bookos_re_01` | Up to date — but maybe BookOS release pending |
| upd_scheduled_night / Programado para esta noche | `src/modules/pages.js:3606` | `toast_bookos_release_actions_01` | BookOS release actions |
| Descargando e instalando actualizaciones... | `src/modules/pages.js:3614` | `toast_bookos_release_actions_02` | BookOS release actions |
| Error:  / Fallo | `src/modules/pages.js:3616` | `toast_bookos_release_actions_03` | BookOS release actions |
| upd_auto_on / upd_auto_off | `src/modules/pages.js:3619` | `toast_bookos_release_actions_04` | BookOS release actions |
| Actualización cancelada | `src/modules/pages.js:3629` | `toast_bookos_release_actions_05` | BookOS release actions |
| Actualización cancelada | `src/modules/pages.js:3659` | `toast_bookos_release_actions_06` | BookOS release actions |
| Sistema actualizado correctamente | `src/modules/pages.js:3681` | `toast_bookos_release_actions_07` | BookOS release actions |
| Nombre del equipo actualizado | `src/modules/pages.js:3754` | `toast_acerca_01` | Acerca |
| tst_app_lang_changed | `src/modules/pages.js:3859` | `toast_administracion_general_01` | Administración General |
| Hora automática activada / Hora automática desactivada / No se pudo cambiar | `src/modules/pages.js:3870` | `toast_date_time_01` | Date & time |
| No se pudo cambiar | `src/modules/pages.js:3871` | `toast_date_time_02` | Date & time |
| Zona horaria actualizada | `src/modules/pages.js:3889` | `toast_date_time_03` | Date & time |
| No se pudo cambiar | `src/modules/pages.js:3890` | `toast_date_time_04` | Date & time |
| No se pudo cambiar | `src/modules/pages.js:3891` | `toast_date_time_05` | Date & time |
| Abriendo impresoras / No hay gestor de impresoras instalado | `src/modules/pages.js:3899` | `toast_date_time_06` | Date & time |
| tst_lang_changed | `src/modules/pages.js:3915` | `toast_date_time_07` | Date & time |
| tst_keyboard_changed | `src/modules/pages.js:3925` | `toast_date_time_08` | Date & time |
| tst_autostart_on / tst_autostart_off | `src/modules/pages.js:3930` | `toast_date_time_09` | Date & time |
| enabled / disabled | `src/modules/pages.js:3934` | `toast_date_time_10` | Date & time |
| Nombre guardado | `src/modules/pages.js:4001` | `toast_cuentas_01` | Cuentas |
| Hostname guardado | `src/modules/pages.js:4006` | `toast_cuentas_02` | Cuentas |
| Esta acción requiere contraseña | `src/modules/pages.js:4024` | `toast_autologin_toggle_01` | Autologin toggle |
| Inicio automático activado / Inicio automático desactivado | `src/modules/pages.js:4030` | `toast_autologin_toggle_02` | Autologin toggle |
| Error:  / no se pudo aplicar | `src/modules/pages.js:4031` | `toast_autologin_toggle_03` | Autologin toggle |
| Esta acción requiere contraseña | `src/modules/pages.js:4049` | `toast_delete_user_01` | Delete user |
| Cuenta eliminada | `src/modules/pages.js:4055` | `toast_delete_user_02` | Delete user |
| Error:  / no se pudo borrar | `src/modules/pages.js:4056` | `toast_delete_user_03` | Delete user |
| Esta acción requiere contraseña | `src/modules/pages.js:4137` | `toast_create_user_dialog_01` | Create user dialog |
| ${username} | `src/modules/pages.js:4144` | `toast_create_user_dialog_02` | Create user dialog |
| Error:  / no se pudo crear | `src/modules/pages.js:4145` | `toast_create_user_dialog_03` | Create user dialog |
| Contraseña cambiada con éxito | `src/modules/pages.js:4183` | `toast_create_user_dialog_04` | Create user dialog |
| Limpieza completada | `src/modules/pages.js:4209` | `toast_mantenimiento_01` | Mantenimiento |
| Error en limpieza | `src/modules/pages.js:4210` | `toast_mantenimiento_02` | Mantenimiento |
| Reglas Polkit configuradas con éxito! | `src/modules/pages.js:4217` | `toast_mantenimiento_03` | Mantenimiento |
| Error al configurar | `src/modules/pages.js:4217` | `toast_mantenimiento_04` | Mantenimiento |
| Ajustes exportados a  | `src/modules/pages.js:4222` | `toast_mantenimiento_05` | Mantenimiento |
| Ajustes importados | `src/modules/pages.js:4228` | `toast_mantenimiento_06` | Mantenimiento |
| Fondo añadido | `src/modules/pages.js:4342` | `toast_fondo_de_pantalla_new_01` | Fondo de Pantalla (NEW) |
| Error al añadir fondo | `src/modules/pages.js:4345` | `toast_fondo_de_pantalla_new_02` | Fondo de Pantalla (NEW) |
| Error al añadir fondo | `src/modules/pages.js:4346` | `toast_fondo_de_pantalla_new_03` | Fondo de Pantalla (NEW) |
| Paleta de colores activada / Paleta desactivada | `src/modules/pages.js:4386` | `toast_fondo_de_pantalla_new_04` | Fondo de Pantalla (NEW) |
| Error al aplicar fondo | `src/modules/pages.js:4399` | `toast_fondo_de_pantalla_new_05` | Fondo de Pantalla (NEW) |
| Fondo de pantalla aplicado | `src/modules/pages.js:4406` | `toast_fondo_de_pantalla_new_06` | Fondo de Pantalla (NEW) |
| ${r.name} | `src/modules/pages.js:4544` | `toast_svg_icon_library_lucide_style__01` | SVG icon library (Lucide-style, stroke-based) |
| ${r.name} | `src/modules/pages.js:4545` | `toast_svg_icon_library_lucide_style__02` | SVG icon library (Lucide-style, stroke-based) |
| ${r.name} | `src/modules/pages.js:4547` | `toast_svg_icon_library_lucide_style__03` | SVG icon library (Lucide-style, stroke-based) |
| ${r.name} | `src/modules/pages.js:4558` | `toast_svg_icon_library_lucide_style__04` | SVG icon library (Lucide-style, stroke-based) |
| Rutina eliminada | `src/modules/pages.js:4574` | `toast_svg_icon_library_lucide_style__05` | SVG icon library (Lucide-style, stroke-based) |
| Rutina actualizada / Rutina creada | `src/modules/pages.js:4657` | `toast_desktop_routine_builder_dialog_01` | Desktop Routine Builder Dialog |
| .modo-name | `src/modules/pages.js:4849` | `toast_picker_popover_desktop_centere_01` | Picker popover (desktop centered dialog) |
| App predeterminada actualizada | `src/modules/pages.js:4945` | `toast_aplicaciones_predeterminadas_n_01` | Aplicaciones Predeterminadas (NEW) |
| No se pudo cambiar | `src/modules/pages.js:4946` | `toast_aplicaciones_predeterminadas_n_02` | Aplicaciones Predeterminadas (NEW) |
| No se pudo cambiar | `src/modules/pages.js:4947` | `toast_aplicaciones_predeterminadas_n_03` | Aplicaciones Predeterminadas (NEW) |
| Silenciado / Sonido activado | `src/modules/pages.js:5061` | `toast_salud_digital_android_style_di_01` | Salud Digital (Android-style Digital Wellbeing) |
| Objetivo actualizado | `src/modules/pages.js:5072` | `toast_salud_digital_android_style_di_02` | Salud Digital (Android-style Digital Wellbeing) |
| Avisos de objetivo activados / Desactivados | `src/modules/pages.js:5074` | `toast_salud_digital_android_style_di_03` | Salud Digital (Android-style Digital Wellbeing) |
| Modo enfoque activado / Modo enfoque desactivado | `src/modules/pages.js:5082` | `toast_salud_digital_android_style_di_04` | Salud Digital (Android-style Digital Wellbeing) |
| Tamaño actualizado — cierra sesión para aplicar | `src/modules/pages.js:5162` | `toast_accesibilidad_01` | Accesibilidad |
| Tamaño del cursor actualizado | `src/modules/pages.js:5171` | `toast_accesibilidad_02` | Accesibilidad |
| Colores invertidos / Colores normales | `src/modules/pages.js:5176` | `toast_accesibilidad_03` | Accesibilidad |
| Movimiento reducido / Animaciones normales | `src/modules/pages.js:5182` | `toast_accesibilidad_04` | Accesibilidad |
| Animaciones reducidas activadas / Animaciones restauradas | `src/modules/pages.js:5269` | `toast_laboratorio_experimental_01` | Laboratorio (experimental) |
| Desenfoque activado / Desenfoque desactivado | `src/modules/pages.js:5274` | `toast_laboratorio_experimental_02` | Laboratorio (experimental) |
| Ventanas elásticas activadas / Ventanas elásticas desactivadas | `src/modules/pages.js:5278` | `toast_laboratorio_experimental_03` | Laboratorio (experimental) |
| Lámpara mágica activada / Lámpara mágica desactivada | `src/modules/pages.js:5282` | `toast_laboratorio_experimental_04` | Laboratorio (experimental) |
| Latencia del cursor optimizada | `src/modules/pages.js:5287` | `toast_laboratorio_experimental_05` | Laboratorio (experimental) |
| Latencia restablecida a valores por defecto | `src/modules/pages.js:5292` | `toast_laboratorio_experimental_06` | Laboratorio (experimental) |
| Compositor reiniciado | `src/modules/pages.js:5301` | `toast_laboratorio_experimental_07` | Laboratorio (experimental) |
| Reconexión automática activada / Reconexión automática desactivada | `src/modules/pages.js:5386` | `toast_buds_administrar_conexiones_su_01` | Buds: Administrar conexiones submenu |
| Error: ¿buds conectados? | `src/modules/pages.js:5389` | `toast_buds_administrar_conexiones_su_02` | Buds: Administrar conexiones submenu |
| Conexión fácil activada / Conexión fácil desactivada | `src/modules/pages.js:5391` | `toast_buds_administrar_conexiones_su_03` | Buds: Administrar conexiones submenu |
| Error iniciando prueba | `src/modules/pages.js:5455` | `toast_buds_fit_test_adaptar_a_tus_oi_01` | Buds: Fit test (Adaptar a tus oídos) |
| Error de conexión | `src/modules/pages.js:5779` | `toast_buds_fit_test_adaptar_a_tus_oi_02` | Buds: Fit test (Adaptar a tus oídos) |
| Error al cambiar ANC | `src/modules/pages.js:5864` | `toast_buds_fit_test_adaptar_a_tus_oi_03` | Buds: Fit test (Adaptar a tus oídos) |
| Error GBC:  | `src/modules/pages.js:5875` | `toast_buds_fit_test_adaptar_a_tus_oi_04` | Buds: Fit test (Adaptar a tus oídos) |
| Cambio automático activado / Cambio automático desactivado | `src/modules/pages.js:5889` | `toast_buds_fit_test_adaptar_a_tus_oi_05` | Buds: Fit test (Adaptar a tus oídos) |
| Error EQ | `src/modules/pages.js:5905` | `toast_buds_fit_test_adaptar_a_tus_oi_06` | Buds: Fit test (Adaptar a tus oídos) |
| EQ:  | `src/modules/pages.js:5914` | `toast_buds_fit_test_adaptar_a_tus_oi_07` | Buds: Fit test (Adaptar a tus oídos) |
| Sonido de localización | `src/modules/pages.js:5928` | `toast_buds_fit_test_adaptar_a_tus_oi_08` | Buds: Fit test (Adaptar a tus oídos) |
| Error al localizar | `src/modules/pages.js:5929` | `toast_buds_fit_test_adaptar_a_tus_oi_09` | Buds: Fit test (Adaptar a tus oídos) |
| Requiere Galaxy Buds Client | `src/modules/pages.js:5930` | `toast_buds_fit_test_adaptar_a_tus_oi_10` | Buds: Fit test (Adaptar a tus oídos) |
| Próximamente | `src/modules/pages.js:5938` | `toast_buds_fit_test_adaptar_a_tus_oi_11` | Buds: Fit test (Adaptar a tus oídos) |
| Error | `src/modules/pages.js:6091` | `toast_controles_tactiles_sub_page_01` | Controles táctiles sub-page |
| Táctil bloqueado / Táctil activo | `src/modules/pages.js:6095` | `toast_controles_tactiles_sub_page_02` | Controles táctiles sub-page |
| No se pudo abrir el selector de archivos | `src/modules/pages.js:6286` | `toast_state_01` | State |
| Enviando… | `src/modules/pages.js:6289` | `toast_state_02` | State |
| Error al enviar:  | `src/modules/pages.js:6290` | `toast_state_03` | State |
| Wi-Fi Direct conectado con  | `src/modules/pages.js:6329` | `toast_state_04` | State |
| Error P2P:  | `src/modules/pages.js:6331` | `toast_state_05` | State |
| Error:  | `src/modules/pages.js:6407` | `toast_state_06` | State |
| Error:  | `src/modules/pages.js:6410` | `toast_state_07` | State |
| Wi-Fi Direct activo con  / dispositivo | `src/modules/pages.js:6507` | `toast_toggle_quick_share_on_off_01` | Toggle Quick Share on/off |
| No se pudo iniciar Quick Share:  | `src/modules/pages.js:6513` | `toast_toggle_quick_share_on_off_02` | Toggle Quick Share on/off |
| Error:  | `src/modules/pages.js:6534` | `toast_visibility_toggle_01` | Visibility toggle |
| Activa Quick Share primero | `src/modules/pages.js:6539` | `toast_download_folder_picker_01` | Download folder picker |
| Carpeta actualizada | `src/modules/pages.js:6546` | `toast_download_folder_picker_02` | Download folder picker |
| Error:  | `src/modules/pages.js:6547` | `toast_download_folder_picker_03` | Download folder picker |
| Activa Quick Share primero | `src/modules/pages.js:6552` | `toast_send_file_button_01` | Send file button |
| Sin dispositivos cercanos encontrados | `src/modules/pages.js:6554` | `toast_send_file_button_02` | Send file button |
| No se pudo abrir el selector de archivos | `src/modules/pages.js:6560` | `toast_send_file_button_03` | Send file button |
| Enviando… | `src/modules/pages.js:6563` | `toast_send_file_button_04` | Send file button |
| Error al enviar:  | `src/modules/pages.js:6564` | `toast_send_file_button_05` | Send file button |
| Enviando… | `src/modules/pages.js:6575` | `toast_send_file_button_06` | Send file button |
| Error al enviar:  | `src/modules/pages.js:6576` | `toast_send_file_button_07` | Send file button |
| Reindexando en segundo plano… | `src/modules/pages.js:6867` | `toast_book_ai_01` | Book AI |
| Ubicación activada / Ubicación desactivada | `src/modules/pages.js:6937` | `toast_ubicacion_01` | Ubicación |
| Información médica guardada | `src/modules/pages.js:6995` | `toast_seguridad_y_emergencia_01` | Seguridad y emergencia |
| Tamaño de icono:  | `src/modules/pages.js:7059` | `toast_pantalla_de_inicio_01` | Pantalla de inicio |

## src/modules/pages.js — placeholder/title/aria-label hardcodeados

| Texto original | Archivo:línea | Key sugerida | Contexto |
|---|---|---|---|
| title="Buscar redes" | `src/modules/pages.js:190` | `attr_wi_fi_subpage_01` | Wi-Fi subpage |
| title="Buscar dispositivos" | `src/modules/pages.js:235` | `attr_bluetooth_subpage_01` | Bluetooth subpage |
| placeholder="Contraseña" | `src/modules/pages.js:302` | `attr_bluetooth_subpage_02` | Bluetooth subpage |
| placeholder="Nombre del equipo" | `src/modules/pages.js:3715` | `attr_acerca_01` | Acerca |
| title="Eliminar cuenta" | `src/modules/pages.js:3967` | `attr_cuentas_01` | Cuentas |
| placeholder="p. ej. María García" | `src/modules/pages.js:4074` | `attr_create_user_dialog_01` | Create user dialog |
| placeholder="maria" | `src/modules/pages.js:4076` | `attr_create_user_dialog_02` | Create user dialog |
| placeholder="Mínimo 8 caracteres" | `src/modules/pages.js:4078` | `attr_create_user_dialog_03` | Create user dialog |
| placeholder="Repite la contraseña" | `src/modules/pages.js:4080` | `attr_create_user_dialog_04` | Create user dialog |
| placeholder="Contraseña actual" | `src/modules/pages.js:4157` | `attr_create_user_dialog_05` | Create user dialog |
| placeholder="Nueva contraseña" | `src/modules/pages.js:4159` | `attr_create_user_dialog_06` | Create user dialog |
| placeholder="Confirmar contraseña" | `src/modules/pages.js:4161` | `attr_create_user_dialog_07` | Create user dialog |
| title="Ejecutar" | `src/modules/pages.js:4517` | `attr_svg_icon_library_lucide_style__01` | SVG icon library (Lucide-style, stroke-based) |
| title="Editar" | `src/modules/pages.js:4518` | `attr_svg_icon_library_lucide_style__02` | SVG icon library (Lucide-style, stroke-based) |
| title="Eliminar" | `src/modules/pages.js:4519` | `attr_svg_icon_library_lucide_style__03` | SVG icon library (Lucide-style, stroke-based) |
| title="Cerrar" | `src/modules/pages.js:4591` | `attr_desktop_routine_builder_dialog_01` | Desktop Routine Builder Dialog |
| placeholder="Nombre de la rutina…" | `src/modules/pages.js:4594` | `attr_desktop_routine_builder_dialog_02` | Desktop Routine Builder Dialog |
| title="Eliminar" | `src/modules/pages.js:4608` | `attr_desktop_routine_builder_dialog_03` | Desktop Routine Builder Dialog |
| title="Eliminar" | `src/modules/pages.js:4626` | `attr_desktop_routine_builder_dialog_04` | Desktop Routine Builder Dialog |
| title="Buscar Buds" | `src/modules/pages.js:6669` | `attr_galaxy_buds_01` | Galaxy Buds |
| placeholder="Escribe para buscar…" | `src/modules/pages.js:6851` | `attr_book_ai_01` | Book AI |
| placeholder="Ej. A+" | `src/modules/pages.js:6961` | `attr_seguridad_y_emergencia_01` | Seguridad y emergencia |
| placeholder="Ej. Penicilina" | `src/modules/pages.js:6962` | `attr_seguridad_y_emergencia_02` | Seguridad y emergencia |
| placeholder="Ej. Ibuprofeno" | `src/modules/pages.js:6963` | `attr_seguridad_y_emergencia_03` | Seguridad y emergencia |
| placeholder="Ej. Diabetes" | `src/modules/pages.js:6964` | `attr_seguridad_y_emergencia_04` | Seguridad y emergencia |
| placeholder="Nombre" | `src/modules/pages.js:6978` | `attr_seguridad_y_emergencia_05` | Seguridad y emergencia |

## src/modules/pages/_common.js — toasts hardcodeados

| Texto original | Archivo:línea | Key sugerida | Contexto |
|---|---|---|---|
| div | `src/modules/pages/_common.js:244` | `toast_toast_notification_system_01` | Toast notification system |
| Contraseña incorrecta o error | `src/modules/pages/_common.js:308` | `toast_generic_sudo_action_shows_prom_01` | Generic Sudo action: shows prompt, runs command |
| Huella verificada — pero esta acción aún requiere contraseña | `src/modules/pages/_common.js:334` | `toast_generic_sudo_action_shows_prom_02` | Generic Sudo action: shows prompt, runs command |
| Error:  | `src/modules/pages/_common.js:338` | `toast_generic_sudo_action_shows_prom_03` | Generic Sudo action: shows prompt, runs command |

## Notas finales

- Muchos toasts usan patrón ternario `a?'X activado':'X desactivado'` — conviene una sola key con placeholder (`{state}`) en vez de dos keys por toggle, para no duplicar 100+ pares activado/desactivado.
- Ya existe el helper `_tr()` en algunas partes de `pages.js` (ver línea 166, 401, 441) que parece envolver `t()` con fallback — confirmar si es alias de `t` o una función distinta antes de migrar todo a un solo patrón.
- Este documento no cubre errores devueltos por el backend Rust (`format!("...")` en `main.rs`, `buds.rs`, etc.) que se muestran directo en toasts del frontend (ej. `run_sudo_command` ahora devuelve `{"ok":false,"error":"..."}` con el mensaje de error del SO en inglés) — si se quiere traducción completa, esos mensajes también habría que interceptarlos en el frontend en vez de mostrarlos crudos.
