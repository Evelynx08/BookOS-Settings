// ── Routines engine ──────────────────────────────────────────────────────
// Lightweight automation core: persistence + snapshot/restore + execution.
// Split out of pages.js so main.js can load it at startup (routine seeding +
// system-event handlers) WITHOUT pulling in the heavy page renderers, which
// are dynamically imported only on first navigation.
import{tauriInvoke}from'../tauri-api.js';

export function getRoutines(){try{return JSON.parse(localStorage.getItem('bookos_routines')||'[]');}catch{return[];}}
export function saveRoutines(r){localStorage.setItem('bookos_routines',JSON.stringify(r));}

const SNAPS_KEY='bookos_routine_snaps';
function _loadSnaps(){try{return JSON.parse(localStorage.getItem(SNAPS_KEY)||'{}');}catch{return{};}}
export function _saveSnap(id,snap){const s=_loadSnaps();s[id]=snap;localStorage.setItem(SNAPS_KEY,JSON.stringify(s));}
export function _deleteSnap(id){const s=_loadSnaps();delete s[id];localStorage.setItem(SNAPS_KEY,JSON.stringify(s));}
export function _getSnap(id){return _loadSnaps()[id]||null;}

export function getRoutineSnapshot(id){return _getSnap(id);}
export function deleteRoutineSnapshot(id){_deleteSnap(id);}
export async function saveRoutineSnapshot(routine){const snap=await snapshotForRoutine(routine);_saveSnap(routine.id,snap);}

export async function executeRoutine(routine){
    if(routine.undo){
        const snap=await snapshotForRoutine(routine);
        _saveSnap(routine.id,snap);
    }
    for(const a of routine.actions){
        try{
            if(a.type==='performance')await tauriInvoke('set_performance_mode',{mode:a.value});
            else if(a.type==='wifi')await tauriInvoke('toggle_wifi',{enable:a.value==='true'});
            else if(a.type==='bluetooth')await tauriInvoke('toggle_bluetooth',{enable:a.value==='true'});
            else if(a.type==='airplane')await tauriInvoke('toggle_airplane_mode',{enable:a.value==='true'});
            else if(a.type==='brightness')await tauriInvoke('set_brightness',{value:parseInt(a.value)});
            else if(a.type==='volume')await tauriInvoke('set_volume',{value:parseInt(a.value)});
            else if(a.type==='dnd')await tauriInvoke('toggle_dnd',{enable:a.value==='true'});
            else if(a.type==='nightlight')await tauriInvoke('set_nightlight',{active:a.value==='true',temperature:null});
            else if(a.type==='theme'){await tauriInvoke('set_color_scheme',{scheme:a.value});document.documentElement.className=/dark/i.test(a.value)?'dark-mode':'light-mode';}
            else if(a.type==='kbd_brightness')await tauriInvoke('set_kbd_brightness',{level:parseInt(a.value)});
            // ── New actions ──
            else if(a.type==='vision_booster')await tauriInvoke(a.value==='true'?'activar_vision_booster':'desactivar_vision_booster');
            else if(a.type==='hdr')await tauriInvoke(a.value==='true'?'activar_hdr':'desactivar_hdr');
            else if(a.type==='screen_saver')await tauriInvoke(a.value==='true'?'activar_ahorro_pantalla':'desactivar_ahorro_pantalla');
            else if(a.type==='thermal')await tauriInvoke('aplicar_perfil_termico',{modo:a.value});
            else if(a.type==='icc_profile')await tauriInvoke('aplicar_perfil_color',{nombreArchivo:a.value});
            else if(a.type==='fan_mode')await tauriInvoke('set_fan_mode',{mode:a.value});
            else if(a.type==='charge_limit')await tauriInvoke('set_charge_limit',{limit:parseInt(a.value)});
        }catch(e){}
    }
}

export async function snapshotForRoutine(routine){
    const snap={};
    const types=new Set(routine.actions.map(a=>a.type));
    const promises=[];
    if(types.has('brightness'))promises.push(tauriInvoke('get_brightness').then(r=>{const v=JSON.parse(r);snap.brightness=v.brightness;}).catch(()=>{}));
    if(types.has('volume'))promises.push(tauriInvoke('get_volume').then(r=>{const v=JSON.parse(r);snap.volume=v.volume;}).catch(()=>{}));
    if(types.has('theme'))promises.push(tauriInvoke('get_current_theme').then(r=>{const v=JSON.parse(r);snap.theme=v.scheme;snap.theme_is_dark=v.is_dark;}).catch(()=>{}));
    if(types.has('performance'))promises.push(tauriInvoke('check_book_hw').then(r=>{const v=JSON.parse(r);snap.performance=v.performance_mode||'balanced';}).catch(()=>{snap.performance='balanced';}));
    if(types.has('wifi'))promises.push(tauriInvoke('get_wifi_status').then(r=>{snap.wifi=JSON.parse(r).enabled;}).catch(()=>{}));
    if(types.has('bluetooth'))promises.push(tauriInvoke('get_bluetooth_status').then(r=>{snap.bluetooth=JSON.parse(r).enabled;}).catch(()=>{}));
    if(types.has('airplane'))promises.push(tauriInvoke('get_airplane_mode').then(r=>{snap.airplane=JSON.parse(r).enabled;}).catch(()=>{}));
    if(types.has('dnd'))promises.push(tauriInvoke('get_dnd_status').then(r=>{snap.dnd=JSON.parse(r).dnd_active;}).catch(()=>{}));
    if(types.has('nightlight'))promises.push(tauriInvoke('get_nightlight').then(r=>{snap.nightlight=JSON.parse(r).active;}).catch(()=>{}));
    if(types.has('kbd_brightness'))promises.push(tauriInvoke('get_kbd_brightness').then(r=>{snap.kbd_brightness=JSON.parse(r).level;}).catch(()=>{}));
    // New action types snapshot
    if(types.has('hdr')||types.has('vision_booster')||types.has('thermal')){
        promises.push(tauriInvoke('obtener_estado_pantalla').then(r=>{
            const v=typeof r==='string'?JSON.parse(r):r;
            snap.hdr_active=v.hdr_activo;
            snap.thermal_mode=v.modo_termico;
        }).catch(()=>{}));
    }
    await Promise.all(promises);
    return snap;
}

export async function restoreSnapshot(snap){
    const promises=[];
    if('brightness' in snap)promises.push(tauriInvoke('set_brightness',{value:parseInt(snap.brightness)}).catch(()=>{}));
    if('volume' in snap)promises.push(tauriInvoke('set_volume',{value:parseInt(snap.volume)}).catch(()=>{}));
    if('theme' in snap){promises.push(tauriInvoke('set_color_scheme',{scheme:snap.theme}).catch(()=>{}));document.documentElement.className=snap.theme_is_dark?'dark-mode':'light-mode';}
    if('performance' in snap)promises.push(tauriInvoke('set_performance_mode',{mode:snap.performance}).catch(()=>{}));
    if('wifi' in snap)promises.push(tauriInvoke('toggle_wifi',{enable:snap.wifi}).catch(()=>{}));
    if('bluetooth' in snap)promises.push(tauriInvoke('toggle_bluetooth',{enable:snap.bluetooth}).catch(()=>{}));
    if('airplane' in snap)promises.push(tauriInvoke('toggle_airplane_mode',{enable:snap.airplane}).catch(()=>{}));
    if('dnd' in snap)promises.push(tauriInvoke('toggle_dnd',{enable:snap.dnd}).catch(()=>{}));
    if('nightlight' in snap)promises.push(tauriInvoke('set_nightlight',{active:snap.nightlight,temperature:null}).catch(()=>{}));
    if('kbd_brightness' in snap)promises.push(tauriInvoke('set_kbd_brightness',{level:parseInt(snap.kbd_brightness)}).catch(()=>{}));
    // New action types restore
    if('hdr_active' in snap)promises.push(tauriInvoke(snap.hdr_active?'activar_hdr':'desactivar_hdr').catch(()=>{}));
    if('thermal_mode' in snap)promises.push(tauriInvoke('aplicar_perfil_termico',{modo:snap.thermal_mode}).catch(()=>{}));
    await Promise.all(promises);
}
