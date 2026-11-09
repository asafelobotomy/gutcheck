// Text that came from a repo, GitHub or an agent is shown to people and LLMs. Control characters,
// zero-width and bidi characters and Unicode tag characters (U+E0000-E007F) can hide text or make it
// read differently from what it is, so they are replaced with spaces before anything shows it.
// (util.js may get its own printable(); the two are to be reconciled into this one set.)

const INVISIBLE_SRC = '[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]|[\\u{E0000}-\\u{E007F}]';
const INVISIBLE_RE = new RegExp(INVISIBLE_SRC, 'gu'); // for replace()
const hasInvisible = (s) => new RegExp(INVISIBLE_SRC, 'u').test(String(s));
// One line, invisible characters gone, at most n characters.
const flat = (s, n = Infinity) => String(s == null ? '' : s).replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

module.exports = { INVISIBLE_SRC, INVISIBLE_RE, hasInvisible, flat };
