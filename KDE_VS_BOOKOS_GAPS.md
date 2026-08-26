# KDE Plasma 6 System Settings vs BookOS Settings — Análisis de brechas

Generado el 2026-07-16, comparando los módulos KCM instalados en el sistema (Plasma 6, vía `kcmshell6 --list`, 90 módulos) contra las páginas reales de BookOS Settings (`src/modules/pages.js`, `src/modules/i18n.js`).

## Metodología

- Se listaron los 90 KCM disponibles con `kcmshell6 --list`.
- Se inspeccionó `pages.js` (7073 líneas) buscando funciones `renderX`, casos de uso y strings relevantes por palabra clave (kwin, shortcut, printer, firewall, night, autologin, touchpad, usuario, cursor theme, power profile, activities, virtual desktop, etc).
- "Parcial" significa que BookOS cubre una parte de la función nativa, o que delega al KCM de KDE abriendo `kcmshell6` en vez de reimplementarlo con UI propia.

## Tabla comparativa

| Módulo KDE (kcm) | Qué hace | ¿Existe en BookOS? | Dónde en BookOS |
|---|---|---|---|
| kcm_about-distro | Info del sistema/distro | Sí | `about` → renderAcerca |
| kcm_access | Accesibilidad (lupa, alto contraste, sticky keys) | Parcial | `accessibility` → renderAccesibilidad (subset: colores invertidos, animaciones) |
| kcm_activities | Actividades (espacios de trabajo temáticos) | No | — |
| kcm_animations | Velocidad/estilo de animaciones | Parcial | dentro de renderAccesibilidad (solo toggle animación rápida/lenta vía AnimationSpeed) |
| kcm_audio_information | Info de dispositivos de audio | No | — |
| kcm_autostart | Apps de inicio automático | Sí | `general` → lista de autostart con toggles |
| kcm_baloofile | Indexado/búsqueda de archivos | No | — |
| kcm_block_devices | Dispositivos de bloque | No | — |
| kcm_bluetooth | Gestión completa de Bluetooth (parejar, perfiles, servicios) | Parcial | `connections`/`devices` — BT básico (conectar/desconectar, buds) sin gestión de perfiles A2DP/HFP, servicios, ni pairing avanzado |
| kcm_bolt | Thunderbolt | No | — |
| kcm_cellular_network | Redes móviles | No | — |
| kcm_clock | Fecha y hora | Sí | `general` — NTP, zona horaria |
| kcm_colors | Esquemas de color globales | Parcial | `themes` — modo oscuro/claro, no editor de esquemas de color completo |
| kcm_componentchooser | Apps predeterminadas (navegador, mail, terminal) | Parcial | `apps` — predeterminadas básicas, no todas las categorías de KDE |
| kcm_cpu | Info avanzada de CPU | No | — |
| kcm_cursortheme | Tema de cursor del mouse | No | Solo hay tinte de iconos (`renderTintedIcons`), no selector de tema de cursor |
| kcm_desktoppaths | Rutas de carpetas personales (Descargas, Documentos…) | No | — |
| kcm_desktoptheme | Estilo global de Plasma (look and feel) | Parcial | `themes` — modo oscuro/claro/temas BookOS, no selector de "Plasma Style" completo |
| kcm_device_automounter | Automontaje de discos/volúmenes | No | — |
| kcm_edid | Datos EDID de pantalla | No | — |
| kcm_egl | Info EGL | No (nicho) | — |
| kcm_energyinfo | Estadísticas de consumo de energía | Parcial | `battery` — gráficas de uso, no el detalle de kcm_energyinfo |
| kcm_feedback | Preferencias de telemetría de usuario | No | — |
| kcm_filetypes | Asociaciones de archivos/MIME | No | — |
| kcm_firewall | Reglas de red/firewall | Parcial | `security` — toggle UFW simple, sin editor de reglas |
| kcm_firmware_security | Seguridad de firmware (Secure Boot, etc) | No | — |
| kcm_fontinst | Instalar/gestionar/previsualizar tipos de letra | No | — |
| kcm_fonts | Tipos de letra de la interfaz | No | No hay gestión de fuentes del sistema |
| kcm_gamecontroller | Configurar mandos de videojuego | No | — |
| kcm_glx | Info GLX | No (nicho) | — |
| kcm_icons | Tema de iconos | Parcial | `themes`/`renderTintedIcons` — solo tinte de iconos propios, no selector de tema de iconos del sistema (Papirus, Breeze, etc) |
| kcm_interrupts | Info de interrupciones HW | No (nicho) | — |
| kcm_kaccounts | Cuentas online (Google, ownCloud, etc) | No | — |
| kcm_kded | Servicios en segundo plano de KDE | No | — |
| kcm_keyboard | Distribución/hardware de teclado | Parcial | `general` — selector de idioma de teclado básico, sin opciones avanzadas de layout/repetición |
| kcm_keys | Atajos de teclado globales | Parcial (delega) | `general` → botón "Atajos de teclado" abre `kcmshell6 kcm_keys` nativo, sin UI propia |
| kcm_krdpserver | Escritorio remoto (RDP) | No | — |
| kcm_kscreen | Gestión y disposición de monitores (multi-monitor) | No | Solo hay selector de resolución simple en `display`, sin arreglo de múltiples pantallas |
| kcm_kwallet5 | Cartera de contraseñas KDE | No | — |
| kcm_kwin_effects | Efectos de compositor | Parcial | `advanced`/renderAvanzadas — blur/wobbly/magic, velocidad de animación, no todos los efectos de KWin |
| kcm_kwin_scripts | Scripts de KWin | No | — |
| kcm_kwin_virtualdesktops | Escritorios virtuales (número, navegación) | No | — |
| kcm_kwindecoration | Bordes y barras de título de ventanas | No | — |
| kcm_kwinoptions | Comportamiento de ventanas (focus, doble-click, etc) | No | — |
| kcm_kwinrules | Reglas por ventana individual | No | — |
| kcm_kwinscreenedges | Esquinas y bordes activos | No | — |
| kcm_kwinsupportinfo | Info de soporte KWin | No (nicho) | — |
| kcm_kwintabbox | Navegación Alt+Tab | No | — |
| kcm_kwintouchscreen | Gestos de pantalla táctil (KWin) | Parcial | Existe algo de "gestos avanzados" para buds, no gestos de pantalla táctil del sistema |
| kcm_kwinxwayland | Compatibilidad X11 en Wayland | No (nicho) | — |
| kcm_landingpage | Página de entrada de System Settings | N/A | Equivalente conceptual: pantalla principal de BookOS Settings |
| kcm_lookandfeel | Tema visual global (look-and-feel completo) | Parcial | `themes` |
| kcm_memory | Info de memoria | No | — |
| kcm_mobile_hotspot | Punto de acceso WiFi | No | — |
| kcm_mobile_power | Gestión de energía (perfil móvil) | Parcial | `battery` — modos de rendimiento propios (silencioso/optimizado/rendimiento), no integra powerdevil profiles nativos |
| kcm_mobile_wifi / wired | Preferencias de red | Sí | `connections` |
| kcm_mouse | Controles del mouse (velocidad, botones, aceleración) | No | Solo hay fix de Hz de cursor (`fix_cursor_hz`), no configuración completa de mouse |
| kcm_netpref | Preferencias de red genéricas (timeouts) | No (nicho) | — |
| kcm_network | Info de interfaces de red | Parcial | `connections` muestra estado básico |
| kcm_networkmanagement | Editor de conexiones de red (WiFi, VPN, Ethernet avanzado) | Parcial | `connections` — WiFi/Ethernet básico, sin editor completo de perfiles/VPN |
| kcm_nightlight | Temperatura de color según hora | Sí | `display` — activar/horario, temperatura fija (no hay control fino de curva) |
| kcm_nighttime | Configurar ciclo día/noche | No | — |
| kcm_notifications | Notificaciones y acciones por evento | Parcial | `notifications` — DND básico, sin control por aplicación tan granular como KDE |
| kcm_opencl | Info OpenCL | No (nicho) | — |
| kcm_pci | Info PCI | No (nicho) | — |
| kcm_plasmalogin | Configurar SDDM (gestor de inicio de sesión) | Parcial | `accounts` — autologin sí, pero no temas/config completa de SDDM |
| kcm_plasmasearch | Preferencias de búsqueda (KRunner) | No | — |
| kcm_plymouth | Pantalla de arranque (splash boot) | No | — |
| kcm_powerdevilprofilesconfig | Gestión de energía (perfiles detallados: brillo, suspensión, tapa cerrada) | Parcial | `battery` — modos simplificados, sin control de "qué pasa al cerrar tapa/inactividad" tan detallado |
| kcm_proxy | Servidores proxy | No | — |
| kcm_pulseaudio | Dispositivos de sonido y volumen | Sí | `sound` |
| kcm_push_notifications | Notificaciones push de servicios online | No | — |
| kcm_recentFiles | Historial de actividad de archivos | No | — |
| kcm_regionandlang | Idioma, formatos numéricos/moneda/hora | Parcial | `general` — idioma de app y sistema, sin formatos regionales (moneda, números) |
| kcm_samba | Estado de Samba | No | — |
| kcm_screenlocker | Bloqueo de pantalla | Sí | `lockscreen` |
| kcm_sddm | Gestor de inicio de sesión (temas SDDM) | No | — |
| kcm_sensors | Sensores de hardware | No | — |
| kcm_smserver | Inicio/cierre de sesión (confirmaciones, restaurar sesión) | No | — |
| kcm_solid_actions | Acciones al conectar dispositivos (autorun) | No | — |
| kcm_soundtheme | Tema de sonidos del sistema/notificaciones | No | — |
| kcm_splashscreen | Tema de pantalla de bienvenida | No | — |
| kcm_style | Estilo/comportamiento de widgets de apps | No | — |
| kcm_tablet | Tabletas y lápices gráficos | No | — |
| kcm_touchpad | Preferencias completas de panel táctil (sensibilidad, gestos, scroll) | Parcial | Solo hay bloqueo simple de touchpad para buds, no config real de touchpad del portátil |
| kcm_touchscreen | Config de pantalla táctil | No | — |
| kcm_usb | Dispositivos USB conectados | No | — |
| kcm_users | Gestión de cuentas de usuario | Sí | `accounts` — crear/eliminar usuario, aunque más simple que KDE (sin gestión fina de grupos/permisos) |
| kcm_virtualkeyboard | Teclado virtual a usar | No | — |
| kcm_wallpaper | Fondo de escritorio | Sí | `wallpaper` |
| kcm_wayland | Info del compositor Wayland | No | — |
| kcm_webshortcuts | Palabras clave de búsqueda web | No | — |
| kcm_workspace | Comportamiento general del espacio de trabajo | Parcial | Repartido entre varias páginas | 
| kcm_xserver | Info del servidor X | No (nicho) | — |
| kcmspellchecking | Diccionarios y corrector ortográfico | No | — |
| (extra) Impresoras/CUPS | Gestión de impresoras y escáneres | Parcial (delega) | `general` → botón abre `kcm_printer_manager` nativo (o `system-config-printer`), sin UI propia |
| (extra) Atajos personalizados | Crear atajos custom (khotkeys) | Parcial (delega) | `general` → botón abre `kcmshell6 kcm_khotkeys` nativo |

## Funciones ausentes prioritarias

Ordenadas por impacto probable para un usuario final típico (no técnico/power-user):

1. **Gestión multi-monitor (kcm_kscreen)** — Hoy solo hay un selector de resolución simple. Portátiles conectados a un monitor externo o proyector son un caso de uso muy común; falta disposición de pantallas, escalado por pantalla, monitor primario, espejo/extendido.
2. **Atajos de teclado con UI propia (kcm_keys)** — Actualmente se delega abriendo el KCM nativo de KDE, lo que rompe la experiencia unificada de BookOS. Traer un editor de atajos globales integrado sería de alto valor visible.
3. **Selector de tema de cursor (kcm_cursortheme)** — Personalización visual muy pedida por usuarios, y BookOS ya invierte en temas/iconos pero no cubre el cursor del mouse.
4. **Config completa de touchpad (kcm_touchpad)** — Sensibilidad, scroll natural, tap-to-click, gestos multitáctiles. Muy usado en laptops (BookOS parece apuntar a laptops), actualmente casi nada cubierto salvo un bloqueo básico ligado a los "buds".
5. **Gestión de impresoras con UI propia (CUPS)** — Hoy delega a herramientas externas; una experiencia nativa (agregar impresora, ver cola de impresión, imprimir de prueba) evitaría salir de la app.
6. **Perfiles de energía más detallados (kcm_powerdevilprofilesconfig)** — Qué pasa al cerrar la tapa, tiempo de suspensión/apagado de pantalla por perfil, comportamiento con batería baja. BookOS tiene modos simplificados pero no ese nivel de control.
7. **Selector de tema de iconos del sistema (kcm_icons)** — Distinto del "tinte de iconos" que ya existe; permitiría cambiar el set de iconos completo (Papirus, Breeze Dark, etc), muy visible para el usuario.
8. **Corrector ortográfico (kcmspellchecking)** — Diccionarios por idioma, útil y fácil de sorprender positivamente al usuario.
9. **Config de mouse (kcm_mouse)** — Velocidad, aceleración, botones, scroll — falta casi totalmente (solo hay un "fix" de Hz del cursor).
10. **Escritorios virtuales (kcm_kwin_virtualdesktops)** — Número de escritorios, nombres, navegación — funcionalidad de productividad usada por bastantes usuarios de KDE.
11. **Reglas de ventana / comportamiento de ventanas (kcmwinrules, kcmwinoptions, kwindecoration)** — Nicho pero valorado por usuarios avanzados; podría ir en "Funciones avanzadas".
12. **Tema de sonidos del sistema (kcm_soundtheme)** — Sonidos de notificación/eventos, complementa bien la sección `sound` ya existente.
13. **Actividades (kcm_activities)** — Función diferenciadora de KDE, nicho pero interesante para power users; baja prioridad frente a lo anterior.

## Funciones que BookOS ya cubre igual o mejor

- **Batería y rendimiento**: BookOS tiene modos de rendimiento (silencioso/optimizado/rendimiento) y perfil térmico con vatios explícitos, gráficas de consumo por app y ahorro de pantalla — más rico visualmente que el kcm_energyinfo/powerdevil nativo para un usuario común.
- **Pantalla de bloqueo (lockscreen)**: incluye biometría, AOD (always-on display) y tema propio — supera a kcm_screenlocker estándar de KDE en funciones tipo smartphone.
- **Salud digital / tiempo de uso**: no existe como KCM nativo de KDE; es una adición original de BookOS.
- **Modos y rutinas**: automatizaciones tipo "modo silencioso a cierta hora" — no tiene equivalente directo en System Settings.
- **Gestión de buds/auriculares (ANC, ecualizador, touchpad de auriculares)**: mucho más específico y completo que cualquier KCM de Bluetooth genérico.
- **Autologin**: integrado con gestión de usuarios en una sola pantalla, más simple de usar que navegar kcm_users + kcm_sddm por separado.
- **Firewall (UFW toggle simple)**: para el usuario promedio, el toggle simple de BookOS es más usable que el editor de reglas de kcm_firewall (aunque menos potente).
- **Home screen / wallpaper con paleta de color**: integración visual (fondo + paleta de temas) más cohesiva que wallpaper KCM + colors KCM por separado en KDE.
- **Recuperación / snapshots**: página `recovery` con capturas y revertir — no es un KCM estándar de System Settings (viene de herramientas tipo Timeshift/Snapper integradas de forma nativa en la UI).
