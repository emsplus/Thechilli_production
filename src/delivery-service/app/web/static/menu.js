(function () {
  "use strict";
  // Ordering page. The signed menu link is the only credential; prices shown here are for display, the server re-prices the order.
  var base = "/api/v1/public/menu/";
  // Two doors to the same page: /menu/{signed token} (a link we sent one customer on WhatsApp) and /r/{slug} (the restaurant's public
  // link: anonymous customer, so the page also asks for the phone number and shows open/closed and the minimum order).
  var slug = (/^\/r\/([a-z0-9]+)\/?$/.exec(location.pathname) || [])[1] || null;
  var isPublic = !!slug;
  var menu = null, cart = {}, order = [], busy = false, lastKey = null, geo = null, ordered = false;
  function $(id) { return document.getElementById(id); }
  function url(p) { return isPublic ? "/api/v1/public/r/" + encodeURIComponent(slug) + (p || "") : base + encodeURIComponent(App.token()) + (p || ""); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(name, cls) { var s = App.icon(name); if (cls) s.setAttribute("class", "ic " + cls); return s; }

  function itemLabel(it) { return it.name || ""; }
  // A variant's own price (POS: item price + delta) replaces the item price; the server re-prices every order anyway.
  function unitPrice(it, vid) {
    var base = typeof it.price === "number" ? it.price : 0;
    if (!vid) return base;
    var v = (it.variants || []).filter(function (x) { return x && x.id === vid; })[0];
    if (!v) return base;
    return typeof v.price === "number" ? v.price : base + (typeof v.price_delta === "number" ? v.price_delta : 0);
  }
  function keyOf(id, vid) { return id + "|" + (vid || ""); }
  function qtyOf(id, vid) { var l = cart[keyOf(id, vid)]; return l ? l.qty : 0; }
  function totalQty() { return order.reduce(function (n, k) { return n + cart[k].qty; }, 0); }
  function subtotal() { return order.reduce(function (n, k) { return n + cart[k].qty * unitPrice(cart[k].item, cart[k].vid); }, 0); }

  function change(it, vid, delta) {
    var k = keyOf(it.id, vid), l = cart[k];
    var q = Math.max(0, Math.min(50, (l ? l.qty : 0) + delta));
    if (q === 0) { delete cart[k]; order = order.filter(function (x) { return x !== k; }); }
    else { if (!l) { cart[k] = { item: it, vid: vid || null, qty: q }; order.push(k); } else l.qty = q; }
    lastKey = null;
    renderMenu(); renderCart();
  }

  function mark(foodType) {
    var kind = foodType === "non_veg" || foodType === "nonveg" || foodType === "non-veg" ? "nonveg" : foodType === "egg" ? "egg" : foodType === "veg" ? "veg" : null;
    if (!kind) return null;
    var NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("class", "mark"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", App.t(kind));
    var t = document.createElementNS(NS, "title"); t.textContent = App.t(kind); svg.appendChild(t);
    var color = kind === "veg" ? "#167d32" : kind === "egg" ? "#a16207" : "#b91c1c";
    var box = document.createElementNS(NS, "rect");
    box.setAttribute("x", "1.5"); box.setAttribute("y", "1.5"); box.setAttribute("width", "17"); box.setAttribute("height", "17"); box.setAttribute("rx", "2");
    box.setAttribute("fill", "none"); box.setAttribute("stroke", color); box.setAttribute("stroke-width", "2");
    svg.appendChild(box);
    var inner = document.createElementNS(NS, kind === "nonveg" ? "path" : "circle");
    if (kind === "nonveg") inner.setAttribute("d", "M10 5l5 9H5z"); else { inner.setAttribute("cx", "10"); inner.setAttribute("cy", "10"); inner.setAttribute("r", "4"); }
    inner.setAttribute("fill", color);
    svg.appendChild(inner);
    return svg;
  }

  function stepper(it, vid) {
    var T = App.t, q = qtyOf(it.id, vid);
    if (!q) {
      var add = el("button", "add"); add.type = "button"; add.appendChild(icon("plus")); add.appendChild(document.createTextNode(T("menu_add")));
      add.setAttribute("aria-label", T("menu_add_one", { name: itemLabel(it) }));
      add.addEventListener("click", function () { change(it, vid, 1); });
      return add;
    }
    var box = el("div", "stepper");
    var minus = el("button"); minus.type = "button"; minus.className = "secondary"; minus.appendChild(icon("minus"));
    minus.setAttribute("aria-label", T("menu_remove_one", { name: itemLabel(it) }));
    minus.addEventListener("click", function () { change(it, vid, -1); });
    var out = el("output", null, String(q)); out.setAttribute("aria-live", "polite");
    var plus = el("button"); plus.type = "button"; plus.className = "secondary"; plus.appendChild(icon("plus"));
    plus.setAttribute("aria-label", T("menu_add_one", { name: itemLabel(it) }));
    plus.addEventListener("click", function () { change(it, vid, 1); });
    box.appendChild(minus); box.appendChild(out); box.appendChild(plus);
    return box;
  }

  var chosenVariant = {};  // item id -> variant id picked in the item's <select>

  function renderItem(it) {
    var li = el("li", "item");
    var info = el("div");
    var name = el("div", "name");
    var m = mark(it.food_type);
    if (m) name.appendChild(m);
    name.appendChild(el("h3", null, it.name));
    info.appendChild(name);
    if (it.description) info.appendChild(el("p", "desc", it.description));
    var vars = Array.isArray(it.variants) ? it.variants.filter(function (v) { return v && v.id && v.is_active !== false; }) : [];
    var shownVid = vars.length ? (chosenVariant[it.id] || vars[0].id) : null;
    info.appendChild(el("p", "price amt", App.money(unitPrice(it, shownVid))));
    li.appendChild(info);
    if (it.sold_out) {  // public page: shown but not orderable (POS switched it off); the server refuses it too
      li.className = "item sold-out";
      li.appendChild(el("p", "sold-tag", App.t("sold_out")));
      return li;
    }
    var vid = null;
    if (vars.length) {
      vid = chosenVariant[it.id] || vars[0].id;
      var sel = el("select"); sel.id = "var-" + it.id;
      vars.forEach(function (v) { var o = el("option", null, v.name || v.id); o.value = v.id; if (v.id === vid) o.selected = true; sel.appendChild(o); });
      var wrap = el("div", "var"), lab = el("label", null, App.t("menu_option")); lab.setAttribute("for", sel.id);
      wrap.appendChild(lab); wrap.appendChild(sel);
      sel.addEventListener("change", function () { chosenVariant[it.id] = sel.value; renderMenu(); });
      li.appendChild(stepper(it, vid));
      li.appendChild(wrap);
    } else li.appendChild(stepper(it, null));
    return li;
  }

  function renderMenu() {
    var root = $("menu");
    if (!menu) return;
    var focused = document.activeElement && document.activeElement.id;
    root.textContent = "";
    var cats = (menu.categories || []).slice(), items = menu.items || [];
    var byCat = {};
    items.forEach(function (it) { (byCat[it.category_id || ""] = byCat[it.category_id || ""] || []).push(it); });
    var any = false;
    function section(title, list) {
      if (!list || !list.length) return;
      any = true;
      var s = el("section", "cat"); if (title) s.appendChild(el("h2", null, title));
      var ul = el("ul", "items");
      list.forEach(function (it) { ul.appendChild(renderItem(it)); });
      s.appendChild(ul); root.appendChild(s);
    }
    cats.forEach(function (c) { section(c.name, byCat[c.id]); delete byCat[c.id]; });
    Object.keys(byCat).forEach(function (k) { section("", byCat[k]); });
    if (!any) root.appendChild(el("p", "msg", App.t("menu_empty")));
    if (focused && $(focused)) $(focused).focus();
  }

  function renderCart() {
    var T = App.t, n = totalQty(), has = n > 0;
    $("cart-empty").hidden = has;
    $("sum").hidden = !has; $("sum-note").hidden = !has; $("order-form").hidden = !has;
    var ul = $("lines"); ul.textContent = "";
    order.forEach(function (k) {
      var l = cart[k], li = el("li");
      var left = el("span"); left.appendChild(el("span", "q", l.qty + " × ")); left.appendChild(document.createTextNode(itemLabel(l.item)));
      li.appendChild(left); li.appendChild(el("span", "amt", App.money(l.qty * unitPrice(l.item, l.vid))));
      ul.appendChild(li);
    });
    $("subtotal").textContent = App.money(subtotal());
    $("cartbar").hidden = !has || ordered;
    $("cart-count").textContent = n === 1 ? T("cart_item_one") : T("cart_item_many", { n: n });
    $("cart-amt").textContent = App.money(subtotal());
    var min = isPublic && menu && menu.min_order > 0 ? menu.min_order : 0;
    $("min-note").hidden = !(min && has);
    if (min) $("min-note").textContent = T("min_order_note", { amount: App.money(min) });
    renderClosed();
  }

  function isClosed() { return isPublic && menu && menu.open === false; }
  function renderClosed() {
    var T = App.t, closed = isClosed();
    $("closed").hidden = !closed;
    if (closed) {
      $("closed-head").textContent = T("closed_now");
      $("closed-sub").textContent = menu.closed_reason === "disabled" ? T("closed_disabled")
        : menu.next_open ? T("closed_opens", { when: menu.next_open }) + " " + T("closed_note") : T("closed_note");
    }
    $("submit").textContent = closed ? T("place_order_closed") : T("place_order");
    $("submit").disabled = !!closed || busy;
  }

  function renderPayment() {
    var online = $("pay-online").checked;
    $("online-box").hidden = !online;
    var qr = $("pay-qr"), u = menu && menu.payment_qr_url;
    if (u && /^https:\/\//.test(u)) { qr.href = u; qr.hidden = false; } else qr.hidden = true;
  }

  function applyPrefill() {
    var p = (menu && menu.prefill) || {};
    if (p.name && !$("f-name").value) $("f-name").value = p.name;
    if (p.address && !$("f-address").value) $("f-address").value = p.address;
    if (p.pay === "online") $("pay-online").checked = true;
    if (typeof p.lat === "number" && typeof p.lng === "number") { geo = { lat: p.lat, lng: p.lng }; $("loc-state").textContent = App.t("loc_done"); }
  }

  var themeSet = false;
  // Owner brand colours arrive as CSS custom properties (light only, owner decision 2026-11-01; server-checked for AA contrast). Set
  // through the CSSOM: allowed by the strict CSP (no inline style attribute is ever written into the markup).
  function applyTheme(t) {
    if (!t || themeSet) return;
    themeSet = true;
    var vars = t.light;
    Object.keys(vars || {}).forEach(function (k) { if (/^--[a-z-]+$/.test(k) && /^#[0-9a-f]{6}$/.test(vars[k])) document.documentElement.style.setProperty(k, vars[k]); });
  }

  function load() {
    return App.api("GET", url()).then(function (d) {
      menu = d;
      $("brand").textContent = d.brand || "";
      if (isPublic) {
        var head = App.t("menu_title_public", { brand: d.brand || "" });
        $("title").textContent = d.brand ? head : App.t("menu_title");
        $("title").removeAttribute("data-i18n");
        document.title = d.brand ? d.brand + " | " + App.t("menu_title") : App.t("menu_title");
        $("phone-field").hidden = false;
        $("p-note").textContent = App.t("ordered_note_public"); $("p-note").removeAttribute("data-i18n");
        applyTheme(d.theme);
      }
      // Drop cart lines that are no longer on the menu (price or availability changed).
      var ids = {}; (d.items || []).forEach(function (it) { ids[it.id] = it; });
      order = order.filter(function (k) { if (ids[cart[k].item.id]) { cart[k].item = ids[cart[k].item.id]; return true; } delete cart[k]; return false; });
      App.announce(""); renderMenu(); renderCart(); renderPayment();
    }, function (e) {
      App.announce(App.errText(e), "error");
      if (e.status === 401 || e.status === 410 || (isPublic && e.status === 404)) $("view").hidden = true;
    });
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; });
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  function submit(ev) {
    ev.preventDefault();
    if (busy) return;
    var T = App.t;
    var name = $("f-name").value.trim(), address = $("f-address").value.trim();
    if (!order.length) { App.announce(T("err_cart_empty"), "error"); return; }
    if (!name) { App.announce(T("err_name_required"), "error"); $("f-name").focus(); return; }
    if (address.length < 3) { App.announce(T("err_address_required"), "error"); $("f-address").focus(); return; }
    var phone = isPublic ? $("f-phone").value.trim() : "";
    if (isPublic && phone.replace(/\D/g, "").length < 10) { App.announce(T("err_phone_required"), "error"); $("f-phone").focus(); return; }
    if (isClosed()) { App.announce(T("err_restaurant_closed"), "error"); return; }
    if (isPublic && menu.min_order > 0 && subtotal() < menu.min_order) { App.announce(T("err_below_min_amount", { amount: App.money(menu.min_order) }), "error"); return; }
    var online = $("pay-online").checked;
    var addr = { text: address };
    if (geo) { addr.lat = geo.lat; addr.lng = geo.lng; }
    var body = {
      client_uuid: "", name: name, address: addr, payment_mode: online ? "online" : "cod", claimed_paid: online && $("f-paid").checked,
      promo_code: $("f-promo").value.trim() || null,
      lines: order.map(function (k) { var l = cart[k]; return { item_id: l.item.id, variant_id: l.vid, quantity: l.qty, note: "" }; })
    };
    if (isPublic) body.phone = phone;
    // The same key is re-sent for a retry of the same order (a lost response must not place it twice); any change makes a new key.
    var sig = JSON.stringify(body);
    if (!lastKey || lastKey.sig !== sig) lastKey = { sig: sig, id: uuid() };
    body.client_uuid = lastKey.id;
    busy = true; $("submit").disabled = true; $("submit").textContent = T("placing");
    App.api("POST", url("/order"), body).then(function (o) {
      App.announce("");
      ordered = true;
      $("shop").hidden = true; $("cartbar").hidden = true;
      $("placed").hidden = false;
      $("p-code").textContent = o.order_code; $("p-total").textContent = App.money(o.total);
      var path = String(o.track_url || "").replace(/^https?:\/\/[^/]+/, "");
      $("p-track").href = /^\/track\/[\w.\-]+$/.test(path) ? path : "#";
      $("p-track").focus();
      window.scrollTo(0, 0);
    }, function (e) {
      App.announce(isPublic && e.code === "rate_limited" ? T("err_rate_limited_public") : App.errText(e), "error");
      if (e.code === "price_changed" || e.code === "item_unavailable" || e.code === "restaurant_closed") { lastKey = null; return load(); }
    }).then(function () {
      busy = false; $("submit").disabled = false; $("submit").textContent = T("place_order");
      renderClosed();
    });
  }

  function useLocation() {
    var T = App.t;
    if (!("geolocation" in navigator)) { $("loc-state").textContent = T("loc_failed"); return; }
    $("loc").disabled = true;
    navigator.geolocation.getCurrentPosition(function (pos) {
      geo = { lat: pos.coords.latitude, lng: pos.coords.longitude }; lastKey = null;
      $("loc-state").textContent = T("loc_done"); $("loc").disabled = false;
    }, function () { $("loc-state").textContent = T("loc_failed"); $("loc").disabled = false; },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
  }

  $("order-form").addEventListener("submit", submit);
  $("loc").addEventListener("click", useLocation);
  ["pay-cod", "pay-online"].forEach(function (id) { $(id).addEventListener("change", function () { renderPayment(); lastKey = null; }); });

  App.onLang(function () { if (menu) { renderMenu(); renderCart(); } });
  App.init(function () { load().then(applyPrefill); });
})();
