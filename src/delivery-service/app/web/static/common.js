/* Shared helpers: INR money format, language catalogue (English only unless the server flag is on), API calls with the link token from the page path, polite live region. */
(function () {
  "use strict";
  var STORE = "del_lang";
  var dict = null;
  var lang = "en";
  // Owner decision 2026-10-31: English only. The server writes DELIVERY_ENABLE_LANGUAGES into this meta tag; when it is "0"
  // (default) there is no switcher, no stored language and no device-language detection.
  var meta = document.querySelector('meta[name="chilli-languages"]');
  var LANGS = !!meta && meta.getAttribute("content") === "1";
  var listeners = [];

  function readStored() { try { return localStorage.getItem(STORE); } catch (e) { return null; } }
  function writeStored(v) { try { localStorage.setItem(STORE, v); } catch (e) { /* private mode: not persisted */ } }

  function t(key, vars) {
    var s = (dict && (dict[lang][key] || dict.en[key])) || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace("{" + k + "}", function () { return String(vars[k]); }); });
    return s;
  }

  function apply() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    document.querySelectorAll("[data-i18n-label]").forEach(function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-label"))); });
    var b = document.getElementById("lang");
    if (b && LANGS) { b.hidden = false; b.textContent = t("lang_toggle"); b.setAttribute("aria-label", t("lang_toggle_label")); b.setAttribute("lang", lang === "en" ? "hi" : "en"); }
    listeners.forEach(function (fn) { fn(); });
  }

  // Money: integer minor units (paise) -> "₹1,23,456.50": rupee sign glued to the number, Indian lakh/crore grouping.
  function money(minor) {
    var n = Math.round(Number(minor));
    if (!isFinite(n)) return "";
    var neg = n < 0; n = Math.abs(n);
    var rupees = String(Math.floor(n / 100)), paise = ("0" + (n % 100)).slice(-2);
    var head = rupees.length > 3 ? rupees.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ",") + "," + rupees.slice(-3) : rupees;
    return (neg ? "-" : "") + "\u20B9" + head + "." + paise;
  }

  // Icons: small stroke paths drawn into <svg class="ic"> (no sprite file, no inline style: CSP stays strict). Elements opt in with
  // data-icon="name"; the icon is decorative (aria-hidden), the words next to it carry the meaning.
  var SVGNS = "http://www.w3.org/2000/svg";
  var ICONS = {
    check: "M5 13l4 4L19 7", plus: "M12 5v14M5 12h14", minus: "M5 12h14",
    phone: "M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z",
    pin: "M12 21s7-6.2 7-12a7 7 0 10-14 0c0 5.8 7 12 7 12zM12 11.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
    navigate: "M3 11l18-8-8 18-2-8-8-2z", locate: "M12 15a3 3 0 100-6 3 3 0 000 6zM12 2v4M12 18v4M2 12h4M18 12h4",
    placed: "M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6",
    accepted: "M12 21a9 9 0 100-18 9 9 0 000 18zM8 12l3 3 5-6",
    preparing: "M4 11h14v4a4 4 0 01-4 4H8a4 4 0 01-4-4v-4zM18 12h3M8 7c0-1.5 1-1.5 1-3M12 7c0-1.5 1-1.5 1-3",
    ready: "M5 8h14l-1 12H6L5 8zM9 8a3 3 0 016 0",
    out_for_delivery: "M6 20a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM18 20a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM8.5 17.5h7L18 9h-4M18 9l1.5-4H22M4 13h4",
    delivered: "M4 11l8-7 8 7v9H4zM10 20v-6h4v6",
    cancelled: "M12 21a9 9 0 100-18 9 9 0 000 18zM9 9l6 6M15 9l-6 6",
    alert: "M12 3l10 18H2L12 3zM12 10v5M12 18v.01", info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 7.5v.01",
    cart: "M3 4h2.5l2.4 11h10.2L20.5 7H6.3M9 20v.01M17 20v.01", user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
    cash: "M3 6h18v12H3zM12 15a3 3 0 100-6 3 3 0 000 6z", bike: "M6 20a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM18 20a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM8.5 17.5h7L18 9h-4",
    clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2", key: "M8 15a4 4 0 110-8 4 4 0 010 8zM11 11h10M18 11v3"
  };
  function icon(name) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "ic"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    var p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", ICONS[name] || ICONS.info);
    svg.appendChild(p);
    return svg;
  }
  function paintIcons(root) {
    (root || document).querySelectorAll("[data-icon]").forEach(function (el) {
      if (el.getAttribute("data-icon-done")) return;
      el.insertBefore(icon(el.getAttribute("data-icon")), el.firstChild);
      el.setAttribute("data-icon-done", "1");
    });
  }

  // Phone numbers go into tel: links only after they pass a strict check (digits, optional leading +).
  function telHref(raw) {
    var s = String(raw == null ? "" : raw).replace(/[\s().-]/g, "");
    return /^\+?[0-9]{6,15}$/.test(s) ? "tel:" + s : null;
  }

  function setLang(l) { lang = l === "hi" ? "hi" : "en"; writeStored(lang); apply(); }

  function token() { var p = location.pathname.split("/"); return p[p.length - 1]; }

  function api(method, path, body) {
    var opts = { method: method, headers: {}, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" };
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error((data && data.code) || "generic"); e.code = (data && data.code) || "generic"; e.status = r.status; throw e; }
        return data;
      });
    }, function () { var e = new Error("network"); e.code = "network"; throw e; });
  }

  function errText(e) { var k = "err_" + (e && e.code); return dict && (dict[lang][k] || dict.en[k]) ? t(k) : t("err_generic"); }

  function announce(text, kind) {
    var el = document.getElementById("msg");
    if (!el) return;
    el.textContent = "";
    if (text && (kind === "error" || kind === "ok")) el.appendChild(icon(kind === "ok" ? "check" : "alert"));
    if (text) { var span = document.createElement("span"); span.textContent = text; el.appendChild(span); }
    el.className = "msg " + (kind || "");
    el.hidden = !text;
  }

  function init(onReady) {
    lang = LANGS && readStored() === "hi" ? "hi" : "en";  // never the device language
    var b = document.getElementById("lang");
    if (b && LANGS) b.addEventListener("click", function () { setLang(lang === "en" ? "hi" : "en"); });
    fetch("/assets/i18n.json", { cache: "force-cache" }).then(function (r) { return r.json(); }).then(function (d) {
      dict = d; paintIcons(); apply(); onReady();
    });
  }

  window.App = { icon: icon, paintIcons: paintIcons, telHref: telHref, t: t, api: api, token: token, errText: errText, announce: announce, init: init, money: money, lang: function () { return lang; },
                 onLang: function (fn) { listeners.push(fn); } };
})();
