import{renderHome,searchIndex,subSearchIndex}from'./modules/home.js';
import{t,getLang}from'./modules/i18n.js';
import{renderConexiones,renderPantalla,renderSonido,renderBateria,renderNotificaciones,renderTemas,renderAcerca,renderActualizacion,renderBloqueo,renderGeneral,renderCuentas,renderMantenimiento,renderSeguridad,renderFondos,renderAplicaciones,renderModos,renderSaludDigital,renderAccesibilidad,renderAvanzadas,renderDispositivos,renderAI,renderUbicacion,renderEmergencia,renderPantallaInicio,renderPlaceholder,getRoutines,executeRoutine,snapshotForRoutine,restoreSnapshot}from'./modules/pages.js';
import{tauriInvoke,isTauri}from'./tauri-api.js';

document.addEventListener('DOMContentLoaded',async()=>{
    const sb=document.getElementById('sb'),app=document.getElementById('app'),mc=document.getElementById('mc');
    // Apply translations to static index.html elements
    document.documentElement.lang=getLang();
    document.title=t('settings')+' BookOS';
    const _hdr=document.querySelector('.header-title');if(_hdr)_hdr.textContent=t('settings');
    const _sIn=document.getElementById('search-in');if(_sIn)_sIn.placeholder=t('search_placeholder');
    const _noR=document.getElementById('no-res');if(_noR)_noR.textContent=t('no_results');
    let userInfo=null;
    // Run startup fetches in parallel — saves ~50-100ms on cold start
    const [_ui,_theme]=await Promise.allSettled([tauriInvoke('get_user_info'),tauriInvoke('get_current_theme')]);
    try{userInfo=JSON.parse(_ui.value);}catch(e){}
    try{const t=JSON.parse(_theme.value);document.documentElement.className=t.is_dark?'dark-mode':'light-mode';}catch(e){}
    // Re-apply hardware settings saved from previous session (battery limit, perf mode)
    tauriInvoke('restore_startup_settings').catch(()=>{});
    if(sb)sb.innerHTML=renderHome(userInfo);

    const pages={
        conexiones:renderConexiones,pantalla:renderPantalla,sonido:renderSonido,
        bateria:renderBateria,notificaciones:renderNotificaciones,temas:renderTemas,
        acerca:renderAcerca,actualizacion:renderActualizacion,bloqueo:renderBloqueo,
        general:renderGeneral,cuentas:renderCuentas,mantenimiento:renderMantenimiento,
        seguridad:renderSeguridad,fondos:renderFondos,aplicaciones:renderAplicaciones,
        dispositivos:renderDispositivos,
        ai:renderAI,
        modos:renderModos,
        ubicacion:renderUbicacion,
        emergencia:renderEmergencia,
        avanzadas:renderAvanzadas,
        salud:renderSaludDigital,
        accesibilidad:renderAccesibilidad,
        inicio:renderPantallaInicio
    };

    // ── Navigation ──
    const _navHistory=[];
    function clearPageIntervals(){
        if(window._pageIntervals){window._pageIntervals.forEach(clearInterval);window._pageIntervals=[];}
    }
    function openPage(id){
        if(!app)return;
        clearPageIntervals();
        const curId=sb.querySelector('.item.active-item')?.dataset?.page;
        // Skip push if navigating to same page; cap depth at 15
        if(curId!==id){
            _navHistory.push(curId||null);
            if(_navHistory.length>15)_navHistory.shift();
        }
        sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));
        sb.querySelector(`[data-page="${id}"]`)?.classList.add('active-item');
        // Page-transition: brief fade to mask layout swap
        app.classList.remove('page-enter');
        void app.offsetWidth;
        app.classList.add('page-enter');
        (pages[id]||((c)=>renderPlaceholder(c,id)))(app);
    }
    function goBack(){
        clearPageIntervals();
        if(!_navHistory.length){app.innerHTML='';sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));return;}
        const prev=_navHistory.pop();
        sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));
        if(prev){
            sb.querySelector(`[data-page="${prev}"]`)?.classList.add('active-item');
            (pages[prev]||((c)=>renderPlaceholder(c,prev)))(app);
        } else {
            app.innerHTML='';
        }
    }
    // Push a callback-based back entry (for sub-pages that render into app directly)
    function pushSubNav(fn){
        _navHistory.push({_subNav:true,fn});
        if(_navHistory.length>15)_navHistory.shift();
    }
    // Extends goBack: handles callback-based sub-page entries pushed via pushSubNav
    function goBackExt(){
        clearPageIntervals();
        if(!_navHistory.length){app.innerHTML='';sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));return;}
        const prev=_navHistory.pop();
        if(prev&&typeof prev==='object'&&prev._subNav){prev.fn();return;}
        sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));
        if(prev){
            sb.querySelector(`[data-page="${prev}"]`)?.classList.add('active-item');
            (pages[prev]||((c)=>renderPlaceholder(c,prev)))(app);
        } else {
            app.innerHTML='';
        }
    }
    window.openPage=openPage;
    window.goBack=goBackExt;
    document.addEventListener('click',e=>{if(e.target.closest('.back-btn'))window.goBack?.();});
    window.pushSubNav=pushSubNav;
    window.clearPageIntervals=clearPageIntervals;
    window._navHistory=_navHistory;
    // Navigate to --page startup arg if provided (e.g. launched from battery applet)
    try{const sp=await tauriInvoke('get_startup_page');if(sp&&pages[sp])openPage(sp);}catch(e){}

    // Single-instance: poll for navigation requests from other instances.
    // Every 2s while focused, 5s when minimized/blurred (saves CPU when idle).
    {
        let nextDelay=2000;
        const tick=async()=>{
            try{const p=await tauriInvoke('check_navigation_request');if(p&&pages[p])openPage(p);}catch(e){}
            nextDelay=document.hidden?5000:2000;
            setTimeout(tick,nextDelay);
        };
        setTimeout(tick,nextDelay);
    }

    sb?.addEventListener('click',e=>{
        const item=e.target.closest('[data-page]');
        if(item)openPage(item.dataset.page);
    });

    // ── Search ──
    const sIn=document.getElementById('search-in'),sX=document.getElementById('search-x'),noR=document.getElementById('no-res');
    sIn?.addEventListener('input',()=>{const v=sIn.value.length>0;if(sX)sX.style.visibility=v?'visible':'hidden';filter(sIn.value.toLowerCase().trim());});
    sIn?.addEventListener('keydown',e=>{if(e.key==='Escape'){sIn.value='';if(sX)sX.style.visibility='hidden';filter('');}});
    sX?.addEventListener('click',()=>{sIn.value='';if(sX)sX.style.visibility='hidden';filter('');sIn.focus();});

    // Container for sub-setting results (created on-demand, lives at end of sidebar)
    let _subResultsCard=null;
    function _ensureSubResultsCard(){
        if(_subResultsCard&&document.body.contains(_subResultsCard))return _subResultsCard;
        _subResultsCard=document.createElement('div');
        _subResultsCard.className='card sub-results-card';
        _subResultsCard.style.display='none';
        sb.appendChild(_subResultsCard);
        return _subResultsCard;
    }
    function filter(q){
        const cards=sb.querySelectorAll('.card:not(.sub-results-card)');let any=false;
        const subCard=_ensureSubResultsCard();
        if(!q){cards.forEach(c=>{c.classList.remove('hidden');c.querySelectorAll('.item').forEach(i=>i.classList.remove('hidden'));});subCard.style.display='none';subCard.innerHTML='';noR.style.display='none';return;}
        cards.forEach(card=>{
            if(card.classList.contains('card-profile')){const m='cuenta perfil profile'.includes(q);card.classList.toggle('hidden',!m);if(m)any=true;return;}
            let vis=false;
            card.querySelectorAll('.item[data-page]').forEach(item=>{
                const e=searchIndex.find(s=>s.id===item.dataset.page);
                if(!e){item.classList.add('hidden');return;}
                const ok=e.title.toLowerCase().includes(q)||e.subtitle.toLowerCase().includes(q)||e.keywords.some(k=>k.includes(q));
                item.classList.toggle('hidden',!ok);if(ok)vis=true;
            });
            card.classList.toggle('hidden',!vis);if(vis)any=true;
        });
        // Sub-setting matches — show items that didn't already match by parent page
        const visiblePages=new Set([...sb.querySelectorAll('.card:not(.hidden) .item[data-page]:not(.hidden)')].map(i=>i.dataset.page));
        const subMatches=subSearchIndex.filter(s=>{
            if(visiblePages.has(s.parent))return false;
            return s.title.toLowerCase().includes(q)||s.keywords.some(k=>k.includes(q));
        }).slice(0,12);
        if(subMatches.length){
            const labelOf=id=>searchIndex.find(x=>x.id===id)?.title||id;
            subCard.innerHTML=subMatches.map(s=>`<div class="item sub-result-item" data-page="${s.parent}" tabindex="0"><div class="item-icon sub-result-ic">›</div><div class="item-texts"><span class="title">${s.title}</span><span class="subtitle">en ${labelOf(s.parent)}</span></div></div>`).join('');
            subCard.style.display='';
            any=true;
        }else{
            subCard.style.display='none';subCard.innerHTML='';
        }
        noR.style.display=any?'none':'block';
    }

    // ── Sidebar collapse toggle ──
    {
        const stored=localStorage.getItem('bookos_sidebar_collapsed')==='1';
        if(stored)mc?.classList.add('sidebar-collapsed');
        document.getElementById('sidebar-toggle')?.addEventListener('click',()=>{
            const collapsed=mc?.classList.toggle('sidebar-collapsed');
            localStorage.setItem('bookos_sidebar_collapsed',collapsed?'1':'0');
        });
        // Keyboard shortcut: Ctrl+B
        document.addEventListener('keydown',e=>{
            if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='b'&&!e.target?.matches?.('input,textarea')){
                e.preventDefault();
                const collapsed=mc?.classList.toggle('sidebar-collapsed');
                localStorage.setItem('bookos_sidebar_collapsed',collapsed?'1':'0');
            }
        });
    }

    // ── Window controls ──
    if(isTauri()){
        let w=window.__TAURI__?.window?.getCurrentWindow?.()||window.__TAURI__?.window?.appWindow;
        if(w){
            document.getElementById('minimize')?.addEventListener('click',()=>w.minimize());
            document.getElementById('close')?.addEventListener('click',()=>w.close());
            const mx=document.getElementById('maximize');
            const toggleMax=async()=>{
                if(await w.isMaximized()){await w.unmaximize();mx.textContent='☐';mc?.classList.add('windowed');}
                else{await w.maximize();mx.textContent='❐';mc?.classList.remove('windowed');}
            };
            mx?.addEventListener('click',toggleMax);
            document.querySelector('.titlebar')?.addEventListener('dblclick',toggleMax);
            document.querySelector('.sidebar-header')?.addEventListener('dblclick',toggleMax);
            if(!(await w.isMaximized().catch(()=>false)))mc?.classList.add('windowed');
        }
    }

    // ── Touch swipe gestures (2-finger horizontal = back/forward) ──
    {
        let t0=null;
        document.addEventListener('touchstart',e=>{if(e.touches.length===2)t0={x:(e.touches[0].clientX+e.touches[1].clientX)/2,y:(e.touches[0].clientY+e.touches[1].clientY)/2};},{passive:true});
        document.addEventListener('touchend',e=>{
            if(!t0||e.changedTouches.length<1)return;
            const x1=(e.changedTouches[0].clientX+(e.changedTouches[1]?.clientX??e.changedTouches[0].clientX))/2;
            const y1=(e.changedTouches[0].clientY+(e.changedTouches[1]?.clientY??e.changedTouches[0].clientY))/2;
            const dx=x1-t0.x, dy=y1-t0.y;
            t0=null;
            if(Math.abs(dy)>60||Math.abs(dx)<80)return;
            if(dx>0)window.goBack?.();
        },{passive:true});
    }

    // ── Keyboard shortcuts ──
    document.addEventListener('keydown',e=>{
        if((e.ctrlKey||e.metaKey)&&e.key==='f'){e.preventDefault();sBox.style.display='block';sIn?.focus();sIn?.select();}
        if(e.key==='Escape')goBackExt();
        if(e.key==='ArrowDown'||e.key==='ArrowUp'){
            const items=[...sb.querySelectorAll('.item:not(.hidden)[tabindex]')];
            const cur=document.activeElement;const idx=items.indexOf(cur);
            if(idx>=0){e.preventDefault();items[e.key==='ArrowDown'?Math.min(idx+1,items.length-1):Math.max(idx-1,0)]?.focus();}
            else if(items.length)items[0]?.focus();
        }
        if(e.key==='Enter'&&document.activeElement?.dataset?.page)openPage(document.activeElement.dataset.page);
    });

    // ── Theme schedule ──
    let scheduleEnabled=false;
    try{const s=JSON.parse(await tauriInvoke('get_theme_schedule'));scheduleEnabled=s.enabled;}catch(e){}
    setInterval(async()=>{
        if(!scheduleEnabled)return;
        try{
            const s=JSON.parse(await tauriInvoke('get_theme_schedule'));
            scheduleEnabled=s.enabled;
            if(!s.enabled)return;
            const now=new Date();
            const h=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
            const cur=JSON.parse(await tauriInvoke('get_current_theme'));
            if(h>=s.dark_time||h<s.light_time){if(!cur.is_dark)await tauriInvoke('set_color_scheme',{scheme:s.dark_theme});}
            else{if(cur.is_dark)await tauriInvoke('set_color_scheme',{scheme:s.light_theme});}
        }catch(e){}
    },60000);

    // ── Routine automation ──────────────────────────────────────────────
    // Opposite trigger map: when a trigger fires, which trigger is its "undo" event?
    const OPPOSITE_TRIGGERS={
        power_connected:'power_disconnected',
        power_disconnected:'power_connected',
        wifi_on:'wifi_off',
        wifi_off:'wifi_on',
        bt_on:'bt_off',
        bt_off:'bt_on',
        low_battery:'power_connected'
    };
    // Pending undo snapshots: routineId -> { opposites: Set<string>, snapshot: object, name: string }
    const _pendingUndos=new Map();

    // Fire all enabled routines that match a given trigger type
    async function fireMatchingRoutines(triggerType){
        // 1) First, check if any pending undos should fire for this trigger
        for(const [rid,undo] of _pendingUndos){
            if(undo.opposites.has(triggerType)){
                try{
                    await restoreSnapshot(undo.snapshot);
                    if(window.toast)window.toast(`"${undo.name}" restaurada`,'↩️');
                }catch(e){}
                _pendingUndos.delete(rid);
            }
        }

        // 2) Then fire matching routines
        const routines=getRoutines();
        const matching=routines.filter(r=>r.enabled&&r.triggers.some(t=>t.type===triggerType));
        for(const r of matching){
            try{
                // If undo is enabled, snapshot current state before executing
                if(r.undo){
                    const snapshot=await snapshotForRoutine(r);
                    const opposites=new Set();
                    for(const t of r.triggers){if(OPPOSITE_TRIGGERS[t.type])opposites.add(OPPOSITE_TRIGGERS[t.type]);}
                    if(opposites.size>0)_pendingUndos.set(r.id,{opposites,snapshot,name:r.name||'Rutina'});
                }
                await executeRoutine(r);
                if(window.toast)window.toast(`Rutina "${r.name}" ejecutada automáticamente`,'⚙️');
            }catch(e){}
        }
    }

    // Listen for system events emitted by the Rust backend
    if(isTauri()){
        const listenFn=window.__TAURI__?.event?.listen||window.__TAURI__?.core?.listen;
        if(listenFn){
            listenFn('routine-trigger',(ev)=>{
                const trigger_type=ev?.payload?.trigger_type;
                console.log('[Rutinas] Evento recibido:',trigger_type,ev);
                if(trigger_type)fireMatchingRoutines(trigger_type);
            });
            console.log('[Rutinas] Listener de eventos registrado');
        }else{
            console.warn('[Rutinas] No se encontró window.__TAURI__.event.listen');
        }
    }

    // Buds battery watcher: notify when low (<20%) once per session, plus
    // refresh tray-level info every 2 min while connected.
    const _budsLowFired={l:false,r:false,c:false};
    setInterval(async()=>{
        if(document.hidden) return;
        try{
            const st=JSON.parse(await tauriInvoke('buds_get_status'));
            if(!st||!st.connected) return;
            const l=st.battery_l|0, r=st.battery_r|0, ca=st.battery_case|0;
            const isLow=(l>0&&l<=20)||(r>0&&r<=20);
            if(isLow){
                const key=(l<=20?'l':'')+(r<=20?'r':'');
                if(!_budsLowFired[key]){
                    _budsLowFired[key]=true;
                    await tauriInvoke('buds_notify_battery',{left:l,right:r,case:ca,low:true}).catch(()=>{});
                }
            } else {
                // Reset trigger when batteries recover
                _budsLowFired.l=false;_budsLowFired.r=false;
            }
        }catch(e){}
    },120000);

    // Buds auto-reconnect: every 15s ask backend to reconnect any saved buds
    // marked with auto_reconnect=true if they're in range. Cheap no-op when already connected.
    setInterval(async()=>{
        if(document.hidden) return;
        try{await tauriInvoke('buds_try_auto_reconnect');}catch(e){}
    },15000);

    // Buds audio-aware switch: every 5s check if PC is playing audio. If yes + buds
    // not on PC → connect (steal from phone). If silent ~30s + buds on PC → disconnect
    // (let phone take them).
    setInterval(async()=>{
        if(document.hidden) return;
        const mac = localStorage.getItem('buds_last_mac');
        if(!mac) return;
        try{
            const r = JSON.parse(await tauriInvoke('buds_audio_switch_check',{mac}));
            if(r.action==='connect'){
                await tauriInvoke('run_command',{cmd:'bluetoothctl',args:['connect',mac]}).catch(()=>{});
            } else if(r.action==='disconnect'){
                await tauriInvoke('buds_disconnect').catch(()=>{});
                await tauriInvoke('run_command',{cmd:'bluetoothctl',args:['disconnect',mac]}).catch(()=>{});
            }
        }catch(e){}
    },5000);

    // Watchdog: check time-based routines every 60 seconds
    const _firedTimeRoutines=new Set();
    setInterval(async()=>{
        const now=new Date();
        const pad=n=>String(n).padStart(2,'0');
        const hhmm=pad(now.getHours())+':'+pad(now.getMinutes());
        const routines=getRoutines();
        for(const r of routines){
            if(!r.enabled)continue;
            for(const t of r.triggers){
                if(t.type!=='time'||!t.value)continue;
                if(t.value===hhmm){
                    const key=r.id+'@'+hhmm;
                    if(!_firedTimeRoutines.has(key)){
                        _firedTimeRoutines.add(key);
                        // Clear fired key after 90s so it can fire again next day
                        setTimeout(()=>_firedTimeRoutines.delete(key),90000);
                        try{
                            await executeRoutine(r);
                            if(window.toast)window.toast(`Rutina "${r.name}" ejecutada (${hhmm})`,'⏰');
                        }catch(e){}
                    }
                }
            }
        }
    },60000);
});

