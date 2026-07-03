export const searchIndex=[
{id:'conexiones',title:'Conexiones',subtitle:'WiFi · Bluetooth · Modo Avión',keywords:['wifi','red','internet','bluetooth','avion','conexion','network','connections','airplane','ethernet','cable','wired']},
{id:'dispositivos',title:'Dispositivos conectados',subtitle:'Share · Buds',keywords:['dispositivo','compartir','share','buds','devices','connected','nearby','headphones','earbuds']},
{id:'ai',title:'AI',subtitle:'Asistente de escritura · notas',keywords:['ai','inteligencia','asistente','assistant','search','semantic','busqueda']},
{id:'modos',title:'Modos y rutinas',subtitle:'Modos · Rutinas',keywords:['modo','rutina','modes','routines','automation','automatizacion']},
{id:'sonido',title:'Sonido',subtitle:'Volumen · Salida',keywords:['sonido','volumen','audio','silencio','salida','sound','volume','mute','output','balance']},
{id:'notificaciones',title:'Notificaciones',subtitle:'No molestar',keywords:['notificacion','alerta','dnd','notifications','alert','do not disturb']},
{id:'pantalla',title:'Pantalla',subtitle:'Brillo · Resolución · Protector vista',keywords:['pantalla','brillo','resolucion','display','kwin','blur','efectos','screen','brightness','resolution','nightlight']},
{id:'bateria',title:'Batería',subtitle:'Energía · Carga · Samsung Book',keywords:['bateria','energia','carga','samsung','book','ventilador','rendimiento','battery','power','charge','performance','fan']},
{id:'bloqueo',title:'Pantalla de bloqueo',subtitle:'Bloqueo · Biometría · AOD',keywords:['bloqueo','lock','aod','huella','lockscreen','biometrics','fingerprint','sddm']},
{id:'inicio',title:'Pantalla Inicio',subtitle:'Diseño · Apps',keywords:['inicio','home','escritorio','homescreen','layout','desktop']},
{id:'fondos',title:'Fondo de pantalla',subtitle:'Fondos · Paleta',keywords:['fondo','wallpaper','paleta','background','palette','accent','color']},
{id:'temas',title:'Temas',subtitle:'Temas · Modo oscuro',keywords:['tema','oscuro','claro','dark','light','themes','theme','mode']},
{id:'seguridad',title:'Seguridad y privacidad',subtitle:'Firewall · Permisos',keywords:['seguridad','privacidad','permiso','firewall','ufw','security','privacy','permissions','camera','microphone']},
{id:'ubicacion',title:'Ubicación',subtitle:'Solicitudes',keywords:['ubicacion','gps','location']},
{id:'emergencia',title:'Seguridad y emergencia',subtitle:'Datos médicos',keywords:['emergencia','medico','emergency','medical','sos']},
{id:'cuentas',title:'Cuentas',subtitle:'Perfil · Nombre · Hostname',keywords:['cuenta','perfil','nombre','hostname','account','profile','name','password','user']},
{id:'avanzadas',title:'Funciones avanzadas',subtitle:'Labs',keywords:['avanzado','labs','advanced','experimental','compositor','effects']},
{id:'salud',title:'Salud digital',subtitle:'Tiempo de uso',keywords:['salud','digital','uso','wellbeing','screen time','usage','focus']},
{id:'mantenimiento',title:'Mantenimiento',subtitle:'Almacenamiento · Cache',keywords:['mantenimiento','limpiar','cache','espacio','disk','almacenamiento','memoria','maintenance','clean','storage','space']},
{id:'aplicaciones',title:'Aplicaciones',subtitle:'Apps predeterminadas',keywords:['aplicacion','app','predeterminada','navegador','browser','apps','default','pdf','image','video','imagenes','correo','email']},
{id:'general',title:'Administración general',subtitle:'Idioma · Teclado · Fecha',keywords:['idioma','teclado','fecha','hora','keyboard','general','language','date','time','locale','shortcuts','atajos','autostart']},
{id:'accesibilidad',title:'Accesibilidad',subtitle:'Visión · Audición',keywords:['accesibilidad','vision','zoom','accessibility','cursor','font','invert','contrast']},
{id:'actualizacion',title:'Actualización de software',subtitle:'Sistema · Flatpak',keywords:['actualizar','update','paru','pacman','flatpak','updates','software','upgrade','dnf','channel','canal']},
{id:'recuperacion',title:'Recuperación',subtitle:'Capturas · Revertir',keywords:['recuperacion','recovery','snapshot','captura','revertir','rollback','btrfs','snapper','restaurar','backup']},
{id:'acerca',title:'Acerca del portátil',subtitle:'Hardware · Info',keywords:['acerca','about','info','kernel','plasma','hardware','version']},
];

// Granular sub-settings index — each entry points to its parent page
export const subSearchIndex=[
// Pantalla
{parent:'pantalla',title:'Brillo',keywords:['brillo','brightness','luminosidad']},
{parent:'pantalla',title:'Modo oscuro',keywords:['oscuro','dark','noche','tema']},
{parent:'pantalla',title:'Luz nocturna',keywords:['luz','nocturna','night','azul','calor']},
{parent:'pantalla',title:'Resolución',keywords:['resolucion','tamaño','pixel']},
{parent:'pantalla',title:'Tasa de refresco',keywords:['refresco','hz','60','120','frecuencia']},
{parent:'pantalla',title:'Escala',keywords:['escala','zoom','dpi']},
{parent:'pantalla',title:'HDR',keywords:['hdr','contraste']},
{parent:'pantalla',title:'Vision Booster',keywords:['vision','booster']},
{parent:'pantalla',title:'Protector vista',keywords:['protector','vista','ojos','reflector']},
// Bateria
{parent:'bateria',title:'Modo de rendimiento',keywords:['rendimiento','performance','balanced','silencioso','potencia']},
{parent:'bateria',title:'Modo ahorro',keywords:['ahorro','ahorrador','save','baja']},
{parent:'bateria',title:'Carga adaptativa',keywords:['carga','adaptativa','adaptive','inteligente']},
{parent:'bateria',title:'Protección de batería',keywords:['proteccion','limite','80','tope']},
{parent:'bateria',title:'Modo ventilador',keywords:['ventilador','fan','silencio','ruido']},
{parent:'bateria',title:'Información de la batería',keywords:['info','salud','ciclos','health','wear']},
// Sonido
{parent:'sonido',title:'Volumen',keywords:['volumen','volume','sonido']},
{parent:'sonido',title:'Silenciar',keywords:['silenciar','mute','silencio']},
{parent:'sonido',title:'Salida de audio',keywords:['salida','output','altavoz','auriculares','speaker']},
{parent:'sonido',title:'Entrada de micrófono',keywords:['microfono','mic','entrada','input']},
// Conexiones
{parent:'conexiones',title:'WiFi',keywords:['wifi','wireless','red','redes']},
{parent:'conexiones',title:'Bluetooth',keywords:['bluetooth','bt']},
{parent:'conexiones',title:'Modo avión',keywords:['avion','airplane','vuelo']},
{parent:'conexiones',title:'VPN',keywords:['vpn','virtual','tunel']},
// Bloqueo
{parent:'bloqueo',title:'Tipo de bloqueo',keywords:['bloqueo','contraseña','pin','tipo']},
{parent:'bloqueo',title:'Huella dactilar',keywords:['huella','fingerprint','biometria','dedo']},
{parent:'bloqueo',title:'Always On Display',keywords:['aod','always','on','display','reloj','permanente']},
{parent:'bloqueo',title:'Book Bar',keywords:['bookbar','book','bar','barra']},
{parent:'bloqueo',title:'Tema SDDM',keywords:['sddm','login','tema','sesion']},
// Notificaciones
{parent:'notificaciones',title:'No molestar (DND)',keywords:['dnd','molestar','silencio']},
{parent:'notificaciones',title:'Notificaciones',keywords:['notificacion','alerta','aviso']},
// Inicio
{parent:'inicio',title:'Tamaño de iconos',keywords:['iconos','tamaño','grande','pequeño']},
{parent:'inicio',title:'Posición de la barra',keywords:['barra','panel','posicion','abajo','arriba','izquierda','derecha']},
{parent:'inicio',title:'Accesos directos',keywords:['accesos','directos','shortcuts','escritorio']},
// Fondos
{parent:'fondos',title:'Fondo de pantalla',keywords:['fondo','wallpaper','imagen']},
{parent:'fondos',title:'Paleta de colores',keywords:['paleta','colores','acento','tono']},
// Temas
{parent:'temas',title:'Esquema de color',keywords:['esquema','color','breeze','dark','light']},
{parent:'temas',title:'Modo oscuro automático',keywords:['automatico','horario','schedule','noche','dia']},
{parent:'temas',title:'Iconos del sistema',keywords:['iconos','icon','tema']},
// Seguridad
{parent:'seguridad',title:'Firewall (UFW)',keywords:['firewall','ufw','puertos']},
{parent:'seguridad',title:'Permisos de apps',keywords:['permisos','sandbox','flatpak']},
// Cuentas
{parent:'cuentas',title:'Nombre de usuario',keywords:['nombre','usuario','user']},
{parent:'cuentas',title:'Hostname',keywords:['hostname','equipo','red','nombre']},
{parent:'cuentas',title:'Avatar',keywords:['avatar','foto','imagen','perfil']},
// General
{parent:'general',title:'Idioma',keywords:['idioma','language','lenguaje','locale']},
{parent:'general',title:'Distribución de teclado',keywords:['teclado','keyboard','distribucion','layout']},
{parent:'general',title:'Fecha y hora',keywords:['fecha','hora','date','time','zona']},
{parent:'general',title:'Página de inicio',keywords:['inicio','startup','arranque','default']},
// Mantenimiento
{parent:'mantenimiento',title:'Almacenamiento',keywords:['almacenamiento','disco','disk','espacio']},
{parent:'mantenimiento',title:'Limpiar caché',keywords:['cache','limpiar','clean','memoria']},
{parent:'mantenimiento',title:'Logs del sistema',keywords:['logs','registros','journal']},
// Acerca
{parent:'acerca',title:'Modelo del equipo',keywords:['modelo','equipo','samsung','book','galaxy']},
{parent:'acerca',title:'Procesador',keywords:['cpu','procesador','intel','amd']},
{parent:'acerca',title:'Memoria RAM',keywords:['ram','memoria','gb']},
{parent:'acerca',title:'GPU',keywords:['gpu','grafica','video','intel','nvidia']},
{parent:'acerca',title:'Kernel',keywords:['kernel','linux','version']},
{parent:'acerca',title:'Versión de Plasma',keywords:['plasma','kde','version']},
// Actualizacion
{parent:'actualizacion',title:'Actualizaciones del sistema',keywords:['actualizacion','update','paru','pacman']},
{parent:'actualizacion',title:'Flatpak',keywords:['flatpak','app']},
// Salud digital
{parent:'salud',title:'Tiempo en pantalla',keywords:['tiempo','pantalla','uso','screen']},
{parent:'salud',title:'Límites de uso',keywords:['limite','uso','tiempo']},
// AI
{parent:'ai',title:'Asistente de escritura',keywords:['asistente','escritura','ai']},
// Modos
{parent:'modos',title:'Modos predefinidos',keywords:['modo','predefinido','perfil']},
{parent:'modos',title:'Rutinas',keywords:['rutina','automatizacion','disparador','trigger']},
// Avanzadas
{parent:'avanzadas',title:'Compositor (KWin)',keywords:['kwin','compositor','efectos']},
{parent:'avanzadas',title:'Inicio automático',keywords:['inicio','autostart','arranque','automatico']},
// Accesibilidad
{parent:'accesibilidad',title:'Lupa',keywords:['lupa','zoom','magnifier']},
{parent:'accesibilidad',title:'Lector de pantalla',keywords:['lector','pantalla','tts','voz']},
{parent:'accesibilidad',title:'Alto contraste',keywords:['contraste','alto','vision']},
// Aplicaciones
{parent:'aplicaciones',title:'Navegador predeterminado',keywords:['navegador','browser','firefox','chromium']},
{parent:'aplicaciones',title:'Cliente de correo',keywords:['correo','email','mail']},
{parent:'aplicaciones',title:'Reproductor multimedia',keywords:['reproductor','multimedia','video','audio']},
// Ubicacion
{parent:'ubicacion',title:'Servicios de ubicación',keywords:['ubicacion','gps','geo']},
// Emergencia
{parent:'emergencia',title:'Información médica',keywords:['medico','medical','grupo','sangre','alergia']},
{parent:'emergencia',title:'Contactos de emergencia',keywords:['contacto','emergencia','sos']},
// Dispositivos
{parent:'dispositivos',title:'Quick Share',keywords:['share','compartir','quick','rquickshare']},
{parent:'dispositivos',title:'Galaxy Buds',keywords:['buds','audifonos','samsung']},
// Conexiones — añadidos
{parent:'conexiones',title:'Ethernet (cable)',keywords:['ethernet','cable','wired','rj45','lan']},
// Avanzadas — efectos concretos
{parent:'avanzadas',title:'Desenfoque de fondo',keywords:['desenfoque','blur','transparencia','translucido']},
{parent:'avanzadas',title:'Ventanas elásticas',keywords:['elasticas','wobbly','wobble','goma']},
{parent:'avanzadas',title:'Lámpara mágica',keywords:['lampara','magica','magic','minimizar','genie']},
{parent:'avanzadas',title:'Latencia del cursor',keywords:['cursor','latencia','lag','hz','raton']},
{parent:'avanzadas',title:'Animaciones reducidas',keywords:['animaciones','reducir','motion','movimiento']},
// Bateria — añadidos
{parent:'bateria',title:'Al conectar el cargador',keywords:['cargador','enchufe','charger','plug','ac','corriente']},
{parent:'bateria',title:'Atenuar pantalla',keywords:['atenuar','dim','brillo','bajo']},
{parent:'bateria',title:'Perfil térmico',keywords:['termico','thermal','watts','tdp','temperatura']},
{parent:'bateria',title:'Límite de carga',keywords:['limite','carga','80','tope','charge limit']},
// Sonido — añadidos
{parent:'sonido',title:'Balance de audio',keywords:['balance','izquierda','derecha','left','right','pan']},
// Accesibilidad — añadidos
{parent:'accesibilidad',title:'Tamaño del cursor',keywords:['cursor','tamaño','raton','grande','puntero']},
{parent:'accesibilidad',title:'Tamaño de texto',keywords:['texto','fuente','font','letra','dpi']},
{parent:'accesibilidad',title:'Colores invertidos',keywords:['invertir','invert','colores','negativo']},
// Aplicaciones — categorías nuevas
{parent:'aplicaciones',title:'Visor de imágenes',keywords:['imagen','imagenes','image','foto','gwenview','visor']},
{parent:'aplicaciones',title:'Lector de PDF',keywords:['pdf','documento','okular','lector']},
{parent:'aplicaciones',title:'Editor de texto',keywords:['texto','editor','text','kate']},
{parent:'aplicaciones',title:'Gestor de archivos',keywords:['archivos','files','gestor','dolphin']},
{parent:'aplicaciones',title:'Archivos comprimidos',keywords:['comprimido','zip','rar','7z','archive']},
// Mantenimiento
{parent:'mantenimiento',title:'Limpiar caché',keywords:['cache','limpiar','clean','basura','temporal']},
{parent:'mantenimiento',title:'Limpiar Flatpak',keywords:['flatpak','limpiar','huerfanos','unused']},
// Salud digital
{parent:'salud',title:'Tiempo de uso',keywords:['tiempo','uso','screen time','pantalla','horas']},
{parent:'salud',title:'Modo enfoque',keywords:['enfoque','focus','concentracion','distraccion']},
{parent:'salud',title:'Límite diario',keywords:['limite','diario','objetivo','goal']},
];

import{t}from'./i18n.js';

const ic=s=>`<div class="item-icon"><img src="assets/${s}" alt=""></div>`;
// Earbuds icon for the Home profile-card shortcut — reuses the same SVG art as
// the Buds page rings (looks clean, never emoji).
const BUDS_SVG=`<span class="home-buds-pair"><img src="assets/budsleft.svg" alt=""><img src="assets/budsright.svg" alt=""></span>`;
const it=(page,icon,key)=>`<div class="item" data-page="${page}" tabindex="0" role="button">${ic(icon)}<div class="item-texts"><span class="title">${t(key)}</span><span class="subtitle">${t(key+'_sub')}</span></div></div>`;

export function renderHome(u){
    const name=u?.display_name||'Usuario';
    const ini=name.charAt(0).toUpperCase();
    // Backend inlines the avatar as a data URL — no protocol headaches.
    const _assetUrl=(p)=>window.__TAURI__?.core?.convertFileSrc?window.__TAURI__.core.convertFileSrc(p):('asset://localhost'+(p.startsWith('/')?p:'/'+p));
    const avSrc=u?.avatar_data||(u?.has_avatar?_assetUrl(u.avatar_path):'');
    const av=avSrc
        ?`<img src="${avSrc}" class="profile-avatar" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'profile-avatar-placeholder',textContent:'${ini}'}))">`
        :`<div class="profile-avatar-placeholder">${ini}</div>`;
    return `
<div class="card card-profile">
    <div class="item" data-page="cuentas" tabindex="0" role="button">
        <div class="profile-left"><span class="title">${name}</span><span class="subtitle">${t('bookos_account')}</span></div>${av}
    </div>
    <div class="item home-buds-row" id="home-buds" tabindex="0" role="button" style="display:none">
        <div class="item-icon">${BUDS_SVG}</div>
        <div class="item-texts"><span class="title home-buds-name"></span></div>
    </div>
</div>

<div class="card">
    ${it('conexiones','wifi.svg','connections')}
    ${it('dispositivos','connected.svg','devices')}
</div>

<div class="card">
    ${it('ai','tips.svg','ai')}
    ${it('modos','routines.svg','modes_routines')}
    ${it('sonido','sound.svg','sound')}
    ${it('notificaciones','notification.svg','notifications')}
</div>

<div class="card">
    ${it('pantalla','brightness.svg','display')}
    ${it('bateria','battery.svg','battery')}
</div>

<div class="card">
    ${it('bloqueo','lockscreen.svg','lockscreen')}
    ${it('inicio','start.svg','homescreen')}
    ${it('fondos','wallpaper.svg','wallpaper')}
    ${it('temas','themes.svg','themes')}
</div>

<div class="card">
    ${it('seguridad','security.svg','security')}
    ${it('ubicacion','location.svg','location')}
    ${it('emergencia','emergency.svg','emergency')}
</div>

<div class="card">
    ${it('cuentas','accounts.svg','accounts')}
    ${it('avanzadas','advanced.svg','advanced')}
</div>

<div class="card">
    ${it('salud','health.svg','digital_health')}
    ${it('mantenimiento','maintanance.svg','maintenance')}
    ${it('aplicaciones','aplications.svg','apps')}
</div>

<div class="card">
    ${it('general','general.svg','general')}
    ${it('accesibilidad','accesibility.svg','accessibility')}
</div>

<div class="card">
    ${it('actualizacion','software.svg','updates')}
    ${it('recuperacion','recovery.svg','recovery')}
    ${it('acerca','about.svg','about')}
</div>`;
}
