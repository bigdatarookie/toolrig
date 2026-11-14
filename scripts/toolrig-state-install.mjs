#!/usr/bin/env node
// Standalone CLI installer. No runtime registration or native State queries.
import { mkdirSync, lstatSync, readFileSync, writeFileSync, readdirSync, renameSync, symlinkSync, readlinkSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
export const acceptedPin = 'a8f47e9ffdd5404dabd93c41e313129f8e6529a4';
const files = ['hub/src/state-cli.js', ...['native','cache','projection','tool','mcp'].map(n=>`hub/src/state/${n}.js`)];
const help = 'toolrig-state --rig <current-rig> --project <context> --filter active|all [--seat <seat@rig> | --owner <seat@rig> ... [--id <qitem> ...]] [--cursor <private-opaque>]';
const hash = b=>createHash('sha256').update(b).digest('hex');
function run(command,args,cwd) { return execFileSync(command,args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,stdio:['ignore','pipe','pipe']}); }
function realDirectory(path) {
  if(lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())throw Error('directory_required:'+path);
}
function safeRoot(root) {
  // Refuse symlink ancestors, including an accidental redirected managed root.
  let p=root;
  for(;;) { if(existsSync(p))realDirectory(p);if(p===dirname(p))break;p=dirname(p); }
}
function safeManagedChildren(root) {
  // Check intermediate children before selected() can follow current and run help.
  for(const name of ['artifacts','bin']) {
    const path=join(root,name);
    try{lstatSync(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    realDirectory(path);
  }
}
function inventory(dir,prefix='') {
  const out={};
  for(const n of readdirSync(join(dir,prefix)).sort()) {
    const rel=prefix?prefix+'/'+n:n, st=lstatSync(join(dir,rel));
    if(st.isDirectory())Object.assign(out,inventory(dir,rel));
    else if(st.isFile())out[rel]=hash(readFileSync(join(dir,rel)));
    else throw Error('non_regular_artifact:'+rel);
  }
  return out;
}
function verify(root,pin) {
  if(!/^[a-f0-9]{40}$/.test(pin))throw Error('full_source_sha_required');
  const dir=join(root,'artifacts',pin);realDirectory(dir);
  const manifestPath=join(dir,'install.json');
  if(!lstatSync(manifestPath).isFile()||lstatSync(manifestPath).isSymbolicLink())throw Error('invalid_manifest');
  const m=JSON.parse(readFileSync(manifestPath));
  if(m.schema!=='toolrig.state-install/1'||m.sourcePin!==pin||m.nodeRequirement!=='>=24 <25'||!m.hashes||!m.sourceHashes)throw Error('invalid_manifest');
  const actual=inventory(dir);delete actual['install.json'];
  if(JSON.stringify(actual)!==JSON.stringify(m.hashes))throw Error('artifact_integrity_failed');
  for(const f of files)if(m.sourceHashes[f]!==actual[f])throw Error('source_integrity_failed');
  // Imports the actual State parser and dependency, with no native invocation.
  const output=run(process.execPath,[join(dir,'entry.mjs'),'--help']);
  if(!output.includes('--owner')||!output.includes('--id'))throw Error('owner_id_help_missing');
  return m;
}
function selected(root,checkIntegrity=true) {
  const p=join(root,'current');let st;
  try{st=lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!st.isSymbolicLink())throw Error('current_must_be_managed_symlink');
  const target=readlinkSync(p), match=/^artifacts\/([a-f0-9]{40})$/.exec(target);
  if(!match)throw Error('unrecognized_current_target');
  if(checkIntegrity)verify(root,match[1]);return match[1];
}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
function launcher(root) {return '#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(join(root,'current','entry.mjs'))+' "$@"\n';}
function checkLauncher(root) {
  const p=join(root,'bin','toolrig-state');
  if(!lstatSync(p).isFile()||lstatSync(p).isSymbolicLink()||!(lstatSync(p).mode&0o111)||readFileSync(p,'utf8')!==launcher(root))throw Error('launcher_integrity_failed');
}
export function manage({action,root,source,revision=acceptedPin}) {
  if(Number(process.versions.node.split('.')[0])!==24)throw Error('node24_required');
  root=resolve(root);safeRoot(root);safeManagedChildren(root);
  if(action==='status') {const pin=selected(root);if(!pin)throw Error('no_managed_selection');checkLauncher(root);return {selected:pin,launcher:join(root,'bin','toolrig-state'),manifest:verify(root,pin)};}
  if(!['install','rollback'].includes(action))throw Error('action_must_be_install_status_rollback');
  mkdirSync(root,{recursive:true});safeRoot(root);
  const lock=join(root,'.install-lock');mkdirSync(lock); // Concurrent writers fail before changing selection.
  let stage,temporaryLink;
  try {
    const previous=selected(root,action!=='rollback');
    mkdirSync(join(root,'artifacts'),{recursive:true});realDirectory(join(root,'artifacts'));
    mkdirSync(join(root,'bin'),{recursive:true});realDirectory(join(root,'bin'));
    const launchPath=join(root,'bin','toolrig-state');
    if(existsSync(launchPath))checkLauncher(root);
    if(!/^[a-f0-9]{40}$/.test(revision))throw Error('full_source_sha_required');
    const dest=join(root,'artifacts',revision);
    if(action==='install'&&!existsSync(dest)) {
      if(!source)throw Error('source_checkout_required');source=resolve(source);
      if(run('git',['rev-parse',revision+'^{commit}'],source).trim()!==revision)throw Error('exact_commit_required');
      const show=path=>run('git',['show',revision+':'+path],source);
      const pkg=JSON.parse(show('hub/package.json')),lockfile=JSON.parse(show('hub/package-lock.json'));
      const zod=lockfile.packages['node_modules/zod'];
      if(pkg.dependencies.zod!==zod.version||zod.dependencies||!zod.integrity||!zod.resolved.startsWith('https://registry.npmjs.org/zod/'))throw Error('unsupported_dependency_lock');
      stage=join(root,'artifacts','.stage-'+randomUUID());mkdirSync(stage);
      const sourceHashes={};
      for(const f of files){const b=show(f);mkdirSync(dirname(join(stage,f)),{recursive:true});writeFileSync(join(stage,f),b);sourceHashes[f]=hash(b);}
      // Minimal pinned CLI dependency closure; no Hub services or install hooks.
      const minimal={name:'toolrig-state-standalone',version:'0.0.0',private:true,type:'module',engines:{node:'>=24 <25'},dependencies:{zod:zod.version}};
      writeFileSync(join(stage,'package.json'),JSON.stringify(minimal));
      writeFileSync(join(stage,'package-lock.json'),JSON.stringify({name:minimal.name,version:minimal.version,lockfileVersion:3,requires:true,packages:{'':minimal,'node_modules/zod':zod}}));
      writeFileSync(join(stage,'entry.mjs'),`import { filterSchema } from './hub/src/state/projection.js';\nif(Number(process.versions.node.split('.')[0])!==24)throw Error('node24_required');\nif(process.argv.length===3&&process.argv[2]==='--help'){filterSchema.parse({states:'all',owners:['help@local'],ids:['help-id']});console.log(${JSON.stringify(help)});}else{await import('./hub/src/state-cli.js');}\n`);
      run('npm',['ci','--ignore-scripts','--omit=dev','--no-audit','--no-fund'],stage);
      const hashes=inventory(stage);
      writeFileSync(join(stage,'install.json'),JSON.stringify({schema:'toolrig.state-install/1',sourcePin:revision,nodeRequirement:'>=24 <25',nodeExecutable:process.execPath,dependency:{zod:zod.version,integrity:zod.integrity},sourceHashes,hashes,mode:'standalone-cli; no runtime registration',installedAt:new Date().toISOString()},null,2)+'\n');
      // Verify before publishing; rename never merges with an existing artifact.
      const testOutput=run(process.execPath,[join(stage,'entry.mjs'),'--help']);
      if(!testOutput.includes('--owner')||!testOutput.includes('--id'))throw Error('owner_id_help_missing');
      renameSync(stage,dest);stage=null;
    }
    verify(root,revision);
    // Stable launcher is immutable under this Node path. Never replace an unknown file.
    if(!existsSync(launchPath))writeFileSync(launchPath,launcher(root),{flag:'wx',mode:0o755});
    checkLauncher(root);
    temporaryLink=join(root,'.current-'+randomUUID());symlinkSync('artifacts/'+revision,temporaryLink);
    renameSync(temporaryLink,join(root,'current'));temporaryLink=null; // Commit point.
    return {selected:revision,previous,launcher:launchPath,manifest:join(dest,'install.json'),rollback:previous?{action:'rollback',revision:previous}:null};
  } finally {if(stage)rmSync(stage,{recursive:true,force:true});if(temporaryLink)rmSync(temporaryLink,{force:true});rmSync(lock,{recursive:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{const {values,positionals}=parseArgs({allowPositionals:true,options:{root:{type:'string'},source:{type:'string'},revision:{type:'string'}}});if(positionals.length!==1)throw Error('usage: install|status|rollback --root PATH [--source CHECKOUT --revision FULL_SHA]');console.log(JSON.stringify(manage({action:positionals[0],root:values.root??join(homedir(),'.local/share/toolrig/state-v07'),source:values.source,revision:values.revision})));}
  catch(e){console.error(JSON.stringify({status:'error',error:e.message}));process.exitCode=1;}
}
