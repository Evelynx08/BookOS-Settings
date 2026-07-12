import{renderHome,searchIndex,subSearchIndex}from'./modules/home.js';
import{t,getLang}from'./modules/i18n.js';
// Routines engine is light and needed at startup (seeding + system-event
// handlers), so it loads statically. The heavy page renderers in pages.js are
// dynamically imported on first navigation to keep cold start fast.
import{getRoutines,executeRoutine,snapshotForRoutine,restoreSnapshot,getRoutineSnapshot,deleteRoutineSnapshot,saveRoutineSnapshot,saveRoutines}from'./modules/routines-engine.js';
let _pagesPromise=null;
const _loadPages=()=>(_pagesPromise||(_pagesPromise=import('./modules/pages.js')));
import{tauriInvoke,isTauri}from'./tauri-api.js';

document.addEventListener('DOMContentLoaded',async()=>{
    const sb=document.getElementById('sb'),app=document.getElementById('app'),mc=document.getElementById('mc');
    // Apply translations to static index.html elements
    document.documentElement.lang=getLang();
    document.title=t('settings')+' BookOS';
    const _hdr=document.querySelector('.header-title');if(_hdr)_hdr.textContent=t('settings');
    const _sIn=document.getElementById('search-in');if(_sIn)_sIn.placeholder=t('search_placeholder');
    const _noR=document.getElementById('no-res');if(_noR)_noR.textContent=t('no_results');
    // ── Instant first paint ──
    // Never block the sidebar on backend shell spawns. Apply the last-known
    // theme + user from localStorage synchronously (no flash, no await), paint
    // immediately, then correct from the backend when it answers.
    const _applyTheme=(isDark)=>{document.documentElement.classList.toggle('dark-mode',isDark);document.documentElement.classList.toggle('light-mode',!isDark);};
    try{const c=localStorage.getItem('__theme_dark__');if(c!==null)_applyTheme(c==='1');}catch{}
    // Restore "reduced motion" lab preference (before any render)
    try{if(localStorage.getItem('bookos_lab_reducedmotion')==='true')document.documentElement.classList.add('reduced-motion');}catch{}
    let userInfo=null;
    try{userInfo=JSON.parse(localStorage.getItem('__user_info__')||'null');}catch{}
    if(sb)sb.innerHTML=renderHome(userInfo);

    // ── Backend corrections (non-blocking) ──
    tauriInvoke('get_current_theme').then(j=>{try{const th=JSON.parse(j);_applyTheme(!!th.is_dark);localStorage.setItem('__theme_dark__',th.is_dark?'1':'0');}catch(e){}}).catch(()=>{});
    tauriInvoke('get_user_info').then(j=>{try{const ui=JSON.parse(j);if(JSON.stringify(ui)!==JSON.stringify(userInfo)){userInfo=ui;if(sb)sb.innerHTML=renderHome(ui);window.updateHomeBudsRow?.();}localStorage.setItem('__user_info__',j);}catch(e){}}).catch(()=>{});
    // Re-apply hardware settings saved from previous session (battery limit, perf mode)
    tauriInvoke('restore_startup_settings').catch(()=>{});
    // Detect distro package manager once and cache for UI
    tauriInvoke('get_pkg_mgr').then(j=>{try{localStorage.setItem('__pkg_mgr__',j);}catch{}}).catch(()=>{});
    tauriInvoke('has_flatpak').then(j=>{try{localStorage.setItem('__has_flatpak__',j);}catch{}}).catch(()=>{});

    // Warm the page-renderers module in the background once home is painted, so
    // the first navigation is instant despite the renderers being lazy-loaded.
    setTimeout(()=>{_loadPages();},500);

    // ── Cache warm-up ──
    // Prefetch the read data of the most-visited pages in the background so the
    // FIRST navigation to them is served instantly from the invoke cache.
    // Two staggered waves to avoid a process-spawn burst during startup.
    setTimeout(()=>{
        ['get_battery_status','get_brightness','get_volume','get_system_info',
         'get_wifi_status','get_bluetooth_status','get_airplane_mode']
            .forEach(c=>tauriInvoke(c).catch(()=>{}));
    },1200);
    setTimeout(()=>{
        ['get_audio_devices','get_bluetooth_devices','get_available_themes',
         'get_theme_schedule','get_datetime_info','get_locale_info','get_lock_timeout']
            .forEach(c=>tauriInvoke(c).catch(()=>{}));
    },3000);

    // Page id → exported render function name in pages.js (resolved lazily).
    const pages={
        conexiones:'renderConexiones',pantalla:'renderPantalla',sonido:'renderSonido',
        bateria:'renderBateria',notificaciones:'renderNotificaciones',temas:'renderTemas',
        acerca:'renderAcerca',actualizacion:'renderActualizacion',recuperacion:'renderSnapshots',bloqueo:'renderBloqueo',
        general:'renderGeneral',cuentas:'renderCuentas',mantenimiento:'renderMantenimiento',
        seguridad:'renderSeguridad',fondos:'renderFondos',aplicaciones:'renderAplicaciones',
        dispositivos:'renderDispositivos',
        ai:'renderAI',
        modos:'renderModos',
        ubicacion:'renderUbicacion',
        emergencia:'renderEmergencia',
        avanzadas:'renderAvanzadas',
        salud:'renderSaludDigital',
        accesibilidad:'renderAccesibilidad',
        inicio:'renderPantallaInicio'
    };
    // Páginas directas / aliases usados por los widgets del panel (BookOS-Widgets)
    pages.wifi='renderWifiPage';          // subpágina Wi-Fi
    pages.bluetooth='renderBTPage';       // subpágina Bluetooth
    const pageAliases={red:'conexiones',brillo:'pantalla',volumen:'sonido'};
    Object.entries(pageAliases).forEach(([a,t])=>{ if(!pages[a]) pages[a]=pages[t]; });
    // Resolve+invoke a page renderer, loading the renderers module on first use.
    // The guarded container drops writes if the user navigated away meanwhile.
    function renderPage(id,container){
        _loadPages().then(mod=>{
            const fn=mod[pages[id]]||((c)=>mod.renderPlaceholder(c,id));
            fn(container);
        }).catch(e=>console.error('[renderPage]',id,e));
    }

    // ── Navigation ──
    const _navHistory=[];
    function clearPageIntervals(){
        if(window._pageIntervals){window._pageIntervals.forEach(clearInterval);window._pageIntervals=[];}
    }
    // Wrap the page container so async renders can't overwrite a newer page.
    // Each render gets a container bound to the nav epoch at call time; once the
    // user navigates (epoch bumps), writes from the stale render are ignored.
    function guardedContainer(epoch){
        return new Proxy(app,{
            set(target,prop,value){
                if(prop==='innerHTML' && (window._navEpoch||0)!==epoch) return true; // stale: drop write
                target[prop]=value; return true;
            },
            get(target,prop){
                const v=target[prop];
                return typeof v==='function'?v.bind(target):v;
            }
        });
    }
    // Per-page scroll memory + HTML snapshots (for swipe previews)
    const _scrollMem={};
    const _pageSnaps={};
    const _fwdHistory=[];
    const detailView=document.querySelector('.detail-view');
    function _rememberScroll(pageId){
        if(!pageId||!detailView)return;
        _scrollMem[pageId]=detailView.scrollTop;
        // Snapshot the rendered page so swipe gestures can preview it
        if(app&&app.innerHTML)_pageSnaps[pageId]=app.innerHTML;
    }
    function _restoreScroll(pageId){
        if(!detailView)return;
        const y=_scrollMem[pageId]||0;
        // Pages render async; retry briefly until the content is tall enough
        let tries=0;
        (function attempt(){
            if(detailView.scrollHeight-detailView.clientHeight>=y||tries++>10){detailView.scrollTop=y;return;}
            setTimeout(attempt,50);
        })();
    }
    function _playTransition(back){
        app.classList.remove('page-enter','page-enter-back');
        void app.offsetWidth;
        app.classList.add(back?'page-enter-back':'page-enter');
    }
    function openPage(id){
        if(!app)return;
        // Bump the navigation token so any in-flight async render from the
        // previous page knows it's stale and must not overwrite the new page.
        const epoch=(window._navEpoch=(window._navEpoch||0)+1);
        clearPageIntervals();
        const curId=sb.querySelector('.item.active-item')?.dataset?.page;
        _rememberScroll(curId);
        // Skip push if navigating to same page; cap depth at 15
        if(curId!==id){
            _navHistory.push(curId||null);
            if(_navHistory.length>15)_navHistory.shift();
        }
        sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));
        sb.querySelector(`[data-page="${id}"]`)?.classList.add('active-item');
        _fwdHistory.length=0;   // a fresh jump invalidates the forward stack
        _playTransition(false);
        if(detailView)detailView.scrollTop=0;
        renderPage(id,guardedContainer(epoch));
    }
    // Forward navigation (only reachable after going back)
    function goForward(){
        if(!_fwdHistory.length)return;
        const epoch=(window._navEpoch=(window._navEpoch||0)+1);
        clearPageIntervals();
        const next=_fwdHistory.pop();
        const curId=sb.querySelector('.item.active-item')?.dataset?.page;
        _rememberScroll(curId);
        _navHistory.push(curId||null);
        if(_navHistory.length>15)_navHistory.shift();
        sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));
        sb.querySelector(`[data-page="${next}"]`)?.classList.add('active-item');
        _playTransition(false);
        renderPage(next,guardedContainer(epoch));
        _restoreScroll(next);
    }
    function goBack(){
        const epoch=(window._navEpoch=(window._navEpoch||0)+1);
        clearPageIntervals();
        if(!_navHistory.length){app.innerHTML='';sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));return;}
        const prev=_navHistory.pop();
        sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));
        if(prev){
            sb.querySelector(`[data-page="${prev}"]`)?.classList.add('active-item');
            renderPage(prev,guardedContainer(epoch));
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
        const epoch=(window._navEpoch=(window._navEpoch||0)+1);
        clearPageIntervals();
        if(!_navHistory.length){app.innerHTML='';sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));return;}
        const prev=_navHistory.pop();
        if(prev&&typeof prev==='object'&&prev._subNav){_playTransition(true);prev.fn();return;}
        const curId=sb.querySelector('.item.active-item')?.dataset?.page;
        if(curId){_rememberScroll(curId);_fwdHistory.push(curId);if(_fwdHistory.length>15)_fwdHistory.shift();}
        sb.querySelectorAll('.item').forEach(i=>i.classList.remove('active-item'));
        if(prev){
            sb.querySelector(`[data-page="${prev}"]`)?.classList.add('active-item');
            _playTransition(true);
            renderPage(prev,guardedContainer(epoch));
            _restoreScroll(prev);
        } else {
            app.innerHTML='';
        }
    }
    window.openPage=openPage;
    window.goBack=goBackExt;
    window.goForward=goForward;
    document.addEventListener('click',e=>{if(e.target.closest('.back-btn'))window.goBack?.();});
    window.pushSubNav=pushSubNav;
    window.clearPageIntervals=clearPageIntervals;
    window._navHistory=_navHistory;
    // Render guard: a render captures window._navEpoch at start; if it changed
    // by the time the async work finishes, the user navigated away — bail out.
    window.navEpoch=()=>window._navEpoch||0;
    window.isStale=(epoch)=>(window._navEpoch||0)!==epoch;
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

    // Open the Buds page from the Home shortcut; ensure pages.js (which owns
    // openConnectedBuds) is loaded first.
    const _openBuds=()=>{ if(window.openConnectedBuds)window.openConnectedBuds(); else _loadPages().then(()=>window.openConnectedBuds?.()); };
    sb?.addEventListener('click',e=>{
        if(e.target.closest('#home-buds')){_openBuds();return;}
        const item=e.target.closest('[data-page]');
        if(item)openPage(item.dataset.page);
    });
    // Keyboard activation for the focusable (role="button") sidebar items.
    sb?.addEventListener('keydown',e=>{
        if(e.key!=='Enter'&&e.key!==' ')return;
        if(e.target.closest('#home-buds')){e.preventDefault();_openBuds();return;}
        const item=e.target.closest('[data-page]');
        if(item){e.preventDefault();openPage(item.dataset.page);}
    });

    // Keep the Home profile-card buds shortcut in sync with the connected device.
    // Detect the connected earbuds/headset locally (pages.js is lazy-loaded, so
    // we can't rely on window.getConnectedBuds being available on the Home view).
    async function _connectedBudsLocal(){
        try{
            const st=JSON.parse(await tauriInvoke('get_bluetooth_status'));
            if(!(st.enabled||st.powered))return null;
            const devs=JSON.parse(await tauriInvoke('get_bluetooth_devices'));
            const isAudio=d=>{const ic=(d.icon||'').toLowerCase(),nm=(d.name||'').toLowerCase();
                return ic.includes('headset')||ic.includes('headphone')||ic.includes('audio-head')||ic.includes('audio')||ic.startsWith('audio-')||
                       nm.includes('buds')||nm.includes('airpods')||nm.includes('headset')||nm.includes('earphone')||
                       nm.includes('galaxy buds')||nm.includes('pixel buds')||nm.includes('wf-')||nm.includes('wh-')||nm.includes('beats');};
            return devs.find(d=>d.connected&&(isAudio(d)||!d.icon))||null;
        }catch(e){return null;}
    }
    // Show the shortcut whenever earbuds/headset are connected (auto or manual).
    async function updateHomeBudsRow(){
        const row=document.getElementById('home-buds');
        if(!row)return;
        let dev=null;
        try{ dev=await (window.getConnectedBuds?window.getConnectedBuds():_connectedBudsLocal()); }catch(e){ dev=await _connectedBudsLocal().catch(()=>null); }
        if(dev&&dev.connected){
            row.style.display='';
            const nm=row.querySelector('.home-buds-name');
            if(nm)nm.textContent=dev.name||'Buds';
        }else{
            row.style.display='none';
        }
    }
    window.updateHomeBudsRow=updateHomeBudsRow;
    // pages.js (where getConnectedBuds lives) is lazy-loaded; poll so the row
    // appears once it's available and tracks connect/disconnect.
    updateHomeBudsRow();
    setInterval(updateHomeBudsRow,5000);

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
    // The sidebar is always visible on launch; it only hides when the user
    // presses the toggle (or Ctrl+B) within the session — no persistence.
    {
        document.getElementById('sidebar-toggle')?.addEventListener('click',()=>{
            mc?.classList.toggle('sidebar-collapsed');
        });
        // Keyboard shortcut: Ctrl+B
        document.addEventListener('keydown',e=>{
            if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='b'&&!e.target?.matches?.('input,textarea')){
                e.preventDefault();
                mc?.classList.toggle('sidebar-collapsed');
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
            // NOTE: double-clicking a data-tauri-drag-region already toggles
            // maximize natively. A JS dblclick handler here would fire a *second*
            // toggle (maximize then immediately restore) — so we don't add one.
            // Instead we just keep the button icon / windowed class in sync.
            const syncMaxState=async()=>{
                const m=await w.isMaximized().catch(()=>false);
                if(mx)mx.textContent=m?'❐':'☐';
                mc?.classList.toggle('windowed',!m);
            };
            w.onResized?.(syncMaxState);
            await syncMaxState();
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

    // ── Touchpad gestures: interactive swipe back/forward with live preview ──
    // Touchpads emit wheel events with deltaX (no touch events in WebKitGTK).
    // Swipe right = back, swipe left = forward. The destination page slides in
    // as a real preview card (Android predictive-back style) using the HTML
    // snapshot taken when you left that page. Navigation only commits on
    // RELEASE (wheel silence ≈ fingers lifted) at full progress.
    {
        const THRESHOLD=300;
        let acc=0,endT=null,active=false,dir=0;   // dir: -1 back, +1 forward
        let cooldownUntil=0;                       // swallow touchpad momentum after a gesture ends
        // Arrow bubble (progress indicator)
        const bub=document.createElement('div');
        bub.className='swipe-back-bubble';
        const ARROW_BACK='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
        const ARROW_FWD='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
        document.body.appendChild(bub);
        // Preview card inside a clipping frame pinned to the content area, so
        // the card emerges from the sidebar's edge instead of crossing over it.
        const clip=document.createElement('div');
        clip.className='swipe-preview-clip';
        const card=document.createElement('div');
        card.className='swipe-preview detail-view';
        clip.appendChild(card);
        document.body.appendChild(clip);
        function targetPage(){
            if(dir<0){const t=_navHistory[_navHistory.length-1];return (typeof t==='string')?t:null;}
            return _fwdHistory[_fwdHistory.length-1]||null;
        }
        let areaRect=null;   // detail-view rect captured at gesture start (sidebar-aware)
        function beginPreview(){
            areaRect=detailView?detailView.getBoundingClientRect():null;
            const tp=targetPage();
            const snap=tp&&_pageSnaps[tp];
            if(!snap||!areaRect){clip.style.display='none';return;}
            const r=areaRect;
            clip.style.cssText=`display:block;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px`;
            card.style.transform=`translateX(${dir<0?-104:104}%)`;
            card.innerHTML=`<div>${snap}</div>`;
            card.scrollTop=_scrollMem[tp]||0;
        }
        function paint(p){
            const side=dir<0?1:-1;   // back: things come from the left
            bub.innerHTML=dir<0?ARROW_BACK:ARROW_FWD;
            bub.style.opacity=Math.min(1,p*1.6);
            // Anchor the bubble to the content area's edges, not the window's,
            // so it doesn't land on top of the sidebar when it's open.
            const aL=areaRect?areaRect.left:0;
            const aR=areaRect?(window.innerWidth-areaRect.right):0;
            bub.style.left=dir<0?aL+'px':'auto';
            bub.style.right=dir<0?'auto':aR+'px';
            bub.style.transform=`translateY(-50%) translateX(${side*(-46+p*62)}px) scale(${0.6+p*0.4})`;
            bub.classList.toggle('armed',p>=1);
            // Preview slides in over the page; page parallaxes away
            card.style.transform=`translateX(${side*(-104+p*104)}%)`;
            if(detailView)detailView.style.transform=`translateX(${side*p*42}px)`;
        }
        function reset(fire){
            const p=Math.min(1,Math.abs(acc)/THRESHOLD);
            const commit=fire&&p>=1;
            acc=0;active=false;          // dir stays set until the exit paint below
            // Inertia after lifting the fingers must not start a new gesture
            cooldownUntil=Date.now()+(commit?800:450);
            bub.classList.add('anim');card.classList.add('anim');
            if(detailView){detailView.style.transition='transform .25s cubic-bezier(.2,.8,.3,1)';detailView.style.transform='';}
            if(commit){
                // Preview finishes sliding to cover the page, then the real
                // render happens underneath it before it fades away.
                card.style.transform='translateX(0)';
                bub.style.opacity='0';
                if(dir<0)window.goBack?.();else window.goForward?.();
                setTimeout(()=>{card.style.opacity='0';},180);
                setTimeout(()=>{clip.style.display='none';card.style.opacity='';card.innerHTML='';},420);
            }else{
                paint(0);
                setTimeout(()=>{clip.style.display='none';card.innerHTML='';},260);
            }
            dir=0;
            setTimeout(()=>{bub.classList.remove('anim','armed');card.classList.remove('anim');if(detailView)detailView.style.transition='';},260);
        }
        document.addEventListener('wheel',e=>{
            if(Date.now()<cooldownUntil)return;    // momentum tail: ignore entirely
            if(Math.abs(e.deltaX)<=Math.abs(e.deltaY)){if(active)reset(false);return;}
            let el=e.target instanceof Element?e.target:null;
            while(el&&el!==document.body){
                if(el.scrollWidth>el.clientWidth+5){const ox=getComputedStyle(el).overflowX;if(ox==='auto'||ox==='scroll')return;}
                el=el.parentElement;
            }
            if(!active){
                // Gestures start only inside the content area — never from the
                // sidebar, which stays untouched and fully visible.
                if(!(e.target instanceof Element)||!detailView||!detailView.contains(e.target))return;
                // Direction decided once, at gesture start, and locked
                const newDir=e.deltaX<0?-1:1;
                if(newDir<0&&!_navHistory.length)return;
                if(newDir>0&&!_fwdHistory.length)return;
                dir=newDir;acc=0;active=true;
                bub.classList.remove('anim');card.classList.remove('anim');
                beginPreview();
            }
            acc+=e.deltaX;
            // Locked direction: pulling the other way only reduces progress
            if(dir<0&&acc>0)acc=0;
            if(dir>0&&acc<0)acc=0;
            paint(Math.min(1,Math.abs(acc)/THRESHOLD));
            clearTimeout(endT);
            endT=setTimeout(()=>reset(true),140);
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
    setInterval(async()=>{
        try{
            // Always re-read: the old early-return on a cached flag meant that
            // enabling the schedule in the UI did nothing until app restart.
            const s=JSON.parse(await tauriInvoke('get_theme_schedule'));
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
    // Built-in battery routine, seeded once: switch to power-saver when the
    // charger is unplugged; the undo snapshot restores the previous profile on
    // reconnect. User can edit/disable/delete it like any routine.
    try{
        if(!localStorage.getItem('bookos_seeded_battery_routine')){
            localStorage.setItem('bookos_seeded_battery_routine','1');
            const rs=getRoutines();
            if(!rs.some(r=>r.triggers&&r.triggers.some(t=>t.type==='power_disconnected'))){
                rs.push({id:crypto.randomUUID(),name:'Ahorro al desconectar',enabled:true,undo:true,
                         triggers:[{type:'power_disconnected'}],
                         actions:[{type:'performance',value:'power-saver'}]});
                saveRoutines(rs);
            }
        }
    }catch(e){}

    // Fire all enabled routines that match a given trigger type.
    // Undo snapshots are persisted (localStorage) so the "switch back to the
    // previous state" works even if the app was restarted in between, and
    // regardless of the routine's undo flag (the flag only governs manual
    // disable-restore in the routines page).
    async function fireMatchingRoutines(triggerType){
        const routines=getRoutines();

        // 1) Restore any routine whose opposite trigger just fired
        for(const r of routines){
            if(!r.enabled||r.undo===false)continue;
            const opposites=new Set();
            for(const t of r.triggers){if(OPPOSITE_TRIGGERS[t.type])opposites.add(OPPOSITE_TRIGGERS[t.type]);}
            if(!opposites.has(triggerType))continue;
            const snap=getRoutineSnapshot(r.id);
            if(!snap)continue;
            try{
                await restoreSnapshot(snap);
                deleteRoutineSnapshot(r.id);
                if(window.toast)window.toast(`"${r.name||'Rutina'}" restaurada`,'↩️');
            }catch(e){}
        }

        // 2) Then fire matching routines (snapshot current state first)
        const matching=routines.filter(r=>r.enabled&&r.triggers.some(t=>t.type===triggerType));
        for(const r of matching){
            try{
                if(r.undo!==false&&r.triggers.some(t=>OPPOSITE_TRIGGERS[t.type]))
                    await saveRoutineSnapshot(r);
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
                if(trigger_type)fireMatchingRoutines(trigger_type);
            });
        }
    }

    // Buds battery watcher: notify when low (<20%) once per session, plus
    // refresh tray-level info every 2 min while connected.
    // Note: no document.hidden guard on the buds watchers — they exist
    // precisely for when the app sits hidden in the tray.
    const _budsLowFired={l:false,r:false,c:false};
    setInterval(async()=>{
        try{
            const st=JSON.parse(await tauriInvoke('buds_get_status'));
            if(!st||!st.connected) return;
            const l=st.battery_l|0, r=st.battery_r|0, ca=st.battery_case|0;
            const isLow=(l>0&&l<=20)||(r>0&&r<=20);
            if(isLow){
                const key=(l<=20?'l':'')+(r<=20?'r':'');
                if(!_budsLowFired[key]){
                    _budsLowFired[key]=true;
                    const lang=localStorage.getItem('bookos_lang')||'es';
                    await tauriInvoke('buds_notify_battery',{left:l,right:r,case:ca,low:true,lang}).catch(()=>{});
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
        try{await tauriInvoke('buds_try_auto_reconnect');}catch(e){}
    },15000);

    // Buds audio-aware switch: every 5s check if PC is playing audio. If yes + buds
    // not on PC → connect (steal from phone). If silent ~30s + buds on PC → disconnect
    // (let phone take them).
    setInterval(async()=>{
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

    // Digital wellbeing: log the active app every 60s while the app runs in the
    // background, so usage data accumulates beyond just the Salud Digital page.
    if(isTauri()){
        setInterval(()=>{
            tauriInvoke('track_active_app').catch(()=>{});
        },60000);
    }

    // Watchdog: time-based routines. Window-based comparison instead of exact
    // HH:MM equality — interval drift or webview timer throttling used to skip
    // minutes entirely, so scheduled routines (e.g. backlight at a set hour)
    // silently never fired. Now any trigger time that fell inside the window
    // since the last check fires exactly once.
    let _lastTimeCheck=Date.now();
    setInterval(async()=>{
        const now=Date.now();
        const from=_lastTimeCheck;
        _lastTimeCheck=now;
        // Cap the window at 6h so a laptop waking from a long suspend doesn't
        // replay a whole day of routines.
        const windowStart=Math.max(from,now-6*3600*1000);
        const routines=getRoutines();
        for(const r of routines){
            if(!r.enabled)continue;
            for(const t of r.triggers){
                if(t.type!=='time'||!t.value)continue;
                const m=/^(\d{1,2}):(\d{2})$/.exec(t.value);
                if(!m)continue;
                // Today's occurrence of the trigger time (and yesterday's, for
                // windows that span midnight)
                const d=new Date(now);d.setHours(parseInt(m[1]),parseInt(m[2]),0,0);
                for(const ts of [d.getTime(),d.getTime()-86400000]){
                    if(ts>windowStart&&ts<=now){
                        try{
                            await executeRoutine(r);
                            if(window.toast)window.toast(`Rutina "${r.name}" ejecutada (${t.value})`,'⏰');
                        }catch(e){}
                        break;
                    }
                }
            }
        }
    },20000);
});

