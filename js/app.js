/**
 * app.js - 主应用逻辑（名单 / 人员 / 抽取 / 历史）
 * 依赖 common.js 提供的全局：$ 、ICONS 、showToast 、injectIcons
 */
(function () {
  "use strict";

  // ===== 预加载 .data/ 目录下的数据文件（C1.js / C2.js / HP.js）=====
  // 作为第一赛季、第二赛季、热点的直接数据源，无需用户手动导入
  var PRELOADED_DATA = { C1: null, C2: null, HP: null };
  var PRELOAD_ERRORS = [];

  function preloadDataFile(type, path) {
    // cache: "no-store" —— 数据文件更新后版本信息必须立刻跟上，不能读浏览器缓存的旧文件
    return fetch(path, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (text) {
        var header = parseFileHeader(text);
        var version = header ? header.version : "未知";
        var backup = tryParseBackup(text);
        PRELOADED_DATA[type] = { text: text, version: version, backup: backup, header: header };
        return { type: type, version: version, ok: true };
      })
      .catch(function (err) {
        PRELOAD_ERRORS.push(type + ": " + (err && err.message ? err.message : err));
        return { type: type, ok: false };
      });
  }

  // 立即启动预加载（并行 fetch 三个文件）
  var PRELOAD_PROMISE = Promise.all([
    preloadDataFile("C1", ".data/C1.js"),
    preloadDataFile("C2", ".data/C2.js"),
    preloadDataFile("HP", ".data/HP.js")
  ]);

  // 判断某类型数据是否已预加载成功
  function hasPreloaded(type) {
    var d = PRELOADED_DATA[type];
    return !!(d && d.backup && d.backup.storage);
  }

  var STORAGE_KEY = "jfes_random_person_v1";

  // 人员链接抽取会话缓存：
  // activeList() 每次从 link.items 构建新对象会导致 cycle/list 模式下的「移除人员」在下次 draw
  // 调用时丢失（从全新未修改的 items 重新切片）。在此按 link.id 缓存可变对象，保证同一轮
  // 抽签过程中对 list.people/removedPool 的 splice/push 持续生效。
  // 当 link.id 变更、或名单总人数与 link.items 不一致（源数据已更新）、或新一轮开始时重置。
  var drawLinkSession = { id: null, obj: null };

  // 全局状态
  var state = {
    lists: [],
    activeListId: null,
    activeDrawLink: null,
    mode: "repeat",
    history: [],
    lastListResult: [],  // 最近一次列表抽取结果 [{person, rank, time}]
    linkLibrary: { people: [], projects: [], times: [], draws: [] },
    // 排行页：当前选中的项目链接 id（数据源仅 linkLibrary.projects，独立于抽签页状态）
    rankActiveProjectId: null,
    // 排行页：表格数据映射 { "项目名": [[col1,col2,...], [col1,col2,...], ...] }
    rankTableData: {},
    // 排行页：当前选中的项目（表格展示用，匹配 rankTableData 的 key）
    rankSelectedProject: null,
    // 排行页：总排行表格数据（总榜 TXT 导入，首行标题无视）[[col,...], ...]
    rankOverallData: [],
    // 排行页：是否正在查看总排行（true 时第2列表格显示 rankOverallData）
    rankOverallActive: false,
    homeBindings: { people: null, calendar: null, projects: null },
    // 项目-日程一一映射：每个项目单独选择对应的日期
    // { calId: 'xxx', projectScheduleMap: { '0': '01-15', '1': '02-20', ... } }
    homeProjectCalMap: null,
    // 日历选中日期（"YYYY-M-D"）：点击日历任一日期更新，黄色边框 + 项目刻度条以此为基准；未初始化时默认今天
    calendar: { selectedDate: null }
  };

  var MODE_HINTS = {
    repeat: "重复抽取相同的",
    single: "一次性抽完不同的",
    cycle:  "循环抽取不同的",
    list:   "连续抽完不同的"
  };
  var MODE_NAMES = { repeat: "重复", single: "单次", cycle: "循环", list: "列表" };

  var spinning = false;
  var winTimer = null;
  var drawSnapshot = null; // {id, order}：抽取开始时的原始人员顺序，用于抽取后按原顺序还原

  // ===== 工具（$、showToast、ICONS 来自 common.js 全局）=====
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ===== 持久化 =====
  function save() {
    try {
      // 抽签的历史记录和抽取进度（history / lastListResult / lists[*].removedPool）
      // 不持久化：关闭浏览器 / 刷新 / 切换赛季后不保留
      var persistedLists = state.lists.map(function (l) {
        return {
          id: l.id,
          name: l.name,
          people: l.people,
          linked: l.linked,
          isLink: l.isLink,
          type: l.type,
          dataKey: l.dataKey
        };
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        lists: persistedLists,
        activeListId: state.activeListId,
        activeDrawLink: state.activeDrawLink,
        mode: state.mode,
        linkLibrary: state.linkLibrary,
        rankActiveProjectId: state.rankActiveProjectId,
        rankTableData: state.rankTableData,
        rankSelectedProject: state.rankSelectedProject,
        rankOverallData: state.rankOverallData,
        rankOverallActive: state.rankOverallActive,
        homeBindings: state.homeBindings,
        homeProjectCalMap: state.homeProjectCalMap
      }));
    } catch (e) {
      console.error("保存失败", e);
      showToast("保存失败：存储空间可能已满");
    }
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.lists)) return false;
      state.lists = data.lists;
      state.activeListId = data.activeListId || null;
      state.activeDrawLink = data.activeDrawLink || null;
      state.mode = data.mode || (data.noRepeat ? "single" : "repeat");
      // 抽签的历史记录和列表 = 仅会话内有效：加载完立即清空（刷新/重开浏览器后不保留）
      state.history = [];
      state.lastListResult = [];
      // 排行页当前选中的项目链接 id（兼容旧数据，无则为 null）
      state.rankActiveProjectId = data.rankActiveProjectId || null;
      // 排行页表格数据（兼容旧数据）
      state.rankTableData = (data.rankTableData && typeof data.rankTableData === "object") ? data.rankTableData : {};
      state.rankSelectedProject = data.rankSelectedProject || null;
      // 排行页总排行（兼容旧数据）
      state.rankOverallData = Array.isArray(data.rankOverallData) ? data.rankOverallData : [];
      state.rankOverallActive = data.rankOverallActive === true;
      // 链接库与首页绑定（兼容旧数据）
      var lib = data.linkLibrary || {};
      state.linkLibrary = {
        people: Array.isArray(lib.people) ? lib.people : [],
        projects: Array.isArray(lib.projects) ? lib.projects : [],
        times: Array.isArray(lib.times) ? lib.times : [],
        draws: Array.isArray(lib.draws) ? lib.draws : []
      };
      // 数据迁移 v：之前 importLink 创建的 linkLibrary 对象未标记 linked:true，
      // 但所有 linkLibrary 里的条目本质都是外部导入的链接数据，所以统一补 linked=true，
      // 保证判断逻辑（是否禁用按钮、是否显示🔗）老数据也能正确命中
      ["people", "projects", "times", "draws"].forEach(function (k) {
        state.linkLibrary[k].forEach(function (it) {
          if (it.linked !== true) it.linked = true;
        });
      });
      var hb = data.homeBindings || {};
      state.homeBindings = {
        people: hb.people || null,
        calendar: hb.calendar || null,
        projects: hb.projects || null
      };
      state.homeProjectCalMap = data.homeProjectCalMap || null;
      // 每次打开/刷新：选中日期强制回到今天，即使之前的 localStorage 里有旧 calendar 值也不读（行为是"每次打开都默认今天"）
      var nowSel = new Date();
      state.calendar = {
        selectedDate: nowSel.getFullYear() + "-" + String(nowSel.getMonth() + 1).padStart(2, "0") + "-" + String(nowSel.getDate()).padStart(2, "0")
      };
      // 确保 lists 有 removedPool 字段（兼容老数据），同时如果有旧的已保存已抽取状态也清空（刷新后不保留抽取进度）
      state.lists.forEach(function (l) { l.removedPool = []; });
      // 清空链接会话缓存（确保本次会话全新开始）
      drawLinkSession.id = null;
      drawLinkSession.obj = null;
      // 数据迁移后统一 save 一次，把补好的 linked:true 持久化（下一次 load 就不用再补了，除非又有更老的数据）
      save();
      return true;
    } catch (e) {
      console.error("加载失败", e);
      return false;
    }
  }
  function activeList() {
    if (state.activeListId) {
      var list = state.lists.find(function (l) { return l.id === state.activeListId; });
      if (list) return list;
    }
    if (state.activeDrawLink) {
      var link = null;
      var linkKind = null;
      // 同时支持两类：抽签库链接 (draws) 与人员链接 (people)
      link = state.linkLibrary.draws && state.linkLibrary.draws.find(function (l) { return l.id === state.activeDrawLink; });
      if (link) linkKind = "draw";
      else {
        link = state.linkLibrary.people && state.linkLibrary.people.find(function (l) { return l.id === state.activeDrawLink; });
        if (link) linkKind = "people";
      }
      if (!link) return null;
      var items = link.items || [];
      var totalCount = items.length;
      if (drawLinkSession.id === link.id && drawLinkSession.obj) {
        var cacheTotal = drawLinkSession.obj.people.length +
          (drawLinkSession.obj.removedPool ? drawLinkSession.obj.removedPool.length : 0);
        if (cacheTotal === totalCount && drawLinkSession.obj.linked === (link.linked === true)) return drawLinkSession.obj;
      }
      // 如果是抽签库链接且有 listId，同时该 list 存在，优先用 state.lists 里的副本（它有独立的 removedPool 状态）
      if (linkKind === "draw" && link.listId) {
        var mirrored = state.lists.find(function (l) { return l.id === link.listId; });
        if (mirrored) return mirrored;
      }
      var fresh = {
        id: link.id,
        name: link.name,
        people: items.slice(),
        removedPool: [],
        linked: link.linked === true,
        isLink: true
      };
      drawLinkSession.id = link.id;
      drawLinkSession.obj = fresh;
      return fresh;
    }
    drawLinkSession.id = null;
    drawLinkSession.obj = null;
    return null;
  }

  function activeSourceType() {
    if (state.activeListId && state.lists.find(function (l) { return l.id === state.activeListId; })) return "list";
    if (state.activeDrawLink) {
      if (state.linkLibrary.draws && state.linkLibrary.draws.find(function (l) { return l.id === state.activeDrawLink; })) return "link";
      if (state.linkLibrary.people && state.linkLibrary.people.find(function (l) { return l.id === state.activeDrawLink; })) return "link";
    }
    return null;
  }

  // ===== 排行页：当前选中的项目链接（仅 linkLibrary.projects 范围）=====
  function rankActiveProject() {
    if (!state.rankActiveProjectId) return null;
    return state.linkLibrary.projects.find(function (l) { return l.id === state.rankActiveProjectId; }) || null;
  }

  // ===== Modal：输入框 =====
  function openPromptModal(title, defaultValue, placeholder) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML =
        '<div class="modal">' +
          '<h3>' + escapeHtml(title) + '</h3>' +
          '<input type="text" maxlength="50" />' +
          '<div class="modal-actions">' +
            '<button class="glass-btn" data-action="cancel">取消</button>' +
            '<button class="glass-btn active" data-action="confirm">确定</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      var input = overlay.querySelector("input");
      if (defaultValue) input.value = defaultValue;
      if (placeholder) input.placeholder = placeholder;
      setTimeout(function () { input.focus(); input.select(); }, 10);

      function close(result) {
        document.body.removeChild(overlay);
        resolve(result);
      }
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) { close(null); return; }
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        if (btn.dataset.action === "cancel") close(null);
        else if (btn.dataset.action === "confirm") close(input.value);
      });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); close(input.value); }
        else if (e.key === "Escape") { close(null); }
      });
    });
  }

  // ===== Modal：确认框 =====
  function openConfirmModal(title, message, confirmText, isDanger) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      var btnClass = isDanger ? "glass-btn danger" : "glass-btn active";
      overlay.innerHTML =
        '<div class="modal">' +
          '<h3>' + escapeHtml(title) + '</h3>' +
          (message ? '<p class="modal-message">' + escapeHtml(message) + '</p>' : '') +
          '<div class="modal-actions">' +
            '<button class="glass-btn" data-action="cancel">取消</button>' +
            '<button class="' + btnClass + '" data-action="confirm">' + escapeHtml(confirmText || "确定") + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      var confirmBtn = overlay.querySelector('[data-action="confirm"]');
      setTimeout(function () { confirmBtn.focus(); }, 10);

      function close(result) {
        document.body.removeChild(overlay);
        resolve(result);
      }
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) { close(false); return; }
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        if (btn.dataset.action === "cancel") close(false);
        else if (btn.dataset.action === "confirm") close(true);
      });
      function esc(e) {
        if (e.key === "Escape") {
          close(false);
          document.removeEventListener("keydown", esc);
        }
      }
      document.addEventListener("keydown", esc);
    });
  }

  // ===== Modal：批量输入 =====
  function openBatchModal(title) {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML =
        '<div class="modal">' +
          '<h3>' + escapeHtml(title || "批量添加") + '</h3>' +
          '<p class="modal-hint">每行一个名字，或用逗号 / 分号分隔</p>' +
          '<textarea placeholder="张三&#10;李四&#10;王五"></textarea>' +
          '<div class="modal-actions">' +
            '<button class="glass-btn" data-action="cancel">取消</button>' +
            '<button class="glass-btn active" data-action="confirm">添加</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      var textarea = overlay.querySelector("textarea");
      setTimeout(function () { textarea.focus(); }, 10);

      function close(result) {
        document.body.removeChild(overlay);
        resolve(result);
      }
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) { close(null); return; }
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        if (btn.dataset.action === "cancel") close(null);
        else if (btn.dataset.action === "confirm") close(textarea.value);
      });
    });
  }

  // ===== Modal：编辑名单（列出所有名单，行内重命名 / 删除） =====
  // 通用：为编辑弹窗 ul 附加拖拽排序（仅 .drag-handle 触发）
  function attachDragSort(ul, getLiKey, onReorder) {
    if (!ul) return;
    var dragLi = null;
    var dragEnabled = false;
    function clearMarks() {
      var lis = ul.querySelectorAll("li");
      for (var i = 0; i < lis.length; i++) lis[i].classList.remove("drop-above", "drop-below");
    }
    // 用 mousedown 记录是否从手柄按下：dragstart 的 e.target 在部分浏览器是 li 本身，
    // 若用 e.target.closest('.drag-handle') 会误判（handle 是 li 的子元素，查祖先查不到）而阻止拖拽
    ul.addEventListener("mousedown", function (e) {
      dragEnabled = !!(e.target.closest && e.target.closest(".drag-handle"));
    });
    ul.addEventListener("dragstart", function (e) {
      if (!dragEnabled) { e.preventDefault(); return; }
      dragLi = e.target.closest ? e.target.closest("li") : null;
      if (!dragLi || dragLi.parentNode !== ul) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", getLiKey(dragLi) || ""); } catch (_) {}
      dragLi.classList.add("dragging");
    });
    ul.addEventListener("dragover", function (e) {
      if (!dragLi) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      var overLi = e.target.closest ? e.target.closest("li") : null;
      if (!overLi || overLi === dragLi || overLi.parentNode !== ul) return;
      var rect = overLi.getBoundingClientRect();
      var above = (e.clientY - rect.top) < rect.height / 2;
      clearMarks();
      overLi.classList.add(above ? "drop-above" : "drop-below");
    });
    ul.addEventListener("drop", function (e) {
      if (!dragLi) return;
      e.preventDefault();
      var overLi = e.target.closest ? e.target.closest("li") : null;
      if (overLi && overLi !== dragLi && overLi.parentNode === ul) {
        var rect = overLi.getBoundingClientRect();
        var above = (e.clientY - rect.top) < rect.height / 2;
        ul.insertBefore(dragLi, above ? overLi : overLi.nextSibling);
        var keys = [];
        var lis = ul.querySelectorAll("li");
        for (var i = 0; i < lis.length; i++) keys.push(getLiKey(lis[i]));
        onReorder(keys);
      }
      clearMarks();
    });
    ul.addEventListener("dragend", function () {
      if (dragLi) dragLi.classList.remove("dragging");
      dragLi = null;
      clearMarks();
    });
  }

  // 名单按新 id 顺序重排
  function reorderLists(newIds) {
    var map = {};
    state.lists.forEach(function (l) { map[l.id] = l; });
    var newList = newIds.map(function (id) { return map[id]; }).filter(Boolean);
    if (newList.length === state.lists.length && newList.length) {
      state.lists = newList;
      save();
      renderAll();
    }
  }

  // 当前名单人员按新 index 顺序重排
  function reorderPeople(newIndices) {
    var list = activeList();
    if (!list) return;
    var arr = list.people;
    var newPeople = newIndices.map(function (i) { return arr[parseInt(i, 10)]; }).filter(function (p) { return p !== undefined && p !== null; });
    if (newPeople.length === arr.length) {
      list.people = newPeople;
      save();
      renderAll();
    }
  }

  function openEditListsModal() {
    // ===== 分 4 类：①抽签链接（state.lists 带🔗 linked=true）②抽签库链接（linkLibrary.draws）③人员链接（linkLibrary.people）④本地链接（state.lists 不带🔗 linked≠true）=====
    var linkedLists = state.lists.filter(function (l) { return l.linked === true; });
    var localLists = state.lists.filter(function (l) { return l.linked !== true; });
    var peopleLinks = state.linkLibrary.people || [];
    var drawLinks = state.linkLibrary.draws || [];
    // 抽签库链接去重：与 state.lists 已镜像（linked=true）重复的不重复显示
    var listIds = {};
    state.lists.forEach(function (l) { listIds[l.id] = true; });
    var uniqueDrawLinks = drawLinks.filter(function (l) { return !l.listId || !listIds[l.listId]; });
    var has1 = linkedLists.length > 0;
    var has2 = uniqueDrawLinks.length > 0;   // ② 抽签库链接（独立）
    var has3 = peopleLinks.length > 0;       // ③ 人员链接
    var has4 = localLists.length > 0;        // ④ 本地链接
    if (!has1 && !has2 && !has3 && !has4) { showToast("暂无名单可编辑"); return; }
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);

    function renderContent() {
      linkedLists = state.lists.filter(function (l) { return l.linked === true; });
      localLists = state.lists.filter(function (l) { return l.linked !== true; });
      peopleLinks = state.linkLibrary.people || [];
      drawLinks = state.linkLibrary.draws || [];
      listIds = {};
      state.lists.forEach(function (l) { listIds[l.id] = true; });
      uniqueDrawLinks = drawLinks.filter(function (l) { return !l.listId || !listIds[l.listId]; });
      has1 = linkedLists.length > 0;
      has2 = uniqueDrawLinks.length > 0;
      has3 = peopleLinks.length > 0;
      has4 = localLists.length > 0;

      var html = '<div class="modal">' + '<h3>编辑名单</h3>';

      // ===== 第 1 分类：抽签链接（state.lists 带🔗）—— 只读，只可排序 =====
      if (has1) {
        html += '<h4 class="sub-section-title">抽签链接（' + linkedLists.length + '）</h4>' +
          '<ul class="edit-list" data-list-kind="linked-list">';
        linkedLists.forEach(function (l) {
          var badge = '<span class="link-badge" title="链接名单">' + ICONS.link + '</span>';
          html +=
            '<li data-id="' + l.id + '" draggable="true" data-kind="linked-list">' +
              '<span class="name">' + badge + escapeHtml(l.name) +
              ' <span style="color:var(--muted);font-size:11px">(' + l.people.length + ')</span></span>' +
              '<span class="drag-handle" title="拖动排序">' + ICONS.menu + '</span>' +
            '</li>';
        });
        html += '</ul>';
      }

      // ===== 第 2 分类：抽签库链接（linkLibrary.draws，未镜像的独立条目）—— 只读，只可排序 =====
      if (has2) {
        html += '<h4 class="sub-section-title">抽签库链接（' + uniqueDrawLinks.length + '）</h4>' +
          '<ul class="edit-list" data-list-kind="draw-link">';
        uniqueDrawLinks.forEach(function (l) {
          var badge = '<span class="link-badge" title="抽签库链接">' + ICONS.link + '</span>';
          var count = (l.items || []).length;
          html +=
            '<li data-id="' + l.id + '" draggable="true" data-kind="draw-link">' +
              '<span class="name">' + badge + escapeHtml(l.name) +
              ' <span style="color:var(--muted);font-size:11px">(' + count + ')</span></span>' +
              '<span class="drag-handle" title="拖动排序">' + ICONS.menu + '</span>' +
            '</li>';
        });
        html += '</ul>';
      }

      // ===== 第 3 分类：人员链接 —— 只读，只可排序 =====
      if (has3) {
        html += '<h4 class="sub-section-title">人员链接（' + peopleLinks.length + '）</h4>' +
          '<ul class="edit-list" data-list-kind="people-link">';
        peopleLinks.forEach(function (l) {
          var badge = '<span class="link-badge" title="人员链接">' + ICONS.link + '</span>';
          html +=
            '<li data-id="' + l.id + '" draggable="true" data-kind="people-link">' +
              '<span class="name">' + badge + escapeHtml(l.name) +
              ' <span style="color:var(--muted);font-size:11px">(' + l.items.length + ')</span></span>' +
              '<span class="drag-handle" title="拖动排序">' + ICONS.menu + '</span>' +
            '</li>';
        });
        html += '</ul>';
      }

      // ===== 第 4 分类：本地链接（state.lists 不带🔗）—— 允许重命名/删除 =====
      if (has4) {
        html += '<h4 class="sub-section-title">本地链接（' + localLists.length + '）</h4>' +
          '<ul class="edit-list" data-list-kind="local-list">';
        localLists.forEach(function (l) {
          html +=
            '<li data-id="' + l.id + '" draggable="true" data-kind="local-list">' +
              '<span class="name">' + escapeHtml(l.name) +
              ' <span style="color:var(--muted);font-size:11px">(' + l.people.length + ')</span></span>' +
              '<span class="drag-handle" title="拖动排序">' + ICONS.menu + '</span>' +
              '<span class="actions">' +
                '<button data-action="rename" title="重命名名单">' + ICONS.pencil + '</button>' +
                '<button class="danger" data-action="delete" title="删除名单">' + ICONS.close + '</button>' +
              '</span>' +
            '</li>';
        });
        html += '</ul>';
      }

      html +=
        '<div class="modal-actions">' +
          '<button class="glass-btn active" data-action="close">关闭</button>' +
        '</div>' +
      '</div>';
      overlay.innerHTML = html;
      if (typeof injectIcons === "function") injectIcons();
      // 4 个列表各自的拖拽排序（不跨区）
      var uls = overlay.querySelectorAll(".edit-list");
      uls.forEach(function (ul) {
        attachDragSort(ul, function (li) { return li.dataset.id; }, function (ids) {
          var kind = ul.dataset.listKind;
          if (kind === "people-link") {
            var arr = state.linkLibrary.people;
            var map = {};
            arr.forEach(function (a) { map[a.id] = a; });
            state.linkLibrary.people = ids.map(function (i) { return map[i]; }).filter(Boolean);
            save();
            renderLists();
          } else if (kind === "draw-link") {
            var arr2 = state.linkLibrary.draws;
            var map2 = {};
            arr2.forEach(function (a) { map2[a.id] = a; });
            // 保持 draws 顺序，仅对当前页面显示的 uniqueDrawLinks 重新排序
            var reordered = ids.map(function (i) { return map2[i]; }).filter(Boolean);
            // 所有 draws：保留不在当前 uniqueDrawLinks 中的条目，按原来顺序放在后面
            var others = arr2.filter(function (a) { return reordered.indexOf(a) === -1; });
            state.linkLibrary.draws = reordered.concat(others);
            save();
            renderLists();
          } else {
            // 抽签链接 / 本地链接：state.lists 的子集，合并后回写
            var sortedChunk = ids.map(function (i) { return state.lists.find(function (l) { return l.id === i; }); }).filter(Boolean);
            var otherKind = kind === "linked-list" ? "local-list" : "linked-list";
            var otherLists = state.lists.filter(function (l) {
              var k = l.linked === true ? "linked-list" : "local-list";
              return k === otherKind;
            });
            state.lists = (kind === "linked-list" ? sortedChunk : otherLists).concat(kind === "local-list" ? sortedChunk : otherLists);
            save();
            renderLists();
          }
          renderContent();
        });
      });
    }
    renderContent();

    var closed = false;
    function close() { if (closed) return; closed = true; document.body.removeChild(overlay); }

    function openEditPeopleForLink(linkId) {
      var srcLink = state.linkLibrary.people.find(function (l) { return l.id === linkId; });
      if (!srcLink) return;
      // 用链接源数据构造一个编辑态容器（不走 activeList / 不走 draw 缓存，直接针对源）
      var editingPeople = srcLink.items.slice();
      if (!editingPeople.length) { showToast("链接内暂无人员"); return; }
      var innerOverlay = document.createElement("div");
      innerOverlay.className = "modal-overlay";
      document.body.appendChild(innerOverlay);
      function commitToSource(finalOrdered) {
        srcLink.items = finalOrdered.slice();
        // 如果当前正在使用该链接作为抽签源，同步清理 drawLinkSession 以促使下次 activeList 重建
        if (state.activeDrawLink === srcLink.id) {
          drawLinkSession.id = null;
          drawLinkSession.obj = null;
          drawSnapshot = null;
        }
        save();
        renderCurrentList();
        renderLists();
      }
      function innerRender() {
        var html = '<div class="modal">' +
          '<h3>编辑人员 · ' + escapeHtml(srcLink.name) + '</h3>' +
          '<ul class="edit-list">';
        editingPeople.forEach(function (p, i) {
          html +=
            '<li data-index="' + i + '" draggable="true">' +
              '<span class="name">' + escapeHtml(p) + '</span>' +
              '<span class="drag-handle" title="拖动排序">' + ICONS.menu + '</span>' +
              '<span class="actions">' +
                '<button data-action="rename" title="重命名">' + ICONS.pencil + '</button>' +
                '<button class="danger" data-action="delete" title="删除">' + ICONS.close + '</button>' +
              '</span>' +
            '</li>';
        });
        html += '</ul><div class="modal-actions">' +
          '<button class="glass-btn active" data-action="close">完成</button>' +
        '</div></div>';
        innerOverlay.innerHTML = html;
        if (typeof injectIcons === "function") injectIcons();
        attachDragSort(innerOverlay.querySelector(".edit-list"), function (li) { return li.dataset.index; }, function (indices) {
          editingPeople = indices.map(function (i) { return editingPeople[i]; });
          commitToSource(editingPeople);
          innerRender();
        });
      }
      innerRender();
      var innerDone = false;
      function innerClose() { if (innerDone) return; innerDone = true; document.body.removeChild(innerOverlay); }
      innerOverlay.addEventListener("click", async function (e) {
        if (e.target === innerOverlay) { innerClose(); return; }
        var btn = e.target.closest("[data-action]");
        if (!btn) return;
        var action = btn.dataset.action;
        var li = btn.closest("li");
        var idx = li ? parseInt(li.dataset.index, 10) : -1;
        if (action === "close") {
          commitToSource(editingPeople);
          innerClose();
        } else if (action === "rename" && idx >= 0) {
          var oldName = editingPeople[idx];
          var nameEl = li.querySelector(".name");
          var actionsEl = li.querySelector(".actions");
          if (nameEl) nameEl.style.display = "none";
          if (actionsEl) actionsEl.style.display = "none";
          var input = document.createElement("input");
          input.type = "text"; input.className = "edit-input"; input.value = oldName; input.maxLength = 60;
          li.insertBefore(input, nameEl); input.focus(); input.select();
          var done = false;
          function commit() {
            if (done) return; done = true;
            var newName = input.value.trim();
            if (newName && newName !== oldName) editingPeople[idx] = newName;
            commitToSource(editingPeople); innerRender();
          }
          function cancel() { if (done) return; done = true; innerRender(); }
          input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); cancel(); }
          });
          input.addEventListener("blur", commit);
        } else if (action === "delete" && idx >= 0) {
          var name = editingPeople[idx];
          if (name === undefined) return;
          var ok = await openConfirmModal("删除人员", "确定删除「" + name + "」？不可恢复。", "删除", true);
          if (!ok) return;
          editingPeople.splice(idx, 1);
          commitToSource(editingPeople);
          if (!editingPeople.length) { innerClose(); renderContent(); showToast("链接已清空"); }
          else innerRender();
        }
      });
    }

    overlay.addEventListener("click", async function (e) {
      if (e.target === overlay) { close(); return; }
      var btn = e.target.closest("[data-action]");
      if (!btn) return;
      var action = btn.dataset.action;
      var li = btn.closest("li");
      var id = li ? li.dataset.id : null;
      var kind = li ? li.dataset.kind : null;

      if (action === "close") { close(); return; }
      // —— 本地名单/抽签链接动作（state.lists 来源的两种 kind：linked-list = 分类①抽签链接 / local-list = 分类③本地链接）——
      if (kind === "linked-list" || kind === "local-list") {
        if (action === "edit-people" && id) {
          // 打开编辑人员弹窗（当前名单源）
          var list = state.lists.find(function (l) { return l.id === id; });
          if (!list) return;
          close();
          // 临时设置 activeListId，确保 openEditPeopleModal 找到该名单
          var origActive = state.activeListId;
          var origActiveLink = state.activeDrawLink;
          state.activeListId = id;
          state.activeDrawLink = null;
          drawLinkSession.id = null; drawLinkSession.obj = null;
          // 清理 removedPool，否则当前池只显示剩员
          list.removedPool = list.removedPool || [];
          openEditPeopleModal();
          // 恢复（openEditPeopleModal 是同步弹层，不会异步保存原 active 值）
          setTimeout(function () {
            state.activeListId = origActive;
            state.activeDrawLink = origActiveLink;
            renderCurrentList();
          }, 0);
          return;
        }
        // 分类③本地链接（local-list）才允许重命名；分类①抽签链接（linked-list）没有重命名按钮（DOM 不渲染），不会走到这
        if (action === "rename" && id && kind === "local-list") { enterListRenameMode(li, id, renderContent); return; }
        if (action === "delete" && id) {
          var list = state.lists.find(function (l) { return l.id === id; });
          if (!list) return;
          var ok = await openConfirmModal(
            "删除名单",
            "确定删除名单「" + list.name + "」？包含 " + list.people.length + " 人，不可恢复。",
            "删除",
            true
          );
          if (!ok) return;
          var idx = state.lists.findIndex(function (l) { return l.id === id; });
          state.lists.splice(idx, 1);
          if (state.activeListId === id) state.activeListId = state.lists[0] ? state.lists[0].id : null;
          save();
          renderAll();
          if (!state.lists.length && !state.linkLibrary.people.length) { close(); showToast("已删除所有名单"); }
          else renderContent();
          return;
        }
      }
      // —— 人员链接动作 ——
      if (kind === "people-link") {
        if (action === "edit-link-items" && id) { openEditPeopleForLink(id); return; }
        if (action === "rename-link" && id) {
          var link = state.linkLibrary.people.find(function (l) { return l.id === id; });
          if (!link) return;
          var nameEl = li.querySelector(".name");
          var actionsEl = li.querySelector(".actions");
          if (nameEl) nameEl.style.display = "none";
          if (actionsEl) actionsEl.style.display = "none";
          var input = document.createElement("input");
          input.type = "text"; input.className = "edit-input"; input.value = link.name; input.maxLength = 60;
          li.insertBefore(input, nameEl); input.focus(); input.select();
          var done = false;
          function commit() {
            if (done) return; done = true;
            var newName = input.value.trim();
            if (newName && newName !== link.name) link.name = newName;
            save();
            renderLists();
            renderAll();
            renderContent();
          }
          function cancel() { if (done) return; done = true; renderContent(); }
          input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); cancel(); }
          });
          input.addEventListener("blur", commit);
          return;
        }
        if (action === "delete-link" && id) {
          var del = state.linkLibrary.people.find(function (l) { return l.id === id; });
          if (!del) return;
          var ok = await openConfirmModal(
            "删除链接",
            "确定删除链接「" + del.name + "」？包含 " + del.items.length + " 人，不可恢复。",
            "删除",
            true
          );
          if (!ok) return;
          var di = state.linkLibrary.people.findIndex(function (l) { return l.id === id; });
          state.linkLibrary.people.splice(di, 1);
          // 同时从所有本地 list.linked=true 的列表里断掉
          state.lists.forEach(function (lst) {
            if (lst.linkId === id) { lst.linkId = null; lst.linked = false; }
          });
          if (state.activeDrawLink === id) state.activeDrawLink = null;
          drawLinkSession.id = null; drawLinkSession.obj = null;
          save();
          renderAll();
          if (!state.lists.length && !state.linkLibrary.people.length) { close(); showToast("已删除所有名单"); }
          else renderContent();
          return;
        }
      }
    });
  }

  function enterListRenameMode(li, id, refresh) {
    var list = state.lists.find(function (l) { return l.id === id; });
    if (!list) return;
    var nameEl = li.querySelector(".name");
    var actionsEl = li.querySelector(".actions");
    nameEl.style.display = "none";
    actionsEl.style.display = "none";
    var input = document.createElement("input");
    input.type = "text";
    input.className = "edit-input";
    input.value = list.name;
    input.maxLength = 50;
    li.insertBefore(input, nameEl);
    input.focus();
    input.select();

    var done = false;
    function commit() {
      if (done) return;
      done = true;
      var newName = input.value.trim();
      if (newName && newName !== list.name) {
        renameList(id, newName);
      }
      refresh();
    }
    function cancel() {
      if (done) return;
      done = true;
      refresh();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
  }

  // ===== 渲染 =====
  function renderLists() {
    var label = $("#listSelectLabel");
    var dropdown = $("#listSelectDropdown");
    var listCount = $("#listCount");
    var linkBadge = $("#listLinkBadge");
    if (!label || !dropdown) return;

    var peopleLinks = state.linkLibrary.people || [];
    var drawLinks = state.linkLibrary.draws || [];

    // 去重：linkLibrary.draws 中 listId 已镜像到 state.lists 的条目不在下拉重复显示
    var listIds = {};
    state.lists.forEach(function (l) { listIds[l.id] = true; });
    var uniqueDrawLinks = drawLinks.filter(function (l) { return !l.listId || !listIds[l.listId]; });

    var hasPeople = peopleLinks.length > 0;
    var hasDrawsExtra = uniqueDrawLinks.length > 0;
    var totalSources = state.lists.length + (hasDrawsExtra ? uniqueDrawLinks.length : 0) + (hasPeople ? peopleLinks.length : 0);

    // 名单卡片标题后括号内统计名单数
    if (listCount) listCount.textContent = totalSources ? "（" + totalSources + "）" : "";

    if (!totalSources) {
      label.textContent = "（暂无名单）";
      if (linkBadge) linkBadge.hidden = true;
      dropdown.innerHTML = "";
      if (state.activeListId || state.activeDrawLink) {
        state.activeListId = null;
        state.activeDrawLink = null;
        save();
      }
      return;
    }

    var active = activeList();
    var activeType = activeSourceType();

    // —— 如果有名单但当前没有有效选中项，自动选中第一个（优先级：抽签链接→抽签库链接→人员链接→本地）——
    if (!active) {
      var first = null, firstKind = null;
      first = state.lists.find(function (l) { return l.linked === true; });
      if (first) firstKind = "list";
      else if (uniqueDrawLinks.length) { first = uniqueDrawLinks[0]; firstKind = "draw-link"; }
      else if (peopleLinks.length) { first = peopleLinks[0]; firstKind = "people-link"; }
      else { first = state.lists[0]; firstKind = "list"; }
      if (first) {
        if (firstKind === "list") {
          state.activeListId = first.id;
          state.activeDrawLink = null;
        } else {
          state.activeDrawLink = first.id;
          state.activeListId = null;
        }
        active = first;
        activeType = firstKind === "list" ? "list" : "link";
        save();
      }
    }

    var activeId = activeType === "link" ? active.id : state.activeListId;

    // 选择框显示（名称 + 必要时的链接徽章）
    var drawLinkActive = !!(activeType === "link" && state.activeDrawLink &&
      drawLinks.find(function (l) { return l.id === state.activeDrawLink; }));
    var showLinkBadge = active && (activeType === "link" || (activeType === "list" && active.linked === true));
    if (linkBadge) {
      linkBadge.hidden = !showLinkBadge;
      if (showLinkBadge && ICONS.link && !linkBadge.innerHTML.trim()) linkBadge.innerHTML = ICONS.link;
    }
    label.textContent = active ? active.name : "（暂无名单）";

    var html = "";

    // ——— 渲染顺序：1. 抽签链接（state.lists 带🔗 linked=true）——
    state.lists.filter(function (l) { return l.linked === true; }).forEach(function (l) {
      var sel = (activeType === "list" && l.id === state.activeListId) ? " active" : "";
      var badge = '<span class="link-badge" data-icon="link" title="抽签链接名单">' + (ICONS.link || "") + '</span>';
      html += '<div class="custom-select-option' + sel + '" data-id="' + l.id + '" data-source="list">' +
        badge +
        '<span class="opt-name">' + escapeHtml(l.name) + '</span>' +
      '</div>';
    });

    // ——— 渲染顺序：2. 抽签库链接（linkLibrary.draws 中未镜像到 state.lists 的条目）——
    if (hasDrawsExtra) {
      uniqueDrawLinks.forEach(function (l) {
        var sel = (activeType === "link" && drawLinkActive && l.id === state.activeDrawLink) ? " active" : "";
        var badge = '<span class="link-badge" data-icon="link" title="抽签链接">' + (ICONS.link || "") + '</span>';
        html += '<div class="custom-select-option link-source' + sel + '" data-id="' + l.id + '" data-source="draw-link">' +
          badge +
          '<span class="opt-name">' + escapeHtml(l.name) + '</span>' +
        '</div>';
      });
    }

    // ——— 渲染顺序：3. 人员链接（作为抽签数据源，linkLibrary.people）——
    if (hasPeople) {
      peopleLinks.forEach(function (l) {
        var isActivePeople = activeType === "link" && !drawLinkActive && l.id === state.activeDrawLink;
        var sel = isActivePeople ? " active" : "";
        var badge = '<span class="link-badge" data-icon="link" title="人员链接">' + (ICONS.link || "") + '</span>';
        html += '<div class="custom-select-option link-source' + sel + '" data-id="' + l.id + '" data-source="people-link">' +
          badge +
          '<span class="opt-name">' + escapeHtml(l.name) + '</span>' +
        '</div>';
      });
    }

    // ——— 渲染顺序：4. 本地链接（state.lists 不带🔗 linked≠true）——
    state.lists.filter(function (l) { return l.linked !== true; }).forEach(function (l) {
      var sel = (activeType === "list" && l.id === state.activeListId) ? " active" : "";
      html += '<div class="custom-select-option local-source' + sel + '" data-id="' + l.id + '" data-source="list">' +
        '<span class="opt-name">' + escapeHtml(l.name) + '</span>' +
      '</div>';
    });

    dropdown.innerHTML = html;
    if (typeof injectIcons === "function") injectIcons();
  }

  function renderCurrentList() {
    var list = activeList();
    var peopleContainer = $("#peopleContainer");
    var drawBtn = $("#drawBtn");
    var peopleCount = $("#peopleCount");
    var editPeopleBtn = document.getElementById("editPeopleBtn");
    var addPersonBtn = document.getElementById("addPersonBtn");

    // ========= [强制先执行：右上角 2 个按钮禁用状态更新] =========
    //   必须在「if (!list) return / if (空名单) return」之前运行，否则：
    //   切到分类③本地空名单（0 人）时，因前面 return 跳过了 disabled 清理 → 按钮一直保持上一条链接名单的禁用状态
    //   直接按 id 操作两个确定的按钮，不依赖 DOM 选择器，避免漏命中
    (function updateHeaderBtns() {
      var aType = activeSourceType();
      var shouldDisable;
      if (!list) {
        // 没有任何名单：按钮全禁用（没东西可编辑/添加）
        shouldDisable = true;
      } else if (aType === "link") {
        // 分类② 人员链接 = 全锁定
        shouldDisable = true;
      } else if (aType === "list" && state.activeListId) {
        // 分类①抽签链接（linked=true）→ 锁定；分类③本地链接（linked!==true）→ 不锁定
        var rawList = state.lists.find(function (l) { return l.id === state.activeListId; });
        shouldDisable = !!(rawList && rawList.linked === true);
      } else {
        shouldDisable = false;
      }
      [editPeopleBtn, addPersonBtn].forEach(function (btn) {
        if (!btn) return;
        btn.removeAttribute("disabled");
        if (shouldDisable) btn.setAttribute("disabled", "");
      });
    })();

    if (!list) {
      if (peopleCount) peopleCount.textContent = "";
      if (peopleContainer) peopleContainer.innerHTML = '';
      if (drawBtn) drawBtn.disabled = true;
      renderResult(null);
      return;
    }

    // 人员卡片标题后括号内统计人员数
    if (peopleCount) peopleCount.textContent = "（" + list.people.length + "）";

    if (drawBtn) drawBtn.disabled = spinning || list.people.length === 0;

    if (!peopleContainer) return;

    if (!list.people.length) {
      peopleContainer.innerHTML = '';
      return;
    }

    var html = "";
    list.people.forEach(function (p, i) {
      html +=
        '<li class="person-item" data-index="' + i + '">' +
          '<span class="index">' + (i + 1) + '</span>' +
          '<span class="name">' + escapeHtml(p) + '</span>' +
        '</li>';
    });
    peopleContainer.innerHTML = html;
  }

  function renderHistory() {
    var container = $("#historyList");
    if (!container) return;
    if (!state.history.length) {
      container.innerHTML = '';
      return;
    }
    var html = "";
    for (var i = state.history.length - 1; i >= 0; i--) {
      var h = state.history[i];
      var cls = i === state.history.length - 1 ? "history-item latest" : "history-item";
      html +=
        '<div class="' + cls + '">' +
          '<div class="name">' + escapeHtml(h.person) + '</div>' +
          '<div class="list">' + escapeHtml(h.listName) + '</div>' +
        '</div>';
    }
    container.innerHTML = html;
  }

  // 渲染列表抽取结果（排名 1~n，样式与人员卡片列表一致）
  function renderListResult() {
    var container = $("#historyList");
    if (!container) return;
    if (!state.lastListResult || !state.lastListResult.length) {
      container.innerHTML = '';
      return;
    }
    var html = "";
    state.lastListResult.forEach(function (r) {
      html +=
        '<div class="list-rank-item">' +
          '<span class="rank">' + r.rank + '</span>' +
          '<span class="name">' + escapeHtml(r.person) + '</span>' +
        '</div>';
    });
    container.innerHTML = html;
  }

  // 根据当前模式渲染第 3 列（历史 / 列表），列表模式左侧按钮为分享图标，右侧按钮为清空列表结果
  function renderThirdColumn() {
    var titleEl = $("#thirdColTitle");
    var countEl = $("#thirdColCount");
    if (titleEl) {
      titleEl.textContent = state.mode === "list" ? "列表" : "历史";
      if (countEl) titleEl.appendChild(countEl);  // 把计数 span 加回标题（因为改 textContent 会把 span 删掉）
    }
    // ——— 计数：历史模式 = state.history.length；列表模式 = lastListResult.length ———
    if (countEl) {
      var n = state.mode === "list"
        ? (state.lastListResult ? state.lastListResult.length : 0)
        : (state.history ? state.history.length : 0);
      countEl.textContent = "（" + n + "）";
      countEl.hidden = false;
    }
    var clearBtn = $("#clearHistoryBtn");
    if (clearBtn) {
      if (state.mode === "list") {
        // 列表模式：右上角显示 share 按钮
        clearBtn.hidden = false;
        clearBtn.title = "分享列表结果";
        clearBtn.dataset.icon = "share";
        clearBtn.innerHTML = ICONS.share || "";
      } else {
        // 历史模式：右上角无按钮
        clearBtn.hidden = true;
      }
    }
    if (state.mode === "list") {
      renderListResult();
    } else {
      renderHistory();
    }
  }

  function renderMode() {
    var buttons = document.querySelectorAll("#modeSelector button");
    buttons.forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.mode === state.mode);
    });
    var hint = $("#modeHint");
    if (hint) hint.textContent = MODE_HINTS[state.mode] || "";
    // 更新刻度选择器填充条位置（顺序须与 HTML 按钮顺序一致：单次/重复/循环/列表）
    var modes = ["single", "repeat", "cycle", "list"];
    var modeIdx = modes.indexOf(state.mode);
    var fill = $("#modeScaleFill");
    if (fill) {
      fill.style.width = (modeIdx >= 0 ? (modeIdx / (modes.length - 1) * 100) : 0) + "%";
    }
    // 同步更新第 3 列标题与内容
    renderThirdColumn();
  }

  function renderResult(val, isFinal) {
    var el = $("#result");
    if (!el) return;
    el.classList.remove("spinning", "pop", "win");

    if (val === null || val === undefined) {
      el.textContent = "?";  // 英文问号
      el.classList.add("placeholder");
      return;
    }
    el.classList.remove("placeholder");
    el.textContent = val;
    if (isFinal) {
      void el.offsetWidth;
      el.classList.add("pop", "win");
    } else {
      el.classList.add("spinning");
    }
  }

  // 渲染数据链接面板：分 4 类（人员/项目/时间/抽签）展示链接库
  function renderLinkDisplay() {
    var container = $("#linkDisplay");
    if (!container) return;
    var lib = state.linkLibrary;
    var sections = [
      { key: "people", label: "人员", items: lib.people },
      { key: "projects", label: "项目", items: lib.projects },
      { key: "times", label: "时间", items: lib.times },
      { key: "draws", label: "抽签", items: lib.draws }
    ];
    var html = "";
    var any = false;
    sections.forEach(function (sec) {
      if (!sec.items.length) return;
      any = true;
      html += '<div class="link-section">' +
        '<div class="link-section-title">' + sec.label + "（" + sec.items.length + "）</div>";
      sec.items.forEach(function (item) {
        html += renderLinkBlock(sec.key, item);
      });
      html += "</div>";
    });
    if (!any) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = html;
    if (typeof injectIcons === "function") injectIcons();
  }

  // 渲染单个链接块（按分类展示内容）
  function renderLinkBlock(type, item) {
    var body = "";
    if (type === "people" || type === "draws") {
      body = item.items.map(function (s) { return escapeHtml(s); }).join("\n");
    } else if (type === "projects") {
      body = item.items.map(function (p) {
        var t = p.tags.length ? "（" + p.tags.map(escapeHtml).join("、") + "）" : "";
        return escapeHtml(p.name) + t;
      }).join("\n");
    } else if (type === "times") {
      body = item.schedules.map(function (s) {
        return "[" + escapeHtml(s.date) + "]" + escapeHtml(s.content) + "[" + escapeHtml(s.category) + "]";
      }).join("\n");
      if (item.categories.length) {
        body += "\n" + item.categories.map(function (c) {
          return "[" + escapeHtml(c.name) + "#" + escapeHtml(c.color) + "]" + escapeHtml(c.desc);
        }).join("  ");
      }
    }
    return '<div class="link-block">' +
      '<div class="link-block-head">' +
        '<span class="link-block-name">' +
          '<span class="link-badge" data-icon="link" title="链接数据">' + (ICONS.link || "") + '</span>' +
          escapeHtml(item.name) +
        '</span>' +
        '<button class="link-block-del" data-del="' + type + '" data-id="' + item.id + '" title="删除">' + (ICONS.close || "✕") + '</button>' +
      '</div>' +
      '<div class="link-block-txt">' + body + '</div>' +
    '</div>';
  }

  // ===== 首页 3 卡片渲染 =====
  function renderHomePeople() {
    var container = $("#homePeopleList");
    var countEl = $("#homePeopleCount");
    if (!container) return;
    var bid = state.homeBindings.people;
    var item = bid ? state.linkLibrary.people.find(function (l) { return l.id === bid; }) : null;
    if (countEl) {
      var n = item ? item.items.length : 0;
      countEl.textContent = "（" + n + "）";
      countEl.hidden = false;
    }
    if (!item) {
      container.innerHTML = '';
      return;
    }
    var html = "";
    item.items.forEach(function (p, i) {
      html += '<li class="person-item" data-index="' + i + '">' +
        '<span class="index">' + (i + 1) + '</span>' +
        '<span class="name">' + escapeHtml(p) + '</span>' +
      '</li>';
    });
    container.innerHTML = html;
  }

  function renderHomeProjects() {
    var container = $("#homeProjectsList");
    var countEl = $("#homeProjectsCount");
    if (!container) return;
    var bid = state.homeBindings.projects;
    var item = bid ? state.linkLibrary.projects.find(function (l) { return l.id === bid; }) : null;
    if (countEl) {
      var n = item ? item.items.length : 0;
      countEl.textContent = "（" + n + "）";
      countEl.hidden = false;
    }
    if (!item) {
      container.innerHTML = '';
      return;
    }

    // 计算日历联动的刻度位置（按一一映射）
    var calResult = null;
    var calMap = state.homeProjectCalMap;
    if (calMap && calMap.calId) {
      var calItem = state.linkLibrary.times.find(function (t) { return t.id === calMap.calId; });
      if (calItem) {
        calResult = calcProjectCalPositions(calItem, item.items.length, calMap.projectScheduleMap);
      }
    }

    var html = "";
    item.items.forEach(function (p, i) {
      var tagsHtml = p.tags.length ? '<div class="pg-tags">' + p.tags.map(function(t) { return '<span class="pg-tag">' + escapeHtml(t) + '</span>'; }).join("") + '</div>' : '';
      var cls = 'project-gauge-item';
      if (calResult) {
        cls += ' linked state-' + (calResult.dateStates[i] || 'future');
      }
      html += '<li class="' + cls + '" data-index="' + i + '">' +
        '<div class="pg-dot"></div>' +
        '<div class="pg-body">' +
          '<div class="pg-name">' + escapeHtml(p.name) + '</div>' +
          tagsHtml +
        '</div>' +
      '</li>';
    });
    container.innerHTML = html;

    // 更新日历按钮状态
    var calBtn = document.getElementById("homeProjectsCalBtn");
    if (calBtn) {
      if (calResult) calBtn.classList.add("active");
      else calBtn.classList.remove("active");
    }

    // 整根刻度的分段绘制（不再用一个高度固定的 ::after 白填充）
    // 段划分（以实际 li 圆点中心为基准，按日期 past/today/future 三色分段画）：
    //   - 起点（container 顶部内 16px）到第 0 个圆点中心：若第 0 项 past/today → 白（已过去）
    //   - 相邻两圆点 i 和 i+1 之间：两端都 past → 白；任一端 today OR today 落在两者之间 → 黄（进行中）；两端都 future → 不画
    //   - 最后一个圆点之后：未来，不画（保留 CSS ::before 半透明背景灰条当参考系就行）
    if (calResult) {
      requestAnimationFrame(function () {
        var rows = container.children;
        var states = calResult.dateStates;
        var N = rows.length;
        var oldOverlay = document.getElementById("pgLinesOverlay");
        if (oldOverlay) oldOverlay.remove();
        if (N === 0) return;
        var overlay = document.createElement("div");
        overlay.id = "pgLinesOverlay";
        overlay.style.position = "absolute";
        overlay.style.left = "0";
        overlay.style.top = "0";
        overlay.style.width = "100%";
        overlay.style.height = "100%";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "1";
        container.appendChild(overlay);

        var isMobile = window.matchMedia("(max-width: 900px)").matches;

        function segColor(stA, stB) {
          if (stA === "past" && stB === "past") return "rgba(255, 255, 255, 0.85)";
          if (stA === "past" && stB === "today") return "rgba(255, 255, 255, 0.85)";
          if (stA === "today" && stB === "today") return "#ffd54f";
          if (stA === "past" && stB === "future") return "#ffd54f";
          return null;
        }

        if (isMobile) {
          // === 横排模式：圆点按 offsetLeft 排列，轨道在上方 y≈8px ===
          var dotXs = [];
          for (var d = 0; d < N; d++) {
            var rr = rows[d];
            dotXs.push(rr.offsetLeft + rr.offsetWidth / 2);
          }
          var startX = 16;       // 左轨道起
          var lineY = 8;         // 轨道 top，与 CSS ::before top:8px 对齐
          var lineH = 3;
          // 段 0
          if (states[0] === "past" || states[0] === "today") {
            var seg0 = { left: startX, right: dotXs[0], color: "rgba(255, 255, 255, 0.85)" };
            var l0 = document.createElement("div");
            l0.style.cssText = "position:absolute;top:" + lineY + "px;left:" + seg0.left + "px;width:" + Math.max(1, seg0.right - seg0.left) + "px;height:" + lineH + "px;background:" + seg0.color + ";border-radius:2px;";
            overlay.appendChild(l0);
          }
          // 段 i→i+1
          for (var s = 0; s < N - 1; s++) {
            var col = segColor(states[s], states[s + 1]);
            if (!col) continue;
            var line = document.createElement("div");
            var segLeft = dotXs[s], segRight = dotXs[s + 1];
            line.style.cssText = "position:absolute;top:" + lineY + "px;left:" + segLeft + "px;width:" + Math.max(1, segRight - segLeft) + "px;height:" + lineH + "px;background:" + col + ";border-radius:2px;transition:background 0.25s ease;";
            overlay.appendChild(line);
          }
        } else {
          // === 竖排模式：圆点按 offsetTop 排列 ===
          var dotYs = [];
          for (var d2 = 0; d2 < N; d2++) {
            var rr2 = rows[d2];
            dotYs.push(rr2.offsetTop + rr2.offsetHeight / 2);
          }
          var startTop = 16;
          var lineLeft = 7;
          var lineWidth = 3;
          var seg0v = null;
          if (states[0] === "past" || states[0] === "today") {
            seg0v = { top: startTop, bottom: dotYs[0], color: "rgba(255, 255, 255, 0.85)" };
          }
          var segs = [];
          if (seg0v) segs.push(seg0v);
          for (var s2 = 0; s2 < N - 1; s2++) {
            var col2 = segColor(states[s2], states[s2 + 1]);
            if (!col2) continue;
            segs.push({ top: dotYs[s2], bottom: dotYs[s2 + 1], color: col2 });
          }
          segs.forEach(function (sg) {
            var line = document.createElement("div");
            var heightPx = Math.max(1, sg.bottom - sg.top);
            line.style.position = "absolute";
            line.style.left = lineLeft + "px";
            line.style.top = sg.top + "px";
            line.style.width = lineWidth + "px";
            line.style.height = heightPx + "px";
            line.style.background = sg.color;
            line.style.borderRadius = "2px";
            line.style.transition = "height 0.35s cubic-bezier(0.2, 1.1, 0.4, 1), top 0.35s cubic-bezier(0.2, 1.1, 0.4, 1), background 0.25s ease";
            overlay.appendChild(line);
          });
        }
      });
    } else {
      var oldOverlay = document.getElementById("pgLinesOverlay");
      if (oldOverlay) oldOverlay.remove();
    }
  }

  // 计算项目对应日历的刻度位置（语义增强版）
  // 返回 { positions:[pct], todayPct, dateStates:['past'|'today'|'future'], minDate, maxDate, rangeMs }
  //   positions[i] = 第 i 项日期在 [minDate, maxDate] 中的百分比（0-100），用于将来扩展
  //   todayPct = 今天在 [minDate, maxDate] 中的百分比（0-100），用于整根白填充条的高度
  //   dateStates[i] = 第 i 项日期相对今天的状态
  function calcProjectCalPositions(calItem, projectCount, projectScheduleMap) {
    var hintYear = new Date().getFullYear();
    var dates = [];
    var dateMap = {};  // 原始日期字符串 → Date 对象
    var rawEntries = calItem.rawEntries || [];
    if (rawEntries.length) {
      rawEntries.forEach(function (entry) {
        if (entry.type !== "schedule") return;
        if (entry.isContinuation) return;
        var res = resolveDate(entry.date, hintYear);
        if (!res) return;
        var dt = new Date(res.year, res.month - 1, res.day);
        dates.push(dt);
        dateMap[entry.date] = dt;
      });
    } else {
      (calItem.schedules || []).forEach(function (s) {
        var res = resolveDate(s.date, hintYear);
        if (!res) return;
        var dt = new Date(res.year, res.month - 1, res.day);
        dates.push(dt);
        dateMap[s.date] = dt;
      });
    }
    if (!dates.length || projectCount === 0) return null;

    dates.sort(function (a, b) { return a - b; });
    var minDate = dates[0];
    var maxDate = dates[dates.length - 1];
    var rangeMs = maxDate.getTime() - minDate.getTime();

    // 参考日期（"今天"语义）= 选中日期 selKey，未设置时回退真实今天
    var refDate;
    try {
      if (state && state.calendar && state.calendar.selectedDate) {
        var ps = state.calendar.selectedDate.split("-").map(Number);
        refDate = new Date(ps[0], ps[1] - 1, ps[2]);
      }
    } catch (_e) { refDate = null; }
    if (!refDate) {
      var now = new Date();
      refDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    function dateToPct(dt) {
      if (rangeMs === 0) return 50;
      var pct = ((dt.getTime() - minDate.getTime()) / rangeMs) * 100;
      return Math.max(0, Math.min(100, pct));
    }
    function classifyDate(dt) {
      if (!dt) return null;
      var d0 = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
      if (d0.getTime() === refDate.getTime()) return "today";
      if (d0.getTime() < refDate.getTime()) return "past";
      return "future";
    }

    var todayPct = dateToPct(refDate);

    var positions = [];
    var dateStates = [];
    for (var i = 0; i < projectCount; i++) {
      var dt = null;
      if (projectScheduleMap && projectScheduleMap[String(i)]) {
        var rawDate = projectScheduleMap[String(i)];
        if (dateMap[rawDate]) {
          dt = dateMap[rawDate];
        } else {
          var res = resolveDate(rawDate, hintYear);
          if (res) dt = new Date(res.year, res.month - 1, res.day);
        }
      }
      if (!dt) {
        if (projectCount <= dates.length) {
          var idx = Math.round((i / Math.max(1, projectCount - 1)) * (dates.length - 1));
          dt = dates[idx];
        } else {
          var ratio = i / projectCount;
          var scaledIdx = Math.round(ratio * (dates.length - 1));
          dt = dates[Math.min(scaledIdx, dates.length - 1)];
        }
      }
      positions.push(dateToPct(dt));
      dateStates.push(classifyDate(dt));
    }

    return {
      positions: positions,
      todayPct: todayPct,
      dateStates: dateStates,
      minDate: minDate,
      maxDate: maxDate,
      rangeMs: rangeMs
    };
  }

  // 将文件中的日期字符串解析为 {year, month, day, hasMonth}，支持多种格式
  // "17" → day=17, hasMonth=false
  // "8-17", "08-17", "8月17日" → month=8, day=17, hasMonth=true
  // "2026-08-17" → full date, hasMonth=true
  function resolveDate(dateStr, hintYear) {
    var s = String(dateStr || "").trim();
    var d = null, m = null, y = hintYear || new Date().getFullYear();
    var hasMonth = false;
    // YYYY-MM-DD
    var full = s.match(/^(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})[日号]?$/);
    if (full) { y = parseInt(full[1]); m = parseInt(full[2]); d = parseInt(full[3]); hasMonth = true; }
    else {
      // MM-DD or M-D or MM/DD or M/D
      var md = s.match(/^(\d{1,2})[-\/月](\d{1,2})[日号]?$/);
      if (md) { m = parseInt(md[1]); d = parseInt(md[2]); hasMonth = true; }
      else {
        // just day number
        var dd = s.match(/^(\d{1,2})$/);
        if (dd) { d = parseInt(dd[1]); }
      }
    }
    if (d === null) return null;
    if (m === null) m = new Date().getMonth() + 1;
    return { year: y, month: m, day: d, hasMonth: hasMonth };
  }

  // 将 Date 对象格式化为 "YYYY-MM-DD"
  function fmtDate(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // 将 hex 颜色转为带透明度的版本，如 "#FF0000" → "rgba(255,0,0,0.12)"
  function hexWithAlpha(hex, alpha) {
    hex = String(hex || "#4caf50").trim();
    // 自动补 # 前缀
    if (hex.charAt(0) !== "#") hex = "#" + hex;
    // 扩展 #RGB → #RRGGBB
    if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
      hex = "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    }
    var m = hex.match(/^#([0-9a-fA-F]{6})$/);
    if (!m) return "rgba(76,175,80," + alpha + ")";
    var r = parseInt(m[1].slice(0, 2), 16);
    var g = parseInt(m[1].slice(2, 4), 16);
    var b = parseInt(m[1].slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  // 中文月份名：1月→一月，11月→十一，12月→十二
  function monthNameCN(m) {
    if (!m) return "";
    var cn = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
    return cn[m - 1] + "月";
  }

  function renderHomeCalendar() {
    var container = $("#homeCalendar");
    if (!container) return;
    var bid = state.homeBindings.calendar;
    var item = bid ? state.linkLibrary.times.find(function (l) { return l.id === bid; }) : null;
    if (!item || !item.schedules.length) {
      container.innerHTML = '';
      return;
    }
    // 构建分类颜色映射：同时支持 code 和 desc 查找
    var catColor = {};
    item.categories.forEach(function (c) {
      catColor[c.name] = c.color || "#4caf50";
      if (c.desc) catColor[c.desc] = c.color || "#4caf50";
    });

    var hintYear = new Date().getFullYear();

    var dateMap = {};
    var resolvedDates = [];

    // 优先使用 rawEntries（包含空日程和续接日程），回退到 schedules
    var rawEntries = item.rawEntries || [];
    if (rawEntries.length) {
      rawEntries.forEach(function (entry) {
        var res = resolveDate(entry.date, hintYear);
        if (!res) return;
        var dt = new Date(res.year, res.month - 1, res.day);
        var key = fmtDate(dt);

        if (entry.type === "schedule") {
          if (!dateMap[key]) dateMap[key] = [];
          var color = catColor[entry.categoryCode] || catColor[entry.category] || "#4caf50";
          dateMap[key].push({
            content: entry.content,
            category: entry.category,
            categoryCode: entry.categoryCode,
            color: color,
            isContinuation: !!entry.isContinuation
          });
          resolvedDates.push(dt);
        } else if (entry.type === "empty") {
          resolvedDates.push(dt);
        }
      });
    } else {
      // 回退：从旧格式的 schedules 构建
      item.schedules.forEach(function (s) {
        var res = resolveDate(s.date, hintYear);
        if (!res) return;
        var dt = new Date(res.year, res.month - 1, res.day);
        var key = fmtDate(dt);
        if (!dateMap[key]) dateMap[key] = [];
        var color = catColor[s.category] || "#4caf50";
        dateMap[key].push({
          content: s.content,
          category: s.category,
          categoryCode: s.categoryCode || s.category,
          color: color,
          isContinuation: !!s.isContinuation
        });
        resolvedDates.push(dt);
      });
    }

    if (!resolvedDates.length) {
      container.innerHTML = '';
      return;
    }

    // 推断月份
    var allNoMonth = rawEntries.every(function (e) {
      var r = resolveDate(e.date, hintYear);
      return r && !r.hasMonth;
    });
    if (allNoMonth) {
      var currentMonth = new Date().getMonth() + 1;
      // 收集所有日期并排序
      var allDates = rawEntries.map(function (e) {
        var r = resolveDate(e.date, hintYear);
        return { entry: e, day: r ? r.day : 0 };
      }).sort(function (a, b) { return a.day - b.day; });
      var prevDay = 0;
      allDates.forEach(function (x) {
        if (x.day <= prevDay && prevDay > 0) currentMonth++;
        x.entry._inferredMonth = currentMonth;
        prevDay = x.day;
      });
    }

    // 确定日期范围
    var minDate = resolvedDates[0], maxDate = resolvedDates[0];
    resolvedDates.forEach(function (dt) {
      if (dt < minDate) minDate = dt;
      if (dt > maxDate) maxDate = dt;
    });
    var startOffset = minDate.getDay();
    var daysSinceMonday = (startOffset === 0 ? 6 : startOffset - 1);
    var startDate = new Date(minDate);
    startDate.setDate(startDate.getDate() - daysSinceMonday);
    var endOffset = maxDate.getDay();
    var daysUntilSunday = (endOffset === 0 ? 0 : 7 - endOffset);
    var endDate = new Date(maxDate);
    endDate.setDate(endDate.getDate() + daysUntilSunday);

    // 如果推断了月份，用推断值覆盖 dateMap 中条目的年月
    if (allNoMonth) {
      allDates.forEach(function (x) {
        if (!x.entry._inferredMonth) return;
        var r = resolveDate(x.entry.date, hintYear);
        if (!r) return;
        r.month = x.entry._inferredMonth;
        var dt = new Date(r.year, r.month - 1, r.day);
        var newKey = fmtDate(dt);
        var oldKey = fmtDate(new Date(hintYear, new Date().getMonth(), r.day));
        if (newKey !== oldKey && dateMap[oldKey]) {
          dateMap[newKey] = dateMap[oldKey];
          delete dateMap[oldKey];
        }
        // 更新 resolvedDates
        for (var k = 0; k < resolvedDates.length; k++) {
          if (resolvedDates[k].getDate() === r.day && resolvedDates[k].getMonth() + 1 !== r.month) {
            resolvedDates[k] = dt;
          }
        }
      });
      // 重新确定范围
      minDate = resolvedDates[0]; maxDate = resolvedDates[0];
      resolvedDates.forEach(function (dt) {
        if (dt < minDate) minDate = dt;
        if (dt > maxDate) maxDate = dt;
      });
      startOffset = minDate.getDay();
      daysSinceMonday = (startOffset === 0 ? 6 : startOffset - 1);
      startDate = new Date(minDate);
      startDate.setDate(startDate.getDate() - daysSinceMonday);
      endOffset = maxDate.getDay();
      daysUntilSunday = (endOffset === 0 ? 0 : 7 - endOffset);
      endDate = new Date(maxDate);
      endDate.setDate(endDate.getDate() + daysUntilSunday);
    }

    // 生成周数据
    var weeks = [];
    var cur = new Date(startDate);
    while (cur <= endDate) {
      var weekDays = [];
      for (var i = 0; i < 7; i++) {
        var key = fmtDate(cur);
        var schedules = dateMap[key] || [];
        weekDays.push({ date: new Date(cur), schedules: schedules });
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push(weekDays);
    }

    // 确定每周的月份（天数多的月份）
    function getWeekMonthNum(weekDays) {
      var monthCounts = {};
      weekDays.forEach(function (d) {
        var m = d.date.getMonth() + 1;
        monthCounts[m] = (monthCounts[m] || 0) + 1;
      });
      var maxMonth = 0, maxCount = -1;
      Object.keys(monthCounts).forEach(function (m) {
        var count = monthCounts[m];
        if (count > maxCount || (count === maxCount && parseInt(m) < maxMonth)) {
          maxCount = count;
          maxMonth = parseInt(m);
        }
      });
      return maxMonth;
    }

    var weekMonths = weeks.map(function (weekDays) {
      return getWeekMonthNum(weekDays);
    });

    // 计算月份合并组
    var monthGroups = [];
    var gi = 0;
    while (gi < weekMonths.length) {
      var start = gi;
      var m = weekMonths[gi];
      while (gi < weekMonths.length && weekMonths[gi] === m) gi++;
      monthGroups.push({ startWeek: start, endWeek: gi - 1, month: m, rowSpan: (gi - start) * 2 });
    }

    // ============ 构建扁平单元格 ============
    var flatCells = [];
    weeks.forEach(function (week) {
      week.forEach(function (d) {
        flatCells.push({
          date: d.date,
          schedules: d.schedules.slice(),
          isEmpty: d.schedules.length === 0,
          isCont: d.schedules.length > 0 && d.schedules.every(function (s) { return s.isContinuation; }),
          mergedColspan: 1,
          skipped: false
        });
      });
    });

    // ============ 计算续接链：反向查找最近的非续接源单元格 ============
    // 对每周内的每个续接单元格，向前回溯找到最近的非续接、非空日程单元格作为源
    // 空日程会中断链，空日程与续接日程不参与合并
    for (var wi = 0; wi < weeks.length; wi++) {
      var weekStart = wi * 7;
      for (var di = 0; di < 7; di++) {
        var idx = weekStart + di;
        var cell = flatCells[idx];
        if (cell.isEmpty) continue;
        if (!cell.isCont) continue;

        // 向前回溯找最近的非续接、非空日程单元格
        for (var j = idx - 1; j >= weekStart; j--) {
          var prev = flatCells[j];
          if (prev.isEmpty) break;
          if (!prev.isCont) {
            cell.skipped = true;
            prev.mergedColspan++;
            break;
          }
        }
      }
    }

    // ============ 续接链索引：每周内为每个 flatCell 标注 chainStartIdx（源 flatCells 索引）+ chainLen（合并列数）
    // 用于点击某一天时，黄框扩展覆盖整个续接日程跨列矩形（与点击合并后的源日程单元格视觉一致）
    for (var wiC = 0; wiC < weeks.length; wiC++) {
      var wsC = wiC * 7;
      for (var diC = 0; diC < 7; diC++) {
        var idxC = wsC + diC;
        var cc = flatCells[idxC];
        if (cc.isEmpty) {
          // 空日程：无续接链，链长 = 1
          cc.chainStartIdx = idxC;
          cc.chainLen = 1;
          continue;
        }
        if (cc.skipped) continue;  // 链内跳过节点：在源节点处统一标记
        // 源或独立单元格：chainLen = mergedColspan，覆盖从自己开始的前 N 列（同周内）
        var len = Math.max(1, cc.mergedColspan || 1);
        var actualLen = Math.min(len, wsC + 7 - idxC);  // 不跨出本周
        for (var kC = 0; kC < actualLen; kC++) {
          flatCells[idxC + kC].chainStartIdx = idxC;
          flatCells[idxC + kC].chainLen = actualLen;
        }
      }
    }

    // ============ 渲染表格 ============
    // ——— 先把 flatCells 存到 state（事件委托的 click handler 需要取它算 chainStart 对应日期，
    //     否则原来的闭包变量 render 后就失效了）———
    state.homeCalendarFlatCells = flatCells;
    var todayKey = fmtDate(new Date());
    // ——— 如果 selectedDate 等于"旧的今日"但 todayKey 已经变了（跨了 0 点），自动同步到最新今日，
    //     否则黄框会留在昨天的日期，或者跨日后今天的单元格没有黄框 class 导致定位不到 seed ———
    if (!state.calendar) state.calendar = {};
    if (state.__calLastToday && state.__calLastToday !== todayKey && state.calendar.selectedDate === state.__calLastToday) {
      state.calendar.selectedDate = todayKey;
    }
    state.__calLastToday = todayKey;
    // 选中日期键：未初始化时默认今天；与真实 todayKey 独立（黄框 + 刻度条以此为基准，真实今天仅用于日历锚点）
    if (!state.calendar || !state.calendar.selectedDate) {
      if (!state.calendar) state.calendar = {};
      state.calendar.selectedDate = todayKey;
    }
    var selKey = state.calendar.selectedDate;
    // 计算「当前选中链」的源 flatCells 索引（用于给续接链中间的所有日期 cell 的底边也画黄线，
    // 否则中间黄线只会出现在源日期列，其他续接日期列的日期底边仍是白色，视觉有白断点）
    var selChainStart = -1;
    for (var __fi = 0; __fi < flatCells.length; __fi++) {
      if (fmtDate(flatCells[__fi].date) === selKey) {
        selChainStart = flatCells[__fi].chainStartIdx;
        break;
      }
    }
    // 「今天」按钮（刷新图标）：选中日期 === 今天时隐藏（已在今天，无需跳转）；选中其他日期时显示（点击立即回到今天）
    var todayBtn = document.getElementById("homeCalendarTodayBtn");
    if (todayBtn) {
      if (selKey === todayKey) {
        todayBtn.style.display = "none";
      } else {
        todayBtn.style.display = "";  // inline-flex default
      }
    }
    var html = '<table class="cal-table">';
    html += '<thead><tr class="cal-header-row">';
    html += '<th class="cal-head-cell cal-head-month">月</th>';
    var dayLabels = ["一", "二", "三", "四", "五", "六", "日"];
    dayLabels.forEach(function (l) {
      html += '<th class="cal-head-cell">' + l + '</th>';
    });
    html += '</tr></thead>';
    html += '<tbody>';

    for (var wi2 = 0; wi2 < weeks.length; wi2++) {
      var isGroupStart = false;
      var group = null;
      monthGroups.forEach(function (g) {
        if (g.startWeek === wi2) { isGroupStart = true; group = g; }
      });

      var ws = wi2 * 7;

      // --- 日期行：空日程使用 rowspan=2 合并日期+日程单元格 ---
      html += '<tr class="cal-week-row">';
      if (isGroupStart) {
        html += '<td class="cal-cell cal-month-cell" rowspan="' + group.rowSpan + '">' +
          monthNameCN(group.month) + '</td>';
      }
      for (var di3 = 0; di3 < 7; di3++) {
        var ci = ws + di3;
        var c = flatCells[ci];
        var cKey = fmtDate(c.date);
        // 续接链属性：点击续接范围内的任何日期/日程，黄框都覆盖整个合并矩形
        var chainAttr = ' data-chain-start="' + c.chainStartIdx + '" data-chain-len="' + c.chainLen + '"';
        // 日期单元格以"选中日期"作为高亮基准（不再仅依赖真实今天，点击后 selKey 会变）
        var isSelSingle = c.isEmpty && cKey === selKey;
        var isSelTop = !c.isEmpty && cKey === selKey;
        // 续接链内的其他日期列（非源日期本身）：若属于当前选中链，也给底边加黄线，与源列的黄线 + 合并日程单元格的顶黄线视觉贯通
        var inSelChain = (!c.isEmpty) && c.mergedColspan <= 1 && selChainStart >= 0 && c.chainStartIdx === selChainStart && cKey !== selKey;
        var chainTopCls = inSelChain ? ' cal-chain-today-top' : '';
        // data-date 放在 td 上便于 click handler 读取对应日期
        if (c.isEmpty) {
          html += '<td class="cal-cell cal-day-cell cal-day-empty' + (isSelSingle ? ' cal-today' : '') + '" data-date="' + cKey + '"' + chainAttr + ' rowspan="2">' + c.date.getDate() + '</td>';
        } else {
          var hasSchedBelow = (c.schedules && c.schedules.length > 0) ? ' has-sched-below' : '';
          html += '<td class="cal-cell cal-day-cell' + hasSchedBelow + (isSelTop ? ' cal-today-top' : '') + chainTopCls + '" data-date="' + cKey + '"' + chainAttr + '>' + c.date.getDate() + '</td>';
        }
      }
      html += '</tr>';

      // --- 日程行：空日程被日期 rowspan=2 覆盖 → 跳过 ---
      html += '<tr class="cal-week-row cal-sched-row">';
      for (var di4 = 0; di4 < 7; di4++) {
        var ci2 = ws + di4;
        var c2 = flatCells[ci2];

        if (c2.isEmpty) {
          continue;
        }
        if (c2.skipped) {
          continue;
        }

        // 源单元格：带 colspan 的，过滤掉续接日程（避免重复显示）
        // 独立单元格（包括无法合并的续接日程）：显示所有日程
        var isSource = c2.mergedColspan > 1;
        var scheds;
        if (isSource) {
          scheds = c2.schedules.filter(function (s) { return !s.isContinuation; });
        } else {
          scheds = c2.schedules.slice();
        }

        var c2Key = fmtDate(c2.date);
        var isSelBottom = c2Key === selKey;
        // 续接链属性：与日期行保持一致（用 chainStartIdx 对应源单元格的索引/链长）
        var chainAttr2 = ' data-chain-start="' + c2.chainStartIdx + '" data-chain-len="' + c2.chainLen + '"';

        if (!scheds.length) {
          var emptySelCls = isSelBottom ? ' cal-today-bottom' : '';
          html += '<td class="cal-cell cal-sched-cell cal-sched-empty' + emptySelCls + '" data-date="' + c2Key + '"' + chainAttr2 + '></td>';
          continue;
        }
        var color = scheds[0].color;
        var cellStyle = 'background:' + hexWithAlpha(color, 0.35) + ';';
        var schedHtml = scheds.map(function (s) { return escapeHtml(s.content); }).join(" ");
        var colspanAttr = isSource ? ' colspan="' + c2.mergedColspan + '"' : '';
        var schedSelCls = isSelBottom ? ' cal-today-bottom' : '';
        html += '<td class="cal-cell cal-sched-cell has-sched' + schedSelCls + '"' + colspanAttr + ' data-date="' + c2Key + '"' + chainAttr2 + ' style="' + cellStyle + '">' +
          schedHtml +
        '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;

    // ======= 单元格点击：把选中日期切到「续接链第一天」，重绘黄框 + 项目刻度条 =======
    //   采用【事件委托】→ click handler 只给 #homeCalendar 容器绑 1 次（__calClickBound 去重）
    //   之前每次 render 给数百个 cell 逐个 addEventListener，会造成重复绑定 → 点一下触发 N 次 renderHomeCalendar → 死循环卡死
    // =======
    if (!container.__calClickBound) {
      container.__calClickBound = true;
      container.addEventListener("click", function (ev) {
        var cell = ev.target.closest(".cal-day-cell, .cal-sched-cell");
        if (!cell || !cell.getAttribute("data-date")) return;
        if (!state.calendar) state.calendar = {};
        var chainStartIdx = parseInt(cell.getAttribute("data-chain-start") || "-1", 10);
        var srcKey;
        // 从 #homeCalendar container 的 DOM 属性中取出上次渲染的 flatCells（避免闭包变量失效）
        // 稳妥方案：直接重算一次 flatCells 太耗时，还是用 state.homeCalendarFlatCells 在 render 开头存下来
        var flatCellsCached = state.homeCalendarFlatCells || [];
        if (chainStartIdx >= 0 && flatCellsCached[chainStartIdx]) {
          srcKey = fmtDate(flatCellsCached[chainStartIdx].date);
        } else {
          srcKey = cell.getAttribute("data-date");
        }
        if (!srcKey) return;
        if (state.calendar.selectedDate === srcKey) return;
        state.calendar.selectedDate = srcKey;
        save();
        renderHomeCalendar();
        renderHomeProjects();
      });
    }

    // （原逐个绑定的 calCells.forEach addEventListener 已删，改成上面的事件委托，彻底解决重复绑定卡死）

    // 黄框定位逻辑抽成独立函数：renderHomeCalendar 的 rAF 与 list-wrap 滚动事件都调用它，
    // 保证日历内容上下滚动时黄框（挂在外层卡片，不随 list-wrap 滚动）实时跟随选中单元格
    function positionFrame() {
      var cont = $("#homeCalendar");
      if (!cont) return;
      var cardEl = cont.closest ? cont.closest(".home-card") : null;
      if (!cardEl) {
        var pp = cont.parentNode;
        while (pp && pp.classList && !pp.classList.contains("home-card")) pp = pp.parentNode;
        cardEl = pp || cont;
      }
      // 以卡片为坐标系（containing block = card.padding box，无 border → 与卡片 box model 一致）
      var cRect = cardEl.getBoundingClientRect();

      // ======= 高亮外框：以 chainLen/chainStartIdx 为续接链参考，
      // 1) 先找到「选中的种子单元格」（single/top/bottom 任一）
      // 2) 读取 chainStartIdx + chainLen
      // 3) 在同周内扫描 chainLen 列：对每一列，收集日期行 cell + 日程行 cell（或 rowspan=2 单格）
      // 4) 所有 cell 的 getBoundingClientRect 取并集 → 覆盖整个续接跨列区间（与点合并日程单元格效果完全一致）
      var frame = document.getElementById("calTodayFrame");
      var seed = cont.querySelector(".cal-cell.cal-today") ||
                  cont.querySelector(".cal-cell.cal-today-top") ||
                  cont.querySelector(".cal-cell.cal-today-bottom");
      if (!seed) {
        if (frame) frame.style.display = "none";
        return;
      }
      if (!frame) {
        frame = document.createElement("div");
        frame.id = "calTodayFrame";
      }
      // 确保 frame 挂在外层卡片（之前可能挂在旧 #homeCalendar 下，DOM 位置错会坐标错 / 被裁）
      if (frame.parentNode !== cardEl) { cardEl.appendChild(frame); }
      frame.style.display = "";
      var chainStart = parseInt(seed.getAttribute("data-chain-start") || "0", 10);
      var chainLen = parseInt(seed.getAttribute("data-chain-len") || "1", 10);
      if (isNaN(chainStart)) chainStart = 0;
      if (isNaN(chainLen) || chainLen < 1) chainLen = 1;
      // 收集同周对应行的所有列 cell 并求联合矩形
      var rect = null;
      var seedWeekIdx = Math.floor(chainStart / 7);
      var allDateCells = cont.querySelectorAll(".cal-week-row:not(.cal-sched-row) .cal-day-cell");
      var allSchedRows = cont.querySelectorAll(".cal-sched-row");
      var schedRowForWeek = allSchedRows[seedWeekIdx] || null;
      for (var colOffset = 0; colOffset < chainLen; colOffset++) {
        var cellIdx = chainStart + colOffset;
        var dayCell = allDateCells[cellIdx];  // 扁平索引正好按周列顺序
        if (dayCell) {
          var dr = dayCell.getBoundingClientRect();
          if (!rect) rect = { top: dr.top, left: dr.left, right: dr.right, bottom: dr.bottom };
          else {
            rect.top = Math.min(rect.top, dr.top);
            rect.left = Math.min(rect.left, dr.left);
            rect.right = Math.max(rect.right, dr.right);
            rect.bottom = Math.max(rect.bottom, dr.bottom);
          }
        }
        // 若 day cell 无 rowspan=2（即有下面的日程行单元格），取日程的那格的 rect
        var daySpan2 = dayCell && dayCell.hasAttribute("rowspan") && dayCell.getAttribute("rowspan") === "2";
        if (!daySpan2 && schedRowForWeek) {
          // 该列在本 sched row 中对应的 td：用 rowspan 合并/续接 skipped 的情况下列号不对应 cell index，
          // 直接按 schedule 源单元格位置 = chainStart 对应的源日期所在列 — sched 源 cell 通过 data-chain-start === chainStart 匹配
          var schedCells = schedRowForWeek.querySelectorAll(".cal-cell");
          for (var si = 0; si < schedCells.length; si++) {
            var sc = schedCells[si];
            var scStart = parseInt(sc.getAttribute("data-chain-start") || "-1", 10);
            if (scStart === chainStart) {
              var sr = sc.getBoundingClientRect();
              rect.top = Math.min(rect.top, sr.top);
              rect.left = Math.min(rect.left, sr.left);
              rect.right = Math.max(rect.right, sr.right);
              rect.bottom = Math.max(rect.bottom, sr.bottom);
              break;  // 一周中对应一个源 sched cell
            }
          }
        }
      }
      if (!rect) { frame.style.display = "none"; return; }
      // 选中单元格被滚出 list-wrap 可视区时隐藏黄框，避免它浮到卡片标题/底边外
      var lw = cont.closest ? cont.closest(".list-wrap") : null;
      if (lw) {
        var lwRect = lw.getBoundingClientRect();
        if (rect.bottom <= lwRect.top || rect.top >= lwRect.bottom) {
          frame.style.display = "none";
          return;
        }
      }
      // 外边框对齐到表格框线：用 -2px 偏移把 4px 半厚（中心 2px）对齐到网格白线中心
      // 由于 containing block = card（无任何裁切），最右 2px 越出也能完整绘制
      var borderPx = 4;
      var half = borderPx / 2;
      var left = rect.left - cRect.left - half;
      var top = rect.top - cRect.top - half;
      var width = (rect.right - rect.left) + borderPx;
      var height = (rect.bottom - rect.top) + borderPx;
      // 关闭过渡后立即赋值，下一帧再开过渡，避免首次渲染时从左上角飞过来
      frame.style.transition = "none";
      frame.style.top = top + "px";
      frame.style.left = left + "px";
      frame.style.width = width + "px";
      frame.style.height = height + "px";
      void frame.offsetWidth;
      frame.style.transition = "";
    }

    // 渲染后设置行高：等待 flex 布局完成再读取实际高度
    requestAnimationFrame(function () {
      var table = container.querySelector(".cal-table");
      if (!table) return;

      // 清理历史版本留下的 footer/tabl 高度内联样式（防止尺寸残留）
      table.style.height = "";
      table.style.flex = "";
      table.style.maxHeight = "";
      table.style.minHeight = "";

      var containerH = container.getBoundingClientRect().height;
      if (containerH < 60) containerH = container.clientHeight;
      var headerRow = table.querySelector(".cal-header-row");
      var headerH = headerRow ? headerRow.offsetHeight : 28;
      var bodyH = Math.max(48, Math.round(containerH) - headerH);
      var weekCount = weeks.length;
      var totalRows = weekCount * 2;
      var baseRowH = Math.floor(bodyH / totalRows);
      var remainder = bodyH - baseRowH * totalRows;

      var nonHeaderRows = table.querySelectorAll("tr:not(.cal-header-row)");
      var idx = 0;
      nonHeaderRows.forEach(function (tr) {
        var extra = idx < remainder ? 1 : 0;
        tr.style.height = (baseRowH + extra) + "px";
        idx++;
      });

      // 再等一帧：行高生效 + 尺寸稳定 → 画选中日期高亮外框覆盖层
      requestAnimationFrame(function () {
        positionFrame();
      });
    });
    // 窗口尺寸变化后，重新分配行高 + 重新定位今日黄框（否则表格宽度改变而黄框仍冻结在旧坐标，造成错位）
    // 防抖 150ms，避免拖动窗口边缘时每 16ms 重渲染整个日历
    if (!window.__jfesHomeCalResizeBound) {
      window.__jfesHomeCalResizeBound = true;
      var __resizeTimer = null;
      window.addEventListener("resize", function () {
        if (__resizeTimer) clearTimeout(__resizeTimer);
        __resizeTimer = setTimeout(function () {
          // 如果当前视图仍是首页且容器仍存在，则重绘日历（行高 + 覆盖层）
          if (document.getElementById("homeCalendar")) { renderHomeCalendar(); }
        }, 150);
      }, { passive: true });
    }
    // 日历内容上下滚动时（小屏行高超出卡片视口），黄框挂在外层卡片不会随 list-wrap 滚动，
    // 需监听 list-wrap 的 scroll 事件，rAF 节流重算黄框位置使其跟随选中单元格
    var __calScrollSW = document.querySelector(".view-home .home-card .list-wrap:has(#homeCalendar)");
    if (__calScrollSW && !__calScrollSW.__scrollBound) {
      __calScrollSW.__scrollBound = true;
      __calScrollSW.addEventListener("scroll", function () {
        if (window.__jfesCalScrollRaf) return;
        window.__jfesCalScrollRaf = requestAnimationFrame(function () {
          window.__jfesCalScrollRaf = null;
          // 仅当首页日历仍存在时重定位（避免在其它视图空跑）
          if (document.getElementById("homeCalendar")) { positionFrame(); }
        });
      }, { passive: true });
    }
  }

  // ============================================================
  // 热点模块：hp 目录帖子加载 / 解析 / 渲染
  // hp/<YYYYMMDD-HHMM> 帖子文件格式：
  //   Line 1: 标题（第 1 行默认是标题，即使没有标题行分隔符也按标题处理）
  //   之后遇到一行正好是 "---"（3 个减号）=> 往下开始正文
  //   正文之后再遇到一行正好是 "---" => 往下开始评论区
  //   评论每一行格式：可选缩进（空格/tab，表示回复层级）+ "作者: 评论内容"
  //   若某行不含冒号分隔且作者上无法解析，整行作为"匿名"处理
  // ============================================================
  var HpState = {
    posts: [],         // [{ id, filename, dateObj, title, body, comments: [{name, text, indentLevel, children: [...]}] }, ...]
    avatars: {},       // 头像 name -> "url(path)" or "data:image/svg+xml;utf8,..."（首字母+随机色）
    avatarExts: ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp"],
    selectedId: null,  // 当前选中帖子 id
    searchText: "",    // 当前搜索关键字
    commentFloorIdx: null,               // 评论详情：当前在看哪条主评论的倒序下标（null=全列表）
    commentScrollFloorToRestore: null,   // 从详情返回列表时：要滚回到哪条主评论的倒序下标（还原位置用）
    commentScrollTopBefore: 0            // 进入详情前：list-wrap 当时的 scrollTop（找不到元素时的兜底还原）
  };

  // 文件名 "20260821-2326" → Date 对象；解析失败返回 null
  function parseHpFilename(name) {
    var base = name.replace(/\.[^.]+$/, "");   // 去扩展名
    var m = base.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (!m) return null;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1, d = parseInt(m[3], 10);
    var hh = parseInt(m[4], 10), mm = parseInt(m[5], 10);
    if (mo < 0 || mo > 11 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
    var dt = new Date(y, mo, d, hh, mm, 0, 0);
    if (isNaN(dt.getTime())) return null;
    return dt;
  }
  function fmtHpDate(dt) {
    if (!dt) return "";
    var y = dt.getFullYear();
    var m = String(dt.getMonth() + 1).padStart(2, "0");
    var d = String(dt.getDate()).padStart(2, "0");
    var hh = String(dt.getHours()).padStart(2, "0");
    var mm = String(dt.getMinutes()).padStart(2, "0");
    return y + "-" + m + "-" + d + " " + hh + ":" + mm;
  }

  // 纯字符串哈希：给名字生成稳定随机色底（保证同一人每次颜色一致）
  function nameHashColor(name) {
    var s = (name || "匿名").toString();
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    // 色调 0-360；取饱和度 60~80，亮度 48~58，保证深色底卡片可读
    var hue = ((h % 360) + 360) % 360;
    var sat = 62 + Math.abs((h >> 3) % 18);
    var lig = 50 + Math.abs((h >> 5) % 8);
    return "hsl(" + hue + ", " + sat + "%, " + lig + "%)";
  }
  function nameFirstChar(name) {
    if (!name) return "?";
    var s = name.trim();
    if (!s) return "?";
    // 英文取首字母大写；中文取首汉字；其他首字符
    return s.charAt(0).toUpperCase();
  }
  function buildAvatarSvg(name) {
    var bg = nameHashColor(name);
    var chRaw = nameFirstChar(name);
    // SVG 里的文本节点要正常转义；最终整体做 encodeURIComponent，确保 data URL 合法（中文、#、&、< 这些都不会破坏 data:image 协议头或 CSS 解析）
    var svgContent =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
        '<rect width="64" height="64" rx="32" fill="' + bg.replace(/"/g, '&quot;') + '"/>' +
        '<text x="32" y="42" font-size="32" font-family="system-ui, -apple-system, Segoe UI, Roboto, PingFang SC, Microsoft YaHei, sans-serif" font-weight="700" fill="#fff" text-anchor="middle">' + escapeHtml(chRaw) + '</text>' +
      '</svg>';
    return "data:image/svg+xml;utf8," + encodeURIComponent(svgContent);
  }

  // file:// 下不能用 encodeURIComponent 把中文转成 %E4%BC%81——Windows 真实文件名是 UTF-16 字符，不是 URL 编码后的路径。
  // 只做最小安全转义：对 "'<>\?#% 以及空格这几个会破坏 CSS url / HTML 路径 / URL 片段的字符做 encodeURIComponent，中文原样保留，file:// 本地文件 100% 能命中。
  function hpEncodeAvatarName(name) {
    var s = String(name == null ? "" : name);
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (' \'"<>\\?#%&'.indexOf(c) >= 0 || c.charCodeAt(0) <= 0x1F) {
        out += encodeURIComponent(c);
      } else {
        out += c;
      }
    }
    return out;
  }

  // 尝试加载 hp/tx/<人名>.<ext>；失败则回退到首字母 SVG
  function hpGetAvatar(name) {
    if (HpState.avatars[name]) return HpState.avatars[name];
    var fallback = buildAvatarSvg(name);
    HpState.avatars[name] = fallback;   // 先占位 fallback，防止 404 反复请求
    // 并行尝试几种常见扩展名；第一个成功即写入缓存
    var pendingExts = HpState.avatarExts.length;
    var safeName = hpEncodeAvatarName(name);
    HpState.avatarExts.forEach(function (ext) {
      var url = "hp/tx/" + safeName + "." + ext;
      // 浏览器 fetch 头不允许直接判断 file:// 存在；用 Image() 探测是否能成功加载
      var img = new Image();
      var done = false;
      img.onload = function () {
        if (done) return;
        done = true;
        if (HpState.avatars[name] && HpState.avatars[name].indexOf("data:") === 0) {
          // CSS url() 内统一用单引号，避免和后续 inline style 的外层双引号冲突
          HpState.avatars[name] = "url('" + url + "')";
          // 已渲染到 DOM 的头像圆框如果是本 fallback，刷新一次背景
          document.querySelectorAll(".hp-comment-avatar[data-name=\"" + cssEscape(name) + "\"]").forEach(function (el) {
            el.style.backgroundImage = HpState.avatars[name];
          });
        }
      };
      img.onerror = function () {
        pendingExts--;
      };
      img.src = url;
    });
    return fallback;
  }
  // 简易 CSS.escape polyfill（兼容老浏览器）
  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/(["'\\])/g, "\\$1");
  }

  // 评论解析：按「行前缀缩进空格数」建父子嵌套树
  function buildHpCommentTree(rawLines) {
    // 结果是顶层数组；每个节点：{name, text, indent, children: []}
    var stack = [];   // 数组每项 {indent, node}
    var roots = [];
    rawLines.forEach(function (line) {
      if (!line.trim()) return;   // 空行忽略
      // 计算缩进（空格 2=tab 1）
      var indent = 0;
      var pos = 0;
      while (pos < line.length) {
        var c = line.charAt(pos);
        if (c === " ") { indent += 1; pos++; }
        else if (c === "\t") { indent += 2; pos++; }
        else break;
      }
      var rest = line.slice(pos);
      if (!rest.trim()) return;
      // 解析 "作者: 内容" 或 "作者：内容"（中英文冒号皆可）
      var sepIdx = -1;
      for (var i = 0; i < rest.length; i++) {
        var cc = rest.charAt(i);
        if (cc === ":" || cc === "：") { sepIdx = i; break; }
      }
      var author, text;
      if (sepIdx < 0) {
        author = "匿名";
        text = rest;
      } else {
        author = rest.slice(0, sepIdx).trim() || "匿名";
        text = rest.slice(sepIdx + 1).replace(/^[ \t]+/, "");
      }
      var node = { name: author, text: text, indent: indent, children: [] };
      // 出栈：pop 到栈顶节点 indent < 当前 indent
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (!stack.length) {
        roots.push(node);
      } else {
        stack[stack.length - 1].node.children.push(node);
      }
      stack.push({ indent: indent, node: node });
    });
    return roots;
  }

  function parseHpPost(filename, rawText) {
    var dt = parseHpFilename(filename);
    if (!dt) return null;     // 文件名不规范：跳过
    var text = (rawText || "").replace(/\r\n?/g, "\n");
    var lines = text.split("\n");
    if (!lines.length) return null;

    var title = "";
    var bodyLines = [];
    var commentLines = [];
    // 状态机：0=还没遇到第一个分隔符（读标题+累积直到遇到 "---" 切正文），1=正文累积中，2=评论累积中
    var stage = 0;
    var readFrom = 0;
    // 第一行默认是标题（无论 stage）
    title = (lines[0] || "").trim();
    readFrom = 1;
    for (var i = 1; i < lines.length; i++) {
      var ln = lines[i];
      var trimmed = (ln || "").trim();
      if (trimmed === "---") {
        if (stage === 0) { stage = 1; readFrom = i + 1; continue; }
        if (stage === 1) {
          // 之前累积的 bodyLines 已经在下面循环前处理，这里切到评论
          stage = 2; readFrom = i + 1; continue;
        }
        if (stage === 2) { /* 评论区里多余 "---" 当正文内容保留 */ }
      }
      if (stage === 0) {
        // 标题后一直没遇到分隔符：作为正文前缀
        bodyLines.push(ln);
      } else if (stage === 1) {
        bodyLines.push(ln);
      } else {
        commentLines.push(ln);
      }
    }
    // 如果到文件末尾 stage 仍是 0（根本没写过分隔符），当作全文正文
    var body = bodyLines.join("\n").replace(/^\s+|\s+$/g, "");
    var comments = buildHpCommentTree(commentLines);

    var postId = "hp_" + filename.replace(/\.[^.]+$/, "");
    // 计数：所有评论节点（含嵌套）总条数
    var countAll = 0;
    (function walk(arr) {
      for (var i = 0; i < arr.length; i++) { countAll++; walk(arr[i].children); }
    })(comments);

    return {
      id: postId,
      filename: filename,
      dateObj: dt,
      title: title,
      body: body,
      comments: comments,
      commentCount: countAll
    };
  }

  // 扫描 hp 目录：多策略兜底解析目录页
  // 策略 1：fetch("hp/") → 常规 <a href="..."> 超链接（Apache/Nginx/Caddy/IIS）【仅 HTTP/HTTPS】
  // 策略 2：fetch("hp/") 返回 JSON 数组（有些静态服务器默认 JSON 列表）【仅 HTTP/HTTPS】
  // 策略 3：遍历整段 HTML 的正则 /(\d{8}-\d{4}[^\s"'<>]*)/g，兜底目录页非超链接只纯文本场景（Python http.server, SimpleHTTPServer）【仅 HTTP/HTTPS】
  // 策略 4【file:// 专用 · 零 fetch】：动态注入 <script src="hp/__all_posts__.js">，读取 window.__ALL_HP_POSTS__
  //         这是 file:// 下唯一 100% 不被 Chrome/Edge CORS 拦截的"批量加载帖子"方案，需要把所有帖子打包进一个 JS 变量（可用下方 UI"一键导出 __all_posts__.js"生成）。
  // 策略 5【file:///HTTP 通用兜底】：localStorage['jfes_hp_posts_cache_v1'] 直接存 {filename, rawText} 数组（用户用"选本地文件"/"拖拽"导入过一次，之后永久记住）
  function loadHpPosts(alsoRender, forceRescan, silent) {
    // 强制重扫：清空缓存 Promise
    if (forceRescan) HpState.__scanPromise = null;
    if (!HpState.__scanPromise) {
      var isFileProtocol = window.location.protocol === "file:";
      HpState.__scanPromise = (async function () {
        var found = [];
        var dirStatus = { ok: false, hint: "", dirFailed: false, triedAllJs: false, allJsOk: false };

        // ---- 策略 5：先读 localStorage 正文章缓存（有就直接用，不折腾任何 fetch/script）----
        try {
          var cacheKey = "jfes_hp_posts_cache_v1";
          var cachedRaw = localStorage.getItem(cacheKey);
          if (cachedRaw) {
            var cachedArr = JSON.parse(cachedRaw);
            if (Array.isArray(cachedArr) && cachedArr.length) {
              var postsFromCache = [];
              cachedArr.forEach(function (item) {
                try {
                  var p = parseHpPost(String(item.filename || ""), String(item.rawText || ""));
                  if (p) postsFromCache.push(p);
                } catch (e4) {}
              });
              if (postsFromCache.length) {
                postsFromCache.sort(function (a, b) { return b.dateObj.getTime() - a.dateObj.getTime(); });
                HpState.posts = postsFromCache;
                if (!silent && typeof showToast === "function") { try { showToast("已加载 " + postsFromCache.length + " 条本地帖子（file:// 缓存）"); } catch (eT) {} }
                return postsFromCache;
              }
            }
          }
        } catch (eCache) { /* localStorage 禁用或损坏不影响主流程 */ }

        // ===== file:// 协议：彻底跳过 fetch（Chrome/Edge 默认 CORS 拦，network error），只走 script + localStorage =====
        if (isFileProtocol) {
          dirStatus.triedAllJs = true;
          try {
            var allPosts = await hpLoadAllPostsScript();
            if (Array.isArray(allPosts) && allPosts.length) {
              var postsFromJs = [];
              allPosts.forEach(function (item) {
                try {
                  var p = parseHpPost(String(item.filename || ""), String(item.raw || item.rawText || item.text || ""));
                  if (p) postsFromJs.push(p);
                } catch (eJ) {}
              });
              if (postsFromJs.length) {
                postsFromJs.sort(function (a, b) { return b.dateObj.getTime() - a.dateObj.getTime(); });
                HpState.posts = postsFromJs;
                dirStatus.allJsOk = true;
                // 同步写入 localStorage：下次打开更快
                try {
                  var toCache = allPosts.map(function (x) {
                    return { filename: String(x.filename || ""), rawText: String(x.raw || x.rawText || x.text || "") };
                  });
                  localStorage.setItem(cacheKey, JSON.stringify(toCache));
                } catch (eC) {}
                if (!silent && typeof showToast === "function") { try { showToast("已加载 " + postsFromJs.length + " 条本地帖子（__all_posts__.js）"); } catch (eT) {} }
                return postsFromJs;
              }
            }
          } catch (_ej) { /* __all_posts__.js 不存在或格式错，不抛异常 */ }
        } else {
          // ===== HTTP/HTTPS 协议：正常使用 fetch 列目录 + 读帖子 =====
          try {
            var resp = await fetch("hp/", { cache: "no-store" });
            dirStatus.ok = resp.ok;
            if (!resp.ok) throw new Error("hp dir not ok: " + resp.status);
            var contentType = (resp.headers.get("content-type") || "").toLowerCase();
            if (contentType.indexOf("application/json") >= 0) {
              // 策略 2：JSON 数组
              try {
                var arr = await resp.json();
                if (Array.isArray(arr)) {
                  arr.forEach(function (x) {
                    var s = (typeof x === "string") ? x : (x.name || x.filename || x.href || "");
                    var m = String(s).match(/(\d{8}-\d{4})(\.[^.\/?#\s]+)?/);
                    if (m) found.push(m[0].split("/").pop());
                  });
                }
              } catch (_je) { /* JSON 解析失败，退回 HTML/text 策略 */ }
            }
            if (!found.length) {
              var text = await resp.text();
              // 策略 1：超链接 DOM 解析
              try {
                var doc = new DOMParser().parseFromString(text, "text/html");
                var links = doc.querySelectorAll("a[href]");
                links.forEach(function (a) {
                  var href = a.getAttribute("href") || "";
                  // 兼容：/hp/20260821-2326、hp/20260821-2326、20260821-2326、20260821-2326.txt、?query 锚点等
                  var m = href.match(/(\d{8}-\d{4})(\.[^.\/?#]+)?/);
                  if (!m) return;
                  found.push(m[0].split("/").pop().split("?")[0].split("#")[0]);
                });
              } catch (_de) { /* DOMParser 失败，退回文本正则 */ }
              // 策略 3：纯文本正则兜底（Python http.server 目录页是纯文本表格不带规范超链接 href 的场景也能命中）
              if (!found.length) {
                var re = /\b(\d{8}-\d{4})(\.[A-Za-z0-9_\-]+)?\b/g;
                var mm;
                while ((mm = re.exec(text)) !== null) {
                  var fn = mm[0];
                  if (fn.indexOf("\\") >= 0) fn = fn.split("\\").pop();
                  found.push(fn);
                }
              }
            }
          } catch (e) {
            dirStatus.hint = (e && e.message) ? e.message : "无法读取 hp 目录";
            dirStatus.dirFailed = true;
          }
        }

        // 去重 + 规范化 + 日期合法性验证（HTTP 下 found 可能有东西；file:// 这里 found 永远是空）
        var seen = {};
        var uniq = [];
        for (var i = 0; i < found.length; i++) {
          var f = found[i].split(/[?#]/)[0];
          var bas = f.replace(/^\.?\//, "").split(/[\\\/]/).pop();
          if (seen[bas]) continue;
          seen[bas] = true;
          // 允许纯 "20260821-2326"（无扩展名）以及 .md/.txt/.text/.log 等常见文本扩展名
          if (parseHpFilename(bas)) uniq.push(bas);
        }
        found = uniq;

        // 读取每个帖子的文本：file:// 下不执行；HTTP 下按扩展名 fallback
        var posts = [];
        var failedFiles = [];
        var commonExts = ["", ".txt", ".md", ".text", ".log"];
        if (!isFileProtocol) {
          for (var fi = 0; fi < found.length; fi++) {
            var fileName = found[fi];
            // 已经带扩展名的直接 fetch；否则尝试多个扩展名
            var candidates = [];
            var hasExt = /\.[A-Za-z0-9_\-]+$/.test(fileName);
            if (hasExt) { candidates.push(fileName); }
            else {
              commonExts.forEach(function (e) { candidates.push(fileName + e); });
            }
            var loadedOk = false;
            for (var ci = 0; ci < candidates.length; ci++) {
              try {
                var url = "hp/" + encodeURIComponent(candidates[ci]);
                var r = await fetch(url, { cache: "no-store" });
                if (!r.ok) continue;
                var ct = (r.headers.get("content-type") || "").toLowerCase();
                if (ct.indexOf("image/") >= 0 || ct.indexOf("video/") >= 0 || ct.indexOf("audio/") >= 0) continue;
                var t = await r.text();
                var p = parseHpPost(candidates[ci], t);
                if (p) { posts.push(p); loadedOk = true; break; }
              } catch (_e) { /* 单个帖子读失败，试下一扩展名 */ }
            }
            if (!loadedOk) failedFiles.push(fileName);
          }
        }

        // 按时间倒序（最新帖子在上）
        posts.sort(function (a, b) { return b.dateObj.getTime() - a.dateObj.getTime(); });
        HpState.posts = posts;

        // 静默加载：不再弹窗提示"检测不到 hp 帖子"
        if (!posts.length) {
          // 无帖子时不提示，保持静默
        } else if (failedFiles.length) {
          if (!silent && typeof showToast === "function") { try { showToast("已加载 " + posts.length + " 条帖子，失败 " + failedFiles.length + " 条"); } catch (e3) {} }
        }
        return posts;
      })().catch(function () { HpState.posts = []; return []; });
    }
    var prom = HpState.__scanPromise.then(function () {
      if (alsoRender) renderHotspotAll();
    });
    return prom;
  }

  // 【file:// 专用 · 零 fetch】动态 <script src="hp/__all_posts__.js"> 加载帖子包
  // __all_posts__.js 格式：
  //   window.__ALL_HP_POSTS__ = [
  //     { filename: "20260821-2326.txt", raw: "帖子第1行标题\n---\n正文\n---\n张三: 评论1" },
  //     { filename: "20260825-1010.md",  raw: "..." }
  //   ];
  function hpLoadAllPostsScript() {
    return new Promise(function (resolve, reject) {
      var timeout = setTimeout(function () { onDone(new Error("timeout"), null); }, 5000);
      function onDone(err, data) {
        clearTimeout(timeout);
        if (script && script.parentNode) script.parentNode.removeChild(script);
        try { delete window.__ALL_HP_POSTS__; } catch (_e) { try { window.__ALL_HP_POSTS__ = undefined; } catch (_e2) {} }
        if (err) reject(err); else resolve(data);
      }
      var script = document.createElement("script");
      script.type = "text/javascript";
      script.onload = function () {
        var data = null;
        try { data = window.__ALL_HP_POSTS__; } catch (_e) { data = null; }
        if (Array.isArray(data)) onDone(null, data);
        else onDone(new Error("__ALL_HP_POSTS__ 非数组"), null);
      };
      script.onerror = function () { onDone(new Error("__all_posts__.js 不存在"), null); };
      script.src = "hp/__all_posts__.js?_=" + Date.now();   // 加时间戳防止缓存
      document.head.appendChild(script);
    });
  }

  // 【兜底序列化】当 HpState.posts 里某条帖子找不到原始 rawText（例如来自 hp/__all_posts__.js 首次注入，或旧版本缓存里只存了对象），
  // 把已解析的 post 对象还原回「标题 --- 正文 --- 评论」的导入格式文本，保证导出不会漏帖子。
  function hpSerializePostToRawText(post) {
    if (!post) return "";
    var lines = [];
    // 1. 第 1 行：标题（严格一行，防止标题内带 \n 导致格式错位）
    var titleLine = (post.title == null ? "(无标题)" : String(post.title)).replace(/\r?\n/g, " ");
    lines.push(titleLine);
    lines.push("");
    // 2. 第 1 个 --- 分隔符 + 正文
    lines.push("---");
    lines.push("");
    if (post.body != null && String(post.body).trim() !== "") {
      lines.push(String(post.body));
    }
    lines.push("");
    lines.push("---");
    lines.push("");
    // 3. 评论：DFS 整棵树，按节点记录的 indent 生成前置空格，格式 =「空格*N + 作者: 内容」
    if (Array.isArray(post.comments)) {
      (function walk(arr) {
        if (!arr || !arr.length) return;
        for (var i = 0; i < arr.length; i++) {
          var n = arr[i];
          if (!n) continue;
          var indent = n.indent != null ? Number(n.indent) : 0;
          if (isNaN(indent) || indent < 0) indent = 0;
          var prefix = "";
          for (var s = 0; s < indent; s++) prefix += " ";
          var name = (n.name == null ? "匿名" : String(n.name)).replace(/\r?\n/g, " ");
          var text = (n.text == null ? "" : String(n.text)).replace(/\r?\n/g, " ");
          lines.push(prefix + name + ": " + text);
          walk(n.children);
        }
      })(post.comments);
    }
    return lines.join("\n");
  }

  // 基于当前 HpState.posts（UI 上实际能看到的所有帖子）构建完整的 {filename,rawText} 导出数组：
  // - 同 filename 能在 localStorage / __lastImportedRaw 里找到原始文本 → 直接用（保真度最高）
  // - 找不到 → hpSerializePostToRawText 序列化兜底 → 保证不漏任何一条
  function hpBuildAllPostsRawFromState() {
    // 先把所有已知 rawText 收集到 map，避免重复
    var rawMap = {};
    try {
      var cached = localStorage.getItem("jfes_hp_posts_cache_v1");
      if (cached) {
        var arr = JSON.parse(cached);
        if (Array.isArray(arr)) {
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            if (it && it.filename != null) rawMap[it.filename] = String(it.rawText || "");
          }
        }
      }
    } catch (_e) {}
    if (Array.isArray(HpState.__lastImportedRaw)) {
      for (var j = 0; j < HpState.__lastImportedRaw.length; j++) {
        var x = HpState.__lastImportedRaw[j];
        if (x && x.filename != null) rawMap[x.filename] = String(x.rawText || "");
      }
    }
    // 遍历 HpState.posts 按顺序输出，优先 rawMap 里的原文，否则序列化
    var out = [];
    if (!Array.isArray(HpState.posts)) return out;
    for (var k = 0; k < HpState.posts.length; k++) {
      var post = HpState.posts[k];
      if (!post || post.filename == null) continue;
      var rawText = rawMap[post.filename];
      if (rawText == null || rawText === "") rawText = hpSerializePostToRawText(post);
      out.push({ filename: post.filename, rawText: rawText });
    }
    return out;
  }

  // 【file:// 专用】把一批本地 File 用 FileReader 读成帖子，写入 HpState.posts 并缓存到 localStorage
  // 另外把导入的 {filename,rawText} 数组写进 HpState.__lastImportedRaw，给 UI"一键导出 __all_posts__.js"按钮使用
  function hpImportLocalFiles(fileList, alsoRender) {
    if (!fileList || !fileList.length) return;
    var files = Array.prototype.slice.call(fileList);
    var pending = files.length;
    var loadedArr = [];
    files.forEach(function (f) {
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var text = String(ev.target.result || "");
          var p = parseHpPost(f.name, text);
          if (p) {
            loadedArr.push({ filename: p.filename, rawText: text });
          }
        } catch (err) { /* 单个文件解析失败不影响其他 */ }
        pending--;
        if (pending === 0) {
          // —— Step 1：解析本次新导入的帖子 ——
          var newPosts = [];
          loadedArr.forEach(function (item) {
            var p = parseHpPost(item.filename, item.rawText);
            if (p) newPosts.push(p);
          });
          newPosts.sort(function (a, b) { return b.dateObj.getTime() - a.dateObj.getTime(); });

          // —— Step 2：帖子数组按 id 合并（新覆盖旧，追加不重叠），不再整数组覆盖 ——
          var postMap = {};
          if (Array.isArray(HpState.posts)) {
            HpState.posts.forEach(function (op) {
              if (op && op.id != null) postMap[op.id] = op;
            });
          }
          var addedCount = 0;   // 本次新增的不同 id
          var updatedCount = 0; // 本次覆盖了几个同名旧 id
          for (var i = 0; i < newPosts.length; i++) {
            var np = newPosts[i];
            if (!np || np.id == null) continue;
            if (postMap[np.id]) updatedCount++;
            else addedCount++;
            postMap[np.id] = np;
          }
          var mergedPosts = Object.keys(postMap).map(function (id) { return postMap[id]; });
          mergedPosts.sort(function (a, b) { return b.dateObj.getTime() - a.dateObj.getTime(); });
          HpState.posts = mergedPosts;

          // —— Step 3：__lastImportedRaw（导出 __all_posts__.js 用）也按 filename 合并 ——
          var rawMap = {};
          if (Array.isArray(HpState.__lastImportedRaw)) {
            HpState.__lastImportedRaw.forEach(function (or) {
              if (or && or.filename != null) rawMap[or.filename] = or;
            });
          }
          for (var j = 0; j < loadedArr.length; j++) {
            var nr = loadedArr[j];
            if (nr && nr.filename != null) rawMap[nr.filename] = nr;
          }
          var mergedRaw = Object.keys(rawMap).map(function (fn) { return rawMap[fn]; });
          HpState.__lastImportedRaw = mergedRaw;

          // —— Step 4：写 localStorage（**写合并后的 mergedRaw**，不是仅本次 loadedArr，刷新页面也不丢历史）
          try {
            localStorage.setItem("jfes_hp_posts_cache_v1", JSON.stringify(mergedRaw));
            var mfNames = mergedRaw.map(function (x) { return x.filename; });
            localStorage.setItem("jfes_hp_manifest", JSON.stringify(mfNames));
          } catch (eC) {}

          // —— Step 5：Toast 文案更清楚，区分新增 / 覆盖 ——
          if (typeof showToast === "function") {
            var msg = "";
            if (addedCount > 0 && updatedCount === 0) {
              msg = "已追加" + addedCount + "条帖子，共" + mergedPosts.length + "条";
            } else if (addedCount === 0 && updatedCount > 0) {
              msg = "已覆盖" + updatedCount + "条同名帖子";
            } else {
              msg = "追加" + addedCount + "条、覆盖" + updatedCount + "条，共" + mergedPosts.length + "条";
            }
            try { showToast(msg); } catch (eT) {}
          }
          if (alsoRender) renderHotspotAll();
        }
      };
      reader.onerror = function () { pending--; if (pending === 0 && alsoRender) renderHotspotAll(); };
      reader.readAsText(f, "utf-8");
    });
  }

  // 导出当前 HpState.posts 里的**全部帖子**为 __all_posts__.js，不再只导出最后一次拖入的那一批
  function hpExportAllPostsJs() {
    // 以 UI 上真实存在的 HpState.posts 为准（能看到几条，就导出几条）
    var arr = hpBuildAllPostsRawFromState();
    if (!arr || !arr.length) {
      if (typeof showToast === "function") { try { showToast("请先导入帖子文件，再导出 __all_posts__.js"); } catch (eT) {} }
      return;
    }
    // 转成 window.__ALL_HP_POSTS__ 格式：每个对象 {filename, raw: rawText}
    var obj = arr.map(function (x) {
      return { filename: String(x.filename || ""), raw: String(x.rawText || "") };
    });
    var code = "// 由 JFES 一键导出（file:// 模式下把此文件放到 hp/ 目录即可自动加载）\n"
             + "// 共导出 " + obj.length + " 条帖子\n"
             + "window.__ALL_HP_POSTS__ = " + JSON.stringify(obj, null, 2) + ";\n";
    var blob = new Blob([code], { type: "text/javascript;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "__all_posts__.js";
    document.body.appendChild(a);
    try { a.click(); } catch (_e) {}
    setTimeout(function () {
      try { document.body.removeChild(a); } catch (_e) {}
      try { URL.revokeObjectURL(url); } catch (_e) {}
    }, 1000);
    if (typeof showToast === "function") { try { showToast("已导出" + obj.length + "条帖子 → __all_posts__.js"); } catch (eT) {} }
  }

  // 刷新热点全部三列
  function renderHotspotAll() {
    if (!document.getElementById("view-hot")) return;
    injectIcons();
    // file:// 协议时显示"选择帖子文件 / 拖拽"面板；HTTP 且有 hp 内容时面板不显示
    var importBox = document.getElementById("hpLocalImport");
    if (importBox) {
      var isFile = window.location.protocol === "file:";
      // 有帖子时也允许面板显示方便 file:// 用户手动刷新缓存，HTTP 下默认隐藏
      importBox.hidden = !isFile;
    }
    renderHpList();
    renderHpDetail();
    renderHpComments();
  }

  function renderHpList() {
    var listEl = document.getElementById("hpListContainer");
    var countEl = document.getElementById("hpCount");
    if (!listEl) return;
    var kw = (HpState.searchText || "").trim().toLowerCase();
    var list = HpState.posts;
    if (kw) {
      list = list.filter(function (p) {
        if (p.title && p.title.toLowerCase().indexOf(kw) >= 0) return true;
        if (p.body && p.body.toLowerCase().indexOf(kw) >= 0) return true;
        // 搜作者名：遍历所有评论
        if (!p.comments || !p.comments.length) return false;
        var hit = false;
        (function walk(arr) {
          for (var i = 0; i < arr.length; i++) {
            if (arr[i].name && arr[i].name.toLowerCase().indexOf(kw) >= 0) { hit = true; return; }
            walk(arr[i].children);
            if (hit) return;
          }
        })(p.comments);
        return hit;
      });
    }
    // 更新搜索框 placeholder 显示帖子数量
    var searchInput = document.getElementById("hpSearchInput");
    if (searchInput) searchInput.placeholder = "搜索 " + list.length + " 个帖子";
    if (!HpState.posts.length) {
      listEl.innerHTML = '';
      return;
    }
    if (!list.length) {
      listEl.innerHTML = '';
      return;
    }
    // 若当前选中 id 不在过滤后列表里，自动清掉选中（避免详情残留显示非本筛选下的内容）
    if (HpState.selectedId) {
      var stillThere = list.some(function (x) { return x.id === HpState.selectedId; });
      if (!stillThere) HpState.selectedId = null;
    }
    // 若还没有选中，默认选最新一条（列表里的第 1 条）
    if (!HpState.selectedId && list.length) HpState.selectedId = list[0].id;

    var html = "";
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var sel = (p.id === HpState.selectedId) ? " selected" : "";
      html +=
        '<div class="hp-post-item' + sel + '" data-id="' + escapeHtml(p.id) + '">' +
          '<div class="hp-post-title">' + escapeHtml(p.title || "(无标题)") + '</div>' +
          '<div class="hp-post-meta">' +
            '<span>' + fmtHpDate(p.dateObj) + '</span>' +
            '<span>' + p.commentCount + '评论</span>' +
          '</div>' +
        '</div>';
    }
    listEl.innerHTML = html;
    // 移动端：如果 selectedId 已被清掉（搜索/筛选导致），自动从详情页切回列表页
    if (!HpState.selectedId) {
      var isMobileAuto = window.matchMedia("(max-width: 900px)").matches;
      if (isMobileAuto) {
        var hotViewAuto = document.getElementById("view-hot");
        if (hotViewAuto && hotViewAuto.classList.contains("hp-detail-mode")) {
          hotViewAuto.classList.remove("hp-detail-mode");
        }
      }
    }
  }

  // 正文分段：按空行（\n 之间含 0~N 空白字符）拆分段落，空段落去掉；没有空行时按单行切
  function hpSplitParagraphs(body) {
    var raw = String(body || "");
    if (!raw) return [];
    var blocks = raw.split(/\n\s*\n/).map(function (s) { return s.replace(/\u00a0/g, " ").replace(/[ \t]+$/gm, "").replace(/^[ \t]+/gm, ""); });
    // 如果按空行切出来只有一段，尝试按单换行切（防止有些正文没有空行分隔，导致整段不分）
    if (blocks.length <= 1 && raw.indexOf("\n") >= 0) {
      blocks = raw.split(/\r?\n/).map(function (s) { return s.replace(/\u00a0/g, " ").replace(/^\s+|\s+$/g, ""); });
    }
    return blocks.filter(function (s) { return s && s.trim().length; });
  }

  function renderHpDetail() {
    var emptyEl = document.getElementById("hpDetailEmpty");
    var boxEl = document.getElementById("hpDetailContainer");
    var headerTitleEl = document.getElementById("hpDetailHeaderTitle");
    var backBtn = document.getElementById("hpDetailBackBtn");
    if (!boxEl) return;
    var isMobile = window.matchMedia("(max-width: 900px)").matches;
    // 先重置 header
    if (headerTitleEl) headerTitleEl.textContent = "详情";
    if (backBtn) backBtn.hidden = true;
    var p = HpState.posts.find(function (x) { return x.id === HpState.selectedId; });
    if (!p) {
      if (emptyEl) emptyEl.hidden = false;
      boxEl.hidden = true;
      boxEl.innerHTML = "";
      hpUnbindDetailHeaderSync();
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    boxEl.hidden = false;
    // 移动端：固定显示「详情」+ 返回按钮，不滚动切换标题
    if (isMobile) {
      hpUnbindDetailHeaderSync();
      if (headerTitleEl) headerTitleEl.textContent = "详情";
      if (backBtn) {
        backBtn.hidden = false;
        // 手动注入返回图标（避免浏览器缓存导致 injectIcons 没注入）
        if (typeof window !== "undefined" && window.ICONS && window.ICONS.back) {
          if (!backBtn.innerHTML) backBtn.innerHTML = window.ICONS.back;
        } else if (!backBtn.innerHTML) {
          backBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
        }
      }
    }
    var paras = hpSplitParagraphs(p.body);
    var bodyHtml = "";
    if (paras.length) {
      bodyHtml = paras.map(function (t) { return "<p>" + escapeHtml(t) + "</p>"; }).join("");
    }
    boxEl.innerHTML =
      '<div class="hp-detail-title" data-origin-title="' + escapeHtml(p.title || "(无标题)") + '">' + escapeHtml(p.title || "(无标题)") + '</div>' +
      '<div class="hp-detail-meta"><span>' + escapeHtml(fmtHpDate(p.dateObj)) + '</span></div>' +
      '<div class="hp-detail-body">' + bodyHtml + '</div>';
    if (!isMobile) hpBindDetailHeaderSync(p);
  }

  // ====== 详情卡片：向下滚动时，如果大标题看不见，把卡片 header 文字改成帖子标题 ======
  // 注意：滚动容器不是 window，是详情卡片内部的 .list-wrap（home-card 内部独立 overflow auto）
  function hpBindDetailHeaderSync(currentPost) {
    hpUnbindDetailHeaderSync();
    var hotView = document.getElementById("view-hot");
    if (!hotView) return;
    var wrap = hotView.querySelector(".col-2 .list-wrap");
    var titleEl = hotView.querySelector(".hp-detail-title");
    var headerEl = document.getElementById("hpDetailHeaderTitle");
    if (!wrap || !titleEl || !headerEl) return;
    var originHeader = "详情";
    var postTitleRaw = titleEl.getAttribute("data-origin-title") || (currentPost && currentPost.title) || titleEl.textContent || "详情";
    HpState.__detailHeader = { wrap: wrap, titleEl: titleEl, headerEl: headerEl, postTitle: postTitleRaw, originHeader: originHeader };
    // rAF 节流：避免 scroll 高频触发 layout 抖动
    var ticking = false;
    var listener = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        if (!HpState.__detailHeader || HpState.__detailHeader.wrap !== wrap) return;
        // 关键守卫：首次绑定 scrollTop 可能为 0，此时 DOM 刚重建 layout 还可能不准
        // 只有滚动过一小段（>= 4px）才做切换判断，避免首次渲染误判
        var scrollY = wrap.scrollTop;
        if (scrollY < 4) {
          if (headerEl.textContent !== originHeader) headerEl.textContent = originHeader;
          return;
        }
        var titleBottom = titleEl.offsetTop + titleEl.offsetHeight;
        // 给 2px 容差：滚动超过标题底部 2 像素才切，避免临界抖动
        if (scrollY + 2 >= titleBottom) {
          if (headerEl.textContent !== postTitleRaw) headerEl.textContent = postTitleRaw;
        } else {
          if (headerEl.textContent !== originHeader) headerEl.textContent = originHeader;
        }
      });
    };
    wrap.addEventListener("scroll", listener, { passive: true });
    HpState.__detailHeader.listener = listener;
    // 双重 rAF：等待至少两帧让 layout + 字体加载完成
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { listener(); });
    });
  }

  function hpUnbindDetailHeaderSync() {
    if (HpState.__detailHeader && HpState.__detailHeader.wrap && HpState.__detailHeader.listener) {
      try { HpState.__detailHeader.wrap.removeEventListener("scroll", HpState.__detailHeader.listener); } catch (_e) {}
    }
    var headerEl = document.getElementById("hpDetailHeaderTitle");
    if (headerEl && headerEl.textContent !== "详情") headerEl.textContent = "详情";
    HpState.__detailHeader = null;
  }

  // 评论渲染：递归嵌套 children
  // 把整棵回复树（rootNode 下所有后代节点）按深度优先拍平为一维数组（顺序=原评论先后顺序：早→晚）
  function hpFlatAllReplies(rootNode) {
    var list = [];
    (function walk(children) {
      if (!children || !children.length) return;
      for (var i = 0; i < children.length; i++) {
        var node = children[i];
        list.push(node);
        walk(node.children);
      }
    })(rootNode.children || []);
    return list;
  }

  function renderHpCommentNode(node, isChild, opts) {
    opts = opts || {};
    var avatar = hpGetAvatar(node.name);
    var avatarStyle;
    if (avatar.indexOf("data:") === 0) {
      avatarStyle = "background-image:url('" + avatar + "');";
    } else {
      avatarStyle = "background-image:" + avatar + ";";
    }
    var itemClass = "hp-comment-item" + (isChild ? " hp-comment-child" : "");
    var textPrefixHtml = "";
    if (opts.detailMode && isChild && node.__replyToName) {
      // 「回复」2 个字用白色（不套 class，继承正文颜色），「@xxx：」黄色（仅 @ 高亮）
      textPrefixHtml = '回复<span class="hp-at-user">@' + escapeHtml(node.__replyToName) + '：</span>';
    }
    var childHtml = "";
    if (opts.skipChildren) {
      // 详情模式下：调用方自己 flat 后平级渲染回复，不需要在节点内部再生成任何嵌套 children 结构
      childHtml = "";
    } else if (!isChild && typeof opts.previewLimit === "number" && opts.previewLimit > 0) {
      // ========== 预览模式（灰块圆角矩形内）：不要层级，不要嵌套，只 flat 后取最早的 N 条平级展示 ==========
      var flat = hpFlatAllReplies(node);
      if (flat.length) {
        var previewNodes = flat.slice(0, opts.previewLimit);  // 最早 2 条，对应 B 站截图灰块里的前两条
        var sub = "";
        for (var k = 0; k < previewNodes.length; k++) {
          var n = previewNodes[k];
          // 头像样式（子评论灰块里隐藏了头像，但 DOM 还是保留正常结构）
          var avS = "";
          var av = hpGetAvatar(n.name);
          if (av.indexOf("data:") === 0) avS = "background-image:url('" + av + "');";
          else avS = "background-image:" + av + ";";
          sub += (
            '<div class="hp-comment-item hp-comment-child">' +
              '<div class="hp-comment-avatar" style="' + avS + '" data-name="' + escapeHtml(n.name) + '"></div>' +
              '<div class="hp-comment-main">' +
                '<div class="hp-comment-name">' + escapeHtml(n.name) + '</div>' +
                '<div class="hp-comment-text">' + escapeHtml(n.text || "") + '</div>' +
              '</div>' +
            '</div>'
          );
        }
        var moreHtml = (opts.moreBtnHtml) ? String(opts.moreBtnHtml) : "";
        childHtml = '<div class="hp-comment-children">' + sub + moreHtml + '</div>';
      } else if (opts.moreBtnHtml) {
        // 极端：flat 为空但有 more（totalSub > 0？hpCountAllChildren 保证不会）
        childHtml = '<div class="hp-comment-children">' + String(opts.moreBtnHtml) + '</div>';
      }
    } else if (node.children && node.children.length) {
      // ========== 其它场景：详情模式 & 子评论本身：保持原有递归 ==========
      var subList = node.children;
      var sub = "";
      for (var i = 0; i < subList.length; i++) {
        sub += renderHpCommentNode(subList[i], true, opts);
      }
      var moreHtml = (!isChild && opts.moreBtnHtml) ? String(opts.moreBtnHtml) : "";
      childHtml = '<div class="hp-comment-children">' + sub + moreHtml + '</div>';
    } else if (!isChild && opts.moreBtnHtml) {
      childHtml = '<div class="hp-comment-children">' + String(opts.moreBtnHtml) + '</div>';
    }
    return (
      '<div class="' + itemClass + '">' +
        '<div class="hp-comment-avatar" style="' + avatarStyle + '" data-name="' + escapeHtml(node.name) + '"></div>' +
        '<div class="hp-comment-main">' +
          '<div class="hp-comment-name">' + escapeHtml(node.name) + '</div>' +
          '<div class="hp-comment-text">' + textPrefixHtml + escapeHtml(node.text || "") + '</div>' +
          childHtml +
        '</div>' +
      '</div>'
    );
  }

  // 数整棵子树的回复节点总数（不含主评论本身）
  function hpCountAllChildren(node) {
    var total = 0;
    if (!node || !node.children || !node.children.length) return 0;
    for (var i = 0; i < node.children.length; i++) {
      total += 1 + hpCountAllChildren(node.children[i]);
    }
    return total;
  }

  // 递归给整棵树（rootNode 下的所有后代）挂 .__replyToName = 父节点 name
  function hpAttachReplyTo(node, parentName) {
    if (!node || !node.children) return;
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      child.__replyToName = parentName;   // 它 reply 到的对象就是它的父
      hpAttachReplyTo(child, child.name); // 它的 children 会 reply 到它自己
    }
  }

  function renderHpComments() {
    var emptyEl = document.getElementById("hpCommentEmpty");
    var boxEl = document.getElementById("hpCommentContainer");
    var headerTitleEl = document.getElementById("hpCommentHeaderTitle");
    var headerTextEl = document.getElementById("hpCommentHeaderText");  // 独立的标题文本 span，不会覆盖掉 count span
    var countEl = document.getElementById("hpCommentCount");
    var backBtn = document.getElementById("hpCommentBackBtn");
    if (!boxEl) return;
    var p = HpState.posts.find(function (x) { return x.id === HpState.selectedId; });
    var total = p ? p.commentCount : 0;
    // 切帖子 / 空帖时：把楼层详情 & 滚动还原相关 state 全部清空，避免串到其他帖子
    if (!p) {
      HpState.commentFloorIdx = null;
      HpState.commentScrollFloorToRestore = null;
      HpState.commentScrollTopBefore = 0;
    }
    if (countEl) countEl.textContent = "（" + total + "）";
    if (!p || !p.comments || !p.comments.length) {
      if (emptyEl) emptyEl.hidden = false;
      boxEl.hidden = true;
      boxEl.innerHTML = "";
      // ====== 空帖时：只改独立 headerTextEl 的文字，不再动 h2 的 textContent（防止 count span 被一并销毁）======
      if (headerTextEl) headerTextEl.textContent = "评论";
      if (headerTitleEl) headerTitleEl.classList.remove("center-title");
      if (countEl) countEl.hidden = false;
      if (backBtn) backBtn.hidden = true;
      HpState.commentFloorIdx = null;
      HpState.commentScrollFloorToRestore = null;
      HpState.commentScrollTopBefore = 0;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    boxEl.hidden = false;
    var isMobileRev = window.matchMedia("(max-width: 900px)").matches;
    // 桌面：reverse → 新的在上；移动端：保持原序 → 旧的在上
    var topLayer = isMobileRev ? p.comments.slice() : p.comments.slice().reverse();
    // ——— 楼层详情模式 ———
    if (HpState.commentFloorIdx != null && HpState.commentFloorIdx >= 0 && HpState.commentFloorIdx < topLayer.length) {
      var rootNode = topLayer[HpState.commentFloorIdx];
      hpAttachReplyTo(rootNode, rootNode.name);   // 所有子孙 replyTo = 父.name；root 的直接 children replyTo = 主评论人
      var totalReplies = hpCountAllChildren(rootNode);
      // 楼层详情：计数 = totalReplies（仅回复数，不含主评论本身，比原来少 1）
      var detailTotal = totalReplies;
      // Header：标题改成「回复（N）」居中，计数显示在标题后（替代原本被放在分割线上的「相关回复共x条」重复文案）
      if (headerTextEl) headerTextEl.textContent = "回复";
      if (headerTitleEl) headerTitleEl.classList.add("center-title");
      if (countEl) {
        countEl.textContent = "（" + detailTotal + "）";
        countEl.hidden = false;
      }
      if (backBtn) backBtn.hidden = false;

      // ====== 详情结构：主评论（带头像） + 无文字分割线 + 所有回复（平级、有头像、仅用「回复 @xxx：」表关系）======
      // ====== 「相关回复共x条」文字已删：标题后的 (N) 已经说明总数了，分割线只保留 1px 细线做视觉隔断 ======
      var rootHtml = renderHpCommentNode(rootNode, false, { detailMode: true, skipChildren: true });
      var dividerHtml = '<div class="hp-detail-divider hp-detail-divider-no-text"></div>';

      var flatReplies = hpFlatAllReplies(rootNode);
      var repliesHtml = "";
      for (var i = 0; i < flatReplies.length; i++) {
        repliesHtml += renderHpCommentNode(flatReplies[i], true, { detailMode: true, skipChildren: true });
      }

      boxEl.innerHTML = '<div class="hp-comment-list hp-detail-mode">' + rootHtml + dividerHtml + repliesHtml + '</div>';
      return;
    }
    // ——— 全评论视图（默认）———
    HpState.commentFloorIdx = null;
    // ====== 详情→返回列表：只改独立 headerTextEl 的文字，count span 全程没被 textContent 销毁，计数自动保留 ======
    if (headerTextEl) headerTextEl.textContent = "评论";
    if (headerTitleEl) headerTitleEl.classList.remove("center-title");
    if (countEl) countEl.hidden = false;
    if (backBtn) backBtn.hidden = true;
    var isMobileCm = window.matchMedia("(max-width: 900px)").matches;
    var html = "";
    for (var i = 0; i < topLayer.length; i++) {
      var node = topLayer[i];
      var totalSub = hpCountAllChildren(node);
      // 移动端：previewLimit=Infinity（全部展开，保持原圆角灰块嵌套结构），
      //         moreBtnHtml 保留「共x条回复」但去掉 data-floor-idx（不可点）
      // 桌面：previewLimit=2，moreBtnHtml 带 data-floor-idx（可点进楼层详情）
      var previewLimit = isMobileCm ? Infinity : 2;
      var moreBtnHtml = "";
      if (totalSub > 0) {
        if (isMobileCm) {
          moreBtnHtml = '<div class="hp-comment-more hp-comment-more-disabled">共' + totalSub + '条回复</div>';
        } else {
          moreBtnHtml = '<div class="hp-comment-more" data-floor-idx="' + i + '">共' + totalSub + '条回复</div>';
        }
      }
      html += renderHpCommentNode(node, false, { previewLimit: previewLimit, moreBtnHtml: moreBtnHtml });
    }
    boxEl.innerHTML = '<div class="hp-comment-list">' + html + '</div>';
    // ——— 还原滚动位置：从「评论详情」返回「全评论列表」时，定位回刚才点击的那条主评论 ———
    var wrap = boxEl.closest(".list-wrap");
    if (wrap && HpState.commentScrollFloorToRestore != null) {
      var targetIdx = HpState.commentScrollFloorToRestore;
      var moreEl = boxEl.querySelector('.hp-comment-more[data-floor-idx="' + targetIdx + '"]');
      var targetItem = moreEl ? moreEl.closest(".hp-comment-item") : null;
      if (targetItem && targetItem.offsetParent === boxEl.querySelector(".hp-comment-list")) {
        // 优先策略：把那条主评论精确滚到评论列顶部（8px 顶距，不贴 header）
        var topPad = 8;
        wrap.scrollTop = Math.max(0, targetItem.offsetTop - topPad);
      } else {
        // 兜底：找不到元素（极端情况），直接还原进入详情前的 list-wrap scrollTop 数值
        wrap.scrollTop = HpState.commentScrollTopBefore || 0;
      }
    }
    // 还原完就清，避免下次正常进入列表 / 换评论人时又被反复滚
    HpState.commentScrollFloorToRestore = null;
  }

  // ===== 热点：导入本地帖子（file:// 模式弹窗）=====
  // 复用项目已有的 modal-overlay 结构（和 openHomeLinkModal 完全一致的 DOM/动画/遮罩）
  function hpOpenImportModal() {
    if (document.getElementById("__hpImportOverlay")) return;
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "__hpImportOverlay";
    document.body.appendChild(overlay);

    overlay.innerHTML =
      '<div class="modal">' +
        '<h3>帖子管理</h3>' +
        '<label class="hp-local-drop" id="hpLocalDrop">' +
          '<div class="hp-local-drop-title"><strong>加载本地帖子</strong></div>' +
          '<div class="hp-local-drop-hint">' +
            '本地保存：点击选择/拖入<br>' +
            '自动保存：导出js文件并放入hp文件夹下' +
          '</div>' +
          '<input type="file" id="hpLocalFileInput" accept=".txt,.md,.text,.log" multiple hidden>' +
        '</label>' +
        '<div class="modal-actions">' +
          '<button class="glass-btn danger" data-action="clear">清除</button>' +
          '<button class="glass-btn" data-action="export">导出</button>' +
          '<button class="glass-btn" data-action="cancel">取消</button>' +
        '</div>' +
      '</div>';
    if (typeof injectIcons === "function") injectIcons();

    var closed = false;
    function close() { if (closed) return; closed = true; if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }

    // 导入文件、拖拽、导出、清除缓存功能，直接在动态创建的弹窗 DOM 上重新绑定（避免和原页面上的元素重复绑定）
    (function bindInsideModal() {
      var hpFileInput = overlay.querySelector("#hpLocalFileInput");
      var hpDrop = overlay.querySelector("#hpLocalDrop");
      if (hpFileInput) {
        hpFileInput.addEventListener("change", function (e) {
          var f = e.target && e.target.files;
          if (!f || !f.length) return;
          hpImportLocalFiles(f, true);
          hpFileInput.value = "";
        });
      }
      if (hpDrop) {
        ["dragenter", "dragover"].forEach(function (evName) {
          hpDrop.addEventListener(evName, function (e) {
            e.preventDefault(); e.stopPropagation();
            hpDrop.classList.add("hp-drag-over");
          });
        });
        ["dragleave", "drop"].forEach(function (evName) {
          hpDrop.addEventListener(evName, function (e) {
            e.preventDefault(); e.stopPropagation();
            hpDrop.classList.remove("hp-drag-over");
          });
        });
        hpDrop.addEventListener("drop", function (e) {
          var dt = e.dataTransfer;
          if (!dt) return;
          if (dt.files && dt.files.length) {
            var valid = [];
            for (var i = 0; i < dt.files.length; i++) {
              var ff = dt.files[i];
              if (!ff || !ff.name) continue;
              if (ff.type && /^(image|video|audio)\//.test(ff.type)) continue;
              var lower = String(ff.name).toLowerCase();
              if (!/\.(txt|md|text|log)$/i.test(lower)) {
                var base = lower.replace(/^.*[\\\/]/, "");
                if (!/^\d{8}-\d{4}$/.test(base)) continue;
              }
              valid.push(ff);
            }
            if (valid.length) hpImportLocalFiles(valid, true);
            else if (typeof showToast === "function") { try { showToast("请拖入帖子文本文件（.txt/.md 等）"); } catch (eT) {} }
          }
        });
      }
    })();

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) { close(); return; }
      var btn = e.target.closest("[data-action]");
      if (!btn) return;
      var act = btn.dataset.action;
      if (act === "cancel") { close(); return; }
      if (act === "export") { hpExportAllPostsJs(); return; }
      if (act === "clear") {
        try {
          localStorage.removeItem("jfes_hp_posts_cache_v1");
          localStorage.removeItem("jfes_hp_manifest");
        } catch (eC) {}
        HpState.__scanPromise = null;
        HpState.posts = [];
        HpState.selectedId = null;
        renderHpList();
        renderHpDetail();
        renderHpComments();
        if (typeof showToast === "function") { try { showToast("已清除本地帖子缓存"); } catch (eT) {} }
        return;
      }
    });
  }

  // 首页选数据弹窗：libCategory=链接库分类(people/projects/times)，bindingKey=homeBindings键(people/projects/calendar)
  function openHomeLinkModal(libCategory, bindingKey) {
    var lib = state.linkLibrary[libCategory] || [];
    var labels = { people: "人员", projects: "项目", times: "时间" };
    var current = state.homeBindings[bindingKey];
    // 无链接数据且无当前绑定时提示；有绑定但库为空时仍弹窗（用于清空）
    if (!lib.length && !current) { showToast("暂无" + (labels[libCategory] || "") + "链接数据，请先在设置页导入"); return; }
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
    function render() {
      var opts = lib.map(function (item) {
        var sel = item.id === current ? " active" : "";
        return '<div class="custom-select-option' + sel + '" data-id="' + item.id + '">' +
          '<span class="opt-name">' + escapeHtml(item.name) + '</span>' +
        '</div>';
      }).join("");
      var hasBinding = !!current;
      var clearBtn = hasBinding ?
        '<button class="glass-btn danger" data-action="clear">清空</button>' : "";
      overlay.innerHTML =
        '<div class="modal">' +
          "<h3>选择" + (labels[libCategory] || "") + "数据</h3>" +
          '<div class="link-pick-list">' +
            opts +
          '</div>' +
          '<div class="modal-actions">' +
            clearBtn +
            '<button class="glass-btn" data-action="cancel">取消</button>' +
          '</div>' +
        '</div>';
      if (typeof injectIcons === "function") injectIcons();
    }
    render();
    var closed = false;
    function close() { if (closed) return; closed = true; document.body.removeChild(overlay); }
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) { close(); return; }
      var btn = e.target.closest("[data-action]");
      if (btn) {
        if (btn.dataset.action === "cancel") { close(); return; }
        if (btn.dataset.action === "clear") {
          state.homeBindings[bindingKey] = null;
          save();
          renderHomeAll();
          close();
          return;
        }
      }
      var opt = e.target.closest("[data-id]");
      if (opt) {
        state.homeBindings[bindingKey] = opt.dataset.id;
        save();
        renderHomeAll();
        close();
        return;
      }
    });
  }

  // 项目卡片 → 日历日程链接弹窗
  // 项目-日程一一映射弹窗：先选日历，再给每个项目单独选日期
  function openProjectCalLinkModal() {
    var times = state.linkLibrary.times;
    var projectsItem = state.homeBindings.projects
      ? state.linkLibrary.projects.find(function (l) { return l.id === state.homeBindings.projects; })
      : null;

    if (!projectsItem || !projectsItem.items || !projectsItem.items.length) {
      showToast("请先链接项目数据");
      return;
    }
    if (!times || !times.length) {
      showToast("请先链接日程（时间）数据");
      return;
    }

    // 当前映射（深拷贝，便于编辑）
    var currentMap = state.homeProjectCalMap && state.homeProjectCalMap.calId
      ? { calId: state.homeProjectCalMap.calId,
          projectScheduleMap: Object.assign({}, state.homeProjectCalMap.projectScheduleMap || {}) }
      : { calId: times[0].id, projectScheduleMap: {} };
    var pendingCalId = currentMap.calId;
    var pendingMappings = Object.assign({}, currentMap.projectScheduleMap);

    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
    var closed = false;
    function close() { if (closed) return; closed = true; document.body.removeChild(overlay); }

    function getScheduleOptions(calItem, categoryFilter, codeToDesc) {
      var hintYear = new Date().getFullYear();
      var opts = [];
      var seen = {};
      var catDescSet = {};  // 统一收集中文备注（desc）分类
      // 将任何形式的分类值（代码/备注/空/未知）归一为"显示用备注"字符串
      function normCat(rawCat) {
        if (!rawCat) return "";
        rawCat = String(rawCat).trim();
        if (!rawCat) return "";
        if (codeToDesc && codeToDesc[rawCat]) return codeToDesc[rawCat];
        return rawCat;  // 未知分类（非 code，本身已经是 desc 或任意文本）原样返回
      }
      function add(dateStr, content, rawCategory) {
        if (!dateStr) return;
        var category = normCat(rawCategory);
        if (category) catDescSet[category] = true;
        // 筛选：只按"中文备注"分类名匹配，保证用户点选备注时能正确命中
        if (categoryFilter) {
          if (category !== categoryFilter) return;
        }
        if (seen[dateStr]) return;
        seen[dateStr] = true;
        opts.push({ date: dateStr, content: content || "", category: category });
      }
      var rawEntries = calItem.rawEntries || [];
      if (rawEntries.length) {
        rawEntries.forEach(function (entry) {
          if (entry.type === "schedule" && !entry.isContinuation)
            add(entry.date, entry.content, entry.category || "");
        });
      } else {
        (calItem.schedules || []).forEach(function (s) {
          add(s.date, s.content, s.category || "");
        });
      }
      // 按日期升序
      opts.sort(function (a, b) {
        var ra = resolveDate(a.date, hintYear);
        var rb = resolveDate(b.date, hintYear);
        if (!ra || !rb) return 0;
        var da = new Date(ra.year, ra.month - 1, ra.day);
        var db = new Date(rb.year, rb.month - 1, rb.day);
        return da - db;
      });
      return { opts: opts, catDescSet: catDescSet };
    }

    // ====== 构造合成式下拉选择器 ======
    // 返回 HTML 字符串，结构：
    //   [wrapContainer]
    //     label (if label)
    //     .custom-select[data-kind][data-row-index]
    //       button.custom-select-trigger
    //         label | chevron
    //       .custom-select-dropdown (hidden)
    //         options...
    function buildCustomSelect(cfg) {
      var opts = cfg.options || [];
      var current = cfg.currentValue != null ? String(cfg.currentValue) : "";
      var labelOpt = opts.find(function (o) { return String(o.value) === current; });
      if (!labelOpt && current === "" && opts.length) labelOpt = opts[0];
      var labelText = labelOpt ? labelOpt.label : (cfg.placeholder || "");
      var attrs = ' data-kind="' + escapeHtml(cfg.kind || "") + '"';
      if (cfg.rowIndex != null) attrs += ' data-row-index="' + cfg.rowIndex + '"';
      var bodyHtml =
        '<div class="custom-select"' + attrs + '>' +
          '<button type="button" class="custom-select-trigger">' +
            '<span class="custom-select-label">' + escapeHtml(labelText) + '</span>' +
            '<span class="custom-select-arrow" data-icon="chevron-down">' +
              (window.ICONS && window.ICONS["chevron-down"] ? window.ICONS["chevron-down"] : "") +
            '</span>' +
          '</button>' +
          '<div class="custom-select-dropdown" hidden>' +
            opts.map(function (o) {
              var val = String(o.value);
              var sel = val === current ? " active" : "";
              return '<div class="custom-select-option' + sel + '" data-value="' + escapeHtml(val) + '">' +
                '<span class="opt-name">' + escapeHtml(o.label) + '</span>' +
              '</div>';
            }).join("") +
          '</div>' +
        '</div>';
      if (cfg.wrapClass) {
        var labelHtml = cfg.label
          ? '<label class="cal-cat-label">' + escapeHtml(cfg.label) + '</label>'
          : "";
        return '<div class="' + cfg.wrapClass + '">' + labelHtml + bodyHtml + '</div>';
      }
      return bodyHtml;
    }

    // 当前分类筛选：空字符串=全部；其余为分类中文备注
    var categoryFilter = "";

    // 渲染与绑定
    function render() {
      var calItem = times.find(function (t) { return t.id === pendingCalId; }) || times[0];

      // 构建 code → desc 映射，并收集所有"显示用备注"
      // categories[].name = 代码/代号(如 A、B、DLC1)
      // categories[].desc = 中文备注(如 宣发、比赛、残奥会day1)
      var codeToDesc = {};
      var allCatNames = [];
      (calItem.categories || []).forEach(function (c) {
        if (!c || (!c.name && !c.desc)) return;
        var display = c.desc && c.desc.trim() ? c.desc.trim() : (c.name || "").trim();
        if (!display) return;
        if (c.name) codeToDesc[c.name.trim()] = display;
        if (c.desc) codeToDesc[c.desc.trim()] = display;  // 自指：用 desc 查也能命中
        if (allCatNames.indexOf(display) === -1) allCatNames.push(display);
      });

      // 用全部分类跑一次拿到真实出现的分类集合（归一到 desc 后）
      var fullResult = getScheduleOptions(calItem, "", codeToDesc);
      Object.keys(fullResult.catDescSet).forEach(function (n) {
        if (n && allCatNames.indexOf(n) === -1) allCatNames.push(n);
      });

      // 校验当前 categoryFilter 仍有效（切换日历可能造成不匹配），无效则重置
      if (categoryFilter && allCatNames.indexOf(categoryFilter) === -1) {
        categoryFilter = "";
      }

      // 按当前筛选取日程
      var filteredResult = getScheduleOptions(calItem, categoryFilter || undefined, codeToDesc);
      var schedOpts = filteredResult.opts;

      // 日历下拉（线性布局：顶部）
      var calOptions = times.map(function (t) {
        return { value: t.id, label: t.name };
      });
      var calSelectHtml = buildCustomSelect({
        wrapClass: "cal-cat-filter cal-calendar-row",
        label: "选择日历",
        kind: "calendar",
        options: calOptions,
        currentValue: pendingCalId,
        placeholder: "（未选择）"
      });

      // 分类筛选 HTML（在日历下拉之下）
      var catOptions = [{ value: "", label: "全部" }].concat(allCatNames.map(function (c) {
        return { value: c, label: c };
      }));
      var catFilterHtml = buildCustomSelect({
        wrapClass: "cal-cat-filter",
        label: "分类筛选",
        kind: "category",
        options: catOptions,
        currentValue: categoryFilter || "",
        placeholder: "全部"
      });

      // 每个项目行的下拉
      var projectRows = projectsItem.items.map(function (p, i) {
        var selected = pendingMappings[String(i)] || "";
        var selectedInList = schedOpts.some(function (s) { return s.date === selected; });
        var pOpts = [{ value: "", label: "-- 未选择 --" }].concat(
          schedOpts.map(function (s) {
            return {
              value: s.date,
              label: s.date + (s.content ? " · " + s.content : "")
            };
          })
        );
        if (selected && !selectedInList) {
          pOpts.push({ value: selected, label: selected + "（已选，不在当前筛选）" });
        }
        var schedSel = buildCustomSelect({
          wrapClass: "",
          label: "",
          kind: "schedule",
          options: pOpts,
          currentValue: selected || "",
          placeholder: "-- 未选择 --",
          rowIndex: i
        });
        return '<div class="cal-map-row">' +
          '<div class="cal-map-proj">' +
            '<span class="cal-map-proj-name">' + escapeHtml(p.name) + '</span>' +
            (p.tags && p.tags.length ? ' <span class="cal-map-proj-tags">' + escapeHtml(p.tags.join(" / ")) + '</span>' : '') +
          '</div>' +
          schedSel +
        '</div>';
      }).join("");

      var hasAny = Object.keys(pendingMappings).some(function (k) { return pendingMappings[k]; });
      var clearBtn = hasAny
        ? '<button class="glass-btn danger" data-action="clear">清空</button>'
        : "";

      overlay.innerHTML =
        '<div class="modal modal-cal-map modal-cal-map-linear">' +
          '<h3>日程链接</h3>' +
          '<div class="cal-map-single-col">' +
            calSelectHtml +
            catFilterHtml +
            '<h4>为每个项目选择对应日期</h4>' +
            '<div class="cal-map-rows">' + projectRows + '</div>' +
          '</div>' +
          '<div class="modal-actions">' +
            clearBtn +
            '<button class="glass-btn" data-action="cancel">取消</button>' +
            '<button class="glass-btn active" data-action="confirm">确定</button>' +
          '</div>' +
        '</div>';
      if (typeof injectIcons === "function") injectIcons();

      // ======= 合成式下拉：触发器点击 + 选项选择 =======
      overlay.querySelectorAll(".custom-select").forEach(function (cs) {
        var trigger = cs.querySelector(".custom-select-trigger");
        var panel = cs.querySelector(".custom-select-dropdown");
        if (!trigger || !panel) return;

        // 清除之前可能遗留的 fixed 定位内联样式，回归 CSS absolute（与 trigger 自然对齐）
        panel.style.position = "";
        panel.style.left = ""; panel.style.right = ""; panel.style.width = "";
        panel.style.top = ""; panel.style.bottom = ""; panel.style.maxHeight = "";
        panel.style.overflowY = ""; panel.style.zIndex = "";

        trigger.addEventListener("click", function (ev) {
          // 关闭其他已开的下拉（保持同一时间只开一个）
          overlay.querySelectorAll(".custom-select-dropdown").forEach(function (p) {
            if (p !== panel) p.hidden = true;
          });
          overlay.querySelectorAll(".custom-select.open").forEach(function (o) {
            if (o !== cs) o.classList.remove("open");
          });
          var willOpen = panel.hidden;
          if (willOpen) cs.classList.add("open"); else cs.classList.remove("open");
          panel.hidden = !panel.hidden;
          ev.stopPropagation();
        });
        panel.addEventListener("click", function (ev) {
          var opt = ev.target.closest(".custom-select-option");
          if (!opt) return;
          var val = opt.dataset.value;
          var kind = cs.dataset.kind;
          var labelEl = cs.querySelector(".custom-select-label");
          var text = (opt.querySelector(".opt-name") || opt).textContent;
          ev.stopPropagation();
          // 关闭所有下拉
          overlay.querySelectorAll(".custom-select-dropdown").forEach(function (p) { p.hidden = true; });
          overlay.querySelectorAll(".custom-select.open").forEach(function (o) { o.classList.remove("open"); });
          // 触发对应业务逻辑
          if (kind === "calendar") {
            pendingCalId = val;
            categoryFilter = "";
            saveMap();
            render();
          } else if (kind === "category") {
            categoryFilter = val || "";
            saveMap();
            render();
          } else if (kind === "schedule") {
            var idx = cs.dataset.rowIndex;
            if (val) pendingMappings[String(idx)] = val;
            else delete pendingMappings[String(idx)];
            // 仅 UI 局部刷新，不重渲染全部（避免每选个值重绘卡顿）
            if (labelEl) labelEl.textContent = text;
            cs.querySelectorAll(".custom-select-option").forEach(function (o) {
              o.classList.toggle("active", o.dataset.value === val);
            });
            // 全局清空按钮显示同步（重渲染以刷新列表）
            saveMap();
            var hasAny = Object.keys(pendingMappings).some(function (k) { return pendingMappings[k]; });
            var clrBtn = overlay.querySelector('[data-action="clear"]');
            var actionsEl = overlay.querySelector(".modal-actions");
            if (actionsEl) {
              var cancelB = actionsEl.querySelector('[data-action="cancel"]');
              if (hasAny && !clrBtn) {
                var b = document.createElement("button");
                b.className = "glass-btn danger";
                b.dataset.action = "clear";
                b.textContent = "清空";
                if (cancelB) actionsEl.insertBefore(b, cancelB);
                else actionsEl.appendChild(b);
              } else if (!hasAny && clrBtn) {
                clrBtn.remove();
              }
            }
          }
        });
      });
    }

    render();

    // 点击空白区域（不在任何下拉内） → 关闭所有打开的下拉
    overlay.addEventListener("click", function (e) {
      var inAnyDropdown = e.target.closest(".custom-select-dropdown, .custom-select-trigger");
      if (!inAnyDropdown) {
        overlay.querySelectorAll(".custom-select-dropdown").forEach(function (p) { p.hidden = true; });
        overlay.querySelectorAll(".custom-select.open").forEach(function (o) { o.classList.remove("open"); });
      }
      if (e.target === overlay) { close(); return; }
      var btn = e.target.closest("[data-action]");
      if (btn) {
        var act = btn.dataset.action;
        if (act === "cancel") { close(); return; }
        if (act === "clear") {
          pendingMappings = {};
          saveMap();
          render();
          return;
        }
        if (act === "confirm") {
          saveMap();
          close();
          return;
        }
      }
    });

    function saveMap() {
      var hasAny = Object.keys(pendingMappings).some(function (k) { return pendingMappings[k]; });
      if (hasAny) {
        state.homeProjectCalMap = { calId: pendingCalId, projectScheduleMap: pendingMappings };
      } else {
        state.homeProjectCalMap = null;
      }
      save();
      renderHomeProjects();
    }
  }

  function renderHomeAll() {
    renderHomePeople();
    renderHomeProjects();
    renderHomeCalendar();
    // 同步首页 4 个链接类按钮的激活黄色态：已绑定数据 → 加 .active（金色填充）
    var peopleBtn = $("#homePeopleBtn");
    if (peopleBtn) peopleBtn.classList.toggle("active", !!state.homeBindings.people);
    var calBtn = $("#homeCalendarBtn");
    if (calBtn) calBtn.classList.toggle("active", !!state.homeBindings.calendar);
    var projLinkBtn = $("#homeProjectsBtn");
    if (projLinkBtn) projLinkBtn.classList.toggle("active", !!state.homeBindings.projects);
    // 项目-日历联动按钮（原本已有 renderHomeProjects 内按 calResult 加 active，这里再以绑定为兜底保证一致）
    var projCalBtn = $("#homeProjectsCalBtn");
    if (projCalBtn) projCalBtn.classList.toggle("active", !!(state.homeProjectCalMap && state.homeProjectCalMap.calId));
  }

  function renderAll() {
    renderLists();
    renderCurrentList();
    renderMode();
    renderLinkDisplay();
    renderHomeAll();
  }

  // ===== 排行页：项目分榜列表渲染（数据源仍为 rankActiveProject，项右侧可链接项目类型名单）=====
  function renderRankPeople() {
    var container = $("#rankPeopleContainer");
    var count = $("#rankPeopleCount");
    var active = rankActiveProject();

    if (!active) {
      if (count) count.textContent = "";
      if (container) container.innerHTML = '';
      return;
    }

    // 兼容 items 为字符串数组或 {name, tags} 对象数组
    var items = active.items || [];
    if (count) count.textContent = "（" + items.length + "）";
    if (!container) return;

    if (!items.length) {
      container.innerHTML = '';
      return;
    }

    var html = "";
    items.forEach(function (it, i) {
      var name = (typeof it === "string") ? it : (it && it.name || "");
      // 总排行查看中不高亮分榜项
      var sel = (!state.rankOverallActive && name === state.rankSelectedProject) ? " selected" : "";
      html +=
        '<li class="person-item' + sel + '" data-index="' + i + '" data-name="' + escapeHtml(name) + '">' +
          '<span class="index">' + (i + 1) + '</span>' +
          '<span class="name">' + escapeHtml(name) + '</span>' +
        '</li>';
    });
    container.innerHTML = html;
  }

  // ===== 排行页：表格渲染 =====
  // 解析 TXT 文件格式：《项目名》开始一个区块，\r\n / \r / \n 分隔行，，；、 分隔列
  function parseRankTableTxt(text) {
    // 统一换行：\r\n → \n，\r → \n，\n 保持
    text = (text || "").replace(/\r\n|\r|\n/g, "\n").trim();
    if (!text) return {};
    var result = {};
    // 按《》分割：先找所有 《xxx》 的位置
    var sections = [];
    var re = /《([^》\n]+)》/g;
    var lastIndex = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      // 从上一个区块末尾到当前标题之间的内容归上一区块
      if (lastIndex > 0) {
        var prevBlock = text.slice(lastIndex, m.index).trim();
        if (prevBlock) {
          var prevRows = parseRowsFromBlock(prevBlock);
          if (prevRows.length) result[sections[sections.length - 1]] = prevRows;
        }
      }
      sections.push(m[1].trim());
      lastIndex = m.index + m[0].length;
    }
    // 最后一个区块
    if (lastIndex < text.length) {
      var lastBlock = text.slice(lastIndex).trim();
      if (lastBlock && sections.length) {
        var lastRows = parseRowsFromBlock(lastBlock);
        if (lastRows.length) result[sections[sections.length - 1]] = lastRows;
      }
    }
    return result;
  }
  // 辅助：把一个文本块按行 → 每行按 TAB / ， / ； / 、 拆成列数组
  function parseRowsFromBlock(block) {
    // 兜底：再次统一换行
    block = (block || "").replace(/\r\n|\r|\n/g, "\n");
    var rows = [];
    var lines = block.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      // 统一按分隔符 split：TAB 或 中文标点 都保留空列
      // 用正则把 TAB 和中文/英文标点都当作分隔符
      var cols = line.split(/\t|[，；、]/).map(function (s) { return s.trim(); });
      // 过滤整行为空的行（但保留中间和末尾的空列）
      var nonEmpty = cols.some(function (s) { return s !== ""; });
      if (!nonEmpty) continue;
      rows.push(cols);
    }
    return rows;
  }

  // 用二维数组构建成绩表格 HTML（第一行作为表头，含行/单元格配色规则）
  // useColumnColors=true（总排行）：按表头文本给整列配置基础文字颜色，行/单元格规则优先级更高
  function buildRankTableHtml(data, useColumnColors) {
    var cols = data[0].length;
    // 列级颜色（最低优先级）：金牌列→金，银牌列→银，铜牌列→铜，总数列→绿，悬赏列→紫
    var colColors = null;
    if (useColumnColors) {
      colColors = {};
      for (var hc = 0; hc < cols; hc++) {
        var h = String(data[0][hc] || "");
        if (h.indexOf("金牌") !== -1) colColors[hc] = "#ffd86b";
        else if (h.indexOf("银牌") !== -1) colColors[hc] = "#dcdcdc";
        else if (h.indexOf("铜牌") !== -1) colColors[hc] = "#e8a060";
        else if (h.indexOf("总数") !== -1) colColors[hc] = "#4ade80";
        else if (h.indexOf("悬赏") !== -1) colColors[hc] = "#c084fc";
      }
    }
    var html = '<table class="rank-table"><thead><tr>';
    for (var c = 0; c < cols; c++) {
      html += '<th>' + escapeHtml(data[0][c] || ("列" + (c + 1))) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (var r = 1; r < data.length; r++) {
      var rowCells = data[r].join(" ");
      var rowStyle = "";
      // 行级颜色（低优先级，单元格有胜/败时会被覆盖）
      if (rowCells.indexOf("未参赛") !== -1) rowStyle = " style=\"color:#ff6b6b\"";
      else if (rowCells.indexOf("金牌") !== -1) rowStyle = " style=\"color:#ffd86b;font-weight:600\"";
      else if (rowCells.indexOf("银牌") !== -1) rowStyle = " style=\"color:#dcdcdc;font-weight:600\"";
      else if (rowCells.indexOf("铜牌") !== -1) rowStyle = " style=\"color:#e8a060;font-weight:600\"";
      else if (rowCells.indexOf("第1名") !== -1) rowStyle = " style=\"color:#ffd86b;font-weight:600\"";
      html += '<tr' + rowStyle + '>';
      for (var c2 = 0; c2 < cols; c2++) {
        var cellVal = data[r][c2] || "";
        var cellStyle = "";
        // 单元格级颜色（最高优先级）：胜→绿，败或/→红
        if (cellVal === "胜") cellStyle = " style=\"color:#4ade80;font-weight:600\"";
        else if (cellVal === "败" || cellVal === "/") cellStyle = " style=\"color:#ff6b6b;font-weight:600\"";
        // 单元格颜色 > 行颜色 > 列颜色
        var colStyle = (colColors && colColors[c2]) ? " style=\"color:" + colColors[c2] + "\"" : "";
        var mergedStyle = cellStyle || rowStyle || colStyle;
        html += '<td' + mergedStyle + '>' + escapeHtml(cellVal) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  function renderRankTable() {
    var empty = $("#rankTableEmpty");
    var container = $("#rankTableContainer");
    if (!empty || !container) return;

    // 总排行模式：显示总榜 TXT 导入的数据
    if (state.rankOverallActive) {
      var overall = state.rankOverallData;
      if (!overall.length) {
        empty.hidden = false;
        container.hidden = true;
        empty.textContent = '';
        return;
      }
      empty.hidden = true;
      container.hidden = false;
      container.innerHTML = buildRankTableHtml(overall, true); // 总排行：按列配色
      return;
    }

    var project = state.rankSelectedProject;
    var data = project ? state.rankTableData[project] : null;

    if (!project || !data || !data.length) {
      empty.hidden = false;
      container.hidden = true;
      if (!project) empty.textContent = '';
      else if (!data || !data.length) empty.textContent = '';
      return;
    }

    empty.hidden = true;
    container.hidden = false;
    container.innerHTML = buildRankTableHtml(data);
  }

  function selectRankItem(name) {
    if (!name) {
      state.rankSelectedProject = null;
      save();
      renderRankPeople();
      renderRankTable();
      return;
    }
    // 检查当前项目下是否存在此名称
    var active = rankActiveProject();
    if (!active) return;
    var items = active.items || [];
    var exists = items.some(function (it) {
      var n = (typeof it === "string") ? it : (it && it.name || "");
      return n === name;
    });
    if (!exists) return;
    state.rankSelectedProject = name;
    state.rankOverallActive = false; // 切到分榜时退出总排行模式
    save();
    renderRankOverallItem();
    renderRankPeople();
    renderRankTable();
    updateRankImportBtnState();
    // 移动端：进成绩详情页（清 rank-board-mode 防冲突）
    if (window.matchMedia("(max-width: 900px)").matches) {
      var rankView = document.getElementById("view-rank");
      if (rankView) {
        rankView.classList.remove("rank-board-mode");
        rankView.classList.add("rank-detail-mode");
      }
      var eye = document.getElementById("rankBoardEyeBtn");
      if (eye) eye.hidden = true;
      var bb = document.getElementById("rankBoardBackBtn");
      if (bb) bb.hidden = true;
      var db = document.getElementById("rankDetailBackBtn");
      if (db) db.hidden = false;
    }
  }

  // 选中总排行（总榜卡片内编号 0 项）：第2列表格切换为总榜数据
  function selectRankOverall() {
    state.rankOverallActive = true;
    save();
    renderRankOverallItem();
    renderRankPeople();
    renderRankTable();
    // 移动端：进成绩详情页（清 rank-board-mode 防冲突）
    if (window.matchMedia("(max-width: 900px)").matches) {
      var rankView = document.getElementById("view-rank");
      if (rankView) {
        rankView.classList.remove("rank-board-mode");
        rankView.classList.add("rank-detail-mode");
      }
      var eye = document.getElementById("rankBoardEyeBtn");
      if (eye) eye.hidden = true;
      var bb = document.getElementById("rankBoardBackBtn");
      if (bb) bb.hidden = true;
      var db = document.getElementById("rankDetailBackBtn");
      if (db) db.hidden = false;
    }
  }

  function renderRankAll() {
    renderRankOverallItem();
    renderRankPeople();
    renderRankTable();
    updateRankImportBtnState();
    renderRankBoards();
  }

  // ===== 排行页右列：水军榜 / 关怀榜（统计热点页所有帖子）=====
  // 水军榜 = 主评论（顶层节点）次数；关怀榜 = 评论下所有子孙回复（任意深度）次数
  // 直接展示完整排名（按次数降序），列表内部滚动；两榜各占卡片 50% 高度
  function computeHpRankBoards() {
    var commentCount = {};
    var replyCount = {};
    HpState.posts.forEach(function (post) {
      (post.comments || []).forEach(function (root) {
        var rn = root.name || "匿名";
        commentCount[rn] = (commentCount[rn] || 0) + 1;
        (function walk(arr) {
          (arr || []).forEach(function (child) {
            var cn = child.name || "匿名";
            replyCount[cn] = (replyCount[cn] || 0) + 1;
            walk(child.children);
          });
        })(root.children);
      });
    });
    function fullList(map) {
      return Object.keys(map)
        .map(function (k) { return { name: k, count: map[k] }; })
        .sort(function (a, b) { return b.count - a.count; });
    }
    return { comments: fullList(commentCount), replies: fullList(replyCount) };
  }

  function renderRankBoardList(ul, entries) {
    if (!ul) return;
    if (!entries.length) {
      ul.innerHTML = '';
      return;
    }
    var html = "";
    entries.forEach(function (e, i) {
      // 复用 hpGetAvatar：加 hp-comment-avatar 类 + data-name，真实头像加载完成后会被自动刷新
      var avatar = hpGetAvatar(e.name);
      var bg = avatar.indexOf("data:") === 0 ? "url('" + avatar + "')" : avatar;
      html += '<li class="rank-board-item' + (i === 0 ? " top1" : "") + '">' +
        '<span class="rank-board-idx">' + (i + 1) + '</span>' +
        '<span class="rank-board-avatar hp-comment-avatar" data-name="' + escapeHtml(e.name) + '" style="background-image:' + bg + ';"></span>' +
        '<span class="rank-board-name">' + escapeHtml(e.name) + '</span>' +
        '<span class="rank-board-count">' + e.count + '</span>' +
      '</li>';
    });
    ul.innerHTML = html;
  }

  function renderRankBoards() {
    var commentUl = $("#rankCommentBoard");
    var replyUl = $("#rankReplyBoard");
    if (!commentUl && !replyUl) return;
    var boards = computeHpRankBoards();

    // 移动端：合并两榜为一个综合榜
    if (window.matchMedia("(max-width: 900px)").matches) {
      // 隐藏关怀榜 board
      var replyBoard = replyUl ? replyUl.closest(".rank-board") : null;
      if (replyBoard) replyBoard.style.display = "none";
      // 隐藏综合榜标题行（简化移动端）
      var title = commentUl ? commentUl.closest(".rank-board").querySelector(".rank-board-title") : null;
      if (title) title.style.display = "none";
      // 合并数据：按人名合并 count = comments + replies
      var mergedMap = {};
      boards.comments.forEach(function (c) { mergedMap[c.name] = (mergedMap[c.name] || 0) + c.count; });
      boards.replies.forEach(function (r) { mergedMap[r.name] = (mergedMap[r.name] || 0) + r.count; });
      var mergedList = Object.keys(mergedMap)
        .map(function (k) { return { name: k, count: mergedMap[k] }; })
        .sort(function (a, b) { return b.count - a.count; });
      renderRankBoardList(commentUl, mergedList);
      return;
    }
    // 桌面端：恢复隐藏状态 + 分别渲染
    var replyBoard2 = replyUl ? replyUl.closest(".rank-board") : null;
    if (replyBoard2 && replyBoard2.style.display === "none") replyBoard2.style.display = "";
    var title2 = commentUl ? commentUl.closest(".rank-board").querySelector(".rank-board-title") : null;
    if (title2) {
      title2.textContent = "水军榜";
      if (title2.style.display === "none") title2.style.display = "";
    }
    renderRankBoardList(commentUl, boards.comments);
    renderRankBoardList(replyUl, boards.replies);
  }

  // 总排行项选中态（总榜卡片内唯一项，编号 0）
  function renderRankOverallItem() {
    var item = document.querySelector("#rankOverallList .person-item");
    if (!item) return;
    item.classList.toggle("selected", state.rankOverallActive === true);
  }

  // 当有表格数据可用时（当前选中项目有数据 或 全局 rankTableData 非空），按钮变黄色；
  // 总榜/项目卡片的链接按钮：各自有链接数据时变黄色
  function updateRankImportBtnState() {
    var btn = $("#rankImportTxtBtn");
    if (btn) {
      var hasAnyData = Object.keys(state.rankTableData).length > 0;
      var active = state.rankSelectedProject && !!state.rankTableData[state.rankSelectedProject];
      btn.classList.toggle("active", !!(hasAnyData || active));
    }
    var overallBtn = $("#rankOverallLinkBtn");
    if (overallBtn) {
      overallBtn.classList.toggle("active", state.rankOverallData.length > 0);
    }
    var projLinkBtn = $("#rankProjLinkBtn");
    if (projLinkBtn) {
      projLinkBtn.classList.toggle("active", !!rankActiveProject());
    }
  }

  // 排行页表格数据管理弹窗：选择 TXT 文件、导入、清空
  function openRankTableDataModal() {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".txt";
    fileInput.style.display = "none";

    function render() {
      var keys = Object.keys(state.rankTableData);
      var listHtml = "";
      if (!keys.length) {
        listHtml = '<div class="link-pick-empty">暂无表格数据，请点击下方「选择 TXT」导入</div>';
      } else {
        listHtml = keys.map(function (k) {
          var hasMedal = state.rankTableData[k].some(function (row) {
            var cells = row.join(" ");
            return cells.indexOf("金牌") !== -1 || cells.indexOf("银牌") !== -1 || cells.indexOf("铜牌") !== -1 || cells.indexOf("第1名") !== -1 || cells.indexOf("未参赛") !== -1 || cells.indexOf("胜") !== -1 || cells.indexOf("败") !== -1;
          });
          var rowCount = state.rankTableData[k].length - 1; // 减去表头
          var sel = (k === state.rankSelectedProject) ? " active" : "";
          var medalBadge = hasMedal ? ' <span style="color:#ffd86b">★</span>' : '';
          return '<div class="custom-select-option' + sel + '" data-project="' + escapeHtml(k) + '">' +
            '<span class="opt-name">' + escapeHtml(k) + medalBadge + '</span>' +
            '<span class="opt-count" style="color:var(--muted);font-size:11px;margin-left:auto;">' + rowCount + ' 行</span>' +
          '</div>';
        }).join("");
      }

      var hasData = keys.length > 0;
      var clearBtn = hasData ?
        '<button class="glass-btn danger" data-action="clear-all">清空全部</button>' : "";

      overlay.innerHTML =
        '<div class="modal">' +
          "<h3>成绩表格数据管理</h3>" +
          '<div class="link-pick-list">' +
            listHtml +
          '</div>' +
          '<div class="modal-actions">' +
            clearBtn +
            '<button class="glass-btn active" data-action="pick-file">选择 TXT</button>' +
            '<button class="glass-btn" data-action="cancel">取消</button>' +
          '</div>' +
        '</div>';
      if (typeof injectIcons === "function") injectIcons();
    }

    render();

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function importFile(file) {
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (evt) {
        var text = evt.target.result || "";
        var parsed = parseRankTableTxt(text);
        var keys = Object.keys(parsed);
        if (!keys.length) {
          showToast("TXT 解析失败：未找到有效项目区块", "error");
          return;
        }
        for (var k in parsed) {
          if (parsed.hasOwnProperty(k)) state.rankTableData[k] = parsed[k];
        }
        save();
        // 自动选中第一个匹配当前名单的项目
        var active = rankActiveProject();
        if (active) {
          var firstMatch = keys.find(function (k) {
            var items = active.items || [];
            return items.some(function (it) {
              var n = (typeof it === "string") ? it : (it && it.name || "");
              return n === k;
            });
          });
          if (firstMatch) {
            selectRankItem(firstMatch);
          } else {
            renderRankTable();
          }
        }
        updateRankImportBtnState();
        showToast("已导入 " + keys.length + " 个项目的表格数据", "success");
      };
      reader.onerror = function () {
        showToast("文件读取失败", "error");
      };
      reader.readAsText(file, "utf-8");
    }

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) { close(); return; }
      var btn = e.target.closest("[data-action]");
      if (btn) {
        var action = btn.dataset.action;
        if (action === "cancel") { close(); return; }
        if (action === "pick-file") {
          fileInput.value = "";
          fileInput.click();
          return;
        }
        if (action === "clear-all") {
          openConfirmModal("清空表格数据", "确定清空全部 " + Object.keys(state.rankTableData).length + " 个项目的成绩表格？此操作不可恢复。", "清空", true).then(function (ok) {
            if (!ok) return;
            state.rankTableData = {};
            state.rankSelectedProject = null;
            save();
            renderRankTable();
            updateRankImportBtnState();
            render(); // 重新渲染弹窗
          });
          return;
        }
      }
      var opt = e.target.closest("[data-project]");
      if (opt) {
        var projectName = opt.dataset.project;
        selectRankItem(projectName);
        close();
        return;
      }
    });

    fileInput.addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      importFile(file);
      // 导入后重新渲染弹窗，让用户看到最新状态
      setTimeout(render, 100);
    });
  }

  // ===== 总榜数据管理弹窗：TXT 格式与成绩读取一致，但第 1 行标题无视 =====
  function parseOverallTxt(text) {
    text = (text || "").replace(/\r\n|\r|\n/g, "\n").trim();
    if (!text) return [];
    var lines = text.split("\n");
    // 第 1 行（首个非空行）为标题，无视
    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].trim()) { start = i + 1; break; }
    }
    if (start < 0 || start >= lines.length) return [];
    return parseRowsFromBlock(lines.slice(start).join("\n"));
  }

  function openRankOverallModal() {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".txt";
    fileInput.style.display = "none";

    function render() {
      var hasData = state.rankOverallData.length > 0;
      var listHtml = hasData ?
        '<div class="custom-select-option">' +
          '<span class="opt-name">总排行</span>' +
          '<span class="opt-count" style="color:var(--muted);font-size:11px;margin-left:auto;">' + (state.rankOverallData.length - 1) + ' 行</span>' +
        '</div>' :
        '<div class="link-pick-empty">暂无总排行数据，请点击下方「选择 TXT」导入</div>';
      var clearBtn = hasData ?
        '<button class="glass-btn danger" data-action="clear-all">清空</button>' : "";

      overlay.innerHTML =
        '<div class="modal">' +
          "<h3>总排行数据管理</h3>" +
          '<div class="link-pick-list">' + listHtml + '</div>' +
          '<div class="modal-actions">' +
            clearBtn +
            '<button class="glass-btn active" data-action="pick-file">选择 TXT</button>' +
            '<button class="glass-btn" data-action="cancel">取消</button>' +
          '</div>' +
        '</div>';
      if (typeof injectIcons === "function") injectIcons();
    }

    render();

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function importFile(file) {
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (evt) {
        var rows = parseOverallTxt(evt.target.result || "");
        if (!rows.length) {
          showToast("TXT 解析失败：标题行后未找到有效表格数据", "error");
          return;
        }
        state.rankOverallData = rows;
        state.rankOverallActive = true; // 导入后自动查看总排行
        save();
        renderRankAll();
        showToast("已导入总排行数据（" + (rows.length - 1) + " 行）", "success");
      };
      reader.onerror = function () {
        showToast("文件读取失败", "error");
      };
      reader.readAsText(file, "utf-8");
    }

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) { close(); return; }
      var btn = e.target.closest("[data-action]");
      if (!btn) return;
      var action = btn.dataset.action;
      if (action === "cancel") { close(); return; }
      if (action === "pick-file") {
        fileInput.value = "";
        fileInput.click();
        return;
      }
      if (action === "clear-all") {
        openConfirmModal("清空总排行数据", "确定清空已导入的总排行表格？此操作不可恢复。", "清空", true).then(function (ok) {
          if (!ok) return;
          state.rankOverallData = [];
          save();
          renderRankAll();
          render(); // 重新渲染弹窗
        });
      }
    });

    fileInput.addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      importFile(file);
      setTimeout(render, 100);
    });
  }

  // ===== 项目卡片右上角链接弹窗：链接项目类型名单（作为分榜数据源，替代原下拉选择）=====
  function openRankProjectLinkModal() {
    var lib = state.linkLibrary.projects || [];
    var current = state.rankActiveProjectId;
    if (!lib.length && !current) {
      showToast("暂无项目链接数据，请先在设置页导入");
      return;
    }

    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);

    function render() {
      var opts = lib.map(function (item) {
        var sel = item.id === current ? " active" : "";
        return '<div class="custom-select-option' + sel + '" data-id="' + item.id + '">' +
          '<span class="opt-name">' + escapeHtml(item.name) + '</span>' +
        '</div>';
      }).join("");
      var clearBtn = current ?
        '<button class="glass-btn danger" data-action="clear">清空</button>' : "";
      overlay.innerHTML =
        '<div class="modal">' +
          "<h3>链接项目名单</h3>" +
          '<div class="link-pick-list">' + opts + '</div>' +
          '<div class="modal-actions">' +
            clearBtn +
            '<button class="glass-btn" data-action="cancel">取消</button>' +
          '</div>' +
        '</div>';
      if (typeof injectIcons === "function") injectIcons();
    }

    render();

    var closed = false;
    function close() { if (closed) return; closed = true; document.body.removeChild(overlay); }

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) { close(); return; }
      var btn = e.target.closest("[data-action]");
      if (btn) {
        if (btn.dataset.action === "cancel") { close(); return; }
        if (btn.dataset.action === "clear") {
          state.rankActiveProjectId = null;
          state.rankSelectedProject = null;
          save();
          renderRankAll();
          close();
          return;
        }
      }
      var opt = e.target.closest("[data-id]");
      if (opt) {
        state.rankActiveProjectId = opt.dataset.id;
        state.rankSelectedProject = null; // 切换名单后重置选中分榜
        save();
        renderRankAll();
        close();
        return;
      }
    });
  }

  // ===== 名单操作 =====
  function createList(name) {
    name = (name || "").trim();
    if (!name) { showToast("名单名称不能为空"); return null; }
    if (name.length > 50) { showToast("名称过长（最多 50 字）"); return null; }
    var list = { id: uid(), name: name, people: [], removedPool: [] };
    state.lists.push(list);
    state.activeListId = list.id;
    save();
    renderAll();
    showToast("已创建名单「" + name + "」");
    return list;
  }

  // ===== 链接库文件解析（4 分类）=====
  // 通用：首行标题，其后按 \n 收集 rest
  function parseLinesTxt(text) {
    text = (text || "").replace(/\r\n?/g, "\n");
    var lines = text.split("\n");
    var name = "", rest = [], nameFound = false;
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t) continue;
      if (!nameFound) { name = t; nameFound = true; }
      else rest.push(t);
    }
    if (!name) return null;
    return { name: name, rest: rest };
  }
  // 人员/抽签：每行或 ，、/ 分隔
  function parsePeopleTxt(text) {
    var p = parseLinesTxt(text);
    if (!p) return null;
    var items = [];
    p.rest.forEach(function (line) {
      line.split(/[，、/]/).forEach(function (s) {
        s = s.trim();
        if (s) items.push(s);
      });
    });
    return { name: p.name, items: items };
  }
  // 项目：每行或 ，、/ 分隔，项目名后 (tag、tag) 或（tag、tag）
  function parseProjectsTxt(text) {
    var p = parseLinesTxt(text);
    if (!p) return null;
    var items = [];
    p.rest.forEach(function (line) {
      // 按行内 ，、/ 分隔项目，但括号()（）内的 、 属于标签分隔，不在此拆分
      var segs = [];
      var depth = 0;
      var cur = "";
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch === "(" || ch === "（") { depth++; cur += ch; }
        else if (ch === ")" || ch === "）") { if (depth > 0) depth--; cur += ch; }
        else if (depth === 0 && (ch === "，" || ch === "、" || ch === "/")) {
          if (cur.trim()) segs.push(cur);
          cur = "";
        } else { cur += ch; }
      }
      if (cur.trim()) segs.push(cur);
      segs.forEach(function (seg) {
        seg = seg.trim();
        if (!seg) return;
        // 匹配半角 () 或全角 （）
        var m = seg.match(/^([^()（）]*?)[(（]([^)）]*)[)）]$/);
        if (m) {
          var projName = m[1].trim();
          var tags = m[2].split(/[、]/).map(function (t) { return t.trim(); }).filter(function (t) { return t; });
          items.push({ name: projName || seg, tags: tags });
        } else {
          items.push({ name: seg, tags: [] });
        }
      });
    });
    return { name: p.name, items: items };
  }
  // 时间：中间行 [日期]日程[分类] 或 【日期】日程【分类】，末行 [分类#色号]说明 或 【分类#色号】说明（可多个）
  function parseTimesTxt(text) {
    var p = parseLinesTxt(text);
    if (!p) return null;
    var schedules = [], categories = [];
    var last = p.rest.length ? p.rest[p.rest.length - 1] : "";

    // 提取最后一行中所有 [分类#色号]说明 对
    var catRegex = /[\[【]([A-Za-z0-9]+)(?:#([0-9a-fA-F]{3,8}))?[\]】]([^\[【]+)?/g;
    var catMatch;
    var lastIsCatLine = false;
    while ((catMatch = catRegex.exec(last)) !== null) {
      var catName = catMatch[1].trim();
      var catColor = (catMatch[2] || "").trim();
      var catDesc = (catMatch[3] || "").trim();
      if (catName) {
        categories.push({
          name: catName,
          color: catColor || "#4caf50",
          desc: catDesc
        });
        lastIsCatLine = true;
      }
    }

    // 构建分类映射：code → { name, color, desc }
    var catMap = {};
    categories.forEach(function (c) {
      catMap[c.name] = c;
    });

    // 解析日程行（除去最后一行分类定义）
    var scheduleLines = lastIsCatLine ? p.rest.slice(0, -1) : p.rest;

    // 先收集所有行的日程/空/续接信息
    // 结构：{ date, type: 'schedule'|'continuation'|'empty', content?, category? }
    var rawEntries = [];
    scheduleLines.forEach(function (line) {
      // 去除全角空格和普通空格
      var trimmed = line.trim();
      if (!trimmed) return;

      // 尝试匹配 [日期]日程内容[分类]（正常日程）
      var smFull = trimmed.match(/^[\[【]([^\]】]+)[\]】](.+?)[\[【]([^\]】]+)[\]】]$/);
      if (smFull) {
        rawEntries.push({
          date: smFull[1].trim(),
          type: "schedule",
          content: smFull[2].trim(),
          category: smFull[3].trim()
        });
        return;
      }

      // 尝试匹配 [日期]~（续接日程）
      var smCont = trimmed.match(/^[\[【]([^\]】]+)[\]】]\s*~\s*$/);
      if (smCont) {
        rawEntries.push({
          date: smCont[1].trim(),
          type: "continuation"
        });
        return;
      }

      // 尝试匹配 [日期]日程（日程无分类，或日程以~开头表示续接）
      var smPartial = trimmed.match(/^[\[【]([^\]】]+)[\]】](.+)$/);
      if (smPartial) {
        var content = smPartial[2].trim();
        if (content === "~") {
          rawEntries.push({
            date: smPartial[1].trim(),
            type: "continuation"
          });
        } else {
          rawEntries.push({
            date: smPartial[1].trim(),
            type: "schedule",
            content: content,
            category: ""
          });
        }
        return;
      }

      // 尝试匹配 [日期]（空日程）
      var smDateOnly = trimmed.match(/^[\[【]([^\]】]+)[\]】]\s*$/);
      if (smDateOnly) {
        rawEntries.push({
          date: smDateOnly[1].trim(),
          type: "empty"
        });
        return;
      }
    });

    // 处理续接日程：往前回溯找到最近的非续接、非空日程
    rawEntries.forEach(function (entry, idx) {
      if (entry.type === "continuation") {
        // 往前找最近的 schedule 类型
        for (var j = idx - 1; j >= 0; j--) {
          if (rawEntries[j].type === "schedule") {
            entry.type = "schedule";
            entry.content = rawEntries[j].content;
            entry.category = rawEntries[j].category;
            entry.isContinuation = true;
            break;
          }
        }
      }
    });

    // 将原始条目转换为输出格式
    rawEntries.forEach(function (entry) {
      if (entry.type === "schedule") {
        // 查找分类的完整信息
        var catInfo = catMap[entry.category] || null;
        schedules.push({
          date: entry.date,
          content: entry.content,
          category: catInfo ? (catInfo.desc || entry.category) : entry.category,
          categoryCode: entry.category,
          isContinuation: !!entry.isContinuation
        });
      }
      // empty 类型的条目不加入 schedules（渲染时由空日程合并处理）
    });

    return { name: p.name, schedules: schedules, categories: categories, rawEntries: rawEntries };
  }
  function parseDrawsTxt(text) { return parsePeopleTxt(text); }

  // 将条目加入链接库：同名条目已存在则替换（清理旧绑定/关联名单），否则新增
  function upsertLink(type, item) {
    var arr = state.linkLibrary[type];
    var idx = arr.findIndex(function (l) { return l.name === item.name; });
    if (idx >= 0) {
      var old = arr[idx];
      // 清理首页绑定，重新指向新条目
      var bMap = { people: "people", projects: "projects", times: "calendar" };
      var bk = bMap[type];
      if (bk && state.homeBindings[bk] === old.id) state.homeBindings[bk] = item.id;
      // 抽签：删除旧关联名单
      if (type === "draws" && old.listId) {
        state.lists = state.lists.filter(function (l) { return l.id !== old.listId; });
        if (state.activeListId === old.listId) {
          state.activeListId = state.lists[0] ? state.lists[0].id : null;
        }
      }
      arr[idx] = item;
    } else {
      arr.push(item);
    }
  }

  // 删除链接库条目：同时清理首页绑定和抽签关联名单
  function deleteLink(type, id) {
    var arr = state.linkLibrary[type];
    var item = arr.find(function (l) { return l.id === id; });
    if (!item) return;
    state.linkLibrary[type] = arr.filter(function (l) { return l.id !== id; });
    var bMap = { people: "people", projects: "projects", times: "calendar" };
    var bk = bMap[type];
    if (bk && state.homeBindings[bk] === id) state.homeBindings[bk] = null;
    if (type === "draws" && item.listId) {
      state.lists = state.lists.filter(function (l) { return l.id !== item.listId; });
      if (state.activeListId === item.listId) {
        state.activeListId = state.lists[0] ? state.lists[0].id : null;
      }
    }
    save();
    renderAll();
    showToast("已删除链接数据「" + item.name + "」");
  }

  // 按分类导入链接库
  function importLink(type, text) {
    var parsed, item;
    if (type === "people" || type === "draws") {
      parsed = parsePeopleTxt(text);
      if (!parsed) { showToast("格式错误：第 1 行应为标题"); return null; }
      if (!parsed.items.length) { showToast("未识别到项"); return null; }
      item = { id: uid(), name: parsed.name, items: parsed.items, linked: true };
      if (type === "draws") {
        var list = { id: uid(), name: parsed.name, people: parsed.items.slice(), removedPool: [], linked: true };
        state.lists.push(list);
        item.listId = list.id;
      }
      upsertLink(type, item);
    } else if (type === "projects") {
      parsed = parseProjectsTxt(text);
      if (!parsed) { showToast("格式错误：第 1 行应为标题"); return null; }
      if (!parsed.items.length) { showToast("未识别到项目"); return null; }
      item = { id: uid(), name: parsed.name, items: parsed.items, linked: true };
      upsertLink(type, item);
    } else if (type === "times") {
      parsed = parseTimesTxt(text);
      if (!parsed) { showToast("格式错误：第 1 行应为标题"); return null; }
      if (!parsed.schedules.length) { showToast("未识别到日程"); return null; }
      item = { id: uid(), name: parsed.name, schedules: parsed.schedules, categories: parsed.categories, rawEntries: parsed.rawEntries, linked: true };
      upsertLink(type, item);
    } else { showToast("未知分类"); return null; }
    save();
    renderAll();
    var labels = { people: "人员", projects: "项目", times: "时间", draws: "抽签" };
    showToast("已链接" + (labels[type] || "") + "「" + item.name + "」");
    return item;
  }

  // 添加链接：选分类弹窗（选文件后弹窗选择 人员/项目/时间/抽签）
  function openLinkCategoryModal(filename, text) {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
    var categories = [
      { key: "people", label: "人员" },
      { key: "projects", label: "项目" },
      { key: "times", label: "时间" },
      { key: "draws", label: "抽签" }
    ];
    var selected = "people";
    function render() {
      var opts = categories.map(function (c) {
        return '<label class="link-cat-option' + (c.key === selected ? " active" : "") + '">' +
          '<input type="radio" name="linkcat" value="' + c.key + '"' + (c.key === selected ? " checked" : "") + ">" +
          "<span>" + c.label + "</span>" +
          "</label>";
      }).join("");
      overlay.innerHTML =
        '<div class="modal">' +
          "<h3>选择分类导入</h3>" +
          '<div class="link-cat-file">文件：' + escapeHtml(filename) + "</div>" +
          '<div class="link-cat-grid">' + opts + "</div>" +
          '<div class="modal-actions">' +
            '<button class="glass-btn" data-action="cancel">取消</button>' +
            '<button class="glass-btn active" data-action="confirm">确认导入</button>' +
          "</div>" +
        "</div>";
    }
    render();
    var closed = false;
    function close() { if (closed) return; closed = true; document.body.removeChild(overlay); }
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) { close(); return; }
      var opt = e.target.closest(".link-cat-option");
      if (opt) {
        var input = opt.querySelector("input");
        if (input) { selected = input.value; render(); }
        return;
      }
      var btn = e.target.closest("[data-action]");
      if (!btn) return;
      if (btn.dataset.action === "cancel") close();
      else if (btn.dataset.action === "confirm") {
        importLink(selected, text);
        close();
      }
    });
  }

  function renameList(id, newName) {
    newName = (newName || "").trim();
    if (!newName) { showToast("名称不能为空"); return; }
    if (newName.length > 50) { showToast("名称过长（最多 50 字）"); return; }
    var list = state.lists.find(function (l) { return l.id === id; });
    if (!list) return;
    list.name = newName;
    save();
    renderAll();
  }
  function selectList(id) {
    if (!state.lists.find(function (l) { return l.id === id; })) return;
    state.activeListId = id;
    state.activeDrawLink = null;
    save();
    renderAll();
  }

  function selectDrawLink(id, type) {
    var valid = false;
    if (type === "draws") {
      valid = !!(state.linkLibrary.draws && state.linkLibrary.draws.find(function (l) { return l.id === id; }));
    } else {
      // 默认 people 分类（保持旧调用兼容）
      valid = !!(state.linkLibrary.people && state.linkLibrary.people.find(function (l) { return l.id === id; }));
    }
    if (!valid) return;
    state.activeDrawLink = id;
    state.activeListId = null;
    // 清理 draw 缓存以便 activeList() 重新构建（切换到不同类型链接时保证干净）
    drawLinkSession.id = null;
    drawLinkSession.obj = null;
    save();
    renderAll();
  }

  // ===== 人员操作 =====
  function batchAddPeople(text) {
    var list = activeList();
    if (!list) { showToast("请先选择名单"); return; }
    var names = (text || "")
      .split(/[\n,，;；\t]/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    if (!names.length) { showToast("未识别到有效人名"); return; }
    list.people = list.people.concat(names);
    save();
    renderCurrentList();
    renderLists();
    showToast("已添加 " + names.length + " 人");
  }
  function updatePerson(index, newName) {
    var list = activeList();
    if (!list) return false;
    newName = (newName || "").trim();
    if (!newName) { showToast("名字不能为空"); return false; }
    if (newName.length > 60) { showToast("名字过长"); return false; }
    if (index < 0 || index >= list.people.length) return false;
    list.people[index] = newName;
    save();
    renderCurrentList();
    renderLists();
    return true;
  }
  function deletePerson(index) {
    var list = activeList();
    if (!list) return;
    if (index < 0 || index >= list.people.length) return;
    list.people.splice(index, 1);
    save();
    renderCurrentList();
    renderLists();
  }

  // ===== Modal：编辑人员（与名单编辑弹窗一致的样式）=====
  function openEditPeopleModal() {
    var list = activeList();
    if (!list) { showToast("请先选择名单"); return; }
    // 编辑时用完整名单：当前池 + 已暂移的合并；
    // 否则 cycle/list 抽走几人后编辑器看不到完整名单，会表现成 "名单为空" 或丢了人。
    var editingRemoved = list.removedPool ? list.removedPool.slice() : [];
    var editingPeople = list.people.concat(editingRemoved);
    if (!editingPeople.length) { showToast("名单为空，无法编辑"); return; }
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);

    function commitEdits(finalOrdered) {
      // 编辑结果统一写回：
      // 1. 本地名单 / 链接会话缓存：people = 最终顺序，removedPool 清空
      list.people = finalOrdered.slice();
      list.removedPool = [];
      drawSnapshot = null;  // 旧快照基于上一次顺序失效，下次 draw 重建
      // 2. 若是链接名单：同步写回源 link.items，保证编辑结果后续重新切链接也存在
      if (list.isLink) {
        var srcLink = state.linkLibrary.people.find(function (l) { return l.id === list.id; });
        if (srcLink) srcLink.items = finalOrdered.slice();
        // 同时使链接缓存失效，下次 activeList() 重切时使用新源数据
        drawLinkSession.id = null;
        drawLinkSession.obj = null;
      }
      save();
      renderCurrentList();
      renderLists();
    }

    function renderContent() {
      var html =
        '<div class="modal">' +
          '<h3>编辑人员</h3>' +
          '<ul class="edit-list">';
      editingPeople.forEach(function (p, i) {
        html +=
          '<li data-index="' + i + '" draggable="true">' +
            '<span class="name">' + escapeHtml(p) + '</span>' +
            '<span class="drag-handle" title="拖动排序">' + ICONS.menu + '</span>' +
            '<span class="actions">' +
              '<button data-action="rename" title="重命名">' + ICONS.pencil + '</button>' +
              '<button class="danger" data-action="delete" title="删除">' + ICONS.close + '</button>' +
            '</span>' +
          '</li>';
      });
      html +=
        '</ul>' +
        '<div class="modal-actions">' +
          '<button class="glass-btn active" data-action="close">关闭</button>' +
        '</div>' +
      '</div>';
      overlay.innerHTML = html;
      attachDragSort(overlay.querySelector(".edit-list"), function (li) { return li.dataset.index; }, function (indices) {
        editingPeople = indices.map(function (i) { return editingPeople[i]; });
        commitEdits(editingPeople);
        renderContent();
      });
    }
    renderContent();

    var closed = false;
    function close() { if (closed) return; closed = true; document.body.removeChild(overlay); }

    overlay.addEventListener("click", async function (e) {
      if (e.target === overlay) { close(); return; }
      var btn = e.target.closest("[data-action]");
      if (!btn) return;
      var action = btn.dataset.action;
      var li = btn.closest("li");
      var idx = li ? parseInt(li.dataset.index, 10) : -1;

      if (action === "close") {
        commitEdits(editingPeople);
        close();
      } else if (action === "rename" && idx >= 0) {
        var oldName = editingPeople[idx];
        var nameEl = li.querySelector(".name");
        var actionsEl = li.querySelector(".actions");
        if (nameEl) nameEl.style.display = "none";
        if (actionsEl) actionsEl.style.display = "none";
        var input = document.createElement("input");
        input.type = "text";
        input.className = "edit-input";
        input.value = oldName;
        input.maxLength = 60;
        li.insertBefore(input, nameEl);
        input.focus();
        input.select();
        var done = false;
        function commit() {
          if (done) return;
          done = true;
          var newName = input.value.trim();
          if (newName && newName !== oldName) editingPeople[idx] = newName;
          commitEdits(editingPeople);
          renderContent();
        }
        function cancel() {
          if (done) return;
          done = true;
          renderContent();
        }
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        });
        input.addEventListener("blur", commit);
      } else if (action === "delete" && idx >= 0) {
        var name = editingPeople[idx];
        if (name === undefined) return;
        var ok = await openConfirmModal(
          "删除人员",
          "确定删除「" + name + "」？不可恢复。",
          "删除",
          true
        );
        if (!ok) return;
        editingPeople.splice(idx, 1);
        commitEdits(editingPeople);
        if (!editingPeople.length) {
          close();
          showToast("名单已清空");
        } else {
          renderContent();
        }
      }
    });
  }

  function enterPeopleRenameMode(li, idx, refresh) {
    var list = activeList();
    if (!list) return;
    var name = list.people[idx];
    if (name === undefined) return;
    var nameEl = li.querySelector(".name");
    var actionsEl = li.querySelector(".actions");
    nameEl.style.display = "none";
    actionsEl.style.display = "none";
    var input = document.createElement("input");
    input.type = "text";
    input.className = "edit-input";
    input.value = name;
    input.maxLength = 60;
    li.insertBefore(input, nameEl);
    input.focus();
    input.select();

    var done = false;
    function commit() {
      if (done) return;
      done = true;
      var newName = input.value.trim();
      if (newName && newName !== name) {
        updatePerson(idx, newName);
      }
      refresh();
    }
    function cancel() {
      if (done) return;
      done = true;
      refresh();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
  }

  // ===== 抽取 =====
  // 按抽取前的原始顺序还原人员，避免 removedPool（抽取顺序）打乱名单
  function restorePeopleOrder(list) {
    var total = list.people.length + ((list.removedPool && list.removedPool.length) || 0);
    if (drawSnapshot && drawSnapshot.id === list.id && drawSnapshot.order && drawSnapshot.order.length === total) {
      list.people = drawSnapshot.order.slice();
      list.removedPool = [];
      return true;
    }
    return false;
  }
  function draw() {
    if (spinning) return;
    var list = activeList();
    if (!list) { showToast("请先选择名单"); return; }
    if (!list.people.length) { showToast("名单为空"); return; }

    // 保存原始顺序快照：仅在新一轮开始（removedPool 为空）时设，
    // cycle 模式一轮内多次 draw 不覆盖，保证抽完一轮还原时顺序正确
    if (!list.removedPool || !list.removedPool.length) {
      drawSnapshot = { id: list.id, order: list.people.slice() };
    }

    // 列表模式：启动 n 连抽
    if (state.mode === "list") {
      startListDraw(list);
      return;
    }

    clearWinEffect();

    var people = list.people.slice();
    spinning = true;
    var drawBtn = $("#drawBtn");
    if (drawBtn) {
      drawBtn.disabled = true;
      drawBtn.textContent = "抽取中…";
    }

    // 5 秒减速滚动动画：起始 30ms（快速），末段 240ms（卡顿逼近）
    var totalDuration = 5000;
    var startTime = Date.now();
    function tick() {
      var elapsed = Date.now() - startTime;
      if (elapsed >= totalDuration) {
        finishDraw(list, people);
        return;
      }
      var progress = elapsed / totalDuration;
      var delay = 30 + Math.pow(progress, 2) * 210;  // 30ms → 240ms
      renderResult(people[Math.floor(Math.random() * people.length)], false);
      setTimeout(tick, delay);
    }
    tick();
  }

  // ===== 列表模式：n 连抽 =====
  function startListDraw(list) {
    // 重置名单（恢复已移除的人员，确保 n 连抽完整）
    if (list.removedPool && list.removedPool.length) {
      list.people = list.people.concat(list.removedPool);
      list.removedPool = [];
    }
    // 重设快照为还原后的完整名单，保证抽取完成还原时顺序正确
    drawSnapshot = { id: list.id, order: list.people.slice() };
    // 初始化列表结果
    state.lastListResult = [];
    save();
    renderListResult();
    renderThirdColumn();   // ← 实时刷新右上角『列表 (N)』计数（清空时计数归 0）
    renderCurrentList();
    renderLists();

    spinning = true;
    var drawBtn = $("#drawBtn");
    if (drawBtn) {
      drawBtn.disabled = true;
      drawBtn.textContent = "抽取中…";
    }
    drawListOnce(list);
  }

  function drawListOnce(list) {
    if (!list.people.length) {
      // 全部抽完，恢复名单
      spinning = false;
      var drawBtn = $("#drawBtn");
      if (drawBtn) {
        drawBtn.disabled = false;
        drawBtn.textContent = "再抽一次";
      }
      if (list.removedPool && list.removedPool.length) {
        if (!restorePeopleOrder(list)) {
          list.people = list.removedPool.slice();
          list.removedPool = [];
        }
        save();
        renderCurrentList();
        renderLists();
      }
      showToast("列表抽取完成，共 " + state.lastListResult.length + " 名");
      return;
    }
    clearWinEffect();
    var people = list.people.slice();
    // 列表模式动画时长减半：2.5 秒
    var totalDuration = 2500;
    var startTime = Date.now();
    function tick() {
      var elapsed = Date.now() - startTime;
      if (elapsed >= totalDuration) {
        finishListDrawOnce(list, people);
        return;
      }
      var progress = elapsed / totalDuration;
      var delay = 30 + Math.pow(progress, 2) * 210;  // 30ms → 240ms
      renderResult(people[Math.floor(Math.random() * people.length)], false);
      setTimeout(tick, delay);
    }
    tick();
  }

  function finishListDrawOnce(list, people) {
    var idx = Math.floor(Math.random() * people.length);
    var chosen = people[idx];

    renderResult(chosen, true);

    // 绿光效果（列表模式缩短为 1.5 秒，绿光结束后自动续抽）
    clearWinEffect();
    var resultEl = $("#result");
    var drawBtn = $("#drawBtn");
    if (resultEl) resultEl.classList.add("win");
    if (drawBtn) drawBtn.classList.add("win");

    // 加入列表结果
    var rank = state.lastListResult.length + 1;
    state.lastListResult.push({
      person: chosen,
      rank: rank,
      time: new Date().toLocaleString("zh-CN")
    });

    // 从名单移除（循环模式行为）
    var realIdx = list.people.indexOf(chosen);
    if (realIdx >= 0) {
      list.people.splice(realIdx, 1);
      if (!Array.isArray(list.removedPool)) list.removedPool = [];
      list.removedPool.push(chosen);
    }

    save();
    renderCurrentList();
    renderLists();
    renderListResult();
    renderThirdColumn();   // ← 实时刷新右上角『列表 (N)』计数（每出 1 名结果计数 +1）

    var glowDuration = 1500;
    if (list.people.length > 0) {
      // 绿光结束后继续下一轮抽取
      winTimer = setTimeout(function () {
        if (resultEl) resultEl.classList.remove("win");
        if (drawBtn) drawBtn.classList.remove("win");
        winTimer = null;
        drawListOnce(list);
      }, glowDuration);
    } else {
      // 全部抽完，恢复名单
      winTimer = setTimeout(function () {
        if (resultEl) resultEl.classList.remove("win");
        if (drawBtn) drawBtn.classList.remove("win");
        winTimer = null;
        spinning = false;
        if (drawBtn) {
          drawBtn.disabled = false;
          drawBtn.textContent = "再抽一次";
        }
        if (list.removedPool && list.removedPool.length) {
          if (!restorePeopleOrder(list)) {
            list.people = list.removedPool.slice();
            list.removedPool = [];
          }
          save();
          renderCurrentList();
          renderLists();
        }
        showToast("列表抽取完成，共 " + state.lastListResult.length + " 名");
      }, glowDuration);
    }
  }

  function clearWinEffect() {
    var resultEl = $("#result");
    var drawBtn = $("#drawBtn");
    if (resultEl) resultEl.classList.remove("win");
    if (drawBtn) drawBtn.classList.remove("win");
    if (winTimer) {
      clearTimeout(winTimer);
      winTimer = null;
    }
  }

  function finishDraw(list, people) {
    var idx = Math.floor(Math.random() * people.length);
    var chosen = people[idx];
    spinning = false;
    var drawBtn = $("#drawBtn");
    if (drawBtn) drawBtn.textContent = "再抽一次";
    renderResult(chosen, true);

    // 抽中后绿色显眼效果，5 秒
    clearWinEffect();
    var resultEl = $("#result");
    if (resultEl) resultEl.classList.add("win");
    if (drawBtn) drawBtn.classList.add("win");
    winTimer = setTimeout(function () {
      if (resultEl) resultEl.classList.remove("win");
      if (drawBtn) drawBtn.classList.remove("win");
      winTimer = null;
    }, 5000);

    var mode = state.mode;

    if (mode === "single" || mode === "cycle") {
      var realIdx = list.people.indexOf(chosen);
      if (realIdx >= 0) {
        list.people.splice(realIdx, 1);
        if (mode === "cycle") {
          if (!Array.isArray(list.removedPool)) list.removedPool = [];
          list.removedPool.push(chosen);
          if (!list.people.length && list.removedPool.length) {
            if (!restorePeopleOrder(list)) {
              list.people = list.removedPool.slice();
              list.removedPool = [];
            }
            showToast("本轮已抽完，名单已自动重置");
          }
        } else if (!list.people.length) {
          showToast("名单已抽空");
        }
      }
      save();
      renderCurrentList();
      renderLists();
    } else {
      // repeat 模式：临时高亮抽中的人员
      if (drawBtn) drawBtn.disabled = false;
      var items = $("#peopleContainer").querySelectorAll(".person-item");
      var highlightIdx = list.people.indexOf(chosen);
      items.forEach(function (el, i) {
        el.classList.toggle("highlight", i === highlightIdx);
        if (i === highlightIdx) {
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      });
      setTimeout(function () {
        items.forEach(function (el) { el.classList.remove("highlight"); });
      }, 2800);
    }

    state.history.push({
      listName: list.name,
      person: chosen,
      time: new Date().toLocaleString("zh-CN")
    });
    if (state.history.length > 100) state.history.shift();
    save();
    renderThirdColumn();
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    // 自定义下拉（名单选择）
    var listSelectWrap = $("#listSelectWrap");
    var listSelectTrigger = $("#listSelectTrigger");
    var listSelectDropdown = $("#listSelectDropdown");
    if (listSelectTrigger && listSelectWrap) {
      listSelectTrigger.addEventListener("click", function (e) {
        e.stopPropagation();
        var isOpen = !listSelectDropdown.hidden;
        if (isOpen) {
          listSelectDropdown.hidden = true;
          listSelectWrap.classList.remove("open");
        } else {
          listSelectDropdown.hidden = false;
          listSelectWrap.classList.add("open");
        }
      });
      // 点击外部关闭下拉
      document.addEventListener("click", function (e) {
        if (!listSelectWrap.contains(e.target)) {
          listSelectDropdown.hidden = true;
          listSelectWrap.classList.remove("open");
        }
      });
    }
    if (listSelectDropdown) {
      listSelectDropdown.addEventListener("click", function (e) {
        var option = e.target.closest(".custom-select-option");
        if (!option) return;
        var id = option.dataset.id;
        var source = option.dataset.source;
        if (id) {
          if (source === "people-link") {
            selectDrawLink(id, "people");
          } else if (source === "draw-link") {
            selectDrawLink(id, "draws");
          } else {
            selectList(id);
          }
          listSelectDropdown.hidden = true;
          listSelectWrap.classList.remove("open");
        }
      });
    }

    var newListBtn = $("#newListBtn");
    if (newListBtn) {
      newListBtn.addEventListener("click", async function () {
        var name = await openPromptModal("新建名单", "", "请输入名单名称");
        if (name === null) return;
        createList(name);
      });
    }

    // 数据链接：选 txt → 弹窗选分类 → 导入链接库
    var linkAddBtn = $("#linkAddBtn");
    var linkFileInput = $("#linkFileInput");
    if (linkAddBtn && linkFileInput) {
      linkAddBtn.addEventListener("click", function () {
        linkFileInput.click();
      });
      linkFileInput.addEventListener("change", function () {
        var file = this.files && this.files[0];
        this.value = ""; // 允许再次选择同一文件（FileReader 已持有 file 引用）
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          openLinkCategoryModal(file.name, String(reader.result || ""));
        };
        reader.onerror = function () { showToast("读取文件失败"); };
        reader.readAsText(file, "utf-8");
      });
    }

    // 数据链接面板：委托处理删除按钮
    var linkDisplay = $("#linkDisplay");
    if (linkDisplay) {
      linkDisplay.addEventListener("click", async function (e) {
        var delBtn = e.target.closest("[data-del]");
        if (!delBtn) return;
        var type = delBtn.dataset.del;
        var id = delBtn.dataset.id;
        var item = state.linkLibrary[type] && state.linkLibrary[type].find(function (l) { return l.id === id; });
        if (!item) return;
        var ok = await openConfirmModal("删除链接数据", "确定删除「" + item.name + "」？", "删除", true);
        if (ok) deleteLink(type, id);
      });
    }

    // 版本信息面板：显示 C1/C2/HP 版本号
    function updateVersionInfo() {
      var types = ["C1", "C2", "HP"];
      types.forEach(function (type) {
        var el = document.getElementById("version" + type);
        if (!el) return;
        var ver = localStorage.getItem("jfes_data_" + type + "_version");
        el.textContent = ver ? ("v" + ver) : "未导入";
      });
    }
    updateVersionInfo();

    // 首页 3 卡片：点击右上角 ＋ 弹窗选择链接库数据
    var homePeopleBtn = $("#homePeopleBtn");
    if (homePeopleBtn) {
      homePeopleBtn.addEventListener("click", function () { openHomeLinkModal("people", "people"); });
    }
    var homeCalendarBtn = $("#homeCalendarBtn");
    if (homeCalendarBtn) {
      homeCalendarBtn.addEventListener("click", function () { openHomeLinkModal("times", "calendar"); });
    }
    // 日历卡片右上角「今天」按钮（刷新图标 ↻）：立即跳回今天，同步刷新黄框 + 项目刻度条
    var homeCalendarTodayBtn = $("#homeCalendarTodayBtn");
    if (homeCalendarTodayBtn) {
      homeCalendarTodayBtn.addEventListener("click", function () {
        var n = new Date();
        var newKey = n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0");
        if (state.calendar.selectedDate === newKey) return;
        state.calendar.selectedDate = newKey;
        save();
        renderHomeCalendar();
        renderHomeProjects();
      });
    }
    var homeProjectsBtn = $("#homeProjectsBtn");
    if (homeProjectsBtn) {
      homeProjectsBtn.addEventListener("click", function () { openHomeLinkModal("projects", "projects"); });
    }
    var homeProjectsCalBtn = $("#homeProjectsCalBtn");
    if (homeProjectsCalBtn) {
      homeProjectsCalBtn.addEventListener("click", openProjectCalLinkModal);
    }

    var editListsBtn = $("#editListsBtn");
    if (editListsBtn) {
      editListsBtn.addEventListener("click", openEditListsModal);
    }

    var addPersonBtn = $("#addPersonBtn");
    if (addPersonBtn) {
      addPersonBtn.addEventListener("click", async function () {
        var list = activeList();
        if (!list) { showToast("请先选择名单"); return; }
        var text = await openBatchModal("添加人员");
        if (text === null) return;
        batchAddPeople(text);
      });
    }

    var editPeopleBtn = $("#editPeopleBtn");
    if (editPeopleBtn) {
      editPeopleBtn.addEventListener("click", openEditPeopleModal);
    }

    var drawBtn = $("#drawBtn");
    if (drawBtn) {
      drawBtn.addEventListener("click", draw);
    }
    // 点击中间问号/抽取结果（#result）也能触发抽取（替代原隐藏的开始抽取按钮）
    var resultEl = document.getElementById("result");
    if (resultEl) {
      resultEl.addEventListener("click", function () {
        // 与 drawBtn 等价：抽取中禁止重复点击（已有 spinning=true return + CSS pointer-events:none 双重保险）
        draw();
      });
    }

    var modeSelector = $("#modeSelector");
    if (modeSelector) {
      modeSelector.addEventListener("click", function (e) {
        var btn = e.target.closest("button[data-mode]");
        if (!btn) return;
        // 抽取中禁止切换模式，防止状态错乱
        if (spinning) {
          showToast("抽取中，请稍候");
          return;
        }
        var mode = btn.dataset.mode;
        var modeChanged = mode !== state.mode;

        // 点击循环 / 列表时直接重置列表：把 removedPool 中所有已移除人员还原回 people
        if (mode === "cycle" || mode === "list") {
          var list = activeList();
          if (list && list.removedPool && list.removedPool.length) {
            var restored = list.removedPool.length;
            if (!restorePeopleOrder(list)) {
              list.people = list.people.concat(list.removedPool);
              list.removedPool = [];
            }
            save();
            renderCurrentList();
            renderLists();
            showToast("已重置名单，恢复 " + restored + " 人");
          }
        }

        if (!modeChanged) return;
        state.mode = mode;
        save();
        renderMode();
        renderThirdColumn();   // ← 切换模式后立即同步右上角标题（历史/列表）+ 计数数据源切换
        renderCurrentList();
        showToast("已切换为「" + MODE_NAMES[mode] + "」模式");
      });
    }

    var clearHistoryBtn = $("#clearHistoryBtn");
    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener("click", async function () {
        if (spinning) { showToast("抽取中，请稍候"); return; }
        // 只有列表模式下按钮才可见（历史模式 hidden=true）
        if (state.mode !== "list") return;
        if (!state.lastListResult || !state.lastListResult.length) {
          showToast("暂无列表结果可分享");
          return;
        }
        var text = state.lastListResult.map(function (r) {
          return r.rank + "." + r.person;
        }).join("\n");
        try {
          await navigator.clipboard.writeText(text);
          showToast("已复制列表结果到剪贴板");
        } catch (e) {
          // 降级方案
          var textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          try {
            document.execCommand("copy");
            showToast("已复制列表结果到剪贴板");
          } catch (e2) {
            showToast("复制失败，请手动复制");
          }
          document.body.removeChild(textarea);
        }
      });
    }

    // 热点模块交互：帖子列表点击 + 搜索框输入
    (function bindHpEvents() {
      var listEl = document.getElementById("hpListContainer");
      if (listEl && !listEl.__hpBound) {
        listEl.__hpBound = true;
        listEl.addEventListener("click", function (e) {
          var item = e.target.closest(".hp-post-item");
          if (!item || !listEl.contains(item)) return;
          var id = item.getAttribute("data-id");
          if (!id) return;
          // 移动端：就算已经选中也要允许点（详情页显示正常）
          var isMobileClick = window.matchMedia("(max-width: 900px)").matches;
          if (!isMobileClick && id === HpState.selectedId) return;
          HpState.selectedId = id;
          HpState.commentFloorIdx = null;
          HpState.commentScrollFloorToRestore = null;
          HpState.commentScrollTopBefore = 0;
          renderHpList();
          renderHpDetail();
          renderHpComments();
          // 移动端：切换到详情页
          var isMobile = window.matchMedia("(max-width: 900px)").matches;
          if (isMobile) {
            var hotView = document.getElementById("view-hot");
            if (hotView) hotView.classList.add("hp-detail-mode");
          }
        });
      }
      var search = document.getElementById("hpSearchInput");
      if (search && !search.__hpBound) {
        search.__hpBound = true;
        // 搜索输入防抖 120ms，避免每敲一个字都重建列表
        var t = null;
        search.addEventListener("input", function () {
          if (t) clearTimeout(t);
          t = setTimeout(function () {
            HpState.searchText = search.value;
            renderHpList();
            renderHpDetail();
            renderHpComments();
          }, 120);
        });
      }
      // 进入热点 tab 时：强制重扫一次 hp（防止首次 init 时 hp/ 目录刚建、静态服务器还没加载到、或 view-hot DOM 还没挂载导致的渲染丢失）
      var navBtns = document.querySelectorAll(".nav-item[data-view]");
      navBtns.forEach(function (btn) {
        if (btn.__hpNavBound) return;
        btn.__hpNavBound = true;
        btn.addEventListener("click", function () {
          // 离开热点 tab 时：重置详情 header 文本 + 重置评论楼层详情状态，避免残留
          if (btn.dataset.view !== "hot") { hpUnbindDetailHeaderSync(); HpState.commentFloorIdx = null; }
          // ====== 切到「抽签 / 首页（view-home）」时：强制重算今日日期 + 重绘日历 ======
          //   根因：用户在其他 tab 挂了很久（跨了 0 点）再回首页，renderHomeCalendar 从不被触发 → todayKey 停在昨天 → 黄框 class 没加 → 黄色边框"消失"
          if (btn.dataset.view === "home") {
            setTimeout(function () {
              // 先清 __calLastToday：保证如果跨日了 selectedDate 会被强制同步到最新今日
              if (typeof state === "object" && state && state.__calLastToday) {
                var nowKey = fmtDate(new Date());
                if (state.calendar && state.calendar.selectedDate === state.__calLastToday && state.__calLastToday !== nowKey) {
                  state.calendar.selectedDate = nowKey;
                }
                state.__calLastToday = nowKey;
              }
              renderHomeCalendar();
              renderHomeProjects();
            }, 0);
            return;
          }
          if (btn.dataset.view !== "hot") return;
          // 移动端：进入热点 tab 默认回到列表态（防止从详情页离开后回来还停在详情）
          var hotView = document.getElementById("view-hot");
          if (hotView) hotView.classList.remove("hp-detail-mode");
          setTimeout(function () {
            loadHpPosts(true, true, true)
              .then(function () { renderRankBoards(); })
              .catch(function () {}); // true,true=渲染+强制重扫；第三个 true=静默，不弹右上角 toast；完成后同步刷新双榜
          }, 0);
        });
      });

      // ====== 页面 visibilitychange（用户一直挂后台，切回前台）：若当前在首页则重绘日历 ======
      //   解决：用户切到其他浏览器 tab 挂到 0 点后再切回来时，日历今日黄框没刷新的问题
      if (!document.__calVisBound) {
        document.__calVisBound = true;
        document.addEventListener("visibilitychange", function () {
          if (document.hidden) return;
          var homeView = document.getElementById("view-home");
          if (!homeView || homeView.hidden) return;  // 当前不在首页 tab，不刷
          setTimeout(function () {
            // 强制同步 selectedDate 到最新今日（仅当之前 selectedDate 就是旧的今日才同步）
            if (typeof state === "object" && state && state.__calLastToday) {
              var nowKey = fmtDate(new Date());
              if (state.calendar && state.calendar.selectedDate === state.__calLastToday && state.__calLastToday !== nowKey) {
                state.calendar.selectedDate = nowKey;
              }
              state.__calLastToday = nowKey;
            }
            renderHomeCalendar();
            renderHomeProjects();
          }, 0);
        });
      }

      // 热点卡片右上角「＋」按钮 → 打开导入/管理弹窗（file:// 模式也会用到）
      var openImportBtn = document.getElementById("hpOpenImportBtn");
      if (openImportBtn && !openImportBtn.__hpBound) {
        openImportBtn.__hpBound = true;
        openImportBtn.addEventListener("click", function () { hpOpenImportModal(); });
      }

      // 评论列：「共 N 条回复」点击进入楼层详情
      var commentBox = document.getElementById("hpCommentContainer");
      if (commentBox && !commentBox.__hpBound) {
        commentBox.__hpBound = true;
        commentBox.addEventListener("click", function (e) {
          var moreEl = e.target.closest(".hp-comment-more");
          if (moreEl) {
            var idx = parseInt(moreEl.getAttribute("data-floor-idx"), 10);
            if (isNaN(idx) || idx < 0) return;
            // —— 进入详情前先记录：当前要进入的 floor，和当时列表的滚动位置（兜底）
            HpState.commentFloorIdx = idx;
            HpState.commentScrollFloorToRestore = idx;
            var wrap = commentBox.closest(".list-wrap");
            HpState.commentScrollTopBefore = wrap ? wrap.scrollTop : 0;
            renderHpComments();
            // 进详情后滚到顶部，防止从列表中间进入详情时仍停在下方
            if (wrap) wrap.scrollTop = 0;
          }
        });
      }
      // 评论列：× 关闭按钮（楼层详情 → 回到全评论列表，并还原到进入详情前的那条评论位置）
      var commentBack = document.getElementById("hpCommentBackBtn");
      if (commentBack && !commentBack.__hpBound) {
        commentBack.__hpBound = true;
        commentBack.addEventListener("click", function () {
          HpState.commentFloorIdx = null;
          renderHpComments();
        });
      }
      // 详情列：← 返回按钮（移动端：帖子详情页 → 回到帖子列表页）
      var detailBack = document.getElementById("hpDetailBackBtn");
      if (detailBack && !detailBack.__hpBound) {
        detailBack.__hpBound = true;
        detailBack.addEventListener("click", function () {
          HpState.selectedId = null;
          HpState.commentFloorIdx = null;
          HpState.commentScrollFloorToRestore = null;
          HpState.commentScrollTopBefore = 0;
          renderHpList();
          renderHpDetail();
          renderHpComments();
          var hotView = document.getElementById("view-hot");
          if (hotView) hotView.classList.remove("hp-detail-mode");
        });
      }
    })();

    // 移动端详情页：双击任意滚动容器 → 平滑滚回顶部
    (function bindMobileDoubleClickToTop() {
      var lastTap = 0;
      document.addEventListener("click", function (e) {
        var hotView = document.getElementById("view-hot");
        if (!hotView || !hotView.classList.contains("hp-detail-mode")) return;
        if (!window.matchMedia("(max-width: 900px)").matches) return;
        var now = Date.now();
        if (now - lastTap < 320) {
          // 找到所有可滚动容器，滚回顶部
          [
            document.querySelector(".view-hot .col-2 .list-wrap"),
            document.querySelector(".view-hot .col-3 .list-wrap"),
            document.documentElement,
            document.body
          ].forEach(function (el) {
            if (el && el.scrollTop > 0) {
              el.scrollTo({ top: 0, behavior: "smooth" });
            }
          });
        }
        lastTap = now;
      }, true); // 捕获阶段，先于任何子元素 click
    })();

    // 媒体查询切换时重新渲染（移动端合并榜/桌面端双榜）
    (function bindRankBoardsMediaChange() {
      var mql = window.matchMedia("(max-width: 900px)");
      if (mql.addEventListener) {
        mql.addEventListener("change", renderRankBoards);
      } else {
        mql.addListener(renderRankBoards); // 旧浏览器兼容
      }
    })();

    // 排行页：总排行项点击（编号 0，切换第2列表格为总榜数据）
    var rankOverallList = $("#rankOverallList");
    if (rankOverallList) {
      rankOverallList.addEventListener("click", function (e) {
        var item = e.target.closest(".person-item");
        if (!item) return;
        selectRankOverall();
      });
    }

    // 排行页：总榜右上角链接按钮（总排行 TXT 读取/清空弹窗）
    var rankOverallLinkBtn = $("#rankOverallLinkBtn");
    if (rankOverallLinkBtn) {
      rankOverallLinkBtn.addEventListener("click", openRankOverallModal);
    }

    // 排行页：项目卡片右上角链接按钮（弹窗链接项目类型名单，作为分榜数据源）
    var rankProjLinkBtn = $("#rankProjLinkBtn");
    if (rankProjLinkBtn) {
      rankProjLinkBtn.addEventListener("click", openRankProjectLinkModal);
    }

    // 排行页：分榜列表项点击选中（事件委托，仅作用于 view-rank）
    var rankPeopleContainer = $("#rankPeopleContainer");
    if (rankPeopleContainer) {
      rankPeopleContainer.addEventListener("click", function (e) {
        var item = e.target.closest(".person-item");
        if (!item) return;
        var name = item.dataset.name;
        selectRankItem(name);
      });
    }

    // 排行页移动端：eye（进排名页）/ back（返回）按钮管理
    (function bindRankMobileMode() {
      var eyeBtn = document.getElementById("rankBoardEyeBtn");      // 总榜卡 eye → P2 排名页
      var boardBackBtn = document.getElementById("rankBoardBackBtn"); // 排名卡 back → P1
      var detailBackBtn = document.getElementById("rankDetailBackBtn"); // 成绩卡 back → P1
      var rankView = document.getElementById("view-rank");
      if (!rankView) return;

      var eyeSvg = (window.ICONS && window.ICONS.eye) ||
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      var backSvg = (window.ICONS && window.ICONS.back) ||
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
      if (eyeBtn && !eyeBtn.innerHTML) eyeBtn.innerHTML = eyeSvg;
      if (boardBackBtn && !boardBackBtn.innerHTML) boardBackBtn.innerHTML = backSvg;
      if (detailBackBtn && !detailBackBtn.innerHTML) detailBackBtn.innerHTML = backSvg;

      function isMobile() { return window.matchMedia("(max-width: 900px)").matches; }

      // P1 默认：清所有 mode，总榜 eye 可见
      function showDefault() {
        rankView.classList.remove("rank-board-mode");
        rankView.classList.remove("rank-detail-mode");
        var mobile = isMobile();
        if (eyeBtn) eyeBtn.hidden = !mobile;
        if (boardBackBtn) boardBackBtn.hidden = true;
        if (detailBackBtn) detailBackBtn.hidden = true;
      }

      // P2 排名页：加 rank-board-mode
      function showBoard() {
        rankView.classList.add("rank-board-mode");
        rankView.classList.remove("rank-detail-mode");
        if (eyeBtn) eyeBtn.hidden = true;
        if (boardBackBtn) boardBackBtn.hidden = false;
        if (detailBackBtn) detailBackBtn.hidden = true;
      }

      // 成绩详情（保留原有逻辑）
      function showDetail() {
        rankView.classList.remove("rank-board-mode");
        rankView.classList.add("rank-detail-mode");
        if (eyeBtn) eyeBtn.hidden = true;
        if (boardBackBtn) boardBackBtn.hidden = true;
        if (detailBackBtn) detailBackBtn.hidden = isMobile() ? false : true;
      }

      if (eyeBtn) eyeBtn.addEventListener("click", showBoard);
      if (boardBackBtn) boardBackBtn.addEventListener("click", showDefault);
      if (detailBackBtn) detailBackBtn.addEventListener("click", showDefault);

      // 选中项目/总排行 → 进成绩详情（原有逻辑）
      var origSelectItem = rankOverallList && rankOverallList._selectRankOverall;

      // 进排行 tab / 媒体查询切换 → 回 P1
      document.querySelectorAll(".nav-item").forEach(function (nav) {
        nav.addEventListener("click", function () {
          if (nav.dataset.view === "rank") showDefault();
        });
      });

      var mql = window.matchMedia("(max-width: 900px)");
      if (mql.addEventListener) mql.addEventListener("change", showDefault);
      else mql.addListener(showDefault);

      showDefault();
    })();

    // 抽签页移动端：三页切换 P1(名单+抽取) ↔ P2(人员) ↔ P3(历史/列表)
    (function bindDrawMobileMode() {
      var listEyeBtn = document.getElementById("drawPeopleEyeBtn");      // P1 名单卡 eye → P2
      var drawEyeBtn = document.getElementById("drawDrawEyeBtn");         // P1 抽取卡 eye → P3
      var peopleBackBtn = document.getElementById("drawPeopleBackBtn");    // P2 back → P1
      var histBackBtn = document.getElementById("drawListBackBtn");        // P3 back → P1
      var drawView = document.getElementById("view-draw");
      if (!drawView) return;

      var eyeSvg = (window.ICONS && window.ICONS.eye) ||
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      var backSvg = (window.ICONS && window.ICONS.back) ||
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
      if (listEyeBtn && !listEyeBtn.innerHTML) listEyeBtn.innerHTML = eyeSvg;
      if (drawEyeBtn && !drawEyeBtn.innerHTML) drawEyeBtn.innerHTML = eyeSvg;
      if (peopleBackBtn && !peopleBackBtn.innerHTML) peopleBackBtn.innerHTML = backSvg;
      if (histBackBtn && !histBackBtn.innerHTML) histBackBtn.innerHTML = backSvg;

      function isMobile() { return window.matchMedia("(max-width: 900px)").matches; }

      // P1 默认：名单 + 抽取，两个 eye 可见
      function showNamePage() {
        drawView.classList.remove("draw-people-mode");
        drawView.classList.remove("draw-history-mode");
        var mobile = isMobile();
        if (listEyeBtn) listEyeBtn.hidden = !mobile;
        if (drawEyeBtn) drawEyeBtn.hidden = !mobile;
        if (peopleBackBtn) peopleBackBtn.hidden = true;
        if (histBackBtn) histBackBtn.hidden = true;
      }

      // P2：仅人员页
      function showPeoplePage() {
        drawView.classList.add("draw-people-mode");
        drawView.classList.remove("draw-history-mode");
        if (listEyeBtn) listEyeBtn.hidden = true;
        if (drawEyeBtn) drawEyeBtn.hidden = true;
        if (peopleBackBtn) peopleBackBtn.hidden = false;
        if (histBackBtn) histBackBtn.hidden = true;
      }

      // P3：仅历史/列表页
      function showHistoryPage() {
        drawView.classList.remove("draw-people-mode");
        drawView.classList.add("draw-history-mode");
        if (listEyeBtn) listEyeBtn.hidden = true;
        if (drawEyeBtn) drawEyeBtn.hidden = true;
        if (peopleBackBtn) peopleBackBtn.hidden = true;
        if (histBackBtn) histBackBtn.hidden = false;
      }

      if (listEyeBtn) listEyeBtn.addEventListener("click", showPeoplePage);
      if (drawEyeBtn) drawEyeBtn.addEventListener("click", showHistoryPage);
      if (peopleBackBtn) peopleBackBtn.addEventListener("click", showNamePage);
      if (histBackBtn) histBackBtn.addEventListener("click", showNamePage);

      // 进入抽签 tab / 媒体查询切换 → 回 P1
      document.querySelectorAll(".nav-item").forEach(function (nav) {
        nav.addEventListener("click", function () {
          if (nav.dataset.view === "draw") showNamePage();
        });
      });

      var mql = window.matchMedia("(max-width: 900px)");
      var onMQ = function () { showNamePage(); };
      if (mql.addEventListener) mql.addEventListener("change", onMQ);
      else mql.addListener(onMQ);

      showNamePage();
    })();

    // 排行页：导入/管理 TXT 表格数据弹窗（与首页日历一致的交互）
    var rankImportBtn = $("#rankImportTxtBtn");
    if (rankImportBtn) {
      rankImportBtn.addEventListener("click", openRankTableDataModal);
    }

    // 全局快捷键：空格/回车抽取（仅在抽签视图可见时响应）
    document.addEventListener("keydown", function (e) {
      var tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      var drawView = document.getElementById("view-draw");
      if (drawView && drawView.hidden) return;
      if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        draw();
      }
    });
  }

  // ===== 赛季数据加载：从 localStorage 私有目录恢复到运行时 =====
  // 存储结构：
  //   jfes_data_C1_content / jfes_data_C2_content / jfes_data_HP_content → 文件原文
  //   jfes_data_C1_version / jfes_data_C2_version / jfes_data_HP_version → 版本号
  // 文件格式：/*{type}-{version}*/ 开头的 JS，执行后得到 JFES_BACKUP 对象
  //   JFES_BACKUP.storage = { key: value, ... } → 需恢复到 localStorage
  //
  // 关键：切换赛季时必须先清除旧赛季的运行时数据，再写入新赛季的数据。
  //       保留的共享键（不随赛季切换）：主题、模糊度、灰暗度、页面标题、当前视图、
  //       应用状态（jfes_random_person_v1：名单结构/活跃ID/链接库/排行等）、私有目录文件
  var SHARED_KEYS = [
    "jfes_theme", "jfes_view", "jfes_card_blur", "jfes_bg_darkness",
    "jfes_page_title", "jfes_bgm", "jfes_bgm_volume", "jfes_bgm_select", "jfes_random_person_v1"
  ];

  function isPrivateDirKey(key) {
    // 私有目录键：jfes_data_*_content / jfes_data_*_version
    return /^jfes_data_/.test(key);
  }

  function clearRuntimeData() {
    // 1. 保存共享键和私有目录键
    var saved = {};
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (!key) continue;
      if (SHARED_KEYS.indexOf(key) >= 0 || isPrivateDirKey(key)) {
        saved[key] = localStorage.getItem(key);
      }
    }
    // 2. 清除所有 jfes_ 键
    var toRemove = [];
    for (var j = 0; j < localStorage.length; j++) {
      var k = localStorage.key(j);
      if (k && k.indexOf("jfes_") === 0) toRemove.push(k);
    }
    toRemove.forEach(function (k) { localStorage.removeItem(k); });
    // 3. 恢复共享键和私有目录键
    Object.keys(saved).forEach(function (k) {
      try { localStorage.setItem(k, saved[k]); } catch (e) {}
    });
  }

  function loadSeasonData() {
    var season = (window.JFESSeason && window.JFESSeason.get) ? window.JFESSeason.get() : "C2";
    var typesToLoad = [season];  // 只加载当前赛季（C1 或 C2）
    typesToLoad.push("HP");      // HP（热点）数据始终加载

    // 关键：先清除旧数据，确保只使用当前赛季的数据
    clearRuntimeData();

    typesToLoad.forEach(function (type) {
      try {
        var backup = null;
        // 优先使用 .data/ 文件夹下预加载的数据
        if (hasPreloaded(type)) {
          backup = PRELOADED_DATA[type].backup;
        } else {
          // 回退：从 localStorage 私有目录读取（兼容旧导入方式）
          var content = localStorage.getItem("jfes_data_" + type + "_content");
          if (content) backup = tryParseBackup(content);
        }
        if (!backup || !backup.storage) return;
        // 将 backup.storage 中的键值对写入 localStorage
        // 但跳过 jfes_data_* 私有数据键，防止嵌套备份覆盖刚导入的新数据
        Object.keys(backup.storage).forEach(function (key) {
          // 跳过私有数据键：防止嵌套备份覆盖刚导入的新数据
          if (/^jfes_data_/.test(key)) return;
          // 跳过用户偏好键：主题/模糊度/灰暗度/背景音乐/页面标题/视图以当前设置为准，
          // 备份里的旧值不回写（否则每次刷新都会把用户的主题设置重置成备份时的值）
          if (/^jfes_(theme|card_blur|bg_darkness|bgm|bgm_volume|bgm_select|page_title|view)$/.test(key)) return;
          try {
            localStorage.setItem(key, String(backup.storage[key]));
          } catch (e) { /* 单键失败不阻断 */ }
        });
      } catch (e) { /* 静默失败 */ }
    });
  }

  function tryParseBackup(text) {
    try {
      // 使用沙箱方式执行，获取 JFES_BACKUP 对象
      var fn = new Function(text + "; return window.JFES_BACKUP;");
      var backup = fn();
      if (backup && backup.format === "JFES_LOCAL_BACKUP") {
        return backup;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // 验证保留的状态引用是否仍指向有效数据（赛季切换后旧ID可能不存在）
  function validateStateReferences() {
    // 1. 清理失效的活跃选择
    if (state.activeListId) {
      var list = state.lists.find(function (l) { return l.id === state.activeListId; });
      if (list && !isListDataValid(list)) {
        state.activeListId = null;
      }
    }
    if (state.activeDrawLink) {
      var link = (state.linkLibrary.people.find(function (l) { return l.id === state.activeDrawLink; }))
        || (state.linkLibrary.draws && state.linkLibrary.draws.find(function (l) { return l.id === state.activeDrawLink; }));
      if (!link) state.activeDrawLink = null;
    }
  }

  // 检查单个列表的数据源是否在 localStorage 中存在
  function isListDataValid(list) {
    if (!list) return false;
    // 本地名单：检查引用的 peopleDataKey 是否存在
    if (list.type === "people" && list.dataKey) {
      return localStorage.getItem(list.dataKey) !== null;
    }
    // 链接名单（从 linkLibrary）：检查 draws 或 people 中是否存在对应 id
    if (list.linked === true) {
      var inDraws = state.linkLibrary.draws && state.linkLibrary.draws.find(function (l) { return l.id === list.id; });
      var inPeople = state.linkLibrary.people.find(function (l) { return l.id === list.id; });
      return (inDraws != null) || (inPeople != null);
    }
    return true;
  }

  // 检查是否至少有一个列表引用了有效数据
  function hasAnyValidList() {
    for (var i = 0; i < state.lists.length; i++) {
      if (isListDataValid(state.lists[i])) return true;
    }
    return false;
  }

  // ===== 数据导入 & 版本管理 公共工具函数 =====
  // 文件首行注释格式：/*类型-版本*/  如 /*C1-1.011.000*/
  function parseFileHeader(text) {
    var m = text.match(/^\s*\/\*\s*(C1|C2|HP)-(\d+(?:\.\d+)*)\s*\*\//);
    if (!m) return null;
    return { type: m[1], version: m[2] };  // 版本保持字符串，如 "1.011.000"
  }

  function parseVersionParts(v) {
    return String(v).split(".").map(function (p) { return parseInt(p, 10) || 0; });
  }

  // 版本比较：a > b 返回正数，a < b 返回负数，相等返回 0
  function compareVersions(a, b) {
    var pa = parseVersionParts(a);
    var pb = parseVersionParts(b);
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var na = pa[i] || 0;
      var nb = pb[i] || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  }

  function getStoredVersion(type) {
    try {
      return localStorage.getItem("jfes_data_" + type + "_version") || "0";
    } catch (e) { return "0"; }
  }

  function setStoredVersion(type, version) {
    try { localStorage.setItem("jfes_data_" + type + "_version", String(version)); } catch (e) {}
  }

  function storeDataFile(type, version, text) {
    try {
      localStorage.setItem("jfes_data_" + type + "_content", text);
      setStoredVersion(type, version);
      return true;
    } catch (e) {
      showToast("存储失败：" + e.message);
      return false;
    }
  }

  // ===== 初始化 =====
  function init() {
    // 等待 .data 目录下 C1/C2/HP 文件预加载完成，再启动数据加载与页面渲染
    PRELOAD_PROMISE.then(function () {
      // ===== 第一步：加载赛季数据（优先使用预加载的 .data 文件，回退使用 localStorage 私有目录）=====
      loadSeasonData();

      var loaded = load();
      if (!loaded || !state.lists.length) {
        // 初始化时不创建示例名单，保持空状态
        state.lists = [];
        state.activeListId = null;
        state.activeDrawLink = null;
      } else {
        // 验证保留的状态引用是否仍有效（赛季切换后旧ID可能不存在）
        validateStateReferences();
        if (!activeList()) {
          state.activeListId = state.lists[0] ? state.lists[0].id : null;
        }
        // 如果所有列表引用都失效（赛季切换导致ID不匹配），清空状态
        if (state.lists.length > 0 && !hasAnyValidList()) {
          state.lists = [];
          state.activeListId = null;
          state.activeDrawLink = null;
          save();
        }
      }
      // 图标注入由 common.js 负责（其 DOMContentLoaded 监听器先于此处触发）
      renderAll();
      // 排行页：初始化项目选择 + 人员列表（仅 linkLibrary.projects 范围）
      renderRankAll();
      bindEvents();
      // 热点模块：页面加载完成后尝试扫描 hp 目录并刷新列表；视图切换进入热点页时也会再刷新
      // 第三个参数 true = 静默：刷新页面时不要弹右上角「已加载 N 条帖子」toast，错误提示（没帖子/目录失败）仍保留
      try {
        loadHpPosts(true, false, true)
          .then(function () { renderRankBoards(); })
          .catch(function () {});
      } catch (e) { /* 浏览器禁用 fetch 或 hp 目录缺失时不抛错阻塞其他模块 */ }

      // ===== 设置页版本信息显示：优先使用 .data 预加载文件的版本号 =====
      (function updateVersionDisplay() {
        var map = { C1: "versionC1", C2: "versionC2", HP: "versionHP" };
        Object.keys(map).forEach(function (type) {
          var el = document.getElementById(map[type]);
          if (!el) return;
          if (PRELOADED_DATA[type] && PRELOADED_DATA[type].version) {
            el.textContent = PRELOADED_DATA[type].version;
          } else {
            var storedVer = getStoredVersion(type);
            el.textContent = storedVer && storedVer !== "0" ? storedVer : "未导入";
          }
        });
      })();

    });  // <-- PRELOAD_PROMISE.then() 回调结束

    // ===== 赛季切换事件：重新加载对应数据 =====
    document.addEventListener("jfes:seasonChange", function (e) {
      var newSeason = e.detail.season;
      showToast("切换到" + (newSeason === "C1" ? "第一赛季" : "第二赛季"));
      // 延迟刷新，让 toast 先显示
      setTimeout(function () { location.reload(); }, 600);
    });
  }

  // 暴露给 common.js 的视图切换回调使用（切换到 rank 页时刷新排行页第1列）
  window.renderRankAll = renderRankAll;
  window.__rankState = function () { return { activeId: state.rankActiveProjectId, projLen: state.linkLibrary.projects.length }; };

  // —— 清理抽签运行时状态：仅在"用户处于抽签页"时记录，离开/关闭/刷新后不保留
  // 不加 toast 提示，仅重置内存，save() 本身也不会持久化这些字段
  function resetDrawRuntime() {
    state.history = [];
    state.lastListResult = [];
    state.lists.forEach(function (l) { l.removedPool = []; });
    drawLinkSession.id = null;
    drawLinkSession.obj = null;
    // 如果当前正在抽签页，重绘相关区域（否则下一次进入抽签页也会由 renderAll 自然重绘）
    var drawView = document.getElementById("view-draw");
    if (drawView && !drawView.hidden) {
      renderHistory();
      renderListResult();
      renderCurrentList();
      renderThirdColumn();
      renderResult(null);
    }
  }
  window.resetDrawRuntime = resetDrawRuntime;

  document.addEventListener("DOMContentLoaded", init);
})();
