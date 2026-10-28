import { main } from './cli';

// `pnpm mimir ...` runs from the package folder; resolve inputs against the caller's folder
const cwd = process.env.INIT_CWD || process.cwd();
main(process.argv.slice(2), { out: s => console.log(s), err: s => console.error(s), cwd }).then(code => { process.exitCode = code; });
