/* Shared helpers of the table QR pages. No framework, no innerHTML with data (every server string goes through textContent). */
"use strict";
window.TQ = (function () {
  function token() {
    var parts = location.pathname.split("/").filter(Boolean);
    var t = parts.length >= 2 ? parts[1] : "";
    return /^[A-Za-z0-9_-]{40,64}$/.test(t) ? t : "";
  }
  var inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 });
  function money(paise) { return inr.format((paise || 0) / 100); }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "className") e.className = attrs[k];
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function getJSON(url, opts) {
    return fetch(url, Object.assign({ credentials: "omit", headers: { Accept: "application/json" } }, opts || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) { return { status: r.status, body: body }; });
    });
  }
  function errMessage(res) {
    if (res && res.body && res.body.error && res.body.error.message) return res.body.error.message;
    return "Something went wrong. Please try again.";
  }
  function showState(box, title, text, retry) {
    box.textContent = "";
    box.appendChild(el("h2", { text: title }));
    box.appendChild(el("p", { text: text }));
    if (retry) {
      var b = el("button", { className: "btn secondary", type: "button", text: "Try again" });
      b.addEventListener("click", retry);
      box.appendChild(b);
    }
    box.hidden = false;
  }
  function inactive(box) {
    showState(box, "This QR code is not active", "Please ask the staff for help or for a new QR code.");
  }
  return { token: token, money: money, el: el, getJSON: getJSON, errMessage: errMessage, showState: showState, inactive: inactive };
})();
