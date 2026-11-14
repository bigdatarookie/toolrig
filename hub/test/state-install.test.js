import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, rmSync, realpathSync, symlinkSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { manage, acceptedPin } from '../../scripts/toolrig-state-install.mjs';
const repo=resolve(import.meta.dirname,'../..');
const git=(args,cwd)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
test('managed State installs, fails before selection, verifies dependencies, updates and rolls back without native reads',()=>{
  const temp=realpathSync(mkdtempSync(join(tmpdir(),'state-installer-'))),root=join(temp,'managed state'),source=join(temp,'source');
  const savedPath=process.env.PATH;
  try{
    // Isolated Git fixture uses unchanged State payload in this checkout; works in shallow CI clones.
    mkdirSync(source);git(['init','-q'],source);git(['config','user.email','fixture@local'],source);git(['config','user.name','Fixture'],source);
    for(const f of ['package.json','package-lock.json','src/state-cli.js',...['native','cache','projection','tool','mcp'].map(n=>'src/state/'+n+'.js')]) {
      const path=join(source,'hub',f);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,readFileSync(join(repo,'hub',f)));
    }
    git(['add','.'],source);git(['commit','-qm','exact accepted State payload'],source);const pin1=git(['rev-parse','HEAD'],source);
    writeFileSync(join(source,'hub/src/state/native.js'),readFileSync(join(source,'hub/src/state/native.js'),'utf8')+'\n// Installer update fixture.\n');
    git(['commit','-qam','fixture revision'],source);const pin2=git(['rev-parse','HEAD'],source);
    const legacy=join(root,'b7b13d784a7b');mkdirSync(legacy,{recursive:true});writeFileSync(join(legacy,'retained'),'old artifact');
    const r1=manage({action:'install',root,source,revision:pin1});assert.equal(r1.previous,null);
    assert.equal(manage({action:'status',root}).selected,pin1);
    const publicStatus=JSON.parse(execFileSync(process.execPath,[join(repo,'scripts/toolrig-state-install.mjs'),'status','--root',root],{encoding:'utf8'}));assert.equal(publicStatus.selected,pin1);
    const bin=join(root,'bin/toolrig-state'),before=readFileSync(bin,'utf8');
    const out=execFileSync(bin,['--help'],{encoding:'utf8',env:{...process.env,PATH:'/no-native-cli-here'}});
    assert.match(out,/--owner/);assert.match(out,/--id/);
    chmodSync(bin,0o644);assert.throws(()=>manage({action:'status',root}),/launcher_integrity_failed/);chmodSync(bin,0o755);
    // Simulated package fetch failure must leave current and launcher untouched.
    const fakeBin=join(temp,'fakebin');mkdirSync(fakeBin);writeFileSync(join(fakeBin,'npm'),'#!/bin/sh\nexit 27\n',{mode:0o755});
    process.env.PATH=fakeBin+':'+savedPath;
    assert.throws(()=>manage({action:'install',root,source,revision:pin2}));
    assert.equal(readlinkSync(join(root,'current')),'artifacts/'+pin1);
    assert.equal(readFileSync(bin,'utf8'),before);assert.ok(!existsSync(join(root,'artifacts',pin2)));
    process.env.PATH=savedPath;
    mkdirSync(join(root,'.install-lock'));
    assert.throws(()=>manage({action:'install',root,source,revision:pin2}),/EEXIST/);rmSync(join(root,'.install-lock'),{recursive:true});
    const r2=manage({action:'install',root,source,revision:pin2});assert.equal(r2.previous,pin1);assert.equal(r2.rollback.revision,pin1);
    manage({action:'rollback',root,revision:pin1});assert.equal(manage({action:'status',root}).selected,pin1);
    assert.ok(existsSync(join(root,'artifacts',pin2)));assert.equal(readFileSync(join(legacy,'retained'),'utf8'),'old artifact');
    // Both source and dependency corruption fail closed; reinstall never silently repairs immutable artifacts.
    const dependency=join(root,'artifacts',pin2,'node_modules/zod/package.json');const dependencyBytes=readFileSync(dependency);writeFileSync(dependency,'{}');
    assert.throws(()=>manage({action:'rollback',root,revision:pin2}),/artifact_integrity_failed/);
    assert.equal(readlinkSync(join(root,'current')),'artifacts/'+pin1);
    writeFileSync(join(root,'artifacts',pin1,'hub/src/state/native.js'),'corrupt');
    assert.throws(()=>manage({action:'status',root}),/artifact_integrity_failed/);
    assert.throws(()=>manage({action:'install',root,source,revision:pin1}),/artifact_integrity_failed/);
    writeFileSync(dependency,dependencyBytes);
    manage({action:'rollback',root,revision:pin2});assert.equal(manage({action:'status',root}).selected,pin2);
    assert.throws(()=>manage({action:'rollback',root,revision:pin1}),/artifact_integrity_failed/);
  }finally{process.env.PATH=savedPath;rmSync(temp,{recursive:true,force:true});}
});
test('unknown root, launcher and selector resources are preserved',()=>{
 const temp=realpathSync(mkdtempSync(join(tmpdir(),'state-installer-')));
 try {
  const root=join(temp,'root');mkdirSync(root);writeFileSync(join(root,'current'),'owner file');
  assert.throws(()=>manage({action:'rollback',root,revision:acceptedPin}),/current_must_be_managed_symlink/);
  assert.equal(readFileSync(join(root,'current'),'utf8'),'owner file');
  rmSync(join(root,'current'));mkdirSync(join(root,'bin'));writeFileSync(join(root,'bin/toolrig-state'),'owner launcher');
  assert.throws(()=>manage({action:'install',root,source:repo}),/launcher_integrity_failed/);
  assert.equal(readFileSync(join(root,'bin/toolrig-state'),'utf8'),'owner launcher');
  const alias=join(temp,'alias');symlinkSync(root,alias);assert.throws(()=>manage({action:'install',root:alias,source:repo}),/directory_required/);
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test('status refuses symlinked managed children before executing any artifact entrypoint',()=>{
  for(const redirected of ['artifacts','bin']) {
    const temp=realpathSync(mkdtempSync(join(tmpdir(),'state-status-symlink-'))),root=join(temp,'root');
    try {
      mkdirSync(root);const outside=join(temp,'outside');mkdirSync(outside);
      const artifactParent=redirected==='artifacts'?outside:join(root,'artifacts');
      mkdirSync(artifactParent,{recursive:true});
      if(redirected==='artifacts')symlinkSync(outside,join(root,'artifacts'));
      const dir=join(artifactParent,acceptedPin);mkdirSync(dir);
      const marker=join(temp,'entry-executed');
      const content={'entry.mjs':`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');console.log('--owner --id');`};
      const sourceHashes={};
      for(const f of ['hub/src/state-cli.js',...['native','cache','projection','tool','mcp'].map(n=>`hub/src/state/${n}.js`)]) {
        content[f]='// synthetic fixture';sourceHashes[f]=createHash('sha256').update(content[f]).digest('hex');
      }
      for(const f of Object.keys(content)){mkdirSync(resolve(join(dir,f),'..'),{recursive:true});writeFileSync(join(dir,f),content[f]);}
      const hashes={};
      function digest(path,prefix=''){for(const item of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){const rel=prefix+item.name;if(item.isDirectory())digest(join(path,item.name),rel+'/');else hashes[rel]=createHash('sha256').update(readFileSync(join(path,item.name))).digest('hex');}}
      digest(dir);
      writeFileSync(join(dir,'install.json'),JSON.stringify({schema:'toolrig.state-install/1',sourcePin:acceptedPin,nodeRequirement:'>=24 <25',hashes,sourceHashes}));
      symlinkSync('artifacts/'+acceptedPin,join(root,'current'));
      const bin=redirected==='bin'?outside:join(root,'bin');mkdirSync(bin,{recursive:true});
      if(redirected==='bin')symlinkSync(outside,join(root,'bin'));
      const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
      writeFileSync(join(bin,'toolrig-state'),'#!/bin/sh\nexec '+quote(process.execPath)+' '+quote(join(root,'current/entry.mjs'))+' "$@"\n',{mode:0o755});
      let error;try{manage({action:'status',root});}catch(e){error=e;}
      assert.equal(existsSync(marker),false,'must reject '+redirected+' before executing entrypoint');
      assert.match(error?.message??'',/directory_required/);
      assert.equal(readlinkSync(join(root,'current')),'artifacts/'+acceptedPin);
      assert.ok(existsSync(join(dir,'install.json')),'outside files must remain intact');
    }finally{rmSync(temp,{recursive:true,force:true});}
  }
});
