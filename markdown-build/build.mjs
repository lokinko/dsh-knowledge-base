import {build,transform} from 'esbuild';
import postcss from 'postcss';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const resolve=createRequire(import.meta.url).resolve;
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(here);
const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const outfile=path.resolve(root,process.argv[2]||'client.js'),moduleId=process.argv[3]||manifest.name;
if(path.relative(root,outfile).startsWith('..'))throw new Error('Build output must stay in this repository');
const katexDir=path.join(path.dirname(resolve('katex/package.json')),'dist');
const ast=postcss.parse(await fs.readFile(path.join(katexDir,'katex.css'),'utf8'));
let fonts=0;
for(const face of ast.nodes.filter(node=>node.type==='atrule'&&node.name==='font-face')){
 for(const declaration of face.nodes){
  if(declaration.prop==='font-family')declaration.value=declaration.value.replaceAll('KaTeX_','TodoKaTeX_');
  if(declaration.prop==='src'){
   const match=/url\(([^)]+\.woff2)\)/.exec(declaration.value);if(!match)throw new Error('Missing WOFF2 font');
   const bytes=await fs.readFile(path.resolve(katexDir,match[1].replace(/["']/g,'')));
   declaration.value='url("data:font/woff2;base64,'+bytes.toString('base64')+'") format("woff2")';fonts++;
  }
 }
}
ast.walkDecls(/^font(?:-family)?$/,declaration=>{declaration.value=declaration.value.replace(/(?<!Todo)KaTeX_/g,'TodoKaTeX_');});
ast.walkRules(rule=>{if(rule.parent?.type==='atrule'&&/keyframes$/i.test(rule.parent.name))return;rule.selectors=rule.selectors.map(selector=>'.em-markdown '+selector);});
ast.walkDecls(declaration=>{if(/(?<!Todo)KaTeX_/.test(declaration.value))throw new Error('Unscoped KaTeX font reference in '+declaration.prop);});
const fontCss=(await transform(ast.toString(),{loader:'css',minify:true})).code;
// Bootstrap is genuine vendor CSS; React retains control of interactive behavior.
// Keep resets and component selectors inside explicitly owned .tm-bs regions.
const bootstrapDir=path.dirname(resolve('bootstrap/package.json'));
const bootstrapManifest=JSON.parse(await fs.readFile(path.join(bootstrapDir,'package.json'),'utf8'));
const bootstrapAst=postcss.parse(await fs.readFile(path.join(bootstrapDir,'dist/css/bootstrap.css'),'utf8'));
bootstrapAst.walkComments(comment=>{if(/sourceMappingURL=/.test(comment.text))comment.remove();});
const bootstrapAnimations=new Map();
bootstrapAst.walkAtRules(/keyframes$/i,rule=>{const original=rule.params.trim(),scoped='todo-bs-'+original;bootstrapAnimations.set(original,scoped);rule.params=scoped;});
bootstrapAst.walkDecls(/^(?:-webkit-)?animation(?:-name)?$/,declaration=>{
 for(const [original,scoped] of bootstrapAnimations)declaration.value=declaration.value.replace(new RegExp('(?<![\\w-])'+original+'(?![\\w-])','g'),scoped);
});
function scopeBootstrapSelector(selector){
 selector=selector.trim();
 if(/^(?::root|html|body)$/.test(selector))return ['.tm-bs'];
 if(/^\[data-bs-theme=(?:["']?)[\w-]+(?:["']?)\]$/.test(selector))return ['.tm-bs'+selector,selector+' .tm-bs'];
 return ['.tm-bs '+selector,'.tm-bs:is('+selector+')'];
}
bootstrapAst.walkRules(rule=>{
 if(rule.parent?.type==='atrule'&&/keyframes$/i.test(rule.parent.name))return;
 rule.selectors=rule.selectors.flatMap(scopeBootstrapSelector);
});
const bootstrapCss=(await transform(bootstrapAst.toString(),{loader:'css',minify:true,target:['chrome110'],legalComments:'inline'})).code;
const bootstrapCheck=postcss.parse(bootstrapCss);
let bootstrapRules=0,bootstrapDataUrls=0;
bootstrapCheck.walkRules(rule=>{
 if(rule.parent?.type==='atrule'&&/keyframes$/i.test(rule.parent.name))return;
 for(const selector of rule.selectors)if(!/(?:^|[\s])\.tm-bs(?:\b|[:.\[])/.test(selector))throw new Error('Unscoped Bootstrap selector: '+selector);
 bootstrapRules++;
});
bootstrapCheck.walkDecls(declaration=>{
 for(const match of declaration.value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)){
  const url=(match[1]??match[2]??match[3]).trim();
  if(!url.startsWith('data:'))throw new Error('External Bootstrap URL: '+url);
  bootstrapDataUrls++;
 }
});
await fs.writeFile(path.join(root,'bootstrap-scoped.css'),bootstrapCss,'utf8');
const result=await build({absWorkingDir:root,entryPoints:['client.source.js'],outfile,bundle:true,format:'iife',platform:'browser',target:['chrome110'],minify:true,legalComments:'eof',metafile:true,define:{__TODO_MODULE_ID__:JSON.stringify(moduleId),__TODO_KATEX_CSS__:JSON.stringify(fontCss),__TODO_BOOTSTRAP_CSS__:JSON.stringify(bootstrapCss)}});
if(Object.values(result.metafile.outputs).some(output=>output.imports.length))throw new Error('Browser artifact has unresolved imports');
const packageRoots=new Map([[bootstrapManifest.name+'@'+bootstrapManifest.version,{directory:bootstrapDir,manifest:bootstrapManifest}]]);
for(const input of Object.keys(result.metafile.inputs)){
 if(!input.includes('node_modules'))continue;
 let directory=path.dirname(path.resolve(root,input));
 while(directory!==path.dirname(directory)){
  try{const manifest=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));if(manifest.name&&manifest.version){packageRoots.set(manifest.name+'@'+manifest.version,{directory,manifest});break;}}catch{}
  directory=path.dirname(directory);
 }
}
const notices=['# Third-party notices','\nThis browser artifact bundles the following libraries. Original license texts follow.\n'];
for(const [name,{directory,manifest}] of [...packageRoots].sort(([a],[b])=>a.localeCompare(b))){
 const names=(await fs.readdir(directory)).filter(name=>/^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name));
 if(!names.length)throw new Error('No license text found for '+name);
 notices.push('\n## '+name+'\nLicense: '+JSON.stringify(manifest.license??'See text below')+'\n');
 for(const name of names)notices.push('\n'+await fs.readFile(path.join(directory,name),'utf8')+'\n');
}
await fs.writeFile(path.join(root,'THIRD_PARTY_NOTICES.md'),notices.join('\n').replaceAll('\r\n','\n').trimEnd()+'\n','utf8');
await fs.writeFile(path.join(here,'build-meta.json'),JSON.stringify({moduleId,fonts,bootstrap:{version:bootstrapManifest.version,bytes:Buffer.byteLength(bootstrapCss),rules:bootstrapRules,dataUrls:bootstrapDataUrls,externalUrls:0,scope:'.tm-bs'},bytes:(await fs.stat(outfile)).size,packages:[...packageRoots.keys()].sort(),metafile:result.metafile},null,2),'utf8');
console.log(`PASS: bundled ${moduleId}; ${fonts} local WOFF2 fonts; ${(await fs.stat(outfile)).size} bytes; no external imports; Bootstrap ${bootstrapManifest.version}: ${bootstrapRules} scoped rules, no external CSS URLs; ${packageRoots.size} third-party licenses retained.`);
