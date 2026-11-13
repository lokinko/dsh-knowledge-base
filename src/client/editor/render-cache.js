// Owned by one editor. Bound both retained entries and UTF-16 units so scrolling
// through many distinct code blocks/formulas cannot retain the whole notebook.
export class LiveRenderCache{
 constructor({maxEntries=96,maxUnits=256000}={}){this.maxEntries=maxEntries;this.maxUnits=maxUnits;this.entries=new Map();this.units=0;}
 has(key){return this.entries.has(key);}
 get(key,build,measure=value=>typeof value==='string'?value.length:0){
  const found=this.entries.get(key);
  if(found){this.entries.delete(key);this.entries.set(key,found);return found.value;}
  const value=build(),units=key.length+measure(value);
  if(units>this.maxUnits)return value;
  while(this.entries.size&&(this.entries.size>=this.maxEntries||this.units+units>this.maxUnits)){
   const oldest=this.entries.keys().next().value;this.units-=this.entries.get(oldest).units;this.entries.delete(oldest);
  }
  this.entries.set(key,{value,units});this.units+=units;return value;
 }
}
