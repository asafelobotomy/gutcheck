// Bundled end-of-life table for the runtimes GutCheck reads from version pins. Scans never fetch it:
// the table ships with the app and says when it was written (AS_OF), so a later opt-in refresh from
// endoflife.date only has to produce the same shape. Dates were checked against each project's own page
// on AS_OF (see docs/sources.md). `eol` is the last day of support; null means no end date is set yet.
// Python and Go cycles are keyed "major.minor", Node by major. `released` feeds the advice only.
// A version older than the oldest cycle listed is treated as end of life with no date.

const AS_OF = '2026-11-09';

const PRODUCTS = {
  node: {
    label: 'Node.js',
    source: 'https://nodejs.org/en/about/previous-releases',
    cross: 'https://endoflife.date/api/v1/products/nodejs/',
    cycles: {
      '18': { eol: '2025-04-30', released: '2022-04-19' },
      '19': { eol: '2023-06-01', released: '2022-10-18' },
      '20': { eol: '2026-04-30', released: '2023-04-18' },
      '21': { eol: '2024-06-01', released: '2023-10-17' },
      '22': { eol: '2027-04-30', released: '2024-04-24' },
      '23': { eol: '2025-06-01', released: '2024-10-16' },
      '24': { eol: '2028-04-30', released: '2025-05-06' },
      '25': { eol: '2026-06-01', released: '2025-10-15' },
      '26': { eol: '2029-04-30', released: '2026-05-05' },
    },
  },
  python: {
    label: 'Python',
    source: 'https://devguide.python.org/versions/',
    cross: 'https://endoflife.date/api/v1/products/python/',
    cycles: {
      '3.8': { eol: '2024-10-07', released: '2019-10-14' },
      '3.9': { eol: '2025-10-31', released: '2020-10-05' },
      '3.10': { eol: '2026-10-01', released: '2021-10-04' },
      '3.11': { eol: '2027-10-31', released: '2022-10-24' },
      '3.12': { eol: '2028-10-31', released: '2023-10-02' },
      '3.13': { eol: '2029-10-31', released: '2024-10-07' },
      '3.14': { eol: '2030-10-31', released: '2025-10-07' },
      '3.15': { eol: '2031-10-31', released: '2026-10-09' },
    },
  },
  go: {
    label: 'Go',
    source: 'https://go.dev/doc/devel/release',
    cross: 'https://endoflife.date/api/v1/products/go/',
    // Policy: a major release is supported until two newer majors exist, so 1.25 ended when 1.27 shipped.
    // The newest two have no end date yet.
    cycles: {
      '1.22': { eol: '2025-02-11', released: '2024-02-06' },
      '1.23': { eol: '2025-08-12', released: '2024-08-13' },
      '1.24': { eol: '2026-02-10', released: '2025-02-11' },
      '1.25': { eol: '2026-08-19', released: '2025-08-12' },
      '1.26': { eol: null, released: '2026-02-10' },
      '1.27': { eol: null, released: '2026-08-19' },
    },
  },
};

module.exports = { AS_OF, PRODUCTS };
