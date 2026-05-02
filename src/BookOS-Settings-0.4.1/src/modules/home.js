export const searchIndex=[
{id:'conexiones',title:'Conexiones',subtitle:'WiFi · Bluetooth · Modo Avión',keywords:['wifi','red','internet','bluetooth','avion','conexion','network']},
{id:'dispositivos',title:'Dispositivos conectados',subtitle:'Share · Buds',keywords:['dispositivo','compartir','share','buds']},
{id:'ai',title:'AI',subtitle:'Asistente de escritura · notas',keywords:['ai','inteligencia','asistente']},
{id:'modos',title:'Modos y rutinas',subtitle:'Modos · Rutinas',keywords:['modo','rutina']},
{id:'sonido',title:'Sonidos y vibración',subtitle:'Volumen · Melodía',keywords:['sonido','volumen','vibracion','audio','silencio']},
{id:'notificaciones',title:'Notificaciones',subtitle:'No molestar',keywords:['notificacion','alerta','dnd']},
{id:'pantalla',title:'Pantalla',subtitle:'Brillo · Resolución · Protector vista',keywords:['pantalla','brillo','resolucion','display','kwin','blur','efectos']},
{id:'bateria',title:'Batería',subtitle:'Energía · Carga · Samsung Book',keywords:['bateria','energia','carga','samsung','book','ventilador','rendimiento']},
{id:'bloqueo',title:'Pantalla de bloqueo',subtitle:'Bloqueo · Biometría · AOD',keywords:['bloqueo','lock','aod','huella']},
{id:'inicio',title:'Pantalla Inicio',subtitle:'Diseño · Apps',keywords:['inicio','home','escritorio']},
{id:'fondos',title:'Fondo de pantalla',subtitle:'Fondos · Paleta',keywords:['fondo','wallpaper','paleta']},
{id:'temas',title:'Temas',subtitle:'Temas · Modo oscuro',keywords:['tema','oscuro','claro','dark','light']},
{id:'seguridad',title:'Seguridad y privacidad',subtitle:'Firewall · Permisos',keywords:['seguridad','privacidad','permiso','firewall','ufw']},
{id:'ubicacion',title:'Ubicación',subtitle:'Solicitudes',keywords:['ubicacion','gps']},
{id:'emergencia',title:'Seguridad y emergencia',subtitle:'Datos médicos',keywords:['emergencia','medico']},
{id:'cuentas',title:'Cuentas',subtitle:'Perfil · Nombre · Hostname',keywords:['cuenta','perfil','nombre','hostname']},
{id:'avanzadas',title:'Funciones avanzadas',subtitle:'Labs',keywords:['avanzado','labs']},
{id:'salud',title:'Salud digital',subtitle:'Tiempo de uso',keywords:['salud','digital','uso']},
{id:'mantenimiento',title:'Mantenimiento',subtitle:'Almacenamiento · Cache',keywords:['mantenimiento','limpiar','cache','espacio','disk','almacenamiento','memoria']},
{id:'aplicaciones',title:'Aplicaciones',subtitle:'Apps predeterminadas',keywords:['aplicacion','app','predeterminada','navegador','browser']},
{id:'general',title:'Administración general',subtitle:'Idioma · Teclado · Fecha',keywords:['idioma','teclado','fecha','hora','keyboard']},
{id:'accesibilidad',title:'Accesibilidad',subtitle:'Visión · Audición',keywords:['accesibilidad','vision','zoom']},
{id:'actualizacion',title:'Actualización de software',subtitle:'Sistema · Flatpak',keywords:['actualizar','update','paru','pacman','flatpak']},
{id:'acerca',title:'Acerca del portátil',subtitle:'Hardware · Info',keywords:['acerca','about','info','kernel','plasma']},
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
];

import{t}from'./i18n.js';

const ic=s=>`<div class="item-icon"><img src="assets/${s}" alt=""></div>`;
const it=(page,icon,key)=>`<div class="item" data-page="${page}" tabindex="0">${ic(icon)}<div class="item-texts"><span class="title">${t(key)}</span><span class="subtitle">${t(key+'_sub')}</span></div></div>`;

export function renderHome(u){
    const name=u?.display_name||'Usuario';
    const ini=name.charAt(0).toUpperCase();
    const av=u?.has_avatar?`<img src="file://${u.avatar_path}" class="profile-avatar">`:`<div class="profile-avatar-placeholder">${ini}</div>`;
    return `
<div class="card card-profile"><div class="item" data-page="cuentas" tabindex="0">
    <div class="profile-left"><span class="title">${name}</span><span class="subtitle">${t('bookos_account')}</span></div>${av}
</div></div>

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
    ${it('acerca','about.svg','about')}
</div>`;
}
