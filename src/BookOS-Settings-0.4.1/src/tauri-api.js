export async function tauriInvoke(cmd, args={}) {
    if(window.__TAURI__){const inv=window.__TAURI__.core?.invoke||window.__TAURI__.tauri?.invoke;if(inv)return await inv(cmd,args);}
    throw new Error(`No Tauri: ${cmd}`);
}
// Wrapper that shows a toast on error and returns null instead of throwing.
// Use for user-initiated actions where silent failure is confusing.
export async function safeInvoke(cmd, args={}, errMsg=null){
    try{return await tauriInvoke(cmd,args);}
    catch(e){
        const msg=errMsg||`Error: ${cmd.replace(/_/g,' ')}`;
        if(window.toast)window.toast(msg,'⚠');
        console.error(`[safeInvoke] ${cmd}:`,e);
        return null;
    }
}
export function isTauri(){return !!window.__TAURI__}
export function getAssetUrl(path) {
    if(window.__TAURI__?.core?.convertFileSrc) return window.__TAURI__.core.convertFileSrc(path);
    return 'asset://localhost' + (path.startsWith('/') ? path : '/' + path);
}
