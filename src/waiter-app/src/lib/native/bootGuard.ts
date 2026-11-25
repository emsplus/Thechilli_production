/**
 * Boot guard: plain ES5 text that layout.tsx inlines as the FIRST script of every page, so it runs even when the app's own
 * chunks fail to parse (an old Android System WebView) or a startup await never resolves. Android shell only (window.androidBridge).
 *
 *  - Hides the NATIVE launch screen after 3 s whatever happens. It talks to the plugin through Capacitor.nativePromise, which
 *    the native bridge injects before any page script; `Capacitor.Plugins.SplashScreen` only exists once the app bundle has run,
 *    so the old safety net (that used it) did nothing exactly when it was needed: JS dead = logo forever.
 *  - Reads the WebView version from the user agent; below MIN_WEBVIEW it shows "update Android System WebView" at once.
 *  - Records window errors / unhandled rejections and boot stages. If the app is not "ready" after 10 s, or a script fails to
 *    load / parse, a full-screen panel shows the text with Copy and Retry buttons. After ready, an error shows a small bar.
 *  The app calls window.__chilliBoot.ready() (lib/native/boot.ts) once it left the splash page.
 */
export const MIN_WEBVIEW = 85; // ??= (Chrome 85) is the newest syntax the build emits (package.json browserslist chrome >= 85)

export const BOOT_GUARD_JS = `(function(){
var w=window;if(typeof w.androidBridge==="undefined")return;
var NEED=${MIN_WEBVIEW},B=w.__chilliBoot={errs:[],stages:[],isReady:false,webview:0,need:NEED};
function t(){try{return Math.round(performance.now())}catch(e){return 0}}
B.stage=function(s){B.stages.push(s+"@"+t())};B.stage("guard");
var m=/Chrome\\/(\\d+)/.exec(navigator.userAgent||"");B.webview=m?+m[1]:0;
function hideNative(){try{var c=w.Capacitor;if(c&&c.nativePromise){c.nativePromise("SplashScreen","hide",{fadeOutDuration:150}).then(null,function(){})}}catch(e){}}
setTimeout(hideNative,3000);
function report(){return "Chilli Staff boot report\\nWebView Chrome: "+(B.webview||"unknown")+" (needs "+NEED+"+)\\nUA: "+navigator.userAgent+"\\nStages: "+B.stages.join(", ")+"\\nErrors:\\n"+(B.errs.join("\\n")||"(none)")}
var box=null;
function el(tag,css,txt){var e=document.createElement(tag);e.style.cssText=css;if(txt)e.textContent=txt;return e}
function btn(label,fn,bg,fg){var b=el("button","font:600 16px sans-serif;padding:12px 18px;margin:8px 8px 0 0;border-radius:10px;border:1px solid #e50914;background:"+bg+";color:"+fg,label);b.onclick=fn;return b}
function copy(){var s=report();try{navigator.clipboard.writeText(s).then(null,fb)}catch(e){fb()}function fb(){try{var a=document.createElement("textarea");a.value=s;document.body.appendChild(a);a.select();document.execCommand("copy");a.remove()}catch(e){}}}
function show(title,body){
 if(!document.body)return;hideNative();
 if(box&&box.parentNode)box.parentNode.removeChild(box);
 box=el("div","position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;background:#fff;color:#111;font:15px/1.4 sans-serif;padding:24px 20px;overflow:auto;box-sizing:border-box");
 box.appendChild(el("div","font:700 22px sans-serif;color:#e50914;margin-bottom:12px",title));
 box.appendChild(el("div","margin-bottom:12px",body));
 box.appendChild(el("pre","white-space:pre-wrap;word-break:break-word;font:12px/1.35 monospace;background:#f3f4f6;padding:10px;border-radius:8px",report()));
 var row=el("div","");row.appendChild(btn("Retry",function(){location.reload()},"#e50914","#fff"));row.appendChild(btn("Copy",copy,"#fff","#e50914"));box.appendChild(row);
 document.body.appendChild(box)}
function bar(msg){
 if(!document.body||document.getElementById("chilli-errbar"))return;
 var b=el("div","position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483646;background:#7f1d1d;color:#fff;font:13px sans-serif;padding:10px 12px;border-radius:10px");
 b.id="chilli-errbar";b.textContent="Error: "+msg.slice(0,120)+"  (tap for details)";
 b.onclick=function(){b.remove();show("Something went wrong","Tap Copy and send this text to support. Retry reloads the app.")};document.body.appendChild(b)}
function onErr(msg,fatal){B.errs.push(msg);if(B.errs.length>20)B.errs.shift();
 if(fatal&&!B.isReady)show("Chilli Staff could not start","A part of the app failed to load. Please update Android System WebView and Chrome in the Play Store, then press Retry.");
 else if(B.isReady)bar(msg)}
w.addEventListener("error",function(e){var tg=e.target;
 if(tg&&tg!==w&&tg.tagName){if(tg.tagName==="SCRIPT")onErr("load failed: "+(tg.src||"script"),true);return}
 var s=(e.message||"error")+" @"+String(e.filename||"").split("/").pop()+":"+(e.lineno||0)+":"+(e.colno||0);
 onErr(s,/SyntaxError|Unexpected token|Unexpected identifier|Invalid or unexpected/.test(String(e.message)))},true);
w.addEventListener("unhandledrejection",function(e){var r=e.reason;onErr("rejection: "+(r&&r.stack?String(r.stack).split("\\n").slice(0,3).join(" | "):String(r)),false)});
B.ready=function(){if(B.isReady)return;B.isReady=true;B.stage("ready");if(box&&box.parentNode){box.parentNode.removeChild(box);box=null}};
var stuck=0,stuckShown=false;
setInterval(function(){
 var sp=document.querySelector(".splash");
 if(!sp||document.documentElement.getAttribute("data-locked")){stuck=0;if(stuckShown&&box){box.parentNode&&box.parentNode.removeChild(box);box=null;stuckShown=false}return}
 stuck++;
 if(stuck>=12&&!box){stuckShown=true;B.errs.push("splash visible for "+stuck+"s at "+location.pathname);show("Chilli Staff is stuck on the logo","The app stopped on the loading screen ("+location.pathname+"). Press Retry. If it happens again, tap Copy and send the text to support.")}
},1000);
function start(){
 if(B.webview&&B.webview<NEED)show("Please update Android System WebView and Chrome in Play Store","This phone has WebView "+B.webview+"; Chilli Staff needs "+NEED+" or newer. Open Play Store, search Android System WebView, tap Update, do the same for Chrome, then reopen the app.");
 setTimeout(function(){if(!B.isReady)show("Chilli Staff did not start","The app did not reach the sign-in screen in 10 seconds. Press Retry. If it happens again, tap Copy and send the text to support.")},10000)}
if(document.body)start();else document.addEventListener("DOMContentLoaded",start)
})();`;
