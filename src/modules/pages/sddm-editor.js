/*
 * Editor visual de la PANTALLA DE BLOQUEO (Win+L). Cuelga de la página "Lock
 * screen" y es el sitio donde se coloca el reloj, las cuentas, la BookBar y los
 * widgets del bloqueo.
 *
 * El mismo theme.conf lo lee también el greeter de SDDM, así que casi todo lo
 * que se ajusta aquí se ve además en la pantalla de acceso. Las dos claves que
 * SOLO afectan al greeter (userSwitcher, blurRadius) van marcadas como tales en
 * el panel: sin esa marca parecían no hacer nada al probarlas con Win+L.
 *
 * Modelo de manipulación directa: la pantalla
 * ocupa el sitio entero, la pieza seleccionada se marca con esquinas en vez de
 * un recuadro, y sus opciones viven en un panel inferior con pestañas.
 *
 * La colocación es LIBRE: el reloj se arrastra a cualquier punto (se guarda como
 * porcentaje de la pantalla, no como una de cinco casillas) y su tamaño, grosor
 * y color se regulan de forma continua.
 *
 * La pantalla es una RÉPLICA en HTML del tema QML, no una captura, para que
 * responda al instante. Sus proporciones salen de Main.qml — si cambias tamaños
 * o posiciones allí, hay que replicarlos aquí o la maqueta miente.
 *
 * Nada toca el disco hasta pulsar "Hecho".
 */
import {
    tauriInvoke, getAssetUrl, esc, toast, showRootAuth
} from './_common.js';
import { t, getLang } from '../i18n.js';

// Textos que el greeter de SDDM y la pantalla de bloqueo NO pueden traducir por
// su cuenta: el primero arranca antes de que haya sesión y el segundo es un QML
// de Plasma, así que ninguno ve el diccionario de la app. Se escriben en
// theme.conf ya traducidos al idioma en el que está BookOS Settings al guardar,
// y el QML los pinta tal cual. Clave del .conf → clave del diccionario.
const LS_STRINGS = {
    strBattery: 'ls_battery',
    strCharging: 'ls_charging',
    strToFull: 'ls_to_full',
    strNoEvents: 'ls_no_events',
    strNotifications: 'ls_notifications',
    strNotification: 'ls_notification',
    strWrongPassword: 'ls_wrong_password',
    strCapsLock: 'ls_caps_lock',
    strSession: 'ls_session',
    strExit: 'ls_exit',
    strStarted: 'ls_started',
    strFinish: 'ls_finish',
    strObjective: 'ls_objective',
    strDeactivateRoutine: 'ls_deactivate_routine'
};

// Espejo del SDDM_KEYS de main.rs. Si añades una clave allí, añádela aquí.
const DEFAULTS = {
    variant: 'auto', accentColor: '#007AFF', pillOpacity: '80', overlayOpacity: '',
    background: 'blur', bgImage: 'backgrounds/bookos.png', blurRadius: '30',
    clockX: '50', clockY: '14', clockScale: '100', clockWeight: '700', clockColor: '',
    clockOpacity: '100', clockStretch: '100', clockAdapt: 'false', clockAdaptV: '',
    clockDepth: 'false', clockTracking: '-2',
    dateScale: '100', dateColor: '', dateWeight: '500', dateGap: '4',
    clockFormat: '24h', clockFont: 'serif', showSeconds: 'false', showDate: 'true',
    dateStyle: 'full', locale: 'es_ES',
    showBookBar: 'true', showBattery: 'true', bookBarPosition: 'bottom',
    bookBarSize: 'normal', userSwitcher: 'row',
    lockNotifications: 'true', lockNotificationContent: 'false',
    clockTint: '', widgets: '', widgetsLayout: 'stack', widgetsX: '50', widgetsY: '34',
    widgetPos: '', widgetScale: '', widgetSize: '', widgetOpacity: '', bgColor: '', usersX: '50', usersY: '52',
    bookBarContent: 'battery;media;routine', bookBarShow: 'always',
    // Los textos traducidos también son claves del .conf: entran en DEFAULTS
    // para que dirty() los vea y para que el filtro de set_sddm_config no los
    // descarte. Su valor inicial es el del idioma activo.
    ...Object.fromEntries(Object.entries(LS_STRINGS).map(([k, key]) => [k, t(key)]))
};

// Iconos meteorológicos: trazos de Heroicons outline con stroke-width 2,
// como manda el HIG al integrarlos (vienen a 1.5 de origen).
const HERO = {
    clear:  '<path d="M12 3v2.25M18.364 5.636l-1.591 1.591M21 12h-2.25M18.364 18.364l-1.591-1.591M12 18.75V21M7.227 16.773l-1.591 1.591M5.25 12H3M7.227 7.227L5.636 5.636"/><path d="M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/>',
    clouds: '<path d="M2.25 15a4.5 4.5 0 0 0 4.5 4.5H18a3.75 3.75 0 0 0 1.332-7.257 3 3 0 0 0-3.758-3.848 5.25 5.25 0 0 0-10.233 2.33A4.502 4.502 0 0 0 2.25 15Z"/>',
    partly: '<path d="M17 5.5v1.6M20.5 9h-1.6M15.5 6.2l-1.1 1.1"/><path d="M18.5 9.6a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0Z"/><path d="M2.25 15a4.5 4.5 0 0 0 4.5 4.5H18a3.75 3.75 0 0 0 1.332-7.257 3 3 0 0 0-3.758-3.848 5.25 5.25 0 0 0-10.233 2.33A4.502 4.502 0 0 0 2.25 15Z"/>',
    night:  '<path d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/>',
    rain:   '<path d="M2.25 13a4.5 4.5 0 0 0 4.5 4.5H18a3.75 3.75 0 0 0 1.332-7.257 3 3 0 0 0-3.758-3.848 5.25 5.25 0 0 0-10.233 2.33A4.502 4.502 0 0 0 2.25 13Z"/><path d="M7.5 19.5l-1 2.5M12 19.5l-1 2.5M16.5 19.5l-1 2.5"/>'
};
const wxIcon = (kind, cls) =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
        HERO[kind] || HERO.clear}</svg>`;

// Estados del tiempo con los colores exactos del Figma
// (ver BookOS-HIG/widgets-tokens.md). Los dos últimos son degradados.
const WX_STATES = {
    clear:  ['#4D9BDE', '#4D9BDE'],
    clouds: ['#AEC5DD', '#AEC5DD'],
    partly: ['#225784', '#225784'],
    night:  ['#09253E', '#09253E'],
    dawn:   ['#09253E', '#2E6698'],
    dusk:   ['#468ECD', '#1E4A71']
};
// Siluetas de los dispositivos, las mismas que pinta el QML desde devices/*.svg.
// Aquí van en línea y simplificadas: la maqueta es una RÉPLICA para colocar, no
// el resultado final, y traerse los SVG del tema obligaría a resolver una ruta
// de /usr/share desde el WebView.
const DEVICE_SVG = {
    laptop: `<svg viewBox="0 0 40 26" class="ed-dev"><rect x="4" y="1" width="32" height="21" rx="2"/><rect x="0" y="22" width="40" height="3" rx="1.2"/></svg>`,
    phone:  `<svg viewBox="0 0 40 26" class="ed-dev"><rect x="15" y="1" width="10" height="24" rx="2.4"/></svg>`,
    tablet: `<svg viewBox="0 0 40 26" class="ed-dev"><rect x="12" y="1" width="16" height="24" rx="2.4"/></svg>`,
    buds:   `<svg viewBox="0 0 40 26" class="ed-dev"><ellipse cx="13" cy="12" rx="7" ry="5.5"/><ellipse cx="27" cy="12" rx="7" ry="5.5"/></svg>`
};
// Ecosistema de ejemplo para la maqueta. En la pantalla real la lista sale de
// UPower (~/.cache/bookos-devices.json): portátil siempre, y móvil, tablet o
// auriculares según lo que haya conectado.
const DEVICE_PREVIEW = [
    { kind: 'laptop', pct: 80 },
    { kind: 'phone',  pct: 64 },
    { kind: 'buds',   pct: 92 }
];

/** Estado deducido de la hora cuando el caché no lo trae. */
function wxStateNow() {
    const h = new Date().getHours();
    if (h >= 21 || h < 6) return 'night';
    if (h < 9) return 'dawn';
    if (h >= 19) return 'dusk';
    return 'clear';
}

// Catálogo de widgets. Añadir uno aquí basta para que salga en el editor;
// su pintado real vive en GreeterWidgets.qml.
const WIDGETS = [
    ['battery', 'Batería', 'Portátil, móvil, tablet y auriculares', '🔋'],
    ['weather', 'Tiempo',  'De tu zona, sin consultar nada al iniciar', '⛅'],
    ['date',    'Fecha',   'Día del mes y tu próximo evento', '📅'],
    // Los dos siguientes necesitan datos de la sesión, así que solo se pintan
    // con Win+L. En la pantalla de acceso no hay bus de sesión al que preguntar
    // y la tarjeta simplemente no aparece.
    ['media',   'Música',  'Lo que suena, con controles · solo con Win+L', '🎵'],
    ['notifications', 'Notificaciones', 'Solo aparece si hay avisos · solo con Win+L', '🔔'],
    ['calendar',      'Calendario',     'Hoy y mañana con tus eventos · solo con Win+L', '🗓️']
];
/** Widgets que no existen en el greeter de SDDM. */
const SESSION_ONLY = ['notifications', 'calendar', 'media'];
/** Widgets con dos formas reales en GreeterWidgets.qml: píldora y tarjeta.
 *  Fecha solo tiene píldora; notificaciones y calendario, solo tarjeta. Ofrecer
 *  el par para todos dejaba poner "tarjeta" en widgets sin diseño de tarjeta y
 *  el resultado era una caja grande con la píldora perdida en medio. */
const HAS_CARD = ['battery', 'weather'];
// Familias comprobadas con `fc-list`: una inventada haría que Qt cayera al
// tipo por defecto sin avisar.
const FONTS = [
    ['bookos',    'SN Pro'],
    ['sans',      'Noto Sans'],
    ['serif',     'Noto Serif'],
    ['mono',      'DejaVu Sans Mono'],
    ['condensed', 'Fira Sans Compressed'],
    ['round',     'Cantarell']
];

// Posición individual de un widget en modo libre.
function wPos(key, axis) {
    const parts = (cfg.widgetPos || '').split(';');
    for (const p of parts) {
        const [k, xy] = p.split(':');
        if (k === key && xy) {
            const v = parseFloat(axis === 'x' ? xy.split(',')[0] : xy.split(',')[1]);
            if (!isNaN(v)) return Math.max(0, Math.min(100, v));
        }
    }
    const idx = (cfg.widgets || '').split(';').filter(Boolean).indexOf(key);
    return axis === 'x' ? (30 + idx * 20) : 34;
}
/** Variante de un widget: 'compact' (píldora) o 'large' (tarjeta). */
function wSize(key) {
    for (const p of (cfg.widgetSize || '').split(';')) {
        const [k, v] = p.split(':');
        if (k === key && v) return v;
    }
    return 'compact';
}
function setWSize(key, v) {
    const others = (cfg.widgetSize || '').split(';').filter(p => p && p.split(':')[0] !== key);
    others.push(`${key}:${v}`);
    cfg.widgetSize = others.join(';');
}

/** Escala de un widget en % (100 = tamaño base). */
/** Opacidad del fondo de un widget en % (100 = sólido). */
function wOpacity(key) {
    for (const p of (cfg.widgetOpacity || '').split(';')) {
        const [k, v] = p.split(':');
        if (k === key && v !== undefined) {
            const n = parseFloat(v);
            if (!isNaN(n)) return Math.max(20, Math.min(100, n));
        }
    }
    return 100;
}
function setWOpacity(key, v) {
    const others = (cfg.widgetOpacity || '').split(';').filter(p => p && p.split(':')[0] !== key);
    others.push(`${key}:${Math.round(v)}`);
    cfg.widgetOpacity = others.join(';');
}

function wScale(key) {
    for (const p of (cfg.widgetScale || '').split(';')) {
        const [k, v] = p.split(':');
        if (k === key) {
            const n = parseFloat(v);
            if (!isNaN(n)) return Math.max(50, Math.min(200, n));
        }
    }
    return 100;
}
function setWScale(key, v) {
    const others = (cfg.widgetScale || '').split(';').filter(p => p && p.split(':')[0] !== key);
    others.push(`${key}:${Math.round(v)}`);
    cfg.widgetScale = others.join(';');
}

function setWPos(key, x, y) {
    const others = (cfg.widgetPos || '').split(';').filter(p => p && p.split(':')[0] !== key);
    others.push(`${key}:${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`);
    cfg.widgetPos = others.join(';');
}
const THEME_DIR = '/usr/share/sddm/themes/bookos';

let cfg = { ...DEFAULTS }, saved = { ...DEFAULTS };
let users = [], selected = null, tab = 0, drag = null;

const isTrue = v => String(v) !== 'false';
const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };

// Estirado vertical efectivo del reloj (100 = sin estirar). Con la tipografía
// adaptable activada manda la medida del fondo (clockAdaptV), que calcula el
// backend; si aún no la hay, el reloj se queda sin estirar en vez de saltar a
// un valor inventado.
const clockStretch = () => Math.max(100, Math.min(260,
    cfg.clockAdapt === 'true' ? num(cfg.clockAdaptV, 100)
                              : num(cfg.clockStretch, 100)));
const dirty = () => Object.keys(DEFAULTS).some(k => cfg[k] !== saved[k]);
const bgAbsolute = () => {
    const p = cfg.bgImage || '';
    return !p ? '' : (p.startsWith('/') ? p : `${THEME_DIR}/${p}`);
};
const isDarkNow = () => cfg.variant === 'dark' ||
    (cfg.variant === 'auto' && !document.body.classList.contains('light'));

// Esquinas de selección: marcan la pieza sin encerrarla en una caja opaca.
const corners = () =>
    ['tl', 'tr', 'bl', 'br'].map(c => `<i class="ed-c ed-c-${c}"></i>`).join('');

// ── Estructura ───────────────────────────────────────────────────────────────
function markup() {
    return `
    <div class="ed-top">
      <button class="ed-back" id="ed-back" aria-label="Atrás">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <span class="ed-title">Pantalla de bloqueo</span>
    </div>

    <div class="ed-stage" id="ed-stage">
      <div class="ed-bg" id="ed-bg"></div>
      <div class="ed-scrim" id="ed-scrim"></div>
      <i class="ed-guide ed-guide-v" id="ed-gv"></i>
      <i class="ed-guide ed-guide-h" id="ed-gh"></i>

      <button class="ed-chip ed-chip-l" id="ed-wall">Fondo de pantalla</button>
      <button class="ed-chip ed-chip-r" id="ed-done">Hecho</button>

      <div class="ed-el ed-clock" id="ed-clock" data-el="clock" tabindex="0">
        <div class="ed-time" id="ed-time">09:41</div>
        <div class="ed-date" id="ed-date"></div>
        ${corners()}
      </div>

      <div class="ed-el ed-users" id="ed-users" data-el="users" tabindex="0">
        <div class="ed-avatars" id="ed-avatars"></div>
        <div class="ed-uname" id="ed-uname"></div>
        <div class="ed-field"></div>
        ${corners()}
      </div>

      <div class="ed-wlayer" id="ed-wlayer"></div>

      <div class="ed-el ed-bar" id="ed-bar" data-el="bar" tabindex="0">
        <div class="ed-pill" id="ed-pill"></div>
        ${corners()}
      </div>
    </div>

    <div class="ed-sheet" id="ed-sheet">
      <div class="ed-grab"></div>
      <div class="ed-tabs" id="ed-tabs"></div>
      <div class="ed-body" id="ed-body"></div>
    </div>`;
}


// Movimiento en caliente: durante el arrastre NO se puede llamar a paint(),
// que reasigna la URL del fondo y regenera el HTML de avatares y widgets en
// cada píxel. Eso era lo que dejaba la pieza congelada hasta soltar. Aquí solo
// se tocan dos propiedades de posición, que el compositor resuelve sin
// recalcular el resto de la maqueta.
function moveOnly(el, x, y) {
    if (!el) return;
    el.style.left = x + '%';
    el.style.top = y + '%';
}

// ── Pintado de la maqueta ────────────────────────────────────────────────────
function paint() {
    const st = document.getElementById('ed-stage');
    if (!st) return;
    const dark = isDarkNow();
    st.classList.toggle('is-dark', dark);
    st.style.setProperty('--ac', cfg.accentColor || '#007AFF');
    st.style.setProperty('--fg', dark ? '#fff' : '#000');
    st.style.setProperty('--pill', dark
        ? `rgba(28,28,30,${num(cfg.pillOpacity, 80) / 100})`
        : `rgba(255,255,255,${num(cfg.pillOpacity, 80) / 100})`);

    const bg = document.getElementById('ed-bg');
    bg.style.backgroundColor = cfg.bgColor || (dark ? '#000' : '#f2f2f7');
    if (cfg.background === 'solid' || !cfg.bgImage) {
        bg.style.backgroundImage = 'none'; bg.style.filter = 'none'; bg.style.transform = 'none';
    } else {
        bg.style.backgroundImage = `url("${getAssetUrl(bgAbsolute())}")`;
        const px = cfg.background === 'blur' ? Math.round(num(cfg.blurRadius, 30) * .28) : 0;
        bg.style.filter = px ? `blur(${px}px)` : 'none';
        bg.style.transform = px ? 'scale(1.06)' : 'none';
    }
    const ov = cfg.overlayOpacity === '' ? (dark ? 50 : 38) : num(cfg.overlayOpacity, 0);
    document.getElementById('ed-scrim').style.background =
        dark ? `rgba(0,0,0,${ov / 100})` : `rgba(255,255,255,${ov / 100})`;

    // Reloj: posición libre (centro del bloque) y tamaño continuo.
    const clock = document.getElementById('ed-clock');
    clock.style.left = num(cfg.clockX, 50) + '%';
    clock.style.top = num(cfg.clockY, 14) + '%';
    const timeEl = document.getElementById('ed-time');
    // Estirado vertical: mismo truco que el QML — se sube el cuerpo y se
    // comprime la anchura, de modo que las cifras crecen solo a lo alto.
    const stretch = clockStretch() / 100;
    timeEl.style.fontSize = (11.5 * num(cfg.clockScale, 100) / 100 * stretch) + 'cqh';
    timeEl.style.transform = stretch === 1 ? '' : `scaleX(${1 / stretch})`;
    const fam = (FONTS.find(f => f[0] === cfg.clockFont) || FONTS[0])[1];
    timeEl.style.fontFamily = `'${fam}'`;
    timeEl.style.fontWeight = String(num(cfg.clockWeight, 700));
    const col = (cfg.clockColor && cfg.clockColor !== 'auto')
        ? cfg.clockColor
        : (cfg.clockTint || (dark ? '#fff' : '#000'));
    timeEl.style.color = col;
    // Cristal: la opacidad va al elemento (arrastra la sombra con él), igual
    // que en el QML.
    const clockA = num(cfg.clockOpacity, 100) / 100;
    timeEl.style.opacity = String(clockA);
    const n = new Date(), p2 = x => String(x).padStart(2, '0');
    const sec = isTrue(cfg.showSeconds) ? ':' + p2(n.getSeconds()) : '';
    timeEl.textContent = cfg.clockFormat === '12h'
        ? `${(n.getHours() % 12) || 12}:${p2(n.getMinutes())}${sec} ${n.getHours() < 12 ? 'AM' : 'PM'}`
        : `${p2(n.getHours())}:${p2(n.getMinutes())}${sec}`;
    const d = document.getElementById('ed-date');
    d.hidden = !isTrue(cfg.showDate);
    d.style.color = col;
    d.style.opacity = String(0.85 * clockA);
    d.textContent = fmtDate(n);

    const list = users.length ? users : [{ name: '—', realName: '', icon: '' }];
    const shown = cfg.userSwitcher === 'single' ? list.slice(0, 1) : list;
    document.getElementById('ed-avatars').innerHTML = shown.map((u, i) =>
        `<span class="ed-av${i === 0 ? ' ed-sel' : ''}"${u.icon
            ? ` style="background-image:url('${getAssetUrl(u.icon)}')"` : ''}>${
            u.icon ? '' : esc((u.realName || u.name || '?').charAt(0).toUpperCase())}</span>`).join('');
    document.getElementById('ed-uname').textContent = shown[0].realName || shown[0].name || '';

    // ── Widgets ──
    // Cada uno es una pieza independiente: en modo libre se arrastra por
    // separado, así puedes tener uno arriba a la izquierda y otro abajo a la
    // derecha. El hueco "+ Añadir" siempre existe: si desapareciera al quedarse
    // sin widgets, no habría forma de añadir el primero.
    const wlist = (cfg.widgets || '').split(';').filter(Boolean);
    const clockEl = document.getElementById('ed-clock');
    const stackTop = 'calc(' + num(cfg.clockY, 14) + '% + ' +
                     (clockEl.offsetHeight / 2 + 26) + 'px)';
    const free = cfg.widgetsLayout === 'free';

    document.getElementById('ed-wlayer').innerHTML =
        wlist.map(w => {
            const meta = WIDGETS.find(m => m[0] === w) || [w, w, '', ''];
            const body = w === 'date'
                ? `<span class="ed-wt ed-wt-date"><i>${
                    new Date().toLocaleDateString((cfg.locale||'es_ES').replace('_','-'),
                    { weekday:'short' }).toUpperCase()}</i><b>${new Date().getDate()}</b>
                    <u>${esc(t('ls_no_events'))}</u></span>`
                : w === 'weather' && wSize(w) === 'large'
                ? `<span class="ed-wx">
                     <span class="ed-wx-top"><b>Madrid</b>${wxIcon(wxStateNow(), 'ed-wx-i')}</span>
                     <span class="ed-wx-t">18ºC</span>
                     <span class="ed-wx-days">${
                        [['27','32','clouds'],['28','30','clouds'],['29','30','partly'],
                         ['30','37','clear'],['31','25','rain'],['01','23','rain'],['02','35','clear']]
                        .map(([dd,tmp,st]) => `<span class="ed-wx-d"><i>${dd}</i>${
                            wxIcon(st,'')}<i>${tmp}ºC</i></span>`).join('')}
                     </span>
                   </span>`
                : w === 'weather'
                ? `<span class="ed-wi">⛅</span><span class="ed-wt"><b>18°</b><i>Madrid</i></span>`
                // Notificaciones: se maqueta la cabecera y tres avisos de
                // ejemplo. Sin texto del aviso, igual que en la pantalla real.
                : w === 'notifications'
                ? `<span class="ed-wn"><i class="ed-wn-h">NOTIFICACIONES 🔔</i>${
                    [['17:00','Mensajes'],['16:00','Correo'],['15:00','Calendario']]
                    .map(([t, app]) => `<span class="ed-wn-r"><span><i>${t}</i><b>${app}</b></span>
                        <span class="ed-wn-dot"></span></span>`).join('')}</span>`
                // Calendario: hoy y mañana, con los nombres de día del locale.
                : w === 'calendar'
                ? (() => {
                    const loc = (cfg.locale || 'es_ES').replace('_', '-');
                    const d0 = new Date(), d1 = new Date();
                    d1.setDate(d1.getDate() + 1);
                    const col = (d, ev) => `<span class="ed-wc-c">
                        <i>${d.toLocaleDateString(loc, { weekday: 'long' }).toUpperCase()}</i>
                        <b>${d.getDate()}</b>
                        ${ev ? `<span class="ed-wc-e">${ev}</span>` : `<u>${esc(t('ls_no_events'))}</u>`}</span>`;
                    return `<span class="ed-wc">${col(d0, '')}${col(d1, 'Sacar la basura')}</span>`;
                  })()
                : w === 'media'
                ? `<span class="ed-wm">
                     <span class="ed-wm-art">♪</span>
                     <span class="ed-wm-txt">
                       <b>Título de la canción</b><i>Artista</i>
                       <span class="ed-wm-ctl"><u>◀◀</u><u class="main">▶</u><u>▶▶</u></span>
                     </span>
                   </span>`
                : w === 'battery' && wSize(w) === 'large'
                ? `<span class="ed-wb">${DEVICE_PREVIEW.map((d, i) => `
                     <span class="ed-wb-d${i === 0 ? ' cur' : ''}">
                       <span class="ed-wb-ring" style="--p:${d.pct * 3.6}deg">
                         <span class="ed-wb-disc">${DEVICE_SVG[d.kind]}</span>
                       </span>
                       <i>${d.pct} %</i>
                     </span>`).join('')}</span>`
                : `<span class="ed-wi">🔋</span><span class="ed-wt"><b>${
                    esc(t('ls_battery'))}</b><i>69 %</i></span>`;
            const wxBg = w === 'weather'
                ? (() => { const [a, b] = WX_STATES[wxStateNow()];
                           return a === b ? `background:${a}`
                                          : `background:linear-gradient(${a},${b})`; })()
                : '';
            // El fondo va como variable propia y no en la clase: cada widget
            // tiene la suya y comparten hoja de estilo.
            const wOp = w === 'weather' ? '' : `--wop:${wOpacity(w) / 100};`;
            return `<div class="ed-el ed-w${w === 'weather' ? ' ed-w-wx' : ''}${
                SESSION_ONLY.includes(w) ? ' ed-w-card' : ''}${
                wSize(w) === 'large' ? (w === 'battery' ? ' ed-w-batt' : ' ed-w-large') : ''}" data-el="w:${w}" tabindex="0"
                style="font-size:${wScale(w)}%;${wOp}${wxBg}">${body}${corners()}
                <button class="ed-wdel" data-del="${w}" title="Quitar">×</button></div>`;
        }).join('') +
        (wlist.length === 0
            ? `<div class="ed-el ed-w ed-wempty" data-el="widgets" tabindex="0">
                 <span class="ed-wadd">+ Añadir widgets</span>${corners()}</div>`
            : '');

    // Colocación: en fila bajo el reloj, o cada uno en su sitio.
    let off = 0;
    document.querySelectorAll('#ed-wlayer .ed-w').forEach((el, i) => {
        const key = (el.dataset.el || '').startsWith('w:') ? el.dataset.el.slice(2) : null;
        if (free && key) {
            el.style.left = wPos(key, 'x') + '%';
            el.style.top = wPos(key, 'y') + '%';
            el.style.transform = 'translate(-50%,-50%)';
        } else {
            // Fila centrada bajo el reloj; se reparte con márgenes calculados
            // para que el conjunto quede centrado sobre el reloj.
            el.style.left = num(cfg.clockX, 50) + '%';
            el.style.top = stackTop;
            el.style.transform = 'translate(-50%,0)';
            el.style.marginLeft = off + 'px';
            off = 0;   // se ajusta abajo con el ancho real
        }
    });
    if (!free) {
        const els = [...document.querySelectorAll('#ed-wlayer .ed-w')];
        const total = els.reduce((a, e) => a + e.offsetWidth + 12, -12);
        let x = -total / 2;
        els.forEach(e => { e.style.marginLeft = x + 'px'; x += e.offsetWidth + 12; });
    }

    const usersEl = document.getElementById('ed-users');
    usersEl.style.left = num(cfg.usersX, 50) + '%';
    usersEl.style.top = num(cfg.usersY, 52) + '%';

    const bar = document.getElementById('ed-bar');
    // Apagada NO se oculta: se queda como fantasma. Ocultarla la sacaba del
    // DOM visible y con ella el ÚNICO sitio desde el que se vuelve a encender
    // (su interruptor vive en su propio panel, y al panel se llega tocándola).
    // Quien la apagaba se quedaba sin forma de recuperarla desde el editor.
    const barOn = isTrue(cfg.showBookBar);
    bar.hidden = false;
    bar.classList.toggle('ed-ghost', !barOn);
    bar.dataset.pos = cfg.bookBarPosition;
    const pill = document.getElementById('ed-pill');
    pill.classList.toggle('compact', cfg.bookBarSize === 'compact');
    pill.textContent = !barOn ? 'BookBar oculta · toca para activarla'
        : isTrue(cfg.showBattery) ? '⚡ 69% · 219 min' : 'Modo Concentración';

    document.querySelectorAll('.ed-el').forEach(e =>
        e.classList.toggle('ed-sel', e.dataset.el === selected));
    // Los widgets se repintan rehaciendo el HTML de su capa, así que el nodo
    // que tenía el foco deja de existir y las flechas dejarían de llegar tras
    // el primer toque. Se devuelve el foco a la pieza seleccionada, salvo que
    // el usuario esté escribiendo o ajustando algo en el panel de abajo.
    if (selected && !document.activeElement?.closest?.('.ed-sheet')) {
        document.querySelector(`.ed-el[data-el="${CSS.escape(selected)}"]`)?.focus?.(
            { preventScroll: true });
    }
    document.getElementById('ed-done').classList.toggle('hot', dirty());
}

function fmtDate(d) {
    const loc = (cfg.locale || 'es_ES').replace('_', '-');
    try {
        if (cfg.dateStyle === 'short') return d.toLocaleDateString(loc);
        if (cfg.dateStyle === 'weekday') return d.toLocaleDateString(loc, { weekday: 'long' });
        return d.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' });
    } catch (e) { return ''; }
}

// ── Panel inferior ───────────────────────────────────────────────────────────
const SHEETS = {
    clock: ['Fuente y color', 'Estilo'],
    users: ['Cuentas'],
    bar:   ['Contenido', 'Aspecto'],
    widgets: ['Widgets'],
    bg:    ['Fondo', 'Ajuste']
};
// La primera muestra ("A") NO es "color del tema": es el tono del propio
// fondo de pantalla, aclarado hasta que se lee sobre él. Lo calcula el backend
// al aplicar y se guarda en clockTint.
const COLORS = ['auto', '#FFFFFF', '#000000', '#007AFF', '#5AC8FA', '#34C759',
                '#FFCC00', '#FF9500', '#FF3B30', '#AF52DE', '#FF2D55'];
/** ¿El color del reloj es uno elegido a mano y no de la paleta ni "auto"? */
const isCustomColor = () => {
    const c = cfg.clockColor || 'auto';
    return c !== 'auto' && !COLORS.includes(c.toUpperCase());
};
/** Normaliza lo que se escriba a mano: "1c1c1e" y "#1C1C1E" valen igual. */
const normHex = v => {
    const h = String(v || '').trim().replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6}$/.test(h) ? '#' + h : null;
};

// El relleno del deslizador va como gradiente duro hasta --accent, que es lo
// que pide el HIG; el porcentaje se recalcula al mover.
const fillPct = (v, min, max) => ((v - min) / (max - min)) * 100;
const sliderRow = (key, label, min, max, val, lo, hi, unit) => `
    <div class="ed-row">
      <span class="ed-rl">${label}<b class="ed-val" data-for="${key}">${val}${unit || ''}</b></span>
      <div class="ed-srow">
        ${lo ? `<span class="ed-lohi">${lo}</span>` : ''}
        <input class="ed-range" type="range" data-key="${key}" min="${min}" max="${max}" value="${val}"
               style="--fill:${fillPct(val, min, max)}%">
        ${hi ? `<span class="ed-lohi">${hi}</span>` : ''}
      </div>
    </div>`;

const optRow = (key, label, opts, cur) => `
    <div class="ed-row">
      <span class="ed-rl">${label}</span>
      <div class="ed-opts" data-key="${key}">
        ${opts.map(([v, l]) => `<button type="button" class="ed-opt${cur === v ? ' on' : ''}" data-val="${v}">${l}</button>`).join('')}
      </div>
    </div>`;

const switchRow = (key, label, on) => `
    <div class="ed-row ed-row-inline">
      <span class="ed-rl">${label}</span>
      <button type="button" class="ed-sw${on ? ' on' : ''}" data-toggle="${key}" role="switch" aria-checked="${on}"><span></span></button>
    </div>`;

function sheetBody() {
    if (selected === 'clock' && tab === 0) {
        // Muestras escritas con su propia fuente y peso: la muestra ES el resultado.
        return `
        <div class="ed-fonts" data-key="clockFont">
          ${FONTS.map(([v, fam]) => `
            <button type="button" class="ed-font${cfg.clockFont === v ? ' on' : ''}" data-val="${v}"
                    title="${fam}"
                    style="font-family:'${fam}';font-weight:${num(cfg.clockWeight, 700)}">12</button>`).join('')}
        </div>
        ${sliderRow('clockWeight', 'Grosor', 100, 900, num(cfg.clockWeight, 700), 'Fina', 'Negrita')}
        ${sliderRow('clockOpacity', 'Opacidad', 20, 100, num(cfg.clockOpacity, 100),
                    'Cristal', 'Sólido', ' %')}
        ${switchRow('clockAdapt', 'Adaptar al fondo', cfg.clockAdapt === 'true')}
        ${cfg.clockAdapt === 'true'
            ? `<p class="ed-tip">Las cifras se alargan hasta llenar el hueco libre que
               deja el fondo, sin taparlo${cfg.clockAdaptV
                    ? ` (ahora, <b>${num(cfg.clockAdaptV, 100)} %</b>)` : ''}. Se vuelve a
               medir al cambiar de imagen o de sitio el reloj.</p>`
            : sliderRow('clockStretch', 'Estirado vertical', 100, 260,
                        num(cfg.clockStretch, 100), 'Normal', 'Alta', ' %')}
        ${sliderRow('clockTracking', 'Separación entre cifras', -8, 8,
                    num(cfg.clockTracking, -2), 'Junta', 'Suelta', ' %')}
        ${switchRow('clockDepth', 'Profundidad (capas)', cfg.clockDepth === 'true')}
        <p class="ed-tip">Con profundidad, el sujeto del fondo se recorta y se pinta
        <b>por delante</b> del reloj. Solo funciona si el fondo tiene un sujeto claro
        contra cielo, pared o degradado; si no lo tiene, se queda como está.</p>
        <div class="ed-row">
          <span class="ed-rl">Color</span>
          <div class="ed-colors" data-key="clockColor">
            ${COLORS.map(c => `
              <button type="button" class="ed-col${(cfg.clockColor || 'auto') === c ? ' on' : ''}${c === 'auto' ? ' auto' : ''}"
                      data-val="${c}" title="${c === 'auto' ? 'Adaptado al fondo de pantalla' : c}"
                      ${c !== 'auto' ? `style="background:${c}"`
                        : (cfg.clockTint ? `style="background:${cfg.clockTint}"` : '')}
                      >${c === 'auto' ? 'A' : ''}</button>`).join('')}
            <!-- Cualquier otro color. El <input type=color> del sistema va
                 DEBAJO de la muestra y transparente: así el botón conserva el
                 aspecto de los demás en vez del cuadro gris del navegador, y
                 al pulsarlo se abre el selector nativo. -->
            <label class="ed-col ed-col-pick${isCustomColor() ? ' on' : ''}"
                   title="Color personalizado"
                   style="background:${isCustomColor() ? cfg.clockColor : 'transparent'}">
              ${isCustomColor() ? '' : '<span>+</span>'}
              <input type="color" id="ed-clockcol"
                     value="${isCustomColor() ? cfg.clockColor : (cfg.clockTint || '#FFFFFF')}">
            </label>
          </div>
        </div>
        ${isCustomColor() ? `
        <div class="ed-row ed-row-inline">
          <span class="ed-rl">Código</span>
          <input class="ed-hex" id="ed-clockhex" type="text" maxlength="7"
                 value="${esc(cfg.clockColor)}" spellcheck="false">
        </div>` : ''}
        <p class="ed-tip">La muestra <b>A</b> toma el tono del fondo de pantalla y lo
        aclara hasta que se lee bien encima. Cambia sola al cambiar el fondo.
        Con <b>+</b> eliges cualquier otro color, o escribes su código.</p>`;
    }
    if (selected === 'clock' && tab === 1) {
        return `
        <div class="ed-row ed-row-inline">
          <span class="ed-rl">Posición</span>
          <div class="ed-opts">
            <button type="button" class="ed-opt" id="ed-center-h">Centrar horizontal</button>
            <button type="button" class="ed-opt" id="ed-center-v">Centrar vertical</button>
          </div>
        </div>
        ${optRow('clockFormat', 'Hora', [['24h', '24 h'], ['12h', '12 h']], cfg.clockFormat)}
        ${switchRow('showSeconds', 'Segundos', isTrue(cfg.showSeconds))}
        ${switchRow('showDate', 'Mostrar fecha', isTrue(cfg.showDate))}
        ${isTrue(cfg.showDate) ? optRow('dateStyle', 'Fecha',
            [['full', 'Día y mes'], ['short', 'Numérica'], ['weekday', 'Solo día']], cfg.dateStyle)
          + sliderRow('dateScale', 'Tamaño de la fecha', 50, 200, num(cfg.dateScale, 100),
                      'Pequeña', 'Grande', ' %')
          + sliderRow('dateWeight', 'Grosor de la fecha', 100, 900, num(cfg.dateWeight, 500),
                      'Fina', 'Negrita')
          + sliderRow('dateGap', 'Separación del reloj', 0, 40, num(cfg.dateGap, 4),
                      'Pegada', 'Suelta', ' px')
          + `<div class="ed-row">
               <span class="ed-rl">Color de la fecha</span>
               <div class="ed-colors" data-key="dateColor">
                 <button type="button" class="ed-col auto${!cfg.dateColor ? ' on' : ''}"
                         data-val="" title="El mismo que el reloj">=</button>
                 ${COLORS.filter(c => c !== 'auto').map(c => `
                   <button type="button" class="ed-col${cfg.dateColor === c ? ' on' : ''}"
                           data-val="${c}" title="${c}" style="background:${c}"></button>`).join('')}
               </div>
             </div>` : ''}
        <p class="ed-tip">Arrastra el reloj para moverlo y tira de una esquina para
        cambiar su tamaño. El grosor está en "Fuente y color".</p>`;
    }
    if (selected === 'users') {
        return `
        ${optRow('userSwitcher', 'Selector', [['row', 'Todas las cuentas'], ['single', 'Solo la última']], cfg.userSwitcher)}
        <p class="ed-tip">Con "Todas las cuentas" se ven todos los usuarios en fila y se
        entra pulsando el que quieras. <b>Solo en la pantalla de acceso</b>: con
        Win+L el sistema solo expone la cuenta que está bloqueada, así que ahí no
        cambia nada. Arrastra el bloque para colocarlo; eso sí vale para ambas.</p>`;
    }
    // Un widget concreto seleccionado (data-el = "w:battery").
    if (selected && selected.startsWith('w:')) {
        const key = selected.slice(2);
        const meta = WIDGETS.find(m => m[0] === key) || [key, key, ''];
        const on = (cfg.widgets || '').split(';').filter(Boolean);
        return `
        <div class="ed-wpick" data-key="widgets">
          ${WIDGETS.map(([v, l, sub, ic]) => `
            <button type="button" class="ed-wopt${on.includes(v) ? ' on' : ''}${v === key ? ' cur' : ''}" data-w="${v}">
              <span class="ed-wopt-ic">${ic}</span>
              <span><b>${l}</b><i>${sub}</i></span>
              <span class="ed-wopt-mark">${on.includes(v) ? '−' : '+'}</span>
            </button>`).join('')}
        </div>
        ${HAS_CARD.includes(key) ? `
        <div class="ed-row">
          <span class="ed-rl">Forma de ${meta[1]}</span>
          <div class="ed-opts" data-wsize="${key}">
            <button type="button" class="ed-opt${wSize(key) === 'compact' ? ' on' : ''}" data-val="compact">Píldora</button>
            <button type="button" class="ed-opt${wSize(key) === 'large' ? ' on' : ''}" data-val="large">Tarjeta</button>
          </div>
        </div>` : ''}
        ${sliderRow('wscale:' + key, 'Tamaño', 50, 200, wScale(key), 'Pequeño', 'Grande', ' %')}
        ${key !== 'weather'
            ? sliderRow('wopa:' + key, 'Fondo', 20, 100, wOpacity(key), 'Cristal', 'Sólido', ' %')
              + `<p class="ed-tip">Solo se transparenta el fondo: los textos siguen
                 opacos para que el widget se siga leyendo.</p>`
            : `<p class="ed-tip">El tiempo no admite transparencia: su color no es una
               superficie, es el cielo del diseño.</p>`}
        ${cfg.widgetsLayout === 'free' ? `
        <div class="ed-row">
          <span class="ed-rl">Posición<b class="ed-val">${
              Math.round(wPos(key, 'x'))} · ${Math.round(wPos(key, 'y'))} %</b></span>
          <div class="ed-opts">
            <button type="button" class="ed-opt" data-wcenter="${key}">Centrar</button>
            <button type="button" class="ed-opt" data-wstack="${key}">Bajo el reloj</button>
          </div>
        </div>` : ''}
        ${optRow('widgetsLayout', 'Colocación',
            [['stack', 'Bajo el reloj'], ['free', 'Libre']], cfg.widgetsLayout)}
        <p class="ed-tip">Con el widget seleccionado, las <b>flechas</b> lo mueven punto a
        punto y con <b>Mayús</b> de cinco en cinco. También puedes arrastrarlo o tirar de
        una esquina.${cfg.widgetsLayout === 'stack'
            ? ' En "Bajo el reloj" van en fila y se mueven con él, así que las flechas no aplican.'
            : ''}</p>`;
    }
    if (selected === 'widgets') {
        const on = (cfg.widgets || '').split(';').filter(Boolean);
        return `
        <div class="ed-wpick" data-key="widgets">
          ${WIDGETS.map(([v, l, sub, ic]) => `
            <button type="button" class="ed-wopt${on.includes(v) ? ' on' : ''}" data-w="${v}">
              <span class="ed-wopt-ic">${ic}</span>
              <span><b>${l}</b><i>${sub}</i></span>
              <span class="ed-wopt-mark">${on.includes(v) ? '−' : '+'}</span>
            </button>`).join('')}
        </div>
        ${optRow('widgetsLayout', 'Colocación',
            [['stack', 'Bajo el reloj'], ['free', 'Libre']], cfg.widgetsLayout)}
        <p class="ed-tip">${cfg.widgetsLayout === 'stack'
            ? 'Van en fila bajo el reloj y se mueven con él.'
            : 'Arrastra cada widget por separado a donde quieras.'}</p>`;
    }
    if (selected === 'bar' && tab === 0) {
        const on = (cfg.bookBarContent || '').split(';').filter(Boolean);
        const C = [['battery', 'Batería', 'Porcentaje y tiempo restante'],
                   ['media', 'Música', 'Lo que esté sonando'],
                   ['routine', 'Modos y rutinas', 'El modo activo del ecosistema']];
        return `
        ${switchRow('showBookBar', 'Mostrar BookBar', isTrue(cfg.showBookBar))}
        ${isTrue(cfg.showBookBar) ? `
          <p class="ed-sub">Qué puede aparecer</p>
          <div class="ed-wpick" data-key="bookBarContent">
            ${C.map(([v, l, sub]) => `
              <button type="button" class="ed-wopt${on.includes(v) ? ' on' : ''}" data-bb="${v}">
                <span><b>${l}</b><i>${sub}</i></span>
                <span class="ed-wopt-mark">${on.includes(v) ? '−' : '+'}</span>
              </button>`).join('')}
          </div>
          ${optRow('bookBarShow', 'Cuándo se ve',
              [['always', 'Siempre'], ['charging', 'Solo al cargar']], cfg.bookBarShow)}
          <p class="ed-tip">${cfg.bookBarShow === 'charging'
              ? 'La píldora se oculta en uso normal y aparece al enchufar el cargador, con una animación.'
              : 'Siempre visible mientras haya algo que mostrar.'}</p>` : ''}`;
    }
    if (selected === 'bar' && tab === 1) {
        return `
        ${optRow('bookBarPosition', 'Posición', [['bottom', 'Abajo'], ['top', 'Arriba']], cfg.bookBarPosition)}
        ${optRow('bookBarSize', 'Tamaño', [['normal', 'Normal'], ['compact', 'Compacta']], cfg.bookBarSize)}`;
    }
    if (selected === 'bg' && tab === 0) {
        const thumb = cfg.bgImage ? `background-image:url('${getAssetUrl(bgAbsolute())}')` : '';
        return `
        <div class="ed-modes" data-key="background">
          <button type="button" class="ed-mode${cfg.background === 'blur' ? ' on' : ''}" data-val="blur">
            <span class="ed-thumb blur" style="${thumb}"></span><span>Desenfocado</span></button>
          <button type="button" class="ed-mode${cfg.background === 'image' ? ' on' : ''}" data-val="image">
            <span class="ed-thumb" style="${thumb}"></span><span>Nítido</span></button>
          <button type="button" class="ed-mode${cfg.background === 'solid' ? ' on' : ''}" data-val="solid">
            <span class="ed-thumb solid"></span><span>Liso</span></button>
        </div>
        ${cfg.background === 'solid' ? `
        <div class="ed-row">
          <span class="ed-rl">Color del fondo</span>
          <div class="ed-colors" data-key="bgColor">
            ${['', '#000000', '#1C1C1E', '#2D2B6B', '#0A3D62', '#14532D',
               '#7C2D12', '#4A044E', '#F2F2F7', '#FFFFFF'].map(c => `
              <button type="button" class="ed-col${(cfg.bgColor || '') === c ? ' on' : ''}${c === '' ? ' auto' : ''}"
                      data-val="${c}" title="${c === '' ? 'Del tema' : c}"
                      ${c ? `style="background:${c}"` : ''}>${c === '' ? 'A' : ''}</button>`).join('')}
          </div>
        </div>` : `
        <div class="ed-row ed-row-inline">
          <span class="ed-rl">Imagen</span>
          <button class="ed-btn" id="ed-pick">Elegir…</button>
        </div>`}`;
    }
    if (selected === 'bg' && tab === 1) {
        return `
        ${cfg.background === 'blur'
            ? sliderRow('blurRadius', 'Desenfoque', 0, 60, num(cfg.blurRadius, 30), 'Nítido', 'Difuso')
              + `<p class="ed-tip">El desenfoque se calcula al guardar y se guarda como
                 imagen aparte, así la pantalla no gasta tiempo en difuminar al arrancar.</p>`
            : ''}
        ${sliderRow('overlayOpacity', 'Oscurecimiento', 0, 90,
            cfg.overlayOpacity === '' ? 45 : num(cfg.overlayOpacity, 0), 'Claro', 'Oscuro')}
        ${sliderRow('pillOpacity', 'Opacidad de píldoras', 20, 100, num(cfg.pillOpacity, 80), 'Trans.', 'Sólida')}
        ${optRow('variant', 'Aspecto', [['auto', 'Auto'], ['light', 'Claro'], ['dark', 'Oscuro']], cfg.variant)}
        <p class="ed-sub">Pantalla de bloqueo (Win+L)</p>
        ${switchRow('lockNotifications', 'Mostrar notificaciones', isTrue(cfg.lockNotifications))}
        ${isTrue(cfg.lockNotifications)
            ? switchRow('lockNotificationContent', 'Mostrar su contenido', isTrue(cfg.lockNotificationContent))
              + `<p class="ed-tip">Con el contenido oculto se ve qué aplicación avisa y
                 cuántos avisos hay, pero no el texto. Un portátil bloqueado suele estar
                 desatendido.</p>` : ''}`;
    }
    return `<p class="ed-tip">Toca el reloj, las cuentas o la BookBar para personalizarlos.
            Toca el fondo para cambiar la imagen.</p>`;
}

// Mide el hueco libre del fondo y guarda el estirado que le toca al reloj.
// El backend es quien puede abrir la imagen; el QML de la pantalla no.
// Silencioso a propósito: es un refinamiento, y si ImageMagick no está o la
// imagen no se puede leer, el reloj se queda como estaba en vez de dar un error
// por algo que el usuario no ha pedido explícitamente.
let adaptBusy = false;
async function measureAdapt() {
    if (cfg.clockAdapt !== 'true' || adaptBusy) return;
    const bg = bgAbsolute();
    if (!bg) return;
    adaptBusy = true;
    try {
        const r = JSON.parse(await tauriInvoke('sddm_clock_adapt', {
            path: bg, clockY: num(cfg.clockY, 14), clockScale: num(cfg.clockScale, 100) }));
        if (r.ok) { cfg.clockAdaptV = String(r.stretch); refresh(); }
    } catch (e) { /* se queda el estirado anterior */ }
    adaptBusy = false;
}

// Genera el recorte del sujeto para el efecto de profundidad. Puede no salir
// —un fondo sin sujeto claro no da recorte— y eso NO es un error: se avisa una
// vez y el interruptor se apaga solo, en vez de dejarlo encendido sin efecto.
let cutoutBusy = false;
async function makeCutout() {
    if (cutoutBusy) return;
    const bg = bgAbsolute();
    if (!bg) return;
    cutoutBusy = true;
    try {
        const r = JSON.parse(await tauriInvoke('sddm_clock_depth',
            { path: bg, clockY: num(cfg.clockY, 14) }));
        if (!r.ok) {
            cfg.clockDepth = 'false';
            toast(r.reason === 'sin sujeto claro'
                ? 'Este fondo no tiene un sujeto que recortar'
                : 'No se pudo preparar la profundidad', '⚠️');
            refresh();
        }
    } catch (e) {
        cfg.clockDepth = 'false';
        toast('No se pudo preparar la profundidad', '⚠️');
        refresh();
    }
    cutoutBusy = false;
}

/** ¿Está el editor realmente en pantalla? */
const mounted = () => !!document.getElementById('ed-stage');

function sheet() {
    // Los listeners viven en el contenedor de la app, que sobrevive a las
    // navegaciones. Si se ha salido del editor, sus nodos ya no existen y
    // escribir en ellos reventaba con "null is not an object".
    if (!mounted()) return;
    // Un widget concreto no está en SHEETS: su pestaña lleva su propio nombre.
    let tabs = SHEETS[selected] || [];
    if (selected && selected.startsWith('w:')) {
        const m = WIDGETS.find(w => w[0] === selected.slice(2));
        tabs = [m ? m[1] : 'Widget'];
    }
    document.getElementById('ed-tabs').innerHTML = tabs.length > 1
        ? tabs.map((l, i) => `<button type="button" class="ed-tab${i === tab ? ' on' : ''}" data-tab="${i}">${l}</button>`).join('')
        : (tabs.length ? `<span class="ed-tab on static">${tabs[0]}</span>` : '');
    document.getElementById('ed-body').innerHTML = sheetBody();
    document.getElementById('ed-sheet').classList.toggle('empty', !selected);
}

const refresh = () => { if (!mounted()) return; paint(); sheet(); };

// ── Página ───────────────────────────────────────────────────────────────────
export async function renderSddmEditor(c) {
    try {
        cfg = { ...DEFAULTS, ...JSON.parse(await tauriInvoke('get_sddm_config')) };
        saved = { ...cfg };
    } catch (e) { cfg = { ...DEFAULTS }; saved = { ...cfg }; }
    try { users = JSON.parse(await tauriInvoke('list_login_users')); } catch (e) { users = []; }

    selected = null; tab = 0;
    c.innerHTML = markup();
    // El contenedor es un proxy que descarta escrituras si el usuario ha
    // navegado a otra página mientras se cargaban los datos. Si eso pasa, no
    // hay maqueta y seguir solo produciría errores más adelante.
    if (!mounted()) return;
    refresh();
    // Config heredada con la tipografía adaptable puesta pero sin medida (por
    // ejemplo tras cambiar el fondo desde otro sitio): se mide al abrir.
    if (cfg.clockAdapt === 'true' && !cfg.clockAdaptV) measureAdapt();

    const stage = document.getElementById('ed-stage');
    const set = (k, v) => { if (cfg[k] !== v) { cfg[k] = v; refresh(); } };

    // Mismo motivo que en pages.js: el listener se engancha una sola vez, así
    // que no puede quedarse con el contenedor de la primera visita.
    c._sddmEdC = c;
    if (!c._sddmEdBound) {
    c._sddmEdBound = true;
    c.addEventListener('click', async ev => {
        if (!mounted()) return;
        if (ev.target.closest('#ed-back')) { window.goBackExt?.() || window.history.back(); return; }

        const tb = ev.target.closest('.ed-tab[data-tab]');
        if (tb) { tab = +tb.dataset.tab; refresh(); return; }

        const wsz = ev.target.closest('[data-wsize] .ed-opt');
        if (wsz) {
            setWSize(wsz.parentElement.dataset.wsize, wsz.dataset.val);
            refresh();
            return;
        }

        const wc = ev.target.closest('[data-wcenter]');
        if (wc) { setWPos(wc.dataset.wcenter, 50, 34); refresh(); return; }
        const ws = ev.target.closest('[data-wstack]');
        if (ws) { set('widgetsLayout', 'stack'); return; }

        const opt = ev.target.closest('.ed-opt, .ed-font, .ed-col, .ed-mode');
        if (opt) { set(opt.parentElement.dataset.key, opt.dataset.val); return; }

        const del = ev.target.closest('[data-del]');
        if (del) {
            const k = del.dataset.del;
            const on = (cfg.widgets || '').split(';').filter(Boolean).filter(w => w !== k);
            cfg.widgets = on.join(';');
            if (selected === 'w:' + k) selected = 'widgets';
            refresh();
            return;
        }

        const bb = ev.target.closest('[data-bb]');
        if (bb) {
            const on = (cfg.bookBarContent || '').split(';').filter(Boolean);
            const i = on.indexOf(bb.dataset.bb);
            if (i === -1) on.push(bb.dataset.bb); else on.splice(i, 1);
            set('bookBarContent', on.join(';'));
            return;
        }

        const wo = ev.target.closest('.ed-wopt');
        if (wo) {
            const on = (cfg.widgets || '').split(';').filter(Boolean);
            const i = on.indexOf(wo.dataset.w);
            if (i === -1) on.push(wo.dataset.w); else on.splice(i, 1);
            set('widgets', on.join(';'));
            return;
        }

        const sw = ev.target.closest('.ed-sw');
        if (sw) {
            const on = !sw.classList.contains('on');
            set(sw.dataset.toggle, on ? 'true' : 'false');
            // Al encender la tipografía adaptable hay que medir el fondo: sin
            // medida el reloj se quedaría igual y parecería que el interruptor
            // no hace nada.
            if (sw.dataset.toggle === 'clockAdapt' && on) measureAdapt();
            if (sw.dataset.toggle === 'clockDepth' && on) makeCutout();
            return;
        }

        if (ev.target.closest('#ed-center-h')) { set('clockX', '50'); return; }
        if (ev.target.closest('#ed-center-v')) { set('clockY', '50'); return; }

        if (ev.target.closest('#ed-pick') || ev.target.closest('#ed-wall')) {
            try {
                const { open } = window.__TAURI__.dialog;
                const path = await open({ multiple: false,
                    filters: [{ name: 'Imagen', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
                if (path) {
                    cfg.bgImage = path;
                    if (cfg.background === 'solid') cfg.background = 'blur';
                    // El acento se recalcula con el fondo nuevo: es lo que se
                    // espera al cambiar de wallpaper, sin tener que pedirlo.
                    try {
                        const r = JSON.parse(await tauriInvoke('sddm_accent_from_image', { path: bgAbsolute() }));
                        // accent para anillos y botones; tint es el mismo tono
                        // aclarado, que es lo que usa el reloj en modo "A".
                        if (r.ok) { cfg.accentColor = r.accent; cfg.clockTint = r.tint || ''; }
                    } catch (e) { /* se quedan los colores anteriores */ }
                    // El hueco libre es otro para cada imagen: se vuelve a medir,
                    // y el recorte del fondo anterior ya no sirve.
                    measureAdapt();
                    if (cfg.clockDepth === 'true') makeCutout();
                    selected = 'bg'; tab = 0; refresh();
                }
            } catch (e) { toast('No se pudo abrir el selector', '❌'); }
            return;
        }

        if (ev.target.closest('#ed-done')) {
            if (!dirty()) { window.goBackExt?.() || window.history.back(); return; }
            const b = ev.target.closest('#ed-done');
            const label = b.textContent;   // respeta el idioma: no siempre es "Hecho"
            const pwd = await showRootAuth('Permisos requeridos',
                'Para guardar la pantalla de inicio de sesión, introduce la contraseña del equipo.');
            if (pwd === null) return;
            b.disabled = true; b.textContent = 'Guardando…';
            // El idioma pudo cambiar entre abrir el editor y guardar; y una
            // config vieja traía las cadenas del idioma anterior. Se reescriben
            // siempre con las del idioma activo, que es lo que hace que la
            // pantalla de acceso hable el mismo idioma que la app.
            for (const [k, key] of Object.entries(LS_STRINGS)) cfg[k] = t(key);
            // El modo "A" del reloj usa clockTint, que solo se calculaba al
            // ELEGIR una imagen desde aquí. Quien traía un fondo de antes (o lo
            // puso desde otro sitio) se quedaba sin tinte y el reloj caía al
            // color del tema — negro en claro, ilegible sobre la foto.
            if ((cfg.clockColor || 'auto') === 'auto' && !cfg.clockTint && bgAbsolute()) {
                try {
                    const r = JSON.parse(await tauriInvoke('sddm_accent_from_image',
                        { path: bgAbsolute() }));
                    if (r.ok && r.tint) cfg.clockTint = r.tint;
                } catch (e) { /* sin tinte, manda el respaldo del QML */ }
            }
            cfg.locale = getLang() === 'es' ? 'es_ES' : 'en_US';
            try {
                const r = JSON.parse(await tauriInvoke('set_sddm_config',
                    { cfg: JSON.stringify(cfg), password: pwd }));
                if (r.ok) { saved = { ...cfg }; toast('Pantalla de inicio de sesión actualizada'); }
                else toast(r.error || 'No se pudo guardar', '❌');
            } catch (e) { toast('No se pudo guardar', '❌'); }
            b.textContent = label; b.disabled = false; refresh();
            return;
        }

        if (ev.target.closest('.ed-sheet')) return;

        const el = ev.target.closest('.ed-el');
        const next = el ? el.dataset.el : (ev.target.closest('#ed-stage') ? 'bg' : null);
        if (next !== selected) { selected = next; tab = 0; }
        refresh();
    });

    c.addEventListener('input', ev => {
        if (!mounted()) return;

        if (ev.target.id === 'ed-clockcol') {
            cfg.clockColor = ev.target.value.toUpperCase();
            paint();
            return;
        }
        if (ev.target.id === 'ed-clockhex') {
            const hex = normHex(ev.target.value);
            // Mientras se escribe, "#1C" todavía no es un color: se deja el
            // campo en paz y no se toca la maqueta hasta que sea válido.
            if (hex) { cfg.clockColor = hex; paint(); }
            return;
        }

        const r = ev.target.closest('.ed-range');
        if (!r) return;
        if (r.dataset.key.startsWith('wscale:')) {
            setWScale(r.dataset.key.slice(7), r.value);
        } else if (r.dataset.key.startsWith('wopa:')) {
            setWOpacity(r.dataset.key.slice(5), r.value);
        } else {
            cfg[r.dataset.key] = String(r.value);
        }
        r.style.setProperty('--fill',
            ((r.value - r.min) / (r.max - r.min)) * 100 + '%');
        const lbl = document.querySelector(`.ed-val[data-for="${r.dataset.key}"]`);
        if (lbl) lbl.textContent = r.value +
            (r.dataset.key === 'dateGap' ? ' px'
             : r.dataset.key.startsWith('wscale:') || r.dataset.key.startsWith('wopa:') ||
               ['clockScale', 'clockStretch', 'clockOpacity', 'clockTracking', 'dateScale']
                 .includes(r.dataset.key) ? ' %' : '');
        // Solo repinta la maqueta: rehacer el panel en cada píxel del deslizador
        // lo reconstruiría bajo el dedo y se perdería el arrastre.
        paint();
        if (r.dataset.key === 'clockWeight')
            document.querySelectorAll('.ed-font').forEach(f => f.style.fontWeight = r.value);
    });

    }   // fin del enganche único al contenedor

    // ── Arrastre: mover el reloj, o redimensionarlo desde una esquina ──
    //
    // El tamaño se deduce de la distancia del puntero al centro del bloque: al
    // alejar la esquina crece y al acercarla encoge, que es como se comporta un
    // asa de redimensionado en cualquier editor. Se toma la distancia y no solo
    // el eje X para que funcione igual arrastrando en diagonal.
    const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

    stage.addEventListener('pointerdown', ev => {
        const el = ev.target.closest('.ed-el');
        if (!el) return;
        const kind = el.dataset.el;
        // El reloj siempre; los widgets solo en modo libre (en "stack" van
        // pegados al reloj y moverlos por su cuenta no tendría sentido).
        const isW = kind && kind.startsWith('w:');
        const movable = kind === 'clock' || kind === 'users'
                     || (isW && cfg.widgetsLayout === 'free');
        if (!movable) return;
        const r = stage.getBoundingClientRect();
        const handle = (kind === 'clock' || isW) ? ev.target.closest('.ed-c') : null;
        const wkey = isW ? kind.slice(2) : null;
        const kx = kind === 'users' ? 'usersX' : 'clockX';
        const ky = kind === 'users' ? 'usersY' : 'clockY';
        const curX = wkey ? wPos(wkey, 'x') : num(cfg[kx], 50);
        const curY = wkey ? wPos(wkey, 'y') : num(cfg[ky], kind === 'users' ? 52 : 14);
        const cx = r.left + r.width * curX / 100;
        const cy = r.top + r.height * curY / 100;

        if (handle) {
            const d0 = dist(ev.clientX, ev.clientY, cx, cy);
            // d0 puede ser casi 0 si se pincha justo en el centro; el mínimo
            // evita una división que dispararía la escala al infinito.
            drag = { mode: 'size', wkey, el,
                     d0: Math.max(12, d0),
                     s0: wkey ? wScale(wkey) : num(cfg.clockScale, 100),
                     cx, cy };
        } else {
            drag = {
                mode: 'move', wkey, kx, ky, el,
                dx: curX - ((ev.clientX - r.left) / r.width) * 100,
                dy: curY - ((ev.clientY - r.top) / r.height) * 100
            };
        }
        el.setPointerCapture?.(ev.pointerId);
        stage.classList.add('dragging');
        if (selected !== kind) { selected = kind; tab = 0; refresh(); }
        ev.preventDefault();
    });

    stage.addEventListener('pointermove', ev => {
        if (!drag) return;
        const r = stage.getBoundingClientRect();

        if (drag.mode === 'size') {
            const k = dist(ev.clientX, ev.clientY, drag.cx, drag.cy) / drag.d0;
            if (drag.wkey) {
                // Los widgets escalan por font-size: sus medidas están en em,
                // así que la tarjeta entera crece sin recalcular la maqueta.
                setWScale(drag.wkey, Math.max(50, Math.min(200, drag.s0 * k)));
                if (drag.el) drag.el.style.fontSize = wScale(drag.wkey) + '%';
                return;
            }
            cfg.clockScale = String(Math.round(Math.max(40, Math.min(260, drag.s0 * k))));
            // Igual que al mover: solo la propiedad que cambia.
            const tEl = document.getElementById('ed-time');
            if (tEl) tEl.style.fontSize =
                (11.5 * num(cfg.clockScale, 100) / 100 * clockStretch() / 100) + 'cqh';
            return;
        }

        // Se limita contando el TAMAÑO del elemento, no solo su centro: antes
        // se acotaba el punto central al 6-94 % y por eso media pieza quedaba
        // recortada contra el borde.
        const el2 = drag.el;
        const halfW = el2 ? (el2.offsetWidth / 2 / r.width) * 100 : 0;
        const halfH = el2 ? (el2.offsetHeight / 2 / r.height) * 100 : 0;
        const clampX = v => Math.max(halfW + 1, Math.min(100 - halfW - 1, v));
        const clampY = v => Math.max(halfH + 1, Math.min(100 - halfH - 1, v));
        let x = clampX(((ev.clientX - r.left) / r.width) * 100 + drag.dx);
        let y = clampY(((ev.clientY - r.top) / r.height) * 100 + drag.dy);
        // Encaje magnético al centro: a menos de 2,5 puntos se pega al 50 % y se
        // enciende la guía. Es la forma de centrar sin tener que afinar a mano.
        const snapX = Math.abs(x - 50) < 2.5, snapY = Math.abs(y - 50) < 2.5;
        if (snapX) x = 50;
        if (snapY) y = 50;
        document.getElementById('ed-gv').classList.toggle('on', snapX);
        document.getElementById('ed-gh').classList.toggle('on', snapY);
        if (drag.wkey) setWPos(drag.wkey, x, y);
        else {
            cfg[drag.kx] = String(Math.round(x * 10) / 10);
            cfg[drag.ky] = String(Math.round(y * 10) / 10);
        }
        moveOnly(drag.el, Math.round(x * 10) / 10, Math.round(y * 10) / 10);
    });

    const endDrag = () => {
        if (!drag) return;
        // El hueco que le toca al reloj depende de dónde esté y de lo que mida:
        // al soltarlo se vuelve a medir, no durante el arrastre (sería un
        // proceso de ImageMagick por cada píxel).
        if (!drag.wkey && drag.kx !== 'usersX') measureAdapt();
        drag = null;
        stage.classList.remove('dragging');
        document.getElementById('ed-gv').classList.remove('on');
        document.getElementById('ed-gh').classList.remove('on');
        refresh();
    };
    // ── Colocación con el teclado ──
    // Arrastrar con el ratón no baja del punto porcentual y para cuadrar dos
    // widgets a la misma altura hace falta esa precisión. Las flechas mueven de
    // uno en uno y con Mayús de cinco en cinco, que es lo que hace cualquier
    // editor de maquetación.
    c.addEventListener('keydown', ev => {
        if (!mounted()) return;
        // Si el foco está en un deslizador o un campo, las flechas son suyas.
        if (ev.target.closest('.ed-sheet')) return;
        const DIRS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const d = DIRS[ev.key];
        if (!d || !selected) return;

        const step = (ev.shiftKey ? 5 : 1);
        const dx = d[0] * step, dy = d[1] * step;
        const clamp = v => Math.max(0, Math.min(100, Math.round(v * 10) / 10));

        if (selected === 'clock') {
            cfg.clockX = String(clamp(num(cfg.clockX, 50) + dx));
            cfg.clockY = String(clamp(num(cfg.clockY, 14) + dy));
            measureAdapt();
        } else if (selected === 'users') {
            cfg.usersX = String(clamp(num(cfg.usersX, 50) + dx));
            cfg.usersY = String(clamp(num(cfg.usersY, 52) + dy));
        } else if (selected && selected.startsWith('w:')) {
            // En "stack" los widgets cuelgan del reloj y no tienen posición
            // propia que mover: se ignora en vez de guardar un valor que no se
            // usaría y reaparecería al cambiar a "libre".
            if (cfg.widgetsLayout !== 'free') return;
            const k = selected.slice(2);
            setWPos(k, clamp(wPos(k, 'x') + dx), clamp(wPos(k, 'y') + dy));
        } else return;

        ev.preventDefault();
        refresh();
    });

    c.addEventListener('change', ev => {
        if (!mounted()) return;
        if (ev.target.id === 'ed-clockcol') { cfg.clockColor = ev.target.value.toUpperCase(); refresh(); }
    });

    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
}
