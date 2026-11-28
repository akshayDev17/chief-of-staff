// The script of Models › Setup › Model for each task (picker-page.ts).
// Nothing it does on a mere choice sends a request, reloads the page or
// changes its address (the owner, 2026-11-27: "upon changing a model in the
// dropdwon, i believe some request is sent"):
//
// - Each dropdown opens a list of the task's models, with a search box at its
//   top when the list is long; arrows, Enter and Escape work in it. Choosing
//   a model sets the row's plain select (the form's own field) and marks the
//   row changed. Choosing a task's fallback as its main model swaps the two.
//   A fallback list hides the row's main model.
// - The bar under the list counts the changed rows, with Undo and Save. Save
//   sends every changed row in one request, asking for JSON; the answer is the
//   page's <main>, swapped in place with the scroll kept and what it says shown
//   in the bar for a few seconds, or a problem shown in the bar with the
//   choices kept.
// - Accept all, Use my free models and Ask Admin for help (forms marked
//   data-fetch, with no fields of their own) are sent in place the same way.
//   The two taps (data-rows) carry the changed rows, which are saved as
//   chosen in the same request, so the answer never drops a choice (a tap
//   leaves those rows as chosen). Help carries none and saves nothing: its
//   answer shows in the banner only, and the rows stay as they are.
// Without the script, the plain selects show, each row has its own Save, and
// every form posts and redirects back.

export const PICKER_SCRIPT = String.raw`
(function () {
  "use strict";
  var main = document.getElementById("screen");
  if (!main || typeof fetch !== "function" || typeof FormData !== "function") return;
  var busy = false;

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function $(id) { return document.getElementById(id); }
  function pickOf(el) { return el && el.closest ? el.closest("[data-pick]") : null; }
  function selectOf(pick) { return $(pick.getAttribute("data-pick")); }
  function rowOf(el) { return el.closest(".task"); }
  function options(pick) { return pick.querySelectorAll('li[role="option"]'); }
  function visible(pick) { return Array.prototype.filter.call(options(pick), function (o) { return !o.hidden; }); }
  function other(pick) {
    var row = rowOf(pick), role = pick.getAttribute("data-role") === "main" ? "fallback" : "main";
    return row.querySelector('[data-pick][data-role="' + role + '"]');
  }

  // ---------- showing a choice ----------
  function show(pick, value) {
    var sel = selectOf(pick), btn = pick.querySelector(".pick-btn"), pv = btn.querySelector(".pv");
    if (!pv.hasAttribute("data-orig-html")) pv.setAttribute("data-orig-html", pv.innerHTML);
    sel.value = value;
    var match = null;
    each(options(pick), function (o) { var on = o.getAttribute("data-value") === value; o.setAttribute("aria-selected", String(on)); if (on) match = o; });
    var orig = sel.getAttribute("data-orig") || "";
    if (value === orig) pv.innerHTML = pv.getAttribute("data-orig-html");
    else if (match) pv.innerHTML = match.querySelector(".ov").outerHTML;
    if (value === orig) btn.removeAttribute("data-changed"); else btn.setAttribute("data-changed", "");
  }
  // A fallback list never offers the row's main model.
  function hideMain(row) {
    var m = row.querySelector('[data-pick][data-role="main"]'), f = row.querySelector('[data-pick][data-role="fallback"]');
    if (!m || !f) return;
    var mv = selectOf(m).value;
    each(options(f), function (o) { o.hidden = !!mv && o.getAttribute("data-value") === mv; });
  }
  function choose(pick, value) {
    var role = pick.getAttribute("data-role"), mate = other(pick), was = selectOf(pick).value;
    if (role === "main" && mate && selectOf(mate).value === value && value) {
      // The fallback becomes the main model; the old main its fallback, where its list has it.
      var back = Array.prototype.some.call(options(mate), function (o) { return o.getAttribute("data-value") === was; }) ? was : "";
      show(mate, back);
    }
    show(pick, value);
    var row = rowOf(pick);
    hideMain(row);
    mark(row);
  }

  // ---------- changed rows, the bar ----------
  function changed(row) {
    return Array.prototype.some.call(row.querySelectorAll("select.nsel"), function (s) { return s.value !== (s.getAttribute("data-orig") || ""); });
  }
  function mark(row) {
    if (changed(row)) row.setAttribute("data-dirty", ""); else row.removeAttribute("data-dirty");
    // A note about a model the user has just changed no longer applies.
    each(row.querySelectorAll(".t-note [data-about]"), function (n) {
      var s = row.querySelector('[data-pick][data-role="' + n.getAttribute("data-about") + '"]');
      n.hidden = !!s && selectOf(s).value !== (selectOf(s).getAttribute("data-orig") || "");
    });
    var note = row.querySelector(".t-note");
    if (note) note.toggleAttribute("data-quiet", !Array.prototype.some.call(note.querySelectorAll("[data-about], .t-says span:not([data-about]), .t-act:not([data-about])"), function (c) { return !c.hidden; }));
    bar();
  }
  function dirtyRows() { return main.querySelectorAll(".task[data-dirty]"); }
  function bar(problem) {
    var b = $("savebar");
    if (!b) return;
    var n = dirtyRows().length;
    b.removeAttribute("data-done");
    b.hidden = n === 0;
    b.querySelector(".sb-n").textContent = n === 1 ? "1 task changed" : n + " tasks changed";
    b.querySelector(".sb-err").textContent = problem || "";
    // One solid blue button: Save while a row is changed.
    each(main.querySelectorAll(".btn.primary:not([data-save]), .btn[data-was-primary]"), function (x) {
      if (n) { x.classList.remove("primary"); x.setAttribute("data-was-primary", ""); }
      else { x.classList.add("primary"); x.removeAttribute("data-was-primary"); }
    });
  }
  function undo() {
    each(dirtyRows(), function (row) {
      each(row.querySelectorAll("[data-pick]"), function (p) { show(p, selectOf(p).getAttribute("data-orig") || ""); });
      hideMain(row);
      mark(row);
    });
    bar();
  }

  // ---------- the open list ----------
  var open = null, at = -1;
  function setActive(i) {
    var vis = visible(open);
    each(options(open), function (o) { o.classList.remove("on"); });
    at = vis.length ? Math.max(0, Math.min(i, vis.length - 1)) : -1;
    var q = open.querySelector(".pick-q"), list = open.querySelector('[role="listbox"]');
    var target = q || list;
    if (at >= 0) {
      vis[at].classList.add("on");
      target.setAttribute("aria-activedescendant", vis[at].id);
      var box = list, o = vis[at];
      if (o.offsetTop < box.scrollTop) box.scrollTop = o.offsetTop;
      else if (o.offsetTop + o.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = o.offsetTop + o.offsetHeight - box.clientHeight;
    } else target.removeAttribute("aria-activedescendant");
  }
  function filter(pick, text) {
    var t = text.toLowerCase().split(/\s+/).filter(Boolean), shown = 0, mv = "";
    if (pick.getAttribute("data-role") === "fallback") { var m = other(pick); mv = m ? selectOf(m).value : ""; }
    each(options(pick), function (o) {
      var hay = o.getAttribute("data-hay") || "", on = !(mv && o.getAttribute("data-value") === mv);
      for (var i = 0; on && i < t.length; i++) if (hay.indexOf(t[i]) === -1) on = false;
      o.hidden = !on;
      if (on) shown++;
    });
    each(pick.querySelectorAll(".pick-group"), function (g) { g.hidden = !!t.length; });
    pick.querySelector(".pick-none").hidden = shown > 0;
    setActive(0);
  }
  function openPick(pick) {
    if (open && open !== pick) closePick(false);
    var pop = pick.querySelector(".pick-pop"), btn = pick.querySelector(".pick-btn");
    if (!pop || btn.disabled) return;
    open = pick;
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    var q = pick.querySelector(".pick-q");
    if (q) q.value = "";
    filter(pick, "");
    var vis = visible(pick), sel = 0;
    vis.forEach(function (o, i) { if (o.getAttribute("aria-selected") === "true") sel = i; });
    setActive(sel);
    (q || pick.querySelector('[role="listbox"]')).focus();
  }
  function closePick(focusBtn) {
    if (!open) return;
    var pick = open;
    open = null;
    pick.querySelector(".pick-pop").hidden = true;
    var btn = pick.querySelector(".pick-btn");
    btn.setAttribute("aria-expanded", "false");
    if (focusBtn) btn.focus();
  }

  // ---------- sending in place ----------
  // The answer's <main> in place, the scroll kept; what it says shows in
  // the bar at the foot of the screen for a few seconds, and in the banner.
  function swap(html) {
    var y = window.scrollY || 0;
    main.innerHTML = html;
    if (window.scrollTo) window.scrollTo(0, y);
    var b = main.querySelector('[data-part="banner"] [tabindex]'), bar = $("savebar");
    if (b) b.focus({ preventScroll: true });
    if (b && bar) {
      bar.hidden = false;
      bar.setAttribute("data-done", "");
      bar.querySelector(".sb-n").textContent = b.textContent;
      setTimeout(function () { if (bar.hasAttribute("data-done")) bar.hidden = true; }, 4000);
    }
  }
  function say(text, cls, role) {
    var banner = main.querySelector('[data-part="banner"]');
    if (!banner) return;
    banner.innerHTML = '<div class="banner ' + cls + '" role="' + role + '" tabindex="-1"></div>';
    banner.firstChild.textContent = text;
    banner.firstChild.focus({ preventScroll: true });
  }
  function send(action, body, answered) {
    if (busy) return false;
    busy = true;
    main.setAttribute("aria-busy", "true");
    fetch(action, { method: "POST", body: body, headers: { accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.main) swap(j.main);
        else if (j.said) { say(j.said, "ok", "status"); answered(); }
        else answered(j.problem || "Couldn't save. Try again.");
      })
      .catch(function () { answered("Couldn't reach the app. Try again."); })
      .then(function () { busy = false; main.removeAttribute("aria-busy"); });
    return true;
  }
  // The changed rows, in /change's fields.
  function changedRows() {
    var body = new FormData();
    each(dirtyRows(), function (row) {
      body.append("task", row.getAttribute("data-task"));
      each(row.querySelectorAll("select.nsel"), function (s) { body.append(s.name, s.value); });
    });
    return body;
  }
  function save() {
    if (!dirtyRows().length) return;
    var body = changedRows();
    var btn = main.querySelector("[data-save]");
    var sent = send(main.querySelector(".task-f").getAttribute("action"), body, function (problem) {
      if (btn) { btn.disabled = false; btn.textContent = "Save"; }
      bar(problem);
    });
    if (sent && btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  }

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var t = e.target;
    var btn = t.closest(".pick-btn");
    if (btn && main.contains(btn)) { var p = pickOf(btn); if (open === p) closePick(true); else openPick(p); return; }
    var o = t.closest('li[role="option"]');
    if (o && open && open.contains(o)) { var pk = open; closePick(true); choose(pk, o.getAttribute("data-value")); return; }
    if (open && !open.contains(t)) closePick(false);
    var go = t.closest("[data-open]");
    if (go) { e.preventDefault(); var target = main.querySelector('[data-pick="' + go.getAttribute("data-open") + '"]'); if (target) { target.scrollIntoView({ block: "center" }); openPick(target); } return; }
    if (t.closest("[data-save]")) { save(); return; }
    if (t.closest("[data-undo]")) { undo(); var first = main.querySelector(".pick-btn"); if (first) first.focus(); }
  });
  document.addEventListener("input", function (e) {
    if (open && e.target.classList && e.target.classList.contains("pick-q")) filter(open, e.target.value);
  });
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (!open) {
      var b = t.closest && t.closest(".pick-btn");
      if (b && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); openPick(pickOf(b)); }
      return;
    }
    if (!open.contains(t)) return;
    var vis = visible(open);
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(at - 1); }
    else if (e.key === "Home" && !open.querySelector(".pick-q")) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && !open.querySelector(".pick-q")) { e.preventDefault(); setActive(vis.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (at >= 0 && vis[at]) { var pk = open; closePick(true); choose(pk, vis[at].getAttribute("data-value")); } }
    else if (e.key === "Escape") { e.preventDefault(); closePick(true); }
    else if (e.key === "Tab") closePick(false);
  });
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!main.contains(f) || !f.hasAttribute("data-fetch")) return;
    e.preventDefault();
    var b = f.querySelector('button[type="submit"]');
    var rows = f.hasAttribute("data-rows");
    var sent = send(f.getAttribute("action"), rows ? changedRows() : new FormData(), function (problem) {
      if (b) b.disabled = false;
      if (!problem) return;
      // A refused change shows in the bar, beside the rows it is about.
      if (rows && dirtyRows().length) bar(problem);
      else say(problem, "warn", "alert");
    });
    if (sent && b) b.disabled = true;
  });
  window.addEventListener("beforeunload", function (e) { if (dirtyRows().length) { e.preventDefault(); e.returnValue = ""; } });

  each(main.querySelectorAll(".task"), hideMain);
})();
`;
