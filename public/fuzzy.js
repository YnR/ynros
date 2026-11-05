// Small fuzzy matcher shared by the browser and the server.
// Each query word must match the text, either as a substring or as letters in
// order (subsequence). Contiguous runs, word starts and exact substrings score
// higher; a word that matches nowhere means no match (score 0).

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function wordScore(word, text) {
  if (!word) return 1;
  const at = text.indexOf(word);
  if (at >= 0) {
    const start = at === 0 || /[^a-z0-9]/.test(text[at - 1]);
    return 10 + word.length * 3 + (start ? 8 : 0) + (at === 0 ? 2 : 0);
  }
  // Subsequence with bonuses for runs and word starts; reject very spread-out matches.
  let score = 0;
  let ti = 0;
  let run = 0;
  let first = -1;
  for (const ch of word) {
    const found = text.indexOf(ch, ti);
    if (found < 0) return 0;
    if (first < 0) first = found;
    run = found === ti ? run + 1 : 0;
    const start = found === 0 || /[^a-z0-9]/.test(text[found - 1]);
    score += 1 + run * 2 + (start ? 3 : 0);
    ti = found + 1;
  }
  const span = ti - first;
  if (span > word.length * 4 + 6) return 0;
  return score;
}

/** Score `text` against `query`; 0 means no match. */
export function fuzzyScore(query, text) {
  const t = norm(text);
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  let total = 0;
  for (const w of words) {
    const s = wordScore(w, t);
    if (!s) return 0;
    total += s;
  }
  return total;
}

/** Rank items by the best score over their fields. Fields can be weighted: [[text, weight], …]. */
export function fuzzyRank(query, items, fields) {
  const out = [];
  for (const item of items) {
    let best = 0;
    for (const [text, weight = 1] of fields(item)) {
      const s = fuzzyScore(query, text) * weight;
      if (s > best) best = s;
    }
    if (best > 0) out.push({ item, score: best });
  }
  return out.sort((a, b) => b.score - a.score);
}
