// Name and header patterns for local dev secrets. Names are matched first; only the first bytes
// of a file are ever read (to tell SSH keys from TLS keys), and contents are never returned
// beyond that header, logged or reported.

const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

// A secret is never this large; bigger files are usually fixtures or bundles.
const MAX_SECRET_BYTES = 1024 * 1024;

// Env files (not their templates), private keys and credential stores, by name only (never read).
const SECRET_NAME = new RegExp('^(?:\\.env(?:\\..+)?|\\.netrc|\\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)'
  + '|.+\\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision)'
  + '|credentials\\.json|service-account.*\\.json|.*-credentials\\.json|client_secret.*\\.json|key\\.properties)$', 'i');
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist|defaults)$/i;

const looksSecret = (p) => {
  const b = p.split('/').pop();
  return !/\.pub$/i.test(b) && SECRET_NAME.test(b) && !ENV_TEMPLATE.test(b);
};

const isFixturePath = (p) => p.split('/').slice(0, -1).some((s) => /^(?:test|tests|testdata|fixtures|__fixtures__)$/.test(s));

// 'ssh' for OpenSSH keys, and for legacy PEM RSA/DSA/EC keys only when SSH context (the .ssh dir
// or an id_* name) says so; 'pem' for other private keys (TLS); null if not a private key header.
const classifyHead = (firstLine, { inSshDir, name }) => {
  const l = String(firstLine).trim();
  if (/^-----BEGIN OPENSSH PRIVATE KEY-----$/.test(l)) return 'ssh';
  if (/^-----BEGIN (?:RSA |DSA |EC )PRIVATE KEY-----$/.test(l)) return inSshDir || /^id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(name) ? 'ssh' : 'pem';
  if (/^-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----$/.test(l)) return 'pem';
  return null;
};

// Public-key fingerprint of an OpenSSH-format private key (readable without the passphrase,
// as the public blob is stored in the clear). Same output as `ssh-keygen -lf`.
const opensshFingerprint = (text) => {
  try {
    const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(String(text));
    if (!m) return null;
    const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    const magic = Buffer.from('openssh-key-v1\0');
    if (buf.length < magic.length || !buf.subarray(0, magic.length).equals(magic)) return null;
    let o = magic.length;
    const u32 = () => { if (o + 4 > buf.length) throw new RangeError('eof'); const v = buf.readUInt32BE(o); o += 4; return v; };
    const str = () => { const n = u32(); if (n > buf.length - o) throw new RangeError('eof'); const s = buf.subarray(o, o + n); o += n; return s; };
    str(); str(); str(); // cipher, kdf, kdf options
    if (u32() < 1) return null;
    const blob = str();
    const tl = blob.readUInt32BE(0);
    if (blob.length < 4 + tl) return null;
    const type = blob.subarray(4, 4 + tl).toString('latin1');
    return { type, fingerprint: 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '') };
  } catch { return null; }
};

const readHead = async (file, bytes = 4096) => {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally { await fh.close(); }
};

module.exports = { looksSecret, isFixturePath, classifyHead, opensshFingerprint, readHead, MAX_SECRET_BYTES };
