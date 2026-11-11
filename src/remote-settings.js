// Settings for repos that are on GitHub but not cloned in the workspace (settings.json, key `remote`).
// Everything is checked here, so the listing, the cache and the UI only ever see clean values.

// GitHub's own rules: owners and orgs are letters, digits and single hyphens (no underscore, so a
// cache folder named <owner>__<name> splits back unambiguously); names are letters, digits, . _ -,
// and never only dots.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const validOwner = (o) => typeof o === 'string' && OWNER_RE.test(o);
const validName = (n) => typeof n === 'string' && NAME_RE.test(n) && !/^\.+$/.test(n);
const validRef = (r) => !!r && validOwner(r.owner) && validName(r.name);

const DEFAULTS = Object.freeze({ enabled: false, orgs: [], forks: false, archived: false, skip: [], maxSizeMB: 500, cacheMaxGB: 5 });

const positive = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const unique = (a) => [...new Set(a)];

function normalizeRemoteSettings(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = (v) => (Array.isArray(v) ? v : []);
  return {
    enabled: s.enabled === true,
    orgs: unique(list(s.orgs).filter(validOwner)),
    forks: s.forks === true,
    archived: s.archived === true,
    skip: unique(list(s.skip).filter((x) => {
      if (typeof x !== 'string') return false;
      const parts = x.split('/');
      return parts.length === 2 && validRef({ owner: parts[0], name: parts[1] });
    })),
    maxSizeMB: positive(s.maxSizeMB, DEFAULTS.maxSizeMB),
    cacheMaxGB: positive(s.cacheMaxGB, DEFAULTS.cacheMaxGB),
  };
}

module.exports = { normalizeRemoteSettings, validRef, validOwner, validName, DEFAULTS };
