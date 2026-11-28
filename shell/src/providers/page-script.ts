// The script of Models › Setup › Providers. Nothing it does reloads the page
// or changes its address (the owner, 2026-11-28):
//
// - Search, the Maker filter (models/maker-filter.ts: its find box and chips)
//   and the strip's Works / Needs credit / Doesn't work / Not tested yet cells only show and
//   hide rows: no request. The strip and its bar count the rows search, the
//   Maker filter and a strength show (each row's data-state, its rowState),
//   the end label then reading "N shown", and a line under Test all
//   says Test all and Retest failed still cover the whole list. A strip cell
//   filters within that view and leaves the counts as they are.
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
// - An address with strength=<Smallest|Middle|Strongest> (and show=<works|
//   credit|fails|pending>) opens the table showing only that strength's models (in
//   that state), as Model for each task links a strength with no usable model;
//   the count line names it, and its Show all shows every model again.
// Focus, the table's scroll position, typed cap values and the open details
// survive every swap. Without the script, every form posts and redirects
// back (page.ts), and every link is a plain address.

import { MAKER_FILTER_JS } from "../models/maker-filter";

export const PAGE_SCRIPT = String.raw`
(function () {
  "use strict";
  var main = document.getElementById("screen");
  if (!main || !window.fetch || !window.history) return;
  var S = { q: "", filter: null, view: main.getAttribute("data-view") || "", last: {}, queue: [], busy: false, waiting: {}, det: {}, allowed: {}, timer: 0, built: false };
  var SPIN = '<span class="spin" aria-hidden="true"></span>';
  var NOUN = { works: "that work", credit: "that need credit", fails: "that don't work", pending: "not tested yet" };
  var TONE = { works: "good", credit: "warn", fails: "bad" };
  var asked = new URLSearchParams(location.search);
  S.tier = ["Smallest", "Middle", "Strongest"].indexOf(asked.get("strength")) !== -1 ? asked.get("strength") : null;
  if (S.tier && NOUN[asked.get("show")]) S.filter = asked.get("show");

  function $(id) { return document.getElementById(id); }
  function cssq(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }
  function byK(k) { return k ? main.querySelector('[data-k="' + cssq(k) + '"]') : null; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function rows() { return main.querySelectorAll("#pick-list > li.row"); }
  function tokens(q) { return q.toLowerCase().split(/\s+/).filter(Boolean); }


  // ---------- filters: search, maker, the strip ----------
  // In the view: the strength, the makers and the search; the strip's own
  // cell filters within it.
  function inView(li, t) {
    if (S.tier && li.getAttribute("data-strength") !== S.tier) return false;
    if (!makers.matches(li)) return false;
    var hay = li.getAttribute("data-hay") || "";
    for (var i = 0; i < t.length; i++) if (hay.indexOf(t[i]) === -1) return false;
    return true;
  }
  function matches(li, t) { return inView(li, t) && (!S.filter || li.getAttribute("data-state") === S.filter); }
  // The strip, its bar and its end label, from the rows in view.
  function recount(all, t) {
    var c = { works: 0, credit: 0, fails: 0, pending: 0 };
    each(all, function (li) {
      if (!inView(li, t)) return;
      var st = li.getAttribute("data-state");
      if (c.hasOwnProperty(st)) c[st]++;
    });
    var total = c.works + c.credit + c.fails + c.pending, narrowed = !!(S.tier || t.length || makers.chosen().length);
    function pct(n) { return (total ? (n / total) * 100 : 0).toFixed(3); }
    each(["works", "credit", "fails", "pending"], function (k) {
      var v = main.querySelector('.cell[data-filter="' + k + '"] .v');
      if (!v) return;
      v.textContent = String(c[k]);
      if (TONE[k]) v.classList.toggle(TONE[k], c[k] > 0);
    });
    var bar = main.querySelector(".bar");
    if (bar) {
      // The same words as models-table.ts barLabel.
      bar.setAttribute("aria-label", (c.works + c.credit + c.fails) + (narrowed ? " tested of " + total + " shown" : " of " + total + " tested") + ": " + c.works + " work, " + c.credit + " need credit, " + c.fails + " don't");
      each([["w", "works"], ["c", "credit"], ["f", "fails"]], function (seg) {
        var i = bar.querySelector("i." + seg[0]);
        if (i) i.setAttribute("style", "width:" + pct(c[seg[1]]) + "%");
      });
    }
    var act = main.querySelector("[data-credit-act]");
    if (act) act.hidden = !c.credit;
    var ends = main.querySelector("[data-ends]");
    if (ends) ends.textContent = narrowed ? total + " shown" : total + " models";
    each(main.querySelectorAll("[data-whole-list]"), function (p) { p.hidden = !narrowed; });
  }
  function mark(text, t) {
    var s = esc(text);
    if (!t.length) return s;
    var re = new RegExp("(" + t.map(function (x) { return esc(x).replace(/[.*+?^${"$"}{}()|[\]\\]/g, "\\$&"); }).join("|") + ")", "gi");
    return s.replace(re, "<mark>$1</mark>");
  }
  function inTier(li) { return !S.tier || li.getAttribute("data-strength") === S.tier; }
  function stateCount(st) { var n = 0; each(rows(), function (li) { if (inTier(li) && (!st || li.getAttribute("data-state") === st)) n++; }); return n; }
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
      var narrowed = S.q.trim() || makers.chosen().length;
      li.innerHTML = "<p>" + (narrowed ? "No model matches “" + esc(S.q.trim() || "your filter") + "”" + (makers.chosen().length ? " from the makers you picked" : "") + "." : "No " + (S.tier ? S.tier + " " : "") + "models" + (S.filter ? " " + NOUN[S.filter] : "") + ".") + (S.tier ? ' <button type="button" class="link" data-show-all>Show all</button>' : "") + "</p>" + (narrowed ? '<button type="button" class="btn small outline" data-clear-all>Clear</button>' : "");
      list.appendChild(li);
    }
    recount(all, t);
    var base = S.filter || S.tier ? stateCount(S.filter) : all.length, count = $("pick-count");
    var noun = (S.tier ? S.tier + " " : "") + "models" + (S.filter ? " " + NOUN[S.filter] : "");
    if (count) {
      count.innerHTML = S.q.trim() || makers.chosen().length
        ? '<b class="num">' + shown + "</b> of " + base + (S.filter || S.tier ? " " + noun : "") + (S.q.trim() ? " match “" + esc(S.q.trim()) + "”" : "")
        : '<span class="num">' + base + "</span> " + (S.filter || S.tier ? noun + ' · <button type="button" class="link" data-show-all style="font-size:13px">Show all</button>' : "models");
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
    makers.render(true);
  }

  // ---------- the Maker filter (models/maker-filter.ts) ----------
  ${MAKER_FILTER_JS}

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
    if (t.closest("[data-show-all]")) { S.filter = null; S.tier = null; var sb = $("tbl-box"); if (sb) sb.scrollTop = 0; apply(); return; }
    var cell = t.closest("[data-filter]");
    if (cell) { var f = cell.getAttribute("data-filter"); S.filter = S.filter === f ? null : f; var bx = $("tbl-box"); if (bx) bx.scrollTop = 0; apply(); return; }
    if (t.closest("[data-clear-all]")) { S.q = ""; makers.clear(); var q = $("pick-q"); if (q) { q.value = ""; q.focus(); } apply(); return; }
    if (t.closest("[data-clear-q]")) { S.q = ""; $("pick-q").value = ""; $("pick-q").focus(); apply(); return; }
  });
  document.addEventListener("input", function (e) {
    var t = e.target;
    if (t.id === "pick-q") { S.q = t.value; var bx = $("tbl-box"); if (bx) bx.scrollTop = 0; apply(); }
  });
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t.id === "pick-q" && e.key === "Escape" && t.value) { e.preventDefault(); t.value = ""; S.q = ""; apply(); }
  });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") poll(); });

  // ---------- start ----------
  // After the page's own listeners: Escape that clears the search does only that.
  var makers = makerFilter({ scope: main, rows: rows, changed: apply });
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
