import{tauriInvoke,getAssetUrl}from'../tauri-api.js';

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

// ── Auto-refresh helper — registers interval in _pageIntervals, cleaned up on navigation ──
function addInterval(fn, ms){
    if(!window._pageIntervals)window._pageIntervals=[];
    const id=setInterval(fn,ms);
    window._pageIntervals.push(id);
    return id;
}

// ── Toast notification system ──
let toastContainer=null;
function toast(msg, icon='✓'){
    if(!toastContainer){
        toastContainer=document.createElement('div');
        toastContainer.className='toast-container';
        document.body.appendChild(toastContainer);
    }
    const t=document.createElement('div');
    t.className='toast';
    t.innerHTML=`<span class="toast-icon">${icon}</span>${esc(msg)}`;
    toastContainer.appendChild(t);
    setTimeout(()=>t.remove(),3000);
}

// ── Dialog (replaces browser confirm()) ──
function showDialog(title,msg,{confirmText='Confirmar',confirmClass='confirm',cancelText='Cancelar',onConfirm,onCancel}={}){
    const ov=document.createElement('div');
    ov.className='bk-overlay';
    ov.innerHTML=`<div class="bk-dialog">
        <div class="bk-dialog-title">${title}</div>
        ${msg?`<div class="bk-dialog-msg">${msg}</div>`:''}
        <div class="bk-dialog-btns">
            <button class="bk-dbtn cancel" id="d-cancel">${cancelText}</button>
            <button class="bk-dbtn ${confirmClass}" id="d-ok">${confirmText}</button>
        </div>
    </div>`;
    document.body.appendChild(ov);
    const close=()=>ov.remove();
    ov.querySelector('#d-cancel').onclick=()=>{close();onCancel?.();};
    ov.querySelector('#d-ok').onclick=()=>{close();onConfirm?.();};
    ov.addEventListener('click',e=>{if(e.target===ov){close();onCancel?.();}});
}

// ── Root password prompt — returns Promise<string|null> ──
function showRootAuth(title,desc=''){
    return new Promise(resolve=>{
        const ov=document.createElement('div');
        ov.className='sudo-modal-overlay';
        ov.innerHTML=`<div class="sudo-modal">
            <div class="sudo-icon">🔐</div>
            <div class="sudo-title">${title}</div>
            ${desc?`<div class="sudo-desc">${desc}</div>`:''}
            <div class="sudo-pw-wrap">
                <input type="password" class="sudo-input" id="sudo-pw" placeholder="Contraseña de administrador" autocomplete="current-password">
                <button class="sudo-eye" id="sudo-eye" tabindex="-1">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
            </div>
            <div class="sudo-btns">
                <button class="bk-dbtn cancel" id="sudo-cancel">Cancelar</button>
                <button class="bk-dbtn confirm" id="sudo-ok">Autorizar</button>
            </div>
        </div>`;
        document.body.appendChild(ov);
        const pw=ov.querySelector('#sudo-pw');
        const close=val=>{ov.remove();resolve(val);};
        requestAnimationFrame(()=>pw.focus());
        ov.querySelector('#sudo-cancel').onclick=()=>close(null);
        ov.querySelector('#sudo-ok').onclick=()=>close(pw.value||null);
        const eye=ov.querySelector('#sudo-eye');
        eye.addEventListener('mousedown',e=>{e.preventDefault();pw.type='text';});
        eye.addEventListener('mouseup',()=>pw.type='password');
        eye.addEventListener('mouseleave',()=>pw.type='password');
        pw.addEventListener('keydown',e=>{
            if(e.key==='Enter')close(pw.value||null);
            if(e.key==='Escape')close(null);
        });
    });
}

// ── Generic Sudo action: shows prompt, runs command ──
async function promptSudo(actionName, cmd, args) {
    const pwd=await showRootAuth('Permisos requeridos',`Para ${actionName}, introduce la contraseña del equipo.`);
    if(!pwd)return false;
    const res=JSON.parse(await tauriInvoke('run_sudo_command',{cmd,args,password:pwd}));
    if(res.ok)return true;
    toast('Contraseña incorrecta o error','❌');
    return false;
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
    return `<div class="detail-item"><span class="dt">${title}</span>${subtitle?`<span class="ds">${subtitle}</span>`:''}</div>`;
}
function renderRowItem(title, subtitle, rightContent){
    return `<div class="detail-item detail-item-row"><div class="detail-texts"><span class="dt">${title}</span>${subtitle?`<span class="ds">${subtitle}</span>`:''}</div>${rightContent}</div>`;
}
function renderToggle(id, active=false){
    return `<div class="toggle-switch ${active?'active':''}" data-toggle="${id}"></div>`;
}
function renderSlider(id, value=50, min=0, max=100){
    const fill=((value-min)/(max-min))*100;
    return `<div class="slider-container"><input type="range" class="filled" id="${id}" min="${min}" max="${max}" value="${value}" style="--fill:${fill}%"><span class="slider-label" id="${id}-l">${value}%</span></div>`;
}
function renderHeader(title){
    return `<div class="detail-header"><button class="back-btn" onclick="window.goBack()">←</button><h2 class="detail-title">${title}</h2></div>`;
}
function renderSection(title){
    return `<p class="section-header">${title}</p>`;
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
            const sub=this.closest('.detail-item-row')?.querySelector('.ds');
            if(sub) sub.textContent=active?'Activado':'Desactivado';
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

// ── Conexiones main page ──
export async function renderConexiones(c){
    c.innerHTML=renderHeader('Conexiones')+renderSkeleton(3);
    let w={enabled:false,ssid:''},bt={enabled:false},air={enabled:false};
    try{[w,bt,air]=await Promise.all([
        tauriInvoke('get_wifi_status').then(JSON.parse).catch(()=>({enabled:false,ssid:''})),
        tauriInvoke('get_bluetooth_status').then(JSON.parse).catch(()=>({enabled:false})),
        tauriInvoke('get_airplane_mode').then(JSON.parse).catch(()=>({enabled:false}))
    ]);}catch(e){}

    let h=renderHeader('Conexiones');
    h+=`<div class="detail-card">
        <div class="conn-main-row">
            <div class="conn-main-clickable" id="go-wifi">
                <div class="conn-main-left">
                    <span class="conn-main-title">Wi-Fi</span>
                    <span class="conn-main-sub ${w.enabled&&w.ssid?'conn-sub-active':''}" id="conn-wifi-sub">${w.enabled?(w.ssid?esc(w.ssid):'Activado'):'Desactivado'}</span>
                </div>
                ${chevron()}
            </div>
            ${renderToggle('wifi',w.enabled)}
        </div>
        <div class="conn-main-row">
            <div class="conn-main-clickable" id="go-bt">
                <div class="conn-main-left">
                    <span class="conn-main-title">Bluetooth</span>
                    <span class="conn-main-sub" id="conn-bt-sub">${bt.enabled?'Activado':'Desactivado'}</span>
                </div>
                ${chevron()}
            </div>
            ${renderToggle('bt',bt.enabled)}
        </div>
    </div>`;
    h+=renderCard([renderRowItem('Modo Avión','',renderToggle('air',air.enabled))]);
    c.innerHTML=h;

    document.getElementById('go-wifi')?.addEventListener('click',()=>{if(window.pushSubNav)window.pushSubNav(()=>renderConexiones(c));window.clearPageIntervals?.();renderWifiPage(c);});
    document.getElementById('go-bt')?.addEventListener('click',()=>{if(window.pushSubNav)window.pushSubNav(()=>renderConexiones(c));window.clearPageIntervals?.();renderBTPage(c);});

    setupToggle('wifi',async a=>{
        try{await tauriInvoke('toggle_wifi',{enable:a});}catch(e){}
        const sub=document.getElementById('conn-wifi-sub');
        if(sub){sub.textContent=a?'Activado':'Desactivado';sub.classList.remove('conn-sub-active');}
        toast(a?'Wi-Fi activado':'Wi-Fi desactivado');
    });
    setupToggle('bt',async a=>{
        try{await tauriInvoke('toggle_bluetooth',{enable:a});}catch(e){}
        const sub=document.getElementById('conn-bt-sub');
        if(sub)sub.textContent=a?'Activado':'Desactivado';
        toast(a?'Bluetooth activado':'Bluetooth desactivado');
    });
    setupToggle('air',async a=>{try{await tauriInvoke('toggle_airplane_mode',{enable:a})}catch(e){}toast(a?'Modo Avión activado':'Modo Avión desactivado');});

    // Refresh SSID label every 10s
    addInterval(async()=>{
        const sub=document.getElementById('conn-wifi-sub');if(!sub)return;
        try{
            const w2=JSON.parse(await tauriInvoke('get_wifi_status'));
            sub.textContent=w2.enabled?(w2.ssid?esc(w2.ssid):'Activado'):'Desactivado';
            sub.classList.toggle('conn-sub-active',!!(w2.enabled&&w2.ssid));
        }catch(e){}
    },10000);
}

// ── Wi-Fi subpage ──
async function renderWifiPage(c){
    c.innerHTML=renderHeader('Wi-Fi','conexiones')+renderSkeleton(2);
    let w={enabled:false,ssid:''};
    try{w=JSON.parse(await tauriInvoke('get_wifi_status'));}catch(e){}

    let h=renderHeader('Wi-Fi','conexiones');
    // Toggle card
    h+=`<div class="detail-card">
        <div class="conn-main-row">
            <span class="conn-main-title" style="font-size:17px;font-weight:700;color:var(--blue)">${w.enabled?'Activado':'Desactivado'}</span>
            ${renderToggle('wifi-page',w.enabled)}
        </div>
    </div>`;
    h+=renderSection('Red actual');
    h+=`<div class="detail-card" id="wifi-current">${renderLoading('Obteniendo red...')}</div>`;
    h+=`<div class="section-header-row"><p class="section-header" style="margin:0">Redes disponibles</p><button class="refresh-btn" id="btn-wifi-refresh" title="Buscar redes"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Buscar</button></div>`;
    h+=`<div class="detail-card" id="wl">${renderLoading('Buscando...')}</div>`;
    c.innerHTML=h;

    const rescanAndLoad=async()=>{
        const btn=document.getElementById('btn-wifi-refresh');
        if(btn){btn.disabled=true;btn.classList.add('spinning');}
        try{await tauriInvoke('wifi_rescan');}catch(e){}
        await loadWifi();
        if(btn){btn.disabled=false;btn.classList.remove('spinning');}
    };
    const loadAll=()=>{loadWifi();tauriInvoke('wifi_rescan').catch(()=>{});};
    if(w.enabled)loadAll();
    document.getElementById('btn-wifi-refresh')?.addEventListener('click',()=>rescanAndLoad());

    setupToggle('wifi-page',async a=>{
        try{await tauriInvoke('toggle_wifi',{enable:a});}catch(e){}
        const label=document.querySelector('[data-toggle="wifi-page"]')?.previousElementSibling;
        if(label)label.textContent=a?'Activado':'Desactivado';
        if(a)loadAll();
        else{
            const cur=document.getElementById('wifi-current');const el=document.getElementById('wl');
            if(cur)cur.innerHTML=renderInfoItem('Wi-Fi desactivado','');
            if(el)el.innerHTML='';
        }
        toast(a?'Wi-Fi activado':'Wi-Fi desactivado');
    });

    addInterval(()=>{if(!document.getElementById('wl'))return;loadWifi();},10000);
}

// ── Bluetooth subpage ──
async function renderBTPage(c){
    c.innerHTML=renderHeader('Bluetooth','conexiones')+renderSkeleton(2);
    let bt={enabled:false};
    try{bt=JSON.parse(await tauriInvoke('get_bluetooth_status'));}catch(e){}

    let h=renderHeader('Bluetooth','conexiones');
    h+=`<div class="detail-card">
        <div class="conn-main-row">
            <span class="conn-main-title" style="font-size:17px;font-weight:700;color:${bt.enabled?'var(--blue)':'var(--tx2)'}">${bt.enabled?'Activado':'Desactivado'}</span>
            ${renderToggle('bt-page',bt.enabled)}
        </div>
    </div>`;
    if(bt.enabled)h+=`<p class="conn-bt-hint">Este equipo es visible para dispositivos cercanos mientras Bluetooth está activado.</p>`;
    h+=`<div class="section-header-row"><p class="section-header" style="margin:0">Dispositivos vinculados</p>${bt.enabled?`<button class="refresh-btn" id="btn-bt-scan" title="Buscar dispositivos"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Escanear</button>`:''}</div>`;
    h+=`<div class="detail-card" id="bl">${renderLoading('Cargando...')}</div>`;
    c.innerHTML=h;

    if(bt.enabled)loadBT();
    document.getElementById('btn-bt-scan')?.addEventListener('click',async()=>{
        const btn=document.getElementById('btn-bt-scan');
        if(btn){btn.disabled=true;btn.classList.add('spinning');}
        try{await tauriInvoke('bluetooth_scan').catch(()=>{});}catch(e){}
        await loadBT();
        if(btn){btn.disabled=false;btn.classList.remove('spinning');}
    });

    setupToggle('bt-page',async a=>{
        try{await tauriInvoke('toggle_bluetooth',{enable:a});}catch(e){}
        const label=document.querySelector('[data-toggle="bt-page"]')?.previousElementSibling;
        if(label){label.textContent=a?'Activado':'Desactivado';label.style.color=a?'var(--blue)':'var(--tx2)';}
        if(a)loadBT();
        toast(a?'Bluetooth activado':'Bluetooth desactivado');
    });

    addInterval(()=>{if(!document.getElementById('bl'))return;loadBT();},15000);
}

async function loadWifi(){
    const cur=document.getElementById('wifi-current'),el=document.getElementById('wl');
    if(!el)return;
    try{
        const nets=JSON.parse(await tauriInvoke('get_wifi_list'));
        const active=nets.find(n=>n.active);
        if(cur){
            cur.innerHTML=active
                ?`<div class="conn-net-item">
                    ${wifiIcon(active.band,true)}
                    <div class="conn-net-info">
                        <span class="conn-net-name" style="color:var(--blue)">${esc(active.ssid)}</span>
                        <span class="conn-net-sub">Conectado · ${esc(active.security||'Abierta')}</span>
                    </div>
                    <button class="conn-gear-btn" id="detail-btn" data-ssid="${esc(active.ssid)}" data-sec="${esc(active.security||'')}" data-band="${esc(active.band||'')}">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--tx2)" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                    </button>
                  </div>`
                :renderInfoItem('Sin conexión activa','Selecciona una red abajo');
            cur.querySelector('#detail-btn')?.addEventListener('click',e=>{
                e.stopPropagation();
                const b=e.currentTarget;
                // Find the container to render into — go up to the #app element
                const app=document.getElementById('app');
                if(app)renderWifiDetailPage(app,{ssid:b.dataset.ssid,security:b.dataset.sec,band:b.dataset.band});
            });
        }
        const others=nets.filter(n=>!n.active);
        el.innerHTML=others.length?others.map(n=>`
            <div class="conn-net-item" data-ssid="${esc(n.ssid)}" data-sec="${esc(n.security||'')}">
                ${wifiIcon(n.band,false)}
                <div class="conn-net-info">
                    <span class="conn-net-name">${esc(n.ssid)}</span>
                    <span class="conn-net-sub">${esc(n.security||'Abierta')}</span>
                </div>
                ${n.security&&n.security!=='--'?lockIcon():''}
            </div>`).join(''):renderInfoItem('No se encontraron redes');
        el.querySelectorAll('.conn-net-item[data-ssid]').forEach(row=>{
            row.addEventListener('click',()=>{
                const ssid=row.dataset.ssid,sec=row.dataset.sec;
                if(!sec||sec==='--'){cWifi(ssid,'');return;}
                document.getElementById('wd')?.remove();
                const d=document.createElement('div');d.id='wd';d.className='wifi-dialog';
                d.innerHTML=`<span class="dt">Conectar a ${esc(ssid)}</span><input type="password" id="wp" placeholder="Contraseña" autofocus><div class="wifi-dialog-btns"><button class="btn btn-secondary btn-sm" id="wc">Cancelar</button><button class="btn btn-primary btn-sm" id="wo">Conectar</button></div>`;
                row.insertAdjacentElement('afterend',d);
                document.getElementById('wc').onclick=()=>d.remove();
                document.getElementById('wo').onclick=()=>{cWifi(ssid,document.getElementById('wp').value);d.remove();};
                document.getElementById('wp').addEventListener('keydown',e=>{if(e.key==='Enter'){cWifi(ssid,document.getElementById('wp').value);d.remove();}});
            });
        });
    }catch(e){if(el)el.innerHTML=renderInfoItem('Error al buscar redes');}
}
async function cWifi(s,p){
    toast('Conectando...','📶');
    try{await tauriInvoke('connect_wifi',{ssid:s,password:p});toast('Conectado a '+s,'📶');loadWifi();}
    catch(e){toast('Error al conectar','❌');}
}

async function loadBT(){
    const el=document.getElementById('bl');if(!el)return;
    try{
        const devs=JSON.parse(await tauriInvoke('get_bluetooth_devices'));
        if(!devs.length){el.innerHTML=renderInfoItem('No hay dispositivos vinculados','Activa el modo vinculación en el otro dispositivo');return;}
        el.innerHTML=devs.map(d=>`
            <div class="conn-bt-item ${d.connected?'conn-bt-connected':''}">
                <div class="conn-bt-icon">${btIcon(d.icon||'',d.name)}</div>
                <div class="conn-bt-info">
                    <span class="conn-bt-name">${esc(d.name)}</span>
                    <span class="conn-bt-sub">${d.connected?'Conectado':'Desconectado'}</span>
                </div>
                <button class="conn-gear-btn conn-bt-action" data-mac="${esc(d.mac)}" data-c="${d.connected}">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--tx2)" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
            </div>`).join('');
        el.querySelectorAll('.conn-bt-action').forEach(b=>{
            b.addEventListener('click',async()=>{
                try{
                    if(b.dataset.c==='true')await tauriInvoke('disconnect_bluetooth',{mac:b.dataset.mac});
                    else await tauriInvoke('connect_bluetooth',{mac:b.dataset.mac});
                    loadBT();toast(b.dataset.c==='true'?'Desconectado':'Conectado','🔵');
                }catch(e){toast('Error','❌');}
            });
        });
    }catch(e){
        console.error('[BT] loadBT parse error',e);
        el.innerHTML=renderInfoItem('Error al cargar dispositivos',String(e).slice(0,160));
    }
}

// ── WiFi network detail page ─────────────────────────────────────────────
async function renderWifiDetailPage(c,{ssid,security,band}){
    // Clear current page intervals and register sub-nav back callback
    window.clearPageIntervals?.();
    if(window.pushSubNav)window.pushSubNav(()=>renderWifiPage(c));
    const bigIcon=`<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="#fff" stroke="none"/></svg>`;
    c.innerHTML=renderHeader('Detalles de Wi-Fi')+
        `<div class="wifi-detail-hero">
            <div class="wifi-detail-icon">${bigIcon}</div>
            <div class="wifi-detail-ssid">${esc(ssid)}</div>
            <div class="wifi-detail-status">Conectado</div>
        </div>`+
        `<div class="detail-card" id="wd-details">${renderLoading('Obteniendo detalles...')}</div>`+
        `<div class="detail-card" id="wd-pw-card">
            <div class="wifi-pw-row">
                <span class="wifi-detail-label">Contraseña</span>
                <div style="display:flex;align-items:center;gap:4px">
                    <span class="wifi-pw-val" id="wd-pw">••••••••</span>
                    <button class="wifi-eye-btn" id="wd-eye" title="Mostrar contraseña">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                </div>
            </div>
        </div>`+
        `<div style="padding:0 0 16px"><button class="btn-forget" id="wd-forget">Olvidar red</button></div>`;

    // Load network details
    try{
        const d=JSON.parse(await tauriInvoke('get_wifi_details',{ssid}));
        const rows=[
            ['Seguridad', security||'Abierta'],
            ['Frecuencia', band||'—'],
            ['Dirección IP', d.ip||'—'],
            ['Puerta de enlace', d.gateway||'—'],
            ['DNS', d.dns||'—'],
            ['Dirección MAC', d.mac||'—'],
        ];
        document.getElementById('wd-details').innerHTML=rows.map(([l,v])=>
            `<div class="wifi-detail-row"><span class="wifi-detail-label">${l}</span><span class="wifi-detail-val">${esc(v)}</span></div>`
        ).join('');
    }catch(e){
        document.getElementById('wd-details').innerHTML=renderInfoItem('No se pudieron cargar los detalles');
    }

    // Password reveal — try without sudo first, then ask
    let _pw=null;
    document.getElementById('wd-eye')?.addEventListener('click',async()=>{
        const el=document.getElementById('wd-pw');
        if(!el)return;
        if(_pw!==null){el.textContent=el.textContent==='••••••••'?_pw:'••••••••';return;}
        // Try without sudo
        let res=JSON.parse(await tauriInvoke('get_wifi_password',{ssid,sudoPassword:''}));
        if(res.ok&&res.password){_pw=res.password;el.textContent=_pw;return;}
        if(!res.needs_auth){el.textContent='—';return;}
        // Needs sudo
        const pwd=await showRootAuth('Contraseña requerida',`Para ver la contraseña de "${esc(ssid)}", introduce la contraseña del equipo.`);
        if(!pwd)return;
        res=JSON.parse(await tauriInvoke('get_wifi_password',{ssid,sudoPassword:pwd}));
        if(res.ok&&res.password){_pw=res.password;el.textContent=_pw;}
        else if(res.error==='wrong_password')toast('Contraseña incorrecta','❌');
        else el.textContent='—';
    });

    // Forget network
    document.getElementById('wd-forget')?.addEventListener('click',()=>{
        showDialog(`Olvidar "${esc(ssid)}"`,
            'El equipo no se conectará automáticamente a esta red.',
            {confirmText:'Olvidar',confirmClass:'danger',onConfirm:async()=>{
                try{await tauriInvoke('forget_wifi',{ssid});toast('Red olvidada');renderWifiPage(c);}
                catch(e){toast('Error al olvidar la red','❌');}
            }});
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Pantalla ────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderPantalla(c){
    c.innerHTML=renderHeader('Pantalla')+renderSkeleton(5);
    let br=75,nl={active:false,temperature:4500},displays=[],theme={is_dark:false,scheme:''};
    let lockTimeout=5;
    let savedVb=false,savedHdr=false,savedDpst=false;
    let hw=null;
    let styleThemes={kvantum_dark:'bookos-dark-blue',kvantum_light:'bookos-light-blue',plasma_dark:'bookos-dark',plasma_light:'bookos-light'};
    try{
        const[b,n,d,t,lt,_hw,st]=await Promise.all([
            tauriInvoke('get_brightness').then(JSON.parse).catch(()=>({brightness:75})),
            tauriInvoke('get_nightlight').then(JSON.parse).catch(()=>({active:false,temperature:4500})),
            ci('get_display_info').then(JSON.parse).catch(()=>[]),
            ci('get_current_theme').then(JSON.parse).catch(()=>({is_dark:false,scheme:''})),
            tauriInvoke('get_lock_timeout').then(r=>JSON.parse(r).timeout).catch(()=>5),
            getCachedHwState(),
            ci('get_style_themes').then(JSON.parse).catch(()=>({})),
        ]);
        br=b.brightness;nl=n;displays=d;theme=t;lockTimeout=lt;hw=_hw;
        if(st&&st.kvantum_dark) styleThemes={...styleThemes,...st};
        if(hw&&typeof hw==='string'){try{hw=JSON.parse(hw);}catch{hw=null;}}
        if(hw){
            savedHdr=!!hw.hdr_activo;
            savedVb=!hw.hdr_activo&&hw.brillo_porcentaje>=99;
            savedDpst=hw.platform_profile==='quiet'||(!hw.hdr_activo&&hw.brillo_porcentaje<=42&&hw.modo_termico==='silencioso');
        } else {
            [savedVb,savedHdr,savedDpst]=await Promise.all([
                getSetting('VisionBooster','false').then(v=>v==='true'),
                getSetting('HdrActive','false').then(v=>v==='true'),
                getSetting('AhorroPantalla','false').then(v=>v==='true'),
            ]);
        }
    }catch(e){console.error('[Pantalla]',e);}

    const savedRR=await getSetting('RefreshRate','120');
    const nlFrom=await getSetting('NightLightFrom','22:00');
    const nlTo=await getSetting('NightLightTo','07:00');

    const hasHwDisplayFeatures=hw!==null;
    let savedIcc='SDC4189.icm',savedIccAdaptive=false;
    if(hasHwDisplayFeatures){
        [savedIcc,savedIccAdaptive]=await Promise.all([
            getSetting('IccProfile','SDC4189.icm'),
            getSetting('IccAdaptive','false').then(v=>v==='true'),
        ]);
    }

    // Display helpers
    const resMap={"2880x1800":"WQXGA+","1920x1200":"WUXGA","1440x900":"WXGA+","1280x800":"WXGA","2560x1600":"WQXGA","1920x1080":"FHD"};
    const getResName=m=>{const b=m.split('@')[0].trim();return resMap[b]||b;};
    // hw !== null → el dispositivo tiene controles de pantalla avanzados (HDR, Vision Booster, ICC)

    const curRes=displays.length?getResName(displays[0].current||''):'';
    const curHz=savedRR==='60'?'60 Hz':'120 Hz';
    const nlLabel=nl.active?`${nlFrom} – ${nlTo}`:'Desactivada';
    const iccProfiles=[
        {file:'SDC4189.icm',name:'sRGB',color:'#8e8e93'},
        {file:'SDC4189S.icm',name:'Vivaz',color:'#ff9f0a'},
        {file:'SDC4189A.icm',name:'Natural',color:'#30d158'},
        {file:'SDC4189P.icm',name:'P3',color:'#0a84ff'},
        {file:'auto',name:'Automático',color:'var(--blue)'},
    ];
    const effectiveIcc=savedIccAdaptive?'auto':savedIcc;
    const curIccName=iccProfiles.find(p=>p.file===effectiveIcc)?.name||'sRGB';
    const toMins=lockTimeout;
    const toLabel=toMins<=1?'1 minuto':toMins>=60?`${Math.round(toMins/60)} hora${toMins>60?'s':''}`:`${toMins} minutos`;

    let h=renderHeader('Pantalla');

    // ① Dark/Light mode card
    h+=`<div class="detail-card" style="padding:16px 16px 0;gap:0">
        <div class="display-mode-row" style="margin-bottom:0">
            <div class="display-mode-card ${!theme.is_dark?'active':''}" data-mode="light">
                <div class="display-mode-preview light-preview"><svg width="24" height="18" viewBox="0 0 24 18" fill="none"><rect x="1" y="1" width="22" height="3" rx="1.5" fill="rgba(0,0,0,.15)"/><rect x="1" y="6" width="14" height="2" rx="1" fill="rgba(0,0,0,.1)"/><rect x="1" y="10" width="10" height="2" rx="1" fill="rgba(0,0,0,.08)"/></svg></div>
                <span class="display-mode-label">Claro</span>
                <div class="display-mode-radio"></div>
            </div>
            <div class="display-mode-card ${theme.is_dark?'active':''}" data-mode="dark">
                <div class="display-mode-preview dark-preview"><svg width="24" height="18" viewBox="0 0 24 18" fill="none"><rect x="1" y="1" width="22" height="3" rx="1.5" fill="rgba(255,255,255,.15)"/><rect x="1" y="6" width="14" height="2" rx="1" fill="rgba(255,255,255,.1)"/><rect x="1" y="10" width="10" height="2" rx="1" fill="rgba(255,255,255,.08)"/></svg></div>
                <span class="display-mode-label">Oscuro</span>
                <div class="display-mode-radio"></div>
            </div>
        </div>
        <div style="border-top:1px solid var(--div);margin:14px -16px 0">
            <div class="detail-item" style="cursor:pointer;padding:12px 20px" id="btn-dark-mode-settings">
                <span class="dt" id="dark-mode-settings-label">Ajustes del modo ${theme.is_dark?'Oscuro':'Claro'}</span>
                ${chevron()}
            </div>
        </div>
    </div>`;

    // ② Brightness card
    h+=renderCard([`<div class="detail-item"><span class="dt">Brillo</span>${renderSlider('br',br)}</div>`]);

    // ③ Display options card (each row → sub-page)
    const dispRows=[];
    dispRows.push(`<div class="detail-item" style="cursor:pointer" id="btn-fluidez">
        <span class="dt">Fluidez de movimientos</span>
        <div style="display:flex;align-items:center;gap:6px"><span style="color:var(--blue);font-size:14px" id="lbl-fluidez">${curHz}</span>${chevron()}</div>
    </div>`);
    dispRows.push(`<div class="detail-item" style="cursor:pointer" id="btn-nightlight">
        <span class="dt">Protección de la vista</span>
        <div style="display:flex;align-items:center;gap:6px"><span style="color:var(--blue);font-size:14px">${nlLabel}</span>${chevron()}</div>
    </div>`);
    if(hasHwDisplayFeatures){
        dispRows.push(`<div class="detail-item" style="cursor:pointer" id="btn-display-mode">
            <span class="dt">Modo de pantalla</span>
            <div style="display:flex;align-items:center;gap:6px"><span style="color:var(--blue);font-size:14px">${curIccName}</span>${chevron()}</div>
        </div>`);
    }
    if(displays.length){
        dispRows.push(`<div class="detail-item" style="cursor:pointer" id="btn-resolution">
            <span class="dt">Resolución de la pantalla</span>
            <div style="display:flex;align-items:center;gap:6px"><span style="color:var(--blue);font-size:14px">${curRes}</span>${chevron()}</div>
        </div>`);
    }
    h+=renderCard(dispRows);

    // ④ Timeout card
    h+=renderCard([`<div class="detail-item" style="cursor:pointer" id="btn-timeout">
        <span class="dt">Tiempo de espera de pantalla</span>
        <div style="display:flex;align-items:center;gap:6px"><span style="color:var(--blue);font-size:14px">${toLabel}</span>${chevron()}</div>
    </div>`]);

    // ⑤ Samsung Display extras (if hw)
    if(hasHwDisplayFeatures){
        h+=renderSection('Samsung Display');
        h+=renderCard([
            renderRowItem('Vision Booster','Brillo máximo · Gama amplia P3',renderToggle('vb',savedVb)),
            renderRowItem('HDR','HDR10 nativo · Gama dinámica alta',renderToggle('hdr',savedHdr)),
            renderRowItem('Ahorro de pantalla','90 Hz · GPU en reposo · Brillo al 40%',renderToggle('dpst',savedDpst)),
        ]);
    }

    c.innerHTML=h;

    // Dark/light mode toggle
    document.querySelectorAll('.display-mode-card').forEach(card=>{
        card.addEventListener('click',async()=>{
            const isDark=card.dataset.mode==='dark';
            const kcsT=await tauriInvoke('get_kde_light_dark_themes').then(JSON.parse).catch(()=>({light:'',dark:'',is_global:false}));
            const name=isDark?(kcsT.dark||'BookOS Dark'):(kcsT.light||'BookOS Light');
            try{await tauriInvoke('apply_kde_theme',{name,isGlobal:kcsT.is_global});}catch(e){}
            document.documentElement.className=isDark?'dark-mode':'light-mode';
            document.querySelectorAll('.display-mode-card').forEach(x=>x.classList.remove('active'));
            card.classList.add('active');
            const lbl=document.getElementById('dark-mode-settings-label');
            if(lbl)lbl.textContent='Ajustes del modo '+(isDark?'Oscuro':'Claro');
            toast(isDark?'Cambiando a modo oscuro':'Cambiando a modo claro');
        });
    });

    // Brightness slider
    setupSlider('br',async v=>{try{await tauriInvoke('set_brightness',{value:parseInt(v)})}catch(e){}},true,
        v=>{try{tauriInvoke('set_brightness',{value:parseInt(v)})}catch(e){}});

    // Samsung Display toggles
    if(hasHwDisplayFeatures){
        const save=(key,val)=>setSetting(key,String(val));
        const hwToggle=(id,key,onFn,offFn)=>setupToggle(id,async a=>{
            try{
                const msg=await (a?onFn():offFn());
                invalidateHwCache();
                const hasWarn=msg&&(msg.includes('advertencias')||msg.includes('no crítico'));
                toast(msg,hasWarn?'⚠️':'✓');
                save(key,a);
            }catch(e){
                const el=document.querySelector(`[data-toggle="${id}"]`);
                if(el)el.classList.toggle('active');
                toast(String(e),'❌');
            }
        });
        hwToggle('vb','VisionBooster',()=>tauriInvoke('activar_vision_booster'),()=>tauriInvoke('desactivar_vision_booster'));
        hwToggle('hdr','HdrActive',()=>tauriInvoke('activar_hdr'),()=>tauriInvoke('desactivar_hdr'));
        hwToggle('dpst','AhorroPantalla',()=>tauriInvoke('activar_ahorro_pantalla'),()=>tauriInvoke('desactivar_ahorro_pantalla'));
    }

    // Sub-page navigation
    document.getElementById('btn-dark-mode-settings')?.addEventListener('click',()=>{
        window.pushSubNav?.(()=>renderPantalla(c));
        const isDark=document.documentElement.classList.contains('dark-mode');
        _pantallaSubDarkMode(c,isDark,styleThemes);
    });
    document.getElementById('btn-fluidez')?.addEventListener('click',()=>{
        window.pushSubNav?.(()=>renderPantalla(c));
        _pantallaSubFluidez(c,savedRR,displays);
    });
    document.getElementById('btn-nightlight')?.addEventListener('click',()=>{
        window.pushSubNav?.(()=>renderPantalla(c));
        _pantallaSubNightLight(c,nl,nlFrom,nlTo);
    });
    if(hasHwDisplayFeatures){
        document.getElementById('btn-display-mode')?.addEventListener('click',()=>{
            window.pushSubNav?.(()=>renderPantalla(c));
            _pantallaSubDisplayMode(c,iccProfiles,effectiveIcc);
        });
    }
    if(displays.length){
        document.getElementById('btn-resolution')?.addEventListener('click',()=>{
            window.pushSubNav?.(()=>renderPantalla(c));
            _pantallaSubResolution(c,displays);
        });
    }
    document.getElementById('btn-timeout')?.addEventListener('click',()=>{
        window.pushSubNav?.(()=>renderPantalla(c));
        _pantallaSubTimeout(c,lockTimeout);
    });
}

// ── Pantalla sub-pages ──────────────────────────────────────────────────
function _ckmark(){
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
}

async function _pantallaSubDarkMode(c,isDark,styleThemes){
    const mode=isDark?'Oscuro':'Claro';
    const kvCurrent=isDark?styleThemes.kvantum_dark:styleThemes.kvantum_light;
    const ptCurrent=isDark?styleThemes.plasma_dark:styleThemes.plasma_light;
    const bookosKv=[{id:'bookos-dark-blue',name:'BookOS Oscuro'},{id:'bookos-light-blue',name:'BookOS Claro'}];
    const bookosPlasma=[{id:'bookos-dark',name:'BookOS Oscuro'},{id:'bookos-light',name:'BookOS Claro'}];
    const mkRow=(item,current,dtype)=>`<div class="detail-item" style="cursor:pointer;justify-content:space-between" data-${dtype}="${esc(item.id)}">
        <span class="dt">${esc(item.name)}</span>${current===item.id?_ckmark():''}
    </div>`;
    let h=renderHeader(`Ajustes del modo ${mode}`);
    h+=renderSection('Tema Kvantum');
    h+=renderCard(bookosKv.map(i=>mkRow(i,kvCurrent,'kv')));
    h+=renderSection('Tema Plasma');
    h+=renderCard(bookosPlasma.map(i=>mkRow(i,ptCurrent,'pt')));
    c.innerHTML=h;

    let curKv=kvCurrent,curPt=ptCurrent;
    const save=async()=>{
        const updated={
            kvantumDark:isDark?curKv:styleThemes.kvantum_dark,
            kvantumLight:isDark?styleThemes.kvantum_light:curKv,
            plasmaDark:isDark?curPt:styleThemes.plasma_dark,
            plasmaLight:isDark?styleThemes.plasma_light:curPt,
        };
        try{await tauriInvoke('set_style_themes',updated);_icInvalidate('get_style_themes');_icInvalidate('get_current_theme');toast('Estilo guardado');}catch(e){toast(String(e),'❌');}
        styleThemes={
            kvantum_dark:updated.kvantumDark,kvantum_light:updated.kvantumLight,
            plasma_dark:updated.plasmaDark,plasma_light:updated.plasmaLight,
        };
    };
    document.querySelectorAll('[data-kv]').forEach(row=>row.addEventListener('click',async()=>{
        curKv=row.dataset.kv;await save();_pantallaSubDarkMode(c,isDark,styleThemes);
    }));
    document.querySelectorAll('[data-pt]').forEach(row=>row.addEventListener('click',async()=>{
        curPt=row.dataset.pt;await save();_pantallaSubDarkMode(c,isDark,styleThemes);
    }));
}

function _pantallaSubFluidez(c,savedRR,displays){
    const options=[
        {rr:'120',name:'Fluido',hz:'120 Hz',desc:'Desplazamiento y animaciones más suaves. Mayor consumo de batería.'},
        {rr:'60',name:'Estándar',hz:'60 Hz',desc:'Menor consumo de batería. Adecuado para uso general.'},
    ];
    const mkRow=opt=>`<div class="detail-item" style="cursor:pointer;flex-direction:column;align-items:flex-start;gap:2px;padding:14px 20px" data-rr="${opt.rr}">
        <div style="display:flex;width:100%;align-items:center;justify-content:space-between">
            <div><span class="dt">${opt.name}</span>&nbsp;<span style="color:var(--tx2);font-size:13px">${opt.hz}</span></div>
            ${savedRR===opt.rr?_ckmark():''}
        </div>
        <span class="ds">${opt.desc}</span>
    </div>`;
    let h=renderHeader('Fluidez de movimientos');
    h+=renderCard(options.map(mkRow));
    c.innerHTML=h;
    document.querySelectorAll('[data-rr]').forEach(row=>row.addEventListener('click',async()=>{
        const mode=row.dataset.rr;
        try{
            setSetting('RefreshRate',mode);
            if(displays.length){
                const disp=displays[0];
                const curRes=(disp.current||'').split('@')[0].trim();
                const targetHz=parseInt(mode);
                const targetMode=(disp.modes||[]).find(m=>m.startsWith(curRes)&&Math.abs(parseInt(m.split('@')[1]||'0')-targetHz)<=2);
                if(targetMode)await tauriInvoke('set_resolution',{output:disp.name,resolution:targetMode});
                await tauriInvoke('set_vrr_policy',{output:disp.name,policy:mode==='60'?'1':'2'}).catch(()=>{});
            }
            toast(mode==='120'?'Modo fluido activado (120 Hz)':'Modo estándar activado (60 Hz)');
        }catch(e){}
        _pantallaSubFluidez(c,mode,displays);
    }));
}

async function _pantallaSubNightLight(c,nl,nlFrom,nlTo){
    const tempPct=Math.round(((nl.temperature||4500)-1000)/55);
    let h=renderHeader('Protección de la vista');
    h+=renderCard([renderRowItem('Protección de la vista',nl.active?'Activada':'Desactivada',renderToggle('nl',nl.active))]);
    h+=`<div id="nl-opts"${nl.active?'':' style="display:none"'}>`;
    h+=renderSection('Horario automático');
    h+=renderCard([
        `<div class="detail-item"><span class="dt">Desde las</span><input type="time" class="time-input" id="nl-from" value="${nlFrom}"></div>`,
        `<div class="detail-item"><span class="dt">Hasta las</span><input type="time" class="time-input" id="nl-to" value="${nlTo}"></div>`,
    ]);
    h+=renderSection('Calidez de color');
    h+=renderCard([`<div class="detail-item"><span class="dt">Temperatura</span>${renderSlider('nlt',tempPct,0,100)}</div>`]);
    h+=`</div>`;
    c.innerHTML=h;
    const nlOpts=document.getElementById('nl-opts');
    setupToggle('nl',async a=>{
        try{await tauriInvoke('set_nightlight',{active:a,temperature:null});}catch(e){}
        if(nlOpts)nlOpts.style.display=a?'block':'none';
        nl={...nl,active:a};
        toast(a?'Protector de vista activado':'Protector de vista desactivado');
    });
    setupSlider('nlt',async v=>{
        const temp=1000+Math.round(parseInt(v)*55);
        try{await tauriInvoke('set_nightlight',{active:true,temperature:temp});}catch(e){}
    });
    const saveHours=async()=>{
        const from=document.getElementById('nl-from')?.value||'22:00';
        const to=document.getElementById('nl-to')?.value||'07:00';
        setSetting('NightLightFrom',from);setSetting('NightLightTo',to);
        const toHHMM=t=>t.replace(':','');
        try{
            await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','kwinrc','--group','NightColor','--key','Mode','1']});
            await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','kwinrc','--group','NightColor','--key','EveningBeginFixed',toHHMM(from)]});
            await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','kwinrc','--group','NightColor','--key','MorningBeginFixed',toHHMM(to)]});
        }catch(e){}
        toast('Horario guardado');
    };
    document.getElementById('nl-from')?.addEventListener('change',saveHours);
    document.getElementById('nl-to')?.addEventListener('change',saveHours);
}

function _pantallaSubDisplayMode(c,iccProfiles,effectiveIcc){
    let h=renderHeader('Modo de pantalla');
    h+=renderCard(iccProfiles.map(p=>`
        <div class="detail-item" style="cursor:pointer;justify-content:space-between" data-icc="${p.file}">
            <div style="display:flex;align-items:center;gap:10px">
                <div style="width:9px;height:9px;border-radius:50%;background:${p.color};flex-shrink:0"></div>
                <span class="dt">${p.name}</span>
            </div>
            ${effectiveIcc===p.file?_ckmark():''}
        </div>
    `));
    c.innerHTML=h;
    document.querySelectorAll('[data-icc]').forEach(row=>row.addEventListener('click',async()=>{
        const file=row.dataset.icc;
        if(file==='auto'){setSetting('IccAdaptive','true');toast('Perfil automático activado');}
        else{setSetting('IccAdaptive','false');try{toast(await tauriInvoke('aplicar_perfil_color',{nombreArchivo:file}));setSetting('IccProfile',file);}catch(e){toast(String(e),'❌');}}
        _pantallaSubDisplayMode(c,iccProfiles,file);
    }));
}

function _pantallaSubResolution(c,displays){
    const d=displays[0];
    const curResOnly=(d.current||'').split('@')[0].trim();
    const uniqueRes=[...new Set((d.modes||[]).map(m=>m.split('@')[0].trim()))];
    const resMap={"2880x1800":"WQXGA+","1920x1200":"WUXGA","1440x900":"WXGA+","1280x800":"WXGA","2560x1600":"WQXGA","1920x1080":"FHD"};
    const getResName=m=>{const b=m.split('@')[0].trim();return resMap[b]||b;};
    let h=renderHeader('Resolución de la pantalla');
    h+=renderCard(uniqueRes.map(r=>`
        <div class="detail-item" style="cursor:pointer;justify-content:space-between" data-res="${r}">
            <span class="dt">${getResName(r)}</span>
            <div style="display:flex;align-items:center;gap:8px">
                <span style="color:var(--tx2);font-size:13px">${r}</span>
                ${r===curResOnly?_ckmark():''}
            </div>
        </div>
    `));
    c.innerHTML=h;
    document.querySelectorAll('[data-res]').forEach(row=>row.addEventListener('click',async()=>{
        const res=row.dataset.res;
        const curHz=(d.current||'').split('@')[1]||'60';
        const targetMode=(d.modes||[]).find(m=>m.startsWith(res+'@'+curHz))||(d.modes||[]).find(m=>m.startsWith(res))||res;
        try{await tauriInvoke('set_resolution',{output:d.name,resolution:targetMode});}catch(e){}
        toast('Resolución: '+getResName(res));
        _pantallaSubResolution(c,[{...d,current:targetMode}]);
    }));
}

function _pantallaSubTimeout(c,lockTimeout){
    const options=[
        {mins:1,label:'1 minuto'},{mins:2,label:'2 minutos'},{mins:5,label:'5 minutos'},
        {mins:10,label:'10 minutos'},{mins:15,label:'15 minutos'},{mins:30,label:'30 minutos'},
    ];
    let h=renderHeader('Tiempo de espera de pantalla');
    h+=renderCard(options.map(opt=>`
        <div class="detail-item" style="cursor:pointer;justify-content:space-between" data-mins="${opt.mins}">
            <span class="dt">${opt.label}</span>
            ${lockTimeout===opt.mins?_ckmark():''}
        </div>
    `));
    c.innerHTML=h;
    document.querySelectorAll('[data-mins]').forEach(row=>row.addEventListener('click',async()=>{
        const mins=parseInt(row.dataset.mins);
        try{await tauriInvoke('set_lock_timeout',{minutes:mins});}catch(e){}
        toast('Tiempo de espera: '+row.querySelector('.dt').textContent);
        _pantallaSubTimeout(c,mins);
    }));
}

// ════════════════════════════════════════════════════════════════════════
// ── Sonido ──────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderSonido(c){
    c.innerHTML=renderHeader('Sonidos y vibración')+renderSkeleton(2);
    let vol=50,muted=false,notifSnd=true,uiSnd=true,devices={sinks:[],sources:[],defaultSink:'',defaultSource:''},apps=[],descs=[];
    try{[{volume:vol,muted},{value:notifSnd},{value:uiSnd},devices,apps,descs]=await Promise.all([
        tauriInvoke('get_volume').then(JSON.parse).catch(()=>({volume:50,muted:false})),
        tauriInvoke('run_command',{cmd:'kreadconfig6',args:['--file','plasmanotifyrc','--group','Notifications','--key','Sound','--default','true']}).then(r=>{const v=typeof r==='string'?r:(r.output||'');return{value:v.trim()!=='false'};}).catch(()=>({value:true})),
        tauriInvoke('run_command',{cmd:'kreadconfig6',args:['--file','kdeglobals','--group','Sounds','--key','Enable','--default','true']}).then(r=>{const v=typeof r==='string'?r:(r.output||'');return{value:v.trim()!=='false'};}).catch(()=>({value:true})),
        tauriInvoke('get_audio_devices').then(JSON.parse).catch(()=>({sinks:[],sources:[],defaultSink:'',defaultSource:''})),
        tauriInvoke('get_app_audio').then(JSON.parse).catch(()=>[]),
        tauriInvoke('get_sink_descriptions').then(JSON.parse).catch(()=>[]),
    ]);}catch(e){vol=50;muted=false;notifSnd=true;uiSnd=true;}

    const descMap=Object.fromEntries(descs.map(d=>[d.name,d.desc]));
    const sinkLabel=(name)=>descMap[name]||name.split('.').slice(-2).join(' ')||name;
    const srcLabel=(name)=>descMap[name]||name.split('.').slice(-2).join(' ')||name;

    let h=renderHeader('Sonidos y vibración');
    h+=renderSection('Volumen');
    h+=renderCard([
        `<div class="detail-item"><span class="dt">Volumen del sistema</span>${renderSlider('vol',vol)}</div>`,
        renderRowItem('Silenciar',muted?'Activado':'Desactivado',renderToggle('mute',muted)),
    ]);

    // Output device
    if(devices.sinks.length>1){
        h+=renderSection('Salida de audio');
        h+=`<div class="detail-card"><div class="audio-dev-list" id="audio-sinks">`;
        devices.sinks.forEach(s=>{
            const active=s.name===devices.defaultSink||s.isDefault;
            h+=`<div class="audio-dev-row${active?' active':''}" data-sink="${esc(s.name)}">
                <div class="audio-dev-icon">${active?'<svg viewBox="0 0 20 20" width="16" height="16" fill="none"><circle cx="10" cy="10" r="9" stroke="var(--blue)" stroke-width="1.5"/><path d="M6 10l3 3 5-6" stroke="var(--blue)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>':'<div style="width:16px;height:16px"></div>'}</div>
                <span class="audio-dev-name">${esc(sinkLabel(s.name))}</span>
            </div>`;
        });
        h+=`</div></div>`;
    }

    // Input device
    if(devices.sources.length>1){
        h+=renderSection('Entrada de audio');
        h+=`<div class="detail-card"><div class="audio-dev-list" id="audio-sources">`;
        devices.sources.forEach(s=>{
            const active=s.name===devices.defaultSource||s.isDefault;
            h+=`<div class="audio-dev-row${active?' active':''}" data-source="${esc(s.name)}">
                <div class="audio-dev-icon">${active?'<svg viewBox="0 0 20 20" width="16" height="16" fill="none"><circle cx="10" cy="10" r="9" stroke="var(--blue)" stroke-width="1.5"/><path d="M6 10l3 3 5-6" stroke="var(--blue)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>':'<div style="width:16px;height:16px"></div>'}</div>
                <span class="audio-dev-name">${esc(srcLabel(s.name))}</span>
            </div>`;
        });
        h+=`</div></div>`;
    }

    // Per-app volumes
    const visApps=apps.filter(a=>a.name&&!['pipewire','PulseAudio','pavucontrol'].includes(a.name));
    if(visApps.length>0){
        h+=renderSection('Volumen por aplicación');
        h+=`<div class="detail-card">`;
        visApps.forEach(a=>{
            h+=`<div class="detail-item audio-app-row" data-app-idx="${a.index}">
                <span class="dt audio-app-name">${esc(a.name)}</span>
                ${renderSlider('app-vol-'+a.index,a.volume,0,150)}
            </div>`;
        });
        h+=`</div>`;
    }

    h+=renderSection('Sonidos del sistema');
    h+=renderCard([
        renderRowItem('Sonidos de notificación','Reproduce sonido al recibir notificaciones',renderToggle('snd-notif',notifSnd)),
        renderRowItem('Sonidos de interfaz','Sonidos al hacer clic, navegar y otras acciones',renderToggle('snd-ui',uiSnd)),
    ]);
    h+=renderSection('Controles de medios');
    h+=renderCard([
        renderRowItem('Reproducción anterior','Tecla ⏮',`<span class="ds">⏮</span>`),
        renderRowItem('Reproducir / Pausar','Tecla ⏯',`<span class="ds">⏯</span>`),
        renderRowItem('Siguiente pista','Tecla ⏭',`<span class="ds">⏭</span>`),
    ]);
    c.innerHTML=h;

    setupSlider('vol',async v=>{try{await tauriInvoke('set_volume',{value:parseInt(v)})}catch(e){}});
    setupToggle('mute',async()=>{try{await tauriInvoke('toggle_mute')}catch(e){}toast('Volumen cambiado','🔊');});
    setupToggle('snd-notif',async a=>{try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','plasmanotifyrc','--group','Notifications','--key','Sound',a?'true':'false']});}catch(e){}toast(a?'Sonidos de notificación activados':'Desactivados','🔔');});
    setupToggle('snd-ui',async a=>{try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','kdeglobals','--group','Sounds','--key','Enable',a?'true':'false']});}catch(e){}toast(a?'Sonidos de interfaz activados':'Desactivados');});

    // Sink selection
    c.querySelectorAll('[data-sink]').forEach(row=>row.addEventListener('click',async()=>{
        const name=row.dataset.sink;
        try{await tauriInvoke('set_default_sink',{name});}catch(e){}
        c.querySelectorAll('[data-sink]').forEach(r=>r.classList.remove('active'));
        row.classList.add('active');
        row.querySelector('.audio-dev-icon').innerHTML='<svg viewBox="0 0 20 20" width="16" height="16" fill="none"><circle cx="10" cy="10" r="9" stroke="var(--blue)" stroke-width="1.5"/><path d="M6 10l3 3 5-6" stroke="var(--blue)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        toast('Salida: '+sinkLabel(name),'🔊');
    }));
    c.querySelectorAll('[data-source]').forEach(row=>row.addEventListener('click',async()=>{
        const name=row.dataset.source;
        try{await tauriInvoke('set_default_source',{name});}catch(e){}
        c.querySelectorAll('[data-source]').forEach(r=>r.classList.remove('active'));
        row.classList.add('active');
        row.querySelector('.audio-dev-icon').innerHTML='<svg viewBox="0 0 20 20" width="16" height="16" fill="none"><circle cx="10" cy="10" r="9" stroke="var(--blue)" stroke-width="1.5"/><path d="M6 10l3 3 5-6" stroke="var(--blue)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        toast('Entrada: '+srcLabel(name),'🎙');
    }));

    // Per-app sliders
    visApps.forEach(a=>{
        setupSlider('app-vol-'+a.index,async v=>{try{await tauriInvoke('set_app_volume',{index:a.index,volume:parseInt(v)})}catch(e){}},false);
    });

    // Sync volume externally every 10s
    addInterval(async()=>{
        const slider=document.getElementById('vol');
        if(!slider||document.activeElement===slider)return;
        try{
            const v=JSON.parse(await tauriInvoke('get_volume'));
            const pct=Math.round(v.volume);
            slider.value=pct; slider.style.setProperty('--fill',pct+'%');
            const lbl=document.getElementById('vol-l');if(lbl)lbl.textContent=pct+'%';
            const mt=document.querySelector('[data-toggle="mute"]');
            if(mt){v.muted?mt.classList.add('active'):mt.classList.remove('active');}
        }catch(e){}
    },10000);
}

// ════════════════════════════════════════════════════════════════════════
// ── Batería (real-time, per-app, predictive) ─────────────────────────────
// ════════════════════════════════════════════════════════════════════════

// Calculate human-readable time string for charging/discharging
function _batTimeText(bat, gb){
    const pct=parseInt(bat.percentage)||0;
    const erate=parseFloat((bat.energy_rate||'0').split(' ')[0].replace(',','.'))||0;
    const ef=parseFloat((bat.energy_full||'').replace(',','.'))||0;
    if(bat.state==='charging'&&erate>0&&ef>0){
        const limit=Math.min(100,Math.max(50,parseInt((gb&&gb.charge_limit)||'80')||80));
        if(pct>=limit)return'Límite de carga alcanzado';
        const whNeeded=(limit-pct)/100*ef;
        const h=whNeeded/erate;
        if(h<(1/60))return'Casi completo';
        if(h<1){const m=Math.round(h*60);return`${m} min para completar la carga`;}
        const hh=Math.floor(h),mm=Math.round((h-hh)*60);
        return mm>0?`${hh}h ${mm}min para completar la carga`:`${hh}h para completar la carga`;
    }
    if(bat.state==='discharging'&&erate>0&&ef>0){
        const whLeft=(pct/100)*ef;
        const h=whLeft/erate;
        if(h<(1/60))return'Batería casi agotada';
        if(h<1){const m=Math.round(h*60);return`${m} min de batería restante`;}
        const hh=Math.floor(h),mm=Math.round((h-hh)*60);
        return mm>0?`${hh}h ${mm}min de batería restante`:`${hh}h de batería restante`;
    }
    // Fallback to UPower string
    let t=(bat.time||'').replace('hours','horas').replace('minutes','minutos').replace('hour','hora').replace('minute','minuto');
    if(!t)return'';
    return bat.state==='charging'?`${t} para completar la carga`:`${t} de batería restante`;
}

// ── IPC con el applet de batería ──────────────────────────────────────────
// Escribe el estado actual al archivo compartido /tmp/bookos-state.json
// para que el widget de la bandeja lo lea y se actualice al instante.
function _emitIpcState(profile,chargeLimit){
    const state=JSON.stringify({power_profile:profile,charge_limit:chargeLimit,source:'settings',ts:Date.now()});
    tauriInvoke('write_ipc_state',{state}).catch(()=>{});
}

export async function renderBateria(c){
    c.innerHTML=renderHeader('Batería')+renderSkeleton(2)+renderSkeletonChart();
    await _renderBateriaContent(c);
    // Auto-refresh every 5s — updates live data and syncs state with the battery applet
    let _lastIpcTs=0;
    addInterval(async()=>{
        if(!document.querySelector('.bat-time-big'))return;
        try{
            const [bat,bprot2,savedLimit2,hw2,ipcRaw]=await Promise.all([
                tauriInvoke('get_battery_status').then(JSON.parse).catch(()=>null),
                getSetting('BatteryProtection','false').then(v=>v==='true'),
                getSetting('ChargeLimit','80').then(v=>Math.min(100,Math.max(50,parseInt(v)||80))),
                tauriInvoke('check_hw_features').then(JSON.parse).catch(()=>null),
                tauriInvoke('read_ipc_state').catch(()=>''),
            ]);
            if(!bat)return;
            const pct=parseInt(bat.percentage)||0;
            const states={'charging':'⚡ Cargando','discharging':'En uso','fully-charged':'✓ Completa','not charging':'No cargando','unknown':''};
            const effectiveLimit=bprot2?savedLimit2:100;
            const timeText=_batTimeText(bat,{charge_limit:String(effectiveLimit)});
            const bigEl=document.querySelector('.bat-time-big');
            const subEl=document.querySelector('.bat-sub');
            const fillEl=document.querySelector('.bat-level-fill');
            const rateEl=document.querySelector('.bat-full-info');
            if(bigEl){
                const numEl=bigEl.querySelector('.bat-time-num');
                const lblEl=bigEl.querySelector('.bat-time-label');
                if(timeText){
                    const _split=(t)=>{const m=t.match(/^(.+?)\s+(para\s+|de\s+)(.+)$/i);return m?{num:m[1],label:m[2]+m[3]}:{num:t,label:''};};
                    const {num,label}=_split(timeText);
                    if(numEl)numEl.textContent=num;
                    if(lblEl)lblEl.textContent=label;
                    else if(label&&numEl){const s=document.createElement('span');s.className='bat-time-label';s.textContent=label;bigEl.appendChild(s);}
                } else {
                    if(numEl)numEl.textContent=`${pct}%`;
                    if(lblEl)lblEl.textContent='';
                }
            }
            if(subEl)subEl.textContent=timeText?`${pct}% disponible`:(states[bat.state]||'Batería');
            if(fillEl){fillEl.style.width=pct+'%';}
            const erate=parseFloat((bat.energy_rate||'0').split(' ')[0].replace(',','.'))||0;
            const chargingLbl2=bprot2&&savedLimit2<100?`Cargando hasta el ${savedLimit2}%`:(bat.state==='charging'?'Cargando':'');
            if(rateEl)rateEl.textContent=`${chargingLbl2?chargingLbl2+' · ':''}${erate>0?`Consumo: ${erate.toFixed(1)} W`:''}`;

            // ── Sync desde el sistema (detecta cambios del applet) ──────
            if(hw2){
                const sysProfile=hw2.performance_mode||'balanced';
                document.querySelectorAll('.perf-mode-card').forEach(x=>
                    x.classList.toggle('active',x.dataset.mode===sysProfile));
                // Sync límite de carga si no lo está arrastrando el usuario
                const sliderEl=document.getElementById('cl');
                if(sliderEl&&document.activeElement!==sliderEl){
                    const sysLimit=hw2.charge_limit?parseInt(hw2.charge_limit):100;
                    if(parseInt(sliderEl.value)!==sysLimit){
                        sliderEl.value=sysLimit;
                        const lbl=document.getElementById('cl-l');
                        if(lbl)lbl.textContent=sysLimit+'%';
                        const fill=((sysLimit-50)/(100-50))*100;
                        sliderEl.style.setProperty('--fill',fill+'%');
                    }
                }
            }

            // ── Leer eventos IPC del applet ─────────────────────────────
            // El applet escribe {"power_profile":"...","source":"applet"} en /tmp/bookos-state.json
            if(ipcRaw){
                try{
                    const ipc=JSON.parse(ipcRaw);
                    if(ipc.source==='applet'&&ipc.ts&&ipc.ts!==_lastIpcTs){
                        _lastIpcTs=ipc.ts;
                        if(ipc.power_profile){
                            document.querySelectorAll('.perf-mode-card').forEach(x=>
                                x.classList.toggle('active',x.dataset.mode===ipc.power_profile));
                        }
                    }
                }catch(e){}
            }
        }catch(e){}
    },5000);
}

async function _renderBateriaContent(c){
    let bat={percentage:'0',state:'unknown',time:'',energy_rate:'',energy_full:'',energy_full_design:''};
    let gb={perf_supported:false,charge_limit_supported:false,performance_mode:'balanced',charge_limit:''};
    let hist=[];
    let bprot=false,dimlow=false,showpct=true,psMode='balanced';
    let appUsage=[];
    let savedChargeLimit=80;
    let csvData={ok:false,rows:[]},adaptivePreds={ok:false,predictions:[]};
    let adaptiveEnabled=false;
    let thermalData={ok:false,rows:[]};
    let chargingInfo={ok:false};
    try{
        const [settingsBatch, batRaw, gbRaw, histRaw, appRaw, csvRaw, predsRaw, thermRaw, chgRaw] = await Promise.all([
            tauriInvoke('get_settings_batch',{keys:['BatteryProtection','DimLowBattery','ShowBatteryPercent','PowerSaver','ChargeLimit','AdaptiveCharging']}).then(JSON.parse).catch(()=>({})),
            tauriInvoke('get_battery_status').then(JSON.parse).catch(()=>({percentage:'0',state:'unknown',time:'',energy_rate:'',energy_full:'',energy_full_design:''})),
            ci('check_hw_features').then(JSON.parse).catch(()=>({perf_supported:false,charge_limit_supported:false,performance_mode:'balanced',charge_limit:''})),
            ci('get_battery_history').then(JSON.parse).catch(()=>[]),
            tauriInvoke('get_app_power_usage').then(JSON.parse).catch(()=>[]),
            tauriInvoke('get_battery_csv_data').then(JSON.parse).catch(()=>({ok:false,rows:[]})),
            tauriInvoke('get_adaptive_predictions').then(JSON.parse).catch(()=>({ok:false,predictions:[]})),
            tauriInvoke('get_thermal_csv_data').then(JSON.parse).catch(()=>({ok:false,rows:[]})),
            tauriInvoke('get_charging_info').then(JSON.parse).catch(()=>({ok:false})),
        ]);
        thermalData=thermRaw; chargingInfo=chgRaw;
        bat=batRaw; gb=gbRaw; hist=histRaw; appUsage=appRaw; csvData=csvRaw; adaptivePreds=predsRaw;
        const s=settingsBatch;
        bprot=(s.BatteryProtection??'false')==='true';
        dimlow=(s.DimLowBattery??'false')==='true';
        showpct=(s.ShowBatteryPercent??'true')!=='false';
        psMode=s.PowerSaver??'balanced';
        savedChargeLimit=Math.min(100,Math.max(50,parseInt(s.ChargeLimit)||80));
        adaptiveEnabled=(s.AdaptiveCharging??'false')==='true';
        // Keep _sc in sync with batch results
        Object.entries(s).forEach(([k,v])=>{if(v!=null)_sc.set(k,v);});
    }catch(e){console.error('[Batería] Error:',e);}

    // Effective charge limit: prefer saved slider value (user's intent) over raw hardware value
    const chargeLimit=bprot?savedChargeLimit:100;

    // Re-apply hardware limit on every load — sysfs resets on boot
    if(bprot && gb.charge_limit_supported && savedChargeLimit<100){
        tauriInvoke('set_charge_limit',{limit:savedChargeLimit}).catch(()=>{});
    }

    const states={'charging':'⚡ Cargando','discharging':'En uso','fully-charged':'✓ Completa','not charging':'No cargando','unknown':''};
    const pct=parseInt(bat.percentage)||0;
    // Pass chargeLimit explicitly so text always uses the right target
    const timeText=_batTimeText(bat,{charge_limit:String(chargeLimit)})||'';
    const ef=parseFloat((bat.energy_full||'').replace(',','.'))||0;
    // energy_full_design can sometimes be lower than energy_full due to UPower calibration — use max as denominator
    const efdRaw=parseFloat((bat.energy_full_design||'').replace(',','.'))||0;
    const efd=efdRaw>0?Math.max(efdRaw,ef):ef||1;
    const capacityVal=parseFloat((bat.capacity||'').replace('%','').replace(',','.'))||(efd>0?Math.min(100,Math.round(ef/efd*100)):100);
    const health=Math.min(100,Math.round(capacityVal));
    let h=renderHeader('Batería');
    h+=`<div class="bat-page-wrap">`; // max-width wrapper — evita que el chart se estire en pantalla completa

    // Hero — número grande + label más pequeño en la misma línea
    const _splitTime=(t)=>{const m=t.match(/^(.+?)\s+(para\s+|de\s+)(.+)$/i);return m?{num:m[1],label:m[2]+m[3]}:{num:t,label:''};};
    h+=`<div class="bat-hero">`;
    if(timeText){
        const {num,label}=_splitTime(timeText);
        h+=`<div class="bat-time-big"><span class="bat-time-num">${num}</span>${label?` <span class="bat-time-label">${label}</span>`:''}</div>`;
        h+=`<span class="bat-sub">${pct}% disponible</span>`;
    } else {
        h+=`<div class="bat-time-big"><span class="bat-time-num">${pct}%</span></div>`;
        h+=`<span class="bat-sub">${states[bat.state]||'Batería'}</span>`;
    }
    // Battery bar: siempre verde (#30CF00), marcador de límite si hay protección
    const isCharging=bat.state==='charging';
    const fillColor='green';
    const limitMarker=bprot&&chargeLimit<100?`<div class="bat-limit-marker" style="left:${chargeLimit}%" title="Límite: ${chargeLimit}%"></div>`:'';
    h+=`<div class="bat-level-bar">${limitMarker}<div class="bat-level-fill ${fillColor}" style="width:${pct}%"></div></div>`;
    h+=`</div>`;
    let erate=parseFloat((bat.energy_rate||'0').split(' ')[0].replace(',','.'))||0;
    const chargingLabel=bprot&&chargeLimit<100?`Cargando hasta el ${chargeLimit}%`:(isCharging?'Cargando':'');
    h+=`<div class="bat-full-info" style="color:var(--tx2)">${chargingLabel?chargingLabel+' · ':''}${erate>0?`Consumo: ${erate.toFixed(1)} W`:''}</div>`;

    // Ajustes ANTES del gráfico
    {
        const bprotLabel=bprot?(chargeLimit>=100?'Máxima':`Hasta el ${chargeLimit}%`):'';
        h+=renderCard([
            renderRowItem('Ahorro de energía','Limita actividad en segundo plano',renderToggle('ps',psMode==='power-saver')),
            renderRowItem('Protección de la batería',bprotLabel?`<span style="color:var(--blue)">${bprotLabel}</span>`:'Limita carga para alargar vida útil',renderToggle('bprot',bprot)),
            `<div id="bprot-limit-section"${bprot?'':' style="display:none"'} style="padding:2px 20px 12px">${renderSlider('cl',savedChargeLimit,50,100)}</div>`,
        ]);
    }

    // ── Today stats chips ──────────────────────────────────────────────────
    {
        const _jsDayCSV2=(d)=>d===0?7:d;
        const _todayCSV2=_jsDayCSV2(new Date().getDay());
        const todayRows2=csvData.ok?csvData.rows.filter(r=>r.day===_todayCSV2):[];
        const healthColor=health>=80?'var(--green)':health>=60?'#ff9500':'var(--red)';
        let chips=`<div class="bat-stat-chip"><span class="bat-stat-label">Salud</span><span class="bat-stat-val" style="color:${healthColor}">${health}%</span></div>`;
        if(todayRows2.length>1){
            const levels=todayRows2.map(r=>r.level);
            const todayMin=Math.min(...levels),todayMax=Math.max(...levels);
            chips+=`<div class="bat-stat-chip"><span class="bat-stat-label">Hoy</span><span class="bat-stat-val">${todayMin}%–${todayMax}%</span></div>`;
            const dischMin=todayRows2.filter(r=>r.state==='discharging').length*2;
            if(dischMin>0){
                const dh=Math.floor(dischMin/60),dm=dischMin%60;
                chips+=`<div class="bat-stat-chip"><span class="bat-stat-label">En uso</span><span class="bat-stat-val">${dh>0?dh+'h ':''} ${dm>0?dm+'m':''}</span></div>`;
            }
        }
        if(ef>0&&efd>0) chips+=`<div class="bat-stat-chip"><span class="bat-stat-label">Capacidad</span><span class="bat-stat-val">${Math.min(ef,efd).toFixed(0)} Wh</span></div>`;
        h+=`<div class="bat-stats-row">${chips}</div>`;
    }

    // Chart — prefer CSV (per-minute, normalized) over hourly history
    {
        const _jsDayToCSV=(d)=>d===0?7:d;
        const _todayCSV=_jsDayToCSV(new Date().getDay());
        const todayRows=csvData.ok?csvData.rows.filter(r=>r.day===_todayCSV):[];

        const _r=document.documentElement;
        const _dark=_r.classList.contains('dark-mode')||(!_r.classList.contains('light-mode')&&window.matchMedia('(prefers-color-scheme:dark)').matches);
        const _c={
            charge:'#30CF00',
            discharge:_dark?'#5A5A5A':'#D0D0D0',
            full:'#0a84ff',
            powerSaver:_dark?'#4FDFFF':'#7BE7FF',
            estimated:_dark?'#4A4A4A':'#CBCBCB',
            tx:_dark?'#FFFFFF':'#000000',
            label:_dark?'rgba(255,255,255,0.45)':'rgba(0,0,0,0.4)',
            labelFaint:_dark?'rgba(255,255,255,0.25)':'rgba(0,0,0,0.25)',
            line80:_dark?'rgba(255,255,255,0.18)':'rgba(0,0,0,0.13)',
        };

        // Prediction label (energy_rate based)
        const erate2=parseFloat((bat.energy_rate||'0').split(' ')[0].replace(',','.'))||0;
        const ef2=parseFloat((bat.energy_full||'0').split(' ')[0].replace(',','.'))||1;
        let predLabel='';
        if(erate2>0&&!isCharging){
            const hoursLeft=ef2*(pct/100)/erate2;
            const hInt=Math.floor(hoursLeft),mInt=Math.round((hoursLeft-hInt)*60);
            predLabel=hInt>0?`~${hInt}h${mInt>0?` ${mInt}m`:''} restante`:`~${mInt}m restante`;
        } else if(erate2>0&&isCharging&&pct<chargeLimit){
            const remaining=ef2*((chargeLimit/100)-(pct/100));
            const hoursToLimit=remaining/erate2;
            const hInt=Math.floor(hoursToLimit),mInt=Math.round((hoursToLimit-hInt)*60);
            predLabel=`~${hInt>0?`${hInt}h `:''} ${mInt>0?`${mInt}m`:''} hasta ${chargeLimit}%`;
        }
        const predColor=isCharging?_c.charge:'#8899FF';

        const CHART_H=190;
        // Helper: compute 80% reference line position within normalized range
        const refLine=(minV,maxV)=>{
            if(80<=minV||80>=maxV)return'';
            const pos=Math.round((1-(80-minV)/(maxV-minV))*100);
            // Label on the right only when far enough from top/bottom ticks (>12% gap)
            const labelRight=pos>12&&pos<88
                ?`<div style="position:absolute;right:0;top:${pos}%;transform:translateY(-50%);font-size:10px;color:${_c.label}">80%</div>`:'';
            return`<div style="position:absolute;left:0;right:${labelRight?'28px':'0'};top:${pos}%;height:1.5px;background:${_c.line80};pointer-events:none"></div>${labelRight}`;
        };

        if(todayRows.length>0){
            // ── CSV chart (per-minute, normalized, wider bars) ──
            const maxBars=50;
            const step=Math.max(1,Math.floor(todayRows.length/maxBars));
            const sampled=todayRows.filter((_,i)=>i%step===0||i===todayRows.length-1);
            const levels=sampled.map(r=>r.level);
            const minL=Math.max(0,Math.min(...levels)-3);
            const maxL=Math.min(100,Math.max(...levels)+2);
            const norm=(v)=>Math.max(3,Math.round(((v-minL)/(maxL-minL||1))*96));
            let bars='';
            sampled.forEach((r,i)=>{
                const s=r.state.toLowerCase();
                const isLast=i===sampled.length-1;
                const c=s==='charging'?_c.charge:s==='full'?_c.full:_c.discharge;
                const hPct=norm(r.level);
                const outline=isLast?`outline:2px solid ${c};outline-offset:2px;`:'';
                const pW=r.power_uw?(r.power_uw/1e6).toFixed(1)+'W':'';
                bars+=`<div class="bat-bar" style="flex:1;min-width:4px;max-width:20px;height:${hPct}%;background:${c};border-radius:5px 5px 2px 2px;${outline}" data-tip="${String(r.h).padStart(2,'0')}:${String(r.m).padStart(2,'0')} · ${r.level}%${r.state==='charging'?' ⚡':''}${pW?' · '+pW:''}"></div>`;
            });
            // x-axis: first, mid, last sample times
            const tFmt=(r)=>`${String(r.h).padStart(2,'0')}:${String(r.m).padStart(2,'0')}`;
            const midRow=sampled[Math.floor(sampled.length/2)];
            const xLabels=`
                <span style="position:absolute;left:0;font-size:10px;color:${_c.label}">${tFmt(sampled[0])}</span>
                <span style="position:absolute;left:50%;transform:translateX(-50%);font-size:10px;color:${_c.label}">${tFmt(midRow)}</span>
                <span style="position:absolute;right:28px;font-size:10px;color:${_c.label}">Ahora</span>`;
            const tickTop=`<div style="position:absolute;right:0;top:0;font-size:10px;color:${_c.label}">${maxL}%</div>`;
            const tickBot=`<div style="position:absolute;right:0;bottom:0;font-size:10px;color:${_c.labelFaint}">${minL}%</div>`;
            h+=`<div class="bat-chart">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
                    <span class="chart-title" style="color:${_c.tx}">Hoy · ${todayRows.length} registros</span>
                </div>
                <div style="position:relative;padding-right:28px">
                    <div style="display:flex;align-items:flex-end;height:${CHART_H}px;gap:3px">${bars}</div>
                    ${tickTop}${tickBot}${refLine(minL,maxL)}
                </div>
                <div style="position:relative;height:18px;margin-top:4px;padding-right:28px">${xLabels}</div>
                <div class="bat-chart-legend" style="margin-top:6px">
                    <span><span class="chart-legend-dot" style="background:${_c.discharge}"></span>Nivel de la batería</span>
                    <span><span class="chart-legend-dot" style="background:${_c.charge}"></span>Cargando</span>
                    <span><span class="chart-legend-dot" style="background:${_c.full}"></span>Completa</span>
                </div>
            </div>`;
        } else {
            // ── History fallback (hourly buckets, normalized) ──
            const HOURS=24, BUCKET=3600;
            const nowTs=Math.floor(Date.now()/1000);
            const buckets=Array.from({length:HOURS},(_,i)=>({
                t:nowTs-(HOURS-1-i)*BUCKET, pSum:0, n:0, charging:0, powerSaver:0, known:false
            }));
            hist.forEach(r=>{
                const age=(nowTs-r.t)/BUCKET;
                const bi=Math.floor(HOURS-1-age);
                if(bi>=0&&bi<HOURS){
                    buckets[bi].pSum+=r.p; buckets[bi].n++;
                    buckets[bi].known=true;
                    if(r.s==='charging')buckets[bi].charging++;
                    if(r.ps)buckets[bi].powerSaver++;
                }
            });
            buckets[HOURS-1].pSum=pct; buckets[HOURS-1].n=1; buckets[HOURS-1].known=true;
            if(bat.state==='charging') buckets[HOURS-1].charging=1;
            if(psMode==='power-saver') buckets[HOURS-1].powerSaver=1;
            const knownIdx=[];
            for(let i=0;i<HOURS;i++)if(buckets[i].known)knownIdx.push(i);
            if(knownIdx.length>=2){
                for(let k=0;k<knownIdx.length-1;k++){
                    const a=knownIdx[k],b=knownIdx[k+1];
                    const va=buckets[a].pSum/buckets[a].n,vb=buckets[b].pSum/buckets[b].n;
                    for(let i=a+1;i<b;i++){const t=(i-a)/(b-a);buckets[i].pSum=va+(vb-va)*t;buckets[i].n=1;}
                }
            } else if(knownIdx.length===1){
                const ki=knownIdx[0],kv=buckets[ki].pSum/buckets[ki].n;
                for(let i=0;i<HOURS;i++){if(!buckets[i].known){buckets[i].pSum=kv;buckets[i].n=1;}}
            }
            const avgs=buckets.map(b=>b.n>0?Math.min(100,b.pSum/b.n):null);
            const knownAvgs=avgs.filter(v=>v!==null);
            const minA=knownAvgs.length?Math.max(0,Math.min(...knownAvgs)-3):0;
            const maxA=knownAvgs.length?Math.min(100,Math.max(...knownAvgs)+2):100;
            const normH=(v)=>Math.max(3,Math.round(((v-minA)/(maxA-minA||1))*96));
            let barDivs='';
            buckets.forEach((b,i)=>{
                const avg=avgs[i]??0;
                const isChargingBar=b.charging>b.n*0.5;
                const isPsBar=b.powerSaver>b.n*0.5;
                const isCurrent=i===HOURS-1;
                let color;
                if(!b.known&&knownIdx.length<2) color=_c.estimated;
                else if(isChargingBar||(isCurrent&&isCharging)) color=_c.charge;
                else if(isPsBar||(isCurrent&&psMode==='power-saver')) color=_c.powerSaver;
                else color=_c.discharge;
                const d=new Date(b.t*1000);
                const hh=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
                const outline=isCurrent?`outline:2px solid ${color};outline-offset:2px;`:'';
                barDivs+=`<div style="flex:1" title="${hh} — ${Math.round(avg)}%">
                    <div style="height:${normH(avg)}%;background:${color};border-radius:5px 5px 2px 2px;${outline}transition:height .4s ease;width:100%"></div>
                </div>`;
            });
            const tickTop=`<div style="position:absolute;right:0;top:0;font-size:10px;color:${_c.label}">${maxA}%</div>`;
            const tickBot=`<div style="position:absolute;right:0;bottom:0;font-size:10px;color:${_c.labelFaint}">${minA}%</div>`;
            const labelIndices=[0,4,8,12,16,20,HOURS-1];
            const xLabels=labelIndices.map(hi=>{
                const d=new Date(buckets[hi].t*1000);
                const label=hi===HOURS-1?'Ahora':d.getHours().toString();
                const xPct=(hi/(HOURS-1)*100).toFixed(1);
                return`<span style="position:absolute;left:${xPct}%;transform:translateX(-50%);font-size:10px;color:${_c.label};white-space:nowrap">${label}</span>`;
            }).join('');
            h+=`<div class="bat-chart">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
                    <span class="chart-title" style="color:${_c.tx}">Hoy</span>
                </div>
                <div style="position:relative;height:${CHART_H}px;padding-right:30px">
                    <div style="display:flex;align-items:flex-end;height:100%;gap:3px">${barDivs}</div>
                    ${tickTop}${tickBot}${refLine(minA,maxA)}
                </div>
                <div style="position:relative;height:18px;margin-top:4px;padding-right:30px">${xLabels}</div>
                <div class="bat-chart-legend" style="margin-top:6px">
                    <span><span class="chart-legend-dot" style="background:${_c.discharge}"></span>Nivel de la batería</span>
                    <span><span class="chart-legend-dot" style="background:${_c.estimated}"></span>Nivel de batería estimado</span>
                    <span><span class="chart-legend-dot" style="background:${_c.charge}"></span>Cargando</span>
                    <span><span class="chart-legend-dot" style="background:${_c.powerSaver}"></span>Ahorro de energía</span>
                </div>
            </div>`;
        }
    }

    // Per-app power usage — icon + name + % right-aligned
    {
        const allApps=appUsage.filter(a=>(parseFloat(a.cpu)||0)>0||(parseFloat(a.mem)||0)>0);
        const userApps=allApps.filter(a=>!a.is_system);
        // ||0 en cada item para que NaN no contamine la suma (NaN||1 = 1 → porcentajes rotos)
        const totalCpuAll=allApps.reduce((s,a)=>s+(parseFloat(a.cpu)||0),0)||1;
        if(allApps.length){
            const mkAppRow=(a)=>{
                const cpu=parseFloat(a.cpu)||0;
                const sharePct=Math.min(100,cpu/totalCpuAll*100);
                const iconHtml=a.icon?`<img src="asset://localhost${a.icon}" width="32" height="32" style="border-radius:10px;object-fit:contain" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`:'';
                const fallbackHtml=`<span class="bat-app-icon-fallback" style="width:32px;height:32px;font-size:11px;${a.icon?'display:none':''}">${a.name.slice(0,2).toUpperCase()}</span>`;
                const rightLabel=`${sharePct.toFixed(1).replace('.',',')}%`;
                return`<div class="bat-app-item" style="padding:12px 20px">
                    <div class="bat-app-icon-wrap" style="width:32px;height:32px;flex-shrink:0">${iconHtml}${fallbackHtml}</div>
                    <span class="bat-app-name" style="flex:1;padding:0 12px;font-size:14px">${esc(a.name)}</span>
                    <span style="font-size:14px;font-weight:500;color:var(--tx2);min-width:52px;text-align:right">${rightLabel}</span>
                </div>`;
            };
            const renderAppList=(list,id='bat-app-list')=>{
                const top=list.slice(0,6);
                if(!top.length)return`<div class="detail-card" id="${id}"><div style="padding:14px 20px;color:var(--tx2);font-size:13px">Sin actividad significativa</div></div>`;
                return`<div class="detail-card" id="${id}">${top.map(mkAppRow).join('')}
                    <div style="padding:12px;text-align:center;border-top:1px solid var(--div)">
                        <span id="bat-sys-toggle" style="font-size:13px;font-weight:500;color:var(--blue);cursor:pointer">Ver detalles</span>
                    </div>
                </div>`;
            };
            const totalSharePct=Math.min(100,userApps.slice(0,6).reduce((s,a)=>s+(parseFloat(a.cpu)||0)/totalCpuAll*100,0));
            h+=`<div style="font-size:13px;font-weight:600;color:var(--tx2);margin:18px 0 8px;padding:0 4px">Uso de la batería: ${totalSharePct.toFixed(0)}%</div>`;
            h+=renderAppList(userApps);
        }
    }

    // Ajustes adicionales al fondo (atenuar + porcentaje)
    h+=renderCard([
        renderRowItem('Atenuar pantalla automáticamente','Atenúa cuando la batería es baja',renderToggle('dim-low',dimlow)),
        renderRowItem('Mostrar porcentaje batería','En el widget de batería',renderToggle('show-pct',showpct)),
        renderInfoItem('Información de la batería',`Capacidad: ${Math.min(ef,efd).toFixed(1)} / ${efd.toFixed(1)} Wh · Salud: ${health}%`),
    ]);

    // ── USB-C charging speed indicator ──
    if(chargingInfo.ok && (chargingInfo.charging || chargingInfo.ac_online)){
        const pW=(chargingInfo.power_uw/1e6).toFixed(1);
        const vV=(chargingInfo.voltage_uv/1e6).toFixed(1);
        const iA=(chargingInfo.current_ua/1e6).toFixed(2);
        const adapter=chargingInfo.adapter_w>0?`${chargingInfo.adapter_w}W`:'';
        const pd=chargingInfo.pd_rev?`USB-PD ${chargingInfo.pd_rev}`:(chargingInfo.op_mode||'');
        const speedLabel=chargingInfo.charging?
            `${pW} W · ${vV}V @ ${iA}A`:
            (chargingInfo.ac_online?'Conectado':'Desconectado');
        const speedColor=chargingInfo.power_uw>30e6?'var(--green)':
                         chargingInfo.power_uw>15e6?'var(--blue)':
                         chargingInfo.power_uw>0?'var(--orange)':'var(--tx2)';
        h+=renderSection('Carga USB-C');
        h+=renderCard([
            `<div class="detail-item"><div class="detail-texts"><span class="dt">Potencia actual</span><span class="ds" style="color:${speedColor};font-weight:600">${speedLabel}</span></div></div>`,
            pd?`<div class="detail-item"><span class="dt">Protocolo</span><span class="ds">${esc(pd)}${adapter?' · '+adapter:''}</span></div>`:'',
        ].filter(Boolean));
    }

    // ── Gráfica térmica ──
    if(thermalData.ok && thermalData.rows.length>10){
        const rows=thermalData.rows.slice(-180); // últimos 6 min @ 2s
        const maxT=Math.max(...rows.map(r=>Math.max(r.cpu_pkg,r.cpu_core,r.nvme,r.wifi)),60);
        const minT=Math.min(...rows.map(r=>Math.min(r.cpu_pkg||200,r.cpu_core||200)),30);
        const H=80, W=rows.length;
        const scale=(v)=>H-Math.max(0,Math.min(H,((v-minT)/(maxT-minT))*H));
        const line=(key,color)=>{
            const pts=rows.map((r,i)=>`${(i/(W-1))*100}%,${scale(r[key]||minT).toFixed(1)}`).join(' ');
            return `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}" vector-effect="non-scaling-stroke"/>`;
        };
        const lastPkg=rows[rows.length-1].cpu_pkg;
        const lastFan=rows[rows.length-1].fan;
        const lastProf=rows[rows.length-1].profile;
        h+=renderSection('Térmica (últimos 6 min)');
        h+=`<div class="bat-chart" style="padding:14px 16px">
            <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--tx2);margin-bottom:6px">
                <span>CPU: <strong style="color:var(--tx)">${lastPkg}°C</strong></span>
                <span>${lastFan>0?`Fan ${lastFan} RPM · `:''}Perfil: ${esc(lastProf||'—')}</span>
            </div>
            <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" style="width:100%;height:${H}px;display:block;background:var(--sbg);border-radius:8px">
                ${line('cpu_pkg','#ff6b6b')}
                ${line('cpu_core','#ffa94d')}
                ${line('nvme','#4dabf7')}
                ${line('wifi','#51cf66')}
            </svg>
            <div class="bat-chart-legend" style="margin-top:6px;font-size:11px">
                <span><span class="chart-legend-dot" style="background:#ff6b6b"></span>CPU pkg</span>
                <span><span class="chart-legend-dot" style="background:#ffa94d"></span>CPU core</span>
                <span><span class="chart-legend-dot" style="background:#4dabf7"></span>NVMe</span>
                <span><span class="chart-legend-dot" style="background:#51cf66"></span>WiFi</span>
                <span style="color:var(--tx2)">· ${minT}°–${maxT}°C</span>
            </div>
        </div>`;
    }

    // ── Carga adaptativa (BookOS CSV system) ──
    {
        const days=['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
        const jsDayToCSV=(d)=>d===0?7:d; // JS: 0=Sun…6=Sat → CSV: 1=Mon…7=Sun
        const todayCSV=jsDayToCSV(new Date().getDay());

        // Adaptive charging toggle + current threshold
        const adaptiveLabel=adaptiveEnabled?(chargeLimit<100?`Activa — límite ${chargeLimit}%`:'Activa — carga completa'):'Inactiva';
        const umbralText=chargeLimit<100?`${chargeLimit}% (protección activa)`:'100% (sin límite)';
        h+=renderSection('Carga adaptativa')+renderCard([
            renderRowItem('Carga adaptativa',`<span style="color:var(--${adaptiveEnabled?'blue':'tx2'})">${adaptiveLabel}</span>`,renderToggle('adaptive-charging',adaptiveEnabled)),
            `<div class="detail-item"><span class="dt">Umbral actual</span><span class="ds" id="umbral-val">${umbralText}</span></div>`,
        ]);

        // Predictions per weekday
        if(adaptivePreds.ok&&adaptivePreds.predictions.length>0){
            const predsMap=new Map(adaptivePreds.predictions.map(p=>[p.day,p]));
            let predRows='';
            for(let d=1;d<=7;d++){
                const p=predsMap.get(d);
                const isToday=d===todayCSV;
                const label=p?`${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')} <span style="font-size:11px;color:var(--tx2)">(${p.samples} datos)</span>`:'<span style="color:var(--tx2)">Sin datos</span>';
                predRows+=`<div class="detail-item" style="padding:10px 20px;display:flex;justify-content:space-between;align-items:center${isToday?';background:var(--hov)':''}">
                    <span style="font-size:14px${isToday?';font-weight:600':''}">${days[d-1]}${isToday?' <span style="font-size:11px;color:var(--blue)">hoy</span>':''}</span>
                    <span style="font-size:14px">${label}</span>
                </div>`;
            }
            h+=`<div style="font-size:12px;color:var(--tx2);margin:4px 0 6px;padding:0 4px">Hora predicha de desconexión por día</div>`;
            h+=`<div class="detail-card">${predRows}</div>`;
        } else if(csvData.ok){
            h+=`<div style="font-size:13px;color:var(--tx2);padding:8px 4px">Necesita más datos para predecir patrones (mínimo 1 desconexión por día).</div>`;
        }
    }

    // Performance mode — shown when power-profiles-daemon is available (generic Linux)
    if(gb.perf_supported){
        const rawPm=gb.performance_mode||'balanced';
        // Samsung platform-profile values → internal card keys
        const pm={'low-power':'ahorro','quiet':'power-saver','balanced':'balanced','performance':'performance'}[rawPm]||rawPm;
        const perfIcons={'ahorro':'./assets/power-saver.svg','power-saver':'./assets/power-saver.svg','balanced':'./assets/optimized.svg','performance':'./assets/performance.svg'};
        const perfNames={'ahorro':'Ahorro extremo','power-saver':'Silencioso','balanced':'Optimizado','performance':'Rendimiento'};
        const perfDescs={'ahorro':'Mínimo consumo','power-saver':'Ahorra batería','balanced':'Equilibrado','performance':'Máximo poder'};
        const modes=['ahorro','power-saver','balanced','performance'];
        h+=renderSection('Modo de rendimiento')+`<div class="perf-modes">${modes.map(m=>`<div class="perf-mode-card ${pm===m?'active':''}" data-mode="${m}"><div class="perf-mode-icon"><img src="${perfIcons[m]}" width="32" height="32" class="perf-icon-img"></div><div class="perf-mode-name">${perfNames[m]}</div><div class="perf-mode-desc">${perfDescs[m]}</div></div>`).join('')}</div>`;
    }
    h+=`</div>`; // cierre bat-page-wrap
    c.innerHTML=h;

    // System process toggle (same mkAppRow as above)
    {
        let showingSys=false;
        const allApps2=appUsage.filter(a=>(parseFloat(a.cpu)||0)>0||(parseFloat(a.mem)||0)>0);
        const userApps2=allApps2.filter(a=>!a.is_system);
        const totalCpuAll2=allApps2.reduce((s,a)=>s+(parseFloat(a.cpu)||0),0)||1;
        const mkAppRow2=(a)=>{
            const cpu=parseFloat(a.cpu)||0;
            const sharePct2=Math.min(100,cpu/totalCpuAll2*100);
            const iconHtml=a.icon?`<img src="asset://localhost${a.icon}" width="32" height="32" style="border-radius:10px;object-fit:contain" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`:'';
            const fallbackHtml=`<span class="bat-app-icon-fallback" style="width:32px;height:32px;font-size:11px;${a.icon?'display:none':''}">${a.name.slice(0,2).toUpperCase()}</span>`;
            const rightLabel=`${sharePct2.toFixed(1).replace('.',',')}%`;
            return`<div class="bat-app-item" style="padding:12px 20px">
                <div class="bat-app-icon-wrap" style="width:32px;height:32px;flex-shrink:0">${iconHtml}${fallbackHtml}</div>
                <span class="bat-app-name" style="flex:1;padding:0 12px;font-size:14px">${esc(a.name)}</span>
                <span style="font-size:14px;font-weight:500;color:var(--tx2);min-width:52px;text-align:right">${rightLabel}</span>
            </div>`;
        };
        document.getElementById('bat-sys-toggle')?.addEventListener('click',function(){
            showingSys=!showingSys;
            this.textContent=showingSys?'Ver menos':'Ver detalles';
            const card=document.getElementById('bat-app-list');
            if(card){
                const list=showingSys?allApps2:userApps2;
                const items=list.slice(0,6).map(mkAppRow2).join('');
                // keep the "Ver detalles" footer row
                const footer=card.querySelector('[style*="text-align:center"]');
                card.innerHTML=items+(footer?footer.outerHTML:`<div style="padding:12px;text-align:center;border-top:1px solid var(--div)"><span id="bat-sys-toggle" style="font-size:13px;font-weight:500;color:var(--blue);cursor:pointer">${showingSys?'Ver menos':'Ver detalles'}</span></div>`);
                document.getElementById('bat-sys-toggle')?.addEventListener('click',arguments.callee);
            }
        });
    }

    setupToggle('ps',async a=>{
        const m=a?'power-saver':'balanced';
        const modoTermico=a?'silencioso':'optimizado';
        setSetting('PowerSaver',m);
        let ok=false;
        try{await tauriInvoke('set_performance_mode',{mode:m});_icInvalidate('check_hw_features');ok=true;}catch(e){}
        try{await tauriInvoke('aplicar_perfil_termico',{modo:modoTermico});}catch(e){}
        toast(a?'Ahorro de energía activado':'Rendimiento normal', ok?'✓':'⚠');
    });
    setupToggle('bprot',async a=>{
        const section=document.getElementById('bprot-limit-section');
        if(section)section.style.display=a?'':'none';
        const currentLimit=parseInt(document.getElementById('cl')?.value)||80;
        // Sync umbral text to match bprot state
        const umbral=document.getElementById('umbral-val');
        if(umbral)umbral.textContent=a&&currentLimit<100?`${currentLimit}% (protección activa)`:'100% (sin límite)';
        // await the writes so they complete before the user can close the app
        await Promise.all([
            setSetting('BatteryProtection',a?'true':'false'),
            setSetting('ChargeLimit',String(currentLimit)),
        ]);
        if(a){
            try{
                const r=JSON.parse(await tauriInvoke('set_charge_limit',{limit:currentLimit}));
                toast(r.ok?`Protección activa: hasta el ${currentLimit}%`:`Guardado (hardware: ${r.error})`,'✓');
            }catch(e){toast('Protección guardada (se aplica al iniciar)','⚠');}
        } else {
            try{await tauriInvoke('set_charge_limit',{limit:100});}catch(e){}
            toast('Carga ilimitada');
        }
    });
    setupToggle('dim-low',async a=>{setSetting('DimLowBattery',a?'true':'false');toast(a?'Atenuación automática activada':'Atenuación automática desactivada');});
    setupToggle('show-pct',async a=>{
        setSetting('ShowBatteryPercent',a?'true':'false');
        // Notify applet via IPC state so it reacts immediately
        const curProfile=document.querySelector('.perf-mode-card.active')?.dataset?.mode||'balanced';
        const savedLim=parseInt(await getSetting('ChargeLimit','80').catch(()=>'80'))||80;
        const state=JSON.stringify({power_profile:curProfile,charge_limit:savedLim,show_percent:a,source:'settings',ts:Date.now()});
        tauriInvoke('write_ipc_state',{state}).catch(()=>{});
        toast(a?'Porcentaje visible en el widget':'Porcentaje oculto en el widget');
    });

    document.querySelectorAll('.perf-mode-card').forEach(b=>{b.addEventListener('click',async()=>{
        const mode=b.dataset.mode;
        const modoTermico={'ahorro':'ahorro','power-saver':'silencioso','balanced':'optimizado','performance':'rendimiento'}[mode]||'optimizado';
        try{await tauriInvoke('set_performance_mode',{mode})}catch(e){}
        try{
            const res=await tauriInvoke('aplicar_perfil_termico',{modo:modoTermico});
            toast(`${b.querySelector('.perf-mode-name')?.textContent}: ${res}`);
        }catch(e){
            toast(`Modo activado (${e})`,'⚠️');
        }
        document.querySelectorAll('.perf-mode-card').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        // Notifica al applet de batería via IPC
        const savedLim=parseInt(await getSetting('ChargeLimit','80').catch(()=>'80'))||80;
        _emitIpcState(mode,savedLim);
    });});
    if(gb.charge_limit_supported){
        setupSlider('cl',async v=>{
            const lim=parseInt(v);
            // Keep umbral text in sync while dragging
            const umbral=document.getElementById('umbral-val');
            if(umbral)umbral.textContent=lim<100?`${lim}% (protección activa)`:'100% (sin límite)';
            try{
                const [r] = await Promise.all([
                    tauriInvoke('set_charge_limit',{limit:lim}).then(JSON.parse),
                    setSetting('ChargeLimit',String(lim)),
                ]);
                if(r.ok)toast(`Límite de carga: ${lim}%`,'🔋');
                else toast(`No se pudo aplicar límite (${r.error||'error'})`, '❌');
                // Notifica al applet vía IPC
                const curProfile=document.querySelector('.perf-mode-card.active')?.dataset?.mode||'balanced';
                _emitIpcState(curProfile,lim);
            }catch(e){toast('Error al aplicar límite de carga','❌');}
        });
    }

    setupToggle('adaptive-charging',async a=>{
        if(a){
            // Show info popup before enabling
            const toggle=document.querySelector('[data-toggle="adaptive-charging"]');
            // Revert toggle visually while dialog is open
            toggle?.classList.remove('active');
            showDialog(
                'Activar carga adaptativa',
                `<p style="margin:0 0 10px">La carga adaptativa aprende cuándo usas el equipo y detiene la carga antes de que llegue al 100%, completándola justo a tiempo.</p><p style="margin:0;font-size:12px;opacity:0.6">Se usará el límite de protección configurado como umbral de parada. Para obtener mejores predicciones, deja el equipo enchufado durante la noche.</p>`,
                {
                    confirmText:'Activar',
                    onConfirm:async()=>{
                        toggle?.classList.add('active');
                        setSetting('AdaptiveCharging','true');
                        try{await tauriInvoke('set_adaptive_charging',{enabled:true});}catch(e){}
                        toast('Carga adaptativa activada','🔋');
                    },
                    onCancel:()=>{}
                }
            );
        } else {
            setSetting('AdaptiveCharging','false');
            try{await tauriInvoke('set_adaptive_charging',{enabled:false});}catch(e){}
            toast('Carga adaptativa desactivada');
        }
    });
    // ── Chart bar tooltip ────────────────────────────────────────────────
    {
        const tip=document.createElement('div');
        tip.className='bat-bar-tip';
        document.body.appendChild(tip);
        const showTip=(e)=>{
            const bar=e.target.closest('.bat-bar');
            if(!bar){tip.style.display='none';return;}
            tip.textContent=bar.dataset.tip||'';
            tip.style.display='block';
            const r=bar.getBoundingClientRect();
            const tx=r.left+r.width/2-tip.offsetWidth/2;
            const ty=r.top-tip.offsetHeight-6+window.scrollY;
            tip.style.left=Math.max(4,tx)+'px';
            tip.style.top=ty+'px';
        };
        const hideTip=()=>{tip.style.display='none';};
        document.querySelectorAll('.bat-bar').forEach(b=>{
            b.addEventListener('mouseenter',showTip);
            b.addEventListener('mouseleave',hideTip);
        });
        // Clean up tooltip when page changes
        if(!window._pageIntervals)window._pageIntervals=[];
        window._pageIntervals.push(setInterval(()=>{if(!document.querySelector('.bat-bar')){tip.remove();hideTip();}},2000));
    }
} // end _renderBateriaContent

// ════════════════════════════════════════════════════════════════════════
// ── Notificaciones ─────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderNotificaciones(c){
    c.innerHTML=renderHeader('Notificaciones')+renderSkeleton(2);

    let dnd=false,snd=true,onLock=true,popups=true;
    try{
        [dnd,snd,onLock,popups]=await Promise.all([
            tauriInvoke('get_dnd_status').then(r=>JSON.parse(r).dnd_active).catch(()=>false),
            tauriInvoke('run_command',{cmd:'kreadconfig6',args:['--file','plasmanotifyrc','--group','Notifications','--key','Sound','--default','true']}).then(v=>v.trim()!=='false').catch(()=>true),
            tauriInvoke('run_command',{cmd:'kreadconfig6',args:['--file','plasmanotifyrc','--group','Notifications','--key','PopupOnLockScreen','--default','true']}).then(v=>v.trim()!=='false').catch(()=>true),
            tauriInvoke('run_command',{cmd:'kreadconfig6',args:['--file','plasmanotifyrc','--group','Notifications','--key','PopupCriticalOnly','--default','false']}).then(v=>v.trim()!=='true').catch(()=>true),
        ]);
    }catch(e){}

    let h=renderHeader('Notificaciones');
    h+=renderSection('General');
    h+=renderCard([
        renderRowItem('No molestar',dnd?'Silencia todas las notificaciones':'Permite notificaciones',renderToggle('dnd',dnd)),
        renderRowItem('Mostrar en pantalla bloqueada','Ver notificaciones al bloquear',renderToggle('notif-lock',onLock)),
        renderRowItem('Mostrar todas las notificaciones','Desactiva para ver sólo críticas',renderToggle('notif-popups',popups)),
    ]);
    h+=renderSection('Audio');
    h+=renderCard([
        renderRowItem('Sonidos de notificación','Reproduce sonido al recibir notificaciones',renderToggle('notif-snd',snd)),
    ]);
    h+=renderSection('Historial');
    h+=renderCard([
        renderRowItem('Historial de notificaciones','Abre el historial de Plasma',`<button class="btn btn-secondary btn-sm" id="notif-hist">Abrir</button>`),
    ]);

    c.innerHTML=h;

    setupToggle('dnd',async a=>{
        try{await tauriInvoke('toggle_dnd',{enable:a});}catch(e){}
        toast(a?'No molestar activado':'No molestar desactivado');
    });
    setupToggle('notif-lock',async a=>{
        try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','plasmanotifyrc','--group','Notifications','--key','PopupOnLockScreen',a?'true':'false']});}catch(e){}
        toast(a?'Notificaciones en pantalla bloqueada activadas':'Desactivadas en bloqueo');
    });
    setupToggle('notif-popups',async a=>{
        try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','plasmanotifyrc','--group','Notifications','--key','PopupCriticalOnly',a?'false':'true']});}catch(e){}
        toast(a?'Todas las notificaciones visibles':'Sólo notificaciones críticas');
    });
    setupToggle('notif-snd',async a=>{
        try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','plasmanotifyrc','--group','Notifications','--key','Sound',a?'true':'false']});}catch(e){}
        toast(a?'Sonidos activados':'Sonidos desactivados','🔔');
    });
    document.getElementById('notif-hist')?.addEventListener('click',()=>{
        try{tauriInvoke('run_command',{cmd:'plasmawindowed',args:['org.kde.plasma.notifications']}).catch(()=>{});}catch(e){}
        toast('Abriendo historial','📋');
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Seguridad ──────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderSeguridad(c){
    c.innerHTML=renderHeader('Seguridad y privacidad')+renderSkeleton(3);

    let fw={active:false},lockTimeout=5,lockAfterSuspend=true,lockGrace=0,camOn=true,micMuted=false;
    try{
        [fw,lockTimeout,lockAfterSuspend,lockGrace,camOn,micMuted]=await Promise.all([
            tauriInvoke('get_firewall_status').then(JSON.parse).catch(()=>({active:false})),
            tauriInvoke('get_lock_timeout').then(r=>JSON.parse(r).timeout).catch(()=>5),
            tauriInvoke('run_command',{cmd:'kreadconfig6',args:['--file','kscreenlockerrc','--group','Daemon','--key','LockOnResume','--default','true']}).then(v=>v.trim()!=='false').catch(()=>true),
            tauriInvoke('run_command',{cmd:'kreadconfig6',args:['--file','kscreenlockerrc','--group','Daemon','--key','LockGracePeriod','--default','0']}).then(v=>parseInt(v)||0).catch(()=>0),
            tauriInvoke('get_camera_enabled').then(r=>JSON.parse(r).enabled).catch(()=>true),
            tauriInvoke('get_mic_muted').then(r=>JSON.parse(r).muted).catch(()=>false),
        ]);
    }catch(e){}

    const timeoutOpts=[1,2,5,10,15,30].map(m=>`<option value="${m}" ${m==lockTimeout?'selected':''}>${m} min</option>`).join('');
    const graceOpts=[0,5,10,30,60].map(s=>`<option value="${s}" ${s==lockGrace?'selected':''}>${s===0?'Inmediatamente':`${s}s`}</option>`).join('');

    let h=renderHeader('Seguridad y privacidad');
    h+=renderSection('Cortafuegos');
    h+=renderCard([
        renderRowItem('Cortafuegos (UFW)',fw.active?'Protegido':'Desactivado',renderToggle('fw',fw.active)),
    ]);
    h+=renderSection('Pantalla de bloqueo');
    h+=renderCard([
        renderRowItem('Bloquear al reanudar de suspensión','Pide contraseña al despertar',renderToggle('sec-lock-resume',lockAfterSuspend)),
        `<div class="detail-item"><span class="dt">Bloqueo automático</span><select class="sel" id="sec-lock-timeout" style="margin-top:8px">${timeoutOpts}</select></div>`,
        `<div class="detail-item"><span class="dt">Periodo de gracia</span><span class="ds">Tiempo sin pedir contraseña al despertar</span><select class="sel" id="sec-lock-grace" style="margin-top:8px">${graceOpts}</select></div>`,
    ]);
    h+=renderSection('Cámara y micrófono');
    h+=renderCard([
        renderRowItem('Cámara',camOn?'Activada':'Bloqueada a nivel del kernel',renderToggle('sec-camera',camOn)),
        renderRowItem('Micrófono',micMuted?'Silenciado en todo el sistema':'Activo',renderToggle('sec-mic',!micMuted)),
    ]);
    h+=renderSection('Privacidad');
    h+=renderCard([
        renderRowItem('Historial de actividades','Plasma registra tus archivos y apps recientes',renderToggle('sec-activity',false)),
        `<div class="detail-item" style="cursor:pointer" id="sec-clear-hist"><span class="dt" style="color:var(--red,#e53935)">Borrar historial de actividades</span></div>`,
    ]);

    c.innerHTML=h;

    setupToggle('fw',async a=>{
        const ok=await promptSudo(a?'activar el cortafuegos':'desactivar el cortafuegos','ufw',[a?'enable':'disable']);
        if(!ok){toast('Permiso denegado','❌');setTimeout(()=>renderSeguridad(c),300);return;}
        toast(a?'Cortafuegos activado':'Cortafuegos desactivado','🛡️');
    });
    setupToggle('sec-lock-resume',async a=>{
        try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','kscreenlockerrc','--group','Daemon','--key','LockOnResume',a?'true':'false']});}catch(e){}
        toast(a?'Bloqueo al reanudar activado':'Desactivado');
    });
    document.getElementById('sec-lock-timeout')?.addEventListener('change',async e=>{
        try{await tauriInvoke('set_lock_timeout',{minutes:parseInt(e.target.value)});}catch(e2){}
        toast('Tiempo de bloqueo: '+e.target.value+' min');
    });
    document.getElementById('sec-lock-grace')?.addEventListener('change',async e=>{
        try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','kscreenlockerrc','--group','Daemon','--key','LockGracePeriod',e.target.value]});}catch(e2){}
        toast('Periodo de gracia actualizado');
    });
    setupToggle('sec-camera',async a=>{
        const r=JSON.parse(await tauriInvoke('set_camera_enabled',{enable:a}));
        if(r.ok) toast(a?'Cámara activada':'Cámara bloqueada','📷');
        else { toast('Error: '+(r.error||'permiso denegado'),'❌'); renderSeguridad(c); }
    });
    setupToggle('sec-mic',async a=>{
        const r=JSON.parse(await tauriInvoke('set_mic_muted',{muted:!a}));
        if(r.ok) toast(a?'Micrófono activo':'Micrófono silenciado','🎙️');
        else renderSeguridad(c);
    });
    setupToggle('sec-activity',async a=>{
        try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','kactivitymanagerdrc','--group','Plugins','--key','org.kde.ActivityManager.ResourceScoringEnabled',a?'true':'false']});}catch(e){}
        toast(a?'Historial activado':'Historial desactivado');
    });
    document.getElementById('sec-clear-hist')?.addEventListener('click',()=>{
        showDialog('Borrar historial','Se eliminará el historial de actividades de Plasma (archivos recientes, apps usadas). No se pueden recuperar.',{
            confirmText:'Borrar',confirmClass:'danger',
            onConfirm:async()=>{
                try{await tauriInvoke('run_command',{cmd:'qdbus6',args:['org.kde.ActivityManager','/ActivityManager/Resources/Scoring','DeleteAllEntries']}).catch(()=>{});}catch(e){}
                try{await tauriInvoke('run_command',{cmd:'kactivitymanagerd',args:['--stop']}).catch(()=>{});}catch(e){}
                toast('Historial borrado','🗑️');
            }
        });
    });

    // Load actual activity-history toggle state
    try{
        const v=await tauriInvoke('run_command',{cmd:'kreadconfig6',args:['--file','kactivitymanagerdrc','--group','Plugins','--key','org.kde.ActivityManager.ResourceScoringEnabled','--default','true']});
        const tog=document.querySelector('[data-toggle="sec-activity"]');
        if(tog&&v.trim()==='true')tog.classList.add('active');
        else if(tog)tog.classList.remove('active');
    }catch(e){}
}

// ════════════════════════════════════════════════════════════════════════
// ── Temas (schedule uses actual selected themes, not hardcoded) ────────
// ════════════════════════════════════════════════════════════════════════
export async function renderTemas(c){
    c.innerHTML=renderHeader('Temas')+renderSkeleton(3);
    let theme={scheme:'',is_dark:false},themes=[],schedule={enabled:false,light_time:'07:00',dark_time:'20:00',light_theme:'BookOS Light',dark_theme:'BookOS Dark'};
    let kcsT={light:'',dark:'',is_global:false};
    try{[theme,themes,schedule,kcsT]=await Promise.all([
        tauriInvoke('get_current_theme').then(JSON.parse),
        tauriInvoke('get_available_themes').then(JSON.parse),
        tauriInvoke('get_theme_schedule').then(JSON.parse),
        tauriInvoke('get_kde_light_dark_themes').then(JSON.parse).catch(()=>({light:'',dark:'',is_global:false})),
    ]);}catch(e){}
    // Only show BookOS themes
    themes=themes.filter(t=>/^bookos/i.test(t.name));
    const dark=themes.filter(t=>t.is_dark),light=themes.filter(t=>!t.is_dark);

    const mkCard=(t,isDk)=>{
        const bg=themeColor(t.name,isDk);
        const innerCls=isDk?'dark-inner':'light-inner';
        return`<div class="theme-card-large ${t.active?'active':''}" data-s="${esc(t.name)}">
            <div class="theme-preview-large" style="background:${bg}">
                <div class="theme-preview-inner ${innerCls}">
                    <div class="tp-bar"></div>
                    <div class="tp-content"><div class="tp-line w60"></div><div class="tp-line w40"></div><div class="tp-line w75"></div></div>
                </div>
            </div>
            <div class="theme-card-footer">
                <span class="theme-name">${esc(t.name)}</span>
                <span class="theme-check">${t.active?'✓':''}</span>
            </div>
        </div>`;
    };

    c.innerHTML=renderHeader('Temas')+
        renderCard([renderRowItem('Modo oscuro',theme.is_dark?'Activado':'Desactivado',renderToggle('dm',theme.is_dark))])+
        renderSection('Cambio programado')+renderCard([
            renderRowItem('Programar tema','Cambiar automáticamente por hora',renderToggle('sched',schedule.enabled)),
            `<div class="detail-item" id="sched-opts" style="display:${schedule.enabled?'block':'none'}"><div style="display:flex;gap:10px;margin-top:8px"><div style="flex:1"><span class="ds">Claro desde</span><input type="time" id="sched-lt" value="${schedule.light_time}" class="sel" style="margin-top:4px"></div><div style="flex:1"><span class="ds">Oscuro desde</span><input type="time" id="sched-dt" value="${schedule.dark_time}" class="sel" style="margin-top:4px"></div></div><div style="display:flex;gap:10px;margin-top:8px"><div style="flex:1"><span class="ds">Tema claro</span><select id="sched-ltheme" class="sel" style="margin-top:4px">${light.map(t=>`<option value="${esc(t.name)}" ${t.name===schedule.light_theme?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div><div style="flex:1"><span class="ds">Tema oscuro</span><select id="sched-dtheme" class="sel" style="margin-top:4px">${dark.map(t=>`<option value="${esc(t.name)}" ${t.name===schedule.dark_theme?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div></div></div>`
        ])+
        renderSection('Tema')+`<div class="theme-grid-duo">${themes.map(t=>mkCard(t,t.is_dark)).join('')}</div>`;

    setupToggle('dm',async a=>{
        const name=a?(kcsT.dark||dark[0]?.name||'BookOS Dark'):(kcsT.light||light[0]?.name||'BookOS Light');
        try{await tauriInvoke('apply_kde_theme',{name,isGlobal:kcsT.is_global})}catch(e){}
        document.documentElement.className=a?'dark-mode':'light-mode';
        toast(a?'Cambiando a modo oscuro':'Cambiando a modo claro');
    });
    setupToggle('sched',async a=>{document.getElementById('sched-opts').style.display=a?'block':'none';saveSchedule(a);toast(a?'Programación activada':'Programación desactivada');});
    document.querySelectorAll('.theme-card-large').forEach(cd=>{cd.addEventListener('click',async()=>{try{await tauriInvoke('set_color_scheme',{scheme:cd.dataset.s})}catch(e){}document.documentElement.className=cd.dataset.s.toLowerCase().includes('dark')?'dark-mode':'light-mode';document.querySelectorAll('.theme-card-large').forEach(x=>{x.classList.remove('active');x.querySelector('.theme-check').textContent='';});cd.classList.add('active');cd.querySelector('.theme-check').textContent='✓';toast('Tema aplicado: '+cd.dataset.s);});});
    ['sched-lt','sched-dt','sched-ltheme','sched-dtheme'].forEach(id=>{document.getElementById(id)?.addEventListener('change',()=>saveSchedule(true));});
}
async function saveSchedule(enabled){
    const lt=document.getElementById('sched-lt')?.value||'07:00';
    const dt=document.getElementById('sched-dt')?.value||'20:00';
    const ltheme=document.getElementById('sched-ltheme')?.value||'BreezeLight';
    const dtheme=document.getElementById('sched-dtheme')?.value||'BreezeDark';
    try{await tauriInvoke('set_theme_schedule',{enabled,light_time:lt,dark_time:dt,light_theme:ltheme,dark_theme:dtheme});}catch(e){}
}

// Fingerprint idle animation — reveals blue rings from center outward
function _startFpIdleAnim(){
    const svg=document.getElementById('fp-svg-main');
    if(!svg)return;
    const blueRings=[...svg.querySelectorAll('.fp-zone')].reverse(); // innermost first
    // Start all blue rings hidden
    blueRings.forEach(r=>{r.style.opacity='0';r.style.transition='none';});
    // Reveal from center outward with stagger
    blueRings.forEach((r,i)=>{
        setTimeout(()=>{
            r.style.transition='opacity 0.4s ease-out';
            r.style.opacity='1';
        }, 300 + i*100);
    });
}

export async function renderBloqueo(c){
    c.innerHTML=renderHeader('Pantalla de bloqueo')+renderSkeleton(3);
    let timeout=5,fp={available:false,enrolled:false},aod=false,sddmCfg={variant:'dark',background:'solid',bgImage:''},userInfo={display_name:'',has_avatar:false,avatar_path:''},bookBarEnabled=true;
    try{[timeout,fp,aod,sddmCfg,userInfo,bookBarEnabled]=await Promise.all([
        tauriInvoke('get_lock_timeout').then(r=>JSON.parse(r).timeout).catch(()=>5),
        tauriInvoke('check_fingerprint').then(JSON.parse).catch(()=>({available:false,enrolled:false})),
        getSetting('AOD','false').then(v=>v==='true'),
        tauriInvoke('get_sddm_config').then(JSON.parse).catch(()=>({variant:'dark',background:'solid',bgImage:''})),
        tauriInvoke('get_user_info').then(JSON.parse).catch(()=>({display_name:'',has_avatar:false,avatar_path:''})),
        getSetting('BookBarEnabled','true').then(v=>v!=='false')
    ]);}catch(e){}

    // Fingerprint SVG — dual-layer: grey base + blue overlay (opacity-controlled)
    const enrolled=fp.enrolled;
    const fpSvg=`<svg viewBox="0 0 200 260" width="170" height="220" id="fp-svg-main" class="fp-svg-main">
        <!-- Grey base ridges (always visible) -->
        <g class="fp-base-group">
            <ellipse cx="100" cy="130" rx="88" ry="110" fill="none" stroke="var(--fp-grey,#3a3a3c)" stroke-width="2.5" stroke-dasharray="30 9 22 8 16 7 10 6" transform="rotate(-8 100 130)" class="fp-base"/>
            <ellipse cx="100" cy="130" rx="76" ry="96"  fill="none" stroke="var(--fp-grey,#3a3a3c)" stroke-width="2.5" stroke-dasharray="26 8 20 7 13 6 8 5"  transform="rotate(-5 100 130)" class="fp-base"/>
            <ellipse cx="100" cy="130" rx="64" ry="82"  fill="none" stroke="var(--fp-grey,#3a3a3c)" stroke-width="2.5" stroke-dasharray="23 8 17 6 12 5 7 5"  transform="rotate(-3 100 130)" class="fp-base"/>
            <ellipse cx="100" cy="130" rx="52" ry="68"  fill="none" stroke="var(--fp-grey,#3a3a3c)" stroke-width="2.5" stroke-dasharray="20 7 15 6 10 5"       transform="rotate(-1 100 130)" class="fp-base"/>
            <ellipse cx="100" cy="130" rx="41" ry="54"  fill="none" stroke="var(--fp-grey,#3a3a3c)" stroke-width="2.5" stroke-dasharray="17 6 13 5 8 4"        transform="rotate(1 100 130)"  class="fp-base"/>
            <ellipse cx="100" cy="130" rx="31" ry="41"  fill="none" stroke="var(--fp-grey,#3a3a3c)" stroke-width="2.5" stroke-dasharray="15 6 11 4 7 4"        transform="rotate(3 100 130)"  class="fp-base"/>
            <ellipse cx="100" cy="130" rx="22" ry="29"  fill="none" stroke="var(--fp-grey,#3a3a3c)" stroke-width="2.5" stroke-dasharray="13 5 9 4"             transform="rotate(5 100 130)"  class="fp-base"/>
            <ellipse cx="100" cy="130" rx="14" ry="18"  fill="none" stroke="var(--fp-grey,#3a3a3c)" stroke-width="2.5" stroke-dasharray="10 4 7 3"             transform="rotate(7 100 130)"  class="fp-base"/>
            <ellipse cx="100" cy="130" rx="7"  ry="9"   fill="none" stroke="var(--fp-grey,#3a3a3c)" stroke-width="2.5" stroke-dasharray="8 3"                  transform="rotate(9 100 130)"  class="fp-base"/>
            <ellipse cx="100" cy="131" rx="2"  ry="3"   fill="var(--fp-grey,#3a3a3c)" class="fp-base"/>
        </g>
        <!-- Blue overlay ridges (opacity-controlled by JS) -->
        <g class="fp-zone-group">
            <ellipse cx="100" cy="130" rx="88" ry="110" fill="none" stroke="var(--fp-blue,#0A58CA)" stroke-width="2.8" stroke-dasharray="30 9 22 8 16 7 10 6" transform="rotate(-8 100 130)" class="fp-zone" style="opacity:0"/>
            <ellipse cx="100" cy="130" rx="76" ry="96"  fill="none" stroke="var(--fp-blue,#0A58CA)" stroke-width="2.8" stroke-dasharray="26 8 20 7 13 6 8 5"  transform="rotate(-5 100 130)" class="fp-zone" style="opacity:0"/>
            <ellipse cx="100" cy="130" rx="64" ry="82"  fill="none" stroke="var(--fp-blue,#0A58CA)" stroke-width="2.8" stroke-dasharray="23 8 17 6 12 5 7 5"  transform="rotate(-3 100 130)" class="fp-zone" style="opacity:0"/>
            <ellipse cx="100" cy="130" rx="52" ry="68"  fill="none" stroke="var(--fp-blue,#0A58CA)" stroke-width="2.8" stroke-dasharray="20 7 15 6 10 5"       transform="rotate(-1 100 130)" class="fp-zone" style="opacity:0"/>
            <ellipse cx="100" cy="130" rx="41" ry="54"  fill="none" stroke="var(--fp-blue,#0A58CA)" stroke-width="2.8" stroke-dasharray="17 6 13 5 8 4"        transform="rotate(1 100 130)"  class="fp-zone" style="opacity:0"/>
            <ellipse cx="100" cy="130" rx="31" ry="41"  fill="none" stroke="var(--fp-blue,#0A58CA)" stroke-width="2.8" stroke-dasharray="15 6 11 4 7 4"        transform="rotate(3 100 130)"  class="fp-zone" style="opacity:0"/>
            <ellipse cx="100" cy="130" rx="22" ry="29"  fill="none" stroke="var(--fp-blue,#0A58CA)" stroke-width="2.8" stroke-dasharray="13 5 9 4"             transform="rotate(5 100 130)"  class="fp-zone" style="opacity:0"/>
            <ellipse cx="100" cy="130" rx="14" ry="18"  fill="none" stroke="var(--fp-blue,#0A58CA)" stroke-width="2.8" stroke-dasharray="10 4 7 3"             transform="rotate(7 100 130)"  class="fp-zone" style="opacity:0"/>
            <ellipse cx="100" cy="130" rx="7"  ry="9"   fill="none" stroke="var(--fp-blue,#0A58CA)" stroke-width="2.8" stroke-dasharray="8 3"                  transform="rotate(9 100 130)"  class="fp-zone" style="opacity:0"/>
            <ellipse cx="100" cy="131" rx="2"  ry="3"   fill="var(--fp-blue,#0A58CA)" class="fp-zone" style="opacity:0"/>
        </g>
    </svg>`;

    const fpHtml=fp.available?renderSection('Biometría')+`<div class="detail-card">
        <div class="fp-hello-wrap" id="fp-area">
            <div class="sensor-wrapper" id="fp-rings">${fpSvg}</div>
            <p id="fp-status" class="fp-hello-status">${enrolled?'Huella configurada correctamente':'Coloca el dedo en el sensor'}</p>
            <button class="btn btn-primary btn-sm" id="fp-enroll" style="margin-top:8px">${enrolled?'Volver a registrar':'Iniciar registro'}</button>
        </div>
    </div>`:'';

    // SDDM theme section
    const bgOpts=[['solid','Sólido'],['image','Imagen'],['blur','Blur']];
    const sddmHtml=renderSection('Gestor de inicio de sesión (SDDM)')+
        `<div id="sddm-preview-wrap"></div>`+
        `<div class="detail-card">
        ${renderRowItem('Modo oscuro','Pantalla de inicio oscura o clara',renderToggle('sddm-dark',sddmCfg.variant==='dark'))}
        <div class="detail-item detail-item-row">
            <div class="detail-texts"><span class="dt">Fondo</span></div>
            <div class="seg-ctrl" id="sddm-bg-ctrl">${bgOpts.map(([v,l])=>`<button class="seg-btn${sddmCfg.background===v?' active':''}" data-val="${v}">${l}</button>`).join('')}</div>
        </div>
        <div class="detail-item detail-item-row" id="sddm-img-row" style="display:${sddmCfg.background==='solid'?'none':'flex'}">
            <div class="detail-texts"><span class="dt">Imagen de fondo</span><span class="ds" id="sddm-img-name" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sddmCfg.bgImage?sddmCfg.bgImage.split('/').pop():'Sin imagen'}</span></div>
            <button class="btn btn-secondary btn-sm" id="sddm-img-btn">Elegir</button>
        </div>
    </div>`;

    c.innerHTML=renderHeader('Pantalla de bloqueo y AOD')+
        renderCard([
            renderInfoItem('Tipo de bloqueo','Contraseña del sistema'),
            `<div class="detail-item"><span class="dt">Tiempo de espera</span><div class="slider-container"><input type="range" class="filled" id="lt" min="1" max="30" value="${timeout}" style="--fill:${((timeout-1)/29)*100}%"><span class="slider-label" id="lt-l">${timeout} min</span></div></div>`
        ])+fpHtml+
        renderSection('Always On Display')+renderCard([
            renderRowItem('AOD','Muestra información cuando la pantalla está apagada',renderToggle('aod',aod))
        ])+
        renderSection('Book Bar')+renderCard([
            renderRowItem('Mostrar Book Bar','Pastilla dinámica con música, rutinas y batería',renderToggle('bookbar',bookBarEnabled))
        ])+sddmHtml;

    setupSlider('lt',async v=>{try{await tauriInvoke('set_lock_timeout',{minutes:parseInt(v)})}catch(e){}const l=document.getElementById('lt-l');if(l)l.textContent=v+' min';toast('Tiempo de espera: '+v+' min');},false);
    setupToggle('aod',async a=>{setSetting('AOD',a?'true':'false');toast(a?'AOD activado':'AOD desactivado');});
    setupToggle('bookbar',async a=>{
        setSetting('BookBarEnabled',a?'true':'false');
        try{await tauriInvoke('run_command',{cmd:'sh',args:['-c',`mkdir -p "$HOME/.config" && echo '{"enabled":${a}}' > "$HOME/.config/bookos-bookbar.json"`]});}catch(e){}
        toast(a?'Book Bar activada':'Book Bar desactivada');
    });

    // Fingerprint: progressive detection animation (center → outer, like a real scan)
    _startFpIdleAnim();

    // SDDM preview
    let _sddmCfg={variant:sddmCfg.variant,background:sddmCfg.background,bgImage:sddmCfg.bgImage};
    const _avatarUrl=userInfo.has_avatar&&userInfo.avatar_path
        ?(window.__TAURI__?.core?.convertFileSrc?window.__TAURI__.core.convertFileSrc(userInfo.avatar_path):`file://${userInfo.avatar_path}`):'';
    const _displayName=userInfo.display_name||'Usuario';

    function _renderSddmPreview(){
        const wrap=document.getElementById('sddm-preview-wrap');
        if(!wrap)return;
        const dark=_sddmCfg.variant==='dark';
        const bg=_sddmCfg.background;
        const imgPath=_sddmCfg.bgImage;
        const imgUrl=imgPath?(window.__TAURI__?.core?.convertFileSrc?window.__TAURI__.core.convertFileSrc(imgPath):`file://${imgPath}`):'';

        const bgColor=dark?'#000':'#f2f2f7';
        const fgColor=dark?'#fff':'#000';
        const fg2=dark?'#8e8e93':'#8e8e93';
        const fieldBg=dark?'#1c1c1e':'#fff';
        const pillBg=dark?'rgba(28,28,30,.8)':'rgba(255,255,255,.8)';
        const overlay=dark?'rgba(0,0,0,.5)':'rgba(255,255,255,.37)';
        const now=new Date();
        const clockStr=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');

        // Background layers
        let bgLayer='';
        if(bg==='solid'||!imgUrl){
            bgLayer=`<div style="position:absolute;inset:0;background:${bgColor}"></div>`;
        } else if(bg==='image'){
            bgLayer=`<div style="position:absolute;inset:0;background:url('${imgUrl}') center/cover no-repeat"></div>
                     <div style="position:absolute;inset:0;background:${overlay}"></div>`;
        } else { // blur
            bgLayer=`<div style="position:absolute;inset:0;overflow:hidden">
                <div style="position:absolute;inset:-20px;background:url('${imgUrl}') center/cover no-repeat;filter:blur(12px)"></div>
            </div>
            <div style="position:absolute;inset:0;background:${overlay}"></div>`;
        }

        wrap.innerHTML=`<div style="position:relative;width:100%;aspect-ratio:16/10;border-radius:18px;overflow:hidden;margin-bottom:12px;box-shadow:0 8px 32px rgba(0,0,0,.35)">
            ${bgLayer}
            <!-- clock -->
            <div style="position:absolute;top:8%;left:50%;transform:translateX(-50%);font-family:serif;font-size:clamp(18px,5vw,28px);font-weight:700;color:${fgColor};white-space:nowrap;text-shadow:0 1px 4px rgba(0,0,0,.4)">${clockStr}</div>
            <!-- avatar + name + password -->
            <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:6px;width:80%">
                ${_avatarUrl
                    ?`<img src="${_avatarUrl}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;display:block">`
                    :`<div style="width:40px;height:40px;border-radius:50%;background:${dark?'#2c2c2e':'#c7c7cc'};display:flex;align-items:center;justify-content:center;font-size:16px;color:${fg2};font-weight:600">${(_displayName[0]||'U').toUpperCase()}</div>`}
                <div style="font-size:11px;font-weight:500;color:${fgColor}">${_displayName}</div>
                <div style="display:flex;gap:4px;width:100%;max-width:160px;margin-top:2px">
                    <div style="flex:1;height:20px;background:${fieldBg};border-radius:10px;display:flex;align-items:center;padding:0 8px">
                        <span style="font-size:6px;color:${fg2};letter-spacing:3px">●●●●●</span>
                    </div>
                    <div style="width:20px;height:20px;background:${dark?'#3a3a3c':'#e5e5ea'};border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:10px;color:${fgColor}">→</div>
                </div>
                <div style="font-size:8px;color:${fg2};margin-top:1px">o usa tu huella dactilar</div>
            </div>
            <!-- battery pill -->
            <div style="position:absolute;bottom:6%;left:50%;transform:translateX(-50%);background:${pillBg};border-radius:10px;padding:3px 10px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)">
                <span style="font-size:9px;font-weight:600;color:${fgColor}">🔋 74%</span>
            </div>
        </div>`;
    }
    _renderSddmPreview();
    async function _sddmPromptAndSave(){
        if(window._sudoModal)window._sudoModal.remove();
        const pwd=await new Promise(resolve=>{
            const d=document.createElement('div');d.className='sudo-modal-overlay';
            d.innerHTML=`<div class="sudo-modal"><div class="sudo-icon">🖥️</div><h3 class="sudo-title">Pantalla de inicio de sesión</h3><p class="sudo-desc">Introduce la contraseña para aplicar los cambios.</p><input type="password" class="sudo-input" id="sddm-pwd" placeholder="Contraseña"><div class="sudo-btns"><button class="btn btn-secondary" id="sddm-cancel">Cancelar</button><button class="btn btn-primary" id="sddm-ok">Aplicar</button></div></div>`;
            document.body.appendChild(d);window._sudoModal=d;
            const cleanup=()=>{d.remove();window._sudoModal=null;};
            document.getElementById('sddm-cancel').onclick=()=>{cleanup();resolve(null);};
            const run=()=>{const v=document.getElementById('sddm-pwd').value;cleanup();resolve(v||null);};
            document.getElementById('sddm-ok').onclick=run;
            document.getElementById('sddm-pwd').addEventListener('keydown',e=>{if(e.key==='Enter')run();});
            requestAnimationFrame(()=>document.getElementById('sddm-pwd')?.focus());
        });
        if(!pwd)return;
        try{
            const res=JSON.parse(await tauriInvoke('set_sddm_config',{variant:_sddmCfg.variant,background:_sddmCfg.background,bgImage:_sddmCfg.bgImage,password:pwd}));
            if(res.ok){toast('Pantalla de inicio actualizada','🖥️');}
            else{toast('Error: '+(res.error||'desconocido'),'❌');}
        }catch(e){toast('Error al guardar configuración SDDM','❌');}
    }
    setupToggle('sddm-dark',async dark=>{
        _sddmCfg.variant=dark?'dark':'light';
        _renderSddmPreview();
        await _sddmPromptAndSave();
    });
    document.querySelectorAll('#sddm-bg-ctrl .seg-btn').forEach(btn=>{
        btn.addEventListener('click',async()=>{
            document.querySelectorAll('#sddm-bg-ctrl .seg-btn').forEach(b=>b.classList.remove('active'));
            btn.classList.add('active');
            _sddmCfg.background=btn.dataset.val;
            const imgRow=document.getElementById('sddm-img-row');
            if(imgRow)imgRow.style.display=_sddmCfg.background==='solid'?'none':'flex';
            _renderSddmPreview();
            await _sddmPromptAndSave();
        });
    });
    document.getElementById('sddm-img-btn')?.addEventListener('click',async()=>{
        try{
            const {open}=window.__TAURI__.dialog;
            const path=await open({filters:[{name:'Imagen',extensions:['png','jpg','jpeg','webp']}],multiple:false});
            if(!path)return;
            _sddmCfg.bgImage=path;
            const nameEl=document.getElementById('sddm-img-name');
            if(nameEl)nameEl.textContent=path.split('/').pop();
            _renderSddmPreview();
            await _sddmPromptAndSave();
        }catch(e){toast('Error al seleccionar imagen','❌');}
    });

    // Fingerprint enroll
    document.getElementById('fp-enroll')?.addEventListener('click',async()=>{
        const btn=document.getElementById('fp-enroll');
        const wrap=document.getElementById('fp-rings');
        const status=document.getElementById('fp-status');
        const svg=document.getElementById('fp-svg-main');
        const blueRings=svg?[...svg.querySelectorAll('.fp-zone')]:[];
        btn.disabled=true;btn.textContent='Registrando...';
        wrap?.classList.add('fp-scanning');
        status.textContent='Coloca tu dedo repetidamente en el sensor...';

        // JS-driven sweep pulse — rings light up from center outward in a loop
        let scanActive=true;
        let tick=0;
        const reversed=[...blueRings].reverse(); // innermost first
        const scanPulse=()=>{
            if(!scanActive)return;
            const idx=tick%reversed.length;
            reversed.forEach((r,i)=>{
                const dist=Math.abs(idx-i);
                const op=dist===0?'1':dist===1?'0.7':dist===2?'0.4':'0.15';
                r.style.opacity=op;
                r.style.transition='opacity 0.15s ease';
            });
            tick++;
            setTimeout(()=>requestAnimationFrame(scanPulse),120);
        };
        requestAnimationFrame(scanPulse);

        try{
            const r=JSON.parse(await tauriInvoke('enroll_fingerprint'));
            scanActive=false;
            wrap?.classList.remove('fp-scanning');
            // Show all rings fully
            blueRings.forEach(ring=>{ring.style.opacity='1';ring.style.transition='opacity 0.3s ease';});
            if(r.ok){
                wrap?.classList.add('fp-success');
                status.textContent='¡Huella registrada correctamente!';
                status.classList.add('success-text');
                btn.textContent='Volver a registrar';
                toast('Huella registrada','✅');
            } else {
                wrap?.classList.add('fp-error');
                status.textContent='No se pudo registrar. Inténtalo de nuevo.';
                btn.textContent='Reintentar';
                setTimeout(()=>{wrap?.classList.remove('fp-error');},2000);
            }
        }catch(e){
            scanActive=false;
            wrap?.classList.remove('fp-scanning');
            blueRings.forEach(ring=>{ring.style.opacity='1';ring.style.transition='opacity 0.3s ease';});
            status.textContent='Error: asegúrate de que el sensor está disponible';
            btn.textContent='Reintentar';
        }
        btn.disabled=false;
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Actualizaciones (Apple + Windows Hybrid — OS card + progress bar) ──
// ════════════════════════════════════════════════════════════════════════
export async function renderActualizacion(c){
    c.innerHTML=renderHeader('Actualización de software')+
        `<div class="upd-searching">
            <div class="upd-spinner-wrap"><div class="upd-spinner"></div></div>
            <span class="upd-searching-text">Buscando actualizaciones...</span>
        </div>`;
    await _doCheckUpdates(c);
}

// Sub-page: list of packages grouped by source (Sistema / Flatpak / AUR)
async function renderUpdatesPackages(c, sys, flat, aur, sysInfo){
    window.pushSubNav(()=>renderActualizacion(c));
    let activeTab='sys';
    function renderTab(){
        const tabs=[
            {id:'sys',label:'Sistema',count:sys.count,pkgs:sys.packages,hasVer:true},
            {id:'flat',label:'Flatpak',count:flat.count,pkgs:flat.packages,hasVer:false},
            {id:'aur',label:'AUR',count:aur.count,pkgs:aur.packages,hasVer:true},
        ];
        const active=tabs.find(t=>t.id===activeTab)||tabs[0];
        const pkgRows=active.pkgs.map((p,i)=>{
            const verText=active.hasVer?(p.old&&p.new?`${esc(p.old)} → ${esc(p.new)}`:(esc(p.old||p.version||''))):(esc(p.version||''));
            return `<div class="upd-pkg-row" data-pkg-idx="${i}" data-pkg-src="${active.id}">
                <div class="upd-pkg-row-info">
                    <span class="upd-pkg-row-name">${esc(p.name)}</span>
                    ${verText?`<span class="upd-pkg-row-ver">${verText}</span>`:''}
                </div>
                <svg class="upd-pkg-row-chev" viewBox="0 0 8 14" width="8" height="14" fill="none"><path d="M1 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>`;
        }).join('');
        return `
        ${renderHeader('Actualizar paquetes')}
        <div class="upd-tabs-wrap">
            ${tabs.map(t=>`<button class="upd-tab${t.id===activeTab?' active':''}" data-tab="${t.id}">${t.label}${t.count?` <span class="pkg-count-badge">${t.count}</span>`:''}</button>`).join('')}
        </div>
        <div class="upd-pkg-list detail-card">
            ${active.pkgs.length
                ? pkgRows
                : `<div class="upd-pkg-empty">Sin paquetes pendientes</div>`}
        </div>
        <div class="upd-install-actions">
            <button class="upd-btn-now" id="upd-install-all" ${(sys.count+flat.count+aur.count)===0?'disabled':''}>Actualizar todo ahora</button>
        </div>`;
    }
    function mount(){
        c.innerHTML=renderTab();
        c.querySelectorAll('.upd-tab').forEach(btn=>btn.addEventListener('click',()=>{
            activeTab=btn.dataset.tab; c.innerHTML=renderTab(); mount();
        }));
        c.querySelectorAll('.upd-pkg-row').forEach(row=>row.addEventListener('click',()=>{
            const src=row.dataset.pkgSrc;
            const idx=parseInt(row.dataset.pkgIdx,10);
            const srcMap={sys:sys.packages,flat:flat.packages,aur:aur.packages};
            renderUpdateDetail(c,srcMap[src][idx],src,sysInfo,()=>{renderUpdatesPackages(c,sys,flat,aur,sysInfo);});
        }));
        document.getElementById('upd-install-all')?.addEventListener('click',async()=>{
            const pwd=await promptUpdatePassword(sysInfo.distro);
            if(!pwd)return;
            try{
                const started=JSON.parse(await tauriInvoke('run_pacman_update_silent',{password:pwd}));
                if(!started.ok&&!started.started)throw new Error(started.error||'Contraseña incorrecta');
                toast('Descargando e instalando actualizaciones...','⬇');
                // Go back to main page and show progress
                renderActualizacion(c);
            }catch(e){toast('Error: '+(e.message||'Fallo'),'✕');}
        });
    }
    mount();
}

// Detail view for a single package
async function renderUpdateDetail(c, pkg, src, sysInfo, onBack){
    window.pushSubNav(onBack);
    const srcLabel={sys:'Sistema',flat:'Flatpak',aur:'AUR'}[src]||src;
    const verArrow=pkg.old&&pkg.new?`${esc(pkg.old)} → ${esc(pkg.new)}`:(esc(pkg.version||pkg.new||''));
    c.innerHTML=renderHeader(esc(pkg.name))+
    `<div class="upd-detail-card">
        <div class="upd-detail-icon-wrap">
            <svg viewBox="0 0 40 40" width="40" height="40" fill="none"><rect width="40" height="40" rx="10" fill="var(--blue)" opacity=".15"/><path d="M20 10v14M20 24l-5-5M20 24l5-5" stroke="var(--blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 30h16" stroke="var(--blue)" stroke-width="2" stroke-linecap="round"/></svg>
        </div>
        <div class="upd-detail-meta">
            <span class="upd-detail-name">${esc(pkg.name)}</span>
            <span class="upd-detail-ver">${verArrow}</span>
        </div>
    </div>
    <div class="upd-detail-actions">
        <button class="upd-night-btn" id="upd-night">Actualizar por la noche</button>
        <button class="upd-btn-now" id="upd-now">Actualizar ahora</button>
    </div>
    ${renderSection('Información')}
    ${renderCard([
        renderRowItem('Fuente',srcLabel,''),
        pkg.old?renderRowItem('Instalado',esc(pkg.old),''):'',
        pkg.new?renderRowItem('Disponible',esc(pkg.new),''):'',
        renderRowItem('Sistema',esc(sysInfo.distro||'BookOS'),''),
        renderRowItem('Kernel',esc(sysInfo.kernel||''),''),
    ].filter(Boolean))}`;

    document.getElementById('upd-night')?.addEventListener('click',()=>{
        setSetting('NightUpdate_'+esc(pkg.name),'true');
        toast('Programado para esta noche','🌙');
    });
    document.getElementById('upd-now')?.addEventListener('click',async()=>{
        const pwd=await promptUpdatePassword(sysInfo.distro);
        if(!pwd)return;
        try{
            const started=JSON.parse(await tauriInvoke('run_pacman_update_silent',{password:pwd}));
            if(!started.ok&&!started.started)throw new Error(started.error||'Contraseña incorrecta');
            toast('Actualizando '+pkg.name+'...','⬇');
            onBack();
        }catch(e){toast('Error: '+(e.message||'Fallo'),'✕');}
    });
}

// macOS-style password prompt for updates
async function promptUpdatePassword(distro){
    return new Promise(resolve=>{
        if(window._sudoModal)window._sudoModal.remove();
        const d=document.createElement('div');
        d.className='sudo-modal-overlay';
        d.innerHTML=`
        <div class="upd-auth-modal">
            <div class="upd-auth-lock">
                <svg viewBox="0 0 44 44" width="44" height="44" fill="none">
                    <rect x="10" y="20" width="24" height="18" rx="4" fill="currentColor" opacity="0.15"/>
                    <rect x="10" y="20" width="24" height="18" rx="4" stroke="currentColor" stroke-width="2"/>
                    <path d="M16 20v-5a6 6 0 0 1 12 0v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <circle cx="22" cy="29" r="3" fill="currentColor"/>
                    <line x1="22" y1="32" x2="22" y2="35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
            </div>
            <div class="upd-auth-content">
                <h3 class="upd-auth-title">Se requiere contraseña</h3>
                <p class="upd-auth-desc"><strong>${esc(distro||'BookOS')}</strong> quiere realizar cambios en el sistema. Introduce tu contraseña para autorizar la acción.</p>
                <div class="upd-auth-field">
                    <label class="upd-auth-label">Contraseña</label>
                    <input type="password" class="upd-auth-input" id="upd-pwd" autocomplete="current-password" placeholder="••••••••">
                </div>
                <p class="upd-auth-error" id="upd-auth-err" style="display:none">Contraseña incorrecta. Inténtalo de nuevo.</p>
            </div>
            <div class="upd-auth-btns">
                <button class="upd-auth-btn cancel" id="upd-cancel">Cancelar</button>
                <button class="upd-auth-btn ok" id="upd-ok">OK</button>
            </div>
        </div>`;
        document.body.appendChild(d);
        window._sudoModal=d;
        const cleanup=()=>{d.remove();window._sudoModal=null;};
        document.getElementById('upd-cancel').onclick=()=>{cleanup();resolve(null);};
        const submit=()=>{const v=document.getElementById('upd-pwd').value;cleanup();resolve(v||null);};
        document.getElementById('upd-ok').onclick=submit;
        document.getElementById('upd-pwd').addEventListener('keydown',e=>{if(e.key==='Enter')submit();});
        requestAnimationFrame(()=>document.getElementById('upd-pwd')?.focus());
    });
}

async function _doCheckUpdates(c){
    // Fast path: if update already running, skip checkupdates (would block on pacman lock)
    // and jump straight to progress UI
    try{
        const p=JSON.parse(await tauriInvoke('get_update_progress'));
        if(p.running){_renderUpdateRunning(c,p);return;}
    }catch(e){}

    let sys={count:0,packages:[]},flat={count:0,packages:[]},aur={count:0,packages:[]},sysInfo={distro:'BookOS',kernel:''};
    let autoupd=false;
    try{[sys,flat,aur,sysInfo,autoupd]=await Promise.all([
        tauriInvoke('check_system_updates').then(JSON.parse).catch(()=>({count:0,packages:[]})),
        tauriInvoke('check_flatpak_updates').then(JSON.parse).catch(()=>({count:0,packages:[]})),
        tauriInvoke('check_aur_updates').then(JSON.parse).catch(()=>({count:0,packages:[]})),
        tauriInvoke('get_system_info').then(JSON.parse).catch(()=>({distro:'BookOS',kernel:''})),
        getSetting('AutoUpdate','false').then(v=>v==='true')
    ]);}catch(e){}
    const total=sys.count+flat.count+aur.count;

    // ── Up to date ──
    if(total===0){
        c.innerHTML=renderHeader('Actualización de software')+
        `<div class="upd-ok">
            <div class="upd-ok-icon">
                <svg viewBox="0 0 56 56" width="56" height="56" fill="none">
                    <circle cx="28" cy="28" r="27" stroke="var(--green)" stroke-width="2"/>
                    <path d="M17 28l8 8 14-16" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </div>
            <span class="upd-ok-title">Tu equipo está actualizado</span>
            <span class="upd-ok-sub">Última comprobación: ahora mismo</span>
            <button class="upd-recheck" id="re-check">Buscar actualizaciones</button>
        </div>`+
        renderSection('Software instalado')+
        renderCard([renderRowItem('Sistema',esc(sysInfo.distro||'BookOS'),''),renderRowItem('Kernel',esc(sysInfo.kernel||''),'')])+
        renderSection('Opciones')+
        renderCard([renderRowItem('Actualizaciones automáticas','Descargar e instalar automáticamente',renderToggle('auto-upd',autoupd))]);
        document.getElementById('re-check')?.addEventListener('click',()=>renderActualizacion(c));
        setupToggle('auto-upd',async a=>{
            setSetting('AutoUpdate',a?'true':'false');
            try{await tauriInvoke('configure_auto_update',{enable:a});}catch(e){}
            toast(a?'Actualizaciones automáticas activadas':'Desactivadas');
        });
        return;
    }

    // ── Updates available ──
    let h=renderHeader('Actualización de software');

    // Summary card
    h+=`<div class="upd-card">
        <div class="upd-card-icon"><img src="assets/book-os.svg" alt="BookOS"></div>
        <div class="upd-card-body">
            <div class="upd-card-top">
                <div class="upd-card-info">
                    <span class="upd-card-name">${esc(sysInfo.distro||'BookOS')}</span>
                    <span class="upd-card-ver">${total} actualización${total>1?'es':''} disponible${total>1?'s':''}</span>
                </div>
            </div>
            <p class="upd-card-desc">Esta actualización incluye correcciones de errores, parches de seguridad y mejoras de rendimiento para tu sistema.</p>
            <div class="upd-card-sources">
                ${sys.count?`<span class="upd-src-chip">Sistema <b>${sys.count}</b></span>`:''}
                ${flat.count?`<span class="upd-src-chip">Flatpak <b>${flat.count}</b></span>`:''}
                ${aur.count?`<span class="upd-src-chip">AUR <b>${aur.count}</b></span>`:''}
            </div>
            <div class="upd-progress-wrap" id="upd-progress" style="display:none">
                <div class="upd-progress-track"><div class="upd-progress-fill" id="upd-bar"></div></div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
                    <span class="upd-progress-label" id="upd-text">Preparando...</span>
                    <button class="bk-dbtn cancel" id="upd-cancel" style="padding:4px 14px;font-size:12px;margin-left:12px">Cancelar</button>
                </div>
            </div>
        </div>
    </div>`;

    h+=renderSection('Software instalado');
    h+=renderCard([renderRowItem('Sistema',esc(sysInfo.distro||'BookOS'),''),renderRowItem('Kernel',esc(sysInfo.kernel||''),'')]);

    h+=renderSection('Opciones');
    h+=renderCard([
        `<div class="detail-item detail-item-row upd-install-row" id="upd-goto-pkgs" style="cursor:pointer">
            <div style="display:flex;flex-direction:column;gap:2px">
                <span class="dt" style="color:var(--blue)">Actualizar e instalar paquetes</span>
                <span style="font-size:12px;color:var(--tx2)">${total} actualización${total>1?'es':''} · Sistema, Flatpak, AUR</span>
            </div>
            <svg viewBox="0 0 8 14" width="8" height="14" fill="none" style="color:var(--tx3);flex-shrink:0"><path d="M1 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>`,
        renderRowItem('Actualizaciones automáticas','Descargar e instalar automáticamente',renderToggle('auto-upd',autoupd)),
    ]);

    c.innerHTML=h;

    document.getElementById('upd-goto-pkgs')?.addEventListener('click',()=>{
        renderUpdatesPackages(c,sys,flat,aur,sysInfo);
    });

    setupToggle('auto-upd',async a=>{setSetting('AutoUpdate',a?'true':'false');try{await tauriInvoke('configure_auto_update',{enable:a});}catch(e){}toast(a?'Actualizaciones automáticas activadas':'Desactivadas');});

    const progressWrap=document.getElementById('upd-progress');
    const bar=document.getElementById('upd-bar');
    const text=document.getElementById('upd-text');

    document.getElementById('upd-cancel')?.addEventListener('click',async()=>{
        try{await tauriInvoke('cancel_update');}catch(e){}
        progressWrap.style.display='none';
        if(bar){bar.classList.remove('indeterminate');bar.style.width='0';bar.style.background='';}
        toast('Actualización cancelada','✕');
    });
}

// Renders a dedicated "installing" screen — used when update is already running on page load
function _renderUpdateRunning(c, initialProgress){
    c.innerHTML=renderHeader('Actualización de software')+
    `<div class="upd-card">
        <div class="upd-card-icon"><img src="assets/book-os.svg" alt="BookOS"></div>
        <div class="upd-card-body">
            <div class="upd-card-top">
                <div class="upd-card-info">
                    <span class="upd-card-name">Instalando actualizaciones</span>
                    <span class="upd-card-ver">No cierres la aplicación</span>
                </div>
            </div>
            <div class="upd-progress-wrap" id="upd-progress">
                <div class="upd-progress-track"><div class="upd-progress-fill indeterminate" id="upd-bar"></div></div>
                <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
                    <span class="upd-progress-label" id="upd-text">Instalando...</span>
                    <button class="bk-dbtn cancel" id="upd-cancel" style="padding:4px 14px;font-size:12px;margin-left:12px">Cancelar</button>
                </div>
            </div>
        </div>
    </div>`;
    const bar=document.getElementById('upd-bar');
    const text=document.getElementById('upd-text');
    const progressWrap=document.getElementById('upd-progress');
    document.getElementById('upd-cancel')?.addEventListener('click',async()=>{
        try{await tauriInvoke('cancel_update');}catch(e){}
        toast('Actualización cancelada','✕');
        renderActualizacion(c);
    });
    _startUpdatePolling(c,bar,text,progressWrap,null);
}

function _startUpdatePolling(c,bar,text,progressWrap,sysInfo){
    if(bar) bar.classList.add('indeterminate');
    let dots=0;
    const poll=setInterval(async()=>{
        try{
            if(!document.getElementById('upd-bar')){clearInterval(poll);return;}
            const p=JSON.parse(await tauriInvoke('get_update_progress'));
            dots=(dots+1)%4;
            if(p.running){
                if(text) text.textContent=(p.output?p.output.split('\n').pop().substring(0,40):'Instalando')+'.'.repeat(dots+1);
            }
            if(p.done){
                clearInterval(poll);
                if(p.ok){
                    if(bar){bar.classList.remove('indeterminate');bar.style.width='100%';}
                    if(text) text.textContent='✓ Completado';
                    toast('Sistema actualizado correctamente','🎉');
                    setTimeout(()=>renderActualizacion(c),1500);
                }else{
                    throw new Error(p.output||'Error al actualizar');
                }
            }
        }catch(e){
            clearInterval(poll);
            if(bar){bar.classList.remove('indeterminate');bar.style.background='var(--red)';bar.style.width='100%';}
            if(text) text.textContent='Error: '+(e.message||'Fallo');
            setTimeout(()=>{if(progressWrap)progressWrap.style.display='none';if(bar)bar.style.background='';},3000);
        }
    },500);
}

// ════════════════════════════════════════════════════════════════════════
// ── Acerca ──────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderAcerca(c){
    c.innerHTML=renderHeader('Acerca del portátil')+renderSkeleton(4);
    let i={hostname:'--',kernel:'--',distro:'--',cpu:'--',ram:'--',gpu:'--',plasma:'--'};
    try{i=JSON.parse(await tauriInvoke('get_system_info'));}catch(e){}

    // Samsung-style: device image + name + rename + info sections
    let h=renderHeader('Acerca del portátil');

    h+=`<div class="about-hero">
        <div class="about-device-img-wrap">
            <img src="./assets/generic_book2.svg" class="about-device-img" alt="Device">
        </div>
        <div class="about-hero-name" id="about-hostname-display">${esc(i.hostname)}</div>
        <button class="about-rename-btn" id="btn-rename-device">Cambiar nombre</button>
        <div class="about-rename-row" id="about-rename-row" style="display:none">
            <input type="text" class="about-rename-input" id="about-rename-input" value="${esc(i.hostname)}" placeholder="Nombre del equipo">
            <button class="btn btn-primary btn-sm" id="about-rename-ok">Guardar</button>
            <button class="btn btn-secondary btn-sm" id="about-rename-cancel">Cancelar</button>
        </div>
    </div>`;

    // Info rows (Samsung About phone style)
    h+=renderSection('Software');
    h+=renderCard([
        renderInfoItem('Sistema operativo','BookOS · '+esc(i.distro)),
        renderInfoItem('Entorno de escritorio','KDE Plasma '+esc(i.plasma)),
        renderInfoItem('Kernel de Linux',esc(i.kernel)),
    ]);

    h+=renderSection('Hardware');
    h+=renderCard([
        renderInfoItem('Procesador',esc(i.cpu)),
        renderInfoItem('Memoria RAM',esc(i.ram)),
        renderInfoItem('Tarjeta gráfica',esc(i.gpu)),
    ]);

    // Links section (Samsung style)
    h+=renderSection('Información adicional');
    h+=renderCard([
        `<div class="detail-item detail-item-row" style="cursor:pointer" id="about-legal"><span class="dt">Información legal</span><span style="color:var(--tx2);font-size:18px">›</span></div>`,
        `<div class="detail-item detail-item-row" style="cursor:pointer" id="about-soft-info"><span class="dt">Información de software</span><span style="color:var(--tx2);font-size:18px">›</span></div>`,
        `<div class="detail-item detail-item-row" style="cursor:pointer" onclick="window.openPage('actualizacion')"><span class="dt" style="color:var(--blue)">Actualización de software</span><span style="color:var(--tx2);font-size:18px">›</span></div>`,
    ]);

    c.innerHTML=h;

    // Rename device
    document.getElementById('btn-rename-device')?.addEventListener('click',()=>{
        document.getElementById('about-rename-row').style.display='flex';
        document.getElementById('about-rename-input')?.focus();
    });
    document.getElementById('about-rename-cancel')?.addEventListener('click',()=>{
        document.getElementById('about-rename-row').style.display='none';
    });
    document.getElementById('about-rename-ok')?.addEventListener('click',async()=>{
        const val=document.getElementById('about-rename-input')?.value?.trim();
        if(!val)return;
        try{await tauriInvoke('set_hostname',{name:val});}catch(e){}
        document.getElementById('about-hostname-display').textContent=val;
        document.getElementById('about-rename-row').style.display='none';
        toast('Nombre del equipo actualizado');
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Administración General ─────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderGeneral(c){
    c.innerHTML=renderHeader('Administración general')+renderSkeleton(2);
    let loc={locale:'',keymap:''},locales=[],keymaps=[],auto={enabled:false},autostartApps=[];
    try{[loc,locales,keymaps,auto,autostartApps]=await Promise.all([
        tauriInvoke('get_locale_info').then(JSON.parse),
        tauriInvoke('get_available_locales').then(JSON.parse),
        tauriInvoke('get_available_keymaps').then(JSON.parse),
        tauriInvoke('get_autostart_bookos').then(JSON.parse).catch(()=>({enabled:false})),
        tauriInvoke('get_autostart_apps').then(JSON.parse).catch(()=>[])
    ]);}catch(e){}
    
    const langMap = {'en_US.UTF-8':'🇺🇸 English (US)', 'es_ES.UTF-8':'🇪🇸 Español (España)', 'fr_FR.UTF-8':'🇫🇷 Français'};
    const getLangName = l => langMap[l] || l;

    c.innerHTML=renderHeader('Administración general') + renderSection('Idiomas y entrada') + renderCard([
        `<div class="detail-item detail-item-row" id="btn-lang" style="cursor:pointer">
            <div class="detail-texts"><span class="dt">Idioma del sistema</span><span class="ds">${getLangName(loc.locale)}</span></div>
            <div style="color:var(--tx2);font-size:18px">›</div>
        </div>`,
        `<div id="lang-list" style="display:none;padding:0 20px 16px"><div class="res-list" style="margin-bottom:0">
            ${locales.map(l=>`<div class="res-item ${l===loc.locale?'active':''}" data-lang="${esc(l)}"><span>${esc(getLangName(l))}</span></div>`).join('')}
        </div></div>`,
        `<div class="detail-item detail-item-row" id="btn-key" style="cursor:pointer">
            <div class="detail-texts"><span class="dt">Distribución del teclado</span><span class="ds">${loc.keymap || 'Predeterminado'}</span></div>
            <div style="color:var(--tx2);font-size:18px">›</div>
        </div>`,
        `<div id="key-list" style="display:none;padding:0 20px 16px"><div class="res-list" style="margin-bottom:0">
            ${keymaps.map(k=>`<div class="res-item ${k===loc.keymap?'active':''}" data-key="${esc(k)}"><span>${esc(k)}</span></div>`).join('')}
        </div></div>`
    ]) + renderSection('Comportamiento de la aplicación') + renderCard([
        renderRowItem('Lanzar al iniciar sesión','Abre BookOS Settings en segundo plano al encender',renderToggle('autostart',auto.enabled))
    ]) + renderSection('Inicio automático') +
    (autostartApps.length===0
        ? renderCard([renderInfoItem('Sin aplicaciones de inicio automático',`Añade apps en ~/.config/autostart/`)])
        : `<div class="detail-card">${autostartApps.map(a=>
            `<div class="detail-item detail-item-row autostart-row">
                <div class="detail-texts"><span class="dt">${esc(a.name)}</span><span class="ds" style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.exec)}</span></div>
                ${renderToggle('ast-'+esc(a.filename),a.enabled)}
            </div>`).join('')}</div>`
    );

    document.getElementById('btn-lang')?.addEventListener('click', ()=>{ const el=document.getElementById('lang-list'); el.style.display=el.style.display==='none'?'block':'none'; });
    document.getElementById('btn-key')?.addEventListener('click', ()=>{ const el=document.getElementById('key-list'); el.style.display=el.style.display==='none'?'block':'none'; });

    document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', async()=>{
        try {
            const ok = await promptSudo('cambiar el idioma del sistema', 'localectl', ['set-locale', `LANG=${b.dataset.lang}`]);
            if(ok){
                document.querySelectorAll('[data-lang]').forEach(x=>x.classList.remove('active'));
                b.classList.add('active');
                document.querySelector('#btn-lang .ds').textContent = getLangName(b.dataset.lang);
                toast('Idioma cambiado (requiere reinicio)');
            }
        } catch(e){}
    }));
    document.querySelectorAll('[data-key]').forEach(b => b.addEventListener('click', async()=>{
        try {
            await tauriInvoke('set_keymap',{layout:b.dataset.key});
            document.querySelectorAll('[data-key]').forEach(x=>x.classList.remove('active'));
            b.classList.add('active');
            document.querySelector('#btn-key .ds').textContent = b.dataset.key;
            toast('Teclado cambiado');
        } catch(e){}
    }));

    setupToggle('autostart', async a => {
        try { await tauriInvoke('toggle_autostart_bookos',{enable:a}); toast(a?'Configurado para inicio automático':'Inicio automático desactivado'); } catch(e){}
    });
    autostartApps.forEach(a=>{
        setupToggle('ast-'+a.filename, async enabled=>{
            try { await tauriInvoke('toggle_autostart_app',{filename:a.filename,enabled}); toast((enabled?'Activado':'Desactivado')+': '+a.name); } catch(e){}
        });
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Cuentas ────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderCuentas(c){
    c.innerHTML=renderHeader('Cuentas')+renderSkeleton(3);
    let u={username:'',display_name:'',hostname:''}, users=[];
    try{[u, users]=await Promise.all([
        tauriInvoke('get_user_info').then(JSON.parse).catch(()=>({username:'',display_name:'',hostname:''})),
        tauriInvoke('get_system_users').then(JSON.parse).catch(()=>[])
    ]);}catch(e){}

    const currentUser = users.find(x => x.username === u.username) || {display_name: u.display_name, has_avatar: false};
    const ini = (currentUser.display_name || u.username || 'U').charAt(0).toUpperCase();
    const av = currentUser.has_avatar ? `<img src="${getAssetUrl(currentUser.avatar_path)}" class="acc-avatar-big">` : `<div class="acc-avatar-big-ph">${ini}</div>`;

    let userListHtml = users.map(us => {
        const sIni = (us.display_name || us.username).charAt(0).toUpperCase();
        const sAv = us.has_avatar ? `<img src="${getAssetUrl(us.avatar_path)}" class="sys-user-av">` : `<div class="sys-user-av-ph">${sIni}</div>`;
        return `<div class="sys-user-item">${sAv}<div class="sys-user-info"><span class="sys-user-name">${esc(us.display_name||us.username)}</span><span class="sys-user-id">@${esc(us.username)}</span></div></div>`;
    }).join('');

    c.innerHTML=renderHeader('Cuentas') + `
        <div class="acc-hero">
            ${av}
            <div class="acc-hero-info">
                <span class="acc-hero-name">${esc(currentUser.display_name || u.username)}</span>
                <span class="acc-hero-sub">Administrador de BookOS</span>
            </div>
        </div>
    ` + renderSection('Datos locales') + renderCard([
        `<div class="detail-item"><span class="dt">Nombre visible</span><div style="display:flex;gap:8px;margin-top:8px"><input type="text" id="dn" value="${esc(u.display_name)}" class="sel" style="flex:1"><button class="btn btn-primary btn-sm" id="sn">Guardar</button></div></div>`,
        `<div class="detail-item"><span class="dt">Nombre del equipo</span><div style="display:flex;gap:8px;margin-top:8px"><input type="text" id="hn" value="${esc(u.hostname)}" class="sel" style="flex:1"><button class="btn btn-primary btn-sm" id="sh">Guardar</button></div></div>`
    ]) + renderSection('Seguridad') + renderCard([
        renderRowItem('Contraseña','Cambia la contraseña de tu cuenta',`<button class="btn btn-secondary btn-sm" id="acc-change-pw">Cambiar</button>`),
    ]) + renderSection('Otros usuarios en el equipo') + `<div class="detail-card"><div class="sys-users-list">${userListHtml}</div></div>`;

    document.getElementById('sn')?.addEventListener('click',async()=>{try{
        const ok = await promptSudo('cambiar el nombre visible', 'chfn', ['-f', document.getElementById('dn').value, u.username]);
        if(ok){ tauriInvoke('set_display_name', {name: document.getElementById('dn').value}).catch(()=>{}); toast('Nombre guardado'); }
    }catch(e){}});

    document.getElementById('sh')?.addEventListener('click',async()=>{try{
        const ok = await promptSudo('cambiar el nombre del equipo', 'hostnamectl', ['set-hostname', document.getElementById('hn').value]);
        if(ok){ tauriInvoke('set_hostname',{name:document.getElementById('hn').value}).catch(()=>{}); toast('Hostname guardado'); }
    }catch(e){}});

    document.getElementById('acc-change-pw')?.addEventListener('click',()=>{
        const ov=document.createElement('div');
        ov.className='bk-overlay';
        ov.innerHTML=`<div class="bk-dialog" style="min-width:320px">
            <div class="bk-dialog-title">Cambiar contraseña</div>
            <div style="padding:0 4px 12px;display:flex;flex-direction:column;gap:10px">
                <div><label class="ds" style="display:block;margin-bottom:4px">Contraseña actual</label>
                    <input type="password" id="pw-current" class="sel" placeholder="Contraseña actual" autocomplete="current-password"></div>
                <div><label class="ds" style="display:block;margin-bottom:4px">Nueva contraseña</label>
                    <input type="password" id="pw-new" class="sel" placeholder="Nueva contraseña" autocomplete="new-password"></div>
                <div><label class="ds" style="display:block;margin-bottom:4px">Confirmar nueva</label>
                    <input type="password" id="pw-confirm" class="sel" placeholder="Confirmar contraseña" autocomplete="new-password"></div>
                <div id="pw-err" style="font-size:12px;color:var(--red,#e53935);display:none"></div>
            </div>
            <div class="bk-dialog-btns">
                <button class="bk-dbtn cancel" id="pw-cancel">Cancelar</button>
                <button class="bk-dbtn confirm" id="pw-ok">Cambiar</button>
            </div>
        </div>`;
        document.body.appendChild(ov);
        const close=()=>ov.remove();
        ov.querySelector('#pw-cancel').onclick=close;
        ov.querySelector('#pw-ok').onclick=async()=>{
            const cur=ov.querySelector('#pw-current').value;
            const nw=ov.querySelector('#pw-new').value;
            const cf=ov.querySelector('#pw-confirm').value;
            const err=ov.querySelector('#pw-err');
            if(!cur||!nw){err.textContent='Rellena todos los campos';err.style.display='block';return;}
            if(nw!==cf){err.textContent='Las contraseñas no coinciden';err.style.display='block';return;}
            if(nw.length<8){err.textContent='La contraseña debe tener al menos 8 caracteres';err.style.display='block';return;}
            try{
                const result=JSON.parse(await tauriInvoke('change_password',{username:u.username,oldPwd:cur,newPwd:nw}));
                if(!result.ok){err.textContent='Contraseña actual incorrecta';err.style.display='block';return;}
                close();toast('Contraseña cambiada con éxito','🔑');
            }catch(e){err.textContent='Error al cambiar contraseña';err.style.display='block';}
        };
        ov.addEventListener('click',e=>{if(e.target===ov)close();});
        ov.querySelector('#pw-current').focus();
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Mantenimiento ──────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderMantenimiento(c){
    c.innerHTML=renderHeader('Mantenimiento')+renderSection('Limpieza')+renderCard([
        renderRowItem('Limpiar Flatpak','Elimina aplicaciones sin uso',`<button class="btn btn-secondary btn-sm" id="m-flat">Limpiar</button>`),
        renderRowItem('Limpiar caché de paquetes','Limpia archivos de Paru/Pacman',`<button class="btn btn-secondary btn-sm" id="m-pkg">Limpiar</button>`),
        renderRowItem('Miniaturas temporales','Borra caché de thumbnails',`<button class="btn btn-secondary btn-sm" id="m-cache">Borrar</button>`)
    ])+renderSection('Gestión de BookOS')+renderCard([
        renderRowItem('Permisos de Hardware','Añade reglas polkit para obviar contraseñas en control',`<button class="btn btn-secondary btn-sm" id="m-polkit">Configurar</button>`),
        renderRowItem('Exportar a JSON','Exportar configuración de BookOS',`<button class="btn btn-secondary btn-sm" id="m-exp">Exportar</button>`),
        renderRowItem('Importar JSON','Importar configuración (requiere elegir archivo)',`<button class="btn btn-secondary btn-sm" id="m-imp">Importar</button>`)
    ]);
    const run=(id,target)=>{
        const b=document.getElementById(id);if(!b)return;
        b.onclick=async()=>{
            const origText=b.textContent;
            b.textContent='…';b.disabled=true;
            try{await tauriInvoke('run_maintenance',{target});b.textContent='✓';toast('Limpieza completada','🧹');}
            catch(e){b.textContent='Error';toast('Error en limpieza','❌');}
            setTimeout(()=>{b.textContent=origText;b.disabled=false;},2000);
        };
    };
    run('m-flat','flatpak');run('m-pkg','packages');run('m-cache','cache');
    
    document.getElementById('m-polkit')?.addEventListener('click', async()=>{
        try { await tauriInvoke('setup_polkit_rules'); toast('Reglas Polkit configuradas con éxito!'); } catch(e) { toast('Error al configurar'); }
    });
    document.getElementById('m-exp')?.addEventListener('click', async()=>{
        try {
            const dest = await window.__TAURI__.dialog.save({defaultPath:'bookos_settings.json', filters:[{name:'JSON',extensions:['json']}]});
            if(dest) { await tauriInvoke('export_settings', {dest}); toast('Ajustes exportados a '+dest); }
        } catch(e){}
    });
    document.getElementById('m-imp')?.addEventListener('click', async()=>{
        try {
            const src = await window.__TAURI__.dialog.open({filters:[{name:'JSON',extensions:['json']}]});
            if(src) { await tauriInvoke('import_settings', {src}); toast('Ajustes importados'); setTimeout(()=>location.reload(), 1500); }
        } catch(e){}
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Fondo de Pantalla (NEW) ────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderFondos(c){
    c.innerHTML=renderHeader('Fondo de pantalla y estilo')+renderSkeleton(2);
    let wallpapers=[];
    try{wallpapers=JSON.parse(await tauriInvoke('get_wallpapers'));}catch(e){}
    let current='';
    try{current=JSON.parse(await tauriInvoke('get_current_wallpaper')).path||'';}catch(e){}

    let colorPalette=false,dimWallpaper=false,isDark=document.documentElement.classList.contains('dark-mode');
    try{[colorPalette,dimWallpaper,isDark]=await Promise.all([
        getSetting('ColorPalette','false').then(v=>v==='true'),
        getSetting('DimWallpaper','false').then(v=>v==='true'),
        tauriInvoke('get_current_theme').then(r=>JSON.parse(r).is_dark).catch(()=>isDark)
    ]);}catch(e){}

    if(!wallpapers.length){
        c.innerHTML=renderHeader('Fondo de pantalla y estilo')+renderCard([renderInfoItem('No se encontraron fondos de pantalla','Añade imágenes a ~/Imágenes o /usr/share/wallpapers')]);
        return;
    }

    const currentWp = wallpapers.find(w=>w.path===current)||wallpapers[0];
    const currentImg = getAssetUrl(currentWp.thumbnail||currentWp.path);
    const today = new Date();
    const time = today.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});
    const date = today.toLocaleDateString('es-ES',{weekday:'short',day:'numeric',month:'short'});

    // Panel colors matching BookOS Dark/Light theme
    const panelBg=isDark?'rgba(20,20,22,0.92)':'rgba(248,248,252,0.92)';
    const panelBorder=isDark?'rgba(255,255,255,0.07)':'rgba(0,0,0,0.08)';
    const panelTx=isDark?'#ffffff':'#1c1c1e';
    const panelTx2=isDark?'rgba(255,255,255,0.55)':'rgba(0,0,0,0.45)';
    const taskIconBg=isDark?'rgba(255,255,255,0.10)':'rgba(0,0,0,0.07)';

    // Dock icons matching the real desktop (same colors as actual BookOS dock)
    const dockIcons=[
        {bg:'#1565c0'}, {bg:'#e53935'}, {bg:'#2e7d32'}, {bg:'#6a1b9a'},
        {bg:'#263238'}, {bg:'#f57c00'}, {bg:'#00838f'}, {bg:'#4527a0'},
    ];
    const volSvg=`<svg viewBox="0 0 24 24" width="10" height="10"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="${panelTx2}"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07" fill="none" stroke="${panelTx2}" stroke-width="2" stroke-linecap="round"/></svg>`;
    const netSvg=`<svg viewBox="0 0 24 24" width="10" height="10"><path d="M5 12.55a11 11 0 0 1 14.08 0" fill="none" stroke="${panelTx2}" stroke-width="2.2" stroke-linecap="round"/><path d="M1.42 9a16 16 0 0 1 21.16 0" fill="none" stroke="${panelTx2}" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="19" r="1.5" fill="${panelTx2}"/></svg>`;
    const battSvg=`<svg viewBox="0 0 24 24" width="12" height="10"><rect x="2" y="7" width="16" height="10" rx="2" fill="none" stroke="${panelTx2}" stroke-width="1.8"/><path d="M22 11v2" stroke="${panelTx2}" stroke-width="2" stroke-linecap="round"/><rect x="4" y="9" width="9" height="6" rx="1" fill="${panelTx2}"/></svg>`;

    let h=renderHeader('Fondo de pantalla y estilo');
    // Desktop preview matching actual BookOS desktop layout:
    // top bar (thin, system tray right) + wallpaper + bottom floating dock
    h += `<div class="wp-preview-desktop">
        <div class="wp-desktop-screen" id="wp-screen">
            <img src="${currentImg}" class="wp-desktop-bg" id="wp-screen-img" alt="" onerror="this.style.opacity='0'">
            <!-- Top bar: thin, same as real KDE panel -->
            <div class="wp-top-bar" style="background:${panelBg};border-bottom:1px solid ${panelBorder}">
                <span class="wp-top-bar-title" style="color:${panelTx2}">BookOS</span>
                <div class="wp-top-bar-tray">
                    ${netSvg}${volSvg}${battSvg}
                    <span style="font-size:8px;font-weight:600;color:${panelTx2};white-space:nowrap">${time}</span>
                </div>
            </div>
            <!-- Bottom floating dock -->
            <div class="wp-float-dock" style="background:${isDark?'rgba(28,28,30,0.85)':'rgba(255,255,255,0.85)'};box-shadow:0 4px 20px rgba(0,0,0,${isDark?'.5':'.2'})">
                ${dockIcons.map(i=>`<div class="wp-dock-icon" style="background:${i.bg}"></div>`).join('')}
            </div>
        </div>
    </div>`;

    // Style quick-pick row (Dark / Light / Color)
    h += `<div class="wp-style-row">
        <div class="wp-style-card" id="wps-dark">
            <div class="ws-icon" style="background:#1a1a2e"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="white"/></svg></div>
            <span class="ws-label">Oscuro</span>
        </div>
        <div class="wp-style-card" id="wps-light">
            <div class="ws-icon" style="background:#f5f5f5"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="5" fill="#ffb300"/><line x1="12" y1="1" x2="12" y2="3" stroke="#ffb300" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="21" x2="12" y2="23" stroke="#ffb300" stroke-width="2" stroke-linecap="round"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" stroke="#ffb300" stroke-width="2" stroke-linecap="round"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" stroke="#ffb300" stroke-width="2" stroke-linecap="round"/><line x1="1" y1="12" x2="3" y2="12" stroke="#ffb300" stroke-width="2" stroke-linecap="round"/><line x1="21" y1="12" x2="23" y2="12" stroke="#ffb300" stroke-width="2" stroke-linecap="round"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" stroke="#ffb300" stroke-width="2" stroke-linecap="round"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" stroke="#ffb300" stroke-width="2" stroke-linecap="round"/></svg></div>
            <span class="ws-label">Claro</span>
        </div>
        <div class="wp-style-card" id="wps-wallpaper">
            <div class="ws-icon" style="background:linear-gradient(135deg,#667eea,#764ba2)"><svg viewBox="0 0 24 24" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="white" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="white"/><polyline points="21 15 16 10 5 21" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/></svg></div>
            <span class="ws-label">Fondo</span>
        </div>
        <div class="wp-style-card" id="wps-palette">
            <div class="ws-icon" style="background:linear-gradient(135deg,#f093fb,#f5576c)"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.55 0 1-.45 1-1 0-.26-.1-.5-.26-.69-.38-.46-.26-1.14.28-1.44A10 10 0 0 0 12 2z" fill="white" opacity=".8"/><circle cx="6.5" cy="11.5" r="1.5" fill="#f44336"/><circle cx="9.5" cy="7.5" r="1.5" fill="#ffeb3b"/><circle cx="14.5" cy="7.5" r="1.5" fill="#4caf50"/><circle cx="17.5" cy="11.5" r="1.5" fill="#2196f3"/></svg></div>
            <span class="ws-label">Paleta</span>
        </div>
    </div>`;

    h += renderCard([
        `<div class="detail-item" style="cursor:pointer;text-align:center" id="btn-change-wp"><span class="dt" style="color:var(--blue)">Cambiar fondo de pantalla</span></div>`
    ]);

    h += renderCard([
        renderRowItem('Paleta de colores','Ajusta colores según el fondo',renderToggle('palette',colorPalette)),
        renderRowItem('Atenuar fondo de pantalla','Atenúa en modo oscuro',renderToggle('dimwp',dimWallpaper))
    ]);

    h += `<div id="wp-grid" style="display:none;margin-top:24px">${renderSection('Fondos disponibles')}
        <div class="wallpaper-grid">
            ${wallpapers.map(w=>{
                const isActive=w.path===currentWp.path;
                const imgUrl=getAssetUrl(w.thumbnail||w.path);
                const colorHash=w.name.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
        const hue=colorHash%360;
        const fallback=`this.style.display='none';this.nextElementSibling.style.display='flex'`;
        return `<div class="wallpaper-card ${isActive?'active':''}" data-path="${esc(w.path)}"><img src="${imgUrl}" class="wp-card-img" loading="lazy" alt="${esc(w.name)}" onerror="${fallback}"><div class="wp-card-placeholder" style="display:none;background:linear-gradient(135deg,hsl(${hue},50%,35%),hsl(${(hue+40)%360},60%,25%))"></div><span class="wp-name">${esc(w.name)}</span></div>`;
            }).join('')}
        </div>
    </div>`;

    c.innerHTML=h;

    document.getElementById('btn-change-wp')?.addEventListener('click',()=>{
        document.getElementById('wp-grid').style.display='block';
        document.getElementById('wp-grid').scrollIntoView({behavior:'smooth'});
    });

    // Style quick-pick actions
    document.getElementById('wps-dark')?.addEventListener('click',async()=>{
        try{await tauriInvoke('apply_kde_theme',{name:'',isGlobal:false});}catch(e){}
        try{await tauriInvoke('set_color_scheme',{scheme:'BreezeDark'});}catch(e){}
        document.documentElement.className='dark-mode';
        toast('Modo oscuro activado');
        renderFondos(c);
    });
    document.getElementById('wps-light')?.addEventListener('click',async()=>{
        try{await tauriInvoke('apply_kde_theme',{name:'',isGlobal:false});}catch(e){}
        try{await tauriInvoke('set_color_scheme',{scheme:'BreezeLight'});}catch(e){}
        document.documentElement.className='light-mode';
        toast('Modo claro activado');
        renderFondos(c);
    });
    document.getElementById('wps-wallpaper')?.addEventListener('click',()=>{
        document.getElementById('wp-grid').style.display='block';
        document.getElementById('wp-grid').scrollIntoView({behavior:'smooth'});
    });
    document.getElementById('wps-palette')?.addEventListener('click',async()=>{
        const tog=document.querySelector('[data-toggle="palette"]');
        const next=!tog?.classList.contains('active');
        tog?.classList.toggle('active',next);
        setSetting('ColorPalette',next?'true':'false');
        toast(next?'Paleta de colores activada':'Paleta desactivada');
    });

    setupToggle('palette',async a=>{
        setSetting('ColorPalette',a?'true':'false');
        toast(a?'Paleta de colores activada':'Paleta desactivada');
    });
    setupToggle('dimwp',async a=>{
        setSetting('DimWallpaper',a?'true':'false');
        toast(a?'Atenuación activada':'Atenuación desactivada');
    });

    document.querySelectorAll('.wallpaper-card').forEach(card=>{
        card.addEventListener('click',async()=>{
            try{await tauriInvoke('set_wallpaper',{path:card.dataset.path});}catch(e){toast('Error al aplicar fondo','❌');return;}
            document.querySelectorAll('.wallpaper-card').forEach(x=>x.classList.remove('active'));
            card.classList.add('active');
            // Update preview immediately
            const previewImg=document.getElementById('wp-screen-img');
            if(previewImg)previewImg.src=card.querySelector('img')?.src||'';
            toast('Fondo de pantalla aplicado','🖼️');
        });
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Modos y Rutinas ────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

// ── SVG icon library (Lucide-style, stroke-based) ──
const SVGI = {
    // Mode icons (24px)
    moon:      `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
    briefcase: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>`,
    film:      `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/></svg>`,
    target:    `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
    // Trigger icons (18px)
    clock:     `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    plug:      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 7V2"/><path d="M15 7V2"/><rect x="6" y="7" width="12" height="10" rx="2"/></svg>`,
    batteryPlug:`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/><path d="M6 11h4"/></svg>`,
    batteryOff:`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/><line x1="6" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="6" y2="15"/></svg>`,
    wifi:      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>`,
    wifiOff:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M10.72 5.08A16 16 0 0 1 22.56 9"/><path d="M5 12.55a11 11 0 0 1 5.17-2.39"/><path d="M10.71 16.11a6 6 0 0 1 4.12-.17"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>`,
    bluetooth: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>`,
    batteryLow:`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/><path d="M6 11h2"/></svg>`,
    // Action icons (18px)
    zap:       `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    plane:     `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 4s-2 1-3.5 2.5L11 8 2.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 7.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/></svg>`,
    sun:       `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
    volume2:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    bellOff:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`,
    moonSm:    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
    palette:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="1" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r="1" fill="currentColor" stroke="none"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`,
    keyboard:  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/></svg>`,
    // UI icons
    plus:      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    x:         `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    play:      `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
    pencil:    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    trash:     `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
    chevronR:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
};

export function getRoutines(){try{return JSON.parse(localStorage.getItem('bookos_routines')||'[]');}catch{return[];}}
export function saveRoutines(r){localStorage.setItem('bookos_routines',JSON.stringify(r));}

const RB_TRIGGERS=[
    {type:'time',              svg:SVGI.clock,     label:'A una hora específica',     valueType:'time'},
    {type:'power_connected',   svg:SVGI.plug,      label:'Al conectar el cargador'},
    {type:'power_disconnected',svg:SVGI.batteryOff,label:'Al desconectar el cargador'},
    {type:'wifi_on',           svg:SVGI.wifi,      label:'Al activar el WiFi'},
    {type:'wifi_off',          svg:SVGI.wifiOff,   label:'Al desactivar el WiFi'},
    {type:'bt_on',             svg:SVGI.bluetooth, label:'Al activar Bluetooth'},
    {type:'bt_off',            svg:SVGI.bluetooth, label:'Al desactivar Bluetooth'},
    {type:'low_battery',       svg:SVGI.batteryLow,label:'Batería baja (<20%)'},
];
const RB_ACTIONS=[
    // ── Conexiones
    {type:'wifi',          svg:SVGI.wifi,     label:'WiFi',               valueType:'toggle_val', options:[['true','Activar'],['false','Desactivar']], category:'Conexiones'},
    {type:'bluetooth',     svg:SVGI.bluetooth,label:'Bluetooth',          valueType:'toggle_val', options:[['true','Activar'],['false','Desactivar']], category:'Conexiones'},
    {type:'airplane',      svg:SVGI.plane,    label:'Modo avión',         valueType:'toggle_val', options:[['true','Activar'],['false','Desactivar']], category:'Conexiones'},
    // ── Pantalla
    {type:'brightness',    svg:SVGI.sun,      label:'Brillo de pantalla', valueType:'range', min:0, max:100, default:50, category:'Pantalla'},
    {type:'vision_booster',svg:SVGI.sun,      label:'Vision Booster',     valueType:'toggle_val', options:[['true','Activar'],['false','Desactivar']], category:'Pantalla'},
    {type:'hdr',           svg:SVGI.sun,      label:'HDR',                valueType:'toggle_val', options:[['true','Activar'],['false','Desactivar']], category:'Pantalla'},
    {type:'screen_saver',  svg:SVGI.moonSm,   label:'Ahorro de pantalla', valueType:'toggle_val', options:[['true','Activar (90Hz)'],['false','Desactivar (120Hz)']], category:'Pantalla'},
    {type:'nightlight',    svg:SVGI.moonSm,   label:'Luz nocturna',       valueType:'toggle_val', options:[['true','Activar'],['false','Desactivar']], category:'Pantalla'},
    {type:'icc_profile',   svg:SVGI.palette,  label:'Perfil de color',    valueType:'select', options:[['SDC4189.icm','Estándar'],['SDC4189S.icm','sRGB'],['SDC4189A.icm','Adobe RGB'],['SDC4189P.icm','DCI-P3']], category:'Pantalla'},
    // ── Sonido
    {type:'volume',        svg:SVGI.volume2,  label:'Volumen del sistema', valueType:'range', min:0, max:100, default:50, category:'Sonido'},
    // ── Batería y rendimiento
    {type:'performance',   svg:SVGI.zap,      label:'Modo de rendimiento',valueType:'select', options:[['ahorro','Ahorro extremo'],['power-saver','Silencioso'],['balanced','Optimizado'],['performance','Rendimiento']], category:'Batería'},
    {type:'thermal',       svg:SVGI.zap,      label:'Perfil térmico',     valueType:'select', options:[['ahorro','Ahorro extremo (5W)'],['silencioso','Silencioso (8W)'],['optimizado','Optimizado (15W)'],['rendimiento','Rendimiento (28W)']], category:'Batería'},
    {type:'fan_mode',      svg:SVGI.zap,      label:'Modo ventilador',    valueType:'select', options:[['0','Automático'],['1','Silencioso'],['2','Normal']], category:'Batería'},
    {type:'charge_limit',  svg:SVGI.plug,     label:'Límite de carga',    valueType:'range', min:50, max:100, default:80, category:'Batería'},
    // ── Personalización
    {type:'theme',         svg:SVGI.palette,  label:'Tema del sistema',   valueType:'select', options:[['BreezeDark','Oscuro'],['BreezeLight','Claro']], category:'Personalización'},
    {type:'kbd_brightness',svg:SVGI.keyboard, label:'Brillo del teclado', valueType:'range', min:0, max:3, default:1, category:'Personalización'},
    // ── Notificaciones
    {type:'dnd',           svg:SVGI.bellOff,  label:'No molestar',        valueType:'toggle_val', options:[['true','Activar'],['false','Desactivar']], category:'Notificaciones'},
];

function rbTriggerLabel(t){const d=RB_TRIGGERS.find(x=>x.type===t.type);return d?(d.label+(t.value?' — '+t.value:'')):t.type;}
function rbActionLabel(a){
    const d=RB_ACTIONS.find(x=>x.type===a.type);
    if(!d)return a.type;
    if(d.valueType==='range')return d.label+' — '+a.value+'%';
    if(d.valueType==='select'||d.valueType==='toggle_val'){const o=(d.options||[]).find(x=>x[0]===a.value);return d.label+' — '+(o?o[1]:a.value);}
    return d.label;
}

export async function executeRoutine(routine){
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
            else if(a.type==='theme'){await tauriInvoke('set_color_scheme',{scheme:a.value});document.documentElement.className=a.value==='BreezeDark'?'dark-mode':'light-mode';}
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

function renderRoutinesList(routines){
    if(!routines.length)return`<div class="detail-card">${renderInfoItem('No hay rutinas','Pulsa "Nueva rutina" para crear tu primera automatización')}</div>`;
    return`<div class="detail-card">`+routines.map(r=>`
        <div class="routine-item" data-id="${esc(r.id)}">
            <div class="routine-item-main">
                <div class="routine-item-info">
                    <span class="routine-item-name">${esc(r.name||'Rutina')}</span>
                    <span class="routine-item-desc">${esc(
                        (r.triggers[0]?rbTriggerLabel(r.triggers[0]):'Sin disparador')
                        +' → '
                        +(r.actions[0]?rbActionLabel(r.actions[0]):'Sin acción')
                        +(r.actions.length>1?' +'+( r.actions.length-1)+' más':'')
                    )}</span>
                </div>
                <div class="routine-item-actions">
                    <button class="rb-icon-btn rb-btn-run" data-run="${esc(r.id)}" title="Ejecutar">${SVGI.play}</button>
                    <button class="rb-icon-btn rb-btn-edit" data-edit="${esc(r.id)}" title="Editar">${SVGI.pencil}</button>
                    <button class="rb-icon-btn rb-btn-delete" data-delete="${esc(r.id)}" title="Eliminar">${SVGI.trash}</button>
                    <div class="toggle-switch ${r.enabled?'active':''}" data-routine-toggle="${esc(r.id)}"></div>
                </div>
            </div>
            <div class="routine-item-chips">
                ${r.triggers.slice(0,3).map(t=>`<span class="routine-chip routine-chip-trigger">${rbTriggerLabel(t)}</span>`).join('')}
                ${r.actions.slice(0,4).map(a=>`<span class="routine-chip routine-chip-action">${rbActionLabel(a)}</span>`).join('')}
            </div>
        </div>
    `).join('')+`</div>`;
}

function bindRoutineEvents(c){
    c.querySelectorAll('[data-routine-toggle]').forEach(el=>{
        el.addEventListener('click',()=>{
            const routines=getRoutines(),r=routines.find(x=>x.id===el.dataset.routineToggle);
            if(r){r.enabled=!r.enabled;saveRoutines(routines);el.classList.toggle('active',r.enabled);toast(r.enabled?`"${r.name}" activada`:`"${r.name}" desactivada`);}
        });
    });
    c.querySelectorAll('[data-run]').forEach(btn=>{
        btn.addEventListener('click',async(e)=>{
            e.stopPropagation();
            const r=getRoutines().find(x=>x.id===btn.dataset.run);if(!r)return;
            btn.style.opacity='0.4';btn.disabled=true;
            await executeRoutine(r);
            btn.style.opacity='';btn.disabled=false;
            toast(`"${r.name}" ejecutada`,'✓');
        });
    });
    c.querySelectorAll('[data-edit]').forEach(btn=>{
        btn.addEventListener('click',(e)=>{
            e.stopPropagation();
            const r=getRoutines().find(x=>x.id===btn.dataset.edit);if(r)openRoutineBuilder(r,c);
        });
    });
    c.querySelectorAll('[data-delete]').forEach(btn=>{
        btn.addEventListener('click',(e)=>{
            e.stopPropagation();
            showDialog('Eliminar rutina','¿Seguro que quieres eliminar esta rutina?',{confirmText:'Eliminar',confirmClass:'danger',onConfirm:()=>{
                const routines=getRoutines().filter(x=>x.id!==btn.dataset.delete);saveRoutines(routines);
                const list=document.getElementById('routines-list');
                if(list){list.innerHTML=renderRoutinesList(routines);bindRoutineEvents(c);}
                toast('Rutina eliminada');
            }});
        });
    });
}

// ── Desktop Routine Builder Dialog ──────────────────────────────────────

function openRoutineBuilder(existing,mainContainer){
    const isEdit=!!existing;
    let routine=existing?JSON.parse(JSON.stringify(existing)):{id:crypto.randomUUID(),name:'',enabled:true,undo:false,triggers:[],actions:[]};
    if(routine.undo===undefined)routine.undo=false;
    const ov=document.createElement('div');ov.className='rb-overlay';
    const render=()=>{
        ov.innerHTML=`<div class="rb-dialog">
            <div class="rb-dialog-header">
                <span class="rb-dialog-title">${isEdit?'Editar rutina':'Nueva rutina'}</span>
                <button class="rb-dialog-close" id="rb-cancel" title="Cerrar">${SVGI.x}</button>
            </div>
            <div class="rb-dialog-namebar">
                <input class="rb-name-input" id="rb-name" placeholder="Nombre de la rutina…" value="${esc(routine.name)}" maxlength="48" spellcheck="false">
            </div>
            <div class="rb-dialog-body">
                <div class="rb-col">
                    <div class="rb-col-header">
                        <span class="rb-col-label rb-col-label-if">Si</span>
                        <span class="rb-col-hint">Condición de activación</span>
                    </div>
                    <div class="rb-col-items">
                        ${routine.triggers.length?routine.triggers.map((t,i)=>{
                            const d=RB_TRIGGERS.find(x=>x.type===t.type);
                            return`<div class="rb-item rb-item-trigger">
                                <span class="rb-item-icon rb-icon-blue">${d?.svg||SVGI.zap}</span>
                                <span class="rb-item-label">${rbTriggerLabel(t)}</span>
                                <button class="rb-item-rm" data-rm-trigger="${i}" title="Eliminar">${SVGI.x}</button>
                            </div>`;
                        }).join(''):''}
                        <button class="rb-add-row" id="rb-add-trigger">${SVGI.plus}<span>Añadir condición</span></button>
                    </div>
                </div>
                <div class="rb-col-divider"></div>
                <div class="rb-col">
                    <div class="rb-col-header">
                        <span class="rb-col-label rb-col-label-then">Entonces</span>
                        <span class="rb-col-hint">Acciones a ejecutar</span>
                    </div>
                    <div class="rb-col-items">
                        ${routine.actions.length?routine.actions.map((a,i)=>{
                            const d=RB_ACTIONS.find(x=>x.type===a.type);
                            return`<div class="rb-item rb-item-action">
                                <span class="rb-item-icon rb-icon-green">${d?.svg||SVGI.zap}</span>
                                <span class="rb-item-label">${rbActionLabel(a)}</span>
                                <button class="rb-item-rm" data-rm-action="${i}" title="Eliminar">${SVGI.x}</button>
                            </div>`;
                        }).join(''):''}
                        <button class="rb-add-row" id="rb-add-action">${SVGI.plus}<span>Añadir acción</span></button>
                    </div>
                </div>
            </div>
            <div class="rb-undo-section">
                <div class="rb-undo-row">
                    <div class="rb-undo-info">
                        <span class="rb-undo-label">Restaurar al finalizar</span>
                        <span class="rb-undo-hint">Revierte los cambios cuando la condición deje de cumplirse</span>
                    </div>
                    <div class="toggle-switch ${routine.undo?'active':''}" id="rb-undo-toggle"></div>
                </div>
            </div>
            <div class="rb-dialog-footer">
                <button class="rb-footer-cancel" id="rb-footer-cancel">Cancelar</button>
                <button class="rb-footer-save" id="rb-footer-save">Guardar rutina</button>
            </div>
        </div>`;
        bind();
    };
    const close=()=>ov.remove();
    const save=()=>{
        routine.name=(ov.querySelector('#rb-name')?.value||'').trim()||'Mi rutina';
        const routines=getRoutines(),idx=routines.findIndex(x=>x.id===routine.id);
        if(idx>=0)routines[idx]=routine;else routines.push(routine);
        saveRoutines(routines);
        const list=document.getElementById('routines-list');
        if(list){list.innerHTML=renderRoutinesList(routines);bindRoutineEvents(mainContainer);}
        close();toast(isEdit?'Rutina actualizada':'Rutina creada','✓');
    };
    function bind(){
        ov.querySelector('#rb-cancel')?.addEventListener('click',close);
        ov.querySelector('#rb-footer-cancel')?.addEventListener('click',close);
        ov.querySelector('#rb-footer-save')?.addEventListener('click',()=>{routine.name=(ov.querySelector('#rb-name')?.value||'').trim()||'Mi rutina';save();});
        ov.querySelector('#rb-name')?.addEventListener('input',e=>{routine.name=e.target.value;});
        ov.querySelector('#rb-add-trigger')?.addEventListener('click',()=>showTriggerPicker(routine,render,ov));
        ov.querySelector('#rb-add-action')?.addEventListener('click',()=>showActionPicker(routine,render,ov));
        ov.querySelectorAll('[data-rm-trigger]').forEach(b=>b.addEventListener('click',()=>{routine.triggers.splice(parseInt(b.dataset.rmTrigger),1);render();}));
        ov.querySelectorAll('[data-rm-action]').forEach(b=>b.addEventListener('click',()=>{routine.actions.splice(parseInt(b.dataset.rmAction),1);render();}));
        ov.querySelector('#rb-undo-toggle')?.addEventListener('click',()=>{routine.undo=!routine.undo;ov.querySelector('#rb-undo-toggle')?.classList.toggle('active',routine.undo);});
        ov.addEventListener('click',e=>{if(e.target===ov)close();});
    }
    document.body.appendChild(ov);render();
    requestAnimationFrame(()=>ov.querySelector('#rb-name')?.focus());
}

// ── Picker popover (desktop centered dialog) ────────────────────────────

function rbPickerDialog(title,bodyHTML,onClose){
    const ov=document.createElement('div');ov.className='rb-picker-overlay';
    ov.innerHTML=`<div class="rb-picker-dialog">
        <div class="rb-picker-header">
            <span class="rb-picker-title">${title}</span>
            <button class="rb-dialog-close" id="pk-close">${SVGI.x}</button>
        </div>
        <div class="rb-picker-body">${bodyHTML}</div>
    </div>`;
    document.body.appendChild(ov);
    const close=(val)=>{ov.remove();onClose(val);};
    ov.querySelector('#pk-close').addEventListener('click',()=>close(null));
    ov.addEventListener('click',e=>{if(e.target===ov)close(null);});
    return{ov,close};
}

function showTriggerPicker(routine,rebuild){
    const {ov}=rbPickerDialog('Añadir condición',
        `<div class="rb-pick-list">${RB_TRIGGERS.map(t=>`
            <button class="rb-pick-item" data-type="${t.type}">
                <span class="rb-pick-icon rb-icon-blue">${t.svg}</span>
                <span class="rb-pick-label">${t.label}</span>
                ${SVGI.chevronR}
            </button>`).join('')}</div>`,
        ()=>{}
    );
    ov.querySelectorAll('.rb-pick-item').forEach(item=>item.addEventListener('click',()=>{
        const type=item.dataset.type,def=RB_TRIGGERS.find(x=>x.type===type);
        ov.remove();
        if(def?.valueType==='time'){showTimeInput(val=>{if(val!==null){routine.triggers.push({type,value:val});rebuild();}});}
        else{routine.triggers.push({type});rebuild();}
    }));
}

function showActionPicker(routine,rebuild){
    // Group actions by category
    const categories=[...new Set(RB_ACTIONS.map(a=>a.category||'Otros'))];
    let listHTML='';
    categories.forEach(cat=>{
        const items=RB_ACTIONS.filter(a=>(a.category||'Otros')===cat);
        if(!items.length)return;
        listHTML+=`<div class="rb-pick-cat">${cat}</div>`;
        listHTML+=items.map(a=>`
            <button class="rb-pick-item" data-type="${a.type}">
                <span class="rb-pick-icon rb-icon-green">${a.svg}</span>
                <span class="rb-pick-label">${a.label}</span>
                ${SVGI.chevronR}
            </button>`).join('');
    });
    const {ov}=rbPickerDialog('Añadir acción',
        `<div class="rb-pick-list">${listHTML}</div>`,
        ()=>{}
    );
    ov.querySelectorAll('.rb-pick-item').forEach(item=>item.addEventListener('click',()=>{
        const type=item.dataset.type,def=RB_ACTIONS.find(x=>x.type===type);ov.remove();
        if(def?.valueType==='range')showRangeInput(def,val=>{if(val!==null){routine.actions.push({type,value:String(val)});rebuild();}});
        else if(def?.valueType==='select'||def?.valueType==='toggle_val')showSelectInput(def,val=>{if(val!==null){routine.actions.push({type,value:val});rebuild();}});
        else{routine.actions.push({type,value:'true'});rebuild();}
    }));
}

function showTimeInput(cb){
    const {ov}=rbPickerDialog('Hora de activación',
        `<div class="rb-value-body">
            <input type="time" id="rb-time-val" class="rb-time-input" value="08:00">
            <div class="rb-value-btns">
                <button class="rb-footer-cancel" id="tv-cancel">Cancelar</button>
                <button class="rb-footer-save" id="tv-ok">Añadir</button>
            </div>
        </div>`,
        ()=>cb(null)
    );
    ov.querySelector('#tv-cancel').addEventListener('click',()=>{ov.remove();cb(null);});
    ov.querySelector('#tv-ok').addEventListener('click',()=>{const v=ov.querySelector('#rb-time-val').value;ov.remove();cb(v);});
}

function showRangeInput(def,cb){
    const pct=def.default+'%';
    const {ov}=rbPickerDialog(def.label,
        `<div class="rb-value-body">
            <div class="rb-range-wrap">
                <div class="slider-container">
                    <input type="range" class="filled" id="rb-range-val" min="${def.min}" max="${def.max}" value="${def.default}" style="--fill:${pct}">
                    <span class="slider-label" id="rb-range-lbl">${def.default}${def.max===2?'':' %'}</span>
                </div>
            </div>
            <div class="rb-value-btns">
                <button class="rb-footer-cancel" id="rv-cancel">Cancelar</button>
                <button class="rb-footer-save" id="rv-ok">Añadir</button>
            </div>
        </div>`,
        ()=>cb(null)
    );
    const s=ov.querySelector('#rb-range-val'),lbl=ov.querySelector('#rb-range-lbl');
    s.addEventListener('input',()=>{const p=((s.value-s.min)/(s.max-s.min))*100;s.style.setProperty('--fill',p+'%');lbl.textContent=s.value+(def.max===2?'':' %');});
    ov.querySelector('#rv-cancel').addEventListener('click',()=>{ov.remove();cb(null);});
    ov.querySelector('#rv-ok').addEventListener('click',()=>{const v=s.value;ov.remove();cb(v);});
}

function showSelectInput(def,cb){
    const {ov}=rbPickerDialog(def.label,
        `<div class="rb-pick-list">${def.options.map(([val,label])=>`
            <button class="rb-pick-item" data-val="${esc(val)}">
                <span class="rb-pick-icon rb-icon-green">${def.svg}</span>
                <span class="rb-pick-label">${label}</span>
                ${SVGI.chevronR}
            </button>`).join('')}</div>`,
        ()=>cb(null)
    );
    ov.querySelectorAll('.rb-pick-item').forEach(item=>item.addEventListener('click',()=>{const v=item.dataset.val;ov.remove();cb(v);}));
}

export async function renderModos(c){
    c.innerHTML=renderHeader('Modos y rutinas')+renderSkeleton(2);
    let h=renderHeader('Modos y rutinas');

    // Mode cards — 4-column horizontal row
    const modes=[
        {id:'sleep', svg:SVGI.moon,      name:'Descanso',      desc:'Tema oscuro, no molestar', color:'#7b61ff'},
        {id:'work',  svg:SVGI.briefcase, name:'Trabajo',        desc:'Máximo brillo, enfocado',  color:'#0a84ff'},
        {id:'movie', svg:SVGI.film,      name:'Cine',           desc:'Tema oscuro, volumen alto',color:'#ff3b30'},
        {id:'focus', svg:SVGI.target,    name:'Concentración',  desc:'Sin distracciones',        color:'#ff9500'},
    ];
    h+=`<div class="modos-grid">`+modes.map(m=>`
        <div class="modo-card" data-modo="${m.id}">
            <div class="modo-icon" style="background:${m.color}18;color:${m.color}">${m.svg}</div>
            <div class="modo-info">
                <span class="modo-name">${m.name}</span>
                <span class="modo-desc">${m.desc}</span>
            </div>
        </div>`).join('')+`</div>`;

    const routines=getRoutines();
    h+=renderSection('Rutinas')+`<div id="routines-list">${renderRoutinesList(routines)}</div>`;
    h+=`<div class="routine-add-wrap">
        <button class="rb-new-btn" id="btn-create-routine">${SVGI.plus}<span>Nueva rutina</span></button>
    </div>`;
    c.innerHTML=h;

    // Restore saved active mode
    getSetting('active_mode','').then(am=>{
        if(am)document.querySelector(`.modo-card[data-modo="${am}"]`)?.classList.add('active');
    });

    document.querySelectorAll('.modo-card').forEach(btn=>{
        btn.addEventListener('click',async()=>{
            const id=btn.dataset.modo;
            let theme='BreezeLight',dnd=false,brightness=50;
            if(id==='sleep'){theme='BreezeDark';dnd=true;brightness=20;}
            if(id==='work'){theme='BreezeLight';dnd=true;brightness=90;}
            if(id==='movie'){theme='BreezeDark';dnd=true;brightness=60;}
            if(id==='focus'){theme='BreezeLight';dnd=true;brightness=70;}
            document.querySelectorAll('.modo-card').forEach(x=>x.classList.remove('active'));
            btn.classList.add('active');
            btn.style.opacity='0.6';
            try{
                await Promise.all([
                    tauriInvoke('set_color_scheme',{scheme:theme}).catch(()=>{}),
                    tauriInvoke('toggle_dnd',{enable:dnd}).catch(()=>{}),
                    tauriInvoke('set_brightness',{value:brightness}).catch(()=>{}),
                ]);
                document.documentElement.className=theme==='BreezeDark'?'dark-mode':'light-mode';
            }finally{btn.style.opacity='';}
            setSetting('active_mode',id);
            toast(`Modo ${btn.querySelector('.modo-name').textContent} activado`,'✓');
        });
    });

    bindRoutineEvents(c);
    document.getElementById('btn-create-routine')?.addEventListener('click',()=>openRoutineBuilder(null,c));
}

// ════════════════════════════════════════════════════════════════════════
// ── Routine snapshot / restore (for "Restaurar al finalizar") ──────────
// ════════════════════════════════════════════════════════════════════════

/** Capture current system state for each action type in a routine */
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

/** Restore a previously captured snapshot */
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

// ════════════════════════════════════════════════════════════════════════
// ── Aplicaciones Predeterminadas (NEW) ─────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderAplicaciones(c){
    c.innerHTML=renderHeader('Aplicaciones')+renderSkeleton(3);
    let defaults={browser:'',email:'',filemanager:''};
    try{defaults=JSON.parse(await tauriInvoke('get_default_apps'));}catch(e){}

    const apps=[
        {key:'browser',icon:'🌐',label:'Navegador web',current:defaults.browser},
        {key:'email',icon:'📧',label:'Cliente de correo',current:defaults.email},
        {key:'filemanager',icon:'📁',label:'Gestor de archivos',current:defaults.filemanager}
    ];

    c.innerHTML=renderHeader('Aplicaciones')+renderSection('Apps predeterminadas')+`<div class="detail-card">${apps.map(a=>
        `<div class="app-default-item"><div class="app-default-icon">${a.icon}</div><div class="app-default-info"><span class="app-default-name">${a.label}</span><span class="app-default-current">${esc(a.current||'No configurada')}</span></div></div>`
    ).join('')}</div>`+renderSection('Acciones')+renderCard([
        `<div class="detail-item" style="text-align:center"><button class="btn btn-secondary btn-sm" id="open-mime">Abrir configuración MIME</button></div>`
    ]);

    document.getElementById('open-mime')?.addEventListener('click',async()=>{
        try{await tauriInvoke('open_mime_settings');}catch(e){}
        toast('Abriendo configuración MIME');
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Salud Digital (Android-style Digital Wellbeing) ───────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderSaludDigital(c){
    c.innerHTML=renderHeader('Salud digital')+renderSkeleton(3);
    let appUsage=[];
    let vol=50,muted=false;
    try{[appUsage,{volume:vol,muted}]=await Promise.all([
        tauriInvoke('get_app_usage').then(JSON.parse).catch(()=>[]),
        tauriInvoke('get_volume').then(JSON.parse).catch(()=>({volume:50,muted:false}))
    ]);}catch(e){}

    // If no real usage data, show placeholder usage for UI demonstration
    const hasData=Array.isArray(appUsage)&&appUsage.length>0;
    const totalMin=hasData?appUsage.reduce((s,a)=>s+(a.minutes||0),0):0;
    const totalH=Math.floor(totalMin/60),totalM=totalMin%60;

    let h=renderHeader('Salud digital');

    // Hero: today's total
    h+=`<div class="sd-hero">
        <div class="sd-hero-ring">
            <svg viewBox="0 0 100 100" width="120" height="120">
                <circle cx="50" cy="50" r="42" fill="none" stroke="var(--sbg)" stroke-width="8"/>
                <circle cx="50" cy="50" r="42" fill="none" stroke="var(--blue)" stroke-width="8"
                    stroke-dasharray="${hasData?Math.min(264,Math.round(totalMin/480*264)):0} 264"
                    stroke-dashoffset="66" stroke-linecap="round"/>
            </svg>
            <div class="sd-hero-ring-label">
                <span class="sd-hero-time">${hasData?(totalH>0?totalH+'h ':'')+totalM+'m':'0m'}</span>
                <span class="sd-hero-sub">Hoy</span>
            </div>
        </div>
        <div class="sd-hero-info">
            <span class="sd-hero-title">Uso del dispositivo</span>
            <span class="sd-hero-desc">Monitoriza cuánto tiempo usas cada aplicación.</span>
        </div>
    </div>`;

    // Screen time goal
    const goalMin=parseInt(await getSetting('sd_goal_min','480').catch(()=>'480'))||480;

    // App usage bars
    if(hasData){
        h+=renderSection('Uso por aplicación');
        const maxMin=Math.max(...appUsage.map(a=>a.minutes||0),1);
        h+=`<div class="detail-card">${appUsage.slice(0,8).map(a=>{
            const pct=Math.round((a.minutes||0)/maxMin*100);
            const m=a.minutes||0;
            const timeStr=m>=60?`${Math.floor(m/60)}h ${m%60}m`:`${m}m`;
            return `<div class="sd-app-item">
                <div class="sd-app-icon-wrap">${a.icon?`<img src="${esc(a.icon)}" class="sd-app-icon">`:
                    `<div class="sd-app-icon-ph">${(a.name||'?').charAt(0).toUpperCase()}</div>`}
                </div>
                <div class="sd-app-info">
                    <div class="sd-app-top"><span class="sd-app-name">${esc(a.name||'App')}</span><span class="sd-app-time">${timeStr}</span></div>
                    <div class="sd-app-bar-bg"><div class="sd-app-bar" style="width:${pct}%"></div></div>
                </div>
            </div>`;
        }).join('')}</div>`;
    } else {
        h+=renderSection('Uso por aplicación');
        h+=renderCard([renderInfoItem('Sin datos de uso aún','El uso se registra cuando actives el seguimiento')]);
    }

    // Volume
    h+=renderSection('Volumen y audio');
    h+=renderCard([
        `<div class="detail-item"><span class="dt">Volumen del sistema</span>${renderSlider('sd-vol',vol)}</div>`,
        renderRowItem('Silenciar','Sin sonido',renderToggle('sd-mute',muted))
    ]);

    // Screen time goal
    const goalH=Math.floor(goalMin/60),goalM=goalMin%60;
    h+=renderSection('Objetivo de tiempo de pantalla');
    h+=renderCard([
        `<div class="detail-item">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <span class="dt">Límite diario</span>
                <span style="font-size:13px;color:var(--tx2)" id="sd-goal-val">${goalH>0?goalH+'h ':''} ${goalM}m</span>
            </div>
            <input type="range" class="range-input" id="sd-goal" min="30" max="720" step="30" value="${goalMin}">
        </div>`,
        renderRowItem('Avisar al alcanzar el límite','Notificación cuando se supere el objetivo',renderToggle('sd-goal-notif',await getSetting('sd_goal_notif','false').then(v=>v==='true').catch(()=>false))),
    ]);

    // Focus mode
    h+=renderSection('Modo enfoque');
    h+=renderCard([
        renderRowItem('No molestar al activar enfoque','Silencia notificaciones en modo enfoque',renderToggle('sd-focus-dnd',await getSetting('sd_focus_dnd','false').then(v=>v==='true').catch(()=>false))),
        renderRowItem('Activar modo enfoque','Minimiza distracciones',renderToggle('sd-focus',false)),
    ]);

    c.innerHTML=h;

    setupSlider('sd-vol',async v=>{
        setSetting('sd_volume',String(v));
        try{await tauriInvoke('set_volume',{value:parseInt(v)});}catch(e){}
    });
    setupToggle('sd-mute',async a=>{try{await tauriInvoke('toggle_mute');}catch(e){}toast(a?'Silenciado':'Sonido activado','🔊');});

    const goalSlider=document.getElementById('sd-goal');
    const goalValEl=document.getElementById('sd-goal-val');
    goalSlider?.addEventListener('input',()=>{
        const v=parseInt(goalSlider.value);
        const h2=Math.floor(v/60),m2=v%60;
        if(goalValEl)goalValEl.textContent=(h2>0?h2+'h ':'')+m2+'m';
    });
    goalSlider?.addEventListener('change',()=>{
        setSetting('sd_goal_min',goalSlider.value);
        toast('Objetivo actualizado');
    });
    setupToggle('sd-goal-notif',async a=>{setSetting('sd_goal_notif',a?'true':'false');toast(a?'Avisos de objetivo activados':'Desactivados');});
    setupToggle('sd-focus-dnd',async a=>{setSetting('sd_focus_dnd',a?'true':'false');});
    setupToggle('sd-focus',async a=>{
        if(a&&await getSetting('sd_focus_dnd','false').then(v=>v==='true').catch(()=>false)){
            try{await tauriInvoke('toggle_dnd',{enable:true});}catch(e){}
        } else if(!a&&await getSetting('sd_focus_dnd','false').then(v=>v==='true').catch(()=>false)){
            try{await tauriInvoke('toggle_dnd',{enable:false});}catch(e){}
        }
        toast(a?'Modo enfoque activado':'Modo enfoque desactivado',a?'🎯':'✋');
    });

    // Refresh only the usage ring + bars every 30s (no full re-render)
    addInterval(async()=>{
        const hero=document.querySelector('.sd-hero');
        if(!hero)return;
        try{
            const usage=JSON.parse(await tauriInvoke('get_app_usage').catch(()=>'[]'));
            if(!Array.isArray(usage)||!usage.length)return;
            const totalMin=usage.reduce((s,a)=>s+(a.minutes||0),0);
            const totalH=Math.floor(totalMin/60),totalM=totalMin%60;
            const timeEl=document.querySelector('.sd-hero-time');
            if(timeEl)timeEl.textContent=(totalH>0?totalH+'h ':'')+totalM+'m';
            const dashEl=document.querySelector('.sd-hero-ring circle:last-child');
            if(dashEl)dashEl.setAttribute('stroke-dasharray',`${Math.min(264,Math.round(totalMin/480*264))} 264`);
        }catch(e){}
    },30000);
}

// ════════════════════════════════════════════════════════════════════════
// ── Accesibilidad ───────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderAccesibilidad(c){
    c.innerHTML=renderHeader('Accesibilidad')+renderSkeleton(3);
    // Rust returns: {font_dpi, contrast, invert, cursor_size} — all strings
    let s={font_dpi:'0',contrast:'5',invert:'false',cursor_size:'24'};
    let reduceMotion=false;
    try{[s,reduceMotion]=await Promise.all([
        tauriInvoke('get_accessibility_settings').then(JSON.parse),
        tauriInvoke('run_command',{cmd:'kreadconfig6',args:['--file','kwinrc','--group','Compositing','--key','AnimationSpeed','--default','3']}).then(v=>parseInt(v.trim())>=5).catch(()=>false),
    ]);}catch(e){}

    // font_dpi=0 means "auto" (system default ~96). Map to 75-150% range.
    const rawDpi=parseInt(s.font_dpi)||0;
    const fontPct=rawDpi>0?Math.round(rawDpi/96*100):100;
    const cursorSize=parseInt(s.cursor_size)||24;
    const invertActive=s.invert==='true';

    let h=renderHeader('Accesibilidad');
    h+=`<div class="acc-preview-wrap">
        <span class="acc-preview-label">Vista previa de texto</span>
        <span class="acc-preview-text" id="acc-prev-text" style="font-size:${Math.round(14*fontPct/100)}px">El texto del sistema se verá así</span>
    </div>`;
    h+=renderSection('Visión');
    h+=renderCard([
        `<div class="detail-item">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <span class="dt">Tamaño de texto</span>
                <span style="font-size:13px;color:var(--tx2);font-variant-numeric:tabular-nums" id="font-scale-val">${fontPct}%</span>
            </div>
            <input type="range" class="range-input" id="font-scale" min="75" max="150" step="5" value="${fontPct}">
        </div>`,
        renderRowItem('Colores invertidos','Invierte los colores (KWin)',renderToggle('acc-invert',invertActive)),
        renderRowItem('Reducir movimiento','Minimiza animaciones del compositor',renderToggle('acc-reduce-motion',reduceMotion))
    ]);
    h+=renderSection('Puntero del ratón');
    h+=renderCard([
        `<div class="detail-item">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <span class="dt">Tamaño del cursor</span>
                <span style="font-size:13px;color:var(--tx2);font-variant-numeric:tabular-nums" id="cursor-val">${cursorSize}px</span>
            </div>
            <input type="range" class="range-input" id="cursor-size" min="16" max="64" step="8" value="${cursorSize}">
        </div>`
    ]);
    c.innerHTML=h;

    const fontSlider=document.getElementById('font-scale');
    const fontVal=document.getElementById('font-scale-val');
    const prevText=document.getElementById('acc-prev-text');
    fontSlider?.addEventListener('input',()=>{
        const pct=parseInt(fontSlider.value);
        fontVal.textContent=pct+'%';
        prevText.style.fontSize=Math.round(14*pct/100)+'px';
    });
    fontSlider?.addEventListener('change',async()=>{
        const pct=parseInt(fontSlider.value);
        const dpi=pct===100?0:Math.round(pct/100*96); // 0 = auto/system default
        try{await tauriInvoke('set_font_scale',{dpi});}catch(e){}
        toast('Tamaño de texto actualizado');
    });

    const cursorSlider=document.getElementById('cursor-size');
    const cursorVal=document.getElementById('cursor-val');
    cursorSlider?.addEventListener('input',()=>{cursorVal.textContent=cursorSlider.value+'px';});
    cursorSlider?.addEventListener('change',async()=>{
        const size=parseInt(cursorSlider.value);
        try{await tauriInvoke('set_cursor_size',{size});}catch(e){}
        toast('Tamaño del cursor actualizado');
    });

    setupToggle('acc-invert',async a=>{
        try{await tauriInvoke('toggle_invert_colors',{enable:a});}catch(e){}
        toast(a?'Colores invertidos':'Colores normales');
    });
    setupToggle('acc-reduce-motion',async a=>{
        // Reduce animation speed in KWin
        try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','kwinrc','--group','Compositing','--key','AnimationSpeed',a?'6':'3']});}catch(e){}
        try{await tauriInvoke('run_command',{cmd:'qdbus6',args:['org.kde.KWin','/KWin','reconfigure']});}catch(e){}
        toast(a?'Movimiento reducido':'Animaciones normales');
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Funciones Avanzadas / Labs ──────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
export async function renderAvanzadas(c){
    c.innerHTML=renderHeader('Funciones avanzadas')+renderSkeleton(3);

    // Load KWin effects + compositor perf state in parallel
    let fx={blur:false,wobbly:false,magic:false},cursorFix=false;
    try{
        [fx,cursorFix]=await Promise.all([
            tauriInvoke('get_kwin_effects').then(JSON.parse).catch(()=>({blur:false,wobbly:false,magic:false})),
            tauriInvoke('get_cursor_fix_status').then(r=>JSON.parse(r).enabled).catch(()=>false),
        ]);
    }catch(e){}

    let h=renderHeader('Funciones avanzadas');

    h+=renderSection('Efectos del compositor');
    h+=renderCard([
        renderRowItem('Desenfoque de fondo','Fondo desenfocado bajo ventanas translúcidas',renderToggle('fx-blur',fx.blur)),
        renderRowItem('Ventanas elásticas','Efecto de movimiento suave al arrastrar',renderToggle('fx-wobbly',fx.wobbly)),
        renderRowItem('Efecto lámpara mágica','Animación al minimizar ventanas',renderToggle('fx-magic',fx.magic)),
    ]);

    h+=renderSection('Rendimiento');
    h+=renderCard([
        renderRowItem('Optimizar latencia del cursor','Ajusta KWin para menor latencia de entrada',renderToggle('fx-cursorfix',cursorFix)),
        renderRowItem('Reiniciar compositor','Útil si hay artefactos gráficos',`<button class="btn btn-secondary btn-sm" id="fx-restart-kwin">Reiniciar</button>`),
    ]);

    h+=`<div class="labs-hero">
        <div class="labs-hero-icon">⚗️</div>
        <div class="labs-hero-text">
            <span class="labs-hero-title">Laboratorio <span class="labs-badge">Beta</span></span>
            <span class="labs-hero-sub">Funciones experimentales. Pueden cambiar o desaparecer.</span>
        </div>
    </div>`;

    // Load lab settings from localStorage
    const labGet=(k,def='false')=>{try{return localStorage.getItem('bookos_lab_'+k)||def;}catch{return def;}};
    const labSet=(k,v)=>{try{localStorage.setItem('bookos_lab_'+k,v);}catch{}};

    h+=renderSection('Activas');
    h+=renderCard([
        renderRowItem('Animaciones reducidas','Menos movimiento en la interfaz',renderToggle('lab-reducedmotion',labGet('reducedmotion')==='true')),
        renderRowItem('Barra de estado extendida','Muestra más datos en la barra lateral',renderToggle('lab-extendedstatus',labGet('extendedstatus')==='true')),
    ]);

    h+=renderSection('En desarrollo');
    h+=`<div class="labs-grid">
        <div class="lab-card">
            <div class="lab-card-icon" style="background:#0a84ff20;color:#0a84ff">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg>
            </div>
            <div class="lab-card-info">
                <span class="lab-card-title">Panel de productividad</span>
                <span class="lab-card-desc">Vista rápida de tareas y notas</span>
            </div>
            <span class="lab-status-chip">Próximamente</span>
        </div>
        <div class="lab-card">
            <div class="lab-card-icon" style="background:#ff950020;color:#ff9500">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            </div>
            <div class="lab-card-info">
                <span class="lab-card-title">Gestos avanzados</span>
                <span class="lab-card-desc">Gestos táctiles personalizados</span>
            </div>
            <span class="lab-status-chip">Próximamente</span>
        </div>
        <div class="lab-card">
            <div class="lab-card-icon" style="background:#30d15820;color:#30d158">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            <div class="lab-card-info">
                <span class="lab-card-title">Sync de ajustes</span>
                <span class="lab-card-desc">Copia de seguridad en la nube</span>
            </div>
            <span class="lab-status-chip">Próximamente</span>
        </div>
        <div class="lab-card">
            <div class="lab-card-icon" style="background:#af52de20;color:#af52de">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
            </div>
            <div class="lab-card-info">
                <span class="lab-card-title">IA contextual</span>
                <span class="lab-card-desc">Sugerencias según tu uso</span>
            </div>
            <span class="lab-status-chip">Próximamente</span>
        </div>
    </div>`;

    c.innerHTML=h;

    // Lab toggles
    setupToggle('lab-reducedmotion',a=>{
        labSet('reducedmotion',a?'true':'false');
        document.documentElement.classList.toggle('reduced-motion',a);
        toast(a?'Animaciones reducidas activadas':'Animaciones restauradas');
    });
    setupToggle('lab-extendedstatus',a=>{
        labSet('extendedstatus',a?'true':'false');
        toast(a?'Barra extendida activada (recarga para ver)':'Barra extendida desactivada');
    });

    setupToggle('fx-blur',async a=>{
        try{await tauriInvoke('toggle_kwin_effect',{effect:'blur',enable:a});}catch(e){}
        toast(a?'Desenfoque activado':'Desenfoque desactivado');
    });
    setupToggle('fx-wobbly',async a=>{
        try{await tauriInvoke('toggle_kwin_effect',{effect:'wobbly',enable:a});}catch(e){}
        toast(a?'Ventanas elásticas activadas':'Ventanas elásticas desactivadas');
    });
    setupToggle('fx-magic',async a=>{
        try{await tauriInvoke('toggle_kwin_effect',{effect:'magic',enable:a});}catch(e){}
        toast(a?'Lámpara mágica activada':'Lámpara mágica desactivada');
    });
    setupToggle('fx-cursorfix',async a=>{
        if(a){
            try{await tauriInvoke('fix_cursor_hz');}catch(e){}
            toast('Latencia del cursor optimizada','⚡');
        } else {
            // Restore defaults
            try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','kwinrc','--group','Compositing','--key','LatencyPolicy','Medium']});}catch(e){}
            try{await tauriInvoke('run_command',{cmd:'qdbus6',args:['org.kde.KWin','/KWin','reconfigure']});}catch(e){}
            toast('Latencia restablecida a valores por defecto');
        }
    });
    document.getElementById('fx-restart-kwin')?.addEventListener('click',()=>{
        showDialog('Reiniciar compositor','KWin se reiniciará brevemente. La pantalla puede parpadear.',{
            confirmText:'Reiniciar',
            onConfirm:async()=>{
                try{await tauriInvoke('run_command',{cmd:'kwin_wayland',args:['--replace']}).catch(()=>{});} catch(e){}
                try{await tauriInvoke('run_command',{cmd:'kwin_x11',args:['--replace']}).catch(()=>{});}catch(e){}
                toast('Compositor reiniciado','♻️');
            }
        });
    });
}

// ════════════════════════════════════════════════════════════════════════
// ── Placeholder ────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════
// ── Dispositivos conectados ────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
const _SVG_HEADPHONES=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;
const _SVG_SHARE=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;

// Helper for Dispositivos rows with icon
function _devRow({id='',icon,iconColor='var(--tx2)',title,subtitle,subtitleId='',right='',extraClass='',extraStyle=''}){
    return `<div class="detail-item detail-item-row${extraClass?' '+extraClass:''}"${id?` id="${id}"`:''}${extraStyle?` style="${extraStyle}"`:''}>`+
        `<div style="flex-shrink:0;width:36px;height:36px;display:flex;align-items:center;justify-content:center;color:${iconColor}">${icon}</div>`+
        `<div style="flex:1;min-width:0;padding:0 12px"><span class="dt" style="display:block">${title}</span>${subtitle!==undefined&&subtitle!==''?`<span class="ds" style="display:block;margin-top:3px"${subtitleId?` id="${subtitleId}"`:''}>${subtitle}</span>`:''}</div>`+
        `${right}</div>`;
}

// ── Buds detail sub-page ────────────────────────────────────────────────
// EQ preset index → label mapping (matches Rust buds.rs EqPresets)
const _BUDS_EQ_PRESETS = [
    {idx:0, key:'bass',   label:'Graves'},
    {idx:1, key:'soft',   label:'Suave'},
    {idx:2, key:'dynamic',label:'Dinámico'},
    {idx:3, key:'clear',  label:'Nítido'},
    {idx:4, key:'treble', label:'Agudos'},
];
// ANC mode index → label
const _BUDS_ANC_MODES = [
    {idx:0, label:'Apagado'},
    {idx:1, label:'Reducción de ruido'},
    {idx:2, label:'Sonido ambiente'},
    {idx:3, label:'Adaptativo'},
];

// ── Connection popup modal (Samsung-style) ──
function _showBudsConnectModal(name, phase){
    let m=document.getElementById('buds-conn-modal');
    if(!m){
        m=document.createElement('div');
        m.id='buds-conn-modal';
        m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(8px);z-index:9999;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s ease';
        document.body.appendChild(m);
    }
    const icon = phase==='ok'
        ? '<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>'
        : phase==='fail'
        ? '<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
        : `<div style="width:52px;height:52px;border:4px solid var(--brd);border-top-color:var(--blue);border-radius:50%;animation:spin 1s linear infinite"></div>`;
    const label = phase==='ok'?'Conectado':phase==='fail'?'No se pudo conectar':'Conectando...';
    m.innerHTML=`<div style="background:var(--card);border-radius:20px;padding:28px 32px;min-width:260px;display:flex;flex-direction:column;align-items:center;gap:14px;box-shadow:0 12px 40px rgba(0,0,0,.3)">
        ${icon}
        <div style="font-size:16px;font-weight:600;color:var(--tx);text-align:center">${esc(name)}</div>
        <div style="font-size:13px;color:var(--tx2)">${label}</div>
    </div>`;
    if(phase==='ok'||phase==='fail'){setTimeout(()=>m.remove(),1200);}
}

async function _renderBudsDetail(c, device){
    if(!device){console.error('[Buds] device es undefined');return;}
    c.innerHTML=renderHeader(device.name||'Buds')+renderSkeleton(2);

    // Try SPP connection to get real buds status
    let status = {connected:false,battery_l:0,battery_r:0,battery_case:0,anc_mode:0,eq_preset:2,eq_enabled:true,wearing_l:false,wearing_r:false,touchpad_locked:false,model:'',error:null};
    let sppConnected = false;
    let gbcAvail = false;
    let gbcDev = null;
    if(device.connected){
        _showBudsConnectModal(device.name||'Buds','connecting');
        try{
            const r = JSON.parse(await tauriInvoke('buds_connect',{mac:device.mac}));
            if(r.connected){status=r;sppConnected=true;}
        }catch(e){console.warn('[Buds] SPP connect failed:',e);}

        if(!sppConnected){
            try{gbcAvail=await tauriInvoke('gbc_is_available');}catch(e){}
            if(gbcAvail){
                try{gbcDev=JSON.parse(await tauriInvoke('gbc_get_device'));}catch(e){console.warn('[Buds] GBC read fail:',e);}
                if(gbcDev&&gbcDev.BatteryLeft!=null){
                    status.battery_l=gbcDev.BatteryLeft;
                    status.battery_r=gbcDev.BatteryRight;
                    status.battery_case=gbcDev.BatteryCase;
                    status.wearing_l=gbcDev.WearStateLeft==='Wearing';
                    status.wearing_r=gbcDev.WearStateRight==='Wearing';
                    status.model=gbcDev.Model||'';
                }
            }
        }
        _showBudsConnectModal(device.name||'Buds', (sppConnected||gbcAvail)?'ok':'fail');
    }

    // Fallback: read UPower battery + saved settings
    let vol=50;
    try{vol=parseInt(JSON.parse(await tauriInvoke('get_volume')).volume)||50;}catch(e){}
    if(!sppConnected&&!gbcAvail){
        try{
            const batt=JSON.parse(await tauriInvoke('get_bt_device_battery',{mac:device.mac}));
            const pct=parseInt(batt.percentage)||0;
            status.battery_l=pct;status.battery_r=pct;
        }catch(e){}
    }
    if(!sppConnected){
        const savedAnc=await getSetting('buds_anc_'+device.mac,'0');
        const savedEq=await getSetting('buds_eq_'+device.mac,'2');
        status.anc_mode=parseInt(savedAnc)||0;
        status.eq_preset=parseInt(savedEq)||2;
        status.eq_enabled=true;
    }

    const battL=status.battery_l;
    const battR=status.battery_r;
    const battCase=status.battery_case;
    const fw=gbcDev?gbcDev.FirmwareVersion:'';
    const modelTag=status.model||(gbcDev?gbcDev.Model:'');

    // Icons (inline SVG, currentColor)
    const _ICO={
        earbud:'<img src="./assets/budsleft.svg" class="buds-model-icon" width="28" height="28" alt="">',
        earbudL:'<img src="./assets/budsleft.svg" class="buds-model-icon" width="28" height="28" alt="">',
        earbudR:'<img src="./assets/budsright.svg" class="buds-model-icon" width="28" height="28" alt="">',
        case:'<img src="./assets/case3.svg" class="buds-model-icon" width="28" height="28" alt="">',
        hero:'<img src="./assets/buds3pro-together.svg" class="buds-model-icon" style="width:220px;height:140px;object-fit:contain" alt="Buds3 Pro">',
        eq:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 4v6M6 14v6M12 4v2M12 10v10M18 4v10M18 18v2"/><circle cx="6" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="8" r="1.8" fill="currentColor"/><circle cx="18" cy="16" r="1.8" fill="currentColor"/></svg>',
        touch:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11V6a2 2 0 0 1 4 0v7"/><path d="M13 9a2 2 0 0 1 4 0v5"/><path d="M17 11a2 2 0 0 1 2 2v4a5 5 0 0 1-5 5h-2a5 5 0 0 1-4.3-2.5L5 15"/><path d="M9 11a2 2 0 0 0-2 2v1"/></svg>',
        voice:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
        conn:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
        adv:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.5 5.5L20 8.5l-4 4 1 5.5L12 15.5 7 18l1-5.5-4-4 5.5-1z"/></svg>',
        a11y:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.5" r="1.8"/><path d="M5 8l7 2 7-2M12 10v5l-3 6M12 15l3 6"/></svg>',
        find:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.3-4.3"/></svg>',
        diag:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>',
        about:'<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg>',
        chevron:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
    };

    // Circular battery ring — icon inside, "Label %" below
    function _battRing(pct,label,icon){
        const r=30,c=2*Math.PI*r;
        const p=Math.max(0,Math.min(100,pct||0));
        const off=c*(1-p/100);
        const col=p>50?'#4cd964':p>20?'#ffcc00':p>10?'#ff9500':'#ff3b30';
        return `<div style="display:flex;flex-direction:column;align-items:center;gap:8px;min-width:86px">
            <div style="position:relative;width:70px;height:70px">
                <svg width="70" height="70" viewBox="0 0 70 70">
                    <circle cx="35" cy="35" r="${r}" fill="none" stroke="rgba(128,128,128,.18)" stroke-width="4"/>
                    <circle cx="35" cy="35" r="${r}" fill="none" stroke="${col}" stroke-width="4" stroke-linecap="round"
                        stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 35 35)"/>
                </svg>
                <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--tx)">${icon||''}</span>
            </div>
            <span style="font-size:12.5px;color:var(--tx);font-weight:500">${esc(label)} ${p}%</span>
        </div>`;
    }

    // ANC stepper — ordered per Samsung app: Off → Ambient → Adaptive → ANC
    const _ancSteps=[
        {idx:0,label:'Desactivado'},
        {idx:2,label:'Sonido Ambiente'},
        {idx:3,label:'Adaptable'},
        {idx:1,label:'Cancelación activa de ruido'},
    ];
    function _ancStepper(active){
        const n=_ancSteps.length;
        const aIdx=Math.max(0,_ancSteps.findIndex(s=>s.idx===active));
        const ease='cubic-bezier(.4,0,.2,1)';
        const slot=100/n;
        return `<div class="buds-anc-stepper" data-active-i="${aIdx}" data-n="${n}" style="padding:20px 18px 18px;position:relative">
            <div class="anc-inner" style="position:relative">
                <div class="anc-track" style="position:absolute;top:8.5px;left:${slot/2}%;right:${slot/2}%;height:3px;background:rgba(128,128,128,.25);border-radius:2px;z-index:0"></div>
                <div class="anc-beam" style="position:absolute;top:8.5px;left:${slot/2}%;height:3px;background:var(--blue);border-radius:2px;z-index:1;pointer-events:none;width:0;transform:translateZ(0);will-change:width"></div>
                <div class="anc-thumb-halo" style="position:absolute;top:-5px;left:0;width:30px;height:30px;margin-left:-15px;border-radius:50%;background:radial-gradient(circle,rgba(10,132,255,.35) 0%,rgba(10,132,255,0) 70%);z-index:2;pointer-events:none;filter:blur(2px);transform:translate3d(0,0,0);will-change:transform"></div>
                <div class="anc-thumb" style="position:absolute;top:3px;left:0;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--blue);box-shadow:0 2px 6px rgba(10,132,255,.5),0 0 0 4px rgba(10,132,255,.18);z-index:4;pointer-events:none;transform:translate3d(0,0,0);will-change:transform"></div>
                <div class="anc-grid" style="display:grid;grid-template-columns:repeat(${n},1fr);position:relative;z-index:3">
                    ${_ancSteps.map((s,i)=>{const on=s.idx===active;return `<button class="buds-anc-node" data-anc="${s.idx}" data-i="${i}" style="background:none;border:none;padding:0;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:12px;position:relative">
                        <span class="anc-dot" style="width:8px;height:8px;border-radius:50%;background:${on?'transparent':'rgba(128,128,128,.45)'};margin-top:6px;transition:background .3s ${ease}"></span>
                        <span class="anc-lbl" style="font-size:11px;text-align:center;color:${on?'var(--blue)':'var(--tx2)'};font-weight:${on?'600':'400'};line-height:1.25;max-width:78px;transition:color .3s ${ease},font-weight .3s ${ease}">${esc(s.label)}</span>
                    </button>`;}).join('')}
                </div>
            </div>
        </div>`;
    }
    function _ancPositionThumb(card){
        if(!card)return;
        const inner=card.querySelector('.anc-inner');
        if(!inner)return;
        const w=inner.getBoundingClientRect().width;
        if(!w)return;
        const n=parseInt(card.dataset.n||'4');
        const i=parseInt(card.dataset.activeI||'0');
        const slotPx=w/n;
        const xPx=slotPx*(i+0.5);
        const thumb=card.querySelector('.anc-thumb');
        const halo=card.querySelector('.anc-thumb-halo');
        const beam=card.querySelector('.anc-beam');
        if(thumb){thumb.style.transform=`translate3d(${xPx}px,0,0)`;}
        if(halo){halo.style.transform=`translate3d(${xPx}px,0,0)`;}
        if(beam){beam.style.width=`${slotPx*i}px`;}
    }

    // Samsung-style row: icon + (title+blue subtitle) + chevron
    function _sRow(title,sub,id,icon,clickable=true){
        return `<div class="buds-s-row" ${id?`id="${id}"`:''} style="padding:14px 18px;display:flex;align-items:center;gap:14px;${clickable?'cursor:pointer':''}">
            <span style="color:var(--tx2);flex-shrink:0;display:flex;align-items:center;justify-content:center;width:28px;height:28px">${icon||''}</span>
            <div style="flex:1;display:flex;flex-direction:column;gap:2px;min-width:0">
                <span style="font-size:14px;color:var(--tx);font-weight:500">${esc(title)}</span>
                ${sub?`<span style="font-size:13px;color:var(--blue)">${esc(sub)}</span>`:''}
            </div>
            <span style="color:var(--tx2);opacity:.6;flex-shrink:0">${SVGI.chevronR}</span>
        </div>`;
    }
    function _sCard(rows){
        // rows can be string OR {row, expand} — expand slides in right below its row
        const items=rows.map(r=>typeof r==='string'?{row:r}:r);
        const sep='<div style="height:1px;background:var(--brd);margin-left:60px"></div>';
        return `<div class="detail-card" style="padding:0;margin:10px 16px;overflow:hidden">
            ${items.map((it,i)=>it.row+(it.expand||'')+(i<items.length-1?sep:'')).join('')}
        </div>`;
    }
    function _sExpand(id,options,currentVal){
        return `<div id="${id}" class="buds-exp" style="display:none;padding:0 16px 14px"><div class="res-list" style="margin-bottom:0">
            ${options.map(o=>`<div class="res-item ${String(o.value)===String(currentVal)?'active':''}" data-v="${esc(String(o.value))}"><span>${esc(o.label)}</span></div>`).join('')}
        </div></div>`;
    }

    const avatarUrl=gbcDev&&gbcDev.DeviceImage?gbcDev.DeviceImage:'';
    const autoAmbient=!!(gbcDev&&(gbcDev.AmbientSoundMode||gbcDev.AutoSwitchAudioOutput));

    let h='';
    // Top bar: connect button right-aligned (no floating avatar)
    h+=`<div style="display:flex;align-items:center;justify-content:flex-end;padding:10px 16px 0">
        <button class="bk-dbtn confirm" id="buds-conn-btn" style="flex:0 0 auto;width:auto;height:34px;padding:0 18px;font-size:13px;border-radius:17px">${device.connected?'Desconectar':'Conectar'}</button>
    </div>`;

    // Hero: big earbuds illustration (or DeviceImage if GBC provides it)
    h+=`<div style="display:flex;justify-content:center;padding:10px 16px 4px">
        ${avatarUrl
            ?`<img src="${esc(avatarUrl)}" style="width:220px;height:140px;object-fit:contain">`
            :_ICO.hero}
    </div>`;

    // Name centered
    h+=`<div style="text-align:center;padding:6px 16px 16px">
        <div style="font-size:18px;font-weight:600;color:var(--tx)">${esc(device.name)}</div>
        ${modelTag?`<div style="font-size:12px;color:var(--tx2);margin-top:3px">${esc(modelTag)}${fw?' · '+esc(fw):''}</div>`:''}
    </div>`;

    // 3 battery rings with earbud/case icons inside
    h+=`<div id="buds-rings" style="display:flex;justify-content:center;gap:22px;padding:0 16px 18px">
        ${_battRing(battL,'Izda',_ICO.earbudL)}
        ${_battRing(battR,'Dcha',_ICO.earbudR)}
        ${_battRing(battCase,'Estuche',_ICO.case)}
    </div>`;

    // ANC card: stepper + auto-ambient toggle
    h+=`<div class="detail-card" style="padding:0;margin:0 16px 10px;overflow:hidden">
        ${_ancStepper(status.anc_mode)}
        <div style="height:1px;background:var(--brd);margin:0 18px"></div>
        <div style="padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:14px">
            <span style="font-size:14px;color:var(--tx)">Cambio automático a sonido ambiente</span>
            ${renderToggle('buds-auto-ambient',autoAmbient)}
        </div>
    </div>`;

    // Settings groups (Samsung style rows)
    const eqSubtitle=status.eq_enabled?(_BUDS_EQ_PRESETS.find(p=>p.idx===status.eq_preset)?.label||'Estándar'):'Plano';
    const touchSubtitle=status.touchpad_locked?'Bloqueado':'Estándar';
    const eqOpts=[{value:'-1',label:'Plano'}].concat(_BUDS_EQ_PRESETS.map(p=>({value:String(p.idx),label:p.label})));
    const eqCur=String(status.eq_enabled?status.eq_preset:-1);
    h+=_sCard([
        {row:_sRow('Calidad y efectos de sonido',eqSubtitle,'buds-row-eq',_ICO.eq),
         expand:_sExpand('buds-eq-list',eqOpts,eqCur)},
        _sRow('Controles de auriculares','','buds-row-touch',_ICO.touch),
        _sRow('Controles de voz','','buds-row-voice',_ICO.voice),
    ]);
    h+=_sCard([
        _sRow('Administrar conexiones','','buds-row-conn',_ICO.conn),
        _sRow('Funciones avanzadas','','buds-row-adv',_ICO.adv),
    ]);
    h+=_sCard([_sRow('Accesibilidad','','buds-row-a11y',_ICO.a11y)]);
    h+=_sCard([
        _sRow('Buscar mis auriculares','','buds-row-find',_ICO.find),
        _sRow('Diagnóstico','','buds-row-diag',_ICO.diag),
    ]);
    h+=_sCard([_sRow('Acerca de los auriculares','','buds-row-about',_ICO.about)]);

    c.innerHTML=renderHeader(device.name||'Buds')+h;

    // BT connect/disconnect button — master poll picks up transition + re-renders
    document.getElementById('buds-conn-btn')?.addEventListener('click',async()=>{
        const btn=document.getElementById('buds-conn-btn');
        btn.disabled=true;btn.textContent=device.connected?'Desconectando...':'Conectando...';
        try{
            if(device.connected){
                await tauriInvoke('buds_disconnect').catch(()=>{});
                await tauriInvoke('disconnect_bluetooth',{mac:device.mac});
            } else {
                await tauriInvoke('connect_bluetooth',{mac:device.mac});
            }
        }catch(e){
            toast('Error de conexión');
            btn.disabled=false;btn.textContent=device.connected?'Desconectar':'Conectar';
        }
    });

    // ANC stepper nodes
    let _lastAnc=status.anc_mode;
    function _ancApply(mode){
        const card=document.querySelector('.buds-anc-stepper');
        if(!card) return;
        const inner=card.querySelector('.anc-inner');
        if(!inner) return;
        const n=parseInt(card.dataset.n||String(_ancSteps.length));
        const newI=_ancSteps.findIndex(s=>s.idx===mode);
        if(newI<0) return;
        const curI=parseInt(card.dataset.activeI||'0');
        if(newI===curI) return;
        const w=inner.getBoundingClientRect().width;
        if(!w) return;
        const slotPx=w/n;
        const fromX=slotPx*(curI+0.5);
        const toX=slotPx*(newI+0.5);
        const fromW=slotPx*curI, toW=slotPx*newI;
        const dist=Math.abs(newI-curI);
        const dur=Math.min(420, 320+dist*30);
        const spring='cubic-bezier(.3,.3,.2,.9)';
        const nodes=card.querySelectorAll('.buds-anc-node');
        const thumb=card.querySelector('.anc-thumb');
        const halo=card.querySelector('.anc-thumb-halo');
        const beam=card.querySelector('.anc-beam');
        const oldNode=nodes[curI], newNode=nodes[newI];

        // labels swap
        if(oldNode){
            const l=oldNode.querySelector('.anc-lbl'); if(l){l.style.color='var(--tx2)';l.style.fontWeight='400';}
            const d=oldNode.querySelector('.anc-dot'); if(d) d.style.background='rgba(128,128,128,.45)';
        }
        if(newNode){
            const l=newNode.querySelector('.anc-lbl'); if(l){l.style.color='var(--blue)';l.style.fontWeight='600';}
            const d=newNode.querySelector('.anc-dot'); if(d) d.style.background='transparent';
        }

        // thumb — pure transform, GPU composited
        if(thumb){
            thumb.animate([
                {transform:`translate3d(${fromX}px,0,0) scale(1,1)`},
                {transform:`translate3d(${(fromX+toX)/2}px,0,0) scale(${1+0.2*Math.min(dist,2)},.82)`, offset:0.55},
                {transform:`translate3d(${toX}px,0,0) scale(1,1)`}
            ],{duration:dur, easing:spring, fill:'forwards'});
        }
        if(halo){
            halo.animate([
                {transform:`translate3d(${fromX}px,0,0) scale(1)`, opacity:.85},
                {transform:`translate3d(${(fromX+toX)/2}px,0,0) scale(1.35)`, opacity:1, offset:0.55},
                {transform:`translate3d(${toX}px,0,0) scale(1)`, opacity:.85}
            ],{duration:dur, easing:spring, fill:'forwards'});
        }
        if(beam){
            beam.animate([
                {width:`${fromW}px`},
                {width:`${toW}px`}
            ],{duration:dur, easing:spring, fill:'forwards'});
        }

        card.dataset.activeI=String(newI);
    }
    // Initial thumb/beam positioning (needs layout)
    requestAnimationFrame(()=>{
        const card=document.querySelector('.buds-anc-stepper');
        if(card) _ancPositionThumb(card);
    });
    // Reposition on window resize
    const _ancResize=()=>{
        const card=document.querySelector('.buds-anc-stepper');
        if(card) _ancPositionThumb(card);
    };
    window.removeEventListener('resize',window.__ancResize||(()=>{}));
    window.__ancResize=_ancResize;
    window.addEventListener('resize',_ancResize);
    document.querySelectorAll('.buds-anc-node').forEach(btn=>{
        btn.addEventListener('click',async()=>{
            const mode=parseInt(btn.dataset.anc);
            _ancApply(mode);
            if(sppConnected){
                try{await tauriInvoke('buds_set_anc',{mode});}
                catch(e){toast('Error al cambiar ANC');}
            } else if(gbcAvail){
                try{
                    let act=null;
                    if(mode===1) act='AncToggle';
                    else if(mode===2) act='AmbientToggle';
                    else if(mode===0){
                        if(_lastAnc===1) act='AncToggle';
                        else if(_lastAnc===2) act='AmbientToggle';
                    }
                    if(act) await tauriInvoke('gbc_execute_action',{action:act});
                }catch(e){toast('Error GBC: '+e);}
            }
            _lastAnc=mode;
            setSetting('buds_anc_'+device.mac, String(mode));
            const lbl=_ancSteps.find(m=>m.idx===mode)?.label||'';
            toast(lbl);
        });
    });

    // Auto-ambient toggle (GBC only — SPP cmd TBD)
    setupToggle('buds-auto-ambient',async a=>{
        if(gbcAvail){
            try{await tauriInvoke('gbc_execute_action',{action:'AmbientToggle'});}catch(e){}
        }
        toast(a?'Cambio automático activado':'Cambio automático desactivado');
    });

    // Row: Calidad y efectos de sonido → toggle inline expansion
    document.getElementById('buds-row-eq')?.addEventListener('click',()=>{
        const el=document.getElementById('buds-eq-list');
        if(el)el.style.display=el.style.display==='none'?'block':'none';
    });
    document.querySelectorAll('#buds-eq-list [data-v]').forEach(item=>{
        item.addEventListener('click',async()=>{
            const idx=parseInt(item.dataset.v);
            const enabled=idx>=0;
            document.querySelectorAll('#buds-eq-list [data-v]').forEach(x=>x.classList.remove('active'));
            item.classList.add('active');
            if(sppConnected){
                try{await tauriInvoke('buds_set_eq',{preset:enabled?idx:0,enabled});}
                catch(e){toast('Error EQ');}
            } else if(gbcAvail){
                try{await tauriInvoke('gbc_execute_action',{action:'EqualizerNextPreset'});}catch(e){}
            }
            if(enabled)setSetting('buds_eq_'+device.mac,String(idx));
            status.eq_enabled=enabled;status.eq_preset=enabled?idx:2;
            const lbl=enabled?(_BUDS_EQ_PRESETS.find(p=>p.idx===idx)?.label||''):'Plano';
            const sub=document.querySelectorAll('#buds-row-eq span')[2];
            if(sub)sub.textContent=lbl;
            toast('EQ: '+lbl);
        });
    });

    // Row: Controles de auriculares → full sub-page
    document.getElementById('buds-row-touch')?.addEventListener('click',()=>{
        if(window.pushSubNav)window.pushSubNav(()=>_renderBudsDetail(c,device));
        window.clearPageIntervals?.();
        _renderBudsTouch(c,device,status,sppConnected,gbcAvail);
    });

    // Row: Buscar mis auriculares
    document.getElementById('buds-row-find')?.addEventListener('click',async()=>{
        if(gbcAvail){
            try{await tauriInvoke('gbc_execute_action',{action:'StartStopFind'});toast('Sonido de localización');}
            catch(e){toast('Error al localizar');}
        } else {toast('Requiere Galaxy Buds Client');}
    });

    // Row: Acerca de
    document.getElementById('buds-row-about')?.addEventListener('click',()=>{
        toast(`${modelTag||'Galaxy Buds'}${fw?' · FW '+fw:''}`);
    });

    // Stubs for non-implemented rows
    ['buds-row-voice','buds-row-conn','buds-row-adv','buds-row-a11y','buds-row-diag'].forEach(id=>{
        document.getElementById(id)?.addEventListener('click',()=>toast('Próximamente'));
    });

    // Live refresh: update battery rings
    function _renderRingsLive(bl,br,bc){
        const rings=document.getElementById('buds-rings');
        if(!rings) return;
        rings.innerHTML=_battRing(bl,'Izda',_ICO.earbudL)+_battRing(br,'Dcha',_ICO.earbudR)+_battRing(bc,'Estuche',_ICO.case);
    }

    // Master poll: detect BT connect/disconnect transitions + live battery
    let _wasConnected=device.connected;
    addInterval(async()=>{
        // Abort if DOM swapped away (user navigated)
        if(!document.getElementById('buds-rings'))return;
        let nowConnected=false, freshDev=null;
        try{
            const list=JSON.parse(await tauriInvoke('get_bluetooth_devices'));
            freshDev=list.find(d=>d.mac===device.mac);
            nowConnected=!!(freshDev&&freshDev.connected);
        }catch(e){return;}

        // Connect state transition → full re-render
        if(nowConnected!==_wasConnected){
            if(window._pageIntervals){window._pageIntervals.forEach(clearInterval);window._pageIntervals=[];}
            _renderBudsDetail(c, freshDev||Object.assign({},device,{connected:nowConnected}));
            return;
        }

        // Still connected: update battery rings
        if(nowConnected){
            if(sppConnected){
                try{
                    const r=JSON.parse(await tauriInvoke('buds_get_status'));
                    _renderRingsLive(r.battery_l,r.battery_r,r.battery_case);
                }catch(e){}
            } else if(gbcAvail){
                try{
                    const d=JSON.parse(await tauriInvoke('gbc_get_device'));
                    _renderRingsLive(d.BatteryLeft,d.BatteryRight,d.BatteryCase);
                }catch(e){}
            } else {
                try{
                    const b=JSON.parse(await tauriInvoke('get_bt_device_battery',{mac:device.mac}));
                    const pct=parseInt(b.percentage)||0;
                    _renderRingsLive(pct,pct,0);
                }catch(e){}
            }
        }
    },3000);
}

// ── Controles táctiles sub-page ───────────────────────────────────────────
async function _renderBudsTouch(c,device,status,sppConnected,gbcAvail){
    const mac=device.mac;
    const _k=s=>'buds_'+s+'_'+mac;

    // Action maps
    const PINCH_OPTS=[
        {value:'noise',label:'Controles de ruido'},
        {value:'sound',label:'Controles de sonido'},
        {value:'volume',label:'Volumen'},
    ];
    const TAP1_OPTS=[
        {value:'playpause',label:'Reproducir o pausar música'},
        {value:'none',label:'Ninguno'},
    ];
    const TAP2_OPTS=[
        {value:'next',label:'Reproducir siguiente canción'},
        {value:'prev',label:'Reproducir canción anterior'},
        {value:'volup',label:'Subir volumen'},
        {value:'voldown',label:'Bajar volumen'},
        {value:'none',label:'Ninguno'},
    ];
    const TAP3_OPTS=TAP2_OPTS;
    const LONG_OPTS=[
        {value:'custom',label:'Ejecutar acción personalizada'},
        {value:'voice',label:'Asistente de voz'},
        {value:'none',label:'Ninguno'},
    ];

    // Load persisted per-device settings
    const [pinchL,pinchR,tap1,tap2,tap3,lng,pinchLEn,pinchREn,tap1En,tap2En,tap3En,lngEn]=await Promise.all([
        getSetting(_k('pinchL'),'noise'),
        getSetting(_k('pinchR'),'noise'),
        getSetting(_k('tap1'),'playpause'),
        getSetting(_k('tap2'),'next'),
        getSetting(_k('tap3'),'prev'),
        getSetting(_k('long'),'custom'),
        getSetting(_k('pinchLEn'),'1'),
        getSetting(_k('pinchREn'),'1'),
        getSetting(_k('tap1En'),'1'),
        getSetting(_k('tap2En'),'1'),
        getSetting(_k('tap3En'),'1'),
        getSetting(_k('longEn'),'1'),
    ]);
    const state={pinchL,pinchR,tap1,tap2,tap3,long:lng,
        pinchLEn:pinchLEn==='1',pinchREn:pinchREn==='1',
        tap1En:tap1En==='1',tap2En:tap2En==='1',tap3En:tap3En==='1',longEn:lngEn==='1'};

    const labelOf=(opts,v)=>opts.find(o=>o.value===v)?.label||'';

    function rowHTML(id,title,subtitle,toggleId,toggleOn,pickable=true){
        return `<div class="buds-tc-row" ${id?`id="${id}"`:''} style="padding:14px 18px;display:flex;align-items:center;gap:14px;${pickable?'cursor:pointer':''}">
            <div style="flex:1;display:flex;flex-direction:column;gap:3px;min-width:0">
                <span style="font-size:14px;color:var(--tx);font-weight:500">${esc(title)}</span>
                ${subtitle?`<span style="font-size:13px;color:${pickable?'var(--blue)':'var(--tx2)'}">${esc(subtitle)}</span>`:''}
            </div>
            ${toggleId?renderToggle(toggleId,toggleOn):''}
        </div>`;
    }
    function expHTML(id,opts,cur){
        return `<div id="${id}" class="buds-exp" style="display:none;padding:0 16px 14px"><div class="res-list" style="margin-bottom:0">
            ${opts.map(o=>`<div class="res-item ${String(o.value)===String(cur)?'active':''}" data-v="${esc(String(o.value))}"><span>${esc(o.label)}</span></div>`).join('')}
        </div></div>`;
    }
    const sep='<div style="height:1px;background:var(--brd);margin:0 18px"></div>';
    const card=items=>`<div class="detail-card" style="padding:0;margin:10px 16px;overflow:hidden">${items.map((it,i)=>{
        const s=(typeof it==='string'?it:(it.row+(it.expand||'')));
        return s+(i<items.length-1?sep:'');
    }).join('')}</div>`;
    const sectionTitle=t=>`<div style="padding:20px 20px 6px;font-size:13px;color:var(--tx2);font-weight:500">${esc(t)}</div>`;

    let h=renderHeader('Controles táctiles');
    // Bloquear toques
    h+=card([rowHTML('tc-lock','Bloquear toques','Deshabilitar toques','tc-lock-tg',!!status.touchpad_locked,false)]);
    // Pinch & hold
    h+=sectionTitle('Controles de pellizcar y mantener');
    h+=card([
        {row:rowHTML('tc-pinchL','Izquierdo',labelOf(PINCH_OPTS,state.pinchL),'tc-pinchL-tg',state.pinchLEn),
         expand:expHTML('exp-pinchL',PINCH_OPTS,state.pinchL)},
        {row:rowHTML('tc-pinchR','Derecho',labelOf(PINCH_OPTS,state.pinchR),'tc-pinchR-tg',state.pinchREn),
         expand:expHTML('exp-pinchR',PINCH_OPTS,state.pinchR)},
    ]);
    // Taps
    h+=sectionTitle('Toques y acciones');
    h+=card([
        {row:rowHTML('tc-tap1','Un toque',labelOf(TAP1_OPTS,state.tap1),'tc-tap1-tg',state.tap1En),
         expand:expHTML('exp-tap1',TAP1_OPTS,state.tap1)},
        {row:rowHTML('tc-tap2','Doble toque',labelOf(TAP2_OPTS,state.tap2),'tc-tap2-tg',state.tap2En),
         expand:expHTML('exp-tap2',TAP2_OPTS,state.tap2)},
        {row:rowHTML('tc-tap3','Triple toque',labelOf(TAP3_OPTS,state.tap3),'tc-tap3-tg',state.tap3En),
         expand:expHTML('exp-tap3',TAP3_OPTS,state.tap3)},
        {row:rowHTML('tc-long','Toque y presionar',labelOf(LONG_OPTS,state.long),'tc-long-tg',state.longEn),
         expand:expHTML('exp-long',LONG_OPTS,state.long)},
    ]);
    c.innerHTML=h;

    // Bloquear toques toggle
    setupToggle('tc-lock-tg',async a=>{
        if(sppConnected){
            try{await tauriInvoke('buds_set_touch_lock',{locked:a});}catch(e){toast('Error');}
        } else if(gbcAvail){
            try{await tauriInvoke('gbc_execute_action',{action:'LockTouchpadToggle'});}catch(e){}
        }
        toast(a?'Táctil bloqueado':'Táctil activo');
    });

    // Bind picker rows — toggle inline expansion panel
    function bindPicker(rowId,expId,opts,key,toggleId){
        const row=document.getElementById(rowId);
        const exp=document.getElementById(expId);
        row?.addEventListener('click',e=>{
            if(e.target.closest('.toggle-switch'))return;
            if(exp)exp.style.display=exp.style.display==='none'?'block':'none';
        });
        exp?.querySelectorAll('[data-v]').forEach(item=>{
            item.addEventListener('click',async()=>{
                const v=item.dataset.v;
                exp.querySelectorAll('[data-v]').forEach(x=>x.classList.remove('active'));
                item.classList.add('active');
                state[key]=v;
                await setSetting(_k(key),v);
                const sub=row?.querySelectorAll('span')[1];
                if(sub)sub.textContent=labelOf(opts,v);
                toast(labelOf(opts,v));
            });
        });
        setupToggle(toggleId,async a=>{
            state[key+'En']=a;
            await setSetting(_k(key+'En'),a?'1':'0');
        });
    }
    bindPicker('tc-pinchL','exp-pinchL',PINCH_OPTS,'pinchL','tc-pinchL-tg');
    bindPicker('tc-pinchR','exp-pinchR',PINCH_OPTS,'pinchR','tc-pinchR-tg');
    bindPicker('tc-tap1','exp-tap1',TAP1_OPTS,'tap1','tc-tap1-tg');
    bindPicker('tc-tap2','exp-tap2',TAP2_OPTS,'tap2','tc-tap2-tg');
    bindPicker('tc-tap3','exp-tap3',TAP3_OPTS,'tap3','tc-tap3-tg');
    bindPicker('tc-long','exp-long',LONG_OPTS,'long','tc-long-tg');
}

// ── Book Share sub-page ──────────────────────────────────────────────────
async function _renderBookShare(c){
    c.innerHTML=renderHeader('Book Share')+renderSkeleton(2);

    // ── Fetch KDE Connect devices ──
    let kdeDevices=[];
    try{kdeDevices=JSON.parse(await tauriInvoke('get_kdeconnect_devices'));}catch(e){console.error('[BookShare]',e);}

    const _SVG_UPLOAD=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
    const _SVG_PHONE=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/></svg>`;
    const _SVG_LAPTOP=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M0 21h24"/></svg>`;

    let h=renderHeader('Book Share');

    // ── KDE Connect / Teléfono ──
    h+=renderSection('Dispositivos vinculados');
    if(kdeDevices.length===0){
        h+=renderCard([_devRow({
            icon:_SVG_PHONE,iconColor:'var(--tx2)',
            title:'Sin dispositivos KDE Connect',
            subtitle:'Instala KDE Connect en tu teléfono para vincularlos'
        })]);
    } else {
        const battIcon=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/></svg>`;
        h+=renderCard(kdeDevices.map(d=>{
            const batt=d.battery?`<span style="font-size:12px;color:var(--tx2);display:inline-flex;align-items:center;gap:3px;margin-left:6px">${battIcon}${esc(d.battery)}%</span>`:'';
            return _devRow({
                icon:_SVG_PHONE,iconColor:d.reachable?'var(--green)':'var(--tx2)',
                title:esc(d.name)+batt,
                subtitle:d.reachable?'Conectado y disponible':'Fuera de alcance'
            });
        }));
    }

    // ── Quick Share (rqs_lib built-in) ──
    h+=renderSection('Quick Share');
    h+=renderCard([_devRow({
        icon:_SVG_SHARE,iconColor:'var(--blue)',
        title:'Compartir cercano',
        subtitleId:'qs-status-sub',
        subtitle:'Inactivo',
        right:renderToggle('qs-toggle',false)
    })]);
    // Visibility selector (only when active)
    h+=`<div id="qs-visibility-row" style="display:none">`;
    h+=renderCard([_devRow({
        icon:`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
        iconColor:'var(--tx2)',
        title:'Visible para otros',
        subtitle:'Otros dispositivos pueden encontrarte',
        right:renderToggle('qs-vis-toggle',true)
    })]);
    h+=`</div>`;

    // ── Discovered devices (mDNS — same WiFi) ──
    h+=`<div id="qs-discover-section" style="display:none">`;
    h+=renderSection('Dispositivos cercanos');
    h+=`<div id="qs-devices-list">`;
    h+=renderCard([_devRow({icon:_SVG_LAPTOP,iconColor:'var(--tx2)',title:'Buscando dispositivos…',subtitle:'Mantén Quick Share activo en el otro equipo'})]);
    h+=`</div></div>`;

    // ── Wi-Fi Direct P2P devices (no WiFi compartida necesaria) ──
    const _SVG_WIFI_DIRECT=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>`;
    h+=`<div id="p2p-section" style="display:none">`;
    h+=renderSection('Wi-Fi Direct');
    h+=`<div id="p2p-devices-list">`;
    h+=renderCard([_devRow({icon:_SVG_WIFI_DIRECT,iconColor:'var(--tx2)',title:'Buscando por Wi-Fi Direct…',subtitle:'Abre Nearby Share en el S22 Ultra'})]);
    h+=`</div></div>`;

    // ── Receive section ──
    const _SVG_DOWNLOAD=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    const _SVG_FOLDER=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    h+=`<div id="qs-recv-section" style="display:none">`;
    h+=renderSection('Recibir');
    h+=renderCard([
        _devRow({
            icon:_SVG_DOWNLOAD,iconColor:'var(--green)',
            title:'Listo para recibir',
            subtitle:'Este equipo es visible para dispositivos cercanos'
        }),
        _devRow({
            id:'qs-recv-folder-row',extraStyle:'cursor:pointer',
            icon:_SVG_FOLDER,iconColor:'var(--tx2)',
            title:'Carpeta de descarga',
            subtitleId:'qs-folder-label',subtitle:'~/Descargas',
            right:`<div style="color:var(--tx2);flex-shrink:0">${SVGI.chevronR}</div>`
        })
    ]);
    h+=`<div id="qs-incoming-list"></div>`;
    h+=`</div>`;

    // ── Send file shortcut ──
    h+=renderSection('Enviar');
    h+=renderCard([_devRow({
        id:'qs-send-btn',extraStyle:'cursor:pointer',
        icon:_SVG_UPLOAD,iconColor:'var(--blue)',
        title:'Enviar archivo',
        subtitle:'Elige un archivo y selecciona un dispositivo cercano',
        right:`<div style="color:var(--tx2);flex-shrink:0">${SVGI.chevronR}</div>`
    })]);
    h+=`<div id="qs-outbound-list"></div>`;

    c.innerHTML=h;

    // ── State ──
    let qsRunning=false;
    let _unlistenTransfer=null, _unlistenDevice=null;
    let _unlistenP2PAdded=null, _unlistenP2PRemoved=null, _unlistenP2PConn=null;
    const qsDevices={};       // endpointId → EndpointInfo (mDNS)
    const p2pDevices={};      // path → P2PPeer (Wi-Fi Direct)
    const p2pConnected=new Set(); // paths of connected P2P peers
    const qsTransfers={};     // id → {msg, el} — inbound
    const qsOutbound={};      // id → {msg, el} — outbound

    const origClear=window.clearPageIntervals;
    window.clearPageIntervals=()=>{
        window.clearPageIntervals=origClear;
        if(qsRunning){
            tauriInvoke('qs_stop_discover').catch(()=>{});
            tauriInvoke('qs_stop').catch(()=>{});
        }
        _unlistenTransfer?.(); _unlistenDevice?.();
        _unlistenP2PAdded?.(); _unlistenP2PRemoved?.(); _unlistenP2PConn?.();
        origClear?.();
    };

    function _renderDevicesList(){
        const keys=Object.keys(qsDevices);
        const el=document.getElementById('qs-devices-list');
        if(!el)return;
        if(keys.length===0){
            el.innerHTML=renderCard([_devRow({icon:_SVG_LAPTOP,iconColor:'var(--tx2)',title:'Sin dispositivos encontrados',subtitle:'Asegúrate de que Quick Share esté activo en el otro equipo'})]);
            return;
        }
        el.innerHTML=renderCard(keys.map(id=>{
            const d=qsDevices[id];
            return _devRow({
                id:`qs-dev-${id}`,extraStyle:'cursor:pointer',
                icon:_SVG_LAPTOP,iconColor:'var(--blue)',
                title:esc(d.name||id),
                subtitle:esc(d.ip||'Dispositivo cercano'),
                right:`<button class="qs-send-to" data-id="${esc(id)}" style="padding:5px 14px;border-radius:20px;border:1.5px solid var(--blue);background:transparent;color:var(--blue);font-size:12px;cursor:pointer">Enviar</button>`
            });
        }));
        el.querySelectorAll('.qs-send-to').forEach(btn=>{
            btn.addEventListener('click',async e=>{
                e.stopPropagation();
                const id=btn.dataset.id;
                const d=qsDevices[id];
                if(!d)return;
                let files=[];
                try{
                    const picked=await window.__TAURI__.dialog.open({multiple:true});
                    if(!picked)return;
                    files=Array.isArray(picked)?picked:[picked];
                }catch(e){toast('No se pudo abrir el selector de archivos');return;}
                try{
                    await tauriInvoke('qs_send_files',{endpointId:id,name:d.name||'',addr:d.ip||'',files});
                    toast('Enviando…');
                }catch(e){toast('Error al enviar: '+e);}
            });
        });
    }

    function _renderP2PList(){
        const el=document.getElementById('p2p-devices-list');
        const sec=document.getElementById('p2p-section');
        if(!el)return;
        const keys=Object.keys(p2pDevices);
        if(keys.length===0){
            el.innerHTML=renderCard([_devRow({icon:_SVG_WIFI_DIRECT,iconColor:'var(--tx2)',title:'Buscando por Wi-Fi Direct…',subtitle:'Abre Nearby Share en el S22 Ultra'})]);
            return;
        }
        if(sec)sec.style.display='';
        el.innerHTML=renderCard(keys.map(path=>{
            const d=p2pDevices[path];
            const isConn=p2pConnected.has(path);
            const sig=d.strength>0?` · ${d.strength}%`:'';
            const rightBtn=isConn
                ?`<span style="font-size:12px;color:var(--green);font-weight:600">● Conectado</span>`
                :`<button class="p2p-connect-btn" data-path="${esc(path)}" data-mac="${esc(d.mac)}" data-name="${esc(d.name||d.mac)}"
                    style="padding:5px 14px;border-radius:20px;border:1.5px solid var(--blue);background:transparent;color:var(--blue);font-size:12px;cursor:pointer">
                    Conectar</button>`;
            return _devRow({
                icon:_SVG_WIFI_DIRECT,iconColor:isConn?'var(--green)':'var(--blue)',
                title:esc(d.name||d.mac),
                subtitle:`Wi-Fi Direct${sig}${isConn?' — listo para recibir':''}`,
                right:rightBtn
            });
        }));
        el.querySelectorAll('.p2p-connect-btn').forEach(btn=>{
            btn.addEventListener('click',async e=>{
                e.stopPropagation();
                btn.disabled=true;btn.textContent='Conectando…';
                try{
                    await tauriInvoke('p2p_connect',{mac:btn.dataset.mac,name:btn.dataset.name});
                    p2pConnected.add(btn.dataset.path);
                    _renderP2PList();
                    toast('Wi-Fi Direct conectado con '+btn.dataset.name);
                }catch(err){
                    toast('Error P2P: '+err);
                    btn.disabled=false;btn.textContent='Conectar';
                }
            });
        });
    }

    function _transferTitle(meta){
        if(!meta)return'Archivo';
        if(meta.text_payload)return meta.text_description||'Texto';
        if(meta.files?.length>1)return`${meta.files.length} archivos`;
        return meta.files?.[0]||meta.text_description||'Archivo';
    }
    function _transferSubIcon(meta){
        if(!meta||meta.files)return _SVG_DOWNLOAD;
        return`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    }
    function _progressBar(pct){
        return`<div style="width:100%;height:5px;border-radius:3px;background:var(--brd);overflow:hidden">
            <div style="width:${pct}%;height:100%;border-radius:3px;background:var(--blue);transition:width .25s ease"></div>
        </div>`;
    }

    function _upsertTransfer(msg){
        // Route outbound to separate list
        if(msg.rtype==='Outbound'){_upsertOutbound(msg);return;}
        const list=document.getElementById('qs-incoming-list');
        if(!list)return;
        const id=msg.id;
        qsTransfers[id]=qsTransfers[id]||{};
        qsTransfers[id].msg=msg;

        const stateStr=(msg.state||'').toLowerCase();
        const isDone=stateStr==='finished'||stateStr==='cancelled'||stateStr==='rejected'||stateStr==='disconnected';
        if(isDone){
            if(stateStr==='finished')toast(`Archivo recibido: ${_transferTitle(msg.meta)}`,'✓');
            qsTransfers[id].el?.remove();
            delete qsTransfers[id];
            return;
        }
        let el=qsTransfers[id].el;
        if(!el){
            el=document.createElement('div');
            el.style.cssText='margin-bottom:4px';
            list.appendChild(el);
            qsTransfers[id].el=el;
        }
        const title=_transferTitle(msg.meta);
        const from=msg.meta?.source?.name?`De: ${esc(msg.meta.source.name)}`:'';
        const progress=(msg.meta?.ack_bytes&&msg.meta?.total_bytes&&msg.meta.total_bytes>0)?
            Math.round(msg.meta.ack_bytes/msg.meta.total_bytes*100):null;
        const pin=msg.meta?.pin_code;
        const isWaiting=stateStr==='waitingforuserconsent'||stateStr==='waiting'||!stateStr;
        el.innerHTML=renderCard([`
            <div class="detail-item" style="flex-direction:column;align-items:flex-start;gap:10px">
                <div style="display:flex;align-items:center;gap:10px;width:100%">
                    <div style="color:var(--blue);flex-shrink:0">${_transferSubIcon(msg.meta)}</div>
                    <div style="flex:1;min-width:0">
                        <div class="dt" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
                        <div class="ds">${from||'Solicitud entrante'}</div>
                    </div>
                    <div style="font-size:12px;color:${isWaiting?'var(--blue)':'var(--tx2)'};font-weight:600;flex-shrink:0">
                        ${isWaiting?'Pendiente':progress!==null?progress+'%':esc(msg.state||'')}
                    </div>
                </div>
                ${pin?`<div style="text-align:center;width:100%;font-size:24px;font-weight:700;letter-spacing:8px;color:var(--blue);padding:4px 0">${esc(pin)}</div>`:''}
                ${isWaiting?`
                <div style="display:flex;gap:8px;width:100%">
                    <button class="qs-accept" data-tid="${esc(id)}" style="flex:1;padding:9px;border-radius:12px;border:none;background:var(--blue);color:#fff;font-size:13px;font-weight:600;cursor:pointer">Aceptar</button>
                    <button class="qs-reject" data-tid="${esc(id)}" style="flex:1;padding:9px;border-radius:12px;border:1.5px solid var(--brd);background:transparent;color:var(--tx);font-size:13px;cursor:pointer">Rechazar</button>
                </div>`:progress!==null?_progressBar(progress):''}
            </div>
        `]);
        el.querySelectorAll('.qs-accept').forEach(b=>b.addEventListener('click',async()=>{
            b.disabled=true;b.textContent='Aceptando…';
            try{await tauriInvoke('qs_action',{transferId:b.dataset.tid,accept:true});}
            catch(e){toast('Error: '+e);b.disabled=false;b.textContent='Aceptar';}
        }));
        el.querySelectorAll('.qs-reject').forEach(b=>b.addEventListener('click',async()=>{
            try{await tauriInvoke('qs_action',{transferId:b.dataset.tid,accept:false});}catch(e){toast('Error: '+e);}
        }));
    }

    function _upsertOutbound(msg){
        const list=document.getElementById('qs-outbound-list');
        if(!list)return;
        const id=msg.id;
        qsOutbound[id]=qsOutbound[id]||{};
        qsOutbound[id].msg=msg;
        const stateStr=(msg.state||'').toLowerCase();
        const isDone=stateStr==='finished'||stateStr==='cancelled'||stateStr==='rejected'||stateStr==='disconnected';
        if(isDone){
            if(stateStr==='finished')toast(`Archivo enviado: ${_transferTitle(msg.meta)}`,'✓');
            qsOutbound[id].el?.remove();
            delete qsOutbound[id];
            return;
        }
        let el=qsOutbound[id].el;
        if(!el){
            el=document.createElement('div');
            el.style.cssText='margin-bottom:4px';
            list.appendChild(el);
            qsOutbound[id].el=el;
        }
        const title=_transferTitle(msg.meta);
        const to=msg.meta?.destination?`A: ${esc(msg.meta.destination.split('/').pop()||msg.meta.destination)}`:'';
        const progress=(msg.meta?.ack_bytes&&msg.meta?.total_bytes&&msg.meta.total_bytes>0)?
            Math.round(msg.meta.ack_bytes/msg.meta.total_bytes*100):null;
        el.innerHTML=renderCard([`
            <div class="detail-item" style="flex-direction:column;align-items:flex-start;gap:10px">
                <div style="display:flex;align-items:center;gap:10px;width:100%">
                    <div style="color:var(--blue);flex-shrink:0">${_SVG_UPLOAD}</div>
                    <div style="flex:1;min-width:0">
                        <div class="dt" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
                        <div class="ds">Enviando${to?' · '+to:''}</div>
                    </div>
                    <div style="font-size:12px;color:var(--blue);font-weight:600;flex-shrink:0">${progress!==null?progress+'%':'…'}</div>
                </div>
                ${progress!==null?_progressBar(progress):''}
            </div>
        `]);
    }

    // ── Toggle Quick Share on/off ──
    setupToggle('qs-toggle',async(on)=>{
        const sub=document.getElementById('qs-status-sub');
        const visRow=document.getElementById('qs-visibility-row');
        const discSec=document.getElementById('qs-discover-section');
        const recvSec=document.getElementById('qs-recv-section');
        if(on){
            if(sub)sub.textContent='Iniciando…';
            try{
                await tauriInvoke('qs_start');
                await tauriInvoke('qs_discover');
                qsRunning=true;
                if(sub)sub.textContent='Activo — buscando dispositivos';
                if(visRow)visRow.style.display='';
                if(discSec)discSec.style.display='';
                if(recvSec)recvSec.style.display='';

                // Listen to device events
                // present=true → appeared, present=null/undefined (default) → removed
                _unlistenDevice=await window.__TAURI__.event.listen('qs-device',ev=>{
                    const d=ev.payload;
                    if(!d||!d.id)return;
                    if(d.present===true){
                        qsDevices[d.id]=d;
                    } else {
                        // removal — present is null/undefined in default struct
                        delete qsDevices[d.id];
                    }
                    _renderDevicesList();
                });
                // Listen to transfer events
                _unlistenTransfer=await window.__TAURI__.event.listen('qs-transfer',ev=>{
                    if(ev.payload)_upsertTransfer(ev.payload);
                });
                // Listen to P2P peer events (Wi-Fi Direct, no shared WiFi needed)
                _unlistenP2PAdded=await window.__TAURI__.event.listen('p2p-peer-added',ev=>{
                    const d=ev.payload;
                    if(!d||!d.path)return;
                    p2pDevices[d.path]=d;
                    document.getElementById('p2p-section')?.style.setProperty('display','');
                    _renderP2PList();
                });
                _unlistenP2PRemoved=await window.__TAURI__.event.listen('p2p-peer-removed',ev=>{
                    if(ev.payload?.path)delete p2pDevices[ev.payload.path];
                    _renderP2PList();
                    if(Object.keys(p2pDevices).length===0)
                        document.getElementById('p2p-section')?.style.setProperty('display','none');
                });
                _unlistenP2PConn=await window.__TAURI__.event.listen('p2p-connected',ev=>{
                    const peer=ev.payload;
                    if(peer?.path)p2pConnected.add(peer.path);
                    if(sub)sub.textContent='Activo — Wi-Fi Direct conectado';
                    _renderP2PList();
                    toast('Wi-Fi Direct activo con '+(peer?.name||peer?.mac||'dispositivo'));
                });
                _renderDevicesList();
            }catch(err){
                document.querySelector('[data-toggle="qs-toggle"]')?.classList.remove('active');
                if(sub)sub.textContent='Error al iniciar';
                toast('No se pudo iniciar Quick Share: '+err);
            }
        } else {
            try{await tauriInvoke('qs_stop_discover');}catch(e){}
            try{await tauriInvoke('qs_stop');}catch(e){}
            qsRunning=false;
            _unlistenTransfer?.();_unlistenDevice?.();
            _unlistenP2PAdded?.();_unlistenP2PRemoved?.();_unlistenP2PConn?.();
            _unlistenTransfer=null;_unlistenDevice=null;
            _unlistenP2PAdded=null;_unlistenP2PRemoved=null;_unlistenP2PConn=null;
            p2pConnected.clear();
            if(sub)sub.textContent='Inactivo';
            if(visRow)visRow.style.display='none';
            if(discSec)discSec.style.display='none';
            if(recvSec)recvSec.style.display='none';
            document.getElementById('p2p-section')?.style.setProperty('display','none');
        }
    });

    // ── Visibility toggle ──
    setupToggle('qs-vis-toggle',async visible=>{
        try{await tauriInvoke('qs_set_visibility',{visible});}catch(err){toast('Error: '+err);}
    });

    // ── Download folder picker ──
    document.getElementById('qs-recv-folder-row')?.addEventListener('click',async()=>{
        if(!qsRunning){toast('Activa Quick Share primero');return;}
        try{
            const dir=await window.__TAURI__.dialog.open({directory:true,multiple:false});
            if(!dir)return;
            await tauriInvoke('qs_set_download_path',{path:dir});
            const lbl=document.getElementById('qs-folder-label');
            if(lbl)lbl.textContent=dir.replace(/^\/home\/[^/]+/,'~');
            toast('Carpeta actualizada');
        }catch(e){toast('Error: '+e);}
    });

    // ── Send file button ──
    document.getElementById('qs-send-btn')?.addEventListener('click',async()=>{
        if(!qsRunning){toast('Activa Quick Share primero');return;}
        const keys=Object.keys(qsDevices);
        if(keys.length===0){toast('Sin dispositivos cercanos encontrados');return;}
        let files=[];
        try{
            const picked=await window.__TAURI__.dialog.open({multiple:true});
            if(!picked)return;
            files=Array.isArray(picked)?picked:[picked];
        }catch(e){toast('No se pudo abrir el selector de archivos');return;}
        if(keys.length===1){
            const d=qsDevices[keys[0]];
            try{await tauriInvoke('qs_send_files',{endpointId:keys[0],name:d.name||'',addr:d.ip||'',files});toast('Enviando…');}
            catch(e){toast('Error al enviar: '+e);}
            return;
        }
        // Multiple devices — show picker
        showDialog('¿A qué dispositivo?',
            `<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${keys.map(id=>`<button class="qs-pick-dev" data-id="${esc(id)}" style="padding:9px 14px;border-radius:10px;border:1.5px solid var(--brd);background:transparent;color:var(--tx);text-align:left;cursor:pointer">${esc(qsDevices[id].name||id)}</button>`).join('')}</div>`,
            {confirmText:'Cancelar',cancelText:'',onConfirm:()=>{}});
        setTimeout(()=>{
            document.querySelectorAll('.qs-pick-dev').forEach(btn=>btn.addEventListener('click',async()=>{
                const id=btn.dataset.id;const d=qsDevices[id];
                document.querySelector('.bk-overlay')?.remove();
                try{await tauriInvoke('qs_send_files',{endpointId:id,name:d.name||'',addr:d.ip||'',files});toast('Enviando…');}
                catch(e){toast('Error al enviar: '+e);}
            }));
        },100);
    });

    // ── Refresh KDE Connect battery every 60s ──
    addInterval(async()=>{
        try{
            const devs=JSON.parse(await tauriInvoke('get_kdeconnect_devices'));
            devs.forEach(d=>{
                document.querySelectorAll('.detail-item.detail-item-row').forEach(row=>{
                    if(row.querySelector('.dt')?.textContent?.includes(d.name)){
                        const sub=row.querySelector('.ds');
                        if(sub)sub.textContent=d.reachable?'Conectado y disponible':'Fuera de alcance';
                    }
                });
            });
        }catch(e){}
    },60000);
}

// ── Main dispositivos list ──────────────────────────────────────────────
export async function renderDispositivos(c){
    c.innerHTML=renderHeader('Dispositivos conectados')+renderSkeleton(2);

    let btDevices=[], scanning=false;
    let btEnabled=false;
    try{const st=JSON.parse(await tauriInvoke('get_bluetooth_status'));btEnabled=!!(st.enabled||st.powered);}catch(e){}
    try{if(btEnabled)btDevices=JSON.parse(await tauriInvoke('get_bluetooth_devices'));}catch(e){}

    const isAudio=d=>{
        const ic=(d.icon||'').toLowerCase(),nm=(d.name||'').toLowerCase();
        return ic.includes('headset')||ic.includes('headphone')||ic.includes('audio-head')||
               ic.includes('audio')||ic.startsWith('audio-')||
               nm.includes('buds')||nm.includes('airpods')||nm.includes('headset')||
               nm.includes('earphone')||nm.includes('galaxy buds')||nm.includes('pixel buds')||
               nm.includes('wf-')||nm.includes('wh-')||nm.includes('beats');
    };
    // Connected audio device with empty icon still counts
    const budsDevices=btDevices.filter(d=>isAudio(d)||(d.connected&&!d.icon));
    // Sort: connected first
    budsDevices.sort((a,b)=>(b.connected?1:0)-(a.connected?1:0));

    // Pre-fetch battery for connected buds (in parallel, best-effort)
    const battMap={};
    await Promise.all(budsDevices.filter(d=>d.connected).map(async d=>{
        try{
            const r=JSON.parse(await tauriInvoke('get_bt_device_battery',{mac:d.mac}));
            if(r.percentage)battMap[d.mac]=r.percentage;
        }catch(e){}
    }));

    function _budsSubtitle(d){
        const batt=battMap[d.mac];
        const battSpan=batt?`<span style="color:var(--tx2);font-size:12px;margin-left:6px">· 🔋${batt}%</span>`:'';
        if(d.connected) return `<span style="color:var(--green)">Conectado${battSpan}</span>`;
        return `<span style="color:var(--tx2)">Desconectado</span>`;
    }

    const _SVG_SCAN=`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;

    let h=renderHeader('Dispositivos conectados');

    // ── Galaxy Buds ──
    h+=`<div class="section-header-row"><p class="section-header" style="margin:0">Galaxy Buds</p>
        ${btEnabled?`<button class="refresh-btn" id="btn-buds-scan" title="Buscar Buds">${_SVG_SCAN}Buscar</button>`:''}
    </div>`;

    if(!btEnabled){
        h+=renderCard([_devRow({icon:_SVG_HEADPHONES,iconColor:'var(--tx2)',
            title:'Bluetooth desactivado',subtitle:'Activa Bluetooth para ver tus Buds',
            right:`<button class="bk-dbtn confirm" id="bt-enable-btn" style="font-size:13px;padding:6px 14px;flex-shrink:0">Activar</button>`})]);
    } else if(budsDevices.length===0){
        h+=renderCard([_devRow({id:'buds-pair',extraStyle:'cursor:pointer',
            icon:_SVG_HEADPHONES,iconColor:'var(--blue)',
            title:'Vincular nuevos Buds',subtitle:'Activa el modo emparejamiento en tus auriculares y pulsa Buscar',
            right:`<div style="color:var(--tx2);flex-shrink:0">${SVGI.chevronR}</div>`})]);
    } else {
        const _budsModelIcon=(name)=>{
            const n=(name||'').toLowerCase();
            if(n.includes('buds3 pro')||n.includes('buds 3 pro'))return '<img src="./assets/buds3pro-together.svg" class="buds-model-icon" style="width:36px;height:36px;object-fit:contain" alt="">';
            return _SVG_HEADPHONES;
        };
        h+=renderCard(budsDevices.map((d,i)=>_devRow({
            extraClass:'buds-list-row',
            extraStyle:'cursor:pointer',
            icon:_budsModelIcon(d.name),
            iconColor:d.connected?'var(--green)':'var(--tx2)',
            title:esc(d.name),
            subtitle:_budsSubtitle(d),
            right:`<div style="display:flex;align-items:center;gap:8px">
                ${!d.connected?`<button class="bk-dbtn confirm buds-quick-conn" data-idx="${i}" style="font-size:12px;padding:5px 12px;flex-shrink:0">Conectar</button>`:''}
                <div style="color:var(--tx2);flex-shrink:0">${SVGI.chevronR}</div>
            </div>`
        })));
    }

    // ── Book Share ──
    h+=renderSection('Book Share');
    h+=renderCard([_devRow({id:'bc-row',extraStyle:'cursor:pointer',
        icon:_SVG_SHARE,iconColor:'var(--blue)',
        title:'Book Share',subtitle:'Quick Share · KDE Connect · Archivos cercanos',
        right:`<div style="color:var(--tx2);flex-shrink:0">${SVGI.chevronR}</div>`})]);

    c.innerHTML=h;

    // BT enable
    document.getElementById('bt-enable-btn')?.addEventListener('click',async()=>{
        try{await tauriInvoke('toggle_bluetooth',{enable:true});}catch(e){}
        setTimeout(()=>renderDispositivos(c),1200);
    });

    // Scan button
    document.getElementById('btn-buds-scan')?.addEventListener('click',async()=>{
        const btn=document.getElementById('btn-buds-scan');
        if(!btn||scanning)return;
        scanning=true;
        btn.disabled=true;
        btn.innerHTML=`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="animation:spin .8s linear infinite"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Buscando…`;
        try{await tauriInvoke('bluetooth_scan');}catch(e){}
        // Refresh list after 7s (scan runs for 6s)
        setTimeout(()=>renderDispositivos(c),7000);
    });

    // Pair new buds → go to Bluetooth page (scan/pair UI)
    document.getElementById('buds-pair')?.addEventListener('click',()=>{
        if(window.pushSubNav)window.pushSubNav(()=>renderDispositivos(c));
        window.clearPageIntervals?.();
        renderBTPage(c);
    });

    // Quick-connect buttons (stop propagation so row click doesn't fire)
    document.querySelectorAll('.buds-quick-conn').forEach(btn=>{
        btn.addEventListener('click',async e=>{
            e.stopPropagation();
            const device=budsDevices[parseInt(btn.dataset.idx)];
            if(!device)return;
            btn.disabled=true;btn.textContent='Conectando…';
            try{await tauriInvoke('connect_bluetooth',{mac:device.mac});}catch(e){}
            setTimeout(()=>renderDispositivos(c),1200);
        });
    });

    // Each Buds row → opens Buds detail sub-page
    document.querySelectorAll('.buds-list-row').forEach((row,i)=>{
        const device=budsDevices[i];
        if(!device)return;
        row.addEventListener('click',e=>{
            if(e.target.closest('.buds-quick-conn'))return; // handled above
            if(window.pushSubNav)window.pushSubNav(()=>renderDispositivos(c));
            window.clearPageIntervals?.();
            _renderBudsDetail(c,device);
        });
    });

    document.getElementById('bc-row')?.addEventListener('click',()=>{
        if(window.pushSubNav)window.pushSubNav(()=>renderDispositivos(c));
        window.clearPageIntervals?.();
        _renderBookShare(c);
    });

    // Live status + battery refresh every 10s
    addInterval(async()=>{
        if(!document.querySelector('.buds-list-row'))return;
        try{
            const devs=JSON.parse(await tauriInvoke('get_bluetooth_devices'));
            const audio=devs.filter(isAudio);
            audio.sort((a,b)=>(b.connected?1:0)-(a.connected?1:0));
            // Update battery for connected devices
            await Promise.all(audio.filter(d=>d.connected).map(async d=>{
                try{const r=JSON.parse(await tauriInvoke('get_bt_device_battery',{mac:d.mac}));if(r.percentage)battMap[d.mac]=r.percentage;}catch(e){}
            }));
            audio.forEach((d,i)=>{
                const rows=document.querySelectorAll('.buds-list-row');
                const row=rows[i];if(!row)return;
                const sub=row.querySelector('.ds');
                if(sub){
                    const batt=battMap[d.mac];
                    const battSpan=batt&&d.connected?`<span style="color:var(--tx2);font-size:12px;margin-left:6px">· 🔋${batt}%</span>`:'';
                    sub.innerHTML=d.connected?`<span style="color:var(--green)">Conectado${battSpan}</span>`:`<span style="color:var(--tx2)">Desconectado</span>`;
                }
                const iconEl=row.querySelector('[style*="color:"]');
                if(iconEl&&iconEl.tagName==='DIV')iconEl.style.color=d.connected?'var(--green)':'var(--tx2)';
            });
        }catch(e){}
    },10000);
}

// ── Book AI ────────────────────────────────────────────────────────────
export async function renderAI(c){
    c.innerHTML=renderHeader('Inteligencia artificial')+renderSkeleton(1);
    let h=renderHeader('Inteligencia artificial');
    h+=`<div id="sem-search-card"></div>`;
    c.innerHTML=h;

    const semCard=document.getElementById('sem-search-card');
    let semPollTimer=null;

    // Spinner keyframes una vez
    if(!document.getElementById('sem-spin-style')){
        const st2=document.createElement('style');
        st2.id='sem-spin-style';
        st2.textContent='@keyframes spin{to{transform:rotate(360deg)}}';
        document.head.appendChild(st2);
    }

    const semRender=async()=>{
        let st;
        try{ st=JSON.parse(await tauriInvoke('search_status')); }
        catch(e){ semCard.innerHTML=renderCard([renderInfoItem('Error','No se puede consultar el estado del servicio.')]); return; }
        const inst=st.installed, state=st.install_state||'';
        const active=st.watcher==='active';
        const busy=(state==='installing'||state==='indexing');

        let sub;
        if(state==='installing')      sub='Instalando… descargando modelo (~500 MB)';
        else if(state==='indexing')   sub='Indexando tus documentos…';
        else if(state==='failed')     sub='Error en la instalación. Toca para reintentar.';
        else if(!inst)                sub='Busca archivos por significado. Modelo local (~500 MB)';
        else if(active)               sub=`${st.count} fragmentos indexados`;
        else                          sub=`${st.count} fragmentos · pausado`;

        const mainToggleOn = inst && active;
        const rows=[
            renderRowItem('Búsqueda semántica',
                `<span style="${state==='failed'?'color:var(--red)':''}">${sub}</span>`,
                busy
                    ? `<div style="width:20px;height:20px;border:2px solid var(--brd);border-top-color:var(--blue);border-radius:50%;animation:spin 1s linear infinite"></div>`
                    : renderToggle('sem-toggle', mainToggleOn)
            )
        ];

        if(inst && !busy){
            rows.push(
                `<div id="sem-reindex-row" class="detail-item detail-item-row" style="cursor:pointer"><div class="detail-texts"><span class="dt">Reindexar ahora</span><span class="ds">Procesa todos los archivos de nuevo</span></div><span style="color:var(--tx2)">${SVGI.chevronR}</span></div>`,
                `<div id="sem-uninstall-row" class="detail-item detail-item-row" style="cursor:pointer"><div class="detail-texts"><span class="dt" style="color:var(--red)">Desinstalar</span><span class="ds">Borra el índice y el modelo</span></div><span style="color:var(--tx2)">${SVGI.chevronR}</span></div>`
            );
        }

        let body=renderCard(rows);

        if(inst && !busy){
            body+=renderSection('Probar búsqueda');
            body+=`<div style="background:var(--card);border-radius:14px;padding:14px">
                <input id="sem-q" placeholder="Escribe para buscar…" style="width:100%;padding:10px 14px;border-radius:10px;border:none;background:var(--sbg);color:var(--tx);font-size:14px;outline:none">
                <div id="sem-results" style="margin-top:10px"></div>
            </div>`;
        }
        semCard.innerHTML=body;

        setupToggle('sem-toggle', async a=>{
            if(!inst){
                await tauriInvoke('search_install');
                semRender();
            } else {
                await tauriInvoke('search_toggle',{enable:a});
                semRender();
            }
        });
        const reidx=document.getElementById('sem-reindex-row');
        if(reidx) reidx.onclick=async()=>{ toast('Reindexando en segundo plano…'); await tauriInvoke('search_reindex'); };
        const unCh=document.getElementById('sem-uninstall-row');
        if(unCh) unCh.onclick=async()=>{
            if(confirm('¿Desinstalar búsqueda semántica?\n\nSe borrará el modelo, el índice y las dependencias (~500 MB).')){
                await tauriInvoke('search_uninstall');
                semRender();
            }
        };

        const q=document.getElementById('sem-q');
        const res=document.getElementById('sem-results');
        if(q && res){
            let dbTimer=null;
            q.oninput=()=>{
                clearTimeout(dbTimer);
                const v=q.value.trim();
                if(!v){ res.innerHTML=''; return; }
                dbTimer=setTimeout(async()=>{
                    const r=JSON.parse(await tauriInvoke('search_query',{query:v}));
                    const items=(r.results||[]).slice(0,6).map(x=>{
                        const name=(x.ruta||'').split('/').pop();
                        const dir=(x.ruta||'').split('/').slice(0,-1).join('/');
                        return `<div style="padding:10px 0;border-bottom:1px solid var(--div);display:flex;align-items:center;gap:12px">
                            <div style="flex:1;min-width:0">
                                <div style="font-weight:500;font-size:14px;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
                                <div style="font-size:12px;color:var(--tx2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(dir)}</div>
                            </div>
                            <span style="font-size:11px;color:var(--blue);font-weight:600">${Math.round((x.score||0)*100)}%</span>
                        </div>`;
                    }).join('');
                    res.innerHTML=items||`<div style="color:var(--tx2);padding:10px 0;font-size:13px">Sin resultados.</div>`;
                }, 300);
            };
        }

        clearTimeout(semPollTimer);
        if(busy){ semPollTimer=setTimeout(semRender, 2500); }
    };
    semRender();
}

// ── Ubicación ─────────────────────────────────────────────────────────────
export async function renderUbicacion(c){
    c.innerHTML=renderHeader('Ubicación')+renderSkeleton(2);
    let locEnabled=false;
    try{const r=JSON.parse(await tauriInvoke('get_location_status'));locEnabled=!!r.enabled;}catch(e){}
    const accuracy=await getSetting('loc_accuracy','high');
    let h=renderHeader('Ubicación');
    h+=renderCard([
        renderRowItem('Servicios de ubicación',locEnabled?'<span style="color:var(--green)">Activos</span>':'Desactivados',renderToggle('loc-svc',locEnabled)),
    ]);
    h+=renderSection('Precisión');
    const accOpts=[['high','Alta precisión','GPS, WiFi y redes móviles'],['medium','Ahorro de batería','Solo WiFi y redes'],['device','Solo dispositivo','Sin conexión a internet']];
    h+=renderCard(accOpts.map(([k,n,d])=>`<div class="detail-item detail-item-row" style="cursor:pointer" data-acc="${k}">
        <div style="flex:1"><span class="dt">${n}</span><span class="ds">${d}</span></div>
        <div style="width:20px;height:20px;border-radius:50%;border:2px solid ${accuracy===k?'var(--blue)':'var(--brd)'};background:${accuracy===k?'var(--blue)':'transparent'};flex-shrink:0;display:flex;align-items:center;justify-content:center">
            ${accuracy===k?'<div style="width:8px;height:8px;border-radius:50%;background:#fff"></div>':''}
        </div></div>`));
    h+=renderSection('Permisos de aplicaciones');
    const locApps=[{name:'Firefox',icon:'firefox',perm:'always'},{name:'Thunderbird',icon:'thunderbird',perm:'ask'},{name:'KDE Connect',icon:'kdeconnect',perm:'always'},{name:'Plasma',icon:'kde',perm:'always'}];
    h+=renderCard(locApps.map(a=>`<div class="detail-item detail-item-row">
        <span class="dt" style="flex:1">${a.name}</span>
        <span style="font-size:13px;color:${a.perm==='always'?'var(--green)':'var(--tx2)'}">${a.perm==='always'?'Siempre':'Preguntar'}</span>
    </div>`));
    h+=renderCard([renderInfoItem('Privacidad de ubicación','La ubicación exacta solo se usa para funciones que la requieran. Nunca se envía sin permiso.')]);
    c.innerHTML=h;
    setupToggle('loc-svc',async a=>{
        try{await tauriInvoke('set_location_enabled',{enable:a});}catch(e){}
        toast(a?'Ubicación activada':'Ubicación desactivada',a?'📍':'');
    });
    c.querySelectorAll('[data-acc]').forEach(row=>{
        row.addEventListener('click',()=>{
            setSetting('loc_accuracy',row.dataset.acc);
            renderUbicacion(c);
        });
    });
}

// ── Seguridad y emergencia ────────────────────────────────────────────────
export async function renderEmergencia(c){
    c.innerHTML=renderHeader('Seguridad y emergencia')+renderSkeleton(2);
    const medRaw=await getSetting('med_info','{}');
    const sosEnabled=await getSetting('sos_enabled','false').then(v=>v==='true');
    const locSos=await getSetting('sos_location','true').then(v=>v==='true');
    let med={};try{med=JSON.parse(medRaw);}catch(e){}
    const contactsRaw=await getSetting('emer_contacts','[]');
    let contacts=[];try{contacts=JSON.parse(contactsRaw);}catch(e){}
    let h=renderHeader('Seguridad y emergencia');
    h+=renderSection('Información médica');
    h+=renderCard([
        `<div class="detail-item" style="padding:14px 20px">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                <div><label style="font-size:12px;color:var(--tx2)">Grupo sanguíneo</label><input id="med-blood" class="about-rename-input" style="margin-top:4px" value="${esc(med.blood||'')}" placeholder="Ej. A+"></div>
                <div><label style="font-size:12px;color:var(--tx2)">Alergias</label><input id="med-allergy" class="about-rename-input" style="margin-top:4px" value="${esc(med.allergy||'')}" placeholder="Ej. Penicilina"></div>
                <div><label style="font-size:12px;color:var(--tx2)">Medicamentos</label><input id="med-meds" class="about-rename-input" style="margin-top:4px" value="${esc(med.meds||'')}" placeholder="Ej. Ibuprofeno"></div>
                <div><label style="font-size:12px;color:var(--tx2)">Condiciones</label><input id="med-cond" class="about-rename-input" style="margin-top:4px" value="${esc(med.cond||'')}" placeholder="Ej. Diabetes"></div>
            </div>
            <button class="bk-dbtn confirm" id="med-save" style="margin-top:12px;width:100%">Guardar</button>
        </div>`
    ]);
    h+=renderSection('Contactos de emergencia');
    if(contacts.length){
        h+=renderCard(contacts.map((ct,i)=>`<div class="detail-item detail-item-row">
            <div style="flex:1"><span class="dt">${esc(ct.name)}</span><span class="ds">${esc(ct.phone)}</span></div>
            <button class="bk-dbtn cancel" data-del="${i}" style="font-size:12px;padding:4px 12px">Eliminar</button>
        </div>`));
    }
    h+=renderCard([`<div class="detail-item" style="padding:14px 20px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div><label style="font-size:12px;color:var(--tx2)">Nombre</label><input id="ec-name" class="about-rename-input" style="margin-top:4px" placeholder="Nombre"></div>
            <div><label style="font-size:12px;color:var(--tx2)">Teléfono</label><input id="ec-phone" class="about-rename-input" style="margin-top:4px" placeholder="+34 600 000 000"></div>
        </div>
        <button class="bk-dbtn confirm" id="ec-add" style="margin-top:12px;width:100%">Añadir contacto</button>
    </div>`]);
    h+=renderSection('Ajustes SOS');
    h+=renderCard([
        renderRowItem('Llamada de emergencia rápida','Pulsa el botón de encendido 3 veces',renderToggle('sos-btn',sosEnabled)),
        renderRowItem('Compartir ubicación','Envía tu posición al contacto de emergencia',renderToggle('sos-loc',locSos)),
    ]);
    c.innerHTML=h;
    document.getElementById('med-save')?.addEventListener('click',()=>{
        const blood=document.getElementById('med-blood')?.value||'';
        const allergy=document.getElementById('med-allergy')?.value||'';
        const meds=document.getElementById('med-meds')?.value||'';
        const cond=document.getElementById('med-cond')?.value||'';
        setSetting('med_info',JSON.stringify({blood,allergy,meds,cond}));
        toast('Información médica guardada','✓');
    });
    document.getElementById('ec-add')?.addEventListener('click',()=>{
        const name=document.getElementById('ec-name')?.value?.trim();
        const phone=document.getElementById('ec-phone')?.value?.trim();
        if(!name||!phone)return;
        contacts.push({name,phone});
        setSetting('emer_contacts',JSON.stringify(contacts));
        renderEmergencia(c);
    });
    c.querySelectorAll('[data-del]').forEach(btn=>{
        btn.addEventListener('click',()=>{
            contacts.splice(parseInt(btn.dataset.del),1);
            setSetting('emer_contacts',JSON.stringify(contacts));
            renderEmergencia(c);
        });
    });
    setupToggle('sos-btn',a=>setSetting('sos_enabled',a));
    setupToggle('sos-loc',a=>setSetting('sos_location',a));
}

// ── Pantalla de inicio ────────────────────────────────────────────────────
export async function renderPantallaInicio(c){
    c.innerHTML=renderHeader('Pantalla de inicio')+renderSkeleton(2);
    const [desktopIcons,gridSnap,dockPos,iconSize,showLabels]=await Promise.all([
        getSetting('desktop_icons','true').then(v=>v==='true'),
        getSetting('desktop_grid','true').then(v=>v==='true'),
        getSetting('dock_position','bottom'),
        getSetting('icon_size','medium'),
        getSetting('icon_labels','true').then(v=>v==='true'),
    ]);
    let h=renderHeader('Pantalla de inicio');
    h+=renderSection('Escritorio');
    h+=renderCard([
        renderRowItem('Iconos en el escritorio','Muestra iconos de archivos y apps en el fondo',renderToggle('desk-icons',desktopIcons)),
        renderRowItem('Rejilla de alineación','Ajusta los iconos automáticamente a la cuadrícula',renderToggle('desk-grid',gridSnap)),
        renderRowItem('Etiquetas de iconos','Muestra el nombre debajo de cada icono',renderToggle('desk-labels',showLabels)),
    ]);
    h+=renderSection('Tamaño de iconos');
    const sizes=[['small','Pequeño'],['medium','Mediano'],['large','Grande']];
    h+=`<div class="detail-card" style="padding:12px 16px;display:flex;gap:8px;flex-wrap:wrap">
        ${sizes.map(([k,l])=>`<button class="buds-eq-btn${iconSize===k?' active':''}" data-size="${k}" style="padding:7px 16px;border-radius:20px;border:1.5px solid ${iconSize===k?'var(--blue)':'var(--brd)'};background:${iconSize===k?'var(--blue)':'transparent'};color:${iconSize===k?'#fff':'var(--tx)'};font-size:13px;cursor:pointer;transition:all .15s">${l}</button>`).join('')}
    </div>`;
    h+=renderSection('Panel y barra de tareas');
    const dockPositions=[['top','Arriba'],['bottom','Abajo'],['left','Izquierda'],['right','Derecha']];
    h+=renderCard(dockPositions.map(([k,l])=>`<div class="detail-item detail-item-row" style="cursor:pointer" data-dock="${k}">
        <span class="dt" style="flex:1">${l}</span>
        <div style="width:20px;height:20px;border-radius:50%;border:2px solid ${dockPos===k?'var(--blue)':'var(--brd)'};background:${dockPos===k?'var(--blue)':'transparent'};flex-shrink:0;display:flex;align-items:center;justify-content:center">
            ${dockPos===k?'<div style="width:8px;height:8px;border-radius:50%;background:#fff"></div>':''}
        </div>
    </div>`));
    h+=renderSection('Accesos directos');
    h+=renderCard([
        `<div class="detail-item detail-item-row" style="cursor:pointer" id="open-widget-browser">
            <div style="flex:1"><span class="dt">Añadir widgets</span><span class="ds">Personaliza tu escritorio con widgets de Plasma</span></div>
            <div style="color:var(--tx2);flex-shrink:0">${SVGI.chevronR}</div>
        </div>`,
        `<div class="detail-item detail-item-row" style="cursor:pointer" id="open-global-theme">
            <div style="flex:1"><span class="dt">Tema global</span><span class="ds">Gestiona apariencia del escritorio completo</span></div>
            <div style="color:var(--tx2);flex-shrink:0">${SVGI.chevronR}</div>
        </div>`,
    ]);
    c.innerHTML=h;
    setupToggle('desk-icons',async a=>{
        setSetting('desktop_icons',a);
        try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','plasma-org.kde.plasma.desktop-appletsrc','--group','Containments','--group','1','--group','General','--key','showToolTips',a?'true':'false']});}catch(e){}
    });
    setupToggle('desk-grid',a=>setSetting('desktop_grid',a));
    setupToggle('desk-labels',a=>setSetting('icon_labels',a));
    c.querySelectorAll('[data-size]').forEach(btn=>{
        btn.addEventListener('click',()=>{
            setSetting('icon_size',btn.dataset.size);
            c.querySelectorAll('[data-size]').forEach(b=>{
                const sel=b.dataset.size===btn.dataset.size;
                b.style.borderColor=sel?'var(--blue)':'var(--brd)';
                b.style.background=sel?'var(--blue)':'transparent';
                b.style.color=sel?'#fff':'var(--tx)';
            });
            toast('Tamaño de icono: '+btn.textContent);
        });
    });
    c.querySelectorAll('[data-dock]').forEach(row=>{
        row.addEventListener('click',async()=>{
            setSetting('dock_position',row.dataset.dock);
            try{await tauriInvoke('run_command',{cmd:'kwriteconfig6',args:['--file','plasmashellrc','--group','PlasmaViews','--group','Panel','--key','location',row.dataset.dock]});}catch(e){}
            renderPantallaInicio(c);
        });
    });
    document.getElementById('open-widget-browser')?.addEventListener('click',()=>{
        try{tauriInvoke('run_command',{cmd:'qdbus',args:['org.kde.plasmashell','/PlasmaShell','org.kde.PlasmaShell.toggleWidgetExplorer']}).catch(()=>{});}catch(e){}
        toast('Abriendo explorador de widgets…');
    });
    document.getElementById('open-global-theme')?.addEventListener('click',()=>{
        try{tauriInvoke('run_command',{cmd:'kcmshell6',args:['lookandfeel']}).catch(()=>{});}catch(e){}
    });
}

export function renderPlaceholder(c, title, msg='Esta sección estará disponible próximamente.'){
    c.innerHTML=renderHeader(title)+renderCard([renderInfoItem(msg,'En desarrollo')]);
}
