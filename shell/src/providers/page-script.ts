// The script of Models › Setup › Providers. Nothing it does reloads the page
// or changes its address (the owner, 2026-11-28):
//
// - Search, the Maker filter (its find box and chips) and the strip's Works /
//   Doesn't work / Not tested yet cells only show and hide rows: no request.
// - Every form marked data-fetch (Test, Refresh, Check again, the price cap,
//   Test all, Retest failed, Disconnect) and every link marked data-view (a
//   confirm, the cap editor, Cancel) is sent in place, asking for JSON: the
//   server answers with the page's <main> rendered for that view, and only
//   the parts that changed are swapped in. Requests go one at a time, in
//   order; a button waiting shows it is busy.
// - While a Test all models run goes on (the rail is marked data-running),
//   the same view is asked for again every few seconds.
// - Back from the provider's consent page (main is marked data-land), the
//   search field takes focus once.
// Focus, the table's scroll position, typed cap values and the open details
// survive every swap. Without the script, every form posts and redirects
// back (page.ts), and every link is a plain address.

export const PAGE_SCRIPT = String.raw`
(function () {
  "use strict";
  var main = document.getElementById("screen");
  if (!main || !window.fetch || !window.history) return;
  var S = { q: "", makers: [], filter: null, view: main.getAttribute("data-view") || "", last: {}, queue: [], busy: false, waiting: {}, det: {}, allowed: {}, timer: 0, built: false };
  var SPIN = '<span class="spin" aria-hidden="true"></span>';
  var NOUN = { works: "that work", fails: "that don't work", pending: "not tested yet" };

  function $(id) { return document.getElementById(id); }
  function cssq(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }
  function byK(k) { return k ? main.querySelector('[data-k="' + cssq(k) + '"]') : null; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function rows() { return main.querySelectorAll("#pick-list > li.row"); }
  function tokens(q) { return q.toLowerCase().split(/\s+/).filter(Boolean); }


  // ---------- filters: search, maker, the strip ----------
  function matches(li, t) {
    if (S.makers.length && S.makers.indexOf(li.getAttribute("data-maker")) === -1) return false;
    var hay = li.getAttribute("data-hay") || "";
    for (var i = 0; i < t.length; i++) if (hay.indexOf(t[i]) === -1) return false;
    if (S.filter) {
      var st = li.getAttribute("data-state");
      if (st !== S.filter) return false;
    }
    return true;
  }
  function mark(text, t) {
    var s = esc(text);
    if (!t.length) return s;
    var re = new RegExp("(" + t.map(function (x) { return esc(x).replace(/[.*+?^${"$"}{}()|[\]\\]/g, "\\$&"); }).join("|") + ")", "gi");
    return s.replace(re, "<mark>$1</mark>");
  }
  function stateCount(st) { var n = 0; each(rows(), function (li) { if (li.getAttribute("data-state") === st) n++; }); return n; }
  function apply() {
    var list = $("pick-list");
    if (!list) return;
    var t = tokens(S.q), shown = 0, all = rows();
    each(all, function (li) {
      var on = matches(li, t);
      li.hidden = !on;
      if (on) shown++;
      each(li.querySelectorAll("[data-hl]"), function (el) {
        if (!el.hasAttribute("data-t")) el.setAttribute("data-t", el.textContent);
        var want = mark(el.getAttribute("data-t"), t);
        if (el.innerHTML !== want) el.innerHTML = want;
      });
    });
    var old = list.querySelector("li.empty[data-client]");
    if (old) old.remove();
    if (all.length && !shown) {
      var li = document.createElement("li");
      li.className = "empty";
      li.setAttribute("data-client", "");
      var narrowed = S.q.trim() || S.makers.length;
      li.innerHTML = "<p>" + (narrowed ? "No model matches “" + esc(S.q.trim() || "your filter") + "”" + (S.makers.length ? " from the makers you picked" : "") + "." : "None " + NOUN[S.filter] + ".") + "</p>" + (narrowed ? '<button type="button" class="btn small outline" data-clear-all>Clear</button>' : "");
      list.appendChild(li);
    }
    var base = S.filter ? stateCount(S.filter) : all.length, count = $("pick-count");
    if (count) {
      count.innerHTML = S.q.trim() || S.makers.length
        ? '<b class="num">' + shown + "</b> of " + base + (S.filter ? " " + NOUN[S.filter] : "") + (S.q.trim() ? " match “" + esc(S.q.trim()) + "”" : "")
        : '<span class="num">' + base + "</span> " + (S.filter ? NOUN[S.filter] + ' · <button type="button" class="link" data-filter="' + S.filter + '" style="font-size:13px">Show all</button>' : "models");
    }
    var search = main.querySelector(".search");
    if (search) search.classList.toggle("has-q", !!S.q);
    each(main.querySelectorAll(".cell[data-filter]"), function (c) { c.setAttribute("aria-pressed", String(c.getAttribute("data-filter") === S.filter)); });
    each(main.querySelectorAll("[data-det]"), function (b) {
      var id = b.getAttribute("data-det"), panel = $("det-" + id), open = !!S.det[id];
      b.setAttribute("aria-expanded", String(open));
      if (panel) panel.hidden = !open;
    });
    Object.keys(S.allowed).forEach(showCheck);
    Object.keys(S.waiting).forEach(function (k) { var b = byK(k); if (b) busy(b); });
    renderMakers(true);
  }

  // ---------- the Maker filter ----------
  function makerCounts() {
    var out = {}, order = [];
    each(rows(), function (li) {
      var k = li.getAttribute("data-maker");
      if (!out[k]) { out[k] = { name: li.getAttribute("data-maker-name") || k, n: 0 }; order.push(k); }
      out[k].n++;
    });
    order.sort(function (a, b) { return out[a].name.localeCompare(out[b].name); });
    return { by: out, order: order };
  }
  function renderMakers(keepList) {
    var el = main.querySelector("[data-maker]");
    if (!el) return;
    var mk = makerCounts();
    S.makers = S.makers.filter(function (k) { return mk.by[k]; });
    if (!el.firstChild) {
      el.innerHTML = '<button type="button" class="btn outline maker-btn" aria-haspopup="true" aria-expanded="false" data-maker-toggle data-k="maker">Maker <span class="n"></span><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></button>' +
        '<div class="pop" role="dialog" aria-label="Filter by maker"><input type="search" name="maker-find" placeholder="Find a maker" aria-label="Find a maker" data-maker-find autocomplete="off"><ul></ul><div class="pop-foot"><button type="button" class="link" data-maker-clear>Clear</button><button type="button" class="btn small outline" data-maker-done>Done</button></div></div>';
    }
    var find = el.querySelector("[data-maker-find]"), f = find.value.toLowerCase();
    if (!keepList || !el.querySelector(".pop ul").children.length) {
      var items = mk.order.filter(function (k) { return !f || mk.by[k].name.toLowerCase().indexOf(f) !== -1 || k.indexOf(f) !== -1; }).map(function (k) {
        return '<li><label><input type="checkbox" name="maker" data-maker-key value="' + esc(k) + '"' + (S.makers.indexOf(k) !== -1 ? " checked" : "") + ">" + esc(mk.by[k].name) + '<span class="c num">' + mk.by[k].n + "</span></label></li>";
      }).join("") || '<li class="none">No maker matches “' + esc(find.value) + '”.</li>';
      el.querySelector(".pop ul").innerHTML = items;
    }
    var btn = el.querySelector(".maker-btn");
    btn.classList.toggle("on", S.makers.length > 0);
    btn.querySelector(".n").textContent = S.makers.length || "";
    btn.setAttribute("aria-label", S.makers.length ? "Maker, " + S.makers.length + " chosen" : "Maker");
    var chips = $("pick-chips");
    if (chips) {
      chips.classList.toggle("on", S.makers.length > 0);
      chips.innerHTML = S.makers.map(function (k) { return '<button type="button" class="chip" data-chip="' + esc(k) + '" aria-label="Remove ' + esc(mk.by[k].name) + '">' + esc(mk.by[k].name) + '<svg viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg></button>'; }).join("") +
        (S.makers.length > 1 ? '<button type="button" class="link" style="font-size:13px" data-maker-clear>Clear makers</button>' : "");
    }
  }
  function closeMakers() {
    var m = main.querySelector(".maker.open");
    if (m) { m.classList.remove("open"); m.querySelector(".maker-btn").setAttribute("aria-expanded", "false"); }
  }

  // ---------- rows the account leaves out: the settings link, then Check again ----------
  function showCheck(id) {
    var link = main.querySelector('a[data-allow="' + cssq(id) + '"]'), form = main.querySelector('form[data-check-for="' + cssq(id) + '"]');
    if (!form) { delete S.allowed[id]; return; }
    if (link) link.hidden = true;
    form.hidden = false;
  }

  // ---------- requests, one at a time ----------
  function busy(b) {
    if (b.getAttribute("aria-busy") === "true") return;
    b.setAttribute("aria-busy", "true");
    b.disabled = true;
    var label = b.getAttribute("data-busy"), lbl = b.querySelector(".lbl"), ico = b.querySelector(".ico");
    if (label === null) return;
    if (lbl) { lbl.textContent = label; if (ico) ico.innerHTML = SPIN; else lbl.insertAdjacentHTML("beforebegin", SPIN); }
    else b.innerHTML = SPIN + (label ? " " + esc(label) : "");
  }
  function say(text) {
    var box = main.querySelector('[data-part="err"]') || main.querySelector('[data-part="banner"]');
    if (box) box.innerHTML = '<div class="err" role="alert"><div><p>' + esc(text) + "</p></div></div>";
  }
  // opens: a view link, whose answer may open a confirm or an editor: focus
  // goes to what it marks data-autofocus.
  function send(url, init, k, isPoll, opens) {
    if (k) S.waiting[k] = true;
    S.queue.push({ url: url, init: init, k: k, poll: !!isPoll, opens: !!opens });
    if (!S.busy) next();
  }
  function next() {
    var job = S.queue.shift();
    if (!job) { S.busy = false; poll(); return; }
    S.busy = true;
    var init = job.init || {};
    // The view shown now goes with every action, so a test keeps the results
    // already under their rows.
    init.headers = job.poll ? { accept: "application/json", "x-cos-poll": "1" } : { accept: "application/json", "x-cos-view": S.view };
    init.credentials = "same-origin";
    fetch(job.url, init)
      .then(function (r) { if (!r.ok && r.status !== 400 && r.status !== 429 && r.status !== 502) throw new Error(String(r.status)); return r.json(); })
      .then(function (j) {
        if (job.k) delete S.waiting[job.k];
        if (typeof j.view === "string") S.view = j.view;
        swap(j.main, j.focus, job.opens);
      })
      .catch(function () {
        if (job.k) delete S.waiting[job.k];
        swap(null);
        say("Couldn't reach the app just now. Try again.");
      })
      .then(next);
  }
  var POLL_MS = 8000;
  function poll() {
    clearTimeout(S.timer);
    if (!main.querySelector("[data-running]")) return;
    S.timer = setTimeout(function () {
      if (S.busy || S.queue.length || document.visibilityState === "hidden") { poll(); return; }
      send(location.pathname + "?" + S.view, { method: "GET" }, null, true);
    }, POLL_MS);
  }

  // ---------- swapping the parts that changed ----------
  function remember() { S.last = {}; each(main.querySelectorAll("[data-part]"), function (p) { S.last[p.getAttribute("data-part")] = p.outerHTML; }); }
  function rowIntoView(el) {
    var box = $("tbl-box"), li = el && el.closest && el.closest("#pick-list > li");
    if (!box || !li) return;
    var top = li.offsetTop, bottom = top + li.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top - 4;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight + 8;
  }
  function swap(html, focusK, opens) {
    var a = document.activeElement, k = a && a.getAttribute && a.getAttribute("data-k");
    var keep = {};
    each(main.querySelectorAll("input[data-keep]"), function (i) { keep[i.getAttribute("data-k")] = i.value; });
    var box = $("tbl-box"), top = box ? box.scrollTop : 0;
    if (html !== null) {
      var tpl = document.createElement("template");
      tpl.innerHTML = html;
      var fresh = tpl.content.querySelectorAll("[data-part]"), live = main.querySelectorAll("[data-part]"), same = fresh.length === live.length;
      for (var i = 0; same && i < fresh.length; i++) same = fresh[i].getAttribute("data-part") === live[i].getAttribute("data-part");
      if (!same) {
        // A part sent as "keep yours" keeps the page's own.
        each(fresh, function (p) {
          if (!p.hasAttribute("data-keep")) return;
          var mine = main.querySelector('[data-part="' + p.getAttribute("data-part") + '"]');
          if (mine) p.replaceWith(mine.cloneNode(true));
        });
        main.replaceChildren(tpl.content);
        S.det = {}; S.allowed = {};
        remember();
      } else {
        each(fresh, function (p, i) {
          if (p.hasAttribute("data-keep")) return;
          var name = p.getAttribute("data-part"), outer = p.outerHTML;
          if (S.last[name] !== outer) live[i].replaceWith(p);
          S.last[name] = outer;
        });
      }
    } else {
      // A request that failed: put back the parts as they were.
      each(main.querySelectorAll("[data-part]"), function (p) {
        var t = document.createElement("template");
        t.innerHTML = S.last[p.getAttribute("data-part")] || p.outerHTML;
        p.replaceWith(t.content.firstChild);
      });
    }
    apply();
    box = $("tbl-box");
    if (box) box.scrollTop = top;
    Object.keys(keep).forEach(function (kk) { var inp = byK(kk); if (inp && inp.tagName === "INPUT") inp.value = keep[kk]; });
    // Focus stays where it was; where that button is gone, it goes to the next step.
    var target = byK(focusK) || (opens ? main.querySelector("[data-autofocus]") : null) || byK(k) || (k ? main.querySelector(".btn.primary:not([disabled])") : null);
    if (target && target !== document.activeElement && !target.disabled && !target.hidden) {
      target.focus({ preventScroll: true });
      if (focusK || opens) rowIntoView(target);
    }
    poll();
  }

  // ---------- events ----------
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form.matches || !form.matches("form[data-fetch]") || !main.contains(form)) return;
    e.preventDefault();
    var b = e.submitter || form.querySelector("[type=submit]");
    if (b && b.disabled) return;
    var data = new FormData(form);
    if (b && b.name) data.append(b.name, b.value);
    var k = b && b.getAttribute("data-k");
    if (b) busy(b);
    send(form.action, { method: "POST", body: data }, k);
  });
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest) return;
    if (!t.closest(".maker")) closeMakers();
    var a = t.closest("a[data-view]");
    if (a && main.contains(a) && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      send(a.href.split("#")[0], { method: "GET" }, a.getAttribute("data-k"), false, true);
      return;
    }
    var allow = t.closest("a[data-allow]");
    if (allow) { var id = allow.getAttribute("data-allow"); S.allowed[id] = true; setTimeout(function () { showCheck(id); var f = main.querySelector('form[data-check-for="' + cssq(id) + '"] button'); if (f) f.focus({ preventScroll: true }); }, 0); return; }
    var hide = t.closest("[data-hide]");
    if (hide) {
      var more = hide.closest(".more"), gone = hide.getAttribute("data-hide");
      if (more) more.remove();
      var p = new URLSearchParams(S.view), kept = p.getAll("result").filter(function (r) { return r.split("|")[0] !== gone; });
      p.delete("result");
      kept.forEach(function (r) { p.append("result", r); });
      p.delete("notice"); p.delete("kind");
      S.view = p.toString();
      return;
    }
    var det = t.closest("[data-det]");
    if (det) { var d = det.getAttribute("data-det"); S.det[d] = !S.det[d]; apply(); return; }
    var cell = t.closest("[data-filter]");
    if (cell) { var f = cell.getAttribute("data-filter"); S.filter = S.filter === f ? null : f; var bx = $("tbl-box"); if (bx) bx.scrollTop = 0; apply(); return; }
    if (t.closest("[data-clear-all]")) { S.q = ""; S.makers = []; var q = $("pick-q"); if (q) { q.value = ""; q.focus(); } apply(); renderMakers(); return; }
    if (t.closest("[data-clear-q]")) { S.q = ""; $("pick-q").value = ""; $("pick-q").focus(); apply(); return; }
    var tog = t.closest("[data-maker-toggle]");
    if (tog) {
      var m = tog.parentElement, open = !m.classList.contains("open");
      closeMakers();
      m.classList.toggle("open", open);
      tog.setAttribute("aria-expanded", String(open));
      if (open) { var fi = m.querySelector("[data-maker-find]"); fi.value = ""; renderMakers(); fi.focus(); }
      return;
    }
    if (t.closest("[data-maker-done]")) { closeMakers(); var mb = byK("maker"); if (mb) mb.focus(); return; }
    if (t.closest("[data-maker-clear]")) { S.makers = []; renderMakers(); apply(); return; }
    var chip = t.closest("[data-chip]");
    if (chip) { var key = chip.getAttribute("data-chip"); S.makers = S.makers.filter(function (x) { return x !== key; }); renderMakers(); apply(); var mb2 = byK("maker"); if (mb2) mb2.focus(); }
  });
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t.matches && t.matches("[data-maker-key]")) {
      var v = t.value;
      if (t.checked) { if (S.makers.indexOf(v) === -1) S.makers.push(v); } else S.makers = S.makers.filter(function (x) { return x !== v; });
      renderMakers(true);
      apply();
    }
  });
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (t.id === "pick-q") { S.q = t.value; var bx = $("tbl-box"); if (bx) bx.scrollTop = 0; apply(); }
    else if (t.matches && t.matches("[data-maker-find]")) renderMakers();
  });
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t.id === "pick-q" && e.key === "Escape" && t.value) { e.preventDefault(); t.value = ""; S.q = ""; apply(); }
    else if (e.key === "Escape" && main.querySelector(".maker.open")) { closeMakers(); var mb = byK("maker"); if (mb) mb.focus(); }
  });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") poll(); });

  // ---------- start ----------
  remember();
  apply();
  poll();
  // Back from the consent page: the search field, once, with the section in view.
  if (main.hasAttribute("data-land")) {
    main.removeAttribute("data-land");
    var land = function () {
      var sec = $("test"), q = $("pick-q");
      if (!sec || !q) return;
      window.scrollTo(0, sec.getBoundingClientRect().top + window.scrollY - 16);
      q.focus({ preventScroll: true });
    };
    if (document.readyState === "complete") land(); else window.addEventListener("load", land, { once: true });
  }
})();
`;
