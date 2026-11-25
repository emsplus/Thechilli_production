/* View-only table menu: GET /api/v1/table-qr/public/menu/{token}. No cart, no ordering. */
"use strict";
(function () {
  var T = window.TQ, $ = function (id) { return document.getElementById(id); };
  var FOOD = { veg: "Vegetarian", non_veg: "Non-vegetarian", egg: "Contains egg" };
  var data = null;

  function itemNode(it) {
    var cls = "item" + (it.sold_out ? " sold-out" : "");
    var name = T.el("div", { className: "name-row" }, [
      it.food_type ? T.el("span", { className: "fm " + it.food_type, role: "img", "aria-label": FOOD[it.food_type] || "" }) : null,
      T.el("h3", { text: it.name })
    ]);
    var price = it.variants && it.variants.length
      ? T.el("p", { className: "variants", text: it.variants.map(function (v) { return v.name + " " + T.money(v.price); }).join(" · ") })
      : T.el("p", { className: "price", text: T.money(it.price) });
    var body = T.el("div", { className: "body" }, [
      name,
      it.description ? T.el("p", { className: "desc", text: it.description }) : null,
      price,
      it.sold_out ? T.el("span", { className: "sold-tag", text: "Sold out today" }) : null
    ]);
    var img = it.image ? T.el("img", { src: it.image, alt: "", loading: "lazy", decoding: "async", width: "84", height: "84" }) : null;
    if (img) img.addEventListener("error", function () { img.remove(); });
    return T.el("li", { className: cls, "data-name": (it.name + " " + (it.description || "")).toLowerCase() }, [body, img]);
  }

  function render() {
    var menu = $("menu"); menu.textContent = "";
    var chips = $("chips"); chips.textContent = "";
    var byCat = {};
    data.items.forEach(function (it) { (byCat[it.category] = byCat[it.category] || []).push(it); });
    data.categories.forEach(function (c, i) {
      var id = "c" + i;
      var list = T.el("ul", { className: "items" }, (byCat[c.id] || []).map(itemNode));
      menu.appendChild(T.el("section", { className: "cat", id: id, "aria-labelledby": id + "-h" }, [T.el("h2", { id: id + "-h", text: c.name }), list]));
      chips.appendChild(T.el("a", { className: "chip", href: "#" + id, text: c.name }));
    });
    if (!data.items.length) T.showState($("state"), "The menu is being updated", "Please ask the staff for today's dishes.");
    chips.hidden = data.categories.length < 2;
    $("search-wrap").hidden = data.items.length < 6;
  }

  function filter() {
    var q = $("q").value.trim().toLowerCase(), any = false;
    document.querySelectorAll(".cat").forEach(function (sec) {
      var shown = 0;
      sec.querySelectorAll(".item").forEach(function (li) {
        var ok = !q || li.getAttribute("data-name").indexOf(q) !== -1;
        li.hidden = !ok; if (ok) shown++;
      });
      sec.hidden = shown === 0; if (shown) any = true;
    });
    $("none").hidden = any;
    $("chips").hidden = !!q || data.categories.length < 2;
  }

  function load() {
    var tok = T.token(), state = $("state");
    state.hidden = true;
    $("loading").hidden = false;
    if (!tok) { $("loading").hidden = true; T.inactive(state); return; }
    T.getJSON("/api/v1/table-qr/public/menu/" + tok).then(function (res) {
      $("loading").hidden = true; $("main").setAttribute("aria-busy", "false");
      if (res.status === 404) { T.inactive(state); return; }
      if (res.status === 429) { T.showState(state, "Please wait a moment", "Too many people opened the menu at once. Try again in a minute.", load); return; }
      if (res.status !== 200) { T.showState(state, "The menu could not be loaded", T.errMessage(res), load); return; }
      data = res.body;
      $("rest").textContent = data.restaurant.name;
      document.title = data.restaurant.name + " · Menu";
      if (data.table) { $("table").textContent = "Table " + data.table.label; $("table").hidden = false; }
      render();
      $("view-note").hidden = false;
      if (data.tax_note) { $("tax").textContent = data.tax_note; $("tax").hidden = false; }
      if (data.review_path) { $("cta-link").setAttribute("href", data.review_path); $("cta").hidden = false; }
    }).catch(function () {
      $("loading").hidden = true;
      T.showState(state, "No connection", "Check your internet connection and try again.", load);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("q").addEventListener("input", function () { if (data) filter(); });
    load();
  });
})();
