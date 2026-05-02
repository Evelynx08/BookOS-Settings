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

const ic=s=>`<div class="item-icon"><img src="assets/${s}" alt=""></div>`;

export function renderHome(u){
    const name=u?.display_name||'Usuario';
    const ini=name.charAt(0).toUpperCase();
    const av=u?.has_avatar?`<img src="file://${u.avatar_path}" class="profile-avatar">`:`<div class="profile-avatar-placeholder">${ini}</div>`;
    return `
<div class="card card-profile"><div class="item" data-page="cuentas" tabindex="0">
    <div class="profile-left"><span class="title">${name}</span><span class="subtitle">BookOS Account</span></div>${av}
</div></div>

<div class="card">
    <div class="item" data-page="conexiones" tabindex="0">${ic('wifi.svg')}<div class="item-texts"><span class="title">Conexiones</span><span class="subtitle">WiFi · Bluetooth · Modo Avión</span></div></div>
    <div class="item" data-page="dispositivos" tabindex="0">${ic('connected.svg')}<div class="item-texts"><span class="title">Dispositivos conectados</span><span class="subtitle">Share · Buds</span></div></div>
</div>

<div class="card">
    <div class="item" data-page="ai" tabindex="0">${ic('tips.svg')}<div class="item-texts"><span class="title">AI</span><span class="subtitle">Asistente de escritura · notas</span></div></div>
    <div class="item" data-page="modos" tabindex="0">${ic('routines.svg')}<div class="item-texts"><span class="title">Modos y rutinas</span><span class="subtitle">Modos · Rutinas</span></div></div>
    <div class="item" data-page="sonido" tabindex="0">${ic('sound.svg')}<div class="item-texts"><span class="title">Sonidos y vibración</span><span class="subtitle">Volumen · Melodía</span></div></div>
    <div class="item" data-page="notificaciones" tabindex="0">${ic('notification.svg')}<div class="item-texts"><span class="title">Notificaciones</span><span class="subtitle">No molestar</span></div></div>
</div>

<div class="card">
    <div class="item" data-page="pantalla" tabindex="0">${ic('brightness.svg')}<div class="item-texts"><span class="title">Pantalla</span><span class="subtitle">Brillo · Resolución · Protector vista</span></div></div>
    <div class="item" data-page="bateria" tabindex="0">${ic('battery.svg')}<div class="item-texts"><span class="title">Batería</span><span class="subtitle">Energía · Carga</span></div></div>
</div>

<div class="card">
    <div class="item" data-page="bloqueo" tabindex="0">${ic('lockscreen.svg')}<div class="item-texts"><span class="title">Pantalla de bloqueo</span><span class="subtitle">Bloqueo · Biometría · AOD</span></div></div>
    <div class="item" data-page="inicio" tabindex="0">${ic('start.svg')}<div class="item-texts"><span class="title">Pantalla Inicio</span><span class="subtitle">Diseño · Apps</span></div></div>
    <div class="item" data-page="fondos" tabindex="0">${ic('wallpaper.svg')}<div class="item-texts"><span class="title">Fondo de pantalla</span><span class="subtitle">Fondos · Paleta</span></div></div>
    <div class="item" data-page="temas" tabindex="0">${ic('themes.svg')}<div class="item-texts"><span class="title">Temas</span><span class="subtitle">Temas · Modo oscuro</span></div></div>
</div>

<div class="card">
    <div class="item" data-page="seguridad" tabindex="0">${ic('security.svg')}<div class="item-texts"><span class="title">Seguridad y privacidad</span><span class="subtitle">Firewall · Permisos</span></div></div>
    <div class="item" data-page="ubicacion" tabindex="0">${ic('location.svg')}<div class="item-texts"><span class="title">Ubicación</span><span class="subtitle">Solicitudes</span></div></div>
    <div class="item" data-page="emergencia" tabindex="0">${ic('emergency.svg')}<div class="item-texts"><span class="title">Seguridad y emergencia</span><span class="subtitle">Datos médicos</span></div></div>
</div>

<div class="card">
    <div class="item" data-page="cuentas" tabindex="0">${ic('accounts.svg')}<div class="item-texts"><span class="title">Cuentas</span><span class="subtitle">Perfil · Nombre</span></div></div>
    <div class="item" data-page="avanzadas" tabindex="0">${ic('advanced.svg')}<div class="item-texts"><span class="title">Funciones avanzadas</span><span class="subtitle">Labs</span></div></div>
</div>

<div class="card">
    <div class="item" data-page="salud" tabindex="0">${ic('health.svg')}<div class="item-texts"><span class="title">Salud digital</span><span class="subtitle">Tiempo de uso</span></div></div>
    <div class="item" data-page="mantenimiento" tabindex="0">${ic('maintanance.svg')}<div class="item-texts"><span class="title">Mantenimiento</span><span class="subtitle">Almacenamiento · RAM</span></div></div>
    <div class="item" data-page="aplicaciones" tabindex="0">${ic('aplications.svg')}<div class="item-texts"><span class="title">Aplicaciones</span><span class="subtitle">Apps predeterminadas</span></div></div>
</div>

<div class="card">
    <div class="item" data-page="general" tabindex="0">${ic('general.svg')}<div class="item-texts"><span class="title">Administración general</span><span class="subtitle">Idioma · Teclado</span></div></div>
    <div class="item" data-page="accesibilidad" tabindex="0">${ic('accesibility.svg')}<div class="item-texts"><span class="title">Accesibilidad</span><span class="subtitle">Visión · Audición</span></div></div>
</div>

<div class="card">
    <div class="item" data-page="actualizacion" tabindex="0">${ic('software.svg')}<div class="item-texts"><span class="title">Actualización de software</span><span class="subtitle">Sistema · Flatpak</span></div></div>
    <div class="item" data-page="acerca" tabindex="0">${ic('about.svg')}<div class="item-texts"><span class="title">Acerca del portátil</span><span class="subtitle">Hardware · Info</span></div></div>
</div>`;
}
