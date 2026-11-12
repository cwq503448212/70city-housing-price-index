'use strict';

/**
 * 十三个看板共用的前端小工具：URL 分享视图、CSV 导出、口径提示气泡。
 *
 * 加载顺序：echarts.min.js 之前或之后都行，但必须排在页面自己的 app.js 之前。
 * 这里只放「与具体模块无关」的能力；指标编码、口径文案、列映射一律留在各页 app.js 或 config 里。
 *
 * 三项能力的边界：
 *   URL  只读写地址栏查询串，不动 localStorage；页面仍是「本地记住上次选择」为准，URL 只覆盖一次。
 *   CSV  只导出调用方传进来的当前区间数据，不读缓存、不碰接口；缺值写空单元格，不补 0。
 *   TIP  只有一个全屏浮层，挂在 body 上，避免被表格横向滚动容器裁掉。
 */

(function () {
  var Board = (window.Board = window.Board || {});

  /* ============================================================
     地址栏参数：?range=60&from=2021-01&to=2026-10&year=2024 …
     ============================================================ */

  Board.qs = function (name) {
    var params = new URLSearchParams(window.location.search);
    var v = params.get(name);
    return v === null || v === '' ? null : v;
  };

  /** 把页面当前视图写回地址栏（replaceState，不新增历史记录、不触发刷新） */
  Board.setQs = function (patch) {
    var params = new URLSearchParams(window.location.search);
    Object.keys(patch || {}).forEach(function (k) {
      var v = patch[k];
      if (v === null || v === undefined || v === '') params.delete(k);
      else params.set(k, String(v));
    });
    var qs = params.toString();
    var next = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    if (next !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.replaceState(null, '', next);
    }
  };

  /* ============================================================
     CSV 导出
     ============================================================ */

  var CSV_TYPE = 'text/csv;charset=utf-8';

  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') {
      if (!isFinite(v)) return '';
      // 保留计算精度，不做千分位、不加单位：Excel 里要能直接算
      return String(Math.round(v * 1e6) / 1e6);
    }
    return String(v);
  }

  function escapeCell(text) {
    if (text === '') return '';
    if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function rowLine(cells) {
    return cells.map(function (c) {
      return escapeCell(cellText(c));
    }).join(',');
  }

  function stamp() {
    var d = new Date();
    var p = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    );
  }

  /** 表头：列名 + 可选的单位/口径后缀（写进同一格，避免多一行把 Excel 公式区打乱） */
  function headerOf(col) {
    var label = col.label || col.key || '';
    var unit = col.unit ? '（' + col.unit + '）' : '';
    var mark = col.calc ? '·本页计算' : '';
    return label + unit + (mark ? ' ' + mark : '');
  }

  /**
   * 导出 CSV。
   * meta   = { module, source, range, note: [字符串] }
   * blocks = [{ title, columns: [{ key, label, unit, calc }], rows: [对象数组] }]
   *
   * 文件结构：注释行（# 开头）→ 空行 → 每张表一段，段间空一行。
   * 注释行是给人看的说明，Excel 会当普通文本行显示，不影响下面的数据区。
   */
  Board.csv = function (meta, blocks) {
    var lines = [];
    var m = meta || {};
    lines.push(rowLine(['# 看板', m.module || '']));
    if (m.source) lines.push(rowLine(['# 数据来源', m.source]));
    if (m.range) lines.push(rowLine(['# 取值区间', m.range]));
    lines.push(rowLine(['# 导出时间', stamp()]));
    if (m.interface) lines.push(rowLine(['# 接口', m.interface]));
    lines.push(rowLine(['# 说明', '数值为该看板页面当前区间内的原始值；空单元格表示官方未发布，不插值、不补 0']));
    (m.note || []).forEach(function (n) {
      lines.push(rowLine(['# 说明', n]));
    });

    (blocks || []).forEach(function (block) {
      if (!block || !block.rows) return;
      lines.push('');
      if (block.title) lines.push(rowLine(['# 表', block.title]));
      lines.push(rowLine(block.columns.map(headerOf)));
      block.rows.forEach(function (row) {
        lines.push(
          rowLine(
            block.columns.map(function (c) {
              return row[c.key];
            })
          )
        );
      });
    });

    var name = (m.file || m.module || 'board').replace(/[\\/:*?"<>|\s]+/g, '-');
    var suffix = m.fileSuffix ? '-' + m.fileSuffix : '';
    download(name + suffix + '.csv', '\ufeff' + lines.join('\r\n') + '\r\n');
  };

  function download(filename, text) {
    var blob = new Blob([text], { type: CSV_TYPE });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);
  }

  /**
   * 把页面上已经渲染好的 <table> 读成 CSV 块。
   * 用于「表就是当前视图」的页面：数值一律取单元格里显示的内容（页面已按区间过滤），
   * <th> 里的 <small>文字</small> 当作单位写进列名，<td data-v="…"> 优先取原始值。
   */
  Board.tableBlock = function (table, title) {
    var headRow = table.querySelector('thead tr');
    if (!headRow) return null;
    var columns = [];
    var ths = headRow.querySelectorAll('th');
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      var small = th.querySelector('small');
      var unit = small ? small.textContent.trim() : '';
      var label = th.textContent.replace(unit, '').replace(/\s+/g, ' ').trim();
      if (!label) label = '列' + (i + 1);
      columns.push({ key: 'c' + i, label: label, unit: unit });
    }
    var rows = [];
    var trs = table.querySelectorAll('tbody tr');
    for (var r = 0; r < trs.length; r++) {
      var tds = trs[r].querySelectorAll('td');
      if (!tds.length) continue;
      var row = {};
      for (var c = 0; c < tds.length && c < columns.length; c++) {
        var td = tds[c];
        var raw = td.getAttribute('data-v');
        var text = raw !== null ? raw : td.textContent.replace(/\s+/g, ' ').trim();
        if (text === '—' || text === '-') text = '';
        row['c' + c] = text;
      }
      rows.push(row);
    }
    return { title: title || '', columns: columns, rows: rows };
  };

  Board.exportTables = function (meta, tables) {
    var blocks = (tables || [])
      .map(function (item) {
        var el = typeof item.table === 'string' ? document.getElementById(item.table) : item.table;
        if (!el) return null;
        return Board.tableBlock(el, item.title);
      })
      .filter(function (b) {
        return b && b.rows.length;
      });
    if (!blocks.length) {
      window.alert('当前视图还没有可导出的数据。');
      return false;
    }
    Board.csv(meta, blocks);
    return true;
  };

  /* ============================================================
     口径提示：<span class="q" data-tip="一句话">?</span>
     桌面 hover、键盘 focus、触屏点击都能看到；浮层是 body 上的单例，不惧 overflow 裁切。
     ============================================================ */

  var tipEl = null;
  var tipOwner = null;

  function ensureTip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'board-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function showTip(owner) {
    var text = owner.getAttribute('data-tip');
    if (!text) return;
    var el = ensureTip();
    el.textContent = text;
    el.hidden = false;
    el.style.left = '0px';
    el.style.top = '0px';

    var box = owner.getBoundingClientRect();
    var tip = el.getBoundingClientRect();
    var gap = 8;
    var left = box.left + box.width / 2 - tip.width / 2;
    var top = box.top - tip.height - gap;
    if (top < 8) top = box.bottom + gap; // 贴顶时翻到下方
    left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    tipOwner = owner;
  }

  function hideTip() {
    if (tipEl) tipEl.hidden = true;
    if (tipOwner) tipOwner.removeAttribute('data-open');
    tipOwner = null;
  }

  function ownerOf(node) {
    while (node && node !== document.body) {
      if (node.getAttribute && node.getAttribute('data-tip')) return node;
      node = node.parentNode;
    }
    return null;
  }

  document.addEventListener('mouseover', function (e) {
    var owner = ownerOf(e.target);
    if (owner && owner !== tipOwner) showTip(owner);
  });

  document.addEventListener('mouseout', function (e) {
    var owner = ownerOf(e.target);
    if (!owner || owner !== tipOwner) return;
    if (owner.hasAttribute('data-open')) return; // 点击钉住的，等再点一次
    hideTip();
  });

  document.addEventListener('click', function (e) {
    var owner = ownerOf(e.target);
    if (!owner) {
      if (tipOwner) hideTip();
      return;
    }
    if (owner.hasAttribute('data-open')) {
      hideTip();
      return;
    }
    if (tipOwner) tipOwner.removeAttribute('data-open');
    owner.setAttribute('data-open', '1');
    showTip(owner);
  });

  document.addEventListener('focusin', function (e) {
    var owner = ownerOf(e.target);
    if (owner) showTip(owner);
  });

  document.addEventListener('focusout', function () {
    if (tipOwner && !tipOwner.hasAttribute('data-open')) hideTip();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && tipOwner) hideTip();
  });

  window.addEventListener('scroll', function () {
    if (tipOwner && !tipOwner.hasAttribute('data-open')) hideTip();
  }, true);

  window.addEventListener('resize', hideTip);

  /* ============================================================
     导出按钮：页面只写文本，行为统一在这里挂
     ============================================================ */

  /**
   * 给按钮挂导出行为，导出期间短暂显示「导出中…」防止连点。
   * build 返回 false 表示当前没有可导出数据，按钮会恢复原样。
   */
  Board.onExport = function (button, build) {
    if (!button) return;
    var label = button.textContent;
    button.addEventListener('click', function () {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = '导出中…';
      setTimeout(function () {
        try {
          build();
        } catch (err) {
          window.alert('导出失败：' + (err && err.message ? err.message : err));
        } finally {
          button.disabled = false;
          button.textContent = label;
        }
      }, 0);
    });
  };
})();
