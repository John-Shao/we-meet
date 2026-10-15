const assert = require('node:assert/strict')
const { test } = require('node:test')
const { bindScreenSource, CaptureBindingStore } = require('../dist/remote-control/source-binding.js')

const share = '11111111-2222-3333-4444-555555555555'
const source = {id:'screen:123:0',display_id:'123'}
const display = {id:123,bounds:{x:-1280,y:0,width:1280,height:720},scaleFactor:1.5,rotation:0}
const native = {left:-1920,top:0,width:1920,height:1080,deviceName:'DISPLAY2',devicePath:'test-monitor',rotation:0,dpiX:144,dpiY:144}
const physical = () => ({x:-1920,y:0,width:1920,height:1080})
const bind = (s=source,d=[display],n=[native],p=physical) => bindScreenSource(s,d,n,p,share)

test('source mapping uses the selected display and physical conversion, including negative origins',()=>{
  let received
  const result=bind(source,[display],[native],rect=>{received=rect;return physical()})
  assert.deepEqual(received,display.bounds)
  assert.equal(result.native.left,-1920)
  assert.match(result.displayBindingHash,/^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(result.native),true)
  const changed=bind(source,[display],[{...native,devicePath:'replacement-monitor'}])
  assert.notEqual(changed.displayBindingHash,result.displayBindingHash)
  assert.notEqual(bindScreenSource(source,[display],[native],physical).displayBindingHash,result.displayBindingHash)
})

test('window, missing ID, duplicate/ambiguous monitor, scale and rotation mismatch never guess a target',()=>{
  assert.throws(()=>bind({...source,id:'window:123:0'}),/full_display/)
  assert.throws(()=>bind({...source,display_id:''}),/full_display/)
  assert.throws(()=>bind(source,[]),/mapping/)
  assert.throws(()=>bind(source,[display,display]),/mapping/)
  for(const n of [[],[native,native],[{...native,left:0}],[{...native,dpiX:96}],[{...native,rotation:90}],[{...native,devicePath:''}]]) {
    assert.throws(()=>bind(source,[display],n),/mapping/)
  }
  assert.throws(()=>bind(source,[display],[native],()=>display.bounds),/mapping/)
})

test('capture records reject stale login, late publication, replaced source and track mutation',()=>{
  let now=0
  const store=new CaptureBindingStore(()=>now), binding=bind()
  store.selected(binding,7,1000)
  assert.equal(store.pending(7),binding)
  assert.throws(()=>store.published('other','TR_test',7),/mismatch/)
  assert.equal(store.published(share,'TR_test',7).binding,binding)
  now=2000 // Once published, this is the capture lifetime, not preparation TTL.
  assert.equal(store.active(7).trackSid,'TR_test')
  assert.throws(()=>store.published(share,'TR_replacement',7),/mismatch/)
  assert.equal(store.active(8),undefined)
  store.selected(binding,8,1000);now=3000
  assert.throws(()=>store.published(share,'TR_test',8),/mismatch/)
  store.selected(binding,8);store.invalidate()
  assert.equal(store.active(8),undefined)
})
