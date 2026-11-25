/**
 * Pre-paint inline scripts for the root layout. Kept in a plain (server-safe) module: anything exported from a
 * "use client" file becomes a client reference on the server, so a string imported from there would not render.
 */
export const THEME_KEY = "pos.theme";
export const SIDEBAR_KEY = "pos.sidebar";

/** Light theme only (owner decision 2026-11-01): forgets a theme saved by an older build ("dark" must not stick) and pins html[data-theme=light] before first paint. It can never apply dark. Ends with ";" because the layout joins the init scripts into one inline script. */
export const THEME_INIT_SCRIPT = `try{localStorage.removeItem("${THEME_KEY}")}catch(e){}document.documentElement.setAttribute("data-theme","light");`;

/** Applies the saved collapsed-sidebar state before first paint. */
export const SIDEBAR_INIT_SCRIPT = `try{if(localStorage.getItem("${SIDEBAR_KEY}")==="collapsed")document.documentElement.setAttribute("data-sidebar","collapsed")}catch(e){}`;

export const EFFECTS_KEY = "pos.effects";

/**
 * Visual effects level before first paint: html[data-effects=reduced] when the user chose "Reduced", or when the
 * setting is "auto" (default) and the device looks low-end (<=4 cores or <=4 GB) or prefers reduced motion.
 * Keep in sync with autoReduce() in effects.ts.
 */
export const EFFECTS_INIT_SCRIPT = `try{var e=null;try{e=localStorage.getItem("${EFFECTS_KEY}")}catch(x){}var r=e==="reduced";if(e!=="full"&&e!=="reduced"){var n=navigator;r=(n.hardwareConcurrency||8)<=4||(n.deviceMemory||8)<=4||matchMedia("(prefers-reduced-motion: reduce)").matches}if(r)document.documentElement.setAttribute("data-effects","reduced")}catch(x){}`;
