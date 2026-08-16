const fs = require('fs');
const m = fs.readFileSync('packages/contracts/src/wire/registry.ts', 'utf8');
const ops = [...m.matchAll(/\bop\(\s*['"]([a-z0-9.]+)['"]/g)].map((x) => x[1]);
const unique = [...new Set(ops)];
console.log('op() calls:', ops.length, 'unique:', unique.length);
console.log(unique.join('\n'));
