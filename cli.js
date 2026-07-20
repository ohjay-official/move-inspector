#!/usr/bin/env node
/**
 * Move Inspector CLI
 * Same heuristic access-control scan as the web app, runnable in a terminal or CI pipeline.
 *
 * Usage:
 *   node cli.js <package-id> [--network mainnet|testnet|devnet] [--json] [--no-fail]
 *
 * Exit codes:
 *   0 — scan completed, no WARN-level flags (or --no-fail was passed)
 *   1 — scan completed, at least one WARN-level flag found (useful for CI gating)
 *   2 — request failed (bad address, network error, etc.)
 *
 * Zero dependencies — uses Node's built-in fetch (Node 18+).
 */

const RPC = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet:  'https://fullnode.devnet.sui.io:443',
};

const COLOR = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  blue: '\x1b[34m', amber: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m',
};
function c(color, s){ return process.stdout.isTTY ? COLOR[color] + s + COLOR.reset : s; }

function parseArgs(argv){
  const args = { network: 'mainnet', json: false, failOnWarn: true, pkg: null };
  for(let i=0; i<argv.length; i++){
    const a = argv[i];
    if(a === '--network'){ args.network = argv[++i]; }
    else if(a === '--json'){ args.json = true; }
    else if(a === '--no-fail'){ args.failOnWarn = false; }
    else if(!a.startsWith('--')){ args.pkg = a; }
  }
  return args;
}

async function rpcCall(network, method, params){
  const res = await fetch(RPC[network], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if(!res.ok) throw new Error('RPC request failed: HTTP ' + res.status);
  const json = await res.json();
  if(json.error) throw new Error(json.error.message || 'RPC error');
  return json.result;
}

function typeToString(t){
  if(t === null || t === undefined) return '';
  if(typeof t === 'string') return t;
  if(t.Struct){
    const s = t.Struct;
    const params = (s.typeArguments || []).map(typeToString).join(', ');
    return s.address.slice(0,6) + '..::' + s.module + '::' + s.name + (params ? '<' + params + '>' : '');
  }
  if(t.Vector) return 'vector<' + typeToString(t.Vector) + '>';
  if(t.Reference) return '&' + typeToString(t.Reference);
  if(t.MutableReference) return '&mut ' + typeToString(t.MutableReference);
  if(t.TypeParameter !== undefined) return 'T' + t.TypeParameter;
  return JSON.stringify(t);
}
function paramList(params){ return (params || []).map(typeToString); }

function looksPrivileged(name){
  return /^(mint|burn|withdraw|admin_|set_|update_|remove_|add_|freeze_|upgrade_|pause_|unpause_|transfer_ownership|init_admin)/i.test(name);
}
function hasCapParam(params){ return params.some(p => /Cap|Admin|Owner|Witness/i.test(p)); }

function buildChecklist(modules){
  const flags = [];
  let totalPublic = 0, totalEntry = 0, totalStructsNoStore = 0;

  Object.entries(modules).forEach(([modName, mod]) => {
    Object.entries(mod.exposedFunctions || {}).forEach(([fnName, fn]) => {
      const params = paramList(fn.parameters);
      const isPublic = fn.visibility === 'Public';
      if(isPublic) totalPublic++;
      if(fn.isEntry) totalEntry++;
      if(isPublic && looksPrivileged(fnName) && !hasCapParam(params)){
        flags.push({
          level: 'warn',
          module: modName,
          fn: fnName,
          text: `${modName}::${fnName} looks privileged by name but takes no capability/admin/witness-typed parameter. Verify it actually restricts who can call it.`,
        });
      }
    });
    Object.entries(mod.structs || {}).forEach(([, st]) => {
      const abilities = (st.abilities && st.abilities.abilities) || [];
      if(abilities.includes('key') && !abilities.includes('store')) totalStructsNoStore++;
    });
  });

  if(totalStructsNoStore > 0){
    flags.push({ level: 'info', text: `${totalStructsNoStore} object type(s) have 'key' but not 'store' — can't be wrapped or moved with generic transfer functions. Often intentional.` });
  }
  if(totalPublic > 0 && totalEntry === 0){
    flags.push({ level: 'info', text: `Exposes ${totalPublic} public function(s) but none are 'entry' — only callable from Move code or PTBs, not directly from a wallet UI.` });
  }
  return flags;
}

function printReport(pkg, network, modules, flags){
  const moduleNames = Object.keys(modules);
  const totalFns = moduleNames.reduce((a,m)=>a+Object.keys(modules[m].exposedFunctions||{}).length,0);
  const totalStructs = moduleNames.reduce((a,m)=>a+Object.keys(modules[m].structs||{}).length,0);

  console.log('');
  console.log(c('bold', 'Move Inspector') + c('dim', '  —  ' + network));
  console.log(c('dim', pkg));
  console.log(c('dim', '─'.repeat(60)));
  console.log(`${moduleNames.length} modules · ${totalFns} functions · ${totalStructs} structs`);
  console.log('');

  console.log(c('bold', 'Access-control scan (heuristic)'));
  if(flags.length === 0){
    console.log(c('green', '  ✓ no flags raised'));
  } else {
    flags.forEach(f => {
      const tag = f.level === 'warn' ? c('amber', '[WARN]') : c('cyan', '[INFO]');
      console.log('  ' + tag + ' ' + f.text);
    });
  }
  console.log(c('dim', '  Pattern-based heuristics only — not a security audit.'));
  console.log('');

  const warnCount = flags.filter(f => f.level === 'warn').length;
  console.log(c('dim', '─'.repeat(60)));
  console.log(warnCount > 0
    ? c('amber', `${warnCount} warning-level flag(s) found.`)
    : c('green', 'No warning-level flags.'));
  console.log('');
}

async function main(){
  const args = parseArgs(process.argv.slice(2));
  if(!args.pkg){
    console.error('Usage: move-inspector <package-id> [--network mainnet|testnet|devnet] [--json] [--no-fail]');
    process.exit(2);
  }
  if(!RPC[args.network]){
    console.error(`Unknown network "${args.network}". Use mainnet, testnet, or devnet.`);
    process.exit(2);
  }

  try{
    const modules = await rpcCall(args.network, 'sui_getNormalizedMoveModulesByPackage', [args.pkg]);
    const moduleNames = Object.keys(modules || {});
    if(moduleNames.length === 0){
      console.error('No modules found for that package ID on ' + args.network + '.');
      process.exit(2);
    }
    const flags = buildChecklist(modules);
    const warnCount = flags.filter(f => f.level === 'warn').length;

    if(args.json){
      console.log(JSON.stringify({
        package: args.pkg, network: args.network,
        moduleCount: moduleNames.length, flags,
      }, null, 2));
    } else {
      printReport(args.pkg, args.network, modules, flags);
    }

    if(args.failOnWarn && warnCount > 0) process.exit(1);
    process.exit(0);
  } catch(err){
    console.error(c('red', 'Error: ') + (err.message || String(err)));
    process.exit(2);
  }
}

main();
