import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, importThinoSettings, safePath, validateSettings } from '../src/settings';
test('inherits daily storage and harmless preferences without copying account data',()=>{
 const result=importThinoSettings({UserName:'tester',DefaultPrefix:'List',DefaultTimePrefix:'HH:mm',ShowLeftSideBar:false,token:'private',password:'private',StartDate:'Monday',MemoSaveLocation:'DAILY'},{folder:'Journal'});
 assert.equal(result.settings.folder,'Journal'); assert.equal(result.settings.weekStart,1); assert.equal(result.settings.showSidebar,false);
 assert.equal(JSON.stringify(result).includes('private'),false); assert.equal(result.report.warnings.length,0);
});
test('independent journal and periodic source precedence',()=>{
 assert.equal(importThinoSettings({UseDailyOrPeriodic:'Periodic'},{folder:'Daily'},{daily:{folder:'Periodic'}}).settings.folder,'Periodic');
 assert.equal(importThinoSettings({JournalSettings:{useIndependentSettings:true,daily:{folder:'Own',format:'YYYY/MM/DD'}}},{folder:'Daily'}).settings.dateFormat,'YYYY/MM/DD');
});
test('reject paths escaping the vault and unsupported writing formats',()=>{
 for(const p of ['../elsewhere','/tmp/foo','C:\\notes','Journal/../../note','a\u0000b']) assert.throws(()=>safePath(p));
 assert.throws(()=>validateSettings({...defaultSettings,dateFormat:'YYYY-MM'}));
 assert.throws(()=>validateSettings({...defaultSettings,timeFormat:'h:mm A'}));
 assert.equal(safePath('Journal/'),'Journal');
});
test('unsupported sources and format produce honest migration warnings',()=>{
 const r=importThinoSettings({MemoSaveLocation:'CANVAS',DefaultTimePrefix:'h:mm A',FetchMemosFromNote:true});
 assert.equal(r.settings.timeFormat,'HH:mm'); assert.equal(r.report.warnings.length,3);
});
