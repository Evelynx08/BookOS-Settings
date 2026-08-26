import{tauriInvoke,getAssetUrl}from'../../tauri-api.js';
import{t}from'../i18n.js';

// ── Settings cache — optimistic in-memory store, updated on every write ──
// Prevents toggle state from "resetting" when navigating back to a page before
// the disk write completes or before get_bookos_setting returns.
const _sc=new Map();
async function getSetting(key,def=''){
    if(_sc.has(key))return _sc.get(key);
    try{const v=JSON.parse(await tauriInvoke('get_bookos_setting',{key,defaultVal:def})).value;_sc.set(key,v);return v;}
    catch(e){console.error('[getSetting]',key,e);return def;}
}
function setSetting(key,value){
    _sc.set(key,String(value)); // update cache synchronously — UI reads this next time
    return tauriInvoke('set_bookos_setting',{key,value:String(value)}).catch(()=>{});
}
// Seed the in-memory settings cache from a batch read without writing to disk.
function primeSetting(key,value){_sc.set(key,value);}

// ── Invoke result cache — avoids re-running slow shell commands on back-navigation ──
// TTLs are conservative: hardware rarely changes in <30s of normal use.
const _ic=new Map();
const _IC_TTL={
    check_hw_features:30000,   // powerprofilesctl, sysfs reads
    get_display_info:30000,    // kscreen-doctor
    get_sink_descriptions:60000, // pactl list sinks - descriptive, static
    get_audio_devices:10000,   // pactl short lists
    get_system_info:120000,    // uname, lscpu — never changes
    get_available_themes:120000,
    get_kde_light_dark_themes:30000,
    get_style_themes:30000,
    get_kwin_effects:30000,
    get_battery_history:20000, // upower history
    get_battery_sysfs:3000,    // fast, but no need to re-read more than 3s
    get_current_theme:5000,    // color scheme — changes only on user action
    get_style_themes:30000,    // kvantum theme list
    get_app_power_usage:15000, // ps aux
};
async function ci(cmd,args){
    const ttl=_IC_TTL[cmd];
    if(!ttl)return tauriInvoke(cmd,args);
    const key=cmd+(args?JSON.stringify(args):'');
    const hit=_ic.get(key);
    if(hit&&Date.now()-hit.ts<ttl)return hit.v;
    const v=await tauriInvoke(cmd,args);
    _ic.set(key,{v,ts:Date.now()});
    return v;
}
// Invalidate a cache entry when we know it changed (e.g. after setting a mode)
function _icInvalidate(cmd){for(const k of _ic.keys())if(k.startsWith(cmd))_ic.delete(k);}

// ── Hardware state cache (5s TTL) — avoids blocking page loads on kscreen-doctor ──
const _hwCache={data:null,ts:0};
async function getCachedHwState(){
    const now=Date.now();
    if(_hwCache.data&&now-_hwCache.ts<5000)return _hwCache.data;
    try{
        const d=await tauriInvoke('obtener_estado_pantalla');
        _hwCache.data=d;_hwCache.ts=Date.now();return d;
    }catch{return null;}
}
export function invalidateHwCache(){_hwCache.data=null;_hwCache.ts=0;}

// ── HTML Escape (prevents XSS from WiFi SSIDs, BT names, pkg names) ──
function esc(s){
    const d=document.createElement('div');
    d.textContent=s;
    return d.innerHTML;
}

// ── Auto-refresh helper — registers interval in _pageIntervals, cleaned up on navigation.
// Skips firing while the document is hidden (window minimized / sidebar collapsed away),
// which keeps CPU near 0 when the user isn't watching.
function addInterval(fn, ms){
    if(!window._pageIntervals)window._pageIntervals=[];
    const id=setInterval(()=>{ if(!document.hidden) fn(); },ms);
    window._pageIntervals.push(id);
    return id;
}

// ── Toast notification system ──
let toastContainer=null;
// Map legacy emoji icons -> inline SVG for clean visual style. Falls back to the
// passed string if no mapping (so old toast('msg','✓') still works).
const _TOAST_ICONS = {
    '✓':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    '✕':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    '❌':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    '✅':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    '⚠':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    '⚠️':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    '⚡':'<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    '🔋':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/></svg>',
    '🔒':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    '🔔':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    '🔊':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    '🔁':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    '🔗':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    '🎧':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
    '🎙️':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg>',
    '📷':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    '📋':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
    '🌙':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    '🛡':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    '🛡️':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    '🗑️':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    '🧹':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.36 2.72 9.21 12.87a2 2 0 0 0-.55 1.05L7 22l8.09-1.66a2 2 0 0 0 1.05-.55L26.28 9.64a2 2 0 0 0 0-2.83l-4.09-4.09a2 2 0 0 0-2.83 0z" transform="scale(0.85) translate(-2 -2)"/></svg>',
    '🔑':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
    '⬇':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
    '↩':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
    '✋':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>',
    '🎯':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    '🎉':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.8 11.3 2 22l10.7-3.79"/><path d="M4 3h.01M22 8h.01M15 2h.01M22 20h.01"/><path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10"/></svg>',
    '📶':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>',
    '📍':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    '🚪':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    '♻️':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 4 7 4 7 8"/><path d="M3 11v6a2 2 0 0 0 2 2h6"/><polyline points="21 20 17 20 17 16"/><path d="M21 13V7a2 2 0 0 0-2-2h-6"/></svg>',
    '🔄':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    'ℹ':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    '🌍':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    '🌐':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    '🎙':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/></svg>',
    '🔵':'<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>',
    '🕐':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    '🖥️':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    '🖨️':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
    '🖼️':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    '🗑':'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    '...':'',
};
// Runtime ES->EN dict for toast messages. Lets us keep call-site strings short
// without converting every toast to i18n keys. Patterns can use $1/$2 for params.
const _TOAST_TR_EN = {
    'Fondo añadido':'Wallpaper added',
    'Error al añadir fondo':'Could not add wallpaper',
    'Fondo de pantalla aplicado':'Wallpaper applied',
    'Error al aplicar fondo':'Could not apply wallpaper',
    'Contraseña incorrecta':'Wrong password',
    'Contraseña incorrecta o error':'Wrong password or error',
    'Huella verificada — pero esta acción aún requiere contraseña':'Fingerprint verified — this action still requires password',
    'Conectando...':'Connecting...',
    'Error al conectar':'Connection failed',
    'Error':'Error',
    'Red olvidada':'Network forgotten',
    'Error al olvidar la red':'Failed to forget network',
    'Estilo guardado':'Style saved',
    'Horario guardado':'Schedule saved',
    'Perfil automático activado':'Automatic profile enabled',
    'Balance centrado':'Balance centered',
    'Volumen cambiado':'Volume changed',
    'Carga ilimitada':'Unlimited charge',
    'Error al aplicar límite de carga':'Failed to apply charge limit',
    'Carga adaptativa activada':'Adaptive charging on',
    'Carga adaptativa desactivada':'Adaptive charging off',
    'Abriendo historial':'Opening history',
    'Permiso denegado':'Permission denied',
    'Periodo de gracia actualizado':'Grace period updated',
    'Historial borrado':'History cleared',
    'Huella registrada':'Fingerprint registered',
    'Pantalla de inicio actualizada':'Login screen updated',
    'Error al guardar configuración SDDM':'Failed to save SDDM settings',
    'Error al seleccionar imagen':'Failed to select image',
    'Tema aplicado':'Theme applied',
    'Modo oscuro activado':'Dark mode enabled',
    'Modo claro activado':'Light mode enabled',
    'Sonidos activados':'Sounds enabled',
    'Sonidos desactivados':'Sounds disabled',
    'AOD activado':'AOD enabled',
    'AOD desactivado':'AOD disabled',
    'Book Bar activada':'Book Bar enabled',
    'Book Bar desactivada':'Book Bar disabled',
    'Limpieza completada':'Cleanup complete',
    'Programado para esta noche':'Scheduled for tonight',
    'Tema lockscreen activado':'Lockscreen theme enabled',
    'Tema lockscreen desactivado':'Lockscreen theme disabled',
    'Tema SDDM activado':'SDDM theme enabled',
    'Tema SDDM desactivado':'SDDM theme disabled',
    'Reconexión automática activada':'Auto-reconnect enabled',
    'Reconexión automática desactivada':'Auto-reconnect disabled',
    'Conexión fácil activada':'Easy pairing enabled',
    'Conexión fácil desactivada':'Easy pairing disabled',
    'Próximamente':'Coming soon',
    'Cortafuegos activado':'Firewall enabled',
    'Cortafuegos desactivado':'Firewall disabled',
    'Cámara activada':'Camera enabled',
    'Cámara bloqueada':'Camera blocked',
    'Micrófono activo':'Microphone active',
    'Micrófono silenciado':'Microphone muted',
    'Historial activado':'History enabled',
    'Historial desactivado':'History disabled',
    'Movimiento reducido':'Motion reduced',
    'Animaciones normales':'Animations normal',
    'Tamaño del cursor actualizado':'Cursor size updated',
    'Tamaño actualizado — cierra sesión para aplicar':'Size updated — log out to apply',
    'Colores invertidos':'Colors inverted',
    'Colores normales':'Colors normal',
    'Latencia del cursor optimizada':'Cursor latency optimized',
    'Latencia restablecida a valores por defecto':'Latency reset to default',
    'Gestos táctiles activados':'Touch gestures enabled',
    'Gestos táctiles desactivados':'Touch gestures disabled',
    'Paleta de colores activada':'Color palette enabled',
    'Paleta desactivada':'Color palette disabled',
    'Atenuación activada':'Dimming enabled',
    'Atenuación desactivada':'Dimming disabled',
    'Error EQ':'EQ error',
    'Centro':'Center',
    // ── Connections / network ──
    'Wi-Fi activado':'Wi-Fi on',
    'Wi-Fi desactivado':'Wi-Fi off',
    'Modo Avión activado':'Airplane mode on',
    'Modo Avión desactivado':'Airplane mode off',
    'Conectado a':'Connected to',
    // ── Display ──
    'Cambiando a modo oscuro':'Switching to dark mode',
    'Cambiando a modo claro':'Switching to light mode',
    'Protección de la vista activada':'Eye comfort on',
    'Protección de la vista desactivada':'Eye comfort off',
    'Protector de vista activado':'Eye protector on',
    'Protector de vista desactivado':'Eye protector off',
    'Resolución':'Resolution',
    'Tiempo de espera':'Timeout',
    // ── Sound ──
    'Sonidos de notificación activados':'Notification sounds on',
    'Sonidos de interfaz activados':'Interface sounds on',
    'Salida':'Output',
    'Entrada':'Input',
    'Silenciado':'Muted',
    'Sonido activado':'Sound on',
    // ── Battery / performance ──
    'Rendimiento normal':'Normal performance',
    'Porcentaje visible en el widget':'Percentage shown in widget',
    'Porcentaje oculto en el widget':'Percentage hidden in widget',
    // ── Notifications ──
    'No molestar activado':'Do not disturb on',
    'No molestar desactivado':'Do not disturb off',
    'Notificaciones en pantalla bloqueada activadas':'Lock screen notifications on',
    'Desactivadas en bloqueo':'Hidden on lock screen',
    'Todas las notificaciones visibles':'All notifications visible',
    'Sólo notificaciones críticas':'Critical notifications only',
    // ── Security / lock ──
    'Tiempo de bloqueo':'Lock time',
    'permiso denegado':'permission denied',
    'Tipo de bloqueo: PIN':'Lock type: PIN',
    'Tipo de bloqueo: Contraseña':'Lock type: Password',
    'Esta acción requiere contraseña':'This action requires a password',
    // ── Themes / icons ──
    'Aplicando iconos…':'Applying icons…',
    'Iconos aplicados':'Icons applied',
    'No se pudieron aplicar los iconos':'Could not apply icons',
    'Programación activada':'Schedule enabled',
    'Programación desactivada':'Schedule disabled',
    'Error al abrir la previsualización':'Failed to open preview',
    // ── Updates ──
    'Fallo':'Failure',
    'No se pudo cambiar el canal':'Could not change channel',
    'Repositorio BookOS activado':'BookOS repository enabled',
    'Repositorio BookOS desactivado':'BookOS repository disabled',
    'Sistema actualizado correctamente':'System updated successfully',
    'Actualizando':'Updating',
    // ── Accounts ──
    'Nombre del equipo actualizado':'Device name updated',
    'Nombre guardado':'Name saved',
    'Hostname guardado':'Hostname saved',
    'Inicio automático activado':'Autologin enabled',
    'Inicio automático desactivado':'Autologin disabled',
    'no se pudo aplicar':'could not apply',
    'no se pudo borrar':'could not delete',
    'no se pudo crear':'could not create',
    'Contraseña cambiada con éxito':'Password changed successfully',
    // ── Maintenance ──
    'Error en limpieza':'Cleanup error',
    'Reglas Polkit configuradas con éxito!':'Polkit rules configured!',
    'Error al configurar':'Configuration error',
    // ── Routines / wellbeing ──
    'Rutina actualizada':'Routine updated',
    'Objetivo actualizado':'Goal updated',
    'Modo enfoque activado':'Focus mode on',
    'Modo enfoque desactivado':'Focus mode off',
    // ── Labs / compositor ──
    'Desenfoque activado':'Blur enabled',
    'Desenfoque desactivado':'Blur disabled',
    'Ventanas elásticas activadas':'Wobbly windows enabled',
    'Ventanas elásticas desactivadas':'Wobbly windows disabled',
    'Lámpara mágica activada':'Magic lamp enabled',
    'Lámpara mágica desactivada':'Magic lamp disabled',
    'Compositor reiniciado':'Compositor restarted',
    // ── Buds ──
    'Error: ¿buds conectados?':'Error: are the buds connected?',
    'Error iniciando prueba':'Error starting test',
    'Error de conexión':'Connection error',
    'Error al cambiar ANC':'Failed to change ANC',
    'Error GBC':'GBC error',
    'Cambio automático activado':'Auto switch enabled',
    'Cambio automático desactivado':'Auto switch disabled',
    'Sonido de localización':'Locate sound',
    'Error al localizar':'Locate failed',
    'Requiere Galaxy Buds Client':'Requires Galaxy Buds Client',
    'Táctil bloqueado':'Touch locked',
    'Táctil activo':'Touch active',
    // ── Share / P2P ──
    'No se pudo abrir el selector de archivos':'Could not open file picker',
    'Enviando…':'Sending…',
    'Error al enviar':'Send failed',
    'Wi-Fi Direct conectado con':'Wi-Fi Direct connected to',
    'Error P2P':'P2P error',
    'Wi-Fi Direct activo con':'Wi-Fi Direct active with',
    'No se pudo iniciar Quick Share':'Could not start Quick Share',
    'Carpeta actualizada':'Folder updated',
    'Sin dispositivos cercanos encontrados':'No nearby devices found',
    // ── Misc ──
    'Reindexando en segundo plano…':'Reindexing in background…',
    'Ubicación activada':'Location on',
    'Ubicación desactivada':'Location off',
    'Información médica guardada':'Medical info saved',
    'Tamaño de icono':'Icon size',
};

// Dynamic toast patterns (routine/mode/theme messages built with template strings)
const _TOAST_TR_DYN=[
    [/^Rutina "(.+)" ejecutada automáticamente$/,'Routine "$1" run automatically'],
    [/^Rutina "(.+)" ejecutada \((.+)\)$/,'Routine "$1" run ($2)'],
    [/^"(.+)" ejecutada$/,'"$1" run'],
    [/^"(.+)" restaurada$/,'"$1" restored'],
    [/^"(.+)" desactivada — estado restaurado$/,'"$1" disabled — previous state restored'],
    [/^"(.+)" desactivada$/,'"$1" disabled'],
    [/^"(.+)" activada$/,'"$1" enabled'],
    [/^Modo (.+) activado$/,'$1 mode on'],
    [/^Tema aplicado: (.+)$/,'Theme applied: $1'],
    [/^(\d+) fondos añadidos$/,'$1 wallpapers added'],
    [/^Protección activa: hasta el (\d+)%$/,'Protection active: up to $1%'],
    [/^Límite de carga: (\d+)%$/,'Charge limit: $1%'],
    [/^Cuenta "(.+)" creada$/,'Account "$1" created'],
];
function _toastTr(msg){
    if(!msg) return msg;
    // Follow the same locale resolution as t(): manual override first, then
    // system locale. (Used to default to Spanish, leaking untranslated toasts
    // to every non-override English user.)
    const stored=(typeof localStorage!=='undefined' ? localStorage.getItem('bookos_lang') : null);
    const lang=(stored&&stored!=='auto')?(stored.startsWith('es')?'es':'en')
        :((navigator.language||'en').toLowerCase().startsWith('es')?'es':'en');
    if (lang === 'es') return msg;
    if (_TOAST_TR_EN[msg]) return _TOAST_TR_EN[msg];
    // Fall back to the UI literal dictionary — many toast strings ('Rutina
    // creada', 'Desactivados', …) only exist there.
    if (_UI_TR_EN[msg]) return _UI_TR_EN[msg];
    for (const [re,rep] of _TOAST_TR_DYN) {
        if (re.test(msg)) return msg.replace(re,rep);
    }
    // Try prefix matches like "EQ: Dinámico"
    for (const k in _TOAST_TR_EN) {
        if (msg.startsWith(k + ':') || msg.startsWith(k + ' ')) {
            return _TOAST_TR_EN[k] + msg.slice(k.length);
        }
    }
    return msg;
}

function toast(msg, icon='✓'){
    if(!toastContainer){
        toastContainer=document.createElement('div');
        toastContainer.className='toast-container';
        document.body.appendChild(toastContainer);
    }
    const t=document.createElement('div');
    t.className='toast';
    // Map known emoji icons to inline SVG so toasts look uniform; arbitrary HTML icons pass through.
    const svgIcon = _TOAST_ICONS[icon] !== undefined ? _TOAST_ICONS[icon] : icon;
    t.innerHTML=`<span class="toast-icon">${svgIcon}</span>${esc(_toastTr(msg))}`;
    toastContainer.appendChild(t);
    setTimeout(()=>t.remove(),3000);
}
// Expose globally so other modules / event listeners can show toasts
if(typeof window!=='undefined'){
    window.toast=toast;
    window._tr=_tr;
}

// El diálogo de autenticación vive en pages.js, que lo publica como
// window.promptAuth al cargarse. Aquí solo se enruta: llamarlo directamente
// lanzaba ReferenceError y cualquier botón que pidiera contraseña —"Hecho"
// del editor de inicio de sesión, entre otros— moría en silencio.
function promptAuth(opts={}){
    const fn=typeof window!=='undefined'?window.promptAuth:null;
    if(typeof fn!=='function'){
        console.error('promptAuth no disponible: pages.js no se ha cargado');
        toast('No se pudo abrir la ventana de autenticación','❌');
        return Promise.resolve(null);
    }
    return fn(opts);
}

// ── Dialog (replaces browser confirm()) ──
let _dlgSeq=0;
function showDialog(title,msg,{confirmText='Confirmar',confirmClass='confirm',cancelText='Cancelar',onConfirm,onCancel}={}){
    // Se guarda quién tenía el foco para devolvérselo al cerrar; sin esto el
    // foco se perdía al body y el teclado quedaba en el limbo.
    const prevFocus=document.activeElement;
    const titleId='bk-dlg-t'+(++_dlgSeq);
    const ov=document.createElement('div');
    ov.className='bk-overlay';
    ov.innerHTML=`<div class="bk-dialog" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
        <div class="bk-dialog-title" id="${titleId}">${title}</div>
        ${msg?`<div class="bk-dialog-msg">${msg}</div>`:''}
        <div class="bk-dialog-btns">
            <button class="bk-dbtn cancel" id="d-cancel">${cancelText}</button>
            ${confirmText!=null?`<button class="bk-dbtn ${confirmClass}" id="d-ok">${confirmText}</button>`:''}
        </div>
    </div>`;
    document.body.appendChild(ov);
    const close=()=>{ov.remove();document.removeEventListener('keydown',onKey,true);try{prevFocus?.focus?.();}catch(e){}};
    function onKey(e){
        if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();onCancel?.();return;}
        if(e.key!=='Tab')return;
        // Trampa de foco: Tab cicla solo entre los botones del diálogo.
        const f=[...ov.querySelectorAll('button')].filter(b=>!b.disabled);
        if(!f.length)return;
        const first=f[0],last=f[f.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    }
    // En captura: se adelanta al Escape global de main.js, que antes navegaba
    // hacia atrás dejando el diálogo huérfano encima de la página nueva.
    document.addEventListener('keydown',onKey,true);
    ov.querySelector('#d-cancel').onclick=()=>{close();onCancel?.();};
    ov.querySelector('#d-ok')?.addEventListener('click',()=>{close();onConfirm?.();});
    ov.addEventListener('click',e=>{if(e.target===ov){close();onCancel?.();}});
    (ov.querySelector('#d-ok')||ov.querySelector('#d-cancel'))?.focus();
}

// ── Root password prompt — thin wrapper over promptAuth().
// Returns Promise<string|null>. Fingerprint matches resolve with empty string
// (callers that need the literal password should switch to promptAuth directly).
function showRootAuth(title,desc=''){
    return promptAuth({
        title,
        description:desc,
        confirmLabel:'Autorizar',
        verifyPassword:false,
        allowFingerprint:true,
    }).then(r=>{
        if(!r)return null;
        if(r.method==='fingerprint')return '';   // signal: use cached sudo / skip pw arg
        return r.password||null;
    });
}

// ── Generic Sudo action: shows prompt, runs command ──
async function promptSudo(actionName, cmd, args) {
    const pwd=await showRootAuth('Permisos requeridos',`Para ${actionName}, introduce la contraseña del equipo.`);
    if(pwd===null)return false;
    const res=JSON.parse(await tauriInvoke('run_sudo_command',{cmd,args,password:pwd}));
    if(res.ok)return true;
    toast('Contraseña incorrecta o error','❌');
    return false;
}

/**
 * Invoke a backend command that may return `{ok:false, needs_auth:true}`.
 * If so, opens promptAuth() and re-invokes with the password injected as `password`.
 *
 * @param {string} cmd        Tauri command name
 * @param {object} args       Args dict
 * @param {object} authOpts   Forwarded to promptAuth
 * @returns parsed JSON response or null if user cancelled
 */
async function invokeWithAuth(cmd, args={}, authOpts={}){
    let r=JSON.parse(await tauriInvoke(cmd, args));
    if(r.ok)return r;
    if(!r.needs_auth)return r;
    const auth=await promptAuth({
        title:'Se requiere autorización',
        description:'Esta acción modifica configuración del sistema. Confirma tu identidad para continuar.',
        ...authOpts,
    });
    if(!auth)return null;
    if(auth.method==='fingerprint'){
        // No password to forward; backend will retry. Most backends still need a real
        // sudo token though, so fingerprint alone won't satisfy them — fall through.
        toast('Huella verificada — pero esta acción aún requiere contraseña','ℹ');
        return null;
    }
    r=JSON.parse(await tauriInvoke(cmd, {...args, password:auth.password}));
    if(!r.ok && r.error)toast('Error: '+r.error,'❌');
    return r;
}

// ── Skeleton Loaders ──
function renderSkeleton(rows=3){
    const widths=['w80','w60','w100','w40'];
    let html='<div class="skeleton">';
    html+='<div class="skeleton-line thick w60"></div>';
    for(let i=0;i<rows;i++) html+=`<div class="skeleton-line ${widths[i%widths.length]}"></div>`;
    html+='</div>';
    return html;
}
function renderSkeletonChart(){
    let html='<div class="skeleton"><div class="skeleton-line w40"></div><div class="skeleton-bar-row">';
    for(let i=0;i<24;i++) html+=`<div class="skeleton-bar" style="height:${20+Math.random()*60}%"></div>`;
    html+='</div></div>';
    return html;
}

// ── Readable UI Helpers ──
function renderLoading(msg='Cargando...'){
    return `<div class="loading"><div class="spinner"></div>${msg}</div>`;
}
function renderCard(items){
    return `<div class="detail-card">${items.join('')}</div>`;
}
function renderInfoItem(title, subtitle=''){
    return `<div class="detail-item"><span class="dt">${_tr(title)}</span>${subtitle?`<span class="ds">${_tr(subtitle)}</span>`:''}</div>`;
}
// Runtime ES->EN dict for all UI labels (rows, sections, headers).
// Auto-translates any string that contains a known ES phrase when bookos_lang=en.
const _UI_TR_EN = {
    // ── Widgets, BookBar y fondo del editor de login ──
    'Widgets':'Widgets', '+ Añadir widgets':'+ Add widgets', 'Quitar':'Remove',
    'Colocación':'Placement', 'Bajo el reloj':'Under the clock', 'Libre':'Free',
    'Batería':'Battery', 'Carga y tiempo restante':'Charge and time left',
    'Tiempo':'Weather', 'De tu zona, sin consultar nada al iniciar':
        'For your area, with no lookup at startup',
    'Fecha':'Date', 'Día del mes':'Day of the month',
    'Arrastra cada widget por separado a donde quieras.':
        'Drag each widget separately wherever you want.',
    'Van en fila bajo el reloj y se mueven con él.':
        'They sit in a row under the clock and move with it.',
    'Todos van en fila bajo el reloj y se mueven con él. Cambia a "Libre" para colocarlos uno a uno.':
        'They all sit in a row under the clock and move with it. Switch to "Free" to place them one by one.',
    'Contenido':'Content', 'Aspecto':'Appearance',
    'Qué puede aparecer':'What can appear',
    'Música':'Music', 'Lo que esté sonando':'Whatever is playing',
    'Modos y rutinas':'Modes and routines', 'El modo activo del ecosistema':'The active ecosystem mode',
    'Porcentaje y tiempo restante':'Percentage and time left',
    'Cuándo se ve':'When it shows', 'Siempre':'Always', 'Solo al cargar':'Only while charging',
    'La píldora se oculta en uso normal y aparece al enchufar el cargador, con una animación.':
        'The pill hides during normal use and appears when you plug in the charger, with an animation.',
    'Siempre visible mientras haya algo que mostrar.':'Always visible while there is something to show.',
    'Color del fondo':'Background color', 'Del tema':'From theme',
    'Grosor':'Weight', 'Tamaño':'Size',
    'La muestra <b>A</b> toma el tono del fondo de pantalla y lo':
        'The <b>A</b> swatch takes the hue of the wallpaper and',
    'aclara hasta que se lee bien encima. Cambia sola al cambiar el fondo.':
        'lightens it until it reads on top. It updates when the wallpaper changes.',
    'Mostrar notificaciones':'Show notifications', 'Mostrar su contenido':'Show their content',
    'Pantalla de bloqueo (Win+L)':'Lock screen (Win+L)',
    'Con el contenido oculto se ve qué aplicación avisa y':
        'With content hidden you see which app is notifying and',
    'cuántos avisos hay, pero no el texto. Un portátil bloqueado suele estar':
        'how many there are, but not the text. A locked laptop is usually',
    'desatendido.':'unattended.',
    'Centrar horizontal':'Center horizontally', 'Centrar vertical':'Center vertically',
    'Posición':'Position', 'Selector':'Selector',
    // ── Editor de la pantalla de inicio de sesión (sddm-editor.js) ──
    // Sin estas entradas la pasada de traducción del DOM dejaba el panel a
    // medias: "Position"/"Size" traducidos y "Compacta"/"Solo la última" no.
    // El editor cuelga de "Lock screen" y su objetivo principal es Win+L; el
    // título decía "Login screen", que apuntaba a la pantalla equivocada.
    'Pantalla de bloqueo':'Lock screen',
    'Personalizar la pantalla':'Customize the screen',
    'Reloj, fondo, cuentas, BookBar y widgets · también en el acceso':
        'Clock, wallpaper, accounts, BookBar and widgets · also on the login screen',
    'Pantalla de inicio de sesión':'Login screen',
    'Reloj, fondo, cuentas y BookBar del login':'Clock, wallpaper, accounts and BookBar',
    'Fuente y color':'Font and color', 'Estilo':'Style', 'Ajuste':'Adjust',
    'Grosor':'Weight', 'Fina':'Thin', 'Negrita':'Bold',
    'Color':'Color', 'Automático':'Automatic',
    'Tamaño':'Size', 'Pequeño':'Small', 'Grande':'Large',
    'Hora':'Time', 'Segundos':'Seconds', 'Mostrar fecha':'Show date',
    'Fecha':'Date', 'Día y mes':'Day and month', 'Numérica':'Numeric', 'Solo día':'Day only',
    'Selector':'Selector', 'Todas las cuentas':'All accounts', 'Solo la última':'Last one only',
    'Cuentas':'Accounts',
    'Mostrar BookBar':'Show BookBar', 'Compacta':'Compact', 'Normal':'Normal',
    'Desenfocado':'Blurred', 'Nítido':'Sharp', 'Liso':'Solid',
    'Imagen':'Image', 'Elegir…':'Choose…',
    'Desenfoque':'Blur', 'Difuso':'Diffuse',
    'Oscurecimiento':'Dimming', 'Claro':'Light', 'Oscuro':'Dark',
    'Opacidad de píldoras':'Pill opacity', 'Trans.':'Trans.', 'Sólida':'Solid',
    'Aspecto':'Appearance', 'Auto':'Auto',
    'Fondo de pantalla':'Wallpaper', 'Hecho':'Done', 'Centrar':'Center',
    'Arrastra el reloj por la pantalla para colocarlo donde quieras.':
        'Drag the clock anywhere on the screen.',
    'Arrastra una esquina para cambiar el tamaño.':'Drag a corner to resize.',
    'Con "Todas las cuentas" se ven todos los usuarios en fila y se':
        'With "All accounts" every user is shown in a row and you',
    'entra pulsando el que quieras, como en macOS.':
        'sign in by tapping the one you want, like macOS.',
    'Toca el reloj, las cuentas o la BookBar para personalizarlos.':
        'Tap the clock, the accounts or the BookBar to customize them.',
    'Toca el fondo para cambiar la imagen.':'Tap the background to change the image.',

    // ── Added in full-app translation sweep ──
    'Buscando actualizaciones...':'Checking for updates...',
    'Color del estuche':'Case color',
    'No hay rutinas':'No routines',
    'Abre el greeter en modo prueba':'Opens the greeter in test mode',
    'Activo para':'Active for',
    'Añadir contacto':'Add contact',
    'Automatiza brillo, tema, no molestar y más según hora o eventos':'Automate brightness, theme, do not disturb and more by time or events',
    'Borra el índice y el modelo':'Clears the index and the model',
    'Color de acento':'Accent color',
    'Condición de activación':'Trigger condition',
    'Contraseña incorrecta. Inténtalo de nuevo.':'Wrong password. Try again.',
    'Escribe para buscar…':'Type to search…',
    'Esta acción es permanente.':'This action is permanent.',
    'Este equipo es visible para dispositivos cercanos mientras Bluetooth está activado.':'This device is visible to nearby devices while Bluetooth is on.',
    'Grupo sanguíneo':'Blood type',
    'Guardar rutina':'Save routine',
    'Imagen de fondo':'Background image',
    'La carga adaptativa aprende cuándo usas el equipo y detiene la carga antes de que llegue al 100%, completándola justo a tiempo.':'Adaptive charging learns when you use your device and stops charging before it reaches 100%, finishing it just in time.',
    'Mínimo 8 caracteres':'At least 8 characters',
    'Nivel de batería estimado':'Estimated battery level',
    'No cierres la aplicación':'Do not close the app',
    'No disponible con carga adaptativa':'Not available with adaptive charging',
    'Nombre de la rutina…':'Routine name…',
    'Nueva contraseña':'New password',
    'O toca el sensor de huella':'Or tap the fingerprint sensor',
    'p. ej. María García':'e.g. Jane Doe',
    'Para obtener mejores predicciones, deja el equipo enchufado durante la noche.':'For better predictions, leave the device plugged in overnight.',
    'Permitir privilegios de administrador (sudo)':'Allow administrator privileges (sudo)',
    'Previsualizar pantalla':'Preview screen',
    'Procesa todos los archivos de nuevo':'Reprocesses all files',
    'Repite la contraseña':'Repeat the password',
    'Revierte los cambios cuando la condición deje de cumplirse':'Reverts changes when the condition no longer holds',
    'Se borrarán los archivos personales del usuario':'The user\'s personal files will be deleted',
    'Sin actividad significativa':'No significant activity',
    'Sin resultados.':'No results.',
    'Teléfono':'Phone',
    'y no se podrá recuperar.':'and cannot be recovered.',
    // Recovery / snapshots page
    'Recuperación':'Recovery',
    'Tomar captura al actualizar':'Take a snapshot when updating',
    'Al actualizar paquetes':'On package updates',
    'Antes de cada actualización de paquetes':'Before every package update',
    'Al actualizar el sistema':'On system updates',
    'Solo antes de subir de versión BookOS':'Only before a BookOS version upgrade',
    'Nunca':'Never',
    'No crear capturas automáticamente':'Never create snapshots automatically',
    'Las instantáneas requieren un sistema de archivos Btrfs.':'Snapshots require a Btrfs filesystem.',
    'Puntos de restauración':'Restore points',
    'No hay capturas todavía.':'No snapshots yet.',
    'Captura':'Snapshot',
    'Revertir':'Revert',
    'Revertir el sistema':'Roll back the system',
    'Se restaurará la captura':'Snapshot will be restored:',
    'Necesitarás reiniciar para aplicarla. ¿Continuar?':'You will need to reboot to apply it. Continue?',
    'Revertido — reinicia para aplicar':'Reverted — reboot to apply',
    'Política de capturas actualizada':'Snapshot policy updated',
    'Avisos de actualizaciones':'Update alerts',
    'Notificar cuando haya actualizaciones de BookOS o paquetes':'Notify when BookOS or package updates are available',
    'Avisos de actualizaciones activados':'Update alerts enabled',
    'Avisos de actualizaciones desactivados':'Update alerts disabled',
    // Display page
    'Ajustes del modo Oscuro':'Dark mode settings',
    'Ajustes del modo Claro':'Light mode settings',
    'Brillo':'Brightness',
    'Fluidez de movimientos':'Motion smoothness',
    'Protección de la vista':'Eye comfort',
    'Modo de pantalla':'Screen mode',
    'Tiempo de espera de pantalla':'Screen timeout',
    'Tiempo de espera':'Timeout',
    'Vision Booster':'Vision Booster',
    'Brillo máximo · Gama amplia P3':'Max brightness · Wide P3 gamut',
    'HDR10 nativo · Gama dinámica alta':'Native HDR10 · High dynamic range',
    'Ahorro de pantalla':'Display saver',
    '90 Hz · GPU en reposo · Brillo al 40%':'90 Hz · GPU idle · 40% brightness',
    'Brillo de pantalla':'Screen brightness',
    'Brillo del teclado':'Keyboard brightness',
    'Automático':'Automatic',
    'Activado':'On','Desactivado':'Off',
    'Activada':'Enabled','Desactivada':'Disabled',
    'Activar':'Enable','Desactivar':'Disable',
    'Activar (90Hz)':'Enable (90Hz)','Desactivar (120Hz)':'Disable (120Hz)',
    // Common labels
    'Aplicaciones':'Applications',
    'Batería':'Battery',
    'Bluetooth':'Bluetooth',
    'Conexiones':'Connections',
    'Cuentas':'Accounts',
    'Pantalla':'Display',
    'Pantalla Inicio':'Home screen',
    'Pantalla de bloqueo':'Lock screen',
    'Sonidos y vibración':'Sound & vibration',
    'Notificaciones':'Notifications',
    'Modos y rutinas':'Modes & routines',
    'Dispositivos conectados':'Connected devices',
    'Seguridad y privacidad':'Security & privacy',
    'Accesibilidad':'Accessibility',
    'Funciones avanzadas':'Advanced features',
    'Administración general':'General management',
    'Actualización de software':'Software update',
    'Acerca del portátil':'About this laptop',
    'Temas':'Themes',
    // Security/lock
    'Tipo de bloqueo':'Lock type',
    'Contraseña clásica':'Classic password',
    'Hará autologin':'Will enable autologin',
    'Contraseña del sistema':'System password',
    'Configurar huella':'Set up fingerprint',
    'Huella registrada':'Fingerprint enrolled',
    'Contraseña huella digital':'Fingerprint password',
    'AOD':'AOD',
    'Muestra información cuando la pantalla está apagada':'Show info when the screen is off',
    'Mostrar Book Bar':'Show Book Bar',
    'Pastilla dinámica con música, rutinas y batería':'Dynamic pill with music, routines and battery',
    // Sound
    'Volumen del sistema':'System volume',
    'Silenciar':'Mute',
    'Balance de audio':'Audio balance',
    'Balance L/R':'L/R balance',
    'Centrar':'Center',
    'Centro':'Center',
    'Izda':'L','Dcha':'R',
    'Sonidos de notificación':'Notification sounds',
    'Reproduce sonido al recibir notificaciones':'Play sound when receiving notifications',
    'Sonidos de interfaz':'Interface sounds',
    'Sonidos al hacer clic, navegar y otras acciones':'Sounds when clicking, navigating and other actions',
    // Battery
    'Ahorro de energía':'Power saver',
    'Limita CPU y procesos en segundo plano':'Limits CPU and background processes',
    'Carga adaptativa':'Adaptive charging',
    'Inactiva':'Inactive',
    'Activa':'Active',
    'Protección de la batería':'Battery protection',
    'Hasta el 80%':'Up to 80%',
    'min para carga completa':'min until fully charged',
    'para completar la carga':'to fully charge',
    'min':'min',
    'disponible':'available',
    // Notifications page
    'General':'General',
    'No molestar':'Do not disturb',
    'Permite notificaciones':'Allows notifications',
    'Mostrar en pantalla bloqueada':'Show on lock screen',
    'Ver notificaciones al bloquear':'See notifications when locked',
    'Mostrar todas las notificaciones':'Show all notifications',
    'Desactiva para ver sólo críticas':'Disable to see only critical',
    'Audio':'Audio',
    'Historial':'History',
    'Historial de notificaciones':'Notification history',
    'Abre el historial de Plasma':'Opens Plasma history',
    'Ajustes de notificaciones':'Notification settings',
    'Configura el historial y el comportamiento en Plasma':'Configure history and behavior in Plasma',
    'Abriendo ajustes de notificaciones':'Opening notification settings',
    'No se pudo abrir':'Could not open',
    'Ventanas emergentes (BookOS)':'Popups (BookOS)',
    'Notificaciones emergentes':'Notification popups',
    'Popups estilo BookOS al recibir notificaciones':'BookOS-style popups when notifications arrive',
    'Posición en pantalla':'Screen position',
    'Cerrar automáticamente tras':'Auto-hide after',
    'Barra de cuenta atrás':'Countdown bar',
    'Muestra cuándo se cerrará el popup':'Shows when the popup will auto-close',
    'Tema de los popups':'Popup theme',
    'Abajo a la derecha':'Bottom right',
    'Abajo a la izquierda':'Bottom left',
    'Arriba a la derecha':'Top right',
    'Arriba a la izquierda':'Top left',
    'Arriba centrado':'Top center',
    'Nunca':'Never',
    'Automático':'Automatic',
    'Claro':'Light',
    'Oscuro':'Dark',
    'Popups BookOS activados':'BookOS popups enabled',
    'Popups BookOS desactivados':'BookOS popups disabled',
    'Cuenta atrás visible':'Countdown visible',
    'Cuenta atrás oculta':'Countdown hidden',
    'Posición actualizada':'Position updated',
    'Duración actualizada':'Duration updated',
    'Tema de popups actualizado':'Popup theme updated',
    'Desinstalar búsqueda semántica':'Uninstall semantic search',
    'Se borrará el modelo, el índice y las dependencias (~500 MB).':'The model, index and dependencies (~500 MB) will be removed.',
    'Desinstalar':'Uninstall',
    'Navegador web':'Web browser',
    'Cliente de correo':'Email client',
    'Gestor de archivos':'File manager',
    'Imágenes':'Images',
    'Vídeo':'Video',
    'Audio':'Audio',
    'Documentos PDF':'PDF documents',
    'Archivos de texto':'Text files',
    'Archivos comprimidos':'Archives',
    'No configurada':'Not set',
    'Toca una categoría para elegir la app predeterminada.':'Tap a category to choose the default app.',
    'No se encontraron aplicaciones para esta categoría.':'No apps found for this category.',
    'Elegir':'Choose',
    'App predeterminada actualizada':'Default app updated',
    'No se pudo cambiar':'Could not change',
    'Abrir':'Open',
    // Security
    'Cortafuegos':'Firewall',
    'Cortafuegos (UFW)':'Firewall (UFW)',
    'Bloquear al reanudar de suspensión':'Lock when resuming from suspend',
    'Pide contraseña al despertar':'Ask for password on wake',
    'Bloqueo automático':'Auto-lock',
    'Periodo de gracia':'Grace period',
    'Tiempo sin pedir contraseña al despertar':'Time without prompting password on wake',
    'Inmediatamente':'Immediately',
    'Cámara y micrófono':'Camera & microphone',
    'Cámara':'Camera',
    'Micrófono':'Microphone',
    'Silenciado en todo el sistema':'Muted system-wide',
    'Privacidad':'Privacy',
    'Historial de actividades':'Activity history',
    'Plasma registra tus archivos y apps recientes':'Plasma tracks your recent files and apps',
    'Borrar historial de actividades':'Clear activity history',
    // Wallpaper / theme picker
    'Oscuro':'Dark',
    'Claro':'Light',
    'Fondo':'Background',
    'Paleta':'Palette',
    'Cambiar fondo de pantalla':'Change wallpaper',
    'Añadir fondo de pantalla':'Add wallpaper',
    'Paleta de colores':'Color palette',
    'Ajusta colores según el fondo':'Adjusts colors based on wallpaper',
    'Atenuar fondo de pantalla':'Dim wallpaper',
    'Atenúa en modo oscuro':'Dims in dark mode',
    'Fondos disponibles':'Available wallpapers',
    // Accounts
    'Crear usuario':'Create user',
    'Eliminar usuario':'Delete user',
    'Inicio de sesión automático':'Automatic login',
    'Cambiar avatar':'Change avatar',
    'Cambiar contraseña':'Change password',
    'Nombre completo':'Full name',
    // Pantalla Inicio
    'Escritorio':'Desktop',
    'Iconos en el escritorio':'Desktop icons',
    'Muestra iconos de archivos y apps de fondo':'Show file and background app icons',
    'Rejilla de alineacion':'Alignment grid',
    'Ajusta los iconos automáticamente a la cuadricula':'Auto-align icons to grid',
    'Etiquetas de iconos':'Icon labels',
    'Muestra el nombre debajo de cada icono':'Show the name below each icon',
    'Tamaño de iconos':'Icon size',
    'Cambia el tamaño de los iconos en el escritorio':'Change the size of desktop icons',
    'Pequeño':'Small','Mediano':'Medium','Grande':'Large',
    'Posición de la barra de tareas':'Taskbar position',
    'Abajo':'Bottom','Izquierda':'Left','Derecha':'Right','Arriba':'Top',
    'Accesos directos':'Shortcuts',
    'Atajos de teclado':'Keyboard shortcuts',
    'Atajos del sistema':'System shortcuts',
    'Asigna teclas a acciones de KDE Plasma':'Assign keys to KDE Plasma actions',
    'Atajos personalizados':'Custom shortcuts',
    'Crea atajos para lanzar apps':'Create shortcuts to launch apps',
    // Admin general
    'Idioma de la aplicación':'Application language',
    'Idioma / Language':'Language',
    'Idiomas y entrada':'Languages & input',
    'Idioma del sistema':'System language',
    'Distribución del teclado':'Keyboard layout',
    'Comportamiento de la aplicación':'Application behavior',
    'Lanzar al iniciar sesión':'Launch at login',
    'Abre BookOS Settings en segundo plano al encender':'Opens BookOS Settings in background at startup',
    'Inicio automático':'Autostart',
    // Buds
    'Calidad y efectos de sonido':'Sound quality & effects',
    'Controles de auriculares':'Earbud controls',
    'Controles de voz':'Voice controls',
    'Administrar conexiones':'Manage connections',
    'Buscar mis auriculares':'Find my earbuds',
    'Diagnóstico':'Diagnostics',
    'Acerca de los auriculares':'About earbuds',
    'Adaptar a tus oídos':'Adapt to your ears',
    'Reconexión automática':'Auto-reconnect',
    'Conexta los buds cuando estén cerca y encendidos':'Connect buds when nearby and powered on',
    'Conexión fácil con auriculares':'Easy pairing',
    'Cambia entre dispositivos cercanos sin desemparejar':'Switch between nearby devices without re-pairing',
    'Cambio automático a sonido ambiente':'Auto switch to ambient sound',
    'Estado guardado':'Saved state',
    'Ecualizador':'Equalizer',
    'Dinámico':'Dynamic',
    'Estándar':'Standard',
    'Fluido':'Smooth',
    'Animaciones más suaves. Mayor consumo.':'Smoother animations. Higher battery use.',
    'Menor consumo de batería.':'Lower battery consumption.',
    'Tonos cálidos que reducen la fatiga visual':'Warm tones that reduce eye strain',
    'Programación y temperatura…':'Schedule & temperature…',
    'Plano':'Flat',
    'Suave':'Soft',
    // Buds EQ "Claro" preset — same Spanish word as "Light", but JS object keys must be unique.
    // Keep theme mapping (Claro→Light) and translate Buds preset inline at call site instead.
    'Realce de graves':'Bass Boost',
    'Realce de agudos':'Treble Boost',
    'Sonido Ambiente':'Ambient Sound',
    'Sonido ambiente':'Ambient sound',
    'Cancelación activa de ruido':'Active noise cancelling',
    'Adaptable':'Adaptive',
    'Touchpad':'Touchpad',
    'Bloqueado':'Locked',
    'Activo':'Active',
    'Auricular izquierdo':'Left earbud',
    'Auricular derecho':'Right earbud',
    'Número de serie':'Serial number',
    'Batería Izquierda':'Left battery',
    'Batería Derecha':'Right battery',
    'Batería Estuche':'Case battery',
    'Cliente':'Client',
    'Galaxy Buds nativo (BookOS)':'Galaxy Buds native (BookOS)',
    // Fit test
    'Coloca los auriculares en tus oídos. El test reproducirá un tono y medirá el sello.':'Place the earbuds in your ears. The test will play a tone and measure the seal.',
    'Iniciar prueba':'Start test',
    'Probando…':'Testing…',
    'Repetir prueba':'Repeat test',
    'Buen ajuste':'Good fit',
    'Ajuste flojo':'Loose fit',
    'Mal ajuste':'Poor fit',
    'Izquierdo':'Left','Derecho':'Right',
    // Generic
    'Sí':'Yes','No':'No',
    'Reiniciar':'Restart',
    'Cerrar':'Close',
    'Aceptar':'Accept','Confirmar':'Confirm',
    'Guardar':'Save','Aplicar':'Apply',
    'Cerrar sesión':'Log out',
    'Más tarde':'Later',
    // Sidebar nav (sidebar items localized via i18n already, plus aliases here)
    'WiFi · Bluetooth · Modo Avión':'WiFi · Bluetooth · Airplane',
    'Share · Buds':'Share · Buds',
    'Modos · Rutinas':'Modes · Routines',
    'Volumen · Melodía':'Volume · Ringtone',
    'Brillo · Resolución · Protector vista':'Brightness · Resolution · Eye care',
    'Energía · Carga':'Power · Charging',
    'Bloqueo · Biometría · AOD':'Lock · Biometrics · AOD',
    'Diseño · Apps':'Layout · Apps',
    'Fondos · Paleta':'Wallpapers · Palette',
    'Temas · Modo oscuro':'Themes · Dark mode',
    'Asistente de escritura · notas':'Writing assistant · notes',
    // Battery page extras
    'Cargando hasta el':'Charging up to',
    'Consumo':'Consumption',
    'min para completar la carga':'min to fully charge',
    'Activa — carga completa':'Active — fully charged',
    'Ahorra batería':'Save battery',
    'Modo ahorro':'Saver mode',
    'Modo ahorro activado':'Saver mode on',
    'Modo ahorro desactivado':'Saver mode off',
    'Ahorro de batería':'Battery saver',
    'Ahorro extremo':'Extreme saver',
    'Ahorro extremo (5W)':'Extreme saver (5W)',
    'Avisar al alcanzar el límite':'Notify when limit reached',
    'Batería baja (<20%)':'Low battery (<20%)',
    'Batería casi agotada':'Battery nearly empty',
    'Atenuar pantalla automáticamente':'Auto-dim screen',
    'Atenúa cuando la batería es baja':'Dim when battery is low',
    'Atenúa en modo oscuro':'Dims in dark mode',
    // Connections
    'Activa Bluetooth para ver tus Buds':'Enable Bluetooth to see your Buds',
    'Activa el modo vinculación en el otro dispositivo':'Enable pairing mode on the other device',
    'Bluetooth activado':'Bluetooth enabled',
    'Bluetooth desactivado':'Bluetooth disabled',
    'WiFi activado':'WiFi enabled',
    'WiFi desactivado':'WiFi disabled',
    'Modo Avión':'Airplane mode',
    'Modo avión activado':'Airplane mode on',
    'Modo avión desactivado':'Airplane mode off',
    'Sin conexión activa':'No active connection',
    'Selecciona una red abajo':'Select a network below',
    'Conectar':'Connect',
    'Desconectar':'Disconnect',
    'Conectado a':'Connected to',
    'Olvidar':'Forget',
    'Red abierta':'Open network',
    'Protegida':'Secured',
    'Buscando redes':'Searching networks',
    // Notifications
    'No molestar':'Do not disturb',
    'Permite notificaciones':'Allows notifications',
    'Mostrar en pantalla bloqueada':'Show on lock screen',
    'Ver notificaciones al bloquear':'See notifications when locked',
    'Mostrar todas las notificaciones':'Show all notifications',
    'Desactiva para ver sólo críticas':'Disable to see only critical',
    // Common adjectives/verbs
    'Apagado':'Off',
    'Encendido':'On',
    'Ninguno':'None',
    'Personalizado':'Custom',
    'Recomendado':'Recommended',
    'Avanzado':'Advanced',
    'Predeterminado':'Default',
    'Sin configurar':'Not configured',
    'Sin asignar':'Unassigned',
    'No disponible':'Unavailable',
    'Cargando':'Loading',
    'Cargando…':'Loading…',
    'Iniciando':'Starting',
    'Iniciando…':'Starting…',
    'Procesando':'Processing',
    'Listo':'Ready',
    'Hecho':'Done',
    'Pendiente':'Pending',
    'Error':'Error',
    'Cancelar':'Cancel',
    'Atrás':'Back',
    'Siguiente':'Next',
    'Anterior':'Previous',
    'Buscar':'Search',
    'Editar':'Edit',
    'Borrar':'Delete',
    'Eliminar':'Remove',
    'Añadir':'Add',
    'Renombrar':'Rename',
    'Exportar':'Export',
    'Importar':'Import',
    'Restablecer':'Reset',
    'Restaurar':'Restore',
    'Predeterminados':'Defaults',
    // Themes
    'Modo oscuro':'Dark mode',
    'Modo claro':'Light mode',
    'Pantalla de inicio oscura o clara':'Dark or light home screen',
    'Programar tema':'Schedule theme',
    'Programar modo oscuro':'Schedule dark mode',
    'Ajustes del modo Oscuro/Claro':'Dark/Light mode settings',
    'Ajustes de los iconos tintados':'Tinted icons settings',
    'Iconos tintados':'Tinted icons',
    'Tintado':'Tinted',
    'Pintar la base':'Tint the base',
    'El cuadrado de fondo toma el color del tinte':'The background square takes the tint colour',
    'Pintar el logo':'Tint the logo',
    'Recolorea el logo de cada app con su propio color':'Recolour each app logo with its own colour',
    'Cambiar automáticamente por hora':'Switch automatically by time',
    'Claro desde':'Light from',
    'Oscuro desde':'Dark from',
    'Tema claro':'Light theme',
    'Tema oscuro':'Dark theme',
    'Tema aplicado':'Theme applied',
    // Updates extras
    'Cancelando':'Cancelling',
    'Cancelado':'Cancelled',
    'Actualización cancelada':'Update cancelled',
    'Descargando e instalando actualizaciones...':'Downloading and installing updates...',
    'Sin paquetes pendientes':'No pending packages',
    'Actualizar todo ahora':'Update all now',
    'Actualizar sistema ahora':'Update system now',
    'Actualizar Flatpak ahora':'Update Flatpak now',
    'Actualizar AUR ahora':'Update AUR now',
    'Actualizando Flatpak...':'Updating Flatpak...',
    'Actualizando AUR...':'Updating AUR...',
    'Flatpak actualizado':'Flatpak updated',
    'Se requiere contraseña':'Password required',
    'quiere realizar cambios en el sistema. Introduce tu contraseña para autorizar la acción.':'wants to make changes to the system. Enter your password to authorize the action.',
    'Actualizar por la noche':'Update tonight',
    'Actualizar ahora':'Update now',
    'Programado para esta noche':'Scheduled for tonight',
    'Fuente':'Source',
    'Instalado':'Installed',
    'Disponible':'Available',
    'Sistema':'System',
    'Kernel':'Kernel',
    // Performance modes
    'Optimizado':'Balanced',
    'Equilibrado':'Balanced',
    'Silencioso':'Quiet',
    'Rendimiento':'Performance',
    'Máximo poder':'Max power',
    'Mínimo consumo':'Min consumption',
    // Buds extras
    'Galaxy Buds':'Galaxy Buds',
    'Coloca tu dedo en el lector':'Place your finger on the reader',
    'o usa tu huella dactilar':'or use your fingerprint',
    'Coloca el dedo en el sensor':'Place your finger on the sensor',
    'Bloqueo de mayúsculas activado':'Caps Lock enabled',
    'Reposo':'Sleep',
    'Cambiar usuario':'Switch user',
    // Lockscreen install toggles
    'Tema BookOS — Pantalla de bloqueo':'BookOS theme — Lock screen',
    'Reemplaza el lockscreen de Plasma':'Replaces the Plasma lockscreen',
    'Tema BookOS — SDDM (login)':'BookOS theme — SDDM (login)',
    'Activa el tema BookOS al iniciar sesión':'Enable BookOS theme at login',
    // Sound additional
    'Salida':'Output',
    'Entrada':'Input',
    'Dispositivo de salida':'Output device',
    'Dispositivo de entrada':'Input device',
    'Volumen por aplicación':'Per-app volume',
    'Sin aplicaciones reproduciendo':'No apps playing',
    // Confirm/dialog
    'Borrar historial':'Clear history',
    'Se eliminará el historial':'History will be deleted',
    'No se pueden recuperar':'Cannot be recovered',
    // Network
    'Contraseña':'Password',
    'Mostrar contraseña':'Show password',
    'Recordar':'Remember',
    'Conectarse a esta red automáticamente':'Connect to this network automatically',

    // ── Bulk extras — full coverage pass ──
    'A una hora específica':'At a specific time',
    'Abierta':'Open',
    'Abre BookOS Settings en segundo plano al encender':'Opens BookOS Settings in the background at startup',
    'Abre Nearby Share en el S22 Ultra':'Open Nearby Share on the S22 Ultra',
    'Abriendo configuración MIME':'Opening MIME settings',
    'Abriendo previsualización…':'Opening preview…',
    'Aceptando…':'Accepting…',
    'Activa — carga completa':'Active — fully charged',
    'Activa Quick Share primero':'Enable Quick Share first',
    'activar el cortafuegos':'enable firewall',
    'desactivar el cortafuegos':'disable firewall',
    'Activar carga adaptativa':'Enable adaptive charging',
    'Activar inicio automático':'Enable autostart',
    'Activar modo enfoque':'Enable focus mode',
    'Activo — buscando dispositivos':'Active — searching devices',
    'Activo — Wi-Fi Direct conectado':'Active — Wi-Fi Direct connected',
    'Actualización cancelada':'Update cancelled',
    'Actualizando ':'Updating ',
    'Adobe RGB':'Adobe RGB',
    'Agudos':'Treble',
    'Ahora':'Now',
    'Ahorra batería':'Save battery',
    'Ahorro activado · procesos en segundo plano limitados':'Saver on · background processes limited',
    'Ajusta KWin para menor latencia de entrada':'Adjusts KWin for lower input latency',
    'Ajustes del modo ':'Mode settings ',
    'Ajustes exportados a ':'Settings exported to ',
    'Ajustes importados':'Settings imported',
    'Al activar Bluetooth':'When enabling Bluetooth',
    'Al activar el WiFi':'When enabling WiFi',
    'Al conectar el cargador':'When charger connects',
    'Al desactivar Bluetooth':'When disabling Bluetooth',
    'Al desactivar el WiFi':'When disabling WiFi',
    'Al desconectar el cargador':'When charger disconnects',
    'Alta precisión':'High precision',
    'Animación al minimizar ventanas':'Animation when minimizing windows',
    'Animaciones reducidas':'Reduced motion',
    'Animaciones reducidas activadas':'Reduced motion enabled',
    'Animaciones restauradas':'Animations restored',
    'Añade imágenes a ~/Imágenes o /usr/share/wallpapers':'Add images to ~/Pictures or /usr/share/wallpapers',
    'Añade reglas polkit para obviar contraseñas en control':'Add polkit rules to skip passwords in control',
    'Añadir acción':'Add action',
    'Añadir condición':'Add condition',
    'Archivo':'File',
    'Asegúrate de que Quick Share esté activo en el otro equipo':'Make sure Quick Share is active on the other device',
    'Asistente de voz':'Voice assistant',
    'Atenuación activada':'Dimming enabled',
    'Atenuación automática activada':'Auto-dim enabled',
    'Atenuación automática desactivada':'Auto-dim disabled',
    'Atenuación desactivada':'Dimming disabled',
    'AUR actualizado':'AUR updated',
    'Auto / Auto-detect':'Auto / Auto-detect',
    'Autorizar':'Authorize',
    'Avisar al alcanzar el límite':'Notify when limit reached',
    'Avisos de objetivo activados':'Goal alerts enabled',
    'Bajar volumen':'Volume down',
    'Subir volumen':'Volume up',
    'Barra de estado extendida':'Extended status bar',
    'Barra extendida activada (recarga para ver)':'Extended bar on (reload to see)',
    'Barra extendida desactivada':'Extended bar off',
    'Bloqueada a nivel del kernel':'Blocked at kernel level',
    'Bloquear toques':'Lock touches',
    'Bloqueo al reanudar activado':'Lock on resume enabled',
    'Borra caché de thumbnails':'Clear thumbnail cache',
    'Buds':'Buds',
    'Buscando…':'Searching…',
    'Buscar mis auriculares':'Find my earbuds',
    'Buscar redes':'Search networks',
    'Buscar dispositivos':'Search devices',
    'Cambiar fondo de pantalla':'Change wallpaper',
    'Cambiar avatar':'Change avatar',
    'Cambiar nombre':'Change name',
    'Cambiar contraseña':'Change password',
    'Cambiar usuario':'Switch user',
    'Cancelado':'Cancelled',
    'Cancelando':'Cancelling',
    'Cancelando…':'Cancelling…',
    'Cancelar':'Cancel',
    'Capturas de pantalla':'Screenshots',
    'Carga ilimitada':'Unlimited charge',
    'Cargar al 80%':'Charge to 80%',
    'Cargar al 100%':'Charge to 100%',
    'Cargando…':'Loading…',
    'Cargando hasta el':'Charging up to',
    'Centrar':'Center',
    'Centro':'Center',
    'Cerrando…':'Closing…',
    'Cerrar':'Close',
    'Cerrar sesión':'Log out',
    'Cifrado':'Encrypted',
    'Coincidencias':'Matches',
    'Coloca el dedo en el sensor':'Place your finger on the sensor',
    'Coloca tu dedo en el lector':'Place your finger on the reader',
    'Coloca tu dedo repetidamente en el sensor...':'Place your finger on the sensor repeatedly...',
    'Color':'Color',
    'Comprobando…':'Checking…',
    'Conectando':'Connecting',
    'Conectando...':'Connecting...',
    'Conectado':'Connected',
    'Cable':'Wired',
    'Copiado':'Copied',
    'Conexión por cable':'Wired connection',
    'Comprobando...':'Checking...',
    'Sin cable conectado':'No cable connected',
    'No hay ninguna interfaz de cable disponible':'No wired interface available',
    'Interfaz':'Interface',
    'Olvidar red':'Forget network',
    'Obteniendo detalles...':'Getting details...',
    'No se pudieron cargar los detalles':'Could not load details',
    'Contraseña requerida':'Password required',
    'Para ver la contraseña de':'To view the password for',
    'introduce la contraseña del equipo.':'enter the device password.',
    'IPv6':'IPv6',
    'MTU':'MTU',
    'Confirmar':'Confirm',
    'Confirmar contraseña':'Confirm password',
    'Conmutar':'Toggle',
    'Consumo':'Consumption',
    'Consumo actual':'Current consumption',
    'Estadísticas de batería':'Battery statistics',
    'Nivel actual':'Current level',
    'Capacidad de diseño':'Design capacity',
    'Sin datos disponibles':'No data available',
    'Carga USB-C':'USB-C charging',
    'Potencia actual':'Current power',
    'Protocolo':'Protocol',
    'Cargador':'Charger',
    'Conectado · sin carga':'Plugged in · not charging',
    'Hora predicha de desconexión':'Predicted unplug time',
    'datos':'samples',
    'hoy':'today',
    'Lun':'Mon','Mar':'Tue','Mié':'Wed','Jue':'Thu','Vie':'Fri','Sáb':'Sat','Dom':'Sun',
    'Necesita más datos para predecir patrones.':'Needs more data to predict patterns.',
    'Contraseña':'Password',
    'Contraseña incorrecta':'Wrong password',
    'Contraseña incorrecta o error':'Wrong password or error',
    'Contraseña actual':'Current password',
    'Contraseña nueva':'New password',
    'Continuar':'Continue',
    'Controles de auriculares':'Earbud controls',
    'Controles de voz':'Voice controls',
    'Controles táctiles':'Touch controls',
    'Copiado al portapapeles':'Copied to clipboard',
    'Copiar':'Copy',
    'Copiar enlace':'Copy link',
    'Cortafuegos activado':'Firewall enabled',
    'Cortafuegos desactivado':'Firewall disabled',
    'Crear':'Create',
    'Crear cuenta':'Create account',
    'Crear usuario':'Create user',
    'Cuenta creada':'Account created',
    'Cuenta eliminada':'Account deleted',
    'Datos':'Data',
    'Datos móviles':'Mobile data',
    'De camino al trabajo':'On the way to work',
    'Deja que BookOS gestione la carga':'Let BookOS manage charging',
    'Desactivado':'Disabled',
    'Desactivar':'Disable',
    'Desconectado':'Disconnected',
    'Desconectando…':'Disconnecting…',
    'Descripción':'Description',
    'Desenfoque de fondo':'Background blur',
    'Desfase':'Offset',
    'Despertar pantalla':'Wake screen',
    'Detalles':'Details',
    'Detalles avanzados':'Advanced details',
    'Detectados':'Detected',
    'Detectando…':'Detecting…',
    'Detener':'Stop',
    'Diagnóstico':'Diagnostics',
    'Días':'Days',
    'Diariamente':'Daily',
    'Dirección':'Address',
    'Dirección IP':'IP address',
    'Dirección MAC':'MAC address',
    'Disco':'Disk',
    'Dispositivo':'Device',
    'Dispositivo desconocido':'Unknown device',
    'Dispositivos cercanos':'Nearby devices',
    'Dispositivos emparejados':'Paired devices',
    'Distribución del teclado':'Keyboard layout',
    'Documentos':'Documents',
    'Domingo':'Sunday',
    'DPI':'DPI',
    'Duración':'Duration',
    'Editar':'Edit',
    'Efecto lámpara mágica':'Magic lamp effect',
    'Ejecutar':'Run',
    'Eliminar':'Delete',
    'Eliminar usuario':'Delete user',
    'Empezando…':'Starting…',
    'Empezar':'Start',
    'En espera':'Standby',
    'En modo oscuro':'In dark mode',
    'En reposo':'Idle',
    'En uso':'In use',
    'Enero':'January','Febrero':'February','Marzo':'March','Abril':'April',
    'Mayo':'May','Junio':'June','Julio':'July','Agosto':'August',
    'Septiembre':'September','Octubre':'October','Noviembre':'November','Diciembre':'December',
    'Lunes':'Monday','Martes':'Tuesday','Miércoles':'Wednesday','Jueves':'Thursday','Viernes':'Friday','Sábado':'Saturday',
    'Energía':'Power',
    'Energía · Carga':'Power · Charging',
    'Entradas y salidas':'Inputs & outputs',
    'Equilibrado':'Balanced',
    'Error al conectar':'Connection failed',
    'Error al guardar':'Failed to save',
    'Error al seleccionar imagen':'Failed to select image',
    'Error al aplicar':'Failed to apply',
    'Error al olvidar la red':'Failed to forget network',
    'Es muy útil para ver vídeos':'Very useful for watching videos',
    'Escaneando…':'Scanning…',
    'Escribir':'Write',
    'Escritorio':'Desktop',
    'Espacio en disco':'Disk space',
    'Espacio libre':'Free space',
    'Esperando':'Waiting',
    'Establecer como predeterminado':'Set as default',
    'Estado':'Status',
    'Estado actual':'Current status',
    'Estilo guardado':'Style saved',
    'Estuche':'Case',
    'Excelente':'Excellent',
    'Exportar ajustes':'Export settings',
    'Fallido':'Failed',
    'Falta poco':'Almost done',
    'Falta':'Missing',
    'Faltan':'Missing',
    'Familia':'Family',
    'Fecha':'Date',
    'Fecha y hora':'Date & time',
    'ANC':'ANC',
    'Hora automática (NTP)':'Automatic time (NTP)',
    'Sincroniza el reloj por internet':'Sync the clock over the internet',
    'Zona horaria':'Time zone',
    'Buscar zona…':'Search zone…',
    'Hora automática activada':'Automatic time enabled',
    'Hora automática desactivada':'Automatic time disabled',
    'Zona horaria actualizada':'Time zone updated',
    'Impresoras':'Printers',
    'Impresoras y escáneres':'Printers & scanners',
    'Añadir y configurar impresoras':'Add and configure printers',
    'Abriendo impresoras':'Opening printers',
    'No hay gestor de impresoras instalado':'No printer manager installed',
    'Búsqueda semántica':'Semantic search',
    'Compartir ubicación':'Share location',
    'Llamada de emergencia rápida':'Quick emergency call',
    'Mostrar batería':'Show battery',
    'Mostrar fecha':'Show date',
    'Mostrar porcentaje batería':'Show battery percentage',
    'Protocolo SPP':'SPP protocol',
    'Color de acento según el fondo':'Accent color from wallpaper',
    'Conecta los buds cuando estén cerca y encendidos':'Connect buds when nearby and on',
    'Día de la semana bajo el reloj':'Day of week under the clock',
    'En el widget de batería':'In the battery widget',
    'Envía tu posición al contacto de emergencia':'Send your location to the emergency contact',
    'Pastilla con porcentaje de batería':'Pill with battery percentage',
    'Pastilla con rutina activa o batería':'Pill with active routine or battery',
    'Pulsa el botón de encendido 3 veces':'Press the power button 3 times',
    'Filtros':'Filters',
    'Finalizado':'Finished',
    'Fluidez de movimientos':'Motion smoothness',
    'Fondo de pantalla y estilo':'Wallpaper & style',
    'Formato del reloj':'Clock format',
    'Reloj':'Clock',
    'Elementos en pantalla':'On-screen elements',
    'Frecuencia':'Frequency',
    'Frecuencia de actualización':'Refresh rate',
    'Funciones avanzadas':'Advanced features',
    'Galería':'Gallery',
    'Gama dinámica alta':'High dynamic range',
    'GPU en reposo':'GPU idle',
    'Grabar pantalla':'Record screen',
    'Graves':'Bass',
    'Guardando…':'Saving…',
    'Guardar':'Save',
    'Hardware':'Hardware',
    'Hasta el':'Up to',
    'Hecho':'Done',
    'Hora':'Time',
    'Hora de fin':'End time',
    'Hora de inicio':'Start time',
    'Horario':'Schedule',
    'Horario guardado':'Schedule saved',
    'HDR':'HDR',
    'HDR10 nativo · Gama dinámica alta':'Native HDR10 · High dynamic range',
    'Iconos del escritorio':'Desktop icons',
    'Idioma':'Language',
    'Idioma de la app':'App language',
    'Idioma del sistema':'System language',
    'Idioma cambiado':'Language changed',
    'Importar ajustes':'Import settings',
    'Imágenes':'Pictures',
    'Inactiva':'Inactive',
    'Inactivo':'Idle',
    'Iniciar prueba':'Start test',
    'Iniciando':'Starting',
    'Iniciando…':'Starting…',
    'Inicio automático':'Autostart',
    'Inicio de sesión':'Login',
    'Instalado':'Installed',
    'Instalando':'Installing',
    'Intensidad':'Intensity',
    'Invertir':'Invert',
    'Izda':'L','Izda %1':'L %1',
    'Lanzar al iniciar sesión':'Launch at login',
    'Limpiar caché':'Clear cache',
    'Limpieza completada':'Cleanup complete',
    'Listo':'Ready',
    'Llamadas':'Calls',
    'Localización':'Location',
    'Marca':'Brand',
    'Más opciones':'More options',
    'Mejor experiencia':'Best experience',
    'Memoria':'Memory',
    'Mensajes':'Messages',
    'Micrófono activo':'Microphone active',
    'Micrófono silenciado':'Microphone muted',
    'Mínimo consumo':'Min consumption',
    'Mismo día':'Same day',
    'Modelo':'Model',
    'Modo':'Mode',
    'Modo Ahorro':'Saver mode',
    'Modo ahorro activado':'Saver mode on',
    'Modo ahorro desactivado':'Saver mode off',
    'Modo gaming':'Gaming mode',
    'Modo trabajo':'Work mode',
    'Modo viaje':'Travel mode',
    'Modo enfoque':'Focus mode',
    'Modo silencio':'Silent mode',
    'Modos y rutinas':'Modes & routines',
    'Mostrar':'Show',
    'Mostrar siempre':'Always show',
    'Movimiento reducido':'Motion reduced',
    'Música':'Music',
    'Música pausada':'Music paused',
    'Música reanudada':'Music resumed',
    'Necesita reinicio':'Reboot required',
    'Ningún dispositivo emparejado':'No paired devices',
    'Ningún resultado':'No results',
    'Nombre':'Name',
    'Nombre Bluetooth':'Bluetooth name',
    'Nombre completo':'Full name',
    'Nombre de usuario':'Username',
    'Nota':'Note',
    'Nuevo':'New',
    'Número':'Number',
    'Número de serie':'Serial number',
    'OK':'OK',
    'Olvidar':'Forget',
    'Online':'Online',
    'Opciones':'Options',
    'Operativa':'Operational',
    'Optimizar':'Optimize',
    'Optimizar latencia del cursor':'Optimize cursor latency',
    'Otros':'Others',
    'Paleta de colores':'Color palette',
    'Paleta desactivada':'Palette disabled',
    'Pantalla':'Display',
    'Pantalla apagada':'Screen off',
    'Pantalla bloqueada':'Screen locked',
    'Pantalla de bloqueo':'Lock screen',
    'Pantalla de inicio':'Home screen',
    'Pantalla principal':'Main display',
    'Pantalla secundaria':'Secondary display',
    'Pantalla Inicio':'Home screen',
    'Paquetes':'Packages',
    'Pausada':'Paused',
    'Pausado':'Paused',
    'Periodo de gracia':'Grace period',
    'Periodo de gracia actualizado':'Grace period updated',
    'Pequeño':'Small','Mediano':'Medium','Grande':'Large',
    'Permiso denegado':'Permission denied',
    'Personalizar':'Customize',
    'Por defecto':'Default',
    'Porcentaje':'Percentage',
    'Posición':'Position',
    'Posición de la barra de tareas':'Taskbar position',
    'Predeterminados':'Defaults',
    'Predicción':'Prediction',
    'Preparando…':'Preparing…',
    'Preparando...':'Preparing...',
    'Privacidad':'Privacy',
    'Procesador':'Processor',
    'Probando…':'Testing…',
    'Procesando':'Processing',
    'Procesando…':'Processing…',
    'Programado para esta noche':'Scheduled for tonight',
    'Protección de batería':'Battery protection',
    'Protección de la batería':'Battery protection',
    'Protección de la vista':'Eye comfort',
    'Punto de acceso':'Hotspot',
    'Quitar':'Remove',
    'Realce de graves':'Bass Boost',
    'Realce de agudos':'Treble Boost',
    'Reciente':'Recent',
    'Recientes':'Recent',
    'Reconectar':'Reconnect',
    'Reconexión automática':'Auto-reconnect',
    'Recordar':'Remember',
    'Recursos':'Resources',
    'Red':'Network',
    'Red abierta':'Open network',
    'Red olvidada':'Network forgotten',
    'Redes':'Networks',
    'Redes disponibles':'Available networks',
    'Reducir movimiento':'Reduce motion',
    'Reiniciar':'Restart',
    'Reiniciar compositor':'Restart compositor',
    'Reiniciando…':'Restarting…',
    'Repetir prueba':'Repeat test',
    'Reposo':'Sleep',
    'Reproducir':'Play',
    'Reproductor':'Player',
    'Resolución':'Resolution',
    'Resolución de pantalla':'Screen resolution',
    'Restablecer':'Reset',
    'Restablecido':'Reset',
    'Restaurar':'Restore',
    'Resultados':'Results',
    'Rutinas':'Routines',
    'Rutina creada':'Routine created',
    'Rutina eliminada':'Routine deleted',
    'Salida':'Output',
    'Salida de audio':'Audio output',
    'Samsung Display':'Samsung Display',
    'sb_lab_extended_battery':'Extended battery',
    'Seguridad':'Security',
    'Seguridad y privacidad':'Security & privacy',
    'Seleccionar':'Select',
    'Seleccionar imagen':'Select image',
    'Seleccionar archivo':'Select file',
    'Selecciona una red abajo':'Select a network below',
    'Sensor de presencia':'Presence sensor',
    'Servidor DNS':'DNS server',
    'Si no funciona, abre Ajustes del Sistema → Atajos':'If it doesn\'t work, open System Settings → Shortcuts',
    'Siguiente':'Next',
    'Siguiente pista':'Next track',
    'Silenciado en todo el sistema':'Muted system-wide',
    'Silencio activado':'Silent on',
    'Silencio desactivado':'Silent off',
    'Sin auriculares conectados':'No earbuds connected',
    'Sin caja':'No case',
    'Sin conexión':'No connection',
    'Sin datos':'No data',
    'Sin dispositivos':'No devices',
    'Sin huella':'No fingerprint',
    'Sin imagen':'No image',
    'Sin resultados':'No results',
    'Sistema':'System',
    'Solo administradores':'Admins only',
    'Solo notificaciones críticas':'Only critical notifications',
    'Sólido':'Solid',
    'Sonido':'Sound',
    'Sonidos y vibración':'Sound & vibration',
    'Sonidos del sistema':'System sounds',
    'Subir':'Upload',
    'Subir archivo':'Upload file',
    'Suspender':'Suspend',
    'Tamaño':'Size',
    'Tamaño de texto':'Text size',
    'Tamaño del cursor':'Cursor size',
    'Tarea':'Task',
    'Tareas':'Tasks',
    'Teclado':'Keyboard',
    'Tema aplicado':'Theme applied',
    'Tema global':'Global theme',
    'Tema BookOS':'BookOS theme',
    'Tema lockscreen activado':'Lockscreen theme enabled',
    'Tema lockscreen desactivado':'Lockscreen theme disabled',
    'Tema SDDM activado':'SDDM theme enabled',
    'Tema SDDM desactivado':'SDDM theme disabled',
    'Temas':'Themes',
    'Temporizador':'Timer',
    'Texto':'Text',
    'Tiempo':'Time',
    'Tiempo de bloqueo':'Lock time',
    'Tipo':'Type',
    'Tipo de bloqueo':'Lock type',
    'Tipo de cuenta':'Account type',
    'Tipografía':'Font',
    'Tipografía del reloj':'Clock font',
    'Toca para activar':'Tap to enable',
    'Toca para desactivar':'Tap to disable',
    'Touchpad':'Touchpad',
    'Tu equipo está actualizado':'Your system is up to date',
    'Última comprobación':'Last checked',
    'Última comprobación: ahora mismo':'Last checked: just now',
    'Última conexión':'Last connection',
    'Última sincronización':'Last sync',
    'Único':'Once',
    'Unidades':'Units',
    'Usuario':'User',
    'Usuario actual':'Current user',
    'Usuarios':'Users',
    'Valor':'Value',
    'Velocidad':'Speed',
    'Ventana':'Window',
    'Ventanas elásticas':'Wobbly windows',
    'Ver':'View',
    'Ver detalles':'View details',
    'Ver historial':'View history',
    'Ver más':'See more',
    'Ver menos':'See less',
    'Verificar':'Verify',
    'Verificado':'Verified',
    'Verificando…':'Verifying…',
    'Versión':'Version',
    'Vibración':'Vibration',
    'Vídeos':'Videos',
    'Visible':'Visible',
    'Volumen':'Volume',
    'Volumen cambiado':'Volume changed',
    'Volumen máximo':'Max volume',
    'Volumen mínimo':'Min volume',
    'WiFi':'WiFi','Wi-Fi':'Wi-Fi',
    'Wi-Fi Direct':'Wi-Fi Direct',
    'Wifi · Bluetooth · Modo Avión':'WiFi · Bluetooth · Airplane',
    'Salud':'Health',
    'Capacidad':'Capacity',
    'Nivel de la batería':'Battery level',
    'Cargando':'Charging',
    'Completa':'Full',
    'Hoy':'Today',
    'En uso':'In use',
    'Uso de la batería':'Battery usage',
    'Vista previa de texto':'Text preview',
    'El texto del sistema se verá así':'System text will look like this',
    'Sin sonido':'No sound',
    'Tamaño de texto':'Text size',
    'Tamaño del cursor':'Cursor size',
    'Colores invertidos':'Inverted colors',
    'Invierte los colores (KWin)':'Inverts colors (KWin)',
    'Minimiza animaciones del compositor':'Minimize compositor animations',
    'Servicios de ubicación':'Location services',
    'Desactivados':'Disabled',
    'Alta precisión':'High precision',
    'GPS, WiFi y redes móviles':'GPS, WiFi and mobile networks',
    'Solo WiFi y redes':'WiFi and networks only',
    'Solo dispositivo':'Device only',
    'Sin conexión a internet':'No internet connection',
    'Siempre':'Always',
    'Preguntar':'Ask',
    'Privacidad de ubicación':'Location privacy',
    'La ubicación exacta solo se usa para funciones que la requieran. Nunca se envía sin permiso.':'Exact location is only used for features that need it. Never sent without permission.',
    'Nombre visible':'Display name',
    'Cambiar foto':'Change photo',
    'Foto actualizada':'Photo updated',
    'Nombre del equipo':'Device name',
    'Administrador de BookOS':'BookOS administrator',
    'Cambia la contraseña de tu cuenta':'Change your account password',
    'Omite la pantalla de inicio de sesión al encender':'Skip login screen on startup',
    'No hay otros usuarios en este equipo.':'No other users on this device.',
    'Crear cuenta nueva':'Create new account',
    'Limpiar Flatpak':'Clean Flatpak',
    'Elimina aplicaciones sin uso':'Remove unused applications',
    'Limpiar':'Clean',
    'Limpiar caché de paquetes':'Clean package cache',
    'Limpia archivos de Paru/Pacman':'Clean Paru/Pacman files',
    'Miniaturas temporales':'Temporary thumbnails',
    'Clear thumbnail cache':'Clear thumbnail cache',
    'Permisos de Hardware':'Hardware permissions',
    'Configurar':'Configure',
    'Exportar a JSON':'Export to JSON',
    'Exportar configuración de BookOS':'Export BookOS settings',
    'Exportar':'Export',
    'Importar JSON':'Import JSON',
    'Importar configuración (requiere elegir archivo)':'Import settings (requires file selection)',
    'Importar':'Import',
    'Borrar':'Delete',
    'Fondo desenfocado bajo ventanas translúcidas':'Blurred background under translucent windows',
    'Efecto de movimiento suave al arrastrar':'Smooth motion effect when dragging',
    'Animación al minimizar ventanas':'Animation when minimizing windows',
    'Optimizar latencia del cursor':'Optimize cursor latency',
    'Ajusta KWin para menor latencia de entrada':'Adjusts KWin for lower input latency',
    'Reiniciar compositor':'Restart compositor',
    'Útil si hay artefactos gráficos':'Useful if there are graphical artifacts',
    'Reiniciar':'Restart',
    'Funciones experimentales. Pueden cambiar o desaparecer en futuras versiones.':'Experimental features. May change or disappear in future versions.',
    'Laboratorio':'Lab',
    'Menos movimiento en la interfaz':'Less interface motion',
    'Muestra más datos en la barra lateral':'Show more data in the sidebar',
    'En desarrollo':'In development',
    'Panel de productividad':'Productivity panel',
    'Vista rápida de tareas y notas':'Quick view of tasks and notes',
    'Gestos avanzados':'Advanced gestures',
    'Gestos táctiles personalizados':'Custom touch gestures',
    'Sync de ajustes':'Settings sync',
    'Copia de seguridad en la nube':'Cloud backup',
    'IA contextual':'Contextual AI',
    'Sugerencias según tu uso':'Suggestions based on your usage',
    'Sin datos de uso aún':'No usage data yet',
    'El uso se registra cuando actives el seguimiento':'Usage is recorded when you enable tracking',
    'Límite diario':'Daily limit',
    'Notificación cuando se supere el objetivo':'Notification when goal is exceeded',
    'No molestar al activar enfoque':'Do not disturb when focus is on',
    'Silencia notificaciones en modo enfoque':'Silence notifications in focus mode',
    'Minimiza distracciones':'Minimize distractions',
    'Uso del dispositivo':'Device usage',
    'Monitoriza cuánto tiempo usas cada aplicación.':'Monitor how long you use each application.',
    'Cambiar':'Change',
    'Sin datos':'No data',
    'No hay datos':'No data',
    'No hay otros usuarios':'No other users',
    'Atajos del sistema':'System shortcuts',
    'Asigna teclas a acciones de KDE Plasma':'Assign keys to KDE Plasma actions',
    'Atajos personalizados':'Custom shortcuts',
    'Crea atajos para lanzar apps':'Create shortcuts to launch apps',
    'Guardar':'Save',
    'Una vez completada la descarga, la instalación tardará aproximadamente 10 minutos.':'Once the download is complete, installation will take about 10 minutes.',
    'Canal de actualizaciones':'Update channel',
    'Estable':'Stable',
    'Beta':'Beta',
    'Developer':'Developer',
    'Versiones probadas y recomendadas':'Tested and recommended versions',
    'Nuevas funciones en pruebas':'New features in testing',
    'Actualizaciones más recientes, inestables':'Most recent updates, unstable',
    'Canal cambiado a':'Channel changed to',
    'Elige qué tan recientes quieres las actualizaciones de BookOS.':'Choose how recent you want BookOS updates.',
    'Actual':'Current',
    'Aplicar':'Apply',
    // ── Window chrome / global search (index.html) ──
    'Mostrar/ocultar barra lateral':'Show/hide sidebar',
    'Minimizar':'Minimize',
    'Maximizar':'Maximize',
    'Limpiar búsqueda':'Clear search',
    // ── Search result titles (home.js searchIndex/subSearchIndex) ──
    'Volumen · Salida':'Volume · Output',
    'Energía · Carga · Samsung Book':'Power · Charging · Samsung Book',
    'Fondo de pantalla':'Wallpaper',
    'Firewall · Permisos':'Firewall · Permissions',
    'Ubicación':'Location',
    'Solicitudes':'Requests',
    'Seguridad y emergencia':'Safety and emergency',
    'Datos médicos':'Medical info',
    'Perfil · Nombre · Hostname':'Profile · Name · Hostname',
    'Salud digital':'Digital wellbeing',
    'Tiempo de uso':'Screen time',
    'Mantenimiento':'Maintenance',
    'Almacenamiento · Cache':'Storage · Cache',
    'Apps predeterminadas':'Default apps',
    'Idioma · Teclado · Fecha':'Language · Keyboard · Date',
    'Visión · Audición':'Vision · Hearing',
    'Sistema · Flatpak':'System · Flatpak',
    'Capturas · Revertir':'Snapshots · Rollback',
    'Luz nocturna':'Night light',
    'Tasa de refresco':'Refresh rate',
    'Escala':'Scale',
    'Protector vista':'Eye protector',
    'Modo de rendimiento':'Performance mode',
    'Modo ventilador':'Fan mode',
    'Información de la batería':'Battery info',
    'Entrada de micrófono':'Microphone input',
    'Modo avión':'Airplane mode',
    'Huella dactilar':'Fingerprint',
    'Tema SDDM':'SDDM theme',
    'No molestar (DND)':'Do not disturb (DND)',
    'Posición de la barra':'Bar position',
    'Esquema de color':'Color scheme',
    'Modo oscuro automático':'Automatic dark mode',
    'Iconos del sistema':'System icons',
    'Permisos de apps':'App permissions',
    'Distribución de teclado':'Keyboard layout',
    'Página de inicio':'Home page',
    'Almacenamiento':'Storage',
    'Logs del sistema':'System logs',
    'Modelo del equipo':'Device model',
    'Memoria RAM':'RAM',
    'Versión de Plasma':'Plasma version',
    'Actualizaciones del sistema':'System updates',
    'Tiempo en pantalla':'Screen time',
    'Límites de uso':'Usage limits',
    'Asistente de escritura':'Writing assistant',
    'Modos predefinidos':'Preset modes',
    'Lupa':'Magnifier',
    'Lector de pantalla':'Screen reader',
    'Alto contraste':'High contrast',
    'Navegador predeterminado':'Default browser',
    'Reproductor multimedia':'Media player',
    'Información médica':'Medical information',
    'Contactos de emergencia':'Emergency contacts',
    'Ethernet (cable)':'Ethernet (wired)',
    'Lámpara mágica':'Magic lamp',
    'Latencia del cursor':'Cursor latency',
    'Atenuar pantalla':'Dim screen',
    'Perfil térmico':'Thermal profile',
    'Límite de carga':'Charge limit',
    'Visor de imágenes':'Image viewer',
    'Lector de PDF':'PDF reader',
    'Editor de texto':'Text editor',
    // ── Input devices (touchpad / mouse) ──
    'Entrada':'Input',
    'Ratón':'Mouse',
    'Sensibilidad, gestos y desplazamiento':'Sensitivity, gestures and scrolling',
    'Velocidad, botones y rueda':'Speed, buttons and wheel',
    'No se detectó ningún touchpad':'No touchpad detected',
    'No se detectó ningún ratón':'No mouse detected',
    'Conecta un ratón USB o Bluetooth':'Connect a USB or Bluetooth mouse',
    'Activado':'Enabled',
    'Tocar para hacer clic':'Tap to click',
    'Un toque equivale a clic izquierdo':'A tap acts as left click',
    'Desplazamiento natural':'Natural scrolling',
    'El contenido sigue el movimiento de los dedos':'Content follows finger movement',
    'Desactivar al escribir':'Disable while typing',
    'Botones para zurdos':'Left-handed buttons',
    'Intercambia clic izquierdo y derecho':'Swaps left and right click',
    'Velocidad del puntero':'Pointer speed',
    'Aceleración adaptativa':'Adaptive acceleration',
    'Desactívala para precisión constante (gaming)':'Turn off for constant precision (gaming)',
    // ── External displays ──
    'Pantallas externas':'External displays',
    'No hay pantallas externas conectadas':'No external displays connected',
    'Conecta un monitor por HDMI o USB-C y aparecerá aquí':'Connect a monitor via HDMI or USB-C and it will appear here',
    'Activada':'Enabled',
    'Desactivada':'Disabled',
    'Resolución':'Resolution',
    'Posición':'Position',
    'Duplicada':'Mirrored',
    'A la izquierda':'To the left',
    'A la derecha':'To the right',
    'Duplicar pantalla':'Mirror display',
    'Establecer como principal':'Set as primary',
    'Pantalla del portátil':'Laptop display',
    'Pantalla externa':'External display',
    'No puedes desactivar la única pantalla':'You cannot disable the only display',
    // ── Advanced power ──
    'Opciones avanzadas de energía':'Advanced power options',
    'Tapa, suspensión y batería crítica':'Lid, suspend and critical battery',
    'Con batería':'On battery',
    'Enchufado':'Plugged in',
    'Batería crítica':'Critical battery',
    'Al cerrar la tapa':'When lid is closed',
    'Suspender tras inactividad':'Suspend after inactivity',
    'Apagar pantalla tras':'Turn off screen after',
    'Acción con batería crítica':'Critical battery action',
    'Nivel crítico':'Critical level',
    'Suspender':'Suspend',
    'Apagar la pantalla':'Turn off screen',
    'Bloquear':'Lock',
    'Apagar el equipo':'Shut down',
    'No hacer nada':'Do nothing',
    'Hibernar':'Hibernate',
    'Guardado':'Saved',
    // ── Cursor / icon theme pickers ──
    'Personalización':'Customization',
    'Tema del cursor':'Cursor theme',
    'No se encontraron temas de cursor':'No cursor themes found',
    'No se encontraron temas de iconos':'No icon themes found',
    'Tema del cursor aplicado':'Cursor theme applied',
    'Predeterminado':'Default',
    // ── Keyboard / touchpad+mouse pages ──
    'Touchpad y ratón':'Touchpad and mouse',
    'Distribución':'Layout',
    'Atajos':'Shortcuts',
    'Repetición de teclas':'Key repeat',
    'Retardo antes de repetir':'Delay before repeating',
    'Velocidad de repetición':'Repeat rate',
    'Guardado — se aplica al iniciar sesión':'Saved — applies at next login',
    'Ver el registro de cambios':'View changelog',
    // ── Recovery / snapshots ──
    'Acceso a instantáneas no habilitado':'Snapshot access not enabled',
    'Btrfs y Snapper están listos, pero falta permitir que tu usuario lea los puntos de restauración.':'Btrfs and Snapper are ready, but your user still needs permission to read restore points.',
    'Habilitar acceso':'Enable access',
    'Habilita el acceso para ver tus puntos de restauración.':'Enable access to see your restore points.',
    'Habilita el acceso primero':'Enable access first',
    'Acceso habilitado':'Access enabled',
    'Crear ahora':'Create now',
    'Creando punto de restauración…':'Creating restore point…',
    'Punto de restauración creado':'Restore point created',
    'Error al crear el punto':'Failed to create restore point',
    // ── Touchpad extras / display extras / custom shortcuts / avatar crop ──
    'Velocidad de desplazamiento':'Scroll speed',
    'Clic derecho con dos dedos':'Two-finger right click',
    'Desactivado: clic derecho en la esquina inferior derecha':'Off: right click in the bottom-right corner',
    'Arriba':'Above',
    'Abajo':'Below',
    'Cambiar de ventana':'Switch windows',
    'Pantalla completa':'Fullscreen window',
    'Lanza cualquier comando con una combinación de teclas':'Launch any command with a key combination',
    'Añadir atajo':'Add shortcut',
    'Comando (ej: konsole)':'Command (e.g. konsole)',
    'Pulsar para capturar combinación':'Press to capture combination',
    'Completa nombre, comando y combinación':'Fill in name, command and combination',
    'Atajo creado':'Shortcut created',
    'Atajo eliminado':'Shortcut deleted',
    'Eliminar atajo':'Delete shortcut',
    'Ajustar foto':'Adjust photo',
    'Arrastra para encuadrar':'Drag to frame',
    // ── Shortcuts editor ──
    'Atajos de teclado':'Keyboard shortcuts',
    'Ver y cambiar los atajos del sistema':'View and change system shortcuts',
    'Captura de pantalla':'Screenshot',
    'Terminal':'Terminal',
    'Bloquear pantalla':'Lock screen',
    'Ventanas':'Windows',
    'Vista general':'Overview',
    'Vista de cuadrícula':'Grid view',
    'Mostrar escritorio':'Show desktop',
    'Maximizar ventana':'Maximize window',
    'Minimizar ventana':'Minimize window',
    'Cerrar ventana':'Close window',
    'Forzar cierre de ventana':'Force close window',
    'Sin asignar':'Not assigned',
    'Toca un atajo y pulsa la nueva combinación. Esc cancela · Retroceso lo borra.':'Tap a shortcut and press the new combination. Esc cancels · Backspace clears it.',
    'Pulsa la combinación…':'Press the combination…',
    'Atajo actualizado':'Shortcut updated',
    // ── Emergency / misc placeholders ──
    'Eliminar cuenta':'Delete account',
    'Buscar Buds':'Search for Buds',
    'Ej. A+':'e.g. A+',
    'Ej. Penicilina':'e.g. Penicillin',
    'Ej. Ibuprofeno':'e.g. Ibuprofen',
    'Ej. Diabetes':'e.g. Diabetes',
    // Dock (pantalla de inicio)
    'Efecto lupa':'Magnification',
    'Los iconos crecen al pasar el cursor, estilo macOS. Al desactivarlo se quedan siempre a tamaño completo':'Icons grow under the cursor, macOS style. Turn it off to keep them always at full size',
    'Intensidad de la lupa':'Magnification strength',
    'Cuánto crece el icono bajo el cursor':'How much the icon grows under the cursor',
    'Efecto lupa activado':'Magnification on',
    'Efecto lupa desactivado':'Magnification off',
    'Suave':'Subtle',
    'Normal':'Normal',
    'Fuerte':'Strong',
    'Paleta dinámica de BookOS':'BookOS dynamic palette',
    'Acento automático de Plasma':'Automatic Plasma accent',
    'Color de acento nativo de KDE según el fondo':"KDE's native accent color, based on the wallpaper",
};

function _tr(str){
    if (!str || typeof str !== 'string') return str;
    const lang = (typeof localStorage!=='undefined' ? localStorage.getItem('bookos_lang') : null) || 'es';
    if (lang === 'es') return str;
    if (_UI_TR_EN[str]) return _UI_TR_EN[str];
    return str;
}

// ── DOM translation pass ─────────────────────────────────────────────────
// Most pages build HTML with raw Spanish text in template literals, so that
// text never passes through _tr(). This walks rendered DOM and applies the
// existing _UI_TR_EN dictionary to text nodes + common attributes when the
// app language is English. Idempotent (English text isn't in the dict, so a
// second pass is a no-op) and only mutates exact full-string matches.
function _isEN(){
    const lang=(typeof localStorage!=='undefined'?localStorage.getItem('bookos_lang'):null)||'es';
    return lang==='en';
}
function translateDOM(root){
    if(!_isEN()||!root||typeof document==='undefined')return;
    try{
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null);
        const nodes=[]; let n;
        while((n=walker.nextNode()))nodes.push(n);
        for(const tn of nodes){
            const raw=tn.nodeValue; if(!raw)continue;
            const key=raw.trim(); if(!key)continue;
            const tr=_UI_TR_EN[key];
            if(tr&&tr!==key)tn.nodeValue=raw.replace(key,tr);
        }
        (root.querySelectorAll?root:document).querySelectorAll('[placeholder],[title],[aria-label]').forEach(el=>{
            for(const a of ['placeholder','title','aria-label']){
                const v=el.getAttribute(a); if(!v)continue;
                const tr=_UI_TR_EN[v.trim()];
                if(tr&&tr!==v.trim())el.setAttribute(a,tr);
            }
        });
    }catch(e){}
}
// Auto-translate dynamically-inserted content (pages, dialogs, popovers) by
// observing the body for added subtrees. Debounced via rAF to coalesce bursts.
if(typeof window!=='undefined'){
    window.translateDOM=translateDOM;
    if(typeof document!=='undefined'&&typeof MutationObserver!=='undefined'){
        let _pending=new Set(), _raf=0;
        const _flush=()=>{ _raf=0; const batch=_pending; _pending=new Set(); batch.forEach(node=>translateDOM(node)); };
        const _obs=new MutationObserver(muts=>{
            if(!_isEN())return;
            for(const m of muts) for(const node of m.addedNodes){
                if(node.nodeType===1) _pending.add(node);
            }
            if(_pending.size&&!_raf)_raf=requestAnimationFrame(_flush);
        });
        const _start=()=>{ if(document.body){ _obs.observe(document.body,{childList:true,subtree:true}); translateDOM(document.body); } };
        if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',_start);
        else _start();
    }
}

function renderRowItem(title, subtitle, rightContent){
    return `<div class="detail-item detail-item-row"><div class="detail-texts"><span class="dt">${_tr(title)}</span>${subtitle?`<span class="ds">${_tr(subtitle)}</span>`:''}</div>${rightContent}</div>`;
}
function renderToggle(id, active=false){
    // Real button: tabbable, Enter/Space for free, announced as a switch by screen readers
    return `<button type="button" class="toggle-switch ${active?'active':''}" data-toggle="${id}" role="switch" aria-checked="${active}"></button>`;
}
function renderSlider(id, value=50, min=0, max=100){
    const fill=((value-min)/(max-min))*100;
    return `<div class="slider-container"><input type="range" class="filled" id="${id}" min="${min}" max="${max}" value="${value}" style="--fill:${fill}%"><span class="slider-label" id="${id}-l">${value}%</span></div>`;
}
function renderHeader(title, rightActions=''){
    return `<div class="detail-header"><button class="back-btn" onclick="window.goBack()">←</button><h2 class="detail-title">${_tr(title)}</h2>${rightActions?`<div class="detail-header-actions">${rightActions}</div>`:''}</div>`;
}
function renderSection(title){
    return `<p class="section-header">${_tr(title)}</p>`;
}

// ── Estados de error / vacío ────────────────────────────────────────────
// Antes no existía ningún helper de error: los `catch(e){}` mudos dejaban la
// página vacía y el usuario no distinguía "falló el backend" de "no hay nada".
// Los callbacks se registran en un mapa y se despachan por delegación para no
// depender de `onclick=` inline (hostil a CSP) ni obligar a cablear ids.
const _stateCbs=new Map();
let _stateSeq=0,_stateBound=false;
function _stateAction(cb){
    if(typeof cb!=='function')return'';
    if(!_stateBound){
        _stateBound=true;
        document.addEventListener('click',e=>{
            const b=e.target?.closest?.('[data-state-action]');
            if(!b)return;
            const fn=_stateCbs.get(b.dataset.stateAction);
            if(fn){e.preventDefault();fn();}
        });
    }
    const id='st'+(++_stateSeq);
    _stateCbs.set(id,cb);
    // El mapa se llenaría sin fin al repintar páginas: se queda con los últimos.
    if(_stateCbs.size>60)_stateCbs.delete(_stateCbs.keys().next().value);
    return id;
}
function renderError(msg='No se pudo cargar la información',{onRetry,retryLabel='Reintentar'}={}){
    const id=_stateAction(onRetry);
    return `<div class="empty-state state-error">
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="var(--tx2)" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16.4v.01"/></svg>
        <span>${_tr(msg)}</span>
        ${id?`<button type="button" class="btn btn-sm" data-state-action="${id}">${_tr(retryLabel)}</button>`:''}
    </div>`;
}
// cta: {label,onClick} — hasta ahora ningún estado vacío ofrecía acción.
function renderEmptyState(icon,title,sub='',cta=null){
    const id=cta?_stateAction(cta.onClick):'';
    return `<div class="empty-state">
        ${icon||''}
        <span class="dt">${_tr(title)}</span>
        ${sub?`<span class="ds">${_tr(sub)}</span>`:''}
        ${id?`<button type="button" class="btn btn-sm" data-state-action="${id}">${_tr(cta.label)}</button>`:''}
    </div>`;
}

// Fila que navega a otra página. Las filas escritas a mano eran <div> con
// `style="cursor:pointer"`: ni enfocables, ni anunciadas, ni activables con
// teclado — el panel derecho entero era inalcanzable salvo los toggles.
function renderNavRow(title,subtitle='',{id='',right=''}={}){
    return `<div class="detail-item detail-item-row nav-row" role="button" tabindex="0"${id?` id="${id}"`:''}><div class="detail-texts"><span class="dt">${_tr(title)}</span>${subtitle?`<span class="ds">${_tr(subtitle)}</span>`:''}</div>${right||chevron()}</div>`;
}
// Enter/Espacio activan esas filas igual que un click (el rol button lo promete).
document.addEventListener('keydown',e=>{
    if(e.key!=='Enter'&&e.key!==' ')return;
    const r=e.target?.closest?.('.nav-row[role="button"]');
    if(!r)return;
    e.preventDefault();r.click();
});

// ── Anchored popover select ──────────────────────────────────────────────
// Floating option picker anchored to a settings row (instead of a sub-page).
// options: [{val,label,sub?,right?,color?}] · title?: header label
// footer: {label,onClick} extra action.
function popoverSelect(anchor,{options,current,onSelect,footer=null,title=''}){
    const prev=document.getElementById('bk-popover');
    if(prev){const same=prev._anchor===anchor;prev.remove();if(same)return;}
    const pop=document.createElement('div');
    pop.id='bk-popover';
    pop.className='bk-popover';
    pop._anchor=anchor;
    const radio=on=>`<span class="bk-pop-radio${on?' on':''}"></span>`;
    pop.innerHTML=(title?`<div class="bk-pop-title">${title}</div>`:'')
        +`<div class="bk-pop-list">`+options.map(o=>{
        const on=String(o.val)===String(current);
        return `<div class="bk-pop-item${on?' active':''}" data-val="${esc(String(o.val))}">
            ${radio(on)}
            ${o.color?`<span class="bk-pop-dot" style="background:${o.color}"></span>`:''}
            <div class="bk-pop-texts">
                <span class="bk-pop-label">${o.label}</span>
                ${o.sub?`<span class="bk-pop-sub">${o.sub}</span>`:''}
            </div>
            ${o.right?`<span class="bk-pop-right">${o.right}</span>`:''}
        </div>`;}).join('')+`</div>`
        +(footer?`<div class="bk-pop-footer" id="bk-pop-footer"><span>${footer.label}</span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>`:'');
    // Inline expansion: inserted right after the anchor row so it occupies
    // space (pushes content down) and scrolls with the page instead of floating.
    anchor.insertAdjacentElement('afterend',pop);
    const close=()=>{pop.remove();document.removeEventListener('mousedown',out,true);document.removeEventListener('keydown',key,true);};
    const out=e=>{if(!pop.contains(e.target)&&!anchor.contains(e.target))close();};
    const key=e=>{if(e.key==='Escape'){e.stopPropagation();close();}};
    setTimeout(()=>{document.addEventListener('mousedown',out,true);document.addEventListener('keydown',key,true);},0);
    pop.querySelectorAll('.bk-pop-item').forEach(it=>it.addEventListener('click',()=>{close();onSelect(it.dataset.val);}));
    if(footer)pop.querySelector('#bk-pop-footer')?.addEventListener('click',()=>{close();footer.onClick();});
}


// ── Toggle & Slider setup (no setTimeout hack — uses MutationObserver-safe approach) ──
function themeColor(name, isDark) {
    const n = name.toLowerCase();
    if(n.includes('bookos')&&n.includes('dark')) return 'linear-gradient(135deg,#000000,#1c1c1e)';
    if(n.includes('bookos')&&n.includes('light')) return 'linear-gradient(135deg,#f2f2f7,#ffffff)';
    if(n.includes('bookos')) return isDark?'linear-gradient(135deg,#000000,#1c1c1e)':'linear-gradient(135deg,#f2f2f7,#ffffff)';
    if(n.includes('catppuccin')&&n.includes('mocha')) return isDark?'linear-gradient(135deg,#1e1e2e,#313244)':'linear-gradient(135deg,#eff1f5,#ccd0da)';
    if(n.includes('catppuccin')&&n.includes('frappe')) return 'linear-gradient(135deg,#303446,#414559)';
    if(n.includes('catppuccin')) return isDark?'linear-gradient(135deg,#24273a,#363a4f)':'linear-gradient(135deg,#eff1f5,#dce0e8)';
    if(n.includes('nord')) return isDark?'linear-gradient(135deg,#2e3440,#3b4252)':'linear-gradient(135deg,#eceff4,#d8dee9)';
    if(n.includes('emerald')&&n.includes('smooth')) return 'linear-gradient(135deg,#1a3a2a,#2d5a3f)';
    if(n.includes('emerald')) return isDark?'linear-gradient(135deg,#1a3a2a,#2d5a3f)':'linear-gradient(135deg,#e8f5e9,#c8e6c9)';
    if(n.includes('iridescent')) return isDark?'linear-gradient(135deg,#1a1a2e,#2d2d5a)':'linear-gradient(135deg,#e8e8f5,#d0d0e8)';
    if(n.includes('heimdal')) return 'linear-gradient(135deg,#1a2940,#2a4060)';
    if(n.includes('kvadapta')||n.includes('adapta')) return isDark?'linear-gradient(135deg,#263238,#37474f)':'linear-gradient(135deg,#fafafa,#eceff1)';
    if(n.includes('breeze')&&n.includes('classic')) return isDark?'linear-gradient(135deg,#31363b,#4d4d4d)':'linear-gradient(135deg,#eff0f1,#bdc3c7)';
    if(n.includes('breeze')) return isDark?'linear-gradient(135deg,#232629,#31363b)':'linear-gradient(135deg,#eff0f1,#fcfcfc)';
    if(n.includes('cachyos')) return isDark?'linear-gradient(135deg,#0d1117,#1a2332)':'linear-gradient(135deg,#e6f0ff,#cce0ff)';
    // Fallback: hash the name for a unique color
    let hash=0;for(let i=0;i<name.length;i++)hash=name.charCodeAt(i)+((hash<<5)-hash);
    const hue=Math.abs(hash)%360;
    return isDark?`linear-gradient(135deg,hsl(${hue},25%,12%),hsl(${hue},20%,18%))`:`linear-gradient(135deg,hsl(${hue},30%,92%),hsl(${hue},25%,85%))`;
}
function setupToggle(id, callback){
    requestAnimationFrame(()=>{
        const el=document.querySelector(`[data-toggle="${id}"]`);
        if(!el)return;
        el.addEventListener('click',function(){
            this.classList.toggle('active');
            const active=this.classList.contains('active');
            this.setAttribute('aria-checked',active?'true':'false');
            const sub=this.closest('.detail-item-row')?.querySelector('.ds');
            if(sub&&!sub.querySelector('span')&&!sub.dataset.custom) sub.textContent=active?t('enabled'):t('disabled');
            callback(active);
        });
    });
}
function setupSlider(id, callback, showPercent=true, liveCallback=null){
    requestAnimationFrame(()=>{
        const slider=document.getElementById(id), label=document.getElementById(id+'-l');
        if(!slider)return;
        const update=()=>{
            const pct=((slider.value-slider.min)/(slider.max-slider.min))*100;
            slider.style.setProperty('--fill',pct+'%');
            if(label) label.textContent=showPercent?slider.value+'%':slider.value;
            if(liveCallback)liveCallback(slider.value);
        };
        slider.addEventListener('input',update);
        slider.addEventListener('change',()=>callback(slider.value));
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Conexiones ──────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
function wifiIcon(band,active){
    const col=active?'#0a84ff':'var(--tx2)';
    return `<div class="conn-net-icon">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none">
            <path d="M1.42 9a16 16 0 0 1 21.16 0" stroke="${col}" stroke-width="2" stroke-linecap="round" opacity="${active?1:.45}"/>
            <path d="M5 12.55a11 11 0 0 1 14.08 0" stroke="${col}" stroke-width="2" stroke-linecap="round" opacity="${active?1:.7}"/>
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" stroke="${col}" stroke-width="2" stroke-linecap="round"/>
            <circle cx="12" cy="20" r="1.5" fill="${col}"/>
        </svg>
        ${band?`<span class="wifi-band-badge" style="color:${col}">${esc(band)}</span>`:''}
    </div>`;
}
function btIcon(hint,name){
    const n=name.toLowerCase();
    const hp=hint==='audio-headphones'||['buds','headphone','pod','earphone','airpod'].some(k=>n.includes(k));
    const lp=hint==='computer'||['book','laptop','computer'].some(k=>n.includes(k));
    const pc=!lp&&n.includes('pc');
    const ph=hint==='phone'||['phone','galaxy s','iphone'].some(k=>n.includes(k));
    const wt=hint==='watch'||['watch','band'].some(k=>n.includes(k));
    const s='var(--tx)',w='1.8',r='round';
    if(hp)return`<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="${s}" stroke-width="${w}" stroke-linecap="${r}"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;
    if(lp||pc)return`<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="${s}" stroke-width="${w}" stroke-linecap="${r}"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M0 21h24"/></svg>`;
    if(ph)return`<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="${s}" stroke-width="${w}" stroke-linecap="${r}"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="18" r="1" fill="${s}"/></svg>`;
    if(wt)return`<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="${s}" stroke-width="${w}" stroke-linecap="${r}"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M7 9l-2-4h10M7 15l-2 4h10"/></svg>`;
    return`<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="${s}" stroke-width="${w}" stroke-linecap="${r}"><rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 6V4M16 6V4M8 18v2M16 18v2"/></svg>`;
}
function chevron(){return`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--tx2)" stroke-width="2" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>`;}
function lockIcon(){return`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--tx2)" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;}


// ── Shared exports (consumed by pages.js barrel + per-section modules) ──
export{
    tauriInvoke,getAssetUrl,t,
    getSetting,setSetting,primeSetting,ci,_icInvalidate,getCachedHwState,
    esc,addInterval,toast,showDialog,showRootAuth,promptSudo,invokeWithAuth,
    renderSkeleton,renderSkeletonChart,renderLoading,renderCard,renderInfoItem,
    renderError,renderEmptyState,renderNavRow,
    _tr,renderRowItem,renderToggle,renderSlider,renderHeader,renderSection,
    popoverSelect,themeColor,setupToggle,setupSlider,wifiIcon,btIcon,chevron,lockIcon
};
