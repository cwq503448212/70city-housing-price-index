'use strict';

/**
 * LPR 模块配置（唯一事实来源）
 *
 * 上游：中国货币网（chinamoney.com.cn，全国银行间同业拆借中心官网）。
 * LPR 由全国银行间同业拆借中心计算发布，中国货币网即官方发布平台；
 * 接口是该站「LPR · 历史数据」页面自己用的 JSON，不是官方开放 API，无稳定性承诺。
 *
 * POST /ags/ms/cm-u-bk-currency/LprHis?lang=CN&strStartDate=YYYY-MM-DD&strEndDate=YYYY-MM-DD
 * 响应：{ head:{rep_code:'200'}, data:{ baseCurveCfgList:['1Y','5Y'] }, records:[…] }
 * records 按日期倒序，一行 = { '1Y':'3.00', '5Y':'3.50', showDateCN:'2026-10-20' }，
 * 数值是字符串百分数（'3.50' 表示 3.50%）。
 */

const SITE = {
  origin: 'https://www.chinamoney.com.cn',
  page: 'https://www.chinamoney.com.cn/chinese/bklpr/',
  path: '/ags/ms/cm-u-bk-currency/LprHis',
};

/** LPR 自 2019-08-20 起按月发布，更早没有；拉全就拉这一段（约 90 期，按自然年分段请求，见下方 HTTP） */
const HISTORY_FROM = '2019-08-20';

/** 每月 20 日 09:15 前公布（遇节假日顺延；顺延日期本地算不出，由「核对拿不到就下回再试」自然兜住） */
const RELEASE = { day: 20, hour: 9, minute: 15 };

/** 两次回源尝试的最小间隔（记在 _meta.json 的 lastAttempt，进程重启后仍生效） */
const TRY_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 上游限制：一次查询跨度超过一年时返回空 records（data.message = 「只提供一年历史数据查询及下载」），
 * 所以拉全历史必须按自然年分段请求（约 8 段）。segmentGapMs 是段间间隔，礼貌抓取。
 */
const HTTP = { timeoutMs: 20000, retries: 2, retryGapMs: 2000, segmentGapMs: 400 };

module.exports = { SITE, HISTORY_FROM, RELEASE, TRY_INTERVAL_MS, HTTP };
