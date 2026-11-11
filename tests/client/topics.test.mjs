import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import postcss from 'postcss';
import {TopicsController,topicReferenceKey,normalizeTopicReference,applyReferenceOperation} from '../../src/client/topics/model.js';
import {createTopicsUI} from '../../src/client/topics/ui.js';

const noteRef=atomId=>({kind:'note',atomId});
const discussionRef=(seq=1)=>({kind:'discussion',sessionId:'session',seq});
const topic=(id='a',patch={})=>({id,question:'Question '+id,references:[],revision:1,createdAt:'2026-01-01',updatedAt:'2026-01-02',...patch});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turns=async()=>{for(let index=0;index<10;index++)await Promise.resolve();};
function setup(handler){
 const topics=new Map([['a',topic()],['b',topic('b')]]),calls=[];let libraryId='library-one';
 const request=async(path,input)=>{
  calls.push({path,input:structuredClone(input)});
  if(handler){const result=handler(path,input);if(result!==undefined)return await result;}
  if(path.endsWith('/discussions')){
   if(input.action==='search')return {libraryId,discussionAvailable:true,results:[{id:'result',title:'Original note',snippet:'exact snippet',reference:noteRef('atom')},{id:'discussion',title:'Discussion',speaker:'assistant',reference:discussionRef()}]};
   return {content:'  Original\r\n中文🙂\t\\literal  ',title:'Original source',speaker:'user',time:'2026-01-01',reference:input.reference};
  }
  if(input.action==='list')return {libraryId,topics:[...topics.values()].map(value=>{const {references,...metadata}=value;return {...structuredClone(metadata),referenceCount:references.length};}),total:topics.size};
  if(input.libraryId!==libraryId)throw Object.assign(new Error('library changed'),{code:'LIBRARY_CHANGED'});
  if(input.action==='get')return {libraryId,topic:structuredClone(topics.get(input.id)),binding:null};
  if(input.action==='create'){const value=topic('created',{question:input.question});topics.set(value.id,value);return {libraryId,topic:structuredClone(value),binding:null};}
  const old=topics.get(input.id);
  if(old.revision!==input.revision)throw Object.assign(new Error('conflict'),{code:'CONFLICT'});
  if(input.action==='delete'){topics.delete(input.id);return {libraryId,ok:true};}
  const value={...old,...(input.question!==undefined?{question:input.question}:{}),...(input.references?{references:input.references}:{}),revision:old.revision+1};topics.set(value.id,value);return {libraryId,topic:structuredClone(value),binding:null};
 };
 const controller=new TopicsController(request);
 return {controller,calls,topics,setLibrary(value){libraryId=value;},async ready(){controller.start();await turns();await controller.open('a');return controller;}};
}

test('topic control rules exclude the native conversation, including mobile and focus states',async()=>{
 const css=postcss.parse(await readFile(new URL('../../src/client/styles/topics.css',import.meta.url),'utf8'));
 const guarded=[];
 css.walkRules(rule=>{
  if(!/\.tp-page\s/.test(rule.selector)||!/(?:\b(?:label|input|textarea|button)\b|\.em-btn\b)/.test(rule.selector))return;
  guarded.push(rule.selector);assert(rule.selector.includes(':not(.nb-native-conversation *)'),'unscoped native control selector: '+rule.selector);
 });
 assert(guarded.some(selector=>selector.includes('textarea')));assert(guarded.some(selector=>selector.includes(':focus-visible')));assert(guarded.some(selector=>selector.includes(':disabled')));
 let mobileGuard=false;css.walkAtRules('media',rule=>{if(rule.params.includes('620px'))rule.walkRules(child=>{if(child.selector.includes('.tp-page button:not(.nb-native-conversation *)'))mobileGuard=true;});});assert(mobileGuard);
});

test('stable reference keys deduplicate labels while distinguishing kinds, sessions and message sequence',()=>{
 assert.equal(topicReferenceKey({...noteRef('a'),label:'One'}),topicReferenceKey({...noteRef('a'),label:'Two'}));
 assert.notEqual(topicReferenceKey(noteRef('session:1')),topicReferenceKey(discussionRef()));
 assert.notEqual(topicReferenceKey(discussionRef(1)),topicReferenceKey(discussionRef(2)));
 assert.throws(()=>normalizeTopicReference({kind:'discussion',sessionId:'session',seq:-1}));
 assert.throws(()=>normalizeTopicReference({kind:'note',atomId:''}));
 const source=[noteRef('a'),discussionRef(),noteRef('b')],before=structuredClone(source);
 assert.deepEqual(applyReferenceOperation(source,{kind:'add',reference:{...noteRef('a'),label:'other'}}),source);
 assert.deepEqual(applyReferenceOperation(source,{kind:'move',reference:noteRef('b'),direction:-1}),[noteRef('a'),noteRef('b'),discussionRef()]);
 assert.deepEqual(applyReferenceOperation(source,{kind:'remove',reference:discussionRef()}),[noteRef('a'),noteRef('b')]);
 assert.deepEqual(source,before);
});

test('long source titles fit the display-label limit without splitting emoji or changing source positions and original text',async()=>{
 for(const title of ['问'.repeat(400),'问'.repeat(299)+'🙂'+'题'.repeat(100),'问'.repeat(298)+'🙂'+'题'.repeat(100)]){
  const reference=discussionRef(42),body='  原文🙂\r\n'+title+'\t';
  const fixture=setup((path,input)=>input.action==='read'?{title,content:body,reference:input.reference}:undefined),controller=await fixture.ready();
  const question='题'.repeat(500);controller.input('questionInput',question);assert.equal(await controller.rename(),true);
  await controller.readSource({reference});assert.equal(await controller.addSelected(),true);
  const saved=fixture.calls.at(-1).input.references[0],expected=title.slice(0,title.charCodeAt(299)>=0xD800&&title.charCodeAt(299)<=0xDBFF?299:300);
  assert.equal(saved.label,expected);assert(saved.label.length<=300);assert(!/[\uD800-\uDBFF]$/.test(saved.label));
  assert.equal(topicReferenceKey(saved),topicReferenceKey(reference));assert.equal(saved.sessionId,'session');assert.equal(saved.seq,42);
  assert.equal(controller.snapshot().read.content,body);assert.equal(controller.snapshot().read.title,title);assert.equal(controller.snapshot().current.question,question);controller.stop();
 }
 const original={...noteRef('unchanged-atom'),label:'字'.repeat(299)+'🙂'+'字'.repeat(100)},normalized=normalizeTopicReference(original);
 assert.equal(normalized.atomId,original.atomId);assert.equal(normalized.label.length,299);assert.equal(original.label.length,401);
});

test('list accepts Host metadata summaries and refresh reads full current references without overwriting typed text',async()=>{
 const fixture=setup();fixture.controller.start();await turns();
 assert.equal(fixture.controller.snapshot().error,null);assert.equal(fixture.controller.snapshot().topics[0].referenceCount,0);assert.equal(fixture.controller.snapshot().topics[0].references,undefined);
 await fixture.controller.open('a');fixture.controller.input('questionInput','Retained user text');fixture.topics.set('a',topic('a',{question:'New saved question',revision:2,references:[discussionRef()]}));
 await fixture.controller.refresh();assert.equal(fixture.controller.snapshot().current.references.length,1);assert.equal(fixture.controller.snapshot().current.revision,2);assert.equal(fixture.controller.snapshot().questionInput,'Retained user text');fixture.controller.stop();
});

test('loading, searching and reading never automatically create questions, sources, summaries or notes',async()=>{
 const fixture=setup(),controller=await fixture.ready();controller.input('query','original');await controller.search();
 assert.equal(controller.snapshot().current.references.length,0);
 await controller.readSource(controller.snapshot().results[0]);
 assert.equal(controller.snapshot().read.content,'  Original\r\n中文🙂\t\\literal  ');
 assert(fixture.calls.every(({input})=>['list','get','search','read'].includes(input.action)));
 assert.equal(await controller.addSelected(),true);const write=fixture.calls.at(-1).input;
 assert.equal(write.action,'update');assert.equal(write.libraryId,'library-one');assert.equal(write.revision,1);
 assert.deepEqual(write.references,[{kind:'note',atomId:'atom',label:'Original source'}]);
 const count=fixture.calls.length;await controller.addSelected();assert.equal(fixture.calls.length,count,'duplicate add performs no write');controller.stop();
});

test('source gestures save each add, remove and order change immediately using the latest CAS revision',async()=>{
 const fixture=setup(),controller=await fixture.ready();
 await controller.references({kind:'add',reference:noteRef('a')});
 await controller.references({kind:'add',reference:discussionRef()});
 await controller.references({kind:'move',reference:discussionRef(),direction:-1});
 await controller.references({kind:'remove',reference:noteRef('a')});
 const writes=fixture.calls.filter(({input})=>input.action==='update').map(({input})=>input);
 assert.deepEqual(writes.map(input=>input.revision),[1,2,3,4]);
 assert.deepEqual(writes[2].references,[discussionRef(),noteRef('a')]);assert.deepEqual(controller.snapshot().current.references,[discussionRef()]);controller.stop();
});

test('question creation, explicit rename and metadata deletion preserve the intended API boundary',async()=>{
 const fixture=setup(),controller=await fixture.ready();
 controller.input('newQuestion','  A manual question  ');assert.equal(await controller.create(),true);assert.equal(controller.snapshot().current.question,'A manual question');
 controller.input('questionInput','Explicitly renamed');assert.equal(fixture.calls.at(-1).input.action,'create');
 assert.equal(await controller.rename(),true);assert.equal(controller.snapshot().current.question,'Explicitly renamed');
 assert.equal(await controller.delete(),true);assert.equal(controller.snapshot().current,null);
 assert.equal(fixture.calls.at(-1).path,'/api/dsh-note/topics');assert.equal(fixture.calls.at(-1).input.action,'delete');
 assert(!fixture.calls.some(call=>call.path.endsWith('/notes')||call.input.action==='start'));controller.stop();
});

test('conflict keeps user text and rebases a pending source gesture onto refreshed references',async()=>{
 const fixture=setup(),controller=await fixture.ready();
 controller.input('questionInput','Rename not submitted yet');
 fixture.topics.set('a',topic('a',{revision:2,references:[discussionRef()]}));
 assert.equal(await controller.references({kind:'add',reference:noteRef('candidate')}),false);
 assert.equal(controller.snapshot().error,'tpConflict');assert.equal(controller.snapshot().questionInput,'Rename not submitted yet');
 assert.equal(controller.snapshot().current.revision,2);assert.equal(controller.snapshot().candidate.operation.reference.atomId,'candidate');
 assert.equal(await controller.retryReferences(),true);
 assert.deepEqual(controller.snapshot().current.references,[discussionRef(),noteRef('candidate')]);assert.equal(controller.snapshot().questionInput,'Rename not submitted yet');assert.equal(controller.snapshot().candidate,null);controller.stop();
});

test('rename conflict retains the proposed question and retry uses the refreshed revision',async()=>{
 const fixture=setup(),controller=await fixture.ready();controller.input('questionInput','My retained question');fixture.topics.set('a',topic('a',{question:'Other window',revision:5}));
 assert.equal(await controller.rename(),false);assert.equal(controller.snapshot().questionInput,'My retained question');assert.equal(controller.snapshot().current.question,'Other window');
 assert.equal(await controller.rename(),true);assert.equal(fixture.calls.at(-1).input.revision,5);assert.equal(controller.snapshot().current.question,'My retained question');controller.stop();
});

test('older question replies and source reads cannot overwrite a newly selected question',async()=>{
 const oldGet=deferred(),oldRead=deferred();let holdGet=false;
 const fixture=setup((path,input)=>{if(holdGet&&input.action==='get'&&input.id==='a')return oldGet.promise;if(input.action==='read')return oldRead.promise;});
 const controller=await fixture.ready();
 const reading=controller.readSource({reference:noteRef('old')});holdGet=true;const opening=controller.open('a');await controller.open('b');
 oldGet.resolve({libraryId:'library-one',topic:topic('a',{question:'stale a'})});oldRead.resolve({content:'stale content',reference:noteRef('old')});await Promise.all([opening,reading]);
 assert.equal(controller.snapshot().current.id,'b');assert.equal(controller.snapshot().read,null);assert.equal(controller.snapshot().selectedSource,null);controller.stop();
});

test('a late source write cannot replace another question or its source list',async()=>{
 const pending=deferred();const fixture=setup((path,input)=>input.action==='update'?pending.promise:undefined),controller=await fixture.ready();
 const write=controller.references({kind:'add',reference:noteRef('old-candidate')});await controller.open('b');
 pending.resolve({libraryId:'library-one',topic:topic('a',{revision:2,references:[noteRef('old-candidate')]})});await write;
 assert.equal(controller.snapshot().current.id,'b');assert.deepEqual(controller.snapshot().current.references,[]);assert.equal(controller.snapshot().busy,false);controller.stop();
});

test('library switching invalidates in-flight search, reads, writes and native topic callbacks',async()=>{
 const pending=deferred();const fixture=setup((path,input)=>input.action==='search'?pending.promise:undefined),controller=await fixture.ready();
 controller.input('query','old');const searching=controller.search();fixture.setLibrary('library-two');await controller.refresh();
 pending.resolve({libraryId:'library-one',results:[{reference:noteRef('old')}],discussionAvailable:true});await searching;
 assert.equal(controller.snapshot().libraryId,'library-two');assert.equal(controller.snapshot().current,null);assert.deepEqual(controller.snapshot().results,[]);
 assert.equal(controller.receiveTopic(topic('a',{revision:8}),'library-one'),false);controller.stop();
});

test('a library mismatch in a source response clears old selections and reports recovery explicitly',async()=>{
 const fixture=setup((path,input)=>input.action==='search'?{libraryId:'new-library',results:[],discussionAvailable:true}:undefined),controller=await fixture.ready();
 controller.input('query','candidate');await controller.search();assert.equal(controller.snapshot().current,null);assert.equal(controller.snapshot().error,'tpLibraryChanged');assert.equal(controller.snapshot().libraryId,'new-library');controller.stop();
});

test('paginated original reading preserves exact text and attribution and stops at the final chunk',async()=>{
 const fixture=setup((path,input)=>input.action==='read'?input.start===4?{content:'正文🙂',reference:input.reference}:{content:' a\r\n',title:'Original title',speaker:'assistant',time:'2026-01-01',reference:input.reference,nextStart:4}:undefined),controller=await fixture.ready();
 const source={reference:discussionRef(),title:'Search title'};await controller.readSource(source);await controller.readSource(source,true);
 assert.equal(controller.snapshot().read.content,' a\r\n正文🙂');assert.equal(controller.snapshot().read.title,'Original title');assert.equal(controller.snapshot().read.speaker,'assistant');assert.equal(controller.snapshot().read.nextStart,null);assert.equal(fixture.calls.at(-1).input.start,4);controller.stop();
});

test('missing source retains the saved link for explicit removal and cannot be added from an unread candidate',async()=>{
 const fixture=setup((path,input)=>input.action==='read'?Promise.reject(new Error('missing source')):undefined),controller=await fixture.ready();
 await controller.references({kind:'add',reference:noteRef('missing')});await controller.readSource({reference:noteRef('missing')});
 assert.equal(controller.snapshot().readError,'tpSourceMissing');assert.equal(controller.snapshot().current.references.length,1);assert.equal(await controller.addSelected(),false);
 await controller.references({kind:'remove',reference:noteRef('missing')});assert.equal(controller.snapshot().current.references.length,0);controller.stop();
});

test('native start busy blocks manual CAS mutations and topic callbacks cannot regress revisions',async()=>{
 const fixture=setup(),controller=await fixture.ready();controller.coauthorBusy(true);const count=fixture.calls.length;
 assert.equal(await controller.references({kind:'add',reference:noteRef('blocked')}),false);assert.equal(fixture.calls.length,count);
 assert.equal(controller.receiveTopic(topic('a',{revision:4,sessionId:'native-session'}),'library-one'),true);
 assert.equal(controller.receiveTopic(topic('a',{revision:2}),'library-one'),false);controller.coauthorBusy(false);
 await controller.references({kind:'add',reference:noteRef('after-start')});assert.equal(fixture.calls.at(-2).input.revision,4,'manual write captured the latest native revision even though mock Host conflicts');controller.stop();
});

test('unmounted controllers ignore asynchronous returns and release subscribers',async()=>{
 const pending=deferred(),fixture=setup((path,input)=>input.action==='search'?pending.promise:undefined),controller=await fixture.ready();let renders=0;controller.subscribe(()=>renders++);
 controller.input('query','candidate');const searching=controller.search();controller.stop();const count=renders;
 pending.resolve({libraryId:'library-one',results:[]});await searching;assert.equal(renders,count);assert.equal(controller.listeners.size,0);
});

test('explicit chat opening scrolls after commit once, while data updates preserve the viewport and focus',()=>{
 let state={libraryId:'library-one',current:topic(),selectedId:'a',topics:[topic()],results:[],busy:false,coauthorBusy:false,newQuestion:'',questionInput:'Question a',query:''};
 const controller={snapshot:()=>state,subscribe:()=>()=>{},start(){},stop(){}};
 const slots=[controller,state,false,false],effects=[];let cursor=0;const scrolls=[];
 const native={scrollIntoView:options=>scrolls.push(options),focus(){throw new Error('Chat opening must not take native focus');}};
 const R={Fragment:'fragment',useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],value=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},useRef(initial){const index=cursor++;return slots[index]??={current:initial};},useId(){cursor++;return 'explicit-chat';},useEffect(fn,deps){const index=cursor++,old=slots[index];if(!old||deps.some((value,i)=>!Object.is(value,old[i])))effects.push(fn);slots[index]=deps;}};
 const h=(type,props,...children)=>({type,props:props||{},children});
 const {TopicsPage}=createTopicsUI({R,h,t:key=>key,Icon(){},Button(){},notebookRequest(){throw new Error('No data request is needed');},CoauthorPanel(){}});
 let all=[];
 function render(){cursor=0;all=[];const root=TopicsPage({slotProps:{}});function walk(value){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object'){all.push(value);if(value.props?.className==='tp-chat')value.props.ref.current=native;walk(value.children);}}walk(root);for(const effect of effects.splice(0))effect();}
 const toggle=()=>all.find(node=>node.type==='button'&&node.children.includes('tpCoauthor'));
 render();assert.equal(scrolls.length,0);toggle().props.onClick();assert.equal(scrolls.length,0,'scroll waits for the open container to mount');render();
 assert.deepEqual(scrolls,[{block:'nearest'}]);assert.equal(toggle().props['aria-expanded'],true);assert.equal(toggle().props['aria-controls'],all.find(node=>node.props.className==='tp-chat').props.id);
 state={...state,reading:true};slots[1]=state;render();assert.equal(scrolls.length,1,'source or message state updates must not scroll again');
 toggle().props.onClick();render();assert.equal(scrolls.length,1);assert.equal(toggle().props['aria-expanded'],false);
 toggle().props.onClick();render();assert.equal(scrolls.length,2);
});

test('page rendering does not trigger synthesis and the formal-note action only invokes the blank-note callback',()=>{
 const controller=new TopicsController(async()=>{throw new Error('Rendering must not make requests');});
 const state={...controller.snapshot(),libraryId:'library-one',current:topic(),selectedId:'a',topics:[topic()]};
 let cursor=0,created=0,args=null;const values=[controller,state,true,false];
 const R={Fragment:'fragment',useState(initial){const value=cursor<values.length?values[cursor++]:typeof initial==='function'?initial():initial;return [value,()=>{}];},useEffect(){},useRef:()=>({current:null}),useId:()=> 'topics-chat-test'};
 const h=(type,props,...children)=>({type,props:props||{},children});function CoauthorPanel(){}
 const {TopicsPage}=createTopicsUI({R,h,t:key=>key,Icon(){},Button(){},notebookRequest:controller.request,CoauthorPanel});
 const tree=TopicsPage({slotProps:{marker:true},onCreateNote:(...received)=>{created++;args=received;}});
 const all=[];function walk(value){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object'){all.push(value);walk(value.children);}}walk(tree);
 const create=all.find(node=>node.type==='button'&&node.children.includes('tpCreateBlankNote'));assert(create);create.props.onClick();assert.equal(created,1);assert.deepEqual(args,[]);
 const panel=all.find(node=>node.type===CoauthorPanel);assert.equal(panel.props.scope,'topic');assert.equal(panel.props.libraryId,'library-one');assert.equal(panel.props.note.id,'a');assert.equal(panel.props.disabled,false);
});
