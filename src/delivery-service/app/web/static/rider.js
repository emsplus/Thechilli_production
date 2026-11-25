(function () {
  "use strict";
  var base = "/api/v1/public/rider/";
  var data = null, timer = null, watchId = null, lastSent = 0, lastSentAt = null, busy = false;
  function $(id) { return document.getElementById(id); }
  function url(p) { return base + encodeURIComponent(App.token()) + (p || ""); }

  function show(id, on) { $(id).hidden = !on; }

  function render() {
    var T = App.t;
    if (!data) return;
    $("code").textContent = data.order_code;
    $("addr").textContent = data.address;
    $("cust").textContent = data.customer_name;
    var cash = $("cash");
    cash.textContent = "";
    if (data.collect_cash) {
      cash.appendChild(document.createTextNode(T("rider_collect") + ": "));
      var amt = document.createElement("span"); amt.className = "amt"; amt.textContent = App.money(data.total);
      cash.appendChild(amt);
    } else cash.textContent = T("rider_prepaid");
    var nav = $("nav");
    if (data.lat != null && data.lng != null) { nav.href = "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(data.lat + "," + data.lng); nav.hidden = false; }
    else { nav.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(data.address); nav.hidden = false; }
    var tel = App.telHref(data.customer_phone);
    $("call").hidden = !tel;
    if (tel) $("call").href = tel;
    var s = data.status, mine = data.yours, offered = data.offered_to_you;
    var cancelled = s === "cancelled", delivered = s === "delivered";
    show("offer", offered && !mine && !cancelled && !delivered);
    show("waiting", mine && !cancelled && !delivered && s !== "ready" && s !== "out_for_delivery");
    show("pickup", mine && s === "ready");
    show("share", mine && s === "out_for_delivery");
    show("otp", mine && s === "out_for_delivery");
    show("done", delivered && mine);
    show("cancelled", cancelled);
    show("notyours", !mine && !offered && !cancelled && !delivered);
    $("share-state").textContent = watchId !== null ? T("rider_share_on") : T("rider_share_off");
    $("share-toggle").textContent = watchId !== null ? T("rider_share_stop") : T("rider_share_start");
    $("share-toggle").setAttribute("aria-pressed", watchId !== null ? "true" : "false");
    if (lastSentAt) $("share-sent").textContent = T("rider_share_sent", { time: lastSentAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) });
    if (s !== "out_for_delivery") stopSharing();
  }

  function load() {
    return App.api("GET", url()).then(function (d) { data = d; render(); }, function (e) {
      App.announce(App.errText(e), "error");
      if (e.status === 401 || e.status === 410) { $("view").hidden = true; clearTimeout(timer); }
    });
  }

  function act(path, body) {
    if (busy) return Promise.resolve();
    busy = true;
    document.querySelectorAll("button").forEach(function (b) { if (b.id !== "lang") b.disabled = true; });
    return App.api("POST", url(path), body).then(function () { App.announce(""); return load(); }, function (e) {
      App.announce(App.errText(e), "error");
      if (e.code === "otp_invalid") { $("otp-input").select(); }
      return load();
    }).then(function () {
      busy = false;
      document.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
    });
  }

  function sendPosition(pos) {
    var now = Date.now();
    if (now - lastSent < 10000) return;  // the server allows one ping per 3 s; 10 s saves battery and data
    lastSent = now;
    App.api("POST", url("/ping"), { lat: pos.coords.latitude, lng: pos.coords.longitude }).then(function () {
      lastSentAt = new Date(); App.announce(""); render();
    }, function (e) { if (e.code !== "rate_limited") App.announce(App.errText(e), "error"); });
  }

  function startSharing() {
    if (!("geolocation" in navigator)) { App.announce(App.t("rider_share_unsupported"), "error"); return; }
    watchId = navigator.geolocation.watchPosition(sendPosition, function (err) {
      stopSharing();
      App.announce(App.t(err.code === 1 ? "rider_share_denied" : "err_generic"), "error");
      render();
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    render();
  }
  function stopSharing() { if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }

  $("accept").addEventListener("click", function () { act("/accept"); });
  $("decline").addEventListener("click", function () { act("/decline"); });
  $("pickup-btn").addEventListener("click", function () { act("/pickup"); });
  $("share-toggle").addEventListener("click", function () { if (watchId === null) startSharing(); else { stopSharing(); render(); } });
  $("otp-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var v = $("otp-input").value.replace(/\D/g, "");
    if (v.length < 4) { App.announce(App.t("err_otp_invalid"), "error"); return; }
    act("/deliver", { otp: v }).then(function () { $("otp-input").value = ""; });
  });

  App.onLang(render);
  App.init(function () {
    load();
    timer = setInterval(function () { if (!document.hidden && !busy) load(); }, 15000);
  });
})();
