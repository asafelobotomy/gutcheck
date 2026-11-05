// Language table and a small lexer that blanks out strings and separates comments from code, so the
// magic-number, debug and marker checks never trip over text inside strings or comments.
// It is not a parser: it only has to be right about where strings and comments begin and end.

// fam: 'c' = // and /* */ comments, 'hash' = # comments, 'plain' = no lexing (LOC only).
const LANGS = {
  js: { lang: 'JavaScript', fam: 'c', tpl: true, regex: true }, mjs: { lang: 'JavaScript', fam: 'c', tpl: true, regex: true }, cjs: { lang: 'JavaScript', fam: 'c', tpl: true, regex: true }, jsx: { lang: 'JavaScript', fam: 'c', tpl: true, regex: true },
  ts: { lang: 'TypeScript', fam: 'c', tpl: true, regex: true }, tsx: { lang: 'TypeScript', fam: 'c', tpl: true, regex: true },
  py: { lang: 'Python', fam: 'hash', triple: true },
  go: { lang: 'Go', fam: 'c', tpl: true, charq: true },
  rs: { lang: 'Rust', fam: 'c', charq: true },
  java: { lang: 'Java', fam: 'c', charq: true }, kt: { lang: 'Kotlin', fam: 'c', charq: true }, cs: { lang: 'C#', fam: 'c', charq: true },
  c: { lang: 'C/C++', fam: 'c', charq: true }, h: { lang: 'C/C++', fam: 'c', charq: true }, cc: { lang: 'C/C++', fam: 'c', charq: true }, cpp: { lang: 'C/C++', fam: 'c', charq: true }, hpp: { lang: 'C/C++', fam: 'c', charq: true },
  swift: { lang: 'Swift', fam: 'c' }, php: { lang: 'PHP', fam: 'c' },
  rb: { lang: 'Ruby', fam: 'hash' }, sh: { lang: 'Shell', fam: 'hash' }, bash: { lang: 'Shell', fam: 'hash' },
  css: { lang: 'CSS', fam: 'plain' }, scss: { lang: 'CSS', fam: 'plain' }, html: { lang: 'HTML', fam: 'plain' }, vue: { lang: 'Vue', fam: 'plain' }, svelte: { lang: 'Svelte', fam: 'plain' },
};

const CHAR_RE = /^'(?:\\.[^']{0,8}|[^'\\\n])'/; // a character literal; anything else (a Rust lifetime, say) is not a string

// A "/" starts a regex literal (not a division) when the previous token cannot end an expression.
function regexAllowed(before) {
  const t = before.trimEnd();
  return t === '' || '(,=:[!&|?{};+-*%<>~^'.includes(t[t.length - 1]) || /\b(?:return|typeof|case)$/.test(t);
}

// Index just past the regex literal (and its flags) that opens at i, or -1 if this is not one.
function regexEnd(text, i) {
  let j = i + 1;
  let cls = false;
  while (j < text.length) {
    const c = text[j];
    if (c === '\n') return -1;
    if (c === '\\') { j += 2; continue; }
    if (c === '[') cls = true;
    else if (c === ']') cls = false;
    else if (c === '/' && !cls) { j++; while (/[a-z]/.test(text[j] || '')) j++; return j; }
    j++;
  }
  return -1;
}

// Returns { code: string[], comments: string[] }, one entry per source line (index = line number - 1).
function lex(text, spec) {
  const code = [];
  const comments = [];
  let cl = '';
  let cm = '';
  const nl = () => { code.push(cl); comments.push(cm); cl = ''; cm = ''; };
  const hash = spec.fam === 'hash';
  const n = text.length;
  let i = 0;

  // Skip a string that opens at i with quote q. Newlines inside are kept so line numbers stay right.
  const skipString = (q, multiline) => {
    let j = i + q.length;
    while (j < n) {
      const c = text[j];
      if (c === '\\') { if (text[j + 1] === '\n') nl(); j += 2; continue; }
      if (text.startsWith(q, j)) { j += q.length; break; }
      if (c === '\n') { if (!multiline) break; nl(); }
      j++;
    }
    i = j;
    cl += q[0] + q[0];
  };

  while (i < n) {
    const ch = text[i];
    if (ch === '\n') { nl(); i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (!hash && ch === '/' && text[i + 1] === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      cm += text.slice(i + 2, j);
      i = j;
      continue;
    }
    if (!hash && ch === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2);
      text.slice(i + 2, j < 0 ? n : j).split('\n').forEach((part, k) => { if (k) nl(); cm += part; });
      i = j < 0 ? n : j + 2;
      cl += ' ';
      continue;
    }
    if (hash && ch === '#') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      cm += text.slice(i + 1, j);
      i = j;
      continue;
    }
    if (spec.regex && ch === '/' && regexAllowed(cl)) {
      const j = regexEnd(text, i);
      if (j > 0) { cl += '/r/'; i = j; continue; }
    }
    if (ch === '"' || ch === "'" || (ch === '`' && spec.tpl)) {
      if (ch === "'" && spec.charq) {
        const m = CHAR_RE.exec(text.slice(i, i + 14));
        if (m) { cl += "''"; i += m[0].length; } else { cl += ch; i++; }
        continue;
      }
      if (spec.triple && text.startsWith(ch.repeat(3), i)) { skipString(ch.repeat(3), true); continue; }
      skipString(ch, ch === '`');
      continue;
    }
    cl += ch;
    i++;
  }
  nl();
  return { code, comments };
}

module.exports = { LANGS, lex };
