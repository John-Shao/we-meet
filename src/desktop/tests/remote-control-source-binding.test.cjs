const assert = require('node:assert/strict')
const { test } = require('node:test')
const { bindScreenSource, CaptureBindingStore } = require('../dist/remote-control/source-binding.js')

const share = '11111111-2222-3333-4444-555555555555'
const source = {id:'screen:123:0',display_id:'123'}
const display = {id:123,bounds:{x:-1280,y:0,width:1280,height:720},scaleFactor:1.5,rotation:0}
const native = {left:-1920,top:0,width:1920,height:1080,deviceName:'DISPLAY2',devicePath:'test-monitor',rotation:0,dpiX:144,dpiY:144}
const toDip = rect => ({x:rect.x/1.5,y:rect.y/1.5,width:rect.width/1.5,height:rect.height/1.5})
const bind = (s=source,d=[display],n=[native],p=toDip) => bindScreenSource(s,d,n,{toDip:p},share)

test('source mapping uses the selected display and native-to-DIP conversion, including negative origins',()=>{
  let received
  const result=bind(source,[display],[native],rect=>{received=rect;return toDip(rect)})
  assert.deepEqual(received,{x:-1920,y:0,width:1920,height:1080})
  assert.equal(result.native.left,-1920)
  assert.match(result.displayBindingHash,/^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(result.native),true)
  const changed=bind(source,[display],[{...native,devicePath:'replacement-monitor'}])
  assert.notEqual(changed.displayBindingHash,result.displayBindingHash)
  assert.notEqual(bindScreenSource(source,[display],[native],{toDip}).displayBindingHash,result.displayBindingHash)
})

test('window, missing ID, duplicate/ambiguous monitor, scale and rotation mismatch never guess a target',()=>{
  assert.throws(()=>bind({...source,id:'window:123:0'}),/full_display/)
  assert.throws(()=>bind({...source,display_id:''}),/full_display/)
  assert.throws(()=>bind(source,[]),/mapping/)
  assert.throws(()=>bind(source,[display,display]),/mapping/)
  for(const n of [[],[native,native],[{...native,left:0}],[{...native,dpiX:96}],[{...native,rotation:90}],[{...native,devicePath:''}]]) {
    assert.throws(()=>bind(source,[display],n),/mapping/)
  }
  assert.throws(()=>bind(source,[display],[native],rect=>rect),/mapping/)
})

test('175% rounded DIP bounds retain exact native pixels and reject ambiguous projections',()=>{
  const d={...display,bounds:{x:0,y:0,width:1756,height:1098},scaleFactor:1.75}
  const n={...native,left:0,top:0,width:3072,height:1920,dpiX:168,dpiY:168}
  const convert=rect=>({x:Math.floor(rect.x/1.75),y:Math.floor(rect.y/1.75),
    width:Math.ceil((rect.x+rect.width)/1.75)-Math.floor(rect.x/1.75),
    height:Math.ceil((rect.y+rect.height)/1.75)-Math.floor(rect.y/1.75)})
  const result=bind(source,[d],[n],convert)
  assert.equal(result.native.width,3072)
  assert.equal(result.native.height,1920)
  assert.deepEqual(result.dipBounds,d.bounds)
  // Distinct native monitors can quantize to the same DIP rectangle: never pick one.
  assert.throws(()=>bind(source,[d],[n,{...n,width:3073,devicePath:'other'}],convert),/mapping/)
  for(const changed of [{...n,dpiX:144},{...n,rotation:90},{...n,devicePath:''}])
    assert.throws(()=>bind(source,[d],[changed],convert),/mapping/)
  assert.throws(()=>bind(source,[d],[{...n,width:3080}],convert),/mapping/)
  assert.throws(()=>bind(source,[d],[{...n,width:NaN}],convert),/mapping/)
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

test('mixed DPI conversion selects the unique negative-origin rotated monitor, independent of order',()=>{
  const primary={...native,left:0,top:0,width:3072,height:1920,dpiX:168,dpiY:168}
  const secondary={...native,left:-1080,top:-120,width:1080,height:1920,rotation:90}
  const dip={x:-720,y:-80,width:720,height:1280}
  const d={...display,bounds:dip,rotation:90}
  const convert=r=>r.x<0 ? toDip(r) : {x:0,y:0,width:1756,height:1098}
  for(const monitors of [[primary,secondary],[secondary,primary]]) {
    const result=bind(source,[d,{id:999,bounds:{x:0,y:0,width:1756,height:1098},scaleFactor:1.75,rotation:0}],monitors,convert)
    assert.equal(result.native.left,-1080)
    assert.equal(result.native.top,-120)
    assert.equal(result.native.rotation,90)
    assert.equal(result.native.width,1080)
  }
})
