const SUITS = ['S', 'H', 'D', 'C'];

function cardKey(c) {
  if (c.s === 'J') return c.j;
  return `${c.r}${c.s}`;
}

function compareSelectCard(a, b) {
  const suitOrder = { S: 4, H: 3, D: 2, C: 1, J: 5 };
  const ra = a.s === 'J' ? 100 : a.r;
  const rb = b.s === 'J' ? 100 : b.r;
  if (ra !== rb) return ra - rb;
  return (suitOrder[a.s] || 0) - (suitOrder[b.s] || 0);
}

function eval2(cards) {
  const jokers = cards.filter((c) => c?.s === 'J').length;
  if (jokers === 0) return eval2NoJoker(cards);

  const base = cards.filter((c) => c && c.s !== 'J');
  const used = new Set(base.map(cardKey));
  const full = [];
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r += 1) {
      const k = `${r}${s}`;
      if (!used.has(k)) full.push({ r, s });
    }
  }

  const best = { cat: -1, t: [], name: '' };
  const tryHand = (h) => {
    const e = eval2NoJoker(h);
    if (compareEval(e, best) > 0) {
      best.cat = e.cat;
      best.t = e.t;
      best.name = e.name;
    }
  };

  if (jokers === 1) {
    for (const rep of full) tryHand(base.concat([rep]));
  } else {
    for (let i = 0; i < full.length; i += 1) {
      for (let j = i + 1; j < full.length; j += 1) {
        tryHand(base.concat([full[i], full[j]]));
      }
    }
  }

  return {
    cat: best.cat,
    t: best.t,
    name: best.name,
    usedJoker: true,
  };
}

function eval2NoJoker(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const uniq = [...new Set(ranks)];
  if (uniq.length === 1) return { cat: 1, t: [uniq[0]], name: '一對' };
  return { cat: 0, t: ranks, name: '高牌' };
}

function eval3(cards) {
  const jokers = cards.filter((c) => c.s === 'J').length;
  if (jokers === 0) return eval3NoJoker(cards);

  const base = cards.filter((c) => c.s !== 'J');
  const used = new Set(base.map(cardKey));
  const full = [];
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r += 1) {
      const k = `${r}${s}`;
      if (!used.has(k)) full.push({ r, s });
    }
  }

  const best = { cat: -1, t: [], name: '' };
  const tryHand = (h) => {
    const e = eval3NoJoker(h);
    if (compareEval(e, best) > 0) {
      best.cat = e.cat;
      best.t = e.t;
      best.name = e.name;
    }
  };

  if (jokers === 1) {
    for (const rep of full) tryHand(base.concat([rep]));
  } else {
    for (let i = 0; i < full.length; i += 1) {
      for (let j = i + 1; j < full.length; j += 1) {
        tryHand(base.concat([full[i], full[j]]));
      }
    }
  }

  return {
    cat: best.cat,
    t: best.t,
    name: best.name,
    usedJoker: true,
  };
}

function eval3NoJoker(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const suits = cards.map((c) => c.s);
  const isFlush = suits.every((s) => s === suits[0]);

  const uniq = [...new Set(ranks)];
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const sortedAsc = [...ranks].sort((a, b) => a - b);
  let isStraight = false;
  let straightHigh = Math.max(...ranks);

  if (uniq.length === 3) {
    if (sortedAsc[2] - sortedAsc[1] === 1 && sortedAsc[1] - sortedAsc[0] === 1) {
      isStraight = true;
      straightHigh = sortedAsc[2];
      if (straightHigh === 14) {
        straightHigh = 15;
      }
    } else if (sortedAsc[0] === 2 && sortedAsc[1] === 3 && sortedAsc[2] === 14) {
      isStraight = true;
      straightHigh = 14;
    }
  }

  if (isStraight && isFlush) return { cat: 5, t: [straightHigh], name: '同花順' };
  if (uniq.length === 1) return { cat: 4, t: [uniq[0]], name: '三條' };
  if (isStraight) return { cat: 3, t: [straightHigh], name: '順子' };
  if (uniq.length === 2) {
    let pairRank = null;
    let kicker = null;
    for (const r in counts) {
      if (counts[r] === 2) pairRank = Number(r);
      if (counts[r] === 1) kicker = Number(r);
    }
    return { cat: 1, t: [pairRank, kicker], name: '一對' };
  }
  return { cat: 0, t: ranks, name: '高牌' };
}

function compareEval(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const len = Math.max(a.t.length, b.t.length);
  for (let i = 0; i < len; i += 1) {
    const av = a.t[i] ?? 0;
    const bv = b.t[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function headWinPoints(e2) {
  if (e2?.cat === 1) {
    const r = Number(e2.t?.[0] || 0);
    if (r >= 2 && r <= 14) return r;
  }
  return 1;
}

function midWinPoints(e3) {
  if (e3?.cat === 5) return 10;
  if (e3?.cat === 4) return 6;
  return 1;
}

function tailWinPoints(e3) {
  if (e3?.cat === 5) return 5;
  if (e3?.cat === 4) return 3;
  return 1;
}

function headSectionScore(playerE, dealerE) {
  const cmp = Math.sign(compareEval(playerE, dealerE));
  if (cmp === 0) return -headWinPoints(dealerE);
  if (cmp > 0) return headWinPoints(playerE);
  return -headWinPoints(dealerE);
}

function midSectionScore(playerE, dealerE) {
  const cmp = Math.sign(compareEval(playerE, dealerE));
  if (cmp === 0) return -midWinPoints(dealerE);
  if (cmp > 0) return midWinPoints(playerE);
  return -midWinPoints(dealerE);
}

function tailSectionScore(playerE, dealerE) {
  const cmp = Math.sign(compareEval(playerE, dealerE));
  if (cmp === 0) return -tailWinPoints(dealerE);
  if (cmp > 0) return tailWinPoints(playerE);
  return -tailWinPoints(dealerE);
}

function strength2(cards) {
  const e = eval2(cards);
  const t = e.t;
  return e.cat * 1e9 + (t[0] || 0) * 1e6 + (t[1] || 0) * 1e3;
}

function strength3(cards) {
  const e = eval3(cards);
  const t = e.t;
  return e.cat * 1e9 + (t[0] || 0) * 1e6 + (t[1] || 0) * 1e3 + (t[2] || 0);
}

function isAllFilled(arr) {
  return arr.every((x) => x);
}

function detectFoul(head, mid, tail) {
  if (!isAllFilled(head) || !isAllFilled(mid) || !isAllFilled(tail)) return { foul: false };
  const sh = strength2(head);
  const sm = strength3(mid);
  const st = strength3(tail);
  if (sh > sm) return { foul: true, msg: '擺烏龍：頭墩大於中墩' };
  if (sm > st) return { foul: true, msg: '擺烏龍：中墩大於尾墩' };
  return { foul: false };
}

function canBeFlush2(cards) {
  const nonJ = cards.filter((c) => c && c.s !== 'J');
  if (nonJ.length <= 1) return true;
  return nonJ.every((c) => c.s === nonJ[0].s);
}

function canBeStraight2(cards) {
  const nonJ = cards.filter((c) => c && c.s !== 'J');
  const jokers = cards.filter((c) => c && c.s === 'J').length;
  if (jokers >= 1) return true;
  if (nonJ.length !== 2) return true;
  const a = nonJ[0].r;
  const b = nonJ[1].r;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi - lo === 1) return true;
  if (hi === 14 && lo === 2) return true;
  return false;
}

function validateSpecial(code, all9Cards, sub, evals) {
  const c = code || 'none';
  if (c === 'none') return { ok: true, bonus: 0 };

  const all = (all9Cards || []).filter(Boolean);
  const jokers = all.filter((x) => x.s === 'J').length;
  const nonJ = all.filter((x) => x.s !== 'J');

  const bonusMap = {
    allRed: 5,
    allBlack: 5,
    threeSnake: 3,
    fourKind: 10,
    fourPairs: 10,
    mixedDragon: 15,
    threeStraightFlush: 25,
    twoFourKind: 30,
    greenDragon: 100,
    noHand: 3,
  };

  const isRed = (s) => s === 'H' || s === 'D';
  const isBlack = (s) => s === 'S' || s === 'C';

  const rankCounts = () => {
    const m = {};
    for (const x of nonJ) m[x.r] = (m[x.r] || 0) + 1;
    return m;
  };

  const canMakeFourKindCount = () => {
    const counts = rankCounts();
    const ranks = Object.keys(counts).map(Number);
    for (const r of ranks) {
      if ((counts[r] || 0) + jokers >= 4) return true;
    }
    return jokers >= 4;
  };

  const canMakeTwoFourKind = () => {
    const counts = rankCounts();
    const ranks = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]);
    let j = jokers;
    let made = 0;
    for (const r of ranks) {
      const need = Math.max(0, 4 - (counts[r] || 0));
      if (need <= j) {
        j -= need;
        made += 1;
        if (made >= 2) return true;
      }
    }
    if (made === 1 && j >= 4) return true;
    if (made === 0 && j >= 8) return true;
    return false;
  };

  const canMakeFourPairs = () => {
    const counts = rankCounts();
    let pairs = 0;
    let singles = 0;
    for (const r in counts) {
      pairs += Math.floor(counts[r] / 2);
      singles += counts[r] % 2;
    }
    const useToPairSingles = Math.min(jokers, singles);
    pairs += useToPairSingles;
    const jLeft = jokers - useToPairSingles;
    pairs += Math.floor(jLeft / 2);
    return pairs >= 4;
  };

  const canMakeLength9Straight = (cards, requireSameColor = null) => {
    const straightCards = (cards || []).filter(Boolean);
    const straightJokers = straightCards.filter((x) => x.s === 'J').length;
    const straightNonJ = straightCards.filter((x) => x.s !== 'J');

    if (requireSameColor) {
      if (requireSameColor === 'red' && straightNonJ.some((x) => !isRed(x.s))) return false;
      if (requireSameColor === 'black' && straightNonJ.some((x) => !isBlack(x.s))) return false;
    }

    const ranks = straightNonJ.map((x) => x.r);
    const uniq = new Set(ranks);
    if (uniq.size !== ranks.length) return false;

    if (ranks.length <= 1) return true;

    const max14 = Math.max(...ranks);
    const min14 = Math.min(...ranks);
    const need14 = max14 - min14 + 1 - ranks.length;
    if (need14 <= straightJokers) return true;

    if (ranks.includes(14)) {
      const ranks1 = ranks.map((r) => (r === 14 ? 1 : r));
      const max1 = Math.max(...ranks1);
      const min1 = Math.min(...ranks1);
      const need1 = max1 - min1 + 1 - ranks1.length;
      if (need1 <= straightJokers) return true;
    }

    return false;
  };

  const head = sub?.head || [];
  const mid = sub?.mid || [];
  const tail = sub?.tail || [];
  const eHead = evals?.head || eval2(head);
  const eMid = evals?.mid || eval3(mid);
  const eTail = evals?.tail || eval3(tail);

  const eightCards = [...(head || []), ...(mid || []), ...(tail || [])].filter(Boolean);
  const eightNonJ = eightCards.filter((x) => x.s !== 'J');

  let ok = false;
  if (c === 'allRed') ok = eightNonJ.every((x) => isRed(x.s));
  if (c === 'allBlack') ok = eightNonJ.every((x) => isBlack(x.s));
  if (c === 'threeSnake') ok = canBeStraight2(head) && eMid.cat >= 3 && eTail.cat >= 3;
  if (c === 'threeStraightFlush') ok = canBeStraight2(head) && canBeFlush2(head) && eMid.cat === 5 && eTail.cat === 5;
  if (c === 'noHand') {
    const eight = [...(head || []), ...(mid || []), ...(tail || [])].filter(Boolean);
    const anyJoker = eight.some((x) => x.s === 'J');
    if (anyJoker) {
      ok = false;
    } else {
      const ranks = eight.map((x) => x.r);
      const set = new Set(ranks);
      if (set.size !== ranks.length) {
        ok = false;
      } else {
        let canMakeAnyHand = false;
        for (let i = 0; i < eight.length; i += 1) {
          for (let j = i + 1; j < eight.length; j += 1) {
            for (let k = j + 1; k < eight.length; k += 1) {
              const e3 = eval3NoJoker([eight[i], eight[j], eight[k]]);
              if ((e3?.cat || 0) > 0) {
                canMakeAnyHand = true;
                break;
              }
            }
            if (canMakeAnyHand) break;
          }
          if (canMakeAnyHand) break;
        }
        ok = !canMakeAnyHand;
      }
    }
  }

  if (c === 'fourKind') ok = canMakeFourKindCount();
  if (c === 'twoFourKind') ok = canMakeTwoFourKind();
  if (c === 'fourPairs') ok = canMakeFourPairs();
  if (c === 'mixedDragon') ok = canMakeLength9Straight(eightCards, null);
  if (c === 'greenDragon') {
    ok = canMakeLength9Straight(eightCards, 'red') || canMakeLength9Straight(eightCards, 'black');
  }

  return { ok, bonus: ok ? bonusMap[c] || 0 : 0 };
}

function computeDealerIdFromSubmissions(submissions) {
  const ids = Object.keys(submissions || {});
  let bestId = null;
  for (const id of ids) {
    const sub = submissions[id];
    if (!sub || !sub.dealerCard) continue;
    if (!bestId) {
      bestId = id;
      continue;
    }
    const cmp = compareSelectCard(sub.dealerCard, submissions[bestId].dealerCard);
    if (cmp > 0) bestId = id;
    if (cmp === 0 && String(id) > String(bestId)) bestId = id;
  }
  return bestId;
}

function computeRoundResult({ submissions, dealerOverride }) {
  const ids = Object.keys(submissions || {});
  if (!ids.length) throw new Error('No submissions');

  const evalMap = {};
  const reportMap = {};
  const foulMap = {};

  for (const id of ids) {
    const sub = submissions[id];
    if (!sub?.dealerCard) throw new Error('Missing dealer card');
    const se = { head: eval2(sub.head), mid: eval3(sub.mid), tail: eval3(sub.tail) };
    evalMap[id] = se;
    const all9 = [sub.dealerCard, ...sub.head, ...sub.mid, ...sub.tail];
    const sp = validateSpecial(sub.report, all9, sub, se);
    reportMap[id] = sp;
    foulMap[id] = detectFoul(sub.head, sub.mid, sub.tail);
  }

  const wulongSet = new Set();
  for (const id of ids) {
    const sub = submissions[id];
    const reportCode = sub.report || 'none';
    const sp = reportMap[id] || { ok: true, bonus: 0 };
    const isReportValid = reportCode !== 'none' && sp.ok && sp.bonus > 0;

    if (!isReportValid && foulMap[id]?.foul) {
      wulongSet.add(id);
    }
    if (reportCode !== 'none' && !isReportValid) {
      wulongSet.add(id);
    }
  }

  const dealerId = dealerOverride || computeDealerIdFromSubmissions(submissions);
  if (!dealerId) throw new Error('Unable to determine dealer');

  const dealerSub = submissions[dealerId];
  const dealerEval = evalMap[dealerId];
  let hasNonDealerReportOk = false;
  for (const id of ids) {
    if (id === dealerId) continue;
    const sub = submissions[id];
    const reportCode = sub.report || 'none';
    const sp = reportMap[id] || { ok: true, bonus: 0 };
    if (reportCode !== 'none' && sp.ok && sp.bonus > 0) {
      hasNonDealerReportOk = true;
      break;
    }
  }

  const dealerReportCode = dealerSub?.report || 'none';
  const dealerReport = reportMap[dealerId] || { ok: false, bonus: 0 };
  const dealerReportOk = dealerReportCode !== 'none' && dealerReport.ok && dealerReport.bonus > 0;

  if (dealerReportOk) {
    const bonus = dealerReport.bonus;
    if (!hasNonDealerReportOk) {
      const results = {};
      for (const id of ids) {
        const sub = submissions[id];
        const se = evalMap[id];
        const isDealer = id === dealerId;
        results[id] = {
          total: isDealer ? bonus * (ids.length - 1) : -bonus,
          note: isDealer
            ? `莊家報到+${bonus}×${ids.length - 1}（本局只計報到）`
            : `被莊家報到-${bonus}`,
          per: { head: 0, mid: 0, tail: 0 },
          report: sub.report || 'none',
          evalNames: { head: se.head.name, mid: se.mid.name, tail: se.tail.name },
          dealerCard: sub.dealerCard,
        };
      }
      return { dealerId, results };
    }

    const results = {};
    let dealerNet = 0;
    let affectedCount = 0;

    for (const id of ids) {
      const sub = submissions[id];
      const se = evalMap[id];
      const reportCode = sub.report || 'none';
      const sp = reportMap[id] || { ok: true, bonus: 0 };
      if (id === dealerId) continue;

      if (reportCode !== 'none' && sp.ok && sp.bonus > 0) {
        results[id] = {
          total: sp.bonus,
          note: `報到+${sp.bonus}（本局只計報到）`,
          per: { head: 0, mid: 0, tail: 0 },
          report: reportCode,
          evalNames: { head: se.head.name, mid: se.mid.name, tail: se.tail.name },
          dealerCard: sub.dealerCard,
        };
        dealerNet -= sp.bonus;
        continue;
      }

      results[id] = {
        total: -bonus,
        note: `被莊家報到-${bonus}`,
        per: { head: 0, mid: 0, tail: 0 },
        report: reportCode,
        evalNames: { head: se.head.name, mid: se.mid.name, tail: se.tail.name },
        dealerCard: sub.dealerCard,
      };
      dealerNet += bonus;
      affectedCount += 1;
    }

    const dealerSe = evalMap[dealerId];
    results[dealerId] = {
      total: dealerNet,
      note: `莊家報到+${bonus}×${affectedCount}（已扣除閒家報到；本局只計報到）`,
      per: { head: 0, mid: 0, tail: 0 },
      report: dealerReportCode,
      evalNames: { head: dealerSe.head.name, mid: dealerSe.mid.name, tail: dealerSe.tail.name },
      dealerCard: dealerSub.dealerCard,
    };
    return { dealerId, results };
  }

  const results = {};
  let dealerNet = 0;

  for (const id of ids) {
    const sub = submissions[id];
    const se = evalMap[id];
    const reportCode = sub.report || 'none';
    const sp = reportMap[id] || { ok: true, bonus: 0 };
    const wulongDealer = wulongSet.has(dealerId);

    if (id !== dealerId && wulongSet.has(id)) {
      if (reportCode !== 'none' && sp.ok && sp.bonus > 0) {
        const total = sp.bonus;
        results[id] = {
          total,
          note: `報到+${sp.bonus}（本局只計報到）`,
          per: { head: 0, mid: 0, tail: 0 },
          report: reportCode,
          evalNames: { head: se.head.name, mid: se.mid.name, tail: se.tail.name },
          dealerCard: sub.dealerCard,
        };
        dealerNet -= total;
        continue;
      }

      const per = {
        head: -headWinPoints(dealerEval.head),
        mid: -midWinPoints(dealerEval.mid),
        tail: -tailWinPoints(dealerEval.tail),
      };
      const total = per.head + per.mid + per.tail;

      const note =
        reportCode !== 'none' && !(sp.ok && sp.bonus > 0)
          ? '報到不符→擺烏龍（本局三墩全輸）'
          : '擺烏龍（本局三墩全輸）';
      results[id] = {
        total,
        note,
        per,
        report: reportCode,
        evalNames: { head: se.head.name, mid: se.mid.name, tail: se.tail.name },
        dealerCard: sub.dealerCard,
      };
      dealerNet -= total;
      continue;
    }

    if (id !== dealerId && reportCode !== 'none' && sp.ok && sp.bonus > 0) {
      const total = sp.bonus;
      results[id] = {
        total,
        note: `報到+${sp.bonus}（本局只計報到）`,
        per: { head: 0, mid: 0, tail: 0 },
        report: reportCode,
        evalNames: { head: se.head.name, mid: se.mid.name, tail: se.tail.name },
        dealerCard: sub.dealerCard,
      };
      dealerNet -= total;
      continue;
    }

    const per = { head: 0, mid: 0, tail: 0 };
    let total = 0;
    const noteParts = [];

    if (id !== dealerId) {
      if (wulongDealer) {
        per.head = headWinPoints(se.head);
        per.mid = midWinPoints(se.mid);
        per.tail = tailWinPoints(se.tail);
        total = per.head + per.mid + per.tail;
        noteParts.push('莊家失誤：三墩全勝');
      } else {
        per.head = headSectionScore(se.head, dealerEval.head);
        per.mid = midSectionScore(se.mid, dealerEval.mid);
        per.tail = tailSectionScore(se.tail, dealerEval.tail);
        total = per.head + per.mid + per.tail;

        if (Math.abs(per.head) !== 0 && (se.head.cat === 1 || dealerEval.head.cat === 1)) {
          if (per.head > 0 && se.head.cat === 1) noteParts.push(`頭墩對子+${headWinPoints(se.head)}`);
          if (per.head < 0 && dealerEval.head.cat === 1) noteParts.push(`頭墩對子-${headWinPoints(dealerEval.head)}`);
        }
        if (
          Math.abs(per.mid) !== 0 &&
          (se.mid.cat === 5 || se.mid.cat === 4 || dealerEval.mid.cat === 5 || dealerEval.mid.cat === 4)
        ) {
          if (per.mid > 0) {
            if (se.mid.cat === 5) noteParts.push('中墩同花順+10');
            else if (se.mid.cat === 4) noteParts.push('中墩三條+6');
          } else {
            if (dealerEval.mid.cat === 5) noteParts.push('中墩同花順-10');
            else if (dealerEval.mid.cat === 4) noteParts.push('中墩三條-6');
          }
        }
        if (
          Math.abs(per.tail) !== 0 &&
          (se.tail.cat === 5 || se.tail.cat === 4 || dealerEval.tail.cat === 5 || dealerEval.tail.cat === 4)
        ) {
          if (per.tail > 0) {
            if (se.tail.cat === 5) noteParts.push('尾墩同花順+5');
            else if (se.tail.cat === 4) noteParts.push('尾墩三條+3');
          } else {
            if (dealerEval.tail.cat === 5) noteParts.push('尾墩同花順-5');
            else if (dealerEval.tail.cat === 4) noteParts.push('尾墩三條-3');
          }
        }
      }
    }

    let note = noteParts.join('｜');
    if (reportCode !== 'none' && !(sp.ok && sp.bonus > 0)) {
      note += (note ? '｜' : '') + (id === dealerId ? '報到不符' : '報到不符→擺烏龍');
    }

    if (id !== dealerId) dealerNet -= total;
    results[id] = {
      total,
      note,
      per,
      report: reportCode,
      evalNames: { head: se.head.name, mid: se.mid.name, tail: se.tail.name },
      dealerCard: sub.dealerCard,
    };
  }

  if (dealerId && results[dealerId]) {
    const wulongDealer = wulongSet.has(dealerId);
    results[dealerId].total = dealerNet;
    const extra = wulongDealer ? '擺烏龍（莊家全輸）' : '莊家淨值';
    results[dealerId].note = (results[dealerId].note ? `${results[dealerId].note}｜` : '') + extra;
  }

  return { dealerId, results };
}

module.exports = {
  computeRoundResult,
};
