(function () {
  "use strict";
  var STEPS = ["placed", "accepted", "preparing", "ready", "out_for_delivery", "delivered"];
  var data = null, timer = null, failed = 0;

  function render() {
    var T = App.t;
    if (!data) return;
    document.getElementById("brand").textContent = data.brand || "";
    document.getElementById("code").textContent = data.order_code;
    var status = data.status;
    var cancelled = status === "cancelled";
    var st = document.getElementById("status");
    st.textContent = "";
    st.appendChild(App.icon(cancelled ? "cancelled" : STEPS.indexOf(status) >= 0 ? status : "info"));
    st.appendChild(document.createTextNode(T("status_" + status)));
    st.className = "status" + (cancelled ? " bad" : status === "delivered" ? " ok" : "");
    var pay = document.getElementById("pay");
    pay.hidden = typeof data.total !== "number" || cancelled;
    if (!pay.hidden) {
      document.getElementById("total").textContent = App.money(data.total);
      document.getElementById("pay-note").textContent = data.status === "delivered" ? "" : data.payment_mode === "cod" ? T("track_pay_cod") : data.payment_mode === "online" ? T("track_pay_online") : "";
    }
    document.getElementById("steps-card").hidden = cancelled;
    document.getElementById("rider-card").hidden = cancelled;
    document.getElementById("cancelled").hidden = !cancelled;
    var call = document.getElementById("call"), tel = App.telHref(data.restaurant_phone);
    call.hidden = !tel;
    if (tel) call.href = tel;
    document.getElementById("note").hidden = cancelled || status === "delivered";
    var idx = STEPS.indexOf(status);
    var ol = document.getElementById("steps");
    ol.hidden = cancelled;
    ol.textContent = "";
    STEPS.forEach(function (s, i) {
      var li = document.createElement("li");
      var state = cancelled ? "todo" : (i < idx || status === "delivered") ? "done" : i === idx ? "current" : "todo";
      li.setAttribute("data-state", state);
      if (state === "current") li.setAttribute("aria-current", "step");
      var dot = document.createElement("span");
      dot.className = "dot";
      dot.appendChild(App.icon(state === "done" ? "check" : s));
      var txt = document.createElement("span");
      txt.className = "txt";
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = T("step_" + s);
      var when = document.createElement("span");
      when.className = "when";
      when.textContent = T("state_" + state);
      txt.appendChild(name);
      txt.appendChild(when);
      li.appendChild(dot);
      li.appendChild(txt);
      ol.appendChild(li);
    });
    var loc = data.rider_location, info = document.getElementById("rider-info"), link = document.getElementById("map");
    if (loc) {
      var mins = Math.max(0, Math.round((Date.now() - new Date(loc.updated_at).getTime()) / 60000));
      info.textContent = mins < 1 ? T("track_rider_now") : T("track_rider_seen", { mins: mins });
      link.href = "https://www.google.com/maps?q=" + encodeURIComponent(loc.lat + "," + loc.lng);
      link.hidden = false;
    } else { info.textContent = T("track_rider_none"); link.hidden = true; }
  }

  function done() { return data && (data.status === "delivered" || data.status === "cancelled"); }

  function load() {
    return App.api("GET", "/api/v1/public/track/" + encodeURIComponent(App.token())).then(function (d) {
      data = d; failed = 0; App.announce(""); render();
    }, function (e) {
      failed++;
      App.announce(App.errText(e), "error");
      if (e.status === 401 || e.status === 410) { stop(); document.getElementById("view").hidden = true; }
    });
  }
  function stop() { if (timer) { clearTimeout(timer); timer = null; } }
  function loop() {
    stop();
    if (done()) return;
    timer = setTimeout(function () { (document.hidden ? Promise.resolve() : load()).then(loop); }, Math.min(15000 * (1 + failed), 60000));
  }

  App.onLang(render);
  App.init(function () { load().then(loop); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && !done()) load(); });
})();
