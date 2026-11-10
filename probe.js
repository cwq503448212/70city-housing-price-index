'use strict';

/**
 * 指标编码探测工具
 *
 * 国家统计局的指标编码绝对不能靠猜。任何要写进 config/indicators.json 的
 * 栏目 id / 指标 id，都必须先用这个工具打印出来看一眼，再用 DBnomics 同期刊
 * 交叉校验一次。
 *
 * 用法：
 *   node probe.js tree                     列出「月度数据」下的栏目树（一层）
 *   node probe.js tree <pid>               展开某个栏目
 *   node probe.js indicators <catalogId>   列出栏目下的指标（含 id / 名称 / 起止）
 *   node probe.js data <catalogId> <indicatorId...> [from] [to]
 *                                          实际取数，看口径和量级对不对
 *   node probe.js check                    对配置里的指标做「官方 vs DBnomics」交叉校验
 *
 * 所有请求都走 sources/nbs.js，内部串行 + 1.2 秒间隔，不会打爆站点。
 */

const config = require('./lib/macro/config');
const nbs = require('./lib/macro/sources/nbs');
const dbnomics = require('./lib/macro/sources/dbnomics');
const month = require('./lib/macro/util/month');

const ROOT_MONTHLY = 'fc982599aa684be7969d7b90b1bd0e84';

function line() {
  console.log('-'.repeat(72));
}

async function showTree(pid) {
  const nodes = await nbs.tree(pid || ROOT_MONTHLY);
  line();
  console.log('栏目数：' + nodes.length + (pid ? '（父节点 ' + pid + '）' : '（月度数据）'));
  line();
  nodes.forEach((n) => {
    console.log([n._id, n.isLeaf ? '叶子' : '目录', n._name].join('  |  '));
  });
}

async function showIndicators(catalogId) {
  const list = await nbs.indicatorsOf(catalogId);
  line();
  console.log('指标数：' + list.length + '（栏目 ' + catalogId + '）');
  line();
  list.forEach((x) => {
    const span = (x.sdate || '?').slice(0, 7) + ' ~ ' + (x.edate ? x.edate.slice(0, 7) : '现在');
    console.log([x.id, span, x.unit || '-', x.shown || x.name].join('  |  '));
  });
}

async function showData(catalogId, ids, from, to) {
  const end = to || month.currentMonth();
  const start = from || month.addMonths(end, -11);
  const data = await nbs.fetchRange({ catalogId: catalogId, indicatorIds: ids, from: start, to: end });
  line();
  console.log('区间：' + start + ' ~ ' + end);
  line();
  ids.forEach((id) => {
    const map = data[id] || {};
    const months = Object.keys(map).sort();
    console.log(id + '  共 ' + months.length + ' 期');
    months.slice(-12).forEach((m) => {
      console.log('    ' + m + '  ' + map[m]);
    });
  });
}

/** 官方主源与 DBnomics 镜像同月对比，容差 0.1 */
async function checkAll() {
  const indicators = config.list();
  const to = month.currentMonth();
  let bad = 0;

  line();
  console.log('交叉校验：国家数据 vs DBnomics（只比镜像有的近 13 期，容差 0.1）');
  line();

  for (const ind of indicators) {
    const segs = ind.segments || [];
    const last = segs[segs.length - 1];
    const cat = config.getCatalog(last.catalog);
    const from = month.addMonths(to, -13);

    const official = await nbs
      .fetchRange({ catalogId: cat.id, indicatorIds: [last.indicatorId], from: from, to: to })
      .then((r) => r[last.indicatorId] || {})
      .catch((e) => ({ __error: e.message }));

    if (official.__error) {
      console.log('  [主源失败] ' + ind.id + '：' + official.__error);
      continue;
    }

    const fbList = [].concat(ind.fallback || []);
    if (!fbList.length) {
      const months = Object.keys(official).sort();
      console.log('  [无兜底] ' + ind.id + '，主源最新 ' + (months[months.length - 1] || '无') + ' = ' + official[months[months.length - 1]]);
      continue;
    }

    const mirror = {};
    for (const fb of fbList) {
      try {
        Object.assign(mirror, await dbnomics.fetchSeries(fb));
      } catch (e) {
        console.log('  [镜像失败] ' + ind.id + ' ' + fb.dataset + '/' + fb.series + '：' + e.message);
      }
    }

    const common = Object.keys(official).filter((m) => typeof mirror[m] === 'number');
    const diff = common.filter((m) => Math.abs(official[m] - mirror[m]) > 0.1);
    const latest = Object.keys(official).sort().pop();

    if (!common.length) {
      console.log('  [无交集] ' + ind.id + '：主源最新 ' + latest + ' = ' + official[latest] + '，镜像区间 ' + (Object.keys(mirror).sort()[0] || '-') + ' ~ ' + (Object.keys(mirror).sort().pop() || '-'));
      continue;
    }
    if (diff.length) {
      bad += 1;
      console.log('  [不一致] ' + ind.id + '：' + diff.length + ' 期超出容差，例如 ' + diff[0] + ' 官方 ' + official[diff[0]] + ' / 镜像 ' + mirror[diff[0]]);
    } else {
      console.log('  [一致] ' + ind.id + '：' + common.length + ' 期对比通过（最新 ' + common[common.length - 1] + '）');
    }
  }

  line();
  console.log(bad ? '有 ' + bad + ' 个指标与镜像不一致，先别上线，回去查口径' : '全部通过');
  return bad;
}

async function main() {
  const [cmd, a, b, c, d] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log('用法：');
    console.log('  node probe.js tree [pid]');
    console.log('  node probe.js indicators <catalogId>');
    console.log('  node probe.js data <catalogId> <indicatorId...> [from] [to]');
    console.log('  node probe.js check');
    return;
  }

  if (cmd === 'tree') return showTree(a);
  if (cmd === 'indicators') {
    if (!a) throw new Error('缺少 catalogId');
    return showIndicators(a);
  }
  if (cmd === 'data') {
    if (!a || !b) throw new Error('缺少 catalogId / indicatorId');
    const ids = [b].concat(c ? [c] : []).filter((x) => /^[0-9a-f]{32}$/i.test(x));
    const rest = process.argv.slice(2).filter((x) => /^\d{4}-\d{2}$/.test(x));
    if (!ids.length) throw new Error('indicatorId 必须是 32 位编码');
    return showData(a, ids, rest[0], rest[1]);
  }
  if (cmd === 'check') {
    const bad = await checkAll();
    if (bad) process.exitCode = 1;
    return;
  }
  throw new Error('未知命令：' + cmd);
}

main().catch((e) => {
  console.error('[probe] ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
