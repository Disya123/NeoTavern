const fs = require('fs');
const m = fs.readFileSync('crates/runtime-kernel/src/lib.rs', 'utf8');
const dispatchBlock = m.slice(m.indexOf('let result = match op {'), m.indexOf('let result = match op {') + 80000);
const arms = [...dispatchBlock.matchAll(/^\s*"([a-z0-9.]+)"\s*=>/gm)].map((x) => x[1]);
const unique = [...new Set(arms)].sort();
console.log('dispatch arms:', unique.length);
console.log(unique.join('\n'));
