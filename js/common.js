/**
 * common.js - 跨页面共享逻辑
 * 包含：SVG 图标库、多 toast 堆叠、视图切换、设置页分类切换、
 *       主题切换（浅色/深色/自动）、卡片模糊度、壁纸灰暗度
 */
(function () {
  "use strict";

  // ===== 工具 =====
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // ===== SVG 图标库 =====
  var ICONS = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
    // 三横杠（汉堡）菜单图标
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><clipPath id="autoLeft"><rect x="0" y="0" width="12" height="24"/></clipPath><clipPath id="autoRight"><rect x="12" y="0" width="12" height="24"/></clipPath></defs><g clip-path="url(#autoLeft)"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></g><g clip-path="url(#autoRight)"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m17.66 17.66 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/></g><line x1="12" y1="2" x2="12" y2="22" stroke-width="1.5"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    "chevron-down": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
    switch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    hot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
    rank: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1.2" fill="currentColor"/><circle cx="4" cy="12" r="1.2" fill="currentColor"/><circle cx="4" cy="18" r="1.2" fill="currentColor"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.111.82-.261.82-.577 0-.285-.01-1.04-.016-2.04-3.338.726-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.468-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.405c1.02.005 2.045.14 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.77.84 1.235 1.91 1.235 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z"/></svg>'
  };
  window.ICONS = ICONS;
  window.$ = $;
  window.$all = $all;

  // ===== Toast 堆叠系统（右上角向下，最多 3 个）=====
  var toastList = [];
  var MAX_TOASTS = 3;
  var TOAST_DURATION = 2000;

  function showToast(msg) {
    var container = $("#toastContainer");
    if (!container) return;
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = msg;
    container.appendChild(toast);
    toastList.push(toast);
    while (toastList.length > MAX_TOASTS) {
      var oldest = toastList.shift();
      removeToast(oldest);
    }
    setTimeout(function () { removeToast(toast); }, TOAST_DURATION);
  }
  function removeToast(toast) {
    if (!toast || !toast.parentNode) return;
    var idx = toastList.indexOf(toast);
    if (idx >= 0) toastList.splice(idx, 1);
    if (toast.classList.contains("hiding")) return;
    toast.classList.add("hiding");
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 250);
  }
  window.showToast = showToast;

  // ===== SVG 图标注入 =====
  function injectIcons() {
    document.querySelectorAll("[data-icon]").forEach(function (el) {
      var name = el.getAttribute("data-icon");
      if (ICONS[name]) el.innerHTML = ICONS[name];
    });
  }
  window.injectIcons = injectIcons;

  // ===== 视图切换 =====
  var __lastView = null;
  function switchView(name) {
    var prev = __lastView;
    // 离开抽签页（且新页面不是抽签）→ 清除抽签运行时记录（历史/抽取进度），不加 toast
    if (prev === "draw" && name !== "draw") {
      try {
        if (typeof window.resetDrawRuntime === "function") window.resetDrawRuntime();
      } catch (e) {}
    }
    __lastView = name;
    $all(".view").forEach(function (v) {
      v.hidden = v.id !== "view-" + name;
    });
    $all(".nav-item[data-view]").forEach(function (n) {
      n.classList.toggle("active", n.dataset.view === name);
    });
    // 液态玻璃指示器同步滑轨位置
    try { window.LiquidGlass && LiquidGlass.setActiveTab(name); } catch (e) {}
    try { localStorage.setItem("jfes_view", name); } catch (e) {}
    var newHash = "#" + name;
    if (location.hash !== newHash) history.replaceState(null, "", newHash);
    var activeView = $("#view-" + name);
    if (activeView) {
      // view 自身（如果 body/html 滚的是 view 容器）
      activeView.scrollTop = 0;
      // 重置 view 内部所有独立滚动容器（list-wrap、card-scroll 等）
      var scrollers = activeView.querySelectorAll(".list-wrap, .card-scroll, .rank-board-scroll");
      for (var s = 0; s < scrollers.length; s++) scrollers[s].scrollTop = 0;
    }
    // 重置 window（部分浏览器/布局下 window 也会滚）
    try { window.scrollTo(0, 0); } catch (_e) {}
    injectIcons();
    // 切换到设置页时更新统计
    if (name === "settings") updateUserStats();
    // 切换到排行页时刷新第1列（项目选择 + 人员列表）
    if (name === "rank" && window.renderRankAll) window.renderRankAll();
  }
  window.switchView = switchView;

  // ===== 设置页用户统计 =====
  function updateUserStats() {
    try {
      var linksEl = $("#statLinks");
      var drawsEl = $("#statDraws");
      if (!linksEl && !drawsEl) return;
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem("jfes_random_person_v1") || "{}"); } catch (e) {}
      if (saved) {
        var lib = saved.linkLibrary || {};
        var totalLinks = (lib.people || []).length + (lib.projects || []).length + (lib.times || []).length + (lib.draws || []).length;
        if (linksEl) linksEl.textContent = totalLinks;
        if (drawsEl) drawsEl.textContent = (saved.history || []).length;
      } else {
        if (linksEl) linksEl.textContent = "0";
        if (drawsEl) drawsEl.textContent = "0";
      }
    } catch (e) {}
  }
  window.updateUserStats = updateUserStats;

  function getInitialView() {
    var hash = location.hash.slice(1);
    var valid = ["home", "hot", "rank", "draw", "settings"];
    if (valid.indexOf(hash) >= 0) return hash;
    return "home";
  }

  function bindViewSwitching() {
    $all(".nav-item[data-view]").forEach(function (item) {
      item.addEventListener("click", function () {
        switchView(item.dataset.view);
      });
    });
    window.addEventListener("hashchange", function () {
      switchView(getInitialView());
    });
  }

  // ===== 底部导航居中（不再需要赛季按钮配对偏移）=====
  function centerNav() {
    var nav = document.querySelector(".bottom-nav");
    if (!nav) return;
    nav.style.transform = "translateX(-50%)";
  }

  // ===== 液态玻璃导航栏（liquid-glass-webgl-2.0.0 移植引擎）=====
  var NAV_VIEW_ORDER = ["home", "hot", "rank", "draw", "settings"];
  function initLiquidGlass() {
    if (!window.LiquidGlass) return;
    try {
      window.LiquidGlass.init({
        nav: ".bottom-nav",
        order: NAV_VIEW_ORDER,
        onSelect: switchView
      });
    } catch (e) {
      console.warn("[JFES] 液态玻璃初始化失败", e);
    }
  }

  // ===== 设置页：分类切换 =====
  function bindSettingsCategories() {
    var categories = document.querySelectorAll(".settings-category");
    var panels = document.querySelectorAll(".settings-panel");
    var settingsView = document.getElementById("view-settings");
    if (!categories.length) return;

    function isMobile() { return window.matchMedia("(max-width: 900px)").matches; }

    // 给每个 panel 的 card-header 注入返回按钮（移动端用）
    var backSvg = (window.ICONS && window.ICONS.back) ||
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
    panels.forEach(function (panel) {
      var header = panel.querySelector(".card-header");
      if (!header || header.querySelector(".settings-detail-back")) return;
      // 确保 header 支持居中 absolute 按钮
      header.classList.add("center");
      header.style.position = "relative";
      var h2 = header.querySelector("h2");
      if (h2) {
        h2.style.flex = "1 1 auto";
        h2.style.textAlign = "center";
      }
      var back = document.createElement("button");
      back.className = "glass-btn round hp-detail-back-btn settings-detail-back";
      back.type = "button";
      back.dataset.icon = "back";
      back.setAttribute("aria-label", "返回");
      back.setAttribute("title", "返回");
      back.innerHTML = backSvg;
      back.hidden = true;
      back.addEventListener("click", function (e) {
        e.stopPropagation();
        if (settingsView) settingsView.classList.remove("settings-detail-mode");
        // 切回列表后让 col-1 选中的分类清 active 视觉
        if (isMobile()) {
          categories.forEach(function (c) { c.classList.remove("active"); });
        }
      });
      header.insertBefore(back, header.firstChild);
    });

    function enterDetailMode() {
      if (settingsView) settingsView.classList.add("settings-detail-mode");
      // 显示所有返回按钮
      panels.forEach(function (p) {
        var b = p.querySelector(".settings-detail-back");
        if (b) b.hidden = false;
      });
    }
    function exitDetailMode() {
      if (settingsView) settingsView.classList.remove("settings-detail-mode");
      panels.forEach(function (p) {
        var b = p.querySelector(".settings-detail-back");
        if (b) b.hidden = true;
      });
    }

    categories.forEach(function (cat) {
      cat.addEventListener("click", function () {
        var target = cat.dataset.category;
        categories.forEach(function (c) {
          c.classList.toggle("active", c.dataset.category === target);
        });
        panels.forEach(function (p) {
          p.hidden = p.dataset.panel !== target;
        });
        if (isMobile()) enterDetailMode();
      });
    });

    // 进设置 tab 清 mode
    var settingsNav = document.querySelector('.nav-item[data-view="settings"]');
    if (settingsNav) {
      settingsNav.addEventListener("click", exitDetailMode);
    }

    // 媒体查询切换
    var mql = window.matchMedia("(max-width: 900px)");
    if (mql.addEventListener) {
      mql.addEventListener("change", function () {
        if (!isMobile()) exitDetailMode();
      });
    } else {
      mql.addListener(function () {
        if (!isMobile()) exitDetailMode();
      });
    }
  }

  // ===== 主题切换（自定义液态玻璃下拉）=====
  var THEME_KEY = "jfes_theme";
  var THEME_NAMES = { light: "浅色模式", dark: "深色模式", auto: "自动切换" };
  var THEME_OPTIONS = [
    { value: "light", name: "浅色" },
    { value: "dark", name: "深色" },
    { value: "auto", name: "自动" }
  ];
  var autoCheckTimer = null;
  var syncThemeUI = null;  // 由 bindTheme 赋值，用于同步自定义下拉标签与高亮

  function loadTheme() {
    try { return localStorage.getItem(THEME_KEY) || "auto"; } catch (e) { return "auto"; }
  }
  function saveTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }
  function getEffectiveTheme(theme) {
    if (theme !== "auto") return theme;
    var hour = new Date().getHours();
    return (hour >= 18 || hour < 6) ? "dark" : "light";
  }
  function scheduleAutoCheck() {
    if (autoCheckTimer) clearInterval(autoCheckTimer);
    autoCheckTimer = setInterval(function () {
      var current = loadTheme();
      if (current !== "auto") return;
      var newEffective = getEffectiveTheme("auto");
      var currentEffective = document.body.getAttribute("data-effective");
      if (newEffective !== currentEffective) {
        document.body.setAttribute("data-effective", newEffective);
        applyWallpaper();
      }
    }, 60000);
  }
  function applyTheme(theme) {
    var effective = getEffectiveTheme(theme);
    document.body.setAttribute("data-theme", theme);
    document.body.setAttribute("data-effective", effective);
    applyWallpaper();
    // 同步设置页自定义下拉（标签 + 选项高亮）
    if (syncThemeUI) syncThemeUI(theme);
    if (theme === "auto") scheduleAutoCheck();
    else if (autoCheckTimer) { clearInterval(autoCheckTimer); autoCheckTimer = null; }
  }

  // ===== 赛季 + 深浅色 壁纸 =====
  // OP1Day/OP1Night = 第一赛季 浅/深；OP2Day/OP2Night = 第二赛季 浅/深
  function applyWallpaper() {
    var season = (window.JFESSeason && window.JFESSeason.get) ? window.JFESSeason.get() : "C2";
    var eff = document.body.getAttribute("data-effective") || "light";
    var name = "OP" + (season === "C1" ? "1" : "2") + (eff === "dark" ? "Night" : "Day");
    var url = "url('img/" + name + ".png')";
    var cur = document.body.style.backgroundImage;
    if (cur !== url) {
      document.body.style.backgroundImage = url + " , " + url;  // 先写两份强制刷新缓存判断
      document.body.style.backgroundImage = url;
    }
    // 背景其他参数由 CSS 提供（center/cover no-repeat fixed），inline 只覆盖 image
  }
  function setTheme(theme) {
    if (!THEME_NAMES[theme]) theme = "auto";
    saveTheme(theme);
    applyTheme(theme);
    showToast("已切换为「" + THEME_NAMES[theme] + "」");
  }
  function bindTheme() {
    var wrap = $("#themeSelectWrap");
    var trigger = $("#themeSelectTrigger");
    var dropdown = $("#themeSelectDropdown");
    if (!wrap || !trigger || !dropdown) return;

    function syncOptions(theme) {
      var opts = dropdown.querySelectorAll(".custom-select-option");
      opts.forEach(function (opt) {
        opt.classList.toggle("active", opt.dataset.value === theme);
      });
      var found = null;
      for (var i = 0; i < THEME_OPTIONS.length; i++) {
        if (THEME_OPTIONS[i].value === theme) { found = THEME_OPTIONS[i]; break; }
      }
      var label = $("#themeSelectLabel");
      if (label && found) label.textContent = found.name;
    }

    function openDropdown() {
      dropdown.hidden = false;
      wrap.classList.add("open");
    }
    function closeDropdown() {
      dropdown.hidden = true;
      wrap.classList.remove("open");
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!dropdown.hidden) closeDropdown();
      else openDropdown();
    });
    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target) && !dropdown.contains(e.target)) {
        closeDropdown();
      }
    });
    dropdown.addEventListener("click", function (e) {
      var option = e.target.closest(".custom-select-option");
      if (!option) return;
      setTheme(option.dataset.value);
      closeDropdown();
    });

    syncThemeUI = syncOptions;
    syncOptions(loadTheme());  // 初始化标签与高亮
  }

  // ===== 卡片模糊度 =====
  var BLUR_KEY = "jfes_card_blur";
  var DEFAULT_BLUR = 2;
  var MIN_BLUR = 0;
  var MAX_BLUR = 80;

  function loadBlur() {
    var v = parseInt(localStorage.getItem(BLUR_KEY), 10);
    if (isNaN(v)) return DEFAULT_BLUR;
    return Math.max(MIN_BLUR, Math.min(MAX_BLUR, v));
  }
  function applyBlur(px) {
    document.documentElement.style.setProperty("--card-blur", px + "px");
  }
  function updateBlurUI(px) {
    var slider = $("#blurSlider");
    var valEl = $("#blurValue");
    if (slider) slider.value = px;
    if (valEl) valEl.textContent = px + "px";
  }
  function saveBlur(px) {
    try { localStorage.setItem(BLUR_KEY, String(px)); } catch (e) {}
  }
  function bindBlur() {
    var slider = $("#blurSlider");
    if (!slider) return;
    slider.addEventListener("input", function () {
      var v = parseInt(slider.value, 10);
      applyBlur(v);
      updateBlurUI(v);
      saveBlur(v);
    });
  }

  // ===== 壁纸灰暗度 =====
  var DARKNESS_KEY = "jfes_bg_darkness";
  var DEFAULT_DARKNESS = 30;
  var MIN_DARKNESS = 0;
  var MAX_DARKNESS = 90;  // 上限 90%，避免完全变黑

  function loadDarkness() {
    var v = parseInt(localStorage.getItem(DARKNESS_KEY), 10);
    if (isNaN(v)) return DEFAULT_DARKNESS;
    return Math.max(MIN_DARKNESS, Math.min(MAX_DARKNESS, v));
  }
  function applyDarkness(percent) {
    document.documentElement.style.setProperty("--bg-darkness", String(percent / 100));
  }
  function updateDarknessUI(percent) {
    var slider = $("#darknessSlider");
    var valEl = $("#darknessValue");
    if (slider) slider.value = percent;
    if (valEl) valEl.textContent = percent + "%";
  }
  function saveDarkness(percent) {
    try { localStorage.setItem(DARKNESS_KEY, String(percent)); } catch (e) {}
  }
  function bindDarkness() {
    var slider = $("#darknessSlider");
    if (!slider) return;
    slider.addEventListener("input", function () {
      var v = parseInt(slider.value, 10);
      applyDarkness(v);
      updateDarknessUI(v);
      saveDarkness(v);
    });
  }

  // ===== 网页命名 =====
  var PAGE_TITLE_KEY = "jfes_page_title";
  var DEFAULT_TITLE = "奥林PIG运动会官网";
  function loadPageTitle() {
    var v = localStorage.getItem(PAGE_TITLE_KEY);
    return v && v.trim() ? v : DEFAULT_TITLE;
  }
  function applyPageTitle(title) { document.title = title; }
  function updatePageTitleUI(title) {
    var input = $("#pageTitleInput");
    if (input && document.activeElement !== input) {
      input.value = title === DEFAULT_TITLE ? "" : title;
    }
  }
  function savePageTitle(title) {
    if (title && title.trim()) {
      try { localStorage.setItem(PAGE_TITLE_KEY, title); } catch (e) {}
    } else {
      try { localStorage.removeItem(PAGE_TITLE_KEY); } catch (e) {}
    }
  }
  function bindPageTitle() {
    var input = $("#pageTitleInput");
    if (!input) return;
    input.addEventListener("input", function () {
      var v = input.value.trim();
      savePageTitle(v);
      applyPageTitle(v || DEFAULT_TITLE);
    });
  }

  // ===== 赛季管理 =====
  // 赛季常量
  var SEASON_KEY = "jfes_current_season";
  var DEFAULT_SEASON = "C2";
  // 数据类型标识（文件头部注释格式：/*类型-版本*/）
  var SEASON_TYPES = ["C1", "C2", "HP"];

  function getCurrentSeason() {
    // 优先读取 sessionStorage（当前标签页会话有效，关闭后自动清除）
    // 若无存储则使用默认 C2
    try {
      var v = sessionStorage.getItem(SEASON_KEY);
      return (v === "C1" || v === "C2") ? v : DEFAULT_SEASON;
    } catch (e) {
      return DEFAULT_SEASON;
    }
  }

  function setCurrentSeason(season) {
    if (season !== "C1" && season !== "C2") return;
    // 只写入 sessionStorage（临时会话，关闭标签页即清除）
    try { sessionStorage.setItem(SEASON_KEY, season); } catch (e) {}
  }

  function initSeasonSelect() {
    var wrap = $("#seasonSelectWrap");
    var trigger = $("#seasonSelectTrigger");
    var dropdown = $("#seasonSelectDropdown");
    if (!wrap || !trigger || !dropdown) return;

    // 清理旧的 localStorage 赛季数据（升级后不再使用持久化存储）
    try {
      localStorage.removeItem(SEASON_KEY);
      localStorage.removeItem("jfes_season_migrated");
      localStorage.removeItem("jfes_user_season_choice");
    } catch (e) {}

    var SEASON_NAMES = { C1: "第一赛季", C2: "第二赛季" };

    // sessionStorage 在当前标签页有效，关闭标签页后自动清除 → 默认回到 C2
    var current = getCurrentSeason();

    function syncOptions() {
      var opts = dropdown.querySelectorAll(".custom-select-option");
      opts.forEach(function (opt) {
        opt.classList.toggle("active", opt.dataset.value === current);
      });
      var label = $("#seasonSelectLabel");
      if (label) label.textContent = SEASON_NAMES[current] || "第二赛季";
    }

    function openDropdown() {
      dropdown.hidden = false;
      wrap.classList.add("open");
      syncOptions();
    }

    function closeDropdown() {
      dropdown.hidden = true;
      wrap.classList.remove("open");
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!dropdown.hidden) closeDropdown();
      else openDropdown();
    });

    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target)) {
        closeDropdown();
      }
    });

    dropdown.addEventListener("click", function (e) {
      var option = e.target.closest(".custom-select-option");
      if (!option) return;
      var val = option.dataset.value;
      setCurrentSeason(val);
      current = val;
      closeDropdown();
      // 触发全局事件，通知 app.js 重新加载数据
      document.dispatchEvent(new CustomEvent("jfes:seasonChange", { detail: { season: val } }));
    });

    syncOptions();
  }

  // 暴露给 app.js 的赛季 API
  window.JFESSeason = {
    get: getCurrentSeason,
    set: setCurrentSeason,
    TYPES: SEASON_TYPES
  };

  // ===== 背景音乐 =====
  // 纯 HTMLAudio：简单、不碰全局事件、不影响任何页面控件点击
  // 音乐切换：自动 / 第一赛季(OP1) / 第二赛季(OP2) / 第二赛季开幕式(OP2OP)
  // 自动规则：第一赛季(C1)→OP1，第二赛季(C2)→OP2；2026-09-04~09-05 全天优先播 OP2OP
  // 音量 0-100（0=关闭），默认 50；选择持久化 localStorage（默认 auto）
  var BGM_VOL_KEY = "jfes_bgm_volume";
  var BGM_SEL_KEY = "jfes_bgm_select";
  var DEFAULT_BGM_VOL = 50;
  var BGM_NAMES = { auto: "自动", op1: "第一赛季", op2: "第二赛季", op2op: "第二赛季开幕式" };
  function loadBgmVol() {
    try {
      var v = parseInt(localStorage.getItem(BGM_VOL_KEY), 10);
      if (isNaN(v) || v < 0 || v > 100) return DEFAULT_BGM_VOL;
      return v;
    } catch (e) { return DEFAULT_BGM_VOL; }
  }
  function saveBgmVol(v) {
    try {
      v = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
      localStorage.setItem(BGM_VOL_KEY, String(v));
    } catch (e) {}
  }
  function loadBgmSel() {
    try {
      var v = localStorage.getItem(BGM_SEL_KEY);
      if (v === "op1" || v === "op2" || v === "op2op") return v;
    } catch (e) {}
    return "auto";
  }
  function saveBgmSel(v) {
    try { localStorage.setItem(BGM_SEL_KEY, v); } catch (e) {}
  }
  function bgmAudio() { return document.getElementById("bgmAudio"); }
  function currentSeasonCode() {
    try {
      if (window.JFESSeason && window.JFESSeason.get) return window.JFESSeason.get();
    } catch (e) {}
    return "C2";
  }
  // 自动模式解析：开幕式日期优先级高于赛季映射
  function resolveAutoBgm() {
    try {
      var now = new Date();
      // 2026年9月4日~9月5日（getMonth() 9月 = 8）
      if (now.getFullYear() === 2026 && now.getMonth() === 8 &&
          (now.getDate() === 4 || now.getDate() === 5)) return "op2op";
    } catch (e) {}
    return (currentSeasonCode() === "C1") ? "op1" : "op2";
  }
  // choice：op1 / op2 / op2op / auto（auto 内部解析为具体曲目）
  function bgmSrcFor(choice) {
    if (!choice || choice === "auto") choice = resolveAutoBgm();
    if (choice === "op1") return "flac/OP1.flac";
    if (choice === "op2op") return "flac/OP2OP.flac";
    return "flac/OP2.flac";
  }

  // 写入 volume + muted（统一单处入口）
  function applyVolume(vol0_100) {
    vol0_100 = Math.max(0, Math.min(100, parseInt(vol0_100, 10) || 0));
    var a = bgmAudio();
    if (!a) return;
    try { a.volume = vol0_100 / 100; } catch (e) {}
    try {
      if (vol0_100 === 0) a.muted = true;
      else a.muted = false;
    } catch (e) {}
  }

  // 设置当前选择（或自动解析）所需 src，并尝试播放（浏览器若不允许非静音自动播放则保持 muted，用户点一下页面任意位置即可播放）
  function applyBgmSrcAndPlay() {
    var a = bgmAudio();
    if (!a) return;
    var src = bgmSrcFor(loadBgmSel());
    if (a.getAttribute("data-src") !== src) {
      try { a.pause(); } catch (e) {}
      a.setAttribute("data-src", src);
      a.src = src;
    }
    var vol = loadBgmVol();
    applyVolume(vol);
    if (vol === 0) return;  // 音量 0 → 不用尝试播放
    // muted + play 永远被允许；若浏览器随后允许解静音则用户手动交互时会自动发声
    a.muted = true;
    var p = a.play();
    if (p && typeof p.then === "function") {
      p.then(function () {
        // 能起就起：按设置音量解静音（被策略拒绝时会抛，catch 中保持 muted）
        try {
          a.muted = (vol === 0);
          if (a.muted && vol > 0) { /* 浏览器强制静音 — 等用户第一下点击后再解 */ }
        } catch (e) {}
      }).catch(function () {});
    }
  }

  // 只接受一次"第一下点击/按键/触摸"作为合法用户手势，用来解除 muted：
  // 监听仅 1 次；用完即删，绝不残留影响页面交互
  function _bgmFirstGestureOnce() {
    var a = bgmAudio();
    if (!a) return;
    if (!a.paused && !a.muted) return;  // 已经正常出声了
    var vol = loadBgmVol();
    if (vol === 0) return;
    try {
      if (a.paused) {
        var p = a.play();
        if (p && typeof p.then === "function") {
          p.then(function () { a.muted = false; a.volume = vol / 100; }).catch(function () {});
        } else {
          a.muted = false; a.volume = vol / 100;
        }
      } else {
        a.muted = false; a.volume = vol / 100;
      }
    } catch (e) {}
    window.removeEventListener("pointerdown", _bgmFirstGestureOnce, { capture: true });
    document.removeEventListener("keydown", _bgmFirstGestureOnce, { capture: true });
    document.removeEventListener("touchstart", _bgmFirstGestureOnce, { capture: true });
  }

  function setBgmVol(v) {
    v = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
    saveBgmVol(v);
    applyVolume(v);
    var a = bgmAudio();
    if (v === 0) {
      if (a) try { a.pause(); } catch (e) {}
    } else if (a && a.paused) {
      // 用户把音量从 0 滑上去 → 主动尝试恢复播放
      var p = a.play();
      if (p && typeof p.then === "function") p.catch(function () {});
    }
    updateBgmVolUI(v);
  }
  function setBgm(v) {
    // 兼容旧 API（赛季切换 / 设置兜底等路径调用）
    if (v === "off") setBgmVol(0);
    else if (loadBgmVol() === 0) setBgmVol(DEFAULT_BGM_VOL);
    else applyBgmSrcAndPlay();
  }
  function loadBgm() { return loadBgmVol() > 0 ? "on" : "off"; }
  function applyBgm(v) {
    if (v === "off") setBgmVol(0);
    else applyBgmSrcAndPlay();
  }
  function updateBgmVolUI(v) {
    v = Math.max(0, Math.min(100, parseInt(v, 10) || 0));
    var s = $("#bgmVolumeSlider");
    if (s && s.value !== String(v)) s.value = String(v);
    var label = $("#bgmVolumeValue");
    if (label) label.textContent = v + "%";
    if (label) {
      if (v === 0) label.classList.add("muted"); else label.classList.remove("muted");
    }
  }
  function bindBgm() {
    var slider = $("#bgmVolumeSlider");
    if (!slider) return;
    var init = loadBgmVol();
    updateBgmVolUI(init);
    applyVolume(init);
    function onInput() {
      var v = parseInt(slider.value, 10) || 0;
      setBgmVol(v);
    }
    slider.addEventListener("input", onInput);
    slider.addEventListener("change", onInput);
  }

  // 音乐切换下拉（自动 / 第一赛季 / 第二赛季 / 第二赛季开幕式）
  function bindBgmSelect() {
    var wrap = $("#bgmSelectWrap");
    var trigger = $("#bgmSelectTrigger");
    var dropdown = $("#bgmSelectDropdown");
    if (!wrap || !trigger || !dropdown) return;

    function syncOptions(sel) {
      dropdown.querySelectorAll(".custom-select-option").forEach(function (opt) {
        opt.classList.toggle("active", opt.dataset.value === sel);
      });
      var label = $("#bgmSelectLabel");
      if (label) label.textContent = BGM_NAMES[sel] || "自动";
    }
    function openDropdown() {
      dropdown.hidden = false;
      wrap.classList.add("open");
    }
    function closeDropdown() {
      dropdown.hidden = true;
      wrap.classList.remove("open");
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!dropdown.hidden) closeDropdown();
      else openDropdown();
    });
    document.addEventListener("click", function (e) {
      if (!wrap.contains(e.target) && !dropdown.contains(e.target)) {
        closeDropdown();
      }
    });
    dropdown.addEventListener("click", function (e) {
      var option = e.target.closest(".custom-select-option");
      if (!option) return;
      var v = option.dataset.value;
      saveBgmSel(v);
      syncOptions(v);
      closeDropdown();
      // 立即按新选择切歌（选择不变 + src 相同则不会重播）
      applyBgmSrcAndPlay();
    });

    syncOptions(loadBgmSel());  // 初始化标签与高亮
  }

  // ===== 开屏页（splash / 登录屏保） =====
  // 展示规则：每次"完整加载文档"都展示 —— 也就是"打开网页"和"F5/Ctrl+R 刷新"都展示。
  //           视图切换 / 内部 SPA 跳转都是同文档内操作，不重复展示。
  // 触发：任意一次 click / keydown / pointerdown / touchstart 即"按下任意键/按钮"，
  //       给 #jfesSplash 加 .slide-out-up → 420ms 后从 DOM 移除，释放 z-index。
  var _splashDone = false;
  function splashDismiss() {
    if (_splashDone) return;
    _splashDone = true;
    var el = document.getElementById("jfesSplash");
    // — 关键 — 同时让首页内容恢复展示。在 splash 往上滑的 420ms 内，
    // 首页内容出现在滑开的"后面"，看起来像 reveal 揭幕，完全无闪烁。
    // 注意：用 setTimeout(0) 保证这一步发生在"指针点击目标已确定之后"，
    //       以免元素出现后 pointer 命中改到下面卡片按钮等错误控件。
    setTimeout(function () {
      try { document.body.classList.remove("jfes-splash-active"); } catch (e) {}
      // 强制导航栏液态玻璃刷新一次（尺寸一直是对的，但为了避免 DPR/viewport 偏差再画一次）
      try {
        if (window.LiquidGlass && typeof window.LiquidGlass.refresh === "function") {
          window.LiquidGlass.refresh();
        }
        // 手动派发 resize 事件，使所有 Canvas、导航胶囊、季节按钮胶囊、viewport 重测
        try { window.dispatchEvent(new Event("resize")); } catch (e) {}
      } catch (e) {}
    }, 0);
    if (!el) return;
    // 移除"按任意键"的闪烁，避免动画卡顿
    var pr = document.getElementById("jfesSplashPress");
    if (pr) pr.style.animationPlayState = "paused";
    // 上滑消失
    el.classList.add("slide-out-up");
    setTimeout(function () {
      try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
    }, 460);
    // 解除 BGM 初始化的静音强制（用户"按了一下"等于合法手势）
    try { if (typeof _bgmFirstGestureOnce === "function") _bgmFirstGestureOnce(); } catch (e) {}
    // 清理所有 splash 监听器
    document.removeEventListener("pointerdown", splashDismiss, true);
    document.removeEventListener("keydown",     splashDismiss, true);
    document.removeEventListener("touchstart",  splashDismiss, true);
    document.removeEventListener("click",       splashDismiss, true);
    window.removeEventListener("popstate",      splashDismiss, true);
  }
  function initSplash() {
    var el = document.getElementById("jfesSplash");
    if (!el) return;
    // 壁纸同步：读 body.backgroundImage（或 data-effective 的 CSS），赋给 splash 背景
    syncSplashWallpaper();
    // 灰暗度遮罩同步
    syncSplashDarkness();
    // 4 类"任意按下键/按钮"的监听 —— capture phase，且命中立即自删
    document.addEventListener("pointerdown", splashDismiss, { capture: true, passive: true });
    document.addEventListener("keydown",     splashDismiss, { capture: true, passive: true });
    document.addEventListener("touchstart",  splashDismiss, { capture: true, passive: true });
    document.addEventListener("click",       splashDismiss, { capture: true, passive: true });
    // 浏览器前进/后退也直接 dismiss
    window.addEventListener("popstate", splashDismiss, { passive: true });
  }
  function syncSplashWallpaper() {
    var bg = document.querySelector(".jfes-splash-bg");
    if (!bg) return;
    try {
      var bodyBg = window.getComputedStyle(document.body).backgroundImage;
      if (bodyBg && bodyBg !== "none") bg.style.backgroundImage = bodyBg;
    } catch (e) {}
  }
  function syncSplashDarkness() {
    var ov = document.getElementById("jfesSplashOverlay");
    if (!ov) return;
    var pct = 0;
    try { pct = parseInt(localStorage.getItem("jfes_bg_darkness"), 10) || 0; } catch (e) {}
    if (pct < 0) pct = 0; if (pct > 90) pct = 90;
    ov.style.background = "rgba(0, 0, 0, " + (pct / 100) + ")";
  }
  // applyTheme / applyWallpaper 触发时同步 splash（splash 仍展示中的话，切换壁纸立刻生效）
  var _origApplyTheme = applyTheme;
  applyTheme = function () {
    var r = _origApplyTheme.apply(null, arguments);
    syncSplashWallpaper();
    syncSplashDarkness();
    return r;
  };
  var _origApplyDarkness = applyDarkness;
  applyDarkness = function (p) {
    var r = _origApplyDarkness.call(null, p);
    var ov = document.getElementById("jfesSplashOverlay");
    if (ov) {
      var v = Math.max(0, Math.min(90, parseInt(p, 10) || 0));
      ov.style.background = "rgba(0, 0, 0, " + (v / 100) + ")";
    }
    return r;
  };

  // ===== 初始化 =====
  function init() {
    // 去掉登录页/开屏页：直接移除 splash 元素，不等待用户交互
    (function skipSplash() {
      try {
        var splash = document.getElementById("jfesSplash");
        if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
      } catch (e) {}
      _splashDone = true;
    })();

    injectIcons();
    applyTheme(loadTheme());

    // 赛季切换
    initSeasonSelect();

    // 视图切换
    bindViewSwitching();

    // 液态玻璃导航栏
    initLiquidGlass();

    // 背景音乐：按音乐切换选择换源（自动模式随赛季重解析）+ 首次启动 + 滑动条/下拉绑定
    document.addEventListener("jfes:seasonChange", function () {
      // 固定选择时 src 不变则不会重播；自动模式会切到新赛季曲目
      applyBgmSrcAndPlay();
    });
    applyBgmSrcAndPlay();
    bindBgm();
    bindBgmSelect();

    // 第一个合法用户手势（点击/按键/触摸）→ 解除浏览器的静音强制
    // 只用 3 类 capture 监听，命中即 removeEventListener 永不残留
    window.addEventListener("pointerdown", _bgmFirstGestureOnce, { capture: true, once: true });
    document.addEventListener("keydown", _bgmFirstGestureOnce, { capture: true, once: true });
    document.addEventListener("touchstart", _bgmFirstGestureOnce, { capture: true, once: true });
    // 切回标签页时再试一次
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) _bgmFirstGestureOnce();
    });

    switchView(getInitialView());

    // 设置页分类切换
    bindSettingsCategories();

    // 主题（深色模式下拉）
    bindTheme();

    // 模糊度
    var initBlur = loadBlur();
    applyBlur(initBlur);
    updateBlurUI(initBlur);
    bindBlur();

    // 灰暗度
    var initDarkness = loadDarkness();
    applyDarkness(initDarkness);
    updateDarknessUI(initDarkness);
    bindDarkness();

    // 网页命名
    var initTitle = loadPageTitle();
    applyPageTitle(initTitle);
    updatePageTitleUI(initTitle);
    bindPageTitle();

    // 导航胶囊居中
    centerNav();
    var _navCenterTimer = null;
    window.addEventListener("resize", function () {
      if (_navCenterTimer) clearTimeout(_navCenterTimer);
      _navCenterTimer = setTimeout(centerNav, 30);
    });
    // 字体/图片加载后再刷新一次，避免初始宽度测量偏差
    window.addEventListener("load", centerNav);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
