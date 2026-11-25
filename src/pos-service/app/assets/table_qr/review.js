/* Guest review form: GET (header) and POST /api/v1/table-qr/public/review/{token}. No login, no cookie. */
"use strict";
(function () {
  var T = window.TQ, $ = function (id) { return document.getElementById(id); };
  var WORDS = { 1: "Very poor", 2: "Poor", 3: "Okay", 4: "Good", 5: "Excellent" };
  var tok = T.token(), sending = false;

  function rating() {
    var r = document.querySelector("input[name=rating]:checked");
    return r ? Number(r.value) : 0;
  }
  function paint() {
    var v = rating();
    document.querySelectorAll(".star").forEach(function (s) {
      s.classList.toggle("on", Number(s.querySelector("input").value) <= v);
    });
    $("rating-text").textContent = v ? v + " of 5 · " + WORDS[v] : "Tap a star";
    if (v) $("err").hidden = true;
  }
  function fail(msg) { $("err").textContent = msg; $("err").hidden = false; }

  function submit(ev) {
    ev.preventDefault();
    if (sending) return;
    $("err").hidden = true;
    var r = rating();
    if (!r) { fail("Please choose 1 to 5 stars."); document.querySelector("input[name=rating]").focus(); return; }
    var body = { rating: r, comment: $("comment").value.trim() || null, name: $("name").value.trim() || null,
      contact: $("contact").value.trim() || null, website: $("website").value || null };
    sending = true; $("send").disabled = true; $("send").textContent = "Sending…";
    T.getJSON("/api/v1/table-qr/public/review/" + tok, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 201) {
        $("form").hidden = true; $("thanks").hidden = false; $("thanks-title").focus();
        if (res.body.google_review_url) { $("google-link").setAttribute("href", res.body.google_review_url); $("google").hidden = false; }
        return;
      }
      if (res.status === 404) { $("form").hidden = true; T.inactive($("state")); return; }
      fail(T.errMessage(res));
    }).catch(function () { fail("No connection. Check your internet and try again."); })
      .then(function () { sending = false; $("send").disabled = false; $("send").textContent = "Send review"; });
  }

  function load() {
    var state = $("state");
    state.hidden = true;
    if (!tok) { $("loading").hidden = true; T.inactive(state); return; }
    T.getJSON("/api/v1/table-qr/public/review/" + tok).then(function (res) {
      $("loading").hidden = true; $("main").setAttribute("aria-busy", "false");
      if (res.status === 404) { T.inactive(state); return; }
      if (res.status !== 200) { T.showState(state, "This page could not be loaded", T.errMessage(res), load); return; }
      $("rest").textContent = res.body.restaurant.name;
      document.title = "Rate your visit · " + res.body.restaurant.name;
      if (res.body.table) { $("table").textContent = "Table " + res.body.table.label; $("table").hidden = false; }
      $("form").hidden = false;
    }).catch(function () {
      $("loading").hidden = true;
      T.showState(state, "No connection", "Check your internet connection and try again.", load);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("input[name=rating]").forEach(function (i) { i.addEventListener("change", paint); });
    $("comment").addEventListener("input", function () { $("count").textContent = $("comment").value.length + " / 500"; });
    $("form").addEventListener("submit", submit);
    load();
  });
})();
