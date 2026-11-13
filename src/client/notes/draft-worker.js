import {serveDraftDriver} from './idb-draft-driver.js';

// Bundled into a local Blob worker, never loaded from a URL.
if(typeof self!=='undefined'&&typeof self.postMessage==='function'&&typeof document==='undefined')serveDraftDriver(self);
